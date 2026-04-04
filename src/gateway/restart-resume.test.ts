import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { AgentCommandIngressOpts } from "../commands/agent/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { writeRestartSentinel } from "../infra/restart-sentinel.js";
import { defaultRuntime } from "../runtime.js";
import { __test, addInflightAgentRun } from "./inflight-agent-runs.js";
import { maybeResumeInflightAgentRunsAfterRestart } from "./restart-resume.js";

type AgentCommandFromIngress = typeof import("../commands/agent.js").agentCommandFromIngress;

const savedEnv = { ...process.env };

async function makeTempStateDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  process.env.OPENCLAW_STATE_DIR = dir;
  return dir;
}

afterEach(async () => {
  __test.reset();
  resetAgentEventsForTest();
  process.env = { ...savedEnv };
});

describe("restart resume", () => {
  it("resumes inflight agent runs when restart sentinel kind=restart", async () => {
    const dir = await makeTempStateDir("openclaw-restart-resume-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };

    await writeRestartSentinel(
      {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        message: "restart",
      },
      env,
    );

    const runId = "run-resume-1";
    const opts: AgentCommandIngressOpts = {
      message: "original",
      sessionId: "sess-1",
      sessionKey: "main",
      deliver: false,
      senderIsOwner: true,
      allowModelOverride: false,
      runId,
    };
    await addInflightAgentRun({ runId, acceptedAt: Date.now(), opts }, env);

    const runAgentMock = vi.fn(async (_o: AgentCommandIngressOpts) => undefined);
    const cfg: OpenClawConfig = {
      gateway: { restartRecovery: { resumeInflightAgentRuns: true } },
    };

    const result = await maybeResumeInflightAgentRunsAfterRestart({
      cfg,
      deps: {} as unknown as CliDeps,
      runtime: defaultRuntime,
      env,
      getActiveRunCount: () => 0,
      runAgent: runAgentMock as unknown as AgentCommandFromIngress,
    });

    expect(result.skipped).toBe(false);
    expect(result.considered).toBe(1);
    expect(result.resumed).toBe(1);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const calledOpts = runAgentMock.mock.calls[0]?.[0];
    expect(calledOpts.runId).toBe(runId);
    expect(calledOpts.senderIsOwner).toBe(true);
    expect(calledOpts.message).toMatch(/gateway restarted/i);

    const store = await __test.readStore(env);
    expect(store.runs[runId]?.resumeCount).toBe(1);
  });

  it("resumes inflight agent runs when restart sentinel kind=config-patch", async () => {
    const dir = await makeTempStateDir("openclaw-restart-resume-patch-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };

    await writeRestartSentinel(
      {
        kind: "config-patch",
        status: "ok",
        ts: Date.now(),
        message: "config patch restart",
      },
      env,
    );

    const runId = "run-resume-patch-1";
    const opts: AgentCommandIngressOpts = {
      message: "original",
      sessionId: "sess-1",
      sessionKey: "main",
      deliver: false,
      senderIsOwner: true,
      allowModelOverride: false,
      runId,
    };
    await addInflightAgentRun({ runId, acceptedAt: Date.now(), opts }, env);

    const runAgentMock = vi.fn(async (_o: AgentCommandIngressOpts) => undefined);
    const cfg: OpenClawConfig = {
      gateway: { restartRecovery: { resumeInflightAgentRuns: true } },
    };

    const result = await maybeResumeInflightAgentRunsAfterRestart({
      cfg,
      deps: {} as unknown as CliDeps,
      runtime: defaultRuntime,
      env,
      getActiveRunCount: () => 0,
      runAgent: runAgentMock as unknown as AgentCommandFromIngress,
    });

    expect(result.skipped).toBe(false);
    expect(result.considered).toBe(1);
    expect(result.resumed).toBe(1);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it("skips resuming runs that exceeded the max resume attempts", async () => {
    const dir = await makeTempStateDir("openclaw-restart-resume-cap-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };

    await writeRestartSentinel(
      {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        message: "restart",
      },
      env,
    );

    const runId = "run-resume-cap-1";
    const opts: AgentCommandIngressOpts = {
      message: "original",
      sessionId: "sess-1",
      sessionKey: "main",
      deliver: false,
      senderIsOwner: true,
      allowModelOverride: false,
      runId,
    };
    await addInflightAgentRun({ runId, acceptedAt: Date.now(), opts, resumeCount: 10 }, env);

    const runAgentMock = vi.fn(async (_o: AgentCommandIngressOpts) => undefined);
    const cfg: OpenClawConfig = {
      gateway: { restartRecovery: { resumeInflightAgentRuns: true } },
    };

    const result = await maybeResumeInflightAgentRunsAfterRestart({
      cfg,
      deps: {} as unknown as CliDeps,
      runtime: defaultRuntime,
      env,
      getActiveRunCount: () => 0,
      runAgent: runAgentMock as unknown as AgentCommandFromIngress,
    });

    expect(result.skipped).toBe(false);
    expect(result.considered).toBe(1);
    expect(result.resumed).toBe(0);
    expect(runAgentMock).toHaveBeenCalledTimes(0);
  });

  it("clears inflight records when enabled but no restart sentinel is present", async () => {
    const dir = await makeTempStateDir("openclaw-restart-resume-clear-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };

    const runId = "run-clear-1";
    const opts: AgentCommandIngressOpts = {
      message: "original",
      sessionId: "sess-1",
      sessionKey: "main",
      deliver: false,
      senderIsOwner: true,
      allowModelOverride: false,
      runId,
    };
    await addInflightAgentRun({ runId, acceptedAt: Date.now(), opts }, env);

    const runAgentMock = vi.fn(async (_o: AgentCommandIngressOpts) => undefined);
    const cfg: OpenClawConfig = {
      gateway: { restartRecovery: { resumeInflightAgentRuns: true } },
    };

    const result = await maybeResumeInflightAgentRunsAfterRestart({
      cfg,
      deps: {} as unknown as CliDeps,
      runtime: defaultRuntime,
      env,
      getActiveRunCount: () => 0,
      runAgent: runAgentMock as unknown as AgentCommandFromIngress,
    });

    expect(result.skipped).toBe(true);
    expect(result.resumed).toBe(0);
    expect(runAgentMock).toHaveBeenCalledTimes(0);

    const store = await __test.readStore(env);
    expect(Object.keys(store.runs)).toHaveLength(0);
  });

  it("does not resume runs for a non-success update sentinel", async () => {
    const dir = await makeTempStateDir("openclaw-restart-resume-update-error-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };

    await writeRestartSentinel(
      {
        kind: "update",
        status: "error",
        ts: Date.now(),
        message: "update failed",
      },
      env,
    );

    const runId = "run-update-error-1";
    const opts: AgentCommandIngressOpts = {
      message: "original",
      sessionId: "sess-1",
      sessionKey: "main",
      deliver: false,
      senderIsOwner: true,
      allowModelOverride: false,
      runId,
    };
    await addInflightAgentRun({ runId, acceptedAt: Date.now(), opts }, env);

    const runAgentMock = vi.fn(async (_o: AgentCommandIngressOpts) => undefined);
    const cfg: OpenClawConfig = {
      gateway: { restartRecovery: { resumeInflightAgentRuns: true } },
    };

    const result = await maybeResumeInflightAgentRunsAfterRestart({
      cfg,
      deps: {} as unknown as CliDeps,
      runtime: defaultRuntime,
      env,
      getActiveRunCount: () => 0,
      runAgent: runAgentMock as unknown as AgentCommandFromIngress,
    });

    expect(result.skipped).toBe(true);
    expect(result.resumed).toBe(0);
    expect(runAgentMock).toHaveBeenCalledTimes(0);

    const store = await __test.readStore(env);
    expect(Object.keys(store.runs)).toHaveLength(0);
  });

  it("starts typing on lifecycle start and stops on lifecycle end for resumed telegram runs", async () => {
    const dir = await makeTempStateDir("openclaw-restart-resume-typing-telegram-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };

    await writeRestartSentinel(
      {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        message: "restart",
      },
      env,
    );

    const runId = "run-resume-typing-telegram-1";
    const opts: AgentCommandIngressOpts = {
      message: "original",
      sessionId: "sess-1",
      sessionKey: "main",
      deliver: true,
      channel: "telegram",
      to: "-100123",
      threadId: "42",
      accountId: "acct-telegram",
      senderIsOwner: true,
      allowModelOverride: false,
      runId,
    };
    await addInflightAgentRun({ runId, acceptedAt: Date.now(), opts }, env);

    const telegramStop = vi.fn();
    const telegramStart = vi.fn(async () => ({
      refresh: async () => undefined,
      stop: telegramStop,
    }));
    const channelRuntime = {
      telegram: { typing: { start: telegramStart } },
      discord: {
        typing: {
          start: vi.fn(async () => ({
            refresh: async () => undefined,
            stop: vi.fn(),
          })),
        },
      },
    } as unknown as NonNullable<
      Parameters<typeof maybeResumeInflightAgentRunsAfterRestart>[0]["channelRuntime"]
    >;

    const runAgentMock = vi.fn(async (_o: AgentCommandIngressOpts) => {
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start" } });
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
    });
    const cfg: OpenClawConfig = {
      gateway: { restartRecovery: { resumeInflightAgentRuns: true } },
    };

    const result = await maybeResumeInflightAgentRunsAfterRestart({
      cfg,
      deps: {} as unknown as CliDeps,
      runtime: defaultRuntime,
      env,
      getActiveRunCount: () => 0,
      runAgent: runAgentMock as unknown as AgentCommandFromIngress,
      channelRuntime,
    });

    expect(result.skipped).toBe(false);
    expect(result.resumed).toBe(1);

    await vi.waitFor(() => {
      expect(telegramStart).toHaveBeenCalledWith({
        to: "-100123",
        accountId: "acct-telegram",
        cfg,
        messageThreadId: 42,
      });
    });
    await vi.waitFor(() => {
      expect(telegramStop).toHaveBeenCalledTimes(1);
    });
  });

  it("does not start typing without lifecycle start for resumed runs", async () => {
    const dir = await makeTempStateDir("openclaw-restart-resume-typing-no-start-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };

    await writeRestartSentinel(
      {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        message: "restart",
      },
      env,
    );

    const runId = "run-resume-typing-no-start-1";
    const opts: AgentCommandIngressOpts = {
      message: "original",
      sessionId: "sess-1",
      sessionKey: "main",
      deliver: true,
      channel: "discord",
      to: "channel-1",
      accountId: "acct-discord",
      senderIsOwner: true,
      allowModelOverride: false,
      runId,
    };
    await addInflightAgentRun({ runId, acceptedAt: Date.now(), opts }, env);

    const discordStart = vi.fn(async () => ({
      refresh: async () => undefined,
      stop: vi.fn(),
    }));
    const channelRuntime = {
      telegram: {
        typing: {
          start: vi.fn(async () => ({
            refresh: async () => undefined,
            stop: vi.fn(),
          })),
        },
      },
      discord: { typing: { start: discordStart } },
    } as unknown as NonNullable<
      Parameters<typeof maybeResumeInflightAgentRunsAfterRestart>[0]["channelRuntime"]
    >;

    const runAgentMock = vi.fn(async (_o: AgentCommandIngressOpts) => undefined);
    const cfg: OpenClawConfig = {
      gateway: { restartRecovery: { resumeInflightAgentRuns: true } },
    };

    const result = await maybeResumeInflightAgentRunsAfterRestart({
      cfg,
      deps: {} as unknown as CliDeps,
      runtime: defaultRuntime,
      env,
      getActiveRunCount: () => 0,
      runAgent: runAgentMock as unknown as AgentCommandFromIngress,
      channelRuntime,
    });

    expect(result.skipped).toBe(false);
    expect(result.resumed).toBe(1);
    expect(discordStart).not.toHaveBeenCalled();
  });

  it("stops typing on lifecycle error for resumed discord runs", async () => {
    const dir = await makeTempStateDir("openclaw-restart-resume-typing-discord-error-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };

    await writeRestartSentinel(
      {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        message: "restart",
      },
      env,
    );

    const runId = "run-resume-typing-discord-error-1";
    const opts: AgentCommandIngressOpts = {
      message: "original",
      sessionId: "sess-1",
      sessionKey: "main",
      deliver: true,
      channel: "discord",
      to: "channel-2",
      accountId: "acct-discord",
      senderIsOwner: true,
      allowModelOverride: false,
      runId,
    };
    await addInflightAgentRun({ runId, acceptedAt: Date.now(), opts }, env);

    const discordStop = vi.fn();
    const discordStart = vi.fn(async () => ({
      refresh: async () => undefined,
      stop: discordStop,
    }));
    const channelRuntime = {
      telegram: {
        typing: {
          start: vi.fn(async () => ({
            refresh: async () => undefined,
            stop: vi.fn(),
          })),
        },
      },
      discord: { typing: { start: discordStart } },
    } as unknown as NonNullable<
      Parameters<typeof maybeResumeInflightAgentRunsAfterRestart>[0]["channelRuntime"]
    >;

    const runAgentMock = vi.fn(async (_o: AgentCommandIngressOpts) => {
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start" } });
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "error" } });
    });
    const cfg: OpenClawConfig = {
      gateway: { restartRecovery: { resumeInflightAgentRuns: true } },
    };

    const result = await maybeResumeInflightAgentRunsAfterRestart({
      cfg,
      deps: {} as unknown as CliDeps,
      runtime: defaultRuntime,
      env,
      getActiveRunCount: () => 0,
      runAgent: runAgentMock as unknown as AgentCommandFromIngress,
      channelRuntime,
    });

    expect(result.skipped).toBe(false);
    expect(result.resumed).toBe(1);

    await vi.waitFor(() => {
      expect(discordStart).toHaveBeenCalledWith({
        channelId: "channel-2",
        accountId: "acct-discord",
        cfg,
      });
    });
    await vi.waitFor(() => {
      expect(discordStop).toHaveBeenCalledTimes(1);
    });
  });
});
