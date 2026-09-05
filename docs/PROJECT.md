# Ryza Chat — public architecture

From-scratch **offline companion framework**: static HTML/JS kernel, Electron desktop shell, Android WebView shell. LLM and TTS are bring-your-own (OpenAI-compatible). This document describes the **source tree**. Binary media is not in git.

离线陪伴框架的公开架构说明。git 只含源码与结构表；贴图 / 音频 / `.skel` 在本地恢复。

Version source of truth: `config/version.json` (currently **1.2.15**). Maintainer-only notes stay on the author’s machine and are not part of this file.

---

## 1. Layout

```
web/                    # static app (no bundler)
  index.html
  css/ app.css
  js/                   # see §2
  vendor/spine-webgl.js # Spine 4.2 runtime
  assets/               # JSON/atlas/SVG in git; raster/audio/skel local
desktop/                # Electron frameless window + ryza://app + /_proxy
android/                # WebView + AssetServer (127.0.0.1 + /_proxy)
scripts/
  serve.py              # static + CORS proxy for browser debug
  build_indexes.py      # scan assets → web/assets/_index/*.json
  motion_regression.js
  game_logic_regression.js
  expression_coverage.js
  memory_regression.js
  privacy_check.py      # packaging gate; non-zero exits abort the build
  stamp_version.js      # version.json → package.json + Gradle
  boot_smoke.js
  build_desktop.ps1
  build_apk.ps1
  setup_android_tools.ps1
  restore_media.py      # copy media into web/assets/ from a local package
config/version.json
config/providers.example.json   # copy to providers.json locally; gitignored
docs/                   # this file + CONTRIBUTING/SECURITY at repo root
```

**Why a web kernel:** the same HTML/JS runs in the browser, the desktop shell, and Android WebView.

```powershell
python scripts/serve.py
# http://127.0.0.1:8765/
```

Do not use `python -m http.server` (no `/_proxy` → CORS failures).

Desktop: `cd desktop && npm install && npx electron .`  
Installer: `powershell -File scripts/build_desktop.ps1`  
APK: `powershell -File scripts/setup_android_tools.ps1` then `scripts/build_apk.ps1`

---

## 2. Modules (web/js)

| File | Role |
|---|---|
| `app.js` | Orchestration only (init, talk, sheets, HUD). Does not own RPG numbers. |
| `api.js` | LLM/TTS transport, tagged replies, `/_proxy`, provider-separated TTS fields |
| `config.js` | Settings + localStorage; hydrates empty keys from local `providers.json` in dev |
| `avatar.js` | Spine WebGL portrait + scene camera, sit/stand, tap hit-testing |
| `game.js` | RPG reducer (`applyDelta` is the only write path) |
| `quests.js` | Quest lifecycle + offline action tables |
| `daily.js` | Daily login rewards via `Game` |
| `memory.js` | Two-layer session memory cards (not mixed with adventure `Game.s.memory`) |
| `world.js` | Map hierarchy, NPC placement, time-of-day helpers |
| `i18n.js` | 7 UI languages + `Langs` (UI / voice pack / LLM / TTS slots) |
| `audio.js` / `alarm.js` / `fx.js` / `shell.js` | Sound routing, alarms, canvas FX, Electron window controls |

**LLM side effects (no tools):** visual fields on the first tag line; stamina/inventory/quest JSON in a trailing `<state>` block stripped before display/TTS. Compatible OpenAI endpoints may not support function calling.

**TTS providers** use separate credential fields (`openai` / `qwen` / `fish`) so switching providers does not reuse the wrong host or key.

**Language matrix:** `app.lang` / `voice.lang` / `llm.lang` / `tts.lang`. If TTS language ≠ reply language, `Api.translate` runs first; on-screen text stays in the LLM language.

---

## 3. Shells

**Desktop (Electron):** `frame:false`, `ryza://app/` (not a loopback port for the page origin), `GET/POST /_proxy` on that scheme. Saves in `%AppData%\RyzaChat\ryza-web-storage.json`. `config/*` is not packaged.

**Android:** plain `Activity` + `AssetServer` (static assets + `/_proxy`). `config/*` returns 404. Command-line APK via `scripts/build_apk.ps1` (no Gradle required).

**Privacy:** `privacy_check.py` scans staged desktop output and APK zip members. Hit → build abort.

---

## 4. Tests

```powershell
node scripts/boot_smoke.js
node scripts/game_logic_regression.js
node scripts/memory_regression.js
node scripts/motion_regression.js
node scripts/expression_coverage.js
python scripts/privacy_check.py web
```

Packaging scripts run the privacy gate before and after produce.

---

## 5. Out of scope (product)

No login/Firebase, no subscription paywall, no token shop, no remote content gate, no analytics, no official websocket. LLM/TTS stay on endpoints the user pastes in Settings.

---

## 6. Media restore

After clone, raster/audio/skel are absent. Restore with `python scripts/restore_media.py <apk-or-unpacked-web>`, then `python scripts/build_indexes.py` if you changed files under `web/assets/`.
