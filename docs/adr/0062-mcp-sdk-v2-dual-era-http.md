# ADR-0062: MCP TypeScript SDK v2 packages and dual-era serving on the network transport

- Status: Accepted for the direction (owner decision 77, enhancement discovery 2026-10-19 add rank 4, FR-MCP-18); the
  mechanism below is Delegated (Linus, WORK QUEUE v10, 2026-10-19), not owner-approved line by line. Supersedes
  [ADR-0041](0041-http-transport-with-oauth-2-1.md) **in part**: only its SDK and protocol-era statements (the
  2025-11-25-only era in its Context and the T13.1 answer that mounts the v1 `StreamableHTTPServerTransport`). Every
  numbered ADR-0041 decision stays as decided, including item 7 as built (no session id is issued or accepted).
- Date: 2026-10-19
- Decided by: zemdregon for the direction (owner decision 77 added T13.10). The mechanism, the package set and the era
  handling are Delegated (agent, 2026-10-19) under the
  [readiness spike](../research/mcp-2026-07-28-readiness-spike-2026-10-15.md) Phase B and the WORK QUEUE v10
  decisions recorded in [ROADMAP T13.10](../ROADMAP.md#610-m13-network-mcp-transport-tasks): the ADR ships in the
  same pull request as the code, committed first (v10-D1); server-side Dynamic Client Registration stays as is (the
  v2 client-side DCR deprecation does not change the server; T13.11 adds CIMD beside it); the 2026 Tasks extension
  is out of scope.
- Related: FR-MCP-18, FR-MCP-01, FR-MCP-12 to FR-MCP-17, NFR-SEC-01, NFR-SEC-05, CAP-1, R-81,
  [ADR-0002](0002-mcp-upstream-acp-downstream.md), [ADR-0040](0040-mcp-caller-authentication-no-oauth-on-stdio.md),
  [ADR-0041](0041-http-transport-with-oauth-2-1.md), [ADR-0047](0047-approval-proxy-over-mcp.md),
  [LLD §20.11](../design/LLD.md#2011-mcp-sdk-v2-and-client-id-metadata-documents-fr-mcp-18-fr-mcp-19-t1310-t1311),
  [TDD §3.14](../design/TDD.md#314-network-mcp-transport-m13).

## Context

Switchboard pinned `@modelcontextprotocol/sdk` 1.32.1 (TDD §3.14, ADR-0041 T13.1 answer). The MCP 2026-07-28
revision replaces the `initialize` handshake and `Mcp-Session-Id` with a per-request `_meta` envelope and
`server/discover` (spike S2), and the TypeScript SDK v2 (`@modelcontextprotocol/server`, `client`, `core`, 2.3.1 on
npm on 2026-10-19; `@modelcontextprotocol/sdk` latest stays 1.32.1) implements both eras on one codebase (spike S5,
S6, S10). The v1 line stops receiving fixes about six months after v2 (R-81, Secondary source), and the public MCP
endpoint (Q-67) must keep serving the clients it has today while new clients move to 2026-07-28.

Verified on 2026-10-19 from the installed 2.3.1 typings and a runtime probe (not from memory):

- `@modelcontextprotocol/server` exports the low-level `Server` (deprecated in favour of `McpServer`, kept for
  "advanced use cases"); `setRequestHandler` now takes the method name (`"tools/list"`, `"tools/call"`) and a
  `(request, ctx)` handler instead of a zod request schema. `McpServer.registerTool` still takes zod schemas, so the
  TDD §2 choice (Ajv JSON Schemas from `src/mcp/schemas.ts`, zod not imported) still needs `Server`.
- `@modelcontextprotocol/server/stdio` exports `StdioServerTransport` (same constructor) and a new `serveStdio`
  factory entry. A `Server` connected by hand to `StdioServerTransport` serves a 2025-era `initialize` exactly as
  before; the v2 `Client` defaults to that legacy handshake (`versionNegotiation` is opt-in).
- HTTP: `createMcpHandler(factory, options)` is web-standard (`fetch(Request) → Response`); `isLegacyRequest`
  is the same classification the entry uses; `WebStandardStreamableHTTPServerTransport` keeps the stateless mode
  (`sessionIdGenerator: undefined`) with `enableJsonResponse` and a `maxRequestBodySize` cap. The SDK's own
  `legacy: "stateless"` fallback answers 2025-era POSTs as SSE streams, not JSON. The node:http adapter lives in a
  separate package, `@modelcontextprotocol/node`, whose latest release (2.1.1) is not in lockstep with 2.3.1.
- Neither era issues a session id: a v2 client's `transport.sessionId` stays `undefined` on both legs, and a
  2026-07-28 request carries `MCP-Protocol-Version: 2026-07-28` plus the envelope instead.

## Decision

1. **Packages.** `@modelcontextprotocol/server`, `@modelcontextprotocol/client` and `@modelcontextprotocol/core`,
   each exact-pinned at 2.3.1, replace `@modelcontextprotocol/sdk`. `client` is a runtime dependency because the fake
   provider CLI shipped in `dist` (`src/adapters/fake/cli.mjs`) is an MCP client; `core` is pinned explicitly so the
   shared core the two depend on is visible in `package.json`. `@modelcontextprotocol/node` is not added: the
   node:http to web `Request`/`Response` bridge is a few lines in `src/mcp/http.ts` and does not lag the server
   package.
2. **Server construction (unchanged in kind).** `src/mcp/server.ts` and the Git tool shim keep the low-level
   `Server` with `tools/list` and `tools/call` handlers, now registered by method name, publishing the Ajv-validated
   JSON Schemas. Every validation, scope, trust-profile, tool-profile and scrubbing check is untouched.
3. **Stdio (unchanged).** `startStdioServer` still connects one `Server` to `StdioServerTransport`; the connection
   follows the client's opening exactly as today. `serveStdio` is not adopted: it owns the transport lifecycle that
   `switchboard serve` owns (reconciliation first, shutdown last) and would add a discarded probe instance per
   connection. A client that opens with the 2025-era handshake sees byte-equivalent behaviour (the unchanged stdio
   suites are the evidence).
4. **HTTP serves both eras, statelessly.** After Switchboard's own checks run unchanged (allowed `Origin`, bearer
   token, approved OAuth client, `mcp` scope, client mapping, POST only, `Mcp-Session-Id` refused, in-flight caps,
   `Authorization` and `Cookie` stripped), the request is classified with the SDK's `isLegacyRequest`:
   - a 2025-era request (an `initialize`, or any claim-less request) is served by a fresh
     `WebStandardStreamableHTTPServerTransport` in stateless mode with JSON responses and the existing body cap,
     connected to a fresh `SwitchboardMcpServer`, both closed when the response ends;
   - a 2026-07-28 request (envelope and `MCP-Protocol-Version` header) is served by one `createMcpHandler`
     per listener with `legacy: "reject"` and `responseMode: "auto"` (one JSON body unless a handler emits a related
     notification first, which no Switchboard tool does; `"json"` behaves the same for Switchboard but prints an SDK
     warning at construction), whose factory builds the same fresh `SwitchboardMcpServer` per request.
   One factory backs both legs so the eras cannot drift. The factory learns which configured MCP client and which
   OAuth client a request belongs to through a `WeakMap` keyed by the web `Request` object (the SDK hands the factory
   that same object), never through the SDK's `AuthInfo`: no token or token-derived value enters an SDK structure.
   Neither leg issues or accepts a session id, so ADR-0041 item 7 as built stands; a session id presented is still
   refused with 400 before classification.
5. **Not adopted now.** `subscriptions/listen`, multi-round-trip `input_required` results, the Tasks extension
   (out of scope by Linus decision), the SDK's bearer-auth, metadata and OAuth-router helpers (the ADR-0041 T13.1
   choice stands), and the v2 client-side DCR deprecation (Switchboard's embedded authorization server keeps RFC 7591
   registration with operator consent; T13.11 adds Client ID Metadata Documents beside it).
6. **Responses are plain JSON in both eras** (Delegated, as today): the legacy transport is built with
   `enableJsonResponse`, Switchboard tools emit no mid-call notifications on the modern leg, and the raw-request tests
   and the approval-proxy clients parse JSON bodies. A non-JSON request media type is refused with 415 before either
   leg parses the body (the SDK asks hand-wired compositions to do this themselves).

## Consequences

- The MCP server tracks a maintained SDK line (R-81 mitigated) and a 2026-07-28 client can call tools over HTTP
  without a session, while every 2025-era client keeps working with no configuration change.
- Two SDK serving paths exist on HTTP; both are per request and share one factory, so a tool added to the server is
  served to both eras by construction.
- The node:http bridge is Switchboard's code (`src/mcp/http.ts`) and is covered by the HTTP tests.
- Stdio gains nothing new yet; era negotiation on stdio (and `serveStdio`) is a later task if a target client
  documents 2026-07-28 on stdio.

## Alternatives considered

- **Keep v1 and wait.** Rejected: R-81 and the public endpoint (Q-67).
- **`createMcpHandler` with `legacy: "stateless"` alone.** Rejected: its legacy leg answers in SSE, which would
  change every 2025-era response shape and the raw-request tests; the hand-wired legacy leg keeps JSON.
- **`@modelcontextprotocol/node` for the bridge.** Rejected while it lags the server package (2.1.1 against 2.3.1).
- **Per-request identity through `AuthInfo`.** Rejected: `AuthInfo.token` is mandatory, so it would put a token or
  a placeholder into SDK structures that reach handlers; the `WeakMap` keeps identity outside the SDK.
- **`McpServer.registerTool`.** Rejected again: zod schemas (TDD §2).

## Evidence

- Runtime probe of 2.3.1 (2026-10-19): a `Server` with method-name handlers served a v2 `Client` over
  `InMemoryTransport`, over stdio (`StdioClientTransport`, legacy default) and over HTTP in both eras (default and
  `versionNegotiation: { mode: { pin: "2026-07-28" } }`), with `sessionId` undefined in both; oversize bodies got
  413 on both legs; a non-JSON media type got 415.
- Tests: `src/mcp/http-eras.test.ts` (both eras initialize and call a tool through the real token checks; no session
  id in any response; a session id is still refused); the unchanged `src/mcp/mcp.test.ts` T13.9 acceptance; every
  unchanged stdio and in-memory suite.

## Revisit when

- A target client documents 2026-07-28 on stdio (then `serveStdio` or era negotiation on stdio).
- `@modelcontextprotocol/node` is released in lockstep and the bridge can be dropped.
- The DCR deprecation window closes (T13.11, FR-MCP-19) or the SDK removes the low-level `Server`.
