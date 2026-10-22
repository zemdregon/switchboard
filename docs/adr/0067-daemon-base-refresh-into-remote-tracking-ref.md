# ADR-0067: The daemon refreshes a project's base branch into its remote-tracking ref

- Status: Accepted (built 2026-10-20). Extended by [ADR-0074](0074-fresh-base-for-cloned-projects-and-session-rebase.md)
  (default base remote for `clone_url` contexts; `refresh_project_base`, `rebase_session`).
- Date: 2026-10-20
- Decided by: Linus decision, Delegated, not owner-approved (agent, 2026-10-20). It does not change bypass runs, the
  Git-write denial or worktree isolation: the agent still cannot write a ref, and the new controller write is checked
  by the ref guard in every profile.
- Related: FR-PRJ-02, FR-GIT-01, FR-GIT-03, FR-WS-05, FRD BR-27,
  [ADR-0027](0027-ref-snapshots-and-violation-handling.md), [ADR-0028](0028-controller-push-and-credential-reach.md),
  [LLD §5.2](../design/LLD.md#52-base-refresh-fr-prj-02-note-adr-0067), [ROADMAP T9.15](../ROADMAP.md#63-m9-projects-and-controlled-commits-tasks).

## Context

A meta-session's first worktree starts at the project's `base_ref` resolved in the operator's repository
(`src/workspace/manager.ts`). Nothing in Switchboard updates that branch. On 2026-10-20 every production run started
from `f06f181` (the local `main`) while `origin/main` had moved several merges ahead. Agents ran `git fetch` to see the
current `main` and were refused `PERMISSION_BLOCKED` (FR-GIT-01, as designed), and every published branch came out
conflicting with its base.

The fix must make the run base current without letting the agent write refs, and keep the ref guard (ADR-0027) fail
closed for agent-made ref changes. A controller fetch moves a remote-tracking ref, which another run's guard would
report as a violation if it happened after that run's LEASED snapshot.

## Decision

1. **Opt-in per project.** A primary context may set `base_remote`, a remote name (never a URL; the `push.remote`
   rule). Without it nothing changes.
2. **The daemon fetches, into the remote-tracking ref only.** Before a meta-session's first worktree is created, under
   the per-repository worktree serialisation, the controller fetches `refs/heads/<base>` from that remote into
   `refs/remotes/<remote>/<base>` with a non-forced refspec, no tags, no submodules and no maintenance. It never writes
   the local branch: the operator's checkout may have it checked out, and FR-WS-05 keeps the operator's branches the
   operator's. The suggested alternative, fast-forwarding the local `main`, was rejected for that reason; the run gets
   the same commit either way.
3. **The run starts at the fetched commit when it fast-forwards the local branch.** A local branch that is ahead or has
   diverged wins (the operator's unpushed work is not dropped); the outcome is recorded.
4. **Only while no other run of the repository holds a write lease.** Otherwise the fetch is skipped (`REPO_BUSY`)
   and the run uses the tracking ref only if step 6 trusts it.
5. **Recorded, and excluded from the guard's comparison by that record.** One `base_refresh` run event per attempt
   (names, SHAs and a reason code; never a URL or Git output). The ref guard accepts a tracking-ref move to exactly the
   SHA of the newest `fetched` record for that ref of that repository, including a symbolic `refs/remotes/<remote>/HEAD`
   through its target. Any other value, a rewind to an older fetched value and a deletion stay violations. The
   refreshing run's own snapshot is taken after the fetch, so the fetch is never in its own comparison.
6. **A tracking ref is trusted only from the controller's record.** After a skipped or failed fetch the current value
   is used only when it equals the newest recorded fetched SHA, so a value an agent wrote cannot become a later base.
7. **The fetch has the push's trust boundary (ADR-0028).** It runs with the operator's own Git configuration so the
   SSH agent or credential helper works, with the allowlisted environment, its own session, no prompts and a timeout;
   the repository's unsafe configuration keys and credential-carrying or disallowed-transport URLs refuse it first.
8. **Degrade, never fail.** Any problem records its reason and the run starts from the configured `base_ref`.

## Consequences

- With `base_remote` set, a new meta-session starts from the remote's current base without operator action, and its
  published branch is based on it. The local branch and the operator's checkout are untouched.
- The controller now makes a network read with the operator's Git credentials at run start, where before only a push
  did. It is opt-in, names a configured remote only and is recorded on every attempt.
- An agent fetch that lands the tracking ref on exactly the controller's newest fetched SHA is indistinguishable from
  the controller's and is accepted; it changes nothing the controller would not have done.
- A crash between the fetch and its record leaves an unrecorded tracking-ref move: other runs report it, and it is not
  trusted as a base until the next recorded fetch.
- Not covered: later runs of a meta-session (they start from the meta-session head) and the T15.7 rebase preparation,
  which still resolves `base_ref` locally (**Proposed** follow-up: resolve it through the same trusted tracking value).
