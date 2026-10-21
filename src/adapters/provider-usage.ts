/**
 * Provider-reported usage and limits (ADR-0079, FR-CAP-13, BR-50, LLD §16.10). The shapes an adapter's optional
 * `readProviderUsage` returns: the quota windows, plan and credits the provider's own CLI reports for the signed-in
 * account, read through that CLI (which uses its own login; Switchboard reads no credential, ADR-0003). Nothing here is
 * a Switchboard estimate: a figure the provider did not report is absent or null, never computed.
 */

/** One quota window as the provider reported it. Fractions are in [0, 1]; `remaining_fraction` is `1 - used`. */
export interface ProviderUsageWindow {
  /** The provider's own window name (Codex: `primary`, `secondary`), prefixed `<limit_id>:` for a non-default bucket. */
  id: string;
  /** The provider's metered bucket id when it names one (Codex `limitId`, e.g. `codex`); null otherwise. */
  limit_id: string | null;
  window_seconds: number | null;
  used_fraction: number;
  remaining_fraction: number;
  /** ISO instant the window resets, as reported; null when the provider gave none. */
  resets_at: string | null;
}

/** A prepaid or included credit balance as reported (Codex `credits`). `balance` stays the provider's string. */
export interface ProviderUsageCredits {
  has_credits: boolean;
  unlimited: boolean;
  balance: string | null;
}

/** A successful read. */
export interface ProviderUsageReport {
  provider: string;
  source: "provider_reported";
  /** When Switchboard read it (the provider sends no timestamp of its own). */
  observed_at: string;
  /** What was asked, for the operator (e.g. `codex app-server account/rateLimits/read`). */
  method: string;
  plan: string | null;
  /** True when the provider says a limit is reached or ordinary use is not allowed; null when it did not say. */
  limit_reached: boolean | null;
  /** The provider's own reason code for a reached limit, verbatim; null when none. */
  limit_reached_type: string | null;
  windows: ProviderUsageWindow[];
  credits: ProviderUsageCredits | null;
  /** ADR-0080 (Cursor): the provider's reset label, verbatim (e.g. `Resets Nov 5`); absent when it shows none. */
  reset_label?: string | null;
  /** ADR-0080: `day` when the provider shows the reset as a date only and `resets_at` is the start of that UTC day. */
  reset_precision?: "day" | null;
  /** ADR-0080 (Cursor): the on-demand (usage-based) row, dollars as shown. */
  on_demand?: ProviderUsageOnDemand | null;
  /** ADR-0080 (Cursor Enterprise): cumulative spend this and last billing period, as shown. */
  spend?: ProviderUsageSpend | null;
}

/** ADR-0080: an on-demand spend row; `state` is the provider's own case, dollars null when not shown. */
export interface ProviderUsageOnDemand {
  state: "fixed" | "unlimited" | "disabled" | "unavailable";
  used_usd: number | null;
  limit_usd: number | null;
  remaining_usd: number | null;
  /** The provider's detail line, verbatim. */
  detail: string | null;
}

/** ADR-0080: a spend view in dollars. */
export interface ProviderUsageSpend {
  current_cycle_usd: number | null;
  previous_period_usd: number | null;
}

/** A read that produced no figures. Never headroom (BR-50): the caller shows `unknown`. */
export interface ProviderUsageUnavailable {
  provider: string;
  source: "unknown";
  observed_at: string;
  method: string;
  /** Short operator-facing reason; never provider output beyond a bounded, control-character-free excerpt. */
  error: string;
}

export type ProviderUsageResult = ProviderUsageReport | ProviderUsageUnavailable;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** A reported percentage (0 to 100) as a used fraction in [0, 1]; undefined when it is not a finite number. */
export function fractionFromPercent(v: unknown): number | undefined {
  if (!finite(v)) return undefined;
  return round6(Math.min(1, Math.max(0, v / 100)));
}

/** A reported Unix time in seconds as an ISO instant; null when it is not a positive finite number. */
export function isoFromUnixSeconds(v: unknown): string | null {
  if (!finite(v) || v <= 0) return null;
  const d = new Date(v * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Bounded, control-character-free excerpt for an `error` (Proposed: 200 characters). */
export function safeExcerpt(s: string, max = 200): string {
  const clean = Array.from(s)
    .filter((c) => c >= " " && c !== "\x7f")
    .join("")
    .trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
