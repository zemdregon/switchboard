# Technical Design Document (TDD)

| Field | Value |
| --- | --- |
| Status | Draft, baseline for milestone M1 |
| Owns | Technology choices and their tradeoffs; cross-cutting engineering concerns (configuration, error handling, logging, security engineering, concurrency, testing, packaging, CI, versioning); per-provider adapter strategy; technical approach by milestone; migration considerations |
| Does not own | Requirements ([SRS](../requirements/SRS.md)); scope, sequencing and status ([ROADMAP](../ROADMAP.md#6-milestones)); components and boundaries ([HLD](HLD.md)); component collaboration ([SDD](SDD.md)); schemas, interfaces, algorithms ([LLD](LLD.md)); run state machine ([FRD](../requirements/FRD.md)) |
| Last reconciled | 2026-10-13 |

## 1. Purpose and scope

This document says *with what* and *how* Switchboard is to be built, at the level a maintainer needs before writing M1.
It does not restate requirements; it cites SRS IDs. Implementation status is owned by
[ROADMAP §6](../ROADMAP.md#6-milestones). As of 2026-10-12 the repository held documentation and research only, with no
code, tests, CI or configuration; code now exists for M1 and parts of M2, M3 and M9. Statements below that describe a
design intention are marked as such in their own text or by their milestone.

Decision status: ADR-0010 (stack) and the other [ADRs](../adr/README.md) are *Delegated* decisions, binding for
implementation until revised but not individually approved by zemdregon. Items labelled **Proposed** or **Assumption** here
are choices made during planning that are not in the SRS, ADRs or research; they may be changed in M1 without an ADR
unless they alter a boundary, persistence format, trust boundary, external interface or the stack (ADR rules).

Sources: [R1] original blueprint (superseded on technical detail), [R2] [verified
research](../research/headless-ai-coding-controller-verified-2026-10-12.md).

## 2. Technology choices

Exact versions are **pinned in M1** (lockfile plus the Version column below; entries marked "Pinned later" are
pinned by the task that introduces them). "Current LTS" means the Node.js LTS line current when M1 starts.

| Area | Choice | Why | Tradeoff | Version |
| --- | --- | --- | --- | --- |
| Language and runtime | TypeScript with `strict` on current Node.js LTS ([ADR-0010](../adr/0010-typescript-node-stack.md)) | I/O-bound supervisor; MCP/ACP/JSON-schema-heavy surface; one language for adapters and schemas | Requires Node on the host; single-executable packaging is later work; Go or Rust would give easier distribution | TypeScript 7.0.2 (`strict`); Node 22 LTS (`engines` `>=22`, developed on 22.22.0); `@types/node` 22.20.5 |
| Upstream protocol | Official MCP TypeScript SDK, stdio transport ([ADR-0002](../adr/0002-mcp-upstream-acp-downstream.md), FR-MCP-01) | Tracks the spec; avoids hand-rolled JSON-RPC | SDK churn can break tool registration; isolate behind `COMP-MCP` | `@modelcontextprotocol/sdk` 1.32.1 (exact-pinned runtime dependency, T2.4; latest on npm 2026-10-12). Its `McpServer.registerTool` helper takes zod schemas, so `src/mcp/server.ts` uses the lower-level `Server` with `tools/list` and `tools/call` handlers and publishes the Ajv-validated JSON Schemas from `src/mcp/schemas.ts`; zod arrives only as the SDK's own transitive dependency and is not imported (Delegated) |
| Downstream ACP | Own thin ACP client over stdio JSON-RPC (M4); check for an official ACP client library first | FR-EXE-03 is Should; the surface needed is small | Maintaining protocol code vs adding a dependency; decide in M4 | M4 |
| Database | SQLite via `better-sqlite3`, WAL mode ([ADR-0005](../adr/0005-sqlite-ledger.md)) | Synchronous API makes "check-then-write in one transaction" simple and keeps the single writer obvious (NFR-REL-01) | Native addon: needs prebuilt binary or a compiler toolchain per platform; blocks the event loop during a statement (acceptable at expected volume) | better-sqlite3 13.0.3 (exact-pinned runtime dependency, T1.3); `@types/better-sqlite3` 9.6.0 (dev); bundles SQLite 3.53.4 |
| Database alternative | `node:sqlite` (built-in) | No native build step | Stability and feature level to be re-evaluated against the pinned Node LTS at M1 start; not adopted unless it supports needed features (WAL, STRICT, transactions, user functions not required) and is stable | Re-evaluated at T1.3 (2026-10-12, Delegated): **not adopted**. On Node 22.22.0 `node:sqlite` still emits an `ExperimentalWarning` ("might change at any time"), so it fails the stability condition; `better-sqlite3` 13.0.3 installed and ran here. Revisit at the single-executable hardening item or when `node:sqlite` is stable on the pinned LTS |
| Schema validation | **Ajv** (JSON Schema) | FR-MCP-09 requires *published JSON Schemas*; Ajv validates the same documents we publish, config and manifest schemas included, so one schema is source of truth | Config types are hand-written beside the schema and kept consistent by tests (T1.2); the MCP SDK's own tool-registration helpers may expect another schema library, so an adapter shim may be needed (to be checked in M1) | Ajv 8.20.0 (exact-pinned runtime dependency, T1.2) |
| Unit and integration tests | Vitest | TypeScript-native, fast, fake timers and mocking | Less ubiquitous than Jest; process-level tests still need a plain harness | Vitest 5.0.4 |
| Lint and format | Biome (single tool) | One config, fast | Smaller rule set than ESLint plus typescript-eslint; type-aware lint rules may be missing, compensated by `tsc --noEmit` in CI | Biome 2.5.15 |
| Package manager | npm with committed lockfile, `npm ci` in CI | Ships with Node; no extra tool for a single-maintainer project | No workspace-level conveniences of pnpm; adequate for a single package | npm 10.9.4 (bundled with local Node); `package-lock.json` committed |
| Git access | `git` CLI via `execFile` (no shell), minimum version **2.32** (raised from 2.30 on 2026-10-13 by [ADR-0023](../adr/0023-minimum-git-version-2-32.md); `src/workspace/git.ts` `MIN_GIT_VERSION`; developed against 2.43) | Worktree and diff semantics are Git's own ([ADR-0006](../adr/0006-worktree-checkpoints-no-blind-replay.md)); pure-JS Git libraries lack worktree support (Assumption) | Requires `git` on host; output parsing must use porcelain/`-z` formats | Min version M1 |
| Process spawning | `node:child_process` `spawn` with `detached: true` | Needed for process groups (FR-EXE-01) | Signal and group semantics differ on macOS/Windows; Windows deferred (NFR-PORT-03) | Node LTS |
| IDs | ULID, small dependency or in-house (about 30 lines) | Sortable, prefix-able, time-ordered | In-house needs a monotonic-within-millisecond test | M1 |
| Logging | Structured JSON to stderr via `pino` with path-based redaction (Proposed) | Redaction support built in; stdout is reserved for MCP framing | One more dependency; redaction is a safety net, not the primary control (§3.3) | Pinned later (with first logging code) |
| Telemetry export | `@opentelemetry/api` + OTLP exporter, M8 (FR-TEL-02) | Standard | Heavy dependency tree; load lazily and only when an endpoint is configured | M8 |
| CI | GitHub Actions on Linux (x86-64; arm64 runner if available, to be confirmed in M1, NFR-PORT-01) | Repository is on GitHub | Hosted runners have no provider CLIs or logins, which matches "tests pass without any provider" ([AGENTS.md](../../AGENTS.md)) | `actions/checkout` pinned by SHA (v5.1.0); `actions/setup-node` on version tag `v5`, SHA unverified from the network, so SHA pinning is pending |

## 3. Cross-cutting concerns

### 3.1 Configuration

- **Format and location (Proposed).** A single JSON file at `$XDG_CONFIG_HOME/switchboard/config.json` (default
  `~/.config/switchboard/config.json`), path overridable with `--config` or `SWITCHBOARD_CONFIG`. Data (SQLite,
  artifacts, worktrees) under `$XDG_DATA_HOME/switchboard`. JSON avoids a second parser and is validated directly by Ajv
  (NFR-SEC-05).
- **Validation.** Loaded once at startup against a published schema; unknown keys, wrong types or a missing
  `schema_version` abort startup (NFR-SEC-06). Config contains no secrets and never provider credentials (ADR-0003).
- **Policy snapshot.** The effective profile settings for a run are copied into `run.policy_snapshot_json` so later
  config edits cannot rewrite history (FR-POL-01, NFR-OBS-01).
- **Proposed keys:**

| Key | Meaning | Requirement |
| --- | --- | --- |
| `schema_version` | Config format version (§6) | n/a |
| `data_dir` | Ledger, artifacts, worktrees root | ADR-0005 |
| `allowed_roots[]` | Canonical roots that workspaces must live under | FR-POL-10 |
| `mcp_clients[]` | `{id, max_trust_profile}` entries; the orchestrator's MCP config launches `switchboard serve --client <id>`, which binds the session to that entry (FR-OPS-04). The binding is as strong as the operator's control over the orchestrator's launch config; there is no further authentication on stdio. | FR-MCP-06, FR-OPS-04 |
| `projects[]` | `{id, name, environment{kind: host or container, image_digest?, limits?}, contexts[{id, kind: repository, path, base_ref, push{policy: none or branch, remote?, branch_prefix?}, identity{name, email}}], max_trust_profile?, allowed_providers?}` (Proposed shape; [LLD §11](LLD.md#11-projects-contexts-and-environments)) | FR-PRJ-01, 02, 04, 06, FR-GIT-04, 05 |
| `mcp_clients[].privileged_approval` | `"required"` (default) or `"not_required"`; implemented (T3.18). `not_required` admits that client's `privileged` requests to QUEUED under an approval row decided `APPROVED` by `client_policy:<client_id>` instead of waiting for `approve` ([LLD §3.1](LLD.md#31-privileged-scope-m3) "Client policy"); only the per-scope approval is lifted (owner decision 22, [ADR-0019](../adr/0019-per-client-privileged-approval.md)). Valid only with `max_trust_profile: "privileged"` (Proposed, fail closed); `doctor` warns for each such client | FR-POL-09, FR-MCP-06 |
| `mcp_clients[].projects` | Project IDs the client may use | FR-PRJ-03, 06 |
| `mcp_clients[].manage_projects` | Boolean, default `false`. `true` offers `create_project`, `update_project` and `delete_project` for dynamic projects created by this client only; implemented (T9.9, [ADR-0030](../adr/0030-dynamic-project-revisions-and-approval.md)) | FR-PRJ-10 |
| `mcp_clients[].max_push_policy` | `none` (default) or `branch`: the widest push policy a dynamic project of this client may declare; refused without `manage_projects: true`; any push still waits for `projects approve` (T9.9) | FR-PRJ-10, FR-GIT-05 |
| `git.sanitize_patterns[]` | Operator additions to the built-in attribution patterns ([LLD §12.4](LLD.md#124-message-sanitisation)). *Note (2026-10-13, Delegated, T9.3, [ADR-0025](../adr/0025-git-commit-provenance-and-sanitiser.md)):* implemented as `git.sanitize_patterns` in the schema, at most 16 strings of at most 200 characters, each validated at load against a restricted regular-expression subset (`src/git/safe-pattern.ts`); an invalid pattern aborts startup naming its index. No RE2 dependency | FR-GIT-04 |
| `limits.global_concurrency`, `limits.per_provider_concurrency` | Defaults 4 and 1 (proposed target) | NFR-PERF-03 |
| `timeouts.*` | Wall-clock, idle, grace (proposed targets in [LLD §8](LLD.md#8-run-supervisor-details)); only `timeouts.preflight_ttl_seconds` exists in the schema today: integer 0 to 3600, default 60 (**Assumption**), 0 disables the preflight cache; unknown keys are rejected. *Note (2026-10-13, Delegated, [decision 29](../ROADMAP.md#42-owner-decisions), T3.21):* it bounds how long a successful `probe` or `authPreflight` is reused; failures are never cached | FR-EXE-01, NFR-PERF-02 |
| `retention.days`, `retention.interval` | Retention in days (default 30, proposed target) and the GC pass period (`<n>m`, `<n>h` or `<n>d`, default `24h`). Collection is on only when `retention.days` is set in the file: the default is a value, not a switch (`ResolvedConfig.retentionEnabled`, T3.12, Proposed, Delegated). A period above about 24.8 days is capped by the timer | NFR-DATA-01, FR-WS-07 |
| `profiles.<name>` | Overrides of the [SRS §3.3](../requirements/SRS.md#33-policy-and-trust-profiles-fr-pol) defaults. They may tighten or loosen a default ([owner decision 12](../ROADMAP.md#42-owner-decisions)); a loosening must be explicit in the config, is validated, and is recorded in the run's policy snapshot and listed by `doctor` (M3, T3.2). *Known limit ([owner decision 20](../ROADMAP.md#42-owner-decisions), 2026-10-13):* a `profiles.edit-untrusted` override that loosens `network` or `repo_config` is not enforced: the Claude adapter compiles `edit-untrusted` with the strict settings (network off at the tool level, repository configuration disabled) whatever the override says, and the Codex adapter makes the run `Ineligible: CAPABILITY_MISSING` | FR-POL-01 |
| `providers.<id>` | `{enabled, binary_path, extra_env_allowlist[], model_overrides}` | FR-ADP-05, FR-EXE-07 |
| `providers.claude-code.git_channel` | Boolean, default `false`; `claude-code` only. Operator opt-in for the Claude Code tool channel through a controller-written `--mcp-config` file; implemented (T9.4b, [ADR-0029](../adr/0029-claude-code-receives-tool-shim-via-mcp-config.md)) and **UNSUPPORTED** until the ADR-0029 live checks pass ([LLD §11.1](LLD.md#111-configuration-shape), §12.2); only approved bypass runs get the channel, without `--safe-mode` ([ADR-0033](../adr/0033-claude-channel-bypass-only-without-safe-mode.md)) | FR-GIT-02, FR-POL-08 |
| `routing.weights`, `routing.minimum_capability_defaults` | Static weights | FR-RTE-02 |
| `capacity.queue_horizon` | Max wait for a known reset | FR-CAP-06 |
| `telemetry.otlp_endpoint` | Optional export target | FR-TEL-02, NFR-PRIV-01 |
| `log.level` | Logging threshold | §3.3 |
| `inner_agent.enabled`, `inner_agent.backend{kind, base_url or provider, model, timeout_ms, max_concurrency, allow_remote, shares_subscription_with}` | Optional inner agent: one backend, no default backend or model, no credential field (Proposed shape; [LLD §13.1](LLD.md#131-configuration-shape)) | FR-INN-01, 03, 04, 15, 16 |
| `inner_agent.tasks.<task>{enabled, mode?, allow_source_content?, input_budget_bytes, max_output_tokens, timeout_ms?}` | Each task off until enabled; `mode` on `commit_message` only | FR-INN-05, 10, 16 |
| `inner_agent.breaker`, `inner_agent.suspension` | Circuit-breaker and automatic-suspension thresholds (proposed targets) | FR-INN-08, 09 |
| `projects[].inner_agent`, `projects[].contexts[].inner_agent` | `off`, `local_only` or `inherit`; can only restrict | FR-INN-16 |

*Note (2026-10-13, Delegated, T9.1):* `projects[]` is implemented for the schema, the loader and the read-only
`switchboard projects list|show|validate` commands (`src/config/projects.ts`, `src/cli/projects.ts`);
`mcp_clients[].projects` followed in T9.2 (2026-10-13, `531a04f`; Delegated). Config-only checks run at load;
filesystem and Git checks run only in `projects validate`, so adding a project cannot stop `serve` starting. See [LLD §11.1](LLD.md#111-configuration-shape).

*Note (2026-10-13, Delegated, T9.2):* `mcp_clients[].projects` is implemented: strict schema key, an unknown project id
aborts the load, and a client with no list may use no project (workspace-path requests are unaffected). `serve` checks
the filesystem rules of the project a request names at each `delegate_task` (path under an allowed root, base ref
resolves). The ledger is at schema version 2 ([ADR-0024](../adr/0024-project-id-columns-and-project-snapshot.md)). The
tests use the fake adapter and real Git repositories in temporary directories, no provider CLI (`src/mcp/mcp.test.ts`,
"projects (T9.2 ...)").

*Note (2026-10-13, Delegated, T9.9):* `mcp_clients[].manage_projects` and `max_push_policy` are implemented (strict
schema keys, defaults off and `none`). Dynamic projects are ledger rows (schema version 4,
[ADR-0030](../adr/0030-dynamic-project-revisions-and-approval.md)), validated by the same schema, structural rules and
filesystem rules as configured projects, at creation and again at every admission. Tests: `src/projects/projects.test.ts`
(store, rules, migration), `src/mcp/project-tools.test.ts` (MCP tools against the fake adapter and real Git
repositories) and `src/cli/projects-dynamic.test.ts` (`projects list|show|approve`); no provider CLI.

### 3.2 Error handling

- Expected failures are values, not exceptions: every domain operation returns a typed result carrying a code from the
  [failure taxonomy](LLD.md#4-failure-taxonomy). Exceptions are for programmer errors and are caught at three boundaries
  only: MCP tool handler, supervisor per-run task, CLI entry.
- Each run executes in its own async task with its own error boundary so one provider's crash or malformed output cannot
  affect other runs or the controller (NFR-REL-02).
- Unknown or unparseable state fails closed: deny, mark ineligible, or end the run with an error (NFR-SEC-06). An
  unrecognised provider event type is counted and recorded, but an unparseable framing error ends the run with
  `OUTPUT_PROTOCOL_ERROR`.
- Every MCP error carries exactly one taxonomy code plus message (FR-MCP-07); messages never include prompts,
  environment values or credential-like strings.
- Database errors on the run-transition path abort the transition; the run is left in its previous durable state and
  startup reconciliation (WF-8, FR-EXE-06) repairs anything inconsistent.

### 3.3 Logging and redaction

- Logs go to stderr as JSON lines; stdout is reserved for MCP framing when `serve` runs.
- Redaction is layered (FR-TEL-03, NFR-SEC-01): (1) code never passes prompts, env maps, shell output or tokens to the
  logger by construction; (2) logger-level path redaction as a backstop; (3) a CI secret-pattern scan over logs, ledger
  and artifacts produced by tests.
- Provider stdout/stderr go to artifacts addressed by SHA-256, never to logs; logs and telemetry reference artifact ID
  and hash.
- Operator-visible output must not present capacity estimates as provider-authoritative (FR-CAP-03) and must not claim
  ToS compliance (NFR-COMP-01).

### 3.4 Security engineering

- **Environment allowlist.** `COMP-EXE` builds each child environment from an explicit allowlist plus adapter-declared
  variables; nothing else is inherited (FR-EXE-07, NFR-SEC-02). Each adapter's allowlist is reviewed in code review and
  covered by a test that spawns a probe child with a poisoned parent environment.
- **Path canonicalization.** Workspace paths are resolved with `realpath` (symlinks followed) and checked as
  path-prefix-with-separator against configured allowed roots before any side effect; re-checked immediately before
  worktree creation to narrow time-of-check/time-of-use gaps (FR-POL-10, NFR-SEC-05).
- **No bypass flags and no global provider config.** A final argv audit in `COMP-EXE` rejects bypass flags unless the
  run is `privileged` with an approval whose scope sets `bypass` and whose scope hash matches the run's policy snapshot
  (FR-POL-03, [LLD §3.1](LLD.md#31-privileged-scope-m3), [ADR-0017](../adr/0017-approved-privileged-scope-bypass.md);
  audit change in T3.17); adapters never write global provider config such as
  `~/.claude/settings.json` (FR-POL-08, [ADR-0004](../adr/0004-trust-profiles-no-bypass-flags.md)).
- **Repository hooks, filters and diff drivers.** Controller Git operations run with repository hooks disabled and a
  clean Git environment (Proposed: `-c core.hooksPath=/dev/null`, `-c core.fsmonitor=false`, `--no-verify`, no
  inherited `GIT_*` variables, no global or system config), because a malicious repository could otherwise execute code
  in the controller's own commits. The same applies to filter and diff drivers that the repository's configuration
  defines and its `.gitattributes` selects (smudge on `worktree add`/`reset --hard`, clean or `process` on
  `status`/`add`, textconv or an external diff on `diff`). Before every call, the runner (`src/workspace/git.ts`) lists
  the configured `filter.<n>.{clean,smudge,process,required}`, `diff.<n>.{textconv,command}` and `diff.external` keys.
  It reads without a scope flag, so `include`/`includeIf` files and `config.worktree` are covered. It then overrides
  each with an empty value via `-c` (`required` becomes `false`). An empty filter command is skipped, and an empty diff
  command fails instead of running (verified on Git 2.43). Every `git diff` also gets `--no-textconv --no-ext-diff`,
  and `core.attributesFile` is `/dev/null`. A driver name that `-c` cannot express (one containing `=` or a newline)
  makes the call fail closed. Delegated decision: `--attr-source`/`GIT_ATTR_SOURCE` is not used, because it needs Git
  2.40 (above the 2.32 minimum) and still reads `info/attributes`.
  Nested repositories: *Note (2026-10-13, Delegated, owner decision 27,
  [ADR-0022](../adr/0022-nested-repositories-excluded-from-controller-git.md)):* a directory in a run worktree that
  holds its own `.git` (directory, gitdir-pointer file or symlink) is found by `src/workspace/nested.ts` without
  running Git and without following symlinks, and is excluded by pathspec (`:(exclude,top,literal)<path>`, plus
  `--ignore-submodules=all` on `status`/`diff`) from `status`, `diff` and `add -A`, so Git never starts in it
  (reproduced on Git 2.43.0; Q-31, R-35). The run does not fail; each skipped path is a non-fatal
  `nested_repositories_skipped` warning. Consequence: files inside a nested repository are not captured in
  checkpoints, diffs or commits. Evidence: `src/workspace/nested.test.ts`; for the drivers,
  `test/malicious/controller.test.ts` ('T3.8 repository-configured Git filter and diff drivers' and 'controller Git
  runner vs. unhardened Git, operation by operation').
- **Agent Git boundary.** Agents get no Git write ability and no push credentials; see
  [§3.10](#310-git-commits-attribution-and-publication) for the layers, the injected-tool channel and what is still
  unverified per provider (FR-GIT-01..09).
- **Credential boundary.** Nothing reads credential files or keyrings (ADR-0003, FR-AUTH-01). Code review gate plus a
  lint rule (Proposed) forbidding references to known credential paths outside test fixtures.
- **Same-account limitation [R2].** A dedicated OS user limits host blast radius but does not isolate provider
  credentials from commands the agent runs as the same user. Hence FR-POL-06: where an adapter cannot confine agent-run
  commands away from credentials, untrusted profiles should run without arbitrary shell. Claude Code does: its untrusted
  profiles have no Bash tool unless the operator allowlists exact commands (§4.1). Codex does not: owner decision 10
  keeps Codex eligible for `inspect-untrusted` and `edit-untrusted` on its native sandbox alone, and the Codex agent runs
  commands inside that sandbox (read-only or `workspace-write`). Whether those commands can reach `~/.codex` credentials
  or other same-user files is **unverified**, so FR-POL-06 stays open for Codex until the live malicious leg (T3.9)
  checks it (R-23, §4.2).
- **Outer sandbox (Proposed, dependent on M3 evaluation).** On Linux, `bubblewrap` or Landlock could wrap the *provider
  process* in addition to provider-native sandboxes, restricting filesystem writes to the run worktree and limiting
  reachable paths. Limits to evaluate: an outer wrapper cannot hide credentials from the provider CLI itself (it needs
  them) and cannot tell the CLI's own network use from agent-run commands, so it complements, not replaces, native
  sandboxes ([R2] prefers native controls first). Outcome recorded in an ADR if adopted.
- **Run as unprivileged user** (NFR-SEC-04): startup refuses to run as root unless explicitly overridden (Proposed).

### 3.5 Concurrency model

Single Node.js process, async I/O, no worker threads in v1 (Assumption). Concurrency is bounded by the ingress queue and
semaphores (FR-CAP-04, NFR-PERF-03). One `serve` daemon per data directory, enforced by an exclusive lock file; a second
`serve` fails with a clear error ([ADR-0005](../adr/0005-sqlite-ledger.md)). Short-lived operator CLI commands open the
same database through the same ledger module (WAL, busy timeout) and write only operator records (approvals, denials,
cancel requests); the daemon picks them up by polling and performs all side effects. If no daemon is running, the next
startup reconciliation applies them. Run state transitions use an optimistic version column ([LLD
§1](LLD.md#1-data-model), [LLD §10](LLD.md#10-idempotency-and-ordering)). Workspace writes are serialized by the lease
([LLD §5](LLD.md#5-workspace-and-lease-algorithm)) so correctness does not depend on the orchestrator serializing calls
([ADR-0006](../adr/0006-worktree-checkpoints-no-blind-replay.md)).

### 3.6 Testing strategy

| Layer | What | Needs live provider? | Requirement |
| --- | --- | --- | --- |
| Unit | Pure logic: eligibility, scoring, backoff, schema validation, path canonicalization, taxonomy mapping | No | all |
| Adapter conformance | Per adapter: success, task failure, native resume, auth missing, malformed output, cancellation, run against **recorded fixtures** (captured provider output committed as files, scrubbed of credentials) | No | FR-ADP-11, ADR-0009 |
| Fake provider CLI (M1) | A scripted executable emitting configurable JSONL, delays, crashes, mutations and ignoring SIGTERM; exercises supervisor, ledger, workspace, reconciliation end to end | No | FR-ADP-01, FR-EXE-01..07 |
| Workspace and Git | Real Git repos in temp dirs: worktree create, lease, checkpoint, mutation detection, rollback, GC | No | FR-WS-01..09 |
| Fault injection | Kill controller with `SIGKILL` at each transition boundary (named crash points), restart, assert ledger consistency and terminal/resumed state | No | NFR-REL-01, FR-EXE-06 |
| Malicious fixture repos (M3, M4) | Repos with prompt-injection files, repo hooks, repo MCP definitions, credential-path reads, out-of-worktree writes, network attempts, run per enabled adapter | Needed for adapter-level proof; sandbox-level parts can run without | NFR-SEC-03 |
| MCP contract | Schema validation, error envelope, idempotency, `wait_seconds` bounds via an in-process MCP client | No | FR-MCP-* |
| `serve` process tests (M2) | Spawn `switchboard serve` as a child with a temp config and data dir, drive it with an MCP stdio client: delegate → SUCCEEDED, stdout carries only MCP framing, a second `serve` on the same data dir fails, `SIGKILL` mid-run then restart ends the run `FAILED/PROCESS_CRASH` with no orphan (`src/cli/serve.test.ts`). The fake adapter is reachable only through the test-only switch below | No | FR-OPS-01, FR-EXE-06, NFR-REL-01 |
| Git boundary (M9) | Fake adapter with scripted tool calls and scripted attempts to `git commit`, move refs or push, against real Git repos and a local bare remote; fixtures of typical attribution trailers, footers and session IDs through the sanitiser; assertion that no published commit contains them and that checkpoint commits never reach the remote | No | FR-GIT-01..09 |
| Project and environment (M9, M10) | Configuration validation (unknown context kind, path outside allowed roots), ceiling arithmetic, `host` runs through a project; container tests need a container runtime and are opt-in (skipped in CI until Q-6 is settled) | No for `host`; runtime for `container` | FR-PRJ-01..09 |
| Live provider smoke | Opt-in only: `scripts/live-smoke.mjs` (`npm run test:live`) is skipped unless `SWITCHBOARD_LIVE_TESTS=1`; not part of `npm test`, never runs in CI (see below) | Yes | [AGENTS.md](../../AGENTS.md) |
| Controller-overhead benchmark | `scripts/bench-perf.mjs` (`npm run bench`) times the real MCP server over the in-memory transport with the fake adapter; not part of `npm test` (see [§3.6.1](#361-controller-overhead-benchmark-t27)) | No | NFR-PERF-01, NFR-PERF-02 |
| Inner agent (M11) | Scripted fake backend as a local HTTP server, hostile-output fixtures, planted-secret prompt capture, import-boundary test; details in [§3.12](#312-inner-agent) | No | FR-INN-01..17 |
| Affinity replay (M7) | Table-driven and property tests over stored `route_decision` rows and a scripted fake adapter set: for any sequence of runs in a project, the provider and model change only when the decision carries an `affinity_switch_reason` from the closed list; a better score, lower cost or lower load never moves a project; no return after recovery; `require_provider`, `affinity reset`, `QUOTA_EXHAUSTED`, breaker open and exhausted retry each produce exactly their reason. Details in [§3.13.3](#3133-testing-affinity-and-retrieval) | No | FR-RTE-06..09, FR-CAP-08 |
| Retrieval index (M12) | Deterministic fake embedding backend, hostile-content fixtures, planted-secret scan, isolation and import-boundary tests; details in [§3.13](#313-retrieval-index) | No | FR-RAG-01..14 |
| Docs check | `scripts/check-docs.mjs` must pass on every change (links, anchors, ID references) | No | NFR-MAINT-02 |

Principles: tests pass with no provider CLI installed or logged in; secret-pattern scan over all test outputs
(NFR-SEC-01); coverage targets are not set until M1 measurement (no number proposed).

**Test-only fake adapter in `serve` (Proposed, T2.6).** `serve` registers the fake adapter only when the environment
variable `SWITCHBOARD_TEST_FAKE_ADAPTER` equals the exact sentinel `enable-test-only-fake-adapter` (scenario from
`SWITCHBOARD_TEST_FAKE_SCENARIO`, default `success`). Any other non-empty value refuses to start, the config schema has
no key or provider id that can enable it, and `serve` logs a warning on stderr when it is on. Production registers
`claude` and `codex` only. With the switch on, `SWITCHBOARD_TEST_CLOCK_OFFSET_MS` (an integer) shifts the daemon's clock
so a process test can show that a run waiting for approval does not expire (T3.4); set without the switch, or to a
non-integer, it refuses to start.

**Running the live smoke test (operator, T2.6).** With the provider CLI installed and logged in natively (Switchboard
never logs in for you):

```sh
SWITCHBOARD_LIVE_TESTS=1 SWITCHBOARD_LIVE_PROVIDER=claude npm run test:live   # or SWITCHBOARD_LIVE_PROVIDER=codex
```

It builds, creates a throwaway Git repository and data directory under the system temp directory, starts the real
`switchboard serve` over stdio, runs one `edit-untrusted` task ("create `SMOKE.md`") against the operator's own CLI and
prints: probe and version-gate results, the compiled policy flags with a bypass-flag audit, the auth status shape (exit
code and key names only, never values), the run's terminal state, the native event types seen, and a HELD / FAILED /
NOT_CHECKED line for each adapter Assumption tracked by [ROADMAP](../ROADMAP.md#7-risks-blockers-and-open-questions)
R-21, R-22 and Q-13. It never reads or prints credentials or prompt/response text. Optional: `SWITCHBOARD_LIVE_TIMEOUT_MS`
(default 600000) and `SWITCHBOARD_LIVE_KEEP=1` (keep the temp directory with the ledger, artifacts and `serve` log).
Exit code 0 means the run succeeded and no checked Assumption failed. With the current manifests Codex is expected to be
refused at eligibility (`ADAPTER_VERSION_UNVERIFIED` and auth `UNKNOWN`, Q-10 and Q-12); the script still reports the
probe-level Assumptions.

#### 3.6.1 Controller-overhead benchmark (T2.7)

`npm run bench` builds, then runs `scripts/bench-perf.mjs` (`--n`, `--warmup`, `--json` options; defaults 30 timed
iterations after 5 warm-up). It drives the real MCP server (`createSwitchboardServer`, real lifecycle, ledger,
workspace manager and artifact store) through the SDK's in-memory transport, with the fake adapter's `success`
scenario on a temporary Git repository, one run at a time. Provider time is excluded because the fake CLI does no
work. Marks are taken by a thin adapter wrapper: `compile` (the last step before the provider process is spawned, used
as the spawn mark) and `extractResult` (called as soon as process exit is observed). Metrics:

- **delegate_task ack**: tool call to `run_id` returned.
- **accepted to spawn**: tool call to the `compile` mark, reported in total and with the probe and auth preflight time
  subtracted. This is the NFR-PERF-01 quantity, measured with preflight uncached (the default `npm run bench`).
- **exit to terminal visible**: exit observed to the first `get_run` showing a terminal state (finalize: worktree
  teardown, diff artifact, ledger commit), polled in a tight loop.
- **get_run** and **list_capabilities**: tool call to result, 30 calls each against a finished run.

**Result, 2026-10-12.** Host: sandbox container, not representative of an operator laptop (Node v22.22.0; Linux
6.18.44-fc-v114 x64; Intel Xeon Processor @ 2.10 GHz, 4 vCPUs; 15.7 GiB RAM). Three consecutive invocations, each 30
iterations after 5 warm-up; values are p50 / p95 / max in milliseconds.

| Metric | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| delegate_task ack | 120.9 / 143.3 / 161.5 | 127.6 / 159.2 / 159.9 | 116.0 / 137.3 / 138.1 |
| Accepted to spawn, total (uncached preflight) | 284.1 / 326.5 / 329.2 | 299.1 / 340.2 / 355.6 | 281.0 / 336.6 / 341.0 |
| Accepted to spawn, excluding probe and auth | 67.5 / 85.3 / 90.9 | 72.1 / 101.1 / 104.0 | 66.5 / 95.7 / 129.1 |
| Live probe and auth preflight (dispatch) | 216.5 / 252.9 / 256.7 | 222.3 / 256.2 / 261.1 | 211.9 / 246.6 / 268.0 |
| Exit to terminal visible via get_run | 70.0 / 101.2 / 109.5 | 74.7 / 102.4 / 113.3 | 65.5 / 93.8 / 108.0 |
| get_run | 1.6 / 2.5 / 6.6 | 1.3 / 1.8 / 2.1 | 1.1 / 1.5 / 1.9 |
| list_capabilities (live probe) | 100.9 / 122.2 / 137.3 | 106.2 / 128.0 / 129.8 | 92.7 / 109.2 / 111.9 |

Run-to-run spread of the p95 for accepted-to-spawn (total) is 326.5 to 340.2 ms, about 4%; the excluding-preflight
p95 varies more (85.3 to 101.1 ms) because it is a small difference of two noisy figures on a shared container.

**NFR-PERF-01 finding.** On this host the controller's accepted-to-spawn overhead is about 0.34 s at p95 with
preflight uncached, against the proposed target of under 2 s at p95 in [SRS NFR-PERF-01](../requirements/SRS.md).
The proposed target is **confirmed for the controller-owned work**, with margin of roughly 6x. Two limits on that
conclusion: (1) the figure includes three trivial fake-CLI process spawns for the probes, so a real provider CLI's
probe cost (not measured; Assumption that it is larger, since real CLIs start more slowly than a bare Node script)
adds to it until preflight is cached, and NFR-PERF-01 itself excludes cached preflight; (2) this is a sandbox
container, and the reference machine is not yet defined. The 2 s value should stay marked *(proposed target)* until a
run with the live Claude Code and Codex probes (`npm run test:live` path) is available. No revision is proposed. The
controller-owned part (about 70 to 100 ms p95 excluding probes) leaves headroom for adding gating work in later
milestones.

**NFR-PERF-02 finding.** Preflight is currently uncached and live in two places. `delegate_task` runs the stage-1
eligibility check, including `probe` and `authPreflight`, before it returns, so its acknowledgement costs about 0.12 s
(p50) on the fake adapter instead of a few milliseconds. The run then probes again at dispatch (PREFLIGHT), about 0.22
s at p50 (two probe spawns, about 0.145 s, and one auth spawn, about 0.07 s). `list_capabilities` probes every
registered provider live on each call (about 0.10 s per provider with the fake adapter). With caching, the
acknowledgement and the dispatch probes would drop to the controller-only cost. The cache required by NFR-PERF-02
(invalidated on binary version change or a configurable TTL) is not implemented, and no roadmap task owns it: T2.7 only
measures. This was a gap to be assigned (reported to the roadmap owner), not a finished requirement.

*Note (2026-10-13, Delegated, [decision 29](../ROADMAP.md#42-owner-decisions), T3.21): resolved.* `PreflightCache`
(`src/adapters/preflight-cache.ts`) now caches successful probe and auth results by adapter id and binary identity
(path, `mtime`, size, inode) for `timeouts.preflight_ttl_seconds` (Assumption: 60 s); failures, `AUTH_REQUIRED` and
`UNKNOWN` are never cached. `npm run bench -- --cached` enables it in the benchmark (the default run keeps the
uncached baseline above). One run on a busier shared host than the tables above (so compare the two rows below with
each other, not with the tables; n = 30, 5 warm-up, p50 / p95 ms):

| Metric | Cache off | Cache on |
| --- | --- | --- |
| `delegate_task` acknowledgement | 239.2 / 291.1 | 45.8 / 52.0 |
| Accepted to spawn, total | 614.6 / 773.0 | 205.7 / 243.7 |
| `list_capabilities` | 162.0 / 206.1 | 0.5 / 1.1 |
| Live probe and auth at dispatch | 406.2 / 514.1 | 0.0 / 0.0 |

The first run after start-up, and the first after a TTL expiry or binary change, still pay the full probe cost. The
benchmark uses the fake adapter only; a real provider CLI's probe cost is unmeasured (Unverified).

### 3.7 Packaging and release

- **Distribution (Proposed).** An npm package exposing a `switchboard` bin with subcommands `serve`, `doctor`, `runs
  list`, `runs show` (FR-OPS-01), later `approve` and `adapters validate` (FR-OPS-02). Published artifacts are compiled
  JavaScript plus type declarations. Where and whether to publish to the npm registry is an open owner decision
  (Assumption: initial installs from a Git checkout or tarball).
- **Single executable** (Node SEA or a bundler) is a later hardening item per ADR-0010; `better-sqlite3`'s native addon
  is the main obstacle and may favour `node:sqlite` at that point.
- **Release.** Tagged from the main branch by CI after checks pass; changelog kept by hand. No dates or cadence are
  committed.

### 3.8 CI pipeline

Proposed jobs on every pull request, all runnable with no provider installed: (1) install via `npm ci`; (2) `biome
check`; (3) `tsc --noEmit`; (4) Vitest unit + integration + fake-provider + fault-injection; (5) `node
scripts/check-docs.mjs`; (6) secret-pattern scan over test outputs; (7) `npm audit` as informational (Assumption). The
fault-injection job needs process-kill privileges only, no root. A scheduled job for version canaries is M8
([ADR-0009](../adr/0009-version-gated-adapters.md)); it needs installed provider CLIs and logins and therefore cannot
run on hosted runners without operator-managed credentials, which the project must not hold, so canaries run on the
operator's machine (Assumption).

### 3.9 Versioning

Package: SemVer, pre-1.0 until the MCP tool schemas stabilise after M2/M6. Independent version numbers: config
`schema_version`, DB migration number, MCP tool schema version (in `list_capabilities`), per-adapter validated
provider-version range ([LLD §6](LLD.md#6-compliance-manifest)).

### 3.10 Git commits, attribution and publication

Implements [ADR-0014](../adr/0014-tool-only-commits-and-publication.md) (FR-GIT-01..09). Everything here is
**Proposed** design except zemdregon's decision itself (agents have no commit or push ability; Switchboard-injected tools
make commits and pushes; commits look ordinary). The central constraint: [R2] documents **no** provider setting for
commit behaviour or attribution, so none is named or assumed here. Each adapter's task begins by checking the installed
CLI and the provider's documentation for (a) whether it can commit on its own, (b) any attribution setting, and (c) the
exact deny-rule syntax for Git write commands, and records the answer in its manifest notes. M2 result (T2.2): Claude
Code documents deny rules and no usable attribution switch ([§4.1](#41-claude-code-m2)); Codex documents neither, which
its adapter declares ([§4.2](#42-codex-m2)). The deny set is `GIT_WRITE_SUBCOMMANDS` in `src/adapters/git-write.ts`
(Proposed).

**Layers.** Prevention first, then detection; none depends on a provider-specific attribution switch.

**By environment (owner decision 24, 2026-10-13; mechanism Proposed).** In a `container` environment (M10, planned)
the image has no Git client (FR-PRJ-05) and layers 2 and 4 hold by construction, so FR-GIT-01 does not rest on layer 1
there, including in approved bypass runs; layer 1 is still compiled and layer 5 still runs. In a `host` environment
layers 1 to 5 apply as below, and for a Claude Code bypass run whether layer 1 holds is unverified until the live check
C-G2 (ROADMAP R-38).

| # | Layer | What it does | Strength | Verified? |
| --- | --- | --- | --- | --- |
| 1 | Profile deny rules | Each adapter compiles Git write operations (commit, branch and tag changes, push) into the provider's *documented* permission controls: Claude Code `--disallowedTools` deny rules plus its explicit `--tools`/`--allowedTools` set, Grok Build `--allow`/`--deny`, OpenCode explicit deny rules, Antigravity `strict` mode. An adapter whose provider documents none declares it (`gitWriteControl`, reported by `list_capabilities`; Codex). Under `inspect-untrusted` and `edit-untrusted` Claude Code has no arbitrary shell, and a shell allowlist entry that could write Git makes the run `Ineligible`; Codex runs commands inside its native sandbox under those profiles (owner decision 10, §4.2), so for Codex this layer is the sandbox's path scope only. | Provider-enforced; only as strong as the provider's rule matching, and lexical | Claude: rule form from the `claude --help` 2.1.296 example only, matching semantics an Assumption (live check pending); Codex: none documented; M4 adapters: to be verified |
| 2 | No credentials in the agent's environment | The environment allowlist (FR-EXE-07) never carries `SSH_AUTH_SOCK`, token variables or credential-helper settings. In a `container` environment (M10) no credential store is mounted. | Strong in containers; in a `host` environment on-disk credentials stay readable by a same-user shell ([R2] limit) | Allowlist: tested in M1; container: M10 |
| 3 | Git-level guard | Per-run Git configuration for agent processes that points hooks at a controller-owned directory whose hooks reject ref updates not carrying the controller's token. Candidate mechanisms: a per-run global config file, or `GIT_CONFIG_COUNT` environment entries (2.31 inferred, below the 2.32 minimum set by [ADR-0023](../adr/0023-minimum-git-version-2-32.md); check Git's release notes). | A guard against provider-internal or accidental commits, **not** a boundary: an agent with a shell can override Git configuration | Mechanism: to be chosen in an M9 spike |
| 4 | Git directory out of reach | A worktree's Git directory lives under the main repository's `.git/worktrees/`, outside the worktree. A provider sandbox that confines writes to the worktree therefore cannot edit refs. | Depends on each sandbox's path scope | Malicious fixtures per adapter (M9) |
| 5 | Detection | Snapshot all refs (`for-each-ref`, including tags and other branches) at LEASED and compare at FINALIZING, plus a check that the run branch holds only controller-made commits. Anything else is a violation: content kept as working-tree changes, commits never published (FR-GIT-03). | Catches what layers 1 to 4 miss; cannot undo a push | Tests in M9 |

**Injected channel.** The controller writes a per-run MCP definition (no global provider config, FR-POL-08) naming a
small stdio server, a subcommand of the `switchboard` binary (internal, not operator-facing). The shim exposes `commit`
and, when policy allows, `push`, and forwards each call over a per-run Unix socket (mode `0600`, under the run
directory) to COMP-GIT in the controller, with a per-run capability token. Git runs in the controller, never in the
agent's process tree. Constraints to verify per provider:

- how a per-run MCP definition is supplied: [R2] says Claude's `--bare` skips MCP discovery and shows no flag for
  supplying one, so the mechanism is **to be verified in M2 and M9**;
- whether a fail-closed mode (Claude `dontAsk`, which denies what would prompt) needs the injected tools pre-allowed in
  the allow rules, and the exact rule form (verify);
- whether the provider's sandbox lets the shim reach the socket (Landlock, Seatbelt and bubblewrap profiles may block
  Unix-socket connects; verify per adapter in M9);
- whether approving an injected MCP server needs a switch that FR-POL-03 treats as a bypass flag. [R2] lists Cursor's
  `--approve-mcps` as a separate switch; if that is required, Cursor uses the finalize-only mode (FR-GIT-09) rather than
  an exception to FR-POL-03.

**Finalize-only mode (Proposed).** The controller makes one commit at FINALIZING from the worktree changes. The message
is taken from the agent's structured final summary (the result event, FR-ADP-04), then sanitised. It loses the agent's
ability to split work into commits; it needs an operator opt-in per context.

**Identity and message.** Author and committer come from the context's `identity`. Default (Proposed): when absent,
`projects validate` reads the repository's effective `user.name` and `user.email` with `git config` (not credentials) and
asks the operator to copy them into the configuration, so the identity is explicit and recorded in the policy snapshot.
Commit signing is optional per context (`sign: true`, FR-GIT-10; zemdregon answered yes to Q-9). A signing key is a
credential, so signing runs only in the controller process through the operator's existing Git configuration, is never
stored or exported to an agent, and never falls back to unsigned ([LLD
§12.3.1](LLD.md#1231-signing-fr-git-10-proposed)). Which signing formats work headlessly is settled in the M9 spike.
The controller sets author and committer dates itself and adds no trailer. The existing checkpoint identity
(`Switchboard <switchboard@localhost>` in `src/workspace/git.ts`) is for internal checkpoints only and must never be
used for published commits.

**Building the commit.** On `commit(message, paths?)` COMP-GIT builds the tree with a temporary index file seeded from
the publish ref's tree (or the run's base commit), adds the requested paths (or all changes) from the worktree, writes the
tree, then creates the commit object with the context identity and moves the publish ref with a compare-and-swap. The
run branch and its checkpoints are untouched. (Plain Git plumbing; exact commands: to be fixed in the M9 spike.)

**Publication.** `push` runs `git push` from the controller process with an explicit refspec for the publish ref, never
`--force`, to the configured remote under the configured prefix. It uses the operator's existing Git configuration (SSH
agent, credential helper). The controller does not read, copy or store any of it (FR-GIT-06, NFR-SEC-01). The agent's
environment is separate from the controller's. In a `host` environment with a shell, ambient credentials remain
readable by the agent, so the `push` tool is withheld (BR-31), except in an approved bypass run (owner decision 37,
Delegated narrow reading, ADR-0028 "Amended before merge", R-51). Candidate stronger answers, not adopted: a dedicated OS
user for a publisher helper (adds a privilege boundary and an installation step), or container environments (M10).

**Audit trail.** The ledger table `git_commit` ([LLD §1](LLD.md#1-data-model)) is written in the same transaction as the
`git_commit` run event. It stores SHA, tree hash and patch ID so records can be re-linked after an operator rebase
(best effort). `git notes` and trailers were rejected because they travel with the repository.

**T9.0 spike findings (note, 2026-10-13; Delegated, not owner-approved; no mechanism here is adopted until the ADRs
named below exist).** Scope: only what could be checked on this host without a model call, a login or a credential. The
tools were Git 2.43.0 (`git --version`) in throwaway repositories with an isolated `HOME`, and the help text of `claude`
2.1.296 (`claude --help`, `claude mcp --help`, `claude mcp add --help`; no prompt run, no `mcp list` or `mcp add`, which
touch configuration). Codex is not installed. Git release-note citations are `Documentation/RelNotes/<version>.adoc` in
the upstream `git/git` repository, read on 2026-10-13. Command transcripts are reproduced in [LLD
§12.3](LLD.md#123-commit-algorithm-and-refs) (plumbing) and below (guards). Verified means "observed on Git 2.43.0 or
read in the installed help"; a minimum version is stated only where a release note says so.

*Layer 3, per-run Git configuration (verified on 2.43.0).* Each row is one command run in a linked worktree of a
repository whose `$HOME/.gitconfig` held an identity, `alias.ci=commit` and `credential.helper=store`; `$G` is
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=<dir>`, and `<dir>` held an executable
`reference-transaction` hook that exits 1 in state `prepared`, and a `pre-push` hook that exits 1.

| Check | Command | Result |
| --- | --- | --- |
| User config neutralised | `GIT_CONFIG_GLOBAL=<empty file> GIT_CONFIG_SYSTEM=/dev/null git config --get-regexp '^(user\|alias)\.'` and `... git ci -m x` | no keys (rc 1); `git: 'ci' is not a git command` (aliases from user config are gone) |
| Credential helper neutralised | same neutral variables, `git config --get-all credential.helper` | no value (rc 1). Setting `credential.helper` to an empty value through `GIT_CONFIG_COUNT` only appends an empty entry after `store`; the reset semantics were not tested |
| Guard blocks Git writes | `env $G git commit -m x`, `git branch sneaky`, `git update-ref refs/heads/sneaky2 HEAD`, `git tag t1`, `git commit --no-verify -m x` | every one: hook message, `fatal: ref updates aborted by hook`, rc 128; no ref created or moved. `--no-verify` does not skip `reference-transaction` |
| Guard blocks push | `env $G git push origin run/1` | `pre-push` message, `error: failed to push some refs`, rc 1; nothing reached the bare remote |
| Guard does not apply to the controller | the same commands with `SWITCHBOARD_TOKEN=x` in the environment | commit and push succeed. Note: controller Git calls already run with `scrubbedGitEnv()` and `-c core.hooksPath=/dev/null` (`src/workspace/git.ts`), so they never carry the guard variables and the hook could reject unconditionally; the token check is optional |
| Agent override, `-c` | `env $G git -c core.hooksPath=/dev/null commit -m x` | **commit succeeds**: a command-line `-c` beats `GIT_CONFIG_COUNT` |
| Agent override, repository config | `git config --local core.hooksPath /dev/null`, then `env $G git commit` | still refused: `GIT_CONFIG_COUNT` beats the repository's local config |
| Agent override, environment | `env $G env -u GIT_CONFIG_COUNT git commit` | **commit succeeds**: the agent owns its environment |
| File variant | `GIT_CONFIG_GLOBAL=<file with core.hooksPath and an identity> git commit` | refused; but after `git config --local core.hooksPath /dev/null` the commit **succeeds**: local config beats the global file, so the file variant is weaker than the environment variant |
| No identity, no commit | neutral config, `git commit` with no `GIT_AUTHOR_*` | `Author identity unknown`, rc 128 (with no hostname FQDN; on a host that has one Git may derive an identity, so this is a side effect, not a control) |
| Repository's own hooks | `git update-ref ...` with a repository `reference-transaction` hook, then with `-c core.hooksPath=/dev/null` | the repository hook ran and aborted the update; with the override the update succeeded (run in the main repository; whether a linked worktree reads the same hooks directory was not tested). This is why the controller always overrides `core.hooksPath` |

Conclusions (Delegated, Proposed): (1) the environment variant (`GIT_CONFIG_COUNT`, `core.hooksPath` to a
controller-owned directory) plus `GIT_CONFIG_GLOBAL` pointing at an identity-free file and `GIT_CONFIG_SYSTEM=/dev/null`
blocks commits, branch and tag changes, ref updates and pushes made by any Git process that inherits the agent's
environment, which includes provider-internal Git calls, and it holds against a repository-local config edit; (2) it is
a guard, not a boundary, exactly as the table says: `-c` and an unset variable defeat it, so the Claude deny rule on
`git -c` and FR-GIT-03 detection stay necessary; (3) the guard hooks fire on ref updates and pushes, so object-only and
index-only operations (`git add`, and by inference `git commit-tree` and `hash-object -w`, which update no ref) are not
covered and leave index changes or unreferenced objects that FR-GIT-03 (refs only) does not see. Versions:
`GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` appear in the Git 2.32.0 release notes; the 2.31.0 notes say "Two new ways
to feed configuration variable-value pairs via environment variables have been introduced" without naming them, so that
`GIT_CONFIG_COUNT` needs 2.31 is **inferred**, not verified; the `reference-transaction` hook is already treated as
existing in the 2.29.0 notes, and the version that introduced it is **unverified**. This host has no Git man pages or
release notes, so the notes were fetched from upstream and nothing else about minimum versions could be checked.

*`MIN_GIT_VERSION` revisited (finding; decided 2026-10-13, see the note after this paragraph).* `MIN_GIT_VERSION`
was `[2, 30, 0]` (`src/workspace/git.ts`; the TDD §2 table above). `scrubbedGitEnv()` already sets
`GIT_CONFIG_GLOBAL=/dev/null`, which the 2.32.0 release notes introduce; on 2.30 and 2.31 the variable would be
unknown to Git, so the operator's global config would not be neutralised there (inferred from the notes, not tested:
no such Git is installed).
`GIT_CONFIG_NOSYSTEM=1`, also set there, is older. Adopting layer 3 as above needs 2.31 (inferred) and the neutral-file
variable needs 2.32. Proposal: raise the minimum to **2.32.0**. That changes the technology stack's stated floor, so
under AGENTS.md it needs an ADR. Nothing in the plumbing below needs more than 2.30 as far as could be checked, but
their introduction versions are unverified for the reason above.

*Decision (2026-10-13, Delegated, under owner decision 25; ROADMAP decision 30, Q-39, R-44;
[ADR-0023](../adr/0023-minimum-git-version-2-32.md)):* `MIN_GIT_VERSION` is now `[2, 32, 0]` (`src/workspace/git.ts`);
`doctor` and `WorkspaceManager.checkGit` use the constant and so reject 2.31 and older, and `src/workspace/workspace.test.ts`
covers the gate with version strings. No requirement ID changes; no SRS requirement names a Git version. The 2.32
introduction of `GIT_CONFIG_GLOBAL` rests on the release notes, not on a test against an old Git (none is installed).

*Per-run MCP definition: Claude Code (help text of 2.1.296 only).* `--mcp-config <configs...>`: "Load MCP servers from
JSON files or strings (space-separated)"; `--strict-mcp-config`: "Only use MCP servers from --mcp-config, ignoring all
other MCP configurations". So a per-run definition is a file in the run directory or a JSON string on the command line,
with the strict flag already in the compiled isolation set; no global configuration is written. `claude mcp add` and
`add-json` write local, user or project configuration (`-s, --scope`), which FR-POL-08 forbids, so they are not the
channel. Not in the help, therefore **Unverified (live check)**: the top-level JSON shape of `--mcp-config` (`add-json`
documents only that a server may be "stdio, SSE, HTTP, or WebSocket"); the form an MCP tool takes in `--allowedTools` or
`--tools`; whether a call to an MCP tool prompts under `--permission-mode dontAsk --permission-prompts none` when it is
not pre-allowed; and whether `--safe-mode` (help: disables "MCP servers" among "all customizations") also disables a
server given by `--mcp-config`. Those four decide whether Claude can receive the channel without a bypass flag
(FR-GIT-02); until a live check answers them the Claude adapter must not claim `commitChannel: injected`. **ADR-0015
conflict (trust boundary; reported, not decided).** [ADR-0015](../adr/0015-claude-untrusted-isolation-flags.md) says the
adapter "never emits ... `--mcp-config`"; `FORBIDDEN_ARGS` in `src/adapters/audit.ts` (T3.17) and
`src/adapters/claude/claude.test.ts` encode that. The injected channel needs exactly that flag. The narrow reading that
fits ADR-0015's purpose (no repository or operator MCP definition in an untrusted run, FR-POL-04) is: `--mcp-config`
carrying only the controller-generated shim definition, always together with `--strict-mcp-config`, so nothing else
loads. That relaxes an accepted ADR and touches the argv audit, so it is a **proposed ADR** (ROADMAP Q-40), not a
decision. For a trusted-development or approved-bypass run the same applies: `approved` repository configuration keeps
`--strict-mcp-config`, so the shim would be the only server; `enabled` omits it (ADR-0021), so the repository's own
definitions would load beside the shim. Under `--dangerously-skip-permissions` (help: "Bypass all permission checks") an
unlisted MCP tool should need no allow rule (inference from the help text, unverified), but a bypass run is exactly
where deny rules are unverified (R-38), so the shim is the sanctioned path there, not the only one.

*Codex (documentation only; nothing verified).* Codex is not installed. [R2] documents `codex exec`, `--json`,
`--sandbox`, `--ignore-user-config`, `--ignore-rules` and the platform sandboxes (bubblewrap, Seatbelt, a Windows
sandbox), and says nothing about supplying an MCP definition, MCP tool approval, Unix-socket access from inside the
sandbox, per-command Git deny rules or a commit or attribution setting. Every cell is **Unverified**; the Codex adapter
keeps `gitWriteControl.kind = none-documented` and the finalize-only fallback (FR-GIT-09) is the only evidenced design
for it until a binary is installed and T3.9 or a follow-up live check runs.

| Question | Claude Code 2.1.296 | Codex |
| --- | --- | --- |
| Per-run MCP definition | `--mcp-config` with `--strict-mcp-config` (help); JSON shape Unverified | Unverified (not in [R2]) |
| Allow-rule form for an MCP tool | Unverified (not in help) | Unverified |
| Channel without a bypass flag | Unverified (depends on rows above and on `--safe-mode`) | Unverified |
| Shim reaches a Unix socket from the sandbox | Unknown: live check. The help lists no sandbox option (T3.0), so none is applied by these flags; nothing says the shim is confined | Unverified: bubblewrap and Seatbelt profiles may block connects ([R2] names the sandboxes, not their socket rules) |
| Deny-rule syntax for Git writes | Help example only: `"Bash(git *) Edit"` (`--disallowedTools`); matching semantics Assumption | None documented in [R2] |
| Provider commit or attribution setting | None in help except `--bare` ("skip ... attribution"), unusable (ADR-0015); the FR-GIT-04 sanitiser stays necessary | None in [R2] |

*Socket path length (observed).* A UNIX socket path is limited by the kernel (`UNIX_PATH_MAX` is 108 in
`/usr/include/linux/un.h`); on this host Python's `bind` failed with "AF_UNIX path too long" at 167 bytes and
`gpg-agent` would not start with a `GNUPGHOME` under the long scratchpad path, but started under `/tmp`. Node 22.22.0
`listen` and `connect` both worked at 157 bytes yet left no file at that path, which was not investigated.
`<data_dir>/runs/<run_id>/tools.sock` (LLD §12.2) can be long when the operator's data directory is, so the socket path
needs a length check at startup, or a short directory; that is a T9.4 design point, not decided here.

*T9.3 build notes (2026-10-13; Delegated; [ADR-0025](../adr/0025-git-commit-provenance-and-sanitiser.md); verified on Git 2.43.0
only).* The plumbing sequence verified in the T9.0 note is implemented in `src/git/commit.ts` and run through the hardened
helper in `src/workspace/git.ts` (scrubbed environment, `core.hooksPath=/dev/null`, drivers neutralised, no user
configuration). Additions and findings:

- **Temporary index.** `GIT_INDEX_FILE` points at a file in a private `0700` directory under the caller's scratch directory
  (it must lie outside the worktree and the repository); it is removed after `write-tree`. The worktree's own index file,
  `HEAD`, run branch and `git status` were byte-identical before and after in every test, including after a simulated
  crash at each step. `GIT_OPTIONAL_LOCKS=0` (already in `scrubbedGitEnv`) keeps read commands from rewriting indexes.
- **Environment.** The helper accepts extra variables only from an allowlist (`GIT_INDEX_FILE`, `GIT_AUTHOR_*`,
  `GIT_COMMITTER_*`); any other key throws. The agent's environment never reaches these calls.
- **Staging.** `git --literal-pathspecs add -- <paths>` for a subset; `git add -A -- . <nested excludes>` for all changes
  (pathspec magic needs the flag off, so the two modes differ, and a directory path that contains a nested repository is
  refused rather than expanded). File names starting with `-` or `:` and containing `*` or `[` were staged literally. Deletions
  are staged. `git ls-tree -r -z --name-only` (with `--literal-pathspecs`) decides whether a missing path is a deletion;
  `git check-ignore --no-index -z --stdin` decides ignored paths (a tracked file that is now ignored is allowed).
- **Message and patch id.** The message goes to `commit-tree -F -` on standard input; `git patch-id --stable` over `diff-tree
  -p --no-ext-diff --no-textconv` gives the 40-hex patch id (best effort, `NULL` if it fails). No `gpgsig` header appears
  although the repository configured `commit.gpgsign=true` with a missing program (signing is T9.10).
- **Hooks.** A repository `reference-transaction`, `pre-commit`, `commit-msg` and `post-commit` hook that exits 1 did not
  stop `update-ref` or `commit-tree` through the helper (test "ignores repository hooks and user configuration"), which
  answers the "not tested" hook question of the T9.0 note for these commands on 2.43.0.
- **Regular-expression safety.** Measured on Node 22.22.0: `.*a.*b` (two unbounded quantifiers) took 36 s on a 4096-character
  line of `a`, so the operator-pattern subset allows one unbounded quantifier and windows of 1024 characters; see ADR-0025
  and LLD §12.4. Node has no RE2 and cannot time-box a synchronous `RegExp`.
- **Still open.** Git 2.32 to 2.42 were not exercised; clean and smudge filters, submodules and large path sets were not
  tested; the shim, socket, snapshot freeze (Q-41) and start-up `recover()` call belong to T9.4.

*T9.4 build notes (2026-10-13; Delegated; [ADR-0026](../adr/0026-per-run-tool-channel-socket-and-token.md); fake adapter
only).* The injected channel is built and tested end to end with the fake adapter; mechanism in [LLD
§12.2](LLD.md#122-channel) (as-built note). Findings and test strategy:

- **No provider declares a channel.** Claude Code and Codex declare `gitCapabilities.commitChannel = "none"` with the
  reason (Q-40 still bars `--mcp-config`; the per-run definition shape, MCP allow rules, `--safe-mode` and socket reach
  are unverified; Codex is not installed). Their compiled argv is unchanged, so every existing argv test still holds.
- **Socket path length.** On this host Node 22.22.0 `listen()` accepted a 251-byte Unix socket path and no file existed
  at that path afterwards, which is consistent with silent truncation by the library (where it bound was not determined).
  The service therefore checks the length itself (at most 100 bytes) and falls back to a short private directory.
  `server.close()` removed the socket file on this host.
- **Peer credentials.** Node.js has no `SO_PEERCRED` API, so the peer is not identified; the directory mode, socket mode
  and token are the controls (R-46). The test host runs as root, so the tests check modes and ownership rather than an
  access denial.
- **Tests (no provider CLI, temporary repositories).** `src/git/channel.test.ts` drives the real socket with a raw client:
  modes and ownership, wrong, foreign, forged and truncated tokens, calls while not RUNNING and after a binding change,
  malformed, oversized, unterminated and silent requests, argument and path refusals (`..`, absolute, through a symbolic
  link, `.git`), unknown tools, the rate limit and the refusal-event cap, two concurrent commits (the second loses the
  compare-and-swap, retries and lands), close with a half-open connection, the long-path fallback, and the crash sweep
  (a killed process's stale socket is removed; links, foreign directories and fallback directories outside a configured
  parent are kept). `src/lifecycle/git-channel.test.ts` runs the lifecycle with the fake CLI, which starts the real
  `tool-shim` (TypeScript entry) and calls `commit` over MCP: publish ref advanced, provenance row, trailer removed,
  operator checkout, run branch and worktree unaffected; refusals through the shim; cancel removes the socket; no token
  bytes anywhere in the data directory. `src/cli/serve.test.ts` repeats the commit through `serve` (stderr and data
  directory searched for the token prefix) and shows that a SIGKILLed daemon's socket directory is removed by the next
  start.
- **Still open.** Live provider checks (R-18, Q-40), a provider sandbox's effect on the connect, `push` (T9.6),
  finalize-only (T9.7), and enforcement of "`none` is ineligible for write-capable profiles without opt-in" (Q-43).

*T9.5 build notes (2026-10-13; Delegated; [ADR-0027](../adr/0027-ref-snapshots-and-violation-handling.md); layer 5 of
the table above; fake adapter only, Git 2.43.0).* Mechanism in [LLD §12.5](LLD.md#125-ref-snapshot-and-violation-handling)
(as-built note). Findings and test strategy:

- **Layer 5 runs for every worktree run**, whatever the adapter, profile or bypass approval; it is not configurable. A
  violation never fails the run (BR-27). The controller restores only its own refs (run branch, worktree `HEAD`, publish
  ref) and reports the rest, because it cannot tell an agent's change from the operator's (R-47).
- **Restoring the run branch with `update-ref`** (not `reset`) leaves the worktree files and index as the agent left
  them; the checkpoint's `add -A` then records the agent's tree on top of the `pre` commit. After an agent `git commit`
  the checkpoint holds the committed file; after `git reset --hard HEAD~1` it records the reversion as a deletion; after
  `git checkout -b` the worktree `HEAD` is pointed back with `symbolic-ref` so the checkpoint lands on the run branch.
- **`git push` to a configured remote** updated `refs/remotes/<remote>/<branch>` on Git 2.43.0 (checked in a scratch
  repository with a worktree and a local bare remote), so a push through a configured remote is detected; a push to an
  explicit path or URL leaves no local ref and is not.
- **Tests (no provider CLI; temporary repositories; plain Git porcelain and plumbing only).** The fake scenario
  `git_attempts` (`src/adapters/fake/cli.mjs`) runs `git commit`, `branch`, `tag`, `update-ref` (on the publish ref and
  the default branch), `push` to a local bare repository, `reset --hard` and `checkout -b` inside the run worktree, plus
  optional `commit` tool calls; `src/lifecycle/ref-guard.test.ts` asserts the events, restores and checkpoint content
  for each, that legitimate tool commits and checkpoints are not flagged and that no-op runs are clean.
  `src/git/ref-guard.test.ts` covers the cap (3000 and 6000 refs; tail digest), other runs' controller moves,
  idempotence, `check_failed`, `snapshot_missing`, a privileged bypass run, and the ref list hidden from `get_run`.
  `src/reconcile/reconcile.test.ts` SIGKILLs a controller child between LEASED and FINALIZING and shows reconciliation
  using the stored snapshot. No test escapes the worktree, reads credentials or uses the network (adversarial cases are
  T3.8b).
- **Still open.** The same attempts through Claude Code and Codex (live checks C-G2 and X-G1), per-worktree refs, Git
  versions other than 2.43.0, and whether a push should be refused after a violation (Q-44).

*T9.6 build notes (2026-10-13; Delegated; [ADR-0028](../adr/0028-controller-push-and-credential-reach.md); the
**Publication** paragraph above; fake adapter and local bare remotes only, Git 2.43.0).* Mechanism in [LLD
§12.6](LLD.md#126-push-algorithm) (as-built note). Findings and test strategy:

- **The push is the one controller Git call with the operator's configuration.** Every check before it uses the hardened
  helper; the push itself gets an allowlisted environment (where Git finds the operator's global configuration, SSH
  agent, credential-helper session and proxy), no terminal (`detached`, standard input closed, so neither Git nor SSH
  can prompt), command-scope `-c` settings that switch hooks, tag following, signing and submodule recursion off and
  allow only `https`, `ssh` and `file`, and `--porcelain --no-verify`. A repository whose own configuration sets a
  command or redirect key (`core.sshCommand`, `credential.helper`, `remote.*.receivepack`, `url.*.insteadOf`,
  `protocol.*`, ...) is refused rather than overridden, because a multi-valued key cannot be reset at command scope
  without also discarding the operator's global setting.
- **Never forced by construction.** The refspec is `<verified sha>:refs/heads/<prefix><sess>`; Git refuses a
  non-fast-forward itself, which is recorded. Only commits with a provenance row of the meta-session can be pushed, so
  checkpoint and run-branch commits cannot, whatever the publish ref points at.
- **Observed on Git 2.43.0** (scratch repositories, a local bare remote): `--show-scope` reports values from an
  `include` file in `.git/config` as `local`, and values from `GIT_CONFIG_PARAMETERS` as `command` (this host's own
  environment sets some; the hardened helper does not inherit them); `push -- <remote> <sha>:<ref>` works with `--`;
  `protocol.allow=never` plus per-protocol `always` gives `fatal: transport 'ext' not allowed` (rc 128); a rejected
  update prints `!\t<src>:<dst>\t[rejected] (non-fast-forward)` on stdout under `--porcelain`; a push through a
  configured remote updates `refs/remotes/<remote>/<branch>`, which the T9.5 ref guard now expects when an accepted
  `git_push` row matches it.
- **BR-31.** A profile qualifies only with shell `none` or an empty allowlist; a non-empty allowlist is refused because
  the controller cannot judge what a listed program can read (R-48 records the remaining file-read-tool gap). Host runs
  with a shell therefore cannot use the agent `push` tool; the operator command `switchboard git push` (or a `container`
  environment, M10) is the route. **Exception (owner decision 37, zemdregon: "BR-31. Don't block git operations on bypass
  mode"; Delegated narrow reading):** an approved bypass run (scope `bypass` and a controller-verified approval, from
  `bypassApprovedFor`, never from agent-supplied data) is offered `push` and accepted with the reason `bypass_exempt`
  recorded; the push itself, the provider's Git-write denial and non-bypass runs are unchanged. The agent of such a run
  can read push credentials if its shell can (R-51); the controller never gives them to it.
- **Tests (no provider CLI, no network; temporary repositories and a local bare remote; the push's `HOME` is a temporary
  directory).** `src/git/push.test.ts` (policy, target, refusals, URL and remote classification, environment allowlist,
  hooks never run, repository command keys refused, remote hook output not stored, violation, BR-31 table, recording,
  concurrency), `src/lifecycle/git-push.test.ts` (the fake agent's `commit` then `push` through the real shim; shell
  profiles withhold `push`; policy `none`; configuration re-read; argument and limit refusals; the ref check stays
  clean), `src/cli/git-push.test.ts` (operator command, lock, config refusal of a URL remote, `runs show` provenance).
- **Still open.** `https` and `ssh` remotes with a real credential helper, SSH agent or proxy (the standard-error
  classification is tested on fixed strings only), Claude Code and Codex channels (T9.4; Claude's is T9.4b,
  [ADR-0029](../adr/0029-claude-code-receives-tool-shim-via-mcp-config.md)), container environments (M10), and pushing
  while `serve` runs (R-49).

*T9.7 build notes (2026-10-13; Delegated; [decision 38](../ROADMAP.md#42-owner-decisions); the **Finalize-only mode**
paragraph above; fake adapter only, Git 2.43.0).* Mechanism in [LLD §12.3](LLD.md#123-commit-algorithm-and-refs)
("As built (... T9.7 ...)"). Findings and test strategy:

- **Same machinery, different trigger.** The commit goes through the T9.3 `GitPublisher` (temporary index, sanitiser,
  identity, lineage check, intent and compare-and-swap, provenance in one transaction, `recover()`), from a second
  instance that accepts only FINALIZING runs; nothing new reaches Git. The opt-in is per context (`finalize_commit`,
  default off), frozen at admission, and applies only to adapters that cannot take the channel; a `none` adapter
  without it is not made ineligible (Q-43, owner decision 36).
- **Fail closed without changing the run.** Anything the controller cannot justify (a violation anywhere in the
  meta-session, no usable or an over-long summary, too many paths, a refused path, a failed run) means no commit and a
  recorded reason; the controller never writes a message of its own (FR-GIT-04, and the M11 rule FR-INN-10 by
  analogy). The run's outcome and the diff and checkpoint artifacts are the same with and without the commit.
- **Bypass.** Handled identically: the commit happens after the ref check and the provider's Git-write denial is
  unchanged, so an approved bypass Claude run in an opted-in project ends with one clean commit on the publish ref. The
  one difference (decision 44, Q-45): an approved bypass run is not skipped for more than 256 paths or a summary over
  8192 characters; it commits all paths and a sanitised-then-truncated message with a note.
- **Tests (no provider CLI; temporary repositories and a local bare remote).** `src/lifecycle/finalize-commit.test.ts`
  with a fake adapter variant declaring `commitChannel: "none"` and the `edit_files` scenario: opt-in off and on, exact
  paths (modify, delete, add), identity, sanitised summary (a `Co-Authored-By:` trailer and a `claude.ai/code` session
  URL removed), provenance row and `via: "finalize"`, worktree index, `HEAD` and run branch unchanged, violation,
  missing and attribution-only summaries, failed run, `injected` adapter, refused path, crash after the ref update and
  after the intent (`recover()`), approved bypass, and the operator push of the finalize commit plus `runs show`.
- **Still open.** Claude Code and Codex live runs (their summaries' real shape: Claude's `result` text, Codex's last
  agent message, FR-ADP-04), container environments (M10), and the live behaviour of a very large bypass commit (Q-45 is
  decided, decision 44).

*T9.4b build notes (2026-10-13; Delegated; [ADR-0029](../adr/0029-claude-code-receives-tool-shim-via-mcp-config.md);
behind the operator opt-in `providers.claude-code.git_channel`; **UNSUPPORTED, no live check run**).* Mechanism in
[LLD §12.2](LLD.md#122-channel) ("As built (... T9.4b ...)"). Findings and test strategy:

- **Off by default, byte-identical.** Without the opt-in the Claude adapter declares `none` with the T9.4 reason and its
  compiled argv is unchanged; with it, `compile` is still unchanged and only the `channelArgs` fragment is added, so
  every existing argv test holds.
- **Decisions where the help text is silent (Assumptions, each failing closed).** The fragment is
  `--mcp-config <dir>/mcp-config.json --allowedTools mcp__switchboard-git__<tool>...`. The channel tools are not named
  in `--tools`, because the help says it lists tools "from the built-in set"; if `--tools` also filters MCP tools the
  tool is absent. The exact-name rules are a second `--allowedTools` occurrence; if the CLI keeps only the last
  occurrence the earlier read and edit rules are lost and the run is denied more. The definition uses the `.mcp.json`
  form (`mcpServers`, `"type": "stdio"`) and an `env` reference `${SWITCHBOARD_TOOL_TOKEN}`; if it is not expanded the
  shim sees a non-token value and every call is refused. `--strict-mcp-config` is already compiled on every invocation
  except decision 26's, so no flag is added; `--safe-mode` stays (live check (c)).
- **Audit.** The argv audit admits the one shape and nothing else, independently of the adapter: the definition path
  comes from the channel service, the tool names from the channel, the decision-26 exception from the run's approval
  context. The file check is repeated before spawn (plain `0600` file, owned by this user, private directory).
- **Tests (no provider CLI, temporary repositories).** `src/adapters/claude/channel.test.ts`: off-snapshot, fragment,
  file contents (one server, no token), malformed shims, each profile including approved bypass with every
  `repository_config`, and the audit's negatives (no channel, inline JSON, other or sibling paths, a second occurrence
  or value, the `=` form, server-wide, wildcard, foreign and unoffered MCP rules, rules outside `--allowedTools` or in
  `policyFlags`, missing `--strict-mcp-config`, unsafe file modes and links). `src/git/channel.test.ts`: `writeFile`
  modes, name allowlist, token refusal, planted link, removal on close, crash sweep and directory reuse.
  `src/lifecycle/claude-channel.test.ts`: the lifecycle with the Claude replay script standing in for `claude`, which
  reads the definition, starts the real `tool-shim` from it (expanding the reference as Claude Code is assumed to) and
  commits through the socket; the evidence record shows one server, mode `0600`, no token in argv or the file, and the
  file and directory are gone after the run; a fragment naming another file or a wildcard rule fails
  `PERMISSION_BLOCKED` before spawn.
- **Still open: the live checks** (ADR-0029 item 7, listed in ROADMAP T9.4b). Nothing here shows what the installed
  `claude` does with the definition.
- **Update 2026-10-13 (owner decision 41, [ADR-0033](../adr/0033-claude-channel-bypass-only-without-safe-mode.md)).**
  The operator-machine live check (`docs/research/live-checks-2026-10-13.md`, PR #41; Claude Code 2.1.296, a hand-made
  stdio server) confirmed the `mcpServers` shape, `${VAR}` expansion (unset stays literal), that the server inherits the
  claude environment and that exact-name rules work under `dontAsk`, and found that `--safe-mode` stops the server. The
  channel is now offered only to an approved bypass run, whose fragment removes `--safe-mode`; every other run with the
  opt-in on has the argv of the opt-in off and uses finalize-only. Tests added: every non-bypass profile gets no channel
  and an identical argv; the audit refuses `--mcp-config` outside an approved bypass run or without the token variable,
  and a Claude argv without `--safe-mode` outside the approved bypass cases; the lifecycle replay runs an approved
  bypass run and records a child environment of only `PATH`, `HOME` and the token, and an `edit-untrusted` run with the
  opt-in on and the project's `finalize_commit` gets its commit through finalize-only. Still unproven end to end through
  Switchboard with the real `claude` (shim start, socket reach, Git deny rules with the server present).

**External reference (T3 Code, MIT, studied not copied; note 2026-10-13, Delegated, not owner-approved).** zemdregon's
pointer (owner decision 36): T3 Code "has orchestrator injection for nearly all of the CLI tools we are targeting". A
research pass read the public repository `pingdotgg/t3code` at commit `6524a8d` (MIT, (c) 2026 T3 Tools Inc.) without
running or installing anything. Labels: *observed in T3 Code source at commit 6524a8d* means a research subagent read
that code (VERIFIED-IN-SOURCE there; still **unverified on our CLIs**); SECONDHAND means issue, pull-request or
third-party documentation text only; UNKNOWN means not found. **These are leads for the open T9.0 items and for T9.4b
and the other adapter tasks. None is verified here. Switchboard must not copy T3 Code's code, identifiers, comments or
documentation**; it implements from each provider's documentation and the installed `--help` (R-50).

- *Shape.* T3 serves a loopback HTTP MCP server with a per-provider-session bearer token (observed in source: 32 random
  bytes, kept hashed, scoped to the session and revoked with it). Switchboard differs on purpose: a Unix-socket stdio
  shim, so the controller listens on no network port ([ADR-0026](../adr/0026-per-run-tool-channel-socket-and-token.md)).
  The server, not the provider, checks authorisation; the provider-side allow rule only gets past the provider's own
  approval gate.
- *Claude Code.* Observed in source: T3 drives Claude through the Agent SDK and passes `mcpServers` over the CLI's stdin
  control channel, because the SDK would otherwise pass an inline `--mcp-config` argument that every local user can
  read (the reason [ADR-0029](../adr/0029-claude-code-receives-tool-shim-via-mcp-config.md) uses a `0600` file); it
  pre-approves with `allowedTools` `mcp__<server>__*` (an explicit per-tool list in its read-only mode), notes that
  headless `dontAsk` denies anything not pre-approved, and sets a per-server timeout because Claude aborts an HTTP MCP
  call after 60 seconds by default. `--strict-mcp-config` is **not** used for its chat sessions (user, project and local
  settings still load, so it is additive); only its capability probe uses it. Switchboard's exclusivity needs
  `--strict-mcp-config` (decision 26 aside). Flag name `--mcp-config` confirmed against our `claude --help` 2.1.296; the
  rest unverified on our CLI.
- *Codex.* Observed in source: `codex app-server` is spawned, and each thread start, resume or fork carries
  `config.mcp_servers[<name>]` (URL and `http_headers`), which Codex layers above the user's and project's
  configuration. T3's own documentation still describes the older `-c mcp_servers.*` plus `bearer_token_env_var` form,
  which is stale against its code. SECONDHAND: a per-thread `mcp_servers` override may replace servers added by `-c`
  launch arguments; under `approval_policy = never` a tool needing approval may be refused unless
  `default_tools_approval_mode` is set; a separate `CODEX_HOME` isolates configuration but needs its own login, which
  collides with [ADR-0003](../adr/0003-no-credential-handling.md). Codex is not installed here; nothing is verified.
- *Cursor.* Observed in source: Cursor SDK `AgentOptions.mcpServers` (HTTP type), re-sent on each send; the user and
  project settings sources are loaded too (additive). The Cursor CLI route is UNKNOWN; MCP-specific approval is UNKNOWN
  (R2 lists `--approve-mcps`, which FR-POL-03 treats as a bypass flag).
- *OpenCode.* Observed in source: T3 spawns `opencode serve` and, per turn, calls `client.mcp.add` with a per-thread
  server name and bearer header, then removes it; it adds session permission rules (deny its own prefix, allow the
  thread's server; last match wins). SECONDHAND: servers added at runtime can be evicted when idle, may be missing on
  the first turn, and a long server name is skipped, so a controller using this route must re-add and verify each turn.
  A config-by-environment route is not verified.
- *Grok Build and Antigravity.* Observed in source: both are ACP agents; T3 passes ACP `mcpServers` with a **stdio**
  bridge process whose endpoint and credential are in its **environment, never its argument list**. This is the closest
  analogue to Switchboard's shim. Its comment says some ACP agents advertise HTTP MCP yet drop it, which is why stdio
  is used. SECONDHAND: Grok adds client-supplied servers on top of the user's configuration and has no strict flag.
  Antigravity's own configuration and whether it honours stdio `mcpServers` are UNKNOWN.
- *Kimi Code.* UNKNOWN: not found in T3 Code.
- *Open questions it leaves* (all for T9.0 / adapter tasks, on our CLIs): does a stdio shim run headless under each
  provider's non-interactive mode; do exact-name allow rules cover its tools under each fail-closed mode; do provider
  sandboxes allow the socket connect; how does each merge with user and repository MCP configuration; is registration
  verifiable (T3 checks for failures because registration can fail silently).

### 3.11 Container environments

Implements FR-PRJ-04, 05, 07, 09 for M10. Status: **Proposed**. zemdregon left Q-6 to the agent ("the rest you pick"),
so the choices below are Delegated, not owner-approved, and unverified until the M10 spike.

- **Runtime.** A rootless OCI-compatible runtime that the controller drives through its CLI (Proposed; rootless Podman
  is the likely candidate, unverified). The controller must run unprivileged (NFR-SEC-04), so a root-owned daemon is out;
  the port is small (create, start, stop, remove, list by label) so the choice stays replaceable.
- **Image.** Operator-supplied and pinned by digest (Proposed); the controller never builds images or pulls implicitly.
  The image contains the provider CLI the project uses and **no Git client** (no `git`, no `gh`; owner decision 24,
  FR-PRJ-05): `projects validate` and container creation look for them on the container's `PATH` and refuse the image
  if found. Whether each provider CLI works without a Git client is checked in the M10 spike (ROADMAP R-40).
- **Mounts.** The run worktree (writable) and declared read-only contexts only. Not the home directory, data directory,
  runtime socket, or any Git credential store. The worktree's Git directory (under the main repository) is **not**
  mounted, which also keeps refs out of reach (layer 4 above). Git operations, including read-only ones such as
  `git diff`, run in the controller on the host, not in the container (owner decision 24); the agent sees the worktree's
  files only.
- **Provider logins (Proposed).** The provider CLI inside the container needs its native login. FR-AUTH-01 forbids the
  controller copying or moving credentials between identities or machines, so mounting the host's credential directory is
  out unless zemdregon decides otherwise. Chosen (Proposed): the operator runs the provider's native login command
  inside the project's container volume once (for example through a `projects login <id> <provider>` operator command
  that only attaches the operator's terminal to that command; the controller never reads the result). Whether that is acceptable
  to each provider's terms is unreviewed (compliance manifest
  review, R-2). The M10 spike must confirm this with each provider before M10 is marked done.
- **Network.** The run's profile maps to the container's network: off for untrusted profiles; allowlist only if the
  runtime can enforce one (to be verified).
- **Limits.** CPU, memory and disk limits from the project, which partly answers R-8.
- **Cleanup.** Every container carries labels with the run and project IDs. Removal at run end, and a label sweep at
  startup before worktrees are assessed (FR-PRJ-07).

### 3.12 Inner agent

Implements FR-INN-01..17 and [ADR-0016](../adr/0016-inner-agent.md) for M11 (COMP-INN, TB-10); schemas, pipeline and task
contracts are in [LLD §13](LLD.md#13-inner-agent). Status: **Proposed**. zemdregon decided that an inner agent exists and
which tasks motivate it (owner decision 14); everything below is Delegated and unverified until M11 lands.

- **Technology (Proposed).** The `http` kind uses the Node built-in `fetch`/HTTP client (and `node:net`/`node:http`
  for a Unix socket); no new dependency and no vendor SDK, so the controller does not pick a provider or carry a provider's
  client code and credential handling (ADR-0003). Schema validation reuses Ajv (§2). Redaction reuses the telemetry
  redactor (§3.3), not a second implementation. The wire mapping of a request onto a chat-completion body is isolated
  behind the backend port ([LLD §13.2](LLD.md#132-backend-port)) and is fixed in T11.3 against the operator's endpoint.
- **Threading and concurrency.** Same single process and event loop as §3.5; no worker thread. A per-backend semaphore
  (`max_concurrency`, proposed target 2) bounds simultaneous calls, and every call carries an `AbortSignal` with the
  per-call deadline, so an inner call is never on a run's critical path beyond that bound. The run supervisor, lease
  heartbeats and reconciliation do not await the pipeline; the only synchronous waits are the `commit` tool call (the
  agent waits for a draft at most the bound) and stage-2 routing at dispatch, not the `delegate_task` acknowledgement.
  The circuit breaker and the quality window are in-process state backed by `inner_call` and `inner_task_state`
  ([LLD §13.4](LLD.md#134-call-pipeline)). The `cli` kind kills its process group at the deadline, as the supervisor does.
- **Testing strategy.** All of it runs with no inner model, provider CLI or network (AGENTS.md):
  - A **scripted fake backend** is a local HTTP server on a loopback ephemeral port inside the test, with scenarios for
    valid output, delay, error status, dropped connection, empty body and
    non-UTF-8 bytes. It also records the exact request it received.
  - **Hostile backend fixtures** drive the pipeline and the commit tool end to end: a draft containing `Co-authored-by:`
    and "generated with" lines; a draft containing a `run_` or `sess_` ID and the run's native session ID; a huge output
    (over the output cap); invalid JSON, wrong types and extra keys; prompt-injection text ("ignore the above and ...",
    a fake tool call, a claim that all tests pass) in the output. Expected: a clean commit through the sanitiser, a
    fallback, or the `MESSAGE_REQUIRED` tool error, and in no case a run state change.
  - **Secret-planted-in-diff test.** A repository diff, log and objective containing planted credential-shaped strings,
    a home path and a controller ID are fed to each task; the captured request body is asserted to contain none of them
    (the telemetry-redactor and identifier-scrub contract), and a recursive scan of logs, spans, events and the ledger
    finds no prompt or response body (FR-INN-16).
  - **Import-boundary test.** A static check (an import-graph test over the TypeScript sources, in the style of a lint
    rule run by Vitest) fails if COMP-POL, any adapter's profile compiler, the retry and failure-classification logic, the
    approval and eligibility code, the push path or the sanitiser rule table imports the inner-agent service or its types
    (FR-INN-06). A second test asserts that run state, exit code and verification results are identical with the fake
    backend returning hostile output and with the inner agent off.
  - **Privacy gates and locality.** Table-driven over [LLD §13.5](LLD.md#135-privacy-gates), including a hostname that
    resolves to loopback at load and elsewhere at connect time (a test resolver), a Unix socket, and the always-`remote`
    `cli` kind.
  - **Accounting and replay.** `get_capacity` and the estimator are byte-identical with and without inner calls;
    `shares_subscription_with` yields one labelled `usage_observation`; route replay with the backend off reproduces the
    stored decision.
  - **Default test run makes zero live calls.** `npm test` starts only the fake backend. Live inner calls are opt-in, in
    the same pattern as the provider smoke test (§3.6): proposed `SWITCHBOARD_LIVE_TESTS=1` plus
    `SWITCHBOARD_LIVE_INNER=1` and an operator-supplied `SWITCHBOARD_LIVE_INNER_CONFIG` path (names Proposed), run by
    `npm run test:live`, never in CI, sending only the built-in `inner test` fixture and never repository data or
    credentials.
- **Observability.** One `inner.call` span per call and `inner_call`, `inner_degraded` and `inner_task_suspended` run
  events with no bodies ([LLD §13.8](LLD.md#138-telemetry-and-events)); `doctor` shows reachable, locality, canary result,
  enabled tasks and degraded or suspended state; `inner status` prints per-task outcome counts and fallback rates from
  `inner_call`; `inner test <task>` runs the fixture (FR-INN-17). Logs follow §3.3: sizes and hashes, never text.
- **OpenCode `cli` kind (Proposed, flags unverified).** [R2] lists `opencode run`; it does not show that a one-shot,
  tool-free completion with an operator-chosen model, an empty working directory and no repository config is possible
  (Q-26). No flag is stated here. Until the T11.0 spike shows the controls that apply for the installed version and writes
  them, with version and date, into [§4.6](#46-opencode-m4), the kind is `Ineligible` (reported by `doctor`, never
  run), and the adapter's argv audit applies (no bypass flag). The `http` kind alone satisfies FR-INN-03.

### 3.13 Retrieval index

Implements FR-RAG-01..14 and [ADR-0031](../adr/0031-retrieval-index.md) for M12 (COMP-RAG, TB-11), and describes how
FR-RTE-06..09 and FR-CAP-08 ([ADR-0032](../adr/0032-provider-model-affinity.md), M6 and M7) are tested. Schemas,
algorithms and the tool contract are in [LLD §14](LLD.md#14-retrieval-index) and [LLD
§3.2](LLD.md#32-provider-and-model-affinity-m7). Status: **Proposed**. zemdregon asked for a per-project automatic
index, a possible deployment-wide index and sticky provider and model use (owner decision 40); every choice below is
Delegated and unverified until the T12.0 spike.

#### 3.13.1 Storage and search (Proposed, Q-48, T12.0)

- **Store.** One SQLite file per project and one for the global index under `<data>/rag/` (HLD §5), opened with the
  existing `better-sqlite3` dependency (§2) but never through the ledger module: the ledger stays the single writer of
  `ledger.db` (ADR-0005), and a retrieval store is a derived cache that can be deleted and rebuilt. Chunk text and
  float32 vectors are BLOB columns. Search is a brute-force cosine scan in process over a hard cap on chunks per store,
  so no native vector extension and no new dependency is needed. An approximate-nearest-neighbour index or a vector
  extension is adopted only if the T12.0 spike shows the cap is too low for real projects, and then by a new ADR.
- **Why not a vector database service.** It would add a network listener or a second process to a single-operator,
  local-first deployment (ADR-0011, NFR-PRIV-01) and a new trust boundary. Rejected for the default; the backend port
  below does not preclude a later one.
- **Embedding backend.** One port, kinds `local` and `http`, sharing the locality classification, `allow_remote` and
`allow_source_content` gates of the inner agent (TDD §3.12, LLD §13.5), with no credential in configuration (ADR-0003).
The `http` kind reuses the Node built-in HTTP client as in §3.12. Which model, dimension, batch size and latency to use
is an operator decision: none is named or assumed here, and the vector dimension is read from the backend and stored
with each store so a model change forces a rebuild (LLD §14.2).
- **Threading.** Same process and event loop as §3.5. Builds run as a background job in `serve`, in small batches that
yield between files, with caps on files, chunks, bytes and elapsed time (FR-RAG-11). A brute-force scan over the capped
store runs synchronously in a bounded loop; whether it must move to a worker thread is a T12.0 measurement, not an
assumption. Admission waits for retrieval at most a configured bound and then proceeds without a pack (FR-RAG-08).
- **Redaction.** Reuses the telemetry redactor (§3.3) and the FR-INN-16 pass, not a second implementation; the secret
  denylist is a path and name pattern table beside the sanitiser patterns, operator-extensible by `exclude`.

#### 3.13.2 Observability

`rag_index_built` and `rag_retrieval` records and run events carry counts, durations, backend id and snippet ids and
hashes, never text ([LLD §14.10](LLD.md#1410-events-and-records)); `doctor` reports backend, locality, store sizes,
revision and staleness (FR-RAG-14). Embedding calls never enter `usage_observation` or capacity (FR-RAG-12).

#### 3.13.3 Testing affinity and retrieval

All of it runs with no embedding model, provider CLI or network (AGENTS.md); `npm test` makes zero live calls.

- **Fake embedding backend.** A deterministic in-process backend (a hash-seeded bag-of-tokens projection to a small
  fixed dimension, so similar text is nearer and identical text gives identical vectors) plus a scripted local HTTP
  server for the `http` kind with scenarios for success, delay, error status, dropped connection, wrong dimension and
  non-finite values. Results are exactly reproducible, so ranking tests assert order, not scores. The dimension and
  scheme are test fixtures, not claims about any real model.
- **Scanner and exclusions.** Real temp Git repositories with planted `.env` files, key and certificate files,
  credential-looking names, binary files, files over the size cap, ignored files, a nested repository (ADR-0022) and a
  symlink leaving the root. Asserted: none is chunked, embedded or stored, and a planted credential-shaped string inside
  an included file is redacted before the embedding request body (captured by the fake) and before storage.
- **Isolation.** Two projects with distinct planted markers: no query, tool call or context pack for one returns the
  other's marker; deleting a project deletes its store; the global index is read only with `use_global` and a
  contributed snippet carries its origin label; a non-contributing project's marker never appears in it (FR-RAG-03,
  FR-RAG-09, FR-RAG-10).
- **Freshness.** A file edited, deleted or moved after indexing is dropped or re-read; a base-ref mismatch is flagged;
  an interrupted build leaves an incomplete marker; every injected failure (backend down, corrupt store, over budget)
  yields no pack and an unchanged run (FR-RAG-08).
- **Authority boundary.** An import-graph test, in the style of §3.12, fails if COMP-POL, the profile compilers, the
  eligibility, approval, retry or push code, or the sanitiser rule table imports the retrieval service; a second test
  asserts that run state, policy snapshot and route eligibility are identical with hostile retrieved text (a fake
  instruction to widen the profile or push) and with retrieval off (FR-RAG-07). The original request text is stored
  unchanged in every case (FR-RAG-05).
- **Locality gates.** Table-driven over the LLD §14.4 table, reusing the §3.12 test resolver.
- **Affinity replay.** A property test generates sequences of runs for a project against scripted adapters whose
  eligibility, capacity estimate and `QUOTA_EXHAUSTED` outcomes vary per step, then replays the persisted
`route_decision` rows and asserts: (1) the chosen provider and model equal the affinity unless the row carries a reason
from the closed list, (2) the reason matches the injected cause, (3) score, cost and load changes alone never produce a
switch, (4) after a switch the old provider is not chosen again when it recovers, (5) with `enabled: false` the M7
scoring behaviour is unchanged. Replay reads stored features, as for FR-INN-12; no clock or randomness enters the
decision. Cache accounting (FR-CAP-08) is tested with recorded fixtures that do and do not report cache tokens: absent
counts stay absent, never estimated.
- **Default posture.** With no embedding backend configured the feature is inert and the existing suite passes
  byte-for-byte (FR-RAG-04). Live embedding calls are opt-in in the pattern of §3.6, proposed
  `SWITCHBOARD_LIVE_TESTS=1` plus `SWITCHBOARD_LIVE_EMBEDDING=1` with an operator-supplied config path (names Proposed),
  never in CI, sending only a built-in fixture text.

## 4. Provider adapter strategy

Source of every fact in this section is [R2]. Anything not stated there reads "to be verified in Mx against installed
CLI"; no flag below is invented, and no flag is assumed to exist beyond what [R2] names. Trust profiles are defined in
SRS §3.3; compilation to native controls is **Proposed** (FR-POL-02: an adapter that cannot satisfy a profile is
ineligible for it, never downgraded). Bypass flags (`--dangerously-skip-permissions`, `--yolo`, `--force`,
`--always-approve`, `--approve-mcps`, `--full-auto`) are never emitted outside an approved `privileged` run (FR-POL-03).
Version ranges come from compliance manifests, not this table (FR-ADP-03, FR-POL-07).

### 4.1 Claude Code (M2)

| Aspect | Detail |
| --- | --- |
| Automation surface | `claude -p` ([R2]) |
| Structured output | `--output-format json` or `stream-json`; partial deltas with `--verbose --include-partial-messages`; final result carries `session_id` |
| Resume | `--resume <session>` and `--continue`; read `session_id` from structured output, never regex (FR-ADP-04) |
| Auth preflight | `claude auth status` returns structured JSON and exit codes; on failure return `AUTH_REQUIRED` naming the native login (FR-AUTH-02) |
| Trust profile compilation (Proposed) | Untrusted profiles: `--safe-mode --restricted --strict-mcp-config` (disable `CLAUDE.md`, skills, plugins, hooks and MCP servers, ignore settings files and confine file tools to the working directory; FR-POL-04), fail-closed `dontAsk` with `--permission-prompts none`, explicit `--tools`/`--allowedTools` rules; never `--allowedTools "*"` (skipped by Claude). **Not `--bare`:** the installed help says it makes auth strictly API-key based, which [ADR-0003](../adr/0003-no-credential-handling.md) and the Claude manifest forbid ([ADR-0015](../adr/0015-claude-untrusted-isolation-flags.md)). Verified against `claude --help` 2.1.296 text only; tool names beyond `Read`, `Edit` and `Bash(...)` rule syntax are Assumptions |
| Sandbox controls | None documented in [R2], and none in the installed help (T3.0, [§4.1.1](#411-claude-code-native-controls-per-profile-and-platform-t30)); `--safe-mode`/`--restricted` are not a sandbox and Bash/read/edit remain. Credential confinement unproven, so `inspect-untrusted` and `edit-untrusted` compile with no arbitrary shell (only `edit-untrusted`'s narrow allowlist), and `test-sandboxed` is ineligible for Claude until confinement is shown (FR-POL-06; M3 evaluation) |
| Known risks | Version-gated features; `total_cost_usd` is a client-side estimate (record as reported, never as remaining quota, FR-CAP-01/03); `PreToolUse` hooks are supplemental only; `CLAUDE_CONFIG_DIR` isolates config *and* credentials, so use only if it keeps the operator's login reachable (to be verified in M2); structured error categories (`rate_limit`, `overloaded`, authentication, billing, server) feed `classifyFailure` |
| Git writes and injected tools (M2, M9) | Verified against `claude --help` 2.1.296 text only (T2.2): every untrusted invocation passes `--disallowedTools` with `Bash(git <verb>)` and `Bash(git <verb> *)` for each Git write subcommand, the Git global options `-C`, `-c`, `--git-dir`, `--work-tree`, and `gh`, in the form of the help's example `Bash(git *)`; there is no Bash tool unless the operator allowlists exact commands, and an allowlist entry that could write Git is `Ineligible`; `--restricted` lets only a person or the permission handler approve file-tool writes to Git files, and `--permission-prompts none` means nobody does. Assumptions: `*` matches any suffix, deny wins over allow, deny rules for a tool absent from `--tools` are accepted. Limits: lexical rules cannot see aliases, scripts run by an allowlisted build tool or absolute paths to `git`. No commit or attribution flag is usable: the help names attribution only under `--bare`, which forces API-key auth ([ADR-0015](../adr/0015-claude-untrusted-isolation-flags.md)), and settings files are never written. `--bare` skips MCP discovery [R2], so the injected tools need an explicitly supplied per-run MCP definition (mechanism not in [R2]: to be verified in M9), and fail-closed `dontAsk` may require them pre-allowed |

#### 4.1.1 Claude Code native controls per profile and platform (T3.0)

Spike result, 2026-10-13 (Delegated agent work, not owner-approved). Nothing below was run against a model: the only
commands executed were `claude --version` (`2.1.296 (Claude Code)`), `claude --help`, `claude -p --help` (the same
options; only the usage line and the command list differ) and `claude auth --help` (commands `login`, `logout`,
`status`). No auth or configuration file was read. Sources, cited in every cell:

- **[H]** that help text, quoted exactly.
- **[AC]** `src/adapters/claude/adapter.ts`, the argv compiled today.
- **[R2 Lnn]** a line of the [verified research](../research/headless-ai-coding-controller-verified-2026-10-12.md).
- **[P]** the Proposed profile defaults in `src/policy/profiles.ts` (empty shell allowlists, network `off`, repository
  configuration `disabled`; ROADMAP Q-17).
- **[S]** the `privileged_scope` dimensions of [LLD §3.1](LLD.md#31-privileged-scope-m3).

Each cell is one of: **Compiles (as implemented today)**, with the flags; **Could compile**, with the documented control
and what is unverified (for T3.5); **Ineligible: `<reason>`**, using the `Ineligible.reason` codes of
[LLD §2](LLD.md#2-adapter-contract) (all give `ELIGIBILITY_NONE` there); or **Unknown: live check in T3.9**.

| Platform | Status |
| --- | --- |
| Linux | The matrix below |
| macOS | Not supported yet: NFR-PORT-02 (M4) and ROADMAP A-2; no cell evaluated |
| Windows | Not supported yet: NFR-PORT-03 (Deferred, ROADMAP §8); no cell evaluated |

**Permission- and sandbox-related options in [H]** (names exactly as printed): `--tools <tools...>`,
`--allowedTools, --allowed-tools <tools...>`, `--disallowedTools, --disallowed-tools <tools...>`,
`--permission-mode <mode>` (choices `"acceptEdits"`, `"auto"`, `"bypassPermissions"`, `"manual"`, `"dontAsk"`,
`"plan"`), `--permission-prompts <target>` (choices `"host"`, `"none"`), `--dangerously-skip-permissions`,
`--allow-dangerously-skip-permissions`, `--restricted`, `--safe-mode`, `--bare`, `--strict-mcp-config`,
`--mcp-config <configs...>`, `--settings <file-or-json>`, `--setting-sources <sources>`, `--add-dir <directories...>`,
`--plugin-dir <path>`, `--plugin-url <url>`, `--disable-slash-commands`, `-w, --worktree [name]`, and the command
`auto-mode` ("Inspect or reset auto mode classifier configuration"). [H] also says that under `-p` "The workspace trust
dialog is skipped" and "Settings files that fail validation are silently ignored".

**R-10 finding.** [H] has no sandbox option and no network option. The word "sandboxes" appears only in the
descriptions of `--dangerously-skip-permissions` and `--allow-dangerously-skip-permissions` ("Recommended only for
sandboxes with no internet access"). So no per-run native sandbox exists without `--settings` or global configuration,
as far as [H] shows. Whether a sandbox can be switched on through `--settings <file-or-json>` is not in [H] or [R2]
(Unknown: live check in T3.9); using `--settings` would also need a new ADR, because
[ADR-0015](../adr/0015-claude-untrusted-isolation-flags.md) forbids it. `--restricted` and `--safe-mode` remove tools and
customisations; they do not confine what an allowed command does (ADR-0015; [R2 L84] for `--bare`).

| Dimension | `inspect-untrusted` | `edit-untrusted` | `test-sandboxed` | `trusted-development` | `privileged` |
| --- | --- | --- | --- | --- | --- |
| Today | Compiles (as implemented today): `-p --output-format stream-json --verbose --safe-mode --restricted --strict-mcp-config --permission-mode dontAsk --permission-prompts none --tools Read,Grep,Glob --allowedTools Read Grep Glob --disallowedTools <Git deny rules>` [AC] | Compiles (as implemented today): as `inspect-untrusted`, plus `Edit,Write` in `--tools` and `--allowedTools` for a writable worktree, and `Bash` with one `Bash(<entry>)` rule per operator allowlist entry [AC] | Ineligible: `PROFILE_UNSUPPORTED` (no per-run sandbox in [H]; FR-POL-06, R-10, Q-16) [AC] | Compiles (as implemented today, T3.5): the `edit-untrusted` flags when network is `off`, shell is `none` or an exact allowlist and repository configuration is `disabled`; every other cell Ineligible: `CAPABILITY_MISSING` (see the rows below) [AC] | Compiles (as implemented today, T3.5, T3.17) from the approved scope when network is `on` and repository configuration `disabled`: with `bypass: false`, the `trusted-development` flags plus `WebFetch` and, for a shell, `Bash` with exact rules (`allowlist`) or the allow rule `Bash` (`broad`); with `bypass: true` and the run's `bypassApproved`, `-p --output-format stream-json --verbose --safe-mode --strict-mcp-config --dangerously-skip-permissions --permission-prompts none --tools <...> --allowedTools <...> --disallowedTools <Git deny rules>` (no `--restricted`, no `--permission-mode`). Other cells Ineligible with the reasons below; `bypass: true` without `bypassApproved`: Ineligible: `PROFILE_UNSUPPORTED` [AC] |
| File access | Compiles (as implemented today): read tools only; `--restricted` "confines the file tools to the working directories (--add-dir included)" [H], and `--add-dir` is never emitted [AC]. The names `Grep` and `Glob` are Assumptions [AC] | Compiles (as implemented today): adds `Edit,Write` [AC]; same confinement [H]; `--restricted` "lets only a person or the configured permission handler approve writes to settings, git and tool-configuration files" [H], and `--permission-prompts none` means nobody does. `Write` is an Assumption [AC] | Could compile: as `edit-untrusted` [H]; unverified: the tool names, and whether the confinement holds (Unknown: live check in T3.9) | Could compile: as `edit-untrusted`, keeping `--restricted`; [H] documents working-directory confinement only as part of `--restricted`, so without it: Unknown: live check in T3.9 | Compiles (as implemented today): `files.access` `read-only` as `inspect-untrusted`, `worktree` adds `Edit,Write` for a writable worktree [S, H, AC]; `read-only` with shell `broad`: Ineligible: `CAPABILITY_MISSING` (nothing in [H] stops a command writing files). In a bypass run `--restricted` is omitted, so [H]'s working-directory confinement of the file tools is not compiled; `--add-dir` and `--worktree` are still never emitted, so nothing adds a directory beyond the worktree (owner decision 19) |
| Shell | Compiles (as implemented today): no `Bash` in `--tools`; `--restricted` "removes the built-in tools that run commands or code (Bash, PowerShell, REPL and the other code-running tools) ... unless --tools names them" [H] | Compiles (as implemented today): no `Bash` unless the operator allowlists exact commands (default empty [P]); rule syntax from the [H] example `"Bash(git *)"`, exact match without `*` an Assumption; an entry that is not plain or could write Git is Ineligible: `PROFILE_UNSUPPORTED` [AC] | Ineligible: `PROFILE_UNSUPPORTED` for any build or test command: FR-POL-06 (read as covering this profile, Q-16) needs confinement away from credentials, and [H] has no sandbox (R-10). With the empty default [P] no command runs; compiling that case is T3.5's choice | Could compile: `allowlist` as `edit-untrusted`; `broad` as `Bash` in `--tools` with the allow rule `Bash` ([H] "tool names to allow") and the Git deny rules kept; unverified: deny wins over allow (Assumption [AC]). Same-user credential reach applies [R2 L220–224] | Compiles (as implemented today): `shell.mode` `none` (no `Bash`), `allowlist` (one exact `Bash(<argv words joined by spaces>)` rule per entry, each word plain; an entry that is not plain or could write Git is Ineligible: `PROFILE_UNSUPPORTED`), `broad` (`Bash` in `--tools`, allow rule `Bash`, Git deny rules kept; deny over allow an Assumption) [S, H, AC]. `allowlist` with `bypass: true`: Ineligible: `CAPABILITY_MISSING` ("Bypass all permission checks" [H], so allow rules cannot narrow `Bash`) |
| Network | Compiles (as implemented today), tool level only: no `WebFetch` in `--tools` ("Specify the list of available tools from the built-in set"), and `--restricted` removes WebFetch "unless --tools names them" [H] | Compiles (as implemented today) at tool level, as `inspect-untrusted`; an operator-allowlisted command is not network-confined, because [H] has no network control (R-36, Q-34) | `allowlist` hosts: Ineligible: `CAPABILITY_MISSING` (no host option in [H]); `off` [P]: Could compile at tool level while no `Bash` is compiled | `policy` or `allowlist`: Ineligible: `CAPABILITY_MISSING` ([H]); `off` [P]: Could compile at tool level with no shell or an exact allowlist (R-36); with `broad` shell, Ineligible: `CAPABILITY_MISSING` (nothing in [H] stops a command's network use) | `network.mode` `on`: Compiles (as implemented today) with `WebFetch` named in `--tools` [H, S, AC]; other network tools: Unknown: live check in T3.9. `off` and `allowlist`: Ineligible: `CAPABILITY_MISSING` ([H] has no network or host control, and unlike `trusted-development` a scope's network limit is not accepted at the tool level; owner decision 23, answering Q-36) |
| Repository config (`CLAUDE.md`, `AGENTS.md`, `.mcp.json`, hooks) | Compiles (as implemented today): `--safe-mode` disables "CLAUDE.md, skills, installed plugins, hooks, MCP servers, custom commands and agents, ..."; `--restricted` "ignores user, project and local settings files (managed settings and --settings still apply ...)"; `--strict-mcp-config` "Only use MCP servers from --mcp-config", none passed [H, AC, ADR-0015]. Admin-managed settings still apply [H]. Whether Claude Code reads `AGENTS.md` is in neither [H] nor [R2]: Unknown: live check in T3.9 | Compiles (as implemented today): as `inspect-untrusted` | `disabled` [P]: Could compile as `inspect-untrusted`. `approved-only`: approved MCP servers could be passed per run with `--mcp-config` plus `--strict-mcp-config` [H], which ADR-0015 forbids today (new ADR needed); approved hooks or instructions: Ineligible: `CAPABILITY_MISSING` (no per-item option in [H]) | `disabled` [P]: as `inspect-untrusted`. `allowlisted`: as `test-sandboxed` `approved-only`; `--setting-sources` selects whole sources ("user, project, local") [H], not items | `repository_config.mode` `disabled`: Compiles (as implemented today) with `--safe-mode --strict-mcp-config` and, without bypass, `--restricted` [AC]; `approved`: Ineligible: `CAPABILITY_MISSING` (as `test-sandboxed`); `enabled`: Ineligible: `CAPABILITY_MISSING` (Proposed: it needs omitting `--safe-mode` and `--restricted`, and without `--restricted` [H] documents no confinement of the file tools to the working directory; decision 19 keeps `--safe-mode` in bypass runs). **Note (2026-10-13, owner decision 26, Q-37, [ADR-0021](../adr/0021-repository-config-in-approved-bypass-runs.md); T3.19):** in an approved bypass run (`bypass: true` and `bypassApproved`) `approved` and `enabled` instead compile, omitting `--safe-mode`; `--strict-mcp-config` is kept for `approved` and omitted for `enabled`; no `--restricted`, Git deny rules unchanged. Without bypass approval the Ineligible reasons above stand. Unverified that the omitted flags load exactly the repository items: Unknown: live check in T3.9 (R-41) |
| Native sandbox | Compiles (as implemented today) without one: [H] has none (R-10 finding); none is needed, as no code-running tool is compiled | Compiles (as implemented today) without one: only operator-listed exact commands run (FR-POL-06 targets arbitrary shell) | Ineligible: `PROFILE_UNSUPPORTED` until T3.9 shows confinement or T3.1 supplies an outer sandbox (R-10, Q-16); a sandbox through `--settings`: Unknown: live check in T3.9 | Could compile without one: FR-POL-06 covers untrusted profiles only; [H] has none | Compiles (as implemented today) without one: [S] has no sandbox dimension; [H] has none, and advises bypass "only for sandboxes with no internet access", which a bypass run here does not have (owner decision 18 accepts loose bypass runs; R-26) |
| Approval behaviour | Compiles (as implemented today): `--permission-mode dontAsk --permission-prompts none`; "none" means "nobody: anything that would prompt is denied automatically" [H]; `dontAsk` denies rather than approves [R2 L24, L86–88]; a denial ends `PERMISSION_BLOCKED` (FR-POL-05) | Compiles (as implemented today): as `inspect-untrusted` | Could compile: as `inspect-untrusted` | Could compile: as `inspect-untrusted` | Compiles (as implemented today): as `inspect-untrusted` when the scope has no `bypass`; in an approved bypass run `--permission-mode` is omitted and `--permission-prompts none` kept (Assumption: [H] does not say how an explicit mode combines with `--dangerously-skip-permissions`) |
| Bypass flag availability | Compiles (as implemented today): never emitted (FR-POL-03, [AC]). [H] lists `--dangerously-skip-permissions` ("Bypass all permission checks"), `--allow-dangerously-skip-permissions` and the mode `bypassPermissions`; `--restricted` "refuses bypassPermissions" [H] | Compiles (as implemented today): never emitted [AC] | Could compile: never emitted (FR-POL-03) | Compiles (as implemented today): never emitted; a `bypassApproved` on this profile is Ineligible: `PROFILE_UNSUPPORTED` (FR-POL-03) [AC] | Compiles (as implemented today, T3.17): `--dangerously-skip-permissions` ("Bypass all permission checks. Recommended only for sandboxes with no internet access." [H]) only when the scope sets `bypass: true` and the run's `bypassApproved` is true ([ADR-0017](../adr/0017-approved-privileged-scope-bypass.md), T3.4); `--restricted` is omitted because it "refuses bypassPermissions" [H] (owner decision 19, Q-33); the argv audit admits the flag only for `privileged` with `bypassApproved` and scope `bypass` [AC]. **Assumption, unverified:** the Git deny rules and `--tools` still apply under the flag: Unknown: live check in T3.9 (R-26, live-smoke C-G2). This matters for `host` environments only: in a `container` environment (M10, planned) the image has no Git client and the Git directory is not mounted, so FR-GIT-01 does not rest on the deny rules (owner decision 24, R-38) |

### 4.2 Codex (M2)

| Aspect | Detail |
| --- | --- |
| Automation surface | `codex exec` |
| Structured output | `--json` emits JSONL (thread, turn, item, error and token-usage events) |
| Resume | `codex exec resume <SESSION_ID>` or `--last` (prefer explicit ID) |
| Auth preflight | Saved ChatGPT or API-key auth is reused; a dedicated status command is not stated in [R2]: to be verified in M2 against installed CLI. `~/.codex/auth.json` is sensitive and never read |
| Trust profile compilation (Proposed) | `--sandbox workspace-write` or stricter, plus `--ignore-user-config` and `--ignore-rules` for full harness control. Read-only sandbox value spelling: to be verified in M4 |
| Sandbox controls | Native: Seatbelt (macOS), bubblewrap (Linux/WSL2); explicit `--sandbox`. Per profile and platform: [§4.2.1](#421-codex-native-controls-per-profile-and-platform-t30) |
| Commands under untrusted profiles (owner decision 10) | Codex's agent runs shell commands inside its native sandbox under `inspect-untrusted` (`--sandbox read-only`) and `edit-untrusted` (`--sandbox workspace-write`); Switchboard has no documented Codex command allowlist to narrow them (Q-11), so "no shell" does not hold for Codex. Whether the sandbox keeps those commands away from `~/.codex` credentials and other same-user files is **unverified**: FR-POL-06 stays open for Codex (R-23) until the live malicious leg (T3.9); an outer sandbox (T3.1) is optional hardening. Network off is an Assumption ([R2] documents no Codex network switch) |
| Known risks | `--full-auto` deprecated, `--yolo` never used outside approved `privileged`; do not expose `OPENAI_API_KEY`/`CODEX_API_KEY` to repo-controlled code; token usage does not reveal remaining subscription capacity |
| Git writes and injected tools (M2, M9) | [R2] documents no per-command deny or allow rule and no commit or attribution setting; `--sandbox workspace-write` or stricter is the only documented control. The adapter declares this (`gitWriteControl` `none-documented`, T2.2), so FR-GIT-03 and FR-GIT-06 are the remaining controls, and a non-empty shell allowlist is `Ineligible`. Whether `workspace-write` blocks writes to a worktree's Git directory (outside the cwd) is an Assumption, unverified because Codex is not installed on the development host (live smoke check X-G1). Supplying a per-run MCP definition together with `--ignore-user-config`: not in [R2], to be verified in M9 |

#### 4.2.1 Codex native controls per profile and platform (T3.0)

Spike result, 2026-10-13 (Delegated agent work, not owner-approved). `codex` is not installed on the development host,
so **every cell is Unverified (documentation only)**: its sources are [R2 Lnn] (a line of the
[verified research](../research/headless-ai-coding-controller-verified-2026-10-12.md)), **[AX]**
(`src/adapters/codex/adapter.ts` and `protocol.ts`, the argv compiled today), [P] and [S] as in
[§4.1.1](#411-claude-code-native-controls-per-profile-and-platform-t30), which also defines the four cell values.
Linux host prerequisites of the sandbox (bubblewrap being installed, user namespaces, Landlock) are not in [R2].

| Platform | Status |
| --- | --- |
| Linux | The matrix below; [R2 L128–129]: "bubblewrap on Linux/WSL2" |
| macOS | Not supported yet: NFR-PORT-02 (M4) and ROADMAP A-2; [R2 L128] names Seatbelt there; no cell evaluated |
| Windows | Not supported yet: NFR-PORT-03 (Deferred, ROADMAP §8); [R2 L129] names "its Windows sandbox"; no cell evaluated |

| Dimension | `inspect-untrusted` | `edit-untrusted` | `test-sandboxed` | `trusted-development` | `privileged` |
| --- | --- | --- | --- | --- | --- |
| Today | Compiles (as implemented today): `codex exec --json --sandbox read-only --ignore-user-config --ignore-rules`, prompt on stdin (Assumption) [AX]. Unverified (documentation only) | Compiles (as implemented today): as `inspect-untrusted` with `--sandbox workspace-write` for a writable worktree; a non-empty shell allowlist, network other than `off` or a requested model is Ineligible: `CAPABILITY_MISSING` [AX]. Unverified (documentation only) | Ineligible: `PROFILE_UNSUPPORTED` (Q-32) [AX] | Compiles (as implemented today, T3.6) only with shell `broad`: `--sandbox workspace-write` (or `read-only`) `--ignore-user-config --ignore-rules`; other cells Ineligible: `CAPABILITY_MISSING` [AX]. Unverified (documentation only) | Compiles (as implemented today, T3.6, T3.17) a scope with `bypass: false`, shell `broad`, network `off` and repository configuration `disabled`, as `trusted-development`; `bypass: true`: Ineligible: `PROFILE_UNSUPPORTED` ("bypass/privileged flag not documented in R2: verify live") whatever the approval [AX]. Unverified (documentation only) |
| File access | Compiles (as implemented today): `--sandbox read-only`; the spelling is an Assumption, [R2 L75, L126] say only "`workspace-write` or stricter" (R-22). Unverified (documentation only) | Compiles (as implemented today): `--sandbox workspace-write` [R2 L75, L126]; whether it blocks writes to the worktree's Git directory outside the cwd is an Assumption (X-G1). Unverified (documentation only) | Could compile: `--sandbox workspace-write` [R2 L75]. Unverified (documentation only) | Could compile: as `test-sandboxed`. Unverified (documentation only) | Compiles (as implemented today): `files.access` `read-only` as `--sandbox read-only`, `worktree` as `--sandbox workspace-write` for a writable worktree [S, AX]. Unverified (documentation only) |
| Shell | Compiles (as implemented today): [R2] documents no way to stop the agent running commands; they run inside `--sandbox read-only` (owner decision 10; §4.2 "Commands under untrusted profiles"). Unverified (documentation only) | Compiles (as implemented today) with an empty allowlist, commands inside the sandbox (decision 10); a non-empty allowlist is Ineligible: `CAPABILITY_MISSING` (no documented command allowlist, Q-11) [AX]. Unverified (documentation only) | Ineligible: `CAPABILITY_MISSING` for a build or test allowlist (Q-11); with the empty default [P] commands still run inside the sandbox, and decision 10 names only the two untrusted profiles (Q-32). Unverified (documentation only) | `broad`: Could compile, commands inside `--sandbox workspace-write` (the only documented mode [R2 L75]); a non-empty `allowlist`: Ineligible: `CAPABILITY_MISSING`. Unverified (documentation only) | `shell.mode` `broad`: Compiles (as implemented today) as `trusted-development`; `none` and `allowlist`: Ineligible: `CAPABILITY_MISSING` ([R2] documents no way to disable or narrow commands; decision 10 does not cover a scope) [S, AX]. Unverified (documentation only) |
| Network | Compiles (as implemented today) only `off`, on the Assumption that the sandbox keeps network off; [R2] documents no Codex network switch [AX]. Whether it is off: Unknown: live check in T3.9. Unverified (documentation only) | Compiles (as implemented today): as `inspect-untrusted`. Unverified (documentation only) | `allowlist` hosts: Ineligible: `CAPABILITY_MISSING` [AX]; `off` [P]: Could compile as `edit-untrusted`. Unverified (documentation only) | `policy` or `allowlist`: Ineligible: `CAPABILITY_MISSING`; `off` [P]: as `edit-untrusted`. Unverified (documentation only) | `network.mode` `off`: Compiles (as implemented today) as `edit-untrusted` (Assumption); `allowlist` and `on`: Ineligible: `CAPABILITY_MISSING` (no documented switch, so `on` cannot be guaranteed either) [S, AX]. Unverified (documentation only) |
| Repository config (`AGENTS.md`, MCP definitions, hooks, provider config) | Compiles (as implemented today): `--ignore-user-config --ignore-rules` ([R2 L127–128]: for a controller "that does not want host configuration silently changing the execution contract"; [R2 L610–611]). That `--ignore-rules` suppresses repository `AGENTS.md` is an Assumption [AX]; repository MCP definitions and hooks are not in [R2]: Unknown: live check in T3.9. Unverified (documentation only) | Compiles (as implemented today): as `inspect-untrusted`. Unverified (documentation only) | `disabled` [P]: Could compile as `inspect-untrusted`; `approved-only`: Ineligible: `CAPABILITY_MISSING` ([R2] documents only the two all-or-nothing flags; a per-run MCP definition with `--ignore-user-config` is not in [R2], §4.2). Unverified (documentation only) | `disabled` [P]: as `inspect-untrusted`; `allowlisted`: Ineligible: `CAPABILITY_MISSING`, as `test-sandboxed`. Unverified (documentation only) | `repository_config.mode` `disabled`: Compiles (as implemented today) as `inspect-untrusted`; `approved`: Ineligible: `CAPABILITY_MISSING`; `enabled`: Ineligible: `CAPABILITY_MISSING` (Proposed: it needs omitting both flags, and whether `--sandbox` still wins over a loaded configuration is not in [R2]) [S, AX]. Unverified (documentation only) |
| Native sandbox | Compiles (as implemented today): `--sandbox read-only`, bubblewrap on Linux [R2 L128–129]. Host prerequisites: Unknown: live check in T3.9 (R-37); whether it keeps commands away from `~/.codex` credentials: Unknown: live check in T3.9 (R-23, FR-POL-06). Unverified (documentation only) | Compiles (as implemented today): `--sandbox workspace-write`; prerequisites and confinement as `inspect-untrusted`. Unverified (documentation only) | Could compile: `--sandbox workspace-write`; prerequisites and confinement: Unknown: live check in T3.9. Unverified (documentation only) | Could compile: as `test-sandboxed`. Unverified (documentation only) | Compiles (as implemented today): follows `files.access` [S, AX]; prerequisites and confinement as `trusted-development`: Unknown: live check in T3.9. Unverified (documentation only) |
| Approval behaviour | Unknown: live check in T3.9. [R2] documents no Codex approval flag, nor what `codex exec` does with an action that would need approval; the adapter reads an item `status` of `declined` as a denial (Assumption, `STATUS_DECLINED` in [AX]) | Unknown: live check in T3.9, as `inspect-untrusted` | Unknown: live check in T3.9 | Unknown: live check in T3.9 | Unknown: live check in T3.9 |
| Bypass flag availability | Compiles (as implemented today): never emitted (FR-POL-03) [AX]. [R2] names `--yolo` ([R2 L28, L125]: the posture "should not be built around `--yolo`") and `--full-auto` ("a deprecated compatibility option", [R2 L126]). Unverified (documentation only) | Compiles (as implemented today): never emitted [AX]. Unverified (documentation only) | Could compile: never emitted (FR-POL-03). Unverified (documentation only) | Could compile: never emitted (FR-POL-03). Unverified (documentation only) | Ineligible: `PROFILE_UNSUPPORTED` (as implemented today, T3.17) for any scope with `bypass: true`, approved or not: [R2] names `--yolo` only as a posture the controller "should not be built around" [R2 L28, L125] and `--full-auto` as "a deprecated compatibility option" [R2 L126], and documents neither what they disable nor a dangerous sandbox mode, which is not precise enough to emit (AGENTS.md); verify live (T3.9, R-26) before a Codex bypass compiles [AX]. Unverified (documentation only) |

### 4.3 Grok Build (M4)

| Aspect | Detail |
| --- | --- |
| Automation surface | `grok -p` / `--single`; native ACP via `grok agent stdio` |
| Structured output | `plain`, `json`, `streaming-json` |
| Resume | `--resume` / `--continue`; `-s/--session-id` names a session and is **not** resume |
| Auth preflight | Cached local token used for headless/ACP; status command not stated: to be verified in M4 against installed CLI |
| Trust profile compilation (Proposed) | Two independent dimensions compiled together: `--allow`/`--deny` rules and a sandbox profile (strict/read-only/workspace named in [R2]; selection flag to be verified in M4). Always-approve only under approved `privileged` |
| Sandbox controls | Landlock (Linux), Seatbelt (macOS); off unless enabled |
| Known risks | Permissions and sandbox are separate; project hooks and trust semantics mean repository config is untrusted input; worktree/fork behaviour is a capability, not assumed per run |
| Git writes and injected tools (M4, M9) | `--deny` rules for Git write commands (syntax: to be verified in M4); sandbox profile as a separate control. No commit or attribution setting in [R2]. Per-run MCP definition: not in [R2], to be verified |

### 4.4 Antigravity (`agy`, M4)

| Aspect | Detail |
| --- | --- |
| Automation surface | `agy -p` (aliases `--print`, `--prompt`); response on stdout, diagnostics on stderr |
| Structured output | `text`, `json`, `stream-json`; result includes conversation identifier and usage counters |
| Resume | Conversation identifier is returned; resume flag: to be verified in M4 against installed CLI |
| Auth preflight | Uses cached credentials; with none, exits with an auth error instead of prompting, which can serve as the harmless-call failure in FR-AUTH-02. `GEMINI_API_KEY` alone is insufficient and the API-key mode stays disabled |
| Trust profile compilation (Proposed) | `toolPermission` modes `request-review`, `proceed-in-sandbox`, `always-proceed`, `strict` plus terminal sandbox controls; prefer `strict` or `proceed-in-sandbox`. How the setting is passed per run without editing global config: to be verified in M4 (FR-POL-08) |
| Sandbox controls | Terminal sandbox controls (names to be verified in M4) |
| Known risks | `--dangerously-skip-permissions` only under approved `privileged`; mapping `toolPermission` to profiles may force ineligibility |
| Git writes and injected tools (M4, M9) | `strict` or `proceed-in-sandbox` `toolPermission`; whether Git writes can be denied separately: to be verified in M4. Per-run MCP definition without editing global config: not in [R2], to be verified (FR-POL-08); else finalize-only |

### 4.5 Cursor CLI (M4)

| Aspect | Detail |
| --- | --- |
| Automation surface | `agent -p`; ACP via `agent acp` |
| Structured output | `text`, `json`, `stream-json`; optional partial deltas |
| Resume | `--resume`, `--continue` |
| Auth preflight | Not stated in [R2]: to be verified in M4 against installed CLI |
| Trust profile compilation (Proposed) | `--sandbox enabled`; `--trust`, `--approve-mcps`, `--force`/`--yolo` decided independently: `--trust` only after controller trust evaluation, never automatic `--approve-mcps` or `--force` |
| Sandbox controls | `--sandbox enabled` or `--sandbox disabled`; sandbox subcommands support extra writable/read-only paths, blocked patterns, network switch (syntax to be verified in M4); `--worktree` with base-ref control exists but the controller owns worktrees |
| Known risks | Can front several model vendors: record harness and backing provider/model (FR-ADP-10); `--list-models` feeds the model registry (FR-ADP-05) |
| Git writes and injected tools (M4, M9) | `--sandbox enabled`; Git-write denial syntax: to be verified in M4. Cursor's `--worktree` creates worktrees and refs of its own and is not used (the controller owns worktrees). If supplying the injected MCP server needs `--approve-mcps` [R2], that is a bypass-class switch (FR-POL-03), so Cursor would use finalize-only mode (FR-GIT-09) |

### 4.6 OpenCode (M4)

| Aspect | Detail |
| --- | --- |
| Automation surface | `opencode run "..."`; `serve`/`attach` persistent service (transport deferred, FR-EXE-04); ACP present |
| Structured output | Output format flags: to be verified in M4 against installed CLI |
| Resume | `--continue`, `--session`, `--fork`; session/export commands exist |
| Auth preflight | to be verified in M4 against installed CLI |
| Trust profile compilation (Proposed) | Build explicit permissions first; `--auto` approves permissions not explicitly denied, so it is allowed only after explicit deny rules are in place, and then only if profile semantics permit (rule syntax: to be verified in M4) |
| Sandbox controls | None stated in [R2]: profiles needing confinement are ineligible until verified |
| Known risks | Multiple backing providers: record harness and backing provider/model (FR-ADP-10) so two paths to one quota pool are not counted as independent capacity |
| Inner-agent `cli` kind (M11, Proposed) | One-shot `opencode run` as a tool-free completion backend: **flags unverified**, no controls named in [R2]; `Ineligible` until the T11.0 spike records them for an installed version ([§3.12](#312-inner-agent), FR-INN-04, Q-26) |
| Git writes and injected tools (M4, M9) | Explicit deny rules for Git write commands before anything else; `--auto` approves whatever is not denied, so the injected tools must be explicitly allowed and Git writes explicitly denied (syntax: to be verified in M4). `--fork` and session export are not used. No sandbox [R2], so only shell-less profiles qualify for push |

### 4.7 Kimi Code (M4, blocked by B-1)

Disabled until the current Kimi Code CLI automation contract is pinned and passes conformance tests (FR-ADP-09, Git
write denial and tool injection included, FR-GIT-01, [ROADMAP
§7](../ROADMAP.md#7-risks-blockers-and-open-questions)). The archived legacy CLI's syntax, models and permissions are
not evidence for the replacement. Every row of this table: to be verified when the contract is pinned.

### 4.8 Muse Code (M4)

*Proposed, Should (FR-ADP-12, owner decision 16).* Every row is **unverified**: the sources are a user report and an SDK
crate, not Meta's documentation ([research note](../research/muse-code-2026-10-13.md), R-33, Q-27). Verify each row
against an installed binary and Meta's documentation before writing adapter code.

| Aspect | Detail |
| --- | --- |
| Automation surface | `muse exec [OPTIONS] [PROMPT]` (headless, one turn); `muse` alone is the interactive TUI and is never used |
| Structured output | `muse exec --json`: JSONL envelope records (command intake, run and task lifecycle, output deltas) ending in a `run_terminal` record. Unknown record kinds must be tolerated and logged, not fatal; the credential-free `--provider echo` mode is the source of recorded fixtures |
| Resume | Sessions exist; flag spelling to be verified |
| Auth preflight | To be verified. The adapter never reads `~/.config/muse/auth.json` and never passes `META_API_KEY`; a missing login yields `AUTH_REQUIRED` naming `muse login` |
| Trust profile compilation | Leave approvals and sandbox on (`--approval-mode`, `--sandbox-network`: values to be verified against the five profiles); `-w off` always; no `--yolo`, `--disable-approval`, `--disable-sandbox` or `--trust-workspace` outside an approved `privileged` scope (add them to the argv audit list) |
| Repository config | Reads `AGENTS.md`/`CLAUDE.md` and skills from the repository and from `~/.agents`, `~/.claude`, `~/.codex`; skipped when the workspace is untrusted (reported). Whether that is enough for FR-POL-04 under the untrusted profiles is to be verified |
| Version gate | Self-updates hourly (reported); set `MUSE_NO_AUTO_UPDATE=1` if confirmed and revalidate on version change (ADR-0009) |
| Success | Exit code `0` is not success; the terminal record and the controller's verification decide |
| Git writes and injected tools (M4, M9) | No per-command deny control reported: declare `none-documented` until found (FR-GIT-01, as Codex); whether a per-run MCP definition can be supplied without a bypass flag: to be verified |
| Capacity | Whether usage, limits or resets are reported: to be verified (FR-CAP-01) |

## 5. Implementation strategy by milestone

Scope and exit criteria are owned by the [ROADMAP](../ROADMAP.md#6-milestones); this section gives the technical
approach only.

| Milestone | Technical approach |
| --- | --- |
| M1 Foundation | Scaffold TS + Biome + Vitest + Actions. Order of build: config loader and schema validation; migration runner and DDL ([LLD §1](LLD.md#1-data-model)); ID/clock utilities behind interfaces for deterministic tests; artifact store (write temp, fsync, rename, record hash); workspace manager against real Git ([LLD §5](LLD.md#5-workspace-and-lease-algorithm)); execution supervisor ([LLD §8](LLD.md#8-run-supervisor-details)); `ProviderAdapter` contract and fake adapter; run lifecycle with optimistic transitions; reconciliation at startup; CLI `doctor` and `runs`. Fault-injection harness is built alongside, not after. |
| M2 Claude Code, Codex + MCP | Recorded-fixture conformance for Claude Code, then Codex (native JSONL; validates that the adapter contract fits two different providers); compliance manifest loader; eligibility filter (profile support, auth, version, manifest); MCP tool handlers over the SDK with Ajv-validated inputs; idempotency; `wait_seconds` implemented as a bounded wait on the run's completion promise, never holding a DB transaction. Startup budget measured for NFR-PERF-01. |
| M3 Isolation | Remaining profiles and per-adapter capability matrix; malicious fixture suite; approval flow (`approval` table, `approve` CLI); verification commands run via argv (no shell) in the worktree; retention/GC job; evaluate outer sandbox (§3.4) and decide by ADR. |
| M4 Adapters | macOS CI leg (NFR-PORT-02); one adapter module + manifest + fixtures + registry entry each (NFR-MAINT-01); ACP stdio client in the supervisor; model registry combining operator config and listing commands where available. |
| M5 Continuity | Native resume per adapter via `resumeArgs`; handoff bundle builder from ledger rows and Git evidence only (FR-SES-04), regenerable from events and decisions (FR-SES-05). |
| M6 Capacity | Usage observation writers; estimator (rolling windows over `usage_observation` and `run`); per-provider breakers persisted in `provider_health`; retry scheduler using [LLD §9](LLD.md#9-retryback-off-algorithm); queue with `WAITING_CAPACITY` timers; `get_capacity`. Cache read and creation token counts and per-project kept/switched counts (FR-CAP-08) where adapters report them. |
| M7 Routing | Feature extraction and heuristic classifier; static weighted scoring; persist `route_decision` rows; `explain_route` reads them. Scores deterministic for a given stored input (FR-RTE-03). Provider and model affinity: `project_affinity` table, the selection step before scoring, the `affinity_switch_reason` field, `affinity reset`, the cache-friendly prompt assembly order, and the replay property test ([§3.13.3](#3133-testing-affinity-and-retrieval), [LLD §3.2](LLD.md#32-provider-and-model-affinity-m7)). |
| M8 Hardening | OTel exporter driven from `run_event`/spans; version canaries (`adapters validate` ships in M4); |
| M9 Projects and controlled commits | Project and context schema in the config loader; `COMP-PRJ` resolution and ceilings; `project_id` columns and the `git_commit` table; per-adapter Git-write denial and channel-support declarations; the shim subcommand and per-run socket; `COMP-GIT` (commit, sanitiser, publish ref, ref snapshots, push with policy); `projects` CLI; fake-adapter fixtures for every attempt in §3.6. Starts with a spike that settles §3.10's open mechanisms (per-run Git config, plumbing commands, socket access under sandboxes). |
| M10 Container environments | After M9 (Q-6 settled by delegation, Proposed): runtime port, mounts, limits, labels and orphan sweep, container leg of the malicious-fixture suite, answer to the provider-login question ([§3.11](#311-container-environments)). |
| M11 Inner agent | Spike T11.0 first (OpenCode one-shot tool-free controls, or record `Ineligible`). Then in order: config schema, backend port, scripted fake backend, `inner_call` and `inner_task_state` tables and the import-boundary test (T11.1); the pipeline with redaction, budget, breaker, re-ask and fallback (T11.2); `http` backend, locality and privacy gates (T11.3); the commit-message task through the existing sanitiser (T11.4); accounting (T11.5); suspension (T11.6); `doctor`, `inner status`, `inner test` (T11.7); then PR draft, log summary, handoff condensation, route features and run title as their milestones allow (T11.8 to T11.12), and the `cli` kind last (T11.13). Every task ships with its fallback and hostile-fixture tests in the same change ([§3.12](#312-inner-agent), [LLD §13](LLD.md#13-inner-agent)). |
| M12 Retrieval index | After M9 and the M11 backend port (T11.1). Spike T12.0 first (storage and embedding backend, Q-48; measure the brute-force cap and scan time on real project sizes). Then in order: config and store schema (T12.1); scanner, exclusions, redaction and chunker (T12.2); embedding port with the fake, `local` and `http` backends and the gates (T12.3); incremental background build, `index` CLI and `doctor` (T12.4); retrieval and the context pack at admission (T12.5); `search_project_context` (T12.6); the global index and sharing rules (T12.7); documentation (T12.8); the agent-callable tool last (T12.9, Could). The import-boundary and isolation tests land with T12.1, not after ([§3.13](#313-retrieval-index), [LLD §14](LLD.md#14-retrieval-index)). Affinity is separate and earlier: the `project_affinity` table, selection step and replay tests ship with M7, cache observations with M6 ([LLD §3.2](LLD.md#32-provider-and-model-affinity-m7)). |

## 6. Migration considerations

- There is no existing system to migrate from; this section covers evolution of Switchboard itself.
- **Database.** Numbered, forward-only migrations recorded in `schema_migrations`
  ([ADR-0005](../adr/0005-sqlite-ledger.md)); the runner refuses to open a database whose newest migration is unknown to
  the binary (downgrade protection). Each migration runs in a transaction after a file-level backup copy (Proposed). No
  down-migrations.
- **Adapter version changes.** A new provider CLI version triggers `ADAPTER_VERSION_UNVERIFIED` until conformance passes
  and the manifest range is extended ([ADR-0009](../adr/0009-version-gated-adapters.md), WF-9). Fixtures are versioned
  alongside the range they validate.
- **Config versioning.** `schema_version` in the config; an unknown newer version aborts startup; older versions are
  upgraded by an explicit `config migrate` command (Proposed) rather than silently.
- **MCP schema evolution.** Add optional fields only within a major version; tool schema version surfaced in
  `list_capabilities`.
- **Static to learned routing.** Static weights ([ADR-0008](../adr/0008-two-stage-routing.md)) are the baseline;
  `route_decision` already stores features, weights, candidates and outcome (FR-RTE-03), so a later learned router
  (deferred, FR-RTE-05) can be evaluated offline against history and rolled out behind a config switch without schema
  change beyond new columns.
- **Storage engine.** Revisit SQLite only per ADR-0005's trigger; the single-writer boundary keeps a swap contained in
  `COMP-LED`.

## 7. Key tradeoffs

| Decision | Gain | Cost | Reference |
| --- | --- | --- | --- |
| TypeScript/Node over Go/Rust | Shared schemas, MCP SDK, fast iteration | Node dependency, signal/process-group care | ADR-0010 |
| `better-sqlite3` (sync) over `node:sqlite` | Mature, simple transactions | Native addon packaging | ADR-0005 |
| Ajv over zod | Published JSON Schemas are the source of truth | Derived types; possible SDK shim | FR-MCP-09 |
| Controller-owned state over transcript scraping | Provider-independent continuity, no private-format dependency | Handoff quality limited to recorded evidence | ADR-0001 |
| Worktree per run | Safe rollback, no replay on dirty state | Disk use, GC needed | ADR-0006 |
| Fail closed on unknown version | No silent weakening of security | Provider auto-update can take adapter offline | ADR-0009 |
| Native provider sandboxes first, outer sandbox optional | Uses vendor-maintained controls | Uneven protection across providers; some profiles ineligible | [R2], FR-POL-06 |
| Async-first tools with bounded wait | Survives client timeouts | Orchestrators must poll | ADR-0002 |
| No automatic permission-bypass flags | Fail-closed headless runs | Some tasks fail with `PERMISSION_BLOCKED` | ADR-0004 |
| Tool-only commits over letting agents commit and rewriting afterwards | No provider attribution can reach published history; works without per-provider attribution switches | A per-run tool channel to verify per provider; some adapters fall back to controller-made commits | ADR-0014 |
| Provenance in the ledger, not in Git | Commits stay indistinguishable from ordinary ones | Links by SHA break on an operator rebase (tree hash and patch ID are best-effort) | ADR-0014 |
| Orchestrator-created projects need a client opt-in and operator approval for containers and push | A compromised orchestrator cannot mount host paths, start containers or enable push on its own | A project is approved on the CLI before it can use those | ADR-0013 |
| Cheap-model drafts (commit, PR, summaries, features) over agent-written text | Saves premium provider turns; the coding agent does not spend output on mechanical text | A weaker model can write a vague or wrong draft; a new egress path (TB-10); fallbacks and a suspension rule add code. Bounded by agent-text-wins defaults, no policy authority, sanitiser, redaction and `local`-first privacy gates | ADR-0016 |
| Provider and model affinity over score-driven choice | A project stays on one provider and model, so provider-side prompt caches can keep hitting (benefit per provider unverified); every move has an auditable reason | The affine provider's quota is spent first and load concentrates (R-58); a better-scoring provider is not used until a listed reason applies | ADR-0032 |
| Per-project SQLite retrieval store with brute-force search over a vector service | No new dependency or process; deletable derived cache; isolation by file | Capped store size; linear scan cost; vectors and text unencrypted in the data directory (R-56); revisit after T12.0 | ADR-0031 |
| Stdio MCP, single process | No network listener | One orchestrator per controller process (Assumption) | ADR-0011 |
