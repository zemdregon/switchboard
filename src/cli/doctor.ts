/** `switchboard doctor` (FR-OPS-01): preflight checks, exit code 1 when any check fails. */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  AdapterRegistry,
  type AuthResult,
  configIdForAdapterId,
  createProbeRunner,
  type ProbeResult,
  providerEntries,
  providerEntry,
} from "../adapters/index.js";
import { loadConfig, type ResolvedConfig } from "../config/index.js";
import { currentSchemaVersion, LEDGER_FILE_NAME, MIGRATIONS } from "../ledger/index.js";
import { inspectDataDirLock } from "../lock/index.js";
import { type AppliedOverride, validateProfileOverrides } from "../policy/index.js";
import { gitText, parseGitVersion, versionAtLeast } from "../workspace/git.js";
import { findOrphans, MIN_GIT_VERSION, planRetentionGc } from "../workspace/index.js";
import { type InnerDoctorSection, innerDoctorSection, renderInnerDoctor } from "./inner.js";
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
  readonly probe: {
    readonly ok: boolean;
    readonly binary_version: string | null;
    readonly failed_steps: string[];
  };
  readonly auth: {
    readonly state: AuthResult["state"];
    readonly instruction: string | null;
  };
  /** Version gate (ADR-0009); null when the probe did not produce a version to gate, or for the fake adapter. */
  readonly version_gate: {
    readonly eligible: boolean;
    readonly code: string | null;
    readonly detail: string;
  } | null;
  /** Operator-facing explanation when status is not ok (not installed, version unverified, ...). */
  readonly note: string | null;
  readonly status: CheckStatus;
}

export interface DoctorReport {
  readonly schema_version: number;
  readonly ok: boolean;
  readonly checks: DoctorCheck[];
  readonly adapters: DoctorAdapterReport[];
  /**
   * T11.7 (FR-INN-17): the inner-agent section. Present only when the config has an `inner_agent` section, so the report
   * for a configuration without one is unchanged. Its findings are at most warnings and never change `ok`.
   */
  readonly inner_agent?: InnerDoctorSection;
}

const fmtValue = (v: AppliedOverride["to"]): string => (Array.isArray(v) ? `[${v.join(", ")}]` : String(v));

/**
 * Lists the `profiles.<name>` overrides that change a default (owner decision 12, T3.2). Absent when there are none, so
 * the check list is unchanged for the default configuration. A loosening is a warning: it is valid but weakens the
 * isolation a profile name suggests (R-25).
 */
function checkProfileOverrides(cfg: ResolvedConfig): DoctorCheck | undefined {
  const applied = validateProfileOverrides(cfg.profileOverrides);
  if (applied.length === 0) return undefined;
  const text = applied
    .map((o) => `${o.profile}.${o.field} ${fmtValue(o.from)} -> ${fmtValue(o.to)} (${o.direction})`)
    .join("; ");
  const loosened = applied.some((o) => o.direction === "loosen");
  return check("profiles", "Profile overrides", loosened ? "warn" : "ok", text);
}

/**
 * Lists the MCP clients configured with `privileged_approval: "not_required"` (owner decision 22, ADR-0019) as a warning:
 * their `privileged` requests run without the operator's `approve` step. Absent when no client sets it, so the check
 * list is unchanged for the default configuration.
 */
function checkPrivilegedApproval(cfg: ResolvedConfig): DoctorCheck | undefined {
  const loose = [...cfg.mcpClients.values()].filter((c) => c.privilegedApproval === "not_required").map((c) => c.id);
  if (loose.length === 0) return undefined;
  return check(
    "privileged_approval",
    "Privileged approval",
    "warn",
    `not required for client${loose.length > 1 ? "s" : ""} ${loose.join(", ")}: their privileged requests run ` +
      "without switchboard approve (scope still validated and recorded; Git-write denial and worktrees still apply)",
  );
}

/**
 * FR-INN-15: a warning when the inner agent's backend is declared to draw on a routed provider's subscription, so its
 * calls consume that provider's capacity (each call records one `inner_agent` usage observation). Absent otherwise.
 */
function checkInnerSharedSubscription(cfg: ResolvedConfig): DoctorCheck | undefined {
  const shared = cfg.innerAgent?.backend?.sharesSubscriptionWith;
  if (cfg.innerAgent?.enabled !== true || !shared) return undefined;
  return check(
    "inner_shared_subscription",
    "Inner agent subscription",
    "warn",
    `the inner agent shares the ${shared} subscription: its calls consume ${shared} capacity; each call is recorded as a ` +
      "usage observation labelled inner_agent (not as provider usage, and it does not change capacity_score)",
  );
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

const LIST_CAP = 10;
const listIds = (ids: readonly string[]): string =>
  ids.length <= LIST_CAP ? ids.join(", ") : `${ids.slice(0, LIST_CAP).join(", ")}, and ${ids.length - LIST_CAP} more`;

/**
 * Retention and orphan reporting (T3.12; FR-WS-07, LLD §5). Strictly read-only: the ledger is opened read-only and
 * nothing is deleted. Reports which meta-sessions the configured retention would collect (`switchboard gc` shows the
 * detail, `gc --apply` collects) and the orphan sweep: worktree directories or `switchboard/*` branches with no ledger row.
 */
async function checkRetentionAndOrphans(cfg: ResolvedConfig, now: Date): Promise<DoctorCheck[]> {
  const file = path.join(cfg.dataDir, LEDGER_FILE_NAME);
  if (!existsSync(file)) {
    return [
      check("gc", "Retention GC", "skip", "skipped: no ledger yet"),
      check("orphans", "Orphan sweep", "skip", "skipped: no ledger yet"),
    ];
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const out: DoctorCheck[] = [];
    const plan = planRetentionGc({ db, days: cfg.retention.days, now });
    const ids = plan.units.map((u) => u.sessionId);
    if (cfg.retentionEnabled) {
      out.push(
        check(
          "gc",
          "Retention GC",
          "ok",
          `retention ${cfg.retention.days} days; ${ids.length === 0 ? "no meta-session would be collected" : `${ids.length} meta-session(s) would be collected: ${listIds(ids)} (switchboard gc shows detail; gc --apply collects)`}`,
        ),
      );
    } else {
      out.push(
        check(
          "gc",
          "Retention GC",
          "ok",
          `retention.days is not set, so nothing is collected${ids.length === 0 ? "" : `; ${ids.length} meta-session(s) are idle longer than the ${cfg.retention.days} day default: ${listIds(ids)}`}`,
        ),
      );
    }
    const o = await findOrphans({ db, dataDir: cfg.dataDir });
    const n = o.worktrees.length + o.branches.length;
    const parts = [
      ...o.worktrees.map((w) => `worktree directory ${w}`),
      ...o.branches.map((b) => `branch ${b.branch} (${b.repoRoot})`),
    ];
    const warn = o.warnings.length ? `; ${o.warnings.join("; ")}` : "";
    out.push(
      n === 0
        ? check("orphans", "Orphan sweep", o.warnings.length ? "warn" : "ok", `no orphans found${warn}`)
        : check(
            "orphans",
            "Orphan sweep",
            "warn",
            `${n} orphan(s) with no ledger row, reported only (never removed): ${listIds(parts)}${warn}`,
          ),
    );
    return out;
  } catch (err) {
    return [check("gc", "Retention GC", "warn", `cannot assess: ${(err as Error).message.split("\n")[0]}`)];
  } finally {
    db?.close();
  }
}

/**
 * Every provider registry entry with an adapter (`src/adapters/providers.ts`, T4.1): test-only entries first (the
 * fake), then the real providers in table order.
 */
export function defaultAdapters(): AdapterRegistry {
  const withAdapter = providerEntries().filter((e) => e.create !== undefined);
  const ordered = [...withAdapter.filter((e) => e.kind === "test"), ...withAdapter.filter((e) => e.kind !== "test")];
  const registry = new AdapterRegistry();
  for (const e of ordered) if (e.create) registry.register(e.create({}));
  return registry;
}

/**
 * `providers.<config id>.enabled: false` disables a provider (default on). Doctor reports it as skipped without
 * running it. The fake adapter and adapters with no config id are always probed, as before.
 */
function isDisabledInConfig(cfg: ResolvedConfig | undefined, adapterId: string): boolean {
  if (cfg === undefined) return false;
  const configId = configIdForAdapterId(adapterId);
  return configId !== undefined && cfg.providers.get(configId)?.enabled === false;
}

async function probeAdapters(registry: AdapterRegistry, cfg?: ResolvedConfig): Promise<DoctorAdapterReport[]> {
  const runner = createProbeRunner(PROBE_ENV_ALLOWLIST);
  const out: DoctorAdapterReport[] = [];
  for (const a of registry.list()) {
    const entry = providerEntry(a.id);
    const kind = entry?.kind === "test" ? "fake" : "real";
    const label = entry?.label ?? `${a.id} (real provider)`;
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
    const overrides = checkProfileOverrides(cfg);
    if (overrides) checks.push(overrides);
    const approval = checkPrivilegedApproval(cfg);
    if (approval) checks.push(approval);
    const innerShared = checkInnerSharedSubscription(cfg);
    if (innerShared) checks.push(innerShared);
  } catch (err) {
    checks.push(check("config", "Config", "fail", (err as Error).message));
  }

  if (cfg) {
    checks.push(checkDataDir(cfg.dataDir), checkLedger(cfg.dataDir), checkLock(cfg.dataDir));
    checks.push(...(await checkRetentionAndOrphans(cfg, (io.now ?? (() => new Date()))())));
  } else {
    for (const [id, label] of [
      ["data_dir", "Data directory"],
      ["ledger", "Ledger"],
      ["lock", "Data-dir lock"],
      ["gc", "Retention GC"],
      ["orphans", "Orphan sweep"],
    ] as const) {
      checks.push(check(id, label, "skip", "skipped: config is not valid"));
    }
  }

  const adapters = await probeAdapters(io.adapters ?? defaultAdapters(), cfg);
  const innerAgent = cfg ? await innerDoctorSection(io, cfg) : undefined;
  const ok = checks.every((c) => c.status !== "fail") && adapters.every((a) => a.status !== "fail");
  return {
    schema_version: JSON_SCHEMA_VERSION,
    ok,
    checks,
    adapters,
    ...(innerAgent !== undefined ? { inner_agent: innerAgent } : {}),
  };
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
  if (r.inner_agent !== undefined) lines.push(...renderInnerDoctor(r.inner_agent, MARK));
  lines.push("", r.ok ? "Result: OK" : "Result: FAILED");
  return `${lines.join("\n")}\n`;
}
