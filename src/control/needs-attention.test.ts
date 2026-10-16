/**
 * T14.2 (FR-CTL-03, LLD §3.4.5): the derived `needs_attention` flag. Each of the five reasons derives from planted ledger
 * rows; a terminal run with no matching rule has no flag; one reason wins by the priority order; unevaluable inputs fail
 * closed. `meta_session.parked_loop` and `control_plane_state` are planted in the shape LLD §3.4.7 names (their writers
 * are T14.4/T14.5) and read through a test {@link ControlPlaneFacts}; without them nothing is inferred.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRecord, type RunState } from "../ledger/index.js";
import {
  type ControlPlaneFacts,
  DEFAULT_MAX_SUCCESSORS_PER_META_SESSION,
  DEFAULT_STALL_MINUTES,
  deriveNeedsAttention,
  matchingReasons,
  NEEDS_ATTENTION_PRIORITY,
  type NeedsAttentionFacts,
  needsAttentionOf,
  readNeedsAttentionFacts,
} from "./needs-attention.js";

const T0 = Date.parse("2026-10-16T10:00:00.000Z");
let dir: string;
let db: Database.Database;
let ledger: Ledger;
let clock: number;
const now = () => new Date(clock);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-needs-attention-"));
  db = openLedger(dir);
  clock = T0;
  ledger = createLedger(db, { ids: createIdGenerator(), now });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function session(projectId: string | null = "web"): string {
  return ledger.createMetaSession({ objective: "o", projectId }).id;
}

function run(metaSessionId: string, state: RunState, extra: { attempt?: number; projectId?: string | null } = {}) {
  const projectId = extra.projectId === undefined ? "web" : extra.projectId;
  const created = ledger.createRun({
    metaSessionId,
    state: state === "FAILED" ? "RUNNING" : state,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "orch",
    projectId,
    attempt: extra.attempt ?? 1,
  });
  if (state === "FAILED") {
    ledger.casRunState({
      runId: created.id,
      from: "RUNNING",
      to: "FAILED",
      expectedVersion: created.version,
      set: { failure_code: "VERIFY_FAILED" },
      payload: { to: "FAILED" },
    });
  }
  return record(created.id);
}

const record = (id: string): RunRecord => ledger.getRunRecord(id) as RunRecord;

/** Plants the LLD §3.4.7 persistence (T14.5 column, T14.4/T14.6 table) and reads it as T14.4/T14.5 will. */
function plantControlPlane(): ControlPlaneFacts {
  db.exec("ALTER TABLE meta_session ADD COLUMN parked_loop INTEGER NOT NULL DEFAULT 0");
  db.exec(`CREATE TABLE control_plane_state (
    project_id TEXT PRIMARY KEY, paused INTEGER NOT NULL CHECK (paused IN (0,1)), paused_by TEXT, paused_at TEXT,
    budget_flags_json TEXT CHECK (budget_flags_json IS NULL OR json_valid(budget_flags_json))) STRICT`);
  return {
    metaSessionParked: (id) =>
      (db.prepare("SELECT parked_loop FROM meta_session WHERE id = ?").get(id) as { parked_loop: number })
        .parked_loop === 1,
    budgetExhausted: (projectId) => {
      const row = db.prepare("SELECT budget_flags_json FROM control_plane_state WHERE project_id = ?").get(projectId) as
        | { budget_flags_json: string | null }
        | undefined;
      return row?.budget_flags_json != null && Object.keys(JSON.parse(row.budget_flags_json)).length > 0;
    },
  };
}

const attention = (r: RunRecord, control?: ControlPlaneFacts) =>
  needsAttentionOf(ledger, record(r.id), { now: now(), ...(control ? { control } : {}) });

describe("needs_attention derives each of the five reasons from ledger rows (T14.2, FR-CTL-03)", () => {
  it("awaiting_approval: the run is AWAITING_APPROVAL", () => {
    const r = run(session(), "AWAITING_APPROVAL");
    expect(attention(r)).toEqual({ active: true, reason: "awaiting_approval" });
  });

  it("awaiting_approval: a PENDING approval row on a run of the meta-session; cleared once decided", () => {
    const s = session();
    const first = run(s, "RUNNING");
    const later = run(s, "QUEUED");
    const approval = ledger.createApproval({ runId: first.id, scopeJson: "{}", scopeHash: "x" });
    expect(attention(later)).toEqual({ active: true, reason: "awaiting_approval" });
    ledger.decideApproval({ id: approval.id, status: "APPROVED", decidedBy: "op" });
    expect(attention(later)).toEqual({ active: false });
  });

  it("awaiting_approval: another client's approval in its own meta-session does not flag this client's run", () => {
    const theirs = ledger.createRun({
      metaSessionId: session(),
      state: "AWAITING_APPROVAL",
      trustProfile: "privileged",
      policySnapshot: {},
      request: {},
      requestHash: "h",
      clientId: "other",
      projectId: "web",
    });
    ledger.createApproval({ runId: theirs.id, scopeJson: "{}", scopeHash: "x" });
    expect(attention(run(session(), "QUEUED"))).toEqual({ active: false });
  });

  it("stalled: RUNNING or LEASED with no run_event for T minutes; any event resets the clock; not cancelled", () => {
    const s = session();
    const running = run(s, "RUNNING");
    ledger.appendRunEvent({ runId: running.id, type: "progress" });
    clock = T0 + (DEFAULT_STALL_MINUTES * 60_000 - 1);
    expect(attention(running)).toEqual({ active: false });
    clock = T0 + DEFAULT_STALL_MINUTES * 60_000;
    expect(attention(running)).toEqual({ active: true, reason: "stalled" });
    expect(record(running.id).state).toBe("RUNNING");
    ledger.appendRunEvent({ runId: running.id, type: "progress" });
    expect(attention(running)).toEqual({ active: false });

    const leased = run(s, "LEASED");
    clock += 31 * 60_000;
    expect(attention(leased)).toEqual({ active: true, reason: "stalled" });
    // The LLD §3.4.5 rule covers RUNNING and LEASED only.
    const others = (["QUEUED", "PREFLIGHT", "VERIFYING", "FINALIZING", "WAITING_CAPACITY"] as const).map((state) =>
      run(session(), state),
    );
    clock += 31 * 60_000;
    for (const r of others) expect(attention(r)).toEqual({ active: false });
  });

  it("failed_after_retry: FAILED at the successor cap; a failed first attempt with retries left has no flag", () => {
    const s = session();
    expect(attention(run(s, "FAILED", { attempt: 1 }))).toEqual({ active: false });
    const atCap = run(s, "FAILED", { attempt: DEFAULT_MAX_SUCCESSORS_PER_META_SESSION });
    expect(attention(atCap)).toEqual({ active: true, reason: "failed_after_retry" });
    expect(needsAttentionOf(ledger, record(atCap.id), { now: now(), maxSuccessorsPerMetaSession: 9 })).toEqual({
      active: false,
    });
  });

  it("parked_loop: meta_session.parked_loop is set; the newest run shows it, an older FAILED run failed_after_retry", () => {
    const control = plantControlPlane();
    const s = session();
    const older = run(s, "FAILED");
    clock += 1000;
    const newest = run(s, "FAILED", { attempt: 2 });
    expect(attention(newest, control)).toEqual({ active: false });
    db.prepare("UPDATE meta_session SET parked_loop = 1 WHERE id = ?").run(s);
    expect(attention(newest, control)).toEqual({ active: true, reason: "parked_loop" });
    expect(attention(older, control)).toEqual({ active: true, reason: "failed_after_retry" });
  });

  it("budget_exhausted: an active refusal for the project or globally flags its non-terminal runs only", () => {
    const control = plantControlPlane();
    const s = session();
    const queued = run(s, "QUEUED");
    const done = run(s, "SUCCEEDED");
    const workspaceRun = run(session(null), "QUEUED", { projectId: null });
    const otherProject = run(session("api"), "QUEUED", { projectId: "api" });
    db.prepare("INSERT INTO control_plane_state (project_id, paused, budget_flags_json) VALUES (?, 0, ?)").run(
      "web",
      JSON.stringify({ runs_per_day: { used: 5, limit: 5 } }),
    );
    expect(attention(queued, control)).toEqual({ active: true, reason: "budget_exhausted" });
    expect(attention(done, control)).toEqual({ active: false });
    expect(attention(otherProject, control)).toEqual({ active: false });
    db.prepare("INSERT INTO control_plane_state (project_id, paused, budget_flags_json) VALUES ('*', 0, ?)").run(
      JSON.stringify({ concurrent_runs: { used: 4, limit: 4 } }),
    );
    expect(attention(otherProject, control)).toEqual({ active: true, reason: "budget_exhausted" });
    // No project resolution, no budget reason (fail closed).
    expect(attention(workspaceRun, control)).toEqual({ active: false });
  });
});

describe("needs_attention: no flag, priority and fail-closed defaults", () => {
  it("a terminal run with no matching rule has no flag and no reason", () => {
    const s = session();
    for (const state of ["SUCCEEDED", "CANCELLED", "FAILED"] as const) {
      const r = run(s, state);
      clock += 24 * 60 * 60_000; // a day of silence never stalls a terminal run
      const flag = attention(r);
      expect(flag).toEqual({ active: false });
      expect("reason" in flag).toBe(false);
    }
  });

  it("without the T14.4/T14.5 persistence nothing infers parked_loop or budget_exhausted", () => {
    const r = run(session(), "FAILED", { attempt: 2 });
    expect(readNeedsAttentionFacts(ledger, r)).toMatchObject({ metaSessionParked: false, budgetExhausted: false });
    expect(attention(r)).toEqual({ active: false });
  });

  it("exposes one reason by the LLD §3.4.5 order when several match", () => {
    const all: NeedsAttentionFacts = {
      state: "RUNNING",
      attempt: 99,
      lastActivityAt: new Date(T0).toISOString(),
      pendingApproval: true,
      metaSessionParked: true,
      newestInMetaSession: true,
      budgetExhausted: true,
    };
    const later = { now: new Date(T0 + 60 * 60_000) };
    expect(NEEDS_ATTENTION_PRIORITY).toEqual([
      "budget_exhausted",
      "parked_loop",
      "awaiting_approval",
      "stalled",
      "failed_after_retry",
    ]);
    expect(matchingReasons(all, later)).toEqual(["budget_exhausted", "parked_loop", "awaiting_approval", "stalled"]);
    expect(deriveNeedsAttention(all, later)).toEqual({ active: true, reason: "budget_exhausted" });
    expect(deriveNeedsAttention({ ...all, budgetExhausted: false }, later)).toMatchObject({ reason: "parked_loop" });
    expect(deriveNeedsAttention({ ...all, budgetExhausted: false, metaSessionParked: false }, later)).toMatchObject({
      reason: "awaiting_approval",
    });
    const failed = { ...all, state: "FAILED" as const, budgetExhausted: false, newestInMetaSession: false };
    expect(matchingReasons({ ...failed, pendingApproval: false }, later)).toEqual(["failed_after_retry"]);
  });

  it("an unevaluable stall clock does not flag stalled", () => {
    const facts: NeedsAttentionFacts = {
      state: "RUNNING",
      attempt: 1,
      lastActivityAt: "not a time",
      pendingApproval: false,
      metaSessionParked: false,
      newestInMetaSession: true,
      budgetExhausted: false,
    };
    expect(deriveNeedsAttention(facts, { now: new Date(T0) })).toEqual({ active: false });
    expect(
      deriveNeedsAttention({ ...facts, lastActivityAt: "2026-01-01T00:00:00Z" }, { now: new Date(Number.NaN) }),
    ).toEqual({ active: false });
  });

  it("is recomputed on read and never written to the ledger", () => {
    const r = run(session(), "RUNNING");
    const before = db.prepare("SELECT * FROM run WHERE id = ?").get(r.id);
    const events = ledger.listRunEvents(r.id).length;
    clock += 60 * 60_000;
    expect(attention(r)).toEqual({ active: true, reason: "stalled" });
    expect(db.prepare("SELECT * FROM run WHERE id = ?").get(r.id)).toEqual(before);
    expect(ledger.listRunEvents(r.id)).toHaveLength(events);
  });
});
