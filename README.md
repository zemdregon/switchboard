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

What works today: `doctor`, `runs list|show|cancel`, and `serve` exposing six MCP tools over stdio, with two trust
profiles (`inspect-untrusted`, `edit-untrusted`). Read [Known limitations](#known-limitations) before relying on it.

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
- Git 2.30.0 or newer (`MIN_GIT_VERSION` in `src/workspace/git.ts`). `doctor` checks both.
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
| `mcp_clients` | yes | Entries `{ "id", "max_trust_profile" }`. `id` matches `^[a-z0-9][a-z0-9_-]{0,63}$` and must be unique. `serve --client <id>` binds a session to one entry. |
| `data_dir` | no | Where the ledger, artifacts and worktrees live. Default `$XDG_DATA_HOME/switchboard` (`~/.local/share/switchboard`). |
| `limits.global_concurrency` | no | Integer 1 to 64. Default 4. |
| `limits.per_provider_concurrency` | no | Integer 1 to 64. Default 1. |
| `providers.<id>.enabled` | no | Boolean. A provider you do not list is enabled. |
| `providers.<id>.weight` | no | Number from 0 to 1. Accepted by the schema. |

`<id>` is one of `claude-code`, `codex`, `grok-build`, `antigravity`, `cursor`, `opencode`, `kimi-code`. Only
`claude-code` and `codex` have adapters in this stage. `max_trust_profile` accepts any of the five profile names, but
see [Trust profiles](#trust-profiles).

## Check the setup with `doctor`

```sh
switchboard doctor            # add --json for machine-readable output
switchboard doctor --config /path/to/config.json
```

`doctor` checks Node, Git, the config, the data directory, the ledger and the data-directory lock, then probes each
adapter (Claude Code, Codex and a fake test adapter that is not a real provider). It exits 0 when no check failed and 1
otherwise. Markers:

| Marker | Meaning |
| --- | --- |
| `[ok]` | Check passed. |
| `[warn]` | Not fatal, exit stays 0. For a provider: CLI not installed, or installed but not logged in or auth unknown. For the ledger: not created yet (`serve` creates it) or an older schema that `serve` migrates. For the lock: a stale lock file. |
| `[FAIL]` | Exit code 1. For a provider: the probe failed, or the version gate rejected the installed version. |
| `[skip]` | Skipped because the config is not valid. |

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
| `delegate_task` | Starts a coding task in a new meta-session; returns a `run_id` at once (optional `wait_seconds`, 0 to 60, waits without cancelling). |
| `continue_task` | Resumes an idle meta-session on the same provider with a new instruction. |
| `get_run` | Returns a run's status, failure code, provider, summary, changed-file count and artifact ids, optionally with events. |
| `cancel_run` | Requests cancellation of a run (asynchronous; poll `get_run`). |
| `get_artifacts` | Lists a run's artifacts (diff, changed files, test report, ...) with hashes; small ones inline. |
| `list_capabilities` | Lists providers with adapter status, version, validated range, auth state and supported trust profiles. |

Tool schemas are published through MCP `tools/list`.

### Operator commands

```text
switchboard runs list [--state <STATE>] [--limit <n>]
switchboard runs show <id>
switchboard runs cancel <id>
```

`runs cancel` writes a request that a running `serve` applies. Add `--json` to any of these for machine-readable output.
Exit codes: 0 success, 1 failure, 2 usage error.

## Trust profiles

A trust profile says what a delegated agent may do ([ADR-0004](docs/adr/0004-trust-profiles-no-bypass-flags.md)). Each
adapter compiles the profile into the provider's own permission and sandbox controls.

| Profile | Available now | Effect in this version |
| --- | --- | --- |
| `inspect-untrusted` | yes | Read-only file access, no shell, network off, repository-provided config disabled. |
| `edit-untrusted` | yes | Edits inside an isolated Git worktree, network off, repository config disabled. The shell allowlist is empty, so no shell command is allowed. |
| `test-sandboxed`, `trusted-development` | no | Rejected with `ELIGIBILITY_NONE`. |
| `privileged` | never granted | Rejected with `PERMISSION_BLOCKED`; it needs per-run operator approval, which this version does not provide. |

A request above the client's `max_trust_profile` also fails `PERMISSION_BLOCKED`. Non-empty
`verification_commands` are refused with `INVALID_REQUEST` until verification lands in milestone 3.

## Security model

- **No credential handling.** Switchboard never reads, copies, logs or exports provider credentials, and does not start
  logins. Probe commands (`doctor`, version and auth checks) run with only `PATH` and `HOME` in their environment.
- **Worktrees.** Edits happen in an isolated Git worktree under the data directory, never directly in your checkout, and
  only for paths under `allowed_roots`.
- **Untrusted profiles by default.** Both available profiles keep the network off and disable repository-provided
  configuration.
- **No bypass flags.** Switchboard does not pass flags such as `--dangerously-skip-permissions`, `--yolo`, `--force` or
  `--full-auto` to provider CLIs, and tests audit this.
- **Fail closed.** An invalid config, an unknown client id, an unverified CLI version or an unavailable profile refuses
  to run rather than weakening anything.

This is a summary of design intent and the implemented checks, not a security guarantee. The isolation has not yet been
tested against malicious repositories (milestone 3). Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Known limitations

- **Codex is unverified.** The Codex compliance manifest has an intentionally empty version range, so every Codex binary
  fails the version gate (see Troubleshooting, ROADMAP Q-8). Codex login and status commands are assumptions.
- **Event shapes are unverified until the live smoke test passes.** The adapters were written against recorded or
  synthetic fixtures. Provider output formats, flags and the exact meaning of status commands may differ on a real CLI.
- Linux only. Single operator only. No hosted or multi-user mode.
- Only Claude Code and Codex, only `inspect-untrusted` and `edit-untrusted`, and `continue_task` only on the same
  provider.
- No `adapters validate` or approval commands yet; they are scheduled for later milestones.

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
| `ADAPTER_VERSION_UNVERIFIED` | `doctor` (`[FAIL]`, exit 1); `list_capabilities` | The installed CLI version is outside the range recorded in the adapter's compliance manifest, so the adapter is ineligible. For Codex the range is deliberately empty (`<0.0.0`) because no Codex version has been verified on the development host (ROADMAP Q-8): **an installed Codex always fails `doctor` today**. Do not edit manifests to force a pass; the `adapters validate` command that would record a version does not exist yet. Use Claude Code, or set `providers.codex.enabled` to `false` (this stops dispatch to Codex; `doctor` still probes it). |
| `ELIGIBILITY_NONE` | MCP error or failed run | No provider can take the task: none enabled, installed, version-verified and logged in for that profile; the profile is unavailable (`test-sandboxed`, `trusted-development`); or the queue or concurrency limit was hit. Run `doctor` and `list_capabilities` to see why. |
| `ELIGIBILITY_NONE` with `details.reason = "QUEUE_FULL"` | MCP error | Switchboard reports a full waiting queue under `ELIGIBILITY_NONE` (a proposed mapping, ROADMAP Q-5). Wait for runs to finish or cancel some, then retry. |
| `PERMISSION_BLOCKED` | MCP error or failed run | The requested `trust_profile` is above the client's `max_trust_profile`, is `privileged`, or the provider denied an operation. Request a lower profile or re-delegate within what is allowed. |
| `another switchboard serve (pid N) already holds the data directory` | `serve` stderr, exit 1 | Another `serve` uses this `data_dir`. Stop it, or point the second one at a different `data_dir`. A stale lock from a dead process is replaced automatically. |
| `unknown MCP client "x"; configured clients: ...` | `serve` stderr, exit 1 | `--client` does not match any `mcp_clients` id in the config. |
| `Invalid config ...` or `Cannot read config file ...` | `doctor`, `serve` | The message lists each problem with its JSON path. Fix the file; unknown keys are errors. A path in `allowed_roots` that does not exist is also an error. |
| Git or Node `[FAIL]` | `doctor` | Install Node 22 or newer, or Git 2.30.0 or newer. |

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
