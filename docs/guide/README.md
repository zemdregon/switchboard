# Switchboard guide

The user and operator guide for Switchboard. The [project README](../../README.md) is the short landing page; these
pages hold the detail that used to live in it. Requirements, design and decisions are owned by the documents listed in
[AGENTS.md](../../AGENTS.md#which-document-owns-what); the guides describe what is implemented and how to use it.

| Guide | What it covers |
| --- | --- |
| [Getting started](getting-started.md) | Requirements, install from source, provider logins, every configuration key, `doctor` and troubleshooting. |
| [MCP server and operator CLI](mcp-server.md) | The MCP tool reference, continuing sessions, capacity and failover, routing, model groups and pacing, how commits reach Git, the command reference and dynamic projects. |
| [Security and trust](security.md) | Trust profiles, verification commands, the security model and the single-operator position. |
| [Provider notes](providers.md) | Login, trust profile, parser evidence and Git notes for Grok Build, Antigravity, Cursor, OpenCode, Kimi Code and Muse Code. |
| [Advanced features](advanced-features.md) | Retrieval index, telemetry and adapter versioning, container environments, the control plane and controlled skills. |
| [Status](status.md) | Milestone-by-milestone status with evidence. The roadmap stays canonical. |
| [Known limitations](known-limitations.md) | What is not done or not verified. |
| [Live testing](live-testing.md) | The opt-in live smoke, malicious-fixture and pair tests, and the budget guard. |

Other places to look: [examples](../../examples/README.md) for configs and MCP client snippets, the
[roadmap](../ROADMAP.md), the [ADRs](../adr/README.md) and the [research](../research/) record.
