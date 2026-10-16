import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../../../packages/agent-core/src/agent.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "../../../llm/types.js";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import { createDeferred } from "../../../test-utils/deferred.js";
import type { StreamFn } from "../../runtime/index.js";
import { wrapStreamFnWithModelRetry } from "./model-stream-retry.js";

const model: Model = {
  id: "gpt-6.1-sol",
  name: "Test model",
  api: "openai-responses",
  provider: "tokenlab",
  baseUrl: "https://example.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1000,
};

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
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
    ...overrides,
  };
}

function response(message: AssistantMessage, events?: AssistantMessageEvent[]) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: assistant() });
    for (const event of events ?? []) {
      stream.push(event);
    }
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } else {
      stream.push({ type: "done", reason: message.stopReason, message });
    }
    stream.end();
  });
  return stream;
}

const overload = () =>
  assistant({
    stopReason: "error",
    errorMessage: "server_error: Our servers are currently overloaded. Please try again later.",
  });

function textDelta(
  text: string,
  partial = assistant({ content: [{ type: "text", text }] }),
): AssistantMessageEvent {
  return { type: "text_delta", contentIndex: 0, delta: text, partial };
}

async function collect(
  stream: Awaited<ReturnType<StreamFn>>,
  onEvent?: (event: AssistantMessageEvent) => void,
) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    onEvent?.(event);
  }
  return { events, message: await stream.result() };
}

describe("model inference retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("continues the same inference after a completed tool without replaying the tool or user", async () => {
    const toolCall = { type: "toolCall" as const, id: "write-1", name: "write", arguments: {} };
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "saved" }],
      details: {},
    }));
    const contexts: Context[] = [];
    const base = vi.fn<StreamFn>((_model, context) => {
      contexts.push({ ...context, messages: context.messages.slice() });
      if (contexts.length === 1) {
        return response(assistant({ stopReason: "toolUse", content: [toolCall] }));
      }
      if (contexts.length === 2) {
        return response(overload());
      }
      return response(assistant({ content: [{ type: "text", text: "Done" }] }));
    });
    const agent = new Agent({
      initialState: {
        model,
        tools: [
          {
            name: "write",
            label: "Write",
            description: "Save",
            parameters: Type.Object({}),
            execute,
          },
        ],
      },
      streamFn: wrapStreamFnWithModelRetry(base),
    });
    const events: string[] = [];
    agent.subscribe((event) => {
      events.push(event.type);
    });
    const run = agent.prompt("Save the file");
    await vi.runAllTimersAsync();
    await run;

    expect(base).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(contexts[2]?.messages).toEqual(contexts[1]?.messages);
    expect(contexts[2]?.messages.at(-1)).toBe(contexts[1]?.messages.at(-1));
    expect(contexts[2]?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(agent.state.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(events.filter((event) => event === "agent_end")).toHaveLength(1);
    expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: "stop" });
  });

  it("uses five reconnects with Codex exponential backoff and surfaces only the exhausted error", async () => {
    const base = vi.fn<StreamFn>(() => response(overload()));
    const onRetry = vi.fn();
    const stream = await wrapStreamFnWithModelRetry(base, onRetry)(model, { messages: [] });
    const result = collect(stream);
    await vi.runAllTimersAsync();
    const { events, message } = await result;
    expect(base).toHaveBeenCalledTimes(6);
    expect(onRetry.mock.calls.map(([retry]) => retry.delayMs)).toEqual([200, 400, 800, 1600, 3200]);
    expect(onRetry.mock.calls.map(([retry]) => retry.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(onRetry.mock.calls.map(([retry]) => retry.maxAttempts)).toEqual([5, 5, 5, 5, 5]);
    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(message.stopReason).toBe("error");
    expect(message.content).toEqual([
      { type: "text", text: "[assistant turn failed before producing content]" },
    ]);
    expect(base.mock.calls[0]?.[2]?.maxRetries).toBe(4);
  });

  it.each([
    "401 invalid API key; please retry your request",
    "402 insufficient balance; please retry your request",
    "429 insufficient_quota",
    "Monthly usage limit reached",
    "400 context_length_exceeded; please retry your request",
    "400 invalid request",
  ])("does not reconnect permanent failures: %s", async (errorMessage) => {
    const base = vi.fn<StreamFn>(() => response(assistant({ stopReason: "error", errorMessage })));
    const result = await collect(await wrapStreamFnWithModelRetry(base)(model, { messages: [] }));
    expect(base).toHaveBeenCalledTimes(1);
    expect(result.message.errorMessage).toBe(errorMessage);
  });

  it("honors a provider retry delay and preserves an explicit request retry budget", async () => {
    const onRetry = vi.fn();
    const base = vi
      .fn<StreamFn>()
      .mockImplementationOnce(() =>
        response(
          assistant({
            stopReason: "error",
            errorMessage: "429 rate_limit_exceeded: Please try again in 1.5s",
          }),
        ),
      )
      .mockImplementation(() => response(assistant()));
    const result = collect(
      await wrapStreamFnWithModelRetry(base, onRetry)(model, { messages: [] }, { maxRetries: 1 }),
    );
    await vi.runAllTimersAsync();
    expect((await result).message.stopReason).toBe("stop");
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 1500 }));
    expect(base.mock.calls[1]?.[2]?.maxRetries).toBe(1);
  });

  it("respects the existing cap for a long provider-requested delay", async () => {
    const base = vi.fn<StreamFn>(() =>
      response(
        assistant({ stopReason: "error", errorMessage: "429 rate limit; retry after: 120s" }),
      ),
    );
    await collect(
      await wrapStreamFnWithModelRetry(base)(model, { messages: [] }, { maxRetryDelayMs: 60_000 }),
    );
    expect(base).toHaveBeenCalledTimes(1);
  });

  it.each([
    { headers: { "retry-after-ms": "1200" } as Record<string, string>, delayMs: 1200 },
    { headers: { "retry-after": "2" } as Record<string, string>, delayMs: 2000 },
  ])(
    "uses Retry-After headers and preserves response hooks: $headers",
    async ({ headers, delayMs }) => {
      const onRetry = vi.fn();
      const onResponse = vi.fn();
      const base = vi.fn<StreamFn>().mockImplementation(async (_model, _context, options) => {
        await options?.onResponse?.({ status: 200, headers }, model);
        return response(base.mock.calls.length === 1 ? overload() : assistant());
      });
      const result = collect(
        await wrapStreamFnWithModelRetry(base, onRetry)(model, { messages: [] }, { onResponse }),
      );
      await vi.runAllTimersAsync();
      expect((await result).message.stopReason).toBe("stop");
      expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ delayMs }));
      expect(onResponse).toHaveBeenCalledTimes(2);
    },
  );

  it("applies symmetric jitter to reconnect backoff", async () => {
    vi.mocked(Math.random).mockReturnValueOnce(0).mockReturnValueOnce(1);
    const onRetry = vi.fn();
    const base = vi
      .fn<StreamFn>()
      .mockImplementation(() => response(base.mock.calls.length <= 2 ? overload() : assistant()));
    const result = collect(
      await wrapStreamFnWithModelRetry(base, onRetry)(model, { messages: [] }),
    );
    await vi.runAllTimersAsync();
    await result;
    expect(onRetry.mock.calls.map(([retry]) => retry.delayMs)).toEqual([180, 440]);
  });

  it("lets cancellation interrupt backoff without another request", async () => {
    const abort = new AbortController();
    const base = vi.fn<StreamFn>(() => response(overload()));
    const onRetry = vi.fn(() => {
      abort.abort();
    });
    const result = await collect(
      await wrapStreamFnWithModelRetry(base, onRetry)(
        model,
        { messages: [] },
        { signal: abort.signal },
      ),
    );
    expect(base).toHaveBeenCalledTimes(1);
    expect(result.message.stopReason).toBe("aborted");
    expect(result.events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
  });

  it.each(["text", "thinking", "toolcall"] as const)(
    "discards buffered %s output before reconnecting",
    async (kind) => {
      const partial = assistant({ content: [{ type: "text", text: "partial" }] });
      const event = {
        type: `${kind}_delta`,
        contentIndex: 0,
        delta: "partial",
        partial,
      } as AssistantMessageEvent;
      const base = vi
        .fn<StreamFn>()
        .mockImplementationOnce(() => response(overload(), [event]))
        .mockImplementationOnce(() => response(assistant()));
      const result = collect(await wrapStreamFnWithModelRetry(base)(model, { messages: [] }));
      await vi.runAllTimersAsync();
      const collected = await result;
      expect(base).toHaveBeenCalledTimes(2);
      expect(collected.events.map((entry) => entry.type)).toEqual(["start", "done"]);
    },
  );

  it("recovers at both buffer limits and resets the budgets before each reconnect", async () => {
    const events = [textDelta("first"), textDelta("second")];
    const start: AssistantMessageEvent = { type: "start", partial: assistant() };
    const limits = {
      maxEvents: events.length + 1,
      maxBytes: [start, ...events].reduce(
        (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)),
        0,
      ),
    };
    const base = vi
      .fn<StreamFn>()
      .mockImplementation(() =>
        response(base.mock.calls.length <= 2 ? overload() : assistant(), events),
      );
    const result = collect(
      await wrapStreamFnWithModelRetry(base, undefined, undefined, limits)(model, { messages: [] }),
    );

    await vi.runAllTimersAsync();
    const collected = await result;

    expect(base).toHaveBeenCalledTimes(3);
    expect(collected.events.map((event) => event.type)).toEqual([
      "start",
      "text_delta",
      "text_delta",
      "done",
    ]);
    expect(collected.message.stopReason).toBe("stop");
  });

  it.each([
    {
      limit: "event count",
      limits: { maxEvents: 3, maxBytes: 1024 * 1024 },
      eventCount: 1000,
      snapshot: "x",
    },
    {
      limit: "full snapshot bytes",
      limits: { maxEvents: 1000, maxBytes: 24 * 1024 },
      eventCount: 4,
      snapshot: "界".repeat(4096),
    },
  ])(
    "streams long output before completion after exceeding $limit and finishes once",
    async ({ limits, eventCount, snapshot }) => {
      const source = createAssistantMessageEventStream();
      const base = vi.fn<StreamFn>(() => source);
      const delivered = createDeferred();
      const start: AssistantMessageEvent = { type: "start", partial: assistant() };
      const events = Array.from({ length: eventCount }, () =>
        textDelta(".", assistant({ content: [{ type: "text", text: snapshot }] })),
      );
      const final = assistant({ content: [{ type: "text", text: snapshot }] });
      const terminal: AssistantMessageEvent = { type: "done", reason: "stop", message: final };
      const wrapped = wrapStreamFnWithModelRetry(base, undefined, undefined, limits);
      const result = collect(await wrapped(model, { messages: [] }), (event) => {
        if (event === events.at(-1)) {
          delivered.resolve();
        }
      });
      source.push(start);
      for (const event of events) {
        source.push(event);
      }
      // No terminal event exists yet: delivery proves the buffer has committed
      // and subsequent events are passed through rather than held for success.
      await delivered.promise;
      source.push(terminal);
      source.end();
      const collected = await result;

      expect(base).toHaveBeenCalledTimes(1);
      expect(collected.events).toEqual([start, ...events, terminal]);
      expect(collected.message).toBe(final);
    },
  );

  it.each(["terminal error", "iterator failure"] as const)(
    "does not reconnect a committed inference after a retryable %s",
    async (failure) => {
      const event = textDelta("Already shown");
      const base = vi.fn<StreamFn>(() => {
        if (failure === "terminal error") {
          return response(overload(), [event]);
        }
        const source = createAssistantMessageEventStream();
        source[Symbol.asyncIterator] = async function* () {
          yield { type: "start", partial: assistant() };
          yield event;
          throw new Error("fetch failed");
        };
        return source;
      });
      const onRetry = vi.fn();
      const result = await collect(
        await wrapStreamFnWithModelRetry(base, onRetry, undefined, {
          maxEvents: 1,
          maxBytes: 1024 * 1024,
        })(model, { messages: [] }),
      );

      expect(base).toHaveBeenCalledTimes(1);
      expect(onRetry).not.toHaveBeenCalled();
      expect(result.events.map((entry) => entry.type)).toEqual(["start", "text_delta", "error"]);
      expect(result.message.stopReason).toBe("error");
    },
  );

  it.each([1, 3])("flushes aborted output once with an event budget of %s", async (maxEvents) => {
    const abort = new AbortController();
    const closed = vi.fn();
    const base = vi.fn<StreamFn>(() => {
      const source = createAssistantMessageEventStream();
      source[Symbol.asyncIterator] = async function* () {
        try {
          yield { type: "start", partial: assistant() };
          yield textDelta("partial");
          abort.abort();
          throw new Error("fetch failed");
        } finally {
          closed();
        }
      };
      return source;
    });
    const result = await collect(
      await wrapStreamFnWithModelRetry(base, undefined, undefined, {
        maxEvents,
        maxBytes: 1024 * 1024,
      })(model, { messages: [] }, { signal: abort.signal }),
    );

    expect(base).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(result.events.map((event) => event.type)).toEqual(["start", "text_delta", "error"]);
    expect(result.events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(result.message.stopReason).toBe("aborted");
  });

  it("flushes buffered updates for a non-retryable terminal error", async () => {
    const event = {
      type: "text_delta" as const,
      contentIndex: 0,
      delta: "partial",
      partial: assistant({ content: [{ type: "text", text: "partial" }] }),
    };
    const base = vi.fn<StreamFn>(() =>
      response(assistant({ stopReason: "error", errorMessage: "400 invalid request" }), [event]),
    );
    const result = await collect(await wrapStreamFnWithModelRetry(base)(model, { messages: [] }));
    expect(base).toHaveBeenCalledTimes(1);
    expect(result.events.map((entry) => entry.type)).toEqual(["start", "text_delta", "error"]);
  });

  it("retries rejected stream creation and closes a failed iterator before reconnecting", async () => {
    const closed = vi.fn();
    const base = vi
      .fn<StreamFn>()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockImplementationOnce(() => {
        const stream = response(overload());
        const original = stream[Symbol.asyncIterator].bind(stream);
        stream[Symbol.asyncIterator] = async function* () {
          try {
            yield* { [Symbol.asyncIterator]: original };
          } finally {
            closed();
          }
        };
        return stream;
      })
      .mockImplementation(() => response(assistant()));
    const result = collect(await wrapStreamFnWithModelRetry(base)(model, { messages: [] }));
    await vi.runAllTimersAsync();
    expect((await result).message.stopReason).toBe("stop");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(base).toHaveBeenCalledTimes(3);
  });

  it("preserves partial output on an iterator failure and does not reconnect it", async () => {
    const partial = assistant({ content: [{ type: "text", text: "Already shown" }] });
    const base = vi.fn<StreamFn>(() => {
      const stream = createAssistantMessageEventStream();
      stream[Symbol.asyncIterator] = async function* () {
        yield { type: "start", partial: assistant() };
        yield { type: "text_delta", contentIndex: 0, delta: "Already shown", partial };
        throw new Error("fetch failed");
      };
      return stream;
    });
    const result = await collect(await wrapStreamFnWithModelRetry(base)(model, { messages: [] }));
    expect(base).toHaveBeenCalledTimes(1);
    expect(result.message).toMatchObject({
      content: partial.content,
      stopReason: "error",
      errorMessage: "fetch failed",
    });
  });

  it("keeps the non-empty error sentinel when only the stream start was received", async () => {
    const base = vi.fn<StreamFn>(() => {
      const stream = createAssistantMessageEventStream();
      stream[Symbol.asyncIterator] = async function* () {
        yield { type: "start", partial: assistant() };
        throw new Error("invalid request format");
      };
      return stream;
    });

    const result = await collect(await wrapStreamFnWithModelRetry(base)(model, { messages: [] }));

    expect(base).toHaveBeenCalledTimes(1);
    expect(result.message).toMatchObject({
      content: [{ type: "text", text: "[assistant turn failed before producing content]" }],
      stopReason: "error",
      errorMessage: "invalid request format",
    });
  });
});
