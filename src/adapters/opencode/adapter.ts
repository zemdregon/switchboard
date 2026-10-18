/**
 * OpenCode adapter (T4.52, TDD §4.6; module, probe, compile matrix and registry entry; Delegated, not owner-approved).
 * Native surface: one process per run, `opencode run --format json --standalone -- <prompt>` (TDD §4.6 "Transport
 * decision"; `--standalone` keeps the run's tools in a private server inside the run's process group instead of the
 * host's shared background service, [LIVE] ESCAPED). The adapter never reads OpenCode credential or configuration files
 * (`auth.json`, `mcp-auth.json`, `.env`), never runs `auth login`, `auth list` output into logs or `auth export`, never
 * writes provider configuration, never sets `OPENCODE_PERMISSION` or `OPENCODE_CONFIG_CONTENT` (ignored on v2.0.23, Q-64),
 * and never emits `--auto`, `--continue`, `--fork`, `--server`, `--attach`, `--share`, `--dir` or `--model`.
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
 * - the parser (T4.53) reads only the `--format json` fields the 2026-10-14 live check recorded; success needs a
 *   `step_finish` with reason `stop`, or a text-only run without one (Q-85 as narrowed by owner decision 68); resume is `--session <id>` through the same matrix. The auth preflight
 *   (T4.54) reads the connection types of `auth list --format json --standalone`. The manifest range admits no version, so none of this runs before `adapters validate`
 *   passes a version.
 */

import {
  DEFAULT_IDLE_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_WALL_CLOCK_MS,
} from "../../exec/index.js";
import { resolveOnPath } from "../codex/adapter.js";
import { classifyCommon, PROVIDER_ERROR_CATEGORY_CODES } from "../failure.js";
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
  AUTH_ENV_CONNECTION_TYPES,
  AUTH_STATUS_ARGS,
  AUTH_STATUS_TIMEOUT_MS,
  DISABLE_AUTOUPDATE_ENV,
  END_OF_OPTIONS,
  ERROR_TYPE_CATEGORIES,
  EVENT,
  FORMAT_FLAG,
  FORMAT_JSON,
  GIT_WRITE_CONTROL_DETAIL,
  NON_PRIVILEGED_UNSUPPORTED_DETAIL,
  OPENCODE_BINARY,
  OPENCODE_LOGIN_COMMAND,
  REASON_STOP,
  REQUIRED_HELP_FLAGS,
  RUN_COMMAND,
  RUN_HELP_ARGS,
  SESSION_FLAG,
  STANDALONE_FLAG,
  TOKEN_KEYS,
  TOOL_KINDS,
  VERSION_ARGS,
} from "./protocol.js";

/**
 * Environment names passed through to OpenCode (FR-EXE-07, NFR-SEC-02). Proposed: `PATH` for the binary and `HOME` so
 * the CLI finds its own native login. Provider keys (OpenCode loads "any keys defined in your environments", [D-cli];
 * [LIVE] 2f), `OPENCODE_PERMISSION`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG` and the `XDG_*` directories stay out.
 */
export const OPENCODE_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME"];

const PROBE_TIMEOUT_MS = 10_000;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_TARGET_CHARS = 512;
/** Native ids are passed as one argv element; refuse anything that could be read as a flag (Proposed). */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

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

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const ineligible = (reason: Ineligible["reason"], detail: string): Ineligible => ({ ineligible: true, reason, detail });
/** Own-key lookup, so a native value such as `constructor` or `__proto__` never resolves to an inherited member. */
const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;
/**
 * Own-property read, so properties carried on Object.prototype or __proto__ smuggling are never read as event
 * fields (Proposed, fail closed; as Cursor T4.43).
 */
const ownProp = (o: Json | undefined, key: string): unknown =>
  o !== undefined && Object.hasOwn(o, key) ? o[key] : undefined;
/** Part ids already counted per run, so a repeated `step_finish` is not recorded twice (TDD §4.6, Proposed). */
const seenParts = new WeakMap<ParseState, Set<string>>();
/** Per-run stream facts for the text-only rule (owner decision 68): a tool event or a `step_finish` seen so far. */
const streamFacts = new WeakMap<ParseState, { tool: boolean; finish: boolean; textOnlyLast: boolean }>();
/** `summary` of the `result` a text-only reply emits (owner decision 68), so the order check can name it. */
export const TEXT_ONLY_RESULT_SUMMARY = "text-only reply without step_finish (owner decision 68)";
/** Category of a stream anomaly (session id changed mid-run); classified OUTPUT_PROTOCOL_ERROR. */
const PROTOCOL_CATEGORY = "protocol";
const CATEGORY_CODES = { ...PROVIDER_ERROR_CATEGORY_CODES, [PROTOCOL_CATEGORY]: "OUTPUT_PROTOCOL_ERROR" } as const;

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

  /**
   * FR-AUTH-01/02 (T4.54): `opencode auth list --format json --standalone`, keyed on the connection types (see
   * protocol.ts). Never reads `auth.json`, never runs `auth login` or `auth export`, and never copies the list (it names
   * providers and accounts) into the result.
   */
  async authPreflight(runner: ProbeRunner): Promise<AuthResult> {
    const exe = this.#exe;
    if (exe === undefined) return { state: "UNKNOWN", reason: `${OPENCODE_BINARY} not found on PATH` };
    const r = await runner([exe, ...this.#launcher, ...AUTH_STATUS_ARGS], { timeoutMs: AUTH_STATUS_TIMEOUT_MS });
    const unknown = (why: string): AuthResult => ({
      state: "UNKNOWN",
      reason: `\`${OPENCODE_BINARY} ${AUTH_STATUS_ARGS.join(" ")}\` gave no login state (${why})`,
    });
    if (r.spawnError !== undefined) return unknown("could not start");
    if (r.timedOut) return unknown("timed out");
    if (r.exitCode !== 0) return unknown(`exit ${r.exitCode}`);
    let doc: unknown;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      return unknown("output is not JSON");
    }
    if (!Array.isArray(doc)) return unknown("not a JSON array");
    let stored = false;
    for (const entry of doc) {
      const connections = obj(entry)?.connections;
      if (!Array.isArray(connections)) return unknown("an entry has no connections list");
      for (const c of connections) {
        const type = str(obj(c)?.type);
        if (type === undefined) return unknown("a connection has no type");
        if (!AUTH_ENV_CONNECTION_TYPES.includes(type)) stored = true;
      }
    }
    return stored ? { state: "OK" } : { state: "AUTH_REQUIRED", loginCommand: OPENCODE_LOGIN_COMMAND };
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
   * FR-SES-03 (T4.53): `--session <id>` through the same matrix, the id taken from the structured `sessionID` only
   * ([LIVE] 13a, 15a). `--continue` is never used: it resumes the most recent session of the directory ([LIVE] 13b).
   */
  resumeArgs(binding: NativeBinding, request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== "opencode") return ineligible("CAPABILITY_MISSING", `binding is for ${binding.provider}`);
    if (!SESSION_ID_RE.test(binding.nativeSessionId)) {
      return ineligible("CAPABILITY_MISSING", "native session id is not a safe single argument");
    }
    return this.#build(request, profile, [SESSION_FLAG, binding.nativeSessionId]);
  }

  /**
   * Pure. Order of checks (the first unmet one is the reason):
   * 0. shell allowlist entries that could write Git: PROFILE_UNSUPPORTED (FR-GIT-01);
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
    const allowlist = profile.shellAllowlist ?? [];
    const gitWrites = gitWriteRisks(allowlist);
    if (gitWrites.length > 0) {
      return ineligible(
        "PROFILE_UNSUPPORTED",
        `shell allowlist entries could write Git (FR-GIT-01): ${gitWrites.map((g) => g.command).join("; ")}`,
      );
    }
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
        renderObjective(request),
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

  /**
   * One `--format json` line -> normalized events (T4.53). Structured fields only (FR-ADP-04): the session id is the
   * `sessionID` of the first event that carries one, and only if resume could pass it as one argument. The `result`
   * event comes from a `step_finish` whose `part.reason` is `stop` (Q-85) or, under owner decision 68 (Q-85 narrowed;
   * [LIVE] 4a), from a non-empty `text` while no tool event and no `step_finish` has been seen: v2.0.23 often ends a
   * short reply with no `step_finish`. A later tool call without a `stop` fails the order check in
   * {@link extractResult}, and a non-`stop` `step_finish` right after a text-only reply is a protocol error, so a run
   * with a tool event keeps the `stop` requirement. Events do not name the provider or model used in native captures ([LIVE] 4c);
   * structured backing_provider and model fields are supported for fronted harnesses (T4.6, FR-ADP-10) and stay unset
   * when not reported.
   */
  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[] {
    if (typeof input !== "string") return []; // no ACP transport for OpenCode (TDD §4.6)
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
    const out: NormalizedEvent[] = [];
    const facts = streamFacts.get(state) ?? { tool: false, finish: false, textOnlyLast: false };
    streamFacts.set(state, facts);
    const part = obj(ownProp(e, "part"));
    const rawBacking =
      ownProp(e, "backing_provider") ??
      ownProp(e, "backingProvider") ??
      ownProp(part, "backing_provider") ??
      ownProp(part, "backingProvider");
    const rawModel = ownProp(e, "model") ?? ownProp(part, "model");
    const backingProvider = str(rawBacking);
    const model = str(rawModel);

    const id = str(ownProp(e, "sessionID")) ?? str(ownProp(part, "sessionID"));
    if (id !== undefined && id !== "") {
      if (!SESSION_ID_RE.test(id)) {
        // Proposed (fail closed): an id resume could not pass as one safe argument is never bound.
        out.push({ kind: "provider_error", category: PROTOCOL_CATEGORY, message: "session id is not a safe argument" });
      } else if (state.nativeSessionId === undefined) {
        state.nativeSessionId = id;
        out.push({
          kind: "session_bound",
          nativeSessionId: id,
          ...(model ? { model: clip(model, 128) } : {}),
          ...(backingProvider ? { backingProvider: clip(backingProvider, 128) } : {}),
        });
      } else if (id !== state.nativeSessionId) {
        out.push({ kind: "provider_error", category: PROTOCOL_CATEGORY, message: "session id changed mid-run" });
      }
    }
    switch (type) {
      case EVENT.stepStart: {
        if (part === undefined) return [...out, ...this.#unknown(state, type)];
        const rawPartType = ownProp(part, "type");
        const partType = str(rawPartType);
        if (rawPartType !== undefined && partType !== "step-start") {
          return [...out, ...this.#unknown(state, partType === undefined ? type : `${type}:${partType}`)];
        }
        return out;
      }
      case EVENT.text: {
        const text = str(ownProp(part, "text"));
        if (text === undefined) return [...out, ...this.#unknown(state, type)];
        if (text === "") return out;
        out.push({ kind: "message", role: "assistant", text: clip(text, MAX_SUMMARY_CHARS) });
        if (!facts.tool && !facts.finish) {
          facts.textOnlyLast = true;
          out.push({ kind: "result", ok: true, summary: TEXT_ONLY_RESULT_SUMMARY });
        }
        return out;
      }
      case EVENT.toolUse: {
        facts.tool = true;
        facts.textOnlyLast = false;
        const name = str(ownProp(part, "tool"));
        if (name === undefined) return [...out, ...this.#unknown(state, type)];
        const partState = obj(ownProp(part, "state"));
        const input = obj(ownProp(partState, "input"));
        // Assumption: the shell input names its command line `command` and the file tools their path `filePath` or
        // `path`; the live check recorded `state.input` but not its keys. Without them the guard sees no command.
        // Proposed (fail closed, T4.56): a tool name not in TOOL_KINDS whose input carries a string `command` is a shell
        // tool, so its command line reaches the tool-call guard (ADR-0039) whatever the tool is called.
        const inputCommand = str(ownProp(input, "command"));
        const kind = own(TOOL_KINDS, name) ?? (inputCommand !== undefined ? "shell" : "other");
        const command = kind === "shell" ? inputCommand : undefined;
        const target =
          kind === "read" || kind === "edit"
            ? (str(ownProp(input, "filePath")) ?? str(ownProp(input, "path")))
            : undefined;
        return [
          ...out,
          {
            kind: "tool_call",
            tool: kind,
            name: clip(name, 64),
            ...(command !== undefined ? { command } : {}),
            ...(target !== undefined ? { target: clip(target, MAX_TARGET_CHARS) } : {}),
          },
        ];
      }
      case EVENT.stepFinish: {
        const afterTextOnly = facts.textOnlyLast;
        facts.finish = true;
        facts.textOnlyLast = false;
        const reason = str(ownProp(part, "reason"));
        if (reason === undefined) return [...out, ...this.#unknown(state, type)];
        if (afterTextOnly && reason !== REASON_STOP) {
          // Owner decision 68: the text-only rule covers a run with no `step_finish` only; a step that ends any other
          // way than `stop` straight after a text-only reply is not a success (fail closed).
          out.push({ kind: "provider_error", category: PROTOCOL_CATEGORY, message: "step finished without stop" });
        }
        const partId = str(ownProp(part, "id"));
        const seen = seenParts.get(state) ?? new Set<string>();
        seenParts.set(state, seen);
        if (partId === undefined || !seen.has(partId)) {
          if (partId !== undefined) seen.add(partId);
          const metrics = this.#metrics(part);
          if (Object.keys(metrics).length > 0) out.push({ kind: "usage", source: "provider_reported", metrics });
        }
        if (reason === REASON_STOP) out.push({ kind: "result", ok: true });
        return out;
      }
      case EVENT.error: {
        const rawErr = ownProp(e, "error");
        const err = obj(rawErr);
        const errType = str(ownProp(err, "type"));
        const message = str(ownProp(err, "message")) ?? str(rawErr);
        if (errType === undefined && message === undefined) {
          if (rawErr === undefined || rawErr === null) return [...out, ...this.#unknown(state, type)];
          const ev: NormalizedEvent = {
            kind: "provider_error",
            category: "unknown",
            message: clip(JSON.stringify(rawErr), MAX_SUMMARY_CHARS),
          };
          return [...out, ev];
        }
        const category = (errType !== undefined ? own(ERROR_TYPE_CATEGORIES, errType) : undefined) ?? "unknown";
        const ev: NormalizedEvent = {
          kind: "provider_error",
          category,
          message: clip(`${errType ?? "error"}: ${message ?? ""}`, MAX_SUMMARY_CHARS),
        };
        return [...out, ev];
      }
      default:
        return [...out, ...this.#unknown(state, type)];
    }
  }

  /** `step_finish` token counts and cost, as reported (no sums, no defaults; FR-CAP-01). */
  #metrics(part: Json | undefined): Record<string, number | string | null> {
    const metrics: Record<string, number | string | null> = {};
    const tokens = obj(ownProp(part, "tokens"));
    for (const [path, metric] of TOKEN_KEYS) {
      let v: unknown = tokens;
      for (const k of path) v = obj(v) ? ownProp(obj(v), k) : undefined;
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) metrics[metric] = v;
    }
    const cost = ownProp(part, "cost");
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) metrics.cost_usd = cost;
    return metrics;
  }

  #unknown(state: ParseState, rawType: string): NormalizedEvent[] {
    state.unknownEvents += 1;
    return [{ kind: "unknown", rawType: clip(rawType, 64) }];
  }

  /**
   * Success needs a clean expected exit, a final `result` (a `step_finish` with reason `stop`, Q-85, or a text-only
   * reply, owner decision 68; see {@link parseEvent}) and no `provider_error`,
   * `permission_denied`, `sandbox_violation` or `rate_limit` event and no `tool_call` the tool-call guard flagged with a
   * `violation` (fail closed; a guard verdict ends the run in every run, bypass included, ADR-0039), no `tool_use`
   * line, read or not, after the last result, and no `unknown` event anywhere in the stream. The summary is the joined
   * assistant text, last {@link MAX_SUMMARY_CHARS} characters.
   */
  extractResult(events: readonly NormalizedEvent[], exit: ExitInfo): RunResult {
    const unknownEventCount = events.filter((e) => e.kind === "unknown").length;
    const bound = events.find((e) => e.kind === "session_bound");
    const nativeSessionId = bound?.kind === "session_bound" ? bound.nativeSessionId : undefined;
    const text = events.flatMap((e) => (e.kind === "message" ? [e.text] : [])).join("\n");
    const summary = text === "" ? undefined : text.slice(-MAX_SUMMARY_CHARS);
    const finalAt = events.findLastIndex((e) => e.kind === "result");
    const final = events[finalAt];
    // Proposed (fail closed, Q-85): a tool call after the last result (a `stop` step or a text-only reply) means the run did not end there. A
    // `tool_use` line the parser could not read (no string `part.tool`) counts too: it parses as `unknown`, as Grok.
    const trailingTool =
      finalAt >= 0 &&
      events
        .slice(finalAt + 1)
        .some((e) => e.kind === "tool_call" || (e.kind === "unknown" && e.rawType === EVENT.toolUse));
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
      unknownEventCount === 0 &&
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
    // Proposed (fail closed, T4.56): a line the parser could not read (an unknown event kind, or a known kind missing
    // its field) may be a step, tool call or refusal it cannot see, so it never leaves the run a success.
    const detail =
      c.code !== "OUTPUT_PROTOCOL_ERROR"
        ? c.detail
        : trailingTool
          ? final?.kind === "result" && final.summary === TEXT_ONLY_RESULT_SUMMARY
            ? "tool call after a text-only reply without a stop step"
            : "tool call after the final stop step"
          : unknownEventCount > 0 && final?.kind === "result" && final.ok
            ? `${unknownEventCount} unreadable event(s) in the stream`
            : c.detail;
    return { ok: false, failureCode: c.code, failureDetail: detail, ...base };
  }

  classifyFailure(evidence: FailureEvidence): FailureClassification {
    return classifyCommon(evidence, CATEGORY_CODES);
  }
}
