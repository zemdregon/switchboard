# ADR-0073: Merge gate accepts pure base merges; MCP `update_run_branch`

- Status: Accepted (built 2026-10-20).
- Date: 2026-10-20
- Decided by: Linus (design authority), 2026-10-20, after production refusals. The design below is Linus's; the
  refinements marked **Delegated** (the chain limit of 10, the closed-list reuse of `gh_error`, the ref guard exemption,
  gating `update_run_branch` on the merge policy, recording the base merge head as `foreign_commit`, the Git floor) were
  made while building it and are not owner-approved.
- Related: FR-SUB-02, FR-GIT-12, [ADR-0070](0070-mcp-merge-run-pr.md) (`merge_run_pr`, amended),
  [ADR-0060](0060-opt-in-head-pinned-merge-policy.md) (the gate's head check, amended),
  [ADR-0050](0050-ci-status-via-operator-gh-cli.md) (the `gh` allowlist, extended with G15),
  [ADR-0067](0067-daemon-base-refresh-into-remote-tracking-ref.md) and [ADR-0028](0028-controller-push-and-credential-reach.md)
  (the hardened fetch and push models reused), [ADR-0027](0027-ref-snapshots-and-violation-handling.md) (ref guard),
  [LLD §3.4.14](../design/LLD.md#3414-update_run_branch-fr-sub-02-fr-git-12-adr-0073),
  [LLD §20.7.1](../design/LLD.md#2071-pure-base-merges-adr-0073),
  [ROADMAP T15.12](../ROADMAP.md#614-m15-project-queue-schedules-and-ci-triggers-tasks).

## Context

On 2026-10-20 the merge policy refused Digifender-LLC/whumpo-website pull requests #299 and #300 with `head_moved`. The
only commit after Switchboard published was GitHub's "Merge branch 'main' into <branch>" commit, created by the pull
request page's Update branch button. The gate (ADR-0060, shared with `merge_run_pr` by ADR-0070) accepted only the exact
published tip, and no MCP tool could accept that commit or update a branch, so an MCP-only steward was stuck.

## Decision

1. **The gate accepts a pure base merge chain.** In `applyMergeGate` (`src/ci/merge-policy.ts`, shared by the poller and
   `merge_run_pr`), the pull request head is acceptable when it equals the published tip or is a chain of 1 to 10
   (`MAX_BASE_MERGE_CHAIN`, **Delegated**) pure base merges on it. A commit is a pure base merge when it has exactly two
   parents, its first parent is the published tip or the previous commit of the chain, its second parent is reachable from
   the base branch head on the remote (fetched now), and its tree equals the tree of a clean local merge of its parents
   (`git merge-tree --write-tree --no-messages`). Anything else (an extra file change, a conflict resolution, a
   non-merge commit, an octopus, a second parent not on the base, a longer chain) stays `head_moved`.
2. **Controller-side verification** (`src/ci/base-merge.ts`, `GitPullHeadPort`, `classifyPullHead`) in the project's
   primary context repository. The one write is a single hardened fetch (ADR-0067 and ADR-0028 hardening) of
   `+refs/pull/<n>/head` and `+refs/heads/<base>` from the published ref's remote into the controller-owned namespace
   `refs/switchboard/merge-gate/<remote>/pr-<n>/{head,base}`; the SHAs used are those the fetch prints, never a later
   read. Never into an agent worktree or an operator branch. The ref guard (LLD §12.5) ignores that namespace
   (**Delegated**). Requires Git 2.41 (**Delegated**); older Git, unsafe repository config, a custom merge driver, an
   unknown project or a fetched head different from the one `gh` reported is `foreign` (`head_moved`, fail closed). A
   failed fetch or Git read is the refusal `gh_error`, retried next poll (**Delegated**: the reason list is closed, so
   `gh_error` now also covers the controller's Git read of the head and base).
3. **G12 is pinned to the accepted head.** `gh pr merge <n> --<method> --match-head-commit <accepted head>`, and the
   re-read before it must still show that head. `verification_result` and `required_reports` stay keyed to the
   published tip (a pure base merge adds only base content); required checks are read at the actual head.
4. **Records.** Migration 0035 adds nullable `merge_event.head_kind` (`published` or `base_merge`) and `pr_head_sha`,
   and the refusal-once index also keys on `pr_head_sha`. `merge_run_pr` gains `head_kind` in its result and accepts the
   accepted head as `expected_head_sha`. The base merge head is still a `foreign_commit` `ref_event` (**Delegated**).
5. **New MCP tool `update_run_branch { run_id, expected_head_sha? }`.** Offered exactly when `merge_run_pr` is and the
   server has the branch-update port and the pull-head reader; same scope as `publish_run`. It asks GitHub to merge the
   base into the pull request branch through the operator's `gh` (new audited argv **G15**, `gh api --method PUT
   repos/{owner}/{repo}/pulls/{n}/update-branch -f expected_head_sha=<sha> --silent`), only when the head is the
   published tip or an accepted chain and the merge would not conflict. It is gated on the merge policy being in force,
   enabled and the project not paused (**Delegated**: it is a GitHub write that only matters for the merge path, so it
   stays within projects the operator approved for merging). It writes no `merge_event`; it appends a `branch_update` run
   event.

## Alternatives

- **Trust GitHub's "Merge branch" commit by author or message.** Rejected: both are attacker-writable; the tree equality
  check is the proof.
- **Accept any descendant of the published tip.** Rejected: it would merge unreviewed content under a policy that
  vouches for the published tip.
- **Ask `gh` for the commit's parents and tree.** Rejected: the decision must come from controller-read Git data, and
  the tree comparison needs a local merge.
- **A reason `base_merge_unverified`.** Rejected: the closed list is a database `CHECK` (migration 0031).

## Consequences

- An MCP-only steward can update a branch and merge it; the Update branch button no longer strands a pull request.
- GitHub's server-side merge may differ from the local merge-ort result (rename detection), producing a false
  `head_moved`; the gate fails closed and an operator merges by hand.
- Each poll fetches once per open pull request whose head moved and is not the published tip (no cache); modest.
- Git 2.41 or newer is required for the classification; with older Git the head stays `head_moved`.
- The ref guard exempts `refs/switchboard/merge-gate/`; it is neither a violation nor trusted.
- Migration numbers: 0035 is used here; 0034 is reserved for PR #809's project setup step.
- `update_run_branch` is a new outward write with the operator's GitHub credentials, bounded by the head check, the
  policy gate, the closed argv and `expected_head_sha`. No live `gh` call is tested (fake port only; Q-109 still open).
