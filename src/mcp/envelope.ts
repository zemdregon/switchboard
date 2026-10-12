/**
 * Compact run envelope (LLD §3 `envelope`, FR-MCP-04, BR-21), built only from controller-owned ledger fields. It never
 * carries raw provider output, worktree paths, branch names, pids or credential material; provider stdout/stderr
 * artifacts are operator-CLI only and are left out of `artifacts`.
 *
 * Proposed (Delegated): `failure_detail` (redacted, bounded) so an asynchronous failure such as AUTH_REQUIRED still
 * names the native login command (FR-AUTH-02); route reasons are short strings derived from `route_decision`; `usage.reported`
 * lists stored provider-reported observations, each labelled with its source (T2.5), and is null when none exist
 * (never zero); `estimated` and `capacity_confidence` stay null until the M6 estimator (FR-CAP-01..03).
 */
import type { Ledger, RunRecord } from "../ledger/index.js";
import { isTerminal } from "../lifecycle/index.js";
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
  failure_code?: string;
  failure_detail?: string;
  provider: { adapter: string | null; model: string | null; adapter_version: string | null };
  route: { reasons: string[] };
  result: { summary?: string; changed_files?: number; verification: Record<string, unknown>[] };
  artifacts: Record<string, string>;
  usage: { reported: ReportedUsage[] | null; estimated: null; capacity_confidence: null };
  replayed?: boolean;
  events?: { seq: number; ts: string; type: string; payload: unknown }[];
}

interface TransitionPayload {
  to?: string;
  adapter_version?: string | null;
  summary?: string;
  changed_files?: number;
}

export function buildEnvelope(ledger: Ledger, run: RunRecord, scrub: (s: string) => string): Envelope {
  let adapterVersion: string | null = null;
  let terminal: TransitionPayload | undefined;
  for (const e of ledger.listRunEvents(run.id)) {
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

  return {
    run_id: run.id,
    meta_session_id: run.meta_session_id,
    status: run.state,
    ...(run.failure_code !== null ? { failure_code: run.failure_code } : {}),
    ...(run.failure_detail ? { failure_detail: scrub(run.failure_detail).slice(0, DETAIL_MAX) } : {}),
    provider: { adapter: run.provider, model: run.model, adapter_version: adapterVersion },
    route: { reasons: routeReasons(ledger, run.id) },
    result,
    artifacts,
    usage: { reported: reportedUsage(ledger, run.id), estimated: null, capacity_confidence: null },
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
    const text = scrub(e.payload_json);
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
