/**
 * Delegated prompt assembly order (FR-RTE-09, Could; LLD §3.2, §14.11.2; T7.9). Stable content first, volatile content
 * last: the run's constraints, then the task text. The lifecycle has already appended the retrieval context pack
 * (LLD §14.6 step 5) to `objective`, so the pack follows the task text and closes the prompt. The order never varies
 * between runs, so two runs of a project with the same constraints share the rendered prefix up to the task text.
 * This is a hygiene rule only: no provider is claimed to reuse a prefix cache, and the benefit is unverified (Q-53).
 *
 * A handoff run never reaches this with constraints: the lifecycle compiles the rendered bundle (its own fixed preamble
 * first, the instruction last; `src/continuity/render.ts`, LLD §15.5) with `constraints: []`.
 */
import type { CompileRequest } from "./types.js";

/** Heading of the constraints block; fixed text, so the stable prefix does not change between runs. */
export const CONSTRAINTS_HEADING = "Constraints:";
/** Heading placed between the stable block and the task text when there are constraints. */
export const TASK_HEADING = "Task:";

/** The prompt text an adapter sends for `request`: the objective alone, or the constraints block and then the task. */
export function renderPrompt(request: Pick<CompileRequest, "objective" | "constraints">): string {
  if (request.constraints.length === 0) return request.objective;
  const constraints = request.constraints.map((c) => `- ${c}`).join("\n");
  return `${CONSTRAINTS_HEADING}\n${constraints}\n\n${TASK_HEADING}\n${request.objective}`;
}
