# Example configurations

Each file is a complete `config.json` in the shape `loadConfig` (`src/config/load.ts`) reads: strict JSON, so
documentation lives here instead of inside the files (any comment key would stop startup as an unknown key).
`src/config/examples.test.ts` loads every `*.json` file in this directory, so a new example is tested automatically.

Conventions: every path is under `/home/you/...`; replace that prefix with your own directories first. Domains are
`*.example.test` placeholders. There are no secrets, tokens or provider bypass flags anywhere in these files.

| File | What it shows | Change first |
| --- | --- | --- |
| `minimal.json` | Smallest working config: one MCP client, everything else default (a provider not listed stays enabled, `src/routing/collect.ts`). | `allowed_roots` (must exist). |
| `two-providers-routing.json` | Claude Code plus Codex with explicit weights (providers not listed stay enabled at their defaults), a `model_groups` group, `routing.weights` and `capacity` pacing. | Provider weights and the subscription window budget. |
| `projects-and-push.json` | One project with a repository context, `branch` push policy and commit signing off. | The context `path`, the `push` remote and prefix, and the commit `identity`. |
| `http-transport.json` | Loopback HTTP transport with OAuth (M13): replace the placeholder `passphrase_hash` with the output of `switchboard consent hash-passphrase` before serving. | `public_url`, `port`, `passphrase_hash`, the OAuth client mapping and `cimd`. |
| `approval-and-sinks.json` | A `privileged` client that still requires operator approval, plus a notification sink for approval events. | The sink `url` (and any `ntfy` server, topic or token you add). |
