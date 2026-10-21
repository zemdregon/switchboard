# ADR-0078: MCP `close_pr` closes a superseded pull request Switchboard opened

- Status: Accepted (built 2026-10-21).
- Date: 2026-10-21
- Decided by: Delegated agent work on an operator task (2026-10-21), not owner-approved. The gap and the outline (close
  only pull requests Switchboard opened, comment the replacement, optional branch deletion, `publish_run`'s gate, audit
  every call) come from the operator's task; the details marked **Delegated** were chosen while building it.
- Related: FR-GIT-13, FR-GIT-12, FR-INN-11, FRD BR-38, FRD BR-58,
  [ADR-0069](0069-mcp-publish-run-and-dynamic-project-push.md) (`publish_run`, the `pull_request` record and the G13/G14
  templates, amended), [ADR-0050](0050-ci-status-via-operator-gh-cli.md) (the `gh` allowlist, extended with G16 and
  G17), [ADR-0003](0003-no-credential-handling.md) (the operator's own `gh` login, no token handled),
  [LLD §3.4.16](../design/LLD.md#3416-close_pr-fr-git-13-adr-0078),
  [ROADMAP T9.21](../ROADMAP.md#63-m9-projects-and-controlled-commits-tasks).

## Context

When an orchestrator re-implements a change, `publish_run` opens a new pull request and the old one stays open. On
2026-10-21 the whumpo steward had to close Digifender-LLC/whumpo-website pull request #301 by hand with `gh`, outside
Switchboard: no MCP tool could close a pull request, so an MCP-only client could not clean up after itself, and the
close left no Switchboard record. ADR-0069 had ruled out any edit or comment on a pull request.

## Decision

1. **New MCP tool `close_pr { project_id, pull_request_number, replacement_pull_request_number, delete_branch? }`.**
   Offered exactly when `publish_run` is (the publish port and `max_push_policy: branch`, never a `console` profile) and
   the server's pull-request port can read a pull request by number and close one (`serve` always wires both through
   `GhPullRequestPort`). Otherwise it is answered exactly like an unknown tool.
2. **Scope: only pull requests Switchboard created for the caller.** The project must pass `publishableContext`
   (ADR-0069: a configured project in the client's list or a dynamic project it created, primary push policy
   `branch`); its push remote must be on github.com. The number must match a `pull_request` row with
   `action = 'created'` (never `reused`: Switchboard did not open that one) in that `owner/repo`, for a run of the
   project whose client is the caller and whose meta-session the caller's HTTP subject may see (the `get_run` rule).
   Anything else is `PERMISSION_BLOCKED` `NOT_SWITCHBOARD_PR` before any `gh` call.
3. **Checks on GitHub, then one write.** G17 (`pr view <number> --repo <o>/<r> --json number,state,url,headRefName`)
   reads the pull request and the replacement. The pull request must still have the head branch Switchboard recorded
   (`HEAD_BRANCH_MISMATCH`) and must not be merged (`ALREADY_MERGED`); the replacement must exist in the same repository
   (`INVALID_REQUEST` `REPLACEMENT_NOT_FOUND`) and differ from it (`SAME_PULL_REQUEST`). An already closed pull request
   returns `closed: false` and nothing is written (idempotent). Otherwise G16 (`pr close <number> --repo <o>/<r>
   --comment <comment> [--delete-branch]`) closes it.
4. **The comment is controller-built (Delegated).** `Superseded by #<replacement>.` followed by a fixed line naming
   `close_pr`, the client id and the run id. No caller text reaches GitHub, so the tool cannot be used to post arbitrary
   comments. Reason: the same rule as the pull request text of ADR-0069 (controller facts, untrusted text labelled).
5. **Branch deletion only when asked (Delegated).** `delete_branch` defaults to false. With `--repo`, `gh pr close
   --delete-branch` deletes the remote head branch and not a local one (**Assumption** from `gh` behaviour, not run
   against GitHub here). The branch is the one Switchboard published (checked in item 3). A later `publish_run` of the
   meta-session pushes it again as a new branch.
6. **Audit every call.** Migration 0036 adds the append-only `pull_request_close` table: one row per call, allowed or
   denied, including calls refused because the tool is not offered (`TOOL_NOT_OFFERED`) or the arguments fail the
   schema (`SCHEMA_INVALID`), with the client, the project and numbers it named (only well-typed values), the matched
   `pull_request` row, run and `owner/repo` when known, the outcome (`closed`, `already_closed`, `refused`, `failed`) and
   a closed reason code. A row that names a run also appends a `pull_request_close` run event on that run. Never a
   comment, title, body or other `gh` text.
7. **Errors.** Scope refusals are `PERMISSION_BLOCKED` with `details.reason`; a `gh` failure is `TOOL_FAILURE` with the
   port's closed code (`GH_MISSING`, `AUTH_REQUIRED`, `TIMEOUT`, `GH_FAILED`, `PARSE_FAILED`), retryable except
   `GH_MISSING` and `AUTH_REQUIRED`.
8. **Not gated on the merge policy or a pause (Delegated).** Closing removes work from review instead of landing it, so
   it does not need the opt-in merge policy that `merge_run_pr` and `update_run_branch` require.

## Consequences

- ADR-0069's "no edit, no comment" on pull requests is narrowed: `close_pr` posts exactly one controller-built closing
  comment on a pull request Switchboard created. FR-INN-11 and FRD BR-38 carry the same note; the inner agent and the
  `pr_draft` task still never touch a pull request.
- Two new `gh` templates (G16 write, G17 read) join the closed allowlist and its audit test; every other verb stays
  refused.
- Migration number 0036 and the `prc_` id prefix are taken here.
- No live `gh` call is tested (fake port and fake runner only).

## Alternatives considered

- **Take a `run_id` like `merge_run_pr`.** Rejected: the caller knows the pull request number from the replacement work,
  and a meta-session can publish several runs onto one branch; the number plus the `pull_request` row is the exact
  record of what Switchboard opened.
- **Accept a free-text comment.** Rejected: it would let a client post arbitrary text with the operator's login.
- **Also close pull requests Switchboard reused or that a person opened on a Switchboard branch.** Rejected: the task
  scopes the tool to pull requests Switchboard opened; a person can close those.
