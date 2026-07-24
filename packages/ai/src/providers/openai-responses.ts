// OpenAI Responses provider adapts OpenAI response streams to the agent runtime.
import OpenAI from "openai";
import type {
  ResponseCompactParams,
  ResponseCreateParamsStreaming,
  ResponseUsage,
} from "openai/resources/responses/responses.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost } from "../host.js";
import { calculateCost } from "../model-utils.js";
import type {
  CacheRetention,
  Context,
  Model,
  OpenAIResponsesCompat,
  ProviderCompactionOptions,
  ProviderCompactionResult,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
  Usage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { resolveCacheRetention } from "./cache-retention.js";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";
import {
  applyCommonResponsesParams,
  convertResponsesMessages,
  createResponsesAssistantOutput,
  resolveResponsesReasoningEffort,
  runResponsesStreamLifecycle,
} from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "opencode"]);

type ResolvedOpenAIResponsesCompat = Required<
  Pick<OpenAIResponsesCompat, "sendSessionIdHeader" | "supportsLongCacheRetention">
>;

function getCompat(model: Model<"openai-responses">): ResolvedOpenAIResponsesCompat {
  return {
    sendSessionIdHeader: model.compat?.sendSessionIdHeader ?? true,
    supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
  };
}

function getPromptCacheRetention(
  compat: ResolvedOpenAIResponsesCompat,
  cacheRetention: CacheRetention,
): "24h" | undefined {
  return cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined;
}

function formatOpenAIResponsesError(error: unknown): string {
  if (error instanceof Error) {
    const status = (error as Error & { status?: unknown }).status;
    const statusCode = typeof status === "number" ? status : undefined;
    if (statusCode !== undefined) {
      return `OpenAI API error (${statusCode}): ${error.message}`;
    }
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  replayResponsesItemIds?: boolean;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
}

type OpenAIResponsesReplayOptions = SimpleStreamOptions & {
  replayResponsesItemIds?: boolean;
};

function mapResponsesUsage(model: Model<"openai-responses">, usage: ResponseUsage): Usage {
  const inputDetails = usage.input_tokens_details as
    | { cached_tokens?: number; cache_write_tokens?: number }
    | null
    | undefined;
  const cacheRead = inputDetails?.cached_tokens ?? 0;
  const cacheWrite = inputDetails?.cache_write_tokens ?? 0;
  const result: Usage = {
    input: Math.max(0, (usage.input_tokens ?? 0) - cacheRead - cacheWrite),
    output: usage.output_tokens ?? 0,
    cacheRead,
    cacheWrite,
    totalTokens: usage.total_tokens ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, result);
  return result;
}

/** Compact Responses input into an opaque replacement state owned by the provider. */
export async function compactOpenAIResponses(
  model: Model<"openai-responses">,
  context: Context,
  options?: ProviderCompactionOptions,
): Promise<ProviderCompactionResult> {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const client = createClient(
    model,
    context,
    apiKey,
    options?.headers,
    cacheRetention === "none" ? undefined : options?.sessionId,
  );
  const input = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
    replayResponsesItemIds: false,
  });
  for (const item of input) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      delete (item as { status?: unknown }).status;
    }
  }
  const customInstructions = options?.customInstructions?.trim();
  const instructions = [context.systemPrompt, customInstructions].filter(Boolean).join("\n\n");
  const body: ResponseCompactParams = {
    model: model.id,
    input,
    instructions: instructions || undefined,
    prompt_cache_key:
      cacheRetention === "none"
        ? undefined
        : clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId),
    prompt_cache_retention: getPromptCacheRetention(getCompat(model), cacheRetention),
  };
  const payload = (await options?.onPayload?.(body, model)) ?? body;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Responses compaction payload hook must return an object");
  }
  const compacted = await client.responses.compact(payload as ResponseCompactParams, {
    signal: options?.signal,
  });
  const usage = mapResponsesUsage(model, compacted.usage);
  return {
    messages: [
      {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
          {
            type: "providerState",
            state: compacted.output,
            estimatedTokens: Math.max(1, compacted.usage.output_tokens ?? 0),
          },
        ],
        usage,
        stopReason: "stop",
        timestamp: Date.now(),
      },
    ],
    usage,
  };
}

/**
 * Generate function for OpenAI Responses API
 */
export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
) => {
  const stream = new AssistantMessageEventStream();
  const output = createResponsesAssistantOutput(model);

  // Start async processing
  void runResponsesStreamLifecycle({
    stream,
    model,
    output,
    options,
    createClient: () => {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      const cacheRetention = resolveCacheRetention(options?.cacheRetention);
      const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
      return createClient(model, context, apiKey, options?.headers, cacheSessionId);
    },
    buildParams: () => buildParams(model, context, options),
    processStreamOptions: {
      serviceTier: options?.serviceTier,
      applyServiceTierPricing: (usage, serviceTier) =>
        applyServiceTierPricing(usage, serviceTier, model),
    },
    formatError: formatOpenAIResponsesError,
  });

  return stream;
};

export const streamSimpleOpenAIResponses: StreamFunction<
  "openai-responses",
  SimpleStreamOptions
> = (model: Model<"openai-responses">, context: Context, options?: SimpleStreamOptions) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);

  return streamOpenAIResponses(model, context, {
    ...base,
    reasoningEffort: resolveResponsesReasoningEffort(model, options?.reasoning),
    replayResponsesItemIds: (options as OpenAIResponsesReplayOptions | undefined)
      ?.replayResponsesItemIds,
  } satisfies OpenAIResponsesOptions);
};

function createClient(
  model: Model<"openai-responses">,
  context: Context,
  apiKey?: string,
  optionsHeaders?: Record<string, string>,
  sessionId?: string,
) {
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const compat = getCompat(model);
  const headers = { ...model.headers };
  if (model.provider === "github-copilot") {
    const hasImages = hasCopilotVisionInput(context.messages);
    const copilotHeaders = buildCopilotDynamicHeaders({
      messages: context.messages,
      hasImages,
    });
    Object.assign(headers, copilotHeaders);
  }

  if (sessionId) {
    if (compat.sendSessionIdHeader) {
      headers.session_id = sessionId;
    }
    headers["x-client-request-id"] = sessionId;
  }

  // Merge options headers last so they can override defaults
  if (optionsHeaders) {
    Object.assign(headers, optionsHeaders);
  }

  const defaultHeaders =
    model.provider === "cloudflare-ai-gateway"
      ? {
          ...headers,
          Authorization: headers.Authorization ?? null,
          "cf-aig-authorization": `Bearer ${apiKey}`,
        }
      : headers;

  return new OpenAI({
    apiKey,
    baseURL: isCloudflareProvider(model.provider) ? resolveCloudflareBaseUrl(model) : model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders,
    // OpenAI supports custom fetch, so sentinels stay opaque until guarded egress.
    fetch: getAiTransportHost().buildModelFetch(model),
  });
}

function buildParams(
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
) {
  const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
    replayResponsesItemIds: options?.replayResponsesItemIds ?? false,
  });

  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const compat = getCompat(model);
  const params: ResponseCreateParamsStreaming = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key:
      cacheRetention === "none"
        ? undefined
        : clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId),
    prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
    store: false,
  };

  if (options?.maxTokens) {
    params.max_output_tokens = options?.maxTokens;
  }

  if (options?.temperature !== undefined) {
    params.temperature = options?.temperature;
  }

  if (options?.serviceTier !== undefined) {
    params.service_tier = options.serviceTier;
  }

  applyCommonResponsesParams(params, model, context, options, {
    setDefaultReasoningOff: model.provider !== "github-copilot",
  });

  return params;
}

function getServiceTierCostMultiplier(
  model: Pick<Model<"openai-responses">, "id">,
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return model.id === "gpt-5.5" ? 2.5 : 2;
    default:
      return 1;
  }
}

function applyServiceTierPricing(
  usage: Usage,
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  model: Pick<Model<"openai-responses">, "id">,
) {
  const multiplier = getServiceTierCostMultiplier(model, serviceTier);
  if (multiplier === 1) {
    return;
  }

  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
