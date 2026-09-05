/* Title fire / voice-toggle / quest confetti. Timing is taken from the
   shipped Lottie JSON (fr / op); drawing is canvas so we don't vendor a
   Lottie runtime. */
(function (global) {
  'use strict';

  function loadJson(url) {
    return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  function loopDuration(json, fallback) {
    if (!json) return fallback;
    var fr = Number(json.fr) || 30;
    var op = Number(json.op) || 90;
    var ip = Number(json.ip) || 0;
    return Math.max(0.4, (op - ip) / fr);
  }

  var Fx = {
    _voiceOn: true,
    _voiceT: 0,
    _fireT: 0,
    _confetti: [],
    _raf: 0,

    init: function () {
      Promise.all([
        loadJson('assets/animations/voice_toggle.json'),
        loadJson('assets/animations/fire.json'),
        loadJson('assets/animations/celebration_confetti.json')
      ]).then(function (res) {
        Fx._voiceDur = loopDuration(res[0], 3);
        Fx._fireDur = loopDuration(res[1], 2.4);
        Fx._confettiDur = loopDuration(res[2], 2.2);
      });
      Fx._voiceDur = 3;
      Fx._fireDur = 2.4;
      Fx._confettiDur = 2.2;
      if (!Fx._raf) {
        var last = 0;
        (function tick(now) {
          Fx._raf = requestAnimationFrame(tick);
          var dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
          last = now;
          Fx._step(dt);
        })(0);
      }
    },

    setVoice: function (on) { Fx._voiceOn = !!on; },

    burstConfetti: function () {
      var c = document.getElementById('lottie-confetti');
      if (!c) return;
      var r = c.getBoundingClientRect();
      var n = 56, i, ang;
      Fx._confetti = [];
      for (i = 0; i < n; i++) {
        ang = (Math.PI * 2 * i) / n + Math.random() * 0.4;
        Fx._confetti.push({
          x: r.width / 2, y: r.height * 0.42,
          vx: Math.cos(ang) * (180 + Math.random() * 220),
          vy: Math.sin(ang) * (80 + Math.random() * 160) - 220,
          rot: Math.random() * 6, vr: (Math.random() - 0.5) * 10,
          w: 6 + Math.random() * 7, h: 10 + Math.random() * 10,
          life: Fx._confettiDur,
          col: Math.random() > 0.5 ? '#e8b45c' : '#ff8a4c'
        });
      }
    },

    _step: function (dt) {
      Fx._drawVoice(dt);
      Fx._drawFire(dt);
      Fx._drawConfetti(dt);
    },

    _drawVoice: function (dt) {
      var c = document.getElementById('lottie-voice');
      if (!c) return;
      var ctx = c.getContext('2d');
      var w = c.width, h = c.height, cx = w / 2, cy = h / 2;
      Fx._voiceT += dt;
      var t = (Fx._voiceT % Fx._voiceDur) / Fx._voiceDur;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = '#f6ecdf';
      ctx.fillStyle = '#f6ecdf';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(8, cy - 5);
      ctx.lineTo(13, cy - 5);
      ctx.lineTo(18, cy - 10);
      ctx.lineTo(18, cy + 10);
      ctx.lineTo(13, cy + 5);
      ctx.lineTo(8, cy + 5);
      ctx.closePath();
      ctx.fill();
      if (Fx._voiceOn) {
        var pulse = 0.65 + 0.35 * Math.sin(t * Math.PI * 2);
        ctx.beginPath();
        ctx.arc(cx + 2, cy, 7 * pulse, -0.7, 0.7);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx + 2, cy, 11 * pulse, -0.7, 0.7);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(10, 10);
        ctx.lineTo(w - 8, h - 8);
        ctx.strokeStyle = '#ff9a86';
        ctx.stroke();
      }
    },

    _drawFire: function (dt) {
      var c = document.getElementById('lottie-fire');
      if (!c || (c.offsetParent === null && c.style.display === 'none')) {
        /* still draw if overlay is visible */
      }
      if (!c) return;
      var ov = document.getElementById('overlay-title');
      if (ov && ov.classList.contains('hidden')) return;
      var ctx = c.getContext('2d');
      var w = c.width, h = c.height;
      Fx._fireT += dt;
      var t = Fx._fireT;
      ctx.clearRect(0, 0, w, h);
      var i, x, y, s, flicker;
      for (i = 0; i < 14; i++) {
        flicker = Math.sin(t * 8 + i * 1.7) * 0.5 + 0.5;
        x = w / 2 + Math.sin(t * 2.2 + i) * (8 + i);
        y = h * 0.72 - (i * 4 + (t * 28 + i * 11) % 40);
        s = 10 - i * 0.4 + flicker * 3;
        ctx.beginPath();
        ctx.fillStyle = i % 2 ? 'rgba(232,180,92,' + (0.35 + flicker * 0.4) + ')'
                              : 'rgba(255,138,76,' + (0.3 + flicker * 0.45) + ')';
        ctx.ellipse(x, y, s * 0.55, s, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    },

    _drawConfetti: function (dt) {
      var c = document.getElementById('lottie-confetti');
      if (!c) return;
      var host = c.parentElement;
      if (host && host.classList.contains('hidden')) {
        Fx._confetti = [];
        return;
      }
      var w = host.clientWidth || 360, h = host.clientHeight || 640;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      var ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
      var next = [], i, p;
      for (i = 0; i < Fx._confetti.length; i++) {
        p = Fx._confetti[i];
        p.life -= dt;
        if (p.life <= 0) continue;
        p.vy += 520 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, p.life / Fx._confettiDur);
        ctx.fillStyle = p.col;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
        next.push(p);
      }
      Fx._confetti = next;
    }
  };

  global.Fx = Fx;
})(window);
