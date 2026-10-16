/**
 * T14.7 `steer_run` (FR-CTL-04, FR-SES-03, FRD BR-7; LLD §3.4.4). The per-process inbox of steer notes waiting for a
 * run's next boundary, and the bounded `run_event` payloads the lifecycle writes for them.
 *
 * Delivery mode (Delegated, not owner-approved): no adapter declares live input yet (the steer spike leaves Claude S1 and
 * Codex S2 unverified), so every note is delivered by boundary-resume. On the ephemeral headless transports the boundary
 * is the end of the provider's turn (its process exits with a result); the lifecycle then resumes the same native
 * session inside the same run with only the note as the prompt. The original objective is never sent again (no replay).
 *
 * Notes live in memory only: the ledger keeps their length and SHA-256, never the text (LLD §3.4.4, NFR-PRIV-02). A note
 * that cannot be delivered (the turn failed, no native session was reported, the run ended, or it is executed by no
 * executor of this process) gets a `steer_undelivered` event with the reason; it is never retried or replayed.
 */
import { createHash } from "node:crypto";

export const STEER_REQUESTED_EVENT = "steer_requested";
export const STEER_DELIVERED_EVENT = "steer_delivered";
export const STEER_UNDELIVERED_EVENT = "steer_undelivered";
/** LLD §3.4.4 `note.maxLength`. */
export const STEER_NOTE_MAX = 4096;
/** The only mode until an adapter declares live input (LLD §2 `liveInput`, not yet in the contract). */
export const STEER_DELIVERY = "boundary_resume";

export type SteerUndeliveredReason =
  /** The run already passed its last boundary (verifying, finalizing, or its last turn ended). */
  | "past_boundary"
  /** In a slot state but executed by no executor of this process (left to reconciliation, T1.9). */
  | "not_in_this_process"
  /** The turn ended in a failure or was cancelled: nothing is resumed. */
  | "turn_not_successful"
  /** The turn reported no native session id, so there is no session to continue (FR-SES-03). */
  | "no_native_session"
  /** The adapter refused to compile the resume, the environment or a pre-spawn audit refused it. */
  | "resume_refused"
  /** The run ended (for example cancelled while waiting) with notes still queued. */
  | "run_ended";

/** What `RunLifecycle.steer` decided. `accepted` means queued for the next boundary, not yet delivered. */
export interface SteerResult {
  readonly accepted: boolean;
  /** Set when not accepted: `terminal` (a no-op, nothing recorded) or the undelivered reason recorded. */
  readonly reason?: "terminal" | SteerUndeliveredReason;
}

/** The `steer_requested` payload: length and hash only, never the text. */
export function steerRequestedPayload(note: string): Record<string, unknown> {
  return {
    note_chars: note.length,
    note_sha256: createHash("sha256").update(note, "utf8").digest("hex"),
    delivery: STEER_DELIVERY,
  };
}

/** The prompt a boundary-resume turn receives: the queued notes in order, and nothing else. */
export function steerPrompt(notes: readonly string[]): string {
  return notes.join("\n\n");
}

/** Notes per run, waiting for the run's next boundary; `closed` once the run's last boundary has passed. */
export class SteerInbox {
  readonly #notes = new Map<string, string[]>();
  readonly #closed = new Set<string>();

  isClosed(runId: string): boolean {
    return this.#closed.has(runId);
  }

  push(runId: string, note: string): void {
    const list = this.#notes.get(runId);
    if (list) list.push(note);
    else this.#notes.set(runId, [note]);
  }

  pending(runId: string): number {
    return this.#notes.get(runId)?.length ?? 0;
  }

  /** Remove and return the run's queued notes (oldest first). */
  take(runId: string): string[] {
    const list = this.#notes.get(runId) ?? [];
    this.#notes.delete(runId);
    return list;
  }

  close(runId: string): void {
    this.#closed.add(runId);
  }

  /** Forget the run; returns how many notes were still queued. */
  clear(runId: string): number {
    const n = this.pending(runId);
    this.#notes.delete(runId);
    this.#closed.delete(runId);
    return n;
  }
}
