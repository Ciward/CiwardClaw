# 🦞 CiwardClaw

[中文说明](./README.zh-CN.md)

A personal fork of [OpenClaw](https://github.com/openclaw/openclaw) focused on CiwardClaw-specific reliability fixes, provider compatibility patches, and ready-to-install release builds.

## Install CiwardClaw

### One-command install: latest CiwardClaw build

```bash
npm install -g https://github.com/Ciward/CiwardClaw/releases/latest/download/openclaw-latest.tgz
```

## Who CiwardClaw is for

CiwardClaw is especially useful for people who:

- want to plug **Google Gemini CLI quota/accounts** into OpenClaw more reliably (`89b1bd2705`, `92af4fc86d`, `9d09fc7cad`, `a65f43da68`, `a10b3e9f03`, `dc7d8d45c2`)
- plan to use **multiple auth profiles/accounts** and want faster switching between them (`2e704a2490`, `4cd5ec67ca`, `32816703a7`, `89b1bd2705`, `6d5e55867c`, `beb9822f4b`)
- mainly chat with OpenClaw through **Telegram**, including **groups and topics**, and want those routing/delivery paths to stay stable (`fcac1dde00`, `9aaac52c75`, `bf80723dde`, `7fb8d606b5`, `c12ae5a4fe`, `5c8a74f2c5`)
- need **custom OpenAI-compatible providers** such as TokenLab/sub2api to behave more like Codex/Responses without the usual compatibility footguns (`a7e7d897d9`, `2f225ae047`, `6d5e55867c`, `beb9822f4b`)

## What CiwardClaw adds

Each item below is backed by commits already present on `ciwardclaw-4.14`.

- ⚡ **Steer-mode and `/refresh` reliability** for Telegram and Discord, including channel-serialization bypass, active-run steering, and replace-not-append refresh flow (`fcac1dde00`, `6aa8860343`, `f8d30243c8`).
- 🛡️ **Restart recovery and typing continuity** across gateway restarts and `/new`, including inflight-run resume and native typing restoration (`7c124e9c6c`, `15e02608f3`, `8bd5271f31`, `4a993bf1af`, `9aaac52c75`, `bf80723dde`).
- ❤️ **Heartbeat routing safeguards** so forced sessions, configured sessions, and thread delivery stay aligned (`7fb8d606b5`, `292b2df52b`, `a8ea2906e0`).
- 🧭 **`/profiles` UX upgrades** with profile-bound usage/status behavior (`2e704a2490`, `4cd5ec67ca`, `32816703a7`).
- 🔐 **Gemini, Codex, and Custom Provider runtime hardening**, including Codex profile login/switch, Gemini CLI OAuth/runtime fixes, explicit API-key preference, Responses compatibility, and Gemini quota-window classification fixes (`89b1bd2705`, `92af4fc86d`, `9d09fc7cad`, `a65f43da68`, `a10b3e9f03`, `6d5e55867c`, `beb9822f4b`, `a7e7d897d9`, `2f225ae047`, `dc7d8d45c2`).
- 🧯 **Fallback, status, and cost guardrails** to prevent false live-switches, zero-context fallback, CCA quota retry loops, stale compaction token accounting, and bad custom OpenAI cost handling (`01148a23a8`, `63c42ffaef`, `1b8f4a2f00`, `94263afc2a`, `d640915829`, `ae38972fd7`, `ad9a588fa3`).
- 🖼️ **Better media/session replay and Telegram delivery correctness**, including inline `data:image/...;base64,...` replay as real image input plus topic/final-delivery fixes (`8ae14d830d`, `c12ae5a4fe`, `5c8a74f2c5`).

## Branch and release

- Default branch: `ciwardclaw-4.14`
- Current branch version: `2026.4.14`
- Latest tagged fork release: [`v2026.4.14`](https://github.com/Ciward/CiwardClaw/releases/tag/v2026.4.14)
- Upstream base: [`openclaw/openclaw`](https://github.com/openclaw/openclaw) `main`

## Upstream docs

Core install and usage docs remain upstream:

- Docs: https://docs.openclaw.ai
- Upstream README: https://github.com/openclaw/openclaw

## Maintainer

- [@Ciward](https://github.com/Ciward)
