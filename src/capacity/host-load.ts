import { loadavg } from "node:os";

/**
 * Host load hold (T3.24; FR-CAP-12, NFR-PERF-03, LLD §20.2). The reader is a port so tests inject a value and
 * production reads `os.loadavg()`. Like the free-disk floor (FR-WS-11, BR-51) the hold is a pacing gate: above
 * `host.max_load1` new runs stay in `QUEUED`, never failed or refused, until the load falls below `host.resume_load1`.
 * Running runs are never signalled.
 */

/** Reads the 1-minute load average. Synchronous on purpose: the lifecycle asks inside its dispatch transaction. */
export interface LoadReader {
  /** The 1-minute load average. Throws when it cannot be read. */
  load1(): number;
}

/** The production reader: `os.loadavg()[0]` (Linux and macOS; Node.js returns zeros where the OS has none). */
export const osLoadReader: LoadReader = {
  load1(): number {
    return loadavg()[0] as number;
  },
};

/** The lifecycle's view of `host.max_load1` and `host.resume_load1` (`resumeLoad1 < maxLoad1`, checked by `load.ts`). */
export interface HostLoadGate {
  readonly maxLoad1: number;
  readonly resumeLoad1: number;
  readonly reader: LoadReader;
  /** Re-read period while runs are held; default {@link DEFAULT_LOAD_RECHECK_MS}. */
  readonly recheckMs?: number;
}

/** How often a load hold re-reads the load average (Assumption, Delegated: the 1-minute average moves slowly). */
export const DEFAULT_LOAD_RECHECK_MS = 15_000;

/** `run_event` recorded once per run and hold episode (payload: `load1`, `max`, `resume`). */
export const LOAD_HOLD_EVENT = "load_hold";
/** `run_event` recorded on a still-queued held run when its hold episode ends (payload: `load1`, or null if unreadable). */
export const LOAD_RELEASE_EVENT = "load_release";
/** `run_event` recorded at admission on a run whose `light: true` was honoured (the client sets `allow_light`). */
export const LIGHT_RUN_EVENT = "light_run";
/** The hold reason shown on `get_run`, `list_runs` and `get_digest` (FR-CAP-12). */
export const HELD_LOAD_REASON = "held_load";

/** The load average, or null when the reader throws or returns something that is not a load (never holds). */
export function readLoad1(reader: LoadReader): number | null {
  let value: number;
  try {
    value = reader.load1();
  } catch {
    return null;
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Hysteresis: a hold starts when the load is above the maximum and lasts until it is below the resume value, so a
 * load between the two keeps whatever the previous pass decided. An unreadable load never holds (as FR-WS-11's
 * unassessable floor) and so also ends a hold.
 */
export function nextLoadHeld(
  held: boolean,
  load1: number | null,
  gate: Pick<HostLoadGate, "maxLoad1" | "resumeLoad1">,
) {
  if (load1 === null) return false;
  return held ? load1 >= gate.resumeLoad1 : load1 > gate.maxLoad1;
}
