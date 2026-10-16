/**
 * `get_digest(since_cursor)` assembly (T14.3; FR-CTL-02, FR-TEL-01, FR-MCP-04, LLD §3.4.3). Read-only over ledger rows:
 * nothing is written, no digest state is kept beyond `run_event`, and the cursor is a `run_event.id`.
 *
 * Scope is `get_run`'s: only runs this client started and the caller may see (the HTTP subject filter included). The
 * scan reads only those runs' events, so the cursor never names, and never advances over, another client's event.
 *
 * Proposed (Delegated, T14.3):
 * - Delta (`since_cursor` given): the events of the caller's runs strictly after the cursor in `(ts, id)` order, at most
 *   {@link DIGEST_SCAN_BUDGET}; the returned cursor is the last scanned event, or `since_cursor` itself when nothing is
 *   new (then `projects` is empty). A run touched by the scan appears in `needs_attention` when its flag is active now,
 *   in `finished` / `failed` when the scan holds its `state_transition` to `SUCCEEDED` / `FAILED`, and its meta-session's
 *   `PENDING` approval in `pending_approvals`. Only projects a scanned run belongs to are listed.
 * - Snapshot (no `since_cursor`): every project the caller may use plus the projects of its runs; current flags and
 *   approvals over all its runs, and the newest {@link SNAPSHOT_TERMINAL_MAX} finished and failed runs per project. The
 *   cursor is the caller's newest event, `null` when it has none (LLD amendment: the LLD type cannot express "no event").
 * - A cursor that is not the id of an event of the caller's visible runs is INVALID_REQUEST (`run_event` is append-only
 *   with no delete, so there is no garbage-collected cursor to fall back from).
 * - Runs without a project (workspace-path runs) are not in the digest; `list_runs` still shows them.
 * - Agent text: an envelope's `result.summary` moves to `untrusted_summaries` as `untrusted_text` (at most
 *   {@link UNTRUSTED_TEXT_MAX} characters, elided with "…", never splitting a surrogate pair) and is removed from the
 *   envelope; `result.verification_summary` (display-only prose from verification output) is removed too and stays on
 *   `get_run`.
 * - `budget.exhausted` reads the same {@link ControlPlaneFacts} port as `needs_attention` (no budgets exist until
 *   T14.4, so it reports none); `budget.caps` is omitted, not invented, until T14.4 persists it.
 * - `paused` (T14.6, LLD §3.4.4) is `control_plane_state` at read time for every listed project: the project's own
 *   flag or the operator's global pause (`isAdmissionPaused`), so a global pause shows `paused: true` on every visible
 *   project. It is not a `needs_attention` reason and no run row carries it.
 * - Pending approvals are `privileged_scope` approvals only (dynamic-project revisions join with T14.8); the
 *   `approval_digest` is LLD §3.4.8's SHA-256 over controller fields only.
 */

import { createHash } from "node:crypto";
import { budgetControlFacts } from "../control/budgets.js";
import { loopBreakerControlFacts } from "../control/loop-attention.js";
import type { ControlPlaneFacts, NeedsAttentionReason } from "../control/needs-attention.js";
import { isAdmissionPaused } from "../control/pause.js";
import type { ApprovalRow, Ledger, RunEventRow, RunRecord } from "../ledger/index.js";
import { canonicalJson } from "../lifecycle/request.js";
import { buildEnvelope, type Envelope } from "./envelope.js";
import { invalid } from "./errors.js";

/** LLD §3.4.3 proposed scan budget: events per call. */
export const DIGEST_SCAN_BUDGET = 10_000;
/** Proposed: finished and failed runs per project in a snapshot. */
export const SNAPSHOT_TERMINAL_MAX = 50;
/** LLD §3.4.1 `untrusted_text.text` maximum. */
export const UNTRUSTED_TEXT_MAX = 500;
export const UNTRUSTED_LABEL = "untrusted_agent_text";

export interface UntrustedText {
  text: string;
  label: typeof UNTRUSTED_LABEL;
}

export interface ApprovalProxyItem {
  approval_id: string;
  approval_digest: string;
  kind: "privileged_scope";
  project_id?: string;
  run_id: string;
  target_client_id: string;
  requested_at: string;
}

export interface DigestProject {
  project_id: string;
  /** T14.6: the project's own pause or the operator's global pause holds admission now. */
  paused: boolean;
  budget: { exhausted: boolean };
  needs_attention: { run_id: string; reason: NeedsAttentionReason; envelope: Envelope }[];
  finished: Envelope[];
  failed: Envelope[];
  pending_approvals: ApprovalProxyItem[];
  untrusted_summaries: { run_id: string; field: "result.summary"; content: UntrustedText }[];
}

export interface Digest {
  cursor: string | null;
  projects: DigestProject[];
}

export interface DigestScope {
  clientId: string;
  /** The run is visible to this caller (`get_run` scope beyond `client_id`, e.g. the HTTP subject). */
  visible(run: RunRecord): boolean;
  /** Projects the caller may use (configured and dynamic); listed in a snapshot even without runs. */
  projectIds: readonly string[];
}

export interface DigestOptions {
  now: Date;
  control?: ControlPlaneFacts;
  scanBudget?: number;
}

export function assembleDigest(
  ledger: Ledger,
  scope: DigestScope,
  sinceCursor: string | undefined,
  scrub: (s: string) => string,
  options: DigestOptions,
): Digest {
  // T14.4/T14.5: the same default facts as `get_run` (budgets, park events), so a digest entry carries its reason.
  const control = options.control ?? loopBreakerControlFacts(ledger, budgetControlFacts(ledger));
  const visibleRuns = new Map<string, RunRecord | null>();
  const visibleRun = (runId: string): RunRecord | undefined => {
    if (!visibleRuns.has(runId)) {
      const run = ledger.getRunRecord(runId);
      visibleRuns.set(runId, run !== undefined && run.client_id === scope.clientId && scope.visible(run) ? run : null);
    }
    return visibleRuns.get(runId) ?? undefined;
  };
  const assemble = (
    runs: RunRecord[],
    terminal: (run: RunRecord) => boolean,
    projectIds: Iterable<string>,
    terminalMax = Number.POSITIVE_INFINITY,
  ) => assembleProjects(ledger, runs, { terminal, terminalMax }, projectIds, scrub, { now: options.now, control });

  if (sinceCursor === undefined) {
    const runs = allRuns(ledger, scope);
    let cursor: RunEventRow | undefined;
    for (const run of runs) {
      const last = ledger.listRunEvents(run.id).at(-1);
      if (last !== undefined && (cursor === undefined || after(last, cursor))) cursor = last;
    }
    return {
      cursor: cursor?.id ?? null,
      projects: assemble(
        runs,
        (run) => run.state === "SUCCEEDED" || run.state === "FAILED",
        [...scope.projectIds, ...projectsOf(runs)],
        SNAPSHOT_TERMINAL_MAX,
      ),
    };
  }

  const start = ledger.getRunEvent(sinceCursor);
  if (start === undefined || visibleRun(start.run_id) === undefined) {
    throw invalid("invalid arguments: $.since_cursor is not a cursor get_digest returned", { field: "since_cursor" });
  }
  const budget = options.scanBudget ?? DIGEST_SCAN_BUDGET;
  const scanned: RunEventRow[] = [];
  let position = { ts: start.ts, id: start.id };
  // Over HTTP another subject's runs are filtered after the query, so read in batches until the budget is full.
  for (;;) {
    const batch = ledger.listRunEventsForClient({ clientId: scope.clientId, after: position, limit: budget });
    for (const e of batch) if (scanned.length < budget && visibleRun(e.run_id) !== undefined) scanned.push(e);
    const last = batch.at(-1);
    if (scanned.length >= budget || last === undefined || batch.length < budget) break;
    position = { ts: last.ts, id: last.id };
  }
  const terminalized = new Set<string>();
  for (const e of scanned) {
    if (e.type !== "state_transition") continue;
    const to = (JSON.parse(e.payload_json) as { to?: unknown }).to;
    if (to === "SUCCEEDED" || to === "FAILED") terminalized.add(e.run_id);
  }
  const touched = [...new Set(scanned.map((e) => e.run_id))].map((id) => visibleRun(id) as RunRecord);
  return {
    cursor: scanned.at(-1)?.id ?? start.id,
    projects: assemble(touched, (run) => terminalized.has(run.id), projectsOf(touched)),
  };
}

function assembleProjects(
  ledger: Ledger,
  runs: RunRecord[],
  sections: { terminal: (run: RunRecord) => boolean; terminalMax: number },
  projectIds: Iterable<string>,
  scrub: (s: string) => string,
  attention: { now: Date; control: ControlPlaneFacts },
): DigestProject[] {
  const { control } = attention;
  const byProject = new Map<string, DigestProject>();
  for (const id of [...new Set(projectIds)].sort()) {
    byProject.set(id, {
      project_id: id,
      paused: isAdmissionPaused(ledger, id),
      budget: { exhausted: control.budgetExhausted(id) || control.budgetExhausted("*") },
      needs_attention: [],
      finished: [],
      failed: [],
      pending_approvals: [],
      untrusted_summaries: [],
    });
  }
  const seenApprovals = new Set<string>();
  for (const run of [...runs].sort(newestFirst)) {
    const project = run.project_id === null ? undefined : byProject.get(run.project_id);
    if (project === undefined) continue;
    const { envelope, summary } = digestEnvelope(buildEnvelope(ledger, run, scrub, attention));
    const flagged = envelope.needs_attention?.active === true ? envelope.needs_attention.reason : undefined;
    if (flagged !== undefined) project.needs_attention.push({ run_id: run.id, reason: flagged, envelope });
    const section = run.state === "SUCCEEDED" ? project.finished : run.state === "FAILED" ? project.failed : undefined;
    const ended = section !== undefined && sections.terminal(run) && section.length < sections.terminalMax;
    if (ended) section.push(envelope);
    const approval = pendingApproval(ledger, run);
    if (approval !== undefined && !seenApprovals.has(approval.id)) {
      seenApprovals.add(approval.id);
      project.pending_approvals.push(proxyItem(approval, run));
    }
    if ((flagged !== undefined || ended) && summary !== undefined) {
      project.untrusted_summaries.push({ run_id: run.id, field: "result.summary", content: untrustedText(summary) });
    }
  }
  return [...byProject.values()];
}

/** The digest's copy of an envelope: agent-written prose leaves it (see the module comment). */
function digestEnvelope(full: Envelope): { envelope: Envelope; summary: string | undefined } {
  const { summary, verification_summary: _display, ...result } = full.result;
  return { envelope: { ...full, result }, summary };
}

/** LLD §3.4.1 `untrusted_text`: capped at {@link UNTRUSTED_TEXT_MAX} UTF-16 units, never ending in half a pair. */
export function untrustedText(text: string): UntrustedText {
  if (text.length <= UNTRUSTED_TEXT_MAX) return { text, label: UNTRUSTED_LABEL };
  let cut = UNTRUSTED_TEXT_MAX - 1;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return { text: `${text.slice(0, cut)}…`, label: UNTRUSTED_LABEL };
}

function pendingApproval(ledger: Ledger, run: RunRecord): ApprovalRow | undefined {
  try {
    const approval = ledger.findApprovalForMetaSession(run.meta_session_id, run.client_id);
    return approval?.status === "PENDING" ? approval : undefined;
  } catch {
    return undefined; // invariant violation: no single row to list; needs_attention already flags the run
  }
}

/** LLD §3.4.8 `approval_proxy_item` from controller fields only; `approval_digest` binds the frozen scope hash. */
function proxyItem(approval: ApprovalRow, run: RunRecord): ApprovalProxyItem {
  const fields = {
    v: 1,
    approval_id: approval.id,
    kind: "privileged_scope",
    scope_hash: approval.scope_hash,
    target_client_id: run.client_id,
    requested_at: approval.requested_at,
  };
  return {
    approval_id: approval.id,
    approval_digest: createHash("sha256").update(canonicalJson(fields)).digest("hex"),
    kind: "privileged_scope",
    ...(run.project_id !== null ? { project_id: run.project_id } : {}),
    run_id: approval.run_id,
    target_client_id: run.client_id,
    requested_at: approval.requested_at,
  };
}

function allRuns(ledger: Ledger, scope: DigestScope): RunRecord[] {
  const out: RunRecord[] = [];
  let before: { createdAt: string; id: string } | undefined;
  for (;;) {
    const batch = ledger.listRunsForClient({ clientId: scope.clientId, ...(before ? { before } : {}), limit: 500 });
    out.push(...batch.filter((run) => scope.visible(run)));
    const last = batch.at(-1);
    if (last === undefined || batch.length < 500) return out;
    before = { createdAt: last.created_at, id: last.id };
  }
}

const projectsOf = (runs: RunRecord[]): string[] => runs.flatMap((r) => (r.project_id === null ? [] : [r.project_id]));

const after = (a: RunEventRow, b: RunEventRow): boolean => a.ts > b.ts || (a.ts === b.ts && a.id > b.id);

/** `list_runs` order: `created_at`, then `id`, both descending. */
const newestFirst = (a: RunRecord, b: RunRecord): number =>
  b.created_at.localeCompare(a.created_at) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);
