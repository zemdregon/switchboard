import { execFile } from "node:child_process";

/**
 * Thin Git runner (TDD §2, LLD §5): `execFile` with no shell, a scrubbed environment, hooks and fsmonitor disabled and
 * every repository-configured filter and diff driver neutralised (TDD §3.4). Callers must request porcelain / `-z`
 * output where they parse anything.
 */

/**
 * Git >= 2.32 (ADR-0023, Delegated decision 30, Q-39). `scrubbedGitEnv()` sets `GIT_CONFIG_GLOBAL=/dev/null`, which the
 * Git 2.32.0 release notes introduce; on 2.30 and 2.31 the operator's global configuration would not be neutralised.
 * Also needs `worktree add -b`, `status --porcelain=v2` and `init -b` for tests.
 */
export const MIN_GIT_VERSION = [2, 32, 0] as const;

/** Proposed controller identity for checkpoint commits (LLD §5 "controller identity"). */
export const CONTROLLER_IDENTITY = { name: "Switchboard", email: "switchboard@localhost" } as const;

export class GitError extends Error {
  override readonly name = "GitError";
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export interface GitResult {
  readonly stdout: Buffer;
  readonly code: number;
}

export interface GitRunOptions {
  readonly cwd?: string;
  /** Exit codes that are not errors (0 is always accepted). */
  readonly okCodes?: readonly number[];
}

const MAX_BUFFER = 256 * 1024 * 1024;

/** Environment with no inherited `GIT_*` variables, no global/system config and no prompts (TDD §3.4, Proposed). */
export function scrubbedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  return env;
}

const BASE_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.quotepath=false",
  "-c",
  `user.name=${CONTROLLER_IDENTITY.name}`,
  "-c",
  `user.email=${CONTROLLER_IDENTITY.email}`,
];

/**
 * Repository-configured driver keys that name a command Git would run inside a controller operation (TDD §3.4
 * "Repository hooks, filters and diff drivers"): filter drivers (`clean`, `smudge`, long-running `process`, plus
 * `required`, which must be cleared so a neutralised driver does not make Git fail), per-driver diff commands
 * (`textconv`, `command`) and the repository-wide `diff.external`. Matched against Git's canonical key names.
 */
const DRIVER_KEY_PATTERN = String.raw`^(filter\..*\.(clean|smudge|process|required)|diff\..*\.(textconv|command)|diff\.external)$`;

/** Diff options forced on every controller `git diff`: never run textconv or external diff programs. */
const DIFF_HARDENING = ["--no-textconv", "--no-ext-diff"] as const;

function execGit(
  full: readonly string[],
  args: readonly string[],
  options: GitRunOptions,
  ok: ReadonlySet<number>,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      full,
      { cwd: options.cwd, env: scrubbedGitEnv(), encoding: "buffer", maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        const errCode = err ? (err as NodeJS.ErrnoException & { code?: unknown }).code : 0;
        const code = typeof errCode === "number" ? errCode : err ? null : 0;
        if (code !== null && ok.has(code)) {
          resolve({ stdout, code });
          return;
        }
        reject(
          new GitError(
            `git ${args[0] ?? ""} failed${err ? `: ${err.message.split("\n")[0]}` : ""}`,
            args,
            code,
            stderr.toString("utf8"),
          ),
        );
      },
    );
  });
}

/**
 * `-c` overrides that neutralise every filter and diff driver command defined in the configuration Git reads at
 * `cwd`. Global and system configuration are already off (`scrubbedGitEnv`), so an unscoped read sees exactly the
 * repository's own configuration: `.git/config`, the worktree's `config.worktree` and every `include`/`includeIf`
 * file (`--local` would skip the last two). An empty command disables a filter driver (Git skips empty `clean`,
 * `smudge` and `process` commands; verified on Git 2.43) and turns a consulted `textconv`/`command` into a hard
 * failure rather than a program run; `required` is forced to `false` so a skipped filter is not an error. A key
 * that `-c` cannot express (a driver name containing `=` or a newline) fails closed.
 */
export async function driverOverrides(cwd?: string): Promise<string[]> {
  const r = await execGit(
    [...BASE_CONFIG, "config", "-z", "--name-only", "--get-regexp", DRIVER_KEY_PATTERN],
    ["config"],
    { ...(cwd !== undefined ? { cwd } : {}) },
    new Set([0, 1]),
  );
  const overrides: string[] = [];
  for (const key of r.stdout.toString("utf8").split("\0")) {
    if (key === "") continue;
    if (key.includes("=") || key.includes("\n")) {
      throw new GitError(
        "repository configuration defines a filter or diff driver the controller cannot neutralise",
        ["config"],
        null,
        "",
      );
    }
    overrides.push("-c", key.endsWith(".required") ? `${key}=false` : `${key}=`);
  }
  return overrides;
}

export async function git(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
  const versionOnly = args.length === 1 && args[0] === "--version";
  const overrides = versionOnly ? [] : await driverOverrides(options.cwd);
  const command = args[0] === "diff" ? ["diff", ...DIFF_HARDENING, ...args.slice(1)] : args;
  const ok = new Set([0, ...(options.okCodes ?? [])]);
  return execGit([...BASE_CONFIG, ...overrides, ...command], args, options, ok);
}

export async function gitText(args: readonly string[], options: GitRunOptions = {}): Promise<string> {
  return (await git(args, options)).stdout.toString("utf8").trim();
}

export function parseGitVersion(output: string): [number, number, number] | undefined {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

export function versionAtLeast(v: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const a = v[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}
