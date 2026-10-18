import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { buildUpdateRehearsalPathEnv } from "./update-rehearsal-paths.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

function rehearsalEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...buildUpdateRehearsalPathEnv(root),
    OPENCLAW_UPDATE_IN_PROGRESS: "0",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
    OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
  };
}

it.each(["prepared", "incomplete"])(
  "reuses only prepared rehearsal shared state across checks (%s)",
  async (kind) => {
    const root = fs.realpathSync(dirs.make("sqlite-rehearsal-shared-"));
    const env = {
      ...rehearsalEnv(root),
      ...(kind === "incomplete" ? { OPENCLAW_SKIP_CHANNELS: undefined } : {}),
    };
    const options = { env, path: path.join(root, "state", "openclaw.sqlite") };
    const database = openOpenClawStateDatabase(options);
    database.db.exec("CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES (1)");
    await closeOpenClawStateDatabaseAsync();
    await withEnvAsync(env, async () => {
      for (const value of [1, 2]) {
        withArtifactPreservingStateReads(() => {
          withOpenClawStateDatabaseReadOnly(({ db }) => {
            expect(db.location() === options.path).toBe(kind === "prepared");
            expect(db.prepare("SELECT value FROM probe").get()).toEqual({ value });
          }, options);
        });
        const candidate = openNodeSqliteDatabase(options.path);
        candidate.exec("UPDATE probe SET value = 2");
        candidate.close();
      }
    });
  },
);
