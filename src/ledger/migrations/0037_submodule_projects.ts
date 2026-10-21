/**
 * Migration 0037 (ADR-0087; FR-PRJ-11, FR-PRJ-12, FR-GIT-14, FR-GIT-15, FR-SUB-03, LLD §3.4.17): umbrella projects
 * with Git submodules, linked publication, the ordered merge and project source grants.
 *
 * - `submodule_commit`: one row per controller-made commit in a submodule repository (`kind = 'publish'`), written in
 *   the same transaction as the umbrella commit's `git_commit` row that bumps its gitlink. `repo` is the lower-case
 *   `host/owner/repo` key of the submodule's source, `paths_json` the umbrella-relative paths whose gitlinks were set
 *   to `commit_sha` (two for a repository referenced twice), `umbrella_commit_sha` the umbrella controller commit.
 * - `submodule_push`: one row per push attempt of a submodule repository by `publish_run` (accepted or not), with the
 *   umbrella publish head it belongs to. The target is the repository's own `https` origin; never a URL here.
 * - `submodule_pull_request`: one row per pull request opened (`created`) or found open and reused (`reused`) in a
 *   submodule repository, linked to the umbrella publish ref (`umbrella_ref`, a `refs/heads/...` name on the umbrella
 *   remote). `repo` is `owner/repo` as `gh` takes it.
 * - `submodule_merge`: the persisted steps of the ordered merge (ADR-0087 item 7): `submodule_merged` (a linked pull
 *   request merged, `merged_sha` its merge commit on the default branch), `submodule_refused` (closed `reason`),
 *   `gitlinks_repointed` (the umbrella commit `merged_sha` on the published umbrella tip `head_sha` that sets the
 *   gitlinks to the merged commits). The umbrella's own merge stays in `merge_event`.
 * - `project_source_request` / `project_source_decision`: an MCP client's request to add an owner to
 *   `project_sources.allowed_owners` on a host already allowed, and its one decision. An approved request widens the
 *   effective allowlist at once.
 * - `merge_event` is rebuilt (SQLite cannot alter a CHECK; the step of migration 0016, foreign keys off, rows, ids and
 *   order kept, indexes and append-only guards recreated as 0031 and 0035 left them) so `reason` also takes
 *   `no_checks_reported` (`merge_policy.checks: all_reported` and no check ran at the head).
 *
 * Every new table is append-only (triggers) and `STRICT`. Controller facts only: ids, SHAs, closed codes, source keys
 * and umbrella-relative paths; never a title, body, credential or `gh` text. Immutable once released: the checksum of
 * this text is recorded in `schema_migrations`.
 */
export const sql = `
CREATE TABLE submodule_commit (
  id                  TEXT PRIMARY KEY CHECK (id LIKE 'smc\\_%' ESCAPE '\\'),
  run_id              TEXT NOT NULL REFERENCES run(id),
  meta_session_id     TEXT NOT NULL REFERENCES meta_session(id),
  kind                TEXT NOT NULL CHECK (kind IN ('publish')),
  repo                TEXT NOT NULL,
  paths_json          TEXT NOT NULL,
  parent_sha          TEXT NOT NULL,
  commit_sha          TEXT NOT NULL,
  umbrella_commit_sha TEXT NOT NULL,
  created_at          TEXT NOT NULL
) STRICT;

CREATE INDEX submodule_commit_session ON submodule_commit (meta_session_id, repo, created_at);
CREATE INDEX submodule_commit_sha ON submodule_commit (meta_session_id, commit_sha);

CREATE TRIGGER submodule_commit_no_update BEFORE UPDATE ON submodule_commit
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER submodule_commit_no_delete BEFORE DELETE ON submodule_commit
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TABLE submodule_push (
  id                TEXT PRIMARY KEY CHECK (id LIKE 'smp\\_%' ESCAPE '\\'),
  run_id            TEXT NOT NULL REFERENCES run(id),
  meta_session_id   TEXT NOT NULL REFERENCES meta_session(id),
  project_id        TEXT NOT NULL,
  repo              TEXT NOT NULL,
  paths_json        TEXT NOT NULL,
  ref               TEXT NOT NULL CHECK (ref LIKE 'refs/heads/%'),
  head_sha          TEXT NOT NULL,
  umbrella_head_sha TEXT NOT NULL,
  outcome           TEXT NOT NULL CHECK (outcome IN ('ACCEPTED','REFUSED_POLICY','REJECTED_REMOTE','ERROR')),
  reason            TEXT NOT NULL,
  requested_by      TEXT NOT NULL CHECK (requested_by = 'operator' OR requested_by GLOB 'mcp_client:?*'),
  created_at        TEXT NOT NULL
) STRICT;

CREATE INDEX submodule_push_session ON submodule_push (meta_session_id, repo, created_at);
CREATE INDEX submodule_push_run ON submodule_push (run_id, created_at);

CREATE TRIGGER submodule_push_no_update BEFORE UPDATE ON submodule_push
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER submodule_push_no_delete BEFORE DELETE ON submodule_push
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TABLE submodule_pull_request (
  id              TEXT PRIMARY KEY CHECK (id LIKE 'spr\\_%' ESCAPE '\\'),
  run_id          TEXT NOT NULL REFERENCES run(id),
  meta_session_id TEXT NOT NULL REFERENCES meta_session(id),
  push_id         TEXT NOT NULL REFERENCES submodule_push(id),
  client_id       TEXT NOT NULL,
  repo            TEXT NOT NULL,
  number          INTEGER NOT NULL CHECK (number > 0),
  url             TEXT NOT NULL CHECK (url LIKE 'https://github.com/%'),
  branch          TEXT NOT NULL,
  base_ref        TEXT NOT NULL,
  head_sha        TEXT NOT NULL,
  umbrella_ref    TEXT NOT NULL CHECK (umbrella_ref LIKE 'refs/heads/%'),
  draft           INTEGER NOT NULL CHECK (draft IN (0, 1)),
  action          TEXT NOT NULL CHECK (action IN ('created', 'reused')),
  created_at      TEXT NOT NULL
) STRICT;

CREATE INDEX submodule_pull_request_run ON submodule_pull_request (run_id, created_at);
CREATE INDEX submodule_pull_request_session ON submodule_pull_request (meta_session_id, created_at);

CREATE TRIGGER submodule_pull_request_no_update BEFORE UPDATE ON submodule_pull_request
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER submodule_pull_request_no_delete BEFORE DELETE ON submodule_pull_request
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TABLE submodule_merge (
  id              TEXT PRIMARY KEY CHECK (id LIKE 'smm\\_%' ESCAPE '\\'),
  run_id          TEXT NOT NULL REFERENCES run(id),
  meta_session_id TEXT NOT NULL REFERENCES meta_session(id),
  project_id      TEXT NOT NULL,
  umbrella_ref    TEXT NOT NULL CHECK (umbrella_ref LIKE 'refs/heads/%'),
  step            TEXT NOT NULL CHECK (step IN ('submodule_merged', 'submodule_refused', 'gitlinks_repointed')),
  repo            TEXT,
  pr_number       INTEGER,
  head_sha        TEXT NOT NULL,
  merged_sha      TEXT,
  reason          TEXT,
  created_at      TEXT NOT NULL,
  CHECK ((step = 'submodule_refused') = (reason IS NOT NULL)),
  CHECK ((step = 'submodule_refused') OR merged_sha IS NOT NULL),
  CHECK ((step = 'gitlinks_repointed') OR (repo IS NOT NULL AND pr_number IS NOT NULL))
) STRICT;

CREATE INDEX submodule_merge_ref ON submodule_merge (project_id, umbrella_ref, created_at);
CREATE INDEX submodule_merge_run ON submodule_merge (run_id, created_at);
CREATE UNIQUE INDEX submodule_merge_refusal_once ON submodule_merge (umbrella_ref, repo, head_sha, reason)
  WHERE step = 'submodule_refused';

CREATE TRIGGER submodule_merge_no_update BEFORE UPDATE ON submodule_merge
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER submodule_merge_no_delete BEFORE DELETE ON submodule_merge
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TABLE project_source_request (
  id           TEXT PRIMARY KEY CHECK (id LIKE 'psr\\_%' ESCAPE '\\'),
  client_id    TEXT NOT NULL,
  host         TEXT NOT NULL,
  owner        TEXT NOT NULL,
  requested_at TEXT NOT NULL
) STRICT;

CREATE INDEX project_source_request_owner ON project_source_request (host, owner);

CREATE TRIGGER project_source_request_no_update BEFORE UPDATE ON project_source_request
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER project_source_request_no_delete BEFORE DELETE ON project_source_request
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TABLE project_source_decision (
  id          TEXT PRIMARY KEY CHECK (id LIKE 'psd\\_%' ESCAPE '\\'),
  request_id  TEXT NOT NULL UNIQUE REFERENCES project_source_request(id),
  decision    TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  decided_by  TEXT NOT NULL,
  decided_at  TEXT NOT NULL
) STRICT;

CREATE TRIGGER project_source_decision_no_update BEFORE UPDATE ON project_source_decision
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER project_source_decision_no_delete BEFORE DELETE ON project_source_decision
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TABLE merge_event_new (
  id           TEXT PRIMARY KEY CHECK (id LIKE 'mge\\_%' ESCAPE '\\'),
  project_id   TEXT NOT NULL,
  publish_ref  TEXT NOT NULL,
  pr_number    INTEGER,
  head_sha     TEXT NOT NULL,
  method       TEXT NOT NULL CHECK (method IN ('squash', 'merge', 'rebase')),
  outcome      TEXT NOT NULL CHECK (outcome IN ('attempted', 'merged', 'refused')),
  reason       TEXT CHECK (reason IN ('head_moved', 'check_failed', 'check_pending', 'no_required_checks',
                 'not_mergeable', 'unverified_at_head', 'report_missing', 'draft', 'policy_off', 'gh_error',
                 'base_mismatch', 'no_checks_reported')),
  run_id       TEXT,
  created_at   TEXT NOT NULL,
  head_kind    TEXT CHECK (head_kind IN ('published', 'base_merge')),
  pr_head_sha  TEXT CHECK ((head_kind IS NULL) = (pr_head_sha IS NULL)),
  CHECK ((outcome = 'refused') = (reason IS NOT NULL))
) STRICT;

INSERT INTO merge_event_new (id, project_id, publish_ref, pr_number, head_sha, method, outcome, reason, run_id,
  created_at, head_kind, pr_head_sha)
SELECT id, project_id, publish_ref, pr_number, head_sha, method, outcome, reason, run_id, created_at, head_kind,
  pr_head_sha
FROM merge_event ORDER BY rowid;

DROP TABLE merge_event;
ALTER TABLE merge_event_new RENAME TO merge_event;

CREATE INDEX merge_event_ref ON merge_event (project_id, publish_ref, created_at);
CREATE UNIQUE INDEX merge_event_refusal_once ON merge_event (project_id, publish_ref, head_sha, ifnull(pr_head_sha, ''),
  reason) WHERE outcome = 'refused';

CREATE TRIGGER merge_event_no_update BEFORE UPDATE ON merge_event
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER merge_event_no_delete BEFORE DELETE ON merge_event
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`;
