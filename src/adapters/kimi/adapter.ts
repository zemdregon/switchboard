/**
 * Kimi Code adapter (T4.62, TDD §4.7, ADR-0049; module, probe, compile matrix and registry entry; Delegated, not
 * owner-approved). Two native surfaces, one process per run (ADR-0049 items 1 and 2):
 * - `kimi --prompt=<prompt> --output-format stream-json` (subprocess JSONL), which is always Never Ask and therefore
 *   bypass-class: compiled only for an approved `privileged` scope that sets `bypass`, with no deny rule, agent file,
 *   tool list or other restriction added (the bypass run stays unrestricted, as the owner requires);
 * - `kimi acp` (ACP over stdio through the ADR-0036 client) for every restricted run: `session/new` with no
 *   `mcpServers`, the mode set to `plan` for read-only files and left at `default` otherwise, and every
 *   `session/request_permission` answered by the controller (`decidePermission`, ADR-0039 guard). `auto` and `yolo`
 *   are never set (declared bypass-class in the registry entry, so the plan audit refuses them too).
 * The adapter never reads Kimi credential or configuration files, never runs `kimi login` or `kimi acp --login`, never
 * writes provider configuration, never passes `--yolo`, `-y`, `--auto`, `--plan`, `--continue`, `--agent`,
 * `--agent-file`, `--skills-dir` or `--add-dir`, and keeps `KIMI_CODE_HOME` out of the environment.
 *
 * Compile matrix (Proposed, fail closed; Delegated decisions, T4.62):
 * - the four non-`privileged` profiles are `Ineligible: PROFILE_UNSUPPORTED`: no sandbox or network control exists, and
 *   repository configuration cannot be disabled ({@link NON_PRIVILEGED_UNSUPPORTED_DETAIL});
 * - `privileged` with `bypass` and an approval: `--prompt`, only for the scope Kimi Code cannot narrow below under
 *   Never Ask (worktree files, shell `broad`, network `on`, repository configuration `enabled`; as Cursor, Q-79);
 * - `privileged` without `bypass`: ACP, only with network `on` and repository configuration `enabled` (neither can be
 *   narrowed per run); files `read-only` compile mode `plan`, `worktree` the default mode; the shell scope is enforced
 *   by the controller's permission answers. If T4.68 shows `default` mode does not ask, this cell becomes `Ineligible`
 *   and Kimi Code is privileged-bypass only (ADR-0049 item 3).
 * Parser, result and resume (T4.63) and the auth preflight (T4.64) are fail-closed placeholders. The manifest range
 * admits no version, so none of this runs before `adapters validate` passes a version (FR-ADP-09, T4.68).
 */
import {
  DEFAULT_IDLE_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_WALL_CLOCK_MS,
} from "../../exec/index.js";
import { resolveOnPath } from "../codex/adapter.js";
import { classifyCommon } from "../failure.js";
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
  ACP_CONFIG_MODEL,
  ACP_MODE_PLAN,
  ACP_SUBCOMMAND,
  GIT_WRITE_CONTROL_DETAIL,
  HELP_FLAG,
  KIMI_BINARY,
  KIMI_LOGIN_COMMAND,
  MODEL_FLAG,
  NON_PRIVILEGED_UNSUPPORTED_DETAIL,
  OUTPUT_FORMAT_FLAG,
  OUTPUT_STREAM_JSON,
  PROMPT_FLAG,
  REQUIRED_HELP_FLAGS,
  VERSION_ARGS,
} from "./protocol.js";

/**
 * Environment names passed through to Kimi Code (FR-EXE-07, NFR-SEC-02). Proposed: `PATH` for the binary and `HOME` so
 * the CLI finds its own native login. `KIMI_CODE_HOME` (relocates configuration, sessions and credentials, [K10]) stays
 * out.
 */
export const KIMI_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME"];

const PROBE_TIMEOUT_MS = 10_000;
/** A model alias passed as one argv word or config value; refuse anything that could be read as a flag (Proposed). */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/;

/** FR-GIT-01 (ADR-0039, ADR-0049 item 5): no per-run deny control is compiled; see protocol.ts. */
export const KIMI_GIT_WRITE_CONTROL: GitWriteControl = {
  kind: "none-documented",
  detail: GIT_WRITE_CONTROL_DETAIL,
  remainingControls: ["FR-GIT-03", "FR-GIT-06"],
};

/** FR-GIT-09 (TDD §4.7 "Git writes and injected tools"): no channel is injected until tool exposure is observed. */
export const KIMI_GIT_CAPABILITIES: GitCapabilities = {
  commitChannel: "finalize-only",
  detail:
    "`kimi -p` has no per-run MCP flag ([K5]); ACP session/new accepts mcpServers (2026-10-15 live check) but tool " +
    "exposure is Unverified: T4.68 and no ADR accepts a Kimi ACP channel yet (ADR-0036 item 7.3), so no tool is " +
    "injected. The controller commits at FINALIZING when the project opts in (FR-GIT-09).",
};

/** Ineligible detail for a bypass approval on a profile other than `privileged` (FR-POL-03). */
export const KIMI_BYPASS_OUTSIDE_PRIVILEGED =
  "bypassApproved is set on a profile other than privileged: a bypass applies only to an approved privileged scope " +
  "(FR-POL-03, ADR-0017)";
/** Ineligible detail for a scope that sets `bypass` on a run whose approval is missing (FR-POL-03). */
export const KIMI_BYPASS_NOT_APPROVED =
  "privileged scope sets bypass but the run's bypassApproved is false: --prompt (Never Ask) is compiled only for an " +
  "approved bypass run (FR-POL-03, ADR-0017, ADR-0049)";

export interface KimiAdapterOptions {
  /** Absolute path of the kimi binary. Defaults to the first executable `kimi` on PATH, resolved once. */
  executable?: string;
  /** Test-only: arguments inserted between the executable and the flags (replay launcher). Empty in production. */
  launcherArgs?: readonly string[];
  timeouts?: Partial<Invocation["timeouts"]>;
  /** PATH used to resolve `kimi` when `executable` is absent. Defaults to process.env.PATH. */
  pathEnv?: string;
}

const ineligible = (reason: Ineligible["reason"], detail: string): Ineligible => ({ ineligible: true, reason, detail });

export class KimiAdapter implements ProviderAdapter {
  readonly id = "kimi" as const;
  readonly transports = ["subprocess-jsonl", "acp-stdio"] as const;
  readonly gitWriteControl = KIMI_GIT_WRITE_CONTROL;
  /** TDD §4.10: `Unverified` (where the session id appears and resume from another directory: T4.68). */
  readonly resumeCwd = "unverified" as const;
  /** T7.12 (FR-RTE-08): what a session reports as its model is not captured yet (T4.63, T4.68). */
  readonly reportedModelFlag = {
    kind: "not_accepted",
    detail: "the model a Kimi Code session reports is not captured yet (Unverified: T4.68)",
  } as const;
  readonly gitCapabilities = KIMI_GIT_CAPABILITIES;
  readonly #exe: string | undefined;
  readonly #launcher: readonly string[];
  readonly #timeouts: Invocation["timeouts"];

  constructor(opts: KimiAdapterOptions = {}) {
    this.#exe = opts.executable ?? resolveOnPath(KIMI_BINARY, opts.pathEnv ?? process.env.PATH);
    this.#launcher = [...(opts.launcherArgs ?? [])];
    this.#timeouts = {
      wallClockMs: DEFAULT_WALL_CLOCK_MS,
      idleMs: DEFAULT_IDLE_MS,
      killGraceMs: DEFAULT_KILL_GRACE_MS,
      ...opts.timeouts,
    };
  }

  /**
   * FR-ADP-02 steps 1 to 5 with no model call: `kimi --version` ([LIVE] 1: `2.1.1`), then `--help` for the required
   * flags and the `acp` subcommand ([LIVE] 2). Output is probe evidence only (FR-ADP-04). The ACP `initialize` is not
   * sent here: it belongs to the auth preflight (T4.64, ADR-0049 item 4).
   */
  async probe(runner: ProbeRunner): Promise<ProbeResult> {
    const exe = this.#exe;
    if (exe === undefined) {
      return {
        binaryPath: KIMI_BINARY,
        binaryVersion: null,
        steps: [{ step: "binary", ok: false, detail: `${KIMI_BINARY} not found on PATH` }],
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
    const helpOk = help.spawnError === undefined && !help.timedOut && help.exitCode === 0;
    const flags = new Set(helpOk ? (help.stdout.match(/--[a-z][a-z0-9-]*/g) ?? []) : []);
    // The `acp` subcommand is listed at the start of a help line ([LIVE] 2, 4; exact layout an Assumption).
    const acpListed = helpOk && new RegExp(`^\\s*${ACP_SUBCOMMAND}\\b`, "m").test(help.stdout);
    const commandOk = helpOk && acpListed;
    const missing = REQUIRED_HELP_FLAGS.filter((f) => !flags.has(f));
    steps.push(
      {
        step: "command",
        ok: commandOk,
        ...(commandOk
          ? {}
          : { detail: helpOk ? `\`${ACP_SUBCOMMAND}\` subcommand not listed` : `\`${HELP_FLAG}\` unavailable` }),
      },
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

  /** FR-AUTH-01/02: the ACP probe of ADR-0049 item 4 arrives with T4.64; until then the state is unknown (fail closed). */
  async authPreflight(_runner: ProbeRunner): Promise<AuthResult> {
    return {
      state: "UNKNOWN",
      reason: "Kimi Code auth preflight is not implemented (T4.64); no status command exists ([LIVE] 2, 6)",
    };
  }

  compile(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    return this.#build(request, profile);
  }

  /** FR-SES-03: resume arrives with the parser (T4.63); a binding of another provider is never compiled. */
  resumeArgs(binding: NativeBinding, _request: CompileRequest, _profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== "kimi") return ineligible("CAPABILITY_MISSING", `binding is for ${binding.provider}`);
    return ineligible(
      "CAPABILITY_MISSING",
      "Kimi Code resume is not compiled until its parser records the session id (T4.63)",
    );
  }

  /**
   * Pure. Order of checks (the first unmet one is the reason):
   * 0. shell allowlist entries that could write Git: PROFILE_UNSUPPORTED (FR-GIT-01);
   * 1. a bypass approval on a profile other than `privileged`: PROFILE_UNSUPPORTED (FR-POL-03);
   * 2. any profile other than `privileged`: PROFILE_UNSUPPORTED ({@link NON_PRIVILEGED_UNSUPPORTED_DETAIL});
   * 3. `privileged` without a scope binding: PROFILE_UNSUPPORTED; `bypass: true` without an approval: PROFILE_UNSUPPORTED
   *    (FR-POL-03);
   * 4. network other than `on`: CAPABILITY_MISSING (no network control on either surface);
   * 5. repository_config other than `enabled`: CAPABILITY_MISSING (no per-run flag disables project configuration and
   *    the CLI has no per-item approval; owner decision 26, Q-37, allows `enabled`);
   * 6. a requested model that is not a safe single word: CAPABILITY_MISSING;
   * 7. bypass: read-only files or shell other than `broad`: CAPABILITY_MISSING (Never Ask runs every tool call);
   * then the bypass cell compiles `--prompt` and the restricted cell compiles ACP.
   */
  #build(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    const gitWrites = gitWriteRisks(profile.shellAllowlist ?? []);
    if (gitWrites.length > 0) {
      return ineligible(
        "PROFILE_UNSUPPORTED",
        `shell allowlist entries could write Git (FR-GIT-01): ${gitWrites.map((g) => g.command).join("; ")}`,
      );
    }
    const approved = profile.bypassApproved || request.bypassApproved === true;
    if (profile.name !== "privileged") {
      if (approved) return ineligible("PROFILE_UNSUPPORTED", KIMI_BYPASS_OUTSIDE_PRIVILEGED);
      return ineligible("PROFILE_UNSUPPORTED", `${profile.name}: ${NON_PRIVILEGED_UNSUPPORTED_DETAIL}`);
    }
    const scope = profile.privilegedScope?.scope;
    if (scope === undefined) {
      return ineligible("PROFILE_UNSUPPORTED", "privileged without an approved scope binding (LLD §3.1)");
    }
    if (scope.bypass && !approved) return ineligible("PROFILE_UNSUPPORTED", KIMI_BYPASS_NOT_APPROVED);
    if (scope.network.mode !== "on") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged network=${scope.network.mode}: Kimi Code has no sandbox or network control (TDD §4.7)`,
      );
    }
    if (scope.repository_config.mode !== "enabled") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged repository_config=${scope.repository_config.mode}: the project's .kimi-code/mcp.json, local.toml ` +
          "and agent files load once the workspace is trusted ([K4], [K5]) and no per-run flag or per-item approval " +
          "exists; owner decision 26 (Q-37) allows `enabled`",
      );
    }
    if (request.model !== undefined && !MODEL_RE.test(request.model)) {
      return ineligible("CAPABILITY_MISSING", "requested model is not a safe single argument");
    }
    const readOnly = scope.files.access === "read-only" || !request.workspace.writable;
    if (scope.bypass) {
      if (readOnly) {
        return ineligible(
          "CAPABILITY_MISSING",
          "privileged read-only files with bypass: `kimi -p` never asks and has no read-only control ([LIVE] 3: it " +
            "rejects --plan), so nothing keeps the run read-only",
        );
      }
      if (scope.shell.mode !== "broad") {
        return ineligible(
          "CAPABILITY_MISSING",
          `privileged shell=${scope.shell.mode} with bypass: \`kimi -p\` never asks and no per-run permission-rule ` +
            "flag exists ([LIVE] 2)",
        );
      }
    }
    if (this.#exe === undefined) return ineligible("CAPABILITY_MISSING", `${KIMI_BINARY} not found on PATH`);
    return scope.bypass ? this.#bypassInvocation(request) : this.#acpInvocation(request, readOnly);
  }

  /** ADR-0049 item 1: exactly the prompt, the output format and an optional model; nothing restricts the run. */
  #bypassInvocation(request: CompileRequest): Invocation {
    const exe = this.#exe as string;
    const policyFlags = [PROMPT_FLAG];
    return {
      transport: "subprocess-jsonl",
      // One word each (Assumption, see protocol.ts): the prompt is visible in the process list.
      argv: [
        exe,
        ...this.#launcher,
        ...(request.model !== undefined ? [`${MODEL_FLAG}=${request.model}`] : []),
        `${PROMPT_FLAG}=${request.objective}`,
        OUTPUT_FORMAT_FLAG,
        OUTPUT_STREAM_JSON,
      ],
      env: {},
      envAllowlist: [...KIMI_ENV_ALLOWLIST],
      cwd: request.workspace.cwd,
      stdin: { kind: "none" },
      outputFormat: "jsonl",
      timeouts: { ...this.#timeouts },
      policyFlags,
      expectedExitCodes: [0],
      maxLineBytes: DEFAULT_MAX_LINE_BYTES,
    };
  }

  /** ADR-0049 item 2: `kimi acp`; the plan carries the prompt, so neither argv nor stdin holds it. */
  #acpInvocation(request: CompileRequest, readOnly: boolean): Invocation {
    const exe = this.#exe as string;
    return {
      transport: "acp-stdio",
      argv: [exe, ...this.#launcher, ACP_SUBCOMMAND],
      env: {},
      envAllowlist: [...KIMI_ENV_ALLOWLIST],
      cwd: request.workspace.cwd,
      stdin: { kind: "none" },
      outputFormat: "acp",
      timeouts: { ...this.#timeouts },
      policyFlags: [],
      expectedExitCodes: [0],
      maxLineBytes: DEFAULT_MAX_LINE_BYTES,
      acp: {
        protocolVersion: 1,
        prompt: request.objective,
        session: { kind: "new" },
        mcpServers: [],
        // `default` is the session's starting mode ([LIVE] 9), so it is not sent.
        ...(readOnly ? { modeId: ACP_MODE_PLAN } : {}),
        ...(request.model !== undefined
          ? { configOptions: [{ configId: ACP_CONFIG_MODEL, value: request.model }] }
          : {}),
        loginCommand: KIMI_LOGIN_COMMAND,
      },
    };
  }

  /** T4.63 writes the parser from captures; until then nothing is recognised and a clean exit cannot succeed. */
  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[] {
    if (typeof input === "string") state.lines += 1;
    state.unknownEvents += 1;
    return [{ kind: "unknown", rawType: "unparsed" }];
  }

  /** Never success before the parser exists (T4.63): a result needs a `result` event, which nothing emits yet. */
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
