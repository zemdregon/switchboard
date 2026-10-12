# ADR-0009: Version-gated adapters with conformance tests

- Status: Accepted
- Date: 2026-10-12
- Decided by: Delegated (agent, 2026-10-12)
- Related: FR-ADP-02–03, FR-ADP-09, FR-ADP-11, FR-OPS-02

## Context

The verified research documents fast CLI churn: Moonshot archived the legacy Kimi CLI on 2026-09-23 in favour of Kimi
Code, several original-blueprint flags were already wrong, and Claude Code features are gated by version. A silently
changed flag could weaken permissions or break parsing.

## Decision

Each adapter declares a validated version range. Preflight probes the installed version; outside the range the adapter
enters `ADAPTER_VERSION_UNVERIFIED` and is ineligible. The operator accepts a new version only after the adapter's
conformance suite passes against it (`adapters validate`). The Kimi Code adapter starts disabled until its contract is
pinned.

## Alternatives considered

- **Best-effort on any version.** Rejected: fails open.
- **Pin and vendor provider binaries.** Rejected: the operator owns installs and logins; vendoring may conflict with
  provider terms.

## Consequences

- Provider auto-updates can take an adapter offline until revalidated. The operator CLI must make this obvious.

## Revisit when

Providers publish stable, versioned automation contracts with deprecation guarantees.
