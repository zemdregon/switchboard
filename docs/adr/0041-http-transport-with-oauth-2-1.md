# ADR-0041: Network MCP transport (Streamable HTTP) protected by OAuth 2.1

- Status: Proposed
- Date: 2026-10-14
- Decided by: Delegated (agent, 2026-10-14, at the owner's request), under [owner
  decision 25](../ROADMAP.md#42-owner-decisions) for everything outside bypass mode. Not a zemdregon quote and not
  owner-approved. Whether to build the transport at all is an owner decision still open (Q-67).
- Supersedes (once accepted): the deferral of the HTTP/SSE transport in [ADR-0002](0002-mcp-upstream-acp-downstream.md),
  and item 4 of [ADR-0040](0040-mcp-caller-authentication-no-oauth-on-stdio.md) is the gate this ADR answers. Neither is
  changed by this document; the status of ADR-0002 changes only when this ADR is accepted.
- Builds on: [ADR-0011](0011-single-operator-local-deployment.md) (single operator, local), [ADR-0003](0003-no-credential-handling.md)
  (no token handling for providers; this ADR's tokens are Switchboard's own client tokens and are a new boundary, see
  below), [ADR-0004](0004-trust-profiles-no-bypass-flags.md), [ADR-0019](0019-per-client-privileged-approval.md).
- Related: FR-MCP-06, FR-MCP-11, FR-OPS-03, FR-OPS-04, FR-OPS-02, NFR-SEC-01, FR-TEL-03, Q-66, Q-67.

## Context

Remote MCP clients such as the Claude mobile app reach a server over the network. Switchboard's MCP server is stdio-only
today (FR-MCP-01). A network transport would expose `delegate_task` and `continue_task` beyond the local machine, so
it crosses a new trust boundary and needs this ADR before any code.

The MCP authorization specification (2025-11-25 revision, read through its published page) applies to HTTP transports.
It requires OAuth 2.1 with PKCE for public clients, protected-resource metadata (RFC 9728), resource indicators (RFC
8707) so tokens are bound to the MCP server, validation of token audience at the server, and no passthrough of tokens
to upstream services. Stdio implementations are told to read credentials from the environment instead.

## Decision (proposed)

1. **Transport.** Streamable HTTP is the only network transport. SSE is not added. The endpoint binds to loopback by
   default. A non-loopback bind is refused unless the operator sets an explicit option and a TLS terminator or relay
   they run is in front of it. Switchboard does not terminate public TLS itself in this design. Origin headers are
   validated on every request to block DNS-rebinding from browsers.
2. **Authorization server.** Switchboard does not run an authorization server. The operator configures an external
   OAuth 2.1 authorization server by issuer URL. Switchboard publishes protected-resource metadata (RFC 9728) that names
   that issuer and its own resource identifier. The resource identifier is the MCP endpoint URL.
3. **Client registration.** Client ID Metadata Documents are preferred. Dynamic Client Registration is accepted only if
   the operator enables it on the authorization server. Manual registration is always possible.
4. **Token checks.** On each MCP request the server verifies signature or introspection, expiry, issuer, and that the
   audience equals its own resource identifier (RFC 8707). A token for any other resource is rejected. The server never
   forwards the inbound token to any upstream provider; provider credentials are untouched (ADR-0003).
5. **Scopes map to trust.** Each OAuth scope maps to a configured MCP client entry, which carries the maximum trust
   profile (FR-MCP-06). A token can never raise a client above its configured maximum. The mapping is configuration,
   not a claim the token carries. Scopes never grant `privileged` (ADR-0019): approval stays with the operator CLI.
6. **Sessions.** Each Streamable HTTP session is bound to the token subject that opened it. A request with a different
   subject, or a session ID from a different client, is refused. Session IDs are unguessable and are never accepted
   as authentication on their own.
7. **Secrets and logs.** Tokens, authorization codes and client secrets are never written to the ledger, logs,
   telemetry or MCP responses (NFR-SEC-01, FR-TEL-03).
8. **Off by default.** The HTTP transport is compiled in only when the operator enables it in configuration, with the
   issuer and client mapping set. With it off, behaviour is unchanged.

## Consequences

- Switchboard gains a new trust boundary (internet-facing or relay-facing HTTP) and a new dependency on an external
  authorization server. Both must appear in the HLD threat model before implementation.
- The operator runs an authorization server, or uses a hosted one, and manages its client registrations. Switchboard
  stores no user password and no user account.
- Remote clients inherit the same policy engine as local ones. Remote use does not add capability.
- Relay tools such as sparfenyuk/mcp-proxy or supergateway would sit in this path if used. Their OAuth support is
  unverified, so one would be evaluated against items 1 to 6 before use.

## Alternatives considered

- **Bearer token in configuration.** Rejected. It has no audience binding, no expiry or rotation, and cannot be revoked
  per client without restarting the server.
- **Mutual TLS.** Deferred. It fits machine clients better than a mobile app, and the mobile connector path is not
  verified (see open question below).
- **Use a third-party relay as the auth layer.** Rejected. It moves the trust decision out of the design and keeps the
  controller's policy exposed without a matching threat model.

## Open questions

- **Q-67 (owner):** Should a network transport be built at all? Proposed default: no, until a concrete remote client
  needs it.
- **Mobile connector auth (unverified):** which authentication methods the Claude mobile app accepts for a custom
  remote connector. This must be confirmed before implementation.
- **Authorization server:** operator-provided, or documented as a requirement only? Proposed: operator-provided.

## Revisit when

- The owner decides on Q-67, or a remote client is confirmed to need the transport.
- The MCP authorization specification changes its requirements.
- The HLD threat model gains a network trust boundary that this ADR does not cover.
