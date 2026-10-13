import { readdir } from "node:fs/promises";

/**
 * Nested-repository guard (Q-31, R-35, TDD §3.4, ADR-0022). A run worktree can contain a directory with its own `.git`
 * (a directory, a gitdir-pointer file or a symlink). If a controller `status`, `diff` or `add -A` enters it, Git starts
 * a child `git status` that reads the nested repository's own configuration and attributes, so its filter and diff
 * drivers can run (reproduced on Git 2.43; the controller's `-c` overrides only cover keys configured in the parent).
 * The controller therefore finds such directories itself, without running Git and without following symlinks, and
 * excludes them from every operation that scans the worktree. The consequence is stated plainly: files inside a nested
 * repository are not captured in checkpoints, diffs or commits.
 */

const GIT_ENTRY = ".git";
const SEP = Buffer.from("/");

/** Result of one scan: nested repository roots as worktree-relative POSIX paths, sorted, plus the Git pathspecs. */
export interface NestedRepositories {
  readonly paths: readonly string[];
  /** `:(exclude,top,...)` pathspecs, one per nested path, to append after `--`. */
  readonly excludes: readonly string[];
}

/**
 * Find every directory below `root` (not `root` itself) that contains a `.git` entry of any kind. A `.git` symlink,
 * file or directory all count (fail closed). Symlinked directories are never descended. A nested repository is not
 * searched further: the whole subtree is excluded. Unreadable directories are skipped (Git cannot enter them either).
 */
export async function findNestedRepositories(root: string): Promise<NestedRepositories> {
  // Paths are walked as Buffers so a name that is not valid UTF-8 still reads back; only the reported path is decoded.
  const rootBuf = Buffer.from(root);
  const gitName = Buffer.from(GIT_ENTRY);
  const found: string[] = [];
  const stack: Buffer[] = [Buffer.alloc(0)];
  while (stack.length > 0) {
    const rel = stack.pop() as Buffer;
    let entries: { name: Buffer | string; isDirectory(): boolean }[];
    try {
      entries = await readdir(rel.length === 0 ? rootBuf : Buffer.concat([rootBuf, SEP, rel]), {
        withFileTypes: true,
        encoding: "buffer",
      });
    } catch {
      continue;
    }
    const names = entries.map((e) => (Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name)));
    if (rel.length > 0 && names.some((n) => n.equals(gitName))) {
      found.push(rel.toString("utf8"));
      continue;
    }
    entries.forEach((e, i) => {
      const name = names[i] as Buffer;
      if (e.isDirectory() && !name.equals(gitName))
        stack.push(rel.length === 0 ? name : Buffer.concat([rel, SEP, name]));
    });
  }
  found.sort();
  return { paths: found, excludes: found.map(excludePathspec) };
}

/**
 * Pathspec that excludes `rel` (relative to the worktree top level) and everything below it. A path made only of
 * ordinary characters uses `literal`; otherwise `glob` with `*`, `?`, `[` and `\` escaped, and each run of U+FFFD (a
 * name that is not valid UTF-8 cannot be passed in argv) widened to `*`, which over-excludes within that one path
 * component and never fails the run. A pathspec cannot carry a NUL, and a file name cannot contain one.
 */
export function excludePathspec(rel: string): string {
  if (!rel.includes("�")) return `:(exclude,top,literal)${rel}`;
  const pattern = rel
    .split(/�+/)
    .map((part) => part.replace(/[\\*?[]/g, "\\$&"))
    .join("*");
  return `:(exclude,top,glob)${pattern}`;
}

/** Git arguments that exclude the nested repositories: `-- . <excludes>` (empty when there are none). */
export function nestedPathspecArgs(nested: NestedRepositories): string[] {
  return nested.excludes.length === 0 ? [] : ["--", ".", ...nested.excludes];
}
