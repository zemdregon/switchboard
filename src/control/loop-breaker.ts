/**
 * Loop breaker, stall settings and successor cap (T14.5; FR-CTL-07, FR-CAP-05, FR-MCP-10, LLD §3.4.5 to §3.4.7).
 *
 * - **Parking.** When the same failure fingerprint (the run's `failure_code`, or the argv of the first verification
 *   command that did not pass) occurs on **N** `FAILED` runs of one meta-session, the lifecycle records one
 *   {@link LOOP_PARKED_EVENT} `run_event` on the Nth failing run, in the transaction of its terminal transition. That
 *   append-only event is the meta-session's `parked_loop` flag: no migration and no run state (FRD §4 is unchanged).
 * - **Successor admission.** {@link successorRefusal} is consulted before every automatic successor (LLD §16.5 retry,
 *   §16.6 quota wait and failover); {@link parkedRefusal} before any new run in an existing meta-session. A parked
 *   meta-session admits nothing; a chain whose next run would pass `max_successors_per_meta_session` is refused.
 * - **Stall.** **T** is only read on the read path (`src/control/loop-attention.ts`); nothing here cancels a run.
 *
 * This module imports nothing from `src/lifecycle` so the lifecycle can call it without an import cycle.
 *
 * Proposed (Delegated, T14.5):
 * - The parked flag is the {@link LOOP_PARKED_EVENT} row rather than the LLD §3.4.7 `meta_session.parked_loop` column,
 *   which would need a migration (T14.5 forbids one; T14.6 may add the column and backfill it from these events).
 * - The verification fingerprint is a SHA-256 prefix of the failing command's argv as frozen in `request_json` (stable
 *   and controller-owned, never agent text or command output). The verification name of FR-CTL-07 is that command.
 * - The cap counts `attempt`, which starts at 1 on the first run (LLD §16.5): a successor is refused when its `attempt`
 *   would exceed the cap. This matches `failed_after_retry` (`attempt >= cap`) in `needs-attention.ts`.
 * - No automatic unpark in M14; a new task (a new meta-session) is unaffected.
 */

import { createHash } from "node:crypto";
import type { Ledger, RunEventRow, RunRecord } from "../ledger/index.js";

/** `run_event` type on the Nth identical failure; its presence in a meta-session is the `parked_loop` flag. */
export const LOOP_PARKED_EVENT = "loop_breaker_parked";

/** Resolved `control_plane.loop_breaker` (LLD §3.4.6). */
export interface LoopBreakerSettings {
  /** **N**: identical failures in one meta-session that park it (≥ 2). */
  identicalFailureThreshold: number;
  /** **T**: minutes without a `run_event` before a `RUNNING`/`LEASED` run is flagged `stalled` (≥ 1). */
  stallMinutes: number;
  /** Highest `attempt` a run of one meta-session may have (≥ 1). */
  maxSuccessorsPerMetaSession: number;
}

/**
 * LLD §3.4.6 Assumption defaults (operator tuning, not provider facts). `stallMinutes` and the cap equal
 * `DEFAULT_STALL_MINUTES` and `DEFAULT_MAX_SUCCESSORS_PER_META_SESSION` of `needs-attention.ts` (a test pins that);
 * they are repeated here so the lifecycle does not import the read-path module.
 */
export const DEFAULT_LOOP_BREAKER: Readonly<LoopBreakerSettings> = Object.freeze({
  identicalFailureThreshold: 3,
  stallMinutes: 30,
  maxSuccessorsPerMetaSession: 8,
});

/** Payload of {@link LOOP_PARKED_EVENT}: bounded, no free text. */
export interface LoopParkedPayload {
  meta_session_id: string;
  threshold: number;
  fingerprint: string;
  run_ids: string[];
}

export type SuccessorRefusal =
  | { reason: "meta_session_parked"; fingerprint: string; threshold: number }
  | { reason: "successor_cap"; attempt: number; max_successors_per_meta_session: number };

const VERIFICATION_EVENT = "verification_command"; // VERIFICATION_COMMAND_EVENT (src/lifecycle/verification.ts)
const NOT_FAILING = new Set(["passed", "not_run"]);

/** The fingerprints one `FAILED` run contributes: `code:<failure_code>` and, if any, `verification:<argv hash>`. */
export function failureFingerprints(run: RunRecord, events: readonly RunEventRow[]): string[] {
  if (run.state !== "FAILED") return [];
  const out = run.failure_code ? [`code:${run.failure_code}`] : [];
  const failing = events
    .filter((e) => e.type === VERIFICATION_EVENT)
    .map((e) => parse(e.payload_json))
    .find((p) => typeof p.outcome === "string" && !NOT_FAILING.has(p.outcome) && Number.isInteger(p.index));
  if (failing !== undefined) {
    const argv = (parse(run.request_json).verification_commands as unknown[] | undefined)?.[failing.index as number];
    if (Array.isArray(argv)) {
      out.push(`verification:${createHash("sha256").update(JSON.stringify(argv)).digest("hex").slice(0, 16)}`);
    }
  }
  return out;
}

/** The {@link LOOP_PARKED_EVENT} of the meta-session, if it is parked. */
export function parkedEvent(ledger: Ledger, metaSessionId: string): LoopParkedPayload | undefined {
  for (const run of ledger.listRunsForMetaSession(metaSessionId)) {
    const row = ledger.listRunEvents(run.id).find((e) => e.type === LOOP_PARKED_EVENT);
    if (row !== undefined) return parse(row.payload_json) as unknown as LoopParkedPayload;
  }
  return undefined;
}

export function isMetaSessionParked(ledger: Ledger, metaSessionId: string): boolean {
  return parkedEvent(ledger, metaSessionId) !== undefined;
}

/**
 * Call in the transaction that moved `failed` to `FAILED`. Parks the meta-session (one {@link LOOP_PARKED_EVENT} on
 * `failed`) when this failure makes some fingerprint reach **N**; returns the payload when it did.
 */
export function recordLoopPark(
  ledger: Ledger,
  failed: RunRecord,
  settings: LoopBreakerSettings = DEFAULT_LOOP_BREAKER,
): LoopParkedPayload | undefined {
  if (failed.state !== "FAILED" || isMetaSessionParked(ledger, failed.meta_session_id)) return undefined;
  const mine = new Set(failureFingerprints(failed, ledger.listRunEvents(failed.id)));
  if (mine.size === 0) return undefined;
  const seen = new Map<string, string[]>();
  for (const run of ledger.listRunsForMetaSession(failed.meta_session_id)) {
    for (const fp of failureFingerprints(run, ledger.listRunEvents(run.id))) {
      if (mine.has(fp)) seen.set(fp, [...(seen.get(fp) ?? []), run.id]);
    }
  }
  for (const [fingerprint, runIds] of seen) {
    if (runIds.length < settings.identicalFailureThreshold) continue;
    const payload: LoopParkedPayload = {
      meta_session_id: failed.meta_session_id,
      threshold: settings.identicalFailureThreshold,
      fingerprint,
      run_ids: runIds,
    };
    ledger.appendRunEvent({ runId: failed.id, type: LOOP_PARKED_EVENT, payload: { ...payload } });
    return payload;
  }
  return undefined;
}

/** Why no new run may join this meta-session, or undefined. */
export function parkedRefusal(ledger: Ledger, metaSessionId: string): SuccessorRefusal | undefined {
  const parked = parkedEvent(ledger, metaSessionId);
  return parked === undefined
    ? undefined
    : { reason: "meta_session_parked", fingerprint: parked.fingerprint, threshold: parked.threshold };
}

/** Why `failed` may get no automatic successor (LLD §16.5, §16.6), or undefined when one may be admitted. */
export function successorRefusal(
  ledger: Ledger,
  failed: RunRecord,
  settings: LoopBreakerSettings = DEFAULT_LOOP_BREAKER,
): SuccessorRefusal | undefined {
  const parked = parkedRefusal(ledger, failed.meta_session_id);
  if (parked !== undefined) return parked;
  if (failed.attempt + 1 > settings.maxSuccessorsPerMetaSession) {
    return {
      reason: "successor_cap",
      attempt: failed.attempt,
      max_successors_per_meta_session: settings.maxSuccessorsPerMetaSession,
    };
  }
  return undefined;
}

function parse(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
