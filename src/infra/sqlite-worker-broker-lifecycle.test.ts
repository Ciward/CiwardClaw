import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createSqliteWorkerLifecycle } from "./sqlite-worker-broker-lifecycle.js";
import type { Actor } from "./sqlite-worker-broker.types.js";

const createCpuTrackedWorker = vi.hoisted(() => vi.fn());
vi.mock("./worker-cpu.js", () => ({ createCpuTrackedWorker }));
vi.mock("./bun-sqlite-library.js", () => ({
  ensureSqliteLibrarySelected: () => {},
}));

beforeEach(() => {
  createCpuTrackedWorker.mockReset();
});

describe("SQLite worker slots", () => {
  // Bun resolves a `file:` preload by stripping "file://", so tsx's URL breaks on Windows.
  it.each([
    { runtime: "Node", bun: undefined, execArgv: ["--import", import.meta.resolve("tsx/esm")] },
    { runtime: "Bun", bun: "1.4.3", execArgv: [] },
  ])("gives $runtime source workers only the TypeScript loader they need", ({ bun, execArgv }) => {
    const versions = Object.getOwnPropertyDescriptor(process, "versions");
    Object.defineProperty(process, "versions", {
      configurable: true,
      value: { ...process.versions, bun },
    });
    try {
      createCpuTrackedWorker.mockReturnValueOnce(
        Object.assign(new EventEmitter(), { unref: vi.fn() }),
      );
      const lifecycle = createSqliteWorkerLifecycle({
        explicitSqliteCloseReleasesNativeResources: true,
        actors: new Map(),
        slots: new Set(),
        stores: new Map(),
        enqueueClose: vi.fn(),
        fail: vi.fn(),
      });
      lifecycle.createSlot(
        {
          carrierUrl: new URL("file:///openclaw/src/infra/sqlite-store.worker.ts"),
          moduleUrl: new URL("file:///openclaw/src/infra/device-auth-store.sqlite.ts"),
          databasePath: "/state/openclaw.sqlite",
          input: Buffer.alloc(0),
          existingOnly: false,
        },
        false,
        () => ({ fail: vi.fn(), finish: vi.fn(), dispatch: vi.fn() }),
      );
      expect(createCpuTrackedWorker).toHaveBeenLastCalledWith(
        expect.any(URL),
        expect.objectContaining({ execArgv }),
      );
    } finally {
      if (versions) {
        Object.defineProperty(process, "versions", versions);
      }
    }
  });

  it.each([
    { capable: true, closeFails: false },
    { capable: false, closeFails: false },
    { capable: true, closeFails: true },
    { capable: false, closeFails: true },
  ])(
    "settles native custody after close or required exit (capable: $capable, failed: $closeFails)",
    async ({ capable, closeFails }) => {
      const terminating = createDeferredCore();
      const worker = Object.assign(new EventEmitter(), {
        unref: vi.fn(),
        terminate: vi.fn(() => {
          terminating.resolve();
          return Promise.resolve(0);
        }),
      });
      createCpuTrackedWorker.mockReturnValueOnce(worker);
      const actors = new Map<string, Actor>();
      const error = new Error("native close failed");
      const lifecycle = createSqliteWorkerLifecycle({
        explicitSqliteCloseReleasesNativeResources: capable,
        actors,
        slots: new Set(),
        stores: new Map(),
        enqueueClose: closeFails
          ? vi.fn().mockRejectedValue(error)
          : vi.fn().mockResolvedValue(undefined),
        fail: () => terminating.resolve(),
      });
      const slot = lifecycle.createSlot(
        {
          carrierUrl: new URL("file:///openclaw/dist/sqlite-store.worker.js"),
          moduleUrl: new URL("file:///openclaw/dist/device-auth-store.sqlite.js"),
          databasePath: "/state/openclaw.sqlite",
          input: Buffer.alloc(0),
          existingOnly: false,
        },
        false,
        () => ({ fail: vi.fn(), finish: vi.fn(), dispatch: vi.fn() }),
      );
      const nativeStopped = createDeferredCore();
      const markNativeStopped = vi.fn(nativeStopped.resolve);
      const actor: Actor = {
        id: 1,
        key: "fixture",
        databasePath: "/state/openclaw.sqlite",
        pathReferences: new Map(),
        moduleUrl: "file:///openclaw/dist/device-auth-store.sqlite.js",
        inputHash: "fixture",
        slot,
        references: 0,
        opened: Promise.resolve(),
        openDispatch: { dispatched: true },
        initialized: true,
        backendClosed: false,
        nativeStopped: nativeStopped.promise,
        markNativeStopped,
      };
      actors.set(actor.key, actor);
      slot.actors.add(actor);
      // A pending sibling open prevents the ordinary empty-slot retirement path.
      let settled = false;
      const closing = lifecycle.closeActor(actor).finally(() => {
        settled = true;
      });
      const outcome = Promise.allSettled([closing]);
      if (!capable || closeFails) {
        await terminating.promise;
        expect(settled).toBe(false);
        expect(markNativeStopped).not.toHaveBeenCalled();
        worker.emit("exit", 0);
      } else {
        await closing;
        expect(worker.terminate).not.toHaveBeenCalled();
      }
      expect(await outcome).toEqual([
        closeFails
          ? { status: "rejected", reason: error }
          : { status: "fulfilled", value: undefined },
      ]);
      expect(markNativeStopped).toHaveBeenCalledOnce();
      expect(actors.size).toBe(0);
    },
  );
});

it("cancels a slot waiter without releasing a retiring worker's capacity", async ({ signal }) => {
  const worker = Object.assign(new EventEmitter(), { unref: vi.fn() });
  createCpuTrackedWorker.mockImplementation(() => worker);
  const slots = new Set<ReturnType<ReturnType<typeof createSqliteWorkerLifecycle>["createSlot"]>>();
  const lifecycle = createSqliteWorkerLifecycle({
    explicitSqliteCloseReleasesNativeResources: true,
    actors: new Map(),
    slots,
    stores: new Map(),
    enqueueClose: vi.fn(),
    fail: vi.fn(),
  });
  const options = {
    carrierUrl: new URL("file:///openclaw/src/infra/sqlite-store.worker.ts"),
    moduleUrl: new URL("file:///openclaw/src/infra/device-auth-store.sqlite.ts"),
    databasePath: "/state/openclaw.sqlite",
    input: Buffer.alloc(0),
    existingOnly: false,
  };
  const replyOwner = () => ({ fail: vi.fn(), finish: vi.fn(), dispatch: vi.fn() });
  const retiring = lifecycle.createSlot(options, false, replyOwner);
  retiring.retiring = retiring.exit;
  const canceled = new AbortController();
  const reason = new Error("worker callback deadline expired");
  const pending = lifecycle.acquireSlot(
    { ...options, signal: canceled.signal },
    { maxWorkers: 1, maxStores: 1 },
    replyOwner,
  );
  const rejected = expect(pending).rejects.toBe(reason);
  canceled.abort(reason);
  try {
    await withinTest(rejected, signal);
    expect(slots.has(retiring)).toBe(true);
    expect(createCpuTrackedWorker).toHaveBeenCalledOnce();
    worker.emit("exit", 0);
    const successor = await lifecycle.acquireSlot(
      options,
      { maxWorkers: 1, maxStores: 1 },
      replyOwner,
    );
    expect(slots.has(retiring)).toBe(false);
    expect(slots.has(successor)).toBe(true);
    expect(createCpuTrackedWorker).toHaveBeenCalledTimes(2);
  } finally {
    worker.emit("exit", 0);
    await Promise.allSettled([pending]);
  }
});
