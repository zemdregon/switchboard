/**
 * `switchboard capacity` (M6, T6.3; FR-OPS-05, FR-CAP-03, LLD §16.3). Prints the same projection as `get_capacity`
 * from a read-only ledger handle; never migrates or creates files. With no ledger yet, every provider is `unknown`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { type CapacityProjection, capacityProjection, capacityProviders } from "../capacity/index.js";
import { loadConfig, type ResolvedConfig } from "../config/index.js";
import { createLedger, LEDGER_FILE_NAME, migrate } from "../ledger/index.js";
import { defaultAdapters } from "./doctor.js";
import { type CliIo, UsageError } from "./io.js";

export function runCapacity(io: CliIo, argv: readonly string[], provider?: string): CapacityProjection {
  const cfg = loadConfig({ argv, env: io.env, ...(io.homedir !== undefined ? { homedir: io.homedir } : {}) });
  const ids: string[] = (io.adapters ?? defaultAdapters()).list().map((a) => a.id);
  if (provider !== undefined && !ids.includes(provider)) {
    throw new UsageError(`unknown provider ${JSON.stringify(provider)}; expected one of ${ids.join(", ")}`);
  }
  return projectCapacity(cfg, provider === undefined ? ids : [provider], (io.now ?? (() => new Date()))());
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
