# Technical Design Document (TDD)

| Field | Value |
| --- | --- |
| Status | Draft, baseline for milestone M1 |
| Owns | Technology choices and their tradeoffs; cross-cutting engineering concerns (configuration, error handling, logging, security engineering, concurrency, testing, packaging, CI, versioning); per-provider adapter strategy; technical approach by milestone; migration considerations |
| Does not own | Requirements ([SRS](../requirements/SRS.md)); scope, sequencing and status ([ROADMAP](../ROADMAP.md#6-milestones)); components and boundaries ([HLD](HLD.md)); component collaboration ([SDD](SDD.md)); schemas, interfaces, algorithms ([LLD](LLD.md)); run state machine ([FRD](../requirements/FRD.md)) |
| Last reconciled | 2026-10-12 |

## 1. Purpose and scope

This document says *with what* and *how* Switchboard is to be built, at the level a maintainer needs before writing M1.
It does not restate requirements; it cites SRS IDs. Nothing described here exists yet: as of 2026-10-12 the repository
holds documentation and research only, with no code, tests, CI or configuration. Every statement below is a design
intention.

Decision status: ADR-0010 (stack) and the other [ADRs](../adr/README.md) are *Delegated* decisions, binding for
implementation until revised but not individually approved by Ender. Items labelled **Proposed** or **Assumption** here
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
| Upstream protocol | Official MCP TypeScript SDK, stdio transport ([ADR-0002](../adr/0002-mcp-upstream-acp-downstream.md), FR-MCP-01) | Tracks the spec; avoids hand-rolled JSON-RPC | SDK churn can break tool registration; isolate behind `COMP-MCP` | Pinned later (with T2.4) |
| Downstream ACP | Own thin ACP client over stdio JSON-RPC (M4); check for an official ACP client library first | FR-EXE-03 is Should; the surface needed is small | Maintaining protocol code vs adding a dependency; decide in M4 | M4 |
| Database | SQLite via `better-sqlite3`, WAL mode ([ADR-0005](../adr/0005-sqlite-ledger.md)) | Synchronous API makes "check-then-write in one transaction" simple and keeps the single writer obvious (NFR-REL-01) | Native addon: needs prebuilt binary or a compiler toolchain per platform; blocks the event loop during a statement (acceptable at expected volume) | better-sqlite3 13.0.3 (exact-pinned runtime dependency, T1.3); `@types/better-sqlite3` 9.6.0 (dev); bundles SQLite 3.53.4 |
| Database alternative | `node:sqlite` (built-in) | No native build step | Stability and feature level to be re-evaluated against the pinned Node LTS at M1 start; not adopted unless it supports needed features (WAL, STRICT, transactions, user functions not required) and is stable | Re-evaluated at T1.3 (2026-10-12, Delegated): **not adopted**. On Node 22.22.0 `node:sqlite` still emits an `ExperimentalWarning` ("might change at any time"), so it fails the stability condition; `better-sqlite3` 13.0.3 installed and ran here. Revisit at the single-executable hardening item or when `node:sqlite` is stable on the pinned LTS |
| Schema validation | **Ajv** (JSON Schema) | FR-MCP-09 requires *published JSON Schemas*; Ajv validates the same documents we publish, config and manifest schemas included, so one schema is source of truth | Config types are hand-written beside the schema and kept consistent by tests (T1.2); the MCP SDK's own tool-registration helpers may expect another schema library, so an adapter shim may be needed (to be checked in M1) | Ajv 8.20.0 (exact-pinned runtime dependency, T1.2) |
| Unit and integration tests | Vitest | TypeScript-native, fast, fake timers and mocking | Less ubiquitous than Jest; process-level tests still need a plain harness | Vitest 5.0.4 |
| Lint and format | Biome (single tool) | One config, fast | Smaller rule set than ESLint plus typescript-eslint; type-aware lint rules may be missing, compensated by `tsc --noEmit` in CI | Biome 2.5.15 |
| Package manager | npm with committed lockfile, `npm ci` in CI | Ships with Node; no extra tool for a single-maintainer project | No workspace-level conveniences of pnpm; adequate for a single package | npm 10.9.4 (bundled with local Node); `package-lock.json` committed |
| Git access | `git` CLI via `execFile` (no shell), minimum version to be fixed in M1 | Worktree and diff semantics are Git's own ([ADR-0006](../adr/0006-worktree-checkpoints-no-blind-replay.md)); pure-JS Git libraries lack worktree support (Assumption) | Requires `git` on host; output parsing must use porcelain/`-z` formats | Min version M1 |
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
| `limits.global_concurrency`, `limits.per_provider_concurrency` | Defaults 4 and 1 (proposed target) | NFR-PERF-03 |
| `timeouts.*` | Wall-clock, idle, grace, preflight TTL (proposed targets in [LLD §8](LLD.md#8-run-supervisor-details)) | FR-EXE-01, NFR-PERF-02 |
| `retention.days` | Default 30 (proposed target) | NFR-DATA-01 |
| `profiles.<name>` | Overrides that may only tighten defaults | FR-POL-01 |
| `providers.<id>` | `{enabled, binary_path, extra_env_allowlist[], model_overrides}` | FR-ADP-05, FR-EXE-07 |
| `routing.weights`, `routing.minimum_capability_defaults` | Static weights | FR-RTE-02 |
| `capacity.queue_horizon` | Max wait for a known reset | FR-CAP-06 |
| `telemetry.otlp_endpoint` | Optional export target | FR-TEL-02, NFR-PRIV-01 |
| `log.level` | Logging threshold | §3.3 |

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
  run is `privileged` with a recorded approval (FR-POL-03); adapters never write global provider config such as
  `~/.claude/settings.json` (FR-POL-08, [ADR-0004](../adr/0004-trust-profiles-no-bypass-flags.md)).
- **Repository hooks.** Controller Git operations run with repository hooks disabled and a clean Git environment
  (Proposed: `-c core.hooksPath=/dev/null`, `--no-verify`, no inherited `GIT_*` variables), because a malicious
  repository could otherwise execute code in the controller's own commits.
- **Credential boundary.** Nothing reads credential files or keyrings (ADR-0003, FR-AUTH-01). Code review gate plus a
  lint rule (Proposed) forbidding references to known credential paths outside test fixtures.
- **Same-account limitation [R2].** A dedicated OS user limits host blast radius but does not isolate provider
  credentials from commands the agent runs as the same user. Hence FR-POL-06: where an adapter cannot confine agent-run
  commands away from credentials, untrusted profiles run without shell.
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
| Workspace and Git | Real Git repos in temp dirs: worktree create, lease, checkpoint, mutation detection, rollback, GC | No | FR-WS-01..07 |
| Fault injection | Kill controller with `SIGKILL` at each transition boundary (named crash points), restart, assert ledger consistency and terminal/resumed state | No | NFR-REL-01, FR-EXE-06 |
| Malicious fixture repos (M3, M4) | Repos with prompt-injection files, repo hooks, repo MCP definitions, credential-path reads, out-of-worktree writes, network attempts, run per enabled adapter | Needed for adapter-level proof; sandbox-level parts can run without | NFR-SEC-03 |
| MCP contract | Schema validation, error envelope, idempotency, `wait_seconds` bounds via an in-process MCP client | No | FR-MCP-* |
| Live provider smoke | Opt-in only; skipped unless an environment variable is set (name Proposed: `SWITCHBOARD_LIVE_TESTS=1`); never runs in CI by default | Yes | [AGENTS.md](../../AGENTS.md) |
| Docs check | `scripts/check-docs.mjs` must pass on every change (links, anchors, ID references) | No | NFR-MAINT-02 |

Principles: tests pass with no provider CLI installed or logged in; secret-pattern scan over all test outputs
(NFR-SEC-01); coverage targets are not set until M1 measurement (no number proposed).

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
| Trust profile compilation (Proposed) | Untrusted profiles: `--bare` (skips hooks, skills, commands, subagents, plugins, MCP, auto-memory, `CLAUDE.md`; FR-POL-04), fail-closed `dontAsk` (or `--permission-prompts none`), explicit `--tools`/allow-deny rules; never `--allowedTools "*"` (skipped by Claude). Exact tool names and rule syntax: to be verified in M2 against installed CLI |
| Sandbox controls | None documented in [R2]; `--bare` is not a sandbox and Bash/read/edit remain. Credential confinement unproven, so `inspect-untrusted` and `edit-untrusted` compile with no arbitrary shell (only `edit-untrusted`'s narrow allowlist), and `test-sandboxed` is ineligible for Claude until confinement is shown (FR-POL-06; M3 evaluation) |
| Known risks | Version-gated features; `total_cost_usd` is a client-side estimate (record as reported, never as remaining quota, FR-CAP-01/03); `PreToolUse` hooks are supplemental only; `CLAUDE_CONFIG_DIR` isolates config *and* credentials, so use only if it keeps the operator's login reachable (to be verified in M2); structured error categories (`rate_limit`, `overloaded`, authentication, billing, server) feed `classifyFailure` |

### 4.2 Codex (M2)

| Aspect | Detail |
| --- | --- |
| Automation surface | `codex exec` |
| Structured output | `--json` emits JSONL (thread, turn, item, error and token-usage events) |
| Resume | `codex exec resume <SESSION_ID>` or `--last` (prefer explicit ID) |
| Auth preflight | Saved ChatGPT or API-key auth is reused; a dedicated status command is not stated in [R2]: to be verified in M2 against installed CLI. `~/.codex/auth.json` is sensitive and never read |
| Trust profile compilation (Proposed) | `--sandbox workspace-write` or stricter, plus `--ignore-user-config` and `--ignore-rules` for full harness control. Read-only sandbox value spelling: to be verified in M4 |
| Sandbox controls | Native: Seatbelt (macOS), bubblewrap (Linux/WSL2); explicit `--sandbox` |
| Known risks | `--full-auto` deprecated, `--yolo` never used outside approved `privileged`; do not expose `OPENAI_API_KEY`/`CODEX_API_KEY` to repo-controlled code; token usage does not reveal remaining subscription capacity |

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

### 4.7 Kimi Code (M4, blocked by B-1)

Disabled until the current Kimi Code CLI automation contract is pinned and passes conformance tests (FR-ADP-09, [ROADMAP
§7](../ROADMAP.md#7-risks-blockers-and-open-questions)). The archived legacy CLI's syntax, models and permissions are
not evidence for the replacement. Every row of this table: to be verified when the contract is pinned.

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
| M6 Capacity | Usage observation writers; estimator (rolling windows over `usage_observation` and `run`); per-provider breakers persisted in `provider_health`; retry scheduler using [LLD §9](LLD.md#9-retryback-off-algorithm); queue with `WAITING_CAPACITY` timers; `get_capacity`. |
| M7 Routing | Feature extraction and heuristic classifier; static weighted scoring; persist `route_decision` rows; `explain_route` reads them. Scores deterministic for a given stored input (FR-RTE-03). |
| M8 Hardening | OTel exporter driven from `run_event`/spans; version canaries (`adapters validate` ships in M4); |

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
| Stdio MCP, single process | No network listener | One orchestrator per controller process (Assumption) | ADR-0011 |
