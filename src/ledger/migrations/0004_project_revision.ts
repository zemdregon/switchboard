/**
 * Migration 0004 (T9.9; FR-PRJ-10, FRD BR-32; ADR-0030): dynamic projects, created over MCP by a client whose entry sets
 * `manage_projects`. Three append-only tables, additive and forward-only (no existing table changes):
 *
 * - `project_revision`: the DDL of LLD §1 "M9 additions" (id, project_id, revision, client_id, definition_json,
 *   status `ACTIVE | PENDING_APPROVAL | DELETED`, created_at; unique `(project_id, revision)`), **without** the
 *   `approved_at` column (an append-only row cannot be updated by the approval) and **with** `approval_reasons_json`
 *   (why a `PENDING_APPROVAL` revision waits; `[]` otherwise). Plus an index on `(client_id, project_id)` for the
 *   creator-only listing.
 * - `project_revision_decision`: the operator's `projects approve` / `--reject` of one revision (decision, OS user,
 *   optional reason code, time). At most one per revision (unique key), referencing the revision it decides.
 * - `project_event`: one row per `create_project` / `update_project` / `delete_project` call, accepted or refused, and per
 *   operator decision (FR-PRJ-10 "every call is recorded as an event"). `run_event` cannot hold them: its `run_id` is NOT
 *   NULL and a project call belongs to no run. Bounded content: codes, ids and a small payload; never a definition (that
 *   is in `project_revision`) and never request text.
 *
 * Every table gets the `BEFORE UPDATE` / `BEFORE DELETE` guards of the other append-only tables. Immutable once released:
 * the checksum of this text is recorded in `schema_migrations`.
 */
export const sql = String.raw`
CREATE TABLE project_revision (
  id              TEXT PRIMARY KEY CHECK (id LIKE 'prv\_%' ESCAPE '\'),
  project_id      TEXT NOT NULL,
  revision        INTEGER NOT NULL CHECK (revision >= 1),
  client_id       TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  status          TEXT NOT NULL CHECK (status IN ('ACTIVE','PENDING_APPROVAL','DELETED')),
  approval_reasons_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(approval_reasons_json)),
  created_at      TEXT NOT NULL,
  UNIQUE (project_id, revision)
) STRICT;
CREATE INDEX project_revision_client ON project_revision(client_id, project_id);

CREATE TABLE project_revision_decision (
  id          TEXT PRIMARY KEY CHECK (id LIKE 'prd\_%' ESCAPE '\'),
  project_id  TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  decided_by  TEXT NOT NULL,
  reason      TEXT,
  decided_at  TEXT NOT NULL,
  UNIQUE (project_id, revision),
  FOREIGN KEY (project_id, revision) REFERENCES project_revision(project_id, revision)
) STRICT;

CREATE TABLE project_event (
  id          TEXT PRIMARY KEY CHECK (id LIKE 'pev\_%' ESCAPE '\'),
  ts          TEXT NOT NULL,
  actor       TEXT NOT NULL CHECK (actor IN ('mcp_client','operator')),
  client_id   TEXT,
  operator    TEXT,
  action      TEXT NOT NULL CHECK (action IN ('create_project','update_project','delete_project','approve','reject')),
  project_id  TEXT,
  revision    INTEGER,
  outcome     TEXT NOT NULL CHECK (outcome IN ('ACCEPTED','REFUSED')),
  code        TEXT,
  reason      TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  CHECK ((outcome = 'REFUSED') = (code IS NOT NULL))
) STRICT;
CREATE INDEX project_event_project ON project_event(project_id, ts);

CREATE TRIGGER project_revision_no_update BEFORE UPDATE ON project_revision
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER project_revision_no_delete BEFORE DELETE ON project_revision
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER project_revision_decision_no_update BEFORE UPDATE ON project_revision_decision
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER project_revision_decision_no_delete BEFORE DELETE ON project_revision_decision
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER project_event_no_update BEFORE UPDATE ON project_event
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER project_event_no_delete BEFORE DELETE ON project_event
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`;
