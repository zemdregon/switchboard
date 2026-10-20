# ADR-0066: Claude `trusted-development` shell allowlist entries compile as command-prefix rules

- Status: Accepted (built 2026-10-20). Amends the rule form that
  [ADR-0015](0015-claude-untrusted-isolation-flags.md) left as an Assumption, for `trusted-development` only.
- Date: 2026-10-20
- Decided by: Linus decision, Delegated, not owner-approved (agent, 2026-10-20). It does not change bypass runs, the
  Git-write denial or worktree isolation.
- Related: FR-POL-02, FR-GIT-01, [ADR-0015](0015-claude-untrusted-isolation-flags.md),
  [ADR-0039](0039-switchboard-side-tool-call-guard.md), [TDD §4.1.1](../design/TDD.md),
  [ROADMAP T3.5](../ROADMAP.md#65-m3-isolation-tasks).

## Context

The Claude adapter compiled each shell allowlist entry to one `--allowedTools` rule `Bash(<entry>)`. The Claude Code
permissions page (code.claude.com/docs/en/permissions, read 2026-10-20) says "A rule with no `*` matches one exact
command"; `Bash(ls *)` matches `ls` and `ls -la` but not `lsof`, and compound commands are split so that every
subcommand must match on its own. The installed `claude --help` (2.1.294) only gives the example `"Bash(git *)"`.

The operator's `profiles.trusted-development` lists program names (`npx`, `npm`, `node`, `make`, ...). Under
`--permission-mode dontAsk` the exact rule `Bash(npx)` matches only a bare `npx`, so Claude Code denied every call with
arguments. Prod runs `run_01M5BST5DB1MXXSRY3DM3KR1KE` and `run_01M5BST5YTYSQKW0KGPRCWM2F8` (Claude Code 2.1.294)
recorded `npx tsc --noEmit` in `permission_denials`, while `Bash` was in the init event's tools and read-only `sed` and
`grep` calls, which Claude Code approves without a rule, ran. The tool was enabled; the rule form was wrong.

## Decision

1. In `trusted-development`, each allowlist entry compiles to `Bash(<entry>)` and `Bash(<entry> *)`: the entry is a
   command prefix, and the command may take any further arguments. The exact rule is kept beside the documented
   trailing-wildcard form in case an older CLI does not match the bare command with it.
2. An entry whose program is `git` or a `git-` subprogram stays exact (`Bash(<entry>)` only). Appended arguments could
   add a write path: a bare `git` entry passes the lexical Git-write check, and `git grep` could gain `-O<cmd>`.
3. `edit-untrusted` keeps exact rules (SRS: "edits without arbitrary execution"), and so does the `privileged` scope's
   argv allowlist, which LLD §3.1 defines as exact argv.
4. Entry validation is unchanged: no wildcard or shell metacharacter in an entry, and every entry that could write Git
   (FR-GIT-01) still makes the run `Ineligible`.

## Consequences

- An allowlisted program can run with any arguments. For interpreters, build tools and runners (`node`, `npx`, `make`,
  `npm`) that means arbitrary code, including Git run from a script; the provider docs say `npx` is not a stripped
  wrapper, so `Bash(npx *)` matches whatever follows it. That is what the operator's allowlist asks for. The Git deny
  rules still apply to every subcommand Claude Code splits out, and the ADR-0039 tool-call guard and finalize-only
  commits (FR-GIT-09) stay the controls for writes hidden behind a program. The existing `CLAUDE_GIT_WRITE_CONTROL`
  limit ("scripts run by an allowlisted build tool") already covers this.
- An operator who wants an exact command in `trusted-development` cannot express it. **Proposed**, not built: a
  per-entry exact marker if that is ever needed.
- Live behaviour of `Bash(<entry> *)` on 2.1.294 is not shown in this repository. The budgeted live channel runs Claude
  with `--tools ""`, so it cannot exercise a Bash rule. The regression test pins the compiled rules and checks them
  against a matcher written from the documented semantics. The next trusted-development prod run is the live check.
