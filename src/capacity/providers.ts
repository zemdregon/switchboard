/**
 * Provider list for the capacity projection (T6.3; LLD §16.2, §16.3): adapter ids in the caller's order with what the
 * configuration says about each (`providers.<config id>.enabled` and `weight`, the per-provider slot limit). Shared by
 * `get_capacity`, `switchboard capacity` and `doctor` so that the three surfaces show the same projection (FR-OPS-05).
 */
import { configIdForAdapterId } from "../adapters/providers.js";
import type { ResolvedConfig } from "../config/index.js";
import type { CapacityProviderInfo } from "./collect.js";

/** NFR-PERF-03 default (one slot per provider) when the caller passes no limits. */
const DEFAULT_LIMIT = 1;

export function capacityProviders(
  ids: readonly string[],
  config: {
    providers?: ResolvedConfig["providers"];
    limits?: Pick<ResolvedConfig["limits"], "perProviderConcurrency">;
  },
): CapacityProviderInfo[] {
  return ids.map((id) => {
    const configId = configIdForAdapterId(id);
    const entry = configId === undefined ? undefined : config.providers?.get(configId);
    return {
      id,
      enabled: entry?.enabled ?? true,
      weight: entry?.weight ?? null,
      // T6.9: the provider's own limit, else the shared per-provider limit (NFR-PERF-03).
      concurrencyLimit: entry?.concurrency ?? config.limits?.perProviderConcurrency ?? DEFAULT_LIMIT,
    };
  });
}
