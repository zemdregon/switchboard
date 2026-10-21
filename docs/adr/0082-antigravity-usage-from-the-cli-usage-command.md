# ADR-0082: Antigravity usage from the CLI's own `/usage` command

- Status: Accepted (built 2026-10-21).
- Date: 2026-10-21
- Decided by: Delegated agent work on an operator task (2026-10-21: "Switchboard must show real usage data for every
  provider"), not owner-approved. It answers Q-101 as **Delegated**: the read has no bypass effect, uses the provider's
  own login and spends no quota, so AGENTS.md "best-practice defaults outside bypass mode" applies.
- Related: FR-CAP-13, FR-CAP-03, FR-AUTH-02, FRD BR-50,
  [ADR-0079](0079-provider-reported-usage-reader.md) (the provider usage reader this implements for Antigravity),
  [ADR-0003](0003-no-credential-handling.md) (no credential handling: the CLI reads its own login),
  [ADR-0055](0055-model-groups-and-usage-pacing.md) (usage windows and pacing; its Q-101 alternative is answered here),
  [LLD §16.10](../design/LLD.md#1610-provider-reported-usage-reader-fr-cap-13-adr-0079),
  [research note 2026-10-21](../research/usage-sources-antigravity-2026-10-21.md),
  [ROADMAP T6.20](../ROADMAP.md#611-m6-capacity-and-resilience-tasks).

## Context

ADR-0079 added an optional adapter method, `readProviderUsage`, whose report `get_capacity`, `switchboard capacity`
and `doctor` show as `provider_usage` beside the capacity projection. Antigravity had no reader: its runs report
tokens only, and its quota stop (`AGY_ERROR` `RESOURCE_EXHAUSTED`, T6.15) carries the reset as free text.

The `agy` CLI (1.4.3, recorded 2026-10-21) answers the read-only slash commands `/usage` (alias `/quota`) and
`/credits` in print mode. Its changelog says they run "without starting an agent turn, spending quota, or leaving a
conversation behind", and the recording shows `num_turns` 0, zero tokens and an empty `conversation_id`. Under
`--output-format json`, `command.data.groups[].buckets[]` carries, per quota window, `id`, `name`, `window` (`5h`,
`weekly`), `remaining_fraction` in [0, 1] and `reset_time` (UTC). The CLI gets the figures from Google's
`v1internal:retrieveUserQuotaSummary` (seen in its logs), which only the CLI's OAuth token may call.

Signed out, `agy -p "/usage"` prints a sign-in URL and waits about 60 s for a code ([LIVE] C6, C13; recorded again
with an empty `HOME`). Q-101 asked whether the controller may call it outside a run. Its Delegated default was no
probe.

## Decision

1. **Antigravity implements `readProviderUsage` with the CLI's own commands (Q-101 answered, Delegated).** It runs
   `agy models` first (the existing `authPreflight`, which never starts a sign-in). Only on `OK` does it run `agy -p
   "/usage" --output-format json` and `agy -p "/credits" --output-format json` in parallel, from the system temporary
   directory, with the probe environment (`PATH`, `HOME`) and a 20 s bound. Reason: the provider's CLI uses its own
   login and Switchboard reads only its stdout (ADR-0003), no quota is spent, and the sign-in wait is never reached.
2. **Mapping onto the ADR-0079 report.** Each bucket is a window. `id` is the bucket id (for example `gemini-5h`,
   unique across groups). `limit_id` is the name of the group of models that share the bucket (for example `Gemini
   Models`), which is the provider's metered unit. `window_seconds` is 18 000 for `5h` and 604 800 for `weekly`, and
   null for any other kind. `remaining_fraction` is as reported and `used_fraction` is `1 - remaining`. `resets_at` is
   `reset_time`. `/credits` `remaining_credits` gives `credits` (`has_credits` when above 0, `unlimited` false,
   `balance` as a string). The CLI reports no plan and no limit-reached flag, so `plan`, `limit_reached` and
   `limit_reached_type` are null. A remaining fraction of 0 is shown as reported, never turned into a flag.
3. **Strict parsing, fail closed.** Only `status` `SUCCESS`, `num_turns` 0 and `command.name` `usage` are read, own
   properties only. A bucket needs a token-shaped `id` and `window`, a finite `remaining_fraction` in [0, 1] and a
   parseable `reset_time` (or none). An invalid bucket is dropped. No valid bucket, a signed-out or unknown login, a
   timeout or a spawn failure is `source: "unknown"` with a short reason and no figure. Free text (`description`, the
   tab-separated `response`) is never read. A failed `/credits` leaves `credits` null and changes nothing else.
4. **Not built: calling `retrieveUserQuotaSummary` directly.** It would need Switchboard to read the CLI's OAuth token,
   which ADR-0003 forbids. The CLI command returns the same figures.

## Consequences

- Antigravity's 5-hour and weekly quota per model group, its reset times and its AI-credit balance are visible over MCP
  and the CLI as `provider_reported`.
- A `get_capacity` call can start, at most once a minute (the ADR-0079 cache), one `agy models` and two `agy`
  print-mode calls. They spend no quota and start no conversation, and a signed-out CLI is never asked to sign in.
- The figures depend on an undocumented print-mode JSON shape of one CLI version. A changed shape gives `unknown`,
  never a wrong figure. The recorded fixtures pin 1.4.3.
- As ADR-0079 says for every reader, the report does not feed pacing or routing (`USAGE_KEYS` stays empty). The
  free-text `Resets in …` of `AGY_ERROR` stays unmapped (Q-100).

## Alternatives considered

- **Keep the Q-101 default (no probe).** Rejected: the operator asked for provider-reported figures, and this command is
  the only source that handles no credential.
- **Read the text output.** Rejected: the JSON payload is structured and carries the same figures unrounded.
- **A separate `group` field.** Rejected for now: `limit_id` already names the metered unit in ADR-0079's shape, and an
  extra field would change the shared schema for one provider.
