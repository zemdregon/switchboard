/**
 * The project setup step (ADR-0071). After a run's worktree is prepared and before the agent starts, the controller
 * runs the project's frozen `setup.commands` in the worktree. Every choice below is Delegated (agent work, decided
 * within Linus's design; not owner-approved):
 *
 * - **Runner.** The verification stage's runner ({@link startVerification}): argv, no shell, own process group, stdin
 *   closed, fail fast, the whole step bounded by `timeout_seconds`, output captured per stream up to
 *   {@link SETUP_OUTPUT_CAP_BYTES}.
 * - **Sandbox and network.** Each command runs under bubblewrap through the bridge of `src/exec/setup-sandbox.ts`: an
 *   empty network namespace whose only exit is the per-step allowlisting CONNECT proxy (`src/exec/connect-proxy.ts`)
 *   on a Unix socket. Without a usable bubblewrap the step fails (`sandbox_unavailable`), never runs unconfined.
 * - **Environment.** Built here, nothing inherited but `PATH`: `HOME` and the XDG directories under
 *   `<data_dir>/setup/<project>/home`, `COREPACK_HOME` under `<data_dir>/caches/corepack`, the cache variables of
 *   `setup.cache`, the allowlisted `setup.env` values and fixed non-interactive switches. The bridge adds the proxy
 *   variables. No operator variable, token, SSH agent or Git credential reaches a command.
 * - **Skip.** A marker in the worktree's own Git directory (outside the worktree, so the agent cannot write it) records
 *   a successful step for a lockfile hash and a setup hash; a later run in the same worktree with both unchanged skips.
 * - **Outputs.** The step may only add or change files Git ignores: the non-ignored `git status` after a successful
 *   step must equal the one before, otherwise the step fails (`outputs_not_ignored`), so setup output (an unignored
 *   `node_modules`) can never reach a checkpoint, diff, commit-tool commit or finalize-only commit.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ConnectProxy,
  type ConnectProxyOptions,
  type ConnectProxyStats,
  detectOuterSandbox,
  type OuterSandboxAvailability,
  setupReadablePaths,
  startConnectProxy,
  wrapSetupSandbox,
} from "../exec/index.js";
import { startVerification, type VerificationCommandResult, type VerificationRun } from "../lifecycle/verification.js";
import type { ProjectSetupSnapshot } from "../policy/index.js";
import { git, gitText } from "./git.js";

/** `run_event` type: one per phase of the step (`started`, `succeeded`, `failed`, `skipped`); codes and numbers only. */
export const WORKSPACE_SETUP_EVENT = "workspace_setup";
/** Per-stream capture bound for one setup command (Delegated). */
export const SETUP_OUTPUT_CAP_BYTES = 256 * 1024;
/** The marker file name, in the worktree's Git directory. */
export const SETUP_MARKER_FILE = "switchboard-setup.json";
/** Lockfiles hashed into the skip key, at the worktree root (absent ones count as absent). */
export const SETUP_LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;

export type SetupFailureReason =
  | "command_failed"
  | "timeout"
  | "sandbox_unavailable"
  | "outputs_not_ignored"
  | "internal_error";

export interface SetupPlan {
  readonly lockfileSha256: string;
  readonly setupSha256: string;
  /** True when the marker records a successful step for both hashes. */
  readonly skip: boolean;
}

export interface SetupRunResult {
  readonly outcome: "succeeded" | "failed" | "timeout" | "cancelled";
  readonly reason?: SetupFailureReason;
  readonly commands: readonly VerificationCommandResult[];
  readonly durationMs: number;
  /** True when the commands ran inside bubblewrap (always in production; false only with an injected test wrap). */
  readonly confined: boolean;
  readonly proxy: ConnectProxyStats;
}

export interface SetupRunInput {
  readonly runId: string;
  readonly projectId: string;
  readonly worktreePath: string;
  readonly setup: ProjectSetupSnapshot;
  readonly plan: SetupPlan;
  /** Called synchronously after each spawn (persist pid/pgid for reconciliation). */
  readonly onSpawn?: (index: number, info: { pid: number; pgid: number }) => void;
}

export interface SetupHandle {
  cancel(): Promise<void>;
  readonly done: Promise<SetupRunResult>;
}

export interface ProjectSetupOptions {
  /** `<data_dir>`: the setup homes and the caches live under it. */
  readonly dataDir: string;
  /** The controller's environment: only `PATH` is read from it (and `HOME`, to hide it in the sandbox). */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** Outer sandbox detection (`serve`); detected once, on first use, when absent. */
  readonly outerSandbox?: OuterSandboxAvailability;
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
  /**
   * Tests only: replaces the bubblewrap wrapper (`socketPath` is the proxy's Unix socket). The result then reports
   * `confined: false`.
   */
  readonly wrap?: (argv: readonly string[], socketPath: string) => readonly string[];
  /** Tests only: the proxy's resolver, address rule and dialler. */
  readonly proxy?: Pick<ConnectProxyOptions, "lookup" | "allowAddress" | "dial">;
}

export interface ProjectSetupRunner {
  plan(worktreePath: string, setup: ProjectSetupSnapshot): Promise<SetupPlan>;
  start(input: SetupRunInput): SetupHandle;
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** SHA-256 of the canonical JSON of the frozen setup (host list and env keys sorted). */
export function setupHash(setup: ProjectSetupSnapshot): string {
  const env = Object.fromEntries(Object.entries(setup.env).sort(([a], [b]) => a.localeCompare(b)));
  return sha256(
    JSON.stringify({
      commands: setup.commands,
      network_hosts: [...setup.network_hosts].sort(),
      cache: setup.cache,
      timeout_seconds: setup.timeout_seconds,
      env,
    }),
  );
}

/** SHA-256 over each known lockfile at the worktree root: its name and the SHA-256 of its bytes, or `absent`. */
export async function lockfileHash(worktreePath: string): Promise<string> {
  const parts: [string, string][] = [];
  for (const name of SETUP_LOCKFILES) {
    const p = path.join(worktreePath, name);
    try {
      const st = await lstat(p);
      parts.push([name, st.isFile() ? sha256(await readFile(p)) : "not_a_file"]);
    } catch {
      parts.push([name, "absent"]);
    }
  }
  return sha256(JSON.stringify(parts));
}

/**
 * The step's environment (see the module comment). `home` and `caches` must exist before the step starts.
 */
export function setupEnvironment(o: {
  readonly path: string | undefined;
  readonly home: string;
  readonly caches: string;
  readonly setup: ProjectSetupSnapshot;
}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: o.path ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: o.home,
    TMPDIR: "/tmp",
    XDG_CACHE_HOME: path.join(o.home, ".cache"),
    XDG_CONFIG_HOME: path.join(o.home, ".config"),
    XDG_DATA_HOME: path.join(o.home, ".local", "share"),
    XDG_STATE_HOME: path.join(o.home, ".local", "state"),
    COREPACK_HOME: path.join(o.caches, "corepack"),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    // Node.js 24+: its fetch (used by corepack) honours the proxy variables the bridge sets.
    NODE_USE_ENV_PROXY: "1",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  if (o.setup.cache === "pnpm") {
    const store = path.join(o.caches, "pnpm-store");
    env.npm_config_store_dir = store;
    env.pnpm_config_store_dir = store;
    env.PNPM_STORE_DIR = store;
  } else if (o.setup.cache === "npm") {
    env.npm_config_cache = path.join(o.caches, "npm");
  }
  for (const [k, v] of Object.entries(o.setup.env)) env[k] = v;
  return env;
}

/** The non-ignored status of the worktree (`git status --porcelain=v1 -z`), the before/after comparison key. */
async function statusKey(worktreePath: string): Promise<string> {
  const r = await git(["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"], {
    cwd: worktreePath,
  });
  return sha256(r.stdout);
}

async function markerPath(worktreePath: string): Promise<string> {
  return path.join(await gitText(["rev-parse", "--absolute-git-dir"], { cwd: worktreePath }), SETUP_MARKER_FILE);
}

/** The setup runner `serve` composes (see the module comment). */
export function createProjectSetup(opts: ProjectSetupOptions): ProjectSetupRunner {
  const caches = path.join(opts.dataDir, "caches");
  let detected: Promise<OuterSandboxAvailability> | undefined;
  const availability = (): Promise<OuterSandboxAvailability> => {
    if (opts.outerSandbox !== undefined) return Promise.resolve(opts.outerSandbox);
    detected ??= detectOuterSandbox({ path: opts.baseEnv.PATH ?? "" });
    return detected;
  };
  const plan = async (worktreePath: string, setup: ProjectSetupSnapshot): Promise<SetupPlan> => {
    const lockfileSha256 = await lockfileHash(worktreePath);
    const setupSha256 = setupHash(setup);
    let skip = false;
    try {
      const m = JSON.parse(await readFile(await markerPath(worktreePath), "utf8")) as Record<string, unknown>;
      skip = m.v === 1 && m.lockfile_sha256 === lockfileSha256 && m.setup_sha256 === setupSha256;
    } catch {
      skip = false; // no marker, or one that cannot be read: run the step
    }
    return { lockfileSha256, setupSha256, skip };
  };

  const start = (input: SetupRunInput): SetupHandle => {
    let cancelled = false;
    let stage: VerificationRun | undefined;
    const started = Date.now();
    const confined = opts.wrap === undefined;
    const done = (async (): Promise<SetupRunResult> => {
      let proxy: ConnectProxy | undefined;
      const end = (outcome: SetupRunResult["outcome"], reason?: SetupFailureReason, extra = {}): SetupRunResult => ({
        commands: [],
        confined,
        proxy: proxy?.stats() ?? { allowed: 0, refused: 0 },
        ...extra,
        outcome,
        ...(reason !== undefined ? { reason } : {}),
        durationMs: Date.now() - started,
      });
      let bwrap: string | null = null;
      if (confined) {
        const b = (await availability()).mechanisms.bubblewrap;
        bwrap = b.available ? b.path : null;
        if (bwrap === null) return end("failed", "sandbox_unavailable");
      }
      const home = path.join(opts.dataDir, "setup", input.projectId, "home");
      let socketDir: string | undefined;
      try {
        await mkdir(home, { recursive: true, mode: 0o700 });
        await mkdir(caches, { recursive: true, mode: 0o700 });
        // A short path: a Unix socket path is limited to about 100 bytes, a data directory may be longer.
        socketDir = await mkdtemp(path.join(tmpdir(), "sb-setup-"));
        const socketPath = path.join(socketDir, "proxy.sock");
        const before = await statusKey(input.worktreePath);
        proxy = await startConnectProxy({
          hosts: input.setup.network_hosts,
          listen: { path: socketPath },
          ...opts.proxy,
        });
        if (cancelled) return end("cancelled");
        const env = setupEnvironment({ path: opts.baseEnv.PATH, home, caches, setup: input.setup });
        const layout = {
          worktree: input.worktreePath,
          writable: [home, caches, socketDir],
          hidden: [
            ...(opts.baseEnv.HOME !== undefined && path.isAbsolute(opts.baseEnv.HOME) ? [opts.baseEnv.HOME] : []),
            opts.dataDir,
            "/run",
            "/tmp",
          ],
          readable: setupReadablePaths(opts.baseEnv.PATH, process.execPath),
        };
        stage = startVerification({
          commands: input.setup.commands,
          cwd: input.worktreePath,
          envAllowlist: Object.keys(env),
          baseEnv: env,
          wallClockMs: input.setup.timeout_seconds * 1000,
          ...(opts.killGraceMs !== undefined ? { killGraceMs: opts.killGraceMs } : {}),
          maxOutputBytes: opts.maxOutputBytes ?? SETUP_OUTPUT_CAP_BYTES,
          confined: true,
          wrapSandbox: (argv) =>
            opts.wrap
              ? opts.wrap(argv, socketPath)
              : wrapSetupSandbox(bwrap as string, layout, socketPath, process.execPath, argv),
          ...(input.onSpawn ? { onSpawn: input.onSpawn } : {}),
        });
        if (cancelled) void stage.cancel();
        const r = await stage.done;
        const result = { commands: r.commands };
        if (r.outcome === "cancelled" || cancelled) return end("cancelled", undefined, result);
        if (r.internalError) return end("failed", "internal_error", result);
        if (r.commands.some((c) => c.outcome === "timeout")) return end("timeout", "timeout", result);
        if (r.outcome !== "passed") return end("failed", "command_failed", result);
        if ((await statusKey(input.worktreePath)) !== before) return end("failed", "outputs_not_ignored", result);
        await writeFile(
          await markerPath(input.worktreePath),
          `${JSON.stringify({ v: 1, lockfile_sha256: input.plan.lockfileSha256, setup_sha256: input.plan.setupSha256 })}\n`,
          { mode: 0o600 },
        );
        return end("succeeded", undefined, result);
      } catch {
        return end("failed", "internal_error", { commands: [] });
      } finally {
        await proxy?.close();
        if (socketDir !== undefined) await rm(socketDir, { recursive: true, force: true });
      }
    })();
    return {
      cancel: async () => {
        cancelled = true;
        await stage?.cancel();
      },
      done,
    };
  };

  return { plan, start };
}

/** The `setup_log` artifact body (version 1, `application/json`): argv and output passed through `redact`. */
export function setupReport(result: SetupRunResult, redact: (b: Buffer) => Buffer, plan: SetupPlan): Buffer {
  const text = (b: Buffer) => redact(b).toString("utf8");
  return Buffer.from(
    JSON.stringify({
      v: 1,
      outcome: result.outcome,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      confined: result.confined,
      lockfile_sha256: plan.lockfileSha256,
      setup_sha256: plan.setupSha256,
      proxy: result.proxy,
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
