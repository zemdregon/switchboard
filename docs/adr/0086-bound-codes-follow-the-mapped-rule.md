# ADR-0086: Profile-bound one-time codes follow the same HTTP eligibility rule as a configuration mapping

- Status: Accepted (2026-10-21). Supersedes [ADR-0085](0085-cli-issued-one-time-codes-for-mcp-oauth.md) in part (its
  refusal of a `privileged` ceiling for a profile-bound code); the rest of ADR-0085 stands.
- Date: 2026-10-21
- Decided by: zemdregon for the outcome (request of 2026-10-21: the example profile is `grok-bot`, and "privileged runs
  must stay unavailable over HTTP, exactly as with bearer tokens today"); the realisation below is **Delegated** (agent,
  2026-10-21) and changes nothing a bypass run may do (owner decision 25).
- Related: FR-MCP-14, FR-MCP-20, FR-MCP-21, BR-59, [ADR-0019](0019-per-client-privileged-approval.md),
  [ADR-0041](0041-http-transport-with-oauth-2-1.md), [LLD §3.3](../design/LLD.md#33-network-mcp-transport-m13),
  ROADMAP T13.12.

## Context

ADR-0085 made a ledger binding stricter than the explicit `transport.http.clients` mapping: it refused any
`mcp_clients` entry with a `privileged` ceiling, so `mcp oauth issue-code --client-profile grok-bot` failed in
production, where `grok-bot` has `max_trust_profile: privileged` and `privileged_approval: required` and is the
explicitly mapped HTTP client today. A mapping to such an entry is allowed (FR-MCP-14) because every privileged run of
it still waits for the operator's approval; "available over HTTP" for privileged work has always meant "requested over
HTTP, approved by the operator", not "unattended".

## Decision

1. A binding made by a profile-bound code (`bound` source of `httpProfileProblem`) follows the same rule as a
   configuration mapping (`mapped`): a `privileged` ceiling is allowed; `privileged_approval: not_required` is refused.
2. The refusal of `privileged_approval: not_required` stays at issue time, at redemption and on every request.
3. `default_mcp_client` (`default` source) stays strict and still refuses a `privileged` ceiling, because it applies to
   every approved OAuth client without an operator act naming the profile.
4. Rationale: issuing a code on the host is an operator act equivalent to editing the configuration map; the code is
   single-use, short-lived (1 to 60 minutes) and names exactly one profile. The trust ceiling, the approval rule and the
   per-request re-check are unchanged, so a binding still cannot raise a ceiling and a privileged run over HTTP still
   needs the operator (ADR-0017, ADR-0019).

## Alternatives considered

- Keep the refusal and require a `clients` map edit for privileged profiles: rejected, it defeats the request's
  `grok-bot` example.
- Allow `not_required` for bound codes: rejected, it would make unattended privileged runs reachable by a code.

## Consequences

- `bindableMcpClients` now includes privileged-ceiling entries whose approval is `required`.
- Tests: `src/cli/mcp-oauth.test.ts`, `src/mcp/oauth-server.test.ts`, `src/mcp/http-profile-resolution.test.ts`,
  `src/config/config.test.ts`.

## Revisit when

An owner decision restricts privileged work over HTTP further, or a second source of bindings is added.
