#!/usr/bin/env bun
// Executes a gate-approved AIDLC Bash command under one child-shell context.
// Prefixing only the first shell word does not scope later `&&` segments; this
// wrapper gives every child process the same validated intent environment.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const ENTRY_SURFACE = join(HOOKS_DIR, "..", "tools", "aidlc-entry-surface.ts");

function decode(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const value = Buffer.from(raw, "base64url").toString("utf-8");
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function run(command: string): number {
  const classified = Bun.spawnSync([process.execPath, ENTRY_SURFACE], {
    cwd: process.cwd(),
    stdin: new TextEncoder().encode(JSON.stringify({ command })),
    stdout: "pipe",
    stderr: "pipe",
  });
  let kind = "unknown-aidlc";
  try {
    kind = JSON.parse(new TextDecoder().decode(classified.stdout)).kind;
  } catch {
    // A malformed classifier result must never execute an unscoped command.
  }
  if (classified.exitCode !== 0 || kind === "unknown-aidlc" || kind === "non-aidlc") {
    process.stderr.write("AIDLC scoped command rejected: unsupported shell syntax or environment clearing command.\n");
    return 2;
  }
  const windows = process.platform === "win32";
  const shell = windows ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/sh";
  const shellArgs = windows ? ["/d", "/s", "/c", command] : ["-c", command];
  const result = spawnSync(shell, shellArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

if (import.meta.main) process.exit(run(decode(process.argv[2]) ?? ""));
