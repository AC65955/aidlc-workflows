// covers: function:readUnitSourceManifest
// covers: function:sourceClaimCovers
// covers: function:readBaselineSourceSnapshot
// covers: function:readUnitSourceSnapshot
// covers: function:workspaceSourceListing
// covers: function:writeBaselineSourceSnapshot
// covers: function:writeUnitSourceSnapshot
//
// t305 - focused #662 substrate and guard-contract coverage. End-to-end receipt,
// recovery, shielding, baseline, swarm and multi-repo scenarios are exercised by
// t304's real CLI fixtures; this file pins the strict manifest/snapshot seams and
// the protocol surfaces that make those flows safe.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  freshReviewReceipts,
  readAllAuditShards,
  readBaselineSourceSnapshot,
  readUnitSourceManifest,
  readUnitSourceSnapshot,
  sourceClaimCovers,
  workspaceSourceListing,
  writeBaselineSourceSnapshot,
  writeUnitSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

import {
  AIDLC_SRC,
  FIXTURES_DIR,
} from "../harness/fixtures.ts";

const ROOT = join(import.meta.dir, "..", "..");
const PROTOCOL = join(ROOT, "core", "aidlc-common", "protocols");
const STAGE = join(ROOT, "core", "aidlc-common", "stages", "construction", "code-generation.md");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const REVIEWER = "aidlc-architecture-reviewer-agent";
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


function runtimeFixture(): { project: string; record: string } {
  const { project, record } = fixture();
  let state = readFileSync(join(FIXTURES_DIR, "state-mid-ideation.md"), "utf-8");
  state = state
    .replace("- **Current Stage**: feasibility", "- **Current Stage**: code-generation\n- **Construction Iteration**: stage-major")
    .replace("- [ ] code-generation — EXECUTE", "- [?] code-generation — EXECUTE");
  writeFileSync(join(record, "aidlc-state.md"), state, "utf-8");
  const dag = join(record, "inception", "units-generation");
  mkdirSync(dag, { recursive: true });
  writeFileSync(join(dag, "unit-of-work-dependency.md"), "```yaml\nunits:\n  - name: alpha\n    depends_on: []\n  - name: beta\n    depends_on: []\n```\n");
  const listing = workspaceSourceListing(project);
  if (listing === null) throw new Error("runtime fixture source listing missing");
  const baseline = writeBaselineSourceSnapshot(project, "code-generation", listing);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, project);
  appendAuditEntry("STAGE_STARTED", {
    Stage: "code-generation",
    Agent: "aidlc-developer-agent",
    "Source Baseline": baseline,
  }, project);
  // Audit timestamps are second-precision. The boundary is emitted in this
  // test process while product CLIs append from child processes/shards; wait
  // for the next second so the fixture does not manufacture causal ambiguity.
  const boundarySecond = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === boundarySecond) {}
  return { project, record };
}

function seedArtifacts(record: string, unit: string): string {
  const dir = join(record, "construction", unit, "code-generation");
  mkdirSync(dir, { recursive: true });
  for (const name of ["code-generation-plan.md", "unit-test-instructions.md", "code-summary.md", "traceability.json"])
    if (!existsSync(join(dir, name))) writeFileSync(join(dir, name), name.endsWith(".json") ? "{}\n" : `# ${name}\n`);
  return dir;
}

function writeManifest(record: string, unit: string, writes: Array<{ path: string; repo?: string }>): void {
  const dir = seedArtifacts(record, unit);
  writeFileSync(join(dir, "source-manifest.json"), `${JSON.stringify({ stage: "code-generation", unit, version: 1, writes }, null, 2)}\n`);
}

function cli(tool: string, args: string[], project: string, env: Record<string, string> = {}): { rc: number; out: string } {
  const merged = { ...process.env, AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1", AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_SKIP_REVISION_BACKSTOP: "1", ...env };
  const r = spawnSync(process.execPath, [tool, ...args, "--project-dir", project], { encoding: "utf-8", env: merged });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function review(project: string, record: string, unit: string, writes: Array<{ path: string; repo?: string }>, env: Record<string, string> = {}): { request: {rc:number;out:string}; verdict: {rc:number;out:string} } {
  writeManifest(record, unit, writes);
  const prior = (readAllAuditShards(project).match(new RegExp(`\\*\\*Event\\*\\*: REVIEW_REQUESTED[\\s\\S]*?\\*\\*Unit\\*\\*: ${unit}`, "g")) ?? []).length;
  const args = ["review", "--stage", "code-generation", "--reviewer", REVIEWER, "--unit", unit, "--iteration", String(prior + 1)];
  const request = cli(LOG, args, project, env);
  const verdict = request.rc === 0 ? cli(LOG, [...args, "--verdict", "READY"], project, env) : { rc: request.rc, out: request.out };
  return { request, verdict };
}

function approve(project: string, env: Record<string, string> = {}): { rc: number; out: string } {
  return cli(STATE, ["approve", "code-generation", "--user-input", "ship"], project, env);
}

function stripUnitBindings(project: string): void {
  const root = join(project, "aidlc", "spaces", "default", "intents");
  for (const rec of readdirSync(root)) {
    const audit = join(root, rec, "audit"); if (!existsSync(audit)) continue;
    for (const file of readdirSync(audit)) {
      const path = join(audit, file); let body = readFileSync(path, "utf-8");
      body = body.replace(/^\*\*(?:Unit Source Fingerprint|Unit Source Binding Bypass)\*\*: .*\r?\n/gm, "");
      writeFileSync(path, body);
    }
  }
}

describe("t305 real receipt and guard flows", () => {
  test("2 stamp refuses without manifest; bypass marker is check-time enforced", () => {
    const { project, record } = runtimeFixture(); seedArtifacts(record, "alpha");
    const args = ["review", "--stage", "code-generation", "--reviewer", REVIEWER, "--unit", "alpha", "--iteration", "1"];
    expect(cli(LOG, args, project).rc).toBe(0);
    const refused = cli(LOG, [...args, "--verdict", "READY"], project);
    expect(refused.rc).toBe(1); expect(refused.out).toContain("has no valid source manifest");
    expect(readAllAuditShards(project)).not.toContain("**Event**: REVIEW_COMPLETED");
    const bypass = cli(LOG, [...args, "--verdict", "READY"], project, { AIDLC_SKIP_SOURCE_FRESHNESS: "1" });
    expect(bypass.rc).toBe(0); expect(readAllAuditShards(project)).toContain("**Unit Source Binding Bypass**: true");
    review(project, record, "beta", [{ path: "app.ts" }], { AIDLC_SKIP_SOURCE_FRESHNESS: "1" });
    expect(approve(project).rc).toBe(1);
    expect(approve(project, { AIDLC_SKIP_SOURCE_FRESHNESS: "1" }).rc).toBe(0);
  }, 30000);

  test("3 disjoint unit invalidation names only beta and bounded recovery clears", () => {
    const { project, record } = runtimeFixture();
    writeFileSync(join(project, "alpha.ts"), "export const a=1\n"); writeFileSync(join(project, "beta.ts"), "export const b=1\n");
    review(project, record, "alpha", [{ path: "alpha.ts" }]); review(project, record, "beta", [{ path: "beta.ts" }]);
    writeFileSync(join(project, "beta.ts"), "export const b=2\n");
    // Refresh the global outer binding with alpha while beta remains stale.
    review(project, record, "alpha", [{ path: "alpha.ts" }]);
    const refused = approve(project); expect(refused.rc).toBe(1); expect(refused.out).toContain("Invalidated receipts: beta"); expect(refused.out).not.toContain("Invalidated receipts: alpha");
    const recovered = review(project, record, "beta", [{ path: "beta.ts" }]); expect(recovered.verdict.rc).toBe(0); expect(approve(project).rc).toBe(0);
  }, 30000);

  test("4 newest claimant shields overlap, but a stale newer claimant invalidates both", () => {
    const pass = runtimeFixture(); writeFileSync(join(pass.project, "shared.ts"), "export const s=1\n");
    review(pass.project, pass.record, "alpha", [{ path: "shared.ts" }]); writeFileSync(join(pass.project, "shared.ts"), "export const s=2\n"); review(pass.project, pass.record, "beta", [{ path: "shared.ts" }]); expect(approve(pass.project).rc).toBe(0);
    const fail = runtimeFixture(); writeFileSync(join(fail.project, "shared.ts"), "export const s=1\n");
    review(fail.project, fail.record, "alpha", [{ path: "shared.ts" }]); writeFileSync(join(fail.project, "shared.ts"), "export const s=2\n"); review(fail.project, fail.record, "beta", [{ path: "shared.ts" }]); writeFileSync(join(fail.project, "shared.ts"), "export const s=3\n");
    const r=approve(fail.project); expect(r.rc).toBe(1); expect(r.out).toContain("source-fingerprint mismatch");
    const state=readFileSync(join(fail.record,"aidlc-state.md"),"utf-8"); const receipts=freshReviewReceipts(fail.project,state,{slug:"code-generation",phase:"construction",for_each:"unit-of-work",reviewer:REVIEWER,reviewer_max_iterations:2,workspace_requires:true,produces:["code-generation-plan","unit-test-instructions","code-summary","traceability"]}); expect([...receipts.unitStale].sort()).toEqual(["alpha","beta"]);
  }, 30000);

  test("5 unclaimed add refuses; claim+recovery and revert both clear", () => {
    const claimed = runtimeFixture(); review(claimed.project, claimed.record, "alpha", [{ path: "app.ts" }]); review(claimed.project, claimed.record, "beta", []);
    writeFileSync(join(claimed.project, "extra.ts"), "export const x=1\n"); review(claimed.project, claimed.record, "beta", []);
    expect(approve(claimed.project).out).toContain("Unclaimed source changes fail closed");
    review(claimed.project, claimed.record, "alpha", [{ path: "app.ts" }, { path: "extra.ts" }]); expect(approve(claimed.project).rc).toBe(0);
    const reverted = runtimeFixture(); review(reverted.project, reverted.record, "alpha", [{ path: "app.ts" }]); review(reverted.project, reverted.record, "beta", []);
    writeFileSync(join(reverted.project, "extra.ts"), "export const x=1\n"); review(reverted.project, reverted.record, "beta", []); expect(approve(reverted.project).rc).toBe(1); rmSync(join(reverted.project, "extra.ts")); expect(approve(reverted.project).rc).toBe(0);
  }, 30000);

  test("6 unit-major ignores late STAGE_STARTED and destroyed baseline fails closed", () => {
    const late = runtimeFixture(); const state=join(late.record,"aidlc-state.md"); writeFileSync(state,readFileSync(state,"utf-8").replace("stage-major","unit-major"));
    writeFileSync(join(late.project,"late.ts"),"export const late=1\n");
    const now=workspaceSourceListing(late.project)!; appendAuditEntry("STAGE_STARTED",{Workflow:"single-stage:code-generation",Stage:"code-generation",Agent:"aidlc-developer-agent","Source Baseline":writeBaselineSourceSnapshot(late.project,"code-generation",now)},late.project);
    const syntheticSecond=Math.floor(Date.now()/1000); while(Math.floor(Date.now()/1000)===syntheticSecond){}
    review(late.project,late.record,"alpha",[{path:"app.ts"}]); review(late.project,late.record,"beta",[]); const lateState=readFileSync(state,"utf-8"); const lateReceipts=freshReviewReceipts(late.project,lateState,{slug:"code-generation",phase:"construction",for_each:"unit-of-work",reviewer:REVIEWER,reviewer_max_iterations:2,workspace_requires:true,produces:["code-generation-plan","unit-test-instructions","code-summary","traceability"]}); expect(lateReceipts.sourceBaseline.state).toBe("ready"); if (lateReceipts.sourceBaseline.state === "ready") expect(lateReceipts.sourceBaseline.listing.has("\0late.ts")).toBe(false); expect(approve(late.project).out).toContain("late.ts");
    const destroyed=runtimeFixture(); review(destroyed.project,destroyed.record,"alpha",[{path:"app.ts"}]); review(destroyed.project,destroyed.record,"beta",[]);
    const audit=readAllAuditShards(destroyed.project); const hash=/\*\*Source Baseline\*\*: sha256:([0-9a-f]{64})/.exec(audit)![1]; rmSync(join(destroyed.record,".aidlc-source-review","code-generation",`baseline-${hash.slice(0,12)}.tsv`)); expect(approve(destroyed.project).out).toContain("baseline snapshot is missing");
  }, 30000);

  test("7 manifest tamper and 8 claimed deletion make only the owning unit stale", () => {
    const tamper=runtimeFixture(); review(tamper.project,tamper.record,"alpha",[{path:"app.ts"}]); review(tamper.project,tamper.record,"beta",[]); writeManifest(tamper.record,"alpha",[]); expect(approve(tamper.project).out).toContain("Invalidated receipts: alpha");
    const deleted=runtimeFixture(); writeFileSync(join(deleted.project,"alpha.ts"),"a\n"); review(deleted.project,deleted.record,"alpha",[{path:"alpha.ts"}]); review(deleted.project,deleted.record,"beta",[]); rmSync(join(deleted.project,"alpha.ts")); review(deleted.project,deleted.record,"beta",[]); expect(approve(deleted.project).out).toContain("Invalidated receipts: alpha");
  }, 30000);

  test("9 fieldless per-unit bindings preserve legacy global policy and 11 zero-unit stays manifest-free", () => {
    const legacy=runtimeFixture(); review(legacy.project,legacy.record,"alpha",[{path:"app.ts"}]); review(legacy.project,legacy.record,"beta",[]); stripUnitBindings(legacy.project); expect(approve(legacy.project).rc).toBe(0);
    const zero=runtimeFixture(); rmSync(join(zero.record,"inception"),{recursive:true,force:true});
    const args=["review","--stage","code-generation","--reviewer",REVIEWER,"--iteration","1"]; expect(cli(LOG,args,zero.project).rc).toBe(0); expect(cli(LOG,[...args,"--verdict","READY"],zero.project).rc).toBe(0); expect(approve(zero.project).rc).toBe(0);
  }, 30000);

  test("12 two recorded repos invalidate only the owning repo and unit", () => {
    const base=runtimeFixture(); const project=base.project; const record=base.record; rmSync(join(project,".git"),{recursive:true,force:true}); for (const repo of ["repo-a","repo-b"]) { const path=join(project,repo); mkdirSync(path,{recursive:true}); git(path,["init","-q"]); git(path,["config","user.email","t@test"]); git(path,["config","user.name","t"]); writeFileSync(join(path,`${repo}.ts`),`export const ${repo.replace(/-/g,"_")}=1\n`); git(path,["add","-A"]); git(path,["commit","-qm","seed"]); } const registry=join(project,"aidlc","spaces","default","intents","intents.json"); const rows=JSON.parse(readFileSync(registry,"utf-8")); rows[0].repos=["repo-a","repo-b"]; writeFileSync(registry,`${JSON.stringify(rows)}\n`); const initial=workspaceSourceListing(project)!; appendAuditEntry("STAGE_JUMPED",{Target:"code-generation","Source Baseline":writeBaselineSourceSnapshot(project,"code-generation",initial)},project); const multiBoundary=Math.floor(Date.now()/1000); while(Math.floor(Date.now()/1000)===multiBoundary){}
    review(project,record,"alpha",[{repo:"repo-a",path:"repo-a.ts"}]); review(project,record,"beta",[{repo:"repo-b",path:"repo-b.ts"}]); writeFileSync(join(project,"repo-b","repo-b.ts"),"export const repo_b=2\n"); review(project,record,"alpha",[{repo:"repo-a",path:"repo-a.ts"}]); const r=approve(project); expect(r.out).toContain("Invalidated receipts: beta"); expect(r.out).not.toContain("Invalidated receipts: alpha");
  }, 30000);

  test("absent exact claim becomes stale when the path appears before an unrelated review", () => {
    const {project,record}=runtimeFixture(); review(project,record,"alpha",[{path:"future.ts"}]); writeFileSync(join(project,"future.ts"),"future\n"); review(project,record,"beta",[{path:"app.ts"}]); expect(approve(project).out).toContain("Invalidated receipts: alpha");
  }, 30000);

  test("ghost/non-applicable units cannot mint review authority or cover unclaimed source", () => {
    const {project,record}=runtimeFixture();
    review(project,record,"alpha",[{path:"app.ts"}]); review(project,record,"beta",[]);
    writeFileSync(join(project,"extra.ts"),"extra\n");
    writeManifest(record,"ghost",[{path:"extra.ts"}]);
    const ghost=cli(LOG,["review","--stage","code-generation","--reviewer",REVIEWER,"--unit","ghost","--iteration","1"],project);
    expect(ghost.rc).toBe(1); expect(ghost.out).toContain("not in the current resolved Unit DAG");
    const forgedState=readFileSync(join(record,"aidlc-state.md"),"utf-8");
    const receipts=freshReviewReceipts(project,forgedState,{slug:"code-generation",phase:"construction",for_each:"unit-of-work",reviewer:REVIEWER,reviewer_max_iterations:2,workspace_requires:true,produces:["code-generation-plan","unit-test-instructions","code-summary","traceability"]});
    expect(receipts.freshUnitClaims.has("ghost")).toBe(false);
  }, 30000);

  test("stage-major selects the tighter STAGE_STARTED baseline", () => {
    const {project,record}=runtimeFixture();
    // Replace the fixture's equal workflow/stage snapshots with a workflow
    // baseline, a pre-stage source addition, and a tighter stage baseline.
    const auditDir=join(record,"audit"); rmSync(auditDir,{recursive:true,force:true}); mkdirSync(auditDir,{recursive:true});
    const workflow=writeBaselineSourceSnapshot(project,"code-generation",workspaceSourceListing(project)!);
    appendAuditEntry("WORKFLOW_STARTED",{Scope:"feature","Source Baseline":workflow},project);
    writeFileSync(join(project,"prestage.ts"),"pre\n");
    const stageBaseline=writeBaselineSourceSnapshot(project,"code-generation",workspaceSourceListing(project)!);
    appendAuditEntry("STAGE_STARTED",{Stage:"code-generation",Agent:"aidlc-developer-agent","Source Baseline":stageBaseline},project);
    const second=Math.floor(Date.now()/1000); while(Math.floor(Date.now()/1000)===second){}
    writeFileSync(join(project,"later.ts"),"later\n"); review(project,record,"alpha",[{path:"app.ts"}]); review(project,record,"beta",[]);
    const out=approve(project).out; expect(out).toContain("later.ts"); expect(out).not.toContain("prestage.ts");
  }, 30000);

  test("calls freshReviewReceipts directly for a modern unit chain", () => {
    const {project,record}=runtimeFixture(); review(project,record,"alpha",[{path:"app.ts"}]); review(project,record,"beta",[]); const state=readFileSync(join(record,"aidlc-state.md"),"utf-8"); const receipts=freshReviewReceipts(project,state,{slug:"code-generation",phase:"construction",for_each:"unit-of-work",reviewer:REVIEWER,reviewer_max_iterations:2,workspace_requires:true,produces:["code-generation-plan","unit-test-instructions","code-summary","traceability"]}); expect(receipts.unitVerdicts.size).toBe(2);
  }, 30000);
});

describe("t305 stage and protocol source-attribution requirements", () => {
  test("pins schema, Bolt-relative paths, review freeze, and workspace_requires semantics", () => {
    const stage=readFileSync(STAGE,"utf-8"); const reviewer=readFileSync(join(PROTOCOL,"stage-protocol-reviewer.md"),"utf-8"); const construction=readFileSync(join(PROTOCOL,"stage-protocol-construction.md"),"utf-8"); const definition=readFileSync(join(PROTOCOL,"stage-definition.md"),"utf-8");
    expect(stage).toContain('"version": 1'); expect(stage).toContain("created, modified, or deleted"); expect(stage).toContain("trailing `/` directory claim"); expect(stage).toContain("MUST omit `repo`"); expect(stage).toContain("unclaimed changed paths\nblock stage completion"); expect(stage).toContain("engine-validated against its strict schema");
    expect(reviewer).toContain("differentially at those paths"); expect(reviewer).toContain("source-manifest.json"); expect(reviewer).toContain("claimed source paths");
    expect(construction).toContain("before the in-Bolt review"); expect(construction).toContain("worktree-relative and omit `repo`"); expect(definition).toContain("source-manifest.json"); expect(definition).toContain("stage-entry source baseline");
  });
});
