# Consent-page approval link spike (T14.10), 2026-10-15

- Date: 2026-10-15
- Status: Research input (Delegated agent work, documentation only; not owner-approved). Normative contracts remain
  [FR-CTL-09](../requirements/SRS.md), [FR-MCP-17](../requirements/SRS.md), [ADR-0041](../adr/0041-http-transport-with-oauth-2-1.md)
  (consent page, cross-linked only; decision text unchanged), and [ADR-0047](../adr/0047-approval-proxy-over-mcp.md)
  Decision 3 (cross-linked only). URL paths, ledger tables and HTML flows marked **Proposed** are spike guidance for
  implementation; they are not fixed endpoints.
- Used by: [ROADMAP](../ROADMAP.md) T14.10, FR-CTL-09, FR-MCP-17, ADR-0041, ADR-0047, T14.8 (MCP proxy boundary;
  cross-link only), T14.9 (sink `link` field; cross-link only).
- Scope: Single-use expiring link semantics, fail-closed unauthenticated access, mapping to `approval_id` and the ledger,
  boundaries to approval proxy and notification sinks, operator/M13 dependencies, and test implications. No code.

## Evidence labels

- **Verified (repo):** read in this repository on 2026-10-15.
- **Verified (spec):** requirement or ADR row cited by ID; ADR decision text not restated.
- **Proposed:** spike guidance not yet fixed in LLD; implementation must align with LLD or amend via ADR.

## Primary sources

| ID | Source | Why it matters |
| --- | --- | --- |
| R1 | [FR-CTL-09](../requirements/SRS.md) | Secondary approval path: single-use, expiring consent-page link; no token in URL |
| R2 | [FR-MCP-17](../requirements/SRS.md) | Consent page authentication (passphrase or pairing code); no login session; CSRF |
| R3 | [ADR-0047](../adr/0047-approval-proxy-over-mcp.md) Decision 3 | Same link rules; revoked when approval decided or expires; secondary to MCP proxy and CLI |
| R4 | [ADR-0041](../adr/0041-http-transport-with-oauth-2-1.md) | M13 issuer origin, consent page on embedded AS, HTTP off by default |
| R5 | [LLD §3.3](../design/LLD.md#33-network-mcp-transport-m13) | Built OAuth consent page, pairing codes, CSRF cookie pattern (client registration today) |
| R6 | [LLD §3.1](../design/LLD.md#31-privileged-scope-m3) | `approval` table, `PENDING` → decided once; `approval.id` as `approval_id` |
| R7 | [LLD §3.4.8](../design/LLD.md#348-approval-proxy-tools-fr-ctl-08-adr-0047) | Primary MCP path with `approval_digest`; not used in the browser link |
| R8 | [ADR-0048](../adr/0048-notification-sinks.md) item 5 | Sink `link` may point at digest or consent page; no token, digest or passphrase in URL |
| R9 | [approval proxy spike](approval-proxy-spike-2026-10-15.md) | T14.8 boundary (cross-link only) |
| R10 | [notification sinks spike](notification-sinks-spike-2026-10-15.md) | T14.9 closed payloads and `link` construction (cross-link only) |
| R11 | [orchestration-layer discovery §6](../research/orchestration-layer-discovery-2026-10-15.md#6-ranked-recommendations-add) | Product intent: phone-friendly approve via existing consent page |

## Three approval paths (Verified spec)

| Path | Who decides | Binding / auth | Normative owner |
| --- | --- | --- | --- |
| Operator CLI | OS user at terminal | Scope hash check on the requesting run ([LLD §3.1](../design/LLD.md#31-privileged-scope-m3)) | FR-OPS-02, FR-POL-09 |
| MCP approval proxy (T14.8) | Marked `approval_proxy` client | Exact `approval_id` + `approval_digest`; OAuth token for MCP only | FR-CTL-08, ADR-0047 |
| Consent-page link (T14.10) | Operator in browser on issuer origin | FR-MCP-17 passphrase or pairing code; link is not a credential | FR-CTL-09, ADR-0047 Decision 3 |

None of the paths widens scope, lifts Git-write denial, or grants `privileged` through MCP alone (ADR-0047 Decision 2g).

## Link semantics (single-use, expiring, no bearer token)

### What the URL may contain (Verified spec + Proposed shape)

- **Verified (spec):** The link carries **no OAuth access token, no refresh token, no approval digest, no passphrase,
  and no scope text** (FR-CTL-09, ADR-0047 Decision 3, ADR-0048 item 5).
- **Proposed:** The URL is an HTTPS GET on the **same issuer origin** as the M13 OAuth consent page
  ([ADR-0041](../adr/0041-http-transport-with-oauth-2-1.md), [LLD §3.3](../design/LLD.md#33-network-mcp-transport-m13)).
  It includes only an **unguessable opaque handle** (high entropy, comparable to pairing-code strength) that the server
  maps server-side to exactly one `approval_id` while the row is `PENDING`. The bare `approval_id` alone is **not**
  sufficient as the only path segment (guessable/idempotent enumeration risk; **Proposed** fail-closed rule).

The opaque handle is **not** a bearer token: possession alone does not approve anything. It only selects which pending
approval the operator may act on **after** FR-MCP-17 authentication succeeds.

### Single-use (Verified spec + Proposed enforcement)

- **Verified (spec):** After the approval is **decided** (approve or deny) or **expires**, the link is **revoked**
  (ADR-0047 Decision 3; ROADMAP T14.10 acceptance: works once then expires).
- **Proposed:** Redemption uses a single atomic ledger update (same pattern as `oauth_pairing_code` redemption in
  LLD §3.3: one `UPDATE ... WHERE used_at IS NULL AND expires_at > now`). A second successful submission with the same
  handle returns a safe error page with no new decision. Concurrent double-submit loses at most one decision (same as
  CLI race semantics; **Proposed**).

### Expiring (Verified spec + Proposed clock)

- **Verified (spec):** Link lifetime is bounded; revoked when the approval is no longer `PENDING` (ADR-0047 Decision 3).
- **Proposed:** Issue `expires_at` no later than the approval's pending lifetime policy (implementation may align link
  TTL to operator-configured attention windows or a fixed cap; must be fixed in LLD before code). Expired or unknown
  handles fail closed with no approval metadata leaked to unauthenticated callers.

### Unauthenticated visit — fail closed (Verified spec)

- **Verified (spec):** Opening the link requires the operator's normal consent-page authentication (FR-MCP-17;
  ADR-0048 item 5). There is **no login session** (Q-76): every visit needs passphrase or pairing code.
- **Proposed behaviour:**
  1. **GET without prior FR-MCP-17 success for this approval action:** show only the same class of static consent UI
     shell used for OAuth client approval (CSRF token, `__Host-` cookie, `Referrer-Policy: no-referrer`, framing forbidden
     per LLD §3.3) **or** refuse with an error that does not reveal whether the handle was valid. Do **not** show
     `scope_json`, run objectives, agent text, or `approval_digest`.
  2. **Wrong or missing CSRF / Origin:** refuse (extend existing consent POST rules; **Proposed**).
  3. **After** passphrase or pairing code verifies: show controller-generated approval summary only (same content rules
     as `list_pending_approvals`: closed fields, no agent-written text per ADR-0047 Decision 2d and T14.8 spike).

Pairing codes remain **CLI-issued** (`switchboard consent pair`, LLD §3.3); the approval link does not embed them.

## Issuance and ledger mapping

### `approval_id` (Verified repo)

- Pending approvals are rows in `approval` with primary key `id` ([LLD DDL](../design/LLD.md)); this `id` is the
  `approval_id` in MCP proxy tools ([LLD §3.4.8](../design/LLD.md#348-approval-proxy-tools-fr-ctl-08-adr-0047)).
- Consent-page decide applies to the same row: transition `PENDING` → `APPROVED` or `DENIED` once (append-only guard on
  `approval`).

### Link issuance record (**Proposed**)

Implementation needs a mutable redemption record separate from the append-only `approval` row, analogous to
`oauth_pairing_code`:

| Field (conceptual) | Role |
| --- | --- |
| `approval_id` | FK to `approval.id`; only while `status = 'PENDING'` |
| `handle_hash` | SHA-256 of opaque handle (never store raw handle in ledger/logs) |
| `issued_at` / `expires_at` | Bounded validity |
| `used_at` | Set on first successful decide via this link; null until then |

**Proposed issuance triggers:** (a) when a `PENDING` approval becomes visible in digest/`needs_attention`, and/or
(b) when emitting `approval_pending` to notification sinks (T14.9). Re-issue after expiry may mint a new handle;
old handles stay invalid. Exact trigger set belongs in LLD §3.4 or a follow-on ADR if persistence changes.

### Audit field for consent-page decide (**Proposed**)

- MCP proxy records `approval.decided_by = "mcp_proxy:<client_id>"` (LLD §3.4.8).
- **Proposed:** consent-page path records `decided_by = "consent_page"` (or `"consent_page:<oauth_client_id>"` if the
  implementation needs to distinguish browser context) and the same `approval_decided` `run_event` + sink announcement
  pattern as CLI and proxy paths (FR-POL-09 timestamp rules unchanged). Mirror FR-CTL-08's `decided_via` wording in
  exports/tests the same way as the T14.8 spike (**Proposed**: `decided_by` prefix is sufficient).

### Digest binding on the web path (**Proposed**)

T14.8 requires `approval_digest` for `decide_approval`. The consent page is operator-authenticated, not model-driven;
**Proposed:** the server binds the POST to the stored `scope_hash` / revision facts for that `approval_id` internally
(no digest in the URL). A mismatch refuses with no ledger write (fail closed).

## Boundaries

### Versus T14.8 MCP approval proxy (cross-link only)

| Topic | MCP proxy (T14.8) | Consent-page link (T14.10) |
| --- | --- | --- |
| Audience | Marked MCP clients with OAuth token | Operator browser on issuer origin |
| Pending list | `list_pending_approvals` + digest in tool output | Not via MCP; optional digest in operator UI only after FR-MCP-17 |
| Decide | `decide_approval(approval_id, approval_digest, …)` | HTML form POST after FR-MCP-17 |
| Stolen capability | Stolen MCP token + digest from listing | Stolen link URL without passphrase/code does not decide |

Details: [approval proxy spike](approval-proxy-spike-2026-10-15.md).

### Versus T14.9 notification sinks (cross-link only)

- Sink payloads may include a `link` field pointing at the **digest** or the **consent page** (ADR-0048 item 5).
- That `link` is **not** the approval secret: it is at most the public HTTPS URL with the opaque handle (or a stable
  entry that redirects after auth). It must not include `approval_digest`, tokens, or pairing codes.
- `approval_pending` events complement MCP proxy listing; they do not replace FR-CTL-02 digest. Delivery remains
  best-effort and off the run path (T14.9).

Details: [notification sinks spike](notification-sinks-spike-2026-10-15.md).

### Versus M13 OAuth client consent (same page origin)

- **Verified (repo):** Today LLD §3.3 documents consent for **OAuth client registration** (`GET`/`POST /authorize`).
- **Proposed:** T14.10 adds a **second use** of the consent page surface on the same origin: deciding a **pending
  approval** row. Shared FR-MCP-17 controls (passphrase, pairing code, CSRF, rate limits) apply; flows must remain
  distinguishable so an approval link cannot be confused with authorizing a new MCP client.

## Operator configuration (keys only; no new keys in this spike)

| Key / path | Relevance |
| --- | --- |
| `transport.http` (enabled, bind, TLS/proxy) | Consent links require reachable HTTPS issuer (ADR-0041) |
| `transport.http.public_url` | Base for absolute links in digest and sinks (LLD §3.4.9 **Link** paragraph) |
| `notification_sinks[]` | Optional `approval_pending` deliveries carrying consent-page `link` (T14.9) |
| `mcp_clients[].approval_proxy` | Unrelated to link issuance; parallel path only |

Passphrase and pairing behaviour: config + `switchboard consent pair` (LLD §3.3); not duplicated here.

## Open operator and M13 dependencies (not blockers for this doc spike)

| Dependency | Notes |
| --- | --- |
| HTTP transport enabled | Stdio-only deployments have no issuer URL; consent links need `public_url` or operator relay (**Assumption** until LLD states otherwise). |
| LLD §3.3 extension | Approval-specific GET/POST routes, HTML, and redemption table are **not** specified in LLD yet (T14.0 design gate / follow-on LLD edit). This spike does **not** name final path strings. |
| All `approval_kind` values | ADR-0047 lists `privileged_scope`, `dynamic_project`, `push_revision`; consent UI must cover each kind before M14 acceptance (**Proposed** parity with proxy listing). |
| Sink + digest coupling | Whether every `approval_pending` sink event includes a fresh link or reuses digest-only navigation (T14.9 **Proposed** examples today use run/digest URLs). |
| `switchboard auth revoke` | ADR-0041 notes operator token revocation CLI not built; unrelated to approval links but part of M13 ops surface. |
| Owner decision 50 / R-65 | Accepted risk for MCP proxy; consent link mitigations are FR-MCP-17 + no secrets in URL (ADR-0047). |

## Test implications (T14.10 acceptance; no code in this spike)

ROADMAP §6.13 T14.10 column maps to:

| Scenario | Expectation |
| --- | --- |
| Happy path once | With HTTP fakes/synthetics, first authenticated approve/deny via link updates `approval` and emits expected events; second use of same URL refuses with no state change |
| No bearer in URL | Automated check: link string matches no token, digest, or `sbac_` authorization code patterns |
| Unauthenticated | GET or POST without FR-MCP-17 success does not show scope content or agent text; does not transition `approval` |
| Revoked when decided | After CLI or MCP proxy decides the same `approval_id`, link handle is dead |
| CSRF / Origin | Cross-site POST with stolen handle fails (extend T13.8 consent tests pattern; **Proposed**) |
| Sinks | If `approval_pending` carries consent `link`, capture obeys ADR-0048 closed payload (cross-test with T14.9 harness) |

Use fake adapters and in-process HTTP only; no real provider CLIs (AGENTS.md live-run policy).

## Related work

- [Approval proxy spike](approval-proxy-spike-2026-10-15.md): primary MCP path and T14.10 boundary (T14.8).
- [Notification sinks spike](notification-sinks-spike-2026-10-15.md): `link` field rules (T14.9).
- [Console tool-profile spike](console-tool-profile-spike-2026-10-15.md): consent links stay secondary to MCP proxy tools.
- [Orchestration-layer discovery](../research/orchestration-layer-discovery-2026-10-15.md): phone approve narrative.

## Open points for implementation (leave for Linus / owner)

- Exact URL path template and HTML copy on the consent page (**Proposed**; requires LLD or ADR before code).
- Whether `decided_by` should include operator OS user when consent page runs on a shared host (**Proposed**: optional
  `consent_page` constant vs `consent_page:<sub>` from audit metadata).
- Re-issue policy when link expires but approval stays `PENDING` (new handle vs digest-only fallback).
