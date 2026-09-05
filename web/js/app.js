/* Main controller: boots straight into the game (no login, no official
   backend), wires the talk loop, the RPG layer (game.js / quests.js /
   daily.js) and the settings/chara forms. This module only orchestrates:
   state lives in Config/Game/Quests/Daily, rendering of the avatar in
   Avatar, sound in Sound, map in World. */
(function (global) {
  'use strict';

  var MEM_KEY = 'ryza.memory.v1';
  var SAVE_KEY = 'ryza.saves.v1';
  var HOME_STAGE = 'stage_01_001_04';       // ライザの家 — the safe place to sleep
  var TEXT_SPEEDS = [
    { v: 30, icon: 'text_speed_1x' },
    { v: 18, icon: 'text_speed_15x' },
    { v: 12, icon: 'text_speed_2x' },
    { v: 8,  icon: 'text_speed_3x' }
  ];
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
       divides it back out via Avatar._cssZoom, and the canvas backing store
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
    _syncPanelFrac: function () {
      if (!window.Avatar || Avatar._panelFrac) return;   // measure once
      var vh = window.innerHeight || 1;
      Avatar._panelFrac = Math.min(0.55, Math.min(340, Math.max(240, 0.34 * vh)) / vh);
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
      I18n.apply(document);
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
        Alarm.load(); Alarm.render(document.getElementById('alarm-list'), App.playFile);
        Alarm.start(App._onAlarm);
        Quests.render(document.getElementById('quest-list'), {});
        Daily.render(document.getElementById('daily-body'));
        App.renderSkins();
        App.buildSettings();
        App.buildCharaForm();
        App.renderMemory();
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
        App.toast('素材索引加载失败：' + e.message, true);
      });
    },

    enterGame: function (fromOnboard) {
      var bar = document.getElementById('input-bar');
      if (bar) bar.classList.remove('spot');
      var st = Config.section('state');
      Sound.setPlace(st.stage, st.tod, World.backgroundFor(st.stage));
      Sound.setRoute('talk');
      App._showDisclosure();
      App._dailyNudge();
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
      if (Daily.available()) {
        /* stagger after the AI-disclosure toast so the two don't stack */
        setTimeout(function () {
          App.toast(I18n.t('dl.title') + ' · ' + I18n.t('dl.cta'));
        }, 3200);
      }
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
        /* Sit/stand is a choice that only exists on stages whose scene lists
           both postures. Walking away resets it to the source default
           (standing), so the next visit to that stage starts on her feet. */
        if (window.Avatar && !Avatar.supportsBothPostures() &&
            Config.section('state').posture !== 'posture_standing') {
          Config.set('state.posture', 'posture_standing');
        }
        App.updateHud();   /* posture chip only shows on dual-posture stages */
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
        return function () { side.classList.remove('open'); fn(); };
      };
      document.getElementById('btn-expand').onclick = function () {
        side.classList.toggle('open');
      };
      document.addEventListener('click', function (e) {
        if (!side.classList.contains('open')) return;
        if (e.target.closest && e.target.closest('#side-menu,#btn-expand')) return;
        side.classList.remove('open');
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
        Welcome.mark('map');
        Sound.setRoute('world');
        App.renderWorld();
      } else {
        Sound.setRoute('talk');
      }
      if (name === 'memory') App.renderMemory();
      if (name === 'skin') { Welcome.mark('skin'); App.renderSkins(); }
      if (name === 'welcome') Welcome.render(document.getElementById('welcome-body'));
      if (name === 'alarm') Welcome.mark('alarm');
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
       posture. Only meaningful on the dual-posture stage. */
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
        var both = window.Avatar && Avatar.supportsBothPostures && Avatar.supportsBothPostures();
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
      World.render(document.getElementById('world-fields'),
                   document.getElementById('world-npcs'),
                   st.stage, App.gotoStage);
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
      document.getElementById('avatar-hit').onclick = function (ev) {
        if (App._inTutorial) { Onboarding.tutorialAdvance(); return; }
        var rect = ev.target.getBoundingClientRect();
        /* rect is in viewport px; layout px need the zoom divided out
           (identity when zoom is 1 — phones/browser). */
        var z = (window.Avatar && Avatar._cssZoom) ? Avatar._cssZoom(ev.target) : 1;
        var x = (ev.clientX - rect.left) / z, y = (ev.clientY - rect.top) / z;
        var part = Avatar.hitPartAt(x, y);
        if (!part) return;   /* miss = no ripple, no SE, no reaction */
        App._ripple(x, y);
        var overlay = Avatar.poke(part);
        App.buzz();
        if (window.Sound) {
          Sound.se('touch_start');
          if (overlay) Sound.tapVoice(overlay);
        }
      };
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
          Welcome.mark('quest');
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
        var name = (Game.ITEMS[it.id] && Game.ITEMS[it.id].name) || it.id;
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
          I18n.apply(document);
          App._relocalize();
          sheet.classList.add('hidden');
        };
        list.appendChild(b);
      });
      sheet.classList.remove('hidden');
    },

    _toggleChara: function () {
      var on = !(Avatar && Avatar._hideChara);
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
      Welcome.mark('talk');

      Api.chat(App.history, text, {
        mode: st.mode, style: st.style,
        rpgContext: App._rpgContext(),
        sceneSection: App._sceneContext(),
        nsfwSection: window.Nsfw ? Nsfw.screenFact() : ''
      })
        .then(function (reply) {
          App.speaking = false;
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
          App.typeBubble(reply.text, function () {
            App.speakThen(reply.text, reply.emotion);
          });

          /* Talk-quests advance once per turn — if the LLM already reported
             quest progress through <state>, don't double-count it here. */
          if (!(reply.state && reply.state.quest)) Quests.progressEvent('talk');
          Quests.render(document.getElementById('quest-list'), {});
        })
        .catch(function (e) {
          App.speaking = false;
          document.getElementById('btn-send').disabled = false;
          var bar = document.getElementById('retry-bar');
          if (bar && e.message !== 'NO_KEY') bar.classList.remove('hidden');
          App.toast(e.message === 'NO_KEY' ? I18n.t('toast.needKey')
                                           : I18n.t('toast.llmFail') + e.message, true);
          App.showBubble('（……うまく聞こえなかった。もう一回言って？）');
        });
    },

    speakThen: function (text, emotion) {
      var st = Config.section('state');
      var app = Config.section('app');
      if (!app.voice || st.style === 'text' || Config.section('tts').mode === 'off') return;
      /* language matrix: display stays in the reply language; when the TTS
         slot asks for a different one, translate first, then synthesize. */
      var replyL = (window.Langs && Langs.llm()) || 'ja';
      var ttsL = (window.Langs && Langs.tts()) || replyL;
      var prep = (ttsL !== replyL && Api.translate)
        ? Api.translate(text, ttsL) : Promise.resolve(text);
      prep.then(function (speakText) {
        /* mode selects the per-mode TTS voice direction (ASMR whisper…) */
        return Api.speak(speakText, ttsL, st.mode);
      }).then(function (url) {
        /* Talking starts when the audio actually exists — before that the
           mouth sat closed (RMS target 0) for the whole TTS latency, and a
           failed synth left _talking stuck true forever. */
        if (!url) return;
        App.playUrl(url, Api.MODE_PLAY_FX[st.mode] || null);
      }).catch(function (e) {
        App.toast(e.message === 'NO_KEY' ? I18n.t('toast.needKey')
              : e.message === 'NO_MODEL' ? I18n.t('toast.needModel')
              : I18n.t('toast.ttsFail') + e.message, true);
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
      a.onended = function () {
        a.playbackRate = 1;
        Avatar.setTalking(false);
        URL.revokeObjectURL(url);
        App._bubbleHold(1600);   /* done talking → bubble steps aside */
      };
      Avatar.setTalking(true);
      App._bubbleKeep();         /* stay put while she talks */
      a.play().catch(function () { Avatar.setTalking(false); });
      App.buzz();
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
      var cur = Number(Config.section('app').textSpeed) || 28;
      var idx = 0;
      TEXT_SPEEDS.forEach(function (o, i) { if (o.v === cur) idx = i; });
      var nxt = TEXT_SPEEDS[(idx + 1) % TEXT_SPEEDS.length];
      Config.set('app.textSpeed', nxt.v);
      App._syncSpeedBtn();
    },
    _syncSpeedBtn: function () {
      var b = document.getElementById('btn-speed');
      if (!b) return;
      var cur = Number(Config.section('app').textSpeed) || 28;
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
      var speed = Number(Config.section('app').textSpeed) || 28;
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
      I18n.apply(form);
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

    buildSettings: function () {
      var w = document.getElementById('settings-form');
      w.innerHTML = '';
      var T = function (k) { return I18n.t(k); };

      App._title(w, T('settings.llm'));
      App._field(w, T('settings.baseUrl'), Config.section('llm').baseUrl,
        function (v) { Config.set('llm.baseUrl', v); },
        { hint: 'OpenAI 兼容地址，以 /v1 结尾；也可放 config/providers.json 自动水合' });
      var models = App._llmModels || [];
      if (models.length) {
        var cur = Config.section('llm').model || '';
        var opts = models.map(function (m) {
          return { v: m.id, t: m.context ? (m.id + ' · ' + m.context) : m.id };
        });
        if (cur && !opts.filter(function (o) { return o.v === cur; }).length) {
          opts.unshift({ v: cur, t: cur });
        }
        App._select(w, T('settings.model'), cur, opts, function (v) {
          App._applyPickedModel(v);
        });
      } else {
        App._field(w, T('settings.model'), Config.section('llm').model,
          function (v) { Config.set('llm.model', v); },
          { hint: T('settings.model.hint') });
      }
      var fetchRow = document.createElement('div');
      fetchRow.className = 'btn-row';
      var bFetch = document.createElement('button');
      bFetch.type = 'button'; bFetch.className = 'btn';
      bFetch.textContent = T('settings.fetchModels');
      bFetch.onclick = function () { App._fetchModels(); };
      fetchRow.appendChild(bFetch);
      w.appendChild(fetchRow);
      App._field(w, T('settings.apiKey'), Config.section('llm').apiKey,
        function (v) { Config.set('llm.apiKey', v); },
        { password: true, hint: T('settings.apiKey.hint') });
      App._field(w, T('settings.temp'), Config.section('llm').temperature,
        function (v) { Config.set('llm.temperature', parseFloat(v) || 0.9); });
      App._field(w, T('settings.maxTokens'), Config.section('llm').maxTokens,
        function (v) { Config.set('llm.maxTokens', Math.max(64, parseInt(v, 10) || 400)); });
      App._field(w, T('settings.historyTurns'), Config.section('llm').historyTurns,
        function (v) { Config.set('llm.historyTurns', Math.max(2, parseInt(v, 10) || 12)); });
      App._field(w, T('settings.context'), Config.section('llm').contextWindow || '',
        function (v) {
          var n = parseInt(v, 10);
          Config.set('llm.contextWindow', n > 0 ? n : 0);
        },
        { hint: T('settings.context.hint') + ' · auto=' + Api.resolvedContext() });
      App._select(w, T('settings.thinking'), Config.section('llm').thinking || 'auto', [
        { v: 'auto', t: T('settings.thinking.auto') },
        { v: 'off', t: T('settings.thinking.off') },
        { v: 'on', t: T('settings.thinking.on') }
      ], function (v) { Config.set('llm.thinking', v); });
      var effort = (window.Api && Api.normalizeEffort)
        ? Api.normalizeEffort(Config.section('llm').thinkingEffort)
        : (Config.section('llm').thinkingEffort || 'default');
      if (effort === 'xhigh') effort = 'max';
      if (['default', 'off', 'low', 'medium', 'high', 'max'].indexOf(effort) === -1) {
        effort = 'default';
      }
      App._select(w, T('settings.thinkingEffort'), effort, [
        { v: 'default', t: T('settings.thinkingEffort.default') },
        { v: 'off', t: T('settings.thinkingEffort.off') },
        { v: 'low', t: T('settings.thinkingEffort.low') },
        { v: 'medium', t: T('settings.thinkingEffort.medium') },
        { v: 'high', t: T('settings.thinkingEffort.high') },
        { v: 'max', t: T('settings.thinkingEffort.max') }
      ], function (v) { Config.set('llm.thinkingEffort', v); });
      App._select(w, T('settings.thinkingStyle'), Config.section('llm').thinkingStyle || 'auto', [
        { v: 'auto', t: T('settings.thinkingStyle.auto') },
        { v: 'none', t: T('settings.thinkingStyle.none') },
        { v: 'openai', t: T('settings.thinkingStyle.openai') },
        { v: 'openrouter', t: T('settings.thinkingStyle.openrouter') },
        { v: 'qwen', t: T('settings.thinkingStyle.qwen') },
        { v: 'glm', t: T('settings.thinkingStyle.glm') }
      ], function (v) { Config.set('llm.thinkingStyle', v); });

      App._title(w, T('settings.memory'));
      var mem = Config.section('memory') || {};
      App._switch(w, T('settings.memoryOn'), mem.enabled !== false,
        function (v) { Config.set('memory.enabled', v); });
      App._field(w, T('settings.turnsPerSession'), mem.turnsPerSession,
        function (v) { Config.set('memory.turnsPerSession', Math.max(2, parseInt(v, 10) || 8)); });
      App._field(w, T('settings.sessionCap'), mem.sessionCap,
        function (v) { Config.set('memory.sessionCap', Math.max(2, parseInt(v, 10) || 8)); });
      App._field(w, T('settings.summaryCap'), mem.summaryCap,
        function (v) { Config.set('memory.summaryCap', Math.max(2, parseInt(v, 10) || 8)); });

      App._title(w, T('settings.tts'));
      App._select(w, T('settings.tts.provider'), Config.section('tts').provider || 'openai', [
        { v: 'openai', t: T('settings.tts.provider.openai') },
        { v: 'qwen', t: T('settings.tts.provider.qwen') },
        { v: 'fish', t: T('settings.tts.provider.fish') }
      ], function (v) {
        Config.set('tts.provider', v);
        if (v === 'fish' && Config.section('tts').mode === 'clone') {
          Config.set('tts.mode', 'preset');
        }
        App.buildSettings();
      });

      if ((Config.section('tts').provider || 'openai') === 'qwen') {
        App._field(w, T('settings.baseUrl'), Config.section('tts').qwenBaseUrl,
          function (v) { Config.set('tts.qwenBaseUrl', v); },
          { hint: T('settings.qwenBaseHint') });
        App._field(w, T('settings.apiKey'), Config.section('tts').qwenApiKey,
          function (v) { Config.set('tts.qwenApiKey', v); }, { password: true });
        App._field(w, T('settings.qwenModel'), Config.section('tts').qwenModel,
          function (v) { Config.set('tts.qwenModel', v); },
          { hint: T('settings.qwenModel.hint'), suggestions: App._qwenModelSuggestions(), list: 'qwen-model-list' });
        var qFetch = document.createElement('div');
        qFetch.className = 'btn-row';
        var bQFetch = document.createElement('button');
        bQFetch.type = 'button'; bQFetch.className = 'btn';
        bQFetch.textContent = T('settings.fetchModels');
        bQFetch.onclick = function () { App._fetchQwenModels(); };
        qFetch.appendChild(bQFetch);
        w.appendChild(qFetch);
        App._field(w, T('settings.qwenVoice'), Config.section('tts').qwenVoice,
          function (v) { Config.set('tts.qwenVoice', v); },
          { hint: T('settings.qwenVoice.hint'), suggestions: Api.QWEN_TTS_VOICES || [], list: 'qwen-voice-list' });
        App._field(w, T('settings.qwenCloneTarget'), Config.section('tts').qwenCloneTarget,
          function (v) { Config.set('tts.qwenCloneTarget', v); },
          { hint: T('settings.qwenCloneTarget.hint') });
        var crow = document.createElement('div');
        crow.className = 'btn-row';
        var clone = document.createElement('button');
        clone.type = 'button'; clone.className = 'btn';
        clone.textContent = T('settings.cloneQwen');
        clone.onclick = function () {
          App.toast(T('toast.cloning'));
          Api.qwenCloneVoice().then(function (vid) {
            Config.set('tts.qwenVoice', vid);
            Config.set('tts.qwenModel', Config.section('tts').qwenCloneTarget || 'qwen3-tts-vc-2026-01-22');
            App.toast(T('toast.cloneOk'));
            App.buildSettings();
          }).catch(function (e) {
            App.toast(T('toast.cloneFail') + e.message, true);
          });
        };
        crow.appendChild(clone);
        w.appendChild(crow);
        App._select(w, T('settings.ttsMode'), Config.section('tts').mode === 'off' ? 'off' : 'clone', [
          { v: 'clone', t: T('settings.ttsMode.clone') },
          { v: 'off', t: T('settings.ttsMode.off') }
        ], function (v) { Config.set('tts.mode', v); App.buildSettings(); });
      } else if (Config.section('tts').provider === 'fish') {
        App._field(w, T('settings.baseUrl'), Config.section('tts').fishBaseUrl,
          function (v) { Config.set('tts.fishBaseUrl', v); },
          { hint: T('settings.fishBaseHint') });
        App._field(w, T('settings.apiKey'), Config.section('tts').fishApiKey,
          function (v) { Config.set('tts.fishApiKey', v); }, { password: true });
        App._field(w, T('settings.fishModel'), Config.section('tts').fishModel,
          function (v) { Config.set('tts.fishModel', v); },
          { hint: T('settings.fishModel.hint'),
            suggestions: Api.FISH_TTS_MODELS || [], list: 'fish-model-list' });
        App._field(w, T('settings.fishVoice'), Config.section('tts').fishVoice,
          function (v) { Config.set('tts.fishVoice', v); },
          { hint: T('settings.fishVoice.hint'),
            suggestions: App._fishVoiceSuggestions(), list: 'fish-voice-list' });
        var fFetch = document.createElement('div');
        fFetch.className = 'btn-row';
        var bFFetch = document.createElement('button');
        bFFetch.type = 'button'; bFFetch.className = 'btn';
        bFFetch.textContent = T('settings.fetchVoices');
        bFFetch.onclick = function () { App._fetchFishVoices(); };
        fFetch.appendChild(bFFetch);
        w.appendChild(fFetch);
        var frow = document.createElement('div');
        frow.className = 'btn-row';
        var fclone = document.createElement('button');
        fclone.type = 'button'; fclone.className = 'btn';
        fclone.textContent = T('settings.cloneFish');
        fclone.onclick = function () {
          App.toast(T('toast.cloningFish'));
          Api.fishCloneVoice().then(function (vid) {
            Config.set('tts.fishVoice', vid);
            App.toast(T('toast.cloneOk'));
            App.buildSettings();
          }).catch(function (e) {
            App.toast(T('toast.cloneFail') + e.message, true);
          });
        };
        frow.appendChild(fclone);
        w.appendChild(frow);
        App._field(w, T('settings.styleHint'), Config.section('tts').styleHint,
          function (v) { Config.set('tts.styleHint', v); },
          { hint: T('settings.styleHint.hint') });
        App._select(w, T('settings.ttsMode'), Config.section('tts').mode === 'off' ? 'off' : 'preset', [
          { v: 'preset', t: T('settings.ttsMode.preset') },
          { v: 'off', t: T('settings.ttsMode.off') }
        ], function (v) { Config.set('tts.mode', v); App.buildSettings(); });
      } else {
      App._field(w, T('settings.baseUrl'), Config.section('tts').baseUrl,
        function (v) { Config.set('tts.baseUrl', v); });
      App._field(w, T('settings.apiKey'), Config.section('tts').apiKey,
        function (v) { Config.set('tts.apiKey', v); },
        { password: true });
      App._select(w, T('settings.ttsMode'), Config.section('tts').mode, [
        { v: 'clone', t: T('settings.ttsMode.clone') },
        { v: 'preset', t: T('settings.ttsMode.preset') },
        { v: 'off', t: T('settings.ttsMode.off') }
      ], function (v) { Config.set('tts.mode', v); App.buildSettings(); });
      if (Config.section('tts').mode === 'clone') {
        App._field(w, T('settings.model'), Config.section('tts').modelClone,
          function (v) { Config.set('tts.modelClone', v); },
          { hint: '克隆通道使用的模型 id（服务端提供，如 MiMo 的声音克隆模型）' });
        App._field(w, T('settings.refAudio'), Config.section('tts').reference,
          function (v) { Config.set('tts.reference', v); },
          { hint: '必须是 wav 或 mp3；APK 里的原声是 m4a，需先转码' });
      } else if (Config.section('tts').mode === 'preset') {
        App._field(w, T('settings.model'), Config.section('tts').modelPreset,
          function (v) { Config.set('tts.modelPreset', v); },
          { hint: '预设音色通道使用的模型 id（服务端提供）' });
        App._field(w, T('settings.presetVoice'), Config.section('tts').presetVoice,
          function (v) { Config.set('tts.presetVoice', v); });
      }
      App._field(w, T('settings.styleHint'), Config.section('tts').styleHint,
        function (v) { Config.set('tts.styleHint', v); },
        { hint: T('settings.styleHint.hint') });
      }

      /* ---------------- language matrix: UI / recorded voice / reply / TTS */
      App._title(w, T('nav.lang'));
      var langOpts = Langs.ALL.map(function (o) { return { v: o.v, t: T(o.k) }; });
      App._select(w, T('settings.lang.ui'), Config.section('app').lang, langOpts,
        function (v) {
          Config.set('app.lang', v); I18n.setLang(v); I18n.apply(document);
          App._relocalize();
        });
      App._select(w, T('settings.lang.voice'), (Config.section('voice') || {}).lang || 'auto', langOpts,
        function (v) { Config.set('voice.lang', v); });
      App._select(w, T('settings.lang.llm'), (Config.section('llm') || {}).lang || 'auto', langOpts,
        function (v) { Config.set('llm.lang', v); });
      App._select(w, T('settings.lang.tts'), (Config.section('tts') || {}).lang || 'auto', langOpts,
        function (v) { Config.set('tts.lang', v); });
      var lh = document.createElement('div');
      lh.className = 'hint'; lh.textContent = T('settings.lang.ttsHint');
      w.appendChild(lh);

      App._title(w, T('settings.app'));
      App._range(w, T('settings.volume'), Config.section('app').volume,
        function (v) {
          Config.set('app.volume', v);
          if (window.Sound) Sound.applyVolumes();
        });
      App._range(w, T('vol.bgm'), (Config.section('audio') || {}).bgm, function (v) {
        Config.set('audio.bgm', v); if (window.Sound) Sound.applyVolumes();
      });
      App._range(w, T('vol.ambient'), (Config.section('audio') || {}).ambient, function (v) {
        Config.set('audio.ambient', v); if (window.Sound) Sound.applyVolumes();
      });
      App._range(w, T('vol.voice'), (Config.section('audio') || {}).voice, function (v) {
        Config.set('audio.voice', v);
      });
      App._range(w, T('vol.se'), (Config.section('audio') || {}).se, function (v) {
        Config.set('audio.se', v);
      });
      /* talk speed: the official sheet is icon pills, not a raw ms input. */
      var sp = document.createElement('div');
      sp.className = 'field';
      var spl = document.createElement('label');
      spl.textContent = T('settings.speed');
      sp.appendChild(spl);
      var seg = document.createElement('div');
      seg.className = 'speed-seg';
      TEXT_SPEEDS.forEach(function (o) {
        var b = document.createElement('button');
        b.type = 'button';
        var cur = Number(Config.section('app').textSpeed) || 28;
        b.className = Math.abs(cur - o.v) < 3 ? 'on' : '';
        b.innerHTML = '<img alt="" src="assets/icons/' + o.icon + '.svg">';
        b.onclick = function () {
          Config.set('app.textSpeed', o.v);
          App.buildSettings();
        };
        seg.appendChild(b);
      });
      sp.appendChild(seg);
      w.appendChild(sp);
      App._switch(w, T('settings.voice'), Config.section('app').voice,
        function (v) { Config.set('app.voice', v); if (App._syncVoicePill) App._syncVoicePill(); });
      App._switch(w, T('settings.bubble'), Config.section('app').showBubble !== false,
        function (v) { Config.set('app.showBubble', v); });
      App._switch(w, T('settings.vibration'), Config.section('app').vibration,
        function (v) { Config.set('app.vibration', v); });
      App._switch(w, T('settings.rim'), Config.section('app').rim !== false,
        function (v) { Config.set('app.rim', v); });

      /* ---------------- time passage (official drove it from AppServerClock) */
      App._title(w, T('settings.time'));
      App._select(w, T('settings.timeMode'), Config.section('app').timeMode || 'real', [
        { v: 'real',   t: T('time.real') },
        { v: 'flow',   t: T('time.flow') },
        { v: 'manual', t: T('time.manual') }
      ], function (v) {
        Config.set('app.timeMode', v);
        if (v === 'flow') {
          Config.set('state.gameHour', new Date().getHours());
          Config.set('state.gameClockAt', Date.now());
          Config.set('state.todManualUntil', 0);
        }
        App.buildSettings();
        App._tickTime();
      });
      if ((Config.section('app').timeMode) === 'flow') {
        App._select(w, T('settings.flowSpeed'), String(Config.section('app').flowSpeed || 60), [
          { v: '15',  t: T('speed.slow') },
          { v: '60',  t: T('speed.mid') },
          { v: '180', t: T('speed.fast') },
          { v: '360', t: T('speed.vfast') }
        ], function (v) {
          Config.set('app.flowSpeed', Number(v));
          App._tickTime();
        });
      }

      /* ---------------- game balance / cheat (user-side replacement for
         the official paywall: limits stay, but can be switched off freely) */
      App._title(w, T('settings.cheat'));
      var cheatHint = document.createElement('div');
      cheatHint.className = 'hint';
      cheatHint.textContent = T('cheat.desc');
      w.appendChild(cheatHint);
      App._switch(w, T('cheat.title') + (Config.section('app').cheat ? ' 🍎∞' : ''),
        Config.section('app').cheat,
        function (v) {
          Config.set('app.cheat', v);
          App.toast(v ? T('cheat.on') : T('cheat.off'));
          App.refreshHud();
          App.buildSettings();
        });
      var g = document.createElement('div');
      g.className = 'hint';
      g.textContent = T('stamina.faintMsg');
      w.appendChild(g);

      App._title(w, T('settings.data'));
      var row = document.createElement('div');
      row.className = 'btn-row';
      var bTest = document.createElement('button');
      bTest.className = 'btn'; bTest.textContent = T('settings.testLlm');
      bTest.onclick = function () { App._testLlm(); };
      var bTts = document.createElement('button');
      bTts.className = 'btn'; bTts.textContent = T('settings.testTts');
      bTts.onclick = function () { App._testTts(); };
      row.appendChild(bTest); row.appendChild(bTts);
      w.appendChild(row);

      var row2 = document.createElement('div');
      row2.className = 'btn-row';
      var bExp = document.createElement('button');
      bExp.className = 'btn'; bExp.textContent = T('settings.export');
      bExp.onclick = function () {
        var txt = Config.exportJSON();
        if (navigator.clipboard) navigator.clipboard.writeText(txt);
        App.toast(I18n.t('toast.copied'));
        console.log(txt);
      };
      var bImp = document.createElement('button');
      bImp.className = 'btn'; bImp.textContent = T('settings.import');
      bImp.onclick = function () {
        var txt = prompt('粘贴配置 JSON');
        if (!txt) return;
        try { Config.importJSON(txt); App.buildSettings(); App.buildCharaForm();
              App.toast(I18n.t('toast.saved')); }
        catch (e) { App.toast('配置解析失败：' + e.message, true); }
      };
      row2.appendChild(bExp); row2.appendChild(bImp);
      w.appendChild(row2);

      /* local_save_data_eraser.dart equivalent. */
      var bErase = document.createElement('button');
      bErase.className = 'btn danger'; bErase.textContent = T('settings.erase');
      bErase.onclick = function () {
        App.openModal({
          title: T('settings.erase'),
          okLabel: T('settings.eraseOk'),
          build: function (body) {
            var p = document.createElement('p');
            p.className = 'onb-sub';
            p.textContent = T('settings.eraseMsg');
            body.appendChild(p);
          },
          onOk: function () {
            Config.eraseAll();
            location.reload();
          }
        });
      };
      var row3 = document.createElement('div');
      row3.className = 'btn-row';
      row3.appendChild(bErase);
      w.appendChild(row3);
    },

    _testLlm: function () {
      var llm = Config.section('llm');
      if (!llm.apiKey) { App.toast(I18n.t('toast.needKey'), true); return; }
      App.toast('测试中…');
      Api.chat([], '短く一言、あいさつして。', { mode: 'chat', style: 'text' })
        .then(function (r) { App.toast('OK：' + r.text); })
        .catch(function (e) { App.toast('失败：' + e.message, true); });
    },

    _testTts: function () {
      var tts = Config.section('tts');
      var key = tts.provider === 'qwen' ? tts.qwenApiKey
              : tts.provider === 'fish' ? tts.fishApiKey
              : tts.apiKey;
      if (!key) { App.toast(I18n.t('toast.needKey'), true); return; }
      var model = tts.provider === 'qwen' ? (tts.qwenModel || 'qwen3-tts-flash')
                : tts.provider === 'fish' ? (tts.fishModel || 'fishaudio-s21pro-flash')
                : (tts.mode === 'clone' ? tts.modelClone : tts.modelPreset);
      if (tts.provider !== 'fish' && Api.isPlaceholderModel(model)) {
        App.toast(I18n.t('toast.needModel'), true); return;
      }
      App.toast('合成中…');
      /* no explicit mode → Api.speak uses the live talk mode, so this
         doubles as a preview of the per-mode voice direction. */
      Api.speak('やあ、聞こえてる？').then(function (url) {
        if (!url) { App.toast('语音已关闭'); return; }
        App.playUrl(url);
        App.toast('OK');
      }).catch(function (e) { App.toast('失败：' + e.message, true); });
    },

    buildCharaForm: function () {
      var w = document.getElementById('chara-form');
      w.innerHTML = '';
      var T = function (k) { return I18n.t(k); };
      var c = Config.section('chara'), p = Config.section('profile');

      App._title(w, 'ライザ（キャラ設定）');
      App._field(w, T('chara.personality'), c.personality,
        function (v) { Config.set('chara.personality', v); });
      App._field(w, T('chara.likes'), c.likes,
        function (v) { Config.set('chara.likes', v); });
      App._field(w, T('chara.dislikes'), c.dislikes,
        function (v) { Config.set('chara.dislikes', v); });
      App._field(w, T('chara.situation'), c.situation,
        function (v) { Config.set('chara.situation', v); });
      App._field(w, T('chara.callMe'), c.callMe,
        function (v) { Config.set('chara.callMe', v); });
      App._field(w, T('chara.extra'), c.extra,
        function (v) { Config.set('chara.extra', v); }, { multi: true });

      App._title(w, 'あなた（プレイヤー設定）');
      App._field(w, T('onb.name'), p.name,
        function (v) { Config.set('profile.name', v); });
      App._field(w, T('onb.birthday'), p.birthday,
        function (v) { Config.set('profile.birthday', v); }, { type: 'date' });
      App._select(w, T('onb.gender'), p.gender || '', [
        { v: '', t: '—' },
        { v: 'female', t: T('onb.gender.female') },
        { v: 'male', t: T('onb.gender.male') },
        { v: 'other', t: T('onb.gender.other') }
      ], function (v) { Config.set('profile.gender', v); });
      App._field(w, T('profile.appearance'), p.appearance,
        function (v) { Config.set('profile.appearance', v); });
      App._field(w, T('profile.background'), p.background,
        function (v) { Config.set('profile.background', v); });
      App._field(w, T('profile.hobby'), p.hobby,
        function (v) { Config.set('profile.hobby', v); });
      App._field(w, T('profile.interest'), p.interest,
        function (v) { Config.set('profile.interest', v); });
      App._field(w, T('profile.futureGoals'), p.futureGoals,
        function (v) { Config.set('profile.futureGoals', v); });
      App._field(w, T('profile.personality'), p.personality,
        function (v) { Config.set('profile.personality', v); });

      App._title(w, T('slot.title'));
      App._renderSlots(w);

      var row = document.createElement('div');
      row.className = 'btn-row';
      var b = document.createElement('button');
      b.className = 'btn primary'; b.textContent = '保存并回到对话';
      b.onclick = function () { App.toast(I18n.t('toast.saved')); App.showView('talk'); };
      row.appendChild(b);
      var b2 = document.createElement('button');
      b2.className = 'btn danger'; b2.textContent = '清空对话记忆';
      b2.onclick = function () {
        if (confirm('清空当前对话历史？')) { App.history = []; App.toast('已清空'); }
      };
      row.appendChild(b2);
      w.appendChild(row);
    },

    /* -------------------------------------------------------- save slots */
    _loadSlots: function () {
      var slots;
      try { slots = JSON.parse(localStorage.getItem(SAVE_KEY) || '[]'); }
      catch (e) { slots = []; }
      while (slots.length < 3) slots.push(null);
      return slots.slice(0, 3);
    },

    _writeSlots: function (slots) {
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(slots)); } catch (e) {}
    },

    _snapshot: function () {
      var st = Config.section('state');
      var place = World.find(st.stage);
      return {
        at: Date.now(),
        day: st.day,
        label: place ? (place.area + ' / ' + place.stage) : st.stage,
        settings: JSON.parse(Config.exportJSON()),
        history: App.history,
        memory: App.memory,
        longmem: window.Memory ? Memory.snapshot() : null,
        game: Game.snapshot(),
        daily: JSON.parse(localStorage.getItem('ryza.daily.v1') || 'null'),
        alarms: Alarm.items
      };
    },

    _applySnapshot: function (snap) {
      if (!snap || !snap.settings) return;
      Config.importJSON(JSON.stringify(snap.settings));
      App.history = snap.history || [];
      App.memory = snap.memory || [];
      App.saveMemory();
      if (window.Memory) Memory.restore(snap.longmem);
      Game.restoreSnapshot(snap.game);
      try { localStorage.setItem('ryza.daily.v1', JSON.stringify(snap.daily || { lastDate: '', streak: 0, claimedDays: [] })); } catch (e) {}
      Daily.load();
      Quests.ensure();
      Alarm.items = snap.alarms || [];
      Alarm.save();
      var st = Config.section('state');
      Avatar.loadSkin(st.skin);
      App._loadSceneFor(st.stage, st.tod);
      if (window.Sound) {
        Sound.setPlace(st.stage, st.tod, World.backgroundFor(st.stage));
        Sound.setRoute('talk');
      }
      App.updateHud();
      App.renderWorld();
      Alarm.render(document.getElementById('alarm-list'), App.playFile);
      Quests.render(document.getElementById('quest-list'), {});
      Daily.render(document.getElementById('daily-body'));
      App.renderMemory();
      App.buildSettings();
      App.buildCharaForm();
      App.renderSkins();
      I18n.setLang(Config.section('app').lang);
      I18n.apply(document);
    },

    _renderSlots: function (wrap) {
      var slots = App._loadSlots();
      slots.forEach(function (s, i) {
        var row = document.createElement('div');
        row.className = 'slot-row';
        var info = document.createElement('div');
        info.className = 'slot-info';
        if (s) {
          var d = new Date(s.at);
          info.textContent = (i + 1) + '. ' + (s.label || '') +
            ' · day ' + (s.day || 1) + ' · ' +
            'Lv' + (s.game ? 1 + Math.floor(Math.sqrt((s.game.exp_total || 0) / 30)) : '?') + ' · ' +
            d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
        } else {
          info.textContent = (i + 1) + '. ' + I18n.t('slot.empty');
        }
        var save = document.createElement('button');
        save.type = 'button';
        save.className = 'mini-btn';
        save.textContent = I18n.t('slot.save');
        save.onclick = function () {
          var all = App._loadSlots();
          all[i] = App._snapshot();
          App._writeSlots(all);
          App.buildCharaForm();
          App.toast(I18n.t('toast.saved'));
        };
        var load = document.createElement('button');
        load.type = 'button';
        load.className = 'mini-btn';
        load.textContent = I18n.t('slot.load');
        load.disabled = !s;
        load.onclick = function () {
          var all = App._loadSlots();
          if (!all[i]) return;
          App._applySnapshot(all[i]);
          App.toast(I18n.t('slot.load'));
          App.showView('talk');
        };
        row.appendChild(info);
        row.appendChild(save);
        row.appendChild(load);
        wrap.appendChild(row);
      });
    }
  };

  global.App = App;
  document.addEventListener('DOMContentLoaded', function () { App.init(); });
})(window);
