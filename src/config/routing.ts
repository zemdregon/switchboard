/**
 * `routing` configuration (M7, T7.1; LLD §17.1, ADR-0044). The JSON schema in `schema.ts` checks types and ranges; this
 * module resolves defaults. Every default is an Assumption with no source behind it (Q-80).
 */
import { DEFAULT_WEIGHTS, SCORE_TERMS, type Weights } from "../routing/score.js";
import type { RoutingConfigInput } from "./schema.js";

/** Resolved `routing` section; every key set. */
export interface RoutingSettings {
  weights: Weights;
}

export function resolveRouting(input: RoutingConfigInput | undefined): RoutingSettings {
  const weights = Object.fromEntries(SCORE_TERMS.map((t) => [t, input?.weights?.[t] ?? DEFAULT_WEIGHTS[t]])) as Weights;
  return { weights };
}
