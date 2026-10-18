import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import * as entryReads from "../config/sessions/session-accessor.sqlite-entry-read.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { assertSessionEntryCurrentAdmission } from "../config/sessions/session-entry-current-admission.js";
import { readSessionEntryCurrentFactsInDatabase } from "../config/sessions/session-entry-current-admission.worker.js";
import type { SessionEntryCurrentSource } from "../config/sessions/session-entry-current.types.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginStateSyncKeyedStore } from "./plugin-state-store.js";
import { executePluginStateCommand } from "./plugin-state.worker.js";

afterEach(() => vi.restoreAllMocks());

it.each(["label", "activeWriterRunId"] as const)(
  "acquires coherent native plugin-state admission facts across a foreign %s commit",
  async (field) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      database.db.exec("PRAGMA journal_mode = WAL");
      const sessionKey = "agent:main:plugin-claim";
      writeSessionEntry(database, sessionKey, { sessionId: "claim-session", updatedAt: 1 });
      const identity = readOpenClawAgentDatabaseIdentity(database);
      if (typeof identity.identity !== "string") {
        throw new Error("Expected the fixture's durable database identity");
      }
      const source: SessionEntryCurrentSource = {
        agentId: database.agentId,
        path: database.path,
        databaseIdentity: identity.identity,
        databaseBirthtime: identity.birthtime,
        sessionKey,
      };
      const options = { namespace: "native-claim", maxEntries: 10, env: state.env };
      const store = createPluginStateSyncKeyedStore<string>("device-pair", options);
      store.register("tab", "open");
      const stateDatabase = openOpenClawStateDatabase({ env: state.env });
      const stages: string[] = [];
      vi.spyOn(admission, "requestSqliteWorkerOperationAdmission").mockImplementation((request) => {
        assertSessionEntryCurrentAdmission(request, {
          source,
          assertCurrent: (entry) => {
            expect(entry?.sessionId).toBe("claim-session");
            if (entry?.activeWriterRunId !== undefined) {
              throw new Error("Session owner was replaced");
            }
          },
        });
        stages.push(request.stage);
      });
      const read = entryReads.readExactSessionEntryRow;
      const peer = new DatabaseSync(database.path);
      readSessionEntryCurrentFactsInDatabase(database, sessionKey);
      peer
        .prepare("UPDATE session_nodes SET display_name = ? WHERE session_key = ?")
        .run("Changed", sessionKey);
      vi.spyOn(entryReads, "readExactSessionEntryRow").mockImplementationOnce((...args) => {
        const row = read(...args);
        // Schedule a real foreign commit after row acquisition but before its revision check.
        peer
          .prepare(
            "UPDATE session_nodes SET entry_json = json_set(entry_json, ?, 'replacement') WHERE session_key = ?",
          )
          .run(`$.${field}`, sessionKey);
        return row;
      });
      try {
        const result = runWithSqliteWorkerStateContext(
          { environment: { ...state.env, OPENCLAW_STATE_DIR: state.stateDir } },
          () =>
            executePluginStateCommand(
              {
                type: "pluginState.observe",
                input: {
                  pluginId: "device-pair",
                  namespace: options.namespace,
                  key: "tab",
                  sessionEntryCurrentSources: [source],
                },
              },
              { ...options, path: stateDatabase.path },
              () => stateDatabase,
              true,
            ),
        );
        if (field === "label") {
          expect(result).toMatchObject({ ok: true, value: { value: "open" } });
          expect(stages).toEqual(["transaction", "commit"]);
        } else {
          expect(result).toMatchObject({
            ok: false,
            error: {
              code: "PLUGIN_STATE_READ_FAILED",
              cause: { message: "Session currency changed while awaiting its native grant" },
            },
          });
          expect(stages).toEqual(["transaction"]);
        }
        expect(store.lookup("tab")).toBe("open");
        expect(stateDatabase.db.isTransaction).toBe(false);
      } finally {
        peer.close();
      }
    });
  },
);
