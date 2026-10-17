# ADR-0029: Claude Code receives the controller-generated tool shim via `--mcp-config`

- Status: Accepted (decision); implementation **supported** behind the operator opt-in, for approved bypass runs only
  (T9.4b; owner decision 2026-10-16, zemdregon: mark T9.4b supported, Claude tool channel, bypass-only per
  [ADR-0033](0033-claude-channel-bypass-only-without-safe-mode.md)). Live evidence: the 2026-10-14 operator run through
  Switchboard's own shim ([ROADMAP §6.3](../ROADMAP.md#63-m9-projects-and-controlled-commits-tasks)). Amends [ADR-0015](0015-claude-untrusted-isolation-flags.md)'s
  ban on `--mcp-config` for the injected channel only. Partly superseded by
  [ADR-0033](0033-claude-channel-bypass-only-without-safe-mode.md) (2026-10-13, owner decision 41): the channel is
  offered only to approved bypass runs, which omit `--safe-mode`
- Date: 2026-10-13
- Decided by: zemdregon (owner decision 36, answer to Q-40); mechanism Delegated (agent, 2026-10-13)
- Related: FR-GIT-02, FR-GIT-01, FR-POL-03, FR-POL-08, [ADR-0014](0014-tool-only-commits-and-publication.md),
  [ADR-0018](0018-claude-bypass-omits-restricted.md), [ADR-0021](0021-repository-config-in-approved-bypass-runs.md),
  [ADR-0026](0026-per-run-tool-channel-socket-and-token.md), ROADMAP T9.4b, R-18, R-50, Q-40,
  [TDD §3.10](../design/TDD.md#310-git-commits-attribution-and-publication),
  [LLD §12.2](../design/LLD.md#122-channel)

## Context

FR-GIT-02 needs each adapter to hand the provider a per-run MCP definition for the controller's `tool-shim`
([ADR-0026](0026-per-run-tool-channel-socket-and-token.md)). For Claude Code the only per-run form seen in `claude
--help` 2.1.296 is `--mcp-config <json file or string>` with `--strict-mcp-config`. [ADR-0015](0015-claude-untrusted-isolation-flags.md)
says the adapter never emits `--mcp-config`, and `src/adapters/audit.ts` and `src/adapters/claude/claude.test.ts`
enforce it, so the Claude adapter declares `commitChannel: "none"` (T9.4). zemdregon answered Q-40 on 2026-10-13: "Q-40
your recommendation." The recommendation was yes, narrowly: only the controller-generated shim definition, never operator
or repository definitions.

A third-party open-source project (T3 Code) is noted in [TDD §3.10](../design/TDD.md#310-git-commits-attribution-and-publication)
as prior art: its source comments observe that an inline `--mcp-config` argument is readable by every local user. That
is the reason for item 1 below. It is studied, not copied, and none of its behaviour is verified on our CLI.

## Decision

1. **A file, not inline JSON.** The Claude adapter MAY emit `--mcp-config <file>`, where `<file>` is written by the
   controller with mode `0600` inside the run's private `0700` directory and removed when the run's channel closes. It
   never passes JSON inline in argv (argv is readable by other local users).
2. **Exactly one server.** The file contains one MCP server, the controller-generated shim: `command` is the daemon's
   own Node executable (`ShimSpec.command[0]`), `args` are the rest of `ShimSpec.command` (the `tool-shim` subcommand
   with `--socket <path>`; the offered tools are `ShimSpec.toolNames`). The server name is a fixed, collision-resistant
   controller name (**Assumption**; the exact name is chosen in T9.4b). Operator, repository and user MCP definitions
   stay barred: the adapter never forwards an operator-supplied `--mcp-config`, and ADR-0015's ban holds for them.
3. **The token stays out of argv and out of the file.** The per-run token (`SWITCHBOARD_TOOL_TOKEN`, `ShimSpec.env`)
   goes into the provider process's environment through `Invocation.env`, as ADR-0026 and `ShimSpec` require (FR-POL-08:
   never argv, a file the adapter writes, or global provider configuration). If Claude Code does not pass its own
   environment to a stdio MCP server, the file may carry an `env` entry that only *references* the variable (for example
   `${SWITCHBOARD_TOOL_TOKEN}`); it never holds the value. Whether Claude Code expands such a reference, and what
   environment a stdio server inherits, is **unverified** (live check).
4. **Pre-approval by exact tool name.** The adapter adds `--allowedTools mcp__<server>__commit` and, when `push` is
   offered, `mcp__<server>__push`. No wildcard (`mcp__<server>__*`). The allow-rule form is an **Assumption** from the
   documented `mcp__<server>__<tool>` naming; it is verified live.
5. **Strictness.** `--strict-mcp-config` is used on every run that carries the shim, so only the shim loads. The one
   exception is owner decision 26 ([ADR-0021](0021-repository-config-in-approved-bypass-runs.md)): an approved bypass run
   with `repository_config` `enabled` deliberately omits `--strict-mcp-config` so the repository's `.mcp.json` loads; the
   shim is then additive to those definitions, and no other definition is added by the controller.
6. **Argv audit.** `src/adapters/audit.ts` gets an allowlist rule for exactly this shape (the `--mcp-config` flag with a
   single path inside the run directory, together with `--strict-mcp-config` unless item 5 applies, and the exact-name
   `--allowedTools` entries), and keeps rejecting every other use of `--mcp-config` and any wildcard MCP allow rule.
   **Not implemented by this change**; it is follow-up task T9.4b (ROADMAP §6.3).
7. **Disabled by default.** The Claude adapter keeps declaring `commitChannel: "none"` until an explicit operator
   opt-in is set, and the opt-in is not offered as supported until the live checks pass. What must be checked live
   (R-18, T9.4b, with the installed `claude`): (a) `--mcp-config` with a stdio shim starts and serves tools headless
   under `-p`; (b) exact-name allow rules cover MCP tools under `--permission-mode dontAsk` and under approved bypass;
   (c) whether `--safe-mode` drops the server (ADR-0015 compiles untrusted profiles with it); (d) the Git deny rules
   (FR-GIT-01) still hold with the server present; (e) the shim can connect to the Unix socket from inside whatever
   sandbox Claude applies; (f) what environment a stdio server inherits and whether a `${VAR}` reference expands.
   Until then a Claude run without the opt-in behaves as today (and, when the project opts in to finalize-only, the
   controller commits at FINALIZING, T9.7).

## Alternatives considered

- **Keep the ban; Claude is finalize-only.** Rejected by zemdregon's answer to Q-40; remains the fallback if a live
  check fails.
- **Inline JSON in argv.** Rejected: world-readable argv.
- **Wildcard allow rule `mcp__<server>__*`.** Rejected: least privilege; the tool set is two named tools.
- **Writing the definition into the project's `.mcp.json` or the user's configuration.** Rejected: global or repository
  configuration (FR-POL-08).
- **Loopback HTTP MCP server with a bearer token.** Rejected: puts the controller on the network; the Unix-socket stdio
  shim is kept ([ADR-0026](0026-per-run-tool-channel-socket-and-token.md)).

## Consequences

- ADR-0015's status line reads "partly superseded by ADR-0029" for the injected channel only; every other clause stands.
- The argv audit and `claude.test.ts` still reject `--mcp-config` until T9.4b lands; no code changes with this ADR.
- A bypass flag is still never used for the channel (FR-POL-03); if exact-name allow rules do not cover the tools under
  `dontAsk`, the adapter stays `none`.
- Reliance on third-party observations is a risk (R-50); the live check is the authority.

## Revisit when

A live check contradicts items 3 to 5, Claude Code adds a flag that supplies a definition without a file, or the
`--mcp-config` semantics change in a CLI release (the manifest range gates the adapter, ADR-0009).

## Implementation note (2026-10-13, T9.4b; Delegated, not owner-approved)

The decision text above is unchanged. Items 1 to 6 are implemented behind the operator opt-in
`providers.claude-code.git_channel` (default `false`), which was documented as unsupported until the item 7 live checks
passed; on 2026-10-16 the owner marked it supported for approved bypass runs only (status line above); without it
the adapter declares `none` and its argv is byte-identical. The server name chosen for item 2 is
`switchboard-git` and the file is `mcp-config.json` in the run's private channel directory, written by the channel
service (not the adapter) and removed on close and by the startup sweep. Item 5 needs no extra flag: the compiled argv
already carries `--strict-mcp-config` everywhere except decision 26's case. Item 3: the file carries the `env` reference
`${SWITCHBOARD_TOOL_TOKEN}`, never the value. Further Assumptions added by the implementation (a second `--allowedTools`
occurrence accumulates, `--tools` does not filter MCP tools, the `mcpServers` / `"type": "stdio"` shape) are listed with
the live checks under the T9.4b status in [ROADMAP §6.3](../ROADMAP.md#63-m9-projects-and-controlled-commits-tasks);
each fails closed. Mechanism and tests: [LLD §12.2](../design/LLD.md#122-channel), [TDD
§3.10](../design/TDD.md#310-git-commits-attribution-and-publication).
