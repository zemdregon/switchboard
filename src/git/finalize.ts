import type { Ledger } from "../ledger/index.js";
import type { ProjectSnapshot } from "../policy/index.js";
import { CommitError, type CommitErrorCode, type GitPublisher, MAX_PATHS, type PathRefusalReason } from "./commit.js";
import type { CredentialReach } from "./credential-reach.js";
import { GIT_POLICY_VIOLATION_EVENT } from "./ref-guard.js";

/**
 * Finalize-only mode (T9.7; FR-GIT-09, FRD BR-30, BR-26, BR-28; owner decision 36, ROADMAP Q-43; LLD §12.3 "As built
 * (T9.7)"). For a run whose adapter cannot receive the injected tool channel (`commitChannel` other than `injected`) and
 * whose frozen project snapshot opted in (`finalize_commit`), the controller makes ONE commit at FINALIZING, after the
 * T9.5 ref check and the evidence checkpoint, through the same {@link GitPublisher} as the `commit` tool: the run's
 * changed paths, the context identity, and the agent's structured final summary as the message, which passes the
 * FR-GIT-04 sanitiser. Provenance is the T9.3 intent/outcome sequence with `origin = 'finalize_only'`.
 *
 * Delegated choices (fail closed; none changes a requirement):
 * - Only a run that is about to end SUCCEEDED is committed (BR-30 speaks of "the run's worktree changes"; a failed or
 *   cancelled run's head is rolled back, FRD §4.4, so its changes are evidence only).
 * - Any `git_policy_violation` in any run of the meta-session prevents the commit (BR-27: offending content is never
 *   published; the same session-wide rule as the push refusal of ROADMAP Q-44).
 * - The controller never writes a stand-in message: no usable summary, or one that is empty after sanitising, means no
 *   commit (`no_message`). A summary over {@link FINALIZE_MESSAGE_MAX} characters (the `commit` tool's limit) is not
 *   truncated, because a cut could split an identifier the sanitiser would otherwise remove (`message_too_long`).
 * - More than {@link MAX_PATHS} changed paths (the `commit` tool's limit) is `too_many_paths`; a refused path refuses the
 *   whole commit (T9.3 rules), recorded as counts per reason, never the path names.
 * - Exception, owner decision 44 (ROADMAP Q-45, "Loosen restrictions always for bypass"): for an approved bypass run
 *   ({@link FinalizeCommitRequest.approvedBypass}) neither size limit skips. All changed paths go in one commit, and an
 *   over-long summary is sanitised in full first and only then truncated (by the publisher, with a one-line note), so a
 *   cut cannot split anything the sanitiser would have removed. Every other skip and refusal is unchanged.
 * - Nothing here changes the run's outcome; the result is recorded as one {@link GIT_FINALIZE_COMMIT_EVENT} event.
 */

/** `run_event` type recording the finalize-only result: committed, skipped (with a reason) or failed (with a code). */
export const GIT_FINALIZE_COMMIT_EVENT = "git_finalize_commit";

/** Same bound as the `commit` tool's `message` (LLD §12.1). */
export const FINALIZE_MESSAGE_MAX = 8192;

export type FinalizeSkipReason =
  | "run_not_succeeded"
  | "environment_not_host"
  | "context_not_writable"
  | "no_identity"
  | "git_policy_violation"
  | "service_unavailable"
  | "no_changes"
  | "too_many_paths"
  | "no_message"
  | "message_too_long"
  | "nothing_to_commit";

export type FinalizeCommitOutcome =
  | {
      readonly outcome: "committed";
      readonly commitSha: string;
      readonly provenanceId: string;
      readonly filesChanged: number;
      /** ADR-0087 item 4: submodule commits made with it and submodule paths not committed (present when attached). */
      readonly submoduleCommits?: number;
      readonly submodulesSkipped?: number;
    }
  | { readonly outcome: "skipped"; readonly reason: FinalizeSkipReason }
  | {
      readonly outcome: "failed";
      readonly reason: CommitErrorCode | "INTERNAL_ERROR";
      /** Refused paths by reason (T9.3 path rules); counts only, never names. */
      readonly refused?: Readonly<Partial<Record<PathRefusalReason, number>>>;
      /** `PROVENANCE_PENDING`: the commit is on the publish ref; `GitPublisher.recover()` writes its row. */
      readonly commitSha?: string;
    };

/**
 * The project snapshot under which finalize-only applies, or undefined when it does not apply at all (no project, no
 * opt-in, or an adapter that receives the channel: then the `commit` tool is the path, FR-GIT-02). Only facts frozen at
 * admission count (ROADMAP Q-41).
 */
export function finalizeCommitPlan(
  commitChannel: "injected" | "finalize-only" | "none",
  policySnapshotJson: string,
): ProjectSnapshot | undefined {
  if (commitChannel === "injected") return undefined;
  let project: ProjectSnapshot | undefined;
  try {
    project = (JSON.parse(policySnapshotJson) as { project?: ProjectSnapshot }).project;
  } catch {
    return undefined;
  }
  return project?.finalize_commit === true ? project : undefined;
}

/** True when any run of the meta-session recorded a `git_policy_violation` (BR-27). */
export function sessionHasGitPolicyViolation(ledger: Ledger, metaSessionId: string): boolean {
  return ledger
    .listRunsForMetaSession(metaSessionId)
    .some((r) => ledger.listRunEvents(r.id).some((e) => e.type === GIT_POLICY_VIOLATION_EVENT));
}

export interface FinalizeCommitRequest {
  readonly runId: string;
  readonly project: ProjectSnapshot;
  /** The run is about to end SUCCEEDED (the checkpoint succeeded too). */
  readonly succeeded: boolean;
  readonly gitPolicyViolation: boolean;
  /** Worktree-relative paths changed by the run (pre to post checkpoint; nested repositories are already excluded). */
  readonly changedPaths: readonly string[];
  /** The agent's structured final summary (FR-ADP-04), unmodified. */
  readonly summary: string | undefined;
  readonly nativeSessionIds: readonly string[];
  /** Id of the run's transition event into FINALIZING (FR-GIT-07 "tool-call event" for this path). */
  readonly finalizingEventId: string | undefined;
  /**
   * The run is an approved bypass run (approved `privileged` scope with `bypass`, ADR-0017), as the lifecycle
   * derived it from `bypassApprovedFor`. Owner decision 44 (ROADMAP Q-45): the two size
   * limits then no longer skip. Default false.
   */
  readonly approvedBypass?: boolean;
  /**
   * T9.10 (FR-GIT-10, BR-33): the BR-31 verdict for signing (`evaluateSigningReach`), set by the lifecycle when the
   * snapshot has `sign: true`. A snapshot with `sign: true` and no verdict fails closed (`SIGNING_FAILED`).
   */
  readonly signReach?: CredentialReach;
}

/** Decide and, when every condition holds, make the finalize-only commit. Never throws. */
export async function makeFinalizeCommit(
  publisher: GitPublisher | undefined,
  req: FinalizeCommitRequest,
): Promise<FinalizeCommitOutcome> {
  const skip = (reason: FinalizeSkipReason): FinalizeCommitOutcome => ({ outcome: "skipped", reason });
  const p = req.project;
  if (!req.succeeded) return skip("run_not_succeeded");
  if (p.environment_kind !== "host") return skip("environment_not_host");
  if (p.writable !== true) return skip("context_not_writable");
  if (p.identity === undefined) return skip("no_identity");
  if (req.gitPolicyViolation) return skip("git_policy_violation");
  if (publisher === undefined) return skip("service_unavailable");
  const paths = [...new Set(req.changedPaths)];
  // ADR-0087 item 4: the run's changed paths cannot see inside an attached submodule, so a run whose only changes are
  // in submodules still commits (the publisher takes every writable submodule and reports the read-only ones).
  if (paths.length === 0 && !(await publisher.hasAttachedSubmodules(req.runId))) return skip("no_changes");
  const bypass = req.approvedBypass === true;
  if (paths.length > MAX_PATHS && !bypass) return skip("too_many_paths");
  const message = req.summary ?? "";
  if (message.trim() === "") return skip("no_message");
  if (message.length > FINALIZE_MESSAGE_MAX && !bypass) return skip("message_too_long");
  try {
    const r = await publisher.commit({
      runId: req.runId,
      message,
      paths,
      identity: p.identity,
      projectId: p.id,
      contextId: p.context_id,
      origin: "finalize_only",
      allSubmodules: true,
      // The publisher sanitises the whole text, then truncates to FINALIZE_MESSAGE_MAX with a note (bypass only).
      ...(bypass ? { looseLimits: true } : {}),
      nativeSessionIds: req.nativeSessionIds,
      ...(req.finalizingEventId !== undefined ? { finalizingEventId: req.finalizingEventId } : {}),
      ...(p.sign === true
        ? { sign: { reach: req.signReach ?? { ok: false, reason: "snapshot_unreadable" as const } } }
        : {}),
    });
    return {
      outcome: "committed",
      commitSha: r.sha,
      provenanceId: r.provenanceId,
      filesChanged: r.filesChanged,
      ...(r.submodules !== undefined
        ? { submoduleCommits: r.submodules.length, submodulesSkipped: r.submodulesSkipped?.length ?? 0 }
        : {}),
    };
  } catch (err) {
    if (!(err instanceof CommitError)) return { outcome: "failed", reason: "INTERNAL_ERROR" };
    if (err.code === "MESSAGE_EMPTY_AFTER_SANITISING") return skip("no_message");
    if (err.code === "NOTHING_TO_COMMIT") return skip("nothing_to_commit");
    const refused: Partial<Record<PathRefusalReason, number>> = {};
    for (const r of err.refused) refused[r.reason] = (refused[r.reason] ?? 0) + 1;
    return {
      outcome: "failed",
      reason: err.code,
      ...(err.refused.length > 0 ? { refused } : {}),
      ...(err.commitSha !== undefined ? { commitSha: err.commitSha } : {}),
    };
  }
}

/** The bounded `git_finalize_commit` event payload: codes, counts and SHAs only (no message, no path names). */
export function finalizeCommitEventPayload(o: FinalizeCommitOutcome): Record<string, unknown> {
  switch (o.outcome) {
    case "committed":
      return {
        outcome: o.outcome,
        commit_sha: o.commitSha,
        provenance_id: o.provenanceId,
        files_changed: o.filesChanged,
        ...(o.submoduleCommits !== undefined
          ? { submodule_commits: o.submoduleCommits, submodules_skipped: o.submodulesSkipped ?? 0 }
          : {}),
      };
    case "skipped":
      return { outcome: o.outcome, reason: o.reason };
    default:
      return {
        outcome: o.outcome,
        reason: o.reason,
        ...(o.refused ? { refused: o.refused } : {}),
        ...(o.commitSha !== undefined ? { commit_sha: o.commitSha } : {}),
      };
  }
}
