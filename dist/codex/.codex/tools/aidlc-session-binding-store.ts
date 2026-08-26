// Filesystem-only native session-binding storage. This deliberately has no
// dependency on aidlc-lib.ts so the shared resolver can validate bindings
// without introducing a circular dependency.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BINDINGS_DIR = ".aidlc-session-bindings";
const VERSION = 1;

export interface NativeSessionBinding {
  version: typeof VERSION;
  sessionId: string;
  intentUuid: string;
  space: string;
  intentDir: string;
  activatedAt: string;
}

export function safeNativeSessionId(sessionId: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(sessionId) ? sessionId : null;
}

function bindingsDir(projectDir: string): string {
  return join(projectDir, "aidlc", BINDINGS_DIR);
}

function bindingPath(projectDir: string, sessionId: string): string | null {
  const safe = safeNativeSessionId(sessionId);
  return safe ? join(bindingsDir(projectDir), `${safe}.json`) : null;
}

function isBinding(value: unknown): value is NativeSessionBinding {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === VERSION &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.intentUuid === "string" &&
    typeof candidate.space === "string" &&
    typeof candidate.intentDir === "string" &&
    typeof candidate.activatedAt === "string";
}

export function readNativeSessionBindingStore(projectDir: string, sessionId: string): NativeSessionBinding | null {
  const path = bindingPath(projectDir, sessionId);
  if (!path) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return isBinding(parsed) && parsed.sessionId === sessionId ? parsed : null;
  } catch {
    return null;
  }
}

export function writeNativeSessionBindingStore(projectDir: string, binding: NativeSessionBinding): boolean {
  const path = bindingPath(projectDir, binding.sessionId);
  if (!path || !isBinding(binding)) return false;
  mkdirSync(bindingsDir(projectDir), { recursive: true });
  writeFileSync(path, `${JSON.stringify(binding)}\n`, "utf-8");
  return true;
}

export function clearNativeSessionBindingStore(projectDir: string, sessionId: string): boolean {
  const path = bindingPath(projectDir, sessionId);
  if (!path) return false;
  rmSync(path, { force: true });
  return true;
}
