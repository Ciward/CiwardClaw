# 🦞 CiwardClaw

A personal fork of [OpenClaw](https://github.com/openclaw/openclaw) focused on migrated fixes from `ciwardclaw`.

## What CiwardClaw adds

- ⚡ **Steer-mode routing reliability** for Telegram and Discord, including serialization-bypass and active-run steering fixes.
- 🛡️ **Restart recovery hardening** so inflight runs resume safely across gateway restarts.
- ⌨️ **Typing continuity fixes** so `/new` and restart-resume flows reflect real run activity.
- 🔐 **Gemini/Codex runtime reliability** with Codex profile login/switch and Gemini endpoint/quota continuity fixes.
- ❤️ **Heartbeat routing safeguards** with channel-aware thread policy and forced-session mismatch guards.
- 🧭 **Auto-reply profile UX upgrades** via `/profiles` and profile-scoped usage/status behavior.

## Branch and release

- Default branch: `ciwardclaw`
- Current fork release: [`v2026.4.4`](https://github.com/Ciward/CiwardClaw/releases/tag/v2026.4.4)
- Upstream base: [`openclaw/openclaw`](https://github.com/openclaw/openclaw) `main`

## Upstream docs

Core install and usage docs remain upstream:

- Docs: https://docs.openclaw.ai
- Upstream README: https://github.com/openclaw/openclaw

## Maintainer

- [@Ciward](https://github.com/Ciward)
