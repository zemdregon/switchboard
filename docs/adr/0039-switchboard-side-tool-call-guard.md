# ADR-0039: Switchboard-side tool-call guard, provider-state reach and repository agent config refusal

- Status: Proposed.
  Amended in part 2026-10-22 by [ADR-0096](0096-git-guard-reads-and-refused-local-verbs.md): a `git_write` verdict on a
  call the provider itself refused as a local Git verb does not fail the run, and every adapter fails a flagged call
  the provider did not refuse.
- Date: 2026-10-14
- Decided by: Delegated (agent, 2026-10-14, at the orchestrator's request), under [owner decision
  25](../ROADMAP.md#42-owner-decisions) for everything outside bypass mode. Not a zemdregon quote and not
  owner-approved. Nothing here restricts what an approved bypass run may do beyond the Git-write denial the owner
  already keeps (ADR-0017).
- Builds on: [ADR-0014](0014-tool-only-commits-and-publication.md) (Git writes only through controller tools),
  [ADR-0027](0027-ref-snapshots-and-violation-handling.md) (ref snapshot backstop),
  [ADR-0037](0037-argv-audit-short-flags-and-bypass-values.md) (argv audit limits). It does not change them.
- Related: FR-GIT-01, FR-GIT-03, FR-AUTH-01, FR-POL-04, FR-POL-08, NFR-SEC-01, NFR-PRIV-02, ROADMAP
  [Q-62 to Q-65](../ROADMAP.md#73-open-questions-for-zemdregon-not-blocking-m2-unless-noted).

## Context

The 2026-10-14 operator live checks found four places where a provider's own control did not hold (all four notes are
in `docs/research/live-checks-2026-10-14-*.md`):

- Grok Build 1.0.50: the Git-write deny rule `Bash(git commit*)` is a prefix match on the command string, so
  `git -C . commit` and `/usr/bin/git commit` created commits; `~/.grok/auth.json` was listable and `test -r` succeeded
  from inside `--sandbox strict` and `workspace`.
- Antigravity `agy` 1.3.4: a repository's `.agents/mcp_config.json` stdio server and `.agents/hooks.json` hook ran under
  `agy -p` at default settings with no approval.
- OpenCode v2.0.23: `OPENCODE_PERMISSION='{"*":"deny"}'` did not deny a `read` call, and shell commands including
  `git commit` ran with no prompt.
- Cursor 2026.10.12: edits apply without `--force`, a refused shell call still ends `success` with exit 0.

The shared point is that a provider's deny rule, sandbox, trust prompt or environment setting is the provider's claim,
not a Switchboard control. The adapters for these providers do not exist yet, so the fix is in the layer every adapter
already goes through.

## Decision

1. **A tool-call guard in `startAdapterRun`** (`src/adapters/tool-guard.ts`). Each `tool_call` event may carry the
   command line of a shell tool (transient `command`; for Codex, its `target`). Switchboard parses it into words
   (`gitWriteInCommand`, `src/adapters/git-write.ts`) and sets `violation` on the event; the transient text is dropped
   before the event is stored. Matching is on parsed words, not a string prefix: program paths, Git global options
   (`-C`, `--git-dir`, ...), `NAME=value` prefixes, launchers (`env`, `timeout`, `sudo`, `xargs`, ...), `sh -c` and
   `eval`, compound lines and `$(...)` are all handled.
   - `git_write`: a known Git write path. Enforced in every run, bypass included. The run ends `PERMISSION_BLOCKED`
     (`git write attempted`). This is detective for the call itself (the provider already ran it) and fail-closed for
     the run; the FR-GIT-03 ref snapshot still restores and reports the refs.
   - `provider_state`: the call names a path under a provider config or credential directory
     (`src/policy/provider-state.ts`). Enforced in every run except an approved bypass run. Ends `SANDBOX_VIOLATION`.
   - `uncertain` Git verdicts (dynamic program, unknown subcommand that may be an alias, `gh`) do not fail a run; they
     are visible to callers of `gitWriteInCommand` and left to the ref snapshot.
2. **Provider state stays out of reach by construction.** A run whose working directory is inside, or contains, a
   provider state directory (`~/.grok`, `~/.claude`, `~/.codex`, `~/.cursor`, `~/.gemini`, `~/.opencode`) is refused
   before spawn (`PROVIDER_STATE_REACHABLE`). A sandbox profile is not relied on for this.
3. **Repository-local agent config is refused while `repoConfig` is `disabled`** (`src/policy/repo-agent-config.ts`).
   A worktree containing a provider's repo-local MCP or hook config (table per provider, from the live checks) does not
   start (`REPO_AGENT_CONFIG_REFUSED`, `PERMISSION_BLOCKED`). An approved privileged scope with
   `repository_config` `approved` or `enabled` lifts the refusal. Claude Code and Codex are not listed: their adapters
   already isolate repo config with flags.
4. **Provider deny rules are defence in depth, never the declared control.** When the Grok, OpenCode or Cursor adapter
   is written, its `gitWriteControl` may not name its own deny rule as the control; the guard, the audit and the ref
   snapshot are. Environment variables such as `OPENCODE_PERMISSION` are not a control either (ADR-0037 limits).
5. **Where a native control is not shown to hold, the profile is `Ineligible`, not downgraded.** See Q-62 to Q-65 for
   the per-provider answers.

## Consequences

- Positive: each escape has a Switchboard-side test with fakes and canary strings
  (`src/adapters/tool-guard.test.ts`); no provider CLI or credential file is used.
- Positive: a provider that ignores its deny rules still ends the run failed and flagged.
- Negative: the guard sees only what the adapter surfaces. A Claude or Codex run is covered; ACP tool calls carry no
  command text today, so they are not (Assumption, to be revisited with the adapter that uses ACP).
- Negative: it is lexical. Scripts and interpreters (`python -c`, `make`, `npm test`) and glob or variable expansion
  can still do what the words do not show. The filesystem boundary (container environment, FR-PRJ-05) and the ref
  snapshot are the controls there.
- Negative: a model that merely mentions `git commit` in a shell argument it does not run (`echo git commit`) is
  parsed as an `echo`, which is correct; `git commit` as an argument to an unknown wrapper is not seen.
- Positive (2026-10-14, Delegated): the two pre-spawn refusals are tested through `RunLifecycle` with the fake CLI
  (`src/lifecycle/lifecycle.test.ts`, "pre-spawn refusals"): each ends the run `FAILED` / `PERMISSION_BLOCKED` with
  `PROVIDER_STATE_REACHABLE` or `REPO_AGENT_CONFIG_REFUSED`, no pid and no `RUNNING` state, and an approved scope with
  `repository_config` `approved` or `enabled` is admitted. The tests found one wiring bug, fixed in the same change: a
  privileged snapshot records `repoConfig: "scoped"`, so the check never refused a privileged run, including one whose
  approved scope says `repository_config` `disabled`. The effective value now comes from the scope
  (`effectiveRepoConfig`, `src/policy/repo-agent-config.ts`; an unmapped mode fails closed to `disabled`).
- Positive (2026-10-20, Linus decision, Delegated, not owner-approved): two false positives that failed real runs
  `PERMISSION_BLOCKED` are fixed in `gitWriteInCommand`. Behind a launcher, a `git-` word with a file extension other
  than `.exe` (`timeout 600 npx vitest run src/cli/git-push.test.ts`) is an argument, not a Git subprogram; a `git-`
  word in program position is still refused. The listing forms of `git branch` (bare, `--show-current`, `--list`/`-l`,
  `-a`, `-r`, `-v`, `--contains`, `--merged`, `--points-at`, `--sort`, `--format`, ...) are read-only; a positional
  name outside list mode, any other or abbreviated option, and a name after `--` stay `git_write` (create, delete,
  move, copy, force, upstream, description). A glob or variable argument is `uncertain`. The shell-allowlist check
  (`gitWriteRisk`) is unchanged: `git branch` in any form is still refused there. Tests: `src/adapters/git-write.test.ts`,
  `src/adapters/git-write-detector.property.test.ts` and `src/adapters/tool-guard.test.ts` (a credential read beside an
  allowed `git-` path or read-only `git branch` is still refused as `provider_state`).
- Negative: both refusals are lexical (`lstat` on the listed paths; resolved paths, symlinks not followed), run after
  the adapter's compile, and use `HOME` from the lifecycle's `baseEnv` (the process environment by default).

## Revisit when

- A live check shows a provider path not in the tables, or an ACP provider that exposes the command text.
- An adapter for Grok, Antigravity, OpenCode or Cursor lands: its tests must show the guard firing on its own event
  shape.
