/**
 * MCP `close_pr` (ADR-0078; LLD §3.4.16; FR-GIT-13). An MCP client that may `publish_run` closes a superseded pull
 * request that Switchboard itself opened for one of its projects, with a controller-built comment linking the
 * replacement pull request, and optionally deletes the head branch. Scope is `publish_run`'s
 * ({@link publishableContext}: a configured project in the client's list or a dynamic project it created, whose primary context's push policy is
 * `branch`), narrowed to pull requests `publish_run` CREATED (a `pull_request` row with `action = 'created'`, never
 * `reused`) in the project's own github.com repository, for a run of this client visible to the caller (another
 * client's or another HTTP subject's run never matches). Anything else is refused before any `gh` call.
 *
 * `gh` calls go through the operator's own login and the audited argv: G17 reads the pull request and the replacement
 * by number; the pull request must still have the recorded head branch and must not be merged; G16 closes it. An already
 * closed pull request is returned with `closed: false` and nothing is written to GitHub (idempotent).
 *
 * Every call, allowed or denied, is one append-only `pull_request_close` row (migration 0036), with a
 * `pull_request_close` run event on the matched run; calls refused before this function (not offered, schema) are
 * recorded by the server through {@link recordClosePrRefusal}.
 */

import { type PullRequestByNumber, PullRequestPortError } from "../ci/gh-pr.js";
import { parseGithubRemote } from "../ci/published-refs.js";
import { PROJECT_ID_PATTERN } from "../config/schema.js";
import type { Ledger, NewPullRequestClose, PullRequestCloseOutcome } from "../ledger/index.js";
import { invalid, ToolError, toToolError } from "./errors.js";
import { defaultPushUrl, type PublishContext, type PublishDeps, publishableContext } from "./publish.js";

export interface ClosePrArgs {
  project_id: string;
  pull_request_number: number;
  replacement_pull_request_number: number;
  delete_branch?: boolean;
}

export interface ClosePrResult {
  project_id: string;
  run_id: string;
  pull_request: { number: number; url: string };
  replacement_pull_request: { number: number; url: string };
  /** False when the pull request was already closed (nothing was written to GitHub). */
  closed: boolean;
  branch_deleted: boolean;
}

export interface ClosePrContext extends Pick<PublishContext, "clientId" | "clientProjects"> {
  readonly ledger: Ledger;
  /** Whether the caller (client and HTTP subject) may see `runId` (the server's `ownRun` rule). */
  readonly visibleRun: (runId: string) => boolean;
}

/** ADR-0078: `close_pr` is offered only when the pull-request port can read by number and close. */
export function closePrOffered(deps: Pick<PublishDeps, "pulls"> | undefined): boolean {
  return deps?.pulls.findByNumber !== undefined && deps.pulls.close !== undefined;
}

/** The controller-built close comment: numbers, the client id and the run id only, never caller text. */
export function closeComment(replacement: number, clientId: string, runId: string): string {
  return (
    `Superseded by #${replacement}.\n\n` +
    `Closed by Switchboard (\`close_pr\`) at the request of MCP client \`${clientId}\`. ` +
    `Switchboard opened this pull request for run \`${runId}\`.`
  );
}

const reasonOf = (err: ToolError): string => (typeof err.details.reason === "string" ? err.details.reason : err.code);

/** The audit row's argument columns from raw (possibly invalid) arguments: only well-typed values are kept. */
function argColumns(
  clientId: string,
  raw: unknown,
): Pick<NewPullRequestClose, "client_id" | "project_id" | "number" | "replacement_number" | "delete_branch"> {
  const a = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const id = (v: unknown) => (typeof v === "string" && new RegExp(PROJECT_ID_PATTERN, "u").test(v) ? v : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);
  return {
    client_id: clientId,
    project_id: id(a.project_id),
    number: num(a.pull_request_number),
    replacement_number: num(a.replacement_pull_request_number),
    delete_branch: a.delete_branch === true ? 1 : 0,
  };
}

/** ADR-0078: the audit row of a `close_pr` call refused before {@link closePr} ran (not offered, schema). */
export function recordClosePrRefusal(ledger: Ledger, clientId: string, raw: unknown, reason: string): void {
  ledger.recordPullRequestClose({
    ...argColumns(clientId, raw),
    pull_request_id: null,
    run_id: null,
    repo: null,
    outcome: "refused",
    reason,
  });
}

const ghFailure = (err: unknown, what: string): ToolError => {
  const code = err instanceof PullRequestPortError ? err.code : "GH_FAILED";
  const e = new ToolError("TOOL_FAILURE", `gh failed while ${what}`, { reason: code });
  e.retryable = code !== "GH_MISSING" && code !== "AUTH_REQUIRED";
  return e;
};

export async function closePr(ctx: ClosePrContext, deps: PublishDeps, args: ClosePrArgs): Promise<ClosePrResult> {
  const audit: Omit<NewPullRequestClose, "outcome" | "reason"> = {
    ...argColumns(ctx.clientId, args),
    pull_request_id: null,
    run_id: null,
    repo: null,
  };
  const record = (outcome: PullRequestCloseOutcome, reason: string | null) =>
    ctx.ledger.recordPullRequestClose({ ...audit, outcome, reason });
  try {
    const result = await closeChecked(ctx, deps, args, audit);
    record(result.closed ? "closed" : "already_closed", null);
    return result;
  } catch (err) {
    const te = toToolError(err);
    record(te.code === "TOOL_FAILURE" ? "failed" : "refused", reasonOf(te));
    throw te;
  }
}

async function closeChecked(
  ctx: ClosePrContext,
  deps: PublishDeps,
  args: ClosePrArgs,
  audit: { pull_request_id: string | null; run_id: string | null; repo: string | null },
): Promise<ClosePrResult> {
  const { pulls } = deps;
  if (pulls.findByNumber === undefined || pulls.close === undefined) {
    throw invalid('unknown tool "close_pr"', { reason: "TOOL_NOT_OFFERED" });
  }
  const number = args.pull_request_number;
  const replacement = args.replacement_pull_request_number;
  if (number === replacement) {
    throw invalid("a pull request cannot replace itself", { reason: "SAME_PULL_REQUEST", field: "replacement" });
  }
  const context = publishableContext(deps, ctx, args.project_id);
  const url =
    context.remote === undefined ? undefined : await (deps.pushUrl ?? defaultPushUrl)(context.path, context.remote);
  const gh = url === undefined ? undefined : parseGithubRemote(url);
  if (gh === undefined) {
    throw invalid("the project's push remote is not a github.com remote", { reason: "REMOTE_NOT_GITHUB" });
  }
  audit.repo = `${gh.owner}/${gh.repo}`;
  const notOurs = () =>
    new ToolError(
      "PERMISSION_BLOCKED",
      `pull request #${number} was not opened by Switchboard for this client's runs of project ${args.project_id}`,
      { reason: "NOT_SWITCHBOARD_PR" },
    );
  const row = ctx.ledger
    .listCreatedPullRequests({ projectId: args.project_id, repo: audit.repo, number })
    .find((r) => r.client_id === ctx.clientId && ctx.visibleRun(r.run_id));
  if (row === undefined) throw notOurs();
  audit.pull_request_id = row.id;
  audit.run_id = row.run_id;

  let current: PullRequestByNumber | null;
  let repl: PullRequestByNumber | null;
  try {
    current = await pulls.findByNumber({ owner: gh.owner, repo: gh.repo, number });
    repl = await pulls.findByNumber({ owner: gh.owner, repo: gh.repo, number: replacement });
  } catch (err) {
    throw ghFailure(err, "reading the pull requests");
  }
  if (current === null || current.headBranch !== row.branch) {
    // The number no longer names the pull request Switchboard opened on that branch (fail closed).
    throw new ToolError("PERMISSION_BLOCKED", `pull request #${number} is not on the branch Switchboard published`, {
      reason: "HEAD_BRANCH_MISMATCH",
    });
  }
  if (repl === null) {
    throw invalid(`replacement pull request #${replacement} does not exist in ${audit.repo}`, {
      reason: "REPLACEMENT_NOT_FOUND",
      field: "replacement_pull_request_number",
    });
  }
  const out = (closed: boolean, branchDeleted: boolean): ClosePrResult => ({
    project_id: args.project_id,
    run_id: row.run_id,
    pull_request: { number, url: current.url },
    replacement_pull_request: { number: replacement, url: repl.url },
    closed,
    branch_deleted: branchDeleted,
  });
  if (current.state === "MERGED") {
    throw new ToolError("PERMISSION_BLOCKED", `pull request #${number} is already merged`, {
      reason: "ALREADY_MERGED",
    });
  }
  if (current.state === "CLOSED") return out(false, false);
  if (current.state !== "OPEN") {
    throw new ToolError("TOOL_FAILURE", "unexpected pull request state", { reason: "PARSE_FAILED" });
  }
  const deleteBranch = args.delete_branch === true;
  try {
    await pulls.close({
      owner: gh.owner,
      repo: gh.repo,
      number,
      comment: closeComment(replacement, ctx.clientId, row.run_id),
      deleteBranch,
    });
  } catch (err) {
    throw ghFailure(err, "closing the pull request");
  }
  return out(true, deleteBranch);
}
