# ADR-0011: Single-operator, local, Linux-first deployment

- Status: Accepted
- Date: 2026-10-12
- Decided by: Delegated (agent, 2026-10-12), as a conservative assumption
- Related: NFR-PORT-01–03, NFR-PRIV-01, NFR-COMP-01, [ADR-0003](0003-no-credential-handling.md)

## Context

The research assumes the controller runs on a host where the operator's provider CLIs are installed and logged in. Nothing in the repository says whether Switchboard is a personal tool or a product for other people. Multi-user or commercial use raises provider-terms questions the verified research explicitly flags as needing review.

## Decision

Switchboard runs as one local process per operator, on the operator's own machine or a machine they control, using that operator's own provider logins. MCP is served on stdio to a locally spawned orchestrator. Linux is the first platform; macOS follows; Windows is deferred. Multi-user, hosted, or resale deployments are out of scope.

## Alternatives considered

- **Shared team server.** Rejected for now: credential sharing and provider-terms risk.
- **macOS first.** Possible, but Linux gives the clearest sandbox story (Landlock, bubblewrap) and CI coverage.

## Consequences

- No network listener, no user accounts, no web UI.
- Product scope questions (who else uses it) are recorded as open in the roadmap.

## Revisit when

zemdregon decides Switchboard should serve other users or run as a hosted service.
