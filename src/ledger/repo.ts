import type Database from "better-sqlite3";
import { defaultIds, type IdGenerator } from "../ids/index.js";

/**
 * Minimal typed repository helpers (Proposed shape). They cover what T1.3 tests and the T1.5/T1.8 callers need first;
 * the run state machine lives in the lifecycle module (FRD §4), not here.
 */

export type RunState =
  | "AWAITING_APPROVAL"
  | "QUEUED"
  | "WAITING_CAPACITY"
  | "PREFLIGHT"
  | "LEASED"
  | "RUNNING"
  | "VERIFYING"
  | "FINALIZING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export type TrustProfile =
  | "inspect-untrusted"
  | "edit-untrusted"
  | "test-sandboxed"
  | "trusted-development"
  | "privileged";

export interface LedgerDeps {
  ids?: IdGenerator;
  now?: () => Date;
}

export interface MetaSessionRow {
  id: string;
  objective: string;
  status: "ACTIVE" | "ARCHIVED";
  repo_root: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface NewMetaSession {
  objective: string;
  repoRoot?: string | null;
  constraints?: unknown[];
}

export interface RunRow {
  id: string;
  meta_session_id: string;
  state: RunState;
  failure_code: string | null;
  trust_profile: TrustProfile;
  request_hash: string;
  client_id: string;
  idempotency_key: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface NewRun {
  metaSessionId: string;
  state?: RunState;
  trustProfile: TrustProfile;
  policySnapshot: unknown;
  request: unknown;
  requestHash: string;
  clientId: string;
  idempotencyKey?: string | null;
}

export interface RunEventRow {
  id: string;
  run_id: string;
  seq: number;
  ts: string;
  type: string;
  payload_json: string;
  artifact_id: string | null;
}

export interface NewRunEvent {
  runId: string;
  type: string;
  payload?: unknown;
  artifactId?: string | null;
}

export interface Ledger {
  createMetaSession(input: NewMetaSession): MetaSessionRow;
  getMetaSession(id: string): MetaSessionRow | undefined;
  createRun(input: NewRun): RunRow;
  getRun(id: string): RunRow | undefined;
  /** Append the next event for a run: `seq` is per-run, gapless, starting at 1 (LLD §1). */
  appendRunEvent(input: NewRunEvent): RunEventRow;
  listRunEvents(runId: string): RunEventRow[];
}

export function createLedger(db: Database.Database, deps: LedgerDeps = {}): Ledger {
  const ids = deps.ids ?? defaultIds;
  const ts = () => (deps.now ?? (() => new Date()))().toISOString();

  const getMetaSession = (id: string) =>
    db
      .prepare(
        "SELECT id, objective, status, repo_root, version, created_at, updated_at FROM meta_session WHERE id = ?",
      )
      .get(id) as MetaSessionRow | undefined;

  const getRun = (id: string) =>
    db
      .prepare(
        `SELECT id, meta_session_id, state, failure_code, trust_profile, request_hash, client_id, idempotency_key,
                version, created_at, updated_at FROM run WHERE id = ?`,
      )
      .get(id) as RunRow | undefined;

  const listRunEvents = (runId: string) =>
    db
      .prepare(
        "SELECT id, run_id, seq, ts, type, payload_json, artifact_id FROM run_event WHERE run_id = ? ORDER BY seq",
      )
      .all(runId) as RunEventRow[];

  return {
    getMetaSession,
    getRun,
    listRunEvents,

    createMetaSession(input) {
      const id = ids.id("sess");
      const now = ts();
      db.prepare(
        `INSERT INTO meta_session (id, objective, constraints_json, repo_root, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      ).run(id, input.objective, JSON.stringify(input.constraints ?? []), input.repoRoot ?? null, now, now);
      return getMetaSession(id) as MetaSessionRow;
    },

    createRun(input) {
      const id = ids.id("run");
      const now = ts();
      db.prepare(
        `INSERT INTO run (id, meta_session_id, state, trust_profile, policy_snapshot_json, request_json, request_hash,
                          client_id, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.metaSessionId,
        input.state ?? "QUEUED",
        input.trustProfile,
        JSON.stringify(input.policySnapshot),
        JSON.stringify(input.request),
        input.requestHash,
        input.clientId,
        input.idempotencyKey ?? null,
        now,
        now,
      );
      return getRun(id) as RunRow;
    },

    appendRunEvent(input) {
      const id = ids.id("evt");
      const append = db.transaction((): RunEventRow => {
        const row = db
          .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_event WHERE run_id = ?")
          .get(input.runId) as {
          next: number;
        };
        const payload = JSON.stringify(input.payload ?? {});
        const when = ts();
        db.prepare(
          "INSERT INTO run_event (id, run_id, seq, ts, type, payload_json, artifact_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(id, input.runId, row.next, when, input.type, payload, input.artifactId ?? null);
        return {
          id,
          run_id: input.runId,
          seq: row.next,
          ts: when,
          type: input.type,
          payload_json: payload,
          artifact_id: input.artifactId ?? null,
        };
      });
      return append.immediate();
    },
  };
}
