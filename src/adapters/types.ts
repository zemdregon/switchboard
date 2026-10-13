/**
 * Adapter contract types (LLD §2, FR-ADP-01). Types the LLD names but does not define (ProbeRunner, ParseState,
 * NativeBinding, TransportHandle, AcpMessage, ExitInfo, RunResult, FailureEvidence, FailureClassification) are
 * Proposed shapes introduced by T1.7.
 */
import type { FailureCode } from "./failure.js";

export type ProviderId = "claude" | "codex" | "grok" | "antigravity" | "cursor" | "opencode" | "kimi" | "fake";
export type TrustProfile =
  | "inspect-untrusted"
  | "edit-untrusted"
  | "test-sandboxed"
  | "trusted-development"
  | "privileged";

export type Transport = "subprocess-jsonl" | "acp-stdio" | "local-service"; // last deferred (FR-EXE-04)

/** Proposed: minimal JSON-RPC 2.0 envelope for ACP messages. */
export interface AcpMessage {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

/** Proposed: output of one probe command run through a ProbeRunner. */
export interface ProbeOutput {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Set when the process could not be started (binary missing). */
  readonly spawnError?: string;
}

/** Supervisor-provided way to execute a provider binary for probe/authPreflight (LLD §2). Tests inject fakes. */
export type ProbeRunner = (
  argv: readonly string[],
  opts?: { readonly cwd?: string; readonly timeoutMs?: number },
) => Promise<ProbeOutput>;

export interface ProbeResult {
  binaryPath: string;
  binaryVersion: string | null;
  steps: Array<{
    step: "binary" | "version" | "command" | "output_format" | "flags" | "smoke";
    ok: boolean;
    detail?: string;
  }>;
  modelsListed?: string[]; // feeds the model registry (FR-ADP-05)
}

export type AuthResult =
  | { state: "OK" }
  | { state: "AUTH_REQUIRED"; loginCommand: string } // names the native command for the operator
  | { state: "UNKNOWN"; reason: string }; // treated as ineligible (NFR-SEC-06)

export interface CompileRequest {
  runId: string;
  objective: string;
  constraints: string[];
  workspace: { cwd: string; writable: boolean };
  model?: string;
  verificationCommands?: string[][];
  handoff?: { bundleArtifactId: string }; // M5
}

export interface ResolvedProfile {
  name: TrustProfile;
  fileAccess: "read-only" | "worktree" | "scoped";
  shell: "none" | "allowlist" | "broad" | "scoped";
  shellAllowlist?: string[];
  network: "off" | "allowlist" | "policy" | "scoped";
  networkAllowlist?: string[];
  repoConfig: "disabled" | "approved-only" | "allowlisted" | "scoped";
  bypassApproved: boolean; // true only with a recorded approval (FR-POL-03)
}

export interface Invocation {
  transport: Transport;
  argv: string[]; // argv[0] = absolute executable path from probe; never a shell string
  env: Record<string, string>; // adapter-declared variables only (FR-EXE-07); allowlisted names come from envAllowlist
  envAllowlist: string[];
  cwd: string;
  stdin?: { kind: "text"; value: string } | { kind: "none" };
  outputFormat: "json" | "jsonl" | "acp";
  timeouts: { wallClockMs: number; idleMs: number; killGraceMs: number };
  policyFlags: string[]; // every security-relevant flag, for the bypass-flag audit
  expectedExitCodes: number[];
  maxLineBytes: number;
}

export interface Ineligible {
  ineligible: true;
  reason: "PROFILE_UNSUPPORTED" | "VERSION_UNVERIFIED" | "NO_MANIFEST" | "AUTH_REQUIRED" | "CAPABILITY_MISSING";
  detail: string;
}

export function isIneligible(x: Invocation | Ineligible): x is Ineligible {
  return "ineligible" in x && x.ineligible === true;
}

/** Observable facts only (NFR-PRIV-02); no provider reasoning text. */
export type NormalizedEvent =
  | { kind: "session_bound"; nativeSessionId: string; model?: string; backingProvider?: string }
  | { kind: "tool_call"; tool: "read" | "edit" | "shell" | "other"; name: string; target?: string; denied?: boolean }
  | { kind: "message"; role: "assistant"; text: string }
  | { kind: "usage"; source: "provider_reported"; metrics: Record<string, number | string | null> }
  | { kind: "rate_limit"; resetAt?: string; reportedCategory?: string }
  | { kind: "permission_denied"; tool: string }
  | { kind: "sandbox_violation"; detail: string }
  | { kind: "provider_error"; category: string; message: string }
  | { kind: "result"; ok: boolean; summary?: string }
  | { kind: "unknown"; rawType: string };

/** Proposed: mutable per-run parser scratch state. */
export interface ParseState {
  lines: number;
  unknownEvents: number;
  nativeSessionId?: string;
}

export function createParseState(): ParseState {
  return { lines: 0, unknownEvents: 0 };
}

/** Proposed: how the supervised process ended, as the adapter sees it. */
export interface ExitInfo {
  outcome: "exited" | "timeout" | "cancelled" | "protocol_error" | "crashed" | "spawn_error" | "internal_error";
  exitCode: number | null;
  signal: string | null;
  timeoutKind?: "wall_clock" | "idle";
  expectedExitCodes: readonly number[];
}

export interface FailureEvidence {
  events: readonly NormalizedEvent[];
  exit: ExitInfo;
  stderrTail: string; // bounded by the caller
  timedOut: boolean;
  cancelled: boolean;
}

export interface FailureClassification {
  code: FailureCode;
  detail: string;
}

/** Proposed: the normalized outcome of one provider invocation. */
export interface RunResult {
  ok: boolean;
  failureCode?: FailureCode;
  failureDetail?: string;
  summary?: string;
  nativeSessionId?: string;
  unknownEventCount: number;
}

/** Proposed: bind to a provider-native session for resume (FR-SES-03). */
export interface NativeBinding {
  provider: ProviderId;
  nativeSessionId: string;
}

/** Proposed: handle for optional graceful cancel. */
export interface TransportHandle {
  runId: string;
  pid?: number;
}

/**
 * How an adapter keeps Git write operations (commit, ref create/move/delete, push) away from the agent (FR-GIT-01).
 * Proposed shape. `provider-deny-rules`: the adapter compiles the provider's documented permission controls so they deny
 * Git writes. `none-documented`: the provider documents no such control, so the adapter declares that and the
 * `remainingControls` (FR-GIT-03 detection and FR-GIT-06 credential separation) are what is left.
 */
export interface GitWriteControl {
  readonly kind: "provider-deny-rules" | "none-documented";
  /** Mechanism and its source, or why no control is documented; with the known limitations. */
  readonly detail: string;
  /** Requirement IDs of the controls that back up (or replace) the provider's own. */
  readonly remainingControls: readonly string[];
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly transports: readonly Transport[];
  /** FR-GIT-01 declaration, surfaced by `list_capabilities`. */
  readonly gitWriteControl: GitWriteControl;

  /** FR-ADP-02 steps 1-5: binary, version, command, output formats, required flags. No auth, no model call. */
  probe(runner: ProbeRunner): Promise<ProbeResult>;
  /** Provider's own status command or a harmless headless call; never reads credentials (FR-AUTH-02). */
  authPreflight(runner: ProbeRunner): Promise<AuthResult>;
  /** Pure. Returns Ineligible (never a downgraded profile) when the profile cannot be satisfied (FR-POL-02). */
  compile(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible;
  /** One stdout line (JSONL) or one ACP message -> zero or more events. Stateful via ParseState. */
  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[];
  /** Folds the event stream plus exit info into the run result. */
  extractResult(events: readonly NormalizedEvent[], exit: ExitInfo): RunResult;
  /** Invocation that continues a native session (FR-SES-03). Pure. */
  resumeArgs(binding: NativeBinding, request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible;
  /** Optional graceful cancel; the supervisor still enforces SIGTERM/SIGKILL. */
  cancel?(handle: TransportHandle): Promise<void>;
  /** Maps evidence to one taxonomy code; unknown evidence never maps to success. */
  classifyFailure(evidence: FailureEvidence): FailureClassification;
}
