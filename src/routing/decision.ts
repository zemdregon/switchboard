/**
 * FR-RTE-03 route decisions (T7.2, LLD §17.4, ADR-0044 item 6): collect the per-candidate score inputs from the ledger,
 * run the stage-2 selection (`score.ts`) and serialise one self-contained `route_decision` row with
 * `features_json.schema_version` 2, so that {@link replayRouteDecision} can recompute the selection and every score from
 * that row alone. Collection reads the ledger; building and replaying are pure.
 */
import { breakerOutcome } from "../capacity/breaker.js";
import { collectCapacityInputs } from "../capacity/collect.js";
import { estimateCapacity } from "../capacity/estimate.js";
import { projectKey } from "../capacity/projection.js";
import { capacityProviders } from "../capacity/providers.js";
import type { AffinitySettings, ResolvedConfig } from "../config/index.js";
import type { Ledger, NewRouteDecision, RouteDecisionRow } from "../ledger/index.js";
import {
  type AffinityFacts,
  type AffinityRecord,
  affinityRecord,
  type ModelPinRecord,
  planAffinity,
} from "./affinity.js";
import type { EligibilityDecision, EligibilityInput } from "./eligibility.js";
import type { RouteFeatures } from "./features.js";
import {
  DEFAULT_WEIGHTS,
  SCORE_TERMS,
  type ScoreInputs,
  type SelectionBasis,
  selectRoute,
  type Terms,
  type Weights,
} from "./score.js";

export const ROUTE_DECISION_SCHEMA_VERSION = 2;

/** What score-input collection needs besides the ledger (LLD §16.1 window, §17.1 weights). */
export interface RouteScoringSettings {
  weights: Weights;
  windowSeconds: number;
  confidenceRuns: number;
  providers?: ResolvedConfig["providers"];
  limits?: Pick<ResolvedConfig["limits"], "perProviderConcurrency">;
  /** T7.5 (LLD §17.1): `routing.affinity`. Absent means enabled with both estimate thresholds null. */
  affinity?: AffinitySettings;
}

export const DEFAULT_AFFINITY: Readonly<AffinitySettings> = Object.freeze({
  enabled: true,
  lowWaterMark: null,
  minConfidence: null,
});

/** LLD §16.1 and §17.1 defaults, for callers built without configuration (tests, the M1 lifecycle). */
export const DEFAULT_ROUTE_SCORING: Readonly<RouteScoringSettings> = Object.freeze({
  weights: DEFAULT_WEIGHTS,
  windowSeconds: 3600,
  confidenceRuns: 10,
});

/**
 * LLD §17.3 inputs per provider over the capacity window: the breaker classification of terminal runs (healthy and
 * counted), the median wall time of succeeded runs, the M6 estimate, and whether the provider is the meta-session's.
 * `sessionProvider` null (a new meta-session) makes every candidate session-bound, so the handoff term is equal.
 */
export function collectScoreInputs(
  ledger: Ledger,
  ids: readonly string[],
  settings: RouteScoringSettings,
  now: Date,
  sessionProvider: string | null,
): Record<string, ScoreInputs> {
  const since = new Date(now.getTime() - settings.windowSeconds * 1000).toISOString();
  const infos = capacityProviders(ids, {
    ...(settings.providers !== undefined ? { providers: settings.providers } : {}),
    ...(settings.limits !== undefined ? { limits: settings.limits } : {}),
  });
  const out: Record<string, ScoreInputs> = {};
  for (const info of infos) {
    let healthy = 0;
    let counted = 0;
    const durations: number[] = [];
    for (const r of ledger.listTerminalRunsForProviderSince(info.id, since)) {
      const o = breakerOutcome(r);
      if (o === "healthy") healthy++;
      else if (o === "counted") counted++;
      if (r.state === "SUCCEEDED" && r.started_at !== null && r.finished_at !== null) {
        const ms = Date.parse(r.finished_at) - Date.parse(r.started_at);
        if (Number.isFinite(ms) && ms >= 0) durations.push(ms);
      }
    }
    const estimate = estimateCapacity(
      collectCapacityInputs(ledger, info, settings.windowSeconds, now),
      { windowSeconds: settings.windowSeconds, confidenceRuns: settings.confidenceRuns },
      now,
    );
    out[info.id] = {
      healthy,
      counted,
      median_ms: median(durations),
      capacity_score: estimate.capacity_score,
      capacity_confidence: estimate.confidence,
      session_bound: sessionProvider === null || sessionProvider === info.id,
    };
  }
  return out;
}

/** What {@link collectAffinityFacts} needs to know about the request. */
export interface AffinityQuestion {
  projectId: string | null;
  /** Canonical workspace path (the project key when there is no project). */
  workspace: string;
  /** False for `continue_task` (LLD §17.6). */
  applies: boolean;
  requiredProvider: string | null;
  admissible: readonly string[];
  decision: EligibilityDecision;
  scoreInputs: Readonly<Record<string, ScoreInputs>>;
  forcedReason?: AffinityFacts["forcedReason"];
}

/** LLD §17.6: read the project's row and the facts the reasons are detected from. Read-only. */
export function collectAffinityFacts(ledger: Ledger, q: AffinityQuestion, settings: AffinitySettings): AffinityFacts {
  const key = projectKey(q.projectId, q.workspace);
  const row = settings.enabled ? ledger.getProjectAffinity(key) : undefined;
  let latestOnAffine: AffinityFacts["latestOnAffine"] = null;
  if (row !== undefined) {
    const latest = ledger.latestProjectRunOnProvider(q.projectId, q.workspace, row.provider, row.updated_at);
    if (latest !== undefined) {
      const retryExhausted = ledger.listRunEvents(latest.id).some((e) => {
        if (e.type !== "retry_not_scheduled") return false;
        try {
          return (JSON.parse(e.payload_json) as { reason?: unknown }).reason === "attempts_exhausted";
        } catch {
          return false;
        }
      });
      latestOnAffine = { failureCode: latest.failure_code, retryExhausted };
    }
  }
  const affineInputs = row !== undefined ? q.scoreInputs[row.provider] : undefined;
  return {
    enabled: settings.enabled,
    applies: q.applies,
    projectKey: key,
    row:
      row !== undefined
        ? { provider: row.provider, model: row.model, reset_requested_at: row.reset_requested_at }
        : undefined,
    requiredProvider: q.requiredProvider,
    admissible: q.admissible,
    excluded: q.decision.excluded.map((e) => ({ provider: e.provider, codes: e.reasons.map((r) => r.code) })),
    latestOnAffine,
    estimate:
      affineInputs !== undefined
        ? { capacityScore: affineInputs.capacity_score, confidence: affineInputs.capacity_confidence }
        : null,
    thresholds: { lowWaterMark: settings.lowWaterMark, minConfidence: settings.minConfidence },
    ...(q.forcedReason !== undefined ? { forcedReason: q.forcedReason } : {}),
  };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : Math.round(((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

export interface RouteDecisionRequest {
  input: EligibilityInput;
  decision: EligibilityDecision;
  /** Providers selection may pick: the eligible set, or for `privileged` the admissible set (FRD V11). */
  admissible: readonly string[];
  preference: string | null;
  features: RouteFeatures | null;
  scoreInputs: Readonly<Record<string, ScoreInputs>>;
  weights: Readonly<Weights>;
  /** Appended to the rule in `selection.basis` (for example the privileged compile note). */
  basisSuffix?: string;
  /**
   * Builds the human `selection.basis` from the rule and suffix (continuations, failover); `selection.rule` is recorded
   * either way.
   */
  basis?: (selected: string) => string;
  project?: { id: string; excluded: readonly string[]; revision?: number };
  /** T5.6 (LLD §15.7 step 7): how a continuation runs; controller values only. */
  continuation?: { mode: "resume" | "handoff"; reason: string; from_provider: string; problem?: string };
  /** T7.5 (LLD §3.2, §17.6): the affinity step's facts; absent means no affinity object is recorded. */
  affinity?: AffinityFacts;
}

export interface RouteDecisionResult {
  provider: string | null;
  rule: SelectionBasis | null;
  basis: string;
  affinity: AffinityRecord | null;
  record: Omit<NewRouteDecision, "runId">;
}

/** LLD §17.3 selection and the §17.4 record. Pure. */
export function buildRouteDecision(req: RouteDecisionRequest): RouteDecisionResult {
  const { input, decision } = req;
  const required = input.requiredProvider ?? null;
  const plan = req.affinity !== undefined ? planAffinity(req.affinity) : null;
  const selection = selectRoute({
    candidateOrder: input.candidates,
    eligible: req.admissible,
    requiredProvider: required,
    preference: req.preference,
    affinityProvider: plan?.affinityProvider ?? null,
    excludeFromScore: plan?.excludeFromScore ?? null,
    scoreInputs: req.scoreInputs,
    weights: req.weights,
  });
  const scored = selection.basis === "score" || selection.basis === "configured_order";
  const affinity =
    req.affinity !== undefined && plan !== null ? affinityRecord(req.affinity, plan, selection.provider, scored) : null;
  const scoreOf = new Map(selection.scored.map((c) => [c.provider, c]));
  // The human basis keeps the M2 wording for a required provider (`provider_preference`, which V8 makes name it); the
  // rule beside it says `required_provider` (LLD §17.4 "As built").
  const label =
    selection.basis === "required_provider" && req.preference === required ? "provider_preference" : selection.basis;
  const selected = `${label ?? "none"}${req.basisSuffix ?? ""}`;
  const basis = req.basis ? req.basis(selected) : selected;
  const scoreInputs = Object.fromEntries(
    [...new Set(req.admissible)].sort().map((p) => [p, req.scoreInputs[p] ?? null]),
  );
  const features_json = JSON.stringify({
    schema_version: ROUTE_DECISION_SCHEMA_VERSION,
    trust_profile: input.trustProfile,
    client_max_profile: input.clientMaxProfile,
    platform: input.platform,
    required_provider: required,
    provider_preference: req.preference,
    requirements: input.requirements,
    candidate_order: [...input.candidates],
    admissible: [...req.admissible],
    route_features: req.features,
    score_inputs: scoreInputs,
  });
  const entry = (provider: string) => {
    const s = scoreOf.get(provider);
    return { score: s?.score ?? null, terms: s?.terms ?? null };
  };
  const candidates_json = JSON.stringify([
    ...decision.eligible.map((provider) => ({ provider, eligible: true, reasons: [], ...entry(provider) })),
    ...decision.excluded.map((e) => ({
      provider: e.provider,
      eligible: false,
      reasons: e.reasons,
      ...entry(e.provider),
    })),
  ]);
  const reasons = {
    outcome: decision.outcome,
    request_reason: decision.requestReason ?? null,
    ...(selection.provider !== null
      ? { selection: { provider: selection.provider, basis, rule: selection.basis } }
      : {}),
    ...(req.continuation !== undefined ? { continuation: req.continuation } : {}),
    ...(affinity !== null ? { affinity } : {}),
    ...(req.project !== undefined
      ? {
          project: {
            id: req.project.id,
            excluded_providers: [...req.project.excluded],
            ...(req.project.revision !== undefined ? { revision: req.project.revision } : {}),
          },
        }
      : {}),
  };
  return {
    provider: selection.provider,
    rule: selection.basis,
    basis,
    affinity,
    record: {
      features_json,
      weights_json: JSON.stringify(Object.fromEntries(SCORE_TERMS.map((t) => [t, req.weights[t]]))),
      candidates_json,
      selected_provider: selection.provider,
      reasons_json: JSON.stringify(reasons),
    },
  };
}

/**
 * T7.12 (FR-RTE-08, Q-90): record the model-pin outcome in the decision's `affinity` object (the record and
 * `reasons_json`). Pure; a decision without an affinity object is returned unchanged. Replay ignores the field: the
 * pin follows a held selection and never changes it.
 */
export function withModelPin(result: RouteDecisionResult, pin: ModelPinRecord): RouteDecisionResult {
  if (result.affinity === null) return result;
  const affinity = { ...result.affinity, model_pin: pin };
  const reasons = JSON.parse(result.record.reasons_json) as Record<string, unknown>;
  return {
    ...result,
    affinity,
    record: { ...result.record, reasons_json: JSON.stringify({ ...reasons, affinity }) },
  };
}

export interface ReplayResult {
  /** 1 for an M2 eligibility-only row (nothing to recompute), 2 for an M7 row. */
  schemaVersion: number;
  ok: boolean;
  differences: string[];
}

interface StoredFeatures {
  schema_version?: number;
  required_provider?: string | null;
  provider_preference?: string | null;
  candidate_order?: string[];
  admissible?: string[];
  score_inputs?: Record<string, ScoreInputs | null>;
}

/**
 * Re-run the LLD §17.3 selection on a stored row and compare (LLD §17.4). Reads nothing but the row; calls no model and
 * no provider. A row without `schema_version` 2 is an M2 eligibility-only row and replays trivially.
 */
export function replayRouteDecision(
  row: Pick<
    RouteDecisionRow,
    "features_json" | "weights_json" | "candidates_json" | "selected_provider" | "reasons_json"
  >,
): ReplayResult {
  const f = JSON.parse(row.features_json) as StoredFeatures;
  if (f.schema_version !== ROUTE_DECISION_SCHEMA_VERSION) return { schemaVersion: 1, ok: true, differences: [] };
  const differences: string[] = [];
  const weights = JSON.parse(row.weights_json ?? "null") as Weights | null;
  if (weights === null) return { schemaVersion: 2, ok: false, differences: ["weights_json missing"] };
  const reasons = JSON.parse(row.reasons_json) as {
    selection?: { provider?: string; rule?: string | null };
    affinity?: Partial<AffinityRecord>;
  };
  const affinity = reasons.affinity;
  const inputs: Record<string, ScoreInputs> = {};
  for (const [p, v] of Object.entries(f.score_inputs ?? {})) if (v !== null) inputs[p] = v;
  const selection = selectRoute({
    candidateOrder: f.candidate_order ?? [],
    eligible: f.admissible ?? [],
    requiredProvider: f.required_provider ?? null,
    preference: f.provider_preference ?? null,
    // A held affinity selected its provider before the score; the stored object says so (LLD §17.6).
    affinityProvider: affinity?.held === true ? (affinity.provider ?? null) : null,
    excludeFromScore: affinity?.excluded_from_score ?? null,
    scoreInputs: inputs,
    weights,
  });
  if (selection.provider !== row.selected_provider) {
    differences.push(`selected_provider: stored ${row.selected_provider}, replayed ${selection.provider}`);
  }
  if ((reasons.selection?.rule ?? null) !== selection.basis) {
    differences.push(`rule: stored ${reasons.selection?.rule ?? null}, replayed ${selection.basis}`);
  }
  const stored = JSON.parse(row.candidates_json) as { provider: string; score: number | null; terms: Terms | null }[];
  const storedOf = new Map(stored.map((c) => [c.provider, c]));
  for (const c of selection.scored) {
    const s = storedOf.get(c.provider);
    if (s?.score !== c.score) differences.push(`score ${c.provider}: stored ${s?.score}, replayed ${c.score}`);
    for (const t of SCORE_TERMS) {
      if (s?.terms?.[t] !== c.terms[t])
        differences.push(`term ${c.provider}.${t}: stored ${s?.terms?.[t]}, replayed ${c.terms[t]}`);
    }
  }
  return { schemaVersion: 2, ok: differences.length === 0, differences };
}
