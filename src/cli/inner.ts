/**
 * Inner-agent operator surfaces (T11.7; FR-INN-17, LLD §13.5, §13.8, ADR-0016): the `doctor` inner-agent section,
 * `inner status`, `inner test <task>` and `inner resume <task>`.
 *
 * Privacy rules these commands keep (FR-INN-16):
 * - nothing here prints a prompt, a response, a header, a key or a base URL's userinfo/query: a backend is shown as its
 *   origin (scheme, host, port) only, backend `detail` strings are reduced to a short code, and counts, hashes-free
 *   sizes and codes are all that is read from the ledger;
 * - `status` never contacts the backend; `doctor` contacts it only for a canary and only when the backend is `local` or
 *   `allow_remote` is set (never a `remote` backend otherwise); `inner test` sends a built-in synthetic fixture that
 *   carries no repository data (`src/inner/fixture.ts`) through the real pipeline, so the same gates apply.
 *
 * Delegated choices (Assumptions, recorded in ROADMAP T11.7): with no `inner_agent` section `doctor` adds nothing (its
 * output stays byte-identical to before) while `inner status` reports `off`; inner-agent findings in `doctor` are at
 * most warnings and never change its exit code (FR-INN-08: the inner agent never fails a run, so it does not fail the
 * preflight); `doctor` and `inner status` read the ledger read-only; `inner test` and `inner resume` write to the
 * ledger and follow the `approve` locking pattern (take the data-directory lock when free, still write while a
 * `serve` daemon holds it); the circuit breaker lives in the daemon's memory (LLD §13.4 step 6), so the CLI cannot see
 * it: the reported state is this process's own and starts `closed`.
 */
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import Database from "better-sqlite3";
import { loadConfig, type ResolvedConfig } from "../config/index.js";
import { INNER_FIXTURES } from "../inner/fixture.js";
import {
  classifyAddress,
  createConfiguredInnerAgent,
  INNER_DEFAULTS,
  INNER_TASKS,
  type InnerAgentDeps,
  type InnerAgentService,
  type InnerAgentSettings,
  type InnerBackend,
  type InnerTask,
  PROMPT_PROVIDER_NAMES,
} from "../inner/index.js";
import {
  createLedger,
  type InnerCallOutcome,
  type InnerSuspensionBasis,
  LEDGER_FILE_NAME,
  openLedger,
} from "../ledger/index.js";
import { acquireDataDirLock, inspectDataDirLock, LockError } from "../lock/index.js";
import type { CheckStatus, DoctorCheck } from "./doctor.js";
import { type CliIo, JSON_SCHEMA_VERSION, UsageError } from "./io.js";

// ---- shared helpers ------------------------------------------------------------------------------------------------

const OUTCOMES: readonly InnerCallOutcome[] = [
  "accepted",
  "rejected_validator",
  "rejected_sanitiser",
  "fallback_unavailable",
  "fallback_suspended",
  "fallback_disabled",
];

export function parseInnerTask(value: string | undefined): InnerTask {
  if (value === undefined || !(INNER_TASKS as readonly string[]).includes(value)) {
    throw new UsageError(`expected a task: ${INNER_TASKS.join(", ")}`);
  }
  return value as InnerTask;
}

function load(io: CliIo, argv: readonly string[]): ResolvedConfig {
  return loadConfig({ argv, env: io.env, ...(io.homedir !== undefined ? { homedir: io.homedir } : {}) });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: printing untrusted text, so controls are stripped
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/gu;
/** A string that came from a backend (a model id): single line, no controls, bounded. */
const safeText = (s: string, max = 80): string => s.replace(CONTROL, "").slice(0, max);
/** A reason or detail reduced to a short code; anything else is dropped. */
const safeCode = (s: string | null | undefined): string | null =>
  s !== null && s !== undefined && /^[A-Za-z0-9_]{1,40}$/u.test(s) ? s : null;

/** `scheme://host[:port]` of a base URL: never userinfo, path or query. */
function originOf(baseUrl: string | undefined): string | null {
  if (baseUrl === undefined) return null;
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

// ---- views ----------------------------------------------------------------------------------------------------------

export type InnerLocality = "local" | "remote" | "unresolved";

export interface InnerBackendView {
  kind: "http" | "cli";
  /** Origin only (scheme, host, port); null for the `cli` kind. */
  endpoint: string | null;
  provider: string | null;
  model: string;
  /** Classification without a lookup: an IP literal is classified, a host name is `unresolved` until connect time. */
  locality: InnerLocality;
  /** `private` marks an RFC 1918 style literal (still `remote` for the gates). */
  address_class: "loopback" | "private" | "remote" | null;
  allow_remote: boolean;
  timeout_ms: number;
  shares_subscription_with: string | null;
  /** False for the `cli` kind until it is verified and implemented (LLD §13.2 Ineligible rule). */
  eligible: boolean;
}

export interface InnerTaskView {
  task: InnerTask;
  enabled: boolean;
  mode: string | null;
  allow_source_content: boolean;
  suspended: boolean;
  suspended_at: string | null;
  suspended_basis: InnerSuspensionBasis | null;
  resumed_at: string | null;
  calls: Record<InnerCallOutcome, number>;
  total_calls: number;
  /** `fallback_*` outcomes over all recorded calls; null when there are none. */
  fallback_rate: number | null;
  /** The quality window of LLD §13.4 step 11 (since the last resume): the same evidence the suspension uses. */
  window: { calls: number; rejected: number; rejection_rate: number | null; threshold: number; min_calls: number };
}

export type InnerAgentStateName = "off" | "no_backend" | "ready";

export interface InnerAgentView {
  state: InnerAgentStateName;
  enabled: boolean;
  backend: InnerBackendView | null;
  breaker_state: string;
  /** `absent` (no ledger yet), `present`, or `no_inner_tables` (a ledger that predates the inner-agent migrations). */
  ledger: "absent" | "present" | "no_inner_tables";
  tasks: InnerTaskView[];
}

function describeBackend(settings: InnerAgentSettings | undefined): InnerBackendView | null {
  const b = settings?.backend;
  if (settings === undefined || b === undefined) return null;
  let locality: InnerLocality = "unresolved";
  let addressClass: InnerBackendView["address_class"] = null;
  if (b.kind === "cli") {
    locality = "remote"; // LLD §13.2: the cli kind is always remote (Proposed)
  } else if (b.baseUrl !== undefined) {
    try {
      const raw = new URL(b.baseUrl).hostname;
      const host = raw.startsWith("[") ? raw.slice(1, -1) : raw;
      if (net.isIP(host) !== 0) {
        addressClass = classifyAddress(host);
        locality = addressClass === "loopback" ? "local" : "remote";
      }
    } catch {
      locality = "remote"; // unparsable: fail closed
    }
  }
  return {
    kind: b.kind,
    endpoint: originOf(b.baseUrl),
    provider: b.provider ?? null,
    model: safeText(b.model),
    locality,
    address_class: addressClass,
    allow_remote: b.allowRemote,
    timeout_ms: b.timeoutMs,
    shares_subscription_with: b.sharesSubscriptionWith,
    eligible: b.kind === "http",
  };
}

interface StateRow {
  task: string;
  suspended: number;
  suspended_at: string | null;
  suspended_basis_json: string | null;
  resumed_at: string | null;
}

function hasTable(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** Read-only: one view per task from the ledger. No ledger, or no inner tables, reads as no calls and not suspended. */
function readTaskViews(
  dataDir: string,
  settings: InnerAgentSettings | undefined,
  taskEnabled: (t: InnerTask) => boolean,
): { ledger: InnerAgentView["ledger"]; tasks: InnerTaskView[] } {
  const susp = settings?.suspension ?? {
    windowCalls: INNER_DEFAULTS.suspension.windowCalls,
    minCalls: INNER_DEFAULTS.suspension.minCalls,
    rejectionThreshold: INNER_DEFAULTS.suspension.rejectionThreshold,
  };
  const file = path.join(dataDir, LEDGER_FILE_NAME);
  let db: Database.Database | undefined;
  let ledger: InnerAgentView["ledger"] = "absent";
  const states = new Map<string, StateRow>();
  const counts = new Map<string, Record<string, number>>();
  const windows = new Map<string, { calls: number; rejected: number }>();
  try {
    if (existsSync(file)) {
      db = new Database(file, { readonly: true, fileMustExist: true });
      const hasCalls = hasTable(db, "inner_call");
      ledger = hasCalls ? "present" : "no_inner_tables";
      if (hasTable(db, "inner_task_state")) {
        for (const r of db
          .prepare("SELECT task, suspended, suspended_at, suspended_basis_json, resumed_at FROM inner_task_state")
          .all() as StateRow[]) {
          states.set(r.task, r);
        }
      }
      if (hasCalls) {
        for (const r of db
          .prepare("SELECT task, outcome, COUNT(*) AS n FROM inner_call GROUP BY task, outcome")
          .all() as {
          task: string;
          outcome: string;
          n: number;
        }[]) {
          const m = counts.get(r.task) ?? {};
          m[r.outcome] = r.n;
          counts.set(r.task, m);
        }
        for (const t of INNER_TASKS) {
          const resumedAt = states.get(t)?.resumed_at ?? null;
          const rows = db
            .prepare(
              `SELECT outcome FROM inner_call
                WHERE task = ? AND outcome IN ('accepted','rejected_validator','rejected_sanitiser')
                  AND (? IS NULL OR created_at > ?)
                ORDER BY created_at DESC, id DESC LIMIT ?`,
            )
            .all(t, resumedAt, resumedAt, susp.windowCalls) as { outcome: string }[];
          windows.set(t, { calls: rows.length, rejected: rows.filter((o) => o.outcome !== "accepted").length });
        }
      }
    }
  } catch {
    // An unreadable ledger reads as empty here; `doctor`'s own ledger check reports the problem.
  } finally {
    db?.close();
  }
  const tasks = INNER_TASKS.map((task): InnerTaskView => {
    const st = states.get(task);
    const c = counts.get(task) ?? {};
    const calls = Object.fromEntries(OUTCOMES.map((o) => [o, c[o] ?? 0])) as Record<InnerCallOutcome, number>;
    const total = OUTCOMES.reduce((n, o) => n + calls[o], 0);
    const fallbacks = calls.fallback_unavailable + calls.fallback_suspended + calls.fallback_disabled;
    const w = windows.get(task) ?? { calls: 0, rejected: 0 };
    let basis: InnerSuspensionBasis | null = null;
    try {
      basis = st?.suspended_basis_json ? (JSON.parse(st.suspended_basis_json) as InnerSuspensionBasis) : null;
    } catch {
      basis = null;
    }
    const cfg = settings?.tasks[task];
    return {
      task,
      enabled: taskEnabled(task),
      mode: cfg?.mode ?? null,
      allow_source_content: cfg?.allowSourceContent === true,
      suspended: st?.suspended === 1,
      suspended_at: st?.suspended_at ?? null,
      suspended_basis: basis,
      resumed_at: st?.resumed_at ?? null,
      calls,
      total_calls: total,
      fallback_rate: total === 0 ? null : fallbacks / total,
      window: {
        calls: w.calls,
        rejected: w.rejected,
        rejection_rate: w.calls === 0 ? null : w.rejected / w.calls,
        threshold: susp.rejectionThreshold,
        min_calls: susp.minCalls,
      },
    };
  });
  return { ledger, tasks };
}

function serviceFor(io: CliIo, cfg: ResolvedConfig, extra: InnerAgentDeps = {}): InnerAgentService {
  return createConfiguredInnerAgent(cfg.innerAgent, {
    providerNames: [...cfg.providers.keys(), ...PROMPT_PROVIDER_NAMES],
    ...(io.innerBackend !== undefined ? { backend: io.innerBackend } : {}),
    ...extra,
  });
}

export function buildInnerView(io: CliIo, cfg: ResolvedConfig): { view: InnerAgentView; service: InnerAgentService } {
  const service = serviceFor(io, cfg);
  const { ledger, tasks } = readTaskViews(cfg.dataDir, cfg.innerAgent, (t) => service.taskEnabled(t));
  return {
    service,
    view: {
      state: service.state,
      enabled: cfg.innerAgent?.enabled === true,
      backend: describeBackend(cfg.innerAgent),
      breaker_state: service.breakerState,
      ledger,
      tasks,
    },
  };
}

const pct = (r: number | null): string => (r === null ? "n/a" : `${Math.round(r * 100)}%`);

// ---- inner status ---------------------------------------------------------------------------------------------------

export interface InnerStatusReport {
  schema_version: number;
  inner_agent: InnerAgentView;
}

export function innerStatus(io: CliIo, argv: readonly string[]): InnerStatusReport {
  const cfg = load(io, argv);
  return { schema_version: JSON_SCHEMA_VERSION, inner_agent: buildInnerView(io, cfg).view };
}

function backendLine(b: InnerBackendView | null): string {
  if (b === null) return "no backend configured";
  const where = b.endpoint ?? (b.provider !== null ? `provider ${b.provider}` : "cli");
  const loc =
    b.locality === "unresolved"
      ? "locality unresolved (host name, classified at connect time)"
      : `${b.locality}${b.address_class === "private" ? " (private address)" : ""}`;
  return `${b.kind} ${where}, model ${b.model}, ${loc}${b.eligible ? "" : ", Ineligible (not implemented or not verified)"}`;
}

export function renderInnerStatus(r: InnerStatusReport): string {
  const v = r.inner_agent;
  const lines = ["switchboard inner status", ""];
  lines.push(`Inner agent: ${v.state}${v.enabled ? "" : " (disabled or not configured)"}`);
  if (v.backend !== null) {
    lines.push(
      `  backend: ${backendLine(v.backend)}`,
      `  allow_remote: ${v.backend.allow_remote ? "yes" : "no"}; shares subscription with: ${v.backend.shares_subscription_with ?? "none"}`,
    );
  }
  lines.push(
    `  ledger: ${v.ledger === "present" ? "present" : v.ledger === "absent" ? "none yet" : "predates the inner-agent tables"}`,
    "",
  );
  const head = ["task", "enabled", "state", "calls", "accepted", "rejected", "fallback", "fb rate", "window rejected"];
  const rows = v.tasks.map((t) => [
    t.task,
    t.enabled ? "yes" : "no",
    t.suspended ? "SUSPENDED" : "active",
    String(t.total_calls),
    String(t.calls.accepted),
    String(t.calls.rejected_validator + t.calls.rejected_sanitiser),
    String(t.calls.fallback_unavailable + t.calls.fallback_suspended + t.calls.fallback_disabled),
    pct(t.fallback_rate),
    `${t.window.rejected}/${t.window.calls} (${pct(t.window.rejection_rate)})`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] as string).length)));
  const fmt = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] as number))
      .join("  ")
      .trimEnd();
  lines.push(fmt(head), ...rows.map(fmt));
  for (const t of v.tasks.filter((x) => x.suspended)) {
    const b = t.suspended_basis;
    lines.push(
      "",
      `${t.task} is suspended since ${t.suspended_at ?? "unknown"}${b ? `: ${b.rejected} of ${b.total} calls rejected over a window of ${b.window_calls} (threshold ${pct(b.threshold)})` : ""}.`,
      `Calls fall back until you run: switchboard inner resume ${t.task}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// ---- doctor section -------------------------------------------------------------------------------------------------

export interface InnerProbeView {
  attempted: boolean;
  /** Why no probe was made: `REMOTE_NOT_ALLOWED`, `INELIGIBLE`, `NO_BACKEND`. */
  skipped_reason: string | null;
  reachable: boolean | null;
  canary_ok: boolean | null;
  eligible: boolean | null;
  /** A short code only (never the backend's text). */
  detail: string | null;
}

export interface InnerDoctorSection extends InnerAgentView {
  /** Locality resolved at probe time (a host name is looked up; nothing else is contacted). */
  resolved_locality: "local" | "remote" | null;
  probe: InnerProbeView;
  checks: DoctorCheck[];
}

const chk = (id: string, label: string, status: CheckStatus, detail: string): DoctorCheck => ({
  id,
  label,
  status,
  detail,
});

/** The doctor section, or `undefined` when the config has no `inner_agent` section (output then unchanged). */
export async function innerDoctorSection(io: CliIo, cfg: ResolvedConfig): Promise<InnerDoctorSection | undefined> {
  if (cfg.innerAgent === undefined) return undefined;
  const { view, service } = buildInnerView(io, cfg);
  const checks: DoctorCheck[] = [];
  const probe: InnerProbeView = {
    attempted: false,
    skipped_reason: null,
    reachable: null,
    canary_ok: null,
    eligible: null,
    detail: null,
  };
  let resolved: "local" | "remote" | null = null;

  if (view.state === "off") {
    checks.push(chk("inner_backend", "Inner agent", "skip", "off: disabled (every task uses its fallback)"));
    probe.skipped_reason = "NO_BACKEND";
  } else if (view.backend !== null && !view.backend.eligible) {
    checks.push(
      chk(
        "inner_backend",
        "Inner agent",
        "warn",
        `${backendLine(view.backend)}; no process is started, tasks use their fallback`,
      ),
    );
    probe.skipped_reason = "INELIGIBLE";
    resolved = "remote";
  } else if (service.backend === undefined || view.backend === null) {
    checks.push(
      chk("inner_backend", "Inner agent", "warn", "enabled but no backend is available; tasks use their fallback"),
    );
    probe.skipped_reason = "NO_BACKEND";
  } else {
    const backend: InnerBackend = service.backend;
    const timeout = view.backend.timeout_ms;
    try {
      resolved = await backend.resolveLocality(AbortSignal.timeout(timeout));
    } catch {
      resolved = "remote"; // fail closed
    }
    const needsOptIn = resolved === "remote" && !view.backend.allow_remote;
    if (needsOptIn) {
      probe.skipped_reason = "REMOTE_NOT_ALLOWED";
      checks.push(
        chk(
          "inner_backend",
          "Inner agent",
          "warn",
          `${backendLine(view.backend)}; classified remote and allow_remote is not set: not contacted, tasks use their fallback (REMOTE_NOT_ALLOWED)`,
        ),
      );
    } else {
      probe.attempted = true;
      try {
        const p = await backend.probe(AbortSignal.timeout(timeout));
        probe.reachable = p.reachable;
        probe.canary_ok = p.canary_ok;
        probe.eligible = p.eligible;
        probe.detail = safeCode(p.detail);
      } catch {
        probe.reachable = false;
        probe.canary_ok = false;
        probe.detail = "PROBE_FAILED";
      }
      const good = probe.reachable === true && probe.canary_ok === true && probe.eligible !== false;
      checks.push(
        chk(
          "inner_backend",
          "Inner agent",
          good ? "ok" : "warn",
          `${backendLine({ ...view.backend, locality: resolved })}; ${
            probe.reachable
              ? probe.canary_ok
                ? "reachable, canary answered within schema"
                : "reachable, canary not answered within schema"
              : "not reachable"
          }${probe.detail !== null && probe.detail !== "OK" ? ` (${probe.detail})` : ""}${good ? "" : "; tasks use their fallback"}`,
        ),
      );
    }
    checks.push(
      chk(
        "inner_breaker",
        "Inner agent circuit",
        "ok",
        `${view.breaker_state} in this process (the daemon's circuit is held in its memory and is not visible here)`,
      ),
    );
  }

  const enabled = view.tasks.filter((t) => t.enabled);
  const shown = view.tasks.filter((t) => t.enabled || t.suspended);
  if (view.state !== "off") {
    checks.push(
      chk(
        "inner_tasks",
        "Inner agent tasks",
        enabled.length === 0 ? "skip" : "ok",
        enabled.length === 0 ? "none enabled" : `enabled: ${enabled.map((t) => t.task).join(", ")}`,
      ),
    );
  }
  for (const t of shown) {
    const w = t.window;
    const rate = `rejection ${w.rejected}/${w.calls} (${pct(w.rejection_rate)}) over the window, threshold ${pct(w.threshold)}; fallback rate ${pct(t.fallback_rate)} of ${t.total_calls} call(s)`;
    checks.push(
      t.suspended
        ? chk(
            `inner_task_${t.task}`,
            `Inner task ${t.task}`,
            "warn",
            `SUSPENDED since ${t.suspended_at ?? "unknown"}: calls fall back until switchboard inner resume ${t.task}; ${rate}`,
          )
        : chk(`inner_task_${t.task}`, `Inner task ${t.task}`, "ok", `enabled, not suspended; ${rate}`),
    );
  }
  return { ...view, resolved_locality: resolved, probe, checks };
}

export function renderInnerDoctor(s: InnerDoctorSection, mark: Record<CheckStatus, string>): string[] {
  return ["", "Inner agent:", ...s.checks.map((c) => `${mark[c.status]} ${c.label}: ${c.detail}`)];
}

// ---- writing commands (resume, test) ----------------------------------------------------------------------------------

/** Take the data-directory lock when free; while a `serve` daemon holds it still run (as `approve` does, ADR-0005). */
async function withLedgerWrite<T>(
  io: CliIo,
  cfg: ResolvedConfig,
  fn: (ledger: ReturnType<typeof createLedger>) => Promise<T> | T,
): Promise<T> {
  let lock: ReturnType<typeof acquireDataDirLock> | undefined;
  try {
    lock = acquireDataDirLock(cfg.dataDir);
  } catch (err) {
    if (!(err instanceof LockError) || inspectDataDirLock(cfg.dataDir).state !== "held") throw err;
  }
  try {
    const db = openLedger(cfg.dataDir);
    try {
      return await fn(createLedger(db, { ...(io.now ? { now: io.now } : {}) }));
    } finally {
      db.close();
    }
  } finally {
    lock?.release();
  }
}

export interface InnerResumeReport {
  schema_version: number;
  task: InnerTask;
  resumed: boolean;
  /** Present when `resumed` is false. */
  reason?: "NOT_SUSPENDED" | "NO_LEDGER";
  resumed_at?: string | null;
  version?: number;
}

/** `inner resume <task>` (FR-INN-09, FR-INN-17): the operator re-enable; `InnerAgentService.resumeTask` does the work. */
export async function innerResume(io: CliIo, argv: readonly string[], task: InnerTask): Promise<InnerResumeReport> {
  const cfg = load(io, argv);
  if (!existsSync(path.join(cfg.dataDir, LEDGER_FILE_NAME))) {
    return { schema_version: JSON_SCHEMA_VERSION, task, resumed: false, reason: "NO_LEDGER" };
  }
  return withLedgerWrite(io, cfg, (ledger) => {
    const row = createConfiguredInnerAgent(cfg.innerAgent, { ledger }).resumeTask(task);
    return row === undefined
      ? { schema_version: JSON_SCHEMA_VERSION, task, resumed: false, reason: "NOT_SUSPENDED" as const }
      : { schema_version: JSON_SCHEMA_VERSION, task, resumed: true, resumed_at: row.resumed_at, version: row.version };
  });
}

export function renderInnerResume(r: InnerResumeReport): string {
  if (r.resumed) return `${r.task} re-enabled at ${r.resumed_at ?? "now"}; quality counting restarts from here.\n`;
  return r.reason === "NO_LEDGER"
    ? `${r.task} is not suspended (no ledger exists yet); nothing to do.\n`
    : `${r.task} is not suspended; nothing to do.\n`;
}

export interface InnerTestReport {
  schema_version: number;
  task: InnerTask;
  /** False when nothing was sent (agent off, no backend, task not enabled). */
  ran: boolean;
  accepted: boolean;
  /** `accepted`, an `inner_call` outcome, or `off` / `no_backend` / `task_not_enabled` when nothing was sent. */
  outcome: string;
  reason: string | null;
  template_version: string;
  /** The built-in fixture carries no repository data; recorded as a constant so the output says so. */
  fixture: "built-in synthetic";
  call: {
    id: string;
    locality: string;
    model_id: string;
    attempts: number;
    latency_ms: number;
    input_bytes: number;
    output_bytes: number;
  } | null;
}

/** `inner test <task>` (FR-INN-17, LLD §13.5): one real pipeline call on the built-in fixture. Never sends repository data. */
export async function innerTest(io: CliIo, argv: readonly string[], task: InnerTask): Promise<InnerTestReport> {
  const cfg = load(io, argv);
  const fixture = INNER_FIXTURES[task];
  const base = {
    schema_version: JSON_SCHEMA_VERSION,
    task,
    template_version: fixture.contract.template_version,
    fixture: "built-in synthetic" as const,
  };
  const probe = serviceFor(io, cfg);
  if (!probe.taskEnabled(task)) {
    const outcome = probe.state === "off" ? "off" : probe.state === "no_backend" ? "no_backend" : "task_not_enabled";
    return { ...base, ran: false, accepted: false, outcome, reason: null, call: null };
  }
  const timeout = (cfg.innerAgent?.backend?.timeoutMs ?? INNER_DEFAULTS.backend.timeoutMs) + 5000;
  return withLedgerWrite(io, cfg, async (ledger) => {
    const service = serviceFor(io, cfg, { ledger });
    const result = await Promise.race([
      service.call(fixture.contract, { user: fixture.user }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeout).unref()),
    ]);
    const row = result.call_id === undefined ? undefined : ledger.listInnerCalls().find((r) => r.id === result.call_id);
    return {
      ...base,
      ran: result.outcome !== "no_call",
      accepted: result.accepted,
      outcome: result.outcome,
      reason: safeCode(result.accepted ? null : result.reason),
      call:
        row === undefined
          ? null
          : {
              id: row.id,
              locality: row.locality,
              model_id: safeText(row.model_id),
              attempts: row.attempts,
              latency_ms: row.latency_ms,
              input_bytes: row.input_bytes,
              output_bytes: row.output_bytes,
            },
    };
  });
}

export function renderInnerTest(r: InnerTestReport): string {
  const lines = [`switchboard inner test ${r.task}`, ""];
  if (!r.ran) {
    lines.push(
      `Nothing was sent: ${
        r.outcome === "off"
          ? "the inner agent is off (no inner_agent section, or enabled is false)"
          : r.outcome === "no_backend"
            ? "no usable backend is configured"
            : `the ${r.task} task is not enabled`
      }.`,
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    `Fixture: ${r.fixture} (${r.template_version}); no repository data is sent.`,
    `Result: ${r.accepted ? "accepted" : `not accepted (${r.outcome}${r.reason !== null ? `, ${r.reason}` : ""}); the task would use its fallback`}`,
  );
  if (r.call !== null) {
    lines.push(
      `Call ${r.call.id}: ${r.call.locality} backend, model ${r.call.model_id}, ${r.call.attempts} attempt(s), ${r.call.latency_ms} ms, ${r.call.input_bytes} bytes sent, ${r.call.output_bytes} bytes received`,
    );
  }
  return `${lines.join("\n")}\n`;
}
