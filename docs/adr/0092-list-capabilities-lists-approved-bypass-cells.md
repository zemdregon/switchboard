# ADR-0092: `list_capabilities` lists `privileged` for a provider whose only privileged cell is the approved bypass cell

- Status: Accepted (built 2026-10-21). Amends the [LLD §3.1](../design/LLD.md#31-privileged-scope-m3) "Listing" rule
  (Proposed, 2026-10-13), which compiled only non-bypass representative scopes.
- Date: 2026-10-21
- Decided by: **Delegated** (agent, 2026-10-21), not owner-approved, under the owner ruling of 2026-10-21 (relayed by
  the orchestrator) that the operator's prod Switchboard always runs bypass on every enabled provider
  ([ADR-0091](0091-configured-default-trust-profile-and-unattended-http-privileged.md)). The ruling sets the outcome
  (prod runs bypass); how the listing reports it is this agent's choice.
- Related: FR-MCP-01, FR-POL-03, FR-POL-09, FR-RTE-01, [LLD §3](../design/LLD.md#3-mcp-tool-contracts),
  [LLD §3.1](../design/LLD.md#31-privileged-scope-m3), [ADR-0017](0017-approved-privileged-scope-bypass.md),
  [ADR-0077](0077-bypass-unconfined-and-every-provider-bypass-cell.md),
  [ADR-0091](0091-configured-default-trust-profile-and-unattended-http-privileged.md), ROADMAP T3.29.

## Context

`list_capabilities` reports each provider's `supported_profiles`: the profiles its adapter compiles on this host
(T3.7). A request's privileged scope is not known at listing time, so `privileged` was listed when the adapter
compiled any scope of a small representative set (`REPRESENTATIVE_PRIVILEGED_SCOPES` in `src/mcp/server.ts`). All of
those scopes have `bypass: false` and are compiled without `bypassApproved`.

Grok Build, Cursor, OpenCode, Kimi Code and Antigravity compile only an approved bypass scope (ADR-0077): every lower
tier, and a privileged scope without bypass, is `Ineligible` by design. They also compile it only with
`repository_config: "enabled"`. So on the production host, where each of them has an approved bypass cell and passes
live bypass runs, `list_capabilities` reported `supported_profiles: []` for Grok Build, Cursor, OpenCode and Kimi Code.
An orchestrator reading the listing would conclude they cannot run at all. Claude Code and Codex were listed because
they also compile non-bypass privileged scopes.

## Decision

1. After the non-bypass representative scopes, the listing also compiles a small set of approved bypass cells
   (`REPRESENTATIVE_BYPASS_SCOPES`): `worktree` files, shell `broad`, network `on`, `bypass: true`, once with
   repository configuration `enabled` and once with `disabled`. Each is compiled as
   `{ ...privilegedEligibilityProfile(scope), bypassApproved: true }`, so every adapter's approval check (the profile's
   or the request's `bypassApproved`; Claude Code's `bypassApprovedFor`) reaches its bypass cell. A provider whose
   adapter compiles any of them lists `privileged`.
2. The simulated approval is listing-only. Listing never dispatches; nothing it compiles is run. The dispatch path is
   unchanged: a run's `bypassApproved` still comes only from its approval row (`evaluateBypass` in
   `src/lifecycle/approval.ts`), the request's own scope is still compiled at dispatch, and the argv audit (T3.17) is
   untouched.
3. Each provider item gains `privileged_bypass_only` (boolean), present exactly when `privileged` is listed: `true`
   when only a bypass cell compiled, `false` when a non-bypass representative scope compiled. The output schema of
   `list_capabilities` (`src/mcp/schemas.ts`) declares it.
4. The lower tiers are listed exactly as before; a disabled or unprobed provider still lists nothing.

## Alternatives considered

- **Leave the listing as it was and document the gap.** Rejected: the listing would keep telling the orchestrator that
  five providers with working bypass cells support nothing.
- **List `privileged` for a bypass-only provider only when the calling client has an approval or `not_required`.**
  Rejected for now: `supported_profiles` is a property of the adapter on this host (T3.7), not of a client's approval
  state; a per-client answer would make the listing an approval oracle and change its meaning for every provider.
- **Compile the configured `default_privileged_scope` instead of a fixed set.** Rejected: the listing would then depend
  on one deployment's configuration and say nothing on a deployment without a default; a fixed set keeps it
  comparable across hosts. The configuration mismatch it would catch is noted below instead.

## Consequences

- `privileged` in `supported_profiles` now means "this provider compiles at least one privileged scope here, possibly
  only the approved bypass cell". `privileged_bypass_only: true` says the latter: such a provider runs a privileged
  request only when the scope sets `bypass` and the run is approved (or its client is `not_required`, ADR-0019).
- A request's scope is still compiled at dispatch; an `Ineligible` there ends the run with its BR-3 code, as before.
- The five bypass-only providers need `repository_config: "enabled"` in the scope. A deployment whose
  `default_privileged_scope` (ADR-0091) or request scope sets `disabled` cannot run them, although the listing shows
  `privileged`; that is an operator configuration matter, not a listing error.
- Claude Code and Codex keep their full lists, now with `privileged_bypass_only: false`.

## Revisit when

- An adapter gains a non-bypass privileged cell (its flag turns `false` without a change here), or a bypass cell needs
  a shape outside the representative set.
- zemdregon wants the listing to reflect the calling client's approval state or the configured default scope.
