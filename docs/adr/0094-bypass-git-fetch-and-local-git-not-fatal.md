# ADR-0094: Approved bypass runs may fetch; their own local Git commands do not fail the run

- Status: Accepted (built 2026-10-21). Amends [ADR-0039](0039-switchboard-side-tool-call-guard.md) in part (the
  tool-call guard has a bypass mode) and [ADR-0027](0027-ref-snapshots-and-violation-handling.md) in part (refs an
  agent's own fetch updates are expected, and an approved bypass run's own run-branch and `HEAD` changes are restored
  without a violation). The ADR-0072 follow-up list of local Git verbs gains `pull`. The rest of those ADRs stands.
  Amended in part 2026-10-22 by [ADR-0096](0096-git-guard-reads-and-refused-local-verbs.md): redirections are not
  arguments, the path form of `git checkout` (not only `--`) is `local` in every run, the remote read forms are reads
  in every run, and a guard `write` on a call the provider refused as a local Git verb does not fail the run.
- Date: 2026-10-21
- Decided by: owner ruling of 2026-10-21, relayed in the operator task `fix/bypass-git-read` (Linus, who holds standing
  design authority), for the outcome: Ampere prod runs in bypass, and bypass may act outside its worktree; Git
  commands that only download or read (`git fetch`, `git remote update`, `git ls-remote`, `git pull --ff-only` "if
  safe") are allowed in privileged and bypass runs; pushes, any remote change and commits to protected or base
  branches stay blocked; Switchboard's finalize commit model stays; the agent's own Git commands must not fail the
  run. The mechanism below (which forms count as reads, the `local` verdict, the deny-rule set, the ref-check window,
  leaving `git pull` denied) is **Delegated** (agent, 2026-10-21) and not owner-approved.
- Related: FR-GIT-01, FR-GIT-03, FR-POL-05, [ADR-0017](0017-approved-privileged-scope-bypass.md),
  [ADR-0027](0027-ref-snapshots-and-violation-handling.md), [ADR-0039](0039-switchboard-side-tool-call-guard.md),
  [ADR-0072](0072-recovered-denials-are-warnings.md), [ADR-0091](0091-configured-default-trust-profile-and-unattended-http-privileged.md),
  [LLD §12.5](../design/LLD.md#125-ref-snapshot-and-violation-handling), ROADMAP T9.23.

## Context

Prod runs every request as an approved privileged bypass run (ADR-0091, ADR-0093). Agents there kept ending
`PERMISSION_BLOCKED` on `git fetch`: run_01M5FW49GZP6Q7P42F3D22Z7N8 (Claude Code, bypass scope, shell `broad`, network
`on`) ran `git fetch --dry-run origin`, Claude Code's `--disallowedTools Bash(git fetch *)` rule denied it twice, and
the run failed with "git write attempted: `git fetch` can create commits, change refs or push". Three controls agreed
that a fetch is a Git write:

1. `GIT_WRITE_SUBCOMMANDS` lists `fetch`, `remote` and `pull`, so Claude Code's deny rules refuse them in every run.
2. The tool-call guard (`gitWriteInCommand`, ADR-0039) returns `write` for them, which fails the run in bypass too.
3. A Claude `rule` denial of anything outside the ADR-0072 local-verb list is the security class `git_write`.

A fetch does change refs, but only remote-tracking refs, `FETCH_HEAD` and newly followed tags. It cannot commit,
cannot move a local branch unless a refspec names one, and pushes nothing. In addition the FR-GIT-03 ref check would
report a fetched `refs/remotes/` change as a `git_policy_violation`, which stops the finalize commit and publication
(BR-27), so allowing the command alone would break the finalize model.

## Decision

Only an approved privileged bypass run (`bypassPermitted`: `privileged`, an approved approval with `bypass`, and the
scope's `bypass`) changes. Every other run is exactly as before.

1. **Downloads and reads are not writes.** In bypass mode `gitWriteInCommand(command, { bypass: true })` returns no
   verdict for:
   - `git fetch` with only listed options (`--all`, `--multiple`, `--prune`, `--tags`, `--no-tags`, `--depth`,
     `--jobs`, `--dry-run`, `--recurse-submodules`, ...), a repository that is a remote name, a path, an `https`,
     `http`, `ssh` or `git` URL or `user@host:path`, and refspecs that are plain names (no `:`, no `+`, no pattern);
   - `git remote`, `git remote -v`, `git remote show`, `git remote get-url`, `git remote update [--prune]`;
   - `git ls-remote` without `--upload-pack`.

   Still `write` (fails the run, `PERMISSION_BLOCKED`): a refspec with a destination (`main:main`, which can move a
   base branch), a force `+`, `--force`, `--prune-tags`, `--refmap`, `--update-head-ok`, `--set-upstream`,
   `--prefetch`, `--upload-pack`, an unknown option, another transport (`ext::`), a dynamic word, and every `git
   remote` form that adds, removes, renames, prunes or reconfigures a remote.
2. **`git pull` stays denied.** Even `--ff-only` moves the run branch, which only the controller's checkpoint may move;
   the ref check would restore it and record a violation, and the pulled upstream changes would be recorded as the
   agent's own working-tree changes. That is not safe under the finalize model, so the ruling's "if safe" condition is
   not met. Agents fetch and compare instead (`git fetch origin && git log HEAD..origin/main`). A denied pull does not
   fail the run (item 3).
3. **The agent's own Git commands on its checkout do not fail the run.** In bypass mode a verb whose ref effects stay
   on the run's own checkout gets the new verdict level `local`, which the tool-call guard does not count as a
   violation: `commit`, `merge`, `cherry-pick`, `revert`, `reset` (they move only the current branch, which is the run
   branch), `pull` with a plain repository and branch names (a fetch plus a merge into the run branch), and `checkout`
   in its path form (`git checkout -- <path>`). Claude Code's deny rules still refuse these commands (a `rule` denial
   of them is the recoverable `git_rule_local` class, warning `GIT_RULE_DENIED_RECOVERED`; `pull` joins that list).
   Still `write` (fails the run, `PERMISSION_BLOCKED`): any Git global option with a value (`-C`, `--git-dir`,
   `--work-tree`, ...), `checkout` of a branch (it can move `HEAD` to a base or protected branch that the next commit
   would write) and `-b`/`-B`/`--orphan`, `switch`, `branch` and `tag` other than listing, `stash`, a pull into a local
   branch (`origin main:main`) or with `--force`, options that run a program, every other write subcommand (`push`,
   `send-pack`, `config`, `update-ref`, `symbolic-ref`, `submodule`, `worktree`, `rebase`, `gc`, ...), `gh` and
   `git-<name>` programs. So pushes, remote changes and moves of base or protected branches still fail the run.
4. **Claude Code bypass deny rules.** An approved bypass invocation passes `CLAUDE_BYPASS_GIT_DENY_RULES`: the usual
   rules without `Bash(git fetch)`, `Bash(git fetch *)`, `Bash(git remote)` and `Bash(git remote *)`, plus
   `Bash(git remote <verb>)` and `Bash(git remote <verb> *)` for `add`, `remove`, `rm`, `rename`, `set-url`,
   `set-head`, `set-branches` and `prune`. `git ls-remote` was never denied. Deny rules are lexical and their matching
   is an Assumption (R-26); item 1 is what refuses a fetch into a local branch.
5. **The ref check expects an agent's fetch.** When a run of the same repository whose dispatch recorded an approved
   bypass (`privileged_dispatch` with `bypass_approved: true`; this run or a concurrent one) had not finished at this
   run's LEASED snapshot, a created, moved or pruned `refs/remotes/` ref and a newly created `refs/tags/` ref are not
   violations; their count is recorded as `fetched_refs` in the `git_ref_check` event. A moved or deleted tag, any local
   branch, the publish ref and every other ref are judged as before.
6. **The ref check folds the bypass run's own commits into the finalize commit.** For providers that compile no Git
   deny rules (or if one is bypassed), a `local` verb from item 3 really runs. In the approved bypass run itself, a
   moved run branch and a moved worktree `HEAD` are put back exactly as FR-GIT-03 already does (the run branch to the
   `pre` checkpoint by compare-and-swap, `HEAD` to the run branch; files and index untouched), but recorded in a
   `git_agent_refs_restored` event (intent before effect) and the `git_ref_check` field `agent_restored`, not as a
   `git_policy_violation`. The agent's commits therefore become working-tree content of the controller's checkpoint
   and finalize commit and never enter published history, which is the finalize commit model; without this, the
   violation would stop the finalize commit and every publication of the meta-session (BR-27). A restore that fails is
   a `check_failed` violation (fail closed).
7. **Unchanged:** the controller's commit, checkpoint and push model (FR-GIT-02, FR-GIT-05, FR-GIT-08, FR-GIT-09), the
   pre-push secret scan, worktree isolation, every non-bypass run, and every other adapter's deny rules (only Claude
   Code compiles `GIT_WRITE_SUBCOMMANDS` into deny rules).

## Alternatives considered

- **Allow `git pull --ff-only` and accept the run-branch move.** Rejected (Delegated): the finalize model needs the run
  branch to stay at the `pre` checkpoint until the controller's own checkpoint. A pull would either be restored as a
  violation (which blocks finalize) or record upstream commits as agent changes.
- **Make every Git deny-rule denial recoverable in bypass, pushes included.** Rejected (Delegated): the tool-call guard
  sees the command before the provider denies it and cannot tell whether a push slipped past the provider (a bypass
  agent can reach push credentials, FR-GIT-06 note), so a push attempt stays fatal and visible.
- **Accept `refs/remotes/` changes in every run.** Rejected (Delegated): non-bypass runs cannot fetch, so a change
  there is still a sign that something wrote refs; the window limits the relaxation to times a bypass run was active on
  the same repository.

## Consequences

- A prod agent can `git fetch origin`, compare against `origin/main` and inspect remotes, and its run can SUCCEED and
  be finalized and published.
- A bypass agent's own commit, reset, merge or pull is a warning (Claude Code, denied) or is put back by the ref check
  (other providers), not a failure; the work still lands only through the controller's finalize commit.
- Fixtures and tests that used `git commit` as the example of a fatal Git write in a bypass cell now use `git push`.
- While a bypass run is active on a repository, another run's ref check of that repository does not report
  remote-tracking ref changes or new tags (Delegated trade-off; ROADMAP Q-120).
- Live verification on prod: ROADMAP T9.23.
