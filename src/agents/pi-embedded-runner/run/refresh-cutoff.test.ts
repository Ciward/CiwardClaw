import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { applyRefreshCutoffToMessages } from "./refresh-cutoff.js";

describe("applyRefreshCutoffToMessages", () => {
  it("keeps all messages when no cutoff is set", () => {
    const messages = [
      { role: "user", content: "old", timestamp: 100 } as AgentMessage,
      { role: "assistant", content: "new", timestamp: 200 } as unknown as AgentMessage,
    ];
    expect(applyRefreshCutoffToMessages(messages)).toEqual(messages);
  });

  it("drops messages at or before the cutoff timestamp", () => {
    const messages = [
      { role: "user", content: "old", timestamp: 100 } as AgentMessage,
      { role: "assistant", content: "boundary", timestamp: 150 } as unknown as AgentMessage,
      { role: "user", content: "new", timestamp: 151 } as AgentMessage,
    ];
    expect(applyRefreshCutoffToMessages(messages, 150)).toEqual([
      { role: "user", content: "new", timestamp: 151 },
    ]);
  });

  it("drops legacy untimestamped messages once refresh becomes authoritative", () => {
    const messages = [
      { role: "user", content: "legacy" } as AgentMessage,
      { role: "assistant", content: "new", timestamp: 200 } as unknown as AgentMessage,
    ];
    expect(applyRefreshCutoffToMessages(messages, 150)).toEqual([
      { role: "assistant", content: "new", timestamp: 200 },
    ]);
  });
});
