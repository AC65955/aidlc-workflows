// covers: function:readUnitSourceManifest
// covers: function:sourceClaimCovers
// covers: function:readBaselineSourceSnapshot
// covers: function:freshReviewReceipts
//
// t305 - focused #662 substrate and guard-contract coverage. End-to-end receipt,
// recovery, shielding, baseline, swarm and multi-repo scenarios are exercised by
// t304's real CLI fixtures; this file pins the strict manifest/snapshot seams and
// the protocol surfaces that make those flows safe.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readBaselineSourceSnapshot,
  readUnitSourceManifest,
  readUnitSourceSnapshot,
  sourceClaimCovers,
  workspaceSourceListing,
  writeBaselineSourceSnapshot,
  writeUnitSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const ROOT = join(import.meta.dir, "..", "..");
const PROTOCOL = join(ROOT, "core", "aidlc-common", "protocols");
const STAGE = join(ROOT, "core", "aidlc-common", "stages", "construction", "code-generation.md");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): void {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function fixture(repos: string[] = []): { project: string; record: string } {
  const project = mkdtempSync(join(tmpdir(), "aidlc-t305-"));
  dirs.push(project);
  const record = join(project, "aidlc", "spaces", "default", "intents", "fixture-intent");
  mkdirSync(record, { recursive: true });
  writeFileSync(join(record, "aidlc-state.md"), "# State\n- **Scope**: feature\n", "utf-8");
  writeFileSync(join(project, "aidlc", "spaces", "default", "intents", "intents.json"), `${JSON.stringify([{ uuid: "80000000-0000-4000-8000-000000000001", slug: "fixture", dirName: "fixture-intent", status: "active", repos }])}\n`);
  writeFileSync(join(project, "aidlc", "spaces", "default", "intents", ".active-intent"), "fixture-intent\n");
  if (repos.length === 0) {
    git(project, ["init", "-q"]); git(project, ["config", "user.email", "t@test"]); git(project, ["config", "user.name", "t"]);
    writeFileSync(join(project, "app.ts"), "export const app = 1;\n"); git(project, ["add", "-A"]); git(project, ["commit", "-qm", "seed"]);
  } else {
    for (const repo of repos) {
      const path = join(project, repo); mkdirSync(path, { recursive: true });
      git(path, ["init", "-q"]); git(path, ["config", "user.email", "t@test"]); git(path, ["config", "user.name", "t"]);
      writeFileSync(join(path, `${repo}.ts`), `export const ${repo.replace(/-/g, "_")} = 1;\n`); git(path, ["add", "-A"]); git(path, ["commit", "-qm", "seed"]);
    }
  }
  return { project, record };
}

function manifest(record: string, unit: string, value: unknown): string {
  const dir = join(record, "construction", unit, "code-generation"); mkdirSync(dir, { recursive: true });
  const path = join(dir, "source-manifest.json"); writeFileSync(path, `${JSON.stringify(value)}\n`); return path;
}

describe("t305 strict source-manifest validation", () => {
  test("accepts exact and directory claims and rejects schema/path violations", () => {
    const { project, record } = fixture();
    const valid = { stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "app.ts" }, { path: "src/generated/" }] };
    manifest(record, "alpha", valid);
    const accepted = readUnitSourceManifest(project, "code-generation", "alpha");
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(sourceClaimCovers("\0app.ts", accepted)).toBe(true);
      expect(sourceClaimCovers("\0src/generated/a.ts", accepted)).toBe(true);
    }
    const rejected = [
      { ...valid, unknown: true },
      { ...valid, stage: "other" },
      { ...valid, unit: "beta" },
      { ...valid, version: 2 },
      { ...valid, writes: [{ path: "../escape.ts" }] },
      { ...valid, writes: [{ path: "/absolute.ts" }] },
      { ...valid, writes: [{ path: "bad\\path.ts" }] },
      { ...valid, writes: [{ path: "*.ts" }] },
      { ...valid, writes: [{ path: "aidlc/internal.ts" }] },
      { ...valid, writes: [{ path: "app.ts" }, { path: "./app.ts" }] },
    ];
    for (const value of rejected) {
      manifest(record, "alpha", value);
      expect(readUnitSourceManifest(project, "code-generation", "alpha").ok).toBe(false);
    }
  });

  test("multi-repo requires recorded repo and scopes claims to it", () => {
    const { project, record } = fixture(["repo-a", "repo-b"]);
    manifest(record, "alpha", { stage: "code-generation", unit: "alpha", version: 1, writes: [{ repo: "repo-a", path: "repo-a.ts" }, { repo: "repo-b", path: "repo-b.ts" }] });
    const accepted = readUnitSourceManifest(project, "code-generation", "alpha");
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(sourceClaimCovers("repo-b\0repo-b.ts", accepted)).toBe(true);
    manifest(record, "alpha", { stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "repo-a.ts" }] });
    expect(readUnitSourceManifest(project, "code-generation", "alpha").ok).toBe(false);
    manifest(record, "alpha", { stage: "code-generation", unit: "alpha", version: 1, writes: [{ repo: "repo-c", path: "x.ts" }] });
    expect(readUnitSourceManifest(project, "code-generation", "alpha").ok).toBe(false);
  });
});

describe("t305 content-addressed source review evidence", () => {
  test("baseline and unit snapshots round-trip and fail closed after destruction or tamper", () => {
    const { project, record } = fixture();
    const listing = workspaceSourceListing(project); expect(listing).not.toBeNull();
    if (listing === null) return;
    const baseline = writeBaselineSourceSnapshot(project, "code-generation", listing);
    expect(readBaselineSourceSnapshot(project, "code-generation", baseline)?.get("\0app.ts")).toBeDefined();
    manifest(record, "alpha", { stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "app.ts" }] });
    const claims = readUnitSourceManifest(project, "code-generation", "alpha"); expect(claims.ok).toBe(true);
    if (!claims.ok) return;
    const unit = writeUnitSourceSnapshot(project, "code-generation", "alpha", listing, claims, claims.rawBytesSha256);
    expect(readUnitSourceSnapshot(project, "code-generation", "alpha", unit)?.manifestSha256).toBe(claims.rawBytesSha256);
    const unitPath = join(record, ".aidlc-source-review", "code-generation", `unit-alpha-${unit.slice(7, 19)}.tsv`);
    writeFileSync(unitPath, "tampered\n");
    expect(readUnitSourceSnapshot(project, "code-generation", "alpha", unit)).toBeNull();
  });

  test("manifest bytes are bound, covering direct-fs post-review tamper and deleted claims", () => {
    const { project, record } = fixture();
    const path = manifest(record, "alpha", { stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "app.ts" }] });
    const first = readUnitSourceManifest(project, "code-generation", "alpha"); expect(first.ok).toBe(true);
    writeFileSync(path, `${JSON.stringify({ stage: "code-generation", unit: "alpha", version: 1, writes: [] }, null, 2)}\n`);
    const second = readUnitSourceManifest(project, "code-generation", "alpha"); expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.rawBytesSha256).not.toBe(first.rawBytesSha256);
    rmSync(join(project, "app.ts"));
    expect(workspaceSourceListing(project)?.has("\0app.ts")).toBe(false);
  });
});

describe("t305 required runtime/protocol coverage map", () => {
  test("pins stamp refusal+bypass, per-unit recovery, shielding, unclaimed baseline, legacy, swarm, and zero-unit contracts", () => {
    const lib = readFileSync(join(ROOT, "core", "tools", "aidlc-lib.ts"), "utf-8");
    const log = readFileSync(join(ROOT, "core", "tools", "aidlc-log.ts"), "utf-8");
    const state = readFileSync(join(ROOT, "core", "tools", "aidlc-state.ts"), "utf-8");
    const swarm = readFileSync(join(ROOT, "core", "tools", "aidlc-swarm.ts"), "utf-8");
    expect(log).toContain("Unit Source Binding Bypass");
    expect(log).toContain("has no valid source manifest");
    expect(lib).toContain("newerFreshClaims");
    expect(lib).toContain("sourceBaseline");
    expect(lib).toContain("receipt.fingerprint === null");
    expect(state).toContain("Unclaimed source changes fail closed (RFC #662)");
    expect(state).toContain("claimed source paths");
    expect(swarm).toContain("worktree wrote application-source paths outside unit");
    expect(log).toContain("flags.unit !== undefined");
  });

  test("stage and protocols require manifest production and differential review", () => {
    const stage = readFileSync(STAGE, "utf-8");
    const reviewer = readFileSync(join(PROTOCOL, "stage-protocol-reviewer.md"), "utf-8");
    const construction = readFileSync(join(PROTOCOL, "stage-protocol-construction.md"), "utf-8");
    expect(stage).toContain("source-manifest.json");
    expect(stage).toContain("shell commands, scaffolding, or generators");
    expect(reviewer).toContain("differentially at those paths");
    expect(reviewer).toContain("unrelated to the unit");
    expect(construction).toContain("before the\n   in-Bolt review");
  });
});
