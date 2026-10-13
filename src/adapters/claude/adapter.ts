/**
 * Claude Code adapter (T2.2; LLD §2 contract; TDD §4.1). Every flag below is cited to its source:
 *   [R2]   docs/research/headless-ai-coding-controller-verified-2026-10-12.md (adapter matrix, "Claude Code" notes,
 *          compliance/authentication boundary, trust-profile section)
 *   [TDD]  docs/design/TDD.md §4.1
 *   [HELP] `claude --help` / `claude auth status --help` of the installed binary, version 2.1.296 (the manifest's
 *          validated_cli_version), read on 2026-10-12 without running a prompt.
 *
 * Flags used (all from [HELP]; the ones also named in [R2]/[TDD] say so):
 *   -p                              non-interactive print mode ([R2], [TDD], [HELP])
 *   --output-format stream-json     structured realtime stream ([R2], [TDD], [HELP])
 *   --verbose                       [R2]/[TDD] pair it with stream-json; Assumption that stream-json under -p needs it
 *   --permission-mode dontAsk       fail-closed: would-prompt operations are denied ([R2], [TDD], [HELP] choices)
 *   --permission-prompts none       nobody answers prompts; would-prompt is denied ([R2], [TDD], [HELP])
 *   --tools <list>                  explicit built-in tool set ([R2] "explicit --tools", [TDD], [HELP])
 *   --allowedTools <rules...>       explicit allow rules, never a wildcard ([R2], [TDD], [HELP])
 *   --disallowedTools <rules...>    deny rules; [HELP]: "Comma or space-separated list of tool names to deny (e.g.
 *                                   "Bash(git *) Edit")". Carries the Git write deny rules (FR-GIT-01); [R2] names
 *                                   only "explicit --tools/allow-deny policy", not this spelling
 *   --safe-mode                     disables CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands/agents;
 *                                   auth works normally ([HELP] only; see the --bare note below)
 *   --restricted                    removes code-running tools unless --tools names them, ignores user/project/local
 *                                   settings files, confines file tools to the working directory, refuses
 *                                   bypassPermissions, and "lets only a person or the configured permission handler
 *                                   approve writes to settings, git and tool-configuration files" ([HELP] only); with
 *                                   `--permission-prompts none` nobody approves, so file-tool writes to Git files are
 *                                   denied (FR-GIT-01; which files count as "git files" is an Assumption)
 *   --strict-mcp-config             only MCP servers from --mcp-config (none are passed) ([HELP] only)
 *   --model <model>                 when the request names one ([HELP]; [R2] says the CLI accepts aliases and IDs)
 *   --resume <session-id>           native resume (FR-SES-03; [R2], [TDD], [HELP])
 *   auth status --json              auth preflight (FR-AUTH-02; `claude auth status` per [R2]/[TDD]; --json per [HELP])
 *   --version / --help              probe only ([HELP])
 *
 * Deviation from [TDD] §4.1 (Proposed `--bare` for untrusted profiles): the installed [HELP] says `--bare` makes
 * Anthropic auth "strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read)". The
 * Claude manifest allows only `native_cached_subscription`, and Switchboard never handles API keys (ADR-0003), so
 * `--bare` would make every run fail auth. FR-POL-04 is met instead with `--safe-mode --restricted
 * --strict-mcp-config`, all documented in [HELP]. TDD §4.1 needs updating to match (reported, not edited here).
 *
 * Profiles (T3.5, TDD §4.1.1 matrix): `inspect-untrusted` and `edit-untrusted` (T2.2), and `trusted-development` with the
 * same flags as `edit-untrusted`, no new flag; `test-sandboxed`, `privileged`, and the trusted-development cells with no
 * documented control are `Ineligible` (see matrixIneligible).
 *
 * Git writes (FR-GIT-01, ADR-0014): see CLAUDE_GIT_WRITE_CONTROL below. No flag documented in [HELP] turns off Claude
 * Code's own commit or attribution behaviour except `--bare` ("skip ... attribution"), which cannot be used (above);
 * settings files are never written (FR-POL-08). Those features are kept unused by denying every way to run Git writes.
 *
 * Never emitted: any BYPASS_FLAGS entry, `--allow-dangerously-skip-permissions`, `--permission-mode
 * bypassPermissions|acceptEdits|auto`, `--settings`, `--setting-sources`, `--mcp-config`, `--plugin-dir`, `--add-dir`,
 * `--worktree`/`-w` (creates a Git worktree and branch, [HELP]), `--from-pr`, `--debug-file`, or any config-writing
 * subcommand (FR-POL-03, FR-POL-08, FR-GIT-01).
 */
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import {
  DEFAULT_IDLE_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_WALL_CLOCK_MS,
} from "../../exec/index.js";
import { classifyCommon } from "../failure.js";
import { GIT_PUBLISHING_PROGRAMS, GIT_WRITE_SUBCOMMANDS, gitWriteRisks } from "../git-write.js";
import type {
  AcpMessage,
  AuthResult,
  CompileRequest,
  ExitInfo,
  FailureClassification,
  FailureEvidence,
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
import { parseClaudeLine } from "./parse.js";

/** Native login the operator runs themselves (FR-AUTH-02). Switchboard never runs it. [HELP]: `claude auth login`. */
export const CLAUDE_LOGIN_COMMAND = "claude auth login";

/** Read-only tools for both untrusted profiles. `Read` is in [HELP]; `Grep` and `Glob` are an Assumption. */
export const CLAUDE_READ_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];
/** File-editing tools for edit-untrusted. `Edit` is in [HELP]; `Write` (needed to create files) is an Assumption. */
export const CLAUDE_EDIT_TOOLS: readonly string[] = ["Edit", "Write"];

/** Every flag that is security-relevant, for policyFlags and the argv tests. */
export const CLAUDE_ISOLATION_FLAGS: readonly string[] = ["--safe-mode", "--restricted", "--strict-mcp-config"];
export const CLAUDE_PERMISSION_FLAGS: readonly string[] = [
  "--permission-mode",
  "dontAsk",
  "--permission-prompts",
  "none",
];

/**
 * Git write deny rules, passed with `--disallowedTools` on every compiled invocation (FR-GIT-01), in the rule form of the
 * [HELP] example `Bash(git *)`. For each subcommand in GIT_WRITE_SUBCOMMANDS: the bare form and the form with
 * arguments; plus Git global options that redirect or reconfigure Git (`-C`, `-c`, `--git-dir`, `--work-tree`) and
 * GitHub CLI pushes. Assumptions (not in [HELP] or [R2]): that `*` matches any suffix (including `=value`) and nothing
 * else; that a deny rule wins over an allow rule; that deny rules naming a tool absent from `--tools` are accepted.
 */
export const CLAUDE_GIT_DENY_RULES: readonly string[] = [
  ...GIT_WRITE_SUBCOMMANDS.flatMap((v) => [`Bash(git ${v})`, `Bash(git ${v} *)`]),
  "Bash(git -C *)",
  "Bash(git -c *)",
  "Bash(git --git-dir *)",
  "Bash(git --git-dir=*)",
  "Bash(git --work-tree *)",
  "Bash(git --work-tree=*)",
  ...GIT_PUBLISHING_PROGRAMS.flatMap((p) => [`Bash(${p})`, `Bash(${p} *)`]),
];

/** FR-GIT-01 declaration for `list_capabilities` and the manifest notes. */
export const CLAUDE_GIT_WRITE_CONTROL: GitWriteControl = {
  kind: "provider-deny-rules",
  detail:
    "Layered, all from `claude --help` 2.1.296: (1) no Bash tool in --tools for inspect-untrusted and edit-untrusted " +
    "unless the operator allowlists exact commands, and any allowlist entry that could write Git (commit, ref change, " +
    "push, config, git global options, gh, command launchers, non-read-only subcommands) makes the run Ineligible; " +
    "(2) --disallowedTools Git write deny rules on every invocation (`Bash(git commit)`, `Bash(git commit *)`, ...); " +
    "(3) --restricted with --permission-prompts none denies file-tool writes to git files. Limits: rule matching " +
    "(`*` semantics, deny-over-allow) is an Assumption; deny rules are lexical and cannot see aliases, scripts run by " +
    "an allowlisted build tool, or absolute paths to git; no flag disables Claude's own commit attribution (only " +
    "--bare, unusable). Live behaviour unverified (live smoke test).",
  remainingControls: ["FR-GIT-03", "FR-GIT-06"],
};

/** Help-text markers the probe requires (FR-ADP-02 steps 3-5). All appear in the installed [HELP]. */
const REQUIRED_HELP: Readonly<Record<"command" | "output_format" | "flags", readonly string[]>> = {
  command: ["--print"],
  output_format: ["--output-format", "stream-json"],
  flags: [
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "--tools",
    "--allowedTools",
    "--disallowedTools",
    "--safe-mode",
    "--restricted",
    "--strict-mcp-config",
    "--resume",
  ],
};

/**
 * Proposed: an `edit-untrusted` shell allowlist entry must be a plain command with plain arguments (no wildcard, no
 * shell metacharacters). Each compiles to an exact-match `Bash(<entry>)` rule; the rule syntax `Bash(git *)` is the
 * [HELP] example, and that a rule without `*` matches only the exact command is an Assumption.
 */
const SHELL_ENTRY = /^[A-Za-z0-9_./-]+( [A-Za-z0-9_./=:@-]+)*$/;
/** Session ids and model names go into argv as option values; refuse anything that could read as an option. */
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;

export interface ClaudeAdapterOptions {
  /** Absolute path, or a bare name resolved on PATH by `probe`. Default `claude`. */
  binaryPath?: string;
  /** Inserted after argv[0]; for fixture replay in tests only (argv[0] is then node, argv[1] the replay script). */
  launcherArgs?: readonly string[];
  timeouts?: Partial<Invocation["timeouts"]>;
}

function resolveOnPath(name: string): string | undefined {
  if (isAbsolute(name)) return name;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

const ineligible = (reason: Ineligible["reason"], detail: string): Ineligible => ({ ineligible: true, reason, detail });

/** Ineligible detail for `privileged` and any bypass-approved profile (T3.5 leaves this cell to T3.17). */
export const CLAUDE_PRIVILEGED_DETAIL =
  "claude adapter does not compile privileged or bypass-approved runs: bypass/privileged compile awaits T3.17";

/**
 * T3.5 compile matrix (TDD §4.1.1, Linux), the cells that are refused before any argv is built. Every refusal is a
 * specific `Ineligible` (LLD §2); nothing is dropped or downgraded (FR-POL-02). Cells checked in this order, so a
 * profile with several unsupported dimensions reports the first:
 * 1. `privileged` or `bypassApproved`: PROFILE_UNSUPPORTED (out of scope here; T3.17).
 * 2. `test-sandboxed`: PROFILE_UNSUPPORTED whatever its dimensions. [H] (`claude --help` 2.1.296) has no sandbox and
 *    no network option, so FR-POL-06 confinement is not shown (R-10; Q-16 reads FR-POL-06 as covering this profile).
 *    Proposed (fail closed): even the empty-allowlist default is refused, because the native-sandbox cell is
 *    Ineligible for every dimension until T3.9 shows confinement or T3.1 supplies an outer sandbox.
 * 3. A `scoped` dimension outside `privileged`: PROFILE_UNSUPPORTED (only the privileged scope may say `scoped`).
 * 4. `trusted-development` (owner decisions 10-12: operator overrides may loosen it):
 *    - network `allowlist` or `policy`: CAPABILITY_MISSING ([H] has no network or host control; R-36).
 *    - shell `broad` (network `off`): CAPABILITY_MISSING, because nothing in [H] stops a command's network use
 *      (Q-34 Proposed). With rule 4a this means `broad` never compiles for Claude today.
 *    - repository configuration `approved-only` or `allowlisted`: CAPABILITY_MISSING. [H] has no per-item control for
 *      approved hooks or instructions; `--setting-sources` selects whole sources, and `--mcp-config` (approved MCP
 *      servers) is barred by ADR-0015.
 *    What remains compiles as `edit-untrusted` (file access, exact shell allowlist, network off at the tool level,
 *    repository configuration disabled with `--safe-mode --restricted --strict-mcp-config`).
 * `inspect-untrusted` and `edit-untrusted` keep their M2 behaviour (T2.2; Q-34: network off at the tool level).
 */
export function matrixIneligible(profile: ResolvedProfile): Ineligible | undefined {
  if (profile.bypassApproved || profile.name === "privileged") {
    return ineligible("PROFILE_UNSUPPORTED", CLAUDE_PRIVILEGED_DETAIL);
  }
  if (profile.name === "test-sandboxed") {
    return ineligible(
      "PROFILE_UNSUPPORTED",
      "test-sandboxed: claude --help 2.1.296 documents no per-run sandbox, so FR-POL-06 confinement is not shown " +
        "(R-10, Q-16); awaits the live check T3.9 or an outer sandbox (T3.1)",
    );
  }
  const scoped = (["fileAccess", "shell", "network", "repoConfig"] as const).filter((f) => profile[f] === "scoped");
  if (scoped.length > 0) {
    return ineligible("PROFILE_UNSUPPORTED", `${profile.name}: scoped ${scoped.join(", ")} belongs to privileged only`);
  }
  if (profile.name === "trusted-development") {
    if (profile.network !== "off") {
      return ineligible(
        "CAPABILITY_MISSING",
        `trusted-development network=${profile.network}: claude --help 2.1.296 documents no network or host control ` +
          "(TDD §4.1.1, R-36)",
      );
    }
    if (profile.shell === "broad") {
      return ineligible(
        "CAPABILITY_MISSING",
        "trusted-development shell=broad with network=off: claude --help 2.1.296 documents nothing that stops a " +
          "command's network use (Q-34, R-36)",
      );
    }
    if (profile.repoConfig !== "disabled") {
      return ineligible(
        "CAPABILITY_MISSING",
        `trusted-development repo_config=${profile.repoConfig}: claude --help 2.1.296 has no per-item control for ` +
          "approved hooks, instructions or MCP servers; --setting-sources selects whole sources and --mcp-config is " +
          "barred by ADR-0015 (TDD §4.1.1)",
      );
    }
    return undefined;
  }
  if (profile.name !== "inspect-untrusted" && profile.name !== "edit-untrusted") {
    return ineligible("PROFILE_UNSUPPORTED", `claude adapter does not support ${String(profile.name)}`);
  }
  return undefined;
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude" as const;
  readonly transports = ["subprocess-jsonl"] as const;
  readonly gitWriteControl = CLAUDE_GIT_WRITE_CONTROL;
  readonly #configured: string;
  #resolved: string | undefined;
  readonly #launcherArgs: readonly string[];
  readonly #timeouts: Invocation["timeouts"];

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.#configured = opts.binaryPath ?? "claude";
    this.#resolved = isAbsolute(this.#configured) ? this.#configured : undefined;
    this.#launcherArgs = [...(opts.launcherArgs ?? [])];
    this.#timeouts = {
      wallClockMs: DEFAULT_WALL_CLOCK_MS,
      idleMs: DEFAULT_IDLE_MS,
      killGraceMs: DEFAULT_KILL_GRACE_MS,
      ...opts.timeouts,
    };
  }

  /**
   * FR-ADP-02 steps 1-5 via `--version` and `--help` only: no auth, no prompt, no model call. Step 7 (harmless
   * structured-output smoke test) needs a model call, so it is not run here; it belongs to the opt-in live validation
   * (FR-OPS-02). Proposed: the step is omitted rather than reported as passed.
   */
  async probe(runner: ProbeRunner): Promise<ProbeResult> {
    const path = resolveOnPath(this.#configured);
    if (path === undefined) {
      return {
        binaryPath: this.#configured,
        binaryVersion: null,
        steps: [{ step: "binary", ok: false, detail: `${this.#configured} not found on PATH` }],
      };
    }
    this.#resolved = path;
    const base = [path, ...this.#launcherArgs];
    const ver = await runner([...base, "--version"]);
    const binaryOk = ver.spawnError === undefined && !ver.timedOut && ver.exitCode === 0;
    // Version output is "<semver> (Claude Code)" in the installed binary; only the leading version token is taken.
    const version = binaryOk ? (/^(\d+\.\d+\.\d+[^\s]*)/.exec(ver.stdout.trim())?.[1] ?? null) : null;
    const steps: ProbeResult["steps"] = [
      { step: "binary", ok: binaryOk, ...(ver.spawnError ? { detail: ver.spawnError } : {}) },
      { step: "version", ok: version !== null, ...(version ? { detail: version } : {}) },
    ];
    const help = binaryOk ? await runner([...base, "--help"]) : undefined;
    const helpText = help && help.exitCode === 0 ? help.stdout : "";
    for (const step of ["command", "output_format", "flags"] as const) {
      const missing = REQUIRED_HELP[step].filter((m) => !helpText.includes(m));
      steps.push({
        step,
        ok: helpText !== "" && missing.length === 0,
        ...(missing.length ? { detail: `missing: ${missing.join(", ")}` } : {}),
      });
    }
    return { binaryPath: path, binaryVersion: version, steps };
  }

  /**
   * FR-AUTH-02 via the documented status command `claude auth status` ([R2]: "structured JSON with success/failure
   * exit codes"; `--json` per [HELP]). Switchboard never reads credential files and never runs login.
   * Assumption: exit 0 means logged in and non-zero means not logged in; a `loggedIn: false` field, if present, is
   * also honoured. Anything else (spawn error, timeout, unparseable output) is UNKNOWN, i.e. ineligible.
   */
  async authPreflight(runner: ProbeRunner): Promise<AuthResult> {
    const path = this.#resolved ?? this.#configured;
    const r = await runner([path, ...this.#launcherArgs, "auth", "status", "--json"]);
    if (r.spawnError !== undefined) return { state: "UNKNOWN", reason: r.spawnError };
    if (r.timedOut) return { state: "UNKNOWN", reason: "auth status timed out" };
    let parsed: Record<string, unknown> | undefined;
    try {
      const v: unknown = JSON.parse(r.stdout);
      if (typeof v === "object" && v !== null && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    } catch {
      // handled below
    }
    if (parsed === undefined) return { state: "UNKNOWN", reason: `unparseable auth status (exit ${r.exitCode})` };
    if (r.exitCode === 0 && parsed.loggedIn !== false) return { state: "OK" };
    if (r.exitCode !== 0 || parsed.loggedIn === false)
      return { state: "AUTH_REQUIRED", loginCommand: CLAUDE_LOGIN_COMMAND };
    return { state: "UNKNOWN", reason: "inconsistent auth status" };
  }

  compile(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    return this.#build(request, profile, []);
  }

  /** FR-SES-03: `--resume <session-id>`; [HELP] `--fork-session` (not used) implies resume keeps the same id. */
  resumeArgs(binding: NativeBinding, request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== "claude") {
      return ineligible("CAPABILITY_MISSING", `binding is for ${binding.provider}, not claude`);
    }
    if (!SAFE_VALUE.test(binding.nativeSessionId)) {
      return ineligible("CAPABILITY_MISSING", "native session id is not a plain identifier");
    }
    return this.#build(request, profile, ["--resume", binding.nativeSessionId]);
  }

  #build(request: CompileRequest, profile: ResolvedProfile, extra: string[]): Invocation | Ineligible {
    // FR-POL-02/03: never downgrade, never bypass (T2.2 for the untrusted profiles, T3.5 for the M3 matrix).
    const refused = matrixIneligible(profile);
    if (refused !== undefined) return refused;
    if (this.#resolved === undefined) {
      return ineligible("CAPABILITY_MISSING", "claude binary path unresolved; run probe first");
    }
    if (request.model !== undefined && !SAFE_VALUE.test(request.model)) {
      return ineligible("CAPABILITY_MISSING", "model name is not a plain identifier");
    }

    const tools = [...CLAUDE_READ_TOOLS];
    const allow = [...CLAUDE_READ_TOOLS];
    // TDD §4.1.1: trusted-development "Could compile" as edit-untrusted (file access, allowlist shell, network off at
    // tool level, repository configuration disabled); the cells it cannot compile were refused by matrixIneligible.
    if (profile.name === "edit-untrusted" || profile.name === "trusted-development") {
      if (profile.fileAccess !== "read-only" && request.workspace.writable) {
        tools.push(...CLAUDE_EDIT_TOOLS);
        allow.push(...CLAUDE_EDIT_TOOLS);
      }
      if (profile.shell === "allowlist") {
        const entries = profile.shellAllowlist ?? [];
        const bad = entries.filter((e) => !SHELL_ENTRY.test(e));
        if (bad.length > 0) {
          return ineligible(
            "PROFILE_UNSUPPORTED",
            `shell allowlist entries not expressible narrowly: ${bad.join("; ")}`,
          );
        }
        // FR-GIT-01: an allowlisted command that could write Git would leave a Git write permitted.
        const gitWrites = gitWriteRisks(entries);
        if (gitWrites.length > 0) {
          return ineligible(
            "PROFILE_UNSUPPORTED",
            `shell allowlist entries could write Git (FR-GIT-01): ${gitWrites.map((g) => `${g.command} (${g.reason})`).join("; ")}`,
          );
        }
        if (entries.length > 0) {
          tools.push("Bash");
          allow.push(...entries.map((e) => `Bash(${e})`));
        }
      } else if (profile.shell !== "none") {
        return ineligible("PROFILE_UNSUPPORTED", `${profile.name} with shell=${profile.shell} is not narrow`);
      }
    } else if (profile.shell !== "none") {
      return ineligible("PROFILE_UNSUPPORTED", "inspect-untrusted must have no shell");
    }

    const policyFlags = [
      ...CLAUDE_ISOLATION_FLAGS,
      ...CLAUDE_PERMISSION_FLAGS,
      "--tools",
      tools.join(","),
      "--allowedTools",
      ...allow,
      "--disallowedTools",
      ...CLAUDE_GIT_DENY_RULES,
    ];
    const argv = [
      this.#resolved,
      ...this.#launcherArgs,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...policyFlags,
      ...(request.model !== undefined ? ["--model", request.model] : []),
      ...extra,
    ];
    return {
      transport: "subprocess-jsonl",
      argv,
      env: {},
      // Assumption: HOME is needed for the CLI to find its own cached login (Switchboard never reads it). No API key
      // variable is ever forwarded (ADR-0003).
      envAllowlist: ["PATH", "HOME"],
      cwd: request.workspace.cwd,
      // Prompt on stdin, not argv, so objective text can never be parsed as a flag. Assumption: `claude -p` reads the
      // prompt from stdin when none is given positionally ([HELP] describes -p as "useful for pipes").
      stdin: { kind: "text", value: promptText(request) },
      outputFormat: "jsonl",
      timeouts: { ...this.#timeouts },
      policyFlags,
      expectedExitCodes: [0],
      maxLineBytes: DEFAULT_MAX_LINE_BYTES,
    };
  }

  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[] {
    if (typeof input !== "string") return []; // no ACP transport for Claude Code ([R2] adapter matrix)
    return parseClaudeLine(input, state);
  }

  extractResult(events: readonly NormalizedEvent[], exit: ExitInfo): RunResult {
    const unknownEventCount = events.filter((e) => e.kind === "unknown").length;
    const bound = events.find((e) => e.kind === "session_bound");
    const nativeSessionId = bound?.kind === "session_bound" ? bound.nativeSessionId : undefined;
    const final = events.findLast((e) => e.kind === "result");
    const summary = final?.kind === "result" ? final.summary : undefined;
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
        (e) => e.kind === "provider_error" || e.kind === "permission_denied" || e.kind === "sandbox_violation",
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
    return classifyCommon(evidence);
  }
}

function promptText(request: CompileRequest): string {
  if (request.constraints.length === 0) return request.objective;
  return `${request.objective}\n\nConstraints:\n${request.constraints.map((c) => `- ${c}`).join("\n")}\n`;
}
