# Codex real usage and rate limits (2026-10-21)

*Delegated agent work; not owner-approved.* Question: how can Switchboard show the signed-in Codex account's real quota
windows instead of only controller estimates? The answer feeds [ADR-0079](../adr/0079-provider-reported-usage-reader.md)
and FR-CAP-13. Verified live on 2026-10-21 with codex-cli 0.162.0, through the budgeted operator channel, one read.
Codex was no longer quota-stopped at the time, so the reached-limit shape comes from the generated schema and a synthetic
fixture, not a live capture. Values below are redacted where marked.

## Sources tried

| # | Source | Result |
| --- | --- | --- |
| 1 | `codex app-server`, JSON-RPC `account/rateLimits/read` | Works. Real figures, no model call, under 1 s. **Used.** |
| 2 | Rollout files `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Works but passive; not used (below). Documented fallback. |
| 3 | `codex exec --json` stdout | Token counts only. |
| 4 | `/status` TUI slash command | Interactive only. |
| 5 | `x-codex-*` response headers; ChatGPT usage dashboard or backend API | Rejected: needs Codex's token or browser session (ADR-0003). |

### 1. `codex app-server` (used)

The method names were found with `codex app-server generate-json-schema --out <dir>`, which also lists
`account/usage/read`, the `account/rateLimits/updated` notification and `account/read`. Switchboard sends three JSON-RPC
lines on stdin: `initialize` (id 1), the `initialized` notification, and `account/rateLimits/read` (id 2) with
`excludeResetCreditDetails: true`. The process exits at stdin end-of-file before it answers, so stdin must be held open
until the id-2 answer arrives (`holdStdinUntil` in the probe runner).

Redacted answer, 2026-10-21T02:36Z:

| Key | Value |
| --- | --- |
| `ordinaryUsageAllowed` | `true` |
| `rateLimits.limitId` | `"codex"` |
| `rateLimits.primary` | `usedPercent` 21, `windowDurationMins` 300, `resetsAt` 1792563926 |
| `rateLimits.secondary` | `usedPercent` 22, `windowDurationMins` 10080, `resetsAt` 1793082847 |
| `credits` | `hasCredits` true, `unlimited` false, `balance` redacted |
| `spendControlReached` | `false` |
| `planType` | `"plus"` |
| `rateLimitReachedType` | `null` |
| `rateLimitResetCredits.availableCount` | 0 |
| `accountId` | redacted (dropped by Switchboard) |

The 300-minute and 10080-minute windows are the five-hour and weekly windows.

### 2. Rollout files (fallback only)

`event_msg` records with `payload.type` `token_count` carry `rate_limits` in snake_case: `limit_id`,
`primary{used_percent, window_minutes, resets_at}`, `secondary{...}`, `credits{has_credits, unlimited, balance}`,
`plan_type`, `rate_limit_reached_type`, plus `info.total_token_usage`, `last_token_usage` and `model_context_window`. This
is real but only as fresh as the last turn, and the files also hold full transcripts, so reading them would put
conversation content in Switchboard's reach. Not used.

### 3 to 5

`codex exec --json` prints `turn.completed.usage` tokens (already recorded per run) and no rate limits. `/status`
needs a terminal UI. The `x-codex-*` headers and the ChatGPT usage backend are reachable only with Codex's own token
or session, which Switchboard never handles.

## Outcome

Source 1, with the CLI's own login, an environment allowlist of `PATH` and `HOME`, and no read of any file under
`~/.codex`. Implementation: `src/adapters/codex/usage.ts`; design:
[LLD §16.10](../design/LLD.md#1610-provider-reported-usage-reader-fr-cap-13-adr-0079).
