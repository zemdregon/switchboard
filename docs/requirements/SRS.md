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
- **Verification status**: no requirement has been verified yet. There is no code and no test suite in the repository as
  of 2026-10-12. Every verification below is *planned*, not *performed*.
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
| Provider | A vendor coding CLI/harness: Claude Code, Codex, Grok Build, Antigravity (`agy`), Cursor CLI, OpenCode, Kimi Code. |
| Adapter | Controller module that translates normalized requests into one provider's documented automation surface and normalizes its output. |
| Run | One attempt to execute a delegated task on one provider. |
| Meta-session | Controller-owned, provider-independent record of an engineering task across one or more runs. |
| Trust profile | Named security posture (§3.3) compiled by each adapter into native controls. |
| Checkpoint | Git commit recorded by the controller marking workspace state before or after a run. |

## 2. Scope of this specification

In scope: the controller daemon, its MCP tool surface, provider adapters, policy engine, workspace manager, session
ledger, router/scheduler, execution supervisor, telemetry pipeline and the operator CLI. The product boundary and
non-goals are owned by the [PRD](PRD.md#6-non-goals); the system boundary is owned by the
[HLD](../design/HLD.md#1-system-context).

## 3. Functional requirements

### 3.1 MCP interface (`FR-MCP`)

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-MCP-01 | The controller shall expose an MCP server over the stdio transport offering the tools `delegate_task`, `continue_task`, `get_run`, `cancel_run`, `get_artifacts` and `list_capabilities`. | Must | CAP-1, [R2] MCP section | T | M2 |
| FR-MCP-02 | The controller shall additionally expose `get_capacity` and `explain_route`. | Must | CAP-6, CAP-7 | T | M6 (`get_capacity`), M7 (`explain_route`) |
| FR-MCP-03 | `delegate_task` shall accept an objective, a workspace path, constraints, a trust profile, optional verification commands and optional routing hints (`provider_preference`, `require_provider`, `minimum_capability`), and shall return a `run_id` and `meta_session_id` without waiting for the run to finish unless the caller supplies a bounded `wait_seconds`. | Must | CAP-1, [ADR-0002](../adr/0002-mcp-upstream-acp-downstream.md) | T | M2 |
| FR-MCP-04 | Tool results shall be compact normalized envelopes (status, provider, route reasons, summary, changed-file count, verification results, artifact references, reported and estimated usage) and shall never contain raw provider transcripts or credential material. | Must | CAP-1, BO-2 | T | M2 |
| FR-MCP-05 | Routing hints shall only narrow provider choice. `require_provider=true` shall not bypass authentication, sandbox, workspace or compliance checks; if the required provider is ineligible the call shall fail with the failure code mapped from the eligibility reason (or `ELIGIBILITY_NONE`) and the reason in the message. | Must | CAP-6, [R2] | T | M2 |
| FR-MCP-06 | The controller shall enforce, per configured MCP client, a maximum trust profile; requests above it shall fail with `PERMISSION_BLOCKED`. The `privileged` profile shall never be grantable through MCP alone (see FR-POL-09). | Must | CAP-3, BO-3 | T | M2 |
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
| FR-POL-03 | The controller shall not pass permission-bypass flags (`--dangerously-skip-permissions`, `--yolo`, `--force`, `--always-approve`, `--approve-mcps`, `--full-auto` or equivalents) except under `privileged` with an operator approval recorded for that run. | Must | BO-3, [R2] | T, I | M2 |
| FR-POL-04 | Under `inspect-untrusted`, `edit-untrusted` and `test-sandboxed`, repository-supplied agent configuration (hooks, MCP server definitions, `CLAUDE.md`/`AGENTS.md`-style instructions, provider project config) shall not be loaded, using native switches such as Claude `--bare` where available. | Must | BO-3, [R2] | T | M2 |
| FR-POL-05 | An operation denied by policy or sandbox shall end the run with `PERMISSION_BLOCKED` or `SANDBOX_VIOLATION` rather than hang waiting for input. | Must | CAP-3 | T | M2 |
| FR-POL-06 | For untrusted profiles, arbitrary shell execution shall be disabled on any adapter that cannot confine agent-executed commands away from the provider's credential store. | Must | BO-3, [R2] credential boundary | T, A | M3 |
| FR-POL-07 | Each provider shall have a versioned compliance manifest (fields in [LLD §6](../design/LLD.md#6-compliance-manifest)); an adapter without a manifest covering the installed version shall be ineligible. | Must | BO-2, [ADR-0003](../adr/0003-no-credential-handling.md) | T, I | M2 |
| FR-POL-08 | The controller shall never modify global provider configuration (for example `~/.claude/settings.json`, `~/.grok/config.toml`); it shall use per-run arguments, environment or dedicated config directories. | Must | BO-3, [ADR-0012](../adr/0012-telemetry-at-wrapper-boundary.md) | T, I | M2 |
| FR-POL-09 | Runs under `privileged` shall require operator approval through the operator CLI for that specific run; approval or denial shall be recorded with timestamp and scope, and a denied run ends `CANCELLED`. | Must | BO-3 | T | M3 |
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
| FR-WS-03 | After each run the controller shall record the changed-file list, a diff artifact and a post-run checkpoint commit on a controller-owned branch. | Must | CAP-4 | T | M1 |
| FR-WS-04 | If a run fails after mutating the workspace, the controller shall either roll back to the pre-run checkpoint or continue via native resume; it shall never replay the original request against the mutated state. | Must | CAP-4, [R2] retry semantics | T | M1 |
| FR-WS-05 | The controller shall not push to remotes, and shall not modify the operator's checked-out branch or working tree; results are delivered as controller-owned branches plus diff artifacts. | Must | BO-3 | T | M1 |
| FR-WS-06 | Write-capable profiles shall require the workspace to be a Git repository; `inspect-untrusted` may operate on a non-Git directory read-only. | Must | CAP-4 | T | M1 |
| FR-WS-07 | Worktrees and controller branches shall be garbage-collected according to a configurable retention policy. | Should | NFR-DATA-01 | T | M3 |

### 3.6 Meta-sessions and continuity (`FR-SES`)

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-SES-01 | The controller shall generate opaque, unique meta-session IDs and map each to zero or more provider-native session bindings. | Must | CAP-5 | T | M1 |
| FR-SES-02 | Each meta-session shall hold a canonical state record: objective, constraints, repository root/worktree/base/head, decisions, changed files, verification results, open work and provider bindings. | Must | CAP-5, [ADR-0001](../adr/0001-controller-owned-canonical-state.md) | T | M1 (schema), M5 (populated across providers) |
| FR-SES-03 | Continuing a meta-session on the same provider shall use the provider's native resume with the stored native session ID. | Must | CAP-5 | T | M2 (Claude), M5 (all) |
| FR-SES-04 | Continuing on a different provider shall build a handoff bundle solely from controller-owned evidence (goal, constraints, decisions, Git base/head, changed files, relevant diff excerpts, latest diagnostics, failed attempts, open tasks, paths to inspect) and instruct the new agent to inspect the repository; the controller shall not parse provider transcript files. | Must | CAP-5, [ADR-0001](../adr/0001-controller-owned-canonical-state.md) | T, I | M5 |
| FR-SES-05 | Decisions and run events shall be append-only; the handoff view shall be regenerable from them. | Must | CAP-5 | T | M1 (events), M5 (handoff view) |
| FR-SES-06 | A meta-session shall have at most one non-terminal run at a time; `continue_task` on a meta-session with an active run fails with `INVALID_REQUEST`. | Must | CAP-5, FR-WS-02 | T | M1 |

### 3.7 Routing (`FR-RTE`)

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-RTE-01 | Routing shall first remove ineligible providers using hard constraints: trust profile support, write/shell/network needs, sandbox strength, minimum capability, required tools, platform, auth state, version state, compliance manifest, known quota exhaustion, concurrency and health. | Must | CAP-6, [ADR-0008](../adr/0008-two-stage-routing.md) | T | M2 (eligibility only), M7 (full) |
| FR-RTE-02 | Eligible providers shall be ranked by a weighted score over estimated success, latency, capacity risk, security risk, handoff cost and monetary cost, with operator-configurable static weights. | Must | CAP-6 | T | M7 |
| FR-RTE-03 | Every routing decision shall be persisted with its input features, weights, candidate scores and outcome so it can be reproduced and explained. | Must | CAP-6, BO-5 | T | M7 |
| FR-RTE-04 | A heuristic task classifier shall estimate context volume, tool/autonomy needs and reasoning depth from the request and repository metadata. | Should | CAP-6, [R1], [R2] | T | M7 |
| FR-RTE-05 | Empirical or contextual-bandit learning of routing weights. | Deferred | CAP-6, [R2] | — | Deferred |

### 3.8 Capacity, scheduling and resilience (`FR-CAP`)

| ID | Requirement | Priority | Source | Verify | Milestone |
| --- | --- | --- | --- | --- | --- |
| FR-CAP-01 | The controller shall record usage observations exactly as each provider reports them, labelled by source, and keep reported values separate from controller estimates. | Must | CAP-7, [ADR-0007](../adr/0007-capacity-as-confidence-estimate.md) | T | M2 (record), M6 (use) |
| FR-CAP-02 | The controller shall maintain a per-provider capacity estimate with `capacity_score`, `confidence`, `sources`, `explicit_remaining` (only when the provider reports it), `reset_at`, `concurrency_available` and `throttle_risk`. | Must | CAP-7 | T | M6 |
| FR-CAP-03 | No interface or log shall present an estimate as provider-authoritative remaining quota. | Must | CAP-7, BO-5 | T, I | M6 |
| FR-CAP-04 | Ingress shall use a bounded priority queue; each provider shall have a concurrency limit and a circuit breaker. | Must | CAP-7 | T | M1 (queue, global limit), M6 (per-provider breaker) |
| FR-CAP-05 | Only `RATE_LIMIT_TRANSIENT`, `PROVIDER_OVERLOADED` and pre-mutation `PROCESS_CRASH` failures shall be retried automatically, with capped exponential backoff and jitter, and only when the workspace is unchanged since the pre-run checkpoint (otherwise FR-WS-04 applies). | Must | CAP-7, [R2] | T | M6 |
| FR-CAP-06 | On `QUOTA_EXHAUSTED`, the controller shall fail over to another eligible provider if the request permits, queue if a reset time is known within a configured horizon, and otherwise return `QUOTA_EXHAUSTED`. | Must | CAP-7 | T | M6 |
| FR-CAP-07 | A token-bucket rate gate shall be applied to a provider only when that provider publishes enforceable rate limits for the auth mode in use. | Could | [R2] | T | M6 |

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
| NFR-PRIV-01 | All controller data shall stay on the host; nothing leaves it except provider traffic made by the provider CLIs themselves and telemetry the operator explicitly configures. | Must | I, T | M1 |
| NFR-PRIV-02 | The controller shall persist observable events (tool calls, file changes, errors, results), not provider-internal reasoning text. | Must | I | M2 |
| NFR-DATA-01 | Run artifacts, events and worktrees shall have configurable retention, defaulting to 30 days *(proposed target)*; deletion shall remove artifacts, worktrees and controller branches together. | Should | T | M3 |
| NFR-COMP-01 | Product documentation and output shall describe Switchboard as using documented provider automation surfaces and shall not claim Terms-of-Service compliance; commercial, resale, multi-user or credential-sharing use requires a per-provider policy review recorded in the compliance manifest. | Must | I | M0 |

## 5. External interfaces

| Interface | Direction | Owner of detail |
| --- | --- | --- |
| MCP over stdio (tool schemas) | Orchestrator → controller | [LLD §3](../design/LLD.md#3-mcp-tool-contracts) |
| Provider CLI subprocess (args, env, JSON/JSONL) | Controller → provider | [LLD §2](../design/LLD.md#2-adapter-contract), per-adapter notes in [TDD §4](../design/TDD.md#4-provider-adapter-strategy) |
| ACP stdio client | Controller → provider | [TDD §4](../design/TDD.md#4-provider-adapter-strategy) (M4) |
| Git (worktrees, commits) | Controller → local repo | [LLD §5](../design/LLD.md#5-workspace-and-lease-algorithm) |
| OpenTelemetry OTLP export | Controller → operator endpoint | [LLD §7](../design/LLD.md#7-telemetry-spans) |
| Operator CLI | Operator → controller | [FRD](FRD.md) workflows |

## 6. Data requirements

Persistent entities (schema owned by [LLD §1](../design/LLD.md#1-data-model)): `meta_session`, `provider_binding`,
`run`, `run_event`, `decision`, `artifact`, `workspace_checkpoint`, `usage_observation`, `provider_health`,
`route_decision`, `adapter_version`, `approval`. All live in one SQLite database in the operator's data directory
([ADR-0005](../adr/0005-sqlite-ledger.md)); artifacts are files addressed by SHA-256 under the same directory.

## 7. Traceability

Requirement → milestone mapping is in the tables above; milestone → requirement coverage is in [ROADMAP
§6](../ROADMAP.md#6-milestones). Requirement → design mapping is in [SDD
§5](../design/SDD.md#5-requirements-to-design-traceability). Capability → requirement mapping:

| Capability | Requirements |
| --- | --- |
| CAP-1 Task delegation | FR-MCP-01, 03–10, FR-EXE-01–02, 05–08 |
| CAP-2 Provider adapters | FR-ADP-01–11, FR-AUTH-02 |
| CAP-3 Policy and trust profiles | FR-POL-01–10, FR-MCP-06 |
| CAP-4 Workspace isolation | FR-WS-01–07 |
| CAP-5 Continuity | FR-SES-01–06 |
| CAP-6 Routing | FR-RTE-01–05, FR-MCP-02, 05 |
| CAP-7 Capacity and backpressure | FR-CAP-01–07, FR-MCP-02, FR-ADP-10 |
| CAP-8 Telemetry and audit | FR-TEL-01–04, NFR-OBS-01 |
| CAP-9 Operator CLI | FR-OPS-01–05 |
