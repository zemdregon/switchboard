/**
 * The ordered merge of an umbrella publication with linked submodule pull requests (ADR-0079 item 7, G7, FR-SUB-03;
 * LLD §3.4.16). MCP `merge_run_pr` ({@link mergeOnRequest}) and the policy poller ({@link pollMergePolicies}) run this
 * one step machine through {@link submoduleMergeHook} for an umbrella publish ref that has `submodule_pull_request`
 * rows; every other ref takes the T15.8 gate exactly as before. Its state is the append-only `submodule_merge` table
 * (plus `git_push` and `merge_event`), recomputed on every call, so it survives restarts. Each call advances as far as
 * it can:
 *
 * 1. **submodules**: each linked pull request (the newest row per repository), in path order, through the gate's own
 *    checks read from `gh` JSON for that repository: G10 open, not a draft, its head the pushed head on the pushed
 *    branch, its base the repository's default branch (the store's `origin/HEAD`), mergeable; the checks per
 *    `merge_policy.checks` (G11 or G16); the policy and G10 read again; then G12 pinned to the pushed head and G17 for
 *    its merge commit (`submodule_merged`). The run's verification and reports belong to the umbrella and are not read
 *    here. A pull request already merged at the pushed head (by a person, or by an earlier call whose G17 failed) is
 *    accepted with its G17 merge commit. A refusal is one `submodule_refused` row per (ref, repository, head, reason)
 *    and stops the walk (later repositories stay `waiting`). A failed G12 is `merge_failed`; the poller does not retry
 *    it at that head, an explicit request does (G12 is head-pinned).
 * 2. **repoint**: every merge commit is fetched into its store (`ensureCommits`) and must be on the repository's default
 *    branch; the published umbrella tip must point every linked path at its pushed head. One umbrella commit on that tip
 *    then sets each path's gitlink (duplicate-URL paths together) to its merge commit: a temporary index, `commit-tree`
 *    with the context identity and a date taken from the ledger (so a retry after a crash makes the same commit), a
 *    `git_commit` provenance row (origin `finalize_only`, `via: submodule_repoint`), checked to change those gitlinks
 *    only and secret-scanned, then the meta-session's publish ref moves to it (compare-and-swap) and the controller
 *    pusher pushes it (the same checks, scan and hardening as `publish_run`: fast-forward only, never forced). An
 *    accepted push is `gitlinks_repointed` (`head_sha` the pre-repoint tip, `merged_sha` the new tip).
 * 3. **umbrella**: the new tip is checked again (one parent, the pre-repoint tip; gitlinks only), then the T15.8 gate
 *    ({@link applyMergeGate}) runs at it with step 2 (verification and reports) keyed to the pre-repoint tip.
 * 4. **merged**: the gate's G12, pinned to the new tip.
 *
 * Nothing here holds `gh` or Git text: ids, SHAs, closed codes, `owner/repo` and validated umbrella-relative paths.
 * **Delegated** (not owner-approved): the extra refusal codes ({@link SUBMODULE_MERGE_REFUSAL_REASONS}), the
 * deterministic repoint date, and `ref_event` run events of kinds `submodule_merged` and `gitlinks_repointed` (no
 * `ref_event` row, whose kinds are closed).
 */
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { ProjectSourcesSettings } from "../config/index.js";
import { DEFAULT_PUBLISH_PREFIX, publishRefFor } from "../git/publish-ref.js";
import type { GitPusher } from "../git/push.js";
import { compileSecretScanAllow, type SecretScanAllowEntry, scanOutgoingDiff } from "../git/secret-scan.js";
import type { GitCommitRow } from "../ledger/index.js";
import { type GitRunner, parseRepositoryUrl, sourceKey } from "../projects/clone.js";
import { isFullSha, isSafeSubmodulePath } from "../submodules/errors.js";
import {
  insertSubmoduleMerge,
  listSubmoduleMergeSteps,
  listSubmodulePullRequestsForUmbrellaRef,
  type SubmoduleMergeRow,
  type SubmodulePullRequestRow,
} from "../submodules/ledger.js";
import { defaultBranchOf, ensureCommits, ensureStore } from "../submodules/store.js";
import { git, gitText } from "../workspace/git.js";
import { isGhOwner, isGhRepo, isSafeBranch } from "./gh-argv.js";
import {
  type MergeRefusalReason,
  REF_EVENT_TYPE,
  type SubmoduleMergePhase,
  type SubmoduleMergeRefusalReason,
} from "./merge-codes.js";
import {
  applyMergeGate,
  type LinkedMergeHook,
  type LinkedMergeOutcome,
  type MergePolicyDeps,
  type MergeTarget,
  type SubmoduleMergeRepoView,
} from "./merge-policy.js";
import type { CiPullRequestGateView, CiPullRequestMergeStatePort, CiRequiredChecks } from "./port.js";
import type { PublishedRef } from "./published-refs.js";

/** The inputs of steps 1 to 3 beyond the T15.8 merge port. */
export interface SubmoduleMergeDeps {
  /** G17: a pull request's state and merge commit. */
  readonly mergeState: CiPullRequestMergeStatePort;
  /** The controller pusher `publish_run` uses: the repoint push gets the same checks, scan and hardening. */
  readonly pusher: Pick<GitPusher, "push">;
  /** `project_sources` in force (stores live under its `clone_root`), read at each call. */
  readonly sources: () => ProjectSourcesSettings | undefined;
  /** Network Git runner of store fetches (default: the store library's). */
  readonly git?: GitRunner;
  /** The primary context's commit identity of a project in force. */
  readonly identityOf: (projectId: string) => { readonly name: string; readonly email: string } | undefined;
  /** Where the temporary index is made; outside every repository. */
  readonly scratchDir: string;
  /** The operator's secret-scan allowlist (`git.secret_scan.allow`), as for every push. */
  readonly secretScanAllow?: readonly SecretScanAllowEntry[];
  /** Local publish ref prefix (default `switchboard/pub/`); must match the commit library's. */
  readonly publishPrefix?: string;
  /** The repoint scan (default {@link scanOutgoingDiff}); a seam for tests. */
  readonly scan?: typeof scanOutgoingDiff;
}

/** One linked repository: its newest pull request row for the umbrella ref and the paths of its push. */
export interface LinkedRepository {
  /** `owner/repo` as `gh` takes it. */
  readonly repo: string;
  /** `host/owner/repo` store key. */
  readonly key: string;
  readonly paths: readonly string[];
  readonly pr: SubmodulePullRequestRow;
}

/**
 * The linked repositories of `umbrellaRef` for `projectId`, in path order (by each repository's first path). The
 * newest pull request row per repository wins; a row whose push is of another project, or whose paths or SHAs do not
 * parse, is left out.
 */
export function linkedRepositories(db: Database.Database, projectId: string, umbrellaRef: string): LinkedRepository[] {
  const newest = new Map<string, SubmodulePullRequestRow>();
  for (const row of listSubmodulePullRequestsForUmbrellaRef(db, umbrellaRef)) newest.set(row.repo, row);
  const out: LinkedRepository[] = [];
  for (const pr of newest.values()) {
    const push = db.prepare("SELECT project_id, repo, paths_json FROM submodule_push WHERE id = ?").get(pr.push_id) as
      | { project_id: string; repo: string; paths_json: string }
      | undefined;
    if (push === undefined || push.project_id !== projectId) continue;
    const paths = parsePaths(push.paths_json);
    if (paths.length === 0 || !isFullSha(pr.head_sha) || !isSafeBranch(pr.branch)) continue;
    const [owner, name, extra] = pr.repo.split("/");
    if (extra !== undefined || owner === undefined || name === undefined || !isGhOwner(owner) || !isGhRepo(name))
      continue;
    out.push({ repo: pr.repo, key: push.repo, paths: [...paths].sort(), pr });
  }
  return out.sort((a, b) => cmp(a.paths[0] as string, b.paths[0] as string));
}

/** Whether `umbrellaRef` of `projectId` has linked submodule pull requests (the ordered merge applies). */
export function hasLinkedPullRequests(db: Database.Database, projectId: string, umbrellaRef: string): boolean {
  return linkedRepositories(db, projectId, umbrellaRef).length > 0;
}

type GateDeps = Pick<MergePolicyDeps, "db" | "ledger" | "merge" | "targets" | "nowMs" | "onEvent" | "pullHeads">;
type Refusal = MergeRefusalReason | SubmoduleMergeRefusalReason;

/**
 * The {@link LinkedMergeHook} of `serve`: undefined for a ref without linked pull requests, else one call of the step
 * machine. Without `sub` (the server lacks the stores, pusher or G17 port) a linked ref is refused
 * `submodule_merge_unavailable` (fail closed: the umbrella is never merged with unrepointed gitlinks).
 */
export function submoduleMergeHook(deps: GateDeps, sub: SubmoduleMergeDeps | undefined): LinkedMergeHook {
  return async (target, ref, gh, opts) => {
    const repos = linkedRepositories(deps.db, target.projectId, ref.publishRef);
    if (repos.length === 0) return undefined;
    if (sub === undefined) {
      return {
        kind: "refused",
        reason: "submodule_merge_unavailable",
        prNumber: null,
        recorded: false,
        refEvents: [],
        submoduleMerge: { phase: "submodules", repos: repos.map((r) => repoView(r, "waiting")) },
      };
    }
    return new StepMachine(deps, sub, target, ref, gh, repos, opts).run();
  };
}

function repoView(
  r: LinkedRepository,
  state: SubmoduleMergeRepoView["state"],
  extra: { merged_sha?: string; reason?: string } = {},
): SubmoduleMergeRepoView {
  return { repo: r.repo, paths: [...r.paths], pr_number: r.pr.number, state, ...extra };
}

class StepMachine {
  private readonly steps: SubmoduleMergeRow[];
  private readonly nowIso: () => string;

  constructor(
    private readonly deps: GateDeps,
    private readonly sub: SubmoduleMergeDeps,
    private readonly target: MergeTarget,
    private readonly ref: PublishedRef,
    private readonly gh: { owner: string; repo: string },
    private readonly repos: readonly LinkedRepository[],
    private readonly opts: Parameters<LinkedMergeHook>[3],
  ) {
    this.steps = listSubmoduleMergeSteps(deps.db, target.projectId, ref.publishRef);
    this.nowIso = () => new Date((deps.nowMs ?? Date.now)()).toISOString();
  }

  async run(): Promise<LinkedMergeOutcome> {
    const tip = this.ref.headSha;
    const repointed = this.steps.find((s) => s.step === "gitlinks_repointed" && s.merged_sha === tip);
    const preTip = repointed?.head_sha ?? tip;
    const expected = this.opts.mode === "request" ? this.opts.expectedHeadSha : undefined;
    if (repointed !== undefined) return this.umbrella(preTip, expected);
    if (expected !== undefined && expected !== tip) return this.refuse("submodules", "head_moved", this.mergedViews());

    // Step 1: each linked pull request in path order.
    const merged = new Map<string, string>();
    const views: SubmoduleMergeRepoView[] = [];
    for (const [i, r] of this.repos.entries()) {
      const done = this.mergedStep(r);
      if (done !== undefined) {
        merged.set(r.repo, done);
        views.push(repoView(r, "merged", { merged_sha: done }));
        continue;
      }
      if (this.opts.mode === "poll" && this.refusedAt(r, "merge_failed")) {
        return { kind: "skipped", refEvents: [], submoduleMerge: this.view("submodules", views, i) };
      }
      const out = await this.mergeOne(r);
      if (out.kind === "refused") {
        const recorded = this.recordRefusal(r, out.reason);
        views.push(repoView(r, "refused", { reason: out.reason }));
        return {
          kind: "refused",
          reason: out.reason,
          prNumber: null,
          recorded,
          refEvents: [],
          submoduleMerge: this.view("submodules", views, i + 1),
        };
      }
      merged.set(r.repo, out.sha);
      views.push(repoView(r, "merged", { merged_sha: out.sha }));
    }

    // Step 2: the repoint commit and its push.
    const pushed = await this.repoint(preTip, merged, views);
    if (pushed.kind === "refused") return pushed.outcome;
    return this.umbrella(preTip, undefined, pushed.tip);
  }

  // ---- step 1 ---------------------------------------------------------------------------------------------------

  private mergedStep(r: LinkedRepository): string | undefined {
    const row = this.steps.find(
      (s) =>
        s.step === "submodule_merged" &&
        s.repo === r.repo &&
        s.pr_number === r.pr.number &&
        s.head_sha === r.pr.head_sha,
    );
    return row?.merged_sha ?? undefined;
  }

  private refusedAt(r: LinkedRepository, reason: string): boolean {
    return this.steps.some(
      (s) => s.step === "submodule_refused" && s.repo === r.repo && s.head_sha === r.pr.head_sha && s.reason === reason,
    );
  }

  /** The gate of one linked pull request, then G12 and G17 (step 1). Never throws for a `gh` or Git failure. */
  private async mergeOne(
    r: LinkedRepository,
  ): Promise<{ kind: "merged"; sha: string } | { kind: "refused"; reason: Refusal }> {
    const [owner, repo] = r.repo.split("/") as [string, string];
    const publishRef = `refs/heads/${r.pr.branch}`;
    const policy = this.target.policy;
    const readView = async (): Promise<CiPullRequestGateView | null | "error"> => {
      try {
        return await this.deps.merge.pullRequestGateView({ owner, repo, publishRef });
      } catch {
        return "error";
      }
    };
    const view = await readView();
    if (view === "error") return { kind: "refused", reason: "gh_error" };
    if (view === null) return { kind: "refused", reason: "not_mergeable" };
    if (view.number !== r.pr.number) return { kind: "refused", reason: "head_moved" };
    if (view.state === "MERGED") {
      // Merged by a person, or by an earlier call whose G17 read failed: accepted at the pushed head only.
      if (view.headSha !== r.pr.head_sha) return { kind: "refused", reason: "head_moved" };
      return this.readMergeCommit(r, owner, repo);
    }
    if (view.state !== "OPEN") return { kind: "refused", reason: "not_mergeable" };
    const store = await this.store(r);
    if (store === undefined) return { kind: "refused", reason: "store_unavailable" };
    const baseBranch = await defaultBranchOf(store, this.storeDeps(r)).catch(() => undefined);
    const first = viewRefusal(view, r, baseBranch);
    if (first !== undefined) return { kind: "refused", reason: first };
    // The checks per `merge_policy.checks` (G11 or G16), as the umbrella's step 3.
    const allReported = policy.checks === "all_reported";
    const reported = this.deps.merge.reportedChecks;
    if (allReported && reported === undefined) return { kind: "refused", reason: "gh_error" };
    let checks: CiRequiredChecks;
    try {
      const q = { owner, repo, prNumber: view.number };
      checks = await (allReported && reported !== undefined
        ? reported.call(this.deps.merge, q)
        : this.deps.merge.requiredChecks(q));
    } catch {
      return { kind: "refused", reason: "gh_error" };
    }
    if (checks.kind === "none")
      return { kind: "refused", reason: allReported ? "no_checks_reported" : "no_required_checks" };
    if (checks.buckets.some((b) => b !== "pass" && b !== "pending")) return { kind: "refused", reason: "check_failed" };
    if (checks.buckets.includes("pending")) return { kind: "refused", reason: "check_pending" };
    // The policy and the pull request are read again right before the write.
    const now = this.deps.targets().find((t) => t.projectId === this.target.projectId);
    if (
      now === undefined ||
      !now.policy.enabled ||
      now.policy.method !== policy.method ||
      (now.policy.checks ?? "required") !== (policy.checks ?? "required")
    ) {
      return { kind: "refused", reason: "policy_off" };
    }
    const again = await readView();
    if (again === "error") return { kind: "refused", reason: "gh_error" };
    if (again === null || again.state !== "OPEN" || again.number !== view.number)
      return { kind: "refused", reason: "head_moved" };
    const second = viewRefusal(again, r, baseBranch);
    if (second !== undefined) return { kind: "refused", reason: second };
    try {
      await this.deps.merge.mergePullRequest({
        owner,
        repo,
        prNumber: view.number,
        method: policy.method,
        headSha: r.pr.head_sha,
      });
    } catch {
      return { kind: "refused", reason: "merge_failed" };
    }
    return this.readMergeCommit(r, owner, repo);
  }

  /** G17: the merge commit of a merged pull request, recorded as `submodule_merged`. */
  private async readMergeCommit(
    r: LinkedRepository,
    owner: string,
    repo: string,
  ): Promise<{ kind: "merged"; sha: string } | { kind: "refused"; reason: Refusal }> {
    let state: Awaited<ReturnType<CiPullRequestMergeStatePort["pullRequestMergeState"]>>;
    try {
      state = await this.sub.mergeState.pullRequestMergeState({ owner, repo, prNumber: r.pr.number });
    } catch {
      return { kind: "refused", reason: "gh_error" };
    }
    const sha = state.mergeCommitSha?.toLowerCase();
    if (state.state !== "MERGED" || sha === undefined || !isFullSha(sha))
      return { kind: "refused", reason: "gh_error" };
    const row = insertSubmoduleMerge(
      this.deps.db,
      {
        runId: r.pr.run_id,
        metaSessionId: r.pr.meta_session_id,
        projectId: this.target.projectId,
        umbrellaRef: this.ref.publishRef,
        step: "submodule_merged",
        repo: r.repo,
        prNumber: r.pr.number,
        headSha: r.pr.head_sha,
        mergedSha: sha,
      },
      { now: () => new Date(this.nowIso()) },
    );
    if (row !== undefined) {
      this.deps.ledger.appendRunEvent({
        runId: r.pr.run_id,
        type: REF_EVENT_TYPE,
        payload: {
          kind: "submodule_merged",
          publish_ref: this.ref.publishRef,
          head_sha: r.pr.head_sha,
          pr_number: r.pr.number,
          repo: r.repo,
          merged_sha: sha,
        },
      });
      this.steps.push(row);
    }
    return { kind: "merged", sha };
  }

  private recordRefusal(r: LinkedRepository, reason: Refusal): boolean {
    const row = insertSubmoduleMerge(
      this.deps.db,
      {
        runId: r.pr.run_id,
        metaSessionId: r.pr.meta_session_id,
        projectId: this.target.projectId,
        umbrellaRef: this.ref.publishRef,
        step: "submodule_refused",
        repo: r.repo,
        prNumber: r.pr.number,
        headSha: r.pr.head_sha,
        reason,
      },
      { now: () => new Date(this.nowIso()) },
    );
    return row !== undefined;
  }

  private async store(r: LinkedRepository): Promise<string | undefined> {
    const settings = this.sub.sources();
    const src = parseRepositoryUrl(`https://${r.key}`);
    if (settings === undefined || src === undefined || sourceKey(src) !== r.key) return undefined;
    try {
      return (await ensureStore(src, { settings, ...(this.sub.git !== undefined ? { git: this.sub.git } : {}) })).path;
    } catch {
      return undefined;
    }
  }

  private storeDeps(r: LinkedRepository): { key: string; git?: GitRunner } {
    return { key: r.key, ...(this.sub.git !== undefined ? { git: this.sub.git } : {}) };
  }

  // ---- step 2 ---------------------------------------------------------------------------------------------------

  private async repoint(
    preTip: string,
    merged: ReadonlyMap<string, string>,
    views: readonly SubmoduleMergeRepoView[],
  ): Promise<{ kind: "pushed"; tip: string } | { kind: "refused"; outcome: LinkedMergeOutcome }> {
    const refuse = (reason: Refusal, r?: LinkedRepository) => ({
      kind: "refused" as const,
      outcome: this.refuse("repoint", reason, views, r !== undefined ? this.recordRefusal(r, reason) : false),
    });
    // Every merge commit in its store and on the repository's default branch.
    for (const r of this.repos) {
      const sha = merged.get(r.repo) as string;
      const store = await this.store(r);
      if (store === undefined) return refuse("store_unavailable", r);
      const presence = await ensureCommits(store, [sha], this.storeDeps(r));
      if (presence.missing.length > 0) return refuse("merge_commit_missing", r);
      const branch = await defaultBranchOf(store, this.storeDeps(r)).catch(() => undefined);
      if (branch === undefined || !(await isAncestor(store, sha, `refs/remotes/origin/${branch}`))) {
        return refuse("merge_commit_off_default_branch", r);
      }
    }
    const session = this.deps.db
      .prepare("SELECT repo_root FROM meta_session WHERE id = ?")
      .get(this.repos[0]?.pr.meta_session_id) as { repo_root: string | null } | undefined;
    const repoRoot = session?.repo_root ?? undefined;
    const identity = this.sub.identityOf(this.target.projectId);
    const metaSessionId = (this.repos[0] as LinkedRepository).pr.meta_session_id;
    const tipRow = this.deps.ledger
      .listGitCommitsForMetaSession(metaSessionId)
      .filter((c) => c.commit_sha === preTip)
      .pop();
    if (repoRoot === undefined || identity === undefined || tipRow === undefined) {
      return refuse("submodule_merge_unavailable");
    }
    // The published tip points every linked path at its pushed head.
    const gitlinks = await readGitlinks(
      repoRoot,
      preTip,
      this.repos.flatMap((r) => r.paths),
    ).catch(() => undefined);
    for (const r of this.repos) {
      if (r.paths.some((p) => gitlinks?.get(p) !== r.pr.head_sha)) return refuse("gitlink_mismatch", r);
    }
    const wanted = new Map<string, string>();
    for (const r of this.repos) for (const p of r.paths) wanted.set(p, merged.get(r.repo) as string);
    const changed = [...wanted].filter(([p, sha]) => gitlinks?.get(p) !== sha);
    const newest = this.newestPr();
    const record = (tip: string) => {
      const row = insertSubmoduleMerge(
        this.deps.db,
        {
          runId: newest.run_id,
          metaSessionId,
          projectId: this.target.projectId,
          umbrellaRef: this.ref.publishRef,
          step: "gitlinks_repointed",
          headSha: preTip,
          mergedSha: tip,
        },
        { now: () => new Date(this.nowIso()) },
      );
      if (row !== undefined) {
        this.deps.ledger.appendRunEvent({
          runId: newest.run_id,
          type: REF_EVENT_TYPE,
          payload: {
            kind: "gitlinks_repointed",
            publish_ref: this.ref.publishRef,
            head_sha: preTip,
            pr_number: null,
            merged_sha: tip,
          },
        });
      }
    };
    // Every merge kept the pushed head (a fast-forward): nothing to repoint.
    if (changed.length === 0) {
      record(preTip);
      return { kind: "pushed", tip: preTip };
    }

    const localRef = publishRefFor(metaSessionId, this.sub.publishPrefix ?? DEFAULT_PUBLISH_PREFIX);
    const commit = await this.repointCommit(repoRoot, preTip, changed, identity).catch(() => undefined);
    // Defence in depth: the commit changes exactly the wanted gitlinks (a Git failure is retryable).
    if (commit === undefined || !(await gitlinksOnly(repoRoot, preTip, commit, wanted))) {
      return refuse("repoint_push_failed");
    }
    const scan = await (this.sub.scan ?? scanOutgoingDiff)(
      repoRoot,
      preTip,
      commit.sha,
      compileSecretScanAllow(this.sub.secretScanAllow ?? []),
    ).catch(() => undefined);
    if (scan === undefined) return refuse("repoint_push_failed");
    if (scan.hitCount > 0) return refuse("secret_scan_blocked");
    this.recordProvenance(tipRow, commit, preTip, localRef, changed);
    // Compare-and-swap: the meta-session's publish ref moves from the published tip only (or is already there).
    const current = await resolveCommit(repoRoot, localRef);
    if (current !== commit.sha) {
      if (current !== preTip) return refuse("head_moved");
      try {
        await git(["update-ref", localRef, commit.sha, preTip], { cwd: repoRoot });
      } catch {
        return refuse("head_moved");
      }
    }
    const requestedBy = this.opts.requestedBy ?? (`mcp_client:${newest.client_id}` as const);
    let pushed: Awaited<ReturnType<GitPusher["push"]>>;
    try {
      pushed = await this.sub.pusher.push({ metaSessionId, requestedBy, runId: newest.run_id });
    } catch {
      return refuse("repoint_push_failed");
    }
    if (!pushed.pushed || pushed.headSha !== commit.sha || pushed.ref !== this.ref.publishRef) {
      if (pushed.reason === "NON_FAST_FORWARD") return refuse("repoint_not_fast_forward");
      if (pushed.reason === "SECRET_SCAN_BLOCKED") return refuse("secret_scan_blocked");
      return refuse("repoint_push_failed");
    }
    record(commit.sha);
    return { kind: "pushed", tip: commit.sha };
  }

  /** The repoint commit: the published tip's tree with the changed gitlinks, one parent, the context identity. */
  private async repointCommit(
    repoRoot: string,
    preTip: string,
    changed: readonly (readonly [string, string])[],
    identity: { name: string; email: string },
  ): Promise<{ sha: string; tree: string }> {
    const tmp = await mkdtemp(path.join(this.sub.scratchDir, "repoint-"));
    try {
      const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
      await git(["read-tree", preTip], { cwd: repoRoot, env });
      const info = changed.map(([p, sha]) => `160000 ${sha}\t${p}\n`).join("");
      await git(["update-index", "--index-info"], { cwd: repoRoot, env, input: info });
      const tree = await gitText(["write-tree"], { cwd: repoRoot, env });
      // The date of the newest `submodule_merged` step: a retry after a crash writes the same commit.
      const when = `${Math.floor(Date.parse(this.newestMergedAt()) / 1000)} +0000`;
      const message = [
        "Point submodules at their merged commits",
        "",
        ...changed.map(([p, sha]) => `${p} ${sha}`),
        "",
      ].join("\n");
      const sha = await gitText(["commit-tree", tree, "-p", preTip, "-F", "-"], {
        cwd: repoRoot,
        input: message,
        env: {
          GIT_AUTHOR_NAME: identity.name,
          GIT_AUTHOR_EMAIL: identity.email,
          GIT_AUTHOR_DATE: when,
          GIT_COMMITTER_NAME: identity.name,
          GIT_COMMITTER_EMAIL: identity.email,
          GIT_COMMITTER_DATE: when,
        },
      });
      return { sha, tree };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /** The `git_commit` provenance row of the repoint commit (idempotent per run and commit). */
  private recordProvenance(
    tipRow: GitCommitRow,
    commit: { sha: string; tree: string },
    preTip: string,
    localRef: string,
    changed: readonly (readonly [string, string])[],
  ): void {
    const newest = this.newestPr();
    this.deps.ledger.recordGitCommit({
      commitSha: commit.sha,
      treeSha: commit.tree,
      repoRoot: tipRow.repo_root,
      publishRef: localRef,
      projectId: this.target.projectId,
      contextId: tipRow.context_id,
      metaSessionId: tipRow.meta_session_id,
      runId: newest.run_id,
      provider: tipRow.provider,
      harness: tipRow.harness,
      model: tipRow.model,
      adapterVersionId: tipRow.adapter_version_id,
      origin: "finalize_only",
      sanitizer: { rules: {} },
      eventPayload: {
        commit_sha: commit.sha,
        tree_sha: commit.tree,
        parent_sha: preTip,
        publish_ref: localRef,
        files_changed: changed.length,
        origin: "finalize_only",
        via: "submodule_repoint",
        sanitizer: { rules: {} },
        gitlinks: changed.map(([p, sha]) => ({ path: p, commit_sha: sha })),
      },
    });
  }

  // ---- step 3 ---------------------------------------------------------------------------------------------------

  private async umbrella(preTip: string, expected: string | undefined, newTip?: string): Promise<LinkedMergeOutcome> {
    const tip = newTip ?? this.ref.headSha;
    const views = this.mergedViews();
    if (expected !== undefined && expected !== preTip && expected !== tip) {
      return this.refuse("umbrella", "head_moved", views);
    }
    if (tip !== preTip) {
      const wanted = new Map<string, string>();
      for (const r of this.repos) for (const p of r.paths) wanted.set(p, this.mergedStep(r) as string);
      const session = this.deps.db
        .prepare("SELECT repo_root FROM meta_session WHERE id = ?")
        .get(this.repos[0]?.pr.meta_session_id) as { repo_root: string | null } | undefined;
      const repoRoot = session?.repo_root ?? undefined;
      if (repoRoot === undefined || !(await gitlinksOnly(repoRoot, preTip, { sha: tip }, wanted))) {
        return this.refuse("umbrella", "head_moved", views);
      }
    }
    const ref: PublishedRef = { ...this.ref, headSha: tip };
    const out = await applyMergeGate(this.deps, this.target, ref, this.gh, {
      mode: this.opts.mode,
      ...(expected === tip ? { expectedHeadSha: tip } : {}),
      verifiedSha: preTip,
    });
    const phase: SubmoduleMergePhase = out.kind === "merged" ? "merged" : "umbrella";
    return { ...out, submoduleMerge: { phase, repos: views } };
  }

  // ---- views ----------------------------------------------------------------------------------------------------

  private mergedViews(): SubmoduleMergeRepoView[] {
    return this.repos.map((r) => {
      const sha = this.mergedStep(r);
      return sha !== undefined ? repoView(r, "merged", { merged_sha: sha }) : repoView(r, "waiting");
    });
  }

  /** `views` for the repositories walked, then `waiting` for the rest from index `from`. */
  private view(phase: SubmoduleMergePhase, views: readonly SubmoduleMergeRepoView[], from: number) {
    return { phase, repos: [...views, ...this.repos.slice(from).map((r) => repoView(r, "waiting"))] };
  }

  private refuse(
    phase: SubmoduleMergePhase,
    reason: Refusal,
    views: readonly SubmoduleMergeRepoView[],
    recorded = false,
  ): LinkedMergeOutcome {
    return {
      kind: "refused",
      reason,
      prNumber: null,
      recorded,
      refEvents: [],
      submoduleMerge: this.view(phase, views, views.length),
    };
  }

  private newestPr(): SubmodulePullRequestRow {
    return [...this.repos]
      .map((r) => r.pr)
      .sort((a, b) => cmp(a.created_at + a.id, b.created_at + b.id))
      .pop() as SubmodulePullRequestRow;
  }

  private newestMergedAt(): string {
    let newest = "";
    for (const r of this.repos) {
      const row = this.steps.find(
        (s) => s.step === "submodule_merged" && s.repo === r.repo && s.head_sha === r.pr.head_sha,
      );
      if (row !== undefined && row.created_at > newest) newest = row.created_at;
    }
    return newest === "" ? this.nowIso() : newest;
  }
}

/** Step 1's checks of one G10 read of a submodule pull request; undefined when they all hold. */
function viewRefusal(
  view: CiPullRequestGateView,
  r: LinkedRepository,
  baseBranch: string | undefined,
): MergeRefusalReason | undefined {
  if (view.isDraft) return "draft";
  if (view.headSha !== r.pr.head_sha || view.headBranch !== r.pr.branch) return "head_moved";
  if (baseBranch === undefined || view.baseBranch !== baseBranch) return "base_mismatch";
  if (view.mergeable !== "MERGEABLE") return "not_mergeable";
  return undefined;
}

/** The gitlinks (mode 160000) of `commit` at `paths`: path → SHA. Other entries are left out. */
async function readGitlinks(repo: string, commit: string, paths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const r = await git(["ls-tree", "-z", "--full-tree", commit, "--", ...paths], { cwd: repo });
  for (const entry of r.stdout.toString("utf8").split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const [mode, type, sha] = entry.slice(0, tab).split(" ");
    if (mode === "160000" && type === "commit" && sha !== undefined) out.set(entry.slice(tab + 1), sha);
  }
  return out;
}

/**
 * `to` has the one parent `from` and differs from it only in gitlinks: every changed entry is a gitlink of a `wanted`
 * path, both sides mode 160000, set to the wanted SHA; and every wanted path is that SHA at `to`.
 */
async function gitlinksOnly(
  repo: string,
  from: string,
  to: { sha: string },
  wanted: ReadonlyMap<string, string>,
): Promise<boolean> {
  try {
    const parents = (await gitText(["rev-list", "--parents", "-n", "1", to.sha], { cwd: repo })).split(" ").slice(1);
    if (parents.length !== 1 || parents[0] !== from) return false;
    const r = await git(["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", from, to.sha], { cwd: repo });
    const parts = r.stdout.toString("utf8").split("\0");
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const [oldMode, newMode, , newSha, status] = (parts[i] as string).replace(/^:/u, "").split(" ");
      const p = parts[i + 1] as string;
      if (oldMode !== "160000" || newMode !== "160000" || status !== "M") return false;
      if (!isSafeSubmodulePath(p) || wanted.get(p) !== newSha) return false;
    }
    const now = await readGitlinks(repo, to.sha, [...wanted.keys()]);
    return [...wanted].every(([p, sha]) => now.get(p) === sha);
  } catch {
    return false;
  }
}

async function isAncestor(repo: string, sha: string, ref: string): Promise<boolean> {
  try {
    const r = await git(["merge-base", "--is-ancestor", sha, ref], { cwd: repo, okCodes: [1, 128] });
    return r.code === 0;
  } catch {
    return false;
  }
}

async function resolveCommit(repo: string, rev: string): Promise<string | undefined> {
  const r = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], {
    cwd: repo,
    okCodes: [1],
  });
  const sha = r.stdout.toString("utf8").trim();
  return r.code === 0 && isFullSha(sha) ? sha : undefined;
}

function parsePaths(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) && v.every((p) => typeof p === "string" && isSafeSubmodulePath(p)) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
