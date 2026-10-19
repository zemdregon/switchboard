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
 * Parser, result, failure classification and resume (T4.63, synthetic fixtures plus the one [CAP] capture): the
 * `stream-json` parser reads the recorded `meta`/`assistant` records and the documented tool records (field names an
 * Assumption), binds the session id from the resume hint and ends the turn there; ACP messages use the shared mapping
 * (`mapAcpMessage`, ADR-0036). Resume is `--session <id>` in the bypass cell and ACP `session/resume` otherwise, through
 * the same matrix. The auth preflight (T4.64) is the ACP probe of ADR-0049 item 4 (`initialize`, then `session/new` in a
 * scratch directory; `-32000` is AUTH_REQUIRED, anything unrecognised UNKNOWN). The manifest range admits no version,
 * so none of this runs before `adapters validate` passes a version (FR-ADP-09, T4.68).
 */

import { defaultRedactor } from "../../artifacts/redact.js";
import { ACP_AUTH_REQUIRED_CODE, acpRunSucceeded, mapAcpMessage } from "../../exec/acp/events.js";
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
  ProbeOutput,
  ProbeResult,
  ProbeRunner,
  ProviderAdapter,
  ResolvedProfile,
  RunResult,
  SkillDelivery,
} from "../types.js";
import {
  ACP_CONFIG_MODEL,
  ACP_METHOD_INITIALIZE,
  ACP_METHOD_SESSION_NEW,
  ACP_MODE_PLAN,
  ACP_SUBCOMMAND,
  AUTH_PROBE_INITIALIZE_ID,
  AUTH_PROBE_SESSION_ID,
  ERROR_AUTH_PREFIX,
  GIT_WRITE_CONTROL_DETAIL,
  HELP_FLAG,
  KIMI_BINARY,
  KIMI_LOGIN_COMMAND,
  META_ERROR_RE,
  META_RESUME_HINT,
  META_VERSION,
  MODEL_FLAG,
  NON_PRIVILEGED_UNSUPPORTED_DETAIL,
  OUTPUT_FORMAT_FLAG,
  OUTPUT_STREAM_JSON,
  PROMPT_FLAG,
  REQUIRED_HELP_FLAGS,
  RESUME_HINT_SESSION_KEY,
  ROLE,
  SESSION_FLAG,
  TOOL_CALLS_KEY,
  VERSION_ARGS,
} from "./protocol.js";
import { withScratchDir } from "./scratch.js";

/**
 * Environment names passed through to Kimi Code (FR-EXE-07, NFR-SEC-02). Proposed: `PATH` for the binary and `HOME` so
 * the CLI finds its own native login. `KIMI_CODE_HOME` (relocates configuration, sessions and credentials, [K10]) stays
 * out.
 */
export const KIMI_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME"];

const PROBE_TIMEOUT_MS = 10_000;
/**
 * Auth probe bound (Proposed): [LIVE] 8 to 10 replied within 2 s; under the ADR-0036 item 4 `initialize` target (30 s).
 * If the CLI keeps running after stdin closes, every probe lasts this long, which the preflight cache absorbs.
 */
const AUTH_PROBE_TIMEOUT_MS = 15_000;
const AUTH_UNKNOWN_REASON = "Kimi Code ACP auth probe was inconclusive";
/** A model alias passed as one argv word or config value; refuse anything that could be read as a flag (Proposed). */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/;
/**
 * A native session id passed as one argv word or ACP `sessionId`; refuse anything that could be read as a flag
 * (Proposed). [CAP] and [LIVE] 9 show `session_<uuid>`, so `_` is allowed after the first character.
 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_DIAGNOSTIC_CHARS = 160;

/**
 * T4.64 diagnostics (Proposed): the first non-blank stderr line, scrubbed for an `UNKNOWN` reason. Secrets go through
 * the artifact redactor; then every path (absolute or `~`), e-mail address, UUID, long hex or digit run and long
 * mixed token is replaced, control characters are dropped and the result is clipped. Best effort, not a guarantee:
 * the probe sends no prompt, so stderr should hold only the CLI's own log line.
 */
export function scrubStderrLine(stderr: string, home: string | undefined = process.env.HOME): string | undefined {
  const first = stderr.split(/\r?\n/).find((l) => l.trim() !== "");
  if (first === undefined) return undefined;
  let line = defaultRedactor(Buffer.from(first, "utf8")).toString("utf8");
  if (home !== undefined && home.length > 1) line = line.split(home).join("~");
  line = line
    .replace(/\p{Cc}/gu, " ")
    .replace(/(?:~|\b[A-Za-z]:)?(?:[\\/][^\s"'`,;:()[\]{}<>]+)+/g, "<path>")
    .replace(/~/g, "<path>")
    .replace(/[^\s"'`<>@]+@[^\s"'`<>@]+/g, "<email>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>")
    .replace(/\b\d{6,}\b/g, "<n>")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g, "<token>")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > MAX_DIAGNOSTIC_CHARS ? `${line.slice(0, MAX_DIAGNOSTIC_CHARS)}...` : line;
}

/** How the probe process ended, for an `UNKNOWN` reason: exit or timeout, stdin state and the scrubbed stderr line. */
function probeDiagnostic(r: ProbeOutput): string {
  const parts = [r.timedOut ? "timed out" : `exit ${r.exitCode}`];
  if (r.stdinOpenAtEnd !== undefined) parts.push(r.stdinOpenAtEnd ? "stdin still open" : "stdin closed");
  const stderr = scrubStderrLine(r.stderr);
  if (stderr !== undefined && stderr !== "") parts.push(`stderr: ${JSON.stringify(stderr)}`);
  return parts.join(", ");
}
const MAX_MESSAGE_CHARS = 4_000;
const MAX_NAME_CHARS = 64;
const MAX_TARGET_CHARS = 512;
/** Tool names read as edits when a call carries a path but no command (Proposed; Kimi's tool names: T4.68). */
const EDIT_NAME_RE = /write|edit|replace|patch|create|delete|remove|move|rename/i;

type Json = Record<string, unknown>;
function ownProp(record: Json | undefined, key: string): unknown {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** A JSON-RPC response's error code for an UNKNOWN reason: an integer only, never provider text. */
const errorCode = (response: Json): string => {
  const code = ownProp(obj(ownProp(response, "error")), "code");
  return Number.isSafeInteger(code) ? `error ${String(code)}` : "without a usable result";
};

/** Per-run `stream-json` state: whether the resume hint (end of the turn) was seen. */
const seenHints = new WeakMap<ParseState, number>();
/**
 * `result` events produced from an ACP `session/prompt` response. Only these take the ACP success rule (the client ends
 * the agent after the result, so its exit status is not evidence, ADR-0036 item 8.3); every other result needs an
 * expected exit code (fail closed).
 */
const acpResults = new WeakSet<NormalizedEvent>();
/** Category of a stream anomaly (two resume hints, a changed or unsafe id, a record after the hint, an unreadable tool call). */
const PROTOCOL_CATEGORY = "protocol";
const CATEGORY_CODES = { ...PROVIDER_ERROR_CATEGORY_CODES, [PROTOCOL_CATEGORY]: "OUTPUT_PROTOCOL_ERROR" } as const;
/**
 * T6.15 quota-stop phrases (`kimiQuotaClassification`): the `403` status is matched on word boundaries on one
 * stderr line, `usage limit` case-insensitively on the same line (the captured `5-hour usage limit` keeps its case).
 */
const KIMI_QUOTA_STATUS_RE = /\b403\b/;
const KIMI_QUOTA_USAGE_RE = /usage limit/i;
const protocolError = (message: string): NormalizedEvent => ({
  kind: "provider_error",
  category: PROTOCOL_CATEGORY,
  message,
});

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
  /** T7.12 (FR-RTE-08): the one `stream-json` capture carries no model field ([CAP], T4.63); ACP: T4.68. */
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

  /**
   * FR-AUTH-01/02 via the ACP probe (T4.64, ADR-0049 item 4; spellings and Assumptions in protocol.ts): `kimi acp` in a
   * fresh scratch directory, sent `initialize` (version 1, no client capability, the ADR-0036 client's shape) and
   * `session/new` (that directory, no `mcpServers`) on stdin, which is held open until a reply for each id has arrived
   * or the timeout (2.1.1 can exit 0 at end-of-file before the `session/new` reply). Only the JSON-RPC replies decide,
   * whatever the exit code or timeout: an `initialize` result with protocol version 1 and then a `session/new` result with a safe `sessionId`
   * is OK; a `session/new` error `-32000` is AUTH_REQUIRED naming `kimi login`; anything else (no or duplicate replies,
   * another error, a line that is not JSON, a spawn failure) is UNKNOWN (fail closed, NFR-SEC-06). The reason carries
   * codes, the exit, the stdin state and at most one scrubbed stderr line ({@link scrubStderrLine}), never the
   * JSON-RPC message text. Never `authenticate`, `--login` or a prompt: no model call and no login. No Kimi
   * file is read and `KIMI_CODE_HOME` is never set. The probe session persists in Kimi's data directory ([LIVE] 12),
   * so this runs once per preflight window (the preflight cache), not per run.
   */
  async authPreflight(runner: ProbeRunner): Promise<AuthResult> {
    const exe = this.#exe;
    if (exe === undefined) return { state: "UNKNOWN", reason: `${KIMI_BINARY} not found on PATH` };
    let r: ProbeOutput;
    try {
      r = await withScratchDir((dir) => {
        const lines = [
          {
            jsonrpc: "2.0",
            id: AUTH_PROBE_INITIALIZE_ID,
            method: ACP_METHOD_INITIALIZE,
            params: {
              protocolVersion: 1,
              clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
              clientInfo: { name: "switchboard", version: "0.0.0" },
            },
          },
          {
            jsonrpc: "2.0",
            id: AUTH_PROBE_SESSION_ID,
            method: ACP_METHOD_SESSION_NEW,
            params: { cwd: dir, mcpServers: [] },
          },
        ];
        const stdinText = lines.map((l) => `${JSON.stringify(l)}\n`).join("");
        // Kimi Code 2.1.1 can exit 0 at stdin end-of-file after the `initialize` reply and before the `session/new`
        // reply (T4.64 fix), so stdin stays open until a reply for each request id has arrived, or the timeout.
        const answered = new Set<unknown>();
        return runner([exe, ...this.#launcher, ACP_SUBCOMMAND], {
          cwd: dir,
          timeoutMs: AUTH_PROBE_TIMEOUT_MS,
          stdinText,
          holdStdinUntil: (message) => {
            const msg = obj(message);
            if (msg !== undefined && !Object.hasOwn(msg, "method") && Object.hasOwn(msg, "id")) answered.add(msg.id);
            return answered.has(AUTH_PROBE_INITIALIZE_ID) && answered.has(AUTH_PROBE_SESSION_ID);
          },
        });
      });
    } catch {
      return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (the probe could not run)` };
    }
    if (r.spawnError !== undefined) return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (${r.spawnError})` };
    const replies = new Map<unknown, Json[]>();
    for (const line of r.stdout.split("\n")) {
      if (line.trim() === "") continue;
      let msg: Json | undefined;
      try {
        msg = obj(JSON.parse(line));
      } catch {
        msg = undefined;
      }
      if (msg === undefined) return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (stdout line is not JSON)` };
      // Agent notifications and requests (`session/update`, ...) carry a method; only responses decide.
      if (Object.hasOwn(msg, "method") || !Object.hasOwn(msg, "id")) continue;
      replies.set(msg.id, [...(replies.get(msg.id) ?? []), msg]);
    }
    const one = (id: number): Json | "missing" | "duplicate" => {
      const got = replies.get(id) ?? [];
      return got.length === 0 ? "missing" : got.length > 1 ? "duplicate" : (got[0] as Json);
    };
    const exit = probeDiagnostic(r);
    const init = one(AUTH_PROBE_INITIALIZE_ID);
    if (typeof init === "string") {
      return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (initialize ${init}, ${exit})` };
    }
    if (ownProp(obj(ownProp(init, "result")), "protocolVersion") !== 1) {
      return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (initialize ${errorCode(init)}, ${exit})` };
    }
    const session = one(AUTH_PROBE_SESSION_ID);
    if (typeof session === "string") {
      return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (session/new ${session}, ${exit})` };
    }
    const error = obj(ownProp(session, "error"));
    if (error !== undefined) {
      if (ownProp(error, "code") === ACP_AUTH_REQUIRED_CODE && !Object.hasOwn(session, "result")) {
        return { state: "AUTH_REQUIRED", loginCommand: KIMI_LOGIN_COMMAND };
      }
      return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (session/new ${errorCode(session)}, ${exit})` };
    }
    const sessionId = str(ownProp(obj(ownProp(session, "result")), "sessionId"));
    if (sessionId !== undefined && SESSION_ID_RE.test(sessionId)) return { state: "OK" };
    return { state: "UNKNOWN", reason: `${AUTH_UNKNOWN_REASON} (session/new returned no usable sessionId, ${exit})` };
  }

  /**
   * T16.7 (TDD §3.16.1, LLD §19.6, ADR-0056 items 5, 6 and 8): every cell delivers skills as the prompt prefix. A cell
   * may name `native` only with the evidence id of a T16.8 live check; the conformance suite fails one without it.
   */
  skillDelivery(): SkillDelivery {
    return "prompt_prefix";
  }

  compile(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    return this.#build(request, profile);
  }

  /**
   * FR-SES-03 (T4.63): the stored native id through the same matrix as a first run (so the same Ineligible reasons):
   * `--session <id>` after the bypass cell's flags (ADR-0049 item 1: no restriction added), or ACP `session/resume`
   * (else `session/load`, chosen by the client from `initialize`, [LIVE] 8) for a restricted run. A binding of another
   * provider, or an id that is not one safe argument, is never compiled. Whether a resumed `-p` run keeps the model of
   * the first run, and resume from another directory, are `Unverified: T4.68`, so the model is passed again.
   */
  resumeArgs(binding: NativeBinding, request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== "kimi") return ineligible("CAPABILITY_MISSING", `binding is for ${binding.provider}`);
    if (!SESSION_ID_RE.test(binding.nativeSessionId)) {
      return ineligible("CAPABILITY_MISSING", "native session id is not a safe single argument");
    }
    return this.#build(request, profile, binding.nativeSessionId);
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
   * then the bypass cell compiles `--prompt` and the restricted cell compiles ACP; `resumeId` adds the resume.
   */
  #build(request: CompileRequest, profile: ResolvedProfile, resumeId?: string): Invocation | Ineligible {
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
    return scope.bypass ? this.#bypassInvocation(request, resumeId) : this.#acpInvocation(request, readOnly, resumeId);
  }

  /** ADR-0049 item 1: exactly the prompt, the output format and an optional model; nothing restricts the run. */
  #bypassInvocation(request: CompileRequest, resumeId: string | undefined): Invocation {
    const exe = this.#exe as string;
    const policyFlags = [PROMPT_FLAG];
    return {
      transport: "subprocess-jsonl",
      // One word each (Assumption, see protocol.ts): the prompt is visible in the process list.
      argv: [
        exe,
        ...this.#launcher,
        ...(request.model !== undefined ? [`${MODEL_FLAG}=${request.model}`] : []),
        `${PROMPT_FLAG}=${renderObjective(request)}`,
        OUTPUT_FORMAT_FLAG,
        OUTPUT_STREAM_JSON,
        ...(resumeId !== undefined ? [SESSION_FLAG, resumeId] : []),
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
  #acpInvocation(request: CompileRequest, readOnly: boolean, resumeId: string | undefined): Invocation {
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
        prompt: renderObjective(request),
        session: resumeId === undefined ? { kind: "new" } : { kind: "resume", nativeSessionId: resumeId },
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

  /**
   * One `stream-json` line or one ACP message -> normalized events (T4.63). ACP messages take the shared mapping
   * (ADR-0036 item 8; the client binds the session from `session/new`). `stream-json` reads structured fields only
   * (FR-ADP-04), by `role`:
   * - `meta` `system.version`: nothing; `meta` `session.resume_hint` with a safe `session_id`: binds the session and is
   *   the end of the turn (`result` ok, [CAP]); `meta` whose `type` is an error: `provider_error` (Assumption);
   * - `assistant`: its text content (string, or `text` parts; other parts such as thinking are dropped, NFR-PRIV-02)
   *   is a message, and each `tool_calls` item a `tool_call` for the ADR-0039 guard;
   * - `tool`: tool output, never an event (untrusted, not a result);
   * - anything else is an `unknown` event and never a result.
   * Hardening (fail closed, as Grok Build T4.23): a second resume hint, an id that changes or is not a safe argument,
   * an `assistant` or `tool` record after the hint, and a tool call whose name or arguments cannot be read are
   * OUTPUT_PROTOCOL_ERROR.
   */
  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[] {
    if (typeof input !== "string") {
      const out = mapAcpMessage(input, state, KIMI_LOGIN_COMMAND);
      for (const e of out) if (e.kind === "result") acpResults.add(e);
      return out;
    }
    state.lines += 1;
    let doc: unknown;
    try {
      doc = JSON.parse(input);
    } catch {
      return []; // the supervisor ends the run OUTPUT_PROTOCOL_ERROR on unparseable framing
    }
    const e = obj(doc);
    const role = str(ownProp(e, "role"));
    if (e === undefined || role === undefined) return this.#unknown(state, "none");
    const ended = (seenHints.get(state) ?? 0) > 0;
    switch (role) {
      case ROLE.meta:
        return this.#meta(e, state);
      case ROLE.assistant: {
        const out = ended ? [protocolError("assistant record after the resume hint")] : [];
        const text = contentText(ownProp(e, "content"));
        if (text !== undefined && text !== "") {
          out.push({ kind: "message", role: "assistant", text: clip(text, MAX_MESSAGE_CHARS) });
        }
        const calls = ownProp(e, TOOL_CALLS_KEY);
        if (calls !== undefined && calls !== null) {
          if (!Array.isArray(calls)) return [...out, protocolError("tool_calls is not a list")];
          for (const c of calls) out.push(toolCallEvent(c));
        }
        if (out.length === 0 && text === undefined && calls === undefined) return this.#unknown(state, role);
        return out;
      }
      case ROLE.tool:
        return ended ? [protocolError("tool record after the resume hint")] : [];
      default:
        return this.#unknown(state, role);
    }
  }

  #meta(e: Json, state: ParseState): NormalizedEvent[] {
    const type = str(ownProp(e, "type"));
    if (type === META_VERSION) return [];
    if (type === META_RESUME_HINT) {
      const id = str(ownProp(e, RESUME_HINT_SESSION_KEY));
      if (id === undefined || id === "") return this.#unknown(state, type);
      const hints = (seenHints.get(state) ?? 0) + 1;
      seenHints.set(state, hints);
      const out: NormalizedEvent[] = [];
      // One turn prints one hint ([CAP]); a second could follow a failure, so the run fails closed.
      if (hints > 1) out.push(protocolError("more than one resume hint"));
      out.push(...this.#bind(state, id));
      out.push(
        hints === 1 ? { kind: "result", ok: true } : { kind: "result", ok: false, summary: "second resume hint" },
      );
      return out;
    }
    if (type !== undefined && META_ERROR_RE.test(type)) {
      const message = str(ownProp(e, "message")) ?? str(ownProp(e, "content"));
      // An error record of any other shape is still an error, never ignored.
      if (message === undefined)
        return [{ kind: "provider_error", category: "unknown", message: "error record without text" }];
      const category = message.startsWith(ERROR_AUTH_PREFIX) ? "auth" : "unknown";
      return [{ kind: "provider_error", category, message: clip(message, MAX_SUMMARY_CHARS) }];
    }
    return this.#unknown(state, `meta:${type ?? "none"}`);
  }

  /**
   * The first id binds the session. A later, different id makes the binding ambiguous and an id resume could not pass
   * as one safe argument is never bound; both fail the run (Proposed, fail closed, as Grok Build and Cursor).
   */
  #bind(state: ParseState, id: string): NormalizedEvent[] {
    if (!SESSION_ID_RE.test(id)) return [protocolError("session id is not a safe argument")];
    if (state.nativeSessionId !== undefined) {
      return id === state.nativeSessionId ? [] : [protocolError("session id changed mid-run")];
    }
    state.nativeSessionId = id;
    return [{ kind: "session_bound", nativeSessionId: id }];
  }

  #unknown(state: ParseState, rawType: string): NormalizedEvent[] {
    state.unknownEvents += 1;
    return [{ kind: "unknown", rawType: clip(rawType, 64) }];
  }

  /**
   * Success needs a final `result` with `ok` and no `provider_error`, `permission_denied`, `sandbox_violation` or
   * `rate_limit` event and no `tool_call` the tool-call guard flagged with a `violation` (a guard verdict ends the run
   * in every run, bypass included, ADR-0039). A `stream-json` run also needs a clean expected exit (the resume hint
   * alone is an Assumption, [CAP]); an ACP run needs the client to have ended the turn (`acpRunSucceeded`, ADR-0036
   * item 8.3). The summary is the joined assistant text, last {@link MAX_SUMMARY_CHARS} characters. The failed
   * path below passes no stderr tail (the adapter contract passes none), so the T6.15 `403`/`usage limit` quota
   * mapping is not reached here either: it lives in `classifyFailure`, which a caller reaches with the stderr tail
   * `startAdapterRun` (`src/adapters/run.ts`) already captures.
   */
  extractResult(events: readonly NormalizedEvent[], exit: ExitInfo): RunResult {
    const unknownEventCount = events.filter((e) => e.kind === "unknown").length;
    const bound = events.findLast((e) => e.kind === "session_bound");
    const nativeSessionId = bound?.kind === "session_bound" ? bound.nativeSessionId : undefined;
    const text = events.flatMap((e) => (e.kind === "message" ? [e.text] : [])).join("\n");
    const summary = text === "" ? undefined : text.slice(-MAX_SUMMARY_CHARS);
    const final = events.findLast((e) => e.kind === "result");
    const base = {
      unknownEventCount,
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(summary ? { summary } : {}),
    };
    const exitOk =
      final !== undefined && acpResults.has(final)
        ? acpRunSucceeded(events, exit)
        : exit.outcome === "exited" && exit.exitCode !== null && exit.expectedExitCodes.includes(exit.exitCode);
    const clean =
      exitOk &&
      final?.kind === "result" &&
      final.ok &&
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
    return { ok: false, failureCode: c.code, failureDetail: c.detail, ...base };
  }

  /**
   * Shared precedence (failure.ts), then the T6.15 limit mapping: error text is already mapped to the shared
   * categories (`auth` from the observed `Authentication required` prefix or ACP `-32000`), and a stream anomaly
   * (category `protocol`) is OUTPUT_PROTOCOL_ERROR. A non-zero `-p` exit with no other evidence is TOOL_FAILURE
   * (K7: failed turns exit non-zero; the codes are `Unverified: T4.68`; [K2] goal codes 3 and 6 included). When the
   * common verdict is `TOOL_FAILURE` or `AUTH_REQUIRED`, the 5-hour usage-limit stderr signal
   * (`kimiQuotaClassification`) is checked next: the CLI labels that quota stop `provider.auth_error`, so without
   * this a usage stop reads as a logged-out provider. Every more specific verdict stands.
   */
  classifyFailure(evidence: FailureEvidence): FailureClassification {
    const common = classifyCommon(evidence, CATEGORY_CODES);
    if (common.code !== "TOOL_FAILURE" && common.code !== "AUTH_REQUIRED") return common;
    return kimiQuotaClassification(evidence) ?? common;
  }
}

/**
 * T6.15 (FR-CAP-11, FR-ADP-04; accepted: owner decision 64, ADR-0058): the Kimi Code 5-hour usage-limit stop of the 2026-10-15 T6.11 capture
 * (exit 1, stderr `provider.auth_error: 403 ... 5-hour usage limit ...`; capture file name in ROADMAP T6.15). A non-zero
 * exited run whose stderr tail holds a line with both `403` and `usage limit` maps to `QUOTA_EXHAUSTED`. The quota
 * signal is checked before the auth mapping: the CLI labels this quota stop `provider.auth_error`, and a stream
 * event for it would land in the `auth` or `unknown` category (today `AUTH_REQUIRED` or `TOOL_FAILURE`), which
 * would make the router treat a usage stop as a logged-out provider. A `403` without `usage limit` maps nothing,
 * so its current verdict stands. Requires an unexpected exit, so exit 0 never maps; a cancelled run never maps.
 * Every verdict more specific than `TOOL_FAILURE`/`AUTH_REQUIRED` (timeout, crash, the tool-call guard, a denial,
 * another provider error, a protocol anomaly, a rate limit) stands. Reached only through
 * `FailureEvidence.stderrTail`, which `extractResult` cannot supply (same gap as Antigravity's
 * `agyErrorClassification`).
 */
export function kimiQuotaClassification(evidence: FailureEvidence): FailureClassification | undefined {
  const { exit } = evidence;
  if (evidence.cancelled) return undefined;
  if (exit.outcome !== "exited" || exit.exitCode === null || exit.expectedExitCodes.includes(exit.exitCode)) {
    return undefined;
  }
  const hit = evidence.stderrTail
    .split("\n")
    .some((line) => KIMI_QUOTA_STATUS_RE.test(line) && KIMI_QUOTA_USAGE_RE.test(line));
  if (!hit) return undefined;
  return { code: "QUOTA_EXHAUSTED", detail: "quota: 403 usage limit" };
}

/** Text of an assistant `content`: a string, or the `text` of `{type:"text"}` parts (Assumption); else undefined. */
function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((p) => {
    const part = obj(p);
    const t = str(ownProp(part, "text"));
    return str(ownProp(part, "type")) === "text" && t !== undefined ? [t] : [];
  });
  return parts.join("");
}

/**
 * One `tool_calls` item -> a `tool_call` event (Assumption: `{id, type:"function", function:{name, arguments}}`, with
 * `arguments` a JSON string or object). The command is transient and evaluated by the guard (ADR-0039). An item whose
 * name or arguments cannot be read is OUTPUT_PROTOCOL_ERROR: under Never Ask the guard is the only Git-write check, so
 * a call it cannot see fails the run (fail closed).
 */
function toolCallEvent(item: unknown): NormalizedEvent {
  const call = obj(item);
  const fn = obj(ownProp(call, "function"));
  const rawName = str(ownProp(fn, "name")) ?? str(ownProp(call, "name"));
  const name = rawName !== undefined && rawName !== "" ? rawName : undefined;
  const rawArgs = fn !== undefined && Object.hasOwn(fn, "arguments") ? fn.arguments : ownProp(call, "arguments");
  let args: Json | undefined;
  if (rawArgs === undefined || rawArgs === null) args = {};
  else if (typeof rawArgs === "string") {
    try {
      args = obj(JSON.parse(rawArgs === "" ? "{}" : rawArgs));
    } catch {
      args = undefined;
    }
  } else args = obj(rawArgs);
  if (name === undefined || args === undefined) return protocolError("tool call without a readable name and arguments");
  const command = str(ownProp(args, "command")) ?? str(ownProp(args, "cmd"));
  const target =
    str(ownProp(args, "path")) ??
    str(ownProp(args, "file_path")) ??
    str(ownProp(args, "filePath")) ??
    str(ownProp(args, "target"));
  const tool =
    command !== undefined ? "shell" : target === undefined ? "other" : EDIT_NAME_RE.test(name) ? "edit" : "read";
  return {
    kind: "tool_call",
    tool,
    name: clip(name, MAX_NAME_CHARS),
    ...(command !== undefined ? { command } : {}),
    ...(target !== undefined && command === undefined ? { target: clip(target, MAX_TARGET_CHARS) } : {}),
  };
}
