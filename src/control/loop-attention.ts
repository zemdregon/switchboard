/**
 * Read-path inputs of the loop breaker (T14.5; FR-CTL-03, FR-CTL-07, LLD §3.4.5, §3.4.6). Feeds the T14.2 derivation in
 * `needs-attention.ts` (reused as is): the `parked_loop` fact from the {@link LOOP_PARKED_EVENT} rows, and **T** and the
 * successor cap from `control_plane.loop_breaker`. {@link findStalledRuns} is the stall evaluator: it only reads, so a
 * stalled run is flagged and never cancelled, signalled or moved to another state.
 */

import type { Ledger, RunRecord } from "../ledger/index.js";
import { DEFAULT_LOOP_BREAKER, isMetaSessionParked, type LoopBreakerSettings } from "./loop-breaker.js";
import {
  type ControlPlaneFacts,
  matchingReasons,
  type NeedsAttentionOptions,
  NO_CONTROL_PLANE_FACTS,
  readNeedsAttentionFacts,
} from "./needs-attention.js";

/** {@link ControlPlaneFacts} whose `metaSessionParked` reads the loop breaker's park events; other facts from `base`. */
export function loopBreakerControlFacts(
  ledger: Ledger,
  base: ControlPlaneFacts = NO_CONTROL_PLANE_FACTS,
): ControlPlaneFacts {
  return {
    metaSessionParked: (id) => isMetaSessionParked(ledger, id) || base.metaSessionParked(id),
    budgetExhausted: (id) => base.budgetExhausted(id),
  };
}

/** Derivation options for `needsAttentionOf` / `buildEnvelope` at `now` under the operator's loop-breaker settings. */
export function loopBreakerAttention(
  ledger: Ledger,
  now: Date,
  settings: LoopBreakerSettings = DEFAULT_LOOP_BREAKER,
  base?: ControlPlaneFacts,
): NeedsAttentionOptions & { control: ControlPlaneFacts } {
  return {
    now,
    stallMinutes: settings.stallMinutes,
    maxSuccessorsPerMetaSession: settings.maxSuccessorsPerMetaSession,
    control: loopBreakerControlFacts(ledger, base),
  };
}

/** `RUNNING` and `LEASED` runs with no `run_event` for **T** minutes at `now`. Read-only. */
export function findStalledRuns(
  ledger: Ledger,
  now: Date,
  settings: LoopBreakerSettings = DEFAULT_LOOP_BREAKER,
): RunRecord[] {
  const options = loopBreakerAttention(ledger, now, settings);
  return [...ledger.listRunsInState("LEASED"), ...ledger.listRunsInState("RUNNING")].filter((run) =>
    matchingReasons(readNeedsAttentionFacts(ledger, run, options.control), options).includes("stalled"),
  );
}
