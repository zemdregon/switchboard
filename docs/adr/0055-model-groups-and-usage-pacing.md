# ADR-0055: Operator-configured model groups and usage pacing per subscription window

- Status: Proposed (partly built: the usage-window model T6.13, the pacing projection T6.14, the limit-signal
  mapping T6.15, the model-groups configuration T7.13 and the pacing gate T6.8 are Done 2026-10-17; the request
  fields and group-aware selection are not built; every default is an Assumption)
- Date: 2026-10-17
- Decided by: zemdregon (the product direction, [owner decision 57](../ROADMAP.md#42-owner-decisions), 2026-10-16:
  model groups across providers, pacing usage so that every subscription is used fully by the time its window resets,
  and limit capture for every provider). Delegated (agent, 2026-10-17, under [owner decision
  25](../ROADMAP.md#42-owner-decisions)) for everything else: the configuration shape, the request fields, the pacing
  arithmetic, the gate, the source labels and the defaults. Not owner-approved beyond the direction. Nothing here changes
  what a bypass run may do: groups and pacing only choose or delay among candidates that already passed the hard filter,
  and affinity still never moves a `privileged` meta-session to another provider.
- Extends: [ADR-0007](0007-capacity-as-confidence-estimate.md) (tier-aware capacity as an estimate),
  [ADR-0008](0008-two-stage-routing.md) (two-stage routing), [ADR-0032](0032-provider-model-affinity.md) (affinity) and
  [ADR-0044](0044-deterministic-route-scoring-and-replayable-decisions.md) (score and decision record), without editing
  any of them. Amends item 8 of [ADR-0043](0043-capacity-estimate-breaker-and-retry.md) ("no rate gate without a
  source"): the source of the gate is now observed usage, not a published limit.
- Related: FR-RTE-01 to FR-RTE-03, FR-RTE-06 to FR-RTE-08, FR-RTE-10, FR-RTE-11, FR-CAP-01 to FR-CAP-03, FR-CAP-07,
  FR-CAP-09 to FR-CAP-11, FR-ADP-04, FR-ADP-05, FR-MCP-02, FR-MCP-05, CAP-6, CAP-7, stated intent C-4 and C-5
  ([ROADMAP §4.3](../ROADMAP.md#43-stated-intent-confirmed-constraints)), owner decisions 2, 40 and 57,
  [FRD §3](../requirements/FRD.md#3-business-rules) (BR-49 to BR-51), ROADMAP T6.8, T6.11, T6.13 to T6.16 and T7.13 to
  T7.17. Contract text: [LLD §16.9](../design/LLD.md#169-usage-windows-and-pacing-fr-cap-09-fr-cap-10) and
  [LLD §17.7](../design/LLD.md#177-model-groups-fr-rte-10-fr-rte-11).

## Context

The stated intent asks for model definitions owned by Switchboard (C-4) and tier-aware load balancing across
subscriptions (C-5). ADR-0007 kept C-5 as a confidence-weighted estimate. ADR-0008 rejected a *static brand-to-tier
table in code*, because such a mapping decays with every model release. Owner decision 2 already routes this project's
own agent work by model tier, but only as an instruction to agents, not as a product feature.

On `main` (checked 2026-10-17 at `d405a60`):

- An orchestrator can name a provider (`provider_preference`, `require_provider`) and a capability floor
  (`minimum_capability`, T7.8), but it cannot name a model or a set of models. `delegate_task.routing` has no `model`
  field (`src/mcp/schemas.ts`), although FR-RTE-07 already counts "an explicit provider or model in the request" as
  `user_request`.
- The model registry (`providers.<id>.models`, LLD §2.1) holds model ids, aliases and capabilities per provider. Nothing
  groups models across providers.
- The capacity estimate (LLD §16.2) knows a rolling window of controller facts and a provider-reported `reset_at`. It has
  no notion of a subscription window, the share of it already used, or the time left in it.
- T6.8 (a token-bucket rate gate, FR-CAP-07) is `Deferred`, because no source publishes an enforceable rate limit for
  the logins in use (T6.0). The only provider-reported remaining figure in any source is Antigravity's separate `/usage`
  call (`remaining_fraction` and `reset_time` per window), which Switchboard does not call: a probe outside a run is a
  new question (Q-101).
- T6.11 captures limit output only for Claude Code and Codex. The operator host already records limit text for other
  CLIs in its logs (for example Cursor's "out of usage" refusal in the doc-alignment gate log); none of it is in the
  repository.

zemdregon asked (owner decision 57) for three things. First, named groups such as a low-cost group and a flagship group,
whose members are models from several providers, so that the orchestrator asks for a group and the router picks a member
by availability and usage headroom, with an explicit model still allowed. Second, pacing that emulates an enforceable
rate limit from observed usage, so that each subscription's usage reaches about 100% just as its window resets and work
shifts to the subscription with the most headroom relative to the time left. Third, limit and usage capture for every
provider.

AGENTS.md asks for an ADR because this adds an external interface (`routing.model_group` and `routing.model`, a `pacing`
block in `get_capacity`), configuration sections, a new run event type and a new version of the route decision record.

## Decision

All Proposed and Delegated except the direction itself; every number is an Assumption and configurable.

1. **Groups are operator configuration only.** `model_groups.<name>.members` is an ordered list of `{ provider, model }`
   pairs, where `provider` is a config provider id and `model` an id or alias that the model registry resolves (LLD
   §2.1). No group name, member, tier or model name appears in code, defaults or fixtures; examples use placeholders.
   The groups in owner decision 57 are the operator's example configuration, not facts about any provider. A group is not
   a capability claim: `minimum_capability` still uses the operator's declared `capabilities` (T7.8).
2. **The request names a group or a model, never both.** `routing.model_group` (a configured group name) and
   `routing.model` (one model id or alias) are optional and mutually exclusive. `provider_preference` and
   `require_provider` keep their meaning and narrow the group to that provider's members. An explicit `model` needs a
   provider (`provider_preference` or `require_provider`), or must resolve in exactly one enabled provider's registry;
   otherwise the request is `INVALID_REQUEST` (no guessing). An unknown group is `INVALID_REQUEST`. A request with
   neither field routes over providers as today, so nothing changes for existing callers.
3. **Members are candidates of the existing two stages.** Stage 1 (FR-RTE-01) runs per member: the provider's existing
   reasons, then model resolution in the registry, then the adapter's compile check with that model. A member that fails
   is excluded with its reason (for example `CAPABILITY_MISSING` from an adapter that accepts no model). Stage 2 scores
   the remaining members with the ADR-0044 terms of their provider plus one new term, `pacing` (item 7). The tie-break
   is `provider_preference`, then score, then member order in the group. If no member is eligible, the BR-3 code is
   returned as today.
4. **Affinity still comes first** (ADR-0032 is unchanged). If the project's affine provider and model form an eligible
   member of the requested group, affinity holds. If the group does not contain that pair, the request itself excludes
   it, which is `user_request`. If the pacing gate defers the affine subscription (item 8) while an undeferred eligible
   candidate remains, that is `capacity_exhausted`: the usage of that subscription is maxed out against its pace, which
   extends ADR-0032 item 5's meaning of "maxed out" and adds nothing to the closed reason list. If every candidate is
   deferred, affinity holds and the run waits for the affine subscription's gate (fail closed, keep the provider, as
   LLD §17.6 does for exhaustion). A better pacing score alone never moves a project.
5. **A subscription is a set of providers that share usage windows.** `capacity.subscriptions.<name>` names its
   providers (each provider in at most one subscription) and its windows. A window has a length and a reset rule:
   `provider_reported` (reset times come from the provider), `fixed` (an operator-declared anchor and period) or
   `rolling`. It may have an operator-declared budget (`runs`, `reported_tokens` or `reported_cost_usd`, with a value).
   A provider in no subscription has no windows, so its pacing is `unknown`. Switchboard never supplies a window
   length, reset time or budget for any provider: each one comes from the provider or from the operator.
6. **Usage per window comes from one labelled source, in this order.** (a) `provider_reported`: a used or remaining
   fraction and a reset time from a key that the capacity module declares for that provider in `USAGE_KEYS`. The set is
   empty until a task wires a sourced key, exactly as `REMAINING_KEYS` (ADR-0043 item 2). (b) `controller_estimated`: the
   operator-declared budget against the usage that Switchboard itself observed in the window (provider-reported counts
   from `usage_observation`, or run counts). It is labelled as an estimate and as a lower bound, because use of the same
   subscription outside Switchboard is not seen. Its confidence follows the reset rule's source. (c) `unknown`. The word
   "remaining" appears only next to a provider-reported value (FR-CAP-03).
7. **Pacing arithmetic.** For a window with length `L`, a known reset `R` and used fraction `u` at time `now`: elapsed
   `e = 1 - (R - now) / L`, target `T` (`capacity.pacing.target_fraction`, default 0.95), allowance
   `a = (T - u) / max(1 - e, ε)`. `a` is the share of a whole window's budget that may be spent per window length of
   time if usage is to reach `T` exactly at the reset. On pace `a ≈ T`; behind pace (underused) `a > T`; ahead of pace
   `a < T`. The subscription's binding window is the one with the smallest `a`. The `pacing` score term is
   `clamp(a / (2T), 0, 1)`: 0.5 on pace, 1 for twice the pace, 0 at or above the target. An unknown window scores 0,
   never headroom (Q-69, ADR-0044 item 2), and never makes a member ineligible. The term's weight
   (`routing.weights.pacing`) defaults to 1, like the others (Q-80).
8. **The pacing gate emulates an enforceable limit from observed usage** (FR-CAP-10, which T6.8 now builds). A window
   *defers* its subscription when its reset is known (`provider_reported` or `fixed`), its source is not `unknown`, an
   estimate's confidence is at least `capacity.pacing.min_confidence`, and `u ≥ min(T, T × e + B)`, where `B` is the
   burst allowance `capacity.pacing.burst_fraction` (default 0.10). The gate opens again at the time the pace line
   catches up (`e` such that `T × e + B ≥ u`) or at the reset, whichever comes first. Both are computable, so a hold is
   always bounded. At admission a deferred member is left out of selection whenever an undeferred eligible member
   remains (`PACING_DEFERRED`, recorded per candidate). When every eligible member is deferred, the run is admitted to
   the affine member if it is one (item 4), else to the member whose gate opens first. `pump()` then holds it in
   `QUEUED` until that time and records a `pacing_hold` event, as the breaker holds runs (FRD T4 guard). Pacing never
   refuses a request on its own, and never fails a run. `capacity.pacing.mode` is `gate` (default), `score` (term only)
   or `off`. A `rolling` window or an unknown source gives the score term only.
9. **"Use every subscription fully" means scheduling submitted work, not creating work.** Switchboard never starts a
   run, a probe or a filler task to consume a subscription, and never generates load on a provider. Headroom only decides
   where work that the orchestrator already submitted goes.
10. **Records and surfaces.** The route decision becomes `features_json.schema_version` 3. It adds `model_group`,
    `requested_model`, the members with their eligibility, and the per-subscription pacing inputs (`u`, its source,
    `L`, `R`, `T`, `B` and the gate verdict). A version 3 row replays exactly from the row alone, and version 1 and 2 rows
    replay as before. `explain_route` lists the group, the chosen member and the pacing factors. `get_capacity`,
    `switchboard capacity` and `doctor` gain a per-subscription `pacing` block from the one projection (ADR-0043 item 6),
    computed on read like the estimate. No table and no migration are needed; `pacing_hold` is a bounded run event type.
11. **Limit capture covers every provider** (FR-CAP-11, T6.11). The operator captures what each CLI (Claude Code, Codex,
    Cursor, Grok Build, Antigravity, OpenCode, Kimi Code, and Muse Code once it has a login) prints on a rate limit,
    overload, quota stop or usage report. The captures come only from the budgeted live-run channel and from the
    operator logs that already exist, never from generated load, and record key names, event types, exit codes and reset
    fields, never account identifiers or transcript content. An adapter maps a signal to a taxonomy code only from
    structured output (FR-ADP-04). A signal that a CLI gives only as free text stays unclassified until a decision says
    otherwise (Q-100). A sourced usage or reset key enters `USAGE_KEYS` only through its own task (T6.15).

## Alternatives considered

- **Tiers hard-coded in code or defaults** (for example "flagship" mapped to named models). Rejected for the reason
  ADR-0008 gives: the mapping decays with each release, and AGENTS.md forbids model names stated as fact.
- **The classifier picks the group from the task.** Not adopted now: the orchestrator asked to request a group, and
  ADR-0044 item 4 keeps features from ranking without a sourced mapping. It can be added later as a hint.
- **A token bucket per provider at an assumed rate.** Rejected: it needs a published limit (ADR-0007), and none exists
  for the logins in use. The pace line uses only reported or operator-declared numbers.
- **Treat an unknown window as on pace (0.5).** Rejected: an unknown subscription would outrank one that is known to be
  ahead of pace, which is the Q-69 error.
- **Return `QUOTA_EXHAUSTED` when every member is deferred.** Rejected: the gate is a pacing device and the subscription
  is not exhausted. Holding until the computable gate-open time is what an enforceable limit does, and it is bounded.
- **Let pacing move an affine project before its gate fires**, to spread usage. Not adopted by default: owner decision
  40 asks to switch only when usage is maxed out. Q-97 asks zemdregon whether the new direction should change that.
- **Call Antigravity's `/usage` from the controller.** Not decided here: a new probe outside a run is Q-101.

## Consequences

- An orchestrator can ask for "the cheap group" or "the flagship group" without knowing which provider has headroom, and
  the operator changes the membership by editing configuration, not code.
- Until a provider-reported usage key is wired, pacing runs on operator-declared budgets. Its values are estimates that
  see only Switchboard's own usage, so they understate use made outside Switchboard (R-67). Without declared windows,
  pacing is inert, and every existing test passes unchanged.
- A member whose adapter refuses any model (Codex today: no documented model flag, Q-11) is excluded with
  `CAPABILITY_MISSING` until its model flag is sourced, so such a member is configurable but never chosen (R-68).
- Affinity keeps a project on one subscription until that subscription's gate fires, so usage concentrates per project.
  New projects and switched projects go where the headroom is.
- FR-CAP-07, FR-RTE-07 and ADR-0043 item 8 get dated notes, and no requirement is renumbered.

## Revisit when

A provider documents usage or reset fields in its run output, or Q-101 (a `/usage` probe) is answered; T6.11
captures change what is sourced; zemdregon answers Q-97 (pacing against affinity), Q-98 (target and burst defaults)
or Q-102 (which provider serves an example member); or
the operator finds that `controller_estimated` pacing misjudges a subscription that is also used outside Switchboard.
