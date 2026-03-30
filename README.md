# 🦞 CiwardClaw

A personal fork of [OpenClaw](https://github.com/openclaw/openclaw) focused on migrated fixes from `ciward/dev`.

## What CiwardClaw adds

- ⚡ **Steer-mode follow-up injection** for Telegram and Discord by bypassing channel serialization while an active dispatch exists.
- ♊ **Gemini CLI auth/usage continuity fixes** to preserve endpoint + project metadata across OAuth and usage resolution.
- 🔄 **Codex profile login/switch support** for easier multi-account operations.
- 🛡️ **Gateway restart recovery hardening** so inflight agent runs can resume safely.
- 🧭 **Auto-reply `/profiles` workflow improvements** with profile-scoped usage/status behavior.
- 🧩 **Slash routing config reload fix** so DM scope updates are respected immediately.

## Branch and release

- Default branch: `ciwardclaw`
- Current fork release: [`v2026.3.30`](https://github.com/Ciward/CiwardClaw/releases/tag/v2026.3.30)
- Upstream base: [`openclaw/openclaw`](https://github.com/openclaw/openclaw) `main`

## Upstream docs

Core install and usage docs remain upstream:

- Docs: https://docs.openclaw.ai
- Upstream README: https://github.com/openclaw/openclaw

## Maintainer

- [@Ciward](https://github.com/Ciward)
