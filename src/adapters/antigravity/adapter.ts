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
 *   shape, a second `result`, a changed conversation id and one that is not a safe token fail the run too; resume is
 *   compiled as `--conversation <id>` in the same cell and fails closed on a different or missing returned id (owner
 *   decision 67, Q-86). The auth
 *   preflight (T4.34) is `agy models`, keyed on the observed exit codes and stderr. The manifest range admits no version, so none of this runs before `adapters validate` passes a
 *   version;
 * - the limit mapping (T6.15, FR-CAP-11): `classifyFailure` reads the structured `AGY_ERROR: {...}` stderr line of an
 *   exit-3 run (the 2026-10-17 T6.11 capture) and maps `status` `RESOURCE_EXHAUSTED` to `QUOTA_EXHAUSTED`; it reaches
 *   the mapping only through `FailureEvidence.stderrTail`, which `extractResult` cannot supply (see there).
 */

import { tmpdir } from "node:os";
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
import { isIneligible } from "../types.js";
import {
  AGY_BINARY,
  AGY_ERROR_EXIT,
  AGY_ERROR_PREFIX,
  AGY_ERROR_STATUS_CATEGORIES,
  AGY_LOGIN_COMMAND,
  AUTH_LOGGED_OUT_EXIT,
  AUTH_LOGGED_OUT_PREFIX,
  AUTH_STATUS_ARGS,
  AUTH_STATUS_LINE_MAX,
  AUTH_STATUS_TIMEOUT_MS,
  BACKING_PROVIDER_KEY,
  CONVERSATION_FLAG,
  DISABLE_AUTO_UPDATE_ENV,
  ERROR_AUTH_PREFIX,
  ERROR_MODEL_PREFIX,
  EVENT,
  GIT_WRITE_CONTROL_DETAIL,
  GO_FLAG_UNDEFINED_RE,
  HELP_FLAG,
  MODEL_FLAG,
  NON_PRIVILEGED_UNSUPPORTED_DETAIL,
  OUTPUT_FORMAT_FLAG,
  OUTPUT_FORMAT_PROBE_ARGS,
  OUTPUT_STREAM_JSON,
  PROMPT_FLAG,
  REQUIRED_HELP_FLAGS,
  SKIP_PERMISSIONS_FLAG,
  STATUS_SUCCESS,
  STEP_TOOL,
  USAGE_KEYS,
  VERSION_ARGS,
} from "./protocol.js";
import { AGY_USAGE_METHOD, readAgyUsage } from "./usage.js";

/**
 * Environment names passed through to Antigravity (FR-EXE-07, NFR-SEC-02). Proposed: `PATH` for the binary and `HOME`,
 * which selects the CLI's own login and settings ([LIVE] C13: a different `HOME` is logged out). `GEMINI_API_KEY`,
 * `GOOGLE_API_KEY` and `GOOGLE_GEMINI_BASE_URL` stay out ([I]; ADR-0003); `DBUS_SESSION_BUS_ADDRESS` is not needed
 * ([LIVE] C5b).
 */
export const ANTIGRAVITY_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME"];

/** A model id passed as one argv word (the registry's `MODEL_ID_PATTERN` shape; never read as a flag). */
const MODEL_ID_RE = new RegExp(MODEL_ID_PATTERN);
const PROBE_TIMEOUT_MS = 10_000;
const AUTH_UNKNOWN_REASON = "`agy models` output is not a recognised login state";
/** One `agy models` line ([LIVE] C3b): a slug with no whitespace, a tab, then a display name. */
const MODEL_LINE = /^\S+\t\S.*$/;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_TARGET_CHARS = 512;
/** Tool parameter keys read as a command, then as a path (Assumption; see `#toolStep`). */
const COMMAND_KEYS: readonly string[] = ["command", "CommandLine"];
const TARGET_KEYS: readonly string[] = ["path", "file_path", "AbsolutePath"];

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
/**
 * Own-property read, so properties carried on Object.prototype or __proto__ smuggling are never read as event
 * fields (Proposed, fail closed; as Cursor T4.43 and OpenCode T4.53).
 */
const ownProp = (o: Json | undefined, key: string): unknown =>
  o !== undefined && Object.hasOwn(o, key) ? o[key] : undefined;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const ineligible = (reason: Ineligible["reason"], detail: string): Ineligible => ({ ineligible: true, reason, detail });
/**
 * Tool steps already reported per run (a step streams ACTIVE then DONE, [LIVE] C7), keyed by `step_index`; the value
 * is the set of commands and paths already reported for the step, so a later update that names a new one is still
 * reported to the tool-call guard.
 */
const seenToolSteps = new WeakMap<ParseState, Map<number, Set<string>>>();
/**
 * Native ids are kept only as one safe token (Proposed, the shape Grok and Cursor check before resume): every recorded
 * `conversation_id` was a UUID or empty ([LIVE] C4, C6, C9, C10).
 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
/** Runs whose resume already reported a different conversation id, so a later line does not report it again. */
const resumeMismatch = new WeakSet<ParseState>();
const RESUME_MISMATCH_MESSAGE = "resumed conversation id differs from the requested one";
const RESUME_NO_ID_MESSAGE = "resume returned no conversation id";
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
  /** ADR-0077: a requested model reaches the CLI only in the approved bypass cell. */
  readonly requestedModelFlag = {
    cells: "bypass",
    detail: "--model <id> in the approved bypass cell, the only compiled cell (ADR-0077; agy --help: --model)",
  } as const;
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
    const helpText = `${help.stdout}\n${help.stderr}`;
    const flags = new Set(commandOk ? (helpText.match(/--[a-z][a-z0-9-]*/g) ?? []) : []);

    // Delegated (T4.32): agy 1.4.0 no longer lists --output-format in --help (observed 2026-10-17, live checks §5).
    // If --help lists it, accept it as before. Otherwise, verify via a no-model check (OUTPUT_FORMAT_PROBE_ARGS) that
    // the CLI accepts the flag without an undefined flag error. Every other flag keeps the help-listing rule.
    let outputFormatOk = flags.has(OUTPUT_FORMAT_FLAG);
    if (!outputFormatOk && commandOk) {
      const check = await run(...OUTPUT_FORMAT_PROBE_ARGS);
      outputFormatOk =
        check.spawnError === undefined &&
        !check.timedOut &&
        check.exitCode === 0 &&
        !GO_FLAG_UNDEFINED_RE.test(check.stderr) &&
        !GO_FLAG_UNDEFINED_RE.test(check.stdout);
    }

    const missing = REQUIRED_HELP_FLAGS.filter((f) => {
      if (f === OUTPUT_FORMAT_FLAG) return !outputFormatOk;
      return !flags.has(f);
    });
    steps.push(
      { step: "command", ok: commandOk, ...(commandOk ? {} : { detail: `\`${HELP_FLAG}\` unavailable` }) },
      {
        step: "output_format",
        ok: outputFormatOk,
        ...(outputFormatOk ? {} : { detail: OUTPUT_FORMAT_FLAG }),
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
   * FR-AUTH-02 via `agy models` (T4.34; observed on `agy` 1.3.4, [LIVE] C3b and C3c; cost in protocol.ts). Exit 0 with
   * at least one stdout line and every non-empty line of the `<slug>\t<name>` shape is OK; exit 1 with a stderr line
   * starting `Error: Please sign in` is AUTH_REQUIRED naming the native login; any other output or exit code, a
   * timeout or a spawn failure is UNKNOWN (ineligible, NFR-SEC-06). Model names are never stored; at most the first
   * stderr line, filtered and truncated, appears in an UNKNOWN reason. It never reads `~/.gemini` and never starts a
   * sign-in.
   */
  async authPreflight(runner: ProbeRunner): Promise<AuthResult> {
    const exe = this.#exe;
    if (exe === undefined) return { state: "UNKNOWN", reason: `${AGY_BINARY} not found on PATH` };
    const r = await runner([exe, ...this.#launcher, ...AUTH_STATUS_ARGS], { timeoutMs: AUTH_STATUS_TIMEOUT_MS });
    if (r.spawnError !== undefined) return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (${r.spawnError})` };
    if (r.timedOut) return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (timed out)` };
    const nonEmpty = (s: string) => s.split("\n").filter((l) => l.trim() !== "");
    const models = nonEmpty(r.stdout);
    const errors = nonEmpty(r.stderr).map((l) => l.trim());
    if (r.exitCode === 0 && models.length > 0 && models.every((l) => MODEL_LINE.test(l))) return { state: "OK" };
    if (r.exitCode === AUTH_LOGGED_OUT_EXIT && errors.some((l) => l.startsWith(AUTH_LOGGED_OUT_PREFIX))) {
      return { state: "AUTH_REQUIRED", loginCommand: AGY_LOGIN_COMMAND };
    }
    const line = Array.from(errors[0] ?? "")
      .filter((c) => c >= " " && c !== "\x7f")
      .join("")
      .slice(0, AUTH_STATUS_LINE_MAX);
    return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (exit ${r.exitCode}${line ? `: ${line}` : ""})` };
  }

  /**
   * T6.20 (FR-CAP-13, ADR-0082 on the ADR-0079 reader): the CLI's own `/usage` and `/credits` answers, read only after
   * `authPreflight` reports a login (signed out, `/usage` waits for a sign-in). Run from the system temporary
   * directory, never a workspace. See `usage.ts`.
   */
  async readProviderUsage(runner: ProbeRunner, now: Date = new Date()): Promise<ProviderUsageResult> {
    const exe = this.#exe;
    if (exe === undefined) {
      return {
        provider: this.id,
        source: "unknown",
        observed_at: now.toISOString(),
        method: AGY_USAGE_METHOD,
        error: `${AGY_BINARY} not found on PATH`,
      };
    }
    return readAgyUsage([exe, ...this.#launcher], runner, () => this.authPreflight(runner), now, tmpdir());
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
   * FR-SES-03 (T4.35, owner decision 67, Q-86): `--conversation <id>` ([LIVE] C9 runs 2 and 3: the same
   * `conversation_id` comes back), compiled by the same matrix as a first run, so only the approved bypass cell
   * compiles and no flag is added beyond its own. An unknown id exits 0 with `SUCCESS` in a new conversation (C9 run 5),
   * so the requested id rides on the invocation and the parser fails a different or missing returned id closed.
   * `-c`/`--continue` is never used. A binding of another provider, or an id that is not one safe token, never compiles.
   */
  resumeArgs(binding: NativeBinding, request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== "antigravity") {
      return ineligible("CAPABILITY_MISSING", `binding is for ${binding.provider}`);
    }
    if (!SESSION_ID_RE.test(binding.nativeSessionId)) {
      return ineligible("CAPABILITY_MISSING", "native session id is not a safe single argument");
    }
    const inv = this.#build(request, profile, [CONVERSATION_FLAG, binding.nativeSessionId]);
    if (isIneligible(inv)) return inv;
    return { ...inv, resumeNativeSessionId: binding.nativeSessionId };
  }

  /**
   * Pure. Order of checks (the first unmet one is the reason):
   * 0. shell allowlist entries that could write Git: PROFILE_UNSUPPORTED (FR-GIT-01);
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
   * 8. a requested model that is not a plain id: CAPABILITY_MISSING; otherwise it is `--model <id>` (ADR-0077).
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
    if (request.model !== undefined && !MODEL_ID_RE.test(request.model)) {
      return ineligible("CAPABILITY_MISSING", "requested model is not a plain model id");
    }
    if (this.#exe === undefined) return ineligible("CAPABILITY_MISSING", `${AGY_BINARY} not found on PATH`);

    const policyFlags = [SKIP_PERMISSIONS_FLAG, ...(request.model !== undefined ? [MODEL_FLAG, request.model] : [])];
    return {
      transport: "subprocess-jsonl",
      // `--prompt=<prompt>` is one argv word, so a prompt that starts with `-` is never read as a flag (Assumption: the
      // `=` form is accepted; see protocol.ts). The prompt is visible in the process list.
      argv: [
        this.#exe,
        ...this.#launcher,
        `${PROMPT_FLAG}=${renderObjective(request)}`,
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
    const type = str(ownProp(e, "event"));
    if (e === undefined || type === undefined) return this.#unknown(state, "none");
    switch (type) {
      case EVENT.init: {
        const init = obj(ownProp(e, "init"));
        const id = str(ownProp(e, "conversation_id"));
        if (init === undefined || id === undefined) return this.#unknown(state, type);
        const rawBacking =
          ownProp(e, BACKING_PROVIDER_KEY) ??
          ownProp(e, "backingProvider") ??
          ownProp(init, BACKING_PROVIDER_KEY) ??
          ownProp(init, "backingProvider");
        const backingProvider = str(rawBacking);
        const rawModel = ownProp(init, "model") ?? ownProp(e, "model");
        const model = str(rawModel);
        return this.#bind(state, id, model, backingProvider);
      }
      case EVENT.stepUpdate:
        return this.#step(e, state);
      case EVENT.result: {
        const r = obj(ownProp(e, "result"));
        const status = str(ownProp(r, "status"));
        if (r === undefined || status === undefined) return this.#unknown(state, type);
        const out: NormalizedEvent[] = [];
        const results = (seenResults.get(state) ?? 0) + 1;
        seenResults.set(state, results);
        // One run prints one `result` ([LIVE] C4); a second could flip an earlier failure, so the run fails closed.
        if (results > 1) {
          out.push({ kind: "provider_error", category: PROTOCOL_CATEGORY, message: "more than one result line" });
        }
        const rawBacking =
          ownProp(e, BACKING_PROVIDER_KEY) ??
          ownProp(e, "backingProvider") ??
          ownProp(r, BACKING_PROVIDER_KEY) ??
          ownProp(r, "backingProvider");
        const backingProvider = str(rawBacking);
        const rawModel = ownProp(r, "model") ?? ownProp(e, "model");
        const model = str(rawModel);
        const id = str(ownProp(r, "conversation_id"));
        if (id !== undefined) out.push(...this.#bind(state, id, model, backingProvider));
        // Owner decision 67: a resumed run must show the conversation it resumed; with no id nothing does.
        if (
          state.resumeNativeSessionId !== undefined &&
          state.nativeSessionId === undefined &&
          !resumeMismatch.has(state)
        ) {
          out.push({ kind: "provider_error", category: PROTOCOL_CATEGORY, message: RESUME_NO_ID_MESSAGE });
        }
        const usage = obj(ownProp(r, "usage"));
        const metrics: Record<string, number | string | null> = {};
        for (const k of USAGE_KEYS) {
          const v = ownProp(usage, k);
          if (typeof v === "number" && Number.isFinite(v) && v >= 0) metrics[k] = v;
        }
        // The envelope's usage is the run total and each `usage` event becomes one ledger row (FR-CAP-01), so only the
        // first `result` records it; a second would count the run twice.
        if (results === 1 && Object.keys(metrics).length > 0) {
          out.push({ kind: "usage", source: "provider_reported", metrics });
        }
        // `denied_actions` was an array of `{action, display_name}` ([LIVE] C7, C18). Any other present value is
        // read as a denial rather than ignored, so an unexpected shape cannot hide one.
        const rawDenied = ownProp(r, "denied_actions");
        const denied = Array.isArray(rawDenied) ? rawDenied : rawDenied === undefined || rawDenied === null ? [] : [{}];
        for (const d of denied) {
          const action = obj(d);
          out.push({
            kind: "permission_denied",
            tool: clip(str(ownProp(action, "display_name")) ?? str(ownProp(action, "action")) ?? "unknown", 64),
          });
        }
        // `error` was a string ([LIVE] C6, C10, C13); any other present value is an unknown error, never ignored.
        const rawError = ownProp(r, "error");
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
        // Q-86: `SUCCESS` with no tokens is what a print timeout returns ([LIVE] C10), so it is not a success. Own
        // property only, so a total inherited from Object.prototype is never read as a reported one (fail closed).
        const total = ownProp(metrics, "total_tokens");
        const ok = results === 1 && status === STATUS_SUCCESS && typeof total === "number" && total > 0;
        const response = str(ownProp(r, "response"));
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
   * conversation) makes the binding ambiguous, so the run fails closed; the first id stays bound. An id that is not
   * one safe token (a control character, a leading `-`, over 256 characters) binds nothing and fails the run. On a
   * resume, a first id other than the requested one is a new conversation ([LIVE] C9 run 5): it fails the run and is
   * never bound, so it cannot replace the stored binding (owner decision 67).
   */
  #bind(
    state: ParseState,
    id: string,
    model: string | undefined,
    backingProvider: string | undefined = undefined,
  ): NormalizedEvent[] {
    if (id === "") return [];
    if (!SESSION_ID_RE.test(id)) {
      return [{ kind: "provider_error", category: PROTOCOL_CATEGORY, message: "conversation id is not a safe token" }];
    }
    if (state.nativeSessionId !== undefined) {
      if (id === state.nativeSessionId) return [];
      return [{ kind: "provider_error", category: PROTOCOL_CATEGORY, message: "conversation id changed mid-run" }];
    }
    const requested = state.resumeNativeSessionId;
    if (requested !== undefined && id !== requested) {
      if (resumeMismatch.has(state)) return [];
      resumeMismatch.add(state);
      return [{ kind: "provider_error", category: PROTOCOL_CATEGORY, message: RESUME_MISMATCH_MESSAGE }];
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

  /** Tool steps become one `tool_call` each (the command or path is transient, for the guard); text deltas are dropped. */
  #step(e: Json, state: ParseState): NormalizedEvent[] {
    const stepType = str(ownProp(e, "step_type"));
    const index = ownProp(e, "step_index");
    if (stepType === undefined || typeof index !== "number") return this.#unknown(state, "step_update");
    // Every step carries the run's `conversation_id` ([H]; [LIVE] C4). A step for another conversation than the bound
    // one makes the run ambiguous, as a changed `init` or `result` id does, so the run fails closed; the step is still
    // read so the tool-call guard sees its command. A step never binds the session itself.
    const stepId = str(ownProp(e, "conversation_id"));
    const bound = state.nativeSessionId;
    const changed = stepId !== undefined && stepId !== "" && bound !== undefined && stepId !== bound;
    const tool = this.#toolStep(e, stepType, index, state);
    if (!changed) return tool;
    return [
      { kind: "provider_error", category: PROTOCOL_CATEGORY, message: "conversation id changed mid-run" },
      ...tool,
    ];
  }

  #toolStep(e: Json, stepType: string, index: number, state: ParseState): NormalizedEvent[] {
    // Only tool steps are actions; the final answer arrives whole in `result.response`, so `agent_response` deltas,
    // `user_input` and `checkpoint` steps are not kept.
    if (stepType !== STEP_TOOL) return [];
    const seen = seenToolSteps.get(state) ?? new Map<number, Set<string>>();
    seenToolSteps.set(state, seen);
    const info = obj(ownProp(e, "tool_info"));
    const name = str(ownProp(info, "name")) ?? str(ownProp(e, "tool_name")) ?? str(ownProp(e, "name")) ?? "unknown";
    // Every container is read, not only the first object one, so a benign or empty container (or key) cannot shadow a
    // command in another (fail closed). The first one found in this order is reported first.
    const containers = [
      obj(ownProp(info, "parameters")),
      obj(ownProp(info, "args")),
      obj(ownProp(info, "input")),
      obj(ownProp(e, "parameters")),
      obj(ownProp(e, "args")),
      obj(ownProp(e, "input")),
    ];
    // Assumption: the parameter names below; the live check recorded `tool_info.{name,parameters}` but not their keys.
    // Without them the guard sees no command or path for this call. Empty and non-string values are skipped. Every
    // distinct command is reported; paths are reported only when the call names no command.
    const values = (keys: readonly string[]) => [
      ...new Set(containers.flatMap((p) => keys.map((k) => str(ownProp(p, k)) ?? "").filter((v) => v !== ""))),
    ];
    const commands = values(COMMAND_KEYS);
    const keys =
      commands.length > 0 ? commands.map((c) => `command:${c}`) : values(TARGET_KEYS).map((t) => `target:${t}`);
    // A step is reported once, and again only when a later update names a command or path not yet reported for it, so
    // the tool-call guard sees every one whichever update carries `tool_info.parameters` (Assumption: not recorded)
    // and an update cannot swap a reported command for an unchecked one.
    const reported = seen.get(index);
    const fresh = reported === undefined ? keys : keys.filter((k) => !reported.has(k));
    if (reported === undefined) seen.set(index, new Set(keys));
    else for (const k of fresh) reported.add(k);
    const call = (key: string | undefined): NormalizedEvent => ({
      kind: "tool_call",
      tool: key?.startsWith("command:") ? "shell" : "other",
      name: clip(name, 64),
      ...(key?.startsWith("command:") ? { command: key.slice("command:".length) } : {}),
      ...(key?.startsWith("target:") ? { target: clip(key.slice("target:".length), MAX_TARGET_CHARS) } : {}),
    });
    if (reported === undefined && fresh.length === 0) return [call(undefined)];
    return fresh.map(call);
  }

  #unknown(state: ParseState, rawType: string): NormalizedEvent[] {
    state.unknownEvents += 1;
    return [{ kind: "unknown", rawType: clip(rawType, 64) }];
  }

  /**
   * Success needs a clean expected exit and a final `result` with `ok` (status `SUCCESS` and reported tokens, Q-86) and
   * no `provider_error`, `permission_denied`, `sandbox_violation` or `rate_limit` event and no `tool_call` the tool-call
   * guard flagged with a `violation` (fail closed; a soft denial and a print timeout both exit 0 with `SUCCESS`, [LIVE]
   * C7, C10; a guard verdict ends the run in every run, bypass included, ADR-0039), and no `tool_call` after the
   * `result` line (as Grok Build, Cursor and OpenCode).
   */
  extractResult(events: readonly NormalizedEvent[], exit: ExitInfo): RunResult {
    const unknownEventCount = events.filter((e) => e.kind === "unknown").length;
    const bound = events.find((e) => e.kind === "session_bound");
    const nativeSessionId = bound?.kind === "session_bound" ? bound.nativeSessionId : undefined;
    const text = events.flatMap((e) => (e.kind === "message" ? [e.text] : [])).join("\n");
    const summary = text === "" ? undefined : text.slice(-MAX_SUMMARY_CHARS);
    const finalAt = events.findLastIndex((e) => e.kind === "result");
    const final = events[finalAt];
    // Proposed (fail closed): `result` was the last line of the recorded stream ([LIVE] C4), so a tool call after it
    // means the run did not end on that result.
    const trailingTool = finalAt >= 0 && events.slice(finalAt + 1).some((e) => e.kind === "tool_call");
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
    // The adapter contract gives `extractResult` the events and the exit only (LLD §2), so the stderr tail is empty
    // here and the T6.15 `AGY_ERROR` mapping is not reached on this path: a live exit-3 quota stop stays `TOOL_FAILURE`
    // `exit code 3` until `startAdapterRun` (`src/adapters/run.ts`) passes the tail it already captures. Pinned by
    // `limit-signals.test.ts`.
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

  /**
   * The shared precedence (`classifyCommon`), then the T6.15 limit mapping: when nothing more specific than
   * `TOOL_FAILURE` was found and the run exited {@link AGY_ERROR_EXIT} with a structured `AGY_ERROR: {...}` line in the
   * stderr tail, its `status` selects the category ({@link AGY_ERROR_STATUS_CATEGORIES}). Every more specific verdict
   * (cancel, timeout, crash, the tool-call guard, a denial, an auth or model error, a protocol anomaly) stands.
   */
  classifyFailure(evidence: FailureEvidence): FailureClassification {
    const common = classifyCommon(evidence, CATEGORY_CODES);
    if (common.code !== "TOOL_FAILURE") return common;
    return agyErrorClassification(evidence) ?? common;
  }
}

/**
 * T6.15 (FR-CAP-11, FR-ADP-04): the last stderr line that starts with {@link AGY_ERROR_PREFIX}, parsed as one JSON
 * object; only the own properties `status`, `error_code` and `retryable` are read (never `short_error` or `error_id`).
 * Requires the documented exit code (TDD §4.4: exit 3 comes with the line), so a line printed by something else in an
 * otherwise normal exit changes nothing. Anything that is not exactly that shape (another exit code, a truncated tail,
 * a non-object, an unmapped or non-string status) is `undefined`: fail closed to the common verdict.
 */
export function agyErrorClassification(evidence: FailureEvidence): FailureClassification | undefined {
  const { exit } = evidence;
  if (exit.outcome !== "exited" || exit.exitCode !== AGY_ERROR_EXIT) return undefined;
  const line = evidence.stderrTail
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
    .findLast((l) => l.startsWith(AGY_ERROR_PREFIX));
  if (line === undefined) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(line.slice(AGY_ERROR_PREFIX.length));
  } catch {
    return undefined;
  }
  const o = obj(doc);
  const status = str(ownProp(o, "status"));
  if (status === undefined) return undefined;
  const category = Object.hasOwn(AGY_ERROR_STATUS_CATEGORIES, status) ? AGY_ERROR_STATUS_CATEGORIES[status] : undefined;
  const code = category === undefined ? undefined : CATEGORY_CODES[category as keyof typeof CATEGORY_CODES];
  if (category === undefined || code === undefined) return undefined;
  const errorCode = ownProp(o, "error_code");
  const retryable = ownProp(o, "retryable");
  const parts = [
    `AGY_ERROR status ${clip(status, 64)}`,
    ...(typeof errorCode === "number" && Number.isFinite(errorCode) ? [`error_code ${errorCode}`] : []),
    ...(typeof retryable === "boolean" ? [`retryable ${retryable}`] : []),
  ];
  return { code, detail: `${category}: ${parts.join(", ")}` };
}
