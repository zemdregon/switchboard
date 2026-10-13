# Software Requirements Specification (SRS)

| Field | Value |
| --- | --- |
| Status | Draft, baseline for milestone M1 |
| Owns | Every uniquely identified, verifiable requirement (functional and nonfunctional). No other document defines requirements; they cite these IDs. |
| Upstream | [BRD](BRD.md) business outcomes (`BO-*`), [PRD](PRD.md) capabilities (`CAP-*`) |
| Downstream | [FRD](FRD.md) workflows, [HLD](../design/HLD.md), [SDD](../design/SDD.md), [TDD](../design/TDD.md), [LLD](../design/LLD.md), [ADRs](../adr/README.md), [ROADMAP](../ROADMAP.md) milestones |
| Last reconciled | 2026-10-12 |

## 1. Conventions

- **IDs** are stable. A retired requirement keeps its ID with status `Withdrawn`; IDs are never reused or renumbered.
- **Priority** uses MoSCoW: `Must` (required for the milestone named), `Should` (planned, may slip one milestone),
  `Could` (desirable, not committed), `Deferred` (explicitly out of current scope; see [ROADMAP
  §8](../ROADMAP.md#8-deferred-and-excluded-work)).
- **Verification**: `T` = automated test, `I` = inspection or review, `D` = demonstration, `A` = analysis.
- **Milestone** is where the requirement is first delivered; see [ROADMAP §6](../ROADMAP.md#6-milestones).
- **Verification status**: as of 2026-10-12 no requirement had been verified, because the repository had no code or test
  suite then. Verification evidence is now recorded per milestone and task in [ROADMAP §6](../ROADMAP.md#6-milestones);
  a requirement is verified only where that evidence names a passing test or check.
- **Source** cites the business outcome or capability the requirement serves, and where relevant the research section
  that motivates it: `[R1]` = [original blueprint](../research/headless-ai-coding-controller.md) (superseded where it
  conflicts), `[R2]` = [verified research,
  2026-10-12](../research/headless-ai-coding-controller-verified-2026-10-12.md).
- **Proposed targets** (numbers chosen during this planning task, not established constraints) are marked *(proposed
  target)*. They become requirements only after measurement in the milestone that names them.

### 1.1 Glossary

| Term | Meaning |
| --- | --- |
| Controller | The Switchboard process. |
| Orchestrator | The upstream AI agent (for example OpenClaw or Grok Bot) that calls the controller as an MCP client. |
| Operator | The human who installs Switchboard, logs in to providers natively, and configures policy. Assumed to be the account owner. |
| Provider | A vendor coding CLI/harness: Claude Code, Codex, Grok Build, Antigravity (`agy`), Cursor CLI, OpenCode, Kimi Code, and (from 2026-10-13) Muse Code. |
| Adapter | Controller module that translates normalized requests into one provider's documented automation surface and normalizes its output. |
| Run | One attempt to execute a delegated task on one provider. |
| Meta-session | Controller-owned, provider-independent record of an engineering task across one or more runs. |
| Trust profile | Named security posture (§3.3) compiled by each adapter into native controls. |
| Checkpoint | Git commit recorded by the controller marking workspace state before or after a run. Internal evidence; never published (FR-GIT-08). |
| Project | A named unit Switchboard manages: one environment (where agents run) plus one or more contexts (what they work on). Runs and meta-sessions belong to exactly one project (§3.12). |
| Environment | Where a project's agent processes execute: `host` (directly on the operator's machine) or `container` (a controller-managed container). |
| Context | A resource attached to a project that agents work with. Only the `repository` kind is delivered (FR-PRJ-02). |
| Agent | The provider CLI process (and the model behind it) doing the coding work in a run. |
| Injected tool | A tool the controller offers to an agent for one run through a controller-supplied MCP definition (FR-GIT-02). The `commit` and `push` tools are the only way agent work becomes a commit or reaches a remote. |
| Publish ref | The controller-owned branch holding the commits made through the commit tool for one meta-session, separate from the internal run branches (FR-GIT-08). |
| Provenance record | Append-only ledger record linking a published commit to the run, provider and model that produced it. The commit itself carries no such marker (FR-GIT-07). |
| Inner agent | A cheap, free or self-hosted model of the operator's choosing, reached through one configured backend, that the controller itself calls for low-stakes text tasks so the provider CLIs do not spend subscription capacity on them (§3.14). It is not a provider, not a routing candidate and not an agent in the Run sense. |
| Inner task | One kind of work the controller may hand to the inner agent, such as drafting a commit message. Defined by the [PRD catalogue](PRD.md#31-inner-agent-task-catalogue) (`IT-*`); schemas, budgets and validators are in [LLD §13](../design/LLD.md#13-inner-agent). |
| Inner backend | The configured way the controller reaches the inner agent: `http` (an endpoint the operator runs or can reach) or `cli` (a one-shot run of an installed provider CLI that holds its own login). |
| Inner call | One stateless, single-turn text completion sent to the inner backend for one inner task (FR-INN-02). |

## 2. Scope of this specification

In scope: the controller daemon, its MCP tool surface, provider adapters, policy engine, workspace manager, project
manager, git publisher, inner-agent service, session ledger, router/scheduler, execution supervisor, telemetry
pipeline and the operator CLI. The product boundary and non-goals are owned by the [PRD](PRD.md#6-non-goals); the
system boundary is owned by the
[HLD](../design/HLD.md#1-system-context).

## 3. Functional requirements

### 3.1 MCP interface (`FR-MCP`)

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-MCP-01 | The controller shall expose an MCP server over the stdio transport offering the tools `delegate_task`, `continue_task`, `get_run`, `cancel_run`, `get_artifacts` and `list_capabilities`, and the read-only `list_projects` tool of FR-PRJ-03. | Must | CAP-1, [R2] MCP section | T | M2 |
| FR-MCP-02 | The controller shall additionally expose `get_capacity` and `explain_route`. | Must | CAP-6, CAP-7 | T | M6 (`get_capacity`), M7 (`explain_route`) |
| FR-MCP-03 | `delegate_task` shall accept an objective, a workspace path, constraints, a trust profile, optional verification commands and optional routing hints (`provider_preference`, `require_provider`, `minimum_capability`), and, for `privileged` only, a privileged scope (from M3, FR-POL-09), and shall return a `run_id` and `meta_session_id` without waiting for the run to finish unless the caller supplies a bounded `wait_seconds`. *(Amended 2026-10-12: privileged scope input added for owner decision 13, [ADR-0017](../adr/0017-approved-privileged-scope-bypass.md).)* | Must | CAP-1, [ADR-0002](../adr/0002-mcp-upstream-acp-downstream.md) | T | M2 |
| FR-MCP-04 | Tool results shall be compact normalized envelopes (status, provider, route reasons, summary, changed-file count, verification results, artifact references, reported and estimated usage) and shall never contain raw provider transcripts or credential material. | Must | CAP-1, BO-2 | T | M2 |
| FR-MCP-05 | Routing hints shall only narrow provider choice. `require_provider=true` shall not bypass authentication, sandbox, workspace or compliance checks; if the required provider is ineligible the call shall fail with the failure code mapped from the eligibility reason (or `ELIGIBILITY_NONE`) and the reason in the message. | Must | CAP-6, [R2] | T | M2 |
| FR-MCP-06 | The controller shall enforce, per configured MCP client, a maximum trust profile; requests above it shall fail with `PERMISSION_BLOCKED`. The `privileged` profile shall never be grantable through MCP alone (see FR-POL-09). *(Note 2026-10-13, owner decision 22: a client's `privileged_approval: "not_required"` is set in the operator's configuration, not through MCP, so it does not contradict this rule; the ceiling still applies, [ADR-0019](../adr/0019-per-client-privileged-approval.md).)* | Must | CAP-3, BO-3 | T | M2 |
| FR-MCP-07 | Every tool error shall carry exactly one code from the normalized failure taxonomy in [LLD §4](../design/LLD.md#4-failure-taxonomy) plus a human-readable message. | Must | CAP-1 | T | M2 |
| FR-MCP-08 | `delegate_task` shall accept an optional client idempotency key; a repeated call with the same key and identical parameters shall return the original run rather than start a new one, and the same key with different parameters shall fail with `INVALID_REQUEST`. Keys are scoped to the calling MCP client. | Should | CAP-1 | T | M2 |
| FR-MCP-09 | All tool inputs shall be validated against published JSON Schemas before any side effect; invalid input or an unknown ID fails with `INVALID_REQUEST`. | Must | NFR-SEC-05 | T | M2 |
| FR-MCP-10 | An automatic retry or failover shall create a successor run in the same meta-session linked to its predecessor; `get_run` on a superseded run shall report the successor's `run_id`. | Must | CAP-1, CAP-7 | T | M6 |

### 3.2 Provider adapters (`FR-ADP`)

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-ADP-01 | Every provider integration shall implement the adapter contract in [LLD §2](../design/LLD.md#2-adapter-contract): probe, auth preflight, compile, parse, resume, cancel. | Must | CAP-2, [R2] | T | M1 (contract + fake adapter) |
| FR-ADP-02 | Adapter preflight shall check, in order: binary present, binary version, automation command, structured-output support, required permission/sandbox flags, auth status, harmless structured-output smoke test. | Must | CAP-2, [R2] compliance section | T | M2 |
| FR-ADP-03 | An installed binary whose version is outside the adapter's validated range shall put the adapter in `ADAPTER_VERSION_UNVERIFIED` and make it ineligible for routing until the operator validates it. | Must | BO-6, [ADR-0009](../adr/0009-version-gated-adapters.md) | T | M2 |
| FR-ADP-04 | Adapters shall consume the provider's native structured output (JSON, JSONL or ACP messages) and shall not infer session IDs, status or usage by pattern-matching free text. | Must | [R2] | T, I | M2 |
| FR-ADP-05 | Model identities, aliases and context limits shall come from a refreshable model registry (operator config plus provider listing commands where available), not from adapter source code. | Must | [R2] | I, T | M4 |
| FR-ADP-06 | Claude Code and Codex adapters shall be delivered first. | Must | CAP-2, owner decision 2026-10-12 | T | M2 |
| FR-ADP-07 | Adapters for Grok Build, Antigravity and Cursor CLI shall be delivered. | Must | CAP-2 | T | M4 |
| FR-ADP-08 | An OpenCode adapter shall be delivered, using `opencode run` first. | Must | CAP-2, owner decision 2026-10-12 | T | M4 |
| FR-ADP-09 | A Kimi Code adapter shall exist only as a version-gated adapter that is disabled until the current Kimi Code CLI automation contract is pinned and passes conformance tests; it shall be enabled once that contract is pinned. | Must | CAP-2, [R2] Kimi, owner decision 2026-10-12 | T | M4 (blocked by B-1, see [ROADMAP §7](../ROADMAP.md#7-risks-blockers-and-open-questions)) |
| FR-ADP-10 | For harnesses that can front several model vendors (OpenCode, Cursor), usage records shall store both the harness and the actual backing provider/model. | Must | CAP-7, [R2] OpenCode | T | M4 |
| FR-ADP-11 | Each adapter shall pass a conformance suite covering success, task failure, native resume, auth missing, malformed output and cancellation, run against recorded fixtures without a live provider. | Must | BO-6 | T | M2 (Claude Code, Codex), M4 (others) |
| FR-ADP-12 | A Muse Code (Meta) adapter shall be delivered as a version-gated adapter over the headless `muse exec --json` mode, with the CLI's approvals and sandbox left on, the controller-owned worktree (`-w off`), no bypass flag (`--yolo`, `--disable-approval`, `--disable-sandbox`, `--trust-workspace`) outside an approved `privileged` scope, and the operator's native login (the controller shall not pass `META_API_KEY`). The success of a run shall not be inferred from the exit code. *(Proposed; every flag and event shape is unverified, see the [research note](../research/muse-code-2026-10-13.md) and Q-27.)* | Should | CAP-2, owner decision 16, [ADR-0009](../adr/0009-version-gated-adapters.md) | T | M4 |

### 3.3 Policy and trust profiles (`FR-POL`)

The five trust profiles and their intended semantics are:

| Profile | Files | Shell | Network | Repo-supplied hooks/MCP/agent config | Intended use |
| --- | --- | --- | --- | --- | --- |
| `inspect-untrusted` | Read-only | None | Off | Disabled | Unknown repositories, review |
| `edit-untrusted` | Isolated worktree only | Narrow allowlist | Off | Disabled | Edits without arbitrary execution |
| `test-sandboxed` | Isolated worktree | Build/test commands | Allowlisted hosts | Controller-approved only | Normal autonomous engineering |
| `trusted-development` | Worktree | Broader shell | Policy-based | Allowlisted | Known internal repositories |
| `privileged` | Explicit scope | Explicit scope | Explicit scope | Explicit scope | Operator-approved exceptional jobs |

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-POL-01 | The controller shall implement the five trust profiles above, configurable but not weakenable below the table's defaults without a config change recorded in the run's policy snapshot. | Must | CAP-3, [ADR-0004](../adr/0004-trust-profiles-no-bypass-flags.md) | T | M2 (`inspect-untrusted`, `edit-untrusted`), M3 (rest) |
| FR-POL-02 | Each adapter shall compile a profile into the strongest native controls it supports. If an adapter cannot satisfy a profile, it shall be ineligible for that profile; the controller shall never silently downgrade the profile. | Must | CAP-3 | T | M2 |
| FR-POL-03 | The controller shall not pass permission-bypass flags (`--dangerously-skip-permissions`, `--yolo`, `--force`, `--always-approve`, `--approve-mcps`, `--full-auto` or equivalents) except under `privileged` with a recorded operator approval that covers the run (FR-POL-09) and whose approved scope explicitly requests bypass and matches the scope the run was admitted with. *(Amended 2026-10-12 by owner decision 13: approval of a `privileged` run no longer implies bypass; see [ADR-0017](../adr/0017-approved-privileged-scope-bypass.md) and [LLD §3.1](../design/LLD.md#31-privileged-scope-m3). Amended 2026-10-13 by owner decision 17: "recorded for that run" became "that covers the run". Note 2026-10-13, owner decisions 19 and 22: the approval that covers the run may be one written by client policy for a client configured `privileged_approval: "not_required"` ([ADR-0019](../adr/0019-per-client-privileged-approval.md)); the scope must still request bypass explicitly and match. On Claude Code an approved bypass run omits `--restricted` ([ADR-0018](../adr/0018-claude-bypass-omits-restricted.md)).)* | Must | BO-3, [R2] | T, I | M2 |
| FR-POL-04 | Under `inspect-untrusted`, `edit-untrusted` and `test-sandboxed`, repository-supplied agent configuration (hooks, MCP server definitions, `CLAUDE.md`/`AGENTS.md`-style instructions, provider project config) shall not be loaded, using native switches such as Claude `--bare` where available. | Must | BO-3, [R2] | T | M2 |
| FR-POL-05 | An operation denied by policy or sandbox shall end the run with `PERMISSION_BLOCKED` or `SANDBOX_VIOLATION` rather than hang waiting for input. | Must | CAP-3 | T | M2 |
| FR-POL-06 | For untrusted profiles, arbitrary shell execution shall be disabled on any adapter that cannot confine agent-executed commands away from the provider's credential store. | Must | BO-3, [R2] credential boundary | T, A | M3 |
| FR-POL-07 | Each provider shall have a versioned compliance manifest (fields in [LLD §6](../design/LLD.md#6-compliance-manifest)); an adapter without a manifest covering the installed version shall be ineligible. | Must | BO-2, [ADR-0003](../adr/0003-no-credential-handling.md) | T, I | M2 |
| FR-POL-08 | The controller shall never modify global provider configuration (for example `~/.claude/settings.json`, `~/.grok/config.toml`); it shall use per-run arguments, environment or dedicated config directories. | Must | BO-3, [ADR-0012](../adr/0012-telemetry-at-wrapper-boundary.md) | T, I | M2 |
| FR-POL-09 | Runs under `privileged` shall require operator approval through the operator CLI. The approval is given for the first `privileged` run of a meta-session and covers later runs of the same meta-session from the same MCP client with the same scope, without expiry; any other scope, meta-session or client requires a new approval. Approval or denial shall be recorded with timestamp and scope, and a denied run ends `CANCELLED`. *(Amended 2026-10-13 by owner decision 17, which replaced "for that specific run"; see [ADR-0017](../adr/0017-approved-privileged-scope-bypass.md). Note 2026-10-13, owner decision 22 (realisation Delegated, [ADR-0019](../adr/0019-per-client-privileged-approval.md)): for an MCP client the operator configures with `privileged_approval: "not_required"`, the operator's configuration stands in for the per-scope CLI approval; the approval is still recorded (timestamp, scope, `decided_by = "client_policy:<client_id>"`), and Git-write denial (FR-GIT-01) and worktree isolation (FR-WS-05) still apply. The default, `"required"`, is this requirement unchanged.)* | Must | BO-3 | T | M3 |
| FR-POL-10 | Workspaces shall be accepted only under operator-configured allowed roots after path canonicalization (symlinks resolved). | Must | NFR-SEC-05 | T | M1 |

### 3.4 Authentication boundary (`FR-AUTH`)

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-AUTH-01 | The controller shall never initiate provider login, submit OAuth forms, read, copy or transform access/refresh tokens, scrape account dashboards, reimplement provider network protocols, patch provider binaries or move credentials between identities or machines. | Must | BO-2, [ADR-0003](../adr/0003-no-credential-handling.md) | I, T | M1 (code review gate), all |
| FR-AUTH-02 | Auth state shall be determined only by the provider's own status command or by a harmless headless call failing with an auth error; on failure the controller shall return `AUTH_REQUIRED` naming the provider and the native login command the operator should run. | Must | BO-2, CAP-2 | T | M2 |

### 3.5 Workspace management (`FR-WS`)

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-WS-01 | Every write-capable run shall execute in a controller-created Git worktree created from a recorded base checkpoint. | Must | CAP-4, [ADR-0006](../adr/0006-worktree-checkpoints-no-blind-replay.md) | T | M1 |
| FR-WS-02 | At most one write lease shall exist per worktree at a time; parallel tasks shall receive separate worktrees. | Must | CAP-4 | T | M1 |
| FR-WS-03 | After each run the controller shall record the changed-file list, a diff artifact and a post-run checkpoint commit on a controller-owned branch. Checkpoint commits are internal evidence and are never published (FR-GIT-08). | Must | CAP-4 | T | M1 |
| FR-WS-04 | If a run fails after mutating the workspace, the controller shall either roll back to the pre-run checkpoint or continue via native resume; it shall never replay the original request against the mutated state. | Must | CAP-4, [R2] retry semantics | T | M1 |
| FR-WS-05 | The controller shall not modify the operator's checked-out branch or working tree, and shall not push to remotes except through the controlled publication in FR-GIT-05, which is off by default; results are delivered as controller-owned branches plus diff artifacts. *(Amended 2026-10-12 by owner decision 7: the blanket no-push rule became push-only-through-injected-tools; see [ADR-0014](../adr/0014-tool-only-commits-and-publication.md).)* | Must | BO-3 | T | M1 (no push by default), M9 (controlled publication) |
| FR-WS-06 | Write-capable profiles shall require the workspace to be a Git repository; `inspect-untrusted` may operate on a non-Git directory read-only. | Must | CAP-4 | T | M1 |
| FR-WS-07 | Worktrees and controller branches shall be garbage-collected according to a configurable retention policy. | Should | NFR-DATA-01 | T | M3 |
| FR-WS-08 | Concurrent runs of one project shall each execute in their own controller-created Git worktree and hold their own write lease. No two concurrent runs of a project, in different meta-sessions, may share a worktree, and a `container` environment (FR-PRJ-05) mounts each run's worktree alone. *(Added 2026-10-13, Delegated under owner decision 41; see [ROADMAP §4.2](../ROADMAP.md#42-owner-decisions).)* | Must | CAP-4, owner decision 41 | T | M9 |
| FR-WS-09 | Worktrees created for concurrent runs of a project shall be removed when the run's changes are merged or its meta-session is abandoned, whichever happens first. The controller branch and diff artifact stay until retention GC (FR-WS-07). *(Proposed 2026-10-13, Delegated under owner decision 41, not accepted: until it is, [FRD §4.4](FRD.md#44-worktree-disposition-per-terminal-state) applies unchanged. Open question Q-54 asks how a merge is detected.)* | Should | CAP-4, owner decision 41 | T | M9 |

### 3.6 Meta-sessions and continuity (`FR-SES`)

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-SES-01 | The controller shall generate opaque, unique meta-session IDs and map each to zero or more provider-native session bindings. | Must | CAP-5 | T | M1 |
| FR-SES-02 | Each meta-session shall hold a canonical state record: objective, constraints, repository root/worktree/base/head, decisions, changed files, verification results, open work and provider bindings. | Must | CAP-5, [ADR-0001](../adr/0001-controller-owned-canonical-state.md) | T | M1 (schema), M5 (populated across providers) |
| FR-SES-03 | Continuing a meta-session on the same provider shall use the provider's native resume with the stored native session ID. | Must | CAP-5 | T | M2 (Claude), M5 (all) |
| FR-SES-04 | Continuing on a different provider shall build a handoff bundle solely from controller-owned evidence (goal, constraints, decisions, Git base/head, changed files, relevant diff excerpts, latest diagnostics, failed attempts, open tasks, paths to inspect) and instruct the new agent to inspect the repository; the controller shall not parse provider transcript files. Text fields of the bundle may be condensed by the inner agent only as FR-INN-13 allows. | Must | CAP-5, [ADR-0001](../adr/0001-controller-owned-canonical-state.md) | T, I | M5 |
| FR-SES-05 | Decisions and run events shall be append-only; the handoff view shall be regenerable from them. | Must | CAP-5 | T | M1 (events), M5 (handoff view) |
| FR-SES-06 | A meta-session shall have at most one non-terminal run at a time; `continue_task` on a meta-session with an active run fails with `INVALID_REQUEST`. *(Note 2026-10-13, Delegated decision 28, R-42: `continue_task` on an `ARCHIVED` meta-session, one that retention GC has collected or is collecting, also fails with `INVALID_REQUEST`.)* | Must | CAP-5, FR-WS-02 | T | M1 |

### 3.7 Routing (`FR-RTE`)

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-RTE-01 | Routing shall first remove ineligible providers using hard constraints: trust profile support, write/shell/network needs, sandbox strength, minimum capability, required tools, platform, auth state, version state, compliance manifest, known quota exhaustion, concurrency and health. | Must | CAP-6, [ADR-0008](../adr/0008-two-stage-routing.md) | T | M2 (eligibility only), M7 (full) |
| FR-RTE-02 | Eligible providers shall be ranked by a weighted score over estimated success, latency, capacity risk, security risk, handoff cost and monetary cost, with operator-configurable static weights. *(Amended 2026-10-13, owner decision 40: the score ranks only the candidates left when affinity is absent or has ended, that is a project's first run or after a switch reason under FR-RTE-07; it never moves a project that has an eligible affine provider, FR-RTE-06.)* | Must | CAP-6 | T | M7 |
| FR-RTE-03 | Every routing decision shall be persisted with its input features, weights, candidate scores and outcome so it can be reproduced and explained. *(Amended 2026-10-13, owner decision 40: the record also carries the project's affinity provider and model, whether affinity held, and the `affinity_switch_reason` when it did not.)* | Must | CAP-6, BO-5 | T | M7 |
| FR-RTE-04 | A heuristic task classifier shall estimate context volume, tool/autonomy needs and reasoning depth from the request and repository metadata. *(Amended 2026-10-13: when the operator enables it, the inner agent may supply the same features as a labelled alternative source under FR-INN-12; the heuristic remains the baseline and the fallback.)* | Should | CAP-6, [R1], [R2] | T | M7 |
| FR-RTE-05 | Empirical or contextual-bandit learning of routing weights. | Deferred | CAP-6, [R2] | — | Deferred |
| FR-RTE-06 | For each project (the workspace for requests with `workspace_path`) the controller shall record the last provider and model that completed a run and keep routing the project there. Among providers that pass FR-RTE-01, the affine one shall be chosen; the weighted score of FR-RTE-02 shall not be used to move a project, and no round-robin or load spreading across providers for one project shall exist. This applies across meta-sessions in the project; FR-SES-03 still governs resume within one. | Must | CAP-6, BO-9, owner decision 40, [ADR-0032](../adr/0032-provider-model-affinity.md) | T | M7 |
| FR-RTE-07 | Affinity shall end only for a reason in this closed list, each recorded as an enumerated `affinity_switch_reason` in the routing decision (FR-RTE-03): `user_request` (`require_provider`, an explicit provider or model in the request, or an operator `affinity reset`); `capacity_exhausted` (FR-CAP-06 `QUOTA_EXHAUSTED`, or the FR-CAP-02 estimate at or below a configured low-water mark with at least a configured confidence); `ineligible` (FR-RTE-01 removes the affine provider: capability, profile, auth, version, circuit breaker open); `failed_after_retry` (FR-CAP-05 exhausted). A better score, lower cost or lower load is not a reason. After a switch the new provider becomes the project's affinity; the controller shall not return to the old one on its own when it recovers (Q-51); only a reason from this list moves it again. | Must | CAP-6, BO-9, BO-5, owner decision 40, [ADR-0032](../adr/0032-provider-model-affinity.md) | T | M7 |
| FR-RTE-08 | When the request names no model, the controller shall reuse the project's last model for the chosen provider, else the adapter default; a model changes only for `user_request` or `ineligible`. | Should | CAP-6, BO-9 | T | M7 |
| FR-RTE-09 | Prompt assembly should be cache-friendly: stable content (project instructions, constraints) first, volatile content (task text, retrieved snippets) last, and no reordering between runs of a project. The cache benefit per provider is unverified. | Could | CAP-6, BO-9 | I | M7 |

### 3.8 Capacity, scheduling and resilience (`FR-CAP`)

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-CAP-01 | The controller shall record usage observations exactly as each provider reports them, labelled by source, and keep reported values separate from controller estimates. | Must | CAP-7, [ADR-0007](../adr/0007-capacity-as-confidence-estimate.md) | T | M2 (record), M6 (use) |
| FR-CAP-02 | The controller shall maintain a per-provider capacity estimate with `capacity_score`, `confidence`, `sources`, `explicit_remaining` (only when the provider reports it), `reset_at`, `concurrency_available` and `throttle_risk`. | Must | CAP-7 | T | M6 |
| FR-CAP-03 | No interface or log shall present an estimate as provider-authoritative remaining quota. | Must | CAP-7, BO-5 | T, I | M6 |
| FR-CAP-04 | Ingress shall use a bounded priority queue; each provider shall have a concurrency limit and a circuit breaker. | Must | CAP-7 | T | M1 (queue, global limit), M6 (per-provider breaker) |
| FR-CAP-05 | Only `RATE_LIMIT_TRANSIENT`, `PROVIDER_OVERLOADED` and pre-mutation `PROCESS_CRASH` failures shall be retried automatically, with capped exponential backoff and jitter, and only when the workspace is unchanged since the pre-run checkpoint (otherwise FR-WS-04 applies). | Must | CAP-7, [R2] | T | M6 |
| FR-CAP-06 | On `QUOTA_EXHAUSTED`, the controller shall fail over to another eligible provider if the request permits, queue if a reset time is known within a configured horizon, and otherwise return `QUOTA_EXHAUSTED`. *(Amended 2026-10-13, owner decision 40: a capacity failover re-bases the project's affinity on the provider it lands on, with reason `capacity_exhausted`, FR-RTE-07.)* | Must | CAP-7 | T | M6 |
| FR-CAP-07 | A token-bucket rate gate shall be applied to a provider only when that provider publishes enforceable rate limits for the auth mode in use. | Could | [R2] | T | M6 |
| FR-CAP-08 | Where a provider CLI reports cache read or creation token counts, the controller shall record them as usage observations labelled by source (FR-CAP-01), and expose per project the count of runs that kept the previous provider and model versus switched, by reason. Which providers report cache tokens is unverified (Q-53). These figures are evidence for the operator, not a claim of cache hits. | Should | CAP-7, BO-9, BO-5, owner decision 40 | T | M6 |

### 3.9 Execution supervision (`FR-EXE`)

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-EXE-01 | Provider processes shall run in their own process group with a wall-clock timeout; cancellation and timeout shall terminate the whole group (graceful signal, then forced kill after a grace period). | Must | CAP-1 | T | M1 |
| FR-EXE-02 | The supervisor shall support the subprocess + JSON/JSONL transport. | Must | [ADR-0002](../adr/0002-mcp-upstream-acp-downstream.md) | T | M1 |
| FR-EXE-03 | The supervisor shall support an ACP stdio client transport for providers that expose ACP. | Should | [R2] | T | M4 |
| FR-EXE-04 | The supervisor shall support a persistent local-service transport (OpenCode `serve`/`attach`). | Deferred | [R2] | — | Deferred |
| FR-EXE-05 | Structured stdout events and stderr diagnostics shall be captured separately and stored as artifacts. | Must | CAP-8 | T | M1 |
| FR-EXE-06 | On startup the controller shall reconcile runs left in non-terminal states: dead processes are marked `PROCESS_CRASH` with cause `controller_restart`, and their worktrees are assessed for mutation before any further action. Provider process groups still alive from the previous controller are terminated first. Reconciliation completes before the MCP server accepts calls. | Must | NFR-REL-01 | T | M1 |
| FR-EXE-07 | Provider subprocesses shall receive an environment built from an explicit allowlist plus adapter-declared variables; no other controller environment shall be inherited. | Must | NFR-SEC-02 | T | M1 |
| FR-EXE-08 | When a request supplies verification commands, the controller shall run them in the run's worktree under the same trust profile after the agent finishes and record the results. | Should | CAP-1 | T | M3 |

### 3.10 Telemetry and audit (`FR-TEL`)

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-TEL-01 | Every run lifecycle step shall append a `run_event` record. | Must | CAP-8 | T | M1 |
| FR-TEL-02 | The controller shall export OpenTelemetry traces following the span structure in [LLD §7](../design/LLD.md#7-telemetry-spans) to an operator-configured endpoint. | Should | CAP-8, [ADR-0012](../adr/0012-telemetry-at-wrapper-boundary.md) | T | M8 |
| FR-TEL-03 | Raw prompts, credentials, environment variables and full shell output shall not appear in telemetry attributes or logs; large outputs are stored as access-controlled artifacts referenced by ID and hash. | Must | BO-2, NFR-PRIV-01 | T, I | M1 |
| FR-TEL-04 | A read-only usage dashboard. | Deferred | [R1] constraint allows it | — | Deferred |

### 3.11 Operator CLI (`FR-OPS`)

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-OPS-01 | The operator CLI shall provide `serve` (start the MCP server on stdio), `doctor` (run preflight for every adapter and print status and any `AUTH_REQUIRED` instructions), `runs list`, `runs show <id>` and `runs cancel <id>`, each with plain-text output that does not rely on colour and a `--json` option for scripts. | Must | CAP-9 | T, D | M1 (`doctor` with fake adapter, `runs`), M2 (`serve`) |
| FR-OPS-02 | The operator CLI shall provide `approve <run_id>` and `deny <run_id>` for `privileged` runs, and `adapters validate <provider>`, which runs the adapter's preflight and its live conformance subset against the installed binary and, on success, records that version as accepted. | Must | CAP-9, FR-POL-09, FR-ADP-03 | T | M3 (`approve`, `deny`), M4 (`adapters validate`) |
| FR-OPS-04 | The operator shall configure Switchboard through one schema-validated config file covering the data directory, allowed workspace roots, concurrency limits, provider enablement and tier weights, and named MCP client entries with their maximum trust profile; `serve --client <name>` binds the stdio session to one client entry, which is the caller identity used by FR-MCP-06. | Must | CAP-3, CAP-9 | T | M1 |
| FR-OPS-05 | The operator CLI shall provide `capacity`, showing the same estimates and sources as `get_capacity`. | Should | CAP-7, BO-5 | T | M6 |
| FR-OPS-03 | The product shall have no web interface and no login commands. | Must | [R1] constraint, BO-2 | I | M1 (kept in all later milestones) |

### 3.12 Projects and contexts (`FR-PRJ`)

Added 2026-10-12 from owner decision 6 ([ADR-0013](../adr/0013-projects-environments-and-contexts.md)): Switchboard
manages *projects*, the environments the coding agents operate from (likely containers) and the *contexts* of those
projects, such as repositories. zemdregon answered Q-7 on 2026-10-12: the orchestrator may create and change projects over
MCP (FR-PRJ-10). The container runtime and provider-login mechanism (Q-6) are a **Delegated, Proposed** choice, not an
owner decision ([ROADMAP §7.3](../ROADMAP.md#73-open-questions-for-zemdregon-not-blocking-m2-unless-noted)).
On 2026-10-13 zemdregon added ([owner decision 24](../ROADMAP.md#42-owner-decisions)) that host-run and container-run agents
are both supported, as the deployer chooses, and that a container image carries no Git tool, so Git is done by
Switchboard on the host (FR-PRJ-04, FR-PRJ-05 and FR-GIT-01 carry dated notes).

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-PRJ-01 | The controller shall manage projects. A project has a stable ID, a name, exactly one environment definition (FR-PRJ-04) and one or more contexts (FR-PRJ-02), and is defined in the schema-validated configuration (FR-OPS-04). | Must | CAP-10, owner decision 6 | T | M9 |
| FR-PRJ-02 | A context is a resource a project's agents work with. The only context kind delivered is `repository`: a local Git repository whose canonical path lies under an allowed root (FR-POL-10), with a base ref, a push policy (FR-GIT-05) and a commit identity (FR-GIT-04). A context of an unknown kind shall fail configuration validation. | Must | CAP-10, FR-POL-10, NFR-SEC-06 | T | M9 |
| FR-PRJ-03 | `delegate_task` shall accept a project reference as an alternative to a workspace path, and a read-only `list_projects` tool shall list the projects the calling MCP client may use. Runs and meta-sessions shall record their project, and a meta-session shall stay in the project it was created in. A request naming both or neither of a project and a workspace path fails `INVALID_REQUEST`. | Must | CAP-10, CAP-1, FR-MCP-09 | T | M9 |
| FR-PRJ-04 | The controller shall support the environment kinds `host` (agent processes run directly on the operator's machine, as in M1 to M3) and `container` (FR-PRJ-05). The environment kind and, for containers, the image digest shall be recorded in the run's policy snapshot. *(Amended 2026-10-13, owner decision 24: both kinds are first-class and stay supported; the kind is chosen per project by whoever deploys Switchboard (configuration, or an approved dynamic project, FR-PRJ-10), and neither replaces the other. A request naming a workspace path rather than a project runs in `host`.)* | Must | CAP-10, FR-POL-01 | T | M9 (`host`), M10 (`container`) |
| FR-PRJ-05 | For a `container` environment the controller shall run the provider process inside a container that mounts only the run's worktree (writable) and declared read-only contexts. It shall not mount the operator's home directory, the controller data directory, Git push credentials or a container-runtime socket. Provider logins reach the container only through the operator running the provider's native login inside the project's container volume (Proposed, ADR-0013); no provider credential shall be copied or moved by the controller (FR-AUTH-01). It shall apply the run's network policy and configured CPU, memory and disk limits, and remove the container when the run ends. *(Amended 2026-10-13, owner decision 24; mechanism Delegated, Proposed: the image shall contain no Git client, at least no `git` and no `gh` executable on the container's `PATH`; `projects validate` and container creation check this, and an image that fails the check starts no run. Git operations for the run (diff, checkpoints, commit, push) are done by the controller on the host, FR-GIT-02 to FR-GIT-09.)* | Must | CAP-10, BO-3, FR-POL-06 | T, A | M10 |
| FR-PRJ-06 | A project may declare a maximum trust profile and a set of allowed providers. The effective maximum profile of a request is the lower of the calling client's maximum (FR-MCP-06) and the project's; a client may use only the projects listed in its configuration entry. A request outside either limit fails `PERMISSION_BLOCKED` before any side effect. | Must | CAP-10, CAP-3, FR-MCP-06 | T | M9 |
| FR-PRJ-07 | Environment lifecycle steps (create, start, stop, remove) shall be recorded as run events. Startup reconciliation (FR-EXE-06) shall find and remove containers left by a previous controller before assessing worktrees. | Must | CAP-10, NFR-REL-01 | T | M10 |
| FR-PRJ-08 | The operator CLI shall provide `projects list`, `projects show <id>` and `projects validate`, which checks configuration, repository paths, base refs and environment availability without starting a run; plain text and `--json` as in FR-OPS-01. | Should | CAP-10, CAP-9 | T | M9 (`host`), M10 (`container` checks) |
| FR-PRJ-09 | Removing a project from the configuration shall not delete its run history. Retention (FR-WS-07, NFR-DATA-01) shall remove a project's containers and volumes together with its worktrees, branches and artifacts. | Should | CAP-10, NFR-DATA-01 | T | M10 |
| FR-PRJ-10 | An MCP client whose configuration entry sets `manage_projects` (default off) shall be able to create, update and delete *dynamic projects* with `create_project`, `update_project` and `delete_project`. A dynamic project is validated exactly like a configured one (FR-PRJ-01, 02), is stored in the ledger as append-only revisions, is snapshotted into runs as in FR-PRJ-01, and is visible only to the client that created it plus the operator. Configured projects can never be changed over MCP. Its limits are the creating client's: the repository path under an allowed root (FR-POL-10); the trust ceiling and provider set no wider than the client's; a push policy no wider than the client's `max_push_policy` (default `none`). A `container` environment, any push policy other than `none`, and any later widening take effect only after the operator approves that revision through the CLI (`projects approve`, never through MCP); until then the project cannot start runs. Deleting a project with a non-terminal run fails `INVALID_REQUEST`; history is kept (FR-PRJ-09). Every call, accepted or refused, is recorded as an event. | Must | CAP-10, owner decision 8, FR-MCP-06, NFR-SEC-06 | T | M9 (`host`), M10 (`container` approval) |

### 3.13 Agent Git boundary, commits and publication (`FR-GIT`)

Added 2026-10-12 from owner decision 7 ([ADR-0014](../adr/0014-tool-only-commits-and-publication.md)): agents have no
commit or push ability. Commits and pushes are made only by Switchboard-injected tools, so a commit looks the same as any
other commit: no co-author trailer, no "generated by" footer, no session ID. The controller still keeps an internal audit
trail of which agent produced which commit (FR-GIT-07). Provider-specific switches that disable a provider's own commit
or attribution behaviour are **not** documented in the verified research ([R2]); the per-provider mechanism is *to be
verified* ([TDD §3.10](../design/TDD.md#310-git-commits-attribution-and-publication)).

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-GIT-01 | Agents shall have no ability to create commits, create or move refs, or push. Each adapter shall compile every write-capable profile so that the provider's documented permission controls deny Git write operations and its own commit and attribution features are not used. Where a provider documents no such control the adapter shall declare that, and FR-GIT-03 and FR-GIT-06 become the remaining controls. *(Amended 2026-10-13, owner decision 24: in a `container` environment this requirement holds by construction, because the image has no Git client and neither the repository's Git directory nor any credential store is mounted (FR-PRJ-05); adapters still compile their deny rules there, but the requirement does not rest on them, including in approved bypass runs. In a `host` environment the controls above, FR-GIT-03 and FR-GIT-06 remain the controls.)* | Must | CAP-11, BO-7, owner decision 7, FR-POL-02 | T, I | M2 (argv and policy inspection), M9 (malicious fixtures) |
| FR-GIT-02 | The controller shall offer agents injected tools, `commit` and, where the context's push policy allows it, `push`, through a per-run channel (a controller-supplied MCP definition, written to no global provider config, FR-POL-08). The tools shall run in the controller, outside the agent's process tree, and shall be the only path by which agent work becomes a commit or reaches a remote. Each adapter shall declare whether it can receive the channel without a permission-bypass flag (FR-POL-03); one that cannot uses the finalize-only mode (FR-GIT-09). | Must | CAP-11, owner decision 7 | T | M9 |
| FR-GIT-03 | The controller shall snapshot the repository's refs before and after each run and check the run branch. A ref created, moved or deleted, or a commit made, other than by the controller shall be a Git policy violation: its content is kept as working-tree changes, the commits are never published, a `git_policy_violation` run event is appended and `runs show` reports it. *(Note 2026-10-13, T9.5, Delegated; text above unchanged: built for every worktree run, see [LLD §12.5](../design/LLD.md#125-ref-snapshot-and-violation-handling) and [ADR-0027](../adr/0027-ref-snapshots-and-violation-handling.md); the controller restores only its own refs and reports the others; verified with the fake adapter only.)* | Must | CAP-11, BO-3 | T | M9 |
| FR-GIT-04 | A commit made through the commit tool shall use the context's configured author and committer identity and a message produced from the agent's text after sanitisation. The controller shall add no trailer, footer, signature line or identifier of its own. Sanitisation shall remove attribution trailers (for example `Co-authored-by:`), "generated by"-style footers and controller, provider, run or session identifiers, using a built-in pattern set plus operator-configured patterns. *(Amended 2026-10-13: the message text may come from the agent or, when the operator enables it, from the inner agent under FR-INN-10; either way it passes this sanitisation and nothing else changes.)* | Must | CAP-11, BO-7, owner decision 7 | T, I | M9 |
| FR-GIT-05 | Pushes shall happen only through the push tool or an operator command, under the context's push policy: `none` (the default) or `branch` (push the publish ref to a configured remote under a configured branch-name prefix). The controller shall never force-push; push the operator's checked-out branch, the repository default branch, run branches, checkpoint commits, tags or notes; or push without recording the attempt and its result. | Must | CAP-11, BO-3, owner decision 7 | T | M9 |
| FR-GIT-06 | Credentials used to push or sign (SSH keys and agent, credential helpers, tokens) shall be used only by controller-side Git operations through the operator's existing Git configuration. The controller shall not store them (NFR-SEC-01) or pass them to an agent (FR-EXE-07). A context whose push policy is not `none` is ineligible for a run whose agent can execute commands that could read those credentials (a `host` environment with shell access, mirroring FR-POL-06). *Note 2026-10-13 (owner decision 37; Delegated narrow reading; no ID change): an approved bypass run is exempt from this ineligibility and is offered the controller `push` tool, with `bypass_exempt` recorded; the controller still never passes the credentials to the agent. This is the one place a bypass run's agent can reach push credentials, by the owner's choice (R-51).* | Must | CAP-11, BO-3, FR-POL-06 | T, A | M9 |
| FR-GIT-07 | For every commit made through the commit tool the controller shall append a provenance record linking commit SHA, tree hash and patch ID to project, context, meta-session, run, provider, model, adapter version, the tool-call event and the sanitiser report (rule names and counts, never content), plus remote and ref once pushed. Records are append-only and retrievable through `runs show`; the commit itself shall not contain them. | Must | CAP-11, BO-5, BO-7 | T | M9 |
| FR-GIT-08 | Checkpoint commits, run branches and other controller refs (FR-WS-03) are internal and shall never be pushed or used as published history. Published commits shall be created only by the commit tool, onto a publish ref separate from the run branches. | Must | CAP-11, FR-WS-03 | T | M9 |
| FR-GIT-09 | For an adapter that cannot receive the injected channel (FR-GIT-02), and when the operator enables it for the context, the controller shall create the commit itself at finalization from the run's worktree changes, with a message taken from the agent's structured final summary, subject to FR-GIT-04 to FR-GIT-08. *(Note 2026-10-13, T9.7, Delegated; text above unchanged: built with the context key `finalize_commit`, for adapters whose channel is not `injected`, after the ref check and the evidence checkpoint of a run that succeeds; it fails closed with a recorded reason and never changes the run's outcome. See [LLD §12.3](../design/LLD.md#123-commit-algorithm-and-refs) and ROADMAP decision 38; verified with the fake adapter only.)* | Should | CAP-11, owner decision 7 | T | M9 |
| FR-GIT-10 | A context may set `sign: true` (default off). The controller then signs each published commit through the operator's existing Git signing configuration, used only by controller-side Git operations (FR-GIT-06): the key or agent is never stored, never passed to an agent and never read by the controller. If signing fails the commit call returns a tool error and no unsigned commit is made; the controller never falls back. Signing is refused for a context whose environment lets the agent reach the signing key (the BR-31 rule). The signature carries only the operator's key identity, never a run or session identifier. | Should | CAP-11, owner decision 9, FR-GIT-06 | T | M9 |

### 3.14 Inner agent (`FR-INN`)

Owner decision 14 (2026-10-13, [ROADMAP §4.2](../ROADMAP.md#42-owner-decisions)) adds the inner agent. Everything below
that is not in that decision's wording is **Delegated** and **Proposed**: the backend kinds, the task list and its
priorities, the validation and fallback rules, and the privacy rules. The design is in
[ADR-0016](../adr/0016-inner-agent.md) and [LLD §13](../design/LLD.md#13-inner-agent); the task catalogue and the
recommendation on each candidate task are in [PRD §3.1](PRD.md#31-inner-agent-task-catalogue). All requirements in this
group first ship in M11.

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-INN-01 | The controller shall support one optional inner agent, configured by the operator (FR-INN-03, FR-INN-04). With none configured, or while it is switched off or unhealthy, every inner task shall use its deterministic fallback (FR-INN-08) and no other controller behaviour shall change. Switchboard shall ship with no default backend and no default model. | Must | CAP-12, BO-8, owner decision 14 | T | M11 |
| FR-INN-02 | An inner call shall be a stateless, single-turn text completion: no tools, no file, shell or network access offered to the model, no memory between calls and no multi-step loop. The controller, not the model, performs every action that follows from the output. | Must | CAP-12, BO-3 | T, I | M11 |
| FR-INN-03 | The `http` backend kind shall call an operator-configured chat-completion endpoint and model chosen only from the configuration file. The configuration shall hold no credential value; a service that needs a key shall be reached through an operator-run local gateway that holds it, or through the `cli` kind (ADR-0003 and FR-AUTH-01 stay unchanged). | Must | CAP-12, BO-2, [ADR-0003](../adr/0003-no-credential-handling.md) | T, I | M11 |
| FR-INN-04 | The `cli` backend kind shall run an installed provider CLI once, headless, with an operator-chosen model, the first being `opencode run` (FR-ADP-08). The run shall use an empty temporary directory, a minimal environment (FR-EXE-07) and the CLI's documented controls to offer no tools; if those controls cannot be shown to apply for the installed version, the backend shall be reported ineligible rather than run. The CLI keeps its own login (FR-AUTH-01). *(Proposed; CLI flags unverified, see Q-26.)* | Should | CAP-12, FR-ADP-08, [R2] | T | M11 |
| FR-INN-05 | Inner tasks shall be those in the PRD catalogue marked in scope. Each task shall be enabled individually in the configuration (none by default) and shall have a versioned prompt template, an input budget, an output schema, a validator and a deterministic fallback, all defined in the LLD. | Must | CAP-12 | T, I | M11 |
| FR-INN-06 | No inner-agent output shall be an input to any security or policy decision: trust profile choice or compilation, the policy snapshot, provider eligibility (FR-RTE-01), approvals, client or project ceilings, push policy, the message sanitiser's rules (FR-GIT-04), secret redaction (FR-TEL-03), failure classification (FR-CAP-05) or the status, exit code or pass/fail of any run or verification command. The inner-agent service shall not be reachable from COMP-POL, the adapters' profile compilers, the retry logic or the push path. | Must | CAP-12, BO-3, NFR-SEC-06 | T, I | M11 |
| FR-INN-07 | Every inner output shall be treated as untrusted data: parsed against the task's schema, length-bounded, stripped of control characters and rejected if invalid. At most one re-ask per call is allowed; after that the fallback applies. | Must | CAP-12, NFR-SEC-05, NFR-SEC-06 | T | M11 |
| FR-INN-08 | An inner-agent failure (unreachable, timeout, error, invalid output, open circuit) shall never fail or cancel a run and shall never block a caller longer than the configured per-call bound. The task shall use its deterministic fallback, the event shall be recorded, and `doctor` shall show the inner agent as degraded. A per-backend circuit breaker shall stop calls after repeated failures until a probe succeeds. | Must | CAP-12, NFR-REL-02 | T | M11 |
| FR-INN-09 | The controller shall record the outcome of every inner call (accepted, rejected by validator, rejected by sanitiser, fallback used) and shall suspend a task automatically when its rejection rate over a configured window exceeds a configured threshold, until the operator re-enables it. *(Proposed; thresholds are proposed targets.)* | Should | CAP-12, BO-5 | T | M11 |
| FR-INN-10 | When the commit-message task is enabled, the controller may draft a commit message from the diff of the paths being committed, in one of three modes: `draft_if_missing` (default; the agent's own message always wins), `always`, or `never`. The prompt shall contain no controller, provider, run or session identifier and no provider name. The drafted message shall pass the FR-GIT-04 sanitiser; if it is empty afterwards, invalid or unavailable, the commit tool shall return a tool error asking the agent to supply a message, and the controller shall not invent one. | Must | CAP-12, CAP-11, BO-7, BO-8, [ADR-0014](../adr/0014-tool-only-commits-and-publication.md) | T | M11 |
| FR-INN-11 | When the PR-draft task is enabled, the controller may draft a pull-request title and description for a meta-session's publish ref and store it as a `pr_draft` artifact. The draft shall pass the same sanitiser as commit messages. Switchboard shall not open, edit or comment on pull requests. | Should | CAP-12, BO-7, BO-8 | T | M11 |
| FR-INN-12 | When the routing-classification task is enabled, the inner agent may supply the FR-RTE-04 features as an enumerated structure. They are scoring inputs only: never used for eligibility, never able to override `require_provider` or hints (FR-MCP-05), stored in the route decision with their source (`inner` or `heuristic`), model and template version, and used by replay from the stored value without calling the model again (FR-RTE-03). | Should | CAP-12, CAP-6, [ADR-0008](../adr/0008-two-stage-routing.md) | T | M11 |
| FR-INN-13 | When enabled, the inner agent may condense controller-owned evidence into prose: handoff-bundle text fields (FR-SES-04) and the log or verification-output summaries in artifacts and envelopes. Structured fields, statuses, exit codes and counts shall come only from controller records; each condensed field shall be labelled with its source and keep a pointer to the raw artifact by ID and hash; on fallback the raw text shall be truncated deterministically instead. | Should | CAP-12, CAP-5, BO-4 | T | M11 |
| FR-INN-14 | When enabled, the inner agent may generate a short run title and one-line summary for listings. | Could | CAP-12, BO-5 | T | M11 |
| FR-INN-15 | Inner-agent usage shall be recorded in its own `inner_call` records (task, backend, model, tokens as reported or unknown, latency, outcome) and shall never be written as a provider `usage_observation`, counted in a capacity estimate, or reduce `capacity_score`. If the operator declares that the backend draws on the same subscription as a routed provider (`shares_subscription_with`), the controller shall additionally record a `usage_observation` for that provider with source `inner_agent`, and `doctor` shall warn that the inner agent is consuming that provider's capacity. | Must | CAP-12, CAP-7, ADR-0007, BO-5 | T | M11 |
| FR-INN-16 | Each backend shall be classified `local` (loopback or a Unix socket on the host) or `remote` (anything else). A `remote` backend is unusable until the operator sets `allow_remote`. Tasks that send repository content (diffs, log excerpts) to a `remote` backend additionally need `allow_source_content` for that task; tasks that send only the request's objective text (routing features, run titles) need `allow_remote` alone *(Assumption)*. A project or context may set `inner_agent` to `off` or `local_only`. Before every call the controller shall apply its deterministic secret redaction to the prompt (FR-TEL-03), and shall not store or log prompt or response bodies beyond what the accepted result already is (sizes and hashes only). | Must | CAP-12, BO-2, NFR-PRIV-01, NFR-SEC-01 | T, I | M11 |
| FR-INN-17 | The operator CLI shall show the inner agent in `doctor` (reachable, locality, model answers a fixed canary within schema, enabled tasks, degraded or suspended state) and provide `inner status` (per-task counts and fallback rates from the ledger) `inner test <task>` (runs the task on a built-in fixture containing no repository data) and `inner resume <task>` (re-enables a task suspended under FR-INN-09). | Should | CAP-12, CAP-9 | T, D | M11 |
| FR-INN-18 | Model-assisted secret or PII detection as an additional, add-only redaction pass. Redaction stays deterministic (FR-TEL-03); no inner-agent verdict may remove or skip a redaction. | Deferred | CAP-12, [ADR-0016](../adr/0016-inner-agent.md) | — | Deferred |

### 3.15 Retrieval index (`FR-RAG`)

Owner decision 40 (2026-10-13, [ROADMAP §4.2](../ROADMAP.md#42-owner-decisions)) asks for an automatic per-project
retrieval index (RAG or vector store) to reduce context requirements, and possibly a deployment-wide one. Everything
below that is not in that decision's wording is **Delegated** and **Proposed**: the modes, exclusions, gates, bounds and
sharing rules. The design is in [ADR-0031](../adr/0031-retrieval-index.md); the privacy gates reuse those of the inner
agent (FR-INN-03, FR-INN-16). All requirements in this group first ship in M12.

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-RAG-01 | When a project has retrieval enabled, the controller shall build and incrementally maintain an index of the project's readable contexts in the data directory, never in the repository. Mode `auto` (the **Proposed** default) is on if and only if an embedding backend is configured; `off` and `on` also exist. | Should | CAP-13, BO-9, owner decision 40 | T | M12 |
| FR-RAG-02 | Only files inside a context root shall be indexed. The scanner shall skip `.git`, nested repositories ([ADR-0022](../adr/0022-nested-repositories-excluded-from-controller-git.md)), symlinks leaving the root, binary files, files over a size cap, ignored files, and a built-in secret denylist (env files, key and certificate files, credential-looking names) plus operator `exclude`. Chunk text shall pass the same redaction as FR-INN-16 before embedding and storage. The denylist is best effort (R-56). | Must | CAP-13, BO-9, NFR-SEC-01 | T | M12 |
| FR-RAG-03 | There shall be one store per project. No run, tool or query for one project shall read another project's index (except FR-RAG-09 and FR-RAG-10), and the store shall be deleted with its project. | Must | CAP-13, BO-9 | T | M12 |
| FR-RAG-04 | Embeddings shall come from a backend port with kinds `local` and `http`, reusing the inner-agent locality classification and gates (FR-INN-03, FR-INN-16): a `remote` backend sees source content only with both `allow_remote` and `allow_source_content`. Switchboard shall handle no API key or credential ([ADR-0003](../adr/0003-no-credential-handling.md), Q-23). With no backend the feature shall be inert and every behaviour unchanged. | Should | CAP-13, BO-2, BO-9 | T | M12 |
| FR-RAG-05 | At admission the controller may prepend retrieved snippets to the delegated prompt within `max_context_tokens` (**Proposed** default to be fixed in T12.0; no number is stated here), each snippet labelled with path, index revision, score and a marker that it is untrusted reference data. The pack shall be omitted when empty or too stale. The original request text shall be stored unchanged; the ledger records snippet ids and hashes, not copies. | Should | CAP-13, BO-9, BO-1 | T | M12 |
| FR-RAG-06 | The MCP tool `search_project_context` shall be read-only, shall show a client only its projects (FR-PRJ), shall bound result count and size, and shall return no paths outside the project. | Should | CAP-13, BO-9 | T | M12 |
| FR-RAG-07 | Retrieved content is untrusted data and shall never be an input to any security or policy decision: profile choice or compilation, policy snapshot, eligibility, approvals, ceilings, push or commit (mirrors FR-INN-06). | Must | CAP-13, BO-3 | T, I | M12 |
| FR-RAG-08 | Results shall carry the index revision and the source file hash. A snippet whose file changed or was deleted since indexing shall be dropped or re-read; an index built from a different base ref than the run's worktree shall be flagged. Failure of any retrieval step shall fall back to no retrieval and never fail the run. | Must | CAP-13, BO-9 | T | M12 |
| FR-RAG-09 | An optional deployment-wide index (`rag.global`, default off) shall be a separate store holding operator-added local knowledge sources and content that projects explicitly contribute (`contribute_to_global`, default false). Content of `untrusted` contexts shall not contribute by default. | Should | CAP-13, BO-9, owner decision 40 | T | M12 |
| FR-RAG-10 | A run shall read the global index only if its project sets `use_global: true` (default false). Each global snippet shall be labelled with its origin project. A snippet from project A shall not reach project B unless A contributes and B uses. The same locality gates and the run's profile apply. | Must | CAP-13, BO-3, BO-9 | T | M12 |
| FR-RAG-11 | Caps shall bound files, chunks, bytes and build time. Building shall run in the `serve` daemon in the background and never block admission; a partial index shall be marked incomplete. Operator commands `switchboard index {status,rebuild,clear} [project]` shall write only operator records. | Should | CAP-13, BO-9 | T | M12 |
| FR-RAG-12 | Embedding calls shall be recorded separately (counts, durations, backend id; no content) and shall never enter `usage_observation` or capacity (as FR-INN-15). | Should | CAP-13, BO-5 | T | M12 |
| FR-RAG-13 | Once an adapter has an injected channel (T9.4b), an agent may call a read-only search through the per-run tool channel ([ADR-0026](../adr/0026-per-run-tool-channel-socket-and-token.md)), with the same project scope and size limits as FR-RAG-06. | Could | CAP-13, BO-9 | T | M12 |
| FR-RAG-14 | The operator can clear any index, which deletes vectors and chunk text; the ledger keeps only counts. `doctor` shall report backend, locality, index size, revision and staleness. | Must | CAP-13, BO-5 | T | M12 |

## 4. Nonfunctional requirements

### 4.1 Security (`NFR-SEC`)

| ID | Requirement | Priority | Verify | Milestone |
| --- | --- | --- | --- | --- |
| NFR-SEC-01 | No provider credential value shall be stored in the controller database, artifacts, logs, telemetry or MCP responses. | Must | T (secret-pattern scan of fixtures and outputs), I | M1 |
| NFR-SEC-02 | Subprocess environments follow FR-EXE-07; the allowlist is reviewed per adapter. | Must | T, I | M1 |
| NFR-SEC-03 | A malicious-fixture repository suite (prompt-injection instructions, repo hooks, repo MCP definitions, attempts to read credential paths, write outside the worktree, or reach the network) shall show no escape from each profile's limits for every enabled adapter. | Must | T | M3 (Claude Code, Codex), M4 (others) |
| NFR-SEC-04 | The controller shall run as an unprivileged user and shall not require root. | Must | I, T | M1 |
| NFR-SEC-05 | All MCP inputs and config files shall be schema-validated; workspace paths are canonicalized and checked against allowed roots (FR-POL-10). | Must | T | M1 |
| NFR-SEC-06 | Unknown or unparseable states shall fail closed (deny, mark ineligible, or end the run with an error), never proceed. | Must | T | M1 |

### 4.2 Reliability (`NFR-REL`)

| ID | Requirement | Priority | Verify | Milestone |
| --- | --- | --- | --- | --- |
| NFR-REL-01 | After the controller is killed at any point (including `SIGKILL`) and restarted, the ledger shall be consistent and every run shall be in a terminal or correctly resumed state. | Must | T (fault-injection test) | M1 |
| NFR-REL-02 | A crash, hang or malformed output from one provider process shall not crash the controller or affect other runs. | Must | T | M1 |

### 4.3 Performance and capacity (`NFR-PERF`)

| ID | Requirement | Priority | Verify | Milestone |
| --- | --- | --- | --- | --- |
| NFR-PERF-01 | Controller overhead from accepted `delegate_task` to provider process spawn, excluding queue wait and cached preflight, should be under 2 s at p95 on the reference machine *(proposed target)*. | Should | T (benchmark) | M2 |
| NFR-PERF-02 | Adapter preflight results shall be cached and invalidated on binary version change or a configurable TTL. | Must | T | M2 |
| NFR-PERF-03 | Global and per-provider concurrency limits shall be configurable; defaults of 4 global and 1 per provider *(proposed target)* apply until measured. | Must | T | M1 (global), M6 (per provider) |

### 4.4 Portability (`NFR-PORT`)

| ID | Requirement | Priority | Verify | Milestone |
| --- | --- | --- | --- | --- |
| NFR-PORT-01 | Linux (x86-64 and arm64) is the first supported host platform. | Must | T (CI) | M1 |
| NFR-PORT-02 | macOS host support. | Must | T (CI) | M4 |
| NFR-PORT-03 | Native Windows host support. | Deferred | — | Deferred |

### 4.5 Maintainability and observability (`NFR-MAINT`, `NFR-OBS`)

| ID | Requirement | Priority | Verify | Milestone |
| --- | --- | --- | --- | --- |
| NFR-MAINT-01 | Adding a provider adapter shall require changes only to that adapter's module, its compliance manifest, its fixtures and the adapter registry entry. | Must | I | M4 |
| NFR-MAINT-03 | Because Switchboard is published as open source for others to run with their own subscriptions, the repository shall include user documentation (install, native provider login, configuration, the trust-profile security model, and `doctor` troubleshooting) sufficient for a new user to reach a passing `doctor` run without reading the source. | Must | I, D | M2 |
| NFR-MAINT-02 | The documentation set shall stay synchronized with implementation as described in [AGENTS.md](../../AGENTS.md); `scripts/check-docs.mjs` shall pass on every change. | Must | T | M0 |
| NFR-OBS-01 | Every run's routing decision, policy snapshot, adapter version and outcome shall be retrievable after the fact via `get_run` and `runs show`. | Must | T | M2 |

### 4.6 Privacy, data and compliance (`NFR-PRIV`, `NFR-DATA`, `NFR-COMP`)

| ID | Requirement | Priority | Verify | Milestone |
| --- | --- | --- | --- | --- |
| NFR-PRIV-01 | All controller data shall stay on the host; nothing leaves it except provider traffic made by the provider CLIs themselves and telemetry the operator explicitly configures, and inner-agent calls to the backend the operator configured, under the locality rules of FR-INN-16. | Must | I, T | M1 |
| NFR-PRIV-02 | The controller shall persist observable events (tool calls, file changes, errors, results), not provider-internal reasoning text. | Must | I | M2 |
| NFR-DATA-01 | Run artifacts, events and worktrees shall have configurable retention, defaulting to 30 days *(proposed target)*; deletion shall remove artifacts, worktrees and controller branches together. *(Amended 2026-10-13, Delegated decision under owner decision 25, recorded as [ROADMAP decision 28](../ROADMAP.md#42-owner-decisions) and Q-19: retention applies to worktrees, controller branches and artifact files, not to events; `run_event` rows are the append-only audit record ([ADR-0005](../adr/0005-sqlite-ledger.md)) and are kept. Not owner-approved.)* | Should | T | M3 |
| NFR-COMP-01 | Product documentation and output shall describe Switchboard as using documented provider automation surfaces and shall not claim Terms-of-Service compliance; commercial, resale, multi-user or credential-sharing use requires a per-provider policy review recorded in the compliance manifest. | Must | I | M0 |

## 5. External interfaces

| Interface | Direction | Owner of detail |
| --- | --- | --- |
| MCP over stdio (tool schemas) | Orchestrator → controller | [LLD §3](../design/LLD.md#3-mcp-tool-contracts) |
| Provider CLI subprocess (args, env, JSON/JSONL) | Controller → provider | [LLD §2](../design/LLD.md#2-adapter-contract), per-adapter notes in [TDD §4](../design/TDD.md#4-provider-adapter-strategy) |
| ACP stdio client | Controller → provider | [TDD §4](../design/TDD.md#4-provider-adapter-strategy) (M4) |
| Git (worktrees, checkpoint and published commits, push) | Controller → local repo and, under FR-GIT-05, a remote | [LLD §5](../design/LLD.md#5-workspace-and-lease-algorithm), [LLD §12](../design/LLD.md#12-injected-git-tools-commits-and-publication) |
| Injected `commit` / `push` tools (per-run MCP channel) | Agent → controller | [LLD §12](../design/LLD.md#12-injected-git-tools-commits-and-publication) |
| Inner backend (HTTP chat completion, or a one-shot provider CLI run) | Controller → operator-chosen model | [LLD §13](../design/LLD.md#13-inner-agent) |
| Container runtime (create, start, stop, remove; runtime Proposed in ADR-0013) | Controller → container runtime | [LLD §11](../design/LLD.md#11-projects-contexts-and-environments) |
| OpenTelemetry OTLP export | Controller → operator endpoint | [LLD §7](../design/LLD.md#7-telemetry-spans) |
| Operator CLI | Operator → controller | [FRD](FRD.md) workflows |

## 6. Data requirements

Persistent entities (schema owned by [LLD §1](../design/LLD.md#1-data-model)): `meta_session`, `provider_binding`,
`run`, `run_event`, `decision`, `artifact`, `workspace_checkpoint`, `usage_observation`, `provider_health`,
`route_decision`, `adapter_version`, `approval`, plus (M11) `inner_call` (FR-INN-15) and (M9) `git_commit`
(provenance, FR-GIT-07) and `project_revision`
(FR-PRJ-10). Project definitions
live in the configuration file, or, for projects an orchestrator created (FR-PRJ-10), in the ledger as append-only
`project_revision` rows, and are snapshotted into each run (FR-PRJ-01). All live in one SQLite
database in the operator's data directory ([ADR-0005](../adr/0005-sqlite-ledger.md)); artifacts are files addressed by
SHA-256 under the same directory.

## 7. Traceability

Requirement → milestone mapping is in the tables above; milestone → requirement coverage is in [ROADMAP
§6](../ROADMAP.md#6-milestones). Requirement → design mapping is in [SDD
§5](../design/SDD.md#5-requirements-to-design-traceability). Capability → requirement mapping:

| Capability | Requirements |
| --- | --- |
| CAP-1 Task delegation | FR-MCP-01, 03–10, FR-EXE-01–02, 05–08 |
| CAP-2 Provider adapters | FR-ADP-01–11, FR-AUTH-02 |
| CAP-3 Policy and trust profiles | FR-POL-01–10, FR-MCP-06, FR-PRJ-06 |
| CAP-4 Workspace isolation | FR-WS-01–09 |
| CAP-5 Continuity | FR-SES-01–06 |
| CAP-6 Routing | FR-RTE-01–09, FR-MCP-02, 05 |
| CAP-7 Capacity and backpressure | FR-CAP-01–08, FR-MCP-02, FR-ADP-10 |
| CAP-8 Telemetry and audit | FR-TEL-01–04, NFR-OBS-01 |
| CAP-9 Operator CLI | FR-OPS-01–05, FR-PRJ-08 |
| CAP-10 Projects, contexts and environments | FR-PRJ-01–10 |
| CAP-11 Controlled commits and publication | FR-GIT-01–10, FR-WS-05 |
| CAP-12 Inner agent | FR-INN-01–18 |
| CAP-13 Retrieval index | FR-RAG-01–14 |
