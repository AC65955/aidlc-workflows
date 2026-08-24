#!/usr/bin/env bun
// Router-owned outer gate for the entire AIDLC Codex hook chain.
//
// A state file is intentionally never sufficient to activate this fork. The
// wrapper asks ai-harness-route about *this event* before it runs the existing
// adapter, then asks the router's provider-native gate for AIDLC's canonical
// intent and runnable state. Missing or malformed router integration fails
// closed: no context, audit, heartbeat, stamp, or lifecycle work is emitted.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// These imports intentionally target the packaged .codex/tools/ tree, just as
// aidlc-codex-adapter.ts does. The manifest projects core/tools beside this
// authored wrapper in every emitted Codex installation.
import { activeIntentUuid, activeSpace, findIntentByUuid, getField, stateFilePath } from "../tools/aidlc-lib.ts";

type RouteAction = { kind?: string; purpose?: "activate" | "resume" };
type RouteDecision = { actions?: RouteAction[] };
type NativeGate = { allow?: boolean; allowContext?: boolean };

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const ADAPTER = join(HERE, "aidlc-codex-adapter.ts");
const BRIDGE = resolve(HERE, "../tools/aidlc-router-bridge.ts");

function jsonProcess(command: string[], input: string, cwd: string): Record<string, unknown> | null {
  try {
    const result = Bun.spawnSync(command, { stdin: Buffer.from(input), stdout: "pipe", stderr: "ignore", cwd });
    if (result.exitCode !== 0) return null;
    return JSON.parse(result.stdout.toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function routerRoot(): string | null {
  const raw = process.env.AIDLC_HARNESS_ROUTE_ROOT;
  if (!raw) return null;
  const root = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  return existsSync(join(root, "adapters", "codex", "route-hook.ts")) &&
    existsSync(join(root, "adapters", "aidlc-v2", "route-gate.ts"))
    ? root
    : null;
}

function promptFrom(event: Record<string, unknown>): string | undefined {
  for (const key of ["prompt", "user_prompt", "user_message"]) {
    const value = event[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function workflowIdentity(projectDir: string): { intentId: string; workflowActive: boolean } | null {
  const space = activeSpace(projectDir);
  const uuid = activeIntentUuid(projectDir, space);
  if (!uuid) return null;
  const intent = findIntentByUuid(projectDir, uuid);
  if (!intent) return null;
  const path = stateFilePath(projectDir, intent.dirName, intent.space);
  if (!existsSync(path)) return { intentId: `${intent.space}:${uuid}`, workflowActive: false };
  let state = "";
  try { state = readFileSync(path, "utf-8"); } catch { return { intentId: `${intent.space}:${uuid}`, workflowActive: false }; }
  const status = (getField(state, "Status") ?? "").trim().toLowerCase();
  const terminal = ["complete", "completed", "cancelled", "canceled", "terminal"].includes(status);
  const parked = (getField(state, "Parked") ?? "").trim().length > 0;
  return { intentId: `${intent.space}:${uuid}`, workflowActive: !terminal && !parked };
}

export async function run(target: string, input: string): Promise<number> {
  let event: Record<string, unknown>;
  try { event = input ? JSON.parse(input) as Record<string, unknown> : {}; } catch { return 0; }
  const sessionId = typeof event.session_id === "string" ? event.session_id : process.env.CODEX_SESSION_ID;
  const projectDirRaw = typeof event.cwd === "string" ? event.cwd : process.cwd();
  const projectDir = isAbsolute(projectDirRaw) ? projectDirRaw : resolve(process.cwd(), projectDirRaw);
  const root = routerRoot();
  if (!sessionId || !root) return 0;
  event.session_id = sessionId;

  const routeHook = join(root, "adapters", "codex", "route-hook.ts");
  let decision = jsonProcess([process.execPath, routeHook], JSON.stringify(event), projectDir) as RouteDecision | null;
  if (!decision) return 0;

  const request = decision.actions?.find((action) => action.kind === "request-provider-binding");
  if (request) {
    const prompt = promptFrom(event);
    if (!prompt || !request.purpose) return 0;
    const binding = jsonProcess(
      [process.execPath, BRIDGE],
      JSON.stringify({ session_id: sessionId, command: prompt, purpose: request.purpose }),
      projectDir,
    );
    const identity = typeof binding?.canonical_intent_identity === "string" ? binding.canonical_intent_identity : undefined;
    if (binding?.accepted !== true || !identity) return 0;
    const flag = request.purpose === "resume" ? "--resume-confirmed" : "--provider-confirmed";
    const activated = jsonProcess(
      ["bun", "run", "route", "--", "activate", "--repo", projectDir, "--session", sessionId, "--provider", "aidlc", "--resource", identity, flag],
      "",
      root,
    );
    if (!activated) return 0;
    decision = jsonProcess([process.execPath, routeHook], JSON.stringify(event), projectDir) as RouteDecision | null;
    if (!decision) return 0;
  }

  const enabled = decision.actions?.some((action) => action.kind === "enable-hook-chain");
  if (!enabled) return 0;
  const identity = workflowIdentity(projectDir);
  if (!identity) return 0;
  const gate = jsonProcess(
    [process.execPath, join(root, "adapters", "aidlc-v2", "route-gate.ts")],
    JSON.stringify({ ...event, intent_id: identity.intentId, workflow_active: identity.workflowActive }),
    projectDir,
  ) as NativeGate | null;
  if (!gate) return 0;

  // Context-only bindings cannot safely run existing hooks: several core hooks
  // write audit/stamp/heartbeat before producing their context. Suppress them
  // until a future dedicated read-only renderer exists.
  if (gate.allow !== true) return 0;
  const result = Bun.spawnSync([process.execPath, ADAPTER, target], {
    stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe", cwd: projectDir, env: process.env,
  });
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode ?? 0;
}

if (import.meta.main) process.exit(await run(process.argv[2] ?? "", await Bun.stdin.text()));
