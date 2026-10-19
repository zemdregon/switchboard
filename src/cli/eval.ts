/**
 * `switchboard eval run <suite> --provider <id> [--live-budget <file>]` and `switchboard eval results <suite>` (T8.14;
 * FR-OPS-06, LLD §20.13 "Evaluation"). An opt-in operator command: it replays each task of the suite file
 * `<data_dir>/eval/<suite>.json` as a normal run on one provider, grades it in a network-off container with the hidden
 * tests outside the agent's worktree (`src/eval/grader.ts`) and records one `eval_result` per task.
 *
 * - It never runs in CI (FR-OPS-06): with `CI` set (other than `false` or `0`), `eval run` reports
 *   `EVAL_SKIPPED_IN_CI`, exits 0 and opens nothing.
 * - A real provider needs `--live-budget <file>` (Linus decision, WORK QUEUE v10; `src/eval/budget.ts`), checked before
 *   the data-directory lock is taken and before any run is admitted. The fake provider needs none.
 * - It holds the data-directory lock for the whole suite, so it refuses (LOCKED) while `serve` runs and no daemon can
 *   start mid-suite (ADR-0005), like `gc --apply`.
 * - The runs go through a `RunLifecycle` built from the same configuration as `serve` (registry, profile resolver,
 *   version gate, project environments), without the MCP server, timers, sinks or retrieval (Delegated).
 */
import path from "node:path";
import type { ProviderId } from "../adapters/index.js";
import { createProbeRunner } from "../adapters/run.js";
import { ArtifactStore } from "../artifacts/index.js";
import { ConfigError, effectiveMaxProfile, loadConfig, primaryContext } from "../config/index.js";
import { createDockerRuntime, snapshotEnvironment } from "../environment/index.js";
import {
  checkLiveBudget,
  EvalRefusal,
  type EvalResultRow,
  EvalSuiteError,
  evalDir,
  isWithin,
  lifecycleReplay,
  listEvalResults,
  loadSuite,
  runSuite,
  spawnGraderExec,
} from "../eval/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { acquireDataDirLock } from "../lock/index.js";
import { createProfileResolver } from "../policy/index.js";
import { DynamicProjectStore } from "../projects/index.js";
import { profileRank } from "../routing/eligibility.js";
import { WorkspaceManager } from "../workspace/index.js";
import { type CliIo, JSON_SCHEMA_VERSION, PROBE_ENV_ALLOWLIST, UsageError } from "./io.js";
import {
  buildRegistry,
  enablement,
  gateFor,
  modelRegistry,
  readFakeSwitch,
  runEnvironments,
  stderrLogger,
} from "./serve.js";

export interface EvalCommandResult {
  readonly code: number;
  readonly data: unknown;
  readonly text: string;
}

export interface EvalOptions {
  readonly provider?: string;
  readonly liveBudget?: string;
}

/** True when the environment says it is CI (`CI` set to anything but empty, `false` or `0`). */
export function isCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const v = env.CI;
  return v !== undefined && v !== "" && v !== "false" && v !== "0";
}

const refusal = (code: string, message: string, exit = 1): EvalCommandResult => ({
  code: exit,
  data: { schema_version: JSON_SCHEMA_VERSION, error: { code, message } },
  text: `switchboard: ${code}: ${message}\n`,
});

function renderRows(suite: string, rows: readonly EvalResultRow[]): string {
  const passed = rows.filter((r) => r.pass === 1).length;
  const lines = rows.map(
    (r) =>
      `  ${r.task_id}  ${r.provider}  ${r.pass === 1 ? "PASS" : "FAIL"}  ${r.wall_clock_ms} ms` +
      `${r.grade_error !== null ? `  ${r.grade_error}` : ""}${r.run_id !== null ? `  ${r.run_id}` : ""}`,
  );
  return `eval ${suite}: ${passed}/${rows.length} passed\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

const toJson = (r: EvalResultRow) => ({ ...r, pass: r.pass === 1, usage: JSON.parse(r.usage_json) as unknown });

export async function runEvalCommand(
  io: CliIo,
  loaderArgv: readonly string[],
  sub: string | undefined,
  rest: readonly string[],
  opts: EvalOptions,
): Promise<EvalCommandResult> {
  if (sub !== "run" && sub !== "results") {
    throw new UsageError(`unknown eval subcommand ${JSON.stringify(sub ?? "")}; expected run or results`);
  }
  if (rest.length !== 1 || rest[0] === undefined) throw new UsageError(`eval ${sub} requires exactly one suite name`);
  const suiteName = rest[0];
  if (sub === "results") {
    if (opts.provider !== undefined || opts.liveBudget !== undefined) {
      throw new UsageError("--provider and --live-budget are only valid with eval run");
    }
    const config = loadConfig({ argv: loaderArgv, env: io.env, ...(io.homedir ? { homedir: io.homedir } : {}) });
    const db = openLedger(config.dataDir);
    try {
      const rows = listEvalResults(db, suiteName);
      return {
        code: 0,
        data: { schema_version: JSON_SCHEMA_VERSION, suite: suiteName, results: rows.map(toJson) },
        text: renderRows(suiteName, rows),
      };
    } finally {
      db.close();
    }
  }

  if (isCi(io.env)) {
    return {
      code: 0,
      data: { schema_version: JSON_SCHEMA_VERSION, suite: suiteName, skipped: "EVAL_SKIPPED_IN_CI" },
      text: "eval run skipped: EVAL_SKIPPED_IN_CI (evaluation never runs in CI, FR-OPS-06)\n",
    };
  }
  const provider = opts.provider;
  if (provider === undefined || provider === "") throw new UsageError("eval run requires --provider <id>");

  const config = loadConfig({ argv: loaderArgv, env: io.env, ...(io.homedir ? { homedir: io.homedir } : {}) });
  let suite: ReturnType<typeof loadSuite>;
  try {
    suite = loadSuite(config.dataDir, suiteName);
    checkLiveBudget(provider, opts.liveBudget, suite.tasks.length);
  } catch (err) {
    if (err instanceof EvalRefusal) return refusal(err.code, err.message);
    if (err instanceof EvalSuiteError) return refusal("EVAL_SUITE_INVALID", err.message);
    throw err;
  }
  const project = config.projects.find((p) => p.id === suite.project);
  if (project === undefined) {
    throw new ConfigError(`suite ${suite.name}: project ${JSON.stringify(suite.project)} is not configured`);
  }
  const effectiveMax = effectiveMaxProfile("trusted-development", project);
  if (profileRank(suite.trustProfile) > profileRank(effectiveMax)) {
    return refusal("EVAL_SUITE_INVALID", `trust_profile ${suite.trustProfile} exceeds project ceiling ${effectiveMax}`);
  }
  for (const c of project.contexts) {
    for (const t of suite.tasks) {
      if (isWithin(t.hiddenTests, c.path) || isWithin(c.path, t.hiddenTests)) {
        return refusal("EVAL_SUITE_INVALID", `task ${t.id}: hidden tests overlap project context ${c.id}`);
      }
    }
  }

  const fake = readFakeSwitch(io.env);
  const registry = buildRegistry(fake, { claudeGitChannel: config.claudeCodeGitChannel });
  if (!registry.list().some((a) => a.id === provider)) {
    throw new UsageError(`unknown or unavailable provider ${JSON.stringify(provider)}`);
  }

  const lock = acquireDataDirLock(config.dataDir); // LockError while a serve daemon holds it
  const db = openLedger(config.dataDir);
  const ids = createIdGenerator();
  const now = io.now;
  const ledger = createLedger(db, { ids, ...(now ? { now } : {}) });
  const artifacts = new ArtifactStore(path.join(config.dataDir, "artifacts"));
  const workspace = new WorkspaceManager({
    db,
    artifacts,
    dataDir: config.dataDir,
    allowedRoots: config.allowedRoots,
    ids,
  });
  const makeRuntime = io.containerRuntime ?? createDockerRuntime;
  const environments = runEnvironments(
    config,
    new DynamicProjectStore(db, { ids, ...(now ? { now } : {}) }),
    ledger,
    stderrLogger(io),
    makeRuntime,
  );
  const lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots: config.allowedRoots,
    globalConcurrency: 1,
    resolveProfile: createProfileResolver(config.profileOverrides),
    probeRunner: createProbeRunner(PROBE_ENV_ALLOWLIST),
    baseEnv: io.env,
    eligibility: {
      gate: gateFor(registry, fake, config.dataDir),
      isEnabled: enablement(config, fake),
      models: modelRegistry(config),
    },
    ...(environments !== undefined ? { environments } : {}),
    ...(now ? { now } : {}),
  });
  lifecycle.start();
  try {
    await workspace.checkGit();
    const context = primaryContext(project);
    const rows = await runSuite(
      {
        db,
        ids,
        ...(now ? { now } : {}),
        replay: lifecycleReplay({
          lifecycle,
          ledger,
          workspace: context.path,
          suite,
          project: {
            id: project.id,
            name: project.name,
            ...snapshotEnvironment(project),
            context_id: context.id,
            base_ref: context.baseRef,
            effective_max_profile: effectiveMax,
            ...(project.allowedProviders !== undefined ? { allowed_providers: [...project.allowedProviders] } : {}),
            // Delegated: an evaluation run never commits or pushes (no identity, push disabled).
            writable: false,
            push: { policy: "none" },
          },
        }),
        grader: {
          runtime: makeRuntime(),
          exec: io.graderExec ?? spawnGraderExec(io.env),
          stagingRoot: path.join(evalDir(config.dataDir), "grading"),
        },
      },
      suite,
      provider as ProviderId,
    );
    return {
      code: 0,
      data: { schema_version: JSON_SCHEMA_VERSION, suite: suite.name, provider, results: rows.map(toJson) },
      text: renderRows(suite.name, rows),
    };
  } finally {
    await lifecycle.shutdown();
    db.close();
    lock.release();
  }
}
