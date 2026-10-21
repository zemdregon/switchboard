# ADR-0083: CLI-issued, profile-bound one-time codes for MCP OAuth, per-IP lockout, revocation and operator OAuth CLI

- Status: Accepted for the direction (owner request, 2026-10-21, quoted below); the mechanism is Delegated (agent,
  2026-10-21) under [owner decision 25](../ROADMAP.md#42-owner-decisions) and is not owner-approved line by line. Extends
  [ADR-0041](0041-http-transport-with-oauth-2-1.md) items 3 and 4 (consent sign-in; token issuance and the operator
  revocation command that item 4 records as not built). The embedded authorization server, Dynamic Client
  Registration, the passphrase and the unbound pairing code stay exactly as decided and built.
- Date: 2026-10-21
- Decided by: zemdregon for the direction. Owner request, 2026-10-21, verbatim: "switchboard needs to support oauth
  mcp, not just authorization bearer token. it must have a built in oauth provider no need to connect an oauth
  server. something like generating a one time use token from cli or something." Everything below the request
  (the code's profile binding, its lifetime bounds, the lockout, the revocation endpoint, the CLI and the MCP tool) is
  **Delegated**; it changes nothing a bypass run may do (owner decision 25).
- Related: FR-MCP-20 to FR-MCP-25, FR-MCP-13 to FR-MCP-17, FR-OPS-03, NFR-SEC-01, NFR-SEC-03, FR-TEL-03, CAP-1,
  [ADR-0041](0041-http-transport-with-oauth-2-1.md), [ADR-0040](0040-mcp-caller-authentication-no-oauth-on-stdio.md),
  [LLD §3.3](../design/LLD.md#33-network-mcp-transport-m13), [HLD TB-12](../design/HLD.md#3-trust-boundaries),
  ROADMAP T13.12.

## Context

ADR-0041 built an embedded OAuth 2.1 authorization server: a remote client registers (DCR or CIMD), is `pending`, and
the operator approves it on a consent page with a passphrase or an unbound pairing code (`consent pair`). What is
missing for the request above:

- The pairing code approves a client but says nothing about *what the client may do*. Which MCP client entry (and so
  which trust ceiling, project list and approval rule) an OAuth client reaches is set only by editing
  `transport.http.clients` in configuration or falling back to `default_mcp_client`, keyed by a `sbc_` identifier the
  operator cannot know before the client registers. The operator's natural flow is "issue a code for this profile, hand
  it to the connector, done".
- Wrong passphrases and codes are throttled globally only, so one hostile address can hold the sign-in locked for
  everyone, and behind a relay every request appears to come from the relay.
- There is no way to revoke a token as a client (RFC 7009), and the operator has no command to list, inspect or revoke
  OAuth clients and tokens (ADR-0041 item 4: "The operator revocation command is not built yet").
- An orchestrator has no way to see which OAuth clients exist.

## Decision

1. **Profile-bound one-time codes.** `switchboard mcp oauth issue-code --client-profile <mcp_client_id> [--ttl
   <n>s|m|h]` prints a single-use code (Switchboard's own secret, never a provider credential, shown once).
   The code is 128 random bits behind a fixed prefix, stored only as its SHA-256 in the ledger (migration 0037, which
   adds a profile column to the pairing code and a binding to the client); the lifetime defaults to 10 minutes and must
   lie between 1 and 60 minutes. Issuing a code ends every older unused code (supersede, not accumulate). The code is
   typed into the consent page's existing pairing-code field; redeeming it approves the pending client and binds it to
   the profile. It is spent on first use and cannot be redeemed again or after expiry. `consent pair` (unbound) and the
   passphrase keep working unchanged.
2. **Which profiles may be offered over HTTP.** At issue time the profile must exist in `mcp_clients` and must be one
   that configuration load would accept as an HTTP target: a `privileged` ceiling, or `privileged_approval:
   not_required`, is refused (ADR-0041 item 6, FR-MCP-14). Privileged runs stay unavailable over HTTP; a code never
   widens a ceiling. A client already bound to a different profile is refused at redemption (re-binding is done by
   revoking the client, then redeeming a new code).
3. **Binding is stored and re-checked.** The binding is a ledger row keyed by the OAuth client. At `/mcp` the profile is
   resolved in this order: the `transport.http.clients` map (configuration wins), then the ledger binding, then
   `default_mcp_client`. A ledger-bound profile must also pass the stricter rule load applies to `default_mcp_client`
   (no `privileged` ceiling, approval required). The result is re-checked at request time against the current
   configuration and the client's approved state, and any failure (profile removed from configuration, now disallowed
   as an HTTP target, client revoked) is a refusal, never a fallback to a laxer profile.
4. **Per-IP lockout.** Ten wrong passphrases or codes from one address within 5 minutes lock sign-in attempts from that
   address for 15 minutes (the constants the operator's own gate uses). The existing global throttle stays as a second
   layer. The optional `transport.http.client_ip_header` (for example `cf-connecting-ip`) names the header carrying the
   real client address, and is honoured only when the TCP peer is loopback, which is where the operator's TLS
   terminator runs; from any other peer the header is ignored. Unset, the peer address is used.
5. **Revocation endpoint (RFC 7009).** `POST /revoke` for public clients, `client_id` required (`token_endpoint_auth_method:
   none`). A token belonging to that client is revoked (revoking a refresh token revokes its access tokens); an unknown
   token, or one of another client, answers 200 and does nothing, as RFC 7009 requires, so the endpoint is not an oracle.
   AS metadata advertises `revocation_endpoint`.
6. **Operator OAuth CLI.** `switchboard mcp oauth clients`, `client <client_id>`, `tokens [--client <id>] [--all]` and
   `revoke <client_id> [--tokens-only]`, each with `--json`. They show identifiers, names, state, bound profile and
   times, never a token, code or hash. `revoke` ends the client's tokens and, unless `--tokens-only`, the client itself.
   This fulfils ADR-0041 item 4's operator revocation command (named `mcp oauth revoke` here rather than `auth revoke`,
   because FR-OPS-03 keeps `auth` out of the CLI).
7. **MCP visibility.** A read-only MCP tool, `list_oauth_clients`, offered to stdio callers only (never over HTTP, so a
   remote client cannot enumerate its peers), returns the same non-secret fields.
8. **Audit.** Every code issue and redemption, grant, refresh, revocation (endpoint and CLI) and lockout is an audit
   event carrying identifiers and reason codes, never a token, code, hash or passphrase.
9. **The operator's prod gate.** An operator-run gate in front of Switchboard that accepts static bearer tokens keeps
   working and now forwards OAuth traffic (`/authorize`, `/token`, `/register`, `/revoke`, `/.well-known/*`, `/mcp`
   with an OAuth token) to Switchboard instead of duplicating it. The gate is operator deployment outside this
   repository; this ADR makes no claim about its code.

## Consequences

- The operator can connect a hosted connector by issuing a code, giving the connector the public URL and typing the
  code on the consent page. No external identity provider is involved, matching the request.
- A code is a bearer credential for the minutes it lives. It is short, single-use, hashed at rest, superseded by the
  next issue, bound to one profile with a ceiling that cannot be `privileged`, and its redemption still happens on the
  CSRF-protected consent page the operator reaches (not by the remote client alone).
- The profile binding adds trust state to the ledger: a bound client's reach is whatever its profile grants, so the
  operator should issue codes only for profiles they would expose over HTTP. Config still wins over a binding, so a
  configured mapping is a hard override.
- `client_ip_header` trusts a header only from loopback. A misconfigured proxy that forwards a client-supplied header
  is the operator's deployment fault; the default (unset) is the safe choice.
- One new migration (0036) and four endpoints/commands; no change to token format, PKCE, audience binding or
  rotation.

## Alternatives considered

- **Make the code reusable or long-lived.** Rejected: a leaked reusable code would be a standing credential.
- **Let a code carry a free-form ceiling.** Rejected: the ceiling already lives in `mcp_clients`; a binding names a
  profile and inherits it, so there is one place to read the policy.
- **Trust `X-Forwarded-For` by default.** Rejected: spoofable; an explicit header name honoured from loopback only is
  fail-closed.
- **Make `/revoke` return 404 or 400 for an unknown token.** Rejected: RFC 7009 requires 200 and an error would be a
  token-existence oracle.
- **Expose client management over HTTP.** Rejected: operator control stays at the terminal and the stdio MCP server
  (FR-OPS-03).
