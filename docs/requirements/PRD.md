# Product Requirements Document (PRD)

| Field | Value |
| --- | --- |
| Status | Draft, baseline for milestone M1 |
| Owns | Target users, use cases, user journeys UJ-1..UJ-9, capabilities CAP-1..CAP-11 and their priorities, the product surface, non-goals, and product-level acceptance criteria per capability. |
| Does not own | Business outcomes ([BRD](BRD.md)); requirements ([SRS](SRS.md)); workflows and business rules ([FRD](FRD.md)); milestone scope and status ([ROADMAP](../ROADMAP.md)); components ([HLD](../design/HLD.md)). |
| Last reconciled | 2026-10-12 |

Nothing in this document is implemented. As of 2026-10-12 the repository contains documentation only. Acceptance
criteria are conditions to be checked when the named milestone delivers.

## 1. Product overview

Switchboard is a headless controller that sits between a primary orchestrating agent (for example OpenClaw or Grok Bot)
and up to seven AI coding CLIs: Claude Code, Grok Build, Antigravity (`agy`), Codex, Cursor CLI, OpenCode and Kimi Code.
It exposes a small MCP tool surface, runs the chosen CLI through its documented headless mode inside an isolated
workspace under a named trust profile, and keeps its own record of the work so tasks can move between providers. It
never logs in to a provider and never handles credentials ([ADR-0003](../adr/0003-no-credential-handling.md)). The
business case is in the [BRD](BRD.md); the stated intent comes from the introduction of the [original
blueprint](../research/headless-ai-coding-controller.md) (superseded on technical details by the [verified
research](../research/headless-ai-coding-controller-verified-2026-10-12.md)).

## 2. Target users

| User | Description | Needs |
| --- | --- | --- |
| Operator | The human who installs Switchboard, logs in to each provider with its native CLI, configures policy and allowed workspace roots, and reviews results. Ender first; as an open-source project, anyone running their own installation ([ADR-0011](../adr/0011-single-operator-local-deployment.md)). | A reliable setup check, clear explanations when something is unavailable, visibility of runs, routing reasons and usage, control over privileged runs, and a safe path when a provider CLI updates. |
| Orchestrator agent | A machine client (for example OpenClaw, Grok Bot) that spawns the controller and calls its MCP tools. | A small, stable tool set; compact results; one error code per failure; asynchronous runs with bounded waits; no way to exceed its permitted trust level. |

Switchboard is open source ([BRD §8](BRD.md#8-personal-tool-and-open-source-project)): other operators are people like
Ender who install it on their own machines with their own subscriptions. There are no shared or hosted users.

## 3. Capabilities

Priorities are MoSCoW as in [SRS §1](SRS.md#1-conventions). Milestones are defined in the
[ROADMAP](../ROADMAP.md#6-milestones). The last column mirrors the capability table at the end of [SRS
§7](SRS.md#7-traceability).

| ID | Capability | Description | Priority | Target milestone | BO served | SRS requirement groups |
| --- | --- | --- | --- | --- | --- | --- |
| CAP-1 | Task delegation via MCP | The orchestrator delegates a task with objective, workspace, constraints and trust profile, gets a `run_id` and `meta_session_id` at once, and polls or waits a bounded time for a compact result. | Must | M2 (vertical slice); verification commands M3 | BO-1 | FR-MCP-01, 03–10, FR-EXE-01–02, 05–08 |
| CAP-2 | Provider adapters with version/auth preflight | One adapter per provider translates requests to documented headless modes and normalizes structured output. Preflight checks binary, version, auth, flags and a smoke call; unvalidated versions are ineligible. | Must, all seven (Kimi Code blocked until its contract is pinned) | M1 (contract and fake adapter), M2 (Claude Code, Codex), M4 (others) | BO-1, BO-2, BO-6 | FR-ADP-01–11, FR-AUTH-02 |
| CAP-3 | Policy and trust profiles | Five named trust profiles compiled into each adapter's native controls, with no automatic bypass flags, no loading of repository-supplied agent config under untrusted profiles, and per-client maximum trust. | Must | M2 (`inspect-untrusted`, `edit-untrusted`); M3 (remaining profiles) | BO-2, BO-3 | FR-POL-01–10, FR-MCP-06 |
| CAP-4 | Workspace isolation | Write-capable runs execute in a controller-created Git worktree from a recorded checkpoint, with one write lease per worktree, post-run checkpoints and diffs, rollback, and no remote pushes except through controlled publication (CAP-11). | Must | M1 (retention and GC M3) | BO-3, BO-4 | FR-WS-01–07 |
| CAP-5 | Meta-sessions and cross-provider continuity | A controller-owned task record outlives any provider session. Continuing on the same provider uses native resume; continuing elsewhere uses a handoff bundle built from controller evidence. | Must | M1 (schema, events), M2 (Claude resume), M5 (all adapters, handoff) | BO-4 | FR-SES-01–06 |
| CAP-6 | Routing with explanation | Hard eligibility filtering first, then weighted scoring; every decision persisted and explainable; routing hints can only narrow the choice. | Must (eligibility); Should (heuristic classifier); learned routing Deferred | M2 (eligibility only), M7 (scoring, classifier, `explain_route`) | BO-1, BO-5 | FR-RTE-01–05, FR-MCP-02, 05 |
| CAP-7 | Capacity estimation and backpressure | Usage is recorded as reported; a per-provider confidence-labelled capacity estimate feeds scheduling; bounded queue, concurrency limits, breakers, bounded retries and failover. | Must | M1 (queue, global limit), M2 (record usage), M6 | BO-1, BO-4, BO-5 | FR-CAP-01–07, FR-MCP-02, FR-ADP-10 |
| CAP-8 | Telemetry and audit | Every lifecycle step appends a run event; secrets and raw prompts never reach telemetry; optional OpenTelemetry export; run records retrievable after the fact. | Must (events, redaction); Should (OTel export); read-only dashboard Deferred | M1 (events); M8 (OTel) | BO-2, BO-5 | FR-TEL-01–04, NFR-OBS-01 |
| CAP-9 | Operator CLI | `serve`, `doctor`, `runs list/show/cancel`, `approve`, `deny`, `adapters validate`, `capacity`, `projects list/show/validate`, and the config file. No login commands and no web interface. | Must | M1 (config, `doctor`, `runs`), M2 (`serve`), M3 (`approve`, `deny`), M4 (`adapters validate`), M6 (`capacity`), M9 (`projects`) | BO-3, BO-5, BO-6 | FR-OPS-01–05, FR-PRJ-08 |
| CAP-10 | Projects, contexts and environments | Switchboard manages *projects*: the environment the coding agents operate from (the operator's host first, a container later) and the *contexts* of that project, such as its repositories. The orchestrator delegates to a project instead of a bare path; a project can cap the trust profile and the providers. | Must | M9 (host environments, repository contexts); M10 (container environments, blocked on Q-6) | BO-3, BO-4 | FR-PRJ-01–09 |
| CAP-11 | Controlled commits and publication | Agents have no commit or push ability. Switchboard-injected tools make the commits and, only when a context's policy allows, the pushes, so commits carry no co-author trailer, "generated by" footer or session ID and look like any other commit. The controller keeps an internal record of which agent produced which commit. | Must | M2 (agents denied Git writes), M9 (tools, publication, audit) | BO-3, BO-7 | FR-GIT-01–09, FR-WS-05 |

Deferred capabilities, tracked in [ROADMAP §8](../ROADMAP.md#8-deferred-and-excluded-work): read-only usage dashboard
(FR-TEL-04), upstream ACP server, learned routing (FR-RTE-05), OpenCode persistent service transport (FR-EXE-04), native
Windows support (NFR-PORT-03), context kinds other than repositories, and multi-user or
hosted operation.

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

### 4.2 User journeys

Workflows behind these journeys are specified in the [FRD](FRD.md) (WF-1 to WF-9); journeys only name the requirements
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
- Outcome: the run executes with explicit, recorded scope. Without approval it does not run.
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

## 5. Product surface

The owner asked for an application plus a backend. In this product:

- **"The application"** is what users touch: the MCP tool surface (`delegate_task`, `continue_task`, `get_run`,
  `cancel_run`, `get_artifacts`, `list_capabilities`, later `list_projects`, `get_capacity` and `explain_route`) for the
  orchestrator, and the operator CLI for the human. A second, narrower surface faces the agents themselves: the injected
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
| CAP-2 | Grok Build, Antigravity, Cursor and OpenCode adapters each pass the recorded-fixture conformance suite. Kimi Code does once its contract is pinned. | M4 |
| CAP-3 | `inspect-untrusted` and `edit-untrusted` runs deny writes outside the worktree and arbitrary shell, do not load repository-supplied agent config, and end with `PERMISSION_BLOCKED` or `SANDBOX_VIOLATION` rather than hanging; a request above its client's maximum trust fails with `PERMISSION_BLOCKED`. | M2 |
| CAP-3 | All five profiles work; the malicious-fixture suite shows no escape for Claude Code; a `privileged` run does not start without a recorded operator approval. | M3 |
| CAP-4 | A write-capable run executes in its own worktree from a recorded checkpoint; the operator's checked-out branch and working tree are unchanged afterwards; no push occurs by default; the changed-file list, diff artifact and post-run checkpoint are recorded; a failed mutating run is rolled back or resumed, never replayed. | M1 |
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
