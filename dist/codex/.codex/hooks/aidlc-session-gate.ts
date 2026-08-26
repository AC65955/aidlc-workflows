#!/usr/bin/env bun
// Codex-native authorization boundary for AIDLC hooks. A project may retain
// durable workflow state while a fresh conversation stays Direct: only an
// explicit `$aidlc intent <name>` selection (or explicit intent creation)
// activates the hooks for that session.

import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(HOOKS_DIR, "aidlc-codex-adapter.ts");
const BINDING = join(HOOKS_DIR, "..", "tools", "aidlc-session-binding.ts");
const ENTRY_SURFACE = join(HOOKS_DIR, "..", "tools", "aidlc-entry-surface.ts");
const SESSION_COMMAND = join(HOOKS_DIR, "aidlc-session-command.ts");

interface CodexHookInput {
  session_id?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  user_prompt?: unknown;
  message?: unknown;
  tool_input?: { command?: unknown };
}

interface GateDecision {
  action?: unknown;
  reason?: unknown;
  recovery?: unknown;
  context?: {
    sessionId?: unknown;
    intentUuid?: unknown;
    space?: unknown;
    intentDir?: unknown;
  };
}

interface EntryClassification {
  kind?: unknown;
}

interface HookIntentContext {
  sessionId: string;
  intentUuid: string;
  space: string;
  intentDir: string;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function projectDir(input: CodexHookInput): string {
  const raw = stringField(input.cwd) ?? process.cwd();
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

function prompt(input: CodexHookInput): string | undefined {
  return stringField(input.prompt) ?? stringField(input.user_prompt) ?? stringField(input.message) ?? undefined;
}

function runAdapter(target: string, input: string, cwd: string, env: Record<string, string | undefined>): number {
  const result = Bun.spawnSync([process.execPath, ADAPTER, target], {
    cwd,
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
}

function classify(cwd: string, input: { prompt?: string; command?: string }): string {
  const result = Bun.spawnSync([process.execPath, ENTRY_SURFACE], {
    cwd,
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return "unknown-aidlc";
  try {
    const parsed = JSON.parse(new TextDecoder().decode(result.stdout)) as EntryClassification;
    return stringField(parsed.kind) ?? "unknown-aidlc";
  } catch {
    return "unknown-aidlc";
  }
}

function resolveDecision(cwd: string, sessionId: string, command?: string): GateDecision {
  const result = Bun.spawnSync([process.execPath, BINDING], {
    cwd,
    stdin: new TextEncoder().encode(JSON.stringify({ projectDir: cwd, sessionId, command })),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return {};
  try {
    return JSON.parse(new TextDecoder().decode(result.stdout)) as GateDecision;
  } catch {
    return {};
  }
}

function resolvedContext(decision: GateDecision): HookIntentContext | null {
  const context = decision.context;
  if (!context) return null;
  const sessionId = stringField(context.sessionId);
  const space = stringField(context.space);
  const intentDir = stringField(context.intentDir);
  const intentUuid = stringField(context.intentUuid);
  return sessionId &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(sessionId) &&
    space &&
    /^[a-z][a-z0-9-]*$/.test(space) &&
    intentDir &&
    /^[A-Za-z0-9._-]+$/.test(intentDir) &&
    intentUuid &&
    /^[A-Za-z0-9._-]+$/.test(intentUuid)
    ? { sessionId, space, intentDir, intentUuid }
    : null;
}

function scopedEnvironment(context: HookIntentContext): Record<string, string> {
  return {
    AIDLC_HOOK_SESSION_ID: context.sessionId,
    AIDLC_HOOK_INTENT_UUID: context.intentUuid,
    AIDLC_HOOK_INTENT_SPACE: context.space,
    AIDLC_HOOK_INTENT_DIR: context.intentDir,
  };
}

function wrappedBashCommand(command: string, env: Record<string, string>): string {
  const encoded = Buffer.from(command, "utf-8").toString("base64url");
  const prefix = Object.entries(env).map(([key, value]) => `${key}=${value}`).join(" ");
  return `${prefix} bun .codex/hooks/aidlc-session-command.ts ${encoded}`;
}

function isDirectAllowed(kind: string): boolean {
  return ["bind", "create", "readonly", "workspace", "non-aidlc"].includes(kind);
}

function deny(reason: string): void {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })}\n`);
}

export async function run(target: string, raw: string): Promise<number> {
  if (!target) return 0;
  let input: CodexHookInput;
  try {
    input = JSON.parse(raw) as CodexHookInput;
  } catch {
    return 0;
  }
  const cwd = projectDir(input);
  const sessionId = stringField(input.session_id);
  const command = stringField(input.tool_input?.command);

  // Compatibility fallback for older/direct creation invocations that did not
  // receive AIDLC_CREATE_SESSION_ID. The primary path binds inside
  // aidlc-utility after the record and state are durable.
  if (target === "rebuild-stage-graph" && command && classify(cwd, { command }) === "create") {
    return runAdapter(target, raw, cwd, process.env);
  }
  if (!sessionId) return 0;

  const promptText = target === "record-human-turn" ? prompt(input) : undefined;
  const decision = resolveDecision(cwd, sessionId, promptText);
  const context = resolvedContext(decision);
  if (target === "scope-bash-command") {
    if (!command) return 0;
    const kind = classify(cwd, { command });
    if (kind === "non-aidlc") return 0;
    if (decision.action === "direct") {
      if (!isDirectAllowed(kind)) {
        deny("AIDLC workflow command blocked: this Codex session is Direct. Run $aidlc intent <name> first, or create a new intent.");
        return 0;
      }
      if (kind !== "create" && kind !== "bind") return 0;
      const created = wrappedBashCommand(command, kind === "create"
        ? { AIDLC_CREATE_SESSION_ID: sessionId }
        : { AIDLC_SELECT_SESSION_ID: sessionId });
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { ...input.tool_input, command: created },
        },
      })}\n`);
      return 0;
    }
    if (kind === "unknown-aidlc") {
      deny("AIDLC command blocked: this command form cannot be safely recognized or scoped. Use a supported AIDLC command form.");
      return 0;
    }
    if (decision.action !== "bound" || !context) {
      deny("AIDLC command could not be authorized for this session. Select a runnable intent before continuing.");
      return 0;
    }
    // A birth must not inherit the old intent context: creation writes a new
    // record and then atomically replaces this session's binding. Its explicit
    // creation id is the authority, while all other bound operations receive
    // the validated old intent context.
    const scoped = wrappedBashCommand(command, kind === "create"
      ? { AIDLC_CREATE_SESSION_ID: sessionId }
      : scopedEnvironment(context));
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        // Codex accepts a rewritten tool input only with an explicit allow
        // decision; otherwise it reports the hook output as malformed and
        // continues with the original command.
        permissionDecision: "allow",
        updatedInput: { ...input.tool_input, command: scoped },
      },
    })}\n`);
    return 0;
  }
  if (decision.action !== "bound" || !context) return 0;
  return runAdapter(target, raw, cwd, {
    ...process.env,
    ...scopedEnvironment(context),
  });
}

if (import.meta.main) {
  process.exit(await run(process.argv[2] ?? "", await Bun.stdin.text()));
}
