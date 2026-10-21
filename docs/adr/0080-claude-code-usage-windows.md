# ADR-0080: Claude Code usage windows from the run's own `rate_limit_event`

- Status: Accepted (built 2026-10-21).
- Date: 2026-10-21
- Decided by: Delegated agent work on an operator task (2026-10-21), not owner-approved. The choice of source and the
  details marked **Delegated** were made while building it from the live capture.
- Related: FR-CAP-14, FR-CAP-13, FR-CAP-09, FR-CAP-10, FR-CAP-11, FRD BR-50,
  [ADR-0003](0003-no-credential-handling.md) (no credential handling),
  [ADR-0079](0079-provider-reported-usage-reader.md) (provider-reported usage reader; this ADR reuses its report shape
  and `provider_usage` field),
  [ADR-0007](0007-capacity-as-confidence-estimate.md) (capacity as a confidence estimate, never authoritative quota),
  [ADR-0055](0055-model-groups-and-usage-pacing.md) (usage windows and pacing),
  [ADR-0058](0058-captured-limit-signatures.md) (captured limit signatures),
  [ADR-0063](0063-per-run-provider-otlp-metrics-receiver.md) (per-run OTLP metrics, the other usage source),
  [capture note](../research/claude-usage-capture-2026-10-21.md),
  [LLD §16.11](../design/LLD.md#1611-claude-code-usage-windows-from-run-output-fr-cap-14-adr-0080),
  [ROADMAP T6.18](../ROADMAP.md#611-m6-capacity-and-resilience-tasks).

## Context

ADR-0055 and BR-50 allow a subscription window's used share and reset to be `provider_reported`, but only from a
declared, sourced key, and `USAGE_KEYS` was empty because no capture showed one. The
[2026-10-21 capture](../research/claude-usage-capture-2026-10-21.md) shows that Claude Code prints one
`rate_limit_event` on every `stream-json` run, `allowed` included, with `unifiedWindows.five_hour` and `.seven_day`
each holding `utilization` and `resetsAt`. The pacing projection could not use them, and an operator saw no provider
figure in `get_capacity`.

## Decision

1. **Record every window figure as provider-reported usage.** The Claude adapter turns each `rate_limit_event` that
   carries window figures into a `usage` event with source `provider_reported`, whatever its status. A `rejected` event
   still also yields the `rate_limit` event it yielded before. The metric keys are `<window>_used_fraction` (0 to 1)
   and `<window>_resets_at` (ISO time) for `five_hour` and `seven_day`. They are stored as ordinary
   `usage_observation` rows: no migration.
2. **Declare windowed `USAGE_KEYS`.** The `claude` keys join `USAGE_KEYS` (the first sourced keys, BR-50). A key may
   carry `window: { id, lengthSeconds }` (5 h is 18000 s, 7 d is 604800 s).
3. **Window-length binding.** A windowed key feeds only a configured subscription window of the same
   `length_seconds`. Reason: without it a 7-day figure could be read into a 5-hour window and the reverse. Unwindowed
   keys keep their old behaviour.
4. **Recorded windowed keys produce an ADR-0079 report.** Per provider whose figures come from run output, the
   rows per declared windowed share key observed within one window length give a `ProviderUsageReport`
   ([ADR-0079](0079-provider-reported-usage-reader.md)), set as the provider's `provider_usage` (method "recorded run
   output (declared usage keys)"; plan, `limit_reached`, `limit_reached_type` and credits `null`; each window with
   `limit_id` null and `window_seconds` 18000 or 604800). Per window: the latest reported reset, then the largest share
   (a row is stored when its run ends, so concurrent runs can store an older reading last; within one window the share
   only grows), then the newest; a window whose reset has passed is dropped; the report is absent when no window
   remains, and its `observed_at` is the oldest reading among its windows. A live reader (ADR-0079, Codex) replaces it
   for a provider that has one. There is no separate output field and no Claude-specific text line: `get_capacity`,
   `switchboard capacity` and `doctor` use the shared `provider_usage` format, for example
   `five_hour (18000 s, provider_reported): used 0.03, remaining 0.97, resets <ISO time>`. `remaining_fraction` is
   `1 - used_fraction` and is printed only on `provider_reported` lines (FR-CAP-03).
5. **No probe and no credential.** ADR-0079 item 7 ("`get_capacity` may run a provider CLI") does not apply to Claude:
   nothing is started for it. The figures are as fresh as the newest Claude run. Switchboard creates no run,
   probe or provider call to refresh them (FR-CAP-10 stays true) and reads no token, header or `~/.claude` file
   (ADR-0003). `REMAINING_KEYS` stays empty: Claude reports a used share, not a remaining amount.

## Consequences

- A configured subscription window of length 5 h or 7 d on Claude reads `provider_reported` figures with a
  provider-reported reset, so the pacing gate no longer needs an operator-declared reset for it (FR-CAP-09).
- The figures can be hours old when Claude has been idle; `observed_at` is always shown.
- A Claude login not seen in the capture (API key, cloud provider) may emit no window figures; then the report is
  absent and nothing changes.
- Tests: `src/adapters/claude/usage.test.ts` with the recorded fixture
  `src/adapters/claude/fixtures/usage-windows-recorded.jsonl`, `src/capacity/reported-usage.test.ts`,
  `src/capacity/usage-window.test.ts`, `src/mcp/get-capacity.test.ts`.

## Alternatives considered

- **Statusline JSON (`rate_limits`).** Rejected: supplied only to the interactive TUI's statusline command.
- **`anthropic-ratelimit-unified-*` headers or the OAuth usage endpoint behind `/usage`.** Not done: both need the
  login's OAuth token, which ADR-0003 forbids Switchboard to handle. Whether the owner wants an exception is left for
  the owner to decide; none is assumed.
- **A `claude -p "/usage"` probe.** Not implemented. It uses zero model tokens, but it spawns the CLI outside any run
  and parses free text with a year-less local-time reset (FR-ADP-04 prefers structured fields). Recorded as a possible
  follow-up if run-time freshness proves too coarse.
- **OpenTelemetry metrics (ADR-0063).** Rejected for this purpose: token and cost counters, no quota figure.
- **A separate Claude-only or `reported_usage` block.** Rejected in favour of the shared ADR-0079 `provider_usage`
  report (decision 4), so a later provider needs only declared keys and no new output field.
