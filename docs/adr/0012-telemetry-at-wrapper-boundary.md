# ADR-0012: Telemetry at the wrapper boundary, never by mutating provider config

- Status: Accepted
- Date: 2026-10-12
- Decided by: Delegated (agent, 2026-10-12)
- Related: FR-TEL-01–03, FR-POL-08

## Context

The original blueprint proposed injecting global Claude hooks into `~/.claude/settings.json` before each run and reading transcript bytes from a `Stop` hook. The verified research notes hooks are documented (not "undocumented"), but rewriting global config per run races between concurrent sessions and makes cleanup failures security-relevant; every run already yields rich observable data at the wrapper boundary.

## Decision

Telemetry is produced by the controller from what it observes: spawn parameters, adapter version, routing decision, structured stdout events, stderr, resource usage, exit status, workspace diff, verification results and reported usage. It is stored as run events and exported as OpenTelemetry traces when configured. Provider hooks may be used only through per-run or dedicated config directories, never by editing global provider config.

## Alternatives considered

- **Global hook injection.** Rejected: races and cleanup risk.
- **Transcript tailing.** Rejected with ADR-0001.

## Consequences

- Some provider-internal detail visible only through hooks is unavailable; acceptable.

## Revisit when

A needed signal is only observable through a hook and a per-run config mechanism exists for that provider.
