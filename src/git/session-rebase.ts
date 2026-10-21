import type Database from "better-sqlite3";
import { insertChainedRunEvent } from "../ledger/index.js";
import { CONTROLLER_IDENTITY, GitError, git, gitText, parseGitVersion, versionAtLeast } from "../workspace/git.js";
import { type BaseRefreshOptions, type BaseRefreshResult, refreshBase } from "./base-refresh.js";

/**
 * Controller-side rebase of a meta-session onto a freshly fetched base (ADR-0074, LLD §5.2.1). A continuing
 * meta-session starts every later run from its stored head (`meta_session.head_commit`), so without this a long-lived
 * session never sees what landed on the remote base after its first run. `rebase_session` fetches the base exactly as
 * the first-worktree refresh does (`refreshBase`, ADR-0067: the same hardened fetch into the remote-tracking ref, one
 * `base_refresh` event) and replays the session's own commits onto it. Nothing runs in an agent's environment and no
 * worktree is touched: every commit is replayed with `git merge-tree --write-tree --merge-base` and `git commit-tree`
 * in the repository's object store (Git 2.40 or later), through the hardened helper (`src/workspace/git.ts`).
 *
 * Two chains are replayed onto the fresh base `F`, both from the session's base commit `B`:
 * - the **continuation chain** `B..head_commit` (the run checkpoints the next run starts from). Author kept, committer
 *   the controller's checkpoint identity, as for every checkpoint;
 * - the **publish chain** `B..<publish ref>` (the controller commits `publish_run` pushes), when the session has one.
 *   Author kept, committer the primary context's `identity` (FR-GIT-04); each replayed commit gets a `git_commit`
 *   provenance row copied from the original's (same run, provider, sanitiser record), so publication still sees only
 *   controller commits (FR-GIT-08). **Delegated**, fail closed: no identity is `IDENTITY_REQUIRED`, and `sign: true`
 *   is `SIGNING_UNAVAILABLE` (signing needs a run's BR-31 verdict, which a session without a run cannot give).
 *
 * Refusals happen before anything changes (only unreachable objects may have been written): a conflict in either
 * chain (`CONFLICT`, with the conflicting paths), a moved head (`HEAD_MOVED`), an active run (`ACTIVE_RUN`), another
 * run holding a lease on the repository (`REPO_BUSY`), a merge commit in a chain (`MERGE_COMMIT`), a failed or skipped
 * fetch (`BASE_REFRESH_FAILED`), a repository merge driver (`REPO_CONFIG_UNSAFE`, it would run a program) or an older
 * Git (`GIT_TOO_OLD`). A commit that becomes empty on the new base is dropped, as `git rebase` does.
 *
 * Commit order (crash safety): the publish ref moves first (`update-ref` compare-and-swap), then ONE ledger
 * transaction re-checks the session (same head, no run, no lease), sets `head_commit` and `base_commit` to the new
 * head and `F`, writes the provenance rows and appends one `session_rebased` event on the session's newest run. A
 * failed re-check moves the publish ref back. A crash between the two leaves a publish ref whose tip has no
 * provenance row: the commit tool and the push then refuse (`PUBLISH_HISTORY_UNVERIFIED`), never publish it.
 *
 * Never pushes (**Delegated**, ADR-0074): a branch `publish_run` pushed before the rebase is no longer a
 * fast-forward of the rebased chain, and the non-forced push is then refused (`NON_FAST_FORWARD`, Q-112).
 */

/** `git merge-tree --merge-base` first shipped in Git 2.40.0. */
export const MIN_SESSION_REBASE_GIT_VERSION = [2, 40, 0] as const;
/** **Delegated** bound on the commits of one chain (the push allows 500, LLD §12.6). */
export const MAX_REBASE_COMMITS = 500;
/** **Delegated** bound on the conflicting paths a refusal lists. */
export const MAX_CONFLICT_PATHS = 50;
/** The run event this module appends on success. */
export const SESSION_REBASED_EVENT = "session_rebased";

export type SessionRebaseRefusal =
  | "NOTHING_TO_REBASE"
  | "ACTIVE_RUN"
  | "HEAD_MOVED"
  | "REPO_BUSY"
  | "GIT_TOO_OLD"
  | "REPO_CONFIG_UNSAFE"
  | "BASE_REFRESH_FAILED"
  | "MERGE_COMMIT"
  | "TOO_MANY_COMMITS"
  | "PUBLISH_HISTORY_UNVERIFIED"
  | "IDENTITY_REQUIRED"
  | "SIGNING_UNAVAILABLE"
  | "CONFLICT"
  | "PUBLISH_REF_MOVED"
  | "GIT_FAILED";

/** A refused rebase; nothing about the session changed. The message is fixed per reason (never Git's output). */
export class SessionRebaseError extends Error {
  override readonly name = "SessionRebaseError";
  constructor(
    readonly reason: SessionRebaseRefusal,
    message: string,
    readonly extra: {
      readonly conflictingPaths?: readonly string[];
      readonly fetchReason?: string;
      readonly runId?: string;
    } = {},
  ) {
    super(message);
  }
}

export interface SessionRebaseInput {
  readonly metaSessionId: string;
  readonly expectedHeadSha?: string;
  /** The project's primary context `base_ref` and effective base remote (ADR-0074). */
  readonly baseRef: string;
  readonly remote: string;
  /** The primary context's commit identity (committer of replayed publish commits). */
  readonly identity?: { readonly name: string; readonly email: string };
  readonly sign: boolean;
  /**
   * ADR-0079 item 3: the primary context sets `submodules.mode: "recursive"`. A gitlink both the session (either
   * chain) and the fresh base changed, to different commits, is then a `CONFLICT` naming that path: `merge-tree` cannot
   * merge a submodule whose objects are not in the umbrella's store. Absent or false: exactly as before.
   */
  readonly submodules?: boolean;
}

export interface SessionRebaseResult {
  readonly previousHead: string;
  readonly newHead: string;
  /** The fresh base the session was replayed onto (its new `base_commit`). */
  readonly baseCommit: string;
  /** Commits of the continuation chain written on the new base (dropped empty ones not counted). */
  readonly rebasedCommits: number;
  /** Set when the session has a publish chain. */
  readonly publish?: { readonly ref: string; readonly previousTip: string; readonly newTip: string };
  readonly fetch: Pick<BaseRefreshResult, "outcome" | "reason">;
}

export type SessionRebaseOptions = BaseRefreshOptions & {
  /** The per-repository worktree serialisation (`serialisedWorktreeCreate` of the workspace manager). */
  readonly serialise: <T>(repoRoot: string, fn: () => Promise<T>) => Promise<T>;
};

interface SessionRow {
  repo_root: string | null;
  base_commit: string | null;
  head_commit: string | null;
  lease_run_id: string | null;
}

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/u;
const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED"] as const;

const TEXT: Readonly<Record<SessionRebaseRefusal, string>> = {
  NOTHING_TO_REBASE: "the meta-session has no recorded repository or head commit yet",
  ACTIVE_RUN: "the meta-session has a run that has not finished; wait for it or cancel it first",
  HEAD_MOVED: "the meta-session head is not expected_head_sha",
  REPO_BUSY: "another run holds a write lease on this repository; retry when it has finished",
  GIT_TOO_OLD: "the controller's Git is older than 2.40, which rebase_session needs",
  REPO_CONFIG_UNSAFE: "the repository configures a merge driver, which the controller does not run",
  BASE_REFRESH_FAILED: "the base could not be fetched; nothing was rebased",
  MERGE_COMMIT: "the meta-session history contains a merge commit, which rebase_session does not replay",
  TOO_MANY_COMMITS: `the meta-session has more than ${MAX_REBASE_COMMITS} commits to replay`,
  PUBLISH_HISTORY_UNVERIFIED: "the publish ref holds a commit without a controller provenance record",
  IDENTITY_REQUIRED: "the project's primary context has no identity for the replayed published commits",
  SIGNING_UNAVAILABLE: "the project requires signed commits, which rebase_session cannot make; nothing was rebased",
  CONFLICT: "the meta-session's changes conflict with the fresh base; nothing was rebased",
  PUBLISH_REF_MOVED: "the publish ref moved while the rebase was prepared; retry",
  GIT_FAILED: "a Git command failed; nothing was rebased",
};

const refuse = (reason: SessionRebaseRefusal, extra?: SessionRebaseError["extra"]) =>
  new SessionRebaseError(reason, TEXT[reason], extra);

/** Rebase the meta-session onto the freshly fetched base, or throw {@link SessionRebaseError} with nothing changed. */
export async function rebaseSession(
  db: Database.Database,
  input: SessionRebaseInput,
  options: SessionRebaseOptions,
): Promise<SessionRebaseResult> {
  const first = checkSession(db, input);
  const version = parseGitVersion(await gitText(["--version"]).catch(() => ""));
  if (!version || !versionAtLeast(version, MIN_SESSION_REBASE_GIT_VERSION)) throw refuse("GIT_TOO_OLD");
  const repoRoot = first.repo_root as string;
  try {
    return await options.serialise(repoRoot, () => rebaseLocked(db, input, options, repoRoot));
  } catch (err) {
    if (err instanceof SessionRebaseError) throw err;
    throw refuse("GIT_FAILED");
  }
}

/** The session preconditions (also re-checked inside the serialisation and the final transaction). */
function checkSession(db: Database.Database, input: SessionRebaseInput): SessionRow {
  const row = db
    .prepare("SELECT repo_root, base_commit, head_commit, lease_run_id FROM meta_session WHERE id = ?")
    .get(input.metaSessionId) as SessionRow | undefined;
  if (!row?.repo_root || !row.base_commit || !row.head_commit) throw refuse("NOTHING_TO_REBASE");
  const active = activeRun(db, input.metaSessionId, row);
  if (active !== undefined) throw refuse("ACTIVE_RUN", { runId: active });
  if (input.expectedHeadSha !== undefined && input.expectedHeadSha !== row.head_commit) throw refuse("HEAD_MOVED");
  return row;
}

function activeRun(db: Database.Database, metaSessionId: string, row: SessionRow): string | undefined {
  const r = db
    .prepare(
      `SELECT id FROM run WHERE meta_session_id = ? AND state NOT IN (${TERMINAL.map(() => "?").join(", ")})
       ORDER BY created_at LIMIT 1`,
    )
    .get(metaSessionId, ...TERMINAL) as { id: string } | undefined;
  return r?.id ?? row.lease_run_id ?? undefined;
}

async function rebaseLocked(
  db: Database.Database,
  input: SessionRebaseInput,
  options: SessionRebaseOptions,
  repoRoot: string,
): Promise<SessionRebaseResult> {
  const session = checkSession(db, input);
  const B = session.base_commit as string;
  const H = session.head_commit as string;
  if (db.prepare("SELECT 1 FROM meta_session WHERE repo_root = ? AND lease_run_id IS NOT NULL").get(repoRoot)) {
    throw refuse("REPO_BUSY");
  }
  const drivers = await git(["config", "-z", "--name-only", "--get-regexp", String.raw`^merge\..*\.driver$`], {
    cwd: repoRoot,
    okCodes: [1],
  });
  if (drivers.code === 0) throw refuse("REPO_CONFIG_UNSAFE");

  // The publish chain is read (and checked) before the fetch, so a refusal here costs no network call.
  const publish = publishChain(db, input.metaSessionId);
  const publishTip = publish !== undefined ? await resolveCommit(repoRoot, publish.ref) : undefined;
  // A session with provenance rows has a publish chain: its ref must name exactly the newest recorded commit.
  if (publish !== undefined && publishTip !== publish.latest) throw refuse("PUBLISH_HISTORY_UNVERIFIED");
  const hasPublishChain = publish !== undefined && publishTip !== undefined && publishTip !== B;
  if (hasPublishChain) {
    if (input.sign) throw refuse("SIGNING_UNAVAILABLE");
    if (input.identity === undefined) throw refuse("IDENTITY_REQUIRED");
  }

  const anchorRow = db
    .prepare("SELECT id FROM run WHERE meta_session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(input.metaSessionId) as { id: string } | undefined;
  if (anchorRow === undefined) throw refuse("NOTHING_TO_REBASE");
  const anchor = anchorRow.id;
  const fetched = await refreshBase(
    db,
    { runId: anchor, metaSessionId: input.metaSessionId, repoRoot, baseRef: input.baseRef, remote: input.remote },
    options,
  );
  if (fetched.outcome !== "fetched") throw refuse("BASE_REFRESH_FAILED", { fetchReason: fetched.reason });
  const F = fetched.baseCommit ?? fetched.facts?.localSha ?? undefined;
  if (F === undefined || !FULL_SHA.test(F)) throw refuse("BASE_REFRESH_FAILED", { fetchReason: fetched.reason });
  const fetch = { outcome: fetched.outcome, reason: fetched.reason };

  if (F === B || (await isAncestor(repoRoot, F, B))) {
    // Already on (or past) the fresh base: nothing to replay, nothing changes.
    return { previousHead: H, newHead: H, baseCommit: B, rebasedCommits: 0, fetch };
  }

  const checkpoints = await chainOf(repoRoot, B, H);
  const published = hasPublishChain ? await chainOf(repoRoot, B, publishTip) : [];
  if (hasPublishChain) {
    const known = new Set(publish.rows.map((r) => r.commit_sha));
    if (!published.every((c) => known.has(c))) throw refuse("PUBLISH_HISTORY_UNVERIFIED");
  }

  const when = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
  const conflicts = new Set<string>();
  if (input.submodules === true) {
    const base = await changedGitlinks(repoRoot, B, F);
    for (const tip of [H, ...(hasPublishChain ? [publishTip as string] : [])]) {
      for (const [p, sha] of await changedGitlinks(repoRoot, B, tip)) {
        const theirs = base.get(p);
        if (theirs !== undefined && theirs !== sha) conflicts.add(p);
      }
    }
  }
  const head = await replay(repoRoot, checkpoints, F, CONTROLLER_IDENTITY, when, conflicts);
  const pub = hasPublishChain
    ? await replay(repoRoot, published, F, input.identity as { name: string; email: string }, when, conflicts)
    : undefined;
  if (conflicts.size > 0) {
    throw refuse("CONFLICT", { conflictingPaths: [...conflicts].sort().slice(0, MAX_CONFLICT_PATHS) });
  }

  // Commit phase: the publish ref first (compare-and-swap), then one ledger transaction.
  if (pub !== undefined && publish !== undefined && publishTip !== undefined) {
    const moved = await git(["update-ref", "--no-deref", publish.ref, pub.tip, publishTip], {
      cwd: repoRoot,
      okCodes: [1, 128],
    });
    if (moved.code !== 0) throw refuse("PUBLISH_REF_MOVED");
  }
  const nowIso = (options.now?.() ?? new Date()).toISOString();
  try {
    db.transaction(() => {
      checkSession(db, { ...input, expectedHeadSha: H });
      const updated = db
        .prepare(
          `UPDATE meta_session SET head_commit = ?, base_commit = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND head_commit = ? AND base_commit = ? AND lease_run_id IS NULL`,
        )
        .run(head.tip, F, nowIso, input.metaSessionId, H, B);
      if (updated.changes !== 1) throw refuse("HEAD_MOVED");
      if (pub !== undefined && publish !== undefined) {
        const bySha = new Map(publish.rows.map((r) => [r.commit_sha, r]));
        for (const m of pub.mapping) {
          const original = bySha.get(m.from);
          if (original !== undefined) copyProvenance(db, original, m, options.ids.id("gcm"), nowIso);
        }
      }
      insertChainedRunEvent(db, {
        id: options.ids.id("evt"),
        runId: anchor,
        ts: nowIso,
        type: SESSION_REBASED_EVENT,
        payloadJson: JSON.stringify({
          v: 1,
          previous_head: H,
          new_head: head.tip,
          previous_base_commit: B,
          base_commit: F,
          rebased_commits: head.mapping.length,
          dropped_commits: checkpoints.length - head.mapping.length,
          publish:
            pub !== undefined && publish !== undefined
              ? {
                  ref: publish.ref,
                  previous_tip: publishTip,
                  new_tip: pub.tip,
                  commits: pub.mapping.slice(0, 100).map((m) => ({ from: m.from, to: m.to })),
                }
              : null,
        }),
      });
    })();
  } catch (err) {
    if (pub !== undefined && publish !== undefined && publishTip !== undefined) {
      await git(["update-ref", "--no-deref", publish.ref, publishTip, pub.tip], { cwd: repoRoot, okCodes: [1, 128] });
    }
    throw err;
  }
  return {
    previousHead: H,
    newHead: head.tip,
    baseCommit: F,
    rebasedCommits: head.mapping.length,
    ...(pub !== undefined && publish !== undefined && publishTip !== undefined
      ? { publish: { ref: publish.ref, previousTip: publishTip, newTip: pub.tip } }
      : {}),
    fetch,
  };
}

interface ProvenanceRow {
  readonly commit_sha: string;
  readonly publish_ref: string;
  readonly [column: string]: unknown;
}

/** The session's publish ref (of its newest provenance row), that ref's newest row and every row of the session. */
function publishChain(
  db: Database.Database,
  metaSessionId: string,
): { ref: string; latest: string; rows: ProvenanceRow[] } | undefined {
  const rows = db
    .prepare("SELECT * FROM git_commit WHERE meta_session_id = ? ORDER BY created_at, id")
    .all(metaSessionId) as ProvenanceRow[];
  const newest = rows.at(-1);
  if (newest === undefined) return undefined;
  const latest = db
    .prepare("SELECT commit_sha FROM git_commit WHERE publish_ref = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(newest.publish_ref) as { commit_sha: string };
  return { ref: newest.publish_ref, latest: latest.commit_sha, rows };
}

/** A copy of an original provenance row for its replayed commit (new id, SHA, tree and time; no tool event). */
function copyProvenance(
  db: Database.Database,
  original: ProvenanceRow,
  replayed: { readonly to: string; readonly tree: string },
  id: string,
  nowIso: string,
): void {
  const row: Record<string, unknown> = {
    ...original,
    id,
    commit_sha: replayed.to,
    tree_sha: replayed.tree,
    patch_id: null,
    tool_event_id: null,
    created_at: nowIso,
  };
  // Column names come from the row SQLite returned, never from a caller.
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO git_commit (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
    ...cols.map((c) => row[c]),
  );
}

/** The commits of `from..to`, oldest first, refusing a merge commit, a chain that does not start at `from`, or too many. */
async function chainOf(repoRoot: string, from: string, to: string): Promise<string[]> {
  if (!(await isAncestor(repoRoot, from, to))) throw refuse("PUBLISH_HISTORY_UNVERIFIED");
  const lines = (
    await gitText(
      [
        "rev-list",
        "--reverse",
        "--topo-order",
        "--parents",
        `--max-count=${MAX_REBASE_COMMITS + 1}`,
        to,
        "--not",
        from,
      ],
      {
        cwd: repoRoot,
      },
    )
  )
    .split("\n")
    .filter((l) => l !== "");
  if (lines.length > MAX_REBASE_COMMITS) throw refuse("TOO_MANY_COMMITS");
  return lines.map((l) => {
    const parts = l.split(" ");
    if (parts.length !== 2) throw refuse("MERGE_COMMIT");
    return parts[0] as string;
  });
}

/**
 * Replay `commits` (single-parent, oldest first) onto `onto`. Conflicting paths are added to `conflicts` and the
 * replay goes on (so one refusal lists them all); the returned tip is then meaningless. A commit whose replayed tree
 * equals its new parent's is dropped.
 */
async function replay(
  repoRoot: string,
  commits: readonly string[],
  onto: string,
  committer: { readonly name: string; readonly email: string },
  when: number,
  conflicts: Set<string>,
): Promise<{ tip: string; mapping: { from: string; to: string; tree: string }[] }> {
  let tip = onto;
  const mapping: { from: string; to: string; tree: string }[] = [];
  for (const c of commits) {
    const merged = await git(
      ["merge-tree", "--write-tree", "--no-messages", "--name-only", "-z", `--merge-base=${c}^`, tip, c],
      { cwd: repoRoot, okCodes: [1] },
    );
    const tokens = merged.stdout.toString("utf8").split("\0");
    const tree = tokens[0] ?? "";
    if (!FULL_SHA.test(tree)) throw new GitError("merge-tree wrote no tree", ["merge-tree"], merged.code, "");
    if (merged.code === 1) {
      for (const t of tokens.slice(1)) if (t !== "") conflicts.add(t);
      continue;
    }
    if (conflicts.size > 0) continue;
    if (tree === (await gitText(["rev-parse", "--verify", "--end-of-options", `${tip}^{tree}`], { cwd: repoRoot }))) {
      continue; // empty on the new base
    }
    const { author, message } = await commitParts(repoRoot, c);
    const sha = await gitText(["commit-tree", tree, "-p", tip, "-F", "-"], {
      cwd: repoRoot,
      input: message,
      env: {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: author.date,
        GIT_COMMITTER_NAME: committer.name,
        GIT_COMMITTER_EMAIL: committer.email,
        GIT_COMMITTER_DATE: `${when} +0000`,
      },
    });
    mapping.push({ from: c, to: sha, tree });
    tip = sha;
  }
  return { tip, mapping };
}

/** The author (name, e-mail, raw date) and the exact message of commit `c`. */
async function commitParts(
  repoRoot: string,
  c: string,
): Promise<{ author: { name: string; email: string; date: string }; message: string }> {
  const raw = (await git(["cat-file", "commit", c], { cwd: repoRoot })).stdout.toString("utf8");
  const split = raw.indexOf("\n\n");
  const header = split >= 0 ? raw.slice(0, split) : raw;
  const message = split >= 0 ? raw.slice(split + 2) : "";
  const m = /^author (.*) <([^>]*)> (\d+ [+-]\d{4})$/mu.exec(header);
  if (m === null) throw new GitError("commit has no author", ["cat-file"], 0, "");
  return { author: { name: m[1] as string, email: m[2] as string, date: m[3] as string }, message };
}

/**
 * ADR-0079 item 3: the gitlinks (mode `160000` on either side) that differ between `from` and `to`, as path to the new
 * gitlink commit (`""` when the gitlink was removed or replaced by something else).
 */
async function changedGitlinks(repoRoot: string, from: string, to: string): Promise<Map<string, string>> {
  const out = (
    await git(["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", from, to], { cwd: repoRoot })
  ).stdout.toString("utf8");
  const tokens = out.split("\0");
  const changed = new Map<string, string>();
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = tokens[i] as string;
    const p = tokens[i + 1] as string;
    const [oldMode, newMode, , newSha] = meta.replace(/^:/u, "").split(" ");
    if (oldMode !== "160000" && newMode !== "160000") continue;
    changed.set(p, newMode === "160000" ? (newSha ?? "") : "");
  }
  return changed;
}

async function resolveCommit(repoRoot: string, ref: string): Promise<string | undefined> {
  const r = await git(["rev-parse", "-q", "--verify", "--end-of-options", `${ref}^{commit}`], {
    cwd: repoRoot,
    okCodes: [1, 128],
  });
  const sha = r.stdout.toString("utf8").trim();
  return r.code === 0 && FULL_SHA.test(sha) ? sha : undefined;
}

async function isAncestor(repoRoot: string, a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const r = await git(["merge-base", "--is-ancestor", a, b], { cwd: repoRoot, okCodes: [1] });
  return r.code === 0;
}
