/**
 * `control_plane` configuration (M14; LLD §3.4.6). The JSON schema in `schema.ts` checks types and ranges; this module
 * resolves defaults. T14.4 resolves `budgets` (every unset cap unlimited, never a provider limit); T14.5 resolves
 * `loop_breaker`, whose defaults are LLD Assumptions (operator tuning, not provider facts; ADR-0007). T14.16 resolves
 * `digest_schedule` (FR-CTL-14, LLD §20.5): absent means off; a cron expression outside the §18.5 syntax aborts startup.
 */
import { DEFAULT_LOOP_BREAKER, type LoopBreakerSettings } from "../control/loop-breaker.js";
import { InvalidCronError, type ParsedCron, validateCronExpr } from "../schedule/cron.js";
import { type BudgetSettings, resolveBudgets } from "./budgets.js";
import type { ControlPlaneConfigInput } from "./schema.js";

/** Resolved `control_plane` section; every key set. */
export interface ControlPlaneSettings {
  budgets: BudgetSettings;
  loopBreaker: LoopBreakerSettings;
  /** T14.16: the digest push schedule, or undefined when off. */
  digestSchedule?: { cron: ParsedCron };
}

/** Semantic checks beyond the schema (T14.16): the digest schedule's cron expression parses. */
export function checkControlPlane(input: ControlPlaneConfigInput | undefined): string[] {
  const cron = input?.digest_schedule?.cron;
  if (cron === undefined) return [];
  try {
    validateCronExpr(cron);
    return [];
  } catch (err) {
    const why = err instanceof InvalidCronError ? err.message : "not a valid cron expression";
    return [`$.control_plane.digest_schedule.cron: ${why}`];
  }
}

export function resolveControlPlane(input: ControlPlaneConfigInput | undefined): ControlPlaneSettings {
  const lb = input?.loop_breaker;
  return {
    budgets: resolveBudgets(input?.budgets),
    loopBreaker: {
      identicalFailureThreshold: lb?.identical_failure_threshold ?? DEFAULT_LOOP_BREAKER.identicalFailureThreshold,
      stallMinutes: lb?.stall_minutes ?? DEFAULT_LOOP_BREAKER.stallMinutes,
      maxSuccessorsPerMetaSession:
        lb?.max_successors_per_meta_session ?? DEFAULT_LOOP_BREAKER.maxSuccessorsPerMetaSession,
    },
    ...(input?.digest_schedule !== undefined
      ? { digestSchedule: { cron: validateCronExpr(input.digest_schedule.cron) } }
      : {}),
  };
}
