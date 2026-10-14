import { type ChildProcess, spawn } from "node:child_process";
import { DEFAULT_MAX_LINE_BYTES, JsonlReader } from "./jsonl.js";
import { hostProcInfo, type ProcInfo } from "./proc-info.js";

/** Failure codes from LLD §4 that the supervisor itself can determine. */
export type ExecFailureCode = "PROCESS_TIMEOUT" | "PROCESS_CRASH" | "OUTPUT_PROTOCOL_ERROR";

export type SupervisedOutcome =
  | "exited" // child exited by itself (any exit code; classification belongs to the adapter)
  | "timeout" // wall-clock or idle timeout; group killed
  | "cancelled" // cancel() called; group killed
  | "protocol_error" // oversize/malformed stdout line; group killed
  | "crashed" // child died from a signal the supervisor did not send
  | "spawn_error" // process could not be started
  | "internal_error"; // onEvent/onSpawn callback threw; group killed, supervisor itself survives

/**
 * A stdout framing or protocol problem. The JSONL reader reports `line_too_long`, `invalid_utf8` and `invalid_json`;
 * a transport layered on the reader (the ACP client, `./acp/`) reports its own kinds through {@link SupervisedRun.fail}.
 */
export interface ProtocolErrorInfo {
  readonly kind: string;
  readonly lineNumber: number;
  readonly message: string;
}

/** Which bound ended a run with `PROCESS_TIMEOUT`. The two `acp_*` kinds are ADR-0036 item 4 (Proposed targets). */
export type TimeoutKind = "wall_clock" | "idle" | "acp_initialize" | "acp_session";

/** Proposed defaults. LLD §8 gives these as proposed targets. */
export const DEFAULT_KILL_GRACE_MS = 10_000;
export const DEFAULT_WALL_CLOCK_MS = 30 * 60_000;
export const DEFAULT_IDLE_MS = 5 * 60_000;
export const DEFAULT_MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

export interface SuperviseOptions {
  /** argv[0] is the executable. Never run through a shell. */
  readonly argv: readonly string[];
  readonly cwd?: string;
  /** Names copied from `baseEnv` into the child (FR-EXE-07). Nothing else is inherited. */
  readonly envAllowlist: readonly string[];
  /** Adapter-declared variables added verbatim to the child environment. */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Source for allowlisted names. Defaults to process.env. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Prompt text written to stdin then closed; stdin is `ignore` when absent (and `keepStdinOpen` is not set). */
  readonly stdinText?: string;
  /**
   * `acp-stdio` (ADR-0036, LLD §8.2): stdin is a pipe that stays open; the caller writes through
   * {@link SupervisedRun.writeStdin} and closes it with {@link SupervisedRun.endStdin}. Exclusive with `stdinText`.
   */
  readonly keepStdinOpen?: boolean;
  /**
   * Graceful step run before the group kill on cancel and on the wall-clock or idle timeout, never on a protocol or
   * internal error (ADR-0036 item 8.5: answer pending permission requests, send `session/cancel`, wait for the
   * result). Bounded by `killGraceMs` whatever it does; the SIGTERM-then-SIGKILL sequence never depends on it.
   */
  readonly beforeTerminate?: (reason: "timeout" | "cancelled") => Promise<void>;
  readonly wallClockMs?: number;
  /** Max time without stdout bytes. */
  readonly idleMs?: number;
  readonly killGraceMs?: number;
  readonly maxLineBytes?: number;
  /** Per-stream capture cap; beyond it capture stops and `truncated` is set. */
  readonly maxCaptureBytes?: number;
  /** Parse stdout as JSONL and deliver each document. Without it stdout is only captured. */
  readonly onEvent?: (value: unknown, lineNumber: number) => void;
  readonly isIgnorableLine?: (line: string) => boolean;
  /** Blank stdout lines are a protocol error rather than skipped (`acp-stdio`). */
  readonly rejectBlankLines?: boolean;
  /** Called synchronously after spawn, before any output is read, so callers can persist pid/pgid. */
  readonly onSpawn?: (info: { pid: number; pgid: number }) => void;
}

export interface SupervisedResult {
  readonly outcome: SupervisedOutcome;
  readonly failureCode: ExecFailureCode | undefined;
  /** Which bound fired, when outcome is `timeout`. */
  readonly timeoutKind: TimeoutKind | undefined;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly protocolError: ProtocolErrorInfo | undefined;
  /** True when SIGKILL escalation was needed. */
  readonly escalatedToKill: boolean;
  /** True when `kill(-pgid, 0)` confirmed ESRCH before the result was reported. */
  readonly groupEmpty: boolean;
  readonly error: Error | undefined;
}

export interface SupervisedRun {
  readonly pid: number | undefined;
  readonly pgid: number | undefined;
  /** Idempotent; resolves when the group is gone. No effect once the run finished. */
  cancel(): Promise<void>;
  /**
   * Ends the run as `protocol_error` (`OUTPUT_PROTOCOL_ERROR`) or as a `timeout` of the given kind (`PROCESS_TIMEOUT`),
   * killing the group at once (no graceful step). For a transport layered on the line reader. No effect once the run
   * is ending or has ended.
   */
  fail(
    failure: { kind: "protocol_error"; error: ProtocolErrorInfo } | { kind: "timeout"; timeoutKind: TimeoutKind },
  ): void;
  /**
   * The provider finished its work (ADR-0036 item 8.4): close stdin, wait up to `killGraceMs` for the process to exit,
   * then run the group kill sequence. The outcome is `exited` whatever the exit status or signal, because the result
   * already decided it. No effect once the run is ending or has ended.
   */
  complete(): Promise<void>;
  /** Writes to an open stdin (`keepStdinOpen`). False when stdin is closed, failed or not a pipe; never throws. */
  writeStdin(data: string): boolean;
  /** Closes an open stdin. Idempotent. */
  endStdin(): void;
  readonly result: Promise<SupervisedResult>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const POLL_MS = 20;
/** Upper bound on waiting for the group to vanish after SIGKILL (Proposed). */
const POST_KILL_WAIT_MS = 5_000;

/**
 * Whether any live process remains in group `pgid`: `kill(-pgid, 0)`, then the platform process table (LLD §8.3)
 * to ignore zombies, which were killed but not yet reaped and cannot run code. When the table cannot be read the
 * group counts as alive (fail closed: keep waiting, then escalate).
 */
export function groupAlive(pgid: number, info: ProcInfo = hostProcInfo): boolean {
  try {
    process.kill(-pgid, 0);
  } catch (err) {
    // ESRCH: no such group. EPERM does not mean alive: macOS answers EPERM for a group whose only members are zombies
    // (observed on the T4.10 macOS leg), so the table decides; an unreadable table still counts as alive.
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return info.liveGroupMember(pgid) ?? true;
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: already gone.
  }
}

/** Build the child environment from the allowlist and adapter-declared variables only. */
export function buildEnv(
  opts: Pick<SuperviseOptions, "envAllowlist" | "extraEnv" | "baseEnv">,
): Record<string, string> {
  const base = opts.baseEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const name of opts.envAllowlist) {
    const v = base[name];
    if (v !== undefined) env[name] = v;
  }
  Object.assign(env, opts.extraEnv);
  const allowed = new Set([...opts.envAllowlist, ...Object.keys(opts.extraEnv ?? {})]);
  for (const key of Object.keys(env)) {
    if (!allowed.has(key)) throw new Error(`environment key outside allowlist: ${key}`);
  }
  return env;
}

class Capture {
  readonly chunks: Buffer[] = [];
  bytes = 0;
  truncated = false;
  constructor(private readonly cap: number) {}
  add(chunk: Buffer): void {
    if (this.truncated) return;
    const room = this.cap - this.bytes;
    if (chunk.length > room) {
      if (room > 0) this.chunks.push(chunk.subarray(0, room));
      this.bytes = this.cap;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }
  get buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/**
 * Run one provider process under supervision (LLD §8, FR-EXE-01/02/05/07, NFR-REL-02).
 * Every failure mode is reported through the result; `result` never rejects.
 */
export function supervise(opts: SuperviseOptions): SupervisedRun {
  const [exe, ...args] = opts.argv;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const wallClockMs = opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const maxCapture = opts.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;

  const settleEarly = (error: Error): SupervisedRun => ({
    pid: undefined,
    pgid: undefined,
    cancel: async () => {},
    fail: () => {},
    complete: async () => {},
    writeStdin: () => false,
    endStdin: () => {},
    result: Promise.resolve({
      outcome: "spawn_error",
      failureCode: "PROCESS_CRASH",
      timeoutKind: undefined,
      exitCode: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdoutTruncated: false,
      stderrTruncated: false,
      protocolError: undefined,
      escalatedToKill: false,
      groupEmpty: true,
      error,
    }),
  });

  if (exe === undefined || exe === "") return settleEarly(new Error("argv must contain an executable"));

  let child: ChildProcess;
  try {
    child = spawn(exe, args, {
      cwd: opts.cwd,
      env: buildEnv(opts),
      detached: true,
      shell: false,
      stdio: [opts.stdinText === undefined && opts.keepStdinOpen !== true ? "ignore" : "pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return settleEarly(err as Error);
  }

  const pid = child.pid;
  const stdout = new Capture(maxCapture);
  const stderr = new Capture(maxCapture);

  let reason: "timeout" | "cancelled" | "protocol_error" | "internal_error" | "completed" | undefined;
  let timeoutKind: TimeoutKind | undefined;
  let protocolError: ProtocolErrorInfo | undefined;
  let internalError: Error | undefined;
  let spawnError: Error | undefined;
  let escalated = false;
  let groupEmpty = pid === undefined;
  let termination: Promise<void> | undefined;
  let exitSeen = false;
  let finished = false;
  let wallTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let aborting: Promise<void> | undefined;
  let stdinOpen = opts.keepStdinOpen === true && opts.stdinText === undefined;

  const clearTimers = () => {
    if (wallTimer) clearTimeout(wallTimer);
    if (idleTimer) clearTimeout(idleTimer);
    wallTimer = idleTimer = undefined;
  };

  /** SIGTERM to the group, wait up to the grace period, SIGKILL, then confirm the group is empty. */
  const terminate = (): Promise<void> => {
    if (pid === undefined) return Promise.resolve();
    termination ??= (async () => {
      clearTimers();
      signalGroup(pid, "SIGTERM");
      const graceEnd = Date.now() + killGraceMs;
      while (groupAlive(pid) && Date.now() < graceEnd) await sleep(POLL_MS);
      if (groupAlive(pid)) {
        escalated = true;
        signalGroup(pid, "SIGKILL");
        const end = Date.now() + POST_KILL_WAIT_MS;
        while (groupAlive(pid) && Date.now() < end) await sleep(POLL_MS);
      }
      groupEmpty = !groupAlive(pid);
    })();
    return termination;
  };

  /** Resolves after `ms`, or as soon as the process has exited. */
  const waitForExit = async (ms: number): Promise<void> => {
    const end = Date.now() + ms;
    while (!exitSeen && !finished && Date.now() < end) await sleep(POLL_MS);
  };

  const abort = (r: NonNullable<typeof reason>): Promise<void> => {
    // After exit or completion the pgid may be reused; never signal then, and keep the natural outcome.
    if (exitSeen || finished) return termination ?? Promise.resolve();
    reason ??= r;
    if (aborting) return aborting;
    clearTimers();
    const graceful =
      (r === "timeout" || r === "cancelled") && opts.beforeTerminate !== undefined ? opts.beforeTerminate : undefined;
    const pre = r === "completed" ? "completed" : graceful ? "graceful" : "none";
    aborting = (async () => {
      if (pre === "completed") {
        endStdin();
        await waitForExit(killGraceMs);
      } else if (pre === "graceful" && graceful) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          graceful(r as "timeout" | "cancelled").catch(() => {}),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, killGraceMs);
          }),
        ]);
        if (timer) clearTimeout(timer);
      }
      // The process may have exited meanwhile: the exit handler then sweeps any straggler, never a reused pgid.
      if (exitSeen || finished) return termination;
      return terminate();
    })();
    return aborting;
  };

  function endStdin(): void {
    if (!stdinOpen) return;
    stdinOpen = false;
    try {
      child.stdin?.end();
    } catch {
      // already closed
    }
  }

  const reader = opts.onEvent
    ? new JsonlReader({
        maxLineBytes: opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
        ...(opts.isIgnorableLine ? { isIgnorable: opts.isIgnorableLine } : {}),
        ...(opts.rejectBlankLines === true ? { rejectBlankLines: true } : {}),
        onEvent: (value, lineNumber) => {
          try {
            opts.onEvent?.(value, lineNumber);
          } catch (err) {
            internalError = err as Error;
            void abort("internal_error");
          }
        },
        onProtocolError: (e) => {
          protocolError = e;
          // Record before abort: a fast exit can set exitSeen and skip reason in abort (malformed_output fakes).
          reason ??= "protocol_error";
          void abort("protocol_error");
        },
      })
    : undefined;

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (termination || aborting) return;
    idleTimer = setTimeout(() => {
      timeoutKind = "idle";
      void abort("timeout");
    }, idleMs);
  };

  const result = new Promise<SupervisedResult>((resolve) => {
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;

    const finish = async () => {
      clearTimers();
      // Sweep stragglers (e.g. a grandchild that outlived its parent) so no orphan stays behind.
      if (pid !== undefined && groupAlive(pid)) await terminate();
      else if (termination) await termination;
      else groupEmpty = true;
      reader?.end();
      let outcome: SupervisedOutcome;
      let failureCode: ExecFailureCode | undefined;
      if (spawnError) {
        outcome = "spawn_error";
        failureCode = "PROCESS_CRASH";
      } else if (reason === "timeout") {
        outcome = "timeout";
        failureCode = "PROCESS_TIMEOUT";
      } else if (reason === "cancelled") {
        outcome = "cancelled";
      } else if (reason === "protocol_error") {
        outcome = "protocol_error";
        failureCode = "OUTPUT_PROTOCOL_ERROR";
      } else if (reason === "internal_error") {
        outcome = "internal_error";
      } else if (reason === "completed") {
        outcome = "exited";
      } else if (signal !== null) {
        outcome = "crashed";
        failureCode = "PROCESS_CRASH";
      } else {
        outcome = "exited";
      }
      const error = spawnError ?? internalError;
      finished = true;
      resolve({
        outcome,
        failureCode,
        timeoutKind,
        exitCode,
        signal,
        stdout: stdout.buffer,
        stderr: stderr.buffer,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        protocolError,
        escalatedToKill: escalated,
        groupEmpty,
        error,
      });
    };

    child.on("error", (err) => {
      spawnError = err;
      if (pid === undefined) void finish();
    });
    child.on("exit", (code, sig) => {
      exitCode = code;
      signal = sig;
      exitSeen = true;
      // Leftover group members would hold the pipes open and block 'close'; clean them up.
      if (pid !== undefined && groupAlive(pid)) void terminate();
    });
    child.on("close", () => void finish());
  });

  if (pid !== undefined) {
    wallTimer = setTimeout(() => {
      timeoutKind = "wall_clock";
      void abort("timeout");
    }, wallClockMs);
    armIdle();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.add(chunk);
      armIdle();
      reader?.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => stderr.add(chunk));
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});

    if (opts.stdinText !== undefined && child.stdin) {
      child.stdin.on("error", () => {}); // EPIPE if the child exits before reading
      child.stdin.end(opts.stdinText);
    } else if (stdinOpen && child.stdin) {
      // A failed write is treated as the process ending (ADR-0036 item 3): stop writing; the exit decides the outcome.
      child.stdin.on("error", () => {
        stdinOpen = false;
      });
    }
    try {
      opts.onSpawn?.({ pid, pgid: pid });
    } catch (err) {
      internalError = err as Error;
      void abort("internal_error");
    }
  }

  return {
    pid,
    pgid: pid,
    cancel: async () => {
      if (pid === undefined) return;
      await abort("cancelled");
    },
    fail: (failure) => {
      if (pid === undefined) return;
      if (failure.kind === "protocol_error") {
        protocolError ??= failure.error;
        reason ??= "protocol_error";
        void abort("protocol_error");
      } else {
        if (reason === undefined && !exitSeen && !finished) timeoutKind = failure.timeoutKind;
        void abort("timeout");
      }
    },
    complete: async () => {
      if (pid === undefined) return;
      await abort("completed");
    },
    writeStdin: (data) => {
      if (!stdinOpen || child.stdin === null || child.stdin.destroyed) return false;
      try {
        child.stdin.write(data);
        return true;
      } catch {
        stdinOpen = false;
        return false;
      }
    },
    endStdin,
    result,
  };
}
