# Notification sinks integration spike (T14.9), 2026-10-15

- Date: 2026-10-15
- Status: Research input (Delegated agent work, documentation only; not owner-approved). Payload
  mapping details marked **Proposed** are spike guidance for implementation; normative contracts remain
  [LLD §3.4.9](../design/LLD.md#349-notification-sinks-fr-ctl-10-adr-0048) and [ADR-0048](../adr/0048-notification-sinks.md)
  (Proposed; cross-linked only, decision text unchanged).
- Used by: [ROADMAP](../ROADMAP.md) T14.9, FR-CTL-10, FR-CTL-03, FR-CTL-08, [ADR-0047](../adr/0047-approval-proxy-over-mcp.md),
  [ADR-0048](../adr/0048-notification-sinks.md), [TDD §3.1](../design/TDD.md#31-configuration).
- Scope: Closed event kinds and reason codes, example webhook and ntfy bodies (metadata-only), operator
  config key references, and test implications for the future sink capture acceptance test. No code.

## Evidence labels

- **Verified (repo):** read in this repository on 2026-10-15.
- **Verified (web):** primary page retrieved on 2026-10-15 with URL cited.
- **Proposed:** spike guidance not yet fixed in LLD; implementation (T14.9) must align with LLD or amend via ADR.

## Primary sources

| ID | Source | Why it matters |
| --- | --- | --- |
| R1 | [ADR-0048](../adr/0048-notification-sinks.md) | Closed payload rule, webhook + ntfy kinds, filter, rate limit, off run path |
| R2 | [LLD §3.4.1](../design/LLD.md#341-shared-types) | `sink_event_kind`, `notification_payload`, `needs_attention_reason`, `approval_kind` |
| R3 | [LLD §3.4.9](../design/LLD.md#349-notification-sinks-fr-ctl-10-adr-0048) | `notification_sinks[]` shape, delivery, link construction |
| R4 | [FR-CTL-03](../requirements/SRS.md) (SRS) | Five closed `needs_attention` reasons |
| R5 | [ADR-0047](../adr/0047-approval-proxy-over-mcp.md) | Approval kinds; proxied decisions announced to sinks |
| R6 | [TDD §3.1](../design/TDD.md#31-configuration) | Top-level `notification_sinks[]` key summary |
| S1 | [ntfy publish](https://docs.ntfy.sh/publish/) (retrieved 2026-10-15) | HTTP POST/PUT to topic URL; optional `Title`, `Priority`, `Tags`, `Click` headers; JSON body publish to unified endpoint |

## Operator configuration (keys only)

Normative field names live in [LLD §3.4.9](../design/LLD.md#349-notification-sinks-fr-ctl-10-adr-0048) and
[TDD §3.1](../design/TDD.md#31-configuration). This spike does not add keys.

| Key / path | Meaning (abbrev.) |
| --- | --- |
| `notification_sinks[]` | Absent ⇒ sinks off (ADR-0048 item 1) |
| `notification_sinks[].id` | Operator label |
| `notification_sinks[].kind` | `webhook` or `ntfy` |
| `notification_sinks[].url` | HTTPS webhook URL when `kind: webhook` |
| `notification_sinks[].ntfy` | `{ server, topic, token? }` when `kind: ntfy` |
| `notification_sinks[].events` | Subset of `sink_event_kind`; default all kinds (LLD) |
| `notification_sinks[].max_per_minute` | Per-sink rate limit; excess dropped and counted |

Related control-plane keys that **produce** sink events (not sink config): `control_plane.budgets`,
`control_plane.loop_breaker`, `mcp_clients[].approval_proxy`, `transport.http.public_url` (link base when set;
LLD §3.4.9).

## Closed `sink_event_kind` values (Verified repo, LLD §3.4.1)

Exactly these six values may appear as `notification_payload.event_kind`:

| `event_kind` | Typical trigger (ledger / control plane) |
| --- | --- |
| `run_terminal` | Run reaches a terminal `status` |
| `needs_attention` | Derived `needs_attention.active` becomes true (FR-CTL-03) |
| `approval_pending` | New `PENDING` approval visible to the operator |
| `approval_decided` | Approval decided (CLI, client policy, or MCP proxy per ADR-0047) |
| `budget_exhausted` | Budget refusal active for admission (§3.4.6) |
| `project_paused` | Project or global pause applied (§3.4.6) |

Per-sink `events[]` filters on this enum only (LLD §3.4.9).

## Closed `reason_code` values (cross-check FR-CTL-03 and ADR-0047)

`notification_payload.reason_code` is a string required on every payload (LLD §3.4.1). Comments in LLD tie it to
**either** a `needs_attention_reason` **or** an `approval_kind`. ADR-0048 item 3 matches: FR-CTL-03 reasons for
attention-style events; approval kinds for ADR-0047 approval events.

### FR-CTL-03 `needs_attention_reason` (exactly five)

| `reason_code` | Used when `event_kind` is |
| --- | --- |
| `awaiting_approval` | `needs_attention` (and matches digest derivation §3.4.5) |
| `parked_loop` | `needs_attention` |
| `failed_after_retry` | `needs_attention` |
| `stalled` | `needs_attention` |
| `budget_exhausted` | `needs_attention` or `budget_exhausted` |

These five are the only needs-attention reason strings in sink payloads; they must not be extended without an SRS/LLD
change.

### ADR-0047 `approval_kind` (exactly three)

| `reason_code` | Used when `event_kind` is |
| --- | --- |
| `privileged_scope` | `approval_pending`, `approval_decided` |
| `dynamic_project` | `approval_pending`, `approval_decided` |
| `push_revision` | `approval_pending`, `approval_decided` |

Proxied decisions (ADR-0047 Decision 2f) emit `approval_decided` with one of these kinds in `reason_code`; no
`scope_summary`, digest, or agent text in the sink payload.

### Other `event_kind` → `reason_code` (**Proposed** for T14.9 implementation)

LLD does not spell out every pair. Implementation should use controller-generated closed codes only:

| `event_kind` | **Proposed** `reason_code` |
| --- | --- |
| `run_terminal` | Terminal run `status` from the compact envelope (`SUCCEEDED`, `FAILED`, `CANCELLED`) |
| `project_paused` | Literal `project_paused` (or `global_paused` when `project_id` is `*` — **Proposed** label) |

If implementation needs additional reason strings, amend LLD or ADR-0048; do not send free-form or agent-derived text.

## `notification_payload` shape (Verified repo)

Every delivery uses the same object (webhook body or ntfy-encoded equivalent):

| Field | Type | Content rule |
| --- | --- | --- |
| `project_id` | string | Configured or dynamic project id |
| `event_kind` | `sink_event_kind` | One of six closed values |
| `reason_code` | string | Closed reason or approval kind as above |
| `run_id` | string or null | Run id when applicable; null for project-only events (**Proposed** where LLD is silent) |
| `link` | string (≤ 2048) | Digest or run URL; no token, digest, or passphrase (ADR-0048 item 5) |

Forbidden in all sinks (ADR-0048 item 3, FR-CTL-10): code, prompts, diffs, objectives, repo content, log lines,
`scope_summary`, `untrusted_text`, planted secrets, or any agent-written text.

## Example: generic webhook

`POST` to `notification_sinks[].url` with `Content-Type: application/json` and body **exactly** the payload object
(**Proposed** header choice; HTTPS + cert verification per ADR-0048 item 7).

Needs attention (stalled run):

```json
{
  "project_id": "acme-api",
  "event_kind": "needs_attention",
  "reason_code": "stalled",
  "run_id": "run_01HZZZZZZZZZZZZZZZZZZZZZZZ",
  "link": "https://switchboard.example/digest"
}
```

Approval decided via MCP proxy (metadata only):

```json
{
  "project_id": "acme-api",
  "event_kind": "approval_decided",
  "reason_code": "privileged_scope",
  "run_id": "run_01HYYYYYYYYYYYYYYYYYYYYYYY",
  "link": "https://switchboard.example/runs/run_01HYYYYYYYYYYYYYYYYYYYYYYY"
}
```

## Example: ntfy mapping (no free-text agent content)

Publish uses ntfy's HTTP API ([S1](https://docs.ntfy.sh/publish/), retrieved 2026-10-15): `POST` or `PUT` to
`https://{server}/{topic}` (or JSON publish with `topic` in body per S1). Optional `Authorization: Bearer` when
`notification_sinks[].ntfy.token` is set (operator config; redacted from logs per ADR-0048 item 7).

**Mapping (Proposed, field-built only):**

| ntfy field | Source | Must not include |
| --- | --- | --- |
| `Title` header (or JSON `title`) | Fixed template: literal `Switchboard:` plus `event_kind` | Run objective, summary, scope text |
| Message body (plain) or JSON `message` | Fixed pattern: `project_id`, `reason_code`, and `run_id` or `none` | Prompts, diffs, log excerpts, `scope_summary` |
| `Click` header (or JSON `click`) | `notification_payload.link` | Tokens or approval digests |
| JSON body (optional) | Same object as webhook `notification_payload` with `Content-Type: application/json` (S1) | Any extra keys with agent content |

Example using topic URL + headers (metadata-only message line):

```http
POST /switchboard-ops HTTP/1.1
Host: ntfy.example
Title: Switchboard: needs_attention
Click: https://switchboard.example/digest
Content-Type: text/plain

project_id=acme-api reason_code=stalled run_id=run_01HZZZZZZZZZZZZZZZZZZZZZZZ
```

Equivalent JSON publish (**Proposed**; S1 JSON format):

```json
{
  "topic": "switchboard-ops",
  "title": "Switchboard: needs_attention",
  "message": "project_id=acme-api reason_code=stalled run_id=run_01HZZZZZZZZZZZZZZZZZZZZZZZ",
  "click": "https://switchboard.example/digest",
  "priority": "default",
  "tags": ["switchboard"]
}
```

A consumer that needs structured data should read the JSON publish body or a parallel webhook; the human-visible
`message` line remains a closed-field template, not a digest summary.

## Delivery behaviour (implementation reminders)

From LLD §3.4.9 and ADR-0048 (Verified repo):

- Asynchronous, bounded timeout (**Proposed** target 5 s in LLD), off admission and execution path.
- Failures record `sink_delivery_failed` counts without payload or URL in the ledger.
- Rate limit: drop and count when over `max_per_minute`.
- Grok bot and other webhooks receive the same JSON as any generic webhook (owner decision 53); no Grok-specific code.

## Test implications (T14.9 acceptance; no code in this spike)

Future sink capture test (ROADMAP §6.13 T14.9 column) should plan for:

| Scenario | Expectation |
| --- | --- |
| Local capture server | Receives HTTP requests whose JSON body (webhook) or parsed JSON publish (ntfy) equals `notification_payload` with only the five allowed fields; field values are closed enums or ids, never planted secret strings, prompt text, or agent summary text from a malicious fixture run |
| Sinks absent | With `notification_sinks` omitted or `[]`, capture server sees zero requests during runs that would otherwise emit events |
| Run path isolation | Sink timeout or 5xx from capture does not fail, delay, or change terminal run state; run completes as without sink |
| ntfy parity | ntfy sink encodes the same closed fields as webhook (body JSON or **Proposed** header template); capture asserts `Title`/`message` contain no substring from planted agent output |
| Secret hygiene | Webhook URL, ntfy `server`/`topic`, and `token` never appear in ledger rows, OTLP/log exports, or MCP tool output (grep fixtures for canary values) |
| Filter + rate limit | **Proposed** follow-on cases: sink with `events: ["approval_decided"]` ignores `run_terminal`; burst beyond `max_per_minute` drops with counter increment (no unbounded queue) |
| ADR-0047 coupling | After T14.8, one proxied `decide_approval` produces exactly one `approval_decided` delivery with `reason_code` ∈ `approval_kind` and no digest in payload |

Suggested harness shape (**Proposed**): in-process HTTP server bound to localhost; config points webhook `url` at it;
optional second sink kind `ntfy` with `server` aimed at the same capture via reverse proxy or dual mount; use fake
adapter runs with known `project_id`/`run_id` only.

## Related work

- [Approval proxy spike](approval-proxy-spike-2026-10-15.md): proxied `decide_approval` triggers `approval_decided`
  (T14.8; cross-link only).
- [MCP 2026-07-28 readiness spike](mcp-2026-07-28-readiness-spike-2026-10-15.md): `subscriptions/listen` is not a
  substitute for these sinks.
- [Adapter steer-input spike](adapter-steer-input-spike-2026-10-15.md): unrelated egress; cross-link only.

## Open points for implementation (not blockers for this doc spike)

- Exact `reason_code` for `run_terminal` and `project_paused` (**Proposed** table above) should be pinned in LLD during
  T14.9 code if tests need stable assertions.
- Whether ntfy uses topic-URL POST with headers only vs unified JSON endpoint: both are valid per S1; pick one in
  implementation and document in LLD if the choice is normative.
