/**
 * Live provider-reported usage for the capacity surfaces (ADR-0079, FR-CAP-13, LLD §16.10). `get_capacity`,
 * `switchboard capacity` and `doctor` ask each enabled provider whose adapter has a `readProviderUsage` reader and
 * attach the answer to that provider's entry as `provider_usage`. The projection itself stays a pure function of the
 * ledger: the report is laid over it, never stored, never fed into `capacity_score`, routing or pacing.
 *
 * Reads are cached per process for {@link PROVIDER_USAGE_TTL_MS} so that repeated calls do not start a CLI each
 * time, and run for all providers at once.
 */
import type { ProviderUsageResult } from "../adapters/provider-usage.js";
import type { ProbeRunner, ProviderAdapter } from "../adapters/types.js";
import type { ProviderCapacity } from "./estimate.js";
import type { CapacityProjection } from "./projection.js";

/** Proposed (Delegated): a minute, so a busy orchestrator polling `get_capacity` starts at most one read a minute. */
export const PROVIDER_USAGE_TTL_MS = 60_000;

/** Process-local cache of the last read per provider. A failed read is cached too, for the same time. */
export class ProviderUsageCache {
  readonly #entries = new Map<string, { at: number; value: Promise<ProviderUsageResult> }>();
  constructor(readonly ttlMs: number = PROVIDER_USAGE_TTL_MS) {}

  get(provider: string, nowMs: number, read: () => Promise<ProviderUsageResult>): Promise<ProviderUsageResult> {
    const hit = this.#entries.get(provider);
    if (hit !== undefined && nowMs - hit.at < this.ttlMs && nowMs >= hit.at) return hit.value;
    const value = read();
    this.#entries.set(provider, { at: nowMs, value });
    return value;
  }
}

/** What a surface needs to read provider usage. */
export interface ProviderUsageReaderDeps {
  readonly runner: ProbeRunner;
  readonly cache?: ProviderUsageCache;
}

/**
 * Reads every adapter in `adapters` that has a reader, in parallel; adapters without one are left out of the map. A
 * reader that throws yields `unknown` with a short reason, never an exception to the caller.
 */
export async function readProviderUsage(
  adapters: readonly ProviderAdapter[],
  deps: ProviderUsageReaderDeps,
  now: Date,
): Promise<Map<string, ProviderUsageResult>> {
  const out = new Map<string, ProviderUsageResult>();
  const readers = adapters.filter((a) => typeof a.readProviderUsage === "function");
  const results = await Promise.all(
    readers.map((a) => {
      const read = async (): Promise<ProviderUsageResult> => {
        try {
          const r = await a.readProviderUsage?.(deps.runner, now);
          if (r === undefined) throw new Error("no reader");
          return r;
        } catch (e) {
          return {
            provider: a.id,
            source: "unknown",
            observed_at: now.toISOString(),
            method: "readProviderUsage",
            error: `usage read failed: ${e instanceof Error ? e.name : "error"}`,
          };
        }
      };
      return deps.cache === undefined ? read() : deps.cache.get(a.id, now.getTime(), read);
    }),
  );
  for (const [i, a] of readers.entries()) {
    const r = results[i];
    if (r !== undefined) out.set(a.id, r);
  }
  return out;
}

/** The projection with `provider_usage` set on each provider entry that has a report. Pure; the input is unchanged. */
export function withProviderUsage(
  projection: CapacityProjection,
  usage: ReadonlyMap<string, ProviderUsageResult>,
): CapacityProjection {
  if (usage.size === 0) return projection;
  return {
    ...projection,
    providers: projection.providers.map((p): ProviderCapacity => {
      const u = usage.get(p.provider);
      return u === undefined ? p : { ...p, provider_usage: u };
    }),
  };
}

/** The adapters a surface should read: those named, enabled in the projection. */
export function usageReadTargets(
  adapters: readonly ProviderAdapter[],
  projection: CapacityProjection,
): ProviderAdapter[] {
  const enabled = new Set(projection.providers.filter((p) => p.enabled).map((p) => p.provider));
  return adapters.filter((a) => enabled.has(a.id));
}

/**
 * Text lines for one report (shared by `switchboard capacity` and `doctor`). FR-CAP-03 wording: "remaining" appears
 * only here, on provider-reported figures, and shares are fractions (the provider's percentage divided by 100).
 */
export function providerUsageLines(u: ProviderUsageResult, indent: string): string[] {
  if (u.source === "unknown") return [`${indent}provider-reported usage: unknown (${u.error}; ${u.method})`];
  const head =
    `${indent}provider-reported usage (${u.method}, at ${u.observed_at}): plan ${u.plan ?? "unknown"}, ` +
    `limit reached ${u.limit_reached === null ? "unknown" : u.limit_reached ? `yes${u.limit_reached_type ? ` (${u.limit_reached_type})` : ""}` : "no"}`;
  const lines = [head];
  for (const w of u.windows) {
    const len = w.window_seconds === null ? "length unknown" : `${w.window_seconds} s`;
    lines.push(
      `${indent}  ${w.id} (${len}, provider_reported): used ${w.used_fraction}, remaining ${w.remaining_fraction}, ` +
        `resets ${w.resets_at ?? "unknown"}`,
    );
  }
  if (u.credits !== null) {
    lines.push(
      `${indent}  credits: ${u.credits.unlimited ? "unlimited" : (u.credits.balance ?? "unknown")}` +
        `${u.credits.has_credits ? "" : " (none)"}`,
    );
  }
  return lines;
}
