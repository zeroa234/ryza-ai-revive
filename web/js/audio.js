/* Soundscape: current_audio_route + background_bus + se_player.

   Routes (source: features/audio):
     title    — bgm_opening, no ambient
     talk     — location ambient, no BGM
     world    — bgm_world_map + ducked ambient
     prologue — both buses paused (prologue voice is one-shot)

   Browsers block play() until a user gesture. Title used to call play()
   during boot (fails silently); world-map was the first click that succeeded,
   which is why BGM seemed to “only start on the map” and ambient never came
   back. Unlock on first pointer/key, then retry the active route. */
(function (global) {
  'use strict';

  var BGM = {
    opening: 'assets/audio/bgm/bgm_opening.m4a',
    world: 'assets/audio/bgm/bgm_world_map.m4a'
  };

  var SE_FALLBACK = {
    quest_clear: 'assets/audio/se/se_quest_clear.m4a',
    skin_change: 'assets/audio/se/se_skin_change.m4a',
    touch_start: 'assets/audio/se/se_touch_start.m4a'
  };

  function voiceLocale() {
    /* the recorded-voice packs have their own language slot (voice.lang);
       'auto' follows the UI language */
    var lang = (window.Langs && Langs.voice()) ||
               (Config && Config.section('app').lang) || 'ja';
    var map = {
      zh: { alarm: 'zh-tw', tap: 'zh-tw', prologue: 'zh-tw' },
      'zh-tw': { alarm: 'zh-tw', tap: 'zh-tw', prologue: 'zh-tw' },
      en: { alarm: 'en', tap: 'en', prologue: 'en' },
      ja: { alarm: 'ja', tap: 'jp', prologue: 'jp' },
      hi: { alarm: 'hi', tap: 'hi-in', prologue: 'hi-in' },
      id: { alarm: 'id', tap: 'id-id', prologue: 'id-id' },
      'pt-br': { alarm: 'pt-br', tap: 'pt-br', prologue: 'pt-br' }
    };
    return map[lang] || map.ja;
  }

  function makeLoop() {
    var a = new Audio();
    a.loop = true;
    a.preload = 'auto';
    a.crossOrigin = 'anonymous';
    return a;
  }

  function fadeVolume(el, to, ms, done) {
    var from = Number(el.volume) || 0;
    var t0 = performance.now();
    var dur = Math.max(40, ms || 280);
    if (el._fadeRaf) cancelAnimationFrame(el._fadeRaf);
    (function step(now) {
      /* rAF hands out the FRAME START timestamp, which can be earlier than
         the performance.now() taken here — an unclamped u then went slightly
         negative and `el.volume = -0.002` threw IndexSizeError inside the
         loop, killing the fade (ambient stuck silent). */
      var u = Util ? Util.clamp((now - t0) / dur, 0, 1) : Math.min(1, Math.max(0, (now - t0) / dur));
      el.volume = Util ? Util.clamp(Util.lerp(from, to, u), 0, 1)
                       : Math.min(1, Math.max(0, from + (to - from) * u));
      if (u < 1) el._fadeRaf = requestAnimationFrame(step);
      else { el.volume = to; done && done(); }
    })(t0);
  }

  var Sound = {
    bgm: makeLoop(),
    amb: makeLoop(),
    _se: null,
    _tap: null,
    ambientFiles: [],
    tapFiles: [],
    seFiles: [],
    /* Do not store these as `_bgmSrc` / `_ambientSrc`: the latter is a
       function, and writing Sound['_ambientSrc'] = path used to wipe it.
       After that, talk/world ambient never came back; only world BGM (which
       uses a constant URL) still played. */
    _loopSrc: { bgm: '', ambient: '' },
    _sceneKeys: [],
    _route: 'title',
    _stageId: '',
    _tod: 'aft',
    _bgId: '',
    _unlocked: false,
    _bindUnlock: false,

    init: function () {
      Sound._listenUnlock();
      Sound._listenLifecycle();
      return Promise.all([
        fetch('assets/_index/ambient.json').then(function (r) { return r.json(); }),
        fetch('assets/_index/tap_voice.json').then(function (r) { return r.json(); }),
        fetch('assets/_index/se.json').then(function (r) { return r.json(); }).catch(function () { return []; })
      ]).then(function (res) {
        Sound.ambientFiles = res[0] || [];
        Sound.tapFiles = res[1] || [];
        Sound.seFiles = res[2] || [];
        return Sound;
      }).catch(function () { return Sound; });
    },

    /* App passes sorted background ids so this module does not read World. */
    setCatalog: function (sceneKeys) {
      Sound._sceneKeys = (sceneKeys || []).slice().sort();
    },

    setPlace: function (stageId, tod, bgId) {
      Sound._stageId = stageId || Sound._stageId;
      Sound._tod = tod || Sound._tod;
      Sound._bgId = bgId || Sound._bgId;
      if (Sound._route === 'talk' || Sound._route === 'world') Sound._applyRoute();
    },

    /* kind: title | talk | world | prologue */
    setRoute: function (kind) {
      if (!kind) return;
      Sound._route = kind;
      Sound._applyRoute();
    },

    _listenUnlock: function () {
      if (Sound._bindUnlock) return;
      Sound._bindUnlock = true;
      var once = function () {
        document.removeEventListener('pointerdown', once, true);
        document.removeEventListener('keydown', once, true);
        Sound.unlock();
      };
      document.addEventListener('pointerdown', once, true);
      document.addEventListener('keydown', once, true);
    },

    _listenLifecycle: function () {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
          try { Sound.bgm.pause(); } catch (e) {}
          try { Sound.amb.pause(); } catch (e) {}
        } else if (Sound._unlocked) {
          Sound._applyRoute();
        }
      });
    },

    unlock: function () {
      if (Sound._unlocked) {
        Sound._applyRoute();
        return Promise.resolve();
      }
      if (Sound._unlocking) return Sound._unlocking;
      var ping = new Audio(BGM.opening);
      ping.muted = true;
      ping.volume = 0;
      Sound._unlocking = ping.play().then(function () {
        try { ping.pause(); ping.removeAttribute('src'); } catch (e) {}
        Sound._unlocked = true;
        Sound._unlocking = null;
        Sound._applyRoute();
      }).catch(function () {
        Sound._unlocked = true;
        Sound._unlocking = null;
        Sound._applyRoute();
      });
      return Sound._unlocking;
    },

    _gain: function (bus) {
      var app = (Config && Config.section('app')) || {};
      var ch = (Config && Config.section('audio')) || {};
      var master = Number(app.volume != null ? app.volume : 0.9);
      var g = Number(ch[bus] != null ? ch[bus] : 1);
      return Util.clamp(master * g, 0, 1);
    },

    _playLoop: function (el, src, bus, duck) {
      var vol = Sound._gain(bus) * (duck != null ? duck : 1);
      var key = bus === 'bgm' ? 'bgm' : 'ambient';
      if (!src) {
        Sound._loopSrc[key] = '';
        if (!el.paused) fadeVolume(el, 0, 220, function () {
          el.pause();
          el.removeAttribute('src');
        });
        else { el.pause(); el.removeAttribute('src'); }
        return;
      }
      if (Sound._loopSrc[key] === src) {
        if (el.paused && Sound._unlocked) {
          var resume = el.play();
          if (resume && resume.catch) resume.catch(function () {});
        }
        fadeVolume(el, vol, 160);
        return;
      }
      Sound._loopSrc[key] = src;
      el.muted = false;
      el.src = src;
      el.volume = 0;
      if (!Sound._unlocked) return;
      var p = el.play();
      if (p && p.catch) p.catch(function () {});
      fadeVolume(el, vol, 320);
    },

    _ambientSrc: function () {
      var files = Sound.ambientFiles;
      if (!files.length) return '';
      var keys = Sound._sceneKeys;
      var bg = Sound._bgId || Sound._stageId;
      var idx = keys.length ? Math.max(0, keys.indexOf(bg)) : 0;
      if (idx < 0) idx = 0;
      var band = (Sound._tod === 'ngt' || Sound._tod === 'eve') ? 'night' : 'day';
      var n = (idx % 47) + 1;
      var want = 'amb_' + Util.pad3(n) + '_' + band + '.m4a';
      var hit = files.filter(function (p) { return p.indexOf(want) !== -1; })[0];
      if (!hit) {
        want = 'amb_' + Util.pad3(n) + '_day.m4a';
        hit = files.filter(function (p) { return p.indexOf(want) !== -1; })[0];
      }
      if (!hit) hit = files[idx % files.length];
      return hit || '';
    },

    _applyRoute: function () {
      var r = Sound._route;
      if (r === 'title') {
        Sound._playLoop(Sound.bgm, BGM.opening, 'bgm');
        Sound._playLoop(Sound.amb, '', 'ambient');
        return;
      }
      if (r === 'prologue') {
        Sound._playLoop(Sound.bgm, '', 'bgm');
        Sound._playLoop(Sound.amb, '', 'ambient');
        return;
      }
      if (r === 'world') {
        Sound._playLoop(Sound.bgm, BGM.world, 'bgm');
        Sound._playLoop(Sound.amb, Sound._ambientSrc(), 'ambient', 0.35);
        return;
      }
      /* talk and every other in-game screen: location ambient, no BGM. */
      Sound._playLoop(Sound.bgm, '', 'bgm');
      Sound._playLoop(Sound.amb, Sound._ambientSrc(), 'ambient');
    },

    applyVolumes: function () {
      if (Sound._route === 'world') {
        Sound.bgm.volume = Sound._gain('bgm');
        Sound.amb.volume = Sound._gain('ambient') * 0.35;
      } else if (Sound._route === 'title') {
        Sound.bgm.volume = Sound._gain('bgm');
      } else {
        Sound.amb.volume = Sound._gain('ambient');
        Sound.bgm.volume = Sound._gain('bgm');
      }
    },

    se: function (name) {
      var src = SE_FALLBACK[name];
      if (!src && Sound.seFiles.length) {
        src = Sound.seFiles.filter(function (p) {
          return p.indexOf('se_' + name) !== -1 || p.indexOf('/' + name) !== -1;
        })[0];
      }
      if (!src) return;
      try { if (Sound._se) Sound._se.pause(); } catch (e) {}
      Sound._se = new Audio(src);
      Sound._se.volume = Sound._gain('se');
      Sound._se.play().catch(function () {});
    },

    tapVoice: function (overlayId) {
      var loc = voiceLocale().tap;
      var style = (Config.section('state').mode === 'asmr') ? 'asmr' : 'normal';
      var key = (overlayId || '').replace(/_active$/, '').replace(/_idle$/, '');
      if (!key) return;
      var cands = Sound.tapFiles.filter(function (p) {
        return p.indexOf('/' + loc + '/') !== -1 && p.indexOf(key) !== -1 && p.indexOf('_' + style + '_') !== -1;
      });
      if (!cands.length) {
        cands = Sound.tapFiles.filter(function (p) {
          return p.indexOf('/jp/') !== -1 && p.indexOf(key) !== -1;
        });
      }
      if (!cands.length) return;
      var src = cands[Math.floor(Math.random() * cands.length)];
      try { if (Sound._tap) Sound._tap.pause(); } catch (e) {}
      Sound._tap = new Audio(src);
      Sound._tap.volume = Sound._gain('voice');
      Sound._tap.play().catch(function () {});
    },

    prologue: function (n) {
      var loc = voiceLocale().prologue;
      var pad = n < 10 ? '0' + n : String(n);
      return 'assets/audio/prologue/' + loc + '/prologue_' + pad + '.m4a';
    },

    voiceLocale: voiceLocale
  };

  /* Pre-recorded Ryza voice catalog (alarm lines, wellDone clips …) —
     assets/_index/voice_bank.json mirrors <locale>/<style>/<type>/<tod>/. */
  var VoiceBank = {
    index: null,

    load: function () {
      return fetch('assets/_index/voice_bank.json')
        .then(function (r) { return r.json(); })
        .then(function (j) { VoiceBank.index = j; return j; });
    },

    locale: function () { return voiceLocale().alarm; },

    pick: function (type, style, tod) {
      var idx = VoiceBank.index;
      if (!idx) return null;
      var locName = VoiceBank.locale();
      var loc = idx[locName] || idx.ja || idx.en;
      if (!loc) return null;
      var s = loc[style] || loc.normal;
      if (!s) return null;
      var t = s[type] || s.goodMorning;
      if (!t) return null;
      var arr = t[tod] || t.daytime || t[Object.keys(t)[0]];
      if (!arr || !arr.length) return null;
      return arr[Math.floor(Math.random() * arr.length)];
    },

    envPath: function (clip) {
      if (!clip) return null;
      return clip.replace(/\.m4a$/i, '.env.json');
    }
  };

  global.Sound = Sound;
  global.VoiceBank = VoiceBank;
})(window);
