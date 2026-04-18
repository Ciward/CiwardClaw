import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { estimateMessagesTokens } from "../../agents/compaction.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { normalizeCommandBody } from "../commands-registry-normalize.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";

const THREAD_CHANNEL = "thread-chat";
const ROOM_CHANNEL = "room-chat";
const TOPIC_CHANNEL = "topic-chat";

type ResolveCommandConversationParams = {
  threadId?: string;
  threadParentId?: string;
  parentSessionKey?: string;
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
};

function firstText(values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim() ?? "").find(Boolean) || undefined;
}

function normalizeCommandContextText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim().toLowerCase();
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).trim().toLowerCase();
  }
  return "";
}

function resolveThreadTargetId(raw?: string): string | undefined {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^thread-chat:/i, "")
    .replace(/^channel:/i, "")
    .trim();
}

function resolveThreadCommandConversation(params: ResolveCommandConversationParams) {
  const parentConversationId = firstText([
    resolveThreadTargetId(params.threadParentId),
    resolveThreadTargetId(params.originatingTo),
    resolveThreadTargetId(params.commandTo),
    resolveThreadTargetId(params.fallbackTo),
  ]);
  if (params.threadId) {
    return {
      conversationId: params.threadId,
      ...(parentConversationId ? { parentConversationId } : {}),
    };
  }
  return parentConversationId ? { conversationId: parentConversationId } : null;
}

function resolveRoomId(raw?: string): string | undefined {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^room-chat:/i, "")
    .replace(/^(room|channel):/i, "")
    .trim();
}

function resolveRoomCommandConversation(params: ResolveCommandConversationParams) {
  const parentConversationId = firstText([
    resolveRoomId(params.originatingTo),
    resolveRoomId(params.commandTo),
    resolveRoomId(params.fallbackTo),
  ]);
  if (params.threadId) {
    return {
      conversationId: params.threadId,
      ...(parentConversationId ? { parentConversationId } : {}),
    };
  }
  return parentConversationId ? { conversationId: parentConversationId } : null;
}

function resolveTopicCommandConversation(params: ResolveCommandConversationParams) {
  const chatId = firstText([params.originatingTo, params.commandTo, params.fallbackTo])
    ?.replace(/^topic-chat:/i, "")
    .trim();
  if (!chatId) {
    return null;
  }
  if (params.threadId) {
    return {
      conversationId: `${chatId}:topic:${params.threadId}`,
      parentConversationId: chatId,
    };
  }
  if (chatId.startsWith("-")) {
    return null;
  }
  return {
    conversationId: chatId,
    parentConversationId: chatId,
  };
}

const hoisted = vi.hoisted(() => {
  const threadChannel = "thread-chat";
  const roomChannel = "room-chat";
  const topicChannel = "topic-chat";
  const setThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  const setThreadBindingMaxAgeBySessionKeyMock = vi.fn();
  const setMatrixThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  const setMatrixThreadBindingMaxAgeBySessionKeyMock = vi.fn();
  const setTelegramThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  const setTelegramThreadBindingMaxAgeBySessionKeyMock = vi.fn();
  const sessionBindingResolveByConversationMock = vi.fn();
  const clearBootstrapSnapshotMock = vi.fn();
  const runtimeChannelRegistry = {
    channels: [
      {
        plugin: {
          id: threadChannel,
          meta: {},
          config: {
            hasPersistedAuthState: () => false,
          },
          bindings: {
            resolveCommandConversation: resolveThreadCommandConversation,
          },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
            setIdleTimeoutBySessionKey: setThreadBindingIdleTimeoutBySessionKeyMock,
            setMaxAgeBySessionKey: setThreadBindingMaxAgeBySessionKeyMock,
          },
        },
      },
      {
        plugin: {
          id: roomChannel,
          meta: {},
          config: {
            hasPersistedAuthState: () => false,
          },
          bindings: {
            resolveCommandConversation: resolveRoomCommandConversation,
          },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
            setIdleTimeoutBySessionKey: setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
            setMaxAgeBySessionKey: setMatrixThreadBindingMaxAgeBySessionKeyMock,
          },
        },
      },
      {
        plugin: {
          id: topicChannel,
          meta: {},
          config: {
            hasPersistedAuthState: () => false,
          },
          bindings: {
            resolveCommandConversation: resolveTopicCommandConversation,
          },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
            setIdleTimeoutBySessionKey: setTelegramThreadBindingIdleTimeoutBySessionKeyMock,
            setMaxAgeBySessionKey: setTelegramThreadBindingMaxAgeBySessionKeyMock,
          },
        },
      },
    ],
  };
  return {
    setThreadBindingIdleTimeoutBySessionKeyMock,
    setThreadBindingMaxAgeBySessionKeyMock,
    setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
    setMatrixThreadBindingMaxAgeBySessionKeyMock,
    setTelegramThreadBindingIdleTimeoutBySessionKeyMock,
    setTelegramThreadBindingMaxAgeBySessionKeyMock,
    sessionBindingResolveByConversationMock,
    clearBootstrapSnapshotMock,
    runtimeChannelRegistry,
  };
});

vi.mock("../../plugins/runtime.js", () => {
  return {
    getActivePluginRegistry: () => hoisted.runtimeChannelRegistry,
    requireActivePluginRegistry: () => hoisted.runtimeChannelRegistry,
    getActivePluginChannelRegistry: () => hoisted.runtimeChannelRegistry,
    requireActivePluginChannelRegistry: () => hoisted.runtimeChannelRegistry,
    getActivePluginRegistryVersion: () => 1,
    getActivePluginChannelRegistryVersion: () => 1,
  };
});

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (channelId: string) =>
    hoisted.runtimeChannelRegistry.channels.find((entry) => entry.plugin.id === channelId)?.plugin,
  normalizeChannelId: (raw?: string | null) => {
    const normalized = raw?.trim().toLowerCase();
    return normalized || null;
  },
}));

vi.mock("../../channels/plugins/conversation-bindings.js", () => ({
  setChannelConversationBindingIdleTimeoutBySessionKey: (params: {
    channelId: string;
    targetSessionKey: string;
    accountId?: string | null;
    idleTimeoutMs: number;
  }) => {
    if (params.channelId === THREAD_CHANNEL) {
      return hoisted.setThreadBindingIdleTimeoutBySessionKeyMock({
        targetSessionKey: params.targetSessionKey,
        accountId: params.accountId,
        idleTimeoutMs: params.idleTimeoutMs,
      });
    }
    if (params.channelId === ROOM_CHANNEL) {
      return hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock({
        targetSessionKey: params.targetSessionKey,
        accountId: params.accountId,
        idleTimeoutMs: params.idleTimeoutMs,
      });
    }
    if (params.channelId === TOPIC_CHANNEL) {
      return hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock({
        targetSessionKey: params.targetSessionKey,
        accountId: params.accountId,
        idleTimeoutMs: params.idleTimeoutMs,
      });
    }
    return [];
  },
  setChannelConversationBindingMaxAgeBySessionKey: (params: {
    channelId: string;
    targetSessionKey: string;
    accountId?: string | null;
    maxAgeMs: number;
  }) => {
    if (params.channelId === THREAD_CHANNEL) {
      return hoisted.setThreadBindingMaxAgeBySessionKeyMock({
        targetSessionKey: params.targetSessionKey,
        accountId: params.accountId,
        maxAgeMs: params.maxAgeMs,
      });
    }
    if (params.channelId === ROOM_CHANNEL) {
      return hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock({
        targetSessionKey: params.targetSessionKey,
        accountId: params.accountId,
        maxAgeMs: params.maxAgeMs,
      });
    }
    if (params.channelId === TOPIC_CHANNEL) {
      return hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock({
        targetSessionKey: params.targetSessionKey,
        accountId: params.accountId,
        maxAgeMs: params.maxAgeMs,
      });
    }
    return [];
  },
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => {
  return {
    getSessionBindingService: () => ({
      bind: vi.fn(),
      getCapabilities: vi.fn(),
      listBySession: vi.fn(),
      resolveByConversation: (ref: unknown) => hoisted.sessionBindingResolveByConversationMock(ref),
      touch: vi.fn(),
      unbind: vi.fn(),
    }),
  };
});

vi.mock("../../agents/bootstrap-cache.js", () => ({
  clearBootstrapSnapshot: (sessionKey: string) => hoisted.clearBootstrapSnapshotMock(sessionKey),
}));

let handleRefreshCommand: (typeof import("./commands-session.js"))["handleRefreshCommand"];
let handleSessionCommand: (typeof import("./commands-session.js"))["handleSessionCommand"];
const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;
const cfgWithCliBackend = {
  ...baseCfg,
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": { command: "claude" },
      },
    },
  },
} satisfies OpenClawConfig;

function buildSessionCommandParams(
  commandBody: string,
  ctxOverrides?: Record<string, unknown>,
): HandleCommandsParams {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "whatsapp",
    Surface: "whatsapp",
    From: "+1222",
    To: "+1222",
    SenderId: "user-1",
    ...ctxOverrides,
  } as HandleCommandsParams["ctx"];
  const channel = normalizeCommandContextText(ctx.Provider ?? ctx.Surface);
  const senderId = typeof ctx.SenderId === "string" ? ctx.SenderId : undefined;
  return {
    ctx,
    cfg: baseCfg,
    command: {
      surface: normalizeCommandContextText(ctx.Surface ?? ctx.Provider),
      channel,
      channelId: channel,
      ownerList: [],
      senderIsOwner: false,
      isAuthorizedSender: true,
      senderId,
      abortKey: senderId,
      rawBodyNormalized: commandBody.trim(),
      commandBodyNormalized: normalizeCommandBody(commandBody.trim()),
      from: typeof ctx.From === "string" ? ctx.From : undefined,
      to: typeof ctx.To === "string" ? ctx.To : undefined,
    },
    directives: parseInlineDirectives(commandBody),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: channel,
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
}

function createThreadCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildSessionCommandParams(commandBody, {
    Provider: THREAD_CHANNEL,
    Surface: THREAD_CHANNEL,
    OriginatingChannel: THREAD_CHANNEL,
    OriginatingTo: "channel:thread-1",
    AccountId: "default",
    MessageThreadId: "thread-1",
    ...overrides,
  });
}

function createTopicCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildSessionCommandParams(commandBody, {
    Provider: TOPIC_CHANNEL,
    Surface: TOPIC_CHANNEL,
    OriginatingChannel: TOPIC_CHANNEL,
    OriginatingTo: "-100200300:topic:77",
    AccountId: "default",
    MessageThreadId: "77",
    ...overrides,
  });
}

function createRoomThreadCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildSessionCommandParams(commandBody, {
    Provider: ROOM_CHANNEL,
    Surface: ROOM_CHANNEL,
    OriginatingChannel: ROOM_CHANNEL,
    OriginatingTo: "room:!room:example.org",
    AccountId: "default",
    MessageThreadId: "$thread-1",
    ...overrides,
  });
}

function createRoomTriggerThreadCommandParams(
  commandBody: string,
  overrides?: Record<string, unknown>,
) {
  return buildSessionCommandParams(commandBody, {
    Provider: ROOM_CHANNEL,
    Surface: ROOM_CHANNEL,
    OriginatingChannel: ROOM_CHANNEL,
    OriginatingTo: "room:!room:example.org",
    AccountId: "default",
    MessageThreadId: "$root",
    ...overrides,
  });
}

function createRoomCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildSessionCommandParams(commandBody, {
    Provider: ROOM_CHANNEL,
    Surface: ROOM_CHANNEL,
    OriginatingChannel: ROOM_CHANNEL,
    OriginatingTo: "room:!room:example.org",
    AccountId: "default",
    ...overrides,
  });
}

function createThreadBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "default:thread-1",
    targetSessionKey: "agent:main:subagent:child",
    targetKind: "subagent",
    conversation: {
      channel: THREAD_CHANNEL,
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "thread-1",
    },
    status: "active",
    boundAt: Date.now(),
    metadata: {
      boundBy: "user-1",
      lastActivityAt: Date.now(),
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
    },
    ...overrides,
  };
}

function createTopicBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "default:-100200300:topic:77",
    targetSessionKey: "agent:main:subagent:child",
    targetKind: "subagent",
    conversation: {
      channel: TOPIC_CHANNEL,
      accountId: "default",
      conversationId: "-100200300:topic:77",
    },
    status: "active",
    boundAt: Date.now(),
    metadata: {
      boundBy: "user-1",
      lastActivityAt: Date.now(),
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
    },
    ...overrides,
  };
}

function createRoomBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "default:$thread-1",
    targetSessionKey: "agent:main:subagent:child",
    targetKind: "subagent",
    conversation: {
      channel: ROOM_CHANNEL,
      accountId: "default",
      conversationId: "$thread-1",
      parentConversationId: "!room:example.org",
    },
    status: "active",
    boundAt: Date.now(),
    metadata: {
      boundBy: "user-1",
      lastActivityAt: Date.now(),
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
    },
    ...overrides,
  };
}

function createRoomTriggerBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return createRoomBinding({
    bindingId: "default:$root",
    conversation: {
      channel: ROOM_CHANNEL,
      accountId: "default",
      conversationId: "$root",
      parentConversationId: "!room:example.org",
    },
    ...overrides,
  });
}

function expectIdleTimeoutSetReply(
  mock: ReturnType<typeof vi.fn>,
  text: string,
  idleTimeoutMs: number,
  idleTimeoutLabel: string,
) {
  expect(mock).toHaveBeenCalledWith({
    targetSessionKey: "agent:main:subagent:child",
    accountId: "default",
    idleTimeoutMs,
  });
  expect(text).toContain(`Idle timeout set to ${idleTimeoutLabel}`);
  expect(text).toContain("2026-02-20T02:00:00.000Z");
}

describe("/session idle and /session max-age", () => {
  beforeEach(async () => {
    if (!handleRefreshCommand || !handleSessionCommand) {
      ({ handleRefreshCommand, handleSessionCommand } = await import("./commands-session.js"));
    }
  });

  beforeEach(() => {
    hoisted.setThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.sessionBindingResolveByConversationMock.mockReset().mockReturnValue(null);
    hoisted.clearBootstrapSnapshotMock.mockReset();
    vi.useRealTimers();
  });

  it("sets idle timeout for the focused thread-chat session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createThreadBinding());
    hoisted.setThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt: Date.now(),
        lastActivityAt: Date.now(),
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(createThreadCommandParams("/session idle 2h"), true);
    const text = result?.reply?.text ?? "";

    expectIdleTimeoutSetReply(
      hoisted.setThreadBindingIdleTimeoutBySessionKeyMock,
      text,
      2 * 60 * 60 * 1000,
      "2h",
    );
  });

  it("shows active idle timeout when no value is provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createThreadBinding({
        metadata: {
          boundBy: "user-1",
          lastActivityAt: Date.now(),
          idleTimeoutMs: 2 * 60 * 60 * 1000,
          maxAgeMs: 0,
        },
      }),
    );

    const result = await handleSessionCommand(createThreadCommandParams("/session idle"), true);
    expect(result?.reply?.text).toContain("Idle timeout active (2h");
    expect(result?.reply?.text).toContain("2026-02-20T02:00:00.000Z");
  });

  it("sets max age for the focused thread-chat session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createThreadBinding());
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt: Date.now(),
        lastActivityAt: Date.now(),
        maxAgeMs: 3 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(
      createThreadCommandParams("/session max-age 3h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(hoisted.setThreadBindingMaxAgeBySessionKeyMock).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      maxAgeMs: 3 * 60 * 60 * 1000,
    });
    expect(text).toContain("Max age set to 3h");
    expect(text).toContain("2026-02-20T03:00:00.000Z");
  });

  it("sets idle timeout for focused topic-chat conversations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createTopicBinding());
    hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt: Date.now(),
        lastActivityAt: Date.now(),
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(createTopicCommandParams("/session idle 2h"), true);
    const text = result?.reply?.text ?? "";

    expectIdleTimeoutSetReply(
      hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock,
      text,
      2 * 60 * 60 * 1000,
      "2h",
    );
  });

  it("sets idle timeout for focused room-chat threads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createRoomBinding());
    hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt: Date.now(),
        lastActivityAt: Date.now(),
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(
      createRoomThreadCommandParams("/session idle 2h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expectIdleTimeoutSetReply(
      hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
      text,
      2 * 60 * 60 * 1000,
      "2h",
    );
  });

  it("sets idle timeout for the triggering room-chat always-thread turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createRoomTriggerBinding());
    hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt: Date.now(),
        lastActivityAt: Date.now(),
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(
      createRoomTriggerThreadCommandParams("/session idle 2h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(hoisted.sessionBindingResolveByConversationMock).toHaveBeenCalledWith({
      channel: ROOM_CHANNEL,
      accountId: "default",
      conversationId: "$root",
      parentConversationId: "!room:example.org",
      threadId: "$root",
    });
    expectIdleTimeoutSetReply(
      hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
      text,
      2 * 60 * 60 * 1000,
      "2h",
    );
  });

  it("sets max age for focused room-chat threads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    const boundAt = Date.parse("2026-02-19T22:00:00.000Z");
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createRoomBinding({ boundAt }));
    hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt,
        lastActivityAt: Date.now(),
        maxAgeMs: 3 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(
      createRoomThreadCommandParams("/session max-age 3h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      maxAgeMs: 3 * 60 * 60 * 1000,
    });
    expect(text).toContain("Max age set to 3h");
    expect(text).toContain("2026-02-20T01:00:00.000Z");
  });

  it("reports topic-chat max-age expiry from the original bind time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    const boundAt = Date.parse("2026-02-19T22:00:00.000Z");
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createTopicBinding({ boundAt }),
    );
    hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt,
        lastActivityAt: Date.now(),
        maxAgeMs: 3 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(
      createTopicCommandParams("/session max-age 3h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      maxAgeMs: 3 * 60 * 60 * 1000,
    });
    expect(text).toContain("Max age set to 3h");
    expect(text).toContain("2026-02-20T01:00:00.000Z");
  });

  it("disables max age when set to off", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createThreadBinding({
        metadata: {
          boundBy: "user-1",
          lastActivityAt: Date.now(),
          idleTimeoutMs: 24 * 60 * 60 * 1000,
          maxAgeMs: 2 * 60 * 60 * 1000,
        },
      }),
    );
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt: Date.now(),
        lastActivityAt: Date.now(),
        maxAgeMs: 0,
      },
    ]);

    const result = await handleSessionCommand(
      createThreadCommandParams("/session max-age off"),
      true,
    );

    expect(hoisted.setThreadBindingMaxAgeBySessionKeyMock).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      maxAgeMs: 0,
    });
    expect(result?.reply?.text).toContain("Max age disabled");
  });

  it("is unavailable outside bindable channels", async () => {
    const params = buildSessionCommandParams("/session idle 2h");
    const result = await handleSessionCommand(params, true);
    expect(result?.reply?.text).toContain(
      "currently available only on channels that support focused conversation bindings",
    );
  });

  it("requires a focused room-chat thread for lifecycle updates", async () => {
    const result = await handleSessionCommand(createRoomCommandParams("/session idle 2h"), true);

    expect(result?.reply?.text).toContain("This conversation is not currently focused.");
    expect(hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock).not.toHaveBeenCalled();
  });

  it("requires binding owner for lifecycle updates", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createThreadBinding({
        metadata: {
          boundBy: "owner-1",
          lastActivityAt: Date.now(),
          idleTimeoutMs: 24 * 60 * 60 * 1000,
          maxAgeMs: 0,
        },
      }),
    );

    const result = await handleSessionCommand(
      createThreadCommandParams("/session idle 2h", {
        SenderId: "other-user",
      }),
      true,
    );

    expect(hoisted.setThreadBindingIdleTimeoutBySessionKeyMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("Only owner-1 can update session lifecycle settings");
  });
});

describe("/refresh", () => {
  beforeEach(async () => {
    if (!handleRefreshCommand) {
      ({ handleRefreshCommand } = await import("./commands-session.js"));
    }
    hoisted.clearBootstrapSnapshotMock.mockReset();
  });

  it("clears bootstrap + skills injection state, preserves token freshness, and returns an English success reply by default", async () => {
    const params = buildSessionCommandParams("/refresh");
    params.ctx.Timestamp = 1_777_000_000_000;
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        totalTokens: 112_000,
        totalTokensFresh: true,
        skillsSnapshot: {
          prompt: "old snapshot",
          skills: [],
          version: 1,
        },
        systemPromptReport: {
          source: "estimate",
          generatedAt: Date.now(),
          systemPrompt: {
            chars: 10,
            projectContextChars: 0,
            nonProjectContextChars: 10,
          },
          injectedWorkspaceFiles: [],
          skills: {
            promptChars: 5,
            entries: [],
          },
          tools: {
            listChars: 0,
            schemaChars: 0,
            entries: [],
          },
        },
      } as SessionEntry,
    };
    params.sessionEntry = params.sessionStore[params.sessionKey]!;

    const result = await handleRefreshCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Session context refreshed. Send your next prompt when ready." },
    });
    expect(hoisted.clearBootstrapSnapshotMock).toHaveBeenCalledWith(params.sessionKey);
    expect(params.sessionEntry?.skillsSnapshot).toBeUndefined();
    expect(params.sessionEntry?.systemPromptReport).toBeUndefined();
    expect(params.sessionEntry?.refreshCutoffTimestamp).toBe(params.ctx.Timestamp);
    expect(params.sessionEntry?.totalTokens).toBe(0);
    expect(params.sessionEntry?.totalTokensFresh).toBe(true);
    expect(params.ctx.Body).toBe("/refresh");
  });

  it("does not manufacture fresh token state for a session that was already stale", async () => {
    const params = buildSessionCommandParams("/refresh");
    params.ctx.Timestamp = 1_777_000_000_000;
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        totalTokens: 81_133,
        totalTokensFresh: false,
        skillsSnapshot: {
          prompt: "old snapshot",
          skills: [],
          version: 1,
        },
      } as SessionEntry,
    };
    params.sessionEntry = params.sessionStore[params.sessionKey]!;

    const result = await handleRefreshCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Session context refreshed. Send your next prompt when ready." },
    });
    expect(params.sessionEntry?.refreshCutoffTimestamp).toBe(params.ctx.Timestamp);
    expect(params.sessionEntry?.totalTokens).toBe(0);
    expect(params.sessionEntry?.totalTokensFresh).toBe(true);
  });

  it("recomputes cached context usage from transcript messages kept after the cutoff", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-refresh-status-"));
    const transcriptPath = path.join(workspaceDir, "refresh-status.jsonl");
    const keptMessage = {
      role: "user",
      content: "keep this context",
      timestamp: 200,
    } as AgentMessage;
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ message: { role: "user", content: "old context", timestamp: 100 } }),
        JSON.stringify({ message: keptMessage }),
      ].join("\n"),
      "utf8",
    );

    const params = buildSessionCommandParams("/refresh");
    params.ctx.Timestamp = 150;
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "session-1",
        sessionFile: transcriptPath,
        updatedAt: Date.now(),
        totalTokens: 81_133,
        totalTokensFresh: false,
      } as SessionEntry,
    };
    params.sessionEntry = params.sessionStore[params.sessionKey]!;

    const result = await handleRefreshCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Session context refreshed. Send your next prompt when ready." },
    });
    expect(params.sessionEntry?.totalTokens).toBe(estimateMessagesTokens([keptMessage]));
    expect(params.sessionEntry?.totalTokensFresh).toBe(true);
  });

  it("continues with the provided prompt when /refresh is followed by manual input", async () => {
    const params = buildSessionCommandParams("/refresh Keep CAPS and continue");
    params.ctx.Timestamp = 1_777_000_000_000;
    params.rootCtx = {
      ...params.ctx,
      Body: "/refresh Keep CAPS and continue",
      RawBody: "/refresh Keep CAPS and continue",
      CommandBody: "/refresh Keep CAPS and continue",
      BodyForCommands: "/refresh Keep CAPS and continue",
      BodyForAgent: "/refresh Keep CAPS and continue",
      BodyStripped: "/refresh Keep CAPS and continue",
    } as typeof params.ctx;
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        totalTokens: 81_133,
        totalTokensFresh: true,
        skillsSnapshot: {
          prompt: "old snapshot",
          skills: [],
          version: 1,
        },
      } as SessionEntry,
    };
    params.sessionEntry = params.sessionStore[params.sessionKey]!;

    const result = await handleRefreshCommand(params, true);

    expect(result).toEqual({ shouldContinue: true });
    expect(params.ctx.Body).toBe("Keep CAPS and continue");
    expect(params.ctx.CommandBody).toBe("Keep CAPS and continue");
    expect((params.ctx as typeof params.ctx & { BodyForCommands?: string }).BodyForCommands).toBe(
      "Keep CAPS and continue",
    );
    expect((params.ctx as typeof params.ctx & { BodyForAgent?: string }).BodyForAgent).toBe(
      "Keep CAPS and continue",
    );
    expect((params.ctx as typeof params.ctx & { BodyStripped?: string }).BodyStripped).toBe(
      "Keep CAPS and continue",
    );
    expect(params.rootCtx?.Body).toBe("Keep CAPS and continue");
  });

  it("returns unsupported when /refresh is used in a CLI-backed session", async () => {
    const params = buildSessionCommandParams("/refresh");
    params.cfg = cfgWithCliBackend;
    params.provider = "claude-cli";
    params.model = "sonnet";
    const clearCallsBefore = hoisted.clearBootstrapSnapshotMock.mock.calls.length;

    const result = await handleRefreshCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚠️ /refresh is not supported for CLI sessions." },
    });
    expect(hoisted.clearBootstrapSnapshotMock).toHaveBeenCalledTimes(clearCallsBefore);
  });
});
