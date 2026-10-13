# ADR-0015: Claude untrusted profiles use safe-mode isolation flags, not `--bare`

- Status: Accepted; partly superseded by [ADR-0018](0018-claude-bypass-omits-restricted.md) for approved bypass runs
  (2026-10-13: an approved `bypass: true` run omits `--restricted`) and partly superseded by
  [ADR-0029](0029-claude-code-receives-tool-shim-via-mcp-config.md) (2026-10-13: the adapter may emit `--mcp-config`
  for the controller-generated tool shim only) and by
  [ADR-0033](0033-claude-channel-bypass-only-without-safe-mode.md) (2026-10-13: an approved bypass run carrying that
  shim omits `--safe-mode`)
- Date: 2026-10-12
- Decided by: Delegated (agent, 2026-10-12)
- Related: FR-POL-02–04, FR-AUTH-01–02, [ADR-0003](0003-no-credential-handling.md),
  [ADR-0004](0004-trust-profiles-no-bypass-flags.md), [ADR-0009](0009-version-gated-adapters.md),
  [TDD §4.1](../design/TDD.md#41-claude-code-m2)

## Context

[TDD §4.1](../design/TDD.md#41-claude-code-m2) proposed `--bare` to isolate untrusted Claude Code profiles from hooks,
skills, plugins, MCP servers and `CLAUDE.md` (FR-POL-04). While writing the adapter (T2.2), the installed CLI's help
(`claude --help`, version 2.1.296, read without running a prompt) showed that `--bare` makes Anthropic authentication
strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings`, and never reads OAuth or the keychain. The Claude
compliance manifest allows only `native_cached_subscription`, and Switchboard never handles API keys
([ADR-0003](0003-no-credential-handling.md)), so every `--bare` run would fail authentication. The same help documents
`--safe-mode`, `--restricted` and `--strict-mcp-config`, which cover the same isolation goals while leaving the
operator's native login usable. The header comment of `src/adapters/claude/adapter.ts` records this finding.

## Decision

The Claude adapter compiles `inspect-untrusted` and `edit-untrusted` with `--safe-mode --restricted
--strict-mcp-config`, together with `--permission-mode dontAsk`, `--permission-prompts none` and explicit
`--tools`/`--allowedTools` lists, as [ADR-0004](0004-trust-profiles-no-bypass-flags.md) already requires. It never emits
`--bare`, `--settings`, `--setting-sources`, `--mcp-config` or any bypass flag. TDD §4.1 is updated to match. This
refines how ADR-0004's profile compilation is realised for Claude; ADR-0004's decision is unchanged and not superseded.

## Alternatives considered

- **`--bare` as TDD proposed.** Rejected: forces API-key authentication, which the manifest and ADR-0003 forbid.
- **`--bare` plus an operator-supplied API key.** Rejected: Switchboard must not handle or forward provider credentials.
- **No isolation flags, rely on `dontAsk` and tool lists only.** Rejected: leaves user and project settings, hooks and
  MCP servers active inside an untrusted run (FR-POL-04).

## Consequences

- Isolation rests on three flags known only from help text. They are version-gated ([ADR-0009](0009-version-gated-adapters.md)):
  a CLI whose help no longer lists them fails the probe and the adapter is ineligible.
- This is verified against help text only. Stream-json event shapes, error category strings, the `Grep`, `Glob` and
  `Write` tool names and the exact-match behaviour of `Bash(...)` rules are unverified Assumptions, tracked in the
  [ROADMAP](../ROADMAP.md#73-open-questions-for-zemdregon-not-blocking-m2-unless-noted) and confirmed by the opt-in live
  smoke test (T2.6).
- `--safe-mode` and `--restricted` are not a sandbox: credential confinement remains unproven (R-10, M3).

## Revisit when

The live smoke test contradicts the help text, a later Claude release changes these flags or the meaning of `--bare`
(for example OAuth support), or M3 shows the flags do not confine an untrusted run.
