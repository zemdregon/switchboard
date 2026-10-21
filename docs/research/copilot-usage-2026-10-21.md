# GitHub Copilot quota sources (2026-10-21)

*Delegated agent work on an operator task; not owner-approved.* Input to
[ADR-0081](../adr/0081-copilot-quota-usage-only-provider.md). Question: can Switchboard show how much GitHub Copilot
quota the operator has left, without a model call and without handling a credential
([ADR-0003](../adr/0003-no-credential-handling.md))?

Checked on the operator host on 2026-10-21 with Copilot CLI 1.0.92 on a free plan, using the operator's own logged-in
`gh`. No token, account id, login or organisation name is recorded here; key names are the only field content quoted,
and the figures are from one free-plan account.

## Sources compared

| Source | Result | Entitlement and remaining? | Cost | Scriptable? | Used |
| --- | --- | --- | --- | --- | --- |
| `gh api /copilot_internal/user` | Plan, SKU, reset date and a `quota_snapshots` object with `chat`, `completions` and `premium_interactions` | Yes: entitlement, remaining, percent remaining, unlimited flag, overage count and permission, snapshot time | One read-only GET, no model call, no premium request | Yes | **Yes** (ADR-0081) |
| `gh api /users/<user>/settings/billing/premium_request/usage` (documented billing API) | Works, but returns only billed usage items (an empty list on a free plan) | No: no entitlement or limit | One GET | Yes | No |
| `copilot` slash commands `/usage` (session metrics) and `/limits` | Exist only inside an interactive session | Not as a script | Interactive session | No | No |
| `copilot -p --output-format json` | Usage statistics for that one run | No: per-run counts only | Needs a model call, so it consumes quota | Yes | No |
| `~/.copilot/logs`, `session-store.db` | No quota keys found | No | None | Files, not an interface | No |
| Copilot CLI binary | A packed native binary; no readable source | Not applicable | Not applicable | Not applicable | No |

## What `gh api /copilot_internal/user` returned

Top-level keys read: `copilot_plan`, `access_type_sku`, `quota_reset_date_utc`, `quota_snapshots`. Under
`quota_snapshots.{chat,completions,premium_interactions}`: `entitlement`, `remaining`, `quota_remaining`,
`percent_remaining`, `unlimited`, `overage_count`, `overage_permitted`, `timestamp_utc`.

Example figures (one free-plan account): chat 27.7 of 200 (13.8 %), completions 2000 of 2000, premium interactions 0 of
0, quota reset 2026-11-01. The response also carries identifying fields (an account id, a login, an analytics tracking
id, endpoint URLs and organisation lists); Switchboard drops all of them with a field allowlist.

## Findings and risks

- The endpoint is GitHub-internal and undocumented. It is the one the Copilot CLI and the IDE extensions read, but
  GitHub does not promise its shape. Mitigation: the parse keeps only allowlisted keys and reports `unparseable` when
  the shape differs ([ADR-0081](../adr/0081-copilot-quota-usage-only-provider.md)).
- `quota_remaining` and `remaining` both exist; whether they always agree is **Unverified**. The mapping the reader
  uses is owned by [LLD §16.11](../design/LLD.md#1611-provider-reported-quota-of-a-usage-only-provider-fr-cap-14-adr-0081).
- One plan only was checked. Paid plans, organisation-managed seats and plans with overage were not observed
  (**Unverified**); `unlimited: true` and `overage_permitted: true` are handled by the schema but not seen live.
- Nothing here was run on a provider account other than reading the operator's own Copilot quota once; no model call
  was made and no premium request was consumed.
