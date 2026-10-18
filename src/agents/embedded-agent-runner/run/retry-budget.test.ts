import { describe, expect, it } from "vitest";
import {
  beginRunAttempt,
  createRunRetryBudget,
  isRunRetryBudgetExhausted,
  recordRunRetry,
  resolveRunRetryKind,
} from "./retry-budget.js";

describe("run retry budget", () => {
  it("allows more than 32 progressing continuations", () => {
    const budget = createRunRetryBudget(32);

    for (let step = 0; step < 33; step += 1) {
      beginRunAttempt(budget);
      recordRunRetry(
        budget,
        resolveRunRetryKind({
          preflightRecovery: {
            route: "truncate_tool_results_only",
            truncatedCount: 0,
          },
          retryingFromTranscript: true,
          toolMetas: [{ toolName: "read", meta: `step=${step}`, isError: false }],
        }),
      );
    }

    expect(budget).toEqual({ attemptsDispatched: 33, attemptsCounted: 0, maxAttempts: 32 });
    expect(isRunRetryBudgetExhausted(budget)).toBe(false);
  });

  it("allows deadline-bound overload recovery past the counted attempt ceiling", () => {
    const budget = createRunRetryBudget(32);
    const now = Date.now();

    for (let attempt = 0; attempt < 33; attempt += 1) {
      beginRunAttempt(budget);
      recordRunRetry(budget, "recovery");
    }

    expect(isRunRetryBudgetExhausted(budget, { deadlineAtMs: now + 1_000 })).toBe(false);
    expect(isRunRetryBudgetExhausted(budget)).toBe(true);
  });

  it("stops deadline-bound overload recovery when the deadline expires", () => {
    const budget = createRunRetryBudget(32);
    const now = Date.now();

    expect(isRunRetryBudgetExhausted(budget, { deadlineAtMs: now + 1_000 })).toBe(false);
    expect(isRunRetryBudgetExhausted(budget, { deadlineAtMs: now - 1 })).toBe(true);
  });

  it("does not let ordinary recovery bypass the counted attempt ceiling", () => {
    const budget = createRunRetryBudget(32);
    for (let attempt = 0; attempt < 33; attempt += 1) {
      beginRunAttempt(budget);
      recordRunRetry(budget, "recovery");
    }

    expect(isRunRetryBudgetExhausted(budget)).toBe(true);
  });

  it("does not erase retries used before a progress continuation", () => {
    const budget = createRunRetryBudget(32);
    for (let retry = 0; retry < 31; retry += 1) {
      beginRunAttempt(budget);
      recordRunRetry(budget, "recovery");
    }

    beginRunAttempt(budget);
    recordRunRetry(budget, "progress_continuation");
    expect(budget.attemptsCounted).toBe(31);

    beginRunAttempt(budget);
    recordRunRetry(budget, "recovery");
    expect(isRunRetryBudgetExhausted(budget)).toBe(true);
  });
});
