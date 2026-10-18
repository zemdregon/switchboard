/** `switchboard doctor` (FR-OPS-01): preflight checks, exit code 1 when any check fails. */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  AdapterRegistry,
  type AuthResult,
  acceptsReportedModel,
  adapterIdForConfigId,
  configIdForAdapterId,
  createProbeRunner,
  emptyVersionCanaryStore,
  evaluateVersionCanary,
  type ProbeResult,
  type ProviderId,
  providerEntries,
  providerEntry,
  readVersionCanaryStore,
  recordAdapterVersion,
} from "../adapters/index.js";
import type { CapacityProjection } from "../capacity/index.js";
import {
  loadConfig,
  type ResolvedConfig,
  type ResolvedModelGroupMember,
  readModelGroupsFromConfigPath,
} from "../config/index.js";
import {
  describeOuterSandbox,
  detectOuterSandbox,
  type OuterSandboxAvailability,
  outerSandboxRefusal,
} from "../exec/outer-sandbox.js";
import { currentSchemaVersion, LEDGER_FILE_NAME, MIGRATIONS } from "../ledger/index.js";
import { inspectDataDirLock } from "../lock/index.js";
import { type ModelConfig, ModelRegistry } from "../models/index.js";
import { type AppliedOverride, validateProfileOverrides } from "../policy/index.js";
import { gitText, parseGitVersion, versionAtLeast } from "../workspace/git.js";
import {
  assessDiskFloor,
  type DiskProbe,
  diskFloorPaths,
  findOrphans,
  formatMb,
  MB,
  MIN_GIT_VERSION,
  planRetentionGc,
  statfsDiskProbe,
} from "../workspace/index.js";
import { pacingDoctorLine, projectCapacity } from "./capacity.js";
import { type InnerDoctorSection, innerDoctorSection, renderInnerDoctor } from "./inner.js";
import { type CliIo, JSON_SCHEMA_VERSION, PROBE_ENV_ALLOWLIST } from "./io.js";
import { type RagDoctorSection, ragDoctorSection, renderRagDoctor } from "./rag-index.js";
import { TEST_FAKE_ADAPTER_ENV, TEST_FAKE_ADAPTER_VALUE } from "./serve.js";
import { skillsDoctorCheck } from "./skills.js";
import { checkUnprivileged } from "./unprivileged.js";

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

export interface DoctorModelGroupMemberReport {
  readonly provider: string;
  readonly model: string;
  readonly status: "resolved" | "alias" | "unresolvable";
  readonly resolved_id: string | null;
  readonly alias?: string;
  readonly code: string | null;
  readonly detail?: string;
  readonly resolution: string;
}

export interface DoctorModelGroupReport {
  readonly name: string;
  readonly members: readonly DoctorModelGroupMemberReport[];
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
  /**
   * T12.4 (FR-RAG-14): the retrieval-index section. Present only when `rag.embedding` is configured, so the report for a
   * configuration without one is unchanged. Its findings are at most warnings and never change `ok`.
   */
  readonly retrieval?: RagDoctorSection;
  /** T6.3 (LLD §16.3): the `get_capacity` projection for the probed adapters; absent when the config is invalid. */
  readonly capacity?: CapacityProjection;
  /**
   * T7.13 (FR-RTE-10): model groups with each member's current resolution. Present only when model groups are configured,
   * so the report for a configuration without any is unchanged.
   */
  readonly model_groups?: DoctorModelGroupReport[];
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

/**
 * Lists configured notification sinks (T14.14; FR-CTL-10, FR-CTL-12). Absent when none are configured, so the check
 * list is unchanged for the default configuration. For each sink, reports its id, kind and whether authorization
 * (or ntfy token) is set or unset, never echoing the value.
 */
function checkNotificationSinksDoctor(cfg: ResolvedConfig): DoctorCheck | undefined {
  if (cfg.notificationSinks.length === 0) return undefined;
  const parts = cfg.notificationSinks.map((s) => {
    if (s.kind === "webhook") {
      const auth = s.authorization !== undefined ? "set" : "unset";
      return `${s.id} (webhook, authorization: ${auth})`;
    }
    const auth = s.token !== undefined ? "set" : "unset";
    return `${s.id} (ntfy, token: ${auth})`;
  });
  return check("notification_sinks", "Notification sinks", "ok", parts.join("; "));
}

/**
 * T3.1 (ADR-0051, LLD §8.4): outer-sandbox availability, always reported. `ok` when no profile requires it (it is
 * optional hardening, Q-22); with `outer_sandbox.required_profiles` set, `fail` when a required mechanism is missing
 * (those runs are refused, OUTER_SANDBOX_UNAVAILABLE) and `warn` otherwise (still refused: this build does not yet wrap
 * runs, OUTER_SANDBOX_NOT_ENFORCED).
 */
function checkOuterSandbox(cfg: ResolvedConfig | undefined, availability: OuterSandboxAvailability): DoctorCheck {
  const label = "Outer sandbox";
  const summary = describeOuterSandbox(availability);
  const required = cfg?.outerSandboxRequiredProfiles ?? [];
  const first = required[0];
  if (first === undefined) {
    if (cfg?.confinedVerification) {
      const bwrapOk = availability.mechanisms.bubblewrap.available;
      return check(
        "outer_sandbox",
        label,
        bwrapOk ? "ok" : "fail",
        bwrapOk
          ? `confined verification enabled (T3.11); ${summary}`
          : `confined verification enabled but bubblewrap unavailable; ${summary}`,
      );
    }
    return check("outer_sandbox", label, "ok", `not required by config; ${summary}`);
  }
  const refusal = outerSandboxRefusal(first, required, availability);
  const status: CheckStatus = refusal?.reason === "OUTER_SANDBOX_UNAVAILABLE" ? "fail" : "warn";
  return check(
    "outer_sandbox",
    label,
    status,
    `required for ${required.join(", ")}: runs under them are refused (${refusal?.reason}); ${summary}`,
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
 * Orphans are removed by `gc --apply` and `serve` (`collectOrphans`), never here.
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
            `${n} orphan(s) with no ledger row (${cfg.retentionEnabled ? `gc --apply or serve removes each once marked for ${cfg.retention.days} days` : "not removed: retention.days is not set"}): ${listIds(parts)}${warn}`,
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
 * Free-disk floor (T3.23; FR-WS-11). Present only when the config sets `limits.min_free_disk_mb`, so the check list of a
 * configuration without it is unchanged. Probes the nearest existing ancestor of each FR-WS-11 path (the data directory
 * and its worktree root may not exist before the first `serve`). Under the floor: `warn`, never `fail` (the floor
 * holds runs, it does not fail anything, and `doctor` exits 0 for it). Unreadable paths: `warn`, the floor is not
 * enforced for them.
 */
function checkDiskFloor(cfg: ResolvedConfig, probe: DiskProbe): DoctorCheck | undefined {
  const floorMb = cfg.limits.minFreeDiskMb;
  if (floorMb === undefined) return undefined;
  const status = assessDiskFloor({
    minFreeBytes: floorMb * MB,
    paths: [...new Set(diskFloorPaths(cfg.dataDir).map(nearestExisting))],
    probe,
  });
  const floor = `floor ${floorMb} MB (limits.min_free_disk_mb)`;
  if (status.freeBytes === null || status.path === null) {
    return check(
      "disk",
      "Free disk",
      "warn",
      `cannot read free space of ${status.unreadable.join(", ")}; ${floor} is not enforced`,
    );
  }
  const unreadable = status.unreadable.length ? `; unreadable: ${status.unreadable.join(", ")}` : "";
  if (status.below) {
    const sweep = cfg.retentionEnabled
      ? "runs the early GC sweep"
      : "runs the early GC sweep, which collects nothing until retention.days is set";
    return check(
      "disk",
      "Free disk",
      "warn",
      `free ${formatMb(status.freeBytes)} on ${status.path} is under the ${floor}: serve holds new runs in QUEUED (disk_hold) and ${sweep}${unreadable}`,
    );
  }
  return check(
    "disk",
    "Free disk",
    "ok",
    `free ${formatMb(status.freeBytes)} on ${status.path}; ${floor}${unreadable}`,
  );
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
export function isDisabledInConfig(cfg: ResolvedConfig | undefined, adapterId: string): boolean {
  if (cfg === undefined) return false;
  const configId = configIdForAdapterId(adapterId);
  return configId !== undefined && cfg.providers.get(configId)?.enabled === false;
}

async function probeAdapters(
  registry: AdapterRegistry,
  cfg?: ResolvedConfig,
  opts?: { now?: () => Date; models?: ModelRegistry },
): Promise<DoctorAdapterReport[]> {
  const runner = createProbeRunner(PROBE_ENV_ALLOWLIST);
  const versionStore = cfg?.dataDir !== undefined ? readVersionCanaryStore(cfg.dataDir) : emptyVersionCanaryStore();
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
      if (probe !== undefined && opts?.models !== undefined) {
        opts.models.refresh(a.id, probe.modelsListed);
      }
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
        const manifestGate = registry.gate(a.id, probe.binaryVersion);
        const canary =
          cfg?.dataDir !== undefined
            ? evaluateVersionCanary(manifestGate, a.id, versionStore)
            : { gate: manifestGate, bump: false, recordVersion: null };
        const g = canary.gate;
        if (cfg?.dataDir !== undefined && canary.recordVersion !== null) {
          recordAdapterVersion(cfg.dataDir, a.id, canary.recordVersion, opts?.now ?? (() => new Date()));
        }
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

  // NFR-SEC-04: the same check `serve` refuses on; root or an unreadable uid fails doctor.
  const privilege = checkUnprivileged(io.effectiveUid);
  checks.push(
    privilege.ok
      ? check("unprivileged", "Unprivileged user", "ok", `effective uid ${privilege.uid} (not root)`)
      : check("unprivileged", "Unprivileged user", "fail", `${privilege.code}: ${privilege.message}`),
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
    cfg = loadConfig({
      argv,
      env: io.env,
      // The config `serve` would accept under the same environment: `fake` in model groups and subscriptions only
      // with the test-only fake switch (TDD §3.6).
      testFakeAdapter: io.env[TEST_FAKE_ADAPTER_ENV] === TEST_FAKE_ADAPTER_VALUE,
      ...(io.homedir !== undefined ? { homedir: io.homedir } : {}),
    });
    checks.push(check("config", "Config", "ok", cfg.configPath));
    const overrides = checkProfileOverrides(cfg);
    if (overrides) checks.push(overrides);
    const approval = checkPrivilegedApproval(cfg);
    if (approval) checks.push(approval);
    const innerShared = checkInnerSharedSubscription(cfg);
    if (innerShared) checks.push(innerShared);
    const sinks = checkNotificationSinksDoctor(cfg);
    if (sinks) checks.push(sinks);
  } catch (err) {
    checks.push(check("config", "Config", "fail", (err as Error).message));
  }

  if (cfg) {
    checks.push(checkDataDir(cfg.dataDir), checkLedger(cfg.dataDir), checkLock(cfg.dataDir));
    checks.push(...(await checkRetentionAndOrphans(cfg, (io.now ?? (() => new Date()))())));
    const disk = checkDiskFloor(cfg, io.diskProbe ?? statfsDiskProbe);
    if (disk) checks.push(disk);
    checks.push(skillsDoctorCheck(cfg)); // T16.2 (LLD §19.10)
  } else {
    for (const [id, label] of [
      ["data_dir", "Data directory"],
      ["ledger", "Ledger"],
      ["lock", "Data-dir lock"],
      ["gc", "Retention GC"],
      ["orphans", "Orphan sweep"],
      ["skills", "Skills"],
    ] as const) {
      checks.push(check(id, label, "skip", "skipped: config is not valid"));
    }
  }

  checks.push(checkOuterSandbox(cfg, io.outerSandbox ?? (await detectOuterSandbox({ path: io.env.PATH ?? "" }))));

  const registry = io.adapters ?? defaultAdapters();
  const byAdapter = new Map<string, ModelConfig>();
  if (cfg) {
    for (const [configId, modelCfg] of cfg.providerModels) {
      const aId = adapterIdForConfigId(configId);
      if (aId !== undefined) byAdapter.set(aId, modelCfg);
    }
  }
  const models = new ModelRegistry(byAdapter);
  const adapters = await probeAdapters(registry, cfg, { now: io.now ?? (() => new Date()), models });
  const innerAgent = cfg ? await innerDoctorSection(io, cfg) : undefined;
  let retrieval: RagDoctorSection | undefined;
  try {
    retrieval = cfg ? await ragDoctorSection(io, cfg) : undefined;
  } catch {
    retrieval = undefined; // informational: an unreadable ledger or store never fails doctor
  }
  const capacity = cfg ? capacitySection(cfg, registry, (io.now ?? (() => new Date()))()) : undefined;
  const modelGroups = cfg ? modelGroupsSection(cfg, registry, models) : undefined;
  const ok = checks.every((c) => c.status !== "fail") && adapters.every((a) => a.status !== "fail");
  return {
    schema_version: JSON_SCHEMA_VERSION,
    ok,
    checks,
    adapters,
    ...(innerAgent !== undefined ? { inner_agent: innerAgent } : {}),
    ...(retrieval !== undefined ? { retrieval } : {}),
    ...(capacity !== undefined ? { capacity } : {}),
    ...(modelGroups !== undefined ? { model_groups: modelGroups } : {}),
  };
}

/**
 * T7.13 (FR-RTE-10, LLD §17.7): lists configured model groups with each member's current resolution.
 * Informational: it never changes `ok`. Absent when no `model_groups` section is configured.
 */
function modelGroupsSection(
  cfg: ResolvedConfig,
  adapters: AdapterRegistry,
  models: ModelRegistry,
): DoctorModelGroupReport[] | undefined {
  const groups = readModelGroupsFromConfigPath(cfg.configPath);
  const entries = Object.entries(groups);
  if (entries.length === 0) return undefined;
  return entries.map(([name, group]) => ({
    name,
    members: group.members.map((m) => resolveGroupMemberForDoctor(m, cfg, adapters, models)),
  }));
}

export function resolveGroupMemberForDoctor(
  member: ResolvedModelGroupMember,
  cfg: ResolvedConfig,
  adapters: AdapterRegistry,
  models: ModelRegistry,
): DoctorModelGroupMemberReport {
  // 1. Is provider disabled in config?
  if (cfg.providers.get(member.provider)?.enabled === false) {
    return {
      provider: member.provider,
      model: member.model,
      status: "unresolvable",
      resolved_id: null,
      code: "PROVIDER_DISABLED",
      detail: "provider is disabled in config",
      resolution: "PROVIDER_DISABLED",
    };
  }

  // 2. Is adapter registered? A member names a config id, or the test-only fake (no config id) as is.
  const adapterId = adapterIdForConfigId(member.provider) ?? member.provider;
  const adapter = adapters.has(adapterId as ProviderId) ? adapters.get(adapterId as ProviderId) : undefined;
  if (adapter === undefined) {
    return {
      provider: member.provider,
      model: member.model,
      status: "unresolvable",
      resolved_id: null,
      code: "ADAPTER_NOT_REGISTERED",
      detail: `adapter for provider ${member.provider} is not registered`,
      resolution: "ADAPTER_NOT_REGISTERED",
    };
  }

  // 3. Does adapter accept models?
  if (adapter.reportedModelFlag !== undefined && !acceptsReportedModel(adapter)) {
    const detail = adapter.reportedModelFlag.detail;
    return {
      provider: member.provider,
      model: member.model,
      status: "unresolvable",
      resolved_id: null,
      code: "CAPABILITY_MISSING",
      detail,
      resolution: `CAPABILITY_MISSING (${detail})`,
    };
  }

  // 4. Resolve in model registry:
  const resolved = models.resolve(adapter.id, member.model);
  if (!resolved.ok) {
    return {
      provider: member.provider,
      model: member.model,
      status: "unresolvable",
      resolved_id: null,
      code: "CAPABILITY_MISSING",
      detail: resolved.detail,
      resolution: `CAPABILITY_MISSING (${resolved.detail})`,
    };
  }

  // 5. Resolved:
  if (resolved.source === "alias") {
    return {
      provider: member.provider,
      model: member.model,
      status: "alias",
      resolved_id: resolved.model,
      alias: member.model,
      code: null,
      resolution: `alias -> ${resolved.model}`,
    };
  }

  return {
    provider: member.provider,
    model: member.model,
    status: "resolved",
    resolved_id: resolved.model,
    code: null,
    resolution: resolved.model,
  };
}

/**
 * T6.3 (LLD §16.3): one capacity line per adapter from the same projection as `get_capacity`. Informational: it never
 * changes `ok`. A ledger that cannot be read leaves the section out rather than failing `doctor`.
 */
function capacitySection(cfg: ResolvedConfig, registry: AdapterRegistry, now: Date): CapacityProjection | undefined {
  try {
    return projectCapacity(
      cfg,
      registry.list().map((a) => a.id),
      now,
    );
  } catch {
    return undefined;
  }
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
  if (r.retrieval !== undefined) lines.push(...renderRagDoctor(r.retrieval, MARK));
  if (r.capacity !== undefined) {
    // FR-CAP-03: labelled as estimates; no remaining or quota wording (see `switchboard capacity` for detail).
    lines.push("", "Capacity (controller estimates, not provider quota; details: switchboard capacity):");
    for (const c of r.capacity.providers) {
      lines.push(
        `       ${c.provider}: breaker ${c.breaker.state}, throttle risk ${c.throttle_risk}, ` +
          `estimate confidence ${c.confidence.toFixed(2)}`,
      );
    }
    // T6.14 (LLD §16.9): one line per subscription from the same projection. Absent when nothing is configured.
    if (r.capacity.pacing !== undefined) {
      for (const sub of r.capacity.pacing) lines.push(pacingDoctorLine(sub));
    }
    // T6.7 (FR-CAP-08): per-project kept versus switched counts, summed; details in `switchboard capacity`.
    const kept = r.capacity.affinity.projects.reduce((n, pr) => n + pr.kept, 0);
    const switched = r.capacity.affinity.projects.reduce(
      (n, pr) => n + Object.values(pr.switched).reduce((m, v) => m + v, 0),
      0,
    );
    lines.push(
      `       projects: ${r.capacity.affinity.projects.length}, runs that kept provider and model ${kept}, ` +
        `switched ${switched}`,
    );
  }
  if (r.model_groups !== undefined && r.model_groups.length > 0) {
    lines.push("", "Model groups:");
    for (const g of r.model_groups) {
      lines.push(`       ${g.name}:`);
      for (const m of g.members) {
        lines.push(`         ${m.provider}/${m.model}: ${m.resolution}`);
      }
    }
  }
  lines.push("", r.ok ? "Result: OK" : "Result: FAILED");
  return `${lines.join("\n")}\n`;
}
