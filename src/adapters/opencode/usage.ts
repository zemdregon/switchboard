/**
 * OpenCode provider-reported spend (ADR-0089, FR-CAP-16, BR-63, LLD §16.13; Delegated, not owner-approved). Runs
 * OpenCode's own read-only `experimental.session.stats` operation (protocol.ts) for three rolling windows and reports
 * OpenCode's spend figure for each as `spend_windows` on a `provider_reported` report. OpenCode reports no plan limit,
 * remaining allowance or reset time to its CLI, so `windows` is empty and plan, credits and the limit flag are null.
 * Never reads `opencode.db` or `auth.json` (both hold credentials; ADR-0003) and never copies raw stdout or stderr
 * into a report.
 */

import type { ProviderUsageResult, ProviderUsageSpendWindow } from "../provider-usage.js";
import type { ProbeRunner } from "../types.js";
import { OPENCODE_BINARY, USAGE_PARAM_FLAG, USAGE_STATS_ARGS, USAGE_STATS_TIMEOUT_MS } from "./protocol.js";

export const OPENCODE_USAGE_METHOD = `${OPENCODE_BINARY} ${USAGE_STATS_ARGS.join(" ")}`;
export const OPENCODE_USAGE_SCOPE =
  "OpenCode's local session history on this host: every OpenCode session here, including use outside Switchboard; " +
  "use on other machines is not seen";
export const OPENCODE_USAGE_NOTE =
  "OpenCode does not report a plan limit, what is left of it or a reset time to its CLI, so none is shown. " +
  "Spend is OpenCode's own figure from its price table, not a bill. Go plan limits are documented per model at " +
  "https://opencode.ai/docs/go and are not applied here.";

/**
 * Rolling windows read. `five_hour` and `weekly` follow the Go plan's documented 5-hour and weekly limits; `monthly`
 * is an **Assumption**: 30 days rolling, because the anchor of the Go monthly window is not reported.
 */
export const OPENCODE_USAGE_WINDOWS: readonly { readonly id: string; readonly lengthSeconds: number }[] = [
  { id: "five_hour", lengthSeconds: 18_000 },
  { id: "weekly", lengthSeconds: 604_800 },
  { id: "monthly", lengthSeconds: 2_592_000 },
];

/** Per-model entries kept in a window's detail, highest spend first (Proposed: keeps the answer bounded). */
export const MAX_USAGE_MODELS = 20;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
/** Own-property read, so an inherited or `__proto__` key is never read as a field (as the adapter's parser). */
const field = (o: Json, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);
const count = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

export interface OpenCodeUsageModel {
  provider_id: string;
  model_id: string;
  cost_usd: number;
  steps: number;
}

export interface OpenCodeSessionStats {
  cost: number;
  sessions: number;
  steps: number;
  tokens: { input: number; output: number; reasoning: number; cache_read: number; cache_write: number };
  models: OpenCodeUsageModel[];
}

/**
 * Pure. Parses one `experimental.session.stats` stdout. Fails closed: anything but the documented shape, with finite
 * non-negative figures and a `data.range` that echoes the request, is an error naming the first bad part (controller
 * text, never output).
 */
export function parseSessionStats(
  stdout: string,
  request: { from: number; to: number },
): { ok: true; stats: OpenCodeSessionStats } | { ok: false; error: string } {
  const bad = (what: string) => ({ ok: false as const, error: `output is not the expected session stats (${what})` });
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "output is not JSON" };
  }
  const root = obj(doc);
  const data = root === undefined ? undefined : obj(field(root, "data"));
  if (data === undefined) return bad("data");
  const range = obj(field(data, "range"));
  if (range === undefined) return bad("range");
  if (field(range, "from") !== request.from || field(range, "to") !== request.to) {
    return { ok: false, error: "the reported range does not match the request" };
  }
  const cost = count(field(data, "cost"));
  if (cost === undefined) return bad("cost");
  const sessions = count(field(data, "sessions"));
  const steps = count(field(data, "steps"));
  if (sessions === undefined || steps === undefined) return bad("sessions or steps");
  const tok = obj(field(data, "tokens"));
  const cache = tok === undefined ? undefined : obj(field(tok, "cache"));
  if (tok === undefined || cache === undefined) return bad("tokens");
  const tokens = {
    input: count(field(tok, "input")),
    output: count(field(tok, "output")),
    reasoning: count(field(tok, "reasoning")),
    cache_read: count(field(cache, "read")),
    cache_write: count(field(cache, "write")),
  };
  if (Object.values(tokens).some((v) => v === undefined)) return bad("tokens");
  const rawModels = field(data, "models");
  if (!Array.isArray(rawModels)) return bad("models");
  const models: OpenCodeUsageModel[] = [];
  for (const m of rawModels) {
    const entry = obj(m);
    const model = entry === undefined ? undefined : obj(field(entry, "model"));
    const modelId = model === undefined ? undefined : field(model, "id");
    const providerId = model === undefined ? undefined : field(model, "providerID");
    const mCost = entry === undefined ? undefined : count(field(entry, "cost"));
    const mSteps = entry === undefined ? undefined : count(field(entry, "steps"));
    if (typeof modelId !== "string" || typeof providerId !== "string" || mCost === undefined || mSteps === undefined) {
      return bad("models");
    }
    models.push({ provider_id: providerId, model_id: modelId, cost_usd: mCost, steps: mSteps });
  }
  return { ok: true, stats: { cost, sessions, steps, tokens: tokens as OpenCodeSessionStats["tokens"], models } };
}

/** Highest spend first, then provider and model id, so the order is stable. */
function byCost(a: OpenCodeUsageModel, b: OpenCodeUsageModel): number {
  if (a.cost_usd !== b.cost_usd) return b.cost_usd - a.cost_usd;
  const ka = `${a.provider_id}/${a.model_id}`;
  const kb = `${b.provider_id}/${b.model_id}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Pure. One window's spend entry: the reported cost as `amount`, with the breakdown in `detail`. */
export function spendWindow(
  id: string,
  windowSeconds: number,
  request: { from: number; to: number },
  stats: OpenCodeSessionStats,
): ProviderUsageSpendWindow {
  const sorted = [...stats.models].sort(byCost);
  const omitted = sorted.length - MAX_USAGE_MODELS;
  return {
    id,
    window_seconds: windowSeconds,
    from: new Date(request.from).toISOString(),
    to: new Date(request.to).toISOString(),
    amount: stats.cost,
    unit: "usd",
    detail: {
      sessions: stats.sessions,
      steps: stats.steps,
      tokens: stats.tokens,
      models: sorted.slice(0, MAX_USAGE_MODELS),
      ...(omitted > 0 ? { models_omitted: omitted } : {}),
    },
  };
}

/**
 * The read, called by `OpenCodeAdapter.readProviderUsage` with the adapter's executable and launcher. Windows run one
 * after another (Delegated): `--standalone` starts a private OpenCode server per call, and three at once on the same
 * local database would contend for it and triple the host load for a figure cached a minute. The first failure ends
 * the read: a provider that answers one window badly is not trusted for the others.
 */
export async function readOpenCodeUsage(
  runner: ProbeRunner,
  exe: string | undefined,
  launcher: readonly string[],
  now: Date,
): Promise<ProviderUsageResult> {
  const at = now.toISOString();
  const unknown = (error: string): ProviderUsageResult => ({
    provider: "opencode",
    source: "unknown",
    observed_at: at,
    method: OPENCODE_USAGE_METHOD,
    error,
  });
  if (exe === undefined) return unknown(`${OPENCODE_BINARY} not found on PATH`);
  const to = now.getTime();
  const spend: ProviderUsageSpendWindow[] = [];
  for (const w of OPENCODE_USAGE_WINDOWS) {
    const request = { from: to - w.lengthSeconds * 1000, to };
    const r = await runner(
      [
        exe,
        ...launcher,
        ...USAGE_STATS_ARGS,
        USAGE_PARAM_FLAG,
        `from=${request.from}`,
        USAGE_PARAM_FLAG,
        `to=${request.to}`,
        USAGE_PARAM_FLAG,
        "tools=none",
      ],
      { timeoutMs: USAGE_STATS_TIMEOUT_MS },
    );
    const why = `session stats (${w.id})`;
    if (r.spawnError !== undefined) return unknown(`${why}: could not start ${OPENCODE_BINARY}`);
    if (r.timedOut) return unknown(`${why}: timed out`);
    if (r.exitCode !== 0) return unknown(`${why}: exited ${r.exitCode}`);
    const parsed = parseSessionStats(r.stdout, request);
    if (!parsed.ok) return unknown(`${why}: ${parsed.error}`);
    spend.push(spendWindow(w.id, w.lengthSeconds, request, parsed.stats));
  }
  return {
    provider: "opencode",
    source: "provider_reported",
    observed_at: at,
    method: OPENCODE_USAGE_METHOD,
    plan: null,
    limit_reached: null,
    limit_reached_type: null,
    windows: [],
    credits: null,
    spend_windows: spend,
    scope: OPENCODE_USAGE_SCOPE,
    note: OPENCODE_USAGE_NOTE,
  };
}
