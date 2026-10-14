# ADR-0040: MCP caller authentication: no OAuth on the stdio transport

- Status: Accepted (owner decision, 2026-10-14, PR #102 comment: stdio launch binding is enough; Q-66)
- Date: 2026-10-14
- Decided by: Delegated (agent, 2026-10-14, at the owner's request to choose an authentication approach), under [owner
  decision 25](../ROADMAP.md#42-owner-decisions) for everything outside bypass mode. Not a zemdregon quote and not
  owner-approved. Nothing here changes what an approved bypass run may do.
- Builds on: [ADR-0002](0002-mcp-upstream-acp-downstream.md) (stdio upstream, HTTP/SSE deferred),
  [ADR-0003](0003-no-credential-handling.md) (no OAuth flows, no token handling),
  [ADR-0011](0011-single-operator-local-deployment.md) (single operator, local, stdio only).
- Related: FR-MCP-01, FR-MCP-06, FR-OPS-04, FR-OPS-02, FR-MCP-11, NFR-SEC-01,
  [ADR-0019](0019-per-client-privileged-approval.md),
  Q-66

## Context

The owner asked what authentication the MCP server needs and whether OAuth is the right choice. Three facts settle most
of it.

1. The MCP authorization specification (OAuth 2.1 with PKCE, protected-resource metadata and token audience binding)
   covers **HTTP-based transports only**. Its protocol requirements say that implementations using the STDIO transport
   should not follow it and should instead retrieve credentials from the environment. Switchboard's upstream is stdio
   (FR-MCP-01, ADR-0002, ADR-0011).
2. The controller runs as one operator's process, spawned by that operator's orchestrator. The party that starts the
   process already controls the local user, so a network login would protect nothing the spawn does not already
   protect. The caller's permissions are the per-client entry in configuration (FR-MCP-06, FR-OPS-04).
3. OAuth on **stdio** would add no trust boundary beyond the local spawn, and would push token storage toward what
   [ADR-0003](0003-no-credential-handling.md) avoids for provider credentials. Network OAuth is a separate boundary
   and is designed in ADR-0041 (Switchboard-issued client tokens, hashed, never provider credentials).

## Decision

1. **Stdio is the only transport.** The MCP server performs no authorization flow of any kind. The trust binding of an
   MCP client is the `serve --client <id>` launch and its configuration entry (FR-OPS-04), as today.
2. **Any credential for stdio comes from the environment.** If a future stdio client must prove identity, the
   configuration may name an environment variable that holds the secret; it shall not hold the value. The value is
   compared in memory and never logged or returned (NFR-SEC-01, FR-TEL-03). This is **Proposed** and off by default;
   Q-66 asks the owner whether any such check is wanted.
3. **OAuth is not adopted on stdio.** Stdio keeps launch binding only (Q-66). OAuth 2.1 applies to the network
   transport designed in [ADR-0041](0041-http-transport-with-oauth-2-1.md), not to this ADR's stdio surface.
4. **The HTTP transport is designed in ADR-0041.** Q-67 decided to build Streamable HTTP (M13). ADR-0041 covers OAuth
   2.1 with PKCE, resource indicators, audience-bound tokens and no token passthrough. A static bearer token in
   configuration is not used for a network listener. Stdio behaviour in this ADR is unchanged.

## Alternatives considered

- **OAuth 2.1 on stdio now.** Rejected. The specification excludes stdio, the controller would store tokens (ADR-0003),
  and the flow protects no boundary the local spawn does not already protect.
- **Static bearer token on a loopback HTTP listener.** Rejected for now. It opens a network surface on the operator's
  machine, which ADR-0011 and ADR-0029 already rule out for the controller and its shim.
- **Mutual TLS on a network listener.** Not evaluated in depth. It would be considered within the revisit step in item
  4, not now.

## Consequences

- Operators see no login step for MCP clients. Security rests on the local user and the config entry, as ADR-0011
  states.
- No OAuth or token store is added for the stdio path.
- FR-MCP-11 and ADR-0041 gate any network listener; stdio stays as this ADR describes.

## Revisit when

- ADR-0041 is accepted or revised after T13.1; stdio rules here stay unless Q-66 is reopened.
- The owner asks for multi-user or hosted use, which ADR-0011 excludes.
- The MCP specification changes its stdio guidance.
