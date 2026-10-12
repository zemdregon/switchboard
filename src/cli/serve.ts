/**
 * `switchboard serve --client <id>` (T2.6; FR-OPS-01, FR-OPS-04, FR-MCP-01, FR-EXE-06, NFR-REL-01, NFR-SEC-06; SDD §3;
 * ADR-0002, ADR-0005, ADR-0011). The long-lived daemon: the only process that performs side effects for a data
 * directory. Startup order (each step fails closed and releases what it took):
 *
 *   1. load and validate the config; the `--client` id must name an `mcp_clients` entry (FR-OPS-04, R-9);
 *   2. take the data-directory lock, so a second `serve` fails clearly (ADR-0005, TDD §3.5);
 *   3. open and migrate the ledger; refuse to serve if it cannot be opened (NFR-SEC-06);
 *   4. check Git, then run startup reconciliation BEFORE the lifecycle starts or MCP accepts calls (FR-EXE-06, WF-8);
 *   5. build the adapter registry (claude, codex; fake only through the test-only switch below) and the lifecycle with
 *      the production COMP-POL `resolveProfile` (`src/policy`) and stage-1 eligibility at dispatch;
 *   6. apply pending operator cancel requests, start the lifecycle, then serve MCP on stdin/stdout;
 *   7. poll operator requests periodically until SIGINT, SIGTERM or the client closing stdin, then shut down: stop
 *      polling, close MCP (stop accepting), `lifecycle.shutdown()` (cancels in-flight runs and waits for them to be
 *      terminal), close the ledger, release the lock.
 *
 * stdout carries MCP framing only (TDD §3.3): every log line goes to stderr as one JSON object per line.
 *
 * Proposed (Delegated, not owner-approved):
 * - Operator requests are polled every {@link OPERATOR_POLL_MS} ms.
 * - The daemon also shuts down when stdin ends (the orchestrator went away), so it never lingers holding the lock.
 * - A second SIGINT/SIGTERM during shutdown is logged and ignored; the lifecycle's own kill grace bounds the wait.
 *
 * Test-only fake adapter switch (documented in TDD §3.6): the fake adapter is registered only when the environment
 * variable {@link TEST_FAKE_ADAPTER_ENV} equals the exact sentinel {@link TEST_FAKE_ADAPTER_VALUE}. The config schema
 * rejects unknown keys and has no `fake` provider id, so no config file can enable it; any other non-empty value of the
 * variable refuses to start (a typo must not silently change behaviour). When enabled, `serve` logs a warning and the
 * fake (which has no compliance manifest) passes the version gate; nothing else changes.
 */
import { FakeAdapter, type FakeScenario } from "../adapters/fake/adapter.js";
import {
  AdapterRegistry,
  ClaudeAdapter,
  CodexAdapter,
  createProbeRunner,
  type ProviderId,
  type VersionGateResult,
} from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { ConfigError, loadConfig, type ResolvedConfig } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { acquireDataDirLock, type DataDirLock } from "../lock/index.js";
import { type SwitchboardMcpServer, startStdioServer } from "../mcp/index.js";
import { resolveProfile } from "../policy/index.js";
import { reconcile } from "../reconcile/index.js";
import { CONFIG_TO_ADAPTER_ID } from "../routing/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { type CliIo, PROBE_ENV_ALLOWLIST } from "./io.js";
import { applyOperatorRequests } from "./operator.js";

export const TEST_FAKE_ADAPTER_ENV = "SWITCHBOARD_TEST_FAKE_ADAPTER";
export const TEST_FAKE_ADAPTER_VALUE = "enable-test-only-fake-adapter";
/** Scenario for the test-only fake adapter (default `success`); read only when the switch is on. */
export const TEST_FAKE_SCENARIO_ENV = "SWITCHBOARD_TEST_FAKE_SCENARIO";
export const OPERATOR_POLL_MS = 1000;

const FAKE_SCENARIOS: readonly FakeScenario[] = [
  "success",
  "task_failure",
  "auth_missing",
  "rate_limit",
  "partial_mutation",
  "malformed_output",
  "hang",
  "hang_ignore_term",
];

/** Exit codes (Proposed, same as the rest of the CLI): 0 clean shutdown, 1 refused to start or failed. */
export interface ServeOptions {
  readonly clientId: string;
  /** `--config` re-passed in the loader's argv form. */
  readonly loaderArgv: readonly string[];
}

export type FakeSwitch = { readonly enabled: false } | { readonly enabled: true; readonly scenario: FakeScenario };

/** Read the test-only fake adapter switch. Throws ConfigError on any value other than unset, empty or the sentinel. */
export function readFakeSwitch(env: Record<string, string | undefined>): FakeSwitch {
  const raw = env[TEST_FAKE_ADAPTER_ENV];
  if (raw === undefined || raw === "") return { enabled: false };
  if (raw !== TEST_FAKE_ADAPTER_VALUE) {
    throw new ConfigError(
      `${TEST_FAKE_ADAPTER_ENV} is set to an unrecognised value; it is a test-only switch. Unset it to serve real providers.`,
    );
  }
  const scenario = env[TEST_FAKE_SCENARIO_ENV] || "success";
  if (!(FAKE_SCENARIOS as readonly string[]).includes(scenario)) {
    throw new ConfigError(`${TEST_FAKE_SCENARIO_ENV} must be one of ${FAKE_SCENARIOS.join(", ")}`);
  }
  return { enabled: true, scenario: scenario as FakeScenario };
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** JSON-lines logger on stderr (TDD §3.3). Callers pass ids, counts and codes only, never prompts or env values. */
export function stderrLogger(io: CliIo): Logger {
  const now = io.now ?? (() => new Date());
  const write = (level: string, msg: string, fields: Record<string, unknown> = {}) =>
    io.stderr.write(`${JSON.stringify({ ts: now().toISOString(), level, component: "serve", msg, ...fields })}\n`);
  return {
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}

/** Provider enablement from config (`providers.<config id>.enabled`, default on); the fake follows the test switch. */
function enablement(config: ResolvedConfig, fake: FakeSwitch): (id: ProviderId) => boolean {
  return (id) => {
    if (id === "fake") return fake.enabled;
    const configId = (Object.keys(CONFIG_TO_ADAPTER_ID) as (keyof typeof CONFIG_TO_ADAPTER_ID)[]).find(
      (k) => CONFIG_TO_ADAPTER_ID[k] === id,
    );
    if (configId === undefined) return false; // not a configured provider id: fail closed
    return config.providers.get(configId)?.enabled !== false;
  };
}

export function buildRegistry(fake: FakeSwitch): AdapterRegistry {
  const registry = new AdapterRegistry().register(new ClaudeAdapter()).register(new CodexAdapter());
  if (fake.enabled) registry.register(new FakeAdapter({ scenario: fake.scenario }));
  return registry;
}

/** Version gate: the registry's manifest gate, except the test-only fake when (and only when) the switch is on. */
function gateFor(registry: AdapterRegistry, fake: FakeSwitch) {
  return (id: ProviderId, version: string | null, dir?: string): VersionGateResult => {
    if (id === "fake" && fake.enabled) {
      return {
        eligible: true,
        evidence: {
          provider: id,
          observedVersion: version,
          validatedRange: "test-only",
          validatedCliVersion: "test-only",
        },
      };
    }
    return registry.gate(id, version, dir);
  };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";

/**
 * Run the daemon until shutdown. Resolves with the exit code. Throws ConfigError (config, unknown client, bad test
 * switch) and LockError (another serve holds the data directory) before anything else is touched; the caller maps them.
 */
export async function serve(io: CliIo, opts: ServeOptions): Promise<number> {
  const log = stderrLogger(io);
  const config = loadConfig({ argv: opts.loaderArgv, env: io.env, ...(io.homedir ? { homedir: io.homedir } : {}) });
  if (!config.mcpClients.has(opts.clientId)) {
    const known = [...config.mcpClients.keys()];
    throw new ConfigError(
      `unknown MCP client ${JSON.stringify(opts.clientId)}; configured clients: ${known.length ? known.join(", ") : "(none)"}`,
    );
  }
  const fake = readFakeSwitch(io.env);
  const lock: DataDirLock = acquireDataDirLock(config.dataDir);

  let db: ReturnType<typeof openLedger> | undefined;
  try {
    try {
      db = openLedger(config.dataDir);
    } catch (err) {
      log.error("refusing to serve: the ledger cannot be opened", { data_dir: config.dataDir, error: message(err) });
      return 1;
    }
    return await runDaemon(io, log, config, opts.clientId, fake, db);
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
    lock.release();
  }
}

async function runDaemon(
  io: CliIo,
  log: Logger,
  config: ResolvedConfig,
  clientId: string,
  fake: FakeSwitch,
  db: ReturnType<typeof openLedger>,
): Promise<number> {
  const ids = createIdGenerator();
  const ledger = createLedger(db, { ids });
  const artifacts = new ArtifactStore(`${config.dataDir}/artifacts`);
  const workspace = new WorkspaceManager({
    db,
    artifacts,
    dataDir: config.dataDir,
    allowedRoots: config.allowedRoots,
    ids,
  });

  try {
    await workspace.checkGit();
  } catch (err) {
    log.error("refusing to serve: git check failed", { error: message(err) });
    return 1;
  }

  // FR-EXE-06: reconciliation completes before the lifecycle dispatches anything and before MCP accepts calls.
  try {
    const report = await reconcile({ db, ledger, workspace });
    log.info("startup reconciliation finished", {
      examined: report.examined,
      changed: report.actions.length,
      orphans_terminated: report.terminated.length,
      leases_released: report.leasesReleased.length,
      cancels_applied: report.cancelsApplied.length,
    });
  } catch (err) {
    log.error("refusing to serve: startup reconciliation failed", { error: message(err) });
    return 1;
  }

  if (fake.enabled) {
    log.warn("TEST-ONLY fake adapter enabled; it is not a real provider", {
      env: TEST_FAKE_ADAPTER_ENV,
      scenario: fake.scenario,
    });
  }
  const registry = buildRegistry(fake);
  const lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots: config.allowedRoots,
    globalConcurrency: config.limits.globalConcurrency,
    perProviderConcurrency: config.limits.perProviderConcurrency,
    resolveProfile,
    probeRunner: createProbeRunner(PROBE_ENV_ALLOWLIST),
    baseEnv: io.env,
    eligibility: { gate: gateFor(registry, fake), isEnabled: enablement(config, fake) },
    onTransition: (n) => log.info("run transition", { run_id: n.runId, from: n.from, to: n.to, rule: n.rule }),
  });

  let polling = false;
  const applyRequests = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      for (const a of await applyOperatorRequests(db, ledger, lifecycle)) {
        log.info("operator cancel applied", {
          run_id: a.runId,
          state_after: a.stateAfter,
          ...(a.error ? { error: a.error } : {}),
        });
      }
    } catch (err) {
      log.error("applying operator requests failed", { error: message(err) });
    } finally {
      polling = false;
    }
  };

  // Queued runs with a pending cancel are cancelled before dispatch can pick them up.
  await applyRequests();
  lifecycle.start();

  let mcp: SwitchboardMcpServer | undefined;
  let resolveStop: (reason: string) => void = () => {};
  const stopped = new Promise<string>((r) => {
    resolveStop = r;
  });
  const onSignal = (sig: NodeJS.Signals) => resolveStop(sig);
  const onStdinEnd = () => resolveStop("stdin closed");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.stdin.on("end", onStdinEnd);
  process.stdin.on("close", onStdinEnd);
  const timer = setInterval(() => void applyRequests(), OPERATOR_POLL_MS);

  let code = 0;
  try {
    mcp = await startStdioServer({
      lifecycle,
      ledger,
      artifacts,
      registry,
      config: { allowedRoots: config.allowedRoots, mcpClients: config.mcpClients },
      clientId,
    });
    mcp.server.onclose = () => resolveStop("mcp transport closed");
    log.info("serving MCP on stdio", {
      client: clientId,
      max_trust_profile: mcp.maxTrustProfile,
      data_dir: config.dataDir,
      adapters: registry.list().map((a) => a.id),
      pid: process.pid,
    });
    const reason = await stopped;
    log.info("shutting down", { reason });
  } catch (err) {
    log.error("serve failed", { error: message(err) });
    code = 1;
  } finally {
    // A further signal during shutdown must not kill the process with the default handler mid-cleanup.
    const ignore = (sig: NodeJS.Signals) => log.warn("already shutting down", { signal: sig });
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.on("SIGINT", ignore);
    process.on("SIGTERM", ignore);
    process.stdin.off("end", onStdinEnd);
    process.stdin.off("close", onStdinEnd);
    clearInterval(timer);
    try {
      // onclose fires again here; resolving the already-settled stop promise is a no-op.
      if (mcp) await mcp.close();
    } catch (err) {
      log.warn("closing the MCP transport failed", { error: message(err) });
    }
    try {
      await lifecycle.shutdown();
    } catch (err) {
      log.error("lifecycle shutdown failed", { error: message(err) });
      code = 1;
    }
    process.stdin.destroy(); // nothing reads stdin any more; do not let it hold the event loop open
    process.off("SIGINT", ignore);
    process.off("SIGTERM", ignore);
    log.info("stopped", { code });
  }
  return code;
}
