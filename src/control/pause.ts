/**
 * Project and global pause (T14.6; FR-CTL-05, FR-OPS-01, FR-SES-06, LLD §3.4.4, §3.4.7). A pause is control-plane
 * state, not a run state (FRD §4 is unchanged): it holds admission and nothing else. Runs already admitted finish as
 * they would have; `needs_attention` (T14.2) has no pause reason; the digest (T14.3) shows `paused` per project.
 *
 * Two surfaces write the flag (spike `project-pause-resume-spike-2026-10-15.md`):
 * - MCP `pause_project` / `resume_project` (`src/mcp/server.ts`) for one project the caller may use, recorded as
 *   `mcp:<client_id>` on the project's `control_plane_state` row.
 * - The operator CLI `switchboard pause` / `switchboard resume` (`src/cli/pause.ts`) for every project at once: the
 *   `'*'` row. The CLI records an append-only {@link OPERATOR_PAUSE_REQUESTED} / {@link OPERATOR_RESUME_REQUESTED}
 *   signal in `control_plane_event`; the `serve` daemon applies it on its operator poll ({@link applyPauseRequests}),
 *   or the CLI applies it itself when it holds the data-directory lock (no daemon). This is the "same pattern as
 *   `approve`" the LLD asks for, with the dedicated table it offers as the alternative to a synthetic run record.
 *
 * Proposed (Delegated, T14.6):
 * - {@link admissionPause} is `row(project).paused OR row('*').paused`; missing rows mean not paused. A run without a
 *   project (workspace-path run) is held by the global pause only: the operator's pause means "no new runs", and such a
 *   run belongs to no project a client could pause.
 * - The lifecycle refuses with `LifecycleError` code `PAUSED` and {@link pauseRefusalDetails}; the MCP layer maps it to
 *   `ELIGIBILITY_NONE` with `details.reason` `PROJECT_PAUSED` or `GLOBAL_PAUSED` (`src/mcp/errors.ts`), as `QUEUE_FULL`
 *   and the T14.4 budget refusal are, and the project work queue keeps the item `READY` (LLD §18.4 step 4).
 * - A retry or quota-ladder successor is a new admission and is refused while its project (or everything) is paused;
 *   the refusal is recorded as `retry_not_scheduled` / `quota_ladder` with reason `paused` (spike: "successors after
 *   terminal: refused while paused"). The failed run stays FAILED; the operator or client starts a new run after resume.
 * - Repeated pause or resume is idempotent: the row is rewritten with the newer actor and time, no error.
 */

import type { Ledger, PendingPauseRequest } from "../ledger/index.js";
import {
  GLOBAL_PAUSE_SCOPE,
  OPERATOR_PAUSE_APPLIED,
  OPERATOR_PAUSE_REQUESTED,
  OPERATOR_RESUME_REQUESTED,
} from "../ledger/index.js";

export { GLOBAL_PAUSE_SCOPE };

/** Why admission is held: the project's own flag, or the operator's global flag. */
export type PauseScope = "project" | "global";

export interface PauseRefusal {
  readonly scope: PauseScope;
  /** The paused project, or `'*'` for the global pause. */
  readonly project_id: string;
  readonly paused_by: string | null;
  readonly paused_at: string | null;
}

/** The pause holding admission of a run in `projectId` (undefined = no project), or undefined when none holds. */
export function admissionPause(ledger: Ledger, projectId: string | undefined): PauseRefusal | undefined {
  if (projectId !== undefined) {
    const row = ledger.getControlPlaneState(projectId);
    if (row?.paused === 1)
      return { scope: "project", project_id: projectId, paused_by: row.paused_by, paused_at: row.paused_at };
  }
  const global = ledger.getControlPlaneState(GLOBAL_PAUSE_SCOPE);
  if (global?.paused === 1) {
    return {
      scope: "global",
      project_id: GLOBAL_PAUSE_SCOPE,
      paused_by: global.paused_by,
      paused_at: global.paused_at,
    };
  }
  return undefined;
}

/** `row(project).paused OR row('*').paused`, as the digest reports it (LLD §3.4.3 `paused`). */
export function isAdmissionPaused(ledger: Ledger, projectId: string): boolean {
  return admissionPause(ledger, projectId) !== undefined;
}

export function pauseRefusalMessage(r: PauseRefusal): string {
  return r.scope === "project"
    ? `project ${r.project_id} is paused; no run is admitted until resume_project`
    : "all projects are paused by the operator; no run is admitted until switchboard resume";
}

/** Closed, controller-generated facts for the MCP error envelope (`details`). */
export function pauseRefusalDetails(r: PauseRefusal): Record<string, unknown> {
  return {
    reason: r.scope === "project" ? "PROJECT_PAUSED" : "GLOBAL_PAUSED",
    ...(r.scope === "project" ? { project_id: r.project_id } : {}),
  };
}

// ---- operator CLI: global pause and resume -----------------------------------------------------------------------

export type PauseRequestOutcome =
  /** Applied by the CLI itself (no daemon held the data directory). */
  | "applied"
  /** Recorded for the serve daemon to apply on its operator poll. */
  | "requested";

export interface PauseRequestResult {
  readonly outcome: PauseRequestOutcome;
  /** The flag the `'*'` row holds after this command (unchanged until the daemon applies a `requested` one). */
  readonly paused: boolean;
  readonly requestEventId: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
}

/**
 * Record an operator `pause` (`paused: true`) or `resume` (`paused: false`) for every project. With `direct` (the
 * caller holds the data-directory lock, so no daemon exists) the `'*'` row is updated in the same transaction and the
 * request is marked applied by `cli_direct`; otherwise only the request is written and the daemon applies it.
 */
export function requestGlobalPause(
  ledger: Ledger,
  opts: { paused: boolean; requestedBy: string; direct: boolean },
): PauseRequestResult {
  return ledger.immediate(() => {
    const event = ledger.appendControlPlaneEvent({
      type: opts.paused ? OPERATOR_PAUSE_REQUESTED : OPERATOR_RESUME_REQUESTED,
      scope: GLOBAL_PAUSE_SCOPE,
      payload: { requested_by: opts.requestedBy, reason: "operator_cli" },
    });
    const base = { requestEventId: event.id, requestedBy: opts.requestedBy, requestedAt: event.ts };
    if (!opts.direct) {
      return { ...base, outcome: "requested", paused: ledger.getControlPlaneState(GLOBAL_PAUSE_SCOPE)?.paused === 1 };
    }
    applyPauseRequest(
      ledger,
      { requestEventId: event.id, scope: GLOBAL_PAUSE_SCOPE, paused: opts.paused, ...base },
      "cli_direct",
    );
    return { ...base, outcome: "applied", paused: opts.paused };
  });
}

export interface AppliedPause {
  readonly requestEventId: string;
  readonly scope: string;
  readonly paused: boolean;
  readonly requestedBy: string;
}

/**
 * Daemon side (the `serve` operator poll): apply every pending operator pause or resume, oldest first, and mark each
 * applied. Safe to call repeatedly; each request is applied once. Also run at startup, before admission opens, so a
 * pause recorded while no daemon ran holds from the first request on.
 */
export function applyPauseRequests(ledger: Ledger): AppliedPause[] {
  return ledger.immediate(() =>
    ledger.listPendingPauseRequests().map((req) => {
      applyPauseRequest(ledger, req, "serve");
      return { requestEventId: req.requestEventId, scope: req.scope, paused: req.paused, requestedBy: req.requestedBy };
    }),
  );
}

function applyPauseRequest(ledger: Ledger, req: PendingPauseRequest, appliedBy: "serve" | "cli_direct"): void {
  ledger.setPaused({ projectId: req.scope, paused: req.paused, by: req.requestedBy });
  ledger.appendControlPlaneEvent({
    type: OPERATOR_PAUSE_APPLIED,
    scope: req.scope,
    payload: { request_event_id: req.requestEventId, paused: req.paused, applied_by: appliedBy },
  });
}
