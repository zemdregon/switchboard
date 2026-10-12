/** `switchboard doctor` (FR-OPS-01): preflight checks, exit code 1 when any check fails. */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type AuthResult, createProbeRunner, type ProbeResult } from "../adapters/index.js";
import { loadConfig, type ResolvedConfig } from "../config/index.js";
import { currentSchemaVersion, LEDGER_FILE_NAME, MIGRATIONS } from "../ledger/index.js";
import { inspectDataDirLock } from "../lock/index.js";
import { gitText, parseGitVersion, versionAtLeast } from "../workspace/git.js";
import { MIN_GIT_VERSION } from "../workspace/index.js";
import { type CliIo, JSON_SCHEMA_VERSION } from "./io.js";

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
  /** Proposed: M1 only registers the fake adapter, and says so. */
  readonly label: string;
  readonly probe: { readonly ok: boolean; readonly binary_version: string | null; readonly failed_steps: string[] };
  readonly auth: { readonly state: AuthResult["state"]; readonly instruction: string | null };
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
  return new AdapterRegistry().register(new FakeAdapter());
}

async function probeAdapters(registry: AdapterRegistry): Promise<DoctorAdapterReport[]> {
  const runner = createProbeRunner();
  const out: DoctorAdapterReport[] = [];
  for (const a of registry.list()) {
    const label = a.id === "fake" ? "fake adapter (M1 stand-in; real providers arrive in M2)" : a.id;
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
    // Proposed: a failed probe fails doctor; missing auth is a warning (printed with its instruction, exit stays 0).
    const status: CheckStatus = !probeOk ? "fail" : auth.state === "OK" ? "ok" : "warn";
    out.push({
      id: a.id,
      label,
      probe: { ok: probeOk, binary_version: probe?.binaryVersion ?? null, failed_steps: failed.filter(() => !probeOk) },
      auth: { state: auth.state, instruction },
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

  const adapters = await probeAdapters(io.adapters ?? defaultAdapters());
  const ok = checks.every((c) => c.status !== "fail") && adapters.every((a) => a.status !== "fail");
  return { schema_version: JSON_SCHEMA_VERSION, ok, checks, adapters };
}

const MARK: Record<CheckStatus, string> = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]", skip: "[skip]" };

export function renderDoctor(r: DoctorReport): string {
  const lines = ["switchboard doctor", ""];
  for (const c of r.checks) lines.push(`${MARK[c.status]} ${c.label}: ${c.detail}`);
  lines.push("", "Adapters (preflight):");
  for (const a of r.adapters) {
    const probe = a.probe.ok
      ? `probe ok${a.probe.binary_version ? ` (version ${a.probe.binary_version})` : ""}`
      : `probe failed (${a.probe.failed_steps.join(", ")})`;
    lines.push(`${MARK[a.status]} ${a.label}: ${probe}; auth ${a.auth.state}`);
    if (a.auth.instruction !== null) {
      lines.push(
        `       ${a.auth.state === "AUTH_REQUIRED" ? "AUTH_REQUIRED, run natively" : "reason"}: ${a.auth.instruction}`,
      );
    }
  }
  lines.push("", r.ok ? "Result: OK" : "Result: FAILED");
  return `${lines.join("\n")}\n`;
}
