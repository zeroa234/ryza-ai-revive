# Security

Operator keys live in the local profile, not in the repository. Do not commit `config/providers.json`. `scripts/privacy_check.py` fails the desktop/APK build if a secret-shaped token or machine-local path would be packaged.

If a key is exposed, rotate it at the provider. Public issues must not contain the token. For a packaging-gate bypass, describe the path or pattern only.

Inference traffic is sent to the endpoints configured in Settings. This repository does not operate a model host.
