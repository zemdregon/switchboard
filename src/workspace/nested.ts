import { readdir } from "node:fs/promises";

/**
 * Nested-repository guard (Q-31, R-35, TDD §3.4, ADR-0022). A run worktree can contain a directory with its own `.git`
 * (a directory, a gitdir-pointer file or a symlink). If a controller `status`, `diff` or `add -A` enters it, Git starts
 * a child `git status` that reads the nested repository's own configuration and attributes, so its filter and diff
 * drivers can run (reproduced on Git 2.43; the controller's `-c` overrides only cover keys configured in the parent).
 * The controller therefore finds such directories itself, without running Git and without following symlinks, and
 * excludes them from every operation that scans the worktree. The consequence is stated plainly: files inside a nested
 * repository are not captured in checkpoints, diffs or commits.
 *
 * ADR-0087 item 4 narrows this for the declared submodules of a context with `submodules.mode: "recursive"`: the
 * workspace manager attaches them as linked worktrees of their stores, and they are found here like any nested
 * repository, so the umbrella's own `status`, `diff` and `add -A` still never enter them. {@link partitionNested} tells
 * them apart from the nested repositories an agent created (ADR-0022 unchanged for those, and for every submodule of a
 * context without that mode): the controller commits inside an attached submodule through its store and sets the
 * umbrella's gitlink itself (`update-index --cacheinfo 160000,<sha>,<path>`), so an explicit commit path inside one is
 * routed there instead of refused as a nested repository.
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

/**
 * ADR-0087 item 4: split a scan into the attached declared submodule worktrees (a nested path equal to one of
 * `attached`, the paths of the run's attach record) and every other nested repository. Both stay excluded from the
 * umbrella's scans; only the caller's routing differs. A path inside an attached submodule is not reported by the scan
 * at all (it stops at the submodule's `.git`), so nested repositories in a submodule are the submodule commit's concern.
 */
export function partitionNested(
  nested: NestedRepositories,
  attached: readonly string[],
): { readonly submodules: readonly string[]; readonly others: NestedRepositories } {
  const declared = new Set(attached);
  const submodules: string[] = [];
  const paths: string[] = [];
  const excludes: string[] = [];
  nested.paths.forEach((p, i) => {
    if (declared.has(p)) submodules.push(p);
    else {
      paths.push(p);
      excludes.push(nested.excludes[i] ?? excludePathspec(p));
    }
  });
  return { submodules, others: { paths, excludes } };
}
