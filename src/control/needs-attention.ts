/**
 * Derived `needs_attention` flag (T14.2; FR-CTL-03, LLD §3.4.1 and §3.4.5). Computed on read from ledger facts only: it
 * is never written to SQLite, adds no migration and is not a run state (FRD §4 is unchanged). `get_run` and `list_runs`
 * attach it to the envelope (`src/mcp/envelope.ts`); the digest (T14.3) reuses {@link needsAttentionOf} so a run listed
 * there carries the same reason as its `get_run` envelope.
 *
 * The split is deliberate: {@link deriveNeedsAttention} is pure over {@link NeedsAttentionFacts}, and
 * {@link readNeedsAttentionFacts} is the only part that reads the ledger.
 *
 * Proposed (Delegated, T14.2):
 * - Priority when several reasons match is the LLD §3.4.5 proposed order, {@link NEEDS_ATTENTION_PRIORITY}.
 * - **T** (stall minutes) and the successor cap default to the LLD §3.4.6 Assumption values (30 and 8) until the
 *   `control_plane.loop_breaker` configuration keys exist; callers may pass other values.
 * - `failed_after_retry` matches `attempt >= cap` (the LLD says "equals"; a run past the cap is no less exhausted).
 * - `budget_exhausted` attaches to the non-terminal runs of a resolved project (a run with no `project_id` never shows
 *   it), so a terminal run never carries it.
 * - `meta_session.parked_loop` (T14.5) and `control_plane_state.budget_flags_json` (T14.4/T14.6) do not exist yet. They
 *   are read through {@link ControlPlaneFacts}; the default {@link NO_CONTROL_PLANE_FACTS} reports neither, which is the
 *   fail-closed default of the derivation spike (missing persistence infers nothing).
 * - A stall clock that cannot be evaluated (an unparseable timestamp) does not flag `stalled`.
 * - An approval lookup that hits the one-approval-per-meta-session invariant (it throws) shows `awaiting_approval`: an
 *   operator has to look at that meta-session.
 *
 * T16.6 (FR-CTL-03 as amended, FR-SKL-06, LLD §19.8; Delegated, not owner-approved): `skill_cleanup_failed` holds while
 * the run's newest `skill_removed` event reports an entry with `removal: "failed"` (that event and the `run_skill`
 * update share one transaction, `src/workspace/native-skills.ts`), in any state, terminal included, until a later
 * removal point verifies the removal. It ranks first: a Switchboard skill file left in a worktree blocks publication
 * (`SKILL_PATH_PRESENT`) and only an operator or a later removal point clears it.
 *
 * T9.14 (FR-GIT-11, FR-CTL-03, LLD §20.9, ADR-0061; Delegated, not owner-approved beyond owner decision 77):
 * `secret_scan_blocked` holds while the meta-session's newest decisive `git_push` event is a `SECRET_SCAN_BLOCKED`
 * refusal (`src/git/secret-scan.ts`, `secretScanBlockedFromPushEvents`): an accepted push of the ref clears it, a
 * refusal for another reason leaves it. Like `ci_fix_stuck`, a terminal run shows it only when it is the newest of its
 * meta-session. It ranks second: publication of the meta-session is refused until the operator allowlists the finding
 * or pushes by hand.
 *
 * `idle_timeout_work_kept` (FR-EXE-01, FR-CTL-03, LLD §3.4.5; Delegated, not owner-approved): the run ended FAILED
 * with `PROCESS_TIMEOUT` and the detail `idle timeout`, and its post-run checkpoint captured changed files (the diff
 * artifact and the rollback's evidence commit keep them). The provider went quiet without a final result, so nothing
 * was published; an operator decides whether to salvage the diff or continue. Like `parked_loop`, only the newest run
 * of its meta-session shows it: a successor supersedes it. It ranks just above `failed_after_retry`, its more specific
 * neighbour.
 */

import type Database from "better-sqlite3";
import { IDLE_TIMEOUT_DETAIL } from "../adapters/failure.js";
import { secretScanBlockedFromPushEvents } from "../git/secret-scan.js";
import type { Ledger, RunRecord, RunState } from "../ledger/index.js";
import { isTerminal } from "../lifecycle/index.js";

/** The closed reason list (FR-CTL-03, LLD §3.4.1), highest priority first (LLD §3.4.5, Proposed order). */
export const NEEDS_ATTENTION_PRIORITY = [
  "skill_cleanup_failed",
  "secret_scan_blocked",
  "budget_exhausted",
  "parked_loop",
  "ci_fix_stuck",
  "awaiting_approval",
  "stalled",
  "idle_timeout_work_kept",
  "failed_after_retry",
] as const;

export type NeedsAttentionReason = (typeof NEEDS_ATTENTION_PRIORITY)[number];

/** LLD §3.4.1 shape: `reason` is present exactly when `active` is true. */
export type NeedsAttention = { active: true; reason: NeedsAttentionReason } | { active: false };

/** LLD §3.4.6 Assumption default for **T** (`control_plane.loop_breaker.stall_minutes`). */
export const DEFAULT_STALL_MINUTES = 30;
/** LLD §3.4.6 Assumption default for `control_plane.loop_breaker.max_successors_per_meta_session`. */
export const DEFAULT_MAX_SUCCESSORS_PER_META_SESSION = 8;

/** States the LLD §3.4.5 stall rule covers, literally. */
const STALL_STATES: ReadonlySet<RunState> = new Set(["RUNNING", "LEASED"]);

/** Ledger facts about one run that the derivation reads. Everything here comes from ledger rows. */
export interface NeedsAttentionFacts {
  state: RunState;
  attempt: number;
  /** `ts` of the newest `run_event` of the run, or its `created_at` when it has none. */
  lastActivityAt: string;
  /** A `PENDING` approval exists for a run of this meta-session the caller may see. */
  pendingApproval: boolean;
  /** `meta_session.parked_loop` is set (T14.5). */
  metaSessionParked: boolean;
  /** The run is the newest of its meta-session (by `created_at`, then `id`). */
  newestInMetaSession: boolean;
  /** An admission budget refusal is active for the run's project or globally (T14.4). */
  budgetExhausted: boolean;
  /** CI fix-up cap reached on a publish ref for the run's project (T15.5). */
  ciFixStuck: boolean;
  /** T16.6: the run's newest `skill_removed` event reports a failed removal. Absent means false. */
  skillCleanupFailed?: boolean;
  /** T9.14: the meta-session's newest decisive `git_push` event is a `SECRET_SCAN_BLOCKED` refusal. Absent means false. */
  secretScanBlocked?: boolean;
  /** FR-EXE-01: FAILED on an idle timeout with changed files in its post-run checkpoint. Absent means false. */
  idleTimeoutWorkKept?: boolean;
}

export interface NeedsAttentionOptions {
  now: Date;
  stallMinutes?: number;
  maxSuccessorsPerMetaSession?: number;
}

/** Every reason whose rule matches, in priority order. */
export function matchingReasons(f: NeedsAttentionFacts, o: NeedsAttentionOptions): NeedsAttentionReason[] {
  const terminal = isTerminal(f.state);
  const matches: Record<NeedsAttentionReason, boolean> = {
    skill_cleanup_failed: f.skillCleanupFailed === true,
    secret_scan_blocked: f.secretScanBlocked === true && (!terminal || f.newestInMetaSession),
    budget_exhausted: f.budgetExhausted && !terminal,
    parked_loop: f.metaSessionParked && f.newestInMetaSession,
    ci_fix_stuck: f.ciFixStuck && (!terminal || f.newestInMetaSession),
    awaiting_approval: f.state === "AWAITING_APPROVAL" || f.pendingApproval,
    stalled: STALL_STATES.has(f.state) && isStale(f.lastActivityAt, o),
    idle_timeout_work_kept: f.state === "FAILED" && f.idleTimeoutWorkKept === true && f.newestInMetaSession,
    failed_after_retry:
      f.state === "FAILED" &&
      (f.attempt >= (o.maxSuccessorsPerMetaSession ?? DEFAULT_MAX_SUCCESSORS_PER_META_SESSION) || f.metaSessionParked),
  };
  return NEEDS_ATTENTION_PRIORITY.filter((r) => matches[r]);
}

/** The highest-priority matching reason, or `{ active: false }` when none matches. */
export function deriveNeedsAttention(f: NeedsAttentionFacts, o: NeedsAttentionOptions): NeedsAttention {
  const [reason] = matchingReasons(f, o);
  return reason === undefined ? { active: false } : { active: true, reason };
}

function isStale(lastActivityAt: string, o: NeedsAttentionOptions): boolean {
  const last = Date.parse(lastActivityAt);
  const now = o.now.getTime();
  if (!Number.isFinite(last) || !Number.isFinite(now)) return false; // fail closed: no evaluable clock, no flag
  return now - last >= (o.stallMinutes ?? DEFAULT_STALL_MINUTES) * 60_000;
}

/** Control-plane persistence that later tasks add (LLD §3.4.7). Absent persistence reports nothing. */
export interface ControlPlaneFacts {
  /** `meta_session.parked_loop` (T14.5). */
  metaSessionParked(metaSessionId: string): boolean;
  /** An active refusal in `control_plane_state.budget_flags_json` for this project id, or `'*'` for global (T14.4). */
  budgetExhausted(projectId: string): boolean;
  /** CI fix-up cap reached on a publish ref for this project (T15.5). */
  ciFixStuck?(projectId: string): boolean;
}

export const NO_CONTROL_PLANE_FACTS: ControlPlaneFacts = {
  metaSessionParked: () => false,
  budgetExhausted: () => false,
  ciFixStuck: () => false,
};

/** Gather {@link NeedsAttentionFacts} for one run from the ledger. Read-only. */
export function readNeedsAttentionFacts(
  ledger: Ledger,
  run: RunRecord,
  control: ControlPlaneFacts = NO_CONTROL_PLANE_FACTS,
): NeedsAttentionFacts {
  const newest = ledger.listRunsForMetaSession(run.meta_session_id).at(-1);
  const events = ledger.listRunEvents(run.id);
  return {
    state: run.state,
    attempt: run.attempt,
    lastActivityAt: events.at(-1)?.ts ?? run.created_at,
    pendingApproval: pendingApproval(ledger, run),
    metaSessionParked: control.metaSessionParked(run.meta_session_id),
    newestInMetaSession: newest?.id === run.id,
    budgetExhausted:
      run.project_id !== null && (control.budgetExhausted(run.project_id) || control.budgetExhausted("*")),
    ciFixStuck: run.project_id !== null && (control.ciFixStuck?.(run.project_id) ?? false),
    skillCleanupFailed: skillCleanupFailed(events),
    secretScanBlocked: secretScanBlocked(ledger, run.meta_session_id),
    idleTimeoutWorkKept: idleTimeoutWorkKept(run, events),
  };
}

/** FR-EXE-01: an idle-timeout failure whose newest post-run `checkpoint` event reports changed files. */
export function idleTimeoutWorkKept(
  run: Pick<RunRecord, "state" | "failure_code" | "failure_detail">,
  events: readonly { type: string; payload_json: string }[],
): boolean {
  if (run.state !== "FAILED" || run.failure_code !== "PROCESS_TIMEOUT" || run.failure_detail !== IDLE_TIMEOUT_DETAIL) {
    return false;
  }
  const post = events.findLast((e) => e.type === "checkpoint" && checkpointKind(e.payload_json) === "post");
  if (post === undefined) return false;
  try {
    const changed = (JSON.parse(post.payload_json) as { changed_files?: unknown }).changed_files;
    return typeof changed === "number" && changed > 0;
  } catch {
    return false;
  }
}

function checkpointKind(payload: string): unknown {
  try {
    return (JSON.parse(payload) as { kind?: unknown }).kind;
  } catch {
    return undefined;
  }
}

/** Most `git_push` events read per derivation; older ones cannot change the answer once one decides (T9.14). */
const SECRET_SCAN_EVENT_WINDOW = 100;

/** T9.14: read the meta-session's newest `git_push` events and decide with `secretScanBlockedFromPushEvents`. */
function secretScanBlocked(ledger: Ledger, metaSessionId: string): boolean {
  const payloads = ledger.listGitPushEventPayloadsForMetaSession(metaSessionId, SECRET_SCAN_EVENT_WINDOW).map((j) => {
    try {
      return JSON.parse(j) as unknown;
    } catch {
      return undefined;
    }
  });
  return secretScanBlockedFromPushEvents(payloads);
}

/** T16.6: the newest `skill_removed` event (LLD §19.11) reports an entry not `verified`, or is malformed. */
function skillCleanupFailed(events: readonly { type: string; payload_json: string }[]): boolean {
  const newest = events.findLast((e) => e.type === "skill_removed");
  if (newest === undefined) return false;
  try {
    const entries = (JSON.parse(newest.payload_json) as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return true; // a malformed removal record is not evidence of a clean worktree
    return entries.some((e) => (e as { removal?: unknown })?.removal !== "verified");
  } catch {
    return true; // an unreadable removal record is not evidence of a clean worktree (fail closed)
  }
}

/** The envelope's `needs_attention` for one run, recomputed from current ledger rows. */
export function needsAttentionOf(
  ledger: Ledger,
  run: RunRecord,
  options: NeedsAttentionOptions & { control?: ControlPlaneFacts },
): NeedsAttention {
  return deriveNeedsAttention(readNeedsAttentionFacts(ledger, run, options.control), options);
}

/** Caller scope as `get_run`: the meta-session's approval joined on this run's client (LLD §3.1 lookup). */
function pendingApproval(ledger: Ledger, run: RunRecord): boolean {
  try {
    return ledger.findApprovalForMetaSession(run.meta_session_id, run.client_id)?.status === "PENDING";
  } catch {
    return true; // invariant violation (more than one approval row): surface it rather than hide it
  }
}

/** Returns true if any publish ref for this project is currently flagged stuck under FR-QUE-05. */
export function isCiFixStuck(db: Database.Database, projectId: string): boolean {
  try {
    const row = db
      .prepare("SELECT 1 FROM ci_trigger_ref_state WHERE project_id = ? AND stuck = 1 LIMIT 1")
      .get(projectId);
    return row !== undefined;
  } catch {
    return false;
  }
}

/** Extends {@link ControlPlaneFacts} with `ciFixStuck` reading from `ci_trigger_ref_state`. */
export function ciFixControlFacts(
  db: Database.Database,
  base: ControlPlaneFacts = NO_CONTROL_PLANE_FACTS,
): ControlPlaneFacts {
  return {
    metaSessionParked: (id) => base.metaSessionParked(id),
    budgetExhausted: (id) => base.budgetExhausted(id),
    ciFixStuck: (projectId) => isCiFixStuck(db, projectId) || (base.ciFixStuck?.(projectId) ?? false),
  };
}
