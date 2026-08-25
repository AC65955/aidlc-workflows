#!/usr/bin/env bun
// Native session binding is deliberately separate from `.aidlc-sessions/`.
// That older directory records passive lifecycle observations; a binding in
// this file is an explicit user choice that authorizes AIDLC hook execution.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  activeSpace,
  findIntentByUuid,
  getField,
  listIntents,
  setActiveIntentCursor,
  stateFilePath,
  writeSessionIntentUuid,
} from "./aidlc-lib.ts";

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

export interface HookIntentContext {
  sessionId: string;
  intentUuid: string;
  space: string;
  intentDir: string;
}

export interface SessionGateDecision {
  allow: boolean;
  reason: string;
  context?: HookIntentContext;
}

function safeSessionId(sessionId: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(sessionId)
    ? sessionId
    : null;
}

function bindingsDir(projectDir: string): string {
  return join(projectDir, "aidlc", BINDINGS_DIR);
}

function bindingPath(projectDir: string, sessionId: string): string | null {
  const safe = safeSessionId(sessionId);
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

export function readNativeSessionBinding(
  projectDir: string,
  sessionId: string,
): NativeSessionBinding | null {
  const path = bindingPath(projectDir, sessionId);
  if (!path) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return isBinding(parsed) && parsed.sessionId === sessionId ? parsed : null;
  } catch {
    return null;
  }
}

export function writeNativeSessionBinding(
  projectDir: string,
  sessionId: string,
  intentUuid: string,
): NativeSessionBinding | null {
  const path = bindingPath(projectDir, sessionId);
  const resolved = findIntentByUuid(projectDir, intentUuid);
  if (!path || !resolved) return null;
  const binding: NativeSessionBinding = {
    version: VERSION,
    sessionId,
    intentUuid,
    space: resolved.space,
    intentDir: resolved.dirName,
    activatedAt: new Date().toISOString(),
  };
  mkdirSync(bindingsDir(projectDir), { recursive: true });
  writeFileSync(path, `${JSON.stringify(binding)}\n`, "utf-8");
  // Keep the pre-existing lifecycle view useful for non-Codex consumers, but
  // never read it as authorization for this native gate.
  writeSessionIntentUuid(projectDir, sessionId, intentUuid);
  return binding;
}

function contextForBinding(
  projectDir: string,
  binding: NativeSessionBinding,
): HookIntentContext | null {
  const resolved = findIntentByUuid(projectDir, binding.intentUuid);
  if (!resolved || resolved.space !== binding.space || resolved.dirName !== binding.intentDir) {
    return null;
  }
  if (!existsSync(stateFilePath(projectDir, resolved.dirName, resolved.space))) {
    return null;
  }
  return {
    sessionId: binding.sessionId,
    intentUuid: binding.intentUuid,
    space: resolved.space,
    intentDir: resolved.dirName,
  };
}

function runnable(projectDir: string, context: HookIntentContext): boolean {
  let state = "";
  try {
    state = readFileSync(stateFilePath(projectDir, context.intentDir, context.space), "utf-8");
  } catch {
    return false;
  }
  const status = (getField(state, "Status") ?? "").toLowerCase();
  const parked = (getField(state, "Parked") ?? "").toLowerCase();
  return !["complete", "completed", "cancelled", "canceled"].includes(status) &&
    !["true", "yes", "1"].includes(parked);
}

function explicitIntentName(command: string): string | null {
  const match = command.trim().match(/^(?:\$aidlc|\/aidlc)\s+intent\s+([^\s]+)/i);
  if (!match) return null;
  const name = match[1].trim();
  return ["create", "list", "switch"].includes(name.toLowerCase()) ? null : name;
}

function resolveExplicitIntent(projectDir: string, command: string): string | null {
  const name = explicitIntentName(command);
  if (!name) return null;
  const matches = listIntents(projectDir, activeSpace(projectDir)).filter(
    (intent) => intent.dirName === name || intent.slug === name,
  );
  return matches.length === 1 ? matches[0].uuid : null;
}

export function resolveNativeSessionGate(
  projectDir: string,
  sessionId: string,
  command?: string,
): SessionGateDecision {
  if (!safeSessionId(sessionId)) return { allow: false, reason: "missing-or-invalid-session" };

  const explicitUuid = command ? resolveExplicitIntent(projectDir, command) : null;
  if (explicitUuid) {
    const binding = writeNativeSessionBinding(projectDir, sessionId, explicitUuid);
    const context = binding && contextForBinding(projectDir, binding);
    if (!context) return { allow: false, reason: "selected-intent-unavailable" };
    // Preserve the normal CLI's shared cursor for explicit intent commands;
    // hook subprocesses use the binding context, so another session moving it
    // cannot redirect this session's state or audit writes.
    setActiveIntentCursor(projectDir, context.intentDir, context.space);
    return runnable(projectDir, context)
      ? { allow: true, reason: "explicit-intent", context }
      : { allow: false, reason: "selected-intent-not-runnable", context };
  }

  const binding = readNativeSessionBinding(projectDir, sessionId);
  if (!binding) return { allow: false, reason: "direct-session" };
  const context = contextForBinding(projectDir, binding);
  if (!context) return { allow: false, reason: "stale-binding" };
  return runnable(projectDir, context)
    ? { allow: true, reason: "active-binding", context }
    : { allow: false, reason: "bound-intent-not-runnable", context };
}

interface BindingCliInput {
  projectDir?: unknown;
  sessionId?: unknown;
  command?: unknown;
}

async function main(): Promise<void> {
  let input: BindingCliInput = {};
  try {
    input = JSON.parse(await Bun.stdin.text()) as BindingCliInput;
  } catch {
    process.stdout.write(`${JSON.stringify({ allow: false, reason: "invalid-input" })}\n`);
    return;
  }
  const projectDir = typeof input.projectDir === "string" ? resolve(input.projectDir) : process.cwd();
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  const command = typeof input.command === "string" ? input.command : undefined;
  process.stdout.write(`${JSON.stringify(resolveNativeSessionGate(projectDir, sessionId, command))}\n`);
}

if (import.meta.main) await main();
