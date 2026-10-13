/**
 * Per-backend circuit breaker (T11.2; FR-INN-08, LLD §13.4 step 6). In memory, starts `closed` at process start
 * (Assumption stated in the LLD; `doctor` re-probes). Only transport-level results move it: a validator or sanitiser
 * rejection is a quality outcome and never reaches this class.
 *
 * - `closed` to `open` after `failureThreshold` consecutive transport failures (across all tasks on the backend);
 * - `open` to `half_open` once `openMs` has passed; exactly one call at a time is let through as the probe, the others
 *   are denied as if `open`;
 * - `half_open` to `closed` on a transport success, to `open` (timer restarted) on a failure.
 */
export type BreakerState = "closed" | "open" | "half_open";
export type BreakerAdmission = "allow" | "probe" | "deny";
/** `degraded`: the breaker just opened from `closed`. `recovered`: a probe succeeded. Written once per transition. */
export type BreakerTransition = "degraded" | "recovered";

export interface BreakerOptions {
  failureThreshold: number;
  openMs: number;
  /** Injectable clock, milliseconds. */
  now?: () => number;
}

export class CircuitBreaker {
  private current: BreakerState = "closed";
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  private readonly now: () => number;

  constructor(private readonly options: BreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  get state(): BreakerState {
    return this.current;
  }

  /** Decide whether a call may go to the backend. A `probe` admission must be settled by success, failure or abandon. */
  admit(): BreakerAdmission {
    if (this.current === "closed") return "allow";
    if (this.current === "open") {
      if (this.now() - this.openedAt < this.options.openMs) return "deny";
      this.current = "half_open";
    }
    if (this.probing) return "deny";
    this.probing = true;
    return "probe";
  }

  success(admission: BreakerAdmission): BreakerTransition | undefined {
    if (admission === "probe") this.probing = false;
    this.failures = 0;
    if (this.current === "half_open") {
      this.current = "closed";
      return "recovered";
    }
    return undefined;
  }

  failure(admission: BreakerAdmission): BreakerTransition | undefined {
    if (admission === "probe") this.probing = false;
    if (this.current === "half_open") {
      this.open();
      return undefined; // still degraded: no new transition
    }
    this.failures++;
    if (this.current === "closed" && this.failures >= this.options.failureThreshold) {
      this.open();
      return "degraded";
    }
    return undefined;
  }

  /** A probe admission that ended without a transport result (an internal error): free the probe slot. */
  abandon(admission: BreakerAdmission): void {
    if (admission === "probe") this.probing = false;
  }

  private open(): void {
    this.current = "open";
    this.openedAt = this.now();
    this.failures = 0;
  }
}
