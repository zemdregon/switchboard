/**
 * Own-repository evaluation (T8.14; FR-OPS-06, LLD §20.13 "Evaluation"). Done-when, on the fake provider and a fixture
 * suite: each task yields an `eval_result` with pass, wall-clock and usage; the grader runs network-off and its tests
 * are absent from the agent's worktree (asserted); a real provider is refused without a live budget file; the command
 * is skipped in CI (`src/cli/eval.test.ts`).
 *
 * Each task is replayed as a normal run through a real `RunLifecycle` with the fake adapter (`edit_files`). No Docker
 * is involved: the grader gets the real ADR-0052 Docker driver (`createDockerRuntime`) over a scripted client, so the
 * argv under test is the driver's own, and a recording exec stands in for the runtime and plays the hidden test.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createDockerRuntime, type DockerExec } from "../environment/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import type { ProjectSnapshot } from "../policy/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import {
  argvHasNetworkNone,
  checkLiveBudget,
  EvalRefusal,
  EvalSuiteError,
  GRADER_TESTS_DIR,
  GRADER_WORK_DIR,
  type GraderExec,
  hiddenTestsInWorktree,
  lifecycleReplay,
  listEvalResults,
  loadSuite,
  runSuite,
} from "./index.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const PROFILE: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};
const DIGEST = `sha256:${"b".repeat(64)}`;
const IMAGE_ID = `sha256:${"c".repeat(64)}`;
const PROJECT: ProjectSnapshot = {
  id: "web",
  name: "Web",
  environment_kind: "host",
  context_id: "main",
  base_ref: "main",
  effective_max_profile: "trusted-development",
};
/** The hidden test of every fixture task: the agent's `answer.txt` must equal the bundle's `expected.txt`. */
const HIDDEN_CHECK = "// hidden grader check: answer.txt must equal expected.txt\n";

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-eval-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  g(repo, "branch", "old");
  writeFileSync(path.join(repo, "README.md"), "hello again\n");
  g(repo, "commit", "-q", "-am", "second");
  dataDir = path.join(root, "data");
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function startLifecycle(): RunLifecycle {
  const ids = createIdGenerator();
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  lifecycle = new RunLifecycle({
    ledger,
    workspace: new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids }),
    artifacts,
    adapters: new AdapterRegistry().register(new FakeAdapter({ scenario: "edit_files", timeouts: PATIENT })),
    allowedRoots: [root],
    globalConcurrency: 1,
    resolveProfile: () => PROFILE,
  });
  lifecycle.start();
  return lifecycle;
}

interface FixtureTask {
  id: string;
  base_ref?: string;
  files: Record<string, string>;
  expected: string;
}

/** Writes `<data_dir>/eval/<name>.json` and one hidden-test bundle per task under `<data_dir>/eval/bundles/`. */
function writeSuite(name: string, tasks: FixtureTask[], over: Record<string, unknown> = {}): void {
  const dir = path.join(dataDir, "eval");
  for (const t of tasks) {
    const bundle = path.join(dir, "bundles", t.id);
    mkdirSync(bundle, { recursive: true });
    writeFileSync(path.join(bundle, "expected.txt"), t.expected);
    writeFileSync(path.join(bundle, "check.test.mjs"), HIDDEN_CHECK);
  }
  writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({
      schema_version: 1,
      project: "web",
      grader: { image_digest: DIGEST, test_command: ["node", `${GRADER_TESTS_DIR}/check.test.mjs`] },
      tasks: tasks.map((t) => ({
        id: t.id,
        base_ref: t.base_ref ?? "main",
        objective: JSON.stringify({ files: t.files, usage: { input_tokens: 11, output_tokens: 3 } }),
        hidden_tests: `bundles/${t.id}`,
      })),
      ...over,
    }),
  );
}

/** The real ADR-0052 Docker driver over a scripted client: rootless, the pinned image present (or not), `rm` echoed. */
function scriptedDocker(opts: { image?: "found" | "missing" } = {}) {
  const calls: string[][] = [];
  const exec: DockerExec = (args) => {
    calls.push([...args]);
    if (args[0] === "info") return Promise.resolve({ code: 0, stdout: '29.8.2\t["name=rootless"]\n', stderr: "" });
    if (args[0] === "image") {
      const stdout = opts.image === "missing" ? "" : `${IMAGE_ID}\t${DIGEST}\n`;
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    }
    if (args[0] === "rm") return Promise.resolve({ code: 0, stdout: `${args[2]}\n`, stderr: "" });
    return Promise.resolve({ code: 1, stdout: "", stderr: "unexpected" });
  };
  return { runtime: createDockerRuntime({ clientPath: "/opt/fake/docker", exec, baseEnv: {} }), calls };
}

interface GradeCall {
  argv: string[];
  mounts: { src: string; dst: string; readonly: boolean }[];
  /** Hidden-test content found in the agent's worktree while the grader ran. */
  leakedDuringGrade: string[];
}

/**
 * Stands in for `docker run`: records the argv, reads the bind mounts from it and plays the hidden test against the
 * staged copies (exit 0 when `answer.txt` equals the bundle's `expected.txt`, else 1).
 */
function recordingGraderExec(): { exec: GraderExec; calls: GradeCall[] } {
  const calls: GradeCall[] = [];
  const exec: GraderExec = (argv) => {
    const mounts = argv.flatMap((a, i) => {
      if (argv[i - 1] !== "--mount") return [];
      const kv = Object.fromEntries(a.split(",").map((p) => p.split("=") as [string, string]));
      return [{ src: kv.src as string, dst: kv.dst as string, readonly: a.split(",").includes("readonly") }];
    });
    const runLabel = argv.find((a) => a.startsWith("switchboard.run="))?.slice("switchboard.run=".length) ?? "";
    const worktree = ledger.getRunRecord(runLabel)?.worktree_path ?? "";
    const bundle = mounts.find((m) => m.dst === GRADER_TESTS_DIR)?.src ?? "";
    calls.push({ argv: [...argv], mounts, leakedDuringGrade: hiddenTestsInWorktree(worktree, bundle) });
    const work = mounts.find((m) => m.dst === GRADER_WORK_DIR)?.src ?? "";
    const answer = path.join(work, "answer.txt");
    const pass =
      existsSync(answer) && readFileSync(answer, "utf8") === readFileSync(path.join(bundle, "expected.txt"), "utf8");
    return Promise.resolve({ code: pass ? 0 : 1 });
  };
  return { exec, calls };
}

async function evaluate(name: string, docker = scriptedDocker()) {
  const lc = startLifecycle();
  const suite = loadSuite(dataDir, name);
  const grader = recordingGraderExec();
  const rows = await runSuite(
    {
      db,
      ids: createIdGenerator(),
      replay: lifecycleReplay({ lifecycle: lc, ledger, project: PROJECT, workspace: repo, suite }),
      grader: { runtime: docker.runtime, exec: grader.exec, stagingRoot: path.join(dataDir, "eval", "grading") },
    },
    suite,
    "fake",
  );
  return { rows, grader, docker, suite };
}

describe("eval run on the fake provider and a fixture suite (T8.14, FR-OPS-06)", () => {
  it("replays each task as a normal run and records an eval_result with pass, wall-clock and usage", async () => {
    writeSuite("fixture", [
      { id: "right", files: { "answer.txt": "42\n" }, expected: "42\n" },
      { id: "wrong", base_ref: "old", files: { "answer.txt": "41\n" }, expected: "42\n" },
    ]);
    const { rows } = await evaluate("fixture");

    const stored = listEvalResults(db, "fixture");
    expect(stored).toEqual(rows);
    expect(stored.map((r) => [r.task_id, r.provider, r.pass, r.test_exit_code, r.grade_error])).toEqual([
      ["right", "fake", 1, 0, null],
      ["wrong", "fake", 0, 1, null],
    ]);
    for (const r of stored) {
      expect(Number.isInteger(r.wall_clock_ms) && r.wall_clock_ms >= 0).toBe(true);
      expect(JSON.parse(r.usage_json)).toEqual([{ input_tokens: 11, output_tokens: 3 }]);
      // A normal run: admitted under the project, SUCCEEDED, from the task's base ref, with its own worktree.
      const run = ledger.getRunRecord(r.run_id as string);
      expect(run?.state).toBe("SUCCEEDED");
      expect(r.run_state).toBe("SUCCEEDED");
      expect(run?.project_id).toBe("web");
      expect(JSON.parse(run?.request_json ?? "{}").base_ref).toBe(r.task_id === "wrong" ? "old" : "main");
      expect(readFileSync(path.join(run?.worktree_path as string, "answer.txt"), "utf8")).toBe(
        r.task_id === "right" ? "42\n" : "41\n",
      );
    }
  });

  it("grades network-off through the ADR-0052 driver, hidden tests only in the grader, never in the worktree", async () => {
    writeSuite("fixture", [{ id: "right", files: { "answer.txt": "42\n" }, expected: "42\n" }]);
    const { rows, grader, docker } = await evaluate("fixture");
    expect(rows[0]?.pass).toBe(1);

    expect(grader.calls).toHaveLength(1);
    const call = grader.calls[0] as GradeCall;
    // Network off, asserted on the argv the real Docker driver assembled.
    expect(argvHasNetworkNone(call.argv)).toBe(true);
    expect(call.argv.slice(call.argv.indexOf("--network"), call.argv.indexOf("--network") + 2)).toEqual([
      "--network",
      "none",
    ]);
    // The pinned image id, resolved locally (never pulled), and no login volume or forwarded environment.
    expect(call.argv).toContain(IMAGE_ID);
    expect(docker.calls.some((c) => c[0] === "pull")).toBe(false);
    expect(call.argv).not.toContain("--env");
    expect(call.argv).not.toContain("--volume");
    expect(call.mounts.map((m) => [m.dst, m.readonly])).toEqual([
      [GRADER_WORK_DIR, false],
      [GRADER_TESTS_DIR, true],
    ]);
    const run = ledger.getRunRecord(rows[0]?.run_id as string);
    const worktree = run?.worktree_path as string;
    for (const m of call.mounts) {
      // Staged copies under <data_dir>/eval/grading: neither the worktree nor the bundle itself is mounted.
      expect(m.src.startsWith(path.join(dataDir, "eval", "grading"))).toBe(true);
      expect(m.src.startsWith(worktree)).toBe(false);
    }
    // The hidden tests are absent from the agent's worktree, during grading and after it.
    expect(call.leakedDuringGrade).toEqual([]);
    const bundle = path.join(dataDir, "eval", "bundles", "right");
    expect(hiddenTestsInWorktree(worktree, bundle)).toEqual([]);
    expect(existsSync(path.join(worktree, "check.test.mjs"))).toBe(false);
    expect(existsSync(path.join(worktree, "expected.txt"))).toBe(false);
    // The staging copy and the grader container are removed.
    expect(readdirSync(path.join(dataDir, "eval", "grading"))).toEqual([]);
    expect(docker.calls.some((c) => c[0] === "rm" && c[2] === `switchboard-eval-${rows[0]?.run_id}`)).toBe(true);
  });

  it("fails a task whose worktree holds the hidden test content, without running the grader", async () => {
    writeSuite("leak", [
      { id: "leak", files: { "answer.txt": "42\n", "check.test.mjs": HIDDEN_CHECK }, expected: "42\n" },
    ]);
    const { rows, grader } = await evaluate("leak");
    expect(rows.map((r) => [r.pass, r.test_exit_code, r.grade_error])).toEqual([[0, null, "EVAL_TESTS_IN_WORKTREE"]]);
    expect(grader.calls).toEqual([]);
  });

  it("refuses a grader image that is not present locally (never pulled) and records a failed task", async () => {
    writeSuite("fixture", [{ id: "right", files: { "answer.txt": "42\n" }, expected: "42\n" }]);
    const docker = scriptedDocker({ image: "missing" });
    const { rows, grader } = await evaluate("fixture", docker);
    expect(rows.map((r) => [r.pass, r.grade_error])).toEqual([[0, "EVAL_GRADER_IMAGE_NOT_PRESENT"]]);
    expect(grader.calls).toEqual([]);
    expect(docker.calls.some((c) => c[0] === "pull" || c[0] === "run")).toBe(false);
  });

  it("refuses to grade when the runtime argv does not carry --network none", async () => {
    writeSuite("fixture", [{ id: "right", files: { "answer.txt": "42\n" }, expected: "42\n" }]);
    const docker = scriptedDocker();
    const real = docker.runtime;
    const networked = {
      runtime: {
        ...real,
        runArgv: (spec: Parameters<typeof real.runArgv>[0]) => real.runArgv({ ...spec, network: "default" }),
      },
      calls: docker.calls,
    };
    const { rows, grader } = await evaluate("fixture", networked);
    expect(rows.map((r) => [r.pass, r.grade_error])).toEqual([[0, "EVAL_GRADER_NETWORK_NOT_OFF"]]);
    expect(grader.calls).toEqual([]);
  });
});

describe("live budget (Linus decision, WORK QUEUE v10)", () => {
  const budget = (content: string): string => {
    const file = path.join(root, "budget.json");
    writeFileSync(file, content);
    return file;
  };

  it("the fake provider needs no budget", () => {
    expect(checkLiveBudget("fake", undefined, 3)).toBeUndefined();
  });

  it("refuses a real provider with EVAL_LIVE_BUDGET_REQUIRED unless the file exists, parses, names it and max_runs > 0", () => {
    const cases: (string | undefined)[] = [
      undefined,
      path.join(root, "missing.json"),
      budget("not json"),
      budget("[]"),
      budget(JSON.stringify({ provider: "codex", max_runs: 5 })),
      budget(JSON.stringify({ provider: "claude", max_runs: 0 })),
      budget(JSON.stringify({ provider: "claude", max_runs: 1.5 })),
      budget(JSON.stringify({ provider: "claude" })),
    ];
    for (const file of cases) {
      let thrown: unknown;
      try {
        checkLiveBudget("claude", file, 1);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(EvalRefusal);
      expect((thrown as EvalRefusal).code).toBe("EVAL_LIVE_BUDGET_REQUIRED");
    }
    expect(checkLiveBudget("claude", budget(JSON.stringify({ provider: "claude", max_runs: 2 })), 2)).toEqual({
      provider: "claude",
      maxRuns: 2,
    });
  });

  it("refuses a suite with more tasks than the budget allows (EVAL_LIVE_BUDGET_EXCEEDED)", () => {
    const file = budget(JSON.stringify({ provider: "claude", max_runs: 1 }));
    expect(() => checkLiveBudget("claude", file, 2)).toThrow(EvalRefusal);
  });
});

describe("suite files", () => {
  const write = (name: string, body: unknown): void => {
    mkdirSync(path.join(dataDir, "eval", "bundles", "t"), { recursive: true });
    writeFileSync(path.join(dataDir, "eval", `${name}.json`), JSON.stringify(body));
  };
  const base = {
    schema_version: 1,
    project: "web",
    grader: { image_digest: DIGEST, test_command: ["true"] },
    tasks: [{ id: "t", base_ref: "main", objective: "x", hidden_tests: "bundles/t" }],
  };

  it("loads a valid suite with the bundle resolved inside <data_dir>/eval", () => {
    write("ok", base);
    const s = loadSuite(dataDir, "ok");
    expect(s.trustProfile).toBe("edit-untrusted");
    expect(s.tasks[0]?.hiddenTests).toBe(path.join(realpathSync(path.join(dataDir, "eval")), "bundles", "t"));
  });

  it("refuses a bundle outside <data_dir>/eval, an unpinned image, privileged and a path-like suite name", () => {
    mkdirSync(path.join(root, "outside"));
    write("escape", { ...base, tasks: [{ ...base.tasks[0], hidden_tests: "../../outside" }] });
    expect(() => loadSuite(dataDir, "escape")).toThrow(/outside/u);
    write("unpinned", { ...base, grader: { image_digest: "latest", test_command: ["true"] } });
    expect(() => loadSuite(dataDir, "unpinned")).toThrow(/sha256/u);
    write("priv", { ...base, trust_profile: "privileged" });
    expect(() => loadSuite(dataDir, "priv")).toThrow(EvalSuiteError);
    expect(() => loadSuite(dataDir, "../ok")).toThrow(EvalSuiteError);
  });
});
