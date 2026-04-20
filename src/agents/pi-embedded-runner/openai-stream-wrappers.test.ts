import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createOpenAIResponsesContextManagementWrapper } from "./openai-stream-wrappers.js";

describe("openai stream wrappers", () => {
  it("adds instructions for custom openai-responses endpoints when missing", () => {
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload = {
        model: (model as { id?: string }).id,
        input: [{ role: "user", content: "hi" }],
        stream: true,
        store: false,
      };
      options?.onPayload?.(payload, model);
      payloads.push(payload);
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenAIResponsesContextManagementWrapper(baseStreamFn, undefined);
    const model = {
      api: "openai-responses",
      provider: "openai-tokenlab",
      id: "gpt-5.2",
      baseUrl: "https://tokenlab.cc.cd/v1",
    } as Model<"openai-responses">;
    const context = {
      messages: [],
      systemPrompt: "You are Ciward's Claw.",
    } as unknown as Context;

    void wrapped(model, context, {});

    expect(payloads).toEqual([
      expect.objectContaining({
        instructions: "You are Ciward's Claw.",
      }),
    ]);
  });

  it("does not override existing instructions for custom openai-responses endpoints", () => {
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload = {
        model: (model as { id?: string }).id,
        input: [{ role: "user", content: "hi" }],
        stream: true,
        store: false,
        instructions: "Existing instructions",
      };
      options?.onPayload?.(payload, model);
      payloads.push(payload);
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenAIResponsesContextManagementWrapper(baseStreamFn, undefined);
    const model = {
      api: "openai-responses",
      provider: "openai-tokenlab",
      id: "gpt-5.2",
      baseUrl: "https://tokenlab.cc.cd/v1",
    } as Model<"openai-responses">;
    const context = {
      messages: [],
      systemPrompt: "You are Ciward's Claw.",
    } as unknown as Context;

    void wrapped(model, context, {});

    expect(payloads).toEqual([
      expect.objectContaining({
        instructions: "Existing instructions",
      }),
    ]);
  });

  it("strips max_output_tokens for custom openai-responses endpoints", () => {
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload = {
        model: (model as { id?: string }).id,
        input: [{ role: "user", content: "hi" }],
        stream: true,
        store: false,
        max_output_tokens: 128,
      };
      options?.onPayload?.(payload, model);
      payloads.push(payload);
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenAIResponsesContextManagementWrapper(baseStreamFn, undefined);
    const model = {
      api: "openai-responses",
      provider: "openai-tokenlab",
      id: "gpt-5.2",
      baseUrl: "https://tokenlab.cc.cd/v1",
    } as Model<"openai-responses">;
    const context = {
      messages: [],
      systemPrompt: "You are Ciward's Claw.",
    } as unknown as Context;

    void wrapped(model, context, {});

    expect(payloads).toEqual([
      expect.not.objectContaining({
        max_output_tokens: expect.anything(),
      }),
    ]);
  });

  it("leaves direct OpenAI responses payloads unchanged", () => {
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload = {
        model: (model as { id?: string }).id,
        input: [{ role: "user", content: "hi" }],
        stream: true,
        store: false,
      };
      options?.onPayload?.(payload, model);
      payloads.push(payload);
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenAIResponsesContextManagementWrapper(baseStreamFn, undefined);
    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5.2",
      baseUrl: "https://api.openai.com/v1",
    } as Model<"openai-responses">;
    const context = {
      messages: [],
      systemPrompt: "You are Ciward's Claw.",
    } as unknown as Context;

    void wrapped(model, context, {});

    expect(payloads).toEqual([
      expect.not.objectContaining({
        instructions: expect.anything(),
      }),
    ]);
  });
});
