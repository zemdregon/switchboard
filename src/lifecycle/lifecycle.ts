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
 * - M1 preflight runs `probe` and `authPreflight` on every dispatch (no cache yet; NFR-PERF-02 caching is M2). Any
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
  type CollectDeps,
  collectFacts,
  type EligibilityDecision,
  type EligibilityInput,
  failureCodeForReason,
  filterEligible,
} from "../routing/index.js";
import { usageObservationsFromEvents } from "../usage/index.js";
import { gitText } from "../workspace/git.js";
import type { PreparedWorkspace, WorkspaceManager } from "../workspace/index.js";
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
}

/** Admission-time eligibility question (FRD V11); answered by the shared stage-1 filter. */
export interface EligibilityQuestion {
  readonly candidates: readonly ProviderId[];
  readonly requiredProvider?: ProviderId;
  readonly trustProfile: TrustProfile;
  readonly clientMaxProfile: TrustProfile;
  /** Canonical workspace path; used only to build the pure compile request. */
  readonly cwd: string;
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
    const hash = req.requestHash ?? requestHash(stored);
    const initial: RunState = req.trustProfile === "privileged" ? "AWAITING_APPROVAL" : "QUEUED";
    const profile = this.opts.resolveProfile(req.trustProfile);

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
      const run = this.ledger.createRun({
        metaSessionId,
        state: initial,
        trustProfile: req.trustProfile,
        policySnapshot: profile,
        request: stored,
        requestHash: hash,
        clientId: req.clientId,
        idempotencyKey: req.idempotencyKey ?? null,
        provider: req.provider,
        priority: PRIORITY_VALUES[stored.priority],
      });
      if (req.routeDecision) this.ledger.insertRouteDecision({ ...req.routeDecision, runId: run.id });
      const rule = initial === "QUEUED" ? "T1" : "T2";
      this.ledger.appendRunEvent({
        runId: run.id,
        type: "state_transition",
        payload: { from: null, to: initial, rule },
      });
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
  async cancel(runId: string, reason = "cancel_run"): Promise<RunState> {
    const run = this.ledger.getRunRecord(runId);
    if (!run) throw new LifecycleError("INVALID_REQUEST", `unknown run ${runId}`);
    if (isTerminal(run.state) || run.state === "FINALIZING") return run.state;
    if (CANCELLABLE_DIRECT.has(run.state)) {
      const moved = this.tryMove(run, "CANCELLED", { finished_at: this.nowIso() }, { reason }, "T19");
      if (moved) return moved.state;
      return this.cancel(runId, reason); // lost a race (e.g. dispatched meanwhile): re-read and re-decide
    }
    const exec = this.inflight.get(runId);
    if (!exec) return run.state;
    exec.cancelRequested = true;
    if (exec.handle) void exec.handle.cancel();
    return (this.ledger.getRunRecord(runId) as RunRecord).state;
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
    const profile = this.opts.resolveProfile(q.trustProfile);
    const input = await collectFacts(
      {
        candidates: q.candidates,
        ...(q.requiredProvider !== undefined ? { requiredProvider: q.requiredProvider } : {}),
        trustProfile: q.trustProfile,
        clientMaxProfile: q.clientMaxProfile,
        profile,
        requirements: {
          network: profile.network,
          writable: q.trustProfile !== "inspect-untrusted",
          ...(profile.shellAllowlist ? { shellAllowlist: profile.shellAllowlist } : {}),
        },
        cwd: q.cwd,
      },
      { ...this.opts.eligibility, registry: this.opts.adapters, runner: this.runner },
    );
    return { input, decision: filterEligible(input) };
  }

  // ---- admission ----------------------------------------------------------------------------------------------

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
    const profile = JSON.parse(run0.policy_snapshot_json) as ResolvedProfile;
    const adapter = this.opts.adapters.get(req.provider);
    if (!adapter) return this.fail(runId, "ELIGIBILITY_NONE", `adapter ${req.provider} is not registered`);

    // PREFLIGHT (WF-6 order: probe, then auth; no login is ever attempted).
    const verdict = this.opts.eligibility
      ? await this.preflightEligibility(req, run0)
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
    if (isIneligible(inv)) return this.fail(runId, "PERMISSION_BLOCKED", `${inv.reason}: ${inv.detail}`);
    if (ws.mode === "worktree") {
      this.opts.workspace.extendLease(runId, 2 * inv.timeouts.wallClockMs + inv.timeouts.killGraceMs);
    }

    // RUNNING (T9): pid/pgid persisted in the same transaction, before any output is read (LLD §8).
    let spawned = false;
    try {
      exec.handle = startAdapterRun(adapter, inv, {
        bypassApproved: profile.bypassApproved,
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
    const probe = await adapter.probe(this.runner);
    const failedStep = probe.steps.find((s) => !s.ok);
    if (failedStep) {
      return {
        ok: false,
        code: "ELIGIBILITY_NONE",
        detail: `${req.provider}: preflight step ${failedStep.step} failed`,
      };
    }
    const auth = await adapter.authPreflight(this.runner);
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
  private async preflightEligibility(req: StoredRequest, run: RunRecord): Promise<PreflightVerdict> {
    const { input, decision } = await this.checkEligibility({
      candidates: [req.provider],
      requiredProvider: req.provider,
      trustProfile: run.trust_profile,
      clientMaxProfile: run.trust_profile,
      cwd: req.workspace,
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
    if (ws.mode === "worktree") {
      try {
        const assessment = await this.opts.workspace.assessMutation(runId);
        const success = outcome.kind === "success";
        const fin = await this.opts.workspace.finalize(runId, { advanceHead: success });
        artifacts.diff = fin.diffArtifactId;
        artifacts.changed_files = fin.changedFilesArtifactId;
        changedFiles = fin.changedFiles.length;
        const failureCode = outcome.kind === "failure" ? outcome.code : undefined;
        this.ledger.appendRunEvent({
          runId,
          type: "workspace_assessment",
          payload: {
            mutated: assessment.mutated,
            reasons: assessment.reasons,
            replay_eligible: assessment.replayEligible,
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
