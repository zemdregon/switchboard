/**
 * OpenCode adapter (T4.52, TDD §4.6; module, probe, compile matrix and registry entry; Delegated, not owner-approved).
 * Native surface: one process per run, `opencode run --format json --standalone -- <prompt>` (TDD §4.6 "Transport
 * decision"; `--standalone` keeps the run's tools in a private server inside the run's process group instead of the
 * host's shared background service, [LIVE] ESCAPED). The adapter never reads OpenCode credential or configuration files
 * (`auth.json`, `mcp-auth.json`, `.env`), never runs `auth login`, `auth list` output into logs or `auth export`, never
 * writes provider configuration, never sets `OPENCODE_PERMISSION` or `OPENCODE_CONFIG_CONTENT` (ignored on v2.0.23, Q-64),
 * and never emits `--auto`, `--continue`, `--fork`, `--server`, `--share` or `--model`.
 *
 * Compile matrix (Proposed, fail closed; Delegated decisions from the 2026-10-14 live check, Q-64 and Q-83):
 * - the four non-`privileged` profiles are `Ineligible: PROFILE_UNSUPPORTED`: no per-run deny took effect, the default
 *   runs every shell command, no sandbox is documented and repository configuration loads (FR-POL-02, FR-POL-06);
 * - `privileged` compiles only when its scope sets `bypass` and the run is approved (owner decision 46), and only for
 *   the scope OpenCode cannot narrow below: worktree files, shell `broad`, network `on` and repository configuration
 *   `enabled`. Its invocation adds no bypass flag: the observed default already runs shell and edits without asking,
 *   and `--auto` would only widen what is refused by default (out-of-tree paths, [LIVE] 11), so it is not emitted
 *   (Q-83). OpenCode confines nothing in that run; what remains is the controller's worktree, the tool-call guard
 *   (ADR-0039), FR-GIT-03 and FR-GIT-06;
 * - parser, auth preflight and resume fail closed until T4.53 and T4.54. The manifest range admits no version, so none
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
  DISABLE_AUTOUPDATE_ENV,
  END_OF_OPTIONS,
  FORMAT_FLAG,
  FORMAT_JSON,
  GIT_WRITE_CONTROL_DETAIL,
  NON_PRIVILEGED_UNSUPPORTED_DETAIL,
  OPENCODE_BINARY,
  REQUIRED_HELP_FLAGS,
  RUN_COMMAND,
  RUN_HELP_ARGS,
  STANDALONE_FLAG,
  VERSION_ARGS,
} from "./protocol.js";

/**
 * Environment names passed through to OpenCode (FR-EXE-07, NFR-SEC-02). Proposed: `PATH` for the binary and `HOME` so
 * the CLI finds its own native login. Provider keys (OpenCode loads "any keys defined in your environments", [D-cli];
 * [LIVE] 2f), `OPENCODE_PERMISSION`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG` and the `XDG_*` directories stay out.
 */
export const OPENCODE_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME"];

const PROBE_TIMEOUT_MS = 10_000;

/** FR-GIT-01 (ADR-0039): no per-run deny took effect on v2.0.23; see protocol.ts. */
export const OPENCODE_GIT_WRITE_CONTROL: GitWriteControl = {
  kind: "none-documented",
  detail: GIT_WRITE_CONTROL_DETAIL,
  remainingControls: ["FR-GIT-03", "FR-GIT-06"],
};

/** FR-GIT-09 (TDD §4.6 "Git writes and injected tools"): a per-run MCP entry was not exercised ([LIVE] 9). */
export const OPENCODE_GIT_CAPABILITIES: GitCapabilities = {
  commitChannel: "finalize-only",
  detail:
    "A per-run MCP server would travel in OPENCODE_CONFIG_CONTENT, which v2.0.23 did not apply to permissions and " +
    "whose MCP handling was not exercised (2026-10-14 live check row 9), so no tool is injected. The controller " +
    "commits at FINALIZING when the project opts in (FR-GIT-09).",
};

/** Ineligible detail for a bypass approval on a profile other than `privileged` (FR-POL-03). */
export const OPENCODE_BYPASS_OUTSIDE_PRIVILEGED =
  "bypassApproved is set on a profile other than privileged: a bypass applies only to an approved privileged scope " +
  "(FR-POL-03, ADR-0017)";
/** Ineligible detail for a `privileged` scope without `bypass`: no non-bypass cell is shown to hold (Q-64). */
export const OPENCODE_PRIVILEGED_NEEDS_BYPASS =
  "privileged without bypass: OpenCode compiles only an approved bypass scope until a per-run permission set is " +
  "shown to take effect (Q-64, TDD §4.6.4)";
/** Ineligible detail for a scope that sets `bypass` on a run whose approval is missing (FR-POL-03). */
export const OPENCODE_BYPASS_NOT_APPROVED =
  "privileged scope sets bypass but the run's bypassApproved is false: the unrestricted invocation is compiled only " +
  "for an approved bypass run (FR-POL-03, ADR-0017)";

export interface OpenCodeAdapterOptions {
  /** Absolute path of the opencode binary. Defaults to the first executable `opencode` on PATH, resolved once. */
  executable?: string;
  /** Test-only: arguments inserted between the executable and the flags (replay launcher). Empty in production. */
  launcherArgs?: readonly string[];
  timeouts?: Partial<Invocation["timeouts"]>;
  /** PATH used to resolve `opencode` when `executable` is absent. Defaults to process.env.PATH. */
  pathEnv?: string;
}

const ineligible = (reason: Ineligible["reason"], detail: string): Ineligible => ({ ineligible: true, reason, detail });

export class OpenCodeAdapter implements ProviderAdapter {
  readonly id = "opencode" as const;
  readonly transports = ["subprocess-jsonl"] as const;
  readonly gitWriteControl = OPENCODE_GIT_WRITE_CONTROL;
  /** TDD §4.10: `Unverified: T4.51` (`--session <id>` resumed from another directory, [LIVE] 15a). */
  readonly resumeCwd = "unverified" as const;
  readonly gitCapabilities = OPENCODE_GIT_CAPABILITIES;
  readonly #exe: string | undefined;
  readonly #launcher: readonly string[];
  readonly #timeouts: Invocation["timeouts"];

  constructor(opts: OpenCodeAdapterOptions = {}) {
    this.#exe = opts.executable ?? resolveOnPath(OPENCODE_BINARY, opts.pathEnv ?? process.env.PATH);
    this.#launcher = [...(opts.launcherArgs ?? [])];
    this.#timeouts = {
      wallClockMs: DEFAULT_WALL_CLOCK_MS,
      idleMs: DEFAULT_IDLE_MS,
      killGraceMs: DEFAULT_KILL_GRACE_MS,
      ...opts.timeouts,
    };
  }

  /**
   * FR-ADP-02 steps 1 to 5 with no model call: `opencode --version`, then `opencode run --help` for the required
   * flags. Output is probe evidence only (FR-ADP-04). Step 7 (the structured-output smoke call) is not run here.
   */
  async probe(runner: ProbeRunner): Promise<ProbeResult> {
    const exe = this.#exe;
    if (exe === undefined) {
      return {
        binaryPath: OPENCODE_BINARY,
        binaryVersion: null,
        steps: [{ step: "binary", ok: false, detail: `${OPENCODE_BINARY} not found on PATH` }],
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

    const help = await run(...RUN_HELP_ARGS);
    const commandOk = help.spawnError === undefined && !help.timedOut && help.exitCode === 0;
    const flags = new Set(commandOk ? (help.stdout.match(/--[a-z][a-z0-9-]*/g) ?? []) : []);
    const missing = REQUIRED_HELP_FLAGS.filter((f) => !flags.has(f));
    steps.push(
      {
        step: "command",
        ok: commandOk,
        ...(commandOk ? {} : { detail: `\`${RUN_HELP_ARGS.join(" ")}\` unavailable` }),
      },
      {
        step: "output_format",
        ok: flags.has(FORMAT_FLAG),
        ...(flags.has(FORMAT_FLAG) ? {} : { detail: FORMAT_FLAG }),
      },
      {
        step: "flags",
        ok: missing.length === 0,
        ...(missing.length ? { detail: `missing ${missing.join(" ")}` } : {}),
      },
    );
    return { binaryPath: exe, binaryVersion: version, steps };
  }

  /** T4.54 supplies the auth preflight; until then fail closed (NFR-SEC-06). Never reads a credential file. */
  async authPreflight(_runner: ProbeRunner): Promise<AuthResult> {
    return {
      state: "UNKNOWN",
      reason: "OpenCode auth preflight is not implemented (T4.54); `opencode auth list` exits 0 in every login state",
    };
  }

  compile(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    return this.#build(request, profile, []);
  }

  /** FR-SES-03: resume arrives with the parser (T4.53); a binding of another provider is never compiled. */
  resumeArgs(binding: NativeBinding, _request: CompileRequest, _profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== "opencode") return ineligible("CAPABILITY_MISSING", `binding is for ${binding.provider}`);
    return ineligible(
      "CAPABILITY_MISSING",
      "OpenCode resume is not compiled until its parser records the session id (T4.53)",
    );
  }

  /**
   * Pure. Order of checks (the first unmet one is the reason):
   * 1. a bypass approval on a profile other than `privileged`: PROFILE_UNSUPPORTED (FR-POL-03);
   * 2. any profile other than `privileged`: PROFILE_UNSUPPORTED ({@link NON_PRIVILEGED_UNSUPPORTED_DETAIL});
   * 3. `privileged`: no scope binding, or `bypass: false`: PROFILE_UNSUPPORTED; `bypass: true` without an approval:
   *    PROFILE_UNSUPPORTED (FR-POL-03);
   * 4. read-only files (scope or workspace): CAPABILITY_MISSING (no per-run deny took effect, Q-64; no sandbox);
   * 5. shell other than `broad`: CAPABILITY_MISSING (the default runs every shell command, [LIVE] 6a, 7);
   * 6. network other than `on`: CAPABILITY_MISSING (no network control and no sandbox, TDD §4.6);
   * 7. repository_config `disabled` or `approved`: CAPABILITY_MISSING (a repository's `opencode.json` and `AGENTS.md`
   *    load, [LIVE] 10a, 10c, and no documented flag ignores them); only `enabled` compiles (owner decision 26, Q-37);
   * 8. a requested model: CAPABILITY_MISSING (the model registry has no OpenCode data yet, T4.5; `--model` is not
   *    emitted, so the operator's configured default model runs).
   */
  #build(request: CompileRequest, profile: ResolvedProfile, tail: string[]): Invocation | Ineligible {
    if (profile.name !== "privileged") {
      if (profile.bypassApproved || request.bypassApproved === true) {
        return ineligible("PROFILE_UNSUPPORTED", OPENCODE_BYPASS_OUTSIDE_PRIVILEGED);
      }
      return ineligible("PROFILE_UNSUPPORTED", `${profile.name}: ${NON_PRIVILEGED_UNSUPPORTED_DETAIL}`);
    }
    const scope = profile.privilegedScope?.scope;
    if (scope === undefined) {
      return ineligible("PROFILE_UNSUPPORTED", "privileged without an approved scope binding (LLD §3.1)");
    }
    if (!scope.bypass) return ineligible("PROFILE_UNSUPPORTED", OPENCODE_PRIVILEGED_NEEDS_BYPASS);
    if (!(profile.bypassApproved || request.bypassApproved === true)) {
      return ineligible("PROFILE_UNSUPPORTED", OPENCODE_BYPASS_NOT_APPROVED);
    }
    if (scope.files.access === "read-only" || !request.workspace.writable) {
      return ineligible(
        "CAPABILITY_MISSING",
        "privileged read-only files: no per-run deny took effect on opencode v2.0.23 and no sandbox is documented, " +
          "so nothing keeps the run read-only (Q-64)",
      );
    }
    if (scope.shell.mode !== "broad") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged shell=${scope.shell.mode}: OpenCode's default runs every shell command and no per-run rule took ` +
          "effect (Q-64)",
      );
    }
    if (scope.network.mode !== "on") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged network=${scope.network.mode}: no network control and no sandbox is documented (TDD §4.6)`,
      );
    }
    if (scope.repository_config.mode !== "enabled") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged repository_config=${scope.repository_config.mode}: a repository's opencode.json and AGENTS.md ` +
          "load and no documented flag ignores them; owner decision 26 (Q-37) allows `enabled` in an approved bypass run",
      );
    }
    if (request.model !== undefined) {
      return ineligible("CAPABILITY_MISSING", "no model registry data for OpenCode yet (T4.5; --model is not emitted)");
    }
    if (this.#exe === undefined) return ineligible("CAPABILITY_MISSING", `${OPENCODE_BINARY} not found on PATH`);

    const policyFlags = [STANDALONE_FLAG];
    return {
      transport: "subprocess-jsonl",
      // The prompt is one argv word after `--` (Assumption, see protocol.ts); it is visible in the process list.
      argv: [
        this.#exe,
        ...this.#launcher,
        RUN_COMMAND,
        FORMAT_FLAG,
        FORMAT_JSON,
        ...policyFlags,
        ...tail,
        END_OF_OPTIONS,
        request.objective,
      ],
      env: { [DISABLE_AUTOUPDATE_ENV]: "1" },
      envAllowlist: [...OPENCODE_ENV_ALLOWLIST],
      cwd: request.workspace.cwd,
      stdin: { kind: "none" },
      outputFormat: "jsonl",
      timeouts: { ...this.#timeouts },
      policyFlags,
      expectedExitCodes: [0],
      maxLineBytes: DEFAULT_MAX_LINE_BYTES,
    };
  }

  /** T4.53 writes the parser from captures; until then nothing is recognised and a clean exit cannot succeed. */
  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[] {
    if (typeof input !== "string") return [];
    state.lines += 1;
    state.unknownEvents += 1;
    return [{ kind: "unknown", rawType: "unparsed" }];
  }

  /** Never success before the parser exists (T4.53): a result needs a `result` event, which nothing emits yet. */
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
