# Architecture notes

Ryza Chat is a local-first conversational client with a Spine 4.2 avatar. This note records the module boundaries of the source tree. Version is pinned in `config/version.json` (currently **1.2.15**).

本地对话客户端的模块边界。版本以 `config/version.json` 为准。

---

## 1. Layout

```
web/                    # static client (no bundler)
  index.html
  css/app.css
  js/                   # §2
  vendor/spine-webgl.js # Spine 4.2 runtime
  assets/               # tables in VCS; large binaries restored locally
desktop/                # Electron host: ryza://app + /_proxy
android/                # WebView + AssetServer
scripts/
  serve.py              # static origin + CORS proxy
  build_indexes.py      # assets → web/assets/_index/*.json
  restore_media.py      # copy runtime binaries into web/assets/
  motion_regression.js
  game_logic_regression.js
  expression_coverage.js
  memory_regression.js
  boot_smoke.js
  privacy_check.py      # packaging gate
  stamp_version.js      # version.json → package.json, Gradle
  build_desktop.ps1
  build_apk.ps1
  setup_android_tools.ps1
config/version.json
config/providers.example.json
docs/                   # this file
```

A single web kernel is loaded by three hosts (browser, Electron, Android). Development:

```powershell
python scripts/serve.py          # http://127.0.0.1:8765/
cd desktop && npx electron .
powershell -File scripts/build_desktop.ps1
powershell -File scripts/setup_android_tools.ps1
powershell -File scripts/build_apk.ps1
```

---

## 2. Client modules (`web/js`)

| File | Responsibility |
|---|---|
| `app.js` | Composition: boot, talk loop, sheets, HUD. Does not own numeric RPG state. |
| `api.js` | LLM/TTS transport, tagged-reply parsing, `/_proxy`, per-provider TTS fields |
| `config.js` | Settings persistence; optional hydration from local `providers.json` |
| `avatar.js` | WebGL portrait and scene camera; posture; tap hit-testing |
| `game.js` | RPG reducer; `applyDelta` is the sole write path |
| `quests.js` | Quest lifecycle and offline action tables |
| `daily.js` | Daily rewards issued through `Game` |
| `memory.js` | Session / summary cards (disjoint from `Game.s.memory`) |
| `world.js` | Map hierarchy, NPC placement, time-of-day |
| `i18n.js` | Seven UI locales; `Langs` slots for UI / voice pack / LLM / TTS |
| `audio.js`, `alarm.js`, `fx.js`, `shell.js` | Routing, alarms, canvas FX, Electron window controls |

**Side-effect protocol.** Visual fields occupy the first tag line of a model reply. Stamina, inventory, and quest updates occupy a trailing `<state>` JSON block, stripped before display and TTS. The protocol does not require tool calling, which many OpenAI-compatible endpoints omit.

**TTS.** Credential fields are partitioned by provider (`openai` / `qwen` / `fish`) so a host switch cannot reuse the previous base URL or key.

**Language matrix.** `app.lang`, `voice.lang`, `llm.lang`, `tts.lang`. When TTS language differs from LLM language, `Api.translate` runs first; on-screen text remains in `llm.lang`.

---

## 3. Hosts

**Desktop.** Electron, `frame: false`, custom scheme `ryza://app/`. `GET/POST /_proxy` is implemented on that scheme. Profile data: `%AppData%\RyzaChat\ryza-web-storage.json`. `config/` is not packaged.

**Android.** `android.app.Activity` and `AssetServer` (static files plus `/_proxy`). Requests under `config/` return 404. The maintained APK path is `scripts/build_apk.ps1`.

**Packaging gate.** `privacy_check.py` inspects staged desktop output and APK zip members. A match aborts the build.

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

Desktop and APK scripts invoke the privacy gate before and after produce.

---

## 5. Runtime resources

After clone, restore binaries with `python scripts/restore_media.py <apk-or-unpacked-web>`. If files under `web/assets/` change, run `python scripts/build_indexes.py`.
