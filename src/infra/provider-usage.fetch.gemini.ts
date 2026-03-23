import { buildUsageHttpErrorSnapshot, fetchJson } from "./provider-usage.fetch.shared.js";
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
  const res = await fetchJson(
    `${endpoint}/v1internal:retrieveUserQuota`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(projectId ? { project: projectId } : {}),
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

  const data = (await res.json()) as GeminiUsageResponse;
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
