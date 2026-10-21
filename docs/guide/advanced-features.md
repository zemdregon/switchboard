# Advanced features

Retrieval index, telemetry, container environments, the control plane and Switchboard-controlled skills. Part of the
[Switchboard guide](README.md).

## Retrieval index (milestone 12)

The retrieval index is **off by default**. Without a configured `rag.embedding` backend, `mode: "auto"` keeps every
project off, `serve` does not build indexes, and `delegate_task` behaves as today. Setting `mode: "on"` without a
backend is a configuration error at load time.

Minimal example (loopback embedding service you run yourself; Switchboard has no API-key field):

```json
{
  "rag": {
    "embedding": {
      "kind": "http",
      "base_url": "http://127.0.0.1:8080",
      "model": "your-embed-model",
      "allow_remote": false,
      "allow_source_content": false
    },
    "mode": "auto"
  }
}
```

`embedding.kind: "local"` is refused today. A backend is `local` only when every resolved address is loopback; anything
else is `remote` and stays unused until both `allow_remote` and `allow_source_content` are true (the same locality rules
as the inner agent (`inner_agent` in [Configure](getting-started.md#configure)). Source text is redacted before embedding;
credential-shaped strings in the config are rejected at load.

Per project (and per context for `exclude`, `caps` and `contribute_to_global`), you may set `rag.mode`, lower caps,
add `exclude` globs, `use_global` (read the optional global index) and `contribute_to_global` (copy this project's
chunks into it). Both sharing flags default to false; contexts on `inspect-untrusted` or `edit-untrusted` do not
contribute unless you opt a context in. Operator-only `rag.global.enabled` and `global.sources` add read-only
directories under your allowed roots.

While `serve` runs, Switchboard builds and refreshes indexes in the background. A build never blocks admitting or
starting a run. At dispatch, a project with retrieval on may receive an **untrusted context pack**: labelled snippets
prepended to the volatile part of the compiled prompt only. The stored request text and the run's outcome are unchanged;
any retrieval failure, timeout, stale index or gate denial means no pack, not a failed run.

Operator commands (counts and metadata only; no chunk text in the ledger):

```text
switchboard index status [<project>|global] [--json]
switchboard index rebuild [<project>|global]
switchboard index clear [<project>|global]
```

`rebuild` and `clear` write operator requests that a running `serve` applies (like `approve`). With no `serve`, `clear`
is applied immediately under the data-directory lock; `rebuild` is queued for the next `serve` start. Inspect state with
`index status` and the `doctor` retrieval block above.

The MCP tool `search_project_context` exists only when an embedding backend is configured **and** the client may use at
least one project with retrieval on. It is read-only, scoped to that client's projects, and bounds result count and
size. `scope: "project"` searches the project's index; `global` and `both` need `use_global` on the project, but
`global` reads only the global index and `both` merges project and global hits by score under one limit. A global hit
is served only while its origin still contributes (a project never gets its own contribution back) and carries
`origin_project` or `source`. When the global index is unavailable, `global` returns `unavailable` with
`GLOBAL_NOT_AVAILABLE` and `both` keeps the project results with the global failure code as the reason. Treat every
returned `text` field as untrusted reference data, not instructions.

The same search is also an agent tool inside a run (ROADMAP T12.9) **only under the bypass-only Claude Code channel
opt-in** `providers.claude-code.git_channel`: in an approved `privileged` bypass run whose project has retrieval on, the
run's tool channel also offers `search_project_context` (allowed by the exact rule
`mcp__switchboard-git__search_project_context`). It searches only the run's own project, takes `query`, `limit` and
`scope` but no `project` or path, and has the same bounds and `unavailable` answers as the MCP tool. Without the
opt-in, or for any other provider, nothing changes.

Privacy: retrieved text never feeds trust profiles, eligibility, approvals, routing, commit or push decisions (an
import-boundary test enforces this). Embedding calls are recorded apart from provider usage and capacity. Indexes live
under `<data_dir>/rag/`; deleting a project removes its store.

Tests on fakes and fixtures (no live embedding in CI): `src/config/rag.test.ts`, `src/retrieval/*.test.ts`,
`src/lifecycle/context-pack.test.ts`, `src/mcp/search-context.test.ts`, `src/mcp/channel-search.test.ts`,
`src/cli/rag-index.test.ts`. Task-level
evidence is in [ROADMAP §6.7](../ROADMAP.md#67-m12-retrieval-index-tasks).

## Telemetry and adapter versioning (milestone 8)

Milestone 8 hardens telemetry export and adapter version change detection. It is **`Partial`**: configuration, a lazy OTLP
exporter, wrapper-boundary spans (T8.2), the collector integration test (T8.3,
[#552](https://github.com/zemdregon/switchboard/pull/552)), the export-time allowlist drop (T8.4,
[#549](https://github.com/zemdregon/switchboard/pull/549)), the version canary and the CI version-bump test are in
place on fakes; acceptance closure (T8.7) is `Done` (see below).
[#558](https://github.com/zemdregon/switchboard/pull/558) reconciled this section and the M8 milestone row after T8.3
landed.

**Trace export (T8.0, T8.1).** Set `telemetry.otlp_endpoint` to an `http` or `https` URL when you want OTLP/HTTP traces.
When the key is absent or empty, `serve` behaves as before M8: no OpenTelemetry packages load at startup and nothing
listens for trace export. (The per-run provider OTLP receiver below is separate: it stays shut unless
`telemetry.provider_otlp` is `true`.) Invalid URLs are rejected at config load without echoing the value. Spans are
intended to carry
only allowlisted attributes from controller-observed facts (prompts, commands and credentials never belong on spans);
see [LLD §7](../design/LLD.md#7-telemetry-spans) and [ADR-0012](../adr/0012-telemetry-at-wrapper-boundary.md).

**Wrapper spans (T8.2).** With an endpoint configured, `serve` emits `controller.delegate` and `provider.spawn` from
controller-observed facts only (lifecycle and spawn callbacks). `src/telemetry/spans.test.ts` runs a fake-adapter
delegate path through an in-process collector and asserts allowlisted attributes plus absence of a planted prompt
canary.

**Allowlist drop (T8.4).** Before export, Switchboard drops any span attribute whose key is not on the LLD §7
allowlist, and any non-scalar or non-finite value (`src/telemetry/allowlist.ts`, applied in `recordSpan` of
`src/telemetry/index.ts`). Dropped values are not logged, since a dropped value may itself be forbidden text, and an
attribute set that throws while being read is dropped whole. `src/telemetry/allowlist.test.ts` plants a disallowed key
on an internal span builder and asserts it never reaches the exporter, and checks that the key set matches LLD §7.

**Collector integration test (T8.3).** `src/telemetry/collector-lifecycle.test.ts` (suite
`collector integration: fake-adapter delegate/finalize path (T8.3)`) runs a fake-adapter delegate/finalize path with
OTLP pointed at the in-process collector fixture `src/telemetry/fixtures/collector.ts`, then asserts the span count,
the LLD §7 parent links (`provider.spawn` under `controller.delegate`, one trace per run; `src/telemetry/links.ts`)
and the absence of every forbidden attribute category from LLD §7. The scan has positive controls: planting a
forbidden category on an exported span fails the lifecycle path (same file), and `src/telemetry/collector.test.ts`
checks each forbidden key and value class individually. No provider CLI is installed in CI. The collector test landed
in [#552](https://github.com/zemdregon/switchboard/pull/552).
[#558](https://github.com/zemdregon/switchboard/pull/558) fixed an M14 acceptance scenario F flake in
`src/mcp/m14-acceptance.test.ts`: the wrong-digest probe flips the last hex digit so it cannot collide with a
digest that already ends in `0`.

**Version canary (T8.5).** Switchboard records each enabled provider's probed CLI version under the data directory
(`version-canary.json`). A version change marks the adapter `ADAPTER_VERSION_UNVERIFIED` until you run
`switchboard adapters validate <provider>` successfully; routing and `doctor` apply the same rule. On the operator host,
schedule `switchboard adapters version-canary` (cron, systemd timer or equivalent); CI uses injected versions only.
Details: [docs/operations/version-canary.md](../operations/version-canary.md).

**Own-repository evaluation (T8.14).** `switchboard eval run <suite> --provider <id>` replays a suite of your own past
tasks from `<data_dir>/eval/<suite>.json` as normal runs, grades each in a network-off container with hidden tests the
agent never sees and records pass, wall-clock time and usage in `eval_result`. It is opt-in, skipped in CI, and a real
provider needs `--live-budget <file>`. Details: [docs/operations/evaluation.md](../operations/evaluation.md).
Tests: `src/eval/eval.test.ts`, `src/cli/eval.test.ts`.

**CI version-bump test (T8.6).** `src/adapters/version-bump-preflight.test.ts` (suite
`version bump through preflight cache invalidation (T8.6)`) simulates a binary identity change, invalidates the
preflight cache, and asserts routing excludes the provider until validation records the new version. No provider CLI is
installed in CI.

**Acceptance closure (T8.7).** `Done`: this section and the M8 status in
[ROADMAP §6](../ROADMAP.md#6-milestones) match `src/telemetry/` and the version canary on `main`, with design-doc
corrections in [#571](https://github.com/zemdregon/switchboard/pull/571) and requirements alignment in
[#575](https://github.com/zemdregon/switchboard/pull/575). M8 itself stays `Partial` until the operator records a dry
run of the scheduled canary on a real CLI upgrade (T8.5).

**Per-run provider OTLP receiver (T8.15).** `Done` on fakes (2026-10-19, Delegated agent work, not owner-approved):
with `telemetry.provider_otlp: true`, a run whose provider manifest declares `otlp_metrics` (with a
provider-documentation citation) gets a loopback-only OTLP/HTTP-JSON metrics receiver (`127.0.0.1` ephemeral port)
for the run's lifetime; token and cost figures it accepts become `provider_reported` usage observations for that run,
forbidden attributes are dropped, and run/task ids are injected by the controller, never trusted from the payload.
With the switch off (the default) no listener opens; a provider without a declaration gets no listener and no extra
environment. No shipped manifest declares `otlp_metrics` yet. No protobuf, no gRPC, no new dependency. See
[ADR-0063](../adr/0063-per-run-provider-otlp-metrics-receiver.md) and
[LLD §20.13](../design/LLD.md#2013-tamper-evident-ledger-provider-telemetry-evaluation-brief-and-critic-t813-t815-t814-t514-t1417).

Tests on fakes: `src/config/config.test.ts`, `src/telemetry/index.test.ts`, `src/telemetry/spans.test.ts`,
`src/telemetry/allowlist.test.ts`, `src/telemetry/collector-lifecycle.test.ts`, `src/telemetry/collector.test.ts`,
`src/telemetry/provider-otlp.test.ts`, `src/lifecycle/lifecycle.test.ts` (T8.15 block),
`src/adapters/version-canary.test.ts`, `src/adapters/version-bump-preflight.test.ts`. Per-task evidence is in
[ROADMAP §6.15](../ROADMAP.md#615-m8-hardening-tasks).

## Container environments (milestone 10)

A `container` project runs the provider inside a rootless Docker container that mounts only the run worktree (writable)
and declared read-only contexts, applies limits and network policy, and is torn down when the run ends. The image must
have no `git` or `gh` on its `PATH` ([ADR-0020](../adr/0020-container-image-without-git-client.md)). On `main` today
the port, security legs and MCP admission are tested on fakes ([PR #554](https://github.com/zemdregon/switchboard/pull/554));
opt-in Docker legs remain open (operator in-volume login, T10.0, is Done since 2026-10-18).

### Status and tests

Fixtures and emulated runtime in CI; opt-in Docker when `SWITCHBOARD_CONTAINER_TESTS=1` and a rootless daemon plus a
local base image are available:

- Malicious-fixture container leg (T10.3): `test/malicious/container-leg.test.ts`; opt-in Docker:
  `test/malicious/container-docker-leg.test.ts`.
- `projects validate` container checks (T10.3): `src/cli/projects.test.ts` (`container environment checks (T10.3 ...)`).
- Retention GC of containers (T10.3, FR-PRJ-09): `src/workspace/gc.test.ts` (`retention GC of container environments
  (T10.3, FR-PRJ-09)`).
- Orphan sweep and `environment` run events (T10.2): `src/reconcile/reconcile.test.ts`, `src/cli/serve-orphan-sweep.test.ts`.
- Mounts, limits and teardown (T10.1): `src/environment/container.test.ts`; opt-in Docker: `src/environment/container-docker.test.ts`.
- MCP admission and `serve` composition (T10.1): `src/mcp/mcp.test.ts` (`container projects through MCP admission
  (T10.1; ...)`), `src/cli/serve-environments.test.ts`, `src/environment/resolver.test.ts`.

Per-task evidence is in [ROADMAP §6.4](../ROADMAP.md#64-m10-container-environments-tasks).

## Control plane (milestone 14)

One orchestrator client can poll `get_digest`, list runs, steer runs and pause or resume projects. A separate
`approval_proxy` client and `notification_sinks` are operator-configured; they are off unless you set them in config.

### Configuration

Control-plane knobs live in `config.json` (no duplicate schema here):

- `mcp_clients[]`: per client, `tool_profile` (`orchestrator` default or `console`), `approval_proxy` and
  `approval_proxy_targets` for the proxy client (ADR-0047), and
  `approval_proxy_kinds` to limit the approval kinds it may decide (ADR-0068).
- `control_plane.budgets` and `control_plane.loop_breaker` (T14.4–T14.5).
- `control_plane.digest_schedule` (T14.16, FR-CTL-14): `{ cron }` in the UTC cron syntax; pushes a metadata-only
  digest to the sinks on schedule; absent means off.
- `projects[].queue.stall_hours` (T14.16, FR-CTL-14): integer 1 to 720 hours; a project with `READY` items and no
  item reaching `DONE` in the window is flagged `stalled_progress` on `get_digest`; absent means off.
- `projects[].critic` (T14.17, FR-CTL-15): `{ enabled, min_diff_lines }`; one read-only advisory critic run on another
  provider after a large diff, findings attached as untrusted text that never changes the original run; `enabled`
  default `false`, `min_diff_lines` integer 1 to 1 000 000 default 400; config-file key only (not a dynamic project
  definition); absent means off.
- `notification_sinks[]`: webhook and ntfy kinds, filters (including the `digest` kind, T14.16, and the
  `decision_requested` kind, T14.15, FR-CTL-13, which carries no decision text) and rate
  limits, plus an optional webhook `authorization`
  value sent as the `Authorization` header (FR-CTL-12, T14.14, ADR-0048); off by default.

See [TDD §3.1](../design/TDD.md#31-configuration) and [LLD §3.4](../design/LLD.md#34-control-plane-m14-proposed-t140).

### MCP tools

| Surface | Orchestrator (default) | `console` profile | `approval_proxy` client |
| --- | --- | --- | --- |
| `get_digest`, `list_runs`, `get_run` | yes | yes | yes (read) |
| `delegate_task`, `cancel_run`, … | yes | subset (`delegate_task` only) | no extra |
| `list_pending_approvals`, `decide_approval` | no | no | yes |
| `request_decision`, `list_decisions` | yes | no | no extra (`decide` only) |
| `decide` | no | no | yes (an `approval_proxy` client decides only decisions of its targets) |
| `pause_project`, `resume_project`, `steer_run` | yes | yes | no |
| `publish_run` (push a SUCCEEDED run's branch, open a pull request with the operator's `gh` login; ADR-0069) | only with `max_push_policy: "branch"` | no | no extra |
| `merge_run_pr` (merge a published run's pull request through the project's merge policy gate; ADR-0070; also accepts a pure base-merge head, ADR-0073) | only with `max_push_policy: "branch"` | no | no extra |
| `update_run_branch` (merge the base branch into a published run's pull request branch through the operator's `gh`; ADR-0073) | only with `max_push_policy: "branch"`, the merge policy on, and the merge port | no | no extra |
| `close_pr` (close a superseded pull request `publish_run` created, linking its replacement; ADR-0078) | only with `max_push_policy: "branch"` | no | no extra |

Tool outputs use closed controller fields only (no transcripts). Pending approvals expose an `approval_digest`, not
scope bodies.

### Operator commands

Global pause and resume use `switchboard pause` and `switchboard resume` (applied directly or queued for a running
`serve`). Sinks stay off unless `notification_sinks` is set.

### `doctor`

Today `doctor` lists configured sinks showing `set`/`unset` for the webhook `authorization` and ntfy token without
echoing values (T14.14), but adds no sink reachability checks yet (optional, T14.13 README outline). Budget validity
and ADR-0047/0048 acceptance follow owner review of those ADRs.

### Status and tests

Fixtures only; no live provider CLI:

- M14 acceptance: `src/mcp/m14-acceptance.test.ts` (scenarios A–G).
- Pause (T14.6): `src/mcp/pause.test.ts`, `src/control/pause.test.ts`, `src/cli/pause.test.ts`.
- Approval proxy (T14.8): `test/malicious/approval-proxy.test.ts`.
- Notification sinks (T14.9): `src/control/sinks.test.ts`; producer legs in `src/lifecycle/lifecycle.test.ts`
  (`approval_pending`/`awaiting_approval` at admission, `parked_loop`/`failed_after_retry`/`skill_cleanup_failed` on
  the run path), `src/mcp/project-tools.test.ts` (pending-revision `approval_pending`), `src/ci/ci-trigger.test.ts`
  (`ci_fix_stuck` 0-to-1), and `test/malicious/approval-proxy.test.ts` / `test/malicious/consent-link.test.ts`
  (served-resource link).
- Webhook authorization (T14.14, FR-CTL-12): `src/config/notification-sinks.test.ts`, `src/cli/cli.test.ts` (doctor
  `set`/`unset` suite); header-delivery and canary scans in `src/control/sinks.test.ts`.
- Decision requests (T14.15, FR-CTL-13): `src/mcp/decisions.test.ts` (park and exactly-once resume/reroute/cancel,
  digest `open_decisions` without text, sink payload without text, tool gating by profile and proxy flag, consent
  links) and `src/ledger/ledger.test.ts` (migration 0030 on a version 29 database keeps every work item, event and
  T15.7 column); operator side `switchboard decisions list`/`decide`
  in `src/cli/decisions.ts`.
- Scheduled digest push and progress stall (T14.16, FR-CTL-14): `src/control/digest-push.test.ts` (metadata-only
  digest on schedule, stall derivation, project-level flag on `get_digest`) and
  `src/config/digest-stall-config.test.ts` (off by default, resolution, refusal of bad cron and stall values).
- Advisory critic (T14.17, FR-CTL-15): `src/control/critic.test.ts` (threshold, exactly-once admission on another
  provider under `inspect-untrusted`, untrusted findings artifact, budgets, off by default) and
  `src/config/critic-config.test.ts` (off by default, resolution, refusal of bad values, absent from dynamic project
  definitions).
- Digest and envelopes: `src/mcp/digest.test.ts`, `src/mcp/list-runs.test.ts`, `src/mcp/needs-attention.test.ts`.

### Known limitations

- The Grok bot is the intended first console client (owner decisions 53/55); ADR-0047 and ADR-0048 are still Proposed.

## Switchboard-controlled skills (milestone 16)

A skill is an operator-authored instruction pack (a Markdown file with `name` and `description` front matter) that
Switchboard stores, versions and injects into a run by name. The orchestrator names skills on a request, and the
configuration adds defaults per installation, per project and per role. Skills are instructions for the agent, not
controls: a skill never changes a run's trust profile, argv, environment, tool set or Git-write denial
([ADR-0056](../adr/0056-switchboard-controlled-skills.md), [LLD §19](../design/LLD.md#19-switchboard-controlled-skills-m16-proposed)).
Everything here is Delegated agent work, not owner-approved beyond the direction (owner decision 58), and off by
default.

### Configuration

Keys in `config.json` ([LLD §19.3](../design/LLD.md#193-configuration-fr-skl-03-fr-skl-04-fr-skl-08) owns them;
no duplicate schema here):

- `skills.enabled` (default `false`). While false the request fields are refused (`INVALID_REQUEST`,
  `SKILLS_DISABLED`), the two MCP tools are not offered, and nothing else changes.
- `skills.defaults[]` and `skills.roles.<role>[]`: names (`name` or `name@n`) applied to every run, or when the request
  names that `role`. `projects[].skills.defaults[]` and `projects[].skills.roles.<role>[]` add project-level entries
  after the global ones.
- `skills.delivery`: `native_preferred` (default) or `prefix_only`. With the adapters shipped today the two behave the
  same (see Delivery below).
- `skills.allow_draft_in_trusted` (default `false`): lets a `trusted-development` run take a draft version by name.
- `skills.max_body_bytes`, `max_per_run`, `max_run_bytes`, `max_names`: caps on one body, the skills of one run, their
  total bytes and the store (defaults 32768, 8, 65536 and 64, Assumptions).
- `mcp_clients[].skills`: an allow-list of names the client may see and inject; absent means every approved name, an
  empty list means none.

### Operator commands

`switchboard skills list [--all]`, `show <name>[@n] [--body]`, `add <name> --file <path> [--from-repository]
[--note <text>]`, `approve <name>@<n>`, `revoke <name>@<n>`, `retire <name>`, `unretire <name>` and
`diff <name>@<a> <name>@<b>`. `add` validates the file (front matter keys, size, control characters, prompt
delimiters and secret-shaped text are refused with exit 65 and one reason), canonicalises it and stores it as an
immutable content-addressed file under `<data_dir>/skills/<sha256>.md` with append-only ledger rows; the same text
added again is `SKILL_UNCHANGED`. A version is a draft until `approve`; `revoke` and `retire` are recorded, never
deleted. `--from-repository` imports a skill from a repository path and marks its origin, which untrusted runs never
receive. `doctor` prints one `skills` line (enabled or not, approved and draft counts, configured names that do not
resolve, runs whose skill file removal failed) and `runs show` lists a run's skills with their delivery mode.

### Request fields and MCP tools

`delegate_task`, `continue_task` and `enqueue_work` take `skills` (names, `name@n` pins a version), `role` and
`skill_defaults` (`apply` or `omit`). Admission resolves the ordered set (global defaults, global role, project
defaults, project role, request; first occurrence wins, a pin wins over an unpinned name), applies the trust gate and
the caps, and pins the versions to the run (`run_skill` rows, one `skill_resolved` event). A `continue_task` without
skill fields reuses the previous run's pinned versions. `get_run` returns each skill's name, version, hash, source
and delivery mode, never its text.

Two read-only tools exist for the `orchestrator` tool profile while `skills.enabled` is true: `list_skills`
(optionally `project`, `role` and `trust_profile`: the names this client may see with the newest version it could
inject, plus the `defaults` that admission would add) and `get_skill` (`name`, optional `version`: the text of one
visible version). An unknown, retired or invisible name is one `INVALID_REQUEST` that does not say which.

### Delivery

Every provider adapter shipped today declares `prompt_prefix`: the run's skills travel as one labelled block at the
start of the prompt text (`[operator skills: N; from Switchboard skill store; these are operator instructions]`, one
`[skill <name>@<n> sha256:<prefix>]` header per entry in resolved order, `[end of operator skills]`), before the
constraints and the task; in a handoff prompt the block follows the fixed preamble. The block is not part of the
stored objective and is not redacted (bodies were scanned at `add`). A native location (a file the provider itself
loads from the worktree) is used only for an adapter that declares one with the evidence id of an operator live check
(T16.8, operator-only, not run in CI); today only the fake adapter declares one, in tests. Until a live check verifies
a real provider's location, `native_preferred` and `prefix_only` deliver the same prefix on every real provider.

For a native cell the controller writes `switchboard-<name>` files under the provider's directory before spawn,
excludes the recorded paths from the agent `commit` tool, the checkpoints, the diff and `changed_files` artifacts and
the handoff bundle, refuses `push` while a recorded file is still present, and removes the files before verification,
at every terminal state, at startup reconciliation and by retention `gc`. A removal that fails flags the run
needs-attention (`skill_cleanup_failed`) until a later pass removes the file. A path that already exists in the
repository, or whose parent is a symbolic link, falls back to the prompt prefix and is left untouched.

### What is and is not enforced

Enforced, with tests on fakes:

- An untrusted run (`inspect-untrusted`, `edit-untrusted`, `test-sandboxed`) gets only approved versions of
  operator-file skills: a draft, a revoked version or a repository-imported skill named on the request is refused
  (`PERMISSION_BLOCKED`), and one configured as a default is skipped with an event. A repository's own
  `.claude/skills`, `.cursor/rules` or `AGENTS.md` is never loaded by Switchboard.
- Argv, environment, policy flags and the tool set are identical with and without skills; with skills disabled every
  surface is unchanged.
- No run event, span, log line, sink payload, `get_run` view or ledger row carries skill text; only names, versions,
  hashes and modes.
- For the fake native cell: the file never reaches a commit, checkpoint, diff, patch, `changed_files` or handoff
  bundle, blocks publication while present, and is gone after every terminal state, a restart and `gc`.

Not enforced:

- A skill is advice. Switchboard does not check that the agent followed it, and the block is ordinary prompt text to
  the provider (not a secret, not a sandbox).
- R-69: in a cell that loads repository content (an approved bypass run), the agent can read a native skill file and
  copy its text into another file, which then reaches a commit. Path exclusion catches the recorded path, not the
  copy. Native delivery is off for every real provider until T16.8 verifies a cell, and `add` refuses secret-shaped
  text, so a copy exposes operator instructions, not credentials.
- No real provider's native skill location is verified (T16.8 Done 2026-10-19, decision 70: Claude Code `NOT_LOADED`;
  Grok Build, Cursor and Muse Code `NOT_CHECKED`). Prompt-prefix delivery has not been
  observed on a live provider through Switchboard either; the acceptance tests run on fakes.

### Status and tests

Fixtures only; no live provider CLI:

- M16 acceptance: `src/mcp/m16-acceptance.test.ts` (one test per clause of the M16 acceptance column).
- Store and format (T16.1): `src/skills/skills.test.ts`; configuration (T16.3): `src/skills/skills-config.test.ts`;
  operator CLI (T16.2): `src/cli/skills.test.ts`.
- Admission (T16.4): `src/mcp/skill-admission.test.ts`, `src/skills/admission.test.ts`,
  `src/skills/import-boundary.test.ts`; tools (T16.9): `src/mcp/skill-tools.test.ts`.
- Delivery (T16.5 to T16.7): `src/lifecycle/skill-delivery.test.ts`, `src/adapters/skill-prefix.test.ts`,
  `src/lifecycle/native-skills.test.ts`, `src/workspace/native-skills.test.ts`, `src/reconcile/native-skills.test.ts`,
  `src/adapters/skill-delivery-conformance.test.ts`.
- Malicious-fixture leg (T16.11): `test/malicious/skills-leg.test.ts`.
