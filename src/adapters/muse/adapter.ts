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
 * Parser and result (T4.73), auth preflight (T4.74), conformance (T4.75), malicious leg (T4.76) and the Git declaration
 * (T4.77) are later tasks; until then the parser recognises nothing, a clean exit is `OUTPUT_PROTOCOL_ERROR`, resume is
 * `Ineligible` and the auth state is `UNKNOWN`.
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
  APPROVAL_MODE_FLAG,
  APPROVAL_ON_REQUEST,
  AUTH_LOGGED_IN_PREFIX,
  AUTH_LOGGED_OUT_PREFIX,
  AUTH_STATUS_ARGS,
  AUTH_STATUS_LINE_MAX,
  AUTH_STATUS_TIMEOUT_MS,
  EXEC_SUBCOMMAND,
  GIT_WRITE_CONTROL_DETAIL,
  HELP_ARGS,
  JSON_FLAG,
  MUSE_BINARY,
  MUSE_LOGIN_COMMAND,
  NON_PRIVILEGED_UNSUPPORTED_DETAIL,
  REQUIRED_HELP_FLAGS,
  SANDBOX_NETWORK_FLAG,
  SANDBOX_NETWORK_RESTRICTED,
  SANDBOX_NETWORK_UNRESTRICTED,
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

const ineligible = (reason: Ineligible["reason"], detail: string): Ineligible => ({ ineligible: true, reason, detail });

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

  /**
   * FR-AUTH-02 via `muse auth status` (T4.74, Q-10 pattern following Grok T4.24): no status command is documented
   * ([M-auth], [M-log]; TDD §4.8), so `muse auth status` and its replies are **Assumptions** (Unverified: T4.71,
   * TDD §4.8.1 item 3). Keyed on the first stdout line at exit 0: a line that starts with `Logged in` is OK,
   * `Not logged in` is AUTH_REQUIRED naming `muse login`; any other first line, a non-zero exit, null exit, timeout,
   * empty output or spawn error is UNKNOWN (fail closed). The output is never stored; at most its first line, filtered
   * and truncated, appears in an UNKNOWN reason. The command never reads `~/.config/muse` or credential files, never
   * passes `META_API_KEY` and never starts a login.
   */
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
    return this.#build(request, profile);
  }

  /** FR-SES-03: `--session-id` resume arrives with the parser (T4.73); a binding of another provider is never compiled. */
  resumeArgs(binding: NativeBinding, _request: CompileRequest, _profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== "muse") return ineligible("CAPABILITY_MISSING", `binding is for ${binding.provider}`);
    return ineligible(
      "CAPABILITY_MISSING",
      "Muse Code resume is not compiled until its parser records the session id (T4.73)",
    );
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
  #build(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
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
      argv: [this.#exe, ...this.#launcher, EXEC_SUBCOMMAND, JSON_FLAG, ...policyFlags, request.objective],
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

  /** T4.73 writes the parser from captures; until then nothing is recognised and a clean exit cannot succeed. */
  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[] {
    if (typeof input === "string") state.lines += 1;
    state.unknownEvents += 1;
    return [{ kind: "unknown", rawType: "unparsed" }];
  }

  /** Never success before the parser exists (T4.73): a result needs a `result` event, which nothing emits yet. */
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
