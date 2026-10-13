/**
 * Migration 0008 (T11.6; FR-INN-09, LLD §13.3, ADR-0016, ADR-0005): `inner_task_state`, the mutable current suspension
 * state of each inner-agent task, one row per task. Unlike the append-only `inner_call` (migration 0005) this table is
 * updated in place: a task is suspended when its rejection rate over the configured window exceeds the configured
 * threshold, and stays suspended until the operator re-enables it. The state lives in the ledger so it survives a restart.
 *
 * - `suspended_basis_json` holds the window evidence of the suspension (window, rejected, total, threshold): counts only,
 *   never a prompt or response body (FR-INN-16).
 * - `resumed_at` is the instant of the last re-enable; quality counting restarts after it (LLD §13.4 step 11).
 * - `version` counts state changes (suspend or resume), for the compare-and-swap style callers of T11.7.
 *
 * Additive and forward-only; no existing table changes. A row exists only once a task has been suspended. A released
 * migration is immutable (ADR-0005): the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE inner_task_state (
  task            TEXT PRIMARY KEY CHECK (task IN ('commit_message','pr_draft','route_features','handoff_condense',
                    'log_summary','run_title')),
  suspended       INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)),
  suspended_at    TEXT,
  suspended_basis_json TEXT CHECK (suspended_basis_json IS NULL OR json_valid(suspended_basis_json)),
  resumed_at      TEXT,
  version         INTEGER NOT NULL DEFAULT 0
) STRICT;
`;
