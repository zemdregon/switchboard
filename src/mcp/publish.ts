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
 * The pull request text is controller-built around the run's own proposal (ADR-0069 note 2026-10-20): the newest
 * `pr_draft` artifact, else a title and description proposed in the run's stored result summary
 * ({@link extractProposal}). The title is `switchboard: <proposed title or run id>`, sanitised by
 * {@link pullRequestTitle} and capped at {@link TITLE_TEXT_MAX}. The body is the proposed description (capped at
 * {@link DRAFT_BODY_MAX_BYTES}, mentions neutralised) first, then a `---` line, a label saying it is agent-written and
 * from which source, and the controller footer (run, meta-session, provider, project, head); with no proposal, the
 * footer alone. A reused open pull request is never edited.
 *
 * ADR-0079 items 5 and 6 (LLD §3.4.16): for a project whose primary context sets `submodules.mode: "recursive"`
 * ({@link PublishDeps.submodules}), the umbrella push is preceded by the linked publication of
 * `src/mcp/publish-submodules.ts` (verified history, the multi-repository secret scan, one push per changed submodule
 * repository; any refusal stops before the umbrella push), and the pull request step opens or reuses one pull request
 * per changed repository against its own default branch before the umbrella's, whose newly created body lists every
 * linked pull request (Delegated wording). A `gh` failure for one repository is reported on that repository's
 * `submodules[]` entry and never undoes a push. Each linked pull request is a `submodule_pull_request` row and a
 * `pull_request_opened` run event with its `repo`.
 */
import type { ArtifactStore } from "../artifacts/index.js";
import { branchOfPublishRef, isSafeBranch, PR_BODY_MAX_BYTES } from "../ci/gh-argv.js";
import { type PullRequestErrorCode, type PullRequestPort, PullRequestPortError } from "../ci/gh-pr.js";
import { parseGithubRemote } from "../ci/published-refs.js";
import type { PushContextConfig, PushResult } from "../git/push.js";
import { isBranchPrefix, isRemoteName, remoteTargetRef } from "../git/push.js";
import { describeSecretScanFindings, SECRET_SCAN_FIX_HINT, secretScanFindings } from "../git/secret-scan.js";
import type { GitPushRequester, Ledger, PullRequestRow, RunRecord } from "../ledger/index.js";
import { insertSubmodulePullRequest } from "../submodules/ledger.js";
import { gitText } from "../workspace/git.js";
import { buildEnvelope } from "./envelope.js";
import { invalid, ToolError } from "./errors.js";
import {
  checkLinkedGates,
  type LinkedPushOutcome,
  type LinkedRepo,
  linkedRepos,
  originUrlOf,
  type PublishSubmoduleDeps,
  pushLinked,
  scanLinked,
  umbrellaOf,
  withPublishLock,
} from "./publish-submodules.js";

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
  /** ADR-0079 item 6: linked publication of umbrella projects; absent, every project publishes as before. */
  readonly submodules?: PublishSubmoduleDeps;
}

export interface PublishContext {
  readonly ledger: Ledger;
  readonly artifacts: Pick<ArtifactStore, "get">;
  readonly clientId: string;
  /** Configured projects this client may use (`mcp_clients[].projects`). */
  readonly clientProjects: readonly string[];
  /** The `get_run` outbound scrubber: the run summary a proposal is read from is exactly what `get_run` returns. */
  readonly scrub: (s: string) => string;
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
  /**
   * ADR-0079 item 6: one entry per changed submodule repository, in path order; present (possibly empty) only for a
   * project whose primary context sets `submodules.mode: "recursive"`.
   */
  submodules?: LinkedPublication[];
}

/** ADR-0079 item 6: one changed submodule repository of a publication. */
export interface LinkedPublication {
  /** `host/owner/repo`. */
  repo: string;
  /** Changed umbrella-relative paths referencing it (duplicate-URL paths together), sorted. */
  paths: string[];
  branch: string;
  head_sha: string;
  /** The repository's default branch (the pull request base); null when it is not known. */
  default_branch: string | null;
  publication: { push_id: string; pushed_at: string; reused: boolean };
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
  const linked = await publishLinked(ctx, deps, run, context, head);

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
  const subs: LinkedPublication[] | undefined = linked?.outcomes.map((o) => ({
    repo: o.repo,
    paths: [...o.paths],
    branch: o.branch,
    head_sha: o.head_sha,
    default_branch: o.default_branch ?? null,
    publication: { push_id: o.push_id, pushed_at: o.pushed_at, reused: o.reused },
    pull_request: null,
  }));
  if (subs !== undefined) result.submodules = subs;
  if (!opts.openPullRequest) return result;
  const proposal = await proposalOf(ctx, run);
  if (linked !== undefined && subs !== undefined && deps.submodules !== undefined) {
    for (const [i, o] of linked.outcomes.entries()) {
      const entry = subs[i] as LinkedPublication;
      const repo = linked.repos.find((r) => r.key === o.repo) as LinkedRepo;
      const pr = await openLinkedPullRequest(
        ctx,
        deps,
        run,
        { repo, outcome: o, umbrella: publication },
        opts.draft,
        proposal,
      );
      if ("error" in pr) entry.pull_request_error = pr.error;
      else entry.pull_request = pr;
    }
  }
  const pr = await openPullRequest(ctx, deps, run, context, publication, opts.draft, proposal, subs ?? []);
  if ("error" in pr) return { ...result, pull_request_error: pr.error };
  return { ...result, pull_request: pr };
}

/**
 * ADR-0079 items 5 and 6: before the umbrella push, the linked publication of every changed submodule repository.
 * Undefined when the project has no submodule plan (or the head is unknown: the pusher then refuses as before).
 */
async function publishLinked(
  ctx: PublishContext,
  deps: PublishDeps,
  run: RunRecord,
  context: PushContextConfig,
  head: string | undefined,
): Promise<{ repos: LinkedRepo[]; outcomes: LinkedPushOutcome[] } | undefined> {
  const sub = deps.submodules;
  if (sub === undefined || run.project_id === null || sub.plan(run.project_id) === undefined) return undefined;
  const umbrella = umbrellaOf(sub.db, run.meta_session_id);
  if (umbrella === undefined || head === undefined) return undefined;
  return withPublishLock(run.meta_session_id, async () => {
    const repos = await linkedRepos(sub, run, { ...umbrella, head });
    if (repos.length === 0) return { repos, outcomes: [] };
    await checkLinkedGates(sub.db, run.meta_session_id, context.path, umbrella.repo);
    if (!isRemoteName(context.remote)) throw notPublishable("REMOTE_INVALID", "push refused (REMOTE_INVALID)");
    if (!isBranchPrefix(context.branchPrefix)) throw notPublishable("PREFIX_INVALID", "push refused (PREFIX_INVALID)");
    const ref = remoteTargetRef(context.branchPrefix, run.meta_session_id);
    await scanLinked(ctx.ledger, sub, run, { ...umbrella, head, ref }, repos, ref);
    const outcomes = await pushLinked(sub, run, {
      repos,
      ref,
      umbrellaHead: head,
      requestedBy: `mcp_client:${ctx.clientId}`,
    });
    return { repos, outcomes };
  });
}

/** A path or branch as a Markdown code span: no control character, no backtick (so it cannot close the span). */
const codeSpan = (s: string): string => `\`${s.replace(CONTROL, " ").replace(/`/gu, "'")}\``;

/**
 * ADR-0079 item 6.5: open or reuse the pull request of one pushed submodule repository against its default branch,
 * recorded as a `submodule_pull_request` row and a `pull_request_opened` event (a reuse once per number and head).
 */
async function openLinkedPullRequest(
  ctx: PublishContext,
  deps: PublishDeps,
  run: RunRecord,
  linked: { repo: LinkedRepo; outcome: LinkedPushOutcome; umbrella: PublishResult["publication"] },
  draft: boolean,
  proposal: ProposedText | undefined,
): Promise<NonNullable<LinkedPublication["pull_request"]> | { error: PublishPullRequestError }> {
  const sub = deps.submodules as PublishSubmoduleDeps;
  const { outcome: o, umbrella } = linked;
  const url = await originUrlOf(linked.repo.store);
  const gh = url === undefined ? undefined : (sub.githubRepo ?? parseGithubRemote)(url);
  if (gh === undefined) return { error: "REMOTE_NOT_GITHUB" };
  const base = o.default_branch;
  if (base === undefined || !isSafeBranch(base)) return { error: "BASE_INVALID" };
  const ghRepo = `${gh.owner}/${gh.repo}`;
  const umbrellaRef = `refs/heads/${umbrella.branch}`;
  const prior = (number: number) =>
    sub.db
      .prepare(
        `SELECT draft, head_sha FROM submodule_pull_request WHERE meta_session_id = ? AND repo = ? AND number = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(run.meta_session_id, ghRepo, number) as { draft: number; head_sha: string }[];
  const record = (number: number, prUrl: string, action: "created" | "reused") => {
    if (action === "reused" && prior(number).some((r) => r.head_sha === o.head_sha)) return;
    ctx.ledger.immediate(() => {
      const row = insertSubmodulePullRequest(sub.db, {
        runId: run.id,
        metaSessionId: run.meta_session_id,
        pushId: o.push_id,
        clientId: ctx.clientId,
        repo: ghRepo,
        number,
        url: prUrl,
        branch: o.branch,
        baseRef: base,
        headSha: o.head_sha,
        umbrellaRef,
        draft,
        action,
      });
      // As `recordPullRequest` announces the umbrella's: the row's facts, never a title or body.
      ctx.ledger.appendRunEvent({
        runId: run.id,
        type: "pull_request_opened",
        payload: {
          pull_request_id: row.id,
          push_id: o.push_id,
          repo: ghRepo,
          number,
          url: prUrl,
          branch: o.branch,
          base_ref: base,
          head_sha: o.head_sha,
          draft,
          action,
          requested_by: `mcp_client:${ctx.clientId}`,
          submodule: { source: o.repo, paths: [...o.paths], umbrella_ref: umbrellaRef },
        },
      });
    });
  };
  try {
    const found = await deps.pulls.findForBranch({ owner: gh.owner, repo: gh.repo, branch: o.branch });
    if (found !== null && found.state === "OPEN") {
      const wasDraft = prior(found.number)[0]?.draft === 1;
      record(found.number, found.url, "reused");
      return { number: found.number, url: found.url, draft: wasDraft, reused: true };
    }
    const created = await deps.pulls.create({
      owner: gh.owner,
      repo: gh.repo,
      branch: o.branch,
      base,
      title: pullRequestTitle(proposal?.title, run.id),
      body: pullRequestBody(run, { head_sha: o.head_sha }, proposal, [
        `- Submodule paths: ${o.paths.map(codeSpan).join(", ")}`,
        `- Umbrella branch: ${codeSpan(umbrella.branch)} at \`${umbrella.head_sha}\``,
      ]),
      draft,
    });
    record(created.number, created.url, "created");
    return { number: created.number, url: created.url, draft, reused: false };
  } catch (err) {
    if (err instanceof PullRequestPortError) return { error: err.code };
    return { error: "GH_FAILED" };
  }
}

/** Most linked pull requests listed in an umbrella pull request body (the rest are counted). */
const LINKED_LIST_MAX = 200;

/** The umbrella body's linked list (Delegated wording): one line per submodule repository, with its pull request. */
function linkedLines(subs: readonly LinkedPublication[]): string[] {
  if (subs.length === 0) return [];
  const lines = ["", "Linked submodule pull requests (merge these before this one):", ""];
  for (const s of subs.slice(0, LINKED_LIST_MAX)) {
    const where = `${s.paths.map(codeSpan).join(", ")} (${codeSpan(s.repo)})`;
    lines.push(
      s.pull_request !== null
        ? `- ${where}: ${s.pull_request.url}`
        : `- ${where}: no pull request${s.pull_request_error !== undefined ? ` (${s.pull_request_error})` : ""}`,
    );
  }
  if (subs.length > LINKED_LIST_MAX) lines.push(`- and ${subs.length - LINKED_LIST_MAX} more`);
  return lines;
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

export function pushRefusal(r: PushResult): ToolError {
  const details = { reason: r.reason, push_id: r.pushId };
  // ADR-0075: name each finding (rule id, path, line; never the value) so the caller can fix it.
  if (r.reason === "SECRET_SCAN_BLOCKED" && r.secretScan !== undefined) {
    const f = secretScanFindings(r.secretScan);
    return new ToolError(
      "PERMISSION_BLOCKED",
      `push refused (SECRET_SCAN_BLOCKED): ${describeSecretScanFindings(f)}. ${SECRET_SCAN_FIX_HINT}`,
      { ...details, ...f },
    );
  }
  if (r.reason === "NOTHING_TO_PUSH") return invalid("the publish ref has no commit to push", details);
  // ADR-0074 (Q-112): after rebase_session the branch pushed before is not an ancestor; the controller never forces.
  if (r.reason === "NON_FAST_FORWARD") {
    return new ToolError(
      "PERMISSION_BLOCKED",
      "push refused (NON_FAST_FORWARD): the remote branch is not an ancestor of the publish head (for example after " +
        "rebase_session); the controller never force-pushes",
      details,
    );
  }
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
  proposed: ProposedText | undefined,
  linked: readonly LinkedPublication[],
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
    const created = await deps.pulls.create({
      owner: gh.owner,
      repo: gh.repo,
      branch: publication.branch,
      base,
      title: pullRequestTitle(proposed?.title, run.id),
      body: pullRequestBody(run, publication, proposed, linkedLines(linked)),
      draft,
    });
    record(created.number, created.url, "created");
    return { number: created.number, url: created.url, draft, reused: false };
  } catch (err) {
    if (err instanceof PullRequestPortError) return { error: err.code };
    return { error: "GH_FAILED" };
  }
}

/** The run's proposed pull request text and where it came from (ADR-0069 note 2026-10-20). */
export interface ProposedText {
  title?: string;
  body?: string;
  source: "pr_draft" | "run_summary";
}

/** The newest non-empty `pr_draft` artifact; else a proposal in the run's stored result summary (as `get_run` shows it). */
async function proposalOf(ctx: PublishContext, run: RunRecord): Promise<ProposedText | undefined> {
  const draft = await draftOf(ctx, run.id);
  if (draft !== undefined && ((draft.title ?? "").trim() !== "" || (draft.body ?? "").trim() !== "")) {
    return { ...draft, source: "pr_draft" };
  }
  const summary = buildEnvelope(ctx.ledger, run, ctx.scrub).result.summary;
  const proposal = summary === undefined ? undefined : extractProposal(summary);
  return proposal === undefined ? undefined : { ...proposal, source: "run_summary" };
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

const THEMATIC_BREAK = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/u;
const TITLE_HEADING = /^ {0,3}#{1,2}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;

/**
 * A pull request title and description proposed in a run's result summary, or undefined (never invented from prose):
 * the first level 1/2 ATX heading that follows a thematic break line (`---`, `***`, `___`; blank lines between are
 * allowed), or else a level 1/2 heading on the summary's first non-blank line. The heading text is the title (raw;
 * {@link pullRequestTitle} sanitises it) and everything after the heading line is the body. Lines inside fenced code
 * blocks are neither breaks nor headings.
 */
export function extractProposal(summary: string): { title: string; body: string } | undefined {
  const lines = summary.split(/\r\n|\r|\n/u);
  const at = (i: number) => {
    const m = TITLE_HEADING.exec(lines[i] ?? "");
    const title = m?.[1]?.trim() ?? "";
    if (title === "") return undefined;
    return {
      title,
      body: lines
        .slice(i + 1)
        .join("\n")
        .trim(),
    };
  };
  let fence: string | undefined;
  let afterBreak = false;
  let firstNonBlank: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const f = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (f !== undefined && f[0] === fence[0] && f.length >= fence.length) fence = undefined;
      continue;
    }
    if (line.trim() === "") continue;
    firstNonBlank ??= i;
    if (f !== undefined) {
      fence = f;
      afterBreak = false;
      continue;
    }
    if (afterBreak) {
      const hit = at(i);
      if (hit !== undefined) return hit;
    }
    afterBreak = THEMATIC_BREAK.test(line);
  }
  return firstNonBlank === undefined ? undefined : at(firstNonBlank);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove control characters
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
/** `@` that would ping a user or team on GitHub (not inside a word, as in an email address). */
const MENTION = /(?<!\w)@(?=[A-Za-z0-9])/gu;
/** Markdown emphasis or code markers that may wrap the whole title, longest first. */
const TITLE_WRAPS = ["**", "__", "*", "_", "`"] as const;

/** The title without a trailing period (not an ellipsis) or a marker pair wrapping all of it, repeatedly. */
function unwrapTitle(title: string): string {
  let t = title;
  for (;;) {
    t = t.replace(/(?<!\.)\.$/u, "").trim();
    const w = TITLE_WRAPS.find((m) => {
      const inner = t.slice(m.length, -m.length);
      return t.length > 2 * m.length && t.startsWith(m) && t.endsWith(m) && !inner.includes(m);
    });
    if (w === undefined) return t;
    t = t.slice(w.length, -w.length).trim();
  }
}

/**
 * Agent text never pings anyone: an `@` before a name becomes the fullwidth `＠` (U+FF20), which GitHub does not link
 * or notify, and which still reads as the name. The simplest safe rewrite: no zero-width characters, no code spans.
 */
export function neutraliseMentions(text: string): string {
  return text.replace(MENTION, "\uff20");
}

/**
 * `switchboard: <text>`: the run's own text without control characters, emphasis or code markers wrapping it, or a
 * trailing period, with mentions neutralised, at most {@link TITLE_TEXT_MAX} characters; else the run id.
 */
export function pullRequestTitle(text: string | undefined, runId: string): string {
  const t = neutraliseMentions(unwrapTitle((text ?? "").replace(CONTROL, " ").replace(/\s+/gu, " ").trim()));
  const clean = [...t].slice(0, TITLE_TEXT_MAX).join("").trim();
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

/** Close a fenced code block or HTML comment the (possibly truncated) agent text left open, so the footer renders. */
function closeOpenBlocks(text: string): string {
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const f = FENCE.exec(line)?.[1];
    if (f === undefined) continue;
    if (fence === undefined) fence = f;
    else if (f[0] === fence[0] && f.length >= fence.length) fence = undefined;
  }
  let out = fence === undefined ? text : `${text}\n${fence}`;
  if (out.lastIndexOf("<!--") > out.lastIndexOf("-->")) out = `${out} -->`;
  return out;
}

/** The one-line label between the agent's text and the controller footer, by where the text came from. */
export const AGENT_TEXT_LABEL: Readonly<Record<ProposedText["source"], string>> = {
  pr_draft:
    "_The text above was written by the run's agent (untrusted; from the run's pr_draft artifact, not reviewed by Switchboard)._",
  run_summary:
    "_The text above was written by the run's agent (untrusted; from the run's result summary, not reviewed by Switchboard)._",
};

/**
 * The agent's proposed description first (control characters removed, mentions neutralised, capped so the footer always
 * fits), then a `---` line, the label naming its source, and the controller footer; with no proposal, the footer alone.
 */
export function pullRequestBody(
  run: Pick<RunRecord, "id" | "meta_session_id" | "provider" | "model" | "project_id">,
  publication: Pick<PublishResult["publication"], "head_sha">,
  proposal: Pick<ProposedText, "body" | "source"> | undefined,
  /** ADR-0079 item 6: controller-built lines appended to the footer (already sanitised by the caller). */
  extra: readonly string[] = [],
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
    ...extra,
  ].join("\n");
  const text = neutraliseMentions((proposal?.body ?? "").replace(BODY_CONTROL, "")).trim();
  if (proposal === undefined || text === "") return capBytes(footer, PR_BODY_MAX_BYTES);
  const tail = `\n\n---\n\n${AGENT_TEXT_LABEL[proposal.source]}\n\n${footer}`;
  // Room for the closers closeOpenBlocks may add (a newline and a fence, or " -->").
  const room = Math.min(DRAFT_BODY_MAX_BYTES, PR_BODY_MAX_BYTES - Buffer.byteLength(tail, "utf8") - 64);
  const agent = closeOpenBlocks(capBytes(text, room).trimEnd());
  return capBytes(`${agent}${tail}`, PR_BODY_MAX_BYTES);
}
