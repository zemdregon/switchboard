# Project pause and resume spike (T14.6), 2026-10-15

- Date: 2026-10-15
- Status: Research input (Delegated agent work, documentation only; not owner-approved). Normative contracts remain
  [LLD §3.4.4](../design/LLD.md#344-steer_run-pause-and-resume-fr-ctl-04-fr-ctl-05),
  [LLD §3.4.7](../design/LLD.md#347-pause-and-budget-persistence-proposed), [FR-CTL-05](../requirements/SRS.md),
  [FR-OPS-01](../requirements/SRS.md), [FR-SES-06](../requirements/SRS.md), and [SDD FR-CTL-05](../design/SDD.md#5-requirements-to-design-traceability).
- Used by: [ROADMAP](../ROADMAP.md) T14.6, T14.3 (`get_digest.paused`), T14.4 (shared `control_plane_state` table).
  Cross-links only to merged M14 spikes: [needs-attention derivation](needs-attention-derivation-spike-2026-10-15.md)
  (T14.2; pause is **not** a `needs_attention_reason`), [get_digest](get-digest-spike-2026-10-15.md) (T14.3;
  `paused` field assembly), [operator budget admission](operator-budget-admission-spike-2026-10-15.md) (T14.4;
  orthogonal `budget_flags_json`), [console tool profile](console-tool-profile-spike-2026-10-15.md) (T14.11; MCP
  `pause_project` / `resume_project` on `console` profile only).
- Scope: MCP per-project pause/resume semantics, operator global pause, admission hold vs in-flight runs, persistence
  sketch, digest and `needs_attention` mapping without new run states, `serve` daemon application of CLI pause, and a
  fake-adapter test plan. **No code.**

## Evidence labels

- **Verified (repo):** read in this repository on 2026-10-15.
- **Verified (spec):** requirement or LLD row cited by ID; accepted ADR decision text is cross-linked only, not restated.
- **Proposed:** error codes, event table shape, or ordering details not yet fixed by T14.6 tests.

## Primary sources

| ID | Source | Why it matters |
| --- | --- | --- |
| R1 | [LLD §3.4](../design/LLD.md#34-control-plane-m14-proposed-t140) | Control-plane gate; shared persistence |
| R2 | [LLD §3.4.4](../design/LLD.md#344-steer_run-pause-and-resume-fr-ctl-04-fr-ctl-05) | Tool schemas; admission before `QUEUED`; digest visibility |
| R3 | [LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02) | `projects[].paused` boolean |
| R4 | [LLD §3.4.5](../design/LLD.md#345-needs-attention-derivation-fr-ctl-03) | Closed five-reason list; pause excluded |
| R5 | [LLD §3.4.7](../design/LLD.md#347-pause-and-budget-persistence-proposed) | `control_plane_state` DDL |
| R6 | [FR-CTL-05](../requirements/SRS.md) | MCP tools + CLI global pause; admission hold; queued wait; running finish |
| R7 | [FR-OPS-01](../requirements/SRS.md) | Operator CLI surface; global pause is not an MCP tool |
| R8 | [FR-SES-06](../requirements/SRS.md) | One non-terminal run per meta-session unchanged by pause |
| R9 | [needs-attention spike §Pause](needs-attention-derivation-spike-2026-10-15.md#open-dependencies-and-task-boundaries) | `paused` on digest only (cross-link) |
| R10 | [LLD §18.4 step 4](../design/LLD.md#184-admission-through-the-creating-clients-ceiling-fr-que-01) | M15 queue items stay `READY` on retryable pause refusal |

## Two pause surfaces (caller scope vs operator global)

| Surface | Who | Scope | Mechanism (Verified — LLD) |
| --- | --- | --- | --- |
| **MCP** `pause_project` / `resume_project` | MCP client | Caller-visible **one project** | Per-project `paused` in [LLD §3.4.4](../design/LLD.md#344-steer_run-pause-and-resume-fr-ctl-04-fr-ctl-05) / [§3.4.7](../design/LLD.md#347-pause-and-budget-persistence-proposed) |
| **Operator CLI** `switchboard pause` / `switchboard resume` (names **Proposed**) | OS user on the host | **All projects** (global kill switch) | Global row `project_id = '*'` ([LLD §3.4.4](../design/LLD.md#344-steer_run-pause-and-resume-fr-ctl-04-fr-ctl-05)) |

**Not in MCP:** Global pause and resume are operator-only ([FR-CTL-05](../requirements/SRS.md),
[console tool-profile spike](console-tool-profile-spike-2026-10-15.md)). Orchestrator and console MCP clients may pause
**their** projects only; they cannot pause another client's project or the whole deployment.

### MCP tool semantics

**Input / output:** [LLD §3.4.4](../design/LLD.md#344-steer_run-pause-and-resume-fr-ctl-04-fr-ctl-05) — required
`project_id`; output `{ project_id, paused }` where `paused` is the flag stored for that project row (not global OR).

**Authorization:**

| Case | Result |
| --- | --- |
| `project_id` unknown to configuration | `INVALID_REQUEST` (same as `list_runs` / `get_run` project filter) |
| Project outside caller's `mcp_clients[].projects` (and not a dynamic project the caller created) | `PERMISSION_BLOCKED` |
| Valid pause or resume | Upsert `control_plane_state` for that `project_id`; return current `paused` boolean |

**Idempotency:** Repeated `pause_project` on an already paused project returns `paused: true` with no error. Repeated
`resume_project` on an unpaused project returns `paused: false`.

**Audit fields (Proposed):** `paused_by = mcp:<client_id>`, `paused_at` ISO-8601 on pause; clear or set `paused_by` on
resume per T14.6 implementation tests.

### Operator CLI global semantics

While global pause is active ([LLD §3.4.4](../design/LLD.md#344-steer_run-pause-and-resume-fr-ctl-04-fr-ctl-05)):

- **No project admits new runs** (same admission gate as per-project pause).
- **Running runs are not cancelled**; they run to a terminal FRD state (Succeeded, Failed, Cancelled, and so on).
- **Effect on `switchboard serve`:** The CLI does not rely on the operator editing SQLite directly. It appends an
  append-only **`operator_pause_requested`** (or paired resume) signal; the daemon applies it on its **operator poll**,
  the same pattern as `approve` ([LLD §3.1](../design/LLD.md#31-privileged-scope-m3), T14.0). T14.6 chooses one shape:
  `run_event` on a synthetic control record **or** a dedicated `control_plane_event` table (**Proposed**).

`paused_by` for the global row is the **OS username** of the operator invoking the CLI (**Proposed**), distinct from
`mcp:<client_id>` on per-project rows.

**FR-OPS-01 note:** Global `pause` / `resume` extend the operator CLI beyond today's enumerated subcommands; wording in
SRS FR-OPS-01 may gain a dated note when T14.6 implements — no requirement ID change in this spike.

## Effective pause at admission

**Effective admission block** for a resolved `project_id` at `delegate_task` / `continue_task` admission (and M15 queue
tick per [LLD §18.4](../design/LLD.md#184-admission-through-the-creating-clients-ceiling-fr-que-01)):

```text
admission_paused(project_id) :=
  row(project_id).paused = 1
  OR row('*').paused = 1
```

Missing `control_plane_state` rows mean **not paused** (fail-closed for *starting* the controller with bad config, not
for missing pause rows — align with [needs-attention spike §Fail-closed](needs-attention-derivation-spike-2026-10-15.md#fail-closed-defaults-proposed)).

**Check position:** After caller/project authorization and alongside budget caps
([operator budget spike §Admission check](operator-budget-admission-spike-2026-10-15.md#admission-check-comp-rte)),
**before** a new run reaches `QUEUED`
([LLD §3.4.4](../design/LLD.md#344-steer_run-pause-and-resume-fr-ctl-04-fr-ctl-05)).

### Admission hold vs running runs finishing

| Phase | While paused (project or global) | FRD run state |
| --- | --- | --- |
| **New admission** | Refused — no new `run` row | Unchanged for existing runs |
| **Internal / M15 queue** | Item stays **`READY`** when refusal is retryable (pause), per [LLD §18.4 step 4](../design/LLD.md#184-admission-through-the-creating-clients-ceiling-fr-que-01) | N/A |
| **Already `QUEUED` / `LEASED` / `RUNNING`** | Controller does **not** cancel; fake/real adapter runs to terminal | Normal transitions |
| **`continue_task` with active non-terminal run** | Still **`INVALID_REQUEST`** ([FR-SES-06](../requirements/SRS.md)) | Unchanged |
| **Successors after terminal** | Refused while paused (loop-breaker successors per [T14.5](../ROADMAP.md#613-m14-control-plane-tasks)) | N/A |

[FR-CTL-05](../requirements/SRS.md): *“A pause holds admission: queued runs wait and running runs finish.”* **Queued** here
means work not yet admitted (ingress queue, `READY` work items), not an FRD state named `QUEUED` waiting indefinitely inside
a paused project — once a run is admitted past the gate, it proceeds unless separately cancelled.

**MCP error (Proposed):** Fail closed with no new run, analogous to `QUEUE_FULL` retry semantics where applicable:
top-level code TBD in LLD §4; `details.reason` **`PROJECT_PAUSED`** or **`GLOBAL_PAUSED`** and `details.project_id` when
scoped. Distinct from `budget_exhausted` ([T14.4 spike](operator-budget-admission-spike-2026-10-15.md)).

**Ledger event (Proposed):** Bounded `project_event` or `run_event` type `pause_admission_refused` with `project_id` and
`scope: project|global` for digest delta scans — optional if `get_digest` reads `control_plane_state` directly on snapshot.

## Persistence (`control_plane_state`)

Verified DDL sketch ([LLD §3.4.7](../design/LLD.md#347-pause-and-budget-persistence-proposed)):

```sql
CREATE TABLE control_plane_state (
  project_id    TEXT PRIMARY KEY,       -- project id or '*' for global pause
  paused        INTEGER NOT NULL CHECK (paused IN (0,1)),
  paused_by     TEXT,                   -- mcp:<client_id> or OS user for CLI
  paused_at     TEXT,
  budget_flags_json TEXT CHECK (budget_flags_json IS NULL OR json_valid(budget_flags_json))
) STRICT;
```

| Row key | Written by | `paused` meaning |
| --- | --- | --- |
| `<project_id>` | MCP `pause_project` / `resume_project` | Per-project hold |
| `*` | Operator `switchboard pause` / `resume` | Global hold |

T14.4 owns readers/writers for `budget_flags_json` only; T14.6 owns `paused` columns. One migration may create the table
for both tasks ([operator budget spike §Persistence](operator-budget-admission-spike-2026-10-15.md#budget_exhausted-without-migration)).

LLD prose also names `control_plane.global_paused`
([§3.4.4](../design/LLD.md#344-steer_run-pause-and-resume-fr-ctl-04-fr-ctl-05)); the **normalized** store is the
`project_id = '*'` row above (**Proposed** — table is source of truth).

## Digest and `needs_attention` (no new run state)

Pause is **control-plane state**, not an FRD run state
([ROADMAP §6.13](../ROADMAP.md#613-m14-control-plane-tasks), T14.0). No `PAUSED` transition on `run.status`.

| Surface | Pause exposure | `needs_attention` |
| --- | --- | --- |
| `get_digest` | `projects[].paused` when `admission_paused` at read time ([LLD §3.4.3](../design/LLD.md#343-get_digest-fr-ctl-02), [get_digest spike](get-digest-spike-2026-10-15.md#budget-and-paused-depends-on-t144-t146)) | Five reasons only |
| `get_run` / `list_runs` | **Proposed:** pause on digest only, not per-run envelope | No sixth reason ([needs-attention spike](needs-attention-derivation-spike-2026-10-15.md#open-dependencies-and-task-boundaries)) |
| With `budget_exhausted` | Digest may show both `paused` and `budget.exhausted` | Budget reason unchanged by pause |

**Digest delta (Proposed):** Include updated `paused` when the scan sees a pause toggle or any `run_event` for that
project ([get_digest spike](get-digest-spike-2026-10-15.md#budget-and-paused-depends-on-t144-t146)). Full snapshot:
read `control_plane_state` for every visible `project_id`.

**Notification sinks (T14.9, cross-link only):** [notification sinks spike](notification-sinks-spike-2026-10-15.md) lists
`project_paused` / `global_paused` event kinds — delivery is optional and off the admission path.

## Interaction with FR-SES-06

Pause does not increase concurrency: a meta-session still has at most one non-terminal run. Pausing a project:

- Does **not** terminate the active run on that meta-session.
- Blocks **new** admissions that would create another run (including `continue_task` after terminal, until resume).
- Does **not** override `continue_task` rejection when a non-terminal run already exists.

## Fake-adapter test plan (T14.6 done-when)

Synthetic MCP clients, fake adapter, shared data directory; no live provider CLIs.

1. **Admission refused while paused:** `pause_project` for project P; `delegate_task` for P errors with no new `run`
   row; repeat under **global** pause (CLI or seeded `'*'` row) for P and project Q.
2. **Running runs complete:** Admit and start a run on P (fake adapter slow path or multi-step fixture); call
   `pause_project` (or global pause) while `RUNNING`; assert run reaches terminal `SUCCEEDED` or `FAILED` without
   pause-induced cancel; assert no second run starts until resume.
3. **Cross-client isolation:** Client A pauses P; Client B `pause_project` for P → `PERMISSION_BLOCKED` when P is outside
   B's scope; B's project R still admits when only P is paused (not global).
4. **Resume clears hold:** After `resume_project` (and global `resume`), the next `delegate_task` for P admits and
   reaches `QUEUED` / terminal on fakes as today.
5. **Digest:** `get_digest` shows `paused: true` for P while paused and `false` after resume; global pause sets `paused:
   true` on every visible project section (**Proposed** digest rule).
6. **`needs_attention` unchanged:** With only pause active (no budget, stall, approval, or loop-breaker facts), no run
   envelope gains a `needs_attention_reason` solely from pause; existing T14.2 five-reason tests remain unchanged.
7. **`serve` operator poll (when implemented):** Daemon running; CLI global pause writes operator signal; within one poll,
   admission refuses and digest reflects global pause — fakes only.

## Dependencies

| Task | Relationship |
| --- | --- |
| **T14.0** | Tool schemas and `serve` operator-poll pattern ([LLD §3.4.4](../design/LLD.md#344-steer_run-pause-and-resume-fr-ctl-04-fr-ctl-05)) |
| **T14.2** | Confirms pause is not a derivation reason — [spike](needs-attention-derivation-spike-2026-10-15.md) |
| **T14.3** | `paused` on digest — [spike](get-digest-spike-2026-10-15.md) |
| **T14.4** | Shared `control_plane_state`; budget orthogonal — [spike](operator-budget-admission-spike-2026-10-15.md) |
| **T14.11** | MCP pause tools on `console` profile only — [spike](console-tool-profile-spike-2026-10-15.md) |

## Related ADRs (cross-link only)

- [ADR-0002](../adr/0002-mcp-upstream-acp-downstream.md) — MCP vs operator CLI boundaries.
- [ADR-0007](../adr/0007-capacity-as-confidence-estimate.md) — pause is not a provider rate limit.

## Implementation sketch (documentation only)

1. Migration: `control_plane_state` per [LLD §3.4.7](../design/LLD.md#347-pause-and-budget-persistence-proposed).
2. COMP-RTE: evaluate `admission_paused` on delegate/continue admission path before `QUEUED`.
3. COMP-MCP: `pause_project` / `resume_project` with project scoping; COMP-OPS: global pause/resume + operator event.
4. COMP-LED: digest `projects[].paused` from table; no FRD states or persisted `needs_attention` for pause.
