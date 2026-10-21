import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { PromptSkill } from "../adapters/prompt.js";
import type { NativeSkillLocation } from "../adapters/types.js";
import type { ArtifactStore } from "../artifacts/index.js";
import { isUnderAllowedRoot } from "../config/index.js";
import { defaultIds, type IdGenerator } from "../ids/index.js";
import { insertChainedRunEvent, type TrustProfile } from "../ledger/index.js";
import {
  applyCheckpointGitlinks,
  checkpointSkippedEventPayload,
  checkpointSubmodules,
  SUBMODULE_CHANGES_SKIPPED_EVENT,
  type SubmoduleCheckpointResult,
} from "../submodules/checkpoint.js";
import { SubmoduleError, type SubmoduleReason } from "../submodules/errors.js";
import { attachRecordFile, readAttachRecord } from "../submodules/worktree.js";
import { git, gitText, MIN_GIT_VERSION, parseGitVersion, versionAtLeast } from "./git.js";
import { ensureWorktreeGitLink } from "./git-link.js";
import {
  markNativeDelivered,
  type NativeDeliveryEntry,
  type NativeRemovalResult,
  type NativeSkillFs,
  nativeExcludePathspecs,
  pendingNativeSkills,
  recordedNativePaths,
  removeNativeSkills,
  type SkillRemovalPoint,
  writeNativeSkills,
} from "./native-skills.js";
import { findNestedRepositories, nestedPathspecArgs } from "./nested.js";
import { type SeedEnvironment, type SeedSpec, type SeedStore, seedWorktree } from "./seeds.js";
import {
  attachRunSubmodules,
  detachRunSubmodules,
  resetRunSubmodules,
  type SubmoduleDeps,
  type SubmodulePlan,
} from "./submodules.js";

/**
 * Workspace manager (T1.5; LLD §5, ADR-0006, FR-WS-01..06). Order of every step is intent row, Git action, outcome row.
 * It never pushes, never touches remotes and never modifies the operator's checked-out branch or working tree.
 */

export type WorkspaceErrorCode =
  | "GIT_UNAVAILABLE"
  | "WORKSPACE_NOT_ALLOWED"
  | "NOT_A_GIT_REPO"
  | "LEASE_HELD"
  | "LEASE_STALE"
  | "LEASE_NOT_HELD"
  | "INVALID_ID"
  | "NOT_FOUND"
  | "RESUME_DIRECTORY_UNAVAILABLE"
  | "SUBMODULE_FAILED";

export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Why the worktree path of the run that created a native session cannot host a resume (T5.7, LLD §15.6 step 2;
 * ADR-0038 item 6.4). Every value means: no resume is attempted there and no other directory is used instead.
 * - `outside_session_directory`: the path is not `<dataDir>/worktrees/<sess>/<name>` of this meta-session (FR-WS-08).
 * - `not_a_directory`: the path exists but is a symlink or not a directory.
 * - `not_registered`: `git worktree list` of the meta-session's repository does not list it, or Git run inside it
 *   resolves to another repository or top level.
 * - `locked`: the worktree is locked (`git worktree lock`); Delegated: treated as in use by someone else.
 * - `unclean`: the §5 mutation check against its own `HEAD` finds changes or untracked files.
 * - `unreadable`: a check could not be completed (fail closed, NFR-SEC-06).
 */
export type ResumeDirectoryProblem =
  | "outside_session_directory"
  | "not_a_directory"
  | "not_registered"
  | "locked"
  | "unclean"
  | "unreadable";

export type ResumeDirectoryVerdict =
  | {
      readonly usable: true;
      readonly path: string;
      /** False: the directory is gone and is re-created at the same path from the head checkpoint. */
      readonly exists: boolean;
    }
  | { readonly usable: false; readonly problem: ResumeDirectoryProblem; readonly detail: string };

/** Thrown by `prepare` when the origin worktree fails the LEASED re-check (T5.7); nothing was created or switched. */
export class ResumeDirectoryUnavailableError extends WorkspaceError {
  constructor(
    readonly problem: ResumeDirectoryProblem,
    detail: string,
  ) {
    super("RESUME_DIRECTORY_UNAVAILABLE", `resume directory unavailable (${problem}): ${detail}`);
  }
}

/**
 * ADR-0079 item 3: a run worktree's submodules could not be attached. Carries the library's closed reason, its taxonomy
 * code and the umbrella-relative path (untrusted text, JSON-quoted in the message; never a URL). Nothing stays attached.
 */
export class SubmodulePreparationError extends WorkspaceError {
  constructor(
    readonly reason: SubmoduleReason,
    readonly failureCode: SubmoduleError["code"],
    readonly path: string | undefined,
  ) {
    super(
      "SUBMODULE_FAILED",
      `submodule preparation failed (${reason})${path !== undefined ? ` at ${JSON.stringify(path.slice(0, 300))}` : ""}`,
    );
  }

  static from(err: SubmoduleError): SubmodulePreparationError {
    return new SubmodulePreparationError(err.reason, err.code, err.path);
  }
}

export interface WorkspaceManagerOptions {
  readonly db: Database.Database;
  readonly artifacts: ArtifactStore;
  /** Controller data directory; worktrees live in `<dataDir>/worktrees/<sess>/<run>`. */
  readonly dataDir: string;
  /** Allowed workspace roots (FR-POL-10). Canonicalised here with realpath. */
  readonly allowedRoots: readonly string[];
  readonly ids?: IdGenerator;
  readonly now?: () => Date;
  /**
   * T9.13 (FR-WS-10, LLD §5.1, ADR-0057): dependency seeding of a fresh worktree, after the `pre` checkpoint and before
   * anything else sees it. Absent (`serve` composes it only when a configured project declares a seed): no call, no
   * row, no event, and the worktree is exactly as before. Seeding never fails `prepare`.
   */
  readonly seeding?: {
    readonly store: SeedStore;
    /** The declared seeds and seed environment of a project, or undefined when it declares none. */
    readonly plan: (
      projectId: string,
    ) => { readonly specs: readonly SeedSpec[]; readonly environment: SeedEnvironment } | undefined;
  };
  /**
   * LLD §5.2 (FR-PRJ-02 note, ADR-0067): the base refresh of a meta-session's first worktree, called under the
   * per-repository worktree serialisation when the run has a project and a `baseRef`. Returns the commit to start from,
   * or undefined to keep `baseRef`; a throw is treated as undefined. Absent (`serve` composes it only when a configured
   * project sets `base_remote`): no call, and the base is resolved exactly as before.
   */
  readonly baseRefresh?: (input: BaseRefreshRequest) => Promise<string | undefined>;
  /** T16.6 test seam: the unlink the native-skill cleaner uses (fault injection, TDD §3.16.2 property 5). */
  readonly nativeSkillFs?: NativeSkillFs;
  /**
   * ADR-0079 item 3: submodule worktrees of a recursive context. `plan` gives the run project's primary-context
   * setting, or undefined when it does not set `submodules.mode: "recursive"`. Absent (or no plan): no call, no record,
   * and the worktree is exactly as before.
   */
  readonly submodules?: SubmoduleDeps & { readonly plan: (projectId: string) => SubmodulePlan | undefined };
}

export interface BaseRefreshRequest {
  readonly runId: string;
  readonly metaSessionId: string;
  readonly projectId: string;
  readonly repoRoot: string;
  readonly baseRef: string;
}

export interface PrepareInput {
  readonly metaSessionId: string;
  readonly runId: string;
  readonly workspace: string;
  readonly trustProfile: TrustProfile;
  /** Proposed default 30 minutes; the scheduler passes 2 x the wall-clock timeout (LLD §5). */
  readonly leaseTtlMs?: number;
  /**
   * Project base ref (FR-PRJ-02, T9.2): the first run of a meta-session starts from it instead of `HEAD`. Ignored once
   * the meta-session has a head commit.
   */
  readonly baseRef?: string;
  /**
   * T5.7 (ADR-0038 item 6.1, LLD §15.6 step 2): a native resume whose adapter does not declare `independent` runs in
   * the worktree path of the run that created the native session. The path is re-checked under the per-repository
   * worktree serialisation; a failed check throws {@link ResumeDirectoryUnavailableError} before any Git change. The run
   * still gets its own branch `switchboard/<sess>/<run>` at the head checkpoint, its own `base` and `pre` checkpoints
   * and the lease. Ignored for `inspect-untrusted` (no worktree).
   */
  readonly resumeIn?: { readonly originPath: string };
}

export type PreparedWorkspace =
  | {
      readonly mode: "worktree";
      readonly worktreePath: string;
      readonly branch: string;
      readonly baseCommit: string;
      readonly repoRoot: string;
      readonly baseCheckpointId: string;
      readonly preCheckpointId: string;
    }
  | { readonly mode: "read-only"; readonly path: string };

export interface MutationAssessment {
  readonly mutated: boolean;
  /** Retry per BR-7 is allowed only when nothing changed (ADR-0006). */
  readonly replayEligible: boolean;
  readonly reasons: readonly string[];
  /**
   * Nested repositories (worktree-relative paths) the controller skipped (Q-31, ADR-0022). Non-fatal warning: files
   * inside them are not captured in checkpoints, diffs or commits.
   */
  readonly nestedRepositories: readonly string[];
}

export interface FinalizeResult {
  readonly postCommit: string;
  readonly postCheckpointId: string;
  readonly committed: boolean;
  readonly changedFiles: readonly { status: string; path: string }[];
  readonly diffArtifactId: string;
  readonly changedFilesArtifactId: string;
  /** As `MutationAssessment.nestedRepositories`. */
  readonly nestedRepositories: readonly string[];
}

export interface RollbackResult {
  readonly diffArtifactId: string;
  readonly restoredTo: string;
}

interface RunWorkspace {
  readonly metaSessionId: string;
  /** The meta-session's repository root; null for a row written before it was recorded. */
  readonly repoRoot: string | null;
  readonly worktreePath: string;
  readonly branch: string;
  readonly preCommit: string;
}

const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;
const ID_RE = /^(sess|run)_[0-9A-Za-z]{1,40}$/;
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

/**
 * Worktree creation queue per repository root, shared by every manager in the process. Git takes no lock on
 * `.git/worktrees/` during `git worktree add`: a concurrent add (or prune) that enumerates worktrees can read a sibling
 * whose admin directory exists but whose `commondir` is not yet written, and dies with
 * `fatal: failed to read .git/worktrees/<id>/commondir`. Runs of different meta-sessions on one repository may
 * prepare at once (T9.11), so the repair-and-add step runs one at a time per repository root.
 */
const worktreeCreateQueue = new Map<string, Promise<void>>();

export async function serialisedWorktreeCreate<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const previous = worktreeCreateQueue.get(repoRoot) ?? Promise.resolve();
  let release = () => {};
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  worktreeCreateQueue.set(repoRoot, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (worktreeCreateQueue.get(repoRoot) === tail) worktreeCreateQueue.delete(repoRoot);
  }
}

export class WorkspaceManager {
  private readonly db: Database.Database;
  private readonly ids: IdGenerator;
  private readonly now: () => Date;
  private gitChecked = false;
  private rootsCache: string[] | undefined;

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.db = options.db;
    this.ids = options.ids ?? defaultIds;
    this.now = options.now ?? (() => new Date());
  }

  /** Verify the installed Git meets the documented minimum (TDD §2). */
  async checkGit(): Promise<string> {
    let out: string;
    try {
      out = await gitText(["--version"]);
    } catch {
      throw new WorkspaceError("GIT_UNAVAILABLE", "git is not installed or not runnable");
    }
    const v = parseGitVersion(out);
    if (!v || !versionAtLeast(v, MIN_GIT_VERSION)) {
      throw new WorkspaceError("GIT_UNAVAILABLE", `${out} is older than the required ${MIN_GIT_VERSION.join(".")}`);
    }
    this.gitChecked = true;
    return out;
  }

  /**
   * Acquire the write lease, record the base checkpoint, create the worktree on `switchboard/<sess>/<run>` and record
   * the pre checkpoint. `inspect-untrusted` gets read-only access to the canonical path: no worktree, no lease
   * (FR-WS-06, Proposed: also for Git repos, since it cannot write).
   */
  async prepare(input: PrepareInput): Promise<PreparedWorkspace> {
    assertId(input.metaSessionId);
    assertId(input.runId);
    const canonical = await this.canonicalWorkspace(input.workspace);

    if (input.trustProfile === "inspect-untrusted") return { mode: "read-only", path: canonical };

    if (!this.gitChecked) await this.checkGit();
    const repoRoot = await this.findRepoRoot(canonical);

    this.acquireLease(input.metaSessionId, input.runId, input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
    try {
      const session = this.db
        .prepare("SELECT head_commit, base_commit FROM meta_session WHERE id = ?")
        .get(input.metaSessionId) as { head_commit: string | null; base_commit: string | null } | undefined;
      if (!session) throw new WorkspaceError("NOT_FOUND", `meta-session ${input.metaSessionId} not found`);

      const refreshed = session.head_commit === null ? await this.refreshBase(input, repoRoot) : undefined;
      const baseCommit = await gitText(
        [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${session.head_commit ?? refreshed ?? input.baseRef ?? "HEAD"}^{commit}`,
        ],
        { cwd: repoRoot },
      );
      const branch = `switchboard/${input.metaSessionId}/${input.runId}`;
      const resumeIn = input.resumeIn;
      const worktreePath = resumeIn
        ? path.resolve(resumeIn.originPath)
        : path.join(this.options.dataDir, "worktrees", input.metaSessionId, input.runId);

      // Intent row first, then the Git action, then the outcome row.
      const baseCheckpointId = this.insertCheckpoint(input.metaSessionId, input.runId, "base", baseCommit, branch);
      let reused = false;
      await serialisedWorktreeCreate(repoRoot, async () => {
        if (resumeIn) {
          // T5.7: re-check the origin path here, where no sibling can add or prune a worktree of this repository.
          const verdict = await this.inspectOrigin(input.metaSessionId, repoRoot, worktreePath);
          if (!verdict.usable) throw new ResumeDirectoryUnavailableError(verdict.problem, verdict.detail);
          if (verdict.exists) {
            // Clean against its own HEAD (checked above): start this run's branch at the head checkpoint in place.
            await git(["switch", "--no-guess", "-c", branch, baseCommit], { cwd: worktreePath });
            reused = true;
            return;
          }
          // The directory is gone: re-create it at the same path from the head checkpoint (LLD §15.6 step 2).
        }
        await this.repairPartialWorktree(repoRoot, worktreePath, branch);
        await mkdir(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
        await git(["worktree", "add", "-b", branch, worktreePath, baseCommit], { cwd: repoRoot });
      });
      const head = await gitText(["rev-parse", "HEAD"], { cwd: worktreePath });
      if (head !== baseCommit) throw new WorkspaceError("NOT_FOUND", "new worktree is not at the base commit");
      const plan = this.submodulePlan(input.runId);
      if (plan !== undefined) {
        await this.attachSubmodules(plan.deps, { repoRoot, worktreePath, commit: baseCommit, plan: plan.plan }, reused);
      }
      const preCheckpointId = this.insertCheckpoint(input.metaSessionId, input.runId, "pre", head, branch);

      const now = this.now().toISOString();
      this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE run SET worktree_path = ?, branch = ?, base_checkpoint_id = ?, version = version + 1, updated_at = ? WHERE id = ?",
          )
          .run(worktreePath, branch, baseCheckpointId, now, input.runId);
        this.db
          .prepare(
            `UPDATE meta_session SET repo_root = COALESCE(repo_root, ?), base_commit = COALESCE(base_commit, ?),
               updated_at = ? WHERE id = ?`,
          )
          .run(repoRoot, baseCommit, now, input.metaSessionId);
      })();
      if (this.options.seeding !== undefined) {
        await this.seed(this.options.seeding, input, { worktreePath, baseCommit, repoRoot });
      }

      return { mode: "worktree", worktreePath, branch, baseCommit, repoRoot, baseCheckpointId, preCheckpointId };
    } catch (err) {
      this.releaseLease(input.runId);
      throw err;
    }
  }

  /** LLD §5.2: the refreshed base of a first run, or undefined (no hook, no project or base ref, or a failed hook). */
  private async refreshBase(input: PrepareInput, repoRoot: string): Promise<string | undefined> {
    const hook = this.options.baseRefresh;
    if (hook === undefined || input.baseRef === undefined) return undefined;
    const row = this.db.prepare("SELECT project_id FROM run WHERE id = ?").get(input.runId) as
      | { project_id: string | null }
      | undefined;
    if (!row?.project_id) return undefined;
    const request: BaseRefreshRequest = {
      runId: input.runId,
      metaSessionId: input.metaSessionId,
      projectId: row.project_id,
      repoRoot,
      baseRef: input.baseRef,
    };
    return serialisedWorktreeCreate(repoRoot, () => hook(request)).catch(() => undefined);
  }

  /**
   * T5.7 (LLD §15.6 step 2, read-only): whether `originPath` can host a resume of `metaSessionId`. It must be
   * `<dataDir>/worktrees/<metaSessionId>/<name>` (never another meta-session's path, FR-WS-08), and, if it exists, a
   * real directory that `git worktree list` of the meta-session's repository lists unlocked, that Git inside resolves
   * to that repository and to itself, and that is clean against its own `HEAD`. A missing directory is usable (it is
   * re-created). The lifecycle calls this before admission; `prepare` repeats it under the worktree serialisation.
   */
  async inspectResumeDirectory(metaSessionId: string, originPath: string): Promise<ResumeDirectoryVerdict> {
    assertId(metaSessionId);
    const row = this.db.prepare("SELECT repo_root FROM meta_session WHERE id = ?").get(metaSessionId) as
      | { repo_root: string | null }
      | undefined;
    if (!row?.repo_root) {
      return { usable: false, problem: "not_registered", detail: "the meta-session has no recorded repository" };
    }
    return this.inspectOrigin(metaSessionId, row.repo_root, path.resolve(originPath));
  }

  /** Heartbeat: extend the lease while the supervisor holds the process (LLD §5). */
  extendLease(runId: string, ttlMs: number): void {
    const expires = new Date(this.now().getTime() + ttlMs).toISOString();
    const res = this.db
      .prepare("UPDATE meta_session SET lease_expires_at = ?, version = version + 1 WHERE lease_run_id = ?")
      .run(expires, runId);
    if (res.changes === 0) throw new WorkspaceError("LEASE_NOT_HELD", `run ${runId} does not hold a lease`);
  }

  /** Release the lease held by `runId`; a no-op if it is not the holder. Returns whether a lease was released. */
  releaseLease(runId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE meta_session SET lease_run_id = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ?
         WHERE lease_run_id = ?`,
      )
      .run(this.now().toISOString(), runId);
    return res.changes > 0;
  }

  /**
   * Mutation detection (LLD §5): HEAD != pre, any porcelain status entry (untracked included), or any diff against pre
   * counts as mutated. Anything unreadable also counts as mutated (fail closed, NFR-SEC-06).
   */
  async assessMutation(runId: string): Promise<MutationAssessment> {
    const ws = this.runWorkspace(runId);
    const reasons: string[] = [];
    let nestedRepositories: readonly string[] = [];
    try {
      await stat(ws.worktreePath);
      await this.ensureGitLink(ws);
      const nested = await findNestedRepositories(ws.worktreePath);
      nestedRepositories = nested.paths;
      const scope = this.scanScope(runId, nested);
      const head = await gitText(["rev-parse", "HEAD"], { cwd: ws.worktreePath });
      if (head !== ws.preCommit) reasons.push("HEAD differs from the pre-run checkpoint");
      const status = await git(
        ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all", ...scope],
        { cwd: ws.worktreePath },
      );
      if (status.stdout.length > 0) reasons.push("working tree has changes or untracked files");
      const diff = await git(["diff", "--quiet", "--ignore-submodules=all", ws.preCommit, ...scope], {
        cwd: ws.worktreePath,
        okCodes: [1],
      });
      if (diff.code !== 0) reasons.push("working tree differs from the pre-run checkpoint");
    } catch (err) {
      reasons.push(`worktree unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const mutated = reasons.length > 0;
    return { mutated, replayEligible: !mutated, reasons, nestedRepositories };
  }

  /**
   * Post-run checkpoint (FR-WS-03): stage everything, commit if anything changed, record the `post` checkpoint and store
   * the diff and changed-files artifacts. With `advanceHead: false` (failed runs) the meta-session head is left alone.
   */
  async finalize(runId: string, options: { advanceHead?: boolean } = {}): Promise<FinalizeResult> {
    const ws = this.runWorkspace(runId);
    await this.ensureGitLink(ws);
    const nested = await findNestedRepositories(ws.worktreePath);
    const scope = this.scanScope(runId, nested);
    // ADR-0079 item 3: changed writable submodule worktrees are checkpointed in their stores first; their gitlinks are
    // set in the umbrella index after its own `add -A` (the scan scope excludes the submodule paths).
    const subCheckpoint = await this.checkpointSubmodules(runId, ws.worktreePath);
    await git(["add", "-A", ...scope], { cwd: ws.worktreePath });
    if (subCheckpoint !== undefined) await applyCheckpointGitlinks(ws.worktreePath, subCheckpoint.gitlinks);
    await this.unstageNativeSkills(runId, ws.worktreePath, "HEAD");
    const clean =
      (await git(["diff", "--cached", "--quiet", "HEAD", ...scope], { cwd: ws.worktreePath, okCodes: [1] })).code ===
        0 && (subCheckpoint?.gitlinks.size ?? 0) === 0;
    let committed = false;
    if (!clean) {
      await git(["commit", "--no-verify", "--no-gpg-sign", "-m", `switchboard: checkpoint for ${runId}`], {
        cwd: ws.worktreePath,
      });
      committed = true;
    }
    const postCommit = await gitText(["rev-parse", "HEAD"], { cwd: ws.worktreePath });
    const skippedPayload = subCheckpoint !== undefined ? checkpointSkippedEventPayload(subCheckpoint) : undefined;
    if (skippedPayload !== undefined) {
      insertChainedRunEvent(this.db, {
        id: this.ids.id("evt"),
        runId,
        ts: this.now().toISOString(),
        type: SUBMODULE_CHANGES_SKIPPED_EVENT,
        payloadJson: JSON.stringify(skippedPayload),
      });
    }
    const { diffArtifactId, changedFilesArtifactId, changedFiles } = await this.storeDiff(
      runId,
      ws,
      ws.preCommit,
      postCommit,
      nativeExcludePathspecs(recordedNativePaths(this.db, runId)),
    );
    const postCheckpointId = this.insertCheckpoint(ws.metaSessionId, runId, "post", postCommit, ws.branch);
    const now = this.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE run SET post_checkpoint_id = ?, version = version + 1, updated_at = ? WHERE id = ?")
        .run(postCheckpointId, now, runId);
      if (options.advanceHead ?? true) {
        this.db
          .prepare("UPDATE meta_session SET head_commit = ?, version = version + 1, updated_at = ? WHERE id = ?")
          .run(postCommit, now, ws.metaSessionId);
      }
    })();
    return {
      postCommit,
      postCheckpointId,
      committed,
      changedFiles,
      diffArtifactId,
      changedFilesArtifactId,
      nestedRepositories: nested.paths,
    };
  }

  /**
   * Roll the worktree back to the pre-run checkpoint (FR-WS-04, LLD §5). The failed attempt's diff is stored as an
   * artifact first. `git clean -fd` removes untracked files but keeps ignored ones (Proposed; LLD §5 wording).
   */
  async rollback(runId: string): Promise<RollbackResult> {
    const ws = this.runWorkspace(runId);
    await this.ensureGitLink(ws);
    const scope = this.scanScope(runId, await findNestedRepositories(ws.worktreePath));
    await git(["add", "-A", ...scope], { cwd: ws.worktreePath });
    await this.unstageNativeSkills(runId, ws.worktreePath, "HEAD");
    const diff = await git(["diff", "--cached", "--binary", "--no-ext-diff", "--no-color", ws.preCommit, ...scope], {
      cwd: ws.worktreePath,
    });
    const diffArtifactId = await this.putArtifact(runId, ws.metaSessionId, "diff", "text/x-diff", diff.stdout);
    await git(["reset", "--hard", ws.preCommit], { cwd: ws.worktreePath });
    await git(["clean", "-fd"], { cwd: ws.worktreePath });
    // ADR-0079 item 3: attached submodule worktrees go back to their recorded commits too.
    if (this.options.submodules !== undefined) {
      await resetRunSubmodules(ws.worktreePath, this.options.submodules.sources()?.cloneRoot);
    }
    this.db
      .prepare("UPDATE meta_session SET head_commit = ?, updated_at = ? WHERE id = ? AND head_commit != ?")
      .run(ws.preCommit, this.now().toISOString(), ws.metaSessionId, ws.preCommit);
    return { diffArtifactId, restoredTo: ws.preCommit };
  }

  /**
   * T16.6 (LLD §19.6 step 2): write each skill's native file under `location` in the run's worktree, falling back to the
   * prompt prefix per entry (`path_taken`, `write_failed`). Never throws for an entry; see `./native-skills.ts`.
   */
  async writeNativeSkills(
    runId: string,
    location: NativeSkillLocation,
    skills: readonly PromptSkill[],
  ): Promise<NativeDeliveryEntry[]> {
    const ws = this.runWorkspace(runId);
    return writeNativeSkills({
      db: this.db,
      runId,
      worktreePath: ws.worktreePath,
      baseCommit: ws.preCommit,
      location,
      skills,
    });
  }

  /** T16.6: `delivery = 'native'` and `delivered_at` on the written rows; call inside the dispatch transaction. */
  markNativeDelivered(runId: string, at: string): void {
    markNativeDelivered(this.db, runId, at);
  }

  /** T16.6: whether the run has a recorded native path that is not verified removed (synchronous ledger read). */
  hasPendingNativeSkills(runId: string): boolean {
    return pendingNativeSkills(this.db, runId).length > 0;
  }

  /** T16.6 (LLD §19.8): one idempotent removal pass at `point`; never throws. */
  removeNativeSkills(runId: string, point: SkillRemovalPoint): Promise<NativeRemovalResult> {
    return removeNativeSkills({
      db: this.db,
      runId,
      point,
      ids: this.ids,
      now: this.now,
      ...(this.options.nativeSkillFs ? { fs: this.options.nativeSkillFs } : {}),
    });
  }

  // ---- internals ----------------------------------------------------------------------------------------------

  /**
   * Pathspec arguments for a scan of the worktree: the nested repositories (Q-31) and, T16.6 (LLD §19.8), the run's
   * recorded native skill paths. Empty when there is nothing to exclude, exactly as before.
   */
  private scanScope(runId: string, nested: Awaited<ReturnType<typeof findNestedRepositories>>): string[] {
    const skill = nativeExcludePathspecs(recordedNativePaths(this.db, runId));
    if (skill.length === 0) return nestedPathspecArgs(nested);
    return ["--", ".", ...nested.excludes, ...skill];
  }

  /**
   * T16.6 (LLD §19.8): an agent may have `git add`ed its skill file, and `add -A` with an exclusion does not unstage it.
   * Reset the index entries of the recorded paths to `rev`, so the checkpoint never contains one.
   */
  private async unstageNativeSkills(runId: string, cwd: string, rev: string): Promise<void> {
    const paths = recordedNativePaths(this.db, runId);
    if (paths.length === 0) return;
    await git(["--literal-pathspecs", "reset", "-q", rev, "--", ...paths], { cwd });
  }

  /**
   * ADR-0079 item 3 "Checkpoints", step 1 for a worktree that has an attach record; undefined otherwise (no
   * `project_sources`, no record: nothing is read or run).
   */
  private async checkpointSubmodules(
    runId: string,
    worktreePath: string,
  ): Promise<SubmoduleCheckpointResult | undefined> {
    const cloneRoot = this.options.submodules?.sources()?.cloneRoot;
    if (cloneRoot === undefined) return undefined;
    const record = await readAttachRecord(attachRecordFile(worktreePath), cloneRoot).catch(() => undefined);
    if (record === undefined) return undefined;
    return checkpointSubmodules({
      runId,
      runWorktree: worktreePath,
      record,
      umbrellaHead: await gitText(["rev-parse", "HEAD"], { cwd: worktreePath }),
      skillPaths: recordedNativePaths(this.db, runId),
    });
  }

  /** ADR-0079 item 3: the run project's recursive submodule plan, or undefined (no option, no project, not recursive). */
  private submodulePlan(
    runId: string,
  ): { plan: SubmodulePlan; deps: NonNullable<WorkspaceManagerOptions["submodules"]> } | undefined {
    const deps = this.options.submodules;
    if (deps === undefined) return undefined;
    const row = this.db.prepare("SELECT project_id FROM run WHERE id = ?").get(runId) as
      | { project_id: string | null }
      | undefined;
    if (!row?.project_id) return undefined;
    const plan = deps.plan(row.project_id);
    return plan === undefined ? undefined : { plan, deps };
  }

  /** ADR-0079 item 3: attach (or, in a reused worktree, refresh); a SubmoduleError fails `prepare` with its reason. */
  private async attachSubmodules(
    deps: SubmoduleDeps,
    input: Parameters<typeof attachRunSubmodules>[0],
    reuse: boolean,
  ): Promise<void> {
    try {
      await attachRunSubmodules(input, deps, { reuse });
    } catch (err) {
      if (err instanceof SubmoduleError) throw SubmodulePreparationError.from(err);
      throw new SubmodulePreparationError("SUBMODULE_ATTACH_FAILED", "TOOL_FAILURE", undefined);
    }
  }

  /** T9.13: the run's project seeds, if any (the store records `seed_applied` or `seed_failed`; never throws). */
  private async seed(
    seeding: NonNullable<WorkspaceManagerOptions["seeding"]>,
    input: PrepareInput,
    ws: { worktreePath: string; baseCommit: string; repoRoot: string },
  ): Promise<void> {
    try {
      const row = this.db.prepare("SELECT project_id FROM run WHERE id = ?").get(input.runId) as
        | { project_id: string | null }
        | undefined;
      if (!row?.project_id) return;
      const plan = seeding.plan(row.project_id);
      if (plan === undefined || plan.specs.length === 0) return;
      await seedWorktree(
        seeding.store,
        {
          runId: input.runId,
          projectId: row.project_id,
          profile: input.trustProfile,
          baseCommit: ws.baseCommit,
          repoRoot: ws.repoRoot,
          worktreePath: ws.worktreePath,
          environment: plan.environment,
        },
        plan.specs,
      );
    } catch {
      // Degrade, never fail (ADR-0057 item 6): the run proceeds with an unseeded worktree.
    }
  }

  private async canonicalRoots(): Promise<string[]> {
    if (!this.rootsCache) {
      this.rootsCache = await Promise.all(this.options.allowedRoots.map((r) => realpath(r)));
    }
    return this.rootsCache;
  }

  private async canonicalWorkspace(workspace: string): Promise<string> {
    let canonical: string;
    try {
      canonical = await realpath(workspace);
    } catch {
      throw new WorkspaceError("WORKSPACE_NOT_ALLOWED", `workspace ${workspace} does not exist`);
    }
    if (!isUnderAllowedRoot(canonical, await this.canonicalRoots())) {
      throw new WorkspaceError("WORKSPACE_NOT_ALLOWED", `workspace ${canonical} is not under an allowed root`);
    }
    return canonical;
  }

  /** The Git top level must itself be under an allowed root, otherwise a parent repository would leak in. */
  private async findRepoRoot(canonical: string): Promise<string> {
    let top: string;
    try {
      top = await gitText(["rev-parse", "--show-toplevel"], { cwd: canonical });
    } catch {
      throw new WorkspaceError("NOT_A_GIT_REPO", `${canonical} is not a Git repository (required for write profiles)`);
    }
    const root = await realpath(top);
    if (!isUnderAllowedRoot(root, await this.canonicalRoots())) {
      throw new WorkspaceError("WORKSPACE_NOT_ALLOWED", `repository root ${root} is not under an allowed root`);
    }
    return root;
  }

  private acquireLease(metaSessionId: string, runId: string, ttlMs: number): void {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT lease_run_id, lease_expires_at FROM meta_session WHERE id = ?")
        .get(metaSessionId) as { lease_run_id: string | null; lease_expires_at: string | null } | undefined;
      if (!row) throw new WorkspaceError("NOT_FOUND", `meta-session ${metaSessionId} not found`);
      const nowDate = this.now();
      if (row.lease_run_id !== null && row.lease_run_id !== runId) {
        const expired = row.lease_expires_at !== null && row.lease_expires_at < nowDate.toISOString();
        if (!expired) {
          throw new WorkspaceError("LEASE_HELD", `write lease on ${metaSessionId} is held by ${row.lease_run_id}`);
        }
        // Expired: only takeable when the holder is terminal; otherwise reconciliation must resolve it first (LLD §5).
        const holder = this.db.prepare("SELECT state FROM run WHERE id = ?").get(row.lease_run_id) as
          | { state: string }
          | undefined;
        if (holder && !TERMINAL.has(holder.state)) {
          throw new WorkspaceError(
            "LEASE_STALE",
            `lease holder ${row.lease_run_id} is non-terminal; reconciliation must resolve it`,
          );
        }
      }
      const expires = new Date(nowDate.getTime() + ttlMs).toISOString();
      this.db
        .prepare(
          `UPDATE meta_session SET lease_run_id = ?, lease_expires_at = ?, version = version + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(runId, expires, nowDate.toISOString(), metaSessionId);
      insertChainedRunEvent(this.db, {
        id: this.ids.id("evt"),
        runId,
        ts: nowDate.toISOString(),
        type: "lease",
        payloadJson: JSON.stringify({ action: "acquired", expires }),
      });
    });
    tx.immediate();
  }

  private async inspectOrigin(
    metaSessionId: string,
    repoRoot: string,
    originPath: string,
  ): Promise<ResumeDirectoryVerdict> {
    const no = (problem: ResumeDirectoryProblem, detail: string): ResumeDirectoryVerdict => ({
      usable: false,
      problem,
      detail,
    });
    const sessionDir = path.resolve(this.options.dataDir, "worktrees", metaSessionId);
    if (!path.isAbsolute(originPath) || path.dirname(originPath) !== sessionDir) {
      return no("outside_session_directory", "the path is not a worktree directory of this meta-session");
    }
    let exists = true;
    try {
      const st = await lstat(originPath);
      if (st.isSymbolicLink() || !st.isDirectory()) return no("not_a_directory", "the path is not a plain directory");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return no("unreadable", errorDetail(err));
      exists = false;
    }
    try {
      const target = exists ? await realpath(originPath) : originPath;
      const entries = parseWorktreeList(
        (await git(["worktree", "list", "--porcelain", "-z"], { cwd: repoRoot })).stdout,
      );
      let entry: WorktreeEntry | undefined;
      for (const e of entries.slice(1)) {
        // The first entry is the main worktree; it is never a controller worktree.
        const listed = exists ? await realpath(e.path).catch(() => path.resolve(e.path)) : path.resolve(e.path);
        if (listed === target) entry = e;
      }
      if (entry?.locked) return no("locked", "the worktree is locked");
      if (!exists) return { usable: true, path: originPath, exists: false };
      if (!entry) return no("not_registered", "the repository does not list the path as one of its worktrees");
      // Defence in depth: Git run inside the directory must reach this repository and this top level (a rewritten
      // `.git` file would point it elsewhere).
      const top = await realpath(await gitText(["rev-parse", "--show-toplevel"], { cwd: originPath }));
      const common = await realpath(
        path.resolve(originPath, await gitText(["rev-parse", "--git-common-dir"], { cwd: originPath })),
      );
      const repoCommon = await realpath(
        path.resolve(repoRoot, await gitText(["rev-parse", "--git-common-dir"], { cwd: repoRoot })),
      );
      if (top !== target || common !== repoCommon) {
        return no("not_registered", "Git inside the directory resolves to another repository or top level");
      }
      // §5 mutation check against its own HEAD: any status entry (untracked included) or diff counts as unclean.
      const scope = nestedPathspecArgs(await findNestedRepositories(originPath));
      const status = await git(
        ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all", ...scope],
        { cwd: originPath },
      );
      const diff = await git(["diff", "--quiet", "--ignore-submodules=all", "HEAD", ...scope], {
        cwd: originPath,
        okCodes: [1],
      });
      if (status.stdout.length > 0 || diff.code !== 0) {
        return no("unclean", "the worktree has changes or untracked files against its own HEAD");
      }
      return { usable: true, path: originPath, exists: true };
    } catch (err) {
      return no("unreadable", errorDetail(err));
    }
  }

  /** A `git worktree add` interrupted mid-way leaves a registration or directory: remove and recreate (LLD §5). */
  private async repairPartialWorktree(repoRoot: string, worktreePath: string, branch: string): Promise<void> {
    // ADR-0079 item 3: submodule worktrees an earlier attempt attached are detached first (their stores pruned).
    if (this.options.submodules !== undefined) {
      await detachRunSubmodules(worktreePath, this.options.submodules.sources()?.cloneRoot);
    }
    await git(["worktree", "prune"], { cwd: repoRoot });
    const exists = await stat(worktreePath).then(
      () => true,
      () => false,
    );
    if (exists) await git(["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });
    const hasBranch = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repoRoot,
      okCodes: [1],
    });
    if (hasBranch.code === 0) await git(["branch", "-D", branch], { cwd: repoRoot });
  }

  private insertCheckpoint(
    metaSessionId: string,
    runId: string,
    kind: "base" | "pre" | "post",
    commit: string,
    branch: string,
  ): string {
    const id = this.ids.id("ckp");
    this.db
      .prepare(
        `INSERT INTO workspace_checkpoint (id, meta_session_id, run_id, kind, commit_sha, branch, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, metaSessionId, runId, kind, commit, branch, this.now().toISOString());
    return id;
  }

  /**
   * T10.3 (defence in depth behind the ref guard, which records the violation): controller Git in the worktree runs only
   * through the worktree's own `.git` link to this repository, never one the agent rewrote (`./git-link.ts`).
   */
  private async ensureGitLink(ws: RunWorkspace): Promise<void> {
    if (ws.repoRoot !== null) await ensureWorktreeGitLink(ws.repoRoot, ws.worktreePath);
  }

  private runWorkspace(runId: string): RunWorkspace {
    assertId(runId);
    const run = this.db.prepare("SELECT meta_session_id, worktree_path, branch FROM run WHERE id = ?").get(runId) as
      | { meta_session_id: string; worktree_path: string | null; branch: string | null }
      | undefined;
    if (!run?.worktree_path || !run.branch) throw new WorkspaceError("NOT_FOUND", `run ${runId} has no worktree`);
    const pre = this.db
      .prepare("SELECT commit_sha FROM workspace_checkpoint WHERE run_id = ? AND kind = 'pre'")
      .get(runId) as { commit_sha: string } | undefined;
    if (!pre) throw new WorkspaceError("NOT_FOUND", `run ${runId} has no pre checkpoint`);
    const sess = this.db.prepare("SELECT repo_root FROM meta_session WHERE id = ?").get(run.meta_session_id) as
      | { repo_root: string | null }
      | undefined;
    return {
      metaSessionId: run.meta_session_id,
      repoRoot: sess?.repo_root ?? null,
      worktreePath: run.worktree_path,
      branch: run.branch,
      preCommit: pre.commit_sha,
    };
  }

  private async storeDiff(runId: string, ws: RunWorkspace, pre: string, post: string, excludes: readonly string[]) {
    // T16.6 (LLD §19.8): the checkpoint already leaves recorded native paths out; excluding them here as well keeps the
    // `diff` and `changed_files` artifacts free of them even if a commit did carry one.
    const scope = excludes.length > 0 ? ["--", ".", ...excludes] : [];
    const diff = await git(["diff", "--binary", "--no-ext-diff", "--no-color", "--no-renames", pre, post, ...scope], {
      cwd: ws.worktreePath,
    });
    const names = await git(["diff", "--name-status", "-z", "--no-renames", pre, post, ...scope], {
      cwd: ws.worktreePath,
    });
    const changedFiles = parseNameStatus(names.stdout.toString("utf8"));
    const diffArtifactId = await this.putArtifact(runId, ws.metaSessionId, "diff", "text/x-diff", diff.stdout);
    const changedFilesArtifactId = await this.putArtifact(
      runId,
      ws.metaSessionId,
      "changed_files",
      "application/json",
      Buffer.from(JSON.stringify(changedFiles)),
    );
    return { diffArtifactId, changedFilesArtifactId, changedFiles };
  }

  private async putArtifact(
    runId: string,
    metaSessionId: string,
    kind: "diff" | "changed_files",
    mediaType: string,
    content: Buffer,
  ): Promise<string> {
    const stored = await this.options.artifacts.put(content);
    const id = this.ids.id("art");
    this.db
      .prepare(
        `INSERT INTO artifact (id, run_id, meta_session_id, kind, sha256, size_bytes, media_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, runId, metaSessionId, kind, stored.sha256, stored.sizeBytes, mediaType, this.now().toISOString());
    return id;
  }
}

interface WorktreeEntry {
  readonly path: string;
  readonly locked: boolean;
}

/** Parse `git worktree list --porcelain -z`: NUL-terminated attribute lines, an empty field between entries. */
function parseWorktreeList(raw: Buffer): WorktreeEntry[] {
  const out: { path: string; locked: boolean }[] = [];
  for (const field of raw.toString("utf8").split("\0")) {
    if (field.startsWith("worktree ")) out.push({ path: field.slice("worktree ".length), locked: false });
    else if ((field === "locked" || field.startsWith("locked ")) && out.length > 0) {
      (out[out.length - 1] as { locked: boolean }).locked = true;
    }
  }
  return out;
}

function errorDetail(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

function assertId(id: string): void {
  if (!ID_RE.test(id)) throw new WorkspaceError("INVALID_ID", `invalid identifier: ${id}`);
}

/** Parse `git diff --name-status -z --no-renames` output: `<status>\0<path>\0` pairs. */
export function parseNameStatus(raw: string): { status: string; path: string }[] {
  const parts = raw.split("\0");
  const out: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    out.push({ status: parts[i] as string, path: parts[i + 1] as string });
  }
  return out;
}
