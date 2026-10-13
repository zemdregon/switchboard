import { lstat, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { defaultIds, type IdGenerator } from "../ids/index.js";
import { createLedger, type GitCommitRow, type Ledger } from "../ledger/index.js";
import { CONTROLLER_IDENTITY, GitError, git, gitText } from "../workspace/git.js";
import { findNestedRepositories, nestedPathspecArgs } from "../workspace/nested.js";
import { DEFAULT_PUBLISH_PREFIX, PublishRefError, publishRefFor } from "./publish-ref.js";
import { createSanitizer, type SanitizeReport, type Sanitizer, SanitizerError } from "./sanitize.js";

/**
 * Controller-side commit algorithm (FR-GIT-04, FR-GIT-07, FR-GIT-08; LLD §12.3; ADR-0014, ADR-0025; T9.3). It builds one
 * commit from a path subset (or every change) of a run's worktree onto the meta-session's publish ref using Git plumbing
 * with a temporary index, and writes the provenance row. It never touches the worktree's own index, `HEAD` or the run
 * branch, never runs a provider and never reads a credential. Every Git call goes through the hardened helper in
 * `src/workspace/git.ts` (scrubbed environment, hooks off, drivers neutralised).
 *
 * Crash ordering (ADR-0025). Git and SQLite cannot share a transaction, and `git_commit` is append-only, so the order is
 * intent, ref update, outcome, each step recoverable:
 *
 * 1. build the tree and the (still unreachable) commit object; nothing is recorded;
 * 2. append the `git_commit_intent` run event, which carries the whole provenance record (SHAs, ids, rule counts);
 * 3. `update-ref <publish ref> <new> <old>` (compare-and-swap);
 * 4. in ONE ledger transaction append the `git_commit` run event and insert the `git_commit` row.
 *
 * A crash before 3 leaves an unfinished intent and no published commit; a crash between 3 and 4 leaves a published
 * commit with an unfinished intent. {@link GitPublisher.recover} resolves each unfinished intent from the repository:
 * the commit is on the publish ref (roll forward: write the row) or it is not (append `git_commit_aborted`).
 */

export type CommitErrorCode =
  | "INVALID_REQUEST"
  | "RUN_NOT_FOUND"
  | "NOT_RUNNING"
  | "LEASE_LOST"
  | "NO_WORKTREE"
  | "PATH_OUTSIDE_WORKTREE"
  | "PATH_REFUSED"
  | "NOTHING_TO_COMMIT"
  | "MESSAGE_EMPTY_AFTER_SANITISING"
  | "SANITISER_FAILED"
  | "IDENTITY_INVALID"
  | "PUBLISH_CONFLICT"
  | "PUBLISH_LINEAGE_VIOLATION"
  | "PROVENANCE_PENDING"
  | "GIT_FAILED";

export type PathRefusalReason =
  | "invalid"
  | "outside_worktree"
  | "git_dir"
  | "symlink_in_path"
  | "missing"
  | "ignored"
  | "nested_repository"
  | "contains_nested_repository";

export interface PathRefusal {
  readonly path: string;
  readonly reason: PathRefusalReason;
}

export class CommitError extends Error {
  override readonly name = "CommitError";
  constructor(
    readonly code: CommitErrorCode,
    message: string,
    /** Per-path report for `PATH_OUTSIDE_WORKTREE` and `PATH_REFUSED`; no file content. */
    readonly refused: readonly PathRefusal[] = [],
    /** Set for `PROVENANCE_PENDING`: the commit that is published but not yet recorded. */
    readonly commitSha?: string,
  ) {
    super(message);
  }
}

/** Steps reported to {@link GitPublisherOptions.testHooks}, after the step completed. */
export type PublishStep = "tree_written" | "commit_created" | "intent_recorded" | "ref_updated" | "outcome_recorded";

export interface GitPublisherOptions {
  readonly db: Database.Database;
  /** Directory for the temporary index files; created `0700`. Must be outside the worktree and the repository. */
  readonly scratchDir: string;
  /** `git.sanitize_patterns` (validated here; an invalid pattern throws when the publisher is constructed). */
  readonly sanitizePatterns?: readonly string[];
  /** Local publish ref prefix (default `switchboard/pub/`, see `publish-ref.ts`). */
  readonly publishPrefix?: string;
  readonly ids?: IdGenerator;
  readonly now?: () => Date;
  /**
   * Run states in which `commit` is accepted (default `RUNNING`). T9.7: the finalize-only publisher is a separate
   * instance with `["FINALIZING"]`, so the tool channel's publisher never accepts a FINALIZING run.
   */
  readonly allowedStates?: readonly string[];
  /**
   * Test seam for crash injection: called after each step; whatever it throws propagates as if the process had died
   * there (no cleanup writes, no abort record). Not for production use.
   */
  readonly testHooks?: { afterStep?(step: PublishStep): void | Promise<void> };
}

export interface CommitInput {
  readonly runId: string;
  readonly message: string;
  /** Worktree-relative paths; omit for all changes. At most {@link MAX_PATHS}. */
  readonly paths?: readonly string[];
  /** Context identity (FR-GIT-04). Used for author and committer. */
  readonly identity: { readonly name: string; readonly email: string };
  readonly projectId: string;
  readonly contextId: string;
  readonly origin?: "commit_tool" | "finalize_only";
  /** The run's provider-native session ids, removed from the message by exact match (FR-ADP-04). */
  readonly nativeSessionIds?: readonly string[];
  /**
   * T9.7 (FR-GIT-09): for a finalize-only commit (`origin: "finalize_only"`), the id of the run's transition event into
   * FINALIZING, which stands in for the tool-call event of FR-GIT-07. Recorded in the intent and in the `git_commit`
   * event (`via: "finalize"`, `finalizing_event_id`), so recovery after a crash keeps it.
   */
  readonly finalizingEventId?: string;
  /**
   * Owner decision 44 (ROADMAP Q-45): set only by the finalize-only path for an approved bypass run, and honoured only
   * with `origin: "finalize_only"` (the agent's own `commit` tool keeps its limits). Lifts the {@link MAX_PATHS} count
   * and truncates a sanitised message longer than {@link LOOSE_MESSAGE_MAX} characters with a one-line note. Path
   * refusals, the sanitiser and the compare-and-swap are unchanged.
   */
  readonly looseLimits?: boolean;
}

export interface CommitResult {
  readonly sha: string;
  readonly treeSha: string;
  readonly parentSha: string;
  readonly publishRef: string;
  readonly filesChanged: number;
  readonly patchId: string | null;
  readonly sanitizer: SanitizeReport;
  /** The `git_commit` row id (`gcm_...`). */
  readonly provenanceId: string;
}

export interface RecoveryReport {
  /** Intents whose commit was on the publish ref: the provenance row was written now. */
  readonly rolledForward: readonly string[];
  /** Intents whose commit never reached the publish ref: `git_commit_aborted` was appended. */
  readonly aborted: readonly string[];
  /** Intents that could not be resolved (repository unreadable); left for the next call. */
  readonly unresolved: readonly string[];
}

export const MAX_PATHS = 256;
/** Length bound of a truncated finalize-only message of an approved bypass run (equals the `commit` tool's bound). */
export const LOOSE_MESSAGE_MAX = 8192;
const TRUNCATION_NOTE = "[Summary truncated by Switchboard; the provider's complete output is in the run's artifacts.]";
const LS_TREE_CHUNK = 256; // paths per `git ls-tree` call, to keep the argument list bounded
const MAX_PATH_LENGTH = 4096;
const MAX_IDENTITY_FIELD = 256;
const ATTEMPTS = 2; // LLD §12.3 step 5: retry once after a lost race

interface IntentRecord {
  readonly commit_sha: string;
  readonly tree_sha: string;
  readonly parent_sha: string;
  readonly expected_old: string | null;
  readonly publish_ref: string;
  readonly files_changed: number;
  /** T9.7: present only for a finalize-only commit. */
  readonly via?: "finalize";
  readonly finalizing_event_id?: string;
  readonly record: {
    readonly commitSha: string;
    readonly treeSha: string;
    readonly patchId: string | null;
    readonly repoRoot: string;
    readonly publishRef: string;
    readonly projectId: string;
    readonly contextId: string;
    readonly metaSessionId: string;
    readonly runId: string;
    readonly provider: string;
    readonly harness: string;
    readonly model: string | null;
    readonly adapterVersionId: string | null;
    readonly origin: "commit_tool" | "finalize_only";
    readonly sanitizer: SanitizeReport;
  };
}

interface RunContext {
  readonly runId: string;
  readonly metaSessionId: string;
  readonly worktreePath: string;
  readonly repoRoot: string;
  readonly baseCommit: string;
  readonly provider: string;
  readonly harness: string;
  readonly model: string | null;
  readonly adapterVersionId: string | null;
}

export class GitPublisher {
  private readonly ledger: Ledger;
  private readonly ids: IdGenerator;
  private readonly now: () => Date;
  private readonly sanitizer: Sanitizer;
  private readonly allowedStates: ReadonlySet<string>;
  /** Commit SHAs between intent and outcome in this process; {@link recover} must not touch them. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly options: GitPublisherOptions) {
    this.ids = options.ids ?? defaultIds;
    this.now = options.now ?? (() => new Date());
    this.ledger = createLedger(options.db, { ids: this.ids, now: this.now });
    this.sanitizer = createSanitizer({ operatorPatterns: options.sanitizePatterns ?? [] });
    this.allowedStates = new Set(options.allowedStates ?? ["RUNNING"]);
  }

  /** The publish ref name for a meta-session under this publisher's prefix. */
  publishRef(metaSessionId: string): string {
    return publishRefFor(metaSessionId, this.options.publishPrefix ?? DEFAULT_PUBLISH_PREFIX);
  }

  /** Create one commit on the meta-session's publish ref (LLD §12.3). Throws {@link CommitError}. */
  async commit(input: CommitInput): Promise<CommitResult> {
    validateInput(input);
    const ctx = this.loadRun(input.runId);
    let publishRef: string;
    try {
      publishRef = this.publishRef(ctx.metaSessionId);
    } catch (err) {
      if (err instanceof PublishRefError) throw new CommitError("INVALID_REQUEST", err.message);
      throw err;
    }
    try {
      await this.checkWorktree(ctx);
      await mkdir(this.options.scratchDir, { recursive: true, mode: 0o700 });
      await this.checkScratch(ctx);
      let sanitized: { message: string; report: SanitizeReport } | undefined;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const done = await this.attempt(ctx, input, publishRef, () => {
          if (sanitized === undefined) sanitized = this.sanitize(input);
          return sanitized;
        });
        if (done !== "lost-race") return done;
      }
      throw new CommitError("PUBLISH_CONFLICT", `the publish ref ${publishRef} kept moving; try again`);
    } catch (err) {
      if (err instanceof CommitError) throw err;
      if (err instanceof GitError) {
        throw new CommitError("GIT_FAILED", `${err.message}${err.stderr ? `: ${firstLine(err.stderr)}` : ""}`);
      }
      throw err;
    }
  }

  /**
   * Resolve every unfinished `git_commit_intent` (all runs, or one) from the repository state. Call it at controller
   * start, before serving. Idempotent. Intents of commits currently in flight in this process are skipped.
   */
  async recover(options: { runId?: string } = {}): Promise<RecoveryReport> {
    const rows = this.options.db
      .prepare(
        `SELECT i.run_id AS run_id, i.payload_json AS payload_json FROM run_event i
         WHERE i.type = 'git_commit_intent' AND (? IS NULL OR i.run_id = ?)
           AND NOT EXISTS (SELECT 1 FROM git_commit c
                            WHERE c.run_id = i.run_id AND c.commit_sha = json_extract(i.payload_json, '$.commit_sha'))
           AND NOT EXISTS (SELECT 1 FROM run_event a
                            WHERE a.run_id = i.run_id AND a.type = 'git_commit_aborted'
                              AND json_extract(a.payload_json, '$.commit_sha') = json_extract(i.payload_json, '$.commit_sha'))
         ORDER BY i.ts, i.seq`,
      )
      .all(options.runId ?? null, options.runId ?? null) as { run_id: string; payload_json: string }[];
    const rolledForward: string[] = [];
    const aborted: string[] = [];
    const unresolved: string[] = [];
    for (const row of rows) {
      const intent = JSON.parse(row.payload_json) as IntentRecord;
      if (this.inFlight.has(intent.commit_sha)) continue;
      let published: boolean;
      try {
        published = await isOnRef(intent.record.repoRoot, intent.commit_sha, intent.publish_ref);
      } catch {
        unresolved.push(intent.commit_sha);
        continue;
      }
      if (published) {
        this.recordOutcome(intent, true);
        rolledForward.push(intent.commit_sha);
      } else {
        this.ledger.appendRunEvent({
          runId: row.run_id,
          type: "git_commit_aborted",
          payload: { commit_sha: intent.commit_sha, reason: "not_published_at_recovery" },
        });
        aborted.push(intent.commit_sha);
      }
    }
    return { rolledForward, aborted, unresolved };
  }

  // ---- internals ----------------------------------------------------------------------------------------------

  private loadRun(runId: string): RunContext {
    const run = this.ledger.getRunRecord(runId);
    if (!run) throw new CommitError("RUN_NOT_FOUND", `run ${runId} not found`);
    if (!this.allowedStates.has(run.state)) throw new CommitError("NOT_RUNNING", `run ${runId} is ${run.state}`);
    if (!run.worktree_path) throw new CommitError("NO_WORKTREE", `run ${runId} has no worktree`);
    if (!run.provider) throw new CommitError("NOT_RUNNING", `run ${runId} has no provider`);
    const session = this.options.db
      .prepare("SELECT repo_root, base_commit, lease_run_id, lease_expires_at FROM meta_session WHERE id = ?")
      .get(run.meta_session_id) as
      | {
          repo_root: string | null;
          base_commit: string | null;
          lease_run_id: string | null;
          lease_expires_at: string | null;
        }
      | undefined;
    if (!session || session.lease_run_id !== runId) {
      throw new CommitError("LEASE_LOST", `run ${runId} does not hold the write lease`);
    }
    if (session.lease_expires_at !== null && session.lease_expires_at < this.now().toISOString()) {
      throw new CommitError("LEASE_LOST", `the write lease of run ${runId} has expired`);
    }
    if (!session.repo_root || !session.base_commit) {
      throw new CommitError("NO_WORKTREE", `meta-session ${run.meta_session_id} has no repository or base commit`);
    }
    const binding = this.options.db
      .prepare(
        "SELECT harness FROM provider_binding WHERE meta_session_id = ? AND provider = ? ORDER BY last_used_at DESC LIMIT 1",
      )
      .get(run.meta_session_id, run.provider) as { harness: string } | undefined;
    const adapter = this.options.db.prepare("SELECT adapter_version_id FROM run WHERE id = ?").get(runId) as {
      adapter_version_id: string | null;
    };
    return {
      runId,
      metaSessionId: run.meta_session_id,
      worktreePath: run.worktree_path,
      repoRoot: session.repo_root,
      baseCommit: session.base_commit,
      provider: run.provider,
      harness: binding?.harness ?? run.provider,
      model: run.model,
      adapterVersionId: adapter.adapter_version_id,
    };
  }

  private async checkWorktree(ctx: RunContext): Promise<void> {
    try {
      if (!(await stat(ctx.worktreePath)).isDirectory()) throw new Error("not a directory");
      const top = await realpath(await gitText(["rev-parse", "--show-toplevel"], { cwd: ctx.worktreePath }));
      if (top !== (await realpath(ctx.worktreePath))) throw new Error("not a worktree top level");
    } catch {
      throw new CommitError("NO_WORKTREE", `the worktree of run ${ctx.runId} is missing or not a Git worktree`);
    }
  }

  private async checkScratch(ctx: RunContext): Promise<void> {
    const scratch = await realpath(this.options.scratchDir);
    for (const forbidden of [ctx.worktreePath, ctx.repoRoot]) {
      const real = await realpath(forbidden).catch(() => forbidden);
      if (scratch === real || scratch.startsWith(`${real}${path.sep}`)) {
        throw new CommitError("INVALID_REQUEST", "scratch directory must be outside the worktree and the repository");
      }
    }
  }

  private sanitize(input: CommitInput): { message: string; report: SanitizeReport } {
    let result: { message: string; report: SanitizeReport };
    try {
      const s =
        input.nativeSessionIds && input.nativeSessionIds.length > 0
          ? createSanitizer({
              operatorPatterns: this.options.sanitizePatterns ?? [],
              nativeSessionIds: input.nativeSessionIds,
            })
          : this.sanitizer;
      result = s.sanitize(input.message);
    } catch (err) {
      if (err instanceof SanitizerError) throw new CommitError("SANITISER_FAILED", `${err.code}: ${err.message}`);
      throw err;
    }
    if (result.message.trim() === "") {
      throw new CommitError("MESSAGE_EMPTY_AFTER_SANITISING", "the message is empty after sanitising");
    }
    if (loosened(input) && result.message.length > LOOSE_MESSAGE_MAX) {
      // The sanitiser has already seen the whole text, so a cut cannot split anything it would have removed.
      return { message: truncateMessage(result.message), report: result.report };
    }
    return result;
  }

  /** One pass of LLD §12.3 steps 2 to 6. Returns the result, or `"lost-race"` when the compare-and-swap lost. */
  private async attempt(
    ctx: RunContext,
    input: CommitInput,
    publishRef: string,
    sanitizedMessage: () => { message: string; report: SanitizeReport },
  ): Promise<CommitResult | "lost-race"> {
    const cwd = ctx.worktreePath;
    const old = await resolveCommit(ctx.repoRoot, publishRef);
    const parent = old ?? (await resolveCommit(ctx.repoRoot, ctx.baseCommit));
    if (!parent) throw new CommitError("NO_WORKTREE", "the session's base commit is not in the repository");
    const parentTree = await gitText(["rev-parse", "--verify", "--end-of-options", `${parent}^{tree}`], { cwd });

    const tmp = await mkdtemp(path.join(this.options.scratchDir, "idx-"));
    let tree: string;
    let filesChanged: number;
    try {
      const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
      await git(["read-tree", parent], { cwd, env });
      if (input.paths === undefined) {
        const nested = await findNestedRepositories(cwd);
        await git(["add", "-A", "--", ".", ...nestedPathspecArgs(nested).slice(2)], { cwd, env });
      } else {
        const accepted = await this.classifyPaths(ctx, parentTree, input.paths);
        // Pathspecs on stdin (NUL separated), so a large finalize-only path list cannot exceed the argument limit.
        await git(["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
          cwd,
          env,
          input: `${accepted.join("\0")}\0`,
        });
      }
      tree = await gitText(["write-tree"], { cwd, env });
      if (tree === parentTree) throw new CommitError("NOTHING_TO_COMMIT", "nothing to commit");
      const names = await git(["diff-tree", "-r", "--name-only", "-z", "--no-renames", parentTree, tree], { cwd });
      filesChanged = names.stdout
        .toString("utf8")
        .split("\0")
        .filter((n) => n !== "").length;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    await this.options.testHooks?.afterStep?.("tree_written");

    const sanitized = sanitizedMessage();
    const when = Math.floor(this.now().getTime() / 1000);
    const identity = input.identity;
    const sha = (
      await git(["commit-tree", tree, "-p", parent, "-F", "-"], {
        cwd,
        input: `${sanitized.message}\n`,
        env: {
          GIT_AUTHOR_NAME: identity.name,
          GIT_AUTHOR_EMAIL: identity.email,
          GIT_AUTHOR_DATE: `${when} +0000`,
          GIT_COMMITTER_NAME: identity.name,
          GIT_COMMITTER_EMAIL: identity.email,
          GIT_COMMITTER_DATE: `${when} +0000`,
        },
      })
    ).stdout
      .toString("utf8")
      .trim();
    await this.options.testHooks?.afterStep?.("commit_created");

    // Defence in depth: the new commit must add exactly itself on top of the base and the old head, so no checkpoint
    // or other run-branch commit can be reachable from the publish ref (FR-GIT-08).
    const excluded = old ? [ctx.baseCommit, old] : [ctx.baseCommit];
    const added = Number(await gitText(["rev-list", "--count", sha, "--not", ...excluded], { cwd }));
    if (added !== 1) {
      throw new CommitError(
        "PUBLISH_LINEAGE_VIOLATION",
        `the new commit would add ${added} commits to the publish ref`,
      );
    }
    const patchId = await patchIdOf(cwd, parent, sha);

    const intent: IntentRecord = {
      commit_sha: sha,
      tree_sha: tree,
      parent_sha: parent,
      expected_old: old ?? null,
      publish_ref: publishRef,
      files_changed: filesChanged,
      ...(input.origin === "finalize_only"
        ? {
            via: "finalize" as const,
            ...(input.finalizingEventId !== undefined ? { finalizing_event_id: input.finalizingEventId } : {}),
          }
        : {}),
      record: {
        commitSha: sha,
        treeSha: tree,
        patchId,
        repoRoot: ctx.repoRoot,
        publishRef,
        projectId: input.projectId,
        contextId: input.contextId,
        metaSessionId: ctx.metaSessionId,
        runId: ctx.runId,
        provider: ctx.provider,
        harness: ctx.harness,
        model: ctx.model,
        adapterVersionId: ctx.adapterVersionId,
        origin: input.origin ?? "commit_tool",
        sanitizer: sanitized.report,
      },
    };
    this.ledger.appendRunEvent({ runId: ctx.runId, type: "git_commit_intent", payload: intent });
    this.inFlight.add(sha);
    try {
      await this.options.testHooks?.afterStep?.("intent_recorded");

      const zero = "0".repeat(parent.length);
      try {
        await git(["update-ref", publishRef, sha, old ?? zero], { cwd });
      } catch (err) {
        if (!(err instanceof GitError)) throw err;
        const now = await resolveCommit(ctx.repoRoot, publishRef);
        this.ledger.appendRunEvent({
          runId: ctx.runId,
          type: "git_commit_aborted",
          payload: { commit_sha: sha, reason: now !== old ? "publish_ref_moved" : "update_ref_failed" },
        });
        if (now !== old) return "lost-race";
        throw err;
      }
      await this.options.testHooks?.afterStep?.("ref_updated");

      let row: GitCommitRow;
      try {
        row = this.recordOutcome(intent, false);
      } catch (err) {
        throw new CommitError(
          "PROVENANCE_PENDING",
          `commit ${sha} is on ${publishRef} but its provenance row was not written (${(err as Error).message}); run recovery`,
          [],
          sha,
        );
      }
      await this.options.testHooks?.afterStep?.("outcome_recorded");
      return {
        sha,
        treeSha: tree,
        parentSha: parent,
        publishRef,
        filesChanged,
        patchId,
        sanitizer: sanitized.report,
        provenanceId: row.id,
      };
    } finally {
      this.inFlight.delete(sha);
    }
  }

  /** The outcome step: `git_commit` event and row in one transaction (idempotent per run and commit). */
  private recordOutcome(intent: IntentRecord, recovered: boolean): GitCommitRow {
    const r = intent.record;
    return this.ledger.recordGitCommit({
      ...r,
      eventPayload: {
        commit_sha: r.commitSha,
        tree_sha: r.treeSha,
        parent_sha: intent.parent_sha,
        publish_ref: r.publishRef,
        files_changed: intent.files_changed,
        origin: r.origin,
        ...(intent.via !== undefined ? { via: intent.via } : {}),
        ...(intent.finalizing_event_id !== undefined ? { finalizing_event_id: intent.finalizing_event_id } : {}),
        sanitizer: r.sanitizer,
        ...(recovered ? { recovered: true } : {}),
      },
    }).row;
  }

  /**
   * Per-path checks before anything is staged (LLD §12.3 step 1). Returns the normalised accepted paths, or throws
   * with a report for every refused path. Nothing is partially committed.
   */
  private async classifyPaths(ctx: RunContext, parentTree: string, requested: readonly string[]): Promise<string[]> {
    const cwd = ctx.worktreePath;
    const refused: PathRefusal[] = [];
    const candidates: string[] = [];
    const seen = new Set<string>();
    for (const raw of requested) {
      const verdict = syntacticVerdict(raw);
      if ("reason" in verdict) {
        refused.push({ path: String(raw), reason: verdict.reason });
        continue;
      }
      if (!seen.has(verdict.path)) {
        seen.add(verdict.path);
        candidates.push(verdict.path);
      }
    }

    const nested = await findNestedRepositories(cwd);
    const live: { rel: string; exists: boolean }[] = [];
    for (const rel of candidates) {
      if (await hasSymlinkAncestor(cwd, rel)) {
        refused.push({ path: rel, reason: "symlink_in_path" });
        continue;
      }
      if (nested.paths.some((n) => rel === n || rel.startsWith(`${n}/`))) {
        refused.push({ path: rel, reason: "nested_repository" });
        continue;
      }
      if (nested.paths.some((n) => n.startsWith(`${rel}/`))) {
        refused.push({ path: rel, reason: "contains_nested_repository" });
        continue;
      }
      live.push({
        rel,
        exists: await lstat(path.join(cwd, rel)).then(
          () => true,
          () => false,
        ),
      });
    }

    if (live.length > 0) {
      const inParent: string[] = [];
      for (let i = 0; i < live.length; i += LS_TREE_CHUNK) {
        const listing = await git(
          [
            "--literal-pathspecs",
            "ls-tree",
            "-r",
            "-z",
            "--name-only",
            parentTree,
            "--",
            ...live.slice(i, i + LS_TREE_CHUNK).map((l) => l.rel),
          ],
          { cwd },
        );
        inParent.push(
          ...listing.stdout
            .toString("utf8")
            .split("\0")
            .filter((n) => n !== ""),
        );
      }
      const tracked = (rel: string) => inParent.some((n) => n === rel || n.startsWith(`${rel}/`));
      const untrackedExisting: string[] = [];
      for (const { rel, exists } of live) {
        if (!exists && !tracked(rel)) refused.push({ path: rel, reason: "missing" });
        else if (exists && !tracked(rel)) untrackedExisting.push(rel);
      }
      if (untrackedExisting.length > 0) {
        const ignored = await git(["check-ignore", "--no-index", "-z", "--stdin"], {
          cwd,
          okCodes: [1],
          input: `${untrackedExisting.join("\0")}\0`,
        });
        const ignoredSet = new Set(
          ignored.stdout
            .toString("utf8")
            .split("\0")
            .filter((n) => n !== ""),
        );
        for (const rel of untrackedExisting) {
          if (ignoredSet.has(rel)) refused.push({ path: rel, reason: "ignored" });
        }
      }
    }

    if (refused.length > 0) {
      const outside = refused.some((r) => r.reason === "outside_worktree" || r.reason === "symlink_in_path");
      throw new CommitError(
        outside ? "PATH_OUTSIDE_WORKTREE" : "PATH_REFUSED",
        `${refused.length} path(s) refused: ${refused.map((r) => `${JSON.stringify(r.path)} (${r.reason})`).join(", ")}`,
        refused,
      );
    }
    return candidates;
  }
}

// ---- helpers ----------------------------------------------------------------------------------------------------

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? ""
  );
}

/** True only for the finalize-only commit of an approved bypass run (owner decision 44). */
function loosened(input: CommitInput): boolean {
  return input.looseLimits === true && input.origin === "finalize_only";
}

/** Cut an already sanitised message at a line boundary (or at the character limit) and append the one-line note. */
function truncateMessage(message: string): string {
  const room = LOOSE_MESSAGE_MAX - TRUNCATION_NOTE.length - 2;
  const head = message.slice(0, room);
  const cut = head.lastIndexOf("\n");
  // A line boundary only when it keeps at least half of the room; one very long line is cut at the limit instead.
  const kept = (cut >= room / 2 ? head.slice(0, cut) : head).trimEnd();
  return `${kept}\n\n${TRUNCATION_NOTE}`;
}

function validateInput(input: CommitInput): void {
  if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new CommitError("INVALID_REQUEST", "message must be a non-empty string");
  }
  if (input.paths !== undefined) {
    if (!Array.isArray(input.paths) || input.paths.length === 0) {
      throw new CommitError("INVALID_REQUEST", "paths must be omitted (all changes) or a non-empty array");
    }
    if (input.paths.length > MAX_PATHS && !loosened(input)) {
      throw new CommitError("INVALID_REQUEST", `at most ${MAX_PATHS} paths`);
    }
  }
  const { name, email } = input.identity ?? { name: "", email: "" };
  for (const v of [name, email]) {
    if (
      typeof v !== "string" ||
      v.trim() === "" ||
      v.length > MAX_IDENTITY_FIELD ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
      /[<>\u0000-\u001F\u007F]/u.test(v)
    ) {
      throw new CommitError("IDENTITY_INVALID", "the commit identity needs a plain name and e-mail address");
    }
  }
  // The checkpoint identity marks internal commits and must never appear on a published commit (TDD §3.10).
  if (email.trim().toLowerCase() === CONTROLLER_IDENTITY.email) {
    throw new CommitError(
      "IDENTITY_INVALID",
      "the controller's checkpoint identity cannot be used for published commits",
    );
  }
  if (!input.projectId || !input.contextId) {
    throw new CommitError("INVALID_REQUEST", "projectId and contextId are required");
  }
}

/** Normalised worktree-relative path, or the reason it is refused before touching the file system. */
function syntacticVerdict(raw: unknown): { path: string } | { reason: PathRefusalReason } {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a NUL byte can never be part of a path
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_PATH_LENGTH || /\u0000/u.test(raw)) {
    return { reason: "invalid" };
  }
  if (path.isAbsolute(raw)) return { reason: "outside_worktree" };
  const norm = path.posix.normalize(raw).replace(/\/+$/u, "");
  if (norm === "." || norm === "") return { reason: "invalid" };
  if (norm === ".." || norm.startsWith("../")) return { reason: "outside_worktree" };
  if (norm.split("/").some((seg) => seg.toLowerCase() === ".git")) return { reason: "git_dir" };
  return { path: norm };
}

/** A symbolic link on any directory component would let Git (or us) step outside the worktree. */
async function hasSymlinkAncestor(root: string, rel: string): Promise<boolean> {
  const segments = rel.split("/").slice(0, -1);
  let current = root;
  for (const seg of segments) {
    current = path.join(current, seg);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch {
      return false; // component missing: nothing further can be a link
    }
  }
  return false;
}

async function resolveCommit(cwd: string, rev: string): Promise<string | undefined> {
  const r = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], {
    cwd,
    okCodes: [1],
  });
  const out = r.stdout.toString("utf8").trim();
  return r.code === 0 && out !== "" ? out : undefined;
}

async function isOnRef(repoRoot: string, sha: string, ref: string): Promise<boolean> {
  const head = await resolveCommit(repoRoot, ref);
  if (head === undefined) return false;
  const r = await git(["merge-base", "--is-ancestor", sha, head], { cwd: repoRoot, okCodes: [1] });
  return r.code === 0;
}

/** `git patch-id --stable` of the commit's diff against its parent; best effort (LLD §12.7), `null` on failure. */
async function patchIdOf(cwd: string, parent: string, sha: string): Promise<string | null> {
  try {
    const diff = await git(["diff-tree", "-p", "--no-ext-diff", "--no-textconv", "--no-color", parent, sha], { cwd });
    const out = await git(["patch-id", "--stable"], { cwd, input: diff.stdout });
    const id = out.stdout.toString("utf8").trim().split(/\s+/u)[0];
    return id && /^[0-9a-f]{40,64}$/u.test(id) ? id : null;
  } catch {
    return null;
  }
}
