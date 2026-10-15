# Loop breaker, stall detection and successor cap spike (T14.5), 2026-10-15

- Date: 2026-10-15
- Status: Research input (Delegated agent work, documentation only; not owner-approved). Normative contracts remain
  [LLD §3.4.6](../design/LLD.md#346-budgets-and-loop-breaker-fr-ctl-06-fr-ctl-07),
  [LLD §3.4.5](../design/LLD.md#345-needs-attention-derivation-fr-ctl-03),
  [FR-CTL-07](../requirements/SRS.md), [FR-CAP-05](../requirements/SRS.md), [FR-MCP-10](../requirements/SRS.md), and
  [FRD §4](../requirements/FRD.md#4-canonical-run-state-machine) (run states unchanged).
- Used by: [ROADMAP](../ROADMAP.md) T14.5, T14.2 (`parked_loop`, `stalled`, `failed_after_retry` inputs), T14.3
  (`get_digest` `needs_attention[]`), T14.6 (`meta_session.parked_loop` DDL shares migration timing). Cross-links only to
  merged M14 spikes: [needs-attention derivation](needs-attention-derivation-spike-2026-10-15.md) (T14.2; priority and
  envelope rules not restated), [operator budget admission](operator-budget-admission-spike-2026-10-15.md) (T14.4;
  `budget_exhausted` orthogonal).
- Scope: Operator settings **N**, **T**, and `max_successors_per_meta_session`; identical-failure counting and
  `parked_loop` parking; stall flag without cancel; successor admission cap (including FR-MCP-10 successors); mapping to
  `needs_attention` and digest exposure without migration; relationship to FR-CAP-05 automatic retry; future fake-adapter
  test plan. **No code.**

## Evidence labels

- **Verified (repo):** read in this repository on 2026-10-15.
- **Verified (spec):** requirement or LLD row cited by ID; accepted ADR decision text is cross-linked only, not restated.
- **Proposed:** admission error codes, event type names, or counting edge cases not yet locked by T14.5 tests.

## Primary sources

| ID | Source | Why it matters |
| --- | --- | --- |
| R1 | [LLD §3.4](../design/LLD.md#34-control-plane-m14-proposed-t140) | COMP-RTE enforces loop breaker and successor cap at admission; no new run state |
| R2 | [LLD §3.4.6](../design/LLD.md#346-budgets-and-loop-breaker-fr-ctl-06-fr-ctl-07) | Config keys, **N** / **T** / cap, parking and stall semantics |
| R3 | [LLD §3.4.5](../design/LLD.md#345-needs-attention-derivation-fr-ctl-03) | `parked_loop`, `stalled`, `failed_after_retry` derivation |
| R4 | [LLD §3.4.7](../design/LLD.md#347-pause-and-budget-persistence-proposed) | `meta_session.parked_loop` column (migration T14.5/T14.6) |
| R5 | [LLD §16.5](../design/LLD.md#165-retry-with-successor-runs) | FR-CAP-05 successor creation at T16; `attempt`, `parent_run_id` |
| R6 | [LLD §16.6](../design/LLD.md#166-quota-exhaustion-ladder-t66) | Quota failover successors count toward the same meta-session cap |
| R7 | [FR-CTL-07](../requirements/SRS.md) | Loop breaker, stall flag, successor cap requirement |
| R8 | [FR-CAP-05](../requirements/SRS.md), [FR-MCP-10](../requirements/SRS.md) | Retryable codes and successor linkage; cap bounds *successors*, not FR-CAP-05 attempt math alone |
| R9 | [FRD §4](../requirements/FRD.md#4-canonical-run-state-machine) | Terminal transitions; stall does not add `CANCELLED` |
| R10 | [TDD §3.1](../design/TDD.md#31-configuration) | `control_plane.loop_breaker` summary row |
| R11 | [needs-attention spike](needs-attention-derivation-spike-2026-10-15.md) | Read-path exposure (cross-link only) |

## Configuration (operator settings)

Validated at config load ([LLD §3.4.6](../design/LLD.md#346-budgets-and-loop-breaker-fr-ctl-06-fr-ctl-07),
[TDD §3.1](../design/TDD.md#31-configuration)). Values are **operator tuning**, never provider limits
([ADR-0007](../adr/0007-capacity-as-confidence-estimate.md)).

| Key | Type | Role |
| --- | --- | --- |
| `control_plane.loop_breaker.identical_failure_threshold` | integer ≥ 2 | **N**: park after N identical failures in one meta-session |
| `control_plane.loop_breaker.stall_minutes` | integer ≥ 1 | **T**: minutes without a `run_event` on a qualifying run → `stalled` only |
| `control_plane.loop_breaker.max_successors_per_meta_session` | integer ≥ 1 | Maximum successor runs admitted in one meta-session (all sources) |

**Assumption defaults** (LLD §3.4.6, not provider facts): **N** = 3, **T** = 30 minutes, **successor cap** = 8.

## Identical failures (**N**)

**Verified (LLD + FR-CTL-07):** In one `meta_session_id`, the controller counts terminal failures that share either:

1. The same normalized `failure_code` on the failed `run` row (FRD failure taxonomy), or
2. The same **failing verification name** when the failure is expressed as a verification outcome (bounded name in ledger
   events or structured verification payload — exact event field is **Proposed** until T14.5 tests plant rows).

Each counted failure is a **distinct run** in the meta-session that reached `FAILED` (or equivalent terminal failure path
in [FRD §4](../requirements/FRD.md#4-canonical-run-state-machine)). Retries and quota failover that produce a new run row
each contribute their own failure if that run ends `FAILED`.

**Fingerprint rule (Proposed):** Compare `failure_code` with case-sensitive equality. For verification identity, compare
the stable verification identifier recorded at finalize time (not free-form agent text). Mixed codes do not accumulate
toward **N** unless two runs share the same code or the same verification name.

**On the Nth match:** In the same ledger transaction that records the Nth qualifying failure, COMP-RTE sets
`meta_session.parked_loop = 1` ([LLD §3.4.7](../design/LLD.md#347-pause-and-budget-persistence-proposed)), emits a
bounded controller `run_event` on the failing run (payload: `threshold: N`, failure fingerprint, `meta_session_id` —
exact event type **Proposed**), and **does not schedule or admit any further successor** for that meta-session (FR-CTL-07).
FR-CAP-05 retry scheduling at T16 must consult parking before creating a successor ([LLD §3.4](../design/LLD.md#34-control-plane-m14-proposed-t140)).

**Relationship to FR-CAP-05:** Automatic retry (FR-CAP-05) applies only to `RATE_LIMIT_TRANSIENT`, `PROVIDER_OVERLOADED`,
and pre-mutation `PROCESS_CRASH` on an unchanged workspace. The loop breaker counts **any** qualifying identical failure,
including non-retryable codes such as `TEST_FAILURE`. A parked meta-session stops **all** successor admission, including
retry and quota failover successors ([FR-MCP-10](../requirements/SRS.md)).

## Parking (`parked_loop`)

| Concept | Behaviour (Verified — LLD) |
| --- | --- |
| Persistence | `meta_session.parked_loop INTEGER NOT NULL DEFAULT 0` ([LLD §3.4.7](../design/LLD.md#347-pause-and-budget-persistence-proposed)) |
| Admission | While `parked_loop = 1`, COMP-RTE refuses any new run row that would be a successor in that meta-session (`parent_run_id` chain, handoff successor, or `continue_task` successor — **Proposed** unified check at admission) |
| Unpark | **Proposed:** No automatic unpark in M14; operator clears the flag via a future operator action or config reload policy (out of T14.5 scope unless ROADMAP adds a task) |
| New meta-session | Parking does not block unrelated meta-sessions on the same project |

Parking is **not** a FRD run state. It does not transition an in-flight run to `CANCELLED` or `FAILED`.

## Stall detection (**T**, no events)

**Verified (LLD §3.4.5–3.4.6):** For a run with `state` in `RUNNING` or `LEASED` only, if there is no `run_event` row for
that `run_id` with timestamp within the last **T** minutes (`stall_minutes`, injectable clock), derivation sets
`needs_attention.reason = stalled`. The controller **does not** cancel the run, send SIGTERM, or transition to
`CANCELLED` (FR-CTL-07).

| Input | Rule |
| --- | --- |
| Qualifying states | `RUNNING`, `LEASED` only ([needs-attention spike](needs-attention-derivation-spike-2026-10-15.md#stalled); `QUEUED`, `PREFLIGHT`, `VERIFYING`, `FINALIZING` excluded until tests expand) |
| Clock reset | Any `run_event` for the `run_id` resets inactivity (including `state_transition`, adapter events, `steer_requested`, controller events) |
| Evaluation site | Read path (T14.2) uses `now` and latest `run_event.ts`; optional background evaluator is **Proposed** and must not cancel |
| Persistence | No stall column; flag is derived only (FR-CTL-03) |

## Successor cap at admission

**Verified (LLD):** `max_successors_per_meta_session` limits how many **successor run rows** may exist in one meta-session.
[LLD §3.4.6](../design/LLD.md#346-budgets-and-loop-breaker-fr-ctl-06-fr-ctl-07) states that §16.5 retry successors and
§16.6 quota failover successors both count toward the same total.

**Counting model (Proposed, test-locked):**

- Let `attempt` on the first run in a meta-session be `1` ([LLD §16.5](../design/LLD.md#165-retry-with-successor-runs)).
- Each admitted successor increments `attempt` on the new row.
- Refuse to create or admit another successor when the next successor would have `attempt > max_successors_per_meta_session`,
  or when `attempt` on the latest run already equals the cap and a further successor is requested.

**Enforcement points:**

1. **T16 scheduling (FR-CAP-05 / §16.5):** Before `scheduleRetry` inserts a row, check cap and `parked_loop`; record
   `retry_not_scheduled` with reason `successor_cap` or `meta_session_parked` (**Proposed** reason strings).
2. **Quota ladder (§16.6):** Failover/wait successors use the same cap check.
3. **Admission (`submit` / `delegate_task` / handoff):** COMP-RTE rejects a successor that would exceed the cap or
   attach to a parked meta-session (**Proposed** MCP error family: budget-style refusal vs `INVALID_REQUEST` — T14.5 tests
   pick one).

**Distinct from §16.5 `max_attempts`:** FR-CAP-05 backoff uses `max_attempts` from capacity/retry config ([ADR-0043](../adr/0043-capacity-estimate-breaker-and-retry.md)).
The loop-breaker **successor cap** is an operator control-plane ceiling (FR-CTL-07). Both must hold; the stricter limit
wins.

**FR-MCP-10:** `get_run` on a superseded run reports `superseded_by` ([LLD §16.5](../design/LLD.md#165-retry-with-successor-runs)).
When the cap blocks the next successor, the chain ends on the last `FAILED` run; derivation may surface
`failed_after_retry` (below).

## `needs_attention` mapping (no migration)

FR-CTL-03 flags are **derived on read** ([needs-attention spike](needs-attention-derivation-spike-2026-10-15.md#exposure-without-schema-migration-fr-ctl-03)).
T14.5 writers supply ledger facts; T14.2 derives reasons. No SQLite column is required for `stalled`.

| T14.5 mechanism | `needs_attention_reason` | Ledger / config facts | Digest / envelope (cross-link T14.2/T14.3) |
| --- | --- | --- | --- |
| Loop breaker park | `parked_loop` | `meta_session.parked_loop = 1` | Newest run in the meta-session carries `reason: parked_loop` on `get_run` / `list_runs`; `get_digest.projects[].needs_attention[]` includes `{ run_id, reason: "parked_loop" }` with optional nested envelope |
| Stall (**T**) | `stalled` | Non-terminal `RUNNING`/`LEASED`, no `run_event` within **T** minutes | Same surfaces with `reason: "stalled"` on the inactive run's envelope |
| Successor cap exhausted | `failed_after_retry` | `run.state = FAILED` and `run.attempt = max_successors_per_meta_session`, **or** parked meta-session with a failed newest run | Envelope on the failed run; digest entry per run where `active` would be true |
| Cap refusal at admission (no new row) | — (no new run) | Admission refused before insert | **Proposed:** Project-level attention only if another non-terminal run already carries a reason; otherwise operator learns via MCP error and existing failed run's `failed_after_retry` |

**Priority when multiple reasons apply** (do not restate full table): `parked_loop` ranks above `stalled` and
`failed_after_retry`; `budget_exhausted` ranks above `parked_loop` ([needs-attention spike](needs-attention-derivation-spike-2026-10-15.md#multiple-reasons-priority-proposed)).

**Fail-closed (pre-migration):** Missing `meta_session.parked_loop` column or NULL treated as `0`; do not infer
`parked_loop` without the flag ([needs-attention spike](needs-attention-derivation-spike-2026-10-15.md#fail-closed-defaults-proposed)).

**Notification sinks (T14.9):** When derived attention becomes active, sinks may emit `event_kind: needs_attention` with
`reason_code` equal to the winning reason (`parked_loop`, `stalled`, or `failed_after_retry`). Cross-link only —
[notification sinks spike](notification-sinks-spike-2026-10-15.md).

## Operator caps vs loop breaker

| Mechanism | Config | Interaction |
| --- | --- | --- |
| Operator budgets (T14.4) | `control_plane.budgets.*` | Refuses **admission** for budget; reason `budget_exhausted` — [operator budget spike](operator-budget-admission-spike-2026-10-15.md) |
| Loop breaker (T14.5) | `control_plane.loop_breaker.*` | Parks meta-session or flags stall; caps successors per meta-session |
| FR-CAP-05 retry | `max_attempts`, backoff | May create successors until cap or park blocks |

A run may show `budget_exhausted` and `stalled` on different runs in the same project; priority picks one reason per
envelope.

## Dependencies

| Task | Relationship |
| --- | --- |
| **T14.0** | Schemas and config keys ([LLD §3.4.6](../design/LLD.md#346-budgets-and-loop-breaker-fr-ctl-06-fr-ctl-07)) |
| **T14.2** | Derives `parked_loop`, `stalled`, `failed_after_retry` — [spike](needs-attention-derivation-spike-2026-10-15.md) |
| **T14.3** | `needs_attention[]` assembly — [get_digest spike](get-digest-spike-2026-10-15.md) |
| **T14.4** | Orthogonal budget refusal |
| **T14.6** | May ship `meta_session.parked_loop` migration alongside `control_plane_state` |
| **M6 (built)** | §16.5/§16.6 successor creation must gain cap and park checks when T14.5 lands |

## Future implementation test plan (T14.5 done-when)

Fake-adapter or synthetic ledger tests with **injected clock** and planted `run` / `run_event` / `meta_session` rows.
No real provider CLIs.

1. **Identical `failure_code` → park:** With **N** = 3, three `FAILED` runs in one meta-session with `failure_code =
   TEST_FAILURE` set `parked_loop = 1`, emit park event, and block a fourth `delegate_task` / retry successor; assert
   `get_run` on the newest run has `needs_attention.reason === "parked_loop"` (T14.2 wiring).
2. **Identical verification name → park:** Three failures with distinct codes but the same failing verification
   fingerprint park the session (**Proposed** fixtures).
3. **Non-identical failures:** **N** − 1 mixed codes do not park; a successor may still be admitted if under cap.
4. **Park blocks FR-CAP-05 retry:** After park, a retryable `RATE_LIMIT_TRANSIENT` on a clean workspace does **not**
   create a successor; `retry_not_scheduled` (or equivalent) cites park/cap.
5. **Stall flag only:** Run in `RUNNING`, no new `run_event` for **T** + ε (clock injection); assert
   `needs_attention.reason === "stalled"`; assert run remains `RUNNING` (or `LEASED`) and **no** cancel event and **no**
   transition to `CANCELLED`.
6. **Stall reset:** After stall would apply, insert a `run_event`; assert `stalled` clears on next `get_run`.
7. **Stall scope:** Run in `QUEUED` with no events does **not** get `stalled` (LLD literal until expanded).
8. **Successor cap:** With cap = 8, admit successors until `attempt === 8` on a terminal failure; refuse the next
   successor at admission or T16 with a recorded reason; assert `failed_after_retry` on the last failed run when
   `attempt` equals cap.
9. **Quota failover counts:** A §16.6 failover successor increments the same meta-session successor count toward the cap
   (synthetic `QUOTA_EXHAUSTED` ladder).
10. **Priority:** Parked meta-session with a stalled run exposes `parked_loop` over `stalled` on the newest run envelope.
11. **Digest parity:** For each case, `get_digest.projects[].needs_attention[]` matches `get_run` for the same `run_id`
    (T14.3 wiring).
12. **Unset / defaults:** Config load accepts Assumption defaults **N**=3, **T**=30, cap=8 when keys omitted (**Proposed**
    test config fragment).

## Related ADRs (cross-link only)

- [ADR-0007](../adr/0007-capacity-as-confidence-estimate.md) — operator **N**, **T**, and cap are not provider limits.
- [ADR-0043](../adr/0043-capacity-estimate-breaker-and-retry.md) — retry successors and `get_run` supersession chain (M6).
- [ADR-0006](../adr/0006-worktree-checkpoints-no-blind-replay.md) — workspace unchanged gate for FR-CAP-05 retry.
