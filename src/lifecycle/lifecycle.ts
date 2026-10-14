/**
 * Run lifecycle orchestration (T1.8): admission → bounded priority queue → PREFLIGHT → LEASED → RUNNING → FINALIZING →
 * terminal, following the FRD §4 state machine (FRD owns the edges; see ./states.ts). Internal API only; the MCP
 * surface arrives in M2.
 *
 * Proposed choices made here (none is owner-approved):
 * - Dispatch happens only after `start()`, so startup reconciliation (T1.9, WF-8) can finish first.
 * - Queue depth counts QUEUED and WAITING_CAPACITY runs; a full queue rejects admission with `QUEUE_FULL` before any row
 *   is written (SDD §1 "retryable error"; the LLD §4 taxonomy has no code for it yet).
 * - Priority values: interactive 2, normal 1, batch 0 (LLD §3 names the enum, LLD §1 stores an integer).
 * - M1 preflight runs `probe` and `authPreflight` on every dispatch (cached by `preflightCache` when set, NFR-PERF-02). Any
 *   failed probe step or an UNKNOWN auth state ends the run `ELIGIBILITY_NONE`; AUTH_REQUIRED ends it `AUTH_REQUIRED`.
 * - PREFLIGHT → LEASED is committed before `WorkspaceManager.prepare`, which then takes the lease and creates the
 *   worktree (intent before effect, LLD §10). A workspace preparation failure uses the LEASED → FAILED edge with
 *   `TOOL_FAILURE`.
 * - A failed or cancelled run's workspace is checkpointed as evidence and the meta-session head is set back to the
 *   pre-run checkpoint (FRD §4.4); the run's own worktree keeps the evidence commit until GC. No automatic retry in
 *   M1: retry eligibility (BR-7) is recorded as an event only; successor runs arrive with FR-CAP-05 in M6.
 * - Controller-side exceptions are contained per run (NFR-REL-02) and end that run `TOOL_FAILURE`.
 *
 * T2.4 additions (Proposed, Delegated):
 * - With `eligibility` set, PREFLIGHT runs the shared stage-1 filter (`src/routing`, FR-RTE-01) for the run's provider
 *   as a required provider instead of the M1 probe/auth checks, so version, manifest, enablement, platform, auth and
 *   profile support are all re-checked at dispatch (FRD BR-20, T8) and an exclusion ends the run with the FRD BR-3 code.
 *   `checkEligibility` exposes the same evaluation to the MCP layer for admission (FRD V11). Without `eligibility` the M1
 *   checks remain (kept for the M1 unit tests; `serve` must always pass it).
 * - Callers may supply the idempotency `requestHash` (canonical validated tool input, BR-10) and a route decision that
 *   is inserted in the admission transaction (FRD T1 side effects).
 * - Native session ids reported by a run are recorded in `provider_binding`; a continuation naming one runs through the
 *   adapter's `resumeArgs` (WF-2, FR-SES-03).
 *
 * T3.3 additions (privileged admission; LLD §3.1, FRD T1/T2, C7, WF-7; Proposed, Delegated):
 * - `privileged` resolves only through a scope binding, never through `resolveProfile`. A new meta-session with a
 *   `scope` is admitted by T2: the run (AWAITING_APPROVAL, snapshot `privilegedScope` with the v2 scope hash and a
 *   pre-allocated approval ID), its `PENDING` approval row and the first `run_event` share one transaction; no process,
 *   no worktree. A continuation with an `approvalId` is admitted by T1 (QUEUED) only if, inside the admission
 *   transaction, that approval is `APPROVED`, was requested by a run of the same meta-session and client, and its stored
 *   hash equals the hash recomputed from (client, meta-session, stored scope); the approved scope is copied as is.
 * - The stored snapshot's `bypassApproved` is always false; it is computed at dispatch (T3.4 below).
 *
 * T3.4 additions (operator approval; LLD §3.1 "Approve" and "Bypass"; Proposed, Delegated):
 * - `applyApprovalDecision` applies an operator `approve`/`deny` record (T3 to QUEUED, T19 to CANCELLED) and pumps.
 * - At dispatch a `privileged` run is checked first by `evaluateBypass` (`./approval.ts`): a missing, undecided or
 *   mismatched approval ends it FAILED `PERMISSION_BLOCKED` (T8) before any probe, lease or process; otherwise the
 *   computed `bypassApproved` is recorded in a `privileged_dispatch` event and is the only source of `bypassApproved`
 *   for the compile and the argv audit.
 * - Cancelling a run in AWAITING_APPROVAL closes its `PENDING` approval as `DENIED` in the same transaction (Q-15,
 *   `./approval.ts`).
 *
 * Owner decisions 19 and 22 (2026-10-13; mechanism Delegated, ADR-0018, ADR-0019):
 * - The T3.3/T3.4 dispatch refusal of every `privileged` run ("privileged compile not available until T3.5/T3.6") is
 *   gone: the adapter's own compile decides, exactly as for any other profile. Preflight's eligibility compile and the
 *   LEASED compile both receive the snapshot with `bypassApproved` from `evaluateBypass` (an `APPROVED` row, operator
 *   or client policy, whose hashes all check and whose scope sets `bypass: true`); an `Ineligible` ends the run with
 *   its BR-3 code through the T3.7 path below. A stored `bypassApproved` is never trusted (always reset to false).
 * - A `privileged` request from a client configured `privileged_approval: "not_required"` (`approvedByClientPolicy`)
 *   is admitted by T1 to QUEUED: the run, its approval row (written `PENDING`, then decided `APPROVED` with
 *   `decided_by = "client_policy:<client_id>"`), the T1 event and an `approval_decided` event (reason
 *   `client_policy`) share one transaction. The scope is validated, canonicalised and hashed exactly as for T2, and
 *   the row is durable for the meta-session (owner decision 17), so `continue_task` and the dispatch-time hash checks
 *   treat it like an operator approval. Only the per-scope approval is lifted (owner decision 22).
 *
 * T3.7 additions (profile-aware eligibility; FRD BR-3, BR-5, T8, T10; LLD §2):
 * - PREFLIGHT re-checks eligibility against the run's frozen policy snapshot, so its compile check is the same compile
 *   LEASED performs; a compile `Ineligible` there ends the run FAILED (T8) with the BR-3 code and the reasons in the
 *   event.
 * - A compile `Ineligible` at LEASED (a race after preflight passed) ends FAILED (T10) with the BR-3 code of the
 *   adapter's reason (`failureCodeForIneligible`: PROFILE_UNSUPPORTED and CAPABILITY_MISSING give ELIGIBILITY_NONE),
 *   with `reason`, `stage: "compile"` and `eligibility` in the transition event. Until T3.7 it ended
 *   PERMISSION_BLOCKED (ROADMAP §6.2.1). PERMISSION_BLOCKED remains only for the client ceiling (BR-13), the
 *   privileged approval check (T3.4) and a refused bypass flag in the argv audit.
 */

import { realpath } from "node:fs/promises";
import {
  AcpPlanAuditError,
  type AdapterRegistry,
  type AdapterRun,
  type AdapterRunOutcome,
  BypassFlagError,
  type ChannelAuditContext,
  createProbeRunner,
  type FailureCode,
  IsolationAuditError,
  isIneligible,
  McpConfigAuditError,
  type NormalizedEvent,
  type PreflightCache,
  type ProbeRunner,
  type ProviderAdapter,
  type ProviderId,
  type ResolvedProfile,
  startAdapterRun,
} from "../adapters/index.js";
import { type ArtifactStore, defaultRedactor, REDACTION_MARKER } from "../artifacts/index.js";
import {
  applyBreakerOutcome,
  type BreakerSettings,
  type BreakerSnapshot,
  breakerAdmission,
  breakerOutcome,
  CLOSED_BREAKER,
} from "../capacity/breaker.js";
import {
  DEFAULT_BREAKER_FAILURE_THRESHOLD,
  DEFAULT_BREAKER_OPEN_SECONDS,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_CAP_MS,
  DEFAULT_RETRY_MAX_ATTEMPTS,
  isUnderAllowedRoot,
  TRUST_PROFILES,
} from "../config/index.js";
import {
  type BuiltBundle,
  type BundleBounds,
  buildAndPutHandoffView,
  DEFAULT_BUNDLE_BOUNDS,
  HANDOFF_BUNDLE_UNAVAILABLE,
  HandoffBundleError,
  MAX_INSTRUCTION_CHARS,
  parseHandoffBundle,
  RENDERER_VERSION,
  type RouteReasonCode,
  recordHandoffView,
  refusesPrivilegedCrossProvider,
  renderHandoffPrompt,
  takeAsOf,
} from "../continuity/index.js";
import { procStartTicks } from "../exec/proc-info.js";
import { ChannelOpenError, type GitToolService, type OpenChannel } from "../git/channel.js";
import type { GitPublisher } from "../git/commit.js";
import { credentialReachFromJson, signingReachFromJson } from "../git/credential-reach.js";
import {
  type FinalizeCommitOutcome,
  finalizeCommitEventPayload,
  finalizeCommitPlan,
  GIT_FINALIZE_COMMIT_EVENT,
  makeFinalizeCommit,
  sessionHasGitPolicyViolation,
} from "../git/finalize.js";
import { RefGuard } from "../git/ref-guard.js";
import { CHANNEL_MCP_CONFIG_FILE } from "../git/tool-protocol.js";
import type { Ledger, NewRouteDecision, RunFieldPatch, RunRecord, RunState, TrustProfile } from "../ledger/index.js";
import {
  canonicalScopeJson,
  type PrivilegedScope,
  type ProjectSnapshot,
  parsePrivilegedScope,
  privilegedScopeHash,
  resolveTrustProfile,
} from "../policy/index.js";
import { workspaceReachesProviderState } from "../policy/provider-state.js";
import { effectiveRepoConfig, repoAgentConfigRefusal } from "../policy/repo-agent-config.js";
import {
  type CollectDeps,
  collectFacts,
  type EligibilityDecision,
  type EligibilityInput,
  failureCodeForIneligible,
  failureCodeForReason,
  filterEligible,
  reasonCodeForIneligible,
  requirementsFor,
} from "../routing/index.js";
import { usageObservationsFromEvents } from "../usage/index.js";
import { gitText } from "../workspace/git.js";
import { type PreparedWorkspace, ResumeDirectoryUnavailableError, type WorkspaceManager } from "../workspace/index.js";
import {
  APPROVAL_DECIDED_EVENT,
  applyApprovalDecision,
  bypassApprovedFor,
  CLIENT_POLICY_DECIDER_PREFIX,
  type DecisionToApply,
  denyApprovalOnCancel,
  evaluateBypass,
} from "./approval.js";
import { requestHash } from "./request.js";
import {
  planResumeDirectory,
  RESUME_DIRECTORY_UNAVAILABLE,
  type ResumeDirectoryPlan,
  type ResumeDirectoryQuestion,
  type ResumeUnavailableProblem,
} from "./resume-directory.js";
import {
  assertTransition,
  IllegalTransitionError,
  isTerminal,
  QUEUE_STATES,
  SLOT_STATES,
  TRANSITIONS,
  type TransitionRule,
} from "./states.js";
import {
  startVerification,
  VERIFICATION_COMMAND_EVENT,
  VERIFICATION_STARTED_EVENT,
  type VerificationResult,
  verificationCommandsProblem,
  verificationEnvAllowlist,
  verificationReport,
  verificationSummary,
} from "./verification.js";

export type LifecycleErrorCode = "INVALID_REQUEST" | "QUEUE_FULL";

/** Admission or API error. No run row is written when it is thrown from `submit`. */
const archivedMessage = (id: string): string =>
  `meta-session ${id} is archived (collected or being collected by retention GC); start a new task instead`;

export class LifecycleError extends Error {
  override readonly name = "LifecycleError";
  constructor(
    readonly code: LifecycleErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type RunPriority = "interactive" | "normal" | "batch";
export const PRIORITY_VALUES: Readonly<Record<RunPriority, number>> = { interactive: 2, normal: 1, batch: 0 };

/** Proposed default ingress bound (FR-CAP-04); configuration has no key for it yet. */
export const DEFAULT_MAX_QUEUE_DEPTH = 64;
/** Proposed: 2 x the 30-minute default wall clock (LLD §5). */
export const DEFAULT_LEASE_TTL_MS = 60 * 60_000;
/** `bypassApprovedFor` that fails closed (false) when the ledger rows cannot be evaluated. */
function approvedBypassFor(ledger: Ledger, run: RunRecord): boolean {
  try {
    return bypassApprovedFor(ledger, run);
  } catch {
    return false;
  }
}

const SUMMARY_MAX = 4000; // LLD §3 envelope `result.summary` maxLength

export interface SubmitRequest {
  /** Configured MCP client (FR-MCP-06); idempotency keys are scoped to it. */
  readonly clientId: string;
  readonly objective: string;
  /** Required for a new meta-session; taken from the meta-session when continuing (FRD C3). */
  readonly workspace?: string;
  /** Continue an existing, idle meta-session (BR-17). */
  readonly metaSessionId?: string;
  readonly trustProfile: TrustProfile;
  /** M1 has no router: the caller names the adapter. */
  readonly provider: ProviderId;
  readonly constraints?: readonly string[];
  readonly priority?: RunPriority;
  /** New meta-sessions only (FR-MCP-08; FRD C6). */
  readonly idempotencyKey?: string;
  /**
   * Idempotency hash supplied by the caller (BR-10: canonical validated tool input, independent of the routed
   * provider). Defaults to a hash of the stored request.
   */
  readonly requestHash?: string;
  /** Route decision persisted with the run in the admission transaction (FRD T1). */
  readonly routeDecision?: Omit<NewRouteDecision, "runId">;
  /** Continue this provider-native session (WF-2, FR-SES-03); requires `metaSessionId`. */
  readonly resume?: { readonly nativeSessionId: string };
  /**
   * Required with `trustProfile: "privileged"`, refused otherwise (FRD V13, C7; LLD §3.1). `scope` (new meta-session
   * only): T2, AWAITING_APPROVAL with a new `PENDING` approval; with `approvedByClientPolicy` (the client is configured
   * `privileged_approval: "not_required"`, ADR-0019; the caller checks the configuration) T1, QUEUED with the new
   * approval decided `APPROVED` by `client_policy:<clientId>` in the same transaction. `approvalId` (continuation
   * only): T1 under the meta-session's `APPROVED` approval for this client, re-verified in the admission transaction.
   */
  readonly privileged?:
    | { readonly scope: unknown; readonly approvedByClientPolicy?: boolean }
    | { readonly approvalId: string };
  /**
   * The project the run is admitted under (FR-PRJ-03, T9.2), already resolved and checked by the caller (V12, BR-23).
   * Recorded as `project_id` on the meta-session and run and as `project` in the policy snapshot. A meta-session keeps
   * its project for life: a continuation must pass the project the meta-session was created in (the snapshot of the
   * current resolution) and one created without a project must pass none; any other combination is INVALID_REQUEST.
   */
  readonly project?: ProjectSnapshot;
  /**
   * T3.10 (FR-EXE-08, FRD V7, T11, T14): argv arrays run in the run's worktree after the agent exits successfully.
   * Refused under `inspect-untrusted`; an empty list means no verification. A continuation takes none (FRD §7.2).
   */
  readonly verificationCommands?: readonly (readonly string[])[];
  /**
   * T5.5 (ADR-0038 items 2 and 5, LLD §15.2, §15.5, §15.7 step 6): admit this continuation as a handoff run. The caller
   * (T5.6 `continue_task`) has built the bundle and put its bytes in the artifact store (`buildAndPutHandoffView`); the
   * admission transaction records the `handoff_view` row and its `handoff_built` decision, writes `route_selected` with
   * mode `handoff`, and stores `request_json.handoff`. At dispatch the lifecycle renders the stored view with
   * `objective` (the new instruction) last and compiles that text with `constraints: []`. Requires `metaSessionId`;
   * refused with `resume`.
   */
  readonly handoff?: HandoffSubmission;
  /**
   * T6.6 (FR-MCP-10, LLD §16.6): internal only. The failed run this one follows as a failover successor: sets
   * `parent_run_id` and `attempt + 1`. Never set from an MCP request.
   */
  readonly successorOf?: { readonly runId: string; readonly attempt: number };
}

/** T5.5: what a handoff submission carries (see {@link SubmitRequest.handoff}). */
export interface HandoffSubmission {
  readonly built: BuiltBundle;
  /** The artifact store's answer to `put(built.bytes)`; its hash must equal `built.sha256`. */
  readonly stored: { readonly sha256: string; readonly sizeBytes: number };
  /** The meta-session's provider before this run (`P0`, LLD §15.7 step 1). */
  readonly fromProvider: string;
  /** The route reason code recorded in `route_selected` and `request_json.handoff.reason` (LLD §15.3). */
  readonly reason: HandoffReason;
}

/** Route reason codes that lead to a handoff (LLD §15.3, §15.7). */
export const HANDOFF_REASONS = [
  "provider_named",
  "bound_provider_ineligible",
  "no_binding",
  "resume_directory_unavailable",
  "quota_failover",
] as const satisfies readonly RouteReasonCode[];
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

/** `request_json.handoff` of a handoff run (ADR-0038 item 2, LLD §15.2); the rendered prompt itself is never stored. */
export interface StoredHandoff {
  bundle_artifact_id: string;
  bundle_sha256: string;
  as_of_sha256: string;
  renderer_version: number;
  from_provider: string;
  reason: HandoffReason;
}

/** `run_event` type recording the dispatch-time approval verdict of a `privileged` run (`approval_id`, `bypass_approved`). */
export const PRIVILEGED_DISPATCH_EVENT = "privileged_dispatch";

/** Admission-time eligibility question (FRD V11); answered by the shared stage-1 filter. */
export interface EligibilityQuestion {
  readonly candidates: readonly ProviderId[];
  readonly requiredProvider?: ProviderId;
  readonly trustProfile: TrustProfile;
  readonly clientMaxProfile: TrustProfile;
  /** Canonical workspace path; used only to build the pure compile request. */
  readonly cwd: string;
  /** Resolved snapshot to compile against instead of `resolveProfile(trustProfile)` (`privileged`, T3.3). */
  readonly profile?: ResolvedProfile;
  /**
   * T6.4: apply the per-provider breaker (`CIRCUIT_OPEN`). Default true (admission, `list_capabilities`); PREFLIGHT
   * passes false because `pump()` already holds queued runs while a breaker is open and dispatches the probe.
   */
  readonly breaker?: boolean;
}

export interface MetaSessionContext {
  readonly workspace: string;
  readonly constraints: readonly string[];
  readonly trustProfile: TrustProfile;
  readonly provider: ProviderId;
  readonly priority: RunPriority;
  readonly clientId: string;
  /** The project the meta-session was created in (FR-PRJ-03); undefined for a workspace-path session. */
  readonly projectId: string | undefined;
  /** Non-terminal run holding the session, if any (BR-17). */
  readonly activeRunId: string | undefined;
}

export interface EligibilityAnswer {
  readonly input: EligibilityInput;
  readonly decision: EligibilityDecision;
}

export interface SubmitResult {
  readonly runId: string;
  readonly metaSessionId: string;
  readonly state: RunState;
  /** True when an idempotent replay returned an existing run. */
  readonly replayed: boolean;
}

/** The validated request stored in `run.request_json` (no secrets, no client id). */
interface StoredRequest {
  objective: string;
  workspace: string;
  constraints: string[];
  trust_profile: TrustProfile;
  provider: ProviderId;
  priority: RunPriority;
  meta_session_id?: string;
  /** Native session to resume (WF-2). */
  resume_native_session_id?: string;
  /** Project the run was admitted under (T9.2); the id is also the `project_id` column. */
  project_id?: string;
  /** The project's base ref for the first worktree of the meta-session (FR-PRJ-02). */
  base_ref?: string;
  /** T3.10: present only when non-empty, so the stored request (and its default hash) is unchanged otherwise. */
  verification_commands?: string[][];
  /** T5.5: present only for a handoff run. */
  handoff?: StoredHandoff;
  /**
   * Q-68 (NFR-SEC-01): how many secret-shaped values the admission redactor replaced in `objective` and `constraints`
   * (never the values). Present only when non-zero, so the stored request (and its default hash) is unchanged otherwise.
   */
  admission_redactions?: number;
}

export interface TransitionNotice {
  readonly runId: string;
  readonly from: RunState;
  readonly to: RunState;
  readonly rule: string;
}

export interface RunLifecycleOptions {
  readonly ledger: Ledger;
  /** Must share the ledger's database handle. */
  readonly workspace: WorkspaceManager;
  readonly artifacts: ArtifactStore;
  readonly adapters: AdapterRegistry;
  /** Allowed workspace roots (FR-POL-10), checked at admission. */
  readonly allowedRoots: readonly string[];
  /** `limits.global_concurrency` from config (FR-CAP-04). */
  readonly globalConcurrency: number;
  /** Optional per-provider slot limit (T4 guard). Unset means no per-provider limit. */
  readonly perProviderConcurrency?: number;
  /**
   * T6.9 (NFR-PERF-03 "per provider", LLD §16.1): slot limits by adapter provider id (`providers.<id>.concurrency`).
   * A provider absent here uses `perProviderConcurrency`.
   */
  readonly perProviderLimits?: ReadonlyMap<string, number>;
  readonly maxQueueDepth?: number;
  /** COMP-POL stand-in: resolves a profile name to the snapshot stored on the run and given to `compile`. */
  readonly resolveProfile: (name: TrustProfile) => ResolvedProfile;
  readonly probeRunner?: ProbeRunner;
  /** Source for allowlisted environment names of provider processes. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly leaseTtlMs?: number;
  /** Observer for every committed transition (tests, telemetry). Must not throw. */
  readonly onTransition?: (notice: TransitionNotice) => void;
  /** Injectable clock for `started_at` / `finished_at`. */
  readonly now?: () => Date;
  /**
   * Stage-1 eligibility (FR-RTE-01) at PREFLIGHT and for `checkEligibility`. The registry and probe runner are the
   * lifecycle's own. `serve` must set it (fail closed, NFR-SEC-06); it is optional only for the M1 unit tests.
   */
  readonly eligibility?: Omit<CollectDeps, "registry" | "runner">;
  /**
   * NFR-PERF-02 / BR-20: shared preflight cache for the M1 preflight and (unless `eligibility.preflight` is set) the
   * stage-1 eligibility collection. Unset means no caching.
   */
  readonly preflightCache?: PreflightCache;
  /**
   * T9.4 (FR-GIT-02, LLD §12.2, ADR-0026): the `COMP-GIT` tool service. When set, a run whose adapter declares an
   * `injected` channel and whose frozen project snapshot has a writable primary context with a commit identity gets a
   * per-run socket and token before spawn, passed to the provider through the adapter's `channelArgs`; the channel is
   * closed and its socket removed as soon as the provider process has exited. Unset: no channel for any run.
   */
  readonly gitTools?: GitToolService;
  /**
   * T9.5 (FR-GIT-03, BR-27, LLD §12.5, ADR-0027): ref snapshot at LEASED and comparison at FINALIZING for every run with
   * a worktree. Defaults to a guard over this lifecycle's ledger with the default publish prefix; it cannot be turned
   * off (fail closed).
   */
  readonly refGuard?: RefGuard;
  /**
   * T9.7 (FR-GIT-09, FRD BR-30, owner decision 36): the publisher for finalize-only commits, constructed with
   * `allowedStates: ["FINALIZING"]` (a separate instance from the tool channel's, which accepts only RUNNING). Used only
   * for a run whose adapter does not declare an `injected` channel and whose frozen project snapshot opted in
   * (`finalize_commit`); see `src/git/finalize.ts`. Unset: an opted-in run records `service_unavailable` and no commit.
   */
  readonly finalizePublisher?: GitPublisher;
  /**
   * T6.4 (FR-CAP-04, LLD §16.4, ADR-0043 item 3): per-provider breaker thresholds (`capacity.breaker`). Unset means
   * the LLD §16.1 defaults. The breaker cannot be turned off.
   */
  readonly breaker?: BreakerSettings;
  /**
   * T6.5 (FR-CAP-05, LLD §9, §16.5, ADR-0043 item 4): automatic retry parameters (`capacity.retry`). Unset means the
   * LLD §9 values. `queueHorizonSeconds` (`capacity.queue_horizon_seconds`, default 0) widens how far ahead a
   * provider-reported reset may lie for a retry to wait for it.
   */
  readonly retry?: { maxAttempts: number; baseMs: number; capMs: number; queueHorizonSeconds?: number };
  /** T6.5: random source in [0, 1) for the backoff jitter; injectable for tests. */
  readonly random?: () => number;
  /** T6.6: handoff bundle bounds for a quota failover (`continuity.*`, LLD §15.4). Unset means the LLD defaults. */
  readonly continuityBounds?: BundleBounds;
}

/** `run_event` type: a channel-capable run was not offered the commit tool, with a reason code (T9.4). */
export const GIT_CHANNEL_NOT_OFFERED_EVENT = "git_channel_not_offered";
/**
 * `run_event` type (T9.6, FRD BR-31, ADR-0028): the context's push policy is `branch` but the run's environment does
 * not keep push credentials out of the agent's reach (or no push service is configured), so `push` is withheld.
 */
export const GIT_PUSH_WITHHELD_EVENT = "git_push_withheld";

type PreflightVerdict =
  | { readonly ok: true; readonly binaryVersion: string | null }
  | {
      readonly ok: false;
      readonly code: FailureCode;
      readonly detail: string;
      readonly extra?: Record<string, unknown>;
    };

type Pending =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly code: FailureCode; readonly detail: string }
  | { readonly kind: "cancelled" };

/** What the verification stage hands to T14 and finalization. */
interface VerificationOutcomeRecord {
  readonly pending: Pending;
  /** Per-command summaries (no argv, no output). */
  readonly summary: readonly Record<string, unknown>[];
  /** `test_report` artifact id when stored. */
  readonly artifacts: Record<string, string>;
}

interface Execution {
  readonly runId: string;
  cancelRequested: boolean;
  /** The provider process, then (T3.10) the verification stage: whatever `cancel` must stop now. */
  handle: { cancel(): Promise<void> } | undefined;
  done: Promise<void>;
}

/** LLD §16.1 breaker defaults (Assumptions, Q-70); `serve` passes `capacity.breaker`. */
const DEFAULT_BREAKER: BreakerSettings = {
  failureThreshold: DEFAULT_BREAKER_FAILURE_THRESHOLD,
  openSeconds: DEFAULT_BREAKER_OPEN_SECONDS,
};
/** LLD §9 / §16.1 retry defaults (Assumptions, Q-71); `serve` passes `capacity.retry`. */
const DEFAULT_RETRY = {
  maxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS,
  baseMs: DEFAULT_RETRY_BASE_MS,
  capMs: DEFAULT_RETRY_CAP_MS,
  queueHorizonSeconds: 0,
};
/** T6.6: how many recent `QUOTA_EXHAUSTED` runs of a provider are read for a reported reset (Assumption). */
const QUOTA_RESET_LOOKBACK = 5;
/** `setTimeout` limit (about 24.8 days); a later wake is re-armed when it fires. */
const MAX_TIMER_MS = 2_147_483_647;

const CANCELLABLE_DIRECT: ReadonlySet<RunState> = new Set(["AWAITING_APPROVAL", "QUEUED", "WAITING_CAPACITY"]);
/** BR-7 / FR-CAP-05 retry set (T6.5 retries these automatically, LLD §16.5). */
const RETRYABLE: ReadonlySet<FailureCode> = new Set(["RATE_LIMIT_TRANSIENT", "PROVIDER_OVERLOADED", "PROCESS_CRASH"]);

export class RunLifecycle {
  private readonly ledger: Ledger;
  private readonly runner: ProbeRunner;
  private readonly maxQueueDepth: number;
  private readonly inflight = new Map<string, Execution>();
  private readonly waiters = new Map<string, ((run: RunRecord) => void)[]>();
  private started = false;
  private stopped = false;
  private rootsCache: string[] | undefined;
  private readonly refGuard: RefGuard;
  /**
   * T9.11 (FR-WS-08, FR-GIT-03): the tail of each repository's finalization queue. The ref check and the checkpoint
   * commit of one run must not interleave with those of another run in the same repository: the checkpoint moves the
   * run branch before its `post` row exists, and another run's ref check in that window would report it as a
   * `git_policy_violation` (Delegated; LLD §5).
   */
  private readonly repoFinalizeQueue = new Map<string, Promise<void>>();
  /** T6.4: one timer for the earliest moment a held run may become dispatchable (breaker cool-down). */
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeAt: number | undefined;

  constructor(private readonly opts: RunLifecycleOptions) {
    if (!Number.isInteger(opts.globalConcurrency) || opts.globalConcurrency < 1) {
      throw new RangeError("globalConcurrency must be a positive integer");
    }
    this.ledger = opts.ledger;
    this.runner = opts.probeRunner ?? createProbeRunner();
    this.maxQueueDepth = opts.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    this.refGuard = opts.refGuard ?? new RefGuard({ ledger: opts.ledger });
  }

  // ---- public API ---------------------------------------------------------------------------------------------

  /** Begin dispatching queued runs. Call after startup reconciliation. */
  start(): void {
    this.started = true;
    this.pump();
  }

  /** Stop dispatching, cancel every in-flight run and wait for each to reach a terminal state. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.wakeAt = undefined;
    for (const exec of this.inflight.values()) {
      exec.cancelRequested = true;
      void exec.handle?.cancel();
    }
    await this.drain();
  }

  /** Resolve once no run is executing in this process. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight.values()].map((e) => e.done));
  }

  /**
   * Admit a run (FRD T1/T2). Validation happens before any write (FRD §7); the idempotency lookup, queue bound,
   * one-active-run check and inserts share one `BEGIN IMMEDIATE` transaction (LLD §10, BR-17).
   */
  async submit(req: SubmitRequest): Promise<SubmitResult> {
    const stored = await this.validate(req);
    const priv = privilegedInput(req);
    const hash =
      req.requestHash ?? requestHash(priv?.kind === "request" ? { ...stored, privileged_scope: priv.scope } : stored);
    const initial: RunState = priv?.kind === "request" && !priv.clientPolicy ? "AWAITING_APPROVAL" : "QUEUED";
    const profile = priv === undefined ? this.opts.resolveProfile(req.trustProfile) : undefined;

    const result = this.ledger.immediate((): SubmitResult => {
      // T5.5: a handoff run's request names its view, whose id is allocated here so both rows share this transaction.
      const handoff = req.handoff;
      const viewId = handoff ? this.ledger.newArtifactId() : undefined;
      const request: StoredRequest =
        handoff && viewId !== undefined
          ? {
              ...stored,
              handoff: {
                bundle_artifact_id: viewId,
                bundle_sha256: handoff.built.sha256,
                as_of_sha256: handoff.built.asOfSha256,
                renderer_version: RENDERER_VERSION,
                from_provider: handoff.fromProvider,
                reason: handoff.reason,
              },
            }
          : stored;
      if (req.idempotencyKey !== undefined) {
        const prior = this.ledger.findRunByIdempotencyKey(req.clientId, req.idempotencyKey);
        if (prior) {
          if (prior.request_hash !== hash) {
            throw new LifecycleError("INVALID_REQUEST", "idempotency key reused with different parameters");
          }
          return { runId: prior.id, metaSessionId: prior.meta_session_id, state: prior.state, replayed: true };
        }
      }
      if (initial === "QUEUED" && this.ledger.countRunsInStates(QUEUE_STATES) >= this.maxQueueDepth) {
        throw new LifecycleError("QUEUE_FULL", `queue is full (${this.maxQueueDepth} runs waiting)`);
      }
      let metaSessionId = req.metaSessionId;
      if (metaSessionId !== undefined) {
        // R-42: authoritative check inside the admission transaction; retention GC marks ARCHIVED in its own one.
        const known = this.ledger.getMetaSession(metaSessionId);
        if (known?.status === "ARCHIVED") {
          throw new LifecycleError("INVALID_REQUEST", archivedMessage(metaSessionId));
        }
        // FR-PRJ-03 / BR-23: a meta-session keeps the project it was created in.
        if ((known?.project_id ?? undefined) !== req.project?.id) {
          throw new LifecycleError(
            "INVALID_REQUEST",
            known?.project_id
              ? `meta-session ${metaSessionId} belongs to project ${known.project_id} and stays in it`
              : `meta-session ${metaSessionId} was created without a project and stays without one`,
          );
        }
        const sessionRuns = this.ledger.listRunsForMetaSession(metaSessionId);
        const active = sessionRuns.find((r) => !isTerminal(r.state));
        if (active) {
          throw new LifecycleError("INVALID_REQUEST", `meta-session ${metaSessionId} has an active run ${active.id}`);
        }
        // T5.6 (Delegated, fail closed): the bundle was built outside this transaction, so it must still describe the
        // session as it is now: the same runs and the same base and head. Otherwise a run admitted and finished in
        // between would be missing from it; refuse with the bundle failure code and write nothing (ADR-0038 item 7).
        if (handoff && !this.handoffIsCurrent(metaSessionId, sessionRuns, handoff.built)) {
          throw new HandoffBundleError("the meta-session changed after the bundle was built");
        }
      } else {
        metaSessionId = this.ledger.createMetaSession({
          objective: stored.objective,
          constraints: stored.constraints,
          ...(req.project ? { projectId: req.project.id } : {}),
        }).id;
      }
      const privileged = priv === undefined ? undefined : this.bindPrivileged(priv, req.clientId, metaSessionId);
      const run = this.ledger.createRun({
        metaSessionId,
        state: initial,
        trustProfile: req.trustProfile,
        policySnapshot: req.project
          ? { ...(privileged?.snapshot ?? profile), project: req.project }
          : (privileged?.snapshot ?? profile),
        ...(req.project ? { projectId: req.project.id } : {}),
        request,
        // T5.5: so `request_hash` covers `handoff` (LLD §15.2); a handoff takes no idempotency key (continuation).
        requestHash: handoff && req.requestHash === undefined ? requestHash(request) : hash,
        clientId: req.clientId,
        idempotencyKey: req.idempotencyKey ?? null,
        provider: req.provider,
        priority: PRIORITY_VALUES[stored.priority],
        ...(req.successorOf ? { parentRunId: req.successorOf.runId, attempt: req.successorOf.attempt + 1 } : {}),
      });
      const byPolicy = priv?.kind === "request" && priv.clientPolicy;
      if (priv?.kind === "request" && privileged) {
        // FRD T2 / LLD §3.1: the PENDING row, in the same transaction as the run and its first event.
        this.ledger.createApproval({
          id: privileged.approvalId,
          runId: run.id,
          scopeJson: canonicalScopeJson(privileged.scope),
          scopeHash: privileged.scopeHash,
        });
        if (byPolicy) {
          // ADR-0019: the client's configuration stands in for the operator's `approve`; the row says so.
          const decided = this.ledger.decideApproval({
            id: privileged.approvalId,
            status: "APPROVED",
            decidedBy: `${CLIENT_POLICY_DECIDER_PREFIX}${req.clientId}`,
          });
          if (!decided) throw new Error(`approval ${privileged.approvalId} could not be decided by client policy`);
          // T5.3 (LLD §15.3): the decision row, in the transaction of the approval it records.
          this.ledger.appendDecision({
            kind: "approval_decided",
            runId: run.id,
            approvalId: privileged.approvalId,
            status: "APPROVED",
            by: "client_policy",
          });
        }
      }
      if (req.routeDecision) this.ledger.insertRouteDecision({ ...req.routeDecision, runId: run.id });
      // T5.3 (LLD §15.3): the controller's route choice; for a handoff (T5.6) the mode and the BR-18 reason code the
      // caller (`continue_task`) decided.
      this.ledger.appendDecision({
        kind: "route_selected",
        runId: run.id,
        provider: req.provider,
        mode: handoff ? "handoff" : req.resume ? "resume" : "new",
        reasons: [
          handoff
            ? handoff.reason
            : req.resume
              ? "same_provider_resume"
              : req.metaSessionId !== undefined
                ? "no_binding"
                : "new_session",
        ],
      });
      // T5.5 (LLD §15.7 step 6): the `handoff_view` row (with the pre-allocated id) and `handoff_built`, in this
      // transaction; a refusal throws HandoffBundleError and rolls the run back.
      if (handoff) {
        recordHandoffView(this.ledger, {
          receivingRunId: run.id,
          built: handoff.built,
          stored: handoff.stored,
          ...(viewId !== undefined ? { artifactId: viewId } : {}),
        });
      }
      const rule = initial === "QUEUED" ? "T1" : "T2";
      this.ledger.appendRunEvent({
        runId: run.id,
        type: "state_transition",
        // The approval is named by id only: never the scope or its hash (LLD §3.1 "What is shown where").
        payload: {
          from: null,
          to: initial,
          rule,
          ...(privileged ? { approval_id: privileged.approvalId } : {}),
          ...(byPolicy ? { approval: "client_policy" } : {}),
        },
      });
      if (byPolicy && privileged) {
        this.ledger.appendRunEvent({
          runId: run.id,
          type: APPROVAL_DECIDED_EVENT,
          payload: { approval_id: privileged.approvalId, status: "APPROVED", reason: "client_policy" },
        });
      }
      return { runId: run.id, metaSessionId, state: initial, replayed: false };
    });
    if (!result.replayed) queueMicrotask(() => this.pump());
    return result;
  }

  /**
   * Cancel per FRD §4.3 / BR-11. Waiting runs end CANCELLED at once; in-flight runs are flagged and their process group
   * is terminated, ending CANCELLED via FINALIZING asynchronously; FINALIZING and terminal runs are unchanged. Returns
   * the state after the call. A run in flight in no executor of this process is left to reconciliation (T1.9).
   */
  async cancel(runId: string, reason = "cancel_run", decidedBy = "cancel_run"): Promise<RunState> {
    const run = this.ledger.getRunRecord(runId);
    if (!run) throw new LifecycleError("INVALID_REQUEST", `unknown run ${runId}`);
    if (isTerminal(run.state) || run.state === "FINALIZING") return run.state;
    if (CANCELLABLE_DIRECT.has(run.state)) {
      let moved: RunRecord | undefined;
      try {
        moved = this.ledger.immediate(() => {
          // FRD §4.3 / Q-15: a waiting privileged run's PENDING approval is closed DENIED in the same transaction.
          denyApprovalOnCancel(this.ledger, run, decidedBy);
          const m = this.tryMove(run, "CANCELLED", { finished_at: this.nowIso() }, { reason }, "T19");
          if (!m) throw LOST_RACE; // roll back the approval decision too
          return m;
        });
      } catch (err) {
        if (err !== LOST_RACE) throw err;
      }
      if (moved) return moved.state;
      return this.cancel(runId, reason, decidedBy); // lost a race (e.g. dispatched meanwhile): re-read and re-decide
    }
    const exec = this.inflight.get(runId);
    if (!exec) return run.state;
    exec.cancelRequested = true;
    if (exec.handle) void exec.handle.cancel();
    return (this.ledger.getRunRecord(runId) as RunRecord).state;
  }

  /**
   * Apply one recorded operator `approve`/`deny` (T3.4, FRD T3/T19, WF-7) in one transaction (`./approval.ts`), then let
   * dispatch pick an approved run up. Throws `ApprovalRefusedError` (nothing written) when the decision no longer
   * applies. Returns the state after the call (QUEUED or CANCELLED).
   */
  applyApprovalDecision(req: DecisionToApply): RunState {
    const moved = applyApprovalDecision(this.ledger, req, {
      appliedBy: "serve",
      ...(this.opts.now ? { now: this.opts.now } : {}),
    });
    const rule = moved.state === "QUEUED" ? "T3" : "T19";
    this.opts.onTransition?.({ runId: moved.id, from: "AWAITING_APPROVAL", to: moved.state, rule });
    if (isTerminal(moved.state)) queueMicrotask(() => this.settle(moved.id));
    else queueMicrotask(() => this.pump());
    return moved.state;
  }

  /** Resolve with the run once it is terminal. */
  waitForTerminal(runId: string): Promise<RunRecord> {
    const run = this.ledger.getRunRecord(runId);
    if (!run) return Promise.reject(new LifecycleError("INVALID_REQUEST", `unknown run ${runId}`));
    if (isTerminal(run.state)) return Promise.resolve(run);
    return new Promise((resolve) => {
      const list = this.waiters.get(runId) ?? [];
      list.push(resolve);
      this.waiters.set(runId, list);
    });
  }

  /** The policy snapshot a profile resolves to (COMP-POL stand-in shared with the MCP layer). */
  resolveProfile(name: TrustProfile): ResolvedProfile {
    return this.opts.resolveProfile(name);
  }

  /** True when PREFLIGHT gates on the shared eligibility filter (`eligibility` option set). */
  get gatesEligibility(): boolean {
    return this.opts.eligibility !== undefined;
  }

  /** FRD V3/V4 (and C3): the canonical workspace path, or `LifecycleError` INVALID_REQUEST. */
  canonicalWorkspace(workspace: string, profile: TrustProfile): Promise<string> {
    return this.checkWorkspace(workspace, profile);
  }

  /**
   * What a continuation inherits from the meta-session's latest run (FRD C3/C4, WF-2): workspace, constraints, profile,
   * provider, priority and the client that owns it. Undefined for an unknown or empty meta-session.
   */
  metaSessionContext(metaSessionId: string): MetaSessionContext | undefined {
    const runs = this.ledger.listRunsForMetaSession(metaSessionId);
    const last = runs.at(-1);
    if (!last) return undefined;
    const stored = JSON.parse(last.request_json) as StoredRequest;
    return {
      workspace: stored.workspace,
      constraints: stored.constraints,
      trustProfile: last.trust_profile,
      provider: stored.provider,
      priority: stored.priority,
      clientId: last.client_id,
      projectId: this.ledger.getMetaSession(metaSessionId)?.project_id ?? undefined,
      activeRunId: runs.find((r) => !isTerminal(r.state))?.id,
    };
  }

  /**
   * T5.7 (LLD §15.6): where a resume of `nativeSessionId` on `provider` would run, checked read-only before admission
   * (`inspect`); `continue_task` turns an `unavailable` plan into a same-provider handoff before any write (T5.6).
   */
  resumeDirectoryPlan(q: ResumeDirectoryQuestion, inspect = true): Promise<ResumeDirectoryPlan> {
    return planResumeDirectory({ ledger: this.ledger, workspace: this.opts.workspace }, q, { inspect });
  }

  /**
   * BR-10 lookup before routing: the run already admitted for `(clientId, key)` when its hash matches, undefined when
   * the key is unused, `LifecycleError` INVALID_REQUEST when the key was used with different parameters.
   */
  findIdempotentRun(clientId: string, key: string, hash: string): RunRecord | undefined {
    const prior = this.ledger.findRunByIdempotencyKey(clientId, key);
    if (prior && prior.request_hash !== hash) {
      throw new LifecycleError("INVALID_REQUEST", "idempotency key reused with different parameters");
    }
    return prior;
  }

  /** Run the stage-1 eligibility filter with this lifecycle's registry, probe runner and eligibility deps. */
  async checkEligibility(q: EligibilityQuestion): Promise<EligibilityAnswer> {
    if (!this.opts.eligibility) throw new Error("eligibility dependencies are not configured");
    const profile = q.profile ?? this.opts.resolveProfile(q.trustProfile);
    const input = await collectFacts(
      {
        candidates: q.candidates,
        ...(q.requiredProvider !== undefined ? { requiredProvider: q.requiredProvider } : {}),
        trustProfile: q.trustProfile,
        clientMaxProfile: q.clientMaxProfile,
        profile,
        requirements: requirementsFor(q.trustProfile, profile),
        cwd: q.cwd,
      },
      {
        ...this.opts.eligibility,
        ...(this.opts.preflightCache && !this.opts.eligibility.preflight
          ? { preflight: this.opts.preflightCache }
          : {}),
        registry: this.opts.adapters,
        runner: this.runner,
      },
    );
    if (q.breaker !== false) {
      // T6.4 (LLD §16.4): an open breaker before its cool-down ends is a stage-1 reason (`CIRCUIT_OPEN`, BR-3).
      const now = this.now();
      for (const f of input.facts) {
        const b = this.breakerOf(f.provider);
        if (breakerAdmission(b, now) === "deny" && b.until !== null) f.circuitOpenUntil = b.until;
        // T6.6 (LLD §16.6, BR-3): a provider-reported reset still ahead after a QUOTA_EXHAUSTED run.
        const reset = this.knownQuotaReset(f.provider, now);
        if (reset !== undefined) f.quotaExhaustedUntil = new Date(reset).toISOString();
      }
    }
    return { input, decision: filterEligible(input) };
  }

  // ---- admission ----------------------------------------------------------------------------------------------

  /**
   * Builds the `privileged` policy snapshot inside the admission transaction (LLD §3.1). For a request: a fresh approval
   * ID and the v2 hash over (client, new meta-session, scope). For a continuation: the approval must be `APPROVED`,
   * belong to a run of this meta-session and client, and its stored hash must equal the recomputed one (FRD C7).
   */
  private bindPrivileged(
    priv: PrivilegedInput,
    clientId: string,
    metaSessionId: string,
  ): { snapshot: ResolvedProfile; scope: PrivilegedScope; scopeHash: string; approvalId: string } {
    const bad = (msg: string): never => {
      throw new LifecycleError("INVALID_REQUEST", msg);
    };
    let scope: PrivilegedScope;
    let scopeHash: string;
    let approvalId: string;
    if (priv.kind === "request") {
      scope = priv.scope;
      scopeHash = privilegedScopeHash({ clientId, metaSessionId, scope });
      approvalId = this.ledger.newApprovalId();
    } else {
      const approval = this.ledger.getApproval(priv.approvalId);
      const owner = approval ? this.ledger.getRunRecord(approval.run_id) : undefined;
      if (!approval || !owner || owner.meta_session_id !== metaSessionId || owner.client_id !== clientId) {
        return bad(`meta-session ${metaSessionId} has no approval for this client (FRD C7)`);
      }
      if (approval.status !== "APPROVED") {
        return bad(`meta-session ${metaSessionId} approval is ${approval.status}, not APPROVED (FRD C7)`);
      }
      const parsed = parsePrivilegedScope(JSON.parse(approval.scope_json) as unknown);
      if (!parsed.ok) return bad(`approval ${approval.id} holds an invalid scope (${parsed.field})`);
      scope = parsed.scope;
      scopeHash = privilegedScopeHash({ clientId, metaSessionId, scope });
      if (scopeHash !== approval.scope_hash) return bad(`approval ${approval.id} scope hash does not match (FRD C7)`);
      approvalId = approval.id;
    }
    const snapshot = resolveTrustProfile("privileged", { privileged: { scope, scopeHash, approvalId } });
    return { snapshot, scope, scopeHash, approvalId };
  }

  private async validate(req: SubmitRequest): Promise<StoredRequest> {
    const bad = (msg: string): never => {
      throw new LifecycleError("INVALID_REQUEST", msg);
    };
    if (typeof req.clientId !== "string" || req.clientId.length === 0) bad("clientId is required");
    if (typeof req.objective !== "string" || req.objective.trim().length === 0) bad("objective must be non-empty");
    if (!(TRUST_PROFILES as readonly string[]).includes(req.trustProfile)) bad(`unknown trust profile`);
    if (!this.opts.adapters.has(req.provider)) bad(`unknown provider ${String(req.provider)}`);
    const priority = req.priority ?? "normal";
    if (!(priority in PRIORITY_VALUES)) bad(`unknown priority`);
    const constraints = [...(req.constraints ?? [])];
    if (constraints.some((c) => typeof c !== "string")) bad("constraints must be strings");
    if (req.resume !== undefined) {
      if (req.metaSessionId === undefined) bad("resume applies to an existing meta-session only");
      if (typeof req.resume.nativeSessionId !== "string" || req.resume.nativeSessionId.length === 0) {
        bad("resume requires a native session id");
      }
    }
    if (req.trustProfile === "privileged") {
      const p = req.privileged;
      if (p === undefined) bad("the privileged profile requires a privileged scope (FRD V13) or an approval (FRD C7)");
      if (req.metaSessionId === undefined && !(p !== undefined && "scope" in p)) {
        bad("a new privileged meta-session requires a privileged scope (FRD V13)");
      }
      if (req.metaSessionId !== undefined && !(p !== undefined && "approvalId" in p)) {
        bad("a privileged continuation takes the meta-session's approved scope; it accepts no new scope (FRD C7)");
      }
    } else if (req.privileged !== undefined) {
      bad("a privileged scope or approval applies only to the privileged profile (FRD V13)");
    }
    const verification = (req.verificationCommands ?? []).map((c) => (Array.isArray(c) ? [...c] : c)) as string[][];
    if (verification.length > 0) {
      const problem = verificationCommandsProblem(verification);
      if (problem !== undefined) bad(problem);
      // FRD V7 (Proposed) and owner decision 11: host verification is allowed under every write-capable profile and
      // refused under inspect-untrusted.
      if (req.trustProfile === "inspect-untrusted") bad("verification commands are refused under inspect-untrusted");
      if (req.metaSessionId !== undefined) bad("verification commands apply to delegate_task only");
    }
    if (req.handoff !== undefined) this.validateHandoff(req, bad);
    if (req.idempotencyKey !== undefined) {
      if (req.metaSessionId !== undefined) bad("idempotency keys apply to new meta-sessions only");
      if (req.idempotencyKey.length < 8 || req.idempotencyKey.length > 128) bad("idempotency key length out of range");
    }

    let workspace: string;
    if (req.metaSessionId !== undefined) {
      const known = this.ledger.getMetaSession(req.metaSessionId);
      if (!known) bad(`unknown meta-session ${req.metaSessionId}`);
      if (known?.status === "ARCHIVED") bad(archivedMessage(req.metaSessionId));
      const first = this.ledger.listRunsForMetaSession(req.metaSessionId).at(-1);
      if (!first) return bad(`meta-session ${req.metaSessionId} has no runs`);
      workspace = (JSON.parse(first.request_json) as StoredRequest).workspace;
    } else {
      if (typeof req.workspace !== "string" || req.workspace.length === 0) return bad("workspace is required");
      workspace = req.workspace;
    }
    const canonical = await this.checkWorkspace(workspace, req.trustProfile);
    // Q-68 (NFR-SEC-01, Delegated, fail closed): the prompt text is redacted with the artifact secret patterns before it
    // is stored. The stored text is all that is kept, so it is also what this run and every continuation send.
    const objective = redactTextCounted(req.objective);
    const redactedConstraints = constraints.map(redactTextCounted);
    const redactions = objective.count + redactedConstraints.reduce((n, c) => n + c.count, 0);
    return {
      objective: objective.text,
      workspace: canonical,
      constraints: redactedConstraints.map((c) => c.text),
      trust_profile: req.trustProfile,
      provider: req.provider,
      priority,
      ...(req.metaSessionId !== undefined ? { meta_session_id: req.metaSessionId } : {}),
      ...(req.project ? { project_id: req.project.id, base_ref: req.project.base_ref } : {}),
      ...(req.resume !== undefined ? { resume_native_session_id: req.resume.nativeSessionId } : {}),
      ...(verification.length > 0 ? { verification_commands: verification } : {}),
      ...(redactions > 0 ? { admission_redactions: redactions } : {}),
    };
  }

  /**
   * T5.5: admission checks of a handoff submission, before any write. Malformed input is INVALID_REQUEST; a bundle the
   * renderer cannot turn into a prompt throws {@link HandoffBundleError} (`TOOL_FAILURE`, `HANDOFF_BUNDLE_UNAVAILABLE`).
   */
  private validateHandoff(req: SubmitRequest, bad: (msg: string) => never): void {
    const h = req.handoff as HandoffSubmission;
    if (req.metaSessionId === undefined) bad("a handoff applies to an existing meta-session only");
    if (req.resume !== undefined) bad("a handoff starts a fresh native session; it cannot resume one");
    if (!(HANDOFF_REASONS as readonly string[]).includes(h.reason)) bad("unknown handoff reason");
    if (typeof h.fromProvider !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(h.fromProvider)) {
      bad("handoff source provider is not a provider id");
    }
    if (h.built.bundle.as_of.meta_session_id !== req.metaSessionId)
      bad("the handoff bundle is of another meta-session");
    if (h.stored.sha256 !== h.built.sha256) bad("the stored handoff view does not match the built bundle");
    // Q-61 (ADR-0038 item 8): the same one constant `continue_task` reads (src/continuity/policy.ts, fail-closed
    // `refuse` while Q-61 is open), so this hook can never be a way around the check in continue_task.
    if (refusesPrivilegedCrossProvider(req.trustProfile, h.fromProvider, req.provider)) {
      bad("PRIVILEGED_CROSS_PROVIDER: a privileged meta-session cannot continue on another provider (Q-61)");
    }
    if ([...req.objective].length > MAX_INSTRUCTION_CHARS) bad("the instruction is too long for a handoff");
    // The prompt is rendered again at dispatch from the stored bytes (same input, same output); rendering it here
    // refuses an unusable bundle before anything is written.
    renderHandoffPrompt({ bundle: parseHandoffBundle(h.built.bytes), instruction: req.objective });
  }

  /** T5.6: the bundle's `as_of` still names exactly the session's runs, base and head (inside the admission transaction). */
  private handoffIsCurrent(metaSessionId: string, runs: readonly RunRecord[], built: BuiltBundle): boolean {
    const asOf = built.bundle.as_of;
    const meta = this.ledger.getMetaSessionContinuity(metaSessionId);
    const listed = new Set(asOf.runs.map((r) => r.run_id));
    return (
      meta !== undefined &&
      meta.base_commit === asOf.base_commit &&
      meta.head_commit === asOf.head_commit &&
      listed.size === runs.length &&
      runs.every((r) => listed.has(r.id))
    );
  }

  /** FRD V3/V4 and C3: canonical path under an allowed root; write-capable profiles need a Git repository. */
  private async checkWorkspace(workspace: string, profile: TrustProfile): Promise<string> {
    this.rootsCache ??= await Promise.all(this.opts.allowedRoots.map((r) => realpath(r)));
    let canonical: string;
    try {
      canonical = await realpath(workspace);
    } catch {
      throw new LifecycleError("INVALID_REQUEST", "workspace does not exist");
    }
    if (!isUnderAllowedRoot(canonical, this.rootsCache)) {
      throw new LifecycleError("INVALID_REQUEST", "workspace is not under an allowed root");
    }
    if (profile !== "inspect-untrusted") {
      let top: string;
      try {
        top = await realpath(await gitText(["rev-parse", "--show-toplevel"], { cwd: canonical }));
      } catch {
        throw new LifecycleError("INVALID_REQUEST", "write-capable profiles require a Git repository");
      }
      if (!isUnderAllowedRoot(top, this.rootsCache)) {
        throw new LifecycleError("INVALID_REQUEST", "repository root is not under an allowed root");
      }
    }
    return canonical;
  }

  // ---- dispatch -----------------------------------------------------------------------------------------------

  /** Move queued runs to PREFLIGHT while global (and per-provider) slots are free (T4, FR-CAP-04). */
  private pump(): void {
    if (!this.started || this.stopped) return;
    this.releaseDueWaiting();
    for (;;) {
      const picked = this.ledger.immediate((): RunRecord | undefined => {
        if (this.ledger.countRunsInStates(SLOT_STATES) >= this.opts.globalConcurrency) return undefined;
        const now = this.now();
        for (const run of this.ledger.listRunsInState("QUEUED")) {
          const limit =
            run.provider === null
              ? undefined
              : (this.opts.perProviderLimits?.get(run.provider) ?? this.opts.perProviderConcurrency);
          if (limit !== undefined && run.provider !== null) {
            if (this.ledger.countRunsInStates(SLOT_STATES, run.provider) >= limit) continue;
          }
          if (run.provider !== null && !this.breakerLetsThrough(run, now)) continue;
          return this.move(run, "PREFLIGHT", {}, { slot: "reserved" });
        }
        return undefined;
      });
      if (!picked) return;
      this.launch(picked.id);
    }
  }

  private launch(runId: string): void {
    const exec: Execution = { runId, cancelRequested: false, handle: undefined, done: Promise.resolve() };
    this.inflight.set(runId, exec);
    exec.done = this.execute(exec)
      .catch((err: unknown) => this.contain(exec, err))
      .finally(() => {
        this.inflight.delete(runId);
        this.pump();
      });
  }

  // ---- execution ----------------------------------------------------------------------------------------------

  private async execute(exec: Execution): Promise<void> {
    const runId = exec.runId;
    const run0 = this.current(runId);
    const req = JSON.parse(run0.request_json) as StoredRequest;
    // FR-POL-03: a stored `bypassApproved` is never trusted; only `evaluateBypass` below may set it.
    let profile: ResolvedProfile = {
      ...(JSON.parse(run0.policy_snapshot_json) as ResolvedProfile),
      bypassApproved: false,
    };
    if (run0.trust_profile === "privileged") {
      // T3.4 (LLD §3.1 "Bypass"): the approval check runs before anything is probed, leased, compiled or spawned. A
      // missing, undecided or mismatched approval fails the run PERMISSION_BLOCKED (PREFLIGHT -> FAILED, FRD T8) with
      // the failed check named in the transition event (never a hash or scope content).
      const verdict = evaluateBypass(this.ledger, run0);
      if (!verdict.ok) {
        return this.fail(
          runId,
          "PERMISSION_BLOCKED",
          `privileged approval check failed before spawn: ${verdict.mismatch}`,
          {
            reason: "APPROVAL_MISMATCH",
            mismatch: verdict.mismatch,
            ...(verdict.approvalId ? { approval_id: verdict.approvalId } : {}),
          },
        );
      }
      // Owner decisions 19 and 22: the adapter's compile decides from here on (preflight eligibility, then LEASED), with
      // `bypassApproved` taken only from the verdict. An adapter that cannot compile the scope ends the run with its
      // BR-3 code (T3.7 path); the argv audit still refuses a bypass flag unless `bypassApproved` (T3.17).
      profile = { ...profile, bypassApproved: verdict.bypassApproved };
      this.ledger.appendRunEvent({
        runId,
        type: PRIVILEGED_DISPATCH_EVENT,
        payload: { approval_id: verdict.approvalId, bypass_approved: verdict.bypassApproved },
      });
    }
    const adapter = this.opts.adapters.get(req.provider);
    if (!adapter) return this.fail(runId, "ELIGIBILITY_NONE", `adapter ${req.provider} is not registered`);
    // T5.5 (LLD §15.5): a handoff run's prompt is rendered from its stored view before anything is probed, leased or
    // spawned; a view that cannot be read, verified or rendered fails the run here (fail closed).
    let handoffPrompt: { prompt: string; ref: { bundleArtifactId: string; bundleSha256: string } } | undefined;
    if (req.handoff !== undefined) {
      try {
        handoffPrompt = await this.renderHandoff(runId, req.objective, req.handoff);
      } catch {
        return this.fail(runId, "TOOL_FAILURE", "the handoff view could not be read or rendered", {
          reason: HANDOFF_BUNDLE_UNAVAILABLE,
        });
      }
    }

    // PREFLIGHT (WF-6 order: probe, then auth; no login is ever attempted).
    const verdict = this.opts.eligibility
      ? await this.preflightEligibility(req, run0, profile)
      : await this.preflightM1(req, adapter);
    if (exec.cancelRequested) return this.cancelEarly(runId);
    if (!verdict.ok) return this.fail(runId, verdict.code, verdict.detail, verdict.extra);
    const binaryVersion = verdict.binaryVersion;

    // LEASED (T5): intent committed before the lease and worktree are created.
    this.move(this.current(runId), "LEASED", {}, { adapter_version: binaryVersion });
    // T5.7 (ADR-0038 item 6, LLD §15.6): a resume runs in its origin's worktree path unless the adapter declares
    // `independent`. The origin is resolved from records here and its directory re-checked inside `prepare`; any
    // failure ends the run before spawn with `resume_directory_unavailable`, never a resume in another directory.
    let resumeIn: { originPath: string } | undefined;
    if (req.resume_native_session_id !== undefined) {
      const plan = await this.resumeDirectoryPlan(
        {
          metaSessionId: run0.meta_session_id,
          provider: req.provider,
          nativeSessionId: req.resume_native_session_id,
          trustProfile: req.trust_profile,
          workspace: req.workspace,
          resumeCwd: adapter.resumeCwd,
        },
        false,
      );
      if (plan.kind === "unavailable") return this.failResumeDirectory(runId, plan.problem, plan.detail);
      if (plan.kind === "origin" && plan.originPath !== null) resumeIn = { originPath: plan.originPath };
    }
    let ws: PreparedWorkspace;
    try {
      ws = await this.opts.workspace.prepare({
        metaSessionId: run0.meta_session_id,
        runId,
        workspace: req.workspace,
        trustProfile: req.trust_profile,
        ...(req.base_ref !== undefined ? { baseRef: req.base_ref } : {}),
        ...(resumeIn ? { resumeIn } : {}),
        leaseTtlMs: this.opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      });
    } catch (err) {
      if (err instanceof ResumeDirectoryUnavailableError)
        return this.failResumeDirectory(runId, err.problem, err.message);
      return this.fail(runId, "TOOL_FAILURE", `workspace preparation failed: ${errorText(err)}`);
    }
    if (exec.cancelRequested) return this.cancelEarly(runId);
    if (ws.mode === "worktree") {
      // T9.5 (FR-GIT-03, LLD §12.5): the controller-visible Git state, recorded before the provider can touch it. A
      // repository that cannot be read here cannot be checked later, so the run fails before spawn (fail closed).
      try {
        await this.refGuard.snapshotAtLeased(runId);
      } catch (err) {
        return this.fail(runId, "TOOL_FAILURE", `git ref snapshot failed: ${errorText(err)}`, {
          reason: "GIT_REF_SNAPSHOT_FAILED",
        });
      }
    }

    const cwd = ws.mode === "worktree" ? ws.worktreePath : ws.path;
    const compileReq = {
      runId,
      // T5.5: a handoff run compiles the rendered bundle with the instruction last, and no separate constraints (the
      // bundle carries them); `handoff` is for the record only (no adapter reads it). Other runs are unchanged.
      objective: handoffPrompt ? handoffPrompt.prompt : req.objective,
      constraints: handoffPrompt ? [] : req.constraints,
      workspace: { cwd, writable: ws.mode === "worktree" },
      ...(handoffPrompt ? { handoff: handoffPrompt.ref } : {}),
    };
    let inv =
      req.resume_native_session_id !== undefined
        ? adapter.resumeArgs(
            { provider: req.provider, nativeSessionId: req.resume_native_session_id },
            compileReq,
            profile,
          )
        : adapter.compile(compileReq, profile);
    if (exec.cancelRequested) return this.cancelEarly(runId);
    if (isIneligible(inv)) {
      // T3.7 (FRD T10, BR-3, BR-5): with stage-1 eligibility, preflight's compile check passed, so this is a race or
      // a resume-only refusal (`resumeArgs`, or the worktree cwd, differs from the preflight compile). The adapter's reason maps to its BR-3 code (LLD §2),
      // normally ELIGIBILITY_NONE, never PERMISSION_BLOCKED: nothing was denied, the profile simply cannot be
      // compiled. The machine-readable reason is in the transition event. PERMISSION_BLOCKED stays for the client
      // ceiling, the privileged approval check and the argv bypass audit below.
      const code = failureCodeForIneligible(inv.reason);
      return this.fail(
        runId,
        code,
        `${req.provider} cannot compile ${run0.trust_profile}: ${inv.reason}: ${inv.detail}`,
        {
          reason: inv.reason,
          stage: "compile",
          eligibility: [{ code: reasonCodeForIneligible(inv.reason), detail: inv.detail.slice(0, 300) }],
        },
      );
    }
    // ADR-0039 (Q-62, Q-63): Switchboard's own pre-spawn refusals, whatever the provider's policy or trust would do.
    // A working directory that holds a provider state directory is refused for every run; repo-local agent config
    // (MCP servers, hooks) is refused while repoConfig is `disabled`.
    const stateReach = workspaceReachesProviderState(cwd, (this.opts.baseEnv ?? process.env).HOME);
    if (stateReach !== undefined) {
      return this.fail(runId, "PERMISSION_BLOCKED", `${req.provider}: ${stateReach}`, {
        reason: "PROVIDER_STATE_REACHABLE",
      });
    }
    const repoRefusal = repoAgentConfigRefusal(req.provider, effectiveRepoConfig(profile), cwd);
    if (repoRefusal !== undefined) {
      return this.fail(runId, "PERMISSION_BLOCKED", repoRefusal, { reason: "REPO_AGENT_CONFIG_REFUSED" });
    }
    if (ws.mode === "worktree") {
      this.opts.workspace.extendLease(runId, 2 * inv.timeouts.wallClockMs + inv.timeouts.killGraceMs);
    }

    // T9.4 (FR-GIT-02): the injected tool channel, opened just before spawn and closed as soon as the process exits.
    const nativeIds: string[] = req.resume_native_session_id !== undefined ? [req.resume_native_session_id] : [];
    /** T5.3: model and backing provider each `session_bound` event reported, by native session id. */
    const bound = new Map<string, { model: string | null; backingProvider: string | null }>();
    let channel: OpenChannel | undefined;
    let channelAudit: ChannelAuditContext | undefined;
    // T9.4b (ADR-0033, owner decision 41): an adapter may narrow its `injected` declaration per run (Claude Code: only
    // an approved bypass run). A run it declines is treated exactly like one of an adapter without a channel.
    const caps = adapter.gitCapabilities;
    const adapterOffers = caps.commitChannel === "injected" && (caps.offersChannel?.(compileReq, profile) ?? true);
    const runCommitChannel = caps.commitChannel === "injected" && !adapterOffers ? "none" : caps.commitChannel;
    if (ws.mode === "worktree") {
      const plan = gitChannelPlan(adapter, run0, this.opts.gitTools !== undefined && adapterOffers);
      if (plan.kind === "not_offered") {
        this.ledger.appendRunEvent({ runId, type: GIT_CHANNEL_NOT_OFFERED_EVENT, payload: { reason: plan.reason } });
      } else if (plan.kind === "offer" && this.opts.gitTools) {
        // T9.6 (BR-29, BR-31): `push` only for a frozen `branch` policy whose run keeps credentials out of reach.
        let offerPush = false;
        let pushExempt = false;
        if (plan.pushPolicy === "branch") {
          // Owner decision 37: an approved bypass (the same evaluateBypass verdict as the argv audit gate) is exempt.
          const approvedBypass = profile.bypassApproved && bypassApprovedFor(this.ledger, run0);
          const reach = credentialReachFromJson(run0.policy_snapshot_json, { approvedBypass });
          const withheld = !reach.ok ? reach.reason : this.opts.gitTools.pushAvailable ? undefined : "push_unavailable";
          if (withheld === undefined) {
            offerPush = true;
            pushExempt = reach.ok && reach.reason === "bypass_exempt";
          } else this.ledger.appendRunEvent({ runId, type: GIT_PUSH_WITHHELD_EVENT, payload: { reason: withheld } });
        }
        try {
          channel = await this.opts.gitTools.open({
            runId,
            metaSessionId: run0.meta_session_id,
            worktreePath: ws.worktreePath,
            identity: plan.identity,
            projectId: plan.projectId,
            contextId: plan.contextId,
            nativeSessionIds: () => nativeIds,
            offerPush,
            ...(offerPush && pushExempt ? { pushReach: "bypass_exempt" as const } : {}),
            ...(plan.sign ? { sign: true as const } : {}),
          });
        } catch (err) {
          if (!(err instanceof ChannelOpenError)) throw err;
          return this.fail(runId, "TOOL_FAILURE", `git tool channel could not be opened: ${err.message}`, {
            reason: "GIT_CHANNEL_UNAVAILABLE",
          });
        }
        const extra = adapter.gitCapabilities.channelArgs?.(channel.shim, compileReq, profile);
        if (extra === undefined || "ineligible" in extra) {
          await channel.close();
          const detail = extra === undefined ? "adapter declares no channelArgs" : `${extra.reason}: ${extra.detail}`;
          return this.fail(runId, "ELIGIBILITY_NONE", `${req.provider} cannot take the git tool channel: ${detail}`, {
            reason: "GIT_CHANNEL_INELIGIBLE",
          });
        }
        // T9.4b (ADR-0029 item 1): files the adapter asked for (the Claude MCP definition) are written by the channel
        // service into the run's private directory; the audit later admits `--mcp-config` only with this path.
        let mcpConfigPath: string | undefined;
        try {
          for (const f of extra.files ?? []) {
            const written = await channel.writeFile(f.name, f.contents);
            if (f.name === CHANNEL_MCP_CONFIG_FILE) mcpConfigPath = written;
          }
        } catch (err) {
          await channel.close();
          if (!(err instanceof ChannelOpenError) && !isFsError(err)) throw err;
          return this.fail(runId, "TOOL_FAILURE", `git tool channel files could not be written: ${errorText(err)}`, {
            reason: "GIT_CHANNEL_UNAVAILABLE",
          });
        }
        // ADR-0033: standalone flags the adapter drops for the channel (Claude `--safe-mode`); the audits recheck them.
        const remove = new Set(extra.removeFlags ?? []);
        if ([...remove].some((f) => !f.startsWith("--") || f.includes("="))) {
          await channel.close();
          return this.fail(runId, "ELIGIBILITY_NONE", `${req.provider} cannot take the git tool channel: bad flag`, {
            reason: "GIT_CHANNEL_INELIGIBLE",
          });
        }
        channelAudit = { toolNames: [...channel.shim.toolNames], ...(mcpConfigPath ? { mcpConfigPath } : {}) };
        inv = {
          ...inv,
          argv: [...inv.argv.filter((a) => !remove.has(a)), ...extra.argv],
          policyFlags: inv.policyFlags.filter((a) => !remove.has(a)),
          env: { ...inv.env, ...extra.env },
        };
      }
    }
    if (exec.cancelRequested) {
      // Opening the channel awaited: a cancel that arrived meanwhile must not be lost (no process exists yet).
      await channel?.close();
      return this.cancelEarly(runId);
    }

    // RUNNING (T9): pid/pgid persisted in the same transaction, before any output is read (LLD §8).
    let spawned = false;
    let out: AdapterRunOutcome;
    try {
      let agent: AdapterRun;
      try {
        agent = startAdapterRun(adapter, inv, {
          bypassApproved: profile.bypassApproved,
          // T3.17: the audit admits a bypass flag only for this profile being privileged with a scope that sets bypass.
          profile,
          // T9.4b: `--mcp-config` and MCP allow rules only in the channel's exact shape (ADR-0029 item 6).
          ...(channelAudit ? { channel: channelAudit } : {}),
          ...(this.opts.baseEnv ? { baseEnv: this.opts.baseEnv } : {}),
          // T4.8 (ADR-0036 item 9): an `acp-stdio` run answers permission requests from this frozen snapshot only.
          // No read-only context is passed yet (fail closed: reads outside the worktree are rejected).
          ...(inv.transport === "acp-stdio"
            ? {
                acp: {
                  snapshot: { profile, worktree: inv.cwd, writable: ws.mode === "worktree", readOnlyContexts: [] },
                  onRunEvent: (e) => this.ledger.appendRunEvent({ runId, type: e.type, payload: e.payload }),
                },
              }
            : {}),
          onSpawn: ({ pid, pgid }) => {
            this.move(
              this.current(runId),
              "RUNNING",
              { pid, pgid, proc_start_ticks: procStartTicks(pid), started_at: this.nowIso() },
              { pid, pgid },
            );
            spawned = true;
          },
          onEvent: (ev) => {
            if (ev.kind === "session_bound") {
              if (!nativeIds.includes(ev.nativeSessionId)) nativeIds.push(ev.nativeSessionId);
              // T5.3 (FR-ADP-10): remember what `session_bound` reported, for the binding row written after the run.
              if (!bound.has(ev.nativeSessionId)) {
                bound.set(ev.nativeSessionId, { model: ev.model ?? null, backingProvider: ev.backingProvider ?? null });
              }
            }
            this.ledger.appendRunEvent({ runId, type: "provider_event", payload: compactEvent(ev) });
          },
        });
      } catch (err) {
        // Nothing was spawned: close the channel (removing its socket and definition file) before the run is terminal.
        if (err instanceof BypassFlagError) {
          await channel?.close();
          return this.fail(runId, "PERMISSION_BLOCKED", err.message);
        }
        if (err instanceof McpConfigAuditError) {
          await channel?.close();
          return this.fail(runId, "PERMISSION_BLOCKED", err.message.slice(0, 500), { reason: "MCP_CONFIG_REFUSED" });
        }
        if (err instanceof AcpPlanAuditError) {
          await channel?.close();
          return this.fail(runId, "PERMISSION_BLOCKED", err.message.slice(0, 500), { reason: "ACP_PLAN_REFUSED" });
        }
        if (err instanceof IsolationAuditError) {
          await channel?.close();
          return this.fail(runId, "PERMISSION_BLOCKED", err.message.slice(0, 500), { reason: "ISOLATION_REFUSED" });
        }
        throw err;
      }
      exec.handle = agent;
      out = await agent.done;
    } finally {
      // LLD §12.2: the socket is closed and removed when the run leaves RUNNING; calls in progress finish first.
      await channel?.close();
    }
    const meta = run0.meta_session_id;
    const streams = await this.storeStreams(runId, meta, out);
    if (!spawned) {
      return this.fail(runId, "PROCESS_CRASH", `spawn failed (${out.exit.outcome})`, { artifacts: streams });
    }

    if (out.result.nativeSessionId) {
      // FR-SES-02/03: remember the native session (from structured output only) so continue_task can resume it.
      const reported = bound.get(out.result.nativeSessionId);
      this.ledger.recordProviderBinding({
        metaSessionId: meta,
        provider: req.provider,
        nativeSessionId: out.result.nativeSessionId,
        // T5.3 (FR-ADP-10, Delegated): the model `session_bound` reported, else the run's recorded model (as for usage
        // observations); the backing provider only when reported. Set at insert, never updated.
        model: reported?.model ?? this.current(runId).model,
        backingProvider: reported?.backingProvider ?? null,
      });
    }
    let pending = pendingOf(exec, out);
    const exitFields = { exit_code: out.exit.exitCode, exit_signal: out.exit.signal };
    const exitPayload = { exit_outcome: out.exit.outcome, group_empty: out.groupEmpty };
    const commands = req.verification_commands ?? [];
    let verification: VerificationOutcomeRecord | undefined;
    if (pending.kind === "success" && commands.length > 0) {
      // T11 (FR-EXE-08): the agent exited successfully and verification was supplied.
      this.move(this.current(runId), "VERIFYING", exitFields, { ...exitPayload, commands: commands.length }, "T11");
      verification = await this.verify(exec, runId, meta, ws, inv, commands);
      pending = verification.pending;
      const verified = verification;
      // T14: pending success, `TEST_FAILURE` (BR-16) or cancelled; the per-command summary is in the event.
      // T5.3 (LLD §15.3): the `verification_outcome` decision is written in the transaction of that T14 event.
      this.ledger.immediate(() => {
        recordVerificationDecision(this.ledger, runId, verified);
        this.move(
          this.current(runId),
          "FINALIZING",
          {},
          {
            pending: verified.pending.kind,
            ...(verified.pending.kind === "failure" ? { failure_code: verified.pending.code } : {}),
            verification: verified.summary,
          },
          "T14",
        );
      });
    } else {
      const rule = pending.kind === "success" ? "T12" : "T13";
      this.move(
        this.current(runId),
        "FINALIZING",
        exitFields,
        {
          pending: pending.kind,
          ...(pending.kind === "failure" ? { failure_code: pending.code } : {}),
          ...exitPayload,
        },
        rule,
      );
    }
    await this.finalize(
      runId,
      meta,
      ws,
      pending,
      out,
      verification ? { ...streams, ...verification.artifacts } : streams,
      {
        commitChannel: runCommitChannel,
        nativeSessionIds: nativeIds,
      },
      verification?.summary,
    );
  }

  /**
   * VERIFYING (T3.10; FR-EXE-08, BR-16, LLD §8.1): run the commands in the worktree, record each command's process
   * group on the run before reading output (reconciliation, WF-8), store the redacted `test_report` artifact and return
   * the pending outcome for T14. Never throws for a command's failure; a controller-side failure ends TOOL_FAILURE.
   */
  private async verify(
    exec: Execution,
    runId: string,
    metaSessionId: string,
    ws: PreparedWorkspace,
    inv: { envAllowlist: readonly string[]; timeouts: { wallClockMs: number; killGraceMs: number } },
    commands: readonly (readonly string[])[],
  ): Promise<VerificationOutcomeRecord> {
    if (ws.mode !== "worktree") {
      // Admission refuses verification under inspect-untrusted, the only profile without a worktree (fail closed).
      const detail = "verification requires a run worktree";
      return { pending: { kind: "failure", code: "TOOL_FAILURE", detail }, summary: [], artifacts: {} };
    }
    const { wallClockMs, killGraceMs } = inv.timeouts;
    // The stage may take up to one more wall clock: keep the lease ahead of it (as at LEASED).
    this.opts.workspace.extendLease(runId, 2 * wallClockMs + (commands.length + 1) * killGraceMs);
    const stage = startVerification({
      commands,
      cwd: ws.worktreePath,
      envAllowlist: verificationEnvAllowlist(inv.envAllowlist),
      ...(this.opts.baseEnv ? { baseEnv: this.opts.baseEnv } : {}),
      wallClockMs,
      killGraceMs,
      onSpawn: (index, { pid, pgid }) => {
        // LLD §8: pid, pgid and start ticks persisted before any output is read, so a restart can kill an orphan.
        this.ledger.updateRunFields(
          runId,
          { pid, pgid, proc_start_ticks: procStartTicks(pid) },
          { type: VERIFICATION_STARTED_EVENT, payload: { index, pid, pgid } },
        );
      },
      onCommandDone: (r) => {
        this.ledger.appendRunEvent({ runId, type: VERIFICATION_COMMAND_EVENT, payload: verificationSummary(r) });
      },
    });
    exec.handle = stage;
    if (exec.cancelRequested) void stage.cancel();
    const result: VerificationResult = await stage.done;
    const summary = result.commands.map(verificationSummary);
    const artifacts: Record<string, string> = {};
    try {
      const body = verificationReport(result, (b) => this.opts.artifacts.redactContent(b));
      const stored = await this.opts.artifacts.put(body);
      artifacts.test_report = this.ledger.insertArtifact({
        runId,
        metaSessionId,
        kind: "test_report",
        sha256: stored.sha256,
        sizeBytes: stored.sizeBytes,
        mediaType: "application/json",
      });
    } catch (err) {
      const detail = `verification report could not be stored: ${errorText(err)}`;
      return { pending: { kind: "failure", code: "TOOL_FAILURE", detail }, summary, artifacts };
    }
    let pending: Pending;
    if (result.outcome === "cancelled" || exec.cancelRequested) pending = { kind: "cancelled" };
    else if (result.internalError) {
      pending = { kind: "failure", code: "TOOL_FAILURE", detail: "controller error during verification" };
    } else if (result.outcome === "failed") {
      const first = result.commands.find((c) => c.outcome !== "passed");
      const what = first ? `command ${first.index} ${first.outcome}` : "a command failed";
      pending = {
        kind: "failure",
        code: "TEST_FAILURE",
        detail: `verification failed: ${what}${first?.exitCode != null ? ` (exit ${first.exitCode})` : ""}`,
      };
    } else pending = { kind: "success" };
    return { pending, summary, artifacts };
  }

  /** M1 preflight (no `eligibility` option): probe and auth only (T8 codes as in M1). */
  private async preflightM1(req: StoredRequest, adapter: ProviderAdapter): Promise<PreflightVerdict> {
    const cache = this.opts.preflightCache;
    const probe = cache ? await cache.probe(adapter, this.runner) : await adapter.probe(this.runner);
    const failedStep = probe.steps.find((s) => !s.ok);
    if (failedStep) {
      return {
        ok: false,
        code: "ELIGIBILITY_NONE",
        detail: `${req.provider}: preflight step ${failedStep.step} failed`,
      };
    }
    const auth = cache ? await cache.authPreflight(adapter, this.runner) : await adapter.authPreflight(this.runner);
    if (auth.state === "AUTH_REQUIRED") {
      return {
        ok: false,
        code: "AUTH_REQUIRED",
        detail: `${req.provider} is not logged in; run \`${auth.loginCommand}\``,
        extra: { login_command: auth.loginCommand },
      };
    }
    if (auth.state === "UNKNOWN")
      return { ok: false, code: "ELIGIBILITY_NONE", detail: `${req.provider}: auth state unknown` };
    return { ok: true, binaryVersion: probe.binaryVersion };
  }

  /**
   * T2.4 preflight: the shared stage-1 filter with the run's provider as the required provider (BR-2, BR-20). The
   * client ceiling was enforced at admission (BR-13), so the run's own profile is passed as the ceiling here (Proposed).
   * An exclusion ends the run FAILED with the BR-3 code (T8) and the reasons in the event payload.
   */
  private async preflightEligibility(
    req: StoredRequest,
    run: RunRecord,
    profile: ResolvedProfile,
  ): Promise<PreflightVerdict> {
    // T3.7: compile against the run's frozen policy snapshot (what LEASED will compile), not a fresh resolution.
    const { input, decision } = await this.checkEligibility({
      candidates: [req.provider],
      requiredProvider: req.provider,
      trustProfile: run.trust_profile,
      clientMaxProfile: run.trust_profile,
      cwd: req.workspace,
      profile,
      breaker: false,
    });
    const binaryVersion = input.facts.find((f) => f.provider === req.provider)?.probe?.binaryVersion ?? null;
    if (decision.outcome.kind === "eligible") return { ok: true, binaryVersion };
    const excluded = decision.excluded[0];
    const code = excluded ? failureCodeForReason(excluded.primary.code) : decision.outcome.failureCode;
    const login = excluded?.reasons.find((r) => r.code === "AUTH_REQUIRED")?.evidence.loginCommand;
    // FR-AUTH-02: name the native login command the operator runs (never run by Switchboard).
    const message =
      typeof login === "string" ? `${decision.outcome.message}; run \`${login}\` natively` : decision.outcome.message;
    return {
      ok: false,
      code,
      detail: message.slice(0, 500),
      extra: {
        eligibility: (excluded?.reasons ?? []).map((r) => ({ code: r.code, detail: r.detail.slice(0, 300) })),
        ...(typeof login === "string" ? { login_command: login } : {}),
      },
    };
  }

  /** Run `fn` after every earlier call for the same repository root has settled (T9.11; `repoFinalizeQueue`). */
  private async serialisedPerRepo<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.repoFinalizeQueue.get(repoRoot) ?? Promise.resolve();
    let release = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.repoFinalizeQueue.set(repoRoot, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.repoFinalizeQueue.get(repoRoot) === tail) this.repoFinalizeQueue.delete(repoRoot);
    }
  }

  /** FINALIZING → terminal (T15–T17): checkpoint, diff, head disposition (FRD §4.4), lease release. */
  private async finalize(
    runId: string,
    metaSessionId: string,
    ws: PreparedWorkspace,
    pending: Pending,
    out: AdapterRunOutcome,
    streams: Record<string, string>,
    git: { commitChannel: "injected" | "finalize-only" | "none"; nativeSessionIds: readonly string[] },
    verification?: readonly Record<string, unknown>[],
  ): Promise<void> {
    let outcome = pending;
    const artifacts: Record<string, string> = { ...streams };
    let changedFiles = 0;
    let changedPaths: readonly string[] = [];
    let nestedSkipped: readonly string[] = [];
    let gitViolations = 0;
    let finalizeCommit: FinalizeCommitOutcome | undefined;
    // T6.5 (BR-7): only an assessed worktree equal to its pre-run checkpoint may be retried (fail closed otherwise).
    let retryEligible: boolean | undefined;
    if (ws.mode === "worktree") {
      try {
        // T9.5 (FR-GIT-03, BR-27): compare refs with the LEASED snapshot and put controller-owned refs back BEFORE the
        // checkpoint, so an agent's commits end up as working-tree content of the checkpoint, never in its history.
        // It never throws for Git problems (recorded as a violation) and never changes the outcome.
        // T9.11: serialised per repository with other runs' ref checks and checkpoints (see `repoFinalizeQueue`).
        const success = outcome.kind === "success";
        const { assessment, fin } = await this.serialisedPerRepo(ws.repoRoot, async () => {
          gitViolations = (await this.refGuard.checkAtFinalizing(runId)).violations;
          const assessment = await this.opts.workspace.assessMutation(runId);
          const fin = await this.opts.workspace.finalize(runId, { advanceHead: success });
          return { assessment, fin };
        });
        artifacts.diff = fin.diffArtifactId;
        artifacts.changed_files = fin.changedFilesArtifactId;
        changedFiles = fin.changedFiles.length;
        changedPaths = fin.changedFiles.map((f) => f.path);
        nestedSkipped = fin.nestedRepositories;
        const failureCode = outcome.kind === "failure" ? outcome.code : undefined;
        retryEligible = !assessment.mutated;
        this.ledger.appendRunEvent({
          runId,
          type: "workspace_assessment",
          payload: {
            mutated: assessment.mutated,
            reasons: assessment.reasons,
            replay_eligible: assessment.replayEligible,
            // Q-31 / ADR-0022: non-fatal warning; files inside these nested repositories are not captured.
            ...(fin.nestedRepositories.length > 0 ? { nested_repositories_skipped: fin.nestedRepositories } : {}),
            // BR-7 (T6.5): a retry-eligible failure is retried automatically unless a stop condition of LLD §16.5
            // applies; the outcome is the `retry_scheduled` or `retry_not_scheduled` event of the terminal transaction.
            retry_eligible: failureCode !== undefined && RETRYABLE.has(failureCode) && !assessment.mutated,
            auto_retry: failureCode !== undefined && RETRYABLE.has(failureCode) && !assessment.mutated,
          },
        });
        this.ledger.appendRunEvent({
          runId,
          type: "checkpoint",
          artifactId: fin.diffArtifactId,
          payload: { kind: "post", commit: fin.postCommit, committed: fin.committed, changed_files: changedFiles },
        });
        if (!success) {
          // FRD §4.4: the meta-session head stays at / returns to the pre-run checkpoint; never replay (FR-WS-04).
          this.ledger.setMetaSessionHead(metaSessionId, ws.baseCommit);
          // T5.3 (LLD §15.3): the `rollback` decision shares a transaction with the `rollback` event.
          this.ledger.immediate(() => {
            this.ledger.appendRunEvent({
              runId,
              type: "rollback",
              payload: { head: ws.baseCommit, evidence_commit: fin.postCommit, mutated: assessment.mutated },
            });
            this.ledger.appendDecision({
              kind: "rollback",
              runId,
              head: ws.baseCommit,
              evidenceCommit: fin.postCommit,
              mutated: assessment.mutated,
            });
          });
        }
      } catch (err) {
        if (outcome.kind !== "failure") {
          outcome = { kind: "failure", code: "TOOL_FAILURE", detail: `finalization failed: ${errorText(err)}` };
        }
      }
      // T9.7 (FR-GIT-09, BR-30): after the ref check and the evidence checkpoint, an opted-in run whose adapter cannot
      // take the channel gets one controller commit on the publish ref. It never changes the run's outcome.
      finalizeCommit = await this.finalizeOnlyCommit(runId, metaSessionId, outcome.kind === "success", {
        ...git,
        changedPaths,
        summary: out.result.summary === undefined ? undefined : redactText(out.result.summary),
      });
    }

    const payload = {
      artifacts,
      changed_files: changedFiles,
      ...(gitViolations > 0 ? { git_policy_violation: true } : {}),
      ...(finalizeCommit?.outcome === "committed" ? { finalize_commit: finalizeCommit.commitSha } : {}),
      ...(finalizeCommit !== undefined && finalizeCommit.outcome !== "committed"
        ? { finalize_commit_skipped: finalizeCommit.reason }
        : {}),
      ...(nestedSkipped.length > 0 ? { nested_repositories_skipped: nestedSkipped } : {}),
      ...(out.result.summary ? { summary: out.result.summary.slice(0, SUMMARY_MAX) } : {}),
      ...(out.result.nativeSessionId ? { native_session_id: out.result.nativeSessionId } : {}),
      ...(verification ? { verification } : {}),
    };
    const finished = this.nowIso();
    this.ledger.immediate(() => {
      this.opts.workspace.releaseLease(runId);
      const run = this.current(runId);
      // FR-CAP-01 (T2.5): provider-reported usage is stored in the terminal transaction; nothing when none was reported.
      for (const obs of usageObservationsFromEvents(out.events, {
        runId,
        provider: run.provider ?? "unknown",
        model: run.model,
      })) {
        this.ledger.insertUsageObservation(obs);
      }
      if (outcome.kind === "success") this.move(run, "SUCCEEDED", { finished_at: finished }, payload);
      else if (outcome.kind === "cancelled") {
        this.move(run, "CANCELLED", { finished_at: finished }, { ...payload, code: "CANCELLED" });
      } else {
        const failed = this.move(
          run,
          "FAILED",
          { failure_code: outcome.code, failure_detail: outcome.detail, finished_at: finished },
          payload,
        );
        // T6.5 (FRD T16, BR-6, BR-7): after the breaker step of the same transition, in the same transaction.
        this.scheduleRetry(failed, outcome.code, retryEligible);
      }
    });
    // T6.6 (BR-6 step 2 and 3, BR-8, BR-9): after the terminal transaction, because a failover builds a bundle.
    if (outcome.kind === "failure" && outcome.code === "QUOTA_EXHAUSTED") await this.quotaLadder(runId);
  }

  /**
   * T9.7: the finalize-only commit (`src/git/finalize.ts`), recorded as one `git_finalize_commit` event. Returns
   * undefined (and records nothing) when finalize-only does not apply to the run. Never throws.
   */
  private async finalizeOnlyCommit(
    runId: string,
    metaSessionId: string,
    succeeded: boolean,
    input: {
      commitChannel: "injected" | "finalize-only" | "none";
      nativeSessionIds: readonly string[];
      changedPaths: readonly string[];
      summary: string | undefined;
    },
  ): Promise<FinalizeCommitOutcome | undefined> {
    try {
      const run = this.current(runId);
      const project = finalizeCommitPlan(input.commitChannel, run.policy_snapshot_json);
      if (project === undefined) return undefined;
      const events = this.ledger.listRunEvents(runId);
      const finalizing = events.findLast((e) => {
        if (e.type !== "state_transition") return false;
        return (JSON.parse(e.payload_json) as { to?: unknown }).to === "FINALIZING";
      });
      const result = await makeFinalizeCommit(this.opts.finalizePublisher, {
        runId,
        project,
        succeeded,
        gitPolicyViolation: succeeded && sessionHasGitPolicyViolation(this.ledger, metaSessionId),
        changedPaths: input.changedPaths,
        summary: input.summary,
        nativeSessionIds: input.nativeSessionIds,
        finalizingEventId: finalizing?.id,
        // Owner decision 44 (Q-45): the same ledger evaluation as the BR-31 exemption; fails closed.
        approvedBypass: approvedBypassFor(this.ledger, run),
        // T9.10 (FR-GIT-10, BR-33): BR-31 for signing, with the same controller-verified bypass exemption as `push`.
        ...(project.sign === true
          ? {
              signReach: signingReachFromJson(run.policy_snapshot_json, {
                approvedBypass: approvedBypassFor(this.ledger, run),
              }),
            }
          : {}),
      });
      this.ledger.appendRunEvent({
        runId,
        type: GIT_FINALIZE_COMMIT_EVENT,
        payload: finalizeCommitEventPayload(result),
      });
      return result;
    } catch {
      // A ledger or snapshot problem here must not change the run's outcome (NFR-REL-02); no commit is claimed.
      return { outcome: "failed", reason: "INTERNAL_ERROR" };
    }
  }

  private async storeStreams(runId: string, metaSessionId: string, out: AdapterRunOutcome) {
    const ids: Record<string, string> = {};
    for (const [kind, buf] of [
      ["provider_stdout", out.stdout],
      ["provider_stderr", out.stderr],
    ] as const) {
      const stored = await this.opts.artifacts.put(buf);
      ids[kind] = this.ledger.insertArtifact({
        runId,
        metaSessionId,
        kind,
        sha256: stored.sha256,
        sizeBytes: stored.sizeBytes,
        mediaType: kind === "provider_stdout" ? "application/x-ndjson" : "text/plain",
      });
    }
    return ids;
  }

  /**
   * T5.5: read this run's `handoff_view` (row of this run, kind and hash as recorded, not collected; the store verifies
   * the content address), check its `as_of` hash and render it with `instruction`. Throws on any mismatch.
   */
  private async renderHandoff(
    runId: string,
    instruction: string,
    h: StoredHandoff,
  ): Promise<{ prompt: string; ref: { bundleArtifactId: string; bundleSha256: string } }> {
    const row = this.ledger.getArtifact(h.bundle_artifact_id);
    if (
      row?.kind !== "handoff_view" ||
      row.run_id !== runId ||
      row.deleted_at !== null ||
      row.sha256 !== h.bundle_sha256 ||
      h.renderer_version !== RENDERER_VERSION
    ) {
      throw new HandoffBundleError("the handoff view row does not match the run's request");
    }
    const bundle = parseHandoffBundle(await this.opts.artifacts.get(row.sha256));
    if (requestHash(bundle.as_of) !== h.as_of_sha256) throw new HandoffBundleError("the view's as_of does not match");
    const { prompt } = renderHandoffPrompt({ bundle, instruction });
    return { prompt, ref: { bundleArtifactId: row.id, bundleSha256: row.sha256 } };
  }

  // ---- terminal helpers -----------------------------------------------------------------------------------------

  /** Direct failure from PREFLIGHT (T8) or LEASED (T10); releases any lease in the same transaction. */
  private fail(runId: string, code: FailureCode, detail: string, extra: Record<string, unknown> = {}): void {
    this.ledger.immediate(() => {
      this.opts.workspace.releaseLease(runId);
      this.move(
        this.current(runId),
        "FAILED",
        { failure_code: code, failure_detail: detail, finished_at: this.nowIso() },
        extra,
      );
    });
  }

  /**
   * T5.7: a resume whose origin directory is unusable ends before spawn (LEASED → FAILED, as a workspace preparation
   * failure) with `TOOL_FAILURE` and `reason: resume_directory_unavailable`; nothing ran in any directory.
   */
  private failResumeDirectory(runId: string, problem: ResumeUnavailableProblem, detail: string): void {
    this.fail(runId, "TOOL_FAILURE", `native resume not attempted: ${detail}`, {
      reason: RESUME_DIRECTORY_UNAVAILABLE,
      problem,
    });
  }

  /** Cancel before a process exists (T19 from PREFLIGHT or LEASED, FRD §4.3): slot and lease released, no workspace change. */
  private cancelEarly(runId: string): void {
    this.ledger.immediate(() => {
      this.opts.workspace.releaseLease(runId);
      this.move(this.current(runId), "CANCELLED", { finished_at: this.nowIso() }, { code: "CANCELLED" }, "T19");
    });
  }

  /** NFR-REL-02: a controller-side exception fails only this run. */
  private async contain(exec: Execution, err: unknown): Promise<void> {
    try {
      await exec.handle?.cancel();
      const detail = `controller error: ${errorText(err)}`;
      const run = this.ledger.getRunRecord(exec.runId);
      if (!run || isTerminal(run.state)) return;
      this.ledger.immediate(() => {
        this.opts.workspace.releaseLease(exec.runId);
        let cur = this.current(exec.runId);
        if (cur.state === "RUNNING" || cur.state === "VERIFYING") {
          const rule = cur.state === "RUNNING" ? "T13" : "T14";
          cur = this.move(cur, "FINALIZING", {}, { pending: "failure", failure_code: "TOOL_FAILURE" }, rule);
        }
        this.move(cur, "FAILED", { failure_code: "TOOL_FAILURE", failure_detail: detail, finished_at: this.nowIso() });
      });
    } catch {
      // Last resort: leave the run for startup reconciliation (WF-8) rather than crash the controller.
    }
  }

  // ---- transitions --------------------------------------------------------------------------------------------

  /**
   * Guarded, ledger-persisted transition: the FRD guard first, then compare-and-set plus `state_transition` event in one
   * transaction (LLD §10). Throws on an illegal edge or a lost race.
   */
  private move(
    run: RunRecord,
    to: RunState,
    set: RunFieldPatch = {},
    payload: Record<string, unknown> = {},
    ruleId?: string,
  ): RunRecord {
    const moved = this.tryMove(run, to, set, payload, ruleId);
    if (!moved) throw new Error(`run ${run.id} changed concurrently (expected ${run.state} v${run.version})`);
    return moved;
  }

  private tryMove(
    run: RunRecord,
    to: RunState,
    set: RunFieldPatch,
    payload: Record<string, unknown>,
    ruleId?: string,
  ): RunRecord | undefined {
    const rule = resolveRule(run.state, to, ruleId);
    const moved = this.ledger.casRunState({
      runId: run.id,
      from: run.state,
      to,
      expectedVersion: run.version,
      // NFR-SEC-01, FR-TEL-03: failure detail and the provider's summary are provider-reported text; a credential-shaped
      // token in either must not reach the ledger (the stream artifacts are redacted at storage time, these are not).
      set: typeof set.failure_detail === "string" ? { ...set, failure_detail: redactText(set.failure_detail) } : set,
      payload: {
        rule: rule.id,
        ...payload,
        ...(typeof payload.summary === "string" ? { summary: redactText(payload.summary) } : {}),
      },
    });
    if (!moved) return undefined;
    if (isTerminal(to)) this.recordBreakerOutcome(moved);
    this.opts.onTransition?.({ runId: run.id, from: run.state, to, rule: rule.id });
    if (isTerminal(to)) queueMicrotask(() => this.settle(run.id));
    return moved;
  }

  // ---- per-provider breaker (T6.4; FR-CAP-04, LLD §16.4) ------------------------------------------------------

  private breakerOf(provider: string): BreakerSnapshot {
    const row = this.ledger.getProviderHealth(provider);
    return row === undefined
      ? CLOSED_BREAKER
      : {
          state: row.breaker_state,
          until: row.breaker_until,
          consecutiveFailures: row.consecutive_failures,
          lastFailureCode: row.last_failure_code,
        };
  }

  /**
   * FRD T4 guard: a run whose provider breaker is open waits in QUEUED (a wake is armed for the cool-down end); once
   * the cool-down has passed, or while `HALF_OPEN`, one run at a time goes through as the probe. Called inside the
   * dispatch transaction; writes `HALF_OPEN` and its event when the probe is the first run after the cool-down.
   */
  private breakerLetsThrough(run: RunRecord, now: Date): boolean {
    const provider = run.provider as string;
    const b = this.breakerOf(provider);
    const admission = breakerAdmission(b, now);
    if (admission === "allow") return true;
    if (admission === "deny") {
      if (b.until !== null) this.scheduleWake(Date.parse(b.until));
      return false;
    }
    if (this.ledger.countRunsInStates(SLOT_STATES, provider) > 0) return false; // the probe is in flight
    if (b.state === "OPEN") {
      this.ledger.writeProviderBreaker(provider, { ...b, state: "HALF_OPEN" });
      this.ledger.appendRunEvent({ runId: run.id, type: "breaker_half_open", payload: { provider } });
    }
    return true;
  }

  /** LLD §16.4 table, at every terminal transition of a routed run, in the transition's transaction. */
  private recordBreakerOutcome(run: RunRecord): void {
    if (run.provider === null) return;
    const outcome = breakerOutcome(run);
    if (outcome === "neutral") return;
    const provider = run.provider;
    this.ledger.immediate(() => {
      const cur = this.breakerOf(provider);
      const { next, transition } = applyBreakerOutcome(
        cur,
        outcome,
        run.failure_code,
        this.opts.breaker ?? DEFAULT_BREAKER,
        this.now(),
      );
      if (next === cur) return;
      this.ledger.writeProviderBreaker(provider, next);
      if (transition === "breaker_opened") {
        this.ledger.appendRunEvent({
          runId: run.id,
          type: transition,
          payload: { provider, consecutive_failures: next.consecutiveFailures, until: next.until },
        });
      } else if (transition === "breaker_closed") {
        this.ledger.appendRunEvent({ runId: run.id, type: transition, payload: { provider } });
      }
    });
  }

  /** Arm the single wake timer for `atMs` (epoch ms) unless an earlier one is armed; it re-runs `pump()`. */
  private scheduleWake(atMs: number): void {
    if (this.stopped || !Number.isFinite(atMs)) return;
    if (this.wakeAt !== undefined && this.wakeAt <= atMs) return;
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
    this.wakeAt = atMs;
    const delay = Math.max(0, Math.min(atMs - this.now().getTime(), MAX_TIMER_MS));
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.wakeAt = undefined;
      this.pump();
    }, delay);
    this.wakeTimer.unref?.();
  }

  // ---- automatic retry (T6.5; FR-CAP-05, FR-MCP-10, LLD §16.5) ---------------------------------------------------

  /**
   * LLD §16.5 at T16: a retryable failure on an unchanged worktree gets a successor in `WAITING_CAPACITY` unless a stop
   * condition applies; either way one event on the failed run says what happened. Runs in the caller's transaction.
   */
  private scheduleRetry(failed: RunRecord, code: FailureCode, workspaceUnchanged: boolean | undefined): void {
    if (!RETRYABLE.has(code) || failed.provider === null) return;
    const settings = this.opts.retry ?? DEFAULT_RETRY;
    const now = this.now();
    const notScheduled = (reason: string, extra: Record<string, unknown> = {}) =>
      this.ledger.appendRunEvent({ runId: failed.id, type: "retry_not_scheduled", payload: { reason, ...extra } });
    if (workspaceUnchanged !== true) {
      notScheduled(workspaceUnchanged === false ? "workspace_changed" : "workspace_not_assessed");
      return;
    }
    if (failed.attempt >= settings.maxAttempts) {
      notScheduled("attempts_exhausted", { attempt: failed.attempt, max_attempts: settings.maxAttempts });
      return;
    }
    if (breakerAdmission(this.breakerOf(failed.provider), now) === "deny") {
      notScheduled("breaker_open");
      return;
    }
    const resetAt = latestResetAt(this.ledger.listRunEvents(failed.id));
    const waitForReset = resetAt === undefined ? 0 : Math.max(0, resetAt - now.getTime());
    const bound = Math.max(settings.capMs, (settings.queueHorizonSeconds ?? 0) * 1000);
    if (waitForReset > bound) {
      notScheduled("reset_beyond_bound", { reset_at: new Date(resetAt as number).toISOString(), bound_ms: bound });
      return;
    }
    const ceiling = Math.min(settings.capMs, settings.baseMs * 2 ** (failed.attempt - 1));
    const jitter = Math.floor((this.opts.random ?? Math.random)() * ceiling);
    const delay = Math.max(jitter, waitForReset);
    const notBefore = new Date(now.getTime() + delay).toISOString();
    const successor = { id: this.createSuccessor(failed, notBefore, code) };
    this.ledger.appendRunEvent({
      runId: failed.id,
      type: "retry_scheduled",
      payload: { successor_run_id: successor.id, attempt: failed.attempt + 1, delay_ms: delay, not_before: notBefore },
    });
    this.scheduleWake(Date.parse(notBefore));
  }

  // ---- quota exhaustion ladder (T6.6; FR-CAP-06, BR-8, BR-9, LLD §16.6) ------------------------------------------

  /** The latest provider-reported reset after a `QUOTA_EXHAUSTED` run of `provider`, if it is still ahead (epoch ms). */
  private knownQuotaReset(provider: string, now: Date): number | undefined {
    let latest: number | undefined;
    for (const run of this.ledger.listRecentQuotaExhaustedRuns(provider, QUOTA_RESET_LOOKBACK)) {
      const reset = latestResetAt(this.ledger.listRunEvents(run.id));
      if (reset !== undefined && reset > now.getTime() && (latest === undefined || reset > latest)) latest = reset;
    }
    return latest;
  }

  /**
   * LLD §16.6 after a run ended `QUOTA_EXHAUSTED`: fail over through the M5 handoff when the request permits it, else
   * wait for a provider-reported reset within the horizon, else nothing more. One `quota_ladder` event on the failed run
   * records the outcome and why each earlier step did not apply. Never throws (NFR-REL-02).
   */
  private async quotaLadder(failedId: string): Promise<void> {
    const failed = this.ledger.getRunRecord(failedId);
    if (!failed || failed.state !== "FAILED" || failed.provider === null || this.stopped) return;
    const notes: string[] = [];
    const record = (payload: Record<string, unknown>) =>
      this.ledger.appendRunEvent({ runId: failed.id, type: "quota_ladder", payload: { ...payload, not_taken: notes } });
    try {
      const settings = this.opts.retry ?? DEFAULT_RETRY;
      if (failed.attempt >= settings.maxAttempts) {
        record({ outcome: "returned", reason: "attempts_exhausted" });
        return;
      }
      const target = await this.failoverTarget(failed, notes);
      if (target !== undefined) {
        const successor = await this.submitFailover(failed, target, notes);
        if (successor !== undefined) {
          record({ outcome: "failover", successor_run_id: successor, to_provider: target });
          return;
        }
      }
      const now = this.now();
      const reset = latestResetAt(this.ledger.listRunEvents(failed.id));
      const horizonMs = (settings.queueHorizonSeconds ?? 0) * 1000;
      if (reset === undefined || reset <= now.getTime()) notes.push("wait:no_reported_reset");
      else if (reset - now.getTime() > horizonMs) notes.push("wait:reset_beyond_horizon");
      else {
        const notBefore = new Date(reset).toISOString();
        const id = this.ledger.immediate(() => this.createSuccessor(failed, notBefore, "QUOTA_EXHAUSTED"));
        this.scheduleWake(reset);
        record({ outcome: "wait", successor_run_id: id, not_before: notBefore });
        return;
      }
      record({ outcome: "returned" });
    } catch (err) {
      try {
        record({ outcome: "returned", error: errorText(err).slice(0, 200) });
      } catch {
        // The failure stands as recorded; nothing else to do (NFR-REL-02).
      }
    }
  }

  /** BR-8 permission and the first eligible other provider (BR-4 order), or undefined with the reasons in `notes`. */
  private async failoverTarget(failed: RunRecord, notes: string[]): Promise<ProviderId | undefined> {
    if (failed.trust_profile === "privileged") {
      notes.push("failover:privileged_cross_provider"); // Q-61 default (ADR-0038 item 8)
      return undefined;
    }
    const decision = this.ledger.getRouteDecision(failed.id);
    if (decision === undefined) {
      notes.push("failover:no_route_decision"); // fail closed: whether the request permitted it is unknown
      return undefined;
    }
    const features = JSON.parse(decision.features_json) as { required_provider?: string | null };
    if (features.required_provider !== null && features.required_provider !== undefined) {
      notes.push("failover:require_provider");
      return undefined;
    }
    const reasons = JSON.parse(decision.reasons_json) as { project?: { excluded_providers?: string[] } };
    const excluded = new Set([failed.provider as string, ...(reasons.project?.excluded_providers ?? [])]);
    const admitted = (JSON.parse(decision.candidates_json) as { provider: string; eligible: boolean }[])
      .filter((c) => c.eligible && !excluded.has(c.provider))
      .map((c) => c.provider as ProviderId);
    if (admitted.length === 0) {
      notes.push("failover:no_other_candidate");
      return undefined;
    }
    const req = JSON.parse(failed.request_json) as StoredRequest;
    const answer = await this.checkEligibility({
      candidates: admitted,
      trustProfile: failed.trust_profile,
      clientMaxProfile: failed.trust_profile,
      cwd: req.workspace,
      profile: JSON.parse(failed.policy_snapshot_json) as ResolvedProfile,
    });
    const target = answer.decision.eligible[0];
    if (target === undefined) notes.push("failover:none_eligible");
    return target;
  }

  /** The handoff successor on `target` (LLD §15.7 steps 5 and 6), or undefined with the reason in `notes`. */
  private async submitFailover(failed: RunRecord, target: ProviderId, notes: string[]): Promise<string | undefined> {
    const req = JSON.parse(failed.request_json) as StoredRequest;
    const snapshot = JSON.parse(failed.policy_snapshot_json) as { project?: ProjectSnapshot };
    try {
      const store = this.opts.artifacts;
      const { built, stored } = await buildAndPutHandoffView(
        { ledger: this.ledger, artifacts: store, redact: (x: Buffer) => store.redactContent(x), store },
        {
          asOf: takeAsOf(this.ledger, failed.meta_session_id),
          bounds: this.opts.continuityBounds ?? DEFAULT_BUNDLE_BOUNDS,
        },
      );
      const submitted = await this.submit({
        clientId: failed.client_id,
        objective: req.objective,
        metaSessionId: failed.meta_session_id,
        trustProfile: failed.trust_profile,
        provider: target,
        constraints: req.constraints,
        priority: req.priority,
        ...(req.verification_commands ? { verificationCommands: req.verification_commands } : {}),
        ...(snapshot.project ? { project: snapshot.project } : {}),
        handoff: { built, stored, fromProvider: failed.provider as string, reason: "quota_failover" },
        successorOf: { runId: failed.id, attempt: failed.attempt },
        routeDecision: {
          features_json: JSON.stringify({ failover_of: failed.id, trust_profile: failed.trust_profile }),
          candidates_json: JSON.stringify([{ provider: target, eligible: true, reasons: [], score: null }]),
          selected_provider: target,
          reasons_json: JSON.stringify({
            selection: { provider: target, basis: `handoff quota_failover from ${failed.provider}` },
            continuation: { mode: "handoff", reason: "quota_failover", from_provider: failed.provider },
          }),
        },
      });
      return submitted.runId;
    } catch (err) {
      notes.push(
        `failover:refused:${err instanceof LifecycleError ? err.code : err instanceof HandoffBundleError ? HANDOFF_BUNDLE_UNAVAILABLE : "error"}`,
      );
      return undefined;
    }
  }

  /** A same-provider successor in `WAITING_CAPACITY` (LLD §16.5 step 3, §16.6 step 2), with its `retry_of` event. */
  private createSuccessor(failed: RunRecord, notBefore: string, code: FailureCode): string {
    const successor = this.ledger.createRun({
      metaSessionId: failed.meta_session_id,
      state: "WAITING_CAPACITY",
      trustProfile: failed.trust_profile,
      policySnapshot: JSON.parse(failed.policy_snapshot_json) as unknown,
      request: JSON.parse(failed.request_json) as unknown,
      requestHash: failed.request_hash,
      clientId: failed.client_id,
      provider: failed.provider,
      priority: failed.priority,
      projectId: failed.project_id ?? null,
      parentRunId: failed.id,
      attempt: failed.attempt + 1,
      nextAttemptAt: notBefore,
    });
    this.ledger.appendRunEvent({
      runId: successor.id,
      type: "retry_of",
      payload: { run_id: failed.id, attempt: failed.attempt, failure_code: code },
    });
    return successor.id;
  }

  /** FRD T18: due `WAITING_CAPACITY` runs go back to `QUEUED`; the earliest one not yet due arms the wake timer. */
  private releaseDueWaiting(): void {
    const now = this.now().getTime();
    for (const run of this.ledger.listRunsInState("WAITING_CAPACITY")) {
      const due = run.next_attempt_at === null ? now : Date.parse(run.next_attempt_at);
      if (Number.isFinite(due) && due > now) {
        this.scheduleWake(due);
        continue;
      }
      this.tryMove(run, "QUEUED", {}, { reason: "next_attempt_due" }, "T18");
    }
  }

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  private settle(runId: string): void {
    const list = this.waiters.get(runId);
    if (!list) return;
    this.waiters.delete(runId);
    const run = this.current(runId);
    for (const resolve of list) resolve(run);
  }

  private current(runId: string): RunRecord {
    const run = this.ledger.getRunRecord(runId);
    if (!run) throw new Error(`run ${runId} vanished`);
    return run;
  }

  private nowIso(): string {
    return (this.opts.now ?? (() => new Date()))().toISOString();
  }
}

/**
 * T5.3 (LLD §15.3): the `verification_outcome` decision for a finished verification stage. The outcome is the stage's
 * own verdict (a controller-side failure or a cancellation maps to `failed` and `cancelled`); the counts are of the
 * per-command outcomes the stage recorded (`passed`, `not_run`, anything else counts as failed). Controller values only.
 */
function recordVerificationDecision(ledger: Ledger, runId: string, v: VerificationOutcomeRecord): void {
  const passed = v.summary.filter((c) => c.outcome === "passed").length;
  const notRun = v.summary.filter((c) => c.outcome === "not_run").length;
  ledger.appendDecision({
    kind: "verification_outcome",
    runId,
    outcome: v.pending.kind === "success" ? "passed" : v.pending.kind === "cancelled" ? "cancelled" : "failed",
    passed,
    failed: v.summary.length - passed - notRun,
    notRun,
  });
}

const LOST_RACE = Symbol("lost-race");

type GitChannelPlan =
  | { readonly kind: "none" }
  | { readonly kind: "not_offered"; readonly reason: string }
  | {
      readonly kind: "offer";
      readonly identity: { readonly name: string; readonly email: string };
      readonly projectId: string;
      readonly contextId: string;
      readonly pushPolicy: "none" | "branch";
      /** T9.10: the frozen snapshot has `sign: true`. */
      readonly sign: boolean;
    };

/**
 * T9.4 (FR-GIT-02, LLD §12.1, ADR-0026; Delegated): whether a write-capable run gets the `commit` tool. Only facts frozen
 * in the run's policy snapshot at admission count (Q-41): a project run in a `host` environment whose primary context
 * is writable and names a commit identity, with an adapter that declares an `injected` channel. Runs delegated by
 * workspace path, and adapters without a channel (Codex; Claude Code without the T9.4b opt-in, or with it on any run
 * other than an approved bypass run, ADR-0033), are untouched (`none`, no event); `serviceConfigured` is false for
 * those.
 */
function gitChannelPlan(adapter: ProviderAdapter, run: RunRecord, serviceConfigured: boolean): GitChannelPlan {
  if (!serviceConfigured || adapter.gitCapabilities.commitChannel !== "injected") return { kind: "none" };
  let project: ProjectSnapshot | undefined;
  try {
    project = (JSON.parse(run.policy_snapshot_json) as { project?: ProjectSnapshot }).project;
  } catch {
    project = undefined;
  }
  if (project === undefined) return { kind: "none" };
  if (project.environment_kind !== "host") return { kind: "not_offered", reason: "environment_not_host" };
  if (project.writable !== true) return { kind: "not_offered", reason: "context_not_writable" };
  if (project.identity === undefined) return { kind: "not_offered", reason: "no_identity" };
  return {
    kind: "offer",
    identity: project.identity,
    projectId: project.id,
    contextId: project.context_id,
    pushPolicy: project.push?.policy === "branch" ? "branch" : "none",
    sign: project.sign === true,
  };
}

type PrivilegedInput =
  | { readonly kind: "request"; readonly scope: PrivilegedScope; readonly clientPolicy: boolean }
  | { readonly kind: "approved"; readonly approvalId: string };

/** The validated `privileged` input of a request (shape already checked by `validate`), or undefined. */
function privilegedInput(req: SubmitRequest): PrivilegedInput | undefined {
  const p = req.privileged;
  if (req.trustProfile !== "privileged" || p === undefined) return undefined;
  if ("approvalId" in p) return { kind: "approved", approvalId: p.approvalId };
  const parsed = parsePrivilegedScope(p.scope);
  if (!parsed.ok)
    throw new LifecycleError("INVALID_REQUEST", `invalid privileged scope: ${parsed.field} ${parsed.message}`);
  return { kind: "request", scope: parsed.scope, clientPolicy: p.approvedByClientPolicy === true };
}

function resolveRule(from: RunState, to: RunState, ruleId?: string): TransitionRule {
  const found = assertTransition(from, to);
  if (ruleId === undefined) return found;
  const named = TRANSITIONS.find((t) => t.id === ruleId && t.from === from && t.to === to);
  if (!named) throw new IllegalTransitionError(from, to);
  return named;
}

/** The artifact secret redactor applied to a text value (same patterns as stored artifacts). */
function redactText(text: string): string {
  return defaultRedactor(Buffer.from(text, "utf8")).toString("utf8");
}

/** {@link redactText} plus how many values it replaced (marker occurrences added; the text's own markers are not counted). */
function redactTextCounted(text: string): { text: string; count: number } {
  const out = redactText(text);
  const markers = (t: string) => t.split(REDACTION_MARKER).length - 1;
  return { text: out, count: markers(out) - markers(text) };
}

function pendingOf(exec: Execution, out: AdapterRunOutcome): Pending {
  if (exec.cancelRequested || out.exit.outcome === "cancelled" || out.result.failureCode === "CANCELLED") {
    return { kind: "cancelled" };
  }
  if (out.result.ok) return { kind: "success" };
  return {
    kind: "failure",
    code: out.result.failureCode ?? "OUTPUT_PROTOCOL_ERROR",
    detail: out.result.failureDetail ?? "provider run failed",
  };
}

/** Bounded, content-free view of a provider event for `run_event` (FR-TEL-03, NFR-PRIV-02: no text, no paths). */
function compactEvent(ev: NormalizedEvent): Record<string, unknown> {
  switch (ev.kind) {
    case "tool_call":
      return { kind: ev.kind, tool: ev.tool, ...(ev.denied ? { denied: true } : {}) };
    case "provider_error":
      return { kind: ev.kind, category: ev.category.slice(0, 64) };
    case "result":
      return { kind: ev.kind, ok: ev.ok };
    case "rate_limit":
      return { kind: ev.kind, ...(ev.resetAt ? { reset_at: ev.resetAt.slice(0, 64) } : {}) };
    case "unknown":
      return { kind: ev.kind };
    default:
      return { kind: ev.kind };
  }
}

/** Re-exported for callers that recorded start ticks through the lifecycle (LLD §8.3). */
export { procStartTicks };

/** A Node.js file-system error (has a string `code` such as `EEXIST`). */
function isFsError(err: unknown): boolean {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string";
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/** T6.5: the latest provider-reported `reset_at` among a run's `rate_limit` provider events (epoch ms), if any. */
function latestResetAt(events: readonly { type: string; payload_json: string }[]): number | undefined {
  let latest: number | undefined;
  for (const e of events) {
    if (e.type !== "provider_event") continue;
    let p: unknown;
    try {
      p = JSON.parse(e.payload_json);
    } catch {
      continue;
    }
    const o = p as { kind?: unknown; reset_at?: unknown };
    if (o?.kind !== "rate_limit" || typeof o.reset_at !== "string") continue;
    const t = Date.parse(o.reset_at);
    if (Number.isFinite(t) && (latest === undefined || t > latest)) latest = t;
  }
  return latest;
}
