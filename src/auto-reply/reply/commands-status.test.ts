import { describe, expect, it } from "vitest";
import type { ProviderUsageSnapshot } from "../../infra/provider-usage.js";
import { resolveStatusUsageLine } from "./commands-status.js";

describe("resolveStatusUsageLine", () => {
  it("returns null when no usage data exists and no profile scope is known", () => {
    expect(resolveStatusUsageLine({})).toBeNull();
  });

  it("shows profile-scoped no-data message when profile is selected but usage is missing", () => {
    expect(
      resolveStatusUsageLine({
        profileScopeLabel: "openai-codex:gmail",
      }),
    ).toBe("📊 Usage: unavailable (no data) · openai-codex:gmail");
  });

  it("shows provider error details and preserves selected profile scope", () => {
    const usageEntry: ProviderUsageSnapshot = {
      provider: "openai-codex",
      displayName: "Codex",
      windows: [],
      error: "Token expired",
    };
    expect(
      resolveStatusUsageLine({
        usageEntry,
        profileScopeLabel: "openai-codex:gmail",
      }),
    ).toBe("📊 Usage: unavailable (Token expired) · openai-codex:gmail");
  });

  it("formats usage windows and appends selected profile scope", () => {
    const now = 1_700_000_000_000;
    const usageEntry: ProviderUsageSnapshot = {
      provider: "openai-codex",
      displayName: "Codex",
      windows: [
        {
          label: "3h",
          usedPercent: 22,
          resetAt: now + 2 * 60 * 60 * 1000,
        },
        {
          label: "Week",
          usedPercent: 32,
          resetAt: now + (6 * 24 + 10) * 60 * 60 * 1000,
        },
      ],
    };
    expect(
      resolveStatusUsageLine({
        usageEntry,
        profileScopeLabel: "openai-codex:default",
        now,
      }),
    ).toBe("📊 Usage: 3h 78% left ⏱2h · Week 68% left ⏱6d 10h · openai-codex:default");
  });
});
