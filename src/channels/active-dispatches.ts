export type ActiveDispatchTracker = {
  mark: (key: string) => void;
  clear: (key: string) => void;
  isActive: (key: string) => boolean;
};

export function createActiveDispatchTracker(): ActiveDispatchTracker {
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
