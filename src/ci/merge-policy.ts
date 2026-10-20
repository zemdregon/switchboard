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
 * 4. The policy is looked up again (`policy_off` when it was turned off meanwhile), G10 is read again (step 1's checks
 *    again), then G12 `gh pr merge <n> --<method> --match-head-commit <sha>`, so a head that moves after the read
 *    refuses on GitHub's side too.
 *
 * Every decision is a `merge_event` row (migration 0030): `attempted` before G12 runs (at most one attempt per head SHA:
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
import { branchOfPublishRef, isSafeBranch } from "./gh-argv.js";
import { MERGE_EVENT_TYPE, type MergeRefusalReason, REF_EVENT_TYPE, type RefEventKind } from "./merge-codes.js";
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

export interface MergePolicyDeps {
  readonly db: Database.Database;
  readonly ledger: Ledger;
  readonly merge: CiMergePort;
  /** Projects with a merge policy in force; read at the start and again just before each merge. */
  readonly targets: () => readonly MergeTarget[];
  readonly resolveRemote: (projectId: string, remote: string) => Promise<{ owner: string; repo: string } | undefined>;
  readonly nowMs?: () => number;
  /** Best effort; must not throw (a throw is swallowed). */
  readonly onEvent?: OnRefSinkEvent;
}

export interface MergePolicyPollResult {
  merged: { projectId: string; publishRef: string; prNumber: number; headSha: string }[];
  refused: { projectId: string; publishRef: string; headSha: string; reason: MergeRefusalReason; recorded: boolean }[];
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

/** Step 1's checks of one G10 read; undefined when they all hold. */
function viewRefusal(view: CiPullRequestGateView, ref: PublishedRef, baseBranch: string | undefined) {
  if (view.isDraft) return "draft" as const;
  if (view.headSha !== ref.headSha || view.headBranch !== branchOfPublishRef(ref.publishRef))
    return "head_moved" as const;
  if (baseBranch === undefined || view.baseBranch !== baseBranch) return "base_mismatch" as const;
  if (view.mergeable !== "MERGEABLE") return "not_mergeable" as const;
  return undefined;
}

/** One merge pass over every target (LLD §20.7). Never throws for a single project or ref. */
export async function pollMergePolicies(deps: MergePolicyDeps): Promise<MergePolicyPollResult> {
  const result: MergePolicyPollResult = { merged: [], refused: [], refEvents: [], unresolved: [] };
  const { db, ledger } = deps;
  const nowMs = deps.nowMs ?? Date.now;
  const nowIso = () => new Date(nowMs()).toISOString();
  for (const target of deps.targets()) {
    if (!target.policy.enabled) continue;
    const { projectId, policy } = target;
    if (isAdmissionPaused(ledger, projectId)) continue;
    const remotes = new Map<string, { owner: string; repo: string } | undefined>();
    for (const ref of listPublishedRefs(db, projectId)) {
      if (isSuperseded(db, projectId, ref.publishRef)) continue;
      if (!remotes.has(ref.remote)) remotes.set(ref.remote, await deps.resolveRemote(projectId, ref.remote));
      const gh = remotes.get(ref.remote);
      if (gh === undefined) {
        result.unresolved.push({ projectId, publishRef: ref.publishRef });
        continue;
      }
      const record = (
        outcome: "attempted" | "merged" | "refused",
        prNumber: number | null,
        reason?: MergeRefusalReason,
      ) =>
        recordMergeEvent(
          { db, ledger, onEvent: deps.onEvent, nowIso: nowIso() },
          {
            projectId,
            ref,
            prNumber,
            method: policy.method,
            outcome,
            ...(reason !== undefined ? { reason } : {}),
          },
        );
      const refuse = (reason: MergeRefusalReason, prNumber: number | null) => {
        const recorded = record("refused", prNumber, reason);
        result.refused.push({ projectId, publishRef: ref.publishRef, headSha: ref.headSha, reason, recorded });
      };
      const readView = async (): Promise<CiPullRequestGateView | null | "error"> => {
        try {
          return await deps.merge.pullRequestGateView({ ...gh, publishRef: ref.publishRef });
        } catch {
          return "error";
        }
      };

      const view = await readView();
      if (view === "error") {
        refuse("gh_error", null);
        continue;
      }
      if (view === null) continue;
      for (const ev of refEventsOfPullRequest(db, projectId, ref, view)) {
        const fresh = recordRefEvent(
          { db, ledger, onEvent: deps.onEvent, nowIso: nowIso() },
          { projectId, ref, kind: ev.kind, headSha: ev.headSha, prNumber: view.number },
        );
        if (fresh) result.refEvents.push({ projectId, publishRef: ref.publishRef, ...ev });
      }
      if (view.state !== "OPEN") continue;
      if (alreadyAttempted(db, projectId, ref)) continue;
      const baseBranch = baseBranchOf(target.baseRef, ref.remote);
      const first = viewRefusal(view, ref, baseBranch);
      if (first !== undefined) {
        refuse(first, view.number);
        continue;
      }
      if (!verifiedAtHead(db, projectId, ref.headSha)) {
        refuse("unverified_at_head", view.number);
        continue;
      }
      if (
        policy.requiredReports.some((r) => r === "docs-alignment" && !reportAlignedAtHead(db, projectId, ref.headSha))
      ) {
        refuse("report_missing", view.number);
        continue;
      }
      let checks: Awaited<ReturnType<CiMergePort["requiredChecks"]>>;
      try {
        checks = await deps.merge.requiredChecks({ ...gh, prNumber: view.number });
      } catch {
        refuse("gh_error", view.number);
        continue;
      }
      if (checks.kind === "none") {
        refuse("no_required_checks", view.number);
        continue;
      }
      if (checks.buckets.some((b) => b !== "pass" && b !== "pending")) {
        refuse("check_failed", view.number);
        continue;
      }
      if (checks.buckets.includes("pending")) {
        refuse("check_pending", view.number);
        continue;
      }
      // Step 4: the policy and the pull request are read again right before the one write.
      const now = deps.targets().find((t) => t.projectId === projectId);
      if (now === undefined || !now.policy.enabled || now.policy.method !== policy.method) {
        refuse("policy_off", view.number);
        continue;
      }
      const again = await readView();
      if (again === "error") {
        refuse("gh_error", view.number);
        continue;
      }
      if (again === null || again.state !== "OPEN" || again.number !== view.number) {
        refuse("head_moved", view.number);
        continue;
      }
      const second = viewRefusal(again, ref, baseBranch);
      if (second !== undefined) {
        refuse(second, view.number);
        continue;
      }
      record("attempted", view.number);
      try {
        await deps.merge.mergePullRequest({
          ...gh,
          prNumber: view.number,
          method: policy.method,
          headSha: ref.headSha,
        });
      } catch {
        // A moved head, a protection rule or any other `gh` refusal: the exit code only, never `gh` text.
        refuse("gh_error", view.number);
        continue;
      }
      record("merged", view.number);
      result.merged.push({ projectId, publishRef: ref.publishRef, prNumber: view.number, headSha: ref.headSha });
    }
  }
  return result;
}

function isSuperseded(db: Database.Database, projectId: string, publishRef: string): boolean {
  const row = db
    .prepare("SELECT superseded_by FROM ci_trigger_ref_state WHERE project_id = ? AND publish_ref = ?")
    .get(projectId, publishRef) as { superseded_by: string | null } | undefined;
  return row?.superseded_by != null;
}

/** At most one G12 per head SHA: an `attempted` row at the published tip ends the policy's work on that head. */
function alreadyAttempted(db: Database.Database, projectId: string, ref: PublishedRef): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM merge_event WHERE project_id = ? AND publish_ref = ? AND head_sha = ? AND outcome = 'attempted'`,
      )
      .get(projectId, ref.publishRef, ref.headSha) !== undefined
  );
}

/**
 * Writes one `merge_event` row (a refusal at most once per ref, head and reason). A new `merged` or `refused` row is
 * also a `merge_event` run event on the publishing run and a sink event. Returns true when a row was written.
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
  },
): boolean {
  const runId = publishingRun(a.db, e.projectId, e.ref);
  const inserted = a.db
    .prepare(
      `INSERT OR IGNORE INTO merge_event (id, project_id, publish_ref, pr_number, head_sha, method, outcome, reason,
         run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
