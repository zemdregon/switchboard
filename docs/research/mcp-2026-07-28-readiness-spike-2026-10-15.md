# MCP 2026-07-28 readiness spike (T14.12), 2026-10-15

- Date: 2026-10-15
- Status: Research input (Delegated agent work, documentation only; not owner-approved). Findings are **Proposed**
  until zemdregon accepts a follow-on roadmap task or ADR.
- Used by: [ROADMAP](../ROADMAP.md) T14.12, FR-MCP-12 to FR-MCP-17, [ADR-0041](../adr/0041-http-transport-with-oauth-2-1.md),
  [discovery note §4 and §6 recommendation 10](orchestration-layer-discovery-2026-10-15.md#4-landscape-what-comparable-tools-offer).
- Scope: SDK and spec support for the stateless core, Multi Round-Trip Requests (MRTR), `subscriptions/listen`, the
  Tasks extension, likely client support among Switchboard's target chat apps, and a **Proposed** path from Dynamic
  Client Registration (FR-MCP-16) toward Client ID Metadata Documents (CIMD). No code changes in this spike.

## Evidence labels

- **Verified (repo):** read in this repository on 2026-10-15.
- **Verified (web):** primary page retrieved on 2026-10-15 with URL cited.
- **Secondary:** third-party summary, not a primary spec or SDK source.
- **Inferred:** author judgement from the sources above.

## Primary sources

| ID | Source | Why it matters |
| --- | --- | --- |
| S1 | [MCP blog: 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/) | Announces stateless core, MRTR, `subscriptions/listen`, Tasks extension, CIMD over DCR, Tier 1 SDK updates |
| S2 | [Spec changelog 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog) | Normative list of breaking changes and deprecations (DCR deprecated, twelve-month window) |
| S3 | [Authorization (2026-07-28)](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) | CIMD SHOULD, DCR MAY for backward compatibility; client registration priority |
| S4 | [Tasks utility (2026-07-28)](https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/tasks) | Extension `io.modelcontextprotocol/tasks`; `tasks/get`, `tasks/update`, `tasks/cancel`; notifications via subscriptions |
| S5 | [TypeScript SDK v2 overview](https://ts.sdk.modelcontextprotocol.io/v2/) | v2 (`@modelcontextprotocol/server` / `client` / `core`) implements 2026-07-28 |
| S6 | [Upgrade v1 → v2](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2) | Package split, DCR deprecation in client (`registerClient`), experimental 2025 tasks removed, 2026 tasks in extension doc |
| S7 | [SDK release v2.3.1](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.3.1) | Published 2026-10-05; pairs with npm `@modelcontextprotocol/server` 2.3.1 |
| S8 | [SDK examples: `subscriptions/`](https://github.com/modelcontextprotocol/typescript-sdk/tree/v2.3.1/examples/subscriptions) | `subscriptions/listen`, `client.listen()`, `handler.notify` |
| S9 | [SDK examples: `mrtr/`](https://github.com/modelcontextprotocol/typescript-sdk/tree/v2.3.1/examples/mrtr) | `input_required` / `requestState` pattern |
| S10 | [SDK examples: `todos-server/`](https://github.com/modelcontextprotocol/typescript-sdk/tree/v2.3.1/examples/todos-server) | Dual-era (2025-11-25 and 2026-07-28) server on one codebase |
| S11 | [Claude Help: custom remote connectors](https://support.anthropic.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp) | Remote Streamable HTTP; OAuth client modes including published identity and auto-register |
| R1 | [ADR-0041](../adr/0041-http-transport-with-oauth-2-1.md) | Switchboard M13: Streamable HTTP, embedded AS, DCR (item 3), stateless MCP endpoint (item 7 as built) |
| R2 | [Discovery note §4](orchestration-layer-discovery-2026-10-15.md#4-landscape-what-comparable-tools-offer) | Prior summary of 2026-07-28 features and client unknowns |

## Switchboard today (Verified repo)

| Topic | As built | Gap vs 2026-07-28 |
| --- | --- | --- |
| TypeScript SDK | `@modelcontextprotocol/sdk` **1.32.1** (`package.json`) | v1 line; negotiates **2025-11-25** era on the wire (S6). |
| HTTP MCP shape | Per-request server instance; refuses `Mcp-Session-Id` (`src/mcp/http.ts`, ADR-0041 item 7) | **Application-level** statelessness matches the spec direction; wire still uses v1 SDK handshake semantics until SDK v2 + era negotiation. |
| OAuth registration | `POST /register` RFC 7591, pending operator approval (FR-MCP-16, R1 item 3) | Spec **deprecated** DCR in favour of CIMD (S2, S3); DCR remains valid during the deprecation window. |
| MRTR / elicitation | Provider elicitation refused (`-32601`); no server-initiated sampling | Switchboard does not need MRTR for its own tools today; spec replaces server-push elicitation with `input_required` (S2). |
| `subscriptions/listen` | Not implemented; MCP advertises tools only (discovery note §3) | No protocol-native change notifications to clients. |
| Tasks extension | Runs are Switchboard `run_id`s + `get_run` polling (FR-MCP-01) | Parallel model to MCP Tasks; not exposed as `io.modelcontextprotocol/tasks`. |

## SDK support (Verified web)

### Stateless core

- **Spec (S2):** Removes `initialize` / `initialized` and `Mcp-Session-Id`; each request carries
  `io.modelcontextprotocol/protocolVersion` and client capabilities in `_meta`; optional `server/discover` for
  capability discovery.
- **TypeScript SDK v2 (S5, S6, S10):** Implements 2026-07-28 via `versionNegotiation`, per-request envelopes
  (`ctx.mcpReq.envelope`), and dual-era servers (`todos-server` serves 2025 and 2026 on the same process).
- **Switchboard fit (Inferred):** HTTP transport is already **one MCP POST per request** without session IDs (R1).
  Moving to the spec stateless **wire** is primarily an SDK v2 migration plus era negotiation, not a redesign of
  Switchboard's run ledger.

### Multi Round-Trip Requests (MRTR)

- **Spec (S1, S2):** Tool results use required `resultType` (`complete` \| `input_required`); interim results carry
  `inputRequests`; clients retry the same call with `inputResponses` (SEP-2322).
- **SDK (S6, S9):** v2 documents MRTR in the migration guide; `examples/mrtr` shows HMAC-protected `requestState` and
  client `allowInputRequired` / auto-fulfil modes.
- **Switchboard fit (Inferred):** **Low near-term value.** Switchboard tools are thin delegates to provider CLIs;
  privileged approval and dynamic projects stay off MCP or on dedicated tools (ADR-0047). MRTR matters if Switchboard later
  exposes in-band confirmation for non-privileged parameters; that is not on the M14 critical path.

### `subscriptions/listen`

- **Spec (S2):** Replaces `resources/subscribe` and the old HTTP GET notification channel with one opted-in POST
  response stream; types include `toolsListChanged`, `resourcesListChanged`, etc.
- **SDK (S8):** `examples/subscriptions` documents `client.listen()` and `handler.notify.toolsChanged()` on HTTP.
- **Switchboard fit (Inferred):** Could eventually push digest or `list_changed` events to a host that keeps a stream
  open. **Not a substitute** for ADR-0048 notification sinks: chat apps often do not hold long-lived MCP streams
  (discovery note §6 rank 2; ADR-0048 alternative rejected).

### Tasks extension (`io.modelcontextprotocol/tasks`)

- **Spec (S4):** Opt-in extension; long work returns `resultType: "task"` with `taskId`; clients poll `tasks/get`,
  respond on `input_required` via `tasks/update`; optional `notifications/tasks` when subscribed.
- **SDK (S6):** v1 **experimental** task interception removed in v2; 2026 tasks use the extension spec (S4), not the
  old 2025-11 experimental core. No dedicated `examples/tasks` directory in v2.3.1; `todos-server` covers
  `input_required` but not the Tasks extension lifecycle.
- **Switchboard fit (Inferred):** **Optional future mapping.** `delegate_task` already returns a durable `run_id` and
  expects polling via `get_run` / digest (M14). Exposing the same work as MCP Tasks would help **only** clients that
  implement the extension and prefer `tasks/get` over custom tools. Defer unless a target client documents Tasks support.

### Client ID Metadata Documents (CIMD) vs DCR

- **Spec (S3):** Clients SHOULD support CIMD; AS SHOULD support CIMD; DCR MAY remain for ASes without CIMD. DCR is
  **deprecated** with removal in a future spec version, with at least twelve months' notice (S2 governance).
- **SDK (S6):** `registerClient` / Dynamic Client Registration marked `@deprecated`; client metadata resolution
  (`resolveClientMetadata`) documents CIMD-oriented defaults; RFC 9207 `iss` validation tightened.
- **Switchboard (R1):** Embedded AS implements DCR + operator consent (FR-MCP-16, FR-MCP-17). Manual client registration
  remains available per ADR-0041 item 3.

## Target MCP clients (likely protocol support)

Owner decision 36 (Verified repo, ROADMAP §4.2): orchestrators to test are **Grok bot**, **OpenClaw**, and the
**Claude app** (remote connector over M13 HTTP).

| Client | Remote MCP / HTTP | OAuth registration modes observed | 2026-07-28 / MRTR / subscriptions / Tasks |
| --- | --- | --- | --- |
| **Claude app** (custom connector) | Yes — Anthropic cloud connects to public URL (S11) | **Verified (web) S11:** "Use Claude's published identity (Recommended)", "Register automatically", or custom OAuth client | **Unverified:** help article does not name protocol revision. **Inferred:** published identity aligns with CIMD (S3); auto-register aligns with DCR (FR-MCP-16). No evidence Claude emits `subscriptions/listen` or Tasks for third-party servers. |
| **Grok bot** (embedding) | Yes — owner decision Q-67 / M13 (R1) | **Assumption:** behaves like other hosted chat connectors (OAuth to embedded AS); no primary Grok MCP version doc in repo | **Unverified** for 2026-07-28 features. Webhook alerts (ADR-0048) are separate from MCP subscriptions. |
| **OpenClaw** | **Secondary** — orchestrator in research blueprint; MCP client behaviour not spec-owned here | **Unverified** | **Unverified** |

**Conclusion (Inferred):** Plan for **dual-era** operation (2025-11-25 and 2026-07-28) through SDK v2, as in S10,
until each target client publishes a 2026-07-28 requirement. Do not rely on `subscriptions/listen` or Tasks for M14
acceptance; keep digest polling and ADR-0048 sinks.

## Proposed plan (documentation only)

This plan **does not** supersede [ADR-0041](../adr/0041-http-transport-with-oauth-2-1.md) today. DCR remains correct
for M13 until a later implementation task amends FR-MCP-16 and ADR-0041 item 3 under the spec deprecation window.

### Phase A — Track clients (no Switchboard code)

1. Record which protocol era each target client negotiates once SDK v2 is in use (stdio probe / HTTP
   `server/discover` or negotiated version in client logs).
2. Re-check Claude connector docs when Anthropic publishes a protocol version for custom connectors (ADR-0041 open
   question on mobile connector auth remains separate).

### Phase B — SDK v2 migration (future roadmap task, not T14.12)

1. Adopt `@modelcontextprotocol/server` / `client` / `core` **2.3.x** (S7) with the official codemod (S6).
2. Run **dual-era** Streamable HTTP like S10: default negotiate `2026-07-28` and `2025-11-25`; keep stdio on the same
   policy so local orchestrators do not break.
3. Replace embedded AS helpers that moved to `@modelcontextprotocol/server-legacy` only where Switchboard still owns an
   AS (S6); long term, external IdP remains optional per ADR-0041.

### Phase C — CIMD alongside DCR (future ADR amendment when coding starts)

1. **Publish** HTTPS Client ID Metadata Documents for Switchboard-defined OAuth clients (for example a stable
   "Switchboard console" and "Switchboard orchestrator" profile), hosted on the issuer origin next to existing RFC 8414
   metadata (R1).
2. **Keep** `POST /register` and pending-operator approval during the DCR deprecation window (S2, S3); FR-MCP-16
   remains satisfied until zemdregon accepts a narrowed requirement.
3. **Document** operator flow: Claude's "published identity" (S11) should use CIMD; "Register automatically" continues
   to hit DCR; manual registration unchanged.
4. **Harden** RFC 9207 `iss` validation on token and authorization callback paths when upgrading the OAuth client stack
   (S6).

### Phase D — Optional protocol features (defer)

| Feature | Trigger to implement | Otherwise |
| --- | --- | --- |
| `subscriptions/listen` | A target client documents support and keeps a listen stream for digest or tool-list updates | Stay pull-only (`get_digest`, `get_run`) |
| MRTR | A Switchboard tool needs in-band user input without a provider CLI | Keep refusing provider elicitation; no MRTR |
| Tasks extension | Target client implements `io.modelcontextprotocol/tasks` and benefits from standard task IDs | Keep `run_id` + ledger events |

## ADR and M14 cross-links

| Document | Spike effect |
| --- | --- |
| **ADR-0041** | Cited; item 3 (DCR) stays until Phase C implementation and owner acceptance of CIMD-first wording. **No new ADR** in T14.12. |
| **ADR-0047** | Unchanged. OAuth client identity and scopes are unchanged; MRTR does not alter approval-proxy digests. |
| **ADR-0048** | Unchanged. Spike **does not** establish protocol-native push to chat apps; "Revisit when" in ADR-0048 remains open. |

## Risks and mitigations (Proposed)

| Risk | Mitigation |
| --- | --- |
| Client upgrades negotiate 2026-07-28 and break v1-only servers | Phase B dual-era; pin tests on both eras (S10 pattern). |
| DCR removed from spec before Switchboard ships CIMD | Phase C on the deprecation timeline (S2); keep DCR until CIMD is live. |
| Premature Tasks mapping duplicates `run_id` | Defer Phase D; one durable id per run in the ledger remains canonical. |

## Done criteria for T14.12 (this file)

- Primary sources cited for stateless core, MRTR, `subscriptions/listen`, Tasks, CIMD vs DCR, and SDK v2.
- Target clients assessed with evidence labels.
- Proposed phased plan recorded without superseding ADR-0041 in this change.
