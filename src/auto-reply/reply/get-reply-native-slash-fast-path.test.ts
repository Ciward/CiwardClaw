import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

const { buildStatusReplyMock, handleCommandsMock } = vi.hoisted(() => ({
  buildStatusReplyMock: vi.fn(),
  handleCommandsMock: vi.fn(),
}));

vi.mock("./commands.runtime.js", () => ({
  handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
}));

vi.mock("./commands-status.js", () => ({
  buildStatusReply: (...args: unknown[]) => buildStatusReplyMock(...args),
}));

const { maybeResolveNativeSlashCommandFastReply } =
  await import("./get-reply-native-slash-fast-path.js");

const createTypingController = (): TypingController => ({
  onReplyStart: async () => {},
  startTypingLoop: async () => {},
  startTypingOnText: async () => {},
  refreshTypingTtl: () => {},
  isActive: () => false,
  markRunComplete: () => {},
  markDispatchIdle: () => {},
  cleanup: vi.fn(),
});

describe("maybeResolveNativeSlashCommandFastReply", () => {
  beforeEach(() => {
    buildStatusReplyMock.mockReset();
    handleCommandsMock.mockReset();
  });

  it("marks native /compact terminal replies for delivery under message_tool_only (#90185)", async () => {
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: "⚙️ Compaction skipped: no real conversation messages yet • Context 12.1k" },
    });

    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/compact",
      CommandBody: "/compact",
      CommandSource: "native",
      CommandAuthorized: true,
      SessionKey: "telegram:slash:123",
      CommandTargetSessionKey: "agent:main:main",
      CommandTurn: {
        kind: "native",
        source: "native",
        authorized: true,
        commandName: "compact",
        body: "/compact",
      },
    });

    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        session: { store: "/tmp/openclaw-native-slash-sessions.json" },
      } as OpenClawConfig),
      agentId: "main",
      agentDir: "/tmp/agent",
      agentCfg: undefined,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing,
    });

    expect(handleCommandsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({
        text: "⚙️ Compaction skipped: no real conversation messages yet • Context 12.1k",
      }),
    });
    if (!result.handled) {
      throw new Error("expected handled");
    }
    if (!result.reply || Array.isArray(result.reply)) {
      throw new Error("expected single reply payload");
    }
    expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("handles authorized text slash commands before model dispatch", async () => {
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: "Trajectory exports can include prompts." },
    });

    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/export-trajectory bundle",
      BodyForCommands: "/export-trajectory bundle",
      CommandBody: "/export-trajectory bundle",
      CommandSource: "text",
      CommandAuthorized: true,
      SessionKey: "agent:dev:webchat",
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "webchat",
      ChatType: "direct",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        commandName: "export-trajectory",
        body: "/export-trajectory bundle",
      },
    });

    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        session: { store: "/tmp/openclaw-text-slash-sessions.json" },
      } as OpenClawConfig),
      agentId: "dev",
      agentDir: "/tmp/agent",
      agentCfg: undefined,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing,
    });

    expect(handleCommandsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({
        text: "Trajectory exports can include prompts.",
      }),
    });
    if (!result.handled || !result.reply || Array.isArray(result.reply)) {
      throw new Error("expected single handled reply");
    }
    expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("handles external authorized text /status before the session lane", async () => {
    buildStatusReplyMock.mockResolvedValueOnce({ text: "Status: ready" });

    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/status",
      BodyForCommands: "/status",
      CommandBody: "/status",
      CommandSource: "text",
      CommandAuthorized: true,
      SessionKey: "agent:main:telegram:group:-1003764790655:topic:2218",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      BotUsername: "CiwardMacBot",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        commandName: "status",
        body: "/status",
      },
    });

    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        commands: { text: false },
        session: { store: "/tmp/openclaw-telegram-status-text-slash-sessions.json" },
      } as OpenClawConfig),
      agentId: "main",
      agentDir: "/tmp/agent",
      agentCfg: undefined,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing,
    });

    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(buildStatusReplyMock).toHaveBeenCalledTimes(1);
    expect(buildStatusReplyMock.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: "agent:main:telegram:group:-1003764790655:topic:2218",
      isGroup: true,
      provider: "openai",
      model: "gpt-5.5",
    });
    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({
        text: "Status: ready",
      }),
    });
    if (!result.handled || !result.reply || Array.isArray(result.reply)) {
      throw new Error("expected single handled reply");
    }
    expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("preserves session status modes when text /status uses the fast path", async () => {
    buildStatusReplyMock.mockResolvedValueOnce({ text: "Status: full" });

    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/status@CiwardMacBot",
      BodyForCommands: "/status@CiwardMacBot",
      CommandBody: "/status@CiwardMacBot",
      CommandSource: "text",
      CommandAuthorized: true,
      SessionKey: "agent:main:telegram:group:-1003764790655:topic:2218",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      BotUsername: "CiwardMacBot",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        commandName: "status",
        body: "/status@CiwardMacBot",
      },
    });
    const storePath = `/tmp/openclaw-telegram-status-modes-${process.pid}.json`;
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(
        storePath,
        JSON.stringify({
          "agent:main:telegram:group:-1003764790655:topic:2218": {
            sessionId: "status-mode-session",
            updatedAt: 1,
            verboseLevel: "full",
            reasoningLevel: "on",
            elevatedLevel: "ask",
          },
        }),
      ),
    );

    await maybeResolveNativeSlashCommandFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        commands: { text: false },
        session: { store: storePath },
        tools: {
          elevated: {
            allowFrom: {
              telegram: ["*"],
            },
          },
        },
      } as OpenClawConfig),
      agentId: "main",
      agentDir: "/tmp/agent",
      agentCfg: undefined,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing,
    });

    expect(buildStatusReplyMock).toHaveBeenCalledTimes(1);
    expect(buildStatusReplyMock.mock.calls[0]?.[0]).toMatchObject({
      resolvedVerboseLevel: "full",
      resolvedReasoningLevel: "on",
      resolvedElevatedLevel: "ask",
    });
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("uses per-agent reasoning defaults for text /status fast path", async () => {
    buildStatusReplyMock.mockResolvedValueOnce({ text: "Status: agent defaults" });

    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/status",
      BodyForCommands: "/status",
      CommandBody: "/status",
      CommandSource: "text",
      CommandAuthorized: true,
      SessionKey: "agent:reviewer:telegram:direct:6925026858",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        commandName: "status",
        body: "/status",
      },
    });

    await maybeResolveNativeSlashCommandFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        commands: { text: false },
        session: { store: `/tmp/openclaw-telegram-status-agent-default-${process.pid}.json` },
        agents: {
          defaults: { reasoningDefault: "off" },
          list: [{ id: "reviewer", reasoningDefault: "stream" }],
        },
      } as OpenClawConfig),
      agentId: "reviewer",
      agentDir: "/tmp/agent",
      agentCfg: { reasoningDefault: "off" },
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing,
    });

    expect(buildStatusReplyMock).toHaveBeenCalledTimes(1);
    expect(buildStatusReplyMock.mock.calls[0]?.[0]).toMatchObject({
      resolvedReasoningLevel: "stream",
    });
  });

  it("forces elevated off for unauthorized text /status fast path", async () => {
    buildStatusReplyMock.mockResolvedValueOnce({ text: "Status: elevated off" });

    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/status",
      BodyForCommands: "/status",
      CommandBody: "/status",
      CommandSource: "text",
      CommandAuthorized: true,
      SessionKey: "agent:main:telegram:direct:6925026858",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
      SenderId: "not-owner",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        commandName: "status",
        body: "/status",
      },
    });
    const storePath = `/tmp/openclaw-telegram-status-elevated-gate-${process.pid}.json`;
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(
        storePath,
        JSON.stringify({
          "agent:main:telegram:direct:6925026858": {
            sessionId: "status-elevated-session",
            updatedAt: 1,
            elevatedLevel: "full",
          },
        }),
      ),
    );

    await maybeResolveNativeSlashCommandFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        commands: { text: false },
        session: { store: storePath },
        tools: {
          elevated: {
            allowFrom: {
              telegram: ["owner"],
            },
          },
        },
      } as OpenClawConfig),
      agentId: "main",
      agentDir: "/tmp/agent",
      agentCfg: { elevatedDefault: "full" },
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing,
    });

    expect(buildStatusReplyMock).toHaveBeenCalledTimes(1);
    expect(buildStatusReplyMock.mock.calls[0]?.[0]).toMatchObject({
      resolvedElevatedLevel: "off",
    });
  });

  it("keeps external text /status subcommands on the canonical session path", async () => {
    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/status plugins",
      BodyForCommands: "/status plugins",
      CommandBody: "/status plugins",
      CommandSource: "text",
      CommandAuthorized: true,
      SessionKey: "agent:main:telegram:group:-1003764790655:topic:2218",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        commandName: "status",
        body: "/status plugins",
      },
    });

    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        commands: { text: false },
        session: { store: "/tmp/openclaw-telegram-status-plugins-text-slash-sessions.json" },
      } as OpenClawConfig),
      agentId: "main",
      agentDir: "/tmp/agent",
      agentCfg: undefined,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing,
    });

    expect(result).toEqual({ handled: false });
    expect(buildStatusReplyMock).not.toHaveBeenCalled();
    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(typing.cleanup).not.toHaveBeenCalled();
  });

  it("leaves external text slash commands on the canonical session path", async () => {
    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/export-trajectory bundle",
      BodyForCommands: "/export-trajectory bundle",
      CommandBody: "/export-trajectory bundle",
      CommandSource: "text",
      CommandAuthorized: true,
      SessionKey: "agent:dev:telegram:group:123",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        commandName: "export-trajectory",
        body: "/export-trajectory bundle",
      },
    });

    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        session: { store: "/tmp/openclaw-external-text-slash-sessions.json" },
      } as OpenClawConfig),
      agentId: "dev",
      agentDir: "/tmp/agent",
      agentCfg: undefined,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing,
    });

    expect(result).toEqual({ handled: false });
    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(typing.cleanup).not.toHaveBeenCalled();
  });
});
