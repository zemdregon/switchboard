# Grok Build usage sources (2026-10-21)

Research for [ADR-0080](../adr/0080-grok-build-usage-reader.md) (FR-CAP-13, on the
[ADR-0079](../adr/0079-provider-reported-usage-reader.md) interface). Host: Ampere operator host, grok 1.0.50.
Delegated agent work; one tiny budgeted live turn was run through the operator's budgeted channel. No credential was
read or recorded.

## Question

Where can Switchboard get real, provider-reported usage for Grok Build without calling a model and without holding a
credential (ADR-0003, FR-AUTH-02)?

## Sources examined

| Source | Result | Why |
| --- | --- | --- |
| ACP extension method `x.ai/billing` (wire name `_x.ai/billing`) on `grok agent --no-leader stdio` | **Works; used** | Backs the TUI `/usage` modal ("Usage limit" tab). No model call. Grok fetches it from xAI (`/billing?format=credits`) with its own cached login. |
| `grok usage <session>` | Does not fit | Per-session tokens and cost only, no account window. |
| `streaming-json` `end` line `total_cost_usd_ticks` | Does not fit | Per run and already read by the adapter. |
| 402 "usage balance exhausted" error | Does not fit | Failure-only; handled as a captured signature (ADR-0058). |
| `x.ai/auth/check_subscription` | Rejected | Returns an email address and team id (personal data); not needed. |
| xAI management REST API | Rejected | Would need Switchboard to hold an API key; ADR-0003 forbids. Open as ROADMAP Q-114 (default no). |

## Exchange

JSON-RPC `initialize`, then `_x.ai/billing {}`, as JSON lines on stdin. The agent exits at stdin end-of-file before it
answers, so stdin is held open until the id-2 answer arrives (about one second on this host). The `initialize` answer
carries an agent id and hostname and is discarded.

Method of research: the installed CLI's `--help`, its bundled user guide (`~/.grok/docs/user-guide`, chapters 04, 14, 17,
23 and 24) and strings in the binary (`xai-grok-shell/src/extensions/billing.rs`, `x.ai/billing`,
`/billing?format=credits`). The web search tools were not available in the session, so public xAI documentation was not
checked.

## Answer shape (redacted; recorded on a SuperGrok account)

```jsonc
{ "config": { "currentPeriod": { "type": "USAGE_PERIOD_TYPE_WEEKLY", "start": "<ISO>", "end": "<ISO>" },
              "onDemandCap": { "val": 0 }, "onDemandUsed": { "val": 0 }, "prepaidBalance": { "val": 0 },
              "isUnifiedBillingUser": true, "billingPeriodStart": "<ISO>", "billingPeriodEnd": "<ISO>" },
  "subscription_tier": "SuperGrok" }
```

The binary's `BillingConfig` also names `creditUsagePercent`, `monthlyLimit` and `history[]`. They were absent on this
account before and after one tiny budgeted live turn, so Switchboard reports them as missing, never 0.

## Assumptions and open points

- **Assumption:** `creditUsagePercent` is a percent 0..100 (the name and the TUI modal suggest it; not observed).
- The `val` amounts have no stated unit. Switchboard labels them `unspecified` and never claims USD.
- `x.ai/billing` is an extension read from the binary and one live check, not a documented interface. It may change; the
  reader whitelists fields and reports `unavailable` on an unrecognised shape.
- Whether usage figures should move from this separate surface into the pacing windows is a follow-up (T6.18 note).
