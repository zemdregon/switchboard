/**
 * `switchboard adapters version-canary` (T8.5, FR-OPS-02): operator-scheduled check that compares each enabled
 * provider's installed binary version to the last recorded value. On change it reports `ADAPTER_VERSION_UNVERIFIED`
 * until `adapters validate` succeeds. Does not auto-validate or route the new version.
 */
import {
  createProbeRunner,
  emptyVersionCanaryStore,
  evaluateVersionCanary,
  providerEntry,
  readVersionCanaryStore,
  recordAdapterVersion,
  type VersionGateResult,
} from "../adapters/index.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { ProviderId } from "../adapters/types.js";
import { loadConfig, type ResolvedConfig } from "../config/index.js";
import { defaultAdapters, isDisabledInConfig } from "./doctor.js";
import { type CliIo, JSON_SCHEMA_VERSION, PROBE_ENV_ALLOWLIST } from "./io.js";

export type CanaryStatus = "ok" | "warn" | "fail" | "skip";

export interface VersionCanaryAdapterReport {
  readonly id: string;
  readonly label: string;
  readonly status: CanaryStatus;
  readonly binary_version: string | null;
  readonly version_bump: boolean;
  readonly code: string | null;
  readonly detail: string | null;
}

export interface VersionCanaryReport {
  readonly schema_version: number;
  readonly ok: boolean;
  readonly adapters: VersionCanaryAdapterReport[];
}

function applyCanaryGate(
  registry: AdapterRegistry,
  id: ProviderId,
  binaryVersion: string | null,
  store: ReturnType<typeof readVersionCanaryStore>,
): { gate: VersionGateResult; bump: boolean; recordVersion: string | null } {
  const manifestGate = registry.gate(id, binaryVersion);
  return evaluateVersionCanary(manifestGate, id, store);
}

export async function runAdaptersVersionCanary(io: CliIo, argv: readonly string[]): Promise<VersionCanaryReport> {
  let cfg: ResolvedConfig | undefined;
  try {
    cfg = loadConfig({ argv, env: io.env, ...(io.homedir !== undefined ? { homedir: io.homedir } : {}) });
  } catch {
    cfg = undefined;
  }
  const dataDir = cfg?.dataDir;
  const store = dataDir !== undefined ? readVersionCanaryStore(dataDir) : emptyVersionCanaryStore();
  const registry = io.adapters ?? defaultAdapters();
  const runner = createProbeRunner(PROBE_ENV_ALLOWLIST);
  const adapters: VersionCanaryAdapterReport[] = [];
  let ok = true;

  for (const a of registry.list()) {
    const entry = providerEntry(a.id);
    const label = entry?.label ?? `${a.id} (real provider)`;
    const kind = entry?.kind === "test" ? "fake" : "real";
    if (kind === "fake" || isDisabledInConfig(cfg, a.id)) {
      adapters.push({
        id: a.id,
        label,
        status: "skip",
        binary_version: null,
        version_bump: false,
        code: null,
        detail: kind === "fake" ? "test adapter skipped" : "disabled in config",
      });
      continue;
    }
    let binaryVersion: string | null = null;
    try {
      const probe = await a.probe(runner);
      binaryVersion = probe.binaryVersion;
      const failed = probe.steps.some((s) => !s.ok);
      if (failed) {
        adapters.push({
          id: a.id,
          label,
          status: "warn",
          binary_version: binaryVersion,
          version_bump: false,
          code: null,
          detail: "probe failed; version canary not evaluated",
        });
        continue;
      }
    } catch (err) {
      adapters.push({
        id: a.id,
        label,
        status: "warn",
        binary_version: null,
        version_bump: false,
        code: null,
        detail: (err as Error).message,
      });
      continue;
    }

    const { gate, bump, recordVersion } = applyCanaryGate(registry, a.id, binaryVersion, store);
    if (dataDir !== undefined && recordVersion !== null) {
      recordAdapterVersion(dataDir, a.id, recordVersion, io.now ?? (() => new Date()));
    }
    if (bump || !gate.eligible) {
      ok = false;
      adapters.push({
        id: a.id,
        label,
        status: "fail",
        binary_version: binaryVersion,
        version_bump: bump,
        code: gate.eligible ? null : gate.code,
        detail: gate.eligible ? null : gate.detail,
      });
      if (bump && !gate.eligible) {
        io.stderr.write(`[version-canary] ${a.id}: ${gate.code}: ${gate.detail}\n`);
      }
      continue;
    }
    adapters.push({
      id: a.id,
      label,
      status: "ok",
      binary_version: binaryVersion,
      version_bump: false,
      code: null,
      detail: null,
    });
  }

  return { schema_version: JSON_SCHEMA_VERSION, ok, adapters };
}

export function renderAdaptersVersionCanary(r: VersionCanaryReport): string {
  const lines = ["switchboard adapters version-canary", ""];
  for (const a of r.adapters) {
    const mark =
      a.status === "ok" ? "[ok]  " : a.status === "fail" ? "[FAIL]" : a.status === "skip" ? "[skip]" : "[warn]";
    const ver = a.binary_version ? ` version ${a.binary_version}` : "";
    lines.push(`${mark} ${a.label}:${ver}${a.version_bump ? " VERSION BUMP" : ""}`);
    if (a.detail !== null) lines.push(`       ${a.code ?? "note"}: ${a.detail}`);
  }
  lines.push("", r.ok ? "Result: OK" : "Result: FAILED (run adapters validate for bumped providers)");
  return `${lines.join("\n")}\n`;
}
