/**
 * Provider-reported usage windows per provider (ADR-0079; FR-CAP-13, BR-50, LLD §16.10).
 *
 * A pure function of the rows the collector read and a clock. It works for any provider from its declarations in
 * {@link USAGE_KEYS} that name a window: for each such window it takes the newest row that holds the declared used (or
 * remaining) share, observed no earlier than one window length ago, and the reset from that same row. A window whose
 * reported reset has passed is left out, because the share it reported belongs to a window that has ended. Nothing is
 * estimated, summed or defaulted: no row means no window, and no window means no block.
 */

import { USAGE_KEYS, type UsageKeyDeclaration } from "./usage-window.js";

export interface ReportedUsageWindow {
  /** The provider's own window name (e.g. Claude Code's `five_hour`). */
  id: string;
  length_seconds: number;
  used_fraction: number;
  remaining_fraction: number;
  /** Null when the provider reported no reset with the share. */
  resets_at: string | null;
  observed_at: string;
  /** The declared key the share came from. */
  key: string;
}

export interface ReportedUsage {
  source: "provider_reported";
  windows: ReportedUsageWindow[];
}

export interface ReportedUsageRow {
  metrics: Readonly<Record<string, unknown>>;
  observedAt: string;
}

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

/** The provider's reported windows in declaration order, or `undefined` when none is current. */
export function reportedUsage(
  provider: string,
  rows: readonly ReportedUsageRow[],
  now: Date,
  keys: Readonly<Record<string, readonly UsageKeyDeclaration[]>> = USAGE_KEYS,
): ReportedUsage | undefined {
  const nowMs = now.getTime();
  const declared = (keys[provider] ?? []).filter((d) => d.origin === "usage_observation" && d.window !== undefined);
  const windows: ReportedUsageWindow[] = [];
  const seen = new Set<string>();
  for (const d of declared) {
    const w = d.window;
    if (w === undefined || seen.has(w.id) || (d.carries !== "used_fraction" && d.carries !== "remaining_fraction")) {
      continue;
    }
    const resetKey = declared.find((r) => r.carries === "reset_at" && r.window?.id === w.id)?.key;
    let best: { at: number; row: ReportedUsageRow; share: number } | undefined;
    for (const row of rows) {
      const at = Date.parse(row.observedAt);
      if (!Number.isFinite(at) || at > nowMs || at < nowMs - w.lengthSeconds * 1000) continue;
      const v = row.metrics[d.key];
      if (!finite01(v)) continue;
      if (best === undefined || at > best.at) best = { at, row, share: v };
    }
    if (best === undefined) continue;
    const resetRaw = resetKey === undefined ? undefined : best.row.metrics[resetKey];
    const resetMs = typeof resetRaw === "string" ? Date.parse(resetRaw) : Number.NaN;
    if (Number.isFinite(resetMs) && resetMs <= nowMs) continue;
    const used = d.carries === "used_fraction" ? best.share : 1 - best.share;
    seen.add(w.id);
    windows.push({
      id: w.id,
      length_seconds: w.lengthSeconds,
      used_fraction: round6(used),
      remaining_fraction: round6(1 - used),
      resets_at: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
      observed_at: new Date(best.at).toISOString(),
      key: d.key,
    });
  }
  return windows.length === 0 ? undefined : { source: "provider_reported", windows };
}
