# Switchboard Roadmap

| Field | Value |
| --- | --- |
| Status | **Canonical.** Single source of truth for scope, priorities, dependencies, sequencing, status and completion criteria. |
| Does not own | Requirements ([SRS](requirements/SRS.md)), behaviour ([FRD](requirements/FRD.md)), design ([HLD](design/HLD.md), [SDD](design/SDD.md), [TDD](design/TDD.md), [LLD](design/LLD.md)), decision rationale ([ADRs](adr/README.md)). |
| Last reconciled | 2026-10-12 |
| Current milestone | M0 and M1 complete (M1 requirement gaps marked `Partial` in §6.1); **next: M2** |

## 1. How to use this roadmap

Read this first, then the documents it links for the milestone you are working on. Update the status column in §6 in the
same change that completes or blocks work, citing evidence (a test, a file path, a PR). Do not mark anything done
without evidence. Agent working rules are in [AGENTS.md](../AGENTS.md).

## 2. Product summary

**Purpose.** Switchboard is a local, headless controller that lets one primary AI orchestrator delegate coding tasks to
the operator's existing AI coding subscriptions (Claude Code, Codex, Grok Build, Antigravity, Cursor CLI, OpenCode, Kimi
Code) through each vendor's documented automation surface, behind one small MCP tool interface. It owns policy,
workspace isolation, cross-provider task state, routing and capacity estimation, so the orchestrator does not have to.

**Users.** The *operator* (the account owner who installs Switchboard and logs in to each CLI; zemdregon first; Switchboard
is published as open source so anyone can run their own installation with their own subscriptions) and the
*orchestrator* (an MCP client agent such as OpenClaw or Grok Bot). See [PRD §2](requirements/PRD.md).

**Desired outcomes.** BO-1 to BO-7 in the [BRD](requirements/BRD.md): more work per paid subscription, no credential
handling, safe unattended runs, continuity across providers, visibility, resilience to CLI churn, and agent work that
reaches the repository as ordinary commits with the audit record kept internally.

**In scope.** Capabilities CAP-1 to CAP-11 in the [PRD](requirements/PRD.md), including projects (the environments
agents operate from and their contexts, CAP-10) and controlled commits and publication (CAP-11). "Application" in this
project means the MCP tool surface plus the operator CLI; "backend" means the controller daemon and its ledger,
workspace manager, router and adapters.

**Non-goals.** Owned by [PRD §6](requirements/PRD.md#6-non-goals). In short: no web UI (a read-only usage dashboard is
deferred), no login or OAuth handling, no hosted or multi-user service, no reimplementation of provider APIs, no claim
of Terms-of-Service compliance, no automatic merges into the operator's branches, and no push that is not made by a
policy-gated Switchboard tool (off by default); agents never commit or push themselves.

## 3. Current state and target state

### 3.1 Audit findings (2026-10-12)

| Area | Finding | Evidence |
| --- | --- | --- |
| Source code, tests, config, CI | None exist. Nothing is implemented. | Repository tree at commit `d41c10c`: only `LICENSE` and `docs/research/` |
| Agent instructions | None existed before this change. Now [AGENTS.md](../AGENTS.md) (with `CLAUDE.md` importing it). | — |
| Roadmap / plan | **No authoritative roadmap existed.** The plan was fragmented across two research documents. The closest thing to a plan was the eight-stage "production sequence" table at the end of the verified research. | [R2 § MCP, ACP, and the recommended production architecture](research/headless-ai-coding-controller-verified-2026-10-12.md#mcp-acp-and-the-recommended-production-architecture) |
| Original blueprint | Describes intent and an architecture, but many concrete flags, permission settings, quota assumptions and the transcript-extraction approach are contradicted by later verified research. Retained as historical record, marked **superseded where it conflicts**. | [headless-ai-coding-controller.md](research/headless-ai-coding-controller.md) |
| Verified research | Current as of 2026-10-12. Reviews the blueprint point by point and recommends corrections. Used as the primary technical source. Not itself a requirements or design document. | [headless-ai-coding-controller-verified-2026-10-12.md](research/headless-ai-coding-controller-verified-2026-10-12.md) |
| Requirements and design documents | None existed. Created in this change (see §5). | — |

### 3.2 Target state

An open-source, single-operator-per-installation controller for Linux and macOS that passes conformance and
malicious-fixture suites for all seven providers (Kimi Code once its contract is pinned), is installable by other people
from its README, exposes the MCP tools in [SRS §3.1](requirements/SRS.md#31-mcp-interface-fr-mcp), continues work across
providers from controller-owned state, routes with explainable decisions, and reports capacity as confidence-weighted
estimates. Architecture: [HLD](design/HLD.md).

## 4. Constraints, assumptions, decisions and conflicts

### 4.1 How sources are classified

| Class | Meaning | Where recorded |
| --- | --- | --- |
| **Owner decision** | Explicitly decided by zemdregon. | Listed in §4.2 only. |
| **Stated intent** | Requirements stated in the original blueprint's introduction, which zemdregon supplied as the project brief. Treated as approved intent, not as approved design. | §4.3 |
| **Delegated decision** | Made by an agent during the 2026-10-12 planning task under zemdregon's delegation. Binding for implementation until revised, not owner-approved. | ADRs marked "Delegated", and §4.4 |
| **Assumption** | Conservative choice where information is missing. Must be confirmed or replaced. | §4.5 |

### 4.2 Owner decisions

1. The two research documents are project research for Switchboard (PRs #1 and #2, merged).
2. Agent work in this project routes model tiers by task difficulty (Haiku for simple, mechanical work; Opus or Fable
   only for demanding work). Recorded in [AGENTS.md](../AGENTS.md#subagent-routing-and-orchestration).
3. The documentation set and roadmap in this change were requested by zemdregon. Their *content* is delegated, not approved.
4. Switchboard is built for zemdregon's own use and published as open source so other people can run it with their own
   subscriptions (2026-10-12).
5. zemdregon holds every subscription named in the research. All seven providers must be integrated; Claude Code and Codex
   are the first integrations (2026-10-12).
6. Switchboard controls *projects*: the environments the coding agents operate from (likely a container of some kind)
   and the *contexts* of those projects, such as repositories (2026-10-12). Recorded in
   [ADR-0013](adr/0013-projects-environments-and-contexts.md); the mechanism is delegated.
7. The agents have no commit or push controls. Commits and pushes are made by Switchboard tools injected into the agent,
   so there are no co-author trailers, "generated by" footers or session IDs and a commit looks like any other commit
   (2026-10-12). Recorded in [ADR-0014](adr/0014-tool-only-commits-and-publication.md); the mechanism, and keeping an
   internal audit trail of which agent produced which commit, are delegated.
8. An orchestrator may create and change projects over MCP (2026-10-12, answer "yes" to Q-7). Recorded in
   [ADR-0013](adr/0013-projects-environments-and-contexts.md). The gating (client opt-in, the client's own limits,
   operator approval for containers and push, creator-only visibility) is delegated.
9. Agents may push, through the injected `push` tool, and commit signing is wanted (2026-10-12, answer "yes" to Q-9).
   Recorded in [ADR-0014](adr/0014-tool-only-commits-and-publication.md). Reading: the question had two parts and "yes"
   was taken for both. Branch scope, the per-context opt-in (push stays off until a context enables it) and the
   signing mechanism are delegated. zemdregon left Q-6 (container runtime and logins) and Q-8 (commit identity) to the agent,
   so those choices are delegated, not owner decisions.

### 4.3 Stated intent (confirmed constraints)

From the [original blueprint's
introduction](research/headless-ai-coding-controller.md#introduction-to-the-cli-native-orchestration-paradigm):

- C-1 Wrap the seven provider CLIs through their headless or documented automation modes, not raw model APIs.
- C-2 No web interface, except restricted dashboards purely for usage monitoring and telemetry.
- C-3 Never interact with OAuth or subscription login flows; rely on credentials cached by the native CLIs.
- C-4 Own model definitions and route by task complexity.
- C-5 Tier-aware load balancing across subscriptions.
- C-6 Persistent cross-provider meta-sessions.
- C-7 Expose capabilities to a primary orchestrator (for example OpenClaw or Grok Bot) as an MCP or ACP server.

### 4.4 Material delegated decisions

| Decision | Record |
| --- | --- |
| The verified research supersedes the original blueprint wherever they conflict (see §4.6). | This roadmap; banner on the original research doc |
| Controller-owned canonical state; no transcript parsing | [ADR-0001](adr/0001-controller-owned-canonical-state.md) |
| MCP upstream (async-first tools); ACP as downstream transport; upstream ACP deferred | [ADR-0002](adr/0002-mcp-upstream-acp-downstream.md) |
| No credential handling; compliance manifests; no "ToS compliant" claims | [ADR-0003](adr/0003-no-credential-handling.md) |
| Five trust profiles; no automatic bypass flags | [ADR-0004](adr/0004-trust-profiles-no-bypass-flags.md) |
| SQLite ledger | [ADR-0005](adr/0005-sqlite-ledger.md) |
| Worktree per write-capable run; no blind replay | [ADR-0006](adr/0006-worktree-checkpoints-no-blind-replay.md) |
| Capacity as confidence estimate; bounded priority queue | [ADR-0007](adr/0007-capacity-as-confidence-estimate.md) |
| Two-stage routing; learned routing deferred | [ADR-0008](adr/0008-two-stage-routing.md) |
| Version-gated adapters | [ADR-0009](adr/0009-version-gated-adapters.md) |
| TypeScript on Node.js | [ADR-0010](adr/0010-typescript-node-stack.md) |
| Single-operator, local, Linux-first | [ADR-0011](adr/0011-single-operator-local-deployment.md) |
| Telemetry at the wrapper boundary | [ADR-0012](adr/0012-telemetry-at-wrapper-boundary.md) |
| Projects (environment plus contexts) defined in configuration; `host` environments first, `container` with a Proposed rootless runtime (Q-6, delegated); an orchestrator can create projects only within its client's limits and with operator approval for containers and push | [ADR-0013](adr/0013-projects-environments-and-contexts.md) |
| Agents never commit or push; injected `commit` and `push` tools do, push off by default; published commits sanitised and separate from internal checkpoints; provenance kept in the ledger | [ADR-0014](adr/0014-tool-only-commits-and-publication.md) |
| Operator CLI commands run as short-lived processes that write only operator records; one `serve` daemon per data directory performs all side effects | [ADR-0005](adr/0005-sqlite-ledger.md), [SDD §6](design/SDD.md#6-design-questions-settled-during-reconciliation) |
| `adapters validate` moved from M8 to M4 so new CLI versions can be accepted as soon as most adapters exist | This roadmap, FR-OPS-02 |
| Delivery order: a thin MCP vertical slice with one adapter (M2) comes *before* adapter expansion, unlike the research's stage order where the MCP protocol came seventh. Rationale: the orchestrator can use and test the controller early; routing and capacity still come after execution semantics are trustworthy, which is the research's actual concern. | This roadmap |

### 4.5 Assumptions

| ID | Assumption | Impact if wrong |
| --- | --- | --- |
| A-1 | *Resolved by owner decision 4.* Each installation serves one operator using that operator's own logins; open-source users run their own installations. Hosted or shared multi-user operation remains out of scope. | A hosted service would change compliance scope, auth model and deployment (ADR-0011, ADR-0003). |
| A-2 | Linux is the first host; macOS follows in M4 because open-source users are likely to run it. | If most users turn out to be on macOS, move NFR-PORT-02 earlier. |
| A-3 | *Resolved by owner decision 5:* Claude Code and Codex are the M2 adapters. | — |
| A-4 | The first orchestrator is any stdio MCP client; acceptance tests use a scripted MCP test client rather than a specific product. | A specific orchestrator may need HTTP transport or different tool shapes. |
| A-5 | *Resolved by owner decision 5:* all seven subscriptions are held and all seven adapters are Must. | — |

### 4.6 Conflicts between sources and how they were resolved

Resolution rule: the verified research is a direct, dated review of the original blueprint against provider
documentation, so its technical findings win. Where the original carries zemdregon's *stated intent* (§4.3), the intent is
kept and only the mechanism changes.

| Topic | Original blueprint | Verified research | Resolution |
| --- | --- | --- | --- |
| Permission flags | `--allowedTools "*"`, `--dangerously-skip-permissions`, `--yolo`, `--trust --approve-mcps --force` | `"*"` is skipped; bypass flags grant too much; trust, MCP approval, command approval and sandbox are separate | Trust profiles, no automatic bypass ([ADR-0004](adr/0004-trust-profiles-no-bypass-flags.md)) |
| Codex interface | `codex -p`, custom JSON wrapper | `codex exec --json` emits JSONL natively | Use native JSONL (TDD §4) |
| Kimi Code | `kimi run`, K2.7, 256K context | Legacy CLI archived 2026-09-23; new contract unknown | Adapter blocked until pinned (FR-ADP-09) |
| Context windows | Hard-coded per CLI | Model properties, change over time | Model registry (FR-ADP-05) |
| Cross-provider state | Parse provider transcripts, summarize trajectories | Controller-owned state; Git is canonical | [ADR-0001](adr/0001-controller-owned-canonical-state.md); intent C-6 kept |
| Quota / NCU | NCU as precise share of remaining quota | Only confidence-weighted estimates are defensible | [ADR-0007](adr/0007-capacity-as-confidence-estimate.md); intent C-5 kept |
| Rate limiting | Leaky bucket ingress, token bucket egress, blind retry | Priority queue, semaphores, breakers; no replay after mutation | [ADR-0006](adr/0006-worktree-checkpoints-no-blind-replay.md), [ADR-0007](adr/0007-capacity-as-confidence-estimate.md) |
| Routing | Brand-to-tier table, IRT | Eligibility then empirical scoring | [ADR-0008](adr/0008-two-stage-routing.md); intent C-4 kept |
| Telemetry | Inject global Claude hooks | Observe at wrapper boundary | [ADR-0012](adr/0012-telemetry-at-wrapper-boundary.md) |
| MCP vs ACP | "MCP or ACP server" | MCP upstream, ACP downstream | [ADR-0002](adr/0002-mcp-upstream-acp-downstream.md); intent C-7 met via MCP |
| Compliance claim | "Absolute ToS compliance" | Documented automation is not a blanket contractual grant | NFR-COMP-01 |
| OpenClaw "Lane Queue" | Relied on for write serialization | Could not be verified | Controller enforces its own leases (FR-WS-02) |
| "Frees 96% of context" | Claimed | Not defensible | Dropped |

## 5. Documentation map

| Path | Purpose | Status | Authoritative for |
| --- | --- | --- | --- |
| [AGENTS.md](../AGENTS.md) | Agent instructions | Current | How agents work in this repo |
| [docs/ROADMAP.md](ROADMAP.md) | This document | Canonical | Scope, priorities, sequencing, status |
| [docs/requirements/BRD.md](requirements/BRD.md) | Business requirements | Draft baseline | Problem, outcomes `BO-*`, stakeholders, success measures |
| [docs/requirements/PRD.md](requirements/PRD.md) | Product requirements | Draft baseline | Users, journeys `UJ-*`, capabilities `CAP-*`, non-goals, product acceptance |
| [docs/requirements/FRD.md](requirements/FRD.md) | Functional behaviour | Draft baseline | Workflows `WF-*`, business rules `BR-*`, run state machine, permissions, validation |
| [docs/requirements/SRS.md](requirements/SRS.md) | Software requirements | Draft baseline | Every requirement ID (`FR-*`, `NFR-*`) and its verification method |
| [docs/design/HLD.md](design/HLD.md) | High-level design | Draft baseline | Boundaries, components `COMP-*`, trust boundaries, deployment, data flows, threats |
| [docs/design/SDD.md](design/SDD.md) | Software design | Draft baseline | Component collaboration, shared patterns, requirement→design traceability |
| [docs/design/TDD.md](design/TDD.md) | Technical design | Draft baseline | Technology choices, cross-cutting concerns, per-provider adapter strategy, test strategy |
| [docs/design/LLD.md](design/LLD.md) | Low-level design | Draft baseline (M1–M2 detail) | Schemas, interfaces, tool contracts, failure taxonomy, algorithms |
| [docs/adr/](adr/README.md) | Decision records | 14 accepted (13 and 14 record zemdregon's 2026-10-12 decisions; mechanisms delegated) | Why each architectural decision was made |
| [docs/research/headless-ai-coding-controller-verified-2026-10-12.md](research/headless-ai-coding-controller-verified-2026-10-12.md) | Verified research | Current reference | Evidence for provider behaviour as of 2026-10-12 |
| [docs/research/headless-ai-coding-controller.md](research/headless-ai-coding-controller.md) | Original blueprint | **Superseded** where it conflicts (§4.6); retained for stated intent | Stated intent C-1 to C-7 only |
| `scripts/check-docs.mjs` | Documentation link and ID checker | Current | Mechanical consistency of this set |

## 6. Milestones

Status values: `Done`, `In progress`, `Partial`, `Planned`, `Blocked`, `Deferred`. No milestone has dates; none were
set. Sizes are not estimated. M9 and M10 were added on 2026-10-12 for owner decisions 6 and 7 (projects; tool-only
commits).

| ID | Milestone | Status | Depends on | Requirements delivered (first delivery) | Acceptance criteria | Verification |
| --- | --- | --- | --- | --- | --- | --- |
| M0 | Documentation baseline | In progress (this change); Done on merge | — | NFR-MAINT-02, NFR-COMP-01 | Document set in §5 exists; `node scripts/check-docs.mjs` passes; AGENTS.md points here | Docs check script; review |
| M1 | Foundation | **Done** (2026-10-12): every acceptance criterion has a passing test (166 tests locally); first CI run unconfirmed; requirement gaps marked `Partial` in §6.1 | M0 | FR-ADP-01, FR-AUTH-01, FR-POL-10, FR-WS-01–06, FR-SES-01, 02 (schema), 05 (events), FR-CAP-04 (queue, global limit), FR-EXE-01, 02, 05–07, FR-SES-06, FR-TEL-01, 03, FR-OPS-01 (`doctor`, `runs`), 03, 04, NFR-SEC-01, 02, 04–06, NFR-REL-01–02, NFR-PERF-03 (global), NFR-PORT-01, NFR-PRIV-01 | A fake provider CLI runs through the full lifecycle transactionally; cancel kills the process tree; `SIGKILL` of the controller mid-run followed by restart leaves a consistent ledger; a failed run that mutated files is rolled back, not replayed; CI green on Linux | Automated integration and fault-injection tests in CI; evidence in §6.1 |
| M2 | Claude Code and Codex adapters + MCP vertical slice | Planned | M1 | FR-MCP-01, 03–09, FR-ADP-02–04, 06, 11 (Claude Code, Codex), FR-POL-01 (two profiles), 02–05, 07, 08, FR-AUTH-02, FR-GIT-01 (Claude Code, Codex), FR-SES-03 (Claude Code, Codex), FR-RTE-01 (eligibility), FR-CAP-01 (record), FR-OPS-01 (`serve`), NFR-PERF-01, 02, NFR-OBS-01, NFR-PRIV-02, NFR-MAINT-03 | For each of Claude Code and Codex, a scripted MCP client delegates an edit task under `edit-untrusted`, polls to `SUCCEEDED`, retrieves a diff artifact and continues the same native session; a new user following the README reaches a passing `doctor`; missing login yields `AUTH_REQUIRED`; unknown CLI version yields `ADAPTER_VERSION_UNVERIFIED`; no bypass flag appears in any compiled invocation; no compiled invocation leaves a Git write operation (commit, ref change, push) permitted (FR-GIT-01) | Conformance suite on recorded fixtures in CI; one opt-in live smoke test run by the operator; argv inspection test |
| M3 | Isolation | Planned | M2 | FR-POL-01 (all), 06, 09, FR-WS-07, FR-EXE-08, FR-OPS-02 (`approve`, `deny`), NFR-SEC-03 (Claude Code, Codex), NFR-DATA-01 | Malicious-fixture suite shows no escape for each profile on Claude Code and Codex; `privileged` runs wait for `approve` and end `CANCELLED` on `deny`; verification commands run and are recorded; retention deletes artifacts, worktrees and branches together | Malicious-fixture suite; integration tests |
| M4 | Adapter expansion | Planned (Kimi Code part blocked by B-1) | M3, M9 (Proposed) | FR-ADP-05, 07, 08, 09, 10, 11 (others), FR-EXE-03, FR-OPS-02 (`adapters validate`), NFR-SEC-03 (others), NFR-MAINT-01, NFR-PORT-02 | Grok Build, Antigravity, Cursor and OpenCode adapters pass conformance and malicious-fixture suites; the test suite passes on macOS; Kimi Code passes once B-1 clears (M4 may be marked `Partial` until then, with only Kimi outstanding); ACP transport used where it is the adapter's chosen surface; adding an adapter touched only its own module, manifest, fixtures and registry entry; `adapters validate` accepts a new CLI version only after its live checks pass | Conformance and fixture suites per adapter; diff inspection |
| M5 | Continuity | Planned | M4 | FR-SES-02 (populated), 03 (all), 04, 05 (handoff view) | Provider A edits and tests; provider B continues from the handoff bundle and completes the task; no provider transcript file is opened (verified by file-access test) | End-to-end test with two fake adapters plus one opt-in live pair |
| M6 | Capacity and resilience | Planned | M5 | FR-MCP-02 (`get_capacity`), 10, FR-CAP-01 (use), 02–07, FR-OPS-05, NFR-PERF-03 (per provider) | Injected rate-limit, overload, quota and crash failures produce the behaviour in FRD WF-5, with successor runs linked to their predecessors; `get_capacity` and `switchboard capacity` never return `explicit_remaining` unless the provider reported it | Fault-injection tests with fake adapters |
| M7 | Routing | Planned | M6 | FR-MCP-02 (`explain_route`), FR-RTE-01 (full), 02–04 | Given stored features and weights, re-running the scorer reproduces every stored decision; `explain_route` lists the deciding factors | Deterministic replay test |
| M8 | Hardening | Planned | M7 | FR-TEL-02 | OTel traces reach a test collector with no forbidden attributes; a scheduled version canary on the operator's machine flags CLI updates before they reach routing | Collector test; version-bump test |
| M9 | Projects and controlled commits | Planned. Numbered after M8 to keep existing milestone IDs stable; **sequenced after M3 and before M4** (Proposed) so new adapters declare their Git controls once | M3 | FR-PRJ-01–04, 06, 08, 10, FR-GIT-01 (fixtures), 02–10, FR-WS-05 (publication) | A scripted MCP client lists projects and delegates to one (`host` environment, one repository context) and the lower of client and project ceilings applies; the agent's `commit` tool call produces a commit on the publish ref with the configured identity and no trailer, footer or identifier even when the message contains them; an agent attempt to commit, move a ref or push (shell or provider built-in) leaves nothing on the publish ref and appears as `git_policy_violation`; with push `none` nothing leaves the host, with `branch` against a local bare remote only the publish ref arrives and never checkpoint commits or run branches; every published commit has a `git_commit` row naming run, provider and model; a client with `manage_projects` can create a `host` project within its limits and use it, a `container` or push-enabled revision stays unusable until `projects approve`, and a client without the flag has no project-management tools; with `sign: true` the published commit verifies against the operator's key and a failed signature creates no commit; adapters that cannot take the channel without a bypass flag run in finalize-only mode only on opt-in | Fake-adapter integration tests with real Git repos and a local bare remote; sanitiser fixtures; malicious-fixture additions for Claude Code and Codex; argv inspection |
| M10 | Container environments | Planned; B-2 resolved by delegation (Proposed), starts with a spike | M9 | FR-PRJ-05, 07, 09 | A `container` project mounts only the run worktree and declared read-only contexts, applies its limits and network policy, and is removed at run end and after a controller crash; no home directory, data directory, push credential or runtime socket is mounted; the container leg of the malicious-fixture suite shows no escape | Opt-in container integration tests (skipped in CI until a runtime is chosen); fault injection; inspection of mounts |

### 6.1 M1 Foundation: tasks

Each task lists objective, references, dependencies and completion checks. Tasks are in dependency order; T1.3 to T1.6
can run in parallel after T1.2.

Task status: **T1.1 to T1.11 Done** (2026-10-12). Evidence is local: `npm test` passes (13 files, 166 tests),
alongside typecheck, lint and `node scripts/check-docs.mjs`. Caveats: the first CI run is unconfirmed, and GitHub
Actions are not yet pinned by SHA (`setup-node` uses a tag).

- **T1.1:** `package.json`, `package-lock.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`,
  `.github/workflows/ci.yml`; versions recorded in [TDD §2](design/TDD.md#2-technology-choices).
- **T1.2:** `src/config/` and `src/lock/`; `src/config/config.test.ts` (precise rejection messages, symlink
  canonicalization), `src/lock/lock.test.ts` (second acquisition fails clearly, stale lock recovered).
- **T1.3:** `src/ledger/`, `src/ids/`; `src/ledger/ledger.test.ts` (migration from empty DB, WAL, append-only
  triggers on `run_event`), `src/ids/ids.test.ts`.
- **T1.4:** `src/artifacts/`; `src/artifacts/artifacts.test.ts` (SHA-256 addressing, redaction before write).
- **T1.5:** `src/workspace/`; `src/workspace/workspace.test.ts` (second lease refused, operator tree untouched, mutated
  failure rolled back, non-Git refused for write profiles).
- **T1.6:** `src/exec/`; `src/exec/supervisor.test.ts` (child and grandchild killed on cancel, env allowlist, oversize
  and malformed lines give `OUTPUT_PROTOCOL_ERROR`), `src/exec/jsonl.test.ts`.
- **T1.7:** `src/adapters/`; `src/adapters/adapters.test.ts` (fake adapter scenarios, conformance harness, no bypass
  flags in compiled argv).
- **T1.8:** `src/lifecycle/`; `src/lifecycle/lifecycle.test.ts` (state-machine table, admission, queue bound,
  priority, concurrency, one active run per meta-session, per-edge outcomes, cancel in each state).
- **T1.9:** `src/reconcile/`; `src/reconcile/reconcile.test.ts` (real `SIGKILL` of a controller child during RUNNING,
  restart ends `FAILED/PROCESS_CRASH`, orphan killed, PID-reuse guard, per-state WF-8 outcomes).
- **T1.10:** `src/cli/`; `src/cli/cli.test.ts` (no login command, `doctor`, `runs list|show|cancel` with `--json`,
  cancel with and without a lock holder, daemon-side application).
- **T1.11:** this reconciliation; design-doc changes are listed in the change description and carried in the documents
  named in §6.1.1.

#### 6.1.1 M1 requirements not fully evidenced

These requirements are in the M1 row of §6, but the evidence above does not fully cover them. They stay `Partial`
until the gap closes; none blocks M2 work.

| Requirement | Status | Gap |
| --- | --- | --- |
| FR-OPS-01 | Partial | `doctor`, `runs list`, `runs show`, `runs cancel` are tested; `serve` is M2 (T2.6) |
| NFR-PORT-01 | Partial | CI targets `ubuntu-24.04` (x86-64) only, the first CI run is unconfirmed, and arm64 is untested (TDD §2 says an arm64 runner is to be confirmed) |
| NFR-SEC-01 | Partial | Secret redaction is tested for artifacts only; no secret-pattern scan covers the ledger, CLI output or logs |
| FR-TEL-03 | Partial | Same gap as NFR-SEC-01; no test asserts that `run_event` payloads and CLI output omit prompts and environment values |
| NFR-SEC-04 | Partial | Inspection-only requirement; no check or recorded review that the controller runs unprivileged |
| NFR-PRIV-01 | Partial | Inspection-only requirement; no recorded review (no network code exists, but nothing asserts it) |
| NFR-SEC-06 | Partial | Fail-closed cases are tested (unreadable worktree, unreadable pending outcome, bypass flag, unknown schema version); "ledger cannot be opened, refuse to serve" waits for `serve` |

All other requirements in the M1 row have at least one passing test named in the task notes above.

| Task | Objective | References | Depends on | Done when |
| --- | --- | --- | --- | --- |
| T1.1 | Scaffold the TypeScript project, lint/format, test runner and a GitHub Actions workflow running typecheck, lint, tests and `node scripts/check-docs.mjs` on Linux | [TDD §2](design/TDD.md#2-technology-choices), ADR-0010, NFR-PORT-01 | — | CI passes on an empty test; `npm test` works locally; versions pinned and recorded in TDD §2 |
| T1.2 | Config file with schema validation: data directory, allowed workspace roots, concurrency, provider enablement and weights, named MCP client entries with max trust profile; data-directory lock so only one `serve` runs | FR-OPS-04, FR-POL-10, NFR-SEC-05, NFR-PERF-03, [TDD §3.1](design/TDD.md#31-configuration), [ADR-0005](adr/0005-sqlite-ledger.md) | T1.1 | Invalid config is rejected with a precise message; paths are canonicalized (symlink test); a second `serve` on the same data directory fails clearly |
| T1.3 | SQLite ledger with forward-only migrations and the M1 tables; append-only `run_event` | [LLD §1](design/LLD.md#1-data-model), ADR-0005, FR-SES-01, 02, 05, FR-TEL-01 | T1.2 | Migration test from empty DB; append-only enforced (update/delete on `run_event` fails); WAL enabled |
| T1.4 | Content-addressed artifact store with redaction hook | FR-EXE-05, FR-TEL-03, NFR-SEC-01 | T1.2 | Artifacts addressed by SHA-256; secret-pattern fixture is redacted before write |
| T1.5 | Workspace manager: base checkpoint, worktree on controller branch, write lease, post-run checkpoint, diff artifact, mutation detection, rollback | [LLD §5](design/LLD.md#5-workspace-and-lease-algorithm), ADR-0006, FR-WS-01–06 | T1.3 | Tests: second lease on same worktree refused; operator branch and working tree untouched; mutated failure rolls back to checkpoint; non-Git workspace refused for write profiles |
| T1.6 | Execution supervisor: spawn in process group, env allowlist, timeout, cancel (graceful then forced), separate stdout/stderr capture, line-framed JSONL reader | [LLD §8](design/LLD.md), FR-EXE-01, 02, 05, 07, NFR-REL-02 | T1.2 | Tests: child and grandchild both killed on cancel; env outside allowlist absent in child; oversize or malformed line yields `OUTPUT_PROTOCOL_ERROR` without crashing |
| T1.7 | Adapter contract and a fake provider CLI with scripted behaviours (success, task failure, auth missing, rate limit, partial mutation then failure, malformed output, hang) | [LLD §2](design/LLD.md#2-adapter-contract), FR-ADP-01 | T1.6 | Fake adapter passes the conformance harness skeleton that M2 will reuse |
| T1.8 | Run lifecycle orchestration (internal API, no MCP yet): queue → preflight → lease → run → finalize, following the FRD state machine, with bounded priority queue, global concurrency and one active run per meta-session | [FRD §4](requirements/FRD.md#4-canonical-run-state-machine) WF-1, WF-4, WF-5, FR-CAP-04, FR-SES-06, [LLD §10](design/LLD.md#10-idempotency-and-ordering) | T1.3–T1.7 | Every FRD transition reachable in M1 has a test; illegal transitions rejected; a second active run on one meta-session is refused |
| T1.9 | Startup reconciliation | FR-EXE-06, NFR-REL-01, FRD WF-8 | T1.8 | Fault-injection test: `SIGKILL` controller during RUNNING, restart, run ends `FAILED/PROCESS_CRASH` with workspace assessed |
| T1.10 | Operator CLI: `doctor` (fake adapter), `runs list`, `runs show`, `runs cancel`, each with `--json`; cancel is written as an operator record the daemon applies | FR-OPS-01, FR-OPS-03, [SDD §3](design/SDD.md#3-interface-responsibilities-and-error-propagation) | T1.8 | CLI tests on output; cancel works with and without a running daemon; no login command exists |
| T1.11 | Update this roadmap's status and any design docs changed during M1 | NFR-MAINT-02 | all | §6 shows M1 `Done` with links to the tests |

### 6.2 M2 Claude Code adapter and MCP slice: tasks

| Task | Objective | References | Depends on | Done when |
| --- | --- | --- | --- | --- |
| T2.1 | Pin the Claude Code and Codex version ranges and record their compliance manifests | FR-POL-07, FR-ADP-03, [LLD §6](design/LLD.md#6-compliance-manifest) | M1 | Manifest file exists and is loaded; unknown version → `ADAPTER_VERSION_UNVERIFIED` test |
| T2.2 | Claude Code adapter, then Codex adapter: probe, auth preflight, compile for `inspect-untrusted` and `edit-untrusted`, parse structured output, resume | [TDD §4](design/TDD.md#4-provider-adapter-strategy), FR-ADP-02, 04, 06, FR-POL-02–05, 08, FR-AUTH-02, FR-SES-03 | T2.1 | Conformance suite passes on recorded fixtures; argv test proves no bypass flags, no global config writes and no permitted Git write operation (FR-GIT-01; the deny-rule syntax and any provider commit or attribution setting are not in the research and are verified against the installed CLI here, then recorded in the manifest notes) |
| T2.3 | Eligibility filter | FR-RTE-01, FR-MCP-05, ADR-0008 | T2.2 | Tests for each hard constraint available in M2 |
| T2.4 | MCP server on stdio with `delegate_task`, `continue_task` (same provider), `get_run`, `cancel_run`, `get_artifacts`, `list_capabilities`; schema validation; per-client max profile; idempotency key | [LLD §3](design/LLD.md#3-mcp-tool-contracts), FR-MCP-01, 03–09 | T2.3 | Scripted MCP client test passes end to end against the fake adapter and against Claude fixtures |
| T2.5 | Record provider-reported usage observations | FR-CAP-01 | T2.2 | Usage stored with source labels, separate from estimates |
| T2.6 | `switchboard serve`; opt-in live smoke test documented for the operator | FR-OPS-01 | T2.4 | Operator can run the live test with one command; it is skipped in CI |
| T2.8 | User documentation: README with install, native login for Claude Code and Codex, config, trust profiles and `doctor` troubleshooting | NFR-MAINT-03, NFR-COMP-01 | T2.6 | A fresh machine reaches a passing `doctor` following only the README |
| T2.7 | Measure NFR-PERF-01 and either confirm or revise the proposed target | NFR-PERF-01 | T2.4 | Benchmark result recorded in TDD |

### 6.3 M9 Projects and controlled commits: tasks

*Proposed breakdown, written when M9 was added; revisit when M3 completes.* Each task lists its references and its
completion check. Design: [LLD §11](design/LLD.md#11-projects-contexts-and-environments),
[LLD §12](design/LLD.md#12-injected-git-tools-commits-and-publication),
[TDD §3.10](design/TDD.md#310-git-commits-attribution-and-publication).

| Task | Objective | References | Depends on | Done when |
| --- | --- | --- | --- | --- |
| T9.0 | Spike: settle the open mechanisms. Per-run Git configuration for agent processes; the Git plumbing for building a commit from a path subset; how Claude Code and Codex accept a per-run MCP definition; whether their sandboxes let the shim reach a Unix socket; deny-rule syntax for Git writes; any provider commit or attribution setting | TDD §3.10, FR-GIT-01, 02, R-18, R-19 | M3 | Findings (commands and flags verified against the installed CLIs, or the adapter marked `finalize-only` with evidence) are written into TDD §3.10, LLD §12 and the manifest notes; `MIN_GIT_VERSION` revisited |
| T9.1 | Project and context schema in the config loader, `projects list`, `projects show`, `projects validate` (`host`) | FR-PRJ-01, 02, 04, 08, [LLD §11.1](design/LLD.md#111-configuration-shape) | T9.0 | Unknown context kind and out-of-root path rejected; commands have `--json`; schema published |
| T9.2 | `project_id` migration, policy-snapshot fields, `delegate_task` `project` input, `list_projects`, lower-of-two ceiling, per-client project list | FR-PRJ-03, 06, FRD V12, BR-23 | T9.1 | Tests: both/neither of project and path rejected, ceiling arithmetic, client list enforced, run and meta-session carry the project |
| T9.3 | `git_commit` and `git_push` tables; publish ref; commit algorithm; sanitiser with built-in rules and operator patterns | FR-GIT-04, 07, 08, [LLD §12.3–12.4](design/LLD.md#123-commit-algorithm-and-refs) | T9.0 | Fixtures of typical attribution trailers, footers and session IDs leave none in the commit; checkpoint commits are not reachable from the publish ref; provenance row written in the same transaction |
| T9.4 | Shim subcommand, per-run socket and token, `COMP-GIT` service, `GitCapabilities` for the fake adapter, Claude Code and Codex | FR-GIT-01, 02, [LLD §12.2](design/LLD.md#122-channel) | T9.2, T9.3 | Fake adapter commits through the tool end to end; token and run-state checks refuse stale or foreign calls |
| T9.5 | Ref snapshots at LEASED and FINALIZING; violation handling; malicious fixtures for `git commit`, ref changes and push attempts | FR-GIT-01, 03, BR-27 | T9.4 | Every scripted attempt leaves the publish ref unchanged and appends `git_policy_violation`; legitimate tool commits are not flagged |
| T9.6 | Push policy, credential-reach rule, `push` tool and operator command; `runs show` provenance view | FR-GIT-05, 06, 07, BR-29, BR-31, FR-WS-05 | T9.4 | Against a local bare remote: policy `none` offers no tool; `branch` pushes only the publish ref; force, default branch, tags and run branches refused; host-with-shell withholds `push` |
| T9.7 | Finalize-only mode for adapters that cannot take the channel (Should) | FR-GIT-09, BR-30 | T9.3 | Opt-in commit at FINALIZING passes the same sanitiser and provenance tests |
| T9.8 | Update the README (projects, commit behaviour, push default), roadmap status and any document the work proved wrong | NFR-MAINT-02, NFR-MAINT-03 | T9.1–T9.7, T9.9, T9.10 | §6 shows M9 `Done` with links to the tests |
| T9.9 | `manage_projects` client flag, `project_revision` table, `create_project`, `update_project`, `delete_project`, creator-only visibility, `projects approve` | FR-PRJ-10, BR-32, [LLD §3](design/LLD.md#3-mcp-tool-contracts), [LLD §11.1](design/LLD.md#111-configuration-shape) | T9.2 | Tests: tools absent without the flag; configured projects and other clients' projects refused; path outside allowed roots, ceiling, provider and push widening beyond the client rejected; `container` and push revisions stay `PENDING_APPROVAL` until `projects approve`; delete with an active run refused; every call is an event |
| T9.10 | Optional commit signing: `sign` context option, controller-side signing with the operator's Git configuration, `projects validate` test signature | FR-GIT-10, BR-33, [LLD §12.3.1](design/LLD.md#1231-signing-fr-git-10-proposed) | T9.3, T9.6 | A signed commit verifies; failure returns `SIGNING_FAILED` and leaves the publish ref unchanged; the key and agent variables never reach the provider process (environment inspection); refused where BR-31 withholds `push` |

### 6.4 M10 Container environments: tasks

*Proposed.* Q-6 was left to the agent, so the runtime and login mechanism are delegated and verified by T10.0 before any
other M10 task.

| Task | Objective | References | Depends on | Done when |
| --- | --- | --- | --- | --- |
| T10.0 | Spike: verify the Proposed rootless runtime and in-volume native login for each provider, and how Git read operations work inside the container; amend ADR-0013 or supersede it | Q-6, FR-AUTH-01, [TDD §3.11](design/TDD.md#311-container-environments) | M9 | Findings recorded, ADR updated, R-13 updated; a provider whose login cannot work in a container is marked `host`-only |
| T10.1 | Environment port with a container implementation: mounts, limits, network policy, labels, teardown | FR-PRJ-04, 05, [LLD §11.3](design/LLD.md#113-environment-port) | T10.0 | Opt-in tests show only the worktree and declared read-only contexts mounted and the container removed at run end |
| T10.2 | Startup orphan sweep and `environment` run events | FR-PRJ-07, FR-EXE-06 | T10.1 | Fault injection: `SIGKILL` mid-run, restart, container gone before worktree assessment |
| T10.3 | Container leg of the malicious-fixture suite; `projects validate` checks; retention of containers and volumes | NFR-SEC-03, FR-PRJ-08, 09 | T10.1 | Fixtures show no escape; GC removes containers with worktrees |

Later milestones (M3–M8) are intentionally kept at the level of the table in §6; break them into tasks when the
preceding milestone completes.

## 7. Risks, blockers and open questions

### 7.1 Risks

| ID | Risk | Effect on plan | Mitigation |
| --- | --- | --- | --- |
| R-1 | Provider CLIs change flags, output or auth behaviour (already happened with Kimi) | Adapters break or weaken security | Version gating, conformance suites, manifests (ADR-0009) |
| R-2 | Provider terms restrict automated or third-party use for some plans | A provider may be unusable | Compliance manifest review per provider; each user runs their own installation with their own logins (ADR-0003, ADR-0011) |
| R-11 | Publishing as open source invites users to run Switchboard in ways the terms do not allow (shared logins, hosted service) | Account risk for those users; reputational risk for the project | README states the single-operator model and that terms compliance is each user's responsibility (NFR-COMP-01, NFR-MAINT-03) |
| R-3 | Same-user credential exfiltration by a prompt-injected agent | Credential theft | FR-POL-06; provider-native sandboxes; untrusted profiles without shell; M3 fixtures |
| R-4 | Native sandbox support differs by platform | Fewer eligible providers on some hosts | Eligibility is per platform; Linux first |
| R-5 | Capacity is opaque | Throttling mid-task | Confidence estimates, backpressure, checkpointed retries (ADR-0007) |
| R-6 | Scope (seven adapters, all Must) is large for one maintainer | Slow delivery | Vertical slice with two adapters first; the rest added one at a time behind the same conformance suite; open-source contributors can add adapters (NFR-MAINT-01) |
| R-7 | Research facts are dated 2026-10-12 and not re-verified here | Flags in TDD may be stale by implementation | Each adapter task starts by verifying against the installed CLI |
| R-8 | No per-run disk or CPU limits | A runaway agent fills the disk or starves the host | Timeouts, concurrency limits and retention for now; revisit in M3 with the outer-sandbox evaluation ([TDD §3.4](design/TDD.md#34-security-engineering)) |
| R-9 | MCP client identity over stdio is only as strong as the orchestrator's launch config (`serve --client <id>`) | A misconfigured orchestrator gets another client's trust ceiling | Keep ceilings low by default; `privileged` always needs operator approval (FR-POL-09) |
| R-10 | Claude Code has no documented native sandbox in the research | Claude may be ineligible for `test-sandboxed` (FR-POL-06); M2's two profiles are unaffected because they allow no arbitrary shell | Settle in M3 with the malicious-fixture suite; other adapters cover those profiles if needed |
| R-12 | A controller crash between spawning a provider process and committing its `pid`, `pgid` and start ticks leaves an orphan that startup reconciliation cannot find (LLD §8) | An unsupervised provider process may keep writing to a worktree until it exits; the run is still assessed and ended | Known limit of M1 (the pid is only known after spawn). **Proposed:** revisit with a launcher or cgroup-based tracking if it matters in M3 |
| R-13 | Container environments need the provider CLI's login inside the container, and FR-AUTH-01 forbids the controller copying or moving credentials | `container` projects may be unusable, or need a per-container native login | Proposed in-volume native login (Q-6, delegated); T10.0 verifies it; host environments unaffected (ADR-0013) |
| R-14 | The message sanitiser is a pattern list; attribution in unusual wording, or written into file contents, is not caught | Commits or files may carry a marker contrary to owner decision 7 | Fixtures of typical output; operator-added patterns; file contents out of scope by design; review of published commits (ADR-0014) |
| R-15 | In a `host` environment a same-user agent shell can read ambient Git credentials | An agent could push around the tool | Withhold the `push` tool there (FR-GIT-06, BR-31); no credentials in the agent environment; containers in M10 |
| R-16 | Removing provider attribution from commits may conflict with a provider's terms; not reviewed | Account or policy risk for the operator | Record the review in the compliance manifest notes (FR-POL-07); no compliance claim (NFR-COMP-01); the operator's call |
| R-17 | Provenance links to commits by SHA; an operator rebase or squash breaks the link | Gaps in the audit trail | Also store tree hash and patch ID (FR-GIT-07); best effort |
| R-18 | A per-run injected MCP channel may be impossible without a bypass flag, or blocked by a provider sandbox, for some providers | Those adapters fall back to controller-made commits | T9.0 spike; finalize-only mode (FR-GIT-09) |
| R-19 | The verified research documents no provider setting for commit behaviour or attribution, nor how to supply a per-run MCP definition | Provider-specific controls cannot be relied on until checked | The layered design does not depend on them (TDD §3.10); each adapter verifies against the installed CLI (T2.2, T9.0) |
| R-20 | An orchestrator that can create projects widens what a compromised or prompt-injected orchestrator can reach | New mounts, providers, ceilings or push rights through a project it created | `manage_projects` off by default; limits are the client's own; operator approval for containers, push and widening; creator-only visibility; every call recorded (FR-PRJ-10, HLD TB-9) |

### 7.2 Blockers

| ID | Blocker | Blocks | Unblocked by |
| --- | --- | --- | --- |
| B-1 | Kimi Code's current automation contract is not pinned | FR-ADP-09 | Moonshot documentation or a validated installed version |
| B-2 | *Resolved by delegation, 2026-10-12 (Proposed):* a rootless runtime and an in-volume native login, to be verified by T10.0. zemdregon left Q-6 to the agent; he has not approved the mechanism. | M10 (FR-PRJ-05, 07, 09) | T10.0 findings |

No blocker affects M1, M2 or M9.

### 7.3 Open questions for zemdregon (not blocking M2 unless noted)

| ID | Question | Default in force |
| --- | --- | --- |
| Q-1 | *Answered 2026-10-12:* built for zemdregon, published open source for others (owner decision 4). | — |
| Q-2 | *Answered 2026-10-12:* all seven held; Claude Code and Codex first (owner decision 5). | — |
| Q-3 | Do you prefer a language other than TypeScript? | TypeScript (ADR-0010); cheapest to change before M1 |
| Q-4 | Which orchestrator will you use first? | Any stdio MCP client (A-4) |
| Q-5 | `QUEUE_FULL` (bounded queue, FR-CAP-04) has no entry in the [LLD §4](design/LLD.md#4-failure-taxonomy) taxonomy; M1 raises it as an admission error before any row is written. Should it become a code (and which MCP error envelope), or map to an existing one? | Internal `LifecycleError` code `QUEUE_FULL`; to settle in T2.4 before the MCP error mapping |
| Q-6 | *Answered by delegation 2026-10-12 ("the rest you pick"):* a rootless OCI-compatible runtime, and the operator runs each provider's native login once inside the project's container volume (TDD §3.11). Not an owner decision. | — |
| Q-7 | *Answered 2026-10-12:* yes (owner decision 8). Gating delegated (FR-PRJ-10). | — |
| Q-8 | *Answered by delegation 2026-10-12 ("the rest you pick"):* the operator's own Git identity, copied explicitly into each context's configuration (TDD §3.10). Not an owner decision. | — |
| Q-9 | *Answered 2026-10-12:* yes (owner decision 9), read as push allowed and signing wanted. Push stays off until a context enables it; publish ref only, never the default branch; signing is controller-side (FR-GIT-10). | — |

## 8. Deferred and excluded work

| Item | Status | Reason | Requirement |
| --- | --- | --- | --- |
| Read-only usage dashboard | Deferred | Allowed by C-2 but not needed to deliver outcomes | FR-TEL-04 |
| Upstream ACP server | Deferred | MCP satisfies C-7 | ADR-0002 |
| Learned (contextual-bandit) routing | Deferred | Needs outcome data | FR-RTE-05 |
| OpenCode persistent `serve`/`attach` transport | Deferred | `opencode run` suffices first | FR-EXE-04 |
| Native Windows host | Deferred | Linux first | NFR-PORT-03 |
| HTTP/SSE MCP transport | Deferred | stdio fits local use | ADR-0002 |
| Automatic merge of result branches | Deferred | Needs judgement | ADR-0006 |
| Multi-user or hosted operation | Excluded | Compliance and credential risk | ADR-0011 |
| Context kinds other than `repository`; remote-clone contexts; multiple writable contexts in one run | Deferred | Not asked for yet; the schema is extensible | FR-PRJ-02 |
| Rewriting attribution inside file contents | Excluded | Out of the commit boundary; the controller does not edit what agents write | FR-GIT-04, R-14 |

## 9. Next actionable milestone

**M2 Claude Code and Codex adapters + MCP vertical slice.** Prerequisites: M1 is `Done` (§6). No M2 task needs a
provider login until the opt-in live smoke test (T2.6). Items that surfaced in M1 and must be handled in M2:

- **Version gating (ADR-0009).** `src/adapters/registry.ts` is a skeleton with no version gating or enablement hook.
  T2.1 and T2.2 add the manifest check, `ADAPTER_VERSION_UNVERIFIED` and enablement there, ahead of T2.3 eligibility.
- **`QUEUE_FULL` has no failure code** in LLD §4; see Q-5. Settle it before T2.4 maps lifecycle errors to MCP errors.
- **Idempotency keys** apply to new meta-sessions only (FRD §7.2 C6); T2.4 must not add a key to `continue_task`
  without changing the FRD and SRS first (see the LLD §3 note).
- **`serve`** (FR-OPS-01) must run reconciliation (`src/reconcile/`) before accepting MCP calls and call
  `applyOperatorRequests` (`src/cli/operator.ts`) for pending operator cancels.
- M1 `Partial` requirements in §6.1.1 (arm64 CI, secret scan beyond artifacts) should be closed alongside T2.x work.
- **Git write denial (FR-GIT-01).** T2.2 must show that no compiled invocation permits Git writes. Provider commit and
  attribution settings are not in the research; verify them against the installed CLI and record the result (R-19).
  M9 (projects and the injected commit and push tools) follows M3 and is sequenced before M4.

### 9.1 How an agent picks up work

1. Read [AGENTS.md](../AGENTS.md), then this roadmap's §6 to find the first milestone whose status is not `Done`.
2. Take the first task in that milestone's task table whose dependencies are done. If the milestone has no task table
   yet (M3 onward), break it into tasks in the same format first, from its row in §6 and the requirements it lists, and
   add them here before coding.
3. Read every reference in the task row: the SRS requirements, the FRD workflow or rule, the LLD/TDD section and the
   ADRs. Those are the contract; this roadmap only sequences them.
4. Implement with tests that prove the task's "Done when" checks and the cited requirements' verification method.
5. In the same change, update the task's status here with evidence, and fix any document the work proved wrong (or add
   an ADR if an architectural decision changed).
6. Run `node scripts/check-docs.mjs` and the test suite before opening the pull request.

## 10. Keeping this roadmap current

- Change status in §6 in the same change as the work, with evidence.
- New scope goes through the PRD and SRS first, then gets a milestone here.
- A conflict between documents is resolved in favour of the owner named in §5, and the losing document is corrected in
  the same change.
