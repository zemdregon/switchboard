/**
 * Pacing gate (M6, T6.8; FR-CAP-10, FR-CAP-07 as amended, BR-51, LLD §16.9, ADR-0055 item 8, ADR-0043 item 8 as
 * amended). The gate emulates an enforceable limit from observed usage: with `capacity.pacing.mode: gate`, a
 * subscription is deferred while any of its windows has used at least `min(T, T × elapsed + B)` of its share, until the
 * latest gate-open time among those windows. The figures and the per-window verdict are the ones the T6.14 projection
 * publishes (`pacingViews`, `gateOpenMs`), so `get_capacity` and the gate never disagree. No token bucket at a published
 * rate is built: none is published.
 *
 * Read-only: no run, probe or provider call is made here. Admission reads the result as a per-candidate fact (stage 2,
 * `PACING_DEFERRED`), `pump()` as a hold in `QUEUED` (`pacing_hold`). Not configured: an empty map and no ledger read.
 */

import type { PacingSettings, SubscriptionSettings } from "../config/capacity.js";
import type { Ledger } from "../ledger/index.js";
import { gateOpenMs, pacingViews } from "./projection.js";
import type { UsedSource } from "./usage-window.js";

/** The per-candidate verdict recorded at admission (LLD §16.9). Not a stage-1 reason and never a BR-3 code. */
export const PACING_DEFERRED = "PACING_DEFERRED";

/** Run event appended by `pump()` while it holds a run for its subscription's gate (LLD §16.9). */
export const PACING_HOLD_EVENT = "pacing_hold";

/** `capacity.subscriptions` and `capacity.pacing` as resolved; the lifecycle receives them only when the file sets them. */
export interface PacingGateSettings {
  readonly subscriptions: readonly SubscriptionSettings[];
  readonly pacing: PacingSettings;
}

/** Why a provider's subscription is deferred: the window whose gate opens last, and that time. */
export interface PacingDeferral {
  subscription: string;
  window: string;
  /** ISO instant, millisecond precision: the subscription's gate-open time. */
  until: string;
  /** Source of the used share that deferred the window (`provider_reported` or `controller_estimated`). */
  source: UsedSource;
}

/**
 * Deferred subscriptions at `now`, keyed by adapter provider id (as `run.provider`). A subscription whose gate-open time
 * is not after `now` is not deferred: at the gate-open instant the pace line has caught up, so the run goes ahead.
 */
export function pacingDeferrals(
  ledger: Ledger,
  settings: PacingGateSettings | undefined,
  now: Date,
): ReadonlyMap<string, PacingDeferral> {
  const out = new Map<string, PacingDeferral>();
  if (settings === undefined || settings.pacing.mode !== "gate" || settings.subscriptions.length === 0) return out;
  const views = pacingViews(ledger, { windowSeconds: 0, confidenceRuns: 0, ...settings }, now);
  const nowMs = now.getTime();
  for (const view of views ?? []) {
    let latest: { open: number; window: string; source: UsedSource } | undefined;
    for (const w of view.windows) {
      const open = gateOpenMs(w, settings.pacing);
      if (open !== null && (latest === undefined || open > latest.open)) {
        latest = { open, window: w.id, source: w.used_fraction.source };
      }
    }
    if (latest === undefined || latest.open <= nowMs) continue;
    const deferral: PacingDeferral = {
      subscription: view.subscription,
      window: latest.window,
      until: new Date(latest.open).toISOString(),
      source: latest.source,
    };
    const sub = settings.subscriptions.find((s) => s.name === view.subscription);
    for (const id of sub?.adapterIds ?? []) out.set(id, deferral);
  }
  return out;
}
