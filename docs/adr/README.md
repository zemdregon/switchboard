# Architecture Decision Records

ADRs own the *why* behind significant architectural choices. Requirements live in the [SRS](../requirements/SRS.md);
scope and sequencing live in the [ROADMAP](../ROADMAP.md).

## Rules

- One decision per file, named `NNNN-short-title.md`, numbered sequentially. Numbers are never reused.
- Status is one of `Proposed`, `Accepted`, `Superseded by ADR-NNNN`, `Deprecated`.
- **Decided by** states who made the decision. "Delegated" means it was made by an agent under Ender's delegation for
  the 2026-10-12 planning task and has not been individually reviewed by Ender. It is binding for implementation until
  revised, but it is not owner-approved.
- Never rewrite an accepted ADR's decision. To change it, write a new ADR that supersedes it and update the old one's
  status line and `Superseded by` link only.
- Write a new ADR for any change that alters a component boundary, a persistence format, a trust or security boundary,
  an external interface, or the technology stack.

## Template

```markdown
# ADR-NNNN: Title

- Status: Proposed | Accepted | Superseded by ADR-NNNN
- Date: YYYY-MM-DD
- Decided by: Ender | Delegated (agent, date)
- Related: requirement IDs, other ADRs

## Context
## Decision
## Alternatives considered
## Consequences
## Revisit when
```

## Index

| ADR | Title | Status | Decided by |
| --- | --- | --- | --- |
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
| [0013](0013-projects-environments-and-contexts.md) | Projects own environments and contexts | Accepted (concept); container details Proposed | Ender (concept), Delegated (mechanism) |
| [0014](0014-tool-only-commits-and-publication.md) | Agents never commit or push; Switchboard-injected tools do | Accepted; supersedes the no-push clause of ADR-0006 | Ender (decision), Delegated (mechanism) |
| [0015](0015-claude-untrusted-isolation-flags.md) | Claude untrusted profiles use safe-mode isolation flags, not `--bare` | Accepted; partly superseded by ADR-0018 for approved bypass runs | Delegated |
| [0016](0016-inner-agent.md) | An inner agent handles cheap, low-stakes tasks, with no authority over security | Accepted | Ender (product decision), Delegated (mechanism) |
| [0017](0017-approved-privileged-scope-bypass.md) | Bypass flags only for an approved privileged scope that sets bypass; complements ADR-0004. Amended before merge (2026-10-13; numbered 0016 while planned): machine-readable scope; approval durable per meta-session | Accepted; approval requirement amended by ADR-0019 for clients configured `privileged_approval: "not_required"` | Delegated (records owner decisions 13 and 17) |
| [0018](0018-claude-bypass-omits-restricted.md) | Approved Claude Code bypass runs omit `--restricted`; partly supersedes ADR-0015 | Accepted | Ender (owner decisions 19, 22), mechanism Delegated |
| [0019](0019-per-client-privileged-approval.md) | Per-client `privileged_approval` setting; amends ADR-0017's approval requirement for clients configured `not_required` | Accepted | Ender (owner decisions 19, 22), mechanism Delegated |
| [0020](0020-container-image-without-git-client.md) | Container images contain no Git client; Git runs on the host; amends ADR-0013's container mechanism | Accepted (rule); runtime and login details stay Proposed in ADR-0013 | Ender (owner decision 24), mechanism Delegated |
| [0021](0021-repository-config-in-approved-bypass-runs.md) | Approved bypass runs may load repository configuration (`approved`, `enabled`); amends ADR-0018 | Accepted (decision); flag behaviour unverified | Ender (owner decision 26), mechanism Delegated |
| [0022](0022-nested-repositories-excluded-from-controller-git.md) | Nested repositories are excluded from controller Git calls; the run does not fail | Accepted | Delegated (agent, under owner decision 25; not an Ender quote) |
