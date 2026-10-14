/** Fake provider adapter implementing the LLD §2 contract against fake/cli.mjs (T1.7). */
import { fileURLToPath } from "node:url";
import { acpRunSucceeded, mapAcpMessage } from "../../exec/acp/events.js";
import {
  DEFAULT_IDLE_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_WALL_CLOCK_MS,
} from "../../exec/index.js";
import { classifyCommon } from "../failure.js";
import type {
  AcpMessage,
  AcpPlan,
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
  ResumeCwd,
  RunResult,
  Transport,
} from "../types.js";

export const FAKE_CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));
/** The scripted fake ACP agent (T4.8, ADR-0036 conformance plan). */
export const FAKE_ACP_AGENT_PATH = fileURLToPath(new URL("./acp-agent.mjs", import.meta.url));
/** Native login command the fake ACP plan names on AUTH_REQUIRED. */
export const FAKE_ACP_LOGIN_COMMAND = "fake-acp login";

/** Fake CLI flag that carries the shim command (JSON) for the injected tool channel (T9.4). */
export const FAKE_TOOL_CHANNEL_FLAG = "--tool-channel";

export type FakeScenario =
  | "success"
  | "task_failure"
  | "auth_missing"
  | "rate_limit"
  | "partial_mutation"
  | "malformed_output"
  | "hang"
  | "hang_ignore_term"
  /**
   * T9.4: with the injected tool channel (`--tool-channel`), writes files into its working directory and calls the
   * `commit` tool through the shim, as an agent would; the objective may be a JSON plan (see `cli.mjs`).
   */
  | "git_commit"
  /**
   * T9.5 (FR-GIT-03): plays an agent that writes to Git by itself with plain Git commands in its working directory (the
   * run worktree, against temporary local repositories only): `git commit`, `branch`, `tag`, `update-ref`, `push` to a
   * local bare repository, `reset --hard`, `checkout -b`, plus optional `commit` tool calls. The objective is a JSON
   * plan (see `cli.mjs`). It never leaves the worktree, reads no credential and uses no network.
   */
  | "git_attempts"
  /** Benign: reports the names (not values) of its environment variables (T3.8, FR-EXE-07). */
  | "env_report"
  /** T4.6 (FR-ADP-10): reports placeholder `backing_provider` and model on the session event, then usage. */
  | "fronted"
  /**
   * T9.7 (FR-GIT-09): plays an agent without a tool channel that edits files and ends with a structured summary. The
   * objective is a JSON plan `{"files": {"<rel path>": "<content>" | null}, "summary": "<text>" | null, "ok": true}`
   * (`null` content deletes the file; a `null` summary emits a result without one; `ok: false` ends as a task failure).
   * T5.5: in a handoff prompt the plan is the text after the `[instruction from the orchestrator]` line (as for
   * `git_commit` and `git_attempts`); the CLI's state recorder keeps the whole prompt.
   */
  | "edit_files";

export interface FakeAdapterOptions {
  scenario?: FakeScenario;
  /** Absolute path of the executable (Proposed: node) and script. Defaults to the bundled fake CLI. */
  executable?: string;
  script?: string;
  timeouts?: Partial<Invocation["timeouts"]>;
  /**
   * T9.7 test variant: `none` declares no injected channel (as Claude Code and Codex do today), so the lifecycle offers
   * no `commit` tool and finalize-only mode can apply. Default `injected`.
   */
  commitChannel?: "injected" | "none";
  /**
   * T5.7 test variant (ADR-0038 item 6.3, LLD §15.6): the fake's `resumeCwd` declaration. Default `bound` (a resume
   * reuses the origin worktree path); `independent` is the unbound variant, `unverified` the fail-closed one.
   */
  resumeCwd?: ResumeCwd;
  /**
   * T4.8 test variant (ADR-0036 conformance plan; ADR-0035 item 4 test-only entry): compile `acp-stdio` invocations
   * that run the scripted fake ACP agent with this fixture, recording what it receives to `record`. Unlike the JSONL
   * mode, every profile compiles (the fake has no native controls; the permission answers are what the tests exercise).
   */
  acp?: {
    fixture: string;
    record?: string;
    modeId?: string;
    configOptions?: Array<{ configId: string; value: string }>;
    mcpServers?: AcpPlan["mcpServers"];
  };
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export class FakeAdapter implements ProviderAdapter {
  readonly id = "fake" as const;
  readonly transports: readonly Transport[];
  /** Test double: no provider exists, so there is no provider control to declare (FR-GIT-01). */
  readonly gitWriteControl: GitWriteControl = {
    kind: "none-documented",
    detail: "fake test adapter; no provider permission controls exist",
    remainingControls: ["FR-GIT-03", "FR-GIT-06"],
  };
  /**
   * FR-GIT-02 (T9.4): the fake CLI receives the shim command in argv (`--tool-channel <json>`, no secret) and the token
   * in its environment, then starts the shim itself, as a provider would from a per-run MCP definition.
   */
  /** T5.7: see {@link FakeAdapterOptions.resumeCwd}. */
  readonly resumeCwd: ResumeCwd;
  readonly gitCapabilities: GitCapabilities;
  readonly #scenario: FakeScenario;
  readonly #exe: string;
  readonly #script: string;
  readonly #timeouts: Invocation["timeouts"];
  readonly #acp: FakeAdapterOptions["acp"];

  constructor(opts: FakeAdapterOptions = {}) {
    this.#acp = opts.acp;
    this.transports = opts.acp ? ["acp-stdio"] : ["subprocess-jsonl"];
    this.resumeCwd = opts.resumeCwd ?? "bound";
    this.gitCapabilities =
      opts.commitChannel === "none"
        ? { commitChannel: "none", detail: "fake test adapter variant without a tool channel (T9.7 tests)" }
        : {
            commitChannel: "injected",
            detail: "fake test adapter: shim command in argv (--tool-channel), token in the environment",
            channelArgs: (shim) => ({
              argv: [FAKE_TOOL_CHANNEL_FLAG, JSON.stringify({ command: shim.command, tools: shim.toolNames })],
              env: { ...shim.env },
            }),
          };
    this.#scenario = opts.scenario ?? "success";
    this.#exe = opts.executable ?? process.execPath;
    this.#script = opts.script ?? FAKE_CLI_PATH;
    this.#timeouts = {
      wallClockMs: DEFAULT_WALL_CLOCK_MS,
      idleMs: DEFAULT_IDLE_MS,
      killGraceMs: DEFAULT_KILL_GRACE_MS,
      ...opts.timeouts,
    };
  }

  async probe(runner: ProbeRunner): Promise<ProbeResult> {
    const ver = await runner([this.#exe, this.#script, "--version"]);
    const binaryOk = ver.spawnError === undefined && ver.exitCode === 0;
    const version = binaryOk ? (/^fake-cli (\S+)/.exec(ver.stdout)?.[1] ?? null) : null;
    const smoke = binaryOk ? await runner([this.#exe, this.#script, "--smoke"]) : undefined;
    const smokeOk = smoke?.exitCode === 0 && smoke.stdout.includes('"type":"result"');
    const fixed = (step: "command" | "output_format" | "flags") => ({
      step,
      ok: binaryOk,
      detail: "fixed by the fake CLI",
    });
    return {
      binaryPath: this.#exe,
      binaryVersion: version,
      steps: [
        { step: "binary", ok: binaryOk, ...(ver.spawnError ? { detail: ver.spawnError } : {}) },
        { step: "version", ok: version !== null },
        fixed("command"),
        fixed("output_format"),
        fixed("flags"),
        { step: "smoke", ok: smokeOk },
      ],
    };
  }

  async authPreflight(runner: ProbeRunner): Promise<AuthResult> {
    const r = await runner([this.#exe, this.#script, "--scenario", this.#scenario, "--auth-status"]);
    if (r.spawnError !== undefined || r.timedOut) return { state: "UNKNOWN", reason: r.spawnError ?? "timed out" };
    try {
      const parsed = JSON.parse(r.stdout) as Json;
      if (parsed.authenticated === true && r.exitCode === 0) return { state: "OK" };
      if (parsed.authenticated === false) return { state: "AUTH_REQUIRED", loginCommand: "fake-cli login" };
    } catch {
      // fall through
    }
    return { state: "UNKNOWN", reason: "unparseable auth status" };
  }

  compile(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    return this.#build(request, profile, []);
  }

  resumeArgs(binding: NativeBinding, request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    if (binding.provider !== "fake") {
      return { ineligible: true, reason: "CAPABILITY_MISSING", detail: `binding is for ${binding.provider}` };
    }
    return this.#build(request, profile, ["--resume", binding.nativeSessionId]);
  }

  #build(request: CompileRequest, profile: ResolvedProfile, extra: string[]): Invocation | Ineligible {
    if (this.#acp) return this.#buildAcp(request, extra[1]);
    if (profile.name === "privileged" || profile.bypassApproved) {
      return { ineligible: true, reason: "PROFILE_UNSUPPORTED", detail: "fake adapter has no privileged mode" };
    }
    return {
      transport: "subprocess-jsonl",
      argv: [this.#exe, this.#script, "--scenario", this.#scenario, ...extra],
      env: {},
      envAllowlist: ["PATH"],
      cwd: request.workspace.cwd,
      stdin: { kind: "text", value: request.objective },
      outputFormat: "jsonl",
      timeouts: { ...this.#timeouts },
      policyFlags: [],
      expectedExitCodes: [0],
      maxLineBytes: DEFAULT_MAX_LINE_BYTES,
    };
  }

  /** `acp-stdio` (T4.8): the fake ACP agent with the fixture; the client owns stdin, so no stdin text. */
  #buildAcp(request: CompileRequest, resumeId: string | undefined): Invocation {
    const a = this.#acp as NonNullable<FakeAdapterOptions["acp"]>;
    return {
      transport: "acp-stdio",
      argv: [this.#exe, FAKE_ACP_AGENT_PATH, "--fixture", a.fixture, ...(a.record ? ["--record", a.record] : [])],
      env: {},
      envAllowlist: ["PATH"],
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
        session: resumeId === undefined ? { kind: "new" } : { kind: "resume", nativeSessionId: resumeId },
        mcpServers: a.mcpServers ?? [],
        ...(a.modeId !== undefined ? { modeId: a.modeId } : {}),
        ...(a.configOptions ? { configOptions: a.configOptions } : {}),
        loginCommand: FAKE_ACP_LOGIN_COMMAND,
      },
    };
  }

  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[] {
    if (typeof input !== "string") return mapAcpMessage(input, state, FAKE_ACP_LOGIN_COMMAND);
    state.lines += 1;
    let doc: unknown;
    try {
      doc = JSON.parse(input);
    } catch {
      return [];
    }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return [];
    const e = doc as Json;
    const type = str(e.type);
    switch (type) {
      case "session": {
        const id = str(e.session_id);
        if (id === undefined) break;
        state.nativeSessionId = id;
        const model = str(e.model);
        const backingProvider = str(e.backing_provider);
        return [
          {
            kind: "session_bound",
            nativeSessionId: id,
            ...(model ? { model } : {}),
            ...(backingProvider ? { backingProvider } : {}),
          },
        ];
      }
      case "tool": {
        const tool = str(e.tool);
        const kind = tool === "read" || tool === "edit" || tool === "shell" ? tool : "other";
        const target = str(e.target);
        return [{ kind: "tool_call", tool: kind, name: str(e.name) ?? "unknown", ...(target ? { target } : {}) }];
      }
      case "message":
        return [{ kind: "message", role: "assistant", text: str(e.text) ?? "" }];
      case "usage": {
        const metrics: Record<string, number | string | null> = {};
        for (const [k, v] of Object.entries(e))
          if (k !== "type" && (typeof v === "number" || typeof v === "string")) metrics[k] = v;
        return [{ kind: "usage", source: "provider_reported", metrics }];
      }
      case "rate_limit": {
        const resetAt = str(e.reset_at);
        return [{ kind: "rate_limit", ...(resetAt ? { resetAt } : {}) }];
      }
      case "error":
        return [{ kind: "provider_error", category: str(e.category) ?? "unknown", message: str(e.message) ?? "" }];
      case "result": {
        const summary = str(e.summary);
        return [{ kind: "result", ok: e.ok === true, ...(summary ? { summary } : {}) }];
      }
      default:
        break;
    }
    state.unknownEvents += 1;
    return [{ kind: "unknown", rawType: type ?? "none" }];
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
    const clean = this.#acp
      ? acpRunSucceeded(events, exit)
      : exit.outcome === "exited" &&
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
