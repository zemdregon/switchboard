/**
 * FR-RTE-03 route decisions (T7.2, LLD §17.4, ADR-0044 item 6): collect the per-candidate score inputs from the ledger,
 * run the stage-2 selection (`score.ts`) and serialise one self-contained `route_decision` row with
 * `features_json.schema_version` 2, so that {@link replayRouteDecision} can recompute the selection and every score from
 * that row alone. Collection reads the ledger; building and replaying are pure.
 *
 * T7.15 (LLD §17.7): a decision with a model group or explicit model (candidates are members) or with the `pacing` term
 * (a candidate's provider is in a configured subscription) is written as version 3. Anything else stays version 2,
 * byte for byte as before.
 */
import { breakerOutcome } from "../capacity/breaker.js";
import { collectCapacityInputs } from "../capacity/collect.js";
import { estimateCapacity } from "../capacity/estimate.js";
import type { PacingGateSettings } from "../capacity/pacing-gate.js";
import { bindingPacingWindow, pacingViews, projectKey } from "../capacity/projection.js";
import { capacityProviders } from "../capacity/providers.js";
import type { PacingSettings } from "../config/capacity.js";
import type { AffinitySettings, ResolvedConfig } from "../config/index.js";
import { DEFAULT_PACING_WEIGHT } from "../config/routing.js";
import type { Ledger, NewRouteDecision, RouteDecisionRow } from "../ledger/index.js";
import {
  type AffinityFacts,
  type AffinityRecord,
  affinityRecord,
  type ModelPinRecord,
  planAffinity,
} from "./affinity.js";
import {
  type EligibilityDecision,
  type EligibilityInput,
  pacingAdmission,
  pacingDeferredCandidates,
} from "./eligibility.js";
import type { RouteFeatures } from "./features.js";
import type { RouteGroup, RouteMember } from "./groups.js";
import {
  DEFAULT_WEIGHTS,
  pacingTerm,
  SCORE_TERMS,
  type ScoreInputs,
  type SelectionBasis,
  selectRoute,
  type Terms,
  type Weights,
} from "./score.js";

export const ROUTE_DECISION_SCHEMA_VERSION = 2;
/** T7.15 (LLD §17.7): a decision with members or with the `pacing` term. */
export const ROUTE_DECISION_SCHEMA_VERSION_GROUPS = 3;

type PacingMode = PacingSettings["mode"];

/** One subscription's stored pacing inputs (`features_json.pacing_inputs`, LLD §17.7): the binding window's figures. */
export interface PacingSubscriptionInputs {
  mode: PacingMode;
  T: number;
  B: number;
  binding_window: string | null;
  used: number | null;
  used_source: string;
  confidence: number;
  elapsed: number | null;
  allowance: number | null;
  defers: boolean;
  until: string | null;
}

/** What the `pacing` term is computed from; replay reads only these (never the ledger or the clock). */
export interface RoutePacingInputs {
  mode: PacingMode;
  subscriptions: Record<string, PacingSubscriptionInputs>;
  /** Per candidate provider, its subscription or null. */
  candidateSubscription: Record<string, string | null>;
}

/**
 * LLD §16.9 and §17.7: the pacing inputs for `providers` from the same figures `get_capacity` publishes (T6.14). Undefined
 * when no subscription is configured or none of `providers` is in one: the term is then left out and the decision stays
 * version 2. Read-only.
 */
export function collectPacingInputs(
  ledger: Ledger,
  settings: PacingGateSettings | undefined,
  providers: readonly string[],
  now: Date,
): RoutePacingInputs | undefined {
  if (settings === undefined || settings.subscriptions.length === 0) return undefined;
  const subOf = new Map<string, string>();
  for (const s of settings.subscriptions) for (const id of s.adapterIds) subOf.set(id, s.name);
  const ids = [...new Set(providers)].sort();
  if (!ids.some((p) => subOf.has(p))) return undefined;
  const views = pacingViews(ledger, { windowSeconds: 0, confidenceRuns: 0, ...settings }, now) ?? [];
  const wanted = new Set(ids.flatMap((p) => subOf.get(p) ?? []));
  const subscriptions: Record<string, PacingSubscriptionInputs> = {};
  for (const view of views) {
    if (!wanted.has(view.subscription)) continue;
    const w = bindingPacingWindow(view);
    const until = view.deferred_until;
    subscriptions[view.subscription] = {
      mode: settings.pacing.mode,
      T: settings.pacing.targetFraction,
      B: settings.pacing.burstFraction,
      binding_window: w?.id ?? null,
      used: w?.used_fraction.value ?? null,
      used_source: w?.used_fraction.source ?? "unknown",
      confidence: w?.used_fraction.confidence ?? 0,
      elapsed: w?.elapsed_fraction ?? null,
      allowance: w?.allowance ?? null,
      defers: until !== null && Date.parse(until) > now.getTime(),
      until: until !== null && Date.parse(until) > now.getTime() ? until : null,
    };
  }
  return {
    mode: settings.pacing.mode,
    subscriptions,
    candidateSubscription: Object.fromEntries(ids.map((p) => [p, subOf.get(p) ?? null])),
  };
}

/** The `pacing` term per provider from stored inputs (LLD §17.7). */
function pacingTerms(
  mode: string,
  subscriptions: Readonly<Record<string, { T: number; allowance: number | null }>>,
  candidateSubscription: Readonly<Record<string, string | null>>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(candidateSubscription).map(([p, sub]) => [
      p,
      pacingTerm(mode, sub === null ? null : subscriptions[sub]),
    ]),
  );
}

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
  /**
   * T7.15 (LLD §17.7): a group or explicit-model request. `input`, `decision` and `admissible` are then member-level
   * (`groupEligibility`): candidates are member keys; `scoreInputs` stays keyed by provider.
   */
  group?: RouteGroup;
  /** T7.15 (LLD §16.9, §17.7): the `pacing` term's inputs; absent, the term is left out. */
  pacing?: RoutePacingInputs;
}

export interface RouteDecisionResult {
  /** The selected provider (for a group request, the chosen member's provider). */
  provider: string | null;
  /** T7.15: the chosen member of a group or explicit-model request; null otherwise. */
  member: RouteMember | null;
  rule: SelectionBasis | null;
  basis: string;
  affinity: AffinityRecord | null;
  record: Omit<NewRouteDecision, "runId">;
}

/** LLD §17.3 selection and the §17.4 record (§17.7 version 3 with members or the `pacing` term). Pure. */
export function buildRouteDecision(req: RouteDecisionRequest): RouteDecisionResult {
  const { input, decision } = req;
  const required = input.requiredProvider ?? null;
  const group = req.group;
  const v3 = group !== undefined || req.pacing !== undefined;
  const providerOf =
    group !== undefined ? Object.fromEntries(group.members.map((m) => [m.key, m.provider])) : undefined;
  const prov = (c: string) => providerOf?.[c] ?? c;
  const memberOf = new Map((group?.members ?? []).map((m) => [m.key, m]));
  // T7.15 (LLD §17.7): the affinity step sees which admissible candidates the pacing gate defers.
  const deferredIds = pacingDeferredCandidates(input, req.admissible, providerOf);
  const facts =
    req.affinity !== undefined
      ? {
          ...req.affinity,
          ...(group !== undefined ? { members: group.members } : {}),
          ...(deferredIds.length > 0 ? { deferred: deferredIds } : {}),
        }
      : undefined;
  const plan = facts !== undefined ? planAffinity(facts) : null;
  // T6.8 (LLD §16.9): the pacing admission rule narrows what selection may pick. The narrowed set is stored as
  // `admissible`, so replay recomputes the same selection from the row alone. Undefined: built exactly as before.
  const pacing = pacingAdmission(input, req.admissible, plan?.affinityProvider ?? null, providerOf);
  const admissible = pacing?.pool ?? req.admissible;
  const deferredOf = new Map((pacing?.deferred ?? []).map((d) => [d.candidate ?? d.provider, d]));
  const weights: Weights =
    req.pacing !== undefined ? { ...req.weights, pacing: req.weights.pacing ?? DEFAULT_PACING_WEIGHT } : req.weights;
  const terms =
    req.pacing !== undefined
      ? pacingTerms(req.pacing.mode, req.pacing.subscriptions, req.pacing.candidateSubscription)
      : undefined;
  const selection = selectRoute({
    candidateOrder: input.candidates,
    eligible: admissible,
    requiredProvider: required,
    preference: req.preference,
    affinityProvider: plan?.affinityProvider ?? null,
    excludeFromScore: plan?.excludeFromScore ?? null,
    scoreInputs: req.scoreInputs,
    weights,
    ...(providerOf !== undefined ? { providerOf } : {}),
    ...(terms !== undefined ? { pacing: terms } : {}),
  });
  const provider = selection.provider !== null ? prov(selection.provider) : null;
  const member = selection.provider !== null ? (memberOf.get(selection.provider) ?? null) : null;
  const scored = selection.basis === "score" || selection.basis === "configured_order";
  const affinity =
    facts !== undefined && plan !== null ? affinityRecord(facts, plan, selection.provider, scored) : null;
  const scoreOf = new Map(selection.scored.map((c) => [c.provider, c]));
  // The human basis keeps the M2 wording for a required provider (`provider_preference`, which V8 makes name it); the
  // rule beside it says `required_provider` (LLD §17.4 "As built").
  const label =
    selection.basis === "required_provider" && req.preference === required ? "provider_preference" : selection.basis;
  const selected = `${label ?? "none"}${req.basisSuffix ?? ""}`;
  const basis = req.basis ? req.basis(selected) : selected;
  const scoreInputs = Object.fromEntries(
    [...new Set(admissible.map(prov))].sort().map((p) => [p, req.scoreInputs[p] ?? null]),
  );
  const features = {
    schema_version: v3 ? ROUTE_DECISION_SCHEMA_VERSION_GROUPS : ROUTE_DECISION_SCHEMA_VERSION,
    trust_profile: input.trustProfile,
    client_max_profile: input.clientMaxProfile,
    platform: input.platform,
    required_provider: required,
    provider_preference: req.preference,
    requirements: input.requirements,
    candidate_order: [...input.candidates],
    admissible: [...admissible],
    route_features: req.features,
    score_inputs: scoreInputs,
  };
  const features_json = JSON.stringify(
    v3
      ? {
          ...features,
          model_group: group?.name ?? null,
          requested_model: group?.requestedModel ?? null,
          members: (group?.members ?? []).map((m) => ({
            key: m.key,
            provider: m.provider,
            model: m.model,
            configured: m.configured,
            order: m.order,
          })),
          pacing_mode: req.pacing?.mode ?? null,
          pacing_inputs: req.pacing?.subscriptions ?? null,
          candidate_subscription: req.pacing?.candidateSubscription ?? null,
        }
      : features,
  );
  const factModel = new Map(input.facts.map((f) => [f.provider as string, f.model ?? null]));
  const entry = (candidate: string) => {
    const s = scoreOf.get(candidate);
    const d = deferredOf.get(candidate);
    return {
      score: s?.score ?? null,
      terms: s?.terms ?? null,
      ...(d !== undefined
        ? {
            pacing: {
              verdict: d.verdict,
              until: d.until,
              subscription: d.subscription,
              window: d.window,
              source: d.source,
            },
          }
        : {}),
      ...(v3
        ? {
            model: memberOf.get(candidate)?.model ?? factModel.get(candidate) ?? null,
            pacing_verdict: d !== undefined ? { verdict: d.verdict, until: d.until } : null,
          }
        : {}),
    };
  };
  // A group candidate is stored with its provider and its member key (LLD §17.7).
  const head = (candidate: string) =>
    group !== undefined ? { provider: prov(candidate), member: candidate } : { provider: candidate };
  const candidates_json = JSON.stringify([
    ...decision.eligible.map((c) => ({ ...head(c), eligible: true, reasons: [], ...entry(c) })),
    ...decision.excluded.map((e) => ({
      ...head(e.provider),
      eligible: false,
      reasons: e.reasons,
      ...entry(e.provider),
    })),
  ]);
  const reasons = {
    outcome: decision.outcome,
    request_reason: decision.requestReason ?? null,
    ...(provider !== null
      ? {
          selection: {
            provider,
            basis,
            rule: selection.basis,
            ...(member !== null ? { member: member.key, model: member.model } : {}),
          },
        }
      : {}),
    ...(req.continuation !== undefined ? { continuation: req.continuation } : {}),
    ...(affinity !== null ? { affinity } : {}),
    ...(pacing !== undefined
      ? {
          pacing: {
            deferred: pacing.deferred.map((d) => ({
              provider: d.provider,
              ...(d.candidate !== undefined ? { member: d.candidate } : {}),
              verdict: d.verdict,
              until: d.until,
            })),
            hold_until: pacing.holdUntil,
          },
        }
      : {}),
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
  const weightTerms = req.pacing !== undefined ? [...SCORE_TERMS, "pacing" as const] : SCORE_TERMS;
  return {
    provider,
    member,
    rule: selection.basis,
    basis,
    affinity,
    record: {
      features_json,
      weights_json: JSON.stringify(Object.fromEntries(weightTerms.map((t) => [t, weights[t]]))),
      candidates_json,
      selected_provider: provider,
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
  /** 1 for an M2 eligibility-only row (nothing to recompute), 2 for an M7 row, 3 for a T7.15 row (LLD §17.7). */
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
  members?: { key: string; provider: string }[];
  pacing_mode?: string | null;
  pacing_inputs?: Record<string, { T: number; allowance: number | null }> | null;
  candidate_subscription?: Record<string, string | null> | null;
}

/**
 * Re-run the LLD §17.3 selection on a stored row and compare (LLD §17.4). Reads nothing but the row; calls no model and
 * no provider. A row without `schema_version` 2 or 3 is an M2 eligibility-only row and replays trivially. Version 3
 * (T7.15, LLD §17.7) also maps members to providers and recomputes the `pacing` term from `pacing_inputs`.
 */
export function replayRouteDecision(
  row: Pick<
    RouteDecisionRow,
    "features_json" | "weights_json" | "candidates_json" | "selected_provider" | "reasons_json"
  >,
): ReplayResult {
  const f = JSON.parse(row.features_json) as StoredFeatures;
  const version = f.schema_version;
  if (version !== ROUTE_DECISION_SCHEMA_VERSION && version !== ROUTE_DECISION_SCHEMA_VERSION_GROUPS) {
    return { schemaVersion: 1, ok: true, differences: [] };
  }
  const differences: string[] = [];
  const weights = JSON.parse(row.weights_json ?? "null") as Weights | null;
  if (weights === null) return { schemaVersion: version, ok: false, differences: ["weights_json missing"] };
  const reasons = JSON.parse(row.reasons_json) as {
    selection?: { provider?: string; rule?: string | null; member?: string };
    affinity?: Partial<AffinityRecord>;
  };
  const affinity = reasons.affinity;
  const inputs: Record<string, ScoreInputs> = {};
  for (const [p, v] of Object.entries(f.score_inputs ?? {})) if (v !== null) inputs[p] = v;
  const v3 = version === ROUTE_DECISION_SCHEMA_VERSION_GROUPS;
  const members = v3 ? (f.members ?? []) : [];
  const providerOf = members.length > 0 ? Object.fromEntries(members.map((m) => [m.key, m.provider])) : undefined;
  const pacing =
    v3 && f.pacing_inputs != null && f.candidate_subscription != null
      ? pacingTerms(f.pacing_mode ?? "", f.pacing_inputs, f.candidate_subscription)
      : undefined;
  // A held affinity selected its candidate before the score; the stored object says so (LLD §17.6, §17.7).
  const affine = providerOf !== undefined ? (affinity?.member ?? null) : (affinity?.provider ?? null);
  const selection = selectRoute({
    candidateOrder: f.candidate_order ?? [],
    eligible: f.admissible ?? [],
    requiredProvider: f.required_provider ?? null,
    preference: f.provider_preference ?? null,
    affinityProvider: affinity?.held === true ? affine : null,
    excludeFromScore: affinity?.excluded_from_score ?? null,
    scoreInputs: inputs,
    weights,
    ...(providerOf !== undefined ? { providerOf } : {}),
    ...(pacing !== undefined ? { pacing } : {}),
  });
  const replayed = selection.provider !== null ? (providerOf?.[selection.provider] ?? selection.provider) : null;
  if (replayed !== row.selected_provider) {
    differences.push(`selected_provider: stored ${row.selected_provider}, replayed ${replayed}`);
  }
  if (providerOf !== undefined && (reasons.selection?.member ?? null) !== selection.provider) {
    differences.push(`member: stored ${reasons.selection?.member ?? null}, replayed ${selection.provider}`);
  }
  if ((reasons.selection?.rule ?? null) !== selection.basis) {
    differences.push(`rule: stored ${reasons.selection?.rule ?? null}, replayed ${selection.basis}`);
  }
  const stored = JSON.parse(row.candidates_json) as {
    provider: string;
    member?: string;
    score: number | null;
    terms: Terms | null;
  }[];
  const storedOf = new Map(stored.map((c) => [providerOf !== undefined ? (c.member ?? c.provider) : c.provider, c]));
  const terms = pacing !== undefined ? [...SCORE_TERMS, "pacing" as const] : SCORE_TERMS;
  for (const c of selection.scored) {
    const s = storedOf.get(c.provider);
    if (s?.score !== c.score) differences.push(`score ${c.provider}: stored ${s?.score}, replayed ${c.score}`);
    for (const t of terms) {
      if (s?.terms?.[t] !== c.terms[t])
        differences.push(`term ${c.provider}.${t}: stored ${s?.terms?.[t]}, replayed ${c.terms[t]}`);
    }
  }
  return { schemaVersion: version, ok: differences.length === 0, differences };
}
