# Security

## Secrets

- Never commit `config/providers.json` or keys from Settings.
- Packaging runs `scripts/privacy_check.py` and fails the build if a key-shaped token or personal machine path would ship.
- Report a leaked key by rotating it at the provider; do not open a public issue that contains the key.

## Scope

This project is a local client. It does not host user inference. LLM/TTS traffic goes to the endpoints **you** configure.

## Contact

Use GitHub Issues for non-sensitive bugs. For a packaging bypass that would embed secrets, open an issue **without** the secret and describe the path/pattern only.
