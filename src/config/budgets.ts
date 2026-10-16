/**
 * `control_plane.budgets` configuration (T14.4; FR-CTL-06, LLD §3.4.6, TDD §3.1). Operator caps on admission: runs per
 * UTC day, concurrent (non-terminal) runs, wall clock per run and provider-reported usage per rolling window, globally
 * and per project. Every cap is an operator value and is never a provider limit (ADR-0007); an absent key means
 * **unlimited** for that dimension (not zero, and no Assumption default exists for a cap).
 *
 * The JSON schema in `schema.ts` embeds {@link budgetCapsSchema} for types and ranges (`projects.<id>` keys follow the
 * project id pattern there; an override for a project that never exists caps nothing, since a dynamic project may be
 * created after startup). No message here echoes a configured value.
 *
 * Delegated (T14.4, fail closed; key names are LLD §3.4.6's):
 * - `usage_per_window.window_seconds` is at least 60 (the spike's Proposed minimum) and at most 31 days
 *   (**Assumption**: a sanity bound, no source).
 * - Integer caps are at most 1 000 000 (**Assumption**: a sanity bound); `wall_clock_per_run_seconds` at most 31 days.
 * - A cap of 0 is a valid operator choice ("admit nothing in this scope") and is enforced as written.
 */

/** LLD §3.4.3 `caps[].key`, the closed list of budget dimensions. */
export const BUDGET_DIMENSIONS = ["runs_per_day", "concurrent_runs", "wall_clock_per_run", "usage_per_window"] as const;
export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

/** Assumptions (Delegated, T14.4); see the module comment. */
export const MIN_USAGE_WINDOW_SECONDS = 60;
export const MAX_USAGE_WINDOW_SECONDS = 31 * 86_400;
export const MAX_WALL_CLOCK_PER_RUN_SECONDS = 31 * 86_400;
export const MAX_BUDGET_COUNT = 1_000_000;
/** Upper bound on `max_reported_tokens` (**Assumption**: a sanity bound; tokens are provider-reported integers). */
export const MAX_BUDGET_TOKENS = 1_000_000_000_000;

/** One scope's caps as written in the config file (`global` or `projects.<id>`), LLD §3.4.6. */
export interface BudgetCapsConfig {
  runs_per_day?: number;
  concurrent_runs?: number;
  wall_clock_per_run_seconds?: number;
  usage_per_window?: { window_seconds: number; max_reported_tokens: number };
}

/** `control_plane.budgets` as written in the config file. */
export interface BudgetsConfigInput {
  global?: BudgetCapsConfig;
  projects?: Record<string, BudgetCapsConfig>;
}

/** JSON schema of one scope's caps (`global`, `projects.<id>`); `schema.ts` embeds it under `control_plane.budgets`. */
export const budgetCapsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    runs_per_day: { type: "integer", minimum: 0, maximum: MAX_BUDGET_COUNT },
    concurrent_runs: { type: "integer", minimum: 0, maximum: MAX_BUDGET_COUNT },
    wall_clock_per_run_seconds: { type: "integer", minimum: 0, maximum: MAX_WALL_CLOCK_PER_RUN_SECONDS },
    usage_per_window: {
      type: "object",
      additionalProperties: false,
      required: ["window_seconds", "max_reported_tokens"],
      properties: {
        window_seconds: { type: "integer", minimum: MIN_USAGE_WINDOW_SECONDS, maximum: MAX_USAGE_WINDOW_SECONDS },
        max_reported_tokens: { type: "integer", minimum: 0, maximum: MAX_BUDGET_TOKENS },
      },
    },
  },
} as const;

/** One scope's resolved caps. `undefined` means unset: unlimited for that dimension, reported as `limit: null`. */
export interface BudgetCaps {
  readonly runsPerDay?: number;
  readonly concurrentRuns?: number;
  readonly wallClockPerRunSeconds?: number;
  readonly usagePerWindow?: { readonly windowSeconds: number; readonly maxReportedTokens: number };
}

/** Resolved `control_plane.budgets`; always set, empty scopes when the section is absent. */
export interface BudgetSettings {
  readonly global: BudgetCaps;
  /** Per-project overrides by project id. A project absent here has only the global caps. */
  readonly projects: ReadonlyMap<string, BudgetCaps>;
}

export const NO_BUDGETS: BudgetSettings = { global: {}, projects: new Map() };

/** True when at least one cap is set in `caps`. */
export function hasAnyCap(caps: BudgetCaps): boolean {
  return (
    caps.runsPerDay !== undefined ||
    caps.concurrentRuns !== undefined ||
    caps.wallClockPerRunSeconds !== undefined ||
    caps.usagePerWindow !== undefined
  );
}

function resolveCaps(c: BudgetCapsConfig | undefined): BudgetCaps {
  if (c === undefined) return {};
  return {
    ...(c.runs_per_day !== undefined ? { runsPerDay: c.runs_per_day } : {}),
    ...(c.concurrent_runs !== undefined ? { concurrentRuns: c.concurrent_runs } : {}),
    ...(c.wall_clock_per_run_seconds !== undefined ? { wallClockPerRunSeconds: c.wall_clock_per_run_seconds } : {}),
    ...(c.usage_per_window !== undefined
      ? {
          usagePerWindow: {
            windowSeconds: c.usage_per_window.window_seconds,
            maxReportedTokens: c.usage_per_window.max_reported_tokens,
          },
        }
      : {}),
  };
}

/** Resolve the section as validated by the schema. Absent means no cap anywhere. */
export function resolveBudgets(input: BudgetsConfigInput | undefined): BudgetSettings {
  return {
    global: resolveCaps(input?.global),
    projects: new Map(Object.entries(input?.projects ?? {}).map(([id, caps]) => [id, resolveCaps(caps)])),
  };
}
