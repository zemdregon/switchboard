/**
 * The opt-in, head-pinned merge policy and ref events (T15.8; FR-SUB-02, FR-SUB-01 first delivery, FR-EXE-10, LLD
 * §20.7, ADR-0060, ADR-0050 amendment 1 item 10). Linus decision, Delegated, not owner-approved, where LLD §20.7 left a
 * choice open; each is recorded there.
 *
 * {@link pollMergePolicies} runs on the CI poller's tick (so `ci_trigger.enabled` is the switch for every `gh` call and
 * `poll_interval_seconds` its pace) over every project whose merge policy is in force and on (`targets`: configured
 * projects and dynamic projects' revisions in force; a revision that turns it on waits for operator approval,
 * FR-PRJ-10), skipping a paused project. For each published ref that is not superseded (T15.7), the gate is read by the
 * controller from `gh` JSON only, never from event or agent text, in this order; the first failing step is the
 * refusal reason:
 *
 * 1. G10 `gh pr view` of the published branch: no pull request → nothing; not `OPEN` → a `merged` or `closed` ref
 *    event, no merge decision; a draft → `draft`; a head other than the tip Switchboard published → `head_moved`; a
 *    base other than the primary context's base branch → `base_mismatch`; not `MERGEABLE` → `not_mergeable`.
 * 2. Ledger: the newest `verification_result` of the project at that head SHA (FR-EXE-10, migration 0027) is `passed`,
 *    else `unverified_at_head`; each `required_reports` entry's newest valid report at that SHA says `aligned`, else
 *    `report_missing`.
 * 3. G11 `gh pr checks --required`: none → `no_required_checks` (fail closed); any `fail`, `cancel` or `skipping` →
 *    `check_failed`; any `pending` → `check_pending`. Non-required checks are never read.
 *    ADR-0087 item 7: with `merge_policy.checks: all_reported` the read is G18 (every reported check, required or not):
 *    none reported → `no_checks_reported`; the same `check_failed` and `check_pending` classification.
 * 4. The policy is looked up again (`policy_off` when it was turned off meanwhile), G10 is read again (step 1's checks
 *    again), then G12 `gh pr merge <n> --<method> --match-head-commit <sha>`, so a head that moves after the read
 *    refuses on GitHub's side too.
 *
 * ADR-0070: the per-ref gate is {@link applyMergeGate}, shared with MCP `merge_run_pr` ({@link mergeOnRequest}), and
 * `merge_policy.require_verification: false` skips step 2's `verification_result` condition only.
 *
 * ADR-0073 (LLD §20.7.1): step 1's head check also accepts a pull request head that is a chain of pure base merges on
 * the published tip (GitHub's "Update branch", MCP `update_run_branch`), verified by the controller with local Git
 * ({@link PullHeadPort}, `base-merge.ts`); G12 is then pinned to that head. Step 2's conditions stay keyed to the
 * published tip (a pure base merge adds base content only); step 3's required checks are read at the pull request's
 * actual head as before. The accepted head and how it was accepted (`head_kind`) are recorded on the `merge_event` row.
 *
 * ADR-0087 item 7: a ref with linked submodule pull requests takes the ordered merge ({@link LinkedMergeHook},
 * `submodule-merge.ts`) on both paths instead; without the hook such a ref is never merged (fail closed). Every other
 * ref is decided exactly as above.
 *
 * Every decision is a `merge_event` row (migration 0031): `attempted` before G12 runs (at most one attempt per head SHA:
 * a G12 failure is recorded `gh_error` and is not retried until the head moves), `merged`, or `refused` with a reason,
 * once per `(ref, head, reason)`. A read failure is a `gh_error` refusal and is retried on the next poll. Each newly
 * written `merged` or `refused` row, and each new `ref_event` row, is also a `run_event` on the run that published the
 * ref (so `get_digest` delivers it to the publishing client only) and a closed sink event (ADR-0048).
 */
import type Database from "better-sqlite3";
import { type ProjectMergePolicy, primaryContext, type ResolvedProject } from "../config/projects.js";
import { isAdmissionPaused } from "../control/pause.js";
import { defaultIds } from "../ids/index.js";
import type { Ledger } from "../ledger/index.js";
import { DOCS_ALIGNMENT_EVENT } from "../lifecycle/docs-alignment.js";
import { type DynamicProjectStore, toResolved } from "../projects/index.js";
import { listSubmodulePullRequestsForUmbrellaRef } from "../submodules/ledger.js";
import type { HeadKind, PullHeadPort } from "./base-merge.js";
import { branchOfPublishRef, isSafeBranch } from "./gh-argv.js";
import {
  MERGE_EVENT_TYPE,
  type MergeRefusalReason,
  REF_EVENT_TYPE,
  type RefEventKind,
  type SubmoduleMergePhase,
  type SubmoduleMergeRefusalReason,
  type SubmoduleMergeRepoState,
} from "./merge-codes.js";
import type { CiMergePort, CiPullRequestGateView, CiPullRequestState } from "./port.js";
import { listPublishedRefs, type PublishedRef } from "./published-refs.js";

/** A project the merge pass looks at: its policy in force and its primary context's base ref. */
export interface MergeTarget {
  readonly projectId: string;
  readonly policy: ProjectMergePolicy;
  /** The primary context's `base_ref`. */
  readonly baseRef: string;
}

/**
 * The projects whose merge policy is on in the definition in force: configured projects, then dynamic projects'
 * revisions in force (FR-PRJ-10: a revision that turns the policy on is not in force until the operator approves it,
 * so it never reaches this list before then). A deleted dynamic project is skipped.
 */
export function mergeTargetsFrom(
  projects: readonly ResolvedProject[],
  store: Pick<DynamicProjectStore, "list">,
): MergeTarget[] {
  const out: MergeTarget[] = [];
  for (const p of projects) {
    if (p.mergePolicy?.enabled === true)
      out.push({ projectId: p.id, policy: p.mergePolicy, baseRef: primaryContext(p).baseRef });
  }
  for (const st of store.list()) {
    const def = st.inForce?.definition;
    if (st.deleted || def?.merge_policy?.enabled !== true || out.some((t) => t.projectId === st.projectId)) continue;
    const resolved = toResolved(def);
    if (resolved.mergePolicy !== undefined) {
      out.push({ projectId: resolved.id, policy: resolved.mergePolicy, baseRef: primaryContext(resolved).baseRef });
    }
  }
  return out;
}

/** A closed event for the sinks (ADR-0048): ids and codes only. */
export interface RefSinkEvent {
  readonly projectId: string;
  readonly eventKind: "ref_event" | "merge_event";
  readonly reasonCode: string;
  readonly runId: string | null;
}

export type OnRefSinkEvent = (e: RefSinkEvent) => void;

/** ADR-0087 item 7: one linked repository of the ordered merge (`details.submodule_merge.repos[]`). */
export interface SubmoduleMergeRepoView {
  /** `owner/repo` as `gh` takes it. */
  readonly repo: string;
  /** Umbrella-relative paths whose gitlinks reference the repository, in path order. */
  readonly paths: readonly string[];
  readonly pr_number: number;
  readonly state: SubmoduleMergeRepoState;
  readonly merged_sha?: string;
  readonly reason?: string;
}

/** ADR-0087 item 7: the ordered merge's progress, recomputed from the ledger on every call. */
export interface SubmoduleMergeView {
  readonly phase: SubmoduleMergePhase;
  readonly repos: readonly SubmoduleMergeRepoView[];
}

/** ADR-0087 item 7: what the ordered merge decided for one umbrella publish ref with linked pull requests. */
export type LinkedMergeOutcome = {
  refEvents: { kind: RefEventKind; headSha: string }[];
  submoduleMerge: SubmoduleMergeView;
} & (
  | { kind: "merged"; prNumber: number; alreadyMerged: boolean; headSha: string; headKind: HeadKind }
  | {
      kind: "refused";
      reason: MergeRefusalReason | SubmoduleMergeRefusalReason;
      prNumber: number | null;
      recorded: boolean;
    }
  | { kind: "skipped" }
);

/**
 * ADR-0087 item 7: the ordered merge of an umbrella publish ref, or undefined when the ref has no linked submodule pull
 * request (then the T15.8 gate runs exactly as before). `requestedBy` is the `git_push` requester of the repoint push.
 */
export type LinkedMergeHook = (
  target: MergeTarget,
  ref: PublishedRef,
  gh: { owner: string; repo: string },
  opts: { mode: "poll" | "request"; expectedHeadSha?: string; requestedBy?: `mcp_client:${string}` },
) => Promise<LinkedMergeOutcome | undefined>;

export interface MergePolicyDeps {
  readonly db: Database.Database;
  readonly ledger: Ledger;
  readonly merge: CiMergePort;
  /** Projects with a merge policy in force; read at the start and again just before each merge. */
  readonly targets: () => readonly MergeTarget[];
  readonly resolveRemote: (projectId: string, remote: string) => Promise<{ owner: string; repo: string } | undefined>;
  /**
   * ADR-0073: the controller's Git read of a pull request's head and base. Without it, only the published tip itself
   * is an acceptable head (every other head is `head_moved`).
   */
  readonly pullHeads?: PullHeadPort;
  readonly nowMs?: () => number;
  /** Best effort; must not throw (a throw is swallowed). */
  readonly onEvent?: OnRefSinkEvent;
  /** ADR-0087 item 7: the ordered merge (`src/ci/submodule-merge.ts`); absent, every ref takes the T15.8 gate. */
  readonly linkedMerge?: LinkedMergeHook;
}

export interface MergePolicyPollResult {
  /** `headSha` is the pull request head G12 was pinned to; `headKind` how the gate accepted it (ADR-0073). */
  merged: { projectId: string; publishRef: string; prNumber: number; headSha: string; headKind: HeadKind }[];
  refused: {
    projectId: string;
    publishRef: string;
    headSha: string;
    reason: MergeRefusalReason | SubmoduleMergeRefusalReason;
    recorded: boolean;
  }[];
  refEvents: { projectId: string; publishRef: string; kind: RefEventKind; headSha: string }[];
  /** Refs whose remote is not a github.com remote. */
  unresolved: { projectId: string; publishRef: string }[];
}

/**
 * The base branch name a context's `base_ref` names, for comparison with the pull request's base: `refs/heads/<b>`,
 * `refs/remotes/<remote>/<b>` or `<remote>/<b>` for the published ref's remote, else the value itself. Undefined when
 * that is not a safe branch name. Delegated (T15.8): a `base_ref` that names a commit never equals a branch, so the merge
 * is refused (`base_mismatch`).
 */
export function baseBranchOf(baseRef: string, remote: string): string | undefined {
  let b = baseRef;
  if (b.startsWith("refs/heads/")) b = b.slice("refs/heads/".length);
  else if (b.startsWith(`refs/remotes/${remote}/`)) b = b.slice(`refs/remotes/${remote}/`.length);
  else if (b.startsWith(`${remote}/`)) b = b.slice(remote.length + 1);
  return isSafeBranch(b) ? b : undefined;
}

/** The run whose accepted push published the ref (newest), or null for an operator push. */
function publishingRun(db: Database.Database, projectId: string, ref: PublishedRef): string | null {
  const row = db
    .prepare(
      `SELECT run_id FROM git_push WHERE project_id = ? AND remote = ? AND ref = ? AND outcome = 'ACCEPTED'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(projectId, ref.remote, ref.publishRef) as { run_id: string | null } | undefined;
  return row?.run_id ?? null;
}

function emit(onEvent: OnRefSinkEvent | undefined, e: RefSinkEvent): void {
  try {
    onEvent?.(e);
  } catch {
    // Best effort (ADR-0048 item 6): delivery never changes the poll.
  }
}

/**
 * Records one ref event once per `(project, ref, kind, head)`. A new row is also a `ref_event` run event on the
 * publishing run and a sink event. Returns true when the row is new.
 */
export function recordRefEvent(
  a: { db: Database.Database; ledger: Ledger; onEvent?: OnRefSinkEvent | undefined; nowIso: string },
  e: { projectId: string; ref: PublishedRef; kind: RefEventKind; headSha: string; prNumber: number | null },
): boolean {
  const runId = publishingRun(a.db, e.projectId, e.ref);
  const inserted = a.db
    .prepare(
      `INSERT OR IGNORE INTO ref_event (id, project_id, publish_ref, kind, head_sha, pr_number, run_id, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(`rfe_${defaultIds.ulid()}`, e.projectId, e.ref.publishRef, e.kind, e.headSha, e.prNumber, runId, a.nowIso);
  if (inserted.changes === 0) return false;
  if (runId !== null) {
    a.ledger.appendRunEvent({
      runId,
      type: REF_EVENT_TYPE,
      payload: { kind: e.kind, publish_ref: e.ref.publishRef, head_sha: e.headSha, pr_number: e.prNumber },
    });
  }
  emit(a.onEvent, { projectId: e.projectId, eventKind: "ref_event", reasonCode: e.kind, runId });
  return true;
}

/**
 * The ref events one pull request read shows (FR-SUB-01): `merged` and `closed` from its state; for an open pull
 * request, `conflicting` at the published tip and `foreign_commit` when its head is a commit Switchboard never pushed
 * on that ref.
 */
export function refEventsOfPullRequest(
  db: Database.Database,
  projectId: string,
  ref: PublishedRef,
  pr: CiPullRequestState,
): { kind: RefEventKind; headSha: string }[] {
  if (pr.state === "MERGED") return [{ kind: "merged", headSha: pr.headSha }];
  if (pr.state === "CLOSED") return [{ kind: "closed", headSha: pr.headSha }];
  if (pr.headSha === ref.headSha)
    return pr.mergeable === "CONFLICTING" ? [{ kind: "conflicting", headSha: pr.headSha }] : [];
  const pushed = db
    .prepare(
      `SELECT 1 FROM git_push WHERE project_id = ? AND remote = ? AND ref = ? AND outcome = 'ACCEPTED'
         AND lower(head_sha) = ?`,
    )
    .get(projectId, ref.remote, ref.publishRef, pr.headSha);
  return pushed === undefined ? [{ kind: "foreign_commit", headSha: pr.headSha }] : [];
}

/** The newest `verification_result` of the project at `headSha` is `passed` (FR-EXE-10). */
export function verifiedAtHead(db: Database.Database, projectId: string, headSha: string): boolean {
  const row = db
    .prepare(
      `SELECT v.outcome AS outcome FROM verification_result v JOIN run r ON r.id = v.run_id
       WHERE r.project_id = ? AND v.head_sha = ?
       ORDER BY v.created_at DESC, v.id DESC LIMIT 1`,
    )
    .get(projectId, headSha) as { outcome: string } | undefined;
  return row?.outcome === "passed";
}

/**
 * The newest valid `docs_alignment` report of the project whose `head_sha` is `headSha` says `aligned` (FR-SKL-11).
 * The report's SHA is the agent's claim (LLD §20.6); the gate's controller-read facts are steps 1 to 3.
 */
export function reportAlignedAtHead(db: Database.Database, projectId: string, headSha: string): boolean {
  const rows = db
    .prepare(
      `SELECT e.payload_json AS payload FROM run_event e JOIN run r ON r.id = e.run_id
       WHERE r.project_id = ? AND e.type = ? ORDER BY e.ts DESC, e.id DESC`,
    )
    .iterate(projectId, DOCS_ALIGNMENT_EVENT) as IterableIterator<{ payload: string }>;
  for (const { payload } of rows) {
    let p: { valid?: unknown; verdict?: unknown; head_sha?: unknown };
    try {
      p = JSON.parse(payload) as typeof p;
    } catch {
      continue;
    }
    if (p.valid !== true || p.head_sha !== headSha) continue;
    return p.verdict === "aligned";
  }
  return false;
}

/**
 * Step 1's checks of one G10 read; undefined when they all hold. `acceptedHead` is the head the gate accepts: the
 * published tip, or a pure base merge chain on it (ADR-0073).
 */
function viewRefusal(
  view: CiPullRequestGateView,
  ref: PublishedRef,
  baseBranch: string | undefined,
  acceptedHead: string,
  checkMergeable = true,
) {
  if (view.isDraft) return "draft" as const;
  if (view.headSha !== acceptedHead || view.headBranch !== branchOfPublishRef(ref.publishRef))
    return "head_moved" as const;
  if (baseBranch === undefined || view.baseBranch !== baseBranch) return "base_mismatch" as const;
  if (checkMergeable && view.mergeable !== "MERGEABLE") return "not_mergeable" as const;
  return undefined;
}

/**
 * Step 2 (ledger) at `sha`: `unverified_at_head` unless `require_verification: false` (ADR-0070), then
 * `report_missing` for a required report; undefined when both hold.
 */
function ledgerRefusal(db: Database.Database, target: MergeTarget, sha: string): MergeRefusalReason | undefined {
  const { projectId, policy } = target;
  if (policy.requireVerification !== false && !verifiedAtHead(db, projectId, sha)) return "unverified_at_head";
  if (policy.requiredReports.some((r) => r === "docs-alignment" && !reportAlignedAtHead(db, projectId, sha))) {
    return "report_missing";
  }
  return undefined;
}

/** Refusals of step 1's checks ({@link viewRefusal}); never recorded with the accepted head. */
const STEP1_REASONS: ReadonlySet<MergeRefusalReason> = new Set([
  "draft",
  "head_moved",
  "base_mismatch",
  "not_mergeable",
]);

/** One merge pass over every target (LLD §20.7). Never throws for a single project or ref. */
export async function pollMergePolicies(deps: MergePolicyDeps): Promise<MergePolicyPollResult> {
  const result: MergePolicyPollResult = { merged: [], refused: [], refEvents: [], unresolved: [] };
  for (const target of deps.targets()) {
    if (!target.policy.enabled) continue;
    const { projectId } = target;
    if (isAdmissionPaused(deps.ledger, projectId)) continue;
    const remotes = new Map<string, { owner: string; repo: string } | undefined>();
    for (const ref of listPublishedRefs(deps.db, projectId)) {
      if (isSuperseded(deps.db, projectId, ref.publishRef)) continue;
      if (!remotes.has(ref.remote)) remotes.set(ref.remote, await deps.resolveRemote(projectId, ref.remote));
      const gh = remotes.get(ref.remote);
      if (gh === undefined) {
        result.unresolved.push({ projectId, publishRef: ref.publishRef });
        continue;
      }
      // ADR-0087 item 7: a ref with linked submodule pull requests takes the ordered merge instead.
      const linked = await deps.linkedMerge?.(target, ref, gh, { mode: "poll" });
      // Fail closed: without the ordered merge (no hook, or a hook that did not take the ref), an umbrella with linked
      // pull requests is never merged.
      if (linked === undefined && hasLinkedRows(deps.db, ref.publishRef)) continue;
      const out = linked ?? (await applyMergeGate(deps, target, ref, gh, { mode: "poll" }));
      for (const ev of out.refEvents) result.refEvents.push({ projectId, publishRef: ref.publishRef, ...ev });
      if (out.kind === "merged") {
        result.merged.push({
          projectId,
          publishRef: ref.publishRef,
          prNumber: out.prNumber,
          headSha: out.headSha,
          headKind: out.headKind,
        });
      } else if (out.kind === "refused") {
        result.refused.push({
          projectId,
          publishRef: ref.publishRef,
          headSha: ref.headSha,
          reason: out.reason,
          recorded: out.recorded,
        });
      }
    }
  }
  return result;
}

/**
 * What {@link applyMergeGate} decided for one published ref. A merge's `headSha` is the pull request head merged
 * (G12's `--match-head-commit`), accepted as `headKind` (ADR-0073).
 */
export type MergeGateOutcome = { refEvents: { kind: RefEventKind; headSha: string }[] } & (
  | { kind: "merged"; prNumber: number; alreadyMerged: boolean; headSha: string; headKind: HeadKind }
  | { kind: "refused"; reason: MergeRefusalReason; prNumber: number | null; recorded: boolean }
  /** `poll` mode only: no pull request, not open, or already attempted at this head; nothing to decide. */
  | { kind: "skipped" }
);

/**
 * The T15.8 gate for one published ref of one target (LLD §20.7 steps 1 to 4, then G12), shared by the poller and
 * MCP `merge_run_pr` (ADR-0070) so there is one copy of it. `mode: "poll"` is the poller's: no pull request, a pull
 * request that is not open, or an earlier attempt at this head ends the work without a decision. `mode: "request"` is
 * one explicit merge request: no pull request or a closed one is `not_mergeable`, a pull request already merged at the
 * published tip is reported merged without G12 (idempotent), a merged one at another head is `head_moved`, an earlier
 * attempt does not stop a new one (G12 is head-pinned, so a retry after `gh_error` is safe), and `expectedHeadSha`,
 * when given, must equal the published tip (`head_moved`). `policy.requireVerification === false` (ADR-0070) skips the
 * `verification_result` condition only. Never throws for a `gh` failure (it is a `gh_error` refusal).
 *
 * ADR-0073: an open pull request whose head is not the published tip, on the published branch and the base branch, is
 * read with {@link PullHeadPort}; a pure base merge chain on the published tip is accepted (`head_kind: base_merge`),
 * anything else is `head_moved`, and a failed fetch is `gh_error`. `expectedHeadSha` may then also be that head. Rows
 * written after the head was accepted carry it (`pr_head_sha`) and `head_kind`.
 *
 * ADR-0087 item 7: `verifiedSha` keys step 2 (verification and reports) to that commit instead of the published tip:
 * the ordered merge passes the pre-repoint tip, because its repoint commit (checked to change gitlinks only) is never
 * verified itself.
 */
export async function applyMergeGate(
  deps: Pick<MergePolicyDeps, "db" | "ledger" | "merge" | "targets" | "nowMs" | "onEvent" | "pullHeads">,
  target: MergeTarget,
  ref: PublishedRef,
  gh: { owner: string; repo: string },
  opts: { mode: "poll" | "request"; expectedHeadSha?: string; verifiedSha?: string },
): Promise<MergeGateOutcome> {
  const { db, ledger } = deps;
  const { projectId, policy } = target;
  const nowMs = deps.nowMs ?? Date.now;
  const refEvents: { kind: RefEventKind; headSha: string }[] = [];
  // The head the gate accepted; set once step 1's head check held.
  let accepted: { kind: HeadKind; sha: string } | undefined;
  const record = (outcome: "attempted" | "merged" | "refused", prNumber: number | null, reason?: MergeRefusalReason) =>
    recordMergeEvent(
      { db, ledger, onEvent: deps.onEvent, nowIso: new Date(nowMs()).toISOString() },
      {
        projectId,
        ref,
        prNumber,
        method: policy.method,
        outcome,
        ...(reason !== undefined ? { reason } : {}),
        // Step 1's reasons are about the pull request itself, wherever they are read: keyed without the head, so the
        // first read and the step 4 re-read share one refusal row (ADR-0073).
        ...(accepted !== undefined && (reason === undefined || !STEP1_REASONS.has(reason)) ? { head: accepted } : {}),
      },
    );
  const refuse = (reason: MergeRefusalReason, prNumber: number | null): MergeGateOutcome => ({
    kind: "refused",
    reason,
    prNumber,
    recorded: record("refused", prNumber, reason),
    refEvents,
  });
  const skipped: MergeGateOutcome = { kind: "skipped", refEvents };
  const request = opts.mode === "request";
  const readView = async (): Promise<CiPullRequestGateView | null | "error"> => {
    try {
      return await deps.merge.pullRequestGateView({ ...gh, publishRef: ref.publishRef });
    } catch {
      return "error";
    }
  };

  const view = await readView();
  if (view === "error") return refuse("gh_error", null);
  if (view === null) return request ? refuse("not_mergeable", null) : skipped;
  for (const ev of refEventsOfPullRequest(db, projectId, ref, view)) {
    const fresh = recordRefEvent(
      { db, ledger, onEvent: deps.onEvent, nowIso: new Date(nowMs()).toISOString() },
      { projectId, ref, kind: ev.kind, headSha: ev.headSha, prNumber: view.number },
    );
    if (fresh) refEvents.push(ev);
  }
  const expected = request ? opts.expectedHeadSha : undefined;
  if (expected !== undefined && expected !== ref.headSha && expected !== view.headSha) {
    return refuse("head_moved", view.number);
  }
  if (view.state !== "OPEN") {
    if (!request) return skipped;
    if (view.state === "MERGED" && view.headSha === ref.headSha) {
      return {
        kind: "merged",
        prNumber: view.number,
        alreadyMerged: true,
        headSha: view.headSha,
        headKind: "published",
        refEvents,
      };
    }
    if (view.state === "MERGED" && mergedAt(db, projectId, ref, view.headSha)) {
      // ADR-0073: this gate merged it at an accepted base merge head.
      return {
        kind: "merged",
        prNumber: view.number,
        alreadyMerged: true,
        headSha: view.headSha,
        headKind: "base_merge",
        refEvents,
      };
    }
    return refuse(view.state === "MERGED" ? "head_moved" : "not_mergeable", view.number);
  }
  if (!request && alreadyAttempted(db, projectId, ref, view.headSha)) return skipped;
  const baseBranch = baseBranchOf(target.baseRef, ref.remote);
  let acceptedSha = ref.headSha;
  if (
    !view.isDraft &&
    view.headSha !== ref.headSha &&
    deps.pullHeads !== undefined &&
    view.headBranch === branchOfPublishRef(ref.publishRef) &&
    baseBranch !== undefined &&
    view.baseBranch === baseBranch
  ) {
    const read = await deps.pullHeads.inspect({
      projectId,
      remote: ref.remote,
      prNumber: view.number,
      baseBranch,
      publishedSha: ref.headSha,
      prHeadSha: view.headSha,
    });
    if (read.kind === "error") return refuse("gh_error", view.number);
    if (read.head === "base_merge") acceptedSha = view.headSha;
  }
  const first = viewRefusal(view, ref, baseBranch, acceptedSha);
  if (first !== undefined) return refuse(first, view.number);
  if (expected !== undefined && expected !== acceptedSha) return refuse("head_moved", view.number);
  accepted = { kind: acceptedSha === ref.headSha ? "published" : "base_merge", sha: acceptedSha };
  const headKind = accepted.kind;
  // Step 2 stays keyed to the published tip: a pure base merge adds base content only (ADR-0073). ADR-0087 item 7:
  // or to the pre-repoint tip the caller names.
  const ledgerReason = ledgerRefusal(db, target, opts.verifiedSha ?? ref.headSha);
  if (ledgerReason !== undefined) return refuse(ledgerReason, view.number);
  // ADR-0087 item 7: `all_reported` reads every reported check (G18); absent or `required` is the default (G11).
  const allReported = policy.checks === "all_reported";
  if (allReported && deps.merge.reportedChecks === undefined) return refuse("gh_error", view.number);
  let checks: Awaited<ReturnType<CiMergePort["requiredChecks"]>>;
  try {
    checks = await (allReported
      ? (deps.merge.reportedChecks as NonNullable<CiMergePort["reportedChecks"]>).call(deps.merge, {
          ...gh,
          prNumber: view.number,
        })
      : deps.merge.requiredChecks({ ...gh, prNumber: view.number }));
  } catch {
    return refuse("gh_error", view.number);
  }
  if (checks.kind === "none") return refuse(allReported ? "no_checks_reported" : "no_required_checks", view.number);
  if (checks.buckets.some((b) => b !== "pass" && b !== "pending")) return refuse("check_failed", view.number);
  if (checks.buckets.includes("pending")) return refuse("check_pending", view.number);
  // Step 4: the policy and the pull request are read again right before the one write.
  const now = deps.targets().find((t) => t.projectId === projectId);
  if (
    now === undefined ||
    !now.policy.enabled ||
    now.policy.method !== policy.method ||
    // ADR-0087 item 7: the check policy changed after this pass read the checks.
    (now.policy.checks ?? "required") !== (policy.checks ?? "required") ||
    // ADR-0070: verification turned back on after this pass skipped it.
    (now.policy.requireVerification !== false && policy.requireVerification === false)
  ) {
    return refuse("policy_off", view.number);
  }
  const again = await readView();
  if (again === "error") return refuse("gh_error", view.number);
  if (again === null || again.state !== "OPEN" || again.number !== view.number)
    return refuse("head_moved", view.number);
  const second = viewRefusal(again, ref, baseBranch, acceptedSha);
  if (second !== undefined) return refuse(second, view.number);
  record("attempted", view.number);
  try {
    await deps.merge.mergePullRequest({ ...gh, prNumber: view.number, method: policy.method, headSha: acceptedSha });
  } catch {
    // A moved head, a protection rule or any other `gh` refusal: the exit code only, never `gh` text.
    return refuse("gh_error", view.number);
  }
  record("merged", view.number);
  return { kind: "merged", prNumber: view.number, alreadyMerged: false, headSha: acceptedSha, headKind, refEvents };
}

/**
 * ADR-0087 item 7 step 0: the umbrella's own conditions that do not depend on the repoint, checked before any linked
 * submodule pull request is merged (a submodule merge cannot be undone). `ref.headSha` is the published (pre-repoint)
 * tip. In order: not superseded (`head_moved`); the umbrella pull request read with G10 is open (`poll`: no pull
 * request or not open is `skipped`; `request`: no pull request or a closed one is `not_mergeable`, a merged one
 * `head_moved`), not a draft, its head the published tip on the published branch (a base merge chain is not accepted
 * here: the repoint push must fast-forward it), its base the primary context's base branch; then step 2 at that tip
 * (`unverified_at_head`, `report_missing`). Mergeability and checks are not read (the repoint commit changes the
 * head). A refusal
 * is a `merge_event` row keyed to the published tip, as the gate's; undefined when every condition holds.
 */
export async function umbrellaPreCheck(
  deps: Pick<MergePolicyDeps, "db" | "ledger" | "merge" | "nowMs" | "onEvent">,
  target: MergeTarget,
  ref: PublishedRef,
  gh: { owner: string; repo: string },
  opts: { mode: "poll" | "request" },
): Promise<MergeGateOutcome | undefined> {
  const { db, ledger } = deps;
  const refuse = (reason: MergeRefusalReason, prNumber: number | null): MergeGateOutcome => ({
    kind: "refused",
    reason,
    prNumber,
    recorded: recordMergeEvent(
      { db, ledger, onEvent: deps.onEvent, nowIso: new Date((deps.nowMs ?? Date.now)()).toISOString() },
      { projectId: target.projectId, ref, prNumber, method: target.policy.method, outcome: "refused", reason },
    ),
    refEvents: [],
  });
  const request = opts.mode === "request";
  if (isSuperseded(db, target.projectId, ref.publishRef)) return refuse("head_moved", null);
  let view: CiPullRequestGateView | null;
  try {
    view = await deps.merge.pullRequestGateView({ ...gh, publishRef: ref.publishRef });
  } catch {
    return refuse("gh_error", null);
  }
  if (view === null) return request ? refuse("not_mergeable", null) : { kind: "skipped", refEvents: [] };
  if (view.state !== "OPEN") {
    if (!request) return { kind: "skipped", refEvents: [] };
    return refuse(view.state === "MERGED" ? "head_moved" : "not_mergeable", view.number);
  }
  // The gate's order: step 1's checks of the pull request, then step 2's ledger conditions.
  const viewReason = viewRefusal(view, ref, baseBranchOf(target.baseRef, ref.remote), ref.headSha, false);
  if (viewReason !== undefined) return refuse(viewReason, view.number);
  const ledgerReason = ledgerRefusal(db, target, ref.headSha);
  if (ledgerReason !== undefined) return refuse(ledgerReason, view.number);
  return undefined;
}

/** What {@link mergeOnRequest} decided; `not_published` and `unresolved` are decided before any `gh` call. */
export type MergeRequestOutcome =
  | {
      kind: "merged";
      prNumber: number;
      /** The pull request head merged; the published tip, or a pure base merge on it (`headKind`, ADR-0073). */
      headSha: string;
      headKind: HeadKind;
      method: ProjectMergePolicy["method"];
      alreadyMerged: boolean;
      gh: { owner: string; repo: string };
      /** ADR-0087 item 7: present only for a ref with linked submodule pull requests. */
      submoduleMerge?: SubmoduleMergeView;
    }
  | {
      kind: "refused";
      reason: MergeRefusalReason | SubmoduleMergeRefusalReason;
      prNumber: number | null;
      headSha: string;
      /** ADR-0087 item 7: present only for a ref with linked submodule pull requests. */
      submoduleMerge?: SubmoduleMergeView;
    }
  /** The ref has no ACCEPTED push for the project (nothing Switchboard published). */
  | { kind: "not_published" }
  /** The ref's remote is not a github.com remote. */
  | { kind: "unresolved"; headSha: string };

/**
 * One explicit merge request for a published ref (MCP `merge_run_pr`, ADR-0070): the poller's per-project checks
 * (policy in force and on, project not paused, ref not superseded), then {@link applyMergeGate} in `request` mode. Not
 * gated by `ci_trigger.enabled` or `ci_trigger.projects`. Every refusal is a `merge_event` row like the poller's: a
 * project without the policy in force or paused is `policy_off` (method `squash` recorded when it has no policy); a
 * superseded ref (T15.7) is `head_moved`.
 */
export async function mergeOnRequest(
  deps: Omit<MergePolicyDeps, "ledger"> & { ledger: Ledger },
  req: {
    projectId: string;
    remote: string;
    publishRef: string;
    expectedHeadSha?: string;
    /** ADR-0087 item 7: the requester of a repoint push (the calling MCP client). */
    requestedBy?: `mcp_client:${string}`;
  },
): Promise<MergeRequestOutcome> {
  const { db, ledger } = deps;
  const ref = listPublishedRefs(db, req.projectId).find(
    (r) => r.remote === req.remote && r.publishRef === req.publishRef,
  );
  if (ref === undefined) return { kind: "not_published" };
  const nowIso = () => new Date((deps.nowMs ?? Date.now)()).toISOString();
  const target = deps.targets().find((t) => t.projectId === req.projectId);
  const refuse = (reason: MergeRefusalReason, method: ProjectMergePolicy["method"]): MergeRequestOutcome => {
    recordMergeEvent(
      { db, ledger, onEvent: deps.onEvent, nowIso: nowIso() },
      { projectId: req.projectId, ref, prNumber: null, method, outcome: "refused", reason },
    );
    return { kind: "refused", reason, prNumber: null, headSha: ref.headSha };
  };
  if (target === undefined || !target.policy.enabled) return refuse("policy_off", target?.policy.method ?? "squash");
  if (isAdmissionPaused(ledger, req.projectId)) return refuse("policy_off", target.policy.method);
  if (isSuperseded(db, req.projectId, ref.publishRef)) return refuse("head_moved", target.policy.method);
  const gh = await deps.resolveRemote(req.projectId, ref.remote);
  if (gh === undefined) return { kind: "unresolved", headSha: ref.headSha };
  // ADR-0087 item 7: a ref with linked submodule pull requests takes the ordered merge.
  const linked = await deps.linkedMerge?.(target, ref, gh, {
    mode: "request",
    ...(req.expectedHeadSha !== undefined ? { expectedHeadSha: req.expectedHeadSha } : {}),
    ...(req.requestedBy !== undefined ? { requestedBy: req.requestedBy } : {}),
  });
  if (linked === undefined && hasLinkedRows(db, ref.publishRef)) {
    // Fail closed: without the ordered merge, an umbrella with linked pull requests is never merged.
    return { kind: "refused", reason: "submodule_merge_unavailable", prNumber: null, headSha: ref.headSha };
  }
  if (linked !== undefined) {
    if (linked.kind === "merged") {
      return {
        kind: "merged",
        prNumber: linked.prNumber,
        headSha: linked.headSha,
        headKind: linked.headKind,
        method: target.policy.method,
        alreadyMerged: linked.alreadyMerged,
        gh,
        submoduleMerge: linked.submoduleMerge,
      };
    }
    return {
      kind: "refused",
      reason: linked.kind === "refused" ? linked.reason : "not_mergeable",
      prNumber: linked.kind === "refused" ? linked.prNumber : null,
      headSha: ref.headSha,
      submoduleMerge: linked.submoduleMerge,
    };
  }
  const out = await applyMergeGate(deps, target, ref, gh, {
    mode: "request",
    ...(req.expectedHeadSha !== undefined ? { expectedHeadSha: req.expectedHeadSha } : {}),
  });
  if (out.kind === "merged") {
    return {
      kind: "merged",
      prNumber: out.prNumber,
      headSha: out.headSha,
      headKind: out.headKind,
      method: target.policy.method,
      alreadyMerged: out.alreadyMerged,
      gh,
    };
  }
  if (out.kind === "refused")
    return { kind: "refused", reason: out.reason, prNumber: out.prNumber, headSha: ref.headSha };
  // `request` mode never skips; fail closed if it ever did.
  return { kind: "refused", reason: "not_mergeable", prNumber: null, headSha: ref.headSha };
}

/** ADR-0087 item 7: the umbrella publish ref has `submodule_pull_request` rows. */
function hasLinkedRows(db: Database.Database, publishRef: string): boolean {
  return listSubmodulePullRequestsForUmbrellaRef(db, publishRef).length > 0;
}

/** The ref was superseded by a newer published ref (T15.7). */
export function isSuperseded(db: Database.Database, projectId: string, publishRef: string): boolean {
  const row = db
    .prepare("SELECT superseded_by FROM ci_trigger_ref_state WHERE project_id = ? AND publish_ref = ?")
    .get(projectId, publishRef) as { superseded_by: string | null } | undefined;
  return row?.superseded_by != null;
}

/**
 * At most one G12 per pull request head: an `attempted` row at the published tip and that head (`pr_head_sha`, or the
 * published tip on rows before migration 0035) ends the policy's work on that head.
 */
function alreadyAttempted(db: Database.Database, projectId: string, ref: PublishedRef, prHeadSha: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM merge_event WHERE project_id = ? AND publish_ref = ? AND head_sha = ?
           AND coalesce(pr_head_sha, head_sha) = ? AND outcome = 'attempted'`,
      )
      .get(projectId, ref.publishRef, ref.headSha, prHeadSha) !== undefined
  );
}

/** ADR-0073: a `merged` row of this published tip at a base merge head `prHeadSha`. */
function mergedAt(db: Database.Database, projectId: string, ref: PublishedRef, prHeadSha: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM merge_event WHERE project_id = ? AND publish_ref = ? AND head_sha = ? AND pr_head_sha = ?
           AND head_kind = 'base_merge' AND outcome = 'merged'`,
      )
      .get(projectId, ref.publishRef, ref.headSha, prHeadSha) !== undefined
  );
}

/**
 * Writes one `merge_event` row (a refusal at most once per ref, published tip, pull request head and reason). A new
 * `merged` or `refused` row is also a `merge_event` run event on the publishing run and a sink event. Returns true when
 * a row was written. `head` (ADR-0073, migration 0035) is the pull request head the gate accepted and how; absent
 * before the head check held.
 */
export function recordMergeEvent(
  a: { db: Database.Database; ledger: Ledger; onEvent?: OnRefSinkEvent | undefined; nowIso: string },
  e: {
    projectId: string;
    ref: PublishedRef;
    prNumber: number | null;
    method: ProjectMergePolicy["method"];
    outcome: "attempted" | "merged" | "refused";
    reason?: MergeRefusalReason;
    head?: { kind: HeadKind; sha: string };
  },
): boolean {
  const runId = publishingRun(a.db, e.projectId, e.ref);
  const inserted = a.db
    .prepare(
      `INSERT OR IGNORE INTO merge_event (id, project_id, publish_ref, pr_number, head_sha, method, outcome, reason,
         run_id, created_at, head_kind, pr_head_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `mge_${defaultIds.ulid()}`,
      e.projectId,
      e.ref.publishRef,
      e.prNumber,
      e.ref.headSha,
      e.method,
      e.outcome,
      e.reason ?? null,
      runId,
      a.nowIso,
      e.head?.kind ?? null,
      e.head?.sha ?? null,
    );
  if (inserted.changes === 0) return false;
  if (e.outcome === "attempted") return true;
  if (runId !== null) {
    a.ledger.appendRunEvent({
      runId,
      type: MERGE_EVENT_TYPE,
      payload: {
        outcome: e.outcome,
        ...(e.reason !== undefined ? { reason: e.reason } : {}),
        publish_ref: e.ref.publishRef,
        head_sha: e.ref.headSha,
        pr_number: e.prNumber,
        method: e.method,
        ...(e.head !== undefined ? { head_kind: e.head.kind, pr_head_sha: e.head.sha } : {}),
      },
    });
  }
  emit(a.onEvent, {
    projectId: e.projectId,
    eventKind: "merge_event",
    reasonCode: e.outcome === "merged" ? "merged" : (e.reason as MergeRefusalReason),
    runId,
  });
  return true;
}
