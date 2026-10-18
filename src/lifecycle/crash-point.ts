/**
 * Named crash points (T1.9, TDD §3.6 "Fault injection"): a test-only hook that lets a fault-injection test SIGKILL a
 * real controller process at a named transition boundary, then restart and reconcile.
 *
 * Armed only when all three hold, read once at module load into a constant:
 * - `NODE_ENV=test` (set by Vitest and passed to its child processes),
 * - `SWITCHBOARD_TEST_CRASH_AT=<point>` names one of {@link CRASH_POINTS},
 * - this module runs from its TypeScript source (`.ts`), so the compiled `dist` build is inert whatever the
 *   environment says.
 * Nothing else reads it: no configuration key, MCP argument or provider output reaches it.
 */

/** Points named after the run state machine (FRD §4.2, LLD lifecycle states). */
export const CRASH_POINTS = [
  /** PREFLIGHT committed and its verdict passed; nothing leased yet. */
  "preflight",
  /** LEASED: lease written, worktree created, pre checkpoint recorded; no provider spawned. */
  "leased",
  /** FINALIZING committed with its pending outcome; no ref check or checkpoint yet. */
  "finalizing_before_checkpoint",
  /** FINALIZING: post checkpoint committed and its event written; terminal transaction not yet run. */
  "finalizing_after_checkpoint",
] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

export const TEST_CRASH_AT_ENV = "SWITCHBOARD_TEST_CRASH_AT";

/** The armed point for this environment and module URL, or undefined (the production answer). */
export function armedCrashPoint(env: NodeJS.ProcessEnv, moduleUrl: string): CrashPoint | undefined {
  if (env.NODE_ENV !== "test" || !moduleUrl.endsWith(".ts")) return undefined;
  const value = env[TEST_CRASH_AT_ENV];
  if (value === undefined || value === "") return undefined;
  if (!(CRASH_POINTS as readonly string[]).includes(value)) {
    throw new Error(`${TEST_CRASH_AT_ENV}=${value} is not a crash point (${CRASH_POINTS.join(", ")})`);
  }
  return value as CrashPoint;
}

const ARMED = armedCrashPoint(process.env, import.meta.url);

/** SIGKILL this process when `name` is the armed point; a no-op otherwise. */
export function crashPoint(name: CrashPoint): void {
  if (ARMED === name) process.kill(process.pid, "SIGKILL");
}
