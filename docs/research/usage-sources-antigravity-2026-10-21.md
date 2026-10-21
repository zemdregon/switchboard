# Antigravity usage sources (2026-10-21)

Research input for ROADMAP T6.20 and
[ADR-0082](../adr/0082-antigravity-usage-from-the-cli-usage-command.md). Recorded on the operator host with `agy`
1.4.3, signed in, from an empty working directory. No model turn was run. Account identifiers are not recorded; the
payloads carry none.

## Sources checked

| Source | Result | Notes |
| --- | --- | --- |
| `agy -p "/usage" --output-format json` | Works: provider-reported | `status` `SUCCESS`, `num_turns` 0, zero tokens, empty `conversation_id`, about 2.4 s. `command.data.groups[].buckets[]` carries `id`, `name`, `window`, `remaining_fraction`, `reset_time` and sometimes `description`. Used by T6.20. |
| `agy -p "/quota" --output-format json` | Works | Same payload as `/usage` (`command.name` `usage`). |
| `agy -p "/credits" --output-format json` | Works | `command.data` is `remaining_credits` (an integer, 0 on this account) and `upgrade_uri`. Used by T6.20. |
| `agy -p "/usage" --output-format stream-json` | Works | `{"event":"command_result","command":{…}}`, then `{"event":"result","result":{…}}`. Not used. |
| `agy -p "/usage"` (text) | Works | One tab-separated line per bucket: group, label, rounded percentage, UTC reset. Not used: the JSON form is structured. |
| `agy -p "/usage"` signed out (empty `HOME`) | Waits for a sign-in | Prints a sign-in URL and waits about 60 s for a code, then a JSON `status` `ERROR`. That is why T6.20 runs `agy models` first. |
| `agy models` | Works, no quota | Model list only. Already the login preflight (T4.34). |
| `agy --help`, `agy changelog` | Documentation | The changelog says print mode answers `/usage`, `/quota`, `/credits`, `/model`, `/effort` and `/skills` "without starting an agent turn, spending quota, or leaving a conversation behind", and that piped and `--json` output use UTC timestamps. |
| Local state `~/.gemini/antigravity-cli/` | No usage cache | Only file names and log lines were read, no file contents beyond the logs. The logs show the CLI's `quota_manager` calling `POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`. No quota figure is stored on disk. The OAuth token file was not opened. |
| `v1internal:retrieveUserQuotaSummary` called directly | Not built | Needs the CLI's OAuth token in Switchboard's hands, which ADR-0003 forbids. `/usage` returns the same data through the CLI. |
| `AGY_ERROR` on stderr (T6.15) | Failure only | `RESOURCE_EXHAUSTED` maps to `QUOTA_EXHAUSTED`; the reset is free text (Q-100). |
| Response headers | Not reachable | The CLI does not print them. |

## Recorded `/usage` payload shape

```text
{conversation_id: "", status: "SUCCESS", response: "<tab-separated text>", duration_seconds: 0, num_turns: 0,
 usage: {input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0},
 command: {name: "usage", data: {description, groups: [
   {name: "Gemini Models", description, buckets: [
     {id: "gemini-weekly", name: "Weekly Limit Remaining", description?, window: "weekly",
      remaining_fraction: 0.1336, reset_time: "2026-10-24T07:21:04Z"},
     {id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.99, reset_time: …}]},
   {name: "Claude and GPT models", buckets: [{id: "3p-weekly", …}, {id: "3p-5h", …}]},
   {name: "Gemini 4 Argon", buckets: [{id: "gemini-argon-wtu-weekly", window: "weekly", …}]}]}}}
```

The payload's own description says models in a group share a weekly and a 5-hour limit, and that quota is used in
proportion to token cost. A bucket at `remaining_fraction` 1 reports a `reset_time` of now plus its window, which moves
on every call: that window has not started.
