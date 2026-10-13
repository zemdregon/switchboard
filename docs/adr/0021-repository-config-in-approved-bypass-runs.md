# ADR-0021: Approved bypass runs may load repository configuration

- Status: Accepted (the decision); the Claude flag behaviour is unverified until the T3.9 live check (R-41)
- Date: 2026-10-13
- Decided by: zemdregon (owner decision 26, answering ROADMAP Q-37: "bypass mode allow all agents to make the changes").
  The split between `approved` and `enabled` and the flag mapping below are Delegated (agent, 2026-10-13) and not
  owner-approved.
- Related: FR-POL-02, FR-POL-03, FR-POL-04, FR-GIT-01, FR-WS-05,
  [ADR-0015](0015-claude-untrusted-isolation-flags.md), [ADR-0017](0017-approved-privileged-scope-bypass.md),
  [ADR-0018](0018-claude-bypass-omits-restricted.md) (amended), [TDD §4.1.1](../design/TDD.md#411-claude-code-native-controls-per-profile-and-platform-t30),
  [LLD §3.1](../design/LLD.md#31-privileged-scope-m3), ROADMAP Q-37, R-38, R-41, T3.9, T3.19

## Context

A `privileged` scope's `repository_config` is `disabled`, `approved` or `enabled` (LLD §3.1). Both adapters refused
`approved` and `enabled` (T3.5, T3.6): for Claude Code, `claude --help` 2.1.296 documents `--safe-mode` as disabling
"CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands/agents" and `--strict-mcp-config` as "only MCP servers
from --mcp-config", with no per-item control. ADR-0018 kept both flags in bypass runs. Q-37 asked whether `enabled`
should compile for approved scopes. zemdregon answered that bypass mode should allow all agents to make the changes.

## Decision

1. In an approved bypass run (profile `privileged`, scope `bypass: true`, the run's `bypassApproved`), `repository_config`
   `approved` and `enabled` compile.
2. Claude Code: the invocation omits `--safe-mode` for both modes. `approved` keeps `--strict-mcp-config` (repository
   MCP definitions do not load); `enabled` omits it (they can load). The flag set is the exported
   `CLAUDE_BYPASS_REPO_CONFIG_ISOLATION_FLAGS`. `--restricted` stays absent (ADR-0018); `--permission-prompts none`, the
   tool and allow lists and the FR-GIT-01 `--disallowedTools` Git deny rules are unchanged; `--mcp-config`, `--settings`
   and `--bare` stay barred.
3. A `privileged` scope without bypass, a bypass scope without approval, and every other profile keep
   `Ineligible: CAPABILITY_MISSING` for `approved` and `enabled`.
4. Codex: no change. Its `bypass: true` is `Ineligible` (the flag is undocumented), so its repository configuration stays
   refused; this decision applies once a Codex bypass is documented.
5. Worktree isolation (FR-WS-05), Git-write denial and the argv audit are unchanged. The audit needs no change: the
   decision only omits flags and adds none.

This amends ADR-0018 item 2 (which kept `--safe-mode` and `--strict-mcp-config`); it supersedes no ADR.

## Alternatives considered

- **Keep refusing (the Q-37 default).** Rejected by owner decision 26.
- **Treat `approved` like `enabled`.** Rejected: `approved` means only items the operator approved, and the help text has
  no per-item control; keeping `--strict-mcp-config` is the nearest narrower setting that exists (Delegated choice).

## Consequences

- A bypass run can execute repository hooks and be steered by repository instruction files and plugins, and for
  `enabled` use repository MCP servers, with the provider's permission bypass and no `--restricted` (R-41, R-38). zemdregon
  accepts this for his own workloads.
- Unverified: that omitting the flags loads exactly those items, and that the Git deny rules still hold (R-38). The T3.9
  live check must cover both.

## Revisit when

The live check shows the flags do not behave as assumed, a Claude release adds per-item repository controls, or Codex
bypass is documented (then add the Codex cell).
