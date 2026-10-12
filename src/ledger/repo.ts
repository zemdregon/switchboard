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
  /** Adapter id chosen at admission (T1.8; M1 has no router). */
  provider?: string | null;
  /** Higher dispatches first (LLD §1 `run.priority`, default 1). */
  priority?: number;
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

/** Every `run` column the lifecycle reads (T1.8). */
export interface RunRecord extends RunRow {
  parent_run_id: string | null;
  attempt: number;
  failure_detail: string | null;
  provider: string | null;
  model: string | null;
  policy_snapshot_json: string;
  request_json: string;
  priority: number;
  worktree_path: string | null;
  branch: string | null;
  base_checkpoint_id: string | null;
  post_checkpoint_id: string | null;
  pid: number | null;
  pgid: number | null;
  proc_start_ticks: number | null;
  exit_code: number | null;
  exit_signal: string | null;
  next_attempt_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

/** Mutable `run` columns a transition may set alongside the state (state and version are managed by the helper). */
export interface RunFieldPatch {
  failure_code?: string | null;
  failure_detail?: string | null;
  provider?: string | null;
  model?: string | null;
  pid?: number | null;
  pgid?: number | null;
  proc_start_ticks?: number | null;
  exit_code?: number | null;
  exit_signal?: string | null;
  next_attempt_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

const PATCHABLE: readonly (keyof RunFieldPatch)[] = [
  "failure_code",
  "failure_detail",
  "provider",
  "model",
  "pid",
  "pgid",
  "proc_start_ticks",
  "exit_code",
  "exit_signal",
  "next_attempt_at",
  "started_at",
  "finished_at",
];

export interface CasRunState {
  runId: string;
  from: RunState;
  to: RunState;
  /** Optimistic guard (LLD §10): the update applies only if `version` still equals this. */
  expectedVersion: number;
  set?: RunFieldPatch;
  /** Payload of the `state_transition` event appended in the same transaction. */
  payload?: Record<string, unknown>;
}

export type ArtifactKind =
  | "provider_stdout"
  | "provider_stderr"
  | "diff"
  | "test_report"
  | "changed_files"
  | "log_summary"
  | "handoff_view";

export interface NewArtifactRow {
  runId: string | null;
  metaSessionId: string | null;
  kind: ArtifactKind;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
}

export interface LeaseRow {
  meta_session_id: string;
  lease_run_id: string;
  lease_expires_at: string | null;
}

export type CheckpointKind = "base" | "pre" | "post";

export interface Ledger {
  createMetaSession(input: NewMetaSession): MetaSessionRow;
  getMetaSession(id: string): MetaSessionRow | undefined;
  createRun(input: NewRun): RunRow;
  getRun(id: string): RunRow | undefined;
  /** Append the next event for a run: `seq` is per-run, gapless, starting at 1 (LLD §1). */
  appendRunEvent(input: NewRunEvent): RunEventRow;
  listRunEvents(runId: string): RunEventRow[];

  // ---- T1.8 additions ------------------------------------------------------------------------------------------
  /** Run `fn` in one `BEGIN IMMEDIATE` transaction (savepoint when nested). */
  immediate<T>(fn: () => T): T;
  getRunRecord(id: string): RunRecord | undefined;
  /**
   * Compare-and-set state transition plus its `state_transition` event in one transaction (LLD §10). Returns the
   * updated row, or `undefined` (nothing written) when the run is no longer in `from` at `expectedVersion`. Does not
   * know the FRD edges; callers guard legality first.
   */
  casRunState(input: CasRunState): RunRecord | undefined;
  /** Update non-state columns and append one event, in one transaction. Returns false if the run does not exist. */
  updateRunFields(runId: string, set: RunFieldPatch, event: { type: string; payload?: unknown }): boolean;
  findRunByIdempotencyKey(clientId: string, key: string): RunRecord | undefined;
  countRunsInStates(states: readonly RunState[], provider?: string): number;
  /** Runs in `state`, highest priority first, then oldest (`created_at`, then ULID order). */
  listRunsInState(state: RunState): RunRecord[];
  listRunsForMetaSession(metaSessionId: string): RunRecord[];
  setMetaSessionHead(metaSessionId: string, commit: string): void;
  insertArtifact(input: NewArtifactRow): string;

  // ---- T1.9 additions ------------------------------------------------------------------------------------------
  /** Every meta-session currently holding a write lease (LLD §5). */
  listLeases(): LeaseRow[];
  /** Commit of the run's first checkpoint of `kind` (the one the workspace manager uses), if any. */
  getRunCheckpointCommit(runId: string, kind: CheckpointKind): string | undefined;
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

  const RUN_RECORD_SQL = "SELECT * FROM run";
  const getRunRecord = (id: string) => db.prepare(`${RUN_RECORD_SQL} WHERE id = ?`).get(id) as RunRecord | undefined;

  /** Insert the next event inside the caller's transaction. */
  const insertEvent = (runId: string, type: string, payload: unknown, when: string): void => {
    const row = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_event WHERE run_id = ?").get(runId) as {
      next: number;
    };
    db.prepare("INSERT INTO run_event (id, run_id, seq, ts, type, payload_json) VALUES (?, ?, ?, ?, ?, ?)").run(
      ids.id("evt"),
      runId,
      row.next,
      when,
      type,
      JSON.stringify(payload ?? {}),
    );
  };

  const patchSql = (set: RunFieldPatch): { cols: string; values: unknown[] } => {
    const keys = PATCHABLE.filter((k) => set[k] !== undefined);
    return { cols: keys.map((k) => `, ${k} = ?`).join(""), values: keys.map((k) => set[k]) };
  };

  const immediate = <T>(fn: () => T): T => db.transaction(fn).immediate();

  return {
    getMetaSession,
    getRun,
    listRunEvents,
    immediate,
    getRunRecord,

    casRunState(input) {
      return immediate(() => {
        const when = ts();
        const { cols, values } = patchSql(input.set ?? {});
        const res = db
          .prepare(
            `UPDATE run SET state = ?, version = version + 1, updated_at = ?${cols}
             WHERE id = ? AND version = ? AND state = ?`,
          )
          .run(input.to, when, ...values, input.runId, input.expectedVersion, input.from);
        if (res.changes !== 1) return undefined;
        insertEvent(input.runId, "state_transition", { from: input.from, to: input.to, ...input.payload }, when);
        return getRunRecord(input.runId);
      });
    },

    updateRunFields(runId, set, event) {
      return immediate(() => {
        const when = ts();
        const { cols, values } = patchSql(set);
        const res = db
          .prepare(`UPDATE run SET version = version + 1, updated_at = ?${cols} WHERE id = ?`)
          .run(when, ...values, runId);
        if (res.changes !== 1) return false;
        insertEvent(runId, event.type, event.payload, when);
        return true;
      });
    },

    findRunByIdempotencyKey(clientId, key) {
      return db.prepare(`${RUN_RECORD_SQL} WHERE client_id = ? AND idempotency_key = ?`).get(clientId, key) as
        | RunRecord
        | undefined;
    },

    countRunsInStates(states, provider) {
      if (states.length === 0) return 0;
      const marks = states.map(() => "?").join(", ");
      const sql = `SELECT COUNT(*) AS n FROM run WHERE state IN (${marks})${provider === undefined ? "" : " AND provider = ?"}`;
      const args: unknown[] = provider === undefined ? [...states] : [...states, provider];
      return (db.prepare(sql).get(...args) as { n: number }).n;
    },

    listRunsInState(state) {
      return db
        .prepare(`${RUN_RECORD_SQL} WHERE state = ? ORDER BY priority DESC, created_at, id`)
        .all(state) as RunRecord[];
    },

    listRunsForMetaSession(metaSessionId) {
      return db
        .prepare(`${RUN_RECORD_SQL} WHERE meta_session_id = ? ORDER BY created_at, id`)
        .all(metaSessionId) as RunRecord[];
    },

    setMetaSessionHead(metaSessionId, commit) {
      db.prepare("UPDATE meta_session SET head_commit = ?, version = version + 1, updated_at = ? WHERE id = ?").run(
        commit,
        ts(),
        metaSessionId,
      );
    },

    insertArtifact(input) {
      const id = ids.id("art");
      db.prepare(
        `INSERT INTO artifact (id, run_id, meta_session_id, kind, sha256, size_bytes, media_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.runId, input.metaSessionId, input.kind, input.sha256, input.sizeBytes, input.mediaType, ts());
      return id;
    },

    listLeases() {
      return db
        .prepare(
          `SELECT id AS meta_session_id, lease_run_id, lease_expires_at FROM meta_session
           WHERE lease_run_id IS NOT NULL ORDER BY id`,
        )
        .all() as LeaseRow[];
    },

    getRunCheckpointCommit(runId, kind) {
      const row = db
        .prepare("SELECT commit_sha FROM workspace_checkpoint WHERE run_id = ? AND kind = ? ORDER BY rowid LIMIT 1")
        .get(runId, kind) as { commit_sha: string } | undefined;
      return row?.commit_sha;
    },

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
                          client_id, idempotency_key, provider, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.provider ?? null,
        input.priority ?? 1,
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
