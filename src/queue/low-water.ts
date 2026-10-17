/**
 * Queue low-water event detector (T15.4; FR-QUE-04, LLD §18.8, ADR-0048).
 *
 * A project may configure a low-water mark for its durable work queue (`projects.<id>.queue.low_water`, integer >= 1;
 * off by default). The admissible count is the number of items for that project in `READY`, or in `PENDING` whose
 * dependencies can still be met (none of their transitive predecessors is in `CANCELLED` or `FAILED_ADMISSION`).
 *
 * Exactly one `queue_low` sink event is emitted when the admissible count drops below the mark. The detector is re-armed
 * only when the admissible count rises to or above the mark again. The payload has only the closed ADR-0048 fields.
 * An unset mark emits nothing.
 */
import type { SinkEvent } from "../control/sinks.js";
import type { Ledger } from "../ledger/index.js";

export interface QueueLowWaterTrackerDeps {
  readonly ledger: Ledger;
  readonly getLowWaterMark: (projectId: string) => number | undefined;
  readonly emit?: (event: SinkEvent) => void;
  readonly dispatcher?: { emit: (event: SinkEvent) => void };
}

export class QueueLowWaterTracker {
  readonly #ledger: Ledger;
  readonly #getLowWaterMark: (projectId: string) => number | undefined;
  readonly #emit: ((event: SinkEvent) => void) | undefined;
  readonly #dispatcher: { emit: (event: SinkEvent) => void } | undefined;
  readonly #armed = new Map<string, boolean>();

  constructor(deps: QueueLowWaterTrackerDeps) {
    this.#ledger = deps.ledger;
    this.#getLowWaterMark = deps.getLowWaterMark;
    this.#emit = deps.emit;
    this.#dispatcher = deps.dispatcher;
  }

  isArmed(projectId: string): boolean {
    return this.#armed.get(projectId) ?? false;
  }

  /**
   * Evaluates the admissible count against the project's low-water mark.
   * If count >= mark, arms the detector.
   * If count < mark and previously armed, disarms and emits a single `queue_low` event.
   * If unset or not previously armed, emits nothing.
   */
  check(projectId: string): void {
    const mark = this.#getLowWaterMark(projectId);
    if (mark === undefined || mark < 1) return;

    const count = this.#ledger.countAdmissibleWorkItems(projectId);
    const wasArmed = this.#armed.get(projectId) ?? false;

    if (count >= mark) {
      this.#armed.set(projectId, true);
    } else if (wasArmed) {
      this.#armed.set(projectId, false);
      const event: SinkEvent = {
        projectId,
        eventKind: "queue_low",
        reasonCode: "queue_low",
        runId: null,
      };
      if (this.#emit) {
        this.#emit(event);
      } else if (this.#dispatcher) {
        this.#dispatcher.emit(event);
      }
    }
  }

  /**
   * Initializes the armed state for a project based on the current queue level without emitting an event.
   * Arms if count >= mark; leaves disarmed if count < mark until count rises to mark.
   */
  init(projectId: string): void {
    const mark = this.#getLowWaterMark(projectId);
    if (mark === undefined || mark < 1) return;
    const count = this.#ledger.countAdmissibleWorkItems(projectId);
    this.#armed.set(projectId, count >= mark);
  }
}

/**
 * Attaches a {@link QueueLowWaterTracker} to a ledger, subscribing to work queue state change notifications.
 */
export function attachQueueLowWater(deps: QueueLowWaterTrackerDeps): QueueLowWaterTracker {
  const tracker = new QueueLowWaterTracker(deps);
  deps.ledger.setQueueChangeListener((projectId) => tracker.check(projectId));
  return tracker;
}
