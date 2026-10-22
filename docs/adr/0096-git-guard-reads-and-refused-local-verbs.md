# ADR-0096: Git guard reads redirections, path checkouts and remote reads; refused local Git verbs do not fail runs

- Status: Accepted (built 2026-10-22). Amends [ADR-0039](0039-switchboard-side-tool-call-guard.md),
  [ADR-0072](0072-recovered-denials-are-warnings.md) (follow-up) and
  [ADR-0094](0094-bypass-git-fetch-and-local-git-not-fatal.md) in part, as listed under Decision. The rest of those
  ADRs stands.
- Date: 2026-10-22
- Decided by: operator task (gap fix for the whumpo-website runs below): "allow read-only git invocations (branch
  listing/show-current, checkout of a file path or `--` pathspec, remote -v, fetch handled by the controller) while
  still denying ref/HEAD-moving writes and pushes; when a run is blocked after it has already committed, preserve the
  work so the run can still be finalized/published; do not weaken pushes, force, or default-branch protections". The
  mechanism below is **Delegated** (agent, 2026-10-22) and not owner-approved.
- Related: FR-GIT-01, FR-GIT-03, FR-POL-05, [ADR-0017](0017-approved-privileged-scope-bypass.md),
  [ADR-0039](0039-switchboard-side-tool-call-guard.md), [ADR-0072](0072-recovered-denials-are-warnings.md),
  [ADR-0094](0094-bypass-git-fetch-and-local-git-not-fatal.md), [LLD §2](../design/LLD.md#2-adapter-contract),
  [LLD §4](../design/LLD.md#4-failure-taxonomy), ROADMAP T9.25.

## Context

After ADR-0094, approved bypass Claude Code runs of project `whumpo-website` (model `claude-opus-5-5`) still ended
`PERMISSION_BLOCKED` after doing their work and committing it through the commit tool:

- run_01M5HQZFRQRAPRE79SY8W9CNX8: "git write attempted: `git checkout` of a branch can move HEAD to, or create, another
  branch". The agent tried to discard a build-rewritten file (`git checkout public-app/visitor.js`, the path form
  without `--`). Claude Code's deny rule refused it (`git_rule_local`), the ref check was `clean`, and the run's commit
  was rolled back with the run.
- run_01M5GWDZ0TMT2NN8KBY3FH61WS: "git write attempted: `git branch <name>` creates a branch".
- run_01M5GS0H1QDMQHB9DETCXW6ZVC: "denied: Bash". The guard flagged nothing; the blocking evidence was security-class
  (`git_write`) deny-rule denials of read-only `gh` commands (the agent reported "`gh` was denied" while trying to read
  a pull request's checks).
- earlier runs failed on `git fetch` (fixed by ADR-0094).
- run_01M5HVJMG9M3G35W5BF0GM40ND (project `switchboard`, the first attempt at this fix): "git write attempted: `git
  fetch` argument `2>` is not a plain remote or branch" for the agent's own `git fetch origin 2>&1 | tail`, cause 1
  below. Its commit was never published.

Reading the guard (`gitWriteInCommand`, `src/adapters/git-write.ts`) showed four causes:

1. **Redirections were arguments.** The splitter kept `2>/dev/null` as a word and split `2>&1` at `&`, so `git branch
   --show-current 2>/dev/null` and `git branch -a 2>/dev/null | head` read as `git branch <name>` ("creates a branch"),
   and `git fetch origin 2>&1 | tail` as a fetch with an unknown argument `2>`.
2. **Every `git checkout` outside `--` was a branch checkout**, although `git checkout <path>` and `git checkout
   <tree-ish> <path>...` only rewrite files; `git remote -v` was a write outside bypass.
3. **The guard judges the attempt, not its effect.** It never stops a provider; it only labels the outcome when the run
   ends. A command Claude Code's deny rule refused never ran, yet its `write` verdict failed the run, whatever the ref
   check found. The finalize path then rolled the meta-session back (FRD §4.4), so the commit-tool commits of the run
   were not published.
4. **A denied read-only `gh`** (`gh pr view`, `gh pr checks`, `gh run view`) was security-class, like `gh pr create`.

**Why Claude Code runs report `denied: Bash`, on Opus as on any model.** The denial does not come from the model: the
adapter passes the FR-GIT-01 Git deny rules with `--disallowedTools` on every invocation, bypass included
(`CLAUDE_GIT_DENY_RULES`, `CLAUDE_BYPASS_GIT_DENY_RULES`: `Bash(git <write verb> *)`, the global options with a value,
and `Bash(gh)` / `Bash(gh *)`), and outside bypass `--permission-mode dontAsk` denies any command no allow rule admits.
Claude Code applies those rules before the command runs and reports a `permission_denied` event whatever model is
selected. When the denial's class is security-class or unknown (a `gh` command, a command chained with a Git write, a
denial in `result.permission_denials` with no decision reason), `classifyCommon` failed the run with the detail
`denied: <tool>`: the tool name of the *first* denial (often a recovered `profile` one) and nothing else. Because event
storage drops the command line (ADR-0039, NFR-PRIV-02), the run history could not say which command was refused.

Investigating also found a gap in the other direction: Claude Code and the fake adapter (JSONL mode) judged guard
violations only when the run also had a `permission_denied` event, and Codex never looked at them, so a flagged Git
write the provider did not refuse (R-26) ended as a success there.

## Decision

1. **Redirections are not arguments of the Git verdict.** `splitSimpleCommands(command, { redirections: "drop" })`
   drops unquoted redirections and their target (`>`, `>>`, `>|`, `<`, `<<`, `<<<`, `<>`, `>&N`, `N>`, `&>`); a target
   that contains a substitution is kept as a word, and a substitution after the operator (`>$(git push)`) is still a
   command of its own. Only `gitWriteInCommand` uses it; the provider-state check keeps redirect targets (`cat >
   ~/.claude/x`). The deny-rule classifier is unchanged (a redirect word is never an option there).
2. **Read forms in every run.** `git checkout` in its path form is the non-fatal verdict `local` in every run: options
   only from a fixed list (`-q`, `-f`, `--ours`, `--theirs`, `-m`, `--conflict=`, `-p`, `--overlay`, `--no-overlay`,
   `--progress`, `--ignore-skip-worktree-bits`) and either `--` with at least one path, two or more positional words
   (Git reads the first as a tree-ish), or one word that cannot be a ref name or names a file (`.`, `./x`, `x/`, a
   component starting with `.`, `..`, `.lock`, a last component with an alphabetic extension such as `visitor.js`).
   `git checkout main`, `release/1.2`, `HEAD~1`, `-b`, `-B`, `--orphan`, `--detach`, `--track`,
   `--recurse-submodules`, a dynamic word and any Git global option with a value stay `write`. `git remote`, `git remote
   -v`, `git remote show` and `git remote get-url` are reads in every run; `git remote update` stays bypass-only
   (ADR-0094) because it fetches.
3. **A denied read-only `gh` is recoverable.** `gitDenyRuleSecurityReason` treats `gh pr view|list|checks|diff|status`,
   `gh issue view|list|status`, `gh run view|list`, `gh repo view`, `gh release view|list`, `gh workflow view|list` and
   `gh status` as local, so a deny-rule denial of them is `git_rule_local` (warning `GIT_RULE_DENIED_RECOVERED`).
   `gh api` (any method), `gh pr checkout`, `gh repo clone`, `gh auth`, every create, edit, merge, close or comment form,
   `--web`, `--show-token`, a dynamic word and `gh` behind a launcher stay security-class. The deny rules themselves
   are unchanged: `gh` is still refused.
4. **A refused local Git verb does not fail the run.** `tool_call` and `permission_denied` events carry the provider's
   call id as `callId` (Claude Code `tool_use.id` / `tool_use_id`), in memory only; `compactEvent` never stores it. A
   guard `git_write` violation whose call the provider reported refusing with denial class `git_rule_local` (every Git
   invocation in it a read or a local ref verb per the ADR-0072 follow-up: never a push, remote change, configuration,
   `gh` write or `-C`/`--git-dir` redirect) is not blocking: the command never ran and its denial is already a
   recovered warning. The run then succeeds with that warning, is finalized and can be published. The backstops stay:
   had the command run, its only effect is on refs the FR-GIT-03 ref check sees, and a ref change in a run with
   recovered denials still fails it (ADR-0072, `denied: <tool>; git refs changed`). A violation with no matching
   refusal, a security-class refusal, a `provider_state` violation and a call without an id still block.
5. **Flagged calls block in every adapter.** Claude Code and the fake adapter judge `recoveredDenialWarnings` whenever
   a denial or a guard violation exists (`hasDenialOrViolation`), and Codex's clean-success test excludes a flagged
   `tool_call`, as the other adapters already did. A flagged `git push` the provider did not refuse now fails the run
   with `PERMISSION_BLOCKED`.
6. **The failure detail names what was denied.** A `permission_denied` event carries an in-memory `detail` (never
   stored as an event; `compactEvent` keeps only the kind and class), built by `deniedCommandSummary`
   (`src/adapters/git-write.ts`) from the command Claude Code's `tool_use` carried: for each of the first three simple
   commands, the program's name and, for `git`, its subcommand, for `gh`, its group and verb, then, for a security-class
   Git deny-rule denial, the reason `gitDenyRuleSecurityReason` gives. Only words matching a short-name pattern
   (`-{0,2}[A-Za-z][A-Za-z0-9.-]{0,23}`) are shown, anything else (paths, URLs, values, tokens) as `…`, so no argument
   value reaches the ledger. `classifyCommon` reports the first denial whose class is not recoverable (else the first)
   as `denied: <tool> (<class>: <summary>)`, for example ``denied: Bash (git_write: `gh pr create`: `gh` can push to a
   Git host)``.
7. **Unchanged.** Every deny rule (Claude Code still refuses `git checkout`, `git branch`, `git switch`, `gh`, pushes),
   the ADR-0094 bypass forms, push, force and remote-change verdicts, Git global options with a value, the ref check,
   the finalize commit and rollback model, and worktree isolation. Creating, moving or deleting a branch or tag,
   `git switch`, `git stash` and `git checkout <branch>` stay `write`: they fail the run unless the provider refused
   them, and if one ran the ref check reports it.

## Alternatives considered

- **Make `git checkout <word>` always `local` in bypass**, relying on the ref check to put `HEAD` back. Rejected
  (Delegated): the task keeps `HEAD`-moving checkouts denied, and ADR-0094's tests pin `git checkout main` as fatal.
- **Ask the file system whether the word is a path.** Rejected: the guard is lexical by design (ADR-0039); a deleted
  file being restored does not exist, and a lookup races with the agent.
- **Keep the run's work on a guard failure** (leave the meta-session head at the post-run checkpoint instead of rolling
  back). Rejected for now (Delegated): it changes the FRD §4.4 disposition of every failed run, and with items 1 to 4
  the observed blocks no longer fail. A push or remote-change attempt stays fatal with its run rolled back, as the owner
  requires (ADR-0017, ADR-0094); the run's commits remain on the session's publish ref and in the evidence checkpoint
  (ROADMAP Q-121).
- **Recover every refused Git command, pushes included.** Rejected: owner policy keeps push attempts fatal and
  visible (ADR-0094 alternatives).

## Consequences

- The three whumpo-website failure shapes above succeed with `GIT_RULE_DENIED_RECOVERED` warnings, and their
  commit-tool commits are finalized and publishable.
- `git checkout <file>`, `git branch --show-current 2>/dev/null`, `git fetch origin 2>&1 | tail` (bypass) and `git
  remote -v` no longer fail any run.
- Claude Code and Codex runs whose provider let a flagged Git write through now fail where they used to succeed.
- The path heuristic can read a branch named like a file (`fix.js`) as a path; the ref check backs that up (`HEAD` is put
  back: without a violation in an approved bypass run, as a violation otherwise).
- A `PERMISSION_BLOCKED` run from a Claude Code denial says which command was refused and why, without storing the
  command line.
- Live verification on prod: ROADMAP T9.25.
