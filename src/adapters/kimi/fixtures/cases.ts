/**
 * Replay helpers for the Kimi Code adapter over synthetic recorded fixtures (T4.63; the conformance suite is T4.65).
 * Test-only (excluded from the build): the adapter runs the shared `node src/adapters/fixtures/replay.mjs --provider
 * kimi` in place of the `kimi` binary. Only the approved bypass cell (`--prompt=<prompt> --output-format stream-json`)
 * is replayed this way; the prompt is the `--prompt=` argv word (stdin unused), which the dialect reads.
 */
import { fileURLToPath } from "node:url";
import { privilegedProfile } from "../../fixtures/privileged.js";
import { replayLauncher } from "../../fixtures/replay.js";
import type { ResolvedProfile } from "../../types.js";
import { KimiAdapter } from "../adapter.js";

export const fixturePath = (name: string): string => fileURLToPath(new URL(`./${name}.jsonl`, import.meta.url));

export const DEFAULT_SESSION_ID = "session_00000000-0000-4000-8000-000000000001";
export const RESUMED_SESSION_ID = "session_00000000-0000-4000-8000-000000000042";
/** The placeholder id of the scrubbed capture (`captured_success.jsonl`). */
export const CAPTURED_SESSION_ID = "session_00000000-0000-0000-0000-000000000000";

/** The one bypass scope Kimi Code compiles (T4.62): worktree files, shell `broad`, network `on`, repo config `enabled`. */
export const BYPASS_SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "on" },
  repository_config: { mode: "enabled" },
  bypass: true,
} as const;

export const PRIVILEGED_BYPASS_PROFILE: ResolvedProfile = privilegedProfile(BYPASS_SCOPE);

const SHORT = { wallClockMs: 10_000, idleMs: 2_000, killGraceMs: 300 };

export interface ReplayOptions {
  exitCode?: number;
  write?: string;
  hang?: boolean;
  ignoreTerm?: boolean;
  timeouts?: Partial<typeof SHORT>;
}

/** A KimiAdapter whose argv[0] is node and whose launcher replays `fixture` instead of running `kimi`. */
export function replayAdapter(fixture: string, o: ReplayOptions = {}): KimiAdapter {
  return new KimiAdapter({
    executable: process.execPath,
    launcherArgs: replayLauncher("kimi", fixturePath(fixture), [
      ...(o.exitCode !== undefined ? ["--exit-code", String(o.exitCode)] : []),
      ...(o.write ? ["--write", o.write] : []),
      ...(o.hang ? ["--hang"] : []),
      ...(o.ignoreTerm ? ["--ignore-term"] : []),
    ]),
    timeouts: { ...SHORT, ...o.timeouts },
  });
}
