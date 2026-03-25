import {
  dedupeProfileIds,
  ensureAuthProfileStore,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { resolveApiKeyForProvider } from "../../agents/model-auth.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { ProviderAuth } from "../../infra/provider-usage.auth.js";
import {
  formatUsageWindowSummary,
  type ProviderUsageSnapshot,
  type UsageProviderId,
} from "../../infra/provider-usage.js";

function parseGoogleUsageToken(
  value: string,
): { token: string; projectId?: string; endpoint?: string } | null {
  try {
    const parsed = JSON.parse(value) as {
      token?: unknown;
      projectId?: unknown;
      endpoint?: unknown;
    };
    if (!parsed || typeof parsed.token !== "string") {
      return null;
    }
    return {
      token: parsed.token,
      ...(typeof parsed.projectId === "string" && parsed.projectId.trim()
        ? { projectId: parsed.projectId.trim() }
        : {}),
      ...(typeof parsed.endpoint === "string" && parsed.endpoint.trim()
        ? { endpoint: parsed.endpoint.trim() }
        : {}),
    };
  } catch {
    return null;
  }
}

function resolveSelectedAuthProfile(params: {
  provider: UsageProviderId;
  cfg: OpenClawConfig;
  sessionEntry?: SessionEntry;
  agentDir?: string;
  profileId?: string;
}): {
  profileId?: string;
  store: ReturnType<typeof ensureAuthProfileStore>;
} {
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const providerKey = normalizeProviderId(params.provider);
  const explicitProfileId = params.profileId?.trim();
  if (explicitProfileId) {
    const explicitProfile = store.profiles[explicitProfileId];
    if (!explicitProfile) {
      return { store };
    }
    return normalizeProviderId(explicitProfile.provider) === providerKey
      ? { profileId: explicitProfileId, store }
      : { store };
  }

  const profileOverride = params.sessionEntry?.authProfileOverride?.trim();
  const order = resolveAuthProfileOrder({
    cfg: params.cfg,
    store,
    provider: providerKey,
    preferredProfile: profileOverride,
  });
  const candidates = dedupeProfileIds([profileOverride, ...order].filter(Boolean) as string[]);
  const profileId = candidates.find((candidate) => {
    const profile = store.profiles[candidate];
    return profile ? normalizeProviderId(profile.provider) === providerKey : false;
  });
  return { profileId, store };
}

export function formatUsageUnavailable(params: {
  reason: string;
  profileScopeLabel?: string;
}): string {
  const profileScopeSuffix = params.profileScopeLabel ? ` · ${params.profileScopeLabel}` : "";
  return `unavailable (${params.reason})${profileScopeSuffix}`;
}

export function resolveScopedUsageSummary(params: {
  usageEntry?: ProviderUsageSnapshot;
  profileScopeLabel?: string;
  now?: number;
}): string | null {
  const { usageEntry, profileScopeLabel } = params;
  if (!usageEntry) {
    return profileScopeLabel
      ? formatUsageUnavailable({ reason: "no data", profileScopeLabel })
      : null;
  }
  if (usageEntry.error) {
    return formatUsageUnavailable({
      reason: usageEntry.error,
      profileScopeLabel,
    });
  }
  if (usageEntry.windows.length === 0) {
    return formatUsageUnavailable({ reason: "no data", profileScopeLabel });
  }
  const summaryLine = formatUsageWindowSummary(usageEntry, {
    now: params.now ?? Date.now(),
    maxWindows: 2,
    includeResets: true,
  });
  if (!summaryLine) {
    return formatUsageUnavailable({ reason: "no data", profileScopeLabel });
  }
  const profileScopeSuffix = profileScopeLabel ? ` · ${profileScopeLabel}` : "";
  return `${summaryLine}${profileScopeSuffix}`;
}

export async function resolveProfileUsageAuthBinding(params: {
  provider: UsageProviderId;
  cfg: OpenClawConfig;
  sessionEntry?: SessionEntry;
  agentDir?: string;
  profileId?: string;
}): Promise<{
  authInput?: ProviderAuth[];
  profileScopeLabel?: string;
}> {
  const { profileId, store } = resolveSelectedAuthProfile(params);
  if (!profileId) {
    return {};
  }

  const profileScopeLabel = profileId.startsWith(`${params.provider}:`)
    ? profileId
    : `${params.provider}:${profileId}`;
  try {
    const resolved = await resolveApiKeyForProvider({
      provider: params.provider,
      cfg: params.cfg,
      profileId,
      store,
      agentDir: params.agentDir,
    });
    const token = resolved.apiKey?.trim();
    if (!token) {
      return { authInput: [], profileScopeLabel };
    }

    const profile = store.profiles[profileId];
    let usageAuth: ProviderAuth = {
      provider: params.provider,
      token,
    };

    if (
      params.provider === "openai-codex" &&
      profile?.type === "oauth" &&
      "accountId" in profile &&
      typeof profile.accountId === "string" &&
      profile.accountId.trim()
    ) {
      usageAuth = {
        ...usageAuth,
        accountId: profile.accountId.trim(),
      };
    }

    if (params.provider === "google-gemini-cli") {
      const parsed = parseGoogleUsageToken(token);
      const projectIdFromProfile =
        profile?.type === "oauth" &&
        "projectId" in profile &&
        typeof profile.projectId === "string" &&
        profile.projectId.trim()
          ? profile.projectId.trim()
          : undefined;
      const endpointFromProfile =
        profile?.type === "oauth" &&
        "endpoint" in profile &&
        typeof profile.endpoint === "string" &&
        profile.endpoint.trim()
          ? profile.endpoint.trim()
          : undefined;
      usageAuth = {
        ...usageAuth,
        token: parsed?.token ?? token,
        ...(parsed?.projectId || projectIdFromProfile
          ? { projectId: parsed?.projectId ?? projectIdFromProfile }
          : {}),
        ...(parsed?.endpoint || endpointFromProfile
          ? { endpoint: parsed?.endpoint ?? endpointFromProfile }
          : {}),
      };
    }

    return {
      authInput: [usageAuth],
      profileScopeLabel,
    };
  } catch {
    // Strict binding: if a profile is selected but auth resolution fails, do not
    // silently fall back to another profile's usage.
    return { authInput: [], profileScopeLabel };
  }
}
