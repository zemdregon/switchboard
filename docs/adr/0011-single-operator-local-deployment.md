# ADR-0011: Single-operator, local, Linux-first deployment

- Status: Accepted
- Date: 2026-10-12
- Decided by: zemdregon (open source, each user runs their own instance, 2026-10-12); Delegated (agent, 2026-10-12) for
  local, stdio-only and Linux-then-macOS
- Related: NFR-PORT-01–03, NFR-PRIV-01, NFR-COMP-01, [ADR-0003](0003-no-credential-handling.md)

## Context

The research assumes the controller runs on a host where the operator's provider CLIs are installed and logged in.
zemdregon's stated intent (2026-10-12): Switchboard solves zemdregon's own problem first and is published as open
source, built so other people can use it. Shared or commercial use of subscriptions raises provider-terms questions the
verified research explicitly flags as needing review.

## Decision

Switchboard is distributed as open source and each user runs their own installation: one local process per operator, on
a machine they control, using that operator's own provider logins. MCP is served on stdio to a locally spawned
orchestrator. Linux is the first platform and macOS follows in M4; Windows is deferred. Shared multi-user, hosted, or
resale deployments are out of scope, and the project never offers them.

## Alternatives considered

- **Shared team server.** Rejected for now: credential sharing and provider-terms risk.
- **macOS first.** Possible, but Linux gives the clearest sandbox story (Landlock, bubblewrap) and CI coverage.

## Consequences

- No network listener, no user accounts, no web UI.
- Other people's use is supported by documentation and packaging (NFR-MAINT-03), not by accounts or shared servers. Each
  user is responsible for their own providers' terms (NFR-COMP-01).

## Revisit when

zemdregon decides Switchboard should serve other users or run as a hosted service.
