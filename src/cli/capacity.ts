/**
 * `switchboard capacity` (M6, T6.3; FR-OPS-05, FR-CAP-03, LLD §16.3). Prints the same projection as `get_capacity`
 * from a read-only ledger handle; never migrates or creates files. With no ledger yet, every provider is `unknown`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { acceptedProviderNames, canonicalProviderId } from "../adapters/providers.js";
import {
  attachProviderUsage,
  bindingPacingWindow,
  type CapacityProjection,
  capacityProjection,
  capacityProviders,
  type PacingSubscriptionView,
  type PacingWindowView,
  type ProviderUsageReport,
} from "../capacity/index.js";
import { loadConfig, type ResolvedConfig } from "../config/index.js";
import { createLedger, LEDGER_FILE_NAME, migrate } from "../ledger/index.js";
import { defaultAdapters } from "./doctor.js";
import { type CliIo, UsageError } from "./io.js";

export function runCapacity(io: CliIo, argv: readonly string[], provider?: string): CapacityProjection {
  return capacityFor(io, argv, provider).projection;
}

function capacityFor(
  io: CliIo,
  argv: readonly string[],
  provider?: string,
): { projection: CapacityProjection; cfg: ResolvedConfig; ids: string[] } {
  const cfg = loadConfig({ argv, env: io.env, ...(io.homedir !== undefined ? { homedir: io.homedir } : {}) });
  const ids: string[] = (io.adapters ?? defaultAdapters()).list().map((a) => a.id);
  // ADR-0076: `--provider` takes either spelling (`claude`, `claude-code`); the projection names the canonical one.
  const named = provider === undefined ? undefined : (canonicalProviderId(provider) ?? provider);
  if (named !== undefined && !ids.includes(named)) {
    throw new UsageError(
      `unknown provider ${JSON.stringify(provider)}; expected one of ${acceptedProviderNames(ids).join(", ")}`,
    );
  }
  const projection = projectCapacity(cfg, named === undefined ? ids : [named], (io.now ?? (() => new Date()))());
  return { projection, cfg, ids };
}

/**
 * `runCapacity` plus provider-reported usage (FR-CAP-13, ADR-0079) when the entry point supplied a usage service
 * (`CliIo.providerUsage`); without one the projection is returned unchanged.
 */
export async function runCapacityWithUsage(
  io: CliIo,
  argv: readonly string[],
  provider?: string,
): Promise<CapacityProjection> {
  const { projection, cfg, ids } = capacityFor(io, argv, provider);
  return attachProviderUsage(projection, io.providerUsage?.(ids, { dataDir: cfg.dataDir }));
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

/**
 * FR-CAP-13 (ADR-0079): the provider's own usage display, one line per window and balance. Every line that says
 * "remaining" also says "provider-reported" (LLD §16.3 wording rule); fractions, never percentages.
 */
export function providerUsageLines(u: ProviderUsageReport): string[] {
  const head = `  provider-reported usage (via ${u.via}, observed ${u.observed_at})`;
  if (u.status === "unavailable") return [`${head}: unavailable: ${u.reason}`];
  if (u.windows.length === 0 && u.balances.length === 0) return [`${head}: no usage data reported`];
  const lines = [`${head}:`];
  for (const w of u.windows) {
    const split =
      w.breakdown === undefined
        ? ""
        : ` (${Object.entries(w.breakdown)
            .map(([k, v]) => `${k} ${v.toFixed(2)}`)
            .join(", ")})`;
    lines.push(
      `    ${w.label} used ${w.used_fraction.toFixed(2)}${split} (remaining ${w.remaining_fraction.toFixed(2)}, ` +
        `provider-reported), reset ${w.reset_at ?? "not reported"}`,
    );
  }
  for (const b of u.balances) {
    const amount = b.unlimited ? "unlimited" : b.amount === null ? "unreadable" : `${b.amount} ${b.currency ?? ""}`;
    lines.push(`    ${b.label}: ${amount.trim()} (provider-reported)`);
  }
  return lines;
}

/**
 * Text view. Wording rule (LLD §16.3, FR-CAP-03): "remaining" appears only on the provider-reported line, never next to
 * an estimate, and no line speaks of quota left or a percentage.
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
    if (c.provider_usage !== undefined) lines.push(...providerUsageLines(c.provider_usage));
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
