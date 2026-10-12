/** `switchboard doctor` (FR-OPS-01): preflight checks, exit code 1 when any check fails. */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import {
  AdapterRegistry,
  type AuthResult,
  ClaudeAdapter,
  CodexAdapter,
  createProbeRunner,
  type ProbeResult,
} from "../adapters/index.js";
import { loadConfig, type ResolvedConfig } from "../config/index.js";
import { currentSchemaVersion, LEDGER_FILE_NAME, MIGRATIONS } from "../ledger/index.js";
import { inspectDataDirLock } from "../lock/index.js";
import { CONFIG_TO_ADAPTER_ID } from "../routing/index.js";
import { gitText, parseGitVersion, versionAtLeast } from "../workspace/git.js";
import { MIN_GIT_VERSION } from "../workspace/index.js";
import { type CliIo, JSON_SCHEMA_VERSION, PROBE_ENV_ALLOWLIST } from "./io.js";

/** Minimum Node major from package.json `engines` (>=22). */
export const MIN_NODE_MAJOR = 22;

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorAdapterReport {
  readonly id: string;
  /** Proposed: says whether this is a real provider CLI or the fake test adapter. */
  readonly label: string;
  /** `real` for a provider CLI, `fake` for the test stand-in. */
  readonly kind: "real" | "fake";
  readonly probe: { readonly ok: boolean; readonly binary_version: string | null; readonly failed_steps: string[] };
  readonly auth: { readonly state: AuthResult["state"]; readonly instruction: string | null };
  /** Version gate (ADR-0009); null when the probe did not produce a version to gate, or for the fake adapter. */
  readonly version_gate: { readonly eligible: boolean; readonly code: string | null; readonly detail: string } | null;
  /** Operator-facing explanation when status is not ok (not installed, version unverified, ...). */
  readonly note: string | null;
  readonly status: CheckStatus;
}

export interface DoctorReport {
  readonly schema_version: number;
  readonly ok: boolean;
  readonly checks: DoctorCheck[];
  readonly adapters: DoctorAdapterReport[];
}

const check = (id: string, label: string, status: CheckStatus, detail: string): DoctorCheck => ({
  id,
  label,
  status,
  detail,
});

function nearestExisting(p: string): string {
  let cur = p;
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
}

function checkDataDir(dataDir: string): DoctorCheck {
  const target = nearestExisting(dataDir);
  try {
    if (!statSync(target).isDirectory())
      return check("data_dir", "Data directory", "fail", `${target} is not a directory`);
    accessSync(target, constants.W_OK);
    const note = target === dataDir ? "" : " (will be created on first use)";
    return check("data_dir", "Data directory", "ok", `${dataDir} is writable${note}`);
  } catch {
    return check("data_dir", "Data directory", "fail", `${target} is not writable`);
  }
}

function checkLedger(dataDir: string): DoctorCheck {
  const file = path.join(dataDir, LEDGER_FILE_NAME);
  const latest = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  if (!existsSync(file)) return check("ledger", "Ledger", "warn", `${file} does not exist yet; serve creates it`);
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const v = currentSchemaVersion(db);
    if (v > latest)
      return check("ledger", "Ledger", "fail", `schema version ${v} is newer than this build (${latest})`);
    if (v < latest) return check("ledger", "Ledger", "warn", `schema version ${v}; ${latest} pending (serve migrates)`);
    return check("ledger", "Ledger", "ok", `${file} opens, schema version ${v} (current)`);
  } catch (err) {
    return check("ledger", "Ledger", "fail", `cannot open ${file}: ${(err as Error).message.split("\n")[0]}`);
  } finally {
    db?.close();
  }
}

function checkLock(dataDir: string): DoctorCheck {
  const s = inspectDataDirLock(dataDir);
  if (s.state === "free") return check("lock", "Data-dir lock", "ok", "no serve daemon holds the lock");
  if (s.state === "held") return check("lock", "Data-dir lock", "ok", `held by serve daemon (pid ${s.pid})`);
  return check(
    "lock",
    "Data-dir lock",
    "warn",
    `stale lock file ${s.lockPath} (owner not running); next serve replaces it`,
  );
}

export function defaultAdapters(): AdapterRegistry {
  return new AdapterRegistry().register(new FakeAdapter()).register(new ClaudeAdapter()).register(new CodexAdapter());
}

const ADAPTER_LABELS: Readonly<Record<string, string>> = {
  fake: "fake adapter (test stand-in, not a real provider)",
  claude: "Claude Code (real provider)",
  codex: "Codex (real provider)",
};

/**
 * `providers.<config id>.enabled: false` disables a provider (default on). Doctor reports it as skipped without
 * running it. The fake adapter and adapters with no config id are always probed, as before.
 */
function isDisabledInConfig(cfg: ResolvedConfig | undefined, adapterId: string): boolean {
  if (cfg === undefined) return false;
  const configId = (Object.keys(CONFIG_TO_ADAPTER_ID) as (keyof typeof CONFIG_TO_ADAPTER_ID)[]).find(
    (k) => CONFIG_TO_ADAPTER_ID[k] === adapterId,
  );
  return configId !== undefined && cfg.providers.get(configId)?.enabled === false;
}

async function probeAdapters(registry: AdapterRegistry, cfg?: ResolvedConfig): Promise<DoctorAdapterReport[]> {
  const runner = createProbeRunner(PROBE_ENV_ALLOWLIST);
  const out: DoctorAdapterReport[] = [];
  for (const a of registry.list()) {
    const kind = a.id === "fake" ? "fake" : "real";
    const label = ADAPTER_LABELS[a.id] ?? `${a.id} (real provider)`;
    if (isDisabledInConfig(cfg, a.id)) {
      out.push({
        id: a.id,
        label,
        kind,
        probe: { ok: false, binary_version: null, failed_steps: [] },
        auth: { state: "UNKNOWN", instruction: null },
        version_gate: null,
        note: "disabled in config (providers.enabled is false); not probed",
        status: "skip",
      });
      continue;
    }
    let probe: ProbeResult | undefined;
    let probeError: string | undefined;
    try {
      probe = await a.probe(runner);
    } catch (err) {
      probeError = (err as Error).message;
    }
    const failed = probe ? probe.steps.filter((s) => !s.ok).map((s) => s.step) : ["probe"];
    const probeOk = probe !== undefined && failed.length === 0;
    let auth: AuthResult = { state: "UNKNOWN", reason: probeError ?? "probe failed; auth not checked" };
    if (probeOk) {
      try {
        auth = await a.authPreflight(runner);
      } catch (err) {
        auth = { state: "UNKNOWN", reason: (err as Error).message };
      }
    }
    const instruction =
      auth.state === "AUTH_REQUIRED" ? auth.loginCommand : auth.state === "UNKNOWN" ? auth.reason : null;
    const notInstalled = probe?.steps.some((s) => s.step === "binary" && !s.ok) === true;
    // Version gate (ADR-0009) applies to real providers once a binary was found; the fake has no manifest.
    let versionGate: DoctorAdapterReport["version_gate"] = null;
    if (kind === "real" && probe !== undefined && !notInstalled) {
      try {
        const g = registry.gate(a.id, probe.binaryVersion);
        versionGate = g.eligible
          ? { eligible: true, code: null, detail: `version ${probe.binaryVersion} is in the validated range` }
          : { eligible: false, code: g.code, detail: g.detail };
      } catch (err) {
        versionGate = { eligible: false, code: "ADAPTER_VERSION_UNVERIFIED", detail: (err as Error).message };
      }
    }
    // Proposed: a real provider that is not installed is a warning (doctor does not require any one CLI). A fake or
    // otherwise failed probe fails doctor. An installed real CLI that the version gate rejects fails, with the reason.
    // Missing auth is a warning (printed with its instruction, exit stays 0).
    let status: CheckStatus;
    let note: string | null = null;
    if (kind === "real" && notInstalled) {
      status = "warn";
      note = `not installed: ${a.id} CLI not found; install it and log in natively to use this provider`;
    } else if (!probeOk) {
      status = "fail";
    } else if (versionGate !== null && !versionGate.eligible) {
      status = "fail";
      note = `${versionGate.code ?? "ADAPTER_VERSION_UNVERIFIED"}: ${versionGate.detail}; adapter is ineligible until an operator validates this version`;
    } else {
      status = auth.state === "OK" ? "ok" : "warn";
    }
    out.push({
      id: a.id,
      label,
      kind,
      probe: { ok: probeOk, binary_version: probe?.binaryVersion ?? null, failed_steps: failed.filter(() => !probeOk) },
      auth: { state: auth.state, instruction },
      version_gate: versionGate,
      note,
      status,
    });
  }
  return out;
}

export async function runDoctor(io: CliIo, argv: readonly string[]): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const nodeVersion = io.nodeVersion ?? process.versions.node;
  const major = Number.parseInt(nodeVersion.split(".")[0] ?? "", 10);
  checks.push(
    check("node", "Node.js", major >= MIN_NODE_MAJOR ? "ok" : "fail", `${nodeVersion} (need >= ${MIN_NODE_MAJOR})`),
  );

  const need = MIN_GIT_VERSION.join(".");
  try {
    const out = await gitText(["--version"]);
    const v = parseGitVersion(out);
    checks.push(
      !v
        ? check("git", "Git", "fail", `cannot parse version from ${JSON.stringify(out)}`)
        : check("git", "Git", versionAtLeast(v, MIN_GIT_VERSION) ? "ok" : "fail", `${v.join(".")} (need >= ${need})`),
    );
  } catch {
    checks.push(check("git", "Git", "fail", `git not found or not runnable (need >= ${need})`));
  }

  let cfg: ResolvedConfig | undefined;
  try {
    cfg = loadConfig({ argv, env: io.env, ...(io.homedir !== undefined ? { homedir: io.homedir } : {}) });
    checks.push(check("config", "Config", "ok", cfg.configPath));
  } catch (err) {
    checks.push(check("config", "Config", "fail", (err as Error).message));
  }

  if (cfg) {
    checks.push(checkDataDir(cfg.dataDir), checkLedger(cfg.dataDir), checkLock(cfg.dataDir));
  } else {
    for (const [id, label] of [
      ["data_dir", "Data directory"],
      ["ledger", "Ledger"],
      ["lock", "Data-dir lock"],
    ] as const) {
      checks.push(check(id, label, "skip", "skipped: config is not valid"));
    }
  }

  const adapters = await probeAdapters(io.adapters ?? defaultAdapters(), cfg);
  const ok = checks.every((c) => c.status !== "fail") && adapters.every((a) => a.status !== "fail");
  return { schema_version: JSON_SCHEMA_VERSION, ok, checks, adapters };
}

const MARK: Record<CheckStatus, string> = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]", skip: "[skip]" };

export function renderDoctor(r: DoctorReport): string {
  const lines = ["switchboard doctor", ""];
  for (const c of r.checks) lines.push(`${MARK[c.status]} ${c.label}: ${c.detail}`);
  lines.push("", "Adapters (preflight):");
  for (const a of r.adapters) {
    if (a.status === "skip") {
      lines.push(`${MARK[a.status]} ${a.label}: disabled in config`);
      if (a.note !== null) lines.push(`       ${a.note}`);
      continue;
    }
    const probe = a.probe.ok
      ? `probe ok${a.probe.binary_version ? ` (version ${a.probe.binary_version})` : ""}`
      : `probe failed (${a.probe.failed_steps.join(", ")})`;
    lines.push(`${MARK[a.status]} ${a.label}: ${probe}; auth ${a.auth.state}`);
    if (a.note !== null) lines.push(`       ${a.note}`);
    if (a.auth.instruction !== null) {
      lines.push(
        `       ${a.auth.state === "AUTH_REQUIRED" ? "AUTH_REQUIRED, run natively" : "reason"}: ${a.auth.instruction}`,
      );
    }
  }
  lines.push("", r.ok ? "Result: OK" : "Result: FAILED");
  return `${lines.join("\n")}\n`;
}
