/**
 * Migration 0001: all tables of LLD §1 (the M1 baseline; later-milestone tables are created empty so the schema has one
 * owner). The DDL is copied from LLD §1, which owns it. Triggers implement the append-only rules of LLD §1
 * (FR-SES-05, FR-TEL-01). Proposed: trigger names `<table>_no_update` / `<table>_no_delete`, and `approval` is
 * update-once with no deletes.
 *
 * Immutable once released: the checksum of this text is recorded in `schema_migrations`; change the schema with a new
 * numbered migration instead.
 */
export const sql = String.raw`
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,            -- sha256 of migration file; mismatch aborts startup
  applied_at  TEXT NOT NULL
) STRICT;

CREATE TABLE meta_session (
  id              TEXT PRIMARY KEY CHECK (id LIKE 'sess\_%' ESCAPE '\'),
  objective       TEXT NOT NULL,
  constraints_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(constraints_json)),
  repo_root       TEXT,                 -- canonical path; NULL for non-Git read-only inspect (FR-WS-06)
  base_commit     TEXT,                 -- first base checkpoint commit
  head_commit     TEXT,                 -- latest post-run checkpoint commit
  open_work_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(open_work_json)),
  status          TEXT NOT NULL CHECK (status IN ('ACTIVE','ARCHIVED')),
  lease_run_id    TEXT,                 -- write lease holder, see section 5
  lease_expires_at TEXT,
  version         INTEGER NOT NULL DEFAULT 0,   -- optimistic concurrency
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

CREATE TABLE provider_binding (          -- provider-native sessions (ADR-0001)
  id               TEXT PRIMARY KEY,
  meta_session_id  TEXT NOT NULL REFERENCES meta_session(id),
  provider         TEXT NOT NULL,       -- adapter id
  harness          TEXT NOT NULL,       -- equals provider unless fronted (FR-ADP-10)
  backing_provider TEXT,                -- actual backing vendor, when reported
  model            TEXT,
  native_session_id TEXT NOT NULL,      -- taken from structured output only (FR-ADP-04)
  created_at       TEXT NOT NULL,
  last_used_at     TEXT NOT NULL,
  UNIQUE (meta_session_id, provider, native_session_id)
) STRICT;

CREATE TABLE adapter_version (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  binary_path     TEXT NOT NULL,
  binary_version  TEXT NOT NULL,
  manifest_hash   TEXT,                 -- sha256 of compliance manifest in force
  probe_json      TEXT NOT NULL CHECK (json_valid(probe_json)),  -- steps of FR-ADP-02, no credentials
  status          TEXT NOT NULL CHECK (status IN ('VALIDATED','UNVERIFIED','DISABLED')),
  first_seen_at   TEXT NOT NULL,
  validated_at    TEXT,
  validated_by    TEXT,                 -- OS user name of operator
  UNIQUE (provider, binary_version, manifest_hash)
) STRICT;

CREATE TABLE run (
  id              TEXT PRIMARY KEY CHECK (id LIKE 'run\_%' ESCAPE '\'),
  meta_session_id TEXT NOT NULL REFERENCES meta_session(id),
  parent_run_id   TEXT REFERENCES run(id),          -- previous attempt or continued run
  attempt         INTEGER NOT NULL DEFAULT 1,
  state           TEXT NOT NULL CHECK (state IN ('AWAITING_APPROVAL','QUEUED','WAITING_CAPACITY',
                    'PREFLIGHT','LEASED','RUNNING','VERIFYING','FINALIZING',
                    'SUCCEEDED','FAILED','CANCELLED')),   -- states owned by FRD
  failure_code    TEXT,                              -- one code from section 4; NOT NULL iff FAILED
  failure_detail  TEXT,                              -- short, redacted
  provider        TEXT,                              -- NULL until routed
  adapter_version_id TEXT REFERENCES adapter_version(id),
  model           TEXT,
  trust_profile   TEXT NOT NULL CHECK (trust_profile IN ('inspect-untrusted','edit-untrusted',
                    'test-sandboxed','trusted-development','privileged')),
  policy_snapshot_json TEXT NOT NULL CHECK (json_valid(policy_snapshot_json)),
  request_json    TEXT NOT NULL CHECK (json_valid(request_json)),  -- validated request, excludes secrets
  request_hash    TEXT NOT NULL,
  client_id       TEXT NOT NULL,                     -- configured MCP client (FR-MCP-06)
  idempotency_key TEXT,
  priority        INTEGER NOT NULL DEFAULT 1,
  worktree_path   TEXT,
  branch          TEXT,
  base_checkpoint_id TEXT,                           -- -> workspace_checkpoint(id)
  post_checkpoint_id TEXT,
  pid             INTEGER,
  pgid            INTEGER,
  proc_start_ticks INTEGER,                          -- guards against PID reuse at reconciliation
  exit_code       INTEGER,
  exit_signal     TEXT,
  next_attempt_at TEXT,                              -- retry / WAITING_CAPACITY wake time
  version         INTEGER NOT NULL DEFAULT 0,        -- optimistic transition guard
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  updated_at      TEXT NOT NULL,
  CHECK ((state = 'FAILED') = (failure_code IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX run_idem ON run(client_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX run_state ON run(state, priority DESC, created_at);
CREATE INDEX run_session ON run(meta_session_id, created_at);

CREATE TABLE run_event (                -- append-only (FR-TEL-01, FR-SES-05)
  id          TEXT PRIMARY KEY CHECK (id LIKE 'evt\_%' ESCAPE '\'),
  run_id      TEXT NOT NULL REFERENCES run(id),
  seq         INTEGER NOT NULL,         -- per-run, gapless, starts at 1
  ts          TEXT NOT NULL,
  type        TEXT NOT NULL,            -- 'state_transition','provider_event','policy','lease', ...
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),  -- bounded, no raw output
  artifact_id TEXT REFERENCES artifact(id),
  UNIQUE (run_id, seq)
) STRICT;

CREATE TABLE decision (                 -- append-only
  id              TEXT PRIMARY KEY,
  meta_session_id TEXT NOT NULL REFERENCES meta_session(id),
  run_id          TEXT REFERENCES run(id),
  decision        TEXT NOT NULL,
  reason_summary  TEXT NOT NULL,        -- observable rationale, not provider reasoning (NFR-PRIV-02)
  created_at      TEXT NOT NULL
) STRICT;

CREATE TABLE artifact (                 -- content-addressed files under <data_dir>/artifacts/ab/cd/<sha256>
  id          TEXT PRIMARY KEY CHECK (id LIKE 'art\_%' ESCAPE '\'),
  run_id      TEXT REFERENCES run(id),
  meta_session_id TEXT REFERENCES meta_session(id),
  kind        TEXT NOT NULL CHECK (kind IN ('provider_stdout','provider_stderr','diff','test_report',
                'changed_files','log_summary','handoff_view')),
  sha256      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  media_type  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  deleted_at  TEXT                      -- set by retention GC (NFR-DATA-01)
) STRICT;
CREATE INDEX artifact_run ON artifact(run_id, kind);

CREATE TABLE workspace_checkpoint (     -- append-only
  id              TEXT PRIMARY KEY,
  meta_session_id TEXT NOT NULL REFERENCES meta_session(id),
  run_id          TEXT REFERENCES run(id),
  kind            TEXT NOT NULL CHECK (kind IN ('base','pre','post')),
  commit_sha      TEXT NOT NULL,
  branch          TEXT NOT NULL,
  created_at      TEXT NOT NULL
) STRICT;

CREATE TABLE usage_observation (        -- append-only; reported never merged with estimated (FR-CAP-01)
  id               TEXT PRIMARY KEY,
  run_id           TEXT REFERENCES run(id),
  provider         TEXT NOT NULL,
  harness          TEXT NOT NULL,
  backing_provider TEXT,
  model            TEXT,
  source           TEXT NOT NULL CHECK (source IN ('provider_reported','controller_estimated')),
  metrics_json     TEXT NOT NULL CHECK (json_valid(metrics_json)), -- tokens, cost as reported, rate-limit signals, reset_at
  observed_at      TEXT NOT NULL
) STRICT;
CREATE INDEX usage_provider_time ON usage_observation(provider, observed_at);

CREATE TABLE provider_health (          -- mutable, one row per provider; breakers detailed in M6
  provider          TEXT PRIMARY KEY,
  auth_state        TEXT NOT NULL CHECK (auth_state IN ('OK','AUTH_REQUIRED','UNKNOWN')),
  version_state     TEXT NOT NULL CHECK (version_state IN ('VALIDATED','UNVERIFIED','ABSENT')),
  breaker_state     TEXT NOT NULL DEFAULT 'CLOSED' CHECK (breaker_state IN ('CLOSED','OPEN','HALF_OPEN')),
  breaker_until     TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_probe_at     TEXT,
  last_failure_code TEXT,
  capacity_json     TEXT CHECK (capacity_json IS NULL OR json_valid(capacity_json)), -- FR-CAP-02, M6
  updated_at        TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE route_decision (           -- append-only (FR-RTE-03); M2 writes eligibility only, M7 adds scores
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES run(id),
  features_json   TEXT NOT NULL CHECK (json_valid(features_json)),
  weights_json    TEXT CHECK (weights_json IS NULL OR json_valid(weights_json)),
  candidates_json TEXT NOT NULL CHECK (json_valid(candidates_json)), -- per candidate: eligible?, reasons, score
  selected_provider TEXT,
  reasons_json    TEXT NOT NULL CHECK (json_valid(reasons_json)),
  created_at      TEXT NOT NULL
) STRICT;

CREATE TABLE approval (                 -- privileged runs (FR-POL-09), M3
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES run(id),
  scope_json    TEXT NOT NULL CHECK (json_valid(scope_json)),   -- explicit files/shell/network/config scope
  scope_hash    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','DENIED','EXPIRED')),
  requested_at  TEXT NOT NULL,
  decided_at    TEXT,
  decided_by    TEXT                    -- OS user of operator CLI
) STRICT;

CREATE TRIGGER run_event_no_update BEFORE UPDATE ON run_event
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER run_event_no_delete BEFORE DELETE ON run_event
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER decision_no_update BEFORE UPDATE ON decision
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER decision_no_delete BEFORE DELETE ON decision
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER workspace_checkpoint_no_update BEFORE UPDATE ON workspace_checkpoint
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER workspace_checkpoint_no_delete BEFORE DELETE ON workspace_checkpoint
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER usage_observation_no_update BEFORE UPDATE ON usage_observation
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER usage_observation_no_delete BEFORE DELETE ON usage_observation
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER route_decision_no_update BEFORE UPDATE ON route_decision
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER route_decision_no_delete BEFORE DELETE ON route_decision
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER approval_update_once BEFORE UPDATE ON approval
WHEN OLD.status <> 'PENDING'
BEGIN SELECT RAISE(ABORT, 'approval already decided'); END;
CREATE TRIGGER approval_no_delete BEFORE DELETE ON approval
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`;
