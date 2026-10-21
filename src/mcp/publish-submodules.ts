/**
 * Linked publication of an umbrella run's submodule commits (ADR-0080 items 5 and 6, FR-GIT-15, LLD §3.4.17): the part
 * of `publish_run` that runs before the umbrella push when the project's primary context sets
 * `submodules.mode: "recursive"`. `src/mcp/publish.ts` drives it and opens the pull requests; this module does the Git
 * work and never touches the umbrella's own push (the {@link import("../git/push.js").GitPusher} still does that, with
 * its own scan, unchanged).
 *
 * 1. {@link linkedRepos}: the gitlinks that differ between the meta-session's base commit and the umbrella publish head
 *    (`git diff-tree`, mode `160000`), grouped by repository (duplicate-URL paths are one repository) through the
 *    manifest of the head read with the context's current lists and the live `project_sources`. Every changed gitlink
 *    must be a recorded `submodule_commit` of the meta-session for that repository, and so must every commit between
 *    the base gitlink and it in the repository's store; otherwise `PERMISSION_BLOCKED` `SUBMODULE_HISTORY_UNVERIFIED`
 *    (with `details.path`), before any scan or push.
 * 2. {@link scanLinked} (item 5): the outgoing range of every changed repository (from its last accepted push of the same
 *    branch when that is an ancestor of the head, else from the base gitlink) and of the umbrella (base commit to
 *    publish head), with the operator allowlist matched against the umbrella-relative path. Any finding refuses the whole
 *    publication with the ADR-0075 shape plus `details.repos`; each finding's `path` is prefixed with the submodule path
 *    (the first path of a duplicate-URL repository). One `secret_scan_hit` event per finding, as the pusher records them.
 * 3. {@link pushLinked} (item 6.3 and 6.4): each repository's head to `refs/heads/<branch_prefix><meta-session>` of the
 *    store's own `origin`, which must still be exactly the repository's https source with no push URL: never forced,
 *    never its default branch (an unknown default branch refuses, fail closed), the ADR-0028 push environment and
 *    `-c` hardening with `https` as the only transport ({@link submodulePushArgs}), and an argv that names no URL and no
 *    credential. One `submodule_push` row per attempt; an accepted push of the same head to the same branch is reused.
 *    A wiki or a repository with no writable path is refused (`SUBMODULE_READ_ONLY`; defensive: such a gitlink is never
 *    bumped by the controller). Unless every repository is accepted, the call is refused `SUBMODULE_PUSH_FAILED`
 *    (`PERMISSION_BLOCKED` when any refusal is a policy refusal, else `TOOL_FAILURE`) with `details.submodules`, and
 *    the umbrella is not pushed; a retry pushes only what is missing.
 *
 * Calls for one meta-session run one at a time in this process.
 */
import { realpath } from "node:fs/promises";
import type Database from "better-sqlite3";
import type { ProjectSourcesSettings } from "../config/index.js";
import {
  classifyPush,
  DEFAULT_PUSH_TIMEOUT_MS,
  type GitPushRun,
  MAX_PUSH_COMMITS,
  MAX_SECRET_SCAN_HIT_EVENTS,
  pushEnv,
  repoConfigUnsafe,
  runGitPush,
  submodulePushArgs,
} from "../git/push.js";
import {
  compileSecretScanAllow,
  describeSecretScanFindings,
  SECRET_SCAN_FIX_HINT,
  SECRET_SCAN_HIT_EVENT,
  type SecretScanAllowEntry,
  type SecretScanHit,
  scanOutgoingDiff,
  secretScanFindings,
} from "../git/secret-scan.js";
import type { Ledger, RunRecord } from "../ledger/index.js";
import { cloneTarget, type GitRunner, parseRepositoryUrl, sourceKey } from "../projects/clone.js";
import { SubmoduleError } from "../submodules/errors.js";
import {
  findAcceptedSubmodulePush,
  insertSubmodulePush,
  isSessionSubmoduleCommit,
  latestAcceptedSubmodulePush,
  type SubmodulePushOutcome,
} from "../submodules/ledger.js";
import { defaultBranchOf, hasCommit } from "../submodules/store.js";
import { git, gitText } from "../workspace/git.js";
import { nativeSkillPresent } from "../workspace/native-skills.js";
import { planManifest, type SubmodulePlan } from "../workspace/submodules.js";
import { ToolError } from "./errors.js";

/** What `serve` wires into `publish_run` for umbrella projects (ADR-0080 item 6). */
export interface PublishSubmoduleDeps {
  /** The ledger's database (the submodule tables). */
  readonly db: Database.Database;
  /** The primary context's `submodules` plan of a project; undefined unless `mode: "recursive"`. */
  readonly plan: (projectId: string) => SubmodulePlan | undefined;
  /** The live effective `project_sources` (its `clone_root` holds the stores). */
  readonly sources: () => ProjectSourcesSettings | undefined;
  /** `git.secret_scan.allow`, as the pusher has it; matched against umbrella-relative paths. */
  readonly secretScanAllow?: readonly SecretScanAllowEntry[];
  /** Environment the push allowlist is copied from (default `process.env`). */
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  /** Wall-clock bound of one push (default {@link DEFAULT_PUSH_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** Network Git of the stores (`remote set-head` when `origin/HEAD` is unknown); test seam. */
  readonly git?: GitRunner;
  /** The push itself (default {@link runGitPush} with the ADR-0028 environment); test seam, argv unchanged. */
  readonly push?: (cwd: string, args: readonly string[], timeoutMs: number) => Promise<GitPushRun>;
  /** A store's `origin` URL as a GitHub `owner/repo` (default: github.com https URLs only); test seam. */
  readonly githubRepo?: (url: string) => { owner: string; repo: string } | undefined;
}

/** One changed submodule repository of a publication. */
export interface LinkedRepo {
  /** `host/owner/repo`. */
  readonly key: string;
  /** Changed umbrella-relative paths referencing it, sorted (duplicate-URL paths together). */
  readonly paths: readonly string[];
  /** Canonical store path. */
  readonly store: string;
  /** The gitlinks of the paths in the umbrella base commit (one per distinct value). */
  readonly bases: readonly string[];
  /** The gitlink in the umbrella publish head: the commit pushed. */
  readonly headSha: string;
  /** Some path of the repository is writable, and it is not a wiki. */
  readonly writable: boolean;
}

/** Per-repository outcome of the push step (`details.submodules` of a refusal, and the result's source). */
export interface LinkedPushOutcome {
  readonly repo: string;
  readonly paths: readonly string[];
  readonly branch: string;
  readonly head_sha: string;
  readonly outcome: SubmodulePushOutcome;
  /** `ok` for an accepted push, else a closed code. */
  readonly reason: string;
  readonly push_id: string;
  readonly pushed_at: string;
  readonly reused: boolean;
  /** The repository's default branch, when it is known. */
  readonly default_branch?: string;
}

/** `details.repos` name of the umbrella repository itself in a secret-scan refusal. */
export const UMBRELLA_REPO_LABEL = "umbrella";

const unverified = (path: string) =>
  new ToolError(
    "PERMISSION_BLOCKED",
    "publication refused (SUBMODULE_HISTORY_UNVERIFIED): a changed submodule gitlink is not a commit this controller " +
      "made for the meta-session",
    { reason: "SUBMODULE_HISTORY_UNVERIFIED", path },
  );

/** The umbrella repository and base commit of a meta-session, as the pusher reads them. */
export function umbrellaOf(db: Database.Database, metaSessionId: string): { repo: string; base: string } | undefined {
  const row = db.prepare("SELECT repo_root, base_commit FROM meta_session WHERE id = ?").get(metaSessionId) as
    | { repo_root: string | null; base_commit: string | null }
    | undefined;
  if (row?.repo_root == null || row.base_commit == null) return undefined;
  return { repo: row.repo_root, base: row.base_commit };
}

/**
 * The meta-session gates the umbrella pusher applies, checked before any submodule push so a publication the pusher
 * would refuse never reaches a submodule remote first: the context's repository is the meta-session's, no recorded Git
 * policy violation (Q-44) and no native skill file present (T16.6). Throws the pusher's `PERMISSION_BLOCKED` reasons.
 */
export async function checkLinkedGates(
  db: Database.Database,
  metaSessionId: string,
  contextPath: string,
  umbrellaRepo: string,
): Promise<void> {
  const blocked = (reason: string) => new ToolError("PERMISSION_BLOCKED", `push refused (${reason})`, { reason });
  const same = await Promise.all([realpath(contextPath), realpath(umbrellaRepo)]).then(
    ([a, b]) => a === b,
    () => false,
  );
  if (!same) throw blocked("CONTEXT_MISMATCH");
  const violation = db
    .prepare(
      `SELECT 1 FROM run_event e JOIN run r ON r.id = e.run_id
       WHERE r.meta_session_id = ? AND e.type = 'git_policy_violation' LIMIT 1`,
    )
    .get(metaSessionId);
  if (violation !== undefined) throw blocked("GIT_POLICY_VIOLATION");
  if (await nativeSkillPresent(db, metaSessionId)) throw blocked("SKILL_PATH_PRESENT");
}

/** Step 1: the changed writable-submodule repositories of `head`, verified; empty when the project has no plan. */
export async function linkedRepos(
  deps: PublishSubmoduleDeps,
  run: RunRecord,
  umbrella: { readonly repo: string; readonly base: string; readonly head: string },
): Promise<LinkedRepo[]> {
  const plan = run.project_id === null ? undefined : deps.plan(run.project_id);
  if (plan === undefined) return [];
  const changed = await changedGitlinks(umbrella.repo, umbrella.base, umbrella.head);
  if (changed.length === 0) return [];
  let manifest: Awaited<ReturnType<typeof planManifest>>;
  try {
    manifest = await planManifest(umbrella.repo, umbrella.head, plan, { sources: deps.sources });
  } catch (err) {
    if (err instanceof SubmoduleError) {
      throw new ToolError(err.code, `publication refused (${err.reason}): ${err.message}`, {
        reason: err.reason,
        ...(err.path !== undefined ? { path: err.path } : {}),
      });
    }
    throw err;
  }
  const settings = deps.sources();
  const byPath = new Map(manifest.entries.map((e) => [e.path, e]));
  const groups = new Map<string, { paths: string[]; bases: Set<string>; heads: Set<string> }>();
  for (const c of changed) {
    const entry = byPath.get(c.path);
    if (entry === undefined || c.base === undefined) throw unverified(c.path);
    const g = groups.get(entry.key) ?? { paths: [], bases: new Set(), heads: new Set() };
    g.paths.push(c.path);
    g.bases.add(c.base);
    g.heads.add(c.head);
    groups.set(entry.key, g);
  }
  const out: LinkedRepo[] = [];
  for (const [key, g] of groups) {
    const first = g.paths[0] as string;
    const headSha = [...g.heads][0] as string;
    if (g.heads.size !== 1 || !isSessionSubmoduleCommit(deps.db, run.meta_session_id, headSha, key)) {
      throw unverified(first);
    }
    const entries = manifest.byKey.get(key) ?? [];
    const source = (entries[0] as (typeof entries)[number]).source;
    let store: string;
    try {
      if (settings === undefined) throw new Error("no project_sources");
      store = await realpath(cloneTarget(source, settings));
    } catch {
      throw new ToolError("TOOL_FAILURE", "publication failed (SUBMODULE_COMMIT_MISSING): no store holds the commit", {
        reason: "SUBMODULE_COMMIT_MISSING",
        path: first,
      });
    }
    const bases = [...g.bases].sort();
    if (!(await verifiedStoreHistory(deps.db, run.meta_session_id, key, store, bases, headSha)))
      throw unverified(first);
    out.push({
      key,
      paths: [...g.paths].sort(),
      store,
      bases,
      headSha,
      writable: entries.some((e) => e.writable),
    });
  }
  return out.sort((a, b) => ((a.paths[0] ?? "") < (b.paths[0] ?? "") ? -1 : 1));
}

/** Step 2 (item 5). Throws the ADR-0075 refusal (plus `details.repos`) when any repository has a finding. */
export async function scanLinked(
  ledger: Ledger,
  deps: PublishSubmoduleDeps,
  run: RunRecord,
  umbrella: { readonly repo: string; readonly base: string; readonly head: string; readonly ref: string },
  repos: readonly LinkedRepo[],
  ref: string,
): Promise<void> {
  const allow = compileSecretScanAllow(deps.secretScanAllow ?? []);
  const hits: (SecretScanHit & { ref: string; repo: string })[] = [];
  let hitCount = 0;
  const withRepos: string[] = [];
  const umbrellaReport = await scanOutgoingDiff(umbrella.repo, umbrella.base, umbrella.head, allow);
  if (umbrellaReport.hitCount > 0) {
    withRepos.push(UMBRELLA_REPO_LABEL);
    hitCount += umbrellaReport.hitCount;
    for (const h of umbrellaReport.hits) hits.push({ ...h, ref: umbrella.ref, repo: UMBRELLA_REPO_LABEL });
  }
  for (const r of repos) {
    const from = await scanStart(deps.db, run.meta_session_id, r, ref);
    if (from === r.headSha) continue;
    const prefix = r.paths[0] as string;
    const report = await scanOutgoingDiff(r.store, from, r.headSha, (rule, p) => allow(rule, `${prefix}/${p}`));
    if (report.hitCount === 0) continue;
    withRepos.push(r.key);
    hitCount += report.hitCount;
    for (const h of report.hits) hits.push({ ...h, path: `${prefix}/${h.path}`, ref, repo: r.key });
  }
  if (hitCount === 0) return;
  for (const hit of hits.slice(0, MAX_SECRET_SCAN_HIT_EVENTS)) {
    ledger.appendRunEvent({
      runId: run.id,
      type: SECRET_SCAN_HIT_EVENT,
      payload: { stage: "push", rule_id: hit.rule_id, path: hit.path, line: hit.line, ref: hit.ref, repo: hit.repo },
    });
  }
  const f = secretScanFindings({ hits: hits.map(({ rule_id, path, line }) => ({ rule_id, path, line })), hitCount });
  throw new ToolError(
    "PERMISSION_BLOCKED",
    `push refused (SECRET_SCAN_BLOCKED): ${describeSecretScanFindings(f)}. ${SECRET_SCAN_FIX_HINT}`,
    { reason: "SECRET_SCAN_BLOCKED", repos: withRepos, ...f },
  );
}

/** Steps 3 and 4 (item 6). Returns every repository's accepted outcome, or throws `SUBMODULE_PUSH_FAILED`. */
export async function pushLinked(
  deps: PublishSubmoduleDeps,
  run: RunRecord,
  input: {
    readonly repos: readonly LinkedRepo[];
    readonly ref: string;
    readonly umbrellaHead: string;
    readonly requestedBy: string;
  },
): Promise<LinkedPushOutcome[]> {
  const branch = input.ref.slice("refs/heads/".length);
  const outcomes: LinkedPushOutcome[] = [];
  for (const r of input.repos) {
    const defaultBranch = await defaultBranchOf(r.store, {
      key: r.key,
      ...(deps.git !== undefined ? { git: deps.git } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    }).catch(() => undefined);
    const common = {
      repo: r.key,
      paths: r.paths,
      branch,
      head_sha: r.headSha,
      ...(defaultBranch !== undefined ? { default_branch: defaultBranch } : {}),
    };
    const prior = findAcceptedSubmodulePush(deps.db, {
      metaSessionId: run.meta_session_id,
      repo: r.key,
      ref: input.ref,
      headSha: r.headSha,
    });
    if (prior !== undefined) {
      outcomes.push({
        ...common,
        outcome: "ACCEPTED",
        reason: prior.reason,
        push_id: prior.id,
        pushed_at: prior.created_at,
        reused: true,
      });
      continue;
    }
    const attempt = await pushOne(deps, r, input.ref, branch, defaultBranch);
    const row = insertSubmodulePush(deps.db, {
      runId: run.id,
      metaSessionId: run.meta_session_id,
      projectId: run.project_id ?? "",
      repo: r.key,
      paths: r.paths,
      ref: input.ref,
      headSha: r.headSha,
      umbrellaHeadSha: input.umbrellaHead,
      outcome: attempt.outcome,
      reason: attempt.reason,
      requestedBy: input.requestedBy,
    });
    outcomes.push({ ...common, ...attempt, push_id: row.id, pushed_at: row.created_at, reused: false });
  }
  const failed = outcomes.filter((o) => o.outcome !== "ACCEPTED");
  if (failed.length === 0) return outcomes;
  const policy = failed.some((o) => o.outcome === "REFUSED_POLICY");
  throw new ToolError(
    policy ? "PERMISSION_BLOCKED" : "TOOL_FAILURE",
    `publication refused (SUBMODULE_PUSH_FAILED): ${failed.length} of ${outcomes.length} submodule repositories ` +
      "were not pushed (see details.submodules); the umbrella was not pushed. Publishing again pushes only what is " +
      "missing",
    {
      reason: "SUBMODULE_PUSH_FAILED",
      submodules: outcomes.map((o) => ({
        repo: o.repo,
        paths: o.paths,
        branch: o.branch,
        head_sha: o.head_sha,
        outcome: o.outcome,
        reason: o.reason,
        push_id: o.push_id,
        reused: o.reused,
      })),
    },
  );
}

/** The store's `origin` URL (the one `pushOne` verified), for the pull request step. */
export async function originUrlOf(store: string): Promise<string | undefined> {
  try {
    return (await gitText(["config", "--get", "remote.origin.url"], { cwd: store })).split("\n")[0]?.trim();
  } catch {
    return undefined;
  }
}

const locks = new Map<string, Promise<unknown>>();

/** In-process per-meta-session mutex (promise chain), so two publications never interleave their submodule pushes. */
export async function withPublishLock<T>(metaSessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(metaSessionId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(metaSessionId, tail);
  try {
    return await run;
  } finally {
    if (locks.get(metaSessionId) === tail) locks.delete(metaSessionId);
  }
}

// ---- helpers ----------------------------------------------------------------------------------------------------

interface ChangedGitlink {
  readonly path: string;
  /** Undefined when the base has no gitlink there. */
  readonly base: string | undefined;
  readonly head: string;
}

const GITLINK_MODE = "160000";
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** Gitlinks of `head` that differ from `base` (`git diff-tree -r -z`, no renames); a removed gitlink is not listed. */
async function changedGitlinks(repo: string, base: string, head: string): Promise<ChangedGitlink[]> {
  const raw = (
    await git(["diff-tree", "-r", "-z", "--no-renames", "--no-ext-diff", "--end-of-options", base, head], {
      cwd: repo,
    })
  ).stdout.toString("utf8");
  const parts = raw.split("\0");
  const out: ChangedGitlink[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i] as string;
    const p = parts[i + 1] as string;
    if (!meta.startsWith(":")) break;
    const [oldMode, newMode, oldSha, newSha] = meta.slice(1).split(" ");
    if (newMode !== GITLINK_MODE || newSha === undefined || !SHA_RE.test(newSha)) continue;
    out.push({ path: p, base: oldMode === GITLINK_MODE ? oldSha : undefined, head: newSha });
  }
  return out;
}

/** Every commit from the base gitlinks to `head` in the store is a recorded submodule commit of the meta-session. */
async function verifiedStoreHistory(
  db: Database.Database,
  metaSessionId: string,
  key: string,
  store: string,
  bases: readonly string[],
  head: string,
): Promise<boolean> {
  try {
    if (!(await hasCommit(store, head))) return false;
    for (const b of bases) {
      if (!(await hasCommit(store, b))) return false;
      const anc = await git(["merge-base", "--is-ancestor", b, head], { cwd: store, okCodes: [1] });
      if (anc.code !== 0) return false;
    }
    const listed = (
      await gitText(["rev-list", `--max-count=${MAX_PUSH_COMMITS + 1}`, head, "--not", ...bases], { cwd: store })
    )
      .split("\n")
      .filter((s) => s !== "");
    if (listed.length === 0 || listed.length > MAX_PUSH_COMMITS) return false;
    return listed.every((sha) => isSessionSubmoduleCommit(db, metaSessionId, sha, key));
  } catch {
    return false;
  }
}

/** The start of a repository's scanned range: its last accepted push of `ref` when an ancestor of the head. */
async function scanStart(db: Database.Database, metaSessionId: string, r: LinkedRepo, ref: string): Promise<string> {
  const base = r.bases[0] as string;
  const prior = latestAcceptedSubmodulePush(db, { metaSessionId, repo: r.key, ref });
  if (prior === undefined) return base;
  if (prior.head_sha === r.headSha) return r.headSha;
  try {
    if (!(await hasCommit(r.store, prior.head_sha))) return base;
    const anc = await git(["merge-base", "--is-ancestor", prior.head_sha, r.headSha], { cwd: r.store, okCodes: [1] });
    return anc.code === 0 ? prior.head_sha : base;
  } catch {
    return base;
  }
}

/** The checks and the push of one repository; never throws (a failed check is `ERROR` `GIT_FAILED`). */
async function pushOne(
  deps: PublishSubmoduleDeps,
  r: LinkedRepo,
  ref: string,
  branch: string,
  defaultBranch: string | undefined,
): Promise<{ outcome: SubmodulePushOutcome; reason: string }> {
  const refuse = (reason: string) => ({ outcome: "REFUSED_POLICY" as const, reason });
  try {
    if (!r.writable || r.key.endsWith(".wiki")) return refuse("SUBMODULE_READ_ONLY");
    if (!(await originIsSource(r.store, r.key))) return refuse("REMOTE_INVALID");
    if (await repoConfigUnsafe(r.store)) return refuse("REPO_CONFIG_UNSAFE");
    const fmt = await git(["check-ref-format", ref], { cwd: r.store, okCodes: [1] });
    if (fmt.code !== 0) return refuse("PREFIX_INVALID");
    // Never the default branch; an unknown default branch cannot be ruled out (fail closed).
    if (defaultBranch === undefined || defaultBranch === branch) return refuse("TARGET_PROTECTED");
    const timeoutMs = deps.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS;
    const push =
      deps.push ??
      ((cwd: string, args: readonly string[], t: number) =>
        runGitPush(cwd, args, pushEnv(deps.sourceEnv ?? process.env), t));
    const res = classifyPush(await push(r.store, submodulePushArgs(r.headSha, ref), timeoutMs), ref);
    return { outcome: res.outcome, reason: res.outcome === "ACCEPTED" ? "ok" : res.reason };
  } catch {
    return { outcome: "ERROR", reason: "GIT_FAILED" };
  }
}

/** `origin` has exactly one URL, the repository's https source, and no push URL (which would redirect the push). */
async function originIsSource(store: string, key: string): Promise<boolean> {
  const urls = await git(["config", "--get-all", "remote.origin.url"], { cwd: store, okCodes: [1] });
  const list = urls.stdout
    .toString("utf8")
    .split("\n")
    .filter((u) => u !== "");
  if (list.length !== 1) return false;
  const src = parseRepositoryUrl(list[0]);
  if (src === undefined || sourceKey(src) !== key) return false;
  const pushUrls = await git(["config", "--get-all", "remote.origin.pushurl"], { cwd: store, okCodes: [1] });
  return pushUrls.code === 1;
}
