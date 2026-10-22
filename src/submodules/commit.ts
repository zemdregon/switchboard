/**
 * Controller-made submodule commits (ADR-0087 item 4, FR-GIT-14), the part of the commit tool and `finalize_commit`
 * that works inside the attached submodule worktrees of a run. `src/git/commit.ts` drives it; this module never
 * touches the umbrella's publish ref or the ledger's `git_commit` row.
 *
 * 1. {@link resolveSubmoduleParents}: per repository (store key), the parent of its next commit: the meta-session's
 *    latest recorded `submodule_commit` (when its store still has it), else the umbrella parent's gitlink.
 * 2. {@link planSubmoduleCommits}: for each repository in scope, the tree of each writable path's worktree is written
 *    through a temporary index in its store ({@link writeWorktreeTree}: hardened helper, nested repositories and the
 *    run's skill paths excluded, the store's filters and hooks never run). An unchanged tree is skipped. Two paths of
 *    one repository changed to different trees refuse the commit (`submodule_duplicate_diverged`); an unchanged
 *    duplicate is moved to the new commit after the umbrella commit. A changed read-only path (a wiki included) keeps
 *    its gitlink and is reported (`read_only`); a path whose `.git` link does not verify is never used
 *    (`link_invalid`, fail closed).
 * 3. {@link createSubmoduleCommits}: one commit per changed repository with the caller's identity and sanitised message
 *    (signed the same way as the umbrella commit when asked), made in the store, so no agent-controlled `.git` link is
 *    followed.
 * 4. {@link gitlinkIndexInfo}: the `update-index --index-info` lines that put every attached path's gitlink in the
 *    umbrella's temporary index: the new commit for each path of a committed repository (duplicates together), else
 *    the umbrella parent's gitlink, so nothing the agent did to a submodule's `HEAD` reaches the umbrella.
 * 5. {@link updateStoreRefs}: the store's publish ref (`refs/heads/switchboard/pub/<meta-session>`) moves to the new
 *    commit with compare-and-swap against the value read when planning.
 * 6. {@link moveDuplicates}: after the umbrella commit is recorded, unchanged duplicates are reset to the new commit.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { repoSigningConfigUnsafe, signedCommitTree } from "../git/sign.js";
import { git, gitText } from "../workspace/git.js";
import { excludePathspec } from "../workspace/nested.js";
import { isFullSha } from "./errors.js";
import { latestSubmoduleCommit } from "./ledger.js";
import { hasCommit } from "./store.js";
import {
  type AttachedSubmodule,
  type AttachRecord,
  resetSubmodule,
  verifySubmoduleLink,
  writeWorktreeTree,
} from "./worktree.js";

/** Why a changed or named submodule path was not committed (the result's `submodules_skipped`). */
export type SubmoduleSkipReason = "read_only" | "link_invalid" | "commit_missing";

export interface SubmoduleSkip {
  readonly path: string;
  readonly reason: SubmoduleSkipReason;
}

/** Which submodule changes a commit takes. */
export interface SubmoduleScope {
  /** Every attached writable submodule in full; changed read-only ones are reported. */
  readonly all: boolean;
  /** Attached path → submodule-relative literal paths, or `"all"` for the whole submodule (its root was named). */
  readonly explicit: ReadonlyMap<string, readonly string[] | "all">;
}

export interface SubmoduleParent {
  readonly sha: string;
  readonly tree: string;
}

export interface SubmoduleParents {
  /** Attached path → its gitlink in the umbrella parent (absent when the parent has none there). */
  readonly gitlinks: ReadonlyMap<string, string>;
  /** Store key → parent of the repository's next commit (absent when no usable commit is known). */
  readonly byKey: ReadonlyMap<string, SubmoduleParent>;
}

export interface SubmoduleGroupPlan {
  readonly key: string;
  readonly store: string;
  /** Every attached path referencing the repository, sorted; all get the new gitlink. */
  readonly paths: readonly string[];
  /** The paths whose changes make the commit. */
  readonly changedPaths: readonly string[];
  readonly parentSha: string;
  readonly treeSha: string;
  /** Unchanged duplicates whose worktree moves to the new commit once the umbrella commit is recorded. */
  readonly movePaths: readonly string[];
  /** The store's publish ref when planned (undefined: it does not exist yet). */
  readonly refOld: string | undefined;
}

export interface SubmodulePlan {
  readonly groups: readonly SubmoduleGroupPlan[];
  readonly skipped: readonly SubmoduleSkip[];
  readonly parents: SubmoduleParents;
}

export interface MadeSubmoduleCommit {
  readonly key: string;
  readonly store: string;
  readonly paths: readonly string[];
  readonly parentSha: string;
  readonly commitSha: string;
  readonly movePaths: readonly string[];
  readonly refOld: string | undefined;
}

/** Two paths of one repository changed to different trees (`PATH_REFUSED` `submodule_duplicate_diverged`). */
export class SubmoduleDivergedError extends Error {
  override readonly name = "SubmoduleDivergedError";
  constructor(readonly paths: readonly string[]) {
    super("two paths of one submodule repository changed differently");
  }
}

/** The attached entry `rel` (a normalised worktree-relative path) is in, and its submodule-relative rest. */
export function routeSubmodulePath(
  record: AttachRecord,
  rel: string,
): { readonly entry: AttachedSubmodule; readonly sub: string } | undefined {
  for (const entry of record.entries) {
    if (rel === entry.path) return { entry, sub: "" };
    if (rel.startsWith(`${entry.path}/`)) return { entry, sub: rel.slice(entry.path.length + 1) };
  }
  return undefined;
}

/**
 * Step 1: the umbrella parent's gitlinks of every attached path and, per repository, the parent of its next commit.
 * A recorded commit the store no longer has, or a gitlink commit the store does not have, is not usable.
 */
export async function resolveSubmoduleParents(input: {
  readonly db: Database.Database;
  readonly metaSessionId: string;
  readonly record: AttachRecord;
  readonly umbrellaCwd: string;
  readonly umbrellaParent: string;
}): Promise<SubmoduleParents> {
  const gitlinks = await readGitlinks(
    input.umbrellaCwd,
    input.umbrellaParent,
    input.record.entries.map((e) => e.path),
  );
  const byKey = new Map<string, SubmoduleParent>();
  for (const [key, entries] of groupByKey(input.record)) {
    const store = (entries[0] as AttachedSubmodule).store;
    const candidates = [
      latestSubmoduleCommit(input.db, input.metaSessionId, key)?.commit_sha,
      ...entries.map((e) => gitlinks.get(e.path)),
    ];
    for (const sha of candidates) {
      if (sha === undefined || !(await hasCommit(store, sha))) continue;
      const tree = await gitText(["rev-parse", "--verify", "--end-of-options", `${sha}^{tree}`], { cwd: store });
      byKey.set(key, { sha, tree });
      break;
    }
  }
  return { gitlinks, byKey };
}

/**
 * Step 2. Throws {@link SubmoduleDivergedError}; Git failures propagate as `GitError`. `skillPaths` are the run's
 * recorded native skill paths (umbrella-relative): excluded from a full add, restored after an explicit one.
 */
export async function planSubmoduleCommits(input: {
  readonly db: Database.Database;
  readonly metaSessionId: string;
  readonly record: AttachRecord;
  readonly runWorktree: string;
  readonly parents: SubmoduleParents;
  readonly scope: SubmoduleScope;
  readonly skillPaths: readonly string[];
  readonly scratchDir: string;
  readonly publishRef: string;
}): Promise<SubmodulePlan> {
  const groups: SubmoduleGroupPlan[] = [];
  const skipped: SubmoduleSkip[] = [];
  for (const [key, entries] of groupByKey(input.record)) {
    const inScope = (e: AttachedSubmodule): boolean =>
      e.writable && (input.scope.all || input.scope.explicit.has(e.path));
    const reportReadOnly = input.scope.all ? entries.filter((e) => !e.writable) : [];
    if (!entries.some(inScope) && reportReadOnly.length === 0) continue;
    const store = (entries[0] as AttachedSubmodule).store;
    const parent = input.parents.byKey.get(key);
    if (parent === undefined) {
      for (const e of entries) if (inScope(e)) skipped.push({ path: e.path, reason: "commit_missing" });
      continue;
    }
    const trees = new Map<string, string>();
    const full = new Map<string, string>();
    for (const e of entries) {
      if (!(await verifySubmoduleLink(input.runWorktree, e))) {
        if (inScope(e) || reportReadOnly.includes(e)) skipped.push({ path: e.path, reason: "link_invalid" });
        continue;
      }
      const skill = skillPathsUnder(input.skillPaths, e.path);
      const fullTree = await writeWorktreeTree(input.runWorktree, e, parent.sha, {
        excludes: skill.map(excludePathspec),
        scratchDir: input.scratchDir,
      });
      full.set(e.path, fullTree);
      if (!inScope(e)) continue;
      const named = input.scope.all ? "all" : (input.scope.explicit.get(e.path) ?? "all");
      trees.set(
        e.path,
        named === "all"
          ? fullTree
          : await writeWorktreeTree(input.runWorktree, e, parent.sha, {
              paths: named,
              restorePaths: skill,
              scratchDir: input.scratchDir,
            }),
      );
    }
    for (const e of reportReadOnly) {
      const t = full.get(e.path);
      if (t !== undefined && t !== parent.tree) skipped.push({ path: e.path, reason: "read_only" });
    }
    const changed = [...trees].filter(([, t]) => t !== parent.tree);
    if (changed.length === 0) continue;
    const treeSha = (changed[0] as [string, string])[1];
    const diverged = changed.filter(([, t]) => t !== treeSha).map(([p]) => p);
    const movePaths: string[] = [];
    for (const e of entries) {
      if (changed.some(([p]) => p === e.path)) continue;
      const t = full.get(e.path);
      if (t === undefined) continue; // link invalid: never touched
      if (t === treeSha) continue;
      if (t === parent.tree) movePaths.push(e.path);
      else if (e.writable) diverged.push(e.path);
      // a changed read-only duplicate keeps its worktree (reported above)
    }
    if (diverged.length > 0) {
      throw new SubmoduleDivergedError([...new Set([...changed.map(([p]) => p), ...diverged])].sort());
    }
    groups.push({
      key,
      store,
      paths: entries.map((e) => e.path),
      changedPaths: changed.map(([p]) => p),
      parentSha: parent.sha,
      treeSha,
      movePaths,
      refOld: await resolveRef(store, input.publishRef),
    });
  }
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { groups, skipped, parents: input.parents };
}

/** Signing of the submodule commits, as the umbrella commit is signed (`src/git/sign.ts`). */
export interface SubmoduleSigning {
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly scratchDir: string;
}

export type CreateSubmoduleCommitsResult =
  | { readonly ok: true; readonly commits: readonly MadeSubmoduleCommit[] }
  | {
      readonly ok: false;
      readonly reason: "repo_config_unsafe" | "sign_failed" | "timeout" | "signature_missing";
    };

/** Step 3: one commit per planned repository, in its store. Nothing is published here. */
export async function createSubmoduleCommits(
  plan: SubmodulePlan,
  opts: {
    readonly message: string;
    readonly identityEnv: Readonly<Record<string, string>>;
    readonly sign?: SubmoduleSigning;
  },
): Promise<CreateSubmoduleCommitsResult> {
  const commits: MadeSubmoduleCommit[] = [];
  for (const g of plan.groups) {
    let commitSha: string;
    if (opts.sign !== undefined) {
      if (await repoSigningConfigUnsafe(g.store)) return { ok: false, reason: "repo_config_unsafe" };
      const signed = await signedCommitTree({
        cwd: g.store,
        tree: g.treeSha,
        parent: g.parentSha,
        message: opts.message,
        identityEnv: opts.identityEnv,
        sourceEnv: opts.sign.sourceEnv,
        timeoutMs: opts.sign.timeoutMs,
        scratchDir: opts.sign.scratchDir,
      });
      if (!signed.ok) return { ok: false, reason: signed.reason };
      commitSha = signed.sha;
    } else {
      commitSha = (
        await git(["commit-tree", g.treeSha, "-p", g.parentSha, "-F", "-"], {
          cwd: g.store,
          input: opts.message,
          env: opts.identityEnv,
        })
      ).stdout
        .toString("utf8")
        .trim();
    }
    commits.push({
      key: g.key,
      store: g.store,
      paths: g.paths,
      parentSha: g.parentSha,
      commitSha,
      movePaths: g.movePaths,
      refOld: g.refOld,
    });
  }
  return { ok: true, commits };
}

/**
 * Step 4: `update-index --index-info` input for every attached path: the new commit of its repository, else the
 * umbrella parent's gitlink, else a removal (mode 0) when the parent has none there.
 */
export function gitlinkIndexInfo(
  record: AttachRecord,
  parents: SubmoduleParents,
  made: readonly MadeSubmoduleCommit[],
): string {
  const bump = new Map<string, string>();
  for (const m of made) for (const p of m.paths) bump.set(p, m.commitSha);
  let out = "";
  for (const e of record.entries) {
    const sha = bump.get(e.path) ?? parents.gitlinks.get(e.path);
    out += sha !== undefined ? `160000 ${sha}\t${e.path}\n` : `0 ${"0".repeat(e.sha.length)}\t${e.path}\n`;
  }
  return out;
}

/**
 * Step 5: move each store's publish ref to its new commit (compare-and-swap against the planned value). Returns the
 * repositories whose ref had moved since planning (nothing is changed for them); other failures throw.
 */
export async function updateStoreRefs(made: readonly MadeSubmoduleCommit[], publishRef: string): Promise<string[]> {
  const moved: string[] = [];
  for (const m of made) {
    const zero = "0".repeat(m.commitSha.length);
    const r = await git(["update-ref", publishRef, m.commitSha, m.refOld ?? zero], { cwd: m.store, okCodes: [1, 128] });
    if (r.code !== 0) {
      if ((await resolveRef(m.store, publishRef)) !== m.refOld) moved.push(m.key);
      else throw new Error(`update-ref failed in the store of ${m.key}`);
    }
  }
  return moved;
}

/** Step 6 (best effort): reset unchanged duplicates to the new commit. Returns the paths that could not be moved. */
export async function moveDuplicates(runWorktree: string, made: readonly MadeSubmoduleCommit[]): Promise<string[]> {
  const failed: string[] = [];
  for (const m of made) {
    for (const p of m.movePaths) {
      try {
        await resetSubmodule(runWorktree, { path: p, store: m.store }, m.commitSha);
      } catch {
        failed.push(p);
      }
    }
  }
  return failed;
}

/** The canonical run worktree path of a submodule (after {@link verifySubmoduleLink}). */
export async function submoduleCwd(runWorktree: string, entry: AttachedSubmodule): Promise<string | undefined> {
  if (!(await verifySubmoduleLink(runWorktree, entry))) return undefined;
  return path.join(await realpath(runWorktree), entry.path);
}

// ---- helpers ----------------------------------------------------------------------------------------------------

function groupByKey(record: AttachRecord): Map<string, AttachedSubmodule[]> {
  const byKey = new Map<string, AttachedSubmodule[]>();
  for (const e of [...record.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const list = byKey.get(e.key) ?? [];
    list.push(e);
    byKey.set(e.key, list);
  }
  return byKey;
}

/** Submodule-relative forms of the skill paths below `subPath`. */
function skillPathsUnder(skillPaths: readonly string[], subPath: string): string[] {
  return skillPaths.filter((p) => p.startsWith(`${subPath}/`)).map((p) => p.slice(subPath.length + 1));
}

/** Gitlinks (mode 160000) of `paths` in `commit`. */
async function readGitlinks(cwd: string, commit: string, paths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const CHUNK = 256;
  for (let i = 0; i < paths.length; i += CHUNK) {
    const r = await git(
      ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", commit, "--", ...paths.slice(i, i + CHUNK)],
      { cwd },
    );
    for (const rec of r.stdout.toString("utf8").split("\0")) {
      if (rec === "") continue;
      const tab = rec.indexOf("\t");
      const [mode, , sha] = rec.slice(0, tab).split(" ");
      if (mode === "160000" && sha !== undefined && isFullSha(sha)) out.set(rec.slice(tab + 1), sha);
    }
  }
  return out;
}

async function resolveRef(cwd: string, ref: string): Promise<string | undefined> {
  const r = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], {
    cwd,
    okCodes: [1],
  });
  const sha = r.stdout.toString("utf8").trim();
  return r.code === 0 && sha !== "" ? sha : undefined;
}
