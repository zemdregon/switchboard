/**
 * Cursor CLI adapter (T4.42, TDD §4.5; module, probe, compile matrix and registry entry; Delegated, not
 * owner-approved). Native surface: one process per run, `cursor-agent --print --output-format stream-json` with the
 * prompt on stdin (TDD §4.5.2 "Transport decision"; [LIVE] 6a: with no positional argument stdin is the prompt, so the
 * prompt is neither visible in the process list nor ever read as a flag). The adapter never reads Cursor credential or
 * configuration files, never runs login, never writes provider configuration (no `CURSOR_CONFIG_DIR` file), never
 * emits `--approve-mcps`, `--yolo`, `-f`, `--auto-review`, `-w`/`--worktree`, `--workspace`, `--add-dir`,
 * `--plugin-dir`, `--continue`, `--sandbox disabled` or a credential flag, and emits its one bypass flag only for an
 * approved `privileged` scope that sets `bypass` (FR-POL-03, ADR-0017).
 *
 * Compile matrix (Proposed, fail closed; Delegated decisions from the 2026-10-14 live check, Q-65 and Q-79):
 * - the four non-`privileged` profiles are `Ineligible: PROFILE_UNSUPPORTED`: no read-only control exists (edits
 *   apply without `--force`), `--sandbox enabled` was never shown to confine (it exits 1 on the operator's host), a run
 *   needs `--trust` to start and then loads the repository's rules, and the operator's global rules and MCP servers
 *   load in every run (FR-POL-02, FR-POL-06);
 * - `privileged` compiles only when its scope sets `bypass` and the run is approved (owner decision 46: the bypass
 *   cell does not wait for Git-write denial to be shown to hold), and only for the scope Cursor cannot narrow below:
 *   worktree files, shell `broad`, network `on` and repository configuration `enabled` (Q-79). No `--sandbox` flag is
 *   emitted, so Cursor itself confines nothing in that run; what remains is the controller's worktree, the tool-call
 *   guard (ADR-0039), FR-GIT-03 and FR-GIT-06;
 * - the parser (T4.43) reads only the `stream-json` fields the 2026-10-14 live check recorded; a refused tool call is a
 *   `permission_denied` event because the final `result` still says `success`; resume is `--resume <id>` through the
 *   same matrix; a second `result`, a session id that changes mid-run or is not a safe argument, a tool call after the
 *   `result` and a credential source other than the login fail the run. The auth preflight (T4.44) keys on `isAuthenticated` of `status --format json`. The manifest range
 *   admits no version, so none of this runs before `adapters validate` passes a version.
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
  API_KEY_SOURCE_LOGIN,
  AUTH_STATUS_ARGS,
  AUTH_STATUS_KEY,
  AUTH_STATUS_TIMEOUT_MS,
  BACKING_PROVIDER_KEY,
  CURSOR_BINARY,
  CURSOR_LOGIN_COMMAND,
  EVENT,
  FORCE_FLAG,
  GIT_WRITE_CONTROL_DETAIL,
  HELP_FLAG,
  NON_PRIVILEGED_UNSUPPORTED_DETAIL,
  OUTPUT_FORMAT_FLAG,
  OUTPUT_STREAM_JSON,
  PRINT_FLAG,
  REQUIRED_HELP_FLAGS,
  RESUME_FLAG,
  SUBTYPE_COMPLETED,
  SUBTYPE_INIT,
  SUBTYPE_STARTED,
  SUBTYPE_SUCCESS,
  TOOL_KEYS,
  TOOL_RESULT_PERMISSION_DENIED,
  TOOL_RESULT_REJECTED,
  TRUST_FLAG,
  USAGE_KEYS,
  VERSION_ARGS,
} from "./protocol.js";

/**
 * Environment names passed through to Cursor (FR-EXE-07, NFR-SEC-02). Proposed: `PATH` for the binary and `HOME` so
 * the CLI finds its own native login. `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN` (credentials, ADR-0003), `CURSOR_CONFIG_DIR`
 * and `XDG_CONFIG_HOME` (would move the configuration the CLI reads and rewrites) stay out.
 */
export const CURSOR_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME"];

const PROBE_TIMEOUT_MS = 10_000;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_TARGET_CHARS = 512;
/** Native ids are passed as one argv element; refuse anything that could be read as a flag (Proposed). */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** FR-GIT-01 (ADR-0039): no per-run deny control is compiled; see protocol.ts. */
export const CURSOR_GIT_WRITE_CONTROL: GitWriteControl = {
  kind: "none-documented",
  detail: GIT_WRITE_CONTROL_DETAIL,
  remainingControls: ["FR-GIT-03", "FR-GIT-06"],
};

/** FR-GIT-09 (TDD §4.5 "Git writes and injected tools"): injecting a server needs `--approve-mcps` (bypass-class). */
export const CURSOR_GIT_CAPABILITIES: GitCapabilities = {
  commitChannel: "finalize-only",
  detail:
    "No per-run MCP definition is documented; a repository or controller MCP server loads only after a stored " +
    "approval or --approve-mcps (bypass-class), so no tool is injected. The controller commits at FINALIZING when " +
    "the project opts in (FR-GIT-09).",
};

/** Ineligible detail for a bypass approval on a profile other than `privileged` (FR-POL-03). */
export const CURSOR_BYPASS_OUTSIDE_PRIVILEGED =
  "bypassApproved is set on a profile other than privileged: a bypass applies only to an approved privileged scope " +
  "(FR-POL-03, ADR-0017)";
/** Ineligible detail for a `privileged` scope without `bypass`: no non-bypass cell is shown to hold (Q-65). */
export const CURSOR_PRIVILEGED_NEEDS_BYPASS =
  "privileged without bypass: Cursor compiles only an approved bypass scope until a read-only control, the sandbox " +
  "and repository-configuration isolation are shown to hold (Q-65, TDD §4.5.4)";
/** Ineligible detail for a scope that sets `bypass` on a run whose approval is missing (FR-POL-03). */
export const CURSOR_BYPASS_NOT_APPROVED =
  "privileged scope sets bypass but the run's bypassApproved is false: --force is compiled only for an approved " +
  "bypass run (FR-POL-03, ADR-0017)";

export interface CursorAdapterOptions {
  /** Absolute path of the cursor-agent binary. Defaults to the first executable `cursor-agent` on PATH, resolved once. */
  executable?: string;
  /** Test-only: arguments inserted between the executable and the flags (replay launcher). Empty in production. */
  launcherArgs?: readonly string[];
  timeouts?: Partial<Invocation["timeouts"]>;
  /** PATH used to resolve `cursor-agent` when `executable` is absent. Defaults to process.env.PATH. */
  pathEnv?: string;
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const ineligible = (reason: Ineligible["reason"], detail: string): Ineligible => ({ ineligible: true, reason, detail });
/** Own-key lookup, so a native key such as `constructor` or `__proto__` never resolves to an inherited member. */
const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;
/** Own-property lookup on a parsed object, ignoring any prototype members. */
const ownProp = (o: Json | undefined, key: string): unknown =>
  o !== undefined && Object.hasOwn(o, key) ? o[key] : undefined;
/** Parameter container fallback (args > parameters > input). */
const toolArgs = (entry: Json | undefined): Json | undefined =>
  obj(ownProp(entry, "args")) ?? obj(ownProp(entry, "parameters")) ?? obj(ownProp(entry, "input"));
/** Shell command parameter aliases: command > cmd > CommandLine. */
const toolCommand = (args: Json | undefined, kind: "read" | "edit" | "shell" | "other"): string | undefined =>
  kind === "shell"
    ? (str(ownProp(args, "command")) ?? str(ownProp(args, "cmd")) ?? str(ownProp(args, "CommandLine")))
    : undefined;
/** File target parameter aliases: path > filePath > file_path > AbsolutePath > target. */
const toolTarget = (args: Json | undefined, kind: "read" | "edit" | "shell" | "other"): string | undefined =>
  kind === "read" || kind === "edit"
    ? (str(ownProp(args, "path")) ??
      str(ownProp(args, "filePath")) ??
      str(ownProp(args, "file_path")) ??
      str(ownProp(args, "AbsolutePath")) ??
      str(ownProp(args, "target")))
    : undefined;
/** `result` lines already seen per run: a second one is a protocol anomaly, never a success (fail closed). */
const seenResults = new WeakMap<ParseState, number>();
/**
 * Track reported command and target keys per tool call (`call_id` or tool name) within a run's parse state,
 * so a later update (`completed`) reporting a swapped or newly provided command/path reaches the tool-call guard
 * without duplicating identical reports.
 */
const seenToolCalls = new WeakMap<ParseState, Map<string, Set<string>>>();
/** Category of a stream anomaly (two results, two session ids); classified OUTPUT_PROTOCOL_ERROR. */
const PROTOCOL_CATEGORY = "protocol";
const CATEGORY_CODES = { ...PROVIDER_ERROR_CATEGORY_CODES, [PROTOCOL_CATEGORY]: "OUTPUT_PROTOCOL_ERROR" } as const;

export class CursorAdapter implements ProviderAdapter {
  readonly id = "cursor" as const;
  readonly transports = ["subprocess-jsonl"] as const;
  readonly gitWriteControl = CURSOR_GIT_WRITE_CONTROL;
  /** TDD §4.10: `--resume <id>` resumed from a second directory ([LIVE] 8c), still `Unverified: T4.41`. */
  readonly resumeCwd = "unverified" as const;
  /**
   * T7.12 (FR-RTE-08, Q-90): init reports a display name, not a model id ([C2], [LIVE] 5b), and `compile` emits no
   * `--model` (a requested model is CAPABILITY_MISSING), so a remembered model is never pinned for Cursor.
   */
  readonly reportedModelFlag = {
    kind: "not_accepted",
    detail: "init reports a display name ([LIVE] 5b); --model is not emitted until the model registry has Cursor data",
  } as const;
  readonly gitCapabilities = CURSOR_GIT_CAPABILITIES;
  readonly #exe: string | undefined;
  readonly #launcher: readonly string[];
  readonly #timeouts: Invocation["timeouts"];

  constructor(opts: CursorAdapterOptions = {}) {
    this.#exe = opts.executable ?? resolveOnPath(CURSOR_BINARY, opts.pathEnv ?? process.env.PATH);
    this.#launcher = [...(opts.launcherArgs ?? [])];
    this.#timeouts = {
      wallClockMs: DEFAULT_WALL_CLOCK_MS,
      idleMs: DEFAULT_IDLE_MS,
      killGraceMs: DEFAULT_KILL_GRACE_MS,
      ...opts.timeouts,
    };
  }

  /**
   * FR-ADP-02 steps 1 to 5 with no model call: `cursor-agent --version`, then `--help` for the required flags. Output
   * is probe evidence only (FR-ADP-04). Step 7 (the structured-output smoke call) is not run here. The version string
   * `2026.10.12-d47ca18` ([LIVE] 1a) carries a commit hash parsed as build metadata (T4.48), allowing manifest ranges
   * to gate the version once `adapters validate` is run by an operator (ADR-0009).
   */
  async probe(runner: ProbeRunner): Promise<ProbeResult> {
    const exe = this.#exe;
    if (exe === undefined) {
      return {
        binaryPath: CURSOR_BINARY,
        binaryVersion: null,
        steps: [{ step: "binary", ok: false, detail: `${CURSOR_BINARY} not found on PATH` }],
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

    const help = await run(HELP_FLAG);
    const commandOk = help.spawnError === undefined && !help.timedOut && help.exitCode === 0;
    const flags = new Set(commandOk ? (help.stdout.match(/--[a-z][a-z0-9-]*/g) ?? []) : []);
    const missing = REQUIRED_HELP_FLAGS.filter((f) => !flags.has(f));
    steps.push(
      { step: "command", ok: commandOk, ...(commandOk ? {} : { detail: `\`${HELP_FLAG}\` unavailable` }) },
      {
        step: "output_format",
        ok: flags.has(OUTPUT_FORMAT_FLAG),
        ...(flags.has(OUTPUT_FORMAT_FLAG) ? {} : { detail: OUTPUT_FORMAT_FLAG }),
      },
      {
        step: "flags",
        ok: missing.length === 0,
        ...(missing.length ? { detail: `missing ${missing.join(" ")}` } : {}),
      },
    );
    return { binaryPath: exe, binaryVersion: version, steps };
  }

  /**
   * FR-AUTH-01/02 (T4.44): `cursor-agent status --format json`, keyed on `isAuthenticated` only (see protocol.ts). Never
   * reads a credential file, never starts a login, and never copies the status output (it holds account fields) into
   * the result.
   */
  async authPreflight(runner: ProbeRunner): Promise<AuthResult> {
    const exe = this.#exe;
    if (exe === undefined) return { state: "UNKNOWN", reason: `${CURSOR_BINARY} not found on PATH` };
    const r = await runner([exe, ...this.#launcher, ...AUTH_STATUS_ARGS], { timeoutMs: AUTH_STATUS_TIMEOUT_MS });
    const unknown = (why: string): AuthResult => ({
      state: "UNKNOWN",
      reason: `\`${CURSOR_BINARY} ${AUTH_STATUS_ARGS.join(" ")}\` gave no login state (${why})`,
    });
    if (r.spawnError !== undefined) return unknown("could not start");
    if (r.timedOut) return unknown("timed out");
    if (r.exitCode !== 0) return unknown(`exit ${r.exitCode}`);
    let doc: unknown;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      return unknown("output is not JSON");
    }
    const flag = obj(doc)?.[AUTH_STATUS_KEY];
    if (flag === true) return { state: "OK" };
    if (flag === false) return { state: "AUTH_REQUIRED", loginCommand: CURSOR_LOGIN_COMMAND };
    return unknown(`no boolean ${AUTH_STATUS_KEY}`);
  }

  compile(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    return this.#build(request, profile, []);
  }

  /**
   * FR-SES-03 (T4.43): `--resume <id>` through the same matrix, the id taken from structured output only ([LIVE] 8a to
   * 8c: the same `session_id` comes back). The follow-up prompt goes on stdin as for a first run (Assumption: [LIVE] 8a
   * passed it as an argument). `--continue` is never used: it names no chat.
   */
  resumeArgs(binding: NativeBinding, request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== "cursor") return ineligible("CAPABILITY_MISSING", `binding is for ${binding.provider}`);
    if (!SESSION_ID_RE.test(binding.nativeSessionId)) {
      return ineligible("CAPABILITY_MISSING", "native session id is not a safe single argument");
    }
    return this.#build(request, profile, [RESUME_FLAG, binding.nativeSessionId]);
  }

  /**
   * Pure. Order of checks (the first unmet one is the reason):
   * 0. shell allowlist entries that could write Git: PROFILE_UNSUPPORTED (FR-GIT-01);
   * 1. a bypass approval on a profile other than `privileged`: PROFILE_UNSUPPORTED (FR-POL-03);
   * 2. any profile other than `privileged`: PROFILE_UNSUPPORTED ({@link NON_PRIVILEGED_UNSUPPORTED_DETAIL});
   * 3. `privileged`: no scope binding, or `bypass: false`: PROFILE_UNSUPPORTED; `bypass: true` without an approval:
   *    PROFILE_UNSUPPORTED (FR-POL-03);
   * 4. read-only files (scope or workspace): CAPABILITY_MISSING (edits apply without `--force`, [LIVE] 7b, and no
   *    sandbox is compiled);
   * 5. shell other than `broad`: CAPABILITY_MISSING (no per-run permission flag, [C6]; `--force` runs every command);
   * 6. network other than `on`: CAPABILITY_MISSING (no per-run network control on `--print`, [C1]; the sandbox is not
   *    compiled);
   * 7. repository_config `disabled` or `approved`: CAPABILITY_MISSING (`--trust`, needed to start, loads the
   *    repository's `AGENTS.md` and rules, [LIVE] 10c; no per-item approval); only `enabled` compiles (owner decision
   *    26, Q-37);
   * 8. a requested model: CAPABILITY_MISSING (the model registry has no Cursor data yet, T4.5; `--model` is not emitted).
   */
  #build(request: CompileRequest, profile: ResolvedProfile, tail: string[]): Invocation | Ineligible {
    const allowlist = profile.shellAllowlist ?? [];
    const gitWrites = gitWriteRisks(allowlist);
    if (gitWrites.length > 0) {
      return ineligible(
        "PROFILE_UNSUPPORTED",
        `shell allowlist entries could write Git (FR-GIT-01): ${gitWrites.map((g) => g.command).join("; ")}`,
      );
    }
    if (profile.name !== "privileged") {
      if (profile.bypassApproved || request.bypassApproved === true) {
        return ineligible("PROFILE_UNSUPPORTED", CURSOR_BYPASS_OUTSIDE_PRIVILEGED);
      }
      return ineligible("PROFILE_UNSUPPORTED", `${profile.name}: ${NON_PRIVILEGED_UNSUPPORTED_DETAIL}`);
    }
    const scope = profile.privilegedScope?.scope;
    if (scope === undefined) {
      return ineligible("PROFILE_UNSUPPORTED", "privileged without an approved scope binding (LLD §3.1)");
    }
    if (!scope.bypass) return ineligible("PROFILE_UNSUPPORTED", CURSOR_PRIVILEGED_NEEDS_BYPASS);
    if (!(profile.bypassApproved || request.bypassApproved === true)) {
      return ineligible("PROFILE_UNSUPPORTED", CURSOR_BYPASS_NOT_APPROVED);
    }
    if (scope.files.access === "read-only" || !request.workspace.writable) {
      return ineligible(
        "CAPABILITY_MISSING",
        "privileged read-only files: Cursor applies edits without --force ([LIVE] 7b) and no sandbox is compiled, so " +
          "nothing keeps the run read-only (Q-65)",
      );
    }
    if (scope.shell.mode !== "broad") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged shell=${scope.shell.mode} with bypass: --force runs every command and no per-run permission ` +
          "flag is documented ([C6])",
      );
    }
    if (scope.network.mode !== "on") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged network=${scope.network.mode}: no per-run network control on --print ([C1]) and the sandbox is ` +
          "not compiled (Q-79)",
      );
    }
    if (scope.repository_config.mode !== "enabled") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged repository_config=${scope.repository_config.mode}: --trust, which a headless run needs to start, ` +
          "loads the repository's AGENTS.md and rules ([LIVE] 10c) and the CLI has no per-item approval; owner " +
          "decision 26 (Q-37) allows `enabled` in an approved bypass run",
      );
    }
    if (request.model !== undefined) {
      return ineligible("CAPABILITY_MISSING", "no model registry data for Cursor yet (T4.5; --model is not emitted)");
    }
    if (this.#exe === undefined) return ineligible("CAPABILITY_MISSING", `${CURSOR_BINARY} not found on PATH`);

    const policyFlags = [TRUST_FLAG, FORCE_FLAG];
    return {
      transport: "subprocess-jsonl",
      argv: [this.#exe, ...this.#launcher, PRINT_FLAG, OUTPUT_FORMAT_FLAG, OUTPUT_STREAM_JSON, ...policyFlags, ...tail],
      env: {},
      envAllowlist: [...CURSOR_ENV_ALLOWLIST],
      cwd: request.workspace.cwd,
      // [LIVE] 6a: with no positional argument the piped text is the prompt.
      stdin: { kind: "text", value: request.objective },
      outputFormat: "jsonl",
      timeouts: { ...this.#timeouts },
      policyFlags,
      expectedExitCodes: [0],
      maxLineBytes: DEFAULT_MAX_LINE_BYTES,
    };
  }

  /**
   * One `stream-json` line -> normalized events (T4.43). Structured fields only (FR-ADP-04): the session id is read from
   * `session_id` of the `system`/`init` line (or of `result` when no `init` came first) and nowhere else. A line whose
   * type or shape is not recognised is an `unknown` event and never a result. A refused tool call ([LIVE] 7a, 11) is a
   * `permission_denied` event, because the final `result` still says `success` and the exit code is 0 (Q-65).
   */
  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[] {
    if (typeof input !== "string") return []; // no ACP transport for Cursor (TDD §4.5.2)
    state.lines += 1;
    let doc: unknown;
    try {
      doc = JSON.parse(input);
    } catch {
      return []; // the supervisor ends the run OUTPUT_PROTOCOL_ERROR on unparseable framing
    }
    const e = obj(doc);
    const type = str(ownProp(e, "type"));
    if (e === undefined || type === undefined) return this.#unknown(state, "none");
    const subtype = str(ownProp(e, "subtype"));
    switch (type) {
      case EVENT.user:
      case EVENT.thinking:
        return [];
      case EVENT.system: {
        if (subtype !== SUBTYPE_INIT) return this.#unknown(state, `${type}:${subtype ?? "none"}`);
        // `model` is a display name ([C2], [LIVE] 5b). No backing vendor was observed in native output ([LIVE] 102),
        // so none is invented from the display name (TDD §4.5). If structured output reports a backing provider
        // (T4.6: harness fronting another provider), it is bound as a plain string.
        const rawBacking = ownProp(e, BACKING_PROVIDER_KEY) ?? ownProp(e, "backingProvider");
        const backingProvider = str(rawBacking);
        const out = this.#bind(state, str(ownProp(e, "session_id")), str(ownProp(e, "model")), backingProvider);
        // `apiKeySource` was the string `login` on every run ([LIVE] 5b). Another string, or a present value that is
        // not a string, is not the native login: the run fails closed rather than ignoring an unexpected shape.
        const rawSource = ownProp(e, "apiKeySource");
        const source = str(rawSource);
        if (rawSource !== undefined && source !== API_KEY_SOURCE_LOGIN) {
          const shown = source === undefined ? "(not a string)" : clip(source, 32);
          out.push({
            kind: "provider_error",
            category: "auth",
            message: `credential source ${shown} is not the native login; run \`${CURSOR_LOGIN_COMMAND}\``,
          });
        }
        return out;
      }
      case EVENT.assistant: {
        const message = obj(ownProp(e, "message"));
        const content = ownProp(message, "content");
        if (!Array.isArray(content)) return this.#unknown(state, type);
        const text = content.map((c) => str(ownProp(obj(c), "text")) ?? "").join("");
        return text === "" ? [] : [{ kind: "message", role: "assistant", text: clip(text, MAX_SUMMARY_CHARS) }];
      }
      case EVENT.toolCall:
        return this.#toolCall(e, subtype, state);
      case EVENT.result: {
        if (subtype === undefined) return this.#unknown(state, type);
        const results = (seenResults.get(state) ?? 0) + 1;
        seenResults.set(state, results);
        const out: NormalizedEvent[] = [];
        // One run prints one `result` ([LIVE] 5a, 5b); a second could flip an earlier failure, so the run fails closed.
        if (results > 1) {
          out.push({ kind: "provider_error", category: PROTOCOL_CATEGORY, message: "more than one result line" });
        }
        const rawBacking = ownProp(e, BACKING_PROVIDER_KEY) ?? ownProp(e, "backingProvider");
        out.push(...this.#bind(state, str(ownProp(e, "session_id")), undefined, str(rawBacking)));
        // Only finite, non-negative counters under the recorded keys are kept ([LIVE] 5a); anything else is dropped.
        const usage = obj(ownProp(e, "usage"));
        const metrics: Record<string, number | string | null> = {};
        for (const k of USAGE_KEYS) {
          const v = ownProp(usage, k);
          if (typeof v === "number" && Number.isFinite(v) && v >= 0) metrics[k] = v;
        }
        if (Object.keys(metrics).length > 0) out.push({ kind: "usage", source: "provider_reported", metrics });
        const ok = results === 1 && subtype === SUBTYPE_SUCCESS && ownProp(e, "is_error") === false;
        out.push({ kind: "result", ok, ...(ok ? {} : { summary: `result ${clip(subtype, 64)}` }) });
        return out;
      }
      default:
        return this.#unknown(state, type);
    }
  }

  /**
   * The first non-empty session id binds the session. A later, different id (a second `init` or a `result` for another
   * session) makes the binding ambiguous, so the run fails closed; the first id stays bound. An id resume could not pass
   * as one safe argument is never bound and fails the run (Proposed, fail closed).
   */
  #bind(
    state: ParseState,
    id: string | undefined,
    model: string | undefined,
    backingProvider?: string | undefined,
  ): NormalizedEvent[] {
    if (id === undefined || id === "") return [];
    if (!SESSION_ID_RE.test(id)) {
      return [{ kind: "provider_error", category: PROTOCOL_CATEGORY, message: "session id is not a safe argument" }];
    }
    if (state.nativeSessionId !== undefined) {
      if (id === state.nativeSessionId) return [];
      return [{ kind: "provider_error", category: PROTOCOL_CATEGORY, message: "session id changed mid-run" }];
    }
    state.nativeSessionId = id;
    return [
      {
        kind: "session_bound",
        nativeSessionId: id,
        ...(model ? { model: clip(model, 128) } : {}),
        ...(backingProvider ? { backingProvider: clip(backingProvider, 128) } : {}),
      },
    ];
  }

  /**
   * `tool_call` started: a `tool_call` event (command or path transient for the guard); completed: denial, plus any
   * newly provided or swapped command/path not reported in started (so an update cannot swap a reported command for an
   * unchecked one). The object held one key in every recorded line ([LIVE] 7a, 7b, 11); should it hold several, each is
   * reported, so a decoy first key cannot hide a shell call from the guard or a refusal from the result.
   */
  #toolCall(e: Json, subtype: string | undefined, state: ParseState): NormalizedEvent[] {
    const call = obj(ownProp(e, "tool_call"));
    const keys = call ? Object.keys(call) : [];
    if (call === undefined || keys.length === 0) return this.#unknown(state, `tool_call:${subtype ?? "none"}`);
    const callId = str(ownProp(e, "call_id"));
    let seen = seenToolCalls.get(state);
    if (seen === undefined) {
      seen = new Map();
      seenToolCalls.set(state, seen);
    }
    if (subtype === SUBTYPE_STARTED) {
      return keys.map((key): NormalizedEvent => {
        const kind = own(TOOL_KEYS, key) ?? "other";
        const entry = obj(ownProp(call, key));
        const args = toolArgs(entry);
        const command = toolCommand(args, kind);
        const target = toolTarget(args, kind);
        const stepId = callId ? `${callId}:${key}` : key;
        const paramKey =
          command !== undefined ? `command:${command}` : target !== undefined ? `target:${target}` : undefined;
        if (paramKey !== undefined) {
          const reported = seen.get(stepId);
          if (reported === undefined) seen.set(stepId, new Set([paramKey]));
          else reported.add(paramKey);
        }
        return {
          kind: "tool_call",
          tool: kind,
          name: clip(key, 64),
          ...(command !== undefined ? { command } : {}),
          ...(target !== undefined ? { target: clip(target, MAX_TARGET_CHARS) } : {}),
        };
      });
    }
    if (subtype === SUBTYPE_COMPLETED) {
      const out: NormalizedEvent[] = [];
      for (const key of keys) {
        const kind = own(TOOL_KEYS, key) ?? "other";
        const entry = obj(ownProp(call, key));
        const args = toolArgs(entry);
        const command = toolCommand(args, kind);
        const target = toolTarget(args, kind);
        const stepId = callId ? `${callId}:${key}` : key;
        const paramKey =
          command !== undefined ? `command:${command}` : target !== undefined ? `target:${target}` : undefined;
        if (paramKey !== undefined) {
          const reported = seen.get(stepId);
          if (reported === undefined) {
            seen.set(stepId, new Set([paramKey]));
            out.push({
              kind: "tool_call",
              tool: kind,
              name: clip(key, 64),
              ...(command !== undefined ? { command } : {}),
              ...(target !== undefined ? { target: clip(target, MAX_TARGET_CHARS) } : {}),
            });
          } else if (!reported.has(paramKey)) {
            reported.add(paramKey);
            out.push({
              kind: "tool_call",
              tool: kind,
              name: clip(key, 64),
              ...(command !== undefined ? { command } : {}),
              ...(target !== undefined ? { target: clip(target, MAX_TARGET_CHARS) } : {}),
            });
          }
        }
        const result = obj(ownProp(entry, "result"));
        const denied =
          result !== undefined &&
          (Object.hasOwn(result, TOOL_RESULT_REJECTED) || Object.hasOwn(result, TOOL_RESULT_PERMISSION_DENIED));
        if (denied) {
          out.push({ kind: "permission_denied", tool: clip(key, 64) });
        }
      }
      return out;
    }
    return this.#unknown(state, `tool_call:${subtype ?? "none"}`);
  }

  #unknown(state: ParseState, rawType: string): NormalizedEvent[] {
    state.unknownEvents += 1;
    return [{ kind: "unknown", rawType: clip(rawType, 64) }];
  }

  /**
   * Success needs a clean expected exit and a final `result` with `ok` and no `provider_error`, `permission_denied`,
   * `sandbox_violation` or `rate_limit` event and no `tool_call` the tool-call guard flagged with a `violation` (fail
   * closed, as Grok Build; a guard verdict ends the run in every run, bypass included, ADR-0039), and no `tool_call`
   * after the `result` line. The summary is the joined assistant text, last {@link MAX_SUMMARY_CHARS} characters. A
   * failed run prints no stream at all ([LIVE] 4, 14), so it ends `TOOL_FAILURE` on its exit code; the stderr text is
   * not read (the adapter contract passes none).
   */
  extractResult(events: readonly NormalizedEvent[], exit: ExitInfo): RunResult {
    const unknownEventCount = events.filter((e) => e.kind === "unknown").length;
    const bound = events.find((e) => e.kind === "session_bound");
    const nativeSessionId = bound?.kind === "session_bound" ? bound.nativeSessionId : undefined;
    const text = events.flatMap((e) => (e.kind === "message" ? [e.text] : [])).join("\n");
    const summary = text === "" ? undefined : text.slice(-MAX_SUMMARY_CHARS);
    const finalAt = events.findLastIndex((e) => e.kind === "result");
    const final = events[finalAt];
    // Proposed (fail closed): `result` was the last line of every recorded run ([LIVE] 5a, 5b), so a tool call after it
    // means the run did not end on that result. A `tool_call` line the parser could not read counts too: an unreadable
    // or bare `tool_call` line parses as `unknown` and must not leave the turn clean (as Grok Build and OpenCode).
    const trailingTool =
      finalAt >= 0 &&
      events
        .slice(finalAt + 1)
        .some(
          (e) =>
            e.kind === "tool_call" ||
            (e.kind === "unknown" && (e.rawType === EVENT.toolCall || e.rawType.startsWith(`${EVENT.toolCall}:`))),
        );
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
      !trailingTool &&
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
    const detail = trailingTool && c.code === "OUTPUT_PROTOCOL_ERROR" ? "tool call after the result line" : c.detail;
    return { ok: false, failureCode: c.code, failureDetail: detail, ...base };
  }

  classifyFailure(evidence: FailureEvidence): FailureClassification {
    return classifyCommon(evidence, CATEGORY_CODES);
  }
}
