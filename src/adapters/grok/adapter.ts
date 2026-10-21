/**
 * Grok Build adapter (T4.22, TDD §4.3; module, probe, compile matrix and registry entry; Delegated, not
 * owner-approved). Native surface: one process per run, `grok --single=<prompt> --output-format streaming-json`
 * (TDD §4.3.1 "Transport decision"). The adapter never reads Grok credential or configuration files, never runs
 * login, never writes provider configuration, never emits `--trust`, `-w`/`--worktree` or `--fork-session`, and emits
 * the one bypass flag below only for an approved `privileged` scope that sets `bypass` (FR-POL-03, ADR-0017).
 *
 * Compile matrix (Proposed, fail closed; every cell below is a Delegated decision from the 2026-10-14 live check,
 * TDD §4.3.3):
 * - the four non-`privileged` profiles are `Ineligible: PROFILE_UNSUPPORTED`: `dontAsk` was not shown to deny, deny
 *   rules are prefix matches and the native login is readable from inside the sandbox, so none of the controls a
 *   profile needs is shown to hold (FR-POL-02, FR-POL-06);
 * - `privileged` compiles only when its scope sets `bypass` and the run is approved (owner decision 46: the bypass
 *   cell does not wait for Git-write denial to be shown to hold). Sandbox profile and permission mode are compiled
 *   together, never one without the other ([R2] L613 to L615): `--always-approve` always with `--sandbox`. Since
 *   ADR-0077 (owner ruling 2026-10-20) the worktree-files bypass cell is not confined to its worktree: it compiles
 *   `--sandbox off`; read-only files keep `--sandbox read-only`;
 * - the parser reads the `streaming-json` fields the 2026-10-14 live check recorded (T4.23): `tool_call` lines with
 *   synthetic fields are parsed and guarded (ADR-0039, T4.27), while unrecorded tool lines are `unknown` events;
 *   resume is `-r <id>` through the same matrix; a second `end`, a session id that changes mid-run or is not a safe
 *   argument and a tool call after the `end` line fail the run. The auth preflight keys on the first line of
 *   `grok models` (T4.24). The manifest range admits no version, so none of this
 *   runs before `adapters validate` passes a version.
 */

import {
  DEFAULT_IDLE_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_WALL_CLOCK_MS,
} from "../../exec/index.js";
import { MODEL_ID_PATTERN } from "../../models/registry.js";
import { resolveOnPath } from "../codex/adapter.js";
import { classifyCommon, PROVIDER_ERROR_CATEGORY_CODES } from "../failure.js";
import { gitWriteRisks } from "../git-write.js";
import { parseVersion } from "../manifest/index.js";
import { renderObjective } from "../prompt.js";
import type { ProviderUsageResult } from "../provider-usage.js";
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
  SkillDelivery,
} from "../types.js";
import {
  ALWAYS_APPROVE_FLAG,
  AUTH_LOGGED_IN_PREFIX,
  AUTH_LOGGED_OUT_PREFIX,
  AUTH_STATUS_ARGS,
  AUTH_STATUS_LINE_MAX,
  AUTH_STATUS_TIMEOUT_MS,
  ERROR_MODEL_PREFIX,
  ERROR_NOT_SIGNED_IN_PREFIX,
  EVENT,
  GIT_WRITE_CONTROL_DETAIL,
  GROK_BINARY,
  GROK_LOGIN_COMMAND,
  HELP_FLAG,
  MODEL_FLAG,
  NO_AUTO_UPDATE_FLAG,
  NON_PRIVILEGED_UNSUPPORTED_DETAIL,
  OUTPUT_FORMAT_FLAG,
  OUTPUT_STREAMING_JSON,
  REQUIRED_HELP_FLAGS,
  RESUME_SHORT_FLAG,
  SANDBOX_FLAG,
  SANDBOX_OFF,
  SANDBOX_READ_ONLY,
  SINGLE_FLAG,
  STOP_REASON_END_TURN,
  USAGE_KEYS,
  VERSION_ARGS,
} from "./protocol.js";
import {
  GROK_USAGE_ARGS,
  GROK_USAGE_METHOD,
  GROK_USAGE_STDIN,
  GROK_USAGE_TIMEOUT_MS,
  grokUsageFromStdout,
  isGrokUsageAnswer,
} from "./usage.js";

/**
 * Environment names passed through to Grok Build (FR-EXE-07, NFR-SEC-02). Proposed: `PATH` for the binary and `HOME`
 * so the CLI finds its own native login. `GROK_HOME` (would hide the login), `XAI_API_KEY` and `GROK_SANDBOX` stay out
 * (ADR-0003; the sandbox is a flag so the audit sees it).
 */
export const GROK_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME"];

const PROBE_TIMEOUT_MS = 10_000;
/** A model id passed as one argv word (the registry's `MODEL_ID_PATTERN` shape; never read as a flag). */
const MODEL_ID_RE = new RegExp(MODEL_ID_PATTERN);
const MAX_SUMMARY_CHARS = 2_000;
const MAX_TARGET_CHARS = 512;
/** Native ids are passed as one argv element; refuse anything that could be read as a flag (Proposed). */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const AUTH_UNKNOWN_REASON = "`grok models` first line is not a recognised login state";

/** FR-GIT-01 (ADR-0039): deny rules are prefix matches, so no declared control; see protocol.ts. */
export const GROK_GIT_WRITE_CONTROL: GitWriteControl = {
  kind: "none-documented",
  detail: GIT_WRITE_CONTROL_DETAIL,
  remainingControls: ["FR-GIT-03", "FR-GIT-06"],
};

/** FR-GIT-09 (TDD §4.3.1 "Per-run MCP"): no per-run MCP definition flag exists in headless mode ([LIVE] step 12). */
export const GROK_GIT_CAPABILITIES: GitCapabilities = {
  commitChannel: "finalize-only",
  detail:
    "No per-run MCP definition flag in headless mode (CLI version 1.0.50 help; ACP `session/new` `mcpServers` is the only " +
    "documented route and is not used). The controller commits at FINALIZING when the project opts in (FR-GIT-09).",
};

/** Ineligible detail for a bypass approval on a profile other than `privileged` (FR-POL-03). */
export const GROK_BYPASS_OUTSIDE_PRIVILEGED =
  "bypassApproved is set on a profile other than privileged: a bypass applies only to an approved privileged scope " +
  "(FR-POL-03, ADR-0017)";
/** Ineligible detail for a `privileged` scope without `bypass`: no non-bypass cell is shown to hold (TDD §4.3.3). */
export const GROK_PRIVILEGED_NEEDS_BYPASS =
  "privileged without bypass: Grok Build compiles only an approved bypass scope until its permission mode, deny " +
  "rules and sandbox are shown to hold together (TDD §4.3.3, Q-62)";
/** Ineligible detail for a scope that sets `bypass` on a run whose approval is missing (FR-POL-03). */
export const GROK_BYPASS_NOT_APPROVED =
  "privileged scope sets bypass but the run's bypassApproved is false: --always-approve is compiled only for an " +
  "approved bypass run (FR-POL-03, ADR-0017)";

export interface GrokAdapterOptions {
  /** Absolute path of the grok binary. Defaults to the first executable `grok` on PATH, resolved once. */
  executable?: string;
  /** Test-only: arguments inserted between the executable and the flags (replay launcher). Empty in production. */
  launcherArgs?: readonly string[];
  timeouts?: Partial<Invocation["timeouts"]>;
  /** PATH used to resolve `grok` when `executable` is absent. Defaults to process.env.PATH. */
  pathEnv?: string;
}

function ownProp(record: Record<string, unknown> | undefined, key: string): unknown {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}
type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const ineligible = (reason: Ineligible["reason"], detail: string): Ineligible => ({ ineligible: true, reason, detail });
/** `end` lines already seen per run: a second one is a protocol anomaly, never a success (fail closed, as Antigravity). */
const seenEnds = new WeakMap<ParseState, number>();
/**
 * Reported parameter keys per tool call, so a late or swapped command in `tool_call_update` emits a tool_call event for
 * the ADR-0039 guard without duplicating identical reports (mirrors Antigravity T4.33 and Cursor T4.43). `shellCalls`
 * holds the keys of calls already reported as `shell`.
 */
const seenToolCalls = new WeakMap<
  ParseState,
  { counter: number; calls: Map<string, Set<string>>; shellCalls: Set<string> }
>();
/** Category of a stream anomaly (two `end` lines, two session ids); classified OUTPUT_PROTOCOL_ERROR. */
const PROTOCOL_CATEGORY = "protocol";
const CATEGORY_CODES = { ...PROVIDER_ERROR_CATEGORY_CODES, [PROTOCOL_CATEGORY]: "OUTPUT_PROTOCOL_ERROR" } as const;

export class GrokAdapter implements ProviderAdapter {
  readonly id = "grok" as const;
  readonly transports = ["subprocess-jsonl"] as const;
  readonly gitWriteControl = GROK_GIT_WRITE_CONTROL;
  /** TDD §4.10: `-r <id>` resumed from a second directory ([LIVE] 14a), still `Unverified: T5.12`. */
  readonly resumeCwd = "unverified" as const;
  /** ADR-0077: a requested model reaches the CLI only in the approved bypass cell. */
  readonly requestedModelFlag = {
    cells: "bypass",
    detail: "--model <id> in the approved bypass cells (ADR-0077; grok --help: -m, --model)",
  } as const;
  readonly gitCapabilities = GROK_GIT_CAPABILITIES;
  readonly #exe: string | undefined;
  readonly #launcher: readonly string[];
  readonly #timeouts: Invocation["timeouts"];

  constructor(opts: GrokAdapterOptions = {}) {
    this.#exe = opts.executable ?? resolveOnPath(GROK_BINARY, opts.pathEnv ?? process.env.PATH);
    this.#launcher = [...(opts.launcherArgs ?? [])];
    this.#timeouts = {
      wallClockMs: DEFAULT_WALL_CLOCK_MS,
      idleMs: DEFAULT_IDLE_MS,
      killGraceMs: DEFAULT_KILL_GRACE_MS,
      ...opts.timeouts,
    };
  }

  /**
   * FR-ADP-02 steps 1 to 5 with no model call: `grok version`, then `grok --help` for the required flags. Output is
   * probe evidence only (FR-ADP-04). Step 7 (the structured-output smoke call) is not run here.
   */
  async probe(runner: ProbeRunner): Promise<ProbeResult> {
    const exe = this.#exe;
    if (exe === undefined) {
      return {
        binaryPath: GROK_BINARY,
        binaryVersion: null,
        steps: [{ step: "binary", ok: false, detail: `${GROK_BINARY} not found on PATH` }],
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
   * FR-AUTH-02 via `grok models` (T4.24, Q-10; observed on CLI version 1.0.50, TDD §4.3.3): the exit code is 0 whether logged
   * in or not, so the first stdout line decides, and only the two observed phrases do (see protocol.ts). A line that
   * starts with `You are logged in` is OK, `You are not authenticated` is AUTH_REQUIRED naming the native login; any
   * other first line, a non-zero exit, a timeout or a spawn failure is UNKNOWN (ineligible, NFR-SEC-06). The output is
   * never stored; at most its first line, filtered and truncated, appears in an UNKNOWN reason. The command lists
   * model names and makes no model call. It never reads `~/.grok` and never starts a login.
   */
  async authPreflight(runner: ProbeRunner): Promise<AuthResult> {
    const exe = this.#exe;
    if (exe === undefined) return { state: "UNKNOWN", reason: `${GROK_BINARY} not found on PATH` };
    const r = await runner([exe, ...this.#launcher, ...AUTH_STATUS_ARGS], { timeoutMs: AUTH_STATUS_TIMEOUT_MS });
    if (r.spawnError !== undefined) return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (${r.spawnError})` };
    if (r.timedOut) return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (timed out)` };
    const first = (r.stdout.split("\n").find((l) => l.trim() !== "") ?? "").trim();
    if (r.exitCode === 0) {
      if (first.startsWith(AUTH_LOGGED_IN_PREFIX)) return { state: "OK" };
      if (first.startsWith(AUTH_LOGGED_OUT_PREFIX)) return { state: "AUTH_REQUIRED", loginCommand: GROK_LOGIN_COMMAND };
    }
    const line = Array.from(first)
      .filter((c) => c >= " " && c !== "\x7f")
      .join("")
      .slice(0, AUTH_STATUS_LINE_MAX);
    return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (exit ${r.exitCode}${line ? `: ${line}` : ""})` };
  }

  /**
   * Provider-reported usage (ADR-0079, ADR-0083, FR-CAP-13): `grok agent --no-leader stdio` `_x.ai/billing`
   * (./usage.ts). No model call; the CLI uses its own login and Switchboard reads no file. A spawn failure, timeout
   * or missing answer is `unknown`, never headroom (BR-50).
   */
  async readProviderUsage(runner: ProbeRunner, now: Date = new Date()): Promise<ProviderUsageResult> {
    const at = now.toISOString();
    const unknown = (error: string): ProviderUsageResult => ({
      provider: "grok",
      source: "unknown",
      observed_at: at,
      method: GROK_USAGE_METHOD,
      error,
    });
    const exe = this.#exe;
    if (exe === undefined) return unknown(`${GROK_BINARY} not found on PATH`);
    const r = await runner([exe, ...this.#launcher, ...GROK_USAGE_ARGS], {
      timeoutMs: GROK_USAGE_TIMEOUT_MS,
      stdinText: GROK_USAGE_STDIN,
      holdStdinUntil: isGrokUsageAnswer,
    });
    if (r.spawnError !== undefined) return unknown(`could not start ${GROK_BINARY} agent (${r.spawnError})`);
    const read = grokUsageFromStdout(r.stdout, at);
    if (read.source === "unknown" && r.timedOut) return unknown("grok agent timed out before answering");
    return read;
  }

  /**
   * T16.7 (TDD §3.16.1, LLD §19.6, ADR-0056 items 5, 6 and 8): every cell delivers skills as the prompt prefix. A cell
   * may name `native` only with the evidence id of a T16.8 live check; the conformance suite fails one without it.
   */
  skillDelivery(): SkillDelivery {
    return "prompt_prefix";
  }

  compile(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    return this.#build(request, profile, []);
  }

  /**
   * FR-SES-03: `-r <id>` with the stored native id ([LIVE] 6a, 14a: same `sessionId` back, not tied to the working
   * directory), compiled by the same matrix as a first run (so the same Ineligible reasons and flags). A binding of
   * another provider, or an id that could be read as a flag, is never compiled. Whether a resumed run keeps its
   * permission mode without the flag is `Unverified: T5.12`, so every policy flag is passed again.
   */
  resumeArgs(binding: NativeBinding, request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== "grok") return ineligible("CAPABILITY_MISSING", `binding is for ${binding.provider}`);
    if (!SESSION_ID_RE.test(binding.nativeSessionId)) {
      return ineligible("CAPABILITY_MISSING", "native session id is not a safe single argument");
    }
    return this.#build(request, profile, [RESUME_SHORT_FLAG, binding.nativeSessionId]);
  }

  /**
   * Pure. Order of checks (the first unmet one is the reason):
   * 0. shell allowlist entries that could write Git: PROFILE_UNSUPPORTED (FR-GIT-01);
   * 1. a bypass approval on a profile other than `privileged`: PROFILE_UNSUPPORTED (FR-POL-03);
   * 2. any profile other than `privileged`: PROFILE_UNSUPPORTED ({@link NON_PRIVILEGED_UNSUPPORTED_DETAIL});
   * 3. `privileged`: no scope binding, or `bypass: false`: PROFILE_UNSUPPORTED; `bypass: true` without an approval:
   *    PROFILE_UNSUPPORTED (FR-POL-03);
   * 4. shell other than `broad`: CAPABILITY_MISSING (under `--always-approve` an allow list is moot and `none` cannot
   *    be enforced: the tool names for `--disallowed-tools` were not exercised);
   * 5. network `allowlist`: CAPABILITY_MISSING (no per-domain control, R-36); with read-only files, network must be
   *    `off` (the `read-only` profile blocks child network on Linux only, [SBX], so `on` cannot be guaranteed);
   * 6. repository_config `disabled` or `approved`: CAPABILITY_MISSING (project sources were not shown inert without
   *    trust, and the CLI has no per-item approval); only `enabled` compiles (owner decision 26, Q-37);
   * 7. worktree files with network `off`: CAPABILITY_MISSING (ADR-0077: the cell is `--sandbox off`, which keeps no
   *    child network off);
   * 8. a requested model that is not a plain id: CAPABILITY_MISSING; otherwise it is `--model <id>`.
   * Then the sandbox profile: read-only files or workspace `read-only` (with `--disable-web-search`, network `off`);
   * worktree files `off` (ADR-0077: bypass is not confined to the worktree).
   */
  #build(request: CompileRequest, profile: ResolvedProfile, tail: string[]): Invocation | Ineligible {
    const gitWrites = gitWriteRisks(profile.shellAllowlist ?? []);
    if (gitWrites.length > 0) {
      return ineligible(
        "PROFILE_UNSUPPORTED",
        `shell allowlist entries could write Git (FR-GIT-01): ${gitWrites.map((g) => g.command).join("; ")}`,
      );
    }
    if (profile.name !== "privileged") {
      if (profile.bypassApproved || request.bypassApproved === true) {
        return ineligible("PROFILE_UNSUPPORTED", GROK_BYPASS_OUTSIDE_PRIVILEGED);
      }
      return ineligible("PROFILE_UNSUPPORTED", `${profile.name}: ${NON_PRIVILEGED_UNSUPPORTED_DETAIL}`);
    }
    const scope = profile.privilegedScope?.scope;
    if (scope === undefined) {
      return ineligible("PROFILE_UNSUPPORTED", "privileged without an approved scope binding (LLD §3.1)");
    }
    if (!scope.bypass) return ineligible("PROFILE_UNSUPPORTED", GROK_PRIVILEGED_NEEDS_BYPASS);
    if (!(profile.bypassApproved || request.bypassApproved === true)) {
      return ineligible("PROFILE_UNSUPPORTED", GROK_BYPASS_NOT_APPROVED);
    }
    if (scope.shell.mode !== "broad") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged shell=${scope.shell.mode} with bypass: --always-approve approves every tool call, so an allow ` +
          "list is moot, and no tool-removal flag was exercised (TDD §4.3.3)",
      );
    }
    const readOnly = scope.files.access === "read-only" || !request.workspace.writable;
    const network = scope.network.mode;
    if (network === "allowlist") {
      return ineligible("CAPABILITY_MISSING", "privileged network=allowlist: no documented Grok Build control (R-36)");
    }
    if (readOnly && network !== "off") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged read-only files with network=${network}: the read-only profile blocks child network on Linux only ([SBX])`,
      );
    }
    if (scope.repository_config.mode !== "enabled") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged repository_config=${scope.repository_config.mode}: project hooks, MCP servers and rules were not ` +
          "shown inert without trust and the CLI has no per-item approval; owner decision 26 (Q-37) allows `enabled` " +
          "in an approved bypass run",
      );
    }
    if (!readOnly && network === "off") {
      return ineligible(
        "CAPABILITY_MISSING",
        "privileged worktree files with network=off and bypass: the bypass cell is --sandbox off (ADR-0077, not " +
          "confined to the worktree), which keeps no child network off",
      );
    }
    if (request.model !== undefined && !MODEL_ID_RE.test(request.model)) {
      return ineligible("CAPABILITY_MISSING", "requested model is not a plain model id");
    }
    if (this.#exe === undefined) return ineligible("CAPABILITY_MISSING", `${GROK_BINARY} not found on PATH`);

    const policyFlags = [
      SANDBOX_FLAG,
      readOnly ? SANDBOX_READ_ONLY : SANDBOX_OFF,
      ...(network === "off" ? ["--disable-web-search"] : []),
      ALWAYS_APPROVE_FLAG,
      ...(request.model !== undefined ? [MODEL_FLAG, request.model] : []),
    ];
    return {
      transport: "subprocess-jsonl",
      // `--single=<prompt>` is one argv word, so a prompt that starts with `-` can never be read as a flag (Assumption:
      // the `=` form is accepted; [LIVE] step 1 shows clap-style errors). The prompt is visible in the process list.
      argv: [
        this.#exe,
        ...this.#launcher,
        NO_AUTO_UPDATE_FLAG,
        `${SINGLE_FLAG}=${renderObjective(request)}`,
        OUTPUT_FORMAT_FLAG,
        OUTPUT_STREAMING_JSON,
        ...policyFlags,
        ...tail,
      ],
      env: {},
      envAllowlist: [...GROK_ENV_ALLOWLIST],
      cwd: request.workspace.cwd,
      stdin: { kind: "none" },
      outputFormat: "jsonl",
      timeouts: { ...this.#timeouts },
      policyFlags,
      expectedExitCodes: [0],
      maxLineBytes: DEFAULT_MAX_LINE_BYTES,
    };
  }

  /**
   * One `streaming-json` line -> normalized events (T4.23). Structured fields only (FR-ADP-04): the session id is read
   * from the `end` line's `sessionId` and nowhere else. A line whose type or shape is not recognised is an `unknown`
   * event and never a result; a final result exists only when an `end` line carries a string `stopReason`. Hardening
   * (fail closed): a second `end` line, a changed session id or one that is not a safe argument is
   * OUTPUT_PROTOCOL_ERROR, an `error` line without a string message is still an error, and only finite non-negative
   * usage counters are recorded.
   */
  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[] {
    if (typeof input !== "string") return []; // no ACP transport for Grok Build (TDD §4.3.1)
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
    switch (type) {
      case EVENT.availableCommands:
      case EVENT.thought:
      case EVENT.usage: // the `end` line carries the totals; this one has a `signature` field and no recorded use
        return [];
      case EVENT.text: {
        const data = str(ownProp(e, "data"));
        if (data === undefined) return this.#unknown(state, type);
        return [{ kind: "message", role: "assistant", text: data }];
      }
      case EVENT.toolCall:
      case EVENT.toolCallUpdate:
        return this.#handleToolCall(e, type, state);
      case EVENT.end: {
        const stop = str(ownProp(e, "stopReason"));
        if (stop === undefined) return this.#unknown(state, type);
        const out: NormalizedEvent[] = [];
        const ends = (seenEnds.get(state) ?? 0) + 1;
        seenEnds.set(state, ends);
        // One turn prints one `end` ([LIVE] 4a, 4b); a second could flip an earlier failure, so the run fails closed.
        if (ends > 1) {
          out.push({ kind: "provider_error", category: PROTOCOL_CATEGORY, message: "more than one end line" });
        }
        const id = str(ownProp(e, "sessionId"));
        const modelUsage = obj(ownProp(e, "modelUsage"));
        const modelFromUsage =
          modelUsage !== undefined
            ? Object.keys(modelUsage).find(
                (k) =>
                  typeof k === "string" &&
                  k !== "" &&
                  k !== "__proto__" &&
                  !(k in Object.prototype) &&
                  Object.hasOwn(modelUsage, k),
              )
            : undefined;
        const candidateModel = str(ownProp(e, "model")) ?? str(ownProp(e, "model_id")) ?? modelFromUsage;
        const rawModel =
          candidateModel !== undefined && candidateModel !== "__proto__" && !(candidateModel in Object.prototype)
            ? candidateModel
            : undefined;
        const candidateBacking = str(ownProp(e, "backing_provider")) ?? str(ownProp(e, "backingProvider"));
        const rawBacking =
          candidateBacking !== undefined && candidateBacking !== "__proto__" && !(candidateBacking in Object.prototype)
            ? candidateBacking
            : undefined;
        if (id !== undefined) out.push(...this.#bind(state, id, rawModel, rawBacking));
        const usage = obj(ownProp(e, "usage"));
        const metrics: Record<string, number | string | null> = {};
        const count = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
        for (const k of USAGE_KEYS) {
          const v = ownProp(usage, k);
          if (count(v)) metrics[k] = v;
        }
        const numTurns = ownProp(e, "num_turns");
        if (usage && count(numTurns)) metrics.num_turns = numTurns;
        // The end line usage is the run total (FR-CAP-01), so only the first end line records it; a second would count twice.
        if (ends === 1 && Object.keys(metrics).length > 0) {
          out.push({ kind: "usage", source: "provider_reported", metrics });
        }
        const ok = ends === 1 && stop === STOP_REASON_END_TURN;
        out.push({ kind: "result", ok, ...(ok ? {} : { summary: `stopReason ${clip(stop, 64)}` }) });
        return out;
      }
      case EVENT.error: {
        const message = str(ownProp(e, "message"));
        // `message` was a string ([LIVE] 3c, 5b); an `error` line of any other shape is still an error, never ignored.
        if (message === undefined)
          return [{ kind: "provider_error", category: "unknown", message: "error line without a string message" }];
        const category = message.startsWith(ERROR_NOT_SIGNED_IN_PREFIX)
          ? "auth"
          : message.startsWith(ERROR_MODEL_PREFIX)
            ? "model_unavailable"
            : "unknown";
        return [{ kind: "provider_error", category, message: clip(message, MAX_SUMMARY_CHARS) }];
      }
      default:
        return this.#unknown(state, type);
    }
  }

  /**
   * Parse a `tool_call` or `tool_call_update` event. Reports parameter keys per tool call, so a late or swapped command
   * in `tool_call_update` emits a tool_call event for the ADR-0039 guard without duplicating identical reports
   * (mirrors Antigravity T4.33 and Cursor T4.43). Unreadable shapes stay `unknown`.
   */
  #handleToolCall(e: Json, type: string, state: ParseState): NormalizedEvent[] {
    const input =
      obj(ownProp(e, "input")) ??
      obj(ownProp(e, "parameters")) ??
      obj(ownProp(e, "args")) ??
      obj(ownProp(e, "arguments"));
    const command =
      str(ownProp(input, "command")) ??
      str(ownProp(input, "cmd")) ??
      str(ownProp(input, "CommandLine")) ??
      str(ownProp(e, "command")) ??
      str(ownProp(e, "cmd")) ??
      str(ownProp(e, "CommandLine"));
    const target =
      str(ownProp(input, "path")) ??
      str(ownProp(input, "filePath")) ??
      str(ownProp(input, "file_path")) ??
      str(ownProp(input, "AbsolutePath")) ??
      str(ownProp(input, "target")) ??
      str(ownProp(e, "path")) ??
      str(ownProp(e, "filePath")) ??
      str(ownProp(e, "file_path")) ??
      str(ownProp(e, "AbsolutePath")) ??
      str(ownProp(e, "target"));
    const rawName = str(ownProp(e, "tool")) ?? str(ownProp(e, "name")) ?? str(ownProp(e, "tool_name"));
    const name = rawName !== undefined && rawName !== "" ? rawName : undefined;
    if (command === undefined && target === undefined && name === undefined) {
      return this.#unknown(state, type);
    }
    const rawCallId = str(ownProp(e, "id")) ?? str(ownProp(e, "call_id")) ?? str(ownProp(e, "tool_call_id"));
    const callId = rawCallId !== undefined && rawCallId !== "" ? rawCallId : undefined;
    let seen = seenToolCalls.get(state);
    if (seen === undefined) {
      seen = { counter: 0, calls: new Map(), shellCalls: new Set() };
      seenToolCalls.set(state, seen);
    }
    const isNew = type === EVENT.toolCall;
    if (isNew && callId === undefined) {
      seen.counter += 1;
    }
    const key = callId ?? (seen.counter > 0 ? `call_${seen.counter}` : `call_1`);
    if (!isNew && seen.counter === 0 && callId === undefined) {
      seen.counter = 1;
    }
    const paramKey =
      command !== undefined ? `command:${command}` : target !== undefined ? `target:${target}` : undefined;
    const reported = seen.calls.get(key);
    if (reported === undefined) {
      seen.calls.set(key, new Set(paramKey === undefined ? [] : [paramKey]));
    } else if (paramKey === undefined || reported.has(paramKey)) {
      // Already reported with this command/target, or update carries no parameters: do not duplicate.
      return [];
    } else {
      reported.add(paramKey);
    }
    // A call opened as a shell call stays one, so a later target-only update without a name is guarded as a command.
    const kind =
      command !== undefined || name === "run_terminal_command" || seen.shellCalls.has(key)
        ? "shell"
        : target !== undefined
          ? "read"
          : "other";
    if (kind === "shell") seen.shellCalls.add(key);
    // A shell call carrying its command line only in a target hands the whole line to the ADR-0039 guard as the
    // transient `command` (never clipped, stripped before the event is kept), so a Git write past the 512-character
    // target clip is still seen (T4.23 sixth-pass gap); the kept target stays clipped.
    const guardCommand = command ?? (kind === "shell" ? target : undefined);
    return [
      {
        kind: "tool_call",
        tool: kind,
        name: clip(name ?? "run_terminal_command", 64),
        ...(guardCommand !== undefined ? { command: guardCommand } : {}),
        ...(target !== undefined && command === undefined ? { target: clip(target, MAX_TARGET_CHARS) } : {}),
      },
    ];
  }

  /**
   * The first non-empty id binds the session. A later, different id (a second `end` for another session) makes the
   * binding ambiguous, so the run fails closed; the first id stays bound. An id resume could not pass as one safe
   * argument is never bound and fails the run (Proposed, fail closed, as Cursor and OpenCode). Structured model and
   * backing_provider are supported for fronted harnesses (T4.6, FR-ADP-10; live check 4a observed a model id string).
   */
  #bind(
    state: ParseState,
    id: string,
    model?: string | undefined,
    backingProvider?: string | undefined,
  ): NormalizedEvent[] {
    if (id === "") return [];
    if (!SESSION_ID_RE.test(id)) {
      return [{ kind: "provider_error", category: PROTOCOL_CATEGORY, message: "session id is not a safe argument" }];
    }
    if (state.nativeSessionId !== undefined) {
      if (id === state.nativeSessionId) return [];
      return [{ kind: "provider_error", category: PROTOCOL_CATEGORY, message: "session id changed mid-run" }];
    }
    state.nativeSessionId = id;
    const cleanModel = model !== undefined && model !== "" ? clip(model, 128) : undefined;
    const cleanBacking =
      backingProvider !== undefined && backingProvider !== "" ? clip(backingProvider, 128) : undefined;
    return [
      {
        kind: "session_bound",
        nativeSessionId: id,
        ...(cleanModel ? { model: cleanModel } : {}),
        ...(cleanBacking ? { backingProvider: cleanBacking } : {}),
      },
    ];
  }

  #unknown(state: ParseState, rawType: string): NormalizedEvent[] {
    state.unknownEvents += 1;
    return [{ kind: "unknown", rawType: clip(rawType, 64) }];
  }

  /**
   * Success needs a clean expected exit and a final `result` with `ok` and no `provider_error`, `permission_denied`,
   * `sandbox_violation` or `rate_limit` event and no `tool_call` the tool-call guard flagged with a `violation` (fail
   * closed, as Codex; a guard verdict ends the run in every run, bypass included, ADR-0039), and no `tool_call` line,
   * read or not, after the `end` line. The summary is the joined assistant text, last {@link MAX_SUMMARY_CHARS}
   * characters.
   */
  extractResult(events: readonly NormalizedEvent[], exit: ExitInfo): RunResult {
    const unknownEventCount = events.filter((e) => e.kind === "unknown").length;
    const bound = events.findLast((e) => e.kind === "session_bound");
    const nativeSessionId = bound?.kind === "session_bound" ? bound.nativeSessionId : undefined;
    const text = events.flatMap((e) => (e.kind === "message" ? [e.text] : [])).join("");
    const summary = text === "" ? undefined : text.slice(-MAX_SUMMARY_CHARS);
    const finalAt = events.findLastIndex((e) => e.kind === "result");
    const final = events[finalAt];
    // Proposed (fail closed): `end` was the last line of every recorded run ([LIVE] 4a, 4b), so a tool call after it
    // means the run did not end on that result. A `tool_call` line the parser could not read counts too: the bare
    // `{"type":"tool_call"}` is the only shape the live check recorded (row 4b), and it parses as `unknown`.
    const trailingTool =
      finalAt >= 0 &&
      events
        .slice(finalAt + 1)
        .some((e) => e.kind === "tool_call" || (e.kind === "unknown" && e.rawType === EVENT.toolCall));
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
    const detail = trailingTool && c.code === "OUTPUT_PROTOCOL_ERROR" ? "tool call after the end line" : c.detail;
    return { ok: false, failureCode: c.code, failureDetail: detail, ...base };
  }

  /**
   * Shared precedence (failure.ts); native error messages are already mapped to the shared categories, and a stream
   * anomaly (category `protocol`) is OUTPUT_PROTOCOL_ERROR.
   */
  classifyFailure(evidence: FailureEvidence): FailureClassification {
    return classifyCommon(evidence, CATEGORY_CODES);
  }
}
