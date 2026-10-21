# Claude Code usage-window capture (2026-10-21)

*Delegated agent work, documentation only; not owner-approved.* Answers the question left open in the
[T6.0 note](capacity-signals-2026-10-14.md) and the [limit captures](limit-captures-2026-10-18.md): does Claude Code
print a structured used share and reset time for its 5-hour and 7-day windows, and can Switchboard read it without a
credential? Mechanism: [ADR-0085](../adr/0085-claude-code-usage-windows.md); requirement FR-CAP-15.

## Method and sources

- **Date and host:** 2026-10-21, the Ampere operator host, one Claude Code login (the operator's own).
- **CLI:** Claude Code 2.1.294; model `claude-haiku-5-5`.
- **Two calls only,** both with `</dev/null` in a scratch directory outside any repository:
  1. `claude -p --model claude-haiku-5-5 --tools "" --strict-mcp-config --permission-mode dontAsk
     --no-session-persistence --output-format stream-json --verbose "Reply with exactly: ok"`
  2. `claude -p "/usage"` (no model call: the result carries model `<synthetic>`, `total_cost_usd` 0 and `num_turns` 0).
- Recorded here: event types, key names, figures and reset times. Not recorded: account or organisation identifiers,
  session ids, request ids, credentials. The captured `rate_limit_event` is reproduced below with nothing removed
  except the identifiers that the stream also carries on other events.

## Captured output

`stream-json` emitted one `rate_limit_event` on the run, with status `allowed`:

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1792567800,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.03,"resetsAt":1792567800},"seven_day":{"utilization":0.06,"resetsAt":1792670400}}}}
```

`resetsAt` values are Unix seconds: 1792567800 is 2026-10-21T07:30Z and 1792670400 is 2026-10-22T12:00Z.

`claude -p "/usage"` printed three lines of text with the same figures:

```text
Current session: 3% used · resets Oct 21, 7:30am (UTC)
Current week (all models): 6% used · resets Oct 22, 12pm (UTC)
Current week (Fable): 0% used · resets Oct 22, 12pm (UTC)
```

## Findings by source

| Source | Works headless without a credential? | Finding |
| --- | --- | --- |
| `rate_limit_event` in `--output-format stream-json` | **Yes** | Emitted on every run, `allowed` included, not only on a limit. `unifiedWindows.five_hour` and `.seven_day` carry `utilization` (0 to 1) and `resetsAt` (Unix seconds). This is the source ADR-0079 reads |
| `claude -p "/usage"` | Yes, zero model tokens | Same figures as free text, with a year-less local-time reset ("Oct 21, 7:30am (UTC)"). Spawns the CLI and parses prose (FR-ADP-04 prefers structured fields). Not implemented; recorded as a possible follow-up |
| Statusline JSON `rate_limits.five_hour` and `.seven_day` (`used_percentage`, `resets_at`) | No | Documented in the CLI bundle; supplied only to a statusline command of the interactive TUI, which a headless run does not start |
| `anthropic-ratelimit-unified-*` response headers | No | The CLI derives `unifiedWindows` from them. Seeing them means calling the API with the login's OAuth token, which [ADR-0003](../adr/0003-no-credential-handling.md) forbids |
| OAuth usage endpoint behind `/usage` | No | Needs the login's credential; not used |
| OpenTelemetry metrics (`claude_code.token.usage`, `claude_code.cost.usage` and similar) | Not applicable | Token and cost counters of the run; no quota figure |
| `~/.claude` local state | Not applicable | No window figures found |

The `rate_limit_event` figures and the `/usage` text agree (3 % and 6 %), so `utilization` is a used share of the
window, not a remaining one.

## NOT_CHECKED

- A `rejected` event carrying `unifiedWindows` (the capture is `allowed` only; the adapter reads the windows whenever
  present).
- The shape of an `allowed_warning` event.
- Windows other than `five_hour` and `seven_day`, such as a per-model weekly window (the `/usage` text shows a
  "Current week (Fable)" line, but no matching `unifiedWindows` key appeared in the event).
- Whether `utilization` is measured before or after the request that produced the event.
- Behaviour on an API-key or Bedrock/Vertex login (the capture is a subscription login).
- Whether `overageStatus` and `isUsingOverage` should affect pacing; they are not read.
