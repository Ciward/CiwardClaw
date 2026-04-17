import { createActiveDispatchTracker } from "openclaw/plugin-sdk/channel-lifecycle";

const tracker = createActiveDispatchTracker();

export function markTelegramDispatchActive(key: string): void {
  tracker.mark(key);
}

export function clearTelegramDispatchActive(key: string): void {
  tracker.clear(key);
}

export function isTelegramDispatchActive(key: string): boolean {
  return tracker.isActive(key);
}
