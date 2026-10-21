/**
 * Grok Build provider-reported usage (ADR-0079, FR-CAP-13, LLD §16.10).
 *
 * Observed 2026-10-21 on grok 1.0.50: `grok agent --no-leader stdio` speaks ACP (JSON-RPC 2.0, one message per line).
 * After `initialize`, the `_x.ai/billing` request answers with the signed-in account's billing period
 * (`config.currentPeriod`, `onDemandCap`, `onDemandUsed`, `prepaidBalance` and so on) and `subscription_tier`. No model
 * is called. The CLI exits at stdin EOF before answering, so the probe runner holds stdin open until the answer. The
 * CLI uses its own saved login; Switchboard never reads `~/.grok` (ADR-0003). The `initialize` answer (agent id, host
 * name) and every field not mapped below are dropped, never stored or shown.
 *
 * `val` amounts carry no stated unit and are never called currency. `creditUsagePercent` is read as 0 to 100
 * (Assumption: not seen on the recorded account); an absent field is unreported, never zero.
 */
import {
  fractionFromPercent,
  type ProviderUsageAmount,
  type ProviderUsagePeriod,
  type ProviderUsageResult,
  type ProviderUsageWindow,
  safeExcerpt,
} from "../provider-usage.js";

export const GROK_USAGE_ARGS: readonly string[] = ["agent", "--no-leader", "stdio"];
export const GROK_USAGE_METHOD = "grok agent stdio _x.ai/billing";
/** Proposed bound. */
export const GROK_USAGE_TIMEOUT_MS = 20_000;
const USAGE_REQUEST_ID = 2;
const PLAN_MAX = 64;

/** The two JSON lines written to stdin: `initialize`, then `_x.ai/billing`. */
export const GROK_USAGE_STDIN = `${[
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } },
  { jsonrpc: "2.0", id: USAGE_REQUEST_ID, method: "_x.ai/billing", params: {} },
]
  .map((m) => JSON.stringify(m))
  .join("\n")}\n`;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const iso = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

const KINDS: Readonly<Record<string, ProviderUsagePeriod["kind"]>> = {
  USAGE_PERIOD_TYPE_WEEKLY: "weekly",
  USAGE_PERIOD_TYPE_MONTHLY: "monthly",
  USAGE_PERIOD_TYPE_DAILY: "daily",
};

const AMOUNT_KEYS: readonly (readonly [string, string])[] = [
  ["prepaid_balance", "prepaidBalance"],
  ["on_demand_cap", "onDemandCap"],
  ["on_demand_used", "onDemandUsed"],
  ["monthly_limit", "monthlyLimit"],
];

/** True for the answer to the usage request (the probe runner then closes stdin). */
export function isGrokUsageAnswer(message: unknown): boolean {
  return obj(message)?.id === USAGE_REQUEST_ID;
}

function unavailable(observedAt: string, error: string): ProviderUsageResult {
  return { provider: "grok", source: "unknown", observed_at: observedAt, method: GROK_USAGE_METHOD, error };
}

/** Pure. Maps the `_x.ai/billing` result to a report; reads only the keys named here. */
export function grokUsageFromResult(result: unknown, observedAt: string): ProviderUsageResult {
  const r = obj(result);
  const config = obj(r?.config);
  if (r === undefined || config === undefined) return unavailable(observedAt, "_x.ai/billing answered without config");
  const unreported: string[] = [];

  const cur = obj(config.currentPeriod);
  const startsAt = iso(cur?.start) ?? iso(config.billingPeriodStart);
  const resetsAt = iso(cur?.end) ?? iso(config.billingPeriodEnd);
  const kind = KINDS[typeof cur?.type === "string" ? cur.type : ""] ?? "unknown";
  const period: ProviderUsagePeriod | undefined =
    cur === undefined && startsAt === null && resetsAt === null
      ? undefined
      : { kind, starts_at: startsAt, resets_at: resetsAt };

  const windows: ProviderUsageWindow[] = [];
  const used = fractionFromPercent(config.creditUsagePercent);
  if (used === undefined) {
    unreported.push("config.creditUsagePercent");
  } else {
    const span = startsAt !== null && resetsAt !== null ? Date.parse(resetsAt) - Date.parse(startsAt) : Number.NaN;
    const seconds = Math.round(span / 1000);
    windows.push({
      id: "credit_period",
      limit_id: null,
      window_seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
      used_fraction: used,
      remaining_fraction: Math.round((1 - used) * 1e6) / 1e6,
      resets_at: resetsAt,
    });
  }

  const amounts: ProviderUsageAmount[] = [];
  for (const [id, key] of AMOUNT_KEYS) {
    const value = finite(obj(config[key])?.val);
    if (value === undefined) unreported.push(`config.${key}`);
    else amounts.push({ id, value, unit: "unspecified", key: `config.${key}` });
  }

  const tier = r.subscription_tier;
  return {
    provider: "grok",
    source: "provider_reported",
    observed_at: observedAt,
    method: GROK_USAGE_METHOD,
    plan: typeof tier === "string" && tier !== "" && tier.length <= PLAN_MAX ? tier : null,
    limit_reached: null,
    limit_reached_type: null,
    windows,
    credits: null,
    ...(period === undefined ? {} : { period }),
    amounts,
    unreported,
  };
}

/** Pure. Finds the usage answer in the CLI's stdout (JSON lines; notifications and other ids are skipped). */
export function grokUsageFromStdout(stdout: string, observedAt: string): ProviderUsageResult {
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let m: unknown;
    try {
      m = JSON.parse(t);
    } catch {
      continue;
    }
    if (!isGrokUsageAnswer(m)) continue;
    const msg = obj(m) as Json;
    const err = obj(msg.error);
    if (err !== undefined) {
      const text = typeof err.message === "string" ? safeExcerpt(err.message) : "";
      return unavailable(observedAt, `_x.ai/billing failed${text ? `: ${text}` : ""}`);
    }
    return grokUsageFromResult(msg.result, observedAt);
  }
  return unavailable(observedAt, "no answer to _x.ai/billing");
}
