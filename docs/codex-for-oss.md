# Codex for Open Source — application copy

Official form: https://openai.com/form/codex-for-oss/  
Chinese page: https://openai.com/zh-Hans-CN/form/codex-for-oss/

Fill email, GitHub username, Organization ID, and maintainer role yourself.  
The answers below are sized for the 500-character fields (spaces counted).

Repository: `https://github.com/zeroa234/ryza-ai-revive`

## Why does this repository qualify? (max 500)

```
Ryza Chat is an MIT-licensed local-first client for conversational agents with a Spine 4.2 avatar. A static HTML/JS runtime is shared by browser, Electron, and Android WebView hosts. Operators attach OpenAI-compatible LLM and TTS endpoints. The tree includes the client, structural data, and a packaging pipeline with secret scanning. Regression tests cover boot, game state, avatar motion, and memory. I am the primary maintainer (issues, releases, desktop and Android builds).
```

## How will you use API credits for your project? (max 500)

```
Credits would support maintenance of this repository: Codex-assisted pull-request review, extending regression tests when the avatar camera or RPG reducer changes, issue triage, release notes, and incremental work on the shared /_proxy contract and privacy_check packaging gate. Generated patches are reviewed before merge.
```

## Anything else (optional, max 500)

```
The client uses a tagged-reply protocol rather than tool calling, so it remains usable against OpenAI-compatible endpoints that omit function calling. Versioning is centralized in config/version.json. Desktop and Android hosts implement the same /_proxy contract as the development server.
```

## Checklist

- [ ] GitHub profile is public
- [ ] Repository is public
- [ ] MIT `LICENSE` on the default branch
- [ ] Form email matches the ChatGPT account
- [ ] Organization ID from https://platform.openai.com/settings/organization
- [ ] Requested benefits: API credits (Codex Security optional)
