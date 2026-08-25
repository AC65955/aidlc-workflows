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

interface CodexHookInput {
  session_id?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  user_prompt?: unknown;
  message?: unknown;
  tool_input?: { command?: unknown };
}

interface GateDecision {
  allow?: unknown;
  context?: {
    sessionId?: unknown;
    intentUuid?: unknown;
    space?: unknown;
    intentDir?: unknown;
  };
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

function intentCreate(command: string | undefined): boolean {
  return Boolean(command && /\b(?:aidlc-utility\.ts\s+intent-create|aidlc\s+intent(?:\s+create|-create))\b/i.test(command));
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

const SCOPED_AIDLC_TOOL =
  /(^|(?:&&|\|\||;|\n)\s*)(bun\s+(?:\.\/)?\.codex\/tools\/aidlc-(?:orchestrate|state|utility|runtime|audit|log|learnings)\.ts\b)/g;

function scopeBashCommand(command: string, context: HookIntentContext): string {
  const prefix = Object.entries(scopedEnvironment(context))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return command.replace(SCOPED_AIDLC_TOOL, `$1${prefix} $2`);
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

  // Creation is the only Direct-mode hook path: it is an explicit workflow
  // request, and rebuild-stage-graph binds the resulting intent atomically to
  // this host session. Every other unbound event remains a cheap no-op.
  if (target === "rebuild-stage-graph" && intentCreate(command)) {
    return runAdapter(target, raw, cwd, process.env);
  }
  if (!sessionId) return 0;

  const decision = resolveDecision(cwd, sessionId, target === "record-human-turn" ? prompt(input) : undefined);
  const context = resolvedContext(decision);
  if (decision.allow !== true || !context) return 0;
  if (target === "scope-bash-command") {
    if (!command) return 0;
    const scoped = scopeBashCommand(command, context);
    if (scoped === command) return 0;
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
  return runAdapter(target, raw, cwd, {
    ...process.env,
    ...scopedEnvironment(context),
  });
}

if (import.meta.main) {
  process.exit(await run(process.argv[2] ?? "", await Bun.stdin.text()));
}
