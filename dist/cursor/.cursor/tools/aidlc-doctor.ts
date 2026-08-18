#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  errorMessage,
  harnessDir,
  isoTimestamp,
  parseArgs,
  resolveProjectDir,
} from "./aidlc-lib.ts";
import {
  adaptLegacyResult,
  buildBundle,
  mergeFindings,
  runDoctorAnalysis,
  type DoctorAnalysis,
} from "./aidlc-doctor-bundle.ts";
import {
  collectDoctorReport,
  type DoctorCheck,
  type DoctorReport,
} from "./aidlc-utility.ts";
import {
  cachedUpdateState,
  refreshUpdateState,
  type UpdateState,
} from "./aidlc-update.ts";
import { collectPluginStatus } from "./aidlc-plugin.ts";
import { scanWindowsUninstallJournals } from "./aidlc-windows-uninstall.ts";
import { discoverProjectHarnesses } from "./aidlc-runtime-paths.ts";
import {
  isModelHarness,
  modelPolicyDoctorIssues,
} from "./aidlc-model-policy.ts";
import {
  flagsDoctorCheck,
  providerDoctorCheck,
  settingsDoctorChecks,
  workspaceSiblingDoctorCheck,
} from "./aidlc-config-diagnostics.ts";
import {
  modelPolicyForHarness,
  resolveAidlcSettings,
} from "./aidlc-settings.ts";

function windowsRecoveryCheck(): DoctorCheck | null {
  if (process.platform !== "win32") return null;
  const recovery = scanWindowsUninstallJournals();
  const paths = [
    ...recovery.pending.map((item) => item.path),
    ...recovery.invalid,
  ];
  return {
    pass: paths.length === 0,
    label: paths.length === 0
      ? "Windows uninstall recovery: no pending continuations"
      : `Windows uninstall recovery: ${recovery.pending.length} pending and ${recovery.invalid.length} invalid continuation(s): ${paths.join(", ")}`,
    fix: paths.length === 0
      ? undefined
      : "finish active AI-DLC commands, then run `aidlc version` to resume cleanup",
  };
}

export async function doctorUpdateState(
  flags: Record<string, string>,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
): Promise<UpdateState> {
  const explicit = flags["check-updates"] === "true";
  const mayRefresh = interactive &&
    flags.json !== "true" &&
    flags.quiet !== "true";
  let update = cachedUpdateState();
  if (
    explicit ||
    (mayRefresh &&
      (update.stale === true ||
        ["stale", "absent", "unavailable"].includes(update.state)))
  ) {
    update = await refreshUpdateState(explicit ? 15_000 : 750, {
      offline: flags.offline === "true" ? true : undefined,
      baseUrl: flags["release-base-url"],
      caBundle: flags["ca-bundle"],
    });
  }
  return update;
}

function updateCheck(state: UpdateState): DoctorCheck {
  return {
    pass: state.state === "current",
    severity: state.state === "current" || state.state === "invalid-config"
      ? undefined
      : "warn",
    label: `Update: ${state.message}`,
    fix: state.state === "behind" ? "run `aidlc update`" : undefined,
  };
}

function pluginCheck(projectDir: string, verbose: boolean): DoctorCheck {
  const { statuses } = collectPluginStatus(projectDir);
  const attention = statuses.filter((status) => status.action === "attention");
  const drift = statuses.filter((status) => status.action === "sync");
  const detail = verbose && statuses.length > 0
    ? ` - ${statuses.map((status) => `${status.key ?? "host"}:${status.state}`).join(", ")}`
    : "";
  if (attention.length > 0) {
    return {
      pass: false,
      severity: "warn",
      label: `Plugins: ${attention.length} need attention${detail}`,
      fix: attention.map((status) => status.message).join("; "),
    };
  }
  if (drift.length > 0) {
    return {
      pass: false,
      severity: "warn",
      label: `Plugins: ${drift.length} require sync${detail}`,
      fix: "run `aidlc config`",
    };
  }
  return {
    pass: true,
    label: statuses.length === 0
      ? "Plugins: no AIDLC plugins installed"
      : `Plugins: composed state is current${detail}`,
  };
}

export function modelsPolicyCheck(projectDir: string, verbose: boolean): DoctorCheck {
  const harnesses = discoverProjectHarnesses(projectDir);
  if (harnesses.length === 0) {
    return {
      pass: true,
      label: "Models: no installed project harness",
    };
  }
  const resolved = resolveAidlcSettings(projectDir);
  const issues: string[] = [];
  for (const harness of harnesses) {
    if (!isModelHarness(harness.distribution)) {
      issues.push(`unsupported harness policy surface: ${harness.distribution}`);
      continue;
    }
    try {
      issues.push(
        ...modelPolicyDoctorIssues(
          harness.root,
          harness.distribution,
          modelPolicyForHarness(resolved.models, harness.distribution),
        )
          .map((issue) => `${harness.distribution}: ${issue}`),
      );
    } catch (error) {
      issues.push(
        `${harness.distribution}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const detail = verbose && issues.length > 0 ? ` - ${issues.join("; ")}` : "";
  if (issues.length > 0) {
    return {
      pass: false,
      severity: "warn",
      label: `Models: ${issues.length} policy issue(s)${detail}`,
      fix: issues.join("; "),
    };
  }
  return {
    pass: true,
    label: "Models: recorded policy is expressible",
  };
}

function humanReport(report: DoctorReport, analysis: DoctorAnalysis): string {
  let output = "AI-DLC Health Check\n";
  output += `${"\u2500".repeat(37)}\n`;
  for (const check of report.checks) {
    if (check.severity === "warn") {
      output += `!  ${check.label}`;
    } else if (check.pass) {
      output += `\u2713  ${check.label}`;
    } else {
      output += `\u2717  ${check.label}`;
    }
    if (!check.pass && check.fix) output += ` - ${check.fix}`;
    output += "\n";
  }
  // Structured diagnosis findings (workflow timeline analysis) are ADVISORY and
  // never change doctor's exit code: they render for visibility but do not count
  // toward `failed`. Only the environment/config checks drive the exit status,
  // so a plain `/aidlc --doctor` keeps its pre-existing contract \u2014 a
  // workflow-level diagnosis (which can be a soft, workflow-in-progress signal)
  // must not flip the exit code that CI and scripts gate on. Info is omitted
  // from the live view to keep it terse; the export carries the full set.
  const diagErrors = analysis.findings.filter((f) => f.severity === "error");
  const diagWarnings = analysis.findings.filter((f) => f.severity === "warning");
  if (diagErrors.length > 0 || diagWarnings.length > 0) {
    output += `${"\u2500".repeat(37)}\n`;
    output += "Workflow diagnosis (advisory):\n";
    for (const f of diagErrors) {
      output += `\u2717  [${f.id}] ${f.summary}`;
      if (f.remedy) output += ` (${f.remedy})`;
      output += "\n";
    }
    for (const f of diagWarnings) {
      output += `!  [${f.id}] ${f.summary}\n`;
    }
  }
  output += `${"\u2500".repeat(37)}\n`;
  output += `${report.passed} passed, ${report.warnings} warnings, ${report.failed} failed\n`;
  return output;
}

// A filesystem-safe UTC timestamp token (isoTimestamp has colons that some
// filesystems reject in names): 2026-07-14T15:26:31Z \u2192 20260714T152631Z.
function fsSafeTimestamp(): string {
  return isoTimestamp().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

// --export: after the live report, write a redacted diagnostic report from
// the SAME analysis this run already computed (issue #575). No second read,
// no cached diagnosis. The export write never changes doctor's exit code.
// `--export` is a bare boolean flag; accept it whether the arg parser recorded
// it as "true" (bare) or a stray token followed it, so a trailing word can
// never silently disable the export.
function writeExport(
  projectDir: string,
  flags: Record<string, string>,
  report: DoctorReport,
  analysis: DoctorAnalysis,
): void {
  try {
    const tsToken = fsSafeTimestamp();
    // A bare `--output` (no value) parses to "true"; treat that as an error
    // rather than creating a directory literally named "true".
    if (flags.output === "true") {
      throw new Error("--output requires a directory path (e.g. --output /tmp/aidlc-report)");
    }
    const outParent = flags.output
      ? flags.output
      : join(projectDir, "aidlc", "diagnostics");
    mkdirSync(outParent, { recursive: true });
    // Merge the legacy environment/config checks (bun present, hooks wired,
    // settings intact) into the exported analysis so report.md/report.json
    // carry the SAME findings the live report shows \u2014 the bundle exists so
    // the maintainer does NOT need the user's project, so a failing env check
    // must reach it. The live render and the exit code are untouched; this
    // only enriches what buildBundle serializes. (Arden round-3 #1.)
    const analysisForExport = {
      ...analysis,
      findings: mergeFindings(report.checks.map(adaptLegacyResult), analysis.findings),
    };
    const exported = buildBundle(outParent, analysisForExport, tsToken);
    let out = "\nDiagnostic report created:\n";
    out += `  ${exported.archivePath ?? exported.bundleDir}\n\n`;
    out += "Findings:\n";
    const topFindings = exported.findings.filter((f) => f.severity !== "info").slice(0, 20);
    if (topFindings.length === 0) {
      out += "  (no errors or warnings)\n";
    } else {
      for (const f of topFindings) out += `  ${f.severity.toUpperCase()} ${f.id}\n`;
    }
    out += "\nNo source files or artifact bodies were included.\n";
    if (exported.manualShareNote) out += `\n${exported.manualShareNote}\n`;
    process.stdout.write(out);
  } catch (e) {
    // Export failure must not mask the live doctor result; report and go on.
    process.stdout.write(`\nDiagnostic report could not be created: ${errorMessage(e)}\n`);
  }
}

export async function main(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const projectDir = resolveProjectDir(flags["project-dir"]);
  const update = await doctorUpdateState(flags);
  const checks: DoctorCheck[] = [];
  const recovery = windowsRecoveryCheck();
  if (recovery) checks.push(recovery);
  checks.push(updateCheck(update));
  checks.push(pluginCheck(projectDir, flags.verbose === "true"));
  checks.push(...settingsDoctorChecks(projectDir));
  checks.push(modelsPolicyCheck(projectDir, flags.verbose === "true"));
  checks.push(flagsDoctorCheck(projectDir, harnessDir()));
  checks.push(providerDoctorCheck(projectDir, harnessDir()));
  checks.push(workspaceSiblingDoctorCheck(projectDir, harnessDir()));
  const report = await collectDoctorReport(projectDir, checks);
  // One fresh analysis, shared by the live report AND the --export writer
  // (issue #575): the structured condition->remedy findings and the
  // reconstructed timeline are computed ONCE here, so the live output and the
  // export can never diverge. The analysis performs no writes.
  const analysis = runDoctorAnalysis(projectDir);
  const code = update.state === "invalid-config"
    ? 2
    : report.failed > 0
    ? 1
    : 0;

  if (flags.json === "true") {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      ok: code === 0,
      code,
      status: report.failed > 0
        ? "failed"
        : report.warnings > 0
        ? "warning"
        : "ok",
      message: `${report.passed} passed, ${report.warnings} warnings, ${report.failed} failed`,
      data: report,
    })}\n`);
  } else if (flags.quiet === "true") {
    process.stdout.write(
      `${report.passed} passed, ${report.warnings} warnings, ${report.failed} failed\n`,
    );
  } else {
    process.stdout.write(humanReport(report, analysis));
  }
  if ("export" in flags) writeExport(projectDir, flags, report, analysis);
  process.exitCode = code;
}

if (import.meta.main) {
  void main(process.argv.slice(2));
}
