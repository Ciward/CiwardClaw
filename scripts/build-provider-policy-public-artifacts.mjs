#!/usr/bin/env node
// Builds provider policy surfaces as standalone ESM files for synchronous runtime loading.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import { collectBundledPluginBuildEntries } from "./lib/bundled-plugin-build-entries.mjs";
import {
  buildPluginSdkEntrySources,
  publicPluginSdkEntrypoints,
} from "./lib/plugin-sdk-entries.mjs";

const PROVIDER_POLICY_SOURCE_RE = /^\.\/provider-policy-api\.[cm]?[jt]s$/u;
export const PROVIDER_POLICY_SYNC_ARTIFACT = "provider-policy-api.sync.js";

export function listProviderPolicyPublicArtifactBuilds(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const entries = params.entries ?? collectBundledPluginBuildEntries({ cwd });
  return entries.flatMap(({ id, sourceEntries }) => {
    const sourceEntry = sourceEntries.find((entry) => PROVIDER_POLICY_SOURCE_RE.test(entry));
    if (!sourceEntry) {
      return [];
    }
    return [
      {
        id,
        sourcePath: path.join(cwd, "extensions", id, sourceEntry.slice(2)),
        outDir: path.join(cwd, "dist", "extensions", id),
        outputPath: path.join(cwd, "dist", "extensions", id, PROVIDER_POLICY_SYNC_ARTIFACT),
      },
    ];
  });
}

export function buildProviderPolicySdkAliases(cwd = process.cwd()) {
  return Object.fromEntries(
    Object.entries(buildPluginSdkEntrySources(publicPluginSdkEntrypoints)).map(
      ([entry, sourcePath]) => [`openclaw/plugin-sdk/${entry}`, path.resolve(cwd, sourcePath)],
    ),
  );
}

function assertStandaloneArtifact(outputPath) {
  const source = fs.readFileSync(outputPath, "utf8");
  const nonBuiltinImports = source.split("\n").filter((line) => {
    const match = /^\s*import(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']/u.exec(line);
    return match && !match[1].startsWith("node:");
  });
  if (nonBuiltinImports.length > 0) {
    throw new Error(
      `${path.relative(process.cwd(), outputPath)} retained non-builtin imports:\n${nonBuiltinImports.join("\n")}`,
    );
  }
}

export async function buildProviderPolicyPublicArtifacts(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const builds = listProviderPolicyPublicArtifactBuilds({ cwd, entries: params.entries });
  const alias = buildProviderPolicySdkAliases(cwd);
  await Promise.all(
    builds.map(async (entry) => {
      await build({
        config: false,
        cwd,
        entry: { "provider-policy-api.sync": entry.sourcePath },
        outDir: entry.outDir,
        clean: false,
        dts: false,
        format: "esm",
        platform: "node",
        outExtensions: () => ({ js: ".js" }),
        fixedExtension: false,
        hash: false,
        alias,
        deps: {
          alwaysBundle: (id) => !id.startsWith("node:"),
        },
        // Provider policy hooks are pure. Dropping unrelated barrel side effects keeps each
        // synchronous artifact self-contained instead of pulling the full plugin SDK graph.
        treeshake: { moduleSideEffects: false },
        outputOptions: { codeSplitting: false },
        logLevel: "silent",
      });
      assertStandaloneArtifact(entry.outputPath);
    }),
  );
  return builds.map((entry) => entry.outputPath);
}

function isMainModule() {
  const argv1 = process.argv[1];
  return Boolean(argv1) && import.meta.url === pathToFileURL(argv1).href;
}

if (isMainModule()) {
  const outputs = await buildProviderPolicyPublicArtifacts();
  console.log(`Built ${outputs.length} standalone provider policy artifacts.`);
}
