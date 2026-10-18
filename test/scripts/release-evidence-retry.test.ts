import { afterEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ read: vi.fn(), sleep: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  return {
    ...(await importOriginal<typeof import("node:child_process")>()),
    execFileSync: (...args: unknown[]) => transport.read(...args),
    execFile: Object.assign(vi.fn(), {
      [promisify.custom]: async (...args: unknown[]) => ({
        stdout: transport.read(...args),
        stderr: "",
      }),
    }),
  };
});
vi.mock("node:timers/promises", () => ({ setTimeout: transport.sleep }));

import { createReleaseEvidenceClient, runReleaseCiGh } from "../../scripts/release-ci-summary.mjs";

afterEach(() => {
  vi.restoreAllMocks();
  transport.read.mockReset();
  transport.sleep.mockReset();
});

describe("release evidence API reads", () => {
  // Job-listing 5xx responses fall back to smaller pages instead (covered below), so async
  // job reads exercise the transient retry budget with a network error.
  it.each(["sync", "async"])("recovers a transient failure followed by 200 (%s)", async (mode) => {
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const failure = Object.assign(
      new Error("gh failed"),
      mode === "sync"
        ? { stderr: "gh: Server Error (HTTP 502)", stdout: "partial response" }
        : { code: "ECONNRESET" },
    );
    transport.read.mockImplementationOnce(() => {
      throw failure;
    });
    transport.read.mockReturnValue(
      mode === "sync" ? '{"id":42}' : '{"total_count":1,"jobs":[{"id":7}]}',
    );
    const client = createReleaseEvidenceClient("openclaw/openclaw");
    const result =
      mode === "sync" ? client.getRunAttempt("42", 1) : await client.getRunAttemptJobs("42", 1);
    expect(result).toEqual(mode === "sync" ? { id: 42 } : [{ id: 7 }]);
    expect(transport.read).toHaveBeenCalledTimes(2);
    expect(
      mode === "sync"
        ? wait.mock.calls.map((call) => call[3])
        : transport.sleep.mock.calls.map((call) => call[0]),
    ).toEqual([2000]);
  });

  it.each(["sync", "async"])("fails after four transient failures (%s)", async (mode) => {
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const failure = Object.assign(
      new Error("gh failed"),
      mode === "sync" ? { stderr: "gh: Server Error (HTTP 502)" } : { code: "ECONNRESET" },
    );
    transport.read.mockImplementation(() => {
      throw failure;
    });
    const client = createReleaseEvidenceClient("openclaw/openclaw");
    await expect(
      Promise.resolve().then(() =>
        mode === "sync" ? client.getRunAttempt("42", 1) : client.getRunAttemptJobs("42", 1),
      ),
    ).rejects.toBe(failure);
    expect(transport.read).toHaveBeenCalledTimes(4);
    expect(
      mode === "sync"
        ? wait.mock.calls.map((call) => call[3])
        : transport.sleep.mock.calls.map((call) => call[0]),
    ).toEqual([2000, 4000, 8000]);
  });

  it.each([
    [
      "POST",
      ["api", "repos/openclaw/openclaw/actions/runs/42/rerun", "--method", "POST"],
      "HTTP 502",
    ],
    ["implicit POST", ["api", "repos/openclaw/openclaw/issues", "-f", "title=test"], "HTTP 502"],
    ["GraphQL", ["api", "graphql"], "HTTP 502"],
    ["forbidden", ["api", "repos/openclaw/openclaw/actions/runs/42"], "HTTP 403"],
    ["rate limited", ["api", "repos/openclaw/openclaw/actions/runs/42"], "HTTP 429"],
  ])("does not retry %s", (_label, args, stderr) => {
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const failure = Object.assign(new Error("gh failed"), { stderr });
    transport.read.mockImplementation(() => {
      throw failure;
    });
    expect(() => runReleaseCiGh(args)).toThrow(failure);
    expect(transport.read).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it.each([
    { total: 1000, requireComplete: true, result: 1000 },
    { total: 1001, requireComplete: true, result: "incomplete or duplicated" },
    { total: 1001, requireComplete: false, result: 1000 },
  ])(
    "keeps the 1,000-job ceiling after falling back to 30-job pages: $total jobs, complete $requireComplete",
    async ({ total, requireComplete, result }) => {
      const jobs = Array.from({ length: total }, (_, index) => ({ id: index + 1 }));
      transport.read.mockImplementation((_bin: string, args: string[]) => {
        const query = new URLSearchParams((args[1] ?? "").split("?")[1]);
        const perPage = Number(query.get("per_page"));
        if (perPage > 30) {
          throw Object.assign(new Error("gh failed"), { stderr: "gh: Server Error (HTTP 502)" });
        }
        const start = (Number(query.get("page")) - 1) * perPage;
        return JSON.stringify({ total_count: total, jobs: jobs.slice(start, start + perPage) });
      });
      const read = createReleaseEvidenceClient("openclaw/openclaw").getRunAttemptJobs("42", 2, {
        requireComplete,
      });
      if (typeof result === "number") {
        await expect(read).resolves.toEqual(jobs.slice(0, result));
      } else {
        await expect(read).rejects.toThrow(result);
      }
      // 100 and 50 each fail once; 30-job pages stop once 1,000 jobs are held (34 pages).
      expect(transport.read).toHaveBeenCalledTimes(2 + 34);
      expect(transport.sleep).not.toHaveBeenCalled();
    },
  );

  it("recovers a network error", () => {
    vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    transport.read.mockImplementationOnce(() => {
      throw Object.assign(new Error("connection failed"), { code: "ECONNRESET" });
    });
    transport.read.mockReturnValue('{"id":42}');
    expect(createReleaseEvidenceClient("openclaw/openclaw").getRunAttempt("42", 1)).toEqual({
      id: 42,
    });
    expect(transport.read).toHaveBeenCalledTimes(2);
  });

  it("does not retry a malformed successful response", () => {
    transport.read.mockReturnValue("invalid JSON");
    expect(() => createReleaseEvidenceClient("openclaw/openclaw").getRunAttempt("42", 1)).toThrow();
    expect(transport.read).toHaveBeenCalledOnce();
  });
});
