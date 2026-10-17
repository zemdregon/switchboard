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
  type Invocation,
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
  PACING_HOLD_EVENT,
  type PacingDeferral,
  type PacingGateSettings,
  pacingDeferrals,
} from "../capacity/pacing-gate.js";
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
import {
  type BudgetAdmission,
  type BudgetRefusal,
  budgetRefusalDetails,
  budgetRefusalMessage,
  registerBudgets,
} from "../control/budgets.js";
import {
  DEFAULT_LOOP_BREAKER,
  type LoopBreakerSettings,
  parkedRefusal,
  recordLoopPark,
  type SuccessorRefusal,
  successorRefusal,
} from "../control/loop-breaker.js";
import { admissionPause, pauseRefusalDetails, pauseRefusalMessage } from "../control/pause.js";
import {
  type Environment,
  EnvironmentRefusal,
  type RunContext as EnvironmentRunContext,
  environmentKindOf,
  hostEnvironment,
  type ReadOnlyContextMount,
} from "../environment/index.js";
import type { OuterSandboxAvailability } from "../exec/outer-sandbox.js";
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
import {
  AFFINITY_SWITCH_REASONS,
  type Ledger,
  type NewRouteDecision,
  type RunFieldPatch,
  type RunRecord,
  type RunState,
  type TrustProfile,
} from "../ledger/index.js";
import { MODEL_ID_PATTERN, type ModelCapability } from "../models/registry.js";
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
  buildRouteDecision,
  type ClassifierInput,
  type CollectDeps,
  classifyRequest,
  collectAffinityFacts,
  collectFacts,
  collectScoreInputs,
  DEFAULT_AFFINITY,
  DEFAULT_ROUTE_SCORING,
  type EligibilityDecision,
  type EligibilityInput,
  failureCodeForIneligible,
  failureCodeForReason,
  filterEligible,
  type RouteFeatures,
  type RouteScoringSettings,
  reasonCodeForIneligible,
  requirementsFor,
} from "../routing/index.js";
import type { Telemetry } from "../telemetry/index.js";
import { type DelegateSpanFacts, SpanTracker } from "../telemetry/spans.js";
import { usageObservationsFromEvents } from "../usage/index.js";
import { gitText } from "../workspace/git.js";
import {
  assessDiskFloor,
  type DiskFloor,
  type DiskFloorStatus,
  type PreparedWorkspace,
  ResumeDirectoryUnavailableError,
  type WorkspaceManager,
} from "../workspace/index.js";
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
  STEER_DELIVERED_EVENT,
  STEER_DELIVERY,
  STEER_NOTE_MAX,
  STEER_REQUESTED_EVENT,
  STEER_UNDELIVERED_EVENT,
  SteerInbox,
  type SteerResult,
  type SteerUndeliveredReason,
  steerPrompt,
  steerRequestedPayload,
} from "./steer.js";
import {
  startVerification,
  VERIFICATION_COMMAND_EVENT,
  VERIFICATION_STARTED_EVENT,
  VERIFICATION_WAIT_EVENT,
  type VerificationLimits,
  type VerificationResult,
  verificationCommandsProblem,
  verificationEnvAllowlist,
  verificationReport,
  verificationSummary,
} from "./verification.js";

export type LifecycleErrorCode = "INVALID_REQUEST" | "QUEUE_FULL" | "BUDGET_EXHAUSTED" | "PAUSED";

/** Admission or API error. No run row is written when it is thrown from `submit`. */
const archivedMessage = (id: string): string =>
  `meta-session ${id} is archived (collected or being collected by retention GC); start a new task instead`;

const parkedMessage = (id: string, parked: SuccessorRefusal): string =>
  `meta-session ${id} is parked by the loop breaker (${parked.reason === "meta_session_parked" ? `${parked.threshold} identical failures, ${parked.fingerprint}` : parked.reason}); start a new task instead`;

export class LifecycleError extends Error {
  override readonly name = "LifecycleError";
  constructor(
    readonly code: LifecycleErrorCode,
    message: string,
    /** T14.4/T14.6: closed, controller-generated facts about the refusal (`BUDGET_EXHAUSTED`, `PAUSED`); empty otherwise. */
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** T14.4 (FR-CTL-06): what `onBudgetRefused` receives; the lifecycle wrote nothing for this request. */
export interface BudgetRefusalNotice {
  /** The project of the refused request, or null for a workspace-path run. */
  readonly projectId: string | null;
  readonly refusal: BudgetRefusal;
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
  /**
   * T7.12 (FR-RTE-08, LLD §17.6): the project's remembered model, pinned by routing when affinity holds and the adapter
   * declares it accepts a reported model id. Stored as `request_json.model`, re-checked at preflight and passed to
   * `compile`. Absent: the adapter default.
   */
  readonly model?: string;
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
  /**
   * T7.12 (FR-RTE-08): a model to check with the provider's model registry and pure `compile` (LLD §2.1 check rule),
   * as the run would be compiled. Absent: the adapter default.
   */
  readonly model?: string;
  /**
   * T7.8 (FR-RTE-01): minimum capability tier to evaluate against operator-declared model capabilities in the model
   * registry. Absent: unconstrained.
   */
  readonly minimumCapability?: ModelCapability;
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
  /** T7.12: the pinned model (see {@link SubmitRequest.model}); present only when pinned. */
  model?: string;
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
  /**
   * T8.2 (FR-TEL-02, LLD §7, ADR-0012): completed-span sink for wrapper-boundary span export. Unset (or an endpoint
   * absent from the config) means no span emission; either way emission is fire-and-forget and never fails a run.
   */
  readonly telemetry?: Telemetry;
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
  /**
   * T14.4 (FR-CTL-06, LLD §3.4.6): operator budget caps (`control_plane.budgets`), asked inside the admission
   * transaction of `submit` and before a retry successor is created. Unset means no cap. The lifecycle publishes the
   * same evaluator to the read path (`registerBudgets`), so `needs_attention` reflects what refuses admission.
   */
  readonly budgets?: BudgetAdmission;
  /** T14.4: observer for every budget refusal (operator log, `budget_exhausted` sink event). Must not throw. */
  readonly onBudgetRefused?: (notice: BudgetRefusalNotice) => void;
  /**
   * T14.5 (FR-CTL-07, LLD §3.4.6): `control_plane.loop_breaker` (**N**, **T**, successor cap). Unset means the LLD
   * Assumption defaults. The loop breaker cannot be turned off.
   */
  readonly loopBreaker?: LoopBreakerSettings;
  /** T6.6: handoff bundle bounds for a quota failover (`continuity.*`, LLD §15.4). Unset means the LLD defaults. */
  readonly continuityBounds?: BundleBounds;
  /**
   * T7.2 (LLD §17.3): stage-2 settings for the quota failover's choice among the other eligible providers (weights,
   * the capacity window, provider configuration). Unset means the LLD defaults.
   */
  readonly routing?: RouteScoringSettings;
  /** T11.11: bounded advisory classifier, called only after eligibility. Never receives routing authority. */
  readonly classifyRouteFeatures?: (
    input: ClassifierInput,
    context: { readonly project?: ProjectSnapshot; readonly runId?: string; readonly metaSessionId?: string },
  ) => Promise<RouteFeatures>;
  /**
   * T12.5 (FR-RAG-05, FR-RAG-08, LLD §14.6): the retrieval context pack. When set, a fresh (not resumed, not handoff)
   * run admitted under a project asks it for a pack after its workspace is prepared and before compile; the text is
   * appended to the prompt compiled for the adapter, never to the stored request. Unset: no run gets a pack.
   */
  readonly contextPack?: ContextPackPort;
  /**
   * T10.1 (FR-PRJ-04, FR-PRJ-05, LLD §11.3): the environment port. Asked once per run with the frozen project
   * snapshot (or undefined for a run by workspace path) for the environment the provider process runs in and the
   * project facts the snapshot deliberately does not carry (read-only context paths, limits). Unset, or an answer
   * whose kind differs from the snapshot's `environment_kind`: a `host` run uses the identity environment as before
   * and a `container` run is refused `ELIGIBILITY_NONE` before any lease or worktree (fail closed: never silently on
   * the host). `prepare` runs just before spawn, after the pre-spawn refusals; `teardown` runs on every path after it.
   */
  readonly environments?: EnvironmentResolver;
  /**
   * T3.11 (FR-EXE-08, FR-POL-06, decision 11): optional confined verification in the outer sandbox from T3.1.
   * When true, verification commands run inside bubblewrap with the worktree writable and the rest read-only.
   */
  readonly confinedVerification?: boolean | undefined;
  /** Profiles whose verification commands must run inside the outer sandbox. */
  readonly outerSandboxRequiredProfiles?: readonly string[] | undefined;
  /** Outer sandbox availability detection result. */
  readonly outerSandbox?: OuterSandboxAvailability | undefined;
  /**
   * T3.22 (FR-EXE-09, LLD §8.1): host-wide verification slots, lower priority and parallelism variables. Unset (no
   * `limits.verification_*` key): verification is exactly the T3.10 stage.
   */
  readonly verificationLimits?: VerificationLimits | undefined;
  /**
   * T3.23 (FR-WS-11, BR-51, LLD §5): the free-disk floor (`limits.min_free_disk_mb`). Unset (the default): no probe is
   * ever made and dispatch is unchanged. Set: `pump()` probes once per dispatch pass while runs are queued; under the
   * floor every queued run is held in `QUEUED` with one `disk_hold` event per hold episode, the wake timer re-probes
   * every `recheckMs`, and `sweep` (the early GC sweep, at most one in flight and one per `recheckMs`) runs. Admission
   * (`submit`) is unaffected: the floor never fails or refuses a run.
   */
  readonly diskFloor?: DiskFloorGate;
  /**
   * T6.8 (FR-CAP-10, BR-51, LLD §16.9): `capacity.subscriptions` and `capacity.pacing`, passed only when the file sets
   * them. Unset: no pacing figure is read and admission and dispatch are unchanged. Set with mode `gate`: eligibility
   * answers carry each candidate's deferral (`PACING_DEFERRED` at selection), and `pump()` holds a queued run whose
   * subscription is deferred in `QUEUED` with one `pacing_hold` event per gate-open time, arming the wake timer for it.
   * Never a refusal, a failure, a new run, a probe or a provider call.
   */
  readonly pacing?: PacingGateSettings;
}

/** T3.23: the lifecycle's view of the free-disk floor; `serve` composes it from the config and `src/workspace/gc.ts`. */
export interface DiskFloorGate extends DiskFloor {
  /** The early GC sweep (FR-WS-11). Its result is the caller's to log; a rejection only ends this sweep. Unset: none. */
  readonly sweep?: (status: DiskFloorStatus) => Promise<unknown>;
  /** Re-probe period while runs are held; default {@link DEFAULT_DISK_RECHECK_MS}. */
  readonly recheckMs?: number;
}

/** T3.23: how often a disk hold re-probes free space (Assumption, Delegated: free space changes slowly). */
export const DEFAULT_DISK_RECHECK_MS = 30_000;

/** T3.23: the `run_event` type recorded when the floor holds a run (payload: free, floor and path in bytes). */
export const DISK_HOLD_EVENT = "disk_hold";

/** T10.1: where a run is placed (LLD §11.3). `serve` composes it from the configuration and the container backend. */
export interface EnvironmentPlacement {
  readonly environment: Environment;
  /** The project's declared read-only contexts (FR-PRJ-05); empty for `host`, which mounts nothing. */
  readonly readOnlyContexts: readonly ReadOnlyContextMount[];
  readonly limits?: EnvironmentRunContext["limits"];
}

/** The snapshot fields an environment is chosen by (the whole frozen `ProjectSnapshot` at dispatch). */
export type EnvironmentSnapshot = Pick<ProjectSnapshot, "id" | "environment_kind" | "image_digest">;

export interface EnvironmentResolver {
  resolve(project: EnvironmentSnapshot | undefined): EnvironmentPlacement | undefined;
}

/**
 * T12.5: the retrieval context pack as the lifecycle sees it. Typed here, structurally, so this module never imports
 * the retrieval service (FR-RAG-07; `src/retrieval/import-boundary.test.ts`); `serve` wires it.
 */
export interface ContextPackPort {
  /** `retrieval.admission_timeout_ms`; the lifecycle stops waiting {@link CONTEXT_PACK_GRACE_MS} after it. */
  readonly timeoutMs: number;
  /** `undefined` when retrieval is inert; otherwise the pack text (or null) and the bounded `rag_retrieval` payload. */
  prepare(request: ContextPackRequest): Promise<ContextPackOutcome | undefined>;
}

export interface ContextPackRequest {
  readonly runId: string;
  readonly projectId: string;
  /** The stored request text. */
  readonly objective: string;
  /** The worktree's base commit, or null for a run without a worktree. */
  readonly baseCommit: string | null;
  /** The run's worktree, where the primary context's files are read for the freshness check. */
  readonly primaryRoot?: string;
  readonly signal: AbortSignal;
}

export interface ContextPackOutcome {
  readonly text: string | null;
  /** Counts, codes, ids and durations only (FR-RAG-12, LLD §14.10); never retrieved text or the query. */
  readonly event: Readonly<Record<string, unknown>>;
}

/** `run_event` type of the retrieval at dispatch (LLD §14.10). Never a failure code; never changes run state. */
export const RAG_RETRIEVAL_EVENT = "rag_retrieval";
/** How long past `timeoutMs` the lifecycle waits for a pack before dispatching without one (Assumption, Delegated). */
export const CONTEXT_PACK_GRACE_MS = 100;

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
  /** T14.7 (FR-CTL-04): steer notes waiting for a run's next boundary (`./steer.ts`). */
  private readonly steerInbox = new SteerInbox();
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
  /** T6.4: one timer for the earliest moment a held run may become dispatchable (breaker cool-down, T6.8 gate-open). */
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeAt: number | undefined;
  /** T3.23: runs that already carry a `disk_hold` event in the current hold episode (cleared when the floor is met). */
  private readonly diskHeld = new Set<string>();
  /** T3.23: the early sweep in flight, and when the last one started (at most one per `recheckMs`). */
  private diskSweep: Promise<void> | undefined;
  private diskSweepAt: number | undefined;
  /** T6.8: the gate-open time each held run's latest `pacing_hold` event names (the ledger is read on first sight). */
  private readonly pacingHeld = new Map<string, string>();
  /** T8.2: wrapper-boundary span tracker; inert when no telemetry sink is configured. */
  private readonly spans: SpanTracker;

  constructor(private readonly opts: RunLifecycleOptions) {
    if (!Number.isInteger(opts.globalConcurrency) || opts.globalConcurrency < 1) {
      throw new RangeError("globalConcurrency must be a positive integer");
    }
    this.ledger = opts.ledger;
    this.runner = opts.probeRunner ?? createProbeRunner();
    this.maxQueueDepth = opts.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    this.refGuard = opts.refGuard ?? new RefGuard({ ledger: opts.ledger });
    this.spans = new SpanTracker(opts.telemetry);
    if (opts.budgets !== undefined) registerBudgets(opts.ledger, opts.budgets);
  }

  // ---- public API ---------------------------------------------------------------------------------------------

  /** T11.11: features are stored only; the stage-1 filter and stage-2 scorer never read them (Q-82). */
  async routeFeatures(
    input: ClassifierInput,
    context: { readonly project?: ProjectSnapshot; readonly runId?: string; readonly metaSessionId?: string } = {},
  ): Promise<RouteFeatures> {
    try {
      return (await this.opts.classifyRouteFeatures?.(input, context)) ?? classifyRequest(input);
    } catch {
      return classifyRequest(input);
    }
  }

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
    // T3.23: an early sweep still working on the ledger finishes before the caller closes the database.
    if (this.diskSweep !== undefined) await this.diskSweep;
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
    // T8.2: the delegation span covers admission-to-terminal for one accepted request; a replay reuses the prior run.
    const admittedAt = this.now().getTime();

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
      // T14.4 (FR-CTL-06): operator budget caps, in the admission transaction so the counts include every row written
      // before this one. A refusal writes nothing; the project stays flagged `budget_exhausted` on read while it holds.
      const refusal = this.opts.budgets?.refusal(req.project?.id, this.now());
      if (refusal !== undefined) {
        this.budgetRefused({ projectId: req.project?.id ?? null, refusal });
        throw new LifecycleError("BUDGET_EXHAUSTED", budgetRefusalMessage(refusal), budgetRefusalDetails(refusal));
      }
      // T14.6 (FR-CTL-05, LLD §3.4.4): a paused project, or the operator's global pause, admits nothing. Read inside
      // the admission transaction so a pause written before it is seen; nothing is written. Runs already admitted are
      // untouched (they finish), and no run state changes: the hold is on admission only.
      const paused = admissionPause(this.ledger, req.project?.id);
      if (paused !== undefined) {
        throw new LifecycleError("PAUSED", pauseRefusalMessage(paused), pauseRefusalDetails(paused));
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
        // T14.5 (FR-CTL-07): a meta-session parked by the loop breaker admits no further run; start a new task instead.
        const parked = parkedRefusal(this.ledger, metaSessionId);
        if (parked) {
          throw new LifecycleError("INVALID_REQUEST", parkedMessage(metaSessionId, parked));
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
    if (!result.replayed) {
      this.spans.delegateStarted(result.runId, admittedAt);
      queueMicrotask(() => this.pump());
    }
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
      if (moved) {
        this.flushSteer(runId);
        return moved.state;
      }
      return this.cancel(runId, reason, decidedBy); // lost a race (e.g. dispatched meanwhile): re-read and re-decide
    }
    const exec = this.inflight.get(runId);
    if (!exec) return run.state;
    exec.cancelRequested = true;
    if (exec.handle) void exec.handle.cancel();
    return (this.ledger.getRunRecord(runId) as RunRecord).state;
  }

  /**
   * T14.7 `steer_run` (FR-CTL-04, LLD §3.4.4): record a controller `steer_requested` event (length and hash only) and
   * queue `note` for the run's next boundary, where it is delivered by boundary-resume (`./steer.ts`). A terminal run is
   * a no-op (nothing recorded). A note that can no longer reach a boundary is recorded `steer_undelivered` at once.
   */
  steer(runId: string, note: string): SteerResult {
    const run = this.ledger.getRunRecord(runId);
    if (!run) throw new LifecycleError("INVALID_REQUEST", `unknown run ${runId}`);
    if (typeof note !== "string" || note.length === 0 || note.length > STEER_NOTE_MAX) {
      throw new LifecycleError("INVALID_REQUEST", `note must be 1 to ${STEER_NOTE_MAX} characters`);
    }
    if (isTerminal(run.state)) return { accepted: false, reason: "terminal" };
    this.ledger.appendRunEvent({ runId, type: STEER_REQUESTED_EVENT, payload: steerRequestedPayload(note) });
    const exec = this.inflight.get(runId);
    let reason: SteerUndeliveredReason | undefined;
    if (SLOT_STATES.includes(run.state) && exec === undefined) reason = "not_in_this_process";
    else if (this.steerInbox.isClosed(runId) || run.state === "VERIFYING" || run.state === "FINALIZING") {
      reason = "past_boundary";
    }
    if (reason !== undefined) {
      this.steerUndelivered(runId, reason, 1);
      return { accepted: false, reason };
    }
    this.steerInbox.push(runId, note);
    return { accepted: true };
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

  /**
   * T10.1 (LLD §11.3): where a run with this frozen project snapshot would execute, by the same rule PREFLIGHT applies
   * at dispatch. Admission asks it before any side effect, so a `container` project with no container environment
   * wired is refused there; undefined (or a kind other than the snapshot's) means the run would be refused.
   */
  environmentPlacement(project: EnvironmentSnapshot | undefined): EnvironmentPlacement | undefined {
    return (
      this.opts.environments?.resolve(project) ??
      (environmentKindOf({ project }) === "host" ? { environment: hostEnvironment, readOnlyContexts: [] } : undefined)
    );
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
        requirements: {
          ...requirementsFor(q.trustProfile, profile),
          ...(q.model !== undefined ? { model: q.model } : {}),
          ...(q.minimumCapability !== undefined ? { minimumCapability: q.minimumCapability } : {}),
        },
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
      // T6.8 (LLD §16.9): the pacing gate's deferral per candidate; applied after stage 1, never a stage-1 reason.
      if (this.opts.pacing !== undefined) {
        const deferrals = pacingDeferrals(this.ledger, this.opts.pacing, now);
        for (const f of input.facts) {
          const d = deferrals.get(f.provider);
          if (d !== undefined) f.pacingDeferred = d;
        }
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
    if (req.model !== undefined) {
      // LLD §2.1 id pattern; the adapter's own compile checks it again.
      if (typeof req.model !== "string" || !new RegExp(MODEL_ID_PATTERN).test(req.model))
        bad("model is not a plain model id");
      if (req.resume !== undefined || req.handoff !== undefined) bad("a pinned model applies to a fresh run only");
    }
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
      ...(req.model !== undefined ? { model: req.model } : {}),
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
      let held: DiskFloorStatus | undefined;
      const picked = this.ledger.immediate((): RunRecord | undefined => {
        if (this.ledger.countRunsInStates(SLOT_STATES) >= this.opts.globalConcurrency) return undefined;
        const now = this.now();
        const queued = this.ledger.listRunsInState("QUEUED");
        // T3.23 (FR-WS-11, BR-51): under the free-disk floor every queued run is held here, with one `disk_hold` event
        // per run and hold episode; nothing fails. The hold lifts when a later pass (wake timer, sweep end, any other
        // dispatch trigger) probes free space at or above the floor. No floor configured: no probe, same path as before.
        if (queued.length > 0 && this.opts.diskFloor !== undefined) {
          const status = assessDiskFloor(this.opts.diskFloor);
          if (status.below) {
            for (const run of queued) this.recordDiskHold(run, status);
            held = status;
            return undefined;
          }
          this.diskHeld.clear();
        }
        // T6.8 (LLD §16.9): read once per pass, only when pacing is configured and a run is queued.
        const deferrals =
          queued.length > 0 && this.opts.pacing !== undefined
            ? pacingDeferrals(this.ledger, this.opts.pacing, now)
            : undefined;
        if (this.pacingHeld.size > 0) {
          const ids = new Set(queued.map((r) => r.id));
          for (const id of this.pacingHeld.keys()) if (!ids.has(id)) this.pacingHeld.delete(id);
        }
        for (const run of queued) {
          const limit =
            run.provider === null
              ? undefined
              : (this.opts.perProviderLimits?.get(run.provider) ?? this.opts.perProviderConcurrency);
          if (limit !== undefined && run.provider !== null) {
            if (this.ledger.countRunsInStates(SLOT_STATES, run.provider) >= limit) continue;
          }
          if (run.provider !== null && !this.pacingLetsThrough(run, deferrals)) continue;
          if (run.provider !== null && !this.breakerLetsThrough(run, now)) continue;
          return this.move(run, "PREFLIGHT", {}, { slot: "reserved" });
        }
        return undefined;
      });
      if (held !== undefined) {
        this.onDiskHold(held);
        return;
      }
      if (!picked) return;
      this.launch(picked.id);
    }
  }

  /**
   * T6.8 (LLD §16.9, FRD T4 guard): a run whose subscription the pacing gate defers waits in `QUEUED` until the
   * gate-open time, for which the wake timer is armed. One `pacing_hold` event per run and gate-open time, also across a
   * restart (the run's latest event is read once). Checked before the breaker, so a held run never becomes its probe.
   */
  private pacingLetsThrough(run: RunRecord, deferrals: ReadonlyMap<string, PacingDeferral> | undefined): boolean {
    const d = deferrals?.get(run.provider as string);
    if (d === undefined) return true;
    let recorded = this.pacingHeld.get(run.id);
    if (recorded === undefined) {
      const last = this.ledger
        .listRunEvents(run.id)
        .filter((e) => e.type === PACING_HOLD_EVENT)
        .at(-1);
      if (last !== undefined) recorded = (JSON.parse(last.payload_json) as { until?: string }).until;
    }
    if (recorded !== d.until) {
      this.ledger.appendRunEvent({
        runId: run.id,
        type: PACING_HOLD_EVENT,
        payload: { subscription: d.subscription, window: d.window, until: d.until, source: d.source },
      });
    }
    this.pacingHeld.set(run.id, d.until);
    this.scheduleWake(Date.parse(d.until));
    return false;
  }

  /** T3.23: one `disk_hold` event per run per hold episode, inside the dispatch transaction. */
  private recordDiskHold(run: RunRecord, status: DiskFloorStatus): void {
    if (this.diskHeld.has(run.id)) return;
    this.diskHeld.add(run.id);
    this.ledger.appendRunEvent({
      runId: run.id,
      type: DISK_HOLD_EVENT,
      payload: {
        reason: "FREE_DISK_BELOW_FLOOR",
        free_bytes: status.freeBytes,
        min_free_bytes: status.minFreeBytes,
        path: status.path,
      },
    });
  }

  /**
   * T3.23: after a pass that held runs, arm the re-probe and start the early sweep (FR-WS-11) unless one is in flight
   * or one started less than `recheckMs` ago, so a floor nothing can reclaim costs one sweep per period, not a loop.
   * The sweep's end re-runs `pump()`, which lifts the hold as soon as the probe says so.
   */
  private onDiskHold(status: DiskFloorStatus): void {
    const floor = this.opts.diskFloor;
    if (floor === undefined || this.stopped) return;
    const recheckMs = floor.recheckMs ?? DEFAULT_DISK_RECHECK_MS;
    const nowMs = this.now().getTime();
    this.scheduleWake(nowMs + recheckMs);
    if (floor.sweep === undefined || this.diskSweep !== undefined) return;
    if (this.diskSweepAt !== undefined && nowMs - this.diskSweepAt < recheckMs) return;
    this.diskSweepAt = nowMs;
    const sweep = floor.sweep;
    this.diskSweep = Promise.resolve()
      .then(() => sweep(status))
      .then(
        () => undefined,
        () => undefined, // the caller logs its own sweep; a failure here only means the hold waits for the re-probe
      )
      .finally(() => {
        this.diskSweep = undefined;
        this.pump();
      });
  }

  private launch(runId: string): void {
    const exec: Execution = { runId, cancelRequested: false, handle: undefined, done: Promise.resolve() };
    this.inflight.set(runId, exec);
    exec.done = this.execute(exec)
      .catch((err: unknown) => this.contain(exec, err))
      .finally(() => {
        this.inflight.delete(runId);
        this.flushSteer(runId);
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
    // T10.1 (LLD §11.3, FR-PRJ-04): the environment, decided from the frozen snapshot before anything is probed,
    // leased or created. A `container` run with no container environment is refused here, never run on the host.
    const snapshotProject = (JSON.parse(run0.policy_snapshot_json) as { project?: ProjectSnapshot }).project;
    const environmentKind = environmentKindOf({ project: snapshotProject });
    const placement = this.environmentPlacement(snapshotProject);
    if (placement === undefined || placement.environment.kind !== environmentKind) {
      return this.fail(
        runId,
        "ELIGIBILITY_NONE",
        `no ${environmentKind} environment is available for project ${snapshotProject?.id ?? "(none)"}` +
          `${placement === undefined ? "" : ` (resolver answered ${placement.environment.kind})`}`,
        { reason: "ENVIRONMENT_UNAVAILABLE", stage: "environment", environment_kind: environmentKind },
      );
    }
    const environment = placement.environment;
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
    // T12.5 (FR-RAG-05, FR-RAG-08, LLD §14.6): a fresh project run may get a context pack, appended to the compiled
    // prompt only; `request_json` keeps the request text unchanged. Any retrieval failure means no pack, never a failure.
    let pack: string | null = null;
    if (
      this.opts.contextPack !== undefined &&
      handoffPrompt === undefined &&
      req.resume_native_session_id === undefined &&
      req.project_id !== undefined
    ) {
      pack = await this.contextPack(this.opts.contextPack, runId, req.project_id, req.objective, ws);
      if (exec.cancelRequested) return this.cancelEarly(runId);
    }
    const compileReq = {
      runId,
      // T5.5: a handoff run compiles the rendered bundle with the instruction last, and no separate constraints (the
      // bundle carries them); `handoff` is for the record only (no adapter reads it). Other runs are unchanged.
      objective: handoffPrompt ? handoffPrompt.prompt : pack !== null ? `${req.objective}\n\n${pack}` : req.objective,
      constraints: handoffPrompt ? [] : req.constraints,
      workspace: { cwd, writable: ws.mode === "worktree" },
      ...(handoffPrompt ? { handoff: handoffPrompt.ref } : {}),
      // T7.12 (FR-RTE-08): the model routing pinned at admission and preflight re-checked; absent = adapter default.
      ...(req.model !== undefined ? { model: req.model } : {}),
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
    /** The channel's argv and environment changes, re-applied to a T14.7 boundary-resume turn. */
    let withChannel = (i: Invocation): Invocation => i;
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
        withChannel = (i) => ({
          ...i,
          argv: [...i.argv.filter((a) => !remove.has(a)), ...extra.argv],
          policyFlags: i.policyFlags.filter((a) => !remove.has(a)),
          env: { ...i.env, ...extra.env },
        });
        inv = withChannel(inv);
      }
    }
    if (exec.cancelRequested) {
      // Opening the channel awaited: a cancel that arrived meanwhile must not be lost (no process exists yet).
      await channel?.close();
      return this.cancelEarly(runId);
    }

    // T10.1 (LLD §11.3, FR-PRJ-05): the environment wraps the audited invocation last, so the pre-spawn audits below
    // see the provider's arguments unchanged after the runtime's. `host` is the identity. A container refusal
    // (runtime missing, image absent or carrying a Git client, network not enforceable) ends the run before spawn
    // with the reason in the transition event; `teardown` runs on every path from here on.
    const environmentRun: EnvironmentRunContext = {
      runId,
      ...(snapshotProject !== undefined ? { projectId: snapshotProject.id } : {}),
      worktreePath: cwd,
      readOnlyContexts: placement.readOnlyContexts,
      profile,
      ...(snapshotProject?.image_digest !== undefined ? { imageDigest: snapshotProject.image_digest } : {}),
      ...(placement.limits !== undefined ? { limits: placement.limits } : {}),
    };
    try {
      inv = (await environment.prepare(environmentRun, inv)).invocation;
    } catch (err) {
      await channel?.close();
      await environment.teardown(environmentRun);
      if (err instanceof EnvironmentRefusal) {
        return this.fail(runId, "ELIGIBILITY_NONE", err.message.slice(0, 500), {
          reason: err.reason,
          stage: "environment",
          environment_kind: environment.kind,
        });
      }
      throw err;
    }
    if (exec.cancelRequested) {
      await channel?.close();
      await environment.teardown(environmentRun);
      return this.cancelEarly(runId);
    }

    // RUNNING (T9): pid/pgid persisted in the same transaction, before any output is read (LLD §8).
    let spawned = false;
    // T8.2: the provider.spawn span covers the observed process lifetime (onSpawn to process exit).
    let spawnStartedAt: number | undefined;
    let out: AdapterRunOutcome;
    const onEvent = (ev: NormalizedEvent): void => {
      if (ev.kind === "session_bound") {
        if (!nativeIds.includes(ev.nativeSessionId)) nativeIds.push(ev.nativeSessionId);
        // T5.3 (FR-ADP-10): remember what `session_bound` reported, for the binding row written after the run.
        if (!bound.has(ev.nativeSessionId)) {
          bound.set(ev.nativeSessionId, { model: ev.model ?? null, backingProvider: ev.backingProvider ?? null });
        }
      }
      this.ledger.appendRunEvent({ runId, type: "provider_event", payload: compactEvent(ev) });
    };
    const runOptions = (turnInv: Invocation) => ({
      bypassApproved: profile.bypassApproved,
      // T3.17: the audit admits a bypass flag only for this profile being privileged with a scope that sets bypass.
      profile,
      // T9.4b: `--mcp-config` and MCP allow rules only in the channel's exact shape (ADR-0029 item 6).
      ...(channelAudit ? { channel: channelAudit } : {}),
      ...(this.opts.baseEnv ? { baseEnv: this.opts.baseEnv } : {}),
      // T4.8 (ADR-0036 item 9): an `acp-stdio` run answers permission requests from this frozen snapshot only.
      // No read-only context is passed yet (fail closed: reads outside the worktree are rejected).
      ...(turnInv.transport === "acp-stdio"
        ? {
            acp: {
              snapshot: { profile, worktree: turnInv.cwd, writable: ws.mode === "worktree", readOnlyContexts: [] },
              onRunEvent: (e: { type: string; payload: unknown }) =>
                this.ledger.appendRunEvent({ runId, type: e.type, payload: e.payload }),
            },
          }
        : {}),
      onEvent,
    });
    try {
      let agent: AdapterRun;
      try {
        agent = startAdapterRun(adapter, inv, {
          ...runOptions(inv),
          onSpawn: ({ pid, pgid }) => {
            this.move(
              this.current(runId),
              "RUNNING",
              { pid, pgid, proc_start_ticks: procStartTicks(pid), started_at: this.nowIso() },
              { pid, pgid },
            );
            spawned = true;
            spawnStartedAt = this.now().getTime();
            this.spans.spawnStarted(runId, spawnStartedAt);
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
      try {
        out = await agent.done;
      } catch (err) {
        // T8.2: the process outcome was never observed; drop the span start instead of inventing exit facts.
        this.spans.discardSpawn(runId);
        throw err;
      }
      if (spawnStartedAt !== undefined) {
        // T8.2: complete provider.spawn from the observed exit; a spawn error never reached onSpawn, so no span starts.
        this.spans.spawnFinished(runId, this.now().getTime(), {
          runId,
          sessionId: run0.meta_session_id,
          provider: req.provider,
          trustProfile: run0.trust_profile,
          adapterVersion: binaryVersion ?? undefined,
          ...(req.model !== undefined ? { model: req.model } : {}),
          transport: inv.transport,
          attempt: run0.attempt,
          exitCode: out.exit.exitCode,
          exitSignal: out.exit.signal,
        });
        spawnStartedAt = undefined;
      }
      // T14.7 (FR-CTL-04, FR-SES-03, BR-7; LLD §3.4.4): the turn's end is the boundary. While steer notes are queued
      // and the turn succeeded with a native session, resume that same session in this run with only the notes as the
      // prompt (never the objective again: no replay). Each earlier turn's streams are kept as artifacts of the run.
      for (let notes = this.steerAtBoundary(exec, out); notes.length > 0; notes = this.steerAtBoundary(exec, out)) {
        const binding = { provider: req.provider, nativeSessionId: out.result.nativeSessionId as string };
        const turnReq = {
          runId,
          objective: steerPrompt(notes),
          constraints: [],
          workspace: compileReq.workspace,
          ...(req.model !== undefined ? { model: req.model } : {}),
        };
        const compiled = adapter.resumeArgs(binding, turnReq, profile);
        if (isIneligible(compiled)) {
          this.steerUndelivered(runId, "resume_refused", notes.length, { stage: "compile", reason: compiled.reason });
          break;
        }
        let turnInv: Invocation;
        try {
          await environment.teardown(environmentRun);
          turnInv = (await environment.prepare(environmentRun, withChannel(compiled))).invocation;
        } catch (err) {
          if (!(err instanceof EnvironmentRefusal)) throw err;
          this.steerUndelivered(runId, "resume_refused", notes.length, { stage: "environment", reason: err.reason });
          break;
        }
        if (ws.mode === "worktree") {
          this.opts.workspace.extendLease(runId, 2 * turnInv.timeouts.wallClockMs + turnInv.timeouts.killGraceMs);
        }
        let turn: AdapterRun;
        // T8.2: a steer turn is a second observed process of the same run, so it gets its own provider.spawn span.
        let turnStartAt: number | undefined;
        try {
          turn = startAdapterRun(adapter, turnInv, {
            ...runOptions(turnInv),
            onSpawn: ({ pid, pgid }) => {
              this.ledger.updateRunFields(
                runId,
                { pid, pgid, proc_start_ticks: procStartTicks(pid) },
                { type: "steer_turn_spawned", payload: { pid, pgid } },
              );
              turnStartAt = this.now().getTime();
              this.spans.spawnStarted(runId, turnStartAt);
            },
          });
        } catch (err) {
          const audits = [BypassFlagError, McpConfigAuditError, AcpPlanAuditError, IsolationAuditError];
          if (!audits.some((E) => err instanceof E)) throw err;
          this.steerUndelivered(runId, "resume_refused", notes.length, { stage: "audit" });
          break;
        }
        this.ledger.appendRunEvent({
          runId,
          type: STEER_DELIVERED_EVENT,
          payload: { delivery: STEER_DELIVERY, notes: notes.length },
        });
        exec.handle = turn;
        // A cancel that arrived while the turn was being prepared stops it at once.
        if (exec.cancelRequested) void turn.cancel();
        const earlier = out;
        try {
          out = await turn.done;
        } catch (err) {
          // T8.2: as for the first turn, no exit facts were observed; drop the span start.
          this.spans.discardSpawn(runId);
          throw err;
        }
        if (turnStartAt !== undefined) {
          this.spans.spawnFinished(runId, this.now().getTime(), {
            runId,
            sessionId: run0.meta_session_id,
            provider: req.provider,
            trustProfile: run0.trust_profile,
            adapterVersion: binaryVersion ?? undefined,
            ...(req.model !== undefined ? { model: req.model } : {}),
            transport: turnInv.transport,
            attempt: run0.attempt,
            exitCode: out.exit.exitCode,
            exitSignal: out.exit.signal,
          });
          turnStartAt = undefined;
        }
        await this.storeStreams(runId, run0.meta_session_id, earlier);
      }
      this.steerInbox.close(runId); // a refused resume also ends steering: later notes are undelivered at once
    } finally {
      // LLD §12.2: the socket is closed and removed when the run leaves RUNNING; calls in progress finish first.
      await channel?.close();
      // T10.1 (FR-PRJ-05): the container is removed when the run ends, whatever ended it; idempotent, never throws.
      await environment.teardown(environmentRun);
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
      verification = await this.verify(exec, runId, meta, ws, inv, commands, run0.trust_profile);
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
    profile?: TrustProfile,
  ): Promise<VerificationOutcomeRecord> {
    if (ws.mode !== "worktree") {
      // Admission refuses verification under inspect-untrusted, the only profile without a worktree (fail closed).
      const detail = "verification requires a run worktree";
      return { pending: { kind: "failure", code: "TOOL_FAILURE", detail }, summary: [], artifacts: {} };
    }
    const { wallClockMs, killGraceMs } = inv.timeouts;
    // The stage may take up to one more wall clock: keep the lease ahead of it (as at LEASED).
    this.opts.workspace.extendLease(runId, 2 * wallClockMs + (commands.length + 1) * killGraceMs);
    const confined =
      this.opts.confinedVerification ??
      (this.opts.outerSandboxRequiredProfiles !== undefined &&
        profile !== undefined &&
        this.opts.outerSandboxRequiredProfiles.includes(profile as string));
    const stage = startVerification({
      commands,
      cwd: ws.worktreePath,
      envAllowlist: verificationEnvAllowlist(inv.envAllowlist),
      ...(this.opts.baseEnv ? { baseEnv: this.opts.baseEnv } : {}),
      wallClockMs,
      killGraceMs,
      confined,
      ...(this.opts.outerSandbox ? { outerSandbox: this.opts.outerSandbox } : {}),
      ...(this.opts.verificationLimits
        ? {
            limits: this.opts.verificationLimits,
            // T3.22: the run stays VERIFYING while it waits; the wait is part of the stage's wall clock.
            onSlotWait: ({ slots }: { slots: number }) =>
              this.ledger.appendRunEvent({ runId, type: VERIFICATION_WAIT_EVENT, payload: { slots } }),
          }
        : {}),
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
    } else if (result.outcome === "timeout") {
      // T3.22: the slot wait used up the run's wall clock; a timeout like any other, not a limiter error.
      const detail = "verification slot wait exceeded the run's wall-clock limit";
      pending = { kind: "failure", code: "PROCESS_TIMEOUT", detail };
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
      ...(req.model !== undefined ? { model: req.model } : {}),
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
        // T14.5 (FR-CTL-07): the Nth identical failure parks the meta-session, before any successor is considered.
        recordLoopPark(this.ledger, failed, this.opts.loopBreaker ?? DEFAULT_LOOP_BREAKER);
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
   * T12.5 (FR-RAG-08, LLD §14.8): ask the port for a pack, waiting at most its timeout plus
   * {@link CONTEXT_PACK_GRACE_MS}. A rejection, a late answer or a failed event write gives no pack; the run goes on
   * unchanged. Writes one `rag_retrieval` event whenever retrieval was attempted.
   */
  private async contextPack(
    port: ContextPackPort,
    runId: string,
    projectId: string,
    objective: string,
    ws: PreparedWorkspace,
  ): Promise<string | null> {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), Math.max(0, port.timeoutMs) + CONTEXT_PACK_GRACE_MS);
    });
    const asked = Promise.resolve().then(() =>
      port.prepare({
        runId,
        projectId,
        objective,
        baseCommit: ws.mode === "worktree" ? ws.baseCommit : null,
        ...(ws.mode === "worktree" ? { primaryRoot: ws.worktreePath } : {}),
        signal: ctrl.signal,
      }),
    );
    asked.catch(() => {}); // a late rejection must not become an unhandled one
    let text: string | null = null;
    let payload: Readonly<Record<string, unknown>>;
    try {
      const r = await Promise.race([asked, late]);
      if (r === undefined) return null;
      if (r === "late") {
        ctrl.abort();
        payload = { outcome: "unavailable", reason: "TIMEOUT" };
      } else {
        text = typeof r.text === "string" && r.text.length > 0 ? r.text : null;
        payload = r.event;
      }
    } catch {
      payload = { outcome: "unavailable", reason: "RETRIEVAL_ERROR" };
    } finally {
      clearTimeout(timer);
    }
    try {
      this.ledger.appendRunEvent({ runId, type: RAG_RETRIEVAL_EVENT, payload: { ...payload } });
    } catch {
      return null;
    }
    return text;
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
  /**
   * T14.7: at a turn's end, the queued steer notes to deliver by resuming the turn's native session, or none. With none
   * queued the run's last boundary has passed (later notes are undelivered at once). Notes that cannot be delivered
   * (the turn failed or was cancelled, or reported no native session) are recorded `steer_undelivered`.
   */
  private steerAtBoundary(exec: Execution, out: AdapterRunOutcome): string[] {
    const runId = exec.runId;
    const queued = this.steerInbox.pending(runId);
    let reason: SteerUndeliveredReason | undefined;
    if (queued === 0) reason = undefined;
    else if (pendingOf(exec, out).kind !== "success") reason = "turn_not_successful";
    else if (!out.result.nativeSessionId) reason = "no_native_session";
    else return this.steerInbox.take(runId);
    this.steerInbox.close(runId);
    if (reason !== undefined) this.steerUndelivered(runId, reason, this.steerInbox.take(runId).length);
    return [];
  }

  /** T14.7: a run's queued notes that no boundary will deliver any more (the run ended). */
  private flushSteer(runId: string): void {
    const left = this.steerInbox.clear(runId);
    if (left > 0) this.steerUndelivered(runId, "run_ended", left);
  }

  private steerUndelivered(
    runId: string,
    reason: SteerUndeliveredReason,
    notes: number,
    extra: Record<string, unknown> = {},
  ): void {
    this.ledger.appendRunEvent({ runId, type: STEER_UNDELIVERED_EVENT, payload: { reason, notes, ...extra } });
  }

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
    if (isTerminal(to)) {
      this.recordBreakerOutcome(moved);
      this.endDelegateSpan(moved);
    }
    if (to === "SUCCEEDED") {
      this.recordAffinity(moved);
      const workItem = this.ledger.findWorkItemByAdmittedRunId(moved.id);
      if (workItem !== undefined) this.ledger.markWorkItemDone(workItem.id);
    }
    this.opts.onTransition?.({ runId: run.id, from: run.state, to, rule: rule.id });
    if (isTerminal(to)) queueMicrotask(() => this.settle(run.id));
    return moved;
  }

  /**
   * T8.2 (FR-TEL-02, LLD §7, ADR-0012): complete the run's `controller.delegate` span from the terminal row.
   * Only controller-observed facts are used; the stored request is parsed for the pinned model alone and the
   * objective/constraints never reach the span builders.
   */
  private endDelegateSpan(run: RunRecord): void {
    let model: string | undefined;
    try {
      model = (JSON.parse(run.request_json) as StoredRequest).model;
    } catch {
      // A span is best effort: a request that cannot be parsed exports without the model attribute.
    }
    const facts: DelegateSpanFacts = {
      runId: run.id,
      sessionId: run.meta_session_id,
      provider: run.provider,
      trustProfile: run.trust_profile,
      ...(model !== undefined ? { model } : {}),
      attempt: run.attempt,
      terminalState: run.state,
      failureCode: run.failure_code,
    };
    this.spans.delegateFinished(run.id, this.now().getTime(), facts);
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

  /**
   * T7.5 (FR-RTE-06, LLD §3.2 step 7, §17.6): when a run succeeds and its route decision (or, for a retry successor
   * without one, its nearest ancestor's) applied affinity, write the project's row: the run's provider and the model
   * its native session reported, with the decision's reason. A first run that fails never gets here, so it creates no
   * row. The `routing_affinity_*` event goes on the run. A concurrent write (version mismatch) is left alone.
   */
  private recordAffinity(run: RunRecord): void {
    if (run.provider === null) return;
    let decision = this.ledger.getRouteDecision(run.id);
    let cursor: RunRecord | undefined = run;
    for (let hops = 0; decision === undefined && cursor?.parent_run_id && hops < 32; hops++) {
      cursor = this.ledger.getRunRecord(cursor.parent_run_id);
      if (cursor !== undefined) decision = this.ledger.getRouteDecision(cursor.id);
    }
    if (decision === undefined) return;
    let affinity: { applies?: unknown; project_key?: unknown; affinity_switch_reason?: unknown } | undefined;
    try {
      affinity = (JSON.parse(decision.reasons_json) as { affinity?: typeof affinity }).affinity;
    } catch {
      return;
    }
    if (affinity?.applies !== true || typeof affinity.project_key !== "string") return;
    const key = affinity.project_key;
    const reason = AFFINITY_SWITCH_REASONS.find((r) => r === affinity?.affinity_switch_reason) ?? null;
    const provider = run.provider;
    const model = this.ledger.latestProviderBinding(run.meta_session_id, provider)?.model ?? null;
    this.ledger.immediate(() => {
      const row = this.ledger.getProjectAffinity(key);
      const written = this.ledger.writeProjectAffinity({
        projectKey: key,
        provider,
        model,
        lastRunId: run.id,
        reason,
        expectedVersion: row?.version,
      });
      if (!written) return;
      if (row?.reset_requested_at) {
        this.ledger.appendRunEvent({
          runId: run.id,
          type: "routing_affinity_reset",
          payload: { project_key: key, by: row.reset_by },
        });
      }
      if (row !== undefined && row.provider === provider && row.model === model) {
        this.ledger.appendRunEvent({
          runId: run.id,
          type: "routing_affinity_held",
          payload: { project_key: key, provider, model },
        });
      } else {
        this.ledger.appendRunEvent({
          runId: run.id,
          type: "routing_affinity_switched",
          payload: {
            project_key: key,
            from_provider: row?.provider ?? null,
            to_provider: provider,
            from_model: row?.model ?? null,
            to_model: model,
            reason,
          },
        });
      }
    });
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
    // T14.5 (FR-CTL-07): a parked meta-session or a full successor cap admits no successor.
    const refused = successorRefusal(this.ledger, failed, this.opts.loopBreaker ?? DEFAULT_LOOP_BREAKER);
    if (refused) {
      const { reason, ...extra } = refused;
      notScheduled(reason, extra);
      return;
    }
    // T14.4 (FR-CTL-06): a retry successor is a new run row, so the operator caps apply to it as to `submit`.
    const refusal = this.opts.budgets?.refusal(failed.project_id ?? undefined, now);
    if (refusal !== undefined) {
      this.budgetRefused({ projectId: failed.project_id, refusal });
      notScheduled("budget_exhausted", budgetRefusalDetails(refusal));
    }
    // T14.6 (FR-CTL-05): a successor is a new admission; a paused project (or a global pause) gets none.
    const paused = admissionPause(this.ledger, failed.project_id ?? undefined);
    if (paused !== undefined) {
      notScheduled("paused", { scope: paused.scope });
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
      // T14.5 (FR-CTL-07): failover and wait successors count toward the same cap and stop at a park.
      const refused = successorRefusal(this.ledger, failed, this.opts.loopBreaker ?? DEFAULT_LOOP_BREAKER);
      if (refused) {
        record({ outcome: "returned", ...refused });
        return;
      }
      // T14.6 (FR-CTL-05): no failover or wait successor into a paused project (or under a global pause).
      const paused = admissionPause(this.ledger, failed.project_id ?? undefined);
      if (paused !== undefined) {
        record({ outcome: "returned", reason: "paused", scope: paused.scope });
        return;
      }
      const routed = await this.failoverTarget(failed, notes);
      if (routed !== undefined) {
        const successor = await this.submitFailover(failed, routed, notes);
        if (successor !== undefined) {
          record({ outcome: "failover", successor_run_id: successor, to_provider: routed.provider });
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
        // T14.4 (FR-CTL-06): the wait successor is a new run row; the operator caps apply.
        const refusal = this.opts.budgets?.refusal(failed.project_id ?? undefined, now);
        if (refusal !== undefined) {
          this.budgetRefused({ projectId: failed.project_id, refusal });
          record({ outcome: "returned", reason: "budget_exhausted", ...budgetRefusalDetails(refusal) });
          return;
        }
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

  /**
   * BR-8 permission and the other eligible provider stage 2 selects (T7.2, LLD §17.3), with its route decision record,
   * or undefined with the reasons in `notes`.
   */
  private async failoverTarget(
    failed: RunRecord,
    notes: string[],
  ): Promise<{ provider: ProviderId; record: Omit<NewRouteDecision, "runId"> } | undefined> {
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
    if (answer.decision.eligible.length === 0) {
      notes.push("failover:none_eligible");
      return undefined;
    }
    const snapshot = JSON.parse(failed.policy_snapshot_json) as { project?: ProjectSnapshot };
    const scoring = this.opts.routing ?? DEFAULT_ROUTE_SCORING;
    const from = failed.provider as string;
    const scoreInputs = collectScoreInputs(this.ledger, answer.decision.eligible, scoring, this.now(), from);
    const routed = buildRouteDecision({
      input: answer.input,
      decision: answer.decision,
      admissible: answer.decision.eligible,
      preference: null,
      features: await this.routeFeatures(
        {
          objective: req.objective,
          constraints: req.constraints ?? [],
          verificationCommands: req.verification_commands?.length ?? 0,
          writable: failed.trust_profile !== "inspect-untrusted",
        },
        {
          runId: failed.id,
          metaSessionId: failed.meta_session_id,
          ...(snapshot.project ? { project: snapshot.project } : {}),
        },
      ),
      scoreInputs,
      // T7.5 (FR-CAP-06 amended, FR-RTE-07): a capacity failover re-bases the project's affinity on success.
      affinity: collectAffinityFacts(
        this.ledger,
        {
          projectId: failed.project_id ?? null,
          workspace: req.workspace,
          applies: true,
          requiredProvider: null,
          admissible: answer.decision.eligible,
          decision: answer.decision,
          scoreInputs,
          forcedReason: "capacity_exhausted",
        },
        scoring.affinity ?? DEFAULT_AFFINITY,
      ),
      weights: scoring.weights,
      basis: () => `handoff quota_failover from ${from}`,
      continuation: { mode: "handoff", reason: "quota_failover", from_provider: from },
      ...(reasons.project !== undefined
        ? {
            project: {
              id: (reasons.project as { id?: string }).id ?? "",
              excluded: reasons.project.excluded_providers ?? [],
            },
          }
        : {}),
    });
    if (routed.provider === null) {
      notes.push("failover:none_eligible");
      return undefined;
    }
    return { provider: routed.provider as ProviderId, record: routed.record };
  }

  /** The handoff successor on `target` (LLD §15.7 steps 5 and 6), or undefined with the reason in `notes`. */
  private async submitFailover(
    failed: RunRecord,
    routed: { provider: ProviderId; record: Omit<NewRouteDecision, "runId"> },
    notes: string[],
  ): Promise<string | undefined> {
    const target = routed.provider;
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
        routeDecision: routed.record,
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

  /** T14.4: the refusal observer never fails or delays admission. */
  private budgetRefused(notice: BudgetRefusalNotice): void {
    try {
      this.opts.onBudgetRefused?.(notice);
    } catch {
      // Observer errors are the observer's problem (as `onTransition`).
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
