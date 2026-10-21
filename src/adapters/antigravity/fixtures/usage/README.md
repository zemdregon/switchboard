# Antigravity `/usage` fixtures

Recorded on the operator host on 2026-10-21 with `agy` 1.4.3, signed in, from an empty working directory (T6.20,
[ADR-0082](../../../../../docs/adr/0082-antigravity-usage-from-the-cli-usage-command.md)). No model turn ran: each
output reports `num_turns` 0 and zero tokens.

| File | Command | Notes |
| --- | --- | --- |
| `usage-1.4.3.jsonl` | `agy -p "/usage" --output-format json` | Recorded as printed. The payload carries no account id or email. |
| `credits-1.4.3.jsonl` | `agy -p "/credits" --output-format json` | Recorded as printed. |
| `usage-logged-out-1.4.3.jsonl` | `HOME=<empty dir> agy -p "/usage" --output-format json` | stdout only. stderr (not kept) printed a sign-in URL and waited for a code, which is why the reader runs only after `agy models` reports a login. |
