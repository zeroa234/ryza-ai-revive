# Contributing

This is a local-first companion **framework**. Keep the public tree source-only: no API keys, no personal paths, no binary character media.

## Before a pull request

1. Restore media locally if you need to run the UI (`scripts/restore_media.py`).
2. Do not commit `config/providers.json`, keystores, or files under `web/assets/` that match the gitignore (png/jpg/audio/skel/fonts).
3. Run:

```powershell
node scripts/boot_smoke.js
node scripts/game_logic_regression.js
node scripts/memory_regression.js
python scripts/privacy_check.py web
```

Avatar or camera changes also need:

```powershell
node scripts/motion_regression.js
node scripts/expression_coverage.js
```

4. Version numbers come from `config/version.json` only (`scripts/stamp_version.js`). Do not hand-edit `desktop/package.json` or Gradle version fields.

## Proxy contract

`scripts/serve.py`, `desktop/main.js`, and Android `AssetServer` share the same `/_proxy` contract (POST for LLM/TTS JSON, GET to pull remote audio into a same-origin blob). Change all three together.

## What belongs in issues

Repro steps, expected vs actual, and whether you ran the scripts above. Do not paste API keys or `providers.json`.

## License

Contributions are accepted under the MIT License in `LICENSE`.
