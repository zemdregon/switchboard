# ADR-0010: TypeScript on Node.js as the implementation stack

- Status: Accepted
- Date: 2026-10-12
- Decided by: Delegated (agent, 2026-10-12). Ender has not stated a language preference; this is the most reversible
  point to change it.
- Related: [TDD §2](../design/TDD.md#2-technology-choices)

## Context

No code exists. The controller is I/O-bound: it supervises subprocesses, parses JSON/JSONL streams, speaks MCP and ACP,
and writes to SQLite. Switchboard is open source and other people will install it (ADR-0011), so ease of installation
and of outside contribution matter as well as development speed.

## Decision

TypeScript (strict mode) on the current Node.js LTS line, using the official MCP TypeScript SDK for the upstream server.
Exact library versions are pinned in M1 and recorded in the TDD.

## Alternatives considered

- **Go.** Strong for process supervision and single-binary distribution; official MCP Go SDK exists. Not chosen because
  the JSON-schema-heavy MCP/ACP surface and the likely orchestrators (Node-based agents) favour TypeScript, and a single
  language across adapters and schemas keeps contributions simple.
- **Python.** Mature MCP SDK; not chosen because packaging and process-group handling are less predictable across hosts
  for a long-running daemon.
- **Rust.** Highest safety and performance; slowest to iterate for a single maintainer at this stage.

## Consequences

- Requires Node.js on the host. Installation is `npm`/`npx`, the usual way MCP servers are added to an orchestrator's
  config. Distribution as a single executable is a later hardening item.
- SQLite access uses a native module or Node's built-in SQLite; prebuilt binaries for Linux and macOS must be confirmed
  in M1 so users never need a compiler.
- Process-group and signal handling must be tested carefully on Linux and macOS.

## Revisit when

Before M1 starts, if Ender prefers another language; later, if distribution or process-control problems prove costly.
