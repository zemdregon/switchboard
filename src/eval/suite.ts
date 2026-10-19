/**
 * Evaluation suite files (T8.14; FR-OPS-06, LLD §20.13 "Evaluation"). A suite is a JSON file in the data directory,
 * `<data_dir>/eval/<suite>.json`, written by the operator. Each task names the base ref its run starts from, the
 * objective the run is given and a hidden-test bundle: a directory under `<data_dir>/eval/` that is copied into the
 * grader container only, never into the agent's worktree.
 *
 * Delegated choices (least privilege, fail closed):
 * - The suite name is a plain file name (no separators, no `..`); the file and every bundle are resolved through
 *   `realpath` and refused when they leave `<data_dir>/eval/` (a symbolic link cannot point a bundle elsewhere).
 * - The grader image is pinned by digest (`sha256:<64 hex>`, the project image rule of ADR-0013 and ADR-0052).
 * - The trust profile defaults to `edit-untrusted`; `privileged` is refused (an evaluation never runs under bypass).
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { TrustProfile } from "../ledger/index.js";

export const EVAL_DIR_NAME = "eval";
export const SUITE_SCHEMA_VERSION = 1;
/** Assumption: a grading command that runs longer than this is a hung test, not a slow one. */
export const DEFAULT_GRADER_TIMEOUT_SECONDS = 600;
export const MAX_GRADER_TIMEOUT_SECONDS = 3600;
export const MAX_SUITE_TASKS = 200;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const EVAL_PROFILES: readonly TrustProfile[] = [
  "inspect-untrusted",
  "edit-untrusted",
  "test-sandboxed",
  "trusted-development",
];

export interface EvalTask {
  readonly id: string;
  /** The ref the replayed run's worktree starts from (the project's `base_ref` for this run). */
  readonly baseRef: string;
  readonly objective: string;
  /** Absolute, canonical path of the hidden-test bundle directory (inside `<data_dir>/eval/`). */
  readonly hiddenTests: string;
  /** argv run in the grader container with the agent's output at the working directory; exit 0 is a pass. */
  readonly testCommand: readonly string[];
}

export interface EvalSuite {
  readonly name: string;
  /** The configured project every task is replayed under. */
  readonly project: string;
  readonly trustProfile: TrustProfile;
  readonly grader: { readonly imageDigest: string; readonly timeoutSeconds: number };
  readonly tasks: readonly EvalTask[];
}

export class EvalSuiteError extends Error {
  override readonly name = "EvalSuiteError";
}

/** `<data_dir>/eval`. */
export function evalDir(dataDir: string): string {
  return path.join(dataDir, EVAL_DIR_NAME);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isArgv = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === "string") && (v[0] as string) !== "";

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new EvalSuiteError(`${at}: unknown key ${JSON.stringify(k)}`);
  }
}

/** True when `child` is `parent` or inside it (both canonical). */
export function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Parses a suite's JSON text. `root` is the canonical `<data_dir>/eval` directory every bundle must stay inside;
 * bundles are resolved against it.
 */
export function parseSuite(name: string, text: string, root: string): EvalSuite {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new EvalSuiteError(`suite ${name}: invalid JSON: ${(err as Error).message.slice(0, 200)}`);
  }
  if (!isObject(raw)) throw new EvalSuiteError(`suite ${name}: not a JSON object`);
  onlyKeys(raw, ["schema_version", "project", "trust_profile", "grader", "tasks"], `suite ${name}`);
  if (raw.schema_version !== SUITE_SCHEMA_VERSION) {
    throw new EvalSuiteError(`suite ${name}: schema_version must be ${SUITE_SCHEMA_VERSION}`);
  }
  if (!nonEmpty(raw.project)) throw new EvalSuiteError(`suite ${name}: project is required`);
  const trustProfile = (raw.trust_profile ?? "edit-untrusted") as TrustProfile;
  if (!EVAL_PROFILES.includes(trustProfile)) {
    throw new EvalSuiteError(
      `suite ${name}: trust_profile must be one of ${EVAL_PROFILES.join(", ")} (privileged is never used for evaluation)`,
    );
  }
  const g = raw.grader;
  if (!isObject(g)) throw new EvalSuiteError(`suite ${name}: grader is required`);
  onlyKeys(g, ["image_digest", "timeout_seconds", "test_command"], `suite ${name}: grader`);
  if (typeof g.image_digest !== "string" || !DIGEST_PATTERN.test(g.image_digest)) {
    throw new EvalSuiteError(`suite ${name}: grader.image_digest must be pinned as sha256:<64 hex>`);
  }
  const timeoutSeconds = g.timeout_seconds ?? DEFAULT_GRADER_TIMEOUT_SECONDS;
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > MAX_GRADER_TIMEOUT_SECONDS
  ) {
    throw new EvalSuiteError(
      `suite ${name}: grader.timeout_seconds must be an integer from 1 to ${MAX_GRADER_TIMEOUT_SECONDS}`,
    );
  }
  if (g.test_command !== undefined && !isArgv(g.test_command)) {
    throw new EvalSuiteError(`suite ${name}: grader.test_command must be a non-empty argv array of strings`);
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new EvalSuiteError(`suite ${name}: tasks must be a non-empty array`);
  }
  if (raw.tasks.length > MAX_SUITE_TASKS) {
    throw new EvalSuiteError(`suite ${name}: at most ${MAX_SUITE_TASKS} tasks`);
  }
  const seen = new Set<string>();
  const tasks = raw.tasks.map((t, i): EvalTask => {
    const at = `suite ${name}: tasks[${i}]`;
    if (!isObject(t)) throw new EvalSuiteError(`${at}: not an object`);
    onlyKeys(t, ["id", "base_ref", "objective", "hidden_tests", "test_command"], at);
    if (typeof t.id !== "string" || !NAME_PATTERN.test(t.id)) {
      throw new EvalSuiteError(`${at}.id must match ${NAME_PATTERN.source}`);
    }
    if (seen.has(t.id)) throw new EvalSuiteError(`${at}.id ${JSON.stringify(t.id)} repeats`);
    seen.add(t.id);
    if (!nonEmpty(t.base_ref) || t.base_ref.startsWith("-")) {
      throw new EvalSuiteError(`${at}.base_ref must be a ref name`);
    }
    if (!nonEmpty(t.objective)) throw new EvalSuiteError(`${at}.objective is required`);
    if (!nonEmpty(t.hidden_tests) || path.isAbsolute(t.hidden_tests)) {
      throw new EvalSuiteError(`${at}.hidden_tests must be a path relative to ${root}`);
    }
    const testCommand = t.test_command ?? g.test_command;
    if (!isArgv(testCommand)) {
      throw new EvalSuiteError(`${at}.test_command (or grader.test_command) must be a non-empty argv array of strings`);
    }
    return {
      id: t.id,
      baseRef: t.base_ref,
      objective: t.objective,
      hiddenTests: resolveBundle(path.join(root, t.hidden_tests), root, `${at}.hidden_tests`),
      testCommand,
    };
  });
  return {
    name,
    project: raw.project,
    trustProfile,
    grader: { imageDigest: g.image_digest, timeoutSeconds },
    tasks,
  };
}

function resolveBundle(candidate: string, root: string, at: string): string {
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new EvalSuiteError(`${at}: ${candidate} does not exist`);
  }
  if (!isWithin(real, root) || real === root) {
    throw new EvalSuiteError(`${at}: resolves outside ${root}`);
  }
  if (!statSync(real).isDirectory()) throw new EvalSuiteError(`${at}: not a directory`);
  return real;
}

/** Reads `<data_dir>/eval/<name>.json`. */
export function loadSuite(dataDir: string, name: string): EvalSuite {
  if (!NAME_PATTERN.test(name)) {
    throw new EvalSuiteError(`suite name must match ${NAME_PATTERN.source} (a file name in ${evalDir(dataDir)})`);
  }
  const dir = evalDir(dataDir);
  const file = path.join(dir, `${name}.json`);
  if (!existsSync(file)) throw new EvalSuiteError(`suite ${name}: ${file} does not exist`);
  const root = realpathSync(dir);
  const real = realpathSync(file);
  if (!isWithin(real, root)) throw new EvalSuiteError(`suite ${name}: ${file} resolves outside ${root}`);
  return parseSuite(name, readFileSync(real, "utf8"), root);
}
