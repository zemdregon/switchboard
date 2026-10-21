# ADR-0090: Claude `trusted-development` compiles a `broad` shell

- Status: Accepted (built 2026-10-21). Narrows the Q-34 refusal (owner decision 25, Delegated) for
  `trusted-development` on Claude Code only; [ADR-0066](0066-claude-trusted-development-allowlist-prefix-rules.md)
  (prefix rules for an allowlist) is unchanged and still applies when the operator keeps an allowlist.
- Date: 2026-10-21
- Decided by: Delegated agent work on an operator task (2026-10-21, branch `fix/trusted-dev-bash-denied`), not
  owner-approved. The goal ("`trusted-development` runs on every provider and model can use Bash, Write and Edit inside
  their own worktree") is the task's; the mechanism and the details marked **Delegated** were chosen while building it.
  It does not change bypass runs, the Git-write denial or worktree isolation.
- Related: FR-POL-02, FR-POL-05, FR-GIT-01, FR-GIT-09, R-36, Q-34, Q-17,
  [ADR-0015](0015-claude-untrusted-isolation-flags.md), [ADR-0033](0033-claude-channel-bypass-only-without-safe-mode.md),
  [ADR-0039](0039-switchboard-side-tool-call-guard.md), [ADR-0066](0066-claude-trusted-development-allowlist-prefix-rules.md),
  [ADR-0072](0072-recovered-denials-are-warnings.md), [TDD §4.1.1](../design/TDD.md),
  [ROADMAP T3.27](../ROADMAP.md#65-m3-isolation-tasks).

## Context

`trusted-development` runs had Bash denied, and tests never ran. The report said Sonnet runs were denied and Opus runs
were not. The prod ledger and the stored Claude streams (read only, 2026-10-21) show something else:

- Both models were denied. Sonnet: `run_01M5D74KSXB5VVC4FZD0D3Q92C`, `run_01M5D1YRABBYPBGFGWZGZHT18C`. Opus:
  `run_01M5D03ET12TRSYNJPTFH0V7MY`, `run_01M5F25ZM59DMECMVFPVWKWHNM`, `run_01M5F5H1RQJC41DEE7E1PFJMDW`. Every one had
  the same init event (tools `Bash,Edit,Glob,Grep,Read,Write`, `permissionMode` `dontAsk`, Claude Code 2.1.294). The
  adapter has no per-model permission mapping: `--model` is the only argv word that depends on the model.
- The denied commands were ordinary shell: `for` loops, `node t.mjs; echo EXIT $?`, `${PIPESTATUS[0]}`, `$(...)`,
  pipes into unlisted programs (`cut`, `awk`, `tee`), `rm`, `timeout`, `pnpm`, `gh`, `patch`, a `python3 -` heredoc,
  and `git log`, `git branch -a` and `git status` (no `git` prefix rule exists, by ADR-0066 item 2). Under
  `--permission-mode dontAsk` Claude Code denies any command that its rule matcher cannot match to an allow rule,
  part by part. A command-prefix allowlist cannot admit loops or expansions, so how often a run was denied depended
  on how the model wrote shell, not on which model it was.
- The six switchboard gap-fix runs of 2026-10-20 (04:17 to 04:41) failed on the exact `Bash(npx)` rules that
  ADR-0066 has since fixed, on a `Write` to `/tmp` (outside the worktree; `--restricted` confinement, intended), and on
  Git verbs the tool-call guard counts as writes (`git checkout`, `git fetch`).

The operator's `profiles.trusted-development` lists interpreters and build tools (`node`, `python3`, `npm`, `npx`,
`make`, `cargo`, `go`). ADR-0066 already records that such entries run arbitrary code, network use included (R-36).
The allowlist therefore did not narrow what a run could do; it only denied ordinary shell syntax.

## Decision

1. **`trusted-development` with `shell: broad` compiles for Claude Code** on a writable worktree with network `off` and
   repository configuration `disabled`: `Bash` in `--tools` and the allow rule `Bash` in `--allowedTools` (the form the
   `privileged` non-bypass cell already uses), with every other flag unchanged: `--safe-mode --restricted
   --strict-mcp-config`, `--permission-mode dontAsk --permission-prompts none`, no `WebFetch`, and the full FR-GIT-01
   `--disallowedTools` Git deny rules.
2. **Refusals kept (Delegated, fail closed):** `broad` with file access `read-only`, or on a read-only workspace, is
   `Ineligible: CAPABILITY_MISSING` (nothing in the help stops a command writing files), as in the `privileged` cell.
   Network `allowlist` or `policy` and repository configuration other than `disabled` stay refused as before.
3. **Network `off` is tool-level only** in this cell: no `WebFetch`, but a shell command can reach the network. It was
   already so for allowlisted interpreters (R-36); `list_capabilities`, the TDD matrix and the security guide say so.
   Q-34's refusal stays for every other Claude profile.
4. **Git stays with Switchboard.** No commit channel (ADR-0033: bypass runs only), the Git deny rules, the tool-call
   guard (ADR-0039) and the FR-GIT-03 ref check are unchanged, and the run's work is committed on its run branch by the
   finalize commit (FR-GIT-09). An agent that runs `git commit`, `git push` or `git fetch` is still denied and its run
   still fails; ADR-0072 is unchanged.
5. **Prod configuration:** `profiles.trusted-development` becomes `{ "file_access": "worktree", "shell": "broad" }`.
   That also makes Codex eligible for `trusted-development` (it compiles only `broad`, inside `--sandbox
   workspace-write`). The other providers stay `PROFILE_UNSUPPORTED` for every non-`privileged` profile, so routing
   never sends them a `trusted-development` run.
6. **Defaults unchanged.** The built-in `trusted-development` default stays the Q-17 strictest reading (empty
   allowlist); `broad` is an explicit operator loosening (owner decision 12) and appears in `doctor` and every run's
   policy snapshot.

## Consequences

- A Claude `trusted-development` run with `broad` can run tests, loops and Git reads, and Edit and Write files in its
  worktree, for every model. The regression tests (`src/adapters/trusted-development-shell.test.ts`, the Claude compile
  matrix and the routing matrix) pin that the compiled policy is the same for Sonnet, Opus, other model families and no
  model.
- What a run can do is unchanged in practice for an operator whose allowlist already named an interpreter. For one whose
  allowlist named only inert programs, `broad` is a real loosening, which is why it is an explicit setting, not a
  default.
- The ADR-0072 warnings stay. With `broad` they should now come only from Git deny-rule hits on reads (`git branch -a`),
  and with an allowlist from unlisted commands.
- Not covered here: a per-run sandbox for Claude's commands (R-10; the help documents none, and `--settings` is barred
  by ADR-0015), and a fixed prompt rule telling agents that Git writes are refused (runs still fail when an agent tries
  `git fetch` or `git commit`). Both are possible follow-ups.
