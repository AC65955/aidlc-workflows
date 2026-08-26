#!/usr/bin/env bun
// Native session binding is deliberately separate from `.aidlc-sessions/`.
// That older directory records passive lifecycle observations; a binding in
// this file is an explicit user choice that authorizes AIDLC hook execution.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  activeSpace,
  findIntentByUuid,
  getField,
  listIntents,
  setActiveIntentCursor,
  stateFilePath,
  writeSessionIntentUuid,
} from "./aidlc-lib.ts";
import { classifyPromptEntry } from "./aidlc-entry-surface.ts";
import {
  clearNativeSessionBindingStore,
  readNativeSessionBindingStore,
  safeNativeSessionId,
  type NativeSessionBinding,
  writeNativeSessionBindingStore,
} from "./aidlc-session-binding-store.ts";

export type { NativeSessionBinding } from "./aidlc-session-binding-store.ts";

export interface HookIntentContext {
  sessionId: string;
  intentUuid: string;
  space: string;
  intentDir: string;
}

export interface SessionGateDecision {
  action: "direct" | "bound" | "deny";
  reason: string;
  recovery?: string;
  context?: HookIntentContext;
}

export function readNativeSessionBinding(
  projectDir: string,
  sessionId: string,
): NativeSessionBinding | null {
  return readNativeSessionBindingStore(projectDir, sessionId);
}

export function writeNativeSessionBinding(
  projectDir: string,
  sessionId: string,
  intentUuid: string,
): NativeSessionBinding | null {
  const resolved = findIntentByUuid(projectDir, intentUuid);
  if (!safeNativeSessionId(sessionId) || !resolved) return null;
  const binding: NativeSessionBinding = {
    version: 1,
    sessionId,
    intentUuid,
    space: resolved.space,
    intentDir: resolved.dirName,
    activatedAt: new Date().toISOString(),
  };
  if (!writeNativeSessionBindingStore(projectDir, binding)) return null;
  // Keep the pre-existing lifecycle view useful for non-Codex consumers, but
  // never read it as authorization for this native gate.
  writeSessionIntentUuid(projectDir, sessionId, intentUuid);
  return binding;
}

export function clearNativeSessionBinding(projectDir: string, sessionId: string): boolean {
  return clearNativeSessionBindingStore(projectDir, sessionId);
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

function resolveExplicitIntent(projectDir: string, command: string): string | null {
  const classified = classifyPromptEntry(command);
  if (classified.kind !== "bind" || !classified.intentName) return null;
  const name = classified.intentName;
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
  if (!safeNativeSessionId(sessionId)) return { action: "direct", reason: "missing-or-invalid-session" };

  const explicitUuid = command ? resolveExplicitIntent(projectDir, command) : null;
  if (explicitUuid) {
    const binding = writeNativeSessionBinding(projectDir, sessionId, explicitUuid);
    const context = binding && contextForBinding(projectDir, binding);
    if (!context) return { action: "deny", reason: "selected-intent-unavailable", recovery: "Select a runnable intent." };
    // Preserve the normal CLI's shared cursor for explicit intent commands;
    // hook subprocesses use the binding context, so another session moving it
    // cannot redirect this session's state or audit writes.
    setActiveIntentCursor(projectDir, context.intentDir, context.space);
    return runnable(projectDir, context)
      ? { action: "bound", reason: "explicit-intent", context }
      : { action: "deny", reason: "selected-intent-not-runnable", recovery: "Select a runnable intent.", context };
  }

  const binding = readNativeSessionBinding(projectDir, sessionId);
  if (!binding) return { action: "direct", reason: "direct-session" };
  const context = contextForBinding(projectDir, binding);
  if (!context) return { action: "direct", reason: "stale-binding" };
  return runnable(projectDir, context)
    ? { action: "bound", reason: "active-binding", context }
    : { action: "deny", reason: "bound-intent-not-runnable", recovery: "Select another runnable intent.", context };
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
    process.stdout.write(`${JSON.stringify({ action: "direct", reason: "invalid-input" })}\n`);
    return;
  }
  const projectDir = typeof input.projectDir === "string" ? resolve(input.projectDir) : process.cwd();
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  const command = typeof input.command === "string" ? input.command : undefined;
  process.stdout.write(`${JSON.stringify(resolveNativeSessionGate(projectDir, sessionId, command))}\n`);
}

if (import.meta.main) await main();
