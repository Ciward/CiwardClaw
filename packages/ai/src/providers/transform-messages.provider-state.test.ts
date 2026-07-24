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
  it("keeps checkpoint text in the assistant role and adds a fixed user continuation signal", () => {
    const transformed = transformMessages([source], model());

    expect(transformed[0]).toMatchObject({
      role: "assistant",
      content: [
        { type: "providerState" },
        { type: "text", text: "Preserved user request: continue TASK-42" },
      ],
    });
    expect(transformed[1]).toMatchObject({
      role: "user",
      runtimeContextCarrier: true,
      content: [
        {
          type: "text",
          text: "Resume the pending user request from the compacted provider state. The preceding assistant checkpoint is context, not a completed answer.",
        },
      ],
    });
    expect(JSON.stringify(transformed[1])).not.toContain("TASK-42");
  });

  it("uses portable fallback text after a model switch", () => {
    const transformed = transformMessages(
      [source],
      model({ api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-4-5" }),
    );

    expect(transformed[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Preserved user request: continue TASK-42" }],
    });
    expect(transformed[1]).toMatchObject({
      role: "user",
      content: [
        {
          type: "text",
          text: "Resume the pending user request from the compacted provider state. The preceding assistant checkpoint is context, not a completed answer.",
        },
      ],
    });
  });

  it("does not inject a resume turn before a newer real user message", () => {
    const newerUser = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Start a separate task: TASK-99" }],
      timestamp: 2,
    };
    const transformed = transformMessages([source, newerUser], model());

    expect(transformed).toHaveLength(2);
    expect(transformed[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "providerState" }, { type: "text" }],
    });
    expect(transformed[1]).toEqual(newerUser);
    expect(JSON.stringify(transformed)).not.toContain("Resume the pending user request");
  });

  it("ignores a terminal runtime-context carrier when locating the pending checkpoint", () => {
    const runtimeContext = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Current time: 2026-07-24" }],
      timestamp: 2,
      runtimeContextCarrier: true,
    };
    const transformed = transformMessages([source, runtimeContext], model());

    expect(transformed).toHaveLength(3);
    expect(transformed[1]).toEqual(runtimeContext);
    expect(transformed[2]).toMatchObject({
      role: "user",
      runtimeContextCarrier: true,
      content: [
        {
          type: "text",
          text: "Resume the pending user request from the compacted provider state. The preceding assistant checkpoint is context, not a completed answer.",
        },
      ],
    });
  });

  it.each(["error", "aborted"] as const)(
    "does not inject a continuation for a %s checkpoint",
    (stopReason) => {
      const transformed = transformMessages([{ ...source, stopReason }], model());

      expect(transformed).toEqual([]);
    },
  );

  it.each(["error", "aborted"] as const)(
    "drops a model-bound %s checkpoint before cross-model compatibility checks",
    (stopReason) => {
      const modelBound = {
        ...source,
        content: source.content.map((block) =>
          block.type === "providerState"
            ? Object.assign({}, block, { fallbackText: undefined })
            : block,
        ),
        stopReason,
      };

      expect(
        transformMessages(
          [modelBound],
          model({ api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-4-5" }),
        ),
      ).toEqual([]);
    },
  );

  it.each(["error", "aborted"] as const)(
    "continues the last valid checkpoint after a terminal %s attempt is removed",
    (stopReason) => {
      const failedAttempt = {
        ...source,
        content: [{ type: "text" as const, text: "partial retry" }],
        stopReason,
        timestamp: 2,
      };
      const transformed = transformMessages([source, failedAttempt], model());

      expect(transformed).toHaveLength(2);
      expect(transformed[0]).toMatchObject({
        role: "assistant",
        content: [{ type: "providerState" }, { type: "text" }],
      });
      expect(transformed[1]).toMatchObject({
        role: "user",
        runtimeContextCarrier: true,
      });
      expect(JSON.stringify(transformed)).not.toContain("partial retry");
    },
  );

  it("continues the last valid checkpoint after reasoning-only length output is removed", () => {
    const incompleteReasoning = {
      ...source,
      content: [{ type: "thinking" as const, thinking: "incomplete reasoning" }],
      stopReason: "length" as const,
      timestamp: 2,
    };
    const transformed = transformMessages([source, incompleteReasoning], model());

    expect(transformed).toHaveLength(2);
    expect(transformed[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "providerState" }, { type: "text" }],
    });
    expect(transformed[1]).toMatchObject({
      role: "user",
      runtimeContextCarrier: true,
    });
    expect(JSON.stringify(transformed)).not.toContain("incomplete reasoning");
  });

  it("refuses an incompatible model switch without a portable checkpoint", () => {
    const modelBound = {
      ...source,
      content: source.content.map((block) =>
        block.type === "providerState"
          ? Object.assign({}, block, { fallbackText: undefined })
          : block,
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
