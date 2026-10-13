# Switchboard

Switchboard is a headless controller that lets one orchestrating agent delegate coding work to AI coding CLIs
(Claude Code and Codex in this stage) through their documented automation surfaces, behind a single MCP tool surface.
It runs on your own machine and reuses the logins you already made with those CLIs. Switchboard itself never handles
provider credentials.

## Status

Pre-release. The package is private and is not published to any registry; you build it from source.

- **Milestone 1 (foundation) is done**: run ledger, workspaces, run lifecycle, reconciliation and the operator CLI
  (`doctor`, `runs`). See [ROADMAP §6](docs/ROADMAP.md#6-milestones) for the evidence.
- **Milestone 2 (Claude Code and Codex adapters plus the MCP slice) is in progress.** The Claude Code and Codex
  adapters, the MCP server and `switchboard serve` exist and pass their tests on recorded or synthetic fixtures and a
  fake provider. They have **not** been confirmed against a live provider yet.
- Providers other than Claude Code and Codex are not implemented.

What works today: `doctor`, `runs list|show|cancel`, `gc`, and `serve` exposing seven MCP tools over stdio (ten for a
client with `manage_projects`), with two trust profiles (`inspect-untrusted`, `edit-untrusted`). Read
[Known limitations](#known-limitations) before relying on it.

## Single operator, your own accounts

Switchboard is designed for **one operator on one machine**, using that operator's own provider logins
([ADR-0011](docs/adr/0011-single-operator-local-deployment.md), [ADR-0003](docs/adr/0003-no-credential-handling.md)).
It is not a hosted service, not multi-user, and must not be used to share a login between people.

Switchboard drives the CLIs through the headless interfaces they document. That is a technical statement, not a legal
one. **This project does not claim that any use of it complies with any provider's terms of service.** Whether your use
is allowed under the terms of Anthropic, OpenAI or any other provider is your responsibility; read their current terms.
Commercial, resale, multi-user or credential-sharing use needs your own policy review first.

## Requirements

- Linux. Other operating systems are not supported yet.
- Node.js 22 or newer (`engines` in `package.json`).
- Git 2.32.0 or newer (`MIN_GIT_VERSION` in `src/workspace/git.ts`). `doctor` checks both.
- For real work, at least one provider CLI installed and logged in natively: Claude Code and/or Codex. `doctor` does not
  require any particular one.

## Install from source

```sh
git clone <this repository> switchboard
cd switchboard
npm ci && npm run build
node dist/cli/bin.js --help
```

The commands below write `switchboard` for `node /path/to/switchboard/dist/cli/bin.js`. Replace it with the absolute
path of your checkout; an orchestrator launching `serve` needs the absolute path too. Switchboard is not published to
npm, so there is no `npm install switchboard`.

## Log in to the providers (natively)

Switchboard has no `login` command and never starts a login, reads token files or exports credentials. You log in with
each provider's own CLI, and Switchboard asks that CLI whether it is logged in.

| Provider | Login step the adapter reports | Status of that step |
| --- | --- | --- |
| Claude Code | `claude auth login` (the adapter returns `AUTH_REQUIRED` naming it) | Taken from the adapter; check Anthropic's documentation |
| Codex | `codex login` (the adapter calls it "believed to be", unverified) | **Unverified**; check OpenAI's documentation for the current login step |

Do not copy credential files between machines or users. Do not put API keys or tokens in the Switchboard config; it has
no place for them and rejects unknown keys.

## Configure

Switchboard reads one JSON file. The path is, in order: `--config <path>`, the `SWITCHBOARD_CONFIG` environment
variable, then `$XDG_CONFIG_HOME/switchboard/config.json` (default `~/.config/switchboard/config.json`). Unknown keys,
wrong types or a missing `schema_version` stop startup.

Minimal example:

```json
{
  "schema_version": 1,
  "allowed_roots": ["/home/you/projects"],
  "mcp_clients": [{ "id": "orchestrator", "max_trust_profile": "edit-untrusted" }]
}
```

Keys (from `src/config/schema.ts`; no other keys exist yet):

| Key | Required | Meaning |
| --- | --- | --- |
| `schema_version` | yes | Must be `1`. |
| `allowed_roots` | yes | Non-empty list of directories. A task's `workspace_path` must be under one of them. Each must exist. Relative paths resolve against the config file's directory. |
| `mcp_clients` | yes | Entries `{ "id", "max_trust_profile", "privileged_approval"?, "projects"? }`. `id` matches `^[a-z0-9][a-z0-9_-]{0,63}$` and must be unique. `serve --client <id>` binds a session to one entry. |
| `mcp_clients[].projects` | no | Ids of the configured `projects` this client may use with `delegate_task`'s `project` input and see in `list_projects`. An id that names no project stops startup. A client without the list can use no project (workspace paths still work). |
| `mcp_clients[].manage_projects` | no | `true` gives this client the `create_project`, `update_project` and `delete_project` tools for its own *dynamic projects* (see [Dynamic projects](#dynamic-projects)). Default `false`: the tools do not exist for it. |
| `mcp_clients[].max_push_policy` | no | `"none"` (default) or `"branch"`: the widest push policy a dynamic project of this client may declare. Only with `manage_projects: true`. A push-enabled project still waits for `projects approve`. |
| `mcp_clients[].privileged_approval` | no | `"required"` (default) or `"not_required"`. With `not_required`, that client's `privileged` requests run without `switchboard approve` (see [Trust profiles](#trust-profiles)). Allowed only when the client's `max_trust_profile` is `privileged`; `doctor` warns for every client that sets it. |
| `data_dir` | no | Where the ledger, artifacts and worktrees live. Default `$XDG_DATA_HOME/switchboard` (`~/.local/share/switchboard`). |
| `limits.global_concurrency` | no | Integer 1 to 64. Default 4. |
| `limits.per_provider_concurrency` | no | Integer 1 to 64. Default 1. |
| `providers.<id>.enabled` | no | Boolean. A provider you do not list is enabled. |
| `providers.<id>.weight` | no | Number from 0 to 1. Accepted by the schema. |
| `retention.days`, `retention.interval` | no | How long idle meta-sessions are kept (integer days, default 30) and how often `serve` runs the clean-up pass (`30m`, `12h`, `7d`; default `24h`). **Nothing is deleted unless you set `retention.days`**; the default only applies once you do (or to `gc` dry runs). |
| `projects` | no | List of `{ "id", "name", "environment"?, "contexts": [...] , "max_trust_profile"?, "allowed_providers"? }`. `id` matches `^[a-z][a-z0-9-]{1,40}$` and is unique. `environment` is `{ "kind": "host" }` (default) or a `container` shape that `projects validate` rejects until M10. Each context is `{ "id", "kind": "repository", "path", "base_ref", "primary"?, "writable"?, "push"?, "identity"?, "sign"? }` with an absolute `path` under an allowed root; exactly one context is primary. Unknown keys and context kinds stop startup. `push.remote` must be the name of a remote in the repository (not a URL), and `push.branch_prefix` a branch-name prefix such as `"switchboard/"`. `max_trust_profile` and `allowed_providers` apply to `delegate_task` with a `project`: the effective trust ceiling is the lower of the client's and the project's, and routing is limited to the listed providers (a request naming another provider with `require_provider` fails `PERMISSION_BLOCKED`); `sign` is accepted but not enforced yet. Full shape: LLD section 11.1. |
| `profiles.<name>` | no | Overrides for `inspect-untrusted`, `edit-untrusted`, `test-sandboxed` or `trusted-development`: `file_access`, `shell`, `shell_allowlist`, `network`, `network_allowlist`, `repo_config`. They may tighten or loosen a default; `doctor` lists them and every run records them. `privileged` has none. See the `edit-untrusted` limit under [Trust profiles](#trust-profiles). |

`<id>` is one of `claude-code`, `codex`, `grok-build`, `antigravity`, `cursor`, `opencode`, `kimi-code`. Only
`claude-code` and `codex` have adapters in this stage. `max_trust_profile` accepts any of the five profile names, but
see [Trust profiles](#trust-profiles).

## Check the setup with `doctor`

```sh
switchboard doctor            # add --json for machine-readable output
switchboard doctor --config /path/to/config.json
```

`doctor` checks Node, Git, the config, the data directory, the ledger and the data-directory lock, reports what
retention would collect and any orphans (read-only), then probes each
adapter (Claude Code, Codex and a fake test adapter that is not a real provider). It exits 0 when no check failed and 1
otherwise. Markers:

| Marker | Meaning |
| --- | --- |
| `[ok]` | Check passed. |
| `[warn]` | Not fatal, exit stays 0. For a provider: CLI not installed, or installed but not logged in or auth unknown. For the ledger: not created yet (`serve` creates it) or an older schema that `serve` migrates. For the lock: a stale lock file. |
| `[FAIL]` | Exit code 1. For a provider: the probe failed, or the version gate rejected the installed version. |
| `[skip]` | Skipped: because the config is not valid, or (for a provider) because `providers.<id>.enabled` is `false`. Skips never change the exit code. |

Per adapter, the auth state is `OK`, `AUTH_REQUIRED` (doctor prints the native login command to run) or `UNKNOWN`
(Switchboard could not tell; the reason is printed). `UNKNOWN` is expected for Codex until its status handling is
verified (see [Troubleshooting](#troubleshooting)).

A machine with no Claude Code or Codex installed gets `[warn]` for both and still exits 0. That proves only that the
environment and config are sound, not that a provider works.

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

| Tool | What it does |
| --- | --- |
| `delegate_task` | Starts a coding task in a new meta-session; returns a `run_id` at once (optional `wait_seconds`, 0 to 60, waits without cancelling). Give exactly one of `workspace_path` and `project` (see `list_projects`). |
| `continue_task` | Resumes an idle meta-session on the same provider with a new instruction. |
| `get_run` | Returns a run's status, failure code, provider, summary, changed-file count and artifact ids, optionally with events. |
| `cancel_run` | Requests cancellation of a run (asynchronous; poll `get_run`). |
| `get_artifacts` | Lists a run's artifacts (diff, changed files, test report, ...) with hashes; small ones inline. |
| `list_capabilities` | Lists providers with adapter status, version, validated range, auth state and supported trust profiles. |
| `list_projects` | Lists the configured projects this client may use (id, name, environment kind, contexts, trust ceiling, allowed providers), plus its own dynamic projects marked `source: "dynamic"` with their revision and status. Read-only; returns no filesystem paths. |
| `create_project`, `update_project`, `delete_project` | Only for a client with `manage_projects`. Create, revise or delete a dynamic project this client owns. See [Dynamic projects](#dynamic-projects). |

Tool schemas are published through MCP `tools/list`.

### Operator commands

```text
switchboard runs list [--state <STATE>] [--limit <n>]
switchboard runs show <id>
switchboard runs cancel <id>
switchboard approve <run_id>
switchboard deny <run_id>
switchboard gc [--apply]
switchboard git push <session_or_run_id>
switchboard projects list
switchboard projects show <id>
switchboard projects validate [<id>]
switchboard projects approve <id> [--revision <n>] [--reject]
```

`runs cancel`, `approve` and `deny` write a request that a running `serve` applies; with no `serve` running they apply
it themselves. `approve` and `deny` act only on a `privileged` run waiting for approval (review its scope with
`runs show` first); `deny` ends the run cancelled, and a second decision is refused. Add `--json` to any of these for
machine-readable output. Exit codes: 0 success, 1 failure (including a refused decision), 2 usage error.

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

`projects list|show|validate` read the `projects` section of the config (see below) and the filesystem only: no
ledger, no lock, no provider process. `validate` checks every project (or the one named): the config rules, that each repository
path is absolute, resolves under an allowed root (so `..` and symlink escapes fail) and is a Git repository, and that
`base_ref` exists. It prints each failure with its config path and exits 1 if any check fails. Only `host` environments
work in this stage: a `container` project is listed but fails `validate` with "container environments are not
implemented yet (M10)". `delegate_task` with `project` runs in the project's primary repository context, starting
from its `base_ref`; a `container` project is refused before anything is written. A meta-session stays in the project it
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

A revision with a `container` environment, a push policy other than `none`, a commit `identity`, `sign: true`, or a
wider trust ceiling or provider set than the revision in force is stored as `PENDING_APPROVAL` and cannot start runs
until you approve it; until then the previous revision stays in force. Review it with `switchboard projects show <id>`,
then run `switchboard projects approve <id>` (add `--revision <n>` once the project has more than one revision, and
`--reject` to refuse it). There is no way to approve over MCP. `approve` works while `serve` runs. Deleting a project
is refused while one of its runs is still going; its history stays. Not yet: pushing from a dynamic project (a push is
refused even after approval) and container environments (milestone 10).

`gc` is the retention clean-up. By default it is a dry run: it lists the idle meta-sessions older than
`retention.days` (all their runs finished, no lease) and any orphans, and changes nothing. `gc --apply` removes each
listed session's worktrees, `switchboard/<session>/` branches and artifact files and marks the session archived; the
run events stay as the audit record. It refuses to apply unless `retention.days` is set in the config, and while a
`serve` is running (stop it first; a dry run is always allowed). When `retention.days` is set, `serve` also runs this
pass at startup and then every `retention.interval`. `doctor` shows the same dry-run summary and the orphan sweep
(worktree directories or `switchboard/*` branches with no ledger row); orphans are reported, never removed.

## Trust profiles

A trust profile says what a delegated agent may do ([ADR-0004](docs/adr/0004-trust-profiles-no-bypass-flags.md)). Each
adapter compiles the profile into the provider's own permission and sandbox controls.

| Profile | Available now | Effect in this version |
| --- | --- | --- |
| `inspect-untrusted` | yes | Read-only file access, network off, repository-provided config disabled. Claude Code gets no shell. Codex runs commands inside its read-only native sandbox (see below). |
| `edit-untrusted` | yes | Edits inside an isolated Git worktree, network off, repository config disabled. Claude Code gets no shell, because the shell allowlist is empty. Codex runs commands inside its `workspace-write` native sandbox (see below). |
| `test-sandboxed`, `trusted-development` | per provider | Each adapter compiles what it can express and refuses the rest with `ELIGIBILITY_NONE`; `list_capabilities` shows which profiles each provider supports on this host. |
| `privileged` | yes, per provider | Above the client's `max_trust_profile`: `PERMISSION_BLOCKED`. Otherwise the run waits for `switchboard approve` or `deny` (or, for a client with `privileged_approval: "not_required"`, starts at once). An approved run is compiled by its provider's adapter from the approved scope; a provider that cannot express the scope fails the run `ELIGIBILITY_NONE` before any process starts. |

A request above the client's `max_trust_profile` also fails `PERMISSION_BLOCKED`. Non-empty
`verification_commands` are refused with `INVALID_REQUEST` until verification lands in milestone 3.

**Codex and the shell.** Codex has no command allowlist that Switchboard can set, so under both untrusted profiles the
Codex agent can run shell commands inside Codex's own sandbox. Whether that sandbox keeps those commands away from
Codex's credential store (`~/.codex`) and other files your user can read has **not been verified**. If you delegate
untrusted repositories, prefer Claude Code, or set `providers.codex.enabled` to `false`, until the live check planned
for milestone 3 settles it (ROADMAP R-23).

**Profile overrides.** `profiles.<name>` in the config may loosen a profile's defaults, but only explicitly, with the
change recorded in every run's policy snapshot and reported by `doctor`. **Known limit:** a `profiles.edit-untrusted`
override that loosens `network` or `repo_config` is not enforced. Claude Code still runs `edit-untrusted` with the
network off (at the tool level) and repository configuration disabled, whatever the override says; Codex refuses such a
run (`ELIGIBILITY_NONE`). Use `trusted-development` or a `privileged` scope for that work (ROADMAP owner decision 20).

**Privileged runs.** A `privileged` request carries a machine-readable `privileged_scope` (file access, shell commands,
network hosts and repository configuration, plus a `bypass` setting that defaults to off) and waits for
`switchboard approve <run_id>`. A provider bypass flag such as `--dangerously-skip-permissions` is passed only when the
approved scope explicitly sets `bypass` ([ADR-0017](docs/adr/0017-approved-privileged-scope-bypass.md)). For Claude
Code an approved bypass run drops `--restricted`, which refuses bypass, and keeps the other isolation flags
([ADR-0018](docs/adr/0018-claude-bypass-omits-restricted.md)); whether Claude's Git deny rules still hold under bypass
is not verified yet (ROADMAP R-38). That gap concerns agents running on your host. Container environments, planned
for milestone 10 and not available yet, are meant to close it: their image has no Git client, they mount neither the
repository's Git directory nor any credentials, and Switchboard makes commits and pushes on the host through its own
tools (ROADMAP owner decision 24). Host-run agents remain supported. Claude Code compiles a privileged scope only with
the network `on`: it has no network control for commands, so a scope asking for network `off` is refused. Codex does
not run `bypass: true` scopes yet (its bypass option is not documented in the sources the adapter relies on), and
neither provider compiles every scope: `list_capabilities` shows whether a provider compiles `privileged` at all, and a
scope it cannot express fails `ELIGIBILITY_NONE`. Approvals never expire: once approved, later `continue_task` runs of
the same meta-session reuse the approved scope without asking again, so approve only scopes you are content to leave
open for that session. A different scope or a new task asks again.

**Skipping the approval for a client you trust.** The loose modes are meant for operators who want them; the defaults
stay strict for everyone else. Setting `"privileged_approval": "not_required"` on an `mcp_clients` entry whose
`max_trust_profile` is `privileged` lifts the per-scope approval for that client only: its `privileged` requests are
validated, hashed and recorded as usual, then start at once under an approval recorded as decided by
`client_policy:<client id>` ([ADR-0019](docs/adr/0019-per-client-privileged-approval.md)). Git-write denial and the
run's isolated worktree still apply. Anything that can launch that client's `serve --client` session can then run
privileged work, including bypass scopes, without you reviewing it (ROADMAP R-39), so use it only for an orchestrator
you control. `approve` and `deny` keep working for clients left at `"required"`.

## Security model

- **No credential handling.** Switchboard never reads, copies, logs or exports provider credentials, and does not start
  logins. Probe commands (`doctor`, version and auth checks) run with only `PATH` and `HOME` in their environment.
- **Worktrees.** Edits happen in an isolated Git worktree under the data directory, never directly in your checkout, and
  only for paths under `allowed_roots`.
- **Untrusted profiles by default.** Both available profiles keep the network off and disable repository-provided
  configuration.
- **No bypass flags.** Switchboard does not pass flags such as `--dangerously-skip-permissions`, `--yolo`, `--force` or
  `--full-auto` to provider CLIs, and tests audit this. The one exception is an approved `privileged` scope that
  explicitly sets `bypass` (approved by you, or by a client's `privileged_approval: "not_required"`; see Trust
  profiles).
- **Pushes only through Switchboard's own tool or command.** Agents cannot push; a push-enabled context (off by default)
  pushes one branch, never forced, from the controller with your Git setup, and never hands a credential to an agent.
- **Fail closed.** An invalid config, an unknown client id, an unverified CLI version or an unavailable profile refuses
  to run rather than weakening anything.

This is a summary of design intent and the implemented checks, not a security guarantee. The isolation has not yet been
tested against malicious repositories (milestone 3). Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Known limitations

- **Codex is unverified.** The Codex compliance manifest has an intentionally empty version range, so every Codex binary
  fails the version gate (see Troubleshooting, ROADMAP Q-12). Codex login and status commands are assumptions.
- **Event shapes are unverified until the live smoke test passes.** The adapters were written against recorded or
  synthetic fixtures. Provider output formats, flags and the exact meaning of status commands may differ on a real CLI.
- Linux only. Single operator only. No hosted or multi-user mode.
- Only Claude Code and Codex; profiles beyond `inspect-untrusted` and `edit-untrusted` only where the adapter can
  compile them (see `list_capabilities`); `continue_task` only on the same provider.
- No `adapters validate` command yet; it is scheduled for milestone 4.

### Optional live smoke test

With a provider CLI installed and logged in natively, you can run one real task against it. It is opt-in and skipped
unless you set the variables; `npm test` and CI never run it.

```sh
SWITCHBOARD_LIVE_TESTS=1 SWITCHBOARD_LIVE_PROVIDER=claude npm run test:live   # or codex
```

It builds, creates a throwaway Git repository and data directory under the system temp directory, runs one
`edit-untrusted` task, and prints which adapter assumptions held, failed or were not checked. Details are in
[TDD §3.6](docs/design/TDD.md#36-testing-strategy). With the current manifests, expect Codex to be refused at the
version gate.

## Troubleshooting

| Code or message | Where you see it | Meaning and what to do |
| --- | --- | --- |
| `AUTH_REQUIRED` | `doctor` adapter line (`[warn]`, "AUTH_REQUIRED, run natively"); a failed run | The provider CLI reports you are not logged in. Run the native login it prints (Claude Code: `claude auth login`; Codex: `codex login`, unverified, check the provider's documentation), then run `doctor` again. |
| auth `UNKNOWN` | `doctor` adapter line | Switchboard could not determine login state; the reason is printed. Check the CLI runs on its own. For Codex this is expected until its status handling is verified. |
| `not installed: ... CLI not found` | `doctor` (`[warn]`) | The provider binary is not on `PATH`. Install it, or ignore it if you do not use that provider. |
| `ADAPTER_VERSION_UNVERIFIED` | `doctor` (`[FAIL]`, exit 1); `list_capabilities` | The installed CLI version is outside the range recorded in the adapter's compliance manifest, so the adapter is ineligible. For Codex the range is deliberately empty (`<0.0.0`) because no Codex version has been verified on the development host (ROADMAP Q-12): **an installed Codex always fails `doctor` today**. Do not edit manifests to force a pass; the `adapters validate` command that would record a version does not exist yet. Use Claude Code, or set `providers.codex.enabled` to `false` (this stops dispatch to Codex, and `doctor` then reports it as `[skip]` and does not probe it). |
| `ELIGIBILITY_NONE` | MCP error or failed run | No provider can take the task: none enabled, installed, version-verified and logged in for that profile; no provider can compile the profile or the approved `privileged` scope; or the queue or concurrency limit was hit. Run `doctor` and `list_capabilities` to see why. |
| `ELIGIBILITY_NONE` with `details.reason = "QUEUE_FULL"` | MCP error | Switchboard reports a full waiting queue under `ELIGIBILITY_NONE` (a proposed mapping, ROADMAP Q-5). Wait for runs to finish or cancel some, then retry. |
| `PERMISSION_BLOCKED` | MCP error or failed run | The requested `trust_profile` is above the client's `max_trust_profile`, a `privileged` run's approval check failed before start (for example a changed scope), or the provider denied an operation. Request a lower profile or re-delegate within what is allowed. |
| `another switchboard serve (pid N) already holds the data directory` | `serve` stderr, exit 1 | Another `serve` uses this `data_dir`. Stop it, or point the second one at a different `data_dir`. A stale lock from a dead process is replaced automatically. |
| `unknown MCP client "x"; configured clients: ...` | `serve` stderr, exit 1 | `--client` does not match any `mcp_clients` id in the config. |
| `Invalid config ...` or `Cannot read config file ...` | `doctor`, `serve` | The message lists each problem with its JSON path. Fix the file; unknown keys are errors. A path in `allowed_roots` that does not exist is also an error. |
| Git or Node `[FAIL]` | `doctor` | Install Node 22 or newer, or Git 2.32.0 or newer. |

## Repository documents

| Path | What it is |
| --- | --- |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | The canonical plan: scope, milestones, status. Start here. |
| [`AGENTS.md`](AGENTS.md) | Instructions for AI coding agents working in this repository (`CLAUDE.md` imports it). |
| [`docs/requirements/`](docs/requirements/) | Business, product and functional requirements, and the SRS. |
| [`docs/design/`](docs/design/) | High-level, software, technical and low-level design. |
| [`docs/adr/`](docs/adr/README.md) | Architecture decision records. |
| [`docs/research/`](docs/research/) | Research inputs, dated October 2026; provider CLI details may change. |
| `LICENSE` | Apache License 2.0. |

## Contributing

Contribution steps and conventions are in [CONTRIBUTING.md](CONTRIBUTING.md). Run `node scripts/check-docs.mjs` after
documentation changes, and `npm test` for code. To report a security concern, see [SECURITY.md](SECURITY.md).
