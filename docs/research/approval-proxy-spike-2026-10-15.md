# MCP approval-proxy tools spike (T14.8), 2026-10-15

- Date: 2026-10-15
- Status: Research input (Delegated agent work, documentation only; not owner-approved). Normative contracts remain
  [ADR-0047](../adr/0047-approval-proxy-over-mcp.md) (Proposed; decision text cross-linked only, not edited here),
  [LLD §3.4.8](../design/LLD.md#348-approval-proxy-tools-fr-ctl-08-adr-0047), and [FR-CTL-08](../requirements/SRS.md).
- Used by: [ROADMAP](../ROADMAP.md) T14.8, FR-CTL-08, FR-MCP-06, FR-MCP-14, FR-POL-09, FR-PRJ-10,
  [ADR-0017](../adr/0017-approved-privileged-scope-bypass.md) (item 5 interaction), T14.9 (sink announcement;
  cross-link only), T14.10 (consent-page link boundary).
- Scope: Exact MCP tool names and schemas, operator configuration gates, digest binding, fail-closed refusal rules,
  audit fields, and boundaries to notification sinks and the consent page. No code.

## Evidence labels

- **Verified (repo):** read in this repository on 2026-10-15.
- **Verified (spec):** requirement or LLD row cited by ID; ADR decision text not restated.
- **Proposed:** implementation guidance where the spike connects sources that use different field names.

## Primary sources

| ID | Source | Why it matters |
| --- | --- | --- |
| R1 | [ADR-0047](../adr/0047-approval-proxy-over-mcp.md) | Scope, controls, audit, sink announcement, consent page as secondary |
| R2 | [LLD §3.4.8](../design/LLD.md#348-approval-proxy-tools-fr-ctl-08-adr-0047) | Tool contracts, digest algorithm, refusal rules, `decided_by` persistence |
| R3 | [LLD §3.4.1](../design/LLD.md#341-shared-types) | `approval_proxy_item`, `approval_kind` |
| R4 | [FR-CTL-08](../requirements/SRS.md) | Requirement row for proxy list/decide and `decided_via: mcp_proxy` |
| R5 | [FR-MCP-06](../requirements/SRS.md), [FR-MCP-14](../requirements/SRS.md) | MCP never grants `privileged` except marked `approval_proxy` clients (owner decision 50 notes) |
| R6 | [FR-POL-09](../requirements/SRS.md) | Privileged approval recording; MCP path amends "operator CLI" for proxy clients |
| R7 | [TDD §3.1](../design/TDD.md#31-configuration) | `mcp_clients[].approval_proxy`, `approval_proxy_targets` |
| R8 | [LLD §3.4.10](../design/LLD.md#3410-tool_profile-fr-ctl-11) | Approval tools orthogonal to `tool_profile` |
| R9 | [notification sinks spike](notification-sinks-spike-2026-10-15.md) | `approval_decided` payload after proxied decide (T14.9; cross-link only) |
| R10 | [console tool-profile spike](console-tool-profile-spike-2026-10-15.md) | `tools/list` composition with `approval_proxy` |

## Exact MCP tools (no others)

Only these two tools implement the approval proxy ([LLD §3.4.8](../design/LLD.md#348-approval-proxy-tools-fr-ctl-08-adr-0047),
[FR-CTL-08](../requirements/SRS.md)). No additional approval MCP tools are defined for T14.8.

| Tool | Listed when | Requirement IDs |
| --- | --- | --- |
| `list_pending_approvals` | `mcp_clients[].approval_proxy` is `true` | FR-CTL-08, ADR-0047 |
| `decide_approval` | same | FR-CTL-08, ADR-0047 |

Clients without `approval_proxy` do **not** receive these names in `tools/list` (absent, not an error at list time)
([ADR-0047](../adr/0047-approval-proxy-over-mcp.md) Decision 1, LLD §3.4.8).

### `list_pending_approvals`

**Input (optional):** `project_id` (string) — filter when set (LLD §3.4.8).

**Output:** `{ "approvals": [ … ] }` where each element is `approval_proxy_item` (LLD §3.4.1).

Required fields on each item: `approval_id`, `approval_digest`, `kind`, `requested_at`, `target_client_id`.
Optional controller-generated fields only: `project_id`, `run_id`, `revision`, `scope_summary` (max 512; no agent text)
(ADR-0047 Decision 2d, LLD `approval_proxy_item`).

`kind` is one of `privileged_scope`, `dynamic_project`, `push_revision` (`approval_kind` enum).

### `decide_approval`

**Input (required):** `approval_id`, `approval_digest` (64 lowercase hex), `decision` ∈ `approve` | `deny`.

**Output:** `{ "approval_id", "status" }` with `status` ∈ `APPROVED` | `DENIED`.

On success: same approval row transitions as CLI `approve` / `deny` (LLD §3.1, §3.4.8), plus `approval_decided`
run event and sink delivery (§3.4.9).

## Who gets the tools: configuration and `tool_profile`

| Gate | Config path | Default | Settable over MCP? | Requirement |
| --- | --- | --- | --- | --- |
| Approval proxy | `mcp_clients[].approval_proxy` | `false` | No | FR-CTL-08, [TDD §3.1](../design/TDD.md#31-configuration) |
| Listed targets | `mcp_clients[].approval_proxy_targets` | caller client id only | No | FR-CTL-08, ADR-0047 Decision 2b |

Invalid operator configuration (including invalid `approval_proxy` value) refuses at config load (ADR-0047 Decision 2a).

**`tool_profile` is not a gate for approval tools.** [LLD §3.4.10](../design/LLD.md#3410-tool_profile-fr-ctl-11) adds
`list_pending_approvals` and `decide_approval` when `approval_proxy` is true **regardless** of whether
`tool_profile` is `orchestrator` or `console` (see [console tool-profile spike §2.1](console-tool-profile-spike-2026-10-15.md)).
`tool_profile` only shrinks or keeps the non-approval surface; it does not grant approval tools by itself.

**Caller identity** still comes from the MCP client entry bound to the session ([FR-MCP-14](../requirements/SRS.md),
[FR-OPS-04](../requirements/SRS.md)): the proxy client's id is recorded on each decision. A proxy may list and decide
only `PENDING` approvals whose `target_client_id` is in `approval_proxy_targets` (default: itself).

**Trust ceiling unchanged:** [FR-MCP-06](../requirements/SRS.md) still caps trust profiles on `delegate_task` and
related tools; marking `approval_proxy` does not grant `privileged` through MCP without a pending approval and
`decide_approval`. [FR-MCP-14](../requirements/SRS.md) still maps one token to one client entry; no OAuth scope grants
`privileged` or `approval_proxy` — the flag is operator configuration only.

## `approval_digest` (ledger-only inputs)

The digest is **computed by the controller from ledger state**, not from agent or repository content
([ADR-0047](../adr/0047-approval-proxy-over-mcp.md) Decision 2c, LLD §3.4.8).

**Algorithm (Verified spec):** SHA-256 over a canonical JSON object:

```json
{
  "v": 1,
  "approval_id": "<id>",
  "kind": "<approval_kind>",
  "scope_hash": "<hex>" | "revision_hash": "<hex>",
  "target_client_id": "<mcp client id>",
  "requested_at": "<timestamp string from row>"
}
```

- For `kind: privileged_scope`, include `scope_hash` from [LLD §3.1](../design/LLD.md#31-privileged-scope-m3)
  (ADR-0017 scope hash: MCP client id, meta-session id, canonical privileged scope).
- For dynamic project / push revision kinds, include `revision_hash` per [ADR-0030](../adr/0030-dynamic-project-revisions-and-approval.md)
  instead of `scope_hash`.

The listing returns the digest for each pending row; `decide_approval` must echo the **exact** `approval_id` and
`approval_digest` pair from that listing for that row. The digest binds the frozen scope or revision the operator
(or proxy) is approving — it does not widen scope (ADR-0047 Decision 2g).

## Stale, missing, or mismatched digest (fail closed)

[LLD §3.4.8](../design/LLD.md#348-approval-proxy-tools-fr-ctl-08-adr-0047) requires fail-closed behaviour with
**no ledger write** when:

| Condition | MCP result |
| --- | --- |
| Wrong or missing `approval_digest` | `INVALID_REQUEST` |
| Unknown or non-pending `approval_id` (stale) | `INVALID_REQUEST` |
| Approval's `target_client_id` not in caller's `approval_proxy_targets` | `INVALID_REQUEST` |
| Row not `PENDING` | `INVALID_REQUEST` |

ROADMAP T14.8 malicious-fixture acceptance matches this table (digest mismatch, wrong target, absent tools on
`tools/list`).

## Audit: `decided_via` vs `decided_by`

| Surface | Field / value | Source |
| --- | --- | --- |
| Requirement language | `decided_via: mcp_proxy` in the approval record | [FR-CTL-08](../requirements/SRS.md), ADR-0047 Decision 2e |
| Persistence (LLD) | `approval.decided_by = "mcp_proxy:<proxy_client_id>"`; no separate `decided_via` column | LLD §3.4.8 schema note |

**Proposed (implementation):** treat FR-CTL-08's `decided_via: mcp_proxy` as satisfied when `decided_by` uses the
`mcp_proxy:<client_id>` prefix and the proxy client's id is recoverable for audit and sink correlation. Timestamp and
scope recording remain as [FR-POL-09](../requirements/SRS.md) requires for privileged approvals.

CLI `approve` / `deny` paths are unchanged (ADR-0047 Decision 2g).

## FR-POL-09 and ADR-0017 item 5 (privileged / bypass)

### FR-POL-09

Privileged runs still require approval before execution. For clients the operator marks `approval_proxy`, deciding a
pending `privileged_scope` approval via `decide_approval` is an allowed path alongside the operator CLI
(FR-POL-09 note 2026-10-15, owner decision 50; [ADR-0047](../adr/0047-approval-proxy-over-mcp.md)). Denied proxied
decisions end the run `CANCELLED` with the same semantics as CLI deny (LLD §3.4.8 → §3.1 transitions).

`privileged_approval: "not_required"` ([ADR-0019](../adr/0019-per-client-privileged-approval.md)) is unchanged: it is
configuration standing in for CLI approval, not an MCP proxy tool.

### ADR-0017 item 5 (bypass flag emission)

Item 5 of [ADR-0017](../adr/0017-approved-privileged-scope-bypass.md) still states (decision text unchanged) that a
bypass flag may be emitted only when, among other checks, the covering approval is `APPROVED` **by the operator CLI**,
`scope_hash` matches the run policy snapshot, and the approved scope sets `bypass: true`.

Interaction for T14.8 (documentation only):

1. **Proxied approve is still an approval of the frozen scope** shown in the listing, including `bypass: true` when
   present in that scope (ADR-0047 Decision 1: privileged scopes including bypass; Decision 2g: no widening).
2. **LLD §3.4.8** says successful `decide_approval` uses the **same transitions as CLI** `approve`/`deny` for the
   approval row and run admission path.
3. **Proposed (implementation):** after a successful proxied `approve` on a `privileged_scope` row, the bypass gate in
   item 5 should treat the row as `APPROVED` with a matching `scope_hash` the same way as after CLI `approve`, without
   relaxing hash equality or the explicit `bypass: true` requirement. If item 5's literal "operator CLI" wording and
   MCP proxy paths must be reconciled in normative text, that is an ADR acceptance or amendment follow-up — this spike
   does not edit ADR-0017.

Item 6 of ADR-0017 ("No MCP tool approves") is superseded in part by ADR-0047 for `decide_approval` on marked clients
(ADR-0047 header); item 5 is cited on the ROADMAP T14.8 row for bypass/hash coupling, not for superseding item 6.

## Notification sinks (T14.9 boundary)

Approval proxy **does not** define sink configuration or payload shape. After a successful `decide_approval`,
[ADR-0047](../adr/0047-approval-proxy-over-mcp.md) Decision 2f requires announcement to configured notification
sinks under [ADR-0048](../adr/0048-notification-sinks.md) with metadata only.

Details: [notification sinks spike](notification-sinks-spike-2026-10-15.md) (`approval_decided`, `reason_code` ∈
`approval_kind`, no digest in payload). Sink delivery is best-effort and off the run path (T14.9); proxy refuse paths
write nothing and therefore emit no `approval_decided` sink event.

## Consent-page link (T14.10 boundary)

[FR-CTL-09](../requirements/SRS.md) and ADR-0047 Decision 3 define a **secondary** path: single-use, expiring link to
the M13 consent page ([FR-MCP-17](../requirements/SRS.md)), no token in the link, revoked when the approval is
decided or expires. That path is **T14.10**, not part of the two MCP proxy tools.

MCP proxy clients use `list_pending_approvals` / `decide_approval` with digest binding; consent-page links are for
operators who prefer a browser step (ADR-0047 Alternatives). Sink `link` fields must not carry approval secrets or
digests ([notification sinks spike](notification-sinks-spike-2026-10-15.md), ADR-0048).

## Test implications (T14.8 acceptance; no code in this spike)

Future malicious-fixture additions (ROADMAP §6.13 T14.8 column) should plan for:

| Scenario | Expectation |
| --- | --- |
| Digest mismatch / missing | `decide_approval` → `INVALID_REQUEST`; approval row and run state unchanged |
| Stale `approval_id` | Same |
| Target not in `approval_proxy_targets` | Same |
| Client without `approval_proxy` | `tools/list` omits both tool names |
| Listing content | No agent text in `scope_summary` or other listed fields; only `approval_proxy_item` shapes |
| Audit | Successful decide records proxy client (LLD `mcp_proxy:<id>`; FR-CTL-08 `decided_via: mcp_proxy`) |
| Sinks | One `approval_decided` per successful proxied decide when sinks configured (see R9) |

## Related work

- [console tool-profile spike](console-tool-profile-spike-2026-10-15.md): `tools/list` layers including `approval_proxy`.
- [notification sinks spike](notification-sinks-spike-2026-10-15.md): closed sink payloads for `approval_decided`.
- [consent-page approval link spike](consent-page-approval-link-spike-2026-10-15.md): T14.10 browser path
  (cross-link only).
- [orchestration-layer discovery](../research/orchestration-layer-discovery-2026-10-15.md): owner decision 50 context.

## Open points for implementation (not blockers for this doc spike)

- Whether FR-CTL-08 `decided_via` should be mirrored explicitly in MCP tool output or only in ledger export
  (**Proposed**: ledger `decided_by` prefix is sufficient if tests assert the prefix).
- Reconcile ADR-0017 item 5 literal "operator CLI" with proxied `APPROVED` rows if docs-check or acceptance tests
  require a single normative sentence (ADR follow-up, not this spike).
