# Contributing

## Pull requests

1. Restore runtime binaries if you need a full UI session (`scripts/restore_media.py`).
2. Do not commit `config/providers.json`, Android keystores, or gitignored binaries under `web/assets/` (raster, audio, skeleton, bundled fonts).
3. Run:

```powershell
node scripts/boot_smoke.js
node scripts/game_logic_regression.js
node scripts/memory_regression.js
python scripts/privacy_check.py web
```

Changes to avatar or camera also require:

```powershell
node scripts/motion_regression.js
node scripts/expression_coverage.js
```

4. Versions are derived from `config/version.json` via `scripts/stamp_version.js`. Do not edit `desktop/package.json` or Gradle version fields by hand.

## Proxy contract

`scripts/serve.py`, `desktop/main.js`, and Android `AssetServer` implement the same `/_proxy` contract (POST: LLM/TTS JSON; GET: fetch remote audio into a same-origin blob). Edits must land on all three.

## Issues

Include reproduction steps and expected versus observed behaviour. Do not attach API keys or `providers.json`.

Contributions are licensed under MIT (`LICENSE`).
