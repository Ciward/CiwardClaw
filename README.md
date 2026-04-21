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

- want to plug **Google Gemini CLI quota/accounts** into OpenClaw more reliably
- plan to use **multiple auth profiles/accounts** and want faster switching between them
- mainly chat with OpenClaw through **Telegram**, including **groups and topics**, and want those routing/delivery paths to stay stable
- need **custom OpenAI-compatible providers** such as TokenLab/sub2api to behave more like Codex/Responses without the usual compatibility footguns

## What CiwardClaw adds

The list below summarizes the main fork-specific improvements on `ciwardclaw-4.14`.

- ⚡ **Steer-mode and `/refresh` reliability** for Telegram and Discord, including channel-serialization bypass, active-run steering, and replace-not-append refresh flow.
- 🛡️ **Restart recovery and typing continuity** across gateway restarts and `/new`, including inflight-run resume and native typing restoration.
- ❤️ **Heartbeat routing safeguards** so forced sessions, configured sessions, and thread delivery stay aligned.
- 🧭 **`/profiles` UX upgrades** with profile-bound usage/status behavior.
- 🔐 **Gemini, Codex, and Custom Provider runtime hardening**, including Codex profile login/switch, Gemini CLI OAuth/runtime fixes, explicit API-key preference, Responses compatibility, and Gemini quota-window classification fixes.
- 🧯 **Fallback, status, and cost guardrails** to prevent false live-switches, zero-context fallback, CCA quota retry loops, stale compaction token accounting, and bad custom OpenAI cost handling.
- 🖼️ **Better media/session replay and Telegram delivery correctness**, including inline `data:image/...;base64,...` replay as real image input plus topic/final-delivery fixes.

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
