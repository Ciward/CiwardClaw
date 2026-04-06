import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { Agent, undiciFetch } = vi.hoisted(() => {
  class Agent {
    constructor(public readonly options?: Record<string, unknown>) {}
  }
  const undiciFetch = vi.fn();
  return { Agent, undiciFetch };
});

vi.mock("undici", () => ({
  Agent,
  fetch: undiciFetch,
}));

let ensureCloudCodeProxyFallbackFetch: typeof import("./cloudcode-fetch-fallback.js").ensureCloudCodeProxyFallbackFetch;
let resetCloudCodeProxyFallbackFetchForTests: typeof import("./cloudcode-fetch-fallback.js").resetCloudCodeProxyFallbackFetchForTests;
let originalFetch: typeof globalThis.fetch | undefined;

describe("ensureCloudCodeProxyFallbackFetch", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ ensureCloudCodeProxyFallbackFetch, resetCloudCodeProxyFallbackFetchForTests } =
      await import("./cloudcode-fetch-fallback.js"));
    resetCloudCodeProxyFallbackFetchForTests();
    undiciFetch.mockReset();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    resetCloudCodeProxyFallbackFetchForTests();
    if (originalFetch) {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("leaves non-cloudcode requests on the original fetch path", async () => {
    const baseFetch = vi.fn(async () => new Response("ok", { status: 200 })) as typeof fetch;
    vi.stubGlobal("fetch", baseFetch);

    ensureCloudCodeProxyFallbackFetch();
    const response = await globalThis.fetch("https://example.com");

    expect(response.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it("keeps cloudcode requests on proxy path when no timeout occurs", async () => {
    const baseFetch = vi.fn(async () => new Response("{}", { status: 401 })) as typeof fetch;
    vi.stubGlobal("fetch", baseFetch);

    ensureCloudCodeProxyFallbackFetch();
    const response = await globalThis.fetch(
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
      {
        method: "POST",
        body: "{}",
      },
    );

    expect(response.status).toBe(401);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it("falls back to direct dispatcher on cloudcode proxy connect timeout", async () => {
    const timeoutError = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    });
    const baseFetch = vi.fn(async () => {
      throw timeoutError;
    }) as typeof fetch;
    vi.stubGlobal("fetch", baseFetch);
    undiciFetch.mockResolvedValue(new Response("{}", { status: 200 }));

    ensureCloudCodeProxyFallbackFetch();
    const response = await globalThis.fetch(
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
      {
        method: "POST",
        body: "{}",
      },
    );

    expect(response.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(undiciFetch).toHaveBeenCalledTimes(1);
    const fallbackInit = undiciFetch.mock.calls[0]?.[1] as { dispatcher?: unknown };
    expect(fallbackInit.dispatcher).toBeInstanceOf(Agent);
  });

  it("uses direct-first mode after a timeout for the same cloudcode host", async () => {
    let first = true;
    const timeoutError = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    });
    const baseFetch = vi.fn(async () => {
      if (first) {
        first = false;
        throw timeoutError;
      }
      return new Response("proxy-second-call", { status: 502 });
    }) as typeof fetch;
    vi.stubGlobal("fetch", baseFetch);
    undiciFetch.mockResolvedValue(new Response("{}", { status: 200 }));

    ensureCloudCodeProxyFallbackFetch();
    const firstResponse = await globalThis.fetch(
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
      {
        method: "POST",
        body: "{}",
      },
    );
    const secondResponse = await globalThis.fetch(
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
      {
        method: "POST",
        body: "{}",
      },
    );

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(undiciFetch).toHaveBeenCalledTimes(2);
  });
});

afterAll(() => {
  vi.doUnmock("undici");
  vi.resetModules();
});
