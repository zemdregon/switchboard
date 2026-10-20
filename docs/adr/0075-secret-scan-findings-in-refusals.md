# ADR-0075: Secret-scan refusals name the rule, path and line of each finding

- Status: Accepted (built 2026-10-20). Extends [ADR-0061](0061-pre-push-secret-scan-blocks-every-run.md) and
  [ADR-0069](0069-mcp-publish-run-and-dynamic-project-push.md).
- Date: 2026-10-20
- Decided by: Delegated agent work, not owner-approved. Nothing here changes what a push may do: the scan, its range,
  its rules, the allowlist and the refusal in every profile (bypass runs included) are unchanged; only what a refused
  caller is told about the findings changes.
- Related: FR-GIT-11, FR-GIT-12, FR-GIT-05, FR-MCP-04,
  [LLD §20.9](../design/LLD.md#209-pre-push-secret-scan-fr-git-11-t914-adr-0061),
  [LLD §3.4.12](../design/LLD.md#3412-publish_run-and-publications-fr-git-12-adr-0069),
  [LLD §12.6](../design/LLD.md#126-push-algorithm), [ROADMAP T9.20](../ROADMAP.md#63-m9-projects-and-controlled-commits-tasks).

## Context

When the pre-push secret scan (ADR-0061) refuses a push, the caller saw only the reason. `publish_run` answered
`PERMISSION_BLOCKED` with the message `push refused (SECRET_SCAN_BLOCKED)` and `details {reason, push_id}`; the agent
`push` tool answered `{code: "SECRET_SCAN_BLOCKED", message: "push refused: SECRET_SCAN_BLOCKED"}`. The findings (rule
id, repository-relative path, new-file line) were recorded in `secret_scan_hit` events, which an orchestrator can read
only through `get_run` events and an agent cannot read at all, so an agent whose test fixture held a token-shaped
value could not find and fix it. `PushResult` did not carry the scan report, although the push library holds it when
it records the refusal.

## Decision

1. **`PushResult.secretScan`.** On a `SECRET_SCAN_BLOCKED` refusal only, the push library's result carries
   `{hits, hitCount}`: the same `{rule_id, path, line}` hits the `secret_scan_hit` events hold (at most 100, the
   report's cap) and the exact count. Never the value, never the line; the scanner still never keeps either.
2. **One view for every caller** (`secretScanFindings` in `src/git/secret-scan.ts`): `findings [{rule_id, path, line,
   path_truncated?}]`, `finding_count` (exact) and `findings_truncated: true` when the list is shorter than the count.
   **Delegated:** a path longer than 512 characters is cut and marked `path_truncated`, which keeps the agent tool's
   answer below the channel's 512 KiB response limit even for 100 findings with escaped paths.
3. **`publish_run`.** The refusal stays `PERMISSION_BLOCKED` with `details.reason` and `details.push_id`, and adds
   `details.findings`, `details.finding_count` and `details.findings_truncated`. The message is
   `push refused (SECRET_SCAN_BLOCKED): <list>. <hint>`.
4. **Agent `push` tool.** The answer keeps the code `SECRET_SCAN_BLOCKED` and the message prefix
   `push refused: SECRET_SCAN_BLOCKED`, followed by `: <list>. <hint>`, and the error gains an optional `details`
   object with the same three fields. The tool shim already relays the whole error object as the tool result's text,
   so the structured field reaches the agent unchanged; `ToolResponse` declares it as optional.
5. **`switchboard git push`.** The JSON report gains the same three fields on a secret-scan refusal, and the human
   line names the findings before the reason text.
6. **The list** (`describeSecretScanFindings`): `2 secret-scan findings: github_token at test/fixtures/a.ts:12; jwt at
   src/x.ts:4`. **Delegated:** at most 20 findings within 1,200 characters, then `; and N more`, so the whole message
   stays inside the MCP error envelope's 2,000-character cut with the hint intact.
7. **Paths cannot inject.** Paths come from the diff header, where Git's C-style quoting is undone, so a path can hold
   any byte but NUL. **Delegated:** in a message, a path that is not plain printable ASCII (letters, digits and
   `._/@+=,~-`) is shown as a JSON string with every character outside printable ASCII escaped as `\uXXXX`, so no line
   break, terminal escape sequence or bidirectional override reaches a message; a shown path is cut at 160
   characters. The structured `path` is exact (up to item 2's cut); JSON escapes it on the wire.
8. **The hint**: "Remove each value from the change (in tests, build fake values at run time instead of committing
   them); the operator can allow a rule at a path with git.secret_scan.allow." It names the operator allowlist but
   gives the agent no way past the scan: the allowlist stays operator configuration only.

## Consequences

- An agent or orchestrator can fix a refused change without the operator reading events for it.
- The findings are what the ledger already records and what `get_run` events already show an orchestrator; no new
  information leaves the controller, and nothing value-shaped is added to any answer.
- The MCP outbound scrubber still runs over the message and details. It leaves rule ids and repository-relative paths
  alone; a path that itself looks like a credential assignment would be redacted, which is harmless.
- Other refusal reasons are unchanged, and the extra `PushResult` field is optional, so existing callers are unaffected.
- Not covered: no live provider reads the answer; the tests use the fake channel client, the in-memory MCP client and
  local bare remotes.
