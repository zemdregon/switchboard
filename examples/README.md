# Example configurations

Each file is a complete `config.json` in the shape `loadConfig` (`src/config/load.ts`) reads: strict JSON, so
documentation lives here instead of inside the files (any comment key would stop startup as an unknown key).
`src/config/examples.test.ts` loads every top-level `*.json` file in this directory, so a new example is tested automatically.

Conventions: every path is under `/home/you/...`; replace that prefix with your own directories first. Domains are
`*.example.test` placeholders. There are no secrets, tokens or provider bypass flags anywhere in these files.

MCP client snippets live in [`mcp-clients/`](mcp-clients/README.md): one stdio snippet per client (Claude app,
Grok bot, OpenClaw), parse-checked by `src/config/examples.test.ts`.

| File | What it shows | Change first |
| --- | --- | --- |
| `minimal.json` | Smallest working config: one MCP client, everything else default (a provider not listed stays enabled, `src/routing/collect.ts`). | `allowed_roots` (must exist). |
| `two-providers-routing.json` | Claude Code plus Codex with explicit weights (providers not listed stay enabled at their defaults), a `model_groups` group, `routing.weights` and `capacity` pacing. | Provider weights and the subscription window budget. |
| `projects-and-push.json` | One project with a repository context, `branch` push policy and commit signing off. | The context `path`, the `push` remote and prefix, and the commit `identity`. |
| `http-transport.json` | Loopback HTTP transport with OAuth (M13): replace the placeholder `passphrase_hash` with the output of `switchboard consent hash-passphrase` before serving. | `public_url`, `port`, `passphrase_hash`, the OAuth client mapping and `cimd`. |
| `approval-and-sinks.json` | A `privileged` client that still requires operator approval, plus a notification sink for approval events. | The sink `url` (and any `ntfy` server, topic or token you add). |

## Cloning projects over MCP (no example file)

`project_sources` and `mcp_clients[].approval_proxy_kinds` (ADR-0068) have no example file: `clone_root` must be an
existing directory under an allowed root when the file loads, which a placeholder path cannot satisfy in
`src/config/examples.test.ts`. Add them to your own config like this, with your own paths and owners:

```json
{
  "project_sources": {
    "clone_root": "/home/you/clones",
    "allowed_hosts": ["github.com"],
    "allowed_owners": ["your-org"]
  },
  "mcp_clients": [
    {
      "id": "chat-bot",
      "max_trust_profile": "edit-untrusted",
      "manage_projects": true,
      "approval_proxy": true,
      "approval_proxy_targets": ["chat-bot"],
      "approval_proxy_kinds": ["dynamic_project", "push_revision"]
    }
  ]
}
```

With this, `chat-bot` can `create_project` with a `clone_url`, then approve the revision itself with `decide_approval`
(never a privileged run). Self-approval is a real trade-off; read R-83 in the roadmap first.

## Skills

`skills/` holds example skill files (LLD §19.1). They are not configuration and are not enabled by default: an operator
adds one with `switchboard skills add docs-alignment --file <path>` and approves it like any other skill.

| File | What it does |
| --- | --- |
| `skills/docs-alignment.md` | Checks README, ROADMAP and ADRs against the code at the run's commit and writes `docs_alignment.json` with `aligned` or `conflict` (FR-SKL-11, LLD §20.6). Switchboard stores it as the run's `docs_alignment` artifact; it never commits or pushes it. |
