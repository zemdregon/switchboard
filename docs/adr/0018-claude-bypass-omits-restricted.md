# ADR-0018: Approved Claude Code bypass runs omit `--restricted`

- Status: Accepted; amended 2026-10-13 by [ADR-0021](0021-repository-config-in-approved-bypass-runs.md): decision
  item 2 (`--safe-mode`, `--strict-mcp-config` stay) no longer holds when the scope's `repository_config` is
  `approved` or `enabled`
- Date: 2026-10-13
- Decided by: zemdregon (owner decisions 19, 22), mechanism Delegated (agent, 2026-10-13). zemdregon decided that an approved
  `bypass: true` run on Claude Code omits `--restricted` instead of being `Ineligible` (owner decision 19, answering
  ROADMAP Q-33) and that in bypass runs only the per-scope approval is lifted while Git-write denial and worktree
  isolation stay (owner decision 22). How the adapter expresses this (which flags stay, the conditions below) is
  Delegated and not owner-approved.
- Related: FR-POL-02, FR-POL-03, FR-POL-04, FR-POL-09, FR-GIT-01, FR-WS-05,
  [ADR-0015](0015-claude-untrusted-isolation-flags.md) (partly superseded),
  [ADR-0017](0017-approved-privileged-scope-bypass.md), [TDD §4.1.1](../design/TDD.md#411-claude-code-native-controls-per-profile-and-platform-t30),
  [LLD §3.1](../design/LLD.md#31-privileged-scope-m3), ROADMAP Q-33, R-26, R-38, T3.5, T3.18

## Context

[ADR-0015](0015-claude-untrusted-isolation-flags.md) compiles Claude Code runs with `--safe-mode --restricted
--strict-mcp-config`. The installed `claude --help` (2.1.296, the T3.0 spike, [TDD
§4.1.1](../design/TDD.md#411-claude-code-native-controls-per-profile-and-platform-t30)) says that `--restricted`
"refuses bypassPermissions", and that it "ignores user, project and local settings files", removes the built-in tools
that run commands or code unless `--tools` names them, confines the file tools to the working directories and "lets
only a person or the configured permission handler approve writes to settings, git and tool-configuration files".

[ADR-0017](0017-approved-privileged-scope-bypass.md) allows a provider bypass flag only for an operator-approved
`privileged` scope that sets `bypass: true` (owner decision 13). On Claude Code those two cannot be combined: a bypass
run with `--restricted` is refused by the CLI. ROADMAP Q-33 asked whether such a run should be `Ineligible` or drop
`--restricted`; the Proposed default was `Ineligible`. zemdregon answered on 2026-10-13 (owner decision 19): drop
`--restricted`, keep the other isolation flags. Owner decision 18 records why: bypass runs are meant to be loose, for
zemdregon's own workloads, and the restrictive defaults remain for everyone else.

## Decision

1. For a `privileged` run whose resolved profile has `bypassApproved: true` (an `APPROVED` approval whose hashes match
   and whose scope sets `bypass: true`, [LLD §3.1](../design/LLD.md#31-privileged-scope-m3) "Bypass"), the Claude
   adapter omits `--restricted`. It is omitted only in that case; every other Claude invocation, including a
   `privileged` run without bypass, keeps the ADR-0015 flags unchanged.
2. The other isolation flags stay (`--safe-mode`, `--strict-mcp-config`), as do the explicit tool lists; how each
   scope dimension maps onto them is the adapter's T3.5 matrix. `--bare`, `--settings`, `--setting-sources` and
   `--mcp-config` stay forbidden as in ADR-0015.
3. The FR-GIT-01 Git deny rules (`--disallowedTools`) are still emitted on every bypass invocation (owner decision 22).
   Whether Claude Code honours them under its bypass mode is unverified (R-38).
4. The run still works in its own worktree (FR-WS-05); nothing in this ADR changes the workspace.
5. The bypass flag itself passes the argv audit only under the T3.17 conditions (ADR-0017 decision item 5).

This partly supersedes ADR-0015: its decision ("compiles ... with `--safe-mode --restricted --strict-mcp-config`")
no longer holds for approved bypass runs. ADR-0015's status line is updated accordingly; its decision text is not
edited.

## Alternatives considered

- **`Ineligible: PROFILE_UNSUPPORTED` for privileged with bypass** (the Q-33 Proposed default). Rejected by owner
  decision 19: Claude Code could then never run a bypass scope, which is the mode zemdregon wants for his own workloads.
- **Keep `--restricted` and omit the bypass flag.** Rejected: it silently narrows what the operator approved, against
  FR-POL-02 (no silent downgrade), and gives a run that stalls on approvals nobody answers.
- **Drop all three isolation flags in bypass runs.** Rejected: owner decision 19 keeps "the other isolation flags", and
  `--safe-mode` and `--strict-mcp-config` do not conflict with bypass according to the help text.

## Consequences

- An approved Claude bypass run loses what `--restricted` gave: user, project and local settings files may load, the
  file tools are no longer confined to the working directories by that flag, and writes to settings, Git and
  tool-configuration files are no longer reserved for a person or the permission handler. With the provider's bypass
  active, nothing in Claude Code asks before such writes.
- If the `--disallowedTools` Git deny rules do not hold under bypass, FR-GIT-01 is not enforced for these runs and only
  FR-GIT-03 (ref snapshot and violation detection, M9) and FR-GIT-06 (no Git credentials in the agent environment)
  remain (R-38). The live check C-G2 in `scripts/live-smoke.mjs` must be extended to a deliberate Git write in an
  approved bypass run (T3.9) before that is known.
- The adapter's compile matrix ([TDD §4.1.1](../design/TDD.md#411-claude-code-native-controls-per-profile-and-platform-t30),
  T3.5) gains a compilable bypass cell; the controller already hands it `bypassApproved` only from the approval
  verdict (T3.18).

## Revisit when

The live bypass check shows the Git deny rules do not hold (then make Claude bypass runs `Ineligible` again, or rely on
FR-GIT-03 once M9 lands), a Claude release lets `--restricted` coexist with a bypass mode, or zemdregon revises decision 19.
