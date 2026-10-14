/**
 * The one capacity projection behind `get_capacity`, `switchboard capacity` and `doctor` (M6; FR-MCP-02, FR-OPS-05,
 * FR-CAP-03, LLD §16.3, ADR-0043 item 6). Deterministic: the same ledger, providers, settings and clock give
 * byte-identical canonical JSON.
 */

import { createHash } from "node:crypto";
import type { Ledger } from "../ledger/index.js";
import { canonicalJson } from "../lifecycle/request.js";
import { type ProjectSwitchCounts, switchCounts } from "./cache.js";
import { type CapacityProviderInfo, collectCapacityInputs } from "./collect.js";
import { type EstimatorSettings, estimateCapacity, type ProviderCapacity } from "./estimate.js";

/** Printed with every projection (FR-CAP-03). */
export const CAPACITY_NOTE =
  "capacity_score, confidence and throttle_risk are controller estimates, not provider-authoritative quota";

export interface CapacityProjection {
  as_of: string;
  window_seconds: number;
  note: string;
  providers: ProviderCapacity[];
  /** T6.7 (FR-CAP-08, LLD §3.2): per-project kept versus switched provider and model, by reason, over the window. */
  affinity: AffinityCounts;
}

export interface AffinityCounts {
  source: "controller";
  note: string;
  projects: ProjectSwitchCounts[];
  /** True when more than {@link MAX_AFFINITY_PROJECTS} projects had runs in the window (the rest are left out). */
  truncated: boolean;
}

/** Bound on the projects listed (Assumption, keeps the answer small); sorted by project key. */
export const MAX_AFFINITY_PROJECTS = 100;
export const AFFINITY_NOTE =
  "counts of runs that kept or switched provider and model; evidence for the operator, says nothing about provider caches";

/** LLD §3.2 project key: the project id, or `ws:` and the SHA-256 of the canonical workspace path. */
export function projectKey(projectId: string | null, workspace: string): string {
  return projectId ?? `ws:${createHash("sha256").update(workspace).digest("hex")}`;
}

function affinityCounts(ledger: Ledger, sinceIso: string, clientId: string | undefined): AffinityCounts {
  const runs = ledger.listStartedRunsSince(sinceIso, clientId).map((r) => {
    let workspace = "";
    try {
      workspace = String((JSON.parse(r.request_json) as { workspace?: unknown }).workspace ?? "");
    } catch {
      workspace = "";
    }
    let switchReason: string | null = null;
    const decision = ledger.getRouteDecision(r.id);
    if (decision !== undefined) {
      try {
        const reasons = JSON.parse(decision.reasons_json) as { affinity?: { affinity_switch_reason?: unknown } };
        const v = reasons.affinity?.affinity_switch_reason;
        switchReason = typeof v === "string" ? v : null;
      } catch {
        switchReason = null;
      }
    }
    return { projectKey: projectKey(r.project_id, workspace), provider: r.provider, model: r.model, switchReason };
  });
  const projects = switchCounts(runs);
  return {
    source: "controller",
    note: AFFINITY_NOTE,
    projects: projects.slice(0, MAX_AFFINITY_PROJECTS),
    truncated: projects.length > MAX_AFFINITY_PROJECTS,
  };
}

/**
 * Providers are listed in the order given (the caller passes registry order). `clientId` limits the `affinity` block to
 * that MCP client's own runs (least privilege: project ids of other clients are not shown); the operator CLI passes
 * none and sees every project. Provider-level figures are the same for every caller.
 */
export function capacityProjection(
  ledger: Ledger,
  providers: readonly CapacityProviderInfo[],
  settings: EstimatorSettings,
  now: Date,
  clientId?: string,
): CapacityProjection {
  return {
    as_of: now.toISOString(),
    window_seconds: settings.windowSeconds,
    note: CAPACITY_NOTE,
    providers: providers.map((p) =>
      estimateCapacity(collectCapacityInputs(ledger, p, settings.windowSeconds, now), settings, now),
    ),
    affinity: affinityCounts(ledger, new Date(now.getTime() - settings.windowSeconds * 1000).toISOString(), clientId),
  };
}

/** Canonical JSON of a projection (sorted keys, LLD §10), for byte comparisons and `--json`. */
export function capacityJson(projection: CapacityProjection): string {
  return canonicalJson(projection);
}
