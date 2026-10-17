# Capacity-signal inventory (T6.0, 2026-10-14)

*Delegated agent work, documentation only; not owner-approved.* Task T6.0 of
[ROADMAP §6.11](../ROADMAP.md#611-m6-capacity-and-resilience-tasks). For each provider Switchboard targets, this note
records what its headless output reports per run that the M6 capacity work could use: token counts, cache read and
creation counts ([Q-53](../ROADMAP.md#73-open-questions-for-zemdregon-not-blocking-m2-unless-noted)), cost, a
rate-limit or overload signal with its reset time, any remaining-quota or limit field, and whether the provider
publishes an enforceable rate limit for the auth mode Switchboard uses ([FR-CAP-07](../requirements/SRS.md)).

Nothing here was run for this note. Every cell cites an existing source in this repository: a live-check note, the
provider's [TDD §4](../design/TDD.md#4-provider-adapter-strategy) subsection (which cites the provider's documentation),
or adapter code and fixtures. A cell with no source reads `Unverified: <operator task>`. "Synthetic" marks a
hand-written test fixture: it shows what the parser assumes, not what the CLI prints. No limit, price, quota, reset
window or tier size is stated from memory.

## Table

| Provider | Token counts | Cache read / creation counts | Cost | Rate-limit or overload signal, reset time | Remaining quota or limit | Published enforceable limit for the auth mode in use (FR-CAP-07) |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `result.usage` keys copied as `usage.<key>` (any numeric key; names not listed in the parser, `src/adapters/claude/parse.ts`); a `result` with `usage` seen live ([live check 2026-10-14](live-checks-2026-10-14-claude-codex.md), check 4) | Key names: Unverified: T6.11 (the parser copies whatever `usage` holds; no cache key is named in a source we hold). *Update 2026-10-17:* `cache_creation_input_tokens`, `cache_read_input_tokens` observed ([live checks 2026-10-17](live-checks-2026-10-17-claude-codex.md#3-limit-and-usage-signals-t611-one-row-per-provider) §3) | `total_cost_usd`, a client-side estimate ([TDD §4.1](../design/TDD.md#41-claude-code-m2), known risks), recorded as reported, never as remaining quota | `rate_limit_event` occurs live on a successful run ([live check 2026-10-14](live-checks-2026-10-14-claude-codex.md), check 4; field values not captured); the parser maps only `rate_limit_info.status = "rejected"` to `rate_limit` with `resetsAt` (seconds) and `rateLimitType` from a **synthetic** fixture (`src/adapters/claude/fixtures/rate-limit.jsonl`). Error categories `rate_limit`, `overloaded`, billing ([TDD §4.1](../design/TDD.md#41-claude-code-m2)). Live shape of a rejection: Unverified: T6.11. *Update 2026-10-17 ([limit captures 2026-10-17](limit-captures-2026-10-17.md)):* a real weekly limit in text mode printed `You've hit your weekly limit · resets 12pm (UTC)` with exit 1 (a free-text reset, an hour with no date); the `stream-json` rejection is still NOT_CHECKED | None in any source we hold. Whether a non-rejected `rate_limit_event` carries a usable figure: Unverified: T6.11. *Update 2026-10-17:* still NOT_CHECKED (field values not captured); the weekly-limit text has no figure ([limit captures 2026-10-17](limit-captures-2026-10-17.md)) | None sourced |
| Codex | Token-usage event family ([TDD §4.2](../design/TDD.md#42-codex-m2), structured output); `input_tokens`, `output_tokens` in **synthetic** fixtures only (`src/adapters/codex/fixtures/success_edit.jsonl`); stream assumptions unchecked live (Q-13) | `cached_input_tokens` in **synthetic** fixtures only; Unverified: T6.11. *Update 2026-10-17:* still NOT_CHECKED; text-mode `exec` prints only a `tokens used` total ([limit captures 2026-10-17](limit-captures-2026-10-17.md)) | None sourced | `rate_limit_exceeded` error category mapped to `rate_limit` (`src/adapters/codex/protocol.ts`, an Assumption); reset field: none sourced. Unverified: T6.11. *Update 2026-10-17 ([limit captures 2026-10-17](limit-captures-2026-10-17.md)):* a real quota stop (0.162.0) is free text, `You’ve hit your usage limit … try again at Oct 22nd, 2026 6:19 AM` (no time zone), and the adapter classified it `unknown`, so the `usage_limit_exceeded` code was not seen; event type and exit code NOT_CHECKED | "Token usage does not reveal remaining subscription capacity" ([TDD §4.2](../design/TDD.md#42-codex-m2), known risks) | None sourced |
| Grok Build | `usage` `input_tokens`, `output_tokens`, `reasoning_tokens`, `total_tokens`, and per-model `modelUsage` (observed, [live check 4a](live-checks-2026-10-14-grok.md)) | `cache_read_input_tokens`, `cache_creation_input_tokens`; per model `cacheReadInputTokens`, `cacheCreationInputTokens` (observed, live check 4a) | `total_cost_usd`, `total_cost_usd_ticks`, per model `costUSD` (observed, live check 4a); whether client-side: Unverified: T4.21 follow-up | Not forced, not observed ([live check 5d](live-checks-2026-10-14-grok.md)); "limits and resets are not documented" ([TDD §4.3](../design/TDD.md#43-grok-build-m4), capacity row) | None documented (TDD §4.3) | None sourced |
| Antigravity | `usage` `input_tokens`, `output_tokens`, `thinking_tokens`, `total_tokens` (observed, [live check C4](live-checks-2026-10-14-antigravity.md); [TDD §4.4](../design/TDD.md#44-antigravity-agy-m4)) | `cache_read_tokens` (observed, live check C4); no creation count in any source | None in the run output | `AGY_ERROR` fields for rate limit, overload and quota: names Unverified: T4.31 (TDD §4.4, failure mapping). *Update 2026-10-17 ([limit captures 2026-10-17](limit-captures-2026-10-17.md)):* a real quota stop in text mode exits 3 with `AGY_ERROR` keys `short_error`, `status` (`RESOURCE_EXHAUSTED`), `error_code` (429), `code_kind`, `retryable`, `error_id`; the reset is free text (`Resets in <h>h<m>m<s>s`) | **Reported, by a separate zero-cost call:** `agy -p "/usage" --output-format json` returns `command.data.groups[].buckets[]` with `window` (weekly, 5h), `remaining_fraction` and `reset_time`; `/credits` returns `remaining_credits` (observed, live check C6). This is the only provider-reported remaining figure in any source we hold | None sourced |
| Cursor CLI | `usage` `inputTokens`, `outputTokens` on `result` (observed, [live check 5a](live-checks-2026-10-14-cursor.md)) | `cacheReadTokens`, `cacheWriteTokens` (observed, live check 5a) | No cost field (live check, usage row) | None sourced: Unverified: T4.41 follow-up. *Update 2026-10-17 ([limit captures 2026-10-17](limit-captures-2026-10-17.md)):* a real usage stop in text mode exits 1 with one line, `ActionRequiredError: … You're out of usage. …`, with no reset; the stream shape is still NOT_CHECKED | None sourced | None sourced |
| OpenCode | `step_finish` `part.tokens` `input`, `output`, `reasoning` ([TDD §4.6](../design/TDD.md#46-opencode-m4), `[T-ev]`); tokens present on `step_finish` live ([live check 5](live-checks-2026-10-14-opencode.md)) | `part.tokens.cache.read`, `cache.write` (TDD §4.6, documented; key presence live not recorded) | `part.cost` (USD; `0` on the free model seen live, check 5) | `error` `provider.quota`, status 402 seen live for a quota failure (check 14b); rate-limit shape: none sourced | "Nothing found, so no capacity claim" (TDD §4.6, usage row) | None sourced |
| Kimi Code | Unverified: T4.61 (B-1) | Unverified: T4.61 | Unverified: T4.61 | Unverified: T4.61. *Update 2026-10-17 ([limit captures 2026-10-17](limit-captures-2026-10-17.md)):* a real 5-hour quota stop (2.1.1, text mode) exits 1 with `error: failed to run prompt: provider.auth_error: 403 You've reached your 5-hour usage limit. …`, with no reset time; the stream shape is NOT_CHECKED | `/usage` and `/status` exist in the TUI; headless: Unverified: T4.61 ([TDD §4.7](../design/TDD.md#47-kimi-code-m4-blocked-by-b-1)) | None sourced |
| Muse Code | Per-run token fields: Unverified: T4.71 ([TDD §4.8](../design/TDD.md#48-muse-code-m4)) | Unverified: T4.71 | Usage-based billing with a dashboard; no CLI usage report documented (TDD §4.8) | No limit or reset documented (TDD §4.8) | None documented | None sourced |

## What follows for M6

- **`explicit_remaining` (FR-CAP-02, FR-CAP-03).** No run output in any source reports remaining quota. The only
  provider-reported remaining figure is Antigravity's `/usage` call, a separate command whose machine-readable shape was
  observed once (live check C6). Until an adapter declares a remaining-capacity key and a task wires it (Antigravity
  only, after its adapter exists, T4.32 onward), `explicit_remaining` is `null` for every provider. M6 does not run
  `/usage` itself: calling a provider CLI outside a run is a new probe whose cost and terms are not reviewed (Q-59).
- **Cache counts (FR-CAP-08, Q-53).** Observed live: Grok Build (read and creation), Cursor (read and write),
  Antigravity (read only). Documented, not observed: OpenCode (read and write). Synthetic only: Codex
  (`cached_input_tokens`). Unknown: Claude Code, Kimi Code, Muse Code. T6.7 maps only the observed and documented key
  shapes, each labelled with its source; others stay absent.
- **Reset times (FR-CAP-06, BR-9).** Only the Claude Code parser reads a reset time, from a synthetic fixture shape;
  Antigravity's `/usage` has `reset_time` per bucket. Every other provider: none. So BR-9 queueing on a known reset is
  possible on the fake adapter and, after T6.11, perhaps on Claude Code; for the others a quota failure fails over or
  returns `QUOTA_EXHAUSTED`.
- **FR-CAP-07.** No source we hold publishes an enforceable rate limit for the subscription logins Switchboard uses.
  T6.8 stays blocked and becomes `Deferred` unless a source appears.

## Operator checks this adds

For T6.11 (Claude Code and Codex, only from normal use, never by generating load):
*Update 2026-10-17:* T6.11 now covers every provider; the results, check by check, are in
[limit captures 2026-10-17](limit-captures-2026-10-17.md).

1. Claude Code: the field values of a non-rejected `rate_limit_event` (key names only; no account identifier), and the
   shape of a `rejected` one if it occurs; the `usage` key names on `result`, including any cache keys.
2. Codex: the token-usage event's key names, including any cached-token key, and the error event of a rate limit or
   quota stop if one occurs.

For the M4 operator checklists (to be added there by the M4 work, which owns TDD §4): the rate-limit and quota error
shapes of Grok Build (T4.21 follow-up), Antigravity (`AGY_ERROR` field names, T4.31), Cursor (T4.41 follow-up), Kimi Code
(T4.61) and Muse Code (T4.71), and OpenCode's cache key presence on a live `step_finish` (T4.51 follow-up).
