import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchGeminiUsage } from "./provider-usage.fetch.gemini.js";

describe("fetchGeminiUsage", () => {
  it("returns HTTP errors for failed requests", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(429, { error: "rate_limited" }),
    );
    const result = await fetchGeminiUsage("token", 5000, mockFetch, "google-gemini-cli");

    expect(result.error).toBe("HTTP 429");
    expect(result.windows).toHaveLength(0);
  });

  it("sends project-aware request and selects the lowest remaining fraction per model family", async () => {
    const mockFetch = createProviderUsageFetch(async (_url, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      expect(headers.Authorization).toBe("Bearer token");
      expect(init?.body).toBe('{"project":"test-project"}');

      return makeResponse(200, {
        buckets: [
          { modelId: "gemini-pro", remainingFraction: 0.8 },
          { modelId: "gemini-pro-preview", remainingFraction: 0.3 },
          { modelId: "gemini-flash", remainingFraction: 0.7 },
          { modelId: "gemini-flash-latest", remainingFraction: 0.9 },
          { modelId: "gemini-unknown", remainingFraction: 0.5 },
        ],
      });
    });

    const result = await fetchGeminiUsage("token", 5000, mockFetch, "google-gemini-cli", {
      projectId: "test-project",
    });

    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]).toEqual({ label: "Pro", usedPercent: 70 });
    expect(result.windows[1]?.label).toBe("Flash");
    expect(result.windows[1]?.usedPercent).toBeCloseTo(30, 6);
  });

  it("uses endpoint override and includes reset timestamps from chosen buckets", async () => {
    const mockFetch = createProviderUsageFetch(async (url, init) => {
      expect(url).toBe(
        "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuota",
      );
      expect(init?.body).toBe('{"project":"daily-project"}');
      return makeResponse(200, {
        buckets: [
          {
            modelId: "gemini-2.5-pro",
            remainingFraction: 0.55,
            resetTime: "2026-01-07T17:19:00Z",
          },
          {
            modelId: "gemini-2.5-flash",
            remainingFraction: 0.8,
            resetTime: "2026-01-08T10:54:00Z",
          },
        ],
      });
    });

    const result = await fetchGeminiUsage("token", 5000, mockFetch, "google-gemini-cli", {
      projectId: "daily-project",
      endpoint: "https://daily-cloudcode-pa.sandbox.googleapis.com",
    });

    expect(result.windows).toEqual([
      {
        label: "Pro",
        usedPercent: expect.closeTo(45, 6),
        resetAt: Date.parse("2026-01-07T17:19:00Z"),
      },
      {
        label: "Flash",
        usedPercent: expect.closeTo(20, 6),
        resetAt: Date.parse("2026-01-08T10:54:00Z"),
      },
    ]);
  });

  it("falls back to cloudcode production endpoint and empty body when project is missing", async () => {
    const mockFetch = createProviderUsageFetch(async (url, init) => {
      expect(url).toBe("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota");
      expect(init?.body).toBe("{}");
      return makeResponse(200, { buckets: [] });
    });

    const result = await fetchGeminiUsage("token", 5000, mockFetch, "google-gemini-cli");
    expect(result.windows).toEqual([]);
  });

  it("returns no windows when the response has no recognized model families", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        buckets: [{ modelId: "gemini-unknown", remainingFraction: 0.5 }],
      }),
    );

    const result = await fetchGeminiUsage("token", 5000, mockFetch, "google-gemini-cli");

    expect(result).toEqual({
      provider: "google-gemini-cli",
      displayName: "Gemini",
      windows: [],
    });
  });

  it("defaults missing fractions to fully available and clamps invalid fractions", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        buckets: [
          { modelId: "gemini-pro" },
          { modelId: "gemini-pro-latest", remainingFraction: -0.5 },
          { modelId: "gemini-flash", remainingFraction: 1.2 },
        ],
      }),
    );

    const result = await fetchGeminiUsage("token", 5000, mockFetch, "google-gemini-cli");

    expect(result.windows).toEqual([
      { label: "Pro", usedPercent: 100 },
      { label: "Flash", usedPercent: 0 },
    ]);
  });
});
