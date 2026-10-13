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
| Git access | `git` CLI via `execFile` (no shell), minimum version **2.30** (Proposed, fixed in T1.5; `src/workspace/git.ts` `MIN_GIT_VERSION`; developed against 2.43) | Worktree and diff semantics are Git's own ([ADR-0006](../adr/0006-worktree-checkpoints-no-blind-replay.md)); pure-JS Git libraries lack worktree support (Assumption) | Requires `git` on host; output parsing must use porcelain/`-z` formats | Min version M1 |
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
| `mcp_clients[].projects` | Project IDs the client may use | FR-PRJ-03, 06 |
| `git.sanitize_patterns[]` | Operator additions to the built-in attribution patterns ([LLD §12.4](LLD.md#124-message-sanitisation)) | FR-GIT-04 |
| `limits.global_concurrency`, `limits.per_provider_concurrency` | Defaults 4 and 1 (proposed target) | NFR-PERF-03 |
| `timeouts.*` | Wall-clock, idle, grace, preflight TTL (proposed targets in [LLD §8](LLD.md#8-run-supervisor-details)) | FR-EXE-01, NFR-PERF-02 |
| `retention.days` | Default 30 (proposed target) | NFR-DATA-01 |
| `profiles.<name>` | Overrides that may only tighten defaults | FR-POL-01 |
| `providers.<id>` | `{enabled, binary_path, extra_env_allowlist[], model_overrides}` | FR-ADP-05, FR-EXE-07 |
| `routing.weights`, `routing.minimum_capability_defaults` | Static weights | FR-RTE-02 |
| `capacity.queue_horizon` | Max wait for a known reset | FR-CAP-06 |
| `telemetry.otlp_endpoint` | Optional export target | FR-TEL-02, NFR-PRIV-01 |
| `log.level` | Logging threshold | §3.3 |
| `inner_agent.enabled`, `inner_agent.backend{kind, base_url or provider, model, timeout_ms, max_concurrency, allow_remote, shares_subscription_with}` | Optional inner agent: one backend, no default backend or model, no credential field (Proposed shape; [LLD §13.1](LLD.md#131-configuration-shape)) | FR-INN-01, 03, 04, 15, 16 |
| `inner_agent.tasks.<task>{enabled, mode?, allow_source_content?, input_budget_bytes, max_output_tokens, timeout_ms?}` | Each task off until enabled; `mode` on `commit_message` only | FR-INN-05, 10, 16 |
| `inner_agent.breaker`, `inner_agent.suspension` | Circuit-breaker and automatic-suspension thresholds (proposed targets) | FR-INN-08, 09 |
| `projects[].inner_agent`, `projects[].contexts[].inner_agent` | `off`, `local_only` or `inherit`; can only restrict | FR-INN-16 |

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
- **Agent Git boundary.** Agents get no Git write ability and no push credentials; see
  [§3.10](#310-git-commits-attribution-and-publication) for the layers, the injected-tool channel and what is still
  unverified per provider (FR-GIT-01..09).
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
| `serve` process tests (M2) | Spawn `switchboard serve` as a child with a temp config and data dir, drive it with an MCP stdio client: delegate → SUCCEEDED, stdout carries only MCP framing, a second `serve` on the same data dir fails, `SIGKILL` mid-run then restart ends the run `FAILED/PROCESS_CRASH` with no orphan (`src/cli/serve.test.ts`). The fake adapter is reachable only through the test-only switch below | No | FR-OPS-01, FR-EXE-06, NFR-REL-01 |
| Git boundary (M9) | Fake adapter with scripted tool calls and scripted attempts to `git commit`, move refs or push, against real Git repos and a local bare remote; fixtures of typical attribution trailers, footers and session IDs through the sanitiser; assertion that no published commit contains them and that checkpoint commits never reach the remote | No | FR-GIT-01..09 |
| Project and environment (M9, M10) | Configuration validation (unknown context kind, path outside allowed roots), ceiling arithmetic, `host` runs through a project; container tests need a container runtime and are opt-in (skipped in CI until Q-6 is settled) | No for `host`; runtime for `container` | FR-PRJ-01..09 |
| Live provider smoke | Opt-in only: `scripts/live-smoke.mjs` (`npm run test:live`) is skipped unless `SWITCHBOARD_LIVE_TESTS=1`; not part of `npm test`, never runs in CI (see below) | Yes | [AGENTS.md](../../AGENTS.md) |
| Controller-overhead benchmark | `scripts/bench-perf.mjs` (`npm run bench`) times the real MCP server over the in-memory transport with the fake adapter; not part of `npm test` (see [§3.6.1](#361-controller-overhead-benchmark-t27)) | No | NFR-PERF-01, NFR-PERF-02 |
| Inner agent (M11) | Scripted fake backend as a local HTTP server, hostile-output fixtures, planted-secret prompt capture, import-boundary test; details in [§3.12](#312-inner-agent) | No | FR-INN-01..17 |
| Docs check | `scripts/check-docs.mjs` must pass on every change (links, anchors, ID references) | No | NFR-MAINT-02 |

Principles: tests pass with no provider CLI installed or logged in; secret-pattern scan over all test outputs
(NFR-SEC-01); coverage targets are not set until M1 measurement (no number proposed).

**Test-only fake adapter in `serve` (Proposed, T2.6).** `serve` registers the fake adapter only when the environment
variable `SWITCHBOARD_TEST_FAKE_ADAPTER` equals the exact sentinel `enable-test-only-fake-adapter` (scenario from
`SWITCHBOARD_TEST_FAKE_SCENARIO`, default `success`). Any other non-empty value refuses to start, the config schema has
no key or provider id that can enable it, and `serve` logs a warning on stderr when it is on. Production registers
`claude` and `codex` only.

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
  subtracted. This is the NFR-PERF-01 quantity, measured with preflight uncached.
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
measures. This is a gap to be assigned (reported to the roadmap owner), not a finished requirement.

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
exact deny-rule syntax for Git write commands, and records the answer in its manifest notes.

**Layers.** Prevention first, then detection; none depends on a provider-specific attribution switch.

| # | Layer | What it does | Strength | Verified? |
| --- | --- | --- | --- | --- |
| 1 | Profile deny rules | Each adapter compiles Git write operations (commit, branch and tag changes, push) into the provider's *documented* permission controls: Claude Code explicit `--tools`/allow-deny rules, Grok Build `--allow`/`--deny`, OpenCode explicit deny rules, Antigravity `strict` mode. Under `inspect-untrusted` and `edit-untrusted` there is no arbitrary shell anyway. | Provider-enforced; only as strong as the provider's rule matching | Rule syntax: to be verified per adapter (M2, M4) |
| 2 | No credentials in the agent's environment | The environment allowlist (FR-EXE-07) never carries `SSH_AUTH_SOCK`, token variables or credential-helper settings. In a `container` environment (M10) no credential store is mounted. | Strong in containers; in a `host` environment on-disk credentials stay readable by a same-user shell ([R2] limit) | Allowlist: tested in M1; container: M10 |
| 3 | Git-level guard | Per-run Git configuration for agent processes that points hooks at a controller-owned directory whose hooks reject ref updates not carrying the controller's token. Candidate mechanisms: a per-run global config file, or `GIT_CONFIG_COUNT` environment entries (newer Git than the current 2.30 minimum, so adopting it raises `MIN_GIT_VERSION`; check Git's release notes). | A guard against provider-internal or accidental commits, **not** a boundary: an agent with a shell can override Git configuration | Mechanism: to be chosen in an M9 spike |
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
readable by the agent, so the `push` tool is withheld (BR-31). Candidate stronger answers, not adopted: a dedicated OS
user for a publisher helper (adds a privilege boundary and an installation step), or container environments (M10).

**Audit trail.** The ledger table `git_commit` ([LLD §1](LLD.md#1-data-model)) is written in the same transaction as the
`git_commit` run event. It stores SHA, tree hash and patch ID so records can be re-linked after an operator rebase
(best effort). `git notes` and trailers were rejected because they travel with the repository.

### 3.11 Container environments

Implements FR-PRJ-04, 05, 07, 09 for M10. Status: **Proposed**. zemdregon left Q-6 to the agent ("the rest you pick"), so the
choices below are Delegated, not owner-approved, and unverified until the M10 spike.

- **Runtime.** A rootless OCI-compatible runtime that the controller drives through its CLI (Proposed; rootless Podman
  is the likely candidate, unverified). The controller must run unprivileged (NFR-SEC-04), so a root-owned daemon is out;
  the port is small (create, start, stop, remove, list by label) so the choice stays replaceable.
- **Image.** Operator-supplied and pinned by digest (Proposed); the controller never builds images or pulls implicitly.
  The image contains the provider CLI the project uses.
- **Mounts.** The run worktree (writable) and declared read-only contexts only. Not the home directory, data directory,
  runtime socket, or any Git credential store. The worktree's Git directory (under the main repository) is **not**
  mounted, which also keeps refs out of reach (layer 4 above); how Git works inside the container for read-only
  operations such as `git diff` is to be settled in the M10 spike (candidate: a read-only bind of the needed objects).
- **Provider logins (Proposed).** The provider CLI inside the container needs its native login. FR-AUTH-01 forbids the
  controller copying or moving credentials between identities or machines, so mounting the host's credential directory is
  out unless zemdregon decides otherwise. Chosen (Proposed): the operator runs the provider's native login command inside the
  project's container volume once (for example through a `projects login <id> <provider>` operator command that only
  attaches the operator's terminal to that command; the controller never reads the result). Whether that is acceptable
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
| Sandbox controls | None documented in [R2]; `--safe-mode`/`--restricted` are not a sandbox and Bash/read/edit remain. Credential confinement unproven, so `inspect-untrusted` and `edit-untrusted` compile with no arbitrary shell (only `edit-untrusted`'s narrow allowlist), and `test-sandboxed` is ineligible for Claude until confinement is shown (FR-POL-06; M3 evaluation) |
| Known risks | Version-gated features; `total_cost_usd` is a client-side estimate (record as reported, never as remaining quota, FR-CAP-01/03); `PreToolUse` hooks are supplemental only; `CLAUDE_CONFIG_DIR` isolates config *and* credentials, so use only if it keeps the operator's login reachable (to be verified in M2); structured error categories (`rate_limit`, `overloaded`, authentication, billing, server) feed `classifyFailure` |
| Git writes and injected tools (M2, M9) | Git write denial through the explicit `--tools`/allow-deny rules [R2] names; rule syntax: to be verified in M2. No commit or attribution setting is documented in [R2]: to be verified in M2 against the installed CLI and Anthropic's documentation. `--bare` skips MCP discovery [R2], so the injected tools need an explicitly supplied per-run MCP definition (mechanism not in [R2]: to be verified in M9), and fail-closed `dontAsk` may require them pre-allowed |

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
| Git writes and injected tools (M2, M9) | `--sandbox workspace-write` or stricter is the documented control; whether it prevents `git commit` or writes to the Git directory is not stated in [R2]: to be verified in M2. No commit or attribution setting in [R2]. Supplying a per-run MCP definition together with `--ignore-user-config`: not in [R2], to be verified in M9 |

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
| M6 Capacity | Usage observation writers; estimator (rolling windows over `usage_observation` and `run`); per-provider breakers persisted in `provider_health`; retry scheduler using [LLD §9](LLD.md#9-retryback-off-algorithm); queue with `WAITING_CAPACITY` timers; `get_capacity`. |
| M7 Routing | Feature extraction and heuristic classifier; static weighted scoring; persist `route_decision` rows; `explain_route` reads them. Scores deterministic for a given stored input (FR-RTE-03). |
| M8 Hardening | OTel exporter driven from `run_event`/spans; version canaries (`adapters validate` ships in M4); |
| M9 Projects and controlled commits | Project and context schema in the config loader; `COMP-PRJ` resolution and ceilings; `project_id` columns and the `git_commit` table; per-adapter Git-write denial and channel-support declarations; the shim subcommand and per-run socket; `COMP-GIT` (commit, sanitiser, publish ref, ref snapshots, push with policy); `projects` CLI; fake-adapter fixtures for every attempt in §3.6. Starts with a spike that settles §3.10's open mechanisms (per-run Git config, plumbing commands, socket access under sandboxes). |
| M10 Container environments | After M9 (Q-6 settled by delegation, Proposed): runtime port, mounts, limits, labels and orphan sweep, container leg of the malicious-fixture suite, answer to the provider-login question ([§3.11](#311-container-environments)). |
| M11 Inner agent | Spike T11.0 first (OpenCode one-shot tool-free controls, or record `Ineligible`). Then in order: config schema, backend port, scripted fake backend, `inner_call` and `inner_task_state` tables and the import-boundary test (T11.1); the pipeline with redaction, budget, breaker, re-ask and fallback (T11.2); `http` backend, locality and privacy gates (T11.3); the commit-message task through the existing sanitiser (T11.4); accounting (T11.5); suspension (T11.6); `doctor`, `inner status`, `inner test` (T11.7); then PR draft, log summary, handoff condensation, route features and run title as their milestones allow (T11.8 to T11.12), and the `cli` kind last (T11.13). Every task ships with its fallback and hostile-fixture tests in the same change ([§3.12](#312-inner-agent), [LLD §13](LLD.md#13-inner-agent)). |

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
| Stdio MCP, single process | No network listener | One orchestrator per controller process (Assumption) | ADR-0011 |
