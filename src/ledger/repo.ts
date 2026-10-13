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

/** `artifact` row (LLD §1). */
export interface ArtifactRow {
  id: string;
  run_id: string | null;
  meta_session_id: string | null;
  kind: ArtifactKind;
  sha256: string;
  size_bytes: number;
  media_type: string;
  created_at: string;
  deleted_at: string | null;
}

/**
 * `usage_observation` input (LLD §1, FR-CAP-01). Proposed (Delegated): until the M6 estimator exists the only writable
 * source is `provider_reported`; `controller_estimated` is reserved by the schema CHECK but this repo refuses it, so an
 * estimate can never be stored as, or next to, a reported figure by accident.
 */
export interface NewUsageObservation {
  runId: string;
  provider: string;
  harness: string;
  backingProvider?: string | null;
  model?: string | null;
  source: "provider_reported";
  metrics: Record<string, number | string | null>;
}

export interface UsageObservationRow {
  id: string;
  run_id: string | null;
  provider: string;
  harness: string;
  backing_provider: string | null;
  model: string | null;
  source: "provider_reported" | "controller_estimated";
  metrics_json: string;
  observed_at: string;
}

/** `route_decision` row (LLD §1; M2 writes eligibility only). JSON columns are pre-serialised by the router. */
export interface NewRouteDecision {
  runId: string;
  features_json: string;
  candidates_json: string;
  selected_provider: string | null;
  reasons_json: string;
  weights_json?: string | null;
}

export interface RouteDecisionRow {
  id: string;
  run_id: string;
  features_json: string;
  weights_json: string | null;
  candidates_json: string;
  selected_provider: string | null;
  reasons_json: string;
  created_at: string;
}

/** `provider_binding` row (LLD §1, ADR-0001): a provider-native session bound to a meta-session. */
export interface ProviderBindingRow {
  id: string;
  meta_session_id: string;
  provider: string;
  harness: string;
  backing_provider: string | null;
  model: string | null;
  native_session_id: string;
  created_at: string;
  last_used_at: string;
}

export interface NewProviderBinding {
  metaSessionId: string;
  provider: string;
  nativeSessionId: string;
  model?: string | null;
}

/** A meta-session eligible for retention GC (T3.12, Proposed per Q-18). */
export interface GcCandidate {
  id: string;
  repo_root: string | null;
  /** Newest of the session's own `updated_at` and each run's `created_at` / `updated_at` / `finished_at`. */
  last_activity: string;
  /** Newest run (for the GC intent / outcome events, which `run_event` can only attach to a run), if any. */
  newest_run_id: string | null;
}

export interface GcSessionTargets {
  /** Recorded worktree paths of the session's runs. */
  worktreePaths: string[];
  /** Recorded `switchboard/<sess>/...` branch names (run rows and checkpoints), de-duplicated. */
  branches: string[];
}

export interface GcArtifactPlan {
  /** Live (not deleted) artifact rows owned by the session. */
  artifactIds: string[];
  /** Hashes referenced by no live row outside this session: their files may be deleted. */
  deletableHashes: string[];
  /** Hashes still referenced by a live row of another session: files must stay. */
  keptHashes: string[];
}

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

  // ---- T2.4 additions (MCP read model, route decisions, native session bindings) -------------------------------
  /** Events with `seq > afterSeq`, ascending, at most `limit`. */
  listRunEventsAfter(runId: string, afterSeq: number, limit: number): RunEventRow[];
  /** Artifacts of a run that retention GC has not deleted, oldest first. */
  listArtifactsForRun(runId: string): ArtifactRow[];
  /** Append-only route decision (FR-RTE-03). Returns the new id. */
  insertRouteDecision(input: NewRouteDecision): string;
  /** Latest route decision recorded for a run. */
  getRouteDecision(runId: string): RouteDecisionRow | undefined;
  /** Append one provider-reported usage observation (append-only table, FR-CAP-01). Returns the new id. */
  insertUsageObservation(input: NewUsageObservation): string;
  /** Observations of a run, oldest first. */
  listUsageObservationsForRun(runId: string): UsageObservationRow[];
  /**
   * Record (or refresh `last_used_at` of) a provider-native session for a meta-session (FR-SES-02, FR-SES-03). The id
   * comes from structured provider output only (FR-ADP-04).
   */
  recordProviderBinding(input: NewProviderBinding): void;
  /** Most recently used binding of a meta-session, optionally for one provider. */
  latestProviderBinding(metaSessionId: string, provider?: string): ProviderBindingRow | undefined;

  // ---- T3.12 additions (retention GC) --------------------------------------------------------------------------
  /**
   * ACTIVE meta-sessions holding no lease whose runs are all terminal and whose newest activity is older than
   * `cutoffIso`. GC's own `gc_*` events are not activity (they live in `run_event`, which is not consulted).
   */
  listGcCandidates(cutoffIso: string): GcCandidate[];
  /** Recorded worktree paths and `switchboard/<sessionId>/` branches of a meta-session. */
  gcSessionTargets(sessionId: string): GcSessionTargets;
  /** Which of the session's live artifact hashes are safe to delete from disk (content is shared across runs). */
  gcArtifactPlan(sessionId: string): GcArtifactPlan;
  /**
   * One transaction: set `deleted_at` on the session's live artifact rows, mark the meta-session `ARCHIVED` and append
   * the outcome event (when the session has a run to attach it to). `run_event` rows are never touched (append-only).
   */
  completeGc(sessionId: string, at: string, outcome: { runId: string | null; payload: unknown }): void;
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

    listRunEventsAfter(runId, afterSeq, limit) {
      return db
        .prepare(
          `SELECT id, run_id, seq, ts, type, payload_json, artifact_id FROM run_event
           WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
        )
        .all(runId, afterSeq, limit) as RunEventRow[];
    },

    listArtifactsForRun(runId) {
      return db
        .prepare(
          `SELECT id, run_id, meta_session_id, kind, sha256, size_bytes, media_type, created_at, deleted_at
           FROM artifact WHERE run_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
        )
        .all(runId) as ArtifactRow[];
    },

    insertRouteDecision(input) {
      const id = ids.id("rte");
      db.prepare(
        `INSERT INTO route_decision (id, run_id, features_json, weights_json, candidates_json, selected_provider,
                                     reasons_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.runId,
        input.features_json,
        input.weights_json ?? null,
        input.candidates_json,
        input.selected_provider,
        input.reasons_json,
        ts(),
      );
      return id;
    },

    insertUsageObservation(input) {
      if ((input.source as string) !== "provider_reported") {
        throw new Error("usage_observation accepts only provider_reported rows (FR-CAP-01)");
      }
      const id = ids.id("use");
      db.prepare(
        `INSERT INTO usage_observation (id, run_id, provider, harness, backing_provider, model, source, metrics_json,
                                        observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.runId,
        input.provider,
        input.harness,
        input.backingProvider ?? null,
        input.model ?? null,
        input.source,
        JSON.stringify(input.metrics),
        ts(),
      );
      return id;
    },

    listUsageObservationsForRun(runId) {
      return db
        .prepare(
          `SELECT id, run_id, provider, harness, backing_provider, model, source, metrics_json, observed_at
           FROM usage_observation WHERE run_id = ? ORDER BY observed_at, id`,
        )
        .all(runId) as UsageObservationRow[];
    },

    getRouteDecision(runId) {
      return db
        .prepare("SELECT * FROM route_decision WHERE run_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
        .get(runId) as RouteDecisionRow | undefined;
    },

    recordProviderBinding(input) {
      const now = ts();
      db.prepare(
        `INSERT INTO provider_binding (id, meta_session_id, provider, harness, model, native_session_id, created_at,
                                       last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (meta_session_id, provider, native_session_id) DO UPDATE SET last_used_at = excluded.last_used_at,
           model = COALESCE(excluded.model, provider_binding.model)`,
      ).run(
        ids.id("pbd"),
        input.metaSessionId,
        input.provider,
        input.provider,
        input.model ?? null,
        input.nativeSessionId,
        now,
        now,
      );
    },

    latestProviderBinding(metaSessionId, provider) {
      const sql = `SELECT * FROM provider_binding WHERE meta_session_id = ?${provider === undefined ? "" : " AND provider = ?"}
                   ORDER BY last_used_at DESC, rowid DESC LIMIT 1`;
      const args = provider === undefined ? [metaSessionId] : [metaSessionId, provider];
      return db.prepare(sql).get(...args) as ProviderBindingRow | undefined;
    },

    listGcCandidates(cutoffIso) {
      return db
        .prepare(
          `SELECT m.id AS id, m.repo_root AS repo_root,
                  (SELECT id FROM run WHERE meta_session_id = m.id ORDER BY created_at DESC, id DESC LIMIT 1)
                    AS newest_run_id,
                  MAX(m.updated_at, COALESCE((SELECT MAX(MAX(r.created_at, r.updated_at, COALESCE(r.finished_at, '')))
                                              FROM run r WHERE r.meta_session_id = m.id), '')) AS last_activity
           FROM meta_session m
           WHERE m.status = 'ACTIVE' AND m.lease_run_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM run r WHERE r.meta_session_id = m.id
                             AND r.state NOT IN ('SUCCEEDED','FAILED','CANCELLED'))
             AND MAX(m.updated_at, COALESCE((SELECT MAX(MAX(r.created_at, r.updated_at, COALESCE(r.finished_at, '')))
                                             FROM run r WHERE r.meta_session_id = m.id), '')) < ?
           ORDER BY last_activity, m.id`,
        )
        .all(cutoffIso) as GcCandidate[];
    },

    gcSessionTargets(sessionId) {
      const prefix = `switchboard/${sessionId}/`;
      const runs = db.prepare("SELECT worktree_path, branch FROM run WHERE meta_session_id = ?").all(sessionId) as {
        worktree_path: string | null;
        branch: string | null;
      }[];
      const cps = db.prepare("SELECT branch FROM workspace_checkpoint WHERE meta_session_id = ?").all(sessionId) as {
        branch: string;
      }[];
      const worktreePaths = [...new Set(runs.flatMap((r) => (r.worktree_path ? [r.worktree_path] : [])))];
      const branches = [
        ...new Set([...runs.map((r) => r.branch), ...cps.map((c) => c.branch)].filter((b): b is string => !!b)),
      ].filter((b) => b.startsWith(prefix));
      return { worktreePaths, branches };
    },

    gcArtifactPlan(sessionId) {
      const own = db
        .prepare(
          `SELECT id, sha256 FROM artifact WHERE deleted_at IS NULL
             AND (meta_session_id = ? OR run_id IN (SELECT id FROM run WHERE meta_session_id = ?))`,
        )
        .all(sessionId, sessionId) as { id: string; sha256: string }[];
      const ownIds = new Set(own.map((a) => a.id));
      const hashes = [...new Set(own.map((a) => a.sha256))];
      const stillLive = db.prepare("SELECT id FROM artifact WHERE sha256 = ? AND deleted_at IS NULL");
      const deletableHashes: string[] = [];
      const keptHashes: string[] = [];
      for (const h of hashes) {
        const others = (stillLive.all(h) as { id: string }[]).filter((r) => !ownIds.has(r.id));
        (others.length === 0 ? deletableHashes : keptHashes).push(h);
      }
      return { artifactIds: [...ownIds], deletableHashes, keptHashes };
    },

    completeGc(sessionId, at, outcome) {
      immediate(() => {
        db.prepare(
          `UPDATE artifact SET deleted_at = ? WHERE deleted_at IS NULL
             AND (meta_session_id = ? OR run_id IN (SELECT id FROM run WHERE meta_session_id = ?))`,
        ).run(at, sessionId, sessionId);
        db.prepare(
          "UPDATE meta_session SET status = 'ARCHIVED', version = version + 1, updated_at = ? WHERE id = ?",
        ).run(at, sessionId);
        if (outcome.runId !== null) insertEvent(outcome.runId, "gc_outcome", outcome.payload, at);
      });
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
