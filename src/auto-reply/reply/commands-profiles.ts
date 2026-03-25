import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveAuthProfileDisplayLabel,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
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

const MAX_TELEGRAM_CALLBACK_DATA_BYTES = 64;

function buildProfileSelectionCallbackData(params: {
  provider: string;
  profileId: string;
}): string | null {
  const callbackData = `/profiles ${params.provider} ${params.profileId}`;
  return Buffer.byteLength(callbackData, "utf8") <= MAX_TELEGRAM_CALLBACK_DATA_BYTES
    ? callbackData
    : null;
}

function buildProfilesProviderCallbackData(provider: string): string | null {
  const callbackData = `/profiles ${provider}`;
  return Buffer.byteLength(callbackData, "utf8") <= MAX_TELEGRAM_CALLBACK_DATA_BYTES
    ? callbackData
    : null;
}

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
  cfg: Parameters<typeof resolveAuthProfileOrder>[0]["cfg"];
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

function formatProfileLine(params: {
  profileId: string;
  cfg: Parameters<typeof resolveAuthProfileDisplayLabel>[0]["cfg"];
  store: ReturnType<typeof ensureAuthProfileStore>;
  isCurrent: boolean;
}): string {
  const display = resolveAuthProfileDisplayLabel({
    cfg: params.cfg,
    store: params.store,
    profileId: params.profileId,
  });
  return `${params.isCurrent ? "* " : "- "}${display}`;
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

  if (!provider) {
    if (overview.length === 0) {
      return { text: "No auth profiles found.\n\nUse: /profiles <provider>" };
    }
    const lines = [
      "Profiles by provider:",
      ...overview.map((entry) => `- ${entry.provider} (${entry.profileIds.length})`),
      "",
      "Use: /profiles <provider>",
      "Switch: /profiles <provider> <profile>",
    ];

    if (params.surface === "telegram") {
      const buttons = overview
        .map((entry) => {
          const callbackData = buildProfilesProviderCallbackData(entry.provider);
          if (!callbackData) {
            return null;
          }
          return [
            {
              text: `${entry.provider} (${entry.profileIds.length})`,
              callback_data: callbackData,
            },
          ];
        })
        .filter(Boolean) as Array<Array<{ text: string; callback_data: string }>>;
      if (buttons.length > 0) {
        return {
          text: "Select a provider:",
          channelData: { telegram: { buttons } },
        };
      }
    }
    return { text: lines.join("\n") };
  }

  const providerProfiles = listProfilesForProvider(store, provider).toSorted();
  if (providerProfiles.length === 0) {
    const lines = [
      `Unknown provider or no profiles: ${provider}`,
      "",
      "Available providers:",
      ...overview.map((entry) => `- ${entry.provider}`),
    ];
    return { text: lines.join("\n") };
  }

  const currentProfileId = resolveCurrentProfileForProvider({
    provider,
    cfg: params.cfg,
    store,
    sessionEntry: params.sessionEntry,
  });

  if (!profileId) {
    const lines = [
      `Profiles (${provider}) — ${providerProfiles.length} available`,
      ...providerProfiles.map((id) =>
        formatProfileLine({
          profileId: id,
          cfg: params.cfg,
          store,
          isCurrent: id === currentProfileId,
        }),
      ),
      "",
      "Switch: /profiles <provider> <profile>",
    ];

    if (params.surface === "telegram") {
      const buttons = providerProfiles
        .map((id) => {
          const callbackData = buildProfileSelectionCallbackData({ provider, profileId: id });
          if (!callbackData) {
            return null;
          }
          const isCurrent = id === currentProfileId;
          return [{ text: isCurrent ? `${id} ✓` : id, callback_data: callbackData }];
        })
        .filter(Boolean) as Array<Array<{ text: string; callback_data: string }>>;
      if (buttons.length > 0) {
        return {
          text: lines.join("\n"),
          channelData: { telegram: { buttons } },
        };
      }
    }

    return { text: lines.join("\n") };
  }

  const normalizedProfileId = profileId.trim();
  if (!providerProfiles.includes(normalizedProfileId)) {
    return {
      text: [
        `Unknown profile for ${provider}: ${normalizedProfileId}`,
        "",
        `Use: /profiles ${provider}`,
      ].join("\n"),
    };
  }
  if (normalizedProfileId === currentProfileId) {
    return { text: `Auth profile already set: ${normalizedProfileId}.` };
  }

  const didPersist = params.setProfile
    ? await params.setProfile(provider, normalizedProfileId)
    : false;
  if (!didPersist) {
    return {
      text: "⚠️ Unable to persist auth profile override for this session.",
    };
  }

  return {
    text: `Auth profile set to ${normalizedProfileId} (${provider}).`,
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
    surface: params.ctx.Surface,
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
