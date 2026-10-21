/**
 * `switchboard capacity` (M6, T6.3; FR-OPS-05, FR-CAP-03, LLD §16.3). Prints the same projection as `get_capacity`
 * from a read-only ledger handle; never migrates or creates files. With no ledger yet, every provider is `unknown`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { acceptedProviderNames, canonicalProviderId } from "../adapters/providers.js";
import { createProbeRunner } from "../adapters/run.js";
import {
  bindingPacingWindow,
  type CapacityProjection,
  capacityProjection,
  capacityProviders,
  type PacingSubscriptionView,
  type PacingWindowView,
  providerUsageLines,
  readProviderUsage,
  usageReadTargets,
  withProviderUsage,
} from "../capacity/index.js";
import { loadConfig, type ResolvedConfig } from "../config/index.js";
import { createLedger, LEDGER_FILE_NAME, migrate } from "../ledger/index.js";
import { COPILOT_PROVIDER, type CopilotQuotaWindow, type ProviderQuotaReport } from "../usage/copilot-quota.js";
import { defaultAdapters } from "./doctor.js";
import { type CliIo, PROBE_ENV_ALLOWLIST, UsageError } from "./io.js";

export async function runCapacity(io: CliIo, argv: readonly string[], provider?: string): Promise<CapacityProjection> {
  const cfg = loadConfig({ argv, env: io.env, ...(io.homedir !== undefined ? { homedir: io.homedir } : {}) });
  const ids: string[] = (io.adapters ?? defaultAdapters()).list().map((a) => a.id);
  // ADR-0076: `--provider` takes either spelling (`claude`, `claude-code`); the projection names the canonical one.
  const named = provider === undefined ? undefined : (canonicalProviderId(provider) ?? provider);
  // ADR-0081: the usage-only `copilot` quota, through the operator's own `gh` (`ci_trigger.gh_binary`), when on.
  const quota =
    cfg.capacity.copilotQuota && io.copilotQuota !== undefined
      ? io.copilotQuota({ binary: cfg.ciTrigger.ghBinary, sourceEnv: io.env })
      : undefined;
  const usageOnly = quota !== undefined && named === COPILOT_PROVIDER && !ids.includes(named);
  if (named !== undefined && !ids.includes(named) && !usageOnly) {
    const accepted = [...acceptedProviderNames(ids), ...(quota !== undefined ? [COPILOT_PROVIDER] : [])];
    throw new UsageError(`unknown provider ${JSON.stringify(provider)}; expected one of ${accepted.join(", ")}`);
  }
  const projection = projectCapacity(
    cfg,
    usageOnly ? [] : named === undefined ? ids : [named],
    (io.now ?? (() => new Date()))(),
  );
  if (quota === undefined || (named !== undefined && !usageOnly)) return projection;
  return { ...projection, provider_quota: [await quota()] };
}

/** `runCapacity` plus the provider-reported usage of each enabled provider with a reader (ADR-0079, FR-CAP-13). */
export async function runCapacityWithUsage(
  io: CliIo,
  argv: readonly string[],
  provider?: string,
): Promise<CapacityProjection> {
  // ADR-0081 rides on `runCapacity` (top-level `provider_quota`); ADR-0079 adds `provider_usage` per adapter entry.
  // A usage-only `--provider copilot` has no adapter entries, so there is nothing for the usage step to read.
  const projection = await runCapacity(io, argv, provider);
  return addProviderUsage(io, projection, new Date(projection.as_of));
}

/**
 * ADR-0079 (FR-CAP-13): lays the provider-reported usage over a projection (shared by `capacity` and `doctor`). Only
 * enabled providers in the projection whose adapter has a reader are asked; the rest are unchanged.
 */
export async function addProviderUsage(
  io: CliIo,
  projection: CapacityProjection,
  now: Date,
): Promise<CapacityProjection> {
  const named = new Set(projection.providers.map((p) => p.provider));
  const adapters = (io.adapters ?? defaultAdapters()).list().filter((a) => named.has(a.id));
  const targets = usageReadTargets(adapters, projection);
  if (targets.length === 0) return projection;
  const runner = io.providerUsageRunner ?? createProbeRunner(PROBE_ENV_ALLOWLIST);
  return withProviderUsage(projection, await readProviderUsage(targets, { runner }, now));
}

/** The projection for `ids` from the configured data directory (shared by `capacity` and `doctor`). */
export function projectCapacity(cfg: ResolvedConfig, ids: readonly string[], now: Date): CapacityProjection {
  const file = path.join(cfg.dataDir, LEDGER_FILE_NAME);
  // No ledger yet: an empty in-memory one, so the output has the same shape and says `unknown` for every provider.
  const db = existsSync(file) ? new Database(file, { readonly: true, fileMustExist: true }) : emptyLedger();
  try {
    return capacityProjection(createLedger(db), capacityProviders(ids, cfg), cfg.capacity, now);
  } finally {
    db.close();
  }
}

function emptyLedger(): Database.Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

const fmt = (n: number | null): string => (n === null ? "unknown" : n.toFixed(2));

/** Printed on every `controller_estimated` pacing line (LLD §16.9, FR-CAP-03). */
export const CONTROLLER_ESTIMATE_WORDING = "estimate, Switchboard-observed only";

/** One `doctor` line per subscription, from the binding window (LLD §16.9). */
export function pacingDoctorLine(sub: PacingSubscriptionView): string {
  const w = bindingPacingWindow(sub);
  const pace = w?.pace ?? "unknown";
  const until = sub.deferred_until ?? "none";
  const source = w?.used_fraction.source ?? "unknown";
  const estimate = source === "controller_estimated" ? ` (${CONTROLLER_ESTIMATE_WORDING})` : "";
  return `       pacing ${sub.subscription}: pace ${pace}, deferred_until ${until}, source ${source}${estimate}`;
}

function figure(n: number | null): string {
  return n === null ? "unknown" : String(n);
}

function pacingWindowLine(w: PacingWindowView): string {
  const used = w.used_fraction;
  const usedText =
    used.value === null
      ? "unknown"
      : used.source === "controller_estimated"
        ? `${used.value} (${CONTROLLER_ESTIMATE_WORDING})`
        : String(used.value);
  const reset = w.reset_at === null ? "none" : w.reset_at.at;
  const start = w.window_start === null ? "none" : w.window_start.at;
  return (
    `${w.id}: length ${w.length_seconds} s, used ${usedText}, source ${used.source}, ` +
    `pace ${w.pace}, elapsed ${figure(w.elapsed_fraction)}, allowance ${figure(w.allowance)}, ` +
    `window_start ${start}, reset ${reset}, defers ${w.defers ? "yes" : "no"}`
  );
}

/** One `copilot` quota line; every figure on it is the provider's own (ADR-0081). */
function copilotWindowLine(q: CopilotQuotaWindow): string {
  const overage = q.overage_permitted ? `overage permitted (${q.overage_count} used)` : "overage not permitted";
  if (q.unlimited) return `${q.id} (provider-reported): unlimited ${q.unit}, ${overage}`;
  const pct = q.percent_remaining === null ? "" : `, ${q.percent_remaining}% remaining`;
  return (
    `${q.id} (provider-reported): remaining ${figure(q.remaining)} of ${figure(q.entitlement)} ${q.unit} ` +
    `(used ${figure(q.used)}${pct}), ${overage}`
  );
}

/** The usage-only providers' section (ADR-0081): provider-reported quota, never an estimate. */
export function providerQuotaLines(r: ProviderQuotaReport): string[] {
  if (r.status === "unavailable") return [`${r.provider} (usage-only): quota unavailable (${r.reason})`];
  const lines = [
    `${r.provider} (usage-only, no run adapter; ${r.source} via ${r.via}, observed ${r.observed_at})`,
    `  plan ${r.plan ?? "unknown"}${r.sku === null ? "" : ` (${r.sku})`}; ` +
      `resets ${r.reset_at === null ? "unknown" : r.reset_at.at}`,
  ];
  for (const q of r.quotas) lines.push(`  ${copilotWindowLine(q)}`);
  return lines;
}

/**
 * Text view. Wording rule (LLD §16.3, FR-CAP-03): "remaining" appears only on the provider-reported line, never next to
 * an estimate, and no line speaks of quota left or a percentage. The one exception is the usage-only provider section
 * (ADR-0081), where every figure, the percentage included, is the provider's own and each line says so.
 */
export function renderCapacity(p: CapacityProjection): string {
  const lines = [`switchboard capacity (as of ${p.as_of}, window ${p.window_seconds} s)`, `Note: ${p.note}.`, ""];
  for (const c of p.providers) {
    lines.push(`${c.provider}${c.enabled ? "" : " (disabled in config)"}`);
    lines.push(
      `  estimate (controller_estimated): score ${fmt(c.capacity_score)}, confidence ${c.confidence.toFixed(2)}, ` +
        `throttle risk ${c.throttle_risk}`,
    );
    lines.push(`  sources: ${c.sources.join(", ")}`);
    lines.push(
      `  provider-reported remaining: ${
        c.explicit_remaining === null
          ? "not reported"
          : `${c.explicit_remaining.value} ${c.explicit_remaining.unit} (at ${c.explicit_remaining.observed_at})`
      }`,
    );
    lines.push(`  provider-reported reset: ${c.reset_at === null ? "none" : c.reset_at.at}`);
    // ADR-0079 (FR-CAP-13): the provider's own report, read live through its CLI.
    if (c.provider_usage !== undefined) lines.push(...providerUsageLines(c.provider_usage, "  "));
    if (c.cache !== undefined) {
      // FR-CAP-08: reported counts with their source; never read as cache use.
      lines.push(
        `  provider-reported cache tokens: read ${c.cache.read ?? "-"}, creation ${c.cache.creation ?? "-"} ` +
          `(${c.cache.rows} reports)`,
      );
    }
    lines.push(`  slots: ${c.concurrency_available} free of ${c.concurrency_limit}`);
    lines.push(
      `  breaker: ${c.breaker.state}${c.breaker.until === null ? "" : ` until ${c.breaker.until}`} ` +
        `(consecutive counted failures ${c.breaker.consecutive_failures})`,
    );
    lines.push(
      `  window: ${c.window.terminal_runs} finished runs, ${c.window.counted_failures} throttle or crash failures, ` +
        `${c.window.quota_exhausted} quota stops, ${c.window.rate_limit_signals} rate-limit signals, ` +
        `${c.window.usage_observations} usage reports`,
    );
  }
  if (p.pacing !== undefined) {
    lines.push(
      "",
      "Pacing (one entry per subscription; the gate verdict is shown, the hold is T6.8 and is not applied here):",
    );
    for (const sub of p.pacing) {
      lines.push(
        `  ${sub.subscription} (providers ${sub.providers.join(", ")}; mode ${sub.mode}; ` +
          `deferred_until ${sub.deferred_until ?? "none"}; verdict ${sub.verdict})`,
      );
      for (const w of sub.windows) lines.push(`    ${pacingWindowLine(w)}`);
    }
  }
  if (p.provider_quota !== undefined) {
    lines.push("", "Usage-only providers (provider-reported quota; no run adapter, never routed to):");
    for (const r of p.provider_quota) lines.push(...providerQuotaLines(r));
  }
  lines.push("", `Provider and model per project (${p.affinity.note}):`);
  if (p.affinity.projects.length === 0) lines.push("  no runs in the window");
  for (const pr of p.affinity.projects) {
    const switched = Object.entries(pr.switched)
      .map(([reason, n]) => `${reason} ${n}`)
      .join(", ");
    lines.push(`  ${pr.project_key}: ${pr.runs} runs, kept ${pr.kept}, switched ${switched === "" ? "0" : switched}`);
  }
  if (p.affinity.truncated) lines.push("  (more projects not shown)");
  return `${lines.join("\n")}\n`;
}
