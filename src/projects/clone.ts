/**
 * Repository sources for dynamic projects (ADR-0068; FR-PRJ-10 note 2026-10-20, LLD §3 `create_project`). A repository
 * context of `create_project` / `update_project` may name `clone_url` instead of `path`; the controller then clones the
 * repository into `project_sources.clone_root` (or reuses an earlier clone of the same repository) and the definition
 * continues with the resolved `path`, under the unchanged ADR-0030 rules.
 *
 * Rules (Decided by Linus under the owner ruling 2026-10-20; details marked **Delegated** are the coder's):
 * - Only `https://<host>/<owner>/<repo>` with an optional `.git` and an optional trailing slash. No userinfo, port,
 *   query, fragment, percent-encoding, other scheme, `.`/`..` segment or character outside `[A-Za-z0-9._-]` in owner
 *   and repository. The host must be in `allowed_hosts` and the owner in `allowed_owners` (case-insensitive).
 * - Target `<clone_root>/<host>/<owner lower case>/<repo lower case, no .git>`. A missing target is cloned into a
 *   temporary directory beside it and renamed into place, so the target never holds half a clone. **Delegated**: a
 *   failed clone removes only its own temporary directory; `rename(2)` refuses a non-empty target, so an existing
 *   repository is never replaced.
 * - An existing target must be a directory (not a symbolic link) that is the top level of a Git repository whose
 *   `origin` URL names the same host, owner and repository (case-insensitive); it is then fetched (best effort) and
 *   reused. Anything else is `CLONE_TARGET_CONFLICT`; nothing is deleted or overwritten.
 * - Git runs through `execFile`-style argv (no shell) with the server's own environment, so the operator's credential
 *   helper or `gh` login is used; Switchboard never reads, passes or stores a credential. `GIT_TERMINAL_PROMPT=0` and a
 *   closed stdin mean Git never waits for a prompt. Git's output is never repeated (it could carry a URL or a token):
 *   every failure is one closed reason code with a fixed message.
 */
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isUnderAllowedRoot, type ProjectSourcesSettings } from "../config/index.js";

/** **Assumption** (no source gives a number): a clone or fetch that takes longer is stopped and reported failed. */
export const DEFAULT_CLONE_TIMEOUT_MS = 300_000;
/** **Delegated** bound on a `clone_url` (the longest accepted host, owner and name fit well inside it). */
export const MAX_CLONE_URL_LENGTH = 512;

export type CloneRefusal =
  | "CLONE_URL_INVALID"
  | "CLONE_SOURCE_NOT_ALLOWED"
  | "CLONE_TARGET_CONFLICT"
  | "CLONE_FAILED"
  | "CLONE_NOT_CONFIGURED";

/** Audit code of one clone attempt (`project_event.payload.clone`). */
export type CloneAudit = "cloned" | "reused" | "failed" | "refused";

const FIXED_TEXT: Readonly<Record<CloneRefusal, string>> = {
  CLONE_URL_INVALID:
    "clone_url must be https://<host>/<owner>/<repo> (optional .git), without credentials, port, query or fragment",
  CLONE_SOURCE_NOT_ALLOWED: "the repository host or owner is not in this server's project_sources",
  CLONE_NOT_CONFIGURED: "this server accepts no clone_url (the operator has not configured project_sources)",
  CLONE_TARGET_CONFLICT:
    "the clone target already exists and is not a clone of this repository; the operator must resolve it",
  CLONE_FAILED:
    "repository could not be cloned with the server's git credentials; the operator may need to grant access",
};

/** A refused or failed clone. The message is fixed per reason; nothing from Git is in it. */
export class CloneError extends Error {
  override readonly name = "CloneError";
  constructor(
    readonly reason: CloneRefusal,
    readonly field?: string,
  ) {
    super(FIXED_TEXT[reason]);
  }
  /** The taxonomy code (ADR-0068): syntax is the client's, a source or target outside the rules is not allowed. */
  get code(): "INVALID_REQUEST" | "PERMISSION_BLOCKED" | "TOOL_FAILURE" {
    if (this.reason === "CLONE_URL_INVALID") return "INVALID_REQUEST";
    if (this.reason === "CLONE_FAILED") return "TOOL_FAILURE";
    return "PERMISSION_BLOCKED";
  }
  get audit(): CloneAudit {
    return this.reason === "CLONE_FAILED" ? "failed" : "refused";
  }
}

/** A parsed repository URL. `host` is lower case; `owner` and `repo` keep their case; `repo` has no `.git`. */
export interface RepositorySource {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/u;

/** Parse `text` by the ADR-0068 rules, or undefined. Pure; no allowlist. */
export function parseRepositoryUrl(text: unknown): RepositorySource | undefined {
  if (typeof text !== "string" || text.length > MAX_CLONE_URL_LENGTH) return undefined;
  const prefix = "https://";
  if (!text.startsWith(prefix)) return undefined;
  let rest = text.slice(prefix.length);
  if (rest.endsWith("/")) rest = rest.slice(0, -1);
  const parts = rest.split("/");
  if (parts.length !== 3) return undefined;
  const [rawHost, owner, rawRepo] = parts as [string, string, string];
  const host = rawHost.toLowerCase();
  if (host.length > 253 || !HOST_RE.test(host)) return undefined; // also refuses userinfo (`@`) and a port (`:`)
  const repo = rawRepo.toLowerCase().endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
  for (const seg of [owner, repo]) {
    if (!SEGMENT_RE.test(seg) || seg === "." || seg === ".." || seg.startsWith("-")) return undefined;
  }
  return { host, owner, repo };
}

/** The stored, normalised form: `https://<host>/<owner>/<repo>` (no `.git`, no trailing slash, no credential). */
export function normalizedUrl(src: RepositorySource): string {
  return `https://${src.host}/${src.owner}/${src.repo}`;
}

/** `host/owner/repo` in lower case: what the audit payload keeps, and the identity two URLs are compared by. */
export function sourceKey(src: RepositorySource): string {
  return `${src.host}/${src.owner.toLowerCase()}/${src.repo.toLowerCase()}`;
}

/** Whether `project_sources` lets `src` be cloned (host exact, owner case-insensitive). */
export function sourceAllowed(src: RepositorySource, settings: ProjectSourcesSettings): boolean {
  return settings.allowedHosts.includes(src.host) && settings.allowedOwners.includes(src.owner.toLowerCase());
}

/** Parse and check one `clone_url`; throws {@link CloneError}. */
export function checkCloneUrl(
  text: unknown,
  settings: ProjectSourcesSettings | undefined,
  field?: string,
): RepositorySource {
  if (settings === undefined) throw new CloneError("CLONE_NOT_CONFIGURED", field);
  const src = parseRepositoryUrl(text);
  if (src === undefined) throw new CloneError("CLONE_URL_INVALID", field);
  if (!sourceAllowed(src, settings)) throw new CloneError("CLONE_SOURCE_NOT_ALLOWED", field);
  return src;
}

/** Where `src` is cloned: `<clone_root>/<host>/<owner lower>/<repo lower>`. */
export function cloneTarget(src: RepositorySource, settings: ProjectSourcesSettings): string {
  return path.join(settings.cloneRoot, src.host, src.owner.toLowerCase(), src.repo.toLowerCase());
}

/**
 * **Delegated** (defence in depth): every Git call turns off repository-configured programs, so a repository found at a
 * target cannot run a hook or an fsmonitor command in the server's account.
 */
const SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"] as const;

/** One Git invocation: argv after `git`, never through a shell. Resolves with the exit status; never rejects. */
export type GitRunner = (
  args: readonly string[],
  opts: { readonly cwd?: string; readonly timeoutMs: number },
) => Promise<{ readonly ok: boolean; readonly stdout: string }>;

/**
 * The default runner: `git` from `PATH`, the server's environment plus `GIT_TERMINAL_PROMPT=0`, stdin closed, output
 * kept in memory only (bounded) and never logged.
 */
export const defaultGitRunner: GitRunner = (args, opts) =>
  new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout });
    };
    const child = spawn("git", [...args], {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(false);
    }, opts.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      if (stdout.length < 65_536) stdout += c;
    });
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });

export interface EnsureCloneDeps {
  readonly settings: ProjectSourcesSettings;
  readonly git?: GitRunner;
  readonly timeoutMs?: number;
  /** ADR-0079 object stores: clone with `--no-checkout` (default false). */
  readonly noCheckout?: boolean;
  /**
   * Extra command-scope `-c` pairs placed after the fixed hooks/fsmonitor settings on the clone and on the reuse fetch
   * (ADR-0079 stores: `protocol.allow=never`, `protocol.https.allow=always`, `submodule.recurse=false`,
   * `fetch.recurseSubmodules=false`). Default none.
   */
  readonly extraConfig?: readonly string[];
  /** Whether a reused clone is fetched (best effort) before it is returned. Default true (ADR-0068). */
  readonly fetchOnReuse?: boolean;
}

/**
 * Clone `src` to its target, or reuse an earlier clone of it. Returns the target path (canonical) and what happened.
 * Throws {@link CloneError} (`CLONE_TARGET_CONFLICT` or `CLONE_FAILED`).
 */
export async function ensureClone(
  src: RepositorySource,
  deps: EnsureCloneDeps,
  field?: string,
): Promise<{ path: string; outcome: "cloned" | "reused" }> {
  const git = deps.git ?? defaultGitRunner;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
  const target = cloneTarget(src, deps.settings);
  const reuseOpts = { extra: deps.extraConfig ?? [], fetch: deps.fetchOnReuse ?? true };
  const existing = await reuse(src, target, deps.settings, git, timeoutMs, field, reuseOpts);
  if (existing !== undefined) return { path: existing, outcome: "reused" };

  const parent = path.dirname(target);
  let tmp: string;
  try {
    await mkdir(parent, { recursive: true });
    // A symbolic link planted on the way would move the clone out of clone_root.
    if (!isUnderAllowedRoot(await realpath(parent), [deps.settings.cloneRoot])) {
      throw new CloneError("CLONE_TARGET_CONFLICT", field);
    }
    tmp = await mkdtemp(path.join(parent, `.${path.basename(target)}.clone-`));
  } catch (err) {
    if (err instanceof CloneError) throw err;
    throw new CloneError("CLONE_FAILED", field);
  }
  const url = `${normalizedUrl(src)}.git`;
  const checkout = deps.noCheckout === true ? ["--no-checkout"] : [];
  const cloned = await git(
    [...SAFE, ...reuseOpts.extra, "clone", "--no-recurse-submodules", ...checkout, "--", url, tmp],
    {
      timeoutMs,
    },
  );
  if (!cloned.ok) {
    await rm(tmp, { recursive: true, force: true });
    throw new CloneError("CLONE_FAILED", field);
  }
  try {
    if ((await exists(target)) === false) {
      await rename(tmp, target);
      return { path: await realpath(target), outcome: "cloned" };
    }
  } catch {
    // Lost a race with a concurrent clone (or the target appeared): fall through to the reuse rules.
  }
  await rm(tmp, { recursive: true, force: true });
  const raced = await reuse(src, target, deps.settings, git, timeoutMs, field, reuseOpts);
  if (raced === undefined) throw new CloneError("CLONE_TARGET_CONFLICT", field);
  return { path: raced, outcome: "reused" };
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** The canonical target when it is a reusable clone of `src`; undefined when it does not exist; else a conflict. */
async function reuse(
  src: RepositorySource,
  target: string,
  settings: ProjectSourcesSettings,
  git: GitRunner,
  timeoutMs: number,
  field: string | undefined,
  opts: { readonly extra: readonly string[]; readonly fetch: boolean },
): Promise<string | undefined> {
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(target);
  } catch {
    return undefined;
  }
  const conflict = () => new CloneError("CLONE_TARGET_CONFLICT", field);
  if (st.isSymbolicLink() || !st.isDirectory()) throw conflict();
  const canonical = await realpath(target);
  if (!isUnderAllowedRoot(canonical, [settings.cloneRoot])) throw conflict();
  const top = await git([...SAFE, "rev-parse", "--show-toplevel"], { cwd: canonical, timeoutMs });
  if (!top.ok) throw conflict();
  let topLevel: string;
  try {
    topLevel = await realpath(top.stdout.trim());
  } catch {
    throw conflict();
  }
  if (topLevel !== canonical) throw conflict(); // a directory inside some other repository
  const origin = await git([...SAFE, "config", "--get", "remote.origin.url"], { cwd: canonical, timeoutMs });
  const remote = origin.ok ? parseRepositoryUrl(origin.stdout.trim()) : undefined;
  if (remote === undefined || sourceKey(remote) !== sourceKey(src)) throw conflict();
  // Best effort: a failed fetch leaves the clone as it was; base_ref is checked against it afterwards.
  if (opts.fetch) {
    await git([...SAFE, ...opts.extra, "fetch", "--no-recurse-submodules", "origin"], { cwd: canonical, timeoutMs });
  }
  return canonical;
}
