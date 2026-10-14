# ADR-0041: Network MCP transport (Streamable HTTP) with embedded OAuth 2.1

- Status: Proposed (implementation gate for M13; Q-67 decided Yes)
- Date: 2026-10-14
- Decided by: Owner (zemdregon, 2026-10-13): build a public Streamable HTTP MCP server
  for embedding into Grok Bot. Auth defaults decided by Linus under delegated authority
  (owner decision 25) on 2026-10-14: Switchboard runs its own embedded OAuth 2.1
  authorization server. Recorded on PR #102 and corrected in docs after #102 merged with
  a stale "deferred" Q-67 row.
- Supersedes (once Accepted after T13.1): the deferral of the HTTP/SSE transport in
  [ADR-0002](0002-mcp-upstream-acp-downstream.md). Item 4 of
  [ADR-0040](0040-mcp-caller-authentication-no-oauth-on-stdio.md) is the gate this ADR
  answers for the network path. Stdio auth stays ADR-0040 (Accepted).
- Builds on: [ADR-0011](0011-single-operator-local-deployment.md) (single operator),
  [ADR-0003](0003-no-credential-handling.md) (no *provider* credential handling; this
  ADR's tokens are Switchboard's own client tokens and are a new boundary),
  [ADR-0004](0004-trust-profiles-no-bypass-flags.md),
  [ADR-0019](0019-per-client-privileged-approval.md).
- Related: FR-MCP-06, FR-MCP-11–15, FR-OPS-02–04, NFR-SEC-01, FR-TEL-03, Q-66, Q-67.

## Context

Remote MCP clients (including Grok Bot embedding Switchboard as a public MCP server)
reach a server over the network. Switchboard's MCP server is stdio-only today
(FR-MCP-01). A network transport exposes `delegate_task` and `continue_task` beyond the
local machine, so it crosses a new trust boundary and needs this ADR before any code.

The MCP authorization specification (2025-11-25 revision) applies to HTTP transports. It
requires OAuth 2.1 with PKCE for public clients, protected-resource metadata (RFC 9728),
resource indicators (RFC 8707), audience validation, and no passthrough of tokens to
upstream services. Stdio stays under ADR-0040 (no OAuth on stdio).

## Decision

1. **Transport.** Streamable HTTP is the only network transport. SSE is not added. The
   listener is off by default. When enabled, it may bind beyond loopback only with an
   explicit config option. Access is HTTPS only: plain HTTP is refused unless the
   listener is loopback behind a configured TLS reverse proxy or tunnel. The issuer URL
   comes from config when behind a proxy. `Origin` headers are validated on every
   request to block DNS-rebinding from browsers. Switchboard does not terminate public
   TLS itself in this design.
2. **Embedded authorization server.** Switchboard runs its own OAuth 2.1 authorization
   server. There is no external IdP by default. An external IdP remains a later option
   and is not the default. The AS implements:
   - Protected Resource Metadata (RFC 9728) and AS metadata (RFC 8414)
   - Dynamic Client Registration (RFC 7591)
   - Authorization code with mandatory PKCE S256
   - Resource indicators (RFC 8707), audience bound to this server's resource identifier
   - Short-lived access tokens and rotating refresh tokens
3. **Operator consent.** The operator approves each new client on a consent page. Sign-in
   uses a locally set operator passphrase (argon2id hash in config). A one-time pairing
   code from `switchboard auth pair` is the fallback. Tokens are stored hashed in the
   ledger and are revoked with `switchboard auth revoke`. Every token issue, refresh and
   revocation is written to the audit log with no token values.
4. **Token checks.** On each MCP request the server verifies signature or introspection,
   expiry, issuer, and that the audience equals its own resource identifier (RFC 8707).
   A token for any other resource is rejected. Missing or invalid tokens are refused
   (fail-closed). The server never forwards the inbound token to any upstream provider;
   provider credentials are untouched (ADR-0003).
5. **Scopes map to trust.** OAuth scopes map to configured MCP client / profile caps
   (FR-MCP-06). A token can never raise a client above its configured maximum. Scopes
   never grant `privileged` by default (ADR-0019): approval stays with the operator CLI.
6. **Sessions.** Each Streamable HTTP session is bound to the token subject that opened
   it. A request with a different subject, or a session ID from a different client, is
   refused. Session IDs are unguessable and are never accepted as authentication alone.
7. **Secrets and logs.** Tokens, authorization codes, pairing codes, passphrases and
   client secrets are never written to the ledger in cleartext, nor to logs, telemetry or
   MCP responses (NFR-SEC-01, FR-TEL-03). Hashes and audit metadata only.
8. **Off by default.** The HTTP transport and AS are compiled in only when the operator
   enables them in configuration. With them off, behaviour is unchanged (stdio only).

## Consequences

- Switchboard gains a network trust boundary and holds its own client-token store (hashed).
  Both must appear in the HLD threat model (TB-12) before implementation.
- The operator does not need a separate IdP for the default path. They set a passphrase
  (or use pairing codes) and approve clients on the consent page.
- Remote clients inherit the same policy engine as local ones. Remote use does not add
  capability beyond what the mapped client entry already allows.
- ADR-0003 still forbids handling *provider* credentials; Switchboard-issued client tokens
  are an explicit exception scoped to this ADR.

## Alternatives considered

- **Defer network transport until a remote client appears.** Rejected by the owner: Grok
  Bot embedding is the concrete remote client and makes HTTP + OAuth critical.
- **External authorization server only.** Rejected as the default. Extra operator
  dependency for the embed path; kept as a later option.
- **Bearer token in configuration.** Rejected. No audience binding, weak rotation, and
  awkward revocation per client.
- **Mutual TLS.** Deferred. Fits machine clients better than browser or bot embeds.

## Open questions

- **Mobile / bot connector auth (unverified):** confirm which auth methods Grok Bot and
  other MCP clients accept for a custom remote connector before T13.1 closes.
- **External IdP:** when, if ever, to document an operator-provided issuer as an optional
  mode alongside the embedded AS.

## Revisit when

- T13.1 spike evidence accepts or revises this ADR.
- The MCP authorization specification changes its requirements.
- The HLD threat model gains a network trust boundary this ADR does not cover.
