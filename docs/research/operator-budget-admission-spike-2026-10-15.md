# Operator budget caps at admission spike (T14.4), 2026-10-15

- Date: 2026-10-15
- Status: Research input (Delegated agent work, documentation only; not owner-approved). Normative contracts remain
  [LLD §3.4.6](../design/LLD.md#346-budgets-and-loop-breaker-fr-ctl-06-fr-ctl-07),
  [LLD §3.4.7](../design/LLD.md#347-pause-and-budget-persistence-proposed), [FR-CTL-06](../requirements/SRS.md),
  [FR-CAP-04](../requirements/SRS.md), [NFR-PERF-03](../requirements/SRS.md), and [TDD §3.1](../design/TDD.md#31-configuration)
  (`control_plane.budgets`).
- Used by: [ROADMAP](../ROADMAP.md) T14.4, T14.2 (`budget_exhausted` derivation), T14.3 (`get_digest.budget`),
  T14.9 (sink `event_kind` `budget_exhausted`). Cross-links only to merged M14 spikes:
  [needs-attention derivation](needs-attention-derivation-spike-2026-10-15.md) (T14.2; derivation rules not restated),
  [get_digest](get-digest-spike-2026-10-15.md) (T14.3; digest assembly not restated).
- Scope: Four operator budget dimensions, configuration keys and defaults, admission refusal and persistence,
  `budget_exhausted` on read paths without new run state, separation from FR-CAP-04 concurrency and provider capacity
  ([ADR-0007](../adr/0007-capacity-as-confidence-estimate.md)), and a future implementation test plan. **No code.**

## Evidence labels

- **Verified (repo):** read in this repository on 2026-10-15.
- **Verified (spec):** requirement or LLD row cited by ID; accepted ADR decision text is cross-linked only, not restated.
- **Proposed:** enforcement ordering, MCP error mapping, or counter sources not yet locked by T14.4 tests.

## Primary sources

| ID | Source | Why it matters |
| --- | --- | --- |
| R1 | [LLD §3.4](../design/LLD.md#34-control-plane-m14-proposed-t140) | COMP-RTE enforces budgets at admission; no new run state |
| R2 | [LLD §3.4.6](../design/LLD.md#346-budgets-and-loop-breaker-fr-ctl-06-fr-ctl-07) | Config keys, refusal persistence, digest counters |
| R3 | [LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02) | `budget.exhausted`, `budget.caps[]` shape |
| R4 | [LLD §3.4.5](../design/LLD.md#345-needs-attention-derivation-fr-ctl-03) | `needs_attention_reason` `budget_exhausted` |
| R5 | [LLD §3.4.7](../design/LLD.md#347-pause-and-budget-persistence-proposed) | `control_plane_state.budget_flags_json` |
| R6 | [FR-CTL-06](../requirements/SRS.md) | Caps, admission refusal, operator-not-provider wording |
| R7 | [FR-CAP-04](../requirements/SRS.md), [NFR-PERF-03](../requirements/SRS.md) | Bounded queue and concurrency limits (separate knobs) |
| R8 | [TDD §3.1](../design/TDD.md#31-configuration) | `control_plane.budgets` summary row |
| R9 | [needs-attention spike §`budget_exhausted`](needs-attention-derivation-spike-2026-10-15.md) | Read-path exposure (cross-link only) |
| R10 | [get_digest spike §`budget`](get-digest-spike-2026-10-15.md) | Digest fields (cross-link only) |

## Budget dimensions and configuration

Operator budgets are **configuration-only ceilings** validated at config load. Per
[LLD §3.4.6](../design/LLD.md#346-budgets-and-loop-breaker-fr-ctl-06-fr-ctl-07), **absent** key ⇒ **unlimited** for that
dimension (not zero). There are **no LLD Assumption defaults** for budget caps (unlike loop-breaker **N**, **T**, and
successor cap in the same section).

Global keys live under `control_plane.budgets.global.*`. Per-project overrides use the same leaf names under
`control_plane.budgets.projects.<project_id>.*` ([TDD §3.1](../design/TDD.md#31-configuration)).

| Dimension | Digest `caps[].key` | Config leaf (under `global` or `projects.<id>`) | Type | Meaning (Verified — LLD) |
| --- | --- | --- | --- | --- |
| Runs per day | `runs_per_day` | `runs_per_day` | integer ≥ 0 or absent | Admission count per **UTC calendar day**, all projects (global) or one project (override) |
| Concurrent runs | `concurrent_runs` | `concurrent_runs` | integer ≥ 0 or absent | **Non-terminal** runs at once in scope |
| Wall-clock per run | `wall_clock_per_run` | `wall_clock_per_run_seconds` | integer ≥ 0 or absent | Wall clock from `LEASED` to terminal for a single run |
| Reported usage per window | `usage_per_window` | `usage_per_window` | object or absent | Rolling window over **provider-reported** usage |

### `usage_per_window` object shape

| Field | Type | Meaning |
| --- | --- | --- |
| `window_seconds` | integer ≥ 1 | Rolling window length (**Proposed** minimum 60 at config load if present; LLD silent) |
| `max_reported_tokens` | integer ≥ 0 | Cap on summed provider-reported token count in the window |

**Proposed (token sum source):** Count `usage_observation` rows with `source = 'provider_reported'` for runs whose
`project_id` matches the budget scope, with `observed_at` (or equivalent timestamp column) within
`now - window_seconds .. now`. Use the same numeric fields the capacity estimator treats as provider-reported usage
([LLD §16](../design/LLD.md#16-capacity-and-resilience-m6)); do not treat `controller_estimated` rows as budget usage.

**Proposed (example only, not a default):** `window_seconds: 86400`, `max_reported_tokens: 500000` in operator docs or
tests — labelled Assumption until T14.4 tests pin an example.

### Example config fragment (documentation)

```yaml
control_plane:
  budgets:
    global:
      runs_per_day: 200
      concurrent_runs: 8
    projects:
      acme-api:
        runs_per_day: 40
        concurrent_runs: 2
        wall_clock_per_run_seconds: 7200
        usage_per_window:
          window_seconds: 86400
          max_reported_tokens: 100000
```

## Admission check (COMP-RTE)

Budget checks run on the same path as `delegate_task` / `continue_task` admission, **before** a new run reaches `QUEUED`,
alongside pause, loop-breaker successor rules, and FR-CAP-04 ingress ([LLD §3.4](../design/LLD.md#34-control-plane-m14-proposed-t140),
[LLD §18 step 4](../design/LLD.md#18-project-queue-schedules-and-ci-triggers-m15-proposed-t150) for M15 queue items).

**Proposed check order within budgets:** For the resolved `project_id`, evaluate **project override** then **global** for
each dimension (stricter effective limit is the **lower** positive limit when both set; **Proposed** until T14.4 tests
record merge rules). A dimension with no configured limit is skipped.

| Dimension | Checked at admission (Proposed) | Notes |
| --- | --- | --- |
| `runs_per_day` | Yes | Count admissions (or terminal admissions only — **Proposed:** count each successful admission that created a run row) since UTC midnight |
| `concurrent_runs` | Yes | Count runs in non-terminal FRD states for the scope |
| `usage_per_window` | Yes | Compare rolling sum to `max_reported_tokens` |
| `wall_clock_per_run_seconds` | Partially | Per-run duration is enforced from `LEASED` onward; **Proposed:** exceeding the cap on an in-flight run sets active budget refusal for the project (same persistence as other refusals) and blocks **new** admissions until reset; admitting a new run does not pre-check duration |

`continue_task` that would create a successor run is subject to the same caps as `delegate_task` when admission would
create a new `run` row (successor cap remains [loop breaker](../design/LLD.md#346-budgets-and-loop-breaker-fr-ctl-06-fr-ctl-07),
T14.5).

### Refusal behaviour

When any configured dimension is over its effective limit at admission time ([FR-CTL-06](../requirements/SRS.md)):

1. **No new run** is created; the FRD state machine is unchanged for existing runs.
2. The controller records **`budget_refused`** on the project (ledger `project_event` or equivalent bounded event per
   [LLD §3.4.6](../design/LLD.md#346-budgets-and-loop-breaker-fr-ctl-06-fr-ctl-07)).
3. **`control_plane_state.budget_flags_json`** for that `project_id` holds the active refusal facts until the window
   resets, usage falls below the cap, concurrent count drops, or the operator raises/removes the cap
   ([LLD §3.4.7](../design/LLD.md#347-pause-and-budget-persistence-proposed)). Global-only exhaustion may also set flags
   on `project_id = '*'` or replicate to affected projects — **Proposed:** T14.4 tests choose one shape; digest must
   still report per visible `project_id`.
4. **MCP error (Proposed):** Fail closed with no side effect beyond (2–3), analogous to `QUEUE_FULL` (ROADMAP Q-5):
   `ELIGIBILITY_NONE` or `INVALID_REQUEST` with `details.reason` naming the exhausted dimension (for example
   `BUDGET_EXHAUSTED`) and `details.cap` matching digest `caps[].key`. Exact top-level code is **not** in LLD §4 yet;
   T14.4 implementation should align with BR-3 mapping tests.

Refusal is **not** retry-automatic like `QUEUE_FULL` for a full ingress queue: the project stays flagged until reset or
operator action ([LLD §3.4.6](../design/LLD.md#346-budgets-and-loop-breaker-fr-ctl-06-fr-ctl-07)).

## `budget_exhausted` without migration

FR-CTL-03 `needs_attention` remains **derived on read** (T14.2); FR-CTL-06 does not add a run state.

| Surface | How `budget_exhausted` appears (Verified — LLD + T14.2 spike) |
| --- | --- |
| `get_run` / `list_runs` envelope | `needs_attention.active: true`, `reason: "budget_exhausted"` when active budget refusal exists for the run's project ([LLD §3.4.5](../design/LLD.md#345-needs-attention-derivation-fr-ctl-03)); attachment to newest non-terminal run is **Proposed** — see [needs-attention spike](needs-attention-derivation-spike-2026-10-15.md) |
| `get_digest` | `projects[].budget.exhausted: true` and `caps[]` with `used` / `limit` (`limit: null` when unset); project-level exhaustion is authoritative even if `needs_attention[]` omits a run ([get_digest spike](get-digest-spike-2026-10-15.md)) |
| Notification sinks (T14.9) | `event_kind` `budget_exhausted`, `reason_code` `budget_exhausted` ([LLD §3.4.1](../design/LLD.md#341-shared-types)); delivery is best-effort off the run path |

Persistence uses the **Proposed** `control_plane_state` DDL in [LLD §3.4.7](../design/LLD.md#347-pause-and-budget-persistence-proposed)
(migration may land with T14.6 pause work); T14.4 owns writers/readers for `budget_flags_json` only. No alteration to
`run.status` or FRD transitions.

**Clearing exhaustion:** **Proposed:** `budget.exhausted` becomes false when no dimension is over limit at read time
(recompute from ledger + config) and `budget_flags_json` is cleared or aged out; UTC day rollover clears `runs_per_day`
refusal; rolling `usage_per_window` clears when observations age out.

## Operator caps vs provider limits (ADR-0007)

These are **different control planes**. Operator budget caps must never be labelled or formatted like provider quota,
TPM/RPM, or subscription remainder ([FR-CTL-06](../requirements/SRS.md), [ADR-0007](../adr/0007-capacity-as-confidence-estimate.md)).

| Mechanism | Config / code path | Purpose |
| --- | --- | --- |
| **Operator budgets (T14.4)** | `control_plane.budgets.*` | Operator policy: how much work Switchboard admits per project/global |
| **Global / per-provider concurrency (M1/M6)** | `limits.global_concurrency`, `limits.per_provider_concurrency`, `providers.<id>.concurrency` | FR-CAP-04 dispatcher semaphores; defaults **4** global and **1** per provider (**proposed target**, NFR-PERF-03) |
| **Bounded ingress queue (M1)** | Internal queue size | `QUEUE_FULL` at admission when full (not a budget cap) |
| **Capacity estimator / `get_capacity` (M6)** | `capacity.*`, `usage_observation`, breaker | Confidence-weighted **estimate**; `explicit_remaining` only when provider reports it |
| **Rate gate (T6.8)** | — | **Deferred** — no enforceable provider limit in source |
| **Provider rate-limit events** | `run_event` / adapter signals | Inform routing and `get_capacity`; not substituted for `control_plane.budgets` |

Wording rules for CLI, MCP, `doctor`, and `get_capacity` mirror [LLD §16](../design/LLD.md#16-capacity-and-resilience-m6):
surfaces that describe `control_plane.budgets` use **operator**, **cap**, or **budget** language; surfaces that describe
provider health use **estimate**, **confidence**, or **provider-reported** language. Digest `limit: null` means unset,
not “unlimited provider quota” ([LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02)).

## Dependencies

| Task | Relationship |
| --- | --- |
| **T14.0** | Schemas and config key names ([LLD §3.4.6](../design/LLD.md#346-budgets-and-loop-breaker-fr-ctl-06-fr-ctl-07)) |
| **T14.2** | Derives `needs_attention.reason = budget_exhausted` from `control_plane_state` / `budget_refused` — [spike](needs-attention-derivation-spike-2026-10-15.md) |
| **T14.3** | Exposes `budget` on digest — [spike](get-digest-spike-2026-10-15.md) |
| **T14.6** | Shares `control_plane_state` table; pause is orthogonal |
| **T14.9** | May emit sink events on new exhaustion |

## Future implementation test plan (T14.4 done-when)

Fake-adapter or synthetic ledger tests with injectable clock and planted `usage_observation` rows:

1. **`runs_per_day`:** With cap `N`, admit `N` runs on one UTC day, then refuse the next `delegate_task` for that scope;
   assert MCP error carries budget reason; assert `budget_refused` / `budget_flags_json`; assert
   `get_digest.budget.exhausted` and envelope `needs_attention.reason === "budget_exhausted"` for T14.2 wiring.
2. **`concurrent_runs`:** Hold `M` non-terminal runs, cap `M`, refuse another admission until one run terminals.
3. **`usage_per_window`:** Plant provider-reported usage summing above `max_reported_tokens` inside
   `window_seconds`; refuse admission; after observations fall outside the window (clock injection), admission succeeds
   and exhaustion clears.
4. **`wall_clock_per_run_seconds`:** Run exceeds cap from `LEASED` (injected clock); project refuses new admissions until
   cleared per implementation choice in §Admission check.
5. **Unset cap:** `get_digest` reports `limit: null` for that `caps[].key`; `doctor` / config dump does not invent a
   numeric default.
6. **Provider limit separation:** `get_capacity`, `switchboard capacity`, and budget refusal errors contain no wording
   implying provider TPM/RPM/subscription remainder; planted `rate_limit` events do not satisfy or bypass operator
   budgets.
7. **Global vs project override:** Project override stricter than global is enforced for that project; global exhaustion
   affects all projects when only global caps are set (**Proposed** cases recorded in test names).
8. **`continue_task` / successor:** Successor admission respects the same caps when it would create a new run row.

## Related ADRs (cross-link only)

- [ADR-0007](../adr/0007-capacity-as-confidence-estimate.md) — capacity is an estimate; ingress concurrency ≠ operator
  budget caps.
- [ADR-0043](../adr/0043-capacity-estimate-breaker-and-retry.md) — breaker and retry (M6); unrelated to FR-CTL-06 caps.
- [ADR-0048](../adr/0048-notification-sinks.md) — `budget_exhausted` sink kind (Proposed ADR).
