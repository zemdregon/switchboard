/**
 * Bypass-flag audit over compiled invocations (FR-POL-03, BR-14, AGENTS.md working rules; owner decision 13, ADR-0017,
 * LLD §3.1 "Bypass"; T3.17).
 *
 * `BYPASS_FLAGS` is the single list. A flag from it is admitted only when the run's context says all three of: the
 * resolved profile is `privileged`, `bypassApproved` is true (computed by the lifecycle from an `APPROVED` approval row,
 * never by an adapter or a request), and the approved scope sets `bypass`. Every other case refuses the flag; with no
 * context at all every flag is refused (the M1/M2 behaviour). The audit is independent of the adapter's own compile
 * gate, so a compile bug cannot by itself put a bypass flag on a spawned argv.
 */
import type { Invocation, ResolvedProfile } from "./types.js";

export const BYPASS_FLAGS: readonly string[] = [
  "--dangerously-skip-permissions",
  "--yolo",
  "--force",
  "--always-approve",
  "--approve-mcps",
  "--full-auto",
];

/** What the audit needs to know about the run an invocation belongs to (T3.17). */
export interface BypassContext {
  /** The run's resolved profile (policy snapshot): its name and, for `privileged`, the approved scope binding. */
  readonly profile: Pick<ResolvedProfile, "name" | "privilegedScope">;
  /** True only when the lifecycle found an `APPROVED`, hash-matching approval whose scope sets bypass. */
  readonly bypassApproved: boolean;
}

/** True exactly when `ctx` admits a bypass flag: privileged ∧ bypassApproved ∧ scope.bypass. */
export function bypassPermitted(ctx: BypassContext | undefined): boolean {
  return (
    ctx !== undefined &&
    ctx.profile.name === "privileged" &&
    ctx.bypassApproved === true &&
    ctx.profile.privilegedScope?.scope.bypass === true
  );
}

function matches(arg: string): string | undefined {
  return BYPASS_FLAGS.find((f) => arg === f || arg.startsWith(`${f}=`));
}

/** Every bypass flag present in argv or policyFlags, whatever the context. */
export function findBypassFlags(inv: Pick<Invocation, "argv" | "policyFlags">): string[] {
  const found = new Set<string>();
  for (const arg of [...inv.argv, ...inv.policyFlags]) {
    const hit = matches(arg);
    if (hit) found.add(hit);
  }
  return [...found];
}

/**
 * The bypass flags in argv or policyFlags that `ctx` does not admit: every one found unless {@link bypassPermitted}.
 * Without a context this is every bypass flag present, so `auditInvocation(inv)` is empty exactly when the argv has
 * none.
 */
export function auditInvocation(inv: Pick<Invocation, "argv" | "policyFlags">, ctx?: BypassContext): string[] {
  return bypassPermitted(ctx) ? [] : findBypassFlags(inv);
}

export class BypassFlagError extends Error {
  constructor(readonly flags: readonly string[]) {
    super(`bypass flags refused: ${flags.join(", ")}`);
    this.name = "BypassFlagError";
  }
}

/** Throws {@link BypassFlagError} when the audit refuses any flag (used before every spawn). */
export function assertBypassAudit(inv: Pick<Invocation, "argv" | "policyFlags">, ctx?: BypassContext): void {
  const refused = auditInvocation(inv, ctx);
  if (refused.length > 0) throw new BypassFlagError(refused);
}
