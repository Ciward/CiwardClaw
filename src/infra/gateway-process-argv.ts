function normalizeProcArg(arg: string): string {
  return arg.replaceAll("\\", "/").toLowerCase();
}

export function parseProcCmdline(raw: string): string[] {
  return raw
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function isGatewayArgv(args: string[], opts?: { allowGatewayBinary?: boolean }): boolean {
  const normalized = args.map(normalizeProcArg);
  const exe = (normalized[0] ?? "").replace(/\.(bat|cmd|exe)$/i, "");
  const allowGatewayBinary = opts?.allowGatewayBinary === true;
  const isGatewayBinary =
    allowGatewayBinary && (exe.endsWith("/openclaw-gateway") || exe === "openclaw-gateway");

  // On macOS launchd restarts, `ps -o command=` can collapse argv to only
  // `openclaw-gateway` (process title) without a separate "gateway" token.
  if (isGatewayBinary) {
    return true;
  }

  if (!normalized.includes("gateway")) {
    return false;
  }

  const entryCandidates = [
    "dist/index.js",
    "dist/entry.js",
    "openclaw.mjs",
    "scripts/run-node.mjs",
    "src/index.ts",
  ];
  if (normalized.some((arg) => entryCandidates.some((entry) => arg.endsWith(entry)))) {
    return true;
  }

  return exe.endsWith("/openclaw") || exe === "openclaw" || isGatewayBinary;
}
