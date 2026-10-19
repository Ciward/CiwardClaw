import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { someAgentEntry, visitAgentConfigScopes } from "./legacy-config-record-shared.js";

// v2026.7.35's default and the observed "local file" variant; match complete prompts only.
const LEGACY_HEARTBEAT_PROMPTS = new Set([
  "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
  "Read local file HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
]);

function isLegacyHeartbeatPrompt(value: unknown): boolean {
  return typeof value === "string" && LEGACY_HEARTBEAT_PROMPTS.has(value);
}

const CRON_RUN_LOG_RULE: LegacyConfigRule = {
  path: ["cron", "runLog"],
  message:
    'cron.runLog is retired; run history now has fixed per-job retention. Run "openclaw doctor --fix".',
};

const CRON_WEBHOOK_RULE: LegacyConfigRule = {
  path: ["cron", "webhook"],
  message:
    'cron.webhook was retired after per-job delivery migration. Run "openclaw doctor --fix".',
};

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "agents.heartbeat.legacy-file-prompt",
    describe: "Remove legacy default file-based heartbeat prompts",
    legacyRules: [
      {
        path: ["agents", "defaults", "heartbeat", "prompt"],
        match: isLegacyHeartbeatPrompt,
        message:
          'agents.defaults.heartbeat.prompt uses the legacy file-based default; heartbeat now uses monitor scratch. Run "openclaw doctor --fix".',
      },
      {
        path: ["agents"],
        match: (value) =>
          someAgentEntry(value, (agent) =>
            isLegacyHeartbeatPrompt(getRecord(agent.heartbeat)?.prompt),
          ),
        message:
          'Per-agent heartbeat.prompt uses the legacy file-based default; heartbeat now uses monitor scratch. Run "openclaw doctor --fix".',
      },
    ],
    apply: (raw, changes) => {
      visitAgentConfigScopes(raw, (agent, path) => {
        const heartbeat = getRecord(agent.heartbeat);
        if (!heartbeat || !isLegacyHeartbeatPrompt(heartbeat.prompt)) {
          return;
        }
        delete heartbeat.prompt;
        changes.push(
          `Removed legacy default ${path}.heartbeat.prompt; heartbeat monitor scratch defaults now apply.`,
        );
      });
    },
  }),
  defineLegacyConfigMigration({
    id: "cron.webhook-remove",
    describe: "Remove retired global cron webhook fallback",
    legacyRules: [CRON_WEBHOOK_RULE],
    apply: (raw, changes) => {
      const cron = getRecord(raw.cron);
      if (!cron || !Object.hasOwn(cron, "webhook")) {
        return;
      }
      delete cron.webhook;
      changes.push("Removed retired cron.webhook after stored jobs migrated to per-job delivery.");
    },
  }),
  defineLegacyConfigMigration({
    id: "cron.runLog-remove",
    describe: "Remove retired cron run-log retention config",
    legacyRules: [CRON_RUN_LOG_RULE],
    apply: (raw, changes) => {
      const cron = getRecord(raw.cron);
      if (!cron || !Object.hasOwn(cron, "runLog")) {
        return;
      }
      delete cron.runLog;
      if (Object.keys(cron).length === 0) {
        delete raw.cron;
      }
      changes.push("Removed retired cron.runLog config; cron history now keeps 2000 runs per job.");
    },
  }),
];
