/**
 * `cli` inner backend (T11.13; FR-INN-04, FR-ADP-03, FR-ADP-08, LLD §13.2, TDD §4.6 / §4.6.6).
 *
 * A configured `inner_agent.backend.kind: cli` (provider `opencode`) may start a process only when both of these hold:
 * the installed version is inside the compliance-manifest range, and that same release is the one whose tool-free argv
 * was verified. Otherwise the backend is not attached (`no_backend`) and probe/complete report `Ineligible` by reason
 * code. Nothing here downgrades to "run anyway".
 *
 * Shipped gate (fail closed): {@link CLI_TOOL_FREE_VERIFICATION} is null. TDD §4.6.6 did not verify a tool-free one-shot,
 * and `src/adapters/manifests/opencode.json` admits no version (`<0.0.0`). Production therefore never resolves a binary
 * and never spawns. Tests may inject a synthetic version, a copied manifest range and a synthetic verification record;
 * that injection is not a claim that T11.0 passed or that a live `opencode` ran.
 *
 * The argv that is allowed to spawn is the TDD §4.6 proposed tool-free shape (not the adapter's privileged
 * `--standalone` argv): absolute exe, `run --format json --pure --model <model> --dir <empty dir> -- <prompt>`, and
 * exactly the three deny-all environment keys below. `auditInvocation` with no bypass context must be empty. The real
 * `OpenCodeAdapter.compile` path is the default compile: today it is `Ineligible` for the tool-free profile, which this
 * gate reports as `FLAGS_UNVERIFIED` and does not spawn. A caller-supplied compile result is held to the same audit and
 * shape; a verification record cannot waive either.
 *
 * This module never executes `opencode --version` and never inherits `process.env`. Spawn uses `shell: false` and the
 * invocation's own env only. Errors are fixed codes, never prompt, stdout or stderr text.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { auditInvocation } from "../adapters/audit.js";
import {
  type ComplianceManifest,
  evaluateVersionGate,
  parseVersion,
  tryLoadManifest,
} from "../adapters/manifest/index.js";
import { OpenCodeAdapter } from "../adapters/opencode/adapter.js";
import {
  createParseState,
  type ExitInfo,
  type Ineligible,
  type Invocation,
  isIneligible,
  type NormalizedEvent,
  type ResolvedProfile,
} from "../adapters/types.js";
import type { InnerBackend, InnerProbeResult, InnerRequest, InnerResult, Locality } from "./port.js";

/** No release has a verified tool-free argv (TDD §4.6.6). Stays null until an operator records one. */
export const CLI_TOOL_FREE_VERIFICATION: CliToolFreeVerification | null = null;

/**
 * Synthetic in tests, operator evidence in production. `version` is a semver release (`1.2.3` matches `v1.2.3`).
 * Prerelease never verifies.
 */
export interface CliToolFreeVerification {
  readonly version: string;
}

/** Injected by tests. Production leaves every field unset, which is `Ineligible` / `no_backend`. */
export interface CliBackendOptions {
  /** Installed version string. Null or omitted means not probed; this module does not exec `opencode`. */
  readonly observedVersion?: string | null;
  /** `undefined` loads `opencode.json`. `null` means the manifest is missing. A test may pass a copied range. */
  readonly manifest?: ComplianceManifest | null;
  /** Default: `OpenCodeAdapter.compile` for the tool-free profile (`pathEnv: ""`, so no PATH lookup). */
  readonly compile?: (input: { model: string; prompt: string; cwd: string }) => Invocation | Ineligible;
  /** `undefined` uses {@link CLI_TOOL_FREE_VERIFICATION} (null). */
  readonly verification?: CliToolFreeVerification | null;
  /** Default: `child_process.spawn` of `argv[0]` with `shell: false`. Tests inject this and must not call `opencode`. */
  readonly spawn?: CliSpawn;
}

export interface CliSpawnResult {
  readonly stdout: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export type CliSpawn = (invocation: Invocation, signal: AbortSignal) => Promise<CliSpawnResult>;

/** Eligibility refusals. `complete` throws these; probe returns them in `detail`. No process is started. */
export type CliRefusal = "MISSING" | "NO_MANIFEST" | "VERSION_OUT_OF_RANGE" | "FLAGS_UNVERIFIED" | "ARGV_AUDIT";

export type CliBackendErrorCode =
  | CliRefusal
  | "ABORTED"
  | "SPAWN_FAILED"
  | "OUTPUT_REJECTED"
  | "TOOL_CALL"
  | "OUTPUT_TOO_LARGE";

export class CliBackendError extends Error {
  override readonly name = "CliBackendError";
  constructor(readonly code: CliBackendErrorCode) {
    super(code);
  }
}

export type CliAssessment =
  | { readonly ok: true; readonly invocation: Invocation }
  | { readonly ok: false; readonly reason: CliRefusal };

export interface CliBackendSettings {
  readonly provider: string | undefined;
  readonly model: string;
  readonly timeoutMs: number;
}

/** TDD §4.6 item 4 canary sentence. Probe compiles it and never spawns. */
const CANARY_PROMPT = "Reply with the single word ok";

/**
 * Assumption (T11.13): a model id is one argv word. The adapter does not yet emit `--model`; this charset is what the
 * tool-free shape will accept once a version is verified. It rejects a flag-shaped model such as `--auto` before that
 * word can be the only thing standing between us and a spawn (the argv audit still runs on whatever compile returned).
 */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,255}$/u;

const TOOL_FREE_ENV_KEYS = [
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_PERMISSION",
] as const;

/** Deny-all. Not read by `auditInvocation`; the shape check refuses any other value, including `allow` and `ask`. */
const DENY_ALL_PERMISSION = '{"*":"deny"}';

const MAX_CAPTURE_BYTES = 1024 * 1024;

const TOOL_FREE_PROFILE: ResolvedProfile = {
  name: "inspect-untrusted",
  fileAccess: "read-only",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};

/** One parser. `pathEnv: ""` resolves no binary (no PATH scan, no exec). */
const PARSER = new OpenCodeAdapter({ pathEnv: "" });

function defaultCompile(input: { model: string; prompt: string; cwd: string }): Invocation | Ineligible {
  return new OpenCodeAdapter({ pathEnv: "" }).compile(
    {
      runId: "inner_cli",
      objective: input.prompt,
      constraints: [],
      workspace: { cwd: input.cwd, writable: false },
      model: input.model,
    },
    TOOL_FREE_PROFILE,
  );
}

function verificationOf(options: CliBackendOptions): CliToolFreeVerification | null {
  return options.verification === undefined ? CLI_TOOL_FREE_VERIFICATION : options.verification;
}

function resolveManifest(options: CliBackendOptions): ComplianceManifest | null {
  if (options.manifest === null) return null;
  if (options.manifest !== undefined) return options.manifest;
  return tryLoadManifest("opencode").loaded?.manifest ?? null;
}

function sameRelease(observed: string, recorded: string): boolean {
  const a = parseVersion(observed);
  const b = parseVersion(recorded);
  if (a === null || b === null || a.prerelease || b.prerelease) return false;
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

/**
 * Version and verification only. Does not compile and does not spawn. `MISSING` and `VERSION_OUT_OF_RANGE` win over
 * `FLAGS_UNVERIFIED`, so a null verification record is not consulted until the manifest admits the version.
 */
function assessPreconditions(options: CliBackendOptions): CliRefusal | "ok" {
  const observed = options.observedVersion;
  if (observed === undefined || observed === null || observed.trim() === "") return "MISSING";
  const manifest = resolveManifest(options);
  if (manifest === null) return "NO_MANIFEST";
  if (!evaluateVersionGate("opencode", manifest, observed).eligible) return "VERSION_OUT_OF_RANGE";
  const verification = verificationOf(options);
  if (verification === null || !sameRelease(observed, verification.version)) return "FLAGS_UNVERIFIED";
  return "ok";
}

/** True only when a `cli` backend may be attached. Production options fail this (null version, null verification). */
export function cliBackendAttachable(options: CliBackendOptions | undefined): boolean {
  return assessPreconditions(options ?? {}) === "ok";
}

function envIsToolFree(env: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(env);
  if (keys.length !== TOOL_FREE_ENV_KEYS.length) return false;
  if (!keys.every((key) => (TOOL_FREE_ENV_KEYS as readonly string[]).includes(key))) return false;
  if (env.OPENCODE_DISABLE_AUTOUPDATE !== "1" || env.OPENCODE_DISABLE_CLAUDE_CODE !== "1") return false;
  const perm = env.OPENCODE_PERMISSION;
  if (perm !== DENY_ALL_PERMISSION) return false;
  return !perm.includes("allow") && !perm.includes("ask");
}

function argvIsToolFree(argv: readonly string[], model: string, prompt: string, cwd: string): boolean {
  if (argv.length !== 11) return false;
  const exe = argv[0];
  if (exe === undefined || !isAbsolute(exe) || exe.includes("\0") || exe.startsWith("-")) return false;
  const words = ["run", "--format", "json", "--pure", "--model", model, "--dir", cwd, "--", prompt];
  for (let i = 0; i < words.length; i += 1) {
    const got = argv[i + 1];
    if (got === undefined || got !== words[i] || got.includes("\0")) return false;
  }
  return true;
}

function shapeIsToolFree(invocation: Invocation, model: string, prompt: string, cwd: string): boolean {
  return (
    MODEL_RE.test(model) &&
    invocation.transport === "subprocess-jsonl" &&
    invocation.outputFormat === "jsonl" &&
    invocation.stdin?.kind === "none" &&
    invocation.expectedExitCodes.length === 1 &&
    invocation.expectedExitCodes[0] === 0 &&
    invocation.cwd === cwd &&
    envIsToolFree(invocation.env) &&
    argvIsToolFree(invocation.argv, model, prompt, cwd)
  );
}

function dirIsEmpty(cwd: string): boolean {
  try {
    return readdirSync(cwd).length === 0;
  } catch {
    return false;
  }
}

/**
 * Full gate for one prompt and one empty directory. Does not spawn. Audit runs before the shape check, so a bypass
 * flag is `ARGV_AUDIT` even when the argv also fails the tool-free shape.
 */
export function assessCliBackend(input: {
  readonly model: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly provider: string | undefined;
  readonly options: CliBackendOptions;
}): CliAssessment {
  const pre = assessPreconditions(input.options);
  if (pre !== "ok") return { ok: false, reason: pre };
  if (input.provider !== "opencode") return { ok: false, reason: "FLAGS_UNVERIFIED" };
  let compiled: Invocation | Ineligible;
  try {
    compiled = (input.options.compile ?? defaultCompile)({
      model: input.model,
      prompt: input.prompt,
      cwd: input.cwd,
    });
  } catch {
    return { ok: false, reason: "FLAGS_UNVERIFIED" };
  }
  if (isIneligible(compiled)) return { ok: false, reason: "FLAGS_UNVERIFIED" };
  if (auditInvocation(compiled).length > 0) return { ok: false, reason: "ARGV_AUDIT" };
  if (!dirIsEmpty(input.cwd) || !shapeIsToolFree(compiled, input.model, input.prompt, input.cwd)) {
    return { ok: false, reason: "FLAGS_UNVERIFIED" };
  }
  return { ok: true, invocation: compiled };
}

function defaultSpawn(invocation: Invocation, signal: AbortSignal): Promise<CliSpawnResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new CliBackendError("ABORTED"));
      return;
    }
    const exe = invocation.argv[0];
    if (exe === undefined) {
      reject(new CliBackendError("SPAWN_FAILED"));
      return;
    }
    let settled = false;
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = nodeSpawn(exe, invocation.argv.slice(1), {
        cwd: invocation.cwd,
        env: { ...invocation.env },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(new CliBackendError("SPAWN_FAILED"));
      return;
    }
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const fail = (code: CliBackendErrorCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill("SIGKILL");
      reject(new CliBackendError(code));
    };
    const onAbort = () => fail("ABORTED");
    const wall = setTimeout(() => fail("OUTPUT_REJECTED"), invocation.timeouts.wallClockMs);
    let idle = setTimeout(() => fail("OUTPUT_REJECTED"), invocation.timeouts.idleMs);
    const bumpIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => fail("OUTPUT_REJECTED"), invocation.timeouts.idleMs);
    };
    const cleanup = () => {
      clearTimeout(wall);
      clearTimeout(idle);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      bumpIdle();
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      stdoutBytes += buf.length;
      if (stdoutBytes > MAX_CAPTURE_BYTES) {
        fail("OUTPUT_TOO_LARGE");
        return;
      }
      stdout.push(buf);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      bumpIdle();
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      stderrBytes += buf.length;
      if (stderrBytes > MAX_CAPTURE_BYTES) fail("OUTPUT_TOO_LARGE");
    });
    child.on("error", () => fail("SPAWN_FAILED"));
    child.on("close", (code, sig) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), exitCode: code, signal: sig });
    });
  });
}

function metricNumber(value: number | string | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseOutput(result: CliSpawnResult, model: string, invocation: Invocation): InnerResult {
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_CAPTURE_BYTES) throw new CliBackendError("OUTPUT_TOO_LARGE");
  const state = createParseState();
  const events: NormalizedEvent[] = [];
  for (const raw of result.stdout.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      JSON.parse(raw);
    } catch {
      throw new CliBackendError("OUTPUT_REJECTED");
    }
    const parsed = PARSER.parseEvent(raw, state);
    if (parsed.length === 0) throw new CliBackendError("OUTPUT_REJECTED");
    events.push(...parsed);
  }
  if (events.some((event) => event.kind === "tool_call")) throw new CliBackendError("TOOL_CALL");
  const exit: ExitInfo = {
    outcome: result.signal !== null ? "crashed" : "exited",
    exitCode: result.exitCode,
    signal: result.signal,
    expectedExitCodes: invocation.expectedExitCodes,
  };
  const extracted = PARSER.extractResult(events, exit);
  if (!extracted.ok || extracted.summary === undefined || extracted.summary === "") {
    throw new CliBackendError("OUTPUT_REJECTED");
  }
  const bound = events.find((event) => event.kind === "session_bound");
  const reported = bound?.kind === "session_bound" ? bound.model : undefined;
  const modelId = (reported !== undefined && reported !== "" ? reported : model).slice(0, 256);
  const usageEvent = events.findLast((event) => event.kind === "usage");
  const usage =
    usageEvent?.kind === "usage"
      ? { in: metricNumber(usageEvent.metrics.input), out: metricNumber(usageEvent.metrics.output) }
      : undefined;
  return { text: extracted.summary, model_id: modelId, ...(usage !== undefined ? { usage } : {}) };
}

function promptOf(req: InnerRequest): string {
  return `${req.system}\n\n${req.user}`;
}

function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), "sb-inner-cli-"));
}

/**
 * The `cli` backend object. Attach one only through {@link cliBackendAttachable}; an object that exists still rechecks
 * the manifest, the verification record, the compile result, the argv audit and the tool-free shape before spawn.
 */
export function createCliBackend(settings: CliBackendSettings, options: CliBackendOptions = {}): InnerBackend {
  return {
    kind: "cli",
    async resolveLocality(signal: AbortSignal): Promise<Locality> {
      if (signal.aborted) throw new CliBackendError("ABORTED");
      return "remote";
    },
    async complete(req: InnerRequest, signal: AbortSignal): Promise<InnerResult> {
      if (signal.aborted) throw new CliBackendError("ABORTED");
      const pre = assessPreconditions(options);
      if (pre !== "ok") throw new CliBackendError(pre);
      const dir = emptyDir();
      try {
        if (signal.aborted) throw new CliBackendError("ABORTED");
        const assessed = assessCliBackend({
          model: settings.model,
          prompt: promptOf(req),
          cwd: dir,
          provider: settings.provider,
          options,
        });
        if (!assessed.ok) throw new CliBackendError(assessed.reason);
        const invocation = assessed.invocation;
        if (auditInvocation(invocation).length > 0) throw new CliBackendError("ARGV_AUDIT");
        const exe = invocation.argv[0];
        if (exe === undefined || !isAbsolute(exe) || exe.includes("\0")) throw new CliBackendError("FLAGS_UNVERIFIED");
        const spawn = options.spawn ?? defaultSpawn;
        return await parseOutput(await spawn(invocation, signal), settings.model, invocation);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async probe(signal: AbortSignal): Promise<InnerProbeResult> {
      if (signal.aborted) throw new CliBackendError("ABORTED");
      const pre = assessPreconditions(options);
      if (pre !== "ok") return { reachable: false, canary_ok: false, eligible: false, detail: pre };
      const dir = emptyDir();
      try {
        const assessed = assessCliBackend({
          model: settings.model,
          prompt: CANARY_PROMPT,
          cwd: dir,
          provider: settings.provider,
          options,
        });
        if (!assessed.ok) return { reachable: false, canary_ok: false, eligible: false, detail: assessed.reason };
        return { reachable: true, canary_ok: false, eligible: true, detail: "NO_CANARY" };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
