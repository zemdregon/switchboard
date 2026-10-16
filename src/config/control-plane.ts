/**
 * `control_plane` configuration (M14; LLD §3.4.6). The JSON schema in `schema.ts` checks types and ranges; this module
 * resolves defaults. T14.5 resolves `loop_breaker`; the defaults are LLD Assumptions (operator tuning, not provider
 * facts; ADR-0007).
 */
import { DEFAULT_LOOP_BREAKER, type LoopBreakerSettings } from "../control/loop-breaker.js";
import type { ControlPlaneConfigInput } from "./schema.js";

/** Resolved `control_plane` section; every key set. */
export interface ControlPlaneSettings {
  loopBreaker: LoopBreakerSettings;
}

export function resolveControlPlane(input: ControlPlaneConfigInput | undefined): ControlPlaneSettings {
  const lb = input?.loop_breaker;
  return {
    loopBreaker: {
      identicalFailureThreshold: lb?.identical_failure_threshold ?? DEFAULT_LOOP_BREAKER.identicalFailureThreshold,
      stallMinutes: lb?.stall_minutes ?? DEFAULT_LOOP_BREAKER.stallMinutes,
      maxSuccessorsPerMetaSession:
        lb?.max_successors_per_meta_session ?? DEFAULT_LOOP_BREAKER.maxSuccessorsPerMetaSession,
    },
  };
}
