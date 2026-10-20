/**
 * Migration 0033 (ADR-0069; LLD §12.6, §3.4.12): MCP `publish_run` publication records.
 *
 * - `git_push.requested_by` gains `mcp_client:<client id>`: a controller push an MCP client asked for with
 *   `publish_run` (the same `GitPusher` and rules as `switchboard git push`). SQLite cannot alter a CHECK, so the table
 *   is rebuilt with the step of migration 0016 (LLD §1), applied with foreign keys off and a `foreign_key_check` before
 *   commit (`Migration.foreignKeysOff`); rows, ids and order are kept, and the 0003 index and append-only guards are
 *   recreated as they were. The client id part is the configuration's own id pattern, checked by the controller; the
 *   CHECK (`GLOB`, case-sensitive) only requires the exact prefix and a non-empty suffix.
 * - `pull_request`: one append-only row per pull request `publish_run` opened (`action = 'created'`) or found open and
 *   reused (`'reused'`) for a pushed branch: the run, its meta-session, the `git_push` row it follows, the `owner/repo`,
 *   number, URL, head branch, base branch, head SHA, draft flag and the requesting client. Controller facts only (ids,
 *   SHAs, names, a URL `gh` printed after it was matched against the expected `https://github.com/<owner>/<repo>/pull/<n>`
 *   shape); never a title, body or any other `gh` text.
 *
 * Immutable once released: the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE git_push_new (
  id            TEXT PRIMARY KEY,
  run_id        TEXT REFERENCES run(id),
  project_id    TEXT NOT NULL,
  context_id    TEXT NOT NULL,
  remote        TEXT NOT NULL,
  ref           TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('ACCEPTED','REFUSED_POLICY','REJECTED_REMOTE','ERROR')),
  detail        TEXT,
  requested_by  TEXT NOT NULL CHECK (requested_by IN ('agent_tool','operator')
                  OR requested_by GLOB 'mcp_client:?*'),
  created_at    TEXT NOT NULL
) STRICT;

INSERT INTO git_push_new (id, run_id, project_id, context_id, remote, ref, head_sha, outcome, detail, requested_by,
  created_at)
SELECT id, run_id, project_id, context_id, remote, ref, head_sha, outcome, detail, requested_by, created_at
FROM git_push ORDER BY rowid;

DROP TABLE git_push;
ALTER TABLE git_push_new RENAME TO git_push;

CREATE INDEX git_push_run ON git_push(run_id);

CREATE TRIGGER git_push_no_update BEFORE UPDATE ON git_push
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER git_push_no_delete BEFORE DELETE ON git_push
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TABLE pull_request (
  id              TEXT PRIMARY KEY CHECK (id LIKE 'prq\\_%' ESCAPE '\\'),
  run_id          TEXT NOT NULL REFERENCES run(id),
  meta_session_id TEXT NOT NULL REFERENCES meta_session(id),
  push_id         TEXT NOT NULL REFERENCES git_push(id),
  client_id       TEXT NOT NULL,
  repo            TEXT NOT NULL,
  number          INTEGER NOT NULL CHECK (number > 0),
  url             TEXT NOT NULL CHECK (url LIKE 'https://github.com/%'),
  branch          TEXT NOT NULL,
  base_ref        TEXT NOT NULL,
  head_sha        TEXT NOT NULL,
  draft           INTEGER NOT NULL CHECK (draft IN (0, 1)),
  action          TEXT NOT NULL CHECK (action IN ('created', 'reused')),
  created_at      TEXT NOT NULL
) STRICT;

CREATE INDEX pull_request_run ON pull_request (run_id, created_at);
CREATE INDEX pull_request_session ON pull_request (meta_session_id, created_at);

CREATE TRIGGER pull_request_no_update BEFORE UPDATE ON pull_request
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER pull_request_no_delete BEFORE DELETE ON pull_request
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`;
