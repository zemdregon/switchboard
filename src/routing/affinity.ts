/**
 * Provider affinity step (T7.5; FR-RTE-06, FR-RTE-07, BR-45, LLD §3.2, §17.6, ADR-0032, ADR-0044 item 8). Pure: given
 * the project's affinity row and facts the caller read from the ledger, decide whether a reason from the closed list
 * applies and, if none does, which provider affinity holds. Scores, cost and load are never inputs here, so they can
 * never be a reason. Fail closed: when unsure, affinity holds (the project stays where it is).
 */
import type { AffinitySwitchReason } from "../ledger/index.js";

/** The `reasons_json.affinity` object (LLD §3.2 plus `applies` and `excluded_from_score`, §17.6). */
export interface AffinityRecord {
  enabled: boolean;
  project_key: string;
  /** The project's affine provider and model before this decision, or null. */
  provider: string | null;
  model: string | null;
  /** The affine provider was chosen. */
  held: boolean;
  affinity_switch_reason: AffinitySwitchReason | null;
  /** The FR-RTE-02 score ranked the candidates in this decision. */
  scored: boolean;
  /** False for a continuation (FR-SES-03 governs) or when affinity is disabled: the row is not moved by this run. */
  applies: boolean;
  excluded_from_score: string | null;
  /**
   * T7.15 (LLD §17.7): `pacing_gate` when the reason is `capacity_exhausted` because the pacing gate deferred the affine
   * candidate while an undeferred one remained. Absent otherwise.
   */
  detail?: "pacing_gate";
  /**
   * T7.15: on a group or explicit-model decision, the affine `<provider>/<model>` candidate among the members, or null
   * when the request names no member with the row's provider and model. Absent on a provider decision.
   */
  member?: string | null;
  /** T7.12 (FR-RTE-08, Q-90): present on a held decision only; whether the remembered model was pinned, and why not. */
  model_pin?: ModelPinRecord;
}

/**
 * Why a held decision did or did not pin the project's remembered model (T7.12). `pinned`: passed to `compile`;
 * otherwise the run keeps the adapter default: `no_remembered_model` (the row's model is null), `adapter_not_declared`
 * (the adapter does not declare that its reported model id is accepted by its model flag), `model_refused` (the model
 * registry or the adapter's `compile` refused the id; the provider still holds, fail closed), `privileged` (a
 * `privileged` run is never pinned, so pinning cannot change what an approved scope or a bypass run does).
 */
export type ModelPinOutcome =
  | "pinned"
  | "no_remembered_model"
  | "adapter_not_declared"
  | "model_refused"
  | "privileged";

export interface ModelPinRecord {
  /** The model passed to `compile`, or null for the adapter default. */
  model: string | null;
  outcome: ModelPinOutcome;
  /** For `model_refused`: the stage-1 reason code that refused it. */
  refused_code?: string;
}

/**
 * T7.12 step 1 (pure): the model a held decision would pin, before the registry and compile check. Null when the
 * decision did not hold (the switch reason already records why; a new provider runs with its adapter default).
 */
export function planModelPin(
  record: AffinityRecord | null,
  adapterAccepts: boolean,
  privileged: boolean,
): { candidate: string; outcome: "pinned" } | { candidate: null; outcome: ModelPinOutcome } | null {
  if (record === null || !record.applies || !record.held) return null;
  if (record.model === null) return { candidate: null, outcome: "no_remembered_model" };
  if (privileged) return { candidate: null, outcome: "privileged" };
  if (!adapterAccepts) return { candidate: null, outcome: "adapter_not_declared" };
  return { candidate: record.model, outcome: "pinned" };
}

export interface AffinityFacts {
  enabled: boolean;
  /** False for `continue_task` decisions (LLD §17.6). */
  applies: boolean;
  projectKey: string;
  row: { provider: string; model: string | null; reset_requested_at: string | null } | undefined;
  /** The caller's `require_provider` target (BR-2), or null. */
  requiredProvider: string | null;
  /** Providers stage 1 admitted. */
  admissible: readonly string[];
  /** Providers stage 1 removed, with their reason codes. */
  excluded: readonly { provider: string; codes: readonly string[] }[];
  /** The project's latest terminal run on the affine provider after the row was last written, if any. */
  latestOnAffine: { failureCode: string | null; retryExhausted: boolean } | null;
  /** The FR-CAP-02 estimate of the affine provider, when it is admissible. */
  estimate: { capacityScore: number | null; confidence: number } | null;
  thresholds: { lowWaterMark: number | null; minConfidence: number | null };
  /** A reason the caller already knows (the quota failover successor: `capacity_exhausted`). */
  forcedReason?: AffinitySwitchReason;
  /**
   * T7.15 (LLD §17.7): the members of a group or explicit-model request. With members, candidates (`admissible`,
   * `excluded`) are member keys, and the affine candidate is the member with the row's provider and model (its
   * configured or resolved id); none is `user_request`. Absent: candidates are providers.
   */
  members?: readonly AffinityMember[];
  /** T7.15 (LLD §16.9): admissible candidates whose subscription the pacing gate defers. Absent: none. */
  deferred?: readonly string[];
}

/** A group member as the affinity step sees it. */
export interface AffinityMember {
  key: string;
  provider: string;
  /** The id the model registry resolved it to (the configured id when unrestricted or not resolved). */
  model: string;
  /** The model id as configured or requested. */
  configured: string;
}

export interface AffinityPlan {
  reason: AffinitySwitchReason | null;
  /** The provider affinity holds, for the selection step; null when there is none or a reason applies. */
  affinityProvider: string | null;
  /** The affine provider left out of the score (LLD §17.6), or null. With members, candidate ids (member keys). */
  excludeFromScore: string | null;
  /** T7.15: `pacing_gate` when the pacing gate gave the `capacity_exhausted` reason. */
  detail?: "pacing_gate";
}

/** T7.15: the affine candidate id: the row's provider, or with members the member with the row's provider and model. */
export function affineCandidate(f: Pick<AffinityFacts, "row" | "members">): string | null {
  const row = f.row;
  if (row === undefined) return null;
  if (f.members === undefined) return row.provider;
  if (row.model === null) return null;
  const m = f.members.find((x) => x.provider === row.provider && (x.model === row.model || x.configured === row.model));
  return m?.key ?? null;
}

/** LLD §3.2 step 3 and §17.6: the first matching reason, in the documented order, or null. */
export function affinityReason(f: AffinityFacts): AffinitySwitchReason | null {
  return reasonOf(f).reason;
}

function reasonOf(f: AffinityFacts): { reason: AffinitySwitchReason | null; detail?: "pacing_gate" } {
  if (f.forcedReason !== undefined) return { reason: f.forcedReason };
  const row = f.row;
  if (row === undefined) return { reason: null };
  if (f.requiredProvider !== null && f.requiredProvider !== row.provider) return { reason: "user_request" };
  if (row.reset_requested_at !== null) return { reason: "user_request" };
  // LLD §17.7: a group (or explicit model) without the affine pair is the caller's own choice.
  const affine = affineCandidate(f);
  if (affine === null) return { reason: "user_request" };
  if (!f.admissible.includes(affine)) {
    const codes = f.excluded.find((e) => e.provider === affine)?.codes ?? [];
    return { reason: codes.includes("QUOTA_EXHAUSTED_KNOWN") ? "capacity_exhausted" : "ineligible" };
  }
  // LLD §17.7: the pacing gate defers the affine candidate while an undeferred one remains. When every candidate is
  // deferred, affinity holds and the run waits for the affine candidate's gate (§16.9).
  const deferred = f.deferred ?? [];
  if (deferred.includes(affine) && f.admissible.some((c) => !deferred.includes(c))) {
    return { reason: "capacity_exhausted", detail: "pacing_gate" };
  }
  if (f.latestOnAffine?.failureCode === "QUOTA_EXHAUSTED") return { reason: "capacity_exhausted" };
  const { lowWaterMark, minConfidence } = f.thresholds;
  const e = f.estimate;
  if (
    lowWaterMark !== null &&
    minConfidence !== null &&
    e !== null &&
    e.capacityScore !== null &&
    e.confidence >= minConfidence &&
    e.capacityScore <= lowWaterMark
  ) {
    return { reason: "capacity_exhausted" };
  }
  if (f.latestOnAffine?.retryExhausted === true) return { reason: "failed_after_retry" };
  return { reason: null };
}

export function planAffinity(f: AffinityFacts): AffinityPlan {
  if (!f.enabled || !f.applies) return { reason: null, affinityProvider: null, excludeFromScore: null };
  const { reason, detail } = reasonOf(f);
  const affine = affineCandidate(f);
  if (f.row === undefined) return { reason, affinityProvider: null, excludeFromScore: null };
  if (reason === null) return { reason, affinityProvider: affine, excludeFromScore: null };
  const exclude = reason === "capacity_exhausted" || reason === "failed_after_retry" ? affine : null;
  return { reason, affinityProvider: null, excludeFromScore: exclude, ...(detail !== undefined ? { detail } : {}) };
}

/** The record stored with the decision, once the selection is known. */
export function affinityRecord(
  f: AffinityFacts,
  plan: AffinityPlan,
  selected: string | null,
  scored: boolean,
): AffinityRecord {
  const active = f.enabled && f.applies;
  return {
    enabled: f.enabled,
    project_key: f.projectKey,
    provider: f.enabled ? (f.row?.provider ?? null) : null,
    model: f.enabled ? (f.row?.model ?? null) : null,
    held: active && plan.affinityProvider !== null && selected === plan.affinityProvider,
    affinity_switch_reason: active ? plan.reason : null,
    scored,
    applies: active,
    excluded_from_score: active ? plan.excludeFromScore : null,
    ...(active && plan.detail !== undefined ? { detail: plan.detail } : {}),
    ...(f.members !== undefined ? { member: f.enabled ? affineCandidate(f) : null } : {}),
  };
}
