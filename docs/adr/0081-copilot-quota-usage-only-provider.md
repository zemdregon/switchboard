# ADR-0081: Copilot quota as a usage-only provider via the operator's `gh`

- Status: Accepted (2026-10-21).
- Date: 2026-10-21
- Decided by: Delegated agent work on an operator task (2026-10-21), not owner-approved. The goal (show the operator's
  real GitHub Copilot quota in `get_capacity` and `switchboard capacity`, with no run adapter) comes from the operator's
  task; the details marked **Delegated** were chosen while building it.
- Related: FR-CAP-14, FR-CAP-03, FRD BR-50, FRD BR-59,
  [ADR-0003](0003-no-credential-handling.md) (no credential handling), [ADR-0050](0050-ci-status-via-operator-gh-cli.md)
  (the operator's `gh` and its environment allowlist `ghEnv`), [ADR-0077](0077-bypass-unconfined-and-every-provider-bypass-cell.md)
  (item 9 keeps a Copilot run adapter out of scope), [ADR-0007](0007-capacity-as-confidence-estimate.md),
  [research note](../research/copilot-usage-2026-10-21.md),
  [LLD §16.11](../design/LLD.md#1611-provider-reported-quota-of-a-usage-only-provider-fr-cap-14-adr-0081),
  [ROADMAP T6.22](../ROADMAP.md#611-m6-capacity-and-resilience-tasks).

## Context

An operator who uses GitHub Copilot CLI wants to see how much of its quota is left next to the other providers.
Copilot is not a Switchboard provider: there is no run adapter, and ADR-0077 item 9 keeps one out of scope. Capacity
output so far shows only controller estimates and the rare provider-reported figure from a run
([ADR-0007](0007-capacity-as-confidence-estimate.md)). The research note compares every source for Copilot's quota
that the operator host offers.

## Decision

1. **Copilot is a usage-only provider named `copilot`.** It appears only in a new additive `provider_quota` array of
   `get_capacity` and `switchboard capacity --json`. It has no adapter, no registry entry, no routing candidate, no
   concurrency slot, no breaker and no estimate. It feeds routing, pacing and the estimator nowhere (FRD BR-59).
2. **The source is the operator's own `gh`.** One fixed argv, `gh api /copilot_internal/user`, run with `execFile`
   (no shell), the allowlisted environment `ghEnv` of the CI trigger (ADR-0050), a 10 s timeout and stderr dropped. The
   output is parsed through a field allowlist; identifying fields (account id, login, analytics tracking id,
   endpoints, organisation lists) are dropped. The figures are labelled `provider_reported` (FR-CAP-01, FR-CAP-03).
3. **ADR-0003 holds.** Switchboard never reads, stores or passes the `gh` or Copilot token. The provider's own tool
   (`gh`) uses its own login, exactly as for CI status (ADR-0050) and `publish_run` (ADR-0069). The allowlisted
   environment carries no token variable.
4. **No model call, no premium request.** The call is a read-only GET of GitHub's own quota snapshot.
5. **Cached and fail-soft (Delegated).** Cached in memory for 60 s, single-flight (concurrent readers share one `gh`
   call). Any failure returns `status: "unavailable"` with a reason from the closed list `gh_missing`, `auth_required`,
   `gh_failed`, `timeout`, `unparseable`, `no_quota`, never an error for the tool and never a guess.
6. **On by default, with an opt-out (Delegated).** `capacity.copilot_quota` (boolean, default `true`); `false` turns
   the reader off and no `gh` call is made. Reasons for default on: one read-only GET through the operator's own
   tool, no model use, no credential handled, and the result only informs. The endpoint is undocumented (see Risks), so
   the key exists to stop the call. Opened as [Q-116](../ROADMAP.md#73-open-questions-for-zemdregon-not-blocking-m2-unless-noted)
   for the owner.
7. **Surfaces.** `get_capacity {"provider":"copilot"}` is accepted and returns `providers: []` plus `provider_quota`
   with the Copilot entry; with no provider argument it returns today's projection plus `provider_quota`; any other
   named provider is unchanged and gets no `provider_quota`. `switchboard capacity` prints a `copilot (usage-only ...)`
   section and accepts `--provider copilot`; `--json` includes `provider_quota`. `doctor` is unchanged. The schema is in
   LLD §16.11.
8. **No run adapter.** Reading a quota needs none; adding one is the separate decision ADR-0077 item 9 left out of
   scope.

## Consequences

- Capacity output gains a block that is absent when the reader is off, so a deployment with `capacity.copilot_quota:
  false` is byte-identical to before.
- The word "remaining" appears for these figures only because they are provider-reported (FR-CAP-03, BR-50).
- One more allowlisted outbound `gh` call. The HLD note on the CI trigger's `gh` use (TB-15) covers it.
- **Risk:** the endpoint is GitHub-internal and undocumented (the one the Copilot CLI and IDEs read). If its shape
  changes the allowlisted parse reports `unparseable`; if GitHub removes it the entry reads `gh_failed` or `no_quota`.
  Nothing else in Switchboard depends on it.
- Verified on one free plan only (research note); paid and organisation plans are **Unverified**.

## Alternatives considered

- **The documented billing API** (`gh api /users/<user>/settings/billing/premium_request/usage`). It works but returns
  only billed usage items (empty on a free plan) and no entitlement or limit, so it cannot show what is left. Rejected.
- **Interactive slash commands** (`/usage`, `/limits`). They exist only inside an interactive Copilot session and are
  not scriptable. Rejected.
- **Per-run statistics** (`copilot -p --output-format json`). Counts for that run only, and it needs a model call that
  consumes quota. Rejected.
- **Reading the `gh` or Copilot token and calling the endpoint directly.** Rejected by ADR-0003.
- **A Copilot run adapter** to get usage from runs. Out of scope (ADR-0077 item 9) and not needed.
- **Default off.** Considered; kept as the owner's choice in Q-116 because the call is read-only and leaves no side
  effect.
