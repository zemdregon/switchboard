/** Bypass-flag audit over compiled invocations (FR-POL-03, AGENTS.md working rules). */
import type { Invocation } from "./types.js";

export const BYPASS_FLAGS: readonly string[] = [
  "--dangerously-skip-permissions",
  "--yolo",
  "--force",
  "--always-approve",
  "--approve-mcps",
  "--full-auto",
];

function matches(arg: string): string | undefined {
  return BYPASS_FLAGS.find((f) => arg === f || arg.startsWith(`${f}=`));
}

/** Returns every bypass flag present in argv or policyFlags. */
export function auditInvocation(inv: Pick<Invocation, "argv" | "policyFlags">): string[] {
  const found = new Set<string>();
  for (const arg of [...inv.argv, ...inv.policyFlags]) {
    const hit = matches(arg);
    if (hit) found.add(hit);
  }
  return [...found];
}

export class BypassFlagError extends Error {
  constructor(readonly flags: readonly string[]) {
    super(`bypass flags refused: ${flags.join(", ")}`);
    this.name = "BypassFlagError";
  }
}
