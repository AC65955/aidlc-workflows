// t315: the Codex native gate must recognize every packaged tool and the
// AIDLC tools actually named by stage protocols. New tools cannot silently
// become an unknown-command denial or an unscoped Direct-session bypass.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_TOOL_RULES,
  classifyBashInvocation,
  REGISTERED_AIDLC_TOOL_NAMES,
} from "../../core/tools/aidlc-entry-surface.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

function toolNames(dir: string): string[] {
  return readdirSync(dir)
    .map((name) => name.match(/^aidlc-([A-Za-z0-9-]+)\.ts$/)?.[1])
    .filter((name): name is string => Boolean(name))
    .sort();
}

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(path));
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

describe("t315 Codex entry surface", () => {
  test("recognizes bare, nested, and dangerous shell AIDLC invocations", () => {
    const cases: Array<[string, string]> = [
      ["bun .codex/tools/aidlc-testing-posture.ts render", "readonly"],
      ["bun .codex/tools/aidlc-testing-posture.ts fingerprint --unit api", "readonly"],
      ["bun .codex/tools/aidlc-graph.ts compile", "workspace"],
      ["bun .codex/tools/aidlc-workspace-sync.ts --force", "workspace"],
      ["cd .codex/tools && bun aidlc-orchestrate.ts next", "mutation"],
      ["bun --bun .codex/tools/aidlc-orchestrate.ts next", "mutation"],
      ["bun run .codex/tools/aidlc-orchestrate.ts next", "mutation"],
      ["sh -c 'bun .codex/tools/aidlc-orchestrate.ts next'", "mutation"],
      ["sh -c 'sudo bun .codex/tools/aidlc-orchestrate.ts next'", "unknown-aidlc"],
      ["env -i bun .codex/tools/aidlc-orchestrate.ts next", "unknown-aidlc"],
      ["bun aidlc.ts next", "unknown-aidlc"],
      ["if true; then bun .codex/tools/aidlc-orchestrate.ts next; fi", "unknown-aidlc"],
      ["echo 'bun .codex/tools/aidlc-orchestrate.ts next'", "non-aidlc"],
      ["cat .codex/tools/aidlc-state.ts", "non-aidlc"],
      ["sed -n '1p' .codex/tools/aidlc-state.ts", "non-aidlc"],
      ["sed -i '' 's/a/b/' .codex/tools/aidlc-state.ts", "unknown-aidlc"],
      ["bun .codex/tools/aidlc-utility.ts intent alpha --arguments 'one && two'", "bind"],
      ["bun .codex/tools/aidlc-utility.ts intent --json", "readonly"],
      ["bun .codex/tools/aidlc-orchestrate.ts next --status", "readonly"],
      ["bun .codex/tools/aidlc-orchestrate.ts --help", "readonly"],
    ];
    for (const [command, expected] of cases) {
      expect(classifyBashInvocation(command).kind, command).toBe(expected);
    }
  });

  test("covers every packaged core tool and every tool named by a stage", () => {
    const sourceTools = toolNames(join(REPO_ROOT, "core", "tools"));
    const codexTools = toolNames(join(REPO_ROOT, "dist", "codex", ".codex", "tools"));
    expect(REGISTERED_AIDLC_TOOL_NAMES).toEqual(sourceTools);
    expect(codexTools).toEqual(sourceTools);
    expect(Object.keys(AIDLC_TOOL_RULES).sort()).toEqual(sourceTools);

    const namedByStage = new Set<string>();
    for (const path of markdownFiles(join(REPO_ROOT, "core", "aidlc-common", "stages"))) {
      const source = readFileSync(path, "utf-8");
      for (const match of source.matchAll(/aidlc-([A-Za-z0-9-]+)\.ts\b/g)) {
        namedByStage.add(match[1]);
      }
    }
    for (const tool of namedByStage) {
      expect(AIDLC_TOOL_RULES[tool], `stage tool ${tool}`).toBeDefined();
      expect(classifyBashInvocation(`bun .codex/tools/aidlc-${tool}.ts --help`).kind).not.toBe("unknown-aidlc");
    }
  });
});
