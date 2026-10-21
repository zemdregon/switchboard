# ADR-0017: Bypass flags only for an approved privileged scope that sets bypass

- Status: Accepted (amended before merge, 2026-10-13); approval requirement amended by
  [ADR-0019](0019-per-client-privileged-approval.md) for MCP clients configured `privileged_approval: "not_required"`
  (2026-10-13); items 5 and 6 (item 6's "No MCP tool approves"; item 5's "`APPROVED` by the operator CLI", since a
  proxied approval satisfies it) are superseded in part by
  [ADR-0047](0047-approval-proxy-over-mcp.md) for clients the operator marks `approval_proxy` (Proposed, 2026-10-15);
  superseded in part by [ADR-0077](0077-bypass-unconfined-and-every-provider-bypass-cell.md) (2026-10-20, owner
  ruling): an approved bypass run may read and write outside its worktree ("Path globs for `files`" below no longer
  implies confinement in bypass)
- Date: 2026-10-12
- Numbering: drafted as ADR-0016 on the M3 plan branch; renumbered ADR-0017 on 2026-10-13 when main, merged first,
  had already used 0016 for [the inner agent](0016-inner-agent.md). Owner decision 17 was numbered 14 on that branch
  (main used 14), and the ROADMAP IDs Q-28 to Q-31 and R-34, R-35 were Q-23 to Q-26 and R-27, R-28.
- Decided by: Delegated (agent, 2026-10-12), recording zemdregon's decision of 2026-10-12 (owner decision 13 in
  [ROADMAP §4.2](../ROADMAP.md#42-owner-decisions)): provider permission-bypass flags may be emitted only when the
  operator-approved `privileged` scope explicitly sets bypass and the approval covers that scope. The mechanism in this
  ADR (the `privileged_scope` shape, the scope hash and the validation rules) is Delegated and not owner-approved.
  Amended by zemdregon's decision of 2026-10-13 (owner decision 17, "initial privileged approval lasts forever"; the
  meta-session reading is the orchestrator's, recorded for zemdregon to correct) and by a Delegated decision of the same
  day that makes the scope machine-readable (zemdregon left ROADMAP Q-28 to the agent).
- Related: FR-POL-03, FR-POL-09, FR-MCP-03, FR-MCP-06, FR-OPS-02, [FRD BR-13, BR-14](../requirements/FRD.md#3-business-rules),
  [FRD WF-7](../requirements/FRD.md#wf-7-privileged-approval), [LLD §3](../design/LLD.md#3-mcp-tool-contracts),
  [ADR-0004](0004-trust-profiles-no-bypass-flags.md), R-26, R-34, Q-30, T3.16, T3.17

> **Amended before merge (2026-10-13).** This ADR was not yet merged, so it is amended in place rather than
> superseded. Two changes: (1) owner decision 17 replaces "ties approval to exactly one run" (the first draft's
> per-run hash and FRD WF-7's postcondition) with a binding to one MCP client, one meta-session and one canonical
> scope: the approval of a meta-session's first `privileged` run is durable and covers its later runs with the same
> scope, including `continue_task` continuations; (2) the scope's dimensions become machine-readable (closed enums
> plus argv-exact command and host lists) instead of free text, and adapters compile the privileged profile from them
> (Delegated, answering ROADMAP Q-28). Decision items 1 to 7 and the consequences below reflect both; the free-text
> design and the per-run hash (`v: 1`) were never implemented.

## Context

[AGENTS.md](../../AGENTS.md#working-rules) forbids code, tests and examples that invoke a provider CLI with a bypass
flag (`--dangerously-skip-permissions`, `--yolo`, `--force`, `--always-approve`, `--approve-mcps`, `--full-auto`) unless
a design document explicitly calls for it. [ADR-0004](0004-trust-profiles-no-bypass-flags.md) decided that there are no
*automatic* bypass flags: they are emitted only under `privileged` with recorded operator approval. FR-POL-03 says the
same, and FR-POL-09 required per-run approval through the operator CLI with the timestamp and scope recorded (amended
2026-10-13 by owner decision 17 to the meta-session binding in Decision item 4).

None of these said what the approved scope contains, whether approving a `privileged` run by itself approves a bypass
flag, or how the controller proves at dispatch time that the scope it is about to act on is the one the operator read.
The M2 code emits no bypass flag in any profile, and the argv audit (`src/adapters/audit.ts`) refuses every one. Owner
decision 13 settles the policy: a bypass flag is allowed only when the operator-approved scope explicitly sets bypass and
the approval row covers that scope. That changes an external interface (`delegate_task` gains an input), so this ADR
and an [LLD §3](../design/LLD.md#3-mcp-tool-contracts) contract are required before any code emits a bypass flag.

Note (2026-10-13): "The M2 code emits no bypass flag" described the code when this ADR was written. Since the
milestone 3 work, an approved `privileged` scope that sets `bypass` does emit the provider's bypass flag, as the
decision below allows (see [ROADMAP §6.5](../ROADMAP.md#65-m3-isolation-tasks)); the argv audit still refuses every
bypass flag otherwise. The decision text is unchanged.

## Decision

1. `delegate_task` gains an optional `privileged_scope` object ([LLD §3.1](../design/LLD.md#31-privileged-scope-m3)).
   It is machine-readable: `files` (`access`: `read-only` or `worktree`), `shell` (`mode`: `none`, `allowlist` with
   argv-exact entries, or `broad`), `network` (`mode`: `off`, `allowlist` with host names, or `on`) and
   `repository_config` (`mode`: `disabled`, `approved` or `enabled`), all required, plus a `bypass` boolean that
   defaults to `false`; unknown keys are refused. It is required when `trust_profile` is `privileged` and refused
   (`INVALID_REQUEST`) for any other profile; a client whose ceiling is below `privileged` gets `PERMISSION_BLOCKED`
   first ([FRD V5, V13](../requirements/FRD.md#71-delegate_task), BR-13).
2. Adapters compile a `privileged` run from the approved scope. A dimension a provider cannot express makes that
   provider `Ineligible` for the run with a reason; it is never dropped or widened silently. The FR-GIT-01 Git write
   deny rules apply whatever the scope says.
3. At admission of a meta-session's first `privileged` run the controller stores the canonical scope in
   `approval.scope_json` and a SHA-256 `scope_hash` over the MCP client ID, the meta-session ID and the canonical scope,
   in the same transaction that creates the run in AWAITING_APPROVAL. The run's policy snapshot records the same hash
   and the approval's ID.
4. Once the operator approves that run, the approval is durable (owner decision 17): it covers every later run of the
   same meta-session, from the same client, with the same scope. A `continue_task` continuation that resolves to
   `privileged` takes the approved scope as is (it has no scope input, so it cannot widen or change it) and needs no
   new approval. A different scope, meta-session or client needs a new approval; a new `delegate_task` always starts
   a new meta-session and so always asks.
5. A bypass flag may be emitted only when all of these hold: the run's resolved profile is `privileged`; the approval
   that covers it is `APPROVED` by the operator CLI; the row's `scope_hash` equals the hash in the run's policy
   snapshot and the hash recomputed from the run's client, meta-session and scope; and the approved scope sets
   `bypass: true`. The resolved profile carries this as `bypassApproved`, and the final argv audit checks it again
   before spawn (T3.17).
6. Approval is never automatic, never expires and is never revoked automatically. No MCP tool approves; no timer,
   configuration value or client ceiling approves; the controller never writes `EXPIRED`. A run waits in
   AWAITING_APPROVAL until the operator approves, denies or someone cancels it. Whether the operator can revoke an
   approval by hand is ROADMAP Q-30.
7. No other profile can ever carry a bypass flag. A loosening `profiles.<name>` override (owner decision 12) cannot add
   one, and `privileged` without `bypass: true` compiles without one.

This complements and narrows ADR-0004; it does not supersede it. ADR-0004 already limits bypass flags to `privileged`
with recorded approval. This ADR adds the further conditions (an explicit `bypass` in the approved scope and a matching
scope hash) and says how they are checked. ADR-0004's decision text is not contradicted, so its status is unchanged.

## Alternatives considered

- **Approving a `privileged` run approves bypass implicitly.** Rejected: the operator would grant the provider's widest
  mode without that being named in what they reviewed, and decision 13 requires an explicit setting.
- **Never emit bypass flags, even under `privileged`.** Rejected by decision 13 (the less restrictive option was
  chosen); it would also leave `privileged` with no more power than `trusted-development` on providers whose only
  non-interactive approval path is a bypass flag.
- **Scope stored without a hash, compared field by field at dispatch.** Rejected: a hash over the canonical form gives
  one comparison that also detects a changed request, and it is what `runs show` can display for the operator to match.
- **Approval with an expiry.** Rejected: WF-7 has no expiry, and an expiring approval invites re-approval without
  re-reading.
- **One approval per run** (this ADR's first draft). Replaced by owner decision 17: every continuation of a privileged
  session would wait for the operator again. The cost is R-34 (no fresh look at later runs).
- **Approval bound to the scope alone, across meta-sessions.** Rejected: one approval would then cover any future task
  that happens to request the same scope, which is far wider than decision 17's "initial approval" for a session.
- **Free-text allow descriptions** (this ADR's first draft). Replaced (Delegated, Q-28): free text cannot be compiled
  by adapters, cannot be validated or compared, and makes the scope hash cover words rather than behaviour. The cost
  is that some providers cannot express some dimensions; those become `Ineligible`, never downgraded.
- **Path globs for `files`.** Not adopted: a `privileged` run still works in its worktree (FR-WS-01), so the useful
  choices are read-only or worktree writes, matching the profile fields.

## Consequences

- The argv audit changes (T3.17): `BYPASS_FLAGS` stays the single list, and a bypass flag passes only when the run's
  resolved profile is `privileged`, `bypassApproved` is true and the approved scope sets `bypass`. Every other case still
  fails before spawn. No code that emits a bypass flag merges before T3.16 (this ADR and LLD §3) and T3.17.
- A bypass flag disables the provider's native approvals and possibly other native controls for that run, including Git
  write deny rules if the provider's bypass overrides them (R-26). Where a provider's bypass overrides a compiled scope
  control, the scope is a statement of what the operator accepted, not something Switchboard enforces inside the
  provider; the live leg (T3.9) checks this.
- Every bypass run is recorded: the approval row (scope, hash, requested, decided, decided by), a `run_event` for the
  approval decision and the compiled invocation's `policyFlags` in the run's events, so the audit trail shows which flag
  was emitted under which approval.
- `get_run` shows the approval status and when it was requested, never the scope content; the operator reviews the full
  scope and its hash with `runs show` before `approve`, and `runs show` lists every run an approval has covered.
- A durable approval removes per-run oversight (R-34): a later continuation runs with the same bypass and privileges
  without a fresh look. Mitigations are the client, meta-session and scope binding, the record of every covered run,
  the per-client ceiling re-checked on every request, and cancellation; a revoke command is ROADMAP Q-30.
- No schema change: `approval.run_id` names the requesting run, from which the meta-session and client are read.
  `PrivilegedScope` in `src/policy/types.ts` is narrowed to the structured type in T3.3; T3.5 and T3.6 compile it.
- [AGENTS.md](../../AGENTS.md#working-rules)'s working rule still holds: this ADR and LLD §3 are the design documents
  that call for a bypass flag, and only in the case above.

## Revisit when

A provider gains a non-interactive approval mode that is narrower than its bypass flag (prefer it), live checks show a
provider's bypass overrides controls the approved scope relies on, zemdregon corrects the reading of decision 17, or zemdregon
decides Q-30 (revocation).
