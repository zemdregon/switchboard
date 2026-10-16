# ADR-0053: Orphan GC: mark on first sighting in a ledger table, remove after the retention period

- Status: Proposed
- Date: 2026-10-16
- Decided by: Delegated (agent, 2026-10-16, under [owner decision 25](../ROADMAP.md#42-owner-decisions); not
  owner-approved). No effect on bypass runs: this is controller housekeeping of its own worktrees and `switchboard/`
  branches.
- Related: T3.12, FR-WS-07, NFR-DATA-01, R-42, decision 28,
  [LLD §5](../design/LLD.md#5-workspace-and-lease-algorithm), [ADR-0005](0005-sqlite-ledger.md),
  [ADR-0006](0006-worktree-checkpoints-no-blind-replay.md)

## Context

[LLD §5](../design/LLD.md#5-workspace-and-lease-algorithm) says orphans (worktree directories under
`<data_dir>/worktrees/` or `switchboard/*` branches with no matching ledger row) are reported by `doctor` and removed
only by GC after the retention period. T3.12 built the report (`findOrphans`) but not the removal: an orphan has no
ledger row, so there is no timestamp to compare with `retention.days`, and nothing to mark before deleting, which is how
session GC stays crash-safe (R-42, decision 28).

Filesystem or Git timestamps are not a safe age. A directory's mtime changes with its contents and can be set by
whatever runs in it; a branch created by `git worktree add -b` points at an old commit, so its commit date says nothing
about when the branch appeared; reflogs are optional. A run being prepared can also appear as an orphan for a moment.

## Decision

1. **A ledger table records the mark.** Migration 18 adds `gc_orphan (kind, repo_root, target, first_seen_at,
   intent_at, removed_at)`, keyed by `(kind, repo_root, target)`; `kind` is `worktree` or `branch` and `repo_root` is
   `''` for a worktree directory. It is additive; no existing table changes (ADR-0005).
2. **The retention clock starts at the first sighting by a collecting pass** (`gc --apply` or a `serve` GC pass, both
   only when `retention.days` is set). Read-only callers (`doctor`, the `gc` dry run) never write it. Nothing is
   removed on its first sighting, whatever `retention.days` is, so a run caught mid-preparation is never removed.
3. **Same crash-safe order as session GC.** Per pass: one transaction marks new orphans (an orphan that reappears
   after removal starts a new clock) and forgets the mark of a target that is no longer an orphan before its removal
   began. Then, per orphan whose mark is older than `retention.days`: an intent transaction re-checks the ledger
   (the target still has no row) and sets `intent_at`; the removal; then `removed_at`. A row with an intent and no
   outcome rolls forward on the next pass. Worktree directories go first, then `git worktree prune` in each known
   repository, then branches.
4. **Boundaries.** Only branches under `switchboard/` are deleted (`git branch -D`, hardened controller Git); a publish
   ref of a known meta-session is not an orphan. Only directories one or two levels under `<data_dir>/worktrees/` are
   removed; removal is refused when that directory or the session directory is a symlink or not a directory, and a
   symlinked orphan is unlinked, never followed. Removed rows are kept as the record of what was removed.

## Consequences

- Orphans are removed at the earliest `retention.days` after the first collecting pass that saw them, and only on a
  later pass; with the default 24 h interval the delay is up to one interval longer.
- The table grows by one row per orphan ever seen; rows are small and orphans are rare (crashes, manual Git work).
- Residual: the ledger re-check and the removal are not one atomic step. A row written between them for the same
  target would need a reused run or session id (ids are unique), so the window is not exploitable in practice; it is
  not covered by a process-level test.
- Another lane adding migration 18 or ADR-0053 at the same time must renumber on merge.
