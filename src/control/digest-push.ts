/**
 * Scheduled digest push (T14.16; FR-CTL-14, FR-CTL-02, FR-CTL-10, LLD §20.5, ADR-0048 item 3 as amended).
 *
 * Off by default: `serve` builds a {@link DigestPushSchedule} only when the operator sets
 * `control_plane.digest_schedule` and at least one notification sink exists. On each scheduler tick (injected clock),
 * when the cron expression matches the current UTC minute and that minute has not fired yet, one `digest` sink event is
 * emitted with project id `*`, reason code `digest`, no run id, and the integer-only {@link DigestCounts} that
 * {@link collectDigestCounts} reads from the ledger. The payload builder (`sinks.ts`) refuses a `counts` object with a
 * missing, extra or non-integer key, so a digest never carries an objective, summary, decision text or any string.
 *
 * Delegated (T14.16, recorded in LLD §20.5):
 * - The `digest` schedule is operator configuration in the §18.5 cron syntax, not a `project_schedule` row: a sink is
 *   an operator-chosen egress path (ADR-0048 item 1), so a chat client cannot create or widen one, and no migration is
 *   needed.
 * - One aggregate event (`project_id` `*`) per fire, not one per project, so a fire costs one delivery against each
 *   sink's rate limit. The per-run detail stays on `get_digest`.
 * - Counts: runs of every state (all time); needs-attention reasons over the non-terminal runs (a terminal run's
 *   historic flag would grow without bound) plus `stalled_progress` per configured project; work items of every state;
 *   `PENDING` approvals; configured projects whose admission is paused (own or global pause).
 * - Dedup is per process (the last fired minute in memory). A restart inside the minute it fired can send that minute
 *   once more; that is a duplicate summary, never lost or extra data.
 */
import type { ResolvedProject } from "../config/projects.js";
import { type Ledger, WORK_ITEM_STATES } from "../ledger/index.js";
import { isTerminal, RUN_STATES } from "../lifecycle/states.js";
import { cronMatches, formatMinuteAnchor, type ParsedCron } from "../schedule/cron.js";
import { budgetControlFacts } from "./budgets.js";
import { loopBreakerControlFacts } from "./loop-attention.js";
import { type ControlPlaneFacts, needsAttentionOf } from "./needs-attention.js";
import { isAdmissionPaused } from "./pause.js";
import { progressStallOf, STALLED_PROGRESS } from "./progress-stall.js";
import { ALL_PROJECTS_ID, DIGEST_ATTENTION_REASONS, type DigestCounts, type SinkEvent } from "./sinks.js";

export interface DigestCountsOptions {
  readonly now: Date;
  /** Configured projects: their pause flags and `queue.stall_hours` windows. */
  readonly projects: readonly Pick<ResolvedProject, "id" | "queue">[];
  /** Default: the facts `get_digest` reads (budgets, loop-breaker parks). */
  readonly control?: ControlPlaneFacts;
}

const zeros = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** The integer-only counts of one digest push, read from current ledger rows. Read-only. */
export function collectDigestCounts(ledger: Ledger, options: DigestCountsOptions): DigestCounts {
  const control = options.control ?? loopBreakerControlFacts(ledger, budgetControlFacts(ledger));
  const runsByState = zeros(RUN_STATES);
  for (const state of RUN_STATES) runsByState[state] = ledger.countRunsInStates([state]);
  const attention = zeros(DIGEST_ATTENTION_REASONS);
  for (const state of RUN_STATES.filter((s) => !isTerminal(s))) {
    for (const run of ledger.listRunsInState(state)) {
      const flag = needsAttentionOf(ledger, run, { now: options.now, control });
      if (flag.active) attention[flag.reason] += 1;
    }
  }
  for (const project of options.projects) {
    const stall = progressStallOf(ledger, project.id, { now: options.now, stallHours: project.queue?.stallHours });
    if (stall.active) attention[STALLED_PROGRESS] += 1;
  }
  const queueByState = zeros(WORK_ITEM_STATES);
  for (const [state, n] of Object.entries(ledger.countWorkItemsByState())) {
    if (state in queueByState) queueByState[state as keyof typeof queueByState] = n;
  }
  return {
    runs_by_state: runsByState,
    needs_attention_by_reason: attention,
    queue_by_state: queueByState,
    pending_approvals: ledger.listApprovals({ status: "PENDING" }).length,
    paused_projects: options.projects.filter((p) => isAdmissionPaused(ledger, p.id)).length,
  };
}

export interface DigestPushScheduleDeps {
  readonly cron: ParsedCron;
  /** Usually `SinkDispatcher.emit`: synchronous, never throws. */
  readonly emit: (event: SinkEvent) => void;
  readonly counts: (now: Date) => DigestCounts;
}

/** Fires one `digest` sink event per matching UTC minute (see the module comment). */
export class DigestPushSchedule {
  readonly #deps: DigestPushScheduleDeps;
  #lastMinute: string | undefined;

  constructor(deps: DigestPushScheduleDeps) {
    this.#deps = deps;
  }

  /** Returns true when this tick emitted a digest. */
  tick(now: Date): boolean {
    if (!cronMatches(this.#deps.cron, now)) return false;
    const minute = formatMinuteAnchor(now);
    if (minute === this.#lastMinute) return false;
    this.#lastMinute = minute;
    this.#deps.emit({
      projectId: ALL_PROJECTS_ID,
      eventKind: "digest",
      reasonCode: "digest",
      runId: null,
      counts: this.#deps.counts(now),
    });
    return true;
  }
}

/** `serve`'s wiring: a schedule only when the operator set the cron and a sink exists; otherwise undefined (off). */
export function digestPushFor(deps: {
  readonly cron: ParsedCron | undefined;
  readonly sinks: { emit(event: SinkEvent): void } | undefined;
  readonly counts: (now: Date) => DigestCounts;
}): DigestPushSchedule | undefined {
  const { cron, sinks } = deps;
  if (cron === undefined || sinks === undefined) return undefined;
  return new DigestPushSchedule({ cron, emit: (e) => sinks.emit(e), counts: deps.counts });
}
