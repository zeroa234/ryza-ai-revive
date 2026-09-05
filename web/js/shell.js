/* Frameless-window controls for the desktop (Electron) shell.
   Browser / Android builds never see window.ryzaShell, so nothing shows. */
(function (global) {
  'use strict';
  if (!global.ryzaShell) return;

  function build() {
    var bar = document.getElementById('topbar');
    if (!bar || document.getElementById('winctl')) return;

    var ctl = document.createElement('div');
    ctl.id = 'winctl';
    var mk = function (id, glyph, title) {
      var b = document.createElement('button');
      b.type = 'button';
      b.id = id;
      b.className = 'icon-btn win-btn';
      b.textContent = glyph;
      b.title = title;
      ctl.appendChild(b);
      return b;
    };
    var pin = mk('win-pin', '📌', '窗口置顶');
    var min = mk('win-min', '—', '最小化');
    var cls = mk('win-close', '✕', '关闭');
    var settingsBtn = document.getElementById('btn-settings');
    if (settingsBtn && settingsBtn.parentNode === bar) {
      bar.insertBefore(ctl, settingsBtn.nextSibling);
    } else {
      bar.appendChild(ctl);
    }

    pin.onclick = function () {
      global.ryzaShell.setTopmost(!pin.classList.contains('on')).then(function (on) {
        pin.classList.toggle('on', !!on);
      });
    };
    min.onclick = function () { global.ryzaShell.minimize(); };
    cls.onclick = function () { global.ryzaShell.close(); };
    global.ryzaShell.isTopmost().then(function (on) { pin.classList.toggle('on', !!on); });

    /* Drag the frameless window by the HUD strip; buttons stay clickable. */
    document.body.classList.add('shell-electron');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})(window);
