# ADR-0032: Provider and model affinity in routing

- Status: Proposed (the thresholds are Assumptions; nothing is implemented)
- Date: 2026-10-13
- Decided by: zemdregon (the product request, owner decision 40, 2026-10-13: "also sticky sessions to increase cache
  hits. Generally only swapping providers and models when maxing out usage, or on user request, so that we dont round
  Robin a single project all the time causing a ton of cache misses."). Delegated (agent, 2026-10-13) for everything
  else: the closed reason list, the model rule, the recorded fields and the M6/M7 placement. Not owner-approved.
- Related: FR-RTE-06–09, FR-RTE-01–03, FR-CAP-02, FR-CAP-05, FR-CAP-06, FR-CAP-08, FR-SES-03, CAP-6, CAP-7, BO-9,
  [ADR-0007](0007-capacity-as-confidence-estimate.md), [ADR-0008](0008-two-stage-routing.md)
- Extends: [ADR-0008](0008-two-stage-routing.md) (adds an affinity step between stage 1 and stage 2) and
  [ADR-0007](0007-capacity-as-confidence-estimate.md) (a capacity estimate becomes one of the listed reasons to switch),
  without changing either decision. Neither accepted ADR is edited.

## Context

Audit (2026-10-13): sticky sessions were not planned or implemented. The closest existing items are FR-SES-03 (native
resume on the same provider, within one meta-session only), FR-RTE-02 (the score has a handoff-cost term, which
discourages a swap but never pins a provider) and FR-CAP-06 (failover on `QUOTA_EXHAUSTED`). Nothing keeps a project on
one provider and model across meta-sessions, nothing forbids score-driven swapping, and nothing observes cache
continuity. With the score alone, small differences in cost, load or estimated capacity can move one project between
providers from run to run, which is the round-robin zemdregon wants to avoid.

Whether and how much each provider's prompt cache pays off is not established in the research; that part is unverified
(Q-53).

## Decision

All Proposed and Delegated; the thresholds are Assumptions.

1. **Affinity is a routing rule, not a new mechanism.** It extends routing (FR-RTE) and capacity (FR-CAP). It adds no
   parallel router.
2. **Per project, remember the last provider and model that completed a run, and keep routing there** (FR-RTE-06). The
   project is the workspace for requests with `workspace_path`. Among providers that pass eligibility (FR-RTE-01), the
   affine one is chosen. The weighted score is not used to move a project, and no round-robin or load spreading exists
   for one project. FR-SES-03 still governs resume inside a meta-session.
3. **A closed list of reasons ends affinity** (FR-RTE-07): `user_request`, `capacity_exhausted`, `ineligible`,
   `failed_after_retry`. Each switch records an enumerated `affinity_switch_reason` in the routing decision (FR-RTE-03).
   A better score, lower cost or lower load is not a reason. This is the deliberate difference from ADR-0008's score.
4. **After a switch, the new provider becomes the affinity** and the controller does not return on its own when the old
   one recovers (Q-51). Only a listed reason moves it again.
5. **Capacity "maxed out" means a confidence estimate** (ADR-0007): a `QUOTA_EXHAUSTED` failure (FR-CAP-06), or the
   FR-CAP-02 estimate at or below a configured low-water mark with at least a configured confidence. The key names are
   `routing.affinity.low_water_mark` and `min_confidence`; their values are chosen in M6/M7 and none is stated here.
6. **Model stickiness** (FR-RTE-08): with no model named in the request, reuse the project's last model for the chosen
   provider, else the adapter default. A model changes only for `user_request` or `ineligible`.
7. **Cache-friendly prompt assembly** (FR-RTE-09, Could): stable content first, volatile content last, no reordering
   between runs of a project. The benefit per provider is unverified.
8. **Observe, do not claim.** Where a provider CLI reports cache token counts they are recorded as usage observations
   labelled by source, with per-project counts of kept versus switched runs by reason (FR-CAP-08). These figures are
   evidence for the operator, not a claim of cache hits.
9. **Configuration** `routing.affinity`: `enabled` (default true), `low_water_mark`, `min_confidence`, `idle_ttl`
   (default none, Q-52). The LLD owns the `project_affinity` table and the algorithm; the property "affinity never
   changes without a listed reason" is tested by replaying stored routing decisions.
10. **Placement.** Affinity lands in M6/M7: it needs several adapters (M4) and capacity (M6).

## Alternatives considered

- **Score only, with a larger handoff-cost weight.** Rejected: it still swaps whenever other terms outweigh the weight,
  and the reason for a swap is a sum of terms, not an auditable fact.
- **A strict pin forever.** Rejected: a project would stay on an exhausted, ineligible or failing provider. The closed
  reason list keeps the pin and still allows the exits zemdregon named (exhaustion, user request) plus the two that are
  safety floors.
- **Round-robin or load spreading across providers.** Rejected by the request: it causes the cache misses this change
  exists to stop.
- **Return to the first provider when it recovers.** Not adopted as the default: it adds a swap, and a cache miss, with
  no listed reason (Q-51).

## Consequences

- Load concentrates: a project spends one provider's quota first, so that provider reaches exhaustion earlier (R-58).
- The cache benefit is provider-specific and unverified, so the gain is a hypothesis until FR-CAP-08 shows data (R-58,
  Q-53).
- "Maxed out" is an estimate, so the switch can fire late (a failed run first, then `capacity_exhausted` or
  `failed_after_retry`) or early (R-58).
- FR-RTE-02, FR-RTE-03 and FR-CAP-06 are amended by dated notes in the SRS; no requirement is renumbered.
- A new table, `project_affinity`, and `routing_affinity_*` events are persistence changes covered by this ADR and by
  the LLD.
- Tests need no live provider: affinity is checked on fake adapters with injected capacity and failure.

## Revisit when

FR-CAP-08 data shows no cache benefit for a provider; operators report one provider's quota exhausted while others sit
idle (R-58); zemdregon answers Q-51 or Q-52 differently; or a provider documents cache behaviour that makes a rule
provider-specific.
