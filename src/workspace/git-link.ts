import { lstat, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gitText } from "./git.js";

/**
 * The run worktree's `.git` link (T10.3; FR-GIT-01, FR-GIT-03, FR-WS-05). A linked worktree's `.git` is a small file,
 * `gitdir: <common dir>/worktrees/<name>`, inside the worktree, so the agent can rewrite it: in a `container`
 * environment the worktree is the one writable mount, and in a `host` environment it is the agent's own directory.
 * Every controller Git command in the worktree (the ref check's worktree `HEAD`, the checkpoint's `add -A` and
 * `commit`, rollback's `reset --hard`) discovers its repository through that file, so a link the agent pointed at the
 * main repository's Git directory would make the controller itself commit to, or reset, the operator's checked-out
 * branch; a `.git` directory the agent made would make it record the agent's own history.
 *
 * The expected link is derived from the host side only: the main repository's `worktrees/<name>/gitdir` entry whose
 * recorded path is this worktree's `.git`. The agent cannot change that entry from a container (the Git directory is
 * not mounted, FR-PRJ-05). Anything else at `<worktree>/.git` (another target, a directory, a symlink, nothing) is
 * replaced by the expected file before controller Git runs there. A worktree directory that is gone is left gone.
 */

export type WorktreeGitLinkState =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly found: "missing" | "file" | "directory" | "symlink" | "other";
      readonly adminDir: string;
    }
  | { readonly ok: "no_worktree" };

/** Throws when the repository lists no worktree entry for `worktreePath` (fail closed: nothing to restore to). */
export async function inspectWorktreeGitLink(repoRoot: string, worktreePath: string): Promise<WorktreeGitLinkState> {
  const wt = await lstat(worktreePath).catch(() => undefined);
  if (!wt?.isDirectory()) return { ok: "no_worktree" };
  const adminDir = await worktreeAdminDir(repoRoot, worktreePath);
  const link = path.join(worktreePath, ".git");
  const st = await lstat(link).catch(() => undefined);
  if (!st) return { ok: false, found: "missing", adminDir };
  if (st.isSymbolicLink()) return { ok: false, found: "symlink", adminDir };
  if (st.isDirectory()) return { ok: false, found: "directory", adminDir };
  if (!st.isFile()) return { ok: false, found: "other", adminDir };
  const m = /^gitdir: (.+?)\r?\n?$/.exec(await readFile(link, "utf8"));
  const target = m?.[1];
  if (target === undefined) return { ok: false, found: "file", adminDir };
  const resolved = await realpath(path.resolve(worktreePath, target)).catch(() => undefined);
  return resolved === adminDir ? { ok: true } : { ok: false, found: "file", adminDir };
}

/** Puts the expected `.git` file back (never following a symlink there). */
export async function restoreWorktreeGitLink(worktreePath: string, adminDir: string): Promise<void> {
  const link = path.join(worktreePath, ".git");
  await rm(link, { recursive: true, force: true });
  await writeFile(link, `gitdir: ${adminDir}\n`, { flag: "wx" });
}

/** Inspects and, when needed, restores; returns what was found (`ok: true` / `no_worktree`: nothing was changed). */
export async function ensureWorktreeGitLink(repoRoot: string, worktreePath: string): Promise<WorktreeGitLinkState> {
  const state = await inspectWorktreeGitLink(repoRoot, worktreePath);
  if (state.ok === false) await restoreWorktreeGitLink(worktreePath, state.adminDir);
  return state;
}

async function worktreeAdminDir(repoRoot: string, worktreePath: string): Promise<string> {
  const common = await realpath(
    path.resolve(repoRoot, await gitText(["rev-parse", "--git-common-dir"], { cwd: repoRoot })),
  );
  const want = path.join(await realpath(worktreePath), ".git");
  const base = path.join(common, "worktrees");
  for (const name of await readdir(base).catch(() => [] as string[])) {
    const recorded = await readFile(path.join(base, name, "gitdir"), "utf8").catch(() => undefined);
    if (recorded === undefined) continue;
    const p = path.resolve(base, name, recorded.trim());
    const canonical = path.join(await realpath(path.dirname(p)).catch(() => path.dirname(p)), path.basename(p));
    if (canonical === want) return path.join(base, name);
  }
  throw new Error(`the repository lists no worktree at ${worktreePath}`);
}
