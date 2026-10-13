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
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import {
  type AdapterRegistry,
  type AdapterRun,
  type AdapterRunOutcome,
  BypassFlagError,
  createProbeRunner,
  type FailureCode,
  isIneligible,
  type NormalizedEvent,
  type PreflightCache,
  type ProbeRunner,
  type ProviderAdapter,
  type ProviderId,
  type ResolvedProfile,
  startAdapterRun,
} from "../adapters/index.js";
import type { ArtifactStore } from "../artifacts/index.js";
import { isUnderAllowedRoot, TRUST_PROFILES } from "../config/index.js";
import type { Ledger, NewRouteDecision, RunFieldPatch, RunRecord, RunState, TrustProfile } from "../ledger/index.js";
import {
  canonicalScopeJson,
  type PrivilegedScope,
  parsePrivilegedScope,
  privilegedScopeHash,
  resolveTrustProfile,
} from "../policy/index.js";
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
import type { PreparedWorkspace, WorkspaceManager } from "../workspace/index.js";
import {
  APPROVAL_DECIDED_EVENT,
  applyApprovalDecision,
  CLIENT_POLICY_DECIDER_PREFIX,
  type DecisionToApply,
  denyApprovalOnCancel,
  evaluateBypass,
} from "./approval.js";
import { requestHash } from "./request.js";
import {
  assertTransition,
  IllegalTransitionError,
  isTerminal,
  QUEUE_STATES,
  SLOT_STATES,
  TRANSITIONS,
  type TransitionRule,
} from "./states.js";

export type LifecycleErrorCode = "INVALID_REQUEST" | "QUEUE_FULL";

/** Admission or API error. No run row is written when it is thrown from `submit`. */
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
}

export interface MetaSessionContext {
  readonly workspace: string;
  readonly constraints: readonly string[];
  readonly trustProfile: TrustProfile;
  readonly provider: ProviderId;
  readonly priority: RunPriority;
  readonly clientId: string;
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
}

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

interface Execution {
  readonly runId: string;
  cancelRequested: boolean;
  handle: AdapterRun | undefined;
  done: Promise<void>;
}

const CANCELLABLE_DIRECT: ReadonlySet<RunState> = new Set(["AWAITING_APPROVAL", "QUEUED", "WAITING_CAPACITY"]);
/** BR-7 / FR-CAP-05 retry set (automatic retry itself is M6). */
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

  constructor(private readonly opts: RunLifecycleOptions) {
    if (!Number.isInteger(opts.globalConcurrency) || opts.globalConcurrency < 1) {
      throw new RangeError("globalConcurrency must be a positive integer");
    }
    this.ledger = opts.ledger;
    this.runner = opts.probeRunner ?? createProbeRunner();
    this.maxQueueDepth = opts.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
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
        const active = this.ledger.listRunsForMetaSession(metaSessionId).find((r) => !isTerminal(r.state));
        if (active) {
          throw new LifecycleError("INVALID_REQUEST", `meta-session ${metaSessionId} has an active run ${active.id}`);
        }
      } else {
        metaSessionId = this.ledger.createMetaSession({
          objective: stored.objective,
          constraints: stored.constraints,
        }).id;
      }
      const privileged = priv === undefined ? undefined : this.bindPrivileged(priv, req.clientId, metaSessionId);
      const run = this.ledger.createRun({
        metaSessionId,
        state: initial,
        trustProfile: req.trustProfile,
        policySnapshot: privileged?.snapshot ?? profile,
        request: stored,
        requestHash: hash,
        clientId: req.clientId,
        idempotencyKey: req.idempotencyKey ?? null,
        provider: req.provider,
        priority: PRIORITY_VALUES[stored.priority],
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
        }
      }
      if (req.routeDecision) this.ledger.insertRouteDecision({ ...req.routeDecision, runId: run.id });
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
      activeRunId: runs.find((r) => !isTerminal(r.state))?.id,
    };
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
    if (req.idempotencyKey !== undefined) {
      if (req.metaSessionId !== undefined) bad("idempotency keys apply to new meta-sessions only");
      if (req.idempotencyKey.length < 8 || req.idempotencyKey.length > 128) bad("idempotency key length out of range");
    }

    let workspace: string;
    if (req.metaSessionId !== undefined) {
      if (!this.ledger.getMetaSession(req.metaSessionId)) bad(`unknown meta-session ${req.metaSessionId}`);
      const first = this.ledger.listRunsForMetaSession(req.metaSessionId).at(-1);
      if (!first) return bad(`meta-session ${req.metaSessionId} has no runs`);
      workspace = (JSON.parse(first.request_json) as StoredRequest).workspace;
    } else {
      if (typeof req.workspace !== "string" || req.workspace.length === 0) return bad("workspace is required");
      workspace = req.workspace;
    }
    const canonical = await this.checkWorkspace(workspace, req.trustProfile);
    return {
      objective: req.objective,
      workspace: canonical,
      constraints,
      trust_profile: req.trustProfile,
      provider: req.provider,
      priority,
      ...(req.metaSessionId !== undefined ? { meta_session_id: req.metaSessionId } : {}),
      ...(req.resume !== undefined ? { resume_native_session_id: req.resume.nativeSessionId } : {}),
    };
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
    for (;;) {
      const picked = this.ledger.immediate((): RunRecord | undefined => {
        if (this.ledger.countRunsInStates(SLOT_STATES) >= this.opts.globalConcurrency) return undefined;
        const limit = this.opts.perProviderConcurrency;
        for (const run of this.ledger.listRunsInState("QUEUED")) {
          if (limit !== undefined && run.provider !== null) {
            if (this.ledger.countRunsInStates(SLOT_STATES, run.provider) >= limit) continue;
          }
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

    // PREFLIGHT (WF-6 order: probe, then auth; no login is ever attempted).
    const verdict = this.opts.eligibility
      ? await this.preflightEligibility(req, run0, profile)
      : await this.preflightM1(req, adapter);
    if (exec.cancelRequested) return this.cancelEarly(runId);
    if (!verdict.ok) return this.fail(runId, verdict.code, verdict.detail, verdict.extra);
    const binaryVersion = verdict.binaryVersion;

    // LEASED (T5): intent committed before the lease and worktree are created.
    this.move(this.current(runId), "LEASED", {}, { adapter_version: binaryVersion });
    let ws: PreparedWorkspace;
    try {
      ws = await this.opts.workspace.prepare({
        metaSessionId: run0.meta_session_id,
        runId,
        workspace: req.workspace,
        trustProfile: req.trust_profile,
        leaseTtlMs: this.opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      });
    } catch (err) {
      return this.fail(runId, "TOOL_FAILURE", `workspace preparation failed: ${errorText(err)}`);
    }
    if (exec.cancelRequested) return this.cancelEarly(runId);

    const cwd = ws.mode === "worktree" ? ws.worktreePath : ws.path;
    const compileReq = {
      runId,
      objective: req.objective,
      constraints: req.constraints,
      workspace: { cwd, writable: ws.mode === "worktree" },
    };
    const inv =
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
    if (ws.mode === "worktree") {
      this.opts.workspace.extendLease(runId, 2 * inv.timeouts.wallClockMs + inv.timeouts.killGraceMs);
    }

    // RUNNING (T9): pid/pgid persisted in the same transaction, before any output is read (LLD §8).
    let spawned = false;
    try {
      exec.handle = startAdapterRun(adapter, inv, {
        bypassApproved: profile.bypassApproved,
        // T3.17: the audit admits a bypass flag only for this profile being privileged with a scope that sets bypass.
        profile,
        ...(this.opts.baseEnv ? { baseEnv: this.opts.baseEnv } : {}),
        onSpawn: ({ pid, pgid }) => {
          this.move(
            this.current(runId),
            "RUNNING",
            { pid, pgid, proc_start_ticks: procStartTicks(pid), started_at: this.nowIso() },
            { pid, pgid },
          );
          spawned = true;
        },
        onEvent: (ev) => this.ledger.appendRunEvent({ runId, type: "provider_event", payload: compactEvent(ev) }),
      });
    } catch (err) {
      if (err instanceof BypassFlagError) return this.fail(runId, "PERMISSION_BLOCKED", err.message);
      throw err;
    }
    const out = await exec.handle.done;
    const meta = run0.meta_session_id;
    const streams = await this.storeStreams(runId, meta, out);
    if (!spawned) {
      return this.fail(runId, "PROCESS_CRASH", `spawn failed (${out.exit.outcome})`, { artifacts: streams });
    }

    if (out.result.nativeSessionId) {
      // FR-SES-02/03: remember the native session (from structured output only) so continue_task can resume it.
      this.ledger.recordProviderBinding({
        metaSessionId: meta,
        provider: req.provider,
        nativeSessionId: out.result.nativeSessionId,
      });
    }
    const pending = pendingOf(exec, out);
    const rule = pending.kind === "success" ? "T12" : "T13";
    this.move(
      this.current(runId),
      "FINALIZING",
      { exit_code: out.exit.exitCode, exit_signal: out.exit.signal },
      {
        pending: pending.kind,
        ...(pending.kind === "failure" ? { failure_code: pending.code } : {}),
        exit_outcome: out.exit.outcome,
        group_empty: out.groupEmpty,
      },
      rule,
    );
    await this.finalize(runId, meta, ws, pending, out, streams);
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

  /** FINALIZING → terminal (T15–T17): checkpoint, diff, head disposition (FRD §4.4), lease release. */
  private async finalize(
    runId: string,
    metaSessionId: string,
    ws: PreparedWorkspace,
    pending: Pending,
    out: AdapterRunOutcome,
    streams: Record<string, string>,
  ): Promise<void> {
    let outcome = pending;
    const artifacts: Record<string, string> = { ...streams };
    let changedFiles = 0;
    let nestedSkipped: readonly string[] = [];
    if (ws.mode === "worktree") {
      try {
        const assessment = await this.opts.workspace.assessMutation(runId);
        const success = outcome.kind === "success";
        const fin = await this.opts.workspace.finalize(runId, { advanceHead: success });
        artifacts.diff = fin.diffArtifactId;
        artifacts.changed_files = fin.changedFilesArtifactId;
        changedFiles = fin.changedFiles.length;
        nestedSkipped = fin.nestedRepositories;
        const failureCode = outcome.kind === "failure" ? outcome.code : undefined;
        this.ledger.appendRunEvent({
          runId,
          type: "workspace_assessment",
          payload: {
            mutated: assessment.mutated,
            reasons: assessment.reasons,
            replay_eligible: assessment.replayEligible,
            // Q-31 / ADR-0022: non-fatal warning; files inside these nested repositories are not captured.
            ...(fin.nestedRepositories.length > 0 ? { nested_repositories_skipped: fin.nestedRepositories } : {}),
            // BR-7: what M6 will act on; M1 never retries automatically (FR-CAP-05 is M6).
            retry_eligible: failureCode !== undefined && RETRYABLE.has(failureCode) && !assessment.mutated,
            auto_retry: false,
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
          this.ledger.appendRunEvent({
            runId,
            type: "rollback",
            payload: { head: ws.baseCommit, evidence_commit: fin.postCommit, mutated: assessment.mutated },
          });
        }
      } catch (err) {
        if (outcome.kind !== "failure") {
          outcome = { kind: "failure", code: "TOOL_FAILURE", detail: `finalization failed: ${errorText(err)}` };
        }
      }
    }

    const payload = {
      artifacts,
      changed_files: changedFiles,
      ...(nestedSkipped.length > 0 ? { nested_repositories_skipped: nestedSkipped } : {}),
      ...(out.result.summary ? { summary: out.result.summary.slice(0, SUMMARY_MAX) } : {}),
      ...(out.result.nativeSessionId ? { native_session_id: out.result.nativeSessionId } : {}),
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
        this.move(
          run,
          "FAILED",
          { failure_code: outcome.code, failure_detail: outcome.detail, finished_at: finished },
          payload,
        );
      }
    });
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
          cur = this.move(cur, "FINALIZING", {}, { pending: "failure", failure_code: "TOOL_FAILURE" }, "T13");
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
      set,
      payload: { rule: rule.id, ...payload },
    });
    if (!moved) return undefined;
    this.opts.onTransition?.({ runId: run.id, from: run.state, to, rule: rule.id });
    if (isTerminal(to)) queueMicrotask(() => this.settle(run.id));
    return moved;
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

const LOST_RACE = Symbol("lost-race");

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

/** Linux: process start time in clock ticks (field 22 of /proc/<pid>/stat), guarding PID reuse (LLD §8). */
export function procStartTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(rest[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}
