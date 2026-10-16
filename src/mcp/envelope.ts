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
 * T14.5 (FR-CTL-07): unless the caller passes its own `control` facts, `parked_loop` reads the loop breaker's park
 * events (`src/control/loop-attention.ts`).
 */

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
  replayed?: boolean;
  events?: { seq: number; ts: string; type: string; payload: unknown }[];
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
  for (const e of ledger.listRunEvents(run.id)) {
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

  const verificationSummary = summaryView(summaryPayload, scrub);
  if (verificationSummary !== undefined) result.verification_summary = verificationSummary;

  return {
    run_id: run.id,
    meta_session_id: run.meta_session_id,
    status: run.state,
    ...(run.project_id ? { project_id: run.project_id } : {}),
    ...(run.failure_code !== null ? { failure_code: run.failure_code } : {}),
    ...(run.failure_detail ? { failure_detail: scrub(run.failure_detail).slice(0, DETAIL_MAX) } : {}),
    provider: { adapter: run.provider, model: run.model, adapter_version: adapterVersion },
    route: { reasons: routeReasons(ledger, run.id) },
    result,
    artifacts,
    usage: { reported: reportedUsage(ledger, run.id), estimated: null, capacity_confidence: null },
    ...approvalOf(ledger, run),
    ...retryLinks(ledger, run),
    ...(attention !== undefined
      ? {
          needs_attention: needsAttentionOf(ledger, run, {
            ...attention,
            control: attention.control ?? loopBreakerControlFacts(ledger),
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
  eligible: boolean;
  reasons: { code: string }[];
}

function routeReasons(ledger: Ledger, runId: string): string[] {
  const row = ledger.getRouteDecision(runId);
  if (!row) return [];
  const out: string[] = [];
  const reasons = JSON.parse(row.reasons_json) as { selection?: { provider?: string; basis?: string } };
  if (row.selected_provider) {
    out.push(`selected ${row.selected_provider} (${reasons.selection?.basis ?? "eligibility"})`);
  }
  for (const c of JSON.parse(row.candidates_json) as Candidate[]) {
    if (c.eligible) out.push(`${c.provider}: eligible`);
    else out.push(`${c.provider}: excluded ${c.reasons[0]?.code ?? "UNKNOWN"}`);
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
