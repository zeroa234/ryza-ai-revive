/* Main controller: boots straight into the game (no login, no official
   backend), wires the talk loop, the RPG layer (game.js / quests.js /
   daily.js) and the settings/chara forms. This module only orchestrates:
   state lives in Config/Game/Quests/Daily, rendering of the avatar in
   Avatar, sound in Sound, map in World. */
(function (global) {
  'use strict';

  var MEM_KEY = 'ryza.memory.v1';
  /* The save-slot key lives with the slot code (settings.js) — a closure-local
     const in this file is invisible there, which is exactly how the slots broke. */
  var HOME_STAGE = 'stage_01_001_04';       // ライザの家 — the safe place to sleep
  var RPG_MODES = { chat: 1, story: 1, immersive: 1 };

  var App = {
    history: [],
    memory: [],
    audio: null,
    speaking: false,
    _typeTimer: null,
    _ringAlarm: null,
    _inTutorial: false,
    _lastText: '',
    _invBag: 'you',

    /* ------------------------------------------------------------- utils */
    toast: function (msg, isErr) {
      var host = document.getElementById('toast-host');
      var el = document.createElement('div');
      el.className = 'toast' + (isErr ? ' err' : '');
      el.textContent = msg;
      host.appendChild(el);
      setTimeout(function () {
        el.style.transition = 'opacity .3s'; el.style.opacity = '0';
        setTimeout(function () { el.remove(); }, 320);
      }, isErr ? 4200 : 2400);
    },

    buzz: function (ms) {
      if (!Config.section('app').vibration) return;
      if (navigator.vibrate) { try { navigator.vibrate(ms || 18); } catch (e) {} }
    },

    _ensureVoiceGraph: function () {
      if (App._voiceAnalyser || !App.audio) return;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        App._voiceCtx = new AC();
        var src = App._voiceCtx.createMediaElementSource(App.audio);
        var an = App._voiceCtx.createAnalyser();
        an.fftSize = 512;
        src.connect(an);
        an.connect(App._voiceCtx.destination);
        App._voiceAnalyser = an;
      } catch (e) {}
    },

    /* HTML escaper for the few places that build innerHTML around dynamic
       (LLM-authored) text — e.g. the quest title row in the status sheet. */
    esc: function (s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    /* Desktop UI zoom. #phone now fills the window (no more letterbox), so a
       small window must scale the fixed-px chrome instead of letting it
       crowd/overflow. CSS zoom scales the whole layout as one; pointer math
       divides it back out via Avatar.cssZoom, and the canvas backing store
       multiplies dpr by it (see avatar.js). Electron-only: phones keep zoom
       1 and rely on the fluid full-viewport layout. */
    /* How much of the screen the bottom log panel covers — the camera's
       plate clamp lets the window sink below the painted art by exactly
       this much (the panel hides the seam). FROZEN at the expanded height:
       tracking the collapsed strip re-solved the window on every toggle —
       the background zoomed and she slid ~180px down (worse than the seam
       it hid). At the current framing factors the hideout's collapsed
       exposure is a ~4% sliver right above the strip, dressed by the
       #stage bottom gradient. The hideout is the ONLY stage with a seam
       to hide: its art is split far_bg (ends at world 629) + floor
       (starts at −1064) with a 1693u gap; every other scene ships one
       full-coverage backdrop quad. */
    /* Applies data-i18n attributes in a subtree. Lives here (not in i18n.js)
       because walking the DOM is presentation; i18n.js stays a pure table. */
    applyI18n: function (root) {
      (root || document).querySelectorAll('[data-i18n]').forEach(function (el) {
        el.textContent = I18n.t(el.getAttribute('data-i18n'));
      });
      /* data-i18n-title sets the tooltip (title attr) rather than the text —
         used where a button already shows an icon or short label but wants a
         longer hover hint. */
      (root || document).querySelectorAll('[data-i18n-title]').forEach(function (el) {
        el.setAttribute('title', I18n.t(el.getAttribute('data-i18n-title')));
      });
    },

    _syncPanelFrac: function () {
      if (!window.Avatar || Avatar.panelFraction()) return;   // measure once
      var vh = window.innerHeight || 1;
      Avatar.setPanelFraction(Math.min(0.55, Math.min(340, Math.max(240, 0.34 * vh)) / vh));
    },

    _fitUi: function () {
      var el = document.getElementById('phone');
      if (!el) return;
      if (!window.ryzaShell) { el.style.zoom = ''; return; }
      /* MUST use innerWidth/innerHeight, never #phone.clientWidth: clientWidth
         is already divided by the active zoom, which feeds back and
         oscillates the scale between zoomed and 1.0 on every check. */
      var w = window.innerWidth || el.clientWidth;
      var h = window.innerHeight || el.clientHeight;
      if (!w || !h) return;
      var z = Math.min(w / 420, h / 860);
      z = Math.max(0.8, Math.min(1.25, z));
      if (Math.abs(z - (App._uiZoom || 1)) > 0.02) {
        App._uiZoom = z;
        el.style.zoom = String(z);
        if (window.Avatar && Avatar.resize) Avatar.resize();
      }
    },

    /* -------------------------------------------------------------- boot */
    init: function () {
      I18n.setLang(Config.section('app').lang || 'zh');
      App.applyI18n(document);
      var inpEl = document.getElementById('input');
      if (inpEl) inpEl.placeholder = I18n.tc('input.hint', inpEl.placeholder);
      document.getElementById('overlay-title').classList.remove('hidden');
      document.getElementById('btn-title-start').disabled = true;

      App.audio = new Audio();
      App.audio.preload = 'auto';
      App.audio.crossOrigin = 'anonymous';
      try { App.memory = JSON.parse(localStorage.getItem(MEM_KEY) || '[]'); }
      catch (e) { App.memory = []; }

      Game.load();
      Daily.load();
      Quests.ensure();
      try { if (window.Memory) Memory.load(); } catch (e) {}

      App._bindChrome();
      App._bindTalk();
      App._bindOverlays();
      Game.on(function () { App.refreshHud(); App._syncOpenViews(); });

      /* Ports first: they must not depend on the asset chain below succeeding. */
      App._wirePorts();

      Promise.all([Config.hydrate(), World.init(), VoiceBank.load(), Sound.init()]).then(function () {
        Sound.setCatalog(Object.keys(World.scenes || {}));
        var st = Config.section('state');
        Sound.setPlace(st.stage, st.tod, World.backgroundFor(st.stage));
        App._tickDay();
        App._syncPanelFrac();
        Avatar.init(function () {
          App._loadSceneFor(st.stage, st.tod);
          App._tickTime();          // adopt the wall/flow clock once the scene is up
        });
        setInterval(App._tickTime, 30000);
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) App._tickTime();
        });
        App.updateHud();
        App.renderWorld();
        /* The Android shell can schedule alarms in the system: they survive the
           process being killed and can wake the lock screen, which an in-page
           timer cannot. When that bridge is present the native side becomes the
           firing authority — Alarm.start stands its own tick down — and the web
           model stays the source of truth, pushed down on every mutation.
           The hook native calls on a foreground fire is defined before the
           schedule is handed over; a missing hook must never cost an alarm. */
        window.RyzaAlarmNative = {
          onFire: function (a) { try { Alarm._nativeFire(a); } catch (e) {} }
        };
        if (window.RyzaAlarm && Alarm.setNative) Alarm.setNative(window.RyzaAlarm);
        Alarm.load();
        Alarm.render(document.getElementById('alarm-list'), App.playFile);
        Alarm.start(App._onAlarm);
        Quests.render(document.getElementById('quest-list'), {});
        Daily.render(document.getElementById('daily-body'));
        App.renderSkins();
        App.buildSettings();
        App.buildCharaForm();
        App.renderMemory();
        /* Official groups open on day 0 / 3 / 5 since first launch. */
        if (window.Daily && Daily.dayIndex) Welcome.bumpDay(Daily.dayIndex());
        Welcome.render(document.getElementById('welcome-body'));
        if (window.Fx) Fx.init();
        App._fitUi();
        window.addEventListener('resize', function () {
          App._fitUi();
          App._syncPanelFrac();
        });

        Onboarding.showTitle(function () {
          if (!Onboarding.isDone()) {
            App._inTutorial = true;
            Onboarding.start(function () {
              App._inTutorial = false;
              App.enterGame(true);
            });
          } else App.enterGame(false);
        });
      }).catch(function (e) {
        /* Recorded as well as shown: the whole boot chain is skipped after a
           throw, and "asset index failed" was the only clue even when the real
           cause was a wiring call. boot_smoke asserts this is null. */
        App._bootError = e;
        App.toast('素材索引加载失败：' + e.message, true);
      });
    },

    /* Every cross-module port, in one place, wired synchronously before any
       async work starts. These are plain closures: nothing here needs the asset
       index. They used to sit inside the asset-loading .then, so a single throw
       anywhere in that chain left the app looking alive with no TTS, no memory
       and no quest ports — while the .catch reported it as an asset problem
       (boot_smoke reproduced exactly that: a stub missing one method, and the
       whole port block was silently skipped with the suite reporting ALL PASS). */
    _wirePorts: function () {
      /* Hand the renderer the two host capabilities it needs, so avatar.js
         never reaches back into App (notice toasts, and which analyser to
         read for lipsync). */
      Avatar.setNotice(App.toast);
      Avatar.setVoiceSource(function () {
        return { analyser: App._voiceAnalyser, paused: !App.audio || App.audio.paused };
      });
      /* Memory summarises through this injected hook (memory.js then has no
         reference to the transport layer). */
      if (Memory.setLLM) {
        Memory.setLLM(function (sys, body, opts) { return Api.complete(sys, body, opts); });
      }
      /* 长期记忆的归纳也走玩家自己配的端点；side 请求必须 standalone，
         否则会分走代际令牌、把玩家正在等的回复判成 STALE 丢掉。 */
      if (window.LongTerm && LongTerm.setLLM) {
        LongTerm.setLLM(function (sys, body, opts) {
          return Api.complete(sys, body, Object.assign({ standalone: true }, opts || {}));
        });
      }
      /* Two render-layer reads that used to be hidden inside core/io modules
         (invisible to the boundary guard, which is why --strict stayed at 0):
         nsfw decides the variant but must not know Avatar, and api fills the
         tag line with the on-screen face without reading Avatar's privates. */
      if (Nsfw.setSink) {
        Nsfw.setSink(function (name) {
          Avatar.setAtlasVariant(name, function () {
            /* The model asked for a variant this outfit does not have. The
               renderer stays silent by design, so say it here — once per
               outfit+variant — instead of leaving a console 404 as the only
               evidence that the toggle did nothing (issue #4). */
            if (Avatar.takeVariantMiss && Avatar.takeVariantMiss()) {
              App.toast(I18n.t('avatar.noVariant'), true);
            }
          });
        });
      }
      if (Api.setScreenState) {
        Api.setScreenState(function () {
          return (Avatar.screenState && Avatar.screenState()) ||
                 { emotion: '', attitude: '' };
        });
      }
      /* Presentation ports for the feature modules. Gameplay states intent;
         this one place decides how it sounds/looks, so quests / daily /
         world / alarm never reference App, Sound or Fx themselves. */
      if (World.setNotice) World.setNotice(App.toast);
      if (Quests.setNotice) Quests.setNotice(App.toast);
      if (Quests.setNavigator) Quests.setNavigator(function (view) { App.showView(view); });
      if (Alarm.setEditor) Alarm.setEditor(function (id) { App._editAlarm(id); });
      var celebrate = function () {
        if (window.Sound) Sound.se('quest_clear');
        if (window.Fx) Fx.burstConfetti();
      };
      if (Quests.setCelebrate) Quests.setCelebrate(celebrate);
      if (Daily.setCelebrate) Daily.setCelebrate(celebrate);
      if (Quests.setGenerator) {
        Quests.setGenerator(function (history, body, opts) { return Api.chat(history, body, opts); });
      }
      if (Quests.setPresenter) {
        Quests.setPresenter(function (res) {
          if (!res) return;
          if (res.sail) App._onSailed();
          if (res.line) {
            if (res.faint) App._showFaint();
            else App.showBubble(res.line);
            if (window.Sound) {
              if (res.ok) Sound.se('quest_clear');
              else if (!res.faint) Sound.se('touch_start');
            }
          }
          App.refreshHud();
        });
      }
      if (Daily.setPresenter) {
        Daily.setPresenter(function (res) {
          if (!res) return;
          if (!res.ok) { App.toast(I18n.t('dl.already')); return; }
          App.toast(I18n.t('dl.got') + res.text);
          /* Official activity: login_streak. The mission needs 1 / 3 / 5
             consecutive days, so record the streak itself rather than +1. */
          Welcome.mark('login_bonus', Daily.streak());
          Welcome.bumpDay(Daily.streak());
          App.refreshHud();
        });
      }
      /* Turn owns "who is speaking". It gets the three things only this layer
         can supply: how to synthesize (language matrix + per-mode direction),
         how to play (the <audio> element, abortable mid-utterance), and how to
         cancel an in-flight reply (Api's epoch). */
      /* 本地服装导入：渲染层只收一个「贴图从哪来」的函数，不碰 IndexedDB。
         已导入的服装在这里登记进皮肤表，重启后仍然可穿。 */
      if (window.CrfStore) {
        Avatar.setPageSource(function (skinId, pageName) {
          return CrfStore.pageUrl(skinId, pageName);
        });
        CrfStore.entries().then(function (list) {
          if (!list.length) return;
          var base = Avatar.skinsIndex || [];
          list.forEach(function (e) { base.push(e); });
          Avatar.skinsIndex = base;
        }).catch(function () { /* 导入表坏了不影响启动 */ });
      }
      if (window.Turn) {
        Turn.setTurnCanceller(function (reason) { return Api.newTurn(reason); });
        Turn.setSynth(function (text, meta) {
          var st2 = Config.section('state');
          var replyL = (window.Langs && Langs.llm) ? Langs.llm() : 'ja';
          var ttsL = (window.Langs && Langs.tts) ? Langs.tts() : replyL;
          /* 防重复翻译：回复里若已经带「译文：」行，说明模型自己翻过了——
             而 Turn 只把**她的台词**传进来（译文行不在这里），所以那条路
             （tts.lang ≠ llm.lang 时先翻再合成）依然要跑。
             真正要防的是「模型给了译文、客户端又翻一遍」⇒ 由下面 displayText
             的 showOriginal 决定显示哪一份，这里只在模型没给译文时才翻。 */
          var alreadyTranslated = !!(meta && meta.translated);
          var prep = (!alreadyTranslated && ttsL !== replyL && Api.translate)
            ? Api.translate(text, ttsL) : Promise.resolve(text);
          return prep.then(function (t) {
            /* Record her own line as it is voiced, so the recogniser hearing
               it come back through the microphone is recognised as echo and
               not as the player (web/js/echo.js). This is the single funnel
               every synthesized line passes through. */
            if (window.Voice && Voice.noteAssistantSpeech) Voice.noteAssistantSpeech(t);
            return Api.speak(t, ttsL, (meta && meta.mode) || st2.mode, (meta && meta.emotion) || '')
              .then(function (url) {
                /* 同一条台词只缓存一次：key = 文本 + 模式。
                   缓存失败绝不影响播放（VoiceCache 自己吞异常）。 */
                if (window.VoiceCache && url) {
                  try {
                    App._voiceSeq = (App._voiceSeq || 0) + 1;
                    var key = 'v' + App._voiceSeq + ':' + t.slice(0, 40);
                    App._lastVoiceKey = key;
                    fetch(url).then(function (r) { return r.blob(); }).then(function (bl) {
                      return VoiceCache.put(key, bl, { text: t, url: '' });
                    }).catch(function () {});
                  } catch (e) {}
                }
                return url;
              });
          });
        });
        Turn.setPlayer(function (url, signal, meta) {
          return App.playSpeech(url, signal, meta && meta.fx);
        });
        /* Synthesis failures surface here now that Turn owns the utterance
           (the toast text is the same one speakThen used to emit). */
        Turn.on(function (ev) {
          if (ev.type !== 'error') return;
          var msg = (ev.error && ev.error.message) || '';
          App.toast(msg === 'NO_KEY' ? I18n.t('toast.needKey')
                : msg === 'NO_MODEL' ? I18n.t('toast.needModel')
                : I18n.t('toast.ttsFail') + msg, true);
        });
      }
      /* Voice input. The microphone needs three things only this layer has:
         whether she is speaking (Turn), whose words came back (Echo), and
         where an accepted transcript goes — this layer decides between
         filling the box and sending it. */
      if (window.Voice) {
        var sttReady = function () {
          return !!String((Config.section('stt') || {}).baseUrl || '').trim();
        };
        Voice.setEcho(window.Echo);
        Voice.setSpeaker(function () { return !!(window.Turn && Turn.isSpeaking()); });
        /* The second engine: our own capture + provider transcription. Injecting
           it also connects it to Voice's gate, so echo suppression and the
           half-duplex rule cover both engines instead of each growing its own. */
        Voice.setCapture(window.Stt || null);
        Voice.setEngine(function () {
          var pref = (Config.section('stt') || {}).engine || 'auto';
          if (pref !== 'auto') return pref;
          /* The packaged shells cannot use the browser recogniser — absent in
             Android's WebView, backed by nothing in Electron (measured: start()
             succeeds, `onstart` fires, then `network`). With a transcription
             endpoint configured they go straight to our own capture instead of
             failing once per session first. Host knowledge lives here rather
             than in the voice layer. */
          var shell = !!window.ryzaShell ||
                      /Android/i.test((navigator && navigator.userAgent) || '');
          return (shell && sttReady()) ? 'capture' : 'auto';
        });
        Voice.setTranscriberReady(sttReady);
        Voice.setLang(function () {
          var lg = (window.Langs && Langs.voice && Langs.voice())
              || (window.Langs && Langs.llm && Langs.llm()) || 'ja';
          /* The recogniser wants BCP-47; i18n.js owns that mapping. */
          return (window.Langs && Langs.sttTag) ? Langs.sttTag(lg) : lg;
        });
        /* One notice handler for both engines — stt.js reports through the same
           codes, and the two must not drift into different toasts. */
        App._micNotice = function (code, isErr) {
          var c = String(code || '');
          if (c === 'mic.on' || c === 'mic.off' || c === 'mic.empty') return;
          if (c === 'mic.denied' || c === 'mic.unsupported' || c === 'mic.unstable' ||
              c === 'mic.nodevice' || c === 'mic.switched' || c === 'mic.noTranscriber') {
            App.toast(I18n.t(c), !!isErr);
            return;
          }
          App.toast(I18n.t('mic.failed') + c.replace(/^mic\.error:/, ''), !!isErr);
        };
        Voice.setNotice(App._micNotice);
        if (window.Stt) {
          Stt.setTranscriber(function (blob, opts) { return Api.transcribe(blob, opts); });
          Stt.setNotice(App._micNotice);
          /* The transcribe request takes a plain language code (api.js maps it
             to ISO-639-1), not the recogniser's BCP-47 tag. */
          Stt.setLang(function () {
            return (window.Langs && Langs.voice && Langs.voice()) ||
                   (window.Langs && Langs.llm && Langs.llm()) || 'ja';
          });
        }
        Voice.setSink(function (text) { App._onVoiceTranscript(text); });
        /* Onset barge-in, off by default: the recogniser cannot tell her
           voice from the player's, so on a setup without echo cancellation
           she would cut herself off. App wires it only when the player asked
           for it (settings → app.bargeIn). */
        Voice.setBargeIn(null);
        if (window.Turn) {
          Turn.on(function (ev) {
            /* She stopped: keep the microphone deaf for a moment (the tail of
               her audio is still in the room and in the recogniser buffer).
               The reason is passed through because a user barge-in must NOT
               arm that cooldown — it would swallow the player's interruption
               itself. */
            if (ev.type === 'end' || ev.type === 'cancel') Voice.noteAssistantSpeechEnded(ev.reason);
            if (ev.type === 'speak') Voice.noteAssistantSpeechStarted();
            if (ev.type === 'state' || ev.type === 'end' || ev.type === 'cancel') App._syncMic();
          });
        }
        App._syncBargeIn();
      }
      App._setupMic();
    },

    enterGame: function (fromOnboard) {
      var bar = document.getElementById('input-bar');
      if (bar) bar.classList.remove('spot');
      var st = Config.section('state');
      Sound.setPlace(st.stage, st.tod, World.backgroundFor(st.stage));
      Sound.setRoute('talk');
      /* 幂等：跳过问卷与教程结束都会走到这里。重复进入时只补一次
         「已经在游戏里」的副作用（音景/路线），弹窗类不再重放。 */
      var firstEntry = !App._entered;
      App._entered = true;
      if (firstEntry) {
        App._showDisclosure();
        App._dailyNudge();
      }
      if (fromOnboard) return;
      App.greet();
    },

    _tickDay: function () {
      var st = Config.section('state');
      var today = new Date().toDateString();
      if (st.lastDayDate && st.lastDayDate !== today) {
        Config.set('state.day', (st.day || 1) + 1);
      }
      if (st.lastDayDate !== today) Config.set('state.lastDayDate', today);
      Daily.load();                       /* breaks the streak if too long a gap */
      App._dailyBadge();
    },

    _dailyNudge: function () {
      Daily.load();
      if (!Daily.available()) return;
      /* 「每日登录」提醒只弹一次：enterGame 可能被二次进入（跳过问卷 + 教程结束
         都会走到那里），没有这个闸门时同一句提示会叠成两个 toast
         —— 走查截图里抓到过。 */
      if (App._nudged) return;
      App._nudged = true;
      /* stagger after the AI-disclosure toast so the two don't stack */
      setTimeout(function () {
        /* 教程途中不打扰：玩家还没进主界面，这时提示只会挡视线 */
        if (App._inTutorial) return;
        App.toast(I18n.t('dl.title') + ' · ' + I18n.t('dl.cta'));
      }, 3200);
    },

    _dailyBadge: function () {
      var dot = document.getElementById('daily-dot');
      if (dot) dot.classList.toggle('hidden', !Daily.available());
    },

    _showDisclosure: function () {
      if (App._disclosed) return;
      App._disclosed = true;
      App.toast(I18n.t('toast.ai'));
    },

    _loadSceneFor: function (stageId, tod) {
      var curtain = document.getElementById('scene-curtain');
      if (curtain) curtain.classList.add('on');
      var bg = World.backgroundFor(stageId);
      Avatar.loadScene(bg, tod, function (err) {
        if (err) { /* stage without a built scene is fine — bg stays dark */ }
        setTimeout(function () {
          if (curtain) curtain.classList.remove('on');
        }, 280);
        /* Sit/stand is a per-stage choice: walking away returns to the source
           default (standing). Avatar owns the rule; the chip itself now
           depends on the OUTFIT (both variants must exist), not on the scene —
           see Avatar.postureSwitchable. */
        if (window.Avatar && Avatar.shouldResetPosture && Avatar.shouldResetPosture()) {
          Config.set('state.posture', 'posture_standing');
        }
        App.updateHud();   /* posture chip visibility follows the worn outfit */
      });
    },

    /* touch_ripple_overlay (source module): a light ring where the avatar
       was tapped, under the reaction voice. */
    _ripple: function (x, y) {
      var layer = document.getElementById('ripple-layer');
      if (!layer) return;
      var el = document.createElement('div');
      el.className = 'tap-ripple';
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      layer.appendChild(el);
      setTimeout(function () { if (el.remove) el.remove(); }, 720);
    },

    /* ------------------------------------------------------------ chrome */
    _bindChrome: function () {
      var drawer = document.getElementById('drawer');
      var scrim = document.getElementById('scrim');
      var open = function (on) {
        drawer.classList.toggle('open', on);
        scrim.classList.toggle('on', on);
      };
      document.getElementById('btn-menu').onclick = function () { open(true); };
      scrim.onclick = function () { open(false); };

      document.querySelectorAll('.drawer-list li').forEach(function (li) {
        li.onclick = function () {
          var act = li.getAttribute('data-action');
          if (act === 'newTalk') { open(false); App._confirmNewTalk(); return; }
          if (act === 'lang') { open(false); App._openLangSheet(); return; }
          if (act === 'toggleChara') { App._toggleChara(); return; }
          if (act === 'fullscreen') { open(false); App._toggleFullscreen(); return; }
          document.querySelectorAll('.drawer-list li').forEach(function (x) {
            x.classList.remove('active');
          });
          li.classList.add('active');
          App.showView(li.getAttribute('data-view'));
          open(false);
        };
      });

      var st = Config.section('state');
      document.querySelectorAll('.mode-pill[data-mode]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-mode') === st.mode);
        b.onclick = function () {
          var prevMode = st.mode;
          Config.set('state.mode', b.getAttribute('data-mode'));
          document.querySelectorAll('.mode-pill[data-mode]').forEach(function (x) {
            x.classList.toggle('active', x === b);
          });
          App.updateHud();
          if (window.Avatar && Avatar.resize) Avatar.resize();
          if (window.Avatar && Avatar.onModeChange &&
              b.getAttribute('data-mode') !== prevMode) {
            Avatar.onModeChange();
          }
          document.getElementById('sheet-mode').classList.add('hidden');
        };
      });
      document.querySelectorAll('.mode-pill[data-style]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-style') === st.style);
        b.onclick = function () {
          Config.set('state.style', b.getAttribute('data-style'));
          document.querySelectorAll('.mode-pill[data-style]').forEach(function (x) {
            x.classList.toggle('active', x === b);
          });
          if (App._syncVoicePill) App._syncVoicePill();
        };
      });

      /* Official voice/text pill (2026-09-07 UI pass): it toggles state.style
         (voice ↔ text), exactly like the shipped screenshots — orange speaker
         「ボイス」 while she talks, dark document 「テキスト」 in text mode.
         The master mute stays where it always was: settings → app.voice. */
      var vbtn = document.getElementById('btn-voice');
      var vcanvas = document.getElementById('lottie-voice');
      var vsync = function () {
        var a = Config.section('app'), st = Config.section('state');
        var talking = !!a.voice && st.style === 'voice';
        vbtn.classList.toggle('on', talking);
        vbtn.classList.toggle('off', !talking);
        var lab = document.getElementById('voice-pill-label');
        if (lab) lab.textContent = I18n.t(talking ? 'voice.on' : 'voice.off');
        if (vcanvas) vcanvas.classList.toggle('hidden', !talking);
        var tico = document.getElementById('voice-text-ico');
        if (tico) tico.classList.toggle('hidden', talking);
        if (window.Fx) Fx.setVoice(!!a.voice);
      };
      vbtn.onclick = function () {
        var st = Config.section('state');
        Config.set('state.style', st.style === 'voice' ? 'text' : 'voice');
        vsync();
        document.querySelectorAll('.mode-pill[data-style]').forEach(function (x) {
          x.classList.toggle('active', x.getAttribute('data-style') === st.style);
        });
        if (st.style !== 'voice' && App.audio) App.audio.pause();
      };
      App._syncVoicePill = vsync;
      vsync();

      /* » — the official right side menu. Each row jumps to the screen the
         source names: shop/skin/save/fullscreen/chara-toggle/settings/map. */
      var side = document.getElementById('side-menu');
      var sideClose = function (fn) {
        return function () {
          side.classList.remove('open');
          document.body.classList.remove('side-open');
          fn();
        };
      };
      document.getElementById('btn-expand').onclick = function () {
        side.classList.toggle('open');
        /* 官方：侧栏打开时右侧只剩菜单本身（截图对照过），
           而我们的快捷钮列原来会叠在菜单项上。用 body 上的类切换显隐，
           样式规则放在 CSS 里（不在 JS 里写内联样式）。 */
        document.body.classList.toggle('side-open', side.classList.contains('open'));
      };
      document.addEventListener('click', function (e) {
        if (!side.classList.contains('open')) return;
        if (e.target.closest && e.target.closest('#side-menu,#btn-expand')) return;
        side.classList.remove('open');
        document.body.classList.remove('side-open');
      }, true);
      document.getElementById('sm-shop').onclick = sideClose(function () { App.showView('quest'); });
      document.getElementById('sm-skin').onclick = sideClose(function () { App.showView('skin'); });
      document.getElementById('sm-save').onclick = sideClose(function () {
        /* the save slots live at the bottom of the player-profile form */
        App.showView('chara');
      });
      document.getElementById('sm-full').onclick = sideClose(function () { App._toggleFullscreen(); });
      document.getElementById('sm-chara').onclick = sideClose(function () { App._toggleChara(); });
      document.getElementById('sm-settings').onclick = sideClose(function () { App.showView('settings'); });
      document.getElementById('sm-map').onclick = sideClose(function () { App.showView('world'); });

      /* Posture button — visible only on stages whose scene lists both sitting
         and standing midgroundPostures (e.g. stage_01_002_01). */
      var postureBtn = document.getElementById('btn-posture');
      if (postureBtn) postureBtn.onclick = function () {
        App.setPosture(Avatar.postureKey() === 'posture_standing'
          ? 'posture_sitting' : 'posture_standing');
      };
      var skinBtn = document.getElementById('btn-chara-skin');
      if (skinBtn) skinBtn.onclick = function () { App.showView('skin'); };
      /* place / tod / mode / map now live inside the mode sheet (the » row
         of chips under the pills) */
      var hudMode = document.getElementById('hud-mode');
      if (hudMode) hudMode.onclick = function () { /* current-mode label */ };
      document.getElementById('hud-place').onclick = function () { App.showView('world'); };
      document.getElementById('btn-map').onclick = function () { App.showView('world'); };
      document.getElementById('btn-quest-sheet').onclick = function () { App.showView('quest'); };
      /* ⇧ — official behaviour: collapse the conversation area down to the
         input row (the whole stage opens up), tap again to bring it back.
         The running transcript (talk_conversation_log) opens by tapping the
         line itself. */
      var logT = document.getElementById('btn-log-toggle');
      if (logT) logT.onclick = function () {
        var phone = document.getElementById('phone');
        var open = phone.classList.toggle('panel-collapsed');
        var arrow = document.querySelector('#btn-log-toggle img');
        if (arrow) arrow.style.transform = open ? 'rotate(180deg)' : '';
        /* no camera re-solve — the window is frozen (see _syncPanelFrac) */
      };
      var spd = document.getElementById('btn-speed');
      if (spd) spd.onclick = function () { App._cycleTextSpeed(); };
      var nt = document.getElementById('btn-newtalk');
      if (nt) nt.onclick = function () { App._confirmNewTalk(); };
      /* tapping her name/subtitle opens the mode sheet (mode lives there now) */
      var logHead = document.getElementById('log-head');
      if (logHead) logHead.onclick = function () {
        document.getElementById('sheet-mode').classList.toggle('hidden');
      };
      ['hud-stamina', 'hud-money', 'hud-level'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.onclick = function () { App.renderStatus(); document.getElementById('sheet-status').classList.remove('hidden'); };
      });
      document.getElementById('btn-bag').onclick = function () {
        App.renderInv();
        document.getElementById('sheet-inv').classList.toggle('hidden');
      };
      document.querySelectorAll('#inv-tabs [data-bag]').forEach(function (b) {
        b.onclick = function () {
          App._invBag = b.getAttribute('data-bag');
          document.querySelectorAll('#inv-tabs [data-bag]').forEach(function (x) {
            x.classList.toggle('active', x === b);
          });
          App.renderInv();
        };
      });
      document.getElementById('btn-tod').onclick = function () {
        var next = World.nextTod(Config.section('state').tod);
        App._setTod(next);
        Config.set('state.todManualUntil', Date.now() + 30 * 60000);  // don't auto-clobber for 30 min
        if ((Config.section('app').timeMode) === 'flow') {
          Config.set('state.gameHour', World.todStartHour(next));
          Config.set('state.gameClockAt', Date.now());
        }
      };
      document.getElementById('world-area').onchange = function (e) {
        /* 地图模式下切区域要留在地图上。原来这里直接调 World.jumpArea，
           而它是**列表**渲染器 —— 于是「切了区域就自动跳回列表」。 */
        if (window.WorldMap && WorldMap.mode === 'map') {
          WorldMap.areaId = e.target.value;
          WorldMap.reset();
          App.renderWorld();
          return;
        }
        World.jumpArea(e.target.value, Config.section('state').stage, App.gotoStage);
      };
      document.getElementById('btn-quest-new').onclick = function () {
        var hasKey = !!(Config.section('llm').apiKey);
        if (hasKey) App.toast(I18n.t('toast.questGen'));
        Quests.generate(hasKey).then(function (q) {
          App.toast(I18n.t('quest.newOk') + '「' + q.title + '」');
          Quests.render(document.getElementById('quest-list'), {});
        });
      };
      document.getElementById('btn-alarm-new').onclick = function () { App._newAlarm(); };
      /* area_bottom_sheet.dart: who is around at the level you're looking at. */
      /* 玩家缩放：按钮 + 滚轮。只放大，复位键回 1.0。 */
      var rp = document.getElementById('btn-replay');
      if (rp) rp.onclick = function () { App.replayLastVoice(); };
      var vf = document.getElementById('btn-voicefav');
      if (vf) vf.onclick = function () { App.favLastVoice(); };
      var zi = document.getElementById('btn-zoom-in');
      var zo = document.getElementById('btn-zoom-out');
      var zr = document.getElementById('btn-zoom-reset');
      if (zi) zi.onclick = function () { Avatar.zoomBy(Avatar.PLAYER_ZOOM_STEP); };
      if (zo) zo.onclick = function () { Avatar.zoomBy(-Avatar.PLAYER_ZOOM_STEP); };
      if (zr) zr.onclick = function () { Avatar.zoomReset(); };
      /* 收起/展开右侧整列钮 */
      var qt = document.getElementById('btn-quick-toggle');
      if (qt) {
        qt.onclick = function () {
          var on = !document.body.classList.contains('quick-collapsed');
          App.setQuickCollapsed(on);
        };
      }
      App.setQuickCollapsed(!!(Config.section('app') || {}).quickCollapsed, true);
      var stageEl = document.getElementById('stage');
      if (stageEl) {
        stageEl.addEventListener('wheel', function (ev) {
          if (!App._viewIsTalk()) return;          /* 只在对话页响应滚轮 */
          ev.preventDefault();
          Avatar.zoomBy(ev.deltaY < 0 ? Avatar.PLAYER_ZOOM_STEP : -Avatar.PLAYER_ZOOM_STEP);
        }, { passive: false });
      }
      var wmBtn = document.getElementById('btn-world-mode');
      if (wmBtn) wmBtn.onclick = function () { App.toggleWorldMode(); };
      /* 服装导入：ZIP 走 CrfStore（IndexedDB），失败只报错不崩 */
      var crfBtn = document.getElementById('btn-crf-zip');
      var crfFile = document.getElementById('crf-file-zip');
      /* Map a CrfStore error to a translated line: prefer crf.err.<code>, and
         fall back to the error's own English message when a code is missing
         or has no translation yet. */
      function crfErrText(e) {
        var code = e && e.code;
        if (code) {
          var key = 'crf.err.' + code;
          var s = T(key);
          if (s && s !== key) return s;
        }
        return (e && e.message) || String(e);
      }
      if (crfBtn && crfFile) {
        crfBtn.onclick = function () { crfFile.click(); };
        crfFile.onchange = function () {
          var f = crfFile.files && crfFile.files[0];
          crfFile.value = '';
          if (!f) return;
          App.toast(T('crf.importing'));
          CrfStore.importZip(f).then(function (v) {
            return CrfStore.get(v.id).then(function (rec) {
              var base = Avatar.skinsIndex || [];
              base.push(CrfStore.entryFor(rec));
              Avatar.skinsIndex = base;
              Config.set('state.skin', v.id);
              App.renderSkins();
              App.toast(T('crf.imported') + v.id);
            });
          }).catch(function (e) {
            App.toast(crfErrText(e), true);
          });
        };
      }
      var crfRm = document.getElementById('btn-crf-remove');
      if (crfRm) {
        crfRm.onclick = function () {
          var list = CrfStore.list();
          if (!list.length) { App.toast(T('crf.none')); return; }
          var last = list[list.length - 1];
          CrfStore.remove(last.id).then(function () {
            Avatar.skinsIndex = (Avatar.skinsIndex || []).filter(function (x) {
              return x.id !== last.id;
            });
            App.renderSkins();
            App.toast(T('crf.removed') + last.id);
          }).catch(function (e) { App.toast(crfErrText(e), true); });
        };
      }
      var peopleBtn = document.getElementById('btn-world-people');
      if (peopleBtn) peopleBtn.onclick = function () { App._showPeople(); };
      document.getElementById('btn-memory-clear').onclick = function () {
        if (!confirm(I18n.t('memory.clearLogAsk'))) return;
        App.memory = []; App.saveMemory(); App.renderMemory();
      };
      var addBtn = document.getElementById('btn-memory-add');
      if (addBtn) addBtn.onclick = function () { App._editMemory(null); };
      var flushBtn = document.getElementById('btn-memory-flush');
      if (flushBtn) flushBtn.onclick = function () {
        if (!window.Memory) return;
        Memory.flushNow().then(function () {
          App.toast(I18n.t('toast.memFlushed'));
          App.renderMemory();
        });
      };
      document.getElementById('btn-settings-reset').onclick = function () {
        if (confirm('恢复所有设置为默认值？')) {
          Config.reset(); App.buildSettings(); App.buildCharaForm();
          App.toast(I18n.t('toast.saved'));
        }
      };
    },

    /* 当前是否在对话页（滚轮缩放只在这里生效，避免影响列表滚动） */
    _viewIsTalk: function () {
      var v = document.getElementById('view-talk');
      return !!(v && v.classList.contains('active'));
    },

    showView: function (name) {
      document.querySelectorAll('.view').forEach(function (v) {
        v.classList.toggle('active', v.id === 'view-' + name);
      });
      document.getElementById('sheet-mode').classList.add('hidden');
      document.getElementById('sheet-inv').classList.add('hidden');
      document.getElementById('sheet-status').classList.add('hidden');
      var npcSheet = document.getElementById('sheet-npc');
      if (npcSheet) npcSheet.classList.add('hidden');
      var langSheet = document.getElementById('sheet-lang');
      if (langSheet) langSheet.classList.add('hidden');
      if (name === 'world') {
        Welcome.milestone('map');   /* local milestone: the official board has no map mission */
        Sound.setRoute('world');
        App.renderWorld();
      } else {
        Sound.setRoute('talk');
      }
      if (name === 'memory') App.renderMemory();
      if (name === 'skin') { Welcome.milestone('skin'); App.renderSkins(); }
      if (name === 'welcome') Welcome.render(document.getElementById('welcome-body'));
      if (name === 'alarm') Welcome.milestone('alarm');
      if (name === 'quest') Quests.render(document.getElementById('quest-list'), {});
      if (name === 'daily') Daily.render(document.getElementById('daily-body'));
    },

    _syncOpenViews: function () {
      var q = document.getElementById('view-quest');
      if (q && q.classList.contains('active')) {
        Quests.render(document.getElementById('quest-list'), {});
      }
      var d = document.getElementById('view-daily');
      if (d && d.classList.contains('active')) Daily.render(document.getElementById('daily-body'));
      if (!document.getElementById('sheet-status').classList.contains('hidden')) App.renderStatus();
      if (!document.getElementById('sheet-inv').classList.contains('hidden')) App.renderInv();
      App.refreshHud();
    },

    /* Single write path for the sit/stand choice: store it, cross-fade the
       skeleton swap (the skin_change SE + veil are the source's own costume
       feedback), and let Avatar.resize() re-solve the camera for the new
       posture. Available wherever the worn outfit has both variants. */
    setPosture: function (posture) {
      if (posture !== 'posture_standing' && posture !== 'posture_sitting') return;
      Config.set('state.posture', posture);
      var veil = document.getElementById('skin-veil');
      if (veil) veil.classList.add('veil-on');
      if (window.Sound) Sound.se('skin_change');
      Avatar.loadSkin(Config.section('state').skin, function () {
        setTimeout(function () { if (veil) veil.classList.remove('veil-on'); }, 260);
        App.updateHud();
      });
    },

    updateHud: function () {
      var st = Config.section('state');
      /* the same localized names the mode sheet shows (source key family
         conversationMode.*) — this used to be a hardcoded Japanese map, so the
         HUD chip stayed 雑談/物語 even in an English UI */
      document.getElementById('hud-mode').textContent = I18n.t('mode.' + st.mode) || st.mode;
      var place = World.find(st.stage);
      document.getElementById('hud-place').textContent =
        place ? World.placeLabel(st.stage, place.stage) : st.stage;
      document.getElementById('hud-tod').textContent = World.todLabel(st.tod);
      var postureBtn = document.getElementById('btn-posture');
      if (postureBtn) {
        /* Offered when the WORN OUTFIT has a variant for both postures — the
           only case where switching really works (the ASMR bikinis exist
           sitting only, and an imported ZIP is one posture). The scene no
           longer gates this: it gated it to one stage out of 38, which is why
           the button looked missing on a fresh install. */
        var both = window.Avatar && Avatar.postureSwitchable && Avatar.postureSwitchable();
        postureBtn.classList.toggle('hidden', !both);
        /* ACTION semantics, not state: the chip is a button, so it names what
           the tap will do. Labelling it with the current posture (standing →
           「立つ」) read as "pressing this makes her stand" while she was
           already standing — the reported 「按站立却变坐」 confusion. */
        postureBtn.textContent = both
          ? (Avatar.postureKey() === 'posture_standing'
              ? I18n.t('posture.sit') : I18n.t('posture.stand'))
          : '';
      }
      var todBtn = document.getElementById('btn-tod-label');
      if (todBtn) todBtn.textContent = World.todLabel(st.tod);
      var dd = document.getElementById('drawer-day');
      if (dd) dd.textContent = I18n.tf('drawer.days', '同伴 {n} 天', { n: (st.day || 1) });
      /* log panel identity line — official shows her name + the current
         mode's description under the avatar (e.g. ASMR: 耳元で震える声で) */
      var ln = document.getElementById('log-name');
      if (ln) ln.textContent = I18n.tc('chara.ryza', 'ライザ');
      var ls = document.getElementById('log-sub');
      if (ls) ls.textContent = I18n.t('mode.sub.' + st.mode) || I18n.t('mode.' + st.mode) || st.mode;
      App._syncSpeedBtn();
      App.refreshHud();
    },

    /* RPG strip: apples (StaminaAppleRow) + coin + level. */
    refreshHud: function () {
      var chip = document.getElementById('hud-stamina');
      if (chip) {
        var a = Game.apples();
        var html = '';
        for (var i = 0; i < a.slots; i++) {
          html += '<img alt="" src="assets/icons/' +
            (i < a.filled ? 'stamina_apple_filled' : 'stamina_apple_empty') + '.svg">';
        }
        html += ' <b>' + (Game.cheat() ? '∞' : Game.s.stamina) + '</b>';
        chip.innerHTML = html;
      }
      var m = document.getElementById('hud-money-n');
      /* official purse pill groups thousands: 43,000 */
      if (m) m.textContent = Game.cheat() ? '∞'
        : String(Game.s.money).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      var lv = document.getElementById('hud-level');
      if (lv) lv.textContent = 'Lv' + Game.level();
      App._dailyBadge();
    },

    gotoStage: function (stageId) {
      var st = Config.section('state');
      Config.set('state.stage', stageId);
      App._loadSceneFor(stageId, st.tod);
      Sound.setPlace(stageId, st.tod, World.backgroundFor(stageId));
      Sound.setRoute('talk');
      App.renderWorld();
      App.updateHud();
      var place = World.find(stageId);
      if (place) App.toast(I18n.tf('talk.mapMove', '来到：{name}', {
        name: World.placeLabel(stageId, place.stage)
      }));
      var npcs = World.npcsAt(stageId, st.day || 1);
      var names = Game.meetCharas(npcs, st.day);
      if (names.length) Game.remember(names.join('、') + ' と出会った。');
      Quests.progressEvent('explore');
      App.showView('talk');
    },

    _setTod: function (tod) {
      if (!World.isTod(tod)) return;
      var s = Config.section('state');
      var prev = s.tod;
      if (tod === prev) return;
      Config.set('state.tod', tod);
      if (prev === 'ngt' && tod === 'mor' && s.stage === HOME_STAGE) {
        Game.refill();
        Game.remember('安全なおうちでぐっすり眠った。');
        App.toast(I18n.t('stamina.slept'));
      }
      App._loadSceneFor(s.stage, tod);
      Sound.setPlace(s.stage, tod, World.backgroundFor(s.stage));
      App.updateHud();
    },

    /* Time passage. 'real' mirrors the official AppServerClock (the scene
       follows the device wall clock); 'flow' runs an in-game clock that ticks
       at app.flowSpeed in-game minutes per real minute and that the LLM can
       also push (see _applySceneDelta); 'manual' leaves it to the 🌤 button.
       A manual tap suppresses auto-sync briefly so a hand-set time isn't
       immediately clobbered. */
    _tickTime: function () {
      if (!window.World || !window.Config) return;
      var app = Config.section('app'), s = Config.section('state');
      var mode = app.timeMode || 'real';
      if (mode === 'manual') return;
      var now = Date.now();
      if ((s.todManualUntil | 0) > now) return;
      var target;
      if (mode === 'real') {
        target = World.hourToTod(new Date().getHours());
      } else {
        var nh = World.flowHour(s.gameHour, s.gameClockAt, now, app.flowSpeed);
        Config.set('state.gameHour', nh);
        Config.set('state.gameClockAt', now);
        target = World.hourToTod(nh);
      }
      if (target && target !== s.tod) App._setTod(target);
    },

    /* The clock line fed to the LLM every turn: day count + current band +
       hour. Official scene.time_bucket is a FACT pushed TO marionette, not a
       command; only local flow mode teaches/accepts a clock write. */
    _clockBlock: function (st) {
      var mode = (Config.section('app').timeMode) || 'real';
      var hour = mode === 'flow' ? Math.floor(Number(st.gameHour) || 12)
               : mode === 'manual' ? World.todStartHour(st.tod)
               : new Date().getHours();
      return '## 現在時刻\n- 同伴 ' + (st.day || 1) + '日目／' +
        World.todLabel(st.tod) + '（約' + hour + '時）';
    },

    /* Talk → map / time of day / sleep. Source: detectEntryMapMove,
       scene.current_stage, scene.time_bucket. Game.applyDelta does not
       know World, so App applies this after the numeric reducer. */
    _applySceneDelta: function (d) {
      if (!d || typeof d !== 'object' || !window.World) return;
      var scene = (d.scene && typeof d.scene === 'object') ? d.scene : {};
      var sleep = d.sleep === true || d.sleep === 'true' || d.sleep === 1 ||
                  scene.sleep === true;
      if (sleep) {
        App._sleepHome();
        return;
      }
      var raw = d.current_stage || d.stage || d.map_move || scene.current_stage;
      if (d.map_moved && !raw) raw = scene.current_stage;
      var s = Config.section('state');
      var fromStage = s.stage, fromTod = s.tod;
      var dest = fromStage;
      if (raw != null && String(raw).trim()) {
        var id = World.resolveStage(String(raw).trim());
        if (id) {
          if (World.locked(World.areaOf(id))) App.toast(I18n.t('world.lockedToast'), true);
          else dest = id;
        }
      }
      /* Official: time_bucket is pushed TO the model (AppServerClock), never
         written back. real/manual ignore LLM tod/time_advance/game_hour.
         flow is the local extension where the LLM may drive one shared clock. */
      var nextTod = fromTod;
      if (World.llmDrivesClock()) {
        var tod = d.tod || d.time_bucket || scene.time_bucket;
        var gh = Number(d.game_hour != null ? d.game_hour : NaN);
        var adv = Number(d.time_advance != null ? d.time_advance :
                         (d.advance_hours != null ? d.advance_hours : NaN));
        var cur = Number(s.gameHour); if (!(cur >= 0 && cur < 24)) cur = 12;
        var nowMs = Date.now();
        if (!isNaN(gh)) cur = ((gh % 24) + 24) % 24;
        else if (!isNaN(adv)) cur = ((cur + adv) % 24 + 24) % 24;
        else if (tod && World.isTod(tod) && tod !== fromTod) cur = World.todStartHour(tod);
        else cur = World.flowHour(cur, s.gameClockAt, nowMs, Config.section('app').flowSpeed);
        Config.set('state.gameHour', cur);
        Config.set('state.gameClockAt', nowMs);
        nextTod = World.hourToTod(cur);
      }
      if (fromTod === 'ngt' && nextTod === 'mor' && dest === HOME_STAGE) {
        Game.refill();
        Game.remember('安全なおうちでぐっすり眠った。');
        App.toast(I18n.t('stamina.slept'));
      }
      if (nextTod !== fromTod) Config.set('state.tod', nextTod);
      if (dest !== fromStage) App.gotoStage(dest);
      else if (nextTod !== fromTod) {
        App._loadSceneFor(fromStage, nextTod);
        Sound.setPlace(fromStage, nextTod, World.backgroundFor(fromStage));
        App.updateHud();
      }
    },

    renderWorld: function () {
      var st = Config.section('state');
      var sel = document.getElementById('world-area');
      World.fillAreaSelect(sel, st.stage);
      var fields = document.getElementById('world-fields');
      /* Official area plates with calibrated pins. The grid stays as the other
         mode: the map is additive, World.render() is untouched. */
      if (window.WorldMap && WorldMap.mode === 'map') {
        /* 官方形态：地图铺满整屏（区域选择改用地图自带的底部条 + 弹层），
           所以这里给世界页挂一个类，让头部与侧栏让位。 */
        var view = document.getElementById('view-world');
        if (view) view.classList.add('map-mode');
        WorldMap.render(fields, st, {
          onPickStage: App.gotoStage,
          onPickArea: function (areaId) {
            var sel2 = document.getElementById('world-area');
            if (sel2) sel2.value = areaId;
          },
          /* 地图模式下头部被隐藏，列表键在地图底部条里 */
          onToggleList: function () { App.toggleWorldMode(); }
        });
      } else {
        var view2 = document.getElementById('view-world');
        if (view2) view2.classList.remove('map-mode');
        World.render(fields,
                     document.getElementById('world-npcs'),
                     st.stage, App.gotoStage);
      }
    },

    /* 地图 / 网格 模式切换 */
    toggleWorldMode: function () {
      if (!window.WorldMap) return;
      var m = WorldMap.toggle();
      var btn = document.getElementById('btn-world-mode');
      if (btn) {
        var label = btn.querySelector('span');
        if (label) label.textContent = (m === 'map') ? '列表' : '地图';
      }
      App.renderWorld();
    },

    /* source: world_map/widgets/area_bottom_sheet.dart + character_avatar */
    _showPeople: function () {
      var st = Config.section('state');
      var day = st.day || 1;
      var list = [], title;
      if (World.mapLevel === 'stages' && World.mapFieldId) {
        list = World.npcsInField(World.mapFieldId, day);
        var pack = World.findField(World.mapFieldId);
        title = pack ? World.placeLabel(pack.field.id, pack.field.name) : I18n.t('world.here');
        list.forEach(function (n) { if (!n.where) n.where = n.stage; });
      } else if (World.mapLevel === 'fields' && World.mapAreaId) {
        list = World.npcsInArea(World.mapAreaId, day);
        var area = World.areas().filter(function (a) { return a.id === World.mapAreaId; })[0];
        title = area ? World.placeLabel(area.id, area.name) : I18n.t('world.areas');
        list.forEach(function (n) { n.where = (n.where || []).join(' / '); });
      } else {
        list = World.npcsAt(st.stage, day);
        var place = World.find(st.stage);
        title = place ? World.placeLabel(st.stage, place.stage) : I18n.t('world.here');
      }
      var sheet = document.getElementById('sheet-npc');
      var root = document.getElementById('npc-sheet-list');
      var head = document.getElementById('npc-sheet-title');
      if (!sheet || !root) return;
      head.textContent = I18n.t('world.peopleOf') + '：' + title;
      root.innerHTML = '';
      if (!list.length) {
        root.innerHTML = '<div class="empty">' + I18n.t('world.empty') + '</div>';
      }
      list.forEach(function (n) {
        var row = document.createElement('div');
        row.className = 'npc-sheet-row';
        var img = document.createElement('img');
        img.src = World.iconFor(n.id);
        img.onerror = function () { img.style.visibility = 'hidden'; };
        var box = document.createElement('div');
        box.className = 'npc-sheet-box';
        var nm = document.createElement('div');
        nm.className = 'npc-name';
        var seen = Game.s.met_charas.indexOf(n.id) !== -1;
        nm.textContent = n.name + (seen ? '' : ' ？');
        var nt = document.createElement('div');
        nt.className = 'npc-note';
        nt.textContent = [n.note, n.where].filter(Boolean).join(' · ');
        box.appendChild(nm); box.appendChild(nt);
        row.appendChild(img); row.appendChild(box);
        row.onclick = function () {
          /* 会ったことのない人には "?" を残す — meeting happens by going there */
          App.toast(n.name + (n.note ? '：' + n.note : ''));
        };
        root.appendChild(row);
      });
      sheet.classList.remove('hidden');
    },

    /* ---------------------------------------------------------- voice input
       Hidden unless the host has a recogniser, and its state has to be honest:
       lit = listening, dimmed = she is talking, so it is visible WHY nothing is
       being heard instead of the mic silently swallowing words. */
    _setupMic: function () {
      var btn = document.getElementById('btn-mic');
      if (!btn) return;
      if (!window.Voice || !Voice.available()) { btn.classList.add('hidden'); return; }
      btn.classList.remove('hidden');
      if (!btn.querySelector('img')) {
        var img = document.createElement('img');
        img.src = 'assets/icons/voicetoggle.svg';   /* the pack's own icon */
        img.alt = '';
        btn.appendChild(img);
      }
      btn.onclick = function () {
        /* First tap arms the feature (settings has the same switch) — otherwise
           the control exists but does nothing and looks broken. */
        if (Config.section('app').stt === 'off') Config.set('app.stt', 'webSpeech');
        Voice.toggle();
      };
      Voice.onState(function () { App._syncMic(); });
      App._syncMic();
    },

    _syncMic: function () {
      var btn = document.getElementById('btn-mic');
      if (!btn || !window.Voice) return;
      var on = Voice.isListening();
      var blocked = on && !!(window.Turn && Turn.isSpeaking());
      btn.classList.toggle('listening', on);
      btn.classList.toggle('blocked', blocked);
      btn.title = I18n.t(on ? 'mic.stop' : 'mic.start');
    },

    /* Barge-in is armed only when the player turned it on. Kept in one place so
       the settings switch and boot agree. */
    _syncBargeIn: function () {
      if (!window.Voice || !Voice.setBargeIn) return;
      var on = !!Config.section('app').bargeIn;
      Voice.setBargeIn(on ? function () {
        if (window.Turn) Turn.interrupt('user-barge-in');
      } : null);
    },

    /* An accepted transcript — Echo and the half-duplex gate already had their
       say. It lands in the input box exactly like typed text, and auto-send goes
       through the send button so there is one send path, not two. */
    _onVoiceTranscript: function (text) {
      var inp = document.getElementById('input');
      if (!inp) return;
      inp.value = text;
      if (!Config.section('app').autoSend) return;
      var delay = Math.max(0, Number(Config.section('app').autoSendDelay) || 2000);
      if (App._autoSendTimer) clearTimeout(App._autoSendTimer);
      App._autoSendTimer = setTimeout(function () {
        App._autoSendTimer = null;
        /* The player may have edited it while the timer ran — then it is theirs
           to send, not ours. */
        if (String(inp.value).trim() !== String(text).trim()) return;
        var send = document.getElementById('btn-send');
        if (send) send.click();
      }, delay);
    },

    /* -------------------------------------------------------------- talk */
    _bindTalk: function () {
      var input = document.getElementById('input');
      var send = document.getElementById('btn-send');
      var go = function () {
        var text = input.value.trim();
        if (!text || App.speaking) return;
        input.value = '';
        App.say(text);
      };
      send.onclick = go;
      input.onkeydown = function (e) { if (e.key === 'Enter') go(); };
      var hitEl = document.getElementById('avatar-hit');
      hitEl.onclick = function (ev) {
        /* A drag ends with a click event; the pointer is not a tap then. */
        if (App._dragMoved) { App._dragMoved = false; return; }
        if (App._inTutorial) { Onboarding.tutorialAdvance(); return; }
        var rect = ev.target.getBoundingClientRect();
        /* rect is in viewport px; layout px need the zoom divided out
           (identity when zoom is 1 — phones/browser). */
        var z = (window.Avatar && Avatar.cssZoom) ? Avatar.cssZoom(ev.target) : 1;
        var x = (ev.clientX - rect.left) / z, y = (ev.clientY - rect.top) / z;
        var part = Avatar.hitPartAt(x, y);
        if (!part) return;   /* miss = no ripple, no SE, no reaction */
        App._ripple(x, y);
        var overlay = Avatar.poke(part);
        Welcome.mark('touch');   /* official activity: app_launched x1 */
        App.buzz();
        if (window.Sound) {
          Sound.se('touch_start');
          if (overlay) Sound.tapVoice(overlay);
        }
      };
      /* 拖动立绘（报告：只能缩放背景、立绘拖不动）。阈值 6px：手指抖动仍算点
         击（分部位点击必须活着），超过阈值才接管，并在随后的 click 里让位。 */
      App._bindDrag(hitEl);
      var retry = document.getElementById('btn-retry');
      if (retry) retry.onclick = function () {
        document.getElementById('retry-bar').classList.add('hidden');
        if (App._lastText) App.say(App._lastText);
      };
    },

    _bindOverlays: function () {
      document.getElementById('onb-next').onclick = function () { Onboarding.next(); };
      document.getElementById('onb-skip').onclick = function () { Onboarding.skip(); };
      document.getElementById('overlay-prologue').onclick = function () { Onboarding.prologueNext(); };
      document.getElementById('ring-dismiss').onclick = function () { App._dismissAlarm(); };
      document.getElementById('ring-snooze').onclick = function () { App._snoozeAlarm(); };
      document.getElementById('qc-ok').onclick = function () {
        document.getElementById('overlay-quest-clear').classList.add('hidden');
        if (Quests.pendingAdvance()) {
          Quests.takeNext();
          Quests.render(document.getElementById('quest-list'), {});
          Welcome.mark('mission_clear');   /* official activity: app_launched x3 */
          var st = Config.section('state');
          var clip = VoiceBank.pick('wellDone', st.mode === 'asmr' ? 'whisper' : 'normal',
                                    Alarm.todForHour(new Date().getHours()));
          setTimeout(function () { clip && App.playFile(clip); }, 500);
        }
      };
      document.getElementById('faint-cancel').onclick = function () {
        document.getElementById('overlay-faint').classList.add('hidden');
      };
      document.getElementById('faint-sleep').onclick = function () { App._sleepHome(); };
      document.getElementById('faint-cheat').onclick = function () {
        if (!Game.cheat()) {
          Config.set('app.cheat', true);
          App.toast(I18n.t('cheat.on'));
        }
        Game.refill();
        document.getElementById('overlay-faint').classList.add('hidden');
        App.buildSettings();
      };
      document.querySelectorAll('.sheet-handle').forEach(function (h) {
        h.onclick = function () {
          var sheet = h.parentElement;
          if (sheet) sheet.classList.add('hidden');
        };
      });
    },

    _showFaint: function () {
      var ov = document.getElementById('overlay-faint');
      var cheatBtn = document.getElementById('faint-cheat');
      if (cheatBtn) cheatBtn.classList.toggle('hidden', !Game.cheat());
      if (ov) ov.classList.remove('hidden');
      Avatar.setEmotion('crying', 'deny');
    },

    _sleepHome: function () {
      var st = Config.section('state');
      var tod = st.tod;
      Config.set('state.stage', HOME_STAGE);
      /* flow: sleeping skips the in-game clock to morning. real/manual keep
         the current band (real stays on the wall clock; official sleep does
         not jump AppServerClock). Stamina refill is independent of lighting. */
      if (World.llmDrivesClock()) {
        tod = 'mor';
        Config.set('state.tod', 'mor');
        Config.set('state.gameHour', World.todStartHour('mor'));
        Config.set('state.gameClockAt', Date.now());
      }
      App._loadSceneFor(HOME_STAGE, tod);
      Sound.setPlace(HOME_STAGE, tod, World.backgroundFor(HOME_STAGE));
      Game.refill();
      Game.remember('安全なおうちでぐっすり眠った。');
      document.getElementById('overlay-faint').classList.add('hidden');
      App.showView('talk');
      App.toast(I18n.t('stamina.slept'));
      App.updateHud();
    },

    _onSailed: function () {
      Game.remember('船でクーケン島を出航した！');
      App.toast(I18n.t('toast.sailed'));
      App.showView('world');
      App.renderWorld();
    },

    /* ------------------------------------------------------- status sheet */
    renderStatus: function () {
      var root = document.getElementById('status-body');
      if (!root) return;
      root.innerHTML = '';
      var a = Game.apples();
      var appleHtml = '';
      for (var i = 0; i < a.slots; i++) {
        appleHtml += '<img class="apple-mini" alt="" src="assets/icons/' +
          (i < a.filled ? 'stamina_apple_filled' : 'stamina_apple_empty') + '.svg">';
      }
      var e = Game.expIntoLevel();
      function row(k, v) {
        var d = document.createElement('div');
        d.className = 'st-row';
        var kk = document.createElement('span'); kk.className = 'st-k'; kk.textContent = k;
        var vv = document.createElement('span'); vv.className = 'st-v'; vv.innerHTML = v;
        d.appendChild(kk); d.appendChild(vv);
        root.appendChild(d);
        return d;
      }
      function sect(t) {
        var d = document.createElement('div');
        d.className = 'st-sect'; d.textContent = t;
        root.appendChild(d);
      }
      sect(I18n.t('st.level') + ' ' + Game.level());
      row(I18n.t('stamina') || 'スタミナ', appleHtml + ' <b>' + (Game.cheat() ? '∞' : Game.s.stamina + '/' + Game.max()) + '</b>');
      row(I18n.t('st.exp'), e.into + ' / ' + e.span + '（' + Game.s.exp_total + '）');
      row('G', Game.cheat() ? '∞' : String(Game.s.money));
      var q = Quests.active();
      if (q) row(I18n.t('quest.goal'),
        '「' + App.esc(q.title) + '」 ' + (q.step | 0) + '/' + q.need);
      row(I18n.t('st.met'), String(Game.s.met_charas.length));
      if (Game.s.met_charas.length && window.World && World.npcs) {
        var names = Game.s.met_charas.slice(-12).reverse()
          .map(function (id) { return World.npcName(id); }).join('、');
        var nr = document.createElement('div');
        nr.className = 'st-mem';
        nr.textContent = names;
        root.appendChild(nr);
      }
      row(I18n.t('quest.ship'), Game.flag('ship_parts', 0) + ' / 4' + (Game.s.sailed ? ' ⛵' : ''));

      sect(I18n.t('st.memory'));
      var mems = Game.s.memory.slice(-12).reverse();
      if (!mems.length) {
        var e2 = document.createElement('div');
        e2.className = 'empty'; e2.textContent = I18n.t('memory.empty');
        root.appendChild(e2);
      }
      mems.forEach(function (m) {
        var d = document.createElement('div');
        d.className = 'st-mem'; d.textContent = m.text;
        root.appendChild(d);
      });
    },

    /* ------------------------------------------------------ inventory sheet */
    renderInv: function () {
      var which = App._invBag;
      var root = document.getElementById('inv-list');
      root.innerHTML = '';
      var list = Game.bagList(which);
      if (!list.length) {
        root.innerHTML = '<div class="empty">' + I18n.t('inv.empty') + '</div>';
      }
      list.forEach(function (it) {
        var row = document.createElement('div');
        row.className = 'inv-row';
        row.innerHTML = '<span class="inv-name"></span><span class="inv-n"></span>';
        /* Game.itemName, not the raw catalogue name: this list was the one place
           that skipped localisation, so the same item read 「漂流WOOD」 here and
           the translated name in the quest line beside it. */
        var name = Game.itemName(it.id);
        row.querySelector('.inv-name').textContent = name;
        row.querySelector('.inv-n').textContent = '×' + (it.count || 1);
        row.onclick = function () {
          var inp = document.getElementById('input');
          inp.value = ((inp.value || '') + ' ' + name).trim();
          document.getElementById('sheet-inv').classList.add('hidden');
          App.showView('talk');
          inp.focus();
        };
        root.appendChild(row);
      });
      var cap = document.getElementById('inv-cap');
      if (cap) cap.textContent = I18n.t('inv.cap')
        .replace('{u}', String(Game.bagUsed(which)))
        .replace('{c}', String(Game.bagCap(which)));
      var up = document.getElementById('btn-bag-up');
      if (up) {
        var order = Game.BAG_ORDER;
        var cur = which === 'ryza' ? Game.s.bagRyza : Game.s.bagYou;
        var idx = order.indexOf(cur);
        var next = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
        var price = next ? (Game.BAG_UPGRADE_COST[next] || 0) : 0;
        up.classList.toggle('hidden', !next);
        if (next) {
          up.textContent = I18n.t('inv.upgrade').replace('{p}', String(price));
          up.onclick = function () {
            if (Game.upgradeBag(which)) {
              App.toast(I18n.t('inv.upgraded'));
              if (window.Sound) Sound.se('quest_clear');
            } else {
              App.toast(I18n.t('inv.tooSmall'), true);
            }
            App.renderInv();
          };
        }
      }
    },

    /* Scene facts every talk mode gets (source marionette_injection:
       scene.current_stage / time_bucket / cast). Location is on screen
       even in ASMR — without this block the model cannot name a place
       or emit current_stage. */
    _sceneContext: function () {
      var st = Config.section('state');
      var parts = [];
      if (window.World && World.promptBlock) parts.push(World.promptBlock(st));
      parts.push(App._peopleBlock(st));
      if (window.World) parts.push(App._clockBlock(st));
      return parts.filter(Boolean).join('\n\n');
    },

    /* Numeric RPG (stamina / bags / quests) — chat/story/immersive only.
       ASMR/text still receive _sceneContext so they can travel/sleep. */
    _rpgContext: function () {
      var st = Config.section('state');
      if (!RPG_MODES[st.mode]) return '';
      return [Game.promptBlock(), Quests.promptBlock()].filter(Boolean).join('\n\n');
    },

    /* met_charas / npcs here — the official game state fed these to the
       model so Ryza can reference other islanders by name. */
    _peopleBlock: function (st) {
      if (!window.World || !World.npcs) return '';
      var L = ['## この世界の人々（ライザ以外）'];
      var here = World.npcsAt(st.stage, st.day || 1);
      L.push('- いま同じ場所にいる人：' +
        (here.length ? here.map(function (n) {
          return World.npcName(n.id) + (n.note ? '（' + n.note + '）' : '');
        }).join('、') : 'いない'));
      var known = {};
      (World.npcs.npcs || []).forEach(function (n) { known[n.id] = n; });
      var met = (Game.s.met_charas || [])
        .map(function (id) { return known[id]; })
        .filter(Boolean).slice(0, 16);
      if (met.length) {
        L.push('- これまでに会った人：' + met.map(function (n) {
          return World.npcName(n.id) + (n.note ? '（' + n.note + '）' : '');
        }).join('、'));
      }
      /* Facts above, roster + protocol below — the model cannot use a cast it
         was never shown (web/js/npc.js). */
      if (window.Npc && Npc.promptBlock) {
        var npcBlock = Npc.promptBlock(st, {
          appCfg: Config.section('app'),
          /* 回复语言与界面语言不同时，才允许模型附带「译文：」行 */
          translate: !!(window.Langs && Langs.llm && Langs.ui && Langs.llm() !== Langs.ui())
        });
        if (npcBlock) L.push('', npcBlock);
      }
      return L.join('\n');
    },

    /* re-paint every localized surface after a language change */
    _relocalize: function () {
      App.buildSettings();
      App.buildCharaForm();
      App.updateHud();
      var inp = document.getElementById('input');
      if (inp) inp.placeholder = I18n.tc('input.hint', inp.placeholder);
      Quests.render(document.getElementById('quest-list'), {});
      Daily.render(document.getElementById('daily-body'));
      Welcome.render(document.getElementById('welcome-body'));
      App.renderWorld();
      App.renderStatus();
      /* the three panels that also carry UI strings (2026-09-07 audit fix:
         these used to keep the old language until you happened to reopen them) */
      if (document.getElementById('skin-grid')) App.renderSkins();
      if (document.getElementById('memory-list')) App.renderMemory();
      if (window.Alarm && Alarm.render) {
        var al = document.getElementById('alarm-list');
        if (al) Alarm.render(al, App.playFile);
      }
      if (App._syncVoicePill) App._syncVoicePill();
      App._syncSpeedBtn();
    },

    _openLangSheet: function () {
      var sheet = document.getElementById('sheet-lang');
      var list = document.getElementById('lang-list');
      if (!sheet || !list) return;
      list.innerHTML = '';
      (I18n.LANGS || []).forEach(function (item) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'mode-pill' + (I18n.lang === item.id ? ' active' : '');
        b.textContent = item.label;
        b.onclick = function () {
          Config.set('app.lang', item.id);
          I18n.setLang(item.id);
          App.applyI18n(document);
          App._relocalize();
          sheet.classList.add('hidden');
        };
        list.appendChild(b);
      });
      sheet.classList.remove('hidden');
    },

    _toggleChara: function () {
      var on = !(Avatar && Avatar.isHidden && Avatar.isHidden());
      if (Avatar && Avatar.setHidden) Avatar.setHidden(on);
      var ico = document.getElementById('ico-toggle-chara');
      if (ico) ico.src = on ? 'assets/icons/chara_show.svg' : 'assets/icons/chara_hide.svg';
    },

    _toggleFullscreen: function () {
      var el = document.getElementById('phone') || document.documentElement;
      var cur = document.fullscreenElement || document.webkitFullscreenElement;
      var req = el.requestFullscreen || el.webkitRequestFullscreen;
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (!cur) {
        req && req.call(el);
        Config.set('app.fullscreen', true);
      } else {
        exit && exit.call(document);
        Config.set('app.fullscreen', false);
      }
    },

    _confirmNewTalk: function () {
      App.openModal({
        title: I18n.t('talk.resetTitle'),
        okLabel: I18n.t('talk.resetOk'),
        build: function (body) {
          var p = document.createElement('p');
          p.className = 'onb-sub';
          p.textContent = I18n.t('talk.resetMsg');
          body.appendChild(p);
        },
        onOk: function () {
          App.history = [];
          if (window.Nsfw) Nsfw.reset();
          App._pages = []; App._pageSel = -1;
          var dots = document.getElementById('log-dots');
          if (dots) dots.innerHTML = '';
          var bub = document.getElementById('bubble');
          if (bub) bub.classList.remove('hidden');
          var bt = document.getElementById('bubble-text');
          if (bt) bt.textContent = '';
          App.showView('talk');
          App.greet();
        }
      });
    },

    greet: function () {
      var st = Config.section('state');
      var line = st.day > 1 ? I18n.tc('greet.n', '……今日も、会えたね。')
                            : I18n.tc('greet.1', '……やあ、会えたね。');
      App.showBubble(line);
      Avatar.setEmotion('happy', 'agree');
    },

    say: function (text) {
      var st = Config.section('state');
      if (!Config.section('llm').apiKey) {
        App.toast(I18n.t('toast.needKey'), true);
        App.showView('settings');
        return;
      }
      if (Game.faint() || !Game.canAct(Game.turnCost(st.mode, st.style))) {
        App.toast(I18n.t('toast.staminaOut'), true);
        App._showFaint();
        return;
      }
      App._lastText = text;
      var retryBar = document.getElementById('retry-bar');
      if (retryBar) retryBar.classList.add('hidden');
      App.speaking = true;
      document.getElementById('btn-send').disabled = true;
      App.showTyping();
      Welcome.mark('talk');            /* official activity: app_launched x5 */

      /* A new turn supersedes whatever was in flight: it stops her speech,
         drops queued lines, and invalidates a reply still on the wire (the
         epoch Api.chat re-checks when it resolves). */
      var turnEpoch = (window.Turn && Turn.beginTurn) ? Turn.beginTurn('say') : null;
      /* 本轮用户说的话作为长期记忆的相关度线索（cue），
         并把这一轮记进待归纳队列（攒够 PENDING_MAX 自动归纳一次）。 */
      if (window.LongTerm) {
        try { LongTerm.note('user', text); } catch (e) {}
      }
      Api.chat(App.history, text, {
        mode: st.mode, style: st.style,
        epoch: turnEpoch,
        cue: text,
        rpgContext: App._rpgContext(),
        sceneSection: App._sceneContext(),
        nsfwSection: window.Nsfw ? Nsfw.screenFact() : ''
      })
        .then(function (reply) {
          /* A reply that is no longer the current turn must not land at all —
             not the history, not the game state, not the face. */
          if (!App._turnCurrent(turnEpoch)) return;
          App.speaking = false;
          if (window.Turn && Turn.finishTurn) Turn.finishTurn();
          document.getElementById('btn-send').disabled = false;
          App.history.push({ role: 'user', content: text });
          App.remember('user', text);
          App.remember('ryza', reply.text);
          try { if (window.Memory) Memory.ingest(text, reply.text); } catch (e) {}

          if (reply.state && typeof reply.state === 'object') {
            Game.applyDelta(reply.state, 'llm');
            App._applySceneDelta(reply.state);
          }
          var cost = Game.turnCost(st.mode, st.style);
          Game.spend(cost, 'talk');

          if (window.Nsfw) Nsfw.onTurn(reply);
          /* Omit = keep (same as undress). A missed tag must not snap the face
             back to neutral/agree. */
          if (reply.emotion || reply.attitude) {
            Avatar.setEmotion(reply.emotion, reply.attitude);
          }
          /* After side effects so the echoed line matches the new screen.
             All fields (emotion / undress / stage) live on this one line —
             stripping it from history made every column decay together. */
          App.history.push({
            role: 'assistant',
            content: Api.formatHistoryReply(reply.text)
          });
          App._sayReply(reply, turnEpoch);
          /* 助手这一轮进长期记忆的待归纳队列（被 STALE 丢弃的回复不会走到这里） */
          if (window.LongTerm) {
            try { LongTerm.note('assistant', reply.text); } catch (e) {}
          }

          /* Talk-quests advance once per turn — if the LLM already reported
             quest progress through <state>, don't double-count it here. */
          if (!(reply.state && reply.state.quest)) Quests.progressEvent('talk');
          Quests.render(document.getElementById('quest-list'), {});
        })
        .catch(function (e) {
          /* Superseded on purpose (interruption / a newer turn): there is
             nothing to report and no retry to offer — surfacing it would look
             like a failure for something the user asked for.
             This check MUST come before the state resets below: it used to sit
             after them, so an aborted reply cleared App.speaking, pushed Turn
             back to idle and re-enabled the send button *while the newer turn
             was still generating* — the UI claimed it was not thinking and
             accepted a third overlapping send. */
          if (e && e.stale) return;
          if (!App._turnCurrent(turnEpoch)) return;
          App.speaking = false;
          if (window.Turn && Turn.finishTurn) Turn.finishTurn();
          document.getElementById('btn-send').disabled = false;
          var bar = document.getElementById('retry-bar');
          if (bar && e.message !== 'NO_KEY') bar.classList.remove('hidden');
          var msg = String(e.message || '');
          var kind = App._failKind(e);
          App.toast(kind === 'nokey' ? I18n.t('toast.needKey')
                 : kind === 'auth' ? I18n.t('toast.llmAuth')
                 : kind === 'model' ? I18n.t('toast.llmModel')
                 : I18n.t('toast.llmFail') + msg, true);
          /* 面板台词必须指向真正的原因。原来不管什么错都写「没听见，再说一次」——
             而那多数是端点/密钥问题，玩家会一直重发而不会去改设置。 */
          App.showBubble(I18n.tc('bubble.fail.' + kind,
            kind === 'nokey' ? '（……ねえ、設定でAPIキーを入れないと、あたしの声が届かないみたい。）'
            : kind === 'auth' ? '（……あれ、鍵が合ってないみたい。設定を見直してくれる？）'
            : kind === 'model' ? '（……そのモデル名、あたしには呼べないみたい。設定を確認して。）'
            : kind === 'timeout' ? '（……返事を待ってるのに、届いてないみたい。設定のベースURLとモデル名、見てくれる？）'
            : kind === 'net' ? '（……そのアドレスに辿り着けないみたい。設定のベースURL、合ってる？）'
            : '（……ごめん、今ちょっと繋がらないみたい。少し待ってからもう一回。）'));
        });
    },

    /* 把模型端点的失败归类，让提示指向真正的原因。
       传输层那两条优先看 Api 挂上的 err.code —— 文案已经本地化，不能再拿中文去匹配；
       其余只依据错误文本（各家端点错误码不统一）：
         nokey 没填 Key / auth 401|403 认证失败 / model 模型名不被接受 /
         timeout 端点不回 / net 地址不可达 / other 其余 */
    _failKind: function (err) {
      var code = (err && typeof err === 'object' && err.code) || '';
      if (code === 'timeout' || code === 'net') return code;
      var m = String((err && err.message) || err || '');
      if (m === 'NO_KEY' || /NO_KEY|needKey/i.test(m)) return 'nokey';
      if (/401|403|unauthor|invalid[_ ]api[_ ]key|forbidden/i.test(m)) return 'auth';
      if (/model|not found|unsupported/i.test(m)) return 'model';
      return 'other';
    },

    /* Is the turn with this epoch still the one in charge? Null means there is
       no turn layer (or no canceller was injected), so there is nothing to
       compare against and the caller is treated as current. */
    _turnCurrent: function (epoch) {
      if (epoch == null) return true;
      if (!window.Turn || !Turn.epoch) return true;
      return Turn.epoch() === epoch;
    },

    /* A reply can now carry more than one speaker (web/js/npc.js). Her lines are
       typed and spoken; another islander's lines are text only, and they wait
       until she has finished talking — otherwise the panel gets rewritten
       mid-sentence while her voice is still going. */
    _sayReply: function (reply, turnEpoch) {
      var beats = (window.Npc && Npc.split)
        ? Npc.split(reply.text)
        : [{ speaker: 'ryza', id: '', name: '', text: String(reply.text || '') }];
      if (!beats.length) { App.typeBubble(''); return; }
      var mine = (window.Npc && Npc.spokenText) ? Npc.spokenText(beats) : reply.text;
      /* 「原文/译文」显示策略。译文行**永不进 TTS**：它不在 mine 里
         （spokenText 只取 ryza 拍），只在这里决定要不要显示。
         设置里关掉「显示原文」时，面板先不写她的原句、只留译文行——
         但语音照旧读原句（朗读与显示是两条线）。 */
      var showOriginal = true;
      try {
        var appCfg = Config.section('app') || {};
        if (appCfg.showOriginal === false) showOriginal = false;
      } catch (e) {}
      var others = beats.filter(function (b) {
        if (b.speaker === 'ryza') return false;
        /* 只要译文时，旁白/译文照显，NPC 行也保留（是别的角色在说话） */
        return true;
      });
      if (!showOriginal && others.some(function (b) { return b.speaker === 'translation'; })) {
        mine = '';                       /* 不写原句，等下面只显示译文行 */
      }

      var showOthers = function () {
        var i = 0;
        (function next() {
          if (i >= others.length) return;
          var b = others[i++];
          var lab = Npc.labelFor(b);
          App.typeBubble(lab ? lab + '：' + b.text : b.text, next);
        })();
      };

      App.typeBubble(mine, function () {
        /* The typewriter runs at the player's text speed, and the player can
           send a new message while it is still going. Showing the line is fine
           (it is what she said), but by the time it finishes this reply may no
           longer be the current turn — and voicing it then speaks the
           superseded line over the new one, with the new reply queued behind
           it. */
        if (!App._turnCurrent(turnEpoch)) return;
        if (mine) App.speakThen(mine, reply.emotion);
        if (!others.length) return;
        if (window.Turn && Turn.isSpeaking()) {
          var off = Turn.on(function (ev) {
            if (ev.type !== 'end' && ev.type !== 'cancel') return;
            off();
            showOthers();
          });
        } else {
          showOthers();
        }
      });
    },

    speakThen: function (text, emotion) {
      var st = Config.section('state');
      var app = Config.section('app');
      if (!app.voice || st.style === 'text' || Config.section('tts').mode === 'off') return;
      /* Turn owns the utterance: it runs the synth port (which applies the
         language matrix and the per-mode voice direction) and the player port,
         and it is what an interruption cancels. */
      Turn.speak(text, {
        mode: st.mode,
        emotion: emotion || (window.Avatar && Avatar.currentEmotion && Avatar.currentEmotion()) || '',
        fx: Api.MODE_PLAY_FX[st.mode] || null,
        ownerId: 'chat'
      });
    },

    /* 重播上一段语音（从缓存取，不重新合成）。 */
    replayLastVoice: function () {
      if (!window.VoiceCache || !App._lastVoiceKey) { App.toast('没有可重播的语音'); return; }
      VoiceCache.urlFor(App._lastVoiceKey).then(function (url) {
        if (!url) { App.toast('这段语音已不在缓存里'); return; }
        var a = App.audio;
        if (!a) return;
        try {
          a.src = url;
          a.playbackRate = 1;
          a.play().catch(function () {});
          Avatar.setTalking(true);
          a.onended = function () { Avatar.setTalking(false); try { URL.revokeObjectURL(url); } catch (e) {} };
        } catch (e) { App.toast('重播失败'); }
      }).catch(function () { App.toast('重播失败'); });
    },

    /* 收藏 / 取消收藏上一段语音（收藏的片段不会被字节预算逐出） */
    favLastVoice: function () {
      if (!window.VoiceCache || !App._lastVoiceKey) { App.toast('没有可收藏的语音'); return; }
      var on = VoiceCache.toggleFav(App._lastVoiceKey);
      App.toast(on ? '已收藏这段语音' : '已取消收藏');
    },

    /* Shared end-of-audio bookkeeping. The rate reset is not cosmetic: ASMR
       plays at 0.93× and a missed reset made the next alarm/tap clip play
       detuned (AUDIT 8). */
    _stopAudio: function (url, holdMs) {
      var a = App.audio;
      if (a) {
        try { a.pause(); } catch (e) {}
        a.playbackRate = 1;
      }
      Avatar.setTalking(false);
      if (url) URL.revokeObjectURL(url);
      App._bubbleHold(holdMs);
    },

    /* Speech playback for Turn: identical bookkeeping to playUrl, plus the
       abort path so an interruption stops the audio mid-utterance and returns
       immediately instead of waiting for the clip to end. */
    playSpeech: function (url, signal, fx) {
      var a = App.audio;
      return new Promise(function (resolve) {
        var done = false;
        function clean() {
          if (!a) return;
          a.removeEventListener('ended', settle);
          a.removeEventListener('error', stop);
          if (signal) signal.removeEventListener('abort', stop);
        }
        function settle() { if (done) return; done = true; clean(); resolve(); }
        function stop() { App._stopAudio(url, 1600); settle(); }
        if (!a) { settle(); return; }
        a.addEventListener('ended', settle);
        /* A failed load / decode fires `error`, not `ended`, and a rejected
           play() (autoplay policy) never fires either. Without these two the
           returned promise stayed pending forever: Turn stayed in SPEAKING, and
           because Voice gates transcripts on Turn.isSpeaking() the microphone
           would be deaf for the rest of the session — the one failure mode the
           turn layer is not allowed to have. */
        a.addEventListener('error', stop);
        if (signal) {
          if (signal.aborted) { stop(); return; }
          signal.addEventListener('abort', stop);
        }
        Promise.resolve(App.playUrl(url, fx)).catch(function () { stop(); });
      });
    },

    /* fx: optional { rate, gain } per-mode playback shaping (see
       Api.MODE_PLAY_FX — ASMR slows and softens even on endpoints that
       ignore voice instructions). */
    playUrl: function (url, fx) {
      App._ensureVoiceGraph();
      if (App._voiceCtx && App._voiceCtx.state === 'suspended') {
        App._voiceCtx.resume().catch(function () {});
      }
      var a = App.audio;
      a.src = url;
      var base = (window.Sound && Sound._gain) ? Sound._gain('voice')
        : (Number(Config.section('app').volume) || 0.9);
      a.volume = Math.max(0, Math.min(1, base * ((fx && fx.gain) || 1)));
      a.playbackRate = (fx && fx.rate) || 1;
      a.onended = function () { App._stopAudio(url, 1600); };
      Avatar.setTalking(true);
      App._bubbleKeep();         /* stay put while she talks */
      var playing = a.play();
      if (playing && typeof playing.catch === 'function') {
        playing.catch(function () { Avatar.setTalking(false); });
      }
      App.buzz();
      return playing;            /* callers that need to know it failed use this */
    },

    _pauseVoice: function () {
      if (App.audio) { try { App.audio.pause(); } catch (e) {} }
      if (Avatar && Avatar.setTalking) Avatar.setTalking(false);
    },

    playFile: function (path, vol, force) {
      if (!force && !Config.section('app').voice) return;
      App._ensureVoiceGraph();
      if (App._voiceCtx && App._voiceCtx.state === 'suspended') {
        App._voiceCtx.resume().catch(function () {});
      }
      var a = App.audio;
      a.src = path;
      a.volume = vol != null ? vol : ((window.Sound && Sound._gain) ? Sound._gain('voice')
        : (Number(Config.section('app').volume) || 0.9));
      Avatar.setTalking(true);
      if (window.Alarm && Alarm.loadEnv) {
        Alarm.loadEnv(path).then(function (env) {
          if (env && Avatar.setTalkingEnvelope) Avatar.setTalkingEnvelope(env);
        });
      }
      a.onended = function () { Avatar.setTalking(false); };
      a.play().catch(function () { Avatar.setTalking(false); });
      App.buzz();
    },

    /* ------------------------------------------------- log panel lifecycle
       2026-09-07 UI pass: the floating auto-fading bubble is gone. The
       official talk screen keeps a bottom log panel — avatar + name + mode
       description, the current line, page dots for the last few replies, and
       a ⇧ that expands the whole running conversation. _bubbleKeep/_bubbleHold
       stay as no-op seams (playUrl/speakThen still call them); nothing
       self-hides anymore, so the old fade race is structurally impossible. */
    _pages: [],
    _pageSel: -1,
    _typeGen: 0,
    _bubbleKeep: function () {
      if (App._bubbleTimer) { clearTimeout(App._bubbleTimer); App._bubbleTimer = null; }
    },
    _bubbleHold: function () { /* panel is persistent — no scheduled fade */ },
    _bubbleReveal: function () { /* no-op seam */ },

    /* the pill's own two official placeholder states (input.hint lives in
       the CONTENT table → tc; input.waiting is a UI key → t) */
    _inputHint: function (waiting) {
      var inp = document.getElementById('input');
      if (!inp) return;
      inp.placeholder = waiting ? I18n.t('input.waiting')
                                : I18n.tc('input.hint', inp.placeholder);
    },

    _pushPage: function (text) {
      if (!text) return;
      var last = App._pages[App._pages.length - 1];
      if (last === text) return;
      App._pages.push(text);
      if (App._pages.length > 5) App._pages.shift();
      App._pageSel = App._pages.length - 1;
      App._renderDots();
    },
    _renderDots: function () {
      var host = document.getElementById('log-dots');
      if (!host) return;
      host.innerHTML = '';
      if (App._pages.length < 2) return;
      App._pages.forEach(function (t, i) {
        var d = document.createElement('i');
        if (i === App._pageSel) d.className = 'on';
        d.title = (i + 1) + ' / ' + App._pages.length;
        d.onclick = function () {
          App._pageSel = i;
          document.getElementById('bubble-text').textContent = App._pages[i];
          var lb = document.getElementById('log-body');
          if (lb) lb.scrollTop = 0;   // reviewing an older message: read from its top
          App._renderDots();
        };
        host.appendChild(d);
      });
    },
    _cycleTextSpeed: function () {
      var cur = Config.textSpeed();
      var idx = 0;
      Config.TEXT_SPEEDS.forEach(function (o, i) { if (o.v === cur) idx = i; });
      var nxt = Config.TEXT_SPEEDS[(idx + 1) % Config.TEXT_SPEEDS.length];
      Config.set('app.textSpeed', nxt.v);
      App._syncSpeedBtn();
    },
    _syncSpeedBtn: function () {
      var b = document.getElementById('btn-speed');
      if (!b) return;
      var cur = Config.textSpeed();
      var label = { 30: '×1', 18: '×1.5', 12: '×2', 8: '×3' };
      b.textContent = label[cur] || (cur <= 10 ? '×3' : cur <= 15 ? '×2' : cur <= 24 ? '×1.5' : '×1');
    },

    /* a new line always brings the panel back (official: she never talks
       into a collapsed strip) */
    _panelUp: function () {
      var phone = document.getElementById('phone');
      if (phone && phone.classList.contains('panel-collapsed')) {
        phone.classList.remove('panel-collapsed');
        var arrow = document.querySelector('#btn-log-toggle img');
        if (arrow) arrow.style.transform = '';
      }
    },

    showTyping: function () {
      App._panelUp();
      var b = document.getElementById('bubble');
      var vig = document.getElementById('vignette');
      if (b) {
        b.classList.remove('hidden');
        b.classList.add('typing', 'speaking');
      }
      document.getElementById('bubble-text').innerHTML =
        '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>';
      if (vig) vig.classList.add('talk-glow');
      App._inputHint(true);
    },

    showBubble: function (text) {
      App._panelUp();
      var vig = document.getElementById('vignette');
      if (vig) vig.classList.remove('talk-glow');
      var b = document.getElementById('bubble');
      if (b) b.classList.remove('typing', 'speaking', 'hidden');
      if (Config.section('app').showBubble === false) return;
      document.getElementById('bubble-text').textContent = text;
      App._pushPage(text);
      App._inputHint(false);
    },

    typeBubble: function (text, done) {
      App._panelUp();
      if (App._typeTimer) clearTimeout(App._typeTimer);
      /* generation token: a second chain (retry/alarm while the first line is
         still typing) kills the old one instead of interleaving writes */
      var gen = ++App._typeGen;
      var b = document.getElementById('bubble');
      var span = document.getElementById('bubble-text');
      var vig = document.getElementById('vignette');
      if (b) {
        b.classList.remove('hidden');
        b.classList.remove('typing');
        b.classList.add('speaking');
      }
      if (vig) vig.classList.add('talk-glow');
      var speed = Config.textSpeed();
      var i = 0;
      (function step() {
        if (gen !== App._typeGen) return;
        if (i >= text.length) {
          if (b) b.classList.remove('speaking');
          if (vig) vig.classList.remove('talk-glow');
          App._pushPage(text);
          App._inputHint(false);
          done && done();
          return;
        }
        span.textContent = text.slice(0, ++i);
        App._scrollLog();
        App._typeTimer = setTimeout(step, speed);
      })();
    },
    /* a long reply scrolls inside the panel (dots switch between messages;
       scrolling reads THIS one when it overflows) — keeps up with the typewriter */
    _scrollLog: function () {
      var b = document.getElementById('log-body');
      if (b) b.scrollTop = b.scrollHeight;
    },

    /* ------------------------------------------------------------ alarms */
    _onAlarm: function (a, clip) {
      App._ringAlarm = a;
      var ov = document.getElementById('overlay-alarm');
      document.getElementById('ring-time').textContent = a.time || '';
      document.getElementById('ring-type').textContent = I18n.t('alarm.type.' + a.type);
      ov.classList.remove('hidden');
      App.showBubble('（' + I18n.t('alarm.type.' + a.type) + '）');
      Avatar.setEmotion('happy', 'agree');
      var gain = (window.Sound && Sound._gain) ? Sound._gain('voice') : 0.9;
      var vol = Math.max(0, Math.min(1, gain * (Number(a.volume) || 1)));
      if (clip) App.playFile(clip, vol);
      if (a.vibrate !== false) App.buzz([30, 60, 30, 60, 30]);
    },

    _dismissAlarm: function () {
      document.getElementById('overlay-alarm').classList.add('hidden');
      if (App.audio) { try { App.audio.pause(); } catch (e) {} }
      Avatar.setTalking(false);
      App._ringAlarm = null;
    },

    _snoozeAlarm: function () {
      if (App._ringAlarm) Alarm.snooze(App._ringAlarm);
      App._dismissAlarm();
      App.toast(I18n.t('alarm.snooze'));
    },

    /* -------------------------------------------------------- modal forms */
    closeModal: function () {
      document.getElementById('modal-scrim').classList.add('hidden');
    },

    openModal: function (opts) {
      opts = opts || {};
      var scrim = document.getElementById('modal-scrim');
      var form = document.getElementById('modal');
      var body = document.getElementById('modal-body');
      document.getElementById('modal-title').textContent = opts.title || '';
      document.getElementById('modal-ok').textContent = opts.okLabel || I18n.t('form.ok');
      document.getElementById('modal-cancel').textContent = I18n.t('form.cancel');
      body.innerHTML = '';
      (opts.build || function () {})(body);
      App.applyI18n(form);
      scrim.classList.remove('hidden');

      var cancel = function () {
        App.closeModal();
        opts.onCancel && opts.onCancel();
      };
      document.getElementById('modal-cancel').onclick = cancel;
      scrim.onclick = function (e) { if (e.target === scrim) cancel(); };
      form.onsubmit = function (e) {
        e.preventDefault();
        if (opts.onOk && opts.onOk(body) === false) return;
        App.closeModal();
      };
    },

    _fieldEl: function (label, innerHtml) {
      var d = document.createElement('div');
      d.className = 'field';
      var lab = document.createElement('label');
      lab.textContent = label;
      d.appendChild(lab);
      var wrap = document.createElement('div');
      wrap.innerHTML = innerHtml;
      while (wrap.firstChild) d.appendChild(wrap.firstChild);
      return d;
    },

    _newAlarm: function () { App._alarmForm(null); },
    _editAlarm: function (id) { App._alarmForm(id); },

    _alarmForm: function (id) {
      var existing = id ? Alarm.get(id) : null;
      var now = new Date();
      var defTime = existing ? existing.time : (
        String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0'));
      var defType = (existing && existing.type) || 'goodMorning';
      var defStyle = (existing && existing.style) || 'normal';
      var defDays = (existing && existing.days) ? existing.days.slice() : [];
      var defSnooze = (existing && existing.snoozeMin != null) ? existing.snoozeMin : 5;
      var defVol = (existing && existing.volume != null) ? existing.volume : 1;
      var defVib = existing ? existing.vibrate !== false : true;
      /* defTime is interpolated into the form's innerHTML — an imported save
         slot could carry Alarm.items with arbitrary strings. Whitelist the
         HH:MM shape before it reaches the DOM. */
      if (!/^\d{1,2}:\d{2}$/.test(defTime)) {
        defTime = String(now.getHours()).padStart(2, '0') + ':' +
                  String(now.getMinutes()).padStart(2, '0');
      }

      App.openModal({
        title: existing ? I18n.t('alarm.edit') : I18n.t('alarm.new'),
        okLabel: I18n.t('form.ok'),
        build: function (body) {
          body.appendChild(App._fieldEl(I18n.t('alarm.time'),
            '<input type="time" id="f-alarm-time" value="' + defTime + '" required>'));

          var typeOpts = Alarm.TYPES.map(function (t) {
            return '<option value="' + t + '"' + (t === defType ? ' selected' : '') + '>' +
                   I18n.t('alarm.type.' + t) + '</option>';
          }).join('');
          body.appendChild(App._fieldEl(I18n.t('alarm.kind'),
            '<select id="f-alarm-type">' + typeOpts + '</select>'));

          var styleOpts = Alarm.STYLES.map(function (s) {
            return '<option value="' + s + '"' + (s === defStyle ? ' selected' : '') + '>' +
                   I18n.t('alarm.style.' + s) + '</option>';
          }).join('');
          body.appendChild(App._fieldEl(I18n.t('alarm.tone'),
            '<select id="f-alarm-style">' + styleOpts + '</select>'));

          var days = document.createElement('div');
          days.className = 'field';
          var lab = document.createElement('label');
          lab.textContent = I18n.t('alarm.days');
          days.appendChild(lab);
          var chips = document.createElement('div');
          chips.className = 'day-chips';
          chips.id = 'f-alarm-days';
          Alarm.WEEK.forEach(function (label, i) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'chip' + (defDays.indexOf(i) >= 0 ? ' on' : '');
            b.setAttribute('data-day', String(i));
            b.textContent = label;
            b.onclick = function () { b.classList.toggle('on'); };
            chips.appendChild(b);
          });
          days.appendChild(chips);
          var hint = document.createElement('div');
          hint.className = 'hint';
          hint.textContent = I18n.t('alarm.everyday') + ' — ' +
            (I18n.lang === 'en' ? 'leave all off' : (I18n.lang === 'ja' ? '未選択で毎日' : '全不选即每天'));
          days.appendChild(hint);
          body.appendChild(days);

          body.appendChild(App._fieldEl(I18n.t('alarm.snooze') + ' (' + I18n.t('alarm.min') + ')',
            '<input type="number" id="f-alarm-snooze" min="1" max="30" value="' + defSnooze + '">'));
          body.appendChild(App._fieldEl(I18n.t('alarm.volume'),
            '<input type="range" id="f-alarm-vol" min="0" max="1" step="0.05" value="' + defVol + '">'));
          var vib = document.createElement('label');
          vib.className = 'switch-row';
          vib.innerHTML = '<span></span><input type="checkbox" id="f-alarm-vib"' +
            (defVib ? ' checked' : '') + '>';
          vib.querySelector('span').textContent = I18n.t('alarm.vibrate');
          body.appendChild(vib);
        },
        onOk: function (body) {
          var time = (body.querySelector('#f-alarm-time').value || '').slice(0, 5);
          if (!/^\d{2}:\d{2}$/.test(time)) { App.toast('请填写时间', true); return false; }
          var type = body.querySelector('#f-alarm-type').value;
          var style = body.querySelector('#f-alarm-style').value;
          var days = [];
          body.querySelectorAll('#f-alarm-days .chip.on').forEach(function (c) {
            days.push(parseInt(c.getAttribute('data-day'), 10));
          });
          var payload = {
            time: time, type: type, style: style, days: days,
            snoozeMin: parseInt(body.querySelector('#f-alarm-snooze').value, 10) || 5,
            volume: parseFloat(body.querySelector('#f-alarm-vol').value) || 1,
            vibrate: !!body.querySelector('#f-alarm-vib').checked
          };
          if (existing) Alarm.update(existing.id, payload);
          else Alarm.add(payload);
          Alarm.render(document.getElementById('alarm-list'), App.playFile);
          App.toast(I18n.t('toast.saved'));
        }
      });
    },

    /* ------------------------------------------------------------ memory */
    remember: function (who, text) {
      App.memory.push({ who: who, text: text, at: Date.now() });
      if (App.memory.length > 400) App.memory = App.memory.slice(-400);
      App.saveMemory();
    },
    saveMemory: function () {
      try { localStorage.setItem(MEM_KEY, JSON.stringify(App.memory)); } catch (e) {}
    },
    renderMemory: function () {
      var root = document.getElementById('memory-list');
      if (!root) return;
      root.innerHTML = '';
      var T = function (k) { return I18n.t(k); };
      if (window.Memory) {
        var bag = Memory.list();
        var pend = Memory.pendingTurns();
        if (pend) {
          var p = document.createElement('div');
          p.className = 'hint';
          p.textContent = I18n.tf('memory.pending', '未总结 {n} 轮', { n: pend });
          root.appendChild(p);
        }
        function section(title, items) {
          if (!items.length) return;
          var h = document.createElement('div');
          h.className = 'mem-layer';
          h.textContent = title;
          root.appendChild(h);
          items.slice().reverse().forEach(function (c) {
            var el = document.createElement('div');
            el.className = 'card';
            el.innerHTML = '<div class="card-sub t-text"></div>' +
              '<div class="card-acts">' +
              '<button type="button" class="mini-btn t-edit"></button>' +
              '<button type="button" class="mini-btn t-del"></button></div>';
            el.querySelector('.t-text').textContent = c.text;
            el.querySelector('.t-edit').textContent = T('memory.edit');
            el.querySelector('.t-del').textContent = T('memory.del');
            el.querySelector('.t-edit').onclick = function () { App._editMemory(c.id); };
            el.querySelector('.t-del').onclick = function () {
              if (!confirm(T('memory.delAsk'))) return;
              Memory.remove(c.id);
              App.renderMemory();
            };
            root.appendChild(el);
          });
        }
        section(T('memory.summaries'), bag.summaries);
        section(T('memory.sessions'), bag.sessions);
      }
      if (App.memory && App.memory.length) {
        var h2 = document.createElement('div');
        h2.className = 'mem-layer';
        h2.textContent = T('memory.log');
        root.appendChild(h2);
        App.memory.slice().reverse().slice(0, 40).forEach(function (m) {
          var el = document.createElement('div');
          el.className = 'card';
          el.innerHTML = '<div class="card-title"><span class="tag' +
            (m.who === 'ryza' ? '' : ' leaf') + ' t-who"></span></div>' +
            '<div class="card-sub t-text"></div>';
          el.querySelector('.t-who').textContent = m.who === 'ryza' ? 'ライザ' : '你';
          el.querySelector('.t-text').textContent = m.text;
          root.appendChild(el);
        });
      }
      if (!root.firstChild) {
        root.innerHTML = '<div class="empty">' + T('memory.empty') + '</div>';
      }
    },

    _editMemory: function (id) {
      var existing = id && window.Memory ? Memory.get(id) : null;
      App.openModal({
        title: existing ? I18n.t('memory.edit') : I18n.t('memory.add'),
        okLabel: I18n.t('form.ok'),
        build: function (body) {
          var ta = document.createElement('textarea');
          ta.id = 'mem-edit-text';
          ta.rows = 6;
          ta.value = existing ? existing.text : '';
          body.appendChild(ta);
          if (!existing) {
            var sel = document.createElement('select');
            sel.id = 'mem-edit-layer';
            [['session', I18n.t('memory.sessions')],
             ['summary', I18n.t('memory.summaries')]].forEach(function (p) {
              var o = document.createElement('option');
              o.value = p[0]; o.textContent = p[1];
              sel.appendChild(o);
            });
            body.appendChild(sel);
          }
        },
        onOk: function (body) {
          var text = (body.querySelector('#mem-edit-text') || {}).value || '';
          if (!window.Memory) return;
          if (existing) Memory.update(existing.id, text);
          else {
            var layer = (body.querySelector('#mem-edit-layer') || {}).value || 'session';
            Memory.add(text, layer);
          }
          App.renderMemory();
        }
      });
    },

    _llmModels: [],
    _qwenModels: [],

    _applyPickedModel: function (id) {
      Config.set('llm.model', id);
      var hit = (App._llmModels || []).filter(function (m) { return m.id === id; })[0];
      if (hit && window.Api && typeof Api.setModelMeta === 'function') Api.setModelMeta(hit);
      if (hit && hit.context && !(Number(Config.section('llm').contextWindow) > 0)) {
        Config.set('llm.contextWindow', hit.context);
        App.buildSettings();
      }
    },

    _fetchModels: function () {
      var llm = Config.section('llm');
      if (!llm.apiKey) { App.toast(I18n.t('toast.needKey'), true); return; }
      if (!llm.baseUrl) { App.toast(I18n.t('toast.needUrl'), true); return; }
      App.toast(I18n.t('toast.modelsWait'));
      Api.listModels().then(function (list) {
        App._llmModels = list || [];
        var hit = App._llmModels.filter(function (m) { return m.id === llm.model; })[0];
        if (hit && hit.context && !(Number(llm.contextWindow) > 0)) {
          Config.set('llm.contextWindow', hit.context);
        }
        App.toast(I18n.tf('toast.modelsOk', '已拉取 {n} 个模型', { n: App._llmModels.length }));
        App.buildSettings();
      }).catch(function (e) {
        App.toast(I18n.t('toast.modelsFail') + (e && e.message ? e.message : ''), true);
      });
    },

    _qwenModelSuggestions: function () {
      var ids = [], seen = {};
      function add(id) {
        id = String(id || '').trim();
        if (!id || seen[id]) return;
        seen[id] = 1;
        ids.push(id);
      }
      (Api.QWEN_TTS_MODELS || []).forEach(add);
      (App._qwenModels || []).forEach(function (m) { add(m && m.id); });
      add((Config.section('tts') || {}).qwenModel);
      return ids;
    },

    _fetchQwenModels: function () {
      var tts = Config.section('tts');
      if (!tts.qwenApiKey) { App.toast(I18n.t('toast.needKey'), true); return; }
      App.toast(I18n.t('toast.modelsWait'));
      Api.listQwenTtsModels().then(function (list) {
        App._qwenModels = list || [];
        App.toast(I18n.tf('toast.modelsOk', '已拉取 {n} 个模型', { n: App._qwenModels.length }));
        App.buildSettings();
      }).catch(function (e) {
        App.toast(I18n.t('toast.modelsFail') + (e && e.message ? e.message : ''), true);
      });
    },

    _fishVoiceSuggestions: function () {
      var ids = [], seen = {};
      function add(id) {
        id = String(id || '').trim();
        if (!id || seen[id]) return;
        seen[id] = 1;
        ids.push(id);
      }
      add(Api.FISH_DEFAULT_VOICE);
      add((Config.section('tts') || {}).fishVoice);
      add((Config.section('tts') || {}).fishVoiceAsmr);
      (App._fishVoices || []).forEach(function (v) { add(v && v.id); });
      return ids;
    },

    _fetchFishVoices: function () {
      var tts = Config.section('tts');
      if (!tts.fishApiKey) { App.toast(I18n.t('toast.needKey'), true); return; }
      App.toast(I18n.t('toast.modelsWait'));
      Api.listFishVoices().then(function (list) {
        App._fishVoices = list || [];
        App.toast(I18n.tf('toast.modelsOk', '已拉取 {n} 个模型', { n: App._fishVoices.length }));
        App.buildSettings();
      }).catch(function (e) {
        App.toast(I18n.t('toast.modelsFail') + (e && e.message ? e.message : ''), true);
      });
    },

    /* ------------------------------------------------------------- skins */
    renderSkins: function () {
      fetch('assets/_index/skins.json').then(function (r) { return r.json(); })
        .then(function (skins) {
          /* 导入的服装不在 skins.json 里，拼在前面（玩家自己加的排最前） */
          var imported = (Avatar.skinsIndex || []).filter(function (x) { return x.imported; });
          if (imported.length) skins = imported.concat(skins);
          var root = document.getElementById('skin-grid');
          var cur = Avatar.outfitOf(Config.section('state').skin);
          var seen = {}, outfits = [];
          skins.forEach(function (s) {
            var oid = Avatar.outfitOf(s.id);
            if (seen[oid]) {
              if (s.hasSpine) seen[oid].hasSpine = true;
              if (!seen[oid].preview && s.preview) seen[oid].preview = s.preview;
              return;
            }
            seen[oid] = { id: oid, hasSpine: !!s.hasSpine, preview: s.preview };
            outfits.push(seen[oid]);
          });
          root.innerHTML = '';
          /* The posture rule used to exist only as a string nobody rendered
             (skin.postureHint) — the player could not tell whether the button
             was missing or the stage simply did not allow it. */
          var hintEl = document.getElementById('skin-posture-hint');
          if (hintEl) {
            hintEl.textContent = I18n.t('skin.postureHint') +
              (window.Avatar && Avatar.postureSwitchable && !Avatar.postureSwitchable()
                ? ' ' + I18n.t('skin.postureOneOnly') : '');
          }
          outfits.forEach(function (s) {
            var el = document.createElement('div');
            var wearable = !!s.hasSpine;
            el.className = 'skin-card' + (s.id === cur ? ' active' : '') + (wearable ? '' : ' locked');
            el.innerHTML = '<img><div class="skin-cap"><span class="t-name"></span>' +
                           '<span class="skin-id"></span></div>';
            var img = el.querySelector('img');
            img.src = s.preview || 'assets/images/chara_placeholder.png';
            img.onerror = function () { img.src = 'assets/images/chara_placeholder.png'; };
            el.querySelector('.t-name').textContent = wearable
              ? I18n.t('skin.wear') : I18n.t('skin.previewOnly');
            el.querySelector('.skin-id').textContent = s.id.replace('crf_skn_002_', '');
            el.onclick = function () {
              if (!wearable) {
                App.toast(I18n.t('skin.previewOnly'), true);
                return;
              }
              Config.set('state.skin', s.id);
              App._switchSkin(s.id);
              App.renderSkins();
            };
            root.appendChild(el);
          });
        });
    },

    _switchSkin: function (id) {
      var veil = document.getElementById('skin-veil');
      veil.classList.add('veil-on');
      if (window.Sound) Sound.se('skin_change');
      setTimeout(function () {
        Avatar.loadSkin(id, function () {
          setTimeout(function () { veil.classList.remove('veil-on'); }, 280);
        });
      }, 160);
    },

    /* -------------------------------------------------------------- forms */
    /* Right-hand button column: hidden/shown by the small ✕ at its head.
       Kept in Config so the choice survives a restart; `silent` skips the
       write when this is only re-applying the stored value at boot. */
    setQuickCollapsed: function (on, silent) {
      document.body.classList.toggle('quick-collapsed', !!on);
      var qt = document.getElementById('btn-quick-toggle');
      if (qt) {
        qt.textContent = on ? '⋯' : '✕';
        qt.title = I18n.t(on ? 'quick.show' : 'quick.hide');
      }
      if (!silent) Config.set('app.quickCollapsed', !!on);
    },

    /* Drag the sprite: pointer capture + a movement threshold, so a tap still
       reaches the part hit-test. Layout px (CSS zoom divided out), forwarded to
       Avatar.panBy which works in world units. */
    _bindDrag: function (el) {
      if (!el) return;
      var drag = { id: null, x: 0, y: 0 };
      el.addEventListener('pointerdown', function (ev) {
        if (App._inTutorial) return;
        drag.id = ev.pointerId; drag.x = ev.clientX; drag.y = ev.clientY;
        /* Consumed by the click that may follow the previous gesture. */
        App._dragMoved = false;
        try { el.setPointerCapture(ev.pointerId); } catch (e) { /* no capture */ }
      });
      el.addEventListener('pointermove', function (ev) {
        if (drag.id !== ev.pointerId) return;
        var z = (window.Avatar && Avatar.cssZoom) ? Avatar.cssZoom(el) : 1;
        var dx = (ev.clientX - drag.x) / z, dy = (ev.clientY - drag.y) / z;
        if (Math.abs(dx) + Math.abs(dy) < 6) return;
        drag.x = ev.clientX; drag.y = ev.clientY;
        App._dragMoved = true;
        if (window.Avatar && Avatar.panBy) Avatar.panBy(dx, dy);
      });
      var end = function (ev) {
        if (drag.id !== ev.pointerId) return;
        drag.id = null;
        /* No reset here: the click that follows this event consumes the flag,
           and the next pointerdown clears whatever is left. A timer would race
           the click and turn a drag release into a poke. */
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    },

    _field: function (wrap, labelKey, value, onInput, opts) {
      opts = opts || {};
      var d = document.createElement('div');
      d.className = 'field';
      var lab = document.createElement('label');
      lab.textContent = labelKey;
      var input = document.createElement(opts.multi ? 'textarea' : 'input');
      if (!opts.multi) input.type = opts.password ? 'password' : (opts.type || 'text');
      input.value = value == null ? '' : value;
      var suggestions = opts.suggestions || [];
      if (opts.list || suggestions.length) {
        var listId = opts.list || ('dl-' + String(labelKey || 'field').replace(/\W+/g, ''));
        input.setAttribute('list', listId);
        var dl = document.createElement('datalist');
        dl.id = listId;
        suggestions.forEach(function (s) {
          if (!s) return;
          var o = document.createElement('option');
          o.value = s;
          dl.appendChild(o);
        });
        d.appendChild(dl);
      }
      input.oninput = function () { onInput(input.value); };
      d.appendChild(lab); d.appendChild(input);
      if (opts.hint) {
        var h = document.createElement('div');
        h.className = 'hint'; h.textContent = opts.hint;
        d.appendChild(h);
      }
      wrap.appendChild(d);
      return d;
    },

    _select: function (wrap, labelKey, value, options, onChange) {
      var d = document.createElement('div');
      d.className = 'field';
      var lab = document.createElement('label');
      lab.textContent = labelKey;
      var sel = document.createElement('select');
      options.forEach(function (o) {
        var op = document.createElement('option');
        op.value = o.v; op.textContent = o.t;
        if (o.v === value) op.selected = true;
        sel.appendChild(op);
      });
      sel.onchange = function () { onChange(sel.value); };
      d.appendChild(lab); d.appendChild(sel);
      wrap.appendChild(d);
      return d;
    },

    _switch: function (wrap, labelKey, value, onChange) {
      var row = document.createElement('div');
      row.className = 'switch-row';
      var span = document.createElement('span');
      span.textContent = labelKey;
      var sw = document.createElement('div');
      sw.className = 'switch' + (value ? ' on' : '');
      sw.onclick = function () {
        var next = !sw.classList.contains('on');
        sw.classList.toggle('on', next);
        onChange(next);
      };
      row.appendChild(span); row.appendChild(sw);
      wrap.appendChild(row);
      return row;
    },

    _range: function (wrap, label, value, onInput) {
      var d = document.createElement('div');
      d.className = 'field';
      var lab = document.createElement('label');
      lab.textContent = label;
      var input = document.createElement('input');
      input.type = 'range';
      input.min = '0'; input.max = '1'; input.step = '0.01';
      input.value = value == null ? 1 : value;
      input.oninput = function () { onInput(parseFloat(input.value)); };
      d.appendChild(lab); d.appendChild(input);
      wrap.appendChild(d);
      return d;
    },

    _title: function (wrap, text) {
      var h = document.createElement('div');
      h.className = 'section-title'; h.textContent = text;
      wrap.appendChild(h);
    },

    /* ------------------------------------------------ settings (settings.js)
       The form assembly lives in its own module now; these are the only names
       other code may call, and they are what scripts/boot_smoke.js drives.
       The generic field primitives above stay here because the alarm form and
       the memory editor use them as well. */
    buildSettings: function () { return Settings.buildSettings(); },
    buildCharaForm: function () { return Settings.buildCharaForm(); },
    _testLlm: function () { return Settings._testLlm(); },
    _testTts: function () { return Settings._testTts(); },
    _renderSlots: function (w) { return Settings._renderSlots(w); }
  };

  global.App = App;
  document.addEventListener('DOMContentLoaded', function () { App.init(); });
})(window);
