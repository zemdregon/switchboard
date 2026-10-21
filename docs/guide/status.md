# Status

Milestone-by-milestone status of what is built and what is verified. Part of the [Switchboard guide](README.md).

## Status

Pre-release. The package is private and is not published to any registry; you build it from source.

- **Milestone 1 (foundation) is done**: run ledger, workspaces, run lifecycle, reconciliation and the operator CLI
  (`doctor`, `runs`). See [ROADMAP §6](../ROADMAP.md#6-milestones) for the evidence.
- **Milestone 2 (Claude Code and Codex adapters plus the MCP slice) is `Partial`.** The Claude Code and Codex
  adapters, the MCP server and `switchboard serve` exist and pass their tests on recorded or synthetic fixtures and a
  fake provider. On Ampere 2026-10-14 the operator ran the opt-in `npm run test:live` smoke through real
  `switchboard serve` ([`docs/research/live-checks-2026-10-14-claude-codex.md`](../research/live-checks-2026-10-14-claude-codex.md)):
  Claude Code 2.1.294 **14 HELD, 0 FAILED, 2 NOT_CHECKED** (C-12, C-G2); Codex 0.162.0 after `adapters validate codex`
  **10 HELD, 0 FAILED, 3 NOT_CHECKED** (X-4, X-9, X-G1). Earlier checks on another host are in
  [`docs/research/live-checks-2026-10-13.md`](../research/live-checks-2026-10-13.md). `Done` waits on the
  remaining residual operator cells (C-G2 and X-G1 deliberate attempts ran 2026-10-19 through the T3.9 leg, both
  `HELD`; see below); `doctor` with both providers installed and logged in passed on 2026-10-17
  ([`docs/research/live-checks-2026-10-17-claude-codex.md`](../research/live-checks-2026-10-17-claude-codex.md)). The
  §6.2 "Blocks Done" narrative matches the 2026-10-14 live smoke on main
  ([PR #570](https://github.com/zemdregon/switchboard/pull/570)). See
  [ROADMAP §6.2](../ROADMAP.md#62-m2-claude-code-adapter-and-mcp-slice-tasks).
- **Milestone 3 (isolation) is `Partial`.** Trust profiles and overrides, approvals (`approve`, `deny`), privileged
  runs, verification commands (optionally confined in bubblewrap), outer-sandbox detection and retention (`gc`) are
  implemented and tested on fakes, as are the controller confinement checks of T3.8b (owner decision 63; credential
  reads, network egress and a push to an explicit URL are not enforced on the fake by design). The operator's live
  malicious-fixture leg (T3.9) is `Done` (2026-10-19, Delegated agent work, not owner-approved): the Claude Code leg
  ran (C-G2 `HELD` at the outcome level; C-M2 `NOT_CHECKED`; C-M3 `ESCAPED`, opening ROADMAP R-74) and the Codex half
  ran in the decision 71 container login (X-G1 `HELD`; X-M2 `HELD` at the outcome level; X-M3 `NOT_CHECKED`). See
  [ROADMAP §6.5](../ROADMAP.md#65-m3-isolation-tasks) for each task.
- **Milestone 9 (projects and controlled commits) is `Partial`.** Projects, the agent `commit` tool, finalize-only
  commits, ref snapshots, push, dynamic projects, signing and concurrent-run worktrees are implemented and tested for
  `host` environments on a fake provider with real Git in temporary repositories. It is not `Done`: nothing has run
  against a live provider through Switchboard's own tool channel, signing was tried only with a throwaway GnuPG key,
  pushing from dynamic projects is refused by design (`CONTEXT_UNKNOWN`, owner decision 62; Q-46 answered), and
  the `container` clauses stay **Partial** until milestone 10 is `Done`
  (mounting and MCP admission are on fakes; T10.0 operator login checks are Done; opt-in Docker and a live container run
  remain open — see milestone 10 below). The
  exceptions are listed in
  [ROADMAP §6.3](../ROADMAP.md#63-m9-projects-and-controlled-commits-tasks) (task T9.8).
- **Milestone 5 (continuity) is `Partial`.** `continue_task` resumes the provider's native session or hands off to
  another provider from a bundle built from Switchboard's own records, and `get_artifacts` and `runs show` show the
  handoff. It is tested on two fake providers, including a check that the controller opens no provider state directory.
  The live resume checks and one live Claude Code to Codex pair ran on 2026-10-19 (ROADMAP T5.12, with Codex in the
  operator's container login). It is not `Done`: that pair failed one check (the Codex handoff run succeeded, but its
  file write did not land, most likely because Codex's sandbox cannot start in that container), and resume for the
  providers of milestone 4 is not built. See [ROADMAP §6.9](../ROADMAP.md#69-m5-continuity-tasks).
- **Milestone 6 (capacity and resilience) is `Done` on fake providers** (2026-10-18, Delegated agent work, not
  owner-approved; acceptance in `src/mcp/m6-acceptance.test.ts`). `get_capacity` and `switchboard capacity` show per-provider
  estimates with their sources, a circuit breaker holds a failing provider back, retryable failures are retried
  automatically as linked successor runs, and quota exhaustion fails over to another provider or returns. All of this
  is tested on fake providers. Limits: real limit output is captured in text mode for six
  providers with the remaining cells `NOT_CHECKED` (operator task T6.11, `Done` 2026-10-17 with a 2026-10-18 follow-up;
  [limit captures](../research/limit-captures-2026-10-17.md) and the
  [follow-up](../research/limit-captures-2026-10-18.md)), and no provider is known to publish an
  enforceable rate limit, so there is no token-bucket gate; the pacing gate paces usage per subscription window
  from observed usage instead (ROADMAP T6.8, `Done` 2026-10-17). The subscription/pacing configuration keys and the
  per-window figure computation exist (ROADMAP T6.13, `Done` 2026-10-17), and capacity output shows one `pacing` entry
  per subscription with each window's figures and source, `deferred_until` and the gate verdict (ROADMAP T6.14, `Done`
  2026-10-17); a deferred candidate is left out when an undeferred eligible one remains, otherwise the run waits in
  `QUEUED` with a `pacing_hold` event until the gate-open time. The pacing acceptance test on fakes passes
  (ROADMAP T6.16, `Done` 2026-10-17, `src/mcp/m6-pacing-acceptance.test.ts`). Pacing estimates are lower bounds from
  Switchboard's own dispatches, and pacing never creates a run (see [Model groups and pacing](mcp-server.md#model-groups-and-pacing)).
  See [ROADMAP §6.11](../ROADMAP.md#611-m6-capacity-and-resilience-tasks).
- **Milestone 7 (routing) is `Done` on fake providers** (2026-10-18, Delegated agent work, not owner-approved;
  acceptance in `src/mcp/m7-acceptance.test.ts`). Eligible providers are scored from Switchboard's own records, every route
  decision is stored and replays exactly, `explain_route` shows why a run went where it did, a project stays on its
  provider until a listed reason moves it (`switchboard affinity list|reset`), and `minimum_capability` is enforced
  against operator-declared model capabilities in the model registry (`src/routing/minimum-capability.test.ts`). All
  of this is tested on fake providers. The cache-friendly prompt order is built (ROADMAP T7.9, Could; no cache
  benefit is claimed). Operator-configured model groups (`routing.model_group`) and explicit models (`routing.model`)
  route over their members with the `pacing` score term, tested on fakes (ROADMAP T7.13 to T7.16, `Done` 2026-10-17,
  `src/mcp/m7-group-acceptance.test.ts`; README T7.17, `Done` 2026-10-17); a group is configuration, never a quality
  claim. Real-provider model flags wait for adapter work. See [Routing and affinity](mcp-server.md#routing-and-affinity),
  [Model groups and pacing](mcp-server.md#model-groups-and-pacing) and [ROADMAP §6.12](../ROADMAP.md#612-m7-routing-tasks).
- **Milestone 8 (hardening) is `Partial`.** Optional OTLP trace export (`telemetry.otlp_endpoint`, off by default),
  lazy exporter load (T8.1), wrapper-boundary span emission for `controller.delegate` and `provider.spawn` (T8.2), the
  collector integration test with parent links and the forbidden-attribute scan (T8.3,
  [#552](https://github.com/zemdregon/switchboard/pull/552); milestone and README reconcile
  [#558](https://github.com/zemdregon/switchboard/pull/558)), export-time allowlist enforcement (T8.4,
  [#549](https://github.com/zemdregon/switchboard/pull/549)), the operator version canary (T8.5) and a CI test that
  excludes routing after a synthetic binary version bump until `adapters validate` records the version (T8.6) are done
  on fakes. Own-repository evaluation (T8.14) is also `Done` on fakes, and the per-run provider OTLP receiver
  (T8.15, `telemetry.provider_otlp`, off by default) is also done on fakes. M8 acceptance closure (T8.7) is
  `Done`; M8 stays `Partial` until the operator records a dry run of the scheduled version canary on a real CLI
  upgrade. See
  [Telemetry and adapter versioning](advanced-features.md#telemetry-and-adapter-versioning-milestone-8) and
  [ROADMAP §6.15](../ROADMAP.md#615-m8-hardening-tasks).
- **Milestone 10 (container environments) is `Partial`.** The environment port, MCP admission and `serve` composition
  for `container` projects ([PR #554](https://github.com/zemdregon/switchboard/pull/554)), orphan sweep,
  malicious-fixture container leg, `projects validate` container checks and retention GC are implemented and tested on
  fakes (and emulated runtime in CI). It is not `Done`: the opt-in Docker mount legs (`SWITCHBOARD_CONTAINER_TESTS=1`)
  and a live end-to-end run through a
  real provider CLI remain open.
  See [Container environments (milestone 10)](advanced-features.md#container-environments-milestone-10) and
  [ROADMAP §6.4](../ROADMAP.md#64-m10-container-environments-tasks).
- **Milestone 11 (inner agent) is `Partial`.** T11.1 to T11.13 are done on fakes: an optional HTTP backend, privacy
  gates, quality monitoring with automatic suspension (T11.6), `doctor` and `inner` reporting, commit-message drafting,
  handoff condensation (T11.10, a service function), record-only routing classification (T11.11), and the `cli` backend
  gate (T11.13, shipped `Ineligible`). The T11.6 roadmap
  row carries its `Done on fakes` status since [#586](https://github.com/zemdregon/switchboard/pull/586), which also
  added `src/inner/suspension.test.ts`: on a scripted fake backend, every call after a suspension falls back without
  reaching a now-good backend, and the first call after the task is re-enabled is accepted from it. The T11.9
  verification-output summary row carries its `Done on fakes` status since
  [#594](https://github.com/zemdregon/switchboard/pull/594), which added the suite
  `log_summary task: roadmap 'Done when' (T11.9)` to `src/inner/log-summary.test.ts`: over six paths on the scripted
  fake backend (accepted lying prose, a rejected success claim, empty, error, not-JSON and a privacy denial) the
  envelope's status, failure code, per-check exit codes and outcome counts equal the run row and terminal transition
  read from the ledger, `raw_artifact` resolves to the stored `test_report`, and the fallback equals a head-8/tail-12
  excerpt written out by hand. That summary is still a service function that no run path calls (see below). T11.1 (the
  `inner_agent` config schema, the backend port, the scripted
  fake backend, the `inner_call` table, the disabled-by-default path and the import-boundary test) is `Done`; its
  roadmap row was reconciled to the 2026-10-16 status contract in
  [#569](https://github.com/zemdregon/switchboard/pull/569), citing `src/config/config.test.ts`,
  `src/inner/inner.test.ts`, `src/inner/import-boundary.test.ts`, `src/inner/port.ts`, `src/inner/fake-backend.ts` and
  `src/ledger/migrations/0005_inner_call.ts` (milestone row and README reconcile
  [#574](https://github.com/zemdregon/switchboard/pull/574)). T11.13 (the `cli` backend) is `Done` (2026-10-18,
  owner decision 66; the gate is met on fakes — the backend runs only inside the manifest range with verified
  tool-free flags and otherwise reports `Ineligible`, with an argv audit — and no OpenCode release through v2.0.32
  offers a tool-free control, so the shipped kind stays `Ineligible`:
  [TDD §4.6.7](../design/TDD.md#467-t110-live-result-2026-10-17)) and no live backend
  has been exercised. Two tasks are wired into production `serve` run paths: the commit-message
  task (the optional `message` on the `commit` tool) and routing classification (`serve` admission, continuation and
  quota failover, with heuristic fallback when inner is off or unavailable). Handoff condensation, PR drafting,
  verification-summary, run-title and a live backend are not: their designs name no run-path call site, so they stay
  service functions, and `src/inner/run-path-reach.test.ts` pins both lists. T11.14 (README and roadmap status for
  M11) is `Done` on that basis (T11.0 to T11.13 Done on fakes; the shipped `cli` backend stays `Ineligible`).
  T11.5 usage-surface pins merged
  [#362](https://github.com/zemdregon/switchboard/pull/362) (suspended-task and project-off denials, re-ask deadline
  counts, shared-subscription label routing, whole `inner_shared_subscription` doctor checks, `enabled: false` with the
  flag set, capacity collector `source` exclusion), [#396](https://github.com/zemdregon/switchboard/pull/396)
  (usage accounting at the quota-failover routing call site, the one `serve`-path classification recorded under a
  run) and [#407](https://github.com/zemdregon/switchboard/pull/407) (`get_run` byte-identical over Streamable HTTP
  and from a second session; a `shares_subscription_with` value that is no provider config id refused at `doctor`
  and `inner test`). See [ROADMAP §6.6](../ROADMAP.md#66-m11-inner-agent-tasks).
- **Milestone 12 (retrieval index) is `Partial`.** Tasks T12.0 to T12.7 are done on fakes (T12.7 is `Done`
  on 2026-10-19 as Delegated agent work, not owner-approved; it was `Partial` the same day after an owner ruling that
  `global` and `both` scope answered only `GLOBAL_NOT_AVAILABLE`): the spike, `rag`
  configuration and per-project store, the scanner through chunker, the embedding port (fake and `http` backends
  behind the locality gates), incremental background indexing in `serve`, `switchboard index status|rebuild|clear`
  and a `doctor` section, an untrusted context pack at admission that never changes the stored request or the
  run's outcome, the read-only MCP tool `search_project_context`, and optional global sharing (`rag.global`,
  `contribute_to_global`, `use_global`, all off by default). Agent-callable search (T12.9) and an opt-in live
  embedding backend are not `Done`. See [Retrieval index](advanced-features.md#retrieval-index-milestone-12),
  [ROADMAP §6.7](../ROADMAP.md#67-m12-retrieval-index-tasks) and the merged requirements and design evidence in
  [SRS §3.15](../requirements/SRS.md#implementation-evidence-partial-m12),
  [PRD CAP-13](../requirements/PRD.md#implementation-evidence-partial-m12--cap-13),
  [HLD §2.1](../design/HLD.md#21-comp-rag-implementation-evidence-m12-t121t123),
  [LLD §14](../design/LLD.md#14-retrieval-index) and [TDD §3.13](../design/TDD.md#313-retrieval-index).
- **Milestone 13 (network MCP transport) is `Done`** (2026-10-19, Delegated agent work, not owner-approved:
  T13.10 (ADR-0062) and T13.11 (ADR-0065) are Done; the M13 scope below stays Done). `serve` can expose the MCP
  tools over Streamable HTTP with OAuth
  2.1 (an embedded authorization server with an operator consent page, PKCE, client registration that the operator
  approves — by Dynamic Client Registration or, since T13.11, a Client ID Metadata Document fetched under SSRF
  limits — audience-bound opaque tokens). It is off by default and binds to loopback; put your own TLS proxy in
  front of it. A test runs the whole path from client registration and PKCE to a tool call. Residual risks are listed
  under [HLD TB-12](../design/HLD.md#3-trust-boundaries). See
  [ROADMAP §6.10](../ROADMAP.md#610-m13-network-mcp-transport-tasks).
- **Milestone 14 (control plane) is `Partial`.** T14.0–T14.11 are implemented on fakes, including pause
  ([#539](https://github.com/zemdregon/switchboard/pull/539)); digest, `list_runs`, `get_run`, budgets, the loop
  breaker, `steer_run`, pause/resume, the approval proxy and notification sinks are covered by unit and
  malicious-fixture tests. The M14 acceptance file (`src/mcp/m14-acceptance.test.ts`) runs scenarios A to G, including
  D (pause holds admission while running work finishes,
  [#559](https://github.com/zemdregon/switchboard/pull/559)). ADR-0047 and ADR-0048 remain Proposed. See
  [Control plane (milestone 14)](advanced-features.md#control-plane-milestone-14) and
  [ROADMAP §6.13](../ROADMAP.md#613-m14-control-plane-tasks).
- **Milestone 15 (project queue, schedules and CI triggers) is `Done` on fakes** (2026-10-20, Delegated agent work,
  not owner-approved; reopened 2026-10-19 for owner decisions 76 and 77, whose tasks are all Done on fakes: T15.6,
  T15.7 (published-ref conflicts and supersede, migration 0029, `src/ci/ref-conflicts.test.ts`), T15.8 (opt-in
  head-pinned merge policy and ref events, migration 0031, `src/ci/merge-policy.test.ts`) and T15.9; the M15 scope
  below stays Done on fakes
  (2026-10-18, Delegated
  agent work,
  not owner-approved; the `serve` low-water wiring below is a separate open fix)). The durable per-project work queue
  (T15.1, [#527](https://github.com/zemdregon/switchboard/pull/527)) and the CI-failure trigger (T15.3,
  [#563](https://github.com/zemdregon/switchboard/pull/563)) are done on fakes. The queue tools (`enqueue_work`,
  `list_work`, `cancel_work`) are offered over stdio and, since T15.9, over the network transport to `orchestrator`
  clients under the same per-client ceiling and project list (a `console` client sees none). The trigger is off by default
  (`ci_trigger` in the configuration); `serve` reads CI status through the operator's logged-in `gh` CLI, polls only
  branches the project pushed, treats the CI text as untrusted and enqueues a work item under the trigger's client
  ceiling. Switchboard reads no GitHub token. Consecutive fix-up items per published ref are capped (T15.5:
  `ci_trigger.max_consecutive_fixes`, Assumption default 2): further failures are recorded without a work item and the
  project is flagged needs-attention (`ci_fix_stuck`) until CI passes or the operator resets the counter.
  Transient CI faults are handled (T15.6: `cancelled`/`timed_out` are recorded as `CI_INFRA` with no fix-up and never
  count toward the cap; per-project `rerun_failed` and `cancel_stale_queued` switches, both off by default, enable one
  `gh run rerun --failed` per (ref, head, job) and cancel of queued runs on superseded heads).
  A ref reported `CONFLICTING` by read-only `gh pr view` admits one rebase item (T15.7, cap shared with the fix-up
  cap); at the cap one re-implementation item from the current base supersedes the old ref, and work items may carry
  a `dedupe_key` (a second live item with the same key is refused) and `hot_paths` (overlapping items never run together).
  A project may turn on a merge policy (T15.8: `projects[].merge_policy`, off by default; an orchestrator that turns it
  on waits for operator approval): a published ref's pull request is merged with `gh pr merge --match-head-commit` only
  when every required check is green at its head, it is mergeable and a passing verification is recorded at that SHA.
  Every merge and refusal is a `merge_event` row; CI results, foreign commits, conflicts, merges and closes of published
  refs are `ref_event` rows, shown to the publishing client in `get_digest` and sent to sinks as metadata only.
  Since ADR-0070 a client that may `publish_run` can also ask for that merge at once with MCP `merge_run_pr` (the same
  gate, not waiting for the poller, also when `ci_trigger` is off), and `merge_policy.require_verification: false`
  (default `true`; turning it off waits for approval like turning the policy on) skips the verification condition only.
  `merge_policy.checks: "all_reported"` (ADR-0080, default `required`) merges only when a check ran and all reported
  checks passed, for repositories without branch protection.
  A pull request head that is only GitHub's "Update branch" merge commit
  (a pure base merge the controller verifies with local Git) is accepted too, and `update_run_branch` asks GitHub for
  that update (ADR-0073).
  A project may set a queue low-water mark (T15.4: `projects.<id>.queue.low_water`, off by default): when the
  admissible count (`READY` items, or `PENDING` items whose dependencies can still be met) drops below the mark, one
  `queue_low` sink event fires, re-armed only when the count rises back to the mark. The detector is covered on fakes
  (unit tests in `src/queue/low-water.test.ts`; end to end through the sink dispatcher with a capturing sink in
  `src/mcp/work-queue.test.ts`); `serve` attaches one tracker per daemon process on the real ledger and the
  sink dispatcher when notification sinks exist, seeding the armed state from the level at startup (`src/cli/serve.ts`;
  end-to-end serve test `src/cli/serve-queue-low-water.test.ts`, [PR #678](https://github.com/zemdregon/switchboard/pull/678)).
  Not built: the MCP server attaches no tracker, so only a `serve` run emits `queue_low` in production.
  Schedules (T15.2, [#561](https://github.com/zemdregon/switchboard/pull/561))
  are done on fakes: off by default, UTC cron, fired by `serve` before the CI poll, and listed or disabled with
  `switchboard schedule`. See
  [ROADMAP §6.14](../ROADMAP.md#614-m15-project-queue-schedules-and-ci-triggers-tasks).
- **Milestone 16 (Switchboard-controlled skills) is `Done` on fakes** (Delegated agent work, not owner-approved). The
  skill store, configuration, operator CLI, admission, prompt-prefix delivery, the native-delivery framework with leak
  prevention, the adapter declarations, the MCP tools, continuity across handoff and resume and the malicious-fixture
  leg are built (T16.1 to T16.7, T16.9 to T16.11). The M16 acceptance file (`src/mcp/m16-acceptance.test.ts`, T16.12)
  runs one test per clause of the milestone's acceptance column through a scripted MCP client on the fake adapter.
  Not required for `Done`: the operator live checks are Done for the four T16.8 candidates (2026-10-19, decision 70:
  Claude Code `NOT_LOADED`, Grok Build, Cursor and Muse Code `NOT_CHECKED`, operator-only), so every real provider
  delivers skills as a prompt prefix, and no skill has been delivered to a live provider through Switchboard yet.
  See [Switchboard-controlled skills (milestone 16)](advanced-features.md#switchboard-controlled-skills-milestone-16),
  [ADR-0056](../adr/0056-switchboard-controlled-skills.md) and
  [ROADMAP §6.16](../ROADMAP.md#616-m16-switchboard-controlled-skills-tasks).
- **Milestone 4 (adapter expansion) is `Partial`.** Shared registry, conformance plumbing, `adapters validate`, the ACP
  client and a macOS CI leg (T4.10; ran 2026-10-14, removed 2026-10-19 when CI went Linux-only) are done; Grok Build,
  Antigravity, Cursor and OpenCode each have a module, compile matrix
  and parser work on synthetic fixtures. Grok Build has module, compile-matrix, parser (T4.23, `Done` against its
  Done-when on synthetic fixtures under owner decision 65; every Done-when case has a supervisor-replayed JSONL fixture
  on `main` ([#260](https://github.com/zemdregon/switchboard/pull/260)); native shapes are T4.28's work),
  auth-preflight, conformance suite (T4.25), malicious-fixture leg (T4.26, `Done` against its Done-when on fixtures
  under owner decision 65; synthetic command fields, readable native login and repository configuration gaps stay;
  [#291](https://github.com/zemdregon/switchboard/pull/291),
  [#302](https://github.com/zemdregon/switchboard/pull/302),
  [#308](https://github.com/zemdregon/switchboard/pull/308),
  [#326](https://github.com/zemdregon/switchboard/pull/326),
  [#345](https://github.com/zemdregon/switchboard/pull/345),
  [#351](https://github.com/zemdregon/switchboard/pull/351),
  [#358](https://github.com/zemdregon/switchboard/pull/358),
  [#378](https://github.com/zemdregon/switchboard/pull/378),
  [#393](https://github.com/zemdregon/switchboard/pull/393),
  [#422](https://github.com/zemdregon/switchboard/pull/422),
  [#449](https://github.com/zemdregon/switchboard/pull/449)) and Git declaration fixture tests on
  synthetic fixtures (README [Grok Build CLI](providers.md#grok-build-cli-milestone-4), ROADMAP T4.22 to T4.27); live
  smoke, live
  malicious leg and `adapters validate` remain operator work (T4.28: the 2026-10-18 `adapters validate grok` run
  passed probe, auth and conformance but stopped at the smoke step on a provider usage limit, so the manifest range
  still admits no version).
  [#302](https://github.com/zemdregon/switchboard/pull/302) through
  [#449](https://github.com/zemdregon/switchboard/pull/449) extend synthetic malicious replay and compile pins only (including
  completing both cut-line positions across categories and exits, parser fall-through paths at exit `2` and `137`,
  trailing `tool_call_update` after `end`, JSON-encoding variants, and replays of the T4.23 second to sixth parser
  residual passes); #449 also pinned a guard gap (a Git write past the 512-character target clip of a target-only shell
  call was not seen), since closed in the parser (2026-10-15, synthetic only). Parser residual pins
  ([#342](https://github.com/zemdregon/switchboard/pull/342),
  [#354](https://github.com/zemdregon/switchboard/pull/354),
  [#372](https://github.com/zemdregon/switchboard/pull/372)) leave the parser unchanged; none of them validate the
  live CLI or close T4.23's or T4.26's gaps. Antigravity has a
  parser (Done against its Done-when under owner decision 65 (a): T4.33; unrecorded-shape, fallback and own-property
  hardening pins plus structured
  `backing_provider`/`model` on `session_bound`, all synthetic,
  [#272](https://github.com/zemdregon/switchboard/pull/272),
  [#276](https://github.com/zemdregon/switchboard/pull/276),
  [#297](https://github.com/zemdregon/switchboard/pull/297)),
  a conformance suite (T4.35, `Done` on synthetic fixtures: native resume `--conversation <id>` fails closed when the
  returned `conversation_id` differs or is missing, owner decision 67; replay dialect edge cases
  [#281](https://github.com/zemdregon/switchboard/pull/281) and Go `flag`-boundary walking
  [#292](https://github.com/zemdregon/switchboard/pull/292)), a malicious-fixture leg (Done against its Done-when
  under owner decision 65 (b): synthetic refusal,
  guard-blocked and trailing-tool fail-closed replay streams, hostile repository entries and FR-POL-04, T4.36;
  [#257](https://github.com/zemdregon/switchboard/pull/257),
  [#262](https://github.com/zemdregon/switchboard/pull/262),
  [#280](https://github.com/zemdregon/switchboard/pull/280))
  and a Git declaration on synthetic fixtures (README [Antigravity CLI](providers.md#antigravity-cli-milestone-4),
  ROADMAP T4.32 to
  T4.37); [#295](https://github.com/zemdregon/switchboard/pull/295) through
  [#373](https://github.com/zemdregon/switchboard/pull/373) extend synthetic parser, conformance and malicious replay
  only and do not validate the live CLI; the T4.38 live `adapters validate` pass followed on 2026-10-18 (CLI 1.4.2,
  manifest range `>=1.4.2 <1.5.0`).
  The live smoke and the live malicious leg for Antigravity ran on 2026-10-19 (ROADMAP T4.38 Done;
  [`docs/research/live-checks-2026-10-19-antigravity.md`](../research/live-checks-2026-10-19-antigravity.md)):
  smoke 9 HELD, 2 ESCAPED (A-7, A-8; risks R-73, R-75), 1 NOT_CHECKED; malicious 1 HELD (A-M3),
  1 ESCAPED (A-M2; risk R-72), 1 NOT_CHECKED (A-M1). Cursor has
  module, compile-matrix, parser (Done against its Done-when under owner decision 65 (a): T4.43;
  supervisor-replayed JSONL fixtures,
  [#283](https://github.com/zemdregon/switchboard/pull/283),
  [#287](https://github.com/zemdregon/switchboard/pull/287),
  [#299](https://github.com/zemdregon/switchboard/pull/299),
  [#324](https://github.com/zemdregon/switchboard/pull/324), residual ordering and resume/compile-parity pins
  [#333](https://github.com/zemdregon/switchboard/pull/333), resume-id matrix and `denied_after_result.jsonl`
  [#341](https://github.com/zemdregon/switchboard/pull/341), parser residual branches
  [#348](https://github.com/zemdregon/switchboard/pull/348) and `idless_guard.jsonl`
  [#360](https://github.com/zemdregon/switchboard/pull/360)), auth-preflight, a conformance suite on synthetic
  fixtures (T4.45; replay dialect hardening, 59 compile/env refusal checks, and fixtures including
  `denied_after_write`, `permission_denied_perm`, `resume_unknown_id`, `unknown_event`, `unsafe_id_after_bound` and
  `git_write_guard_args`,
  [#309](https://github.com/zemdregon/switchboard/pull/309),
  [#315](https://github.com/zemdregon/switchboard/pull/315)), malicious-fixture leg (T4.46; category/exit matrix and
  12 partial streams, [#316](https://github.com/zemdregon/switchboard/pull/316); residual cells at exits 2 and 137 and
  guard-only Git writes, [#367](https://github.com/zemdregon/switchboard/pull/367)) and Git declaration
  fixture tests on synthetic fixtures (README [Cursor CLI](providers.md#cursor-cli-milestone-4), ROADMAP T4.42 to
  T4.47); live
  smoke passed and the live malicious leg closed on 2026-10-19 per owner decision 77 (smoke `outcome=ok`, 11 held; post-merge
  malicious rerun w1703 inside the wrapper: U-M1/U-M2 `HELD`, U-M3 `NOT_CHECKED` as expected bypass
  behaviour), so T4.48 is `Done`;
  the escape fix ([ADR-0059](../adr/0059-cursor-bypass-cell-bubblewrap-wrapper.md), owner ruling
2026-10-19 06:41 CDT) has landed on this branch, hermetically tested; the first live rerun inside the wrapper (w1700)
  ended with all three cells `NOT_CHECKED` (`FAILED TOOL_FAILURE` before any tool call — a harness fault in the
  operator channel's model pin, not a wrapper or model outcome). Under the owner ruling of 2026-10-19 08:12 CDT a check
  is `HELD` only when the stream's tool calls show every asked action attempted, and U-M2/U-M3 join U-M1 as `mustRun`;
  the post-merge rerun (w1703) reached the tools and closed the row per the steward ruling
  of 2026-10-19 09:50 CDT under owner decision 77;
the 2026-10-19 `adapters validate cursor` run passed
  the probe (Cursor CLI 2026.10.16), auth, 11 static conformance checks and the smoke (owner decision 59), so the
  manifest admits `>=2026.10.16 <2026.11.0`. OpenCode has module, compile-matrix,
  probe, registry entry, parser (Done against its Done-when under owner decision 65 (a): T4.53; native limit and
  tool-input shapes still open after T4.58 (ran 2026-10-19 without capturing them; see T4.56);
  supervisor-replayed JSONL fixtures,
  [#274](https://github.com/zemdregon/switchboard/pull/274),
  [#290](https://github.com/zemdregon/switchboard/pull/290),
  [#311](https://github.com/zemdregon/switchboard/pull/311),
  [#321](https://github.com/zemdregon/switchboard/pull/321), terminal reason and late error handling
  [#328](https://github.com/zemdregon/switchboard/pull/328), malformed step-start fail-closed, scope compile parity and
  arrival-order independence
  [#339](https://github.com/zemdregon/switchboard/pull/339), parser residual branches on synthetic lines
  [#357](https://github.com/zemdregon/switchboard/pull/357)),
  auth-preflight, conformance suite on synthetic fixtures (T4.55), malicious-fixture leg (Done against its Done-when
  under owner decision 65 (b): synthetic refusal shapes, guard-blocked, trailing-tool, unreadable-event, exit 2/137,
  JSON-encoding, and path-upgrade fail-closed replay streams in a widened hostile matrix and FR-POL-04, T4.56;
  [#245](https://github.com/zemdregon/switchboard/pull/245),
  [#284](https://github.com/zemdregon/switchboard/pull/284),
  [#298](https://github.com/zemdregon/switchboard/pull/298),
  [#312](https://github.com/zemdregon/switchboard/pull/312),
  [#323](https://github.com/zemdregon/switchboard/pull/323),
  [#355](https://github.com/zemdregon/switchboard/pull/355),
  [#369](https://github.com/zemdregon/switchboard/pull/369)) and Git declaration fixture tests on synthetic
  fixtures (README [OpenCode CLI](providers.md#opencode-cli-milestone-4), ROADMAP T4.52 to T4.57); live smoke and the live
  malicious leg ran on 2026-10-19 (T4.58 Done): the 2026-10-18 `adapters validate opencode` run passed the probe
  (`opencode v2.0.23`), auth, 11 static conformance checks and the smoke (owner decisions 60 and 68; one model call),
  so the manifest admits `>=2.0.23 <2.1.0`, and the 2026-10-19 smoke
  (11 HELD, O-G1 NOT_CHECKED, edit through recognised calls) and
  malicious leg (O-M1/O-M2/O-M3 HELD, no check ESCAPED) are recorded in
  [`docs/research/live-checks-2026-10-19-opencode.md`](../research/live-checks-2026-10-19-opencode.md).
  T4.52, T4.54, T4.55 and T4.57 are Done against their
  Done-when on synthetic fixtures; T4.53 and T4.56 are Done against their Done-when under owner decision 65 (a) and (b),
  with their native-shape gaps still open after T4.58 (see those rows). Kimi Code has module, compile matrix, probe and
  registry entry
  ([#429](https://github.com/zemdregon/switchboard/pull/429)), parser and resume (T4.63, three scrubbed captures
  plus synthetic fixtures, [#436](https://github.com/zemdregon/switchboard/pull/436)), auth preflight (T4.64,
  [#444](https://github.com/zemdregon/switchboard/pull/444)), a conformance suite (T4.65,
  [#455](https://github.com/zemdregon/switchboard/pull/455)), a malicious-fixture leg (T4.66,
  [#459](https://github.com/zemdregon/switchboard/pull/459)) and a Git declaration (T4.67,
  [#464](https://github.com/zemdregon/switchboard/pull/464)); T4.63, T4.64 and T4.66 are Done against their Done-when
  under owner decision 65 (a), (d) and (b), and T4.65 and T4.67 are Done against their Done-when (2026-10-15),
  on synthetic fixtures except the T4.64 probe's two live `validate` runs (auth `OK`) and the
  T4.68 live `adapters validate` pass on 2026-10-18 (CLI 2.1.1, manifest range `>=2.1.1 <2.2.0`) (README
  [Kimi Code CLI](providers.md#kimi-code-cli-milestone-4), ROADMAP T4.62 to T4.69); live smoke and the live malicious leg
  ran on 2026-10-19 (w1408; post-#748 w1601 rerun) and the row closed Partial-by-ruling with permission gating
  Deferred (T4.68). The Grok Build and Muse Code manifests still admit
  no version until `switchboard adapters validate` passes a real CLI (operator tasks); Claude Code, Codex, OpenCode,
  Kimi Code, Antigravity and Cursor already admit one. M4 stays `Partial` (T4.90 closure, 2026-10-17,
  Delegated). Open items, by blocker: operator live legs (T4.28; T4.38 Done 2026-10-19; T4.48 legs ran 2026-10-19,
  row Done 2026-10-19 closed by owner decision 77; T4.68 legs ran 2026-10-19, row closed
  Partial-by-ruling, gating Deferred; T4.12 is Deferred
  under decision 69 — it needed a Mac and was optional for criterion 2; the
  2026-10-17 live runs found that `adapters validate` compiles under `inspect-untrusted`, which Grok Build, Cursor
  and OpenCode cannot run by design; owner decisions 59 and 60 let Grok Build, Cursor, Kimi Code, OpenCode and
  Antigravity reach the smoke step in the adapter's only compiled cell instead (T4.4));
   rows waiting on uncaptured live shapes
  (T4.35, T4.51, T4.53, T4.56; owner decision 65 sets when parser, CI
  malicious-leg and README rows are `Done` against their Done-when; T4.33 and T4.36 are `Done`
  under decision 65 (a) and (b), remaining native shapes carried by the T4.38 operator remainder); README rows final
  after their live legs
  (T4.29, T4.39, T4.49, T4.69 and T4.79 are `Done` except the post-T4.n8 update; T4.59 is `Done`);
  Muse Code (Should) has module, compile matrix, auth preflight,
  conformance suite and Git declaration on synthetic fixtures, with no `muse` run (README
  [Muse Code CLI](providers.md#muse-code-cli-milestone-4), ROADMAP T4.72 to T4.79); T4.71 and T4.78 need Meta access
  (Q-27); T4.73
  is `Done` against its Done-when under owner decision 65 (a), with record spellings, session-id field and `terminal`
  values Assumption until the T4.71 capture (carried by T4.78); T4.76 is `Done` against its Done-when under owner
  decision 65 (b), on Switchboard's ADR-0039 tool-call guard alone, with tool-record field names Assumption until
  T4.71; T4.79 is `Done` except the post-T4.78 update.
  Outside an approved `privileged` bypass scope every profile is ineligible for the new providers, including a
  Kimi Code `privileged` scope without `bypass`, which is `Ineligible: PROFILE_UNSUPPORTED` ("Kimi has no permission
  requests") since the owner-level ruling relayed 2026-10-19 08:45 CDT (ROADMAP T4.68; ADR-0049 item 3). See
  [ROADMAP §6.8](../ROADMAP.md#68-m4-adapter-expansion-tasks).

What works today: `doctor`, `runs list|show|cancel`, `approve`, `deny`, `gc`, `capacity`, `affinity list|reset`,
`index status|rebuild|clear`, `projects list|show|validate|approve`, `git push`, `inner status|test|resume`,
`skills list|show|add|approve|revoke|retire|unretire|diff`, and
`serve` exposing seventeen MCP tools over stdio (eighteen when retrieval is on for at least one of the client's
projects, twenty with skills enabled, twenty-three with `manage_projects`, plus two approval-proxy tools for an
`approval_proxy` client; a `console` client sees only the console set). The five trust
profile names exist; which of them a provider can run is listed in [Trust profiles](providers.md#trust-profiles) and by
`list_capabilities`. Read
[Known limitations](advanced-features.md#known-limitations) before relying on it.

The milestone status log (per-milestone progress with dated evidence) lives in
[ROADMAP §11](../ROADMAP.md#11-milestone-status-log-moved-from-the-readme-t812).
