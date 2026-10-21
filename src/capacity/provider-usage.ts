/**
 * Provider-reported plan usage (FR-CAP-13, ADR-0079, BR-50): the figures a provider CLI shows in its own usage display,
 * read through that CLI with the CLI's own login. Switchboard never reads a credential, never calls a provider API
 * itself and never stores these figures in the ledger (ADR-0003); a report lives in memory for a short time only.
 *
 * Provider-neutral: each provider plugs in a {@link ProviderUsageReader} (the Kimi Code one is
 * `src/adapters/kimi/usage.ts`). {@link ProviderUsageService} caches one report per provider and shares one in-flight
 * read between concurrent callers, so `get_capacity` polled in a loop starts at most one provider CLI per TTL.
 * Every report is `source: "provider_reported"` (BR-50): the values are the provider's, never an estimate.
 */

/** One quota window as the provider reported it. Fractions are 0..1, rounded to 6 decimal places. */
export interface ProviderUsageWindow {
  /** Stable id within the provider (`5h`, `weekly`, `monthly` for Kimi Code). */
  id: string;
  /** The provider's own label, for display. */
  label: string;
  used_fraction: number;
  /** `1 - used_fraction`, as reported (provider-reported, never an estimate; FR-CAP-03). */
  remaining_fraction: number;
  /** Granularity of the reported value: 0.01 for a rounded whole percent. */
  precision: number;
  /** When the window resets, if the provider said; derived from a relative hint, so approximate. */
  reset_at: string | null;
  /** Granularity of `reset_at` in seconds (60 for a minute-resolution hint), or null with no reset. */
  reset_precision_seconds: number | null;
  /** Optional split of `used_fraction` by the provider's own categories (Kimi Code: `kimi`, `code`). */
  breakdown?: Record<string, number>;
}

/** A money figure the provider reported (for example a top-up wallet). `amount` null when it could not be read. */
export interface ProviderUsageBalance {
  id: string;
  label: string;
  amount: number | null;
  currency: string | null;
  unlimited?: true;
}

interface ReportBase {
  provider: string;
  source: "provider_reported";
  observed_at: string;
  /** How the figures were obtained, in words (no path, no command line, no credential). */
  via: string;
}

export type ProviderUsageReport =
  | (ReportBase & { status: "ok"; windows: ProviderUsageWindow[]; balances: ProviderUsageBalance[] })
  | (ReportBase & { status: "unavailable"; reason: string });

/** Reads one provider's usage. Implementations must not throw for expected failures; they return `unavailable`. */
export interface ProviderUsageReader {
  readonly provider: string;
  readonly via: string;
  read(now: Date): Promise<ProviderUsageReport>;
}

export interface ProviderUsageServiceOptions {
  /** How long an `ok` report is reused. Default 300 000 ms (Proposed: a plan window moves slowly). */
  readonly ttlMs?: number;
  /** How long an `unavailable` report is reused. Default 60 000 ms (Proposed). */
  readonly failureTtlMs?: number;
  readonly now?: () => Date;
}

export const DEFAULT_PROVIDER_USAGE_TTL_MS = 300_000;
export const DEFAULT_PROVIDER_USAGE_FAILURE_TTL_MS = 60_000;

/** Reason used when a reader throws: generic, because the error text could carry anything. */
export const PROVIDER_USAGE_READER_FAILED = "the usage reader failed unexpectedly";

/** Rounds a fraction to 6 decimal places (the precision every window fraction is published with). */
export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** In-memory cache over a set of readers. No ledger writes, no migration. */
export class ProviderUsageService {
  readonly #readers = new Map<string, ProviderUsageReader>();
  readonly #cache = new Map<string, { report: ProviderUsageReport; expires: number }>();
  readonly #inflight = new Map<string, Promise<ProviderUsageReport>>();
  readonly #ttl: number;
  readonly #failureTtl: number;
  readonly #now: () => Date;

  constructor(readers: readonly ProviderUsageReader[], opts: ProviderUsageServiceOptions = {}) {
    for (const r of readers) this.#readers.set(r.provider, r);
    this.#ttl = opts.ttlMs ?? DEFAULT_PROVIDER_USAGE_TTL_MS;
    this.#failureTtl = opts.failureTtlMs ?? DEFAULT_PROVIDER_USAGE_FAILURE_TTL_MS;
    this.#now = opts.now ?? (() => new Date());
  }

  /** Providers with a reader, in registration order. */
  providers(): string[] {
    return [...this.#readers.keys()];
  }

  /** The cached or a fresh report; undefined when no reader is registered for `provider`. */
  async get(provider: string): Promise<ProviderUsageReport | undefined> {
    const reader = this.#readers.get(provider);
    if (reader === undefined) return undefined;
    const cached = this.#cache.get(provider);
    if (cached !== undefined && this.#now().getTime() < cached.expires) return cached.report;
    const pending = this.#inflight.get(provider);
    if (pending !== undefined) return pending;
    const p = this.#read(reader).finally(() => this.#inflight.delete(provider));
    this.#inflight.set(provider, p);
    return p;
  }

  async #read(reader: ProviderUsageReader): Promise<ProviderUsageReport> {
    const at = this.#now();
    let report: ProviderUsageReport;
    try {
      report = await reader.read(at);
    } catch {
      report = {
        status: "unavailable",
        provider: reader.provider,
        source: "provider_reported",
        observed_at: at.toISOString(),
        via: reader.via,
        reason: PROVIDER_USAGE_READER_FAILED,
      };
    }
    const ttl = report.status === "ok" ? this.#ttl : this.#failureTtl;
    this.#cache.set(reader.provider, { report, expires: this.#now().getTime() + ttl });
    return report;
  }
}

/**
 * Adds `provider_usage` to each enabled provider entry the service has a reader for, reading them in parallel. Other
 * entries are returned as they were (same object), so output without a reader is byte-identical. Disabled providers
 * are not read (**Delegated**, least privilege: a provider the operator turned off is not started for a status line).
 */
export async function attachProviderUsage<
  E extends { provider: string; enabled: boolean; provider_usage?: ProviderUsageReport },
  P extends { providers: E[] },
>(projection: P, service: ProviderUsageService | undefined): Promise<P> {
  if (service === undefined) return projection;
  const known = new Set(service.providers());
  const providers = await Promise.all(
    projection.providers.map(async (entry) => {
      if (!entry.enabled || !known.has(entry.provider)) return entry;
      const report = await service.get(entry.provider);
      return report === undefined ? entry : { ...entry, provider_usage: report };
    }),
  );
  return { ...projection, providers };
}
