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
 *    approved scope's `shell` dimension; a scope or snapshot that claims `bypass` without a controller-verified
 *    approval is refused (`bypass_run`), because a bypass run skips the provider's permission prompts, so nothing the
 *    profile names is enforced;
 * 3. an adapter whose manifest declares credential confinement: no manifest has such a field (the manifest schema in
 *    `src/adapters/manifest/schema.ts` defines none), so this path is never taken (Assumption, recorded in ADR-0028).
 *
 * Bypass exemption (owner decision 37, "BR-31. Don't block git operations on bypass mode"; Delegated narrow reading,
 * ADR-0028 "Amended before merge"): a run whose bypass the CONTROLLER has verified (`approvedBypass`, computed by the
 * caller from `bypassApprovedFor`, the same evaluation the argv audit gate relies on: an APPROVED, hash-matching
 * approval row whose scope sets `bypass`) is `ok` with the recorded reason `bypass_exempt`, whatever its shell
 * dimension says. Policy `branch` and a host environment are still required first. The flag is a controller-held
 * fact passed in by code; nothing the agent or an MCP client can set reaches it, and a snapshot that merely says
 * `bypass` is still refused. The exemption widens what the AGENT may reach (it may read the operator's push
 * credentials if its shell can), never what the controller pushes: the push itself is unchanged.
 *
 * Signing (T9.10, FR-GIT-10, FRD BR-33): {@link evaluateSigningReach} applies this same rule, exemption included, to a
 * context with `sign: true`, without the push-policy precondition; a refusal fails the commit with `SIGNING_FAILED`.
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

/** The reason recorded when a controller-verified approved bypass run is exempt from BR-31 (owner decision 37). */
export const BYPASS_EXEMPT = "bypass_exempt";

export type CredentialReach =
  | { readonly ok: true; readonly reason?: typeof BYPASS_EXEMPT }
  | { readonly ok: false; readonly reason: CredentialReachReason };

/** Controller-held facts the rule may use beyond the frozen snapshot. */
export interface CredentialReachFacts {
  /** True only when the controller verified an approved bypass for this run (`bypassApprovedFor`). Default false. */
  readonly approvedBypass?: boolean;
}

/** Parse `run.policy_snapshot_json` and apply {@link evaluateCredentialReach}; an unreadable snapshot fails closed. */
export function credentialReachFromJson(policySnapshotJson: string, facts?: CredentialReachFacts): CredentialReach {
  let snap: unknown;
  try {
    snap = JSON.parse(policySnapshotJson);
  } catch {
    return { ok: false, reason: "snapshot_unreadable" };
  }
  if (typeof snap !== "object" || snap === null) return { ok: false, reason: "snapshot_unreadable" };
  return evaluateCredentialReach(snap as PolicySnapshot, facts);
}

/** BR-31 for the agent `push` tool, from the run's frozen snapshot. Every unknown value refuses. */
export function evaluateCredentialReach(snap: PolicySnapshot, facts?: CredentialReachFacts): CredentialReach {
  if (snap.project === undefined) return { ok: false, reason: "no_project" };
  if (snap.project.push?.policy !== "branch") return { ok: false, reason: "policy_not_branch" };
  return agentReach(snap, facts);
}

/**
 * T9.10 (FR-GIT-10, FRD BR-33: "Signing is refused where BR-31 would withhold `push`"): the SAME rule as
 * {@link evaluateCredentialReach}, including the owner decision 37 exemption for a controller-verified approved bypass
 * run, minus the push-policy precondition, which concerns `push` only (a context may sign with push policy `none`).
 * Wherever the push policy is `branch` both functions return the same verdict (tested). Delegated reading, LLD §12.3.1.
 */
export function evaluateSigningReach(snap: PolicySnapshot, facts?: CredentialReachFacts): CredentialReach {
  if (snap.project === undefined) return { ok: false, reason: "no_project" };
  return agentReach(snap, facts);
}

/** {@link evaluateSigningReach} from `run.policy_snapshot_json`; an unreadable snapshot fails closed. */
export function signingReachFromJson(policySnapshotJson: string, facts?: CredentialReachFacts): CredentialReach {
  let snap: unknown;
  try {
    snap = JSON.parse(policySnapshotJson);
  } catch {
    return { ok: false, reason: "snapshot_unreadable" };
  }
  if (typeof snap !== "object" || snap === null) return { ok: false, reason: "snapshot_unreadable" };
  return evaluateSigningReach(snap as PolicySnapshot, facts);
}

/** The environment, bypass and shell part of BR-31, shared by push and signing. `snap.project` is present. */
function agentReach(snap: PolicySnapshot, facts?: CredentialReachFacts): CredentialReach {
  if (snap.project?.environment_kind !== "host") return { ok: false, reason: "container_not_available" };
  if (facts?.approvedBypass === true) return { ok: true, reason: BYPASS_EXEMPT };
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
