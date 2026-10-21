/**
 * Provider-reported usage windows per provider (ADR-0088; FR-CAP-15, BR-50, LLD §16.12).
 *
 * A pure function of the rows the collector read and a clock. It works for any provider from its declarations in
 * {@link USAGE_KEYS} that name a window: for each such window it reads the rows that hold the declared used (or
 * remaining) share, observed no earlier than one window length ago, and takes the reset from the same row. A row is
 * stored when its run ends, so concurrent runs can store an older reading after a newer one; the row kept is therefore
 * the one with the latest reported reset (the current window), then the largest used share (usage within one window
 * only grows), then the newest. A window whose reported reset has passed is left out, because its share belongs to a
 * window that has ended. Nothing is estimated, summed or defaulted: no row means no window, and no window means no
 * report. The result has the ADR-0079 `ProviderUsageReport` shape, so it appears as the provider's `provider_usage`;
 * its `observed_at` is the oldest reading among its windows (plan, limit flags and credits are not in run output).
 */

import type { ProviderUsageReport, ProviderUsageWindow } from "../adapters/provider-usage.js";
import { USAGE_KEYS, type UsageKeyDeclaration } from "./usage-window.js";

/** The ADR-0079 `method` of a report built from recorded run output (no CLI is started for it). */
export const RECORDED_USAGE_METHOD = "recorded run output (declared usage keys)";

export interface ReportedUsageRow {
  metrics: Readonly<Record<string, unknown>>;
  observedAt: string;
}

/** Rows read per declared share key, newest first (Assumption: enough to cover the runs that overlap the newest). */
export const REPORTED_USAGE_ROWS = 20;

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const finite01 = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** Declared share keys of `provider` that name a window: the keys the collector asks the ledger for. */
export function reportedShareKeys(
  provider: string,
  keys: Readonly<Record<string, readonly UsageKeyDeclaration[]>> = USAGE_KEYS,
): { key: string; lengthSeconds: number }[] {
  const out: { key: string; lengthSeconds: number }[] = [];
  for (const d of keys[provider] ?? []) {
    if (d.origin === "usage_observation" && d.window !== undefined && d.carries !== "reset_at") {
      out.push({ key: d.key, lengthSeconds: d.window.lengthSeconds });
    }
  }
  return out;
}

/** The provider's reported windows in declaration order, as an ADR-0079 report; `undefined` when none is current. */
export function reportedUsage(
  provider: string,
  rows: readonly ReportedUsageRow[],
  now: Date,
  keys: Readonly<Record<string, readonly UsageKeyDeclaration[]>> = USAGE_KEYS,
): ProviderUsageReport | undefined {
  const nowMs = now.getTime();
  const declared = (keys[provider] ?? []).filter((d) => d.origin === "usage_observation" && d.window !== undefined);
  const windows: ProviderUsageWindow[] = [];
  let oldest = Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  for (const d of declared) {
    const w = d.window;
    if (w === undefined || seen.has(w.id) || (d.carries !== "used_fraction" && d.carries !== "remaining_fraction")) {
      continue;
    }
    const resetKey = declared.find((r) => r.carries === "reset_at" && r.window?.id === w.id)?.key;
    // A reset that is absent or unparsable ranks below any reported one.
    let best: { at: number; resetMs: number; used: number } | undefined;
    for (const row of rows) {
      const at = Date.parse(row.observedAt);
      if (!Number.isFinite(at) || at > nowMs || at < nowMs - w.lengthSeconds * 1000) continue;
      const v = row.metrics[d.key];
      if (!finite01(v)) continue;
      const resetRaw = resetKey === undefined ? undefined : row.metrics[resetKey];
      const parsed = typeof resetRaw === "string" ? Date.parse(resetRaw) : Number.NaN;
      const resetMs = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
      const used = d.carries === "used_fraction" ? v : 1 - v;
      if (
        best === undefined ||
        resetMs > best.resetMs ||
        (resetMs === best.resetMs && (used > best.used || (used === best.used && at > best.at)))
      ) {
        best = { at, resetMs, used };
      }
    }
    if (best === undefined || (Number.isFinite(best.resetMs) && best.resetMs <= nowMs)) continue;
    const { used, resetMs } = best;
    seen.add(w.id);
    oldest = Math.min(oldest, best.at);
    windows.push({
      id: w.id,
      limit_id: null,
      window_seconds: w.lengthSeconds,
      used_fraction: round6(used),
      remaining_fraction: round6(1 - used),
      resets_at: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
    });
  }
  if (windows.length === 0) return undefined;
  return {
    provider,
    source: "provider_reported",
    observed_at: new Date(oldest).toISOString(),
    method: RECORDED_USAGE_METHOD,
    plan: null,
    limit_reached: null,
    limit_reached_type: null,
    windows,
    credits: null,
  };
}
