import type { AgentMessage } from "@mariozechner/pi-agent-core";

export function applyRefreshCutoffToMessages(
  messages: AgentMessage[],
  refreshCutoffTimestamp?: number,
): AgentMessage[] {
  if (typeof refreshCutoffTimestamp !== "number" || !Number.isFinite(refreshCutoffTimestamp)) {
    return messages;
  }
  return messages.filter((message) => {
    const timestamp = (message as { timestamp?: unknown }).timestamp;
    return typeof timestamp === "number" && Number.isFinite(timestamp)
      ? timestamp > refreshCutoffTimestamp
      : false;
  });
}
