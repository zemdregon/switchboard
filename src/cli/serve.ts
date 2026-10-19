/**
 * `switchboard serve --client <id>` (T2.6; FR-OPS-01, FR-OPS-04, FR-MCP-01, FR-EXE-06, NFR-REL-01, NFR-SEC-06; SDD §3;
 * ADR-0002, ADR-0005, ADR-0011). The long-lived daemon: the only process that performs side effects for a data
 * directory. Startup order (each step fails closed and releases what it took):
 *
 *   0. refuse to start as root, or when the effective uid cannot be read (NFR-SEC-04, `./unprivileged.ts`), before
 *      the config is read or anything is opened;
 *   1. load and validate the config; the `--client` id must name an `mcp_clients` entry (FR-OPS-04, R-9);
 *   2. take the data-directory lock, so a second `serve` fails clearly (ADR-0005, TDD §3.5);
 *   3. open and migrate the ledger; refuse to serve if it cannot be opened (NFR-SEC-06);
 *   4. check Git, then run startup reconciliation BEFORE the lifecycle starts or MCP accepts calls (FR-EXE-06, WF-8);
 *   5. build the adapter registry (every provider registry entry with an adapter, T4.1: claude, codex, grok (T4.22), antigravity (T4.32), cursor (T4.42), opencode (T4.52), kimi (T4.62);
 *      fake only through the test-only switch below) and the lifecycle with the production COMP-POL `resolveProfile` (`src/policy`) and
 *      stage-1 eligibility at dispatch;
 *   6. apply pending operator requests (cancel, approve, deny), start the lifecycle, then serve MCP on stdin/stdout;
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
 *
 * Test-only clock offset (T3.4, Proposed, documented in TDD §3.6): with the fake switch on, {@link TEST_CLOCK_OFFSET_ENV}
 * (an integer number of milliseconds) shifts the daemon's clock (ledger timestamps, lifecycle, reconciliation, logs), so
 * a process test can show that a run AWAITING_APPROVAL does not expire after 24 hours. Set without the switch, or to a
 * non-integer, it refuses to start.
 *
 * T3.12 (Proposed, Delegated): when the config sets `retention.days`, one retention GC pass (`runRetentionGc`) runs right
 * after reconciliation, before the lifecycle starts and MCP accepts calls (so no run can race it), and then every
 * `retention.interval` (default 24h). With `retention.days` unset nothing is collected, whatever the default value is.
 * A failing pass is logged and never stops serving; units are crash-safe and a later pass rolls them forward. Each pass
 * then collects orphans (`collectOrphans`, ADR-0054): marked on first sighting, removed once marked for `retention.days`.
 *
 * T3.4: the operator poll also applies `approve`/`deny` records (`applyOperatorRequests`), and startup reconciliation
 * applies those recorded while no daemon ran.
 *
 * T3.1 (LLD §8.4, ADR-0051; Delegated): when `outer_sandbox.required_profiles` is set, the outer-sandbox mechanisms are
 * detected once at startup (with the daemon's `PATH`) and a warning is logged; each listed profile is then refused by
 * the profile resolver (`ELIGIBILITY_NONE`) at admission, so no run under it starts unconfined. Unset: no detection.
 *
 * T9.4 (FR-GIT-02, FR-GIT-07, LLD §12.2, ADR-0025, ADR-0026; Delegated): after reconciliation and before anything else
 * runs, `GitPublisher.recover()` resolves commit intents a crash left open (roll forward or abort), and the tool
 * service sweeps socket directories of channels that were open when the previous daemon died. The lifecycle gets the
 * `COMP-GIT` tool service; the shim command is this same entry point (`process.execPath`, the controller's own Node
 * options without inspector flags, the script path) with the internal `tool-shim` subcommand.
 */

import os from "node:os";
import path from "node:path";
import type { FakeScenario } from "../adapters/fake/adapter.js";
import {
  AdapterRegistry,
  adapterIdForConfigId,
  configIdForAdapterId,
  createProbeRunner,
  evaluateVersionCanary,
  PreflightCache,
  type ProviderId,
  providerEntries,
  readVersionCanaryStore,
  type VersionGateResult,
} from "../adapters/index.js";
import { ArtifactStore, defaultRedactor } from "../artifacts/index.js";
import { osLoadReader } from "../capacity/host-load.js";
import { CiTriggerPoller, GhCiStatusPort, resolveGithubRemote } from "../ci/index.js";
import { ConfigError, loadConfig, primaryContext, type ResolvedConfig } from "../config/index.js";
import { collectDigestCounts, digestPushFor } from "../control/digest-push.js";
import {
  ALL_PROJECTS_ID,
  type ApprovalAnnouncement,
  ApprovalLinkPage,
  applyPauseRequests,
  BudgetEvaluator,
  ConsentLinkStore,
  Critic,
  createConsentApprovalSource,
  NO_PROJECT_ID,
  OnceGate,
  SinkDispatcher,
  sinkOutcomeRecorder,
  transitionNotifier,
} from "../control/index.js";
import {
  type ContainerRuntime,
  containerSeedCommand,
  createContainerEnvironment,
  createDockerRuntime,
  createProjectEnvironmentResolver,
  type Environment,
  environmentEventSink,
} from "../environment/index.js";
import { detectOuterSandbox, type OuterSandboxAvailability, outerSandboxRefusal } from "../exec/outer-sandbox.js";
import { GitToolService } from "../git/channel.js";
import { GitPublisher } from "../git/commit.js";
import { GitPusher, pushContextResolver } from "../git/push.js";
import { createIdGenerator } from "../ids/index.js";
import { createClassifyRouteFeaturesHook, createConfiguredInnerAgent, PROMPT_PROVIDER_NAMES } from "../inner/index.js";
import { createLedger, openLedger, RagLedger } from "../ledger/index.js";
import { type EnvironmentResolver, RunLifecycle, type SkillDeliveryPort } from "../lifecycle/index.js";
import { acquireDataDirLock, type DataDirLock } from "../lock/index.js";
import { createChannelSearchPort, searchProjectResolver } from "../mcp/channel-search.js";
import {
  AttemptLimiter,
  AuthorizationServer,
  createSwitchboardServer,
  type HttpTransportListener,
  OAuthClientStore,
  OAuthTokenStore,
  PairingCodeStore,
  type PauseAnnouncement,
  SubjectBindingStore,
  type SwitchboardMcpServer,
  startHttpTransport,
  startStdioServer,
} from "../mcp/index.js";
import type { PendingRevisionAnnouncement } from "../mcp/project-tools.js";
import type { SearchContextDeps } from "../mcp/search-context.js";
import { type ModelConfig, ModelRegistry } from "../models/index.js";
import { createProfileResolver } from "../policy/index.js";
import { DynamicProjectStore, innerSettingResolver, toResolved } from "../projects/index.js";
import {
  admitWorkItemRequest,
  attachQueueLowWater,
  queueSchedulerSettingsFromConfig,
  runProjectWorkQueueTick,
} from "../queue/index.js";
import { reconcile } from "../reconcile/index.js";
import { globalOrigins } from "../retrieval/global.js";
import { pruneRagStores } from "../retrieval/store.js";
import { fireDueSchedules } from "../schedule/index.js";
import { canonicalBody, listRunSkills, readSkillContent } from "../skills/index.js";
import { createTelemetry } from "../telemetry/index.js";
import {
  collectOrphans,
  createSeedStore,
  DEFAULT_SEED_ENTRIES_PER_SEED,
  DEFAULT_SEED_STORE_MB,
  type DiskFloor,
  diskFloorPaths,
  earlySweepReclaimers,
  hostSeedEnvironment,
  MB,
  runEarlySweep,
  runRetentionGc,
  type SeedEnvironment,
  type SeedSpec,
  type SeedStore,
  seedReclaimer,
  statfsDiskProbe,
  WorkspaceManager,
} from "../workspace/index.js";
import { briefContextPack } from "./brief-pack.js";
import { type CliIo, PROBE_ENV_ALLOWLIST } from "./io.js";
import { applyOperatorRequests } from "./operator.js";
import { ragBackendFor, ragProjects, type ServeRag, startServeRag, toBuildProject } from "./rag-index.js";
import { checkUnprivileged } from "./unprivileged.js";

export const TEST_FAKE_ADAPTER_ENV = "SWITCHBOARD_TEST_FAKE_ADAPTER";
export const TEST_FAKE_ADAPTER_VALUE = "enable-test-only-fake-adapter";
/** Scenario for the test-only fake adapter (default `success`); read only when the switch is on. */
export const TEST_FAKE_SCENARIO_ENV = "SWITCHBOARD_TEST_FAKE_SCENARIO";
export const OPERATOR_POLL_MS = 1000;
/** Upper bound on waiting for a retrieval build to stop at shutdown (Assumption, Delegated, T12.4). */
const RAG_STOP_WAIT_MS = 2000;
/** Node clamps a timer delay above 2^31-1 ms (about 24.8 days) to 1 ms, so a longer `retention.interval` is capped. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
/** Test-only clock offset in milliseconds; honoured only with the fake switch on (T3.4 process tests). */
export const TEST_CLOCK_OFFSET_ENV = "SWITCHBOARD_TEST_CLOCK_OFFSET_MS";

const FAKE_SCENARIOS: readonly FakeScenario[] = [
  "success",
  "task_failure",
  "auth_missing",
  "rate_limit",
  "partial_mutation",
  "malformed_output",
  "hang",
  "hang_ignore_term",
  "git_commit",
];

/** Exit codes (Proposed, same as the rest of the CLI): 0 clean shutdown, 1 refused to start or failed. */
export interface ServeOptions {
  readonly clientId: string;
  /** `--config` re-passed in the loader's argv form. */
  readonly loaderArgv: readonly string[];
}

export type FakeSwitch =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly scenario: FakeScenario; readonly clockOffsetMs?: number };

/** Read the test-only fake adapter switch. Throws ConfigError on any value other than unset, empty or the sentinel. */
export function readFakeSwitch(env: Record<string, string | undefined>): FakeSwitch {
  const raw = env[TEST_FAKE_ADAPTER_ENV];
  const offset = env[TEST_CLOCK_OFFSET_ENV];
  if (raw === undefined || raw === "") {
    if (offset !== undefined && offset !== "") {
      throw new ConfigError(`${TEST_CLOCK_OFFSET_ENV} is a test-only switch; it needs ${TEST_FAKE_ADAPTER_ENV}.`);
    }
    return { enabled: false };
  }
  if (raw !== TEST_FAKE_ADAPTER_VALUE) {
    throw new ConfigError(
      `${TEST_FAKE_ADAPTER_ENV} is set to an unrecognised value; it is a test-only switch. Unset it to serve real providers.`,
    );
  }
  const scenario = env[TEST_FAKE_SCENARIO_ENV] || "success";
  if (!(FAKE_SCENARIOS as readonly string[]).includes(scenario)) {
    throw new ConfigError(`${TEST_FAKE_SCENARIO_ENV} must be one of ${FAKE_SCENARIOS.join(", ")}`);
  }
  if (offset === undefined || offset === "") return { enabled: true, scenario: scenario as FakeScenario };
  if (!/^-?\d{1,15}$/.test(offset)) throw new ConfigError(`${TEST_CLOCK_OFFSET_ENV} must be an integer (milliseconds)`);
  return { enabled: true, scenario: scenario as FakeScenario, clockOffsetMs: Number(offset) };
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * JSON-lines logger on stderr (TDD §3.3). Callers pass ids, counts and codes only, never prompts or env values. T13.5
 * (FR-MCP-15): every line also passes the secret redactor, so a token or code that reached an error message is
 * `[REDACTED]` before it leaves the process.
 */
export function stderrLogger(io: CliIo): Logger {
  const now = io.now ?? (() => new Date());
  const write = (level: string, msg: string, fields: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ ts: now().toISOString(), level, component: "serve", msg, ...fields });
    io.stderr.write(`${defaultRedactor(Buffer.from(line, "utf8")).toString("utf8")}\n`);
  };
  return {
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}

/** Provider enablement from config (`providers.<config id>.enabled`, default on); the fake follows the test switch. */
/** T4.5 (FR-ADP-05, LLD §2.1): the model registry from `providers.<id>.models`, keyed by adapter id. */
function modelRegistry(config: ResolvedConfig): ModelRegistry {
  const byAdapter = new Map<string, ModelConfig>();
  for (const [configId, models] of config.providerModels) {
    const adapterId = adapterIdForConfigId(configId);
    if (adapterId !== undefined) byAdapter.set(adapterId, models);
  }
  return new ModelRegistry(byAdapter);
}

function enablement(config: ResolvedConfig, fake: FakeSwitch): (id: ProviderId) => boolean {
  return (id) => {
    if (id === "fake") return fake.enabled;
    const configId = configIdForAdapterId(id);
    if (configId === undefined) return false; // not a configured provider id: fail closed
    return config.providers.get(configId)?.enabled !== false;
  };
}

/**
 * Every provider registry entry with an adapter (`src/adapters/providers.ts`, T4.1), in table order; test-only entries
 * (the fake) only when the switch is on. `claudeGitChannel` is `providers.claude-code.git_channel` (T9.4b, ADR-0029
 * item 7, ADR-0033): default false, so the Claude adapter declares no tool channel and its argv is unchanged; when
 * true, only approved bypass runs get it.
 */
export function buildRegistry(fake: FakeSwitch, opts: { claudeGitChannel?: boolean } = {}): AdapterRegistry {
  const registry = new AdapterRegistry();
  for (const entry of providerEntries()) {
    if (entry.create === undefined || (entry.kind === "test" && !fake.enabled)) continue;
    registry.register(
      entry.create({
        claudeGitChannel: opts.claudeGitChannel === true,
        ...(fake.enabled ? { fakeScenario: fake.scenario } : {}),
      }),
    );
  }
  return registry;
}

/** Version gate: manifest gate plus the T8.5 version canary (read-only store), except the test fake when enabled. */
function gateFor(registry: AdapterRegistry, fake: FakeSwitch, dataDir: string) {
  const store = readVersionCanaryStore(dataDir);
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
    const manifestGate = registry.gate(id, version, dir);
    return evaluateVersionCanary(manifestGate, id, store).gate;
  };
}

/**
 * argv prefix that starts `switchboard tool-shim` with the same Node and entry script as this daemon (T9.4). Inspector
 * and debugger flags are dropped so a shim never opens a debug port. Throws when the entry script is unknown.
 */
export function defaultShimCommand(): string[] {
  const script = process.argv[1];
  if (script === undefined || script === "")
    throw new Error("cannot locate the switchboard entry script for tool-shim");
  const nodeArgs = process.execArgv.filter((a) => !a.startsWith("--inspect") && !a.startsWith("--debug"));
  return [process.execPath, ...nodeArgs, path.resolve(script), "tool-shim"];
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";

/** Injectable timer surface for the retention GC schedule (T3.12); defaults to the real globals. */
export interface RetentionGcTimers {
  readonly setInterval: typeof setInterval;
  readonly clearInterval: typeof clearInterval;
}

/**
 * T3.12: start the retention GC interval pass. Returns the capped delay and a `stop` for shutdown. The pass never
 * runs at scheduling time: the startup pass is the explicit `await gcPass("startup")` in `runDaemon` before the
 * lifecycle starts. A `run` that throws or rejects is logged (first line only, like every other `serve` error log)
 * and never stops later passes; the handle is unref'd so an idle daemon still exits when stdin closes.
 */
export function scheduleRetentionGc(
  intervalMs: number,
  run: () => unknown,
  timers?: RetentionGcTimers,
  log?: Pick<Logger, "error">,
): { readonly delayMs: number; stop: () => void } {
  const set = timers?.setInterval ?? setInterval;
  const clear = timers?.clearInterval ?? clearInterval;
  const delayMs = Math.min(intervalMs, MAX_TIMER_MS);
  const report = (err: unknown): void => {
    log?.error("retention gc failed", { when: "interval", error: message(err) });
  };
  const timer = set(() => {
    try {
      const result = run();
      if (result instanceof Promise) result.catch(report);
    } catch (err) {
      report(err);
    }
  }, delayMs);
  timer.unref();
  return { delayMs, stop: () => clear(timer) };
}

/**
 * Run the daemon until shutdown. Resolves with the exit code; 1 without touching anything when running as root
 * (NFR-SEC-04). Throws ConfigError (config, unknown client, bad test
 * switch) and LockError (another serve holds the data directory) before anything else is touched; the caller maps them.
 */
export async function serve(io0: CliIo, opts: ServeOptions): Promise<number> {
  const privilege = checkUnprivileged(io0.effectiveUid);
  if (!privilege.ok) {
    stderrLogger(io0).error(`refusing to serve: ${privilege.message}`, { code: privilege.code });
    return 1;
  }
  const fake = readFakeSwitch(io0.env);
  const offset = fake.enabled ? (fake.clockOffsetMs ?? 0) : 0;
  const base = io0.now ?? (() => new Date());
  const io: CliIo = offset === 0 ? io0 : { ...io0, now: () => new Date(base().getTime() + offset) };
  const log = stderrLogger(io);
  const config = loadConfig({
    argv: opts.loaderArgv,
    env: io.env,
    testFakeAdapter: fake.enabled,
    ...(io.homedir ? { homedir: io.homedir } : {}),
  });
  if (!config.mcpClients.has(opts.clientId)) {
    const known = [...config.mcpClients.keys()];
    throw new ConfigError(
      `unknown MCP client ${JSON.stringify(opts.clientId)}; configured clients: ${known.length ? known.join(", ") : "(none)"}`,
    );
  }
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

/**
 * T10.2 (FR-PRJ-07): the environments startup reconciliation sweeps for containers a previous controller left. Only
 * when a configured project is `container`; a runtime that does not answer is skipped with a warning, because its
 * containers are not running either (Assumption, Delegated: a rootless daemon that is down runs no container). The
 * provider-side client process of a container run is still a process group that FR-EXE-06 terminates.
 */
export async function orphanSweepEnvironments(
  config: Pick<ResolvedConfig, "projects">,
  ledger: ReturnType<typeof createLedger>,
  log: Logger,
  makeRuntime: () => ContainerRuntime = createDockerRuntime,
): Promise<Environment[]> {
  if (!config.projects.some((p) => p.environment.kind === "container")) return [];
  const runtime = makeRuntime();
  const info = await runtime.info();
  if (!info.available) {
    log.warn("container orphan sweep skipped: no container runtime answered", { detail: info.detail });
    return [];
  }
  const onEvent = environmentEventSink(ledger, (event, why) =>
    log.warn("environment event not recorded", { step: event.payload.step, container: event.payload.container, why }),
  );
  return [createContainerEnvironment({ runtime, onEvent })];
}

/**
 * T10.1 (FR-PRJ-04, FR-PRJ-05, LLD §11.3): the lifecycle's environment resolver. Only when a configured project is
 * `container` (Delegated: a host-only configuration composes nothing, so a dynamic `container` project there stays
 * refused at admission); then the `container` backend over the rootless Docker driver, whose `environment` events land
 * in the ledger (T10.2). The runtime is not asked anything here: each run's `prepare` checks it (rootless, image
 * present and Git-free) and refuses the run when it does not answer. `host` stays the identity. A project resolves to
 * its configured definition, else a dynamic project's revision in force (as admission does).
 */
export function runEnvironments(
  config: Pick<ResolvedConfig, "projects">,
  store: Pick<DynamicProjectStore, "state">,
  ledger: ReturnType<typeof createLedger>,
  log: Logger,
  makeRuntime: () => ContainerRuntime = createDockerRuntime,
  seeds?: ServeSeeds,
): EnvironmentResolver | undefined {
  if (!config.projects.some((p) => p.environment.kind === "container")) return undefined;
  const onEvent = environmentEventSink(ledger, (event, why) =>
    log.warn("environment event not recorded", { step: event.payload.step, container: event.payload.container, why }),
  );
  return createProjectEnvironmentResolver({
    // T9.13 (FR-WS-10): a container run's seed entries become read-only bind mounts; none without a declared seed.
    container: createContainerEnvironment({
      runtime: makeRuntime(),
      onEvent,
      ...(seeds !== undefined
        ? { seeds: { root: seeds.root, mounts: (runId: string) => seeds.store.containerMounts(runId) } }
        : {}),
    }),
    lookup: (id) => {
      const configured = config.projects.find((p) => p.id === id);
      if (configured !== undefined) return configured;
      const dynamic = store.state(id)?.inForce?.definition;
      return dynamic !== undefined ? toResolved(dynamic) : undefined;
    },
  });
}

/** T9.13 (FR-WS-10, LLD §5.1, ADR-0057): the dependency seed store and the per-project plan `serve` composes. */
export interface ServeSeeds {
  readonly store: SeedStore;
  /** `<data_dir>/seeds`. */
  readonly root: string;
  readonly plan: (
    projectId: string,
  ) => { readonly specs: readonly SeedSpec[]; readonly environment: SeedEnvironment } | undefined;
}

/**
 * T9.13: the seed store, only when a configured project declares `dependency_seeds` (none: no store, no directory, no
 * call, and every worktree is exactly as before). Builds run like verification commands: the verification limiter and
 * confinement apply (bubblewrap is looked up on PATH when confined); a `container` project's builds run in its image.
 * Dynamic projects cannot declare seeds (their definition schema has no such key), so only configured ones are planned.
 */
export function serveSeeds(
  config: Pick<
    ResolvedConfig,
    "projects" | "dataDir" | "limits" | "verificationLimits" | "confinedVerification" | "profileOverrides"
  >,
  db: ReturnType<typeof openLedger>,
  artifacts: ArtifactStore,
  ids: ReturnType<typeof createIdGenerator>,
  baseEnv: Readonly<Record<string, string | undefined>>,
  makeRuntime: () => ContainerRuntime = createDockerRuntime,
  now?: () => Date,
): ServeSeeds | undefined {
  const seeded = config.projects.filter((p) => (p.dependencySeeds ?? []).length > 0);
  if (seeded.length === 0) return undefined;
  const needsContainer = seeded.some((p) => p.environment.kind === "container");
  const store = createSeedStore({
    db,
    artifacts,
    dataDir: config.dataDir,
    maxBytes: (config.limits.seedStoreMb ?? DEFAULT_SEED_STORE_MB) * MB,
    entriesPerSeed: config.limits.seedEntriesPerSeed ?? DEFAULT_SEED_ENTRIES_PER_SEED,
    ...(config.verificationLimits !== undefined ? { verificationLimits: config.verificationLimits } : {}),
    confined: config.confinedVerification,
    baseEnv,
    ids,
    ...(now ? { now } : {}),
    ...(needsContainer
      ? {
          commands: {
            container: containerSeedCommand({
              runtime: makeRuntime(),
              profileFor: createProfileResolver(config.profileOverrides),
            }),
          },
        }
      : {}),
  });
  return {
    store,
    root: path.join(config.dataDir, "seeds"),
    plan: (projectId) => {
      const p = seeded.find((x) => x.id === projectId);
      if (p?.dependencySeeds === undefined) return undefined;
      const environment: SeedEnvironment =
        p.environment.kind === "container"
          ? { kind: "container", imageDigest: p.environment.imageDigest ?? "" }
          : hostSeedEnvironment();
      return { specs: p.dependencySeeds, environment };
    },
  };
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
  const now = io.now;
  const ledger = createLedger(db, { ids, ...(now ? { now } : {}) });
  const artifacts = new ArtifactStore(`${config.dataDir}/artifacts`);
  const seeds = serveSeeds(config, db, artifacts, ids, io.env, createDockerRuntime, now);
  const workspace = new WorkspaceManager({
    db,
    artifacts,
    dataDir: config.dataDir,
    allowedRoots: config.allowedRoots,
    ids,
    ...(seeds !== undefined ? { seeding: { store: seeds.store, plan: seeds.plan } } : {}),
  });

  try {
    await workspace.checkGit();
  } catch (err) {
    log.error("refusing to serve: git check failed", { error: message(err) });
    return 1;
  }

  // FR-EXE-06: reconciliation completes before the lifecycle dispatches anything and before MCP accepts calls.
  try {
    const environments = await orphanSweepEnvironments(config, ledger, log);
    const report = await reconcile({ db, ledger, workspace, environments, ...(now ? { now } : {}) });
    log.info("startup reconciliation finished", {
      examined: report.examined,
      changed: report.actions.length,
      orphans_terminated: report.terminated.length,
      leases_released: report.leasesReleased.length,
      cancels_applied: report.cancelsApplied.length,
      decisions_applied: report.decisionsApplied.length,
      containers_removed: report.containersRemoved.length,
    });
    // T9.13 (LLD §5.1): orphaned seed builds killed, interrupted evictions rolled forward, scratch entries removed.
    if (seeds !== undefined) await seeds.store.reconcile();
    const admittingReset = ledger.reconcileAdmittingWorkItems();
    if (admittingReset > 0) {
      log.info("project work queue: reset ADMITTING items to READY", { count: admittingReset });
    }
  } catch (err) {
    log.error("refusing to serve: startup reconciliation failed", { error: message(err) });
    return 1;
  }

  // T12.1 (FR-RAG-03): the retrieval store of a project that no longer exists (removed from the configuration, or a
  // dynamic project deleted) is deleted. Without any store on disk, which is the case while no embedding backend is
  // configured, this reads one missing directory and does nothing.
  try {
    const live = new Set([
      ...config.projects.map((p) => p.id),
      ...new DynamicProjectStore(db, { ids, ...(now ? { now } : {}) })
        .list()
        .filter((s) => !s.deleted)
        .map((s) => s.projectId),
    ]);
    const pruned = pruneRagStores(config.dataDir, live);
    if (pruned.removed.length > 0 || pruned.ignored.length > 0) {
      log.info("retrieval stores pruned", { removed: pruned.removed.length, ignored: pruned.ignored.length });
    }
  } catch (err) {
    log.warn("retrieval store pruning failed; continuing", { error: message(err) });
  }

  // T11.4 (FR-INN-10, ADR-0016): the inner-agent service, first wired for the commit-message task. With no
  // `inner_agent` section, or `enabled: false`, it is `off` and every task falls back (FR-INN-01).
  const innerAgent = createConfiguredInnerAgent(config.innerAgent, {
    ledger,
    providerNames: [...config.providers.keys(), ...PROMPT_PROVIDER_NAMES],
    logger: (entry) => log.info("inner agent call", entry),
  });
  // LLD §13.1 and the T11.3 note: the effective project/context setting, resolved from the current configuration (or a
  // dynamic project's revision in force) at channel open and at every commit call; an unknown project reads as `off`.
  const innerSettingFor = innerSettingResolver(
    config.projects,
    new DynamicProjectStore(db, { ids, ...(now ? { now } : {}) }),
  );

  // T12.6 (FR-RAG-06): read-only search over a project's store; absent without an embedding backend (FR-RAG-04). The
  // same handler serves the MCP tool and, T12.9 (FR-RAG-13), the per-run tool channel. T12.7 (FR-RAG-10): the global
  // origins that may share, resolved per call from the live project list exactly as at admission.
  const searchContext: SearchContextDeps | undefined =
    config.rag.embedding !== undefined
      ? {
          dataDir: config.dataDir,
          settings: config.rag,
          backend: ragBackendFor(io, config.rag.embedding),
          globalOrigins: () =>
            globalOrigins(
              config.rag.global,
              ragProjects(config, db).map((p) => toBuildProject(config.rag, p)),
            ),
          record: (r: Parameters<RagLedger["record"]>[0]) => void new RagLedger(db, { ids }).record(r),
          ...(io.homedir !== undefined ? { homeDir: io.homedir } : {}),
          ...(now ? { now } : {}),
        }
      : undefined;

  // T9.4: commit intents left by a crash (ADR-0025), then socket directories of channels a crash left open (ADR-0026).
  let gitTools: GitToolService;
  let finalizePublisher: GitPublisher;
  try {
    const publisher = new GitPublisher({
      db,
      scratchDir: path.join(config.dataDir, "git-scratch"),
      sanitizePatterns: config.sanitizePatterns,
      ids,
      ...(now ? { now } : {}),
    });
    const recovered = await publisher.recover();
    // T9.7 (FR-GIT-09): finalize-only commits use their own publisher, which accepts only FINALIZING runs, so the tool
    // channel's publisher keeps refusing anything but RUNNING. Same scratch directory and sanitiser patterns.
    finalizePublisher = new GitPublisher({
      db,
      scratchDir: path.join(config.dataDir, "git-scratch"),
      sanitizePatterns: config.sanitizePatterns,
      allowedStates: ["FINALIZING"],
      ids,
      ...(now ? { now } : {}),
    });
    gitTools = new GitToolService({
      db,
      dataDir: config.dataDir,
      publisher,
      // T9.6 (ADR-0028): push targets come from this process's configuration at push time; the operator's Git
      // configuration is used only by the controller's own `git push` (allowlisted environment, never the agent's).
      pusher: new GitPusher({
        db,
        resolveContext: pushContextResolver(config.projects),
        sourceEnv: io.env,
        secretScanAllow: config.secretScanAllow,
        ids,
        ...(now ? { now } : {}),
      }),
      shimCommand: defaultShimCommand(),
      innerAgent,
      innerSettingFor,
      // T12.9 (FR-RAG-13): offered on a run's channel only when retrieval is on for its project.
      ...(searchContext !== undefined
        ? {
            search: createChannelSearchPort(
              searchContext,
              searchProjectResolver(config.projects, new DynamicProjectStore(db, { ids, ...(now ? { now } : {}) })),
            ),
          }
        : {}),
      fallbackDirs: [io.env.XDG_RUNTIME_DIR, os.tmpdir()].filter((d): d is string => typeof d === "string" && d !== ""),
      ...(now ? { now } : {}),
    });
    const swept = await gitTools.sweepStale();
    log.info("git recovery finished", {
      commits_rolled_forward: recovered.rolledForward.length,
      commits_aborted: recovered.aborted.length,
      commits_unresolved: recovered.unresolved.length,
      channels_cleaned: swept.cleaned.length,
      channels_skipped: swept.skipped.length,
    });
  } catch (err) {
    log.error("refusing to serve: git recovery failed", { error: message(err) });
    return 1;
  }

  // One collecting pass at a time (T3.12 retention, T3.23 early sweep): a pass asked for while another runs is skipped.
  let gcInFlight: Promise<void> | undefined;
  const withGcSlot = async (fn: () => Promise<void>): Promise<void> => {
    if (gcInFlight) return;
    let done: () => void = () => {};
    gcInFlight = new Promise<void>((r) => {
      done = r;
    });
    try {
      await fn();
    } finally {
      gcInFlight = undefined;
      done();
    }
  };
  // T3.12: retention GC, only when the operator set retention.days. Housekeeping: a failure never blocks serving.
  const gcPass = async (when: "startup" | "interval"): Promise<void> => {
    if (!config.retentionEnabled) return;
    await withGcSlot(async () => {
      try {
        const r = await runRetentionGc({
          db,
          artifacts,
          dataDir: config.dataDir,
          days: config.retention.days,
          ...(now ? { now: now() } : {}),
        });
        log.info("retention gc finished", {
          when,
          cutoff: r.cutoff,
          collected: r.collected.map((c) => c.sessionId),
          errors: r.errors.length,
        });
        for (const e of r.errors)
          log.warn("retention gc unit failed", { session_id: e.sessionId, step: e.step, error: e.message });
        for (const c of r.collected)
          for (const w of c.warnings) log.warn("retention gc warning", { session_id: c.sessionId, warning: w });
        const o = await collectOrphans({
          db,
          dataDir: config.dataDir,
          days: config.retention.days,
          ...(now ? { now: now() } : {}),
        });
        log.info("orphan gc finished", {
          when,
          marked: o.marked,
          waiting: o.waiting,
          worktrees_removed: o.removedWorktrees.length,
          branches_removed: o.removedBranches.length,
          errors: o.errors.length,
        });
        for (const e of o.errors) log.warn("orphan gc failed", { target: e.target, step: e.step, error: e.message });
        for (const w of o.warnings) log.warn("orphan gc warning", { warning: w });
      } catch (err) {
        log.error("retention gc failed", { when, error: message(err) });
      }
    });
  };
  await gcPass("startup");

  // T3.23 (FR-WS-11, BR-51): the free-disk floor, off unless `limits.min_free_disk_mb` is set. The lifecycle holds
  // queued runs under it (`disk_hold`) and asks for this early sweep, which takes the same GC slot as the retention
  // pass. Reclaimers in order: dependency seeds (T9.13; only when a project declares one), then meta-sessions idle
  // longer than `retention.days`, only when `retention.days` is set (the one switch for every collection, T3.12).
  const floorMb = config.limits.minFreeDiskMb;
  const diskFloorBase: DiskFloor | undefined =
    floorMb === undefined
      ? undefined
      : { minFreeBytes: floorMb * MB, paths: diskFloorPaths(config.dataDir), probe: statfsDiskProbe };
  const diskSweep = async (floor: DiskFloor): Promise<void> => {
    await withGcSlot(async () => {
      try {
        const r = await runEarlySweep({
          db,
          floor,
          reclaimers: earlySweepReclaimers({
            gc: { db, artifacts, dataDir: config.dataDir, days: config.retention.days },
            enabled: config.retentionEnabled,
            ...(seeds !== undefined ? { seeds: seedReclaimer(seeds.store) } : {}),
          }),
          ...(now ? { now: now() } : {}),
        });
        log.info("early disk sweep finished", {
          satisfied: r.satisfied,
          free_mb_before: r.before.freeBytes === null ? null : Math.floor(r.before.freeBytes / MB),
          free_mb_after: r.after.freeBytes === null ? null : Math.floor(r.after.freeBytes / MB),
          min_free_mb: floorMb,
          leased_worktrees: r.leasedWorktrees.length,
          steps: r.steps.map((s) =>
            "error" in s.outcome
              ? { name: s.name, error: s.outcome.error }
              : { name: s.name, reclaimed: s.outcome.reclaimed, notes: s.outcome.notes },
          ),
        });
      } catch (err) {
        log.error("early disk sweep failed", { error: message(err) });
      }
    });
  };
  if (diskFloorBase !== undefined) {
    log.info("free-disk floor on: new runs are held in QUEUED while free space is under it", {
      min_free_mb: floorMb,
      paths: diskFloorBase.paths,
      early_sweep_collects_meta_sessions: config.retentionEnabled,
    });
  }

  if (fake.enabled) {
    log.warn("TEST-ONLY fake adapter enabled; it is not a real provider", {
      env: TEST_FAKE_ADAPTER_ENV,
      scenario: fake.scenario,
      ...(fake.clockOffsetMs !== undefined ? { clock_offset_ms: fake.clockOffsetMs } : {}),
    });
  }
  if (config.claudeCodeGitChannel) {
    log.warn(
      "opt-in providers.claude-code.git_channel is on (bypass-only): offered only to approved bypass runs, which then " +
        "omit --safe-mode and load repository CLAUDE.md and hooks",
      { adr: "ADR-0033" },
    );
  }
  let outerSandbox: OuterSandboxAvailability | undefined;
  const outerSandboxRequired = config.outerSandboxRequiredProfiles;
  const confinedVerification = config.confinedVerification;
  if (outerSandboxRequired.length > 0 || confinedVerification) {
    outerSandbox = await detectOuterSandbox({ path: io.env.PATH ?? "" });
    const m = outerSandbox.mechanisms;
    if (outerSandboxRequired.length > 0) {
      log.warn("outer_sandbox.required_profiles is set: runs under these profiles are refused at admission", {
        adr: "ADR-0051",
        profiles: outerSandboxRequired,
        bubblewrap: m.bubblewrap.available,
        prlimit: m.prlimit.available,
        landlock: m.landlock.available,
      });
    }
    if (confinedVerification) {
      log.info("confined verification is enabled (T3.11): verification commands run in the outer sandbox", {
        bubblewrap: m.bubblewrap.available,
      });
    }
  }
  const registry = buildRegistry(fake, { claudeGitChannel: config.claudeCodeGitChannel });
  // T12.4 / T12.5: set below once background indexing has started; until then (and with no embedding backend) the
  // context-pack port answers `undefined` and a run is compiled without a pack.
  let rag: ServeRag | undefined;
  const telemetry = createTelemetry(config); // inert without `telemetry.otlp_endpoint`; spans arrive from T8.2 emission
  // T14.9 (FR-CTL-10, ADR-0048): notification sinks only when the operator configured one; none means no request at all.
  const sinks =
    config.notificationSinks.length === 0
      ? undefined
      : new SinkDispatcher({
          sinks: config.notificationSinks,
          ...(config.httpTransport !== undefined ? { linkBase: config.httpTransport.resource } : {}),
          onOutcome: sinkOutcomeRecorder({ log, appendRunEvent: (e) => ledger.appendRunEvent(e) }),
        });
  if (sinks) log.info("notification sinks configured", { sinks: sinks.sinkIds });
  const notifySinks = sinks ? transitionNotifier(sinks, (runId) => ledger.getRunRecord(runId)?.project_id) : undefined;
  // T14.9 (FR-CTL-10, ADR-0048): `needs_attention` emits once per (run, reason) in this process; keys name only the
  // run id and the closed reason code.
  const attentionGate = new OnceGate();
  // T14.17 (FR-CTL-15): the advisory critic, built once the queue admission deps exist (after `lifecycle.start()`).
  let critic: Critic | undefined;
  // T15.4 (FR-QUE-04, LLD §18.8, ADR-0048): one queue low-water tracker for this process, on the real ledger and the
  // same dispatcher as the other sink events. It recomputes on every work-queue state change the ledger notifies
  // (MCP enqueue/cancel, the scheduler tick's dequeue and admission outcomes, run-terminal transitions); the mark comes
  // from the resolved project config, an unset mark emits nothing. Only attached when a sink exists, or the events have
  // nowhere to go (the same rule as T14.9 above). `init` seeds the armed state from the level at startup, so a queue
  // opening at or above its mark emits exactly once when it first drains below, and re-arms only by refilling to the mark.
  if (sinks) {
    const lowWaterTracker = attachQueueLowWater({
      ledger,
      getLowWaterMark: (pid) => config.projects.find((p) => p.id === pid)?.queue?.lowWater,
      dispatcher: sinks,
    });
    for (const project of config.projects) lowWaterTracker.init(project.id);
  }
  // T14.4 (FR-CTL-06, LLD §3.4.6): operator budget caps (`control_plane.budgets`); with none configured, admission
  // never queries the ledger for them. A refusal is logged with the cap (operator values only) and, once per
  // exhausted window and scope, sent to the sinks as `budget_exhausted` (no run id: nothing was written).
  const budgets = new BudgetEvaluator({ ledger, settings: config.controlPlane.budgets, ...(now ? { now } : {}) });
  if (budgets.configured) log.info("operator budget caps configured", { source: "control_plane.budgets" });
  const notifiedExhaustion = new Map<string, string>();
  const onBudgetRefused: NonNullable<ConstructorParameters<typeof RunLifecycle>[0]["onBudgetRefused"]> = ({
    projectId,
    refusal,
  }) => {
    log.warn("admission refused by operator budget cap", {
      project_id: projectId ?? "-",
      scope: refusal.scope,
      cap: refusal.cap,
      limit: refusal.limit,
      used: refusal.used,
      window_ends_at: refusal.window_ends_at,
    });
    if (!sinks) return;
    const key = `${refusal.cap}|${refusal.window_ends_at ?? ""}`;
    if (notifiedExhaustion.get(refusal.project_id) === key) return;
    notifiedExhaustion.set(refusal.project_id, key);
    sinks.emit({
      projectId: refusal.project_id,
      eventKind: "budget_exhausted",
      reasonCode: "budget_exhausted",
      runId: null,
    });
  };
  // T10.1: container projects run through the `container` backend; `host` is unchanged.
  const environments = runEnvironments(
    config,
    new DynamicProjectStore(db, { ids, ...(now ? { now } : {}) }),
    ledger,
    log,
    createDockerRuntime,
    seeds,
  );
  const lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    // T16.5 (LLD §19.6): wired whatever `skills.enabled` says, so a run admitted with skills before the operator turned
    // them off still gets exactly the versions it was admitted with; a run without `run_skill` rows reads nothing.
    skillDelivery: skillDeliveryPort(db, config.dataDir),
    // T16.6 (LLD §19.6 step 1): `prefix_only` forces the prompt prefix even for a cell that declares `native`.
    skillDeliveryMode: config.skills.delivery,
    // T8.2 (FR-TEL-02, LLD §7): wrapper-boundary span export; inert when no OTLP endpoint is configured.
    telemetry,
    allowedRoots: config.allowedRoots,
    globalConcurrency: config.limits.globalConcurrency,
    perProviderConcurrency: config.limits.perProviderConcurrency,
    // T6.9: `providers.<id>.concurrency`, keyed by adapter id.
    perProviderLimits: providerLimits(config),
    // T6.4: per-provider breaker thresholds (`capacity.breaker`, LLD §16.4).
    breaker: config.capacity.breaker,
    // T3.23 (FR-WS-11): the free-disk floor and its early sweep; absent when `limits.min_free_disk_mb` is not set.
    ...(diskFloorBase !== undefined
      ? {
          diskFloor: {
            ...diskFloorBase,
            sweep: async (status) => {
              log.warn("free disk is under the floor: queued runs are held (disk_hold) and the early sweep runs", {
                free_mb: status.freeBytes === null ? null : Math.floor(status.freeBytes / MB),
                min_free_mb: floorMb,
                path: status.path,
              });
              await diskSweep(diskFloorBase);
            },
          },
        }
      : {}),
    // T3.24 (FR-CAP-12, LLD §20.2): the host load hold over `os.loadavg()`; absent when `host` is not set.
    ...(config.hostLoad !== undefined ? { hostLoad: { ...config.hostLoad, reader: osLoadReader } } : {}),
    // T6.8 (FR-CAP-10, LLD §16.9): the pacing gate; absent unless the file sets `capacity.subscriptions` or `pacing`.
    ...(config.capacity.subscriptions !== undefined && config.capacity.pacing !== undefined
      ? { pacing: { subscriptions: config.capacity.subscriptions, pacing: config.capacity.pacing } }
      : {}),
    // T6.5: automatic retry parameters and the reset wait bound (`capacity.retry`, `capacity.queue_horizon_seconds`).
    retry: { ...config.capacity.retry, queueHorizonSeconds: config.capacity.queueHorizonSeconds },
    // T14.5: loop breaker N, T and successor cap (`control_plane.loop_breaker`, LLD §3.4.6).
    loopBreaker: config.controlPlane.loopBreaker,
    // T6.6: bundle bounds for a quota failover handoff (`continuity.*`, LLD §15.4).
    continuityBounds: config.continuity,
    // T7.2: stage-2 settings for the quota failover's choice (`routing.weights`, the capacity window; LLD §17.3).
    routing: {
      weights: config.routing.weights,
      windowSeconds: config.capacity.windowSeconds,
      confidenceRuns: config.capacity.confidenceRuns,
      providers: config.providers,
      limits: config.limits,
    },
    // T3.1 (ADR-0051): a profile in `outer_sandbox.required_profiles` is refused here (fail closed).
    resolveProfile: createProfileResolver(
      config.profileOverrides,
      (p) => outerSandboxRefusal(p, outerSandboxRequired, outerSandbox)?.message,
    ),
    probeRunner: createProbeRunner(PROBE_ENV_ALLOWLIST),
    baseEnv: io.env,
    eligibility: {
      gate: gateFor(registry, fake, config.dataDir),
      isEnabled: enablement(config, fake),
      models: modelRegistry(config),
    },
    preflightCache: new PreflightCache({ ttlMs: config.preflightTtlMs }),
    gitTools,
    finalizePublisher,
    // T3.11 (FR-EXE-08, FR-POL-06, decision 11): confined verification in the outer sandbox.
    confinedVerification,
    outerSandboxRequiredProfiles: outerSandboxRequired,
    ...(outerSandbox ? { outerSandbox } : {}),
    // T3.22 (FR-EXE-09): host-wide verification slots; absent unless a `limits.verification_*` key is set.
    ...(config.verificationLimits ? { verificationLimits: config.verificationLimits } : {}),
    // T12.5 (FR-RAG-05, FR-RAG-08): retrieval at dispatch; no pack when retrieval is inert or fails.
    // T5.14 (FR-SES-07, LLD §20.13): the project brief frozen at admission goes first, inside the same budget.
    contextPack: briefContextPack({
      timeoutMs: config.rag.retrieval.admissionTimeoutMs,
      maxContextTokens: config.rag.retrieval.maxContextTokens,
      allowedRoots: config.allowedRoots,
      policySnapshot: (runId) => ledger.getRunRecord(runId)?.policy_snapshot_json,
      project: (projectId) => config.projects.find((p) => p.id === projectId),
      retrieve: async (request, reservedTokens) => rag?.prepareContextPack(request, reservedTokens),
    }),
    // T11.11 (FR-INN-12, Q-82): record-only route features from the configured inner agent and the
    // project/context privacy resolver. Heuristic fallback when the agent is off, the task is disabled,
    // a privacy gate denies, or the call fails. Never ranks; lifecycle never imports the service.
    classifyRouteFeatures: createClassifyRouteFeaturesHook(innerAgent, innerSettingFor),
    onTransition: (n) => {
      log.info("run transition", { run_id: n.runId, from: n.from, to: n.to, rule: n.rule });
      notifySinks?.(n);
      critic?.onTransition(n);
    },
    budgets,
    onBudgetRefused,
    // T14.9 (FR-CTL-10, ADR-0048): pending and attention announcements on the same dispatcher as the transition hook.
    // `needs_attention` emits once per (run, reason) through the gate; a sink failure never reaches the run.
    onApprovalPending: (n) => {
      if (!sinks) return;
      sinks.emit({
        projectId: n.projectId ?? NO_PROJECT_ID,
        eventKind: "approval_pending",
        reasonCode: "privileged_scope",
        runId: n.runId,
      });
      if (attentionGate.claim(`needs_attention|${n.runId}|awaiting_approval`)) {
        sinks.emit({
          projectId: n.projectId ?? NO_PROJECT_ID,
          eventKind: "needs_attention",
          reasonCode: "awaiting_approval",
          runId: n.runId,
        });
      }
    },
    onNeedsAttention: (n) => {
      if (!sinks) return;
      if (attentionGate.claim(`needs_attention|${n.runId}|${n.reason}`)) {
        sinks.emit({
          projectId: n.projectId ?? NO_PROJECT_ID,
          eventKind: "needs_attention",
          reasonCode: n.reason,
          runId: n.runId,
        });
      }
    },
    ...(environments !== undefined ? { environments } : {}),
    ...(now ? { now } : {}),
  });

  // T14.10 (FR-CTL-09, ADR-0047 Decision 3): single-use, expiring consent-page links, only with the HTTP transport. A
  // sweep on each operator poll issues a link for every decidable approval without a live one and logs its URL, which
  // is not a credential: opening it still needs the passphrase or a pairing code (FR-MCP-17).
  const consentLinks = config.httpTransport
    ? new ConsentLinkStore({
        issuer: config.httpTransport.issuer,
        source: createConsentApprovalSource({
          ledger,
          clientIds: [...config.mcpClients.keys()],
          projectStore: new DynamicProjectStore(db, { ids, ...(now ? { now } : {}) }),
          applyDecision: (req) => lifecycle.applyApprovalDecision(req),
          ...(sinks !== undefined
            ? {
                announce: (a: ApprovalAnnouncement) =>
                  sinks.emit({
                    projectId: a.projectId,
                    eventKind: "approval_decided",
                    reasonCode: a.kind,
                    runId: a.runId,
                  }),
              }
            : {}),
        }),
        ...(now ? { now } : {}),
      })
    : undefined;
  const sweepConsentLinks = (): void => {
    if (!consentLinks) return;
    try {
      for (const l of consentLinks.sweep()) {
        log.info("consent-page approval link issued", {
          approval_id: l.approvalId,
          url: l.url,
          expires_at: l.expiresAt,
        });
      }
    } catch (err) {
      log.warn("issuing consent-page approval links failed", { error: message(err) });
    }
  };

  let polling = false;
  const applyRequests = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      // T14.6 (FR-CTL-05, LLD §3.4.4): the CLI's global pause / resume, applied here as `approve` is. Admission reads
      // the row inside its transaction, so from this poll on no new run is admitted (or admission reopens).
      for (const p of applyPauseRequests(ledger)) {
        log.info(p.paused ? "operator pause applied: no project admits new runs" : "operator resume applied", {
          scope: p.scope,
          requested_by: p.requestedBy,
          request_event_id: p.requestEventId,
        });
        if (p.paused) {
          sinks?.emit({
            projectId: ALL_PROJECTS_ID,
            eventKind: "project_paused",
            reasonCode: "global_paused",
            runId: null,
          });
        }
      }
      for (const a of await applyOperatorRequests(db, ledger, lifecycle)) {
        log.info(a.kind === "decision" ? "operator decision applied" : "operator cancel applied", {
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

  const queueSettings = queueSchedulerSettingsFromConfig(
    config as { queue?: { maxItemsPerProject?: number; dequeueBatch?: number } },
  );
  const queueAdmission = {
    lifecycle,
    ledger,
    registry,
    config: {
      allowedRoots: config.allowedRoots,
      mcpClients: config.mcpClients,
      projects: config.projects,
      dataDir: config.dataDir,
      providers: config.providers,
      capacity: config.capacity,
      limits: config.limits,
      routing: config.routing,
      // T7.14 (FR-RTE-11, LLD §17.7): the same group table the MCP server checks at enqueue.
      modelGroups: config.modelGroups,
    },
    projectStore: new DynamicProjectStore(db, { ids, ...(now ? { now } : {}) }),
    // T16.4 (LLD §19.4): a queued item resolves its skills at its own admission, on the ledger handle.
    ...(config.skills.enabled ? { skills: { db, settings: config.skills } } : {}),
  };
  // T14.17 (FR-CTL-15, LLD §20.13): one read-only critic run on another provider after a large diff, admitted through
  // the same path as a queued item (budgets, pause and ceilings apply) with the project snapshot frozen read-only.
  const criticSettings = new Map(config.projects.flatMap((p) => (p.critic ? [[p.id, p.critic] as const] : [])));
  if (criticSettings.size > 0) {
    critic = new Critic({
      ledger,
      settingsFor: (projectId) => criticSettings.get(projectId),
      providers: () => registry.list().map((a) => a.id),
      admit: (a) =>
        admitWorkItemRequest(
          { ...queueAdmission, candidateOrder: a.candidates as ProviderId[], readOnlyProject: true },
          a.clientId,
          a.projectId,
          a.request,
          a.idempotencyKey,
        ),
      onError: (err) => log.error("advisory critic failed", { error: message(err) }),
    });
  }
  const runQueueTick = () =>
    runProjectWorkQueueTick(ledger, queueAdmission, queueSettings).catch((err) => {
      log.error("project work queue tick failed", { error: message(err) });
    });
  // T15.3 (FR-QUE-03, LLD §18.7 step 2, ADR-0050): CI is polled through the operator's `gh` before the queue dequeue
  // (step 3), so a fix-up item can be admitted on the same tick. Off unless `ci_trigger.enabled`; no `gh` call otherwise.
  // T15.6 (FR-QUE-06, ADR-0050 amendment 1): the same port is the write side, used only for a project whose
  // `rerun_failed` or `cancel_stale_queued` switch is on.
  const ciTrigger = config.ciTrigger;
  const ciPort = ciTrigger.enabled
    ? new GhCiStatusPort({
        binary: ciTrigger.ghBinary,
        sourceEnv: io.env,
        useCheckRunsFallback: ciTrigger.useCheckRunsFallback,
      })
    : undefined;
  const ciPoller = ciPort
    ? new CiTriggerPoller(
        {
          db,
          ledger,
          port: ciPort,
          actions: ciPort,
          settings: ciTrigger,
          resolveRemote: async (projectId, remote) => {
            const project = config.projects.find((p) => p.id === projectId);
            return project === undefined ? undefined : resolveGithubRemote(primaryContext(project).path, remote);
          },
          maxItemsPerProject: queueSettings.maxItemsPerProject,
          // T14.9 (FR-CTL-10, ADR-0048): a ref newly reaching the stuck flag reaches the sinks as `needs_attention`
          // (`ci_fix_stuck`, no run; the project carries it). The poller announces the 0→1 transition only.
          ...(sinks === undefined
            ? {}
            : {
                onStuck: (info: { projectId: string; publishRef: string }) => {
                  if (attentionGate.claim(`needs_attention|${info.projectId}|${info.publishRef}|ci_fix_stuck`)) {
                    sinks.emit({
                      projectId: info.projectId,
                      eventKind: "needs_attention",
                      reasonCode: "ci_fix_stuck",
                      runId: null,
                    });
                  }
                },
              }),
        },
        () => (now ? now() : new Date()).getTime(),
      )
    : undefined;
  // T14.16 (FR-CTL-14, LLD §20.5, ADR-0048): the metadata-only digest push, only when the operator set
  // `control_plane.digest_schedule` and a sink exists to receive it; otherwise nothing is collected or sent.
  const digestCron = config.controlPlane.digestSchedule?.cron;
  const digestPush = digestPushFor({
    cron: digestCron,
    sinks,
    counts: (at) => collectDigestCounts(ledger, { now: at, projects: config.projects }),
  });
  if (digestCron !== undefined && sinks === undefined) {
    log.warn("control_plane.digest_schedule is set but no notification sink is configured; no digest is sent");
  }
  const runSchedulerTick = async () => {
    try {
      digestPush?.tick(now ? now() : new Date());
    } catch (err) {
      log.error("digest push tick failed", { error: message(err) });
    }
    // T15.2 (FR-QUE-02, LLD §18.7 step 1): due schedules enqueue before the CI poll and the queue dequeue.
    try {
      fireDueSchedules(ledger, { ...(now ? { nowUtc: new Date(now()) } : {}) });
    } catch (err) {
      log.error("schedule fire tick failed", { error: message(err) });
    }
    if (ciPoller !== undefined) {
      try {
        const r = await ciPoller.tick();
        for (const e of r?.errors ?? []) {
          log.warn("ci trigger poll error", { project_id: e.projectId, publish_ref: e.publishRef, reason: e.reason });
        }
        for (const q of r?.enqueued ?? []) {
          log.info("ci trigger enqueued fix-up work", {
            project_id: q.projectId,
            work_item_id: q.workItemId,
            external_id: q.externalId,
          });
        }
      } catch (err) {
        log.error("ci trigger poll failed", { error: message(err) });
      }
    }
    await runQueueTick();
  };
  void runSchedulerTick();

  // T12.4 (FR-RAG-11, LLD §14.5): background index builds. `startServeRag` only queues every project and returns; a
  // build runs on later turns of the event loop and is never awaited by admission. Without an embedding backend it is
  // undefined and nothing changes (FR-RAG-04). Pending `index rebuild|clear` requests are applied with the operator poll.
  try {
    rag = startServeRag({ io, config, db, log, ...(now ? { now } : {}) });
    if (rag !== undefined) {
      log.info("retrieval index builds started in the background", { projects: rag.indexer.queued().length });
      void rag.applyRequests();
    }
  } catch (err) {
    log.warn("retrieval indexing could not start; continuing without it", { error: message(err) });
  }

  let mcp: SwitchboardMcpServer | undefined;
  let httpListener: HttpTransportListener | undefined;
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
  const timer = setInterval(() => {
    void applyRequests();
    void rag?.applyRequests();
    void runSchedulerTick();
    sweepConsentLinks();
  }, OPERATOR_POLL_MS);
  const gcTimer = config.retentionEnabled
    ? scheduleRetentionGc(config.retention.intervalMs, () => void gcPass("interval"), undefined, log)
    : undefined;

  let code = 0;
  try {
    const mcpDeps = {
      lifecycle,
      ledger,
      artifacts,
      registry,
      config: {
        allowedRoots: config.allowedRoots,
        mcpClients: config.mcpClients,
        projects: config.projects,
        // T9.9 (FR-PRJ-10, ADR-0030): no dynamic project inside the data directory; disabled providers are off-limits.
        dataDir: config.dataDir,
        providers: config.providers,
        // T5.6: handoff bundle bounds (`continuity.*`, LLD §15.4).
        continuity: config.continuity,
        // T6.3: `get_capacity` settings and slot limits (LLD §16.1, §16.3).
        capacity: config.capacity,
        limits: config.limits,
        // T7.2: stage-2 score weights (`routing.weights`, LLD §17.1).
        routing: config.routing,
        // T7.14 (FR-RTE-11, LLD §17.7): configured model groups for `routing.model_group`.
        modelGroups: config.modelGroups,
      },
      ...(now ? { now } : {}),
      projectStore: new DynamicProjectStore(db, { ids, ...(now ? { now } : {}) }),
      // T14.8 (FR-CTL-08, ADR-0047 2f): proxied decisions the transition hook does not announce reach the same sinks.
      ...(sinks !== undefined
        ? {
            announceApproval: (a: ApprovalAnnouncement) =>
              sinks.emit({ projectId: a.projectId, eventKind: "approval_decided", reasonCode: a.kind, runId: a.runId }),
            // T14.6 (FR-CTL-05): a client's pause_project reaches the sinks as `project_paused` (resume has no kind).
            announcePause: (a: PauseAnnouncement) => {
              if (a.paused) {
                sinks.emit({
                  projectId: a.projectId,
                  eventKind: "project_paused",
                  reasonCode: "project_paused",
                  runId: null,
                });
              }
            },
            // T14.9 (FR-CTL-10, ADR-0048): a revision waiting for the operator reaches the sinks as `approval_pending`
            // (a revision has no run; the project carries it). One revision row emits once.
            announcePendingRevision: (a: PendingRevisionAnnouncement) =>
              sinks.emit({
                projectId: a.projectId,
                eventKind: "approval_pending",
                reasonCode: a.kind,
                runId: null,
              }),
          }
        : {}),
      // T13.5 (FR-MCP-15, Q-78): stdio sees only meta-sessions with no HTTP subject; HTTP sees only its own.
      subjectBindings: new SubjectBindingStore(db, now ? { now } : {}),
      // T12.6 (FR-RAG-06): read-only search over a project's store; absent without an embedding backend (FR-RAG-04).
      ...(searchContext !== undefined ? { searchContext } : {}),
      // T16.9 (FR-SKL-08, LLD §19.9): the skill store under `<data_dir>/skills/`, read-only; absent unless
      // `skills.enabled`, so a disabled installation offers no skill tools.
      ...(config.skills.enabled ? { skills: { db, dataDir: config.dataDir, settings: config.skills } } : {}),
    };
    mcp = await startStdioServer({ ...mcpDeps, clientId });
    mcp.server.onclose = () => resolveStop("mcp transport closed");
    log.info("serving MCP on stdio", {
      client: clientId,
      max_trust_profile: mcp.maxTrustProfile,
      data_dir: config.dataDir,
      adapters: registry.list().map((a) => a.id),
      pid: process.pid,
    });
    // T13.1 (FR-MCP-12): no listener unless `transport.http.enabled`. T13.3 (FR-MCP-13, Q-73): bearer tokens are
    // verified against the hashed rows in the ledger; a refusal logs its reason code only, never the token.
    const oauthTokens = new OAuthTokenStore(db, now ? { now } : {});
    const oauthClients = new OAuthClientStore(db, now ? { now } : {});
    // One wrong-passphrase lockout for the OAuth consent page and the approval-link page (T14.10).
    const passphraseLimiter = new AttemptLimiter();
    const pairing = new PairingCodeStore(db, now ? { now } : {});
    httpListener = await startHttpTransport(config.httpTransport, {
      tokens: oauthTokens,
      onTokenRejected: (reason) => log.warn("refused an HTTP bearer token", { reason }),
      // T13.4 (FR-MCP-14, Q-77): a mapped token gets a stateless MCP server for its configured client, with that
      // client's maximum profile; the same lifecycle, ledger and policy as stdio.
      onClientRefused: (reason, oauthClientId) =>
        log.warn("refused an HTTP MCP request", { reason, client_id: oauthClientId }),
      // T13.5 (FR-MCP-15, Q-78): each meta-session it opens is bound to the token's OAuth client.
      mcpServerFor: (mcpClientId, oauthClientId) =>
        createSwitchboardServer({ ...mcpDeps, clientId: mcpClientId, subject: oauthClientId }),
      // T13.7 (FR-MCP-16, Q-74): open registration creates a pending client only; the operator approves it later.
      clients: oauthClients,
      onClientRegistered: (clientId) =>
        log.info("registered an OAuth client, pending operator approval", { client_id: clientId }),
      // T13.8 (Q-75, Q-76): authorization code + PKCE S256 behind the operator consent page; the audit log gets event
      // names, client ids and reason codes only, never a token, code, passphrase or pairing code.
      ...(config.httpTransport
        ? {
            authorizationServer: new AuthorizationServer(config.httpTransport, {
              clients: oauthClients,
              tokens: oauthTokens,
              pairing,
              limiter: passphraseLimiter,
              ...(config.httpTransport.passphraseHash !== undefined
                ? { passphraseHash: config.httpTransport.passphraseHash }
                : {}),
              ...(now ? { now } : {}),
              onEvent: (event, fields) => log.info("OAuth authorization event", { event, ...fields }),
            }),
          }
        : {}),
      // T14.10 (FR-CTL-09, FR-MCP-17): the approval-link page on the same origin, with the same authentication.
      ...(config.httpTransport && consentLinks
        ? {
            approvalLinks: new ApprovalLinkPage({
              issuer: config.httpTransport.issuer,
              links: consentLinks,
              pairing,
              limiter: passphraseLimiter,
              ...(config.httpTransport.passphraseHash !== undefined
                ? { passphraseHash: config.httpTransport.passphraseHash }
                : {}),
              ...(now ? { now } : {}),
              onEvent: (event, fields) => log.info("consent-page approval link event", { event, ...fields }),
            }),
          }
        : {}),
    });
    if (httpListener && config.httpTransport) {
      log.info("serving MCP on HTTP", {
        bind: httpListener.address.address,
        port: httpListener.address.port,
        resource: config.httpTransport.resource,
      });
    }
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
    gcTimer?.stop();
    // Abort a running build (each committed batch is already consistent). A scan in progress is not interruptible, so
    // shutdown waits for it at most RAG_STOP_WAIT_MS; the ledger write of a late result then fails and is only logged.
    if (rag !== undefined)
      await Promise.race([rag.stop(), new Promise((r) => setTimeout(r, RAG_STOP_WAIT_MS).unref())]);
    await gcInFlight; // a pass still running must finish before the lifecycle and the ledger are closed
    try {
      if (httpListener) await httpListener.close();
    } catch (err) {
      log.warn("closing the HTTP listener failed", { error: message(err) });
    }
    try {
      // onclose fires again here; resolving the already-settled stop promise is a no-op.
      if (mcp) await mcp.close();
    } catch (err) {
      log.warn("closing the MCP transport failed", { error: message(err) });
    }
    try {
      await lifecycle.shutdown();
      await gitTools.closeAll(); // every run closed its own channel; this is a backstop
    } catch (err) {
      log.error("lifecycle shutdown failed", { error: message(err) });
      code = 1;
    }
    await telemetry.close();
    await sinks?.close(); // aborts deliveries in flight; never throws
    process.stdin.destroy(); // nothing reads stdin any more; do not let it hold the event loop open
    process.off("SIGINT", ignore);
    process.off("SIGTERM", ignore);
    log.info("stopped", { code });
  }
  return code;
}

/** T6.9 (NFR-PERF-03): `providers.<config id>.concurrency` re-keyed by adapter provider id, for the dispatcher. */
export function providerLimits(config: Pick<ResolvedConfig, "providers">): ReadonlyMap<string, number> {
  const limits = new Map<string, number>();
  for (const [configId, entry] of config.providers) {
    const adapterId = adapterIdForConfigId(configId);
    if (adapterId !== undefined && entry.concurrency !== undefined) limits.set(adapterId, entry.concurrency);
  }
  return limits;
}

/**
 * T16.5 (FR-SKL-05, LLD §19.6, §19.7): the lifecycle's skill port over the ledger handle and the content store. `load`
 * reads each pinned version's stored file (hash-verified by `readSkillContent`) and returns its canonical body; `record`
 * fills `run_skill.delivery` and `delivered_at`, which admission left for dispatch (`src/skills/admission.ts`).
 */
export function skillDeliveryPort(db: ReturnType<typeof openLedger>, dataDir: string): SkillDeliveryPort {
  return {
    load: (runId) =>
      listRunSkills(db, runId).map((r) => ({
        name: r.name,
        version: r.version,
        sha256: r.sha256,
        body: canonicalBody(readSkillContent(dataDir, r.sha256)),
      })),
    record: (runId, delivery, at) => {
      db.prepare("UPDATE run_skill SET delivery = ?, delivered_at = ? WHERE run_id = ?").run(delivery, at, runId);
    },
  };
}
