// t300-codex-router-wrapper: the outer Codex wrapper binds the router state
// to the target project, then re-reads the same binding before invoking native hooks.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditFilePath, stateFilePath } from "../../core/tools/aidlc-lib.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CODEX_TREE = join(REPO_ROOT, "dist", "codex", ".codex");
const scratch: string[] = [];

function project(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "aidlc-router-wrapper-project-"));
  scratch.push(root);
  cpSync(CODEX_TREE, join(root, ".codex"), { recursive: true });

  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  const record = "router-wrapper-123e4567";
  const intents = join(root, "aidlc", "spaces", "default", "intents");
  mkdirSync(join(root, "aidlc", "spaces", "default", "memory"), { recursive: true });
  mkdirSync(join(intents, record), { recursive: true });
  writeFileSync(join(root, "aidlc", "active-space"), "default\n");
  writeFileSync(join(intents, "active-intent"), `${record}\n`);
  writeFileSync(join(intents, "intents.json"), JSON.stringify([
    { uuid, slug: "router-wrapper", dirName: record, status: "in-flight" },
  ]));
  writeFileSync(
    stateFilePath(root, record, "default"),
    "# AI-DLC State Tracking\n\n- **Status**: In Progress\n",
  );
  return { root };
}

function router(): string {
  const root = mkdtempSync(join(tmpdir(), "aidlc-router-wrapper-router-"));
  scratch.push(root);
  mkdirSync(join(root, "adapters", "codex"), { recursive: true });
  mkdirSync(join(root, "adapters", "aidlc-v2"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { route: "bun route.ts" } }));
  writeFileSync(
    join(root, "route.ts"),
    `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const repoIndex = process.argv.indexOf("--repo");
const repo = repoIndex >= 0 ? process.argv[repoIndex + 1] : process.cwd();
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, ".router-binding"), "bound\\n");
process.stdout.write("{}\\n");
`,
  );
  writeFileSync(
    join(root, "adapters", "codex", "route-hook.ts"),
    `import { existsSync } from "node:fs";
import { join } from "node:path";
const event = await Bun.stdin.json().catch(() => ({}));
const bound = existsSync(join(process.cwd(), ".router-binding"));
process.stdout.write(JSON.stringify({ actions: bound
  ? [{ kind: "enable-hook-chain", hookChain: "aidlc-v2" }]
  : [{ kind: "request-provider-binding", purpose: "activate" }] }) + "\\n");
`,
  );
  writeFileSync(
    join(root, "adapters", "aidlc-v2", "route-gate.ts"),
    `import { existsSync } from "node:fs";
import { join } from "node:path";
process.stdout.write(JSON.stringify({ allow: existsSync(join(process.cwd(), ".router-binding")) }) + "\\n");
`,
  );
  return root;
}

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("t300 Codex router wrapper", () => {
  test("binds activate to the project before enabling the native hook chain", () => {
    const fixture = project();
    const routerRoot = router();
    const event = {
      hook_event_name: "UserPromptSubmit",
      session_id: "router-wrapper-session",
      cwd: fixture.root,
      prompt: "$aidlc intent router-wrapper",
    };
    const result = spawnSync(
      "bun",
      [join(fixture.root, ".codex", "hooks", "aidlc-router-wrapper.ts"), "record-human-turn"],
      {
        cwd: fixture.root,
        input: JSON.stringify(event),
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_HARNESS_ROUTE_ROOT: routerRoot,
          AIDLC_PROJECT_DIR: undefined,
          CLAUDE_PROJECT_DIR: undefined,
        } as NodeJS.ProcessEnv,
      },
    );

    expect(result.status).toBe(0);
    expect(existsSync(join(fixture.root, ".router-binding"))).toBe(true);
    expect(existsSync(join(routerRoot, ".router-binding"))).toBe(false);
    expect(readFileSync(auditFilePath(fixture.root), "utf-8")).toContain("HUMAN_TURN");
  });
});
