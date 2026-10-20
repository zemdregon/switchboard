# ADR-0070: MCP `merge_run_pr` through the T15.8 merge-policy gate

- Status: Accepted (built 2026-10-20).
- Date: 2026-10-20
- Amended by [ADR-0073](0073-merge-gate-accepts-pure-base-merges.md) (2026-10-20): the head check also accepts a chain
  of pure base merges on the published tip, `expected_head_sha` may be that accepted head and the result gains
  `head_kind`; the decision above is otherwise unchanged.
- Decided by: Linus (design authority) on owner approval of auto-merge for whumpo-website, 2026-10-20. The design
  below is Linus's; the refinements marked **Delegated** were made while building it and are not owner-approved.
- Related: FR-SUB-02, FR-GIT-12, FR-PRJ-10, FR-EXE-10, FR-MCP-15, [ADR-0060](0060-opt-in-head-pinned-merge-policy.md)
  (the merge policy and its gate), [ADR-0069](0069-mcp-publish-run-and-dynamic-project-push.md) (`publish_run`),
  [ADR-0050](0050-ci-status-via-operator-gh-cli.md) (the operator's `gh`, G10 to G12),
  [LLD §3.4.13](../design/LLD.md#3413-merge_run_pr-fr-sub-02-fr-git-12-adr-0070),
  [LLD §20.7](../design/LLD.md#207-opt-in-merge-policy-and-ref-events-fr-sub-01-fr-sub-02-t158-adr-0060),
  [ROADMAP T15.11](../ROADMAP.md#614-m15-project-queue-schedules-and-ci-triggers-tasks).

## Context

An MCP-only steward (the whumpo-website client: `manage_projects`, `max_push_policy: branch`, approval proxy on itself
for `dynamic_project` and `push_revision`) publishes runs with `publish_run` (ADR-0069) but had no MCP tool to merge
the pull request. T15.8 (ADR-0060) already has an opt-in, head-pinned merge policy per project, applied by the CI
poller, but only on the poller's tick, only while `ci_trigger.enabled`, and always requiring a passed
`verification_result` at the head. Leaving MCP to merge by hand, or adding a second merge path with its own checks,
would either break the MCP-only goal or duplicate the safety gate.

## Decision

1. **New MCP tool `merge_run_pr { run_id, expected_head_sha? }`.** It merges the pull request of the run's published
   ref through the operator's `gh` login, synchronously, only when T15.8's gate holds at the pull request's current head,
   read by the controller from `gh` JSON only: the project's merge policy in force and enabled (configured project, or
   a dynamic project's in-force revision), the project not paused, the pull request `OPEN`, not draft, its head the tip
   Switchboard published (and `expected_head_sha` when given), its base the primary context's base branch, `MERGEABLE`,
   every required check completed and successful (none required is refused, fail closed; pending is refused
   `check_pending`, never waited for), and the policy's verification and `required_reports` conditions. Then G12, `gh pr
   merge <n> --<method> --match-head-commit <sha>` (the existing audited argv).
2. **One gate.** The per-ref gate is factored out of `pollMergePolicies` into `applyMergeGate`
   (`src/ci/merge-policy.ts`), called by the poller (`poll` mode, behaviour unchanged) and by the tool through
   `mergeOnRequest` (`request` mode). There is no second copy of the checks.
3. **Request-mode differences (Delegated).** No pull request or a `CLOSED` one is `not_mergeable`; a pull request already
   `MERGED` at the published tip returns `merged: true` without G12 (idempotent), at another head `head_moved`; an
   earlier `attempted` row does not block a new G12 (head-pinned, so a retry after `gh_error` is safe; the poller keeps
   its one-attempt-per-head rule); a paused project, or one without the policy in force, is `policy_off`; a superseded
   ref (T15.7) is `head_moved`. No reason is added, so `merge_event`'s closed list and migration 0031 are unchanged.
4. **Records.** Every refusal, attempt and merge is the poller's `merge_event` row, run event on the publishing run and
   sink event, so `get_digest` shows it to the publishing client only. Result: `{ run_id, pull_request: { number, url },
   merged: true, head_sha, method }`. A refusal is `PERMISSION_BLOCKED` with `details.reason` from the closed list; a
   `gh` read or merge failure is `TOOL_FAILURE` `gh_error`, `retryable: true`.
5. **Offered exactly with `publish_run`.** Listed and callable only when `publish_run` is (publish port and
   `max_push_policy: branch`, never a `console` profile) and the server has the merge port; otherwise it is an unknown
   tool. `tools/list` and `callTool` read the same `offeredDescriptors`. Scope is `publish_run`'s: another client's or
   another HTTP subject's run is `unknown run`, and the run's project must be one the client may publish. The run must
   have an accepted push of a branch recorded on it (`publish_run` or the agent `push` tool; **Delegated**: both are
   controller pushes of the client's own run), else `INVALID_REQUEST` `NOT_PUBLISHED`.
6. **`ci_trigger` (Delegated, as recommended).** `serve` always wires the merge port: the CI poller's `gh` port when
   `ci_trigger.enabled`, otherwise the same G10 to G12 port on `ci_trigger.gh_binary` (as `publish_run` uses that binary
   when the trigger is off). The tool does not depend on `ci_trigger.projects`; the project's own merge policy decides.
   `ci_trigger.enabled` stays the switch for the poller's unattended merges only.
7. **`merge_policy.require_verification`** (boolean, default `true`, T15.8's behaviour). `false` skips the
   `verification_result`-at-head condition only; `required_reports`, the checks and every pull request condition still
   apply. A dynamic revision with `require_verification: false` waits for approval with `approval_needed`
   `merge_policy`, as `enabled: true` already does (`src/projects/rules.ts`), approvable with `decide_approval` by an
   approval proxy whose kinds include the revision's kind, or `switchboard projects approve`. The gate's policy re-read
   refuses `policy_off` when verification was turned back on after the pass skipped it.
8. **`list_projects` shows the merge policy in force** of each project that sets one: `merge_policy: { enabled,
   method, required_reports, require_verification }`. Absent means off. Nothing changes for projects without a policy.

## Alternatives

- **A separate merge check in the MCP layer.** Rejected: two gates drift; the decided design names one shared function.
- **Wait for pending checks inside the call.** Rejected: a synchronous tool must not hold a request for CI minutes; the
  client calls again (refusals are recorded once per head and reason).
- **New refusal reasons (`no_pull_request`, `project_paused`).** Rejected: the closed list is a database `CHECK`
  (migration 0031); the existing reasons describe these cases and `details` carries the facts.
- **Offer the tool only when `ci_trigger.enabled`.** Rejected: it would tie an explicit client request to the unattended
  poller's switch; the publish port already runs `gh` with the trigger off.

## Consequences

- The steward can publish and merge over MCP only, under a policy the operator (or its approval proxy) approved.
- `merge_run_pr` is an outward-facing write with the operator's GitHub credentials, reachable by any client configured
  with `max_push_policy: branch` whose project has the policy on. It is bounded by the same gate, head pin and closed argv
  as the poller (risks R-77, R-78 apply unchanged).
- `require_verification: false` lets a project merge on required checks alone; it is a widening that waits for approval.
- The installed-`gh` flag check (Q-109) still applies; tests use a fake port only.
