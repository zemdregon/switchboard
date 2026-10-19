/**
 * Project progress stall (T14.16; FR-CTL-14, FR-CTL-03 as noted, LLD §20.5). Derived on read from work-queue rows only:
 * nothing is written, no migration is added and no run state or run transition changes.
 *
 * A project is `stalled_progress` when the operator set `projects.<id>.queue.stall_hours` (off when unset), it has
 * `READY` work items, and no item reached `DONE` within the window. The next `DONE` clears it, because the window
 * restarts there.
 *
 * Delegated (T14.16, recorded in LLD §20.5): the window starts at the later of the newest `DONE` item's `terminal_at`
 * and the oldest `READY` item's `created_at`. The `READY` side reads `created_at`, not the time the item last became
 * `READY`: an item that cycles `READY` → `ADMITTING` → `READY` on admission retries has made no progress, so it must not
 * restart the window. A timestamp that cannot be parsed raises nothing (no evaluable clock, no flag), as the run-level
 * `stalled` rule does (`needs-attention.ts`).
 */
import type { Ledger, ProgressStallFacts } from "../ledger/index.js";

/** The project-level needs-attention reason (FR-CTL-14). Not a run-level reason: it carries no run. */
export const STALLED_PROGRESS = "stalled_progress";

/** Project-level shape, as the run-level `needs_attention` (LLD §3.4.1): `reason` present exactly when active. */
export type ProjectNeedsAttention = { active: true; reason: typeof STALLED_PROGRESS } | { active: false };

const HOUR_MS = 3_600_000;

/** Pure: `stalled_progress` for one project's facts, with `stallHours` unset meaning off. */
export function deriveProgressStall(
  facts: ProgressStallFacts,
  options: { now: Date; stallHours: number | undefined },
): ProjectNeedsAttention {
  const { stallHours } = options;
  if (stallHours === undefined || facts.readyCount === 0 || facts.oldestReadyCreatedAt === null)
    return { active: false };
  const firstReady = Date.parse(facts.oldestReadyCreatedAt);
  const lastDone = facts.lastDoneAt === null ? Number.NEGATIVE_INFINITY : Date.parse(facts.lastDoneAt);
  const now = options.now.getTime();
  if (!Number.isFinite(firstReady) || Number.isNaN(lastDone) || !Number.isFinite(now)) return { active: false };
  return now - Math.max(firstReady, lastDone) >= stallHours * HOUR_MS
    ? { active: true, reason: STALLED_PROGRESS }
    : { active: false };
}

/** `stalled_progress` for one project, read from current ledger rows. */
export function progressStallOf(
  ledger: Ledger,
  projectId: string,
  options: { now: Date; stallHours: number | undefined },
): ProjectNeedsAttention {
  if (options.stallHours === undefined) return { active: false }; // off: no query
  return deriveProgressStall(ledger.readProgressStallFacts(projectId), options);
}
