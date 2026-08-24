import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveBindingRequest } from "../../core/tools/aidlc-router-bridge.ts";
import { stateFilePath } from "../../core/tools/aidlc-lib.ts";

const scratch: string[] = [];

function project(status = "in-flight", state = "In Progress"): { root: string; record: string; uuid: string } {
  const root = mkdtempSync(join(tmpdir(), "aidlc-router-bridge-"));
  scratch.push(root);
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  const record = "native-gate-123e4567";
  const intentsRoot = join(root, "aidlc", "spaces", "default", "intents");
  mkdirSync(intentsRoot, { recursive: true });
  writeFileSync(join(intentsRoot, "intents.json"), JSON.stringify([
    { uuid, slug: "native-gate", dirName: record, status },
  ]));
  const path = stateFilePath(root, record, "default");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `# State\n\n- **Status**: ${state}\n`);
  return { root, record, uuid };
}

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("t294 AIDLC router provider-confirmation bridge", () => {
  test("selects an explicit runnable intent and returns its space-qualified UUID", () => {
    const fixture = project();
    const result = resolveBindingRequest(fixture.root, {
      session_id: "session-1",
      command: "$aidlc intent native-gate",
      purpose: "activate",
    });

    expect(result).toEqual({
      accepted: true,
      canonical_intent_identity: `default:${fixture.uuid}`,
      workflow_active: true,
      purpose: "activate",
    });
    expect(readFileSync(join(fixture.root, "aidlc", "spaces", "default", "intents", "active-intent"), "utf-8"))
      .toBe(`${fixture.record}\n`);
  });

  test("rejects terminal intents and binds a parked intent only for explicit resume", () => {
    const completed = project("complete");
    expect(resolveBindingRequest(completed.root, {
      session_id: "session-1", command: "$aidlc intent native-gate", purpose: "activate",
    })).toMatchObject({ accepted: false, workflow_active: false, reason: "intent status is terminal (complete)" });

    const parked = project();
    const state = stateFilePath(parked.root, parked.record, "default");
    writeFileSync(state, "# State\n\n- **Status**: In Progress\n- **Parked**: 2026-08-21T00:00:00Z\n");
    expect(resolveBindingRequest(parked.root, {
      session_id: "session-2", command: "$aidlc intent native-gate", purpose: "activate",
    })).toMatchObject({ accepted: false, workflow_active: false, reason: expect.stringContaining("parked") });
    expect(resolveBindingRequest(parked.root, {
      session_id: "session-2", command: "$aidlc intent native-gate --resume", purpose: "resume",
    })).toEqual({
      accepted: true,
      canonical_intent_identity: `default:${parked.uuid}`,
      workflow_active: false,
      purpose: "resume",
    });
  });
});
