// t314-codex-native-session-gate: Codex starts Direct, and explicit intent
// selection binds subsequent hook work to that intent rather than the mutable
// workspace cursor.

import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CODEX_DIST = join(REPO_ROOT, "dist", "codex");
const ALPHA_UUID = "00000000-0000-7000-8000-000000000001";
const BETA_UUID = "00000000-0000-7000-8000-000000000002";
const ALPHA_DIR = "alpha-00000001";
const BETA_DIR = "beta-00000002";

function state(stage: string): string {
  return readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8")
    .replace(/(- \*\*Current Stage\*\*:\s*)[^\n]+/, `$1${stage}`);
}

function recordPath(project: string, record: string): string {
  return join(project, "aidlc", "spaces", "default", "intents", record, "aidlc-state.md");
}

function auditContent(project: string, record: string): string {
  const auditDir = join(project, "aidlc", "spaces", "default", "intents", record, "audit");
  if (!existsSync(auditDir)) return "";
  return readdirSync(auditDir)
    .sort()
    .map((entry) => readFileSync(join(auditDir, entry), "utf-8"))
    .join("\n");
}

function seedProject(): string {
  const project = mkdtempSync(join(tmpdir(), "t314-"));
  cpSync(join(CODEX_DIST, ".codex"), join(project, ".codex"), { recursive: true });
  cpSync(join(CODEX_DIST, "aidlc"), join(project, "aidlc"), { recursive: true });
  const intents = join(project, "aidlc", "spaces", "default", "intents");
  mkdirSync(join(intents, ALPHA_DIR), { recursive: true });
  mkdirSync(join(intents, BETA_DIR), { recursive: true });
  writeFileSync(join(project, "aidlc", "active-space"), "default\n", "utf-8");
  writeFileSync(join(intents, "active-intent"), `${BETA_DIR}\n`, "utf-8");
  writeFileSync(
    join(intents, "intents.json"),
    `${JSON.stringify([
      { uuid: ALPHA_UUID, slug: "alpha", status: "in-flight" },
      { uuid: BETA_UUID, slug: "beta", status: "in-flight" },
    ])}\n`,
    "utf-8",
  );
  writeFileSync(recordPath(project, ALPHA_DIR), state("alpha-stage"), "utf-8");
  writeFileSync(recordPath(project, BETA_DIR), state("beta-stage"), "utf-8");
  return project;
}

function runGate(project: string, target: string, payload: Record<string, unknown>): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, join(project, ".codex", "hooks", "aidlc-session-gate.ts"), target],
    cwd: project,
    stdin: new TextEncoder().encode(JSON.stringify({ ...payload, cwd: project })),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function createIntent(project: string): { code: number; stdout: string } {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      join(project, ".codex", "tools", "aidlc-utility.ts"),
      "intent-create",
      "--scope", "poc",
      "--arguments", "native gate creation",
      "--project-dir", project,
    ],
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout) };
}

function scopedBashCommand(project: string, sessionId: string, command: string): string {
  const result = runGate(project, "scope-bash-command", {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command },
  });
  expect(result.code).toBe(0);
  const output = JSON.parse(result.stdout) as {
    hookSpecificOutput?: {
      permissionDecision?: string;
      updatedInput?: { command?: string };
    };
  };
  expect(output.hookSpecificOutput?.permissionDecision).toBe("allow");
  const scoped = output.hookSpecificOutput?.updatedInput?.command;
  expect(typeof scoped).toBe("string");
  return scoped as string;
}

function runShell(project: string, command: string): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ["sh", "-c", command],
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function resolvedIntent(project: string, env: Record<string, string>): string {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      "import { activeIntent } from './.codex/tools/aidlc-lib.ts'; process.stdout.write(`${activeIntent(process.cwd()) ?? 'null'}\\n`);",
    ],
    cwd: project,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return new TextDecoder().decode(result.stdout).trim();
}

describe("t314 Codex native session gate", () => {
  test("a fresh session remains Direct despite a globally active intent", () => {
    const project = seedProject();
    try {
      const result = runGate(project, "session-start", {
        hook_event_name: "SessionStart",
        session_id: "fresh-direct",
        source: "startup",
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(existsSync(join(project, "aidlc", ".aidlc-session-bindings", "fresh-direct.json"))).toBe(false);
      expect(existsSync(join(project, "aidlc", ".aidlc-sessions", "codex-session.json"))).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("a Direct session denies workflow mutations without changing the shared intent", () => {
    const project = seedProject();
    try {
      const betaBefore = readFileSync(recordPath(project, BETA_DIR), "utf-8");
      const result = runGate(project, "scope-bash-command", {
        hook_event_name: "PreToolUse",
        session_id: "fresh-direct",
        tool_name: "Bash",
        tool_input: { command: "bun .codex/tools/aidlc-orchestrate.ts next" },
      });
      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain("$aidlc intent <name>");
      expect(readFileSync(recordPath(project, BETA_DIR), "utf-8")).toBe(betaBefore);
      expect(auditContent(project, BETA_DIR)).toBe("");

      const nested = runGate(project, "scope-bash-command", {
        hook_event_name: "PreToolUse",
        session_id: "fresh-direct",
        tool_name: "Bash",
        tool_input: { command: "sh -c 'bun .codex/tools/aidlc-orchestrate.ts next'" },
      });
      expect(JSON.parse(nested.stdout).hookSpecificOutput.permissionDecision).toBe("deny");

      for (const command of [
        "cd .codex/tools && bun aidlc-orchestrate.ts next",
        "sh -c 'sudo bun .codex/tools/aidlc-orchestrate.ts next'",
        "sh -c 'env -i bun .codex/tools/aidlc-orchestrate.ts next'",
      ]) {
        const denied = runGate(project, "scope-bash-command", {
          hook_event_name: "PreToolUse",
          session_id: "fresh-direct",
          tool_name: "Bash",
          tool_input: { command },
        });
        expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, command).toBe("deny");
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("a Direct session permits ordinary Bash and atomically binds an intent-create", () => {
    const project = seedProject();
    try {
      expect(runGate(project, "scope-bash-command", {
        hook_event_name: "PreToolUse",
        session_id: "fresh-create",
        tool_name: "Bash",
        tool_input: { command: "pwd" },
      }).stdout).toBe("");
      expect(runGate(project, "scope-bash-command", {
        hook_event_name: "PreToolUse",
        session_id: "fresh-create",
        tool_name: "Bash",
        tool_input: { command: "env -i pwd" },
      }).stdout).toBe("");

      const created = scopedBashCommand(
        project,
        "fresh-create",
        "bun .codex/tools/aidlc-utility.ts intent-create --scope poc --arguments 'atomic binding'",
      );
      const result = runShell(project, created);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Intent created:");
      expect(existsSync(join(project, "aidlc", ".aidlc-session-bindings", "fresh-create.json"))).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("a Direct shell intent switch becomes a session binding", () => {
    const project = seedProject();
    try {
      const selected = runShell(project, scopedBashCommand(
        project,
        "fresh-selection",
        "bun .codex/tools/aidlc-utility.ts intent switch alpha",
      ));
      expect(selected.code).toBe(0);
      const binding = JSON.parse(readFileSync(
        join(project, "aidlc", ".aidlc-session-bindings", "fresh-selection.json"),
        "utf-8",
      )) as { intentUuid: string; intentDir: string };
      expect(binding).toEqual(expect.objectContaining({ intentUuid: ALPHA_UUID, intentDir: ALPHA_DIR }));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("a bound intent-create receives structural birth context and replaces the old binding", () => {
    const project = seedProject();
    try {
      expect(runGate(project, "record-human-turn", {
        hook_event_name: "UserPromptSubmit",
        session_id: "bound-birth",
        prompt: "$aidlc intent alpha",
      }).code).toBe(0);
      const created = scopedBashCommand(
        project,
        "bound-birth",
        "bun .codex/tools/aidlc-utility.ts intent-create --scope poc --arguments 'bound birth'",
      );
      expect(created).toContain("AIDLC_CREATE_SESSION_ID=bound-birth");
      expect(created).not.toContain("AIDLC_HOOK_INTENT_DIR=");
      const result = runShell(project, created);
      expect(result.code).toBe(0);
      const binding = JSON.parse(readFileSync(
        join(project, "aidlc", ".aidlc-session-bindings", "bound-birth.json"),
        "utf-8",
      )) as { intentUuid: string; intentDir: string };
      expect(binding.intentUuid).not.toBe(ALPHA_UUID);
      expect(binding.intentDir).not.toBe(ALPHA_DIR);
      expect(result.stdout).toContain(binding.intentDir);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("Direct next --status is allowed unchanged while Bound status is scoped", () => {
    const project = seedProject();
    try {
      const status = "bun .codex/tools/aidlc-orchestrate.ts next --status";
      const direct = runGate(project, "scope-bash-command", {
        hook_event_name: "PreToolUse",
        session_id: "fresh-status",
        tool_name: "Bash",
        tool_input: { command: status },
      });
      expect(direct.code).toBe(0);
      expect(direct.stdout).toBe("");

      expect(runGate(project, "record-human-turn", {
        hook_event_name: "UserPromptSubmit",
        session_id: "bound-status",
        prompt: "$aidlc intent alpha",
      }).code).toBe(0);
      const scoped = scopedBashCommand(project, "bound-status", status);
      expect(scoped).toContain(`AIDLC_HOOK_INTENT_DIR=${ALPHA_DIR}`);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("a bound session permits registered testing and graph tools through the wrapper", () => {
    const project = seedProject();
    try {
      expect(runGate(project, "record-human-turn", {
        hook_event_name: "UserPromptSubmit",
        session_id: "bound-tools",
        prompt: "$aidlc intent alpha",
      }).code).toBe(0);
      for (const command of [
        "bun .codex/tools/aidlc-testing-posture.ts render",
        "bun .codex/tools/aidlc-graph.ts compile",
      ]) {
        const scoped = scopedBashCommand(project, "bound-tools", command);
        expect(scoped).toContain(`AIDLC_HOOK_INTENT_DIR=${ALPHA_DIR}`);
      }
      const unsupported = runGate(project, "scope-bash-command", {
        hook_event_name: "PreToolUse",
        session_id: "bound-tools",
        tool_name: "Bash",
        tool_input: { command: "bun .codex/tools/aidlc-unknown.ts run" },
      });
      const output = JSON.parse(unsupported.stdout) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(output.hookSpecificOutput?.permissionDecisionReason).toContain("cannot be safely recognized or scoped");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("explicit selection binds the session and keeps later hooks on its intent after cursor drift", () => {
    const project = seedProject();
    try {
      const selected = runGate(project, "record-human-turn", {
        hook_event_name: "UserPromptSubmit",
        session_id: "bound-alpha",
        prompt: "$aidlc intent alpha",
      });
      expect(selected.code).toBe(0);
      const binding = JSON.parse(readFileSync(
        join(project, "aidlc", ".aidlc-session-bindings", "bound-alpha.json"),
        "utf-8",
      )) as { intentUuid: string; intentDir: string };
      expect(binding).toEqual(expect.objectContaining({ intentUuid: ALPHA_UUID, intentDir: ALPHA_DIR }));

      // A matching hook context is scoped, but a forged UUID/dir pair must
      // not override the cursor merely because it is present in the process
      // environment.
      writeFileSync(
        join(project, "aidlc", "spaces", "default", "intents", "active-intent"),
        `${ALPHA_DIR}\n`,
        "utf-8",
      );
      expect(resolvedIntent(project, {
        AIDLC_HOOK_SESSION_ID: "bound-alpha",
        AIDLC_HOOK_INTENT_UUID: BETA_UUID,
        AIDLC_HOOK_INTENT_SPACE: "default",
        AIDLC_HOOK_INTENT_DIR: BETA_DIR,
      })).toBe(ALPHA_DIR);

      // The selection updates the shared cursor, then a different session moves
      // it to beta. The original session's hook context must still be alpha.
      writeFileSync(
        join(project, "aidlc", "spaces", "default", "intents", "active-intent"),
        `${BETA_DIR}\n`,
        "utf-8",
      );
      const resumed = runGate(project, "session-start", {
        hook_event_name: "SessionStart",
        session_id: "bound-alpha",
        source: "startup",
      });
      expect(resumed.code).toBe(0);
      expect(resumed.stdout).toContain("AIDLC WORKFLOW ACTIVE");
      expect(resumed.stdout).toContain("Current Stage: alpha-stage");
      expect(resumed.stdout).not.toContain("Current Stage: beta-stage");

      const alphaAudit = join(project, "aidlc", "spaces", "default", "intents", ALPHA_DIR, "audit");
      const betaAudit = join(project, "aidlc", "spaces", "default", "intents", BETA_DIR, "audit");
      expect(existsSync(alphaAudit)).toBe(true);
      expect(existsSync(betaAudit)).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("an explicit intent-create command binds its newly created intent through the hook chain", () => {
    const project = seedProject();
    try {
      const created = createIntent(project);
      expect(created.code).toBe(0);
      expect(created.stdout).toContain("Intent created:");
      const rebuilt = runGate(project, "rebuild-stage-graph", {
        hook_event_name: "PostToolUse",
        session_id: "created-here",
        tool_name: "Bash",
        tool_input: { command: "bun .codex/tools/aidlc-utility.ts intent-create --scope poc" },
        tool_response: created.stdout,
      });
      expect(rebuilt.code).toBe(0);
      const binding = JSON.parse(readFileSync(
        join(project, "aidlc", ".aidlc-session-bindings", "created-here.json"),
        "utf-8",
      )) as { intentDir: string };
      expect(created.stdout).toContain(binding.intentDir);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("a bound session's actual next/report subprocesses stay on its intent after cursor drift", () => {
    const project = seedProject();
    try {
      const construction = readFileSync(
        join(REPO_ROOT, "tests", "fixtures", "state-construction-bolt1.md"),
        "utf-8",
      );
      // `report --result skipped` is a real routed transition and audit write;
      // make the active conditional stage executable before we exercise it.
      const runnableConstruction = construction.replace(
        "- [ ] functional-design — EXECUTE",
        "- [-] functional-design — EXECUTE",
      );
      writeFileSync(recordPath(project, ALPHA_DIR), runnableConstruction, "utf-8");
      writeFileSync(recordPath(project, BETA_DIR), runnableConstruction, "utf-8");
      expect(runGate(project, "record-human-turn", {
        hook_event_name: "UserPromptSubmit",
        session_id: "bound-alpha-engine",
        prompt: "$aidlc intent alpha",
      }).code).toBe(0);
      writeFileSync(
        join(project, "aidlc", "spaces", "default", "intents", "active-intent"),
        BETA_DIR + "\n",
        "utf-8",
      );

      const nextCommand = scopedBashCommand(
        project,
        "bound-alpha-engine",
        "sh -c 'bun .codex/tools/aidlc-orchestrate.ts next'",
      );
      expect(nextCommand).toContain("AIDLC_HOOK_INTENT_DIR=" + ALPHA_DIR);
      const next = runShell(project, nextCommand);
      expect(next.code).toBe(0);
      expect(next.stdout).toContain('"stage":"functional-design"');
      const steering = JSON.parse(next.stdout) as { continue_token?: string };
      expect(typeof steering.continue_token).toBe("string");
      const continuedCommand = scopedBashCommand(
        project,
        "bound-alpha-engine",
        `bun .codex/tools/aidlc-orchestrate.ts continue '${steering.continue_token}'`,
      );
      const continued = runShell(project, continuedCommand);
      expect(continued.code).toBe(0);
      // The run-stage directive gives the agent concrete output paths. They
      // must be alpha paths despite beta now owning the shared cursor.
      expect(continued.stdout).toContain(ALPHA_DIR);
      expect(continued.stdout).not.toContain(BETA_DIR);

      const alphaAuditBefore = auditContent(project, ALPHA_DIR);

      const reportCommand = scopedBashCommand(
        project,
        "bound-alpha-engine",
        "bun .codex/tools/aidlc-orchestrate.ts report --stage functional-design --result skipped --reason 'not applicable'",
      );
      const report = runShell(project, reportCommand);
      expect(report.code).toBe(0);
      expect(report.stdout).toContain('"kind":"done"');
      expect(readFileSync(recordPath(project, ALPHA_DIR), "utf-8")).toContain(
        "- [S] functional-design — EXECUTE",
      );
      expect(readFileSync(recordPath(project, BETA_DIR), "utf-8")).toContain(
        "- [-] functional-design — EXECUTE",
      );
      const alphaAuditAfter = auditContent(project, ALPHA_DIR);
      expect(alphaAuditAfter).not.toBe(alphaAuditBefore);
      expect(alphaAuditAfter).toContain("**Event**: STAGE_SKIPPED");
      expect(auditContent(project, BETA_DIR)).toBe("");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("a bound session scopes jump and returns Direct after a space operation", () => {
    const project = seedProject();
    try {
      const construction = readFileSync(
        join(REPO_ROOT, "tests", "fixtures", "state-construction-bolt1.md"),
        "utf-8",
      ).replace("- [ ] functional-design — EXECUTE", "- [-] functional-design — EXECUTE");
      writeFileSync(recordPath(project, ALPHA_DIR), construction, "utf-8");
      writeFileSync(recordPath(project, BETA_DIR), construction, "utf-8");
      expect(runGate(project, "record-human-turn", {
        hook_event_name: "UserPromptSubmit",
        session_id: "bound-jump",
        prompt: "$aidlc intent alpha",
      }).code).toBe(0);
      writeFileSync(join(project, "aidlc", "spaces", "default", "intents", "active-intent"), `${BETA_DIR}\n`, "utf-8");

      const alphaAuditBefore = auditContent(project, ALPHA_DIR);
      const jumped = runShell(project, scopedBashCommand(
        project,
        "bound-jump",
        "bun .codex/tools/aidlc-jump.ts execute --target functional-design --direction redo --scope feature",
      ));
      expect(jumped.code).toBe(0);
      expect(auditContent(project, ALPHA_DIR)).not.toBe(alphaAuditBefore);
      expect(auditContent(project, ALPHA_DIR)).toContain("**Event**: STAGE_JUMPED");
      expect(auditContent(project, BETA_DIR)).toBe("");

      const switched = runShell(project, scopedBashCommand(
        project,
        "bound-jump",
        "bun .codex/tools/aidlc-utility.ts space default",
      ));
      expect(switched.code).toBe(0);
      expect(existsSync(join(project, "aidlc", ".aidlc-session-bindings", "bound-jump.json"))).toBe(false);
      const denied = runGate(project, "scope-bash-command", {
        hook_event_name: "PreToolUse",
        session_id: "bound-jump",
        tool_name: "Bash",
        tool_input: { command: "bun .codex/tools/aidlc-orchestrate.ts next" },
      });
      expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
