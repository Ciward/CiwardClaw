import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProviderPolicyPublicArtifacts,
  listProviderPolicyPublicArtifactBuilds,
  PROVIDER_POLICY_SYNC_ARTIFACT,
} from "../../scripts/build-provider-policy-public-artifacts.mjs";

describe("provider policy public artifact build", () => {
  it("emits a standalone synchronous artifact only for provider policy entries", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-provider-policy-build-"));
    const sourceDir = path.join(cwd, "extensions", "fixture");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "provider-policy-api.ts"),
      'export const marker = "standalone-provider-policy";\n',
      "utf8",
    );
    const entries = [
      {
        id: "fixture",
        sourceEntries: ["./index.ts", "./provider-policy-api.ts"],
      },
      {
        id: "without-policy",
        sourceEntries: ["./index.ts"],
      },
    ];

    try {
      const builds = listProviderPolicyPublicArtifactBuilds({ cwd, entries });
      expect(builds).toEqual([
        {
          id: "fixture",
          sourcePath: path.join(sourceDir, "provider-policy-api.ts"),
          outDir: path.join(cwd, "dist", "extensions", "fixture"),
          outputPath: path.join(
            cwd,
            "dist",
            "extensions",
            "fixture",
            PROVIDER_POLICY_SYNC_ARTIFACT,
          ),
        },
      ]);

      await expect(buildProviderPolicyPublicArtifacts({ cwd, entries })).resolves.toEqual([
        builds[0]?.outputPath,
      ]);
      const output = fs.readFileSync(builds[0]?.outputPath ?? "", "utf8");
      expect(output).toContain("standalone-provider-policy");
      expect(output).not.toMatch(/^\s*import\b/mu);
    } finally {
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  });
});
