// Tests status command defaults for thinking and reasoning display.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../agents/fast-mode.js", () => ({
  resolveFastModeState: () => ({ mode: false, enabled: false, source: "default" }),
}));

vi.mock("../../agents/model-auth-label.js", () => ({
  resolveModelAuthLabel: () => "api-key",
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  listSubagentRunsForRequester: () => [],
}));

vi.mock("../../infra/provider-usage.js", () => ({
  resolveUsageProviderId: () => undefined,
  loadProviderUsageSummary: async () => ({
    updatedAt: Date.now(),
    providers: [],
  }),
  formatUsageWindowSummary: () => undefined,
}));

vi.mock("../group-activation.js", () => ({
  normalizeGroupActivation: (value: unknown) => value,
}));

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    getFollowupQueueDepth: () => 0,
    resolveQueueSettings: () => ({ mode: "interrupt" }),
  };
});

const { buildStatusReply } = await import("./commands-status.js");

async function buildKiraStatusReply(cfg: OpenClawConfig) {
  return await buildStatusReply({
    cfg,
    command: {
      isAuthorizedSender: true,
      channel: "whatsapp",
    } as never,
    sessionKey: "agent:kira:main",
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
    defaultGroupActivation: () => "mention",
  });
}

describe("buildStatusReply", () => {
  beforeAll(async () => {
    await buildKiraStatusReply({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
        },
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig);
  });

  it("shows per-agent thinkingDefault in the status card", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
        },
        list: [
          {
            id: "kira",
            model: "openai/gpt-5.4",
            thinkingDefault: "xhigh",
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildKiraStatusReply(cfg);

    expect(reply?.text).toContain("Think: xhigh");
  });

  it("shows xhigh for a configured custom model that supports it", async () => {
    const model = "gpt-5.6-terra";
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      models: {
        providers: {
          tokenlab: {
            baseUrl: "https://tokenlab.example/v1",
            api: "openai-responses",
            models: [
              {
                id: model,
                name: model,
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 272_000,
                maxTokens: 128_000,
                thinkingLevelMap: { xhigh: "xhigh" },
                compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: `tokenlab/${model}`,
        },
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildStatusReply({
      cfg,
      command: {
        isAuthorizedSender: true,
        channel: "whatsapp",
      } as never,
      sessionEntry: {
        sessionId: "terra-xhigh-status",
        updatedAt: 0,
        thinkingLevel: "xhigh",
      },
      sessionKey: "agent:main:main",
      provider: "tokenlab",
      model,
      contextTokens: 0,
      resolvedThinkLevel: "xhigh",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
    });

    expect(reply?.text).toContain("Think: xhigh");
  });

  it("shows per-agent fallback overrides in the status card", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "kira",
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: ["google/gemini-2.5-flash"],
            },
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildKiraStatusReply(cfg);

    expect(reply?.text).toContain("Fallbacks: google/gemini-2.5-flash");
    expect(reply?.text).not.toContain("Fallbacks: anthropic/claude-sonnet-4-6");
  });

  it("keeps default fallback config when the agent has no explicit model", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "kira",
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildKiraStatusReply(cfg);

    expect(reply?.text).toContain("Fallbacks: anthropic/claude-sonnet-4-6");
  });

  it("keeps agent primary strict when the agent has no explicit fallback override", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "kira",
            model: {
              primary: "openai/gpt-5.4",
            },
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildKiraStatusReply(cfg);

    expect(reply?.text).not.toContain("Fallbacks:");
  });

  it("treats an explicit empty per-agent fallback override as disabling inherited fallbacks", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "kira",
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: [],
            },
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildKiraStatusReply(cfg);

    expect(reply?.text).not.toContain("Fallbacks:");
  });
});
