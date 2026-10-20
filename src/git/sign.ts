/**
 * Controller-side commit signing (FR-GIT-10, FRD BR-33, LLD §12.3.1; ADR-0034; T9.10). Used only by
 * {@link GitPublisher.commit} (both the agent `commit` tool and the finalize-only path) when the run's frozen project
 * snapshot has `sign: true`, and by `projects validate` for its test signature. With `sign` off nothing here runs.
 *
 * Trust boundary (ADR-0034). Signing is the one controller Git step that runs with the operator's signing setup: the
 * operator's global and system Git configuration (where `user.signingkey`, `gpg.format` and `gpg.program` live) and the
 * variables that locate the operator's keyring or agent ({@link SIGNING_ENV_ALLOWLIST}). The controller never reads,
 * stores, prints or logs a key, passphrase, keyring or agent socket: it never runs `gpg` or `ssh-keygen` itself, keeps
 * no output of the signing process (its standard error is drained and discarded), and records only a reason code.
 *
 * - **Environment.** Built from an allowlist (fail closed): no inherited `GIT_*` variable (so no `GIT_CONFIG_*`,
 *   `GIT_CONFIG_PARAMETERS`, `GIT_SSH_COMMAND`), no `DISPLAY`, no askpass variable, plus `GIT_TERMINAL_PROMPT=0`,
 *   `LC_ALL=C` and the controller's own `GIT_DIR`, `GIT_OBJECT_DIRECTORY` and identity variables. It reaches only the
 *   controller's own `git` child for this one step; the provider process gets its adapter's allowlist, which names none
 *   of {@link SIGNING_AGENT_VARIABLES} (tested by environment inspection).
 * - **Repository configuration is never read.** The repository's own configuration is untrusted (an agent that had a
 *   shell in a worktree could write it; see `REPO_CONFIG_UNSAFE` in `push.ts`). `git commit-tree -S` runs with
 *   `GIT_DIR` set to a fresh controller-made scratch repository and `GIT_OBJECT_DIRECTORY` set to the real repository's
 *   object store, so Git reads the tree and parent from the repository and writes the signed commit object into it,
 *   while the only configuration it reads is the operator's global and system files and the scratch repository's own.
 *   In addition, a repository whose own configuration (local, worktree or included files) sets any signing key
 *   ({@link UNSAFE_SIGNING_CONFIG_PATTERN}) is refused (`repo_config_unsafe`) rather than silently ignored.
 * - **Process.** Its own session (`detached`, no controlling terminal, so nothing can prompt on `/dev/tty`), standard
 *   input carrying only the commit message, a timeout that kills the process group, and hooks off at command scope.
 * - **No fallback.** Any failure (non-zero exit, timeout, spawn error, or a commit object without a signature header)
 *   is a failure; the caller turns it into `SIGNING_FAILED` and never makes an unsigned commit instead.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git, gitText } from "../workspace/git.js";

/** Variables that locate the operator's signing keyring or agent. Never in any provider allowlist (tested). */
export const SIGNING_AGENT_VARIABLES = ["GNUPGHOME", "GPG_AGENT_INFO", "SSH_AUTH_SOCK"] as const;

/**
 * Variables copied from the controller's environment into the signing step (Delegated, ADR-0034): `PATH` (to find
 * `gpg`, `gpgsm` or `ssh-keygen`), where Git finds the operator's global configuration (`HOME`, `XDG_CONFIG_HOME`),
 * the user name (`USER`, `LOGNAME`), the runtime directory where `gpg-agent` keeps its sockets (`XDG_RUNTIME_DIR`), and
 * {@link SIGNING_AGENT_VARIABLES}. Nothing else.
 */
export const SIGNING_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  ...SIGNING_AGENT_VARIABLES,
] as const;

/**
 * Signing keys that, in the repository's own configuration, are refused (POSIX ERE over Git's canonical key names):
 * every `gpg.*` key (`gpg.program`, `gpg.format`, `gpg.ssh.program`, `gpg.ssh.defaultKeyCommand`,
 * `gpg.x509.program`, ...) and `user.signingkey`. The same keys in the operator's global or system configuration are
 * the operator's own and are used.
 */
export const UNSAFE_SIGNING_CONFIG_PATTERN = String.raw`^(gpg\..*|user\.signingkey)$`;

/** Proposed (Delegated): bound of one signing step; below the shim's 120 s call timeout. */
export const DEFAULT_SIGN_TIMEOUT_MS = 60_000;

/** Command-scope settings of the signing step (command scope overrides every configuration file). */
const SIGN_CONFIG: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
];

/** Identity variables a caller may add (the same names the hardened helper accepts for `commit-tree`). */
const IDENTITY_KEYS = new Set([
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
]);

/** Fixed reason codes of a signing failure (recorded; never Git's or the signing program's output). */
export type SigningFailureReason = "sign_failed" | "timeout" | "signature_missing";

export type SignedCommitResult =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly reason: SigningFailureReason };

/** The signing environment: allowlisted variables only, then the fixed Git settings. */
export function signingEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SIGNING_ENV_ALLOWLIST) {
    const v = source[key];
    if (typeof v === "string" && v !== "") env[key] = v;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.LC_ALL = "C";
  return env;
}

/** True when the repository's own configuration (local, worktree, included files) sets a signing key. Names only. */
export async function repoSigningConfigUnsafe(cwd: string): Promise<boolean> {
  const r = await git(["config", "-z", "--show-scope", "--name-only", "--get-regexp", UNSAFE_SIGNING_CONFIG_PATTERN], {
    cwd,
    okCodes: [1],
  });
  if (r.code === 1) return false;
  const parts = r.stdout.toString("utf8").split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] !== "command") return true; // global and system are off in the hardened helper: local, worktree
  }
  return false;
}

export interface SignedCommitTreeOptions {
  /** A worktree or repository whose object store receives the commit. */
  readonly cwd: string;
  readonly tree: string;
  /** Omit for a root commit (the `projects validate` test signature). */
  readonly parent?: string;
  /** T15.7: further parents after {@link parent} (a rebase run's merged base); default none. Needs `parent`. */
  readonly extraParents?: readonly string[];
  /** Passed on standard input exactly as given (`commit-tree -F -`). */
  readonly message: string;
  /** The six `GIT_AUTHOR_*` / `GIT_COMMITTER_*` variables; any other key throws. */
  readonly identityEnv: Readonly<Record<string, string>>;
  /** Environment the allowlisted variables are copied from (the controller's own). */
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  /** Parent directory of the temporary scratch repository (default: the OS temporary directory). */
  readonly scratchDir?: string;
}

/**
 * `git commit-tree -S` with the operator's signing setup and nothing from the repository's configuration (see the
 * module comment). Returns the new commit's id only when Git succeeded AND the object carries a signature header.
 */
export async function signedCommitTree(opts: SignedCommitTreeOptions): Promise<SignedCommitResult> {
  for (const key of Object.keys(opts.identityEnv)) {
    if (!IDENTITY_KEYS.has(key)) throw new Error(`environment variable ${key} is not allowed`);
  }
  const objects = path.resolve(opts.cwd, await gitText(["rev-parse", "--git-path", "objects"], { cwd: opts.cwd }));
  const format = await gitText(["rev-parse", "--show-object-format"], { cwd: opts.cwd });
  const parentDir = opts.scratchDir ?? tmpdir();
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(path.join(parentDir, "sign-"));
  try {
    const gitDir = path.join(scratch, "repo.git");
    await git(["init", "--bare", "-q", `--object-format=${format}`, gitDir], { cwd: scratch });
    const env = {
      ...signingEnv(opts.sourceEnv),
      ...opts.identityEnv,
      GIT_DIR: gitDir,
      GIT_OBJECT_DIRECTORY: objects,
    };
    const args = [
      ...SIGN_CONFIG,
      "commit-tree",
      opts.tree,
      ...(opts.parent ? ["-p", opts.parent] : []),
      ...(opts.parent ? (opts.extraParents ?? []).flatMap((p) => ["-p", p]) : []),
      "-S",
      "-F",
      "-",
    ];
    const run = await runSigning(scratch, args, env, opts.message, opts.timeoutMs);
    if (run.timedOut) return { ok: false, reason: "timeout" };
    const sha = run.stdout.trim();
    if (run.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(sha)) return { ok: false, reason: "sign_failed" };
    if (!(await hasSignature(opts.cwd, sha))) return { ok: false, reason: "signature_missing" };
    return { ok: true, sha };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** True when the commit object has a `gpgsig` or `gpgsig-sha256` header (any signature format Git writes). */
export async function hasSignature(cwd: string, sha: string): Promise<boolean> {
  const raw = (await git(["cat-file", "commit", sha], { cwd })).stdout.toString("utf8");
  const headerEnd = raw.indexOf("\n\n");
  const headers = (headerEnd === -1 ? raw : raw.slice(0, headerEnd)).split("\n");
  return headers.some((l) => l.startsWith("gpgsig ") || l.startsWith("gpgsig-sha256 "));
}

/**
 * `projects validate` (T9.10, LLD §12.3.1): sign an empty root commit in a throwaway scratch repository with the
 * operator's setup. Nothing is kept: the scratch directory is removed afterwards.
 */
export async function testSignature(opts: {
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  readonly scratchDir?: string;
  readonly timeoutMs?: number;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: SigningFailureReason }> {
  const parentDir = opts.scratchDir ?? tmpdir();
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(path.join(parentDir, "sign-test-"));
  try {
    const repo = path.join(scratch, "probe");
    await git(["init", "-q", repo], { cwd: scratch });
    const tree = (await git(["mktree", "-z"], { cwd: repo, input: "" })).stdout.toString("utf8").trim();
    const r = await signedCommitTree({
      cwd: repo,
      tree,
      message: "Switchboard signing test\n",
      identityEnv: {
        GIT_AUTHOR_NAME: "Switchboard signing test",
        GIT_AUTHOR_EMAIL: "signing-test@localhost",
        GIT_AUTHOR_DATE: "1000000000 +0000",
        GIT_COMMITTER_NAME: "Switchboard signing test",
        GIT_COMMITTER_EMAIL: "signing-test@localhost",
        GIT_COMMITTER_DATE: "1000000000 +0000",
      },
      sourceEnv: opts.sourceEnv,
      timeoutMs: opts.timeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS,
      scratchDir: scratch,
    });
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

interface SigningRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly timedOut: boolean;
}

const MAX_STDOUT = 4096; // a commit id and a newline

/** Run `git <args>` in its own session; standard error is drained and discarded (it may name the key or keyring). */
function runSigning(
  cwd: string,
  args: readonly string[],
  env: Record<string, string>,
  input: string,
  timeoutMs: number,
): Promise<SigningRun> {
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    let settled = false;
    const child = spawn("git", [...args], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => {
      if (out.length < MAX_STDOUT) out += b.toString("utf8");
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const finish = (r: SigningRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.on("error", () => finish({ code: null, stdout: "", timedOut }));
    child.on("close", (code) => finish({ code, stdout: out, timedOut }));
  });
}
