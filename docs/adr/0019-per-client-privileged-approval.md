# ADR-0019: Per-client `privileged_approval` setting

- Status: Accepted
- Date: 2026-10-13
- Decided by: zemdregon (owner decisions 19, 22), mechanism Delegated (agent, 2026-10-13). zemdregon decided that in approved
  bypass runs only the per-scope approval is lifted, while Git-write denial (FR-GIT-01, owner decision 7) and worktree
  isolation (FR-WS-05) stay enforced (owner decision 22), with the restrictive defaults kept for other deployers (owner
  decision 18). The realisation below (a per-client configuration setting, its name, values and default, and the
  admission mechanics) is Delegated and not owner-approved.
- Related: FR-POL-03, FR-POL-09, FR-MCP-06, FR-OPS-01, FR-OPS-02, FR-OPS-04, FR-GIT-01, FR-WS-05,
  [FRD BR-13, BR-14](../requirements/FRD.md#3-business-rules), [FRD WF-7](../requirements/FRD.md#wf-7-privileged-approval),
  [LLD §3.1](../design/LLD.md#31-privileged-scope-m3), [TDD §3.1](../design/TDD.md#31-configuration),
  [ADR-0017](0017-approved-privileged-scope-bypass.md) (amended), [ADR-0018](0018-claude-bypass-omits-restricted.md),
  ROADMAP R-9, R-34, R-39, T3.18

## Context

[ADR-0017](0017-approved-privileged-scope-bypass.md) requires the operator to approve the first `privileged` run of a
meta-session through the operator CLI (`approve <run_id>`) before it dispatches; no MCP tool, timer, configuration
value or client ceiling approves (its decision items 5 and 6). Owner decision 17 already made that approval durable for
the meta-session.

Owner decision 22 says that in approved bypass runs only the per-scope approval is lifted: Git-write denial and worktree
isolation stay. Owner decision 18 says the loose modes are for zemdregon's own workloads and the restrictive profiles exist
for other people who deploy Switchboard, so loosening must be explicit and the defaults stay restrictive. Lifting the
approval for everyone would change the default for other deployers; lifting it per request would let an orchestrator
lift it for itself. A setting the operator controls, per MCP client, keeps both decisions.

## Decision

1. Each `mcp_clients[]` entry may set `privileged_approval`, a closed enum `"required" | "not_required"`, default
   `"required"`. Unknown values fail configuration validation with the JSON path and the allowed values.
   `"not_required"` is refused unless that client's `max_trust_profile` is `privileged` (Proposed: fail closed rather
   than accept a setting that does nothing).
2. `"required"` is the behaviour of ADR-0017 unchanged: a `privileged` `delegate_task` enters AWAITING_APPROVAL with a
   `PENDING` approval row (FRD T2) and waits for `approve` or `deny`.
3. With `"not_required"`, a `privileged` `delegate_task` from that client still passes every check it passes today:
   the client ceiling (V5, BR-13), the `privileged_scope` validation (V1, V13), canonicalisation and the `v: 2` scope
   hash. It is then admitted by FRD T1 to QUEUED; in the same admission transaction the controller writes the approval
   row (`scope_json`, `scope_hash`, `requested_at`) and decides it `APPROVED` with
   `decided_by = "client_policy:<client_id>"`, appends the T1 `state_transition` event (naming the approval and
   `approval: "client_policy"`) and an `approval_decided` event with `reason: "client_policy"`.
4. Such a row is an ordinary `APPROVED` row everywhere else: it is durable for the meta-session (owner decision 17),
   so `continue_task` continuations run under it (FRD C7) with the scope as is; the dispatch-time **Bypass** check
   ([LLD §3.1](../design/LLD.md#31-privileged-scope-m3)) applies all its hash and ownership checks to it, so a
   tampered snapshot or row still fails `PERMISSION_BLOCKED` before spawn; `bypassApproved` is true only when the
   scope sets `bypass: true`.
5. `approve` and `deny` keep working for runs of `"required"` clients. A run admitted under client policy never waits
   in AWAITING_APPROVAL, so `approve` and `deny` refuse it, naming the client policy.
6. Nothing else is relaxed: FR-GIT-01 Git-write denial and FR-WS-05 worktree isolation apply to every `privileged`
   run, and a bypass flag still passes the argv audit only under ADR-0017's conditions (T3.17). An orchestrator cannot
   set or see the setting through MCP; only the operator's configuration file can.
7. `doctor` lists every client with `"not_required"` as a `[warn]` line.

This amends ADR-0017's approval requirement (decision item 5's "`APPROVED` by the operator CLI" and item 6's "no ...
configuration value ... approves") for clients configured `"not_required"`, and only for them. ADR-0017's status line
is updated accordingly; its decision text is not edited.

## Alternatives considered

- **A global switch.** Rejected: every client, including a low-trust orchestrator raised to `privileged` for a single
  task, would lose the approval; per client keeps the decision next to the ceiling it qualifies.
- **A request field (`privileged_scope.approval: "skip"`).** Rejected: the orchestrator would grant itself the lift;
  FR-MCP-06 forbids privileged authority through MCP alone.
- **No approval row for such runs.** Rejected: the row is the audit record (who decided, when, which scope and hash)
  and what the dispatch-time hash checks and continuations rely on; writing it keeps one code path.
- **A new `approval.status` value such as `AUTO`.** Rejected: needs a forward migration of the `CHECK` constraint, and
  every reader of `APPROVED` would need to learn it; `decided_by` already says who decided.
- **Lifting the approval only for `bypass: true` scopes.** Not adopted: decision 22 concerns the per-scope approval,
  and a narrower scope needing more ceremony than a wider one would invert the intent.

## Consequences

- A `"not_required"` client can start and continue `privileged` runs, including bypass runs, with no operator review
  of the scope (R-39). The trust in that client rests on the operator's control of its launch configuration (R-9).
- The audit trail is unchanged in kind: the approval row, its `decided_by`, the run events and `runs show` show which
  runs ran under client policy.
- FR-POL-09, FR-POL-03, FR-MCP-06, BR-13, BR-14, WF-7 and the FRD T1 guard carry dated notes; IDs are unchanged.
- The default configuration behaves exactly as before.

## Revisit when

zemdregon revises decision 22 or chooses another realisation, Q-30 (revocation) is decided, MCP clients gain authentication
stronger than the stdio launch binding, or R-38 shows Git-write denial does not hold under a provider's bypass.
