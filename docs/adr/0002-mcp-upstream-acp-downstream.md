# ADR-0002: MCP as the upstream control plane, ACP as a downstream transport

- Status: Accepted
- Date: 2026-10-12
- Decided by: Delegated (agent, 2026-10-12)
- Related: FR-MCP-01–09, FR-EXE-02–04

## Context

The stated intent is to expose the controller to a primary orchestrator "as a Model Context Protocol (MCP) or Agent
Context Protocol (ACP) server" ([original
blueprint](../research/headless-ai-coding-controller.md#introduction-to-the-cli-native-orchestration-paradigm)). The
[verified
research](../research/headless-ai-coding-controller-verified-2026-10-12.md#mcp-acp-and-the-recommended-production-architecture)
found that MCP is designed for applications to consume tools, while ACP (exposed by Grok Build `grok agent stdio` and
Cursor `agent acp`) is an agent/session protocol. Coding tasks can take minutes to hours, longer than many MCP clients
wait for one tool call.

## Decision

1. Upstream, the controller is an MCP server over stdio with a small tool set (FR-MCP-01/02). This satisfies the "MCP or
   ACP" intent with MCP.
2. Tool calls are asynchronous-first: `delegate_task` returns a `run_id` immediately; callers poll `get_run` or pass a
   bounded `wait_seconds`.
3. Downstream, the controller acts as an ACP *client* to providers that expose ACP (M4), alongside subprocess JSON/JSONL
   and, later, local-service transports.
4. An upstream ACP server is deferred.

## Alternatives considered

- **Upstream ACP server.** Deferred: no orchestrator requirement for it has been identified, and it doubles the protocol
  surface.
- **Blocking tool calls only.** Rejected: long runs would exceed client timeouts and hold the orchestrator's turn.
- **HTTP/SSE MCP transport.** Deferred: stdio matches the local single-operator deployment (ADR-0011) and avoids opening
  a network listener.

## Consequences

- Orchestrators must poll or use bounded waits. This is documented in the tool descriptions.
- Process isolation between orchestrator and provider processes is preserved.

## Revisit when

A target orchestrator can only speak ACP, or the MCP specification's long-running task support becomes broadly
implemented by target clients.
