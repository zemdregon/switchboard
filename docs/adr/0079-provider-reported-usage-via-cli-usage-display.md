# ADR-0079: Provider-reported plan usage read from the CLI's own usage display (Kimi Code first)

- Status: Accepted (built 2026-10-21).
- Date: 2026-10-21
- Decided by: Delegated (agent, 2026-10-21), not owner-approved. Everything below is a Delegated choice; the open owner
  option is ROADMAP Q-114.
- Related: FR-CAP-13, FR-CAP-01, FR-CAP-03, FRD BR-50,
  [ADR-0003](0003-no-credential-handling.md) (no credential handling),
  [ADR-0055](0055-model-groups-and-usage-pacing.md) (usage windows and the `provider_reported` source),
  [ADR-0058](0058-captured-limit-signatures.md) (limit signals taken from captured provider output),
  [LLD §16.10](../design/LLD.md#1610-provider-usage-readers-fr-cap-13),
  [research note](../research/kimi-usage-2026-10-21.md),
  [ROADMAP T6.17](../ROADMAP.md#611-m6-capacity-and-resilience-tasks).

## Context

Capacity figures were estimates from Switchboard's own runs, with `provider_reported` only where a stream named a key.
Kimi Code subscribers have 5 hour, weekly and monthly plan windows, and the orchestrator wants the real numbers. The
research note records every source examined (CLI 2.1.1): stream-json and ACP carry no quota, the backend endpoint needs
the OAuth bearer token, and the `kimi web` route needs a local bearer file. The CLI's interactive `/usage` command
renders the plan usage with the CLI's own credentials.

## Decision

1. **Read the CLI's `/usage` display.** A `ProviderUsageReader` (LLD §16.10) for Kimi runs `kimi` under a
   pseudo-terminal (util-linux or BSD `script`) in a stable, private probe directory `<data_dir>/probes/kimi-usage`
   (created 0700; refused unless it is a real, empty directory owned by the controller's user), with an environment of
   `PATH` and `HOME` only (plus `TERM`, `COLUMNS`, `LINES`), types `/usage`, parses the terminal text with the pure
   parser `parseKimiUsagePanel`, and exits with Ctrl-C. No model call is made and no session is created. Kimi trusts
   folders one by one, so the first read meets its "Trust this folder?" dialog: the reader answers "Trust and continue"
   only when the dialog names the probe directory and that option is selected, and fails closed otherwise; it also fails
   closed, typing nothing, when the prompt does not appear.
2. **Never read a credential or call the provider API.** Switchboard reads no token file and sends no request to
   Kimi's backend. The CLI computes the figures with its own credentials.
3. **Report as `provider_reported`** with the observation time and the reading path (`via`), per window: used and
   remaining fraction, precision, reset time and its precision. Booster balances are reported as `balances`.
4. **Cache.** An in-memory TTL cache in `ProviderUsageService`: 300 s after a success, 60 s after a failure, one
   reading in flight per provider. `get_capacity` and `switchboard capacity` may therefore start the CLI at most once
   per TTL; `doctor` does not read usage, so it stays fast.
5. **Fail closed.** A missing binary, a timeout, an unlogged CLI or text the parser does not recognise gives
   `status: "unavailable"` with a reason, never a guessed figure. A TUI change in a later CLI version therefore
   degrades to `unavailable`.
6. **Not an input to decisions yet.** The reading is shown, not fed to the estimator, pacing or routing
   (**Proposed** follow-up).

## Alternatives considered

- **Call `GET /coding/v1/usages` directly.** Exact ratios and ISO reset times, but it needs the OAuth bearer token:
  credential handling and reimplementing the provider protocol. Rejected (ADR-0003).
- **Use `kimi web` and `GET /api/v1/oauth/usage`.** Same data through the CLI's credentials, but every route needs the
  bearer in `~/.kimi-code/server.token`; reading it is credential handling, and it starts a local server. Rejected;
  recorded as an owner option (Q-114), default no.
- **ACP `/usage`.** Session token counts only, no plan windows. Rejected.
- **stream-json events.** No quota. Rejected.

## Consequences

- Precision is a whole percent (0.01) and a minute-level relative reset time; the reset instant is the observation
  time plus that offset.
- The reader depends on the TUI text of Kimi Code 2.1.1; the fixture `src/adapters/kimi/fixtures/usage-tui-2.1.1.raw`
  and the parser tests pin it, and a changed layout fails closed.
- Side effects in the operator's Kimi state: one trust record and one workspace-list entry for the probe directory
  (once, as the directory is stable) and one `/usage` line of input history per read. A fresh directory per read was
  tried first and rejected: it would meet the trust dialog and add a trust record on every read.
- The provider-neutral interface lets another provider add a reader later without touching `get_capacity`.
- A provider without a reader is unchanged: its `get_capacity` entry is byte-identical to before.
- No live Kimi call is made in tests; the reader runs against a fake runner and the captured fixture.
