/**
 * Closed `gh` argv and JSON allowlists for the CI-failure trigger (T15.3; LLD §18.6, ADR-0050, audited like provider
 * argv per ADR-0037). Every argv is built here from validated parts, one value per argv cell, and checked against the
 * templates below before it is returned; nothing else can be spawned. The child environment is an allowlist that never
 * carries a token variable: `gh` authenticates with the operator's own stored login.
 *
 * | ID | argv (after the binary) |
 * | --- | --- |
 * | G1 | `run list --repo {owner}/{repo} --branch {branch} --limit 1 --json {G1_FIELDS}` |
 * | G2 | `run view {databaseId} --repo {owner}/{repo} --json {G2_FIELDS}` |
 * | G3 | `api repos/{owner}/{repo}/commits/{sha}/check-runs --paginate --jq {CHECK_RUNS_JQ}` (fallback, default off) |
 *
 * T15.6 (FR-QUE-06, LLD §20.1, ADR-0050 amendment 1). Only spawned when a project sets the matching switch:
 *
 * | ID | argv (after the binary) | switch |
 * | --- | --- | --- |
 * | G4 | `run view {databaseId} --repo {owner}/{repo} --json {G4_FIELDS}` | `rerun_failed` |
 * | G5 | `run rerun {databaseId} --failed --repo {owner}/{repo}` (write) | `rerun_failed` |
 * | G6 | `run list --repo {owner}/{repo} --branch {branch} --status queued --limit {QUEUED_LIMIT} --json {G6_FIELDS}` | `cancel_stale_queued` |
 * | G7 | `run view {databaseId} --repo {owner}/{repo} --json {G7_FIELDS}` | `cancel_stale_queued` |
 * | G8 | `run cancel {databaseId} --repo {owner}/{repo}` (write; never `--force`) | `cancel_stale_queued` |
 *
 * T15.7 (FR-QUE-07, LLD §20.4, ADR-0050 amendment 1 item 9), read-only, for every watched published ref:
 *
 * | ID | argv (after the binary) |
 * | --- | --- |
 * | G9 | `pr view {branch} --repo {owner}/{repo} --json {G9_FIELDS}` |
 *
 * T15.8 (FR-SUB-02, LLD §20.7, ADR-0050 amendment 1 item 10, ADR-0060). G10 and G11 are reads; G12 is the one merge
 * write verb, spawned only for a project whose `merge_policy.enabled` is on and only after the gate held. Never
 * `--admin`, `--auto` or `--delete-branch`:
 *
 * | ID | argv (after the binary) |
 * | --- | --- |
 * | G10 | `pr view {branch} --repo {owner}/{repo} --json {G10_FIELDS}` |
 * | G11 | `pr checks {number} --repo {owner}/{repo} --required --json {G11_FIELDS}` |
 * | G12 | `pr merge {number} --repo {owner}/{repo} --{squash\|merge\|rebase} --match-head-commit {sha}` (write) |
 *
 * ADR-0069 (MCP `publish_run`, LLD §3.4.12). G14 is a read; G13 is the one pull-request write verb, spawned only by
 * `publish_run` after the controller push of the same branch was accepted. Title and body are controller-built cells
 * ({@link isPrTitle}, {@link isPrBody}); never `--fill`, `--web`, `--assignee`, `--reviewer` or `--label`:
 *
 * | ID | argv (after the binary) |
 * | --- | --- |
 * | G13 | `pr create --repo {owner}/{repo} --head {branch} --base {base} --title {title} --body {body} [--draft]` (write) |
 * | G14 | `pr view {branch} --repo {owner}/{repo} --json {G14_FIELDS}` |
 */

export const G1_FIELDS = "databaseId,conclusion,headBranch,status,headSha";
export const G2_FIELDS = "databaseId,conclusion,status";
/** G4: the run attempt and its jobs (`gh` 2.102.0 lists both fields for `run view`). */
export const G4_FIELDS = "attempt,jobs";
export const G6_FIELDS = "databaseId,conclusion,headBranch,status,headSha";
export const G7_FIELDS = "databaseId,status,headSha";
/** G9: the pull request's mergeability (`gh` 2.102.0 `pr view --help` lists all five fields). */
export const G9_FIELDS = "number,state,isDraft,mergeable,headRefOid";
/** G10: the merge gate's read (`gh pr view` manual lists all seven fields; G9 plus the head and base branch names). */
export const G10_FIELDS = "number,state,isDraft,mergeable,headRefOid,headRefName,baseRefName";
/** G14: the link facts of the pull request whose head is the pushed branch (ADR-0069). */
export const G14_FIELDS = "number,state,url";
/** ADR-0069: most characters of a G13 title cell (controller-built: `switchboard: ` and at most 120 of the run's). */
export const PR_TITLE_MAX = 200;
/** ADR-0069: most bytes of a G13 body cell (controller footer plus the capped agent-written draft). */
export const PR_BODY_MAX_BYTES = 20 * 1024;
/** G11: only the result bucket of each required check (`gh pr checks` manual: `pass`, `fail`, `pending`, ...). */
export const G11_FIELDS = "bucket";
/** G12 merge methods; each is one `gh pr merge` flag (`--squash`, `--merge`, `--rebase`). */
export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];
/** G6 page size: queued runs read per published ref and poll (Assumption: enough for one ref's backlog). */
export const QUEUED_LIMIT = "20";
/**
 * Fixed G3 filter: one compact object per completed check run. `--paginate` applies `--jq` per page, so the latest run
 * is chosen in code, not in the filter. The REST check-run id field is `id`.
 */
export const CHECK_RUNS_JQ = '.check_runs[] | select(.status == "completed") | {id, conclusion, completed_at}';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPO = /^[A-Za-z0-9._-]{1,100}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const DATABASE_ID = /^[1-9][0-9]{0,19}$/u;
const PR_NUMBER = /^[1-9][0-9]{0,9}$/u;

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

export function isPrNumber(s: string): boolean {
  return PR_NUMBER.test(s);
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

/** C0 controls (tab and newline aside) and DEL; a title allows none of them, a body only tab, LF and CR. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find control characters
const TITLE_CONTROL = /[\u0000-\u001f\u007f]/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find control characters
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/** A G13 title cell: one line, no control character, never read as a flag, at most {@link PR_TITLE_MAX} characters. */
export function isPrTitle(s: string): boolean {
  return s.length > 0 && s.length <= PR_TITLE_MAX && !s.startsWith("-") && !TITLE_CONTROL.test(s);
}

/** A G13 body cell: no control character but tab and line breaks, never read as a flag, bounded in bytes. */
export function isPrBody(s: string): boolean {
  return (
    s.length > 0 && Buffer.byteLength(s, "utf8") <= PR_BODY_MAX_BYTES && !s.startsWith("-") && !BODY_CONTROL.test(s)
  );
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

/** G4: attempt and jobs of a completed run (rerun once, T15.6). */
export function ghRunJobsArgv(owner: string, repo: string, databaseId: string): string[] {
  if (!isDatabaseId(databaseId)) throw new GhArgvError("invalid run id");
  return audited(["run", "view", databaseId, "--repo", repoArg(owner, repo), "--json", G4_FIELDS]);
}

/** G5: rerun the failed jobs of one run (T15.6 write verb). */
export function ghRunRerunFailedArgv(owner: string, repo: string, databaseId: string): string[] {
  if (!isDatabaseId(databaseId)) throw new GhArgvError("invalid run id");
  return audited(["run", "rerun", databaseId, "--failed", "--repo", repoArg(owner, repo)]);
}

/** G6: queued runs on a published branch (stale cancel, T15.6). */
export function ghRunListQueuedArgv(owner: string, repo: string, branch: string): string[] {
  if (!isSafeBranch(branch)) throw new GhArgvError("invalid branch");
  return audited([
    "run",
    "list",
    "--repo",
    repoArg(owner, repo),
    "--branch",
    branch,
    "--status",
    "queued",
    "--limit",
    QUEUED_LIMIT,
    "--json",
    G6_FIELDS,
  ]);
}

/** G7: re-read one run's status and head immediately before a cancel. */
export function ghRunHeadArgv(owner: string, repo: string, databaseId: string): string[] {
  if (!isDatabaseId(databaseId)) throw new GhArgvError("invalid run id");
  return audited(["run", "view", databaseId, "--repo", repoArg(owner, repo), "--json", G7_FIELDS]);
}

/** G8: cancel one queued run (T15.6 write verb; never `--force`). */
export function ghRunCancelArgv(owner: string, repo: string, databaseId: string): string[] {
  if (!isDatabaseId(databaseId)) throw new GhArgvError("invalid run id");
  return audited(["run", "cancel", databaseId, "--repo", repoArg(owner, repo)]);
}

/** G9: mergeability of the pull request whose head is the published branch (T15.7, read-only). */
export function ghPrViewArgv(owner: string, repo: string, branch: string): string[] {
  if (!isSafeBranch(branch)) throw new GhArgvError("invalid branch");
  return audited(["pr", "view", branch, "--repo", repoArg(owner, repo), "--json", G9_FIELDS]);
}

/** G10: the merge gate's view of the pull request whose head is the published branch (T15.8, read-only). */
export function ghPrGateViewArgv(owner: string, repo: string, branch: string): string[] {
  if (!isSafeBranch(branch)) throw new GhArgvError("invalid branch");
  return audited(["pr", "view", branch, "--repo", repoArg(owner, repo), "--json", G10_FIELDS]);
}

/** G11: the required checks of one pull request's head (T15.8, read-only). */
export function ghPrRequiredChecksArgv(owner: string, repo: string, prNumber: string): string[] {
  if (!isPrNumber(prNumber)) throw new GhArgvError("invalid pull request number");
  return audited(["pr", "checks", prNumber, "--repo", repoArg(owner, repo), "--required", "--json", G11_FIELDS]);
}

/** G12: merge one pull request pinned to its head SHA (T15.8 write verb). */
export function ghPrMergeArgv(
  owner: string,
  repo: string,
  prNumber: string,
  method: MergeMethod,
  sha: string,
): string[] {
  if (!isPrNumber(prNumber)) throw new GhArgvError("invalid pull request number");
  if (!(MERGE_METHODS as readonly string[]).includes(method)) throw new GhArgvError("invalid merge method");
  if (!isFullLowerSha(sha)) throw new GhArgvError("invalid commit id");
  return audited(["pr", "merge", prNumber, "--repo", repoArg(owner, repo), `--${method}`, "--match-head-commit", sha]);
}

/** G13: open a pull request for the pushed branch (ADR-0069 write verb). */
export function ghPrCreateArgv(
  owner: string,
  repo: string,
  branch: string,
  base: string,
  title: string,
  body: string,
  draft: boolean,
): string[] {
  if (!isSafeBranch(branch) || !isSafeBranch(base)) throw new GhArgvError("invalid branch");
  if (!isPrTitle(title)) throw new GhArgvError("invalid pull request title");
  if (!isPrBody(body)) throw new GhArgvError("invalid pull request body");
  const argv = ["pr", "create", "--repo", repoArg(owner, repo), "--head", branch, "--base", base];
  argv.push("--title", title, "--body", body);
  if (draft) argv.push("--draft");
  return audited(argv);
}

/** G14: the pull request whose head is the pushed branch, link facts only (ADR-0069, read-only). */
export function ghPrLinkViewArgv(owner: string, repo: string, branch: string): string[] {
  if (!isSafeBranch(branch)) throw new GhArgvError("invalid branch");
  return audited(["pr", "view", branch, "--repo", repoArg(owner, repo), "--json", G14_FIELDS]);
}

/**
 * The argv audit: true only for an argv that is exactly one of G1 to G14 with validated values in the value cells.
 * Builders call it before returning, so a template edit that drifts fails closed.
 */
export function isAllowedGhArgv(argv: readonly string[]): boolean {
  const ownerRepo = (s: string | undefined): boolean => {
    if (s === undefined) return false;
    const parts = s.split("/");
    return parts.length === 2 && isGhOwner(parts[0] as string) && isGhRepo(parts[1] as string);
  };
  if (argv[0] === "run" && argv[1] === "list" && argv.length === 12) {
    return (
      argv[2] === "--repo" &&
      ownerRepo(argv[3]) &&
      argv[4] === "--branch" &&
      isSafeBranch(argv[5] ?? "") &&
      argv[6] === "--status" &&
      argv[7] === "queued" &&
      argv[8] === "--limit" &&
      argv[9] === QUEUED_LIMIT &&
      argv[10] === "--json" &&
      argv[11] === G6_FIELDS
    );
  }
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
      (argv[6] === G2_FIELDS || argv[6] === G4_FIELDS || argv[6] === G7_FIELDS)
    );
  }
  if (argv[0] === "run" && argv[1] === "rerun") {
    return (
      argv.length === 6 &&
      isDatabaseId(argv[2] ?? "") &&
      argv[3] === "--failed" &&
      argv[4] === "--repo" &&
      ownerRepo(argv[5])
    );
  }
  if (argv[0] === "run" && argv[1] === "cancel") {
    return argv.length === 5 && isDatabaseId(argv[2] ?? "") && argv[3] === "--repo" && ownerRepo(argv[4]);
  }
  if (argv[0] === "pr" && argv[1] === "view") {
    return (
      argv.length === 7 &&
      isSafeBranch(argv[2] ?? "") &&
      argv[3] === "--repo" &&
      ownerRepo(argv[4]) &&
      argv[5] === "--json" &&
      (argv[6] === G9_FIELDS || argv[6] === G10_FIELDS || argv[6] === G14_FIELDS)
    );
  }
  if (argv[0] === "pr" && argv[1] === "create") {
    return (
      (argv.length === 12 || (argv.length === 13 && argv[12] === "--draft")) &&
      argv[2] === "--repo" &&
      ownerRepo(argv[3]) &&
      argv[4] === "--head" &&
      isSafeBranch(argv[5] ?? "") &&
      argv[6] === "--base" &&
      isSafeBranch(argv[7] ?? "") &&
      argv[8] === "--title" &&
      isPrTitle(argv[9] ?? "") &&
      argv[10] === "--body" &&
      isPrBody(argv[11] ?? "")
    );
  }
  if (argv[0] === "pr" && argv[1] === "checks") {
    return (
      argv.length === 8 &&
      isPrNumber(argv[2] ?? "") &&
      argv[3] === "--repo" &&
      ownerRepo(argv[4]) &&
      argv[5] === "--required" &&
      argv[6] === "--json" &&
      argv[7] === G11_FIELDS
    );
  }
  if (argv[0] === "pr" && argv[1] === "merge") {
    return (
      argv.length === 8 &&
      isPrNumber(argv[2] ?? "") &&
      argv[3] === "--repo" &&
      ownerRepo(argv[4]) &&
      MERGE_METHODS.some((m) => argv[5] === `--${m}`) &&
      argv[6] === "--match-head-commit" &&
      isFullLowerSha(argv[7] ?? "")
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

/** One job of a G4 run after the closed allowlist. `name` is untrusted text from the workflow file. */
export interface GhJobFields {
  name: string;
  status: string;
  conclusion: string;
}

/** G4 run fields: the attempt number and its jobs. */
export interface GhRunJobsFields {
  attempt: number;
  jobs: GhJobFields[];
}

/** A job name kept as a dedup key: 1 to 200 characters, no control characters. */
export const JOB_NAME_MAX = 200;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the class refuses control characters on purpose
const CONTROL = /[\u0000-\u001f\u007f]/u;

/**
 * G4 stdout: `{attempt, jobs: [{name, status, conclusion}]}`; every other job property is dropped. The job sub-fields
 * are an Assumption (`gh run view --help` lists `jobs` but not its members). Throws on anything else.
 */
export function parseRunJobs(stdout: string): GhRunJobsFields {
  const o = JSON.parse(stdout) as unknown;
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new Error("unexpected run shape");
  const r = o as Record<string, unknown>;
  if (typeof r.attempt !== "number" || !Number.isSafeInteger(r.attempt) || r.attempt < 1) {
    throw new Error("unexpected attempt");
  }
  if (!Array.isArray(r.jobs)) throw new Error("unexpected jobs");
  const jobs = r.jobs.map((raw: unknown): GhJobFields => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("unexpected job shape");
    const j = raw as Record<string, unknown>;
    const name = str(j.name);
    const status = str(j.status);
    const conclusion = j.conclusion === null ? "" : str(j.conclusion);
    if (name === undefined || status === undefined || conclusion === undefined) throw new Error("unexpected job");
    if (name.length === 0 || name.length > JOB_NAME_MAX || CONTROL.test(name)) throw new Error("unexpected job name");
    return { name, status, conclusion };
  });
  return { attempt: r.attempt, jobs };
}

/** G6 stdout: a JSON array of at most {@link QUEUED_LIMIT} runs with their heads. Throws on anything else. */
export function parseQueuedRuns(stdout: string): GhRunFields[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length > Number(QUEUED_LIMIT)) throw new Error("unexpected run list shape");
  return parsed.map((raw) => {
    const run = pickRunFields(raw, true);
    if (run === undefined) throw new Error("unexpected run fields");
    return run;
  });
}

/** G7 stdout: `{databaseId, status, headSha}`. Throws on anything else. */
export function parseRunHead(stdout: string): { databaseId: string; status: string; headSha: string } {
  const o = JSON.parse(stdout) as unknown;
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new Error("unexpected run shape");
  const r = o as Record<string, unknown>;
  const databaseId = idOf(r.databaseId);
  const status = str(r.status);
  const headSha = str(r.headSha);
  if (databaseId === undefined || status === undefined || headSha === undefined) throw new Error("unexpected run");
  return { databaseId, status, headSha };
}

/** G9 fields after the closed allowlist. `mergeable` is `MERGEABLE`, `CONFLICTING` or `UNKNOWN`. */
export interface GhPrViewFields {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  headRefOid: string;
}

const PR_STATES: ReadonlySet<string> = new Set(["OPEN", "CLOSED", "MERGED"]);
const MERGEABLE: ReadonlySet<string> = new Set(["MERGEABLE", "CONFLICTING", "UNKNOWN"]);

/** G9 stdout: one pull request object; every other property is dropped. Throws on anything else. */
export function parsePrView(stdout: string): GhPrViewFields {
  const o = JSON.parse(stdout) as unknown;
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new Error("unexpected pr shape");
  const r = o as Record<string, unknown>;
  if (typeof r.number !== "number" || !Number.isSafeInteger(r.number) || r.number < 1) throw new Error("unexpected pr");
  if (typeof r.state !== "string" || !PR_STATES.has(r.state)) throw new Error("unexpected pr state");
  if (typeof r.isDraft !== "boolean") throw new Error("unexpected pr draft flag");
  if (typeof r.mergeable !== "string" || !MERGEABLE.has(r.mergeable)) throw new Error("unexpected mergeable");
  if (typeof r.headRefOid !== "string" || !isFullLowerSha(r.headRefOid.toLowerCase()))
    throw new Error("unexpected head");
  return {
    number: r.number,
    state: r.state as GhPrViewFields["state"],
    isDraft: r.isDraft,
    mergeable: r.mergeable as GhPrViewFields["mergeable"],
    headRefOid: r.headRefOid.toLowerCase(),
  };
}

/** G10 fields after the closed allowlist: G9's plus the head and base branch names. */
export interface GhPrGateViewFields extends GhPrViewFields {
  headRefName: string;
  baseRefName: string;
}

/** G10 stdout: G9's checks, plus two branch names that must be safe branch names. Throws on anything else. */
export function parsePrGateView(stdout: string): GhPrGateViewFields {
  const base = parsePrView(stdout);
  const r = JSON.parse(stdout) as Record<string, unknown>;
  if (typeof r.headRefName !== "string" || !isSafeBranch(r.headRefName)) throw new Error("unexpected head branch");
  if (typeof r.baseRefName !== "string" || !isSafeBranch(r.baseRefName)) throw new Error("unexpected base branch");
  return { ...base, headRefName: r.headRefName, baseRefName: r.baseRefName };
}

/** `gh pr checks` buckets (`gh pr checks` manual); anything else is a parse failure. */
export const CHECK_BUCKETS = ["pass", "fail", "pending", "skipping", "cancel"] as const;
export type CheckBucket = (typeof CHECK_BUCKETS)[number];

/** At most this many required checks are read (Assumption: more than any branch protection lists). */
export const REQUIRED_CHECKS_MAX = 200;

/** G11 stdout: a JSON array of `{bucket}`; every other property is dropped. Throws on anything else. */
export function parseRequiredChecks(stdout: string): CheckBucket[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length > REQUIRED_CHECKS_MAX) throw new Error("unexpected checks shape");
  return parsed.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("unexpected check shape");
    const b = (raw as Record<string, unknown>).bucket;
    if (typeof b !== "string" || !(CHECK_BUCKETS as readonly string[]).includes(b))
      throw new Error("unexpected bucket");
    return b as CheckBucket;
  });
}

/** G14 fields after the closed allowlist (ADR-0069). */
export interface GhPrLinkFields {
  number: number;
  state: string;
  url: string;
}

/**
 * A pull request URL exactly as github.com prints it for `owner/repo`: `https://github.com/<owner>/<repo>/pull/<n>`
 * (case-insensitive owner and repository, as GitHub treats them). Returns the number, or undefined for anything else.
 */
export function pullRequestNumberOf(url: string, owner: string, repo: string): number | undefined {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9][0-9]{0,9})$/u.exec(url);
  if (m === null) return undefined;
  if ((m[1] as string).toLowerCase() !== owner.toLowerCase() || (m[2] as string).toLowerCase() !== repo.toLowerCase()) {
    return undefined;
  }
  const n = Number(m[3]);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** G14 stdout: one object with `number`, `state` and a URL of `owner/repo`. Throws on anything else. */
export function parsePrLinkView(stdout: string, owner: string, repo: string): GhPrLinkFields {
  const o = JSON.parse(stdout) as unknown;
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new Error("unexpected pull request shape");
  const r = o as Record<string, unknown>;
  const state = str(r.state);
  const url = str(r.url);
  const number = typeof r.number === "number" && Number.isSafeInteger(r.number) && r.number > 0 ? r.number : undefined;
  if (state === undefined || url === undefined || number === undefined || !/^[A-Z_]{1,20}$/u.test(state)) {
    throw new Error("unexpected pull request fields");
  }
  if (pullRequestNumberOf(url, owner, repo) !== number) throw new Error("pull request URL does not match");
  return { number, state, url };
}

/** G13 stdout: `gh pr create` prints the new pull request's URL (the last non-empty line). Throws on anything else. */
export function parsePrCreated(stdout: string, owner: string, repo: string): { number: number; url: string } {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const url = lines[lines.length - 1] ?? "";
  const number = pullRequestNumberOf(url, owner, repo);
  if (number === undefined) throw new Error("unexpected pull request URL");
  return { number, url };
}
