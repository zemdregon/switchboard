# ADR-0027: Ref snapshots at LEASED and FINALIZING, and what the controller restores on a Git policy violation

- Status: Accepted; expected differences extended by [ADR-0028](0028-controller-push-and-credential-reach.md) (the
  remote-tracking ref a controller push updates)
- Date: 2026-10-13
- Decided by: Delegated (agent), under [owner decision 25](../ROADMAP.md#42-owner-decisions) (best practice for a
  decision that does not change what a bypass run may do; this one keeps bypass runs' Git-write denial exactly as owner
  decision 22 requires). Not an Ender quote and not owner-approved. Recorded as owner decision 34 in the roadmap for
  traceability only. Detection itself was already decided in
  [ADR-0014](0014-tool-only-commits-and-publication.md) item 6 and specified in
  [LLD §12.5](../design/LLD.md#125-ref-snapshot-and-violation-handling); this ADR records the persisted snapshot format
  and the restore rules the LLD and FRD BR-27 left open.
- Related: FR-GIT-01, FR-GIT-03, FR-GIT-08, FR-WS-03, FR-WS-05, FRD BR-27, FRD §4.5,
  [ADR-0006](0006-worktree-checkpoints-no-blind-replay.md), [ADR-0014](0014-tool-only-commits-and-publication.md),
  [ADR-0022](0022-nested-repositories-excluded-from-controller-git.md),
  [ADR-0025](0025-git-commit-provenance-and-sanitiser.md), [ADR-0026](0026-per-run-tool-channel-socket-and-token.md),
  ROADMAP T9.5, R-47, Q-44

## Context

FR-GIT-03 requires a ref snapshot before and after each run and a check of the run branch; FRD BR-27 says a violation
does not fail the run, the content is kept as working-tree content in the evidence checkpoint, the offending commits are
never published, a `git_policy_violation` event names what was found and `runs show` flags it. LLD §12.5 puts the LEASED
listing (hash plus names and SHAs, "bounded in size") in a `run_event` payload. Left open: the payload format that a
restarted controller must read back, the bound, which changed refs the controller puts back and which it only reports,
how a legitimate tool commit (T9.4) is told apart from an agent's `git update-ref` on the publish ref, how concurrent
runs in the same repository avoid flagging each other, and what happens when the check cannot run.

## Decision

1. **Snapshot event, version 1.** After `WorkspaceManager.prepare` and before compile and spawn, a `git_ref_snapshot`
   run event with `{v: 1, phase: "leased", digest, ref_count, refs, truncated, tail, repo_head, worktree_head,
   run_branch, publish_ref}`: `git for-each-ref` over the main repository (branches, tags, remote-tracking refs, notes,
   stash, every `switchboard/` ref), `digest` a SHA-256 over all `<sha> <name>` lines in code-unit order, `refs` the
   first refs by name, `repo_head` and `worktree_head` as symbolic-ref target and SHA. No new table or column; the
   ledger survives a restart, so reconciliation compares against the same snapshot. If the repository cannot be read at
   LEASED the run fails `TOOL_FAILURE` (`reason: GIT_REF_SNAPSHOT_FAILED`) before spawn.
2. **Bound (Proposed numbers).** At most 5000 listed refs and 1 MiB of names and SHAs; refs beyond are covered by a
   tail count and digest (excluding the run's own branch and publish ref, which are checked against the ledger).
   A change in the tail is one violation `unlisted_refs_changed` without names. At most 200 violation entries per event
   (the total is always stored), at most 50 foreign commit SHAs per ref. `get_run` events and `runs show` show the
   snapshot's digest and counts, never the ref list.
3. **Check at FINALIZING.** After the provider has exited and before the post-run checkpoint (lifecycle and
   reconciliation), compare; one `git_policy_violation` event (scope, kind, ref name, old and new SHA, action, restore
   target, foreign commit SHAs; never a message or file content) is appended **before** anything is restored, then a
   `git_ref_check` event with the outcome (`clean`, `violation` with per-ref restore results, `failed`, `skipped`). A run
   with a `git_ref_check` event is not checked again. The run's outcome is unchanged (BR-27); the terminal transition
   payload carries `git_policy_violation: true`, and `runs show` prints a `git policy: VIOLATION` line.
4. **Restored (controller-owned refs only), each with a compare-and-swap.**
   - The run branch is expected at the run's `pre` checkpoint commit (ledger). Any other tip is put back there; the
     worktree's files and index are not touched, so the agent's tree becomes the checkpoint's working-tree content and
     the agent's commits are not in the run branch history.
   - The worktree's `HEAD` must be the symbolic ref to the run branch; otherwise it is pointed back, so the checkpoint
     lands on the run branch.
   - The publish ref is accepted when unchanged since LEASED, or when it is a commit with a `git_commit_intent` (not
     aborted) whose recorded parent chain through such commits reaches the meta-session's base commit. Otherwise it is
     moved to the newest commit with a `git_commit` row and a valid chain, else to its LEASED value, else deleted. A tool
     commit that T9.3 parented on an agent-moved publish head therefore fails the chain test and is not kept published.
5. **Reported, not restored: every other ref and the main checkout's `HEAD`.** The default branch, other branches, tags,
   remote-tracking refs, notes and stash may be the operator's own concurrent work, which the controller cannot tell from
   the agent's and must never modify (FR-WS-05). A push to a remote is seen only through a remote-tracking ref it
   updated, and cannot be undone (BR-27).
6. **Concurrent controller activity is not a violation.** Another run's branch may move to one of that run's checkpoint
   commits, or be deleted while that run is non-terminal (worktree repair) or after GC archived its session; another
   session's publish ref may move to one of that session's controller commits. Anything else under
   `refs/heads/switchboard/` is a violation (reported).
7. **Fail closed.** A check that cannot complete appends a `check_failed` violation and `git_ref_check` `failed`. A run
   that reached RUNNING without a snapshot gets `snapshot_missing`, and its run branch, worktree `HEAD` and publish ref
   are still checked against the ledger; a run with no snapshot that never reached RUNNING is `skipped` with an event.
8. **Same in bypass runs.** The guard takes no trust profile input: an approved `privileged` bypass run is checked,
   flagged and restored exactly like any other (owner decision 22).

## Alternatives considered

- **Fail the run on a violation.** Rejected: BR-27 says the run does not fail for that reason alone; the evidence and
  the restores give the fail-closed property that matters (nothing foreign is published or on the run branch).
- **Restore every changed ref to its snapshot value.** Rejected: it would overwrite the operator's own commits, fetches
  or tags made during the run, and FR-WS-05 forbids touching the operator's branches.
- **Store the full listing in an artifact or a new table.** Rejected for now: `artifact.kind` has no suitable value
  and a table needs a migration; the bounded event with a tail digest is enough to detect and is what LLD §12.5 describes.
- **Refuse runs in repositories above the cap.** Rejected: large tag sets are common; the tail digest keeps detection.

## Consequences

- New run event types `git_ref_snapshot` and `git_ref_check`; `git_policy_violation` gets its first writer. Two ledger
  read methods (`listGitCommitsForMetaSession`, `getMetaSessionBaseCommit`); no migration.
- Every write-capable run pays two `for-each-ref` listings and a few `rev-parse` calls.
- Operator activity in the repository during a run (a commit on the default branch, a fetch, a new tag), and changes
  beyond the listing cap, are flagged as violations although the agent did not make them (R-47). A narrow window remains
  in which another run's checkpoint commit exists in Git before its ledger row; that is flagged too (fail closed).
- T9.6 has to decide whether a session with a violation may push (Q-44).

## Revisit when

T9.6 adds push, M10 container runs make agent ref writes impossible by construction, or false positives from operator
activity prove frequent enough to need an attribution mechanism (for example the layer 3 guard of TDD §3.10).
