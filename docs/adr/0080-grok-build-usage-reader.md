# ADR-0080: Grok Build usage reader through the ACP `x.ai/billing` call

- Status: Accepted (built 2026-10-21).
- Date: 2026-10-21
- Decided by: Delegated agent work on an operator task (2026-10-21), not owner-approved. The goal (real,
  provider-reported usage for Grok Build) comes from the operator's task; every default marked **Delegated**,
  **Proposed** or **Assumption** was chosen while building it.
- Related: FR-CAP-13, FR-CAP-03, FR-AUTH-02, FRD BR-50, [ADR-0079](0079-provider-reported-usage-reader.md) (the reader
  interface this builds on), [ADR-0003](0003-no-credential-handling.md) (no credential handling, holds),
  [ADR-0058](0058-captured-limit-signatures.md) (failure-only limit signatures, unchanged),
  [LLD §16.10](../design/LLD.md#1610-provider-reported-usage-reader-fr-cap-13-adr-0079),
  [research note](../research/grok-usage-sources-2026-10-21.md), ROADMAP T6.18, Q-101, Q-114.

## Context

Before this change Switchboard knew about Grok Build usage only from per-run token and cost counters and from the 402
"usage balance exhausted" failure. ADR-0079 added an optional adapter method, `readProviderUsage`, that reads the
signed-in account's usage through the provider's own CLI. Grok Build's TUI shows the account allowance in its `/usage`
modal. That data comes from the ACP extension method `x.ai/billing` on `grok agent stdio`, which Grok answers from xAI
with its own cached login and without a model turn (research note).

## Decision

1. `GrokAdapter.readProviderUsage` runs `grok agent --no-leader stdio` through the existing probe runner, with the probe
   environment allowlist (`PATH`, `HOME`) and a 20 s timeout (**Proposed**). It writes `initialize` (id 1) and
   `_x.ai/billing` (id 2) as JSON lines and holds stdin open until the id-2 answer, because the agent exits at stdin
   end-of-file before it answers. `--no-leader` keeps the read from attaching to, or starting, a shared leader process.
2. Only whitelisted fields are kept: `config.currentPeriod` (`type`, `start`, `end`), `config.billingPeriodStart` and
   `billingPeriodEnd` (fallback), `config.creditUsagePercent`, the `val` of `config.prepaidBalance`, `onDemandCap`,
   `onDemandUsed` and `monthlyLimit`, and `subscription_tier`. The `initialize` answer (agent id, hostname), stderr and
   every other field are dropped. `x.ai/auth/check_subscription` is not called because it returns an email address and
   a team id.
3. ADR-0079's report gains three optional, additive fields, so a provider that reports a period or amounts without a
   used share can still say so: `period` (`kind`, `starts_at`, `resets_at`), `amounts[]` (`id`, `value`,
   `unit: "unspecified"`, `key`) and `unreported[]` (keys the reader knows but the answer omitted). Codex output does
   not change.
4. `creditUsagePercent`, when present, becomes the window `credit_period` (**Assumption:** a percent from 0 to 100).
   When absent, as on the recorded SuperGrok account, there is no window and the key is listed in `unreported`. A
   missing figure is unreported, never 0 (BR-50).
5. The `val` amounts carry no stated unit, so they are labelled `unspecified`; Switchboard never calls them dollars.

## Consequences

- `get_capacity`, `switchboard capacity` and `doctor` show Grok Build's plan, current weekly period and reset time and
  the prepaid and on-demand amounts as `provider_reported`, through ADR-0079's cache.
- Q-101 (may the controller call a provider's own usage command outside a run) is answered for Grok Build as for Codex:
  yes for a read-only call with no model turn and no credential read by Switchboard.
- `x.ai/billing` is found in the binary and one live check, not in the documented method list ("non-exhaustive" in the
  user guide). A Grok update may change it; the reader then reports `unknown` with a reason, never headroom.
- The read starts one Grok process per cache period while `get_capacity` is polled.

## Alternatives rejected

- **xAI management or billing REST API.** Needs Switchboard to hold an xAI key or a browser session (ADR-0003). Left to
  the owner as Q-114, default no.
- **Driving the TUI `/usage` modal.** Needs a pseudo-terminal and screen scraping; fragile and not headless.
- **Per-run `total_cost_usd_ticks` against an operator budget.** That is the existing `controller_estimated` path, not
  a provider-reported figure.
