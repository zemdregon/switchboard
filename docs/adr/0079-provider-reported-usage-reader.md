# ADR-0079: Provider-reported usage reader (Codex first)

- Status: Accepted (built 2026-10-21).
- Date: 2026-10-21
- Decided by: Delegated agent work on an operator task (2026-10-21), not owner-approved. The gap (no real provider quota
  figure anywhere in the projection) comes from the operator's task; the details marked **Delegated** or **Proposed**
  were chosen while building it.
- Related: FR-CAP-13, FR-CAP-01, FR-CAP-03, FR-CAP-09, FRD BR-50,
  [ADR-0003](0003-no-credential-handling.md) (no credential handling, holds),
  [ADR-0055](0055-model-groups-and-usage-pacing.md) (usage windows and pacing, unchanged),
  [LLD §16.10](../design/LLD.md#1610-provider-reported-usage-reader-fr-cap-13-adr-0079),
  [research note](../research/codex-usage-2026-10-21.md),
  [ROADMAP T6.17](../ROADMAP.md#611-m6-capacity-and-resilience-tasks).

## Context

An audit on 2026-10-20 found that Switchboard showed no real provider quota figure. `get_capacity` carried
controller estimates, and `explicit_remaining` and `reset_at` were `null` for every provider because the sourced key
lists (`REMAINING_KEYS`, `USAGE_KEYS`) are empty: no provider's run output names a remaining quota. `get_capacity` was
documented as read-only and as never calling a provider. Codex does expose the signed-in account's rate-limit windows
through `codex app-server` (JSON-RPC `account/rateLimits/read`), with no model call; the finding and the sources that
were rejected are in the [research note](../research/codex-usage-2026-10-21.md).

## Decision

1. **Optional adapter method `readProviderUsage(runner, now)`.** An adapter that can read its provider's own usage
   figures implements it; the shared result types are `ProviderUsageReport` (source `provider_reported`) and
   `ProviderUsageUnavailable` (source `unknown`, with a short reason).
2. **Codex reads through `codex app-server`.** It runs the CLI through the existing probe runner with an environment
   allowlist of `PATH` and `HOME`, sends `initialize`, `initialized` and `account/rateLimits/read`, and holds stdin open
   until the answer arrives. No model call. The CLI uses its own login: Switchboard reads no credential and no file under
   `~/.codex` (ADR-0003 holds). Fields such as `accountId` are dropped.
3. **Overlay, not replacement.** `get_capacity`, `switchboard capacity` (text and `--json`) and `switchboard doctor`
   (a separate informational section that never changes `ok`) show the report as `provider_usage` beside each provider's
   existing entry. The projection (`capacity_score`, `explicit_remaining`, `reset_at`, `pacing`, routing) is unchanged.
4. **Cache.** Per process, one minute (**Proposed**, **Delegated**), so repeated calls do not start the CLI each time.
5. **Unknown is never headroom (BR-50).** A spawn failure, a timeout (15 s, **Proposed**) or a JSON-RPC error gives
   `source: "unknown"` with a reason. `limit_reached` comes only from the provider's own flags, never from a full window.
6. **No ledger write, no routing input (yet).** The report is not stored and feeds neither routing, pacing nor the
   score. Feeding it into pacing is possible follow-up work and is not done here.
7. **Statement amended.** "`get_capacity` never calls a provider" no longer holds as written: it now runs the provider
   CLI's own read-only account call, only for enabled providers whose adapter has a reader. It never makes a model call
   and never reads a credential.

## Consequences

- Operators see the real Codex windows, plan and credits next to the estimates, labelled `provider_reported`.
- `get_capacity` can start one short child process per enabled provider with a reader, at most once a minute each.
- Other providers gain the same surface by implementing the method; none is claimed today.
- The reached-limit shape is covered by the generated schema and a synthetic fixture, not a live capture.

## Alternatives rejected

- **Scraping rollout files** (`~/.codex/sessions/**/rollout-*.jsonl`, `token_count` events): real, but only as fresh as
  the last turn, and the files hold full transcripts. Kept as a documented fallback only.
- **`x-codex-*` response headers or the ChatGPT usage dashboard or backend API:** would need Switchboard to hold the
  Codex token or a browser session (ADR-0003).
- **`codex exec --json` stdout and the `/status` slash command:** the first carries token counts only, the second is
  interactive.
- **A separate MCP tool:** the data belongs beside the projection it qualifies; a second tool would split the picture.
