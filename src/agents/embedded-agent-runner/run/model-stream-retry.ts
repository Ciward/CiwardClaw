/** Retries transient inference failures before any stream output is committed. */
import { isContextOverflow } from "@openclaw/ai/internal/runtime";
import { sleepWithAbort } from "../../../infra/backoff.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { AssistantMessage, AssistantMessageEvent } from "../../../llm/types.js";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import {
  isNonRetryableProviderLimitError,
  isRetryableAssistantError,
} from "../../../llm/utils/retry.js";
import { MAX_TIMER_TIMEOUT_MS } from "../../../shared/number-coercion.js";
import {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isPeriodicUsageLimitErrorMessage,
} from "../../embedded-agent-helpers/failover-matches.js";
import type { StreamFn } from "../../runtime/index.js";
import { buildStreamErrorAssistantMessage } from "../../stream-message-shared.js";
import { abortable } from "./abortable.js";

// Keep SDK request retries separate from same-model stream reconnects.
const REQUEST_MAX_RETRIES = 4;
const STREAM_MAX_RETRIES = 10;
const RETRY_INITIAL_DELAY_MS = 200;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
// Cap the exponent before computing it so long waits never overflow into an immediate timer.
const MAX_RETRY_BACKOFF_EXPONENT = Math.ceil(
  Math.log2(MAX_TIMER_TIMEOUT_MS / RETRY_INITIAL_DELAY_MS),
);
const RETRY_AFTER_RE =
  /\b(?:retry[- ]after|try again in)\b\s*:?\s*(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|s|minutes?|m)?/i;

type ModelStreamRetryNotice = {
  attempt: number;
  maxAttempts?: number;
  delayMs: number;
};

type ModelStreamRetryOptions = {
  onRetry?: (retry: ModelStreamRetryNotice) => void;
  providerRetries?: number;
  bufferLimits?: { maxEvents: number; maxBytes: number };
  overloadRetryUntil?: () => number;
};

function resolveHeaderDelayMs(headers: Record<string, string>): number | undefined {
  const milliseconds = headers["retry-after-ms"];
  if (milliseconds?.trim() && Number.isFinite(Number(milliseconds))) {
    return Math.max(0, Number(milliseconds));
  }
  const value = headers["retry-after"]?.trim();
  if (!value) {
    return undefined;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.max(0, numeric * 1000);
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function resolveRequestedDelayMs(message: string): number | undefined {
  const match = RETRY_AFTER_RE.exec(message);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier =
    unit === "ms" || unit?.startsWith("millisecond") ? 1 : unit?.startsWith("m") ? 60_000 : 1000;
  const delayMs = value * multiplier;
  return Number.isFinite(delayMs) ? delayMs : undefined;
}

function isRetryableModelError(message: AssistantMessage, contextWindow: number): boolean {
  const text = message.errorMessage ?? "";
  return (
    message.stopReason === "error" &&
    !isNonRetryableProviderLimitError(text) &&
    (isRetryableAssistantError(message) || isOverloadedErrorMessage(text)) &&
    !isContextOverflow(message, contextWindow) &&
    !isAuthErrorMessage(text) &&
    !isBillingErrorMessage(text) &&
    !isPeriodicUsageLimitErrorMessage(text)
  );
}

function ensureNonEmptyErrorContent(message: AssistantMessage, model: Parameters<StreamFn>[0]) {
  if (message.stopReason !== "error" || message.content.length > 0) {
    return message;
  }
  const fallback = buildStreamErrorAssistantMessage({
    model: { api: model.api, provider: model.provider, id: model.id },
    errorMessage: message.errorMessage ?? "LLM request failed.",
  });
  return { ...fallback, usage: message.usage, timestamp: message.timestamp };
}

/**
 * Retry one inference using the same input and completed tool results. Session
 * auto-retry stays disabled; re-entering the agent loop can repeat tool effects.
 */
export function wrapStreamFnWithModelRetry(
  baseFn: StreamFn,
  {
    onRetry,
    providerRetries,
    bufferLimits = { maxEvents: 1024, maxBytes: 8 * 1024 * 1024 },
    overloadRetryUntil,
  }: ModelStreamRetryOptions = {},
): StreamFn {
  return (model, context, options) => {
    const outer = createAssistantMessageEventStream();
    const requestOptions = {
      ...options,
      maxRetries: options?.maxRetries ?? providerRetries ?? REQUEST_MAX_RETRIES,
    };
    const signal = requestOptions.signal;
    const maxRetryDelayMs = requestOptions.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    const errorMessage = (error: unknown): AssistantMessage => ({
      ...buildStreamErrorAssistantMessage({ model, errorMessage: formatErrorMessage(error) }),
      ...(signal?.aborted ? { stopReason: "aborted", errorMessage: "Request was aborted" } : {}),
    });
    const bufferedEvents: AssistantMessageEvent[] = [];
    let bufferedBytes = 0;
    let committed = false;
    const flushBufferedEvents = () => {
      for (const event of bufferedEvents) {
        outer.push(event);
      }
      bufferedEvents.length = 0;
      bufferedBytes = 0;
    };
    const finish = (message: AssistantMessage) => {
      flushBufferedEvents();
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        outer.push({ type: "error", reason: message.stopReason, error: message });
      } else {
        outer.push({ type: "done", reason: message.stopReason, message });
      }
      outer.end();
    };

    void (async () => {
      for (let retries = 0; ; retries += 1) {
        let partial: AssistantMessage | undefined;
        let headerDelayMs: number | undefined;
        let message: AssistantMessage;
        let terminalError = false;
        if (signal?.aborted) {
          finish(errorMessage(signal.reason));
          return;
        }
        try {
          const stream = await baseFn(model, context, {
            ...requestOptions,
            onResponse: async (response, responseModel) => {
              headerDelayMs = resolveHeaderDelayMs(response.headers);
              await options?.onResponse?.(response, responseModel);
            },
          });
          const iterator = stream[Symbol.asyncIterator]();
          try {
            while (true) {
              const next = await iterator.next();
              if (next.done || next.value.type === "done" || next.value.type === "error") {
                break;
              }
              const event = next.value;
              if ("partial" in event && event.partial) {
                partial = event.partial;
              }
              if (committed) {
                outer.push(event);
                continue;
              }
              // Include full partial snapshots: counting only deltas leaves the
              // retained assistant messages unbounded as output grows.
              const eventBytes = Buffer.byteLength(JSON.stringify(event));
              if (
                bufferedEvents.length >= bufferLimits.maxEvents ||
                bufferedBytes + eventBytes > bufferLimits.maxBytes
              ) {
                // Subscribers have no rollback channel. Once the bounded buffer
                // is committed, stream the rest without reconnecting this turn.
                committed = true;
                flushBufferedEvents();
                outer.push(event);
                continue;
              }
              bufferedEvents.push(event);
              bufferedBytes += eventBytes;
            }
            message = ensureNonEmptyErrorContent(await stream.result(), model);
            terminalError = message.stopReason === "error";
          } finally {
            // Close the failed reader/watchdog before opening the next request.
            try {
              const close = iterator.return?.();
              if (close) {
                await (signal ? abortable(signal, close) : close);
              }
            } catch {
              /* Keep the provider outcome. */
            }
          }
        } catch (error) {
          const failure = errorMessage(error);
          message =
            partial && partial.content.length > 0
              ? { ...partial, stopReason: failure.stopReason, errorMessage: failure.errorMessage }
              : failure;
        }
        if (signal?.aborted) {
          finish(errorMessage(signal.reason));
          return;
        }

        // Only an uncommitted inference can reconnect. Reader failures after
        // buffered partial events remain terminal without a provider outcome.
        const retryableAttempt = !committed && (terminalError || bufferedEvents.length === 0);
        const retryableError = isRetryableModelError(message, model.contextWindow);
        const overloadDeadlineMs = signal ? overloadRetryUntil?.() : undefined;
        // A signal alone has no deadline. Only the run watchdog can bound overload waiting.
        const persistentOverloadRetry =
          overloadDeadlineMs !== undefined &&
          Number.isFinite(overloadDeadlineMs) &&
          overloadDeadlineMs > Date.now() &&
          isOverloadedErrorMessage(message.errorMessage ?? "");
        if (
          !retryableAttempt ||
          (!persistentOverloadRetry && retries >= STREAM_MAX_RETRIES) ||
          !retryableError
        ) {
          finish(message);
          return;
        }
        const requestedDelayMs =
          headerDelayMs ?? resolveRequestedDelayMs(message.errorMessage ?? "");
        if (
          !persistentOverloadRetry &&
          requestedDelayMs !== undefined &&
          maxRetryDelayMs > 0 &&
          requestedDelayMs > maxRetryDelayMs
        ) {
          finish(message);
          return;
        }
        const backoffExponent = Math.min(retries, MAX_RETRY_BACKOFF_EXPONENT);
        const backoffMs =
          RETRY_INITIAL_DELAY_MS * 2 ** backoffExponent * (0.9 + Math.random() * 0.2);
        const backoffLimitMs =
          maxRetryDelayMs > 0
            ? Math.min(maxRetryDelayMs, MAX_TIMER_TIMEOUT_MS)
            : MAX_TIMER_TIMEOUT_MS;
        const boundedBackoffMs = Math.min(backoffLimitMs, backoffMs);
        // A provider's zero Retry-After must still yield between persistent overload attempts.
        const delayMs = Math.min(
          MAX_TIMER_TIMEOUT_MS,
          Math.round(
            requestedDelayMs === 0
              ? RETRY_INITIAL_DELAY_MS
              : (requestedDelayMs ?? boundedBackoffMs),
          ),
        );
        bufferedEvents.length = 0;
        bufferedBytes = 0;
        onRetry?.({
          attempt: retries + 1,
          maxAttempts: persistentOverloadRetry ? undefined : STREAM_MAX_RETRIES,
          delayMs,
        });
        await sleepWithAbort(delayMs, signal);
      }
    })().catch((error: unknown) => {
      finish(errorMessage(error));
    });
    return outer;
  };
}
