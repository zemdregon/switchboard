# ADR-0091: Configured default trust profile and scope, and opt-in unattended privileged runs over HTTP

- Status: Accepted (built 2026-10-21). Amends [ADR-0019](0019-per-client-privileged-approval.md) in part (an HTTP
  client may carry `privileged_approval: "not_required"` when the operator opts in) and
  [ADR-0086](0086-bound-codes-follow-the-mapped-rule.md) and FR-MCP-14 in part (a mapped or bound entry with
  `not_required` is accepted under the same opt-in). Both decisions stand otherwise.
- Date: 2026-10-21
- Decided by: zemdregon for the outcome (owner ruling 2026-10-21, relayed by the orchestrator: the operator's prod
  Switchboard always runs in bypass mode, trust profile `privileged` with each provider's bypass cell
  ([ADR-0017](0017-approved-privileged-scope-bypass.md), [ADR-0077](0077-bypass-unconfined-and-every-provider-bypass-cell.md)),
  for every run delegated by any client, stdio or OAuth/HTTP, on every project and every enabled provider, unless the
  caller asks for another profile, and runs never stall on a per-run approval; restrictive defaults stay for other
  deployers). The mechanism below (key names, resolution order, clamping, validation, `doctor` lines) is **Delegated**
  (agent, 2026-10-21) and not owner-approved.
- Related: FR-POL-12, FR-MCP-26, FR-MCP-27, FR-MCP-03, FR-MCP-06, FR-MCP-14, FR-MCP-21, FR-POL-09,
  [FRD V5, V13](../requirements/FRD.md#71-delegate_task), [LLD §3.1](../design/LLD.md#31-privileged-scope-m3),
  [LLD §3.3](../design/LLD.md#33-network-mcp-transport-m13), [TDD §3.1](../design/TDD.md#31-configuration),
  [ADR-0019](0019-per-client-privileged-approval.md), [ADR-0041](0041-http-transport-with-oauth-2-1.md),
  [ADR-0086](0086-bound-codes-follow-the-mapped-rule.md), ROADMAP T3.28.

## Context

Before this change every `delegate_task` and `enqueue_work` request had to name `trust_profile`, and a `privileged`
request had to carry its own `privileged_scope` (FRD V13). A client that forgot either got a lower profile or an
error. ADR-0019 lets a stdio client be configured `privileged_approval: "not_required"`, so its privileged runs are
admitted pre-approved, but every HTTP-reachable entry (a `transport.http.clients` mapping, a ledger binding from a
profile-bound code, `default_mcp_client`) was refused `not_required` at config load, at `mcp oauth issue-code` and on
every request (`httpProfileProblem`). The operator's prod orchestrator reaches Switchboard over HTTP, so its privileged
runs always waited in `AWAITING_APPROVAL`. The owner ruling asks for the opposite on the operator's own deployment,
without changing what other deployers get.

## Decision

All keys are optional; absent, behaviour is exactly as before.

1. **`default_trust_profile`** (top level, a trust profile) and **`projects[].default_trust_profile`** (configuration
   file projects only; it overrides the top-level one for that project). A request with no `trust_profile` resolves to
   the project's default, else the top-level one, then is **lowered to the request's effective ceiling** (the client's
   maximum, and in a project the lower of that and the project's `max_trust_profile`), so a default never fails V5: a
   project capped at `edit-untrusted` gets `edit-untrusted`, an `inspect-untrusted` client gets `inspect-untrusted`.
   A dynamic project has no such key and uses the top-level default, clamped the same way. With neither configured the
   request is `INVALID_REQUEST` `trust_profile is required` with `details.field = "trust_profile"`
   (`request.trust_profile` for `enqueue_work`, `enqueue[i].request.trust_profile` for a decision's enqueue list).
2. **`default_privileged_scope`** (top level, a `privileged_scope` object of LLD §3.1). It is checked at load by the same
   closed schema and list rules as a request's scope (`parsePrivilegedScope`), with the error naming its JSON path, and
   stored parsed (`bypass` filled). When the resolved profile (defaulted or requested) is `privileged` and the request
   names no scope, this scope is the request's scope. An explicit `privileged_scope` always wins. A scope with a
   non-privileged profile is still refused (V13); with neither a request scope nor a default, V13 refuses as before.
3. **Fail closed:** config load is refused if any default trust profile (top level or project) is `privileged` and
   `default_privileged_scope` is absent.
4. **Resolution is the request.** The idempotency hash, the eligibility question, the policy snapshot and the
   approval row use the resolved profile and scope, so a defaulted request and the same explicit one are one request.
   `enqueue_work` and each decision enqueue entry store the resolved `trust_profile` and `privileged_scope` in the work
   item's `request_json`, so queue admission (`src/queue/admission.ts`) is unchanged and an item keeps the default it
   was queued under. `list_projects` items carry `default_trust_profile` (the clamped default) when one is configured.
   `continue_task` is unchanged (it already defaults to the session's profile, C4, and a privileged continuation still
   needs the meta-session's approved approval, C7).
5. **`transport.http.allow_unattended_privileged`** (boolean, default false). When true, `httpProfileProblem` no longer
   returns `approval_not_required` for the `mapped` and `bound` sources: a `transport.http.clients` mapping or a
   profile-bound code may name an entry with `privileged_approval: "not_required"`, and that client's privileged runs
   are admitted pre-approved by `client_policy:<client_id>` exactly as on stdio (ADR-0019). Config load, `mcp oauth
   issue-code` and the per-request binding re-check all read the flag through that one function. `default_mcp_client`
   is never relaxed: it still refuses a privileged ceiling and `not_required`.
6. **`doctor`** warns when any default trust profile is `privileged` (`privileged_default`), and when
   `allow_unattended_privileged` is on (`unattended_http_privileged`), naming the HTTP-mapped or bindable clients with
   `not_required`.
7. **Unchanged:** the client and project ceilings (V5), scope validation, the dispatch-time hash checks, Git-write
   denial and worktree rules of each tier, the bypass cells themselves and every untrusted profile.

The operator's prod configuration sets `default_trust_profile: "privileged"`, a `default_privileged_scope` with
`bypass: true`, `privileged_approval: "not_required"` on the clients that delegate, and
`transport.http.allow_unattended_privileged: true`. That is configuration on the operator host, not part of this
repository.

## Alternatives considered

- **A per-client default profile.** Rejected (Delegated): the ruling is per deployment; a client-level key adds a
  third resolution layer and the ceilings already give per-client and per-project control.
- **Refuse a default above the ceiling instead of clamping.** Rejected: the ruling is that every run uses the default
  "unless the caller asks for another profile"; a project capped below it should still run, at its own ceiling.
- **Relax `default_mcp_client` too.** Rejected (fail closed): it would make every approved OAuth client privileged and
  unattended without an explicit mapping, which ADR-0041 and ADR-0086 kept strict.
- **Leave the HTTP refusal in place and approve through `approval_proxy`.** Rejected: runs would still stall until a
  proxy decided them.

## Consequences

- A deployment without the new keys is unchanged: `trust_profile` stays required, V13 unchanged, every HTTP source
  refuses `not_required`.
- On a deployment that sets them, a request that omits `trust_profile` runs `privileged` under the operator's scope
  wherever the ceilings allow it; a client that wants a lower tier must ask for it explicitly. The `doctor` lines make
  the setting visible.
- An HTTP client mapped to a `not_required` entry can start unattended privileged runs; the security boundary is the
  operator's mapping or the code they issue on the host, as for stdio.

## Revisit when

- zemdregon wants per-client defaults, or a deployer asks for a default that refuses rather than clamps.
- `default_mcp_client` needs the same opt-in.
