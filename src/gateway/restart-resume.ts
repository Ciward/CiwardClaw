import type { CliDeps } from "../cli/deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { type RestartSentinel, readRestartSentinel } from "../infra/restart-sentinel.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  clearInflightAgentRuns,
  ensureInflightAgentRunLifecycleCleanerStarted,
  isInflightAgentRunRecoveryEnabled,
  listInflightAgentRuns,
  markInflightAgentRunsResumed,
} from "./inflight-agent-runs.js";

const DEFAULT_RESUME_PROMPT =
  "Continue where you left off. The OpenClaw gateway restarted while you were running.";
const MAX_RESUME_ATTEMPTS = 10;
// Skip records older than 10 minutes — stale runs are unlikely to produce
// useful continuations after such a long gap.
const MAX_AGE_MS = 10 * 60 * 1000;
let cachedChannelRuntime: ReturnType<typeof createPluginRuntime>["channel"] | undefined;

function getChannelRuntime() {
  cachedChannelRuntime ??= createPluginRuntime().channel;
  return cachedChannelRuntime;
}

type ResumedRunTypingTarget =
  | {
      channel: "telegram";
      to: string;
      accountId?: string;
      messageThreadId?: number;
    }
  | {
      channel: "discord";
      channelId: string;
      accountId?: string;
    };

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalTelegramThreadId(value?: string | number): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveResumedRunTypingTarget(
  opts: Parameters<typeof agentCommandFromIngress>[0],
): ResumedRunTypingTarget | null {
  const channel = (
    normalizeOptionalText(opts.replyChannel) ?? normalizeOptionalText(opts.channel)
  )?.toLowerCase();
  const to = normalizeOptionalText(opts.replyTo) ?? normalizeOptionalText(opts.to);
  if (!channel || !to) {
    return null;
  }
  const accountId =
    normalizeOptionalText(opts.replyAccountId) ?? normalizeOptionalText(opts.accountId);
  if (channel === "telegram") {
    return {
      channel,
      to,
      accountId,
      messageThreadId: normalizeOptionalTelegramThreadId(opts.threadId),
    };
  }
  if (channel === "discord") {
    return {
      channel,
      channelId: to,
      accountId,
    };
  }
  return null;
}

function attachResumeTypingLifecycleBridge(params: {
  cfg: OpenClawConfig;
  runId: string;
  resumeOpts: Parameters<typeof agentCommandFromIngress>[0];
  subscribeAgentEvent: typeof onAgentEvent;
  resolveChannelRuntime: () => ReturnType<typeof createPluginRuntime>["channel"];
}): () => void {
  const target = resolveResumedRunTypingTarget(params.resumeOpts);
  if (!target) {
    return () => {};
  }

  let closed = false;
  let lease:
    | {
        stop: () => void;
      }
    | undefined;
  let leaseStartPromise: Promise<void> | undefined;
  let unsubscribe: () => void = () => {};

  const stopLease = () => {
    const active = lease;
    lease = undefined;
    active?.stop();
  };

  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    stopLease();
    unsubscribe();
  };

  const startLease = async () => {
    if (closed || lease || leaseStartPromise) {
      return;
    }
    leaseStartPromise = (async () => {
      try {
        const runtime = params.resolveChannelRuntime();
        const nextLease =
          target.channel === "telegram"
            ? await runtime.telegram.typing.start({
                to: target.to,
                accountId: target.accountId,
                cfg: params.cfg,
                messageThreadId: target.messageThreadId,
              })
            : await runtime.discord.typing.start({
                channelId: target.channelId,
                accountId: target.accountId,
                cfg: params.cfg,
              });
        if (closed) {
          nextLease.stop();
          return;
        }
        lease = nextLease;
      } catch (error) {
        logVerbose(
          `restart recovery: typing lease start failed for run ${params.runId}: ${String(error)}`,
        );
      }
    })().finally(() => {
      leaseStartPromise = undefined;
    });
    await leaseStartPromise;
  };

  unsubscribe = params.subscribeAgentEvent((evt) => {
    if (closed || evt.runId !== params.runId || evt.stream !== "lifecycle") {
      return;
    }
    const phase = typeof evt.data?.phase === "string" ? evt.data.phase : undefined;
    if (phase === "start") {
      void startLease();
      return;
    }
    if (phase === "end" || phase === "error") {
      cleanup();
    }
  });

  return cleanup;
}

function isRestartEligibleSentinel(sentinel: RestartSentinel | null | undefined): boolean {
  const payload = sentinel?.payload;
  if (!payload || payload.status !== "ok") {
    return false;
  }
  switch (payload.kind) {
    case "restart":
    case "config-apply":
    case "config-patch":
    case "update":
      return true;
    default:
      return false;
  }
}

export async function maybeResumeInflightAgentRunsAfterRestart(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  runtime: RuntimeEnv;
  env?: NodeJS.ProcessEnv;
  /**
   * Optional pre-read sentinel snapshot.
   * This avoids races with other startup code that consumes the sentinel.
   */
  sentinel?: RestartSentinel | null;
  /**
   * If provided and returns >0, resumption will be skipped to reduce duplicate
   * work during in-process restarts where older runs may still be active.
   */
  getActiveRunCount?: () => number;
  runAgent?: typeof agentCommandFromIngress;
  subscribeAgentEvent?: typeof onAgentEvent;
  channelRuntime?: ReturnType<typeof createPluginRuntime>["channel"];
}): Promise<{ resumed: number; considered: number; skipped: boolean }> {
  if (!isInflightAgentRunRecoveryEnabled(params.cfg)) {
    return { resumed: 0, considered: 0, skipped: true };
  }

  const env = params.env ?? process.env;
  const active = params.getActiveRunCount?.() ?? 0;
  if (active > 0) {
    return { resumed: 0, considered: 0, skipped: true };
  }

  const sentinel = params.sentinel ?? (await readRestartSentinel(env).catch(() => null));
  if (!isRestartEligibleSentinel(sentinel)) {
    // Best-effort: if the gateway started without a valid restart sentinel,
    // clear any leftover inflight records (e.g. after a hard crash) so they do
    // not get resumed on a future unrelated restart.
    await clearInflightAgentRuns(env).catch(() => {});
    return { resumed: 0, considered: 0, skipped: true };
  }

  ensureInflightAgentRunLifecycleCleanerStarted(env);
  const inflight = await listInflightAgentRuns(env);
  const run = params.runAgent ?? agentCommandFromIngress;
  const subscribeAgentEvent = params.subscribeAgentEvent ?? onAgentEvent;
  const resolveChannelRuntime = () => params.channelRuntime ?? getChannelRuntime();
  const now = Date.now();

  const resumedIds: string[] = [];
  for (const entry of inflight) {
    const runId = entry.runId?.trim();
    if (!runId) {
      continue;
    }
    if ((entry.resumeCount ?? 0) >= MAX_RESUME_ATTEMPTS) {
      continue;
    }
    if (now - entry.acceptedAt > MAX_AGE_MS) {
      logVerbose(`restart recovery: skipping stale run ${runId} (age ${now - entry.acceptedAt}ms)`);
      continue;
    }
    const baseOpts = entry.opts;
    const resumeOpts = {
      ...baseOpts,
      runId,
      message: DEFAULT_RESUME_PROMPT,
    };
    const cleanupTyping = attachResumeTypingLifecycleBridge({
      cfg: params.cfg,
      runId,
      resumeOpts,
      subscribeAgentEvent,
      resolveChannelRuntime,
    });
    void run(resumeOpts, params.runtime, params.deps)
      .catch((err) => {
        logVerbose(`restart recovery: resumed run ${runId} failed: ${String(err)}`);
      })
      .finally(() => {
        cleanupTyping();
      });
    resumedIds.push(runId);
  }

  await markInflightAgentRunsResumed(resumedIds, env).catch(() => {});

  return { resumed: resumedIds.length, considered: inflight.length, skipped: false };
}
