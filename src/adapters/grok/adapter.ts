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
 *   together, never one without the other ([R2] L613 to L615): `--always-approve` always with `--sandbox`;
 * - parser, auth preflight, resume and the tool-call guard declaration are T4.23, T4.24 and T4.27: until then no
 *   event is parsed (a run that exits cleanly ends `OUTPUT_PROTOCOL_ERROR`), the auth state is `UNKNOWN` and resume is
 *   `Ineligible`, all fail closed. The manifest range admits no version, so none of this runs before
 *   `adapters validate` passes a version.
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
  ALWAYS_APPROVE_FLAG,
  GIT_WRITE_CONTROL_DETAIL,
  GROK_BINARY,
  HELP_FLAG,
  NO_AUTO_UPDATE_FLAG,
  NON_PRIVILEGED_UNSUPPORTED_DETAIL,
  OUTPUT_FORMAT_FLAG,
  OUTPUT_STREAMING_JSON,
  REQUIRED_HELP_FLAGS,
  SANDBOX_FLAG,
  SANDBOX_READ_ONLY,
  SANDBOX_STRICT,
  SANDBOX_WORKSPACE,
  SINGLE_FLAG,
  VERSION_ARGS,
} from "./protocol.js";

/**
 * Environment names passed through to Grok Build (FR-EXE-07, NFR-SEC-02). Proposed: `PATH` for the binary and `HOME`
 * so the CLI finds its own native login. `GROK_HOME` (would hide the login), `XAI_API_KEY` and `GROK_SANDBOX` stay out
 * (ADR-0003; the sandbox is a flag so the audit sees it).
 */
export const GROK_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME"];

const PROBE_TIMEOUT_MS = 10_000;

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

const ineligible = (reason: Ineligible["reason"], detail: string): Ineligible => ({ ineligible: true, reason, detail });

export class GrokAdapter implements ProviderAdapter {
  readonly id = "grok" as const;
  readonly transports = ["subprocess-jsonl"] as const;
  readonly gitWriteControl = GROK_GIT_WRITE_CONTROL;
  /** TDD §4.10: `-r <id>` resumed from a second directory ([LIVE] 14a), still `Unverified: T5.12`. */
  readonly resumeCwd = "unverified" as const;
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

  /** T4.24 supplies the auth preflight; until then fail closed (NFR-SEC-06). Never reads a credential file. */
  async authPreflight(_runner: ProbeRunner): Promise<AuthResult> {
    return {
      state: "UNKNOWN",
      reason: "Grok Build auth preflight is not implemented (T4.24); no status command exits non-zero when logged out",
    };
  }

  compile(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    return this.#build(request, profile, []);
  }

  /** FR-SES-03: resume arrives with the parser (T4.23); a binding of another provider is never compiled. */
  resumeArgs(binding: NativeBinding, _request: CompileRequest, _profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== "grok") return ineligible("CAPABILITY_MISSING", `binding is for ${binding.provider}`);
    return ineligible(
      "CAPABILITY_MISSING",
      "Grok Build resume is not compiled until its parser records the session id (T4.23)",
    );
  }

  /**
   * Pure. Order of checks (the first unmet one is the reason):
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
   * 7. a requested model: CAPABILITY_MISSING (the model registry has no Grok data yet, T4.5; `-m` is not emitted).
   * Then the sandbox profile: read-only files or workspace `read-only`; worktree files with network `off` `strict`,
   * with network `on` `workspace`; `--disable-web-search` with network `off`.
   */
  #build(request: CompileRequest, profile: ResolvedProfile, tail: string[]): Invocation | Ineligible {
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
    if (request.model !== undefined) {
      return ineligible("CAPABILITY_MISSING", "no model registry data for Grok Build yet (T4.5; -m is not emitted)");
    }
    if (this.#exe === undefined) return ineligible("CAPABILITY_MISSING", `${GROK_BINARY} not found on PATH`);

    const sandbox = readOnly ? SANDBOX_READ_ONLY : network === "off" ? SANDBOX_STRICT : SANDBOX_WORKSPACE;
    const policyFlags = [
      SANDBOX_FLAG,
      sandbox,
      ...(network === "off" ? ["--disable-web-search"] : []),
      ALWAYS_APPROVE_FLAG,
    ];
    return {
      transport: "subprocess-jsonl",
      // `--single=<prompt>` is one argv word, so a prompt that starts with `-` can never be read as a flag (Assumption:
      // the `=` form is accepted; [LIVE] step 1 shows clap-style errors). The prompt is visible in the process list.
      argv: [
        this.#exe,
        ...this.#launcher,
        NO_AUTO_UPDATE_FLAG,
        `${SINGLE_FLAG}=${request.objective}`,
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

  /** T4.23 writes the parser from captures; until then nothing is recognised and a clean exit cannot succeed. */
  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[] {
    if (typeof input !== "string") return [];
    state.lines += 1;
    state.unknownEvents += 1;
    return [{ kind: "unknown", rawType: "unparsed" }];
  }

  /** Never success before the parser exists (T4.23): a result needs a `result` event, which nothing emits yet. */
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
