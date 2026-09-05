# Desktop (Windows) — Electron frameless shell

Thin desktop shell around the static `../web` framework. This package only provides:

- a **borderless window** (`frame:false`) — no title bar, no edges, so the
  phone column reads as one object;
- **always-on-top toggle**, minimize and close buttons (top-right, shown only
  inside Electron — the browser build never sees `window.ryzaShell`);
- serves `web/` as **`ryza://app/`** (privileged custom scheme — not `file://`,
  not a loopback port). `GET/POST /_proxy` is handled on that scheme, same
  contract as `scripts/serve.py` (which stays on 8765 for browser debug only);
- drag-the-window-by-the-HUD (`-webkit-app-region`), single-instance lock.

## Run from source

```powershell
cd desktop
npm install            # first time; scripts/build_desktop.ps1 sets mirror env
npx electron .
```

## Build the installer

```powershell
powershell -File scripts/build_desktop.ps1
```

Output: `output/desktop/RyzaChat-Setup-<version>.exe` (NSIS).
Standard install/uninstall: the installer creates Start-Menu/desktop shortcuts
and an entry in "Apps & features"; uninstalling removes the program but keeps
save data in `%AppData%\RyzaChat\ryza-web-storage.json` (settings, conversations,
quests) — delete that folder to wipe everything, or use Settings →
"抹除全部本地数据" inside the app.

## Privacy notes (what ships)

- `config/providers.json` is **not** part of the package (it lives outside
  `web/` and is gitignored); API keys are entered in Settings and stay in
  the local user profile.
- No analytics, no crash reporting, no official backend calls.

## Dev self-check

`$env:RYZA_SHOT='C:\path\out.png'; npx electron .` captures the window 9 s
after load and exits — used by the screenshot workflow.
