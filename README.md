# Switchboard

![Switchboard logo](assets/switchboard-logo.png)

Switchboard is a headless controller that lets one orchestrating agent delegate coding work to AI coding CLIs
(Claude Code and Codex in this stage) through their documented automation surfaces, behind a single MCP tool surface.
It runs on your own machine and reuses the logins you already made with those CLIs. Switchboard itself never handles
provider credentials.

## Status

Pre-release. The package is private and is not published to any registry; you build it from source.

- **Milestone 1 (foundation) is done**: run ledger, workspaces, run lifecycle, reconciliation and the operator CLI
  (`doctor`, `runs`). See [ROADMAP §6](docs/ROADMAP.md#6-milestones) for the evidence.
- **Milestone 2 (Claude Code and Codex adapters plus the MCP slice) is `Partial`.** The Claude Code and Codex
  adapters, the MCP server and `switchboard serve` exist and pass their tests on recorded or synthetic fixtures and a
  fake provider. The 2026-10-13 operator-machine live checks
  ([`docs/research/live-checks-2026-10-13.md`](docs/research/live-checks-2026-10-13.md)) ran the real Claude Code
  2.1.296 (14 of 16 checks held; two need a failing run) and codex-cli 0.162.1 (flag assumptions held; Codex has not
  run through Switchboard). The opt-in `npm run test:live` smoke test has not been run by the operator personally. See
  [ROADMAP §6.2](docs/ROADMAP.md#62-m2-claude-code-adapter-and-mcp-slice-tasks).
- **Milestone 3 (isolation) is `Partial`.** Approvals, privileged runs and retention are implemented; the live
  malicious-fixture checks are not. See [ROADMAP §6](docs/ROADMAP.md#6-milestones) for each task.
- **Milestone 9 (projects and controlled commits) is `Partial`.** Projects, the agent `commit` tool, finalize-only
  commits, ref snapshots, push, dynamic projects, signing and concurrent-run worktrees are implemented and tested for
  `host` environments on a fake provider with real Git in temporary repositories. It is not `Done`: nothing has run
  against a live provider through Switchboard's own tool channel, signing was tried only with a throwaway GnuPG key,
  pushing from dynamic projects is not wired, and container environments need milestone 10. The exceptions are listed
  in [ROADMAP §6.3](docs/ROADMAP.md#63-m9-projects-and-controlled-commits-tasks) (task T9.8).
- **Milestone 5 (continuity) is `Partial`.** `continue_task` resumes the provider's native session or hands off to
  another provider from a bundle built from Switchboard's own records, and `get_artifacts` and `runs show` show the
  handoff. It is tested on two fake providers, including a check that the controller opens no provider state directory.
  It is not `Done`: no run of a real Claude Code and Codex pair has been made (the opt-in `npm run test:live:pair`
  script exists and has not been run), and resume for the providers of milestone 4 is not built. See
  [ROADMAP §6.9](docs/ROADMAP.md#69-m5-continuity-tasks).
- **Milestone 6 (capacity and resilience) is `Partial`.** `get_capacity` and `switchboard capacity` show per-provider
  estimates with their sources, a circuit breaker holds a failing provider back, retryable failures are retried
  automatically as linked successor runs, and quota exhaustion fails over to another provider or returns. All of this
  is tested on fake providers. It is not `Done`: what Claude Code and Codex print on a real rate limit or quota stop has
  not been captured (operator task T6.11), and no provider is known to publish an enforceable rate limit, so there is no
  rate gate. See [ROADMAP §6.11](docs/ROADMAP.md#611-m6-capacity-and-resilience-tasks).
- **Milestone 7 (routing) is `Partial`.** Eligible providers are scored from Switchboard's own records, every route
  decision is stored and replays exactly, `explain_route` shows why a run went where it did, a project stays on its
  provider until a listed reason moves it (`switchboard affinity list|reset`), and `minimum_capability` is enforced
  against operator-declared model capabilities in the model registry (`src/routing/minimum-capability.test.ts`). All
  of this is tested on fake providers. It is not `Done`: the cache-friendly prompt order is not built (ROADMAP T7.9,
  Could) and real-provider model flags wait for adapter work. See [Routing and affinity](#routing-and-affinity) and
  [ROADMAP §6.12](docs/ROADMAP.md#612-m7-routing-tasks).
- **Milestone 11 (inner agent) is `Partial`.** An optional HTTP backend, privacy gates, `doctor` and `inner` reporting,
  and commit-message drafting on fakes are on main; most run-path hooks, PR drafting and a live backend are not. See
  [ROADMAP §6.6](docs/ROADMAP.md#66-m11-inner-agent-tasks).
- **Milestone 12 (retrieval index) is `Partial`.** Tasks T12.0 to T12.7 are done on fakes: the spike, `rag`
  configuration and per-project store, the scanner through chunker, the embedding port (fake and `http` backends
  behind the locality gates), incremental background indexing in `serve`, `switchboard index status|rebuild|clear`
  and a `doctor` section, an untrusted context pack at admission that never changes the stored request or the
  run's outcome, the read-only MCP tool `search_project_context`, and optional global sharing (`rag.global`,
  `contribute_to_global`, `use_global`, all off by default). Agent-callable search (T12.9) and an opt-in live
  embedding backend are not `Done`. See [Retrieval index](#retrieval-index-milestone-12),
  [ROADMAP §6.7](docs/ROADMAP.md#67-m12-retrieval-index-tasks) and the merged requirements and design evidence in
  [SRS §3.15](docs/requirements/SRS.md#implementation-evidence-partial-m12),
  [PRD CAP-13](docs/requirements/PRD.md#implementation-evidence-partial-m12--cap-13),
  [HLD §2.1](docs/design/HLD.md#21-comp-rag-implementation-evidence-m12-t121t123),
  [LLD §14](docs/design/LLD.md#14-retrieval-index) and [TDD §3.13](docs/design/TDD.md#313-retrieval-index).
- **Milestone 13 (network MCP transport) is done.** `serve` can expose the MCP tools over Streamable HTTP with OAuth
  2.1 (an embedded authorization server with an operator consent page, PKCE, client registration that the operator
  approves, audience-bound opaque tokens). It is off by default and binds to loopback; put your own TLS proxy in
  front of it. A test runs the whole path from client registration and PKCE to a tool call. Residual risks are listed
  under [HLD TB-12](docs/design/HLD.md#3-trust-boundaries). See
  [ROADMAP §6.10](docs/ROADMAP.md#610-m13-network-mcp-transport-tasks).
- **Milestone 4 (adapter expansion) is `Partial`.** Shared registry, conformance plumbing, `adapters validate`, the ACP
  client and a macOS CI leg are done; Grok Build, Antigravity, Cursor and OpenCode each have a module, compile matrix
  and parser work on synthetic fixtures. Grok Build has module, compile-matrix, parser (partial), auth-preflight,
  conformance suite (T4.25), malicious-fixture leg (partial: `replayGap`, T4.26) and Git declaration fixture tests
  on synthetic fixtures (README [Grok Build CLI](#grok-build-cli-milestone-4), ROADMAP T4.22 to T4.27); live smoke,
  live malicious leg and `adapters validate` remain operator work (T4.28). Antigravity has a
  conformance suite (partial: native resume, T4.35), a malicious-fixture leg (partial: live shapes and FR-POL-04, T4.36)
  and a Git declaration on synthetic fixtures (README [Antigravity CLI](#antigravity-cli-milestone-4), ROADMAP T4.35 to
  T4.37); live smoke, live malicious leg and `adapters validate` for Antigravity remain operator work (T4.38). Cursor
  has conformance and malicious-fixture legs and a Git declaration on
  recorded fixtures (README [Cursor CLI](#cursor-cli-milestone-4), ROADMAP T4.45 to T4.47); live smoke, live malicious
  leg and `adapters validate` for Cursor remain operator work (T4.48). OpenCode has a conformance suite and Git
  declaration on synthetic fixtures and a malicious-fixture leg that is still partial (README
  [OpenCode CLI](#opencode-cli-milestone-4), ROADMAP T4.55 to T4.57); live smoke, live malicious leg and
  `adapters validate` for OpenCode remain operator work (T4.58). Other M4 providers are still catching up on those
  legs. Manifests still admit no version until `switchboard adapters validate` passes a real CLI (operator tasks).
  Outside an approved `privileged` bypass scope every profile is ineligible for the new providers. See
  [ROADMAP §6.8](docs/ROADMAP.md#68-m4-adapter-expansion-tasks).

What works today: `doctor`, `runs list|show|cancel`, `approve`, `deny`, `gc`, `capacity`, `affinity list|reset`,
`index status|rebuild|clear`, `projects list|show|validate|approve`, `git push`, `inner status|test|resume`, and
`serve` exposing nine MCP tools over stdio (ten when retrieval is on for at least one of the client's projects,
thirteen with `manage_projects`). The five trust
profile names exist; which of them a provider can run is listed in [Trust profiles](#trust-profiles) and by
`list_capabilities`. Read
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

- Linux. Other operating systems are not supported yet. macOS process handling (process tree and PID-reuse guard
  through `ps`) runs in a macOS CI leg (typecheck, lint, tests and docs check on a GitHub-hosted runner), and no trust
  profile is eligible on macOS.
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
| Codex | `codex login`; status is read with `codex login status` (exit code 0 logged in, 1 not) | `codex login status` observed on codex-cli 0.162.1 (`docs/research/live-checks-2026-10-13.md`); output format undocumented, so only the exit code is used; check OpenAI's documentation for the login step |
| Grok Build | `grok login` (the adapter returns `AUTH_REQUIRED` naming it; the CLI's own error text also names `grok login --device-code`) | Auth preflight runs `grok models` and keys on the first stdout line (`You are logged in with grok.com.` vs `You are not authenticated.`; exit 0 in both states on the 2026-10-14 live check, `grok 1.0.50`; [`docs/research/live-checks-2026-10-14-grok.md`](docs/research/live-checks-2026-10-14-grok.md)); check xAI's documentation for the login step |
| Antigravity | Launch **`agy`** without arguments (the adapter returns `AUTH_REQUIRED` naming `agy`; the CLI's stderr also says to launch without arguments to sign in) | Auth preflight runs `agy models` and keys on exit code and stderr (`<slug>\t<name>` lines at exit 0 vs `Error: Please sign in` at exit 1 on the 2026-10-14 live check, `agy` 1.3.4; [`docs/research/live-checks-2026-10-14-antigravity.md`](docs/research/live-checks-2026-10-14-antigravity.md)); check Google's Antigravity documentation for the login step |
| Cursor CLI | `cursor-agent login` (the adapter returns `AUTH_REQUIRED` naming it) | Auth preflight runs `cursor-agent status --format json` and keys on `isAuthenticated` (exit 0 both logged in and logged out on the 2026-10-14 live check; [`docs/research/live-checks-2026-10-14-cursor.md`](docs/research/live-checks-2026-10-14-cursor.md)); check Cursor's documentation for the login step |
| OpenCode | `opencode auth login` (the adapter returns `AUTH_REQUIRED` naming it) | Auth preflight runs `opencode auth list --format json --standalone` and treats any non-environment connection type as logged in (exit 0 in every state on the 2026-10-14 live check, `opencode v2.0.23`; [`docs/research/live-checks-2026-10-14-opencode.md`](docs/research/live-checks-2026-10-14-opencode.md)); check OpenCode's documentation for the login step |

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

Keys (from `src/config/schema.ts`; the `projects` key is described below the table):

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
| `providers.claude-code.git_channel` | no | Boolean, default `false`. **Unsupported, for testing only:** gives Claude Code the injected `commit` (and `push`) tool through a Switchboard-written `--mcp-config` file in the run's private directory, **only in an approved `privileged` run whose scope sets `bypass`**. Such a run then omits `--safe-mode` (it stops the tool server from starting), so the repository's `CLAUDE.md` and hooks load in it. Every other run is unaffected and can use `finalize_commit`. It has not been run end to end with the real `claude` (ROADMAP T9.4b); `serve` logs a warning when it is on. Only `claude-code` accepts the key. |
| `retention.days`, `retention.interval` | no | How long idle meta-sessions are kept (integer days, default 30) and how often `serve` runs the clean-up pass (`30m`, `12h`, `7d`; default `24h`). **Nothing is deleted unless you set `retention.days`**; the default only applies once you do (or to `gc` dry runs). |
| `projects` | no | List of `{ "id", "name", "environment"?, "contexts": [...] , "max_trust_profile"?, "allowed_providers"? }`. `id` matches `^[a-z][a-z0-9-]{1,40}$` and is unique. `environment` is `{ "kind": "host" }` (default) or a `container` shape that `projects validate` rejects until M10. Each context is `{ "id", "kind": "repository", "path", "base_ref", "primary"?, "writable"?, "push"?, "identity"?, "sign"?, "finalize_commit"? }` with an absolute `path` under an allowed root; exactly one context is primary. Unknown keys and context kinds stop startup. `push.remote` must be the name of a remote in the repository (not a URL), and `push.branch_prefix` a branch-name prefix such as `"switchboard/"`. `max_trust_profile` and `allowed_providers` apply to `delegate_task` with a `project`: the effective trust ceiling is the lower of the client's and the project's, and routing is limited to the listed providers (a request naming another provider with `require_provider` fails `PERMISSION_BLOCKED`); `sign` (default `false`; needs `identity`, primary writable context only) makes the controller sign each published commit with the operator's own global Git signing configuration; a signing failure, a repository whose own configuration sets `gpg.*` or `user.signingkey`, or a run whose agent could reach the key (the `push` rule) returns `SIGNING_FAILED` and commits nothing; `projects validate` makes a test signature. Only GnuPG has been tried, with a throwaway key; SSH, X.509, passphrase-protected and hardware keys are untested. `finalize_commit` (default `false`; needs `identity`, primary writable context only) turns on finalize-only commits, described below. Full shape: LLD section 11.1. |
| `routing` | no | `{ "weights"?: { "success", "latency", "capacity", "security", "handoff", "cost" }, "affinity"?: { "enabled", "low_water_mark", "min_confidence", "idle_ttl" } }`. Each weight 0 to 100, default 1; all 0 means configured order. `affinity.enabled` defaults to `true`; `low_water_mark` and `min_confidence` (0 to 1) are set together or both left `null` (the default, which leaves the estimate trigger off); `idle_ttl` accepts only `null` (no expiry). Unknown keys stop startup. See [Routing and affinity](#routing-and-affinity) and LLD section 17.1. |
| `timeouts.preflight_ttl_seconds` | no | Integer 0 to 3600. How long a successful adapter preflight is cached (default 60); 0 disables the cache. |
| `git.sanitize_patterns` | no | Up to 16 extra regular-expression sources (200 characters each, restricted subset in `src/git/safe-pattern.ts`). A commit-message line that matches one is removed, in addition to the built-in attribution rules. |
| `inner_agent` | no | The optional inner agent (ADR-0016): a cheap or self-hosted model for small tasks. Off unless you write the section and set `enabled: true`; there is no default backend, model or task, and no key, token or header field (a hosted service goes through a gateway you run). Shape: `{ "enabled", "backend": { "kind": "http", "base_url", "model", "timeout_ms"?, "max_concurrency"?, "allow_remote"?, "shares_subscription_with"? }, "tasks": { "<task>": { "enabled", ... } }, "breaker"?, "suspension"? }`; `base_url` may not carry userinfo or a query. Full shape: LLD section 13.1. Inspect it with `doctor` and `inner status`. |
| `rag` | no | The optional retrieval index (ADR-0031): off unless you configure an `embedding` backend. No credential fields; `mode` defaults to `auto` (on only when a backend exists and the project allows). Projects and contexts may narrow caps and exclusions; `use_global` and `contribute_to_global` default to false and cannot be set on dynamic projects. Full shape: [LLD §14.1](docs/design/LLD.md#141-configuration-shape) and [Retrieval index](#retrieval-index-milestone-12). |
| `profiles.<name>` | no | Overrides for `inspect-untrusted`, `edit-untrusted`, `test-sandboxed` or `trusted-development`: `file_access`, `shell`, `shell_allowlist`, `network`, `network_allowlist`, `repo_config`. They may tighten or loosen a default; `doctor` lists them and every run records them. `privileged` has none. See the `edit-untrusted` limit under [Trust profiles](#trust-profiles). |

`<id>` is one of `claude-code`, `codex`, `grok-build`, `antigravity`, `cursor`, `opencode`, `kimi-code`. Only
`claude-code` and `codex` pass the version gate on `main` today; the other ids name registered M4 adapters whose
manifests admit no version until `switchboard adapters validate` passes a live CLI (ROADMAP §6.8.2). `<id>` is the
*config* id. The *provider* id used in
`routing.provider_preference` of `delegate_task` is the adapter id: `claude`
for Claude Code (config id `claude-code`), `codex` for Codex. `max_trust_profile` accepts any of the five profile
names, but see [Trust profiles](#trust-profiles).

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
(Switchboard could not tell; the reason is printed). `UNKNOWN` means the status command exited with
neither of its two expected codes, timed out or could not start (see [Troubleshooting](#troubleshooting)). For Codex the
state comes from the exit code of `codex login status` (0 is `OK`, 1 is `AUTH_REQUIRED`).

When the config has an `inner_agent` section, `doctor` adds an "Inner agent" block (and an `inner_agent` key in `--json`):
the backend kind, its locality (`local` for a loopback address, `remote` for anything else), the model, whether a fixed
canary answered within schema, the circuit state of the `doctor` process, and each enabled task with its rejection and
fallback rates and whether it is suspended. Its findings are at most `[warn]` and never change the exit code. `doctor`
contacts the backend only for that canary, and never a `remote` backend unless `allow_remote` is true. With no
`inner_agent` section the output is unchanged.

When `rag.embedding` is configured, `doctor` adds a "Retrieval index" block (and a `retrieval` key in `--json`): the
backend kind, model and locality; whether the privacy gate allows it; a one-line `probe` of the embedding endpoint
(only built-in probe text, and never to a `remote` backend unless `allow_remote` is true); and per project (and
`global` when `rag.global.enabled`) the index mode, revision, completeness, size, build time and staleness. These lines
are at most `[warn]` or `[skip]` and never change the exit code. With no `rag.embedding` section the report is unchanged.

A machine with no Claude Code or Codex installed gets `[warn]` for both and still exits 0. That proves only that the
environment and config are sound, not that a provider works.

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
as the inner agent (`inner_agent` in [Configure](#configure)). Source text is redacted before embedding;
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
`global` and the global half of `both` still return `unavailable` with `GLOBAL_NOT_AVAILABLE` until a follow-up wires
the global store into the tool (admission and the global build already use it). Treat every returned `text` field as
untrusted reference data, not instructions.

Privacy: retrieved text never feeds trust profiles, eligibility, approvals, routing, commit or push decisions (an
import-boundary test enforces this). Embedding calls are recorded apart from provider usage and capacity. Indexes live
under `<data_dir>/rag/`; deleting a project removes its store.

Tests on fakes and fixtures (no live embedding in CI): `src/config/rag.test.ts`, `src/retrieval/*.test.ts`,
`src/lifecycle/context-pack.test.ts`, `src/mcp/search-context.test.ts`, `src/cli/rag-index.test.ts`. Task-level
evidence is in [ROADMAP §6.7](docs/ROADMAP.md#67-m12-retrieval-index-tasks).

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
| `continue_task` | Continues an idle meta-session with a new instruction: resumes the same provider's native session, or hands off to another provider (or a fresh session) with a bundle built from Switchboard's own records. A `privileged` meta-session continues on its own provider only. |
| `get_run` | Returns a run's status, failure code, provider, summary, changed-file count and artifact ids, optionally with events. A run that was retried or failed over names its successor in `superseded_by`; the successor names the run it follows in `retry_of`. |
| `cancel_run` | Requests cancellation of a run (asynchronous; poll `get_run`). |
| `get_artifacts` | Lists a run's artifacts (diff, changed files, test report, ...) with hashes; small ones inline. |
| `list_capabilities` | Lists providers with adapter status, version, validated range, auth state and supported trust profiles. |
| `get_capacity` | Per-provider capacity: controller estimates (`capacity_score`, `confidence`, `throttle_risk`) with their sources, free slots, the circuit breaker, and `reset_at` or `explicit_remaining` only when the provider itself reported them; reported cache token counts where a source names the keys; per-project counts of runs that kept or switched provider and model. Read-only; it never calls a provider. |
| `explain_route` | Why a run went to its provider, from Switchboard's stored route decision: candidates with eligibility reasons, the recorded task features, weights and per-candidate scores, the selection rule and short deciding factors. Price, model quality and sandbox strength are not sourced, so those terms are equal for every provider. Read-only; no model is asked. |
| `list_projects` | Lists the configured projects this client may use (id, name, environment kind, contexts, trust ceiling, allowed providers), plus its own dynamic projects marked `source: "dynamic"` with their revision and status. Read-only; returns no filesystem paths. |
| `search_project_context` | Read-only semantic search over a project's indexed contexts (and optionally the global index once the tool is wired for `global`/`both`). Listed only when `rag.embedding` is set and this client has at least one project with retrieval on. See [Retrieval index](#retrieval-index-milestone-12). |
| `create_project`, `update_project`, `delete_project` | Only for a client with `manage_projects`. Create, revise or delete a dynamic project this client owns. See [Dynamic projects](#dynamic-projects). |

Tool schemas are published through MCP `tools/list`.

### Continuing a session: resume or handoff

`continue_task` takes a meta-session that has no active run and a new instruction, and does one of two things:

- **Resume.** The session's provider is eligible and has a native session: Switchboard resumes that native session
  (Claude Code `--resume <session id>`, Codex `exec resume <session id>`; the Codex form is an assumption until the
  operator's live run) in the worktree path of the run that created
  it, on a new run branch at the session's head checkpoint. If that directory is gone or is not clean, the continuation
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

`get_artifacts` returns the `handoff_view` of a handoff run; `get_run` names its artifact id and never carries bundle
text. `runs show <run>` prints a Handoff block: bundle artifact id and hash, the provider handed off from and why, the
source runs, and the binding the run started.

The `privileged` rule: a `privileged` meta-session continues on its own provider only. A continuation that would
hand it to another provider is refused with `INVALID_REQUEST` (`details.reason: "PRIVILEGED_CROSS_PROVIDER"`) before any
other provider is probed or anything is written, because a durable approval for a bypass run was given for one provider.
This is a fail-closed default until [ROADMAP Q-61](docs/ROADMAP.md#73-open-questions-for-zemdregon-not-blocking-m2-unless-noted)
is answered; a same-provider `privileged` continuation keeps the approval as it was.

### Capacity, retries and failover

`get_capacity`, `switchboard capacity` and the capacity lines of `doctor` show one projection, computed from
Switchboard's own records when you ask:

- **Estimates are estimates.** `capacity_score`, `confidence` and `throttle_risk` come from recent run outcomes,
  rate-limit signals the provider printed, the circuit breaker and free slots, over `capacity.window_seconds` (default
  one hour). With no recent evidence they read `unknown`, `null` and `0`, never "plenty". No provider's run output is
  known to report remaining quota, so `explicit_remaining` is `null` for every provider today. Nothing here is a
  percentage of your subscription. The sources are in
  [docs/research/capacity-signals-2026-10-14.md](docs/research/capacity-signals-2026-10-14.md).
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

**`explain_route`** returns, from the stored decision only, the candidates with their eligibility reasons, the
features, the weights, each candidate's terms and score, the rule that selected the provider, the affinity outcome and
short deciding factors such as `affinity held (claude)`. No model is asked and no reasoning is invented. A client sees
only its own runs. `switchboard affinity list` and `affinity reset` are under [Operator commands](#operator-commands).

The rules and the record format are in [LLD §17](docs/design/LLD.md#17-routing-m7) and
[ADR-0044](docs/adr/0044-deterministic-route-scoring-and-replayable-decisions.md).

### How commits reach Git

Agents are not given a way to commit or push: Git writes are denied where the provider documents a rule (Claude
Code; Codex documents none), and Switchboard compares the repository's refs before and after each run and records any
change as a `git_policy_violation`. Commits are made by the controller, on the host, in one of three ways, into a
publish ref `refs/heads/switchboard/pub/<session>` that is kept apart from the run branches and checkpoint commits.
This applies to runs started with `delegate_task`'s `project`.

| Path | Who commits | Offered by |
| --- | --- | --- |
| The agent's `commit` tool | The controller, for the paths the agent names, through the stdio `switchboard tool-shim` the adapter gives the agent | The fake test adapter. Claude Code only behind the unsupported `providers.claude-code.git_channel` and only in an approved `privileged` bypass run. Not Codex |
| Finalize-only commit | The controller, at the end of a successful run, from the run's changed files and the agent's summary | Any adapter without the tool, when the project's primary context sets `finalize_commit` (see below) |
| No commit | Nobody; the work stays in the run's worktree, diff and checkpoint | The default for those adapters |

Every commit uses the context's `identity`, passes the same sanitiser (attribution trailers, footers and session links
removed, plus your `git.sanitize_patterns`) and is recorded with its provenance (run, provider, model); see `runs show`.
Nothing leaves the host unless the context's push policy is `branch` (the default is `none`); the push never forces and
its `remote` is a remote name, never a URL (details below). With `"sign": true` the controller signs each published
commit with your own Git signing configuration; only GnuPG with a throwaway key has been tried. Approved bypass runs
are exempt from the push credential rule and from the finalize-only size limits (owner decisions 37 and 44).

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
switchboard gc [--apply]
switchboard git push <session_or_run_id>
switchboard projects list
switchboard projects show <id>
switchboard projects validate [<id>]
switchboard projects approve <id> [--revision <n>] [--reject]
switchboard adapters validate <provider>
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
machine-readable output. Exit codes: 0 success, 1 failure (including a refused decision), 2 usage error.

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
bypass flag. Only when everything passes does it edit the provider's manifest file in your source checkout
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
the unsupported `providers.claude-code.git_channel`) still run write-capable tasks; by default their work stays in the
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

**Inner agent.** `inner status` (read-only; it never contacts the backend) shows the state (`off`, `no_backend` or
`ready`), the backend's origin and locality, and per task the call counts by outcome, the fallback rate and the
rejection rate over the quality window; add `--json` for the same data. `inner test <task>` sends one built-in synthetic
fixture through the real pipeline (the same privacy gates, redaction, validation and `inner_call` record) and prints
the outcome, never the prompt or the reply; it sends no repository data, and it exits 1 when the result would fall back,
or when nothing was sent because the agent or the task is off. A task whose rejection rate exceeds the configured
threshold is suspended and falls back until you run `inner resume <task>` (quality counting then restarts). Neither
command prints a base URL's userinfo, a header, a key or any prompt or response text.

Which tasks run today (2026-10-14): only the commit-message task is wired into a run path (the optional `message` on
the `commit` tool). The PR-draft, verification-summary and run-title tasks exist as service functions, tested on fakes,
and nothing calls them yet; the handoff-condensation and routing tasks need milestones 11 and 7 (the handoff bundle of
milestone 5 is built without it). No hosted or live backend has been
exercised: every test uses a scripted fake or a local fake server.

## Grok Build CLI (milestone 4)

Config id `grok-build`; routing and `list_capabilities` id `grok-build`. Switchboard runs the **`grok`** binary with
`--single=<prompt> --output-format streaming-json`
([TDD §4.3.1](docs/design/TDD.md#431-grok-build-native-controls-per-profile-and-platform-t420); observed on
2026-10-14 in [`docs/research/live-checks-2026-10-14-grok.md`](docs/research/live-checks-2026-10-14-grok.md),
`grok 1.0.50`). The prompt is one argv word (`--single=<prompt>`), not stdin (an Assumption in the adapter). Switchboard
never sets `GROK_HOME`, `XAI_API_KEY` or `GROK_SANDBOX` (the sandbox profile is always a `--sandbox` flag).

The compliance manifest range admits no version until an operator runs `switchboard adapters validate grok-build` and
commits the manifest diff (ROADMAP T4.28). Until then `doctor` reports `ADAPTER_VERSION_UNVERIFIED` for Grok Build.

### Login

See the [login table](#log-in-to-the-providers-natively) above. Switchboard never runs `grok login`; it only runs
`grok models` during preflight.

### Trust profiles

The adapter compiles only what [TDD §4.3.1](docs/design/TDD.md#431-grok-build-native-controls-per-profile-and-platform-t420)
records for the 2026-10-14 live check (Q-62): every profile other than an approved `privileged` bypass scope is refused
(`PROFILE_UNSUPPORTED`), because `dontAsk` did not show a deny without a matching allow rule, deny rules are prefix
matches only (so Git-write denial via `--deny` is not a control Switchboard can rely on), the native login file is
readable from inside the sandbox, and no per-run MCP-definition flag exists in headless mode.

| Profile | Available now | Effect in this version |
| --- | --- | --- |
| `inspect-untrusted` | no | `PROFILE_UNSUPPORTED` (`list_capabilities` / `ELIGIBILITY_NONE`) |
| `edit-untrusted` | no | As `inspect-untrusted` |
| `test-sandboxed` | no | As `inspect-untrusted` |
| `trusted-development` | no | As `inspect-untrusted` |
| `privileged` | only an approved bypass scope | Above the client's ceiling: `PERMISSION_BLOCKED`. Otherwise the run waits for `switchboard approve` or `deny` (or starts at once when the client's `privileged_approval` is `not_required`). An approved scope with `bypass` compiles one argv shape: `grok --no-auto-update --single=<prompt> --output-format streaming-json` with `--sandbox` and `--always-approve` together (never one without the other), worktree file access, shell `broad`, network `on` or `off` (with `--disable-web-search` when off), repository configuration `enabled`, and sandbox profile `read-only`, `strict` or `workspace` from the scope (owner decision 46). A scope without `bypass`, or any narrowing Switchboard can express, is refused before spawn. No `--allow` or `--deny` rules are emitted (prefix matches are not a Git-write control). |

Resume continues the native session with `-r <session_id>` through the same matrix when the provider is eligible
(synthetic fixtures in `src/adapters/grok/grok.test.ts`, T4.23).

### Git and commits

`list_capabilities` reports `gitWriteControl` **`none-documented`**: Grok Build documents `--deny` rules, but they are
prefix matches and the live check showed forms that could still run `git commit` (step 9); Switchboard does not emit a
deny rule.

`commitChannel` is **`finalize-only`**: Switchboard does not inject a per-run MCP server (no headless MCP-definition
flag was found in the 2026-10-14 live check). In the only compiled scope, project `.mcp.json` and `.grok/config.toml`
MCP servers load without `--trust` (observed step 10a). To publish work, set `finalize_commit` on the project's primary
context as for Codex ([How commits reach Git](#how-commits-reach-git)). Shell allowlist entries that could write Git make
the run `Ineligible` (`PROFILE_UNSUPPORTED`, FR-GIT-01), including on an approved bypass scope.

The parser does not yet read `tool_call` / `tool_call_update` shapes (T4.23 Partial), so Switchboard's tool-call guard
(ADR-0039) cannot see Grok Build's shell commands until a capture records those lines; `extractResult` on `main` does not
yet mirror Cursor's ADR-0039 handling for a guard verdict on a parsed `tool_call` (other lane). In an approved bypass
run, Git-write denial therefore rests on FR-GIT-03 and FR-GIT-06 in addition to any provider rule.

Fixture evidence on `main`: `src/adapters/grok/grok.test.ts` ("grok compile matrix (T4.22)", "grok probe and resume
(T4.22, T4.23)", "grok parser and result (T4.23; SYNTHETIC lines in the shapes the 2026-10-14 live check recorded)",
"grok auth preflight (T4.24, Q-10; SYNTHETIC outputs in the shapes of the 2026-10-14 live check)", "grok conformance
suite (synthetic recorded fixtures, FR-ADP-11, T4.25)" and "grok Git declaration (T4.27, FR-GIT-01, FR-GIT-02,
FR-GIT-09)"); CI also runs `test/malicious/adapter-leg.test.ts` ("adapter malicious leg: grok", T4.26 partial while
`replayGap` is set). No end-to-end run through Switchboard against a logged-in `grok` has been recorded yet (T4.28).

## Antigravity CLI (milestone 4)

Config id `antigravity`; routing and `list_capabilities` id `antigravity`. Switchboard runs the **`agy`** binary with
`--prompt=<prompt> --output-format stream-json`
([TDD §4.4.2](docs/design/TDD.md#442-antigravity-native-controls-per-profile-and-platform-t430); observed on
2026-10-14 in [`docs/research/live-checks-2026-10-14-antigravity.md`](docs/research/live-checks-2026-10-14-antigravity.md),
`agy` 1.3.4). The prompt is one argv word (`--prompt=<prompt>`), not stdin (an Assumption in the adapter). Switchboard
sets `AGY_CLI_DISABLE_AUTO_UPDATE=true` on every run and never puts `GEMINI_API_KEY`, `GOOGLE_API_KEY` or
`GOOGLE_GEMINI_BASE_URL` in the child environment (API-key mode stays disabled).

The compliance manifest range admits no version until an operator runs `switchboard adapters validate antigravity` and
commits the manifest diff (ROADMAP T4.38). Until then `doctor` reports `ADAPTER_VERSION_UNVERIFIED` for Antigravity.

### Login

See the [login table](#log-in-to-the-providers-natively) above. Switchboard never launches `agy` for sign-in; it only
runs `agy models` during preflight.

### Trust profiles

The adapter compiles only what [TDD §4.4.2](docs/design/TDD.md#442-antigravity-native-controls-per-profile-and-platform-t430)
records for the 2026-10-14 live check (Q-63, Q-84): every profile other than an approved `privileged` bypass scope is
refused (`PROFILE_UNSUPPORTED`), because `toolPermission` is a settings value, not per run, soft denials can leave
`status` `SUCCESS` at exit 0, repository `GEMINI.md`, `AGENTS.md` and the `.agents` MCP server and hooks load with no
per-run approval flag, and no per-run deny rule was shown to hold under the bypass flag (T4.31 C8 not run).

| Profile | Available now | Effect in this version |
| --- | --- | --- |
| `inspect-untrusted` | no | `PROFILE_UNSUPPORTED` (`list_capabilities` / `ELIGIBILITY_NONE`) |
| `edit-untrusted` | no | As `inspect-untrusted` |
| `test-sandboxed` | no | As `inspect-untrusted` |
| `trusted-development` | no | As `inspect-untrusted` |
| `privileged` | only an approved bypass scope | Above the client's ceiling: `PERMISSION_BLOCKED`. Otherwise the run waits for `switchboard approve` or `deny` (or starts at once when the client's `privileged_approval` is `not_required`). An approved scope with `bypass` compiles one argv shape: `agy --prompt=<prompt> --output-format stream-json --dangerously-skip-permissions` with `AGY_CLI_DISABLE_AUTO_UPDATE=true`, worktree file access, shell `broad`, network `on` and repository configuration `enabled`, and **no** `--sandbox` (owner decision 46, Q-84). A scope without `bypass`, or any narrowing Switchboard can express (read-only files, shell allowlist, network off or repository configuration other than `enabled`), is refused before spawn. |

Resume is not compiled: `resumeArgs` is `Ineligible` for every profile until a live capture shows how resume is marked
(Q-86; synthetic fixtures in `src/adapters/antigravity/antigravity.test.ts`, T4.33 and T4.35).

### Git and commits

`list_capabilities` reports `gitWriteControl` **`none-documented`**: Antigravity documents Git deny rules only in
`settings.json` or `/permissions` scopes, none per run, and Switchboard writes no configuration file. Whether deny rules
hold under `--dangerously-skip-permissions` was not observed (T4.31 C8). Git-write denial therefore relies on FR-GIT-03
(controller ref comparison) and FR-GIT-06 (the tool-call guard) in addition to any provider rule. Shell allowlist
entries that could write Git make the run `Ineligible` (`PROFILE_UNSUPPORTED`, FR-GIT-01).

`commitChannel` is **`finalize-only`**: Switchboard does not inject a per-run MCP server (no headless MCP-definition
flag is documented). In the only compiled scope, repository `.agents/mcp_config.json`, `.agents/hooks.json`, `GEMINI.md`
and `AGENTS.md` load (observed on the 2026-10-14 live check). To publish work, set `finalize_commit` on the project's
primary context as for Codex ([How commits reach Git](#how-commits-reach-git)).

Fixture evidence: `src/adapters/antigravity/antigravity.test.ts` ("antigravity compile matrix (T4.32)", "antigravity
probe (T4.32)", "antigravity auth preflight (T4.34; SYNTHETIC outputs in the shapes of the 2026-10-14 live check C3b,
C3c)", "antigravity parser and result (T4.33)", "antigravity conformance suite (synthetic recorded fixtures, FR-ADP-11,
T4.35)", "antigravity Git declaration (T4.37, FR-GIT-01, FR-GIT-02, FR-GIT-09)" and "antigravity malicious-fixture leg
(T4.36, NFR-SEC-03, FR-POL-04, FR-POL-06; SYNTHETIC lines)"); CI also runs
`test/malicious/adapter-leg.test.ts` ("adapter malicious leg: antigravity"). The conformance `resume` case and parts of
the malicious leg stay partial on the roadmap (T4.35, T4.36) until operator captures close the gaps. No end-to-end run
through Switchboard against a logged-in `agy` has been recorded yet (T4.38).

## Cursor CLI (milestone 4)

Config id `cursor`; routing and `list_capabilities` id `cursor`. Switchboard runs the **`cursor-agent`** binary with
`--print --output-format stream-json` and the prompt on stdin ([TDD §4.5.2](docs/design/TDD.md#452-transport-decision);
observed on 2026-10-14 in [`docs/research/live-checks-2026-10-14-cursor.md`](docs/research/live-checks-2026-10-14-cursor.md)).
Do not invoke bare `agent` on `PATH`: on some hosts that name is Grok Build's CLI, not Cursor's (same live check).

The compliance manifest range admits no version until an operator runs `switchboard adapters validate cursor` and
commits the manifest diff (ROADMAP T4.48). Until then `doctor` reports `ADAPTER_VERSION_UNVERIFIED` for Cursor.

### Login

See the [login table](#log-in-to-the-providers-natively) above. Switchboard never runs `cursor-agent login`; it only
runs `cursor-agent status --format json` during preflight.

### Trust profiles

The adapter compiles only what [TDD §4.5.1](docs/design/TDD.md#451-cursor-native-controls-per-profile-and-platform-t440)
records for the 2026-10-14 live check (Q-65, Q-79): every profile other than an approved `privileged` bypass scope is
refused (`PROFILE_UNSUPPORTED`), because edits apply without `--force`, `--sandbox enabled` did not start on the
operator's Ampere host, headless runs need `--trust` (which loads repository rules and the operator's global MCP
servers), and no per-run permission flag is documented.

| Profile | Available now | Effect in this version |
| --- | --- | --- |
| `inspect-untrusted` | no | `PROFILE_UNSUPPORTED` (`list_capabilities` / `ELIGIBILITY_NONE`) |
| `edit-untrusted` | no | As `inspect-untrusted` |
| `test-sandboxed` | no | As `inspect-untrusted` |
| `trusted-development` | no | As `inspect-untrusted` |
| `privileged` | only an approved bypass scope | Above the client's ceiling: `PERMISSION_BLOCKED`. Otherwise the run waits for `switchboard approve` or `deny` (or starts at once when the client's `privileged_approval` is `not_required`). An approved scope with `bypass` compiles one argv shape: `cursor-agent --print --output-format stream-json --trust --force` with the prompt on stdin, worktree file access, shell `broad`, network `on` and repository configuration `enabled`, and **no** `--sandbox` flag (owner decision 46). A scope without `bypass`, or any narrowing Switchboard can express, is refused before spawn. Bypass-class flags such as `--approve-mcps` and `--yolo` are never compiled outside that case. |

Resume continues the native session with `--resume <session_id>` through the same matrix when the provider is eligible
(synthetic fixtures in `src/adapters/cursor/cursor.test.ts`, T4.43). The parser treats a guard-flagged `tool_call`
(`violation`) as a failed run per [ADR-0039](docs/adr/0039-switchboard-side-tool-call-guard.md) even when `result` is
`success` at exit 0 ([#238](https://github.com/zemdregon/switchboard/pull/238)). Rate-limit and sandbox stream shapes and
`backingProvider` on `session_bound` are still unrecorded (T4.43 stays `Partial` on the roadmap).

### Git and commits

`list_capabilities` reports `gitWriteControl` **`none-documented`**: Cursor documents permission rules in configuration
files, not per-run argv, and Switchboard does not write a per-run `CURSOR_CONFIG_DIR` file. Git-write denial therefore
relies on FR-GIT-03 (controller ref comparison) and FR-GIT-06 (the tool-call guard) in addition to any provider rule.
Shell allowlist entries that could write Git make the run `Ineligible` (`PROFILE_UNSUPPORTED`, FR-GIT-01).

`commitChannel` is **`finalize-only`**: Switchboard does not inject a `commit` tool or pass `--approve-mcps`, so
repository `.mcp.json` servers stay unapproved (observed on the 2026-10-14 live check). To publish work, set
`finalize_commit` on the project's primary context as for Codex ([How commits reach Git](#how-commits-reach-git)).

Fixture evidence: `src/adapters/cursor/cursor.test.ts` ("cursor Git declaration (T4.47, FR-GIT-01, FR-GIT-02,
FR-GIT-09)"), the conformance suite ("cursor conformance suite (synthetic recorded fixtures, FR-ADP-11, T4.45)") and
the malicious-fixture leg ("cursor malicious-fixture leg (T4.46, NFR-SEC-03, FR-POL-04, FR-POL-06)"); CI also runs
`test/malicious/adapter-leg.test.ts` ("adapter malicious leg: cursor"). No end-to-end run through Switchboard against a
logged-in `cursor-agent` has been recorded yet (T4.48).

## OpenCode CLI (milestone 4)

Config id `opencode`; routing and `list_capabilities` id `opencode`. Switchboard runs the **`opencode`** binary with
`run --format json --standalone -- <prompt>` ([TDD §4.6](docs/design/TDD.md#46-opencode-m4); observed on
2026-10-14 in [`docs/research/live-checks-2026-10-14-opencode.md`](docs/research/live-checks-2026-10-14-opencode.md),
`opencode v2.0.23`). The prompt is one argv word after `--`, not stdin (an Assumption in the adapter). Switchboard never
sets `OPENCODE_PERMISSION` or `OPENCODE_CONFIG_CONTENT` (ignored on that version in the live check).

The compliance manifest range admits no version until an operator runs `switchboard adapters validate opencode` and
commits the manifest diff (ROADMAP T4.58). Until then `doctor` reports `ADAPTER_VERSION_UNVERIFIED` for OpenCode.

### Login

See the [login table](#log-in-to-the-providers-natively) above. Switchboard never runs `opencode auth login`; it only
runs `opencode auth list --format json --standalone` during preflight.

### Trust profiles

The adapter compiles only what [TDD §4.6.1](docs/design/TDD.md#461-opencode-native-controls-per-profile-and-platform-t450)
records for the 2026-10-14 live check (Q-64, Q-83): every profile other than an approved `privileged` bypass scope is
refused (`PROFILE_UNSUPPORTED`), because no per-run deny took effect, the default runs shell commands including Git
writes, no sandbox is documented and a repository's `opencode.json` and `AGENTS.md` load.

| Profile | Available now | Effect in this version |
| --- | --- | --- |
| `inspect-untrusted` | no | `PROFILE_UNSUPPORTED` (`list_capabilities` / `ELIGIBILITY_NONE`) |
| `edit-untrusted` | no | As `inspect-untrusted` |
| `test-sandboxed` | no | As `inspect-untrusted` |
| `trusted-development` | no | As `inspect-untrusted` |
| `privileged` | only an approved bypass scope | Above the client's ceiling: `PERMISSION_BLOCKED`. Otherwise the run waits for `switchboard approve` or `deny` (or starts at once when the client's `privileged_approval` is `not_required`). An approved scope with `bypass` compiles one argv shape: `opencode run --format json --standalone -- <prompt>` with worktree file access, shell `broad`, network `on` and repository configuration `enabled`, and **no** `--auto` (owner decision 46, Q-83). A scope without `bypass`, or any narrowing Switchboard can express, is refused before spawn. Bypass-class flags such as `--auto` are never compiled outside that case (and are not emitted even inside it). |

Resume continues the native session with `--session <session_id>` through the same matrix when the provider is eligible
(synthetic fixtures in `src/adapters/opencode/opencode.test.ts`, T4.53).

### Git and commits

`list_capabilities` reports `gitWriteControl` **`none-documented`**: OpenCode documents `bash` deny patterns in
configuration, but on opencode v2.0.23 no per-run deny took effect in the live check, so Switchboard does not emit a
deny rule. Git-write denial therefore relies on FR-GIT-03 (controller ref comparison) and FR-GIT-06 (the tool-call
guard) in addition to any provider rule. Shell allowlist entries that could write Git make the run `Ineligible`
(`PROFILE_UNSUPPORTED`, FR-GIT-01).

`commitChannel` is **`finalize-only`**: Switchboard does not inject a per-run MCP server through
`OPENCODE_CONFIG_CONTENT` (not exercised on the 2026-10-14 live check). In the only compiled scope, repository
`opencode.json` and `AGENTS.md` load (owner decision 26). To publish work, set `finalize_commit` on the project's primary
context as for Codex ([How commits reach Git](#how-commits-reach-git)).

Fixture evidence: `src/adapters/opencode/opencode.test.ts` ("opencode conformance suite (synthetic recorded fixtures,
FR-ADP-11, T4.55)" and "opencode Git declaration (T4.57, FR-GIT-01, FR-GIT-02, FR-GIT-09)"); CI also runs
`test/malicious/adapter-leg.test.ts` ("adapter malicious leg: opencode") with the case in
`test/malicious/adapters/opencode.case.ts` (T4.56 is still `Partial` on the roadmap: hostile streams that end blocked
are not pinned yet). No end-to-end run through Switchboard against a logged-in `opencode` has been recorded yet
(T4.58).

## Trust profiles

A trust profile says what a delegated agent may do ([ADR-0004](docs/adr/0004-trust-profiles-no-bypass-flags.md)). Each
adapter compiles the profile into the provider's own permission and sandbox controls.

| Profile | Available now | Effect in this version |
| --- | --- | --- |
| `inspect-untrusted` | yes | Read-only file access, network off, repository-provided config disabled. Claude Code gets no shell. Codex runs commands inside its read-only native sandbox (see below). |
| `edit-untrusted` | yes | Edits inside an isolated Git worktree, network off, repository config disabled. Claude Code gets no shell, because the shell allowlist is empty. Codex runs commands inside its `workspace-write` native sandbox (see below). |
| `test-sandboxed` | no | Both adapters refuse it (`PROFILE_UNSUPPORTED`, reported as `ELIGIBILITY_NONE`): neither provider shows confinement for it yet (`src/adapters/claude/adapter.ts`, `src/adapters/codex/adapter.ts`). |
| `trusted-development` | only some settings | Each adapter compiles the settings it can express (for example Codex only with a `broad` shell) and refuses the rest with `ELIGIBILITY_NONE`; `list_capabilities` shows which profiles each provider supports on this host. |
| `privileged` | yes, per provider | Above the client's `max_trust_profile`: `PERMISSION_BLOCKED`. Otherwise the run waits for `switchboard approve` or `deny` (or, for a client with `privileged_approval: "not_required"`, starts at once). An approved run is compiled by its provider's adapter from the approved scope; a provider that cannot express the scope fails the run `ELIGIBILITY_NONE` before any process starts. |

A request above the client's `max_trust_profile` also fails `PERMISSION_BLOCKED`.

**Verification commands.** `delegate_task` may pass `verification_commands`, a list of argv arrays such as
`[["npm", "test"]]`. After the agent finishes successfully, Switchboard runs them one after another in the run's
worktree, with no shell (`;`, `$( )` and `*` are passed literally), the run's environment allowlist (no `GIT_*`,
SSH-agent or GnuPG variables) and the run's wall-clock limit. The first command that fails, times out or cannot start
ends the run `FAILED` with `TEST_FAILURE`; the agent's own summary is kept. `get_run` shows each command's outcome and
exit code, and `get_artifacts` returns the full output as a `test_report` (at most 1 MiB per stream, secret patterns
redacted). `cancel_run` stops a running command, and a controller restart ends the run `PROCESS_CRASH` without running
the commands again. They are refused under `inspect-untrusted`. **They run on your host as your user, outside any
provider sandbox** (ROADMAP owner decision 11, R-24): they can read your files and use the network. Supply them only for
repositories you trust. A Git ref they move is reported as a policy violation and controller refs are put back, but a
push they make cannot be seen.

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
- **Inner-agent privacy.** The inner agent is off by default and is the one place the controller process itself calls
  out. A backend is `local` only if every address it resolves to is loopback; a `remote` backend is unused until you set
  `allow_remote`, and a task that sends repository content (diffs, log excerpts) to a remote backend needs its own
  `allow_source_content`. A project can only restrict it (`off` or `local_only`). Prompts are redacted first, bodies are
  never logged, and nothing it returns reaches a policy, approval or failure decision.
- **Retrieval privacy.** The retrieval index is off by default and uses the same locality gates for its embedding
  backend. Chunk text and MCP search results are untrusted reference data; they never reach profile compilation,
  eligibility, approvals, routing, commit or push logic, and a retrieval failure never fails a run. Ledger rows for
  index and search hold counts, ids and hashes only.
- **Fail closed.** An invalid config, an unknown client id, an unverified CLI version or an unavailable profile refuses
  to run rather than weakening anything.

This is a summary of design intent and the implemented checks, not a security guarantee. The isolation has not yet been
tested against malicious repositories (milestone 3). Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Known limitations

- **Codex is only lightly validated.** The Codex compliance manifest covers `>=0.162.0 <0.163.0` (an Assumption, ROADMAP
  Q-12), validated on codex-cli 0.162.0 on 2026-10-14 by `switchboard adapters validate codex` (probe, auth, static
  conformance checks and one smoke call; `docs/research/live-checks-2026-10-14-claude-codex.md`) and, for 0.162.1, by
  `--version` and the flags in `--help` (`docs/research/live-checks-2026-10-13.md`), not by a conformance suite. Any
  other Codex version fails the version gate. The `codex login status` exit codes were observed on that version only;
  its output format is undocumented.
- **Grok Build malicious-fixture leg is partial (ROADMAP T4.26).** CI runs `test/malicious/adapter-leg.test.ts` with
  `test/malicious/adapters/grok.case.ts` on synthetic `streaming-json` streams (no `grok` installed). Compile and
  isolation-flag checks pass for each compiled bypass cell; hostile replay blocking checks are skipped while `replayGap`
  is set because `tool_call` / `tool_call_update` fields were not recorded (T4.23), so sandbox and policy denials can
  still end at exit 0 in an approved bypass run, and credential reads inside the sandbox are not refused (Q-62). See
  ROADMAP T4.26 for the full gap list.
- **Event shapes are partly verified.** The 2026-10-13 live checks confirmed the Claude Code stream-json shapes
  (C-1 to C-11 and G-1) on 2.1.296 and the Codex flags (X-1 to X-3) on 0.162.1. Claude error strings (C-12), the
  Git-write attempt (C-G2) and Codex through Switchboard (X-5 to X-9) are still unverified, and another CLI version may
  differ. See `docs/research/live-checks-2026-10-13.md`.
- Linux only. Single operator only. No hosted or multi-user mode.
- Only Claude Code and Codex; profiles beyond `inspect-untrusted` and `edit-untrusted` only where the adapter can
  compile them (see `list_capabilities`); a `privileged` `continue_task` only on the same provider (ROADMAP
  Q-61 is open).
- `adapters validate` is implemented for every registered provider, but only Claude Code and Codex have a manifest range
  on `main` today. Antigravity, Cursor, OpenCode and the other M4 adapters still need operator captures before their
  manifests admit a version (ROADMAP T4.38, T4.48, T4.58 and §6.8.2).
- Routing (milestone 7) evaluates `minimum_capability` against operator-declared model capabilities in the model
  registry instead of refusing it (ROADMAP §6.12 T7.8, `src/routing/minimum-capability.test.ts`); undeclared models
  fail closed with `CAPABILITY_MISSING` (mapping to `ELIGIBILITY_NONE`), and admitted providers compile with the
  satisfying model. Affinity pins the model at compile when the adapter declares `reportedModelFlag` (Claude Code
  today, T7.12, `src/routing/model-pin.test.ts`); undeclared adapters keep their default model. No cache benefit from
  keeping a project on one provider is claimed (T7.9).
- Capacity figures are controller estimates. No provider is known to report remaining quota, and the rate-limit and
  quota output shapes of Claude Code and Codex come from synthetic fixtures until the operator captures them (ROADMAP
  T6.11). There is no rate gate, because no provider publishes an enforceable limit for the logins used (T6.8,
  Deferred).
- Retrieval is tested with a deterministic in-process fake embedder and scripted HTTP fixtures; no live embedding model
  runs in CI. `search_project_context` with `scope: "global"` or `"both"` does not read the global store yet (admission
  merge with `use_global` does).

### Optional live smoke test

With a provider CLI installed and logged in natively, you can run one real task against it. It is opt-in and skipped
unless you set the variables; `npm test` and CI never run it.

```sh
SWITCHBOARD_LIVE_TESTS=1 SWITCHBOARD_LIVE_PROVIDER=claude npm run test:live   # or codex
```

It builds, creates a throwaway Git repository and data directory under the system temp directory, runs one
`edit-untrusted` task, and prints which adapter assumptions held, failed or were not checked. Details are in
[TDD §3.6](docs/design/TDD.md#36-testing-strategy). With the current manifests, a codex-cli 0.162.0 or 0.162.1 passes the
version gate (range `>=0.162.0 <0.163.0`); any other Codex version is refused as `ADAPTER_VERSION_UNVERIFIED`.

### Optional live pair test

With both Claude Code and Codex installed and logged in natively, `SWITCHBOARD_LIVE_TESTS=1 npm run test:live:pair`
delegates one edit to one provider and continues the session on the other through `continue_task`, in a throwaway
repository, for each direction (`SWITCHBOARD_LIVE_PAIR=claude:codex` runs one). It is opt-in and skipped otherwise, passes
no bypass flag, prints no prompt or transcript, and records statuses, bindings (without native session ids) and the
bundle hash. A provider that is not installed or not logged in makes its checks `NOT_CHECKED`. It has not been run
against real providers yet (ROADMAP T5.12 is the operator task).

## Troubleshooting

| Code or message | Where you see it | Meaning and what to do |
| --- | --- | --- |
| `AUTH_REQUIRED` | `doctor` adapter line (`[warn]`, "AUTH_REQUIRED, run natively"); a failed run | The provider CLI reports you are not logged in. Run the native login it prints (Claude Code: `claude auth login`; Codex: `codex login`, check the provider's documentation), then run `doctor` again. |
| auth `UNKNOWN` | `doctor` adapter line | Switchboard could not determine login state; the reason is printed. Check the CLI runs on its own. For Codex it means `codex login status` exited with a code other than 0 or 1, timed out or could not start. |
| `not installed: ... CLI not found` | `doctor` (`[warn]`) | The provider binary is not on `PATH`. Install it, or ignore it if you do not use that provider. |
| `ADAPTER_VERSION_UNVERIFIED` | `doctor` (`[FAIL]`, exit 1); `list_capabilities` | The installed CLI version is outside the range recorded in the adapter's compliance manifest, so the adapter is ineligible. For Codex the range on main is `>=0.162.0 <0.163.0` (validated on 0.162.0, ROADMAP Q-12, an Assumption): another Codex version fails `doctor` until you run `switchboard adapters validate codex` and commit the manifest diff, or set `providers.codex.enabled` to `false` (this stops dispatch to Codex, and `doctor` then reports it as `[skip]` and does not probe it). Do not edit manifests by hand to force a pass. |
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
