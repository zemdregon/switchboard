/**
 * Subscription usage windows (M6, T6.13; FR-CAP-09, BR-50, BR-41, LLD §16.9, ADR-0055 items 5 to 7).
 *
 * A pure function of the resolved configuration, rows the caller read from the ledger and an injected clock: no I/O, no
 * randomness, no stored state, no migration. Nothing here names a provider's window, budget or reset: each comes from
 * a declared provider key or from the operator. Every figure carries its source (BR-50):
 *
 * - `provider_reported` only from a key declared in {@link USAGE_KEYS}, which is empty and frozen until a task wires a
 *   sourced key (T6.15), exactly as `REMAINING_KEYS` (LLD §16.2);
 * - `operator_declared` for a `fixed` reset (the budget is the operator's too, but the used share against it is an
 *   estimate);
 * - `controller_estimated` for a budget against Switchboard-observed usage, always `lower_bound: true`;
 * - otherwise `unknown`, which is never headroom.
 *
 * Only `provider_reported` usage rows are read; `inner_agent` and `controller_estimated` rows change nothing (BR-41).
 * No consumer is wired here: the projection block is T6.14, the gate T6.8 and the routing term T7.15.
 */

import type { PacingSettings, SubscriptionSettings, UsageWindowSettings } from "../config/capacity.js";
import type { UsageBudgetUnit } from "../config/schema.js";
import { reportedTokens } from "../control/budgets.js";

/** What a declared usage key carries (LLD §16.9 "Declared keys"). */
export type UsageKeyCarries = "used_fraction" | "remaining_fraction" | "reset_at";

/**
 * One declared key: where it is read (`usage_observation.metrics_json` or a `rate_limit` provider event's payload), the
 * key name, what it carries and the source document that shows it.
 */
export interface UsageKeyDeclaration {
  readonly origin: "usage_observation" | "rate_limit";
  readonly key: string;
  readonly carries: UsageKeyCarries;
  readonly source: string;
}

/**
 * Declared usage keys per adapter provider id. Empty on purpose: no key is wired yet (candidates are listed in LLD §16.9
 * and mapped by T6.15 with a source citation).
 */
export const USAGE_KEYS: Readonly<Record<string, readonly UsageKeyDeclaration[]>> = Object.freeze({});

/** Rows of the subscription's providers, as the caller read them; `provider` is the adapter id (as `run.provider`). */
export interface UsageWindowInputs {
  /** Runs that started a provider process (`run.started_at` set). */
  startedRuns: readonly { provider: string; startedAt: string }[];
  /** `usage_observation` rows; any `source` other than `provider_reported` is ignored (BR-41). */
  usage: readonly {
    provider: string;
    source: string;
    metrics: Readonly<Record<string, unknown>>;
    observedAt: string;
  }[];
  /** `rate_limit` provider events: the event payload and its time. */
  rateLimitSignals: readonly { provider: string; payload: Readonly<Record<string, unknown>>; observedAt: string }[];
}

export type ResetSource = "provider_reported" | "operator_declared";
export type UsedSource = "provider_reported" | "controller_estimated" | "unknown";
export type Pace = "ahead" | "on_pace" | "behind" | "unknown";

/** Printed with every `controller_estimated` figure (LLD §16.9). */
export const ESTIMATE_NOTE =
  "Switchboard-observed usage only; use of this subscription outside Switchboard is not seen";

export interface UsedFraction {
  value: number | null;
  source: UsedSource;
  confidence: number;
  /** `controller_estimated` only. */
  lower_bound?: true;
  basis?: UsageBudgetUnit;
  note?: string;
  /** `provider_reported` only: the declared key the value came from. */
  key?: string;
}

export interface UsageWindowFigures {
  id: string;
  length_seconds: number;
  reset_at: { at: string; source: ResetSource } | null;
  window_start: { at: string; source: ResetSource | "controller" } | null;
  used_fraction: UsedFraction;
  /** Null when the reset is unknown; 1 for a `rolling` window. */
  elapsed_fraction: number | null;
  allowance: number | null;
  pace: Pace;
}

export interface SubscriptionUsage {
  subscription: string;
  providers: string[];
  windows: UsageWindowFigures[];
}

/** LLD §16.9 floor of `1 - elapsed` in the allowance and the confidences of an estimate (Assumptions, Q-98). */
export const ALLOWANCE_EPSILON = 0.01;
export const ESTIMATE_CONFIDENCE_KNOWN_RESET = 0.8;
export const ESTIMATE_CONFIDENCE_ROLLING = 0.5;
/** Assumption (Delegated, T6.13): a reported share in a `rolling` window, whose reset is not reported, counts 0.5. */
export const REPORTED_CONFIDENCE_ROLLING = 0.5;

/** Reported cost keys summed for `reported_cost_usd` (Claude Code `total_cost_usd`, OpenCode `cost_usd`; first found). */
export const REPORTED_COST_KEYS: readonly string[] = Object.freeze(["total_cost_usd", "cost_usd"]);

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function reportedCost(metrics: Readonly<Record<string, unknown>>): number {
  for (const k of REPORTED_COST_KEYS) {
    const v = metrics[k];
    if (finite(v) && v >= 0) return v;
  }
  return 0;
}

interface Declared {
  at: number;
  value: number | string;
  key: string;
}

/** Values of declared keys carrying `carries`, from the subscription's providers' rows, oldest first. */
function declaredValues(
  sub: SubscriptionSettings,
  inputs: UsageWindowInputs,
  keys: Readonly<Record<string, readonly UsageKeyDeclaration[]>>,
  carries: UsageKeyCarries,
  nowMs: number,
): Declared[] {
  const out: Declared[] = [];
  const providers = new Set(sub.adapterIds);
  const take = (
    provider: string,
    origin: UsageKeyDeclaration["origin"],
    row: Readonly<Record<string, unknown>>,
    observedAt: string,
  ) => {
    const at = Date.parse(observedAt);
    if (!Number.isFinite(at) || at > nowMs) return;
    for (const d of keys[provider] ?? []) {
      if (d.origin !== origin || d.carries !== carries) continue;
      const v = row[d.key];
      if (finite(v) || typeof v === "string") out.push({ at, value: v, key: d.key });
    }
  };
  for (const u of inputs.usage) {
    if (u.source === "provider_reported" && providers.has(u.provider))
      take(u.provider, "usage_observation", u.metrics, u.observedAt);
  }
  for (const s of inputs.rateLimitSignals) {
    if (providers.has(s.provider)) take(s.provider, "rate_limit", s.payload, s.observedAt);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** `fixed`: the first `anchor + k × length` strictly after `now` (so `now` on a boundary starts a new window). */
export function nextFixedReset(anchorMs: number, lengthMs: number, nowMs: number): number {
  return anchorMs + (Math.floor((nowMs - anchorMs) / lengthMs) + 1) * lengthMs;
}

function windowFigures(
  sub: SubscriptionSettings,
  w: UsageWindowSettings,
  pacing: PacingSettings,
  inputs: UsageWindowInputs,
  nowMs: number,
  keys: Readonly<Record<string, readonly UsageKeyDeclaration[]>>,
): UsageWindowFigures {
  const lengthMs = w.lengthSeconds * 1000;
  const iso = (ms: number) => new Date(ms).toISOString();

  // reset_at and window_start.
  let resetMs: number | null = null;
  let resetSource: ResetSource | null = null;
  if (w.reset.kind === "fixed") {
    resetMs = nextFixedReset(Date.parse(w.reset.anchor), lengthMs, nowMs);
    resetSource = "operator_declared";
  } else if (w.reset.kind === "provider_reported") {
    for (const d of declaredValues(sub, inputs, keys, "reset_at", nowMs)) {
      const t = typeof d.value === "string" ? Date.parse(d.value) : Number.NaN;
      if (Number.isFinite(t) && t > nowMs && (resetMs === null || t > resetMs)) resetMs = t;
    }
    if (resetMs !== null) resetSource = "provider_reported";
  }
  const rolling = w.reset.kind === "rolling";
  let startMs: number | null = null;
  let window_start: UsageWindowFigures["window_start"] = null;
  if (resetMs !== null && resetSource !== null) {
    startMs = resetMs - lengthMs;
    window_start = { at: iso(startMs), source: resetSource };
  } else if (rolling) {
    startMs = nowMs - lengthMs;
    window_start = { at: iso(startMs), source: "controller" };
  }

  // used_fraction: a declared report first, then the budget estimate, else unknown.
  let used: UsedFraction = { value: null, source: "unknown", confidence: 0 };
  if (startMs !== null) {
    const from = startMs;
    const inWindow = (d: Declared) => d.at >= from;
    const reported = [
      ...declaredValues(sub, inputs, keys, "used_fraction", nowMs).filter(inWindow),
      ...declaredValues(sub, inputs, keys, "remaining_fraction", nowMs)
        .filter(inWindow)
        .map((d) => ({ ...d, value: finite(d.value) ? 1 - d.value : d.value })),
    ]
      .filter((d): d is Declared & { value: number } => finite(d.value))
      .sort((a, b) => a.at - b.at);
    const latest = reported.at(-1);
    if (latest !== undefined) {
      used = {
        value: round6(clamp01(latest.value)),
        source: "provider_reported",
        confidence: rolling ? REPORTED_CONFIDENCE_ROLLING : 1,
        key: latest.key,
      };
    } else if (w.budget !== null) {
      const providers = new Set(sub.adapterIds);
      const within = (t: string) => {
        const ms = Date.parse(t);
        return Number.isFinite(ms) && ms >= from && ms <= nowMs;
      };
      let observed = 0;
      if (w.budget.unit === "runs") {
        observed = inputs.startedRuns.filter((r) => providers.has(r.provider) && within(r.startedAt)).length;
      } else {
        for (const u of inputs.usage) {
          if (u.source !== "provider_reported" || !providers.has(u.provider) || !within(u.observedAt)) continue;
          observed +=
            w.budget.unit === "reported_tokens" ? reportedTokens(JSON.stringify(u.metrics)) : reportedCost(u.metrics);
        }
      }
      used = {
        value: round6(Math.min(1, observed / w.budget.value)),
        source: "controller_estimated",
        confidence: rolling ? ESTIMATE_CONFIDENCE_ROLLING : ESTIMATE_CONFIDENCE_KNOWN_RESET,
        lower_bound: true,
        basis: w.budget.unit,
        note: ESTIMATE_NOTE,
      };
    }
  }

  // elapsed, allowance, pace.
  const T = pacing.targetFraction;
  const B = pacing.burstFraction;
  const elapsed = rolling ? 1 : resetMs === null ? null : round6(clamp01(1 - (resetMs - nowMs) / lengthMs));
  let allowance: number | null = null;
  let pace: Pace = "unknown";
  if (used.value !== null && elapsed !== null) {
    allowance = round6(rolling ? T - used.value : (T - used.value) / Math.max(1 - elapsed, ALLOWANCE_EPSILON));
    const line = T * elapsed;
    pace = used.value > line + B ? "ahead" : used.value < line - B ? "behind" : "on_pace";
  }

  return {
    id: w.id,
    length_seconds: w.lengthSeconds,
    reset_at: resetMs === null || resetSource === null ? null : { at: iso(resetMs), source: resetSource },
    window_start,
    used_fraction: used,
    elapsed_fraction: elapsed,
    allowance,
    pace,
  };
}

/**
 * Figures for every configured subscription, in name order; `undefined` when none is configured, so a caller adds no
 * `pacing` output at all. `keys` defaults to {@link USAGE_KEYS} (tests pass a declaration to exercise the reported path).
 */
export function usageWindows(
  subscriptions: readonly SubscriptionSettings[] | undefined,
  pacing: PacingSettings | undefined,
  inputs: UsageWindowInputs,
  now: Date,
  keys: Readonly<Record<string, readonly UsageKeyDeclaration[]>> = USAGE_KEYS,
): SubscriptionUsage[] | undefined {
  if (subscriptions === undefined || subscriptions.length === 0 || pacing === undefined) return undefined;
  const nowMs = now.getTime();
  return subscriptions.map((sub) => ({
    subscription: sub.name,
    providers: [...sub.providers],
    windows: sub.windows.map((w) => windowFigures(sub, w, pacing, inputs, nowMs, keys)),
  }));
}
