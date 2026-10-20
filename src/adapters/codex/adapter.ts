/**
 * Codex CLI adapter (T2.2, TDD §4.2, LLD §2). Native surface: `codex exec --json` (JSONL) and
 * `codex exec resume <SESSION_ID>` (R2). Every native spelling lives in ./protocol.ts with its citation or an
 * **Assumption** marker. The adapter never reads Codex credential or config files, never runs login, never writes
 * provider configuration and emits its one bypass flag only for an approved `privileged` scope that sets `bypass`
 * (FR-AUTH-01/02, FR-POL-03, FR-POL-08).
 *
 * `privileged` (T3.6, T3.17): a scope with `bypass: false` compiles from the documented sandbox and harness flags only
 * (see #privileged). A scope with `bypass: true` compiles, only when the run is approved, to
 * `--dangerously-bypass-approvals-and-sandbox` (ADR-0077; `codex exec --help` of codex-cli 0.162.0): no sandbox, so
 * the run is not confined to its worktree (owner ruling 2026-10-20), and the FR-GIT-03 ref snapshot, the tool-call
 * guard (ADR-0039) and FR-GIT-06 still apply. `--yolo` and `--full-auto` are never emitted.
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import {
  DEFAULT_IDLE_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_WALL_CLOCK_MS,
} from "../../exec/index.js";
import { MODEL_ID_PATTERN } from "../../models/registry.js";
import { classifyCommon } from "../failure.js";
import { gitWriteRisks } from "../git-write.js";
import { parseVersion } from "../manifest/index.js";
import { renderObjective } from "../prompt.js";
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
  AUTH_STATUS_LINE_MAX,
  AUTH_STATUS_TIMEOUT_MS,
  AUTH_UNKNOWN_REASON,
  BYPASS_FLAG,
  CODEX_BINARY,
  CODEX_LOGIN_COMMAND,
  CODEX_LOGIN_STATUS_ARGS,
  ERROR_CODE_CATEGORIES,
  EVENT,
  EXEC_SUBCOMMAND,
  GIT_WRITE_CONTROL_DETAIL,
  HELP_FLAG,
  IGNORE_RULES_FLAG,
  IGNORE_USER_CONFIG_FLAG,
  ITEM,
  JSON_FLAG,
  MODEL_FLAG,
  RESUME_SUBCOMMAND,
  SANDBOX_FLAG,
  SANDBOX_READ_ONLY,
  SANDBOX_WORKSPACE_WRITE,
  STATUS_DECLINED,
  VERSION_FLAG,
} from "./protocol.js";

/**
 * Environment names passed through to Codex (FR-EXE-07, NFR-SEC-02). Proposed: PATH for the binary and HOME so the
 * CLI can find its own saved login (R2: saved CLI authentication is reused by `codex exec`; the auth file lives under
 * the home directory). `OPENAI_API_KEY`/`CODEX_API_KEY` are deliberately excluded (R2: do not expose them broadly).
 */
export const CODEX_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME"];

/** Proposed bounds. */
const PROBE_TIMEOUT_MS = 10_000;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_TARGET_CHARS = 512;
/** Native ids are passed as one argv element; refuse anything that could be read as a flag (Proposed). */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
/** A model id passed as one argv word (the registry's `MODEL_ID_PATTERN` shape; never read as a flag). */
const MODEL_ID_RE = new RegExp(MODEL_ID_PATTERN);

/** FR-GIT-01: Codex documents no Git write control, so the adapter declares that (see protocol.ts). */
export const CODEX_GIT_WRITE_CONTROL: GitWriteControl = {
  kind: "none-documented",
  detail: GIT_WRITE_CONTROL_DETAIL,
  remainingControls: ["FR-GIT-03", "FR-GIT-06"],
};

/** Owner decision 10: Codex stays eligible on its native sandbox for these two, confinement unverified (R-23). */
const UNTRUSTED_PROFILES = new Set(["inspect-untrusted", "edit-untrusted"]);
/** Every non-privileged profile the compile matrix evaluates (T3.6, TDD §4.2.1). */
const MATRIX_PROFILES = new Set([...UNTRUSTED_PROFILES, "test-sandboxed", "trusted-development"]);

/** Ineligible detail for a scope that sets `bypass` on a run whose `bypassApproved` is false (FR-POL-03). */
export const CODEX_BYPASS_NOT_APPROVED =
  "privileged scope sets bypass but the run's bypassApproved is false: --dangerously-bypass-approvals-and-sandbox is " +
  "compiled only for an operator-approved scope (FR-POL-03, ADR-0017, ADR-0077)";
/** Ineligible detail for a bypass approval on a profile other than `privileged` (FR-POL-03). */
export const CODEX_BYPASS_OUTSIDE_PRIVILEGED =
  "bypassApproved is set on a profile other than privileged: a bypass applies only to an approved privileged scope " +
  "(FR-POL-03, ADR-0017)";

export interface CodexAdapterOptions {
  /** Absolute path of the codex binary. Defaults to the first executable `codex` on PATH, resolved once. */
  executable?: string;
  /**
   * Test-only: arguments inserted between the executable and `exec` (recorded-fixture replay runs the shared
   * `node src/adapters/fixtures/replay.mjs --provider codex ...` in place of the binary). Empty in production.
   */
  launcherArgs?: readonly string[];
  timeouts?: Partial<Invocation["timeouts"]>;
  /** PATH used to resolve `codex` when `executable` is absent. Defaults to process.env.PATH. */
  pathEnv?: string;
}

type Json = Record<string, unknown>;
type ProviderErrorEvent = Extract<NormalizedEvent, { kind: "provider_error" }>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** First executable regular file named `name` on `pathEnv`, as an absolute path. */
export function resolveOnPath(name: string, pathEnv: string | undefined): string | undefined {
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

const ineligible = (reason: Ineligible["reason"], detail: string): Ineligible => ({ ineligible: true, reason, detail });

/** The documented sandbox and harness-control flags ([R2] L75, L126-128; read-only spelling an Assumption). */
function harnessFlags(readOnly: boolean): string[] {
  return [
    SANDBOX_FLAG,
    readOnly ? SANDBOX_READ_ONLY : SANDBOX_WORKSPACE_WRITE,
    IGNORE_USER_CONFIG_FLAG, // FR-POL-04/08: no host config changes the contract; nothing is written
    IGNORE_RULES_FLAG,
  ];
}

/**
 * FR-GIT-02 declaration (T9.4, ADR-0026; Delegated): no injected channel. Codex is not installed on the build host and
 * [R2] documents no per-run MCP definition, MCP tool approval or Unix-socket access from its sandbox (TDD §3.10, T9.0).
 * The compiled argv is unchanged.
 */
export const CODEX_GIT_CAPABILITIES: GitCapabilities = {
  commitChannel: "none",
  detail:
    "No injected commit channel: no per-run MCP definition, MCP tool approval or socket access from the sandbox is " +
    "documented in [R2] or verified (Codex not installed; T9.0). Agent work stays in the run's worktree and diff " +
    "artifacts.",
};

export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex" as const;
  readonly transports = ["subprocess-jsonl"] as const;
  readonly gitWriteControl = CODEX_GIT_WRITE_CONTROL;
  /**
   * T5.12 cell 2 (2026-10-19, codex-cli 0.162.0 in the operator's container login;
   * docs/research/live-checks-2026-10-19-codex-container-resume.md): `exec resume <id>` found the session from a
   * second worktree and from an unrelated empty directory (same thread id, exit 0), so resumeCwd is `independent`
   * (ADR-0038 item 6.3, LLD §15.6, TDD §4.10). Every resume still re-sends the full policy flags.
   */
  readonly resumeCwd = "independent" as const;
  /** T7.12 (FR-RTE-08, Q-90): no documented model flag (R2, TDD §4.2), so a remembered model is never pinned. */
  readonly reportedModelFlag = { kind: "not_accepted", detail: "no documented Codex model flag" } as const;
  readonly gitCapabilities = CODEX_GIT_CAPABILITIES;
  readonly #exe: string | undefined;
  readonly #launcher: readonly string[];
  readonly #timeouts: Invocation["timeouts"];

  constructor(opts: CodexAdapterOptions = {}) {
    this.#exe = opts.executable ?? resolveOnPath(CODEX_BINARY, opts.pathEnv ?? process.env.PATH);
    this.#launcher = [...(opts.launcherArgs ?? [])];
    this.#timeouts = {
      wallClockMs: DEFAULT_WALL_CLOCK_MS,
      idleMs: DEFAULT_IDLE_MS,
      killGraceMs: DEFAULT_KILL_GRACE_MS,
      ...opts.timeouts,
    };
  }

  /**
   * FR-ADP-02 steps 1-5. Version and help output are probe evidence only (never session/status/usage, FR-ADP-04).
   * Step 7 (structured-output smoke test) is not run: for Codex it would be a model call, which probe must not make;
   * the operator's opt-in live smoke test covers it.
   */
  async probe(runner: ProbeRunner): Promise<ProbeResult> {
    const exe = this.#exe;
    if (exe === undefined) {
      return {
        binaryPath: CODEX_BINARY,
        binaryVersion: null,
        steps: [{ step: "binary", ok: false, detail: `${CODEX_BINARY} not found on PATH` }],
      };
    }
    const run = (...args: string[]) => runner([exe, ...this.#launcher, ...args], { timeoutMs: PROBE_TIMEOUT_MS });
    const ver = await run(VERSION_FLAG);
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

    const help = await run(EXEC_SUBCOMMAND, HELP_FLAG);
    const commandOk = help.spawnError === undefined && !help.timedOut && help.exitCode === 0;
    const flags = new Set(commandOk ? (help.stdout.match(/--[a-z][a-z0-9-]*/g) ?? []) : []);
    const missing = [SANDBOX_FLAG, IGNORE_USER_CONFIG_FLAG, IGNORE_RULES_FLAG].filter((f) => !flags.has(f));
    steps.push(
      { step: "command", ok: commandOk, ...(commandOk ? {} : { detail: `\`${EXEC_SUBCOMMAND}\` unavailable` }) },
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
   * FR-AUTH-02 via `codex login status` (observed on codex-cli 0.162.1, docs/research/live-checks-2026-10-13.md:
   * exit 0 logged in, exit 1 not logged in; the output format is undocumented, so only the exit code decides).
   * Exit 0 is OK, exit 1 is AUTH_REQUIRED, and any other exit code, a timeout or a spawn failure is UNKNOWN (ineligible,
   * NFR-SEC-06, fail closed). The runner supplies the minimal probe environment. Output is never parsed or stored; at
   * most the exit code and the first line, truncated, appear in an UNKNOWN reason. It never reads `~/.codex/auth.json`
   * or any other file and never starts a login.
   */
  async authPreflight(runner: ProbeRunner): Promise<AuthResult> {
    const exe = this.#exe;
    if (exe === undefined) return { state: "UNKNOWN", reason: `${CODEX_BINARY} not found on PATH` };
    const r = await runner([exe, ...this.#launcher, ...CODEX_LOGIN_STATUS_ARGS], { timeoutMs: AUTH_STATUS_TIMEOUT_MS });
    if (r.spawnError !== undefined) return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (${r.spawnError})` };
    if (r.timedOut) return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (timed out)` };
    if (r.exitCode === 0) return { state: "OK" };
    if (r.exitCode === 1) return { state: "AUTH_REQUIRED", loginCommand: CODEX_LOGIN_COMMAND };
    const first = (r.stdout.split("\n").find((l) => l.trim() !== "") ?? "").trim();
    const line = Array.from(first)
      .filter((c) => c >= " " && c !== "\x7f")
      .join("")
      .slice(0, AUTH_STATUS_LINE_MAX);
    return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (exit ${r.exitCode}${line ? `: ${line}` : ""})` };
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

  /** FR-SES-03: `codex exec resume <SESSION_ID>` with the stored native id (R2; explicit id preferred over `--last`). */
  resumeArgs(binding: NativeBinding, request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== "codex") return ineligible("CAPABILITY_MISSING", `binding is for ${binding.provider}`);
    if (!SESSION_ID_RE.test(binding.nativeSessionId)) {
      return ineligible("CAPABILITY_MISSING", "native session id is not a safe single argument");
    }
    // Observed (T5.12 cell 1, 2026-10-19, codex-cli 0.162.0): exec-level flags before `resume <id>` and the follow-up
    // prompt on stdin resume the same thread with exit 0.
    return this.#build(request, profile, [RESUME_SUBCOMMAND, binding.nativeSessionId]);
  }

  /**
   * Pure. The T3.6 compile matrix for the non-privileged profiles (TDD §4.2.1; Proposed, Delegated). Every dimension
   * either maps to a documented control (`--sandbox`, `--ignore-user-config`, `--ignore-rules`, [R2]) or makes the run
   * Ineligible with a reason naming it; nothing is downgraded or silently dropped (FR-POL-02). Checks run in a fixed
   * order so the first failing dimension names the reason.
   */
  #build(request: CompileRequest, profile: ResolvedProfile, tail: string[]): Invocation | Ineligible {
    if (profile.name === "privileged") {
      const priv = this.#privileged(request, profile);
      return "ineligible" in priv ? priv : this.#invocation(request, priv.policyFlags, tail);
    }
    if (profile.bypassApproved || request.bypassApproved === true) {
      return ineligible("PROFILE_UNSUPPORTED", CODEX_BYPASS_OUTSIDE_PRIVILEGED);
    }
    if (!MATRIX_PROFILES.has(profile.name)) return ineligible("PROFILE_UNSUPPORTED", `unknown profile ${profile.name}`);
    const scoped = (["fileAccess", "shell", "network", "repoConfig"] as const).filter((k) => profile[k] === "scoped");
    if (scoped.length > 0) return ineligible("PROFILE_UNSUPPORTED", `scoped ${scoped.join(", ")} outside privileged`);
    const allowlist = profile.shellAllowlist ?? [];
    const gitWrites = gitWriteRisks(allowlist);
    if (gitWrites.length > 0) {
      return ineligible(
        "PROFILE_UNSUPPORTED",
        `shell allowlist entries could write Git (FR-GIT-01): ${gitWrites.map((g) => g.command).join("; ")}`,
      );
    }
    const shellIneligible = this.#shell(profile, allowlist);
    if (shellIneligible) return shellIneligible;
    // Assumption: Codex sandbox modes keep network off; R2 documents no network switch, so only `off` compiles (R-36).
    if (profile.network !== "off") {
      return ineligible("CAPABILITY_MISSING", `network=${profile.network}: no documented Codex network control`);
    }
    // R2 documents only the two all-or-nothing harness flags, no per-item approval of repository config.
    if (profile.repoConfig !== "disabled") {
      return ineligible(
        "CAPABILITY_MISSING",
        `repoConfig=${profile.repoConfig}: Codex documents only all-or-nothing --ignore-user-config/--ignore-rules`,
      );
    }
    // R2/TDD §4.2 name no model-selection flag; never silently run a different model (Q-11, model part open).
    if (request.model !== undefined) return ineligible("CAPABILITY_MISSING", "no documented Codex model flag");
    // Q-32, Proposed (Delegated): decision 10 names only the two untrusted profiles, and Codex cannot limit commands
    // to build and test commands, so test-sandboxed fails closed until Q-32 is answered or T3.9 records HELD.
    if (profile.name === "test-sandboxed") {
      return ineligible(
        "PROFILE_UNSUPPORTED",
        "test-sandboxed: owner decision 10 covers only inspect-untrusted and edit-untrusted; Codex credential " +
          "confinement is unverified (Q-32, R-23, FR-POL-06)",
      );
    }
    if (this.#exe === undefined) return ineligible("CAPABILITY_MISSING", `${CODEX_BINARY} not found on PATH`);

    const readOnly =
      profile.name === "inspect-untrusted" || profile.fileAccess === "read-only" || !request.workspace.writable;
    return this.#invocation(request, harnessFlags(readOnly), tail);
  }

  /**
   * `privileged` (T3.6, T3.17; TDD §4.2.1 `privileged` column; LLD §3.1; Proposed, Delegated). Compiles the approved
   * scope from the documented flags only; checks in this order, the first unmet one is the `Ineligible` reason:
   * 1. No scope binding: PROFILE_UNSUPPORTED.
   * 2. `bypass: true`: the bypass cell ({@link #bypass}); PROFILE_UNSUPPORTED {@link CODEX_BYPASS_NOT_APPROVED} without
   *    an approval.
   * 3. shell `none` or `allowlist`: CAPABILITY_MISSING ([R2] documents no way to disable or narrow commands; decision 10
   *    does not cover a scope). `broad` compiles: commands run inside the sandbox.
   * 4. network `allowlist` or `on`: CAPABILITY_MISSING (no documented switch, so `on` cannot be guaranteed either).
   *    `off` compiles on the existing Assumption that the sandbox keeps network off.
   * 5. repository_config `approved`: CAPABILITY_MISSING (only all-or-nothing flags). `enabled`: CAPABILITY_MISSING
   *    (Proposed): it means omitting `--ignore-user-config`/`--ignore-rules`, and whether `--sandbox` still wins over a
   *    loaded user configuration is not in [R2]. `disabled` compiles with both flags.
   * 6. A requested model: CAPABILITY_MISSING (no model flag outside the bypass cell, Delegated: unchanged).
   * Then files `read-only` (or a read-only workspace) is `--sandbox read-only`, `worktree` is `--sandbox workspace-write`.
   * `bypassApproved` true on a `bypass: false` scope changes nothing (no flag).
   */
  #privileged(request: CompileRequest, profile: ResolvedProfile): { policyFlags: string[] } | Ineligible {
    const scope = profile.privilegedScope?.scope;
    if (scope === undefined) {
      return ineligible("PROFILE_UNSUPPORTED", "privileged without an approved scope binding (LLD §3.1)");
    }
    if (scope.bypass) return this.#bypass(request, profile, scope);
    if (scope.shell.mode !== "broad") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged shell=${scope.shell.mode}: no documented Codex control to disable or narrow commands (Q-11)`,
      );
    }
    if (scope.network.mode !== "off") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged network=${scope.network.mode}: no documented Codex network control (R-36)`,
      );
    }
    if (scope.repository_config.mode !== "disabled") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged repository_config=${scope.repository_config.mode}: Codex documents only all-or-nothing ` +
          "--ignore-user-config/--ignore-rules, and whether --sandbox wins over loaded configuration is not in R2; " +
          "owner decision 26 (Q-37) allows it for bypass runs only",
      );
    }
    if (request.model !== undefined) return ineligible("CAPABILITY_MISSING", "no documented Codex model flag");
    return { policyFlags: harnessFlags(scope.files.access === "read-only" || !request.workspace.writable) };
  }

  /**
   * The approved bypass cell (ADR-0077; Delegated where marked). Checks in this order, the first unmet one is the reason:
   * 1. no approval (`bypassApproved` on the profile or request): PROFILE_UNSUPPORTED {@link CODEX_BYPASS_NOT_APPROVED} (FR-POL-03);
   * 2. read-only files (scope or workspace): CAPABILITY_MISSING: the bypass flag turns the sandbox off, so nothing keeps
   *    the run read-only; a read-only scope without `bypass` compiles `--sandbox read-only` instead;
   * 3. shell other than `broad`: CAPABILITY_MISSING (every command runs unprompted, no allowlist is documented);
   * 4. network other than `on`: CAPABILITY_MISSING (with no sandbox the network is not restricted);
   * 5. repository_config `approved`: CAPABILITY_MISSING (only the all-or-nothing harness flags). `disabled` keeps
   *    `--ignore-user-config --ignore-rules`; `enabled` omits them (owner decision 26, Q-37).
   * Then `--dangerously-bypass-approvals-and-sandbox` replaces `--sandbox`, and a requested model is `--model <id>`
   * (`codex exec --help`: "-m, --model <MODEL>"; the id shape is the registry's, checked again here).
   * The run is not confined to its worktree (owner ruling 2026-10-20); it still starts in it (FR-WS-01).
   */
  #bypass(
    request: CompileRequest,
    profile: ResolvedProfile,
    scope: NonNullable<ResolvedProfile["privilegedScope"]>["scope"],
  ): { policyFlags: string[] } | Ineligible {
    if (!(profile.bypassApproved || request.bypassApproved === true)) {
      return ineligible("PROFILE_UNSUPPORTED", CODEX_BYPASS_NOT_APPROVED);
    }
    if (scope.files.access === "read-only" || !request.workspace.writable) {
      return ineligible(
        "CAPABILITY_MISSING",
        "privileged read-only files with bypass: --dangerously-bypass-approvals-and-sandbox turns the sandbox off, so " +
          "nothing keeps the run read-only (ADR-0077); use a scope without bypass",
      );
    }
    if (scope.shell.mode !== "broad") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged shell=${scope.shell.mode} with bypass: every command runs unprompted and no Codex command ` +
          "allowlist is documented (Q-11)",
      );
    }
    if (scope.network.mode !== "on") {
      return ineligible(
        "CAPABILITY_MISSING",
        `privileged network=${scope.network.mode} with bypass: no sandbox restricts the network (ADR-0077, R-36)`,
      );
    }
    if (scope.repository_config.mode === "approved") {
      return ineligible(
        "CAPABILITY_MISSING",
        "privileged repository_config=approved: Codex documents only all-or-nothing --ignore-user-config/--ignore-rules",
      );
    }
    if (request.model !== undefined && !MODEL_ID_RE.test(request.model)) {
      return ineligible("CAPABILITY_MISSING", "requested model is not a plain model id");
    }
    return {
      policyFlags: [
        BYPASS_FLAG,
        ...(scope.repository_config.mode === "disabled" ? [IGNORE_USER_CONFIG_FLAG, IGNORE_RULES_FLAG] : []),
        ...(request.model !== undefined ? [MODEL_FLAG, request.model] : []),
      ],
    };
  }

  #invocation(request: CompileRequest, policyFlags: string[], tail: string[]): Invocation | Ineligible {
    if (this.#exe === undefined) return ineligible("CAPABILITY_MISSING", `${CODEX_BINARY} not found on PATH`);
    return {
      transport: "subprocess-jsonl",
      // Assumption: with no positional prompt, `codex exec` reads the prompt from stdin.
      argv: [this.#exe, ...this.#launcher, EXEC_SUBCOMMAND, JSON_FLAG, ...policyFlags, ...tail],
      env: {},
      envAllowlist: [...CODEX_ENV_ALLOWLIST],
      cwd: request.workspace.cwd,
      stdin: { kind: "text", value: renderObjective(request) },
      outputFormat: "jsonl",
      timeouts: { ...this.#timeouts },
      policyFlags,
      expectedExitCodes: [0],
      maxLineBytes: DEFAULT_MAX_LINE_BYTES,
    };
  }

  /**
   * Shell dimension. R2 documents no way to stop or narrow the commands Codex runs inside its sandbox (Q-11):
   * - untrusted profiles: `none` or an empty allowlist compile (owner decision 10, commands run inside the sandbox,
   *   confinement unverified, R-23); a non-empty allowlist is CAPABILITY_MISSING; `broad` is not compiled (Proposed).
   * - test-sandboxed: a non-empty allowlist is CAPABILITY_MISSING; everything else falls to the Q-32 gate.
   * - trusted-development: only `broad` compiles (commands inside the sandbox); `none` or any allowlist, empty
   *   included, is CAPABILITY_MISSING, since decision 10 does not cover it (Proposed, as the privileged matrix cell).
   */
  #shell(profile: ResolvedProfile, allowlist: readonly string[]): Ineligible | undefined {
    if (profile.name === "trusted-development") {
      if (profile.shell === "broad") return undefined;
      return ineligible(
        "CAPABILITY_MISSING",
        `shell=${profile.shell}: no documented Codex control to disable or narrow commands (Q-11)`,
      );
    }
    if (allowlist.length > 0) return ineligible("CAPABILITY_MISSING", "no documented Codex command allowlist (Q-11)");
    if (UNTRUSTED_PROFILES.has(profile.name) && profile.shell !== "none" && profile.shell !== "allowlist") {
      return ineligible(
        "PROFILE_UNSUPPORTED",
        `shell=${profile.shell} is not compiled for Codex under ${profile.name}`,
      );
    }
    return undefined;
  }

  /** One JSONL line -> normalized events. Structured fields only (FR-ADP-04); reasoning text is dropped. */
  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[] {
    if (typeof input !== "string") return []; // no ACP transport for Codex
    state.lines += 1;
    let doc: unknown;
    try {
      doc = JSON.parse(input);
    } catch {
      return []; // the supervisor ends the run OUTPUT_PROTOCOL_ERROR on unparseable framing
    }
    const e = obj(doc);
    const type = str(e?.type);
    if (e === undefined || type === undefined) return this.#unknown(state, "none");
    switch (type) {
      case EVENT.threadStarted: {
        const id = str(e.thread_id);
        if (id === undefined || id === "") return this.#unknown(state, type);
        state.nativeSessionId = id;
        return [{ kind: "session_bound", nativeSessionId: id }];
      }
      case EVENT.turnStarted:
        return [];
      case EVENT.turnCompleted: {
        const usage = obj(e.usage);
        const out: NormalizedEvent[] = [];
        if (usage) {
          const metrics: Record<string, number | string | null> = {};
          for (const [k, v] of Object.entries(usage)) if (typeof v === "number") metrics[k] = v;
          out.push({ kind: "usage", source: "provider_reported", metrics });
        }
        out.push({ kind: "result", ok: true });
        return out;
      }
      case EVENT.turnFailed:
        return [this.#error(obj(e.error)), { kind: "result", ok: false }];
      case EVENT.error:
        return this.#errorEvents(e);
      case EVENT.itemStarted:
      case EVENT.itemUpdated:
        return []; // actions are recorded once, on completion
      case EVENT.itemCompleted:
        return this.#item(obj(e.item), state);
      default:
        return this.#unknown(state, type);
    }
  }

  #unknown(state: ParseState, rawType: string): NormalizedEvent[] {
    state.unknownEvents += 1;
    return [{ kind: "unknown", rawType }];
  }

  #error(err: Json | undefined): ProviderErrorEvent {
    const code = str(err?.code);
    const category = (code !== undefined ? ERROR_CODE_CATEGORIES[code] : undefined) ?? "unknown";
    return { kind: "provider_error", category, message: clip(str(err?.message) ?? "", MAX_SUMMARY_CHARS) };
  }

  #errorEvents(err: Json): NormalizedEvent[] {
    const ev = this.#error(err);
    if (ev.category === "rate_limit") return [{ kind: "rate_limit", reportedCategory: str(err.code) ?? "" }, ev];
    if (ev.category === "sandbox") return [{ kind: "sandbox_violation", detail: ev.message }, ev];
    return [ev];
  }

  #item(item: Json | undefined, state: ParseState): NormalizedEvent[] {
    const type = str(item?.type);
    if (item === undefined || type === undefined) return this.#unknown(state, "item:none");
    const declined = str(item.status) === STATUS_DECLINED;
    const call = (tool: "read" | "edit" | "shell" | "other", name: string, target?: string): NormalizedEvent[] => {
      const ev: NormalizedEvent = {
        kind: "tool_call",
        tool,
        name,
        ...(target ? { target: clip(target, MAX_TARGET_CHARS) } : {}),
        ...(declined ? { denied: true } : {}),
      };
      return declined ? [ev, { kind: "permission_denied", tool: name }] : [ev];
    };
    switch (type) {
      case ITEM.agentMessage:
        return [{ kind: "message", role: "assistant", text: clip(str(item.text) ?? "", MAX_SUMMARY_CHARS) }];
      case ITEM.reasoning:
      case ITEM.todoList:
        return []; // not observable actions (NFR-PRIV-02)
      case ITEM.commandExecution:
        return call("shell", ITEM.commandExecution, str(item.command));
      case ITEM.fileChange: {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const paths = changes.map((c) => str(obj(c)?.path)).filter((p): p is string => p !== undefined);
        if (paths.length === 0) return call("edit", ITEM.fileChange);
        return paths.flatMap((p) => call("edit", ITEM.fileChange, p));
      }
      case ITEM.mcpToolCall:
        return call("other", `mcp:${str(item.server) ?? "?"}/${str(item.tool) ?? "?"}`);
      case ITEM.webSearch:
        return call("other", ITEM.webSearch);
      case ITEM.error:
        return this.#errorEvents(item);
      default:
        return this.#unknown(state, `item:${type}`);
    }
  }

  extractResult(events: readonly NormalizedEvent[], exit: ExitInfo): RunResult {
    const unknownEventCount = events.filter((e) => e.kind === "unknown").length;
    const bound = events.findLast((e) => e.kind === "session_bound");
    const nativeSessionId = bound?.kind === "session_bound" ? bound.nativeSessionId : undefined;
    const lastMessage = events.findLast((e) => e.kind === "message");
    const summary = lastMessage?.kind === "message" && lastMessage.text ? lastMessage.text : undefined;
    const final = events.findLast((e) => e.kind === "result");
    const base = {
      unknownEventCount,
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(summary ? { summary } : {}),
    };
    // Proposed, fail closed: any error, denial or sandbox event fails the run even if a later turn completed.
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

  /** Shared precedence (failure.ts); native error codes are already normalized to the shared categories. */
  classifyFailure(evidence: FailureEvidence): FailureClassification {
    return classifyCommon(evidence);
  }
}
