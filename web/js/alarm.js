/* Alarms: APK layout assets/audio/alarm/<locale>/<normal|whisper>/<type>/<tod>/<n>.m4a
   + sibling .env.json (durationMs, windowMs, envelope[]) for lipsync.
   The clip catalog (VoiceBank) itself lives in audio.js with the rest of
   the sound routing. */
(function (global) {
  'use strict';

  var KEY = 'ryza.alarms.v1';
  var TYPES = ['goodMorning', 'playWithMe', 'task', 'wellDone'];
  var STYLES = ['normal', 'whisper'];
  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  function todForHour(h) {
    if (h < 5) return 'night';
    if (h < 11) return 'morning';
    if (h < 17) return 'daytime';
    if (h < 20) return 'evening';
    return 'night';
  }

  var Alarm = {
    items: [],
    _timer: null,
    _fired: {},

    load: function () {
      try { Alarm.items = JSON.parse(localStorage.getItem(KEY) || '[]'); }
      catch (e) { Alarm.items = []; }
      return Alarm.items;
    },
    save: function () {
      try { localStorage.setItem(KEY, JSON.stringify(Alarm.items)); } catch (e) {}
    },

    add: function (a) {
      a.id = 'a' + Date.now();
      a.enabled = a.enabled !== false;
      if (a.snoozeMin == null) a.snoozeMin = 5;
      if (a.volume == null) a.volume = 1;
      if (a.vibrate == null) a.vibrate = true;
      Alarm.items.push(a);
      Alarm.save();
    },
    remove: function (id) {
      Alarm.items = Alarm.items.filter(function (x) { return x.id !== id; });
      Alarm.save();
    },
    toggle: function (id) {
      Alarm.items.forEach(function (x) { if (x.id === id) x.enabled = !x.enabled; });
      Alarm.save();
    },
    get: function (id) {
      return Alarm.items.filter(function (x) { return x.id === id; })[0] || null;
    },
    update: function (id, patch) {
      Alarm.items.forEach(function (x) {
        if (x.id !== id) return;
        Object.keys(patch).forEach(function (k) { x[k] = patch[k]; });
      });
      Alarm.save();
    },

    start: function (onFire) {
      if (Alarm._timer) clearInterval(Alarm._timer);
      Alarm._timer = setInterval(function () { Alarm._tick(onFire); }, 5000);
      Alarm._tick(onFire);
    },

    _tick: function (onFire) {
      var now = new Date();
      var hhmm = String(now.getHours()).padStart(2, '0') + ':' +
                 String(now.getMinutes()).padStart(2, '0');
      var dow = now.getDay();
      var stamp = now.toDateString() + ' ' + hhmm;
      Alarm.items.forEach(function (a) {
        if (!a.enabled) return;
        var t = a._snoozeUntil || a.time;
        if (t !== hhmm) return;
        if (!a._snoozeUntil && Array.isArray(a.days) && a.days.length &&
            a.days.indexOf(dow) === -1) return;
        if (Alarm._fired[stamp + a.id]) return;
        Alarm._fired[stamp + a.id] = true;
        a._snoozeUntil = null;
        Alarm.save();
        var clip = VoiceBank.pick(a.type, a.style || 'normal', todForHour(now.getHours()));
        onFire && onFire(a, clip);
      });
    },

    snooze: function (a) {
      var min = Math.max(1, parseInt(a.snoozeMin, 10) || 5);
      var d = new Date();
      d.setMinutes(d.getMinutes() + min);
      a._snoozeUntil = String(d.getHours()).padStart(2, '0') + ':' +
                       String(d.getMinutes()).padStart(2, '0');
      Alarm.save();
    },

    loadEnv: function (clip) {
      var p = VoiceBank.envPath(clip);
      if (!p) return Promise.resolve(null);
      return fetch(p).then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    },

    render: function (root, onPlay) {
      root.innerHTML = '';
      if (!Alarm.items.length) {
        root.innerHTML = '<div class="empty">' + I18n.t('alarm.empty') + '</div>';
        return;
      }
      Alarm.items.slice().sort(function (x, y) { return x.time < y.time ? -1 : 1; })
        .forEach(function (a) {
          var el = document.createElement('div');
          el.className = 'card' + (a.enabled ? '' : ' done');
          var days = (a.days && a.days.length)
            ? a.days.slice().sort().map(function (d) { return WEEK[d]; }).join(' ')
            : I18n.t('alarm.everyday');
          el.innerHTML =
            '<div class="card-title"><span class="t-time"></span>' +
            '<span class="tag"></span><span class="tag leaf"></span></div>' +
            '<div class="card-sub"><span class="t-days"></span></div>' +
            '<div class="card-acts">' +
            '<button class="mini-btn t-play"></button>' +
            '<button class="mini-btn t-edit"></button>' +
            '<button class="mini-btn t-toggle"></button>' +
            '<button class="mini-btn t-del"></button></div>';
          el.querySelector('.t-time').textContent = a.time;
          el.querySelector('.t-days').textContent = days +
            (a.snoozeMin ? ' · ' + I18n.t('alarm.snooze') + ' ' + a.snoozeMin + I18n.t('alarm.min') : '');
          el.querySelector('.tag').textContent = I18n.t('alarm.type.' + a.type);
          el.querySelector('.tag.leaf').textContent = I18n.t('alarm.style.' + (a.style || 'normal'));
          el.querySelector('.t-play').textContent = I18n.t('alarm.preview');
          el.querySelector('.t-edit').textContent = I18n.t('form.edit');
          el.querySelector('.t-toggle').textContent = a.enabled ? I18n.t('alarm.on') : I18n.t('alarm.off');
          el.querySelector('.t-del').textContent = I18n.t('alarm.delete');
          el.querySelector('.t-play').onclick = function () {
            var clip = VoiceBank.pick(a.type, a.style || 'normal', todForHour(new Date().getHours()));
            clip && onPlay && onPlay(clip);
          };
          el.querySelector('.t-edit').onclick = function () {
            if (App && App._editAlarm) App._editAlarm(a.id);
          };
          el.querySelector('.t-toggle').onclick = function () {
            Alarm.toggle(a.id); Alarm.render(root, onPlay);
          };
          el.querySelector('.t-del').onclick = function () {
            Alarm.remove(a.id); Alarm.render(root, onPlay);
          };
          root.appendChild(el);
        });
    },

    TYPES: TYPES,
    STYLES: STYLES,
    WEEK: WEEK,
    todForHour: todForHour
  };

  global.Alarm = Alarm;
})(window);
