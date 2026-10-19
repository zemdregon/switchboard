/**
 * `switchboard eval run <suite>` core (T8.14; FR-OPS-06, LLD §20.13 "Evaluation"). Each task of the suite is replayed
 * as a normal run through {@link RunLifecycle.submit} (admission, preflight, worktree, adapter, terminal state), one
 * at a time, then graded by `./grader.ts`; one `eval_result` row is written per task. The lifecycle is not changed.
 */
import type Database from "better-sqlite3";
import type { ProviderId } from "../adapters/index.js";
import type { IdGenerator } from "../ids/index.js";
import type { Ledger, RunState } from "../ledger/index.js";
import type { RunLifecycle } from "../lifecycle/index.js";
import type { ProjectSnapshot } from "../policy/index.js";
import { type GradeOutcome, type GraderPorts, gradeTask } from "./grader.js";
import type { EvalSuite, EvalTask } from "./suite.js";

/** The MCP-client id evaluation runs are admitted under (idempotency scope only; never a configured client). */
export const EVAL_CLIENT_ID = "switchboard-eval";

export interface EvalResultRow {
  readonly id: string;
  readonly suite: string;
  readonly task_id: string;
  readonly provider: string;
  readonly run_id: string | null;
  readonly run_state: string | null;
  readonly pass: 0 | 1;
  readonly test_exit_code: number | null;
  readonly grade_error: string | null;
  readonly wall_clock_ms: number;
  readonly usage_json: string;
  readonly created_at: string;
}

export function insertEvalResult(db: Database.Database, row: EvalResultRow): void {
  db.prepare(
    `INSERT INTO eval_result (id, suite, task_id, provider, run_id, run_state, pass, test_exit_code, grade_error,
       wall_clock_ms, usage_json, created_at)
     VALUES (@id, @suite, @task_id, @provider, @run_id, @run_state, @pass, @test_exit_code, @grade_error,
       @wall_clock_ms, @usage_json, @created_at)`,
  ).run(row);
}

export function listEvalResults(db: Database.Database, suite: string): EvalResultRow[] {
  return db.prepare("SELECT * FROM eval_result WHERE suite = ? ORDER BY created_at, id").all(suite) as EvalResultRow[];
}

/** Outcome of one replayed run. */
export interface ReplayOutcome {
  readonly runId: string | null;
  readonly state: RunState | null;
  readonly worktreePath: string | null;
  /** Provider-reported usage metrics of the run, oldest first. */
  readonly usage: readonly Record<string, unknown>[];
  /** Set when the run could not be admitted (nothing ran). */
  readonly error?: string;
}

/** Replays one task as a run; the production and test implementation is {@link lifecycleReplay}. */
export type EvalReplay = (task: EvalTask, provider: ProviderId) => Promise<ReplayOutcome>;

export interface LifecycleReplayDeps {
  readonly lifecycle: Pick<RunLifecycle, "submit" | "waitForTerminal" | "canonicalWorkspace">;
  readonly ledger: Pick<Ledger, "getRunRecord" | "listUsageObservationsForRun">;
  /** The project's snapshot; `base_ref` is replaced by the task's. */
  readonly project: ProjectSnapshot;
  /** The project's primary context path (the run's workspace). */
  readonly workspace: string;
  readonly suite: Pick<EvalSuite, "trustProfile">;
}

/** Submits the task as a normal, new run in the project and waits for its terminal state. */
export function lifecycleReplay(deps: LifecycleReplayDeps): EvalReplay {
  return async (task, provider) => {
    let runId: string;
    try {
      const workspace = await deps.lifecycle.canonicalWorkspace(deps.workspace, deps.suite.trustProfile);
      const submitted = await deps.lifecycle.submit({
        clientId: EVAL_CLIENT_ID,
        objective: task.objective,
        workspace,
        trustProfile: deps.suite.trustProfile,
        provider,
        priority: "batch",
        project: { ...deps.project, base_ref: task.baseRef },
      });
      runId = submitted.runId;
    } catch (err) {
      return { runId: null, state: null, worktreePath: null, usage: [], error: (err as Error).message.slice(0, 300) };
    }
    const run = await deps.lifecycle.waitForTerminal(runId);
    const usage = deps.ledger.listUsageObservationsForRun(runId).map((u) => {
      try {
        return JSON.parse(u.metrics_json) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
    return { runId, state: run.state, worktreePath: run.worktree_path, usage };
  };
}

export interface RunSuiteDeps {
  readonly db: Database.Database;
  readonly ids: IdGenerator;
  readonly replay: EvalReplay;
  readonly grader: GraderPorts;
  readonly now?: () => Date;
}

/** Runs every task of the suite on `provider` and records one `eval_result` per task. */
export async function runSuite(deps: RunSuiteDeps, suite: EvalSuite, provider: ProviderId): Promise<EvalResultRow[]> {
  const now = deps.now ?? (() => new Date());
  const rows: EvalResultRow[] = [];
  for (const task of suite.tasks) {
    const started = now().getTime();
    const replayed = await deps.replay(task, provider);
    const wallClockMs = Math.max(0, now().getTime() - started);
    let grade: GradeOutcome;
    if (replayed.runId === null) {
      grade = { pass: false, exitCode: null, detail: replayed.error ?? "not admitted" };
    } else if (replayed.state !== "SUCCEEDED" || replayed.worktreePath === null) {
      grade = { pass: false, exitCode: null };
    } else {
      grade = await gradeTask(deps.grader, {
        runId: replayed.runId,
        worktreePath: replayed.worktreePath,
        task,
        imageDigest: suite.grader.imageDigest,
        timeoutSeconds: suite.grader.timeoutSeconds,
      });
    }
    const gradeError =
      replayed.runId === null
        ? "EVAL_RUN_NOT_ADMITTED"
        : replayed.state !== "SUCCEEDED"
          ? `EVAL_RUN_${replayed.state ?? "UNKNOWN"}`
          : (grade.error ?? null);
    const row: EvalResultRow = {
      id: `evl_${deps.ids.ulid()}`,
      suite: suite.name,
      task_id: task.id,
      provider,
      run_id: replayed.runId,
      run_state: replayed.state,
      pass: grade.pass && grade.exitCode === 0 ? 1 : 0,
      test_exit_code: grade.exitCode,
      grade_error: gradeError,
      wall_clock_ms: wallClockMs,
      usage_json: JSON.stringify(replayed.usage),
      created_at: now().toISOString(),
    };
    insertEvalResult(deps.db, row);
    rows.push(row);
  }
  return rows;
}
