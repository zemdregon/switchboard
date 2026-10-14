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
 * - parser, auth preflight and resume fail closed until T4.33 and T4.34. The manifest range admits no version, so none
 *   of this runs before `adapters validate` passes a version.
 */
import {
  DEFAULT_IDLE_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_WALL_CLOCK_MS,
} from "../../exec/index.js";
import { resolveOnPath } from "../codex/adapter.js";
import { classifyCommon } from "../failure.js";
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
  GIT_WRITE_CONTROL_DETAIL,
  HELP_FLAG,
  NON_PRIVILEGED_UNSUPPORTED_DETAIL,
  OUTPUT_FORMAT_FLAG,
  OUTPUT_STREAM_JSON,
  PROMPT_FLAG,
  REQUIRED_HELP_FLAGS,
  SKIP_PERMISSIONS_FLAG,
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

const ineligible = (reason: Ineligible["reason"], detail: string): Ineligible => ({ ineligible: true, reason, detail });

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

  /** FR-SES-03: resume arrives with the parser (T4.33); a binding of another provider is never compiled. */
  resumeArgs(binding: NativeBinding, _request: CompileRequest, _profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== "antigravity") {
      return ineligible("CAPABILITY_MISSING", `binding is for ${binding.provider}`);
    }
    return ineligible(
      "CAPABILITY_MISSING",
      "Antigravity resume is not compiled until its parser records the conversation id (T4.33)",
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

  /** T4.33 writes the parser from captures; until then nothing is recognised and a clean exit cannot succeed. */
  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[] {
    if (typeof input !== "string") return [];
    state.lines += 1;
    state.unknownEvents += 1;
    return [{ kind: "unknown", rawType: "unparsed" }];
  }

  /** Never success before the parser exists (T4.33): a result needs a `result` event, which nothing emits yet. */
  extractResult(events: readonly NormalizedEvent[], exit: ExitInfo): RunResult {
    const unknownEventCount = events.filter((e) => e.kind === "unknown").length;
    const c = this.classifyFailure({
      events,
      exit,
      stderrTail: "",
      timedOut: exit.outcome === "timeout",
      cancelled: exit.outcome === "cancelled",
    });
    return { ok: false, failureCode: c.code, failureDetail: c.detail, unknownEventCount };
  }

  classifyFailure(evidence: FailureEvidence): FailureClassification {
    return classifyCommon(evidence);
  }
}
