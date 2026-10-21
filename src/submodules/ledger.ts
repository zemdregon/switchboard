/**
 * Typed rows of migration 0037's submodule tables (ADR-0080 items 4, 6, 7 and 9): `submodule_commit`,
 * `submodule_push`, `submodule_pull_request` and `submodule_merge`. Plain inserts and reads on the caller's database
 * handle, so an insert joins the caller's transaction (the commit path writes `submodule_commit` rows in the same
 * transaction as the umbrella's `git_commit` row). No run event is appended here: the caller decides what to announce.
 *
 * Controller facts only (ADR-0080 item 9): ids, SHAs, closed codes, `host/owner/repo` keys and umbrella-relative paths.
 * The insert helpers check SHAs and paths before writing; the tables' own CHECKs and append-only triggers are the
 * second line.
 */
import type Database from "better-sqlite3";
import { defaultIds, type IdGenerator } from "../ids/index.js";
import { isFullSha, isSafeSubmodulePath, MAX_SUBMODULES } from "./errors.js";

export interface SubmoduleLedgerDeps {
  readonly ids?: IdGenerator;
  readonly now?: () => Date;
}

// ---- submodule_commit -------------------------------------------------------------------------------------------

export interface SubmoduleCommitRow {
  id: string;
  run_id: string;
  meta_session_id: string;
  kind: "publish";
  /** Lower-case `host/owner/repo` source key. */
  repo: string;
  /** JSON array of umbrella-relative paths whose gitlinks were set to `commit_sha`. */
  paths_json: string;
  parent_sha: string;
  commit_sha: string;
  umbrella_commit_sha: string;
  created_at: string;
}

export interface NewSubmoduleCommit {
  readonly runId: string;
  readonly metaSessionId: string;
  readonly repo: string;
  readonly paths: readonly string[];
  readonly parentSha: string;
  readonly commitSha: string;
  readonly umbrellaCommitSha: string;
}

export function insertSubmoduleCommit(
  db: Database.Database,
  input: NewSubmoduleCommit,
  deps: SubmoduleLedgerDeps = {},
): SubmoduleCommitRow {
  checkPaths(input.paths);
  checkShas(input.parentSha, input.commitSha, input.umbrellaCommitSha);
  const id = (deps.ids ?? defaultIds).id("smc");
  db.prepare(
    `INSERT INTO submodule_commit (id, run_id, meta_session_id, kind, repo, paths_json, parent_sha, commit_sha,
       umbrella_commit_sha, created_at)
     VALUES (?, ?, ?, 'publish', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.runId,
    input.metaSessionId,
    input.repo,
    JSON.stringify([...input.paths]),
    input.parentSha,
    input.commitSha,
    input.umbrellaCommitSha,
    stamp(deps),
  );
  return db.prepare("SELECT * FROM submodule_commit WHERE id = ?").get(id) as SubmoduleCommitRow;
}

/** The meta-session's latest submodule commit of `repo` (the parent of its next one), or undefined. */
export function latestSubmoduleCommit(
  db: Database.Database,
  metaSessionId: string,
  repo: string,
): SubmoduleCommitRow | undefined {
  return db
    .prepare(
      `SELECT * FROM submodule_commit WHERE meta_session_id = ? AND repo = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(metaSessionId, repo) as SubmoduleCommitRow | undefined;
}

/** Whether `sha` is a recorded submodule commit of the meta-session (of `repo`, when given). */
export function isSessionSubmoduleCommit(
  db: Database.Database,
  metaSessionId: string,
  sha: string,
  repo?: string,
): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM submodule_commit WHERE meta_session_id = ? AND commit_sha = ? AND (? IS NULL OR repo = ?)
         LIMIT 1`,
      )
      .get(metaSessionId, sha, repo ?? null, repo ?? null) !== undefined
  );
}

/** The submodule commits recorded with one umbrella controller commit, oldest first. */
export function listSubmoduleCommitsForUmbrella(
  db: Database.Database,
  umbrellaCommitSha: string,
): SubmoduleCommitRow[] {
  return db
    .prepare("SELECT * FROM submodule_commit WHERE umbrella_commit_sha = ? ORDER BY created_at, id")
    .all(umbrellaCommitSha) as SubmoduleCommitRow[];
}

/** The `paths_json` of a row (an empty list when it is not a JSON array of strings). */
export function submoduleCommitPaths(row: Pick<SubmoduleCommitRow, "paths_json">): string[] {
  return parsePaths(row.paths_json);
}

// ---- submodule_push ---------------------------------------------------------------------------------------------

export type SubmodulePushOutcome = "ACCEPTED" | "REFUSED_POLICY" | "REJECTED_REMOTE" | "ERROR";

export interface SubmodulePushRow {
  id: string;
  run_id: string;
  meta_session_id: string;
  project_id: string;
  repo: string;
  paths_json: string;
  ref: string;
  head_sha: string;
  umbrella_head_sha: string;
  outcome: SubmodulePushOutcome;
  reason: string;
  requested_by: string;
  created_at: string;
}

export interface NewSubmodulePush {
  readonly runId: string;
  readonly metaSessionId: string;
  readonly projectId: string;
  readonly repo: string;
  readonly paths: readonly string[];
  /** `refs/heads/...` on the repository's own origin. */
  readonly ref: string;
  readonly headSha: string;
  readonly umbrellaHeadSha: string;
  readonly outcome: SubmodulePushOutcome;
  /** Closed reason code (`ok` for an accepted push). */
  readonly reason: string;
  /** `operator` or `mcp_client:<id>`. */
  readonly requestedBy: string;
}

export function insertSubmodulePush(
  db: Database.Database,
  input: NewSubmodulePush,
  deps: SubmoduleLedgerDeps = {},
): SubmodulePushRow {
  checkPaths(input.paths);
  checkShas(input.headSha, input.umbrellaHeadSha);
  const id = (deps.ids ?? defaultIds).id("smp");
  db.prepare(
    `INSERT INTO submodule_push (id, run_id, meta_session_id, project_id, repo, paths_json, ref, head_sha,
       umbrella_head_sha, outcome, reason, requested_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.runId,
    input.metaSessionId,
    input.projectId,
    input.repo,
    JSON.stringify([...input.paths]),
    input.ref,
    input.headSha,
    input.umbrellaHeadSha,
    input.outcome,
    input.reason,
    input.requestedBy,
    stamp(deps),
  );
  return db.prepare("SELECT * FROM submodule_push WHERE id = ?").get(id) as SubmodulePushRow;
}

/** The latest accepted push of `headSha` to `ref` of `repo` by the meta-session (idempotent reuse), or undefined. */
export function findAcceptedSubmodulePush(
  db: Database.Database,
  q: { readonly metaSessionId: string; readonly repo: string; readonly ref: string; readonly headSha: string },
): SubmodulePushRow | undefined {
  return db
    .prepare(
      `SELECT * FROM submodule_push
       WHERE meta_session_id = ? AND repo = ? AND ref = ? AND head_sha = ? AND outcome = 'ACCEPTED'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(q.metaSessionId, q.repo, q.ref, q.headSha) as SubmodulePushRow | undefined;
}

/**
 * The meta-session's latest accepted push of `repo` to `ref`, whatever its head (the start of the next secret-scan
 * range, ADR-0080 item 5), or undefined.
 */
export function latestAcceptedSubmodulePush(
  db: Database.Database,
  q: { readonly metaSessionId: string; readonly repo: string; readonly ref: string },
): SubmodulePushRow | undefined {
  return db
    .prepare(
      `SELECT * FROM submodule_push WHERE meta_session_id = ? AND repo = ? AND ref = ? AND outcome = 'ACCEPTED'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(q.metaSessionId, q.repo, q.ref) as SubmodulePushRow | undefined;
}

export function getSubmodulePush(db: Database.Database, id: string): SubmodulePushRow | undefined {
  return db.prepare("SELECT * FROM submodule_push WHERE id = ?").get(id) as SubmodulePushRow | undefined;
}

export function listSubmodulePushesForRun(db: Database.Database, runId: string): SubmodulePushRow[] {
  return db
    .prepare("SELECT * FROM submodule_push WHERE run_id = ? ORDER BY created_at, id")
    .all(runId) as SubmodulePushRow[];
}

// ---- submodule_pull_request -------------------------------------------------------------------------------------

export interface SubmodulePullRequestRow {
  id: string;
  run_id: string;
  meta_session_id: string;
  push_id: string;
  client_id: string;
  /** `owner/repo` as `gh` takes it. */
  repo: string;
  number: number;
  url: string;
  branch: string;
  base_ref: string;
  head_sha: string;
  umbrella_ref: string;
  draft: 0 | 1;
  action: "created" | "reused";
  created_at: string;
}

export interface NewSubmodulePullRequest {
  readonly runId: string;
  readonly metaSessionId: string;
  readonly pushId: string;
  readonly clientId: string;
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly headSha: string;
  /** The umbrella publish ref on the umbrella remote (`refs/heads/...`). */
  readonly umbrellaRef: string;
  readonly draft: boolean;
  readonly action: "created" | "reused";
}

export function insertSubmodulePullRequest(
  db: Database.Database,
  input: NewSubmodulePullRequest,
  deps: SubmoduleLedgerDeps = {},
): SubmodulePullRequestRow {
  checkShas(input.headSha);
  const id = (deps.ids ?? defaultIds).id("spr");
  db.prepare(
    `INSERT INTO submodule_pull_request (id, run_id, meta_session_id, push_id, client_id, repo, number, url, branch,
       base_ref, head_sha, umbrella_ref, draft, action, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.runId,
    input.metaSessionId,
    input.pushId,
    input.clientId,
    input.repo,
    input.number,
    input.url,
    input.branch,
    input.baseRef,
    input.headSha,
    input.umbrellaRef,
    input.draft ? 1 : 0,
    input.action,
    stamp(deps),
  );
  return db.prepare("SELECT * FROM submodule_pull_request WHERE id = ?").get(id) as SubmodulePullRequestRow;
}

export function listSubmodulePullRequestsForRun(db: Database.Database, runId: string): SubmodulePullRequestRow[] {
  return db
    .prepare("SELECT * FROM submodule_pull_request WHERE run_id = ? ORDER BY created_at, id")
    .all(runId) as SubmodulePullRequestRow[];
}

export function listSubmodulePullRequestsForUmbrellaRef(
  db: Database.Database,
  umbrellaRef: string,
): SubmodulePullRequestRow[] {
  return db
    .prepare("SELECT * FROM submodule_pull_request WHERE umbrella_ref = ? ORDER BY created_at, id")
    .all(umbrellaRef) as SubmodulePullRequestRow[];
}

// ---- submodule_merge --------------------------------------------------------------------------------------------

export type SubmoduleMergeStep = "submodule_merged" | "submodule_refused" | "gitlinks_repointed";

export interface SubmoduleMergeRow {
  id: string;
  run_id: string;
  meta_session_id: string;
  project_id: string;
  umbrella_ref: string;
  step: SubmoduleMergeStep;
  repo: string | null;
  pr_number: number | null;
  head_sha: string;
  merged_sha: string | null;
  reason: string | null;
  created_at: string;
}

export interface NewSubmoduleMerge {
  readonly runId: string;
  readonly metaSessionId: string;
  readonly projectId: string;
  readonly umbrellaRef: string;
  readonly step: SubmoduleMergeStep;
  /** `owner/repo`; required except for `gitlinks_repointed`. */
  readonly repo?: string;
  readonly prNumber?: number;
  readonly headSha: string;
  /** Required except for `submodule_refused`. */
  readonly mergedSha?: string;
  /** Closed refusal code; only (and required) for `submodule_refused`. */
  readonly reason?: string;
}

/**
 * Append one step. A `submodule_refused` step is recorded once per (umbrella ref, repo, head, reason): a repeat returns
 * undefined and writes nothing (`INSERT OR IGNORE` on the table's partial unique index).
 */
export function insertSubmoduleMerge(
  db: Database.Database,
  input: NewSubmoduleMerge,
  deps: SubmoduleLedgerDeps = {},
): SubmoduleMergeRow | undefined {
  checkShas(input.headSha, ...(input.mergedSha !== undefined ? [input.mergedSha] : []));
  const id = (deps.ids ?? defaultIds).id("smm");
  const res = db
    .prepare(
      `INSERT ${input.step === "submodule_refused" ? "OR IGNORE " : ""}INTO submodule_merge (id, run_id,
         meta_session_id, project_id, umbrella_ref, step, repo, pr_number, head_sha, merged_sha, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.runId,
      input.metaSessionId,
      input.projectId,
      input.umbrellaRef,
      input.step,
      input.repo ?? null,
      input.prNumber ?? null,
      input.headSha,
      input.mergedSha ?? null,
      input.reason ?? null,
      stamp(deps),
    );
  if (res.changes === 0) return undefined;
  return db.prepare("SELECT * FROM submodule_merge WHERE id = ?").get(id) as SubmoduleMergeRow;
}

/** Every step of the ordered merge of one umbrella publish ref of a project, oldest first. */
export function listSubmoduleMergeSteps(
  db: Database.Database,
  projectId: string,
  umbrellaRef: string,
): SubmoduleMergeRow[] {
  return db
    .prepare("SELECT * FROM submodule_merge WHERE project_id = ? AND umbrella_ref = ? ORDER BY created_at, id")
    .all(projectId, umbrellaRef) as SubmoduleMergeRow[];
}

/** Every merge step recorded on one run, oldest first (the digest's `ref_events`). */
export function listSubmoduleMergeStepsForRun(db: Database.Database, runId: string): SubmoduleMergeRow[] {
  return db
    .prepare("SELECT * FROM submodule_merge WHERE run_id = ? ORDER BY created_at, id")
    .all(runId) as SubmoduleMergeRow[];
}

// ---- helpers ----------------------------------------------------------------------------------------------------

function stamp(deps: SubmoduleLedgerDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

function checkPaths(paths: readonly string[]): void {
  if (paths.length === 0 || paths.length > MAX_SUBMODULES || !paths.every((p) => isSafeSubmodulePath(p))) {
    throw new TypeError("paths must be 1 to 1024 safe umbrella-relative submodule paths");
  }
}

function checkShas(...shas: readonly string[]): void {
  if (!shas.every((s) => isFullSha(s))) throw new TypeError("a SHA must be a full lower-case object id");
}

function parsePaths(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) && v.every((p) => typeof p === "string") ? (v as string[]) : [];
  } catch {
    return [];
  }
}
