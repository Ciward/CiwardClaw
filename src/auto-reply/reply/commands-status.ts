import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import {
  dedupeProfileIds,
  ensureAuthProfileStore,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { resolveModelAuthLabel } from "../../agents/model-auth-label.js";
import { resolveApiKeyForProvider } from "../../agents/model-auth.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { listSubagentRunsForRequester } from "../../agents/subagent-registry.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import { toAgentModelListLike } from "../../config/model-input.js";
import type { SessionEntry, SessionScope } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import type { ProviderAuth } from "../../infra/provider-usage.auth.js";
import {
  formatUsageWindowSummary,
  loadProviderUsageSummary,
  resolveUsageProviderId,
  type ProviderUsageSnapshot,
  type UsageProviderId,
} from "../../infra/provider-usage.js";
import type { MediaUnderstandingDecision } from "../../media-understanding/types.js";
import { normalizeGroupActivation } from "../group-activation.js";
import { resolveSelectedAndActiveModel } from "../model-runtime.js";
import { buildStatusMessage } from "../status.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { CommandContext } from "./commands-types.js";
import { getFollowupQueueDepth, resolveQueueSettings } from "./queue.js";
import { resolveSubagentLabel } from "./subagents-utils.js";

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

function formatStatusUsageUnavailable(params: {
  reason: string;
  profileScopeLabel?: string;
}): string {
  const profileScopeSuffix = params.profileScopeLabel ? ` · ${params.profileScopeLabel}` : "";
  return `📊 Usage: unavailable (${params.reason})${profileScopeSuffix}`;
}

export function resolveStatusUsageLine(params: {
  usageEntry?: ProviderUsageSnapshot;
  profileScopeLabel?: string;
  now?: number;
}): string | null {
  const { usageEntry, profileScopeLabel } = params;
  if (!usageEntry) {
    return profileScopeLabel
      ? formatStatusUsageUnavailable({ reason: "no data", profileScopeLabel })
      : null;
  }
  if (usageEntry.error) {
    return formatStatusUsageUnavailable({
      reason: usageEntry.error,
      profileScopeLabel,
    });
  }
  if (usageEntry.windows.length === 0) {
    return formatStatusUsageUnavailable({ reason: "no data", profileScopeLabel });
  }
  const summaryLine = formatUsageWindowSummary(usageEntry, {
    now: params.now ?? Date.now(),
    maxWindows: 2,
    includeResets: true,
  });
  if (!summaryLine) {
    return formatStatusUsageUnavailable({ reason: "no data", profileScopeLabel });
  }
  const profileScopeSuffix = profileScopeLabel ? ` · ${profileScopeLabel}` : "";
  return `📊 Usage: ${summaryLine}${profileScopeSuffix}`;
}

function resolveSelectedAuthProfile(params: {
  provider: UsageProviderId;
  cfg: OpenClawConfig;
  sessionEntry?: SessionEntry;
  agentDir?: string;
}): {
  profileId?: string;
  store: ReturnType<typeof ensureAuthProfileStore>;
} {
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const providerKey = normalizeProviderId(params.provider);
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

async function resolveStatusUsageAuthBinding(params: {
  provider: UsageProviderId;
  cfg: OpenClawConfig;
  sessionEntry?: SessionEntry;
  agentDir?: string;
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

export async function buildStatusReply(params: {
  cfg: OpenClawConfig;
  command: CommandContext;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  parentSessionKey?: string;
  sessionScope?: SessionScope;
  storePath?: string;
  provider: string;
  model: string;
  contextTokens: number;
  resolvedThinkLevel?: ThinkLevel;
  resolvedFastMode?: boolean;
  resolvedVerboseLevel: VerboseLevel;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel?: ElevatedLevel;
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
  isGroup: boolean;
  defaultGroupActivation: () => "always" | "mention";
  mediaDecisions?: MediaUnderstandingDecision[];
}): Promise<ReplyPayload | undefined> {
  const {
    cfg,
    command,
    sessionEntry,
    sessionKey,
    parentSessionKey,
    sessionScope,
    storePath,
    provider,
    model,
    contextTokens,
    resolvedThinkLevel,
    resolvedFastMode,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel,
    isGroup,
    defaultGroupActivation,
  } = params;
  if (!command.isAuthorizedSender) {
    logVerbose(`Ignoring /status from unauthorized sender: ${command.senderId || "<unknown>"}`);
    return undefined;
  }
  const statusAgentId = sessionKey
    ? resolveSessionAgentId({ sessionKey, config: cfg })
    : resolveDefaultAgentId(cfg);
  const statusAgentDir = resolveAgentDir(cfg, statusAgentId);
  const currentUsageProvider = (() => {
    try {
      return resolveUsageProviderId(provider);
    } catch {
      return undefined;
    }
  })();
  let usageLine: string | null = null;
  if (currentUsageProvider) {
    let usageBinding: Awaited<ReturnType<typeof resolveStatusUsageAuthBinding>> | undefined;
    try {
      usageBinding = await resolveStatusUsageAuthBinding({
        provider: currentUsageProvider,
        cfg,
        sessionEntry,
        agentDir: statusAgentDir,
      });
      const usageSummary = await loadProviderUsageSummary({
        timeoutMs: 3500,
        providers: [currentUsageProvider],
        auth: usageBinding.authInput,
        agentDir: statusAgentDir,
      });
      usageLine = resolveStatusUsageLine({
        usageEntry: usageSummary.providers[0],
        profileScopeLabel: usageBinding.profileScopeLabel,
      });
    } catch {
      usageLine = formatStatusUsageUnavailable({
        reason: "request failed",
        profileScopeLabel: usageBinding?.profileScopeLabel,
      });
    }
  }
  const queueSettings = resolveQueueSettings({
    cfg,
    channel: command.channel,
    sessionEntry,
  });
  const queueKey = sessionKey ?? sessionEntry?.sessionId;
  const queueDepth = queueKey ? getFollowupQueueDepth(queueKey) : 0;
  const queueOverrides = Boolean(
    sessionEntry?.queueDebounceMs ?? sessionEntry?.queueCap ?? sessionEntry?.queueDrop,
  );

  let subagentsLine: string | undefined;
  if (sessionKey) {
    const { mainKey, alias } = resolveMainSessionAlias(cfg);
    const requesterKey = resolveInternalSessionKey({ key: sessionKey, alias, mainKey });
    const runs = listSubagentRunsForRequester(requesterKey);
    const verboseEnabled = resolvedVerboseLevel && resolvedVerboseLevel !== "off";
    if (runs.length > 0) {
      const active = runs.filter((entry) => !entry.endedAt);
      const done = runs.length - active.length;
      if (verboseEnabled) {
        const labels = active
          .map((entry) => resolveSubagentLabel(entry, ""))
          .filter(Boolean)
          .slice(0, 3);
        const labelText = labels.length ? ` (${labels.join(", ")})` : "";
        subagentsLine = `🤖 Subagents: ${active.length} active${labelText} · ${done} done`;
      } else if (active.length > 0) {
        subagentsLine = `🤖 Subagents: ${active.length} active`;
      }
    }
  }
  const groupActivation = isGroup
    ? (normalizeGroupActivation(sessionEntry?.groupActivation) ?? defaultGroupActivation())
    : undefined;
  const modelRefs = resolveSelectedAndActiveModel({
    selectedProvider: provider,
    selectedModel: model,
    sessionEntry,
  });
  const selectedModelAuth = resolveModelAuthLabel({
    provider,
    cfg,
    sessionEntry,
    agentDir: statusAgentDir,
  });
  const activeModelAuth = modelRefs.activeDiffers
    ? resolveModelAuthLabel({
        provider: modelRefs.active.provider,
        cfg,
        sessionEntry,
        agentDir: statusAgentDir,
      })
    : selectedModelAuth;
  const agentDefaults = cfg.agents?.defaults ?? {};
  const effectiveFastMode =
    resolvedFastMode ??
    resolveFastModeState({
      cfg,
      provider,
      model,
      sessionEntry,
    }).enabled;
  const statusText = buildStatusMessage({
    config: cfg,
    agent: {
      ...agentDefaults,
      model: {
        ...toAgentModelListLike(agentDefaults.model),
        primary: `${provider}/${model}`,
      },
      contextTokens,
      thinkingDefault: agentDefaults.thinkingDefault,
      verboseDefault: agentDefaults.verboseDefault,
      elevatedDefault: agentDefaults.elevatedDefault,
    },
    agentId: statusAgentId,
    sessionEntry,
    sessionKey,
    parentSessionKey,
    sessionScope,
    sessionStorePath: storePath,
    groupActivation,
    resolvedThink: resolvedThinkLevel ?? (await resolveDefaultThinkingLevel()),
    resolvedFast: effectiveFastMode,
    resolvedVerbose: resolvedVerboseLevel,
    resolvedReasoning: resolvedReasoningLevel,
    resolvedElevated: resolvedElevatedLevel,
    modelAuth: selectedModelAuth,
    activeModelAuth,
    usageLine: usageLine ?? undefined,
    queue: {
      mode: queueSettings.mode,
      depth: queueDepth,
      debounceMs: queueSettings.debounceMs,
      cap: queueSettings.cap,
      dropPolicy: queueSettings.dropPolicy,
      showDetails: queueOverrides,
    },
    subagentsLine,
    mediaDecisions: params.mediaDecisions,
    includeTranscriptUsage: false,
  });

  return { text: statusText };
}
