/**
 * Version canary (T8.5, FR-ADP-03, NFR-PERF-02, FR-OPS-02, WF-9): compares the installed CLI version to the last
 * recorded value on the operator host. A change marks the adapter `ADAPTER_VERSION_UNVERIFIED` until
 * `switchboard adapters validate` succeeds; there is no auto-validate and routing does not trust the new version.
 *
 * The store lives under the data directory (`version-canary.json`). When no row exists yet, the baseline is the
 * manifest's `validated_cli_version` (unless it is the placeholder `unverified-on-this-host`). The preflight cache
 * (NFR-PERF-02) still invalidates on binary identity change; this store tracks the probed version string across
 * restarts and scheduled checks.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { VersionGateResult } from "./manifest/gate.js";

export const VERSION_CANARY_FILENAME = "version-canary.json";

export interface VersionCanaryRecord {
  readonly binary_version: string;
  /** ISO-8601 timestamp when the version was recorded. */
  readonly recorded_at: string;
}

export interface VersionCanaryStore {
  readonly schema_version: 1;
  readonly adapters: Record<string, VersionCanaryRecord>;
}

export interface VersionCanaryEvaluation {
  readonly gate: VersionGateResult;
  /** True when the observed version differs from the baseline (operator must run `adapters validate`). */
  readonly bump: boolean;
  /**
   * When set, the caller may persist this version as the new baseline (stable probe with no bump, or after validate).
   * Routing paths should not write; `doctor` and `adapters version-canary` may.
   */
  readonly recordVersion: string | null;
  /**
   * What the canary compared (decision 75): the full observed string next to its normalised core, and the baseline
   * likewise, so captured evidence shows the exact installed build. Cores are null when absent or unrecognised.
   */
  readonly evidence: VersionCanaryEvidence;
}

export interface VersionCanaryEvidence {
  readonly observed_raw: string | null;
  readonly observed_core: string | null;
  readonly baseline_raw: string | null;
  readonly baseline_core: string | null;
}

export function versionCanaryPath(dataDir: string): string {
  return path.join(dataDir, VERSION_CANARY_FILENAME);
}

export function emptyVersionCanaryStore(): VersionCanaryStore {
  return { schema_version: 1, adapters: {} };
}

export function readVersionCanaryStore(dataDir: string): VersionCanaryStore {
  const file = versionCanaryPath(dataDir);
  if (!existsSync(file)) return emptyVersionCanaryStore();
  try {
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      typeof data === "object" &&
      data !== null &&
      (data as VersionCanaryStore).schema_version === 1 &&
      typeof (data as VersionCanaryStore).adapters === "object" &&
      (data as VersionCanaryStore).adapters !== null
    ) {
      return data as VersionCanaryStore;
    }
  } catch {
    // Corrupt file: fail open to an empty store; the next stable probe re-establishes a baseline.
  }
  return emptyVersionCanaryStore();
}

export function writeVersionCanaryStore(dataDir: string, store: VersionCanaryStore): void {
  mkdirSync(dataDir, { recursive: true });
  const file = versionCanaryPath(dataDir);
  const tmp = `${file}.tmp-${process.pid}`;
  const text = `${JSON.stringify(store, null, 2)}\n`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Baseline for comparison: persisted row first, else manifest `validated_cli_version` when it is a real version. */
export function versionCanaryBaseline(
  store: VersionCanaryStore,
  adapterId: string,
  validatedCliVersion: string | null,
): string | null {
  const row = store.adapters[adapterId]?.binary_version ?? null;
  if (row !== null) return row;
  if (validatedCliVersion === null || validatedCliVersion === "" || validatedCliVersion === "unverified-on-this-host") {
    return null;
  }
  return validatedCliVersion;
}

/**
 * The release core the canary compares (T4.80, ROADMAP §4.2 decision 75): the first `x.y.z` token of a version string,
 * after stripping one trailing build suffix that is exactly `-<7 to 40 hex digits>` (Cursor's commit hash) or
 * `+<anything>` (semver build metadata). Text after whitespace is not part of the token, so raw probe lines such as
 * `codex-cli 0.162.0` and `2.1.294 (Claude Code)` keep working. Any other attached suffix (`-beta`, `-rc1`, `.4`,
 * unknown text) yields null: the caller fails closed.
 */
export function versionCanaryCore(version: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)(\S*)/.exec(version);
  if (!m) return null;
  const [, major, minor, patch, suffix] = m;
  if (suffix !== "" && !/^-[0-9a-fA-F]{7,40}$/.test(suffix ?? "") && !/^\+.+$/.test(suffix ?? "")) return null;
  return `${Number(major)}.${Number(minor)}.${Number(patch)}`;
}

/**
 * Whether two version strings name the same release. The probe reports the CLI's raw version line (Codex prints
 * `codex-cli 0.162.0`, Cursor `2026.10.16-e3cb207`) while a manifest's `validated_cli_version` is the bare
 * major.minor.patch, so the strings are compared by `versionCanaryCore`; identical strings always match, and when
 * either side has no core (no version, or an unrecognised suffix) they do not.
 */
export function sameVersion(a: string, b: string): boolean {
  if (a === b) return true;
  const ca = versionCanaryCore(a);
  const cb = versionCanaryCore(b);
  return ca !== null && cb !== null && ca === cb;
}

/**
 * Applies the version canary on top of a manifest version gate. Read-only with respect to the store; use
 * `recordAdapterVersion` when `recordVersion` is set.
 */
export function evaluateVersionCanary(
  gate: VersionGateResult,
  adapterId: string,
  store: VersionCanaryStore,
): VersionCanaryEvaluation {
  const observed = gate.evidence.observedVersion;
  const baseline = versionCanaryBaseline(store, adapterId, gate.evidence.validatedCliVersion);
  const evidence: VersionCanaryEvidence = {
    observed_raw: observed,
    observed_core: observed === null ? null : versionCanaryCore(observed),
    baseline_raw: baseline,
    baseline_core: baseline === null ? null : versionCanaryCore(baseline),
  };
  if (!gate.eligible || observed === null) {
    return { gate, bump: false, recordVersion: null, evidence };
  }
  if (baseline === null) {
    return { gate, bump: false, recordVersion: observed, evidence };
  }
  if (sameVersion(observed, baseline)) {
    const haveRow = store.adapters[adapterId] !== undefined;
    return { gate, bump: false, recordVersion: haveRow ? null : observed, evidence };
  }
  return {
    gate: {
      eligible: false,
      code: "ADAPTER_VERSION_UNVERIFIED",
      detail:
        `installed ${adapterId} version ${observed} (core ${evidence.observed_core ?? "unrecognised"}) changed since ` +
        `last recorded ${baseline} (core ${evidence.baseline_core ?? "unrecognised"}) ` +
        `(version canary); run switchboard adapters validate ${adapterId}`,
      evidence: gate.evidence,
    },
    bump: true,
    recordVersion: null,
    evidence,
  };
}

export function recordAdapterVersion(
  dataDir: string,
  adapterId: string,
  binaryVersion: string,
  now: () => Date = () => new Date(),
  store?: VersionCanaryStore,
): void {
  const base = store ?? readVersionCanaryStore(dataDir);
  const next: VersionCanaryStore = {
    schema_version: 1,
    adapters: {
      ...base.adapters,
      [adapterId]: { binary_version: binaryVersion, recorded_at: now().toISOString() },
    },
  };
  writeVersionCanaryStore(dataDir, next);
}
