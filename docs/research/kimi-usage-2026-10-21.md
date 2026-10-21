# Kimi Code plan usage: where the number can be read (2026-10-21)

Delegated agent research (2026-10-21), Kimi Code CLI 2.1.1, not owner-approved. No account data is recorded here. It
feeds [ADR-0084](../adr/0084-kimi-usage-via-cli-usage-display.md).

Question: can Switchboard show the plan usage that Kimi Code reports (5 hour, weekly and monthly windows) without
handling a credential?

| Source | What it carries | Verdict |
| --- | --- | --- |
| `--output-format stream-json` events | Session and token events only; no plan quota and no reset time. | No quota. |
| ACP (`kimi acp`), `/usage` command | Session token counts only. | No quota. |
| Kimi backend `GET /coding/v1/usages` (api.kimi.com or api.kimi.ai) | `usages.{limit_5h,limit_7d,limit_month_total,limit_month_code}` with `used_ratio` and `reset_time`, plus a booster wallet. Needs the OAuth bearer token. | Rejected: credential handling and reimplementing the provider protocol ([ADR-0003](../adr/0003-no-credential-handling.md)). |
| `kimi web` local server, `GET /api/v1/oauth/usage` | The same data through the CLI's own credentials. Every route needs the persistent local bearer in `~/.kimi-code/server.token`. | Not used: reading that file is credential handling. Listed as an owner option (ROADMAP Q-114). |
| Interactive TUI slash command `/usage` | Rendered by the CLI with its own credentials: "Plan usage" with `5h limit`, `Weekly limit` and `Monthly limit` rows (`N% used`, `resets in 1d 2h 3m`), a `kimi N% · code M%` breakdown and an optional "Extra Usage" booster wallet. | Chosen. |

Observed side effects of the TUI path: no model call and no session; Kimi adds the working directory to its workspace
list and one `/usage` line to its input history. In a folder it has not trusted, the TUI first shows a "Trust this
folder?" dialog (`❯ Trust and continue` / `Exit`); trust is stored per exact folder under
`~/.kimi-code/workspace-trust/`, so the reader uses one stable probe directory and answers the dialog once. Precision is
a whole percent and a minute-level relative reset time. A sanitised terminal capture is committed as
`src/adapters/kimi/fixtures/usage-tui-2.1.1.raw`.
