/**
 * Adapter contract types (LLD §2, FR-ADP-01). Types the LLD names but does not define (ProbeRunner, ParseState,
 * NativeBinding, TransportHandle, AcpMessage, ExitInfo, RunResult, FailureEvidence, FailureClassification) are
 * Proposed shapes introduced by T1.7.
 */
import type { PrivilegedScopeBinding } from "../policy/types.js";
import type { FailureCode } from "./failure.js";
import type { PromptSkill } from "./prompt.js";
import type { ProviderUsageResult } from "./provider-usage.js";
import type { BuiltinProviderId } from "./providers.js";

/** Adapter ids, derived from the provider registry table `BUILTIN_PROVIDERS` (`./providers.ts`, T4.1, LLD §2). */
export type ProviderId = BuiltinProviderId;
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
  /** Set only with `holdStdinUntil`: whether stdin was still held open when the process ended. */
  readonly stdinOpenAtEnd?: boolean;
}

/** Supervisor-provided way to execute a provider binary for probe/authPreflight (LLD §2). Tests inject fakes. */
export type ProbeRunner = (
  argv: readonly string[],
  opts?: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    /** Proposed (T4.64): written to the probe's stdin, which is then closed (see `holdStdinUntil`). Without it stdin is not connected. */
    readonly stdinText?: string;
    /**
     * Proposed (T4.64 fix): with `stdinText`, stdin stays open after the text is written and is closed only once this
     * returns true for a JSON object read from stdout, or when the process ends or times out. For a probe whose
     * process exits at stdin end-of-file before it has answered every request.
     */
    readonly holdStdinUntil?: (message: unknown) => boolean;
  },
) => Promise<ProbeOutput>;

export interface ProbeResult {
  binaryPath: string;
  binaryVersion: string | null;
  steps: Array<{
    step: "binary" | "version" | "command" | "output_format" | "flags" | "smoke" | "confinement";
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
  /**
   * M5, T5.5 (ADR-0038 item 5.1, LLD §15.5): set for a handoff run, for the record only. No adapter reads it: the
   * lifecycle has already put the rendered bundle and the new instruction in `objective` and passed `constraints: []`.
   */
  handoff?: { bundleArtifactId: string; bundleSha256: string };
  /**
   * T3.17 (Proposed shape; LLD §3.1 "Bypass", ADR-0017): true only when the lifecycle found an `APPROVED`, hash-matching
   * approval row whose scope sets bypass (`evaluateBypass`). Adapters never compute it. Equivalent to
   * `ResolvedProfile.bypassApproved` (the LLD §2 carrier); adapters accept either. A provider bypass flag is compiled
   * only when the run is approved, the profile is `privileged` and its scope sets `bypass`; a `privileged` scope with
   * `bypass: true` and no approval is `Ineligible`, and an approval on any other profile is `Ineligible`.
   */
  bypassApproved?: boolean;
  /**
   * T16.5 (FR-SKL-05, LLD §19.6 step 3, §19.7): the run's `prompt_prefix` skill entries in resolved order, read by the
   * lifecycle at dispatch. Absent or empty: the prompt is unchanged. An adapter renders them through `./prompt.ts`
   * into the text that carries the prompt and nowhere else; they never change the argv flags, the environment or the
   * policy flags. Never set for a handoff run (the handoff renderer places the block itself).
   */
  skills?: readonly PromptSkill[];
}

/**
 * T16.6 (LLD §19.6, ADR-0056 items 6 and 8, TDD §3.16.1): where a cell that delivers natively puts a skill file. The
 * path is always a fresh `switchboard-` path inside the run worktree: `<dir>/switchboard-<name>/<file>` (`layout.file`)
 * or `<dir>/switchboard-<name>.<ext>` (`layout.ext`). The workspace manager writes it (`src/workspace/native-skills.ts`);
 * the adapter only declares it.
 */
export interface NativeSkillLocation {
  /** Worktree-relative directory, `/`-separated; never absolute, never `..`, never a `.git` component. */
  readonly dir: string;
  readonly layout: { readonly file: string } | { readonly ext: string };
  /** Pure renderer from the canonical skill to the text the provider expects (UTF-8 on disk). */
  render(skill: PromptSkill): string;
  /**
   * Id of the T16.8 live check that showed a file at this location reaches the model. Required: a declaration without
   * one is read as `prompt_prefix` here, and the T16.7 conformance suite fails it.
   */
  readonly evidence: string;
}

/**
 * T16.5/T16.6 (LLD §19.6, ADR-0056 items 6 and 7, TDD §3.16.1): how a compiled cell delivers the run's skills. Every
 * shipped provider adapter and cell is `prompt_prefix` on 2026-10-17; only the fake adapter can declare `native`, in tests
 * (T16.6). T16.7 adds the per-adapter declarations and their conformance check.
 */
export type SkillDelivery = "prompt_prefix" | { readonly native: NativeSkillLocation };

/** The default for every adapter and cell (LLD §19.6). */
export const DEFAULT_SKILL_DELIVERY: SkillDelivery = "prompt_prefix";

/** Path segment rules of {@link nativeSkillPath}: no empty, `.`, `..` or `.git` segment, no backslash, no NUL. */
function safeSegment(seg: string): boolean {
  return (
    seg !== "" &&
    seg !== "." &&
    seg !== ".." &&
    seg.toLowerCase() !== ".git" &&
    !seg.includes("\\") &&
    !seg.includes("\0") &&
    !seg.includes("/")
  );
}

/** Skill names as the store accepts them (`src/skills/format.ts` `SKILL_NAME`), repeated so this module stays leaf. */
const NATIVE_SKILL_NAME = /^[a-z][a-z0-9-]{1,47}$/u;

/**
 * The worktree-relative path of `name`'s native file under `location`, or undefined when the location or the name is
 * not a safe relative path (fail closed: the caller then uses the prompt prefix).
 */
export function nativeSkillPath(location: NativeSkillLocation, name: string): string | undefined {
  if (!NATIVE_SKILL_NAME.test(name) || typeof location.dir !== "string") return undefined;
  const dir = location.dir.split("/");
  if (!dir.every(safeSegment)) return undefined;
  const layout = location.layout as { file?: unknown; ext?: unknown };
  if (typeof layout.file === "string" && safeSegment(layout.file)) {
    return [...dir, `switchboard-${name}`, layout.file].join("/");
  }
  if (typeof layout.ext === "string" && /^[A-Za-z0-9]{1,16}$/u.test(layout.ext)) {
    return [...dir, `switchboard-${name}.${layout.ext}`].join("/");
  }
  return undefined;
}

/**
 * The cell's declared delivery: {@link ProviderAdapter.skillDelivery} when the adapter declares it, else the default.
 * A `native` declaration is honoured only with a non-empty evidence id, a renderer and a safe location (T16.6);
 * anything else is read as `prompt_prefix` (fail closed: nothing is written to the worktree).
 */
export function skillDeliveryOf(
  adapter: Pick<ProviderAdapter, "skillDelivery">,
  request: CompileRequest,
  profile: ResolvedProfile,
): SkillDelivery {
  const declared = adapter.skillDelivery?.(request, profile);
  if (declared === "prompt_prefix") return declared;
  const native = typeof declared === "object" && declared !== null ? declared.native : undefined;
  if (
    native !== undefined &&
    typeof native.evidence === "string" &&
    native.evidence.trim() !== "" &&
    typeof native.render === "function" &&
    nativeSkillPath(native, "probe-name") !== undefined
  ) {
    return { native };
  }
  return DEFAULT_SKILL_DELIVERY;
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
  /** Present exactly when `transport` is `acp-stdio` (LLD §2 "ACP plan", ADR-0036). Pure data; audited before spawn. */
  acp?: AcpPlan;
  /**
   * T4.35 (owner decision 67): the native id a `subprocess-jsonl` resume asked for. `startAdapterRun` copies it to
   * {@link ParseState.resumeNativeSessionId} so the parser can fail closed when the provider answers in another session.
   */
  resumeNativeSessionId?: string;
}

/**
 * The ACP session plan an `acp-stdio` adapter compiles (LLD §2, ADR-0036 items 5 to 10; T4.8). Method and field names
 * are from the ACP specification v1 (agentclientprotocol.com, retrieved 2026-10-13, as cited in ADR-0036); what a real
 * provider does with them is Unverified until its operator capture.
 */
export interface AcpPlan {
  /** v2 is draft ([ACP-V2]); an `initialize` answer with any other version ends the run `OUTPUT_PROTOCOL_ERROR`. */
  protocolVersion: 1;
  /** Sent as one `text` content block in the single `session/prompt`. */
  prompt: string;
  /** `session/new` with `cwd` = `Invocation.cwd`, or a resume (`session/resume` if advertised, else `session/load`). */
  session: { kind: "new" } | { kind: "resume"; nativeSessionId: string };
  /** `[]` unless ADR-0036 item 7.3 holds; the pre-spawn audit refuses any entry until a per-provider ADR exists. */
  mcpServers: AcpStdioServer[];
  /** `session/set_mode` value compiled for the profile; audited against the registry's bypass-class mode ids. */
  modeId?: string;
  /** `session/set_config_option` values; audited against the registry's bypass-class values (use Unverified). */
  configOptions?: Array<{ configId: string; value: string }>;
  /** Native login command named on `AUTH_REQUIRED` (FR-AUTH-02). The client never logs in itself. */
  loginCommand: string;
  /**
   * Fail closed when a tool call runs without a `session/request_permission` naming it (outside an approved bypass
   * run): the client ends the run `PERMISSION_BLOCKED` (ADR-0049 item 3; set by the Kimi Code adapter, T4.68).
   */
  requirePermissionRequest?: boolean;
}

/** A stdio MCP server entry of `session/new` (ADR-0036 item 7.3). The tool token never travels here. */
export interface AcpStdioServer {
  name: string;
  command: string;
  args: string[];
  env: [];
}

/**
 * ACP facts a provider registry entry may declare (LLD §2, ADR-0036 items 9 and 10; additive only, as ADR-0035 item 2).
 * The bypass-class mode ids and option values are refused before spawn outside the approved bypass case.
 */
export interface AcpDeclarations {
  readonly bypassModeIds: readonly string[];
  readonly bypassConfigValues: ReadonlyArray<{ readonly configId: string; readonly value: string }>;
  /** Optional parser from an agent-reported tool call to an argv; used only to narrow (ADR-0036 item 9.2). */
  readonly parseExecute?: (toolCall: unknown) => string[] | null;
  /** Optional parser from an agent-reported tool call to a host name; used only to narrow (ADR-0036 item 9.2). */
  readonly parseFetchHost?: (toolCall: unknown) => string | null;
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
  | {
      kind: "tool_call";
      tool: "read" | "edit" | "shell" | "other";
      name: string;
      target?: string;
      denied?: boolean;
      /** Transient: a shell tool's command line, set by the parser, evaluated and dropped by `startAdapterRun` (`./tool-guard.ts`); never stored. */
      command?: string;
      /** Set by `startAdapterRun` when Switchboard's own tool-call guard fired (Q-62 to Q-65, ADR-0039). */
      violation?: { kind: "git_write" | "provider_state"; reason: string };
    }
  | { kind: "message"; role: "assistant"; text: string }
  | { kind: "usage"; source: "provider_reported"; metrics: Record<string, number | string | null> }
  | { kind: "rate_limit"; resetAt?: string; reportedCategory?: string }
  | {
      kind: "permission_denied";
      tool: string;
      /**
       * ADR-0072: what kind of denial the adapter positively identified. Only `profile` (a tool or command the trust
       * profile does not allow, e.g. Claude Code's dontAsk `mode` denial) is recoverable; every other class, and an
       * absent class, keeps failing the run (fail closed).
       */
      denial?: DenialClass;
    }
  | { kind: "sandbox_violation"; detail: string }
  | { kind: "provider_error"; category: string; message: string }
  | { kind: "result"; ok: boolean; summary?: string }
  | { kind: "unknown"; rawType: string };

/** Proposed: mutable per-run parser scratch state. */
export interface ParseState {
  lines: number;
  unknownEvents: number;
  nativeSessionId?: string;
  /** The id this run was compiled to resume ({@link Invocation.resumeNativeSessionId}); absent on a first run. */
  resumeNativeSessionId?: string;
  /** Claude Code only (C-10): `tool_use_id`s already reported from a `system/permission_denied` event, so the `result` event's `permission_denials` entry for the same call is not reported twice. */
  claudeDeniedToolUseIds?: Set<string>;
  /**
   * Claude Code only (ADR-0072 follow-up): the command line of each `Bash` `tool_use` by id, kept only until a
   * `rule` denial of that id is classified (bounded; a missing entry classifies as security-class).
   */
  claudeBashCommands?: Map<string, string>;
  /** ACP only (T4.8): scratch state of the shared `session/update` mapper (`src/exec/acp/events.ts`). */
  acp?: AcpParseState;
}

/** Proposed (T4.8): what the shared ACP mapper keeps between messages. The client owns `deniedToolCallIds`. */
export interface AcpParseState {
  /** Tool call ids whose permission request the client rejected (their `tool_call` events get `denied: true`). */
  readonly deniedToolCallIds: Set<string>;
  /** The assistant message being joined from `agent_message_chunk` updates, flushed on any other update. */
  message?: { id: string | undefined; text: string; truncated: boolean } | undefined;
}

export function createParseState(): ParseState {
  return { lines: 0, unknownEvents: 0 };
}

/** Proposed: how the supervised process ended, as the adapter sees it. */
export interface ExitInfo {
  outcome: "exited" | "timeout" | "cancelled" | "protocol_error" | "crashed" | "spawn_error" | "internal_error";
  exitCode: number | null;
  signal: string | null;
  /** `acp_initialize` and `acp_session` are the ACP handshake bounds (ADR-0036 item 4). */
  timeoutKind?: "wall_clock" | "idle" | "acp_initialize" | "acp_session";
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
/**
 * ADR-0072: closed denial classes of a `permission_denied` event. `profile` is the recoverable class; `git_write` (a
 * Switchboard Git deny rule, FR-GIT-01) and `outside_worktree` (a file tool confined to the worktree or a location
 * outside the allowed roots) are security-class. No class means unknown, which is treated as security-class.
 * `git_rule_local` (ADR-0072 follow-up) is also recoverable: a Git deny rule blocked a command whose Git invocations
 * are only reads or local ref verbs (`git branch -a`, `git log`), never a push, remote, config or repository redirect.
 */
export const DENIAL_CLASSES = ["profile", "git_write", "outside_worktree", "git_rule_local"] as const;
export type DenialClass = (typeof DENIAL_CLASSES)[number];

/**
 * ADR-0072: closed warning codes of a run result. `PERMISSION_DENIED_RECOVERED` for `profile` denials,
 * `GIT_RULE_DENIED_RECOVERED` for `git_rule_local` denials.
 */
export const RUN_WARNING_CODES = ["PERMISSION_DENIED_RECOVERED", "GIT_RULE_DENIED_RECOVERED"] as const;

/** ADR-0072: one run-result warning; `tool` is a sanitised tool name, never agent text. */
export interface RunWarning {
  code: (typeof RUN_WARNING_CODES)[number];
  tool: string;
  count: number;
}

export interface RunResult {
  ok: boolean;
  failureCode?: FailureCode;
  failureDetail?: string;
  summary?: string;
  nativeSessionId?: string;
  unknownEventCount: number;
  /** ADR-0072: present only on a successful result whose recovered, non-security denials did not fail it. */
  warnings?: RunWarning[];
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
  /** T9.6 added `push`, T12.9 the read-only `search_project_context` (FR-RAG-13). */
  readonly toolNames: readonly ("commit" | "push" | "search_project_context")[];
  /** Environment the shim needs: exactly the token variable (`SWITCHBOARD_TOOL_TOKEN`). */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * FR-GIT-02 declaration (LLD §2 "M9 additions"; T9.4). `injected`: the adapter can pass the per-run channel to its
 * provider without a permission-bypass flag (FR-POL-03), through `channelArgs`. `finalize-only`: it cannot, and the
 * controller commits at FINALIZING when the operator opts in (FR-GIT-09, T9.7). `none`: no channel is declared; `detail`
 * says why (Codex: unverified provider behaviour; Claude Code: the same unless the operator sets the bypass-only opt-in
 * `providers.claude-code.git_channel`, T9.4b, ADR-0029, ADR-0033). `detail` is an addition to the LLD shape so the
 * reason is recorded with the declaration.
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

/**
 * Whether a resumed native session is tied to the working directory it was created in (T5.7; ADR-0038 item 6.3,
 * LLD §15.6). Static adapter data, set from TDD §4.10:
 * - `bound`: sourced as tied to the directory (Antigravity, Muse Code).
 * - `unverified`: not known (Claude Code, Codex, Grok Build, Cursor, OpenCode, Kimi Code until their operator checks
 *   record a result). Handled exactly as `bound` (NFR-SEC-06).
 * - `independent`: a dated capture recorded `PASS` for resume from another worktree (T5.12 check 2 or the provider's M4
 *   operator item). The only value that lets a resume run in a fresh worktree path.
 */
export type ResumeCwd = "bound" | "independent" | "unverified";

/**
 * True only for `independent`. Every other value, and a missing or malformed declaration, means the resume runs in the
 * worktree path of the run that created the native session (fail closed, NFR-SEC-06).
 */
export function resumeMayChangeDirectory(adapter: { readonly resumeCwd?: unknown }): boolean {
  return adapter.resumeCwd === "independent";
}

/**
 * T7.12 (FR-RTE-08, Q-90): whether a model id the provider's native session reports (`session_bound.model`) is accepted
 * by the adapter's model flag, so routing may pin a project's remembered model at `compile`. Static adapter data:
 * - `accepted`: the reported value is a model id the model flag takes, with the source in `detail`.
 * - `not_accepted`: the provider reports something else (a display name), or the adapter emits no model flag.
 * An adapter without a declaration is handled as `not_accepted` (fail closed: the run keeps the adapter default).
 */
export interface ReportedModelFlag {
  kind: "accepted" | "not_accepted";
  detail: string;
}

/** True only for a declared `accepted`; anything else keeps the adapter default (NFR-SEC-06). */
export function acceptsReportedModel(adapter: { readonly reportedModelFlag?: unknown }): boolean {
  const d = adapter.reportedModelFlag;
  return typeof d === "object" && d !== null && (d as { kind?: unknown }).kind === "accepted";
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly transports: readonly Transport[];
  /** FR-GIT-01 declaration, surfaced by `list_capabilities`. */
  readonly gitWriteControl: GitWriteControl;
  /** T5.7 declaration ({@link ResumeCwd}): whether a native resume is tied to its working directory. */
  readonly resumeCwd: ResumeCwd;
  /** FR-GIT-02 declaration (T9.4): whether and how the per-run injected tool channel reaches the provider. */
  readonly gitCapabilities: GitCapabilities;
  /** T7.12 declaration ({@link ReportedModelFlag}); absent means `not_accepted`. */
  readonly reportedModelFlag?: ReportedModelFlag;
  /** T16.5/T16.6 declaration ({@link SkillDelivery}), pure, per compiled cell; absent means `prompt_prefix` for every cell. */
  skillDelivery?(request: CompileRequest, profile: ResolvedProfile): SkillDelivery;

  /** FR-ADP-02 steps 1-5: binary, version, command, output formats, required flags. No auth, no model call. */
  probe(runner: ProbeRunner): Promise<ProbeResult>;
  /** Provider's own status command or a harmless headless call; never reads credentials (FR-AUTH-02). */
  authPreflight(runner: ProbeRunner): Promise<AuthResult>;
  /**
   * ADR-0079 (FR-CAP-13): optional. The account's quota windows as the provider's own CLI reports them, read through
   * the runner with no model call and no credential read by Switchboard. Absent means the provider has no such reader.
   */
  readProviderUsage?(runner: ProbeRunner, now?: Date): Promise<ProviderUsageResult>;
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
