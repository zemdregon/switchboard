/**
 * Skill limit defaults and the Delegated ranges (T16.3; FR-SKL-03, LLD §19.3).
 *
 * The LLD names the four defaults and no bounds. The ranges below are Delegated: they keep a typo from accepting an
 * unbounded body or name list, and they are recorded in LLD §19.3. `max_run_bytes` must also be at least
 * `max_body_bytes` (checked in the loader): one body cannot exceed the run total.
 */

/** LLD §19.3 defaults (Assumptions). The store uses these when a caller omits the option. */
export const DEFAULT_MAX_BODY_BYTES = 32_768;
export const DEFAULT_MAX_PER_RUN = 8;
export const DEFAULT_MAX_RUN_BYTES = 65_536;
export const DEFAULT_MAX_NAMES = 64;

/** `skills.max_body_bytes`: 1 byte through 1 MiB. */
export const MIN_MAX_BODY_BYTES = 1;
export const MAX_MAX_BODY_BYTES = 1_048_576;
/** `skills.max_per_run`: 1 through 64 (the same ceiling as the concurrency limits). */
export const MIN_MAX_PER_RUN = 1;
export const MAX_MAX_PER_RUN = 64;
/** `skills.max_run_bytes`: 1 byte through 16 MiB. */
export const MIN_MAX_RUN_BYTES = 1;
export const MAX_MAX_RUN_BYTES = 16_777_216;
/** `skills.max_names`: 1 through 4096. */
export const MIN_MAX_NAMES = 1;
export const MAX_MAX_NAMES = 4_096;

/** Delegated: at most this many `skills.roles` / `projects[].skills.roles` keys. */
export const MAX_SKILL_ROLES = 128;

/** The two T16.1 store parameters taken from `skills.max_body_bytes` and `skills.max_names`. */
export interface SkillStoreLimits {
  readonly maxBodyBytes: number;
  readonly maxNames: number;
}
