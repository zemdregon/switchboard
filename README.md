# Switchboard

![Switchboard logo](assets/switchboard-logo.png)

**One AI agent in charge. Every AI coding CLI at its command.**

Switchboard lets the agent you already work with hand coding tasks to Claude Code, Codex, Grok Build, Antigravity,
Cursor, OpenCode, Kimi Code and Muse Code, all through one [MCP](https://modelcontextprotocol.io) tool surface. It runs
on your own machine, reuses the logins you already made with those CLIs, and never touches your credentials.

- **Delegate, don't babysit.** Your orchestrator calls `delegate_task`, gets a `run_id` back at once, and checks in
  when it likes. Each task runs in its own isolated Git worktree.
- **Use every subscription you pay for.** Work is routed by capacity and track record, and moves to another provider
  when one runs out of quota.
- **Safe by default.** Agents start read-only or confined to a worktree. Anything riskier waits for your approval.
- **Everything is on the record.** Every run, route decision and commit lands in a local, hash-chained ledger.

> **Pre-release.** Linux only, built from source, not published to npm. Claude Code and Codex are the most exercised
> providers. See [Status](#status) for what is verified and what is not.

## Quickstart

You need Linux, Node.js 22 or newer and Git 2.32 or newer, plus at least one provider CLI logged in natively. You
can have your own AI do the setup, or run the commands yourself.

### Option 1: one-shot setup prompt

Paste this into the AI coding agent of your choice (Claude Code, Codex, Cursor, OpenCode and so on) from any
directory. It builds Switchboard, writes a config, checks it and registers it with that agent. It will stop and ask
you for the few things only you can decide.

```text
Set up Switchboard for me. Switchboard is a headless controller that lets one orchestrating agent delegate coding
tasks to AI coding CLIs through a single MCP stdio server. Repository: https://github.com/zemdregon/switchboard

Work through these steps in order and report the result of each one briefly.

1. Check prerequisites: Linux, Node.js >= 22 and Git >= 2.32 (`node --version`, `git --version`). If one is missing,
   tell me what to install and stop.
2. Ask me for two things before changing anything: (a) the directory that holds the projects I want agents to work
   in (this becomes `allowed_roots`; it must already exist), and (b) where to put the Switchboard checkout (suggest
   ~/switchboard).
3. Clone and build:
   git clone https://github.com/zemdregon/switchboard.git <checkout>
   cd <checkout> && npm ci && npm run build
4. Create ~/.config/switchboard/config.json from examples/minimal.json in the checkout. Replace the placeholder
   `allowed_roots` path with the directory I gave you. Keep `"max_trust_profile": "edit-untrusted"`; do not raise it,
   and do not add any `privileged` or bypass settings.
5. Run `node <checkout>/dist/cli/bin.js doctor --config ~/.config/switchboard/config.json` and show me the output.
   `[warn]` lines for provider CLIs that are not installed or not logged in are fine. A `[FAIL]` is not: fix it or
   tell me why you cannot.
6. For each provider CLI that `doctor` reports as installed but not logged in, tell me the native login command from
   this list and let me run it myself: Claude Code `claude auth login`, Codex `codex login`, Grok Build `grok login`,
   Antigravity `agy` (launch with no arguments), Cursor `cursor-agent login`, OpenCode `opencode auth login`,
   Kimi Code `kimi login`. NEVER log in for me, and never read, print, copy or write API keys, tokens, auth.json files
   or keychain entries anywhere. Re-run `doctor` after I confirm.
7. Register Switchboard as a stdio MCP server in YOUR OWN MCP configuration (use your documented way of adding one):
   command `node`, args `<absolute checkout path>/dist/cli/bin.js serve --client orchestrator --config
   <absolute path to the config file>`. Use absolute paths. Tell me if I need to restart you to load it.
8. After the restart, verify it: call the `list_capabilities` tool and show me which providers are available. Then,
   if I agree, call `delegate_task` once with `trust_profile` set to `inspect-untrusted`, a small read-only
   objective such as "summarize the layout of this repository", and `workspace_path` set to a Git checkout under
   `allowed_roots`. Poll `get_run` until it finishes and show me the result.

Rules: never use flags such as --dangerously-skip-permissions, --yolo or --force with any provider CLI; never run
Switchboard's live smoke test (`npm run test:live`); do not edit anything outside the checkout, the Switchboard config
and your own MCP settings; stop and ask if anything is unclear.
```

### Option 2: by hand

```sh
git clone https://github.com/zemdregon/switchboard.git
cd switchboard
npm ci && npm run build

mkdir -p ~/.config/switchboard
cp examples/minimal.json ~/.config/switchboard/config.json
# edit allowed_roots to list a directory that exists, e.g. /home/you/projects

node dist/cli/bin.js doctor --config ~/.config/switchboard/config.json
```

`doctor` exits 0 when the environment and config are sound. Provider lines read `[warn]` until a provider CLI is
installed and logged in with its own login command ([provider logins](docs/guide/getting-started.md#log-in-to-the-providers-natively)).

Then register Switchboard in your orchestrator's MCP settings as a **stdio** server (client snippets for the Claude
app, a Grok bot and OpenClaw are in [`examples/mcp-clients/`](examples/mcp-clients/README.md)):

```json
{
  "mcpServers": {
    "switchboard": {
      "command": "node",
      "args": [
        "/path/to/switchboard/dist/cli/bin.js",
        "serve", "--client", "orchestrator",
        "--config", "/path/to/.config/switchboard/config.json"
      ]
    }
  }
}
```

Ask your orchestrator to delegate something. Under the hood it calls `delegate_task`:

```json
{"objective": "add a hello-world script", "workspace_path": "/home/you/projects/demo", "trust_profile": "edit-untrusted"}
```

`workspace_path` must be a Git checkout under one of your `allowed_roots`. The call returns a `run_id` at once; poll
`get_run` for the outcome and `get_artifacts` for the diff.

Want to try it without any provider CLI? Start the server with
`SWITCHBOARD_TEST_FAKE_ADAPTER=enable-test-only-fake-adapter` set and tasks run on a built-in fake adapter
([details](docs/design/TDD.md#36-testing-strategy)).

## How it works

```text
  You ──▶ Orchestrator agent ──MCP──▶ Switchboard ──▶ Claude Code
                                          │       ├─▶ Codex
                                          │       ├─▶ Cursor, OpenCode, Grok, Kimi, ...
                                          ▼
                       isolated worktrees · run ledger · approvals
```

1. Your orchestrator calls `delegate_task` with an objective, a workspace and a trust profile.
2. Switchboard picks an eligible provider, creates an isolated Git worktree and drives that provider's CLI through its
   documented headless interface.
3. The run finishes (or fails with one clear failure code). You and the orchestrator read the summary, the diff and
   the test report.

Switchboard is for **one operator on one machine**. It is not a hosted service, and it stores no provider credentials.

## What you get

| Capability | In plain words | More |
| --- | --- | --- |
| One tool surface | `delegate_task`, `continue_task`, `get_run`, `get_artifacts`, `cancel_run` and friends, the same for every provider. | [MCP tools](docs/guide/mcp-server.md#mcp-tools) |
| Isolation | Every task runs in its own Git worktree, not in your checkout. | [Security](docs/guide/security.md) |
| Trust profiles | Read-only, edit-in-a-worktree and more, each compiled into the provider's own sandbox controls. `privileged` needs your approval. | [Trust profiles](docs/guide/security.md#trust-profiles) |
| Routing and failover | Scores providers from your own history and capacity, and moves work when one hits its limit. `explain_route` shows why. | [Routing](docs/guide/mcp-server.md#routing-and-affinity) |
| Continuity | Continue a task on the same provider, or hand it to another with context from Switchboard's records. | [Continuing](docs/guide/mcp-server.md#continuing-a-session-resume-or-handoff) |
| Controlled Git | Agents commit through a controlled tool; you decide which projects may push, open pull requests or merge. | [Git commits](docs/guide/mcp-server.md#how-commits-reach-git) |
| Verification | Run your test commands after the agent finishes, and fail the run if they fail. | [Trust profiles](docs/guide/security.md#trust-profiles) |
| Audit and telemetry | A local, hash-chained ledger of runs and decisions. Optional OTLP traces, off by default. | [Advanced](docs/guide/advanced-features.md) |
| Control plane | Digests, pauses, approvals and notifications for chat or console clients. | [Control plane](docs/guide/advanced-features.md#control-plane-milestone-14) |

## Supported providers

Switchboard drives each CLI through its documented automation surface and asks the CLI itself whether you are logged
in.

| Provider | Native login | Notes |
| --- | --- | --- |
| Claude Code | `claude auth login` | Most exercised, with live smoke results. |
| Codex | `codex login` | Most exercised, with live smoke results. |
| Cursor CLI | `cursor-agent login` | [Notes](docs/guide/providers.md#cursor-cli-milestone-4) |
| OpenCode | `opencode auth login` | [Notes](docs/guide/providers.md#opencode-cli-milestone-4) |
| Kimi Code | `kimi login` | [Notes](docs/guide/providers.md#kimi-code-cli-milestone-4) |
| Antigravity | launch `agy` | [Notes](docs/guide/providers.md#antigravity-cli-milestone-4) |
| Grok Build | `grok login` | [Notes](docs/guide/providers.md#grok-build-cli-milestone-4) |
| Muse Code | see notes | Optional; [notes](docs/guide/providers.md#muse-code-cli-milestone-4) |

You need at least one. Switchboard has no `login` command and never handles tokens or key files.

## Safe by default

| Profile | What the agent may do |
| --- | --- |
| `inspect-untrusted` | Read-only file access. No network. |
| `edit-untrusted` | Edit inside an isolated worktree. No network. Repository config is ignored. |
| `privileged` | Only after you run `switchboard approve`. |

Each MCP client in your config has a `max_trust_profile` ceiling, so an orchestrator can never ask for more than you
allowed. Other profiles and the exact guarantees are in the [security guide](docs/guide/security.md).

## Status

Pre-release and built from source. The foundation (run ledger, workspaces, lifecycle, operator CLI) is done. The
Claude Code and Codex adapters, MCP server, isolation, projects and controlled commits, continuity, capacity and
routing are implemented and tested, mostly on fake providers and recorded fixtures, with live provider checks that are
partial. Not everything is verified against live providers yet. The honest, per-milestone detail is in the
[status guide](docs/guide/status.md) and the canonical [roadmap](docs/ROADMAP.md#6-milestones), and the gaps are in
[known limitations](docs/guide/known-limitations.md).

## Documentation

| Read | For |
| --- | --- |
| [Getting started](docs/guide/getting-started.md) | Requirements, install, provider logins, every config key, `doctor`, troubleshooting. |
| [MCP server and operator CLI](docs/guide/mcp-server.md) | Tool reference, sessions, capacity, routing, Git and the full command reference. |
| [Security and trust](docs/guide/security.md) | Trust profiles, the security model and the single-operator position. |
| [Provider notes](docs/guide/providers.md) | Per-provider behaviour, parsers and Git notes. |
| [Advanced features](docs/guide/advanced-features.md) | Retrieval index, telemetry, containers, control plane, skills. |
| [Examples](examples/README.md) | Ready-made configs and MCP client snippets. |
| [Roadmap](docs/ROADMAP.md) | Scope, milestones and status. The canonical plan. |
| [All guides](docs/guide/README.md) | Index of the guide set, including live testing. |
| [Design and requirements](docs/design/HLD.md) | HLD, SDD, TDD, LLD, requirements and [ADRs](docs/adr/README.md). |

## Your accounts, your responsibility

Switchboard drives the CLIs through the headless interfaces they document. That is a technical statement, not a legal
one. **This project does not claim that any use of it complies with any provider's terms of service.** Use your own
logins, one operator per machine, and read each provider's current terms before you rely on it. Details are in
[Single operator, your own accounts](docs/guide/security.md#single-operator-your-own-accounts).

## Contributing

Contribution steps are in [CONTRIBUTING.md](CONTRIBUTING.md). AI agents working in this repository should read
[AGENTS.md](AGENTS.md) first. Report security concerns as described in [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE).
