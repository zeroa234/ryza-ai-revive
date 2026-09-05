# Ryza Chat

**Offline AI companion framework** — one static HTML/JavaScript client, plus thin Windows (Electron) and Android (WebView) shells. You bring your own OpenAI-compatible LLM and TTS keys. Nothing in this tree talks to a vendor game server.

**离线 AI 陪伴框架**：同一套纯前端，外加 Windows / Android 薄壳。大模型和语音接口由你在设置里自填。本仓库不连接任何官方游戏服务。

Current version: **1.2.15** — optional installers (when you have restored local media): [Releases](https://github.com/zeroa234/ryza-ai-revive/releases)

> Unofficial fan project. Not affiliated with Gust, Koei Tecmo, or any original publisher.  
> 非官方同人项目，与官方及原发行方无关。

License: **MIT** (this source tree). Binary character art, Spine `.skel` files, voice/BGM, and fonts are **not** in git — you supply them locally.

本仓库只授权**源码**。角色贴图、骨骼二进制、语音/BGM、字体不进 git，由使用者在本地自行放入。

---

## What this repository is / 本仓库是什么

A **from-scratch client framework** for a local-first companion app:

- Static `web/` kernel (no bundler required) shared by browser, desktop, and Android
- Bring-your-own LLM (OpenAI-compatible `/v1/chat/completions`) and TTS (OpenAI-compatible, Qwen DashScope, or Fish Audio)
- Local CORS proxy (`POST/GET /_proxy`) so the browser/WebView never holds a privileged network stack
- Optional RPG layer (stamina, quests, inventory, daily login) stored in localStorage
- Spine 4.2 avatar + scene camera, sit/stand, tap reactions
- Privacy gate: packaging **aborts** if a key-shaped secret or personal machine path would ship
- Regression tests for boot, game logic, avatar motion, memory, and expression coverage

This git tree is **source code and data tables** (JSON / atlas / SVG). Raster images, audio, and `.skel` binaries are gitignored, including history.

本 git 树是**源码 + 结构表**。位图、音频、`.skel` 已从仓库（含历史）排除。

---

## Features / 功能

| EN | 中文 |
|---|---|
| Talk modes (chat / story / immersive / ASMR / text) | 五种对话模式 |
| Spine 4.2 portrait + scenes, sit/stand, tap reactions | 立绘与场景、坐站切换、点击反应 |
| Local RPG layer (stamina, quests, inventory, daily login) | 体力 / 任务 / 背包 / 每日登录 |
| BYO OpenAI-compatible LLM + TTS (Qwen / Fish Audio optional) | 自填 LLM 与 TTS（可选百炼 / Fish Audio） |
| 7 UI languages | 界面七语 |
| Frameless desktop window + Android WebView APK | 无边框桌面窗 + 安卓 WebView |
| Privacy check on every desktop/APK build | 每次打包跑隐私闸门 |

---

## Assets / 素材（不在 git 里）

Playable Windows and Android builds still need media under `web/assets/`. Restore from a Release package you already have — do not commit those files:

可玩包需要把素材放回 `web/assets/`，不要提交：

```powershell
python scripts/restore_media.py path\to\RyzaChat-1.2.15.apk
# or an unpacked desktop tree:
python scripts/restore_media.py path\to\win-unpacked\resources\web
```

JSON / atlas / SVG under `web/assets/` stay in git so modules have structure tables. PNG / JPEG / audio / `.skel` / bundled fonts do not.

---

## Privacy / 隐私

- `config/providers.json` is **gitignored**. Copy `config/providers.example.json` and fill keys locally.
- Keys live in app settings (localStorage / `%AppData%\RyzaChat`). They are not baked into exe/APK.
- `scripts/privacy_check.py` runs before and after packaging and **fails the build** on secret-shaped strings or personal paths.
- No analytics, no crash reporter, no official backend.

---

## Run from source / 从源码运行

Restore media first, then start the bundled static server. Spine and `fetch` cannot use `file://`. The server also provides `/_proxy` for CORS:

```powershell
python scripts/serve.py
# open http://127.0.0.1:8765/
```

Do not use `python -m http.server` — there is no proxy, LLM/TTS will fail CORS.

### Desktop / 桌面

```powershell
cd desktop
npm install
npx electron .
```

Installer (after media restore):

```powershell
powershell -File scripts/build_desktop.ps1
# -> output/desktop/RyzaChat-Setup-<version>.exe
```

### Android / 安卓

```powershell
powershell -File scripts/setup_android_tools.ps1   # one-time JDK 17 + SDK
powershell -File scripts/build_apk.ps1
# -> output/android/RyzaChat-<version>.apk
```

Toolchain directory: set `RYZA_ANDROID_TOOLS`, or put a path in gitignored `config/android-tools.local.txt`.

---

## Settings / 设置里要填什么

1. **LLM** — OpenAI-compatible base URL, model id, API key.
2. **TTS** (optional) — separate fields per provider. Packaged builds do not include `providers.json`; fill model names on device.

---

## Tests / 测试

```powershell
node scripts/boot_smoke.js
node scripts/game_logic_regression.js
node scripts/memory_regression.js
node scripts/motion_regression.js
node scripts/expression_coverage.js
python scripts/privacy_check.py web
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Architecture: [docs/PROJECT.md](docs/PROJECT.md).

---

## Layout / 目录

```
web/          static app (media under assets/ is local-only)
desktop/      Electron shell (ryza://app)
android/      WebView + local AssetServer
scripts/      serve, indexes, packaging, privacy gate
config/       version.json + providers.example.json
docs/         public architecture notes
```

---

## Disclaimer / 声明

This repository is original client code. It does not distribute another publisher's game binaries or paid services. Character likenesses, if you use them, come from media **you** place under `web/assets/`. Do not treat this as an official product.

本仓库是从零编写的客户端框架，不通过 git 分发第三方游戏二进制或付费服务。角色形象若使用，来自你放在 `web/assets/` 的本地素材。请勿当成官方产品。
