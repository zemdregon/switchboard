/**
 * Muse Code adapter (T4.72, TDD §4.8; module, probe, compile matrix and registry entry; Delegated, not owner-approved).
 * Native surface (Proposed, TDD §4.8): one process per run, `muse exec --json -w off <policy flags> <prompt>`. The
 * adapter never reads Muse credential, trust or settings files, never runs login, never writes provider configuration,
 * never emits `--yolo`, `--disable-approval`, `--disable-sandbox`, `--approval-mode never` or a `-c` setting, keeps
 * approvals and the sandbox on in every compiled cell, always passes `-w off` (the controller owns the worktree) and
 * keeps `META_API_KEY` out of the child environment.
 *
 * `MUSE_NO_AUTO_UPDATE=1` is deliberately NOT set: it is reported by a third party only ([Orca]), Meta's pages do not
 * mention it, and neither T4.70 nor T4.71 confirmed that it pins the version (TDD §4.8 "Version gate"). The version gate
 * (ADR-0009) is the control until then.
 *
 * Compile matrix (Proposed, fail closed; Delegated decisions, T4.72, following Grok Build T4.22):
 * - the four non-`privileged` profiles are `Ineligible: PROFILE_UNSUPPORTED` until T4.71 results exist
 *   ({@link NON_PRIVILEGED_UNSUPPORTED_DETAIL}); TDD §4.8 sources no control that makes one safe;
 * - `privileged` without `bypass` is `Ineligible` too: no non-bypass cell is shown to hold, and the shared argv audit
 *   refuses `-w` (Cursor's declared short flag, ADR-0037) outside an approved bypass run, so such an argv could never
 *   spawn ({@link MUSE_PRIVILEGED_NEEDS_BYPASS});
 * - `privileged` with `bypass` and an approval compiles per owner decision 46: approvals `on-request`, network
 *   `restricted` for `off` or `unrestricted` for `on`, `--trust-workspace` for repository configuration `enabled`.
 * Parser, result, failure classification and resume (T4.73, Delegated, not owner-approved; synthetic fixtures, no `muse`
 * was run): record kinds and fields are reported or **Assumption** spellings in protocol.ts, `Unverified: T4.71`. Success
 * needs a `run_terminal` record with `terminal: "completed"` and a clean expected exit; exit code `0` alone never is
 * ([M-ext]: it "reports how the run ended, not whether the work is correct", BR-16). Auth preflight (T4.74),
 * conformance (T4.75), malicious leg (T4.76) and the Git declaration (T4.77) are later tasks; until then the auth state
 * is `UNKNOWN`.
 */
import {
  DEFAULT_IDLE_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_WALL_CLOCK_MS,
} from "../../exec/index.js";
import { resolveOnPath } from "../codex/adapter.js";
import { classifyCommon, PROVIDER_ERROR_CATEGORY_CODES } from "../failure.js";
import { gitWriteRisks } from "../git-write.js";
import { parseVersion } from "../manifest/index.js";
import type {
  AcpMessage,
  AuthResult,
  CompileRequest,
  ExitInfo,
  FailureClassification,
  FailureEvidence,
  GitCapabilities,
  GitWriteControl,
  Ineligible,
  Invocation,
  NativeBinding,
  NormalizedEvent,
  ParseState,
  ProbeResult,
  ProbeRunner,
  ProviderAdapter,
  ResolvedProfile,
  RunResult,
} from "../types.js";
import {
  APPROVAL_MODE_FLAG,
  APPROVAL_ON_REQUEST,
  AUTH_LOGGED_IN_PREFIX,
  AUTH_LOGGED_OUT_PREFIX,
  AUTH_STATUS_ARGS,
  AUTH_STATUS_LINE_MAX,
  AUTH_STATUS_TIMEOUT_MS,
  DELTA_TEXT_FIELD,
  EXEC_SUBCOMMAND,
  GIT_WRITE_CONTROL_DETAIL,
  HELP_ARGS,
  JSON_FLAG,
  MUSE_BINARY,
  MUSE_LOGIN_COMMAND,
  NON_PRIVILEGED_UNSUPPORTED_DETAIL,
  RECORD,
  REQUIRED_HELP_FLAGS,
  SANDBOX_NETWORK_FLAG,
  SANDBOX_NETWORK_RESTRICTED,
  SANDBOX_NETWORK_UNRESTRICTED,
  SESSION_ID_FIELD,
  SESSION_ID_FLAG,
  TERMINAL_COMPLETED,
  TRUST_WORKSPACE_FLAG,
  VERSION_ARGS,
  WORKTREE_OFF,
  WORKTREE_SHORT_FLAG,
} from "./protocol.js";

/**
 * Environment names passed through to Muse Code (FR-EXE-07, NFR-SEC-02). Proposed: `PATH` for the binary and `HOME` so
 * the CLI finds its own native login. `META_API_KEY` (hides the browser session, [M-auth]), `MUSE_NO_AUTO_UPDATE`
 * (unconfirmed, see the header), `XDG_CONFIG_HOME` and `CODEX_HOME` (relocate ambient settings and skills, [M-ext])
 * stay out (ADR-0003).
 */
export const MUSE_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME"];

const PROBE_TIMEOUT_MS = 10_000;
const AUTH_UNKNOWN_REASON = "`muse auth status` first line is not a recognised login state";
const MAX_SUMMARY_CHARS = 2_000;
/** `--session-id <uuid>` ([M-ext]): only a canonical uuid is bound or resumed, so the id is one argument, never a flag. */
const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** FR-GIT-01 (ADR-0039): no per-command deny control is documented; see protocol.ts. */
export const MUSE_GIT_WRITE_CONTROL: GitWriteControl = {
  kind: "none-documented",
  detail: GIT_WRITE_CONTROL_DETAIL,
  remainingControls: ["FR-GIT-03", "FR-GIT-06"],
};

/** FR-GIT-09 (TDD §4.8 "Per-run MCP"): the `-c` form for a server block is `Unverified: T4.71`, so nothing is injected. */
export const MUSE_GIT_CAPABILITIES: GitCapabilities = {
  commitChannel: "finalize-only",
  detail:
    "Per-run MCP through `-c key=value` is plausible ([M-log]) but its syntax for a server block and whether it leaves " +
    "the user settings untouched are Unverified: T4.71, so no tool is injected. The controller commits at FINALIZING " +
    "when the project opts in (FR-GIT-09).",
};

/** Ineligible detail for a bypass approval on a profile other than `privileged` (FR-POL-03). */
export const MUSE_BYPASS_OUTSIDE_PRIVILEGED =
  "bypassApproved is set on a profile other than privileged: a bypass applies only to an approved privileged scope " +
  "(FR-POL-03, ADR-0017)";
/** Ineligible detail for a `privileged` scope without `bypass` (see the header). */
export const MUSE_PRIVILEGED_NEEDS_BYPASS =
  "privileged without bypass: no non-bypass Muse Code cell is shown to hold until T4.71 (TDD §4.8), and the shared " +
  "argv audit refuses -w (a declared Cursor short flag, ADR-0037) outside an approved bypass run, so `-w off` could " +
  "not spawn";
/** Ineligible detail for a scope that sets `bypass` on a run whose approval is missing (FR-POL-03). */
export const MUSE_BYPASS_NOT_APPROVED =
  "privileged scope sets bypass but the run's bypassApproved is false: the Muse Code bypass cell is compiled only for " +
  "an approved bypass run (FR-POL-03, ADR-0017)";

export interface MuseAdapterOptions {
  /** Absolute path of the muse binary. Defaults to the first executable `muse` on PATH, resolved once. */
  executable?: string;
  /** Test-only: arguments inserted between the executable and the flags (replay launcher). Empty in production. */
  launcherArgs?: readonly string[];
  timeouts?: Partial<Invocation["timeouts"]>;
  /** PATH used to resolve `muse` when `executable` is absent. Defaults to process.env.PATH. */
  pathEnv?: string;
}

type Json = Record<string, unknown>;
const ownProp = (record: Json | undefined, key: string): unknown =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const ineligible = (reason: Ineligible["reason"], detail: string): Ineligible => ({ ineligible: true, reason, detail });
/** `run_terminal` records already seen per run: any record after the first is a protocol anomaly (fail closed). */
const seenTerminals = new WeakMap<ParseState, number>();
/** Category of a stream anomaly (a record after `run_terminal`, a changed or unsafe session id): OUTPUT_PROTOCOL_ERROR. */
const PROTOCOL_CATEGORY = "protocol";
const CATEGORY_CODES = { ...PROVIDER_ERROR_CATEGORY_CODES, [PROTOCOL_CATEGORY]: "OUTPUT_PROTOCOL_ERROR" } as const;

export class MuseAdapter implements ProviderAdapter {
  readonly id = "muse" as const;
  readonly transports = ["subprocess-jsonl"] as const;
  readonly gitWriteControl = MUSE_GIT_WRITE_CONTROL;
  /** TDD §4.10 ([M-ext]): `--allow-workspace-switch` is needed when the workspace differs, so `bound`. */
  readonly resumeCwd = "bound" as const;
  readonly gitCapabilities = MUSE_GIT_CAPABILITIES;
  readonly #exe: string | undefined;
  readonly #launcher: readonly string[];
  readonly #timeouts: Invocation["timeouts"];

  constructor(opts: MuseAdapterOptions = {}) {
    this.#exe = opts.executable ?? resolveOnPath(MUSE_BINARY, opts.pathEnv ?? process.env.PATH);
    this.#launcher = [...(opts.launcherArgs ?? [])];
    this.#timeouts = {
      wallClockMs: DEFAULT_WALL_CLOCK_MS,
      idleMs: DEFAULT_IDLE_MS,
      killGraceMs: DEFAULT_KILL_GRACE_MS,
      ...opts.timeouts,
    };
  }

  /**
   * FR-ADP-02 steps 1 to 5 with no model call: `muse --version` ([M-ov]; the version is the first semver in the first
   * non-empty line, whatever words surround it), then `muse exec --help` for the required flags. Output is probe
   * evidence only (FR-ADP-04).
   */
  async probe(runner: ProbeRunner): Promise<ProbeResult> {
    const exe = this.#exe;
    if (exe === undefined) {
      return {
        binaryPath: MUSE_BINARY,
        binaryVersion: null,
        steps: [{ step: "binary", ok: false, detail: `${MUSE_BINARY} not found on PATH` }],
      };
    }
    const run = (...args: string[]) => runner([exe, ...this.#launcher, ...args], { timeoutMs: PROBE_TIMEOUT_MS });
    const ver = await run(...VERSION_ARGS);
    const binaryOk = ver.spawnError === undefined && !ver.timedOut && ver.exitCode === 0;
    const line =
      ver.stdout
        .split("\n")
        .find((l) => l.trim() !== "")
        ?.trim() ?? "";
    const version = binaryOk && parseVersion(line) ? line : null;
    const steps: ProbeResult["steps"] = [
      { step: "binary", ok: binaryOk, ...(binaryOk ? {} : { detail: ver.spawnError ?? `exit ${ver.exitCode}` }) },
      { step: "version", ok: version !== null, ...(version === null ? { detail: "no parseable version" } : {}) },
    ];
    if (!binaryOk) return { binaryPath: exe, binaryVersion: null, steps };

    const help = await run(...HELP_ARGS);
    const commandOk = help.spawnError === undefined && !help.timedOut && help.exitCode === 0;
    const flags = new Set(commandOk ? (help.stdout.match(/--[a-z][a-z0-9-]*/g) ?? []) : []);
    const missing = REQUIRED_HELP_FLAGS.filter((f) => !flags.has(f));
    steps.push(
      { step: "command", ok: commandOk, ...(commandOk ? {} : { detail: `\`${HELP_ARGS.join(" ")}\` unavailable` }) },
      { step: "output_format", ok: flags.has(JSON_FLAG), ...(flags.has(JSON_FLAG) ? {} : { detail: JSON_FLAG }) },
      {
        step: "flags",
        ok: missing.length === 0,
        ...(missing.length ? { detail: `missing ${missing.join(" ")}` } : {}),
      },
    );
    return { binaryPath: exe, binaryVersion: version, steps };
  }

  /** FR-AUTH-01/02 (T4.74): `muse auth status` is assumed until T4.71; first-line prefixes are Assumption spellings. */
  async authPreflight(runner: ProbeRunner): Promise<AuthResult> {
    const exe = this.#exe;
    if (exe === undefined) return { state: "UNKNOWN", reason: `${MUSE_BINARY} not found on PATH` };
    const r = await runner([exe, ...this.#launcher, ...AUTH_STATUS_ARGS], { timeoutMs: AUTH_STATUS_TIMEOUT_MS });
    if (r.spawnError !== undefined) return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (${r.spawnError})` };
    if (r.timedOut) return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (timed out)` };
    const first = (r.stdout.split("\n").find((l) => l.trim() !== "") ?? "").trim();
    if (r.exitCode === 0) {
      if (first.startsWith(AUTH_LOGGED_IN_PREFIX)) return { state: "OK" };
      if (first.startsWith(AUTH_LOGGED_OUT_PREFIX)) return { state: "AUTH_REQUIRED", loginCommand: MUSE_LOGIN_COMMAND };
    }
    const line = Array.from(first)
      .filter((c) => c >= " " && c !== "\x7f")
      .join("")
      .slice(0, AUTH_STATUS_LINE_MAX);
    return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (exit ${r.exitCode}${line ? `: ${line}` : ""})` };
  }

  compile(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    return this.#build(request, profile, []);
  }

  /**
   * FR-SES-03 (T4.73): `muse exec --session-id <uuid> <prompt>` ([M-ext], corrected) with the id the parser bound from
   * structured output, compiled by the same matrix as a first run (same Ineligible reasons, every policy flag passed
   * again: whether a resumed run keeps its flags is `Unverified: T4.71` item 14). A binding of another provider or an
   * id that is not a uuid is never compiled; `--allow-workspace-switch` is never emitted (`resumeCwd` is `bound`).
   */
  resumeArgs(binding: NativeBinding, request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== "muse") return ineligible("CAPABILITY_MISSING", `binding is for ${binding.provider}`);
    if (!SESSION_ID_RE.test(binding.nativeSessionId)) {
      return ineligible("CAPABILITY_MISSING", "native session id is not a uuid (`--session-id <uuid>`, [M-ext])");
    }
    return this.#build(request, profile, [SESSION_ID_FLAG, binding.nativeSessionId]);
  }

  /**
   * Pure. Order of checks (the first unmet one is the reason):
   * 0. shell allowlist entries that could write Git: PROFILE_UNSUPPORTED (FR-GIT-01);
   * 1. a bypass approval on a profile other than `privileged`: PROFILE_UNSUPPORTED (FR-POL-03);
   * 2. any profile other than `privileged`: PROFILE_UNSUPPORTED ({@link NON_PRIVILEGED_UNSUPPORTED_DETAIL});
   * 3. `privileged`: no scope binding, or `bypass: false`: PROFILE_UNSUPPORTED; `bypass: true` without an approval:
   *    PROFILE_UNSUPPORTED (FR-POL-03);
   * 4. shell other than `broad`: CAPABILITY_MISSING (no per-run allow rule is documented; `untrusted` with no TTY is
   *    Unverified: T4.71);
   * 5. files `read-only`: CAPABILITY_MISSING (no read-only file mode is documented in TDD §4.8);
   * 6. network `allowlist`: CAPABILITY_MISSING (what `proxy-only` admits is not documented);
   * 7. repository_config `disabled` or `approved`: CAPABILITY_MISSING (an untrusted headless run stops [M-log], user
   *    rules and home-directory skills load regardless [M-cfg], [M-ext], and there is no per-item approval);
   * 8. a requested model: CAPABILITY_MISSING (TDD §4.8 sources no model flag; no model registry data, T4.5);
   * 9. an objective that is empty or starts with `-`: CAPABILITY_MISSING (the prompt is one positional word [M-ext];
   *    no end-of-options marker is sourced, so a leading dash could be read as a flag).
   */
  #build(request: CompileRequest, profile: ResolvedProfile, resume: readonly string[]): Invocation | Ineligible {
    const gitWrites = gitWriteRisks(profile.shellAllowlist ?? []);
    if (gitWrites.length > 0) {
      return ineligible(
        "PROFILE_UNSUPPORTED",
        `shell allowlist entries could write Git (FR-GIT-01): ${gitWrites.map((g) => g.command).join("; ")}`,
      );
    }
    if (profile.name !== "privileged") {
      if (profile.bypassApproved || request.bypassApproved === true) {
        return ineligible("PROFILE_UNSUPPORTED", MUSE_BYPASS_OUTSIDE_PRIVILEGED);
      }
      return ineligible("PROFILE_UNSUPPORTED", `${profile.name}: ${NON_PRIVILEGED_UNSUPPORTED_DETAIL}`);
    }
    const scope = profile.privilegedScope?.scope;
    if (scope === undefined) {
      return ineligible("PROFILE_UNSUPPORTED", "privileged without an approved scope binding (LLD §3.1)");
    }
    if (!scope.bypass) return ineligible("PROFILE_UNSUPPORTED", MUSE_PRIVILEGED_NEEDS_BYPASS);
    if (!(profile.bypassApproved || request.bypassApproved === true)) {
      return ineligible("PROFILE_UNSUPPORTED", MUSE_BYPASS_NOT_APPROVED);
    }
    if (scope.shell.mode !== "broad") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged shell=${scope.shell.mode}: Muse Code documents no per-run allow rule, and whether ` +
          "--approval-mode untrusted stops or denies with no TTY is Unverified: T4.71",
      );
    }
    if (scope.files.access === "read-only" || !request.workspace.writable) {
      return ineligible("CAPABILITY_MISSING", "privileged read-only files: no read-only file mode is documented");
    }
    const network = scope.network.mode;
    if (network === "allowlist") {
      return ineligible(
        "CAPABILITY_MISSING",
        "privileged network=allowlist: what --sandbox-network proxy-only admits is not documented (R-36)",
      );
    }
    if (scope.repository_config.mode !== "enabled") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged repository_config=${scope.repository_config.mode}: an untrusted headless run stops naming ` +
          "--trust-workspace ([M-log]), user-level rules and home-directory skills load regardless ([M-cfg], [M-ext]) " +
          "and the CLI has no per-item approval",
      );
    }
    if (request.model !== undefined) {
      return ineligible(
        "CAPABILITY_MISSING",
        "no model flag is sourced for Muse Code and no model registry data (T4.5)",
      );
    }
    if (request.objective.trim() === "" || request.objective.startsWith("-")) {
      return ineligible(
        "CAPABILITY_MISSING",
        "the prompt is one positional argument ([M-ext]) and no end-of-options marker is sourced, so an empty " +
          "objective or one starting with '-' is not compiled",
      );
    }
    if (this.#exe === undefined) return ineligible("CAPABILITY_MISSING", `${MUSE_BINARY} not found on PATH`);

    // Approvals and the sandbox stay on: the default approval mode is passed explicitly so the audit sees it, and the
    // network value is the narrowest one that grants what the scope asks for ([M-perm]). `--trust-workspace` loads the
    // workspace's skills and rules, which repository_config `enabled` grants in an approved bypass run ([M-log]).
    const policyFlags = [
      WORKTREE_SHORT_FLAG,
      WORKTREE_OFF,
      APPROVAL_MODE_FLAG,
      APPROVAL_ON_REQUEST,
      SANDBOX_NETWORK_FLAG,
      network === "off" ? SANDBOX_NETWORK_RESTRICTED : SANDBOX_NETWORK_UNRESTRICTED,
      TRUST_WORKSPACE_FLAG,
    ];
    return {
      transport: "subprocess-jsonl",
      // The prompt is the last argv word (inline prompt, [M-ext]); it is visible in the process list.
      argv: [this.#exe, ...this.#launcher, EXEC_SUBCOMMAND, JSON_FLAG, ...policyFlags, ...resume, request.objective],
      env: {},
      envAllowlist: [...MUSE_ENV_ALLOWLIST],
      cwd: request.workspace.cwd,
      stdin: { kind: "none" },
      outputFormat: "jsonl",
      timeouts: { ...this.#timeouts },
      policyFlags,
      // `0` means only that the turn completed ([M-ext]); the terminal record decides success (T4.73, BR-16).
      expectedExitCodes: [0],
      maxLineBytes: DEFAULT_MAX_LINE_BYTES,
    };
  }

  /**
   * One `--json` record per line (T4.73; spellings in protocol.ts, `Unverified: T4.71`). `run_started` binds the
   * session id from its structured field only; `run_output_delta` text becomes assistant messages; `run_terminal`
   * becomes the `result` (ok only for `terminal: "completed"`); the other [SDK] kinds carry nothing Switchboard records
   * and are dropped (`turn_input_user` echoes the prompt; no usage field is sourced, so none is recorded, FR-CAP-01).
   * Any other kind, a record without a string `kind`, or a known kind without its field is `unknown`: counted, never a
   * result. Fail closed (Delegated): any record after the first `run_terminal`, a session id that is not a uuid and a
   * changed session id are OUTPUT_PROTOCOL_ERROR.
   */
  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[] {
    if (typeof input !== "string") return []; // no ACP transport for Muse Code (TDD §4.8)
    state.lines += 1;
    let doc: unknown;
    try {
      doc = JSON.parse(input);
    } catch {
      return []; // the supervisor ends the run OUTPUT_PROTOCOL_ERROR on unparseable framing
    }
    const terminalsBefore = seenTerminals.get(state) ?? 0;
    const events = this.#record(obj(doc), state);
    if (terminalsBefore === 0) return events;
    // `run_terminal` "marks the end" ([Orca]); a later record could flip or extend the outcome, so the run fails.
    return [{ kind: "provider_error", category: PROTOCOL_CATEGORY, message: "record after run_terminal" }, ...events];
  }

  #record(e: Json | undefined, state: ParseState): NormalizedEvent[] {
    const kind = str(ownProp(e, "kind"));
    if (e === undefined || kind === undefined) return this.#unknown(state, "none");
    switch (kind) {
      case RECORD.runStarted: {
        const id = ownProp(e, SESSION_ID_FIELD);
        if (id === undefined) return [];
        if (typeof id !== "string") return this.#unknown(state, kind);
        return this.#bind(state, id);
      }
      case RECORD.runOutputDelta: {
        const text = str(ownProp(e, DELTA_TEXT_FIELD));
        if (text === undefined) return this.#unknown(state, kind);
        return text === "" ? [] : [{ kind: "message", role: "assistant", text }];
      }
      case RECORD.runTerminal: {
        const terminal = str(ownProp(e, "terminal"));
        if (terminal === undefined) return this.#unknown(state, kind);
        seenTerminals.set(state, (seenTerminals.get(state) ?? 0) + 1);
        if (terminal === TERMINAL_COMPLETED) {
          const text = str(ownProp(e, "text"));
          return [{ kind: "result", ok: true, ...(text ? { summary: text.slice(-MAX_SUMMARY_CHARS) } : {}) }];
        }
        const reason = str(ownProp(e, "reason"));
        const summary = `terminal ${clip(terminal, 64)}${reason ? `: ${clip(reason, MAX_SUMMARY_CHARS)}` : ""}`;
        return [{ kind: "result", ok: false, summary }];
      }
      case RECORD.taskLifecycle:
      case RECORD.commandAccepted:
      case RECORD.commandResult:
      case RECORD.modelConfigured:
      case RECORD.toolResult:
      case RECORD.turnInputUser:
        return [];
      default:
        return this.#unknown(state, kind);
    }
  }

  /** The first uuid binds the session; a different later id, or one that is not a uuid, fails the run (fail closed). */
  #bind(state: ParseState, id: string): NormalizedEvent[] {
    if (!SESSION_ID_RE.test(id)) {
      return [{ kind: "provider_error", category: PROTOCOL_CATEGORY, message: "session id is not a uuid" }];
    }
    if (state.nativeSessionId !== undefined) {
      if (id === state.nativeSessionId) return [];
      return [{ kind: "provider_error", category: PROTOCOL_CATEGORY, message: "session id changed mid-run" }];
    }
    state.nativeSessionId = id;
    return [{ kind: "session_bound", nativeSessionId: id }];
  }

  #unknown(state: ParseState, rawType: string): NormalizedEvent[] {
    state.unknownEvents += 1;
    return [{ kind: "unknown", rawType: clip(rawType, 64) }];
  }

  /**
   * Success needs a clean expected exit, a final `result` with `ok` (a `run_terminal` of `completed`) and no
   * `provider_error`, `permission_denied`, `sandbox_violation`, `rate_limit` or guard-flagged `tool_call` event (fail
   * closed, as Grok Build T4.23). Exit `0` with any other terminal value is a failure; unknown records are counted and
   * never make a result. The summary is the joined assistant text (last {@link MAX_SUMMARY_CHARS} characters), else the
   * terminal record's text.
   */
  extractResult(events: readonly NormalizedEvent[], exit: ExitInfo): RunResult {
    const unknownEventCount = events.filter((e) => e.kind === "unknown").length;
    const bound = events.findLast((e) => e.kind === "session_bound");
    const nativeSessionId = bound?.kind === "session_bound" ? bound.nativeSessionId : undefined;
    const final = events.findLast((e) => e.kind === "result");
    const text = events.flatMap((e) => (e.kind === "message" ? [e.text] : [])).join("");
    const summary = text !== "" ? text.slice(-MAX_SUMMARY_CHARS) : final?.kind === "result" ? final.summary : undefined;
    const base = {
      unknownEventCount,
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(summary ? { summary } : {}),
    };
    const clean =
      exit.outcome === "exited" &&
      exit.exitCode !== null &&
      exit.expectedExitCodes.includes(exit.exitCode) &&
      final?.kind === "result" &&
      final.ok &&
      !events.some(
        (e) =>
          e.kind === "provider_error" ||
          e.kind === "permission_denied" ||
          e.kind === "sandbox_violation" ||
          e.kind === "rate_limit" ||
          (e.kind === "tool_call" && e.violation !== undefined),
      );
    if (clean) return { ok: true, ...base };
    const c = this.classifyFailure({
      events,
      exit,
      stderrTail: "",
      timedOut: exit.outcome === "timeout",
      cancelled: exit.outcome === "cancelled",
    });
    return { ok: false, failureCode: c.code, failureDetail: c.detail, ...base };
  }

  /**
   * Shared precedence (failure.ts); a stream anomaly (category `protocol`) is OUTPUT_PROTOCOL_ERROR. No native error,
   * rate-limit, permission or sandbox record is sourced (TDD §4.8), so a failed terminal and an unexpected exit code
   * ([M-ext]: `1` failed or cancelled, `2` usage error, `130`, `143`) are TOOL_FAILURE, never a narrower code.
   */
  classifyFailure(evidence: FailureEvidence): FailureClassification {
    return classifyCommon(evidence, CATEGORY_CODES);
  }
}
