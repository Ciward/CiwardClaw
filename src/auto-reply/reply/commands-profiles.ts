import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveAuthProfileDisplayLabel,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadProviderUsageSummary, resolveUsageProviderId } from "../../infra/provider-usage.js";
import {
  formatUsageUnavailable,
  resolveProfileUsageAuthBinding,
  resolveScopedUsageSummary,
} from "../../status/profile-usage.js";
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import { persistSessionEntry } from "./commands-session-store.js";
import type { CommandHandler } from "./commands-types.js";

type ProfileOverview = {
  provider: string;
  profileIds: string[];
};

type ParsedProfilesArgs = {
  provider?: string;
  profileId?: string;
};

type ResolvedProfileSelection =
  | { kind: "resolved"; profileId: string }
  | { kind: "ambiguous"; profileIds: string[] }
  | { kind: "not-found" };

const PROFILE_USAGE_TIMEOUT_MS = 3500;

function parseProfilesArgs(raw: string): ParsedProfilesArgs {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const tokens = trimmed.split(/\s+/g).filter(Boolean);
  const provider = tokens[0] ? normalizeProviderId(tokens[0]) : undefined;
  const profileId = tokens[1]?.trim();
  return {
    provider: provider || undefined,
    profileId: profileId || undefined,
  };
}

function buildProfilesOverview(
  store: ReturnType<typeof ensureAuthProfileStore>,
): ProfileOverview[] {
  const byProvider = new Map<string, string[]>();
  for (const profileId of Object.keys(store.profiles)) {
    const profile = store.profiles[profileId];
    if (!profile) {
      continue;
    }
    const provider = normalizeProviderId(profile.provider);
    const list = byProvider.get(provider) ?? [];
    list.push(profileId);
    byProvider.set(provider, list);
  }
  return [...byProvider.entries()]
    .map(([provider, profileIds]) => ({ provider, profileIds: profileIds.toSorted() }))
    .toSorted((a, b) => a.provider.localeCompare(b.provider));
}

function resolveCurrentProfileForProvider(params: {
  provider: string;
  cfg: OpenClawConfig;
  store: ReturnType<typeof ensureAuthProfileStore>;
  sessionEntry?: SessionEntry;
}): string | undefined {
  const preferred = params.sessionEntry?.authProfileOverride?.trim();
  const order = resolveAuthProfileOrder({
    cfg: params.cfg,
    store: params.store,
    provider: params.provider,
    preferredProfile: preferred,
  });
  const candidates = [preferred, ...order].filter(Boolean) as string[];
  return candidates.find((profileId) => {
    const profile = params.store.profiles[profileId];
    return profile ? normalizeProviderId(profile.provider) === params.provider : false;
  });
}

function resolveProviderScopedProfileId(params: { provider: string; profileId: string }): string {
  const separatorIndex = params.profileId.indexOf(":");
  if (separatorIndex <= 0) {
    return params.profileId;
  }
  const profileProvider = normalizeProviderId(params.profileId.slice(0, separatorIndex));
  return profileProvider === normalizeProviderId(params.provider)
    ? params.profileId.slice(separatorIndex + 1)
    : params.profileId;
}

function resolveRequestedProfileSelection(params: {
  provider: string;
  profileId: string;
  providerProfiles: readonly string[];
}): ResolvedProfileSelection {
  const requested = params.profileId.trim();
  if (!requested) {
    return { kind: "not-found" };
  }
  const requestedScoped = resolveProviderScopedProfileId({
    provider: params.provider,
    profileId: requested,
  });
  const matches = params.providerProfiles.filter((candidate) => {
    if (candidate === requested) {
      return true;
    }
    const candidateScoped = resolveProviderScopedProfileId({
      provider: params.provider,
      profileId: candidate,
    });
    return candidateScoped === requested || candidateScoped === requestedScoped;
  });
  const deduped = [...new Set(matches)];
  if (deduped.length === 0) {
    return { kind: "not-found" };
  }
  if (deduped.length > 1) {
    return { kind: "ambiguous", profileIds: deduped };
  }
  return { kind: "resolved", profileId: deduped[0] };
}

function resolveProviderScopedProfileLabel(params: {
  provider: string;
  profileId: string;
  cfg: OpenClawConfig;
  store: ReturnType<typeof ensureAuthProfileStore>;
}): string {
  const fullLabel = resolveAuthProfileDisplayLabel({
    cfg: params.cfg,
    store: params.store,
    profileId: params.profileId,
  });
  const shortId = resolveProviderScopedProfileId({
    provider: params.provider,
    profileId: params.profileId,
  });
  if (fullLabel === params.profileId) {
    return shortId;
  }
  if (fullLabel.startsWith(`${params.profileId} (`)) {
    return `${shortId}${fullLabel.slice(params.profileId.length)}`;
  }
  return fullLabel;
}

function removeProfileScopeSuffix(summary: string, profileScopeLabel?: string): string {
  if (!profileScopeLabel) {
    return summary;
  }
  const suffix = ` · ${profileScopeLabel}`;
  return summary.endsWith(suffix) ? summary.slice(0, -suffix.length) : summary;
}

async function resolveProfileUsageSummaryByProfile(params: {
  provider: string;
  profileIds: string[];
  cfg: OpenClawConfig;
  sessionEntry?: SessionEntry;
  agentDir?: string;
}): Promise<Map<string, string>> {
  const usageProvider = resolveUsageProviderId(params.provider);
  if (!usageProvider) {
    return new Map();
  }

  const now = Date.now();
  const usagePairs: Array<readonly [string, string]> = [];
  for (const profileId of params.profileIds) {
    const usageBinding = await resolveProfileUsageAuthBinding({
      provider: usageProvider,
      cfg: params.cfg,
      sessionEntry: params.sessionEntry,
      agentDir: params.agentDir,
      profileId,
    });
    try {
      const usageSummary = await loadProviderUsageSummary({
        timeoutMs: PROFILE_USAGE_TIMEOUT_MS,
        providers: [usageProvider],
        auth: usageBinding.authInput ?? [],
        agentDir: params.agentDir,
      });
      const scopedUsageSummary = resolveScopedUsageSummary({
        usageEntry: usageSummary.providers[0],
        profileScopeLabel: usageBinding.profileScopeLabel,
        now,
      });
      const fallbackSummary = formatUsageUnavailable({
        reason: "no data",
        profileScopeLabel: usageBinding.profileScopeLabel,
      });
      usagePairs.push([
        profileId,
        removeProfileScopeSuffix(
          scopedUsageSummary ?? fallbackSummary,
          usageBinding.profileScopeLabel,
        ),
      ]);
    } catch {
      const requestFailed = formatUsageUnavailable({
        reason: "request failed",
        profileScopeLabel: usageBinding.profileScopeLabel,
      });
      usagePairs.push([
        profileId,
        removeProfileScopeSuffix(requestFailed, usageBinding.profileScopeLabel),
      ]);
    }
  }
  return new Map(usagePairs);
}

function formatProfileLine(params: {
  provider: string;
  profileId: string;
  cfg: OpenClawConfig;
  store: ReturnType<typeof ensureAuthProfileStore>;
  isCurrent: boolean;
  usageSummary?: string;
}): string {
  const display = resolveProviderScopedProfileLabel({
    provider: params.provider,
    profileId: params.profileId,
    cfg: params.cfg,
    store: params.store,
  });
  return `${params.isCurrent ? "* " : "- "}${display}${
    params.usageSummary ? ` · ${params.usageSummary}` : ""
  }`;
}

function ensureSessionEntryForProfileSwitch(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
}): SessionEntry | undefined {
  if (!params.sessionStore || !params.sessionKey) {
    return undefined;
  }
  if (params.sessionEntry) {
    return params.sessionEntry;
  }
  const next: SessionEntry = {
    sessionId: params.sessionStore[params.sessionKey]?.sessionId ?? "main",
    updatedAt: Date.now(),
  };
  params.sessionStore[params.sessionKey] = next;
  return next;
}

export async function resolveProfilesCommandReply(params: {
  cfg: OpenClawConfig;
  commandBodyNormalized: string;
  surface?: string;
  sessionEntry?: SessionEntry;
  agentDir?: string;
  setProfile?: (provider: string, profileId: string) => Promise<boolean>;
}): Promise<ReplyPayload | null> {
  const body = params.commandBodyNormalized.trim();
  if (!body.startsWith("/profiles")) {
    return null;
  }

  const argText = body.replace(/^\/profiles\b/i, "").trim();
  const { provider, profileId } = parseProfilesArgs(argText);
  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const overview = buildProfilesOverview(store);
  const commandPlugin = params.surface ? getChannelPlugin(params.surface)?.commands : null;

  if (!provider) {
    if (overview.length === 0) {
      return { text: "No auth profiles found.\n\nUse: /profiles <provider>" };
    }
    const channelData = commandPlugin?.buildProfilesProviderChannelData?.({
      providers: overview.map((entry) => ({
        id: entry.provider,
        count: entry.profileIds.length,
      })),
    });
    if (channelData) {
      return {
        text: "Select a provider:",
        channelData,
      };
    }
    return {
      text: [
        "Profiles by provider:",
        ...overview.map((entry) => `- ${entry.provider} (${entry.profileIds.length})`),
        "",
        "Use: /profiles <provider>",
        "Switch: /profiles <provider> <profile>",
      ].join("\n"),
    };
  }

  const providerProfiles = listProfilesForProvider(store, provider).toSorted();
  if (providerProfiles.length === 0) {
    return {
      text: [
        `Unknown provider or no profiles: ${provider}`,
        "",
        "Available providers:",
        ...overview.map((entry) => `- ${entry.provider}`),
      ].join("\n"),
    };
  }

  const currentProfileId = resolveCurrentProfileForProvider({
    provider,
    cfg: params.cfg,
    store,
    sessionEntry: params.sessionEntry,
  });

  if (!profileId) {
    const usageByProfile = await resolveProfileUsageSummaryByProfile({
      provider,
      profileIds: providerProfiles,
      cfg: params.cfg,
      sessionEntry: params.sessionEntry,
      agentDir: params.agentDir,
    });
    const channelData =
      commandPlugin?.buildProfilesListChannelData?.({
        provider,
        profiles: providerProfiles.map((id) => ({
          profileId: id,
          label: resolveProviderScopedProfileLabel({
            provider,
            profileId: id,
            cfg: params.cfg,
            store,
          }),
          isCurrent: id === currentProfileId,
        })),
      }) ?? undefined;
    return {
      text: [
        `Profiles (${provider}) — ${providerProfiles.length} available`,
        ...providerProfiles.map((id) =>
          formatProfileLine({
            provider,
            profileId: id,
            cfg: params.cfg,
            store,
            isCurrent: id === currentProfileId,
            usageSummary: usageByProfile.get(id),
          }),
        ),
        "",
        "Switch: /profiles <provider> <profile>",
      ].join("\n"),
      channelData,
    };
  }

  const selected = resolveRequestedProfileSelection({
    provider,
    profileId,
    providerProfiles,
  });
  if (selected.kind === "not-found") {
    return {
      text: [
        `Unknown profile for ${provider}: ${profileId}`,
        "",
        `Use: /profiles ${provider}`,
      ].join("\n"),
    };
  }
  if (selected.kind === "ambiguous") {
    return {
      text: [
        `Ambiguous profile for ${provider}: ${profileId}`,
        ...selected.profileIds.map((candidate) => `- ${candidate}`),
        "",
        `Use the full profile id: /profiles ${provider} <provider:id>`,
      ].join("\n"),
    };
  }
  if (selected.profileId === currentProfileId) {
    return { text: `Auth profile already set: ${selected.profileId}.` };
  }

  const didPersist = params.setProfile
    ? await params.setProfile(provider, selected.profileId)
    : false;
  if (!didPersist) {
    return {
      text: "Unable to persist auth profile override for this session.",
    };
  }

  return {
    text: `Auth profile set to ${selected.profileId} (${provider}).`,
  };
}

export const handleProfilesCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const commandBodyNormalized = params.command.commandBodyNormalized.trim();
  if (!commandBodyNormalized.startsWith("/profiles")) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/profiles");
  if (unauthorized) {
    return unauthorized;
  }

  const profilesAgentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  const profilesAgentDir = resolveAgentDir(params.cfg, profilesAgentId);

  const reply = await resolveProfilesCommandReply({
    cfg: params.cfg,
    commandBodyNormalized,
    surface: params.command.surface,
    sessionEntry: params.sessionEntry,
    agentDir: profilesAgentDir,
    setProfile: async (_provider, selectedProfileId) => {
      const entry = ensureSessionEntryForProfileSwitch({
        sessionEntry: params.sessionEntry,
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
      });
      if (!entry || !params.sessionStore || !params.sessionKey) {
        return false;
      }
      entry.authProfileOverride = selectedProfileId;
      entry.authProfileOverrideSource = "user";
      delete entry.authProfileOverrideCompactionCount;
      return await persistSessionEntry({
        ...params,
        sessionEntry: entry,
      });
    },
  });
  if (!reply) {
    return null;
  }
  return { reply, shouldContinue: false };
};
