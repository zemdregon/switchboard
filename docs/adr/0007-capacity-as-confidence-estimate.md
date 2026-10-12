# ADR-0007: Capacity is a confidence-weighted scheduler estimate

- Status: Accepted
- Date: 2026-10-12
- Decided by: Delegated (agent, 2026-10-12)
- Related: FR-CAP-01–07, FR-MCP-02

## Context

The stated intent includes "tier-aware load balancing across different provider subscriptions" (for example, 20% left on Claude Max 20x is more compute than 20% on ChatGPT Plus). The original blueprint proposed Normalized Compute Units (NCU) derived from token and cost output, plus a leaky bucket at ingress and token buckets per provider. The verified research found that reported costs are client-side estimates, subscription limits are opaque and not TPM/RPM, and that a constant-rate leaky bucket starves short interactive tasks behind long ones.

## Decision

- Keep the tier-aware intent, but represent capacity as a per-provider *estimate* with an explicit confidence, its sources, and `explicit_remaining` populated only when a provider actually reports remaining capacity.
- Operator config may declare each subscription's tier and a relative weight, used as a prior for the estimate.
- Ingress uses a bounded priority queue; each provider has a concurrency semaphore and circuit breaker. Token buckets are used only where a provider publishes enforceable limits.
- Backpressure replaces "infinite availability": fail over if allowed, queue if a reset is known, else return `QUOTA_EXHAUSTED`.

## Alternatives considered

- **NCU as a precise quota percentage.** Rejected: false precision.
- **Ignore capacity entirely.** Rejected: fails the tier-aware intent and causes avoidable throttling.

## Consequences

- `get_capacity` output is honest but less crisp than a single percentage.
- Estimates improve only as runs accumulate.

## Revisit when

Providers expose documented remaining-quota APIs or CLI output.
