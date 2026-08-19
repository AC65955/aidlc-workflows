// t300-plugin-doctor-checks: plugin-authored /aidlc --doctor checks (#796).
//
// The fixture copies a complete Claude install, adds one installed plugin
// identity through a scope file, and swaps only that plugin's optional doctor
// script. This keeps exit-code assertions focused on the plugin runner instead
// of unrelated missing-install failures.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AIDLC_MEMORY_SRC,
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
} from "../harness/fixtures.ts";

const PLUGIN = "doctor-probe";
const created: string[] = [];

afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
});

function freshProject(): string {
  const project = createTestProject();
  created.push(project);
  cpSync(AIDLC_SRC, join(project, ".claude"), { recursive: true });
  cpSync(AIDLC_MEMORY_SRC, join(project, "aidlc"), { recursive: true });
  writeFileSync(
    join(project, ".claude", "scopes", `${PLUGIN}-scope.md`),
    [
      "---",
      `name: ${PLUGIN}-scope`,
      `plugin: ${PLUGIN}`,
      "depth: Standard",
      "description: Doctor probe plugin scope",
      "keywords:",
      "  - doctor-probe-scope",
      "---",
      "",
    ].join("\n"),
  );
  return project;
}

function scriptPath(project: string): string {
  return join(project, ".claude", "tools", `${PLUGIN}-doctor.ts`);
}

function writeDoctorScript(project: string, body: string): void {
  writeFileSync(scriptPath(project), body, "utf-8");
}

function runDoctor(
  project: string,
  args: string[] = [],
  envOverrides: Record<string, string> = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: project,
    AIDLC_HARNESS_DIR: ".claude",
    ...envOverrides,
  };
  if (!("AIDLC_PLUGIN_DOCTOR_TIMEOUT_MS" in envOverrides)) {
    delete env.AIDLC_PLUGIN_DOCTOR_TIMEOUT_MS;
  }
  return spawnSync(
    process.execPath,
    [join(project, ".claude", "tools", "aidlc-utility.ts"), "doctor", ...args, "--project-dir", project],
    {
      cwd: project,
      encoding: "utf-8",
      env,
      timeout: 30_000,
    },
  );
}

function output(run: ReturnType<typeof runDoctor>): string {
  return `${run.stdout ?? ""}${run.stderr ?? ""}`;
}

function setPluginSelection(project: string, plugins: string[]): void {
  const path = join(project, ".claude", "tools", "data", "harness.json");
  const harness = JSON.parse(readFileSync(path, "utf-8"));
  harness.plugins = plugins;
  writeFileSync(path, `${JSON.stringify(harness, null, 2)}\n`, "utf-8");
}

function reportJson(project: string): Record<string, unknown> {
  const outDir = join(project, "out");
  const reportDir = readdirSync(outDir)
    .find((name) => name.startsWith("aidlc-diagnostic-report-") && !name.endsWith(".tar.gz"));
  expect(reportDir).toBeTruthy();
  return JSON.parse(readFileSync(join(outDir, reportDir!, "report.json"), "utf-8"));
}

describe("t300 plugin doctor checks", () => {
  test("enabled plugin passing check renders a pass row and exits 0", () => {
    const project = freshProject();
    writeDoctorScript(
      project,
      'process.stdout.write(JSON.stringify({checks:[{pass:true,label:"tool is ready"}]}));\n',
    );

    const run = runDoctor(project);
    expect(run.status, output(run)).toBe(0);
    expect(output(run)).toContain(`✓  Plugin check (${PLUGIN}): tool is ready`);
  });

  test("failing error-severity check renders a failure and exits 1", () => {
    const project = freshProject();
    writeDoctorScript(
      project,
      'process.stdout.write(JSON.stringify({checks:[{pass:false,label:"tool is missing",fix:"install the tool",severity:"error"}]}));\n',
    );

    const run = runDoctor(project);
    expect(run.status).toBe(1);
    expect(output(run)).toContain(`✗  Plugin check (${PLUGIN}): tool is missing — install the tool`);
  });

  test("failing advisory check stays visible and exits 0", () => {
    const project = freshProject();
    writeDoctorScript(
      project,
      'process.stdout.write(JSON.stringify({checks:[{pass:false,label:"optional tool is missing",fix:"install it when needed",severity:"advisory"}]}));\n',
    );

    const run = runDoctor(project);
    expect(run.status, output(run)).toBe(0);
    expect(output(run)).toContain(
      `✓  Plugin check (${PLUGIN}): optional tool is missing (advisory): install it when needed`,
    );
  });

  test("malformed JSON becomes one loud finding with the required shape", () => {
    const project = freshProject();
    writeDoctorScript(project, 'process.stdout.write("not-json");\n');

    const run = runDoctor(project);
    const out = output(run);
    expect(run.status).toBe(1);
    expect(out.match(new RegExp(`✗  Plugin check \\(${PLUGIN}\\):`, "g"))?.length).toBe(1);
    expect(out).toContain(scriptPath(project));
    expect(out).toContain("required JSON shape");
  });

  test("timeout becomes a loud finding", () => {
    const project = freshProject();
    writeDoctorScript(project, "await Bun.sleep(5_000);\n");

    const run = runDoctor(project, [], { AIDLC_PLUGIN_DOCTOR_TIMEOUT_MS: "50" });
    expect(run.status).toBe(1);
    expect(output(run)).toContain(
      `✗  Plugin check (${PLUGIN}): check script timed out after 50ms`,
    );
  });

  test("disabled plugin script is inert", () => {
    const project = freshProject();
    const canary = join(project, "plugin-doctor-ran");
    writeDoctorScript(
      project,
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.env.PLUGIN_DOCTOR_CANARY!, "ran");',
        'process.stdout.write(JSON.stringify({checks:[{pass:true,label:"ran"}]}));',
        "",
      ].join("\n"),
    );
    setPluginSelection(project, ["aidlc"]);

    const run = runDoctor(project, [], { PLUGIN_DOCTOR_CANARY: canary });
    expect(run.status, output(run)).toBe(0);
    expect(existsSync(canary)).toBe(false);
    expect(output(run)).not.toContain(`Plugin check (${PLUGIN}):`);
  });

  test("plugin without a doctor script emits no plugin rows", () => {
    const project = freshProject();

    const run = runDoctor(project);
    expect(run.status, output(run)).toBe(0);
    expect(output(run)).not.toContain(`Plugin check (${PLUGIN}):`);
  });

  test("--export includes a plugin check finding in report.json", () => {
    const project = freshProject();
    writeDoctorScript(
      project,
      'process.stdout.write(JSON.stringify({checks:[{pass:false,label:"exported plugin failure",fix:"repair plugin"}]}));\n',
    );

    const run = runDoctor(project, ["--export", "--output", join(project, "out")]);
    expect(run.status).toBe(1);
    const report = reportJson(project) as {
      findings?: Array<{ summary?: string; severity?: string }>;
    };
    expect(report.findings?.some(
      (finding) =>
        finding.summary === `Plugin check (${PLUGIN}): exported plugin failure` &&
        finding.severity === "error",
    )).toBe(true);
  });

  test("malformed entries are skipped and summarized once", () => {
    const project = freshProject();
    writeDoctorScript(
      project,
      'process.stdout.write(JSON.stringify({checks:[{pass:true,label:"valid"},{pass:"yes",label:"bad"},null]}));\n',
    );

    const run = runDoctor(project);
    const out = output(run);
    expect(run.status).toBe(1);
    expect(out).toContain(`✓  Plugin check (${PLUGIN}): valid`);
    expect(out).toContain(`✗  Plugin check (${PLUGIN}): 2 malformed check entries skipped`);
  });

  test("check rows are capped and truncation fails loud", () => {
    const project = freshProject();
    writeDoctorScript(
      project,
      'process.stdout.write(JSON.stringify({checks:Array.from({length:52},(_,i)=>({pass:true,label:["row",i].join(" ")}))}));\n',
    );

    const run = runDoctor(project);
    const out = output(run);
    expect(run.status).toBe(1);
    expect(out).toContain(`✓  Plugin check (${PLUGIN}): row 49`);
    expect(out).not.toContain(`✓  Plugin check (${PLUGIN}): row 50`);
    expect(out).toContain(`✗  Plugin check (${PLUGIN}): 2 check result(s) truncated after 50 rows`);
  });
});
