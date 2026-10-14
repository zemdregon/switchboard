/**
 * `explain_route` (T7.3; FR-MCP-02, FR-RTE-03, LLD §17.5, ADR-0044 item 7): a read-only view of one stored
 * `route_decision`. Pure: it reads the row it is given and nothing else, never calls a model or a provider, and its
 * `deciding_factors` come from a fixed template over stored values, never from model text. Reason details are bounded
 * and passed through the caller's scrubber (paths outside the allowed roots, secrets).
 */
import type { RouteDecisionRow } from "../ledger/index.js";
import { ROUTE_DECISION_SCHEMA_VERSION } from "./decision.js";

/** LLD §17.5: the bound on each reason detail, as in eligibility errors. */
export const MAX_REASON_DETAIL = 300;

export interface ExplainedCandidate {
  provider: string;
  eligible: boolean;
  reasons: { code: string; detail: string }[];
  score: number | null;
  terms: Record<string, number> | null;
}

export interface RouteExplanation {
  run_id: string;
  schema_version: number | null;
  decided_at: string | null;
  selected_provider: string | null;
  selection: { provider: string; basis: string; rule: string | null } | null;
  candidates: ExplainedCandidate[];
  features: Record<string, unknown> | null;
  weights: Record<string, number> | null;
  affinity: Record<string, unknown> | null;
  continuation: Record<string, unknown> | null;
  project: { id: string; excluded_providers: string[] } | null;
  deciding_factors: string[];
}

const parse = <T>(json: string | null): T | null => {
  if (json === null) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
};
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function explainRoute(
  runId: string,
  row: RouteDecisionRow | undefined,
  scrub: (s: string) => string = (s) => s,
): RouteExplanation {
  if (row === undefined) {
    return {
      run_id: runId,
      schema_version: null,
      decided_at: null,
      selected_provider: null,
      selection: null,
      candidates: [],
      features: null,
      weights: null,
      affinity: null,
      continuation: null,
      project: null,
      deciding_factors: ["no route decision recorded"],
    };
  }
  const features = parse<Record<string, unknown>>(row.features_json);
  const reasons = parse<Record<string, unknown>>(row.reasons_json) ?? {};
  const version = features?.schema_version === ROUTE_DECISION_SCHEMA_VERSION ? ROUTE_DECISION_SCHEMA_VERSION : 1;
  const rawCandidates = parse<unknown[]>(row.candidates_json) ?? [];
  const candidates: ExplainedCandidate[] = rawCandidates.filter(isObject).map((c) => ({
    provider: String(c.provider),
    eligible: c.eligible === true,
    reasons: (Array.isArray(c.reasons) ? c.reasons : []).filter(isObject).map((r) => ({
      code: String(r.code),
      detail: scrub(String(r.detail ?? "")).slice(0, MAX_REASON_DETAIL),
    })),
    score: typeof c.score === "number" ? c.score : null,
    terms: isObject(c.terms) ? (c.terms as Record<string, number>) : null,
  }));
  const sel = isObject(reasons.selection) ? reasons.selection : null;
  const selection =
    sel !== null && typeof sel.provider === "string"
      ? {
          provider: sel.provider,
          basis: scrub(String(sel.basis ?? "")),
          rule: typeof sel.rule === "string" ? sel.rule : null,
        }
      : null;
  const project = isObject(reasons.project)
    ? {
        id: String(reasons.project.id),
        excluded_providers: Array.isArray(reasons.project.excluded_providers)
          ? reasons.project.excluded_providers.map(String)
          : [],
      }
    : null;
  const affinity = isObject(reasons.affinity) ? reasons.affinity : null;
  return {
    run_id: runId,
    schema_version: version,
    decided_at: row.created_at,
    selected_provider: row.selected_provider,
    selection,
    candidates,
    // Only the M7 record's features are explained; an M2 row's request facts stay in the ledger.
    features: version === ROUTE_DECISION_SCHEMA_VERSION ? features : null,
    weights: parse<Record<string, number>>(row.weights_json),
    affinity,
    continuation: isObject(reasons.continuation) ? reasons.continuation : null,
    project,
    deciding_factors: decidingFactors(version, row.selected_provider, selection, candidates, affinity),
  };
}

/** LLD §17.5 template: the rule, the affinity outcome, the top two scores when scored, each exclusion's first code. */
function decidingFactors(
  version: number,
  selected: string | null,
  selection: RouteExplanation["selection"],
  candidates: readonly ExplainedCandidate[],
  affinity: Record<string, unknown> | null,
): string[] {
  const out: string[] = [];
  if (version !== ROUTE_DECISION_SCHEMA_VERSION) out.push("eligibility only (decision recorded before scoring)");
  if (selection !== null) {
    out.push(`selected ${selection.provider} by ${selection.rule ?? selection.basis}`);
  } else if (selected === null) {
    out.push("no provider selected");
  }
  if (affinity !== null) {
    const provider = typeof affinity.provider === "string" ? affinity.provider : null;
    const reason = typeof affinity.affinity_switch_reason === "string" ? affinity.affinity_switch_reason : null;
    if (affinity.held === true) out.push(`affinity held (${provider})`);
    else if (reason !== null) out.push(`affinity switched from ${provider} (${reason})`);
    else if (affinity.applies === false) out.push("affinity not applied (continuation)");
    else if (provider === null) out.push("no affinity recorded for the project");
  }
  if (selection?.rule === "score" || selection?.rule === "configured_order") {
    const ranked = candidates
      .filter((c) => c.eligible && c.score !== null)
      .sort((a, b) => (b.score as number) - (a.score as number));
    for (const c of ranked.slice(0, 2)) out.push(`score ${c.provider} ${(c.score as number).toFixed(4)}`);
  }
  for (const c of candidates) {
    const first = c.reasons[0];
    if (!c.eligible && first !== undefined) out.push(`${c.provider} excluded: ${first.code}`);
  }
  return out;
}
