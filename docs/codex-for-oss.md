# Codex for Open Source — application copy

Official form: https://openai.com/form/codex-for-oss/  
(zh page: https://openai.com/zh-Hans-CN/form/codex-for-oss/)

Fill the ChatGPT email, GitHub username, OpenAI Organization ID, and maintainer role yourself.  
The two 500-character answers below are ready to paste. Character counts include spaces.

Repository URL: `https://github.com/zeroa234/ryza-ai-revive`

## Why does this repository qualify? (max 500)

```
Ryza Chat is a public MIT-licensed offline AI companion framework: a static HTML/JS client plus thin Electron and Android WebView shells. Users bring their own OpenAI-compatible LLM/TTS; nothing calls a vendor game backend. The git tree is source-only (no binary media). Packaging aborts on secret-shaped strings. Tests cover boot, game logic, avatar motion, and memory. I am the primary maintainer (issues, releases, Windows/Android builds). Local-first companion pattern, not a hosted service.
```

## How will you use API credits for your project? (max 500)

```
Use credits only for maintainer work: Codex-assisted PR review, updating regression tests when avatar/camera/RPG modules change, issue triage, release notes, and hardening the local /_proxy plus privacy_check packaging path. All generated patches go through review before merge. Credits will not fund end-user inference, hosted chat, or a hosted model. The app stays bring-your-own-key; OpenAI credits stay on maintainer automation and core open-source maintenance.
```

## Anything else (optional, max 500)

```
The public tree is original client code under MIT. Character raster/audio/skel files are gitignored and are not distributed via git. Desktop and Android shells are thin: same web kernel, local proxy, no analytics. I can apply Codex to review PRs, keep the test suite green, and document maintainer workflows without changing the BYO-key product model.
```

## Checklist before submit

- [ ] GitHub profile is **public**
- [ ] Repository is **public**
- [ ] LICENSE file is MIT on default branch
- [ ] ChatGPT account email matches the form
- [ ] Organization ID from https://platform.openai.com/settings/organization
- [ ] Interested in: API credits (and Codex Security only if you want it)
