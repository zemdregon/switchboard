# ADR-0043: Capacity estimate computed on read, per-provider breaker in `provider_health`, retries as linked successor runs

- Status: Proposed
- Date: 2026-10-14
- Decided by: Delegated (agent, 2026-10-14, ROADMAP T6.1), under [owner decision 25](../ROADMAP.md#42-owner-decisions)
  for everything outside bypass mode. Not a zemdregon quote and not owner-approved. Nothing here changes what a bypass
  run may do: a failover to another provider of a `privileged` run is the cross-provider case of
  [Q-61](../ROADMAP.md#73-open-questions-for-zemdregon-not-blocking-m2-unless-noted) and keeps its fail-closed default.
- Extends: [ADR-0007](0007-capacity-as-confidence-estimate.md) (capacity is a confidence-weighted estimate) without
  editing it. Builds on [ADR-0006](0006-worktree-checkpoints-no-blind-replay.md) (no blind replay) and
  [ADR-0038](0038-handoff-bundle-and-continuity.md) (the bundle a failover reuses).
- Related: FR-CAP-01 to FR-CAP-08, FR-MCP-02, FR-MCP-10, FR-OPS-05, FR-INN-15, NFR-PERF-03, NFR-SEC-06,
  [FRD WF-5](../requirements/FRD.md#wf-5-failure-handling-and-retry), [FRD §3](../requirements/FRD.md#3-business-rules)
  (BR-3, BR-6 to BR-9, BR-41), ROADMAP T6.0 to T6.12, the
  [T6.0 inventory](../research/capacity-signals-2026-10-14.md). Contract text:
  [LLD §16](../design/LLD.md#16-capacity-and-resilience-m6).

## Context

M6 makes capacity visible and failures recoverable (ROADMAP §6.11). On `main`, usage is recorded as reported (M2), the
`provider_health` table exists with breaker columns that nothing reads or writes, the run row has `parent_run_id`,
`attempt` and `next_attempt_at` that nothing sets for a retry, and `WAITING_CAPACITY` is a state that no transition
enters. LLD §3 and §9 leave `get_capacity`, breakers and failover "to be detailed in M6".

The T6.0 inventory found that no provider's run output reports remaining quota. The only provider-reported remaining
figure is Antigravity's separate `/usage` command. Cache counts are reported by some CLIs. Reset times are known only from
the Claude Code parser's assumed `rate_limit_event` shape. No provider publishes an enforceable rate limit for the
logins Switchboard uses. An estimator built on these inputs mostly sees controller facts: run outcomes, breaker state
and slots.

AGENTS.md asks for an ADR because this adds an external interface (`get_capacity`, two `get_run` fields and new run
event types), writes a table that nothing wrote before, and changes the run lifecycle (successor runs).

## Decision

1. **The estimate is computed on read.** The estimate is a pure function of ledger rows (runs, run events,
   `provider_reported` usage rows, the `provider_health` row), configuration, slot counts and a clock. Nothing stores it.
   `provider_health.capacity_json` stays `NULL`, so there is no second copy that could go stale. The same ledger, config
   and clock give byte-identical output, which also proves that inner-agent rows (BR-41) change nothing, because the
   estimator never reads them.
2. **Unknown is unknown.** With no evidence in the window, `capacity_score` is `null`, `confidence` is 0 and
   `throttle_risk` is `unknown`. Nothing shows that as headroom. An unknown estimate never makes a provider ineligible,
   because otherwise every provider would be ineligible. Only positive evidence does: an open breaker, or a provider-reported
   `reset_at` still in the future after a `QUOTA_EXHAUSTED` failure (T6.6). `explicit_remaining` is filled only from a
   key that the capacity module declares as provider-reported remaining capacity for that provider. The declared set is
   empty until a task wires a sourced key, so today it is `null` for every provider.
3. **Per-provider breaker in `provider_health`.** Only `RATE_LIMIT_TRANSIENT`, `PROVIDER_OVERLOADED` and
   `PROCESS_CRASH` count, and a crash caused by a controller restart does not. Enough counted failures in a row open the
   breaker until a cool-down ends. Then one run at a time is the `HALF_OPEN` probe. A healthy outcome closes the
   breaker and a counted failure opens it again. While the breaker is open, the provider is ineligible with reason
   `CIRCUIT_OPEN`, which BR-3 maps to `ELIGIBILITY_NONE`. Runs already queued for it wait in `QUEUED`, as the guard on
   FRD T4 requires. The row survives a restart.
4. **Retries are linked successor runs.** At T16 a retryable failure on a byte-identical workspace (BR-7) creates a new
   run in the same meta-session. It has `parent_run_id` set to the failed run, `attempt + 1`, the same request and
   `request_hash`, no idempotency key, `WAITING_CAPACITY` and a `next_attempt_at` from LLD §9. A timer moves it to
   `QUEUED` (T18). The chain ends without a successor when attempts are exhausted, when the provider's breaker is open,
   or when a provider-reported reset lies beyond the wait bound. A run orphaned by a controller restart is not retried
   automatically (the controller cannot know what the provider did outside the worktree); the orchestrator decides.
5. **`get_run` gains `retry_of` and `superseded_by`** (both nullable, additive), so a caller's original `run_id` leads
   to the attempt that is running now (FR-MCP-10).
6. **One projection for `get_capacity`, `switchboard capacity` and `doctor`.** Each provider entry carries the FR-CAP-02
   fields. Each figure is labelled by source (`controller_estimated` for the estimate, `provider_reported` for
   `reset_at` and `explicit_remaining`). On any surface, the word "remaining" appears only next to a provider-reported
   value (FR-CAP-03).
7. **Quota ladder (T6.6).** On `QUOTA_EXHAUSTED`, the controller fails over through the M5 bundle when the request
   permits it. Otherwise it waits for a known reset within `capacity.queue_horizon_seconds`, and otherwise returns the
   code. The horizon default is 0: the controller never holds a run for a provider reset unless the operator opts in.
   The orchestrator gets the code and the reset time and decides. A `privileged` run never fails over to another
   provider while Q-61 is open.
8. **No rate gate without a source** (FR-CAP-07). No configuration key is added until T6.0's table names an enforceable
   limit.
9. **No migration.** Every column used already exists (migration 0001). The new run event types are bounded and carry no
   provider text.

## Alternatives considered

- **Store the estimate in `provider_health.capacity_json`, refreshed on each run end.** Rejected for now. It gives two
  sources of truth, the stored copy goes stale as the window moves, and the inner-agent "byte-identical" property would
  hold only for the writer. The column stays for a later cache if reads become slow.
- **Treat unknown capacity as unavailable.** Rejected. No provider reports remaining quota, so every provider would be
  ineligible.
- **A score from token sums against an assumed plan size.** Rejected. It needs plan limits that no source gives (ADR-0007:
  false precision).
- **In-memory breaker, as for the inner agent.** Rejected for providers. A restart would forget an open breaker and send
  the next run straight into the same overload. The table already exists.
- **Retry by re-running the failed run row.** Rejected: FRD §4.1 says retry is not a backward edge, and each attempt is
  its own evidence (ADR-0006).
- **Retry orphaned runs after a restart.** Rejected as a default: a controller crash leaves no trustworthy record of what
  the provider did outside the worktree.

## Consequences

- `get_capacity` is honest and often says "unknown". It sharpens only as runs accumulate or as a provider starts to
  report figures (ADR-0007's consequence, unchanged).
- A breaker can hold back a provider that recovered early, for at most one cool-down. The thresholds are Assumptions,
  are configurable and are recorded as Q-70.
- Successor runs make the ledger longer, bounded by `capacity.retry.max_attempts`.
- `continue_task` refuses while a successor is waiting, because the meta-session has an active run. Cancelling the
  successor clears it.

## Revisit when

A provider's run output reports remaining quota or a reset time in a sourced shape (T6.11, the M4 operator checks); M7
adds affinity (a failover becomes a `capacity_exhausted` switch); or reading the estimate becomes slow enough to cache.
