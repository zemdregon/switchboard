/**
 * Codex provider-reported usage (ADR-0079, FR-CAP-13, LLD §16.10).
 *
 * Observed 2026-10-21 on codex-cli 0.162.0 (docs/research/codex-usage-2026-10-21.md): `codex app-server` speaks
 * JSON-RPC 2.0 as JSON lines on stdio; after `initialize` and `initialized`, the `account/rateLimits/read` request
 * answers with the signed-in account's rate-limit snapshot (`rateLimits` and `rateLimitsByLimitId`, each with
 * `primary` and `secondary` windows carrying `usedPercent`, `windowDurationMins` and `resetsAt` in Unix seconds,
 * plus `planType`, `credits` and `rateLimitReachedType`; `ordinaryUsageAllowed` beside them). No model is called. The
 * CLI uses its own saved login; Switchboard writes three requests to the child's stdin and reads its stdout, and never
 * reads `~/.codex` (ADR-0003). `accountId` and any field not mapped below are dropped, never stored or shown.
 */
import {
  fractionFromPercent,
  isoFromUnixSeconds,
  type ProviderUsageCredits,
  type ProviderUsageResult,
  type ProviderUsageWindow,
  safeExcerpt,
} from "../provider-usage.js";

/** `codex app-server` (no flags: the CLI's own config and login, as `codex login status`). */
export const CODEX_USAGE_ARGS: readonly string[] = ["app-server"];
export const CODEX_USAGE_METHOD = "codex app-server account/rateLimits/read";
/** Proposed bound: the observed read took under one second. */
export const CODEX_USAGE_TIMEOUT_MS = 15_000;
const USAGE_REQUEST_ID = 2;

/**
 * The three JSON lines written to stdin. `excludeResetCreditDetails` skips the reset-credit detail lookup the schema
 * describes for background polls; the count still arrives and is not used.
 */
export const CODEX_USAGE_STDIN = `${[
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "switchboard", version: "0" } } },
  { jsonrpc: "2.0", method: "initialized" },
  {
    jsonrpc: "2.0",
    id: USAGE_REQUEST_ID,
    method: "account/rateLimits/read",
    params: { excludeResetCreditDetails: true },
  },
]
  .map((m) => JSON.stringify(m))
  .join("\n")}\n`;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** True for the answer to the usage request (the probe runner then closes stdin). */
export function isCodexUsageAnswer(message: unknown): boolean {
  return obj(message)?.id === USAGE_REQUEST_ID;
}

function windowOf(limitId: string | null, name: string, prefix: boolean, v: unknown): ProviderUsageWindow | null {
  const w = obj(v);
  if (w === undefined) return null;
  const used = fractionFromPercent(w.usedPercent);
  if (used === undefined) return null;
  const mins = w.windowDurationMins;
  return {
    id: prefix && limitId !== null ? `${limitId}:${name}` : name,
    limit_id: limitId,
    window_seconds: typeof mins === "number" && Number.isFinite(mins) && mins > 0 ? mins * 60 : null,
    used_fraction: used,
    remaining_fraction: Math.round((1 - used) * 1e6) / 1e6,
    resets_at: isoFromUnixSeconds(w.resetsAt),
  };
}

function credits(v: unknown): ProviderUsageCredits | null {
  const c = obj(v);
  if (c === undefined || typeof c.hasCredits !== "boolean" || typeof c.unlimited !== "boolean") return null;
  return { has_credits: c.hasCredits, unlimited: c.unlimited, balance: str(c.balance) };
}

/**
 * Pure. Maps the `account/rateLimits/read` result to a report. The single-bucket `rateLimits` view names the default
 * bucket; every other bucket in `rateLimitsByLimitId` adds its windows with ids prefixed by its `limitId`.
 */
export function codexUsageFromResult(result: unknown, observedAt: string): ProviderUsageResult {
  const r = obj(result);
  const main = obj(r?.rateLimits);
  if (r === undefined || main === undefined) {
    return unavailable(observedAt, "account/rateLimits/read answered without rateLimits");
  }
  const mainId = str(main.limitId);
  const windows: ProviderUsageWindow[] = [];
  const push = (w: ProviderUsageWindow | null) => {
    if (w !== null && !windows.some((x) => x.id === w.id)) windows.push(w);
  };
  push(windowOf(mainId, "primary", false, main.primary));
  push(windowOf(mainId, "secondary", false, main.secondary));
  const byId = obj(r.rateLimitsByLimitId) ?? {};
  let reachedType = str(main.rateLimitReachedType);
  for (const key of Object.keys(byId).sort()) {
    const b = obj(byId[key]);
    if (b === undefined) continue;
    const id = str(b.limitId) ?? key;
    if (id === mainId) continue;
    push(windowOf(id, "primary", true, b.primary));
    push(windowOf(id, "secondary", true, b.secondary));
    reachedType ??= str(b.rateLimitReachedType);
  }
  const allowed = r.ordinaryUsageAllowed;
  // Only what the provider says: a full window with no flag is not read as reached (the schema says clients must not
  // infer the state from percentages or reset times).
  const limitReached = reachedType !== null || allowed === false ? true : allowed === true ? false : null;
  return {
    provider: "codex",
    source: "provider_reported",
    observed_at: observedAt,
    method: CODEX_USAGE_METHOD,
    plan: str(main.planType),
    limit_reached: limitReached,
    limit_reached_type: reachedType,
    windows,
    credits: credits(main.credits),
  };
}

function unavailable(observedAt: string, error: string): ProviderUsageResult {
  return { provider: "codex", source: "unknown", observed_at: observedAt, method: CODEX_USAGE_METHOD, error };
}

/** Pure. Finds the usage answer in the app-server's stdout (JSON lines; notifications and other ids are skipped). */
export function codexUsageFromStdout(stdout: string, observedAt: string): ProviderUsageResult {
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let m: unknown;
    try {
      m = JSON.parse(t);
    } catch {
      continue;
    }
    if (!isCodexUsageAnswer(m)) continue;
    const msg = obj(m) as Json;
    const err = obj(msg.error);
    if (err !== undefined) {
      const text = typeof err.message === "string" ? safeExcerpt(err.message) : "";
      return unavailable(observedAt, `account/rateLimits/read failed${text ? `: ${text}` : ""}`);
    }
    return codexUsageFromResult(msg.result, observedAt);
  }
  return unavailable(observedAt, "no answer to account/rateLimits/read");
}
