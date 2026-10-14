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
}

export interface AffinityPlan {
  reason: AffinitySwitchReason | null;
  /** The provider affinity holds, for the selection step; null when there is none or a reason applies. */
  affinityProvider: string | null;
  /** The affine provider left out of the score (LLD §17.6), or null. */
  excludeFromScore: string | null;
}

/** LLD §3.2 step 3 and §17.6: the first matching reason, in the documented order, or null. */
export function affinityReason(f: AffinityFacts): AffinitySwitchReason | null {
  if (f.forcedReason !== undefined) return f.forcedReason;
  const row = f.row;
  if (row === undefined) return null;
  if (f.requiredProvider !== null && f.requiredProvider !== row.provider) return "user_request";
  if (row.reset_requested_at !== null) return "user_request";
  if (!f.admissible.includes(row.provider)) {
    const codes = f.excluded.find((e) => e.provider === row.provider)?.codes ?? [];
    return codes.includes("QUOTA_EXHAUSTED_KNOWN") ? "capacity_exhausted" : "ineligible";
  }
  if (f.latestOnAffine?.failureCode === "QUOTA_EXHAUSTED") return "capacity_exhausted";
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
    return "capacity_exhausted";
  }
  if (f.latestOnAffine?.retryExhausted === true) return "failed_after_retry";
  return null;
}

export function planAffinity(f: AffinityFacts): AffinityPlan {
  if (!f.enabled || !f.applies) return { reason: null, affinityProvider: null, excludeFromScore: null };
  const reason = affinityReason(f);
  const row = f.row;
  if (row === undefined) return { reason, affinityProvider: null, excludeFromScore: null };
  if (reason === null) return { reason, affinityProvider: row.provider, excludeFromScore: null };
  const exclude = reason === "capacity_exhausted" || reason === "failed_after_retry" ? row.provider : null;
  return { reason, affinityProvider: null, excludeFromScore: exclude };
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
  };
}
