/**
 * Test-only (excluded from the build), SYNTHETIC: Muse Code fixtures for T4.72. No `muse` binary was installed or run;
 * the version line is the format reported by a third party ([Orca] in TDD §4.8), not a capture. T4.71 replaces these
 * with scrubbed captures.
 */
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
