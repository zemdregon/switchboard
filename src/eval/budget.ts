/**
 * Live budget file for an evaluation on a real provider (T8.14; FR-OPS-06, NFR-MAINT-05). Linus decision (WORK QUEUE
 * v10, Delegated, not owner-approved): `--live-budget <file>` must exist, parse, name the provider and a maximum run
 * count above 0; otherwise the command fails with `EVAL_LIVE_BUDGET_REQUIRED` before any run is admitted. The fake
 * provider needs none. A suite with more tasks than the budget allows is refused whole (`EVAL_LIVE_BUDGET_EXCEEDED`,
 * Delegated: fail closed rather than run a prefix).
 */
import { readFileSync } from "node:fs";

/** The test-only provider: needs no live budget. Every other provider is real. */
export const FAKE_PROVIDER = "fake";

export type EvalRefusalCode = "EVAL_LIVE_BUDGET_REQUIRED" | "EVAL_LIVE_BUDGET_EXCEEDED" | "EVAL_SKIPPED_IN_CI";

export class EvalRefusal extends Error {
  override readonly name = "EvalRefusal";
  constructor(
    readonly code: EvalRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

export interface LiveBudget {
  readonly provider: string;
  readonly maxRuns: number;
}

/**
 * The budget a run of `taskCount` tasks on `provider` may use, or `undefined` for the fake provider. Throws
 * {@link EvalRefusal} when a real provider has no valid budget file or the suite needs more runs than it allows.
 */
export function checkLiveBudget(
  provider: string,
  budgetFile: string | undefined,
  taskCount: number,
): LiveBudget | undefined {
  if (provider === FAKE_PROVIDER) return undefined;
  const refuse = (why: string): never => {
    throw new EvalRefusal(
      "EVAL_LIVE_BUDGET_REQUIRED",
      `provider ${JSON.stringify(provider)} is a real provider: ${why}; pass --live-budget <file> with ` +
        `{"provider": "${provider}", "max_runs": <n > 0>}`,
    );
  };
  if (budgetFile === undefined || budgetFile === "") return refuse("no live budget file given");
  let text: string;
  try {
    text = readFileSync(budgetFile, "utf8");
  } catch {
    return refuse(`live budget file ${budgetFile} cannot be read`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse(`live budget file ${budgetFile} is not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return refuse("live budget is not a JSON object");
  const { provider: named, max_runs: maxRuns } = raw as Record<string, unknown>;
  if (named !== provider) return refuse(`live budget names provider ${JSON.stringify(named ?? null)}`);
  if (typeof maxRuns !== "number" || !Number.isInteger(maxRuns) || maxRuns < 1) {
    return refuse("live budget max_runs must be an integer greater than 0");
  }
  if (taskCount > maxRuns) {
    throw new EvalRefusal(
      "EVAL_LIVE_BUDGET_EXCEEDED",
      `suite has ${taskCount} tasks but the live budget allows ${maxRuns} runs of ${provider}`,
    );
  }
  return { provider, maxRuns };
}
