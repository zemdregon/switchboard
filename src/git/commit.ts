import { lstat, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { defaultIds, type IdGenerator } from "../ids/index.js";
import { createLedger, type GitCommitRow, type Ledger } from "../ledger/index.js";
import {
  createSubmoduleCommits,
  gitlinkIndexInfo,
  type MadeSubmoduleCommit,
  moveDuplicates,
  planSubmoduleCommits,
  resolveSubmoduleParents,
  routeSubmodulePath,
  SubmoduleDivergedError,
  type SubmoduleParents,
  type SubmodulePlan,
  type SubmoduleSkip,
  submoduleCwd,
  updateStoreRefs,
} from "../submodules/commit.js";
import { SubmoduleError } from "../submodules/errors.js";
import { insertSubmoduleCommit } from "../submodules/ledger.js";
import { type AttachRecord, attachRecordFile, readAttachRecord } from "../submodules/worktree.js";
import { CONTROLLER_IDENTITY, GitError, git, gitText } from "../workspace/git.js";
import { nativeExcludePathspecs, recordedNativePaths } from "../workspace/native-skills.js";
import { excludePathspec, findNestedRepositories, nestedPathspecArgs } from "../workspace/nested.js";
import type { CredentialReach } from "./credential-reach.js";
import { DEFAULT_PUBLISH_PREFIX, PublishRefError, publishRefFor } from "./publish-ref.js";
import { MAX_SECRET_SCAN_HIT_EVENTS } from "./push.js";
import { createSanitizer, type SanitizeReport, type Sanitizer, SanitizerError } from "./sanitize.js";
import {
  compileSecretScanAllow,
  SECRET_SCAN_HIT_EVENT,
  type SecretScanAllow,
  type SecretScanAllowEntry,
  scanOutgoingDiff,
} from "./secret-scan.js";
import {
  DEFAULT_SIGN_TIMEOUT_MS,
  repoSigningConfigUnsafe,
  type SigningFailureReason,
  signedCommitTree,
} from "./sign.js";

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
 * Signing (T9.10, FR-GIT-10, LLD §12.3.1, ADR-0034): with {@link CommitInput.sign} the commit object of step 1 is
 * made by `src/git/sign.ts` with the operator's signing setup. The BR-31 verdict and the repository's own signing
 * configuration are checked first; any refusal or signing failure is `SIGNING_FAILED` with a
 * `git_commit_signing_failed` run event (reason code only), before any intent, so the publish ref never moves and no
 * unsigned commit is made. Without `sign` nothing about this path changes.
 *
 * Commit-message task (T11.4, FR-INN-10, LLD §12.1, §12.3 step 2 (M11), ADR-0016): the tool channel may hand in a
 * {@link CommitMessageTask}. After the tree is written, and only when the task applies (no agent message, or mode
 * `always`), its `draft` receives the diff of exactly the committed paths and returns text or "unavailable". This module
 * never imports the inner-agent service: the task is an injected function, and whatever it returns is untrusted text
 * that passes {@link GitPublisher}'s own sanitiser (the same built-in and operator rules as an agent message) before
 * `commit-tree`; the sanitiser is the only producer of the text Git receives. No usable draft and no agent message is
 * `MESSAGE_REQUIRED`; the controller never writes a stand-in. Without a task nothing about this path changes.
 *
 * Rebase runs (T15.7, FR-QUE-07, LLD §20.4): when the run has a `prepared` `run_rebase` row (the controller merged the
 * base into the worktree, `src/git/rebase-prep.ts`), the run's first commit records that base commit as its second
 * parent (`commit-tree -p <old> -p <base>`, signed or not). It is added only while it is a full SHA of a commit in the
 * repository that is not yet an ancestor of the first parent, so later commits of the run and retries stay single
 * parent. The message, sanitiser, compare-and-swap and provenance path are the same; the lineage check also excludes
 * the merge parent and still requires exactly one new commit, and `merge_parent_sha` is added to the intent and the
 * `git_commit` event. Without such a row nothing about this path changes.
 *
 * Commit-time secret scan (T9.14; FR-GIT-11; ADR-0061 point 4; LLD §20.9). Once the commit is published and recorded,
 * the added lines of `parent..commit` are scanned with the push's scanner (`src/git/secret-scan.ts`, the same rules and
 * the same operator allowlist, {@link GitPublisherOptions.secretScanAllow}) and each hit is one `secret_scan_hit` event
 * `{stage: "commit", rule_id, path, line, ref, commit_sha}` (never the value). It only WARNS: it runs after the commit
 * exists, it never refuses, and a scan or ledger failure is swallowed, so the commit and its result are unchanged. The
 * push still scans and refuses on its own.
 *
 * Submodule commits (ADR-0080 item 4, FR-GIT-14): when the run worktree has an attach record
 * (`src/submodules/worktree.ts`, written by the workspace manager for a context with `submodules.mode: "recursive"`)
 * and {@link GitPublisherOptions.submoduleCloneRoot} is set, each changed writable submodule in scope (every one for
 * "all changes" and for `allSubmodules`; a named one for explicit `paths`) gets one commit in its store, made by
 * `src/submodules/commit.ts` after the message is chosen, with the same identity, sanitised message and signing. The
 * umbrella's temporary index then gets every attached path's gitlink (the new commit, duplicates together, else the
 * parent's), so nothing the agent did to a submodule `HEAD` is committed. The intent carries the submodule commits;
 * each store's publish ref moves (compare-and-swap) between the intent and the umbrella `update-ref`; the
 * `submodule_commit` rows are written in the transaction of the `git_commit` row (also on recovery). An explicit path
 * inside an attached submodule is committed in that submodule only (refused `submodule_read_only` in a read-only one,
 * `submodule_link_invalid` when its `.git` link does not verify); a directory that contains one is still refused
 * (`contains_nested_repository`). Without an attach record nothing about this path changes (ADR-0022).
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
  | "SIGNING_FAILED"
  | "MESSAGE_REQUIRED"
  | "GIT_FAILED";

export type PathRefusalReason =
  | "invalid"
  | "outside_worktree"
  | "git_dir"
  | "symlink_in_path"
  | "missing"
  | "ignored"
  | "nested_repository"
  | "contains_nested_repository"
  /** ADR-0080 item 4: inside an attached read-only submodule (a wiki included). */
  | "submodule_read_only"
  /** ADR-0080 item 4: inside an attached submodule whose `.git` link does not verify (fail closed). */
  | "submodule_link_invalid"
  /** ADR-0080 item 4: two paths of one submodule repository changed to different trees. */
  | "submodule_duplicate_diverged";

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
    /**
     * T16.6 (LLD §19.8 `details.reason`): `SKILL_PATH_IN_COMMIT` when the tree would contain a recorded native skill
     * path (with code `PATH_REFUSED`). The tool line protocol carries a code and a message only, so the message names it.
     */
    readonly detailReason?: "SKILL_PATH_IN_COMMIT",
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
  /**
   * T9.10: environment the signing step copies its allowlisted variables from (`src/git/sign.ts`), read at each signed
   * commit. Default `process.env`. Only the controller's own `git` child for that step receives them.
   */
  readonly signingEnv?: Readonly<Record<string, string | undefined>>;
  /** T9.10: bound of one signing step (default {@link DEFAULT_SIGN_TIMEOUT_MS}). */
  readonly signTimeoutMs?: number;
  /**
   * T9.14: the operator allowlist of the secret scan (`git.secret_scan.allow`), the same entries the push uses, so an
   * allowlisted fixture does not warn at every commit. An unknown rule id throws when the publisher is constructed.
   */
  readonly secretScanAllow?: readonly SecretScanAllowEntry[];
  /**
   * ADR-0080 item 4: `project_sources.clone_root`, where every submodule store lives. An attach record's stores must be
   * under it. Unset: submodule commits are off and an attach record refuses the commit (fail closed).
   */
  readonly submoduleCloneRoot?: string;
}

/** Run event appended when a signed commit is refused or signing fails (T9.10). Reason codes only, never key data. */
export const GIT_COMMIT_SIGNING_FAILED_EVENT = "git_commit_signing_failed";

/** Why a signed commit was not made (the `reason` of {@link GIT_COMMIT_SIGNING_FAILED_EVENT}). */
export type SigningRefusalReason = "credential_reach" | "repo_config_unsafe" | SigningFailureReason;

/**
 * T11.4: what the commit algorithm hands the commit-message task (LLD §13.6 `commit_message` input fields). Built from the
 * two tree objects only, never from a run object or transcript. Paths are worktree-relative.
 */
export interface CommitDraftRequest {
  /** `git diff-tree -r --numstat` of the parent tree and the new tree: added, deleted and path per changed file. */
  readonly numstat: string;
  /** `git diff-tree -r -p` of the same two trees (exactly the paths being committed). */
  readonly diff: string;
  /** Up to {@link MAX_RECENT_SUBJECTS} subject lines of the commit's parent history (style hint). */
  readonly recentSubjects: readonly string[];
  /**
   * The publisher's own sanitiser for this commit (built-in and operator rules plus the run's native session ids).
   * Returns the sanitised text, or null when nothing is left or the sanitiser refuses the text. Lets the inner pipeline
   * record `rejected_sanitiser` (LLD §13.4 step 10); the publisher sanitises the chosen text again regardless.
   */
  readonly sanitise: (text: string) => string | null;
}

/** T11.4: the result of one draft. `ok: false` covers every fallback (disabled, denied, unavailable, invalid). */
export type CommitDraftResult =
  | { readonly ok: true; readonly text: string; readonly innerCallId: string | null }
  | { readonly ok: false };

/** T11.4 (FR-INN-10): the commit-message task, injected by the tool channel only when it is enabled for the run. */
export interface CommitMessageTask {
  /** `never` is represented by passing no task at all. */
  readonly mode: "draft_if_missing" | "always";
  /** Must not throw; a throw is treated as `{ ok: false }`. Bounded by the inner agent's per-call timeout. */
  draft(request: CommitDraftRequest): Promise<CommitDraftResult>;
}

export interface CommitInput {
  readonly runId: string;
  /**
   * The agent's message. Required unless {@link messageTask} is set (T11.4), in which case it may be omitted and the
   * task drafts one; when present it is never sent to the task.
   */
  readonly message?: string;
  /** T11.4: only from the tool channel (`origin` `commit_tool`); refused with `INVALID_REQUEST` otherwise. */
  readonly messageTask?: CommitMessageTask;
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
  /**
   * T9.10 (FR-GIT-10, FRD BR-33): sign this commit with the operator's signing setup. Set by the caller only when the
   * run's frozen project snapshot has `sign: true`, with the BR-31 verdict the caller evaluated for the run
   * (`evaluateSigningReach`, the same rule and bypass exemption as `push`). Absent: unsigned, exactly as before.
   */
  readonly sign?: { readonly reach: CredentialReach };
  /**
   * ADR-0080 item 4: set only by the finalize-only path (honoured only with `origin: "finalize_only"`). Every attached
   * writable submodule is committed in full, whatever `paths` names (the run's changed paths cannot see inside a
   * submodule); a `paths` entry inside a read-only or unverifiable submodule is reported in `submodulesSkipped`
   * instead of refused; and `paths` may be empty (submodule changes only).
   */
  readonly allSubmodules?: boolean;
}

/** ADR-0080 item 4: one submodule commit made with an umbrella commit. */
export interface SubmoduleCommitSummary {
  /** Every umbrella path whose gitlink was set to {@link commitSha} (two for a repository referenced twice). */
  readonly paths: readonly string[];
  /** `host/owner/repo` source key. */
  readonly repo: string;
  readonly commitSha: string;
  readonly parentSha: string;
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
  /** T11.4: `inner` when the committed message was drafted by the inner agent. */
  readonly messageSource: "agent" | "inner";
  /** T15.7: the second parent (the merged base) of a rebase run's first commit; absent otherwise. */
  readonly mergeParentSha?: string;
  /** ADR-0080 item 4: present (possibly empty) only when the run worktree has attached submodules. */
  readonly submodules?: readonly SubmoduleCommitSummary[];
  /** ADR-0080 item 4: changed or named submodule paths not committed, with the reason; same presence rule. */
  readonly submodulesSkipped?: readonly SubmoduleSkip[];
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
/** LLD §13.6 `commit_message`: up to 5 recent subject lines of the publish ref as a style hint. */
export const MAX_RECENT_SUBJECTS = 5;
const MAX_SUBJECT_HINT_CHARS = 200;

interface ChosenMessage {
  readonly message: string;
  readonly report: SanitizeReport;
  readonly source: "agent" | "inner";
  readonly innerCallId: string | null;
}

interface IntentRecord {
  readonly commit_sha: string;
  readonly tree_sha: string;
  readonly parent_sha: string;
  readonly expected_old: string | null;
  readonly publish_ref: string;
  readonly files_changed: number;
  /** T9.10: present (and `true`) only for a signed commit. */
  readonly signed?: true;
  /** T9.7: present only for a finalize-only commit. */
  readonly via?: "finalize";
  readonly finalizing_event_id?: string;
  /** T15.7: present only for a rebase run's two-parent commit (the second parent). */
  readonly merge_parent_sha?: string;
  /** ADR-0080 item 4: present only when submodule commits were made; recorded as `submodule_commit` rows. */
  readonly submodules?: readonly {
    readonly repo: string;
    readonly paths: readonly string[];
    readonly parent_sha: string;
    readonly commit_sha: string;
  }[];
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
    /** T11.4: present only for a drafted message (absent reads as `agent`, also on intents written before T11.4). */
    readonly messageSource?: "inner";
    readonly innerCallId?: string | null;
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
  private readonly secretScanAllow: SecretScanAllow;
  /** Commit SHAs between intent and outcome in this process; {@link recover} must not touch them. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly options: GitPublisherOptions) {
    this.ids = options.ids ?? defaultIds;
    this.now = options.now ?? (() => new Date());
    this.ledger = createLedger(options.db, { ids: this.ids, now: this.now });
    this.sanitizer = createSanitizer({ operatorPatterns: options.sanitizePatterns ?? [] });
    this.allowedStates = new Set(options.allowedStates ?? ["RUNNING"]);
    this.secretScanAllow = compileSecretScanAllow(options.secretScanAllow ?? []);
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
      if (input.sign !== undefined) await this.checkSigning(ctx, input);
      const record = await this.attachRecord(ctx);
      // Chosen once and reused after a lost race (the draft is not requested twice; Delegated, T11.4).
      let chosen: ChosenMessage | undefined;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const done = await this.attempt(ctx, input, publishRef, record, async (draftRequest) => {
          chosen ??= await this.chooseMessage(input, draftRequest);
          return chosen;
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

  /**
   * ADR-0080 item 4: whether the run's worktree has attached submodules (an attach record exists). A cheap check for
   * the finalize-only path, which has no umbrella paths to commit when only submodules changed. Never throws.
   */
  async hasAttachedSubmodules(runId: string): Promise<boolean> {
    const run = this.ledger.getRunRecord(runId);
    if (!run?.worktree_path) return false;
    return lstat(attachRecordFile(run.worktree_path)).then(
      () => true,
      () => false,
    );
  }

  // ---- internals ----------------------------------------------------------------------------------------------

  /**
   * ADR-0080 item 4: the run worktree's attach record, or undefined when there is none. A record that is not valid,
   * names another worktree, or exists without {@link GitPublisherOptions.submoduleCloneRoot} refuses the commit
   * (`GIT_FAILED`; fail closed): nothing would keep the umbrella from recording a gitlink the agent chose.
   */
  private async attachRecord(ctx: RunContext): Promise<AttachRecord | undefined> {
    const file = attachRecordFile(ctx.worktreePath);
    const invalid = () =>
      new CommitError(
        "GIT_FAILED",
        `the submodule attach record of run ${ctx.runId} is not valid; nothing was committed`,
      );
    const root = this.options.submoduleCloneRoot;
    if (root === undefined) {
      const exists = await lstat(file).then(
        () => true,
        () => false,
      );
      if (exists) throw invalid();
      return undefined;
    }
    let record: AttachRecord | undefined;
    try {
      record = await readAttachRecord(file, root);
    } catch (err) {
      if (err instanceof SubmoduleError) throw invalid();
      throw err;
    }
    if (record === undefined) return undefined;
    if (record.worktree !== (await realpath(ctx.worktreePath))) throw invalid();
    return record;
  }

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

  /** The sanitiser for this commit: built-in and operator rules, plus the run's native session ids when known. */
  private sanitizerFor(input: CommitInput): Sanitizer {
    return input.nativeSessionIds && input.nativeSessionIds.length > 0
      ? createSanitizer({
          operatorPatterns: this.options.sanitizePatterns ?? [],
          nativeSessionIds: input.nativeSessionIds,
        })
      : this.sanitizer;
  }

  /**
   * T11.4 (LLD §12.1, §12.3 steps 2 and 3, §13.7): pick the message. Without a task, or with `draft_if_missing` and an
   * agent message, this is exactly the pre-T11.4 path (no draft is requested). Otherwise the draft is requested; a
   * usable draft (non-empty after this publisher's sanitiser) wins; else the agent's message when there is one (mode
   * `always`); else `MESSAGE_REQUIRED`. Every returned message has passed {@link sanitize}.
   */
  private async chooseMessage(input: CommitInput, request: () => Promise<CommitDraftRequest>): Promise<ChosenMessage> {
    const task = input.messageTask;
    const agent = input.message;
    if (task === undefined || (task.mode === "draft_if_missing" && agent !== undefined)) {
      return { ...this.sanitize(input, agent ?? ""), source: "agent", innerCallId: null };
    }
    let draft: CommitDraftResult = { ok: false };
    try {
      draft = await task.draft(await request());
    } catch {
      draft = { ok: false }; // the task contract never throws; this keeps a broken one from failing the call
    }
    if (draft.ok && typeof draft.text === "string") {
      const clean = this.trySanitize(input, draft.text);
      if (clean !== undefined) return { ...clean, source: "inner", innerCallId: draft.innerCallId };
    }
    if (agent !== undefined) return { ...this.sanitize(input, agent), source: "agent", innerCallId: null };
    throw new CommitError(
      "MESSAGE_REQUIRED",
      "no commit message was given and none could be drafted; call commit again with a message",
    );
  }

  /** {@link sanitize} for drafted text: undefined (instead of an error) when nothing usable is left or it is refused. */
  private trySanitize(input: CommitInput, text: string): { message: string; report: SanitizeReport } | undefined {
    try {
      return this.sanitize(input, text);
    } catch (err) {
      if (err instanceof CommitError) return undefined;
      throw err;
    }
  }

  private sanitize(input: CommitInput, text: string): { message: string; report: SanitizeReport } {
    let result: { message: string; report: SanitizeReport };
    try {
      result = this.sanitizerFor(input).sanitize(text);
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
    record: AttachRecord | undefined,
    messageFor: (draftRequest: () => Promise<CommitDraftRequest>) => Promise<ChosenMessage>,
  ): Promise<CommitResult | "lost-race"> {
    const cwd = ctx.worktreePath;
    const old = await resolveCommit(ctx.repoRoot, publishRef);
    const parent = old ?? (await resolveCommit(ctx.repoRoot, ctx.baseCommit));
    if (!parent) throw new CommitError("NO_WORKTREE", "the session's base commit is not in the repository");
    const mergeParent = await this.mergeParentFor(ctx, parent);
    const parentTree = await gitText(["rev-parse", "--verify", "--end-of-options", `${parent}^{tree}`], { cwd });
    // ADR-0080 item 4: the umbrella parent's gitlinks and each submodule repository's next parent.
    const parents =
      record !== undefined
        ? await resolveSubmoduleParents({
            db: this.options.db,
            metaSessionId: ctx.metaSessionId,
            record,
            umbrellaCwd: cwd,
            umbrellaParent: parent,
          })
        : undefined;
    const finalizeAll = input.allSubmodules === true && input.origin === "finalize_only";

    const tmp = await mkdtemp(path.join(this.options.scratchDir, "idx-"));
    let tree: string;
    let filesChanged: number;
    let plan: SubmodulePlan | undefined;
    let routedSkips: readonly SubmoduleSkip[] = [];
    try {
      const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
      await git(["read-tree", parent], { cwd, env });
      // T16.6 (LLD §19.8): the run's recorded native skill paths, while not verified removed.
      const skillPaths = recordedNativePaths(this.options.db, ctx.runId);
      let explicit: ReadonlyMap<string, readonly string[] | "all"> = new Map();
      if (input.paths === undefined) {
        // Attached submodules are nested repositories here too: their contents never enter the umbrella's add. Their
        // paths are excluded by name as well, so a removed `.git` link cannot turn one into plain umbrella files.
        const nested = await findNestedRepositories(cwd);
        await git(
          [
            "add",
            "-A",
            "--",
            ".",
            ...nestedPathspecArgs(nested).slice(2),
            ...nativeExcludePathspecs(skillPaths),
            ...(record?.entries.map((e) => excludePathspec(e.path)) ?? []),
          ],
          { cwd, env },
        );
      } else {
        const classified = await this.classifyPaths(
          ctx,
          parentTree,
          input.paths,
          record !== undefined && parents !== undefined ? { record, parents, finalizeAll } : undefined,
        );
        explicit = classified.submodules;
        routedSkips = classified.skipped;
        if (classified.umbrella.length > 0) {
          // Pathspecs on stdin (NUL separated), so a large finalize-only path list cannot exceed the argument limit.
          await git(["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
            cwd,
            env,
            input: `${classified.umbrella.join("\0")}\0`,
          });
        }
      }
      if (record !== undefined && parents !== undefined) {
        plan = await this.planSubmodules(ctx, record, parents, {
          all: input.paths === undefined || finalizeAll,
          explicit,
          skillPaths,
          publishRef,
        });
        // Every attached path's gitlink back to the parent's: the umbrella index never records a submodule `HEAD`
        // the agent could have moved. The new gitlinks are set once the submodule commits exist.
        await git(["update-index", "--index-info"], { cwd, env, input: gitlinkIndexInfo(record, parents, []) });
      }
      if (skillPaths.length > 0) {
        // An explicitly named path (or a directory holding one) was added literally: put those entries back to the
        // parent's, so the commit never changes a recorded path.
        await git(["--literal-pathspecs", "reset", "-q", parent, "--", ...skillPaths], { cwd, env });
      }
      tree = await gitText(["write-tree"], { cwd, env });
      if (skillPaths.length > 0) {
        const inTree = await git(
          ["--literal-pathspecs", "ls-tree", "-r", "-z", "--name-only", tree, "--", ...skillPaths],
          {
            cwd,
          },
        );
        if (inTree.stdout.length > 0) {
          throw new CommitError(
            "PATH_REFUSED",
            "the commit would contain a Switchboard skill file (SKILL_PATH_IN_COMMIT); nothing was committed",
            [],
            undefined,
            "SKILL_PATH_IN_COMMIT",
          );
        }
      }
      if (tree === parentTree && (plan?.groups.length ?? 0) === 0) {
        throw new CommitError("NOTHING_TO_COMMIT", "nothing to commit");
      }
      filesChanged = await changedCount(cwd, parentTree, tree);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    await this.options.testHooks?.afterStep?.("tree_written");

    // T11.4: the draft request is built lazily, only when the commit-message task actually asks for a draft.
    const sanitized = await messageFor(async () => ({
      numstat: (await git(["diff-tree", "-r", "--numstat", "--no-renames", parentTree, tree], { cwd })).stdout.toString(
        "utf8",
      ),
      diff: (
        await git(
          ["diff-tree", "-r", "-p", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", parentTree, tree],
          {
            cwd,
          },
        )
      ).stdout.toString("utf8"),
      recentSubjects: await recentSubjects(cwd, parent),
      sanitise: (text) => this.trySanitize(input, text)?.message ?? null,
    }));
    const when = Math.floor(this.now().getTime() / 1000);
    const identity = input.identity;
    const identityEnv = {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_AUTHOR_DATE: `${when} +0000`,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
      GIT_COMMITTER_DATE: `${when} +0000`,
    };
    // ADR-0080 item 4: the submodule commits (same identity, dates, message and signing), then their gitlinks.
    let made: readonly MadeSubmoduleCommit[] = [];
    if (record !== undefined && parents !== undefined && plan !== undefined && plan.groups.length > 0) {
      const created = await createSubmoduleCommits(plan, {
        message: `${sanitized.message}\n`,
        identityEnv,
        ...(input.sign !== undefined
          ? {
              sign: {
                sourceEnv: this.options.signingEnv ?? process.env,
                timeoutMs: this.options.signTimeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS,
                scratchDir: this.options.scratchDir,
              },
            }
          : {}),
      });
      if (!created.ok) this.signingFailed(ctx, input, created.reason);
      made = created.commits;
      tree = await this.withGitlinks(cwd, tree, gitlinkIndexInfo(record, parents, made));
      filesChanged = await changedCount(cwd, parentTree, tree);
    }
    let sha: string;
    if (input.sign !== undefined) {
      // T9.10: the same tree, parent, identity, dates and message; only the signature header is added, by Git.
      const signed = await signedCommitTree({
        cwd,
        tree,
        parent,
        ...(mergeParent !== undefined ? { extraParents: [mergeParent] } : {}),
        message: `${sanitized.message}\n`,
        identityEnv,
        sourceEnv: this.options.signingEnv ?? process.env,
        timeoutMs: this.options.signTimeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS,
        scratchDir: this.options.scratchDir,
      });
      if (!signed.ok) this.signingFailed(ctx, input, signed.reason);
      sha = signed.sha;
    } else {
      sha = (
        await git(
          ["commit-tree", tree, "-p", parent, ...(mergeParent !== undefined ? ["-p", mergeParent] : []), "-F", "-"],
          {
            cwd,
            input: `${sanitized.message}\n`,
            env: identityEnv,
          },
        )
      ).stdout
        .toString("utf8")
        .trim();
    }
    await this.options.testHooks?.afterStep?.("commit_created");

    // Defence in depth: the new commit must add exactly itself on top of the base and the old head, so no checkpoint
    // or other run-branch commit can be reachable from the publish ref (FR-GIT-08). T15.7: the merge parent is the
    // controller-resolved base, so its history is excluded too; still exactly one new commit.
    const excluded = [ctx.baseCommit, ...(old ? [old] : []), ...(mergeParent !== undefined ? [mergeParent] : [])];
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
      ...(input.sign !== undefined ? { signed: true as const } : {}),
      ...(input.origin === "finalize_only"
        ? {
            via: "finalize" as const,
            ...(input.finalizingEventId !== undefined ? { finalizing_event_id: input.finalizingEventId } : {}),
          }
        : {}),
      ...(mergeParent !== undefined ? { merge_parent_sha: mergeParent } : {}),
      ...(made.length > 0
        ? {
            submodules: made.map((m) => ({
              repo: m.key,
              paths: m.paths,
              parent_sha: m.parentSha,
              commit_sha: m.commitSha,
            })),
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
        ...(sanitized.source === "inner"
          ? { messageSource: "inner" as const, innerCallId: sanitized.innerCallId }
          : {}),
      },
    };
    this.ledger.appendRunEvent({ runId: ctx.runId, type: "git_commit_intent", payload: intent });
    this.inFlight.add(sha);
    try {
      await this.options.testHooks?.afterStep?.("intent_recorded");

      // ADR-0080 item 4: each store's publish ref keeps its new commit (compare-and-swap) before the umbrella moves.
      if (made.length > 0) {
        const moved = await updateStoreRefs(made, publishRef).catch((err: unknown) => {
          this.ledger.appendRunEvent({
            runId: ctx.runId,
            type: "git_commit_aborted",
            payload: { commit_sha: sha, reason: "submodule_ref_update_failed" },
          });
          throw err;
        });
        if (moved.length > 0) {
          this.ledger.appendRunEvent({
            runId: ctx.runId,
            type: "git_commit_aborted",
            payload: { commit_sha: sha, reason: "submodule_ref_moved" },
          });
          return "lost-race";
        }
      }

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
      await this.warnSecrets(ctx, parent, sha, publishRef);
      if (made.length > 0) {
        // Best effort: an unchanged duplicate that cannot be moved keeps its worktree (its gitlink is already bumped).
        await moveDuplicates(cwd, made);
        for (const m of made) await this.warnSecrets(ctx, m.parentSha, m.commitSha, publishRef, m.store, m.paths[0]);
      }
      return {
        sha,
        treeSha: tree,
        parentSha: parent,
        publishRef,
        filesChanged,
        patchId,
        sanitizer: sanitized.report,
        provenanceId: row.id,
        messageSource: sanitized.source,
        ...(mergeParent !== undefined ? { mergeParentSha: mergeParent } : {}),
        ...(record !== undefined
          ? {
              submodules: made.map((m) => ({
                paths: m.paths,
                repo: m.key,
                commitSha: m.commitSha,
                parentSha: m.parentSha,
              })),
              submodulesSkipped: mergeSkips(routedSkips, plan?.skipped ?? []),
            }
          : {}),
      };
    } finally {
      this.inFlight.delete(sha);
    }
  }

  /**
   * T15.7: the second parent of this commit, or undefined. Only a `prepared` `run_rebase` row of the run with a full
   * SHA that names a commit in the repository and is not yet an ancestor of `parent` (so only the run's first commit,
   * and every retry of it, carries it). Any other row leaves the commit single parent.
   */
  private async mergeParentFor(ctx: RunContext, parent: string): Promise<string | undefined> {
    const row = this.options.db
      .prepare("SELECT merge_parent_sha FROM run_rebase WHERE run_id = ? AND state = 'prepared'")
      .get(ctx.runId) as { merge_parent_sha: string | null } | undefined;
    const candidate = row?.merge_parent_sha;
    if (typeof candidate !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(candidate)) return undefined;
    if ((await resolveCommit(ctx.repoRoot, candidate)) !== candidate) return undefined;
    const r = await git(["merge-base", "--is-ancestor", candidate, parent], { cwd: ctx.repoRoot, okCodes: [1] });
    return r.code === 1 ? candidate : undefined;
  }

  /**
   * T9.14 (LLD §20.9): the commit-time warning. Scans the added lines of `parent..sha` and appends one
   * `secret_scan_hit` event per hit (at most {@link MAX_SECRET_SCAN_HIT_EVENTS}). Never throws: the commit is already
   * published and recorded, and a warning must not change its outcome.
   */
  private async warnSecrets(
    ctx: RunContext,
    parent: string,
    sha: string,
    publishRef: string,
    /** ADR-0080 item 4: a submodule commit is scanned in its store; hit paths get the submodule path as prefix. */
    repo: string = ctx.worktreePath,
    pathPrefix?: string,
  ): Promise<void> {
    try {
      const report = await scanOutgoingDiff(repo, parent, sha, this.secretScanAllow);
      for (const hit of report.hits.slice(0, MAX_SECRET_SCAN_HIT_EVENTS)) {
        this.ledger.appendRunEvent({
          runId: ctx.runId,
          type: SECRET_SCAN_HIT_EVENT,
          payload: {
            stage: "commit",
            rule_id: hit.rule_id,
            path: pathPrefix !== undefined ? `${pathPrefix}/${hit.path}` : hit.path,
            line: hit.line,
            ref: publishRef,
            commit_sha: sha,
          },
        });
      }
    } catch {
      // Warn only (ADR-0061 point 4): a failed scan records nothing and leaves the commit as it is.
    }
  }

  /**
   * ADR-0080 item 4: plan the submodule commits; two paths of one repository changed differently refuse the commit
   * (`PATH_REFUSED`, `submodule_duplicate_diverged` per path).
   */
  private async planSubmodules(
    ctx: RunContext,
    record: AttachRecord,
    parents: SubmoduleParents,
    opts: {
      all: boolean;
      explicit: ReadonlyMap<string, readonly string[] | "all">;
      skillPaths: readonly string[];
      publishRef: string;
    },
  ): Promise<SubmodulePlan> {
    try {
      return await planSubmoduleCommits({
        db: this.options.db,
        metaSessionId: ctx.metaSessionId,
        record,
        runWorktree: ctx.worktreePath,
        parents,
        scope: { all: opts.all, explicit: opts.explicit },
        skillPaths: opts.skillPaths,
        scratchDir: this.options.scratchDir,
        publishRef: opts.publishRef,
      });
    } catch (err) {
      if (!(err instanceof SubmoduleDivergedError)) throw err;
      const refused = err.paths.map((p) => ({ path: p, reason: "submodule_duplicate_diverged" as const }));
      throw new CommitError(
        "PATH_REFUSED",
        `${refused.length} path(s) refused: ${refused.map((r) => `${JSON.stringify(r.path)} (${r.reason})`).join(", ")}`,
        refused,
      );
    }
  }

  /** ADR-0080 item 4: `tree` with the gitlink entries of `indexInfo` (a fresh temporary index; returns the new tree). */
  private async withGitlinks(cwd: string, tree: string, indexInfo: string): Promise<string> {
    const tmp = await mkdtemp(path.join(this.options.scratchDir, "idx-"));
    try {
      const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
      await git(["read-tree", tree], { cwd, env });
      await git(["update-index", "--index-info"], { cwd, env, input: indexInfo });
      return await gitText(["write-tree"], { cwd, env });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * The outcome step: `git_commit` event and row in one transaction (idempotent per run and commit), with the
   * `submodule_commit` rows of the intent (ADR-0080 item 4) in the same transaction.
   */
  private recordOutcome(intent: IntentRecord, recovered: boolean): GitCommitRow {
    return this.options.db.transaction(() => {
      const res = this.recordGitCommitRow(intent, recovered);
      if (res.created) {
        for (const s of intent.submodules ?? []) {
          insertSubmoduleCommit(
            this.options.db,
            {
              runId: intent.record.runId,
              metaSessionId: intent.record.metaSessionId,
              repo: s.repo,
              paths: s.paths,
              parentSha: s.parent_sha,
              commitSha: s.commit_sha,
              umbrellaCommitSha: intent.commit_sha,
            },
            { ids: this.ids, now: this.now },
          );
        }
      }
      return res.row;
    })();
  }

  private recordGitCommitRow(intent: IntentRecord, recovered: boolean): { row: GitCommitRow; created: boolean } {
    const r = intent.record;
    const { messageSource, innerCallId, ...rest } = r;
    return this.ledger.recordGitCommit({
      ...rest,
      ...(messageSource === "inner" ? { messageSource, innerCallId: innerCallId ?? null } : {}),
      eventPayload: {
        commit_sha: r.commitSha,
        tree_sha: r.treeSha,
        parent_sha: intent.parent_sha,
        // T15.7: present only for a rebase run's two-parent commit, so every other event is unchanged.
        ...(intent.merge_parent_sha !== undefined ? { merge_parent_sha: intent.merge_parent_sha } : {}),
        publish_ref: r.publishRef,
        files_changed: intent.files_changed,
        origin: r.origin,
        ...(intent.signed === true ? { signed: true } : {}),
        ...(intent.via !== undefined ? { via: intent.via } : {}),
        ...(intent.finalizing_event_id !== undefined ? { finalizing_event_id: intent.finalizing_event_id } : {}),
        sanitizer: r.sanitizer,
        // T11.4 (LLD §12.7): present only for a drafted message, so an agent commit's event is unchanged.
        ...(messageSource === "inner" ? { message_source: "inner", inner_call_id: innerCallId ?? null } : {}),
        // ADR-0080 item 4: present only with submodule commits, so every other event is unchanged.
        ...(intent.submodules !== undefined
          ? { submodules: intent.submodules.map((s) => ({ repo: s.repo, paths: s.paths, commit_sha: s.commit_sha })) }
          : {}),
        ...(recovered ? { recovered: true } : {}),
      },
    });
  }

  /**
   * T9.10 checks before anything is built: the BR-31 verdict the caller evaluated (`evaluateSigningReach`) and the
   * repository's own signing configuration (refused, `src/git/sign.ts`). Either refusal is `SIGNING_FAILED`.
   */
  private async checkSigning(ctx: RunContext, input: CommitInput): Promise<void> {
    const reach = input.sign?.reach;
    if (reach === undefined || !reach.ok) {
      this.signingFailed(ctx, input, "credential_reach", reach && !reach.ok ? reach.reason : "not_evaluated");
    }
    if (await repoSigningConfigUnsafe(ctx.worktreePath)) this.signingFailed(ctx, input, "repo_config_unsafe");
  }

  /** Record the refusal (reason codes only, never Git's or the signing program's output) and throw `SIGNING_FAILED`. */
  private signingFailed(
    ctx: RunContext,
    input: CommitInput,
    reason: SigningRefusalReason,
    reachReason?: string,
  ): never {
    this.ledger.appendRunEvent({
      runId: ctx.runId,
      type: GIT_COMMIT_SIGNING_FAILED_EVENT,
      payload: {
        origin: input.origin ?? "commit_tool",
        reason,
        ...(reachReason !== undefined ? { credential_reach: reachReason } : {}),
      },
    });
    throw new CommitError("SIGNING_FAILED", `the commit could not be signed (${reason}); nothing was committed`);
  }

  /**
   * Per-path checks before anything is staged (LLD §12.3 step 1). Returns the normalised accepted umbrella paths and
   * (ADR-0080 item 4) the paths routed into attached submodules, or throws with a report for every refused path.
   * Nothing is partially committed.
   */
  private async classifyPaths(
    ctx: RunContext,
    parentTree: string,
    requested: readonly string[],
    sub: { record: AttachRecord; parents: SubmoduleParents; finalizeAll: boolean } | undefined,
  ): Promise<ClassifiedPaths> {
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
    const routed = new Map<string, { entry: AttachRecord["entries"][number]; subs: string[] }>();
    for (const rel of candidates) {
      if (await hasSymlinkAncestor(cwd, rel)) {
        refused.push({ path: rel, reason: "symlink_in_path" });
        continue;
      }
      // ADR-0080 item 4: a path in an attached submodule is committed in that submodule only.
      const hit = sub !== undefined ? routeSubmodulePath(sub.record, rel) : undefined;
      if (hit !== undefined) {
        const r = routed.get(hit.entry.path) ?? { entry: hit.entry, subs: [] };
        r.subs.push(hit.sub);
        routed.set(hit.entry.path, r);
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
      live.push({ rel, exists: await exists(path.join(cwd, rel)) });
    }
    refused.push(...(await livePathRefusals(cwd, parentTree, live)));

    const submodules = new Map<string, readonly string[] | "all">();
    const skipped: SubmoduleSkip[] = [];
    for (const [subPath, { entry, subs }] of routed) {
      const subCwd = entry.writable ? await submoduleCwd(cwd, entry) : undefined;
      const parent = sub?.parents.byKey.get(entry.key);
      const why: SubmoduleSkip["reason"] | undefined = !entry.writable
        ? "read_only"
        : subCwd === undefined
          ? "link_invalid"
          : parent === undefined
            ? "commit_missing"
            : undefined;
      if (why !== undefined || subCwd === undefined || parent === undefined) {
        // The finalize-only commit takes every writable submodule anyway; it reports instead of refusing.
        if (sub?.finalizeAll === true) skipped.push({ path: subPath, reason: why ?? "link_invalid" });
        else {
          const reason: PathRefusalReason =
            why === "read_only"
              ? "submodule_read_only"
              : why === "commit_missing"
                ? "missing"
                : "submodule_link_invalid";
          for (const s of subs) refused.push({ path: s === "" ? subPath : `${subPath}/${s}`, reason });
        }
        continue;
      }
      if (subs.includes("")) {
        submodules.set(subPath, "all");
        continue;
      }
      const subNested = await findNestedRepositories(subCwd);
      const subLive: { rel: string; exists: boolean }[] = [];
      for (const s of subs) {
        if (subNested.paths.some((n) => s === n || s.startsWith(`${n}/`))) {
          refused.push({ path: `${subPath}/${s}`, reason: "nested_repository" });
        } else if (subNested.paths.some((n) => n.startsWith(`${s}/`))) {
          refused.push({ path: `${subPath}/${s}`, reason: "contains_nested_repository" });
        } else subLive.push({ rel: s, exists: await exists(path.join(subCwd, s)) });
      }
      const subRefused = await livePathRefusals(subCwd, parent.tree, subLive);
      for (const r of subRefused) refused.push({ path: `${subPath}/${r.path}`, reason: r.reason });
      const accepted = subLive.map((l) => l.rel).filter((s) => !subRefused.some((r) => r.path === s));
      if (accepted.length > 0) submodules.set(subPath, accepted);
    }

    if (refused.length > 0) {
      const outside = refused.some((r) => r.reason === "outside_worktree" || r.reason === "symlink_in_path");
      throw new CommitError(
        outside ? "PATH_OUTSIDE_WORKTREE" : "PATH_REFUSED",
        `${refused.length} path(s) refused: ${refused.map((r) => `${JSON.stringify(r.path)} (${r.reason})`).join(", ")}`,
        refused,
      );
    }
    return { umbrella: live.map((l) => l.rel), submodules, skipped };
  }
}

interface ClassifiedPaths {
  /** Accepted umbrella paths. */
  readonly umbrella: readonly string[];
  /** ADR-0080 item 4: attached path → accepted submodule-relative paths, or `"all"` when its root was named. */
  readonly submodules: ReadonlyMap<string, readonly string[] | "all">;
  /** ADR-0080 item 4 (finalize-only): named submodules that are not committed. */
  readonly skipped: readonly SubmoduleSkip[];
}

/**
 * The tracked, missing and ignored checks of LLD §12.3 step 1 for paths below `cwd` (the umbrella worktree or, ADR-0080
 * item 4, a verified submodule worktree) against `parentTree`. Returns one refusal per refused path (relative to `cwd`).
 */
async function livePathRefusals(
  cwd: string,
  parentTree: string,
  live: readonly { rel: string; exists: boolean }[],
): Promise<PathRefusal[]> {
  const refused: PathRefusal[] = [];
  if (live.length === 0) return refused;
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
  return refused;
}

async function exists(p: string): Promise<boolean> {
  return lstat(p).then(
    () => true,
    () => false,
  );
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
  if (input.messageTask !== undefined) {
    // T11.4: the task is offered only to the agent's own `commit` tool, never to the finalize-only path.
    if ((input.origin ?? "commit_tool") !== "commit_tool") {
      throw new CommitError("INVALID_REQUEST", "a commit-message task is accepted only for the commit tool");
    }
    if (input.message !== undefined && (typeof input.message !== "string" || input.message.trim() === "")) {
      throw new CommitError("INVALID_REQUEST", "message must be omitted or a non-empty string");
    }
  } else if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new CommitError("INVALID_REQUEST", "message must be a non-empty string");
  }
  if (input.paths !== undefined) {
    // ADR-0080 item 4: the finalize-only commit of submodule changes alone names no umbrella path.
    const submodulesOnly = input.allSubmodules === true && input.origin === "finalize_only";
    if (!Array.isArray(input.paths) || (input.paths.length === 0 && !submodulesOnly)) {
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

/**
 * T11.4: up to {@link MAX_RECENT_SUBJECTS} subject lines reachable from `head` (the publish ref, else the base commit),
 * as a style hint. Best effort: an empty list on any failure. `--no-show-signature` keeps a repository's
 * `log.showSignature` from adding signature output.
 */
async function recentSubjects(cwd: string, head: string): Promise<string[]> {
  try {
    const out = await git(
      ["log", "--no-show-signature", "--no-color", `--max-count=${MAX_RECENT_SUBJECTS}`, "--format=%s", head, "--"],
      { cwd },
    );
    return out.stdout
      .toString("utf8")
      .split("\n")
      .map((l) => l.trim().slice(0, MAX_SUBJECT_HINT_CHARS))
      .filter((l) => l !== "");
  } catch {
    return [];
  }
}

/** Number of paths that differ between two trees (a gitlink counts as one). */
async function changedCount(cwd: string, fromTree: string, toTree: string): Promise<number> {
  const names = await git(["diff-tree", "-r", "--name-only", "-z", "--no-renames", fromTree, toTree], { cwd });
  return names.stdout
    .toString("utf8")
    .split("\0")
    .filter((n) => n !== "").length;
}

/** ADR-0080 item 4: one skip per path (the first reason wins), sorted by path. */
function mergeSkips(...lists: readonly (readonly SubmoduleSkip[])[]): SubmoduleSkip[] {
  const byPath = new Map<string, SubmoduleSkip>();
  for (const list of lists) for (const s of list) if (!byPath.has(s.path)) byPath.set(s.path, s);
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
