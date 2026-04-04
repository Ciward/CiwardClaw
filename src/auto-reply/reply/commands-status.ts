import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { resolveModelAuthLabel } from "../../agents/model-auth-label.js";
import { listControlledSubagentRuns } from "../../agents/subagent-control.js";
import { countPendingDescendantRuns } from "../../agents/subagent-registry.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import { toAgentModelListLike } from "../../config/model-input.js";
import type { SessionEntry, SessionScope } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { loadProviderUsageSummary, resolveUsageProviderId } from "../../infra/provider-usage.js";
import type { MediaUnderstandingDecision } from "../../media-understanding/types.js";
import { normalizeGroupActivation } from "../group-activation.js";
import { resolveSelectedAndActiveModel } from "../model-runtime.js";
import { buildStatusMessage } from "../status.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { CommandContext } from "./commands-types.js";
import {
  formatUsageUnavailable,
  resolveProfileUsageAuthBinding,
  resolveScopedUsageSummary,
} from "./profile-usage.js";
import { getFollowupQueueDepth, resolveQueueSettings } from "./queue.js";
import { resolveSubagentLabel } from "./subagents-utils.js";

export function resolveStatusUsageLine(params: {
  usageEntry?: Parameters<typeof resolveScopedUsageSummary>[0]["usageEntry"];
  profileScopeLabel?: string;
  now?: number;
}): string | null {
  const summary = resolveScopedUsageSummary(params);
  return summary ? `📊 Usage: ${summary}` : null;
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
  const currentUsageProvider = (() => {
    try {
      return resolveUsageProviderId(provider);
    } catch {
      return undefined;
    }
  })();
  let usageLine: string | null = null;
  if (currentUsageProvider) {
    let usageBinding: Awaited<ReturnType<typeof resolveProfileUsageAuthBinding>> | undefined;
    try {
      usageBinding = await resolveProfileUsageAuthBinding({
        provider: currentUsageProvider,
        cfg,
        sessionEntry,
        agentDir: statusAgentDir,
      });
      const usageSummaryTimeoutMs = 3500;
      let usageTimeout: NodeJS.Timeout | undefined;
      const usageSummary = await Promise.race([
        loadProviderUsageSummary({
          timeoutMs: usageSummaryTimeoutMs,
          providers: [currentUsageProvider],
          auth: usageBinding.authInput,
          agentDir: statusAgentDir,
        }),
        new Promise<never>((_, reject) => {
          usageTimeout = setTimeout(
            () => reject(new Error("usage summary timeout")),
            usageSummaryTimeoutMs,
          );
        }),
      ]).finally(() => {
        if (usageTimeout) {
          clearTimeout(usageTimeout);
        }
      });
      const usageSummaryLine = resolveScopedUsageSummary({
        usageEntry: usageSummary.providers[0],
        profileScopeLabel: usageBinding.profileScopeLabel,
      });
      usageLine = usageSummaryLine ? `📊 Usage: ${usageSummaryLine}` : null;
    } catch {
      usageLine = `📊 Usage: ${formatUsageUnavailable({
        reason: "request failed",
        profileScopeLabel: usageBinding?.profileScopeLabel,
      })}`;
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
    const runs = listControlledSubagentRuns(requesterKey);
    const verboseEnabled = resolvedVerboseLevel && resolvedVerboseLevel !== "off";
    if (runs.length > 0) {
      const active = runs.filter(
        (entry) => !entry.endedAt || countPendingDescendantRuns(entry.childSessionKey) > 0,
      );
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
  const agentDefaults = cfg.agents?.defaults ?? {};
  const agentConfig = resolveAgentConfig(cfg, statusAgentId);
  const effectiveFastMode =
    resolvedFastMode ??
    resolveFastModeState({
      cfg,
      provider,
      model,
      agentId: statusAgentId,
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
      thinkingDefault: agentConfig?.thinkingDefault ?? agentDefaults.thinkingDefault,
      verboseDefault: agentDefaults.verboseDefault,
      elevatedDefault: agentDefaults.elevatedDefault,
    },
    agentId: statusAgentId,
    explicitConfiguredContextTokens:
      typeof agentDefaults.contextTokens === "number" && agentDefaults.contextTokens > 0
        ? agentDefaults.contextTokens
        : undefined,
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
    includeTranscriptUsage: true,
  });

  return { text: statusText };
}
