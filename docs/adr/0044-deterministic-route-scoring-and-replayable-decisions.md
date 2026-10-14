# ADR-0044: Deterministic route scoring with neutral defaults, replayable decision records and affinity details

- Status: Proposed
- Date: 2026-10-14
- Decided by: Delegated (agent, 2026-10-14, ROADMAP T7.0), under [owner decision 25](../ROADMAP.md#42-owner-decisions)
  for everything outside bypass mode. Not a zemdregon quote and not owner-approved. Nothing here changes what a bypass
  run may do: routing only chooses among providers that passed the hard filter, and affinity never moves a `privileged`
  meta-session to another provider.
- Extends: [ADR-0008](0008-two-stage-routing.md) (two-stage routing) and [ADR-0032](0032-provider-model-affinity.md)
  (provider and model affinity) without editing either. Reads the estimate of
  [ADR-0043](0043-capacity-estimate-breaker-and-retry.md).
- Related: FR-RTE-01 to FR-RTE-04, FR-RTE-06 to FR-RTE-08, FR-MCP-02, FR-CAP-06, FR-CAP-08, FR-INN-12,
  [FRD §3](../requirements/FRD.md#3-business-rules) (BR-1 to BR-4, BR-39, BR-45), ROADMAP T7.0 to T7.11. Contract text:
  [LLD §17](../design/LLD.md#17-routing-m7), with [LLD §3.2](../design/LLD.md#32-provider-and-model-affinity-m7).

## Context

M7 adds stage 2 of routing (ROADMAP §6.12). On `main` there is no score: the MCP server picks `provider_preference` if
it is eligible, else the first eligible provider in configured order, and stores eligibility only. ADR-0008 says to rank
with static weights over six terms (success, latency, capacity risk, security risk, handoff cost, money); ADR-0032 puts
an affinity step before the score. Neither says where each term's value comes from, and for three of them no source
exists: no provider price, no model ranking and no sandbox-strength order is in the research, and T6.0 found none for
the logins in use. LLD §3.2 leaves the affinity thresholds, the moment the row is written and the detection of each
reason open.

AGENTS.md asks for an ADR because this adds an external interface (`explain_route`), a persistence format (the version 2
route decision and three columns on the not yet built `project_affinity` table) and configuration keys.

## Decision

1. **Unsourced terms are neutral.** `security` and `cost` take 0.5 for every candidate, so they can never decide a
   route; they exist so that a later sourced value plugs in without a format change. Terms from the controller's own
   ledger are facts: `success` (smoothed healthy share, using the breaker's classification), `latency` (median wall time
   relative to the fastest candidate) and `handoff` (1 for the meta-session's provider).
2. **Unknown capacity scores as no capacity.** A `null` `capacity_score` gives the capacity term 0, its worst value
   (Q-69: unknown is never headroom). It never makes a provider ineligible.
3. **Weights default to 1 each, configurable 0 to 100.** No source ranks the terms against each other, so the default
   treats them equally (Assumption, Q-80). With no history every candidate ties and the configured order decides, which
   is the M2 behaviour.
4. **Features are recorded, not used to rank.** The FR-RTE-04 heuristic classifier produces the LLD §13.6 enumeration
   from the request alone. With no sourced per-provider mapping from a feature to a provider's fitness, no feature
   changes a route in M7 (Q-82).
5. **Selection order:** `require_provider`, affinity, `provider_preference`, score, configured order. A preference stays
   a hint and is not an affinity reason (LLD §3.2).
6. **Every decision is self-contained and versioned.** `features_json.schema_version` 2 carries the per-candidate score
   inputs, the configured order and the hints; replay recomputes from that row and the stored weights alone, with exact
   number comparison, and never calls a model or a provider.
7. **`explain_route` reads only the stored row,** under the same ownership rule as `get_run`, and adds template-derived
   `deciding_factors`, never model text.
8. **Affinity details, fail closed.** The estimate trigger is off by default (both thresholds `null`), so only positive
   evidence of exhaustion switches (Q-81). The row is written only when a run whose decision applied affinity succeeds,
   so a failed first run creates none. Continuations (FR-SES-03, BR-18) never move the row; the quota failover successor
   does, as `capacity_exhausted`. `idle_ttl` accepts only `null` until expiry is built. Reset is two columns on the row,
   consumed once by the next routing step as `user_request`.

## Alternatives considered

- **Invent defaults for price or sandbox strength** (for example from public price pages or vendor claims). Rejected:
  AGENTS.md forbids unsourced facts, and a wrong value would silently steer every first run.
- **Score unknown capacity as neutral (0.5).** Rejected: it would rank a provider with no evidence above one with known,
  low headroom, which is the "unknown as headroom" error Q-69 rules out.
- **Store only the result and recompute inputs on replay.** Rejected: inputs drift with the ledger (window, new runs), so
  replay could not reproduce a past decision.
- **Write the affinity row at routing time** (§3.2 step 5 read literally). Not adopted: §3.2 step 7 says a failing first
  run creates no affinity, which writing on success satisfies without a rollback path.

## Consequences

- With the defaults, routing changes only where the controller has evidence: providers with more counted failures, slower
  successful runs or a known lower capacity estimate rank lower on a project's first run or after a switch.
- `explain_route` can show why a provider was chosen without any model reasoning; M2 rows are explained as
  eligibility-only.
- Three neutral or recorded-only parts (security, cost, features) carry no information until a source exists; the
  README must not claim otherwise.
- The M7 migration adds `project_affinity` with three more columns than LLD §3.2's first DDL; the LLD records both.
