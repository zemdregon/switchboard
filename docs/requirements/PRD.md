# Product Requirements Document (PRD)

| Field | Value |
| --- | --- |
| Status | Draft, baseline for milestone M1 |
| Owns | Target users, use cases, user journeys UJ-1..UJ-13, capabilities CAP-1..CAP-17 and their priorities, the product surface, non-goals, and product-level acceptance criteria per capability. |
| Does not own | Business outcomes ([BRD](BRD.md)); requirements ([SRS](SRS.md)); workflows and business rules ([FRD](FRD.md)); milestone scope and status ([ROADMAP](../ROADMAP.md)); components ([HLD](../design/HLD.md)). |
| Last reconciled | 2026-10-14 |

Acceptance criteria are conditions to be checked when the named milestone delivers. Status note (2026-10-13): this
document no longer describes a documentation-only repository. Milestone M1 is done and M2, M3 and M9 are `Partial`
([ROADMAP §6](../ROADMAP.md#6-milestones)); the roadmap owns what is implemented. CAP-9 as written lists commands
that do not exist yet: `adapters validate` is owned by milestone M4 (FR-OPS-02) and `capacity` by milestone M6
(FR-OPS-05), both `Planned` in the ROADMAP §6 table. `serve`, `doctor`, `runs`, `approve`, `deny`, `gc`, `git push` and
`projects list|show|validate|approve` exist today. The requirement text is unchanged.

## 1. Product overview

Switchboard is a headless controller that sits between a primary orchestrating agent (for example OpenClaw or Grok
Bot) and up to eight AI coding CLIs: Claude Code, Grok Build, Antigravity (`agy`), Codex, Cursor CLI, OpenCode, Kimi
Code and, since 2026-10-13, Muse Code from Meta (FR-ADP-12). It exposes a small MCP tool surface, runs the chosen CLI
through its documented headless mode inside an isolated workspace under a named trust profile, and keeps its own
record of the work so tasks can move between providers. It never logs in to a provider and never handles credentials
([ADR-0003](../adr/0003-no-credential-handling.md)). It may also hand cheap, low-stakes text tasks to an *inner agent*
the operator chooses, so the provider CLIs keep their capacity for coding (CAP-12). It keeps a project on one provider
and model and can index a project's files, so provider prompt caches stay warm and agents are sent less context (CAP-6,
CAP-7, CAP-13). The business case is in the
[BRD](BRD.md); the stated intent comes from the introduction of the [original
blueprint](../research/headless-ai-coding-controller.md) (superseded on technical details by the [verified
research](../research/headless-ai-coding-controller-verified-2026-10-12.md)).

## 2. Target users

| User | Description | Needs |
| --- | --- | --- |
| Operator | The human who installs Switchboard, logs in to each provider with its native CLI, configures policy and allowed workspace roots, and reviews results. zemdregon first; as an open-source project, anyone running their own installation ([ADR-0011](../adr/0011-single-operator-local-deployment.md)). | A reliable setup check, clear explanations when something is unavailable, visibility of runs, routing reasons and usage, control over privileged runs, and a safe path when a provider CLI updates. |
| Orchestrator agent | A machine client (for example OpenClaw, Grok Bot) that spawns the controller and calls its MCP tools. | A small, stable tool set; compact results; one error code per failure; asynchronous runs with bounded waits; no way to exceed its permitted trust level. |

Switchboard is open source ([BRD §8](BRD.md#8-personal-tool-and-open-source-project)): other operators are people like
zemdregon who install it on their own machines with their own subscriptions. There are no shared or hosted users.

## 3. Capabilities

Priorities are MoSCoW as in [SRS §1](SRS.md#1-conventions). Milestones are defined in the
[ROADMAP](../ROADMAP.md#6-milestones). The last column mirrors the capability table at the end of [SRS
§7](SRS.md#7-traceability).

| ID | Capability | Description | Priority | Target milestone | BO served | SRS requirement groups |
| --- | --- | --- | --- | --- | --- | --- |
| CAP-1 | Task delegation via MCP | The orchestrator delegates a task with objective, workspace, constraints and trust profile, gets a `run_id` and `meta_session_id` at once, and polls or waits a bounded time for a compact result. | Must | M2 (vertical slice); verification commands M3 | BO-1 | FR-MCP-01, 03–10, FR-EXE-01–02, 05–09 |
| CAP-2 | Provider adapters with version/auth preflight | One adapter per provider translates requests to documented headless modes and normalizes structured output. Preflight checks binary, version, auth, flags and a smoke call; unvalidated versions are ineligible. | Must, all seven (Kimi Code blocked until its contract is pinned) | M1 (contract and fake adapter), M2 (Claude Code, Codex), M4 (others) | BO-1, BO-2, BO-6 | FR-ADP-01–11, FR-AUTH-02 |
| CAP-3 | Policy and trust profiles | Five named trust profiles compiled into each adapter's native controls, with no automatic bypass flags, no loading of repository-supplied agent config under untrusted profiles, and per-client maximum trust. | Must | M2 (`inspect-untrusted`, `edit-untrusted`); M3 (remaining profiles) | BO-2, BO-3 | FR-POL-01–10, FR-MCP-06 |
| CAP-4 | Workspace isolation | Write-capable runs execute in a controller-created Git worktree from a recorded checkpoint, with one write lease per worktree, post-run checkpoints and diffs, rollback, and no remote pushes except through controlled publication (CAP-11). Concurrent runs of one project each get their own worktree and lease (owner decision 42), and worktrees of concurrent runs are removed on merge or abandon once FR-WS-09 is accepted. | Must | M1 (retention and GC M3; per-project concurrent worktrees M9) | BO-3, BO-4 | FR-WS-01–11 |
| CAP-5 | Meta-sessions and cross-provider continuity | A controller-owned task record outlives any provider session. Continuing on the same provider uses native resume; continuing elsewhere uses a handoff bundle built from controller evidence. | Must | M1 (schema, events), M2 (Claude resume), M5 (all adapters, handoff) | BO-4 | FR-SES-01–06 |
| CAP-6 | Routing with explanation | Hard eligibility filtering first, then weighted scoring; every decision persisted and explainable; routing hints can only narrow the choice. Sticky affinity (owner decision 40): a project stays on its last provider and model, and moves only for a listed reason (user request, capacity exhausted, ineligible, failed after retry), never for a better score, so provider prompt caches are not needlessly lost. Model groups (owner decision 57, Proposed): the operator names groups of models across providers (for example a low-cost and a flagship group), the orchestrator asks for a group or for one model, and routing picks an eligible member by availability and usage headroom; groups are configuration, never a quality claim. | Must (eligibility, model groups); Should (heuristic classifier); learned routing Deferred | M2 (eligibility only), M7 (scoring, classifier, `explain_route`, affinity, model groups) | BO-1, BO-5, BO-9 | FR-RTE-01–11, FR-MCP-02, 05 |
| CAP-7 | Capacity estimation and backpressure | Usage is recorded as reported; a per-provider confidence-labelled capacity estimate feeds scheduling; bounded queue, concurrency limits, breakers, bounded retries and failover. Cache token counts are recorded where a provider CLI reports them, and per project the runs that kept or switched provider and model are counted by reason (evidence, not a claim of cache hits). Usage pacing (owner decision 57, Proposed): per subscription window, dispatch is paced so usage approaches the target by the reset, work shifts to the subscription with the most headroom for the time left, and a pacing gate delays (never refuses) work for a subscription ahead of its pace; figures are provider-reported where a provider reports them, else labelled estimates; limit output is captured for every provider. | Must | M1 (queue, global limit), M2 (record usage), M6 | BO-1, BO-4, BO-5, BO-9 | FR-CAP-01–11, FR-MCP-02, FR-ADP-10 |
| CAP-8 | Telemetry and audit | Every lifecycle step appends a run event; secrets and raw prompts never reach telemetry; optional OpenTelemetry export; run records retrievable after the fact. | Must (events, redaction); Should (OTel export); read-only dashboard Deferred | M1 (events); M8 (OTel) | BO-2, BO-5 | FR-TEL-01–04, NFR-OBS-01 |
| CAP-9 | Operator CLI | `serve`, `doctor`, `runs list/show/cancel`, `approve`, `deny`, `adapters validate`, `capacity`, `projects list/show/validate`, and the config file. No login commands and no web interface. | Must | M1 (config, `doctor`, `runs`), M2 (`serve`), M3 (`approve`, `deny`), M4 (`adapters validate`), M6 (`capacity`), M9 (`projects`) | BO-3, BO-5, BO-6 | FR-OPS-01–05, FR-PRJ-08 |
| CAP-10 | Projects, contexts and environments | Switchboard manages *projects*: the environment the coding agents operate from (the operator's host or a container, both supported and chosen per project by the deployer, owner decision 24; host delivered first) and the *contexts* of that project, such as its repositories. The orchestrator delegates to a project instead of a bare path; a project can cap the trust profile and the providers. | Must | M9 (host environments, repository contexts); M10 (container environments; Q-6 settled by delegation, verified in the M10 spike) | BO-3, BO-4 | FR-PRJ-01–09 |
| CAP-11 | Controlled commits and publication | Agents have no commit or push ability. Switchboard-injected tools make the commits and, only when a context's policy allows, the pushes, so commits carry no co-author trailer, "generated by" footer or session ID and look like any other commit. The controller keeps an internal record of which agent produced which commit. | Must | M2 (agents denied Git writes), M9 (tools, publication, audit) | BO-3, BO-7 | FR-GIT-01–09, FR-WS-05 |
| CAP-12 | Inner agent | One optional cheap, free or self-hosted model of the operator's choosing, called by the controller (not by orchestrators) for opt-in low-stakes text tasks: commit messages, PR drafts, routing classification, handoff and log summaries, run titles. Stateless, no tools, no authority over security or run status; every output validated; a deterministic fallback for every task; usage kept apart from provider capacity; explicit privacy rules for local versus remote models. Owner decision 14. | Must (core, commit messages); Should (PR drafts, routing, summaries, `cli` backend, CLI views); Could (titles); model-assisted redaction Deferred | M11 | BO-8, BO-1 | FR-INN-01–18 |
| CAP-13 | Retrieval index | Optional, automatic per-project index of a project's readable contexts, kept in the data directory and never in the repository, searched at admission to prepend a small, labelled context pack to the delegated prompt and through a read-only MCP tool, so agents are sent less context. An optional deployment-wide index holds operator-added knowledge and content that projects explicitly contribute, read only by projects that opt in. Retrieved text is untrusted data with no authority over security or results; secrets are excluded and redacted best effort; a remote embedding backend sees source only with both inner-agent gates. Inert with no embedding backend. Owner decision 40. | Should (core), Must (isolation, exclusions, untrusted-data and freshness rules); global index Should; agent-callable search Could | M12 | BO-9, BO-1 | FR-RAG-01–14 |
| CAP-14 | Agent subscriptions to PR and merge events | Optional, later. An agent subscribes to a pull request or merge and is notified when CI passes or fails, when another agent commits to that PR, or when it merges or closes, so it can make the change it needs. Not scheduled; it needs this entry and its SRS requirements (FR-SUB-01) before any build. *(Note 2026-10-15, owner decision 51: the narrowed form, fixing CI on branches a project published, is CAP-16 and milestone M15; this entry stays Deferred.)* | Deferred | Not scheduled ([ROADMAP §8](../ROADMAP.md#8-deferred-and-excluded-work)) | None yet (no business outcome in BRD) | FR-SUB-01 |
| CAP-15 | Control plane for one chat client | One MCP client can keep watch over several unattended projects: a digest and `list_runs` with a `needs_attention` flag, operator budgets and a loop breaker, pause, and approvals by a client the operator marks as an approval proxy under fixed controls, with the consent page as a secondary method. Steering, notification sinks, the consent-page link and a `console` tool profile are Should. An approval is decided only through the controls of FR-CTL-08 or the consent page, never by a model's text alone. Owner decisions 49 and 50. | Must (inbox and digest, needs-attention, budgets and loop breaker, pause, approval proxy); Should (steering, notification sinks, consent-page link, `console` tool profile) | M14 | BO-1, BO-3, BO-5 | FR-CTL-01–12 |
| CAP-16 | Project queue, schedules and CI triggers | Work for a project waits in a durable queue and runs on schedules, or when CI fails on a branch the project published. Each item is admitted under the ceiling of the client that created it. The general PR and merge subscription of CAP-14 stays Deferred. Owner decision 51. | Should | M15 (after M14); the CI trigger reads CI through the operator's `gh` CLI (owner decision 54) | BO-1, BO-4 | FR-QUE-01–05 |
| CAP-17 | Switchboard-controlled skills | The operator defines named skills (instruction packs such as a security review or a merge-steward playbook) that Switchboard stores and versions. The orchestrator, project defaults and per-role defaults inject them into a run by name; each provider receives them in its native way where that is verified, otherwise as a labelled prompt prefix. Skills never enter the repository or a commit and are removed after the run; untrusted runs get only operator-approved skills. *Proposed (2026-10-17, owner decision 58, [ADR-0056](../adr/0056-switchboard-controlled-skills.md)); partly built (T16.1: store, migration 0021 and state derivation; T16.3: configuration keys and loader; T16.2: operator CLI; T16.9: read-only MCP tools; T16.4: admission; T16.5: prompt-prefix delivery; T16.6: native-delivery framework and leak prevention, all Delegated, not owner-approved).* | Should | M16 | BO-1, BO-3 | FR-SKL |

Deferred capabilities, tracked in [ROADMAP §8](../ROADMAP.md#8-deferred-and-excluded-work): read-only usage dashboard
(FR-TEL-04), upstream ACP server, learned routing (FR-RTE-05), OpenCode persistent service transport (FR-EXE-04), native
Windows support (NFR-PORT-03), context kinds other than repositories, model-assisted redaction (FR-INN-18),
approximate-nearest-neighbour indexes and learned reranking for retrieval, agent subscriptions to PR and merge events
(CAP-14, FR-SUB-01), and multi-user or hosted operation.

### Implementation evidence (partial M12) — CAP-13

Milestone boundaries and task status: [ROADMAP §6.7](../ROADMAP.md#67-m12-retrieval-index-tasks). On fakes and synthetic
fixtures through T12.3 (2026-10-14, Delegated, not owner-approved): deployment and per-project `rag` configuration;
per-project SQLite retrieval stores under the data directory; scanner, exclusion filters, redaction and chunking over
readable contexts; and the embedding backend port with a deterministic fake backend and an `http` backend subject to the
same locality and source-content gates as the inner agent. Schemas, algorithms and module-level evidence are in [SDD
§4.1](../design/SDD.md#41-comp-rag-implementation-evidence-m12-t121t123), [TDD §3.13](../design/TDD.md#313-retrieval-index)
and [LLD §14](../design/LLD.md#14-retrieval-index).

**Design (T12.5; FR-RAG-05, FR-RAG-07, FR-RAG-08).** On `origin/main` after squash merges
[#180](https://github.com/zemdregon/switchboard/pull/180) and [#181](https://github.com/zemdregon/switchboard/pull/181):
admission context pack in [LLD §14.11](../design/LLD.md#1411-admission-context-pack-t125); component and traceability
notes in [SDD §4.1 (T12.5)](../design/SDD.md#t125--admission-context-pack-design-intent) and [SDD
§5](../design/SDD.md#5-requirements-to-design-traceability); test plan in [TDD
§3.13.8](../design/TDD.md#3138-t125-admission-time-context-pack-2026-10-14). Global-index merge at admission is
deferred to T12.7 (same TDD section).

**Runtime (implemented, T12.4–T12.5).** Built on fakes ([ROADMAP §6.7](../ROADMAP.md#67-m12-retrieval-index-tasks)):
incremental background index build, operator `index` commands and `doctor` retrieval reporting (T12.4); delegated runs
with retrieval on receive an untrusted context pack at dispatch (T12.5;
`src/retrieval/admission.test.ts`, `src/lifecycle/context-pack.test.ts`, `src/retrieval/import-boundary.test.ts`);
differences from the design are listed at the end of LLD §14.11. The admission path searches the project store only
until T12.7.

**Design (T12.7; FR-RAG-09, FR-RAG-10).** On `origin/main`: deployment-wide index and opt-in sharing in [LLD
§14.9](../design/LLD.md#149-global-index-and-sharing) (`rag.global`, operator-added `sources`, `contribute_to_global`
and `use_global`, default off on every side; `untrusted` contexts do not contribute by default; every global snippet
carries `origin_project` or a source label; the same §14.4 locality gates and run profile apply), with admission-time
merge of project and global hits in [LLD §14.6](../design/LLD.md#146-selection-and-token-budget) step 3 alongside the
T12.5 pack path (LLD §14.11). Store layout and caps: [LLD §14.2](../design/LLD.md#142-stores-and-tables).
Engineering expectations: cross-project isolation and origin labelling in [TDD
§3.13.3](../design/TDD.md#3133-testing-affinity-and-retrieval); explicit admission merge coverage in [TDD
§3.13.8](../design/TDD.md#3138-t125-admission-time-context-pack-2026-10-14). Load-time enforcement that only the
operator file may set sharing flags is implemented in T12.1 ([TDD
§3.13.5](../design/TDD.md#3135-t121-config-and-store-2026-10-14)). Workflow rule BR-47 and WF-14 traceability: [FRD
§3.1](FRD.md#31-implementation-evidence-partial-m12) (open in
[PR #196](https://github.com/zemdregon/switchboard/pull/196)); SRS requirement evidence in
[PR #198](https://github.com/zemdregon/switchboard/pull/198). Component mapping: [SDD
§5](../design/SDD.md#5-requirements-to-design-traceability) (`FR-RAG-09`, `FR-RAG-10`); [ADR-0031](../adr/0031-retrieval-index.md).

**Runtime (implemented, T12.7, Partial; ROADMAP §6.7).** T12.7 is Partial (2026-10-19, owner ruling): global/both scope
returns GLOBAL_NOT_AVAILABLE on main; fix in #728 / sb/2026-10-18-fix-t127-search-global (f8c3fc5f).
A separate global SQLite store is built by
`serve` after the projects from operator `sources` and contributing projects, with admission search merge when
`use_global` is set and `index rebuild global`, `index clear global`, `index status global` and the `doctor`
`rag_index_global` check (`src/retrieval/global.test.ts`, `src/cli/rag-index.test.ts`). Not implemented yet on
`main`: reading the global store from `search_project_context` (T12.6 `global`/`both` still answer
`GLOBAL_NOT_AVAILABLE`).

### 3.1 Inner agent task catalogue

The inner agent (CAP-12) is configured once and then used for the tasks the operator enables one by one. This catalogue
owns which tasks exist and whether each is in scope; requirements are in [SRS §3.14](SRS.md#314-inner-agent-fr-inn) and
schemas and validators in [LLD §13](../design/LLD.md#13-inner-agent). Owner decision 14 named commit and PR writing,
routing for auto mode, and "other things"; every row below beyond those is **Proposed** (the drafter's judgement, not
zemdregon's decision). "Fallback" is what happens with no inner agent or when it fails (FR-INN-08).

**Rule for what may go to a cheap model.** A task qualifies only if (a) a wrong or hostile output cannot change what a
run is allowed to do, how it ended or whether it passed, (b) the output can be checked mechanically or is only advisory
text for a human or an agent that will inspect the repository anyway, and (c) there is a safe fallback.

| ID | Task | What it produces | Value | Main risk if the model is weak or manipulated | Controls | Fallback | Recommendation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| IT-1 | Commit message | Message for the commit tool from the diff of the committed paths | The coding agent does not spend output on it | Vague or wrong message in published history; attribution text echoed; instructions from the diff followed | Agent text wins by default; sanitiser; no IDs or provider names in the prompt; empty means error (FR-INN-10) | Tool error: the agent writes the message | **In scope** (Must, first task) |
| IT-2 | PR title and description draft | `pr_draft` artifact for a publish ref | Saves a premium turn per PR | Overclaims ("all tests pass"); attribution text; leaks internal paths | Same sanitiser; draft states only facts from the diff and run records; Switchboard never posts it (FR-INN-11) | No draft; the orchestrator writes its own | **In scope** (Should) |
| IT-3 | Routing classification for auto mode | Enumerated features for FR-RTE-04 (context volume, autonomy, reasoning depth, task kind) | Better stage-2 scoring when the caller names no provider | A skewed feature sends work to a weaker or costlier provider; prompt injection in the request | Features only, never eligibility or `require_provider`; stored with source and version; replay never re-calls the model (FR-INN-12) | Heuristic classifier, else neutral features | **In scope** (Should; needs M7) |
| IT-4 | Handoff condensation | Prose fields of the FR-SES-04 bundle | Smaller bundle for the next provider | A summary that drops or invents a decision or failure | Additive and labelled; structured fields from records only; raw artifact pointers kept; the next agent must inspect the repository (FR-INN-13) | Deterministic truncation of raw text | **In scope** (Should; needs M5) |
| IT-5 | Log and verification-output summary | `log_summary` text and envelope summary lines | Short, readable results for the orchestrator | A summary that says "passed" when it failed | Status, exit codes and counts come from records only; source label; raw artifact link (FR-INN-13) | Deterministic head and tail excerpt with counts | **In scope** (Should) |
| IT-6 | Run title and one-line summary | Text for `runs list` and envelopes | Readability | Injected text shown to humans and orchestrators | Length cap, control characters stripped, treated as data (FR-INN-14) | First line of the objective, truncated | **In scope** (Could) |
| IT-7 | Secret or PII detection | Extra redactions | Catch odd secret formats | Misses are silent leaks; sending content to find secrets is itself exposure | None adequate | Deterministic redaction stays the control | **Deferred** (FR-INN-18); at most an add-only advisory pass on a `local` backend later |
| IT-8 | Failure classification | A failure code for retry or failover | Fewer `UNKNOWN`s | A wrong code triggers a replay on a mutated workspace (BR-7) | — | Adapter and controller classification | **Excluded** (FR-INN-06) |
| IT-9 | Permission, sandbox, approval or eligibility decisions | Any policy verdict | — | A cheap, injectable model holding a security decision | — | Policy engine | **Excluded permanently** (FR-INN-06) |
| IT-10 | Rewriting or compressing the orchestrator's instruction before delegation | A shorter prompt | Fewer provider tokens | Changes the user's intent silently | — | Send as given | **Not now**: the orchestrator owns the instruction |
| IT-11 | Verification test selection | Which tests to run | Faster checks | Skipping the test that would have failed | — | Run the supplied commands | **Excluded**: it changes what is verified |
| IT-12 | Advisory diff pre-review ("does this look done?") | A note beside the result | Cheap second look | False confidence; reviewed as if authoritative | Would have to be advisory only and labelled | None | **Not now**: reconsider after IT-1 to IT-6 have fallback data |
| IT-13 | Commit splitting or ordering suggestions | Groups of paths for several commits | Tidier history | Splits that break the build | Would need verification between commits | One commit per tool call as made | **Deferred** |
| IT-14 | Changelog or release notes | Text from commit history | Convenience | Misstatement | Builds on IT-2 | None | **Not now**: no requirement behind it |
| IT-15 | A general model tool for orchestrators | Direct access to the inner model | Convenience | Switchboard becomes a model proxy and TB-1 widens | — | — | **Excluded** (ADR-0016) |

**How the operator chooses the inner agent (Proposed).** In the configuration file, name one backend and model, then
list the tasks to enable; there is no default model, and nothing is enabled until listed. A backend is `http` (an
endpoint the operator runs or reaches; any key-bearing service goes through a local gateway) or `cli` (a one-shot run of
an installed provider CLI, first OpenCode with a free or cheap model, which holds its own login). `switchboard doctor`
shows whether it is reachable and answers a fixed canary correctly; `switchboard inner test <task>` tries one task on
built-in sample data; a project or repository context can turn the inner agent `off` or `local_only`.

**Privacy in one paragraph.** A `local` backend (loopback or a Unix socket on the same host) keeps everything on the
machine. A `remote` backend needs an explicit opt-in, and sending diffs or log excerpts to it needs a second opt-in per
task. Secrets are redacted by fixed rules before any call, and prompts and replies are not logged.

**Capacity.** Inner calls are not provider usage. They never reduce a provider's capacity estimate, unless the operator
says the inner model draws on the same subscription as a routed provider, in which case that consumption is recorded and
`doctor` warns about it.

## 4. Use cases and user journeys

### 4.1 Use cases

| Use case | Actor | CAP |
| --- | --- | --- |
| Delegate a bounded coding task to the best eligible provider | Orchestrator | CAP-1, CAP-2, CAP-6 |
| Inspect an unknown repository read-only | Orchestrator | CAP-1, CAP-3 |
| Edit code in isolation and receive a branch and diff, not a change to the operator's checkout | Orchestrator | CAP-1, CAP-4 |
| Delegate work to a named project (its environment and repositories) instead of a bare path | Orchestrator | CAP-1, CAP-10 |
| Have the agent's finished work committed, and optionally pushed, as ordinary commits | Orchestrator, Operator | CAP-11 |
| Find out which agent produced a given commit | Operator | CAP-11, CAP-8 |
| Continue unfinished work after a quota wall or an expired login | Orchestrator | CAP-5, CAP-7 |
| Check that every provider is installed, logged in and validated | Operator | CAP-2, CAP-9 |
| Audit what ran, why it was routed there and what it consumed | Operator | CAP-8, CAP-9 |
| Approve one exceptional privileged run | Operator | CAP-3, CAP-9 |
| Accept a new provider CLI version after conformance checks | Operator | CAP-2, CAP-9 |
| Let a cheap or self-hosted model write commit messages, PR drafts and summaries instead of a premium provider | Operator | CAP-12 |
| Keep a project on one provider and model so prompt caches stay warm, switching only when usage is maxed out or on request | Operator, Orchestrator | CAP-6, CAP-7 |
| Ask for a group of models (for example "flagship") and get whichever member has headroom, while every subscription is used fully by its reset | Orchestrator, Operator | CAP-6, CAP-7 |
| Give agents relevant project context from an index instead of re-sending large amounts of it | Operator | CAP-13 |
| Let an agent follow a pull request or merge and react when CI or another agent changes it (deferred) | Orchestrator | CAP-14 |
| Give every coder or steward run the same operator playbook by naming a skill, without pasting it into the task or the repository | Operator, Orchestrator | CAP-17 |

### 4.2 User journeys

Workflows behind these journeys are specified in the [FRD](FRD.md) (WF-1 to WF-16); journeys only name the requirements
involved.

#### UJ-1 First-time setup

- Trigger: operator has installed Switchboard and wants to use it.
- Steps: (1) install the provider CLIs wanted; (2) log in to each with its native login command, outside Switchboard;
  (3) set allowed workspace roots, per-client maximum trust and any provider preferences in configuration; (4) run
  `switchboard doctor`; (5) read per-adapter status and fix anything reported, including the native login command named
  for any `AUTH_REQUIRED`.
- Outcome: operator knows which providers are eligible and why any are not.
- CAP: CAP-2, CAP-9, CAP-3. FR: FR-OPS-01, FR-ADP-02, FR-ADP-03, FR-AUTH-02, FR-POL-07, FR-POL-10, NFR-PERF-02.

#### UJ-2 Orchestrator delegates a task and collects the result

- Trigger: the orchestrator has a coding task.
- Steps: (1) call `delegate_task` with objective, workspace, constraints, trust profile and optional verification
  commands and hints; (2) receive `run_id` and `meta_session_id` immediately, or a result if a bounded `wait_seconds`
  elapses first; (3) the controller selects an eligible provider and runs it in an isolated worktree; (4) poll
  `get_run`; (5) fetch artifacts with `get_artifacts` if needed.
- Outcome: a compact envelope with status, provider, route reasons, summary, changed-file count, verification results
  and usage; the change sits on a controller-owned branch with a diff artifact.
- CAP: CAP-1, CAP-3, CAP-4, CAP-6, CAP-8. FR: FR-MCP-01, 03, 04, 05, 07, 09, FR-POL-01, FR-POL-10, FR-WS-01, 03, 05,
  FR-EXE-01, 08, FR-RTE-01, FR-TEL-01.

#### UJ-3 Continue a task on the same or a different provider

- Trigger: the orchestrator wants to extend or repair earlier work, or a run needs a different provider.
- Steps: (1) call `continue_task` with the `meta_session_id`; (2) same provider: native resume with the stored session
  ID; (3) different provider: the controller builds a handoff bundle from its own records and instructs the new agent to
  inspect the repository; (4) result collected as in UJ-2.
- Outcome: work continues with objective, decisions, changed files and failed attempts preserved.
- CAP: CAP-5, CAP-4, CAP-6. FR: FR-MCP-01, FR-SES-01–05, FR-WS-04, FR-RTE-01.

#### UJ-4 Provider unavailable and the system responds

- Trigger: auth expired, quota exhausted, or CLI version unverified.
- Steps: (1) the failure is classified into one code (`AUTH_REQUIRED`, `QUOTA_EXHAUSTED`, `ADAPTER_VERSION_UNVERIFIED`);
  (2) auth or version: the provider becomes ineligible and the error names the operator action (native login command, or
  revalidation); (3) quota: fail over to another eligible provider if permitted, queue if a reset time is known within
  the configured horizon, otherwise return `QUOTA_EXHAUSTED`; (4) transient rate-limit or overload failures are retried
  a bounded number of times, only if the workspace is unchanged.
- Outcome: the task completes elsewhere, waits, or fails with a precise reason and an operator instruction; the
  workspace is never replayed blindly.
- CAP: CAP-2, CAP-7, CAP-4. FR: FR-AUTH-02, FR-ADP-03, FR-CAP-04, FR-CAP-05, FR-CAP-06, FR-WS-04, FR-MCP-05, FR-MCP-07.

#### UJ-5 Operator inspects runs, routing reasons and usage

- Trigger: operator wants to know what happened or what was consumed.
- Steps: (1) `switchboard runs list`; (2) `switchboard runs show <id>` for routing decision, policy snapshot, adapter
  version, changed files, verification results, reported versus estimated usage and artifact references; (3) optionally
  review exported OpenTelemetry traces.
- Outcome: operator can explain any run after the fact.
- CAP: CAP-8, CAP-9, CAP-6, CAP-7. FR: FR-OPS-01, NFR-OBS-01, FR-RTE-03, FR-CAP-01, FR-CAP-03, FR-TEL-01–03.

#### UJ-6 Operator approves a privileged run

- Trigger: a request asks for the `privileged` profile.
- Steps: (1) the request is held in `AWAITING_APPROVAL`; MCP alone cannot grant it; (2) operator reviews the requested
  scope with `runs show`; (3) operator runs `switchboard approve <run_id>`; (4) approval is recorded with timestamp and
  scope and the run proceeds.
- Outcome: the run executes with explicit, recorded scope. Without approval it does not run. The approval also covers
  later runs that continue the same meta-session with the same scope (owner decision 17); a different scope or a new
  meta-session asks again.
- CAP: CAP-3, CAP-9. FR: FR-POL-01, FR-POL-03, FR-POL-09, FR-MCP-06, FR-OPS-02.

#### UJ-7 Provider CLI updates and the operator revalidates the adapter

- Trigger: a provider CLI upgrades to a version outside the adapter's validated range.
- Steps: (1) preflight detects the version and puts the adapter in `ADAPTER_VERSION_UNVERIFIED`, so it receives no
  routed work; (2) operator runs the adapter conformance suite against the new version; (3) operator runs `switchboard
  adapters validate <provider>`; (4) `doctor` confirms eligibility.
- Outcome: the new version is accepted deliberately, or the provider stays out of rotation.
- CAP: CAP-2, CAP-9. FR: FR-ADP-02, FR-ADP-03, FR-ADP-11, FR-OPS-02, FR-POL-07.

#### UJ-8 Delegate to a project

- Trigger: the operator has defined a project (an environment and one or more repository contexts) in configuration, and
  the orchestrator has a coding task for it.
- Steps: (1) the operator runs `switchboard projects validate` and fixes anything it reports; (2) the orchestrator calls
  `list_projects` to see the projects its client entry may use; (3) it calls `delegate_task` with a `project` instead of
  a workspace path; (4) the controller applies the lower of the client's and the project's trust ceiling, creates the
  run's worktree from the project's repository context, and runs the agent in the project's environment; (5) results
  are collected as in UJ-2.
- Outcome: the work happens in the project's environment against its repository, within the project's limits, and the
  run record names the project.
- CAP: CAP-10, CAP-1, CAP-3, CAP-4. FR: FR-PRJ-01–04, FR-PRJ-06, FR-PRJ-08, FR-MCP-06, FR-WS-01.

#### UJ-9 Agent work becomes ordinary commits

- Trigger: an agent running in a project's repository has finished a unit of work.
- Steps: (1) the agent calls the injected `commit` tool with a message, rather than running Git itself (Git writes are
  denied to it); (2) the controller makes the commit on the meta-session's publish ref using the repository's configured
  identity and a sanitised message, and records a provenance record; (3) if the context's push policy allows it, the
  agent or the operator pushes through the `push` tool or command; the default policy is no push; (4) later the operator
  runs `switchboard runs show <id>` and sees which provider and model produced each commit.
- Outcome: the commits in the repository carry no agent trailer, footer or session ID, and the ledger still says who
  produced them. An agent that tried to commit or push by itself produced nothing published, and the attempt is reported.
- CAP: CAP-11, CAP-8. FR: FR-GIT-01–08.

#### UJ-10 Configure and use an inner agent

- Trigger: the operator wants commit messages, summaries or routing hints produced by a cheap, free or self-hosted model
  instead of a premium provider.
- Steps: (1) the operator adds an `inner_agent` section naming a backend and model and the tasks to enable (nothing is
  enabled by default); (2) `switchboard doctor` reports the backend reachable, its locality (`local` or `remote`) and
  whether it answered the canary; (3) `switchboard inner test commit_message` shows a sample draft and whether it passed
  validation; (4) during runs, an agent that calls `commit` without a message gets a drafted one, sanitised like any
  other; (5) later `switchboard inner status` shows accepted drafts, rejections and fallbacks per task, and
  `get_capacity` is unchanged because inner usage is not provider usage.
- Alternate: the backend is down or the model produces rubbish; tasks fall back, the run is unaffected, the commit tool
  asks the agent for a message, `doctor` shows the inner agent as degraded, and a task with too many rejections is
  suspended.
- Outcome: premium capacity is spent on coding; cheap text tasks go to the operator's chosen model; nothing about what a
  run may do depends on that model.
- CAP: CAP-12, CAP-9, CAP-11. FR: FR-INN-01–17.

#### UJ-11 Project stays on its provider, with retrieved context

- Trigger: the operator works repeatedly on one project and wants fewer tokens per task (owner decision 40).
- Steps: (1) the operator configures an embedding backend and leaves project retrieval at `auto`; `switchboard doctor`
  reports the backend, its locality and the index state; (2) the daemon indexes the project's contexts in the
  background, skipping secrets and ignored files; (3) the orchestrator delegates tasks; each routes to the provider and
  model the project last used, and `get_run` shows that affinity held; (4) the prompt carries a few labelled snippets
  from the index, marked as untrusted reference data, and the original request is unchanged; (5) when a provider's
  usage is nearly spent, or the orchestrator names a provider, the project moves and the routing decision records why;
  (6) `switchboard index status` and `capacity` show index state and kept-versus-switched counts.
- Alternate: no backend is configured and everything behaves as before; the index is stale or a step fails and the run
  goes ahead without snippets; a project sets `use_global: true` and also sees labelled snippets from the
  deployment-wide index.
- Outcome: the project does not bounce between providers, caches stay warm where providers support them, and agents are
  sent less context. The saving is not measured by the product.
- CAP: CAP-6, CAP-7, CAP-13. FR: FR-RTE-06–09, FR-CAP-08, FR-RAG-01–14.

#### UJ-12 Orchestrator asks for a model group; usage is paced across subscriptions

*Proposed (2026-10-17, owner decision 57, [ADR-0055](../adr/0055-model-groups-and-usage-pacing.md); partly built on
fakes: T7.13 to T7.17 `Done` 2026-10-17, including the model-group acceptance test
(`src/mcp/m7-group-acceptance.test.ts`), the pacing acceptance test T6.16
(`src/mcp/m6-pacing-acceptance.test.ts`) and the README pass T7.17, all `Done` 2026-10-17).*

- Actor: Orchestrator; the operator configures groups and subscription windows.
- Trigger: the orchestrator delegates a task with `routing.model_group` set to a configured group, or with one explicit
  model.
- Flow: the operator has defined, for example, a low-cost group and a flagship group whose members are models from
  several providers, and the windows of each subscription (length, reset rule, optional budget). Switchboard checks each
  member like any candidate, keeps a project on its member as long as that member is in the group and its subscription
  is within its pace, and otherwise picks the member whose subscription has the most headroom for the time left in its
  window. A subscription that is ahead of its pace is deferred; if every member is deferred, the run waits until the
  computed time and then starts.
- Outcome: every subscription is used close to fully by its reset, without the orchestrator tracking providers.
  `get_capacity` shows each window's figures with their source; estimates are marked as covering Switchboard's own usage
  only. Switchboard never starts work on its own to use up a subscription.
- CAP: CAP-6, CAP-7. FR: FR-RTE-10, FR-RTE-11, FR-CAP-09, FR-CAP-10, FR-RTE-06, FR-RTE-07.

#### UJ-13 Operator defines a skill; runs receive it by name

*Proposed (2026-10-17, owner decision 58, [ADR-0056](../adr/0056-switchboard-controlled-skills.md); the journey as a
whole is not built, but its store step is (T16.1: validation, canonicalisation, content storage, migration
0021 and state derivation in `src/skills/`), its operator-CLI step is (T16.2: `switchboard skills` in
`src/cli/skills.ts`), its configuration step is (T16.3: `skills.*`, `projects[].skills`
and `mcp_clients[].skills` in the schema and loader) and its MCP-tools step is (T16.9: read-only `list_skills`
and `get_skill` in `src/mcp/` with the §19.5 steps 2 to 4 resolver in `src/skills/resolve.ts`).*

- Actor: Operator (defines and approves skills); Orchestrator (injects them).
- Trigger: the operator wants every steward run to follow a merge playbook, and an orchestrator wants one review run to
  follow a security-review checklist.
- Flow: the operator adds the two skills with `switchboard skills add`, reads them back and approves the versions, and
  sets `skills.roles.steward` to the playbook. The orchestrator calls `list_skills`, then `delegate_task` with `role:
  "steward"` for the steward run and `skills: ["security-review"]` for the review run. Switchboard resolves and pins the
  versions, records them on each run and gives them to each provider natively where verified, otherwise as a labelled
  block at the start of the prompt. When a run ends the delivered files are gone; nothing from the skill is in the
  branch, the diff or any commit.
- Alternate: an `edit-untrusted` run that names a draft or repository-imported skill is refused with a reason; a
  `continue_task` keeps the same versions; a handoff to another provider re-delivers them there.
- Outcome: the playbook is maintained once, every run that used it is traceable to the exact version and hash, and
  untrusted runs never receive instructions the operator did not approve.
- CAP: CAP-17, CAP-3, CAP-9. FR: FR-SKL-01–10, FR-POL-04.

**Implementation note (partial M12).** UJ-11 is the target operator and orchestrator experience for CAP-13. On `main`,
T12.4–T12.5 deliver background indexing, `doctor`/`index` visibility and labelled per-project snippets at admission on
fakes, and T12.7 (Partial; global/both scope returns GLOBAL_NOT_AVAILABLE on main; fix in #728 /
sb/2026-10-18-fix-t127-search-global (f8c3fc5f)) delivers the alternate path with `use_global: true` and
deployment-wide snippets at
admission ([§3 implementation evidence](#implementation-evidence-partial-m12--cap-13)). Agent-callable search is T12.6
(Done on fakes; its `global`/`both` scopes still answer `GLOBAL_NOT_AVAILABLE`).

## 5. Product surface

The owner asked for an application plus a backend. In this product:

- **"The application"** is what users touch: the MCP tool surface (`delegate_task`, `continue_task`, `get_run`,
  `cancel_run`, `get_artifacts`, `list_capabilities`, `list_projects`, and later `get_capacity` and `explain_route`) for
  the orchestrator, and the operator CLI for the human. A second, narrower surface faces the agents themselves: the injected
  `commit` and `push` tools of CAP-11, offered per run and nothing else. There is no graphical or web application ([SRS
  FR-OPS-03](SRS.md#311-operator-cli-fr-ops)).
- **"The backend"** is the controller daemon: policy engine, project manager, session ledger, workspace manager, git
  publisher, router/scheduler, execution supervisor, adapters and telemetry pipeline. Components are defined in the
  [HLD](../design/HLD.md#1-system-context) (COMP-MCP through COMP-OPS). The MCP front end and operator CLI are the
  application-facing components; the others form the backend.

Both run on the operator's own machine, with MCP over stdio to a locally spawned orchestrator
([ADR-0002](../adr/0002-mcp-upstream-acp-downstream.md), [ADR-0011](../adr/0011-single-operator-local-deployment.md)).

### 5.1 Accessibility and platform notes for the CLI

Plain-text output, `--json` and no colour-only signals are required by FR-OPS-01; Linux first by NFR-PORT-01.

- Output is plain text, readable by screen readers and in logs.
- A machine-readable `--json` option on read commands (`doctor`, `runs list`, `runs show`) so scripts and the
  orchestrator need not scrape text.
- No information is carried by colour alone: statuses and failure codes appear as words (for example `SUCCEEDED`,
  `AUTH_REQUIRED`), with any colour only as reinforcement.
- Errors name the failure code and the operator action, such as the native login command for `AUTH_REQUIRED`.
- Linux (x86-64 and arm64) first (NFR-PORT-01); macOS in M4 (NFR-PORT-02); native Windows deferred (NFR-PORT-03).

## 6. Non-goals

The following are out of scope. Sources: the stated intent in [R1], [ADR-0003](../adr/0003-no-credential-handling.md),
[ADR-0011](../adr/0011-single-operator-local-deployment.md), and the deferred items in [ROADMAP
§8](../ROADMAP.md#8-deferred-and-excluded-work).

- **Web UI**, beyond a deferred read-only usage and telemetry dashboard (FR-TEL-04). No other web interface.
- **Login or OAuth handling**, in any form. The operator logs in natively (FR-AUTH-01).
- **Multi-user or hosted service.** No accounts, shared server, resale or credential sharing (ADR-0011).
- **Reimplementing provider APIs** or protocols, reverse engineering, or patching provider binaries (FR-AUTH-01).
- **Claiming terms-of-service compliance.** Switchboard describes its use of documented automation surfaces and makes no
  compliance claim (NFR-COMP-01).
- **Automatic merge into operator branches, and any push that is not policy-gated.** Results arrive as controller-owned
  branches and diffs; pushing happens only through the injected tool or an operator command, under a context policy that
  defaults to no push (FR-WS-05, FR-GIT-05). Agents never push or commit themselves (FR-GIT-01).
- **Containers on arbitrary images and non-repository contexts**, for now. Only `repository` contexts exist
  (FR-PRJ-02). An orchestrator may create projects (FR-PRJ-10) but only within its client's limits, and a `container`
  or push-enabled project waits for operator approval.
- **Attribution inside file contents.** The controller keeps agent attribution out of commits (FR-GIT-04); it does not
  rewrite what an agent writes into source files.
- **An inner agent with authority or tools.** The inner agent writes text; it never decides permissions, eligibility,
  approvals, redaction, failure classes or run status, and orchestrators cannot call it directly ([ADR-0016](../adr/0016-inner-agent.md),
  FR-INN-02, FR-INN-06).
- **Retrieved text with authority, and sharing between projects by default.** Indexed content is untrusted data that
  never decides permissions, eligibility or approvals, and no project reads another's index unless the content's
  project contributes it and the reading project opts in
  ([ADR-0031](../adr/0031-retrieval-index.md), FR-RAG-07, FR-RAG-10).
- **Round-robin or load-spreading of one project across providers.** A project moves only for a listed reason
  ([ADR-0032](../adr/0032-provider-model-affinity.md), FR-RTE-06, FR-RTE-07).
- **Storing a hosted model's API key in Switchboard**, for now (Q-23). Key-bearing services are reached through an
  operator-run local gateway or a CLI that holds its own login.
- **Windows**, for now (NFR-PORT-03, deferred).
- **Upstream ACP server**, for now (ADR-0002); MCP is the upstream interface. ACP as a downstream client is in scope at
  M4.
- **Learned routing**, for now (FR-RTE-05, deferred); routing uses static weights.
- Also excluded for now: the OpenCode persistent service transport (FR-EXE-04) and a Kimi Code adapter until its
  automation contract is pinned (FR-ADP-09).

## 7. Product acceptance criteria

Each criterion is observable and is checked when the named milestone delivers. Detailed verification methods are in the
[SRS](SRS.md). None has been checked yet.

| CAP | Acceptance criteria | Milestone |
| --- | --- | --- |
| CAP-1 | With the Claude Code adapter, an MCP client calls `delegate_task` and receives a `run_id` and `meta_session_id` without waiting for completion; `get_run` returns a compact envelope with no raw transcript or credential material; a tool error carries exactly one failure code. A repeated call with the same idempotency key returns the original run. | M2 |
| CAP-1 | When verification commands are supplied, their results appear in the run result. | M3 |
| CAP-2 | `switchboard doctor` reports, for each adapter, binary, version, auth status and eligibility; a missing login yields `AUTH_REQUIRED` with the native login command; an out-of-range version yields `ADAPTER_VERSION_UNVERIFIED` and no routed work. | M1 (fake adapter), M2 (Claude Code, Codex) |
| CAP-2 | Grok Build, Antigravity, Cursor and OpenCode adapters each pass the recorded-fixture conformance suite. Kimi Code does once its contract is pinned. Muse Code does too (Should, FR-ADP-12). | M4 |
| CAP-3 | `inspect-untrusted` and `edit-untrusted` runs deny writes outside the worktree and arbitrary shell, do not load repository-supplied agent config, and end with `PERMISSION_BLOCKED` or `SANDBOX_VIOLATION` rather than hanging; a request above its client's maximum trust fails with `PERMISSION_BLOCKED`. | M2 |
| CAP-3 | All five profiles work; the malicious-fixture suite shows no escape for Claude Code; a `privileged` run does not start without a recorded operator approval. | M3 |
| CAP-4 | A write-capable run executes in its own worktree from a recorded checkpoint; the operator's checked-out branch and working tree are unchanged afterwards; no push occurs by default; the changed-file list, diff artifact and post-run checkpoint are recorded; a failed mutating run is rolled back or resumed, never replayed. | M1 |
| CAP-4 | Two concurrent runs of one project get distinct worktrees and write leases, and neither can write to the other's worktree. | M9 |
| CAP-4 | Retention policy removes artifacts, worktrees and controller branches together. | M3 |
| CAP-5 | Meta-session records and append-only events exist in the ledger. | M1 |
| CAP-5 | `continue_task` resumes natively on the same provider; on a different provider it supplies a handoff bundle built only from controller records, and the new run sees the objective, decisions, changed files and prior failures. | M5 (Claude resume from M2) |
| CAP-6 | Providers failing a hard constraint are excluded and the reason is returned; `require_provider` never bypasses auth, sandbox, workspace or compliance checks. | M2 |
| CAP-6 | Every decision stores features, weights and candidate scores; `explain_route` reproduces the explanation. | M7 |
| CAP-7 | Usage is recorded as reported, labelled by source and kept apart from estimates; the queue is bounded with a global concurrency limit. | M1, M2 |
| CAP-7 | `get_capacity` returns estimates with confidence and sources and never presents an estimate as provider-authoritative; quota exhaustion triggers failover, queueing or `QUOTA_EXHAUSTED`; only the retryable failure codes are retried, only on an unchanged workspace. | M6 |
| CAP-8 | Every lifecycle step appends a run event; secret-pattern scans of fixtures and outputs find no credential values, raw prompts or environment variables in logs or telemetry. | M1 |
| CAP-8 | OpenTelemetry traces reach an operator-configured endpoint. | M8 |
| CAP-9 | `doctor` and `runs list/show` work against the fake adapter; `serve` starts the MCP server on stdio; no login command and no web interface exist. | M1, M2 |
| CAP-9 | `approve` and `deny` work for privileged runs; `adapters validate <provider>` accepts a revalidated CLI version only after its live checks pass; `capacity` shows the same estimates as `get_capacity`. | M3, M4, M6 |
| CAP-10 | `projects validate` accepts a configuration with a repository context and a `host` environment and rejects an unknown context kind; `delegate_task` with a `project` runs in that project's repository; a request above the lower of the client's and the project's ceiling fails `PERMISSION_BLOCKED`; the run record names the project. | M9 |
| CAP-10 | A `container` environment mounts only the run's worktree and declared read-only contexts, applies its limits, and is removed when the run ends, including after a controller crash. | M10 |
| CAP-11 | No adapter's compiled controls allow Git writes under a write-capable profile (argv inspection), and the fake adapter's attempt to run `git commit` is denied. | M2 |
| CAP-11 | A commit made through the injected tool carries the configured identity and no trailer, footer or identifier, even when the agent's message contains them; an agent-made commit or ref change is never published and is reported; with push disabled nothing leaves the host; with push enabled to a local bare remote only the publish ref arrives; every published commit has a provenance record naming run, provider and model. | M9 |
| CAP-12 | With no inner agent configured every behaviour is unchanged and all tests pass; with a fake backend, an enabled task is used, an invalid or empty output falls back, and an unreachable backend never fails or delays a run beyond the per-call bound. | M11 |
| CAP-12 | An agent `commit` call without a message gets a drafted message that passes the sanitiser and contains no trailer, footer or identifier even when the fake backend returns them; with the task suspended or the backend down the tool returns an error asking for a message. | M11 |
| CAP-12 | Inner usage appears only in `inner_call` records and never in `usage_observation` or `get_capacity`, unless `shares_subscription_with` is set, in which case the observation is labelled `inner_agent` and `doctor` warns. | M11 |
| CAP-12 | A `remote` backend is unusable without `allow_remote`; diffs reach it only with the per-task opt-in; a project set to `local_only` never sends to it; a planted secret in a diff does not appear in the captured prompt; no inner-agent output reaches any policy component (import-boundary test). | M11 |
| CAP-6 | A project's second and later runs use the same provider and model whatever the scores say; the only things that move it are the listed reasons, each recorded as `affinity_switch_reason` in the routing decision; replaying recorded decisions never finds a switch without a reason. | M7 |
| CAP-7 | Cache read and creation token counts are recorded as usage observations with their source where a provider reports them; per project, the counts of runs that kept or switched provider and model by reason are shown; no output claims a cache hit. | M6 |
| CAP-6 | A request for a configured model group is routed to an eligible member, an explicit model is honoured or refused with a reason, and replay reproduces each group decision; no group or model name is in code. | M7 |
| CAP-7 | With declared subscription windows, work shifts to the subscription with the largest allowance, a subscription ahead of its pace is deferred and its waiting run starts at the computed time, and every usage figure shows its source (provider-reported, operator-declared or a Switchboard-observed estimate). | M6 |
| CAP-13 | With no embedding backend configured every behaviour is unchanged and all tests pass; with a fake backend, an indexed project's run prompt carries labelled, bounded snippets and the stored request text is unchanged. | M12 |
| CAP-13 | Files outside a context root, ignored files, secret-denylist files, symlinks leaving the root and nested repositories are not indexed; a planted secret in an indexed file does not reach the fake backend's captured input; one project's search never returns another project's content. | M12 |
| CAP-13 | Any retrieval failure leaves the run unaffected; a snippet whose file changed since indexing is dropped or flagged; no retrieved content reaches any policy, eligibility or approval component (import-boundary test). | M12 |
| CAP-13 | A `remote` embedding backend is unusable without `allow_remote`, and sees source only with `allow_source_content`; the global index is off by default, and a run reads it only when its project sets `use_global`; `index clear` removes vectors and chunk text. | M12 |
| CAP-14 | Deferred. Acceptance criteria are written when the capability is scheduled ([ROADMAP §8](../ROADMAP.md#8-deferred-and-excluded-work)). | — |
| CAP-15 | A scripted MCP client gets, from a cursor, a digest across two projects showing needs-attention reasons, pending approvals and finished runs. | M14 |
| CAP-15 | A run that fails the same way N times is parked and flagged, and a budget cap refuses admission with a needs-attention reason. | M14 |
| CAP-15 | Pause holds admission, and steering a run on a fake adapter continues the same native session with the note. | M14 |
| CAP-15 | An `approval_proxy` client decides a pending privileged approval only with the matching digest, and a client without the flag gets no approval tools. | M14 |
| CAP-15 | A notification sink receives metadata-only payloads and never a planted secret or agent text. | M14 |
| CAP-16 | A queued item is admitted only under its creating client's ceiling, and a schedule does nothing until it is enabled. | M15 |
| CAP-16 | A CI-failure trigger admits work only for branches the project published, and its event text is treated as untrusted. | M15 |
| CAP-17 | With skills disabled or none resolved, prompts, argv, environment and records are unchanged; with skills, a fake run's prompt carries the labelled block in resolved order, and argv and environment are still unchanged. | M16 |
| CAP-17 | An untrusted run never receives a draft or repository-imported skill; a skill with a secret, a prompt delimiter or an unknown front matter key is refused at `add`. | M16 |
| CAP-17 | A fake adapter's native skill file never appears in a commit, checkpoint, diff or handoff, blocks publication while present, and is gone after every terminal state, a restart and GC; no event, span, log or sink contains skill text. | M16 |
