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
  // rewrite or delete refs, reflogs and objects (R-43; each verified to change a throwaway repository on Git 2.43.0)
  "reflog",
  "pack-refs",
  "gc",
  "prune",
  "maintenance",
  "repack",
  "hash-object",
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
 * Git global options (before the subcommand) that take a value, as `--opt value` or `--opt=value` (`-C` and `-c` only
 * the first). R-43: the Git 2.43.0 usage text lists them; `--namespace`, `--config-env`, `--exec-path` and
 * `--attr-source` each ran `git branch` or `update-ref` successfully in a throwaway repository, so none of them stops a
 * write. Deny rules are compiled for every spelling.
 */
export const GIT_GLOBAL_OPTIONS_WITH_VALUE: readonly string[] = [
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--exec-path",
  "--attr-source",
];

/**
 * Git global options without a value. R-43: on Git 2.43.0 `git <option> branch t` created a ref for every one of these
 * except `--bare`, which fails from a work tree but changes how the repository is found (it works from inside a Git
 * directory or with `GIT_DIR`), so it is denied as well. `--super-prefix` is internal and rejected by Git 2.43.0.
 */
export const GIT_GLOBAL_FLAGS: readonly string[] = [
  "--no-pager",
  "-P",
  "-p",
  "--paginate",
  "--no-optional-locks",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-replace-objects",
  "--bare",
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

/**
 * ADR-0094: Git subcommands that only download or read in some forms, allowed in an approved privileged bypass run when
 * {@link gitBypassReadVerdict} admits the exact form. `git pull` is not here: it moves the run branch, which only the
 * controller's checkpoint may move (finalize commit model), so it stays denied ({@link GIT_BYPASS_LOCAL_SUBCOMMANDS}).
 */
export const GIT_BYPASS_READ_SUBCOMMANDS: readonly string[] = ["fetch", "ls-remote", "remote"];

/** `git fetch` options without a value that download without touching local branches (Git 2.43.0 `git fetch -h`). */
const FETCH_FLAGS = new Set([
  "--all",
  "--multiple",
  "-p",
  "--prune",
  "-t",
  "--tags",
  "-n",
  "--no-tags",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "--dry-run",
  "--progress",
  "--no-progress",
  "--unshallow",
  "--update-shallow",
  "--no-recurse-submodules",
  "--recurse-submodules",
  "--write-fetch-head",
  "--no-write-fetch-head",
  "--atomic",
  "-4",
  "--ipv4",
  "-6",
  "--ipv6",
  "--show-forced-updates",
  "--no-show-forced-updates",
  "--porcelain",
  "--no-auto-gc",
  "--no-auto-maintenance",
]);
/** `git fetch` options with a value (`--depth 1` or `--depth=1`; `--recurse-submodules` only inline). */
const FETCH_VALUE_OPTIONS = new Set([
  "--depth",
  "--deepen",
  "--shallow-since",
  "--shallow-exclude",
  "-j",
  "--jobs",
  "--filter",
  "--server-option",
  "-o",
  "--negotiation-tip",
  "--recurse-submodules",
]);
/**
 * A repository argument: a configured remote or group name, a local path, an `https`, `http`, `ssh` or `git` URL, or
 * the scp-like `user@host:path`. Anything else (another transport such as `ext::`, a dynamic word) is refused.
 */
const FETCH_REPOSITORY =
  /^([A-Za-z0-9._/~-]+|(https?|ssh|git):\/\/[A-Za-z0-9._~:/@%+-]+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+)$/;
/** A refspec source without a destination, a force `+` or a pattern: it updates only `FETCH_HEAD` and tracking refs. */
const FETCH_REFSPEC = /^[A-Za-z0-9._/-]+$/;
/** `git ls-remote` options that run another program. */
const LS_REMOTE_EXEC = /^(-u|--upload-pack)/;
/** `git remote` forms that only read or download (Git 2.43.0 `git remote -h`); every other form changes a remote. */
const REMOTE_READ_FORMS = new Set(["show", "get-url", "update"]);

/**
 * ADR-0094: `undefined` when `git <sub> <args>` (sub in {@link GIT_BYPASS_READ_SUBCOMMANDS}) only downloads objects
 * into the repository, updates `FETCH_HEAD`, remote-tracking refs (`refs/remotes/`) or new tags, or reads; otherwise a
 * `write` verdict. Fails closed: an unknown option, a refspec with a destination (`main:main`), a force `+`, a pattern,
 * `--refmap`, `--prune-tags`, `--update-head-ok`, `--set-upstream`, `--prefetch`, `--force`, `--upload-pack`, a
 * transport other than a plain name, path or `https`/`http`/`ssh`/`git` URL, or a `git remote` form that adds, removes,
 * renames or reconfigures a remote.
 */
export function gitBypassReadVerdict(sub: string, args: readonly string[]): GitCommandVerdict | undefined {
  const write = (reason: string): GitCommandVerdict => ({ level: "write", reason });
  if (sub === "ls-remote") {
    const exec = args.find((w) => LS_REMOTE_EXEC.test(w));
    return exec === undefined ? undefined : write(`\`git ls-remote ${exec.split("=", 1)[0]}\` runs another program`);
  }
  if (sub === "remote") {
    const at = args.findIndex((w) => !w.startsWith("-"));
    if (at === -1) {
      return args.every((w) => w === "-v" || w === "--verbose")
        ? undefined
        : write("`git remote` option changes a remote");
    }
    const form = args[at] as string;
    if (!REMOTE_READ_FORMS.has(form) || args.slice(0, at).some((w) => w !== "-v" && w !== "--verbose")) {
      return write(`\`git remote ${form}\` changes a remote`);
    }
    const options = form === "update" ? ["-p", "--prune"] : ["-n", "--push", "--all"];
    const bad = args.slice(at + 1).find((w) => (w.startsWith("-") ? !options.includes(w) : !FETCH_REFSPEC.test(w)));
    return bad === undefined ? undefined : write(`\`git remote ${form} ${bad}\` is not a plain read`);
  }
  let positional = 0;
  const plain = (w: string) => (positional++ === 0 ? FETCH_REPOSITORY : FETCH_REFSPEC).test(w);
  for (let i = 0; i < args.length; i++) {
    const w = args[i] as string;
    if (w === "--") {
      const bad = args.slice(i + 1).find((p) => !plain(p));
      return bad === undefined ? undefined : write(`\`git fetch\` argument \`${bad}\` is not a plain remote or branch`);
    }
    if (w.startsWith("-") && w !== "-") {
      const [name, inline] = w.split(/=(.*)/s, 2) as [string, string | undefined];
      if (FETCH_FLAGS.has(w) || /^-j[0-9]+$/.test(w)) continue;
      if (FETCH_VALUE_OPTIONS.has(name)) {
        if (inline === undefined && name !== "--recurse-submodules") i++;
        continue;
      }
      return write(`\`git fetch ${name}\` can update a local branch, tag or configuration, or run a program`);
    }
    if (!plain(w)) return write(`\`git fetch\` argument \`${w}\` is not a plain remote or branch`);
  }
  return undefined;
}

/**
 * ADR-0094: Git verbs whose ref effects stay on the run's own checkout (the current branch, which is the run branch, and
 * the worktree `HEAD`), `local` rather than `write` in an approved bypass run when {@link gitBypassLocalVerdict} admits
 * the form. A provider's Git deny rules still refuse them where it compiles any (Claude Code); where one runs, the
 * FR-GIT-03 ref check of that bypass run puts the run branch and `HEAD` back without a violation, so the agent's
 * commits become working-tree content of the controller's checkpoint and finalize commit and never enter its history.
 * Verbs that create, move or delete any other ref (`branch`, `tag`, `stash`, `switch`, `checkout <branch>`, `rebase`,
 * `update-ref`, ...) stay `write`.
 */
export const GIT_BYPASS_LOCAL_SUBCOMMANDS: readonly string[] = [
  "commit",
  "merge",
  "cherry-pick",
  "revert",
  "reset",
  "pull",
  "checkout",
];

/** Arguments that keep a {@link GIT_BYPASS_LOCAL_SUBCOMMANDS} verb a `write`: they run a program or write elsewhere. */
const BYPASS_LOCAL_RISKY_ARGS = /^(-O|--open-files-in-pager|--output|--exec|-x$|--upload-pack|--receive-pack)/;
/** `git pull` options that can update a local branch other than the current one, or configuration. */
const PULL_RISKY_OPTIONS = /^(-f$|--force|--refmap|--update-head-ok|--set-upstream|--prune-tags|--prefetch)/;

/**
 * ADR-0094: the verdict of a {@link GIT_BYPASS_LOCAL_SUBCOMMANDS} verb in an approved bypass run: `local`, or `write`
 * when an argument runs a program or writes elsewhere ({@link BYPASS_LOCAL_RISKY_ARGS}); `git checkout` only in its
 * path form (`git checkout -- <path>`, `git checkout <commit> -- <path>`) with no `-b`/`-B` (any other checkout may move
 * `HEAD` to, or create, another branch, which the next commit would write); `git pull` only with a plain repository and
 * plain branch names (no `:` destination, no `+`) and without {@link PULL_RISKY_OPTIONS}.
 */
function gitBypassLocalVerdict(sub: string, args: readonly string[]): GitCommandVerdict {
  const write = (reason: string): GitCommandVerdict => ({ level: "write", reason });
  const risky = args.find((w) => BYPASS_LOCAL_RISKY_ARGS.test(w));
  if (risky !== undefined) return write(`\`git ${sub} ${risky.split("=", 1)[0]}\` runs a program or writes elsewhere`);
  if (sub === "checkout") {
    const sep = args.indexOf("--");
    if (sep === -1 || args.slice(0, sep).some((w) => /^-[bB]|^--orphan|^--ignore-other-worktrees/.test(w))) {
      return write("`git checkout` of a branch can move HEAD to, or create, another branch");
    }
  }
  if (sub === "pull") {
    const bad = args.find((w) => PULL_RISKY_OPTIONS.test(w));
    if (bad !== undefined) return write(`\`git pull ${bad.split("=", 1)[0]}\` can update another ref or configuration`);
    const positional = args.filter((w) => !w.startsWith("-"));
    if (positional.some((w, k) => !(k === 0 ? FETCH_REPOSITORY : FETCH_REFSPEC).test(w))) {
      return write("`git pull` with a refspec destination or a transport can update a local branch");
    }
  }
  return { level: "local", reason: `\`git ${sub}\` changes the run's own checkout; the ref check puts it back` };
}

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

/**
 * How sure {@link gitWriteInCommand} is: `write` names a known write path, `uncertain` is fail-closed doubt. `local`
 * (ADR-0094, bypass mode only) is a verb whose ref effects stay on the run's own checkout (`git commit`, `git reset`,
 * `git pull`, `git checkout -- <path>`, ...): the provider's Git deny rules still refuse it where compiled and the
 * FR-GIT-03 ref check puts the run branch back, but the attempt alone does not fail an approved bypass run.
 */
export interface GitCommandVerdict {
  readonly level: "write" | "local" | "uncertain";
  readonly reason: string;
}

/** Options of {@link gitWriteInCommand}. */
export interface GitCommandCheckOptions {
  /**
   * ADR-0094: the run is an approved privileged bypass run (`bypassPermitted`). Git commands that only download or
   * read ({@link gitBypassReadVerdict}) are then not writes, and local verbs ({@link GIT_BYPASS_LOCAL_SUBCOMMANDS}) are
   * `local`, not `write`.
   */
  readonly bypass?: boolean;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "busybox"]);
/** Launchers whose own options and positional prefix (`timeout 5`, `nice -n 5`) precede the command they run. */
const PREFIX_LAUNCHERS = new Set([
  "env",
  "command",
  "exec",
  "nice",
  "nohup",
  "timeout",
  "time",
  "xargs",
  "sudo",
  "doas",
  "setsid",
  "stdbuf",
  "ionice",
  "chroot",
  "flock",
  "script",
]);
/** `git -c <key>=...` keys that make a read-only subcommand run a program or define a command. */
const RISKY_GIT_CONFIG =
  /^(alias\.|core\.(fsmonitor|hookspath|sshcommand|pager|editor|askpass)|credential\.|include|url\.|gpg\.|diff\..*\.(command|textconv)|filter\.)/i;
const RISKY_GIT_ENV =
  /^GIT_(CONFIG|EXEC_PATH|SSH|ASKPASS|EDITOR|PAGER|EXTERNAL_DIFF|PROXY_COMMAND|DIR$|WORK_TREE$|COMMON_DIR$|OBJECT_DIRECTORY|ALTERNATE)/;

/**
 * Split one command string into simple commands (arrays of words): shell quoting, backslash escapes, and the
 * separators `; & | newline ( ) { }` plus command substitution (`$(`, backtick), whose contents become further simple
 * commands. Lexical only: no variable or glob expansion (a word containing `$` or a backtick is left as written, and
 * callers treat it as dynamic). Redirections stay as words.
 */
export function splitSimpleCommands(command: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let cur = "";
  let has = false;
  const endWord = (): void => {
    if (has) words.push(cur);
    cur = "";
    has = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (c === "\\") {
      if (i + 1 < command.length) {
        cur += command[i + 1];
        has = true;
        i++;
      }
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end;
      cur += command.slice(i + 1, stop);
      has = true;
      i = stop;
    } else if (c === '"') {
      has = true;
      i++;
      for (; i < command.length && command[i] !== '"'; i++) {
        const d = command[i] as string;
        if (d === "\\" && i + 1 < command.length) {
          cur += command[i + 1];
          i++;
        } else if (d === "`" || (d === "$" && command[i + 1] === "(")) {
          cur += d; // substitution inside double quotes: keep the text; the word is dynamic
        } else cur += d;
      }
    } else if (c === "$" && command[i + 1] === "(") {
      endCommand();
      i++;
    } else if (/[\s]/.test(c) && c !== "\n") {
      endWord();
    } else if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "`") {
      endCommand();
    } else if (c === "{" || c === "}") {
      // `{ git commit; }`: a lone brace is grouping; inside a word (`${HOME}`, `{a,b}`) it is text
      if (has || cur !== "" || (command[i + 1] !== undefined && !/\s/.test(command[i + 1] as string))) {
        cur += c;
        has = true;
      } else endWord();
    } else {
      cur += c;
      has = true;
    }
  }
  endCommand();
  return out;
}

const isDynamic = (w: string): boolean => /[$`*?[]/.test(w);

/**
 * Whether a launcher argument names a Git subprogram (`git-receive-pack`, `/usr/lib/git-core/git-push`,
 * `git-lfs.exe`). Git subprograms carry no file extension except `.exe`, so a source path such as
 * `src/cli/git-push.test.ts` passed to `timeout 600 npx vitest run` is an argument, not the wrapped program.
 */
const isGitSubprogram = (name: string): boolean => /^git-[^.]*(\.exe)?$/.test(name);

/** `git branch` flags that only list or select what is listed (Git 2.43.0 `git branch -h`). */
const BRANCH_LIST_FLAGS = new Set([
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "-l",
  "--list",
  "-i",
  "--ignore-case",
  "-q",
  "--quiet",
  "--show-current",
  "--no-color",
  "--no-column",
  "--no-abbrev",
  "--omit-empty",
]);
/** Short flags that may be bundled in one word (`-av`, `-vv`, `-rl`). */
const BRANCH_LIST_SHORT = /^-[arvliq]+$/;
/** Options whose value may be the next word (`--sort refname`); `=` forms are matched by name. */
const BRANCH_VALUE_OPTIONS = new Set(["--sort", "--format", "--points-at"]);
/** Options whose value, if any, must be inline (`--color=always`, `--abbrev=7`). */
const BRANCH_INLINE_OPTIONS = new Set(["--color", "--column", "--abbrev"]);
/**
 * Filters that put `git branch` in list mode, so later positional words are patterns, not new branch names. Their
 * commit argument is optional and may be the next word, which is then a pattern either way.
 */
const BRANCH_LIST_MODE = new Set([
  "-l",
  "--list",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
]);

/**
 * Whether `git branch <args>` is a write. Read-only only when every option is a known listing option and either no
 * positional word is given or list mode is set (`--list`, `-l`, or a filter such as `--merged`), as in Git's
 * `builtin/branch.c`. Anything else (create, `-d`/`-D`, `-m`/`-M`, `-c`/`-C`, `-u`, `--unset-upstream`, `-f`,
 * `--edit-description`, `--track`, an abbreviated or unknown option, a positional after `--`) is a write: fail closed.
 */
function branchVerdict(args: readonly string[]): GitCommandVerdict | undefined {
  let listMode = false;
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i] as string;
    if (isDynamic(w)) return { level: "uncertain", reason: `dynamic \`git branch\` argument \`${w}\`` };
    if (w === "--") {
      positional ||= i + 1 < args.length;
      break;
    }
    if (!w.startsWith("-") || w === "-") {
      positional = true;
      continue;
    }
    const name = w.split("=", 1)[0] as string;
    if (BRANCH_LIST_MODE.has(name)) listMode = true;
    if (BRANCH_LIST_FLAGS.has(w) || BRANCH_LIST_SHORT.test(w)) {
      if (/^-[a-z]*l/.test(w) && !w.startsWith("--")) listMode = true;
    } else if (BRANCH_VALUE_OPTIONS.has(name)) {
      if (name === w) i++;
    } else if (BRANCH_INLINE_OPTIONS.has(name) || BRANCH_LIST_MODE.has(name)) {
      // value inline or absent; a following word is a pattern (list mode) or makes the command a create
    } else {
      return { level: "write", reason: `\`git branch ${w}\` can create, delete, move or copy a branch` };
    }
  }
  if (positional && !listMode) {
    return { level: "write", reason: "`git branch <name>` creates a branch" };
  }
  return undefined;
}

function gitVerdict(words: readonly string[], bypass: boolean): GitCommandVerdict | undefined {
  let i = 1;
  let globalWithValue = false;
  while (i < words.length) {
    const w = words[i] as string;
    if (!w.startsWith("-")) break;
    const [name, inline] = w.split(/=(.*)/s, 2) as [string, string | undefined];
    if (name === "-c" || name === "--config-env") {
      const value = inline ?? words[i + 1] ?? "";
      if (inline === undefined) i++;
      if (name === "--config-env" || RISKY_GIT_CONFIG.test(value)) {
        return { level: "write", reason: `git ${name} ${value.split("=")[0]} can define or run a command` };
      }
    } else if (name === "-C" || GIT_GLOBAL_OPTIONS_WITH_VALUE.includes(name)) {
      if (inline === undefined) i++;
      globalWithValue = true;
      if (name === "--exec-path") return { level: "write", reason: "git --exec-path replaces git's subprograms" };
    } else if (!GIT_GLOBAL_FLAGS.includes(name) && name !== "--help" && name !== "--version" && name !== "-h") {
      return { level: "uncertain", reason: `unknown git global option \`${w}\`` };
    }
    i++;
  }
  const sub = words[i];
  if (sub === undefined) return undefined;
  if (isDynamic(sub)) return { level: "uncertain", reason: `dynamic git subcommand \`${sub}\`` };
  const args = words.slice(i + 1);
  // ADR-0094: a global option with a value (`-C`, `--git-dir`, `--work-tree`, ...) can point git at another repository,
  // so it keeps the relaxed subcommands below writes; only their plain forms are relaxed.
  if (bypass && !globalWithValue) {
    if (GIT_BYPASS_READ_SUBCOMMANDS.includes(sub)) return gitBypassReadVerdict(sub, args);
    if (GIT_BYPASS_LOCAL_SUBCOMMANDS.includes(sub)) return gitBypassLocalVerdict(sub, args);
  }
  if (sub === "branch") return branchVerdict(args);
  if (GIT_WRITE_SUBCOMMANDS.includes(sub))
    return { level: "write", reason: `\`git ${sub}\` can create commits, change refs or push` };
  if (!GIT_READ_ONLY_SUBCOMMANDS.includes(sub)) {
    return { level: "uncertain", reason: `\`git ${sub}\` is not a known read-only subcommand (alias or external)` };
  }
  const exec = args.find((w) => GIT_EXEC_OPTIONS.test(w));
  if (exec !== undefined) return { level: "write", reason: `\`git ${sub} ${exec}\` runs another program` };
  return undefined;
}

function simpleVerdict(words: readonly string[], depth: number, bypass: boolean): GitCommandVerdict | undefined {
  if (depth > 6) return { level: "uncertain", reason: "command nesting too deep to check" };
  let i = 0;
  let envRisk: string | undefined;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string)) {
    const name = (words[i] as string).split("=")[0] as string;
    if (RISKY_GIT_ENV.test(name)) envRisk = name;
    i++;
  }
  const rest = words.slice(i);
  const program = rest[0];
  if (program === undefined) return undefined;
  const v = programVerdict(rest, depth, bypass);
  if (v !== undefined && envRisk !== undefined && v.level === "uncertain") {
    return { level: "write", reason: `${envRisk} set for a git command` };
  }
  if (v === undefined && envRisk !== undefined && basename(program) === "git") {
    return { level: "write", reason: `${envRisk} set for a git command` };
  }
  return v;
}

function programVerdict(words: readonly string[], depth: number, bypass: boolean): GitCommandVerdict | undefined {
  const program = words[0] as string;
  if (isDynamic(program)) return { level: "uncertain", reason: `dynamic program \`${program}\`` };
  const name = basename(program);
  if (name === "git") return gitVerdict(words, bypass);
  if (name.startsWith("git-")) return { level: "write", reason: `\`${name}\` is a git subprogram` };
  if (GIT_PUBLISHING_PROGRAMS.includes(name))
    return { level: "uncertain", reason: `\`${name}\` can push to a Git host` };
  if (name === "eval") return commandVerdict(words.slice(1).join(" "), depth + 1, bypass);
  if (SHELLS.has(name)) {
    for (let j = 1; j < words.length; j++) {
      const w = words[j] as string;
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(w) && words[j + 1] !== undefined) {
        return commandVerdict(words[j + 1] as string, depth + 1, bypass);
      }
    }
    return undefined;
  }
  if (PREFIX_LAUNCHERS.has(name)) {
    // The launcher's own options may take values (`sudo -u root`, `nice -n 5`): the wrapped command starts at the
    // first word that is itself a program this check understands. File paths with an extension (`git-push.test.ts`)
    // are ordinary arguments here, not Git subprograms.
    let j = 1;
    while (j < words.length) {
      const w = basename(words[j] as string);
      if (
        w === "git" ||
        isGitSubprogram(w) ||
        GIT_PUBLISHING_PROGRAMS.includes(w) ||
        SHELLS.has(w) ||
        w === "eval" ||
        PREFIX_LAUNCHERS.has(w)
      )
        break;
      j++;
    }
    const inner = words.slice(j);
    return inner.length === 0 ? undefined : simpleVerdict(inner, depth + 1, bypass);
  }
  return undefined;
}

function commandVerdict(command: string, depth: number, bypass: boolean): GitCommandVerdict | undefined {
  let local: GitCommandVerdict | undefined;
  let uncertain: GitCommandVerdict | undefined;
  for (const words of splitSimpleCommands(command)) {
    const v = simpleVerdict(words, depth, bypass);
    if (v?.level === "write") return v;
    if (v?.level === "local") local ??= v;
    else uncertain ??= v;
  }
  return local ?? uncertain;
}

/**
 * Whether a shell command LINE (what a provider's shell tool was asked to run, not an allowlist entry) can perform a
 * Git write, judged on the parsed words rather than a command-string prefix (Q-62: Grok's `--deny 'Bash(git commit*)'`
 * did not match `git -C . commit` or `/usr/bin/git commit`). Handles compound lines (`;`, `&&`, `||`, `|`, newlines,
 * `$(...)`, backticks), `NAME=value` prefixes, launchers (`env`, `timeout 5`, `sudo`, `xargs`, ...), `sh -c '...'` and
 * `eval` recursively, program paths (`/usr/bin/git`), and Git global options before the subcommand.
 *
 * `write`: a known write path (subcommand in {@link GIT_WRITE_SUBCOMMANDS}, `git-<name>`, a `-c` that defines an alias
 * or hook, `GIT_CONFIG_*` set). Two exceptions keep read-only work running (Linus decision, Delegated, not
 * owner-approved, 2026-10-20): the listing forms of `git branch` (bare, `--show-current`, `--list`, `-a`, `-r`, `-v`,
 * `--contains`, `--merged`, ...; see `branchVerdict`) are not writes, and behind a launcher a `git-` word with a file
 * extension (`timeout 600 npx vitest run src/cli/git-push.test.ts`) is an argument, not a Git subprogram. `uncertain`: the check cannot tell (a dynamic program or subcommand, an unknown
 * subcommand that may be an alias, `gh`). Not covered, by design: scripts and interpreters (`python -c`, `make`);
 * the FR-GIT-03 ref snapshot is the backstop for those.
 *
 * ADR-0094 (`opts.bypass`, an approved privileged bypass run only): the download and read forms admitted by
 * {@link gitBypassReadVerdict} (`git fetch`, `git remote update`, `git ls-remote`, `git remote -v`, ...) are not
 * writes, and the verbs admitted by {@link gitBypassLocalVerdict} (`git commit`, `git reset`, `git pull`, `git checkout
 * -- <path>`, ...) are `local`. Pushes, remote changes, configuration, `gh`, `git-<name>` programs, a fetch or pull into
 * a local branch, any change to another branch or tag, and any Git global option with a value stay `write`.
 */
export function gitWriteInCommand(command: string, opts: GitCommandCheckOptions = {}): GitCommandVerdict | undefined {
  return commandVerdict(command, 0, opts.bypass === true);
}

/**
 * ADR-0072 follow-up (Linus, 2026-10-20): Git subcommands a provider's Git deny rule (FR-GIT-01) may have blocked
 * without the attempt being security-class: reads and local ref or index verbs (`pull` since ADR-0094). Anything else (push, send-pack, remote,
 * fetch, config, update-ref, symbolic-ref, submodule, clone, worktree, rebase, bisect, an alias, ...) is
 * security-class. The denied command never ran; the FR-GIT-03 ref check backs this up.
 */
const GIT_RULE_LOCAL_SUBCOMMANDS: readonly string[] = [
  ...GIT_READ_ONLY_SUBCOMMANDS,
  "branch",
  "tag",
  "stash",
  "checkout",
  "switch",
  "reset",
  "restore",
  "add",
  "rm",
  "mv",
  "commit",
  "merge",
  "cherry-pick",
  "revert",
  "notes",
  "reflog",
  // ADR-0094: a denied `git pull` never ran; had it run, it is a fetch plus a merge into the run branch, which the
  // FR-GIT-03 ref check restores. Pushes and remote changes stay out of this list.
  "pull",
];
/** Git global options that change nothing about which repository is used (`--bare` and every option with a value do). */
const GIT_RULE_HARMLESS_GLOBALS = GIT_GLOBAL_FLAGS.filter((f) => f !== "--bare");
/** Options of a local subcommand that run another program or write a file anywhere. */
const GIT_RULE_RISKY_ARGS = /^(-O|--open-files-in-pager|--output|--exec|-x$|--upload-pack|--receive-pack)/;
/** Shell words that may open a simple command (`for ...; do git log ...; done`, `if git ...; then`). */
const SHELL_KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{", "time"]);
const GIT_OR_GH_TEXT = /(^|[^A-Za-z0-9_-])(git|gh)([^A-Za-z0-9_]|$)/;
/** Proposed bound: a longer command is not parsed and counts as security-class. */
export const GIT_RULE_COMMAND_MAX_CHARS = 16_384;

/**
 * ADR-0072 follow-up: why a shell command that a Git deny rule blocked is security-class, or `undefined` when every Git
 * invocation in it is a read or a local ref verb (`git branch -a`, `git tag -l`, `git stash list`, `git log`,
 * `git checkout`), which makes the denial recoverable. Lexical and conservative, never executes anything: the command
 * is split on `; & | newline ( )`, `$(` and backticks ({@link splitSimpleCommands}); in each simple command, after
 * shell keywords and `NAME=value` prefixes, the first word is the program. Security-class: a missing, oversized or
 * empty command; no Git invocation found (the rule's match cannot be explained); any `gh`; a `git-<name>` program; a
 * dynamic program; a `GIT_*` assignment; a launcher, shell or `eval` whose arguments mention `git` or `gh`; `git` or
 * `gh` as a later argument of another program (`find -exec`, `xargs`); a Git global option other than the harmless
 * flags (`-C`, `-c`, `--git-dir`, `--work-tree`, `--exec-path`, `--bare`, ...); a dynamic subcommand or one outside the
 * local set (`push`, `send-pack`, `remote`, `fetch`, `config`, `update-ref`, `symbolic-ref`, ...); and a local
 * subcommand with an option that runs a program or writes a file elsewhere (`-O`, `--output`, `--exec`).
 */
export function gitDenyRuleSecurityReason(command: string | undefined): string | undefined {
  if (command === undefined || command.trim() === "") return "denied command not found";
  if (command.length > GIT_RULE_COMMAND_MAX_CHARS) return "denied command too long to check";
  const scan = ruleScan(command, 0);
  return scan.reason ?? (scan.sawGit ? undefined : "no git invocation found");
}

function ruleScan(command: string, depth: number): { reason?: string; sawGit: boolean } {
  if (depth > 4) return { reason: "command nesting too deep to check", sawGit: false };
  let sawGit = false;
  for (const all of splitSimpleCommands(command)) {
    // A substitution inside double quotes stays inside its word (`echo "$(git push)"`): scan it as a command too.
    for (const w of all) {
      const at = w.search(/\$\(|`/);
      if (at === -1) continue;
      const inner = ruleScan(w.slice(at), depth + 1);
      if (inner.reason !== undefined) return inner;
      sawGit ||= inner.sawGit;
    }
    let i = 0;
    while (i < all.length && SHELL_KEYWORDS.has(all[i] as string)) i++;
    for (; i < all.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(all[i] as string); i++) {
      if ((all[i] as string).startsWith("GIT_")) return { reason: "a GIT_ variable is set", sawGit };
    }
    const words = all.slice(i);
    const program = words[0];
    if (program === undefined) continue;
    const name = basename(program);
    if (isDynamic(program)) return { reason: `dynamic program \`${program}\``, sawGit };
    if (GIT_PUBLISHING_PROGRAMS.includes(name)) return { reason: `\`${name}\` can push to a Git host`, sawGit };
    if (name.startsWith("git-")) return { reason: `\`${name}\` is a git subprogram`, sawGit };
    if (name !== "git") {
      const launcher = COMMAND_LAUNCHERS.includes(name) || PREFIX_LAUNCHERS.has(name) || SHELLS.has(name);
      for (const w of words.slice(1)) {
        const b = basename(w);
        if (b === "git" || GIT_PUBLISHING_PROGRAMS.includes(b) || isGitSubprogram(b)) {
          return { reason: `\`${name}\` runs \`${b}\``, sawGit };
        }
        if (launcher && GIT_OR_GH_TEXT.test(w)) return { reason: `\`${name}\` may run git or gh`, sawGit };
      }
      continue;
    }
    sawGit = true;
    let j = 1;
    while (j < words.length && (words[j] as string).startsWith("-")) {
      const w = words[j] as string;
      if (!GIT_RULE_HARMLESS_GLOBALS.includes(w))
        return {
          reason: `git global option \`${w.split("=", 1)[0]}\``,
          sawGit,
        };
      j++;
    }
    const sub = words[j];
    if (sub === undefined) continue;
    if (isDynamic(sub)) return { reason: `dynamic git subcommand \`${sub}\``, sawGit };
    if (!GIT_RULE_LOCAL_SUBCOMMANDS.includes(sub)) return { reason: `\`git ${sub}\` is not a local git verb`, sawGit };
    const risky = words.slice(j + 1).find((w) => GIT_RULE_RISKY_ARGS.test(w));
    if (risky !== undefined) {
      return {
        reason: `\`git ${sub} ${risky.split("=", 1)[0]}\` runs a program or writes elsewhere`,
        sawGit,
      };
    }
  }
  return { sawGit };
}
