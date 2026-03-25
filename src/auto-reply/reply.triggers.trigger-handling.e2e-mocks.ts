import { vi } from "vitest";

const piEmbeddedMocks = vi.hoisted(() => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  compactEmbeddedPiSession: vi.fn(),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

export function getTriggerPiEmbeddedMocks() {
  return piEmbeddedMocks;
}

function createPiEmbeddedMockModule() {
  return {
    abortEmbeddedPiRun: piEmbeddedMocks.abortEmbeddedPiRun,
    compactEmbeddedPiSession: piEmbeddedMocks.compactEmbeddedPiSession,
    runEmbeddedPiAgent: piEmbeddedMocks.runEmbeddedPiAgent,
    queueEmbeddedPiMessage: piEmbeddedMocks.queueEmbeddedPiMessage,
    resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
    isEmbeddedPiRunActive: piEmbeddedMocks.isEmbeddedPiRunActive,
    isEmbeddedPiRunStreaming: piEmbeddedMocks.isEmbeddedPiRunStreaming,
  };
}

function createPiEmbeddedRunnerMockModule() {
  return {
    abortEmbeddedPiRun: piEmbeddedMocks.abortEmbeddedPiRun,
    compactEmbeddedPiSession: piEmbeddedMocks.compactEmbeddedPiSession,
    runEmbeddedPiAgent: piEmbeddedMocks.runEmbeddedPiAgent,
    queueEmbeddedPiMessage: piEmbeddedMocks.queueEmbeddedPiMessage,
    resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
    isEmbeddedPiRunActive: piEmbeddedMocks.isEmbeddedPiRunActive,
    isEmbeddedPiRunStreaming: piEmbeddedMocks.isEmbeddedPiRunStreaming,
    waitForEmbeddedPiRunEnd: vi.fn().mockResolvedValue(true),
  };
}

function createPiEmbeddedRunnerRunMockModule() {
  return {
    runEmbeddedPiAgent: piEmbeddedMocks.runEmbeddedPiAgent,
  };
}

function createPiEmbeddedRunnerRunsMockModule() {
  return {
    abortEmbeddedPiRun: piEmbeddedMocks.abortEmbeddedPiRun,
    queueEmbeddedPiMessage: piEmbeddedMocks.queueEmbeddedPiMessage,
    resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
    isEmbeddedPiRunActive: piEmbeddedMocks.isEmbeddedPiRunActive,
    isEmbeddedPiRunStreaming: piEmbeddedMocks.isEmbeddedPiRunStreaming,
    waitForEmbeddedPiRunEnd: vi.fn().mockResolvedValue(true),
  };
}

function createPiEmbeddedRunnerCompactMockModule() {
  return {
    compactEmbeddedPiSession: piEmbeddedMocks.compactEmbeddedPiSession,
  };
}

// Cover both relative and root-absolute module ids used by Vitest transforms.
vi.mock("../agents/pi-embedded.js", createPiEmbeddedMockModule);
vi.mock("../agents/pi-embedded.ts", createPiEmbeddedMockModule);
vi.mock("/src/agents/pi-embedded.js", createPiEmbeddedMockModule);
vi.mock("/src/agents/pi-embedded.ts", createPiEmbeddedMockModule);
vi.mock("../agents/pi-embedded-runner.js", createPiEmbeddedRunnerMockModule);
vi.mock("../agents/pi-embedded-runner.ts", createPiEmbeddedRunnerMockModule);
vi.mock("/src/agents/pi-embedded-runner.js", createPiEmbeddedRunnerMockModule);
vi.mock("/src/agents/pi-embedded-runner.ts", createPiEmbeddedRunnerMockModule);
vi.mock("../agents/pi-embedded-runner/run.js", createPiEmbeddedRunnerRunMockModule);
vi.mock("../agents/pi-embedded-runner/run.ts", createPiEmbeddedRunnerRunMockModule);
vi.mock("/src/agents/pi-embedded-runner/run.js", createPiEmbeddedRunnerRunMockModule);
vi.mock("/src/agents/pi-embedded-runner/run.ts", createPiEmbeddedRunnerRunMockModule);
vi.mock("../agents/pi-embedded-runner/runs.js", createPiEmbeddedRunnerRunsMockModule);
vi.mock("../agents/pi-embedded-runner/runs.ts", createPiEmbeddedRunnerRunsMockModule);
vi.mock("/src/agents/pi-embedded-runner/runs.js", createPiEmbeddedRunnerRunsMockModule);
vi.mock("/src/agents/pi-embedded-runner/runs.ts", createPiEmbeddedRunnerRunsMockModule);
vi.mock("../agents/pi-embedded-runner/compact.js", createPiEmbeddedRunnerCompactMockModule);
vi.mock("../agents/pi-embedded-runner/compact.ts", createPiEmbeddedRunnerCompactMockModule);
vi.mock("/src/agents/pi-embedded-runner/compact.js", createPiEmbeddedRunnerCompactMockModule);
vi.mock("/src/agents/pi-embedded-runner/compact.ts", createPiEmbeddedRunnerCompactMockModule);

const providerUsageMocks = vi.hoisted(() => ({
  loadProviderUsageSummary: vi.fn().mockResolvedValue({
    updatedAt: 0,
    providers: [],
  }),
  formatUsageSummaryLine: vi.fn().mockReturnValue("📊 Usage: Claude 80% left"),
  formatUsageWindowSummary: vi.fn().mockReturnValue("Claude 80% left"),
  resolveUsageProviderId: vi.fn((provider: string) => provider.split("/")[0]),
}));

export function getTriggerProviderUsageMocks() {
  return providerUsageMocks;
}

vi.mock("../infra/provider-usage.js", () => providerUsageMocks);
vi.mock("../infra/provider-usage.ts", () => providerUsageMocks);
vi.mock("/src/infra/provider-usage.js", () => providerUsageMocks);
vi.mock("/src/infra/provider-usage.ts", () => providerUsageMocks);

const modelCatalogMocks = vi.hoisted(() => ({
  loadModelCatalog: vi.fn().mockResolvedValue([
    {
      provider: "anthropic",
      id: "claude-opus-4-5",
      name: "Claude Opus 4.5",
      contextWindow: 200000,
    },
    {
      provider: "openrouter",
      id: "anthropic/claude-opus-4-5",
      name: "Claude Opus 4.5 (OpenRouter)",
      contextWindow: 200000,
    },
    { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 mini" },
    { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
    { provider: "openai-codex", id: "gpt-5.2", name: "GPT-5.2 (Codex)" },
    { provider: "minimax", id: "MiniMax-M2.7", name: "MiniMax M2.7" },
  ]),
  resetModelCatalogCacheForTest: vi.fn(),
}));

export function getTriggerModelCatalogMocks() {
  return modelCatalogMocks;
}

vi.mock("../agents/model-catalog.js", () => modelCatalogMocks);
vi.mock("../agents/model-catalog.ts", () => modelCatalogMocks);
vi.mock("/src/agents/model-catalog.js", () => modelCatalogMocks);
vi.mock("/src/agents/model-catalog.ts", () => modelCatalogMocks);

const webSessionMocks = vi.hoisted(() => ({
  webAuthExists: vi.fn().mockResolvedValue(true),
  getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
}));

export function getTriggerWebSessionMocks() {
  return webSessionMocks;
}

// Cover both legacy extension entrypoints and current runtime boundary imports.
vi.mock("../../extensions/whatsapp/runtime-api.js", () => webSessionMocks);
vi.mock("../../extensions/whatsapp/runtime-api.ts", () => webSessionMocks);
vi.mock("../../extensions/whatsapp/src/session.js", () => webSessionMocks);
vi.mock("../../extensions/whatsapp/src/session.ts", () => webSessionMocks);
vi.mock("../plugins/runtime/runtime-whatsapp-boundary.js", () => webSessionMocks);
vi.mock("../plugins/runtime/runtime-whatsapp-boundary.ts", () => webSessionMocks);
vi.mock("/extensions/whatsapp/runtime-api.js", () => webSessionMocks);
vi.mock("/extensions/whatsapp/runtime-api.ts", () => webSessionMocks);
vi.mock("/extensions/whatsapp/src/session.js", () => webSessionMocks);
vi.mock("/extensions/whatsapp/src/session.ts", () => webSessionMocks);
vi.mock("/src/plugins/runtime/runtime-whatsapp-boundary.js", () => webSessionMocks);
vi.mock("/src/plugins/runtime/runtime-whatsapp-boundary.ts", () => webSessionMocks);
