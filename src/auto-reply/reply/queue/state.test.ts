// Tests queue state storage, dedupe, and cleanup primitives.
import { afterEach, describe, expect, it } from "vitest";
import {
  clearFollowupQueue,
  getExistingFollowupQueue,
  getFollowupQueue,
  refreshQueuedFollowupSession,
  restoreFollowupQueueItemsToFront,
  takeFollowupQueueItems,
} from "./state.js";
import type { FollowupRun } from "./types.js";

const QUEUE_KEY = "agent:main:dm:test";

afterEach(() => {
  clearFollowupQueue(QUEUE_KEY);
});

function makeRun(): FollowupRun["run"] {
  return {
    agentId: "main",
    agentDir: "/tmp/agent",
    sessionId: "session-1",
    sessionKey: QUEUE_KEY,
    sessionFile: "/tmp/session-1.jsonl",
    workspaceDir: "/tmp/workspace",
    config: {} as FollowupRun["run"]["config"],
    provider: "anthropic",
    model: "claude-opus-4-6",
    authProfileId: "profile-a",
    authProfileIdSource: "user",
    timeoutMs: 30_000,
    blockReplyBreak: "message_end",
  };
}

describe("refreshQueuedFollowupSession", () => {
  it("retargets queued runs to the persisted selection", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    const lastRun = makeRun();
    const queuedRun: FollowupRun = {
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    const summarizedRun: FollowupRun = {
      prompt: "summarized message",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    queue.lastRun = lastRun;
    queue.items.push(queuedRun);
    queue.summarySources.push(summarizedRun);
    queue.summaryElisions.push({
      contextKey: "context",
      count: 2,
      source: {
        prompt: "elided summary",
        enqueuedAt: Date.now(),
        run: makeRun(),
      },
      sourceRefs: new WeakSet(),
    });

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "openai",
      nextModel: "gpt-4o",
      nextAuthProfileId: undefined,
      nextAuthProfileIdSource: undefined,
    });

    expect(queue.lastRun).toEqual({
      ...makeRun(),
      provider: "openai",
      model: "gpt-4o",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(queue.items[0]?.run).toEqual({
      ...makeRun(),
      provider: "openai",
      model: "gpt-4o",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(queue.summarySources[0]?.run).toEqual({
      ...makeRun(),
      provider: "openai",
      model: "gpt-4o",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(queue.summaryElisions[0]?.source.run).toEqual({
      ...makeRun(),
      provider: "openai",
      model: "gpt-4o",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("retargets queued runs with user model override source", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    const queuedRun: FollowupRun = {
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: { ...makeRun(), hasAutoFallbackProvenance: true },
    };
    queue.items.push(queuedRun);

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextProvider: "ollama",
      nextModel: "qwen3.5:27b",
      nextModelOverrideSource: "user",
    });

    expect(queue.items[0]?.run).toEqual({
      ...makeRun(),
      provider: "ollama",
      model: "qwen3.5:27b",
      hasSessionModelOverride: true,
      modelOverrideSource: "user",
    });
  });
});

describe("getFollowupQueue", () => {
  it("trims overflow metadata when a live queue cap shrinks", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 3 });
    for (const [contextKey, count] of [
      ["oldest", 2],
      ["middle", 3],
      ["newest", 4],
    ] as const) {
      queue.summaryElisions.push({
        contextKey,
        count,
        source: {
          prompt: contextKey,
          enqueuedAt: Date.now(),
          run: makeRun(),
        },
        sourceRefs: new WeakSet(),
      });
    }
    queue.evictedSummaryCount = 5;

    const updated = getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 1 });

    expect(updated.summaryElisions.map((entry) => entry.contextKey)).toEqual(["newest"]);
    expect(updated.evictedSummaryCount).toBe(10);
  });
});

describe("takeFollowupQueueItems", () => {
  it("removes matching queued items while keeping the rest queued", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "steer" });
    const first: FollowupRun = {
      prompt: "merge me",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    const second: FollowupRun = {
      prompt: "keep me",
      enqueuedAt: Date.now(),
      run: makeRun(),
      images: [{ type: "image", data: "base64", mimeType: "image/png" }],
    };
    queue.items.push(first, second);

    const taken = takeFollowupQueueItems(QUEUE_KEY, (item) => !item.images?.length);

    expect(taken).toEqual([first]);
    expect(getExistingFollowupQueue(QUEUE_KEY)?.items).toEqual([second]);
  });

  it("does not skip nonmatching queued items to take later matches", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "steer" });
    const first: FollowupRun = {
      prompt: "keep me first",
      enqueuedAt: Date.now(),
      run: makeRun(),
      images: [{ type: "image", data: "base64", mimeType: "image/png" }],
    };
    const second: FollowupRun = {
      prompt: "do not overtake",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    queue.items.push(first, second);

    const taken = takeFollowupQueueItems(QUEUE_KEY, (item) => !item.images?.length);

    expect(taken).toEqual([]);
    expect(getExistingFollowupQueue(QUEUE_KEY)?.items).toEqual([first, second]);
  });

  it("does not take live items while older summary work is pending", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "steer" });
    const run: FollowupRun = {
      prompt: "newer live item",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    const summarySource: FollowupRun = {
      prompt: "older summarized item",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    queue.items.push(run);
    queue.summaryLines.push("older summarized item");
    queue.summarySources.push(summarySource);

    expect(takeFollowupQueueItems(QUEUE_KEY, () => true)).toEqual([]);
    expect(getExistingFollowupQueue(QUEUE_KEY)?.items).toEqual([run]);
  });

  it("deletes the queue when no work remains", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "steer" });
    const run: FollowupRun = {
      prompt: "merge me",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    queue.items.push(run);

    expect(takeFollowupQueueItems(QUEUE_KEY, () => true)).toEqual([run]);

    expect(getExistingFollowupQueue(QUEUE_KEY)).toBeUndefined();
  });
});

describe("restoreFollowupQueueItemsToFront", () => {
  it("recreates a deleted queue and restores taken items in front order", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "steer" });
    const first: FollowupRun = {
      prompt: "first",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    const second: FollowupRun = {
      prompt: "second",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    queue.items.push(first, second);

    const taken = takeFollowupQueueItems(QUEUE_KEY, () => true);

    expect(getExistingFollowupQueue(QUEUE_KEY)).toBeUndefined();
    expect(restoreFollowupQueueItemsToFront(QUEUE_KEY, { mode: "steer" }, taken)).toBe(2);
    expect(getExistingFollowupQueue(QUEUE_KEY)?.items).toEqual([first, second]);
  });

  it("prepends restored items ahead of newer queued work", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "steer" });
    const first: FollowupRun = {
      prompt: "first",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    const second: FollowupRun = {
      prompt: "second",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    const newer: FollowupRun = {
      prompt: "newer",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    queue.items.push(first, newer);

    const taken = takeFollowupQueueItems(QUEUE_KEY, (item) => item.prompt === "first");
    getExistingFollowupQueue(QUEUE_KEY)?.items.push(second);

    expect(restoreFollowupQueueItemsToFront(QUEUE_KEY, { mode: "steer" }, taken)).toBe(1);
    expect(getExistingFollowupQueue(QUEUE_KEY)?.items).toEqual([first, newer, second]);
  });
});
