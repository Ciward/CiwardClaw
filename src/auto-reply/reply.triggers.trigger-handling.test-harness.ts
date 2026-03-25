import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  getTriggerModelCatalogMocks,
  getTriggerPiEmbeddedMocks,
  getTriggerProviderUsageMocks,
  getTriggerWebSessionMocks,
} from "./reply.triggers.trigger-handling.e2e-mocks.js";

// Avoid exporting vitest mock types (TS2742 under pnpm + d.ts emit).
// oxlint-disable-next-line typescript/no-explicit-any
type AnyMock = any;
// oxlint-disable-next-line typescript/no-explicit-any
type AnyMocks = Record<string, any>;
const piEmbeddedMocks = getTriggerPiEmbeddedMocks();
const providerUsageMocks = getTriggerProviderUsageMocks();
const modelCatalogMocks = getTriggerModelCatalogMocks();
const webSessionMocks = getTriggerWebSessionMocks();

export function getAbortEmbeddedPiRunMock(): AnyMock {
  return piEmbeddedMocks.abortEmbeddedPiRun;
}

export function getCompactEmbeddedPiSessionMock(): AnyMock {
  return piEmbeddedMocks.compactEmbeddedPiSession;
}

export function getRunEmbeddedPiAgentMock(): AnyMock {
  return piEmbeddedMocks.runEmbeddedPiAgent;
}

export function getQueueEmbeddedPiMessageMock(): AnyMock {
  return piEmbeddedMocks.queueEmbeddedPiMessage;
}

export function getProviderUsageMocks(): AnyMocks {
  return providerUsageMocks;
}

export function getModelCatalogMocks(): AnyMocks {
  return modelCatalogMocks;
}

export function getWebSessionMocks(): AnyMocks {
  return webSessionMocks;
}

export const MAIN_SESSION_KEY = "agent:main:main";

type TempHomeEnvSnapshot = {
  home: string | undefined;
  userProfile: string | undefined;
  homeDrive: string | undefined;
  homePath: string | undefined;
  openclawHome: string | undefined;
  stateDir: string | undefined;
};

let suiteTempHomeRoot = "";
let suiteTempHomeId = 0;

function snapshotTempHomeEnv(): TempHomeEnvSnapshot {
  return {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    homeDrive: process.env.HOMEDRIVE,
    homePath: process.env.HOMEPATH,
    openclawHome: process.env.OPENCLAW_HOME,
    stateDir: process.env.OPENCLAW_STATE_DIR,
  };
}

function restoreTempHomeEnv(snapshot: TempHomeEnvSnapshot): void {
  const restoreKey = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  };

  restoreKey("HOME", snapshot.home);
  restoreKey("USERPROFILE", snapshot.userProfile);
  restoreKey("HOMEDRIVE", snapshot.homeDrive);
  restoreKey("HOMEPATH", snapshot.homePath);
  restoreKey("OPENCLAW_HOME", snapshot.openclawHome);
  restoreKey("OPENCLAW_STATE_DIR", snapshot.stateDir);
}

function setTempHomeEnv(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_STATE_DIR = join(home, ".openclaw");

  if (process.platform !== "win32") {
    return;
  }
  const match = home.match(/^([A-Za-z]:)(.*)$/);
  if (!match) {
    return;
  }
  process.env.HOMEDRIVE = match[1];
  process.env.HOMEPATH = match[2] || "\\";
}

beforeAll(async () => {
  suiteTempHomeRoot = await fs.mkdtemp(join(os.tmpdir(), "openclaw-triggers-suite-"));
});

afterAll(async () => {
  if (!suiteTempHomeRoot) {
    return;
  }
  await fs.rm(suiteTempHomeRoot, { recursive: true, force: true }).catch(() => undefined);
  suiteTempHomeRoot = "";
  suiteTempHomeId = 0;
});

export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = join(suiteTempHomeRoot, `case-${++suiteTempHomeId}`);
  const snapshot = snapshotTempHomeEnv();
  await fs.mkdir(join(home, ".openclaw", "agents", "main", "sessions"), { recursive: true });
  setTempHomeEnv(home);

  try {
    // Avoid cross-test leakage if a test doesn't touch these mocks.
    piEmbeddedMocks.runEmbeddedPiAgent.mockClear();
    piEmbeddedMocks.abortEmbeddedPiRun.mockClear();
    piEmbeddedMocks.compactEmbeddedPiSession.mockClear();
    return await fn(home);
  } finally {
    restoreTempHomeEnv(snapshot);
  }
}

export function makeCfg(home: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-5" },
        workspace: join(home, "openclaw"),
        // Test harness: avoid 1s coalescer idle sleeps that dominate trigger suites.
        blockStreamingCoalesce: { idleMs: 1 },
        // Trigger tests assert routing/authorization behavior, not delivery pacing.
        humanDelay: { mode: "off" },
      },
    },
    channels: {
      whatsapp: {
        allowFrom: ["*"],
      },
    },
    messages: {
      queue: {
        debounceMs: 0,
      },
    },
    session: { store: join(home, "sessions.json") },
  } as OpenClawConfig;
}

export async function loadGetReplyFromConfig() {
  return (await import("./reply.js")).getReplyFromConfig;
}

export function installTriggerHandlingReplyHarness(
  setGetReplyFromConfig: (
    getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig,
  ) => void,
): void {
  beforeAll(async () => {
    setGetReplyFromConfig(await loadGetReplyFromConfig());
  });
  installTriggerHandlingE2eTestHooks();
}

export function requireSessionStorePath(cfg: { session?: { store?: string } }): string {
  const storePath = cfg.session?.store;
  if (!storePath) {
    throw new Error("expected session store path");
  }
  return storePath;
}

export async function readSessionStore(cfg: {
  session?: { store?: string };
}): Promise<Record<string, { elevatedLevel?: string }>> {
  const storeRaw = await fs.readFile(requireSessionStorePath(cfg), "utf-8");
  return JSON.parse(storeRaw) as Record<string, { elevatedLevel?: string }>;
}

export function makeWhatsAppElevatedCfg(
  home: string,
  opts?: { elevatedEnabled?: boolean; requireMentionInGroups?: boolean },
): OpenClawConfig {
  const cfg = makeCfg(home);
  cfg.channels ??= {};
  cfg.channels.whatsapp = {
    ...cfg.channels.whatsapp,
    allowFrom: ["+1000"],
  };
  if (opts?.requireMentionInGroups !== undefined) {
    cfg.channels.whatsapp.groups = { "*": { requireMention: opts.requireMentionInGroups } };
  }

  cfg.tools = {
    ...cfg.tools,
    elevated: {
      allowFrom: { whatsapp: ["+1000"] },
      ...(opts?.elevatedEnabled === false ? { enabled: false } : {}),
    },
  };
  return cfg;
}

export async function runDirectElevatedToggleAndLoadStore(params: {
  cfg: OpenClawConfig;
  getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
  body?: string;
}): Promise<{
  text: string | undefined;
  store: Record<string, { elevatedLevel?: string }>;
}> {
  const res = await params.getReplyFromConfig(
    {
      Body: params.body ?? "/elevated on",
      From: "+1000",
      To: "+2000",
      Provider: "whatsapp",
      SenderE164: "+1000",
      CommandAuthorized: true,
    },
    {},
    params.cfg,
  );
  const text = Array.isArray(res) ? res[0]?.text : res?.text;
  const storePath = params.cfg.session?.store;
  if (!storePath) {
    throw new Error("session.store is required in test config");
  }
  const store = await readSessionStore(params.cfg);
  return { text, store };
}

export async function expectInlineCommandHandledAndStripped(params: {
  home: string;
  getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
  body: string;
  stripToken: string;
  blockReplyContains: string;
  requestOverrides?: Record<string, unknown>;
}) {
  const runEmbeddedPiAgentMock = mockRunEmbeddedPiAgentOk();
  runEmbeddedPiAgentMock.mockClear();
  const { blockReplies, handlers } = createBlockReplyCollector();
  const res = await params.getReplyFromConfig(
    {
      Body: params.body,
      From: "+1002",
      To: "+2000",
      CommandAuthorized: true,
      ...params.requestOverrides,
    },
    handlers,
    makeCfg(params.home),
  );

  const text = Array.isArray(res) ? res[0]?.text : res?.text;
  expect(blockReplies.length).toBe(1);
  expect(blockReplies[0]?.text).toContain(params.blockReplyContains);
  expect(runEmbeddedPiAgentMock).toHaveBeenCalled();
  const prompt = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0]?.prompt ?? "";
  expect(prompt).not.toContain(params.stripToken);
  expect(text).toBe("ok");
}

export async function runGreetingPromptForBareNewOrReset(params: {
  home: string;
  body: "/new" | "/reset";
  getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
}) {
  const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
  runEmbeddedPiAgentMock.mockClear();
  runEmbeddedPiAgentMock.mockResolvedValue({
    payloads: [{ text: "hello" }],
    meta: {
      durationMs: 1,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });

  const res = await params.getReplyFromConfig(
    {
      Body: params.body,
      From: "+1003",
      To: "+2000",
      CommandAuthorized: true,
    },
    {},
    makeCfg(params.home),
  );
  const text = Array.isArray(res) ? res[0]?.text : res?.text;
  expect(text).toBe("hello");
  expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
  const prompt = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0]?.prompt ?? "";
  expect(prompt).toContain("A new session was started via /new or /reset");
  expect(prompt).toContain("Run your Session Startup sequence");
}

export function installTriggerHandlingE2eTestHooks() {
  afterEach(() => {
    vi.restoreAllMocks();
  });
}

export function mockRunEmbeddedPiAgentOk(text = "ok"): AnyMock {
  const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
  runEmbeddedPiAgentMock.mockResolvedValue({
    payloads: [{ text }],
    meta: {
      durationMs: 1,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });
  return runEmbeddedPiAgentMock;
}

export function createBlockReplyCollector() {
  const blockReplies: Array<{ text?: string }> = [];
  return {
    blockReplies,
    handlers: {
      onBlockReply: async (payload: { text?: string }) => {
        blockReplies.push(payload);
      },
    },
  };
}
