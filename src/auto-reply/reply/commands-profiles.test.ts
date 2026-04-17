import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const mocks = vi.hoisted(() => ({
  resolveAgentDir: vi.fn(() => "/tmp/openclaw/agents/main"),
  resolveSessionAgentId: vi.fn(() => "main"),
  ensureAuthProfileStore: vi.fn(),
  listProfilesForProvider: vi.fn(),
  resolveAuthProfileDisplayLabel: vi.fn((params: { profileId: string }) => params.profileId),
  resolveAuthProfileOrder: vi.fn(() => []),
  getChannelPlugin: vi.fn(),
  loadProviderUsageSummary: vi.fn(),
  resolveUsageProviderId: vi.fn((provider: string) => provider),
  resolveProfileUsageAuthBinding: vi.fn(),
  resolveScopedUsageSummary: vi.fn(),
  formatUsageUnavailable: vi.fn((params: { reason: string; profileScopeLabel?: string }) => {
    const suffix = params.profileScopeLabel ? ` · ${params.profileScopeLabel}` : "";
    return `unavailable (${params.reason})${suffix}`;
  }),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: mocks.resolveAgentDir,
  resolveSessionAgentId: mocks.resolveSessionAgentId,
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  listProfilesForProvider: mocks.listProfilesForProvider,
  resolveAuthProfileDisplayLabel: mocks.resolveAuthProfileDisplayLabel,
  resolveAuthProfileOrder: mocks.resolveAuthProfileOrder,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => mocks.getChannelPlugin(...args),
}));

vi.mock("../../infra/provider-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/provider-usage.js")>(
    "../../infra/provider-usage.js",
  );
  const mockedLoadProviderUsageSummary =
    mocks.loadProviderUsageSummary as typeof actual.loadProviderUsageSummary;
  const mockedResolveUsageProviderId =
    mocks.resolveUsageProviderId as typeof actual.resolveUsageProviderId;
  return {
    ...actual,
    loadProviderUsageSummary: (...args: Parameters<typeof actual.loadProviderUsageSummary>) =>
      mockedLoadProviderUsageSummary(...args),
    resolveUsageProviderId: (...args: Parameters<typeof actual.resolveUsageProviderId>) =>
      mockedResolveUsageProviderId(...args),
  };
});

vi.mock("../../status/profile-usage.js", () => ({
  resolveProfileUsageAuthBinding: (...args: unknown[]) =>
    (mocks.resolveProfileUsageAuthBinding as (...args: unknown[]) => unknown)(...args),
  resolveScopedUsageSummary: (...args: unknown[]) =>
    (mocks.resolveScopedUsageSummary as (...args: unknown[]) => unknown)(...args),
  formatUsageUnavailable: (...args: unknown[]) =>
    (mocks.formatUsageUnavailable as (...args: unknown[]) => unknown)(...args),
}));

const { handleProfilesCommand, resolveProfilesCommandReply } =
  await import("./commands-profiles.js");

describe("resolveProfilesCommandReply", () => {
  const cfg = {} as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getChannelPlugin.mockReturnValue(undefined);
    mocks.ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "openai-codex:work": { provider: "openai-codex" },
        "openai-codex:personal": { provider: "openai-codex" },
        "anthropic:default": { provider: "anthropic" },
      },
    } as never);
    mocks.listProfilesForProvider.mockImplementation((_store: unknown, provider: string) =>
      provider === "openai-codex"
        ? ["openai-codex:work", "openai-codex:personal"]
        : provider === "anthropic"
          ? ["anthropic:default"]
          : [],
    );
    mocks.resolveAuthProfileOrder.mockReturnValue(["openai-codex:work"] as never[]);
    mocks.resolveProfileUsageAuthBinding.mockImplementation(
      async (params: { profileId?: string }) => ({
        authInput: [{ provider: "openai-codex", token: params.profileId ?? "default" }],
        profileScopeLabel: params.profileId,
      }),
    );
    mocks.loadProviderUsageSummary.mockImplementation(
      async (params: { auth?: Array<{ token?: string }> }) => {
        const token = params.auth?.[0]?.token ?? "";
        const usedPercent = token.includes("work") ? 40 : 20;
        return {
          updatedAt: Date.now(),
          providers: [
            {
              provider: "openai-codex",
              displayName: "Codex",
              windows: [{ label: "5h", usedPercent }],
            },
          ],
        };
      },
    );
    mocks.resolveScopedUsageSummary.mockImplementation(
      (params: {
        usageEntry?: { windows?: Array<{ label: string; usedPercent: number }> };
        profileScopeLabel?: string;
      }) => {
        const window = params.usageEntry?.windows?.[0];
        if (!window) {
          return params.profileScopeLabel
            ? `unavailable (no data) · ${params.profileScopeLabel}`
            : null;
        }
        const remaining = 100 - window.usedPercent;
        return `${window.label} ${remaining}% left · ${params.profileScopeLabel}`;
      },
    );
  });

  it("lists providers when called without args", async () => {
    const reply = await resolveProfilesCommandReply({
      cfg: cfg as never,
      commandBodyNormalized: "/profiles",
      agentDir: "/tmp/openclaw/agents/main",
    });

    expect(reply?.text).toContain("Profiles by provider:");
    expect(reply?.text).toContain("openai-codex (2)");
    expect(reply?.text).toContain("anthropic (1)");
  });

  it("lists profiles for a provider and marks the current one", async () => {
    const reply = await resolveProfilesCommandReply({
      cfg: cfg as never,
      commandBodyNormalized: "/profiles openai-codex",
      sessionEntry: {
        sessionId: "session",
        updatedAt: Date.now(),
        authProfileOverride: "openai-codex:work",
      } satisfies SessionEntry,
      agentDir: "/tmp/openclaw/agents/main",
    });

    expect(reply?.text).toContain("Profiles (openai-codex)");
    expect(reply?.text).toContain("* work · 5h 60% left");
    expect(reply?.text).toContain("- personal · 5h 80% left");
  });

  it("returns telegram inline buttons for provider profile list", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      commands: {
        buildProfilesListChannelData: ({
          provider,
          profiles,
        }: {
          provider: string;
          profiles: Array<{ profileId: string; label: string; isCurrent: boolean }>;
        }) => ({
          telegram: {
            buttons: profiles.map((profile) => [
              {
                text: profile.label,
                callback_data: `prf_sel_${provider}|${profile.profileId}`,
              },
            ]),
          },
        }),
      },
    });

    const reply = await resolveProfilesCommandReply({
      cfg: cfg as never,
      commandBodyNormalized: "/profiles openai-codex",
      surface: "telegram",
      sessionEntry: {
        sessionId: "session",
        updatedAt: Date.now(),
        authProfileOverride: "openai-codex:work",
      } satisfies SessionEntry,
      agentDir: "/tmp/openclaw/agents/main",
    });

    const buttons = (reply?.channelData as { telegram?: { buttons?: unknown[][] } } | undefined)
      ?.telegram?.buttons;
    expect(buttons).toBeDefined();
    expect(buttons?.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callback_data: "prf_sel_openai-codex|openai-codex:work",
        }),
      ]),
    );
  });
});

describe("handleProfilesCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "openai-codex:work": { provider: "openai-codex" },
        "openai-codex:personal": { provider: "openai-codex" },
      },
    } as never);
    mocks.listProfilesForProvider.mockReturnValue(["openai-codex:work", "openai-codex:personal"]);
    mocks.resolveAuthProfileOrder.mockReturnValue(["openai-codex:work"]);
  });

  it("persists session authProfileOverride when switching profiles", async () => {
    const params = buildCommandTestParams("/profiles openai-codex personal", {} as never);
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      authProfileOverride: "openai-codex:work",
      authProfileOverrideSource: "user",
    };
    const sessionStore: Record<string, SessionEntry> = {
      [params.sessionKey]: sessionEntry,
    };

    const result = await handleProfilesCommand(
      {
        ...params,
        sessionEntry,
        sessionStore,
      },
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Auth profile set to openai-codex:personal");
    expect(sessionStore[params.sessionKey]?.authProfileOverride).toBe("openai-codex:personal");
    expect(sessionStore[params.sessionKey]?.authProfileOverrideSource).toBe("user");
  });

  it("accepts provider-scoped profile shorthand when unique", async () => {
    const params = buildCommandTestParams("/profiles openai-codex work", {} as never);
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      authProfileOverride: "openai-codex:personal",
      authProfileOverrideSource: "user",
    };
    const sessionStore: Record<string, SessionEntry> = {
      [params.sessionKey]: sessionEntry,
    };

    const result = await handleProfilesCommand(
      {
        ...params,
        sessionEntry,
        sessionStore,
      },
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Auth profile set to openai-codex:work");
    expect(sessionStore[params.sessionKey]?.authProfileOverride).toBe("openai-codex:work");
  });
});
