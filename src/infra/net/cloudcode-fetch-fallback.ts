import { Agent, fetch as undiciFetch } from "undici";

const CLOUDCODE_FETCH_FALLBACK_MARKER = Symbol.for("openclaw.fetch.cloudcode-proxy-fallback");
const CLOUDCODE_HOSTS = new Set([
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.sandbox.googleapis.com",
  "autopush-cloudcode-pa.sandbox.googleapis.com",
]);
const DIRECT_CONNECT_TIMEOUT_MS = 30_000;
const DIRECT_STREAM_TIMEOUT_MS = 30 * 60 * 1000;
const DIRECT_FALLBACK_TTL_MS = 10 * 60 * 1000;

type FetchWithFallbackMarker = typeof fetch & {
  [CLOUDCODE_FETCH_FALLBACK_MARKER]?: true;
};

type FetchWithPreconnect = typeof fetch & {
  preconnect?: (url: string, init?: { credentials?: RequestCredentials }) => void;
};

const directPreferredUntilByHost = new Map<string, number>();
let directDispatcher: Agent | null = null;

function resolveRequestUrl(input: RequestInfo | URL): URL | null {
  if (input instanceof URL) {
    return input;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    try {
      return new URL(input.url);
    } catch {
      return null;
    }
  }
  if (typeof input === "string") {
    try {
      return new URL(input);
    } catch {
      return null;
    }
  }
  return null;
}

function isCloudCodeUrl(url: URL): boolean {
  return url.protocol === "https:" && CLOUDCODE_HOSTS.has(url.hostname);
}

function isConnectTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const causeCode = (error as Error & { cause?: { code?: unknown } }).cause?.code;
  return typeof causeCode === "string" && causeCode === "UND_ERR_CONNECT_TIMEOUT";
}

function shouldUseDirectFirst(hostname: string): boolean {
  const preferredUntil = directPreferredUntilByHost.get(hostname);
  if (!preferredUntil) {
    return false;
  }
  if (preferredUntil > Date.now()) {
    return true;
  }
  directPreferredUntilByHost.delete(hostname);
  return false;
}

function resolveDirectDispatcher(): Agent {
  if (!directDispatcher) {
    directDispatcher = new Agent({
      bodyTimeout: DIRECT_STREAM_TIMEOUT_MS,
      headersTimeout: DIRECT_STREAM_TIMEOUT_MS,
      connect: { timeout: DIRECT_CONNECT_TIMEOUT_MS },
    });
  }
  return directDispatcher;
}

async function fetchViaDirectDispatcher(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let target: string | URL;
  if (typeof input === "string" || input instanceof URL) {
    target = input;
  } else if (typeof Request !== "undefined" && input instanceof Request) {
    target = input.url;
  } else {
    throw new TypeError("Unsupported request input for Cloud Code direct fetch fallback");
  }
  const directFetch = undiciFetch as unknown as typeof fetch;
  const directInit = {
    ...(init as Record<string, unknown>),
    dispatcher: resolveDirectDispatcher(),
  } as RequestInit;
  return await directFetch(target, directInit);
}

export function ensureCloudCodeProxyFallbackFetch(): void {
  const currentFetch = globalThis.fetch as FetchWithFallbackMarker | undefined;
  if (!currentFetch || currentFetch[CLOUDCODE_FETCH_FALLBACK_MARKER]) {
    return;
  }

  const originalFetch = globalThis.fetch;
  const patched = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = resolveRequestUrl(input);
    if (!requestUrl || !isCloudCodeUrl(requestUrl)) {
      return await originalFetch(input, init);
    }

    if (shouldUseDirectFirst(requestUrl.hostname)) {
      return await fetchViaDirectDispatcher(input, init);
    }

    try {
      return await originalFetch(input, init);
    } catch (error) {
      if (!isConnectTimeoutError(error)) {
        throw error;
      }
      directPreferredUntilByHost.set(requestUrl.hostname, Date.now() + DIRECT_FALLBACK_TTL_MS);
      return await fetchViaDirectDispatcher(input, init);
    }
  }) as FetchWithFallbackMarker;

  const originalWithPreconnect = originalFetch as FetchWithPreconnect;
  if (typeof originalWithPreconnect.preconnect === "function") {
    const target = patched as FetchWithPreconnect;
    target.preconnect = originalWithPreconnect.preconnect.bind(originalWithPreconnect);
  }

  Object.defineProperty(patched, CLOUDCODE_FETCH_FALLBACK_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  globalThis.fetch = patched as typeof fetch;
}

export function resetCloudCodeProxyFallbackFetchForTests(): void {
  directPreferredUntilByHost.clear();
  directDispatcher = null;
}
