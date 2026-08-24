#!/usr/bin/env bun
// Provider-confirmation bridge for ai-harness-route's AIDLC v2 integration.
//
// The router deliberately does not read AIDLC state. This bridge owns the
// opposite boundary: it resolves an explicit AIDLC selection/resume command to
// its canonical resource identity, validates whether the selected workflow may
// run, and only then updates AIDLC's cursor/session stamp. It does not invoke
// the router or advance lifecycle state.

import { existsSync, readFileSync } from "node:fs";
import {
  activeSpace,
  getField,
  listIntents,
  setActiveIntentCursor,
  stateFilePath,
  writeSessionIntentUuid,
} from "./aidlc-lib.ts";

export type BindingPurpose = "activate" | "resume";

export interface BindingRequest {
  session_id: string;
  command: string;
  purpose?: BindingPurpose;
}

export interface BindingResponse {
  accepted: boolean;
  canonical_intent_identity?: string;
  workflow_active: boolean;
  purpose?: BindingPurpose;
  reason?: string;
}

type ResolvedIntent = {
  space: string;
  uuid: string;
  slug: string;
  dirName: string;
  status: string;
};

const TERMINAL_STATUSES = new Set(["complete", "completed", "cancelled", "canceled", "terminal"]);

function reject(reason: string): BindingResponse {
  return { accepted: false, workflow_active: false, reason };
}

function parseRequest(command: string): { target?: string; purpose: BindingPurpose } | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens[0]?.toLowerCase() !== "$aidlc" && tokens[0]?.toLowerCase() !== "/aidlc") return null;
  const subcommand = tokens[1]?.toLowerCase();
  if (subcommand === "--resume" && tokens.length === 2) return { purpose: "resume" };
  if (subcommand !== "intent") return null;

  const target = tokens[2];
  if (target === "--resume" && tokens.length === 3) return { purpose: "resume" };
  if (!target || ["switch", "list", "create"].includes(target.toLowerCase())) return null;
  const flags = tokens.slice(3);
  if (flags.some((flag) => flag !== "--resume")) return null;
  return { target, purpose: flags.includes("--resume") ? "resume" : "activate" };
}

function resolveIntent(projectDir: string, target: string | undefined): ResolvedIntent | null {
  const space = activeSpace(projectDir);
  const intents = listIntents(projectDir, space);
  const selected = target
    ? intents.find((intent) => intent.dirName === target) ??
      (() => {
        const matches = intents.filter((intent) => intent.slug === target && intent.dirName !== null);
        return matches.length === 1 ? matches[0] : undefined;
      })()
    : intents.find((intent) => intent.active);
  if (!selected?.dirName || !selected.uuid) return null;
  return {
    space,
    uuid: selected.uuid,
    slug: selected.slug,
    dirName: selected.dirName,
    status: selected.status,
  };
}

function workflowActive(projectDir: string, intent: ResolvedIntent): { active: boolean; reason?: string } {
  if (TERMINAL_STATUSES.has(intent.status.trim().toLowerCase())) {
    return { active: false, reason: `intent status is terminal (${intent.status})` };
  }
  const path = stateFilePath(projectDir, intent.dirName, intent.space);
  if (!existsSync(path)) return { active: false, reason: "intent has no lifecycle state" };
  let state: string;
  try {
    state = readFileSync(path, "utf-8");
  } catch {
    return { active: false, reason: "intent lifecycle state is unreadable" };
  }
  const status = (getField(state, "Status") ?? "").trim().toLowerCase();
  if (TERMINAL_STATUSES.has(status)) return { active: false, reason: `workflow status is terminal (${status})` };
  if ((getField(state, "Parked") ?? "").trim().length > 0) {
    return { active: false, reason: "workflow is parked; resume must complete before lifecycle hooks run" };
  }
  return { active: true };
}

/**
 * Resolve and validate a router request. A successful response deliberately
 * moves only AIDLC-owned cursor/stamp state; router activation is the host's
 * subsequent responsibility and requires its own provider-confirmed flag.
 */
export function resolveBindingRequest(projectDir: string, request: BindingRequest): BindingResponse {
  if (!request.session_id) return reject("missing session_id");
  const parsed = parseRequest(request.command);
  if (!parsed) return reject("unsupported AIDLC binding command");
  if (request.purpose && request.purpose !== parsed.purpose) return reject("requested purpose does not match AIDLC command");
  const intent = resolveIntent(projectDir, parsed.target);
  if (!intent) return reject(parsed.target ? "intent was not found or is ambiguous" : "no active AIDLC intent");
  const current = workflowActive(projectDir, intent);
  // A parked intent is inactive for hooks, but an explicit resume is its
  // sanctioned re-entry path. Bind it read-only for this turn; `unpark` then
  // makes the next event runnable without ever treating old state as activation.
  const resumeParked = parsed.purpose === "resume" && current.reason?.startsWith("workflow is parked");
  if (!current.active && !resumeParked) return reject(current.reason ?? "workflow is not runnable");

  // AIDLC, not the router, owns intent selection and its session stamp.
  setActiveIntentCursor(projectDir, intent.dirName, intent.space);
  writeSessionIntentUuid(projectDir, request.session_id, intent.uuid);
  return {
    accepted: true,
    canonical_intent_identity: `${intent.space}:${intent.uuid}`,
    workflow_active: current.active,
    purpose: parsed.purpose,
  };
}

if (import.meta.main) {
  const input = await Bun.stdin.json().catch(() => null) as BindingRequest | null;
  if (!input) {
    process.stdout.write(`${JSON.stringify(reject("expected JSON binding request on stdin"))}\n`);
    process.exit(0);
  }
  process.stdout.write(`${JSON.stringify(resolveBindingRequest(process.cwd(), input))}\n`);
}
