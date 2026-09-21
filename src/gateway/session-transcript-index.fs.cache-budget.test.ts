import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionTranscriptIndexCache,
  readSessionTranscriptIndex,
  sessionTranscriptIndexCacheBytesForTest,
  setSessionTranscriptIndexCacheBudgetForTest,
} from "./session-transcript-index.fs.js";

let root: string;

async function writeTranscript(name: string, approxBytes: number): Promise<string> {
  const filePath = path.join(root, name);
  const filler = "x".repeat(1024);
  const line = `${JSON.stringify({ type: "user", message: { role: "user", content: filler } })}\n`;
  const lines = Math.max(1, Math.ceil(approxBytes / line.length));
  await fs.promises.writeFile(filePath, line.repeat(lines));
  return filePath;
}

function cachedBytes(): number {
  return sessionTranscriptIndexCacheBytesForTest();
}

beforeEach(async () => {
  // Resolve symlinks: macOS os.tmpdir() is /var -> /private/var.
  root = await fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), "transcript-budget-")),
  );
  clearSessionTranscriptIndexCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  setSessionTranscriptIndexCacheBudgetForTest();
  clearSessionTranscriptIndexCache();
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe("transcript index cache byte accounting", () => {
  it("leaves the byte total unchanged when a cached transcript is re-read", async () => {
    const filePath = await writeTranscript("a.jsonl", 16 * 1024);
    const { size } = await fs.promises.stat(filePath);
    await readSessionTranscriptIndex(filePath);
    expect(cachedBytes()).toBe(size);

    // A cache hit re-inserts the same entry to refresh LRU order; that bare
    // delete+set must not touch the running total.
    const open = vi.spyOn(fs.promises, "open");
    await readSessionTranscriptIndex(filePath);

    expect(open).not.toHaveBeenCalled();
    expect(cachedBytes()).toBe(size);
  });

  it("replaces rather than accumulates bytes when a transcript grows", async () => {
    const filePath = await writeTranscript("a.jsonl", 16 * 1024);
    await readSessionTranscriptIndex(filePath);

    await writeTranscript("a.jsonl", 64 * 1024);
    const { size } = await fs.promises.stat(filePath);
    await readSessionTranscriptIndex(filePath);

    expect(cachedBytes()).toBe(size);
  });

  it("releases bytes when the transcript disappears", async () => {
    const filePath = await writeTranscript("a.jsonl", 16 * 1024);
    await readSessionTranscriptIndex(filePath);
    await fs.promises.rm(filePath);

    expect(await readSessionTranscriptIndex(filePath)).toBeNull();

    expect(cachedBytes()).toBe(0);
  });

  it("evicts oldest transcripts once cached bytes exceed the budget", async () => {
    const perFile = 16 * 1024;
    setSessionTranscriptIndexCacheBudgetForTest(perFile * 3);
    const paths: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      paths.push(await writeTranscript(`t${i}.jsonl`, perFile));
    }

    for (const filePath of paths) {
      await readSessionTranscriptIndex(filePath);
    }

    const totalBytes = paths.reduce((sum, p) => sum + fs.statSync(p).size, 0);
    expect(totalBytes).toBeGreaterThan(perFile * 3);
    expect(cachedBytes()).toBeLessThanOrEqual(perFile * 3);
    // Guard against an empty cache trivially satisfying the budget.
    expect(cachedBytes()).toBeGreaterThan(0);

    // Eviction stays invisible to callers: the evicted transcript rebuilds.
    const open = vi.spyOn(fs.promises, "open");
    const rebuilt = await readSessionTranscriptIndex(paths[0]);
    expect(open).toHaveBeenCalled();
    expect(rebuilt?.entries.length).toBeGreaterThan(0);
  });

  it("keeps a single transcript larger than the whole budget cached", async () => {
    const budget = 16 * 1024;
    setSessionTranscriptIndexCacheBudgetForTest(budget);
    const filePath = await writeTranscript("huge.jsonl", budget * 4);
    const { size } = await fs.promises.stat(filePath);

    expect(await readSessionTranscriptIndex(filePath)).not.toBeNull();

    // Evicting it would rebuild the index on every read; the budget yields here.
    expect(size).toBeGreaterThan(budget);
    expect(cachedBytes()).toBe(size);
  });
});
