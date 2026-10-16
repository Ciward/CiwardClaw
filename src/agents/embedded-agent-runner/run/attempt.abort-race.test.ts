import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";
import { wrapStreamFnWithModelRetry } from "./model-stream-retry.js";

vi.mock("./model-stream-retry.js", () => ({
  wrapStreamFnWithModelRetry: vi.fn<
    typeof import("./model-stream-retry.js").wrapStreamFnWithModelRetry
  >((baseFn) => baseFn),
}));

const hoisted = getHoisted();
const tempPaths: string[] = [];

describe("runEmbeddedAttempt abort races", () => {
  beforeAll(async () => {
    vi.useRealTimers();
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    vi.mocked(wrapStreamFnWithModelRetry)
      .mockReset()
      .mockImplementation((baseFn) => baseFn);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it("stops before session creation when aborted during eager lock acquisition", async () => {
    const abortController = new AbortController();
    const prompt = vi.fn(async () => {});
    const abortError = new Error("stopped during lock acquisition");
    abortError.name = "AbortError";
    let markLockRequested!: () => void;
    let observedSignal: AbortSignal | undefined;
    const lockRequested = new Promise<void>((resolve) => {
      markLockRequested = resolve;
    });
    hoisted.acquireSessionWriteLockMock.mockImplementationOnce(async (params) => {
      observedSignal = params.signal;
      markLockRequested();
      await new Promise<void>((resolve) => {
        params.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw params.signal?.reason;
    });

    const attempt = createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:telegram:direct:123",
      tempPaths,
      sessionPrompt: prompt,
      attemptOverrides: {
        abortSignal: abortController.signal,
      },
    });
    await lockRequested;
    abortController.abort(abortError);

    await expect(attempt).rejects.toBe(abortError);

    expect(hoisted.createAgentSessionMock).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(observedSignal).toBe(abortController.signal);
  });

  it("installs overload retries after the watchdog with its finite deadline", async () => {
    vi.useFakeTimers();
    const installationOrder: string[] = [];
    const onAttemptTimeoutArmed = vi.fn(() => {
      installationOrder.push("watchdog");
    });
    vi.mocked(wrapStreamFnWithModelRetry).mockImplementationOnce((baseFn) => {
      installationOrder.push("retry");
      return baseFn;
    });

    const attempt = createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:telegram:direct:123",
      tempPaths,
      sessionPrompt: async () => {},
      attemptOverrides: {
        timeoutMs: 50,
        retryOverloadUntilRunTimeout: true,
        onAttemptTimeoutArmed,
      },
    });
    const result = await attempt;

    expect(installationOrder).toEqual(["watchdog", "retry"]);
    expect(onAttemptTimeoutArmed).toHaveBeenCalledTimes(1);
    expect(wrapStreamFnWithModelRetry).toHaveBeenCalledTimes(1);
    const retryDeadline = vi.mocked(wrapStreamFnWithModelRetry).mock.calls[0]?.[1]
      ?.overloadRetryUntil;
    expect(retryDeadline?.()).toBe(Date.now() + 50);
    expect(result).toMatchObject({ timedOut: false, timedOutByRunBudget: false });
  });
});
