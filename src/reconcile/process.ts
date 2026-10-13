/**
 * Orphan provider process groups at startup (FR-EXE-06, LLD §8). The previous controller started each provider in its
 * own process group (`pgid = pid`) and recorded `pid`, `pgid` and the leader's start time before reading output, so a
 * live orphan can be told apart from a reused PID. The start time comes from the platform port (LLD §8.2,
 * `src/exec/proc-info.ts`): `/proc` on Linux, BSD `ps` on macOS (Unverified until T4.10), nothing elsewhere.
 *
 * Proposed identity rules:
 * - leader present and its start time equals the recorded one → our orphan: terminate the group;
 * - leader present with a different start time → the PID was reused by an unrelated process: never signal;
 * - leader present but no start time was recorded → identity cannot be proven: never signal (fail safe, reported);
 * - leader's presence cannot be determined (no process-table mechanism, `ps` failed or printed something unparseable)
 *   while the group answers `kill(-pgid, 0)` → identity cannot be proven: never signal (fail closed, reported);
 * - leader gone but the group still has live members → our orphan. A new process ID never matches an active process
 *   group ID (POSIX `fork()`), so a live group with that ID can only be the recorded one.
 */

import { DEFAULT_KILL_GRACE_MS, groupAlive, hostProcInfo, type ProcInfo } from "../exec/index.js";

export type OrphanStatus =
  | { readonly kind: "none" }
  | { readonly kind: "alive"; readonly pgid: number; readonly leaderAlive: boolean }
  | { readonly kind: "pid_reused"; readonly pgid: number; readonly recordedTicks: number; readonly actualTicks: number }
  | { readonly kind: "unverifiable"; readonly pgid: number };

export interface ProcessRecord {
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly proc_start_ticks: number | null;
}

/** Classify the process group recorded on a run. `info` is injectable for tests; it defaults to the host's. */
export function inspectOrphan(run: ProcessRecord, info: ProcInfo = hostProcInfo): OrphanStatus {
  const pgid = run.pgid;
  if (pgid === null || pgid <= 1) return { kind: "none" };
  const leader = run.pid ?? pgid;
  const probe = info.startTime(leader);
  if (probe.kind === "present") {
    const ticks = probe.start;
    if (run.proc_start_ticks === null) return { kind: "unverifiable", pgid };
    if (ticks !== run.proc_start_ticks) {
      return { kind: "pid_reused", pgid, recordedTicks: run.proc_start_ticks, actualTicks: ticks };
    }
    // A zombie leader still matches; the group counts as alive only if a live member remains.
    return groupAlive(pgid, info) ? { kind: "alive", pgid, leaderAlive: true } : { kind: "none" };
  }
  if (probe.kind === "unknown") return groupAlive(pgid, info) ? { kind: "unverifiable", pgid } : { kind: "none" };
  return groupAlive(pgid, info) ? { kind: "alive", pgid, leaderAlive: false } : { kind: "none" };
}

export interface TerminateResult {
  /** SIGKILL was needed after the grace period. */
  readonly escalated: boolean;
  /** The group had no live member when we stopped waiting. */
  readonly groupEmpty: boolean;
}

/** Upper bound on waiting for the group to vanish after SIGKILL (Proposed; mirrors the supervisor). */
const POST_KILL_WAIT_MS = 5_000;
const POLL_MS = 20;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: already gone.
  }
}

/** The supervisor's cancel sequence (LLD §8): SIGTERM to the group, grace, SIGKILL, confirm the group is empty. */
export async function terminateGroup(pgid: number, killGraceMs = DEFAULT_KILL_GRACE_MS): Promise<TerminateResult> {
  signalGroup(pgid, "SIGTERM");
  const graceEnd = Date.now() + killGraceMs;
  while (groupAlive(pgid) && Date.now() < graceEnd) await sleep(POLL_MS);
  let escalated = false;
  if (groupAlive(pgid)) {
    escalated = true;
    signalGroup(pgid, "SIGKILL");
    const end = Date.now() + POST_KILL_WAIT_MS;
    while (groupAlive(pgid) && Date.now() < end) await sleep(POLL_MS);
  }
  return { escalated, groupEmpty: !groupAlive(pgid) };
}
