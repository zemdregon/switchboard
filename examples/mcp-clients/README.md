# MCP client snippets

Configuration examples that register Switchboard's stdio server (`switchboard serve`) with three MCP clients.
Each file is strict JSON and is parse-checked by `src/config/examples.test.ts`. Replace the `/path/to/...`
placeholders with your checkout, config file and client id (the `--client` id must match an `mcp_clients` entry;
see the README's [Run as an MCP server](../../README.md#run-as-an-mcp-server) section).

| File | Client |
| --- | --- |
| `claude-app.json` | Claude app (merge the `mcpServers` object into its MCP config file). |
| `grok-bot.json` | Grok bot (merge the `mcpServers` object into its MCP server config). |
| `openclaw.json` | OpenClaw (merge the `mcpServers` object into `openclaw.json`). |

**Assumption** (Linus decision, WORK QUEUE v10, Delegated, not owner-approved): these files are configuration
examples, checked for parse only. How each client loads its MCP config file is not verified here; follow that
client's own documentation for where its config file lives and whether it needs a restart. No provider is run by
these files.
