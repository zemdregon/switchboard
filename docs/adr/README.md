# Architecture Decision Records

ADRs own the *why* behind significant architectural choices. Requirements live in the [SRS](../requirements/SRS.md); scope and sequencing live in the [ROADMAP](../ROADMAP.md).

## Rules

- One decision per file, named `NNNN-short-title.md`, numbered sequentially. Numbers are never reused.
- Status is one of `Proposed`, `Accepted`, `Superseded by ADR-NNNN`, `Deprecated`.
- **Decided by** states who made the decision. "Delegated" means it was made by an agent under zemdregon's delegation for the 2026-10-12 planning task and has not been individually reviewed by zemdregon. It is binding for implementation until revised, but it is not owner-approved.
- Never rewrite an accepted ADR's decision. To change it, write a new ADR that supersedes it and update the old one's status line and `Superseded by` link only.
- Write a new ADR for any change that alters a component boundary, a persistence format, a trust or security boundary, an external interface, or the technology stack.

## Template

```markdown
# ADR-NNNN: Title

- Status: Proposed | Accepted | Superseded by ADR-NNNN
- Date: YYYY-MM-DD
- Decided by: zemdregon | Delegated (agent, date)
- Related: requirement IDs, other ADRs

## Context
## Decision
## Alternatives considered
## Consequences
## Revisit when
```

## Index

| ADR | Title | Status | Decided by |
|---|---|---|---|
| [0001](0001-controller-owned-canonical-state.md) | Controller-owned canonical state, provider sessions as optimization | Accepted | Delegated |
| [0002](0002-mcp-upstream-acp-downstream.md) | MCP as the upstream control plane, ACP as a downstream transport | Accepted | Delegated |
| [0003](0003-no-credential-handling.md) | The controller never handles provider credentials | Accepted | Delegated (codifies stated intent) |
| [0004](0004-trust-profiles-no-bypass-flags.md) | Trust profiles compiled per adapter; no automatic bypass flags | Accepted | Delegated |
| [0005](0005-sqlite-ledger.md) | SQLite ledger with append-only run events | Accepted | Delegated |
| [0006](0006-worktree-checkpoints-no-blind-replay.md) | Worktree per write-capable run; checkpoints; no blind replay | Accepted | Delegated |
| [0007](0007-capacity-as-confidence-estimate.md) | Capacity is a confidence-weighted scheduler estimate | Accepted | Delegated |
| [0008](0008-two-stage-routing.md) | Two-stage routing: hard eligibility, then scoring | Accepted | Delegated |
| [0009](0009-version-gated-adapters.md) | Version-gated adapters with conformance tests | Accepted | Delegated |
| [0010](0010-typescript-node-stack.md) | TypeScript on Node.js as the implementation stack | Accepted | Delegated |
| [0011](0011-single-operator-local-deployment.md) | Single-operator, local, Linux-first deployment | Accepted | Delegated |
| [0012](0012-telemetry-at-wrapper-boundary.md) | Telemetry at the wrapper boundary, never by mutating provider config | Accepted | Delegated |
