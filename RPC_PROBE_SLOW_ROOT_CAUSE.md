# Gateway startup warm-up delay investigation (2026-03-23)

## Scope

This report investigates why gateway cold starts/restarts sometimes spend several minutes before becoming ready. It focuses on the startup path executed by `openclaw gateway run` and launchd-managed restart flows.

## Executive summary

The dominant delay is **pre-start doctor preflight**, not post-start gateway warm-up.

Specifically, the CLI pre-action/config-guard path runs `loadAndMaybeMigrateDoctorConfig()` for `gateway` commands, and that flow can execute expensive scans/repairs plus render large `Doctor warnings` note blocks before `runGatewayLoop` calls `startGatewayServer()`. During long incidents, logs show this exact pattern:

- `signal SIGTERM received` (old process shutdown starts)
- long gap with a rendered `Doctor warnings` block
- only then first startup logs like `synced openai-codex credentials from external cli`
- finally `gateway listening ...`

So the user-observed "warm-up minutes" are mostly time spent **before** gateway server startup.

## Evidence

### 1) Long gaps align with doctor note output before first startup log

From `~/.openclaw/logs/gateway.log` on 2026-03-23:

- `L177175` `2026-03-23T20:13:07.671+08:00` `[gateway] signal SIGTERM received`
- `L177176` `2026-03-23T20:13:07.674+08:00` `[gateway] received SIGTERM; shutting down`
- `L177179-L177186` rendered `Doctor warnings` panel
- `L177187` `2026-03-23T20:21:02.544+08:00` first startup marker (`synced openai-codex credentials from external cli`)

Delta from SIGTERM to first startup marker: **~474.9s**.

Another window:

- `L177299` `2026-03-23T20:39:58.601+08:00` SIGTERM
- `L177300` stop message
- `L177303-L177310` Doctor warnings panel
- `L177311` first startup marker at `20:48:21.699`

Delta: **~503.1s**.

Another extreme window:

- `L177422` `2026-03-23T21:05:40.497+08:00` SIGTERM
- `L177423` stop message
- `L177426-L177433` Doctor warnings panel
- `L177434` first startup marker at `21:56:41.071`

Delta: **~3060.6s**.

These gaps happen _before_ normal startup phases (plugin loading, Control UI handling, channel boot). That excludes post-start warm-up as primary cause.

### 2) `Control UI assets missing; building` is not the dominant delay

When present, `Control UI assets missing; building` appears near the end of startup and is followed quickly by listening in many runs. It cannot explain the multi-minute pre-start holes above.

### 3) Code path confirms heavy preflight can run before gateway start

- `src/cli/program/preaction.ts:101-141` invokes `ensureConfigReady()` for most commands.
- `src/cli/program/config-guard.ts:47-55` runs `loadAndMaybeMigrateDoctorConfig()` when `shouldMigrateStateFromPath(commandPath)` is true.
- `src/cli/argv.ts:303-324` currently returns `true` for `gateway` command paths.
- `src/commands/doctor-config-flow.ts` includes multiple potentially expensive operations in this preflight path:
  - legacy state/config migration checks (`autoMigrateLegacyStateDir`, `maybeMigrateLegacyConfig`)
  - allowlist recovery scans (`maybeRepairAllowlistPolicyAllowFrom`) with filesystem reads
  - safe-bin scans (`scanExecSafeBinTrustedDirHints`) that resolve executables across PATH
  - note rendering for warnings (`note(...)`), which matches the observed `Doctor warnings` block in logs.

Because this runs before gateway start, any slowdown here is directly perceived as startup warm-up delay.

### 4) External-CLI credential sync is not the multi-minute root cause

`syncExternalCliCredentials()` appears as one of the first startup markers after the long hole. Its Codex keychain read has a 5s timeout and is cached (`EXTERNAL_CLI_SYNC_TTL_MS = 15m`), so it can contribute seconds but does not fit repeated 8+ minute/50+ minute gaps.

Relevant files:

- `src/agents/auth-profiles/external-cli-sync.ts`
- `src/agents/cli-credentials.ts` (Codex keychain read timeout 5000ms)

## Why this manifests as "warm-up slow"

Operationally, restart/start is perceived as one step. But implementation has a pre-start doctor guard stage in the same command flow. When this stage stalls, users see a long "starting/warming" period even though the gateway server has not started yet.

## Impacted commands

Any command path where config guard runs doctor flow can be impacted. For this incident, `gateway` paths are the critical user-facing surface.

## Secondary observation: restart strategy

There are pending local edits that revert restart default to full-process restart and keep in-process restart only behind `OPENCLAW_FORCE_INPROC_SIGUSR1_RESTART=1`.

Those edits are not the root cause analysis itself and are intentionally not finalized in this report-first step.

## Reproduction notes

1. Trigger restart under a config/state with doctor warnings.
2. Observe in `~/.openclaw/logs/gateway.log`:
   - shutdown signal lines,
   - then doctor warning panel output,
   - then delayed first startup marker (`synced openai-codex ...`),
   - then `gateway listening ...`.
3. Measure `SIGTERM -> first startup marker` for true pre-start stall duration.

## Root cause statement

**Root cause:** `gateway` command execution currently enters doctor preflight (`loadAndMaybeMigrateDoctorConfig`) via config guard before starting gateway server. In affected environments this preflight can be very slow (filesystem/path scans + migration checks + note rendering), creating minute-level startup delays that are misattributed to gateway warm-up.

## Proposed fix direction (not applied in this step)

1. Keep safety checks, but decouple heavy doctor work from gateway startup hot path:
   - fast validation-only preflight for `gateway run/start/restart`;
   - defer expensive doctor scans/repairs to explicit `doctor` commands or background diagnostics.
2. Preserve existing diagnostics visibility via concise warning lines instead of blocking note-heavy flow during startup.
3. After startup path is reduced, reassess restart policy default (full-process vs in-process) with targeted tests.

## Files/locations investigated

- `src/cli/program/preaction.ts`
- `src/cli/program/config-guard.ts`
- `src/cli/argv.ts`
- `src/commands/doctor-config-flow.ts`
- `src/infra/state-migrations.ts`
- `src/agents/auth-profiles/external-cli-sync.ts`
- `src/agents/cli-credentials.ts`
- `src/gateway/server.impl.ts`
- `src/daemon/launchd.ts`
- `src/daemon/launchd-restart-handoff.ts`
- Logs: `~/.openclaw/logs/gateway.log`, `~/.openclaw/logs/gateway.err.log`

---

## Addendum: second startup bottleneck after doctor-preflight fix (2026-03-24)

### Scope

After the first fix (doctor preflight removed from the gateway hot path), cold starts still showed long pre-listen delays. This addendum isolates that second bottleneck.

### Executive summary

The remaining delay is a **plugin-load import bottleneck** before `listening on ws://...`.

With default config, startup spends ~100-160 seconds in synchronous plugin loading. The dominant hotspot is the `discord` plugin import path under Jiti, specifically the `openclaw/plugin-sdk/discord` runtime export surface.

### Evidence

#### 1) Startup gap remains pre-listen and disappears when plugins are disabled

Command shape (same startup path):

- `node dist/index.js gateway --port <port> --allow-unconfigured`

Measured results:

- Plugins disabled via temp config (`plugins.enabled=false`): `LISTEN_SEC=2.930`
- Default config: `LISTEN_SEC=107.011`
- Repeated default runs: `LISTEN_SEC=112.561`, `131.099`, `162.437`

This isolates the remaining delay to plugin-dependent startup work.

#### 2) Single-plugin loader benchmark isolates `discord` as dominant hotspot

Using `loadOpenClawPlugins(...)` with only one plugin enabled at a time (`cache: false`, discovery/manifest caches disabled):

- `discord`: `125616.7ms`
- `whatsapp`: `2044.1ms`
- `feishu`: `1157.7ms`
- `openclaw-weixin`: `1001.0ms`
- `device-pair`: `653.2ms`
- `acpx`: `143.6ms`
- most others: `~10-200ms`

So the startup bottleneck is not general plugin loading; it is strongly skewed to Discord.

#### 3) Direct Jiti module loads confirm Discord import path is the bottleneck

With loader-equivalent Jiti alias setup:

- `extensions/discord/index.ts`: `186086.5ms`
- `src/plugin-sdk/discord.ts`: `123725.8ms`

and, in isolated dependency probes:

- `extensions/discord/src/audit.ts`: `117637.9ms`
- `extensions/discord/src/monitor/thread-bindings.ts`: `104206.3ms`

These heavy modules are re-exported by `src/plugin-sdk/discord.ts`.

#### 4) Startup order confirms this blocks listening

- Gateway loads plugins before logging listening:
  - `src/gateway/server.impl.ts:477-485`
  - `src/gateway/server.impl.ts:912-920`
- Plugin loader performs blocking Jiti module eval in its candidate loop:
  - `src/plugins/loader.ts:840-963`

Therefore this import cost directly delays gateway readiness.

### Why `acpx` and `openclaw-weixin` are not the dominant cause

Targeted config experiments:

- Default: `~106s`
- Disable `openclaw-weixin`: `~106s` (no meaningful improvement)
- Disable `acpx`: `~122s` (not an improvement)
- Disable both: `~121s`

This aligns with the benchmark data that points to Discord import cost, not ACPX/Weixin.

### Root cause statement

The second cold-start bottleneck is a synchronous Jiti import hotspot in the Discord plugin path. Loading the Discord plugin pulls in `openclaw/plugin-sdk/discord` runtime exports that include heavy extension modules, and that import dominates pre-listen startup time.

### Proposed fix direction (not applied in this report-first step)

1. Slim runtime-loaded exports in `src/plugin-sdk/discord.ts` so bootstrap paths do not import heavy operational modules.
2. Move heavy Discord helper exports (audit/thread-binding/onboarding-related runtime helpers) behind explicit/lazy runtime boundaries.
3. Keep Discord plugin entry (`extensions/discord/index.ts`) on a minimal SDK surface for startup.
4. Add a regression guard for plugin-load startup latency on gateway cold start.

### Applied fix (import-graph reduction for Discord startup path)

After the report-first checkpoint, we applied a scoped import-graph refactor to reduce eager module loading on the gateway plugin bootstrap path.

#### What changed

1. Use core SDK in Discord plugin bootstrap/runtime files (instead of the Discord subpath):
   - `extensions/discord/index.ts`
   - `extensions/discord/src/runtime.ts`
2. Remove `openclaw/plugin-sdk/discord` dependency from Discord subagent hooks:
   - `extensions/discord/src/subagent-hooks.ts`
   - now imports local `./accounts.js` and `./monitor/thread-bindings.js`.
3. Remove monolithic `openclaw/plugin-sdk/discord` import from the Discord channel plugin:
   - `extensions/discord/src/channel.ts`
   - now imports only the exact required modules directly from core/extension sources.
4. Narrow status-issues shim export surface:
   - add `extensions/discord/src/status-issues.export.ts`
   - point `src/channels/plugins/status-issues/discord.ts` at that narrow export module.
5. Keep public SDK compatibility:
   - `src/plugin-sdk/discord.ts` still exports `discordOnboardingAdapter` and `collectDiscordStatusIssues` (API surface preserved).
6. Adjust tests for the new import boundaries:
   - `extensions/discord/src/subagent-hooks.test.ts`.

#### Why this fix should improve startup

The startup bottleneck was synchronous module evaluation during plugin load. When runtime-loaded Discord files imported `openclaw/plugin-sdk/discord`, that subpath re-export graph could pull in heavier Discord helpers earlier than needed. By replacing broad subpath imports with direct, minimal imports:

- the bootstrap path evaluates fewer modules up front,
- heavy modules are less likely to be dragged into pre-listen startup transitively,
- gateway can reach `listening on ws://...` sooner.

This directly targets the measured pre-listen delay class described above (Jiti import hotspot before listen).

### Potential impact assessment

#### Behavior impact

- Expected behavior impact: **none** (refactor is import-boundary only; no business-logic changes intended).
- Channel behavior, onboarding behavior, and status issue logic are unchanged in implementation.

#### Compatibility impact

- External/plugin SDK compatibility: **kept**.
- `src/plugin-sdk/discord.ts` retains the previously expected exports used by tests and downstream imports.

#### Test/validation status

- Targeted tests passed:
  - `extensions/discord/src/channel.test.ts`
  - `extensions/discord/src/subagent-hooks.test.ts`
  - `src/plugin-sdk/subpaths.test.ts`
- Repo checks/build passed:
  - `pnpm check`
  - `pnpm build`

#### Residual risk / caveats

1. This is a structural optimization, not a semantic feature change; risk is mainly import-boundary drift in future refactors.
2. Startup-time improvement is expected from import-graph reduction, but final runtime delta should still be confirmed by cold-start benchmarking.
3. Per current operator instruction, no new gateway start/replace runtime benchmark was executed in this step; benchmark confirmation remains a follow-up task.

### Follow-up benchmark (isolated cold-start, 2026-03-24)

After applying the import-graph reduction, we ran an isolated cold-start comparison using:

- separate state/config roots via `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH`
- loopback-only bind
- dedicated benchmark ports (`18951-18953`, `19051-19053`)
- no interaction with the operator's local gateway port (`18789`)

Command shape per run:

- `node dist/index.js gateway run --port <port> --bind loopback --allow-unconfigured --verbose`

Config variants:

1. `plugins.enabled=true` (`plugins_on`)
2. `plugins.enabled=false` (`plugins_off`)

#### Results (3 runs each)

- `plugins_on`: 3.867s, 2.607s, 2.729s
  - avg: **3.068s**, min: 2.607s, max: 3.867s
- `plugins_off`: 1.609s, 1.614s, 1.611s
  - avg: **1.611s**, min: 1.609s, max: 1.614s

#### Interpretation

1. Gateway cold start now reaches listen in single-digit seconds in this environment.
2. Plugin load still adds measurable cost (`plugins_on` slower than `plugins_off`), but the previous minute-level pre-listen stall was not reproduced.
3. The gap between plugin-on/off (~1.46s avg) suggests remaining plugin startup overhead exists, yet it is in a practical range compared with earlier incidents.
