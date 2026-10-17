/**
 * Verification stage (T3.10; FR-EXE-08, FRD T11, T14, BR-16, §4.3, V7; FR-TEL-03, NFR-SEC-01; LLD §8.1). After the
 * agent's process exits successfully, the controller runs the request's `verification_commands` one after another in
 * the run's worktree and records the results. Delegated choices (not owner-approved), all recorded in LLD §8.1:
 *
 * - **No shell.** Each command is an argv array spawned through the run supervisor (`shell: false`, own process group,
 *   stdin closed). Nothing is joined, split, globbed or expanded.
 * - **Environment.** Only the names in the run's invocation allowlist (`Invocation.envAllowlist`), read from the
 *   controller's environment, minus every `GIT_*` name and the signing and agent variables
 *   ({@link SIGNING_AGENT_VARIABLES}), even if an allowlist names them. Adapter-declared variables (`Invocation.env`,
 *   which can carry the tool-channel token) are never passed.
 * - **Time.** The run's wall-clock bound (`Invocation.timeouts.wallClockMs`) bounds the whole stage; each command gets
 *   what is left of it. There is no idle timeout (a quiet test is not a hang). Timeout and cancel terminate the
 *   command's process group (SIGTERM, the run's kill grace, SIGKILL).
 * - **Fail fast.** The first command that does not pass ends the stage; later commands are recorded `not_run`.
 * - **Output.** Each stream is captured up to {@link VERIFICATION_OUTPUT_CAP_BYTES} and truncated with a marker. It is
 *   stored only in the `test_report` artifact, redacted by the artifact store's redactor before it is embedded in JSON
 *   and again when stored; run events and the envelope get exit codes and outcomes only.
 * - **Slots (T3.22, FR-EXE-09).** Only when {@link VerificationOptions.limits} is set: the stage first takes one
 *   host-wide verification slot (`src/lock/slots.ts`) and holds it until its last command ends. The wait is part of the
 *   stage's wall clock; a wait that outlasts it ends the stage `timeout` with every command `not_run`. The commands run
 *   at the configured lower priority and get the configured parallelism variables through the allowlist.
 */
import { getPriority, setPriority } from "node:os";
import {
  DEFAULT_KILL_GRACE_MS,
  findOnPath,
  type OuterSandboxAvailability,
  type SupervisedRun,
  supervise,
  wrapOuterSandboxVerification,
} from "../exec/index.js";
import { SIGNING_AGENT_VARIABLES } from "../git/sign.js";
import { acquireSlot, type SlotLease, type SlotLockOptions } from "../lock/index.js";

/** Proposed (Delegated): per-stream capture bound for one verification command (LLD §8.1). */
export const VERIFICATION_OUTPUT_CAP_BYTES = 1024 * 1024;
/** Schema bounds (`src/mcp/schemas.ts`), re-checked by the lifecycle for internal callers. */
export const MAX_VERIFICATION_COMMANDS = 16;
export const MAX_VERIFICATION_ARGS = 64;
export const MAX_VERIFICATION_ARG_LENGTH = 4096;

/** `run_event` type: one per verification command that finished (index, outcome, exit status; no output). */
export const VERIFICATION_COMMAND_EVENT = "verification_command";
/** `run_event` type: the command whose process group is now recorded on the run (index and pid only). */
export const VERIFICATION_STARTED_EVENT = "verification_command_started";
/** `run_event` type (T3.22, FR-EXE-09): the run found every verification slot held and is waiting in VERIFYING. */
export const VERIFICATION_WAIT_EVENT = "verification_wait";

/**
 * T3.22 (FR-EXE-09): the host-wide verification limiter. Absent (no `limits.verification_*` key) means no slot, no
 * priority change and no extra variable: the stage is exactly the T3.10 one.
 */
export interface VerificationLimits {
  /** Slots shared by the verification stages of every run of this operator account on the host. */
  readonly slots: number;
  /** Added to the controller's niceness for each command (like `nice -n`), capped at 19; 0 leaves it unchanged. */
  readonly nice: number;
  /** Operator-declared parallelism variables (for example `VITEST_MAX_WORKERS`), added to the allowlist with values. */
  readonly env: Readonly<Record<string, string>>;
  /** Lock placement (tests); default the host-wide `default` scope. */
  readonly lock?: Omit<SlotLockOptions, "slots"> | undefined;
}

export type VerificationCommandOutcome = "passed" | "failed" | "timeout" | "cancelled" | "error" | "not_run";
/** `timeout` (T3.22): the wait for a verification slot outlasted the run's wall clock; no command ran. */
export type VerificationOutcome = "passed" | "failed" | "cancelled" | "timeout";

export interface VerificationCommandResult {
  readonly index: number;
  readonly argv: readonly string[];
  readonly outcome: VerificationCommandOutcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  /** The supervisor reported a controller-side problem (a callback threw); not the command's fault. */
  readonly internalError: boolean;
}

export interface VerificationResult {
  readonly outcome: VerificationOutcome;
  readonly commands: readonly VerificationCommandResult[];
  /** True when any command hit a controller-side error (the lifecycle then fails the run TOOL_FAILURE). */
  readonly internalError: boolean;
  /** True when verification ran inside the outer sandbox (T3.11). */
  readonly confined?: boolean | undefined;
}

export interface VerificationOptions {
  readonly commands: readonly (readonly string[])[];
  readonly cwd: string;
  /** Already filtered by {@link verificationEnvAllowlist}. */
  readonly envAllowlist: readonly string[];
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Bound on the whole stage. */
  readonly wallClockMs: number;
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
  /** Called synchronously after each spawn, before any output is read (persist pid/pgid for reconciliation). */
  readonly onSpawn?: (index: number, info: { pid: number; pgid: number }) => void;
  /** Called after each command that ran (or failed to start). */
  readonly onCommandDone?: (result: VerificationCommandResult) => void;
  /**
   * T3.11 (FR-EXE-08, FR-POL-06, decision 11): optional confined verification in the outer sandbox from T3.1.
   * When true, verification commands run inside bubblewrap with the worktree writable and the rest read-only.
   */
  readonly confined?: boolean | undefined;
  /** Outer sandbox availability; if omitted and confined is true, looked up on PATH. */
  readonly outerSandbox?: OuterSandboxAvailability | undefined;
  /** Optional sandbox wrapper transform (for tests or custom wrapping). */
  readonly wrapSandbox?: ((argv: readonly string[], cwd: string) => readonly string[]) | undefined;
  /** T3.22 (FR-EXE-09): the verification limiter; absent means none. */
  readonly limits?: VerificationLimits | undefined;
  /** T3.22: called once when the stage starts waiting for a slot (record `verification_wait`). */
  readonly onSlotWait?: ((info: { slots: number }) => void) | undefined;
}

export interface VerificationRun {
  /** Idempotent: stops the stage, terminating the running command's process group. */
  cancel(): Promise<void>;
  readonly done: Promise<VerificationResult>;
}

/** The run's allowlist without `GIT_*` names and the signing/agent variables (defence in depth; LLD §8.1). */
export function verificationEnvAllowlist(names: readonly string[]): string[] {
  const denied = new Set<string>(SIGNING_AGENT_VARIABLES);
  return [...new Set(names)].filter((n) => !n.toUpperCase().startsWith("GIT_") && !denied.has(n));
}

/**
 * Shape check for internal callers (the MCP schema already enforces it): an array of at most 16 non-empty argv arrays
 * of at most 64 strings (the first non-empty) of at most 4096 characters without NUL. Returns an error message, or
 * undefined when valid.
 */
export function verificationCommandsProblem(commands: unknown): string | undefined {
  if (!Array.isArray(commands)) return "verification commands must be an array of argv arrays";
  if (commands.length > MAX_VERIFICATION_COMMANDS) {
    return `at most ${MAX_VERIFICATION_COMMANDS} verification commands`;
  }
  for (const [i, argv] of commands.entries()) {
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_VERIFICATION_ARGS) {
      return `verification command ${i} must be a non-empty argv array of at most ${MAX_VERIFICATION_ARGS} strings`;
    }
    if (typeof argv[0] !== "string" || argv[0].length === 0) {
      return `verification command ${i} must name an executable`;
    }
    for (const a of argv) {
      if (typeof a !== "string" || a.length > MAX_VERIFICATION_ARG_LENGTH || a.includes("\0")) {
        return `verification command ${i} has an invalid argument`;
      }
    }
  }
  return undefined;
}

const marker = (cap: number) => Buffer.from(`\n[switchboard: output truncated after ${cap} bytes]\n`, "utf8");

/** Run the commands one after another (fail fast). `done` never rejects. */
export function startVerification(opts: VerificationOptions): VerificationRun {
  const cap = opts.maxOutputBytes ?? VERIFICATION_OUTPUT_CAP_BYTES;
  let cancelled = false;
  let current: SupervisedRun | undefined;
  const deadline = Date.now() + opts.wallClockMs;
  const isConfined = opts.confined === true;

  let bwrapPath: string | null = null;
  let bwrapAvailable = true;
  if (isConfined && !opts.wrapSandbox) {
    if (opts.outerSandbox !== undefined) {
      bwrapAvailable = opts.outerSandbox.mechanisms.bubblewrap.available;
      bwrapPath = opts.outerSandbox.mechanisms.bubblewrap.path;
    } else {
      bwrapPath = findOnPath("bwrap", process.env.PATH);
      bwrapAvailable = bwrapPath !== null;
    }
  }

  const limits = opts.limits;
  const envAllowlist = limits
    ? verificationEnvAllowlist([...opts.envAllowlist, ...Object.keys(limits.env)])
    : opts.envAllowlist;
  const baseEnv = limits ? { ...(opts.baseEnv ?? process.env), ...limits.env } : opts.baseEnv;
  const lower = (pid: number): void => {
    if (!limits || limits.nice <= 0) return;
    try {
      setPriority(pid, Math.min(19, getPriority() + limits.nice));
    } catch {
      // Best effort: the command may already have exited; a priority is not a security control.
    }
  };

  const done = (async (): Promise<VerificationResult> => {
    const results: VerificationCommandResult[] = [];
    let stop: VerificationOutcome | undefined;
    let internalError = false;
    let slot: SlotLease | undefined;
    if (limits && opts.commands.length > 0) {
      let got: SlotLease | "timeout" | "cancelled";
      try {
        got = await acquireSlot({
          ...limits.lock,
          slots: limits.slots,
          deadline,
          cancelled: () => cancelled,
          onWait: () => opts.onSlotWait?.({ slots: limits.slots }),
        });
      } catch {
        // A slot that cannot be set up is a controller-side problem (TOOL_FAILURE), never a run without a slot.
        got = "timeout";
        internalError = true;
      }
      if (typeof got === "string") {
        stop = internalError ? "failed" : got;
      } else slot = got;
    }
    try {
      for (const [index, argv] of opts.commands.entries()) {
        const skipped = (outcome: VerificationCommandOutcome): VerificationCommandResult => ({
          index,
          argv,
          outcome,
          exitCode: null,
          signal: null,
          durationMs: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          stdoutTruncated: false,
          stderrTruncated: false,
          internalError: false,
        });
        if (stop !== undefined) {
          results.push(skipped("not_run"));
          continue;
        }
        if (cancelled) {
          stop = "cancelled";
          results.push(skipped("not_run"));
          continue;
        }
        if (isConfined && !opts.wrapSandbox && (!bwrapAvailable || !bwrapPath)) {
          stop = "failed";
          const failureResult: VerificationCommandResult = {
            ...skipped("error"),
            stderr: Buffer.from("outer sandbox required for verification but bubblewrap is unavailable\n"),
          };
          results.push(failureResult);
          opts.onCommandDone?.(failureResult);
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          stop = "failed";
          const r = skipped("timeout");
          results.push(r);
          opts.onCommandDone?.(r);
          continue;
        }
        const started = Date.now();
        const bwrapExec = bwrapPath ?? "bwrap";
        const spawnArgv = isConfined
          ? opts.wrapSandbox
            ? opts.wrapSandbox(argv, opts.cwd)
            : wrapOuterSandboxVerification(bwrapExec, opts.cwd, argv)
          : argv;
        current = supervise({
          argv: spawnArgv,
          cwd: opts.cwd,
          envAllowlist,
          ...(baseEnv ? { baseEnv } : {}),
          wallClockMs: remaining,
          idleMs: remaining + 1, // no idle timeout: only the wall clock bounds a command
          killGraceMs: opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
          maxCaptureBytes: cap,
          ...(opts.onSpawn || limits
            ? {
                onSpawn: (info: { pid: number; pgid: number }) => {
                  lower(info.pid);
                  opts.onSpawn?.(index, info);
                },
              }
            : {}),
        });
        // A cancel that raced the spawn must still stop this command.
        if (cancelled) void current.cancel();
        const r = await current.result;
        current = undefined;
        let outcome: VerificationCommandOutcome;
        switch (r.outcome) {
          case "exited":
            outcome = r.exitCode === 0 ? "passed" : "failed";
            break;
          case "timeout":
            outcome = "timeout";
            break;
          case "cancelled":
            outcome = "cancelled";
            break;
          case "crashed":
            outcome = "failed";
            break;
          default:
            outcome = "error"; // spawn_error, internal_error (protocol_error cannot happen: stdout is not parsed)
        }
        const isInternal = r.outcome === "internal_error";
        internalError ||= isInternal;
        const result: VerificationCommandResult = {
          index,
          argv,
          outcome,
          exitCode: r.exitCode,
          signal: r.signal,
          durationMs: Date.now() - started,
          stdout: r.stdoutTruncated ? Buffer.concat([r.stdout, marker(cap)]) : r.stdout,
          stderr: r.stderrTruncated ? Buffer.concat([r.stderr, marker(cap)]) : r.stderr,
          stdoutTruncated: r.stdoutTruncated,
          stderrTruncated: r.stderrTruncated,
          internalError: isInternal,
        };
        results.push(result);
        opts.onCommandDone?.(result);
        if (outcome === "cancelled") stop = "cancelled";
        else if (outcome !== "passed") stop = "failed";
      }
    } finally {
      await slot?.release();
    }
    return {
      outcome: stop ?? (cancelled ? "cancelled" : "passed"),
      commands: results,
      internalError,
      ...(isConfined ? { confined: true } : {}),
    };
  })();

  return {
    cancel: async () => {
      cancelled = true;
      await current?.cancel();
    },
    done,
  };
}

/** Per-command summary for run events, the terminal record and the envelope: no argv, no output (FR-TEL-03). */
export function verificationSummary(r: VerificationCommandResult): Record<string, unknown> {
  return {
    index: r.index,
    outcome: r.outcome,
    exit_code: r.exitCode,
    ...(r.signal !== null ? { signal: r.signal } : {}),
    duration_ms: r.durationMs,
    ...(r.stdoutTruncated || r.stderrTruncated ? { output_truncated: true } : {}),
  };
}

/**
 * The `test_report` artifact body (version 1, `application/json`). Argv and output are passed through `redact` before
 * they are put into JSON; the artifact store redacts the whole body again when it is stored.
 */
export function verificationReport(result: VerificationResult, redact: (b: Buffer) => Buffer): Buffer {
  const text = (b: Buffer) => redact(b).toString("utf8");
  return Buffer.from(
    JSON.stringify({
      v: 1,
      outcome: result.outcome,
      ...(result.confined !== undefined ? { confined: result.confined } : {}),
      commands: result.commands.map((c) => ({
        index: c.index,
        argv: c.argv.map((a) => text(Buffer.from(a, "utf8"))),
        outcome: c.outcome,
        exit_code: c.exitCode,
        signal: c.signal,
        duration_ms: c.durationMs,
        stdout: text(c.stdout),
        stderr: text(c.stderr),
        stdout_truncated: c.stdoutTruncated,
        stderr_truncated: c.stderrTruncated,
      })),
    }),
    "utf8",
  );
}
