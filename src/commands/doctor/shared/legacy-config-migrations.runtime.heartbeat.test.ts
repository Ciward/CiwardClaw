import { describe, expect, it } from "vitest";
import { HEARTBEAT_PROMPT } from "../../../auto-reply/heartbeat.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { validateConfigObjectRaw } from "../../../config/validation-core.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

const OBSERVED_LEGACY_PROMPT =
  "Read local file HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.";
// Shipped in v2026.7.35: src/auto-reply/heartbeat.ts.
const SHIPPED_LEGACY_PROMPT =
  "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.";

const migrate = (raw: unknown) =>
  applyLegacyDoctorMigrations(raw, { sourceConfigBeforeMigrations: raw, pluginContracts: false });

const heartbeatSettings = {
  every: "1h",
  activeHours: { start: "08:00", end: "22:00", timezone: "Asia/Shanghai" },
  model: "example/monitor",
  session: "agent:main:heartbeat",
  target: "last",
  to: "fixture-recipient",
  accountId: "fixture-account",
  timeoutSeconds: 90,
  lightContext: true,
  isolatedSession: true,
};

describe("legacy default heartbeat prompt migration", () => {
  it.each([
    { name: "observed local-file default", prompt: OBSERVED_LEGACY_PROMPT },
    { name: "v2026.7.35 default", prompt: SHIPPED_LEGACY_PROMPT },
  ])("retires the $name override in defaults and keyed entries", ({ prompt }) => {
    const raw = {
      agents: {
        defaults: { heartbeat: { ...structuredClone(heartbeatSettings), prompt } },
        entries: {
          main: {
            model: "example/chat",
            heartbeat: { ...structuredClone(heartbeatSettings), prompt },
          },
        },
      },
    };
    const original = structuredClone(raw);
    expect(findLegacyConfigIssues(raw)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "agents.defaults.heartbeat.prompt",
          message: expect.stringContaining("doctor --fix"),
        }),
        expect.objectContaining({
          path: "agents",
          message: expect.stringContaining("heartbeat.prompt"),
        }),
      ]),
    );

    const result = migrate(raw);

    expect(result.next).toEqual({
      agents: {
        defaults: { heartbeat: heartbeatSettings },
        entries: { main: { model: "example/chat", heartbeat: heartbeatSettings } },
      },
    });
    expect(result.changes).toEqual([
      expect.stringContaining("agents.defaults.heartbeat.prompt"),
      expect.stringContaining("agents.entries.main.heartbeat.prompt"),
    ]);
    expect(validateConfigObjectRaw(result.next).ok).toBe(true);
    expect(findLegacyConfigIssues(result.next)).toEqual([]);
    expect(migrate(result.next)).toEqual({ next: null, changes: [] });
    expect(raw).toEqual(original);
  });

  it("retires list-entry defaults while preserving custom prompts and heartbeat enrollment", () => {
    const customPrompt = `${SHIPPED_LEGACY_PROMPT} Also report database replication lag.`;
    const raw = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        list: [
          { id: "main", heartbeat: { prompt: OBSERVED_LEGACY_PROMPT } },
          { id: "monitor", heartbeat: { every: "15m", prompt: SHIPPED_LEGACY_PROMPT } },
          { id: "custom", heartbeat: { every: "2h", prompt: customPrompt } },
        ],
      },
    };
    expect(findLegacyConfigIssues(raw)).toContainEqual(
      expect.objectContaining({
        path: "agents",
        message: expect.stringContaining("heartbeat.prompt"),
      }),
    );

    const result = migrate(raw);

    expect(result.next).toEqual({
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { heartbeat: {} },
          monitor: { heartbeat: { every: "15m" } },
          custom: { heartbeat: { every: "2h", prompt: customPrompt } },
        },
      },
    });
    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("agents.list[0].heartbeat.prompt"),
        expect.stringContaining("agents.list[1].heartbeat.prompt"),
      ]),
    );
    expect(validateConfigObjectRaw(result.next).ok).toBe(true);
    expect(findLegacyConfigIssues(result.next)).toEqual([]);
    expect(migrate(result.next)).toEqual({ next: null, changes: [] });
  });

  it.each([
    HEARTBEAT_PROMPT,
    "Read HEARTBEAT.md and report database replication lag.",
    `${OBSERVED_LEGACY_PROMPT} Also report database replication lag.`,
    `${SHIPPED_LEGACY_PROMPT} Also report database replication lag.`,
    SHIPPED_LEGACY_PROMPT.replace("HEARTBEAT_OK", "CUSTOM_OK"),
    "",
    undefined,
    null,
    42,
  ])("preserves custom, canonical, absent, or malformed prompt %j", (prompt) => {
    const raw = {
      agents: {
        defaults: { heartbeat: { every: "1h", prompt } },
        entries: { main: { heartbeat: { every: "15m", prompt } } },
      },
    };
    expect(findLegacyConfigIssues(raw)).toEqual([]);
    expect(migrate(raw)).toEqual({ next: null, changes: [] });
  });

  it("preserves a custom default when retiring a per-agent default override", () => {
    const customHeartbeat = { every: "1h", prompt: "Report database replication lag." };
    const result = migrate({
      agents: {
        defaults: { heartbeat: customHeartbeat },
        entries: { main: { heartbeat: { prompt: OBSERVED_LEGACY_PROMPT } } },
      },
    });
    expect(result.next).toEqual({
      agents: {
        defaults: { heartbeat: customHeartbeat },
        entries: { main: { heartbeat: {} } },
      },
    });
    expect(result.changes).toEqual([
      expect.stringContaining("agents.entries.main.heartbeat.prompt"),
    ]);
  });
});
