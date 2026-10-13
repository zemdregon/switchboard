# ADR-0025: `git_commit` and `git_push` tables, publish ref, commit crash ordering and the sanitiser's pattern language

- Status: Accepted
- Date: 2026-10-13
- Decided by: Delegated (agent), under [owner decision 25](../ROADMAP.md#42-owner-decisions) (best practice for a
  decision that does not change what a bypass run may do). Not an zemdregon quote and not owner-approved. Recorded as owner
  decision 32 in the roadmap for traceability only. The tables and the commit steps were already proposed in
  [LLD §1](../design/LLD.md#1-data-model) and [§12.3](../design/LLD.md#123-commit-algorithm-and-refs); this ADR
  records the
  persistence-format change AGENTS.md requires and the mechanisms the LLD left open.
- Related: FR-GIT-04, FR-GIT-07, FR-GIT-08, [ADR-0005](0005-sqlite-ledger.md), [ADR-0006](0006-worktree-checkpoints-no-blind-replay.md),
  [ADR-0014](0014-tool-only-commits-and-publication.md), [ADR-0022](0022-nested-repositories-excluded-from-controller-git.md),
  [ADR-0024](0024-project-id-columns-and-project-snapshot.md), ROADMAP T9.3, R-14, R-45, Q-41, Q-42

## Context

ADR-0014 makes the controller the only author of published commits. T9.3 builds the controller-side part: the tables
that record which run and provider produced each published commit (FR-GIT-07), the ref the commits go onto (FR-GIT-08),
the commit algorithm and the message sanitiser (FR-GIT-04). Four things were open:

1. Git and SQLite cannot share a transaction, and `git_commit` is append-only, so the LLD's "update the ref, then
  insert the
   row and the event in one transaction" leaves a published commit with no provenance if the process dies between the two.
2. LLD §12.3 names the publish ref `refs/heads/<push.branch_prefix><sess>`, but the §11.1 example `branch_prefix:
   "switchboard/"` would put it at `refs/heads/switchboard/<sess>`, which cannot coexist with the run branch
   `refs/heads/switchboard/<sess>/<run>` (a Git ref cannot also be a directory).
3. Operator sanitiser patterns are regular expressions supplied by configuration. Node has no RE2 and cannot time-box a
   synchronous `RegExp` call, so an unrestricted pattern (`(a+)+$`) can hang the controller on an agent-supplied message.
4. Whether to add a dependency (a native RE2 binding) is a technology-stack change.

## Decision

1. **Migration `0003_git_commit`** (`src/ledger/migrations/0003_git_commit.ts`; ledger schema version 3) creates
   `git_commit` and `git_push` with the DDL of LLD §1, `BEFORE UPDATE`/`DELETE` guards on both
   (`<table>_no_update`, `<table>_no_delete`), and two additions the LLD did not list: a unique index
   `git_commit_run_sha` on `(run_id, commit_sha)` (crash recovery re-inserts idempotently) and an index `git_push_run`.
   Forward-only and additive: no existing table changes; an older build refuses a version 3 database through the
   existing "newer than this build supports" rule. `project_revision` is not created (T9.9). ID prefixes `gcm_`
   (`git_commit`, from the LLD) and `gps_` (`git_push`, Proposed here).
2. **Crash ordering: intent, ref update, outcome.** (a) Build the tree and the commit object (unreachable, so harmless if
   abandoned). (b) Append the run event `git_commit_intent`, which carries the whole provenance record (SHAs, ids,
   provider, rule counts; never the message). (c) `update-ref <publish ref> <new> <old>` as a compare-and-swap. (d) In ONE
   ledger transaction append the `git_commit` run event and insert the `git_commit` row (the row's `tool_event_id` is that
   event). A lost compare-and-swap appends `git_commit_aborted` and retries once from the new head (LLD §12.3 step 5); a
   second loss is `PUBLISH_CONFLICT`. `GitPublisher.recover()` resolves each intent that has neither a row nor an abort
   event: if the commit is an ancestor of the publish ref it writes the row (roll forward, the event is marked
   `recovered`), otherwise it appends `git_commit_aborted`. It is idempotent and skips commits in flight in the same
   process; call it once at controller start, before serving. The row is therefore written only for published commits,
   and no published commit stays without one once recovery has run. New `run_event.type` values: `git_commit_intent`,
   `git_commit_aborted` (with `git_commit` from the LLD).
3. **Publish ref.** `refs/heads/switchboard/pub/<sess>` by default (`src/git/publish-ref.ts`). The local prefix is a
   controller setting and is not `push.branch_prefix`, which names the remote branch (LLD §12.6 pushes the publish ref to
   `<branch_prefix><sess>`; T9.6 builds that refspec). Any prefix that would place the ref in the run-branch namespace
   (`switchboard/sess_*`) is refused. A publish commit's parent is the previous publish commit or the meta-session's base
   commit, never a run-branch commit; before moving the ref the algorithm also checks that the new commit adds exactly one
   commit beyond the base and the old head, and refuses otherwise (`PUBLISH_LINEAGE_VIOLATION`).
4. **Sanitiser pattern language.** Operator patterns (`git.sanitize_patterns`, added to the config schema: at most 16, 200
   characters each) are validated by a parser (`src/git/safe-pattern.ts`) to a subset of JavaScript regular expressions:
   no back-references, look-around, named groups or property escapes; no quantifier on a group that contains a
   quantifier or
   (except `?`) an alternation; repeat counts at most 64; at most one unbounded quantifier; and an estimated cost
   `1024^(unbounded+1) x choices` of at most 2^26 steps. Matching is line by line in windows of 1024 characters under a
   one-second budget; exceeding it fails closed (the commit is refused, `SANITISER_FAILED`). Invalid patterns abort config
   load. The subset was chosen from a measurement: `.*a.*b` took 36 seconds on a 4096-character line, so two unbounded
   quantifiers are refused. **No RE2 dependency is added** (it would change the technology stack and add a native build).
5. **Built-in rules** (LLD §12.4 table, extended): `trailer.co-author`, `trailer.generated`, `trailer.session`
   (`Claude-Session:` and vendor-keyed trailers), `trailer.ai-signoff`, `footer.generated-by`, `id.controller` (all
   controller id prefixes), `id.native-session` (exact match, at least 6 characters), `url.session`. They run on an
   NFKC copy with invisible characters stripped, repeat until nothing more is removed, and fail closed if they do not
   converge. The report holds rule ids and counts only.
6. **Effect on bypass mode: none.** This adds no permission, flag, approval or credential handling. The commit is made by
   the controller from a temporary index; it never touches the worktree's index, `HEAD` or run branch, and never signs
   (T9.10).

## Consequences

- The ledger schema version is 3. The migration test upgrades a version 2 database that already has rows.
- The commit library is not yet reachable by an agent: the shim, socket and `COMP-GIT` service are T9.4, which also calls
  `recover()` at start-up and supplies the identity, project and context ids. The commit identity and push policy are
  not yet frozen in the policy snapshot (Q-41).
- A sanitiser pattern outside the subset is rejected even if it would be safe (for example `(a|b)+`); the operator rewrites
  it. Removal of a line is by whole line; token rules (ids, URLs) leave the text around them.
- Lines longer than 1024 characters are matched in windows, so an operator pattern cannot match across a window boundary.
- Residual risk R-14 stands (patterns cannot catch attribution phrased in words they do not describe); R-45 records the
  pattern-language limits.

## Revisit when

An RE2 binding is acceptable as a dependency (then replace the subset), a provider documents a commit or attribution
setting, or T9.6 settles the remote branch naming against Q-42.
