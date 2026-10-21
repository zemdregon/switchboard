# ADR-0084: Kimi Code provider usage read from the CLI's own `/usage` display

- Status: Accepted (built 2026-10-21).
- Date: 2026-10-21
- Decided by: Delegated (agent, 2026-10-21), not owner-approved. Everything below is a Delegated choice; the open owner
  option is ROADMAP Q-114.
- Related: FR-CAP-13,
  [ADR-0079](0079-provider-reported-usage-reader.md) (the reader interface, report shape, cache and surfaces this
  implements for Kimi Code),
  [ADR-0003](0003-no-credential-handling.md) (no credential handling, holds),
  [LLD §16.10](../design/LLD.md#1610-provider-reported-usage-reader-fr-cap-13-adr-0079),
  [research note](../research/kimi-usage-2026-10-21.md),
  [ROADMAP T6.19](../ROADMAP.md#611-m6-capacity-and-resilience-tasks).

## Context

ADR-0079 added an optional `readProviderUsage` adapter method and a `provider_usage` overlay, with Codex first. Kimi
Code subscribers have 5 hour, weekly and monthly plan windows. On Kimi Code CLI 2.1.1 neither stream-json nor ACP carries
them, the backend endpoint needs the OAuth bearer token, and the `kimi web` route needs a local bearer file. The CLI's
interactive `/usage` command renders the plan usage with the CLI's own credentials (research note).

## Decision

1. **Read the TUI `/usage` display under a pseudo-terminal.** The Kimi reader runs `kimi` through util-linux or BSD
   `script`, types `/usage`, parses the terminal text with the pure parser `parseKimiUsagePanel`
   (`src/adapters/kimi/usage.ts`) and ends the CLI with Ctrl-C. No model call, no session, no credential read, no request
   to Kimi's API. The environment is `PATH` and `HOME` plus `TERM`, `COLUMNS` and `LINES`.
2. **Stable private probe directory.** The CLI runs in `<data_dir>/probes/kimi-usage`, created by Switchboard as an
   empty real directory (not a symlink) owned by the user, mode 0700, and checked on every read. A stable path means
   Kimi's workspace list gains one entry in total instead of one per read.
3. **Trust dialog.** If Kimi asks whether to trust the directory, the reader answers only when the dialog names that
   directory and has "Trust and continue" selected; any other dialog fails the read.
4. **Fail closed.** A missing binary, timeout, unrecognised text or any unexpected prompt gives
   `ProviderUsageUnavailable` (`source: "unknown"`, with a reason), never a figure. A TUI change in a later CLI version
   therefore degrades to `unknown`.
5. **Injected `TerminalRunner`.** The reader takes a `TerminalRunner`. Production wiring passes one built on
   `<data_dir>/probes`; without it, as in tests, the Kimi reader returns `unknown` and spawns nothing.
6. **Mapping to ADR-0079's report.** Method `kimi TUI /usage (pseudo-terminal)`. Windows `5h` (18000 s), `weekly`
   (604800 s) and `monthly` (`window_seconds` null). The monthly breakdown `kimi N% · code M%` becomes windows
   `kimi:monthly` and `code:monthly` with `limit_id` `kimi` and `code`. The "Extra Usage" booster wallet becomes
   `credits`. `plan` and `limit_reached` are null: the display names neither. `resets_at` is the observation time plus
   the relative reset text.

## Consequences

- Precision is a whole percent (0.01) and a reset time to the minute.
- The parser depends on the TUI layout of Kimi Code 2.1.1; the fixture `src/adapters/kimi/fixtures/usage-tui-2.1.1.raw`
  and `src/adapters/kimi/usage.test.ts` pin it.
- Side effects in the operator's Kimi state: the probe directory is recorded in Kimi's workspace list (once, because the
  path is stable) and each read adds one `/usage` line to its input history.
- Cache, surfaces, wording rules and the not-a-routing-input rule are ADR-0079's and apply unchanged.
- No live Kimi call is tested; tests use a fake `TerminalRunner` and the captured fixture.

## Alternatives considered

- **Call `GET /coding/v1/usages` directly** (`usages.limit_5h`, `limit_7d`, `limit_month_total`, `limit_month_code`
  with `used_ratio` and `reset_time`, plus a booster wallet): needs the OAuth bearer token, so it is credential handling
  and reimplementing the provider protocol. Rejected (ADR-0003).
- **`kimi web` and `GET /api/v1/oauth/usage`:** exact ratios and ISO reset times through the CLI's credentials, but every
  route needs the persistent bearer in `~/.kimi-code/server.token`; reading it is credential handling. Rejected; an
  owner option (Q-114), Delegated default no.
- **ACP `/usage`:** session token counts only. Rejected.
- **stream-json events:** no quota. Rejected.
