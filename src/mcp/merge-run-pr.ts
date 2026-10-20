/**
 * MCP `merge_run_pr` (ADR-0070; LLD §3.4.13; FR-SUB-02, FR-GIT-12). An MCP client that may `publish_run` asks the
 * controller to merge the pull request of one of its own published runs. The decision is T15.8's gate, the same code
 * the CI poller runs ({@link mergeOnRequest} → `applyMergeGate`, LLD §20.7): the project's merge policy in force and
 * on, the project not paused, and, read by the controller from `gh` JSON only at the published head, an open,
 * non-draft, mergeable pull request on the primary context's base branch whose head is the tip Switchboard published,
 * every required check passed, and the policy's verification and report conditions. The one write is G12, `gh pr merge
 * <n> --<method> --match-head-commit <sha>`, through the operator's `gh` login. Every refusal, attempt and merge is the
 * poller's `merge_event` row, so `get_digest` shows it on the publishing run.
 *
 * Scope is `publish_run`'s: the run must be the caller's (another client's or subject's run is unknown, through
 * `ownRun` in the server), and its project must be one this client may publish ({@link publishableContext}).
 *
 * ADR-0073 (LLD §3.4.14): the gate also accepts a pull request head that is a chain of pure base merges on the
 * published tip (GitHub's "Update branch"), verified by the controller with local Git, and merges pinned to that head
 * (`head_kind: base_merge`). MCP `update_run_branch` ({@link updateRunBranch}) asks GitHub for that update, under the
 * same scope and only for a project whose merge policy is in force and on.
 */

import type { HeadKind } from "../ci/base-merge.js";
import { updateBranchOnRequest } from "../ci/branch-update.js";
import type { MergePolicyDeps } from "../ci/merge-policy.js";
import { mergeOnRequest } from "../ci/merge-policy.js";
import type { CiBranchUpdatePort } from "../ci/port.js";
import type { Ledger, RunRecord } from "../ledger/index.js";
import { invalid, ToolError } from "./errors.js";
import { type PublishContext, type PublishDeps, publishableContext } from "./publish.js";

/**
 * The merge port and gate inputs `serve` shares with the CI poller (`ci_trigger.gh_binary`). ADR-0073: `update` (G15)
 * and `pullHeads` offer `update_run_branch`.
 */
export type MergeRunDeps = Omit<MergePolicyDeps, "ledger"> & { readonly update?: CiBranchUpdatePort };

/** ADR-0073: `update_run_branch` is offered only with both the update port and the pull-head reader. */
export function updateRunOffered(deps: MergeRunDeps | undefined): boolean {
  return deps?.update !== undefined && deps.pullHeads !== undefined;
}

/** ADR-0073: the run event `update_run_branch` appends to the run (ids, SHAs and codes only). */
export const BRANCH_UPDATE_EVENT = "branch_update";

export interface MergeRunResult {
  run_id: string;
  pull_request: { number: number; url: string };
  merged: true;
  head_sha: string;
  /** ADR-0073: `published` (the published tip) or `base_merge` (pure base merges on it). */
  head_kind: HeadKind;
  method: "squash" | "merge" | "rebase";
}

export interface UpdateRunBranchResult {
  run_id: string;
  pull_request: { number: number; url: string };
  /** False when the base head is already in the branch (nothing was asked of GitHub). */
  updated: boolean;
  previous_head_sha: string;
}

/** The newest ACCEPTED push of a branch attributed to the run (`publish_run` or the agent `push` tool). */
function runPublication(deps: MergeRunDeps, run: RunRecord): { remote: string; ref: string } | undefined {
  return deps.db
    .prepare(
      `SELECT remote, ref FROM git_push WHERE run_id = ? AND project_id = ? AND outcome = 'ACCEPTED'
         AND ref LIKE 'refs/heads/%' ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(run.id, run.project_id) as { remote: string; ref: string } | undefined;
}

export async function mergeRunPr(
  ctx: Pick<PublishContext, "clientId" | "clientProjects"> & { ledger: Ledger },
  publish: Pick<PublishDeps, "resolveContext">,
  deps: MergeRunDeps,
  run: RunRecord,
  expectedHeadSha: string | undefined,
): Promise<MergeRunResult> {
  publishableContext(publish, ctx, run.project_id);
  const projectId = run.project_id as string;
  const pub = runPublication(deps, run);
  const notPublished = () =>
    invalid(`run ${run.id} has no published branch; publish it with publish_run first`, { reason: "NOT_PUBLISHED" });
  if (pub === undefined) throw notPublished();
  const out = await mergeOnRequest(
    { ...deps, ledger: ctx.ledger },
    {
      projectId,
      remote: pub.remote,
      publishRef: pub.ref,
      ...(expectedHeadSha !== undefined ? { expectedHeadSha } : {}),
    },
  );
  if (out.kind === "not_published") throw notPublished();
  if (out.kind === "unresolved") {
    throw invalid("the published branch's remote is not a github.com remote", { reason: "REMOTE_NOT_GITHUB" });
  }
  if (out.kind === "refused") throw refusal("merge", out);
  return {
    run_id: run.id,
    pull_request: {
      number: out.prNumber,
      url: `https://github.com/${out.gh.owner}/${out.gh.repo}/pull/${out.prNumber}`,
    },
    merged: true,
    head_sha: out.headSha,
    head_kind: out.headKind,
    method: out.method,
  };
}

function refusal(
  verb: "merge" | "update",
  out: { reason: string; headSha: string; prNumber: number | null },
): ToolError {
  const details = {
    reason: out.reason,
    head_sha: out.headSha,
    ...(out.prNumber !== null ? { pull_request_number: out.prNumber } : {}),
  };
  if (out.reason === "gh_error") {
    const what = verb === "merge" ? "merging" : "updating";
    const err = new ToolError("TOOL_FAILURE", `gh or git failed while reading or ${what} the pull request`, details);
    err.retryable = true;
    return err;
  }
  return new ToolError("PERMISSION_BLOCKED", `${verb} refused (${out.reason})`, details);
}

/**
 * MCP `update_run_branch` (ADR-0073, LLD §3.4.14): GitHub's "Update branch" for the pull request of one of this
 * client's published runs ({@link updateBranchOnRequest}). Every outcome but `not_published` and `unresolved` is one
 * `branch_update` run event on the run.
 */
export async function updateRunBranch(
  ctx: Pick<PublishContext, "clientId" | "clientProjects"> & { ledger: Ledger },
  publish: Pick<PublishDeps, "resolveContext">,
  deps: MergeRunDeps,
  run: RunRecord,
  expectedHeadSha: string | undefined,
): Promise<UpdateRunBranchResult> {
  publishableContext(publish, ctx, run.project_id);
  const pub = runPublication(deps, run);
  const notPublished = () =>
    invalid(`run ${run.id} has no published branch; publish it with publish_run first`, { reason: "NOT_PUBLISHED" });
  if (pub === undefined || deps.update === undefined || deps.pullHeads === undefined) throw notPublished();
  const out = await updateBranchOnRequest(
    { ...deps, ledger: ctx.ledger, update: deps.update, pullHeads: deps.pullHeads },
    {
      projectId: run.project_id as string,
      remote: pub.remote,
      publishRef: pub.ref,
      ...(expectedHeadSha !== undefined ? { expectedHeadSha } : {}),
    },
  );
  if (out.kind === "not_published") throw notPublished();
  if (out.kind === "unresolved") {
    throw invalid("the published branch's remote is not a github.com remote", { reason: "REMOTE_NOT_GITHUB" });
  }
  const record = (payload: Record<string, unknown>) =>
    ctx.ledger.appendRunEvent({
      runId: run.id,
      type: BRANCH_UPDATE_EVENT,
      payload: { publish_ref: pub.ref, ...payload },
    });
  if (out.kind === "refused") {
    record({ outcome: "refused", reason: out.reason, head_sha: out.headSha, pr_number: out.prNumber });
    throw refusal("update", out);
  }
  record({
    outcome: out.kind === "updated" ? "requested" : "current",
    previous_head_sha: out.previousHeadSha,
    pr_number: out.prNumber,
  });
  return {
    run_id: run.id,
    pull_request: {
      number: out.prNumber,
      url: `https://github.com/${out.gh.owner}/${out.gh.repo}/pull/${out.prNumber}`,
    },
    updated: out.kind === "updated",
    previous_head_sha: out.previousHeadSha,
  };
}
