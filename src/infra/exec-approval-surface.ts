import { getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";

export type ExecApprovalInitiatingSurfaceState =
  | { kind: "enabled"; channel: string | undefined; channelLabel: string }
  | { kind: "disabled"; channel: string; channelLabel: string }
  | { kind: "unsupported"; channel: string; channelLabel: string };

function labelForChannel(channel?: string): string {
  switch (channel) {
    case "discord":
      return "Discord";
    case "telegram":
      return "Telegram";
    case "tui":
      return "terminal UI";
    case INTERNAL_MESSAGE_CHANNEL:
      return "Web UI";
    default:
      return channel ? channel[0]?.toUpperCase() + channel.slice(1) : "this platform";
  }
}

export function resolveExecApprovalInitiatingSurfaceState(params: {
  channel?: string | null;
  accountId?: string | null;
  cfg?: OpenClawConfig;
}): ExecApprovalInitiatingSurfaceState {
  const channel = normalizeMessageChannel(params.channel);
  const channelLabel = labelForChannel(channel);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return { kind: "enabled", channel, channelLabel };
  }

  const cfg = params.cfg ?? loadConfig();
  const state = getChannelPlugin(channel)?.execApprovals?.getInitiatingSurfaceState?.({
    cfg,
    accountId: params.accountId,
  });
  if (state) {
    return { ...state, channel, channelLabel };
  }
  return { kind: "unsupported", channel, channelLabel };
}

export function hasConfiguredExecApprovalDmRoute(cfg: OpenClawConfig): boolean {
  const execApprovals = cfg.approvals?.exec;
  const mode = execApprovals?.mode ?? "session";
  const hasValidGlobalTarget =
    execApprovals?.enabled === true &&
    (mode === "targets" || mode === "both") &&
    Array.isArray(execApprovals.targets) &&
    execApprovals.targets.some((target) => {
      const channel = normalizeMessageChannel(target?.channel);
      const to = typeof target?.to === "string" ? target.to.trim() : "";
      return Boolean(channel && isDeliverableMessageChannel(channel) && to);
    });

  if (hasValidGlobalTarget) {
    return true;
  }

  return listChannelPlugins().some(
    (plugin) => plugin.execApprovals?.hasConfiguredDmRoute?.({ cfg }) ?? false,
  );
}
