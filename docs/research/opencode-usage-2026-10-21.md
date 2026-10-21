# OpenCode provider-reported usage (2026-10-21)

*Delegated agent work on an operator task; not owner-approved.* Research behind
[ADR-0089](../adr/0089-opencode-spend-usage-reader.md) and
[ROADMAP T6.24](../ROADMAP.md#611-m6-capacity-and-resilience-tasks): which OpenCode surface reports real usage, and
whether any reports a limit, remaining allowance or reset time.

## Method and sources

- Host: the operator host, `opencode v2.0.23` (`~/.opencode/bin/opencode`, ARM64 Bun binary). Account backing: the
  `opencode-go` provider (OpenCode Go subscription) plus free `opencode` (Zen) models. `auth list` showed an "OpenCode
  Console" stored integration (names only); `auth export` was never run and no credential file was read.
- Read-only commands only; no model was called. The recorded outputs are kept verbatim as test fixtures in
  `src/adapters/opencode/fixtures/usage/` (they carry no account id, email or credential, only model ids).
- OpenCode documentation: <https://opencode.ai/docs/go> (repository file
  `services/www/src/docs/content/console/go.mdx` in github.com/sst/opencode) and the Console API Budgets page
  (`services/www/src/docs/content/console/api/budgets.mdx`).

## Findings per source

| Source | Works? | What it gives | Why / notes |
| --- | --- | --- | --- |
| `opencode stats --json [--days N]` | **Works** | sessions, steps, tokens (input/output/reasoning/cache read/write), `cost` (USD), per-model `{model:{id,providerID,variant}, steps, tokens, cost}` | Day granularity only (`--days 0` = today). Same data as the endpoint below. Local history of this host only. |
| `opencode api [--standalone] experimental.session.stats --param from=<ms> --param to=<ms> --param tools=none` | **Works (chosen)** | Same `SessionStats.Info` shape for any ms window, so 5-hour / 7-day / 30-day windows | ~0.2 s via background service, ~3.7 s `--standalone`. Bad params print `HTTP 500 Internal Server Error` **with exit 0** → must validate JSON. Endpoint is marked experimental. |
| OpenCode server OpenAPI (`opencode api GET /openapi.json`, 150 operations) | No quota op | No usage/limit/balance/subscription operation exists | Checked every path: session, provider, integration, credential, config… none carries plan limits. |
| `opencode api GET /api/provider/opencode-go` | No | `ProviderNotFoundError` in the service location | — |
| Bundle strings (`strings` on the binary) | Partial | Rate-limit headers `x-ratelimit-{limit,remaining,reset}-*`, `anthropic-ratelimit-*`, `retry-after(-ms)` are parsed **only into provider errors** (`retryAfterMs`, `limit`, `remaining`, `reset`) | Only on an error response; nothing is persisted on success. The app shows a Go "account_rate_limit" retry status with `retryAfterMs` (source: `packages/app/src/session/usage-exceeded-dialogs.tsx`). |
| Local DB `~/.local/share/opencode/opencode.db` | Not used | `session_message` holds per-step `cost` and `tokens`; no rate-limit/`account_rate_limit`/`retryAfterMs` error was ever recorded on this host (count 0) | **Contains credentials** (`account`, `control_account`, `credential` tables with tokens) → Switchboard must not open it (ADR-0003). Read once read-only for schema/greps only; no secret rows read. |
| `opencode run --format json` stream | Already wired | `step_finish.part.tokens` + `cost` per run (existing `usage_observation`); `error.type = provider.quota` (402) | No rate-limit shape captured (limit-captures 2026-10-17: NOT_CHECKED). No reset key. |
| OpenCode Console API (`https://opencode.ai/console/api/v1/budgets/members`) | Not usable without a credential | `limit_micro_cents`, `spent_micro_cents`, `exceeded`, `resets_at` per member (docs: `services/www/src/docs/content/console/api/budgets.mdx`) | Needs an `oc_sk_…` Console API key held by Switchboard → violates ADR-0003. Also covers Console **budgets**, not the Go plan's 5h/weekly/monthly allowances. **Owner decision option**, not merged. |
| Go plan limits (docs `services/www/src/docs/content/console/go.mdx`) | Documented only | Per-model monthly dollar limit (Go $10 plan: e.g. Muse Spark 1.3 $60, DeepSeek V4.1 Flash $80; Go Plus higher); 5-hour = 20 %, weekly = 50 %, monthly = 100 % of that | Not reported by any CLI/API we can read; the plan tier (Go vs Go Plus) is not visible to the CLI. Reset semantics of the windows are undocumented. |
| Console dashboard (opencode.ai/workspace) usage graphs | Not used | Go usage bars | Needs the browser session → ADR-0003, not attempted. |

## Sample

30-day window at 2026-10-21: `cost` 14.40 USD, 24 471 steps; models `opencode-go/muse-spark-1.3-contributor` 12.67 USD,
`opencode-go/deepseek-v4.1-flash` 1.73 USD, free models 0. 5-hour window: all zero (no OpenCode use since 2026-10-20).

## Conclusions

- The chosen surface is `experimental.session.stats` with `--standalone`, read for 5-hour, 7-day and 30-day rolling
  windows, reporting spend (`provider_reported`) with its scope: every OpenCode session on this host.
- No readable surface reports the Go plan limit, remaining allowance or reset time, so none is reported, with a note.
  `USAGE_KEYS` and `REMAINING_KEYS` stay empty for OpenCode.
- Open for zemdregon: whether a Switchboard-held Console API key (Budgets API) is ever acceptable; today ADR-0003 rules
  it out.
