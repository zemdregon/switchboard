/**
 * Provider configuration and credential directories (Q-62, Q-64; FR-AUTH-01, NFR-SEC-01, ADR-0039). A provider's
 * sandbox or permission mode is not a credential boundary: on Ampere 2026-10-14 `grok` 1.0.50 listed `~/.grok` and
 * `test -r` its login file from inside `--sandbox strict` and `workspace`
 * ([live-checks-2026-10-14-grok.md](../../docs/research/live-checks-2026-10-14-grok.md) step 11). Switchboard therefore
 * keeps these directories out of reach by itself: a run's working directory may not contain or sit inside one
 * ({@link workspaceReachesProviderState}), and a tool call that names a path under one is a violation
 * ({@link commandReachesProviderState}), whatever the provider's own policy says.
 *
 * The list is the home-relative directories the research notes and the operator's AGENTS.md name for the providers in
 * the registry. It is not exhaustive (a provider can keep state elsewhere, e.g. under XDG directories; Assumption: an
 * entry is added when a live check names the path), and it never reads, lists or opens any of them.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { splitSimpleCommands } from "../adapters/git-write.js";

/** Home-relative provider state directories, with the provider that owns each (source: research notes 2026-10-14). */
export const PROVIDER_STATE_DIRS: readonly { readonly dir: string; readonly provider: string }[] = [
  { dir: ".claude", provider: "claude" },
  { dir: ".codex", provider: "codex" },
  { dir: ".grok", provider: "grok" },
  { dir: ".cursor", provider: "cursor" },
  { dir: ".gemini", provider: "antigravity" },
  { dir: ".opencode", provider: "opencode" },
];

/** Absolute provider state directories for `home` (default: the process's home directory). */
export function providerStateRoots(home: string = homedir()): string[] {
  return PROVIDER_STATE_DIRS.map((d) => join(home, d.dir));
}

const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Why a run in `cwd` could reach a provider state directory, or `undefined`: `cwd` is inside one, or contains one (a
 * worktree or project root that is the home directory or an ancestor of it exposes `~/.grok` to a provider that may
 * read its whole working tree). Lexical on resolved paths; symlinks are not followed (Assumption).
 */
export function workspaceReachesProviderState(cwd: string, home: string = homedir()): string | undefined {
  const abs = resolve(cwd);
  for (const root of providerStateRoots(home)) {
    if (within(abs, root)) return `working directory is inside ${root}`;
    if (within(root, abs)) return `working directory ${abs} contains ${root}`;
  }
  return undefined;
}

function expandHome(word: string, home: string): string | undefined {
  if (word === "~" || word.startsWith("~/")) return join(home, word.slice(1));
  for (const p of ["$HOME", `\${HOME}`]) {
    if (word === p || word.startsWith(`${p}/`)) return join(home, word.slice(p.length));
  }
  if (word.includes("$") || word.includes("`")) return undefined;
  return word;
}

/**
 * The provider state directory a path or shell command line names, or `undefined`. Each word (and the value of a
 * `--flag=value` or `VAR=value` word) is expanded for `~`, `$HOME` and `${HOME}`, resolved against `cwd` when relative
 * and compared with {@link providerStateRoots}. Words with other variables or substitutions are not resolved
 * (lexical limit; a glob or a script can still reach a directory, which only a filesystem boundary stops).
 */
export function commandReachesProviderState(command: string, opts: { cwd: string; home?: string }): string | undefined {
  const home = opts.home ?? homedir();
  const roots = providerStateRoots(home);
  for (const words of splitSimpleCommands(command)) {
    for (const raw of words) {
      const candidates = [raw, raw.slice(raw.indexOf("=") + 1)].filter((w) => w !== "");
      for (const c of candidates) {
        const expanded = expandHome(c, home);
        if (expanded === undefined) continue;
        const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(opts.cwd, expanded);
        const hit = roots.find((r) => within(abs, r));
        if (hit !== undefined) return hit;
      }
    }
  }
  return undefined;
}

/** {@link commandReachesProviderState} for a single path (a file tool's target). */
export function pathReachesProviderState(path: string, opts: { cwd: string; home?: string }): string | undefined {
  const home = opts.home ?? homedir();
  const expanded = expandHome(path, home);
  if (expanded === undefined) return undefined;
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(opts.cwd, expanded);
  return providerStateRoots(home).find((r) => within(abs, r));
}
