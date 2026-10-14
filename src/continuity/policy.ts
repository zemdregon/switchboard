/**
 * The Q-61 rule for a `privileged` continuation on another provider (ADR-0038 item 8, LLD §15.7 step 3; ROADMAP Q-61).
 *
 * Q-61 is OPEN: zemdregon has not decided whether a meta-session's `APPROVED` privileged approval (possibly a
 * `bypass: true` scope) may carry over to a DIFFERENT provider with no new operator review. Until it is answered the
 * fail-closed default applies: such a continuation is refused with `INVALID_REQUEST`,
 * `details.reason = "PRIVILEGED_CROSS_PROVIDER"`, before any side effect. Same-provider `privileged` continuations
 * (including a same-provider handoff) keep FRD C7 unchanged.
 *
 * This constant is the ONE place the rule lives. It is read by the check in `continue_task` (`src/mcp/server.ts`) and by
 * the lifecycle's handoff admission guard (`src/lifecycle/lifecycle.ts`), so that the hook cannot route around it. If
 * zemdregon answers "allowed", the change is this one line (`"allow_under_approval"`); the continuation then passes the
 * same C7 checks, the target provider compiles the approved scope at dispatch (FR-POL-02) and the LLD §3.1 Bypass check
 * and argv audit run unchanged. Nothing else may relax it: there is no configuration key, environment variable or
 * request field for it.
 */

export type PrivilegedCrossProviderPolicy = "refuse" | "allow_under_approval";

/** Q-61 fail-closed default (ADR-0038 item 8.2). Do not change without zemdregon's answer to Q-61. */
export const PRIVILEGED_CROSS_PROVIDER: PrivilegedCrossProviderPolicy = "refuse";

/** `details.reason` of the refusal (LLD §15.7 step 3). */
export const PRIVILEGED_CROSS_PROVIDER_REASON = "PRIVILEGED_CROSS_PROVIDER";

/**
 * True when a continuation with `profile` from session provider `fromProvider` to `toProvider` must be refused under
 * {@link PRIVILEGED_CROSS_PROVIDER}. `policy` is a parameter for the unit test only; callers pass nothing.
 */
export function refusesPrivilegedCrossProvider(
  profile: string,
  fromProvider: string,
  toProvider: string,
  policy: PrivilegedCrossProviderPolicy = PRIVILEGED_CROSS_PROVIDER,
): boolean {
  return profile === "privileged" && fromProvider !== toProvider && policy !== "allow_under_approval";
}
