/**
 * Credential-reach rule for the injected `push` tool (FRD BR-31, FR-GIT-06, FR-POL-06; LLD §12.6 step 1; ADR-0028;
 * T9.6). A context with push policy `branch` is offered `push` for a run only if the agent cannot run commands that
 * could read the push credentials. BR-31 names three ways to satisfy that:
 *
 * 1. a `container` environment with no credential store mounted: M10, not built, so a `container` snapshot is
 *    refused here (`container_not_available`), fail closed;
 * 2. a profile without arbitrary shell: shell `none`, or `allowlist` with an EMPTY allowlist. A non-empty allowlist
 *    is refused (`shell_allowlist`): the controller cannot prove that an allowlisted program (an editor, an
 *    interpreter, `cat`) cannot read `~/.ssh` or a credential helper's store, so it does not count as "without
 *    arbitrary shell" (Delegated, ADR-0028). `broad` is refused (`shell_broad`). A `privileged` run is judged by its
 *    approved scope's `shell` dimension; a scope or approval that sets `bypass` is always refused (`bypass_run`),
 *    because a bypass run skips the provider's permission prompts, so nothing the profile names is enforced;
 * 3. an adapter whose manifest declares credential confinement: no manifest has such a field (the manifest schema in
 *    `src/adapters/manifest/schema.ts` defines none), so this path is never taken (Assumption, recorded in ADR-0028).
 *
 * Pure: it reads only the frozen policy snapshot of the run. The operator command is not subject to this rule (the
 * operator is not the agent); it still goes through the policy, ref and never-force rules in `push.ts`.
 *
 * Known gap (ROADMAP R-48): a profile without shell can still give the agent the provider's own file-read tool, and
 * FR-POL-06/BR-31 speak of "commands", not file reads. Whether a provider's read tool can reach `~/.ssh` depends on
 * the provider's own path scoping, which is unverified.
 */
import type { PolicySnapshot } from "../policy/types.js";

export type CredentialReachReason =
  | "snapshot_unreadable"
  | "no_project"
  | "policy_not_branch"
  | "container_not_available"
  | "bypass_run"
  | "shell_broad"
  | "shell_allowlist"
  | "shell_unknown";

export type CredentialReach = { readonly ok: true } | { readonly ok: false; readonly reason: CredentialReachReason };

/** Parse `run.policy_snapshot_json` and apply {@link evaluateCredentialReach}; an unreadable snapshot fails closed. */
export function credentialReachFromJson(policySnapshotJson: string): CredentialReach {
  let snap: unknown;
  try {
    snap = JSON.parse(policySnapshotJson);
  } catch {
    return { ok: false, reason: "snapshot_unreadable" };
  }
  if (typeof snap !== "object" || snap === null) return { ok: false, reason: "snapshot_unreadable" };
  return evaluateCredentialReach(snap as PolicySnapshot);
}

/** BR-31 for the agent `push` tool, from the run's frozen snapshot. Every unknown value refuses. */
export function evaluateCredentialReach(snap: PolicySnapshot): CredentialReach {
  const project = snap.project;
  if (project === undefined) return { ok: false, reason: "no_project" };
  if (project.push?.policy !== "branch") return { ok: false, reason: "policy_not_branch" };
  if (project.environment_kind !== "host") return { ok: false, reason: "container_not_available" };
  if (snap.bypassApproved === true) return { ok: false, reason: "bypass_run" };
  if (snap.shell === "scoped") {
    const scope = snap.privilegedScope?.scope;
    if (scope === undefined) return { ok: false, reason: "shell_unknown" };
    if (scope.bypass === true) return { ok: false, reason: "bypass_run" };
    if (scope.shell.mode === "none") return { ok: true };
    if (scope.shell.mode === "allowlist") {
      return scope.shell.allowlist.length === 0 ? { ok: true } : { ok: false, reason: "shell_allowlist" };
    }
    return { ok: false, reason: scope.shell.mode === "broad" ? "shell_broad" : "shell_unknown" };
  }
  if (snap.shell === "none") return { ok: true };
  if (snap.shell === "allowlist") {
    const list = snap.shellAllowlist;
    if (list === undefined || (Array.isArray(list) && list.length === 0)) return { ok: true };
    return { ok: false, reason: "shell_allowlist" };
  }
  if (snap.shell === "broad") return { ok: false, reason: "shell_broad" };
  return { ok: false, reason: "shell_unknown" };
}
