/**
 * Git write operations an agent must never be able to perform (FR-GIT-01, ADR-0014 decision 1): creating commits,
 * creating, moving or deleting refs, and pushing. Shared by every adapter (deny rules, shell allowlist validation) and
 * by the argv tests.
 *
 * The lists are Proposed (Delegated, 2026-10-12) and are a lexical check of one command, split on spaces. They are not a
 * sandbox and cannot see through Git aliases defined in the operator's configuration, scripts run by an allowlisted
 * build tool (`npm test`, `make`), or anything else a command executes at runtime. Detection (FR-GIT-03, M9) and keeping
 * credentials out of the agent's environment (FR-GIT-06) back them up.
 */

/**
 * Git subcommands that create commits, create, move or delete refs (including HEAD and remote-tracking refs), push, or
 * change Git configuration (which can define aliases or hooks that do any of these). Deny rules are compiled from this
 * list; a shell allowlist entry using any of them is refused.
 */
export const GIT_WRITE_SUBCOMMANDS: readonly string[] = [
  // create commits (most also move the current branch)
  "commit",
  "commit-tree",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "am",
  "pull",
  "stash",
  "notes",
  "filter-branch",
  "fast-import",
  // create, move or delete refs
  "branch",
  "tag",
  "update-ref",
  "symbolic-ref",
  "reset",
  "checkout",
  "switch",
  "worktree",
  "bisect",
  "replace",
  "fetch",
  "remote",
  "submodule",
  // publish
  "push",
  "send-pack",
  "svn",
  // configuration that can turn any later command into a write (aliases, hooks path, identity)
  "config",
];

/**
 * Git subcommands accepted in a shell allowlist entry (Proposed). Everything else is refused, so unknown subcommands,
 * Git aliases and external `git-<name>` programs fail closed. Subcommands that list in one form and write in another
 * (`branch`, `tag`, `stash`, `remote`, `worktree`, `notes`) are deliberately absent.
 */
export const GIT_READ_ONLY_SUBCOMMANDS: readonly string[] = [
  "status",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "log",
  "show",
  "shortlog",
  "blame",
  "grep",
  "ls-files",
  "ls-tree",
  "cat-file",
  "rev-parse",
  "rev-list",
  "describe",
  "merge-base",
  "name-rev",
  "for-each-ref",
  "show-ref",
  "count-objects",
  "version",
];

/** Options of read-only subcommands that run another program (`git grep -O<cmd>`). Refused in allowlist entries. */
const GIT_EXEC_OPTIONS = /^(-O|--open-files-in-pager)/;

/** Other programs that publish to a Git host. `gh` can push branches and create tags and releases. */
export const GIT_PUBLISHING_PROGRAMS: readonly string[] = ["gh"];

/**
 * Programs that run another command given as their arguments (Proposed), so `env git commit` or `xargs git push` would
 * hide a Git write from the subcommand check. An allowlist entry starting with one of them is refused.
 */
export const COMMAND_LAUNCHERS: readonly string[] = [
  "env",
  "command",
  "exec",
  "eval",
  "nice",
  "nohup",
  "timeout",
  "time",
  "xargs",
  "sudo",
  "doas",
  "su",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "busybox",
];

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/**
 * Why one shell command (as a shell allowlist entry: plain words separated by spaces) could perform a Git write, or
 * `undefined` if the lexical check finds no way. Fails closed: Git global options before the subcommand (`-C`, `-c`,
 * `--git-dir`, ...), unknown subcommands and command launchers all count as able to write.
 */
export function gitWriteRisk(command: string): string | undefined {
  const words = command.trim().split(/\s+/).filter(Boolean);
  const program = basename(words[0] ?? "");
  if (program === "") return undefined;
  if (COMMAND_LAUNCHERS.includes(program)) return `\`${program}\` runs arbitrary commands, including git`;
  if (GIT_PUBLISHING_PROGRAMS.includes(program)) return `\`${program}\` can push to a Git host`;
  if (program !== "git" && !program.startsWith("git-")) return undefined;
  if (program.startsWith("git-")) return `\`${program}\` is a git subprogram outside the read-only set`;
  const sub = words[1];
  if (sub === undefined) return undefined; // bare `git` prints usage
  if (sub.startsWith("-")) return `git global option \`${sub}\` can redirect or reconfigure git`;
  if (GIT_WRITE_SUBCOMMANDS.includes(sub)) return `\`git ${sub}\` can create commits, change refs or push`;
  if (!GIT_READ_ONLY_SUBCOMMANDS.includes(sub)) return `\`git ${sub}\` is not a known read-only git subcommand`;
  const exec = words.slice(2).find((w) => GIT_EXEC_OPTIONS.test(w));
  if (exec !== undefined) return `\`git ${sub} ${exec}\` runs another program`;
  return undefined;
}

/** Every command in `commands` that could perform a Git write, with the reason. Used by adapters and argv tests. */
export function gitWriteRisks(commands: readonly string[]): Array<{ command: string; reason: string }> {
  const out: Array<{ command: string; reason: string }> = [];
  for (const command of commands) {
    const reason = gitWriteRisk(command);
    if (reason !== undefined) out.push({ command, reason });
  }
  return out;
}
