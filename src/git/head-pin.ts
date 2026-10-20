/**
 * Head pin for verification evidence (T8.10; FR-EXE-10, LLD §20.6). Before the verification stage the controller reads
 * the commit the run stands on and computes the worktree's tree with a temporary index (`GIT_INDEX_FILE` in a fresh
 * private directory outside the worktree), so the run's own index, `HEAD` and refs are never touched. The commit is kept
 * as `head_sha` only when the worktree tree equals that commit's tree; otherwise the result records no SHA.
 *
 * Delegated reading (not owner-approved), recorded in LLD §20.6: in a Switchboard worktree the commit tool moves the
 * run's publish ref, not the worktree's `HEAD` (LLD §12.3), so "HEAD" is the publish ref's commit when that ref exists
 * and the worktree's `HEAD` otherwise. The tree is built like a commit-tool `commit` with no path list (`add -A`,
 * nested repositories excluded), so a clean worktree after a commit-tool commit pins exactly the published commit.
 *
 * Fail closed: any Git error gives no SHA (and no tree when the tree could not be written). It never throws and never
 * fails the run; the verification result is then simply not pinned.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git, gitText } from "../workspace/git.js";
import { findNestedRepositories, nestedPathspecArgs } from "../workspace/nested.js";

export interface HeadPin {
  /** The commit the worktree's tree equals; null when the trees differ or Git could not be read. */
  readonly headSha: string | null;
  /** The worktree's tree as a commit would record it; null when it could not be computed. */
  readonly treeSha: string | null;
}

/** The publish ref's commit when the ref exists, else the worktree's `HEAD`; undefined when neither resolves. */
async function pinCandidate(worktree: string, publishRef: string): Promise<string | undefined> {
  const published = await git(["rev-parse", "--verify", "-q", "--end-of-options", `${publishRef}^{commit}`], {
    cwd: worktree,
    okCodes: [1],
  });
  const sha = published.stdout.toString("utf8").trim();
  if (published.code === 0 && sha !== "") return sha;
  const head = await gitText(["rev-parse", "--verify", "-q", "--end-of-options", "HEAD^{commit}"], { cwd: worktree });
  return head === "" ? undefined : head;
}

/** Compute the run's head pin (see the module comment). `scratch` defaults to the OS temporary directory. */
export async function readHeadPin(worktree: string, publishRef: string, scratch: string = tmpdir()): Promise<HeadPin> {
  let candidate: string | undefined;
  let treeSha: string | null = null;
  try {
    candidate = await pinCandidate(worktree, publishRef);
    const tmp = await mkdtemp(path.join(scratch, "sb-pin-"));
    try {
      const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
      if (candidate !== undefined) await git(["read-tree", candidate], { cwd: worktree, env });
      const nested = await findNestedRepositories(worktree);
      await git(["add", "-A", "--", ".", ...nestedPathspecArgs(nested).slice(2)], { cwd: worktree, env });
      treeSha = await gitText(["write-tree"], { cwd: worktree, env });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    if (candidate === undefined) return { headSha: null, treeSha };
    const headTree = await gitText(["rev-parse", "--verify", "--end-of-options", `${candidate}^{tree}`], {
      cwd: worktree,
    });
    return { headSha: headTree === treeSha ? candidate : null, treeSha };
  } catch {
    return { headSha: null, treeSha };
  }
}
