import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  buildUsageErrorSnapshot,
  buildUsageHttpErrorSnapshot,
  fetchJson,
} from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "./provider-usage.types.js";

type GeminiUsageResponse = {
  buckets?: Array<{
    modelId?: string;
    remainingFraction?: number;
    remainingAmount?: string;
    resetTime?: string;
  }>;
};

type RequestImpl = typeof httpRequest;
type NodeRequestResult = {
  status: number;
  body: string;
};
type FetchWithMarker = typeof fetch & {
  [key: symbol]: unknown;
};

const defaultHttpRequestImpl: RequestImpl = httpRequest;
const defaultHttpsRequestImpl: RequestImpl = httpsRequest;

let httpRequestImpl: RequestImpl = defaultHttpRequestImpl;
let httpsRequestImpl: RequestImpl = defaultHttpsRequestImpl;

export function setGeminiUsageNetworkDepsForTest(deps?: {
  httpRequest?: RequestImpl;
  httpsRequest?: RequestImpl;
}): void {
  httpRequestImpl = deps?.httpRequest ?? defaultHttpRequestImpl;
  httpsRequestImpl = deps?.httpsRequest ?? defaultHttpsRequestImpl;
}

function isTimeoutLikeError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("abort") || message.includes("timeout")) {
      return true;
    }
    const causeCode = (error as Error & { cause?: { code?: unknown } }).cause?.code;
    if (typeof causeCode === "string" && causeCode.includes("TIMEOUT")) {
      return true;
    }
  }
  return false;
}

async function postJsonViaNodeRequest(params: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}): Promise<NodeRequestResult> {
  const parsedUrl = new URL(params.url);
  const requestImpl =
    parsedUrl.protocol === "https:"
      ? httpsRequestImpl
      : parsedUrl.protocol === "http:"
        ? httpRequestImpl
        : null;
  if (!requestImpl) {
    throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`);
  }

  return await new Promise<NodeRequestResult>((resolve, reject) => {
    const req = requestImpl(
      parsedUrl,
      {
        method: "POST",
        headers: {
          ...params.headers,
          "Content-Length": Buffer.byteLength(params.body).toString(),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );

    const timer = setTimeout(() => {
      req.destroy(new Error("Timeout"));
    }, params.timeoutMs);

    req.on("close", () => {
      clearTimeout(timer);
    });
    req.on("error", reject);
    req.write(params.body);
    req.end();
  });
}

function parseGeminiUsageResponseBody(body: string): GeminiUsageResponse {
  if (!body.trim()) {
    return {};
  }
  return JSON.parse(body) as GeminiUsageResponse;
}

export async function fetchGeminiUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  provider: UsageProviderId,
  options?: { projectId?: string; endpoint?: string },
): Promise<ProviderUsageSnapshot> {
  const endpoint =
    typeof options?.endpoint === "string" && options.endpoint.trim().length > 0
      ? options.endpoint.trim()
      : "https://cloudcode-pa.googleapis.com";
  const projectId = options?.projectId?.trim();
  const requestUrl = `${endpoint}/v1internal:retrieveUserQuota`;
  const requestBody = JSON.stringify(projectId ? { project: projectId } : {});
  const requestHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const abortWrappedFetchMarker = Symbol.for("openclaw.fetch.abort-signal-wrapped");
  const isAbortWrappedFetch = (fetchFn as FetchWithMarker)[abortWrappedFetchMarker] === true;
  const canUseNodeTransport =
    (fetchFn === globalThis.fetch || isAbortWrappedFetch) &&
    (requestUrl.startsWith("https://") || requestUrl.startsWith("http://"));

  let data: GeminiUsageResponse;
  try {
    if (canUseNodeTransport) {
      const response = await postJsonViaNodeRequest({
        url: requestUrl,
        headers: requestHeaders,
        body: requestBody,
        timeoutMs,
      });
      if (response.status < 200 || response.status >= 300) {
        return buildUsageHttpErrorSnapshot({
          provider,
          status: response.status,
        });
      }
      data = parseGeminiUsageResponseBody(response.body);
    } else {
      const res = await fetchJson(
        requestUrl,
        {
          method: "POST",
          headers: requestHeaders,
          body: requestBody,
        },
        timeoutMs,
        fetchFn,
      );

      if (!res.ok) {
        return buildUsageHttpErrorSnapshot({
          provider,
          status: res.status,
        });
      }

      data = (await res.json()) as GeminiUsageResponse;
    }
  } catch (error) {
    return buildUsageErrorSnapshot(
      provider,
      isTimeoutLikeError(error) ? "Timeout" : "request failed",
    );
  }
  const quotas: Record<string, { remainingFraction: number; resetAt?: number }> = {};

  for (const bucket of data.buckets || []) {
    const model = bucket.modelId || "unknown";
    const frac = bucket.remainingFraction ?? 1;
    const resetAt =
      typeof bucket.resetTime === "string" && bucket.resetTime.trim()
        ? Date.parse(bucket.resetTime)
        : undefined;
    const resetAtMs = Number.isFinite(resetAt) ? resetAt : undefined;
    if (!quotas[model] || frac < quotas[model].remainingFraction) {
      quotas[model] = {
        remainingFraction: frac,
        ...(typeof resetAtMs === "number" ? { resetAt: resetAtMs } : {}),
      };
    }
  }

  const windows: UsageWindow[] = [];
  let proMin = { remainingFraction: 1 } as { remainingFraction: number; resetAt?: number };
  let flashMin = { remainingFraction: 1 } as { remainingFraction: number; resetAt?: number };
  let hasPro = false;
  let hasFlash = false;

  for (const [model, quota] of Object.entries(quotas)) {
    const lower = model.toLowerCase();
    if (lower.includes("pro")) {
      hasPro = true;
      if (quota.remainingFraction < proMin.remainingFraction) {
        proMin = quota;
      }
    }
    if (lower.includes("flash")) {
      hasFlash = true;
      if (quota.remainingFraction < flashMin.remainingFraction) {
        flashMin = quota;
      }
    }
  }

  if (hasPro) {
    windows.push({
      label: "Pro",
      usedPercent: clampPercent((1 - proMin.remainingFraction) * 100),
      ...(typeof proMin.resetAt === "number" ? { resetAt: proMin.resetAt } : {}),
    });
  }
  if (hasFlash) {
    windows.push({
      label: "Flash",
      usedPercent: clampPercent((1 - flashMin.remainingFraction) * 100),
      ...(typeof flashMin.resetAt === "number" ? { resetAt: flashMin.resetAt } : {}),
    });
  }

  return { provider, displayName: PROVIDER_LABELS[provider], windows };
}
