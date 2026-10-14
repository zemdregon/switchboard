/**
 * T5.3 (FR-SES-02, FR-ADP-10, NFR-PRIV-02; LLD §1 and §15.3; ADR-0038): the ledger side of the canonical state. One
 * `appendDecision` helper writes the `decision` table once per cause and refuses terminal runs; the append-only triggers
 * reject update and delete; `provider_binding` is set at insert only; `open_work_json` is rewritten at each terminal
 * transition; changed files and verification results are readable per meta-session. No migration is involved.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DECISION_KINDS, type DecisionInput, DecisionTemplateError } from "../continuity/decisions.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, DecisionRefusedError, type Ledger, openLedger, type RunRow } from "./index.js";

let dir: string;
let db: Database.Database;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-canon-"));
  db = openLedger(dir);
  ledger = createLedger(db, { ids: createIdGenerator() });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function newRun(sessionId: string, extra: { request?: unknown } = {}): RunRow {
  return ledger.createRun({
    metaSessionId: sessionId,
    state: "QUEUED",
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: extra.request ?? { objective: "x" },
    requestHash: `h-${Math.random()}`,
    clientId: "c",
    provider: "fake",
  });
}

/** Walk a run to a terminal state through `casRunState`, with the terminal payload a lifecycle would write. */
function finish(runId: string, to: "SUCCEEDED" | "FAILED" | "CANCELLED", payload: Record<string, unknown> = {}) {
  const rec = ledger.getRunRecord(runId);
  if (!rec) throw new Error("no run");
  const fin = ledger.casRunState({ runId, from: rec.state, to: "FINALIZING", expectedVersion: rec.version });
  if (!fin) throw new Error("lost race");
  return ledger.casRunState({
    runId,
    from: "FINALIZING",
    to,
    expectedVersion: fin.version,
    set:
      to === "FAILED" ? { failure_code: "TEST_FAILURE", failure_detail: "d", finished_at: "2026-10-14T00:00:00Z" } : {},
    payload,
  });
}

const SHA = "a".repeat(64);
const COMMIT = "c".repeat(40);
const inputsFor = (runId: string): Record<(typeof DECISION_KINDS)[number], DecisionInput> => ({
  route_selected: { kind: "route_selected", runId, provider: "fake", mode: "new", reasons: ["new_session"] },
  handoff_built: {
    kind: "handoff_built",
    runId,
    bundleArtifactId: "art_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    bundleSha256: SHA,
    asOfSha256: SHA,
    sourceRuns: 2,
  },
  approval_decided: { kind: "approval_decided", runId, approvalId: "apv_AAA", status: "APPROVED", by: "operator" },
  verification_outcome: { kind: "verification_outcome", runId, outcome: "passed", passed: 2, failed: 0, notRun: 0 },
  rollback: { kind: "rollback", runId, head: COMMIT, evidenceCommit: COMMIT, mutated: false },
});

describe("appendDecision (the one writer of the decision table)", () => {
  it("writes each of the five kinds once per cause, with a run_id and the meta-session of the run", () => {
    const s = ledger.createMetaSession({ objective: "o" });
    const run = newRun(s.id);
    const inputs = inputsFor(run.id);
    for (const kind of DECISION_KINDS) {
      const first = ledger.appendDecision(inputs[kind]);
      expect(first.created).toBe(true);
      const again = ledger.appendDecision(inputs[kind]);
      expect(again).toEqual({ id: first.id, created: false });
    }
    const rows = ledger.listDecisionsForRun(run.id);
    expect(rows.map((r) => r.decision).sort()).toEqual([...DECISION_KINDS].sort());
    for (const r of rows) {
      expect(r.id).toMatch(/^dec_/);
      expect(r.run_id).toBe(run.id);
      expect(r.meta_session_id).toBe(s.id);
      expect(r.reason_summary.length).toBeLessThanOrEqual(500);
    }
    expect(rows.find((r) => r.decision === "handoff_built")?.reason_summary).toBe(
      `bundle=art_01ARZ3NDEKTSV4RRFFQ69G5FAV sha256=${SHA} as_of=${SHA} source_runs=2`,
    );
  });

  it("approval_decided is once per approval: a second approval of the same run is a second cause", () => {
    const s = ledger.createMetaSession({ objective: "o" });
    const run = newRun(s.id);
    const a = {
      kind: "approval_decided",
      runId: run.id,
      approvalId: "apv_A",
      status: "APPROVED",
      by: "operator",
    } as const;
    expect(ledger.appendDecision(a).created).toBe(true);
    expect(ledger.appendDecision(a).created).toBe(false);
    expect(ledger.appendDecision({ ...a, approvalId: "apv_B", status: "DENIED" }).created).toBe(true);
    // apv_A must not match apv_AB by prefix.
    expect(ledger.appendDecision({ ...a, approvalId: "apv_AB" }).created).toBe(true);
    expect(ledger.listDecisionsForRun(run.id)).toHaveLength(3);
  });

  it("refuses a decision for a terminal run (the ordering rule) and for an unknown run; nothing is written", () => {
    const s = ledger.createMetaSession({ objective: "o" });
    const run = newRun(s.id);
    ledger.appendDecision(inputsFor(run.id).route_selected);
    expect(finish(run.id, "SUCCEEDED")?.state).toBe("SUCCEEDED");
    for (const kind of DECISION_KINDS) {
      expect(() => ledger.appendDecision(inputsFor(run.id)[kind])).toThrow(DecisionRefusedError);
    }
    expect(() => ledger.appendDecision(inputsFor("run_NOPE").route_selected)).toThrow(DecisionRefusedError);
    expect(ledger.listDecisionsForRun(run.id)).toHaveLength(1);
  });

  it("rejects free text and writes nothing (NFR-PRIV-02)", () => {
    const s = ledger.createMetaSession({ objective: "o" });
    const run = newRun(s.id);
    expect(() =>
      ledger.appendDecision({
        kind: "route_selected",
        runId: run.id,
        provider: "the model said: pick this one because it is best",
        mode: "new",
        reasons: ["new_session"],
      }),
    ).toThrow(DecisionTemplateError);
    expect(ledger.listDecisionsForRun(run.id)).toEqual([]);
  });

  it("the append-only triggers reject UPDATE and DELETE of a decision row", () => {
    const s = ledger.createMetaSession({ objective: "o" });
    const run = newRun(s.id);
    const { id } = ledger.appendDecision(inputsFor(run.id).rollback);
    expect(() => db.prepare("UPDATE decision SET reason_summary = 'x' WHERE id = ?").run(id)).toThrow(
      /append-only|ABORT|decision/i,
    );
    expect(() => db.prepare("DELETE FROM decision WHERE id = ?").run(id)).toThrow(/append-only|ABORT|decision/i);
    expect(ledger.listDecisionsForRun(run.id)).toHaveLength(1);
  });

  it("needs no migration: the table keeps its 0001 columns", () => {
    const cols = (db.prepare("PRAGMA table_info(decision)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["id", "meta_session_id", "run_id", "decision", "reason_summary", "created_at"]);
  });
});

describe("provider_binding is set at insert and not updated (FR-ADP-10)", () => {
  it("records harness, backing provider and model; a second bind of the same native session refreshes last_used_at only", () => {
    const s = ledger.createMetaSession({ objective: "o" });
    ledger.recordProviderBinding({
      metaSessionId: s.id,
      provider: "fake",
      nativeSessionId: "n-1",
      backingProvider: "backing-x",
      model: "m-a",
    });
    ledger.recordProviderBinding({
      metaSessionId: s.id,
      provider: "fake",
      nativeSessionId: "n-1",
      model: "other",
      backingProvider: "other",
    });
    const [row, ...rest] = ledger.listProviderBindings(s.id);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      provider: "fake",
      harness: "fake",
      backing_provider: "backing-x",
      model: "m-a",
      native_session_id: "n-1",
    });
  });

  it("harness defaults to the provider and backing provider and model default to null", () => {
    const s = ledger.createMetaSession({ objective: "o" });
    ledger.recordProviderBinding({ metaSessionId: s.id, provider: "fake", nativeSessionId: "n-2" });
    expect(ledger.latestProviderBinding(s.id)).toMatchObject({ harness: "fake", backing_provider: null, model: null });
  });
});

describe("open_work_json is rewritten at each terminal transition (LLD §15.3)", () => {
  it("is [] before any terminal run, then the derivation of the terminal runs; no run_event is added for it", () => {
    const s = ledger.createMetaSession({ objective: "o" });
    expect(ledger.getOpenWorkProjection(s.id)).toEqual([]);
    const r1 = newRun(s.id, {
      request: {
        objective: "a",
        verification_commands: [
          ["npm", "test"],
          ["npm", "run", "lint"],
        ],
      },
    });
    ledger.appendRunEvent({
      runId: r1.id,
      type: "verification_command",
      payload: { index: 0, outcome: "passed", exit_code: 0 },
    });
    ledger.appendRunEvent({
      runId: r1.id,
      type: "verification_command",
      payload: { index: 1, outcome: "failed", exit_code: 1 },
    });
    ledger.appendRunEvent({
      runId: r1.id,
      type: "workspace_assessment",
      payload: { nested_repositories_skipped: ["a", "b"] },
    });
    expect(ledger.getOpenWorkProjection(s.id)).toEqual([]); // not terminal yet
    const before = ledger.listRunEvents(r1.id).length;
    finish(r1.id, "FAILED", { git_policy_violation: true });
    // Exactly the two transition events (to FINALIZING and to FAILED) were added; the projection adds none.
    expect(ledger.listRunEvents(r1.id).length).toBe(before + 2);
    expect(ledger.getOpenWorkProjection(s.id)).toEqual([
      { kind: "last_run_failed", run_id: r1.id, detail: "TEST_FAILURE" },
      {
        kind: "verification_not_passing",
        run_id: r1.id,
        detail: { index: 1, outcome: "failed", argv: ["npm", "run", "lint"] },
      },
      { kind: "instruction_not_completed", run_id: r1.id, detail: r1.id },
      { kind: "nested_repositories_skipped", run_id: r1.id, detail: 2 },
      { kind: "git_policy_violation", run_id: r1.id, detail: null },
    ]);
    // A later succeeded run (no verification of its own) clears the newest-run items; the verification item of the older
    // verified run stays (LLD §15.3: "the newest run that ran verification").
    const r2 = newRun(s.id);
    finish(r2.id, "SUCCEEDED");
    expect(ledger.getOpenWorkProjection(s.id)).toEqual([
      {
        kind: "verification_not_passing",
        run_id: r1.id,
        detail: { index: 1, outcome: "failed", argv: ["npm", "run", "lint"] },
      },
    ]);
  });

  it("a CANCELLED run is open work too", () => {
    const s = ledger.createMetaSession({ objective: "o" });
    const r = newRun(s.id);
    ledger.casRunState({ runId: r.id, from: "QUEUED", to: "CANCELLED", expectedVersion: r.version, payload: {} });
    expect(ledger.getOpenWorkProjection(s.id)).toEqual([
      { kind: "last_run_cancelled", run_id: r.id, detail: null },
      { kind: "instruction_not_completed", run_id: r.id, detail: r.id },
    ]);
  });

  it("is not touched by a non-terminal transition, and another meta-session is unaffected", () => {
    const a = ledger.createMetaSession({ objective: "a" });
    const b = ledger.createMetaSession({ objective: "b" });
    const ra = newRun(a.id);
    ledger.casRunState({ runId: ra.id, from: "QUEUED", to: "PREFLIGHT", expectedVersion: ra.version, payload: {} });
    expect(ledger.getOpenWorkProjection(a.id)).toEqual([]);
    const rb = newRun(b.id);
    finish(rb.id, "FAILED");
    expect(ledger.getOpenWorkProjection(a.id)).toEqual([]);
    expect(ledger.getOpenWorkProjection(b.id)).not.toEqual([]);
    expect(ledger.getOpenWorkProjection("sess_NOPE")).toBeUndefined();
  });
});

describe("changed files and verification results per meta-session (read helper)", () => {
  it("lists the terminal runs in order with counts, artifacts, post commit and verification results", () => {
    const s = ledger.createMetaSession({ objective: "o" });
    const r1 = newRun(s.id, { request: { objective: "a", verification_commands: [["npm", "test"]] } });
    ledger.appendRunEvent({
      runId: r1.id,
      type: "verification_command",
      payload: { index: 0, outcome: "failed", exit_code: 2 },
    });
    finish(r1.id, "FAILED", {
      changed_files: 3,
      artifacts: { changed_files: "art_CF1", diff: "art_D1", test_report: "art_T1" },
    });
    const r2 = newRun(s.id);
    finish(r2.id, "SUCCEEDED", { changed_files: 1, artifacts: { changed_files: "art_CF2" } });
    const r3 = newRun(s.id); // still QUEUED: not part of the outcomes
    expect(r3.id).toBeDefined();

    const out = ledger.listOutcomesForMetaSession(s.id);
    expect(out?.meta_session_id).toBe(s.id);
    expect(out?.runs.map((r) => r.run_id)).toEqual([r1.id, r2.id]);
    expect(out?.runs[0]).toMatchObject({
      state: "FAILED",
      failure_code: "TEST_FAILURE",
      changed_files: 3,
      changed_files_artifact_id: "art_CF1",
      diff_artifact_id: "art_D1",
      test_report_artifact_id: "art_T1",
      verification: [{ index: 0, outcome: "failed", exit_code: 2, argv: ["npm", "test"] }],
    });
    expect(out?.runs[1]).toMatchObject({
      state: "SUCCEEDED",
      changed_files: 1,
      changed_files_artifact_id: "art_CF2",
      verification: [],
    });
    expect(ledger.listOutcomesForMetaSession("sess_NOPE")).toBeUndefined();
  });
});
