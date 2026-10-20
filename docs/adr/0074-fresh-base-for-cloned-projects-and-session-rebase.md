# ADR-0074: Cloned projects refresh their base by default; MCP refresh and session rebase

- Status: Accepted (built 2026-10-20). Extends [ADR-0067](0067-daemon-base-refresh-into-remote-tracking-ref.md).
- Date: 2026-10-20
- Decided by: Linus (design authority), 2026-10-20: the default base remote for `clone_url` contexts, the `base_remote`
  rule for them, `refresh_project_base`, `rebase_session` and "no force-push". Details marked **Delegated** are the
  coder's, not owner-approved. Nothing here changes bypass runs, the Git-write denial or worktree isolation: every Git
  write is the controller's, outside every agent environment.
- Related: FR-PRJ-02, FR-PRJ-10, FR-GIT-01, FR-GIT-04, FR-GIT-08, FR-WS-05,
  [ADR-0028](0028-controller-push-and-credential-reach.md), [ADR-0068](0068-mcp-only-project-onboarding.md),
  [ADR-0069](0069-mcp-publish-run-and-dynamic-project-push.md),
  [LLD §3.4.15](../design/LLD.md#3415-refresh_project_base-and-rebase_session-adr-0074),
  [LLD §5.2.1](../design/LLD.md#521-cloned-projects-and-session-rebase-adr-0074),
  [ROADMAP T9.19](../ROADMAP.md#63-m9-projects-and-controlled-commits-tasks).

## Context

On 2026-10-20 new `whumpo-website` worktrees still started from `802cd9d` (#291) while `origin/main` was at `6a3004e`.
`whumpo-website` is a dynamic project created over MCP with a `clone_url` context (`push.remote: origin`,
`base_ref: main`, no `base_remote`). The ADR-0067 refresh runs only when the primary context sets `base_remote`, so the
clone was never fetched after it was made. Separately, the refresh runs only for a meta-session's first worktree: a
continuing meta-session starts every run from its stored head, and no MCP tool could refresh a clone or rebase a
session. Run `run_01M5D74KSXB5VVC4FZD0D3Q92C` (the whumpo #301 refresh) stopped because its worktree had neither #299
nor #300.

The dynamic definition schema already carried `base_remote` (it is derived from the configuration's context schema),
but nothing checked it for a `clone_url` context and no orchestrator set it.

## Decision

1. **A `clone_url` context refreshes by default.** A primary context with `clone_url` and no `base_remote` has the
   effective base remote of its push remote when it names one, else `origin`, the remote `ensureClone` creates. It
   resolves with that `baseRemote`, so `serveBaseRefresh` fetches before every new meta-session's first worktree with
   the unchanged ADR-0067 algorithm: the hardened fetch into the remote-tracking ref only, under the per-repository
   worktree serialisation, one `base_refresh` event per attempt, the ref guard's record rule. No new network path.
   Configured projects and `path` contexts are unchanged.
2. **`base_remote` on a `clone_url` context must name the clone's remote.** `create_project` and `update_project`
   refuse any other value with `PERMISSION_BLOCKED` `BASE_REMOTE_NOT_CLONE_REMOTE`. The default, or an explicit value
   equal to it, only reads from the allowlisted clone source and needs no approval. **Delegated** (fail closed): an
   explicit value that differs from the default (possible only when `push.remote` names another remote) waits for
   approval with the new reason `base_remote`.
3. **The worktree starts from the fetched remote commit.** As ADR-0067 item 3: when the fetched commit fast-forwards
   the clone's local `main` (which nothing ever advances), the run starts from it, not from the local branch. A failed
   fetch keeps the fallback (the local base) and its `base_refresh` event with outcome `failed` is in `get_run`'s
   events.
4. **`refresh_project_base { project_id }`** fetches a remote-backed project's base now (the same refresh) and returns
   `{ base_ref, base_commit, previous_commit }` plus the remote, the fetched tip and the reason. **Delegated:** its
   event is recorded on the client's newest visible run of the project in that repository; with none there is no event,
   so the fetched value is not trusted by a later failed refresh (fail closed; a run event needs a run and no new table
   is added).
5. **`rebase_session { session_id, expected_head_sha? }`** fetches the base and replays the meta-session's commits onto
   it, controller-side, with `git merge-tree --write-tree --merge-base` and `git commit-tree` in the repository's object
   store: no worktree, no agent environment. It refuses before changing anything on a conflict (with the conflicting
   paths), a moved expected head, an active run, a project that is not remote-backed, and the further **Delegated**
   cases below. On success the new head is the meta-session's `head_commit` (the next run continues from it), the old
   head is kept in a `session_rebased` event, and it returns `{ previous_head, new_head, base_commit, rebased_commits }`.
6. **Both of the session's chains move together** (**Delegated**). The continuation chain (`base_commit..head_commit`,
   the run checkpoints) and the publish chain (`base_commit..<publish ref>`, the controller commits) are both replayed
   onto the fresh base, and `base_commit` becomes that base. Moving only the head would make the next controller commit
   carry the upstream changes as its own diff; moving only the head and the base would break publication's history
   check. Each replayed controller commit gets a `git_commit` provenance row copied from its original (same run,
   provider, sanitiser record), so publication still pushes only controller commits (FR-GIT-08).
7. **Identity and signing.** Authors are kept. Replayed checkpoints get the controller's checkpoint identity as
   committer, as every checkpoint does; replayed controller commits get the primary context's `identity` (FR-GIT-04),
   and without one the rebase is refused `IDENTITY_REQUIRED`. Nothing is signed unless the project requires it; a
   project with `sign: true` and a publish chain is refused `SIGNING_UNAVAILABLE`, because signing needs a run's BR-31
   verdict (ADR-0034), which a session between runs cannot give (fail closed).
8. **Never a push, never a force-push.** `rebase_session` writes only local objects, the publish ref and the ledger. A
   branch `publish_run` pushed before the rebase is not a fast-forward of the rebased chain; the non-forced push is
   refused by the remote and `publish_run` answers `PERMISSION_BLOCKED` `NON_FAST_FORWARD` with a clear message.
   Whether such a branch should be force-pushed (or re-published under a new name) is open (Q-112).
9. **Further refusals** (**Delegated**, fail closed): `REPO_BUSY` while any run of the repository holds a write lease
   (so no other run's ref snapshot sees the publish ref move); `REPO_CONFIG_UNSAFE` when the repository configures a
   merge driver (it would run a program); `MERGE_COMMIT` (replaying merges is not supported); `TOO_MANY_COMMITS` above
   500 per chain; `PUBLISH_HISTORY_UNVERIFIED` when the publish ref holds a commit without a provenance row or is not
   its ledger head; `BASE_REFRESH_FAILED` when the fetch was skipped or failed; `GIT_TOO_OLD` below Git 2.40
   (`merge-tree --merge-base`).
10. **Gated like the other session tools.** Both tools exist only when `serve` wires the base port, and only for a
    client whose ceiling is above `inspect-untrusted` (they write Git objects and refs; never a `console` profile). A
    project is resolved as `search_project_context` resolves it (configured and in the client's list, or the client's
    own dynamic project in force) and a meta-session as `continue_task` checks it (this client and HTTP subject).
11. **`start_run` / `continue_task` `refresh_base: true`** is not added (**Delegated**): a new meta-session already
    fetches, and a continuation can call `rebase_session` first; folding the rebase into admission would put a network
    fetch and refusals on the admission path.

## Consequences

- Every new meta-session of a cloned project starts from the remote's current base without operator action.
- An orchestrator can refresh a long-lived session explicitly, and the next run sees what landed upstream plus the
  session's own work. A session whose branch was already pushed cannot be published again until Q-112 is answered.
- The rebase moves the publish ref outside any run. It is safe against the ref guard only because it runs under the
  worktree serialisation while no run of the repository holds a lease; the next run's LEASED snapshot includes the new
  value.
- Crash safety: the publish ref moves first (compare-and-swap), then one ledger transaction re-checks the session and
  writes the head, base, provenance rows and event; a failed re-check moves the ref back. A crash between the two
  leaves a publish tip without a provenance row, which the commit tool and the push refuse
  (`PUBLISH_HISTORY_UNVERIFIED`); nothing unrecorded is published.
- The rebased checkpoint chain is reachable only from `head_commit` until the next run creates its branch on it, so a
  `git gc --prune=now` by the operator in that window could remove it and the next run would fail to prepare (Q-113).
- Not covered: `https` and `ssh` remotes are not tested (tests use bare `file://` remotes); no live provider or GitHub
  call.
