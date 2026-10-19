/**
 * Test helper for the live plug-ins (`scripts/live/providers/*.mjs`): compile a plug-in's approved `privileged` cell in
 * the real adapter class, with a fake absolute executable path so no binary is resolved and nothing is spawned.
 */
import { AntigravityAdapter } from "../src/adapters/antigravity/adapter.js";
import { findBypassFlags } from "../src/adapters/audit.js";
import { ClaudeAdapter } from "../src/adapters/claude/adapter.js";
import { CursorAdapter } from "../src/adapters/cursor/adapter.js";
import { GrokAdapter } from "../src/adapters/grok/adapter.js";
import { KimiAdapter } from "../src/adapters/kimi/adapter.js";
import { OpenCodeAdapter } from "../src/adapters/opencode/adapter.js";
import { type Ineligible, type Invocation, isIneligible, type ProviderAdapter } from "../src/adapters/types.js";
import { type PrivilegedScope, privilegedScopeHash, resolveTrustProfile } from "../src/policy/index.js";

const FAKE_EXE = "/nonexistent/live-cells/bin";

const ADAPTERS: Record<string, () => ProviderAdapter> = {
  claude: () => new ClaudeAdapter({ binaryPath: `${FAKE_EXE}/claude` }),
  antigravity: () => new AntigravityAdapter({ executable: `${FAKE_EXE}/agy` }),
  cursor: () => new CursorAdapter({ executable: `${FAKE_EXE}/cursor-agent` }),
  grok: () => new GrokAdapter({ executable: `${FAKE_EXE}/grok` }),
  kimi: () => new KimiAdapter({ executable: `${FAKE_EXE}/kimi` }),
  opencode: () => new OpenCodeAdapter({ executable: `${FAKE_EXE}/opencode` }),
};

export interface CellCompile {
  readonly result: Invocation | Ineligible;
  /** Bypass-class flags the argv audit finds, with the provider's scoped flags (empty when Ineligible). */
  readonly bypassFlags: string[];
}

/** Compile `scope` as an approved `privileged` cell of `adapterId` (approved: `bypassApproved` when the scope bypasses). */
export function compileCell(adapterId: string, scope: PrivilegedScope): CellCompile {
  const make = ADAPTERS[adapterId];
  if (make === undefined) throw new Error(`no adapter for ${adapterId}`);
  const profile = resolveTrustProfile("privileged", {
    privileged: {
      scope,
      scopeHash: privilegedScopeHash({ clientId: "live-cells", metaSessionId: "live-cells", scope }),
      approvalId: "apv_0000000000000000000000TEST",
    },
  });
  const result = make().compile(
    {
      runId: "run_live_cells",
      objective: "x",
      constraints: [],
      workspace: { cwd: "/tmp", writable: true },
      ...(scope.bypass ? { bypassApproved: true } : {}),
    },
    profile,
  );
  return { result, bypassFlags: isIneligible(result) ? [] : findBypassFlags(result, adapterId) };
}
