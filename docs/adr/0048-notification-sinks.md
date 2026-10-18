# ADR-0048: Operator-configured notification sinks: webhook and ntfy

- Status: Proposed
- Date: 2026-10-15
- Decided by: Delegated (agent, 2026-10-15) under [owner decision 25](../ROADMAP.md#42-owner-decisions) (outside bypass
  mode; no bypass effect). The first target, the Grok bot, is zemdregon's choice (owner decision 52, 2026-10-15,
  answering discovery question 4: "Grok Bot"). Owner decision 53 (2026-10-15) settles that the Grok bot generates its
  own webhook at deployment, so the generic webhook is pointed at it with no Grok-specific code, and adds ntfy. The
  realisation below is Delegated and not owner-approved.
- Related: FR-CTL-10, FR-CTL-12, FR-CTL-08, FR-QUE-04, NFR-PRIV-01, NFR-SEC-01, FR-TEL-03, FR-INN-16, [ADR-0003](0003-no-credential-handling.md),
  [ADR-0041](0041-http-transport-with-oauth-2-1.md), [ADR-0047](0047-approval-proxy-over-mcp.md), R-66,
  owner decisions 52, 53 and 55.

## Context

A person using one chat bot cannot see a run that needs them unless something reaches them while the chat is closed
(discovery note, [§5](../research/orchestration-layer-discovery-2026-10-15.md#5-the-single-chatbot-experience-target-proposed)).
Today Switchboard makes no outbound call except provider CLIs, configured telemetry (OTLP, M8) and the configured
inner-agent backend (NFR-PRIV-01). A notification sink adds a new egress path: data leaves the host for a service the
operator chose. [AGENTS.md](../../AGENTS.md) requires a new ADR before a new external interface or boundary change is
built, and the discovery note recommended this one for the same reason.

## Decision

1. **Operator-chosen and off by default.** Sinks are defined only in operator configuration. With none defined, no
   outbound notification is made and behaviour is unchanged. The configuration keys are **Proposed** and are fixed in
   [LLD §3.4.9](../design/LLD.md#349-notification-sinks-fr-ctl-10-adr-0048) and [TDD §3.1](../design/TDD.md#31-configuration).
2. **Two kinds: webhook and ntfy.** A generic HTTPS webhook with an operator-given URL; the Grok bot is reached by
   pasting the webhook the Grok bot generates at deployment into this sink, with no Grok-specific code (owner decision
   53). An ntfy sink publishes to an operator-given ntfy server and topic (owner decision 53); its publish interface is
   cited from ntfy's documentation in T14.0. Other channels (email, a native chat push) are not built; each would need
   its own review. Email is not first because it needs mail credentials, which
   Switchboard does not handle (ADR-0003).
3. **Closed payload.** A payload carries only: the project ID (a configured id, `-` for a run admitted without a
   project, or `*` for an event that applies to every project), one event kind from a closed list, one reason code from
   the closed list for that kind (`SUCCEEDED`/`FAILED`/`CANCELLED` for `run_terminal`; the closed list of FR-CTL-03
   for `needs_attention`; the approval kind for `approval_pending` and `approval_decided` (ADR-0047 events);
   `project_paused`/`global_paused` for `project_paused`; `budget_exhausted`; `queue_low` for FR-QUE-04), the run ID
   and a link. It never carries code, prompts, diffs, objectives, repository content, log lines or agent-written text,
   of any length. The payload is built from fields, not by filtering a free-text message, so there is no text to redact.
   The closed event-kind list is: `run_terminal`, `needs_attention`, `approval_pending`, `approval_decided`,
   `budget_exhausted`, `project_paused`, and `queue_low` (T15.4, FR-QUE-04; reason code `queue_low`, `run_id` null).
4. **Filter and rate limit.** Each sink names the event kinds it receives and a maximum rate. Events beyond the rate
   are dropped and counted, not queued without bound.
5. **Links carry no secret.** A link points to the digest or the consent page. It holds no token, no approval
   digest and no passphrase; opening it requires the operator's normal authentication (FR-MCP-17 or the CLI).
6. **Delivery never affects a run.** A sink call is best effort, runs outside the admission and execution path, and has
   a bounded timeout. A failure is logged, and is recorded as `sink_delivery_failed` in the ledger only when the
   event has a run, never with the payload.
7. **Transport.** HTTPS only, with certificate verification on. A webhook URL, optional webhook authorization
   (FR-CTL-12), ntfy topic or ntfy access token is operator configuration; it is redacted from logs and telemetry
   (NFR-SEC-01, FR-TEL-03). The controller holds no provider credential (ADR-0003).

## Consequences

- A new egress path exists when an operator configures a sink. It is recorded as **R-66** (not blocking). Its
  mitigations are the closed payload, the default-off setting and operator-chosen destinations.
- NFR-PRIV-01 lists the permitted outbound traffic. A dated note there records that configured notification sinks are
  one more operator-configured path, and that the payload rule above applies to it.
- Whether the Grok bot's generated webhook accepts the closed JSON payload as sent is checked when the operator
  deploys it (**Assumption** until then); no Grok-specific code exists to adapt.
- Alerts reach the operator only when the operator has configured a sink. Without one, the digest (FR-CTL-02) is the
  only signal, as today.

## Alternatives considered

- **Digest only, no push.** Keeps egress at zero, but the operator learns about a parked or failed run only when the
  chat is next opened. Rejected for the "alert while away" goal (discovery note, §5).
- **Email first.** Needs mail credentials that Switchboard would have to hold. Rejected under ADR-0003.
- **A Grok-specific sink.** Rejected: the Grok bot's webhook is generated at deployment (owner decision 53), so a
  generic webhook covers it.
- **Chat-app push over MCP `subscriptions/listen`.** Client support in chat apps is unknown (discovery note, §6,
  recommendation 2). Not relied on.

## Revisit when

- The Grok bot's webhook turns out to need a payload shape the generic sink does not send.
- A second channel is requested, or the payload needs a field that is not in the closed list (that needs a new ADR or
  an amendment to this one).
- The MCP 2026-07-28 readiness spike (T14.12) makes a protocol-native notification path available to the target clients.
