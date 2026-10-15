# M14 acceptance test plan spike (T14.13), 2026-10-15

- Date: 2026-10-15
- Status: Research input (Delegated agent work, documentation only; not owner-approved). This note is an
  **implementation-ready test plan** for the future T14.13 code task; it is not the acceptance test itself.
- Used by: [ROADMAP](../ROADMAP.md) T14.13, M14 row acceptance criteria ([§6](../ROADMAP.md#6-milestones)),
  NFR-MAINT-02, NFR-MAINT-03.
- Normative contracts: [LLD §3.4](../design/LLD.md#34-control-plane-m14-proposed-t140), [SRS §3.17](../requirements/SRS.md#317-control-plane-fr-ctl)
  (FR-CTL-01–11), [PRD CAP-15](../requirements/PRD.md#3-capabilities). Cross-links merged M14 spikes only (no body
  duplication): [needs-attention](needs-attention-derivation-spike-2026-10-15.md) (T14.2),
  [get_digest](get-digest-spike-2026-10-15.md) (T14.3), [operator budget admission](operator-budget-admission-spike-2026-10-15.md)
  (T14.4), [loop breaker / stall / successor cap](loop-breaker-stall-successor-cap-spike-2026-10-15.md) (T14.5),
  [project pause/resume](project-pause-resume-spike-2026-10-15.md) (T14.6),
  [adapter steer-input](adapter-steer-input-spike-2026-10-15.md) (T14.7),
  [approval proxy](approval-proxy-spike-2026-10-15.md) (T14.8),
  [notification sinks](notification-sinks-spike-2026-10-15.md) (T14.9),
  [consent-page approval link](consent-page-approval-link-spike-2026-10-15.md) (T14.10),
  [console tool profile](console-tool-profile-spike-2026-10-15.md) (T14.11),
  [MCP 2026-07-28 readiness](mcp-2026-07-28-readiness-spike-2026-10-15.md) (T14.12, out of acceptance scope).
- Scope: Map each M14 acceptance clause to fake-adapter MCP scenarios (harness shape, tools, ledger assertions),
  define implementation order vs hot files, list README outline and documentation-correction workflow. **No code.**

## Evidence labels

- **Verified (repo):** read in this repository on 2026-10-15.
- **Verified (spec):** requirement or LLD row cited by ID.
- **Proposed:** file names, helper layout, or fixture choreography not fixed until T14.13 implementation lands.

## M14 acceptance criteria (owner of truth: ROADMAP §6 M14 row)

The milestone row names seven observable outcomes. The table below is the T14.13 test plan index; each §Scenario
expands one row.

| # | M14 row clause (paraphrase) | Primary FR / task | Scenario id |
| --- | --- | --- | --- |
| A | Scripted MCP client: digest across **two projects** with needs-attention reasons, pending approvals, finished runs, cursor | FR-CTL-02, FR-CTL-03, T14.3 | [§A](#scenario-a-digest-two-projects-and-cursor) |
| B | Same failure **N** times parks meta-session and flags | FR-CTL-07, T14.5 | [§B](#scenario-b-loop-breaker-park-and-flag) |
| C | Budget cap refuses admission with needs-attention reason | FR-CTL-06, T14.4 | [§C](#scenario-c-budget-cap-refusal) |
| D | Pause holds admission; running runs finish | FR-CTL-05, T14.6 | [§D](#scenario-d-pause-holds-admission) |
| E | `steer_run` on fake adapter: same native session with note | FR-CTL-04, T14.7 | [§E](#scenario-e-steer-same-native-session) |
| F | `approval_proxy` decides only with matching digest; other clients see no approval tools | FR-CTL-08, T14.8 | [§F](#scenario-f-approval-proxy-and-negative-list) |
| G | Notification sink: metadata-only; never planted secret or agent text | FR-CTL-10, T14.9 | [§G](#scenario-g-sink-closed-payload) |

Secondary coverage (not separate milestone clauses but required by T14.13 done-when): `list_runs` / `get_run`
envelope parity (T14.1), `console` `tool_profile` (T14.11), consent link (T14.10) as an optional sub-suite or follow-on
file so the main acceptance file stays bounded.

## Shared harness (Proposed)

Follow the established pattern in `src/mcp/m6-acceptance.test.ts` and `src/mcp/m7-acceptance.test.ts` (**Verified
repo**):

| Piece | Role in M14 acceptance |
| --- | --- |
| `FakeAdapter` + scripted provider CLI | No real provider binary; scenarios inject failures, silence, session ids |
| `createSwitchboardServer` + SDK `InMemoryTransport` | Same path as production MCP tool dispatch |
| Temporary Git repo + `WorkspaceManager` | Real worktrees for `delegate_task` / steer boundaries |
| `openLedger` / SQL assertions | Post-conditions on `run`, `run_event`, `approval`, `control_plane_state`, `meta_session` |
| Optional `test/malicious/controller.test.ts` extensions | Digest mismatch, agent text in tool descriptions (T14.8) |
| Local HTTP capture server (Node `http.createServer`) | Sink capture (T14.9); never log sink URL or token |

**Proposed primary file:** `src/mcp/m14-acceptance.test.ts` (single describe per scenario A–G, shared `beforeEach`
fixture builder). **Proposed malicious legs:** `test/malicious/m14-approval-proxy.test.ts` or new cases in
`test/malicious/controller.test.ts` (match T14.8 done-when). **Proposed sink leg:** helper under
`src/mcp/fixtures/sink-capture.ts` (or inline in acceptance file if under ~80 lines).

Config fixture: two projects `proj-a` / `proj-b` on one orchestrator client; second MCP client for scoping negatives;
third client with `approval_proxy: true` and `tool_profile: console` for F/G; `notification_sinks[]` pointing at loopback
only in sink scenarios.

Injected clock: required for T14.5 stall (**T** minutes) and budget windows (T14.4); wire through lifecycle test hooks
as in loop-breaker spike (cross-link only).

## Scenario A: digest two projects and cursor

**Maps:** M14 row clause A; FR-CTL-02, FR-CTL-03; T14.1, T14.2, T14.3, T14.8 (pending list shape).

| Step | Action | MCP tools | Ledger / read assertions |
| --- | --- | --- | --- |
| 1 | Plant `proj-a`: one run `SUCCEEDED`, one `FAILED`, one non-terminal with `awaiting_approval` (privileged pending), one with derived `stalled` or `budget_exhausted` per T14.2 rules | `delegate_task`, `get_run` (setup) | `run_event` rows for transitions; `approval` row `PENDING` where needed |
| 2 | Plant `proj-b`: at least one finished run; ensure client may see both projects | same | `run.client_id` and project membership |
| 3 | `get_digest` with no cursor | `get_digest` | Response `projects[]` has **both** ids; sections include `needs_attention`, `finished`, `pending_approvals`, `budget`; `cursor` is `evt_*` |
| 4 | Append a new `run_event` (e.g. complete a run) | (lifecycle) | New `evt_*` id |
| 5 | `get_digest` with previous `cursor` | `get_digest` | Delta only; repeated call same cursor ⇒ identical body ([get_digest spike](get-digest-spike-2026-10-15.md)) |
| 6 | Plant agent-written text in a run summary field | `get_digest`, `get_run` | `untrusted_summaries` or labelled `untrusted_text`; length cap; no raw secret string in JSON |

**File areas (implementation):** `src/mcp/server.ts` (`get_digest`, `list_runs`, `get_run` envelopes),
`src/ledger/repo.ts` (digest scan over `run_event`), derivation module (T14.2; likely `src/lifecycle/` or
`src/control-plane/` per implementation choice).

**Negative:** Client B must not see client A's exclusive dynamic project in digest (`PERMISSION_BLOCKED` or omission per
LLD scoping).

## Scenario B: loop breaker park and flag

**Maps:** M14 row clause B; FR-CTL-07; T14.5.

| Step | Action | MCP tools | Ledger assertions |
| --- | --- | --- | --- |
| 1 | Set `control_plane.loop_breaker.identical_failure_threshold` to **N** (use LLD default from T14.0 Assumption or config pin in test) | config load | — |
| 2 | Start meta-session; fake adapter returns same failure classification **N** times (successor runs or retries per FR-CAP-05 / FR-MCP-10) | `delegate_task`, poll `get_run` | `meta_session` or flag `parked_loop`; no further successor admitted |
| 3 | Read run | `get_run`, `list_runs`, `get_digest` | `needs_attention: true`, `reason: parked_loop` on newest run ([T14.2 spike](needs-attention-derivation-spike-2026-10-15.md)) |
| 4 | Attempt another delegate in same meta-session | `delegate_task` | Admission refused with closed reason; no new `run` row |

**File areas:** `src/ledger/repo.ts` (loop-breaker counters, parking), lifecycle admission (`src/lifecycle/`), fake
scenario hooks in `src/adapters/fake/`.

## Scenario C: budget cap refusal

**Maps:** M14 row clause C; FR-CTL-06; T14.4.

| Step | Action | MCP tools | Ledger assertions |
| --- | --- | --- | --- |
| 1 | Set one dimension at limit (e.g. `concurrent_runs: 1` with one active run, or `runs_per_day`) | config | `control_plane_state` / budget counters per [LLD §3.4.6–3.4.7](../design/LLD.md#346-budgets-and-loop-breaker-fr-ctl-06-fr-ctl-07) |
| 2 | Admit second run | `delegate_task` | Refused before adapter spawn; project flagged `budget_exhausted` on digest and envelope |
| 3 | `get_digest` / `get_run` | read tools | `needs_attention` with `budget_exhausted`; cap values never labelled as provider limits (string scan / schema) |

**File areas:** `src/ledger/repo.ts` (budget check at admission), `src/mcp/server.ts` (refusal mapping to MCP error).

## Scenario D: pause holds admission

**Maps:** M14 row clause D; FR-CTL-05; T14.6.

| Step | Action | MCP tools | Ledger assertions |
| --- | --- | --- | --- |
| 1 | Start long-running fake run on `proj-a` | `delegate_task` | `RUNNING` or `LEASED` |
| 2 | `pause_project` for `proj-a` | `pause_project` | Pause flag in §3.4.7 persistence; digest `paused: true` |
| 3 | New delegate on `proj-a` | `delegate_task` | Held (not started); no new active run |
| 4 | Wait for first run to complete (fake completes) | poll `get_run` | Terminal state without cancel-from-pause |
| 5 | `resume_project` | `resume_project` | Admission works again |

**File areas:** `src/ledger/repo.ts` (pause flags), `src/mcp/server.ts` (pause tools), lifecycle admission gate.

**Optional leg:** operator CLI global pause (`switchboard pause` / `resume` names Proposed in LLD) — separate test in
`src/cli/` or folded into acceptance with CLI `main()` invocation as in other acceptance tests.

## Scenario E: steer same native session

**Maps:** M14 row clause E; FR-CTL-04; T14.7.

| Step | Action | MCP tools | Ledger assertions |
| --- | --- | --- | --- |
| 1 | Start fake run that exposes stable `session_id` across resume | `delegate_task` | `session_bound` event with native id |
| 2 | While non-terminal, `steer_run(run_id, note)` | `steer_run` | `run_event` type `steer_requested` (LLD §3.4.4); note not in sink payload |
| 3 | Complete run | poll | Same native session id in subsequent spawn args (fake records argv); **no** new meta-session for steer |
| 4 | Negative | `steer_run` on another client's run | `PERMISSION_BLOCKED` |

**File areas:** `src/mcp/server.ts` (`steer_run`), `src/lifecycle/` (boundary resume), `src/adapters/fake/` (record
resume argv). Mode: boundary-resume for fake (`liveInput: false` per [steer spike](adapter-steer-input-spike-2026-10-15.md)).

## Scenario F: approval proxy and negative list

**Maps:** M14 row clause F; FR-CTL-08; T14.8.

| Step | Action | MCP tools | Ledger assertions |
| --- | --- | --- | --- |
| 1 | Orchestrator client requests `privileged` run → pending approval | `delegate_task` | `approval` `PENDING`; digest computable |
| 2 | Client **without** `approval_proxy`: `tools/list` | MCP list | No `list_pending_approvals` / `decide_approval` |
| 3 | Proxy client: `list_pending_approvals` | list tool | Closed fields only; `approval_digest` present |
| 4 | `decide_approval` wrong digest | `decide_approval` | Refusal; approval row unchanged; no `decided_via` |
| 5 | `decide_approval` correct digest | `decide_approval` | `APPROVED` or `DENIED`; `decided_via: mcp_proxy`; `approval_decided` event |
| 6 | Malicious fixture | decide/list | No agent prompt in tool `description` fields ([T14.8 done-when](../ROADMAP.md#613-m14-control-plane-tasks)) |

**File areas:** `src/mcp/server.ts` (tool registration, decide path), `src/ledger/repo.ts` (`decided_via`, approval row),
`test/malicious/`.

## Scenario G: sink closed payload

**Maps:** M14 row clause G; FR-CTL-10; T14.9 (and announcement from F step 5).

| Step | Action | MCP tools | Ledger assertions |
| --- | --- | --- | --- |
| 1 | Configure one `webhook` sink to loopback capture URL; optional second `ntfy` kind with mock server | config only | No sink URL in ledger |
| 2 | Trigger event (e.g. run terminal, `needs_attention`, or proxied approval) | lifecycle + F | Async delivery off run path |
| 3 | Inspect capture bodies | — | Only `notification_payload` fields; scan for planted `CANARY_SECRET_*` and agent transcript markers |
| 4 | Sink timeout / 500 | fault inject | Run still `SUCCEEDED`; no delay beyond bound |
| 5 | Unconfigured sinks | default config | Zero HTTP requests |

**File areas:** new sink dispatcher module (T14.9 implementation path), **not** on hot `server.ts` list except tool
side-effects; config in `src/config/`.

## Tool and file matrix (summary)

| MCP tool / surface | Tasks | Primary code areas (future) | Acceptance scenario |
| --- | --- | --- | --- |
| `get_digest` | T14.3 | `src/mcp/server.ts`, ledger digest scan | A |
| `list_runs`, `get_run` | T14.1, T14.2 | `src/mcp/server.ts`, derivation | A (support), B–D read paths |
| `delegate_task` (+ poll) | M2 base | lifecycle, adapters | All |
| `pause_project`, `resume_project` | T14.6 | `src/mcp/server.ts`, `src/ledger/repo.ts` | D |
| `steer_run` | T14.7 | `src/mcp/server.ts`, lifecycle, adapters | E |
| `list_pending_approvals`, `decide_approval` | T14.8 | `src/mcp/server.ts`, `src/ledger/repo.ts` | F, G |
| `tools/list` profiles | T14.11 | `src/mcp/server.ts` | F negative, console smoke |
| Notification delivery | T14.9 | sink worker (new) | G |
| Consent approval link | T14.10 | M13 HTTP / consent | Optional sub-suite |

## Implementation order vs hot files

**ROADMAP order (Verified):** T14.0 → T14.1 & T14.2 → T14.3–T14.6 (after T14.2) → T14.7 (after T14.1) → T14.9 (after
T14.0) → T14.8 (after T14.1, T14.9) → T14.10 (after T14.8) → T14.11 (after T14.1, T14.3, T14.7) → **T14.13 last**.

**Hot files (one serial editor per file among concurrent PRs):**

| Hot file | Tasks touching it | T14.13 code must wait until |
| --- | --- | --- |
| `src/mcp/server.ts` | T14.1, T14.3, T14.8, T14.11 | T14.11 merged (all MCP tools and profiles registered) |
| `src/ledger/repo.ts` | T14.4, T14.6, T14.8 | T14.8 merged (budget, pause, `decided_via` persistence) |

**Recommended acceptance implementation waves (Proposed):**

1. After T14.3 lands: scenario A (digest-only) in a thin `m14-acceptance.test.ts`.
2. After T14.4–T14.6: add C, D; extend A budget/pause sections.
3. After T14.5: add B (clock injection).
4. After T14.7: add E.
5. After T14.8–T14.9: add F, G (+ malicious/sink files).
6. After T14.10–T14.11: README + optional consent/console legs; mark T14.13 Done in ROADMAP.

T14.12 does not block acceptance (transport readiness is orthogonal).

**Lane coordination:** While slots own adapter or `inner` paths, acceptance work stays in `src/mcp/m14-acceptance.test.ts`,
`test/malicious/`, and sink fixtures only — no edits to `src/adapters/**` except extending fake scenario hooks if a
steer/session assertion requires it (coordinate with adapter lane).

## README section outline (T14.13 deliverable, not written in this spike)

Add a **Control plane (milestone 14)** section to [README.md](../../README.md) (**Proposed** structure, NFR-MAINT-03):

1. **Purpose** — one chat/orchestrator client can poll `get_digest`, list runs, steer, pause; approval proxy and sinks
   are operator-configured.
2. **Configuration** — pointer to `mcp_clients[]` (`tool_profile`, `approval_proxy`, `approval_proxy_targets`),
   `control_plane.budgets`, `control_plane.loop_breaker`, `notification_sinks[]`, pause flags; link to TDD §3.1 and
   LLD §3.4 (no duplicate schema).
3. **MCP tools** — table: orchestrator vs `console` profile; approval tools only when `approval_proxy`; closed payloads
   (no transcripts).
4. **Operator commands** — global pause/resume CLI; budgets and loop-breaker knobs; sinks off by default.
5. **`doctor`** — new checks for sink URL reachability (optional), budget config validity, ADR-0047/0048 flags if still
   Proposed.
6. **Status** — bullet linking `src/mcp/m14-acceptance.test.ts` and malicious/sink tests; explicit "fixtures only, no
   live provider" statement.
7. **Known limitations** — consent link browser flow; Grok bot as first console client (owner decisions 53/55); ADR
   acceptance pending.

Update the README **Status** milestone list to include M14 `Partial` with the same evidence links as §6.

## Documentation corrections workflow (NFR-MAINT-02, NFR-MAINT-03)

When T14.13 **implementation** proves spec or design text wrong:

| Step | Action | Owner doc |
| --- | --- | --- |
| 1 | Fix code and tests first | `src/`, `test/` |
| 2 | Update the **owning** spec (SRS for FR-CTL, LLD §3.4 for tool shapes) in the same PR if the contract changes | SRS, LLD |
| 3 | If trust boundary or egress changes, add/supersede ADR (0047/0048 acceptance may move from Proposed) | `docs/adr/` |
| 4 | Update ROADMAP §6 M14 row and T14.13 row with status + evidence links | ROADMAP only for this spike's constraint on FRD/SDD/HLD/TDD **bodies** — T14.13 may **cite** corrections needed in the PR description and ROADMAP without editing FRD/SDD/HLD/TDD until a dedicated docs task says so |
| 5 | Run `node scripts/check-docs.mjs` and markdownlint on touched `docs/**` | CI |
| 6 | README section (outline above) in the same PR as the acceptance test | README |

**This spike (documentation only):** edits **ROADMAP** T14.13 (+ cross-links). Do not edit FRD, SDD, HLD, or TDD bodies
for T14.13 plan land; implementation PRs follow the table above.

## CI and done-when checklist (T14.13 code task)

- [ ] `npm test` includes `m14-acceptance` and new malicious/sink legs; no provider CLI on PATH required.
- [ ] Each scenario A–G maps to a named `it(...)` or describe block cited from ROADMAP §6 M14 row.
- [ ] `node scripts/check-docs.mjs` passes after README + ROADMAP update.
- [ ] Secret scan tests unchanged or extended for sink logs (no URL/token leakage).
- [ ] ADR-0047 and ADR-0048 **Accepted** before claiming M14 `Done` (ROADMAP Blocks Done — owner acceptance).

## Open items (leave for Linus / zemdregon)

- ADR-0047 and ADR-0048 remain Proposed; acceptance test may land on fakes before ADR Accepted, but M14 row stays
  `Partial` until owner accepts ADRs (ROADMAP §6.13 Blocks Done).
- Exact injected-clock hook surface for stall timing (implementation choice; see T14.5 spike).
- Whether T14.10 consent link is in the same file as A–G or a follow-up test file.
