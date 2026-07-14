// Tracks sender-bound Telegram middleware lanes so steer input can bypass grammY's
// conversation sequentializer without granting another sender the same activation.
const activeDispatchCounts = new Map<string, number>();

function resolveActiveDispatchKey(key: string, senderId: string | undefined): string | undefined {
  const normalizedKey = key.trim();
  const normalizedSenderId = senderId?.trim();
  if (!normalizedKey || !normalizedSenderId) {
    return undefined;
  }
  return `${normalizedKey}\u0000${normalizedSenderId}`;
}

export function markTelegramDispatchActive(key: string, senderId: string | undefined): void {
  const dispatchKey = resolveActiveDispatchKey(key, senderId);
  if (!dispatchKey) {
    return;
  }
  activeDispatchCounts.set(dispatchKey, (activeDispatchCounts.get(dispatchKey) ?? 0) + 1);
}

export function clearTelegramDispatchActive(key: string, senderId: string | undefined): void {
  const dispatchKey = resolveActiveDispatchKey(key, senderId);
  if (!dispatchKey) {
    return;
  }
  const count = activeDispatchCounts.get(dispatchKey) ?? 0;
  if (count <= 1) {
    activeDispatchCounts.delete(dispatchKey);
    return;
  }
  activeDispatchCounts.set(dispatchKey, count - 1);
}

export function isTelegramDispatchActive(key: string, senderId: string | undefined): boolean {
  const dispatchKey = resolveActiveDispatchKey(key, senderId);
  return dispatchKey ? (activeDispatchCounts.get(dispatchKey) ?? 0) > 0 : false;
}

const TELEGRAM_STEER_FOLLOWUP = Symbol.for("openclaw.telegram.steerFollowup");

export function markTelegramSteerFollowup(ctx: object): void {
  Object.defineProperty(ctx, TELEGRAM_STEER_FOLLOWUP, {
    configurable: true,
    value: true,
  });
}

export function isTelegramSteerFollowup(ctx: unknown): boolean {
  if ((typeof ctx !== "object" && typeof ctx !== "function") || ctx === null) {
    return false;
  }
  return (ctx as Record<PropertyKey, unknown>)[TELEGRAM_STEER_FOLLOWUP] === true;
}
