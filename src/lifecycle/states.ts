/**
 * Canonical run state machine, transcribed from FRD §4.2 (the FRD owns states and edges; this file only encodes them).
 * `milestone` says when the edge first becomes reachable; T1.8 drives the M1 edges. T20 (controller restart) is handled
 * by startup reconciliation (T1.9, WF-8) and is not an edge of its own here: its outcomes reuse the edges below.
 */
import type { RunState } from "../ledger/index.js";

export const RUN_STATES: readonly RunState[] = [
  "AWAITING_APPROVAL",
  "QUEUED",
  "WAITING_CAPACITY",
  "PREFLIGHT",
  "LEASED",
  "RUNNING",
  "VERIFYING",
  "FINALIZING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
];

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

/** States that hold a global concurrency slot (reserved at T4, released at a terminal state or T7). Proposed. */
export const SLOT_STATES: readonly RunState[] = ["PREFLIGHT", "LEASED", "RUNNING", "VERIFYING", "FINALIZING"];

/** States counted against the bounded ingress queue (FR-CAP-04). Proposed: runs waiting for dispatch. */
export const QUEUE_STATES: readonly RunState[] = ["QUEUED", "WAITING_CAPACITY"];

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

export interface TransitionRule {
  /** FRD §4.2 row id. */
  readonly id: string;
  readonly from: RunState;
  readonly to: RunState;
  readonly event: string;
  readonly milestone: "M1" | "M3" | "M6";
}

const rule = (id: string, from: RunState, to: RunState, event: string, milestone: TransitionRule["milestone"]) =>
  ({ id, from, to, event, milestone }) as const;

/** T19 (cancel) expands to one direct edge per non-terminal state without a process or workspace (FRD §4.3). */
export const TRANSITIONS: readonly TransitionRule[] = [
  rule("T3", "AWAITING_APPROVAL", "QUEUED", "operator approve", "M3"),
  rule("T19", "AWAITING_APPROVAL", "CANCELLED", "cancel_run or operator deny", "M1"),
  rule("T4", "QUEUED", "PREFLIGHT", "dispatcher picks run", "M1"),
  rule("T19", "QUEUED", "CANCELLED", "cancel_run", "M1"),
  rule("T18", "WAITING_CAPACITY", "QUEUED", "reset_at reached", "M6"),
  rule("T19", "WAITING_CAPACITY", "CANCELLED", "cancel_run", "M6"),
  rule("T5", "PREFLIGHT", "LEASED", "preflight passes", "M1"),
  rule("T6", "PREFLIGHT", "QUEUED", "provider became ineligible, another eligible", "M6"),
  rule("T7", "PREFLIGHT", "WAITING_CAPACITY", "quota known exhausted, reset within horizon", "M6"),
  rule("T8", "PREFLIGHT", "FAILED", "no usable provider", "M1"),
  rule("T19", "PREFLIGHT", "CANCELLED", "cancel_run", "M1"),
  rule("T9", "LEASED", "RUNNING", "process group spawned", "M1"),
  rule("T10", "LEASED", "FAILED", "compile or spawn error", "M1"),
  rule("T19", "LEASED", "CANCELLED", "cancel_run", "M1"),
  rule("T11", "RUNNING", "VERIFYING", "exit ok, verification supplied", "M3"),
  rule("T12", "RUNNING", "FINALIZING", "exit ok, no verification", "M1"),
  rule("T13", "RUNNING", "FINALIZING", "failure, timeout, crash or cancel", "M1"),
  rule("T14", "VERIFYING", "FINALIZING", "verification done, failed or cancelled", "M3"),
  rule("T15", "FINALIZING", "SUCCEEDED", "pending success", "M1"),
  rule("T16", "FINALIZING", "FAILED", "pending failure", "M1"),
  rule("T17", "FINALIZING", "CANCELLED", "pending cancelled", "M1"),
];

/** Entry states for a new run (FRD T1, T2). */
export const INITIAL_STATES: readonly RunState[] = ["QUEUED", "AWAITING_APPROVAL"];

export class IllegalTransitionError extends Error {
  override readonly name = "IllegalTransitionError";
  constructor(
    readonly from: RunState,
    readonly to: RunState,
  ) {
    super(`illegal run transition ${from} -> ${to}`);
  }
}

/** The FRD rule for `from -> to`, or undefined when no such edge exists. */
export function findTransition(from: RunState, to: RunState): TransitionRule | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

/** Guard: returns the rule or throws {@link IllegalTransitionError}. Terminal states are never left. */
export function assertTransition(from: RunState, to: RunState): TransitionRule {
  const t = findTransition(from, to);
  if (!t) throw new IllegalTransitionError(from, to);
  return t;
}
