/**
 * Delegated prompt assembly order (FR-RTE-09, Could; LLD §3.2, §14.11.2; T7.9). Stable content first, volatile content
 * last: the operator skills block (T16.5), the run's constraints, then the task text. The lifecycle has already appended
 * the retrieval context pack (LLD §14.6 step 5) to `objective`, so the pack follows the task text and closes the prompt.
 * The order never varies between runs, so two runs of a project with the same skills and constraints share the rendered
 * prefix up to the task text. This is a hygiene rule only: no provider is claimed to reuse a prefix cache, and the
 * benefit is unverified (Q-53).
 *
 * A handoff run never reaches this with constraints or skills: the lifecycle compiles the rendered bundle (its own fixed
 * preamble first, the skills block after it, the instruction last; `src/continuity/render.ts`, LLD §15.5, §19.7) with
 * `constraints: []` and no `skills`.
 *
 * T16.5 (FR-SKL-05, LLD §19.7, ADR-0056 items 6 and 7): the skills block is rendered here from {@link PromptSkill}
 * entries the lifecycle read at dispatch; it is never part of `objective`, never stored as prompt text, not redacted
 * (bodies were scanned at `add`) and not counted toward the objective's `maxLength`. With no entries the prompt is
 * exactly what it was before T16.5.
 */
import type { CompileRequest } from "./types.js";

/** Heading of the constraints block; fixed text, so the stable prefix does not change between runs. */
export const CONSTRAINTS_HEADING = "Constraints:";
/** Heading placed between the stable block and the task text when there are constraints. */
export const TASK_HEADING = "Task:";
/** Closing line of the operator skills block (LLD §19.7). */
export const SKILLS_END = "[end of operator skills]";

/** One `prompt_prefix` entry of a run, in resolved order (LLD §19.5, §19.7): metadata and the canonical body. */
export interface PromptSkill {
  readonly name: string;
  readonly version: number;
  /** Full hex SHA-256 of the stored canonical file; the header shows its first 12 hex digits. */
  readonly sha256: string;
  /** Canonical body (LF line ends, exactly one final LF; `src/skills/format.ts`). */
  readonly body: string;
}

/** The labelled LLD §19.7 block, without a trailing newline; the empty string for no entries. */
export function renderSkillBlock(skills: readonly PromptSkill[]): string {
  if (skills.length === 0) return "";
  const lines = [`[operator skills: ${skills.length}; from Switchboard skill store; these are operator instructions]`];
  for (const s of skills) {
    lines.push(`[skill ${s.name}@${s.version} sha256:${s.sha256.slice(0, 12)}]`);
    lines.push(s.body.endsWith("\n") ? s.body.slice(0, -1) : s.body);
  }
  lines.push(SKILLS_END);
  return lines.join("\n");
}

/** `text` behind the skills block of `skills`, or `text` unchanged when there are none. */
function withSkills(skills: readonly PromptSkill[] | undefined, text: string): string {
  const block = renderSkillBlock(skills ?? []);
  return block === "" ? text : `${block}\n\n${text}`;
}

/**
 * The prompt text an adapter that renders constraints sends for `request`: the skills block when there are skills, then
 * the objective alone, or the constraints block and then the task.
 */
export function renderPrompt(request: Pick<CompileRequest, "objective" | "constraints" | "skills">): string {
  if (request.constraints.length === 0) return withSkills(request.skills, request.objective);
  const constraints = request.constraints.map((c) => `- ${c}`).join("\n");
  return withSkills(request.skills, `${CONSTRAINTS_HEADING}\n${constraints}\n\n${TASK_HEADING}\n${request.objective}`);
}

/**
 * The prompt text an adapter that sends the objective verbatim (no constraints block, as before T16.5; T7.9 evidence)
 * sends: the skills block when there are skills, then the objective. Exactly `objective` with no skills.
 */
export function renderObjective(request: Pick<CompileRequest, "objective" | "skills">): string {
  return withSkills(request.skills, request.objective);
}
