# ADR-0022: Nested repositories are excluded from controller Git calls

- Status: Accepted
- Date: 2026-10-13
- Decided by: Delegated (agent), under [owner decision 25](../ROADMAP.md#42-owner-decisions) (best practice for a
  decision that does not affect bypass mode). Not an zemdregon quote and not owner-approved. Recorded as owner decision 27 in
  the roadmap for traceability only.
- Related: NFR-SEC-03, FR-WS-05, [TDD §3.4](../design/TDD.md#34-security-engineering), ROADMAP Q-31, R-35, T3.8, T3.20

## Context

A run worktree can contain a directory with its own `.git` (a directory, a gitdir-pointer file or a symlink). Once such
a path is a gitlink in the index, controller `status`, `diff` and `add -A` start a child `git status` inside it, which
reads the nested repository's own configuration and `.gitattributes`, so its filter and diff drivers can run as the
operator's user. The controller's `-c` blanking (TDD §3.4) only covers keys configured in the parent. Reproduced on Git
2.43.0 with a benign marker-file filter: `git status`, `git diff HEAD` and `git add -A` each ran it. An untracked nested
repository that is not yet a gitlink was not entered by `status`.

## Decision

1. The controller does not fail the run. Failing would obstruct zemdregon's bypass runs, and the nested repository is
   something the agent may legitimately create.
2. Before each controller Git operation that scans the worktree (`assessMutation`, `finalize`, `rollback` in
   `src/workspace/manager.ts`), `src/workspace/nested.ts` lists every directory below the worktree root that contains a
   `.git` entry of any kind. It runs no Git and never follows symlinks. The worktree root's own `.git` is not nested. A
   nested repository's subtree is not searched further.
3. Each such path is excluded from the operation with a `:(exclude,top,literal)<path>` pathspec (`glob` with escaping
   for a name that is not valid UTF-8, which cannot be passed in argv as is), after `-- .`. `status` and `diff` also
   pass `--ignore-submodules=all`. Git therefore never enters the nested repository.
4. Each skipped path is a non-fatal warning: `nested_repositories_skipped` in the `workspace_assessment` run event and
   in the terminal run payload, only when non-empty. No schema change.

## Consequences

- Files inside a nested repository are not captured in checkpoints, diffs or commits: change detection is weaker there.
  A gitlink entry the run itself had already staged is committed as a pointer only.
- A nested repository that appears between the scan and the Git call is not covered. The provider process has ended
  before finalisation, but nothing enforces that here.
- The controller's other Git calls (`rev-parse`, `worktree`, `branch`, `reset --hard`, `clean -fd`) do not scan the
  worktree for changes and are unchanged. `clean -fd` does not enter nested repositories by default; not re-verified here.
- Unverified: behaviour on other Git versions (reproduced and tested on 2.43.0 only; the documented minimum is 2.30).

## Alternatives considered

- **Fail the run when a nested `.git` appears** (the Q-31 proposal). Rejected: obstructs bypass runs.
- **`diff.ignoreSubmodules=dirty` or `--ignore-submodules` alone.** Rejected: does not cover `add -A` (`git add` has no
  such option on 2.43.0).
- **Enumerate and blank the nested repository's configuration.** Rejected: complex, and it would still read
  attacker-controlled files.

## Revisit when

A real use case needs nested repository contents captured, or a Git release changes pathspec exclusion semantics.
