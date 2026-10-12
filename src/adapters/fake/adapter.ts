/** Fake provider adapter implementing the LLD §2 contract against fake/cli.mjs (T1.7). */
import { fileURLToPath } from "node:url";
import {
  DEFAULT_IDLE_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_WALL_CLOCK_MS,
} from "../../exec/index.js";
import { classifyCommon } from "../failure.js";
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

export const FAKE_CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));

export type FakeScenario =
  | "success"
  | "task_failure"
  | "auth_missing"
  | "rate_limit"
  | "partial_mutation"
  | "malformed_output"
  | "hang"
  | "hang_ignore_term";

export interface FakeAdapterOptions {
  scenario?: FakeScenario;
  /** Absolute path of the executable (Proposed: node) and script. Defaults to the bundled fake CLI. */
  executable?: string;
  script?: string;
  timeouts?: Partial<Invocation["timeouts"]>;
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export class FakeAdapter implements ProviderAdapter {
  readonly id = "fake" as const;
  readonly transports = ["subprocess-jsonl"] as const;
  /** Test double: no provider exists, so there is no provider control to declare (FR-GIT-01). */
  readonly gitWriteControl: GitWriteControl = {
    kind: "none-documented",
    detail: "fake test adapter; no provider permission controls exist",
    remainingControls: ["FR-GIT-03", "FR-GIT-06"],
  };
  readonly #scenario: FakeScenario;
  readonly #exe: string;
  readonly #script: string;
  readonly #timeouts: Invocation["timeouts"];

  constructor(opts: FakeAdapterOptions = {}) {
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

  parseEvent(input: string | AcpMessage, state: ParseState): NormalizedEvent[] {
    if (typeof input !== "string") return []; // no ACP transport
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
        return [{ kind: "session_bound", nativeSessionId: id, ...(model ? { model } : {}) }];
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
