// Tracks in-flight Telegram dispatches per sequential key. Under steer queue
// mode, grammY `sequentialize` would serialize a follow-up update behind the
// active run (same key), so the follow-up never reaches the active run's steer
// injection. The bot routes such follow-ups onto a unique `:steer:` key to run
// concurrently; this counter tells it when a dispatch for the key is already
// active. Mark on dispatch start, clear on dispatch end (see bot-message.ts);
// the sequentialize key resolver reads it (see bot-core.ts).
type ActiveDispatchTracker = {
  mark: (key: string) => void;
  clear: (key: string) => void;
  isActive: (key: string) => boolean;
};

function createActiveDispatchTracker(): ActiveDispatchTracker {
  const counts = new Map<string, number>();

  return {
    mark(key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    clear(key) {
      const count = counts.get(key) ?? 0;
      if (count <= 1) {
        counts.delete(key);
        return;
      }
      counts.set(key, count - 1);
    },
    isActive(key) {
      return (counts.get(key) ?? 0) > 0;
    },
  };
}

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
