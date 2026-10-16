# ADR-0030: Dynamic project revisions, decisions and events in the ledger; approval on the CLI

- Status: Accepted
- Date: 2026-10-13
- Decided by: Delegated (agent), under [owner decision 25](../ROADMAP.md#42-owner-decisions) (best practice for a
  decision that does not affect bypass mode). Not an zemdregon quote and not owner-approved. Recorded as decision 39 in
  the roadmap for traceability only. zemdregon answered only "yes" to orchestrator-managed projects (Q-7, owner decision
  8); the gating limits, the pending-approval state and creator-only visibility were already Proposed in FRD BR-32, SRS
  FR-PRJ-10 and [ADR-0013](0013-projects-environments-and-contexts.md). This ADR records the persistence format, the
  trust-boundary mechanics and the external interface (three MCP tools, two configuration keys, one CLI command) that
  AGENTS.md requires an ADR for.
- Related: FR-PRJ-10, FR-PRJ-01, 02, 06, 09, FR-POL-10, FR-MCP-06, FRD BR-32, HLD TB-9,
  [ADR-0005](0005-sqlite-ledger.md), [ADR-0013](0013-projects-environments-and-contexts.md),
  [ADR-0024](0024-project-id-columns-and-project-snapshot.md), ROADMAP T9.9

## Context

FR-PRJ-10 lets an MCP client whose entry sets `manage_projects` create, update and delete *dynamic projects*. An LLM
orchestrator then chooses where agents run, so the feature crosses trust boundary TB-9 (HLD): a compromised or
prompt-injected orchestrator must not reach paths, providers, ceilings, push rights, containers or identities beyond its
own entry, nor edit the operator's configured projects. LLD §1 proposed a `project_revision` table with an
`approved_at` column, but also lists it among the append-only tables, which cannot take a later update. FR-PRJ-10 asks
that every call, accepted or refused, be recorded as an event; `run_event.run_id` is `NOT NULL` and a project call
belongs to no run.

## Decision

1. **Migration `0004_project_revision`** (ledger schema version 4; additive and forward-only, ADR-0005) creates three
   append-only tables, each with `BEFORE UPDATE` and `BEFORE DELETE` guards like the other append-only tables:
   - `project_revision` (LLD §1 DDL): `id` (`prv_`), `project_id`, `revision` (unique per project, from 1),
     `client_id` (the creator; later revisions must carry the same client), `definition_json` (the validated project
     object of LLD §11.1; repository paths are stored, as they are operator-visible configuration; no secret can be in
     it, since the schema has no credential field and a remote must be a remote name), `status`
     (`ACTIVE | PENDING_APPROVAL | DELETED`), `approval_reasons_json` and `created_at`, plus an index on
     `(client_id, project_id)`. **Deviation from LLD §1:** no `approved_at` column; the approval is a row of its own.
   - `project_revision_decision`: the operator's approval or rejection of one revision (`prd_`; `decision`, OS user,
     optional reason, time), unique per `(project_id, revision)` and referencing that revision.
   - `project_event`: one row per `create_project`, `update_project` or `delete_project` call, accepted or refused
     (schema failures and calls by a client that is not offered the tools included), and per operator decision
     (`pev_`; actor, client or operator, action, project id when it is a well-formed id, revision, outcome, taxonomy
     code when refused, a reason code, a bounded payload of codes and field paths). It never holds a definition, a path
     or request text.
2. **State is derived, never stored:** a revision is usable when `ACTIVE`, or `PENDING_APPROVAL` with an `APPROVED`
   decision; the revision in force is the highest usable revision; a `DELETED` latest revision deletes the project and
   its id is never reused; only the latest revision can be decided, once. A newer revision that waits (or was rejected)
   leaves the previous one in force.
3. **Configuration:** `mcp_clients[].manage_projects` (boolean, default `false`) and `mcp_clients[].max_push_policy`
   (`none | branch`, default `none`; refused without `manage_projects`). Strict schema.
4. **Tools:** `create_project`, `update_project` and `delete_project` are listed and callable only for a client with
   `manage_projects`; for any other client a call is answered exactly as an unknown tool (and recorded). A definition is
   validated like configuration (the published `projectSchema` with Delegated length and item bounds, the loader's
   structural rules, and the `projects validate` filesystem rules: absolute path, `realpath` under an allowed root,
   Git repository whose top level is under an allowed root, `base_ref` resolves) and must also be free of control,
   separator and bidirectional characters and not lie inside the controller's data directory. Limits are the client's:
   ceiling no higher than its `max_trust_profile`, push policy no wider than `max_push_policy`, providers within its
   provider set (the providers the operator has not disabled; no per-client provider list exists). Quotas: 32 live
   projects per client, 100 revisions per project (Assumptions). A configured id, or another client's dynamic project,
   is `PERMISSION_BLOCKED` with the same message.
5. **Approval:** a revision waits (`PENDING_APPROVAL`, `approval_needed` in the result) when it has a `container`
   environment, a push policy other than `none`, a commit identity, `sign: true`, or widens the revision in force
   (higher effective ceiling, or providers no longer a subset). The commit identity and signing reasons are additions:
   an identity names the author of published commits (LLD §11.2 says an orchestrator must not invent one, and the
   `identities` list proposed there is not built), and signing would use the operator's key. Only
   `switchboard projects approve <id> [--revision n] [--reject]` decides; it requires `--revision` once a project has
   more than one revision, so a client cannot swap in a new revision between the operator's review and the approval.
   It takes the data-directory lock when free and otherwise still writes its single row (like `approve`/`deny`).
6. **Use:** `delegate_task` and `continue_task` resolve a dynamic project only for its creator, only while that client
   still has `manage_projects`, to its in-force revision, after re-checking the client's current limits and the
   filesystem rules; a configured project of the same id always wins. The run's policy snapshot is frozen exactly as
   for a configured project (shape unchanged); the route decision's `project` reasons name the revision.
   `list_projects` shows a client its own dynamic projects with `source`, `revision` and `status`, never a path.
   Deletion is refused (`INVALID_REQUEST`, as FR-PRJ-10 and LLD §3 say) while a run of the project is not terminal or a
   request for it is being admitted; history stays (FR-PRJ-09).

## Alternatives considered

- **`approved_at` updated in place** (LLD §1 as drafted): rejected; it breaks the append-only rule and loses who
  decided. An update-once column like `approval` was possible but the decision row also records rejections.
- **Events as `run_event` rows:** impossible without a run; a synthetic run per project was rejected as misleading.
- **Namespacing dynamic ids per client** (for example `<client>/<id>`): rejected; ids would differ from the
  configuration's shape and `project_id` columns would need parsing. Collisions are refused instead.
- **Approve the latest revision without `--revision`:** rejected for projects with more than one revision (the
  time-of-check gap above).
- **Wiring push targets for approved dynamic projects** into the `push` tool and `switchboard git push`: not done in
  T9.9. Both still resolve push contexts from the configuration only, so an approved push-enabled dynamic project is
  refused at push time (`CONTEXT_UNKNOWN`), which fails closed (ROADMAP Q-46).

## Consequences

- An older build refuses a version 4 ledger through the existing "newer than this build supports" rule.
- An orchestrator with `manage_projects` can point agents at any Git repository under the allowed roots, as a
  `workspace_path` request already can; it cannot reach more than its entry allows without the operator. Residual risks
  are in ROADMAP §7.1 (R-53, R-54).
- Dynamic projects with push cannot push yet (Q-46). A dynamic `container` project is admitted when `serve` composes
  container placement for it (T10.1, [PR #554](https://github.com/zemdregon/switchboard/pull/554)); a host-only
  configuration still refuses at admission with `ENVIRONMENT_NOT_IMPLEMENTED`.
