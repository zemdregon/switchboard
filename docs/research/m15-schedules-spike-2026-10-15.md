# M15 schedules spike (T15.2), 2026-10-15

- Date: 2026-10-15
- Status: Research input (Delegated agent work, documentation only; not owner-approved). Normative schedule table,
  cron subset, fire behaviour and CLI names remain
  [LLD §18.5](../design/LLD.md#185-schedules-fr-que-02) and scheduler ordering in
  [LLD §18.7](../design/LLD.md#187-scheduler-integration-comp-rte) (T15.0). Queue admission for fired items follows
  [LLD §18.4](../design/LLD.md#184-admission-through-the-creating-clients-ceiling-fr-que-01) and the T15.1 plan.
- Used by: [ROADMAP](../ROADMAP.md) T15.2 (implementation plan). Cross-links
  [T15.0](../ROADMAP.md#614-m15-project-queue-schedules-and-ci-triggers-tasks) (design gate),
  [T15.1](../ROADMAP.md#614-m15-project-queue-schedules-and-ci-triggers-tasks)
  ([queue admission spike](m15-queue-admission-spike-2026-10-15.md)); does not restate LLD §18 bodies.
- Scope: Forward migration **0018** (`project_schedule`), ledger helpers, scheduler tick step 1 (schedule fire only),
  operator CLI `switchboard schedule list|disable` (and `approve` for widening), widening approval aligned with
  [discovery §8](../research/orchestration-layer-discovery-2026-10-15.md#8-risks-the-new-layer-introduces), injected-clock
  test matrix, hot-file sequencing vs migration **0017** / `src/ledger/repo.ts`. **No code.**

## Evidence labels

- **Verified (repo):** read in this repository on 2026-10-15.
- **Verified (spec):** requirement or LLD row cited by ID.
- **Proposed:** helper names, MCP create/enable surfaces, `PENDING_APPROVAL` column shape, or 0018 split vs T15.3 not
  fixed until implementation PRs land.

## Primary sources

| ID | Source | Why it matters |
| --- | --- | --- |
| R1 | [LLD §18.5](../design/LLD.md#185-schedules-fr-que-02) | `project_schedule` DDL, cron subset, fire and dedup |
| R2 | [LLD §18.7](../design/LLD.md#187-scheduler-integration-comp-rte) | Tick step 1 (schedules); T15.2 implements step 1 only |
| R3 | [LLD §18.2–18.4](../design/LLD.md#182-queue-work-item-record-fr-que-01) | Enqueued work items; `source_kind = 'schedule'` |
| R4 | [FR-QUE-02](../requirements/SRS.md#318-project-queue-and-triggers-fr-que) | Off by default; admit as FR-QUE-01; list and disable |
| R5 | [FR-OPS-01](../requirements/SRS.md#311-operator-cli-fr-ops) | Operator CLI plain text + `--json` pattern for new commands |
| R6 | [T15.1 spike](m15-queue-admission-spike-2026-10-15.md) | Migration **0017**, dequeue step 3, `repo.ts` queue slice |
| R7 | [Discovery §8](../research/orchestration-layer-discovery-2026-10-15.md#8-risks-the-new-layer-introduces) | Chat-created schedules that widen reach wait for operator approval |
| R8 | [ADR-0005](../adr/0005-sqlite-ledger.md) | Forward-only migrations |
| R9 | [ADR-0030](../adr/0030-dynamic-project-revisions-and-approval.md) | Widening dynamic projects; analogous gate for schedules |

## Dependency: T15.1 queue (0017)

**Verified (spec):** A schedule fire does not call `delegate_task` directly; it inserts one
`project_work_item` per due minute ([LLD §18.5](../design/LLD.md#185-schedules-fr-que-02)). Admission runs on the same
scheduler tick as step 3 ([LLD §18.7](../design/LLD.md#187-scheduler-integration-comp-rte)) once T15.1 lands.

**Verified (research):** [T15.1 spike](m15-queue-admission-spike-2026-10-15.md) locks migration **0017** for
`project_work_item` / `project_work_dependency`. T15.2 must not ship before **0017** is on `main`.

## Forward migration 0018 (outline)

**Verified (spec):** [LLD §18.5](../design/LLD.md#185-schedules-fr-que-02) assigns `project_schedule` to migration
**0018**. The same LLD section number also assigns CI tables to **0018** (T15.3). **Proposed sequencing:**

| Approach | When | Notes |
| --- | --- | --- |
| **A (preferred for T15.2 alone)** | T15.2 PR | `0018_project_schedule.ts` creates only `project_schedule`; T15.3 adds `0019` for CI tables and updates LLD in that PR if numbers diverge |
| **B (single 0018)** | Joint T15.2+T15.3 or T15.3 first | One migration file with schedule + CI DDL as in LLD; T15.2 code uses schedule half only |

Default implementation plan: **A** to keep T15.2 mergeable without T15.3; document any number change in the migration PR.

### Deliverables (implementation task)

| Step | Path / action | Notes |
| --- | --- | --- |
| 1 | `src/ledger/migrations/0018_project_schedule.ts` | Export `sql`; header cites FR-QUE-02, LLD §18.5, ADR-0005 |
| 2 | Append to `MIGRATIONS` in `src/ledger/migrations/index.ts` | `{ version: 18, name: "project_schedule", sql }` after **0017** |
| 3 | `src/ledger/ledger.test.ts` | Fresh DB at 18; upgrade from 17 with queue rows preserved |
| 4 | `Ledger` schedule helpers in `src/ledger/repo.ts` | See §Ledger helpers; **serial** with T15.1 queue helpers |

### SQL scope (cite LLD; do not duplicate full DDL here)

Migration **0018** creates the table defined in [LLD §18.5](../design/LLD.md#185-schedules-fr-que-02):

- `project_schedule` (`sch_*` ids, `enabled` default `0`, `cron_expr`, `template_json`, `last_fire_at`, timestamps)

**Proposed (T15.2, not in LLD SQL block):** widening approval state on the schedule row:

```sql
-- Proposed addition for discovery §8 / LLD widening paragraph; review in implementation PR
approval_state  TEXT NOT NULL DEFAULT 'APPROVED' CHECK (approval_state IN (
                  'PENDING_APPROVAL','APPROVED','REJECTED')),
```

- Chat clients that create a schedule whose `template_json.trust_profile` (or push/container widening analogous to
  FR-PRJ-10) exceeds the creator's current ceiling at create time → `approval_state = 'PENDING_APPROVAL'`,
  `enabled = 0` until `switchboard schedule approve` ([LLD §18.5 widening](../design/LLD.md#185-schedules-fr-que-02)).
- Operator-created or non-widening schedules → `APPROVED` immediately; `enabled` still defaults to `0` (FR-QUE-02 off by
  default).

If implementation prefers a separate `project_schedule_approval` table (mirror dynamic projects), that is **Proposed**
and needs an LLD patch in the same PR as code.

### Migration test matrix

| Case | Assertion |
| --- | --- |
| Fresh ledger | Version 18; `project_schedule` exists; `enabled` default 0; `CHECK (enabled IN (0,1))` |
| Upgrade from 17 | Existing `project_work_item` rows unchanged; 0018 additive only |
| Invalid cron at insert | Application rejects before SQL (create-time validation per LLD) |
| `sch_*` uniqueness | Primary key on `id` |

## Schedule record and storage

**Verified (spec):** Rows are ledger-persisted ([LLD §18.5](../design/LLD.md#185-schedules-fr-que-02)), same SQLite
database as the queue ([ADR-0005](../adr/0005-sqlite-ledger.md)).

| Field | Role |
| --- | --- |
| `creator_client_id` | Copied into each fired `project_work_item.creator_client_id`; admission ceiling is this client at admission time (§18.4) |
| `cron_expr` | Five-field UTC expression; validated at create |
| `enabled` | `0` until operator or approved client explicitly enables (**off by default**) |
| `template_json` | Frozen `delegate_task` template; `{{schedule_fire_at}}` substituted at fire |
| `last_fire_at` | ISO-8601 minute anchor; updated in the same transaction as enqueue for dedup |
| `disabled_at` | Set when operator runs `schedule disable` |

**Proposed id for work items from schedules:** Optional deterministic `idempotency_key` on enqueue such as
`schedule:{sch_id}:{minute_bucket}` so a crash mid-transaction cannot create two rows for the same minute even if
`last_fire_at` reconciliation lags (**Proposed**; must align with partial unique index on
`(creator_client_id, idempotency_key)` from **0017**).

## Cron syntax and timezone (**Proposed** where noted)

**Verified (spec):** [LLD §18.5](../design/LLD.md#185-schedules-fr-que-02) — five fields, **UTC only**, Vixie subset:
minute, hour, day-of-month, month, weekday; `*` `,` `-` `/`; no `@yearly` or named months; invalid → `INVALID_REQUEST`
at create.

**Proposed (implementation detail):**

| Topic | Decision |
| --- | --- |
| Tick granularity | Match on **current UTC minute** (truncate seconds); scheduler tick at least once per minute in production |
| Daylight saving | N/A (UTC storage avoids local DST) |
| Parser | Shared pure function `cronMatches(expr, utcDate)`; property tests on edge weekdays `0` vs `7` |
| Leap seconds | Ignore; use system UTC wall clock from injected port in tests |
| Enable after missed minutes | **Proposed:** no backfill; only the current minute is considered on each tick (LLD wording: "matches the current minute") |

Operator-facing docs should state that all schedules are UTC and show the next fire time in UTC in `schedule list --json`.

## Off-by-default enablement

**Verified (spec):** [FR-QUE-02](../requirements/SRS.md#318-project-queue-and-triggers-fr-que);
`enabled INTEGER DEFAULT 0`.

| Stage | `enabled` | Fires? |
| --- | --- | --- |
| Row inserted (MCP or CLI create) | `0` | No |
| `PENDING_APPROVAL` widening | `0` | No |
| After `schedule approve` | `0` until explicit enable | No |
| Operator `schedule enable` (**Proposed** MCP/CLI) | `1` | Yes on matching minutes |
| After `schedule disable` | `0`; `disabled_at` set | No future fires |

**Proposed surfaces:** LLD names `list|disable|approve` for operator CLI. Enabling is required by FR-QUE-02 semantics
("off by default") but not spelled as a subcommand in LLD — add **`switchboard schedule enable <sch_id>`** or document
that create accepts `enabled: true` only for operator identity (**Proposed**; prefer explicit `enable` subcommand for
auditability).

## Fire path: enqueue under creator ceiling

```mermaid
sequenceDiagram
  participant Tick as Scheduler tick (step 1)
  participant LED as COMP-LED
  participant Q as project_work_item (0017)

  Tick->>LED: list enabled schedules due this UTC minute
  LED->>LED: BEGIN IMMEDIATE; check last_fire_at != this minute
  LED->>Q: INSERT work item (source_kind schedule, source_id sch_*)
  LED->>LED: UPDATE project_schedule.last_fire_at
  Note over Q: T15.1 dequeue (step 3) may admit same tick
  LED->>LED: COMMIT
```

**Verified (spec):** Enqueued items use `source_kind = 'schedule'` and `source_id = sch_*`
([LLD §18.5](../design/LLD.md#185-schedules-fr-que-02)). Dequeue uses `creator_client_id` from the schedule row
([LLD §18.4](../design/LLD.md#184-admission-through-the-creating-clients-ceiling-fr-que-01)) — the schedule does not
widen the ceiling beyond the creating client.

| Rule | Test hook |
| --- | --- |
| Template trust profile above creator ceiling at fire | `FAILED_ADMISSION` on dequeue (same as queue items) |
| Creator ceiling lowered after enable | Next dequeue → `FAILED_ADMISSION`; schedule keeps firing new items unless operator disables (**Proposed:** optional `doctor` warning) |
| Dynamic project unapproved widening | Item stays `READY`; no admission per ADR-0030 |
| `QUEUE_FULL` | Work item stays `READY`; no duplicate fire same minute (`last_fire_at` already set) |

## Widening schedules from chat clients

**Verified (research):** [Discovery §8](../research/orchestration-layer-discovery-2026-10-15.md#8-risks-the-new-layer-introduces)
— schedules created by a chat client that widen what the client could do in one call wait for operator approval, as
FR-PRJ-10 does for projects.

**Verified (spec):** [LLD §18.5 widening](../design/LLD.md#185-schedules-fr-que-02) — `PENDING_APPROVAL` until
`switchboard schedule approve`.

**Proposed create path:** MCP tool `create_schedule` (and optional `update_schedule`) scoped like `enqueue_work`:
creator client only; operator CLI `switchboard schedule create` for break-glass (**Proposed** names). Widening detector
reuses §11.2 `effectiveMaxProfile` comparison against `template_json.trust_profile` and FR-PRJ-10 push/container rules
when the template references push-enabled policies.

| `approval_state` | `enabled` | Scheduler step 1 |
| --- | --- | --- |
| `PENDING_APPROVAL` | `0` | Skip row |
| `APPROVED` | `0` | Skip until enable |
| `APPROVED` | `1` | Normal fire logic |
| `REJECTED` | `0` | Skip; operator may delete (**Proposed** `schedule delete`) |

## Operator CLI (FR-OPS-01)

**Verified (spec):** [LLD §18.5](../design/LLD.md#185-schedules-fr-que-02) — `switchboard schedule list|disable <sch_id>`;
`disable` sets `enabled = 0` and `disabled_at`; `switchboard schedule approve` for widening.

**Proposed** command table (match existing `runs` / `projects` UX: plain text default, `--json`):

| Command | Purpose |
| --- | --- |
| `schedule list` | All schedules (operator); filter `--project <id>` |
| `schedule show <sch_id>` | One row + next fire UTC (**Proposed** computed field) |
| `schedule disable <sch_id>` | Stop future fires |
| `schedule enable <sch_id>` | Set `enabled = 1` when `APPROVED` |
| `schedule approve <sch_id>` | `PENDING_APPROVAL` → `APPROVED` |
| `schedule deny <sch_id>` | **Proposed** `REJECTED`; mirror `projects` deny wording |

Wire in `src/cli/commands/` following patterns from `runs` and `projects`; register in CLI router (**Proposed** paths).

## Scheduler integration (T15.2 slice)

**Verified (spec):** [LLD §18.7](../design/LLD.md#187-scheduler-integration-comp-rte) step 1 only for T15.2.

**Proposed wiring** (extends [T15.1 spike §Scheduler](m15-queue-admission-spike-2026-10-15.md#scheduler-integration-t151-slice)):

1. Extract or extend `schedulerTick({ nowUtc, ledger, config })` invoked from `serve`.
2. Step 1: `fireDueSchedules(nowUtc)` before CI poll (T15.3) and before `claimReadyWorkItem` (T15.1).
3. Inject `nowUtc` from a `ClockPort` in tests; production uses real UTC.

Respect project pause: **Proposed** skip fire for schedules whose `project_id` is paused (consistent with dequeue holding
on pause).

## Injected-clock test matrix

Use fake adapters and `ClockPort` only; no provider CLIs in CI ([AGENTS.md](../../AGENTS.md) live-test policy).

| # | Scenario | Clock / setup | Action | Expected |
| --- | --- | --- | --- | --- |
| S1 | Inert until enabled | Create schedule `*/1 * * * *`, `enabled=0` | Advance 3 minutes, tick | No `project_work_item` rows |
| S2 | Enable then fire once | Enable at minute T | Tick at T | Exactly one item; `source_kind=schedule`; `last_fire_at` = T |
| S3 | Same minute dedup | S2 state | Second tick same minute | No second item |
| S4 | Restart same minute | S2 state; kill after commit | Restart; tick same minute | No duplicate item (`last_fire_at` persisted) |
| S5 | Crash before commit | Force crash after INSERT item, before `last_fire_at` update (**Proposed** test hook) | Restart; tick | At most one item (idempotency key or reconciliation resets `last_fire_at` from queued item — **Proposed** reconcile job) |
| S6 | `disable` stops future | Enabled schedule | `schedule disable`; advance to next due minute | No new items; prior items unaffected |
| S7 | `{{schedule_fire_at}}` | Template objective contains token | Fire | `request_json.objective` contains substituted ISO timestamp |
| S8 | Invalid cron | — | `create_schedule` with bad expr | `INVALID_REQUEST`; no row |
| S9 | Widening chat schedule | Chat client; `privileged` template above ceiling | Create | `PENDING_APPROVAL`, `enabled=0`; no fire after enable attempt without approve |
| S10 | Approve widening | S9 | `schedule approve` then `enable`; tick due | One item; admission uses chat `creator_client_id` |
| S11 | Admission ceiling | Enabled; template within ceiling | Fire + dequeue same tick | One `run` under creator ceiling (T15.1 fake path) |
| S12 | UTC boundary | Expr `0 0 * * *` | Inject 23:59 → 00:00 UTC | Fires only on 00:00 minute |

**Test files (Proposed):** `src/ledger/ledger.test.ts` (0018); `src/schedule/schedule-fire.test.ts` or extend queue
scheduler tests; `src/cli/schedule.test.ts` for list/disable/approve.

## Implementation order and hot files

**Task order:** T15.0 (Done) → T15.1 (**0017** + dequeue) → **T15.2** (**0018** + tick step 1) → T15.3 (CI).

**Hot files (one serial editor per file among concurrent PRs):**

| Hot file | T15.2 touch | Serial with |
| --- | --- | --- |
| `src/ledger/migrations/0018_*.ts`, `migrations/index.ts` | Schedule DDL | Must follow **0017**; coordinate with T15.3 if using single 0018 |
| `src/ledger/repo.ts` | Schedule CRUD, `fireDueSchedules` transaction | **T15.1 queue slice** — rebase queue PR first or land T15.2 after T15.1 merges |
| `src/cli/serve.ts` | Call tick step 1 | T15.1 step 3, T14 pause ticks |
| `src/lifecycle/` or `src/queue/scheduler.ts` | **Proposed** shared `schedulerTick` | T15.1/T15.3 same module |
| `src/cli/commands/schedule*.ts` | list, disable, enable, approve | Low contention |
| `src/mcp/server.ts` | **Proposed** `create_schedule` | After T15.1 MCP patterns |

**Do not edit (parallel worker lanes, 2026-10-15):** `src/adapters/**`, `src/inner/**`, `test/**` owned by other slots;
T15.2 tests live in `src/**/*.test.ts` beside modules.

**Recommended waves (Proposed):**

1. Migration 0018 + repo schedule helpers + ledger tests.
2. `fireDueSchedules` + injected-clock S1–S6.
3. CLI list/disable/approve/enable.
4. MCP create (+ widening) and S9–S11 with T15.1 dequeue enabled.

## CI and done-when checklist (T15.2 code task)

- [ ] `0018` on fresh and v17 ledgers
- [ ] Injected-clock matrix S1–S6 minimum; S4 restart dedup required by ROADMAP
- [ ] `disable` stops future admissions (S6)
- [ ] Widening approval S9–S10 (**Proposed** if MCP create in same PR)
- [ ] `node scripts/check-docs.mjs` if LLD/ROADMAP/TDD updated
- [ ] Full `npm test`; no real provider or `gh` in CI

## Open items for Linus / implementation PR

- Migration **0018** schedule-only vs combined with T15.3 CI tables (see §Forward migration 0018).
- Whether `schedule enable` is CLI-only or also MCP (**Proposed** both).
- Reconciliation after crash S5: idempotency key vs scanning `project_work_item` for open schedule-sourced rows.
- Exact `PENDING_APPROVAL` column vs side table (§SQL scope).
