import { DEFAULT_MAX_LINE_BYTES } from "../../../exec/index.js";
import type { Invocation } from "../../types.js";
import { KIMI_LOGIN_COMMAND } from "../protocol.js";

export interface DeferredAcpOptions {
  readonly exe?: string;
  readonly cwd: string;
  readonly prompt?: string;
  /** Resume this native session id instead of starting a new session. */
  readonly resumeId?: string;
  /** Adds the read-only `plan` mode id. */
  readonly readOnly?: boolean;
  /** Adds the model config option. */
  readonly model?: string;
}

/**
 * The Kimi ACP plan as a literal Invocation. It mirrors the ACP cell kept for the Deferred ROADMAP section 8 row
 * "Kimi ACP permission gating (ADR-0049 item 3)" (`KimiAdapter#acpInvocation`), which no compile reaches since the
 * T4.68 bypass-only gate (owner ruling 2026-10-19 08:45 CDT). Tests use it to exercise the shared ACP client and the
 * parser without a production seam.
 */
export function deferredAcpInvocation(opts: DeferredAcpOptions): Invocation {
  const exe = opts.exe ?? "/opt/synthetic/kimi";
  return {
    transport: "acp-stdio",
    argv: [exe, "acp"],
    env: {},
    envAllowlist: ["PATH", "HOME"],
    cwd: opts.cwd,
    stdin: { kind: "none" },
    outputFormat: "acp",
    timeouts: { wallClockMs: 20_000, idleMs: 20_000, killGraceMs: 300 },
    policyFlags: [],
    expectedExitCodes: [0],
    maxLineBytes: DEFAULT_MAX_LINE_BYTES,
    acp: {
      protocolVersion: 1,
      prompt: opts.prompt ?? "Create SMOKE.md",
      session: opts.resumeId === undefined ? { kind: "new" } : { kind: "resume", nativeSessionId: opts.resumeId },
      mcpServers: [],
      ...(opts.readOnly === true ? { modeId: "plan" } : {}),
      ...(opts.model !== undefined ? { configOptions: [{ configId: "model", value: opts.model }] } : {}),
      loginCommand: KIMI_LOGIN_COMMAND,
      requirePermissionRequest: true,
    },
  };
}
