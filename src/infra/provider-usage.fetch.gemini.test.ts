import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import {
  fetchGeminiUsage,
  setGeminiUsageNetworkDepsForTest,
} from "./provider-usage.fetch.gemini.js";

describe("fetchGeminiUsage", () => {
  afterEach(() => {
    setGeminiUsageNetworkDepsForTest();
  });

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

  it("returns Timeout when the request aborts", async () => {
    const mockFetch = createProviderUsageFetch(async () => {
      throw new DOMException("This operation was aborted", "AbortError");
    });

    const result = await fetchGeminiUsage("token", 5000, mockFetch, "google-gemini-cli");
    expect(result.error).toBe("Timeout");
    expect(result.windows).toEqual([]);
  });

  it("returns request failed when fetch throws non-timeout errors", async () => {
    const mockFetch = createProviderUsageFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const result = await fetchGeminiUsage("token", 5000, mockFetch, "google-gemini-cli");
    expect(result.error).toBe("request failed");
    expect(result.windows).toEqual([]);
  });

  it("uses node transport with global fetch and parses quota response", async () => {
    let seenUrl = "";
    let seenBody = "";
    let seenAuthorization = "";

    const mockHttpsRequest = ((input: unknown, options: unknown, callback?: unknown) => {
      const req = new EventEmitter() as EventEmitter & {
        write: (chunk: string | Buffer) => boolean;
        end: () => void;
        destroy: (error?: Error) => void;
      };
      let requestBody = "";
      req.write = (chunk) => {
        requestBody += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        return true;
      };
      req.destroy = (error?: Error) => {
        if (error) {
          req.emit("error", error);
        }
        req.emit("close");
      };
      req.end = () => {
        seenUrl = String(input);
        seenBody = requestBody;
        const headers =
          options && typeof options === "object" && "headers" in options
            ? (options.headers as Record<string, string>)
            : undefined;
        seenAuthorization = headers?.Authorization ?? headers?.authorization ?? "";
        if (typeof callback === "function") {
          const res = new PassThrough() as PassThrough & { statusCode?: number };
          res.statusCode = 200;
          (callback as (res: IncomingMessage) => void)(res as unknown as IncomingMessage);
          res.end(
            JSON.stringify({
              buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0.25 }],
            }),
          );
        }
        req.emit("close");
      };
      return req as unknown as ReturnType<typeof import("node:https").request>;
    }) as unknown as typeof import("node:https").request;

    setGeminiUsageNetworkDepsForTest({ httpsRequest: mockHttpsRequest });
    const result = await fetchGeminiUsage("token", 5000, globalThis.fetch, "google-gemini-cli", {
      projectId: "test-project",
    });

    expect(seenUrl).toBe("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota");
    expect(seenAuthorization).toBe("Bearer token");
    expect(seenBody).toBe('{"project":"test-project"}');
    expect(result.windows).toEqual([{ label: "Pro", usedPercent: 75 }]);
  });

  it("returns Timeout when node transport times out", async () => {
    const mockHttpsRequest = ((_input: unknown, _options: unknown, _callback?: unknown) => {
      const req = new EventEmitter() as EventEmitter & {
        write: (chunk: string | Buffer) => boolean;
        end: () => void;
        destroy: (error?: Error) => void;
      };
      req.write = () => true;
      req.end = () => {};
      req.destroy = (error?: Error) => {
        if (error) {
          req.emit("error", error);
        }
        req.emit("close");
      };
      return req as unknown as ReturnType<typeof import("node:https").request>;
    }) as unknown as typeof import("node:https").request;

    setGeminiUsageNetworkDepsForTest({ httpsRequest: mockHttpsRequest });
    const result = await fetchGeminiUsage("token", 5, globalThis.fetch, "google-gemini-cli", {
      projectId: "test-project",
    });

    expect(result.error).toBe("Timeout");
    expect(result.windows).toEqual([]);
  });
});
