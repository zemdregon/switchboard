/**
 * Antigravity adapter (T4.32, TDD §4.4; module, probe, compile matrix and registry entry; Delegated, not
 * owner-approved). Native surface: one process per run, `agy --prompt=<prompt> --output-format stream-json` (TDD §4.4
 * "Transport (decision)": an ephemeral subprocess, not ACP; the separate ACP server does not reuse `agy`'s login,
 * [LIVE] C16). The adapter never reads Antigravity credential, settings or state files (`~/.gemini/...`), never starts
 * the sign-in, never writes `settings.json`, never passes `--gemini_dir`, `--add-dir`, `--remote-control`, `--sandbox`,
 * `--mode`, `--model`, `--continue` or `--print-timeout`, keeps `GEMINI_API_KEY`, `GOOGLE_API_KEY` and
 * `GOOGLE_GEMINI_BASE_URL` out of the environment (API-key mode stays disabled), and emits its one bypass flag only
 * for an approved `privileged` scope that sets `bypass` (FR-POL-03, ADR-0017).
 *
 * Compile matrix (Proposed, fail closed; TDD §4.4.2, Q-63 and Q-84):
 * - the four non-`privileged` profiles are `Ineligible: PROFILE_UNSUPPORTED`: `toolPermission` is a settings value,
 *   not per run, and `init.permission_mode` was `request-review` in every live run (FR-POL-02, FR-POL-08);
 * - `privileged` compiles only when its scope sets `bypass` and the run is approved (owner decision 46), as
 *   `--dangerously-skip-permissions`, and only for the scope Antigravity cannot narrow below under it: worktree
 *   files, shell `broad`, network `on` and repository configuration `enabled` (Q-84). `--sandbox` is not compiled:
 *   whether it still confines anything under the bypass flag was not observed ([LIVE] C8). Antigravity confines
 *   nothing in that run; what remains is the controller's worktree, the tool-call guard (ADR-0039), FR-GIT-03 and
 *   FR-GIT-06;
 * - the parser (T4.33) reads only the `stream-json` fields the 2026-10-14 live check recorded; soft denials fail the run
 *   and `SUCCESS` with no reported tokens is not a success (Q-86); a `denied_actions` or `error` value of an unrecorded
 *   shape, a second `result` and a changed conversation id fail the run too; resume is not compiled (Q-86). The auth
 *   preflight fails closed until T4.34. The manifest range admits no version, so none of this runs before `adapters validate` passes a
 *   version.
 */
import {
  DEFAULT_IDLE_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_WALL_CLOCK_MS,
} from "../../exec/index.js";
import { resolveOnPath } from "../codex/adapter.js";
import { classifyCommon, PROVIDER_ERROR_CATEGORY_CODES } from "../failure.js";
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
  AGY_BINARY,
  DISABLE_AUTO_UPDATE_ENV,
  ERROR_AUTH_PREFIX,
  ERROR_MODEL_PREFIX,
  EVENT,
  GIT_WRITE_CONTROL_DETAIL,
  HELP_FLAG,
  NON_PRIVILEGED_UNSUPPORTED_DETAIL,
  OUTPUT_FORMAT_FLAG,
  OUTPUT_STREAM_JSON,
  PROMPT_FLAG,
  REQUIRED_HELP_FLAGS,
  SKIP_PERMISSIONS_FLAG,
  STATUS_SUCCESS,
  STEP_TOOL,
  USAGE_KEYS,
  VERSION_ARGS,
} from "./protocol.js";

/**
 * Environment names passed through to Antigravity (FR-EXE-07, NFR-SEC-02). Proposed: `PATH` for the binary and `HOME`,
 * which selects the CLI's own login and settings ([LIVE] C13: a different `HOME` is logged out). `GEMINI_API_KEY`,
 * `GOOGLE_API_KEY` and `GOOGLE_GEMINI_BASE_URL` stay out ([I]; ADR-0003); `DBUS_SESSION_BUS_ADDRESS` is not needed
 * ([LIVE] C5b).
 */
export const ANTIGRAVITY_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME"];

const PROBE_TIMEOUT_MS = 10_000;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_TARGET_CHARS = 512;

/** FR-GIT-01 (ADR-0039): no per-run deny control; see protocol.ts. */
export const ANTIGRAVITY_GIT_WRITE_CONTROL: GitWriteControl = {
  kind: "none-documented",
  detail: GIT_WRITE_CONTROL_DETAIL,
  remainingControls: ["FR-GIT-03", "FR-GIT-06"],
};

/** FR-GIT-09 (TDD §4.4 "Git writes and injected tools"): no per-run MCP definition is documented. */
export const ANTIGRAVITY_GIT_CAPABILITIES: GitCapabilities = {
  commitChannel: "finalize-only",
  detail:
    "MCP servers come only from the global and workspace mcp_config.json files and their tools need a settings " +
    "allow rule ([M], [P]), so no tool is injected. The controller commits at FINALIZING when the project opts in " +
    "(FR-GIT-09).",
};

/** Ineligible detail for a bypass approval on a profile other than `privileged` (FR-POL-03). */
export const ANTIGRAVITY_BYPASS_OUTSIDE_PRIVILEGED =
  "bypassApproved is set on a profile other than privileged: a bypass applies only to an approved privileged scope " +
  "(FR-POL-03, ADR-0017)";
/** Ineligible detail for a `privileged` scope without `bypass` (TDD §4.4.2 `toolPermission` row). */
export const ANTIGRAVITY_PRIVILEGED_NEEDS_BYPASS =
  "privileged without bypass: toolPermission is not settable per run, so only --dangerously-skip-permissions in an " +
  "approved bypass scope compiles (TDD §4.4.2, Q-63)";
/** Ineligible detail for a scope that sets `bypass` on a run whose approval is missing (FR-POL-03). */
export const ANTIGRAVITY_BYPASS_NOT_APPROVED =
  "privileged scope sets bypass but the run's bypassApproved is false: --dangerously-skip-permissions is compiled " +
  "only for an approved bypass run (FR-POL-03, ADR-0017)";

export interface AntigravityAdapterOptions {
  /** Absolute path of the agy binary. Defaults to the first executable `agy` on PATH, resolved once. */
  executable?: string;
  /** Test-only: arguments inserted between the executable and the flags (replay launcher). Empty in production. */
  launcherArgs?: readonly string[];
  timeouts?: Partial<Invocation["timeouts"]>;
  /** PATH used to resolve `agy` when `executable` is absent. Defaults to process.env.PATH. */
  pathEnv?: string;
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const ineligible = (reason: Ineligible["reason"], detail: string): Ineligible => ({ ineligible: true, reason, detail });
/**
 * Tool steps already reported per run (a step streams ACTIVE then DONE, [LIVE] C7), keyed by `step_index`; the value
 * is whether the report carried a command or path, so a later update that first carries one is still reported.
 */
const seenToolSteps = new WeakMap<ParseState, Map<number, boolean>>();
/** `result` lines already seen per run: a second one is a protocol anomaly, never a success (fail closed). */
const seenResults = new WeakMap<ParseState, number>();
/** Category of a stream anomaly (two results, two conversation ids); classified OUTPUT_PROTOCOL_ERROR. */
const PROTOCOL_CATEGORY = "protocol";
const CATEGORY_CODES = { ...PROVIDER_ERROR_CATEGORY_CODES, [PROTOCOL_CATEGORY]: "OUTPUT_PROTOCOL_ERROR" } as const;

export class AntigravityAdapter implements ProviderAdapter {
  readonly id = "antigravity" as const;
  readonly transports = ["subprocess-jsonl"] as const;
  readonly gitWriteControl = ANTIGRAVITY_GIT_WRITE_CONTROL;
  /** TDD §4.10 ([RS]): "Histories are scoped to the working directory", so `bound` (registry entry agrees). */
  readonly resumeCwd = "bound" as const;
  readonly gitCapabilities = ANTIGRAVITY_GIT_CAPABILITIES;
  readonly #exe: string | undefined;
  readonly #launcher: readonly string[];
  readonly #timeouts: Invocation["timeouts"];

  constructor(opts: AntigravityAdapterOptions = {}) {
    this.#exe = opts.executable ?? resolveOnPath(AGY_BINARY, opts.pathEnv ?? process.env.PATH);
    this.#launcher = [...(opts.launcherArgs ?? [])];
    this.#timeouts = {
      wallClockMs: DEFAULT_WALL_CLOCK_MS,
      idleMs: DEFAULT_IDLE_MS,
      killGraceMs: DEFAULT_KILL_GRACE_MS,
      ...opts.timeouts,
    };
  }

  /**
   * FR-ADP-02 steps 1 to 5 with no model call: `agy --version`, then `agy --help` for the required flags. Output is
   * probe evidence only (FR-ADP-04). Step 7 (the structured-output smoke call) is not run here.
   */
  async probe(runner: ProbeRunner): Promise<ProbeResult> {
    const exe = this.#exe;
    if (exe === undefined) {
      return {
        binaryPath: AGY_BINARY,
        binaryVersion: null,
        steps: [{ step: "binary", ok: false, detail: `${AGY_BINARY} not found on PATH` }],
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

  /** T4.34 supplies the auth preflight; until then fail closed (NFR-SEC-06). Never reads a credential file. */
  async authPreflight(_runner: ProbeRunner): Promise<AuthResult> {
    return { state: "UNKNOWN", reason: "Antigravity auth preflight is not implemented (T4.34)" };
  }

  compile(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    return this.#build(request, profile, []);
  }

  /**
   * FR-SES-03 (T4.33): not compiled (Q-86). `--conversation <id>` resumes a known id, but an unknown id exits 0 with
   * `SUCCESS` in a new conversation and only a stderr warning ([LIVE] C9 run 5), so a resume that lost its history
   * cannot be told apart from one that kept it in the stream. Fail closed until a check shows a structured signal.
   */
  resumeArgs(binding: NativeBinding, _request: CompileRequest, _profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== "antigravity") {
      return ineligible("CAPABILITY_MISSING", `binding is for ${binding.provider}`);
    }
    return ineligible(
      "CAPABILITY_MISSING",
      "Antigravity resume is not compiled: an unknown --conversation id silently starts a new conversation with exit " +
        "0 (2026-10-14 live check C9), so a lost history is not visible in the stream (Q-86)",
    );
  }

  /**
   * Pure. Order of checks (the first unmet one is the reason):
   * 1. a bypass approval on a profile other than `privileged`: PROFILE_UNSUPPORTED (FR-POL-03);
   * 2. any profile other than `privileged`: PROFILE_UNSUPPORTED ({@link NON_PRIVILEGED_UNSUPPORTED_DETAIL});
   * 3. `privileged`: no scope binding, or `bypass: false`: PROFILE_UNSUPPORTED; `bypass: true` without an approval:
   *    PROFILE_UNSUPPORTED (FR-POL-03);
   * 4. read-only files (scope or workspace): CAPABILITY_MISSING (the bypass flag approves every tool, [H]; workspace
   *    writes are auto-allowed even without it, [LIVE] C7);
   * 5. shell other than `broad`: CAPABILITY_MISSING (allow rules are settings, not per run, [P]);
   * 6. network other than `on`: CAPABILITY_MISSING (`--sandbox` is not compiled; under bypass not confined, [H]);
   * 7. repository_config `disabled` or `approved`: CAPABILITY_MISSING (`GEMINI.md`, `AGENTS.md` and `.agents/*` load
   *    and run with no approval, [LIVE] C11; no flag disables them); only `enabled` compiles (owner decision 26, Q-37);
   * 8. a requested model: CAPABILITY_MISSING (the model registry has no Antigravity data yet, T4.5; `--model` is not
   *    emitted).
   */
  #build(request: CompileRequest, profile: ResolvedProfile, tail: string[]): Invocation | Ineligible {
    if (profile.name !== "privileged") {
      if (profile.bypassApproved || request.bypassApproved === true) {
        return ineligible("PROFILE_UNSUPPORTED", ANTIGRAVITY_BYPASS_OUTSIDE_PRIVILEGED);
      }
      return ineligible("PROFILE_UNSUPPORTED", `${profile.name}: ${NON_PRIVILEGED_UNSUPPORTED_DETAIL}`);
    }
    const scope = profile.privilegedScope?.scope;
    if (scope === undefined) {
      return ineligible("PROFILE_UNSUPPORTED", "privileged without an approved scope binding (LLD §3.1)");
    }
    if (!scope.bypass) return ineligible("PROFILE_UNSUPPORTED", ANTIGRAVITY_PRIVILEGED_NEEDS_BYPASS);
    if (!(profile.bypassApproved || request.bypassApproved === true)) {
      return ineligible("PROFILE_UNSUPPORTED", ANTIGRAVITY_BYPASS_NOT_APPROVED);
    }
    if (scope.files.access === "read-only" || !request.workspace.writable) {
      return ineligible(
        "CAPABILITY_MISSING",
        "privileged read-only files: --dangerously-skip-permissions approves every tool and workspace writes are " +
          "auto-allowed even without it ([H], 2026-10-14 live check C7), so nothing keeps the run read-only",
      );
    }
    if (scope.shell.mode !== "broad") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged shell=${scope.shell.mode} with bypass: the bypass flag approves every command and allow rules ` +
          "are settings, not per run ([P])",
      );
    }
    if (scope.network.mode !== "on") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged network=${scope.network.mode}: --sandbox is not compiled and whether it confines anything under ` +
          "the bypass flag was not observed (T4.31 C8, Q-84)",
      );
    }
    if (scope.repository_config.mode !== "enabled") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged repository_config=${scope.repository_config.mode}: GEMINI.md, AGENTS.md and the .agents MCP ` +
          "servers and hooks load and run with no approval (2026-10-14 live check C11) and no flag disables them; " +
          "owner decision 26 (Q-37) allows `enabled` in an approved bypass run",
      );
    }
    if (request.model !== undefined) {
      return ineligible(
        "CAPABILITY_MISSING",
        "no model registry data for Antigravity yet (T4.5; --model is not emitted)",
      );
    }
    if (this.#exe === undefined) return ineligible("CAPABILITY_MISSING", `${AGY_BINARY} not found on PATH`);

    const policyFlags = [SKIP_PERMISSIONS_FLAG];
    return {
      transport: "subprocess-jsonl",
      // `--prompt=<prompt>` is one argv word, so a prompt that starts with `-` is never read as a flag (Assumption: the
      // `=` form is accepted; see protocol.ts). The prompt is visible in the process list.
      argv: [
        this.#exe,
        ...this.#launcher,
        `${PROMPT_FLAG}=${request.objective}`,
        OUTPUT_FORMAT_FLAG,
        OUTPUT_STREAM_JSON,
        ...policyFlags,
        ...tail,
      ],
      env: { [DISABLE_AUTO_UPDATE_ENV]: "true" },
      envAllowlist: [...ANTIGRAVITY_ENV_ALLOWLIST],
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
   * One `stream-json` line -> normalized events (T4.33). Structured fields only (FR-ADP-04): the session id is the
   * `conversation_id` of `init` (or of `result` when no `init` came first). A soft-denied tool ([LIVE] C7) is a
   * `permission_denied` event per `denied_actions` entry, because the run still ends `SUCCESS` with exit 0. The
   * envelope's usage is the run total, so per-step usage is not recorded (no double count).
   */
  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[] {
    if (typeof input !== "string") return []; // no ACP transport (TDD §4.4 transport decision)
    state.lines += 1;
    let doc: unknown;
    try {
      doc = JSON.parse(input);
    } catch {
      return []; // the supervisor ends the run OUTPUT_PROTOCOL_ERROR on unparseable framing
    }
    const e = obj(doc);
    const type = str(e?.event);
    if (e === undefined || type === undefined) return this.#unknown(state, "none");
    switch (type) {
      case EVENT.init: {
        const init = obj(e.init);
        const id = str(e.conversation_id);
        if (init === undefined || id === undefined) return this.#unknown(state, type);
        return this.#bind(state, id, str(init.model));
      }
      case EVENT.stepUpdate:
        return this.#step(e, state);
      case EVENT.result: {
        const r = obj(e.result);
        const status = str(r?.status);
        if (r === undefined || status === undefined) return this.#unknown(state, type);
        const out: NormalizedEvent[] = [];
        const results = (seenResults.get(state) ?? 0) + 1;
        seenResults.set(state, results);
        // One run prints one `result` ([LIVE] C4); a second could flip an earlier failure, so the run fails closed.
        if (results > 1) {
          out.push({ kind: "provider_error", category: PROTOCOL_CATEGORY, message: "more than one result line" });
        }
        const id = str(r.conversation_id);
        if (id !== undefined) out.push(...this.#bind(state, id, undefined));
        const usage = obj(r.usage);
        const metrics: Record<string, number | string | null> = {};
        for (const k of USAGE_KEYS) {
          const v = usage?.[k];
          if (typeof v === "number" && Number.isFinite(v) && v >= 0) metrics[k] = v;
        }
        if (Object.keys(metrics).length > 0) out.push({ kind: "usage", source: "provider_reported", metrics });
        // `denied_actions` was an array of `{action, display_name}` ([LIVE] C7, C18). Any other present value is
        // read as a denial rather than ignored, so an unexpected shape cannot hide one.
        const rawDenied = r.denied_actions;
        const denied = Array.isArray(rawDenied) ? rawDenied : rawDenied === undefined || rawDenied === null ? [] : [{}];
        for (const d of denied) {
          const action = obj(d);
          out.push({
            kind: "permission_denied",
            tool: clip(str(action?.display_name) ?? str(action?.action) ?? "unknown", 64),
          });
        }
        // `error` was a string ([LIVE] C6, C10, C13); any other present value is an unknown error, never ignored.
        const rawError = r.error;
        const error = str(rawError);
        if (error !== undefined && error !== "") {
          const category = error.startsWith(ERROR_MODEL_PREFIX)
            ? "model_unavailable"
            : error.startsWith(ERROR_AUTH_PREFIX)
              ? "auth"
              : "unknown";
          out.push({ kind: "provider_error", category, message: clip(error, MAX_SUMMARY_CHARS) });
        } else if (error === undefined && rawError !== undefined && rawError !== null) {
          out.push({ kind: "provider_error", category: "unknown", message: "non-string error field" });
        }
        // Q-86: `SUCCESS` with no tokens is what a print timeout returns ([LIVE] C10), so it is not a success.
        const total = metrics.total_tokens;
        const ok = results === 1 && status === STATUS_SUCCESS && typeof total === "number" && total > 0;
        const response = str(r.response);
        if (response !== undefined && response !== "") {
          out.push({ kind: "message", role: "assistant", text: clip(response, MAX_SUMMARY_CHARS) });
        }
        out.push({
          kind: "result",
          ok,
          ...(ok ? {} : { summary: status === STATUS_SUCCESS ? "SUCCESS with no reported tokens" : clip(status, 64) }),
        });
        return out;
      }
      default:
        return this.#unknown(state, type);
    }
  }

  /**
   * The first non-empty id binds the session. A later, different id (a second `init` or a `result` for another
   * conversation) makes the binding ambiguous, so the run fails closed; the first id stays bound.
   */
  #bind(state: ParseState, id: string, model: string | undefined): NormalizedEvent[] {
    if (id === "") return [];
    if (state.nativeSessionId !== undefined) {
      if (id === state.nativeSessionId) return [];
      return [{ kind: "provider_error", category: PROTOCOL_CATEGORY, message: "conversation id changed mid-run" }];
    }
    state.nativeSessionId = id;
    return [{ kind: "session_bound", nativeSessionId: id, ...(model ? { model: clip(model, 128) } : {}) }];
  }

  /** Tool steps become one `tool_call` each (the command or path is transient, for the guard); text deltas are dropped. */
  #step(e: Json, state: ParseState): NormalizedEvent[] {
    const stepType = str(e.step_type);
    const index = e.step_index;
    if (stepType === undefined || typeof index !== "number") return this.#unknown(state, "step_update");
    // Only tool steps are actions; the final answer arrives whole in `result.response`, so `agent_response` deltas,
    // `user_input` and `checkpoint` steps are not kept.
    if (stepType !== STEP_TOOL) return [];
    const seen = seenToolSteps.get(state) ?? new Map<number, boolean>();
    seenToolSteps.set(state, seen);
    // Already reported with a command or path: later updates of the step add nothing.
    if (seen.get(index) === true) return [];
    const info = obj(e.tool_info);
    const name = str(info?.name) ?? str(e.tool_name) ?? "unknown";
    const params = obj(info?.parameters);
    // Assumption: the parameter names below; the live check recorded `tool_info.{name,parameters}` but not their keys.
    // Without them the guard sees no command or path for this call.
    const command = str(params?.command) ?? str(params?.CommandLine);
    const target = str(params?.path) ?? str(params?.file_path) ?? str(params?.AbsolutePath);
    const kind = command !== undefined ? "shell" : "other";
    const carries = command !== undefined || target !== undefined;
    // Reported once without parameters: a later update is reported again only when it first names a command or path,
    // so the tool-call guard sees it whichever update carries `tool_info.parameters` (Assumption: not recorded).
    if (seen.has(index) && !carries) return [];
    seen.set(index, carries);
    return [
      {
        kind: "tool_call",
        tool: kind,
        name: clip(name, 64),
        ...(command !== undefined ? { command } : {}),
        ...(target !== undefined && command === undefined ? { target: clip(target, MAX_TARGET_CHARS) } : {}),
      },
    ];
  }

  #unknown(state: ParseState, rawType: string): NormalizedEvent[] {
    state.unknownEvents += 1;
    return [{ kind: "unknown", rawType: clip(rawType, 64) }];
  }

  /**
   * Success needs a clean expected exit and a final `result` with `ok` (status `SUCCESS` and reported tokens, Q-86) and
   * no `provider_error`, `permission_denied`, `sandbox_violation` or `rate_limit` event (fail closed; a soft denial and
   * a print timeout both exit 0 with `SUCCESS`, [LIVE] C7, C10).
   */
  extractResult(events: readonly NormalizedEvent[], exit: ExitInfo): RunResult {
    const unknownEventCount = events.filter((e) => e.kind === "unknown").length;
    const bound = events.find((e) => e.kind === "session_bound");
    const nativeSessionId = bound?.kind === "session_bound" ? bound.nativeSessionId : undefined;
    const text = events.flatMap((e) => (e.kind === "message" ? [e.text] : [])).join("\n");
    const summary = text === "" ? undefined : text.slice(-MAX_SUMMARY_CHARS);
    const final = events.findLast((e) => e.kind === "result");
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
          e.kind === "rate_limit",
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

  classifyFailure(evidence: FailureEvidence): FailureClassification {
    return classifyCommon(evidence, CATEGORY_CODES);
  }
}
