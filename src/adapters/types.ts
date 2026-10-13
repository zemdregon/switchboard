/**
 * Adapter contract types (LLD §2, FR-ADP-01). Types the LLD names but does not define (ProbeRunner, ParseState,
 * NativeBinding, TransportHandle, AcpMessage, ExitInfo, RunResult, FailureEvidence, FailureClassification) are
 * Proposed shapes introduced by T1.7.
 */
import type { PrivilegedScopeBinding } from "../policy/types.js";
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
  /**
   * T3.17 (Proposed shape; LLD §3.1 "Bypass", ADR-0017): true only when the lifecycle found an `APPROVED`, hash-matching
   * approval row whose scope sets bypass (`evaluateBypass`). Adapters never compute it. Equivalent to
   * `ResolvedProfile.bypassApproved` (the LLD §2 carrier); adapters accept either. A provider bypass flag is compiled
   * only when the run is approved, the profile is `privileged` and its scope sets `bypass`; a `privileged` scope with
   * `bypass: true` and no approval is `Ineligible`, and an approval on any other profile is `Ineligible`.
   */
  bypassApproved?: boolean;
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
  /**
   * `privileged` only (LLD §2, §3.1; T3.3): the approved scope, its v2 hash and the approval ID. The scalar fields above
   * stay `scoped` for `privileged`; adapters compile from this scope (T3.5, T3.6), mapping its spellings through
   * `src/policy/scope.ts`.
   */
  privilegedScope?: PrivilegedScopeBinding;
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

/**
 * What the controller hands an adapter so it can name the per-run tool shim in the provider's own per-run MCP form
 * (LLD §2 "M9 additions", §12.2; T9.4, ADR-0026). `env` holds the one-run capability token for the shim; it is a
 * secret for the run's lifetime and must reach the provider only through `Invocation.env` (never argv, a file the
 * adapter writes, or global provider configuration, FR-POL-08).
 */
export interface ShimSpec {
  /** Full argv that starts the shim, ending in `tool-shim --socket <socketPath>`. argv[0] is an absolute path. */
  readonly command: readonly string[];
  readonly socketPath: string;
  /**
   * T9.4b (ADR-0029 item 1): the run's private channel directory (`0700`, owned by the controller's user) that holds the
   * socket. A file an adapter asks for through {@link ChannelArgs.files} is written here by the channel service.
   */
  readonly dir: string;
  readonly toolNames: readonly ("commit" | "push")[];
  /** Environment the shim needs: exactly the token variable (`SWITCHBOARD_TOOL_TOKEN`). */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * FR-GIT-02 declaration (LLD §2 "M9 additions"; T9.4). `injected`: the adapter can pass the per-run channel to its
 * provider without a permission-bypass flag (FR-POL-03), through `channelArgs`. `finalize-only`: it cannot, and the
 * controller commits at FINALIZING when the operator opts in (FR-GIT-09, T9.7). `none`: no channel is declared; `detail`
 * says why (Codex: unverified provider behaviour; Claude Code: the same unless the operator sets the unsupported opt-in
 * `providers.claude-code.git_channel`, T9.4b, ADR-0029). `detail` is an addition to the LLD shape so the reason is
 * recorded with the declaration.
 */
export interface GitCapabilities {
  readonly commitChannel: "injected" | "finalize-only" | "none";
  readonly detail: string;
  /**
   * Pure. The argv and environment fragment that supplies the shim to the provider for this run; appended by the
   * lifecycle to the compiled invocation. Present exactly when `commitChannel` is `injected`. Must not emit a bypass
   * flag: the argv audit (FR-POL-03) runs over the result.
   */
  channelArgs?(shim: ShimSpec, request: CompileRequest, profile: ResolvedProfile): ChannelArgs | Ineligible;
  /**
   * Pure. Optional per-run narrowing of an `injected` declaration (T9.4b, ADR-0033; Delegated shape): when present and
   * false for a run, the lifecycle treats that run as `none` (no channel, no `channelArgs` call, no event, and the
   * finalize-only commit of FR-GIT-09 applies as for an adapter without a channel). Absent means every run qualifies.
   * Claude Code: true only for an approved `privileged` scope with `bypass` (owner decision 41).
   */
  offersChannel?(request: CompileRequest, profile: ResolvedProfile): boolean;
}

/** A file an adapter needs next to the socket (T9.4b): written by the channel service, never by the adapter. */
export interface ChannelFile {
  /** One of `CHANNEL_FILE_NAMES` (`src/git/tool-protocol.ts`); any other name refuses the channel. */
  readonly name: string;
  /** File contents. Must never contain the token (FR-POL-08); the token reaches the provider only through `env`. */
  readonly contents: string;
}

/**
 * What `channelArgs` returns: the argv and environment fragment, and optionally files the lifecycle has the channel
 * service write (mode `0600`, exclusive create) into {@link ShimSpec.dir} before spawn (T9.4b, ADR-0029 item 1).
 */
export interface ChannelArgs extends Pick<Invocation, "argv" | "env"> {
  readonly files?: readonly ChannelFile[];
  /**
   * Standalone flags (no value; each starts with `--` and has no `=`) the lifecycle removes from the compiled argv and
   * `policyFlags` before it appends `argv` (T9.4b, ADR-0033; Delegated shape). A flag that is absent is a no-op. Only
   * Claude Code's `--safe-mode` in an approved bypass run today (owner decision 41: `--safe-mode` stops the injected
   * server from starting). The argv audits (`./audit.ts`) run over the result and refuse any omission they do not
   * admit.
   */
  readonly removeFlags?: readonly string[];
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly transports: readonly Transport[];
  /** FR-GIT-01 declaration, surfaced by `list_capabilities`. */
  readonly gitWriteControl: GitWriteControl;
  /** FR-GIT-02 declaration (T9.4): whether and how the per-run injected tool channel reaches the provider. */
  readonly gitCapabilities: GitCapabilities;

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
