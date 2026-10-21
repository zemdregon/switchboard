/**
 * Capacity input collector (M6, T6.2; LLD §16.2). Reads only the rows the LLD table lists: terminal runs, `rate_limit`
 * provider events, `provider_reported` usage rows, the `provider_health` breaker columns and slot counts. It never reads
 * `inner_agent` or `controller_estimated` usage rows (BR-41, FR-INN-15), inner-agent or retrieval records, or artifact
 * content. Read-only.
 */
import type { Ledger, RunState } from "../ledger/index.js";
import { SLOT_STATES } from "../lifecycle/states.js";
import type { CapacityInputs, CapacityRunInput } from "./estimate.js";
import { REPORTED_USAGE_ROWS, type ReportedUsageRow, reportedShareKeys } from "./reported-usage.js";

/** What the caller knows about a provider from the registry and configuration. */
export interface CapacityProviderInfo {
  /** Adapter provider id (as stored in `run.provider`). */
  id: string;
  enabled: boolean;
  weight: number | null;
  /** Per-provider concurrency limit in force. */
  concurrencyLimit: number;
}

const TERMINAL: ReadonlySet<RunState> = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
/**
 * Reconciliation writes `failure_detail` with this marker for a run orphaned by a controller restart
 * (`RECONCILE_CAUSE` in `src/reconcile/reconcile.ts`; a test keeps them equal). Not imported, so that this read-only
 * module does not depend on the reconciliation code.
 */
export const RESTART_MARKER = "cause controller_restart";

export function collectCapacityInputs(
  ledger: Ledger,
  provider: CapacityProviderInfo,
  windowSeconds: number,
  now: Date,
): CapacityInputs {
  const since = new Date(now.getTime() - windowSeconds * 1000).toISOString();
  const runs: CapacityRunInput[] = ledger
    .listTerminalRunsForProviderSince(provider.id, since)
    .filter((r) => TERMINAL.has(r.state))
    .map((r) => ({
      state: r.state as CapacityRunInput["state"],
      failureCode: r.failure_code,
      started: r.started_at !== null,
      controllerRestart: r.failure_code === "PROCESS_CRASH" && (r.failure_detail ?? "").includes(RESTART_MARKER),
    }));
  const rateLimitSignals = ledger.listRateLimitSignalsSince(provider.id, since).map((s) => ({ resetAt: s.reset_at }));
  const usage = ledger.listProviderReportedUsageSince(provider.id, since).map((u) => ({
    metrics: parseMetrics(u.metrics_json),
    observedAt: u.observed_at,
  }));
  // ADR-0079: the newest rows per declared window share key, looked back one window length (not the estimator window).
  const reportedUsageRows: ReportedUsageRow[] = [];
  for (const { key, lengthSeconds } of reportedShareKeys(provider.id)) {
    const from = new Date(now.getTime() - lengthSeconds * 1000).toISOString();
    for (const row of ledger.listLatestProviderReportedUsageWithKey(provider.id, key, from, REPORTED_USAGE_ROWS)) {
      reportedUsageRows.push({ metrics: parseMetrics(row.metrics_json), observedAt: row.observed_at });
    }
  }
  const health = ledger.getProviderHealth(provider.id);
  return {
    provider: provider.id,
    enabled: provider.enabled,
    weight: provider.weight,
    runs,
    rateLimitSignals,
    usage,
    reportedUsageRows,
    breaker: {
      state: health?.breaker_state ?? "CLOSED",
      until: health?.breaker_until ?? null,
      consecutiveFailures: health?.consecutive_failures ?? 0,
    },
    slots: { inUse: ledger.countRunsInStates(SLOT_STATES, provider.id), limit: provider.concurrencyLimit },
  };
}

function parseMetrics(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
