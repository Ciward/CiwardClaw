import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPackageIntegrityReader } from "./package-update-integrity.js";
import { legacyPackageFingerprint } from "./package-update-legacy.test-support.js";
import { writePackageRoot } from "./package-update-steps.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform === "win32")(
  "reproduces the published 2026.9.8 tree seal in legacy mode",
  async () => {
    const root = dirs.make("publication-legacy-");
    await writePackageRoot(root, "2026.9.8");
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules/.package-lock.json"), "{}");
    fs.symlinkSync("package.json", path.join(root, "manifest-link"));
    fs.linkSync(path.join(root, "package.json"), path.join(root, "manifest-hardlink"));
    const fingerprint = legacyPackageFingerprint(root);

    await expect(createPackageIntegrityReader().tree(root, root, undefined, true)).resolves.toEqual(
      fingerprint,
    );
    expect((await createPackageIntegrityReader().tree(root)).digest).not.toBe(fingerprint.digest);
  },
);

it.skipIf(process.platform === "win32")(
  "keeps link-count drift visible to the legacy candidate seal",
  async () => {
    const parent = dirs.make("publication-ctime-");
    const root = path.join(parent, "package");
    await writePackageRoot(root, "2026.9.8");
    const fingerprint = legacyPackageFingerprint(root);
    const file = path.join(root, "package.json");
    const before = fs.statSync(file, { bigint: true });
    fs.linkSync(file, path.join(parent, "temporary-hardlink"));
    expect(fs.statSync(file, { bigint: true }).nlink).toBe(before.nlink + 1n);

    const observed = await createPackageIntegrityReader().tree(root, root, undefined, true);
    expect(observed.digest).not.toBe(fingerprint.digest);
    expect(observed.digest).toBe(legacyPackageFingerprint(root).digest);
  },
);
