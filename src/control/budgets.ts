/**
 * Operator budget caps at admission (T14.4; FR-CTL-06, FR-CAP-04, NFR-PERF-03, ADR-0007; LLD §3.4.3, §3.4.6, §3.4.7;
 * [spike](../../docs/research/operator-budget-admission-spike-2026-10-15.md)).
 *
 * Four dimensions, each an **operator** value from `control_plane.budgets` and never a provider limit: runs per UTC
 * day, concurrent (non-terminal) runs, wall clock per run and provider-reported usage per rolling window. The run
 * lifecycle asks {@link BudgetEvaluator.refusal} inside its admission transaction; a refusal writes no run row and
 * carries the needs-attention reason `budget_exhausted`. No run state is added (FRD §4 unchanged).
 *
 * Everything here is **derived on read** from ledger rows and the configuration, at the evaluator's clock:
 * exhaustion clears by itself when the UTC day rolls over, observations age out of the window, a run reaches a
 * terminal state or the operator raises the cap. Nothing is written to SQLite and no migration is added: the LLD §3.4.7
 * `control_plane_state.budget_flags_json` row (a T14.6 migration) is not needed to answer "is a refusal active now?",
 * so T14.4 records a refusal through the lifecycle's `onBudgetRefused` hook (operator log and the `budget_exhausted`
 * sink event) instead of a ledger row.
 *
 * Delegated (T14.4; recorded in LLD §3.4.6):
 * - Scopes: a project override replaces the global cap for that project's **own** counting; the global cap still
 *   counts every run (all projects and workspace-path runs). Both are enforced; the project scope is checked first.
 *   A run without a project is subject to the global caps only.
 * - "Over a cap": `runs_per_day`, `concurrent_runs` and `usage_per_window` refuse when `used >= limit` (admitting one
 *   more would exceed the cap; a cap of 0 admits nothing); `wall_clock_per_run` refuses while a non-terminal run in the
 *   scope has been running longer than the cap (`used > limit`, from `started_at`, which is set at LEASED) and clears
 *   when that run ends. Admitting a run does not pre-check its own duration; the provider process timeouts still apply.
 * - `runs_per_day` counts every run row created since UTC midnight (admitted, awaiting approval, successors), not only
 *   terminal ones; `window_ends_at` is the next UTC midnight.
 * - `usage_per_window` sums `provider_reported` observations in `now - window_seconds .. now`: `total_tokens` when a
 *   row reports it, else every finite numeric metric named `tokens` or ending in `_tokens` (conservative: a cached or
 *   thinking subset may be counted twice, so the cap bites earlier, never later). `window_ends_at` is when the oldest
 *   counted observation leaves the window. `controller_estimated` and `inner_agent` rows never count.
 * - {@link ControlPlaneFacts.budgetExhausted} answers the project scope for a project id and the global scope for
 *   `'*'` (the T14.2 reader asks both), so the envelope and digest reflect the same evaluation that refuses admission.
 * - The MCP mapping (`src/mcp/errors.ts`) is `ELIGIBILITY_NONE` with `details.reason = "BUDGET_EXHAUSTED"`, the
 *   `QUEUE_FULL` precedent (ROADMAP Q-5); a queued work item (T15.1) is retried, not failed.
 */

import { type BudgetCaps, type BudgetDimension, type BudgetSettings, hasAnyCap } from "../config/budgets.js";
import type { Ledger, ProviderUsageRow } from "../ledger/index.js";
// Type-only on purpose: the lifecycle imports this module, and `needs-attention.ts` imports the lifecycle.
import type { ControlPlaneFacts } from "./needs-attention.js";

/** `NO_CONTROL_PLANE_FACTS` of `needs-attention.ts`, repeated here to keep the import above type-only. */
const NO_FACTS: ControlPlaneFacts = { metaSessionParked: () => false, budgetExhausted: () => false };

/** LLD §3.4.3 `budget.caps[]` item: `limit: null` means unset (never a provider limit). */
export interface BudgetCapStatus {
  key: BudgetDimension;
  limit: number | null;
  used: number;
  window_ends_at: string | null;
}

/** LLD §3.4.3 `budget` object for one project (or the global scope). */
export interface BudgetStatus {
  exhausted: boolean;
  caps: BudgetCapStatus[];
}

/** Why admission was refused: the first cap over its limit, project scope before global. */
export interface BudgetRefusal {
  readonly scope: "project" | "global";
  /** The project id, or `'*'` for the global scope. */
  readonly project_id: string;
  readonly cap: BudgetDimension;
  readonly limit: number;
  readonly used: number;
  readonly window_ends_at: string | null;
  /** `wall_clock_per_run` only: the run over the cap. */
  readonly run_id?: string;
}

/** What the run lifecycle needs: the refusal check at admission and the facts the read path reuses. */
export interface BudgetAdmission {
  /** The refusal for admitting one more run of `projectId` (undefined: a workspace-path run) at `now`, if any. */
  refusal(projectId: string | undefined, now: Date): BudgetRefusal | undefined;
  /** {@link ControlPlaneFacts} over the same evaluation (`metaSessionParked` is never answered here). */
  readonly facts: ControlPlaneFacts;
}

const ONE_DAY_MS = 86_400_000;

/** The UTC calendar day of `now`: its start and the next midnight, ISO 8601. */
export function utcDayWindow(now: Date): { start: string; end: string } {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { start: new Date(start).toISOString(), end: new Date(start + ONE_DAY_MS).toISOString() };
}

/** The provider-reported token count of one observation; see the module comment (Delegated rule). */
export function reportedTokens(metricsJson: string): number {
  let metrics: unknown;
  try {
    metrics = JSON.parse(metricsJson);
  } catch {
    return 0;
  }
  if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) return 0;
  const m = metrics as Record<string, unknown>;
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (finite(m.total_tokens)) return Math.floor(m.total_tokens);
  let sum = 0;
  for (const [k, v] of Object.entries(m)) if ((k === "tokens" || k.endsWith("_tokens")) && finite(v)) sum += v;
  return Math.floor(sum);
}

export interface BudgetEvaluatorOptions {
  readonly ledger: Ledger;
  readonly settings: BudgetSettings;
  /** Injectable clock; defaults to the system clock. The lifecycle passes its own `now` to {@link refusal}. */
  readonly now?: () => Date;
}

/** Evaluates the operator caps over ledger rows. One per ledger; see {@link registerBudgets}. */
export class BudgetEvaluator implements BudgetAdmission {
  readonly #ledger: Ledger;
  readonly #settings: BudgetSettings;
  readonly #now: () => Date;
  readonly facts: ControlPlaneFacts;

  constructor(opts: BudgetEvaluatorOptions) {
    this.#ledger = opts.ledger;
    this.#settings = opts.settings;
    this.#now = opts.now ?? (() => new Date());
    this.facts = {
      metaSessionParked: () => false,
      budgetExhausted: (projectId) =>
        projectId === "*"
          ? this.scopeRefusal("global", undefined, this.#now()) !== undefined
          : this.scopeRefusal("project", projectId, this.#now()) !== undefined,
    };
  }

  /** True when any cap is configured in any scope (with none, admission never queries the ledger). */
  get configured(): boolean {
    return hasAnyCap(this.#settings.global) || [...this.#settings.projects.values()].some(hasAnyCap);
  }

  refusal(projectId: string | undefined, now: Date = this.#now()): BudgetRefusal | undefined {
    return (
      (projectId === undefined ? undefined : this.scopeRefusal("project", projectId, now)) ??
      this.scopeRefusal("global", undefined, now)
    );
  }

  /**
   * LLD §3.4.3 `budget` for `projectId`: every dimension, the project's own cap when it has one, else the global cap
   * (counted globally), else `limit: null` with the project's own count. `exhausted` is {@link refusal} for the project.
   */
  status(projectId: string, now: Date = this.#now()): BudgetStatus {
    const own = this.#settings.projects.get(projectId) ?? {};
    const caps = DIMENSIONS.map((key) => {
      if (capOf(own, key) !== undefined) return this.measure(key, own, projectId, now);
      if (capOf(this.#settings.global, key) !== undefined)
        return this.measure(key, this.#settings.global, undefined, now);
      return this.measure(key, {}, projectId, now);
    }).map(capStatus);
    return { exhausted: this.refusal(projectId, now) !== undefined, caps };
  }

  /** LLD §3.4.3 `budget` for the global scope (`'*'`): every run counted. */
  globalStatus(now: Date = this.#now()): BudgetStatus {
    const caps = DIMENSIONS.map((key) => this.measure(key, this.#settings.global, undefined, now)).map(capStatus);
    return { exhausted: this.scopeRefusal("global", undefined, now) !== undefined, caps };
  }

  private scopeRefusal(
    scope: "project" | "global",
    projectId: string | undefined,
    now: Date,
  ): BudgetRefusal | undefined {
    const caps = scope === "global" ? this.#settings.global : (this.#settings.projects.get(projectId as string) ?? {});
    for (const key of DIMENSIONS) {
      if (capOf(caps, key) === undefined) continue;
      const m = this.measure(key, caps, projectId, now);
      if (m.limit === null || !over(key, m.used, m.limit)) continue;
      return {
        scope,
        project_id: scope === "global" ? "*" : (projectId as string),
        cap: key,
        limit: m.limit,
        used: m.used,
        window_ends_at: m.window_ends_at,
        ...(m.runId !== undefined ? { run_id: m.runId } : {}),
      };
    }
    return undefined;
  }

  /** `used` for one dimension in one counting scope (`projectId` undefined: every run), with the cap's `limit`. */
  private measure(
    key: BudgetDimension,
    caps: BudgetCaps,
    projectId: string | undefined,
    now: Date,
  ): BudgetCapStatus & { runId?: string } {
    const limit = capOf(caps, key) ?? null;
    switch (key) {
      case "runs_per_day": {
        const day = utcDayWindow(now);
        return { key, limit, used: this.#ledger.countRunsCreatedSince(day.start, projectId), window_ends_at: day.end };
      }
      case "concurrent_runs":
        return { key, limit, used: this.#ledger.listOpenRunClocks(projectId).length, window_ends_at: null };
      case "wall_clock_per_run": {
        let used = 0;
        let runId: string | undefined;
        for (const r of this.#ledger.listOpenRunClocks(projectId)) {
          if (r.started_at === null) continue;
          const started = Date.parse(r.started_at);
          if (!Number.isFinite(started)) continue; // fail closed on the clock: an unreadable timestamp counts nothing
          const seconds = Math.floor((now.getTime() - started) / 1000);
          if (seconds > used) {
            used = seconds;
            runId = r.id;
          }
        }
        return { key, limit, used, window_ends_at: null, ...(runId !== undefined ? { runId } : {}) };
      }
      case "usage_per_window": {
        const windowSeconds = caps.usagePerWindow?.windowSeconds;
        if (windowSeconds === undefined) return { key, limit: null, used: 0, window_ends_at: null };
        const since = new Date(now.getTime() - windowSeconds * 1000).toISOString();
        const rows: ProviderUsageRow[] = this.#ledger.listReportedUsageSince(since, projectId);
        const used = rows.reduce((n, r) => n + reportedTokens(r.metrics_json), 0);
        const oldest = rows[0]?.observed_at;
        const ends = oldest === undefined ? null : new Date(Date.parse(oldest) + windowSeconds * 1000);
        return {
          key,
          limit,
          used,
          window_ends_at: ends !== null && Number.isFinite(ends.getTime()) ? ends.toISOString() : null,
        };
      }
    }
  }
}

const DIMENSIONS: readonly BudgetDimension[] = [
  "runs_per_day",
  "concurrent_runs",
  "wall_clock_per_run",
  "usage_per_window",
];

/** The closed LLD §3.4.3 item: the measuring run id stays inside (it is named in a refusal, not in `caps[]`). */
const capStatus = ({ key, limit, used, window_ends_at }: BudgetCapStatus): BudgetCapStatus => ({
  key,
  limit,
  used,
  window_ends_at,
});

function capOf(caps: BudgetCaps, key: BudgetDimension): number | undefined {
  switch (key) {
    case "runs_per_day":
      return caps.runsPerDay;
    case "concurrent_runs":
      return caps.concurrentRuns;
    case "wall_clock_per_run":
      return caps.wallClockPerRunSeconds;
    case "usage_per_window":
      return caps.usagePerWindow?.maxReportedTokens;
  }
}

/** The "over a cap" rule per dimension (module comment). */
function over(key: BudgetDimension, used: number, limit: number): boolean {
  return key === "wall_clock_per_run" ? used > limit : used >= limit;
}

/** One line for the refusal: operator wording only (cap, budget), never provider quota, TPM/RPM or subscription. */
export function budgetRefusalMessage(r: BudgetRefusal): string {
  const scope = r.scope === "global" ? "global" : `project ${r.project_id}`;
  const usage: Record<BudgetDimension, string> = {
    runs_per_day: `${r.used} runs admitted this UTC day, cap ${r.limit}`,
    concurrent_runs: `${r.used} runs in progress, cap ${r.limit}`,
    wall_clock_per_run: `run ${r.run_id ?? "?"} has run for ${r.used} s, cap ${r.limit} s`,
    usage_per_window: `${r.used} reported tokens in the window, cap ${r.limit}`,
  };
  const until = r.window_ends_at === null ? "" : ` (window ends ${r.window_ends_at})`;
  return (
    `operator budget cap ${r.cap} reached for ${scope}: ${usage[r.cap]}${until}; admission refused until the cap ` +
    "resets or the operator raises it (control_plane.budgets)"
  );
}

/** `details` of the refusal error: the cap named as the digest names it, plus the needs-attention reason. */
export function budgetRefusalDetails(r: BudgetRefusal): Record<string, unknown> {
  return {
    reason: "BUDGET_EXHAUSTED",
    needs_attention_reason: "budget_exhausted",
    scope: r.scope,
    project_id: r.project_id,
    cap: r.cap,
    limit: r.limit,
    used: r.used,
    window_ends_at: r.window_ends_at,
    ...(r.run_id !== undefined ? { run_id: r.run_id } : {}),
  };
}

// ---- read-path registry ------------------------------------------------------------------------------------------

const registry = new WeakMap<Ledger, BudgetAdmission>();

/**
 * Publish the admission's facts for the ledger's read path. The run lifecycle calls this with the evaluator it refuses
 * admission with, so `get_run`, `list_runs` and the digest derive `budget_exhausted` from the same caps and clock
 * (`src/mcp/envelope.ts` reads {@link budgetControlFacts}). One admission per ledger; a later call replaces it.
 */
export function registerBudgets(ledger: Ledger, budgets: BudgetAdmission): void {
  registry.set(ledger, budgets);
}

/** {@link ControlPlaneFacts} whose `budgetExhausted` asks the registered evaluator; other facts come from `base`. */
export function budgetControlFacts(ledger: Ledger, base: ControlPlaneFacts = NO_FACTS): ControlPlaneFacts {
  return {
    metaSessionParked: (id) => base.metaSessionParked(id),
    budgetExhausted: (projectId) =>
      (registry.get(ledger)?.facts.budgetExhausted(projectId) ?? false) || base.budgetExhausted(projectId),
  };
}

/** The registered evaluator's LLD §3.4.3 `budget` for a project, when one is registered (for the digest, T14.3). */
export function budgetStatusFor(ledger: Ledger, projectId: string, now?: Date): BudgetStatus | undefined {
  const b = registry.get(ledger);
  return b instanceof BudgetEvaluator ? b.status(projectId, now) : undefined;
}
