// Provider adapters test portable fallback for opaque provider state.
import { describe, expect, it } from "vitest";
import type { AssistantMessage, Model } from "../types.js";
import { transformMessages } from "./transform-messages.js";

const source: AssistantMessage = {
  role: "assistant",
  api: "openai-responses",
  provider: "tokenlab",
  model: "gpt-5.6-terra",
  content: [
    {
      type: "providerState",
      state: [{ type: "compaction", encrypted_content: "opaque-state" }],
      fallbackText: "Preserved user request: continue TASK-42",
    },
  ],
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
};

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    api: "openai-responses",
    provider: "tokenlab",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 16_000,
    ...overrides,
  };
}

describe("transformMessages provider state", () => {
  it("preserves opaque state for the same model", () => {
    expect(transformMessages([source], model())).toEqual([source]);
  });

  it("uses portable fallback text after a model switch", () => {
    const [message] = transformMessages(
      [source],
      model({ api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-4-5" }),
    );

    expect(message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Preserved user request: continue TASK-42" }],
    });
  });

  it("refuses an incompatible model switch without a portable checkpoint", () => {
    const modelBound = {
      ...source,
      content: source.content.map((block) =>
        block.type === "providerState" ? { ...block, fallbackText: undefined } : block,
      ),
    };

    expect(() =>
      transformMessages(
        [modelBound],
        model({ api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-4-5" }),
      ),
    ).toThrow(
      "Provider-native compacted state from tokenlab/gpt-5.6-terra cannot be replayed by anthropic/claude-sonnet-4-5",
    );
  });
});
