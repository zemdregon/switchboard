# Limit captures, every provider (T6.11, 2026-10-17)

*Delegated agent work, documentation only; not owner-approved.* Task T6.11 of
[ROADMAP §6.11](../ROADMAP.md#611-m6-capacity-and-resilience-tasks), generalised to every provider by owner decision 57.
It records what each provider CLI printed when it hit a usage, rate or quota limit in normal use. It updates the
`Unverified: T6.11` cells of the [T6.0 note](capacity-signals-2026-10-14.md) and the parser Assumptions. It extends
§3 of [live checks 2026-10-17](live-checks-2026-10-17-claude-codex.md#3-limit-and-usage-signals-t611-one-row-per-provider)
and corrects it for Claude Code, Cursor CLI and Kimi Code (see [Corrections](#corrections)).

## Method and sources

- **Nothing was provoked.** No provider CLI was called for this note. Codex has been quota-stopped since its first call
  of the day (stated reset 2026-10-22 06:19), so it was not called again.
- The sources are the two that T6.11 allows. (a) The budgeted live-run channel: `~/operator-runs/live-logs/`, already
  scrubbed. (b) The operator logs on the host from normal use: worker logs `~/operator-runs/w<N>-*.log`,
  merge-steward logs and doc-alignment-gate logs.
- The worker launchers append a header `=== <LABEL> (<model>) <date>` each time a tag is relaunched on another
  provider. Each limit line is attributed to the provider of the section it appears in. A log with no header is
  attributed to the launcher that created it, which the steward's notes in `assignments.md` name.
- Recorded here: the provider's own limit wording, key names, event types, exit codes and the output mode. Not
  recorded: credentials, account or session identifiers, `error_id` values and transcript content. The redacted raw
  snippets stay on the operator host (`~/operator-runs/limit-captures/`, below).
- "Exit" is the CLI's exit code, from the `EXIT n` line the launcher appends after the CLI returns.
- The launchers run every CLI in its **text** output mode (`--output-format text`, or `plain` for Grok Build). So
  these captures show the human-readable line, not the `stream-json` event a Switchboard adapter would parse. The one
  exception is Codex: Switchboard's own adapter ran it through `adapters validate codex`.

## Table

| Provider | What occurred | Message (provider's own words) | Event type / shape | Exit | Reset or retry field and format | Used or remaining figure | Structured? (Q-100) | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code (version not in those logs) | **Weekly limit**, 4 worker runs on 2026-10-15 between 05:07Z and 06:10Z (`w245`, `w246`, `w250`, `w251`; Opus and Fable, so one shared limit) | `You've hit your weekly limit · resets 12pm (UTC)` | One stdout line under `--output-format text`; no event | **1** | Free text: wall-clock hour and zone, no date (`resets 12pm (UTC)`) | none | no | limit text, exit code **PASS**. `stream-json` shape of a rejection (`rate_limit_event` with `status: "rejected"`, `resetsAt`) **NOT_CHECKED** |
| Codex 0.162.0 | **Quota stop** on the first call of 2026-10-17 (03:33Z, `adapters validate codex` smoke, `exec --json`) | `You’ve hit your usage limit. Upgrade to Pro (…), visit … to purchase more credits or try again at Oct 22nd, 2026 6:19 AM.` | Only as the adapter re-printed it: `TOOL_FAILURE (unknown: <message>)`. The validate smoke keeps no stream | not captured (the check exited 1) | Free text: `try again at <Mon> <D>(st\|nd\|rd\|th), <YYYY> <h>:<mm> AM\|PM`, **no time zone** (the host is UTC) | none in the message | unknown | **FAIL** for classification (`unknown`, not a quota code). Event type, error `code` and CLI exit code **NOT_CHECKED** |
| Cursor CLI (`cursor-agent`, Composer 2.5) | **Out of usage**: 53 consecutive merge-loop passes from 2026-10-16 22:25Z, 21 doc-alignment-gate runs from 23:05Z to 02:02Z (the gate's log records each; the agent logs were overwritten later), and the fix workers `w861` (2026-10-17 02:25Z) and `w862` (04:02Z) | `ActionRequiredError: Increase limits for faster responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.` | The whole output is that one line under `--output-format text`; it starts with an error class name, `ActionRequiredError` | **1** | none (no reset time or window in the message) | none | no (class name only) | **PASS** (captured). `stream-json` shape **NOT_CHECKED** |
| Grok Build | No limit seen in any log | | | | | | | **NOT_CHECKED** |
| Antigravity (`agy`) | **Quota stop**, 7 worker runs on 2026-10-15 and 2026-10-16 (`w345`, `w350`, `w360`, `w362`, `w375`, `w385`, `w571`), as in the earlier note | stderr `error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in <h>h<m>m<s>s.` then one line `AGY_ERROR: {…}` | `AGY_ERROR` JSON keys `short_error`, `status` (`RESOURCE_EXHAUSTED`), `error_code` (`429`), `code_kind` (`http`), `retryable` (`true`), `error_id` | **3** | Free text inside `short_error` and the stderr line: a relative duration, `Resets in 2h0m56s` down to `Resets in 21s`; once `Resets in 121h22m9s` (2026-10-16, a weekly window) | none | `status`, `error_code`, `retryable` yes; reset no | **PASS** (captured). `--output-format json` shape **NOT_CHECKED** |
| OpenCode | No limit in the operator logs. The 2026-10-14 live check saw a quota failure, `error` `provider.quota` with status 402 ([live check 14b](live-checks-2026-10-14-opencode.md)) | | `type: "error"`, `error.type: "provider.quota"` (2026-10-14) | | none sourced | none | yes (2026-10-14) | quota shape **PASS** (2026-10-14, not new). Rate limit **NOT_CHECKED** |
| Kimi Code 2.1.1 | **5-hour quota**, 6 runs: 2026-10-14 01:17Z (a k3 operator run), 2026-10-15 (`w362`, `w369`, `w373`, `w391`) and 2026-10-16 (`w596`) | `error: failed to run prompt: provider.auth_error: 403 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: <url>` then `See log: ~/.kimi-code/logs/kimi-code.log` | Text under `-p` (default text output). The error kind it prints is **`provider.auth_error`** with HTTP **403**, although this is a quota stop | **1** | none: "when the current 5-hour window ends", with no time | none | no (kind and status are inside free text) | **PASS** (captured). The `stream-json` shape **NOT_CHECKED**. Note the hazard: a parser that keys on the kind would read it as an auth failure |
| Muse Code | Skipped (owner deferral; no login) | | | | | | | **NOT_CHECKED** |

### Usage and cache key names

No new key names were captured: every limit occurred in text mode. Recorded already, and unchanged:

- Claude Code `result.usage`, including the cache keys `cache_creation_input_tokens` and `cache_read_input_tokens`
  (live checks 2026-10-17 §3).
- Grok Build, Antigravity and Cursor (T6.0 table).
- OpenCode `part.tokens` (T6.0 table).

Codex `exec` in text mode prints only a human total (`tokens used` and a number on the next line) in 21 worker logs.
That is not a key name, so the Codex token-usage key names stay **NOT_CHECKED**. Kimi Code `stream-json` showed no usage
event in the one recorded sample (`system.version`, `assistant`, `session.resume_hint`), so its usage keys are also
**NOT_CHECKED**.

## Corrections

1. **The "Claude limit until 02:19:30Z" of 2026-10-17 was Cursor's message.** The merge steward recorded
   `opus-limit-until 2026-10-17T02:19:30Z` after a doc-alignment-gate run at 01:19Z failed with "You're out of usage".
   At that time the gate ran only `cursor-agent` (its Claude fallback was added and later replaced between 02:05Z and
   02:22Z). The text is Cursor's `ActionRequiredError` line. So it is a Cursor capture, and the steward's attribution
   **FAILS**. No Claude limit occurred on 2026-10-16 or 2026-10-17.
2. The live checks of 2026-10-17 §3 found no real occurrence for Cursor CLI and Kimi Code. That came from a search that
   matched only synthetic test text. Both had real occurrences, listed above. It also found no Claude Code limit;
   the weekly limit of 2026-10-15 is above.

## Parser Assumptions against these captures

| Adapter | Assumption in the parser | What the capture shows |
| --- | --- | --- |
| Claude Code (`src/adapters/claude/parse.ts`) | `rate_limit_event` with `rate_limit_info.status = "rejected"`, `resetsAt` and `rateLimitType` (synthetic fixture `rate-limit.jsonl`); error categories `rate_limit`, `billing_error` | Not confirmed and not contradicted: the only real limit was in text mode. The text-mode reset is a wall-clock hour with no date. The header comment now says so |
| Codex (`src/adapters/codex/protocol.ts`) | Errors carry a structured `code`; `usage_limit_exceeded` maps to `quota`, `rate_limit_exceeded` to `rate_limit` | A real quota stop classified `unknown`. So the event carried no `code` in `ERROR_CODE_CATEGORIES`, or no `code` at all. `usage_limit_exceeded` is still unconfirmed. The comment now says so |
| Antigravity | No `AGY_ERROR` or rate-limit shape is recorded; an `ERROR` envelope classifies `TOOL_FAILURE` (synthetic fixtures `rate_limit*.jsonl`) | `AGY_ERROR` is real, with exit 3 and the keys above, in text mode. M4 owns the adapter, so its code is not edited here; this is a T6.15 candidate |
| Cursor CLI | No rate-limit shape is recorded; an empty stream at exit 1 classifies `TOOL_FAILURE` (synthetic `rate_limit*.jsonl`) | Text-mode `ActionRequiredError` line, exit 1. The stream shape is still unknown, so the Assumption stands |
| Kimi Code | No limit shape is recorded | The text line names `provider.auth_error` and 403 for a quota stop. Whatever Kimi's stream event is, it must not be keyed on "auth" alone |
| Grok Build, OpenCode, Muse Code | Synthetic rate-limit fixtures only (OpenCode `provider.quota` is recorded, 2026-10-14) | Nothing new |

## Candidates for T6.15

Only structured fields are candidates (FR-ADP-04, Q-100):

- **Antigravity:** `AGY_ERROR.status = "RESOURCE_EXHAUSTED"`, `error_code = 429` and `retryable`, mapped to
  `QUOTA_EXHAUSTED`. No reset key exists; the duration "Resets in …" is free text and stays unmapped.
- **OpenCode:** `error.type = "provider.quota"`. It is already mapped.

Not candidates, because they are free text only:

- Claude Code (`resets <hour> (<zone>)`).
- Codex (`try again at <date> <time>`).
- Cursor (`ActionRequiredError`, no reset).
- Kimi Code (`provider.auth_error: 403 … 5-hour usage limit`).

If Q-100 allows a free-text reset, Codex's absolute date and Antigravity's relative duration are the only parseable
ones. Codex's has no time zone. Claude Code's names an hour but no date.

*Outcome (T6.15, 2026-10-17):* the Antigravity `status` is mapped to `QUOTA_EXHAUSTED` in the adapter's
`classifyFailure` from the stderr tail (`src/adapters/antigravity/protocol.ts`, tests in
`src/adapters/antigravity/limit-signals.test.ts`, synthetic fixture `agy_error_quota.jsonl` from the key names above).
No `USAGE_KEYS` entry was declared: no capture carries a structured used or remaining figure or reset time
([ROADMAP T6.15](../ROADMAP.md#611-m6-capacity-and-resilience-tasks)).

## Checks

| Check | Result |
| --- | --- |
| One row per provider, from normal use only, nothing provoked | **PASS** |
| Claude Code limit text and exit code | **PASS** (weekly limit, exit 1) |
| Claude Code `rate_limit_event` field values, and a rejected one in `stream-json` | **NOT_CHECKED** |
| Claude Code `usage` key names | **PASS** (live checks 2026-10-17 §3) |
| Codex quota stop text | **PASS** |
| Codex adapter classification of a quota stop | **FAIL** (`TOOL_FAILURE`/`unknown`) |
| Codex error event type, `code` and CLI exit code; token-usage key names | **NOT_CHECKED** |
| Cursor CLI limit text and exit code | **PASS** |
| Antigravity `AGY_ERROR` keys and exit code | **PASS** |
| Kimi Code limit text and exit code | **PASS** |
| OpenCode quota shape | **PASS** (2026-10-14); rate limit **NOT_CHECKED** |
| Grok Build, Muse Code | **NOT_CHECKED** |
| Steward's provider attribution of limit text | **FAIL** once (correction 1) |
| No credential, account identifier or transcript content here | **PASS** |

## Operator hook for the remaining cells

From 2026-10-17 the operator host records every new limit event as it happens. The script is
`~/operator-runs/limit-capture.sh`, called after each run by the worker launchers, the merge loop, `live-run.sh` and
`live-run-ext.sh`. It writes `~/operator-runs/limit-captures/<provider>-<UTC time>.txt`, with the source log, the exit
code, the matching marker and a redacted snippet. The merge steward notes each new capture in its pass notes. Once
every provider has one, it launches a follow-up docs task that fills the `NOT_CHECKED` cells above. The 21 captures
behind this note were backfilled into that directory from the logs listed in the table.
