/**
 * MCP `publish_run` (ADR-0069; LLD §3.4.12; FR-GIT-05, FR-GIT-06, FR-GIT-11). An MCP client publishes one of its own
 * SUCCEEDED runs: the controller pushes the run's meta-session publish ref exactly as `switchboard git push` does (the
 * same {@link GitPusher}: policy `branch`, configured remote and prefix, controller commits only, never forced, never
 * the default or a checked-out branch, the pre-push secret scan in every profile), recorded with
 * `requested_by = mcp_client:<id>`, and then, unless the client asks not to, opens (or reuses) a pull request with the
 * operator's own `gh` login through the audited G13/G14 argv (ADR-0050). The agent's `push` tool and BR-31 are not
 * involved: this is a controller push, like the operator's (ADR-0028).
 *
 * Idempotent: when the meta-session already has an ACCEPTED push of the current publish head to the current target,
 * nothing is pushed again and that push is returned; an open pull request for the branch is reused (and recorded once
 * per number and head). A `gh` failure never undoes the push: the result then has `pull_request: null` and a closed
 * `pull_request_error`.
 *
 * The pull request text is controller-built. The title is `switchboard: <draft title or run id>`, where the draft title
 * (the run's `pr_draft` artifact, inner-agent text) is stripped of control characters and capped at
 * {@link TITLE_TEXT_MAX}. The body is a controller footer (run, meta-session, provider, project, head) and, when the run
 * has a `pr_draft` artifact, its body capped at {@link DRAFT_BODY_MAX_BYTES} under a heading that labels it agent-written.
 */
import type { ArtifactStore } from "../artifacts/index.js";
import { branchOfPublishRef, isSafeBranch, PR_BODY_MAX_BYTES } from "../ci/gh-argv.js";
import { type PullRequestErrorCode, type PullRequestPort, PullRequestPortError } from "../ci/gh-pr.js";
import { parseGithubRemote } from "../ci/published-refs.js";
import type { PushContextConfig, PushResult } from "../git/push.js";
import { isBranchPrefix, isRemoteName, remoteTargetRef } from "../git/push.js";
import type { GitPushRequester, Ledger, PullRequestRow, RunRecord } from "../ledger/index.js";
import { gitText } from "../workspace/git.js";
import { invalid, ToolError } from "./errors.js";

/** Most characters of the run's own text in the title (ADR-0069). */
export const TITLE_TEXT_MAX = 120;
/** Most bytes of the agent-written draft body copied into the pull request (ADR-0069). */
export const DRAFT_BODY_MAX_BYTES = 16 * 1024;
/** Newest `git_push` events read when looking for an existing accepted push of the head. */
const PUSH_EVENTS_SCANNED = 500;

/** `pull_request_error` vocabulary: the port's codes, plus the controller's own refusals before any `gh` call. */
export type PublishPullRequestError = PullRequestErrorCode | "REMOTE_NOT_GITHUB" | "BASE_INVALID";

export interface PublishDeps {
  /** The controller pusher (`serve` shares the agent `push` tool's instance, so pushes of one meta-session serialise). */
  readonly pusher: {
    push(req: { metaSessionId: string; requestedBy: GitPushRequester; runId?: string }): Promise<PushResult>;
  };
  /** Configuration first, then approved dynamic projects ({@link projectPushContextResolver}). */
  readonly resolveContext: (projectId: string) => PushContextConfig | undefined;
  readonly pulls: PullRequestPort;
  /** The push URL of `remote` in `repo` (default: `git remote get-url --push` through the hardened helper). */
  readonly pushUrl?: (repo: string, remote: string) => Promise<string | undefined>;
}

export interface PublishContext {
  readonly ledger: Ledger;
  readonly artifacts: Pick<ArtifactStore, "get">;
  readonly clientId: string;
  /** Configured projects this client may use (`mcp_clients[].projects`). */
  readonly clientProjects: readonly string[];
}

export interface PublishResult {
  run_id: string;
  meta_session_id: string;
  publication: {
    push_id: string;
    remote: string;
    branch: string;
    head_sha: string;
    pushed_at: string;
    /** True when an earlier accepted push of the same head was returned and nothing was pushed now. */
    reused: boolean;
  };
  pull_request: { number: number; url: string; draft: boolean; reused: boolean } | null;
  pull_request_error?: PublishPullRequestError;
}

/** Push outcomes that mean "you may not publish this" rather than "the controller failed". */
const POLICY_REASONS: ReadonlySet<string> = new Set([
  "NO_PROJECT",
  "CONTEXT_UNKNOWN",
  "POLICY_NONE",
  "GIT_POLICY_VIOLATION",
  "SKILL_PATH_PRESENT",
  "REMOTE_INVALID",
  "PREFIX_INVALID",
  "CONTEXT_MISMATCH",
  "REMOTE_UNKNOWN",
  "PUBLISH_HISTORY_UNVERIFIED",
  "TARGET_PROTECTED",
  "REPO_CONFIG_UNSAFE",
  "REMOTE_URL_CREDENTIALS",
  "REMOTE_TRANSPORT_NOT_ALLOWED",
  "SECRET_SCAN_BLOCKED",
]);

const notPublishable = (reason: string, message: string) => new ToolError("PERMISSION_BLOCKED", message, { reason });

/** Whether this client may publish runs of `projectId` at all (the `tools/list` gate is the client's push maximum). */
export function publishableContext(
  deps: Pick<PublishDeps, "resolveContext">,
  ctx: Pick<PublishContext, "clientId" | "clientProjects">,
  projectId: string | null,
): PushContextConfig {
  if (projectId === null) throw notPublishable("NO_PROJECT", "the run has no project, so it has no push policy");
  const context = deps.resolveContext(projectId);
  if (context === undefined) throw notPublishable("CONTEXT_UNKNOWN", `project ${projectId} cannot be published`);
  // A configured project must still be in this client's list; a dynamic one must be this client's own (creator-only).
  const mine =
    context.dynamicCreator !== undefined
      ? context.dynamicCreator === ctx.clientId
      : ctx.clientProjects.includes(projectId);
  if (!mine) throw notPublishable("CONTEXT_UNKNOWN", `project ${projectId} cannot be published`);
  if (context.policy !== "branch") {
    throw notPublishable("POLICY_NONE", `project ${projectId}: the primary context's push policy is none`);
  }
  return context;
}

export async function publishRun(
  ctx: PublishContext,
  deps: PublishDeps,
  run: RunRecord,
  opts: { openPullRequest: boolean; draft: boolean },
): Promise<PublishResult> {
  const { ledger } = ctx;
  if (run.state !== "SUCCEEDED") {
    throw invalid(`run ${run.id} is ${run.state}; only a SUCCEEDED run can be published`, {
      reason: "RUN_NOT_SUCCEEDED",
      status: run.state,
    });
  }
  const context = publishableContext(deps, ctx, run.project_id);
  const own = ledger.listGitCommitsForMetaSession(run.meta_session_id).filter((c) => c.run_id === run.id);
  const newest = own[own.length - 1];
  if (newest === undefined) {
    throw invalid(`run ${run.id} has no published commit to push`, { reason: "NOTHING_TO_PUBLISH" });
  }
  const head = ledger.latestPublishedHead(newest.publish_ref);

  const existing = head === undefined ? undefined : acceptedPushOf(ledger, run.meta_session_id, context, head);
  let publication: PublishResult["publication"];
  if (existing !== undefined) {
    publication = { ...existing, reused: true };
  } else {
    const pushed = await deps.pusher.push({
      metaSessionId: run.meta_session_id,
      requestedBy: `mcp_client:${ctx.clientId}`,
      runId: run.id,
    });
    if (!pushed.pushed) throw pushRefusal(pushed);
    const branch = branchOfPublishRef(pushed.ref);
    if (branch === undefined)
      throw new ToolError("TOOL_FAILURE", "the pushed ref is not a branch", { reason: "GIT_FAILED" });
    publication = {
      push_id: pushed.pushId,
      remote: pushed.remote,
      branch,
      head_sha: pushed.headSha,
      pushed_at: ledger.getGitPush(pushed.pushId)?.created_at ?? new Date().toISOString(),
      reused: false,
    };
  }

  const result: PublishResult = {
    run_id: run.id,
    meta_session_id: run.meta_session_id,
    publication,
    pull_request: null,
  };
  if (!opts.openPullRequest) return result;
  const pr = await openPullRequest(ctx, deps, run, context, publication, opts.draft);
  if ("error" in pr) return { ...result, pull_request_error: pr.error };
  return { ...result, pull_request: pr };
}

/** The newest ACCEPTED `git_push` of the meta-session that put `head` on the context's current target. */
function acceptedPushOf(
  ledger: Ledger,
  metaSessionId: string,
  context: PushContextConfig,
  head: string,
): Omit<PublishResult["publication"], "reused"> | undefined {
  if (!isRemoteName(context.remote) || !isBranchPrefix(context.branchPrefix)) return undefined;
  const target = remoteTargetRef(context.branchPrefix, metaSessionId);
  for (const raw of ledger.listGitPushEventPayloadsForMetaSession(metaSessionId, PUSH_EVENTS_SCANNED)) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (p.outcome !== "ACCEPTED" || p.head_sha !== head || p.ref !== target || p.remote !== context.remote) continue;
    const row = typeof p.push_id === "string" ? ledger.getGitPush(p.push_id) : undefined;
    const branch = branchOfPublishRef(target);
    if (row === undefined || branch === undefined) continue;
    return { push_id: row.id, remote: row.remote, branch, head_sha: head, pushed_at: row.created_at };
  }
  return undefined;
}

function pushRefusal(r: PushResult): ToolError {
  const details = { reason: r.reason, push_id: r.pushId };
  if (r.reason === "NOTHING_TO_PUSH") return invalid("the publish ref has no commit to push", details);
  if (POLICY_REASONS.has(r.reason)) return new ToolError("PERMISSION_BLOCKED", `push refused (${r.reason})`, details);
  return new ToolError("TOOL_FAILURE", `push failed (${r.reason})`, details);
}

async function defaultPushUrl(repo: string, remote: string): Promise<string | undefined> {
  if (!isRemoteName(remote)) return undefined;
  try {
    return (await gitText(["remote", "get-url", "--push", remote], { cwd: repo })).split("\n")[0]?.trim();
  } catch {
    return undefined;
  }
}

/** `main`, `refs/heads/main`, `origin/main` or `refs/remotes/origin/main` (the push remote's) as a branch name. */
export function baseBranchOf(baseRef: string, remote: string): string | undefined {
  let b = baseRef;
  for (const prefix of ["refs/heads/", `refs/remotes/${remote}/`, `${remote}/`]) {
    if (b.startsWith(prefix)) {
      b = b.slice(prefix.length);
      break;
    }
  }
  return isSafeBranch(b) ? b : undefined;
}

async function openPullRequest(
  ctx: PublishContext,
  deps: PublishDeps,
  run: RunRecord,
  context: PushContextConfig,
  publication: PublishResult["publication"],
  draft: boolean,
): Promise<NonNullable<PublishResult["pull_request"]> | { error: PublishPullRequestError }> {
  const url = await (deps.pushUrl ?? defaultPushUrl)(context.path, publication.remote);
  const gh = url === undefined ? undefined : parseGithubRemote(url);
  if (gh === undefined) return { error: "REMOTE_NOT_GITHUB" };
  const base = baseBranchOf(context.baseRef, publication.remote);
  if (base === undefined) return { error: "BASE_INVALID" };
  const record = (number: number, prUrl: string, action: PullRequestRow["action"]) => {
    const seen = ctx.ledger
      .listPullRequestsForMetaSession(run.meta_session_id)
      .some((r) => r.number === number && r.repo === `${gh.owner}/${gh.repo}` && r.head_sha === publication.head_sha);
    if (seen && action === "reused") return;
    ctx.ledger.recordPullRequest({
      run_id: run.id,
      meta_session_id: run.meta_session_id,
      push_id: publication.push_id,
      client_id: ctx.clientId,
      repo: `${gh.owner}/${gh.repo}`,
      number,
      url: prUrl,
      branch: publication.branch,
      base_ref: base,
      head_sha: publication.head_sha,
      draft: draft ? 1 : 0,
      action,
    });
  };
  try {
    const found = await deps.pulls.findForBranch({ owner: gh.owner, repo: gh.repo, branch: publication.branch });
    if (found !== null && found.state === "OPEN") {
      record(found.number, found.url, "reused");
      const prior = ctx.ledger
        .listPullRequestsForMetaSession(run.meta_session_id)
        .find((r) => r.number === found.number);
      return { number: found.number, url: found.url, draft: prior?.draft === 1, reused: true };
    }
    const prDraft = await draftOf(ctx, run.id);
    const created = await deps.pulls.create({
      owner: gh.owner,
      repo: gh.repo,
      branch: publication.branch,
      base,
      title: pullRequestTitle(prDraft?.title, run.id),
      body: pullRequestBody(run, publication, prDraft?.body),
      draft,
    });
    record(created.number, created.url, "created");
    return { number: created.number, url: created.url, draft, reused: false };
  } catch (err) {
    if (err instanceof PullRequestPortError) return { error: err.code };
    return { error: "GH_FAILED" };
  }
}

/** The run's newest `pr_draft` artifact (`{ title, body }`, sanitised when it was stored), or undefined. */
async function draftOf(ctx: PublishContext, runId: string): Promise<{ title?: string; body?: string } | undefined> {
  const art = ctx.ledger
    .listArtifactsForRun(runId)
    .filter((a) => a.kind === "pr_draft")
    .at(-1);
  if (art === undefined) return undefined;
  try {
    const parsed = JSON.parse((await ctx.artifacts.get(art.sha256)).toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const o = parsed as Record<string, unknown>;
    return {
      ...(typeof o.title === "string" ? { title: o.title } : {}),
      ...(typeof o.body === "string" ? { body: o.body } : {}),
    };
  } catch {
    return undefined; // missing or failed integrity: no draft (fail closed: the footer alone)
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove control characters
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

/** `switchboard: <text>`: the run's own text without control characters, at most {@link TITLE_TEXT_MAX} characters. */
export function pullRequestTitle(text: string | undefined, runId: string): string {
  const clean = [...(text ?? "").replace(CONTROL, " ").replace(/\s+/gu, " ").trim()]
    .slice(0, TITLE_TEXT_MAX)
    .join("")
    .trim();
  return `switchboard: ${clean === "" ? runId : clean}`;
}

/** Truncate to at most `max` UTF-8 bytes on a code point boundary. */
function capBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, "utf8") <= max) return s;
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > max) break;
    out += ch;
    bytes += n;
  }
  return out;
}

export const AGENT_TEXT_HEADING =
  "### Agent-written description (untrusted; from the run's pr_draft artifact, not reviewed by Switchboard)";

/** Controller footer, then the capped agent-written draft under a heading that labels it. */
export function pullRequestBody(
  run: Pick<RunRecord, "id" | "meta_session_id" | "provider" | "model" | "project_id">,
  publication: Pick<PublishResult["publication"], "head_sha">,
  draftBody: string | undefined,
): string {
  const provider =
    run.provider === null ? "unknown" : run.model === null ? run.provider : `${run.provider} (${run.model})`;
  const footer = [
    "Opened by Switchboard `publish_run` with the operator's GitHub login.",
    "",
    `- Run: \`${run.id}\``,
    `- Meta-session: \`${run.meta_session_id}\``,
    `- Provider: ${provider.replace(CONTROL, " ")}`,
    `- Project: \`${run.project_id ?? "-"}\``,
    `- Head: \`${publication.head_sha}\``,
  ].join("\n");
  const agent = capBytes((draftBody ?? "").replace(BODY_CONTROL, ""), DRAFT_BODY_MAX_BYTES).trim();
  const body = agent === "" ? footer : `${footer}\n\n${AGENT_TEXT_HEADING}\n\n${agent}`;
  return capBytes(body, PR_BODY_MAX_BYTES);
}
