/**
 * Test-only (excluded from the build), SYNTHETIC: Muse Code fixtures for T4.72 and T4.73. No `muse` binary was installed or run;
 * the version line is the format reported by a third party ([Orca] in TDD §4.8), not a capture. T4.71 replaces these
 * with scrubbed captures.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PrivilegedScope } from "../../../policy/types.js";
import { privilegedProfile } from "../../fixtures/privileged.js";
import type { ResolvedProfile } from "../../types.js";

/** The one scope shape whose approved bypass run compiles with network off (see the adapter header). */
export const BYPASS_SCOPE: PrivilegedScope = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "off" },
  repository_config: { mode: "enabled" },
  bypass: true,
};

/** `privileged` with {@link BYPASS_SCOPE}; callers set `bypassApproved` on the request or the profile. */
export const PRIVILEGED_BYPASS_PROFILE: ResolvedProfile = privilegedProfile(BYPASS_SCOPE);

/** SYNTHETIC `muse --version` stdout in the reported format ([Orca]: "Muse Code 1.2.1 (1.2.1-R2847.1)"). */
export const SYNTHETIC_VERSION_STDOUT = "Muse Code 1.2.1 (1.2.1-R2847.1)\n";

/** SYNTHETIC `muse exec --help` stdout listing the flags TDD §4.8 sources (layout invented; Unverified: T4.71). */
export const SYNTHETIC_EXEC_HELP_STDOUT =
  "Usage: muse exec [OPTIONS] [PROMPT]\n" +
  "      --json\n" +
  "      --prompt-file <PATH>\n" +
  "      --approval-mode <MODE>\n" +
  "      --sandbox-network <MODE>\n" +
  "  -w, --worktree <MODE>\n" +
  "      --session-id <UUID>\n";

/** Session ids of the T4.73 JSONL fixtures (SYNTHETIC uuids). */
export const DEFAULT_SESSION_ID = "00000000-0000-4000-8000-000000000001";
export const RESUMED_SESSION_ID = "00000000-0000-4000-8000-000000000042";

/**
 * Reads a SYNTHETIC T4.73 fixture `./<name>.jsonl`: the first line is the `_fixture` header (its `exit` is the exit code
 * the case pins), every other line is one `muse exec --json` record in the reported or **Assumption** shapes of
 * protocol.ts. No line was captured from a real `muse`; T4.71 replaces these.
 */
export function readFixture(name: string): { exitCode: number; lines: string[] } {
  const [head = "", ...lines] = readFileSync(fileURLToPath(new URL(`./${name}.jsonl`, import.meta.url)), "utf8")
    .split("\n")
    .filter((l) => l !== "");
  const header = (JSON.parse(head) as { _fixture?: { synthetic?: boolean; exit?: number } })._fixture;
  if (header?.synthetic !== true || typeof header.exit !== "number") throw new Error(`${name}: bad fixture header`);
  return { exitCode: header.exit, lines };
}
