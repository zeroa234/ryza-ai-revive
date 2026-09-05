# Ryza Chat

A local-first client for a conversational agent with a real-time 2D avatar.

The application is a static HTML/JavaScript runtime. Thin native hosts load the same tree on Windows (Electron) and Android (WebView). Language and speech models are attached at run time through operator-configured HTTP APIs (OpenAI-compatible chat completions, plus optional TTS backends).

面向实时二维立绘的本地对话客户端。应用核为静态 HTML/JavaScript；Windows（Electron）与 Android（WebView）仅提供宿主。语言模型与语音合成在运行时接入操作者配置的 HTTP API。

Version **1.2.15**. License: [MIT](LICENSE). Releases: [GitHub Releases](https://github.com/zeroa234/ryza-ai-revive/releases).

---

## Architecture

| Layer | Role |
|---|---|
| `web/` | Shared client: UI, avatar renderer, local state, i18n |
| `desktop/` | Frameless Electron host (`ryza://app/`) |
| `android/` | `Activity` + local `AssetServer` |
| `scripts/` | Dev server, indexes, packaging, regression tests |
| `config/` | Version pin (`version.json`) and provider templates |

The three hosts share one proxy contract, `GET/POST /_proxy`, so browser and WebView code can call operator endpoints without a CORS failure. The development server is `python scripts/serve.py` (`http://127.0.0.1:8765/`). A plain `http.server` is insufficient because it does not implement the proxy.

三端共用 `/_proxy`。开发请用 `scripts/serve.py`，不要用 `python -m http.server`。

Inference is not bundled. Settings require an OpenAI-compatible base URL, model identifier, and API key; TTS is optional and uses per-provider credential fields (`openai` / `qwen` / `fish`).

推理与语音不随仓库分发，由设置页配置。

Further module-level notes: [docs/PROJECT.md](docs/PROJECT.md).

---

## Capabilities

- Dialogue modes: chat, story, immersive, ASMR, text
- Spine 4.2 portrait and scene graph (posture, camera, tap hit-testing)
- Local RPG-style state: stamina, quests, inventory, daily rewards (`localStorage`)
- Two-layer session memory, independent of adventure logs
- Four language slots (UI, bundled voice, LLM output, TTS), seven UI locales
- Tagged replies for scene side effects; numeric deltas in a trailing `<state>` block (no function-calling requirement)

---

## Runtime resources

Structural tables (JSON, atlas, SVG) live in `web/assets/` and are versioned with the client. Large binaries (raster, audio, skeleton) are excluded from version control and restored before a full session or packaged build:

结构表随仓库版本管理；体积较大的栅格图、音频与骨骼二进制在完整运行或打包前本地恢复：

```powershell
python scripts/restore_media.py path\to\RyzaChat-1.2.15.apk
python scripts/restore_media.py path\to\win-unpacked\resources\web
```

If asset files change, regenerate indexes with `python scripts/build_indexes.py`.

---

## Configuration and secrets

Copy `config/providers.example.json` to `config/providers.json` for local hydration. That file is gitignored. Packaged hosts do not embed it; keys remain in the app profile (`localStorage` or `%AppData%\RyzaChat`). `scripts/privacy_check.py` is a packaging gate: a non-zero exit aborts desktop and APK builds when a secret-shaped token or machine-local path would be included.

---

## Build

```powershell
python scripts/serve.py                          # browser
cd desktop; npm install; npx electron .          # desktop
powershell -File scripts/build_desktop.ps1       # NSIS installer
powershell -File scripts/setup_android_tools.ps1 # JDK 17 + SDK (once)
powershell -File scripts/build_apk.ps1           # APK
```

Android toolchain path: environment `RYZA_ANDROID_TOOLS`, or gitignored `config/android-tools.local.txt`.

---

## Tests

```powershell
node scripts/boot_smoke.js
node scripts/game_logic_regression.js
node scripts/memory_regression.js
node scripts/motion_regression.js
node scripts/expression_coverage.js
python scripts/privacy_check.py web
```

Contribution rules: [CONTRIBUTING.md](CONTRIBUTING.md).
