# Limit captures, follow-up (T6.11, 2026-10-18)

*Delegated agent work, documentation only; not owner-approved.* Follow-up to
[limit captures 2026-10-17](limit-captures-2026-10-17.md) for task T6.11 of
[ROADMAP §6.11](../ROADMAP.md#611-m6-capacity-and-resilience-tasks). It fills the `NOT_CHECKED` cells that the
operator hook's new captures answer, and updates the [T6.0 note](capacity-signals-2026-10-14.md) to match.

## Method and sources

- **Nothing was provoked.** No provider CLI was called for this note.
- The only source is the operator hook's directory `~/operator-runs/limit-captures/`: one redacted snippet per limit
  event, written by `~/operator-runs/limit-capture.sh` (see the
  [first note](limit-captures-2026-10-17.md#operator-hook-for-the-remaining-cells)). The hook reported
  `ALL-PROVIDERS: yes` before this note was started.
- New captures are those dated after 2026-10-17T06:30Z: 28 files (21 Cursor, 4 Grok Build, 1 each for Claude Code,
  Codex and OpenCode).
- A capture is used only if its snippet shows the CLI's own error line just before the launcher's `EXIT n` line. A
  marker that matched agent prose, a prompt or a header line is a false positive and is listed under
  [Excluded captures](#excluded-captures).
- Recorded here: the provider's own limit wording, key names, event types and exit codes. Not recorded: credentials,
  account or session identifiers, error ids, URL queries or transcript content.
- As in the first note, the launchers run every CLI in its text output mode (`plain` for Grok Build), so these are not
  the `stream-json` events a Switchboard adapter parses.

## Table

One row per provider with a new usable capture. The other providers are unchanged; their rows are in the
[2026-10-17 table](limit-captures-2026-10-17.md#table).

| Provider | What occurred | Message (provider's own words) | Event type / shape | Exit | Reset or retry field and format | Used or remaining figure | Structured? (Q-100) | Verdict | Capture files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Grok Build (version not in the captures; model key `grok-4.7-build`) | **Usage balance exhausted**, 4 worker runs on 2026-10-18 between 04:47Z and 09:12Z | `API error (status 402 Payment Required): Grok Build usage balance exhausted` | A JSON object after the prefix `Internal error:`, printed twice (once bare, once as `Error: Internal error: {…}`; which stream each went to is not recorded). Keys `message` (the text above) and `http_status` (`402`). In one capture it also carries `promptUsage` (below) | **1** | none (no reset time, window or retry-after in the object or the message) | `promptUsage` is the failing run's own usage, not a remaining figure: `inputTokens`, `outputTokens`, `totalTokens`, `cachedReadTokens`, `cacheCreationTokens`, `reasoningTokens`, `modelCalls`, `apiDurationMs`, `costUsdTicks`, per model `modelUsage.<model>.<same keys>`, and `numTurns` | `http_status` yes; the kind of stop ("usage balance exhausted") only in the free-text `message`; reset none | **PASS** (captured). `stream-json` shape **NOT_CHECKED**. Rate limit and overload **NOT_CHECKED** | `grok-20261018T044756Z.txt`, `grok-20261018T074056Z.txt`, `grok-20261018T074057Z.txt`, `grok-20261018T091202Z.txt` |
| Cursor CLI (`cursor-agent`, Composer) | **Out of usage** again, 21 worker runs from 2026-10-17 07:49Z to 2026-10-18 10:12Z | Identical to the [2026-10-17 row](limit-captures-2026-10-17.md#table): `ActionRequiredError: Increase limits for faster responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.` | Unchanged: the whole output is that one line in text mode | **1** | none | none | no (class name only) | **PASS** (same shape, repeated; nothing new). `stream-json` shape **NOT_CHECKED** | `cursor-20261017T074920Z.txt`, `cursor-20261017T101109Z.txt`, `cursor-20261017T111633Z.txt`, `cursor-20261017T132919Z.txt`, `cursor-20261017T151234Z.txt`, `cursor-20261017T175315Z.txt`, `cursor-20261017T192226Z.txt`, `cursor-20261017T210310Z.txt`, `cursor-20261017T220327Z.txt`, `cursor-20261017T223552Z.txt`, `cursor-20261017T230758Z.txt`, `cursor-20261017T234154Z.txt`, `cursor-20261018T011418Z.txt`, `cursor-20261018T013429Z.txt`, `cursor-20261018T023723Z.txt`, `cursor-20261018T032854Z.txt`, `cursor-20261018T035656Z.txt`, `cursor-20261018T045035Z.txt`, `cursor-20261018T084927Z.txt`, `cursor-20261018T091208Z.txt`, `cursor-20261018T101242Z.txt` |

### Grok Build key names

The Grok Build error object names its usage keys in camelCase (`cachedReadTokens`, `cacheCreationTokens`,
`costUsdTicks`). The successful runs of [live check 4a](live-checks-2026-10-14-grok.md) used snake_case on `usage`
(`cache_read_input_tokens`, `cache_creation_input_tokens`, `total_cost_usd_ticks`) and camelCase per model. So a
parser must not assume one naming across success and error output. These key names come from text-mode output only.

## Excluded captures

Their markers matched text that is not the CLI's own limit output, so nothing is recorded from them:

| Capture file | Marker | Why excluded |
| --- | --- | --- |
| `claude-20261017T094515Z.txt` | signature `AGY_ERROR` | Agent prose: a worker's summary that names Antigravity's `AGY_ERROR`. Exit 0, no CLI error line |
| `codex-20261017T121419Z.txt` | signature `You’ve hit your usage limit` | The marker text is in the header only; the snippet ends inside the CLI's startup output, with no limit line and no `EXIT n` line |
| `opencode-20261018T115720Z.txt` | signature `ActionRequiredError` | Agent prose: a diff and commit message about Cursor's limit mapping. Exit 0, no CLI error line |

## Candidates for T6.15

Only structured fields are candidates (FR-ADP-04, Q-100):

- **Grok Build:** `http_status = 402` in the `Internal error:` object, as a quota stop (`QUOTA_EXHAUSTED`). No reset
  key exists. Whether 402 is ever used for anything other than an exhausted balance is not sourced (Assumption to
  check before mapping), and the text-mode prefix may not match the `stream-json` shape.

No `USAGE_KEYS` candidate: no new capture carries a used or remaining fraction or a reset time. `promptUsage` is the
run's own consumption.

## Still NOT_CHECKED

Unchanged from the [2026-10-17 checks](limit-captures-2026-10-17.md#checks): every `stream-json` limit shape; Claude
Code `rate_limit_event` field values; Codex error event type, `code`, CLI exit code and token-usage key names; OpenCode
rate limit; Grok Build rate limit and overload; Muse Code (no login).

## Checks

| Check | Result |
| --- | --- |
| Only captures showing the CLI's own error line before `EXIT n` used | **PASS** (3 false positives excluded) |
| Grok Build limit text, exit code and error keys | **PASS** (402, exit 1, `message`, `http_status`) |
| Grok Build reset or remaining figure | **PASS** (none exists in these captures) |
| Grok Build `stream-json` limit shape, rate limit, overload | **NOT_CHECKED** |
| Cursor CLI limit text and exit code, repeated | **PASS** (unchanged) |
| Cursor CLI `stream-json` limit shape | **NOT_CHECKED** |
| Claude Code, Codex, OpenCode new limit output | **NOT_CHECKED** (only false positives) |
| No credential, account identifier or transcript content here | **PASS** |
