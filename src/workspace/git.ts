import { execFile } from "node:child_process";

/**
 * Thin Git runner (TDD §2, LLD §5): `execFile` with no shell, a scrubbed environment and hooks disabled. Callers must
 * request porcelain / `-z` output where they parse anything.
 */

/** Proposed: Git >= 2.30 (needs `worktree add -b`, `status --porcelain=v2`, `init -b` for tests; 2.30 is a conservative floor). */
export const MIN_GIT_VERSION = [2, 30, 0] as const;

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
  "commit.gpgsign=false",
  "-c",
  "core.quotepath=false",
  "-c",
  `user.name=${CONTROLLER_IDENTITY.name}`,
  "-c",
  `user.email=${CONTROLLER_IDENTITY.email}`,
];

export function git(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
  const full = [...BASE_CONFIG, ...args];
  const ok = new Set([0, ...(options.okCodes ?? [])]);
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
