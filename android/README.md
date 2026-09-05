# Android WebView shell (no Flutter, no androidx)

Plain `android.app.Activity` + framework `WebView`. `web/` is bundled as
APK assets; `AssetServer` serves them on `http://127.0.0.1:8765/` AND
forwards `POST /_proxy?u=https://…` to the LLM/TTS endpoint (same contract
as `scripts/serve.py` / `desktop/main.js` — without it, WebView CORS kills
chat). `config/*` requests answer 404: providers.json never ships.

## Build the APK (no Gradle needed)

```powershell
powershell -File scripts/setup_android_tools.ps1   # one-time: JDK17 + SDK 34
powershell -File scripts/build_apk.ps1             # -> output\android\RyzaChat-<ver>.apk
```

Pipeline: `aapt2 compile/link` → `javac --release 11` → `d8` →
`scripts/pack_apk_assets.py` (assets MUST go in with forward slashes —
`aapt2 -A` on Windows writes `assets\js\…` which AssetManager can't open) →
`zipalign` → `apksigner` (self-signed keystore in `android/keystore/`,
gitignored). With local media restored, output is a large APK; it installs and uninstalls like any APK
(`adb install -r` or sideload; uninstall clears app data).

The Gradle project still works for Android Studio users
(`assets.srcDirs = ["../../web"]`), but the script above is the maintained path.

## Privacy

- No providers.json / API keys / personal endpoints inside the package
  (verified by scanning every packaged js/css/html + zip listing).
- No analytics, no permissions beyond INTERNET + VIBRATE.
