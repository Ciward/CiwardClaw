import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { markGatewayStartupMainSessionOrphans } from "./server-startup-main-session-orphans.js";

const markStartupOrphanedMainSessionsForRecovery = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../agents/main-session-recovery/main-session-restart-recovery-marking.js", () => ({
  markStartupOrphanedMainSessionsForRecovery,
}));

function mark(isRestartRecoverySuppressed: () => boolean) {
  return markGatewayStartupMainSessionOrphans(
    {
      cfg: {} as OpenClawConfig,
      isRestartRecoverySuppressed,
      scheduler: { signal: new AbortController().signal },
      log: { warn: vi.fn() },
    },
    new Set(),
  );
}

describe("markGatewayStartupMainSessionOrphans", () => {
  beforeEach(() => {
    markStartupOrphanedMainSessionsForRecovery.mockClear();
  });

  it("quarantines interrupted main sessions while crash-loop recovery is suppressed", async () => {
    await mark(() => true);

    expect(markStartupOrphanedMainSessionsForRecovery).not.toHaveBeenCalled();
  });

  it("marks interrupted main sessions when recovery is not suppressed", async () => {
    await mark(() => false);

    expect(markStartupOrphanedMainSessionsForRecovery).toHaveBeenCalledOnce();
  });
});
