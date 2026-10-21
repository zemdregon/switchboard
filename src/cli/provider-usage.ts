/**
 * The provider-reported usage service the real entry point builds (FR-CAP-13, ADR-0079, BR-50). One reader per
 * provider that has one and is registered: today Kimi Code only (`src/adapters/kimi/usage.ts`). `bin.ts` passes this
 * as `CliIo.providerUsage`; tests that call `main` directly never get it, so they never start a provider CLI.
 *
 * Delegated (ADR-0079): the Kimi Code TUI runs in the stable probe directory `<data_dir>/probes/kimi-usage`, so its
 * per-folder trust answer is given once, not once per read (see `src/adapters/kimi/usage.ts`).
 */
import path from "node:path";
import { KimiUsageReader } from "../adapters/kimi/usage.js";
import { type ProviderUsageReader, ProviderUsageService } from "../capacity/index.js";

/** `<data_dir>/probes/kimi-usage`: where the Kimi Code usage TUI runs. */
export function kimiUsageProbeDir(dataDir: string): string {
  return path.join(dataDir, "probes", "kimi-usage");
}

export function defaultProviderUsage(
  adapterIds: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  dataDir: string,
): ProviderUsageService | undefined {
  const readers: ProviderUsageReader[] = [];
  if (adapterIds.includes("kimi")) readers.push(new KimiUsageReader({ env, probeDir: kimiUsageProbeDir(dataDir) }));
  return readers.length === 0 ? undefined : new ProviderUsageService(readers);
}
