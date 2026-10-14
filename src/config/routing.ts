/**
 * `routing` configuration (M7, T7.1 and T7.4; LLD §17.1, ADR-0044). The JSON schema in `schema.ts` checks types and
 * ranges; this module adds the one cross-field rule (the two estimate thresholds are set together or not at all) and
 * resolves defaults. Every default is an Assumption with no source behind it (Q-80, Q-81).
 */
import { DEFAULT_WEIGHTS, SCORE_TERMS, type Weights } from "../routing/score.js";
import type { RoutingConfigInput } from "./schema.js";

/** Resolved `routing.affinity` (LLD §3.2): the estimate trigger is on only when both thresholds are set. */
export interface AffinitySettings {
  enabled: boolean;
  lowWaterMark: number | null;
  minConfidence: number | null;
}

/** Resolved `routing` section; every key set. */
export interface RoutingSettings {
  weights: Weights;
  affinity: AffinitySettings;
}

export function resolveRouting(input: RoutingConfigInput | undefined): RoutingSettings {
  const weights = Object.fromEntries(SCORE_TERMS.map((t) => [t, input?.weights?.[t] ?? DEFAULT_WEIGHTS[t]])) as Weights;
  return {
    weights,
    affinity: {
      enabled: input?.affinity?.enabled ?? true,
      lowWaterMark: input?.affinity?.low_water_mark ?? null,
      minConfidence: input?.affinity?.min_confidence ?? null,
    },
  };
}

/** Cross-field checks the JSON schema cannot express; one message per problem, JSON-path prefixed. */
export function checkRouting(input: RoutingConfigInput | undefined): string[] {
  const a = input?.affinity;
  const low = a?.low_water_mark ?? null;
  const conf = a?.min_confidence ?? null;
  return (low === null) !== (conf === null)
    ? ["$.routing.affinity: low_water_mark and min_confidence must be set together (LLD §3.2), or both left null"]
    : [];
}
