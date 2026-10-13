# ADR-0033: The Claude Code tool channel is offered only to approved bypass runs, which omit `--safe-mode`

- Status: Accepted (decision); implementation present behind the unsupported operator opt-in
  `providers.claude-code.git_channel` (T9.4b, 2026-10-13, Delegated) and **unproven end to end** through Switchboard
- Date: 2026-10-13
- Decided by: zemdregon (owner decision 41: of the options put to him after the live check, he chose option A, "offer
  the channel only for an approved bypass run"; the wording here is Delegated, not his words). The mechanism (where
  `--safe-mode` is removed, the audit rules, the per-run narrowing) is Delegated (agent, 2026-10-13) and not
  owner-approved.
- Supersedes: the scope of [ADR-0029](0029-claude-code-receives-tool-shim-via-mcp-config.md) for which runs get the
  Claude channel (ADR-0029 offered it to every write-capable project run with the opt-in, with `--safe-mode` kept).
  ADR-0029's items 1 to 6 (file, one server, token, exact-name rules, strictness, audit shape) stand. Also partly
  supersedes [ADR-0015](0015-claude-untrusted-isolation-flags.md) (`--safe-mode` on every invocation) for this case.
- Related: FR-GIT-02, FR-GIT-01, FR-GIT-09, FR-POL-03, FR-POL-04, FR-POL-08, FR-WS-05,
  [ADR-0017](0017-approved-privileged-scope-bypass.md), [ADR-0018](0018-claude-bypass-omits-restricted.md),
  [ADR-0021](0021-repository-config-in-approved-bypass-runs.md), [ADR-0026](0026-per-run-tool-channel-socket-and-token.md),
  ROADMAP T9.4b, T9.7, R-18, R-38, R-41, R-59, [TDD §3.10](../design/TDD.md#310-git-commits-attribution-and-publication),
  [LLD §12.2](../design/LLD.md#122-channel)

## Context

An agent ran live checks on the operator's machine on 2026-10-13 with Claude Code 2.1.296 and a hand-made 12-line stdio
MCP server, not Switchboard's `tool-shim` (report `docs/research/live-checks-2026-10-13.md`, added by PR #41 and not on
this branch). Relevant findings (observed there, not here):

- `--mcp-config` with one stdio server works headless; the file needs the `{"mcpServers": {...}}` wrapper (a bare map
  is rejected) (check 6).
- A `${VAR}` reference in the server's `env` expands from the claude environment; an unset variable stays the
  **literal** text. The server inherits the whole claude process environment (check 7).
- Exact-name allow rules `mcp__<server>__<tool>` work under `dontAsk`; wildcards and server-wide rules also work; with
  no rule the call is denied (check 8a to 8c).
- **`--safe-mode` stops the injected server from starting**, with or without `--strict-mcp-config`;
  `--strict-mcp-config` alone and `--restricted` alone keep it (checks 8d, 8e). The compiled untrusted and
  trusted-development flags include `--safe-mode` (ADR-0015), so the channel as built by ADR-0029 cannot work on them.
- Omitting `--safe-mode` loads the repository's `CLAUDE.md`, hooks and (without `--strict-mcp-config`) `.mcp.json`;
  a repository hook ran a command with no prompt (check 15, R-41).
- The Git deny rules and `--tools` held under `--dangerously-skip-permissions` (check 14, R-38).

The report's recommendation 1 asked for an owner decision. Option A was to offer the channel only where repository
configuration is already accepted and the run is deliberately loose: an approved `privileged` run whose scope sets
`bypass` ([ADR-0017](0017-approved-privileged-scope-bypass.md); owner decision 26 and
[ADR-0021](0021-repository-config-in-approved-bypass-runs.md) already let such a run load repository configuration).
zemdregon chose option A.

## Decision

1. **Bypass only.** The Claude adapter offers the injected tool channel only when all of these hold: the operator
   opt-in `providers.claude-code.git_channel` is on, the resolved profile is `privileged`, its approved scope sets
   `bypass`, and the run's `bypassApproved` is true (the same three facts the bypass argv audit checks). The adapter
   says so through a per-run `offersChannel` predicate; for every other run the lifecycle treats the adapter as
   declaring `none`: no channel, no `--mcp-config`, an argv identical to the opt-in off, and the finalize-only commit
   (FR-GIT-09, T9.7) applies when the project opts in.
2. **`--safe-mode` is omitted in that case.** The channel fragment asks the lifecycle to remove `--safe-mode` from the
   compiled argv (a no-op where decision 26 already omitted it). Consequently the repository's instruction files,
   skills, plugins and hooks load in that run, as in decision 26's `approved` case. `--strict-mcp-config` stays except
   in decision 26's `enabled` case, so no repository MCP definition loads otherwise.
3. **Unchanged in that case.** Git-write denial (FR-GIT-01: `--disallowedTools` deny rules, `--tools`), worktree
   isolation (FR-WS-05), the bypass flag audit, ADR-0029 items 1 to 6, and no bypass flag added for the channel.
4. **Belt and braces in the argv audit** (`src/adapters/audit.ts`, run before every spawn): `--mcp-config` is refused
   on any run that is not an approved bypass run; `--mcp-config` is refused when the provider environment lacks a
   non-empty `SWITCHBOARD_TOOL_TOKEN` (an unset reference would stay literal); and a Claude argv without `--safe-mode`
   is refused unless the run is an approved bypass run and either decision 26 applies (`repository_config` `approved`
   or `enabled`) or the argv carries the channel definition.
5. **Environment.** The stdio server sees the claude process environment, which is the adapter's child environment:
   only `PATH`, `HOME` (the adapter's allowlist) and the token. The controller always sets the token.
6. **Still unsupported.** The opt-in stays documented as UNSUPPORTED until a live run through Switchboard with a real
   Claude Code shows the shim starting, serving `commit` over the socket, and the Git deny rules holding with it.

## Alternatives considered

- **Drop `--safe-mode` for every run with the opt-in.** Rejected: loads repository hooks and instructions into
  untrusted runs (R-41), defeating ADR-0015.
- **Keep ADR-0029's scope and wait for another way to keep customisations off** (`--settings`, `--setting-sources`,
  `--disable-slash-commands`, plugin flags; untested). Not chosen by zemdregon; remains a follow-up if a spike finds one.
- **Finalize-only for all Claude runs.** Remains the path for every non-bypass run.
- **Omit `--safe-mode` at compile time whenever the opt-in and bypass hold.** Rejected (Delegated): the run would lose
  `--safe-mode` even when the lifecycle then offers no channel (for example a non-`host` project), with no benefit.

## Consequences

- ADR-0029's status line points here; its decision text is unchanged. ADR-0015's status line names this ADR too.
- `GitCapabilities` gains the optional `offersChannel` and `ChannelArgs` the optional `removeFlags` (LLD §12.2 note).
- A bypass run with the channel carries R-41's repository-configuration exposure even when its scope says
  `repository_config: disabled`. zemdregon accepts bypass runs as deliberately loose; recorded as R-59.
- Tests: `src/adapters/claude/channel.test.ts`, `src/lifecycle/claude-channel.test.ts` (fake claude replay only).

## Revisit when

A flag is found that keeps customisations off while keeping one MCP server; a Claude Code release changes
`--safe-mode`; or the live run through Switchboard fails.
