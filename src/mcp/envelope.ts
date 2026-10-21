/**
 * Compact run envelope (LLD §3 `envelope`, FR-MCP-04, BR-21), built only from controller-owned ledger fields. It never
 * carries raw provider output, worktree paths, branch names, pids or credential material; provider stdout/stderr
 * artifacts are operator-CLI only and are left out of `artifacts`.
 *
 * Proposed (Delegated): `failure_detail` (redacted, bounded) so an asynchronous failure such as AUTH_REQUIRED still
 * names the native login command (FR-AUTH-02); route reasons are short strings derived from `route_decision`; `usage.reported`
 * lists stored provider-reported observations, each labelled with its source (T2.5), and is null when none exist
 * (never zero); `estimated` and `capacity_confidence` stay null until the M6 estimator (FR-CAP-01..03).
 *
 * T3.3 (LLD §3.1 "What is shown where"): a `privileged` run carries `approval: { status, requested_at }` of the approval
 * named by its policy snapshot, and nothing else of it: never the scope, the scope hash or `decided_by`. The policy
 * snapshot itself is never read into the envelope beyond that ID.
 *
 * T11.9 (FR-INN-13): when a verification-output summary exists, `result.verification_summary` carries it as DISPLAY-ONLY text
 * with a visible source label (derived here from the source, never from the stored text) and a pointer to the raw artifact
 * by ID and SHA-256. It never feeds `status`, `failure_code`, `verification` (exit codes, outcomes) or any count: those are
 * read from the run row and the terminal transition as before. This module still does not import `src/inner/`.
 *
 * T3.4: the operator `approve`/`deny` record (`operator_decision_requested`) carries the deciding OS user and the scope
 * hash for the operator CLI; `get_run include_events` drops both fields from that event (Proposed).
 *
 * T14.2 (FR-CTL-03, LLD §3.4.5): when the caller passes needs-attention options (`get_run`, `list_runs`), the envelope
 * carries `needs_attention`, derived on read by `src/control/needs-attention.ts` from ledger rows only; nothing is stored.
 * T14.4 (FR-CTL-06): unless the caller passes its own `control` facts, `budget_exhausted` reads the budget evaluator the
 * run lifecycle registered for this ledger (`src/control/budgets.ts`), so the flag matches what refuses admission.
 * T14.5 (FR-CTL-07): likewise `parked_loop` reads the loop breaker's park events (`src/control/loop-attention.ts`).
 *
 * T3.24 (FR-CAP-12, LLD §20.2): a `QUEUED` run whose latest `load_hold` event has no later `load_release` carries
 * `hold: { reason: "held_load", since }` (the hold event's time). Absent otherwise; a hold is not a needs-attention reason.
 *
 * ADR-0069 (LLD §3.4.12): a run with at least one ACCEPTED `git_push` event (the agent `push` tool, an operator push
 * recorded on it, or `publish_run`) carries `publications`, one entry per pushed branch and head, oldest first, with the
 * newest `pull_request` row of that branch when `publish_run` opened or reused one. Deliberate exception to "no branch
 * names" above: the remote branch is what the caller publishes and reviews; it is the controller's
 * `<branch_prefix><meta-session id>`, never a run branch or a worktree path.
 *
 * ADR-0080 items 6 and 7 (LLD §3.4.17): a publication of an umbrella project carries `linked_pull_requests`, the
 * submodule pull requests `publish_run` linked to the branch (newest per repository, with the pushed paths) and, once
 * the ordered merge reached one, its `merge_state` read from the `submodule_merge` steps.
 */

import { RUN_WARNING_CODES, type RunWarning } from "../adapters/types.js";
import { HELD_LOAD_REASON, LOAD_HOLD_EVENT, LOAD_RELEASE_EVENT } from "../capacity/host-load.js";
import { budgetControlFacts } from "../control/budgets.js";
import { loopBreakerControlFacts } from "../control/loop-attention.js";
import {
  type ControlPlaneFacts,
  type NeedsAttention,
  type NeedsAttentionOptions,
  needsAttentionOf,
} from "../control/needs-attention.js";
import { GIT_REF_SNAPSHOT_EVENT } from "../git/ref-guard.js";
import type { Ledger, RunRecord } from "../ledger/index.js";
import {
  isTerminal,
  LOG_SUMMARY_EVENT,
  type LogSummarySource,
  OPERATOR_DECISION_REQUESTED,
  summaryLabel,
} from "../lifecycle/index.js";
import type { ReportedUsage } from "../usage/index.js";
import { MCP_ARTIFACT_KINDS } from "./schemas.js";

const MCP_KINDS: ReadonlySet<string> = new Set(MCP_ARTIFACT_KINDS);
const SUMMARY_MAX = 4000;
const DETAIL_MAX = 1000;
const EVENT_PAYLOAD_MAX = 2000;

export interface Envelope {
  run_id: string;
  meta_session_id: string;
  status: string;
  /** FR-PRJ-03: the project of a run delegated to one; absent for a workspace-path run. */
  project_id?: string;
  failure_code?: string;
  failure_detail?: string;
  provider: { adapter: string | null; model: string | null; adapter_version: string | null };
  route: { reasons: string[] };
  result: {
    summary?: string;
    changed_files?: number;
    verification: Record<string, unknown>[];
    verification_summary?: VerificationSummaryView;
    /** ADR-0072: recovered, non-security denials of a run that succeeded. */
    warnings?: RunWarning[];
  };
  artifacts: Record<string, string>;
  usage: { reported: ReportedUsage[] | null; estimated: null; capacity_confidence: null };
  approval?: { status: "PENDING" | "APPROVED" | "DENIED"; requested_at: string };
  /** T6.5 (FR-MCP-10, LLD §16.5): the failed run this one retries; present only on a successor. */
  retry_of?: string;
  /** T6.5 (FR-MCP-10): the run that supersedes this one (its retry or failover successor); present only when set. */
  superseded_by?: string;
  /** T14.2 (FR-CTL-03): derived on read for `get_run` and `list_runs`; `reason` only when `active`. */
  needs_attention?: NeedsAttention;
  /** T3.24 (FR-CAP-12): present only while a `QUEUED` run is held by the host load hold. */
  hold?: { reason: typeof HELD_LOAD_REASON; since: string };
  /** T8.10 (FR-EXE-10, LLD §20.6): the run's newest verification result's pin; present once one is recorded. */
  verification?: VerificationPinView;
  replayed?: boolean;
  /** ADR-0069: accepted pushes of this run's branch, with the pull request `publish_run` opened for it. */
  publications?: PublicationView[];
  events?: { seq: number; ts: string; type: string; payload: unknown }[];
}

/** ADR-0069: one pushed branch head of a run; the pull request fields only when one was recorded for the branch. */
export interface PublicationView {
  branch: string;
  head_sha: string;
  pushed_at: string;
  pull_request_url?: string;
  pull_request_number?: number;
  /** ADR-0080 item 6: the submodule pull requests `publish_run` linked to this branch; present only when there is one. */
  linked_pull_requests?: LinkedPullRequestView[];
}

/** ADR-0080 items 6 and 7: one linked submodule pull request and, once the ordered merge reached it, its state. */
export interface LinkedPullRequestView {
  /** `host/owner/repo` (as `publish_run`'s `submodules[].repo`). */
  repo: string;
  paths: string[];
  number: number;
  url: string;
  base_ref: string;
  head_sha: string;
  merge_state?: { state: "merged"; merged_sha: string } | { state: "refused"; reason: string };
}

/**
 * ADR-0080: the newest `submodule_pull_request` row per repository linked to `branch`, with the paths of the push it
 * was opened for and its merge state from the `submodule_merge` steps of the umbrella ref: `merged` once a
 * `submodule_merged` step names the pull request, else `refused` with the newest refusal at its head, else absent.
 */
function linkedPullRequestsOf(ledger: Ledger, run: RunRecord, branch: string): LinkedPullRequestView[] {
  const umbrellaRef = `refs/heads/${branch}`;
  const newest = new Map<string, ReturnType<Ledger["listSubmodulePullRequestsForRun"]>[number]>();
  for (const pr of ledger.listSubmodulePullRequestsForRun(run.id)) {
    if (pr.umbrella_ref === umbrellaRef) newest.set(pr.push?.repo ?? pr.repo, pr);
  }
  if (newest.size === 0) return [];
  const steps = run.project_id === null ? [] : ledger.listSubmoduleMergeSteps(run.project_id, umbrellaRef);
  const out: LinkedPullRequestView[] = [];
  for (const [repo, pr] of newest) {
    // GitHub owner and repository names are case-insensitive.
    const mine = steps.filter((s) => s.repo?.toLowerCase() === pr.repo.toLowerCase() && s.pr_number === pr.number);
    const merged = mine.find((s) => s.step === "submodule_merged" && s.merged_sha !== null);
    const refused = mine.filter((s) => s.step === "submodule_refused" && s.head_sha === pr.head_sha).at(-1);
    out.push({
      repo,
      paths: pr.push !== undefined ? pathsOf(pr.push.paths_json) : [],
      number: pr.number,
      url: pr.url,
      base_ref: pr.base_ref,
      head_sha: pr.head_sha,
      ...(merged !== undefined
        ? { merge_state: { state: "merged" as const, merged_sha: merged.merged_sha as string } }
        : refused?.reason != null
          ? { merge_state: { state: "refused" as const, reason: refused.reason } }
          : {}),
    });
  }
  return out.sort((a, b) => ((a.paths[0] ?? a.repo) < (b.paths[0] ?? b.repo) ? -1 : 1));
}

function pathsOf(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** ADR-0069: accepted `git_push` events of the run (deduplicated by branch and head) and its `pull_request` rows. */
function publicationsOf(ledger: Ledger, run: RunRecord, pushes: readonly { ts: string; payload: unknown }[]) {
  const runId = run.id;
  const out: PublicationView[] = [];
  const seen = new Set<string>();
  for (const e of pushes) {
    const p = e.payload as { outcome?: unknown; ref?: unknown; head_sha?: unknown };
    if (p.outcome !== "ACCEPTED" || typeof p.ref !== "string" || typeof p.head_sha !== "string") continue;
    if (!p.ref.startsWith("refs/heads/") || !/^[0-9a-f]{40}$/u.test(p.head_sha)) continue;
    const branch = p.ref.slice("refs/heads/".length);
    const key = `${branch}\u0000${p.head_sha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ branch, head_sha: p.head_sha, pushed_at: e.ts });
  }
  if (out.length === 0) return out;
  const prs = ledger.listPullRequestsForRun(runId);
  for (const pub of out) {
    const pr = prs.filter((r) => r.branch === pub.branch).at(-1);
    if (pr !== undefined) {
      pub.pull_request_url = pr.url;
      pub.pull_request_number = pr.number;
    }
    const linked = linkedPullRequestsOf(ledger, run, pub.branch);
    if (linked.length > 0) pub.linked_pull_requests = linked;
  }
  return out;
}

/**
 * T8.10 (FR-EXE-10, LLD §20.6): `verified_at_sha` is the commit the verification ran on, null when the worktree's tree
 * differed from it. `stale` is computed on read from the ledger's newest `git_commit` for the run's publish ref (Linus
 * decision v10 (a)): true when that head is another commit. Delegated (fail closed): a result without a SHA is always
 * `stale`, so it can never count as verification at the current head.
 */
export interface VerificationPinView {
  verified_at_sha: string | null;
  tree_sha: string | null;
  stale: boolean;
}

function verificationPin(ledger: Ledger, runId: string): VerificationPinView | undefined {
  const row = ledger.latestVerificationResult(runId);
  if (row === undefined) return undefined;
  const head = ledger.latestPublishedHead(row.publish_ref);
  const stale = row.head_sha === null || (head !== undefined && head !== row.head_sha);
  return { verified_at_sha: row.head_sha, tree_sha: row.tree_sha, stale };
}

/** T11.9: a condensed view of the verification output. Prose only; see the module comment. */
export interface VerificationSummaryView {
  source: LogSummarySource;
  label: string;
  text: string;
  notable?: string[];
  raw_artifact: { id: string; sha256: string };
  summary_artifact_id?: string;
}

interface TransitionPayload {
  to?: string;
  adapter_version?: string | null;
  summary?: string;
  changed_files?: number;
  /** T3.10: per-command verification summaries (index, outcome, exit status; never argv or output). */
  verification?: unknown;
  /** ADR-0072: the terminal transition's recovered-denial warnings. */
  warnings?: unknown;
}

export function buildEnvelope(
  ledger: Ledger,
  run: RunRecord,
  scrub: (s: string) => string,
  attention?: NeedsAttentionOptions & { control?: ControlPlaneFacts },
): Envelope {
  let adapterVersion: string | null = null;
  let terminal: TransitionPayload | undefined;
  let summaryPayload: unknown;
  let loadHoldSince: string | undefined;
  const pushes: { ts: string; payload: unknown }[] = [];
  for (const e of ledger.listRunEvents(run.id)) {
    if (e.type === "git_push") {
      try {
        pushes.push({ ts: e.ts, payload: JSON.parse(e.payload_json) });
      } catch {
        // an unreadable payload is not a publication
      }
      continue;
    }
    if (e.type === LOAD_HOLD_EVENT || e.type === LOAD_RELEASE_EVENT) {
      loadHoldSince = e.type === LOAD_HOLD_EVENT ? e.ts : undefined;
      continue;
    }
    if (e.type === LOG_SUMMARY_EVENT) {
      try {
        summaryPayload = JSON.parse(e.payload_json); // the latest wins
      } catch {
        summaryPayload = undefined;
      }
      continue;
    }
    if (e.type !== "state_transition") continue;
    const p = JSON.parse(e.payload_json) as TransitionPayload;
    if (p.to === "LEASED" && typeof p.adapter_version === "string") adapterVersion = p.adapter_version;
    if (p.to !== undefined && isTerminal(p.to as RunRecord["state"])) terminal = p;
  }

  const artifacts: Record<string, string> = {};
  for (const a of ledger.listArtifactsForRun(run.id)) if (MCP_KINDS.has(a.kind)) artifacts[a.kind] = a.id;

  const result: Envelope["result"] = { verification: [] };
  if (typeof terminal?.summary === "string") result.summary = scrub(terminal.summary).slice(0, SUMMARY_MAX);
  if (typeof terminal?.changed_files === "number") result.changed_files = terminal.changed_files;
  if (Array.isArray(terminal?.verification)) {
    result.verification = terminal.verification.filter(
      (v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v),
    );
  }

  const warnings = warningsView(terminal?.warnings);
  if (warnings.length > 0) result.warnings = warnings;

  const verificationSummary = summaryView(summaryPayload, scrub);
  if (verificationSummary !== undefined) result.verification_summary = verificationSummary;
  const pin = verificationPin(ledger, run.id);
  const publications = publicationsOf(ledger, run, pushes);

  return {
    run_id: run.id,
    meta_session_id: run.meta_session_id,
    status: run.state,
    ...(run.project_id ? { project_id: run.project_id } : {}),
    ...(run.failure_code !== null ? { failure_code: run.failure_code } : {}),
    ...(run.failure_detail ? { failure_detail: scrub(run.failure_detail).slice(0, DETAIL_MAX) } : {}),
    provider: { adapter: run.provider, model: run.model, adapter_version: adapterVersion },
    route: { reasons: routeReasons(ledger, run) },
    result,
    artifacts,
    usage: { reported: reportedUsage(ledger, run.id), estimated: null, capacity_confidence: null },
    ...approvalOf(ledger, run),
    ...retryLinks(ledger, run),
    ...(run.state === "QUEUED" && loadHoldSince !== undefined
      ? { hold: { reason: HELD_LOAD_REASON, since: loadHoldSince } }
      : {}),
    ...(pin !== undefined ? { verification: pin } : {}),
    ...(publications.length > 0 ? { publications } : {}),
    ...(attention !== undefined
      ? {
          needs_attention: needsAttentionOf(ledger, run, {
            ...attention,
            control: attention.control ?? loopBreakerControlFacts(ledger, budgetControlFacts(ledger)),
          }),
        }
      : {}),
  };
}

/** T6.5 (FR-MCP-10): the successor chain links, one step each way. */
function retryLinks(ledger: Ledger, run: RunRecord): Pick<Envelope, "retry_of" | "superseded_by"> {
  const successor = ledger.findSuccessorRun(run.id);
  return {
    ...(run.parent_run_id !== null && run.attempt > 1 ? { retry_of: run.parent_run_id } : {}),
    ...(successor !== undefined ? { superseded_by: successor.id } : {}),
  };
}

const SUMMARY_TEXT_MAX = 2000;
const SUMMARY_NOTE_MAX = 200;
const SHA256 = /^[0-9a-f]{64}$/u;

/** Strict shape check of a stored `log_summary` payload; anything unexpected shows nothing (fail closed). */
function summaryView(payload: unknown, scrub: (s: string) => string): VerificationSummaryView | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const p = payload as Record<string, unknown>;
  const source = p.source;
  if (source !== "inner" && source !== "heuristic") return undefined;
  if (typeof p.text !== "string" || typeof p.raw_artifact_id !== "string") return undefined;
  if (typeof p.raw_sha256 !== "string" || !SHA256.test(p.raw_sha256)) return undefined;
  const notable =
    source === "inner" && Array.isArray(p.notable)
      ? p.notable
          .filter((n): n is string => typeof n === "string")
          .slice(0, 5)
          .map((n) => scrub(n).slice(0, SUMMARY_NOTE_MAX))
      : [];
  return {
    source,
    label: summaryLabel(source),
    text: scrub(p.text).slice(0, SUMMARY_TEXT_MAX),
    ...(notable.length > 0 ? { notable } : {}),
    raw_artifact: { id: p.raw_artifact_id, sha256: p.raw_sha256 },
    ...(typeof p.summary_artifact_id === "string" ? { summary_artifact_id: p.summary_artifact_id } : {}),
  };
}

const SHOWN_APPROVAL_STATUSES: ReadonlySet<string> = new Set(["PENDING", "APPROVED", "DENIED"]);

/** `{ approval }` for a privileged run whose snapshot names an approval; `{}` otherwise (fail closed: no guessing). */
function approvalOf(ledger: Ledger, run: RunRecord): Pick<Envelope, "approval"> {
  if (run.trust_profile !== "privileged") return {};
  let approvalId: unknown;
  try {
    approvalId = (JSON.parse(run.policy_snapshot_json) as { privilegedScope?: { approvalId?: unknown } })
      .privilegedScope?.approvalId;
  } catch {
    return {};
  }
  const row = typeof approvalId === "string" ? ledger.getApproval(approvalId) : undefined;
  if (!row || !SHOWN_APPROVAL_STATUSES.has(row.status)) return {};
  return {
    approval: { status: row.status as "PENDING" | "APPROVED" | "DENIED", requested_at: row.requested_at },
  };
}

function reportedUsage(ledger: Ledger, runId: string): ReportedUsage[] | null {
  // Only provider_reported rows are exposed here; an estimate must never surface as a reported figure.
  const rows = ledger.listUsageObservationsForRun(runId).filter((r) => r.source === "provider_reported");
  if (rows.length === 0) return null;
  return rows.map((r) => ({
    source: "provider_reported",
    provider: r.provider,
    harness: r.harness,
    backing_provider: r.backing_provider,
    model: r.model,
    observed_at: r.observed_at,
    metrics: JSON.parse(r.metrics_json) as ReportedUsage["metrics"],
  }));
}

interface Candidate {
  provider: string;
  /** T7.15 (LLD §17.7): the group member key (`provider/model`); several members may share one provider. */
  member?: string | null;
  eligible: boolean;
  reasons: { code: string }[];
}

/** The adapter compile verdicts a `privileged` admission defers to dispatch (T3.3, as `admissible` in `server.ts`). */
const DEFERRED_COMPILE = new Set(["PROFILE_UNSUPPORTED", "CAPABILITY_MISSING"]);

/**
 * One line per candidate, labelled by its group member when it has one (so two members of one provider are two
 * distinguishable lines). For a `privileged` run a candidate refused only by the adapter's compile verdict was
 * admissible, its compile deferred to dispatch: it reads as deferred, not as excluded beside its own selection.
 */
export function routeReasons(ledger: Ledger, run: RunRecord): string[] {
  const row = ledger.getRouteDecision(run.id);
  if (!row) return [];
  const out: string[] = [];
  const reasons = JSON.parse(row.reasons_json) as { selection?: { provider?: string; basis?: string } };
  if (row.selected_provider) {
    out.push(`selected ${row.selected_provider} (${reasons.selection?.basis ?? "eligibility"})`);
  }
  for (const c of JSON.parse(row.candidates_json) as Candidate[]) {
    const label = c.member ?? c.provider;
    const code = c.reasons[0]?.code ?? "UNKNOWN";
    const deferred =
      run.trust_profile === "privileged" &&
      c.reasons.length > 0 &&
      c.reasons.every((r) => DEFERRED_COMPILE.has(r.code));
    if (c.eligible) out.push(`${label}: eligible`);
    else if (deferred) out.push(`${label}: compile deferred to dispatch (${code})`);
    else out.push(`${label}: excluded ${code}`);
  }
  return out;
}

/** Compact events for `get_run include_events` (LLD §3): type and a bounded, scrubbed payload; no raw output. */
export function compactEvents(
  ledger: Ledger,
  runId: string,
  afterSeq: number,
  limit: number,
  scrub: (s: string) => string,
): NonNullable<Envelope["events"]> {
  return ledger.listRunEventsAfter(runId, afterSeq, limit).map((e) => {
    const raw =
      e.type === OPERATOR_DECISION_REQUESTED
        ? operatorOnlyStripped(e.payload_json)
        : e.type === GIT_REF_SNAPSHOT_EVENT
          ? refListStripped(e.payload_json)
          : e.payload_json;
    const text = scrub(raw);
    let payload: unknown;
    if (text.length > EVENT_PAYLOAD_MAX) payload = { truncated: true, bytes: e.payload_json.length };
    else {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { unparseable: true };
      }
    }
    return { seq: e.seq, ts: e.ts, type: e.type, payload };
  });
}

/** T9.5: the MCP client sees the snapshot's digest and counts, not the operator repository's ref list. */
function refListStripped(json: string): string {
  try {
    const { refs, ...rest } = JSON.parse(json) as { refs?: unknown };
    return JSON.stringify({ ...rest, refs_listed: Array.isArray(refs) ? refs.length : 0 });
  } catch {
    return JSON.stringify({ unparseable: true });
  }
}

/** Operator-only fields of an `approve`/`deny` record (LLD §3.1 "What is shown where": no hash, no `decided_by`). */
function operatorOnlyStripped(json: string): string {
  try {
    const { requested_by: _by, scope_hash: _hash, ...rest } = JSON.parse(json) as Record<string, unknown>;
    return JSON.stringify(rest);
  } catch {
    return JSON.stringify({ unparseable: true });
  }
}

const WARNING_TOOL = /^[A-Za-z0-9_.:-]{1,64}$/;

/** ADR-0072: the stored warnings re-checked against the closed shape on read; anything else is dropped. */
function warningsView(raw: unknown): RunWarning[] {
  if (!Array.isArray(raw)) return [];
  const out: RunWarning[] = [];
  for (const w of raw) {
    if (typeof w !== "object" || w === null) continue;
    const { code, tool, count } = w as Record<string, unknown>;
    if (!RUN_WARNING_CODES.some((c) => c === code)) continue;
    if (typeof tool !== "string" || !WARNING_TOOL.test(tool)) continue;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) continue;
    out.push({ code: code as RunWarning["code"], tool, count });
  }
  return out;
}
