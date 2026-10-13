/**
 * Provider-reported usage observations (T2.5, FR-CAP-01, ADR-0007).
 *
 * Converts `usage` NormalizedEvents into `usage_observation` rows. Only figures a provider reported are recorded; this
 * module never computes, sums, defaults or infers a number, and never produces a `controller_estimated` row (estimates
 * arrive with M6 and live apart from reported values). A run with no usage events yields no rows, so readers see null,
 * not zero. The event shapes behind the metrics are Assumptions held by each adapter (R2 names only the families).
 * Proposed (Delegated): one row per `usage` event; `harness` is the adapter id (as for `provider_binding`); model and
 * backing provider come from the run's `session_bound` event, falling back to the run's recorded model.
 */
import type { NormalizedEvent } from "../adapters/index.js";
import type { NewUsageObservation } from "../ledger/index.js";

export interface UsageContext {
  runId: string;
  provider: string;
  /** The run's recorded model, used when no `session_bound` event named one. */
  model?: string | null;
}

export function usageObservationsFromEvents(
  events: readonly NormalizedEvent[],
  ctx: UsageContext,
): NewUsageObservation[] {
  let model: string | null = ctx.model ?? null;
  let backingProvider: string | null = null;
  const out: NewUsageObservation[] = [];
  for (const ev of events) {
    if (ev.kind === "session_bound") {
      if (ev.model) model = ev.model;
      if (ev.backingProvider) backingProvider = ev.backingProvider;
    } else if (ev.kind === "usage" && ev.source === "provider_reported") {
      const metrics: Record<string, number | string | null> = {};
      for (const [k, v] of Object.entries(ev.metrics)) {
        if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "string" || v === null) metrics[k] = v;
      }
      if (Object.keys(metrics).length === 0) continue;
      out.push({
        runId: ctx.runId,
        provider: ctx.provider,
        harness: ctx.provider,
        backingProvider,
        model,
        source: "provider_reported",
        metrics,
      });
    }
  }
  return out;
}

export interface ReportedUsage {
  source: "provider_reported";
  provider: string;
  harness: string;
  backing_provider: string | null;
  model: string | null;
  observed_at: string;
  metrics: Record<string, number | string | null>;
}
