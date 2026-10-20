# ADR-0065: Client ID Metadata Documents beside Dynamic Client Registration

- Status: Accepted for the direction (owner decision 77, enhancement discovery 2026-10-19 add rank 4, FR-MCP-19); the
  mechanism below is Delegated (Linus, WORK QUEUE v10, 2026-10-19), not owner-approved line by line. Extends
  [ADR-0041](0041-http-transport-with-oauth-2-1.md) item 3 (client registration): Dynamic Client Registration stays
  exactly as decided and built (T13.7); this ADR adds a second way for a public client to identify itself.
- Date: 2026-10-19
- Decided by: zemdregon for the direction (owner decision 77 added T13.11). The mechanism is Delegated (agent,
  2026-10-19) under the WORK QUEUE v10 decisions recorded in
  [ROADMAP T13.11](../ROADMAP.md#610-m13-network-mcp-transport-tasks): (a) on by default for the HTTP transport's
  authorization server only, off by `transport.http.cimd: false`, stdio unaffected; (b) no caching of metadata
  documents across consents; (c) IPv4-mapped IPv6 and NAT64 forms of blocked ranges are blocked too.
- Related: FR-MCP-19, FR-MCP-16, FR-MCP-17, NFR-SEC-05, CAP-1,
  [ADR-0041](0041-http-transport-with-oauth-2-1.md), [ADR-0062](0062-mcp-sdk-v2-dual-era-http.md),
  [LLD §20.11](../design/LLD.md#2011-mcp-sdk-v2-and-client-id-metadata-documents-fr-mcp-18-fr-mcp-19-t1310-t1311),
  [HLD TB-12](../design/HLD.md#3-trust-boundaries).

## Context

The embedded authorization server (ADR-0041) knows a client only through Dynamic Client Registration (RFC 7591,
T13.7): a client posts its metadata, gets a random `sbc_` identifier and waits, `pending`, for the operator's consent.
The MCP ecosystem is moving to Client ID Metadata Documents (`draft-ietf-oauth-client-id-metadata-document`, "CIMD"):
the client's identifier is an `https` URL, and the JSON document at that URL carries the same RFC 7591 metadata. The
v2 SDK (ADR-0062) deprecates client-side DCR in favour of it. FR-MCP-19 asks for CIMD beside DCR.

CIMD moves one thing across a trust boundary: the authorization server now makes an **outbound request to a URL chosen
by an unauthenticated caller**, since anyone can open `GET /authorize?client_id=https://...`. The draft's §8.6 names
the consequence (server-side request forgery against loopback, private and link-local services, cloud metadata
endpoints included) and requires that such addresses are never fetched. `oauth_client` and `http_subject` enforce
the `sbc_` identifier form by `CHECK` (`oauth_token` keys by the same identifier without a `CHECK`), and the
`transport.http.clients` mapping is keyed by it.

Verified on 2026-10-19 from the draft's text (not from memory): the Client Identifier URL must be `https`, must have a
path component and no userinfo or fragment, should not have a query, and is compared by simple string comparison; the
document must carry a `client_id` equal to the URL used to fetch it; it must be served with `200` as JSON; the server
must not follow redirects when fetching it; the server should display the URL's host on the consent page; and
`client_id_metadata_document_supported` is the authorization-server metadata flag.

## Decision

1. **A URL `client_id` is a CIMD client, on by default for the HTTP transport's authorization server.**
   `transport.http.cimd` (default `true`) enables it; `false` makes such a `client_id` an unknown client with no fetch.
   Stdio has no authorization server and is unaffected.
2. **The identifier is checked before anything else:** `https`, its own WHATWG serialisation, a DNS-name host (an IP
   literal is refused), a path other than `/`, no userinfo, query, fragment or dot segments, and at most 2048
   characters (`checkCimdClientId`, which takes no issuer). The server then refuses its own origin (`cimd_self`)
   before fetching, since that document would be served by Switchboard itself.
3. **The fetch is bounded and pinned.** The server resolves the host itself and refuses the client when **any**
   resolved address is special-use: unspecified, loopback, private, shared address space, link-local, unique-local,
   multicast, documentation, benchmarking or reserved space, and the IPv4-mapped and NAT64 (RFC 6052 well-known prefix)
   forms of a blocked IPv4 range (decision (c)), as well as the 6to4 and Teredo forms and the whole NAT64 local-use
   prefix `64:ff9b:1::/48` (Delegated fail-closed hardening of the same policy). The TLS connection is pinned to the
   checked address with the server name set to the host, so there is
   no second resolution to race. One `GET`; a redirect of any status is refused (the draft's MUST NOT, tightening LLD
   §20.11's Proposed "at most one"); the response must be `200` with a JSON media type; the whole fetch, resolution
   included, ends after 5 s; a body over 64 KiB, declared or received, is refused unparsed. At most two fetches run at
   once. The trust store is Node's default; a certificate authority can be injected only through the fetcher's
   constructor (tests), never through a global switch.
4. **The document is validated like a registration request.** Its `client_id` must equal the identifier exactly; the
   rest passes the same checks as RFC 7591 registration (public client, `https` redirect URIs only, the code grant).
   Nothing from the document is trusted beyond that.
5. **A CIMD client is keyed internally by `sbc_` + 128 bits of the URL's SHA-256**, stored in `oauth_client` like a
   registered client with the URL beside it in a new, additive table `oauth_cimd_client` (migration 0028). Tokens,
   meta-session bindings and the `transport.http.clients` mapping keep working unchanged; `oauth_client_id` in that
   mapping may be the URL itself, which config load maps to the derived identifier.
6. **Consent decides, as before (FR-MCP-17).** A new URL creates a `pending` client under the same registration cap as
   DCR (checked before the fetch); the first consent approves it; a denied or revoked client gets no fetch on its
   behalf. Every authorization request fetches the document afresh and refreshes the stored metadata (decision (b));
   `POST /token` never fetches. The consent page shows the URL as the client id and its host on its own line, labelled
   as the fact the client's document cannot choose.
7. **Audit:** `cimd_fetched` and `cimd_refused` events with the derived client id, the host and a reason code; never
   the document. A refused document is an error page with no redirect, like an unknown client.

## Consequences

- A remote client can now use the identifier form the ecosystem is moving to, without registering first, while the
  operator still approves every client on the consent page and still sees a host name the client did not choose.
- The server has one new outbound path, limited by design: resolution-time address policy, pinned connection, no
  redirects, time and size caps, a concurrency cap and the pending cap. The residual risk is a public host that the
  operator would not want contacted; the fetch reveals only that Switchboard asked for a metadata document.
- A host that is *meant* to be private (a development client on loopback) cannot be a CIMD client: the draft's
  development-only loopback exception is not implemented (fail closed). Such a client registers through DCR instead.
- The table is migration 0028: `0027_verification_result` (T8.10) reached `main` first, so the CIMD table took the
  next free number on the merge.

## Alternatives considered

- **Store the URL as the client id.** Rejected: three released migrations check the `sbc_` form and would need
  rebuilding; the derived identifier keeps every table and the config mapping unchanged.
- **Cache fetched documents.** Rejected by decision (b): the simplest fail-closed behaviour is to look again each time,
  since the draft lets documents change and consent is per request anyway.
- **Follow one redirect.** Rejected: the draft forbids it, and refusing is strictly safer than checking the target.
- **A loopback exception for development.** Rejected: the draft allows it only for development deployments and
  Switchboard cannot tell those apart; DCR covers the case.
