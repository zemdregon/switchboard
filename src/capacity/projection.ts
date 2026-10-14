/**
 * The one capacity projection behind `get_capacity`, `switchboard capacity` and `doctor` (M6; FR-MCP-02, FR-OPS-05,
 * FR-CAP-03, LLD §16.3, ADR-0043 item 6). Deterministic: the same ledger, providers, settings and clock give
 * byte-identical canonical JSON.
 */
import type { Ledger } from "../ledger/index.js";
import { canonicalJson } from "../lifecycle/request.js";
import { type CapacityProviderInfo, collectCapacityInputs } from "./collect.js";
import { type EstimatorSettings, estimateCapacity, type ProviderCapacity } from "./estimate.js";

/** Printed with every projection (FR-CAP-03). */
export const CAPACITY_NOTE =
  "capacity_score, confidence and throttle_risk are controller estimates, not provider-authoritative quota";

export interface CapacityProjection {
  as_of: string;
  window_seconds: number;
  note: string;
  providers: ProviderCapacity[];
}

/** Providers are listed in the order given (the caller passes registry order). */
export function capacityProjection(
  ledger: Ledger,
  providers: readonly CapacityProviderInfo[],
  settings: EstimatorSettings,
  now: Date,
): CapacityProjection {
  return {
    as_of: now.toISOString(),
    window_seconds: settings.windowSeconds,
    note: CAPACITY_NOTE,
    providers: providers.map((p) =>
      estimateCapacity(collectCapacityInputs(ledger, p, settings.windowSeconds, now), settings, now),
    ),
  };
}

/** Canonical JSON of a projection (sorted keys, LLD §10), for byte comparisons and `--json`. */
export function capacityJson(projection: CapacityProjection): string {
  return canonicalJson(projection);
}
