/**
 * GitHub's "Update branch" on request (ADR-0073; MCP `update_run_branch`, LLD §3.4.14, FR-SUB-02). For a published
 * ref of a project whose merge policy is in force and on (the gate `merge_run_pr` uses: not paused, not superseded),
 * the controller reads the pull request (G10), checks that it is open, on the published branch and the primary
 * context's base branch, and that its head is one the merge gate accepts (the published tip, or a pure base merge
 * chain on it, read with {@link PullHeadPort}); then, unless the base head is already in that head, asks GitHub to
 * merge the base into the branch (G15), pinned to that head with `expected_head_sha`. The resulting head is a pure base
 * merge, which the gate accepts. A merge of the base that would conflict is refused (`not_mergeable`) before any write.
 * No `merge_event` row is written (nothing was merged); the MCP layer records a `branch_update` run event.
 */

import { isAdmissionPaused } from "../control/pause.js";
import type { PullHeadPort } from "./base-merge.js";
import { branchOfPublishRef } from "./gh-argv.js";
import type { MergeRefusalReason } from "./merge-codes.js";
import { baseBranchOf, isSuperseded, type MergePolicyDeps } from "./merge-policy.js";
import type { CiBranchUpdatePort, CiPullRequestGateView } from "./port.js";
import { listPublishedRefs } from "./published-refs.js";

export type BranchUpdateOutcome =
  | {
      /** `updated`: GitHub accepted the update request; `current`: the base head is already in the branch. */
      kind: "updated" | "current";
      prNumber: number;
      previousHeadSha: string;
      gh: { owner: string; repo: string };
    }
  | { kind: "refused"; reason: MergeRefusalReason; prNumber: number | null; headSha: string }
  | { kind: "not_published" }
  | { kind: "unresolved"; headSha: string };

export async function updateBranchOnRequest(
  deps: Pick<MergePolicyDeps, "db" | "ledger" | "merge" | "targets" | "resolveRemote"> & {
    pullHeads: PullHeadPort;
    update: CiBranchUpdatePort;
  },
  req: { projectId: string; remote: string; publishRef: string; expectedHeadSha?: string },
): Promise<BranchUpdateOutcome> {
  const { db, ledger } = deps;
  const ref = listPublishedRefs(db, req.projectId).find(
    (r) => r.remote === req.remote && r.publishRef === req.publishRef,
  );
  if (ref === undefined) return { kind: "not_published" };
  const refuse = (reason: MergeRefusalReason, prNumber: number | null, headSha = ref.headSha): BranchUpdateOutcome => ({
    kind: "refused",
    reason,
    prNumber,
    headSha,
  });
  const target = deps.targets().find((t) => t.projectId === req.projectId);
  if (target === undefined || !target.policy.enabled || isAdmissionPaused(ledger, req.projectId)) {
    return refuse("policy_off", null);
  }
  if (isSuperseded(db, req.projectId, ref.publishRef)) return refuse("head_moved", null);
  const gh = await deps.resolveRemote(req.projectId, ref.remote);
  if (gh === undefined) return { kind: "unresolved", headSha: ref.headSha };
  let view: CiPullRequestGateView | null;
  try {
    view = await deps.merge.pullRequestGateView({ ...gh, publishRef: ref.publishRef });
  } catch {
    return refuse("gh_error", null);
  }
  if (view === null || view.state !== "OPEN") return refuse("not_mergeable", view?.number ?? null);
  const head = view.headSha;
  if (view.headBranch !== branchOfPublishRef(ref.publishRef)) return refuse("head_moved", view.number, head);
  const baseBranch = baseBranchOf(target.baseRef, ref.remote);
  if (baseBranch === undefined || view.baseBranch !== baseBranch) return refuse("base_mismatch", view.number, head);
  if (req.expectedHeadSha !== undefined && req.expectedHeadSha !== head) return refuse("head_moved", view.number, head);
  const read = await deps.pullHeads.inspect({
    projectId: req.projectId,
    remote: ref.remote,
    prNumber: view.number,
    baseBranch,
    publishedSha: ref.headSha,
    prHeadSha: head,
  });
  if (read.kind === "error") return refuse("gh_error", view.number, head);
  if (read.head === "foreign") return refuse("head_moved", view.number, head);
  if (read.upToDate) return { kind: "current", prNumber: view.number, previousHeadSha: head, gh };
  if (read.conflicts) return refuse("not_mergeable", view.number, head);
  try {
    await deps.update.updatePullRequestBranch({ ...gh, prNumber: view.number, expectedHeadSha: head });
  } catch {
    // A moved head (GitHub checks expected_head_sha), a conflict or any other `gh` refusal: the exit code only.
    return refuse("gh_error", view.number, head);
  }
  return { kind: "updated", prNumber: view.number, previousHeadSha: head, gh };
}
