import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Model, StreamFn } from "../../llm.js";
import {
  calculateContextTokens,
  compact,
  estimateContextTokens,
  generateProviderStateFallbackSummary,
  generateSummary,
  supportsProviderNativeCompaction,
} from "./compaction.js";
import { createFileOps } from "./utils.js";

describe("supportsProviderNativeCompaction", () => {
  const baseModel: Model = {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    api: "openai-responses",
    provider: "tokenlab",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  };

  it("requires an explicit Responses capability declaration", () => {
    expect(supportsProviderNativeCompaction(baseModel)).toBe(false);
    expect(
      supportsProviderNativeCompaction({
        ...baseModel,
        compat: { supportsResponsesCompaction: true },
      }),
    ).toBe(true);
  });

  it("does not enable the capability for a non-Responses adapter", () => {
    expect(
      supportsProviderNativeCompaction({
        ...baseModel,
        api: "openai-completions",
        compat: { supportsResponsesCompaction: true },
      }),
    ).toBe(false);
  });
});

describe("calculateContextTokens", () => {
  it("prefers the final-iteration context snapshot over aggregate billing usage", () => {
    expect(
      calculateContextTokens({
        input: 12,
        output: 15_104,
        cacheRead: 819_661,
        cacheWrite: 93_130,
        contextUsage: {
          state: "available",
          promptTokens: 148_874,
          totalTokens: 163_978,
        },
        totalTokens: 927_907,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ).toBe(163_978);
  });

  it("preserves the numeric compatibility fallback when the snapshot is unavailable", () => {
    expect(
      calculateContextTokens({
        input: 12,
        output: 15_104,
        cacheRead: 819_661,
        cacheWrite: 93_130,
        contextUsage: { state: "unavailable" },
        totalTokens: 927_907,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ).toBe(927_907);
  });

  it("estimates the transcript instead of using aggregate billing when context is unavailable", () => {
    const estimate = estimateContextTokens([
      { role: "user", content: "hello", timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-fable-5",
        usage: {
          input: 12,
          output: 15_104,
          cacheRead: 819_661,
          cacheWrite: 93_130,
          contextUsage: { state: "unavailable" },
          totalTokens: 927_907,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
    ]);

    expect(estimate.tokens).toBeLessThan(927_907);
    expect(estimate.tokens).toBeGreaterThan(0);
    expect(estimate.usageTokens).toBe(0);
    expect(estimate.lastUsageIndex).toBeNull();
  });

  it("uses the previous exact snapshot and estimates only the unavailable tail", () => {
    const estimate = estimateContextTokens([
      {
        role: "assistant",
        content: [{ type: "text", text: "previous" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-fable-5",
        usage: {
          input: 12,
          output: 1_000,
          cacheRead: 148_862,
          cacheWrite: 0,
          contextUsage: {
            state: "available",
            promptTokens: 148_874,
            totalTokens: 149_874,
          },
          totalTokens: 149_874,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      },
      { role: "user", content: "next", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-fable-5",
        usage: {
          input: 12,
          output: 15_104,
          cacheRead: 819_661,
          cacheWrite: 93_130,
          contextUsage: { state: "unavailable" },
          totalTokens: 927_907,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    ]);

    expect(estimate.usageTokens).toBe(149_874);
    expect(estimate.tokens).toBeGreaterThan(149_874);
    expect(estimate.tokens).toBeLessThan(927_907);
    expect(estimate.lastUsageIndex).toBe(0);
  });
});

describe("generateSummary thinking options", () => {
  it("maps explicit Fable off to low effort for compaction", async () => {
    const model: Model = {
      id: "production-fable",
      name: "Production Fable",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      params: { canonicalModelId: "claude-fable-5" },
    };
    const summaryMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
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
    const streamFn = vi.fn<StreamFn>((_model, context, options) => {
      expect(options?.reasoning).toBe("low");
      expect(context.systemPrompt).toContain("user and an AI assistant");
      expect(context.systemPrompt).not.toContain("AI coding assistant");
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: summaryMessage });
      stream.end();
      return stream;
    });

    const result = await generateSummary(
      [{ role: "user", content: "hello", timestamp: 1 }],
      model,
      1000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "off",
      streamFn,
    );

    expect(result).toEqual({ ok: true, value: "summary" });
    expect(streamFn).toHaveBeenCalledOnce();
  });
});

describe("generateProviderStateFallbackSummary", () => {
  it("asks the owning model to summarize its opaque compacted state", async () => {
    const model: Model = {
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
    };
    const compacted: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [
        {
          type: "providerState",
          state: [{ type: "compaction", encrypted_content: "opaque" }],
          estimatedTokens: 40,
        },
      ],
      usage: {
        input: 100,
        output: 40,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 140,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    const streamFn = vi.fn<StreamFn>((_model, context) => {
      expect(context.messages[0]).toEqual(compacted);
      expect(context.messages[1]).toMatchObject({
        role: "user",
        content: [{ type: "text", text: expect.stringContaining("## Goal") }],
      });
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          ...compacted,
          content: [{ type: "text", text: "portable checkpoint" }],
        },
      });
      stream.end();
      return stream;
    });

    const result = await generateProviderStateFallbackSummary(
      [compacted],
      model,
      1000,
      "test-key",
      undefined,
      undefined,
      "preserve active tasks",
      "high",
      streamFn,
    );

    expect(result).toEqual({ ok: true, value: "portable checkpoint" });
  });
});

describe("split-turn compaction", () => {
  it("serializes history and turn-prefix summaries", async () => {
    const model: Model = {
      id: "summary-model",
      name: "Summary Model",
      api: "test-api",
      provider: "test-provider",
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 8_000,
    };
    let active = 0;
    let maxActive = 0;
    let callCount = 0;
    const streamFn = vi.fn<StreamFn>(() => {
      active++;
      maxActive = Math.max(maxActive, active);
      callCount++;
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        active--;
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: `summary-${callCount}` }],
          api: model.api,
          provider: model.provider,
          model: model.id,
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
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      }, 5);
      return stream;
    });

    const result = await compact(
      {
        firstKeptEntryId: "kept-entry",
        messagesToSummarize: [{ role: "user", content: "history", timestamp: 1 }],
        turnPrefixMessages: [{ role: "user", content: "prefix", timestamp: 2 }],
        isSplitTurn: true,
        tokensBefore: 100,
        fileOps: createFileOps(),
        settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
      },
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
    );

    expect(result.ok).toBe(true);
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });
});
