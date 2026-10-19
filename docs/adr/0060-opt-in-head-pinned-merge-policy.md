# ADR-0060: Opt-in, head-pinned merge policy per project

- Status: Accepted for the direction (owner decision 76, 2026-10-19); the mechanism below is Proposed until ROADMAP
  T15.8 builds it
- Date: 2026-10-19
- Decided by: zemdregon for the direction: "Add all 7 including auto-merge", written in chat on 2026-10-19
  ([owner decision 76](../ROADMAP.md#42-owner-decisions)). The mechanism and its wording are Delegated (agent,
  2026-10-19), not owner-approved.
- Supersedes in part: [ADR-0006](0006-worktree-checkpoints-no-blind-replay.md), the alternative "Automatic merge into
  the operator's branch. Deferred: integration conflicts need judgement", and the decision clause "Integration of result
  branches is the orchestrator's or operator's step", **for projects that turn this policy on**. Everything else in
  ADR-0006 stands.
- Related: FR-SUB-01, FR-SUB-02, FR-EXE-10, FR-QUE-03, FR-QUE-05 to FR-QUE-07, FR-PRJ-10, FR-GIT-05, CAP-14,
  [ADR-0003](0003-no-credential-handling.md), [ADR-0014](0014-tool-only-commits-and-publication.md),
  [ADR-0050](0050-ci-status-via-operator-gh-cli.md), [LLD §20.7](../design/LLD.md#207-opt-in-merge-policy-and-ref-events-fr-sub-01-fr-sub-02-t158-adr-0060)

## Context

ADR-0006 deferred automatic merge because integration conflicts need judgement, and ROADMAP §8 kept "automatic merge
of result branches" Deferred. FR-SUB-01 (subscriptions to PR and merge events) was Deferred under owner decision 43.

The operator's own harness ran a merge steward more than 1,400 times while it built this repository. The steward merged
green pull requests pinned to their head SHA (`gh pr merge --match-head-commit`), behind a documentation gate whose
result was keyed to the same SHA. The comparison report (recommendation R7) proposed an opt-in policy built on three
smaller pieces: CI transient handling (FR-QUE-06), conflict and supersede handling (FR-QUE-07) and verification evidence
pinned to the head (FR-EXE-10). It asked for an owner decision first. zemdregon gave it on 2026-10-19: "Add all 7
including auto-merge."

## Decision

1. **Off by default, per project.** `projects[].merge_policy.enabled` defaults to `false`. Turning it on is an
   operator configuration change. An orchestrator that turns it on through project management waits for operator
   approval, as other widenings under FR-PRJ-10 do.
2. **Only refs the project published.** The policy applies only to a pull request whose head is a ref Switchboard
   published for that project (LLD §18.6) and whose base is the context's configured base branch. Draft pull requests
   are never merged.
3. **The gate is read by the controller from `gh` JSON, never from event or agent text.** All of these must hold at the
   pull request's current head SHA:
   - every required check is completed and successful (non-required checks are ignored; a base branch with no
     required checks is refused, fail closed);
   - the pull request is mergeable;
   - a verification result is recorded at that SHA (FR-EXE-10);
   - every report the project lists in `required_reports` (for example the `docs-alignment` skill, FR-SKL-11) says
     `aligned` at that SHA.
4. **Head-pinned merge.** The merge runs the operator's logged-in `gh` (ADR-0050's trust model; no credential in the
   controller) with `gh pr merge <number> --<method> --match-head-commit <sha>`, so a head that moves between the read
   and the merge refuses the merge on GitHub's side as well. `gh pr merge` is the only merge verb added to the
   allowlist, and only for projects with the policy on.
5. **Recorded.** Every merge and every refusal is a `merge_event` ledger row with a reason from a closed list, shown in
   `get_digest` and sent to sinks as a closed payload ([ADR-0048](0048-notification-sinks.md)).
6. **Ref events (FR-SUB-01 first delivery).** The same poller records CI pass and fail on the head, commits by another
   party, conflicts, merge and close as ledger events for the publishing client. There is still no inbound webhook
   (ADR-0050, alternatives), and an event never authorises an action by itself.

## Alternatives considered

- **Keep merge with the external orchestrator.** Rejected by owner decision 76. It also keeps the gate logic in a
  prompt, which the harness report found error-prone.
- **Merge on any green check.** Rejected: the harness needed "required checks only" (the macOS leg was dropped from
  gating by a ruling), and an unpinned merge can land a head nobody verified.
- **Merge into the operator's local branch.** Rejected: Switchboard never touches the operator's checked-out branch
  (ADR-0006). The merge happens on the host repository through its pull request.

## Consequences

- A project with the policy on lands work without a human merge step; the controls are required checks, mergeability,
  verification at the head and the operator's branch protection on the host.
- The `gh` allowlist gains a write verb (with ADR-0050 amendment 1's rerun and cancel), each behind its own project
  switch.
- [PRD §6](../requirements/PRD.md#6-non-goals) no longer lists automatic merge as a non-goal without qualification; it
  stays a non-goal for projects without the policy.
- Branch protection settings on the host remain the operator's responsibility and are not read as configuration.

## Revisit when

- A target host other than GitHub needs merging.
- The operator wants merge queues or required reviews to count as part of the gate.
- An inbound webhook path is accepted for FR-SUB-01.
