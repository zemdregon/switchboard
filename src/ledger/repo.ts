import type Database from "better-sqlite3";
import { approvalCausePrefix, type DecisionInput, renderDecisionSummary } from "../continuity/decisions.js";
import { deriveOpenWork, type OpenWorkRun } from "../continuity/open-work.js";
import { defaultIds, type IdGenerator } from "../ids/index.js";
import { type ControlPlaneLedgerSlice, createControlPlaneLedgerSlice } from "./control-plane.js";
import { DecisionRefusedError } from "./errors.js";
import { createScheduleLedgerSlice, type ScheduleLedgerSlice } from "./schedule.js";
import {
  createWorkQueueLedgerSlice,
  type EnqueueWorkItemInput,
  type WorkItemRow,
  type WorkListFilter,
} from "./work-queue.js";

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
  /** Project the meta-session was created in (FR-PRJ-03); NULL when delegated by workspace path. Fixed for life. */
  project_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface NewMetaSession {
  objective: string;
  repoRoot?: string | null;
  /** Project the meta-session belongs to (FR-PRJ-03). Omit for a workspace-path session. */
  projectId?: string | null;
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
  /** Project of the run (FR-PRJ-03); NULL for a workspace-path run. */
  project_id: string | null;
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
  /**
   * T7.14 fix (FR-RTE-10, LLD §17.7 Run fields): the requested/resolved model the run uses
   * (`request_json.model`); null when no model was requested, so the adapter default applies.
   */
  model?: string | null;
  /** Higher dispatches first (LLD §1 `run.priority`, default 1). */
  priority?: number;
  /** Project of the run (FR-PRJ-03); must equal the meta-session's. */
  projectId?: string | null;
  /** T6.5 (FR-MCP-10, LLD §16.5): the failed run a retry or failover successor follows. */
  parentRunId?: string | null;
  /** T6.5: attempt number (default 1); a successor has its parent's plus one. */
  attempt?: number;
  /** T6.5: when a `WAITING_CAPACITY` successor becomes due (ISO 8601). */
  nextAttemptAt?: string | null;
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

/** T14.1: filter for `listRunsForClient`. `since` is inclusive and `until` exclusive, both on `created_at` (ISO). */
export interface RunListFilter {
  clientId: string;
  projectId?: string;
  states?: readonly RunState[];
  since?: string;
  until?: string;
  before?: { createdAt: string; id: string };
  limit: number;
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

// ---- Retention GC predicates (T3.12, R-42). Aliases: `m` = meta_session. The one `?` is the cutoff (ISO). ----
const NEWEST_RUN_SQL = "(SELECT id FROM run WHERE meta_session_id = m.id ORDER BY created_at DESC, id DESC LIMIT 1)";
const LAST_ACTIVITY_SQL = `MAX(m.updated_at, COALESCE((SELECT MAX(MAX(r.created_at, r.updated_at, COALESCE(r.finished_at, '')))
                                              FROM run r WHERE r.meta_session_id = m.id), ''))`;
const IDLE_EXPIRED_SQL = `m.status = 'ACTIVE' AND m.lease_run_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM run r WHERE r.meta_session_id = m.id
                             AND r.state NOT IN ('SUCCEEDED','FAILED','CANCELLED'))
             AND ${LAST_ACTIVITY_SQL} < ?`;
// Marked ARCHIVED by beginGc but not finished: the newest GC event is the intent, or live artifact rows remain.
// Contains no placeholder; SQLite binds the one `?` of IDLE_EXPIRED_SQL only.
const GC_PENDING_SQL = `m.status = 'ARCHIVED' AND (
               (SELECT e.type FROM run_event e WHERE e.run_id = ${NEWEST_RUN_SQL}
                  AND e.type IN ('gc_intent','gc_outcome') ORDER BY e.seq DESC LIMIT 1) = 'gc_intent'
               OR EXISTS (SELECT 1 FROM artifact a WHERE a.deleted_at IS NULL
                  AND (a.meta_session_id = m.id OR a.run_id IN (SELECT id FROM run WHERE meta_session_id = m.id))))`;

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
  | "handoff_view"
  | "pr_draft" // T11.8, migration 0009
  | "handoff_condense" // T11.10, migration 0016
  | "seed_log"; // T9.13, migration 0022

export interface NewArtifactRow {
  /** Pre-allocated with {@link Ledger.newArtifactId} when a row written first must name it (T5.5, LLD §15.2). */
  id?: string;
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
  source: "provider_reported" | "controller_estimated" | "inner_agent";
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

/** T6.2 (LLD §16.2): a terminal run as the capacity estimator sees it. */
export interface CapacityRunRow {
  id: string;
  state: RunState;
  failure_code: string | null;
  failure_detail: string | null;
  started_at: string | null;
  finished_at: string;
}

/** T6.2 (LLD §16.2): a provider-reported `rate_limit` signal (the bounded `compactEvent` payload). */
export interface RateLimitSignalRow {
  ts: string;
  reset_at: string | null;
}

/** T6.2 (LLD §16.2): a `provider_reported` usage row of one provider (metrics as stored). */
export interface ProviderUsageRow {
  metrics_json: string;
  observed_at: string;
}

/** T14.4 (FR-CTL-06): a non-terminal run's wall clock, for the `wall_clock_per_run` budget. */
export interface OpenRunClockRow {
  id: string;
  state: RunState;
  started_at: string | null;
}

/** T6.7 (FR-CAP-08): a run that started a provider process, as the switch counter sees it. */
export interface StartedRunRow {
  id: string;
  provider: string;
  model: string | null;
  project_id: string | null;
  request_json: string;
  created_at: string;
}

/** `provider_health` (LLD §1); M6 reads and writes only the breaker columns (LLD §16.4). */
export interface ProviderHealthRow {
  provider: string;
  breaker_state: "CLOSED" | "OPEN" | "HALF_OPEN";
  breaker_until: string | null;
  consecutive_failures: number;
  last_failure_code: string | null;
  updated_at: string;
  version: number;
}

/** T7.4 (LLD §3.2, §17.6): the closed `affinity_switch_reason` list (FR-RTE-07). */
export const AFFINITY_SWITCH_REASONS = [
  "user_request",
  "capacity_exhausted",
  "ineligible",
  "failed_after_retry",
] as const;
export type AffinitySwitchReason = (typeof AFFINITY_SWITCH_REASONS)[number];

/** `project_affinity` row (migration 0014). */
export interface ProjectAffinityRow {
  project_key: string;
  provider: string;
  model: string | null;
  since: string;
  last_run_id: string | null;
  last_switch_reason: AffinitySwitchReason | null;
  reset_requested_at: string | null;
  reset_by: string | null;
  updated_at: string;
  version: number;
}

/** What a succeeded run writes into its project's row (LLD §17.6). */
export interface AffinityWrite {
  projectKey: string;
  provider: string;
  model: string | null;
  lastRunId: string;
  /** The decision's reason, or null for a first run or a held affinity. */
  reason: AffinitySwitchReason | null;
  /** The row version the caller read (`undefined` when it read no row); a mismatch writes nothing. */
  expectedVersion: number | undefined;
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

/**
 * Set at INSERT from the run's `session_bound` event (FR-ADP-10, T5.3) and never updated afterwards: a conflicting
 * insert (the same native session bound again by a resume) refreshes `last_used_at` only.
 */
export interface NewProviderBinding {
  metaSessionId: string;
  provider: string;
  nativeSessionId: string;
  /** The harness; defaults to `provider` (LLD §1: it equals the provider unless fronted, and no adapter reports another). */
  harness?: string;
  /** The actual backing vendor when the adapter reported one. */
  backingProvider?: string | null;
  model?: string | null;
}

/** The `meta_session` columns the handoff bundle reads (T5.4; LLD §15.1). Never `open_work_json` (LLD §15.3). */
export interface MetaSessionContinuityRow {
  id: string;
  objective: string;
  constraints_json: string;
  repo_root: string | null;
  base_commit: string | null;
  head_commit: string | null;
}

/** `decision` row (LLD §1, append-only). */
export interface DecisionRow {
  id: string;
  meta_session_id: string;
  run_id: string | null;
  decision: string;
  reason_summary: string;
  created_at: string;
}

/** One verification command of a run, from its `verification_command` events (argv from the stored request). */
export interface RunVerificationResult {
  index: number;
  outcome: string;
  exit_code: number | null;
  argv: string[] | null;
}

/**
 * What a terminal run left behind, from existing run records only (T5.3; LLD §15.1 sources): the changed-files count and
 * artifact, the post-run checkpoint commit and the verification results. Content stays in the artifacts and in Git.
 */
export interface RunOutcomeRecord {
  run_id: string;
  state: "SUCCEEDED" | "FAILED" | "CANCELLED";
  failure_code: string | null;
  provider: string | null;
  created_at: string;
  finished_at: string | null;
  /** Commit of the run's first `post` checkpoint, if one was recorded. */
  post_commit: string | null;
  /** `changed_files` count of the terminal record (0 when it carries none). */
  changed_files: number;
  /** Artifact ids named by the terminal record (`changed_files`, `diff`, `test_report`), when present. */
  changed_files_artifact_id: string | null;
  diff_artifact_id: string | null;
  test_report_artifact_id: string | null;
  verification: RunVerificationResult[];
  nested_repositories_skipped: number;
  git_policy_violation: boolean;
}

/** The terminal runs of a meta-session with the session's base and head commits (T5.3). */
export interface MetaSessionOutcomes {
  meta_session_id: string;
  base_commit: string | null;
  head_commit: string | null;
  /** Terminal runs in `(created_at, id)` order. */
  runs: RunOutcomeRecord[];
}

/** A meta-session eligible for retention GC (T3.12, Proposed per Q-18). */
export interface GcCandidate {
  id: string;
  repo_root: string | null;
  /** Newest of the session's own `updated_at` and each run's `created_at` / `updated_at` / `finished_at`. */
  last_activity: string;
  /** Newest run (for the GC intent / outcome events, which `run_event` can only attach to a run), if any. */
  newest_run_id: string | null;
  /** True for an `ARCHIVED` session whose collection began earlier and must roll forward (no cutoff applies). */
  resume: boolean;
}

export interface GcSessionTargets {
  /** Recorded worktree paths of the session's runs. */
  worktreePaths: string[];
  /** Recorded `switchboard/<sess>/...` branch names (run rows and checkpoints), de-duplicated. */
  branches: string[];
  /** Ids of the session's runs: their `container` environment containers carry them as a label (T10.3, FR-PRJ-09). */
  runIds: string[];
}

export interface GcArtifactPlan {
  /** Live (not deleted) artifact rows owned by the session. */
  artifactIds: string[];
  /** Hashes referenced by no live row outside this session: their files may be deleted. */
  deletableHashes: string[];
  /** Hashes still referenced by a live row of another session: files must stay. */
  keptHashes: string[];
}

/** `approval.status` (LLD §1). The controller never writes `EXPIRED` (no expiry: WF-7, owner decision 17). */
export type ApprovalStatus = "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";

/** `approval` row (LLD §1, §3.1): one per meta-session in M3, created by its first `privileged` run. */
export interface ApprovalRow {
  id: string;
  /** The run that requested the approval (the meta-session's first `privileged` run). */
  run_id: string;
  /** Canonical `privileged_scope` (LLD §3.1). */
  scope_json: string;
  /** v2 hash over client, meta-session and scope (LLD §3.1). */
  scope_hash: string;
  status: ApprovalStatus;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export interface NewApproval {
  /** Pre-allocated with {@link Ledger.newApprovalId} when the run's policy snapshot must name it (LLD §3.1). */
  id?: string;
  runId: string;
  scopeJson: string;
  scopeHash: string;
}

export interface ApprovalDecision {
  id: string;
  status: "APPROVED" | "DENIED";
  /** OS user of the operator CLI, or the cancel source when a waiting run is cancelled (ROADMAP Q-15, Proposed). */
  decidedBy: string;
  /**
   * When the operator decided (ISO 8601); defaults to now. T3.4: the time the operator CLI recorded the decision, which
   * precedes its application when `serve` or startup reconciliation applies it later.
   */
  decidedAt?: string;
}

/** One `git_commit` row (FR-GIT-07; LLD §1 "M9 additions"). Append-only: rows are never updated or deleted. */
export interface GitCommitRow {
  id: string;
  commit_sha: string;
  tree_sha: string;
  patch_id: string | null;
  repo_root: string;
  publish_ref: string;
  project_id: string;
  context_id: string;
  meta_session_id: string;
  run_id: string;
  provider: string;
  harness: string;
  model: string | null;
  adapter_version_id: string | null;
  origin: "commit_tool" | "finalize_only";
  tool_event_id: string | null;
  sanitizer_json: string;
  created_at: string;
  /** T11.4 (migration 0007, LLD §12.7): `inner` when the inner agent drafted the message; `agent` otherwise. */
  message_source: "agent" | "inner";
  /** T11.4: the `inner_call` row of the accepted draft; NULL for an agent message. */
  inner_call_id: string | null;
}

/** Everything `recordGitCommit` needs. `id`, `tool_event_id` and `created_at` are assigned by the ledger. */
export interface NewGitCommit {
  commitSha: string;
  treeSha: string;
  patchId?: string | null;
  repoRoot: string;
  publishRef: string;
  projectId: string;
  contextId: string;
  metaSessionId: string;
  runId: string;
  provider: string;
  harness: string;
  model?: string | null;
  adapterVersionId?: string | null;
  origin: "commit_tool" | "finalize_only";
  /** `{ "rules": { "<rule id>": <count> } }`: rule ids and counts only, never removed text. */
  sanitizer: unknown;
  /** Payload of the `git_commit` run event written in the same transaction (bounded: SHAs, counts, rule ids). */
  eventPayload: unknown;
  /** T11.4 (LLD §12.7): default `agent`. */
  messageSource?: "agent" | "inner";
  /** T11.4: only with `messageSource: "inner"` (the column CHECK refuses it otherwise). */
  innerCallId?: string | null;
}

/** One `git_push` row (FR-GIT-05; LLD §1 "M9 additions", §12.6). Append-only. Never holds a URL or Git output. */
export interface GitPushRow {
  id: string;
  /** The calling run for an agent push; NULL for an operator push (LLD §1). */
  run_id: string | null;
  project_id: string;
  context_id: string;
  /** Configured remote NAME (validated as a name, never a URL); empty when the attempt was refused before a valid name existed. */
  remote: string;
  /** Target ref on the remote (`refs/heads/<branch_prefix><sess>`); empty when refused before it could be computed. */
  ref: string;
  /** The publish head that was (or would have been) pushed; empty when there was none. */
  head_sha: string;
  outcome: "ACCEPTED" | "REFUSED_POLICY" | "REJECTED_REMOTE" | "ERROR";
  /** Short reason code from a fixed vocabulary (`src/git/push.ts`); never Git's own output. */
  detail: string | null;
  requested_by: "agent_tool" | "operator";
  created_at: string;
}

/** Everything `recordGitPush` needs; `id` and `created_at` are assigned by the ledger. */
export interface NewGitPush {
  runId: string | null;
  /** The run the `git_push` run event is appended to (the calling run, or for an operator push the run of the head commit). */
  eventRunId: string;
  projectId: string;
  contextId: string;
  remote: string;
  ref: string;
  headSha: string;
  outcome: GitPushRow["outcome"];
  detail: string | null;
  requestedBy: GitPushRow["requested_by"];
  /** Payload of the `git_push` run event (bounded; SHAs, names and codes only). `push_id` is added by the ledger. */
  eventPayload: Record<string, unknown>;
}

export type InnerCallOutcome =
  | "accepted"
  | "rejected_validator"
  | "rejected_sanitiser"
  | "fallback_unavailable"
  | "fallback_suspended"
  | "fallback_disabled";

/** One `inner_call` row (T11.2, LLD §13.3). No prompt or response body: sizes and a hash only (FR-INN-16). */
export interface InnerCallRow {
  id: string;
  task: string;
  backend_kind: "http" | "cli";
  model_id: string;
  locality: "local" | "remote";
  template_version: string;
  outcome: InnerCallOutcome;
  reason: string | null;
  attempts: number;
  latency_ms: number;
  tokens_in: number | null;
  tokens_out: number | null;
  input_bytes: number;
  output_bytes: number;
  input_sha256: string;
  run_id: string | null;
  meta_session_id: string | null;
  created_at: string;
}

/** Everything `recordInnerCall` needs; `id` and `created_at` are assigned by the ledger. */
export type NewInnerCall = Omit<InnerCallRow, "id" | "created_at">;

/** Extra run events written in the same transaction as the `inner_call` row, for a call tied to a run (LLD §13.8). */
export interface InnerCallEvents {
  /** Merged into the `inner_call` event payload (for example `title` and `summary` of a `run_title`). */
  callPayload?: Record<string, unknown>;
  artifactId?: string | null;
  /** `inner_degraded` / `inner_task_suspended` events, appended after the `inner_call` event. */
  extra?: { type: string; payload: unknown }[];
  /**
   * `inner_agent.backend.shares_subscription_with` (FR-INN-15, LLD §13.4 step 13). When set and a backend request was
   * actually made (`attempts >= 1`), one `usage_observation` for this provider with `source = 'inner_agent'` is written
   * in the same transaction as the `inner_call` row. Absent or null: nothing is written to `usage_observation`.
   */
  sharedSubscriptionWith?: string | null;
  /**
   * T11.6 (FR-INN-09, LLD §13.4 step 11): the quality window. When set and the recorded outcome is a quality outcome
   * (`accepted`, `rejected_validator`, `rejected_sanitiser`), the ledger evaluates the task's window in the same
   * transaction and suspends the task when at least `minCalls` calls exist and the rejected share exceeds
   * `rejectionThreshold`. Absent: no evaluation (callers that only record).
   */
  suspension?: { windowCalls: number; minCalls: number; rejectionThreshold: number };
}

/** Evidence of a suspension (`inner_task_state.suspended_basis_json`, the `inner_task_suspended` event payload). */
export interface InnerSuspensionBasis {
  window_calls: number;
  rejected: number;
  total: number;
  threshold: number;
}

/** Result of `recordInnerCall`: the row, plus the basis when this very call suspended its task. Not a column. */
export type RecordedInnerCall = InnerCallRow & { suspended_task?: InnerSuspensionBasis };

/** One `inner_task_state` row (T11.6, LLD §13.3), with the basis decoded. */
export interface InnerTaskStateRow {
  task: string;
  suspended: boolean;
  suspended_at: string | null;
  suspended_basis: InnerSuspensionBasis | null;
  resumed_at: string | null;
  version: number;
}

export interface Ledger extends ControlPlaneLedgerSlice, ScheduleLedgerSlice {
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
  /**
   * T14.1 (FR-CTL-01, LLD §3.4.2): one client's runs, newest first (`created_at` descending, then `id` descending),
   * narrowed by the optional filters; `before` is the keyset position of the last row of the previous page. Read-only.
   */
  listRunsForClient(filter: RunListFilter): RunRecord[];
  /** T14.3 (FR-CTL-02, LLD §3.4.3): one `run_event` row by id. Read-only. */
  getRunEvent(id: string): RunEventRow | undefined;
  /**
   * T14.3 (FR-CTL-02, LLD §3.4.3): events of one client's runs in `(ts, id)` order, strictly after `after` when given,
   * at most `limit`. Read-only.
   */
  listRunEventsForClient(filter: {
    clientId: string;
    after?: { ts: string; id: string };
    limit: number;
  }): RunEventRow[];
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
  /** Every binding of a meta-session, oldest first. */
  listProviderBindings(metaSessionId: string): ProviderBindingRow[];

  // ---- T5.3 additions (canonical state across providers, LLD §15.3) ---------------------------------------------------
  /**
   * The ONE writer of the `decision` table (ADR-0038 item 3). Renders the fixed template of `input.kind` from controller
   * values only (a non-controller value throws `DecisionTemplateError`, nothing written), refuses a decision for a
   * terminal or unknown run ({@link DecisionRefusedError}; the ordering rule that fixes the decisions of a bundle's
   * `as_of`), and writes it once per cause: `created: false` and the existing id when this cause already has a row (one per
   * run and kind, except `approval_decided`, one per approval). Call inside the transaction of the event that causes it.
   */
  appendDecision(input: DecisionInput): { id: string; created: boolean };
  /** Decisions of a run, oldest first. */
  listDecisionsForRun(runId: string): DecisionRow[];
  /**
   * Changed files and verification results per meta-session, from run records (T5.3): terminal runs in `(created_at, id)`
   * order with the base and head commits. `undefined` for an unknown meta-session.
   */
  listOutcomesForMetaSession(metaSessionId: string): MetaSessionOutcomes | undefined;
  /** The `open_work_json` projection of a meta-session (LLD §15.3), parsed. `undefined` for an unknown meta-session. */
  getOpenWorkProjection(metaSessionId: string): unknown[] | undefined;
  /** Most recently used binding of a meta-session, optionally for one provider. */
  latestProviderBinding(metaSessionId: string, provider?: string): ProviderBindingRow | undefined;

  // ---- T6.2 additions (capacity estimator inputs, LLD §16.2; read-only) -------------------------------------------
  /** Terminal runs of `provider` whose `finished_at` is at or after `sinceIso`, oldest first. */
  listTerminalRunsForProviderSince(provider: string, sinceIso: string): CapacityRunRow[];
  /** `rate_limit` provider events of `provider`'s runs recorded at or after `sinceIso`, oldest first. */
  listRateLimitSignalsSince(provider: string, sinceIso: string): RateLimitSignalRow[];
  /** `provider_reported` usage rows of `provider` observed at or after `sinceIso`, oldest first (never `inner_agent`). */
  listProviderReportedUsageSince(provider: string, sinceIso: string): ProviderUsageRow[];
  /**
   * T14.4 (FR-CTL-06): run rows created at or after `sinceIso` (every admission that wrote a row, whatever its state);
   * only the runs of `projectId` when it is given.
   */
  countRunsCreatedSince(sinceIso: string, projectId?: string): number;
  /** T14.4: non-terminal runs with their `started_at` (set at LEASED); only the runs of `projectId` when given. */
  listOpenRunClocks(projectId?: string): OpenRunClockRow[];
  /**
   * T14.4: `provider_reported` usage rows observed at or after `sinceIso` across providers, oldest first; only the rows
   * of `projectId`'s runs when it is given (never `inner_agent` or `controller_estimated`).
   */
  listReportedUsageSince(sinceIso: string, projectId?: string): ProviderUsageRow[];
  /**
   * T6.7 (FR-CAP-08): runs created at or after `sinceIso` that started a provider process, oldest first; only the runs
   * of `clientId` when it is given.
   */
  listStartedRunsSince(sinceIso: string, clientId?: string): StartedRunRow[];
  /** T6.6 (LLD §16.6): the provider's most recent `QUOTA_EXHAUSTED` runs, newest first, at most `limit`. */
  listRecentQuotaExhaustedRuns(provider: string, limit: number): RunRecord[];
  /** T6.5 (FR-MCP-10): the run that supersedes `runId` (its retry or failover successor), if any. */
  findSuccessorRun(runId: string): RunRecord | undefined;
  /** The provider's `provider_health` row, if one was written. */
  getProviderHealth(provider: string): ProviderHealthRow | undefined;
  /** T7.4: the project's affinity row, if any. */
  getProjectAffinity(projectKey: string): ProjectAffinityRow | undefined;
  /** T7.4: every affinity row, by project key. */
  listProjectAffinities(): ProjectAffinityRow[];
  /**
   * T7.4 (LLD §17.6): create or update the row with a version check. `since` changes only when the provider changes;
   * a held affinity keeps its last reason; a pending reset is cleared. Returns false (nothing written) when the row's
   * version is not `expectedVersion`, or when a row exists and none was expected.
   */
  writeProjectAffinity(input: AffinityWrite): boolean;
  /** T7.4: record an operator reset on an existing row; false when the project has no row (nothing written). */
  requestAffinityReset(projectKey: string, by: string): boolean;
  /**
   * T7.5 (LLD §17.6): the project's latest terminal run on `provider` that finished after `afterIso`. The project is
   * `projectId`, or with none the runs without a project whose stored request names `workspace`.
   */
  latestProjectRunOnProvider(
    projectId: string | null,
    workspace: string,
    provider: string,
    afterIso: string,
  ): { id: string; state: string; failure_code: string | null } | undefined;
  /**
   * T6.4 (LLD §16.4): write the breaker columns of `provider`'s row, creating it if needed with `auth_state =
   * 'UNKNOWN'` and `version_state = 'UNVERIFIED'` (placeholders nothing reads). Bumps `version`.
   */
  writeProviderBreaker(
    provider: string,
    breaker: {
      state: ProviderHealthRow["breaker_state"];
      until: string | null;
      consecutiveFailures: number;
      lastFailureCode: string | null;
    },
  ): void;

  // ---- T5.4 additions (handoff bundle sources, LLD §15.1 and §15.2; read-only) -------------------------------------
  /** The continuity fields of a meta-session the bundle builder reads (LLD §15.1). `undefined` when unknown. */
  getMetaSessionContinuity(metaSessionId: string): MetaSessionContinuityRow | undefined;
  /** One artifact row by id, deleted by retention GC or not. */
  getArtifact(id: string): ArtifactRow | undefined;
  /** Highest `run_event.seq` of a run; 0 when it has none (the `as_of` watermark, LLD §15.2). */
  maxRunEventSeq(runId: string): number;
  /** Events of a run with `seq <= maxSeq`, ascending (events appended after an `as_of` are not returned). */
  listRunEventsUpTo(runId: string, maxSeq: number): RunEventRow[];

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
   * Mark first (R-42): in one `BEGIN IMMEDIATE` transaction re-check that the session is still an expired idle `ACTIVE`
   * one (no lease, only terminal runs, activity older than `cutoffIso`), set it `ARCHIVED` (admission refuses it from
   * then on) and append the `gc_intent` event (when it has a run). Returns false, writing nothing, when it is no
   * longer idle. A session already `ARCHIVED` with collection pending only gets another intent event (roll-forward).
   */
  beginGc(sessionId: string, cutoffIso: string, at: string, intent: unknown): boolean;
  /**
   * One transaction, after the Git and file steps: set `deleted_at` on the session's live artifact rows and append the
   * outcome event (when the session has a run to attach it to). The session was marked `ARCHIVED` by {@link beginGc}.
   * `run_event` rows are never touched (append-only).
   */
  completeGc(sessionId: string, at: string, outcome: { runId: string | null; payload: unknown }): void;

  // ---- T3.3 additions (privileged approvals, LLD §1 and §3.1) ----------------------------------------------------
  /** A fresh `apv_` id, so a run's policy snapshot can name its approval before the row exists (FK order). */
  newApprovalId(): string;
  /** A fresh `art_` id for {@link NewArtifactRow.id} (T5.5: the handoff run's request names its view). */
  newArtifactId(): string;
  /** Insert a `PENDING` approval row with `requested_at` now. Call inside the admission transaction. */
  createApproval(input: NewApproval): ApprovalRow;
  getApproval(id: string): ApprovalRow | undefined;
  /** The approval a run requested (`approval.run_id`), if any. */
  getApprovalForRun(runId: string): ApprovalRow | undefined;
  /** Approvals, oldest first, optionally of one status. */
  listApprovals(filter?: { status?: ApprovalStatus; limit?: number }): ApprovalRow[];
  /**
   * The approval of a meta-session for one MCP client (LLD §3.1 lookup): joins `approval.run_id` to `run` on the
   * meta-session and client. At most one row exists per meta-session in M3; more than one is an invariant violation and
   * throws (fail closed).
   */
  findApprovalForMetaSession(metaSessionId: string, clientId: string): ApprovalRow | undefined;
  /**
   * Decide a `PENDING` approval (update-once, LLD §1): sets status, `decided_at` (now) and `decided_by`. Returns the
   * updated row, or `undefined` (nothing written) when the row is missing or already decided. Only these three columns
   * are ever updated; `scope_json` and `scope_hash` are never rewritten.
   */
  decideApproval(input: ApprovalDecision): ApprovalRow | undefined;
  /** Runs (oldest first) whose policy snapshot names this approval (`privilegedScope.approvalId`). */
  listRunsCoveredByApproval(approvalId: string): RunRecord[];

  // ---- T9.3 additions (commit provenance, LLD §12.3 and §12.7) ---------------------------------------------------
  /**
   * In ONE `BEGIN IMMEDIATE` transaction append the `git_commit` run event and insert the `git_commit` row that points
   * at it (FR-GIT-07). Idempotent per `(run_id, commit_sha)`: when the row exists nothing is written and `created` is
   * false, which is what crash recovery relies on. A constraint failure rolls both writes back.
   */
  recordGitCommit(input: NewGitCommit): { row: GitCommitRow; created: boolean };
  /** Provenance rows of a run, oldest first. */
  listGitCommits(runId: string): GitCommitRow[];
  /** Provenance rows for one commit SHA, oldest first (the same commit may be recorded by more than one run). */
  findGitCommitsBySha(commitSha: string): GitCommitRow[];

  // ---- T9.5 additions (ref snapshots, LLD §12.5) -----------------------------------------------------------------
  /** Provenance rows of every run of a meta-session, oldest first. */
  listGitCommitsForMetaSession(metaSessionId: string): GitCommitRow[];
  /** The meta-session's base commit (set by the first `prepare`), if any. */
  getMetaSessionBaseCommit(metaSessionId: string): string | undefined;

  // ---- T9.6 additions (push, LLD §12.6) --------------------------------------------------------------------------
  /**
   * In ONE `BEGIN IMMEDIATE` transaction append the `git_push` run event (on `eventRunId`) and insert the `git_push`
   * row (FR-GIT-05: every attempt, accepted or refused, is recorded). The event payload gains `push_id`.
   */
  recordGitPush(input: NewGitPush): { row: GitPushRow; eventId: string };
  /** One `git_push` row by id. */
  getGitPush(id: string): GitPushRow | undefined;
  /** Whether an ACCEPTED `git_push` row pushed exactly `headSha` to `ref` on the remote named `remote` (T9.6). */
  hasAcceptedPush(remote: string, ref: string, headSha: string): boolean;

  // ---- T11.2 additions (inner-agent call pipeline, LLD §13.3, §13.4 step 13, §13.8) --------------------------------
  /**
   * In ONE `BEGIN IMMEDIATE` transaction insert the append-only `inner_call` row and, only when `input.run_id` is set,
   * the `inner_call` run event (payload: ids, outcome and sizes, never text) plus any `events.extra`. Returns the row.
   */
  recordInnerCall(input: NewInnerCall, events?: InnerCallEvents): RecordedInnerCall;
  /** `inner_call` rows, oldest first, optionally of one run. */
  listInnerCalls(filter?: { runId?: string }): InnerCallRow[];

  // ---- T11.6 additions (quality monitoring and suspension, FR-INN-09, LLD §13.3, §13.4 step 11) --------------------
  /** The task's `inner_task_state` row; `undefined` when it was never suspended (equivalent to not suspended). */
  getInnerTaskState(task: string): InnerTaskStateRow | undefined;
  /** Every `inner_task_state` row, by task. */
  listInnerTaskStates(): InnerTaskStateRow[];
  /**
   * Re-enable a suspended task in one transaction: `suspended = 0`, the suspension fields cleared, `resumed_at` set
   * (quality counting restarts after it), `version` incremented. Returns the new state, or `undefined` when the task was
   * not suspended (nothing is changed or recorded). Writes no run event (LLD §13.8).
   */
  resumeInnerTask(task: string): InnerTaskStateRow | undefined;

  // ---- T15.1 additions (project work queue, FR-QUE-01, LLD §18) -----------------------------------------------
  enqueueWorkItem(input: EnqueueWorkItemInput): WorkItemRow;
  getWorkItem(id: string): WorkItemRow | undefined;
  findWorkItemByIdempotency(creatorClientId: string, key: string): WorkItemRow | undefined;
  findWorkItemByAdmittedRunId(runId: string): WorkItemRow | undefined;
  listWorkItems(filter: WorkListFilter): WorkItemRow[];
  listWorkItemPredecessors(workItemId: string): string[];
  cancelWorkItem(workItemId: string, byClientId: string, operator?: boolean): WorkItemRow | undefined;
  claimReadyWorkItem(projectId: string): WorkItemRow | undefined;
  releaseAdmittingToReady(workItemId: string): boolean;
  completeWorkAdmission(
    workItemId: string,
    outcome: { kind: "admitted"; runId: string } | { kind: "retry" } | { kind: "failed"; code: string },
  ): WorkItemRow | undefined;
  markWorkItemDone(workItemId: string): WorkItemRow | undefined;
  closeWorkItemForRun(runId: string, runState: "SUCCEEDED" | "FAILED" | "CANCELLED"): WorkItemRow | undefined;
  reconcileAdmittingWorkItems(): number;
  countWorkItemsForProject(projectId: string): number;
  listDistinctProjectIdsWithReadyWork(): string[];
  // ---- T15.4 additions (queue low-water event, FR-QUE-04, LLD §18.8) -----------------------------------------
  countAdmissibleWorkItems(projectId: string): number;
  setQueueChangeListener(listener?: (projectId: string) => void): void;
}

export {
  type ControlPlaneEventRow,
  type ControlPlaneEventType,
  type ControlPlaneStateRow,
  GLOBAL_PAUSE_SCOPE,
  OPERATOR_PAUSE_APPLIED,
  OPERATOR_PAUSE_REQUESTED,
  OPERATOR_RESUME_REQUESTED,
  type PendingPauseRequest,
} from "./control-plane.js";
export type {
  CreateScheduleInput,
  ScheduleApprovalState,
  ScheduleLedgerSlice,
  ScheduleListFilter,
  ScheduleRow,
} from "./schedule.js";
export type { EnqueueWorkItemInput, WorkItemRow, WorkItemState, WorkListFilter } from "./work-queue.js";

export function createLedger(db: Database.Database, deps: LedgerDeps = {}): Ledger {
  const ids = deps.ids ?? defaultIds;
  const ts = () => (deps.now ?? (() => new Date()))().toISOString();

  const getMetaSession = (id: string) =>
    db
      .prepare(
        "SELECT id, objective, status, repo_root, project_id, version, created_at, updated_at FROM meta_session WHERE id = ?",
      )
      .get(id) as MetaSessionRow | undefined;

  const getRun = (id: string) =>
    db
      .prepare(
        `SELECT id, meta_session_id, state, failure_code, trust_profile, request_hash, client_id, idempotency_key,
                project_id, version, created_at, updated_at FROM run WHERE id = ?`,
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
  // ---- T11.6 helpers (inner_task_state) --------------------------------------------------------------------------
  const QUALITY_OUTCOMES: readonly string[] = ["accepted", "rejected_validator", "rejected_sanitiser"];
  const STATE_COLS = "task, suspended, suspended_at, suspended_basis_json, resumed_at, version";
  interface InnerTaskStateDbRow {
    task: string;
    suspended: number;
    suspended_at: string | null;
    suspended_basis_json: string | null;
    resumed_at: string | null;
    version: number;
  }
  const toInnerTaskState = (r: InnerTaskStateDbRow): InnerTaskStateRow => ({
    task: r.task,
    suspended: r.suspended === 1,
    suspended_at: r.suspended_at,
    suspended_basis:
      r.suspended_basis_json === null ? null : (JSON.parse(r.suspended_basis_json) as InnerSuspensionBasis),
    resumed_at: r.resumed_at,
    version: r.version,
  });
  const readInnerTaskState = (task: string): InnerTaskStateRow | undefined => {
    const r = db.prepare(`SELECT ${STATE_COLS} FROM inner_task_state WHERE task = ?`).get(task) as
      | InnerTaskStateDbRow
      | undefined;
    return r === undefined ? undefined : toInnerTaskState(r);
  };
  /**
   * LLD §13.4 step 11: over the task's last `windowCalls` quality calls since `resumed_at` (strictly after it;
   * `fallback_*` outcomes are not evidence), the basis when at least `minCalls` exist and the rejected share exceeds the
   * threshold, else `undefined`. Nothing when the task is already suspended.
   */
  const evaluateInnerWindow = (
    task: string,
    w: { windowCalls: number; minCalls: number; rejectionThreshold: number },
  ): InnerSuspensionBasis | undefined => {
    const state = readInnerTaskState(task);
    if (state?.suspended === true) return undefined;
    const outcomes = db
      .prepare(
        `SELECT outcome FROM inner_call
          WHERE task = ? AND outcome IN ('accepted','rejected_validator','rejected_sanitiser')
            AND (? IS NULL OR created_at > ?)
          ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(task, state?.resumed_at ?? null, state?.resumed_at ?? null, w.windowCalls) as { outcome: string }[];
    const total = outcomes.length;
    const rejected = outcomes.filter((o) => o.outcome !== "accepted").length;
    if (total < w.minCalls || total === 0 || rejected / total <= w.rejectionThreshold) return undefined;
    return { window_calls: w.windowCalls, rejected, total, threshold: w.rejectionThreshold };
  };
  const suspendInnerTask = (task: string, basis: InnerSuspensionBasis, when: string) => {
    db.prepare(
      `INSERT INTO inner_task_state (task, suspended, suspended_at, suspended_basis_json, version)
       VALUES (?, 1, ?, ?, 1)
       ON CONFLICT(task) DO UPDATE SET suspended = 1, suspended_at = excluded.suspended_at,
         suspended_basis_json = excluded.suspended_basis_json, version = version + 1`,
    ).run(task, when, JSON.stringify(basis));
  };

  const insertEvent = (
    runId: string,
    type: string,
    payload: unknown,
    when: string,
    artifactId: string | null = null,
  ): string => {
    const row = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_event WHERE run_id = ?").get(runId) as {
      next: number;
    };
    const id = ids.id("evt");
    db.prepare(
      "INSERT INTO run_event (id, run_id, seq, ts, type, payload_json, artifact_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(id, runId, row.next, when, type, JSON.stringify(payload ?? {}), artifactId);
    return id;
  };

  const patchSql = (set: RunFieldPatch): { cols: string; values: unknown[] } => {
    const keys = PATCHABLE.filter((k) => set[k] !== undefined);
    return { cols: keys.map((k) => `, ${k} = ?`).join(""), values: keys.map((k) => set[k]) };
  };

  const immediate = <T>(fn: () => T): T => db.transaction(fn).immediate();
  const workQueue = createWorkQueueLedgerSlice(db, { ids, ts, immediate });

  const APPROVAL_SQL =
    "SELECT id, run_id, scope_json, scope_hash, status, requested_at, decided_at, decided_by FROM approval";
  const getApproval = (id: string) => db.prepare(`${APPROVAL_SQL} WHERE id = ?`).get(id) as ApprovalRow | undefined;

  // ---- T5.3 helpers (outcomes per meta-session, open-work projection) ----------------------------------------------
  const TERMINAL_STATES = ["SUCCEEDED", "FAILED", "CANCELLED"] as const;
  const parseJson = (text: string): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  };
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

  /** Terminal runs of a meta-session with the facts the open-work derivation and the read helper need (existing records only). */
  const outcomesOf = (metaSessionId: string): RunOutcomeRecord[] => {
    const runs = db
      .prepare(
        `SELECT id, state, failure_code, provider, created_at, finished_at, request_json FROM run
         WHERE meta_session_id = ? AND state IN ('SUCCEEDED','FAILED','CANCELLED') ORDER BY created_at, id`,
      )
      .all(metaSessionId) as {
      id: string;
      state: RunOutcomeRecord["state"];
      failure_code: string | null;
      provider: string | null;
      created_at: string;
      finished_at: string | null;
      request_json: string;
    }[];
    return runs.map((r) => {
      const events = listRunEvents(r.id);
      const terminal = events.findLast((e) => {
        if (e.type !== "state_transition") return false;
        const p = parseJson(e.payload_json);
        return isRecord(p) && typeof p.to === "string" && (TERMINAL_STATES as readonly string[]).includes(p.to);
      });
      const tp = terminal === undefined ? undefined : parseJson(terminal.payload_json);
      const payload = isRecord(tp) ? tp : {};
      const arts = isRecord(payload.artifacts) ? payload.artifacts : {};
      const request = parseJson(r.request_json);
      const argvs =
        isRecord(request) && Array.isArray(request.verification_commands) ? request.verification_commands : [];
      const byIndex = new Map<number, RunVerificationResult>();
      for (const e of events) {
        if (e.type !== "verification_command") continue;
        const p = parseJson(e.payload_json);
        if (!isRecord(p) || typeof p.index !== "number" || typeof p.outcome !== "string") continue;
        const a = argvs[p.index];
        byIndex.set(p.index, {
          index: p.index,
          outcome: p.outcome,
          exit_code: typeof p.exit_code === "number" ? p.exit_code : null,
          argv: Array.isArray(a) && a.every((x) => typeof x === "string") ? (a as string[]) : null,
        });
      }
      const assessment = events.findLast((e) => e.type === "workspace_assessment");
      const ap = assessment === undefined ? undefined : parseJson(assessment.payload_json);
      const nested =
        isRecord(ap) && Array.isArray(ap.nested_repositories_skipped) ? ap.nested_repositories_skipped.length : 0;
      const post = db
        .prepare(
          "SELECT commit_sha FROM workspace_checkpoint WHERE run_id = ? AND kind = 'post' ORDER BY rowid LIMIT 1",
        )
        .get(r.id) as { commit_sha: string } | undefined;
      return {
        run_id: r.id,
        state: r.state,
        failure_code: r.failure_code,
        provider: r.provider,
        created_at: r.created_at,
        finished_at: r.finished_at,
        post_commit: post?.commit_sha ?? null,
        changed_files: typeof payload.changed_files === "number" ? payload.changed_files : 0,
        changed_files_artifact_id: strOrNull(arts.changed_files),
        diff_artifact_id: strOrNull(arts.diff),
        test_report_artifact_id: strOrNull(arts.test_report),
        verification: [...byIndex.values()].sort((a, b) => a.index - b.index),
        nested_repositories_skipped: nested,
        git_policy_violation: payload.git_policy_violation === true,
      };
    });
  };

  /**
   * LLD §15.3: rewrite `meta_session.open_work_json` from the pure derivation over all terminal runs. Called inside the
   * transaction of every terminal transition (after the terminal `state_transition` event is written). No event is added.
   */
  const refreshOpenWork = (metaSessionId: string, when: string): void => {
    const runs: OpenWorkRun[] = outcomesOf(metaSessionId).map((o) => ({
      runId: o.run_id,
      state: o.state,
      failureCode: o.failure_code,
      verification: o.verification.map((v) => ({ index: v.index, outcome: v.outcome, argv: v.argv })),
      nestedRepositoriesSkipped: o.nested_repositories_skipped,
      gitPolicyViolation: o.git_policy_violation,
    }));
    db.prepare("UPDATE meta_session SET open_work_json = ?, version = version + 1, updated_at = ? WHERE id = ?").run(
      JSON.stringify(deriveOpenWork(runs)),
      when,
      metaSessionId,
    );
  };

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
        const moved = getRunRecord(input.runId);
        // T5.3 (LLD §15.3): every terminal transition, whichever caller made it, refreshes the open-work projection.
        if (moved !== undefined && (TERMINAL_STATES as readonly string[]).includes(input.to)) {
          refreshOpenWork(moved.meta_session_id, when);
          // LLD §18.2 (T15.1): the queue item that admitted this run is closed in the same transaction.
          workQueue.closeWorkItemForRun(moved.id, input.to as (typeof TERMINAL_STATES)[number]);
        }
        return moved;
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

    listRunsForClient(f) {
      const where = ["client_id = ?"];
      const args: unknown[] = [f.clientId];
      if (f.projectId !== undefined) {
        where.push("project_id = ?");
        args.push(f.projectId);
      }
      if (f.states !== undefined) {
        if (f.states.length === 0) return [];
        where.push(`state IN (${f.states.map(() => "?").join(", ")})`);
        args.push(...f.states);
      }
      if (f.since !== undefined) {
        where.push("created_at >= ?");
        args.push(f.since);
      }
      if (f.until !== undefined) {
        where.push("created_at < ?");
        args.push(f.until);
      }
      if (f.before !== undefined) {
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        args.push(f.before.createdAt, f.before.createdAt, f.before.id);
      }
      return db
        .prepare(`${RUN_RECORD_SQL} WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(...args, f.limit) as RunRecord[];
    },

    getRunEvent(id) {
      return db
        .prepare("SELECT id, run_id, seq, ts, type, payload_json, artifact_id FROM run_event WHERE id = ?")
        .get(id) as RunEventRow | undefined;
    },

    listRunEventsForClient(f) {
      const after = f.after === undefined ? "" : " AND (e.ts > ? OR (e.ts = ? AND e.id > ?))";
      const args: unknown[] = f.after === undefined ? [] : [f.after.ts, f.after.ts, f.after.id];
      return db
        .prepare(
          `SELECT e.id, e.run_id, e.seq, e.ts, e.type, e.payload_json, e.artifact_id FROM run_event e
           JOIN run r ON r.id = e.run_id WHERE r.client_id = ?${after} ORDER BY e.ts, e.id LIMIT ?`,
        )
        .all(f.clientId, ...args, f.limit) as RunEventRow[];
    },

    setMetaSessionHead(metaSessionId, commit) {
      db.prepare("UPDATE meta_session SET head_commit = ?, version = version + 1, updated_at = ? WHERE id = ?").run(
        commit,
        ts(),
        metaSessionId,
      );
    },

    insertArtifact(input) {
      const id = input.id ?? ids.id("art");
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

    listTerminalRunsForProviderSince(provider, sinceIso) {
      return db
        .prepare(
          `SELECT id, state, failure_code, failure_detail, started_at, finished_at FROM run
           WHERE provider = ? AND state IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
             AND finished_at IS NOT NULL AND finished_at >= ?
           ORDER BY finished_at, id`,
        )
        .all(provider, sinceIso) as CapacityRunRow[];
    },

    listRateLimitSignalsSince(provider, sinceIso) {
      return db
        .prepare(
          `SELECT e.ts AS ts, json_extract(e.payload_json, '$.reset_at') AS reset_at
           FROM run_event e JOIN run r ON r.id = e.run_id
           WHERE r.provider = ? AND e.type = 'provider_event' AND e.ts >= ?
             AND json_extract(e.payload_json, '$.kind') = 'rate_limit'
           ORDER BY e.ts, e.id`,
        )
        .all(provider, sinceIso)
        .map((r) => {
          const row = r as { ts: string; reset_at: unknown };
          return { ts: row.ts, reset_at: typeof row.reset_at === "string" ? row.reset_at : null };
        });
    },

    listProviderReportedUsageSince(provider, sinceIso) {
      return db
        .prepare(
          `SELECT metrics_json, observed_at FROM usage_observation
           WHERE provider = ? AND source = 'provider_reported' AND observed_at >= ?
           ORDER BY observed_at, id`,
        )
        .all(provider, sinceIso) as ProviderUsageRow[];
    },

    countRunsCreatedSince(sinceIso, projectId) {
      const sql = `SELECT COUNT(*) AS n FROM run WHERE created_at >= ?${projectId === undefined ? "" : " AND project_id = ?"}`;
      const args: unknown[] = projectId === undefined ? [sinceIso] : [sinceIso, projectId];
      return (db.prepare(sql).get(...args) as { n: number }).n;
    },

    listOpenRunClocks(projectId) {
      const sql = `SELECT id, state, started_at FROM run
           WHERE state NOT IN ('SUCCEEDED','FAILED','CANCELLED')${projectId === undefined ? "" : " AND project_id = ?"}
           ORDER BY created_at, id`;
      return (projectId === undefined ? db.prepare(sql).all() : db.prepare(sql).all(projectId)) as OpenRunClockRow[];
    },

    listReportedUsageSince(sinceIso, projectId) {
      const sql =
        projectId === undefined
          ? `SELECT metrics_json, observed_at FROM usage_observation
             WHERE source = 'provider_reported' AND observed_at >= ? ORDER BY observed_at, id`
          : `SELECT u.metrics_json, u.observed_at FROM usage_observation u JOIN run r ON r.id = u.run_id
             WHERE u.source = 'provider_reported' AND u.observed_at >= ? AND r.project_id = ? ORDER BY u.observed_at, u.id`;
      const args: unknown[] = projectId === undefined ? [sinceIso] : [sinceIso, projectId];
      return db.prepare(sql).all(...args) as ProviderUsageRow[];
    },

    getProviderHealth(provider) {
      return db
        .prepare(
          `SELECT provider, breaker_state, breaker_until, consecutive_failures, last_failure_code, updated_at, version
           FROM provider_health WHERE provider = ?`,
        )
        .get(provider) as ProviderHealthRow | undefined;
    },

    listStartedRunsSince(sinceIso, clientId) {
      const sql = `SELECT id, provider, model, project_id, request_json, created_at FROM run
           WHERE started_at IS NOT NULL AND provider IS NOT NULL AND created_at >= ?${clientId === undefined ? "" : " AND client_id = ?"}
           ORDER BY created_at, id`;
      const args: unknown[] = clientId === undefined ? [sinceIso] : [sinceIso, clientId];
      return db.prepare(sql).all(...args) as StartedRunRow[];
    },

    listRecentQuotaExhaustedRuns(provider, limit) {
      return db
        .prepare(
          `${RUN_RECORD_SQL} WHERE provider = ? AND failure_code = 'QUOTA_EXHAUSTED'
           ORDER BY finished_at DESC, id DESC LIMIT ?`,
        )
        .all(provider, limit) as RunRecord[];
    },

    findSuccessorRun(runId) {
      return db
        .prepare(`${RUN_RECORD_SQL} WHERE parent_run_id = ? ORDER BY attempt, created_at, id LIMIT 1`)
        .get(runId) as RunRecord | undefined;
    },

    getProjectAffinity(projectKey) {
      return db.prepare("SELECT * FROM project_affinity WHERE project_key = ?").get(projectKey) as
        | ProjectAffinityRow
        | undefined;
    },

    listProjectAffinities() {
      return db.prepare("SELECT * FROM project_affinity ORDER BY project_key").all() as ProjectAffinityRow[];
    },

    writeProjectAffinity(w) {
      const now = ts();
      if (w.expectedVersion === undefined) {
        const r = db
          .prepare(
            `INSERT INTO project_affinity (project_key, provider, model, since, last_run_id, last_switch_reason,
               updated_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT (project_key) DO NOTHING`,
          )
          .run(w.projectKey, w.provider, w.model, now, w.lastRunId, w.reason, now);
        return r.changes === 1;
      }
      const r = db
        .prepare(
          `UPDATE project_affinity SET
             since = CASE WHEN provider = @provider THEN since ELSE @now END,
             last_switch_reason = CASE WHEN @reason IS NULL AND provider = @provider THEN last_switch_reason
                                       ELSE @reason END,
             provider = @provider, model = @model, last_run_id = @run,
             reset_requested_at = NULL, reset_by = NULL, updated_at = @now, version = version + 1
           WHERE project_key = @key AND version = @version`,
        )
        .run({
          key: w.projectKey,
          provider: w.provider,
          model: w.model,
          run: w.lastRunId,
          reason: w.reason,
          now,
          version: w.expectedVersion,
        });
      return r.changes === 1;
    },

    latestProjectRunOnProvider(projectId, workspace, provider, afterIso) {
      const where =
        projectId !== null
          ? "project_id = @project"
          : "project_id IS NULL AND json_extract(request_json, '$.workspace') = @workspace";
      return db
        .prepare(
          `SELECT id, state, failure_code FROM run
           WHERE provider = @provider AND state IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
             AND finished_at IS NOT NULL AND finished_at > @after AND ${where}
           ORDER BY finished_at DESC, id DESC LIMIT 1`,
        )
        .get({ provider, after: afterIso, project: projectId, workspace }) as
        | { id: string; state: string; failure_code: string | null }
        | undefined;
    },

    requestAffinityReset(projectKey, by) {
      const r = db
        .prepare(
          `UPDATE project_affinity SET reset_requested_at = @now, reset_by = @by, updated_at = @now,
             version = version + 1 WHERE project_key = @key`,
        )
        .run({ key: projectKey, by, now: ts() });
      return r.changes === 1;
    },

    writeProviderBreaker(provider, b) {
      db.prepare(
        `INSERT INTO provider_health (provider, auth_state, version_state, breaker_state, breaker_until,
           consecutive_failures, last_failure_code, updated_at, version)
         VALUES (@provider, 'UNKNOWN', 'UNVERIFIED', @state, @until, @failures, @code, @now, 1)
         ON CONFLICT (provider) DO UPDATE SET breaker_state = @state, breaker_until = @until,
           consecutive_failures = @failures, last_failure_code = @code, updated_at = @now, version = version + 1`,
      ).run({
        provider,
        state: b.state,
        until: b.until,
        failures: b.consecutiveFailures,
        code: b.lastFailureCode,
        now: ts(),
      });
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
      // T5.3 (FR-ADP-10, LLD §1): harness, backing provider and model are set at insert and not updated; binding the
      // same native session again (a resume) only refreshes `last_used_at`.
      db.prepare(
        `INSERT INTO provider_binding (id, meta_session_id, provider, harness, backing_provider, model, native_session_id,
                                       created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (meta_session_id, provider, native_session_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
      ).run(
        ids.id("pbd"),
        input.metaSessionId,
        input.provider,
        input.harness ?? input.provider,
        input.backingProvider ?? null,
        input.model ?? null,
        input.nativeSessionId,
        now,
        now,
      );
    },

    listProviderBindings(metaSessionId) {
      return db
        .prepare("SELECT * FROM provider_binding WHERE meta_session_id = ? ORDER BY created_at, rowid")
        .all(metaSessionId) as ProviderBindingRow[];
    },

    appendDecision(input) {
      return immediate(() => {
        const run = db.prepare("SELECT meta_session_id, state FROM run WHERE id = ?").get(input.runId) as
          | { meta_session_id: string; state: RunState }
          | undefined;
        if (run === undefined) throw new DecisionRefusedError(`decision ${input.kind}: unknown run ${input.runId}`);
        if ((TERMINAL_STATES as readonly string[]).includes(run.state)) {
          throw new DecisionRefusedError(`decision ${input.kind}: run ${input.runId} is already ${run.state}`);
        }
        const summary = renderDecisionSummary(input);
        const prefix = input.kind === "approval_decided" ? approvalCausePrefix(input.approvalId) : undefined;
        const existing = (
          prefix === undefined
            ? db
                .prepare("SELECT id FROM decision WHERE run_id = ? AND decision = ? ORDER BY rowid LIMIT 1")
                .get(input.runId, input.kind)
            : db
                .prepare(
                  `SELECT id FROM decision WHERE run_id = ? AND decision = ? AND substr(reason_summary, 1, ?) = ?
                   ORDER BY rowid LIMIT 1`,
                )
                .get(input.runId, input.kind, prefix.length, prefix)
        ) as { id: string } | undefined;
        if (existing !== undefined) return { id: existing.id, created: false };
        const id = ids.id("dec");
        db.prepare(
          "INSERT INTO decision (id, meta_session_id, run_id, decision, reason_summary, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(id, run.meta_session_id, input.runId, input.kind, summary, ts());
        return { id, created: true };
      });
    },

    listDecisionsForRun(runId) {
      return db
        .prepare(
          "SELECT id, meta_session_id, run_id, decision, reason_summary, created_at FROM decision WHERE run_id = ? ORDER BY created_at, rowid",
        )
        .all(runId) as DecisionRow[];
    },

    listOutcomesForMetaSession(metaSessionId) {
      const m = db.prepare("SELECT id, base_commit, head_commit FROM meta_session WHERE id = ?").get(metaSessionId) as
        | { id: string; base_commit: string | null; head_commit: string | null }
        | undefined;
      if (m === undefined) return undefined;
      return {
        meta_session_id: m.id,
        base_commit: m.base_commit,
        head_commit: m.head_commit,
        runs: outcomesOf(metaSessionId),
      };
    },

    getOpenWorkProjection(metaSessionId) {
      const row = db.prepare("SELECT open_work_json FROM meta_session WHERE id = ?").get(metaSessionId) as
        | { open_work_json: string }
        | undefined;
      return row === undefined ? undefined : (JSON.parse(row.open_work_json) as unknown[]);
    },

    latestProviderBinding(metaSessionId, provider) {
      const sql = `SELECT * FROM provider_binding WHERE meta_session_id = ?${provider === undefined ? "" : " AND provider = ?"}
                   ORDER BY last_used_at DESC, rowid DESC LIMIT 1`;
      const args = provider === undefined ? [metaSessionId] : [metaSessionId, provider];
      return db.prepare(sql).get(...args) as ProviderBindingRow | undefined;
    },

    getMetaSessionContinuity(metaSessionId) {
      return db
        .prepare(
          "SELECT id, objective, constraints_json, repo_root, base_commit, head_commit FROM meta_session WHERE id = ?",
        )
        .get(metaSessionId) as MetaSessionContinuityRow | undefined;
    },

    getArtifact(id) {
      return db
        .prepare(
          `SELECT id, run_id, meta_session_id, kind, sha256, size_bytes, media_type, created_at, deleted_at
           FROM artifact WHERE id = ?`,
        )
        .get(id) as ArtifactRow | undefined;
    },

    maxRunEventSeq(runId) {
      return (
        db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM run_event WHERE run_id = ?").get(runId) as { n: number }
      ).n;
    },

    listRunEventsUpTo(runId, maxSeq) {
      return db
        .prepare(
          `SELECT id, run_id, seq, ts, type, payload_json, artifact_id FROM run_event
           WHERE run_id = ? AND seq <= ? ORDER BY seq`,
        )
        .all(runId, maxSeq) as RunEventRow[];
    },

    listGcCandidates(cutoffIso) {
      // Expired idle ACTIVE sessions, plus ARCHIVED sessions whose collection began (`gc_intent` is their newest GC event,
      // or live artifact rows remain) and must roll forward. Admission refuses ARCHIVED sessions (R-42).
      return db
        .prepare(
          `SELECT m.id AS id, m.repo_root AS repo_root, m.status = 'ARCHIVED' AS resume,
                  ${NEWEST_RUN_SQL} AS newest_run_id,
                  ${LAST_ACTIVITY_SQL} AS last_activity
           FROM meta_session m
           WHERE (${IDLE_EXPIRED_SQL}) OR (${GC_PENDING_SQL})
           ORDER BY last_activity, m.id`,
        )
        .all(cutoffIso)
        .map((r) => {
          const row = r as Omit<GcCandidate, "resume"> & { resume: number };
          return { ...row, resume: row.resume === 1 };
        });
    },

    beginGc(sessionId, cutoffIso, at, intent) {
      return immediate(() => {
        const row = db
          .prepare(
            `SELECT m.status AS status, ${NEWEST_RUN_SQL} AS newest_run_id,
                    (${IDLE_EXPIRED_SQL}) AS expired
             FROM meta_session m WHERE m.id = ?`,
          )
          .get(cutoffIso, sessionId) as { status: string; newest_run_id: string | null; expired: number } | undefined;
        if (!row) return false;
        if (row.status === "ACTIVE") {
          // Re-check idleness inside the marking transaction: a run admitted since the candidate list was read wins.
          if (row.expired !== 1) return false;
          db.prepare(
            "UPDATE meta_session SET status = 'ARCHIVED', version = version + 1, updated_at = ? WHERE id = ? AND status = 'ACTIVE'",
          ).run(at, sessionId);
        }
        if (row.newest_run_id !== null) insertEvent(row.newest_run_id, "gc_intent", intent, at);
        return true;
      });
    },

    gcSessionTargets(sessionId) {
      const prefix = `switchboard/${sessionId}/`;
      const runs = db.prepare("SELECT id, worktree_path, branch FROM run WHERE meta_session_id = ?").all(sessionId) as {
        id: string;
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
      return { worktreePaths, branches, runIds: runs.map((r) => r.id) };
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
        if (outcome.runId !== null) insertEvent(outcome.runId, "gc_outcome", outcome.payload, at);
      });
    },

    newApprovalId() {
      return ids.id("apv");
    },

    newArtifactId() {
      return ids.id("art");
    },

    createApproval(input) {
      const id = input.id ?? ids.id("apv");
      db.prepare(
        `INSERT INTO approval (id, run_id, scope_json, scope_hash, status, requested_at)
         VALUES (?, ?, ?, ?, 'PENDING', ?)`,
      ).run(id, input.runId, input.scopeJson, input.scopeHash, ts());
      return getApproval(id) as ApprovalRow;
    },

    getApproval,

    getApprovalForRun(runId) {
      return db.prepare(`${APPROVAL_SQL} WHERE run_id = ? ORDER BY requested_at, id LIMIT 1`).get(runId) as
        | ApprovalRow
        | undefined;
    },

    listApprovals(filter = {}) {
      const where = filter.status === undefined ? "" : " WHERE status = ?";
      const args: unknown[] = filter.status === undefined ? [] : [filter.status];
      return db
        .prepare(`${APPROVAL_SQL}${where} ORDER BY requested_at, id LIMIT ?`)
        .all(...args, filter.limit ?? -1) as ApprovalRow[];
    },

    findApprovalForMetaSession(metaSessionId, clientId) {
      const rows = db
        .prepare(
          `SELECT a.id, a.run_id, a.scope_json, a.scope_hash, a.status, a.requested_at, a.decided_at, a.decided_by
           FROM approval a JOIN run r ON r.id = a.run_id
           WHERE r.meta_session_id = ? AND r.client_id = ? ORDER BY a.requested_at, a.id LIMIT 2`,
        )
        .all(metaSessionId, clientId) as ApprovalRow[];
      if (rows.length > 1) {
        throw new Error(`meta-session ${metaSessionId} has more than one approval row (invariant, LLD §3.1)`);
      }
      return rows[0];
    },

    decideApproval(input) {
      if (input.status !== "APPROVED" && input.status !== "DENIED") {
        throw new Error(`an approval can only be decided APPROVED or DENIED, not ${String(input.status)}`);
      }
      if (typeof input.decidedBy !== "string" || input.decidedBy.length === 0) throw new Error("decidedBy is required");
      const res = db
        .prepare("UPDATE approval SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'PENDING'")
        .run(input.status, input.decidedAt ?? ts(), input.decidedBy, input.id);
      return res.changes === 1 ? getApproval(input.id) : undefined;
    },

    listRunsCoveredByApproval(approvalId) {
      return db
        .prepare(
          `${RUN_RECORD_SQL} WHERE trust_profile = 'privileged'
             AND json_extract(policy_snapshot_json, '$.privilegedScope.approvalId') = ? ORDER BY created_at, id`,
        )
        .all(approvalId) as RunRecord[];
    },

    createMetaSession(input) {
      const id = ids.id("sess");
      const now = ts();
      db.prepare(
        `INSERT INTO meta_session (id, objective, constraints_json, repo_root, project_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      ).run(
        id,
        input.objective,
        JSON.stringify(input.constraints ?? []),
        input.repoRoot ?? null,
        input.projectId ?? null,
        now,
        now,
      );
      return getMetaSession(id) as MetaSessionRow;
    },

    createRun(input) {
      const id = ids.id("run");
      const now = ts();
      db.prepare(
        `INSERT INTO run (id, meta_session_id, state, trust_profile, policy_snapshot_json, request_json, request_hash,
                          client_id, idempotency_key, provider, model, priority, project_id, parent_run_id, attempt,
                          next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.model ?? null,
        input.priority ?? 1,
        input.projectId ?? null,
        input.parentRunId ?? null,
        input.attempt ?? 1,
        input.nextAttemptAt ?? null,
        now,
        now,
      );
      return getRun(id) as RunRow;
    },

    recordGitCommit(input) {
      return immediate(() => {
        const existing = db
          .prepare("SELECT * FROM git_commit WHERE run_id = ? AND commit_sha = ?")
          .get(input.runId, input.commitSha) as GitCommitRow | undefined;
        if (existing) return { row: existing, created: false };
        const when = ts();
        const eventId = insertEvent(input.runId, "git_commit", input.eventPayload, when);
        const id = ids.id("gcm");
        db.prepare(
          `INSERT INTO git_commit (id, commit_sha, tree_sha, patch_id, repo_root, publish_ref, project_id, context_id,
             meta_session_id, run_id, provider, harness, model, adapter_version_id, origin, tool_event_id,
             sanitizer_json, created_at, message_source, inner_call_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.commitSha,
          input.treeSha,
          input.patchId ?? null,
          input.repoRoot,
          input.publishRef,
          input.projectId,
          input.contextId,
          input.metaSessionId,
          input.runId,
          input.provider,
          input.harness,
          input.model ?? null,
          input.adapterVersionId ?? null,
          input.origin,
          eventId,
          JSON.stringify(input.sanitizer ?? { rules: {} }),
          when,
          input.messageSource ?? "agent",
          input.innerCallId ?? null,
        );
        return { row: db.prepare("SELECT * FROM git_commit WHERE id = ?").get(id) as GitCommitRow, created: true };
      });
    },

    listGitCommits(runId) {
      return db
        .prepare("SELECT * FROM git_commit WHERE run_id = ? ORDER BY created_at, id")
        .all(runId) as GitCommitRow[];
    },

    findGitCommitsBySha(commitSha) {
      return db
        .prepare("SELECT * FROM git_commit WHERE commit_sha = ? ORDER BY created_at, id")
        .all(commitSha) as GitCommitRow[];
    },

    listGitCommitsForMetaSession(metaSessionId) {
      return db
        .prepare("SELECT * FROM git_commit WHERE meta_session_id = ? ORDER BY created_at, id")
        .all(metaSessionId) as GitCommitRow[];
    },

    recordGitPush(input) {
      return immediate(() => {
        const when = ts();
        const id = ids.id("gps");
        const eventId = insertEvent(input.eventRunId, "git_push", { push_id: id, ...input.eventPayload }, when);
        db.prepare(
          `INSERT INTO git_push (id, run_id, project_id, context_id, remote, ref, head_sha, outcome, detail, requested_by,
             created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.runId,
          input.projectId,
          input.contextId,
          input.remote,
          input.ref,
          input.headSha,
          input.outcome,
          input.detail,
          input.requestedBy,
          when,
        );
        return { row: db.prepare("SELECT * FROM git_push WHERE id = ?").get(id) as GitPushRow, eventId };
      });
    },

    getGitPush(id) {
      return db.prepare("SELECT * FROM git_push WHERE id = ?").get(id) as GitPushRow | undefined;
    },

    hasAcceptedPush(remote, ref, headSha) {
      return (
        db
          .prepare(
            "SELECT 1 FROM git_push WHERE outcome = 'ACCEPTED' AND remote = ? AND ref = ? AND head_sha = ? LIMIT 1",
          )
          .get(remote, ref, headSha) !== undefined
      );
    },

    getMetaSessionBaseCommit(metaSessionId) {
      const row = db.prepare("SELECT base_commit FROM meta_session WHERE id = ?").get(metaSessionId) as
        | { base_commit: string | null }
        | undefined;
      return row?.base_commit ?? undefined;
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

    recordInnerCall(input, events) {
      return immediate(() => {
        const id = ids.id("inc");
        const when = ts();
        const row: RecordedInnerCall = { ...input, id, created_at: when };
        db.prepare(
          `INSERT INTO inner_call (id, task, backend_kind, model_id, locality, template_version, outcome, reason, attempts,
             latency_ms, tokens_in, tokens_out, input_bytes, output_bytes, input_sha256, run_id, meta_session_id, created_at)
           VALUES (@id, @task, @backend_kind, @model_id, @locality, @template_version, @outcome, @reason, @attempts,
             @latency_ms, @tokens_in, @tokens_out, @input_bytes, @output_bytes, @input_sha256, @run_id, @meta_session_id,
             @created_at)`,
        ).run(row);
        if (events?.sharedSubscriptionWith && row.attempts >= 1) {
          const metrics: Record<string, number> = {};
          if (row.tokens_in !== null) metrics.input_tokens = row.tokens_in;
          if (row.tokens_out !== null) metrics.output_tokens = row.tokens_out;
          db.prepare(
            `INSERT INTO usage_observation (id, run_id, provider, harness, backing_provider, model, source, metrics_json,
                                            observed_at)
             VALUES (?, ?, ?, ?, NULL, ?, 'inner_agent', ?, ?)`,
          ).run(
            ids.id("use"),
            row.run_id,
            events.sharedSubscriptionWith,
            events.sharedSubscriptionWith,
            row.model_id,
            JSON.stringify(metrics),
            when,
          );
        }
        if (row.run_id !== null) {
          insertEvent(
            row.run_id,
            "inner_call",
            {
              inner_call_id: id,
              task: row.task,
              outcome: row.outcome,
              ...(row.reason !== null ? { reason: row.reason } : {}),
              locality: row.locality,
              template_version: row.template_version,
              attempts: row.attempts,
              latency_ms: row.latency_ms,
              input_bytes: row.input_bytes,
              output_bytes: row.output_bytes,
              ...events?.callPayload,
            },
            when,
            events?.artifactId ?? null,
          );
          for (const e of events?.extra ?? []) insertEvent(row.run_id, e.type, e.payload, when);
        }
        // Step 11: quality window. Same transaction, so the row and the state change are never seen apart.
        const w = events?.suspension;
        if (w !== undefined && QUALITY_OUTCOMES.includes(row.outcome)) {
          const basis = evaluateInnerWindow(row.task, w);
          if (basis !== undefined) {
            suspendInnerTask(row.task, basis, when);
            row.suspended_task = basis;
            if (row.run_id !== null)
              insertEvent(row.run_id, "inner_task_suspended", { task: row.task, ...basis }, when);
          }
        }
        return row;
      });
    },

    getInnerTaskState: (task) => readInnerTaskState(task),

    listInnerTaskStates() {
      return (
        db.prepare(`SELECT ${STATE_COLS} FROM inner_task_state ORDER BY task`).all() as InnerTaskStateDbRow[]
      ).map(toInnerTaskState);
    },

    resumeInnerTask(task) {
      return immediate(() => {
        const cur = readInnerTaskState(task);
        if (cur === undefined || !cur.suspended) return undefined;
        db.prepare(
          `UPDATE inner_task_state SET suspended = 0, suspended_at = NULL, suspended_basis_json = NULL,
             resumed_at = ?, version = version + 1 WHERE task = ?`,
        ).run(ts(), task);
        return readInnerTaskState(task);
      });
    },

    listInnerCalls(filter) {
      const cols = `id, task, backend_kind, model_id, locality, template_version, outcome, reason, attempts, latency_ms,
        tokens_in, tokens_out, input_bytes, output_bytes, input_sha256, run_id, meta_session_id, created_at`;
      return (
        filter?.runId !== undefined
          ? db.prepare(`SELECT ${cols} FROM inner_call WHERE run_id = ? ORDER BY id`).all(filter.runId)
          : db.prepare(`SELECT ${cols} FROM inner_call ORDER BY id`).all()
      ) as InnerCallRow[];
    },

    ...workQueue,
    // T14.6 (FR-CTL-05): pause rows and operator pause signals (migration 0018).
    ...createControlPlaneLedgerSlice(db, { ids, ts, immediate }),
    // T15.2 (FR-QUE-02): schedules (migration 0019).
    ...createScheduleLedgerSlice(db, { ids, ts, immediate }),
  };
}
