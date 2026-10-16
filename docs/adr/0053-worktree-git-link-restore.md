# ADR-0053: Controller Git reaches a run worktree only through its own `.git` link

- Status: Proposed
- Date: 2026-10-16
- Decided by: Delegated (agent, 2026-10-16, under [owner decision 25](../ROADMAP.md#42-owner-decisions); not
  owner-approved). It does not change what a bypass run may do: it keeps the Git-write denial that bypass runs keep
  (owner decisions 22 and 24).
- Related: T10.3, T9.5, FR-GIT-01, FR-GIT-03, FR-WS-05, FR-PRJ-05, NFR-SEC-03, R-35, R-40,
  [ADR-0027](0027-ref-snapshots-and-violation-handling.md), [ADR-0020](0020-container-image-without-git-client.md),
  [ADR-0052](0052-container-environment-docker-backend.md),
  [LLD §12.5](../design/LLD.md#125-ref-snapshot-and-violation-handling)

## Context

A run worktree is a linked Git worktree: its `.git` is a one-line file, `gitdir: <repository>/.git/worktrees/<name>`,
inside the worktree. In a `container` environment the worktree is the one writable mount (FR-PRJ-05), so even an agent
with no Git client and no view of the Git directory can rewrite that file; in a `host` environment it is the agent's
own directory. Every controller Git command that runs in the worktree finds its repository through that file: the ref
check reads the worktree `HEAD` and may point it back with `symbolic-ref`, the post-run checkpoint runs `add -A` and
`commit`, rollback runs `reset --hard` and `clean`.

The T10.3 container leg of the malicious-fixture suite checked what happens when the agent points the link at the
operator repository's Git directory (`gitdir: <repository>/.git`). That is a path the agent can read from the link
itself. Before this decision the controller followed it. A probe on `main` before this change (fake adapter, host
environment, recorded in the T10.3 pull request; **Observed** 2026-10-16) had the agent write one file and rewrite the
link. ADR-0027's ref check read the worktree `HEAD` through the link, found the operator's `refs/heads/main`, and
"restored" it with `symbolic-ref`. That switched the **operator's checkout `HEAD`** from `main` to the run branch. The
checkpoint's `add -A` and `commit` then ran through the **operator's index**, which was left holding the agent's file.
The run branch got the checkpoint, so the agent's write still landed as content, but the controller had changed the
operator's checkout (FR-WS-05). A `.git` directory the agent made instead would have the checkpoint record the agent's
own history.

## Decision

1. **Expected link from the host side only.** The expected link is the `worktrees/<name>` entry of the run's
   repository whose recorded `gitdir` is this worktree's `.git` (`src/workspace/git-link.ts`). That entry lives in the
   repository's Git directory, which is never mounted into a container. When no entry names the worktree, the check
   fails closed (it throws).
2. **Checked first, recorded, then restored.** `RefGuard.checkAtFinalizing` inspects the link before it reads any ref
   through the worktree. Anything else at `<worktree>/.git` is a violation: another target, unreadable content, a
   directory, a symlink, or nothing. The scope is `worktree_link`, the kind `link_changed` and the action `restore`.
   It is appended as a `git_policy_violation` event before the effect. Then the expected file is written back, never
   following a symlink, and the `git_ref_check` event lists `{scope: "worktree_link", ok}` among its restores. A
   failed restore is a `check_failed` violation, as for any check that cannot complete. Both the lifecycle and
   startup reconciliation call this method, so both paths are covered.
3. **Defence in depth.** `WorkspaceManager.assessMutation`, `finalize` and `rollback` also restore the link silently
   before their Git commands. The ref guard is the place where the change is recorded.
4. **Outcome unchanged.** As with other Git policy violations (BR-27), the run's outcome is not changed. The terminal
   payload carries `git_policy_violation: true`. The agent's files are kept as checkpoint content on the run branch.

## Consequences

- An approved bypass agent in a container cannot make the controller change the operator's refs, `HEAD` or index by
  redirecting the link. The container leg (`test/malicious/container-leg.test.ts`, and the opt-in
  `test/malicious/container-docker-leg.test.ts` on rootless Docker) shows every ref unchanged except the run branch,
  which only the controller's checkpoint moves.
- The same holds for `host` runs. There, an agent that can also write the repository's Git directory directly is
  still caught by ADR-0027's ref comparison (reported, not restored, for operator refs).
- Not covered: an agent on the host that rewrites the repository's `worktrees/<name>/gitdir` entry itself. That needs
  write access to the Git directory, which a container never has.
