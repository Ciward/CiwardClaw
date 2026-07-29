import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearAgentHarnesses,
  listRegisteredAgentHarnesses,
  registerAgentHarness,
  restoreRegisteredAgentHarnesses,
} from "./harness/registry.js";
import type { AgentHarness } from "./harness/types.js";
import { resolveCandidateThinkingLevel, resolveEffectiveAgentRuntime } from "./thinking-runtime.js";

function openAIConfig(runtime: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        models: {
          "openai/gpt-5.6-luna": { agentRuntime: { id: runtime } },
        },
      },
    },
  };
}

describe("resolveEffectiveAgentRuntime", () => {
  let registeredHarnesses: ReturnType<typeof listRegisteredAgentHarnesses>;

  beforeAll(() => {
    registeredHarnesses = listRegisteredAgentHarnesses();
  });

  beforeEach(() => {
    clearAgentHarnesses();
  });

  afterAll(() => {
    restoreRegisteredAgentHarnesses(registeredHarnesses);
  });

  it("keeps cold-start official OpenAI Luna on implicit Codex policy", () => {
    expect(
      resolveEffectiveAgentRuntime({
        cfg: {},
        provider: "openai",
        modelId: "gpt-5.6-luna",
      }),
    ).toBe("codex");
  });

  it("resolves residual auto to OpenClaw when no plugin harness is registered", () => {
    expect(
      resolveEffectiveAgentRuntime({
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "http://127.0.0.1:8080/v1",
                models: [],
              },
            },
          },
        },
        provider: "openai",
        modelId: "gpt-5.6-luna",
      }),
    ).toBe("openclaw");
  });

  it("resolves residual auto through a registered Codex harness", () => {
    const supports = vi.fn<AgentHarness["supports"]>(({ provider }) =>
      provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
    );
    const codexHarness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports,
      runAttempt: async () => {
        throw new Error("not exercised");
      },
    };
    registerAgentHarness(codexHarness);

    expect(
      resolveEffectiveAgentRuntime({
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "http://127.0.0.1:8080/v1",
                models: [],
              },
            },
          },
        },
        provider: "openai",
        modelId: "gpt-5.6-luna",
      }),
    ).toBe("codex");
    expect(supports).toHaveBeenCalledWith(
      expect.not.objectContaining({
        providerOwnerStatus: expect.anything(),
        providerOwnerPluginIds: expect.anything(),
      }),
    );
  });

  it("prefers explicit session overrides and treats legacy harness ids as observational", () => {
    const cfg = openAIConfig("openclaw");
    expect(
      resolveEffectiveAgentRuntime({
        cfg,
        provider: "openai",
        modelId: "gpt-5.6-luna",
        sessionEntry: { agentRuntimeOverride: "codex", agentHarnessId: "openclaw" },
      }),
    ).toBe("codex");
    expect(
      resolveEffectiveAgentRuntime({
        cfg,
        provider: "openai",
        modelId: "gpt-5.6-luna",
        sessionEntry: { agentHarnessId: "codex" },
      }),
    ).toBe("openclaw");
    expect(
      resolveEffectiveAgentRuntime({
        cfg,
        provider: "openai",
        modelId: "gpt-5.6-luna",
      }),
    ).toBe("openclaw");
  });

  it("lets an explicit OpenClaw override replace configured Codex policy", () => {
    expect(
      resolveEffectiveAgentRuntime({
        cfg: openAIConfig("codex"),
        provider: "openai",
        modelId: "gpt-5.6-luna",
        sessionEntry: { agentRuntimeOverride: "openclaw", agentHarnessId: "codex" },
      }),
    ).toBe("openclaw");
  });

  it("keeps a supported candidate level unchanged", () => {
    expect(
      resolveCandidateThinkingLevel({
        cfg: {},
        provider: "demo",
        modelId: "demo-model",
        level: "medium",
      }),
    ).toBe("medium");
  });

  it("uses configured custom-model capabilities when callers omit a catalog", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          tokenlab: {
            baseUrl: "https://tokenlab.example/v1",
            models: [
              {
                id: "gpt-5.6-terra",
                name: "GPT-5.6 Terra",
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 272_000,
                maxTokens: 128_000,
                reasoning: true,
                compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
                thinkingLevelMap: { xhigh: "xhigh" },
              },
              {
                id: "gpt-5.6-luna",
                name: "GPT-5.6 Luna",
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 272_000,
                maxTokens: 128_000,
                reasoning: true,
                compat: { supportedReasoningEfforts: ["low", "medium", "high", "max"] },
                thinkingLevelMap: { max: "max" },
              },
            ],
          },
        },
      },
    };

    expect(
      resolveCandidateThinkingLevel({
        cfg,
        provider: "tokenlab",
        modelId: "gpt-5.6-terra",
        level: "xhigh",
        agentRuntime: "openclaw",
      }),
    ).toBe("xhigh");
    expect(
      resolveCandidateThinkingLevel({
        cfg,
        provider: "tokenlab",
        modelId: "gpt-5.6-luna",
        level: "max",
        agentRuntime: "openclaw",
      }),
    ).toBe("max");
  });

  it("clamps an unsupported candidate level without changing the requested value", () => {
    const requested = "ultra" as const;

    expect(
      resolveCandidateThinkingLevel({
        cfg: {},
        provider: "demo",
        modelId: "demo-model",
        level: requested,
      }),
    ).toBe("high");
    expect(requested).toBe("ultra");
  });

  it("re-evaluates every candidate from the immutable request so later support can upgrade", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
            "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
          },
        },
      },
    };
    const requested = "ultra" as const;

    expect(
      resolveCandidateThinkingLevel({
        cfg,
        provider: "openai",
        modelId: "gpt-5.6-luna",
        level: requested,
      }),
    ).toBe("max");
    expect(
      resolveCandidateThinkingLevel({
        cfg,
        provider: "openai",
        modelId: "gpt-5.6-sol",
        level: requested,
      }),
    ).toBe("ultra");
  });
});
