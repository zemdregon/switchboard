import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { ArtifactStore } from "../artifacts/index.js";
import { isUnderAllowedRoot } from "../config/index.js";
import { defaultIds, type IdGenerator } from "../ids/index.js";
import type { TrustProfile } from "../ledger/index.js";
import { git, gitText, MIN_GIT_VERSION, parseGitVersion, versionAtLeast } from "./git.js";
import { findNestedRepositories, nestedPathspecArgs } from "./nested.js";

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
  | "RESUME_DIRECTORY_UNAVAILABLE";

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

export interface WorkspaceManagerOptions {
  readonly db: Database.Database;
  readonly artifacts: ArtifactStore;
  /** Controller data directory; worktrees live in `<dataDir>/worktrees/<sess>/<run>`. */
  readonly dataDir: string;
  /** Allowed workspace roots (FR-POL-10). Canonicalised here with realpath. */
  readonly allowedRoots: readonly string[];
  readonly ids?: IdGenerator;
  readonly now?: () => Date;
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

async function serialisedWorktreeCreate<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
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

      const baseCommit = await gitText(
        ["rev-parse", "--verify", "--end-of-options", `${session.head_commit ?? input.baseRef ?? "HEAD"}^{commit}`],
        { cwd: repoRoot },
      );
      const branch = `switchboard/${input.metaSessionId}/${input.runId}`;
      const resumeIn = input.resumeIn;
      const worktreePath = resumeIn
        ? path.resolve(resumeIn.originPath)
        : path.join(this.options.dataDir, "worktrees", input.metaSessionId, input.runId);

      // Intent row first, then the Git action, then the outcome row.
      const baseCheckpointId = this.insertCheckpoint(input.metaSessionId, input.runId, "base", baseCommit, branch);
      await serialisedWorktreeCreate(repoRoot, async () => {
        if (resumeIn) {
          // T5.7: re-check the origin path here, where no sibling can add or prune a worktree of this repository.
          const verdict = await this.inspectOrigin(input.metaSessionId, repoRoot, worktreePath);
          if (!verdict.usable) throw new ResumeDirectoryUnavailableError(verdict.problem, verdict.detail);
          if (verdict.exists) {
            // Clean against its own HEAD (checked above): start this run's branch at the head checkpoint in place.
            await git(["switch", "--no-guess", "-c", branch, baseCommit], { cwd: worktreePath });
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

      return { mode: "worktree", worktreePath, branch, baseCommit, repoRoot, baseCheckpointId, preCheckpointId };
    } catch (err) {
      this.releaseLease(input.runId);
      throw err;
    }
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
      const nested = await findNestedRepositories(ws.worktreePath);
      nestedRepositories = nested.paths;
      const scope = nestedPathspecArgs(nested);
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
    const nested = await findNestedRepositories(ws.worktreePath);
    const scope = nestedPathspecArgs(nested);
    await git(["add", "-A", ...scope], { cwd: ws.worktreePath });
    const clean =
      (await git(["diff", "--cached", "--quiet", "HEAD", ...scope], { cwd: ws.worktreePath, okCodes: [1] })).code === 0;
    let committed = false;
    if (!clean) {
      await git(["commit", "--no-verify", "--no-gpg-sign", "-m", `switchboard: checkpoint for ${runId}`], {
        cwd: ws.worktreePath,
      });
      committed = true;
    }
    const postCommit = await gitText(["rev-parse", "HEAD"], { cwd: ws.worktreePath });
    const { diffArtifactId, changedFilesArtifactId, changedFiles } = await this.storeDiff(
      runId,
      ws,
      ws.preCommit,
      postCommit,
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
    const scope = nestedPathspecArgs(await findNestedRepositories(ws.worktreePath));
    await git(["add", "-A", ...scope], { cwd: ws.worktreePath });
    const diff = await git(["diff", "--cached", "--binary", "--no-ext-diff", "--no-color", ws.preCommit, ...scope], {
      cwd: ws.worktreePath,
    });
    const diffArtifactId = await this.putArtifact(runId, ws.metaSessionId, "diff", "text/x-diff", diff.stdout);
    await git(["reset", "--hard", ws.preCommit], { cwd: ws.worktreePath });
    await git(["clean", "-fd"], { cwd: ws.worktreePath });
    this.db
      .prepare("UPDATE meta_session SET head_commit = ?, updated_at = ? WHERE id = ? AND head_commit != ?")
      .run(ws.preCommit, this.now().toISOString(), ws.metaSessionId, ws.preCommit);
    return { diffArtifactId, restoredTo: ws.preCommit };
  }

  // ---- internals ----------------------------------------------------------------------------------------------

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
      const seq = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM run_event WHERE run_id = ?")
        .get(runId) as {
        n: number;
      };
      this.db
        .prepare("INSERT INTO run_event (id, run_id, seq, ts, type, payload_json) VALUES (?, ?, ?, ?, 'lease', ?)")
        .run(this.ids.id("evt"), runId, seq.n, nowDate.toISOString(), JSON.stringify({ action: "acquired", expires }));
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
    return {
      metaSessionId: run.meta_session_id,
      worktreePath: run.worktree_path,
      branch: run.branch,
      preCommit: pre.commit_sha,
    };
  }

  private async storeDiff(runId: string, ws: RunWorkspace, pre: string, post: string) {
    const diff = await git(["diff", "--binary", "--no-ext-diff", "--no-color", "--no-renames", pre, post], {
      cwd: ws.worktreePath,
    });
    const names = await git(["diff", "--name-status", "-z", "--no-renames", pre, post], { cwd: ws.worktreePath });
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
