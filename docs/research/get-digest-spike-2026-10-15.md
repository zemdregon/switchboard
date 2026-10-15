# `get_digest(since_cursor)` spike (T14.3), 2026-10-15

- Date: 2026-10-15
- Status: Research input (Delegated agent work, documentation only; not owner-approved). Normative contracts remain
  [LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02), [FR-CTL-02](../requirements/SRS.md), [FR-TEL-01](../requirements/SRS.md),
  [FR-MCP-04](../requirements/SRS.md), and T14.0 shared types ([LLD §3.4.1](../design/LLD.md#341-shared-types)).
- Used by: [ROADMAP](../ROADMAP.md) T14.3, T14.11 (`console` profile), M14 acceptance (T14.13). Cross-links only to merged
  M14 spikes: [needs-attention derivation](needs-attention-derivation-spike-2026-10-15.md) (T14.2; derivation rules not
  restated here), [approval proxy](approval-proxy-spike-2026-10-15.md) (T14.8), [notification sinks](notification-sinks-spike-2026-10-15.md)
  (T14.9), [console tool profile](console-tool-profile-spike-2026-10-15.md) (T14.11). Consent-page link (T14.10) is
  out of scope; see the separate consent-link spike when landed.
- Scope: Digest cursor over `run_event`, delta vs full snapshot behaviour, per-project section assembly, untrusted agent
  text on the digest path, caller scoping, and task dependencies. **No code.** Does not duplicate the T14.2 derivation
  tables.

## Evidence labels

- **Verified (repo):** read in this repository on 2026-10-15.
- **Verified (spec):** requirement or LLD row cited by ID; accepted ADR decision text is cross-linked only, not restated.
- **Proposed:** assembly details not yet locked by MCP tests (ROADMAP T14.3 done-when).

## Primary sources

| ID | Source | Why it matters |
| --- | --- | --- |
| R1 | [LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02) | Tool input/output JSON Schema; cursor semantics; agent-text rule |
| R2 | [LLD §3.4.1](../design/LLD.md#341-shared-types) | `digest_cursor`, `untrusted_text`, `approval_proxy_item`, `needs_attention_reason` |
| R3 | [LLD §3.0 envelope](../design/LLD.md#30-shared-types) | FR-MCP-04 compact row shape for `finished` / `failed` / optional nested `envelope` |
| R4 | [LLD `run_event` DDL](../design/LLD.md#1-data-model) | Append-only ledger rows the cursor scans (FR-TEL-01) |
| R5 | [FR-CTL-02](../requirements/SRS.md) | Requirement for digest sections and cursor |
| R6 | [FR-TEL-01](../requirements/SRS.md) | Every lifecycle step appends `run_event` |
| R7 | [FR-MCP-04](../requirements/SRS.md) | No transcripts or credentials in tool results |
| R8 | [needs-attention spike](needs-attention-derivation-spike-2026-10-15.md) | T14.2 derivation entry point and digest boundaries (cross-link only) |
| R9 | [approval proxy spike](approval-proxy-spike-2026-10-15.md) | `pending_approvals` item shape and proxy scope (T14.8) |
| R10 | [notification sinks spike](notification-sinks-spike-2026-10-15.md) | Pull digest vs push sinks (T14.9; cross-link only) |
| R11 | [console tool-profile spike](console-tool-profile-spike-2026-10-15.md) | `get_digest` in `console` profile (T14.11) |

## MCP tool shape (Verified — LLD)

Input and output schemas are exactly [LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02) and [§3.4.1](../design/LLD.md#341-shared-types).
This spike names fields and assembly behaviour; it does not redefine JSON Schema.

| Direction | Field | Schema owner |
| --- | --- | --- |
| Input | `since_cursor` | Optional `digest_cursor`; absent ⇒ full snapshot within retention |
| Output | `cursor` | Required `digest_cursor` |
| Output | `projects[]` | Per-project object; see below |

## Digest cursor format

### Source rows and events (Verified — LLD, FR-TEL-01)

| Concept | Definition |
| --- | --- |
| Ledger table | `run_event` — append-only; each row has `id` (`evt_` + 26 Crockford base32 chars), `run_id`, `seq`, `ts`, `type`, bounded `payload_json` ([LLD DDL](../design/LLD.md#1-data-model)) |
| Cursor type | `digest_cursor` — pattern `^evt_[0-9A-HJKMNP-TV-Z]{26}$` ([LLD §3.4.1](../design/LLD.md#341-shared-types)) |
| Ordering | Total order `(ts, id)` on `run_event` rows; `id` breaks ties when timestamps collide |
| Scan window | Rows strictly **after** the position named by `since_cursor`, up to a bounded scan budget (proposed target: **10 000** events per call, [LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02)) |
| Returned `cursor` | The `run_event.id` of the **last** row included in that scan (not “next event to read”) |

`since_cursor` on input is the **output `cursor` from the caller's previous successful `get_digest`** (or omitted for the
first poll). The implementation resolves `since_cursor` to the `(ts, id)` pair of that `evt_*` row; if the row was garbage-collected,
behaviour matches an absent cursor (full snapshot within retention, [LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02)).

### Stability and idempotency (Verified — LLD; Proposed — exact JSON)

| Case | Behaviour |
| --- | --- |
| No new `run_event` rows after `since_cursor` | **Empty delta:** no new facts in the scan; returned `cursor` equals input `since_cursor` ([LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02)) |
| Repeated call with same `since_cursor` | Same digest body and same `cursor` (ROADMAP T14.3 test) |
| Retention GC | Events before retention are not replayed; stale cursor ⇒ treat as absent cursor |
| Invalid `since_cursor` (pattern, unknown id) | Fail closed: `INVALID_REQUEST` (same validation posture as other MCP tools, FR-MCP-09) |

**Proposed (empty digest JSON):** When the delta is empty, return `projects: []` and unchanged `cursor`. Do not omit
`projects` or `cursor`. Section arrays inside a project object are always present when that project is included (see
assembly).

**Proposed (scan budget exhausted):** If more than 10 000 events remain after `since_cursor`, include only the first
10 000 in this response, set `cursor` to the last included `evt_*`, and rely on the client to call again with that
`cursor` until the delta is drained. Whether to add an explicit `truncated` flag is **not** in LLD; T14.3 implementation
may add one only with an LLD/SRS amendment.

### Full snapshot (`since_cursor` absent)

Within retention, the controller performs a scan that establishes the output `cursor` (typically the latest `(ts, id)` in
the scan). Project sections reflect **current** controller-visible state for each project the caller may use, not only
rows touched in the last event (contrast with delta mode below). Exact retention bounds follow existing ledger GC
(NFR-DATA-01); T14.3 tests use planted fixtures with a bounded event set.

## Caller scoping (Verified — LLD)

Same rules as `get_run` / `list_runs` ([LLD §3.4.2](../design/LLD.md#342-list_runs-fr-ctl-01)): only runs the caller
started (`client_id` match) and runs of projects in `mcp_clients[].projects` (plus dynamic projects the caller created).
Other clients' runs and projects never appear. Digest assembly runs in COMP-MCP with facts from COMP-LED ([LLD §3.4 intro](../design/LLD.md#34-control-plane-m14-proposed-t140)).

## Per-project sections and fields

Each element of `projects[]` is an object with required `project_id` ([LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02)).
All other properties are optional in schema but **Proposed** assembly always sets them when the project is included in a
non-empty response. Field types are **only** those in LLD — this table is a reading guide.

| Section / field | LLD schema | Content (normative owner: LLD) |
| --- | --- | --- |
| `project_id` | string, required | Configured or dynamic project id |
| `paused` | boolean | Project or effective pause visible to digest ([LLD §3.4.4](../design/LLD.md#344-steer_run-pause-and-resume-fr-ctl-04-fr-ctl-05), §3.4.7); pause is **not** a `needs_attention_reason` ([T14.2 spike](needs-attention-derivation-spike-2026-10-15.md)) |
| `budget` | object | `exhausted` plus optional `caps[]` with `key`, `limit`, `used`, `window_ends_at` ([LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02), §3.4.6); `limit: null` when unset (never a provider limit, ADR-0007) |
| `needs_attention` | array | Items `{ run_id, reason, envelope? }`; `reason` ∈ `needs_attention_reason`; derivation per §3.4.5 / T14.2 |
| `finished` | array of `envelope` | Runs that **succeeded** (terminal `SUCCEEDED`), FR-MCP-04 shape |
| `failed` | array of `envelope` | Runs that **failed** (terminal `FAILED`), FR-MCP-04 shape |
| `pending_approvals` | array of `approval_proxy_item` | `PENDING` approvals visible on the digest path ([LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02)); proxy listing rules in [approval proxy spike](approval-proxy-spike-2026-10-15.md) (T14.8) |
| `untrusted_summaries` | array | Side channel for agent-written digest text; see §Untrusted text |

### `needs_attention[]` (depends on T14.2)

- **Derivation:** Call the same `deriveNeedsAttention` (name Proposed in T14.2 spike) used for `get_run` / `list_runs`.
- **Digest row shape:** `run_id` and `reason` required; optional `envelope` is the compact envelope with `needs_attention`
  attached per [LLD §3.4.1](../design/LLD.md#341-shared-types).
- **Priority:** Single `reason` per run when multiple rules match
  ([LLD §3.4.5](../design/LLD.md#345-needs-attention-derivation-fr-ctl-03)); details in
  [needs-attention spike](needs-attention-derivation-spike-2026-10-15.md) only.
- **Project-level budget:** `budget.exhausted` is always authoritative for `budget_exhausted` at project scope even when
  no run is listed in `needs_attention[]` ([T14.2 spike §`get_digest`](needs-attention-derivation-spike-2026-10-15.md)).

### `finished[]` and `failed[]` (Proposed assembly)

| Mode | `finished` / `failed` |
| --- | --- |
| Delta (`since_cursor` set) | Include a run iff the scan batch contains a `state_transition` (or equivalent terminalizing event) on that `run_id` to `SUCCEEDED` or `FAILED`, and the run is in caller scope. Envelope is built as for `get_run` at read time. |
| Full snapshot (`since_cursor` absent) | Include terminal runs in caller scope that remain within retention (e.g. `finished_at` or last terminal event within the retention window). Exact retention filter is **Proposed** for T14.3 tests. |

Runs that terminalized before the cursor position do not appear in a delta call (ROADMAP: “only events after” the cursor).

### `pending_approvals[]` (cross-link T14.8)

Items are `approval_proxy_item` ([LLD §3.4.1](../design/LLD.md#341-shared-types)): controller-generated fields only;
`scope_summary` max 512 and never agent text. Revision kinds (`dynamic_project`, `push_revision`) appear here per
[needs-attention spike §Digest boundary](needs-attention-derivation-spike-2026-10-15.md) and [approval proxy spike](approval-proxy-spike-2026-10-15.md).

**Proposed (delta):** Include an approval when it entered `PENDING` or changed in a way visible to the caller during the
scanned events, or on full snapshot include all current `PENDING` rows for the caller's proxy targets.

### `budget` and `paused` (depends on T14.4, T14.6)

| Field | Source task | Digest behaviour |
| --- | --- | --- |
| `budget.exhausted`, `budget.caps[]` | T14.4 | Current project (and global override) admission flags per [LLD §3.4.6](../design/LLD.md#346-budgets-and-loop-breaker-fr-ctl-06-fr-ctl-07) |
| `paused` | T14.6 | Current `control_plane_state` for the project and global pause ([LLD §3.4.7](../design/LLD.md#347-pause-and-budget-persistence-proposed)) |

**Proposed (delta):** Emit `budget` / `paused` on a project when the scan touches that `project_id` (budget refusal event,
pause toggle, or any `run_event` for a run in that project). On full snapshot, emit for every visible project.

## Untrusted and length-capped agent text (FR-TEL-01, FR-CTL-02)

FR-TEL-01 requires lifecycle steps to append `run_event` records; digest **incremental** behaviour is defined over those
rows ([LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02)). Agent-origin **content** in MCP output is governed separately:

| Rule | Source |
| --- | --- |
| Any `result.summary` (and any later agent-written field explicitly listed in LLD) on the digest path is copied into `untrusted_summaries[]`, not treated as instructions | [LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02), [FR-CTL-02](../requirements/SRS.md) |
| Each entry: `{ run_id, field: "result.summary", content: untrusted_text }` | [LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02) |
| `untrusted_text.text` max **500** characters; `label` const **`untrusted_agent_text`** | [LLD §3.4.1](../design/LLD.md#341-shared-types) |
| Envelope `result.summary` may allow up to 4000 in §3.0; on digest output, **strip or omit** inline `result.summary` from envelopes in `finished`, `failed`, and nested `needs_attention[].envelope` when the same text is exported in `untrusted_summaries` (Proposed; prevents duplicate authoritative-looking prose) | Aligns LLD §3.4.3 agent-text rule with FR-MCP-04 |
| `verification_summary` and other display-only prose | Follow §13.6 / inner-agent rules elsewhere; not expanded on digest unless LLD adds a `field` enum entry |
| No raw transcripts, provider stdout/stderr, or credentials in digest JSON | [FR-MCP-04](../requirements/SRS.md), [LLD §3.0](../design/LLD.md#30-shared-types) |

**ROADMAP T14.3 test:** A planted instruction string in a run summary appears only under `untrusted_summaries` with
`label: "untrusted_agent_text"` and length ≤ 500 (truncation policy: **Proposed** — suffix elision with no partial UTF-16
surrogate).

Sink payloads remain separate closed fields ([notification sinks spike](notification-sinks-spike-2026-10-15.md)); digest
does not forward agent text to sinks.

## Dependencies (no duplication of T14.2 body)

| Task | What T14.3 consumes |
| --- | --- |
| **T14.0** | Schemas, cursor type, scan budget target, section names ([LLD §3.4](../design/LLD.md#34-control-plane-m14-proposed-t140)) |
| **T14.1** `list_runs` | Shared envelope builder and caller scoping; parity: digest envelopes for a `run_id` match `get_run` / `list_runs` for the same caller ([FR-CTL-01](../requirements/SRS.md), [LLD §3.4.2](../design/LLD.md#342-list_runs-fr-ctl-01)) |
| **T14.2** | `needs_attention` derivation and reason priority — [spike](needs-attention-derivation-spike-2026-10-15.md) and [LLD §3.4.5](../design/LLD.md#345-needs-attention-derivation-fr-ctl-03) only |
| **T14.4** | `budget` facts |
| **T14.5** | Inputs to `needs_attention` reasons (`parked_loop`, `stalled`, `failed_after_retry`) |
| **T14.6** | `paused` flag |
| **T14.8** | `pending_approvals` population rules for proxy clients ([approval proxy spike](approval-proxy-spike-2026-10-15.md)) |
| **T14.9** | Optional push notifications; digest remains pull-based ([notification sinks spike](notification-sinks-spike-2026-10-15.md)) |
| **T14.11** | `get_digest` exposed on `console` profile ([console tool-profile spike](console-tool-profile-spike-2026-10-15.md)) |

## Implementation sketch (documentation only)

1. **COMP-LED:** `scanRunEvents(afterCursor, limit)` → ordered batch + last `evt_*`; `buildEnvelope(runId, caller)`
   (shared with T14.1/T14.2).
2. **COMP-MCP:** `get_digest` handler validates `since_cursor`, runs scan, groups affected `run_id` / `project_id`, assembles
   `projects[]` per delta vs snapshot rules above, attaches `untrusted_summaries`, returns `cursor`.
3. **No persistence** of digest state beyond `run_event`; cursor is opaque to clients except for validation pattern.

## T14.3 done-when (implementation, post-spike)

Per [ROADMAP §6.13](../ROADMAP.md#613-m14-control-plane-tasks): MCP tests — cursor filters
events; idempotent repeat; malicious summary in `untrusted_summaries` only. `node scripts/check-docs.mjs` passes.

## Related ADRs (cross-link only)

- [ADR-0007](../adr/0007-capacity-as-confidence-estimate.md) — budget caps are operator limits, not provider limits.
- [ADR-0047](../adr/0047-approval-proxy-over-mcp.md) — `pending_approvals` and proxy scope (Proposed).
- [ADR-0048](../adr/0048-notification-sinks.md) — push path orthogonal to digest pull (Proposed).
