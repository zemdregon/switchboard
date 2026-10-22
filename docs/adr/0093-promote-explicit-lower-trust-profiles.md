# ADR-0093: Per-client promotion of an explicit lower trust profile to the configured default

- Status: Accepted (built 2026-10-21). Amends [ADR-0091](0091-configured-default-trust-profile-and-unattended-http-privileged.md)
  in part (for a client that opts in, an explicit `trust_profile` below the configured default no longer wins). The
  rest of ADR-0091 stands.
- Date: 2026-10-21
- Decided by: zemdregon for the outcome (owner ruling 2026-10-21, relayed by the orchestrator: the operator's prod
  Switchboard always runs bypass (`privileged` with each provider's bypass cell) for every client, project and enabled
  provider with no per-run approval, including callers that still pass `trust_profile: "trusted-development"`). The
  mechanism below (key name, per-client scope, comparison rule, visibility, validation, `doctor` line) is
  **Delegated** (agent, 2026-10-21) and not owner-approved.
- Related: FR-POL-13, FR-POL-12, FR-MCP-26, [FRD V5, V13, C4, C7](../requirements/FRD.md#71-delegate_task),
  [LLD §3.1](../design/LLD.md#31-privileged-scope-m3), [TDD §3.1](../design/TDD.md#31-configuration),
  [ADR-0017](0017-approved-privileged-scope-bypass.md), [ADR-0019](0019-per-client-privileged-approval.md),
  [ADR-0091](0091-configured-default-trust-profile-and-unattended-http-privileged.md), ROADMAP T3.30.

## Context

ADR-0091 resolves a request that omits `trust_profile` to the configured default (lowered to the request's effective
ceiling), but an explicit `trust_profile` always wins. Some orchestrator clients of the operator's prod deployment still
pass `trust_profile: "trusted-development"` on every call. Their runs get the lower tier and fail where the work needs
more (Bash commands denied, `git fetch` blocked), although the owner ruling is that every run on that deployment is a
bypass run. Changing every caller is not under the operator's control; the deployment needs a switch.

## Decision

1. **`mcp_clients[].promote_trust_profile`** (boolean, default `false`). When `true`, a `delegate_task` request, an
   `enqueue_work` request or a decision enqueue entry from that client whose explicit `trust_profile` ranks **below**
   the default ADR-0091 would give it (the configured project's `default_trust_profile`, else the top-level one,
   lowered to the request's effective ceiling) is resolved **as if `trust_profile` were omitted**: it gets that
   default, and for `privileged` the request's own `privileged_scope` when given, else `default_privileged_scope`
   (ADR-0091 rule 2).
2. **Never lowers, never exceeds.** A request at or above that clamped default is unchanged (so a request above a
   project's ceiling still fails V5 as before). Promotion goes no higher than the effective ceiling, so it never makes a
   request fail V5. With no default configured for the request there is nothing to promote to and the request is
   unchanged.
3. **Resolution is the request** (ADR-0091 rule 4). The idempotency hash, the eligibility question, the policy
   snapshot, the approval row (pre-approved by `client_policy:<client_id>` when the client is `privileged_approval:
   "not_required"`, ADR-0019) and a queued item's `request_json` use the promoted profile and scope, so a promoted
   request and the same request spelled out at the default are one request.
4. **Visible.** A promoted `delegate_task` run records a `trust_profile_promoted` run event at admission, in the
   admission transaction, with payload `{ "requested": <the explicit tier>, "resolved": <the run's profile> }`;
   `get_run` with `include_events` shows it, and the run's `trust_profile` is the promoted one. A queued item stores and
   reports (the `enqueue_work` response and `list_work`) the promoted `trust_profile`; the original tier of a queued
   request is not kept (Delegated: smallest honest option; the item never claims a tier it will not run at).
5. **`continue_task` is not promoted.** A continuation keeps its session's profile when it names none (C4), and an
   explicit lower one stays lower; a privileged continuation still needs the meta-session's approved approval (C7).
6. **Fail closed at load:** `promote_trust_profile: true` on a client is refused, with the error naming
   `$.mcp_clients[i].promote_trust_profile`, when neither a top-level nor any project `default_trust_profile` is
   configured.
7. **`doctor`** warns `trust_profile_promotion`, naming the clients that set it.
8. **Unchanged:** client and project ceilings, V13 (a scope with a non-privileged resolved profile is refused), scope
   validation, Git-write denial and worktree isolation of every tier, the bypass cells, and every client that does not
   set the key.

## Alternatives considered

- **One top-level switch for all clients.** Rejected (Delegated): the ruling covers the operator's deployment, but a
  per-client key keeps the effect to the clients the operator names and leaves other clients' explicit choices
  intact; on prod the operator sets it on every delegating client.
- **A per-client minimum profile** (`min_trust_profile`). Rejected: a second, independent profile setting per client
  that could disagree with the configured default and project defaults; promotion reuses the one ADR-0091 resolution
  and its clamping.
- **Reject a request below the default.** Rejected: the failing callers would still fail, now earlier; the ruling is
  that their runs succeed as bypass runs.

## Consequences

- On a deployment that sets the key, a promoting client cannot ask for a tier below the default; to get a lower tier
  for that client the operator removes the key or lowers the client's or project's ceiling.
- Without the key, behaviour is exactly ADR-0091's.

## Revisit when

- zemdregon wants a deployment-wide switch, or a caller needs a lower tier on a promoting client.
- Queued items need to keep the originally requested tier.
