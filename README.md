# 🦞 CiwardClaw

A personal fork of [OpenClaw](https://github.com/openclaw/openclaw) focused on migrated fixes from `ciwardclaw`.

## What CiwardClaw adds

- ⚡ **Steer-mode routing reliability** for Telegram and Discord, including serialization-bypass and active-run steering fixes.
- 🛡️ **Restart recovery hardening** so inflight runs resume safely across gateway restarts.
- ⌨️ **Typing continuity fixes** so `/new` and restart-resume flows reflect real run activity.
- 🔐 **Gemini/Codex runtime reliability** with Codex profile login/switch plus Gemini endpoint propagation, OAuth credential parsing, usage transport alignment, and runner connectivity hardening.
- ❤️ **Heartbeat routing safeguards** with channel-aware thread policy and forced-session mismatch guards.
- 🧭 **Auto-reply profile UX upgrades** via `/profiles` and profile-scoped usage/status behavior.
- 🧯 **Fallback/status/cost guardrails** to prevent false live-switching during fallback (including embedded runner), avoid zero-context fallback, stop CCA quota retry loops, and harden custom OpenAI provider cost handling.

## Branch and release

- Default branch: `ciwardclaw`
- Current fork release: [`v2026.4.4`](https://github.com/Ciward/CiwardClaw/releases/tag/v2026.4.4)
- Post-release branch patches: reliability fixes after `v2026.4.4` are included on `ciwardclaw` but not tagged as a newer release yet.
- Upstream base: [`openclaw/openclaw`](https://github.com/openclaw/openclaw) `main`

## Upstream docs

Core install and usage docs remain upstream:

- Docs: https://docs.openclaw.ai
- Upstream README: https://github.com/openclaw/openclaw

## Maintainer

- [@Ciward](https://github.com/Ciward)
