/**
 * Migration 0036 (ADR-0078; FR-GIT-13, LLD §3.4.16): the audit of MCP `close_pr`.
 *
 * `pull_request_close` holds one append-only row per `close_pr` call, allowed or denied: the calling client, the
 * project and pull request number it named (NULL when the arguments did not carry them), the replacement number,
 * whether branch deletion was asked, the outcome (`closed`, `already_closed`, `refused`, `failed`) and a closed reason code.
 * When the call matched a `pull_request` row that `publish_run` created, the row, its run and its `owner/repo` are
 * recorded too. Controller facts only (ids, numbers, codes); never a comment, title, body or any other `gh` text.
 *
 * Immutable once released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = String.raw`
CREATE TABLE pull_request_close (
  id                 TEXT PRIMARY KEY CHECK (id LIKE 'prc\_%' ESCAPE '\'),
  client_id          TEXT NOT NULL,
  project_id         TEXT,
  number             INTEGER CHECK (number IS NULL OR number > 0),
  replacement_number INTEGER CHECK (replacement_number IS NULL OR replacement_number > 0),
  delete_branch      INTEGER NOT NULL CHECK (delete_branch IN (0, 1)),
  pull_request_id    TEXT REFERENCES pull_request(id),
  run_id             TEXT REFERENCES run(id),
  repo               TEXT,
  outcome            TEXT NOT NULL CHECK (outcome IN ('closed', 'already_closed', 'refused', 'failed')),
  reason             TEXT,
  created_at         TEXT NOT NULL
) STRICT;

CREATE INDEX pull_request_close_project ON pull_request_close (project_id, created_at);

CREATE TRIGGER pull_request_close_no_update BEFORE UPDATE ON pull_request_close
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER pull_request_close_no_delete BEFORE DELETE ON pull_request_close
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`;
