import { createHash } from "node:crypto";
import type { Ledger, RunRecord } from "../ledger/index.js";
import { GitError, git } from "../workspace/git.js";
import { DEFAULT_PUBLISH_PREFIX, isRunBranchRef, publishRefFor } from "./publish-ref.js";

/**
 * Ref snapshots and Git policy violations (FR-GIT-01, FR-GIT-03, FRD BR-27, LLD §12.5, TDD §3.10 layer 5; T9.5;
 * ADR-0027). Detection backs prevention: whatever the agent managed to do to Git refs during a run is found here, the
 * controller-owned refs are put back, and everything is recorded.
 *
 * At LEASED, before the provider spawns, {@link RefGuard.snapshotAtLeased} records the repository's refs (`git
 * for-each-ref` over the main repository: branches, tags, remote-tracking refs, notes, stash, other `switchboard/` refs)
 * plus the main checkout's `HEAD`, the worktree's `HEAD`, the run branch and the publish ref, as a digest and a bounded
 * list in a `git_ref_snapshot` run event. At FINALIZING, after the provider has exited and before the controller's
 * checkpoint commit, {@link RefGuard.checkAtFinalizing} lists them again and compares:
 *
 * - **Run branch** (`switchboard/<sess>/<run>`): only the controller moves it, and only at the checkpoint that follows
 *   this check, so its tip must still be the run's `pre` checkpoint commit (ledger). Anything else (an agent `git
 *   commit`, `reset`, `update-ref` or deletion) is a violation; the ref is moved back to the `pre` commit with a
 *   compare-and-swap, which leaves the worktree's files and index alone, so the agent's tree is kept as the working-tree
 *   content the post-run checkpoint records (BR-27) and the agent's commits are not on the run branch.
 * - **Worktree `HEAD`**: must still be the symbolic ref to the run branch; otherwise (`checkout -b`, detached `HEAD`)
 *   it is a violation and is pointed back, so the checkpoint lands on the run branch.
 * - **Publish ref** of the run's meta-session: may only hold commits the controller built. A value is accepted when it
 *   did not change since LEASED, or when it is a commit with a `git_commit_intent` (not aborted) whose parent chain
 *   through such commits reaches the meta-session's base commit. Otherwise it is a violation and the ref is moved
 *   (compare-and-swap) to the newest commit with a `git_commit` provenance row and a valid chain, else back to its LEASED
 *   value, else deleted, so foreign commits are never published (FR-GIT-08).
 * - **Other `switchboard/` refs** may move only as the controller moves them for other runs: another run's branch to
 *   one of that run's checkpoint commits (or deleted once its session is archived by GC, or while that run is not
 *   terminal), another session's publish ref to one of that session's controller commits. Anything else is a violation.
 * - **Every other ref** (default branch, other branches, tags, remote-tracking refs, notes, stash) and the main
 *   checkout's `HEAD`: any change is a violation. They are **reported, not restored** (Delegated): the controller
 *   cannot tell an agent's change from the operator's own concurrent work, and must never modify the operator's
 *   branches or checkout (FR-WS-05).
 *
 * Violations append one `git_policy_violation` event (ref names, change kind and SHAs only; never a message or file
 * content) BEFORE any ref is restored (intent before effect), then one `git_ref_check` event with the outcome. The run's
 * outcome is not changed (BR-27). Nothing here depends on the trust profile: an approved bypass run is checked and
 * handled exactly like any other (owner decision 22: Git-write denial stays enforced in bypass runs).
 *
 * Fail closed: a check that cannot complete is itself recorded as a violation (`check_failed`); a run that reached
 * RUNNING without a LEASED snapshot gets `snapshot_missing` and still has its run branch, worktree `HEAD` and publish ref
 * checked against the ledger. A push the agent made to a remote cannot be seen or undone from here unless it updated a
 * remote-tracking ref (BR-27); prevention (BR-29) is the control.
 */

export const GIT_REF_SNAPSHOT_EVENT = "git_ref_snapshot";
export const GIT_REF_CHECK_EVENT = "git_ref_check";
export const GIT_POLICY_VIOLATION_EVENT = "git_policy_violation";

/** Bounds on what one snapshot or violation event stores (Proposed, Delegated; ADR-0027). */
export interface RefGuardLimits {
  /** Refs listed by name and SHA in the LEASED snapshot; refs beyond it are covered by a tail digest only. */
  readonly maxListedRefs: number;
  /** Bytes of listed `name` plus `sha` in the LEASED snapshot; listing stops at whichever limit comes first. */
  readonly maxListedBytes: number;
  /** Violation entries stored in one `git_policy_violation` event; the total count is always stored. */
  readonly maxViolations: number;
  /** Foreign commit SHAs listed per violated ref; the count is capped at {@link MAX_COUNTED_COMMITS}. */
  readonly maxForeignCommits: number;
}

export const DEFAULT_REF_GUARD_LIMITS: RefGuardLimits = {
  maxListedRefs: 5000,
  maxListedBytes: 1024 * 1024,
  maxViolations: 200,
  maxForeignCommits: 50,
};

/** Upper bound on commits counted per violated ref. */
export const MAX_COUNTED_COMMITS = 1000;
/** Ref names longer than this are stored truncated in violation entries (marked `name_truncated`). */
const MAX_STORED_NAME = 512;

export interface HeadState {
  /** Symbolic-ref target (`refs/heads/...`), or null when detached or unreadable. */
  readonly symref: string | null;
  readonly sha: string | null;
}

/** Payload of the LEASED `git_ref_snapshot` event (version 1). */
export interface RefSnapshotV1 {
  readonly v: 1;
  readonly phase: "leased";
  /** SHA-256 over every ref as `<sha> <name>\n`, names in code-unit order. */
  readonly digest: string;
  readonly ref_count: number;
  /** `[name, sha]` pairs, sorted by name; the first refs up to the limits. */
  readonly refs: readonly (readonly [string, string])[];
  readonly truncated: boolean;
  /** When truncated: the refs whose name sorts after `after` (the last listed name), as a count and digest. */
  readonly tail: { readonly after: string; readonly count: number; readonly digest: string } | null;
  readonly repo_head: HeadState;
  readonly worktree_head: HeadState;
  readonly run_branch: { readonly ref: string; readonly sha: string | null };
  readonly publish_ref: { readonly ref: string; readonly sha: string | null };
}

export type ViolationScope =
  | "run_branch"
  | "worktree_head"
  | "publish_ref"
  | "repo_head"
  | "switchboard"
  | "other"
  | "unlisted"
  | "guard";

export type ViolationKind =
  | "created"
  | "moved"
  | "deleted"
  | "head_changed"
  | "unlisted_refs_changed"
  | "snapshot_missing"
  | "check_failed";

export interface ViolationEntry {
  readonly scope: ViolationScope;
  readonly kind: ViolationKind;
  readonly ref: string | null;
  readonly name_truncated?: true;
  readonly old: string | null;
  readonly new: string | null;
  /** `restore` when the controller puts the ref back; `report` when it only records it. */
  readonly action: "restore" | "report";
  /** Where a restored ref is put back to (null: deleted). */
  readonly restore_to?: string | null;
  readonly foreign_commits?: readonly string[];
  readonly foreign_commit_count?: number;
  readonly detail?: string;
}

export type RefCheckResult =
  | { readonly result: "clean" | "skipped" | "already_checked"; readonly violations: 0 }
  | { readonly result: "violation" | "failed"; readonly violations: number };

export interface RefGuardOptions {
  readonly ledger: Ledger;
  /** Local publish ref prefix; must match the `GitPublisher`'s (default `switchboard/pub/`). */
  readonly publishPrefix?: string;
  readonly limits?: Partial<RefGuardLimits>;
}

interface RunFacts {
  readonly run: RunRecord;
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly runBranchRef: string;
  readonly publishRef: string;
  readonly preCommit: string | undefined;
}

interface Restore {
  readonly scope: "run_branch" | "worktree_head" | "publish_ref";
  readonly ref: string;
  readonly from: string | null;
  readonly to: string | null;
}

export class RefGuard {
  private readonly ledger: Ledger;
  private readonly limits: RefGuardLimits;
  private readonly prefix: string;

  constructor(options: RefGuardOptions) {
    this.ledger = options.ledger;
    this.limits = { ...DEFAULT_REF_GUARD_LIMITS, ...options.limits };
    this.prefix = options.publishPrefix ?? DEFAULT_PUBLISH_PREFIX;
  }

  /**
   * Record the LEASED snapshot for a run with a prepared worktree (idempotent: an existing snapshot is returned). Throws
   * when the repository cannot be read; the caller fails the run before spawn (fail closed).
   */
  async snapshotAtLeased(runId: string): Promise<RefSnapshotV1> {
    const existing = this.leasedSnapshot(runId);
    if (existing) return existing;
    const facts = this.facts(runId);
    if (!facts) throw new Error(`run ${runId} has no worktree to snapshot`);
    const refs = await listRefs(facts.repoRoot);
    const names = [...refs.keys()].sort(compare);
    const listed: [string, string][] = [];
    let bytes = 0;
    for (const name of names) {
      const sha = refs.get(name) as string;
      if (listed.length >= this.limits.maxListedRefs || bytes + name.length + sha.length > this.limits.maxListedBytes) {
        break;
      }
      listed.push([name, sha]);
      bytes += name.length + sha.length;
    }
    const truncated = listed.length < names.length;
    const after = listed.at(-1)?.[0] ?? "";
    // The run's own refs are checked against the ledger, never through the tail digest (the publish ref moves legitimately).
    const own = new Set([facts.runBranchRef, facts.publishRef]);
    const tailNames = truncated ? names.slice(listed.length).filter((n) => !own.has(n)) : [];
    const snapshot: RefSnapshotV1 = {
      v: 1,
      phase: "leased",
      digest: digestOf(names, refs),
      ref_count: names.length,
      refs: listed,
      truncated,
      tail: truncated ? { after, count: tailNames.length, digest: digestOf(tailNames, refs) } : null,
      repo_head: await headState(facts.repoRoot),
      worktree_head: await headState(facts.worktreePath),
      run_branch: { ref: facts.runBranchRef, sha: refs.get(facts.runBranchRef) ?? null },
      publish_ref: { ref: facts.publishRef, sha: refs.get(facts.publishRef) ?? null },
    };
    this.ledger.appendRunEvent({ runId, type: GIT_REF_SNAPSHOT_EVENT, payload: snapshot });
    return snapshot;
  }

  /**
   * Compare with the LEASED snapshot, record and handle violations (BR-27). Call after the provider has exited and
   * before the post-run checkpoint. Never throws for a Git or ledger read problem: that is recorded as `check_failed`.
   * Idempotent: a run that already has a `git_ref_check` event is not checked again.
   */
  async checkAtFinalizing(runId: string): Promise<RefCheckResult> {
    if (this.ledger.listRunEvents(runId).some((e) => e.type === GIT_REF_CHECK_EVENT)) {
      return { result: "already_checked", violations: 0 };
    }
    const facts = this.facts(runId);
    if (!facts) return { result: "skipped", violations: 0 };
    const snapshot = this.leasedSnapshot(runId);
    if (!snapshot && !this.reachedRunning(runId)) {
      // No snapshot and no provider process ever ran (crash or failure between prepare and spawn): nothing to check.
      this.ledger.appendRunEvent({
        runId,
        type: GIT_REF_CHECK_EVENT,
        payload: { v: 1, result: "skipped", reason: "no_snapshot_before_spawn" },
      });
      return { result: "skipped", violations: 0 };
    }
    let violations: ViolationEntry[];
    let current: Map<string, string>;
    try {
      current = await listRefs(facts.repoRoot);
      violations = await this.compare(facts, snapshot, current);
    } catch (err) {
      const entry: ViolationEntry = {
        scope: "guard",
        kind: "check_failed",
        ref: null,
        old: null,
        new: null,
        action: "report",
        detail: errorText(err),
      };
      this.ledger.appendRunEvent({
        runId,
        type: GIT_POLICY_VIOLATION_EVENT,
        payload: { v: 1, violation_count: 1, truncated: false, violations: [entry] },
      });
      this.ledger.appendRunEvent({
        runId,
        type: GIT_REF_CHECK_EVENT,
        payload: { v: 1, result: "failed", reason: entry.detail },
      });
      return { result: "failed", violations: 1 };
    }

    const afterDigest = digestOf([...current.keys()].sort(compare), current);
    if (violations.length === 0) {
      this.ledger.appendRunEvent({
        runId,
        type: GIT_REF_CHECK_EVENT,
        payload: { v: 1, result: "clean", digest_before: snapshot?.digest ?? null, digest_after: afterDigest },
      });
      return { result: "clean", violations: 0 };
    }

    // Intent before effect: the violation (with the planned restores) is recorded before any ref is touched.
    const stored = violations.slice(0, this.limits.maxViolations);
    this.ledger.appendRunEvent({
      runId,
      type: GIT_POLICY_VIOLATION_EVENT,
      payload: {
        v: 1,
        violation_count: violations.length,
        truncated: stored.length < violations.length,
        digest_before: snapshot?.digest ?? null,
        digest_after: afterDigest,
        violations: stored,
      },
    });
    const restored: { scope: string; ref: string; to: string | null; ok: boolean; error?: string }[] = [];
    for (const r of restoresOf(violations)) {
      try {
        await this.restore(facts, r);
        restored.push({ scope: r.scope, ref: r.ref, to: r.to, ok: true });
      } catch (err) {
        restored.push({ scope: r.scope, ref: r.ref, to: r.to, ok: false, error: errorText(err) });
      }
    }
    this.ledger.appendRunEvent({
      runId,
      type: GIT_REF_CHECK_EVENT,
      payload: { v: 1, result: "violation", violation_count: violations.length, restored },
    });
    return { result: "violation", violations: violations.length };
  }

  // ---- internals ----------------------------------------------------------------------------------------------

  private facts(runId: string): RunFacts | undefined {
    const run = this.ledger.getRunRecord(runId);
    if (!run?.worktree_path || !run.branch) return undefined;
    const repoRoot = this.ledger.getMetaSession(run.meta_session_id)?.repo_root;
    if (!repoRoot) return undefined;
    return {
      run,
      repoRoot,
      worktreePath: run.worktree_path,
      runBranchRef: `refs/heads/${run.branch}`,
      publishRef: publishRefFor(run.meta_session_id, this.prefix),
      preCommit: this.ledger.getRunCheckpointCommit(runId, "pre"),
    };
  }

  private leasedSnapshot(runId: string): RefSnapshotV1 | undefined {
    for (const e of this.ledger.listRunEvents(runId)) {
      if (e.type !== GIT_REF_SNAPSHOT_EVENT) continue;
      const p = JSON.parse(e.payload_json) as Partial<RefSnapshotV1>;
      if (p.v === 1 && p.phase === "leased" && Array.isArray(p.refs)) return p as RefSnapshotV1;
    }
    return undefined;
  }

  private reachedRunning(runId: string): boolean {
    return this.ledger.listRunEvents(runId).some((e) => {
      if (e.type !== "state_transition") return false;
      return (JSON.parse(e.payload_json) as { to?: unknown }).to === "RUNNING";
    });
  }

  private async compare(
    facts: RunFacts,
    snapshot: RefSnapshotV1 | undefined,
    current: Map<string, string>,
  ): Promise<ViolationEntry[]> {
    const out: ViolationEntry[] = [];
    const own = new Set([facts.runBranchRef, facts.publishRef]);

    if (!snapshot) {
      out.push({ scope: "guard", kind: "snapshot_missing", ref: null, old: null, new: null, action: "report" });
    } else {
      // Every listed ref, plus every current ref in the listed name range (a new ref sorts somewhere among them).
      const before = new Map(snapshot.refs.map(([n, s]) => [n, s] as const));
      const inRange = (name: string) => !snapshot.truncated || compare(name, snapshot.tail?.after ?? "") <= 0;
      const names = new Set<string>([...before.keys()]);
      for (const name of current.keys()) if (inRange(name)) names.add(name);
      for (const name of [...names].sort(compare)) {
        if (own.has(name)) continue;
        const b = before.get(name);
        const a = current.get(name);
        if (b === a) continue;
        const scope = name.startsWith("refs/heads/switchboard/") ? "switchboard" : "other";
        if (scope === "switchboard" && this.controllerMoved(name, a)) continue;
        out.push(entry(scope, name, b ?? null, a ?? null, "report"));
      }
      if (snapshot.truncated && snapshot.tail) {
        const tail = [...current.keys()].filter((n) => !inRange(n) && !own.has(n)).sort(compare);
        const digest = digestOf(tail, current);
        if (tail.length !== snapshot.tail.count || digest !== snapshot.tail.digest) {
          out.push({
            scope: "unlisted",
            kind: "unlisted_refs_changed",
            ref: null,
            old: snapshot.tail.digest,
            new: digest,
            action: "report",
            detail: `refs after the snapshot limit changed (${snapshot.tail.count} before, ${tail.length} after)`,
          });
        }
      }
      const head = await headState(facts.repoRoot);
      if (head.symref !== snapshot.repo_head.symref || (head.symref === null && head.sha !== snapshot.repo_head.sha)) {
        out.push({
          scope: "repo_head",
          kind: "head_changed",
          ref: "HEAD",
          old: snapshot.repo_head.symref ?? snapshot.repo_head.sha,
          new: head.symref ?? head.sha,
          action: "report",
        });
      }
    }

    // Worktree HEAD must still name the run branch, or the checkpoint would land elsewhere.
    const wtHead = await headState(facts.worktreePath);
    if (wtHead.symref !== facts.runBranchRef) {
      out.push({
        scope: "worktree_head",
        kind: "head_changed",
        ref: "HEAD",
        old: facts.runBranchRef,
        new: wtHead.symref ?? wtHead.sha,
        action: "restore",
        restore_to: facts.runBranchRef,
      });
    }

    // Run branch: only the controller's checkpoint (after this check) moves it.
    const runNow = current.get(facts.runBranchRef) ?? null;
    const runExpected = facts.preCommit ?? snapshot?.run_branch.sha ?? null;
    if (runExpected === null) {
      out.push({
        ...entry("run_branch", facts.runBranchRef, null, runNow, "report"),
        detail: "no pre-run checkpoint recorded",
      });
    } else if (runNow !== runExpected) {
      const foreign = runNow ? await foreignCommits(facts.repoRoot, runNow, [runExpected], new Set()) : undefined;
      out.push({
        ...entry("run_branch", facts.runBranchRef, runExpected, runNow, "restore"),
        restore_to: runExpected,
        ...(foreign ? foreignFields(foreign, this.limits.maxForeignCommits) : {}),
      });
    }

    // Publish ref: only commits the controller built, chained back to the session's base commit.
    const pubBefore = snapshot ? snapshot.publish_ref.sha : undefined;
    const pubNow = current.get(facts.publishRef) ?? null;
    if (pubNow !== pubBefore) {
      const chain = this.publishChain(facts.run.meta_session_id, facts.publishRef);
      // Without a snapshot an absent ref is fine only if the controller never published on it.
      const acceptable =
        pubNow === null ? snapshot === undefined && chain.restoreTarget() === undefined : chain.valid(pubNow);
      if (!acceptable) {
        const target = chain.restoreTarget() ?? pubBefore ?? null;
        const base = this.ledger.getMetaSessionBaseCommit(facts.run.meta_session_id);
        const foreign = pubNow
          ? await foreignCommits(facts.repoRoot, pubNow, [target, base].filter(isString), chain.legit)
          : undefined;
        out.push({
          ...entry("publish_ref", facts.publishRef, pubBefore ?? null, pubNow, "restore"),
          restore_to: target,
          ...(foreign ? foreignFields(foreign, this.limits.maxForeignCommits) : {}),
        });
      }
    }
    return out;
  }

  /** Whether a change to another run's or session's `switchboard/` ref matches what the controller records. */
  private controllerMoved(name: string, after: string | undefined): boolean {
    if (isRunBranchRef(name)) {
      const [, , , sess, runId] = name.split("/");
      const other = runId ? this.ledger.getRunRecord(runId) : undefined;
      if (!other || other.meta_session_id !== sess) return false;
      if (after === undefined) {
        // Deleted: by retention GC (session ARCHIVED) or by a partial-worktree repair while that run is in flight.
        const terminal = other.state === "SUCCEEDED" || other.state === "FAILED" || other.state === "CANCELLED";
        return this.ledger.getMetaSession(other.meta_session_id)?.status === "ARCHIVED" || !terminal;
      }
      return (["base", "pre", "post"] as const).some((k) => this.ledger.getRunCheckpointCommit(other.id, k) === after);
    }
    const pubPrefix = `refs/heads/${this.prefix}`;
    if (name.startsWith(pubPrefix) && after !== undefined) {
      const sess = name.slice(pubPrefix.length);
      if (!this.ledger.getMetaSession(sess)) return false;
      return this.publishChain(sess, name).legit.has(after);
    }
    return false;
  }

  /**
   * Controller-built commits of a meta-session's publish ref, from `git_commit_intent` events that were not aborted
   * (each records the parent the controller chose), and the subset confirmed by a `git_commit` provenance row.
   */
  private publishChain(metaSessionId: string, publishRef: string) {
    const parents = new Map<string, string>();
    const aborted = new Set<string>();
    for (const r of this.ledger.listRunsForMetaSession(metaSessionId)) {
      for (const e of this.ledger.listRunEvents(r.id)) {
        if (e.type !== "git_commit_intent" && e.type !== "git_commit_aborted") continue;
        const p = JSON.parse(e.payload_json) as { commit_sha?: unknown; parent_sha?: unknown; publish_ref?: unknown };
        if (typeof p.commit_sha !== "string") continue;
        if (e.type === "git_commit_aborted") aborted.add(p.commit_sha);
        else if (p.publish_ref === publishRef && typeof p.parent_sha === "string")
          parents.set(p.commit_sha, p.parent_sha);
      }
    }
    for (const sha of aborted) parents.delete(sha);
    const base = this.ledger.getMetaSessionBaseCommit(metaSessionId);
    const legit = new Set(parents.keys());
    const valid = (sha: string): boolean => {
      let cur: string | undefined = sha;
      for (let i = 0; i <= parents.size && cur !== undefined; i++) {
        if (!parents.has(cur)) return cur === base && cur !== sha;
        cur = parents.get(cur);
      }
      return false;
    };
    const recorded = this.ledger
      .listGitCommitsForMetaSession(metaSessionId)
      .filter((row) => row.publish_ref === publishRef)
      .map((row) => row.commit_sha);
    return {
      legit,
      valid,
      /** The newest recorded commit with a valid chain, if any. */
      restoreTarget: (): string | undefined => recorded.filter(valid).at(-1),
    };
  }

  private async restore(facts: RunFacts, r: Restore): Promise<void> {
    if (r.scope === "worktree_head") {
      await git(["symbolic-ref", "HEAD", r.ref], { cwd: facts.worktreePath });
      return;
    }
    const sample = r.to ?? r.from ?? "";
    const zero = "0".repeat(sample.length === 64 ? 64 : 40);
    if (r.to === null) {
      if (r.from !== null) await git(["update-ref", "-d", r.ref, r.from], { cwd: facts.repoRoot });
      return;
    }
    await git(["update-ref", r.ref, r.to, r.from ?? zero], { cwd: facts.repoRoot });
  }
}

// ---- helpers ------------------------------------------------------------------------------------------------------

function entry(
  scope: ViolationScope,
  name: string,
  old: string | null,
  now: string | null,
  action: "restore" | "report",
): ViolationEntry {
  const kind: ViolationKind = old === null ? "created" : now === null ? "deleted" : "moved";
  const long = name.length > MAX_STORED_NAME;
  return {
    scope,
    kind,
    ref: long ? name.slice(0, MAX_STORED_NAME) : name,
    ...(long ? { name_truncated: true as const } : {}),
    old,
    new: now,
    action,
  };
}

function restoresOf(violations: readonly ViolationEntry[]): Restore[] {
  const order: Restore["scope"][] = ["worktree_head", "run_branch", "publish_ref"];
  const out: Restore[] = [];
  for (const scope of order) {
    const v = violations.find((x) => x.scope === scope && x.action === "restore");
    if (!v) continue;
    if (scope === "worktree_head") {
      out.push({ scope, ref: v.restore_to as string, from: null, to: null });
    } else {
      out.push({ scope, ref: v.ref as string, from: v.new, to: v.restore_to ?? null });
    }
  }
  return out;
}

function foreignFields(list: { shas: string[]; count: number }, max: number) {
  return { foreign_commits: list.shas.slice(0, max), foreign_commit_count: list.count };
}

/** Commits reachable from `tip` but not from `exclude`, minus controller-built ones (SHAs only, bounded). */
async function foreignCommits(
  repoRoot: string,
  tip: string,
  exclude: readonly string[],
  controller: ReadonlySet<string>,
): Promise<{ shas: string[]; count: number }> {
  const r = await git(
    ["rev-list", `--max-count=${MAX_COUNTED_COMMITS}`, tip, "--not", ...exclude.filter((x) => x !== tip), "--"],
    { cwd: repoRoot, okCodes: [128] },
  );
  if (r.code !== 0) return { shas: [], count: 0 };
  const shas = r.stdout
    .toString("utf8")
    .split("\n")
    .filter((s) => s !== "" && !controller.has(s));
  return { shas, count: shas.length };
}

/** `for-each-ref` over the repository: every ref name and the object it points at. */
async function listRefs(repoRoot: string): Promise<Map<string, string>> {
  const out = await git(["for-each-ref", "--format=%(objectname) %(refname)"], { cwd: repoRoot });
  const refs = new Map<string, string>();
  for (const line of out.stdout.toString("utf8").split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    refs.set(line.slice(space + 1), line.slice(0, space));
  }
  return refs;
}

async function headState(cwd: string): Promise<HeadState> {
  const sym = await git(["symbolic-ref", "-q", "HEAD"], { cwd, okCodes: [1, 128] });
  const sha = await git(["rev-parse", "-q", "--verify", "HEAD"], { cwd, okCodes: [1, 128] });
  const text = (b: { stdout: Buffer; code: number }) =>
    b.code === 0 ? b.stdout.toString("utf8").trim() || null : null;
  return { symref: text(sym), sha: text(sha) };
}

function digestOf(names: readonly string[], refs: ReadonlyMap<string, string>): string {
  const h = createHash("sha256");
  for (const n of names) h.update(`${refs.get(n) ?? ""} ${n}\n`);
  return h.digest("hex");
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isString(x: string | null | undefined): x is string {
  return typeof x === "string";
}

function errorText(err: unknown): string {
  if (err instanceof GitError)
    return `${err.message}${err.stderr ? `: ${err.stderr.split("\n")[0]}` : ""}`.slice(0, 300);
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
