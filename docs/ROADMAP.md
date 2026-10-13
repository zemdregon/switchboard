# Switchboard Roadmap

| Field | Value |
| --- | --- |
| Status | **Canonical.** Single source of truth for scope, priorities, dependencies, sequencing, status and completion criteria. |
| Does not own | Requirements ([SRS](requirements/SRS.md)), behaviour ([FRD](requirements/FRD.md)), design ([HLD](design/HLD.md), [SDD](design/SDD.md), [TDD](design/TDD.md), [LLD](design/LLD.md)), decision rationale ([ADRs](adr/README.md)). |
| Last reconciled | 2026-10-12 |
| Current milestone | M0 and M1 complete (M1 gaps `Partial` in §6.1). **M2: `Partial`**: T2.1 to T2.8 are implemented and tested on fakes and synthetic fixtures; not `Done` until the operator's live smoke run, a recorded Codex version, the NFR-PERF-02 decision and the FR-GIT-01 Git-write check added on main (§6.2, §6.2.1, §9). M9 and M10 (projects, controlled commits, containers) follow M3 |

## 1. How to use this roadmap

Read this first, then the documents it links for the milestone you are working on. Update the status column in §6 in the
same change that completes or blocks work, citing evidence (a test, a file path, a PR). Do not mark anything done
without evidence. Agent working rules are in [AGENTS.md](../AGENTS.md).

## 2. Product summary

**Purpose.** Switchboard is a local, headless controller that lets one primary AI orchestrator delegate coding tasks to
the operator's existing AI coding subscriptions (Claude Code, Codex, Grok Build, Antigravity, Cursor CLI, OpenCode, Kimi
Code, and since 2026-10-13 Muse Code) through each vendor's documented automation surface, behind one small MCP
tool interface. It owns policy,
workspace isolation, cross-provider task state, routing and capacity estimation, so the orchestrator does not have to.

**Users.** The *operator* (the account owner who installs Switchboard and logs in to each CLI; Ender first; Switchboard
is published as open source so anyone can run their own installation with their own subscriptions) and the
*orchestrator* (an MCP client agent such as OpenClaw or Grok Bot). See [PRD §2](requirements/PRD.md).

**Desired outcomes.** BO-1 to BO-8 in the [BRD](requirements/BRD.md): more work per paid subscription, no credential
handling, safe unattended runs, continuity across providers, visibility, resilience to CLI churn, agent work that
reaches the repository as ordinary commits with the audit record kept internally, and cheap text work handled by an
operator-chosen inner model instead of premium capacity.

**In scope.** Capabilities CAP-1 to CAP-12 in the [PRD](requirements/PRD.md), including projects (the environments
agents operate from and their contexts, CAP-10), controlled commits and publication (CAP-11) and the inner agent
(CAP-12). "Application" in this
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
| **Owner decision** | Explicitly decided by Ender. | Listed in §4.2 only. |
| **Stated intent** | Requirements stated in the original blueprint's introduction, which Ender supplied as the project brief. Treated as approved intent, not as approved design. | §4.3 |
| **Delegated decision** | Made by an agent during the 2026-10-12 planning task under Ender's delegation. Binding for implementation until revised, not owner-approved. | ADRs marked "Delegated", and §4.4 |
| **Assumption** | Conservative choice where information is missing. Must be confirmed or replaced. | §4.5 |

### 4.2 Owner decisions

1. The two research documents are project research for Switchboard (PRs #1 and #2, merged).
2. Agent work in this project routes model tiers by task difficulty (Haiku for simple, mechanical work; Opus or Fable
   only for demanding work). Recorded in [AGENTS.md](../AGENTS.md#subagent-routing-and-orchestration).
3. The documentation set and roadmap in this change were requested by Ender. Their *content* is delegated, not approved.
4. Switchboard is built for Ender's own use and published as open source so other people can run it with their own
   subscriptions (2026-10-12).
5. Ender holds every subscription named in the research. All seven providers must be integrated; Claude Code and Codex
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
   signing mechanism are delegated. Ender left Q-6 (container runtime and logins) and Q-8 (commit identity) to the agent,
   so those choices are delegated, not owner decisions.
<!-- markdownlint-disable-next-line MD029 -->
14. Switchboard has an *inner agent*: a self-hosted model, a cheap or free OpenCode model, or another model of the
    user's choosing, used for many cheap tasks so the main provider CLIs do not have to do them: commit and PR writing,
    task routing for auto mode, and other tasks the drafter judges to fit (2026-10-13). Recorded in
    [ADR-0016](adr/0016-inner-agent.md). Ender's wording covers only the product idea. Everything else is delegated and
    Proposed: the backend kinds, which tasks are in scope ([PRD §3.1](requirements/PRD.md#31-inner-agent-task-catalogue)),
    the rule that it has no authority over security or run status, validation, fallback, privacy and the M11
    placement. (Numbers 10 to 13 are used by the open M3 plan, PR #13.)
<!-- markdownlint-disable-next-line MD029 -->
15. Ender told the agent to go with its recommendations on Q-23 to Q-26 (2026-10-13): no hosted API key in
    Switchboard; M11 after M9; `draft_if_missing` for commit messages and PR drafts off unless enabled; the OpenCode
    `cli` kind stays Should until T11.0. The recommendations were already the defaults in force, so no requirement
    changed. They are now owner-chosen, not only delegated.
<!-- markdownlint-disable-next-line MD029 -->
16. Muse Code (Meta's `muse` CLI) is added to the provider support plan (2026-10-13). Ender said it is "not a must
yet", so FR-ADP-12 is `Should`, in M4 (Q-27 keeps the access question open). Evidence is third-party and unverified
    ([research note](research/muse-code-2026-10-13.md)); the adapter design is delegated.

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
documentation, so its technical findings win. Where the original carries Ender's *stated intent* (§4.3), the intent is
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
| [docs/adr/](adr/README.md) | Decision records | 16 accepted (13 and 14 record Ender's 2026-10-12 decisions and 16 his 2026-10-13 decision, mechanisms delegated; 15 is delegated) | Why each architectural decision was made |
| [docs/research/headless-ai-coding-controller-verified-2026-10-12.md](research/headless-ai-coding-controller-verified-2026-10-12.md) | Verified research | Current reference | Evidence for provider behaviour as of 2026-10-12 |
| [docs/research/headless-ai-coding-controller.md](research/headless-ai-coding-controller.md) | Original blueprint | **Superseded** where it conflicts (§4.6); retained for stated intent | Stated intent C-1 to C-7 only |
| `scripts/check-docs.mjs` | Documentation link and ID checker | Current | Mechanical consistency of this set |

## 6. Milestones

Status values: `Done`, `In progress`, `Partial`, `Planned`, `Blocked`, `Deferred`. No milestone has dates; none were
set. Sizes are not estimated. M9 and M10 were added on 2026-10-12 for owner decisions 6 and 7 (projects; tool-only
commits); M11 on 2026-10-13 for owner decision 14 (inner agent).

| ID | Milestone | Status | Depends on | Requirements delivered (first delivery) | Acceptance criteria | Verification |
| --- | --- | --- | --- | --- | --- | --- |
| M0 | Documentation baseline | In progress (this change); Done on merge | — | NFR-MAINT-02, NFR-COMP-01 | Document set in §5 exists; `node scripts/check-docs.mjs` passes; AGENTS.md points here | Docs check script; review |
| M1 | Foundation | **Done** (2026-10-12): every acceptance criterion has a passing test (166 tests locally); first CI run unconfirmed; requirement gaps marked `Partial` in §6.1 | M0 | FR-ADP-01, FR-AUTH-01, FR-POL-10, FR-WS-01–06, FR-SES-01, 02 (schema), 05 (events), FR-CAP-04 (queue, global limit), FR-EXE-01, 02, 05–07, FR-SES-06, FR-TEL-01, 03, FR-OPS-01 (`doctor`, `runs`), 03, 04, NFR-SEC-01, 02, 04–06, NFR-REL-01–02, NFR-PERF-03 (global), NFR-PORT-01, NFR-PRIV-01 | A fake provider CLI runs through the full lifecycle transactionally; cancel kills the process tree; `SIGKILL` of the controller mid-run followed by restart leaves a consistent ledger; a failed run that mutated files is rolled back, not replayed; CI green on Linux | Automated integration and fault-injection tests in CI; evidence in §6.1 |
| M2 | Claude Code and Codex adapters + MCP vertical slice | **Partial** (2026-10-12): T2.1 to T2.8 implemented with tests on fakes and synthetic fixtures (353 tests locally); not `Done`, see "Blocks Done" in §6.2. The FR-GIT-01 requirement and acceptance criterion were added to M2 on main (PR #11) after this work and are not yet shown | M1 | FR-MCP-01, 03–09, FR-ADP-02–04, 06, 11 (Claude Code, Codex), FR-POL-01 (two profiles), 02–05, 07, 08, FR-AUTH-02, FR-GIT-01 (Claude Code, Codex), FR-SES-03 (Claude Code, Codex), FR-RTE-01 (eligibility), FR-CAP-01 (record), FR-OPS-01 (`serve`), NFR-PERF-01, 02, NFR-OBS-01, NFR-PRIV-02, NFR-MAINT-03 | For each of Claude Code and Codex, a scripted MCP client delegates an edit task under `edit-untrusted`, polls to `SUCCEEDED`, retrieves a diff artifact and continues the same native session; a new user following the README reaches a passing `doctor`; missing login yields `AUTH_REQUIRED`; unknown CLI version yields `ADAPTER_VERSION_UNVERIFIED`; no bypass flag appears in any compiled invocation; no compiled invocation leaves a Git write operation (commit, ref change, push) permitted (FR-GIT-01) | Conformance suite on recorded fixtures in CI; one opt-in live smoke test run by the operator; argv inspection test |
| M3 | Isolation | Planned | M2 | FR-POL-01 (all), 06, 09, FR-WS-07, FR-EXE-08, FR-OPS-02 (`approve`, `deny`), NFR-SEC-03 (Claude Code, Codex), NFR-DATA-01 | Malicious-fixture suite shows no escape for each profile on Claude Code and Codex; `privileged` runs wait for `approve` and end `CANCELLED` on `deny`; verification commands run and are recorded; retention deletes artifacts, worktrees and branches together | Malicious-fixture suite; integration tests |
| M4 | Adapter expansion | Planned (Kimi Code part blocked by B-1; Muse Code is Should) | M3, M9 (Proposed) | FR-ADP-05, 07, 08, 09, 10, 11 (others), 12, FR-EXE-03, FR-OPS-02 (`adapters validate`), NFR-SEC-03 (others), NFR-MAINT-01, NFR-PORT-02 | Grok Build, Antigravity, Cursor and OpenCode adapters pass conformance and malicious-fixture suites; the test suite passes on macOS; Kimi Code passes once B-1 clears (M4 may be marked `Partial` until then, with only Kimi outstanding); ACP transport used where it is the adapter's chosen surface; adding an adapter touched only its own module, manifest, fixtures and registry entry; `adapters validate` accepts a new CLI version only after its live checks pass | Conformance and fixture suites per adapter; diff inspection |
| M5 | Continuity | Planned | M4 | FR-SES-02 (populated), 03 (all), 04, 05 (handoff view) | Provider A edits and tests; provider B continues from the handoff bundle and completes the task; no provider transcript file is opened (verified by file-access test) | End-to-end test with two fake adapters plus one opt-in live pair |
| M6 | Capacity and resilience | Planned | M5 | FR-MCP-02 (`get_capacity`), 10, FR-CAP-01 (use), 02–07, FR-OPS-05, NFR-PERF-03 (per provider) | Injected rate-limit, overload, quota and crash failures produce the behaviour in FRD WF-5, with successor runs linked to their predecessors; `get_capacity` and `switchboard capacity` never return `explicit_remaining` unless the provider reported it | Fault-injection tests with fake adapters |
| M7 | Routing | Planned | M6 | FR-MCP-02 (`explain_route`), FR-RTE-01 (full), 02–04 | Given stored features and weights, re-running the scorer reproduces every stored decision; `explain_route` lists the deciding factors | Deterministic replay test |
| M8 | Hardening | Planned | M7 | FR-TEL-02 | OTel traces reach a test collector with no forbidden attributes; a scheduled version canary on the operator's machine flags CLI updates before they reach routing | Collector test; version-bump test |
| M9 | Projects and controlled commits | Planned. Numbered after M8 to keep existing milestone IDs stable; **sequenced after M3 and before M4** (Proposed) so new adapters declare their Git controls once | M3 | FR-PRJ-01–04, 06, 08, 10, FR-GIT-01 (fixtures), 02–10, FR-WS-05 (publication) | A scripted MCP client lists projects and delegates to one (`host` environment, one repository context) and the lower of client and project ceilings applies; the agent's `commit` tool call produces a commit on the publish ref with the configured identity and no trailer, footer or identifier even when the message contains them; an agent attempt to commit, move a ref or push (shell or provider built-in) leaves nothing on the publish ref and appears as `git_policy_violation`; with push `none` nothing leaves the host, with `branch` against a local bare remote only the publish ref arrives and never checkpoint commits or run branches; every published commit has a `git_commit` row naming run, provider and model; a client with `manage_projects` can create a `host` project within its limits and use it, a `container` or push-enabled revision stays unusable until `projects approve`, and a client without the flag has no project-management tools; with `sign: true` the published commit verifies against the operator's key and a failed signature creates no commit; adapters that cannot take the channel without a bypass flag run in finalize-only mode only on opt-in | Fake-adapter integration tests with real Git repos and a local bare remote; sanitiser fixtures; malicious-fixture additions for Claude Code and Codex; argv inspection |
| M10 | Container environments | Planned; B-2 resolved by delegation (Proposed), starts with a spike | M9 | FR-PRJ-05, 07, 09 | A `container` project mounts only the run worktree and declared read-only contexts, applies its limits and network policy, and is removed at run end and after a controller crash; no home directory, data directory, push credential or runtime socket is mounted; the container leg of the malicious-fixture suite shows no escape | Opt-in container integration tests (skipped in CI until a runtime is chosen); fault injection; inspection of mounts |
| M11 | Inner agent | Planned (Proposed). Owner decision 14; numbered after M10 to keep milestone IDs stable; **sequenced after M9** (Proposed). Tasks that use another milestone's output wait for it (§6.6) | M2 (configuration, ledger); M9 for commit and PR tasks; M3, M4, M5, M7 for the tasks that use them | FR-INN-01–17 | With no inner agent configured nothing changes and the suite passes; with a fake backend, enabled tasks are used and invalid, empty, slow or unreachable output falls back without failing or delaying a run beyond the bound; a commit with no agent message gets a sanitised drafted message with no trailer, footer or identifier even when the backend returns them; inner usage never appears in provider usage or capacity unless a shared subscription is declared; a `remote` backend needs `allow_remote` and diffs need the per-task opt-in, and a planted secret never reaches a captured prompt; no inner output reaches any policy component; `doctor` and `inner status` report state | Fake-backend integration and fault-injection tests; hostile-backend sanitiser fixtures; import-boundary test; secret-in-prompt test; inspection of the privacy gates; one opt-in live run against an operator-chosen backend |

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

Status (2026-10-12), per task. Evidence is local (`npm test`: 22 files, 353 tests, plus build, typecheck, lint and
`node scripts/check-docs.mjs`); the first CI run on this branch is unconfirmed. Every provider-facing result below is on
fakes or **synthetic** fixtures; nothing has run against a real Claude Code or Codex binary.

| Task | Status | Evidence | Caveat |
| --- | --- | --- | --- |
| T2.1 | Done on fixtures | `src/adapters/manifest/manifest.test.ts` ("shipped manifests", "version gate", "AdapterRegistry.gate": unknown version yields `ADAPTER_VERSION_UNVERIFIED`); manifests in `src/adapters/manifests/` | The Codex range is intentionally empty (`<0.0.0`), so Codex fails the gate (Q-12) |
| T2.2 | Partial: done on synthetic fixtures, except the FR-GIT-01 check | `src/adapters/claude/claude.test.ts` ("claude compile: argv policy", "claude conformance on recorded (synthetic) fixtures", probe and auth); `src/adapters/codex/codex.test.ts` ("Codex conformance suite", "compile: argv and policy", "probe (FR-ADP-02 steps 1-5)"); [ADR-0015](adr/0015-claude-untrusted-isolation-flags.md) | Event shapes and flags unverified (R-21, R-22, Q-10, Q-13); probe skips the FR-ADP-02 smoke step. The "no permitted Git write operation" check (FR-GIT-01) was added to T2.2 on main (PR #11) after this work; no test shows it yet (Blocks Done item 4) |
| T2.3 | Done | `src/routing/routing.test.ts` ("eligibility filter (T2.3, FR-RTE-01, FR-MCP-05)": disabled, ceiling, binary missing, version, no manifest, auth, capability, shell allowlist, platform, `require_provider`) | Hard constraints available in M2 only |
| T2.4 | Done against the fake adapter and replay fixtures | `src/mcp/mcp.test.ts` ("tool surface", "vertical slice against the fake adapter", "Claude and Codex adapters on recorded replay fixtures", "validation", "per-client trust ceiling", "idempotency", "cancel_run", "dispatch-time gate") | Claude runs use replay fixtures (synthetic); Codex end to end only with test doubles for version and auth |
| T2.5 | Done | `src/usage/usage.test.ts` ("usageObservationsFromEvents", "usage_observation ledger helpers": `provider_reported` label, append-only, no estimates); `src/mcp/mcp.test.ts` ("usage in get_run (T2.5)") | Codex usage event shape is an Assumption |
| T2.6 | Done on fakes; live run not performed | `src/cli/serve.test.ts` (stdio framing, end to end, lock, SIGKILL reconcile, operator cancel, SIGTERM, refuses to start); `test/live-smoke.test.ts` and `scripts/live-smoke.mjs` (`npm run test:live`, skipped unless `SWITCHBOARD_LIVE_TESTS=1`) | The operator has not run the live test (see "Blocks Done") |
| T2.7 | Done, on the fake adapter | `scripts/bench-perf.mjs` (`npm run bench`); results and findings in [TDD §3.6.1](design/TDD.md#361-controller-overhead-benchmark-t27) | Target confirmed for controller-owned work only, on a sandbox host (see §6.2.1) |
| T2.8 | Partial | `README.md` (install, native login, config, profiles, `doctor`, serve, live smoke, troubleshooting); `doctor` behaviour in `src/cli/cli.test.ts` | "A fresh machine reaches a passing `doctor`" is verified only for the no-provider case (see "Blocks Done") |
| Policy (cross-task) | Done | `src/policy/policy.test.ts` ("resolveProfile (COMP-POL, M2)": two profiles, frozen snapshots, no `privileged`, fail closed, no bypass flag on Claude or Codex) | FR-POL-01 (all profiles) is M3 |

**Blocks Done.** M2 stays `Partial` against its acceptance criteria because:

1. The opt-in live smoke test (`npm run test:live`) has not been run by the operator against real Claude Code or Codex.
   Event shapes, error categories, flag spellings and auth behaviour are therefore unconfirmed (R-21, R-22, Q-10, Q-13),
   and the criteria "polls to `SUCCEEDED`, retrieves a diff artifact and continues the same native session" and
   "missing login yields `AUTH_REQUIRED`" are shown on fakes and synthetic fixtures only.
2. The Codex manifest range is empty, so Codex cannot pass the version gate or `doctor` until an operator records a real
   `codex --version` (Q-12). No command exists to record one: `adapters validate` is scheduled for M4 (FR-OPS-02).
3. "A new user following the README reaches a passing `doctor`" is verified only for the no-provider case (both
   providers `[warn]`, exit 0, which proves the environment and config only). A machine with a provider installed has
   not been checked, and an installed Codex fails `doctor` by design today.
4. FR-GIT-01 (Claude Code, Codex) and the M2 criterion "no compiled invocation leaves a Git write operation (commit,
   ref change, push) permitted" were added on main (PR #11) after T2.2 was written. No argv test asserts it yet, and
   `edit-untrusted` (Codex workspace write; a Claude shell allowlist entry the operator configures) has not been
   checked for Git writes. Provider commit and attribution settings are verified against the installed CLI (R-19).

Criteria met on fakes or fixtures: "unknown CLI version yields `ADAPTER_VERSION_UNVERIFIED`" (manifest, routing, MCP and
`doctor` tests) and "no bypass flag appears in any compiled invocation" (argv tests in `claude.test.ts`, `codex.test.ts`,
`policy.test.ts`).

#### 6.2.1 M2 requirements that are Partial or unowned

| Requirement | Status | Gap and reason |
| --- | --- | --- |
| NFR-PERF-02 (Must, M2) | **Not implemented; no roadmap task owns it** | Preflight (`probe`, `authPreflight`) is uncached and runs live in `delegate_task`, at dispatch and in `list_capabilities` ([TDD §3.6.1](design/TDD.md#361-controller-overhead-benchmark-t27)). T2.7 only measured it. **Proposed task for Ender to decide** (see Q-14); no milestone is assigned here |
| NFR-PERF-01 | Partial | The proposed 2 s p95 target is confirmed for controller-owned work on the fake adapter in a sandbox container only (about 0.34 s p95 uncached); real provider probe cost and a reference machine are unmeasured |
| NFR-SEC-04 | Partial | `serve` does not refuse to run as root and nothing records a review; still inspection-only, as in §6.1.1 |
| FR-ADP-02 | Partial | The probes cover binary, version, command, flags and (separately) auth; the harmless structured-output smoke test (step 7) is skipped by the probes |
| FR-ADP-03, FR-ADP-04, FR-ADP-06, FR-ADP-11 (Claude Code, Codex) | Partial | Tested on synthetic fixtures only; unconfirmed against live CLIs (R-21, R-22, Q-13) |
| FR-AUTH-02 | Partial | Claude parses `auth status --json` (assumed shape); Codex returns `UNKNOWN` because no status command is documented, so Codex is ineligible (Q-10) |
| FR-POL-02 (Codex) | Partial | Codex has no documented shell allowlist or model flag in the adapter's sources; it returns `Ineligible` for those requirements (Q-11, settled in M3) |
| FR-OPS-01 (`serve`) | Partial | `serve` is implemented and tested (`src/cli/serve.test.ts`, including refusing to start when the ledger cannot be opened) but has not been run against a live provider, and has no root check (NFR-SEC-04) |
| FR-GIT-01 (Claude Code, Codex) | **Not shown** | Added to M2 on main (PR #11) after T2.2; no test proves that compiled invocations deny Git writes (Blocks Done item 4) |
| Compile-time `Ineligible` in the lifecycle | Partial | After preflight, `src/lifecycle/lifecycle.ts` still ends a run on an adapter `Ineligible` from `compile` with `PERMISSION_BLOCKED`, not the [FRD BR-3](requirements/FRD.md#3-business-rules) code. The eligibility filter calls `compile` earlier and uses the BR-3 codes, so this path is a race-only fallback. Not changed here |

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

### 6.6 M11 Inner agent: tasks

*Proposed breakdown, written when M11 was added; revisit when M9 completes.* Design: [ADR-0016](adr/0016-inner-agent.md),
[LLD §13](design/LLD.md#13-inner-agent), [TDD §3.12](design/TDD.md#312-inner-agent), [PRD
§3.1](requirements/PRD.md#31-inner-agent-task-catalogue). Order of delivery: the core and the `http` backend first, then
the commit-message task (the highest-value one), then the others as the milestones they need complete. No task here may
call a live model in the default test run.

| Task | Objective | References | Depends on | Done when |
| --- | --- | --- | --- | --- |
| T11.0 | Spike: on the installed OpenCode, find whether a one-shot `opencode run` with an operator-chosen model can be run with no tools, an empty working directory and no repository config. Record the flags verified, or record that it cannot and mark the `cli` kind `Ineligible` | FR-INN-04, Q-26, [R2] OpenCode | — | The result and the checked flags are written into TDD §4.6 with the version and date, or the limitation is recorded and FR-INN-04 re-prioritised |
| T11.1 | Config schema for `inner_agent`, the backend port, a scripted fake backend, the `inner_call` table, the disabled-by-default path, and the import-boundary test | FR-INN-01, 02, 05, 06, LLD §13.1–13.3 | M2 | Config rejects unknown keys and a credential-looking value; with no section the suite behaves as before; a test fails if COMP-POL, an adapter's profile compiler, the retry logic or the push path imports the inner-agent service |
| T11.2 | Call pipeline: redaction, input budget, call, schema validation, one re-ask, per-call timeout, circuit breaker, fallback result, `inner_call` and run events | FR-INN-07, 08, 16 (redaction, no body logging), LLD §13.4 | T11.1 | Fake-backend tests: invalid, empty, oversized, slow, erroring and non-UTF-8 outputs all fall back within the bound; breaker opens and probes; a planted secret never appears in the captured prompt or in any log |
| T11.3 | `http` backend, locality classification, `allow_remote`, `allow_source_content`, project and context `inner_agent` override | FR-INN-03, 16, LLD §13.2, §13.5, [LLD §11](design/LLD.md#11-projects-contexts-and-environments) | T11.2, T9.1 | Against a local fake HTTP server: a `remote` backend is refused without opt-in, diffs are refused without the per-task opt-in, `local_only` and `off` projects never call a remote backend |
| T11.4 | Commit-message task: optional `message` on the `commit` tool, modes `draft_if_missing`, `always`, `never`, prompt without identifiers, sanitiser on the result, provenance note | FR-INN-10, FR-GIT-04, [LLD §12.1](design/LLD.md#121-tool-contracts), [LLD §12.4](design/LLD.md#124-message-sanitisation) | T11.2, T9.3, T9.4 | A hostile fake backend returning `Co-authored-by:` lines, a run ID and a "generated by" footer yields a clean commit; empty or unavailable output returns the tool error and no commit; the agent's own message wins in the default mode |
| T11.5 | Usage accounting: `inner_call` records only, nothing in `usage_observation` or capacity; `shares_subscription_with` observation and the `doctor` warning | FR-INN-15, ADR-0007 | T11.1 | `get_capacity` and the estimator are byte-identical with and without inner calls; with the flag set, one labelled observation per call appears |
| T11.6 | Quality monitoring and automatic suspension | FR-INN-09 | T11.2 | Rejection rate above the configured threshold over the window suspends the task, which then falls back until re-enabled |
| T11.7 | `doctor` inner-agent section, `inner status`, `inner test` with the built-in fixture | FR-INN-17 | T11.3, T11.6 | Plain-text and `--json` output; `inner test` sends no repository data (asserted on the captured prompt) |
| T11.8 | PR-draft task and the `pr_draft` artifact kind | FR-INN-11, [LLD §3](design/LLD.md#3-mcp-tool-contracts) | T11.4 | Draft passes the sanitiser; Switchboard makes no call to any pull-request API (test asserts no such client exists) |
| T11.9 | Log and verification-output summary | FR-INN-13, FR-EXE-08 | T11.2, M3 | Statuses, exit codes and counts in the envelope come from records in every test; the summary carries a source label and a raw-artifact pointer; fallback is deterministic head and tail |
| T11.10 | Handoff-bundle condensation | FR-INN-13, FR-SES-04 | T11.2, M5 | Structured bundle fields are identical with and without the inner agent; condensed fields are labelled and link to raw artifacts |
| T11.11 | Routing classification feature | FR-INN-12, FR-RTE-04, ADR-0008 | T11.2, M7 | Stored feature with source, model and template version; replay reproduces the decision with the backend off; the feature never changes eligibility or `require_provider` |
| T11.12 | Run title and one-line summary (Could) | FR-INN-14 | T11.2 | Length cap and control-character stripping tested |
| T11.13 | `cli` backend using OpenCode (Should) | FR-INN-04, FR-ADP-08, FR-ADP-03 | T11.0, M4 (OpenCode adapter and manifest) | Runs only on a version inside the manifest range and only with the verified tool-free flags; otherwise reports `Ineligible`; no bypass flag in argv (argv audit) |
| T11.14 | Update the README (configuration, privacy, `doctor`, `inner`), roadmap status and any document the work proved wrong | NFR-MAINT-02, NFR-MAINT-03 | T11.1–T11.8 | §6 shows M11 with status and links to tests |

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
| R-21 | Claude stream-json event shapes and error category strings are unverified; the adapter was written against `claude --help` 2.1.296 text and synthetic fixtures (`src/adapters/claude/parse.ts`; [ADR-0015](adr/0015-claude-untrusted-isolation-flags.md)) | Misparsed events or misclassified failures on a real CLI | Live smoke test (T2.6) before M2 is called done; classify unknown shapes as `OUTPUT_PROTOCOL_ERROR`, never success |
| R-22 | Codex event shapes and the `--sandbox read-only` spelling are unverified (`src/adapters/codex/protocol.ts`); no Codex binary was available | Misparsed events, or a sandbox flag that does not mean what the adapter assumes | Live smoke test (T2.6); the probe requires the flags in `codex exec --help` |
| R-27 | *Proposed (owner decision 14).* A cheap model writes a vague, wrong or misleading commit message or PR draft, and it enters published history | Poor history; reviewers misled | Agent text wins by default; sanitiser and non-empty check (FR-INN-10); `inner status` shows rejection rates and suspension (FR-INN-09); `never` mode; the provenance record notes the drafting source |
| R-28 | *Proposed.* Repository content or an orchestrator's request contains prompt injection aimed at the inner model | A bad draft, a misleading title or summary, or a skewed routing feature | The inner agent has no authority (FR-INN-06), no tools (FR-INN-02), validated output (FR-INN-07), and routing features cannot touch eligibility (FR-INN-12) |
| R-29 | *Proposed.* Source code or logs are sent to a `remote` inner backend that the operator or the provider may retain or train on; deterministic redaction misses a secret | Data leaves the host from the controller itself | `local`/`remote` classification, `allow_remote`, per-task `allow_source_content`, per-project `local_only`, redaction before every call, no body logging (FR-INN-16); the examples default to local |
| R-30 | *Proposed.* A condensed handoff or log summary drops or invents a fact, and the next agent or the orchestrator trusts it | Wasted work or a wrong conclusion | Additive and labelled, raw artifact pointers, statuses from records only, the next agent still inspects the repository (FR-INN-13) |
| R-31 | *Proposed.* The inner backend draws on the same subscription as a routed provider (for example a Claude Code or OpenCode login also used for coding) | Capacity estimates are blind to real consumption; the saving is lost | `shares_subscription_with` records an `inner_agent` observation and `doctor` warns (FR-INN-15) |
| R-32 | *Proposed.* Model or server churn changes output quality or format under a fixed prompt template; the `cli` kind's flags change (as R-1) | Rising fallback rates, silent quality drift | Versioned templates, per-task outcome records and suspension (FR-INN-05, 09), `inner test`; the `cli` kind is version-gated (FR-INN-04) |
| R-33 | *Proposed (owner decision 16).* Muse Code facts come from a third-party user report and an SDK crate, not Meta's documentation; the CLI self-updates hourly and its flags (`--yolo`, `-w`, `--approval-mode`), JSONL kinds, auth precedence (`META_API_KEY` first) and trust gating are unverified; exit code 0 does not mean success | A misbuilt adapter, a bypass flag emitted, or a stale fixture | Version gate and `MUSE_NO_AUTO_UPDATE=1` if confirmed (ADR-0009); `--yolo` and its parts in the argv audit; never pass `META_API_KEY`; read Meta's docs and capture `echo`-provider fixtures before M4 code; success judged by records and verification (BR-16) |

### 7.2 Blockers

| ID | Blocker | Blocks | Unblocked by |
| --- | --- | --- | --- |
| B-1 | Kimi Code's current automation contract is not pinned | FR-ADP-09 | Moonshot documentation or a validated installed version |
| B-2 | *Resolved by delegation, 2026-10-12 (Proposed):* a rootless runtime and an in-volume native login, to be verified by T10.0. Ender left Q-6 to the agent; he has not approved the mechanism. | M10 (FR-PRJ-05, 07, 09) | T10.0 findings |

No blocker affects M1, M2 or M9.

### 7.3 Open questions for Ender (not blocking M2 unless noted)

| ID | Question | Default in force |
| --- | --- | --- |
| Q-1 | *Answered 2026-10-12:* built for Ender, published open source for others (owner decision 4). | — |
| Q-2 | *Answered 2026-10-12:* all seven held; Claude Code and Codex first (owner decision 5). | — |
| Q-3 | Do you prefer a language other than TypeScript? | TypeScript (ADR-0010); cheapest to change before M1 |
| Q-4 | Which orchestrator will you use first? | Any stdio MCP client (A-4) |
| Q-5 | `QUEUE_FULL` (bounded queue, FR-CAP-04) has no entry in the [LLD §4](design/LLD.md#4-failure-taxonomy) taxonomy. **Resolved for M2 (Proposed, Delegated; not owner-approved):** MCP maps it to `ELIGIBILITY_NONE` with `details.reason = "QUEUE_FULL"` (`src/mcp/mcp.test.ts`, "a full ingress queue maps to ELIGIBILITY_NONE with reason QUEUE_FULL"). A dedicated code needs an [LLD §4](design/LLD.md#4-failure-taxonomy) and [SRS](requirements/SRS.md) decision first | `ELIGIBILITY_NONE` with `details.reason` `QUEUE_FULL`; internal `LifecycleError` code stays `QUEUE_FULL` |
| Q-6 | *Answered by delegation 2026-10-12 ("the rest you pick"):* a rootless OCI-compatible runtime, and the operator runs each provider's native login once inside the project's container volume (TDD §3.11). Not an owner decision. | — |
| Q-7 | *Answered 2026-10-12:* yes (owner decision 8). Gating delegated (FR-PRJ-10). | — |
| Q-8 | *Answered by delegation 2026-10-12 ("the rest you pick"):* the operator's own Git identity, copied explicitly into each context's configuration (TDD §3.10). Not an owner decision. | — |
| Q-9 | *Answered 2026-10-12:* yes (owner decision 9), read as push allowed and signing wanted. Push stays off until a context enables it; publish ref only, never the default branch; signing is controller-side (FR-GIT-10). | — |
| Q-10 | Codex auth preflight returns `UNKNOWN` because no status command is documented (R2, TDD §4.2), so Codex runs are `ELIGIBILITY_NONE` until a status mechanism is verified. Which mechanism should be used, if any? | Ineligible (fail closed, NFR-SEC-06); a structured auth error mid-run still ends `AUTH_REQUIRED` |
| Q-11 | Codex has no documented shell allowlist or model flag in the adapter's sources, which may conflict with FR-POL-02 (and the model constraint). Settle whether Codex meets FR-POL-02 or is limited to read-only profiles | Adapter compiles only what it can express and returns `Ineligible` otherwise; to settle in M3 |
| Q-12 | The Codex manifest range is empty, so every Codex binary is `ADAPTER_VERSION_UNVERIFIED`. Which `codex --version` will the operator validate? | Fail closed until the operator records one (T2.1 note, `adapters validate`) |
| Q-13 | Are the Claude and Codex assumptions in R-21 and R-22 correct on real CLIs? | Unconfirmed; the opt-in live smoke test (T2.6) must confirm or correct each, and the fixtures and TDD §4.1–4.2 are updated with the result |
| Q-14 | NFR-PERF-02 (Must, M2: cache adapter preflight, invalidate on binary version change or a configurable TTL) is unimplemented and no task owns it. Should it become a task, and in which milestone? **Proposed:** a task to add the cache in the probe and auth path used by `delegate_task`, dispatch and `list_capabilities`, with a version-change invalidation test | None; the requirement stays unmet and M2 stays `Partial` until Ender decides |
| Q-23 | *Answered 2026-10-13:* no. Hosted-model keys stay outside Switchboard (local gateway or the `cli` kind), as proposed (owner decision 15). | — |
| Q-24 | *Answered 2026-10-13:* M11 after M9, core, `http` backend and commit-message task first, as proposed (owner decision 15). | — |
| Q-25 | *Answered 2026-10-13:* `draft_if_missing` with the agent's text winning; PR drafts are Should and off unless enabled, as proposed (owner decision 15). | — |
| Q-26 | *Answered 2026-10-13* by taking the proposal: the `cli` kind stays Should and `Ineligible` until the T11.0 spike verifies a tool-free one-shot (owner decision 15). The technical question itself is still open. | — |
| Q-27 | *Partly answered 2026-10-13:* Ender said Muse Code is "not a must yet", so FR-ADP-12 stays `Should` (owner decision 16). Still open: does Ender hold Meta access, and by which login (device-code `muse login`, or an API key, which Switchboard cannot pass)? | `Should`, M4; no adapter work depends on it before M4 (FR-ADP-12) |

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
| Model-assisted secret or PII redaction (inner agent) | Deferred | A miss is a silent leak and sending content to find secrets is itself exposure; deterministic redaction stays the control. Revisit as an add-only advisory pass on a `local` backend | FR-INN-18 |
| Inner agent exposed to orchestrators as a tool | Excluded | Makes Switchboard a model proxy and widens TB-1; no requirement behind it | ADR-0016 |
| Inner-agent tasks IT-10 to IT-14 (prompt rewriting, test selection, diff pre-review, commit splitting, changelogs) | Deferred or excluded | Each changes intent, verification or authority, or has no requirement; see [PRD §3.1](requirements/PRD.md#31-inner-agent-task-catalogue) | — |

## 9. Next actionable milestone

**Close M2, then M3.** M2 is `Partial` (§6, §6.2). Its code and documentation are in place; the remaining work needs the
operator or Ender, in this order:

1. **Operator live smoke run.** Run `SWITCHBOARD_LIVE_TESTS=1 SWITCHBOARD_LIVE_PROVIDER=claude npm run test:live` (and
   `codex`) with native logins. Record which assumptions held; correct the fixtures, TDD §4.1 to §4.2, R-21, R-22,
   Q-10 and Q-13 with the result.
2. **Codex version (Q-12).** Record a real `codex --version` in the Codex manifest range. There is no command for this
   yet (`adapters validate` is M4), so it is a reviewed manifest edit that must follow a passing live check.
3. **NFR-PERF-02 decision (Q-14).** Ender decides whether and where the preflight cache is scheduled.
4. Re-run `doctor` on a machine with a provider installed and update the "Blocks Done" list in §6.2.
5. **Git write denial (FR-GIT-01; agent work).** Add the T2.2 argv check that no compiled invocation permits Git
   writes. Provider commit and attribution settings are not in the research; verify them against the installed CLI and
   record the result (R-19).

Then start **M3 Isolation** (§6), breaking it into tasks first (§9.1). Notes carried from M2:

- **`QUEUE_FULL`** maps to `ELIGIBILITY_NONE` with a reason (Q-5, Proposed); a dedicated code needs an LLD §4 and SRS
  change.
- **Idempotency keys** apply to new meta-sessions only (FRD §7.2 C6); `continue_task` rejects a key.
- **Compile-time `Ineligible`** in the lifecycle still ends `PERMISSION_BLOCKED` (§6.2.1).
- M1 `Partial` requirements in §6.1.1 (arm64 CI, secret scan beyond artifacts) remain open, as does NFR-SEC-04 for `serve`.
- M9 (projects and the injected commit and push tools) follows M3 and is sequenced before M4.

### 9.1 How an agent picks up work

1. Read [AGENTS.md](../AGENTS.md), then this roadmap's §6 to find the first milestone whose status is not `Done`. A
   `Partial` milestone is closed from its "Blocks Done" list before the next one starts.
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
