/**
 * Closed `gh` argv and JSON allowlists for the CI-failure trigger (T15.3; LLD §18.6, ADR-0050, audited like provider
 * argv per ADR-0037). Every argv is built here from validated parts, one value per argv cell, and checked against the
 * three templates before it is returned; nothing else can be spawned. The child environment is an allowlist that never
 * carries a token variable: `gh` authenticates with the operator's own stored login.
 *
 * | ID | argv (after the binary) |
 * | --- | --- |
 * | G1 | `run list --repo {owner}/{repo} --branch {branch} --limit 1 --json {G1_FIELDS}` |
 * | G2 | `run view {databaseId} --repo {owner}/{repo} --json {G2_FIELDS}` |
 * | G3 | `api repos/{owner}/{repo}/commits/{sha}/check-runs --paginate --jq {CHECK_RUNS_JQ}` (fallback, default off) |
 */

export const G1_FIELDS = "databaseId,conclusion,headBranch,status,headSha";
export const G2_FIELDS = "databaseId,conclusion,status";
/**
 * Fixed G3 filter: one compact object per completed check run. `--paginate` applies `--jq` per page, so the latest run
 * is chosen in code, not in the filter. The REST check-run id field is `id`.
 */
export const CHECK_RUNS_JQ = '.check_runs[] | select(.status == "completed") | {id, conclusion, completed_at}';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPO = /^[A-Za-z0-9._-]{1,100}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const DATABASE_ID = /^[1-9][0-9]{0,19}$/u;

export function isGhOwner(s: string): boolean {
  return OWNER.test(s);
}

export function isGhRepo(s: string): boolean {
  return REPO.test(s) && s !== "." && s !== "..";
}

export function isFullLowerSha(s: string): boolean {
  return SHA.test(s);
}

export function isDatabaseId(s: string): boolean {
  return DATABASE_ID.test(s);
}

/**
 * A branch name safe as one argv cell: letters, digits, `.`, `_`, `-`, `/`; never starting with `-` (it could read as a
 * flag) or `/`; no `..`, `//`, `@{`, trailing `/` or `.lock`; at most 255 characters.
 */
export function isSafeBranch(s: string): boolean {
  if (s.length === 0 || s.length > 255) return false;
  if (!/^[A-Za-z0-9._/-]+$/u.test(s)) return false;
  if (s.startsWith("-") || s.startsWith("/") || s.startsWith(".") || s.endsWith("/") || s.endsWith(".lock"))
    return false;
  return !s.includes("..") && !s.includes("//") && !s.includes("/.");
}

/** `refs/heads/<branch>` → `<branch>`, or undefined for any other kind of ref or an unsafe name. */
export function branchOfPublishRef(ref: string): string | undefined {
  if (!ref.startsWith("refs/heads/")) return undefined;
  const branch = ref.slice("refs/heads/".length);
  return isSafeBranch(branch) ? branch : undefined;
}

export class GhArgvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhArgvError";
  }
}

const repoArg = (owner: string, repo: string): string => {
  if (!isGhOwner(owner) || !isGhRepo(repo)) throw new GhArgvError("invalid owner/repo");
  return `${owner}/${repo}`;
};

/** G1: latest workflow run on the published branch. */
export function ghRunListArgv(owner: string, repo: string, branch: string): string[] {
  if (!isSafeBranch(branch)) throw new GhArgvError("invalid branch");
  return audited([
    "run",
    "list",
    "--repo",
    repoArg(owner, repo),
    "--branch",
    branch,
    "--limit",
    "1",
    "--json",
    G1_FIELDS,
  ]);
}

/** G2: confirm the terminal conclusion of the run G1 returned. */
export function ghRunViewArgv(owner: string, repo: string, databaseId: string): string[] {
  if (!isDatabaseId(databaseId)) throw new GhArgvError("invalid run id");
  return audited(["run", "view", databaseId, "--repo", repoArg(owner, repo), "--json", G2_FIELDS]);
}

/** G3: completed check runs on the tip commit (only when the operator enables the fallback). */
export function ghCheckRunsArgv(owner: string, repo: string, sha: string): string[] {
  if (!isFullLowerSha(sha)) throw new GhArgvError("invalid commit id");
  const path = `repos/${repoArg(owner, repo)}/commits/${sha}/check-runs`;
  return audited(["api", path, "--paginate", "--jq", CHECK_RUNS_JQ]);
}

/**
 * The argv audit: true only for an argv that is exactly one of G1 to G3 with validated values in the value cells.
 * Builders call it before returning, so a template edit that drifts fails closed.
 */
export function isAllowedGhArgv(argv: readonly string[]): boolean {
  const ownerRepo = (s: string | undefined): boolean => {
    if (s === undefined) return false;
    const parts = s.split("/");
    return parts.length === 2 && isGhOwner(parts[0] as string) && isGhRepo(parts[1] as string);
  };
  if (argv[0] === "run" && argv[1] === "list") {
    return (
      argv.length === 10 &&
      argv[2] === "--repo" &&
      ownerRepo(argv[3]) &&
      argv[4] === "--branch" &&
      isSafeBranch(argv[5] ?? "") &&
      argv[6] === "--limit" &&
      argv[7] === "1" &&
      argv[8] === "--json" &&
      argv[9] === G1_FIELDS
    );
  }
  if (argv[0] === "run" && argv[1] === "view") {
    return (
      argv.length === 7 &&
      isDatabaseId(argv[2] ?? "") &&
      argv[3] === "--repo" &&
      ownerRepo(argv[4]) &&
      argv[5] === "--json" &&
      argv[6] === G2_FIELDS
    );
  }
  if (argv[0] === "api") {
    const m = /^repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]{40})\/check-runs$/u.exec(argv[1] ?? "");
    return (
      argv.length === 5 &&
      m !== null &&
      ownerRepo(`${m[1]}/${m[2]}`) &&
      argv[2] === "--paginate" &&
      argv[3] === "--jq" &&
      argv[4] === CHECK_RUNS_JQ
    );
  }
  return false;
}

function audited(argv: string[]): string[] {
  if (!isAllowedGhArgv(argv)) throw new GhArgvError("gh argv outside the allowlist");
  return argv;
}

/**
 * Variables copied from the controller's environment into `gh`: where it finds the operator's configuration and stored
 * login (`HOME`, `XDG_CONFIG_HOME`, `GH_CONFIG_DIR`), the keyring's session bus, and HTTPS proxy and CA settings. No
 * token variable (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`) and no `GH_HOST` or
 * `GH_REPO` is ever passed.
 */
export const GH_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "GH_CONFIG_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

/** The `gh` environment: allowlisted variables only, then fixed non-interactive settings. */
export function ghEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of GH_ENV_ALLOWLIST) {
    const v = source[key];
    if (typeof v === "string" && v !== "") env[key] = v;
  }
  env.GH_PROMPT_DISABLED = "1";
  env.GH_NO_UPDATE_NOTIFIER = "1";
  env.GH_NO_EXTENSION_UPDATE_NOTIFIER = "1";
  env.GH_SPINNER_DISABLED = "1";
  env.NO_COLOR = "1";
  env.LC_ALL = "C";
  return env;
}

/** G1/G2 run fields after the closed allowlist; every other property of `gh` output is dropped. */
export interface GhRunFields {
  databaseId: string;
  conclusion: string;
  status: string;
  headBranch?: string;
  headSha?: string;
}

/** G3 check-run fields after the closed allowlist. */
export interface GhCheckRunFields {
  databaseId: string;
  conclusion: string;
  completedAt: string;
}

const idOf = (v: unknown): string | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? String(v) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** One run object, keeping only allowlisted fields; undefined when a required field is missing or mistyped. */
export function pickRunFields(raw: unknown, withHead: boolean): GhRunFields | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const databaseId = idOf(o.databaseId);
  const status = str(o.status);
  const conclusion = o.conclusion === null ? "" : str(o.conclusion);
  if (databaseId === undefined || status === undefined || conclusion === undefined) return undefined;
  if (!withHead) return { databaseId, conclusion, status };
  const headBranch = str(o.headBranch);
  const headSha = str(o.headSha);
  if (headBranch === undefined || headSha === undefined) return undefined;
  return { databaseId, conclusion, status, headBranch, headSha };
}

/** G1 stdout: a JSON array of at most one run. Throws on anything else. */
export function parseRunList(stdout: string): GhRunFields | null {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length > 1) throw new Error("unexpected run list shape");
  if (parsed.length === 0) return null;
  const run = pickRunFields(parsed[0], true);
  if (run === undefined) throw new Error("unexpected run fields");
  return run;
}

/** G2 stdout: one run object. Throws on anything else. */
export function parseRunView(stdout: string): GhRunFields {
  const run = pickRunFields(JSON.parse(stdout) as unknown, false);
  if (run === undefined) throw new Error("unexpected run fields");
  return run;
}

/** G3 stdout: one compact JSON object per line (the fixed filter's output). Returns the latest completed check run. */
export function parseCheckRuns(stdout: string): GhCheckRunFields | null {
  let latest: GhCheckRunFields | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const o = JSON.parse(line) as Record<string, unknown>;
    if (typeof o !== "object" || o === null || Array.isArray(o)) throw new Error("unexpected check run shape");
    const databaseId = idOf(o.id);
    const conclusion = str(o.conclusion);
    const completedAt = str(o.completed_at);
    if (databaseId === undefined || conclusion === undefined || completedAt === undefined) {
      throw new Error("unexpected check run fields");
    }
    if (latest === null || completedAt > latest.completedAt) latest = { databaseId, conclusion, completedAt };
  }
  return latest;
}
