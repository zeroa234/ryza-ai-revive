/* Android keyboard handling.

   The manifest uses windowSoftInputMode=adjustResize so the focused input is
   always pushed above the IME — but that resizes the WebView, and our layout
   (html/body height:100% + #phone fixed top:0/bottom:0 + canvas inset:0) then
   squeezes the whole stage into the strip above the keyboard.

   Fix: keep adjustResize (input stays visible), but when the keyboard opens,
   pin #phone back to the full screen height and anchor it to the bottom. The
   avatar keeps its aspect ratio (the top overflows off-screen) and the input
   bar sits just above the keyboard. When it closes, everything resets.

   Gated to Android only; desktop/browser never fire this. */
(function (global) {
  'use strict';
  var IS_ANDROID = /Android/i.test(navigator.userAgent || '');
  if (!IS_ANDROID) return;

  var lastW = 0, full = 0, phone = null;

  function apply() {
    if (!phone) return;
    var h = window.innerHeight;
    var open = full && h < full - 40;          /* same width, shorter => IME up */
    if (open) {
      /* #phone now fills the viewport (no vh-driven width formula left to
         pin), so only the height has to hold against the IME resize. */
      phone.style.height = full + 'px';
      phone.style.top = 'auto';
      phone.style.bottom = '0';
    } else {
      phone.style.height = '';
      phone.style.top = '';
      phone.style.bottom = '';
    }
  }

  function onResize() {
    var w = window.innerWidth, h = window.innerHeight;
    if (w !== lastW) {          /* rotation / real resize: recalibrate baseline */
      lastW = w; full = h;
    } else if (h >= full) {     /* keyboard closed (or window grew back) */
      full = h;
    }
    apply();
  }

  function init() {
    phone = document.getElementById('phone');
    if (!phone) { setTimeout(init, 200); return; }
    lastW = window.innerWidth;
    full = window.innerHeight;
    global.addEventListener('resize', onResize);
    /* Some WebViews fire visualViewport before resize; catch both. */
    if (global.visualViewport) {
      global.visualViewport.addEventListener('resize', onResize);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else init();
})(window);
