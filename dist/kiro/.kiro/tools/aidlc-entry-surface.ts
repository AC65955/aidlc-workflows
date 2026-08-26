// Canonical, harness-neutral classification for the AIDLC command surface.
// Codex consumes this through its native gate; keeping the recognition rules in
// one module prevents a prompt recognizer and a Bash rewrite list from drifting.

export type EntryKind =
  | "bind"
  | "create"
  | "readonly"
  | "workspace"
  | "routing"
  | "mutation"
  | "unknown-aidlc"
  | "non-aidlc";

export interface EntryClassification {
  kind: EntryKind;
  /** Present only for an explicit existing-intent selection. */
  intentName?: string;
}

const SKILL_PREFIX = /^(?:\$aidlc|\/aidlc)\b\s*/i;

interface ToolRule {
  default: EntryKind;
  verbs?: Record<string, EntryKind>;
}

// Every packaged core tool has an explicit default. Most helpers are not
// normally invoked by a user, but registering them still makes an accidental
// invocation fail safely (and lets the coverage test detect newly packaged
// tools). User-facing tools refine this default by subcommand below.
const MUTATION_DEFAULTS = [
  "audit", "bolt", "directive", "entry-surface", "includes", "jump", "log",
  "orchestrate", "runner-gen", "rule-schema", "sensor-claim-sources",
  "sensor-linter", "sensor-required-sections", "sensor-schema",
  "sensor-traceability", "sensor-type-check", "sensor-upstream-coverage",
  "session-binding", "session-binding-store", "stage-schema", "state",
  "steering", "swarm", "tiers", "usage", "utility", "validity", "worktree",
] as const;

const READONLY_DEFAULTS = [
  "artifact-resolution", "artifact-vocabulary", "doctor-bundle", "documentkb-schema", "lib",
  "metrics", "runtime-paths", "testing-posture", "validate", "version",
  "workspace-doctor", "workspace-manifest",
] as const;

export const AIDLC_TOOL_RULES: Readonly<Record<string, ToolRule>> = {
  ...Object.fromEntries(MUTATION_DEFAULTS.map((name) => [name, { default: "mutation" as const }])),
  ...Object.fromEntries(READONLY_DEFAULTS.map((name) => [name, { default: "readonly" as const }])),
  graph: {
    default: "workspace",
    verbs: { ars: "readonly", export: "readonly", "validate-grid": "readonly" },
  },
  knowledge: { default: "mutation", verbs: { help: "readonly", list: "readonly", show: "readonly" } },
  learnings: { default: "mutation", verbs: { surface: "readonly" } },
  runtime: {
    default: "mutation",
    verbs: { read: "readonly", summary: "readonly" },
  },
  sensor: { default: "mutation", verbs: { describe: "readonly", list: "readonly" } },
  "workspace-sync": { default: "workspace" },
};

export const REGISTERED_AIDLC_TOOL_NAMES = Object.freeze(Object.keys(AIDLC_TOOL_RULES).sort());

interface ShellLexResult {
  commands: string[][];
  malformed: boolean;
}

// A deliberately small shell lexer: enough to distinguish command words from
// quoted data, split compound commands, and recurse into `sh -c`. It is not a
// shell evaluator; unknown syntax that mentions AIDLC fails closed.
function lexShell(command: string): ShellLexResult {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let malformed = false;

  const flushWord = (): void => {
    if (word.length > 0) {
      words.push(word);
      word = "";
    }
  };
  const flushCommand = (): void => {
    flushWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      flushWord();
      continue;
    }
    if (char === ";" || char === "|" || char === "\n" || (char === "&" && command[index + 1] === "&")) {
      flushCommand();
      if (char === "&") index++;
      continue;
    }
    word += char;
  }
  if (escaped || quote) malformed = true;
  flushCommand();
  return { commands, malformed };
}

function firstToken(input: string): string | null {
  const match = input.trim().match(/^([^\s]+)/);
  return match?.[1]?.toLowerCase() ?? null;
}

function classifyUtility(args: readonly string[]): EntryKind {
  const first = args[0]?.toLowerCase() ?? null;
  if (!first) return "unknown-aidlc";
  if (first === "intent-create" || (first === "intent" && args[1]?.toLowerCase() === "create")) return "create";
  if (first === "intent") {
    const target = args[1]?.toLowerCase();
    if (!target || target === "list" || target === "help" || target === "-h") return "readonly";
    if (target === "--json") return "readonly";
    if (target === "switch") {
      return args[2] ? "bind" : "mutation";
    }
    return "bind";
  }
  if (first === "space" || first === "space-create" || first === "plugin" || first === "select-plugins") return "workspace";
  if (["status", "help", "version", "codekb-path", "codekb-scope-diff"].includes(first)) return "readonly";
  if (first === "config") {
    const verb = args[1]?.toLowerCase();
    return verb === "get" || verb === "list" ? "readonly" : "mutation";
  }
  // Doctor may append a health-check audit record, including --export.
  if (first === "doctor") return "mutation";
  return "mutation";
}

function classifyTool(tool: string, args: readonly string[]): EntryKind {
  const normalized = tool.replace(/^aidlc-/, "").replace(/\.ts$/, "");
  if (["--help", "-h", "--version"].includes(args[0]?.toLowerCase() ?? "")) return "readonly";
  if (normalized === "utility") return classifyUtility(args);
  const rule = AIDLC_TOOL_RULES[normalized];
  if (!rule) return "unknown-aidlc";
  const verb = args[0]?.toLowerCase();
  if (normalized === "orchestrate" && verb === "next") {
    const hasMutationFlag = args.some((arg) => ["--scope", "--depth", "--test-strategy", "--review", "--stage", "--phase"].includes(arg));
    if (!hasMutationFlag && args.some((arg) => ["--status", "--help", "--version"].includes(arg))) return "readonly";
  }
  return rule.verbs?.[verb ?? ""] ?? rule.default;
}

export function classifyPromptEntry(prompt: string): EntryClassification {
  const trimmed = prompt.trim();
  const match = trimmed.match(SKILL_PREFIX);
  if (!match) return { kind: "non-aidlc" };
  const tail = trimmed.slice(match[0].length).trim();
  if (!tail || /^--resume\b/i.test(tail) || /^(?:compose|--new-scope)\b/i.test(tail)) return { kind: "routing" };
  const first = firstToken(tail);
  const rest = tail.replace(/^\S+\s*/, "");
  if (first === "intent") {
    const target = firstToken(rest);
    if (!target || target === "list" || target === "help" || target === "-h") return { kind: "readonly" };
    if (target === "create") return { kind: "create" };
    if (target === "switch") {
      const switched = firstToken(rest.replace(/^\S+\s*/, ""));
      return switched ? { kind: "bind", intentName: switched } : { kind: "mutation" };
    }
    return { kind: "bind", intentName: target };
  }
  if (first === "space" || first === "space-create" || first === "plugin") return { kind: "workspace" };
  if (first === "knowledge") return ["list", "show", "help"].includes(firstToken(rest) ?? "")
    ? { kind: "readonly" }
    : { kind: "mutation" };
  if (first === "config") return ["get", "list"].includes(firstToken(rest) ?? "")
    ? { kind: "readonly" }
    : { kind: "mutation" };
  if (["--status", "--help", "--version"].includes(first ?? "")) return { kind: "readonly" };
  if (first === "--doctor") return { kind: "mutation" };
  if (["--stage", "--phase", "--scope", "--depth", "--test-strategy", "--review"].includes(first ?? "")) return { kind: "mutation" };
  return { kind: "routing" };
}

function commandBasename(value: string): string {
  const parts = value.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? value;
}

function isAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function looksLikeAidlcReference(value: string): boolean {
  if (/\s/.test(value)) return false; // quoted data, e.g. echo 'bun aidlc-…'
  const base = commandBasename(value);
  return base === "aidlc" ||
    base === "aidlc.ts" ||
    /^aidlc-[A-Za-z0-9-]+\.ts$/.test(base) ||
    /(?:^|\/)\.codex\/tools\/aidlc-[A-Za-z0-9-]+\.ts$/.test(value);
}

function safeSourceReader(executable: string, args: readonly string[]): boolean {
  if (!["cat", "grep", "head", "rg", "sed", "tail"].includes(executable)) return false;
  if (executable === "sed" && args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="))) return false;
  // Do not exempt a command that redirects its read into another file. The
  // lexer keeps redirections as words, which is sufficient for this narrow
  // source-inspection allowlist.
  if (args.some((arg) => /^>>?/.test(arg))) return false;
  return args.some(looksLikeAidlcReference);
}

function toolInvocationAt(words: readonly string[], start: number): { tool: string; args: readonly string[] } | null {
  for (let index = start; index < words.length; index++) {
    const base = commandBasename(words[index]);
    if (base === "aidlc.ts" || /^aidlc(?:-|\.ts)/.test(base) && !/^aidlc-[A-Za-z0-9-]+\.ts$/.test(base)) return null;
    const tool = base.match(/^(aidlc-[A-Za-z0-9-]+)\.ts$/)?.[1];
    if (tool) return { tool, args: words.slice(index + 1) };
  }
  return null;
}

function classifyShellCommand(words: readonly string[]): EntryKind {
  let index = 0;
  let unsafeContext = false;
  while (index < words.length && isAssignment(words[index])) index++;

  while (index < words.length) {
    const executable = commandBasename(words[index]).toLowerCase();
    if (["sh", "bash", "zsh", "dash", "ksh"].includes(executable)) {
      const commandIndex = words.findIndex((word, position) => position >= index && word === "-c");
      if (commandIndex < 0 || !words[commandIndex + 1]) return "non-aidlc";
      const nested = classifyBashInvocation(words[commandIndex + 1]).kind;
      return unsafeContext && nested !== "non-aidlc" ? "unknown-aidlc" : nested;
    }
    if (executable === "command") {
      index++;
      continue;
    }
    if (executable === "sudo") {
      unsafeContext = true;
      index++;
      while (index < words.length && words[index].startsWith("-")) index++;
      continue;
    }
    if (executable === "env") {
      index++;
      while (index < words.length) {
        const value = words[index];
        if (value === "-i" || value === "--ignore-environment") unsafeContext = true;
        if (value === "-u") {
          index += 2;
          continue;
        }
        if (value.startsWith("-") || isAssignment(value)) {
          index++;
          continue;
        }
        break;
      }
      continue;
    }
    if (executable === "aidlc" || executable.startsWith("aidlc-")) return "unknown-aidlc";
    if (executable !== "bun" && executable !== "bunx") {
      if (safeSourceReader(executable, words.slice(index + 1))) return "non-aidlc";
      return words.some(looksLikeAidlcReference) ? "unknown-aidlc" : "non-aidlc";
    }
    let targetIndex = index + 1;
    // Bun accepts launcher flags before a script, and `run`/`x`/`bunx` add an
    // extra launcher word. Rather than guessing every Bun flag arity, search
    // the remaining command words for an AIDLC script; a non-script reference
    // below still fails closed.
    while (targetIndex < words.length && words[targetIndex].startsWith("-")) targetIndex++;
    if (["run", "x", "bunx"].includes(words[targetIndex]?.toLowerCase() ?? "")) {
      targetIndex++;
      while (targetIndex < words.length && words[targetIndex].startsWith("-")) targetIndex++;
    }
    const invocation = toolInvocationAt(words, targetIndex);
    if (!invocation) return words.slice(targetIndex).some(looksLikeAidlcReference) ? "unknown-aidlc" : "non-aidlc";
    const kind = classifyTool(invocation.tool, invocation.args);
    return unsafeContext ? "unknown-aidlc" : kind;
  }
  return "non-aidlc";
}

export function classifyBashInvocation(command: string): EntryClassification {
  const lexed = lexShell(command);
  if (lexed.malformed) return /\baidlc(?:[-\w]*|\.ts)?\b/i.test(command)
    ? { kind: "unknown-aidlc" }
    : { kind: "non-aidlc" };
  let found = false;
  let result: EntryKind = "readonly";
  const merge = (kind: EntryKind): EntryClassification | null => {
    if (kind === "unknown-aidlc") return { kind };
    if (kind === "non-aidlc") return null;
    found = true;
    if (kind === "mutation" || kind === "routing" || kind === "create" || kind === "bind") result = kind;
    else if (kind === "workspace" && result === "readonly") result = kind;
    return null;
  };
  for (const words of lexed.commands) {
    const classified = classifyShellCommand(words);
    const denied = merge(classified);
    if (denied) return denied;
  }
  if (found) return { kind: result };
  return { kind: "non-aidlc" };
}

export function isDirectAllowed(kind: EntryKind): boolean {
  return kind === "bind" || kind === "create" || kind === "readonly" || kind === "workspace" || kind === "non-aidlc";
}

if (import.meta.main) {
  let input: { prompt?: unknown; command?: unknown } = {};
  try {
    input = JSON.parse(await Bun.stdin.text()) as { prompt?: unknown; command?: unknown };
  } catch {
    process.stdout.write(`${JSON.stringify({ kind: "unknown-aidlc" satisfies EntryKind })}\n`);
    process.exit(0);
  }
  const result = typeof input.prompt === "string"
    ? classifyPromptEntry(input.prompt)
    : typeof input.command === "string"
      ? classifyBashInvocation(input.command)
      : { kind: "non-aidlc" as const };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
