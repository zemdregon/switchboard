/**
 * Migration 0025 (T8.14; FR-OPS-06, LLD §20.13 "Evaluation"): own-repository evaluation results.
 *
 * `eval_result`: one append-only row per graded suite task and provider. `pass` is 1 exactly when the hidden test
 * command exited 0 in the network-off grader container; `wall_clock_ms` is the replayed run's admission-to-terminal
 * time; `usage_json` is the run's provider-reported usage metrics (a JSON array, empty when the provider reported none).
 * `run_id` names the normal run the task was replayed as; `grade_error` names why a task was not graded (the run did not
 * succeed, the grader was refused or the hidden tests were found in the agent's worktree), never test output.
 *
 * Immutable once released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE eval_result (
  id             TEXT PRIMARY KEY,
  suite          TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  provider       TEXT NOT NULL,
  run_id         TEXT,
  run_state      TEXT,
  pass           INTEGER NOT NULL CHECK (pass IN (0, 1)),
  test_exit_code INTEGER,
  grade_error    TEXT,
  wall_clock_ms  INTEGER NOT NULL CHECK (wall_clock_ms >= 0),
  usage_json     TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL,
  CHECK (pass = 0 OR test_exit_code = 0)
) STRICT;

CREATE INDEX eval_result_suite ON eval_result (suite, provider, created_at);
`;
