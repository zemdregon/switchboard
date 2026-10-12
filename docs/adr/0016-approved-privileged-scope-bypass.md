# ADR-0016: Bypass flags only for an approved privileged scope that sets bypass

- Status: Accepted
- Date: 2026-10-12
- Decided by: Delegated (agent, 2026-10-12), recording Ender's decision of 2026-10-12 (owner decision 13 in
  [ROADMAP §4.2](../ROADMAP.md#42-owner-decisions)): provider permission-bypass flags may be emitted only when the
  operator-approved `privileged` scope explicitly sets bypass and the approval covers that scope. The mechanism in this
  ADR (the `privileged_scope` shape, the scope hash and the validation rules) is Delegated and not owner-approved.
- Related: FR-POL-03, FR-POL-09, FR-MCP-03, FR-MCP-06, FR-OPS-02, [FRD BR-13, BR-14](../requirements/FRD.md#3-business-rules),
  [FRD WF-7](../requirements/FRD.md#wf-7-privileged-approval), [LLD §3](../design/LLD.md#3-mcp-tool-contracts),
  [ADR-0004](0004-trust-profiles-no-bypass-flags.md), R-26, T3.16, T3.17

## Context

[AGENTS.md](../../AGENTS.md#working-rules) forbids code, tests and examples that invoke a provider CLI with a bypass
flag (`--dangerously-skip-permissions`, `--yolo`, `--force`, `--always-approve`, `--approve-mcps`, `--full-auto`) unless
a design document explicitly calls for it. [ADR-0004](0004-trust-profiles-no-bypass-flags.md) decided that there are no
*automatic* bypass flags: they are emitted only under `privileged` with recorded operator approval. FR-POL-03 says the
same, and FR-POL-09 requires per-run approval through the operator CLI with the timestamp and scope recorded.

None of these said what the approved scope contains, whether approving a `privileged` run by itself approves a bypass
flag, or how the controller proves at dispatch time that the scope it is about to act on is the one the operator read.
The M2 code emits no bypass flag in any profile, and the argv audit (`src/adapters/audit.ts`) refuses every one. Owner
decision 13 settles the policy: a bypass flag is allowed only when the operator-approved scope explicitly sets bypass and
the approval row covers that scope. That changes an external interface (`delegate_task` gains an input), so this ADR
and an [LLD §3](../design/LLD.md#3-mcp-tool-contracts) contract are required before any code emits a bypass flag.

## Decision

1. `delegate_task` gains an optional `privileged_scope` object ([LLD §3](../design/LLD.md#3-mcp-tool-contracts)). It
   states, as explicit allow descriptions, the file access, shell, network and repository configuration the run asks
   for, and carries a `bypass` boolean that defaults to `false`. It is required when `trust_profile` is `privileged`
   and refused (`INVALID_REQUEST`) for any other profile; a client whose ceiling is below `privileged` gets
   `PERMISSION_BLOCKED` first ([FRD V5, V13](../requirements/FRD.md#71-delegate_task), BR-13).
2. At admission the controller stores the canonical scope in `approval.scope_json` and a SHA-256 `scope_hash` that
   covers the canonical scope, the run ID and the run's `request_hash`, in the same transaction that creates the run in
   AWAITING_APPROVAL. The run's policy snapshot records the same hash.
3. A bypass flag may be emitted only when all of these hold: the run's resolved profile is `privileged`; its `approval`
   row is `APPROVED` by the operator CLI; the row's `scope_hash` equals the hash in the run's policy snapshot and the
   hash recomputed from the stored scope and request; and the approved scope sets `bypass: true`. The resolved profile
   carries this as `bypassApproved`, and the final argv audit checks it again before spawn (T3.17).
4. Approval is never automatic and never expires. No MCP tool approves; no timer, configuration value or client
   ceiling approves; the controller never writes `EXPIRED`. A run waits in AWAITING_APPROVAL until the operator approves,
   denies or someone cancels it.
5. No other profile can ever carry a bypass flag. A loosening `profiles.<name>` override (owner decision 12) cannot add
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
- **Machine-readable scope (path globs, argv allowlists, host lists) compiled into native rules.** Deferred, not
  rejected: the providers' rule languages differ and are partly unverified. Free-text allow descriptions are what the
  operator approves for now; ROADMAP Q-23 asks whether to make them machine-readable.

## Consequences

- The argv audit changes (T3.17): `BYPASS_FLAGS` stays the single list, and a bypass flag passes only when the run's
  resolved profile is `privileged`, `bypassApproved` is true and the approved scope sets `bypass`. Every other case still
  fails before spawn. No code that emits a bypass flag merges before T3.16 (this ADR and LLD §3) and T3.17.
- A bypass flag disables the provider's native approvals and possibly other native controls for that run, including Git
  write deny rules if the provider's bypass overrides them (R-26). The approved scope's descriptions are then a
  statement of intent the operator accepted, not something Switchboard enforces inside the provider.
- Every bypass run is recorded: the approval row (scope, hash, requested, decided, decided by), a `run_event` for the
  approval decision and the compiled invocation's `policyFlags` in the run's events, so the audit trail shows which flag
  was emitted under which approval.
- `get_run` shows the approval status and when it was requested, never the scope content; the operator reviews the full
  scope and its hash with `runs show` before `approve`.
- [AGENTS.md](../../AGENTS.md#working-rules)'s working rule still holds: this ADR and LLD §3 are the design documents
  that call for a bypass flag, and only in the case above.

## Revisit when

A provider gains a non-interactive approval mode that is narrower than its bypass flag (prefer it), live checks show a
provider's bypass overrides controls the approved scope relies on, or Ender decides Q-23 (machine-readable scope).
