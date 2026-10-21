# Getting started

Requirements, install from source, provider logins, configuration, `doctor` and troubleshooting. Part of the
[Switchboard guide](README.md).

## Requirements

- Linux. Other operating systems are not supported yet. macOS process handling (process tree and PID-reuse guard
  through `ps`) passed a macOS CI leg (T4.10; the leg was removed on 2026-10-19 and CI is Linux only), and no trust
  profile is eligible on macOS.
- Node.js 22 or newer (`engines` in `package.json`).
- Git 2.32.0 or newer (`MIN_GIT_VERSION` in `src/workspace/git.ts`). `doctor` checks both.
- For real work, at least one provider CLI installed and logged in natively: Claude Code, Codex, Grok Build,
  Antigravity, Cursor, OpenCode, Kimi Code or Muse Code. Only Claude Code, Codex, OpenCode, Kimi Code, Antigravity
  and Cursor admit a version today; the other manifests admit no version until `switchboard adapters validate`
  passes a live CLI (see
  [ROADMAP §6.8](../ROADMAP.md#68-m4-adapter-expansion-tasks)). `doctor` does not require any particular one.

## Install from source

```sh
git clone https://github.com/zemdregon/switchboard.git switchboard
cd switchboard
npm ci && npm run build
node dist/cli/bin.js --help
```

`npm ci` installs `better-sqlite3` from its published prebuilds when one matches your platform; without network access
to fetch a prebuild you need a C/C++ toolchain (make, g++, python3) so it can compile instead.

The commands below write `switchboard` for `node /path/to/switchboard/dist/cli/bin.js`. Replace it with the absolute
path of your checkout; an orchestrator launching `serve` needs the absolute path too. Switchboard is not published to
npm, so there is no `npm install switchboard`. `npm pack` produces an installable tarball (`npm install
./switchboard-0.0.0.tgz`); the package is not published to npm.

## Log in to the providers (natively)

Switchboard has no `login` command and never starts a login, reads token files or exports credentials. You log in with
each provider's own CLI, and Switchboard asks that CLI whether it is logged in.

| Provider | Login step the adapter reports | Status of that step |
| --- | --- | --- |
| Claude Code | `claude auth login` (the adapter returns `AUTH_REQUIRED` naming it) | Taken from the adapter; check Anthropic's documentation |
| Codex | `codex login`; status is read with `codex login status` (exit code 0 logged in, 1 not) | `codex login status` observed on codex-cli 0.162.1 (`docs/research/live-checks-2026-10-13.md`); output format undocumented, so only the exit code is used; check OpenAI's documentation for the login step |
| Grok Build | `grok login` (the adapter returns `AUTH_REQUIRED` naming it; the CLI's own error text also names `grok login --device-code`) | Auth preflight runs `grok models` and keys on the first stdout line (`You are logged in with grok.com.` vs `You are not authenticated.`; exit 0 in both states on the 2026-10-14 live check, `grok 1.0.50`; [`docs/research/live-checks-2026-10-14-grok.md`](../research/live-checks-2026-10-14-grok.md)); check xAI's documentation for the login step |
| Antigravity | Launch **`agy`** without arguments (the adapter returns `AUTH_REQUIRED` naming `agy`; the CLI's stderr also says to launch without arguments to sign in) | Auth preflight runs `agy models` and keys on exit code and stderr (`<slug>\t<name>` lines at exit 0 vs `Error: Please sign in` at exit 1 on the 2026-10-14 live check, `agy` 1.3.4; [`docs/research/live-checks-2026-10-14-antigravity.md`](../research/live-checks-2026-10-14-antigravity.md)); check Google's Antigravity documentation for the login step |
| Cursor CLI | `cursor-agent login` (the adapter returns `AUTH_REQUIRED` naming it) | Auth preflight runs `cursor-agent status --format json` and keys on `isAuthenticated` (exit 0 both logged in and logged out on the 2026-10-14 live check; [`docs/research/live-checks-2026-10-14-cursor.md`](../research/live-checks-2026-10-14-cursor.md)); check Cursor's documentation for the login step |
| OpenCode | `opencode auth login` (the adapter returns `AUTH_REQUIRED` naming it) | Auth preflight runs `opencode auth list --format json --standalone` and treats any non-environment connection type as logged in (exit 0 in every state on the 2026-10-14 live check, `opencode v2.0.23`; [`docs/research/live-checks-2026-10-14-opencode.md`](../research/live-checks-2026-10-14-opencode.md)); check OpenCode's documentation for the login step |
| Kimi Code | `kimi login` (the adapter returns `AUTH_REQUIRED` naming it; Switchboard never runs `kimi login` or `kimi acp --login`) | No status command exists; auth preflight runs `kimi acp` and sends ACP `initialize` then `session/new`, keying on the JSON-RPC replies only: a `sessionId` is logged in, error `-32000` (`Authentication required`) is logged out (Kimi Code CLI 2.1.1, rows 8 to 10 of [`docs/research/live-checks-2026-10-15-kimi.md`](../research/live-checks-2026-10-15-kimi.md), no model call); the probe ran live twice through Switchboard on 2026-10-18 (final-verify `validate kimi` on the fixed probe and the `adapters validate kimi` pass, both `[ok] auth: OK`, ROADMAP T4.64 and T4.68); the live legs ran on 2026-10-19 and the row closed Partial-by-ruling with permission gating Deferred (ROADMAP T4.68); check Moonshot's Kimi Code documentation for the login step |

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

More complete starting points live in [`examples/`](../../examples/README.md): each top-level `*.json` config loads as is
(replace the `/home/you/...` paths first). The [`mcp-clients/`](../../examples/mcp-clients/README.md) snippets are MCP
client settings, not Switchboard configs.

Keys (from `src/config/schema.ts`; the `projects` key is described below the table):

| Key | Required | Meaning |
| --- | --- | --- |
| `schema_version` | yes | Must be `1`. |
| `allowed_roots` | yes | Non-empty list of directories. A task's `workspace_path` must be under one of them. Each must exist. Relative paths resolve against the config file's directory. |
| `mcp_clients` | yes | Entries `{ "id", "max_trust_profile", "privileged_approval"?, "projects"? }`. `id` matches `^[a-z0-9][a-z0-9_-]{0,63}$` and must be unique. `serve --client <id>` binds a session to one entry. |
| `mcp_clients[].projects` | no | Ids of the configured `projects` this client may use with `delegate_task`'s `project` input and see in `list_projects`. An id that names no project stops startup. A client without the list can use no project (workspace paths still work). |
| `mcp_clients[].manage_projects` | no | `true` gives this client the `create_project`, `update_project` and `delete_project` tools for its own *dynamic projects* (see [Dynamic projects](mcp-server.md#dynamic-projects)). Default `false`: the tools do not exist for it. |
| `mcp_clients[].max_push_policy` | no | `"none"` (default) or `"branch"`: the widest push policy a dynamic project of this client may declare. Only with `manage_projects: true`. A push-enabled project still waits for `projects approve`. Since ADR-0069 (2026-10-20, owner decision 78) an approved revision with push policy `branch` pushes (agent `push` tool, `publish_run`, `switchboard git push`) while the client keeps `manage_projects` and `max_push_policy: "branch"`; it also offers `publish_run` to the client. |
| `mcp_clients[].approval_proxy_kinds` | no | Subset of `privileged_scope`, `dynamic_project`, `push_revision`, `project_source` that an `approval_proxy` client may list and decide over MCP (default: the first three; `project_source`, which widens the owners Switchboard may clone from, is served only when listed, ADR-0087). Refused without `approval_proxy: true`. Example: `["dynamic_project", "push_revision"]` lets a chat client approve project revisions but never a privileged run (ADR-0068). |
| `mcp_clients[].privileged_approval` | no | `"required"` (default) or `"not_required"`. With `not_required`, that client's `privileged` requests run without `switchboard approve` (see [Trust profiles](providers.md#trust-profiles)). Allowed only when the client's `max_trust_profile` is `privileged`; `doctor` warns for every client that sets it. |
| `data_dir` | no | Where the ledger, artifacts and worktrees live. Default `$XDG_DATA_HOME/switchboard` (`~/.local/share/switchboard`). |
| `limits.global_concurrency` | no | Integer 1 to 64. Default 4. |
| `limits.per_provider_concurrency` | no | Integer 1 to 64. Default 1. |
| `limits.verification_slots` | no | Integer 1 to 64. How many verification commands may run at once across every run on this host (ROADMAP T3.22, FR-EXE-09). Off unless you set a `limits.verification_*` key; then unset keys take the defaults (slots 2, nice 10, no extra variables). |
| `limits.verification_nice` | no | Integer 0 to 19. Niceness added to each verification command (default 10); 0 leaves their priority unchanged. Same off-unless-set rule as `limits.verification_slots`. |
| `limits.verification_env` | no | Up to 16 upper-case variable names with string values (at most 256 characters each), for example `VITEST_MAX_WORKERS`. Given to verification commands only, through the environment allowlist; `PATH`, `HOME`, `GIT_*`, `LD_*`, `DYLD_*`, `NODE_OPTIONS` and signing/agent variables are refused. Same off-unless-set rule as `limits.verification_slots`. |
| `limits.min_free_disk_mb` | no | Integer, whole megabytes; **off when absent** (nothing probes the disk and nothing changes). When set, `serve` checks the free space of the data directory and its `worktrees` root before dispatching: under the floor every queued run waits in `QUEUED` with a `disk_hold` event (it is never failed or refused; `delegate_task` still accepts), the free space is re-probed every 30 seconds, and an early clean-up sweep runs, which collects idle meta-sessions older than `retention.days` **only if you set `retention.days`** (the same switch as above) and never a worktree whose run holds a write lease. `doctor` adds a `Free disk` line with the free space and the floor. See [ROADMAP T3.23](../ROADMAP.md#65-m3-isolation-tasks). |
| `host.max_load1`, `host.resume_load1` | no | Numbers above 0, set together, `resume_load1` lower than `max_load1` (anything else is refused at load). **Off when absent** (the load average is never read). When set, `serve` reads the 1-minute load average before dispatching: above `max_load1` new runs wait in `QUEUED` with the hold reason `held_load` (shown by `get_run` and `get_digest`) until the load is below `resume_load1`. Running runs are never stopped; a load that cannot be read never holds; `doctor` adds a `Host load` line (ROADMAP T3.24, FR-CAP-12). |
| `mcp_clients[].allow_light` | no | Boolean, default `false`. When `true`, that client's `delegate_task` or `enqueue_work` request with `light: true` is admitted during a host load hold; from any other client `light` is ignored (T3.24). |
| `providers.<id>.enabled` | no | Boolean. A provider you do not list is enabled. |
| `providers.<id>.weight` | no | Number from 0 to 1. Accepted by the schema. |
| `providers.claude-code.git_channel` | no | Boolean, default `false`. **Supported, bypass-only** (owner decision 2026-10-16, ADR-0033): gives Claude Code the injected `commit` (and `push`) tool through a Switchboard-written `--mcp-config` file in the run's private directory, **only in an approved `privileged` run whose scope sets `bypass`**. Such a run then omits `--safe-mode` (it stops the tool server from starting), so the repository's `CLAUDE.md` and hooks load in it. Every other run is unaffected and can use `finalize_commit`. With `rag.embedding` set and retrieval on for the project, the same run also gets the read-only `search_project_context` tool for its own project (ROADMAP T12.9). Git-write denial still applies in that run (ROADMAP T9.4b); `serve` logs a warning when it is on. Only `claude-code` accepts the key. |
| `retention.days`, `retention.interval` | no | How long idle meta-sessions are kept (integer days, default 30) and how often `serve` runs the clean-up pass (`30m`, `12h`, `7d`; default `24h`). **Nothing is deleted unless you set `retention.days`**; the default only applies once you do (or to `gc` dry runs). |
| `projects` | no | List of `{ "id", "name", "environment"?, "contexts": [...] , "max_trust_profile"?, "allowed_providers"? }`. `id` matches `^[a-z][a-z0-9-]{1,40}$` and is unique. `environment` is `{ "kind": "host" }` (default) or a `container` shape; `projects validate` checks runtime, image and the no-Git-client probe for `container` projects when configured (see [Container environments](advanced-features.md#container-environments-milestone-10)). Each context is `{ "id", "kind": "repository", "path", "base_ref", "base_remote"?, "primary"?, "writable"?, "push"?, "identity"?, "sign"?, "finalize_commit"? }` with an absolute `path` under an allowed root; exactly one context is primary. `base_remote` (primary context only) is the name of a remote in the repository (not a URL, like `push.remote`): when set, the daemon fetches the base branch into its remote-tracking ref before a meta-session's first worktree and starts the run at the fetched commit when it fast-forwards the local branch (LLD §5.2, ADR-0067). Unknown keys and context kinds stop startup. `push.remote` must be the name of a remote in the repository (not a URL), and `push.branch_prefix` a branch-name prefix such as `"switchboard/"`. `max_trust_profile` and `allowed_providers` apply to `delegate_task` with a `project`: the effective trust ceiling is the lower of the client's and the project's, and routing is limited to the listed providers (a request naming another provider with `require_provider` fails `PERMISSION_BLOCKED`); `sign` (default `false`; needs `identity`, primary writable context only) makes the controller sign each published commit with the operator's own global Git signing configuration; a signing failure, a repository whose own configuration sets `gpg.*` or `user.signingkey`, or a run whose agent could reach the key (the `push` rule) returns `SIGNING_FAILED` and commits nothing; `projects validate` makes a test signature. Only GnuPG has been tried, with a throwaway key; SSH, X.509, passphrase-protected and hardware keys are untested. `finalize_commit` (default `false`; needs `identity`, primary writable context only) turns on finalize-only commits, described below. `setup` (host projects only; ADR-0071) is `{ "commands": [[argv...], ...], "network"?: { "hosts": [...] }, "cache"?: "pnpm" \| "npm" \| "none", "timeout_seconds"?, "env"? }`: up to 8 argv commands (no shell) the controller runs in each run's worktree before the agent starts, inside bubblewrap whose only network is an allowlisting HTTPS proxy to `network.hosts` (default `["registry.npmjs.org"]`, port 443 only), with a minimal environment (no operator variables, tokens or SSH agent; `HOME` under `data_dir/setup/<project>`), shared caches under `data_dir/caches` (`pnpm` store, `npm` cache, `COREPACK_HOME`), `timeout_seconds` default 600 (at most 1800) and `env` limited to `CI`, `NODE_ENV`, `NO_COLOR`. It is skipped when the same worktree already ran the same setup for the same lockfile; its output must be Git-ignored; a failure ends the run `TOOL_FAILURE` (`SETUP_FAILED` or `SETUP_TIMEOUT`) before the agent starts, with the output in the `setup_log` artifact. It needs a working unprivileged bubblewrap and does not run without one. Full shape: LLD section 11.1 and section 5.3. |
| `routing` | no | `{ "weights"?: { "success", "latency", "capacity", "security", "handoff", "cost", "pacing" }, "affinity"?: { "enabled", "low_water_mark", "min_confidence", "idle_ttl" } }`. Each weight 0 to 100, default 1; all 0 means configured order. The seventh weight `pacing` (T7.13) is accepted and resolved, and since T7.15 (`Done` 2026-10-17) the scorer reads it: a candidate whose provider is in a configured subscription gets the `pacing` term after the six terms in [Routing and affinity](mcp-server.md#routing-and-affinity), otherwise the score still uses those six. `affinity.enabled` defaults to `true`; `low_water_mark` and `min_confidence` (0 to 1) are set together or both left `null` (the default, which leaves the estimate trigger off); `idle_ttl` accepts only `null` (no expiry). Unknown keys stop startup. See [Routing and affinity](mcp-server.md#routing-and-affinity) and LLD section 17.1. |
| `model_groups` | no | Operator-named groups of models across providers (T7.13, FR-RTE-10): `{ "<name>": { "members": [{ "provider": "<config provider id>", "model": "<model id or alias>" }] } }`. Names match `^[a-z][a-z0-9_-]{0,31}$`, at most 32 groups; each group lists 1 to 32 members in order (order is the last tie-break). Startup refuses an unknown provider id, a duplicate pair, an empty group, a malformed name or model, and unknown keys; the one exception is the test-only `fake` adapter id, accepted as a member `provider` (and in `capacity.subscriptions.<name>.providers`) only when that adapter is registered (`serve` with the test-only fake switch, TDD §3.6), and refused as before otherwise. A member whose model the registry cannot resolve is accepted and reported by `doctor` (below), not refused. Names and members are configuration only. Full shape: [LLD §17.7](../design/LLD.md#177-model-groups-fr-rte-10-fr-rte-11). |
| `timeouts.preflight_ttl_seconds` | no | Integer 0 to 3600. How long a successful adapter preflight is cached (default 60); 0 disables the cache. |
| `telemetry.otlp_endpoint` | no | `http` or `https` URL for OTLP/HTTP trace export. When omitted or empty, Switchboard does not load OpenTelemetry at startup and makes no outbound telemetry connection. See [Telemetry and adapter versioning](advanced-features.md#telemetry-and-adapter-versioning-milestone-8) and [LLD §7](../design/LLD.md#7-telemetry-spans). |
| `telemetry.provider_otlp` | no | Boolean (default off). When `true`, a run whose provider manifest cites `otlp_metrics` gets a per-run loopback OTLP/HTTP-JSON metrics receiver (`127.0.0.1:0`, T8.15, FR-TEL-06); anything else means no receiver opens for any run. No shipped manifest declares `otlp_metrics` yet, so the switch alone changes nothing. See [Telemetry and adapter versioning](advanced-features.md#telemetry-and-adapter-versioning-milestone-8) and [ADR-0063](../adr/0063-per-run-provider-otlp-metrics-receiver.md). |
| `git.sanitize_patterns` | no | Up to 16 extra regular-expression sources (200 characters each, restricted subset in `src/git/safe-pattern.ts`). A commit-message line that matches one is removed, in addition to the built-in attribution rules. |
| `git.secret_scan.allow` | no | Up to 64 entries `{ "rule_id", "path" }` for the secret scan ([LLD §20.9](../design/LLD.md#209-pre-push-secret-scan-fr-git-11-t914-adr-0061)). Every push, by the agent's `push` tool or `git push` on the CLI and in every profile including an approved bypass run, scans the added lines it would publish with the built-in rules (`src/artifacts/redact.ts`: private-key blocks, AWS, GitHub, `sk-`, Slack and JWT shapes, Switchboard's own tokens, `Bearer` headers and `password=`-style assignments) and refuses with `SECRET_SCAN_BLOCKED` on a hit, recording the rule id, path and line and never the value. The commit tool runs the same scan over the added lines of the new commit and records each hit as a `secret_scan_hit` warning event (`stage: "commit"`) without refusing. An entry lets a hit of `rule_id` through at paths the glob matches (`fixtures/**`); an unknown rule id stops startup. There is no other switch: to publish anyway, push by hand. `switchboard git ack-secret-scan <gps_id>` acknowledges a refused push: it clears the `secret_scan_blocked` attention flag until the next refusal and never lets the push through. |
| `inner_agent` | no | The optional inner agent (ADR-0016): a cheap or self-hosted model for small tasks. Off unless you write the section and set `enabled: true`; there is no default backend, model or task, and no key, token or header field (a hosted service goes through a gateway you run). Shape: `{ "enabled", "backend": { "kind": "http", "base_url", "model", "timeout_ms"?, "max_concurrency"?, "allow_remote"?, "shares_subscription_with"? }, "tasks": { "<task>": { "enabled", ... } }, "breaker"?, "suspension"? }`; `base_url` may not carry userinfo or a query, and `shares_subscription_with` must be one of the provider config ids listed below this table (`claude-code`, `codex`, ...) or `null`: any other string stops startup, so `doctor` fails its config check naming the key and `inner test` exits 1 before sending anything. Full shape: LLD section 13.1. Inspect it with `doctor` and `inner status`. |
| `project_sources` | no | `{ "clone_root", "allowed_hosts"?, "allowed_owners" }`: lets a `manage_projects` client give `create_project` a `clone_url` (`https://<host>/<owner>/<repo>`) instead of a `path`. `clone_root` is an existing absolute directory under an allowed root and outside `data_dir`; `allowed_hosts` defaults to `["github.com"]`; `allowed_owners` is required. Without it every `clone_url` is refused. Git runs with your own credentials (credential helper or `gh` login); Switchboard never sees them (ADR-0068). |
| `projects[].contexts[].submodules` | no | `{ "mode": "off" or "recursive", "writable_paths"?, "exclude"? }` on the primary context of an umbrella repository (ADR-0087). Absent or `off`: every nested repository is left out of controller Git, as before. `recursive`: Switchboard reads `.gitmodules` itself, checks every submodule URL against `project_sources` (`https://<host>/<owner>/<repo>` or `../<repo>`, host and owner allowlisted), keeps one shared clone per submodule repository and checks each submodule out at its recorded commit in the run worktree. `writable_paths` (up to 512 worktree-relative paths, or exactly `["*"]`) lets the controller commit changes in those submodules and publish them; `exclude` leaves paths out; a wiki (`*.wiki`) is never writable. A non-empty `writable_paths` waits for operator approval (`submodule_write`). Only the primary context may set `recursive`. Contract: [LLD §3.4.17](../design/LLD.md#3417-submodule-projects-adr-0087). |
| `projects[].merge_policy.checks` | no | `"required"` (default) or `"all_reported"` (ADR-0087): `all_reported` merges only when at least one check ran at the head and every reported check passed, for repositories without branch protection; no check at all is refused `no_checks_reported`. Setting `all_reported` waits for operator approval (`merge_checks`). |
| `rag` | no | The optional retrieval index (ADR-0031): off unless you configure an `embedding` backend. No credential fields; `mode` defaults to `auto` (on only when a backend exists and the project allows). Projects and contexts may narrow caps and exclusions; `use_global` and `contribute_to_global` default to false and cannot be set on dynamic projects. Full shape: [LLD §14.1](../design/LLD.md#141-configuration-shape) and [Retrieval index](advanced-features.md#retrieval-index-milestone-12). |
| `profiles.<name>` | no | Overrides for `inspect-untrusted`, `edit-untrusted`, `test-sandboxed` or `trusted-development`: `file_access`, `shell`, `shell_allowlist`, `network`, `network_allowlist`, `repo_config`. They may tighten or loosen a default; `doctor` lists them and every run records them. `privileged` has none. See the `edit-untrusted` limit under [Trust profiles](providers.md#trust-profiles). |
| `outer_sandbox.required_profiles` | no | List of distinct non-privileged profile names (default empty, which changes nothing). A listed profile is refused with `ELIGIBILITY_NONE` unless bubblewrap and `prlimit` work on the host; because no process is wrapped through this gate yet, a listed profile is refused even when both work (`OUTER_SANDBOX_NOT_ENFORCED`). `doctor` reports the check. The Cursor bypass cell's own bubblewrap wrapper lives outside this gate ([ADR-0059](../adr/0059-cursor-bypass-cell-bubblewrap-wrapper.md)). See [Trust profiles](providers.md#trust-profiles) and LLD section 8.4. |

`<id>` is one of `claude-code`, `codex`, `grok-build`, `antigravity`, `cursor`, `opencode`, `kimi-code`, `muse-code`. Only
`claude-code`, `codex`, `opencode`, `kimi-code`, `antigravity` and `cursor` pass the version
gate on `main` today; the other ids
(`grok-build`, `muse-code`) name registered M4 adapters whose manifests admit no version
until `switchboard adapters validate` passes a live CLI
(ROADMAP §6.8.2). `<id>` is the *config* id. The canonical *provider* name is the adapter id: `claude`
for Claude Code (config id `claude-code`), `grok` for Grok Build (`grok-build`), `kimi` for Kimi Code (`kimi-code`),
`muse` for Muse Code (`muse-code`); the others are the same in both. Every provider input (`providers.<id>`,
`allowed_providers`, `model_groups` members, `routing.provider_preference` of `delegate_task`, `get_capacity`, the CLI
`--provider` flags) accepts either spelling, and outputs report the canonical name
([ADR-0076](../adr/0076-provider-name-aliases.md), table in LLD §2 "Provider ids"). `max_trust_profile` accepts any
of the five profile
names, but see [Trust profiles](providers.md#trust-profiles).

## Check the setup with `doctor`

```sh
switchboard doctor            # add --json for machine-readable output
switchboard doctor --config /path/to/config.json
```

`doctor` checks Node, Git, the config, the data directory, the ledger, the ledger hash chain and the
data-directory lock, reports what
retention would collect and any orphans (read-only), reports free disk space against `limits.min_free_disk_mb` when
that key is set (`[warn]` under the floor: `serve` holds new runs; never `[FAIL]`), then probes each
adapter (Claude Code, Codex and a fake test adapter that is not a real provider). It exits 0 when no check failed and 1
otherwise. Markers:

| Marker | Meaning |
| --- | --- |
| `[ok]` | Check passed. |
| `[warn]` | Not fatal, exit stays 0. For a provider: CLI not installed, or installed but not logged in or auth unknown. For the ledger: not created yet (`serve` creates it) or an older schema that `serve` migrates. For the lock: a stale lock file. |
| `[FAIL]` | Exit code 1. For a provider: the probe failed, or the version gate rejected the installed version. |
| `[skip]` | Skipped: because the config is not valid, or (for a provider) because `providers.<id>.enabled` is `false`, or (for the ledger hash chain) because no ledger exists yet or the chain migration is still pending (`serve` migrates). Skips never change the exit code. |

When the ledger has the chain columns (migration 26), `doctor` also verifies both hash chains
(`ledger_chain`, T8.13, FR-TEL-05, [ADR-0064](../adr/0064-hash-chained-ledger-rows.md)): `[ok]` carries each
chain's length and head hash, and `[FAIL]` names the table and the first broken row. It detects edits made
without the chain code, not a rewritten chain or a truncated tail.

Per adapter, the auth state is `OK`, `AUTH_REQUIRED` (doctor prints the native login command to run) or `UNKNOWN`
(Switchboard could not tell; the reason is printed). `UNKNOWN` means the status command exited with
neither of its two expected codes, timed out or could not start (see [Troubleshooting](#troubleshooting)). For Codex the
state comes from the exit code of `codex login status` (0 is `OK`, 1 is `AUTH_REQUIRED`).

When the config has an `inner_agent` section, `doctor` adds an "Inner agent" block (and an `inner_agent` key in `--json`):
the backend kind, its locality (`local` for a loopback address, `remote` for anything else), the model, whether a fixed
canary answered within schema, the circuit state of the `doctor` process, and each enabled task with its rejection and
fallback rates and whether it is suspended. Its findings are at most `[warn]` and never change the exit code. `doctor`
contacts the backend only for that canary, and never a `remote` backend unless `allow_remote` is true. When the backend
declares `shares_subscription_with`, the check list also carries a `[warn]` (`inner_shared_subscription`): the inner
agent's calls consume that provider's capacity, and each call records one usage observation labelled `inner_agent` —
never as provider usage, and never in `capacity_score`. That warning and that label are only ever a known provider
config id: with `shares_subscription_with` set to any other string, `doctor` (text and `--json`) exits 1 on its
`config` check with the loader's message naming the key, carries no `inner_shared_subscription` check and no inner-agent
block, and `inner test` exits 1 with the same message, sends nothing and writes neither an `inner_call` row nor an
observation (`src/inner/usage-surfaces.test.ts`, [#407](https://github.com/zemdregon/switchboard/pull/407)). The
warning follows the declaration, not routing: with the shared provider disabled in config (`providers.<id>.enabled:
false`) `doctor` carries the identical check, `inner status` still names the provider and each backend request still
writes its labelled row (`src/inner/usage-surfaces.test.ts`). Inner
calls leave the capacity projection unchanged; when the inner-agent section is present, its call counts change, so the
whole `doctor --json` document does not stay byte-identical. With no `inner_agent` section the output is unchanged.

When `rag.embedding` is configured, `doctor` adds a "Retrieval index" block (and a `retrieval` key in `--json`): the
backend kind, model and locality; whether the privacy gate allows it; a one-line `probe` of the embedding endpoint
(only built-in probe text, and never to a `remote` backend unless `allow_remote` is true); and per project (and
`global` when `rag.global.enabled`) the index mode, revision, completeness, size, build time and staleness. These lines
are at most `[warn]` or `[skip]` and never change the exit code. With no `rag.embedding` section the report is unchanged.

When `model_groups` is configured, `doctor` adds a "Model groups" block (and a `model_groups` key in `--json`): each
group with each member's current resolution — the resolved id, an `alias -> <id>` mapping, or the stage-1 code it
would get (`PROVIDER_DISABLED`, `ADAPTER_NOT_REGISTERED`, `CAPABILITY_MISSING` with its detail). The block is
informational and never changes the exit code. With no `model_groups` section the report is unchanged.

A machine with no Claude Code or Codex installed gets `[warn]` for both and still exits 0. That proves only that the
environment and config are sound, not that a provider works.

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
