/**
 * The evaluation grader (T8.14; FR-OPS-06, LLD §20.13 "Evaluation", ADR-0052). After a task's run ends, the grader
 * copies the agent's worktree (without `.git`) and the task's hidden-test bundle into a staging directory under
 * `<data_dir>/eval/grading/`, and runs the task's test command in a container through the ADR-0052 container-runtime
 * port with network `none`. The hidden tests are copied into the staging directory only, never into the worktree; the
 * grader checks before and after grading that no file of the bundle is present in the worktree (same path, same content).
 *
 * Linus decisions (WORK QUEUE v10, Delegated, not owner-approved): the grader image follows the ADR-0052 pinning rules
 * (a `sha256:` digest resolved among local images, never pulled; a rootless runtime) and gets no login volume; `pass`
 * is the hidden test command's exit code 0 only.
 *
 * Delegated: exactly two mounts (the staged output writable at `/eval/work`, the staged bundle read-only at
 * `/eval/tests`), no forwarded environment, the driver's `--cap-drop ALL` and `no-new-privileges`; the argv is
 * refused unless it carries `--network none`, so a driver change cannot silently grade with networking on.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DEFAULT_PIDS_LIMIT, SWITCHBOARD_ROLE_LABEL, SWITCHBOARD_RUN_LABEL } from "../environment/container.js";
import { DOCKER_CLIENT_ENV } from "../environment/docker-runtime.js";
import type { ContainerRunSpec, ContainerRuntime } from "../environment/runtime.js";
import type { EvalTask } from "./suite.js";

export const GRADER_WORK_DIR = "/eval/work";
export const GRADER_TESTS_DIR = "/eval/tests";
export const GRADER_ROLE = "eval-grader";

export type GradeError =
  | "EVAL_GRADER_UNAVAILABLE"
  | "EVAL_GRADER_NOT_ROOTLESS"
  | "EVAL_GRADER_IMAGE_NOT_PRESENT"
  | "EVAL_GRADER_IMAGE_AMBIGUOUS"
  | "EVAL_GRADER_NETWORK_NOT_OFF"
  | "EVAL_GRADER_FAILED"
  | "EVAL_TESTS_IN_WORKTREE";

export interface GraderExecResult {
  /** Exit code, or null when the process could not start, was killed or timed out. */
  readonly code: number | null;
}

export type GraderExec = (argv: readonly string[], opts: { readonly timeoutMs: number }) => Promise<GraderExecResult>;

export interface GraderPorts {
  readonly runtime: ContainerRuntime;
  /** Spawns the runtime client argv; tests inject a fake that records it. */
  readonly exec: GraderExec;
  /** `<data_dir>/eval/grading`: staging directories are created and removed here. */
  readonly stagingRoot: string;
}

export interface GradeRequest {
  readonly runId: string;
  /** The agent's worktree, read only by the grader. */
  readonly worktreePath: string;
  readonly task: EvalTask;
  readonly imageDigest: string;
  readonly timeoutSeconds: number;
}

export interface GradeOutcome {
  readonly pass: boolean;
  readonly exitCode: number | null;
  readonly error?: GradeError;
  readonly detail?: string;
}

const fail = (error: GradeError, detail: string): GradeOutcome => ({ pass: false, exitCode: null, error, detail });

function walk(root: string, out: string[] = [], rel = ""): string[] {
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel === "" ? entry.name : path.join(rel, entry.name);
    if (entry.isDirectory()) walk(root, out, child);
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

/**
 * The bundle files (relative paths) present in the worktree at the same relative path with identical content. Empty
 * when the hidden tests are absent from the worktree, which is the property the grader asserts. Delegated: a match
 * needs path and content, because content alone flags a correct answer that equals an expected-output file of the
 * bundle, and path alone flags a hidden test that replaces a visible test file of the repository.
 */
export function hiddenTestsInWorktree(worktreePath: string, bundlePath: string): string[] {
  const found: string[] = [];
  for (const rel of walk(bundlePath)) {
    if (rel.split(path.sep)[0] === ".git") continue;
    const candidate = path.join(worktreePath, rel);
    let isFile = false;
    try {
      isFile = statSync(candidate).isFile();
    } catch {
      isFile = false;
    }
    if (isFile && sha256(candidate) === sha256(path.join(bundlePath, rel))) found.push(rel);
  }
  return found.sort();
}

/** True when the argv passes `--network none` to the runtime. */
export function argvHasNetworkNone(argv: readonly string[]): boolean {
  return argv.some((a, i) => (a === "--network" && argv[i + 1] === "none") || a === "--network=none");
}

export function graderContainerName(runId: string): string {
  return `switchboard-eval-${runId}`;
}

/** Grades one task's run. Never throws for a grading problem: the outcome names it and `pass` is false. */
export async function gradeTask(ports: GraderPorts, req: GradeRequest): Promise<GradeOutcome> {
  const leakedBefore = hiddenTestsInWorktree(req.worktreePath, req.task.hiddenTests);
  if (leakedBefore.length > 0) {
    return fail("EVAL_TESTS_IN_WORKTREE", `hidden test content found in the worktree: ${leakedBefore.join(", ")}`);
  }
  const info = await ports.runtime.info();
  if (!info.available) return fail("EVAL_GRADER_UNAVAILABLE", info.detail);
  if (!info.rootless) return fail("EVAL_GRADER_NOT_ROOTLESS", info.detail);
  const image = await ports.runtime.resolveImage(req.imageDigest);
  if (image.kind === "not_present") {
    return fail("EVAL_GRADER_IMAGE_NOT_PRESENT", `${req.imageDigest} is not present locally (never pulled)`);
  }
  if (image.kind === "ambiguous") {
    return fail("EVAL_GRADER_IMAGE_AMBIGUOUS", `${req.imageDigest} matches ${image.imageIds.length} images`);
  }

  mkdirSync(ports.stagingRoot, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(path.join(ports.stagingRoot, `${req.runId}-`));
  const name = graderContainerName(req.runId);
  try {
    const work = path.join(staging, "work");
    const tests = path.join(staging, "tests");
    cpSync(req.worktreePath, work, {
      recursive: true,
      filter: (src) => path.relative(req.worktreePath, src).split(path.sep)[0] !== ".git",
    });
    cpSync(req.task.hiddenTests, tests, { recursive: true });
    if (/[,\n\r]/u.test(staging))
      return fail("EVAL_GRADER_FAILED", "staging path contains a character the runtime cannot carry");
    const spec: ContainerRunSpec = {
      name,
      imageId: image.imageId,
      labels: { [SWITCHBOARD_RUN_LABEL]: req.runId, [SWITCHBOARD_ROLE_LABEL]: GRADER_ROLE },
      mounts: [
        { source: work, target: GRADER_WORK_DIR, readonly: false },
        { source: tests, target: GRADER_TESTS_DIR, readonly: true },
      ],
      network: "none",
      pidsLimit: DEFAULT_PIDS_LIMIT,
      workdir: GRADER_WORK_DIR,
      forwardEnv: [],
      argv: req.task.testCommand,
    };
    let argv: readonly string[];
    try {
      argv = ports.runtime.runArgv(spec);
    } catch (err) {
      return fail("EVAL_GRADER_FAILED", (err as Error).message);
    }
    if (!argvHasNetworkNone(argv)) {
      return fail("EVAL_GRADER_NETWORK_NOT_OFF", "the runtime argv does not carry --network none");
    }
    const r = await ports.exec(argv, { timeoutMs: req.timeoutSeconds * 1000 });
    const leakedAfter = hiddenTestsInWorktree(req.worktreePath, req.task.hiddenTests);
    if (leakedAfter.length > 0) {
      return fail("EVAL_TESTS_IN_WORKTREE", `hidden test content found in the worktree: ${leakedAfter.join(", ")}`);
    }
    if (r.code === null) return fail("EVAL_GRADER_FAILED", "test command did not complete (killed or timed out)");
    return { pass: r.code === 0, exitCode: r.code };
  } finally {
    await ports.runtime.remove(name).catch(() => undefined);
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Spawns the runtime client with only the client's environment allowlist; output is discarded (never recorded). */
export function spawnGraderExec(baseEnv: Readonly<Record<string, string | undefined>> = process.env): GraderExec {
  const env: Record<string, string> = {};
  for (const n of DOCKER_CLIENT_ENV) {
    const v = baseEnv[n];
    if (v !== undefined) env[n] = v;
  }
  return (argv, opts) =>
    new Promise((resolve) => {
      const [exe, ...args] = argv;
      if (exe === undefined) {
        resolve({ code: null });
        return;
      }
      const child = spawn(exe, args, { env, stdio: "ignore" });
      const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ code: null });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code: signal !== null ? null : code });
      });
    });
}
