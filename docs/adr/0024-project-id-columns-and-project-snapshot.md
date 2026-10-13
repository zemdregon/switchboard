# ADR-0024: Project ID columns and the project block in the policy snapshot

- Status: Accepted
- Date: 2026-10-13
- Decided by: Delegated (agent), under [owner decision 25](../ROADMAP.md#42-owner-decisions) (best practice for a
  decision that does not affect bypass mode). Not an zemdregon quote and not owner-approved. Recorded as owner decision
  31 in the roadmap for traceability only. The tables and columns themselves were already proposed in
  [LLD §1](../design/LLD.md#1-data-model) ("M9 additions"); this ADR records the persistence-format change that
  AGENTS.md requires.
- Related: FR-PRJ-03, FR-PRJ-04, FR-PRJ-06, [ADR-0005](0005-sqlite-ledger.md), [ADR-0013](0013-projects-environments-and-contexts.md),
  FRD V12 and BR-23, ROADMAP T9.2

## Context

M9 lets `delegate_task` name a project instead of a workspace path. FR-PRJ-03 requires runs and meta-sessions to record
their project and a meta-session to stay in it; FR-PRJ-04 requires the environment kind in the run's policy snapshot.
The ledger had no place for either (ledger schema version 1).

## Decision

1. Migration `0002_project_id` (`src/ledger/migrations/0002_project_id.ts`) is forward-only like `0001` and adds two
   nullable `TEXT` columns: `meta_session.project_id` and `run.project_id`. Existing rows keep `NULL`, which means
   "delegated by workspace path". No index, no `CHECK` and no foreign key: a configured project may leave the
   configuration while its history stays (FR-PRJ-09), so the column cannot reference a table. An older build refuses a
   version 2 database through the existing "newer than this build supports" rule (ADR-0005); a newer build reads a
   version 1 database after the migration with no data change.
2. The resolved project is frozen into `run.policy_snapshot_json` as a `project` object: `id`, `name`,
   `environment_kind`, `context_id`, `base_ref`, `effective_max_profile` and, when the project declares them,
   `allowed_providers` (`ProjectSnapshot`, `src/policy/types.ts`). It holds no filesystem path, remote, identity or
   credential. Push policy, commit identity and the image digest join it with T9.3 and M10. A run delegated by
   workspace path has no `project` key, so its snapshot is byte-identical to before.
3. A meta-session keeps its project for life. The lifecycle enforces it in the admission transaction: a continuation
   must carry the project the meta-session was created in (or none, for a path session); any other combination is
   `INVALID_REQUEST`. `continue_task` takes no `project` input, so the MCP layer re-resolves the meta-session's own
   project under the same checks as a new request.
4. `mcp_clients[].projects` (list of configured project ids) is added to the configuration schema. An id that names no
   configured project aborts startup (NFR-SEC-06). A client with no list may use no project (fail closed); requests
   that name a workspace path are unaffected.

## Consequences

- The ledger schema version is 2. The migration test upgrades a version 1 database with existing rows and checks they
  keep `NULL`.
- `project_id` is not indexed. T9.9's "delete a project with a non-terminal run" check will scan `run` by state first;
  add an index in that task's migration if it proves slow.
- The policy snapshot is read back as a `ResolvedProfile`; the extra `project` key is ignored by the adapters.
- `git_commit`, `project_revision` and `git_push` (LLD §1) are not created here; they come with their tasks.
