/**
 * The submodule manifest of one umbrella commit (ADR-0080 item 2, G10). The controller never runs `git submodule` and
 * never lets Git follow a `.gitmodules` URL: it reads the gitlinks (`git ls-tree -r -z --full-tree`, mode `160000`) and
 * the `.gitmodules` blob of the commit (`git config --blob <commit>:.gitmodules --no-includes -z --list`) itself,
 * through the hardened local helper (scrubbed environment, no hooks, no drivers, no network), and checks every used
 * URL against the effective `project_sources`.
 *
 * Rules:
 * - Only `submodule.<name>.path` and `submodule.<name>.url` are read; `update`, `branch`, `fetchRecurseSubmodules`,
 *   `ignore`, `shallow` and every other key are never followed. `include` / `includeIf` are not read (`--no-includes`).
 * - Every gitlink that is not excluded must be declared by exactly one entry whose `path` equals the gitlink path
 *   (`SUBMODULE_UNDECLARED`). An entry without a gitlink is ignored (its URL is not checked).
 * - **Delegated** (fail closed): every declared `path` value is checked for safety even when no gitlink uses it, so a
 *   `.gitmodules` that names `../escape` is refused (`SUBMODULE_PATH_UNSAFE`) rather than silently ignored; an entry
 *   with more than one `path` value is refused the same way, and a used entry with zero or several `url` values is
 *   `SUBMODULE_URL_INVALID`.
 * - An excluded path (an `exclude` entry equal to the path or an ancestor directory of it) is dropped entirely: no
 *   declaration or URL check.
 * - A URL is `https://<host>/<owner>/<repo>[.git]` by {@link parseRepositoryUrl}, or `../<repo>[.git]` resolved against
 *   `umbrella` (same host and owner); anything else (another scheme, scp-like, `ext::`, credentials, `../../x`, a
 *   relative URL with no umbrella source) is `SUBMODULE_URL_INVALID`. Host exact and owner case-insensitive in the live
 *   `sources()` (`SUBMODULE_SOURCE_NOT_ALLOWED`).
 * - Bound: {@link MAX_SUBMODULES} gitlinks and {@link MAX_SUBMODULES} `.gitmodules` sections
 *   (`SUBMODULE_MANIFEST_TOO_LARGE`).
 * - A wiki (repository name ending in `.wiki`, case-insensitive) is never writable.
 */
import type { ProjectSourcesSettings } from "../config/index.js";
import { parseRepositoryUrl, type RepositorySource, sourceAllowed, sourceKey } from "../projects/clone.js";
import { git, gitText } from "../workspace/git.js";
import { isSafeSubmodulePath, MAX_SUBMODULES, SubmoduleError } from "./errors.js";

export interface ManifestOptions {
  /** Live getter of the effective `project_sources` (a source grant takes effect without a restart). */
  readonly sources: () => ProjectSourcesSettings;
  /** The umbrella's own source, to resolve `../<repo>[.git]`; without it a relative URL is refused. */
  readonly umbrella?: RepositorySource;
  /** Worktree-relative paths (or ancestor directories) whose gitlinks are ignored. */
  readonly exclude: readonly string[];
  /** Worktree-relative submodule paths the controller may commit in, or exactly `["*"]` for every non-wiki path. */
  readonly writable: readonly string[];
}

export interface SubmoduleEntry {
  /** Umbrella-relative POSIX path of the gitlink. */
  readonly path: string;
  /** The `.gitmodules` section name (untrusted text; never used as a file name). */
  readonly name: string;
  /** The gitlink commit in the umbrella commit. */
  readonly sha: string;
  readonly source: RepositorySource;
  /** {@link sourceKey}: `host/owner/repo` lower case; duplicate-URL paths share it (and one store). */
  readonly key: string;
  readonly wiki: boolean;
  /** Listed in `writable` (or `["*"]`) and not a wiki. */
  readonly writable: boolean;
}

export interface SubmoduleManifest {
  /** The resolved umbrella commit. */
  readonly commit: string;
  /** Sorted by path. */
  readonly entries: readonly SubmoduleEntry[];
  /** Entries per {@link SubmoduleEntry.key}, in path order. */
  readonly byKey: ReadonlyMap<string, readonly SubmoduleEntry[]>;
  /** Paths of entries that are not writable (wikis included), sorted. */
  readonly readOnlyPaths: readonly string[];
}

const GITLINK_MODE = "160000";

/**
 * Read and check the manifest of `commit` in the repository at `repoRoot`. Throws {@link SubmoduleError}; never runs a
 * network operation.
 */
export async function readSubmoduleManifest(
  repoRoot: string,
  commit: string,
  opts: ManifestOptions,
): Promise<SubmoduleManifest> {
  const { sha, gitlinks, gitmodules } = await readRaw(repoRoot, commit);
  if (gitlinks.length > MAX_SUBMODULES) throw new SubmoduleError("SUBMODULE_MANIFEST_TOO_LARGE");

  const excluded = (p: string) => opts.exclude.some((e) => p === e || p.startsWith(`${e}/`));
  const used = gitlinks.filter((l) => !excluded(l.path));
  for (const l of used)
    if (!isSafeSubmodulePath(l.path)) throw new SubmoduleError("SUBMODULE_PATH_UNSAFE", { path: l.path });

  const sections = gitmodules === undefined ? new Map<string, Section>() : parseGitmodules(gitmodules);
  if (sections.size > MAX_SUBMODULES) throw new SubmoduleError("SUBMODULE_MANIFEST_TOO_LARGE");
  const byPath = new Map<string, { name: string; section: Section }[]>();
  for (const [name, section] of sections) {
    if (section.paths.length === 0) continue;
    const p = section.paths[0] as string;
    if (excluded(p)) continue;
    if (section.paths.length > 1 || !isSafeSubmodulePath(p))
      throw new SubmoduleError("SUBMODULE_PATH_UNSAFE", { path: p });
    const list = byPath.get(p) ?? [];
    list.push({ name, section });
    byPath.set(p, list);
  }

  const settings = opts.sources();
  const allWritable = opts.writable.length === 1 && opts.writable[0] === "*";
  const entries: SubmoduleEntry[] = [];
  for (const link of used) {
    const decl = byPath.get(link.path);
    if (decl === undefined || decl.length !== 1) throw new SubmoduleError("SUBMODULE_UNDECLARED", { path: link.path });
    const { name, section } = decl[0] as { name: string; section: Section };
    if (section.urls.length !== 1) throw new SubmoduleError("SUBMODULE_URL_INVALID", { path: link.path });
    const source = resolveSubmoduleUrl(section.urls[0] as string, opts.umbrella);
    if (source === undefined) throw new SubmoduleError("SUBMODULE_URL_INVALID", { path: link.path });
    if (!sourceAllowed(source, settings)) throw new SubmoduleError("SUBMODULE_SOURCE_NOT_ALLOWED", { path: link.path });
    const wiki = source.repo.toLowerCase().endsWith(".wiki");
    const listed = allWritable || opts.writable.includes(link.path);
    entries.push({
      path: link.path,
      name,
      sha: link.sha,
      source,
      key: sourceKey(source),
      wiki,
      writable: listed && !wiki,
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byKey = new Map<string, SubmoduleEntry[]>();
  for (const e of entries) {
    const list = byKey.get(e.key) ?? [];
    list.push(e);
    byKey.set(e.key, list);
  }
  return {
    commit: sha,
    entries,
    byKey,
    readOnlyPaths: entries.filter((e) => !e.writable).map((e) => e.path),
  };
}

/**
 * Resolve one `.gitmodules` URL: an absolute ADR-0068 URL, or `../<repo>[.git]` against `umbrella`. Pure; no
 * allowlist. Undefined for anything else.
 */
export function resolveSubmoduleUrl(
  text: string,
  umbrella: RepositorySource | undefined,
): RepositorySource | undefined {
  if (text.startsWith("../")) {
    if (umbrella === undefined) return undefined;
    const rest = text.slice(3);
    if (rest === "" || rest.includes("/") || rest.includes("\\")) return undefined;
    return parseRepositoryUrl(`https://${umbrella.host}/${umbrella.owner}/${rest}`);
  }
  return parseRepositoryUrl(text);
}

interface Section {
  paths: string[];
  urls: string[];
}

interface Gitlink {
  readonly path: string;
  readonly sha: string;
}

async function readRaw(
  repoRoot: string,
  commit: string,
): Promise<{ sha: string; gitlinks: Gitlink[]; gitmodules: Buffer | undefined }> {
  try {
    if (commit === "" || commit.startsWith("-")) throw new SubmoduleError("SUBMODULE_MANIFEST_UNREADABLE");
    const sha = await gitText(["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`], { cwd: repoRoot });
    const tree = (await git(["ls-tree", "-r", "-z", "--full-tree", sha], { cwd: repoRoot })).stdout.toString("utf8");
    const gitlinks: Gitlink[] = [];
    let gitmodulesMode: string | undefined;
    for (const rec of tree.split("\0")) {
      if (rec === "") continue;
      const tab = rec.indexOf("\t");
      const [mode, , objectId] = rec.slice(0, tab).split(" ");
      const p = rec.slice(tab + 1);
      if (mode === GITLINK_MODE) gitlinks.push({ path: p, sha: objectId as string });
      else if (p === ".gitmodules") gitmodulesMode = mode;
    }
    if (gitmodulesMode === undefined) return { sha, gitlinks, gitmodules: undefined };
    // Git itself refuses a symbolic-link `.gitmodules`; so does the controller.
    if (gitmodulesMode !== "100644" && gitmodulesMode !== "100755") {
      throw new SubmoduleError("SUBMODULE_MANIFEST_UNREADABLE");
    }
    const cfg = await git(["config", "--blob", `${sha}:.gitmodules`, "--no-includes", "-z", "--list"], {
      cwd: repoRoot,
    });
    return { sha, gitlinks, gitmodules: cfg.stdout };
  } catch (err) {
    if (err instanceof SubmoduleError) throw err;
    throw new SubmoduleError("SUBMODULE_MANIFEST_UNREADABLE");
  }
}

/** `git config -z --list` output: `key\nvalue\0` (or `key\0` for a key without a value). Only path and url. */
function parseGitmodules(raw: Buffer): Map<string, Section> {
  const sections = new Map<string, Section>();
  for (const rec of raw.toString("utf8").split("\0")) {
    if (rec === "") continue;
    const nl = rec.indexOf("\n");
    const key = nl === -1 ? rec : rec.slice(0, nl);
    const value = nl === -1 ? undefined : rec.slice(nl + 1);
    // Section and variable names are lower case in Git's output; the subsection (the name) keeps its case and may
    // contain dots, so the variable is after the last dot.
    if (!key.startsWith("submodule.")) continue;
    const dot = key.lastIndexOf(".");
    if (dot <= "submodule.".length - 1) continue;
    const name = key.slice("submodule.".length, dot);
    const variable = key.slice(dot + 1);
    if (name === "") continue;
    const s = sections.get(name) ?? { paths: [], urls: [] };
    sections.set(name, s);
    if (sections.size > MAX_SUBMODULES) throw new SubmoduleError("SUBMODULE_MANIFEST_TOO_LARGE");
    // A key without a value is boolean `true` in Git; for path and url it is unusable: kept as "" so it is refused.
    if (variable === "path") s.paths.push(value ?? "");
    else if (variable === "url") s.urls.push(value ?? "");
  }
  return sections;
}
