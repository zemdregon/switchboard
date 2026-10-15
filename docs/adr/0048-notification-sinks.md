# ADR-0048: Operator-configured notification sinks, webhook first

- Status: Proposed
- Date: 2026-10-15
- Decided by: Delegated (agent, 2026-10-15) under [owner decision 25](../ROADMAP.md#42-owner-decisions) (outside bypass
  mode; no bypass effect). The first target, the Grok bot, is zemdregon's choice (owner decision 52, 2026-10-15,
  answering discovery question 4: "Grok Bot"). The realisation below is Delegated and not owner-approved. Its endpoint
  and message format are unverified (Q-92).
- Related: FR-CTL-10, FR-CTL-08, NFR-PRIV-01, NFR-SEC-01, FR-TEL-03, FR-INN-16, [ADR-0003](0003-no-credential-handling.md),
  [ADR-0041](0041-http-transport-with-oauth-2-1.md), [ADR-0047](0047-approval-proxy-over-mcp.md), R-66, Q-92, Q-93.

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
   the T14.0 design, not here.
2. **Two kinds, webhook first.** The first sink is a generic HTTPS webhook with an operator-given URL. The Grok bot is
   the first target of that same sink, aimed at its inbound endpoint (Q-92). Other channels (ntfy, email, a native chat
   push) are not built; each would need its own review. Email is not first because it needs mail credentials, which
   Switchboard does not handle (ADR-0003).
3. **Closed payload.** A payload carries only: the project ID, one event kind from a closed list, one reason code from
   the closed list of FR-CTL-03 (or the approval kind for ADR-0047 events), the run ID and a link. It never carries code,
   prompts, diffs, objectives, repository content, log lines or agent-written text, of any length. The payload is built
   from fields, not by filtering a free-text message, so there is no text to redact.
4. **Filter and rate limit.** Each sink names the event kinds it receives and a maximum rate. Events beyond the rate
   are dropped and counted, not queued without bound.
5. **Links carry no secret.** A link points to the digest or the consent page. It holds no token, no approval
   digest and no passphrase; opening it requires the operator's normal authentication (FR-MCP-17 or the CLI).
6. **Delivery never affects a run.** A sink call is best effort, runs outside the admission and execution path, and has
   a bounded timeout. A failure is recorded as a count and a reason code in the ledger, never with the payload.
7. **Transport.** HTTPS only, with certificate verification on. A webhook URL that embeds a secret is operator
   configuration; it is redacted from logs and telemetry (NFR-SEC-01, FR-TEL-03). The controller holds no provider
   credential (ADR-0003).

## Consequences

- A new egress path exists when an operator configures a sink. It is recorded as **R-66** (not blocking). Its
  mitigations are the closed payload, the default-off setting and operator-chosen destinations.
- NFR-PRIV-01 lists the permitted outbound traffic. A dated note there records that configured notification sinks are
  one more operator-configured path, and that the payload rule above applies to it.
- The Grok target depends on a Grok bot endpoint and message format that nobody has checked (Q-92). Until Q-92 is
  answered, only the generic webhook is verified to be buildable, and the Grok target is a Proposed configuration.
- Alerts reach the operator only when the operator has configured a sink. Without one, the digest (FR-CTL-02) is the
  only signal, as today.

## Alternatives considered

- **Digest only, no push.** Keeps egress at zero, but the operator learns about a parked or failed run only when the
  chat is next opened. Rejected for the "alert while away" goal (discovery note, §5).
- **Email first.** Needs mail credentials that Switchboard would have to hold. Rejected under ADR-0003.
- **ntfy first.** A reasonable generic channel; deferred, since owner decision 52 named the Grok bot and a second
  channel can be added with the same payload rule.
- **Chat-app push over MCP `subscriptions/listen`.** Client support in chat apps is unknown (discovery note, §6,
  recommendation 2). Not relied on.

## Revisit when

- Q-92 is answered with a verified Grok bot endpoint and format.
- A second channel is requested, or the payload needs a field that is not in the closed list (that needs a new ADR or
  an amendment to this one).
- The MCP 2026-07-28 readiness spike (T14.12) makes a protocol-native notification path available to the target clients.
