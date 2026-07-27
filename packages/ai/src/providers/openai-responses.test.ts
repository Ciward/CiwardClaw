import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";

const openAiMockState = vi.hoisted(() => ({
  compactBodies: [] as unknown[],
  configs: [] as unknown[],
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = {
      compact: vi.fn((body: unknown) => {
        openAiMockState.compactBodies.push(body);
        return Promise.resolve({
          id: "cmp_1",
          object: "response.compaction",
          created_at: 1,
          output: [
            {
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: "stale runtime instructions" }],
            },
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "remember TASK-42" }],
            },
            {
              id: "cmp_item_1",
              type: "compaction",
              encrypted_content: "opaque-state",
            },
          ],
          usage: {
            input_tokens: 1200,
            input_tokens_details: { cached_tokens: 200 },
            output_tokens: 80,
            output_tokens_details: { reasoning_tokens: 40 },
            total_tokens: 1280,
          },
        });
      }),
      create: vi.fn(() => {
        throw new Error("stop after constructor");
      }),
    };

    constructor(config: unknown) {
      openAiMockState.configs.push(config);
    }
  },
}));

import { compactOpenAIResponses, streamOpenAIResponses } from "./openai-responses.js";

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
} satisfies Context;

function model(overrides: Partial<Model<"openai-responses">> = {}) {
  return {
    id: "gpt-5.5",
    name: "GPT-5.5",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  } satisfies Model<"openai-responses">;
}

describe("OpenAI Responses provider", () => {
  afterEach(() => {
    openAiMockState.compactBodies = [];
    openAiMockState.configs = [];
    configureAiTransportHost({});
  });

  it("returns provider state that can replace the prior Responses input", async () => {
    const result = await compactOpenAIResponses(
      model(),
      {
        systemPrompt: "Keep exact task identifiers.",
        messages: [
          { role: "user", content: "remember TASK-42", timestamp: 1 },
          {
            role: "assistant",
            api: "openai-responses",
            provider: "openai",
            model: "gpt-5.5",
            content: [],
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 2,
          },
        ],
      },
      {
        apiKey: "sentinel-key",
        customInstructions: "Preserve current task identifiers.",
        promptCacheKey: "session-1",
      },
    );

    expect(openAiMockState.compactBodies).toEqual([
      expect.objectContaining({
        model: "gpt-5.5",
        instructions: expect.stringContaining("Preserve current task identifiers."),
        prompt_cache_key: "session-1",
      }),
    ]);
    expect((openAiMockState.compactBodies[0] as { instructions: string }).instructions).toContain(
      "Prioritize recent conversation state",
    );
    const compactBody = openAiMockState.compactBodies[0] as { input: Array<{ role?: string }> };
    expect(
      compactBody.input.some((item) => item.role === "developer" || item.role === "system"),
    ).toBe(false);
    expect(JSON.stringify(openAiMockState.compactBodies[0])).not.toContain(
      "Keep exact task identifiers.",
    );
    expect(result.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [
          expect.objectContaining({
            type: "providerState",
            state: [
              expect.objectContaining({ role: "user" }),
              expect.objectContaining({
                type: "compaction",
                encrypted_content: "opaque-state",
              }),
            ],
            estimatedTokens: 80,
          }),
        ],
      }),
    ]);
    expect(result.usage).toMatchObject({
      input: 1000,
      output: 80,
      cacheRead: 200,
      totalTokens: 1280,
    });
  });

  it("uses only the stable compact policy when no compact-specific focus is provided", async () => {
    await compactOpenAIResponses(
      model(),
      {
        systemPrompt: "Transient runtime context that will be rebuilt.",
        messages: [{ role: "user", content: "remember TASK-43", timestamp: 1 }],
      },
      { apiKey: "sentinel-key" },
    );

    const body = openAiMockState.compactBodies[0] as { instructions: string };
    expect(body.instructions).toContain("Preserve the user's active request");
    expect(body.instructions).not.toContain("Transient runtime context that will be rebuilt.");
  });

  it("strips replay status without mutating frozen provider state", async () => {
    const frozenState = Object.freeze({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "preserve TASK-44", annotations: [] }],
    });

    await compactOpenAIResponses(
      model(),
      {
        messages: [
          {
            role: "assistant",
            api: "openai-responses",
            provider: "openai",
            model: "gpt-5.5",
            content: [{ type: "providerState", state: [frozenState], estimatedTokens: 12 }],
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
          },
        ],
      },
      { apiKey: "sentinel-key" },
    );

    const body = openAiMockState.compactBodies[0] as {
      input: Array<{ status?: string }>;
    };
    expect(frozenState.status).toBe("completed");
    expect(body.input[0]).not.toHaveProperty("status");
  });

  it("constructs the SDK client with the host guarded fetch", async () => {
    const hostFetch: typeof fetch = async () => new Response(null, { status: 500 });
    configureAiTransportHost({ buildModelFetch: () => hostFetch });

    const result = await streamOpenAIResponses(model(), context, {
      apiKey: "sentinel-key",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(openAiMockState.configs).toHaveLength(1);
    expect((openAiMockState.configs[0] as { fetch?: unknown }).fetch).toBe(hostFetch);
  });

  it("keeps Cloudflare composed upstream auth opaque in SDK headers", async () => {
    const hostFetch: typeof fetch = async () => new Response(null, { status: 500 });
    configureAiTransportHost({ buildModelFetch: () => hostFetch });

    await streamOpenAIResponses(
      model({
        provider: "cloudflare-ai-gateway",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/openai",
      }),
      context,
      { apiKey: "oc-sent-v1-0123456789abcdef01234567" },
    ).result();

    const config = openAiMockState.configs[0] as {
      apiKey?: string;
      defaultHeaders?: Record<string, string | null>;
      fetch?: unknown;
    };
    expect(config.apiKey).toBe("oc-sent-v1-0123456789abcdef01234567");
    expect(config.defaultHeaders?.["cf-aig-authorization"]).toBe(
      "Bearer oc-sent-v1-0123456789abcdef01234567",
    );
    expect(config.fetch).toBe(hostFetch);
  });
});
