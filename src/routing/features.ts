/**
 * FR-RTE-04 heuristic task classifier (`heuristic.v1`, LLD §17.2, ADR-0044 item 4). Pure: a function of the validated
 * request only (no repository metadata in M7, Q-82). The thresholds and keyword lists are Assumptions. Output uses the
 * LLD §13.6 `route_features` enumeration, each value tagged `source: "heuristic"`. No feature ranks a provider in M7: no
 * source maps a feature to a provider's fitness, so the scorer never reads them (Q-82).
 */

export const CLASSIFIER_VERSION = "heuristic.v1";

export type Level = "low" | "medium" | "high";
export type ContextVolume = "small" | "medium" | "large";
export type TaskKind = "bug_fix" | "feature" | "refactor" | "test" | "docs" | "investigation" | "other";

export interface FeatureValue<T extends string> {
  value: T;
  source: "heuristic";
}

export interface RouteFeatures {
  classifier: typeof CLASSIFIER_VERSION;
  context_volume: FeatureValue<ContextVolume>;
  autonomy: FeatureValue<Level>;
  reasoning_depth: FeatureValue<Level>;
  task_kind: FeatureValue<TaskKind>;
}

export interface ClassifierInput {
  objective: string;
  constraints: readonly string[];
  verificationCommands: number;
  /** False only for a read-only profile (`inspect-untrusted`). */
  writable: boolean;
}

/** Assumptions (LLD §17.2): characters of objective plus constraints. */
export const SMALL_CHARS = 400;
export const MEDIUM_CHARS = 2000;

/** First match wins, in this order (LLD §17.2). Whole words, case-insensitive. */
const KIND_WORDS: readonly (readonly [TaskKind, readonly string[]])[] = [
  ["investigation", ["investigate", "why", "explain", "analyse", "analyze", "diagnose"]],
  ["test", ["test", "tests"]],
  ["docs", ["doc", "docs", "readme", "documentation"]],
  ["refactor", ["refactor", "rename", "restructure"]],
  ["bug_fix", ["fix", "bug", "crash", "error", "regression"]],
  ["feature", ["add", "implement", "create", "support"]],
];

function taskKind(objective: string): TaskKind {
  const words = new Set(
    objective
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter(Boolean),
  );
  for (const [kind, list] of KIND_WORDS) if (list.some((w) => words.has(w))) return kind;
  return "other";
}

const h = <T extends string>(value: T): FeatureValue<T> => ({ value, source: "heuristic" });

export function classifyRequest(input: ClassifierInput): RouteFeatures {
  const chars = [...input.objective].length + input.constraints.reduce((n, c) => n + [...c].length, 0);
  const volume: ContextVolume = chars < SMALL_CHARS ? "small" : chars < MEDIUM_CHARS ? "medium" : "large";
  const autonomy: Level = !input.writable ? "low" : input.verificationCommands > 0 ? "high" : "medium";
  const kind = taskKind(input.objective);
  const depth: Level =
    kind === "investigation" || kind === "refactor" || volume === "large"
      ? "high"
      : kind === "docs" || volume === "small"
        ? "low"
        : "medium";
  return {
    classifier: CLASSIFIER_VERSION,
    context_volume: h(volume),
    autonomy: h(autonomy),
    reasoning_depth: h(depth),
    task_kind: h(kind),
  };
}
