# MCP server and operator CLI

Run Switchboard as an MCP server: the tool reference, continuing sessions, capacity, routing, Git commits and the
operator command reference. Part of the [Switchboard guide](README.md).

## Run as an MCP server

`serve --client <id>` runs the MCP server on stdin/stdout for one configured client. stdout carries MCP messages only;
logs are JSON lines on stderr. It rejects `--json`. It stops on SIGINT, SIGTERM or when the client closes stdin.

To use it, register Switchboard in your orchestrator's MCP settings as a **stdio** server with:

- command: `node`
- args: `/path/to/switchboard/dist/cli/bin.js serve --client orchestrator` (plus `--config <path>` if you use a
  non-default config)

The exact config format differs between orchestrators; follow your orchestrator's documentation for adding a stdio MCP
server. The `--client` id must match an `mcp_clients` entry; that entry's `max_trust_profile` caps what the session can
request. There is no further authentication on stdio, so the binding is only as strong as your control over the
orchestrator's launch configuration.

Only one `serve` can hold a data directory at a time.

### MCP tools

| Tool | Family | What it does | Availability |
| --- | --- | --- | --- |
| `delegate_task` | run | Starts a coding task in a new meta-session; returns a `run_id` at once (optional `wait_seconds`, 0 to 60, waits without cancelling). Give exactly one of `workspace_path` and `project` (see `list_projects`). `trust_profile` may be omitted when the operator set `default_trust_profile`: it is then that default lowered to your ceiling, and a `privileged` request without `privileged_scope` uses `default_privileged_scope` (ADR-0091). For a client the operator set `promote_trust_profile`, an explicit `trust_profile` below that default is promoted to it (the run gets a `trust_profile_promoted` event; ADR-0093). | Always |
| `continue_task` | run | Continues an idle meta-session with a new instruction: resumes the same provider's native session, or hands off to another provider (or a fresh session) with a bundle built from Switchboard's own records. A `privileged` meta-session continues on its own provider only. | Always |
| `get_run` | run | Returns a run's status, failure code, provider, summary, changed-file count and artifact ids, optionally with events. A run that was retried or failed over names its successor in `superseded_by`; the successor names the run it follows in `retry_of`. | Always; `console` sees it |
| `cancel_run` | run | Requests cancellation of a run (asynchronous; poll `get_run`). | Always (orchestrator only) |
| `get_artifacts` | run | Lists a run's artifacts (diff, changed files, test report, ...) with hashes; small ones inline. | Always (orchestrator only) |
| `list_capabilities` | capability | Lists providers with adapter status, version, validated range, auth state and supported trust profiles; `privileged` is listed when the adapter compiles any privileged scope here, possibly only the approved bypass cell, which `privileged_bypass_only: true` marks ([ADR-0092](../adr/0092-list-capabilities-lists-approved-bypass-cells.md)). | Always (orchestrator only) |
| `get_capacity` | capability | Per-provider capacity: controller estimates (`capacity_score`, `confidence`, `throttle_risk`) with their sources, free slots, the circuit breaker, and `reset_at` or `explicit_remaining` only when the provider itself reported them; reported cache token counts where a source names the keys; per-project counts of runs that kept or switched provider and model; one `pacing` entry per configured subscription; and, for Codex, Cursor and Antigravity, `provider_usage` (the signed-in account's quota windows, plan and credits, `provider_reported`, read through `codex app-server` or Cursor's own `/usage` command, cached for a minute, `unknown` when the read fails); for Claude Code, the same report built from the windows printed in recorded run output, as of the newest Claude run; for OpenCode, `provider_usage` carries `spend_windows` instead (USD spent in 5-hour, 7-day and 30-day windows from OpenCode's local session history, with `scope` and `note`; no limit, remaining or reset); and, unless `capacity.copilot_quota` is `false`, a `provider_quota` array with your GitHub Copilot quota read through your own `gh` (usage-only, `provider_reported`). Read-only; it makes no model call and reads no credential, and `{"provider":"copilot"}` returns only the Copilot entry. | Always (orchestrator only) |
| `explain_route` | capability | Why a run went to its provider, from Switchboard's stored route decision: candidates with eligibility reasons, the recorded task features, weights and per-candidate scores, the selection rule and short deciding factors. Price, model quality and sandbox strength are not sourced, so those terms are equal for every provider. Read-only; no model is asked. | Always (orchestrator only) |
| `list_runs` | control | Runs visible to this client, newest first, with optional project, status and time filters. | Always; `console` sees it |
| `get_digest` | control | A per-project digest since a cursor: paused state, budgets, needs-attention runs, finished and failed runs, pending approvals and untrusted summaries. | Always; `console` sees it |
| `pause_project` | control | Pause one of the client's projects: no new run is admitted (running runs finish) until resume. | Always; `console` sees it |
| `resume_project` | control | Lift a pause this client set on one of its projects. | Always; `console` sees it |
| `steer_run` | control | Append a note to a run; on a fake adapter it continues the same native session. | Always; `console` sees it |
| `list_projects` | project | Lists the configured projects this client may use (id, name, environment kind, contexts with their effective definition (`base_ref`, push remote name and branch prefix, commit identity, `sign`, `finalize_commit`, `submodules`), trust ceiling, `default_trust_profile` when the operator configured a default, allowed providers, merge policy), plus its own dynamic projects marked `source: "dynamic"` with their revision and status. Read-only; returns no filesystem paths. | Always (orchestrator only) |
| `enqueue_work` | queue | Queue a `delegate_task` request on one project this client may use; the controller admits it later under the creating client's ceiling. An omitted `trust_profile` (and a privileged request's omitted scope) is filled from the operator's defaults at enqueue and stored. | Orchestrator profile only (stdio and network transport); `console` sees none |
| `list_work` | queue | Work items this client queued, highest priority first, then oldest, with optional project and state filters. | Orchestrator profile only (stdio and network transport); `console` sees none |
| `cancel_work` | queue | Cancel a `PENDING` or `READY` item this client queued; an admitted item stops with `cancel_run` on its run. | Orchestrator profile only (stdio and network transport); `console` sees none |
| `publish_run` | publication | Push one of this client's SUCCEEDED runs' branch with the operator-push rules and the pre-push secret scan, then open (or reuse) a pull request with the operator's `gh` login. Idempotent. For a project with writable submodules (ADR-0087) it first scans every changed repository, pushes each submodule branch to its own repository, then the umbrella, and opens one pull request per repository (the umbrella's lists the others); the result adds `submodules[]` and the run envelopes list `linked_pull_requests`. A pull request already merged at the published head is returned with `merged: true` (ADR-0095). If `gh` fails, the push stands, `pull_request` is null and `pull_request_error` names why; `GH_FAILED` adds `pull_request_error_detail` (exit code, a closed `reason` such as `HEAD_BRANCH_MISSING` or `RATE_LIMITED`, and a redacted, capped `gh` message). See [ADR-0069](../adr/0069-mcp-publish-run-and-dynamic-project-push.md) and [ADR-0095](../adr/0095-publish-run-gh-failure-detail-and-merged-reuse.md). | Only with `max_push_policy: "branch"` (orchestrator profile) |
| `merge_run_pr` | publication | Merge the pull request of one of this client's published runs with the operator's `gh` login, only through the project's merge policy gate (T15.8: policy in force and on, not paused, open, not draft, published head, base branch, mergeable, every required check passed, verification and reports as the policy says), pinned to the head (`--match-head-commit`). The head may also be a chain of pure base merges on the published tip (GitHub's Update branch commit, verified by the controller; ADR-0073); the result carries `head_kind` (`published` or `base_merge`). Refusals are `PERMISSION_BLOCKED` with a closed `details.reason`; every decision is a `merge_event` in `get_digest`. Idempotent. With linked submodule pull requests (ADR-0087) it merges them first, in path order, re-points the umbrella to the merged commits, then merges the umbrella, resuming where an earlier call stopped; `details.submodule_merge` shows the progress. See [ADR-0070](../adr/0070-mcp-merge-run-pr.md). | With `publish_run` (the server's `gh` merge port on `ci_trigger.gh_binary`, also when `ci_trigger` is off) |
| `update_run_branch` | publication | Ask GitHub, through the operator's `gh` login (`gh api` PUT `update-branch`, pinned to the head), to merge the base branch into the pull request branch of one of this client's published runs; refused unless the head is the published tip or a pure base-merge chain on it, the merge would not conflict and the project's merge policy is on. Returns `{ run_id, pull_request, updated, previous_head_sha }`; `updated: false` when the base is already contained. See [ADR-0073](../adr/0073-merge-gate-accepts-pure-base-merges.md). | With `merge_run_pr` |
| `close_pr` | publication | Close a superseded pull request that `publish_run` created for one of this client's runs of a project, with the operator's `gh` login, posting a fixed comment that links the replacement pull request (same repository) and, with `delete_branch: true`, deleting its branch. Refused (`PERMISSION_BLOCKED`, `details.reason`) for any pull request Switchboard did not create for the caller (`NOT_SWITCHBOARD_PR`), a merged one or one no longer on the published branch. Idempotent (`closed: false` when already closed). Every call, allowed or refused, is recorded. See [ADR-0078](../adr/0078-mcp-close-pr.md). | With `publish_run` |
| `refresh_project_base` | publication | Fetch a remote-backed project's base now (ADR-0074); for a project with `submodules.mode: "recursive"` it also makes the base's submodule commits present and returns `submodules: { total, present, fetched, missing }` (ADR-0087). | Offered with the base port, above `inspect-untrusted` |
| `rebase_session` | publication | Replay a meta-session's controller commits onto the fresh base without a worktree, never pushing (ADR-0074). A submodule path that both the session and the base changed is a `CONFLICT` naming the path (ADR-0087). | As `refresh_project_base` |
| `search_project_context` | retrieval | Read-only semantic search over a project's indexed contexts. See [Retrieval index](advanced-features.md#retrieval-index-milestone-12). | Only when retrieval is on for at least one of the client's projects |
| `list_skills` | skills | Operator-approved skill names this client may inject, with the newest usable version's metadata (no bodies). | Only when `skills.enabled` |
| `get_skill` | skills | The text of one visible skill version. | Only when `skills.enabled` |
| `list_oauth_clients` | oauth | The OAuth clients that registered with the embedded authorization server: id, name, state, bound MCP client profile and times; never a token, code or hash. Read-only; the same data as `switchboard mcp oauth clients`. | stdio only; never offered over the network transport |
| `create_project` | project management | Define a client-owned dynamic project (same shape and checks as a configured one). See [Dynamic projects](#dynamic-projects). | Only with `manage_projects: true` |
| `update_project` | project management | Write a new revision of a dynamic project; a widening revision stays unusable until `projects approve`. | Only with `manage_projects: true` |
| `delete_project` | project management | Remove a dynamic project once none of its runs is going; its history stays. | Only with `manage_projects: true` |
| `request_project_source` | project management | Ask for a repository owner to be added to `project_sources.allowed_owners` (an approver with the `project_source` kind or `projects sources approve` decides it; no restart). | Only with `manage_projects: true` and `project_sources` configured |
| `list_pending_approvals` | approval | Pending approvals for this client, with digests (never scope bodies). | Only with `approval_proxy: true`; `console` sees it |
| `decide_approval` | approval | Decide a pending approval with its matching digest. | Only with `approval_proxy: true`; `console` sees it |
| `request_decision` | decision | Ask the operator a question with two to six options and a recommendation; optionally park one of this client's work items (`PARKED_DECISION`) and carry work items to enqueue on the decision. Sinks hear `decision_requested`, never the text. | Orchestrator profile only (stdio and network transport); `console` sees none |
| `list_decisions` | decision | Decisions this client requested, with question, options and note labelled `untrusted_client_text`. | Orchestrator profile only (stdio and network transport); `console` sees none |
| `decide` | decision | Decide one open decision of a client this proxy may act for: the item resumes or is cancelled and the enqueue list is added once, as the requesting client; deciding twice is refused (`CONFLICT`). | Only with `approval_proxy: true`, orchestrator profile; `console` sees none |

A `console` tool-profile client sees only `get_digest`, `list_runs`, `get_run`, `delegate_task`, `steer_run`,
`pause_project` and `resume_project`, plus the two approval tools when it has `approval_proxy`; every other tool needs
the default `orchestrator` profile. See [Control plane](advanced-features.md#control-plane-milestone-14).

Tool schemas are published through MCP `tools/list`.

### Continuing a session: resume or handoff

`continue_task` takes a meta-session that has no active run and a new instruction, and does one of two things:

- **Resume.** The session's provider is eligible and has a native session: Switchboard resumes that native session
  (Claude Code `--resume <session id>`; Codex `exec <flags> resume <session id>` with the instruction on stdin, the
  form observed on codex-cli 0.162.0) in the worktree path of the run that created
  it, on a new run branch at the session's head checkpoint — unless the adapter declares `resumeCwd: 'independent'`
  from a recorded capture (today Claude Code and Codex, from T5.12 cell 2), in which case the resume gets a fresh
  worktree path. For a bound resume, if that directory is gone or is not clean, the continuation
  becomes a handoff on the same provider instead of resuming somewhere else.
- **Handoff.** You name another provider in `routing.provider_preference`, the session has no native session to resume,
  its directory is unusable, or its provider is no longer eligible. Switchboard builds a bundle, stores it as the run's
  `handoff_view` artifact and gives the new provider a fresh native session whose prompt is the bundle followed by your
  instruction. The first provider's native session is left untouched and can still be resumed.
  `require_provider: true` turns "no eligible provider" into an error instead of falling back.

What the bundle carries: your goal, constraints and every earlier instruction (labelled as your text); controller
facts (the base and head commits, run outcomes and failure codes, decisions such as routing, verification outcomes and
open work derived from them); changed-file lists and bounded diff excerpts read from Git; and each run's reported
summary or failure text, which is shown inside blocks labelled as untrusted data. What it never carries: a provider's
transcript or its state directory (Switchboard opens no file under a provider's home directory to build it), raw
provider output, credentials or tokens, a native session id, or any text that was not produced by the controller, by you
or by the repository. Size is bounded by the `continuity.max_bundle_bytes`, `continuity.max_diff_excerpt_bytes` and
`continuity.max_text_chars` configuration keys, and what was cut is listed in the
bundle's `truncation`. A bundle that cannot be built fails the call with `TOOL_FAILURE`
(`details.reason: "HANDOFF_BUNDLE_UNAVAILABLE"`) and writes nothing.

**Project brief** (T5.14, FR-SES-07): `projects[].brief_file` in the configuration file names an operator-maintained
text file (goal, definition of done, known failures) that must sit outside every allowed root and context and hold at
most 4 KiB of UTF-8; anything else stops `serve` at startup. Each run admitted on a briefed project reads
it at admission (an unreadable brief refuses the run with `TOOL_FAILURE`,
`details.reason: "PROJECT_BRIEF_UNAVAILABLE"`), freezes its SHA-256 so later edits do not change that run, and gets
it as a labelled block before the retrieved context, inside `rag.retrieval.max_context_tokens` (retrieval is trimmed
first). A handoff successor re-resolves the project and gets the block too; a native resume reuses the session that
already had it. The handoff bundle (version 3) lists the hash as `brief`, never the text. Unset, prompts are
unchanged.

`get_artifacts` returns the `handoff_view` of a handoff run; `get_run` names its artifact id and never carries bundle
text. `runs show <run>` prints a Handoff block: bundle artifact id and hash, the provider handed off from and why, the
source runs, and the binding the run started.

The `privileged` rule: a `privileged` meta-session continues on its own provider only. A continuation that would
hand it to another provider is refused with `INVALID_REQUEST` (`details.reason: "PRIVILEGED_CROSS_PROVIDER"`) before any
other provider is probed or anything is written, because a durable approval for a bypass run was given for one provider.
This is a fail-closed default until [ROADMAP Q-61](../ROADMAP.md#73-open-questions-for-zemdregon-not-blocking-m2-unless-noted)
is answered; a same-provider `privileged` continuation keeps the approval as it was.

### Capacity, retries and failover

`get_capacity`, `switchboard capacity` and the capacity lines of `doctor` show one projection, computed from
Switchboard's own records when you ask:

- **Estimates are estimates.** `capacity_score`, `confidence` and `throttle_risk` come from recent run outcomes,
  rate-limit signals the provider printed, the circuit breaker and free slots, over `capacity.window_seconds` (default
  one hour). With no recent evidence they read `unknown`, `null` and `0`, never "plenty". No provider's run output is
  known to report remaining quota, so `explicit_remaining` is `null` for every provider today (Codex's live account read
  is shown separately as `provider_usage`, below). Nothing here is a
  percentage of your subscription. The sources are in
  [docs/research/capacity-signals-2026-10-14.md](../research/capacity-signals-2026-10-14.md).
- **Provider-reported usage (Codex, Grok Build, Kimi Code).** For an enabled provider whose CLI can report the signed-in
  account's quota without a model call, each provider entry also carries `provider_usage`:
  `source: "provider_reported"` with the plan, `limit_reached`, the windows (`used_fraction`, `remaining_fraction`,
  `window_seconds`, `resets_at`) and credits, or
  `source: "unknown"` with a reason when the read failed, which is never headroom. Codex is read by running
  `codex app-server` with your own Codex login (Switchboard reads no credential and no file under `~/.codex`). Grok Build
  is read by running `grok agent --no-leader stdio` and asking its `_x.ai/billing` method, which backs Grok's `/usage`
  screen, with your own Grok login. Its report adds `period` (kind, start, reset), `amounts` (prepaid balance and
  on-demand cap and use; the unit is not stated, so it reads `unspecified`) and `unreported`, the figures Grok did not
  send, which are unknown, not zero.
  Kimi Code is read from the CLI's own `/usage` display: Switchboard runs `kimi` under a pseudo-terminal in
  `<data_dir>/probes/kimi-usage`, types `/usage` and parses the 5 hour, weekly and monthly rows (whole percent, reset
  to the minute, [ADR-0084](../adr/0084-kimi-usage-via-cli-usage-display.md)); it needs the terminal runner that
  `serve` wires, and Kimi lists that directory in its workspace list and keeps a `/usage` line in its input history.
  It is shown beside the estimates and does not change them, routing or pacing, and it is not stored. `doctor` prints
  it in a separate "Provider-reported usage" section that never changes `ok`. Details:
  [ADR-0079](../adr/0079-provider-reported-usage-reader.md), [ADR-0083](../adr/0083-grok-build-usage-reader.md),
  [docs/research/codex-usage-2026-10-21.md](../research/codex-usage-2026-10-21.md),
  [docs/research/grok-usage-sources-2026-10-21.md](../research/grok-usage-sources-2026-10-21.md).
- **Provider-reported usage (Cursor).** Cursor CLI has no non-interactive usage command, so Switchboard starts
  `cursor-agent` in a pseudo-terminal (`script(1)`, read-only `--mode ask`, an empty scratch directory), runs its own
  `/usage` slash command and reads the panel. That takes about 6 s and makes no model call. `provider_usage` then
  carries the plan, the windows `included`, `included:auto` and `included:api` (shares as the CLI rounds them), the reset
  day (`resets_at` at the start of that UTC day, `reset_precision: "day"`, `reset_label` verbatim) and `on_demand`
  (state and dollars as shown). Cursor uses its own login; Switchboard reads no Cursor file. A changed panel or a
  failed read is `unknown`. Details:
  [ADR-0080](../adr/0080-cursor-usage-from-the-cli-usage-command.md),
  [docs/research/cursor-usage-2026-10-21.md](../research/cursor-usage-2026-10-21.md).
- **Provider-reported usage (Antigravity).** Antigravity's entry carries the CLI's own `/usage` answer: one window per
  quota bucket (`id` such as `gemini-5h` or `3p-weekly`, `limit_id` the group of models sharing it, such as `Gemini
  Models`, 5-hour or weekly `window_seconds`, `remaining_fraction`, `used_fraction`, `resets_at`) and the AI-credit
  balance from `/credits` as `credits`. Switchboard runs `agy models` and, only if that shows you signed in,
  `agy -p "/usage" --output-format json` and `agy -p "/credits" --output-format json`; neither starts an agent turn or
  spends quota, and Switchboard reads nothing under `~/.gemini`. Signed out, the entry says `unknown` with "agy is not
  signed in" rather than starting a sign-in. Details:
  [ADR-0082](../adr/0082-antigravity-usage-from-the-cli-usage-command.md),
  [docs/research/usage-sources-antigravity-2026-10-21.md](../research/usage-sources-antigravity-2026-10-21.md).
- **Copilot quota (usage-only).** Unless `capacity.copilot_quota` is `false`, the projection also carries a
  `provider_quota` array with one `copilot` entry. Switchboard runs your own logged-in `gh` with the fixed command
  `gh api /copilot_internal/user` (read-only; no model call, no premium request; the token is never read), keeps a
  60-second in-memory cache and shows the plan, SKU, reset time and, for `premium_interactions`, `chat` and
  `completions`, the entitlement, remaining, used, percent remaining, overage count and whether overage is permitted.
  Every figure is `provider_reported`. If it cannot be read the entry is `status: "unavailable"` with a `reason` of
  `gh_missing`, `auth_required`, `gh_failed`, `timeout`, `unparseable` or `no_quota`. Copilot is not a provider
  Switchboard can run work on, so this never affects routing or pacing. The endpoint is GitHub-internal and
  undocumented. Shape: [LLD §16.11](../design/LLD.md#1611-provider-reported-quota-of-a-usage-only-provider-fr-cap-14-adr-0081);
  sources: [docs/research/copilot-usage-2026-10-21.md](../research/copilot-usage-2026-10-21.md).
- **Provider-reported spend (OpenCode).** OpenCode reports what was spent, not a quota. Its `provider_usage` has empty
  `windows`, `plan`, `limit_reached` and `credits` `null`, and a `spend_windows` list: one entry each for `five_hour`, `weekly`
  and `monthly` (rolling 5 hours, 7 days and 30 days, the last an assumption) with `from`, `to`, `amount` in `usd` as
  OpenCode's own price table counts it, and a `detail` with sessions, steps, tokens and the top 20 models by spend.
  `scope` says it covers every OpenCode session on this host, including use outside Switchboard; `note` says the plan
  limit, what is left of it and the reset time are not reported, so none is shown. It is read by running
  `opencode api --standalone experimental.session.stats` three times (one after another) with your own OpenCode
  install; Switchboard never opens `opencode.db` or `auth.json`. The text form prints `spent <amount> usd; limit not
  reported, remaining not reported, reset not reported`. Details:
  [ADR-0089](../adr/0089-opencode-spend-usage-reader.md),
  [docs/research/opencode-usage-2026-10-21.md](../research/opencode-usage-2026-10-21.md).
- **Circuit breaker.** After `capacity.breaker.failure_threshold` (default 3) rate-limit, overload or crash failures in
  a row, a provider is held back for `capacity.breaker.open_seconds` (default 300). New requests go to other providers;
  with `require_provider` they fail `ELIGIBILITY_NONE`. Queued runs wait. Then one run tries it, and its outcome
  closes or re-opens the breaker.
- **Automatic retry.** A `RATE_LIMIT_TRANSIENT`, `PROVIDER_OVERLOADED` or `PROCESS_CRASH` failure is retried only if the
  worktree is exactly as it was before the run. The retry is a new run in the same meta-session, with capped
  exponential backoff and jitter (`capacity.retry.*`: at most 3 attempts, 2 s base, 120 s cap). A changed worktree is
  never retried (it is rolled back and kept as evidence). A run cut off by a Switchboard restart is not retried
  either.
- **Quota exhaustion.** On `QUOTA_EXHAUSTED`, Switchboard hands the work to the next eligible provider with the same
  kind of bundle `continue_task` uses, unless you set `require_provider` or the run is `privileged`. Otherwise it waits
  for a reset time the provider reported, if that falls within `capacity.queue_horizon_seconds`. The default is 0,
  meaning never wait. Otherwise it returns `QUOTA_EXHAUSTED`.
- **Limits.** `limits.per_provider_concurrency` (default 1) applies to every provider, and
  `providers.<id>.concurrency` overrides it for one provider.
- **Cache and switch counts** are evidence, not claims. Reported cache token counts are shown only where a source names
  the provider's key (Grok Build today). The per-project kept and switched counts show the reason routing recorded
  (see [Routing and affinity](#routing-and-affinity)), or `unrecorded` for a change no affinity reason covers: a
  decision written before milestone 7, a `continue_task` to another provider, a change of reported model alone, or
  affinity turned off.
- **Pacing (subscriptions).** When `capacity.subscriptions` are configured, the same projection carries one `pacing`
  entry per subscription: each window's used share, reset and time left with its source (`provider_reported`,
  `operator_declared`, `controller_estimated` or `unknown`), `deferred_until` and the gate verdict (`deferred`,
  `clear` or `inactive`). A deferred candidate is left out when an undeferred eligible one remains; otherwise the run
  waits in `QUEUED` with a `pacing_hold` event until the gate-open time (the pacing gate, ROADMAP T6.8, `Done`
  2026-10-17). Pacing never refuses a request, fails a run or creates one. The wording rule applies: no "remaining" without
  `provider_reported`, no plan percentage, and every `controller_estimated` line reads "estimate, Switchboard-observed
  only". `doctor` prints one pacing line per
  subscription. With no subscriptions configured the block is omitted and the output is unchanged.

### Routing and affinity

Every `delegate_task`, `continue_task` and quota failover is routed in two stages, and the decision is stored with
everything needed to re-run it.

1. **Eligibility.** Providers that fail a hard constraint (enablement, trust ceiling, platform, binary, version gate,
   login, profile compile, open circuit breaker, known quota exhaustion, `minimum_capability` evaluated against
   operator-declared model capabilities in the model registry, the project's `allowed_providers`) are removed with a
   reason. Undeclared models fail closed (`CAPABILITY_MISSING`, mapping to `ELIGIBILITY_NONE`); admitted providers
   compile with the satisfying model (`src/routing/minimum-capability.test.ts`). No hint or score brings one back.
   `require_provider` with an ineligible provider is an error.
2. **Selection**, first match wins: the provider named with `require_provider`; the project's affine provider (below);
   an eligible `provider_preference`; the highest score; configured order on a tie.

**The score** is a weighted mean of six terms, each 0 to 1, computed per candidate from Switchboard's own ledger:
`success` (healthy versus counted failures in the capacity window), `latency` (median wall time of succeeded runs),
`capacity` (the milestone 6 estimate; an unknown estimate scores 0, never as headroom), `handoff` (staying on the
meta-session's provider for a continuation), and `security` and `cost`, which are 0.5 for every provider because no
source gives a sandbox-strength order or a price. With no history every provider ties, so the default is configured
order. Weights are `routing.weights` (0 to 100 each, default 1, an Assumption). A heuristic classifier also records
task features (`context_volume`, `autonomy`, `task_kind`, `reasoning_depth`) for explanation only: no feature changes
a route, because no source says which provider is better at what.

**What a score never claims.** It is not a quality, price or model ranking, and not a prediction of success. Terms with
no source are equal for every provider, so they can never decide a route.

**Affinity.** A project (its id, or the workspace path for a run without one) stays on the provider and model of its
last succeeded run. A better score, a lower cost or a lower load never moves it. It moves only for a reason from a
closed list, recorded in the decision:

- `user_request`: `require_provider` names another provider, or the operator ran `switchboard affinity reset`;
- `ineligible`: the affine provider failed stage 1 (it does not move back when it recovers);
- `capacity_exhausted`: known quota exhaustion, a quota failover, or the optional estimate trigger
  (`routing.affinity.low_water_mark` with `min_confidence`, both off by default);
- `failed_after_retry`: the project's last run there failed after its automatic retries ran out.

`provider_preference` is a hint: it does not move a project that already has affinity. A first run that fails creates
no affinity. A `continue_task` follows its meta-session, not affinity, and a `privileged` meta-session is never moved
to another provider. The model is remembered (the one the provider's session reported, or the satisfying model under
`minimum_capability`) and pinned at compile for adapters declaring acceptance of reported model flags (Claude Code
today; `src/routing/model-pin.test.ts`); an undeclared adapter keeps its default model.
`routing.affinity.enabled: false` turns affinity off.

**Prompt order.** Every adapter sends the delegated prompt in one fixed order: stable content first (the run's
constraints under a `Constraints:` heading, or a handoff's fixed preamble and bundle), then the task text, then a
retrieval context pack when there is one. Two runs of a project with the same constraints therefore send the same text
up to the task text (`src/adapters/prompt.ts`, `src/adapters/prompt-order.test.ts`). This is hygiene only: no cache
benefit is claimed, for any provider, and none has been measured (ROADMAP T7.9, Q-53).

**`explain_route`** returns, from the stored decision only, the candidates with their eligibility reasons, the
features, the weights, each candidate's terms and score, the rule that selected the provider, the affinity outcome and
short deciding factors such as `affinity held (claude)`. No model is asked and no reasoning is invented. A client sees
only its own runs. `switchboard affinity list` and `affinity reset` are under [Operator commands](advanced-features.md#operator-commands).

The rules and the record format are in [LLD §17](../design/LLD.md#17-routing-m7) and
[ADR-0044](../adr/0044-deterministic-route-scoring-and-replayable-decisions.md).

### Model groups and pacing

Model groups (milestone 7) and usage pacing (milestone 6) are built and tested on fake providers only
(`src/mcp/m7-group-acceptance.test.ts`, `src/mcp/m6-pacing-acceptance.test.ts`). With neither `model_groups` nor
`capacity.subscriptions` configured, routing decisions, outcomes and capacity output are byte-identical to a build
without them (`src/routing/group-selection.test.ts`, `src/capacity/pacing-projection.test.ts`,
`src/lifecycle/pacing-gate.test.ts`).

**What a group is.** A model group is a name you choose for an ordered list of `{ provider, model }` pairs in
`model_groups` (see [Configure](getting-started.md#configure)). It is configuration only. Switchboard ships no group,
tier or model name,
and a group's name or a member's place in it is never a claim about quality, capability or price: a group called
`flagship` is just a label. `minimum_capability` still uses only the capabilities you declared for each model, and
member order is used only as the last tie-break. A member's `provider` is a config provider id; the test-only fake
adapter id `fake` is accepted there and in `capacity.subscriptions.<name>.providers` only when that adapter is
registered (`serve` with the test-only fake switch, TDD §3.6), and is refused as before otherwise.

**How to request one.** `delegate_task` and `enqueue_work` accept two optional routing fields; give at most one:

- `routing.model_group: "<name>"` makes each member a candidate, keyed `<provider>/<model>`. Each member passes the
  usual eligibility checks with its own model; a member whose model the registry cannot resolve, or whose adapter
  accepts no model request, is left out with `CAPABILITY_MISSING`, and a group with no eligible member returns
  `ELIGIBILITY_NONE`. With `provider_preference` (and `require_provider`) only that provider's members are considered.
  The chosen member's model is the model compiled into the run.
- `routing.model: "<model id or alias>"` asks for one model. Name its provider with `provider_preference`, or leave the
  provider out and the model must resolve in exactly one enabled provider's registry.

Refused with `INVALID_REQUEST` before anything runs: both fields, an unknown group, a group with no member for the named
provider, and a model that resolves in no provider's registry, in several, or only unrestrictedly (the message says
"name a provider for this model"). `continue_task` accepts neither field; a continuation follows its meta-session.
Affinity still applies: a project whose provider and model are an eligible member keeps them; a group that does not
contain them moves the project with `user_request`. `explain_route` names the group, the chosen member, each excluded
member's code and one pacing line per subscribed provider.

**What pacing shows.** `capacity.subscriptions` describes your own subscriptions: which providers share one, each
window's length and reset (`fixed`, `rolling` or `provider_reported`) and an optional budget (`runs`,
`reported_tokens` or `reported_cost_usd`). `get_capacity`, `switchboard capacity` and `doctor` then show, per
subscription and window, the used share, the reset and time left, and the source of each figure. A used share
is `provider_reported` only from a key Switchboard reads (Claude Code, below); otherwise it is either
`controller_estimated` (your budget against Switchboard's own dispatches) or `unknown`.

**Provider-reported usage (Claude Code).** Claude Code prints its 5-hour and 7-day usage windows (used share and reset
time) with every run. Switchboard records them, and `get_capacity`, `switchboard capacity` and
`doctor` show the newest figure per window as the provider's `provider_usage` report
([ADR-0079](../adr/0079-provider-reported-usage-reader.md) shape), labelled `provider_reported`, with the time it was
observed. The figures are
as fresh as the newest Claude Code run: Switchboard never starts a run or calls the provider to refresh them, and it
reads no login token. A window whose reset time has passed is left out, and with no recent Claude Code run nothing is
shown. A subscription window whose length is 5 hours or 7 days reads the matching figure as `provider_reported`
([ADR-0088](../adr/0088-claude-code-usage-windows.md)).

**What pacing never claims.**

- A `controller_estimated` figure is a lower bound: it counts only what Switchboard dispatched, and use of the same
  subscription from anywhere else is not seen. Every such figure carries `lower_bound: true` and reads "estimate,
  Switchboard-observed only".
- "Remaining" appears only next to a `provider_reported` figure, never next to an estimate, and no figure is a
  percentage of your plan. An `unknown` window is never treated as headroom.
- Switchboard never supplies a window, reset or budget; each comes from you or from a declared provider key.

**What the pacing gate does.** With `capacity.pacing.mode: gate` (the default), a subscription whose estimated use is
ahead of its pace line plus a burst allowance is deferred until a computed time no later than the window's reset; once
use reaches the target (`target_fraction`, default 0.95) it stays deferred until the reset. A deferred candidate is
left out while another eligible one remains (an affine project then moves with `capacity_exhausted`), otherwise the run
waits in `QUEUED` with one `pacing_hold` event and starts at the gate-open time. A `rolling` window, an `unknown`
figure and an estimate below `min_confidence` never defer; `mode: score` only adds the `pacing` score term and
`mode: off` makes it neutral. Pacing never refuses a request or fails a run, and it never creates a run, a probe or a
provider call to use up a subscription: it only delays or redirects work you submitted.

The design is in [LLD §16.9](../design/LLD.md#169-usage-windows-and-pacing-fr-cap-09-fr-cap-10),
[LLD §17.7](../design/LLD.md#177-model-groups-fr-rte-10-fr-rte-11) and
[ADR-0055](../adr/0055-model-groups-and-usage-pacing.md). Every default is an Assumption (ROADMAP Q-98, Q-99).

### How commits reach Git

Agents are not given a way to commit or push: Git writes are denied where the provider documents a rule (Claude
Code; Codex documents none), and Switchboard compares the repository's refs before and after each run and records any
change as a `git_policy_violation`. Commits are made by the controller, on the host, in one of three ways, into a
publish ref `refs/heads/switchboard/pub/<session>` that is kept apart from the run branches and checkpoint commits.
This applies to runs started with `delegate_task`'s `project`.

| Path | Who commits | Offered by |
| --- | --- | --- |
| The agent's `commit` tool | The controller, for the paths the agent names, through the stdio `switchboard tool-shim` the adapter gives the agent | The fake test adapter. Claude Code only behind the bypass-only opt-in `providers.claude-code.git_channel` and only in an approved `privileged` bypass run. Not Codex |
| Finalize-only commit | The controller, at the end of a successful run, from the run's changed files and the agent's summary | Any adapter without the tool, when the project's primary context sets `finalize_commit` (see below) |
| No commit | Nobody; the work stays in the run's worktree, diff and checkpoint | The default for those adapters |

Every commit uses the context's `identity`, passes the same sanitiser (attribution trailers, footers and session links
removed, plus your `git.sanitize_patterns`) and is recorded with its provenance (run, provider, model); see `runs show`.
Nothing leaves the host unless the context's push policy is `branch` (the default is `none`); the push never forces and
its `remote` is a remote name, never a URL (details below). With `"sign": true` the controller signs each published
commit with your own Git signing configuration; only GnuPG with a throwaway key has been tried. Approved bypass runs
are exempt from the push credential rule and from the finalize-only size limits (owner decisions 37 and 44).

### Connect a remote MCP client with OAuth

A remote MCP client (a hosted connector, for example) connects to `serve` over Streamable HTTP and signs in with OAuth
2.1. Switchboard has its own OAuth provider built in: there is no external authorization server to set up, and the
one-time code comes from the CLI. This is *Proposed* until ROADMAP T13.12 is Done
([ADR-0085](../adr/0085-cli-issued-one-time-codes-for-mcp-oauth.md)); the commands below are the design.

Prerequisites: `transport.http` is enabled with a `public_url` behind your TLS proxy (see the `transport` row of the
[configuration table](getting-started.md#configure)), and the MCP client profile you will offer exists in
`mcp_clients`. Only a profile that is allowed over HTTP works: not `privileged_approval: not_required`, unless you set
`transport.http.allow_unattended_privileged: true` (ADR-0091), in which case that profile's privileged runs over HTTP
run without `switchboard approve` (`doctor` warns). A
profile with a `privileged` ceiling is allowed, as with a `clients` mapping, and its privileged runs still wait for your
approval ([ADR-0086](../adr/0086-bound-codes-follow-the-mapped-rule.md)); `default_mcp_client` still refuses a
`privileged` ceiling.

1. On the host running Switchboard, issue a code for the profile. The code is printed once, works once and expires
   after 10 minutes unless you pass `--ttl` (1 to 60 minutes). Issuing a new code ends every older unused code.

   ```text
   switchboard mcp oauth issue-code --client-profile orchestrator --ttl 15m
   ```

2. In the remote client, add the connector with your public URL (`https://<public_url>`). The client finds the
   authorization server by itself and sends your browser to the Switchboard consent page.
3. Paste the code into the consent page's pairing-code field. The client is approved and bound to that profile, so it
   gets that profile's trust ceiling and approval rules and nothing more. A configured `transport.http.clients` entry
   still takes precedence over a binding; `default_mcp_client` is used only when there is neither.
4. To see who is connected, run `switchboard mcp oauth clients` (or `client <client_id>`, `tokens`); an orchestrator on
   stdio can call `list_oauth_clients`. None of them shows a token.
5. To cut a client off, run `switchboard mcp oauth revoke <client_id>` (add `--tokens-only` to end its tokens and keep
   the client). The client can also revoke its own token at the `revocation_endpoint` (RFC 7009).

The passphrase and `switchboard consent pair` still work; a pairing code from `consent pair` approves a client without
binding it to a profile. Wrong codes and passphrases are locked out per client address (10 wrong in 5 minutes locks
that address for 15 minutes). If a reverse proxy sits in front of Switchboard, set `transport.http.client_ip_header`
(for example `cf-connecting-ip`) so the lockout sees the real address; the header is trusted only when the request
arrives from loopback. Static bearer tokens kept in a gate you run in front of Switchboard keep working; that gate
should forward the OAuth endpoints and OAuth-authenticated `/mcp` traffic to Switchboard.

### Command reference

Every top-level `switchboard` command, with its purpose, key options and a link to the section that describes it
(`node scripts/check-docs.mjs` checks that this table names every command in `src/cli/main.ts`). `--config <path>`
and `--json` work with every command except `serve` (which rejects `--json`: stdout carries MCP framing only). The
subsections below give the full behaviour; `switchboard --help` prints the same list.

| Command | Purpose | Key options | Details |
| --- | --- | --- | --- |
| `serve --client <id>` | Run the MCP server on stdin/stdout for one configured MCP client (logs go to stderr) | `--client` (required), `--config` | [Run as an MCP server](#run-as-an-mcp-server) |
| `doctor` | Check Node, Git, config, data directory, ledger, retention, disk and host load, then probe each adapter | `--json`, `--config` | [Check the setup with `doctor`](getting-started.md#check-the-setup-with-doctor) |
| `runs list`, `runs show <id>`, `runs cancel <id>` | List runs newest first, show one run and its events, request cancellation | `--state`, `--limit`, `--json` | [Operator commands](advanced-features.md#operator-commands) |
| `capacity [--provider <id>]` | Per-provider capacity projection: the same data as the `get_capacity` MCP tool (read-only); `--provider copilot` shows only the usage-only Copilot quota | `--provider`, `--json` | [Capacity, retries and failover](#capacity-retries-and-failover) |
| `affinity list`, `affinity reset <project_key>` | Show each project's provider affinity; make the next routing step choose afresh | `--json` | [Routing and affinity](#routing-and-affinity) |
| `index status`, `index rebuild`, `index clear` | Retrieval index state per store; request a rebuild; delete a store's vectors | project/global argument, `--json` | [Retrieval index](advanced-features.md#retrieval-index-milestone-12) |
| `eval run <suite> --provider <id> [--live-budget <file>]`, `eval results <suite>` | Own-repository evaluation: replay a suite as runs, grade network-off with hidden tests, record `eval_result` (skipped in CI; real providers need a live budget) | `--provider`, `--live-budget` (`run` only), `--json` | [docs/operations/evaluation.md](../operations/evaluation.md) |
| `gc [--apply] [--dry-run]` | Retention clean-up: dry run by default; `--apply` collects (refused while `serve` runs or without `retention.days`) | `--apply`, `--dry-run`, `--json` | [Operator commands](advanced-features.md#operator-commands) |
| `projects sources list`, `projects sources approve <id>`, `projects sources reject <id>` | List, approve or reject the repository-owner requests of `request_project_source` (ADR-0087); an approved owner joins `project_sources.allowed_owners` at once, without a restart | none | [Submodules](#umbrella-projects-with-git-submodules) |
| `projects list`, `projects show <id>`, `projects validate [<id>]`, `projects approve <id>` | List and inspect configured and dynamic projects, check them, approve or reject a pending dynamic revision | `--revision`, `--reject`, `--json` | [Dynamic projects](#dynamic-projects) |
| `git push <id>` | Push a meta-session's published commits to the context's configured remote branch (never forced; refused while `serve` runs) | `--json` | [How commits reach Git](#how-commits-reach-git) |
| `git ack-secret-scan <gps_id>` | Acknowledge a push the secret scan refused: clears `secret_scan_blocked` until the next refusal; never allows the push (works while `serve` runs) | `--json` | [LLD §20.9](../design/LLD.md#209-pre-push-secret-scan-fr-git-11-t914-adr-0061) |
| `adapters validate <provider>`, `adapters version-canary` | Accept the installed version of a provider CLI (runs one real read-only smoke call); flag CLI upgrades for re-validation | `--json` | [Operator commands](advanced-features.md#operator-commands) |
| `inner status`, `inner test <task>`, `inner resume <task>` | Inner-agent state (read-only), one synthetic fixture through the backend, re-enable a suspended task | `--json` | [Operator commands](advanced-features.md#operator-commands) |
| `approve <run_id>` | Approve the `privileged` run waiting for approval (review it with `runs show` first) | `--json` | [Operator commands](advanced-features.md#operator-commands) |
| `deny <run_id>` | Deny the waiting `privileged` run; it ends `CANCELLED` | `--json` | [Operator commands](advanced-features.md#operator-commands) |
| `pause` | Pause every project: no new run is admitted until resume (an MCP client can pause only its own projects) | `--json` | [Control plane](advanced-features.md#control-plane-milestone-14) |
| `resume` | Lift the operator pause set by `pause` (a project paused by an MCP client stays paused) | `--json` | [Control plane](advanced-features.md#control-plane-milestone-14) |
| `consent hash-passphrase`, `consent pair` | Hash the HTTP consent-page passphrase for config; print a one-time pairing code (Switchboard's own secrets, never a provider sign-in) | `--json` | [ROADMAP §6.10](../ROADMAP.md#610-m13-network-mcp-transport-tasks) |
| `mcp oauth issue-code --client-profile <mcp_client_id> [--ttl <n>s\|m\|h]` | Print a single-use code (default 10 minutes, 1 to 60) that approves a remote OAuth client on the consent page and binds it to that MCP client profile; issuing a code ends older unused ones; a profile with `privileged_approval: not_required` is refused (a `privileged` ceiling is allowed; its runs still need approval, ADR-0086) | `--client-profile` (required), `--ttl`, `--json` | [Connect a remote MCP client with OAuth](#connect-a-remote-mcp-client-with-oauth) |
| `mcp oauth clients`, `mcp oauth client <client_id>`, `mcp oauth tokens [--client <id>] [--all]`, `mcp oauth revoke <client_id> [--tokens-only]` | List and inspect OAuth clients and their tokens (never token values), and revoke a client's tokens or the client itself | `--client`, `--all`, `--tokens-only`, `--json` | [Connect a remote MCP client with OAuth](#connect-a-remote-mcp-client-with-oauth) |
| `schedule list`, `schedule show <id>`, `schedule enable <id>`, `schedule disable <id>`, `schedule approve <id>`, `schedule deny <id>`, `schedule create <cron> <project> <template_json>` | List, inspect, enable, disable, approve, reject and create UTC cron schedules (off by default) | `--project` (list), `--json` | [ROADMAP §6.14](../ROADMAP.md#614-m15-project-queue-schedules-and-ci-triggers-tasks) |
| `decisions list`, `decisions decide <dec_id> --option <n>` | List decision requests with their (untrusted) question and options; decide one as the operator: its work item resumes or is cancelled and its enqueue list is added once; deciding twice is refused | `--project`, `--state` (list), `--option`, `--note` (decide), `--json` | [LLD §20.3](../design/LLD.md#203-decision-requests-fr-ctl-13-t1415) |
| `skills list`, `skills show <name>[@n]`, `skills add <name>`, `skills approve <name>@<n>`, `skills revoke <name>@<n>`, `skills retire <name>`, `skills unretire <name>`, `skills diff <name>@<a> <name>@<b>` | Skill store: list, inspect, validate and store a version, approve, revoke, retire and diff | `--all`, `--body`, `--file`, `--from-repository`, `--note`, `--json` | [Switchboard-controlled skills](advanced-features.md#switchboard-controlled-skills-milestone-16) |

### Operator commands

```text
switchboard runs list [--state <STATE>] [--limit <n>]
switchboard runs show <id>
switchboard runs cancel <id>
switchboard capacity [--provider <id>]
switchboard affinity list
switchboard affinity reset <project_key>
switchboard approve <run_id>
switchboard deny <run_id>
switchboard pause
switchboard resume
switchboard consent hash-passphrase
switchboard consent pair
switchboard mcp oauth issue-code --client-profile <mcp_client_id> [--ttl <n>s|m|h]
switchboard mcp oauth clients
switchboard mcp oauth client <client_id>
switchboard mcp oauth tokens [--client <id>] [--all]
switchboard mcp oauth revoke <client_id> [--tokens-only]
switchboard schedule list [--project <id>]
switchboard schedule show <sch_id>
switchboard schedule enable <sch_id>
switchboard schedule disable <sch_id>
switchboard schedule approve <sch_id>
switchboard schedule deny <sch_id>
switchboard schedule create <cron> <project> <template_json>
switchboard skills list [--all]
switchboard skills show <name>[@n] [--body]
switchboard skills add <name> --file <path> [--from-repository] [--note <text>]
switchboard skills approve <name>@<n> [--note <text>]
switchboard skills revoke <name>@<n> [--note <text>]
switchboard skills retire <name> / skills unretire <name>
switchboard skills diff <name>@<a> <name>@<b>
switchboard gc [--apply] [--dry-run]
switchboard git push <session_or_run_id>
switchboard projects list
switchboard projects show <id>
switchboard projects validate [<id>]
switchboard projects approve <id> [--revision <n>] [--reject]
switchboard projects sources list
switchboard projects sources approve <id>
switchboard projects sources reject <id>
switchboard adapters validate <provider>
switchboard adapters version-canary
switchboard inner status
switchboard inner test <task>
switchboard inner resume <task>
switchboard index status [<project>|global]
switchboard index rebuild [<project>|global]
switchboard index clear [<project>|global]
```

`runs cancel`, `approve` and `deny` write a request that a running `serve` applies; with no `serve` running they apply
it themselves. `approve` and `deny` act only on a `privileged` run waiting for approval (review its scope with
`runs show` first); `deny` ends the run cancelled, and a second decision is refused. Add `--json` to any of these for
machine-readable output. Every command documents itself: `switchboard <command> --help` (or `switchboard help
<command>`) prints that command's usage, options and one example. Exit codes: 0 success, 1 failure (including a
refused decision), 2 usage error, 65 skills add refused.

`affinity list` shows the provider each project is kept on (the project id, or `ws:` and a hash of the workspace path),
the model its last run reported, since when and why it last switched. `affinity reset <project_key>` makes the next
routing step for that project choose again among the eligible providers, recorded as `user_request`; the first run
that then succeeds consumes the reset. Resetting a project with no affinity exits 1 and writes nothing.

`adapters validate <provider>` (`claude`, `codex`, `cursor`, or the config id such as `claude-code`) accepts the
version of a provider CLI that is installed now. It runs the adapter's probe, its auth preflight and a conformance
subset that ends
with a structured-output smoke test, and **that smoke step makes one real provider call** (a trivial read-only prompt in
a throwaway repository; it may use your subscription quota). It never logs in: if the CLI is not logged in (`AUTH_REQUIRED`)
or its login state cannot be determined (`UNKNOWN`) it fails, and you log in natively and run it again. It passes no
bypass flag under `inspect-untrusted`. Grok Build, Cursor, Kimi Code, OpenCode and Antigravity compile nothing under
`inspect-untrusted`, so for those five only (owner decisions 59 and 60) the same smoke task runs in the adapter's only
compiled cell instead: an approved `privileged` bypass scope, approved in memory for that one call and never recorded,
with exactly the one bypass flag that cell declares (`--always-approve`, `--force`, `--prompt` or
`--dangerously-skip-permissions`; `--auto` for OpenCode, ADR-0077); the
step output and the evidence line name that cell and its ruling, and `--json` reports it as `smoke_profile`. If the
smoke step fails, the step reports the run's classified failure code and its classifier detail (`CODE (exit code N):
detail`), redacted with the ledger's secret patterns with e-mail addresses and URL query strings stripped, clipped to
one line and never raw stderr or stdout, and `--json` adds `failure_code` and `failure_detail` to the smoke step. Only
when everything passes does it edit the provider's manifest file in your source checkout
(`src/adapters/manifests/<provider>.json`): `validated_cli_version`, `validated_on`, `validated_version_range` (the same
minor series, for example `>=2.1.296 <2.2.0`; an assumption, not a provider statement) and a dated evidence sentence
appended to `notes`. It does not commit: review the diff and commit the manifest change yourself, then rebuild and
restart `serve`. On any failure it writes nothing and exits 1. It needs a clone of the repository (an installed package
has no source tree to edit), and `--json` prints each step's result.

`git push` publishes the commits a meta-session made through the injected `commit` tool: it pushes the session's
publish ref (`switchboard/pub/<session>`) to the context's `push.remote` as the branch `<push.branch_prefix><session>`.
It works only when the context sets `"push": { "policy": "branch", "remote": "<remote name>", "branch_prefix": "..." }`
(the default policy `none` refuses with a message naming it). It never force-pushes (a non-fast-forward is refused by
Git and reported), never pushes the default or a checked-out branch, run branches, checkpoint commits, tags or notes,
and refuses a meta-session that has a recorded Git policy violation. It uses your own Git setup (SSH agent, credential
helper) for that one `git push`, without hooks or prompts; it refuses a remote whose URL embeds credentials or uses a
transport other than `https`, `ssh` or `file`, and a repository whose own configuration sets a credential helper,
`core.sshCommand` or `insteadOf` (move those to your global configuration). Like `gc --apply`, it refuses while
`serve` is running. Every attempt, accepted or refused, is recorded and shown by `runs show`, which also lists each
published commit's provenance (SHA, tree, patch ID, project, context, session, run, provider, model, adapter version,
sanitiser counts) and where it was pushed, never the message or a URL. Exit 0 when the remote branch holds the commits,
1 otherwise.

Agents get a `push` tool only for a context with policy `branch` and only when the run cannot read your push
credentials (FRD BR-31): a profile with no shell or an empty shell allowlist. Host runs with a shell are not offered
`push`; use `git push` above (or a container environment, once milestone 10 exists). An approved bypass run is the
exception (owner decision 37): it is offered `push` whatever its shell, and the run record shows `bypass_exempt`. That is
the one place a bypass run's agent can reach your push credentials, by your choice; Switchboard still never hands them
to it, and its Git-write denial is unchanged.

Providers that cannot receive the injected `commit` tool (Codex, and Claude Code except in an approved bypass run with
the bypass-only `providers.claude-code.git_channel`) still run write-capable tasks; by default their work stays in the
run's worktree, diff and checkpoint, with no commit. To have Switchboard commit it, set `"finalize_commit": true` on the
project's primary context, next to its `identity`:

```json
{ "id": "main", "kind": "repository", "path": "/home/you/projects/web", "base_ref": "main",
  "identity": { "name": "Your Name", "email": "you@example.com" }, "finalize_commit": true }
```

When such a run succeeds, Switchboard makes one commit of the run's changed files on the session's publish ref, with
your identity and the agent's final summary as the message after the same sanitiser as the `commit` tool (attribution
trailers, footers and session links removed). It makes no commit for a failed or cancelled run, after a recorded Git
policy violation in the session, when the summary is missing or empty after sanitising, when it is over 8192 characters
or more than 256 files changed (an approved bypass run is not limited on either: it commits all files and a truncated
message with a note), or when a path is refused; `runs show` gives the reason. The commit is recorded like any
other (`via finalize` in `runs show`) and leaves the host only through Switchboard's own push (the `git push` command
above, or a `push` tool offered to a later run), under the context's push policy. Approved bypass runs are treated
the same apart from those two size limits.

`projects list|show|validate` read the `projects` section of the config (see below) and the filesystem only: no
ledger, no lock, no provider process. `validate` checks every project (or the one named): the config rules, that each repository
path is absolute, resolves under an allowed root (so `..` and symlink escapes fail) and is a Git repository, and that
`base_ref` exists. It prints each failure with its config path and exits 1 if any check fails. A `container` project is
also checked for a rootless runtime, a present image and no `git`/`gh` on the image `PATH` (milestone 10). `delegate_task`
with `project` runs in the project's primary repository context, starting from its `base_ref`
(or the fetched remote tip when the primary context sets `base_remote`;
[LLD §5.2](../design/LLD.md#52-base-refresh-fr-prj-02-note-adr-0067)); a `container` project
without composed placement is refused before anything is written. A meta-session stays in the project it
was created in, and runs and meta-sessions record the project in the ledger (schema version 2).
`projects list|show` also show dynamic projects from the ledger (read-only), with `source` `config` or `dynamic`, the
client that created them, the latest revision and its state, the revision in force and what a pending revision needs
approval for.

#### Dynamic projects

A client whose entry sets `"manage_projects": true` can define its own projects with `create_project`, change them with
`update_project` (each call writes a new revision) and remove them with `delete_project`. Such a project uses the same
shape and the same checks as a configured one: the repository must be a Git repository under an allowed root (never
inside `data_dir`), and `base_ref` must exist. Its trust ceiling, providers and push policy cannot exceed the client's
own (`max_trust_profile`, the providers you have not disabled, `max_push_policy`). A client cannot touch your configured
projects, or another client's: only the creator sees and uses a dynamic project, and an id that is already configured
is refused. Every call, accepted or refused, is recorded in the ledger.

A revision with a `container` environment, a push policy other than `none`, a commit `identity`, `sign: true`, a new or
changed `setup` step (`project_setup`, ADR-0071), writable submodules (`submodule_write`), `merge_policy.checks:
"all_reported"` (`merge_checks`, ADR-0087), or a wider trust ceiling or provider set than the revision in force is
stored as `PENDING_APPROVAL` and cannot start runs
until you approve it; until then the previous revision stays in force. Review it with `switchboard projects show <id>`,
then run `switchboard projects approve <id>` (add `--revision <n>` once the project has more than one revision, and
`--reject` to refuse it). Over MCP, only a client the operator marked `approval_proxy` may decide through
`decide_approval` (FR-CTL-08), limited to the kinds in `approval_proxy_kinds`. With `project_sources` configured,
a project's repository can be a `clone_url` that the server clones for you, so the whole onboarding runs over MCP
(ADR-0068). `approve` works while `serve` runs. Deleting a project
is refused while one of its runs is still going; its history stays. By design a push from a dynamic project
is refused (`CONTEXT_UNKNOWN`) even after approval (owner decision 62; Q-46 answered). Approved `container`
dynamic projects can run when `serve` composes placement (milestone 10,
[PR #554](https://github.com/zemdregon/switchboard/pull/554)); operator in-volume login (T10.0) is Done since
2026-10-18; the container backend does not mount a login volume yet.

### Umbrella projects with Git submodules

An umbrella repository whose submodules you want agents to edit can be onboarded, run, published and merged over MCP
only (ADR-0087, [LLD §3.4.17](../design/LLD.md#3417-submodule-projects-adr-0087)). Set `submodules` on the primary
context (see [Configuration](getting-started.md)); read the result back with `list_projects`. If a submodule belongs
to an owner that `project_sources` does not list, the orchestrator calls `request_project_source`; you (or an approver
client whose `approval_proxy_kinds` includes `project_source`) decide it, and the owner is allowed at once on hosts
you already allow (a grant never adds a host). Then `publish_run` pushes each changed submodule to its own repository,
never forced and never to its default branch, and opens linked pull requests; `merge_run_pr` merges them in order and
re-points the umbrella. Repositories without branch protection need `merge_policy.checks: "all_reported"`.

`gc` is the retention clean-up. By default it is a dry run: it lists the idle meta-sessions older than
`retention.days` (all their runs finished, no lease) and any orphans, and changes nothing. `gc --apply` removes each
listed session's worktrees, `switchboard/<session>/` branches and artifact files and marks the session archived; the
run events stay as the audit record. It refuses to apply unless `retention.days` is set in the config, and while a
`serve` is running (stop it first; a dry run is always allowed). When `retention.days` is set, `serve` also runs this
pass at startup and then every `retention.interval`. `doctor` shows the same dry-run summary and the orphan sweep
(worktree directories or `switchboard/*` branches with no ledger row). `gc --apply` and the `serve` pass also remove
orphans, but never on first sight: the first pass marks each one and a later pass removes it once it has been marked
for `retention.days`. Only `switchboard/` branches and directories under the data directory's `worktrees/` are removed.

**Inner agent.** `inner status` (read-only; it never contacts the backend) shows the state (`off`, `no_backend` or
`ready`), the backend's origin and locality, and per task the call counts by outcome, the fallback rate and the
rejection rate over the quality window; add `--json` for the same data. `inner test <task>` sends one built-in synthetic
fixture through the real pipeline (the same privacy gates, redaction, validation and `inner_call` record) and prints
the outcome, never the prompt or the reply; it sends no repository data, and it exits 1 when the result would fall back,
or when nothing was sent because the agent or the task is off. A task whose rejection rate exceeds the configured
threshold is suspended and falls back until you run `inner resume <task>` (quality counting then restarts). That
T11.6 behaviour is pinned on a scripted fake backend in `src/inner/suspension.test.ts` (merged
[PR #586](https://github.com/zemdregon/switchboard/pull/586)): the suspension survives a restart, applies per task,
keeps falling back with a good backend until re-enabled, and the re-enable is recorded and restarts the window. Neither
command prints a base URL's userinfo, a header, a key or any prompt or response text.

Which tasks run today (2026-10-18): two tasks are wired into production `serve` run paths — the commit-message task
(the optional `message` on the `commit` tool offered to the provider CLI in the run's worktree) and routing
classification (T11.11, **Done on fakes**; `serve` admission, continuation and quota failover through
`RunLifecycleOptions.classifyRouteFeatures`). Features are stored with source, model and template version and never
change eligibility or `require_provider` (Q-82); when the inner agent is off, the task is disabled, a project is `off`,
or the backend is unavailable, dispatch records the heuristic classifier. The PR-draft, verification-summary, run-title
and handoff-condensation (T11.10, **Done on fakes**) tasks exist as service functions, tested on fakes; neither `serve`
nor any `inner` command calls them on a run path (`inner test` exercises the pipeline with its built-in synthetic
fixture only). That is by design for now: the LLD names no run-path call site for any of the four, and
`src/inner/run-path-reach.test.ts` fails if one gains a production caller without the documents changing with it.
The `inner status|test|resume` commands are CLI-only and never touch run data: with a populated run ledger and no
shared-subscription declaration, those diagnostics leave every non-inner table unchanged and do not link inner calls
to the run (`src/inner/cli-run-isolation.test.ts`). With `shares_subscription_with`, a backend request
also records labelled usage with no run link. Merged fake-backend evidence for usage accounting
([PR #334](https://github.com/zemdregon/switchboard/pull/334),
[PR #338](https://github.com/zemdregon/switchboard/pull/338) and
[PR #343](https://github.com/zemdregon/switchboard/pull/343)): the injected commit-message task and routing hook that
`serve` wires write one labelled observation per backend request with a shared subscription and none without
(`src/inner/usage.test.ts`); `get_capacity` (filtered and unfiltered, over an in-process transport and over
authenticated Streamable HTTP),
`switchboard capacity --json` and the `doctor --json` capacity object are byte-identical before and after those
contracts, `inner test` and accepted, rejected and unavailable calls, with and without a shared subscription
(`src/inner/usage-surfaces.test.ts`); over the same Streamable HTTP session `get_run` is byte-identical too (without
`include_events`, and the envelope with it around exactly three `inner_call` events carrying no token figure), and a
second HTTP session opened after the calls, which gets its own server instance, reads the same `get_capacity` and
`get_run` bytes, so the equality is a property of the ledger rather than of one session's memory (merged
[#407](https://github.com/zemdregon/switchboard/pull/407)); and the estimator reads `provider_reported` rows only, so
the projection is unchanged whether the shared subscription names the provider under test, another provider or none,
and so is the provider-reported cache block of `switchboard capacity` (T6.7) even when a labelled or planted
`inner_agent` row carries the cache key names it reads
(`src/capacity/capacity.test.ts`). Merged [#362](https://github.com/zemdregon/switchboard/pull/362) additionally pins
T11.5 surfaces on fakes: a suspended task (T11.6; the suspension gate itself is pinned in
`src/inner/suspension.test.ts`, merged [#586](https://github.com/zemdregon/switchboard/pull/586)) and a project set
to `off` deny without a request and write no
observation; a re-ask that hits the deadline keeps the first attempt's token counts; the shared-subscription label
follows `shares_subscription_with` (not the run's provider); `doctor` asserts the full `inner_shared_subscription`
check in human and `--json` output before and after `inner test`; with `enabled: false` and the flag set, `inner test`
sends nothing and capacity and the whole `doctor --json` document stay byte-identical; and the capacity collector
ignores `inner_agent` rows by `source` alone even when metric keys resemble provider usage (`usage.test.ts`,
`usage-surfaces.test.ts`, `capacity.test.ts`). Those tests call the injected contracts directly; the production `commit`
tool channel (over its Unix socket) and all three `serve` call sites of the routing hook (admission through
`delegate_task`, continuation through `continue_task` and, merged
[#396](https://github.com/zemdregon/switchboard/pull/396), the quota failover) are driven with the same inner usage
checks in `src/inner/usage-channels.test.ts`, on fakes. Admission and continuation classify before their run exists,
so those `inner_call` rows and any labelled observations carry no run id. The quota failover (the T6.6 ladder)
classifies under the run that just failed on quota, after it is terminal, and is the one `serve`-path classification
that carries a run id: with `shares_subscription_with` it writes one labelled row under that failed run (the shared
provider as label, the backend's counts), whether the label names the exhausted provider, the successor or a spare,
and none without; the successor lands on the same provider under every label, because labelled rows never reach the
scorer (ADR-0007); neither run's envelope reports the row and the ledger's per-run list shows it under the failed run
only; the failed run's event list gains one `inner_call` event with no token figure beside its `quota_ladder` event
and the successor's gains none; and `get_capacity` counts provider-reported rows only for the exhausted provider and
the successor, keeps a spare that never ran byte-identical (its clock aside) even when it is the label, and names the
inner agent nowhere. The same three call sites are pinned for provenance and fallback in
`src/mcp/inner-route-features.test.ts`: the failover is classified only after eligibility and without changing the
chosen provider; a required provider that fails eligibility is never classified; a disabled task, an invalid, erroring
or hung backend, or a throwing injected classifier keeps `heuristic.v1`; `explain_route` and replay read the stored
row without a backend call; and a replayed `delegate_task` with the same idempotency key does not classify again. The
human `runs show` text prints its usage section from provider-reported rows only and names nothing about the inner
agent even with a planted labelled row (`src/inner/usage-surfaces.test.ts`). The ledger's public usage insert refuses
an `inner_agent` row with its FR-CAP-01 message and writes nothing, and no production module other than
`src/ledger/repo.ts` writes the table in any SQLite spelling (`INSERT`, `INSERT OR <conflict>`, `REPLACE`), so the
pipeline's own record under `shares_subscription_with` is the only writer of labelled rows
(`src/inner/usage.test.ts`). The same file pins that the table's append-only triggers refuse `UPDATE`, `DELETE` and a
relabelling `INSERT OR REPLACE` alike: SQLite's `REPLACE` conflict resolution deletes the colliding row, and the ledger
opens with `recursive_triggers` on so that delete fires the guard (Q-96 in the roadmap, answered;
`src/ledger/ledger.test.ts` pins the same refusal on `run_event`). The scan stays as the sole-writer pin for every
spelling. The
statements above about what `inner status`, `inner test`, `inner resume` and the `doctor` block print (states, the
circuit line, rates, the canary verdict, the origin-only backend line, the resume notice) are pinned on the command
output in `src/inner/cli-doctor-surfaces.test.ts`; the `no_backend` state is reachable from an on-disk config only
through the `cli` kind, because the config refuses `enabled: true` without a backend. No hosted or live backend has
been exercised: every test uses a scripted fake or a local fake server. The per-task test and module
evidence behind these statements, and the list of what is not built, is in
[HLD §2.5](../design/HLD.md#25-comp-inn-implementation-evidence-m11-t111t1113-done-on-fakes),
[SDD §4.3](../design/SDD.md#43-comp-inn-implementation-evidence-m11-t111t1113-done-on-fakes) and the
[TDD §3.12](../design/TDD.md#312-inner-agent) as-built note
([PR #353](https://github.com/zemdregon/switchboard/pull/353)).
