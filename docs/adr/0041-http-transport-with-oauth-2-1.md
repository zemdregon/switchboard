# ADR-0041: Network MCP transport (Streamable HTTP) with embedded OAuth 2.1

- Status: Proposed
- Date: 2026-10-14
- Decided by: Delegated (Linus, 2026-10-14), recording the owner decision that Switchboard will be embedded in
  Grok Bot as a public-facing MCP server, so HTTP transport and OAuth are critical. Under [owner
  decision 25](../ROADMAP.md#42-owner-decisions) for everything outside bypass mode. Q-67 is **Yes** (build it).
  Not owner-approved line-by-line; T13.1 may revise implementation details before this ADR is Accepted.
- Supersedes (once accepted): the deferral of the HTTP/SSE transport in [ADR-0002](0002-mcp-upstream-acp-downstream.md),
  and item 4 of [ADR-0040](0040-mcp-caller-authentication-no-oauth-on-stdio.md) is the gate this ADR answers. Neither is
  changed by this document; the status of ADR-0002 changes only when this ADR is accepted.
- Builds on: [ADR-0011](0011-single-operator-local-deployment.md) (single operator),
  [ADR-0003](0003-no-credential-handling.md)
  (no provider credential handling; this ADR's tokens are Switchboard's own client tokens and are a new boundary),
  [ADR-0004](0004-trust-profiles-no-bypass-flags.md), [ADR-0019](0019-per-client-privileged-approval.md).
- Related: FR-MCP-06, FR-MCP-11 to FR-MCP-15, FR-OPS-03, FR-OPS-04, FR-OPS-02, NFR-SEC-01, FR-TEL-03, Q-66, Q-67.

## Context

Remote MCP clients reach a server over the network. Switchboard's MCP server is stdio-only today (FR-MCP-01). The
owner decided (Q-67, 2026-10-14) that Switchboard will be embedded as a public-facing MCP server, so a network
transport is a core priority (M13). That crosses a new trust boundary and needs this ADR before any code.

The MCP authorization specification (2025-11-25 revision) applies to HTTP transports. It requires OAuth 2.1 with PKCE
for public clients, protected-resource metadata (RFC 9728), resource indicators (RFC 8707) so tokens are bound to the
MCP server, validation of token audience at the server, and no passthrough of tokens to upstream services. Stdio stays
on launch binding only ([ADR-0040](0040-mcp-caller-authentication-no-oauth-on-stdio.md)).

## Decision (proposed)

1. **Transport.** Streamable HTTP is the only network transport. SSE is not added. The listener is off by default. When
   enabled it binds to loopback by default. A non-loopback bind is refused unless the operator sets an explicit option
   and a TLS terminator or relay they run is in front of it. Plain HTTP is refused unless the listener is on loopback
   behind a configured TLS proxy. Origin headers are validated on every request to block DNS-rebinding from browsers.
2. **Authorization server (default).** Switchboard runs its **own embedded OAuth 2.1 authorization server**. There is
   no external IdP by default. It publishes AS metadata (RFC 8414) and protected-resource metadata (RFC 9728). The
   resource identifier (audience) is this server's MCP endpoint URL. An external IdP remains a later option, not the
   default.
3. **Client registration and consent.** Dynamic Client Registration (RFC 7591) is supported. The operator approves each
   new client on a local consent page. Sign-in uses a locally set operator passphrase (argon2id hash in config). A
   one-time pairing code from `switchboard auth pair` is the fallback. Manual registration remains possible.
4. **Token issuance.** Authorization code with mandatory PKCE S256 only. Resource indicators (RFC 8707) bind tokens to
   this server's audience. Access tokens are short-lived; refresh tokens rotate. Tokens are stored hashed in the ledger
   and are revocable with `switchboard auth revoke`. Every issue, refresh and revocation is audit-logged with no token
   values.
5. **Token checks.** On each MCP request the server verifies signature or introspection, expiry, issuer, and that the
   audience equals its own resource identifier. A token for any other resource is rejected. The server never forwards
   the inbound token to any upstream provider; provider credentials are untouched (ADR-0003).
6. **Scopes map to trust.** Each OAuth scope maps to a configured MCP client entry, which carries the maximum trust
   profile (FR-MCP-06). A token can never raise a client above its configured maximum. Scopes never grant `privileged`
   by default (ADR-0019): approval stays with the operator CLI.
7. **Sessions.** Each Streamable HTTP session is bound to the token subject that opened it. A request with a different
   subject, or a session ID from a different client, is refused. Session IDs are unguessable and are never accepted as
   authentication on their own.
8. **Secrets and logs.** Tokens, authorization codes, pairing codes and passphrases are never written to the ledger,
   logs, telemetry or MCP responses (NFR-SEC-01, FR-TEL-03). Only hashes and audit metadata are stored.
9. **Off by default.** The HTTP transport is compiled in only when the operator enables it in configuration. With it
   off, behaviour is unchanged (stdio only).

## Consequences

- Switchboard gains a new trust boundary (internet-facing or relay-facing HTTP) and an embedded authorization server.
  Both must appear in the HLD threat model (TB-12) before implementation.
- The operator sets a local passphrase and approves clients; Switchboard does not depend on an external IdP for the
  default path. Hashed tokens and revocations live in the ledger.
- Remote clients inherit the same policy engine as local ones. Remote use does not add capability beyond configured
  trust caps.
- Fail-closed: missing or wrong audience, unlisted Origin, plain HTTP without the loopback+TLS-proxy exception, or a
  `privileged` claim without operator approval is refused.

## Alternatives considered

- **External authorization server only.** Rejected as the default. Embedding Switchboard in Grok Bot as a public MCP
  server needs a self-contained AS; an external IdP stays a later option.
- **Bearer token in configuration.** Rejected. It has no audience binding, no expiry or rotation, and cannot be revoked
  per client without restarting the server.
- **Mutual TLS.** Deferred. It fits machine clients better than interactive operator consent.
- **Defer the network transport (fail-closed).** Rejected by Q-67 (owner, 2026-10-14): HTTP and OAuth are critical for
  the Grok Bot embedding.

## Open questions

- **Mobile connector auth (unverified):** which authentication methods the Claude mobile app accepts for a custom
  remote connector. Confirm before relying on that client.
- **External IdP:** keep as a later optional mode; not required for M13 acceptance.
- **T13.1 spike:** confirm MCP SDK Streamable HTTP and how the embedded AS mounts beside the resource server.

## Revisit when

- T13.1 produces evidence that revises any item above (then Accept or revise this ADR).
- The MCP authorization specification changes its requirements.
- The HLD threat model gains a network trust boundary that this ADR does not cover.
