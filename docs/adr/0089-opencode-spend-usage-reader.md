# ADR-0089: OpenCode provider-reported spend and the `spend_windows` extension

- Status: Accepted (built 2026-10-21).
- Date: 2026-10-21
- Decided by: Delegated agent work on an operator task (2026-10-21), not owner-approved. The goal (real OpenCode usage
  figures beside the projection) comes from the operator's task; the details marked **Delegated**, **Proposed** or
  **Assumption** were chosen while building it.
- Related: FR-CAP-16, FR-CAP-13, FR-CAP-03, FRD BR-50, BR-63,
  [ADR-0079](0079-provider-reported-usage-reader.md) (the reader interface, extended here, not superseded),
  [ADR-0080](0080-cursor-usage-from-the-cli-usage-command.md) (Cursor; its per-billing-period `spend` is a different
  field and is kept as is),
  [ADR-0003](0003-no-credential-handling.md) (no credential handling, holds),
  [LLD §16.13](../design/LLD.md#1613-provider-reported-spend-and-the-opencode-reader-fr-cap-16-adr-0089),
  [research note](../research/opencode-usage-2026-10-21.md),
  [ROADMAP T6.24](../ROADMAP.md#611-m6-capacity-and-resilience-tasks).

## Context

ADR-0079 added an optional `ProviderAdapter.readProviderUsage(runner, now)` and a `ProviderUsageReport` shaped for
providers that report quota windows as used fractions with a reset (Codex). OpenCode reports no such thing. Its own
read-only `experimental.session.stats` operation returns what was spent (USD from OpenCode's price table), sessions,
steps, tokens and per-model figures for any millisecond range, from OpenCode's local session history on this host. No
surface the CLI can read reports the Go plan's limit, what is left of it, or a reset time (the
[research note](../research/opencode-usage-2026-10-21.md) lists every source checked). A fraction or remaining figure
computed from spend against the documented Go limits would be a Switchboard estimate presented as the provider's.

## Decision

1. **Additive `spend_windows` extension of `ProviderUsageReport`.** Optional
   `spend_windows: ProviderUsageSpendWindow[]` (each `id`, `window_seconds`, `from`, `to`, `amount`, `unit: "usd"`,
   optional `detail`), plus optional `scope` and `note` strings. `amount` is the reported spend, never a remaining
   figure (FR-CAP-03). Codex and Cursor set none of them, so their reports, schema validation and text are unchanged.
   No second interface is added.
2. **OpenCode reader on the adapter.** `OpenCodeAdapter.readProviderUsage` runs
   `opencode api --standalone experimental.session.stats --param from=<ms> --param to=<ms> --param tools=none` through
   the probe runner (allowlist `PATH`, `HOME`, the adapter's executable and launcher) for three rolling windows:
   `five_hour` (18 000 s), `weekly` (604 800 s) and `monthly` (2 592 000 s; **Assumption**: 30 days rolling, because the
   Go monthly anchor is not reported). The report has `windows: []`, `plan`, `limit_reached`, `limit_reached_type` and
   `credits` `null`, the three `spend_windows` entries, a `scope` and a `note`.
3. **Sequential windows** (**Delegated**). `--standalone` starts a private OpenCode server per call (about 3.7 s each
   on the operator host); three at once on the same local database would contend for it and triple the load for a
   figure cached a minute (ADR-0079 item 4). Each call has a 20 s timeout (**Proposed**). The first failure ends the
   read.
4. **The JSON shape decides, not the exit code.** Bad input prints `HTTP 500 Internal Server Error` with exit 0. The
   parser accepts only `{"data": …}` with finite non-negative figures and a `data.range` that echoes the requested
   `from` and `to`, reading own properties only. Models are sorted by spend (descending, then id) and capped at 20
   (**Proposed**) with `models_omitted`.
5. **Fail closed, controller text only.** A missing binary, spawn failure, timeout, non-zero exit, non-JSON output,
   wrong shape or range mismatch gives `ProviderUsageUnavailable` (`source: "unknown"`) with a short controller-written
   reason; raw stdout, stderr and the spawn error are never copied (BR-50).
6. **Scope is stated** (BR-63). The figures cover every OpenCode session on this host, including use outside
   Switchboard, and nothing on other machines; `scope` says so, and `note` says limit, remaining and reset are not
   reported.

## Consequences

- Operators see OpenCode spend for the three windows beside the projection, labelled `provider_reported` with its scope;
  text says `spent … usd; limit not reported, remaining not reported, reset not reported`.
- `get_capacity` may start up to three short OpenCode processes, one after another, at most once a minute per process.
- The endpoint is marked experimental by OpenCode; a change in its shape makes the read `unknown`, never a wrong figure.
- The projection, routing, pacing and the ledger are unchanged; spend is not compared with any limit.

## Alternatives rejected

- **OpenCode Console Budgets API** (`limit_micro_cents`, `spent_micro_cents`, `resets_at`): needs an `oc_sk_…` Console
  API key held by Switchboard (ADR-0003), and covers Console budgets, not the Go plan's windows. Left as an open
  question for zemdregon.
- **Reading `~/.local/share/opencode/opencode.db`**: it holds credential tables (`account`, `credential`), so Switchboard
  must not open it (ADR-0003).
- **`opencode stats --json --days N`**: same data, but day granularity only; no 5-hour window.
- **Deriving a used fraction from the documented Go limits**: the plan tier and window anchors are not visible to the
  CLI, so the figure would be an estimate labelled as the provider's.
- **A separate generic reader interface beside ADR-0079's**: two shapes for one surface; extending the report
  additively keeps one interface.
