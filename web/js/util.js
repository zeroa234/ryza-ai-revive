/* Shared helpers. Keep this free of App/Avatar/World so feature modules
   don't import each other for clamp / weighted pick. */
(function (global) {
  'use strict';

  var Util = {
    clamp: function (v, lo, hi) {
      v = Number(v);
      if (v !== v) v = lo;
      if (v < lo) return lo;
      if (v > hi) return hi;
      return v;
    },

    lerp: function (a, b, t) {
      return a + (b - a) * t;
    },

    pad3: function (n) {
      n = Math.floor(Number(n) || 0);
      if (n < 10) return '00' + n;
      if (n < 100) return '0' + n;
      return String(n);
    },

    /* Skeleton .skel hashes are two *signed* 32-bit halves concatenated
       without a separator ("-2a81ab33" + "-1db7ab26" =
       "-2a81ab33-1db7ab26"); the gesture MixDurationPoses.sourceHash is the
       same value in unsigned hex ("d57e54cde24854da"). Convert each negative
       half (2^32 − v) so the two actually compare. */
    hashHex: function (h) {
      var s = String(h == null ? '' : h).trim().toLowerCase();
      if (!s) return '';
      var m = /^(-?)([0-9a-f]{8})(-?)([0-9a-f]{8})$/.exec(s);
      if (m) {
        var va = parseInt(m[2], 16), vb = parseInt(m[4], 16);
        if (m[1] === '-') va = (0x100000000 - va) >>> 0;
        if (m[3] === '-') vb = (0x100000000 - vb) >>> 0;
        return ('00000000' + va.toString(16)).slice(-8) +
               ('00000000' + vb.toString(16)).slice(-8);
      }
      s = s.replace(/[^0-9a-f]/g, '');
      if (!s) return '';
      while (s.length < 16) s = '0' + s;
      return s.slice(-16);
    },

    swapHashHalves: function (h) {
      h = Util.hashHex(h);
      if (h.length < 16) return h;
      return h.slice(8) + h.slice(0, 8);
    },

    weighted: function (items, weightOf) {
      var sum = 0, i, r, w;
      if (!items || !items.length) return null;
      for (i = 0; i < items.length; i++) {
        w = weightOf ? weightOf(items[i]) : (Number(items[i].weight) || 0);
        sum += w > 0 ? w : 0;
      }
      if (!(sum > 0)) return items[Math.floor(Math.random() * items.length)];
      r = Math.random() * sum;
      for (i = 0; i < items.length; i++) {
        w = weightOf ? weightOf(items[i]) : (Number(items[i].weight) || 0);
        r -= w > 0 ? w : 0;
        if (r <= 0) return items[i];
      }
      return items[items.length - 1];
    }
  };

  global.Util = Util;
})(window);
