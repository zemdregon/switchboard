/**
 * The one capacity projection behind `get_capacity`, `switchboard capacity` and `doctor` (M6; FR-MCP-02, FR-OPS-05,
 * FR-CAP-03, LLD §16.3, ADR-0043 item 6). Deterministic: the same ledger, providers, settings and clock give
 * byte-identical canonical JSON.
 *
 * T6.14 (FR-CAP-09, LLD §16.9): when subscriptions are configured, the same object carries a `pacing` array computed
 * from the T6.13 figures. The array is omitted otherwise, so an unconfigured projection stays byte-identical. The
 * gate verdict is shown here; the hold that acts on it is T6.8 and is not applied.
 */

import { createHash } from "node:crypto";
import type { PacingSettings, SubscriptionSettings } from "../config/capacity.js";
import type { PacingMode } from "../config/schema.js";
import type { Ledger } from "../ledger/index.js";
import { canonicalJson } from "../lifecycle/request.js";
import { type ProjectSwitchCounts, switchCounts } from "./cache.js";
import { type CapacityProviderInfo, collectCapacityInputs } from "./collect.js";
import { type EstimatorSettings, estimateCapacity, type ProviderCapacity } from "./estimate.js";
import {
  type Pace,
  type SubscriptionUsage,
  type UsageWindowFigures,
  type UsageWindowInputs,
  type UsedFraction,
  usageWindows,
} from "./usage-window.js";

/** Printed with every projection (FR-CAP-03). */
export const CAPACITY_NOTE =
  "capacity_score, confidence and throttle_risk are controller estimates, not provider-authoritative quota";

/** `gate` shows deferred or clear; `score` and `off` never defer (LLD §16.9). */
export type PacingVerdict = "deferred" | "clear" | "inactive";

/** One window of a subscription, the T6.13 figures plus whether this window defers. No `openAt` (T6.8 owns the hold). */
export interface PacingWindowView {
  id: string;
  length_seconds: number;
  reset_at: UsageWindowFigures["reset_at"];
  window_start: UsageWindowFigures["window_start"];
  used_fraction: UsedFraction;
  elapsed_fraction: number | null;
  allowance: number | null;
  pace: Pace;
  defers: boolean;
}

/** One subscription in the projection's `pacing` array (LLD §16.9 surfaces). */
export interface PacingSubscriptionView {
  subscription: string;
  providers: string[];
  mode: PacingMode;
  deferred_until: string | null;
  verdict: PacingVerdict;
  windows: PacingWindowView[];
}

export interface CapacityProjection {
  as_of: string;
  window_seconds: number;
  note: string;
  providers: ProviderCapacity[];
  /** T6.7 (FR-CAP-08, LLD §3.2): per-project kept versus switched provider and model, by reason, over the window. */
  affinity: AffinityCounts;
  /**
   * T6.14 (LLD §16.9). Present only when `usageWindows` returns figures. Absent — not `[]` — otherwise, so canonical
   * JSON of an unconfigured projection does not gain a key.
   */
  pacing?: PacingSubscriptionView[];
}

/** Estimator settings plus the optional subscription block (T6.13). Callers without it are unchanged. */
export interface ProjectionSettings extends EstimatorSettings {
  readonly subscriptions?: readonly SubscriptionSettings[];
  readonly pacing?: PacingSettings;
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

/**
 * Earliest instant the ledger helpers accept. Rate-limit resets and the open-run join are not bounded by the estimator
 * window: a declared reset can have been observed before the longest subscription window and still be in the future.
 */
const EPOCH = "1970-01-01T00:00:00.000Z";

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

function adapterIdsOf(subscriptions: readonly SubscriptionSettings[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const sub of subscriptions) {
    for (const id of sub.adapterIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function parseObject(json: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rows `usageWindows` reads. Terminal runs and provider-reported usage use the longest window as a lookback; the pure
 * function then keeps only what falls inside each window. Open runs are joined by id so `started_at` comes from the
 * open clock (`listStartedRunsSince` has the provider but only `created_at`, which is not a start).
 * `listRateLimitSignalsSince` returns `{ ts, reset_at }` only; `USAGE_KEYS` is empty, so that changes no figure today.
 */
function collectUsageInputs(
  ledger: Ledger,
  subscriptions: readonly SubscriptionSettings[],
  now: Date,
): UsageWindowInputs {
  const ids = adapterIdsOf(subscriptions);
  const wanted = new Set(ids);
  const lengths = subscriptions.flatMap((s) => s.windows.map((w) => w.lengthSeconds));
  const maxLength = lengths.length === 0 ? 0 : Math.max(...lengths);
  const since = new Date(now.getTime() - maxLength * 1000).toISOString();

  const started = new Map<string, { provider: string; startedAt: string }>();
  for (const provider of ids) {
    for (const row of ledger.listTerminalRunsForProviderSince(provider, since)) {
      if (row.started_at === null) continue;
      started.set(row.id, { provider, startedAt: row.started_at });
    }
  }

  const openStarted = new Map<string, string>();
  for (const clock of ledger.listOpenRunClocks()) {
    if (clock.started_at !== null) openStarted.set(clock.id, clock.started_at);
  }
  if (openStarted.size > 0) {
    for (const row of ledger.listStartedRunsSince(EPOCH)) {
      const startedAt = openStarted.get(row.id);
      if (startedAt === undefined || !wanted.has(row.provider) || started.has(row.id)) continue;
      started.set(row.id, { provider: row.provider, startedAt });
    }
  }

  const usage: {
    provider: string;
    source: string;
    metrics: Record<string, unknown>;
    observedAt: string;
  }[] = [];
  for (const provider of ids) {
    for (const row of ledger.listProviderReportedUsageSince(provider, since)) {
      const metrics = parseObject(row.metrics_json);
      if (metrics === undefined) continue;
      usage.push({ provider, source: "provider_reported", metrics, observedAt: row.observed_at });
    }
  }

  const rateLimitSignals: {
    provider: string;
    payload: Record<string, unknown>;
    observedAt: string;
  }[] = [];
  for (const provider of ids) {
    for (const row of ledger.listRateLimitSignalsSince(provider, EPOCH)) {
      if (row.reset_at === null) continue;
      rateLimitSignals.push({ provider, payload: { reset_at: row.reset_at }, observedAt: row.ts });
    }
  }
  return { startedRuns: [...started.values()], usage, rateLimitSignals };
}

/**
 * Gate-open time in ms, from the published T6.13 figures (already rounded). Null when the window does not defer:
 * mode other than `gate`, unknown reset or used or elapsed, confidence below `min_confidence`, or used under
 * `min(T, T × elapsed + B)`. The instant is the earlier of `reset_at` and `window_start + length × (used − B) / T`,
 * rounded to the millisecond.
 */
export function gateOpenMs(w: UsageWindowFigures, pacing: PacingSettings): number | null {
  if (pacing.mode !== "gate") return null;
  const used = w.used_fraction.value;
  const elapsed = w.elapsed_fraction;
  if (w.reset_at === null || w.window_start === null || used === null || elapsed === null) return null;
  if (w.used_fraction.confidence < pacing.minConfidence) return null;
  const T = pacing.targetFraction;
  const B = pacing.burstFraction;
  if (!(T > 0) || used < Math.min(T, T * elapsed + B)) return null;
  const startMs = Date.parse(w.window_start.at);
  const resetMs = Date.parse(w.reset_at.at);
  if (!Number.isFinite(startMs) || !Number.isFinite(resetMs)) return null;
  const formula = startMs + w.length_seconds * 1000 * ((used - B) / T);
  const open = Math.round(Math.min(resetMs, formula));
  return Number.isFinite(open) ? open : null;
}

function toView(usage: SubscriptionUsage, pacing: PacingSettings): PacingSubscriptionView {
  const opens: number[] = [];
  const windows: PacingWindowView[] = usage.windows.map((w) => {
    const open = gateOpenMs(w, pacing);
    if (open !== null) opens.push(open);
    return { ...w, defers: open !== null };
  });
  const gating = pacing.mode === "gate" && opens.length > 0;
  let verdict: PacingVerdict = "clear";
  if (pacing.mode !== "gate") verdict = "inactive";
  else if (gating) verdict = "deferred";
  return {
    subscription: usage.subscription,
    providers: [...usage.providers],
    mode: pacing.mode,
    deferred_until: gating ? new Date(Math.max(...opens)).toISOString() : null,
    verdict,
    windows,
  };
}

export function pacingViews(
  ledger: Ledger,
  settings: ProjectionSettings,
  now: Date,
): PacingSubscriptionView[] | undefined {
  const { subscriptions, pacing } = settings;
  if (subscriptions === undefined || subscriptions.length === 0 || pacing === undefined) return undefined;
  const usage = usageWindows(subscriptions, pacing, collectUsageInputs(ledger, subscriptions, now), now);
  if (usage === undefined) return undefined;
  return usage.map((u) => toView(u, pacing));
}

/**
 * The binding window is the one with the smallest non-null allowance; if every allowance is null, the first window.
 * `doctor` prints one line from it (LLD §16.9).
 */
export function bindingPacingWindow(sub: PacingSubscriptionView): PacingWindowView | undefined {
  let best: PacingWindowView | undefined;
  for (const w of sub.windows) {
    if (w.allowance === null) continue;
    if (best === undefined || best.allowance === null || w.allowance < best.allowance) best = w;
  }
  return best ?? sub.windows[0];
}

/**
 * Providers are listed in the order given (the caller passes registry order). `clientId` limits the `affinity` block to
 * that MCP client's own runs (least privilege: project ids of other clients are not shown); the operator CLI passes
 * none and sees every project. Provider-level figures are the same for every caller. `pacing` is not filtered by the
 * provider argument: it is one entry per configured subscription.
 */
export function capacityProjection(
  ledger: Ledger,
  providers: readonly CapacityProviderInfo[],
  settings: ProjectionSettings,
  now: Date,
  clientId?: string,
): CapacityProjection {
  const pacing = pacingViews(ledger, settings, now);
  return {
    as_of: now.toISOString(),
    window_seconds: settings.windowSeconds,
    note: CAPACITY_NOTE,
    providers: providers.map((p) =>
      estimateCapacity(collectCapacityInputs(ledger, p, settings.windowSeconds, now), settings, now),
    ),
    affinity: affinityCounts(ledger, new Date(now.getTime() - settings.windowSeconds * 1000).toISOString(), clientId),
    ...(pacing !== undefined ? { pacing } : {}),
  };
}

/** Canonical JSON of a projection (sorted keys, LLD §10), for byte comparisons and `--json`. */
export function capacityJson(projection: CapacityProjection): string {
  return canonicalJson(projection);
}
