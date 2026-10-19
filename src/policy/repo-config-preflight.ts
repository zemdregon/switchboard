/**
 * Repository-configuration preflight (FR-POL-11, LLD §20.10, T3.25). Before a run starts, a bounded walk of the
 * working directory lists the agent-readable configuration a provider CLI may act on, as `{path, kind}` entries for the
 * run's policy snapshot. It never opens, reads or hashes a file: `readdir` with file types (no symlink follow; a
 * symlink is listed by name and never descended) is the only filesystem call. The walk is a record and, in an approved
 * bypass run, a warning (owner decisions 26 and 77); it refuses nothing. The FR-POL-04 refusal for the untrusted
 * profiles stays in `repo-agent-config.ts`, unchanged.
 *
 * Caps (Linus decision, WORK QUEUE v10, Assumption): paths of at most 4 segments, 200 entries, 5,000 directory entries
 * visited; hitting any cap sets `truncated`. `.git/` and `node_modules/` are never entered.
 */
import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";

export type RepoConfigKind =
  | "claude_config"
  | "mcp_config"
  | "cursor_config"
  | "vscode_tasks"
  | "envrc"
  | "env_file"
  | "provider_config";

export interface RepoConfigEntry {
  /** Relative to the working directory, `/`-separated. */
  path: string;
  kind: RepoConfigKind;
  /** Present (true) only when the entry is a symbolic link; its target is neither read nor followed. */
  symlink?: true;
}

export interface RepoConfigSeen {
  entries: RepoConfigEntry[];
  truncated: boolean;
}

export const REPO_CONFIG_MAX_DEPTH = 4;
export const REPO_CONFIG_MAX_ENTRIES = 200;
export const REPO_CONFIG_MAX_VISITED = 5_000;
const SKIPPED_DIRS: ReadonlySet<string> = new Set([".git", "node_modules"]);

/**
 * Provider project configuration files that can set a provider base-URL override (FR-POL-11), by `<dir>/<name>` or a
 * bare name. Assumption: a file is listed because the provider documents or a live check showed it as project config
 * able to name a model endpoint; its contents are not read, so the list says "may set", never "sets". `.claude/` and
 * the `.env*` files (which can set `*_BASE_URL` variables) have their own kinds.
 */
const PROVIDER_CONFIG_PATHS: ReadonlySet<string> = new Set([
  ".codex/config.toml",
  ".grok/config.toml",
  ".gemini/settings.json",
  "opencode.json",
  "opencode.jsonc",
]);

/** The kind of `name` (inside directory `parent`, `""` at the root), or undefined when it is not listed. */
export function repoConfigKind(parent: string, name: string): RepoConfigKind | undefined {
  if (name === ".claude") return "claude_config";
  if (name === ".mcp.json") return "mcp_config";
  if (name === ".cursor") return "cursor_config";
  if (name === "tasks.json" && parent === ".vscode") return "vscode_tasks";
  if (name === ".envrc") return "envrc";
  if (name === ".env" || name.startsWith(".env.")) return "env_file";
  if (PROVIDER_CONFIG_PATHS.has(name) || PROVIDER_CONFIG_PATHS.has(`${parent}/${name}`)) return "provider_config";
  return undefined;
}

/**
 * Walks `cwd` breadth-first in name order. A listed directory (`.claude/`, `.cursor/`) is recorded once and not
 * entered. A directory that cannot be read is skipped (the record is informational; FR-POL-04 is the control).
 */
export function scanRepoConfig(cwd: string): RepoConfigSeen {
  const entries: RepoConfigEntry[] = [];
  let truncated = false;
  let visited = 0;
  const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
  while (queue.length > 0) {
    const dir = queue.shift() as { rel: string; depth: number };
    let dirents: Dirent[];
    try {
      dirents = readdirSync(dir.rel === "" ? cwd : join(cwd, dir.rel), { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const parent = dir.rel.split("/").pop() ?? "";
    for (const d of dirents) {
      if (visited >= REPO_CONFIG_MAX_VISITED) return { entries, truncated: true };
      visited++;
      const rel = dir.rel === "" ? d.name : `${dir.rel}/${d.name}`;
      const kind = repoConfigKind(parent, d.name);
      if (kind !== undefined) {
        if (entries.length >= REPO_CONFIG_MAX_ENTRIES) return { entries, truncated: true };
        entries.push({ path: rel, kind, ...(d.isSymbolicLink() ? { symlink: true as const } : {}) });
        if (kind === "claude_config" || kind === "cursor_config") continue;
      }
      if (!d.isDirectory() || SKIPPED_DIRS.has(d.name)) continue;
      if (dir.depth + 1 >= REPO_CONFIG_MAX_DEPTH) {
        truncated = true;
        continue;
      }
      queue.push({ rel, depth: dir.depth + 1 });
    }
  }
  return { entries, truncated };
}
