# ADR-0067: A privileged run may `git add` and `git commit` in its own worktree

- Status: Proposed (built 2026-10-20). Narrows, for `privileged` runs only, the Git-write denial of
  [ADR-0014](0014-tool-only-commits-and-publication.md) decision 1 as enforced by the
  [ADR-0039](0039-switchboard-side-tool-call-guard.md) tool-call guard and the
  [ADR-0027](0027-ref-snapshots-and-violation-handling.md) ref check. Those ADRs are otherwise unchanged.
- Date: 2026-10-20
- Decided by: requested in the operator's task for this change (2026-10-20); the realisation below is Delegated (agent).
  It is not recorded as an owner decision in [ROADMAP §4.2](../ROADMAP.md#42-owner-decisions), and nothing here should
  be read as zemdregon approving more than that task asked for.
- Related: FR-GIT-01, FR-GIT-03, FR-POL-09, owner decision 22, [ADR-0017](0017-approved-privileged-scope-bypass.md),
  [LLD §12.5](../design/LLD.md#125-ref-snapshot-and-violation-handling).

## Context

The tool-call guard classifies every `git commit` a provider's shell tool attempts as a Git write and the run ends
`PERMISSION_BLOCKED`. Privileged agents often commit their finished work in their worktree before they exit. Run
`run_01M5C2EKGX` failed with ``git write attempted: `git commit` can create commits, change refs or push``, so the
meta-session head stayed at the pre-run checkpoint (FRD §4.4) and the finished work only survived as failure evidence,
even though the ref check would have kept the commits as checkpoint content (BR-27).

## Decision

1. **Tool-call guard.** For a run whose resolved profile is `privileged` with a scope binding (the lifecycle passes it
   only after the T3.4 dispatch approval check), `gitWriteInCommand` takes a run scope (worktree root and the shell
   directory followed across the run's tool calls). `git add` and `git commit` are not writes when all of these hold:
   no Git global option before the subcommand (`-C`, `-c`, `--git-dir`, `--work-tree`, ...); no `GIT_DIR`-style
   environment prefix; the shell directory is known and inside the worktree (`cd`, `pushd`, `popd` are followed
   lexically; a dynamic target, `cd` alone, `cd -`, `popd`, `source` or a `cd` behind another command makes it
   unknown persistently (into later calls), while `env -C` or `chroot` makes it unknown for that command only); no word
   names a path outside the worktree (absolute, `~`, or `..` escaping it);
   and for `commit`, no `--amend` (the lexical check cannot tell whether HEAD was created in this run, so every amend
   is refused: fail closed). Every other subcommand is judged exactly as before, so push, fetch, branch, tag,
   update-ref, checkout, switch, reset, rebase, merge, stash and config stay `PERMISSION_BLOCKED`.
2. **Ref check.** For a `privileged` run with a `privileged_dispatch` event, a run-branch tip that strictly descends
   from the run's `pre` checkpoint, with the worktree `HEAD` still the symbolic ref to the run branch, is not a
   violation. A `git_run_commits` event (`ref`, `pre`, `tip`, `commit_count`, at most 50 `commits`) is appended, then
   the run branch is moved back to `pre` with a compare-and-swap that keeps the files and index, and the
   `git_ref_check` event carries `run_commits`. The controller's post-run checkpoint then records the agent's commits
   exactly as it records uncommitted work: one checkpoint commit on `pre`, native-skill paths unstaged, diff against
   `pre`. A tip that does not descend from `pre` (an amend or reset of `pre` or older) and every other ref change stay
   violations, handled as before.
3. **Unchanged.** Non-privileged runs, provider-side deny rules (for example Claude's `--disallowedTools Bash(git
   commit *)`), FR-GIT-06 and the publish ref rules. The agent's own commits are never published as such; only the
   controller's checkpoint and tool commits are.

## Consequences

- A privileged run no longer fails for committing its own work, and that work reaches the meta-session head like any
  other checkpoint content.
- Agent commit messages and authorship are not kept: the checkpoint folds them (Delegated: keeping them would bypass
  the checkpoint's native-skill unstaging and its single-commit history).
- `git commit --amend` of a commit the agent made in this run is also refused by the guard (stricter than the request).
- Providers whose own deny rules still refuse `git commit` in privileged runs are not changed here; whether to compile
  those rules differently for privileged runs is open.
