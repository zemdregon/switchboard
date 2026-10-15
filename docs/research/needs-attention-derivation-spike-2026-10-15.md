# Derived `needs_attention` flag spike (T14.2), 2026-10-15

- Date: 2026-10-15
- Status: Research input (Delegated agent work, documentation only; not owner-approved). Normative contracts remain
  [LLD §3.4.5](../design/LLD.md#345-needs-attention-derivation-fr-ctl-03), [FR-CTL-03](../requirements/SRS.md),
  [FR-CTL-07](../requirements/SRS.md) (loop-breaker inputs), and [FRD §4](../requirements/FRD.md#4-canonical-run-state-machine)
  (run states unchanged).
- Used by: [ROADMAP](../ROADMAP.md) T14.2, T14.1 (`list_runs` envelope), T14.3 (`get_digest` assembly), T14.4–T14.6
  (budget, loop breaker, pause inputs). Cross-links only to merged M14 spikes: [notification sinks](notification-sinks-spike-2026-10-15.md)
  (T14.9), [approval proxy](approval-proxy-spike-2026-10-15.md) (T14.8), [console tool profile](console-tool-profile-spike-2026-10-15.md)
  (T14.11). Consent-page link (T14.10) is out of scope here; see the separate consent-link spike when landed.
- Scope: Closed `needs_attention_reason` list, ledger facts and events that derive each reason, read-path exposure on
  `get_run`, future `list_runs` and `get_digest`, priority when multiple reasons apply, fail-closed defaults, and open
  dependencies. **No new run state** (FR-CTL-03, ROADMAP §6.13 conventions). No code.

## Evidence labels

- **Verified (repo):** read in this repository on 2026-10-15.
- **Verified (spec):** requirement or LLD row cited by ID; accepted ADR decision text is cross-linked only, not restated.
- **Proposed:** T14.0/T14.2 implementation choices not yet fixed by tests.

## Primary sources

| ID | Source | Why it matters |
| --- | --- | --- |
| R1 | [LLD §3.4](../design/LLD.md#34-control-plane-m14-proposed-t140) | Control-plane gate; shared types; tool shapes |
| R2 | [LLD §3.4.1](../design/LLD.md#341-shared-types) | `needs_attention`, `needs_attention_reason` JSON Schema |
| R3 | [LLD §3.4.5](../design/LLD.md#345-needs-attention-derivation-fr-ctl-03) | Derivation table and reason priority |
| R4 | [LLD §3.4.6](../design/LLD.md#346-budgets-and-loop-breaker-fr-ctl-06-fr-ctl-07) | Budget refusal, loop breaker, stall **T**, successor cap |
| R5 | [LLD §3.0 envelope](../design/LLD.md#30-shared-types) | Compact `get_run` / `list_runs` row shape (FR-MCP-04) |
| R6 | [LLD §3.4.2–3.4.3](../design/LLD.md#342-list_runs-fr-ctl-01) | `list_runs` and `get_digest` output fields |
| R7 | [FR-CTL-03](../requirements/SRS.md), [FR-CTL-07](../requirements/SRS.md) | Requirement IDs for flag and loop-breaker inputs |
| R8 | [FRD §4](../requirements/FRD.md#4-canonical-run-state-machine) | Canonical run states; `AWAITING_APPROVAL` is a state, `needs_attention` is not |
| R9 | [LLD DDL `run`, `run_event`, `approval`, `meta_session`](../design/LLD.md#1-data-model) | Ledger rows used at derivation time |
| R10 | [notification sinks spike §Closed reason_code](notification-sinks-spike-2026-10-15.md#closed-reason_code-values-cross-check-fr-ctl-03-and-adr-0047) | Sink `reason_code` alignment (T14.9; cross-link only) |

## Closed reason list (exactly five)

Matches [LLD §3.4.1](../design/LLD.md#341-shared-types) and [FR-CTL-03](../requirements/SRS.md). No extension without SRS/LLD
change.

| `needs_attention_reason` | Meaning (operator-facing) |
| --- | --- |
| `awaiting_approval` | A privileged or policy-gated approval is outstanding for a run the caller may see |
| `parked_loop` | Loop breaker parked the meta-session; no further successors are admitted |
| `failed_after_retry` | A run failed after exhausting the configured successor cap (or alongside a parked meta-session) |
| `stalled` | A non-terminal run has had no ledger activity for **T** minutes; the run is not cancelled |
| `budget_exhausted` | Admission is refused because an operator budget cap is active for the project or globally |

These are **not** FRD run states. Derivation runs on read in COMP-LED (envelope assembly) using facts already written by
COMP-RTE, COMP-POL and lifecycle transitions (SDD FR-CTL-03 row).

## Derivation: ledger rows and events per reason

The table below maps each reason to **ledger facts** (rows and bounded `run_event` types). It does not introduce states
or transitions. Persistence additions from later tasks (for example `meta_session.parked_loop`,
`control_plane_state`) are
named in [LLD §3.4.6–3.4.7](../design/LLD.md#347-pause-and-budget-persistence-proposed); T14.2 derives from them once
those writers exist (T14.4–T14.5).

### `awaiting_approval`

| Source | Ledger fact | Typical `run_event` / notes |
| --- | --- | --- |
| Privileged first run | `run.state = 'AWAITING_APPROVAL'` ([FRD T2](../requirements/FRD.md#4-canonical-run-state-machine)) | Admission `state_transition` (T2); first events on the new run |
| Privileged approval row | `approval.status = 'PENDING'` where `approval.run_id` references a run in the same `meta_session_id` the caller may see ([LLD §3.1](../design/LLD.md#31-privileged-scope-m3)) | `approval` row created with the run; envelope may include `approval.status` |
| Operator decision path | Same until `approval` leaves `PENDING` | `operator_decision_requested` / `approval_closed` style events ([LLD §3.1](../design/LLD.md#31-privileged-scope-m3)); no MCP decision |

**Caller scope:** Same as `get_run` — only runs the caller started or projects it may use. A `PENDING` approval on another
client's meta-session does not set the flag for this caller.

**Digest boundary:** Project-revision approvals (`dynamic_project`, `push_revision`) appear under `get_digest.pending_approvals`
([LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02), [approval proxy spike](approval-proxy-spike-2026-10-15.md)) when
listed for the proxy; they are not extra `needs_attention_reason` strings. If a revision approval blocks a **run** in
`AWAITING_APPROVAL` or holds a `PENDING` `approval` row tied to that run's meta-session, `awaiting_approval` applies to
that run's envelope.

### `parked_loop`

| Source | Ledger fact | Typical `run_event` / notes |
| --- | --- | --- |
| Loop breaker (FR-CTL-07) | `meta_session.parked_loop = 1` ([LLD §3.4.7](../design/LLD.md#347-pause-and-budget-persistence-proposed), written by T14.5) | Controller records the park decision (bounded payload: threshold, failure fingerprint); no successor admitted |
| Display run | **Newest** run in the parked meta-session (by `run.created_at`) carries `needs_attention.reason = parked_loop` on its envelope ([LLD §3.4.5](../design/LLD.md#345-needs-attention-derivation-fr-ctl-03)) | Older runs in the same session may be terminal without an active flag if a higher-priority reason does not apply |

Parking is triggered after **N** identical `failure_code` or identical failing verification name in one meta-session
([LLD §3.4.6](../design/LLD.md#346-budgets-and-loop-breaker-fr-ctl-06-fr-ctl-07)); counting uses existing `run.failure_code`,
verification results in bounded events, and successor `run.attempt` chain.

### `failed_after_retry`

| Source | Ledger fact | Typical `run_event` / notes |
| --- | --- | --- |
| Terminal failure at cap | `run.state = 'FAILED'` and `run.attempt = control_plane.loop_breaker.max_successors_per_meta_session` | Terminal `state_transition`; `failure_code` set per FRD |
| Parked meta-session | `run.state = 'FAILED'` while `meta_session.parked_loop = 1` | May co-occur with `parked_loop`; priority table usually surfaces `parked_loop` first |

Does **not** apply to a terminal `SUCCEEDED` or `CANCELLED` run with no matching rule. A failed first attempt with
successors remaining typically has `active: false` unless another reason (for example `stalled` on a different run in the
session) applies.

### `stalled`

| Source | Ledger fact | Typical `run_event` / notes |
| --- | --- | --- |
| Stall detector (FR-CTL-07) | `run.state` in `RUNNING` or `LEASED` (non-terminal) | Any `run_event` with `run_id` resets the stall clock |
| Inactivity | No `run_event` for this `run_id` with `ts` within the last **T** minutes (`control_plane.loop_breaker.stall_minutes`, default **30**, Assumption in §3.4.6) | Uses injectable clock in tests; **does not** emit cancel or transition to `CANCELLED` |

States such as `QUEUED`, `PREFLIGHT`, `VERIFYING`, or `FINALIZING` are out of scope for the LLD stall rule unless T14.5
tests expand the set; until then, implement §3.4.5 literally (`RUNNING` or `LEASED` only).

### `budget_exhausted`

| Source | Ledger fact | Typical `run_event` / notes |
| --- | --- | --- |
| Admission refusal (FR-CTL-06) | Active budget refusal on the project or global scope in `control_plane_state.budget_flags_json` ([LLD §3.4.7](../design/LLD.md#347-pause-and-budget-persistence-proposed), written by T14.4) | `budget_refused` recorded on the project ([LLD §3.4.6](../design/LLD.md#346-budgets-and-loop-breaker-fr-ctl-06-fr-ctl-07)); cap keys and admission rules: [operator budget admission spike](operator-budget-admission-spike-2026-10-15.md) (T14.4) |
| Project linkage | Resolve `project_id` from `meta_session.project_id` or `run.project_id` / policy snapshot | Refusal persists until window reset or operator raises cap |

`needs_attention` for this reason may attach to the **newest non-terminal run** in the project or to a synthetic digest
row at project level (see `get_digest` below). Envelope attachment for a specific `run_id` should match what T14.4 tests
define; project-level exhaustion is always visible on `get_digest.budget.exhausted`.

## Multiple reasons: priority (Proposed)

When more than one rule matches, expose **one** `reason` on the envelope and digest entry ([LLD §3.4.5](../design/LLD.md#345-needs-attention-derivation-fr-ctl-03)):

1. `budget_exhausted`
2. `parked_loop`
3. `awaiting_approval`
4. `stalled`
5. `failed_after_retry`

T14.2 implementation may adjust this order only with tests that lock UI-stable behaviour. Sinks that emit `event_kind:
needs_attention` should use the same winning reason ([notification sinks spike](notification-sinks-spike-2026-10-15.md);
T14.9).

## Exposure without schema migration (FR-CTL-03)

The flag is **computed at read time** and added to MCP JSON outputs. Existing ledger columns and envelope required fields
stay as in [LLD §3.0](../design/LLD.md#30-shared-types). No migration is required solely for `needs_attention`.

### Shape (shared)

```jsonc
"needs_attention": {
  "active": true,
  "reason": "awaiting_approval"   // required when active is true; omitted when active is false
}
```

When `active` is `false`, omit `reason` ([LLD §3.4.1](../design/LLD.md#341-shared-types)).

### `get_run` (today + T14.2)

- **Where:** Top-level field on the returned envelope (same object as `run_id`, `status`, …), optional in schema until
  T14.2 ships; once implemented, always present with at least `active`.
- **Behaviour:** Recompute on every call from current ledger rows; idempotent for unchanged facts.
- **Terminal runs:** If no rule matches, `needs_attention.active` is `false` and `reason` is absent (ROADMAP T14.2 done-when).
- **Events:** `include_events` is unchanged; stall and loop-breaker logic uses event timestamps, not client-supplied data.

### `list_runs` (T14.1 — not implemented on `main`)

- **Where:** Each element of `runs[]` is the same compact envelope as `get_run` for that `run_id` ([LLD §3.4.2](../design/LLD.md#342-list_runs-fr-ctl-01),
  FR-CTL-01).
- **Behaviour:** Call the same derivation function as `get_run` per row; do not cache a stale flag across pages.
- **Dependency:** T14.1 must land before MCP tests can assert parity; T14.2 should implement derivation in COMP-LED once
  and invoke it from both code paths.

### `get_digest` (T14.3)

- **Per-run attention:** `projects[].needs_attention[]` entries require `run_id` and `reason`, optional nested `envelope`
  ([LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02)). Include one entry per run in the caller's projects where
  `needs_attention.active` would be true on `get_run`, using the same priority table.
- **Budget:** `projects[].budget.exhausted` and per-cap `used` / `limit` reflect `budget_exhausted` at project scope
  even when no single run is the best attachment target.
- **Not duplicated here:** `pending_approvals` (approval proxy items), `finished` / `failed` arrays, pause `paused`, and
  `untrusted_summaries` — assembled per T14.3; this spike only requires that any run listed in `needs_attention` matches
  `get_run` for the same `run_id`.
- **Cursor:** Digest delta is driven by `run_event` scan (FR-TEL-01); recomputing `needs_attention` on each digest call
  avoids persisting the flag.

## Fail-closed defaults (Proposed)

| Situation | Default |
| --- | --- |
| Run not found or caller lacks scope | No envelope; existing `INVALID_REQUEST` / `PERMISSION_BLOCKED` (unchanged) |
| `control_plane` config missing or invalid at load | Controller refuses to start (existing config validation); no partial MCP surface |
| Budget / loop-breaker persistence not yet migrated (pre–T14.4/T14.5) | Treat missing `control_plane_state` / `parked_loop` as false; do not infer `budget_exhausted` or `parked_loop` |
| Ambiguous project id on old runs (`project_id` NULL) | Budget reason applies only when project resolution succeeds; otherwise omit `budget_exhausted` for that run |
| Clock / stall evaluation error in tests | Fail closed to `active: false` for `stalled` rather than flagging all running runs |
| Two reasons match | Apply priority table; never return multiple `reason` values on one envelope |

Deriving `active: true` without a closed `reason` is forbidden by schema. Deriving a sixth reason string is forbidden
(FR-CTL-03).

## Open dependencies and task boundaries

| Dependency | Owner task | What T14.2 needs |
| --- | --- | --- |
| `list_runs` MCP tool | T14.1 | Envelope parity tests; shared derivation entry point |
| Budget refusal persistence and admission checks | T14.4 | `budget_exhausted` facts in `control_plane_state` |
| Loop breaker, stall detector, successor cap | T14.5 | `parked_loop`, `stalled`, `failed_after_retry` inputs |
| `get_digest` assembly | T14.3 | Project-level arrays and `budget.exhausted`; consumes T14.2 derivation |
| Pause | T14.6 | `paused` on digest; pause holds admission but is **not** a `needs_attention_reason` |
| Notification delivery | T14.9 | Emit `needs_attention` sink events when the derived flag becomes true (cross-link only) |
| Approval proxy / consent link | T14.8 / T14.10 | `pending_approvals` and consent URLs; not alternate reason enums |

**T14.2 done-when (implementation, post-spike):** Unit/integration tests per ROADMAP — each of the five reasons from
planted ledger rows; terminal run with no rule → `active: false`; FRD state-machine tests unchanged.

## Implementation sketch (documentation only)

1. Add `deriveNeedsAttention(runId, callerScope, now, config)` in COMP-LED (name Proposed) reading `run`, `meta_session`,
   `approval`, recent `run_event` timestamps, and `control_plane_state` for the resolved `project_id`.
2. Extend envelope builder used by `get_run` (and later `list_runs`) to attach `needs_attention`.
3. Export the same helper to COMP-MCP / digest builder for T14.3.
4. Do not write `needs_attention` to SQLite; do not add FRD transitions.

## Related ADRs (cross-link only)

- [ADR-0007](../adr/0007-capacity-as-confidence-estimate.md) — operator caps are not provider limits (FR-CTL-06, LLD §3.4.6).
- [ADR-0048](../adr/0048-notification-sinks.md) — closed sink payloads for attention events (T14.9).
- [ADR-0047](../adr/0047-approval-proxy-over-mcp.md) — proxied approvals; digest list separate from this flag.
