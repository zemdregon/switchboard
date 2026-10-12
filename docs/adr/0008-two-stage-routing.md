# ADR-0008: Two-stage routing: hard eligibility, then scoring

- Status: Accepted
- Date: 2026-10-12
- Decided by: Delegated (agent, 2026-10-12)
- Related: FR-RTE-01–05, FR-MCP-05

## Context

The original blueprint mapped complexity tiers to brands (low: Kimi/Gemini Flash, medium: Cursor/OpenCode, high: Claude/Grok) and proposed Item Response Theory as the routing engine. The verified research notes that such mappings decay with each model release, and that IRT captures one difficulty dimension while real constraints (sandbox strength, auth state, quota, platform) are hard filters.

## Decision

1. **Eligibility filter** removes any provider failing a hard constraint (FR-RTE-01). This ships first (M2) because it is also a security control.
2. **Scoring** ranks eligible providers with operator-configurable static weights over success likelihood, latency, capacity risk, security risk, handoff cost and money (M7).
3. Every decision is persisted with features and scores for `explain_route`.
4. Learned weights (contextual bandit) are deferred until enough outcome data exists; IRT may be used offline as one feature.

## Alternatives considered

- **Static brand-to-tier table.** Rejected: decays quickly.
- **Learned router from day one.** Rejected: no outcome data, and it would learn from unverified execution semantics.

## Consequences

- Early routing is simple and predictable; quality depends on the operator's weights and the model registry.

## Revisit when

At least several hundred completed runs with verification outcomes exist (proposed threshold), making learned weights testable.
