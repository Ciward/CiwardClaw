// Agent Core tests provider-native compaction replacement context behavior.
import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  ProviderStateContent,
  UserMessage,
} from "../../../../llm-core/src/index.js";
import type { SessionTreeEntry } from "../types.js";
import { buildSessionContext } from "./session.js";

const oldUser: UserMessage = {
  role: "user",
  content: "old history",
  timestamp: 1,
};

const replacement: AssistantMessage = {
  role: "assistant",
  api: "openai-responses",
  provider: "tokenlab",
  model: "gpt-5.6-terra",
  content: [
    {
      type: "providerState",
      state: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "TASK-42" }],
        },
        {
          type: "compaction",
          encrypted_content: "opaque-state",
        },
      ],
    } satisfies ProviderStateContent,
  ],
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 2,
};

describe("buildSessionContext provider-native compaction", () => {
  it("atomically replaces old history and keeps messages appended after compaction", () => {
    const newerUser: UserMessage = {
      role: "user",
      content: "continue TASK-42",
      timestamp: 4,
    };
    const entries: SessionTreeEntry[] = [
      {
        type: "message",
        id: "old-user",
        parentId: null,
        timestamp: "2026-07-24T00:00:00.000Z",
        message: oldUser,
      },
      {
        type: "compaction",
        id: "compact-1",
        parentId: "old-user",
        timestamp: "2026-07-24T00:01:00.000Z",
        summary: "provider-native compacted state",
        firstKeptEntryId: "old-user",
        tokensBefore: 40_000,
        replacementMessages: [replacement],
      },
      {
        type: "message",
        id: "new-user",
        parentId: "compact-1",
        timestamp: "2026-07-24T00:02:00.000Z",
        message: newerUser,
      },
    ];

    expect(buildSessionContext(entries).messages).toEqual([replacement, newerUser]);
  });
});
