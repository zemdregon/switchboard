/**
 * The production {@link TerminalRunner} (ADR-0079, FR-CAP-13): runs a provider CLI's interactive TUI under a
 * pseudo-terminal from util-linux or BSD `script`, for a usage display that exists only there (Kimi Code `/usage`).
 *
 * Delegated (2026-10-21, live check on Kimi Code 2.1.1): the child runs in one STABLE probe directory
 * (`<probeRoot>/<probeDirName>`, production `<data_dir>/probes/<name>`), not a fresh temporary directory, because a
 * TUI may ask once per exact folder whether to trust it and remember the answer in its own data directory; a fresh
 * directory per read would ask every time and leave one record per read. Before every run the directory is created
 * with mode 0700 if missing and must be a real directory (no symlink), owned by this user, without group or other
 * write permission, and EMPTY, so no planted project configuration starts with the TUI. The child gets its real path
 * as working directory.
 *
 * The child's environment is exactly what the caller passes (its allowlist applied there). It runs detached in its own
 * process group, its output is capped at 1 MiB (newest kept) and never logged, and it is always stopped before the
 * result settles: Ctrl-C twice, SIGTERM to the group after about 1 s, SIGKILL after about 3 s.
 */
import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { resolveOnPath } from "./codex/adapter.js";
import type { TerminalIo, TerminalRunner, TerminalRunResult } from "./types.js";

export const MAX_TERMINAL_OUTPUT_CHARS = 1024 * 1024;

export type SpawnImpl = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface TerminalRunnerOptions {
  /** Parent of the probe directories (production: `<data_dir>/probes`). */
  readonly probeRoot: string;
  /** The pseudo-terminal wrapper; default `script` resolved on `pathEnv`. */
  readonly scriptCommand?: string;
  /** Default `process.env.PATH`. */
  readonly pathEnv?: string;
  readonly platform?: NodeJS.Platform;
  readonly spawnImpl?: SpawnImpl;
}

export const TERMINAL_PROBE_DIR_NOT_EMPTY = "the usage probe directory is not empty";
export const TERMINAL_PROBE_DIR_UNSAFE =
  "the usage probe directory is not a private directory (a symlink, another owner, or group or other write access)";
export const TERMINAL_UNSUPPORTED_PLATFORM = "a pseudo-terminal through `script` needs Linux or macOS";
export const TERMINAL_NO_SCRIPT = "`script` not found on PATH; it provides the pseudo-terminal the TUI needs";
export const TERMINAL_UNSAFE_ARGV = "the command cannot be passed to `script` safely";
export const TERMINAL_SPAWN_FAILED = "could not start the TUI through `script`";

const unsafeArg = (a: string) => a.includes("'") || /\p{Cc}/u.test(a);

/** The `script` argv that runs `argv` under a pseudo-terminal, or undefined on an unsupported platform. */
export function scriptArgs(platform: NodeJS.Platform, argv: readonly string[]): string[] | undefined {
  if (platform === "linux") return ["-qfc", argv.map((a) => `'${a}'`).join(" "), "/dev/null"];
  if (platform === "darwin") return ["-q", "/dev/null", ...argv];
  return undefined;
}

/**
 * Creates the probe directory (mode 0700) if missing and checks it before a run. Returns its real path, or the fixed
 * reason it cannot be used. The directory is only listed, never read into.
 */
export async function prepareProbeDir(
  dir: string,
): Promise<{ ok: true; realPath: string } | { ok: false; error: string }> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const st = await lstat(dir);
    const uid = process.getuid?.();
    if (st.isSymbolicLink() || !st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o022) !== 0) {
      return { ok: false, error: TERMINAL_PROBE_DIR_UNSAFE };
    }
    if ((await readdir(dir)).length > 0) return { ok: false, error: TERMINAL_PROBE_DIR_NOT_EMPTY };
    return { ok: true, realPath: await realpath(dir) };
  } catch {
    return { ok: false, error: TERMINAL_PROBE_DIR_UNSAFE };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createTerminalRunner(opts: TerminalRunnerOptions): TerminalRunner {
  return async <T>(
    argv: readonly string[],
    run: Parameters<TerminalRunner>[1] & { drive: (io: TerminalIo) => Promise<T> },
  ): Promise<TerminalRunResult<T>> => {
    const platform = opts.platform ?? process.platform;
    if (argv.length === 0 || argv.some(unsafeArg)) return { ok: false, error: TERMINAL_UNSAFE_ARGV };
    const args = scriptArgs(platform, argv);
    if (args === undefined) return { ok: false, error: TERMINAL_UNSUPPORTED_PLATFORM };
    const name = opts.scriptCommand ?? "script";
    const script = name.includes("/") ? name : resolveOnPath(name, opts.pathEnv ?? process.env.PATH);
    if (script === undefined) return { ok: false, error: TERMINAL_NO_SCRIPT };
    if (run.probeDirName === "" || /[\\/]|^\.\.?$/.test(run.probeDirName)) {
      return { ok: false, error: TERMINAL_PROBE_DIR_UNSAFE };
    }
    const probe = await prepareProbeDir(path.join(opts.probeRoot, run.probeDirName));
    if (!probe.ok) return probe;
    return session(opts.spawnImpl ?? (nodeSpawn as SpawnImpl), script, args, probe.realPath, run);
  };
}

async function session<T>(
  spawnImpl: SpawnImpl,
  command: string,
  args: string[],
  cwd: string,
  run: { timeoutMs: number; env: Readonly<Record<string, string>>; drive: (io: TerminalIo) => Promise<T> },
): Promise<TerminalRunResult<T>> {
  const deadline = Date.now() + run.timeoutMs;
  const events = new EventEmitter();
  let buf = "";
  let dropped = 0; // characters dropped from the head of `buf` by the cap
  let exited = false;
  let spawnError = false;
  let child: ChildProcess;
  try {
    child = spawnImpl(command, args, { cwd, env: { ...run.env }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return { ok: false, error: TERMINAL_SPAWN_FAILED };
  }
  child.stdout?.on("data", (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (buf.length > MAX_TERMINAL_OUTPUT_CHARS) {
      const cut = buf.length - MAX_TERMINAL_OUTPUT_CHARS;
      buf = buf.slice(cut);
      dropped += cut;
    }
    events.emit("change");
  });
  child.stderr?.on("data", () => undefined); // drained, never kept
  child.stdin?.on("error", () => undefined);
  child.on("error", () => {
    spawnError = true;
    exited = true;
    events.emit("change");
  });
  child.on("exit", () => {
    exited = true;
    events.emit("change");
  });
  const write = (s: string) => {
    if (!exited && child.stdin?.writable) child.stdin.write(s);
  };
  const waitFor = (pred: () => boolean, ms: number) =>
    new Promise<boolean>((resolve) => {
      if (pred()) return resolve(true);
      const done = (v: boolean) => {
        clearTimeout(timer);
        events.off("change", check);
        resolve(v);
      };
      const check = () => {
        if (pred()) done(true);
      };
      const timer = setTimeout(() => done(pred()), Math.max(0, ms));
      events.on("change", check);
    });
  const io: TerminalIo = {
    cwd,
    output: () => buf,
    mark: () => dropped + buf.length,
    outputSince: (m) => buf.slice(Math.max(0, m - dropped)),
    write,
    exited: () => exited,
    remaining: () => deadline - Date.now(),
    waitFor,
  };
  try {
    const value = await run.drive(io);
    return spawnError ? { ok: false, error: TERMINAL_SPAWN_FAILED } : { ok: true, value };
  } finally {
    await stop(child, () => exited, write, waitFor);
    buf = "";
  }
}

/** Ctrl-C twice, then SIGTERM to the process group after about 1 s, then SIGKILL after about 3 s. */
async function stop(
  child: ChildProcess,
  isExited: () => boolean,
  write: (s: string) => void,
  waitFor: (pred: () => boolean, ms: number) => Promise<boolean>,
): Promise<void> {
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    }
  };
  if (!isExited()) {
    write("\u0003");
    await sleep(200);
    write("\u0003");
    if (!(await waitFor(isExited, 1_000))) {
      signal("SIGTERM");
      if (!(await waitFor(isExited, 2_000))) {
        signal("SIGKILL");
        await waitFor(isExited, 1_000);
      }
    }
  }
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}
