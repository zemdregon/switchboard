/**
 * Bubblewrap confinement of the Cursor bypass cell (ADR-0059; T4.48 fix under the owner ruling of 2026-10-19 06:41 CDT,
 * option A). The approved bypass cell (owner decision 46, Q-79) keeps `--trust --force`, but its provider process
 * always starts inside `bwrap`; there is no unconfined path:
 * - the host root is mounted read-only, with a fresh minimal `/dev` and `/proc` and every namespace but the network
 *   unshared (the cell's network is `on`, Q-79);
 * - `$HOME`, the platform temp directory (which holds the leg's temp parent) and the other host temp and runtime
 *   directories are hidden behind an empty tmpfs, and so is the worktree's parent (other runs' worktrees);
 * - only the worktree is bound read-write, and back into the tmpfs only Cursor's own install directory and its login
 *   store (read-only) and its state directory (read-write, written on every run) are bound;
 * - a missing `bwrap`, a confinement probe that fails, or a worktree that would re-expose a hidden directory makes the
 *   cell Ineligible, which a run reports as `ELIGIBILITY_NONE`.
 *
 * Cursor's state paths are from the 2026-10-14 live check (`docs/research/live-checks-2026-10-14-cursor.md`, rows 11
 * and "Side effects"); whether Cursor accepts a read-only login store is **Unverified** until the steward's live rerun.
 * The tool-call guard exemption for bypass runs (ADR-0039 item 1) stays: it is detective only, this wrapper is the
 * enforcing control. Nothing here reads a credential: paths are only stat'ed and named in bind arguments.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findOnPath } from "../../exec/outer-sandbox.js";
import type { ProbeResult, ProbeRunner } from "../types.js";

/** The bubblewrap binary looked up on `PATH` (0.11.1 on the Ampere host). */
export const BWRAP_BINARY = "bwrap";

/**
 * Cursor's login store under `$HOME`, bound read-only ([LIVE] row 11: login survived a scratch `CURSOR_CONFIG_DIR`, so
 * the credential is not under `~/.cursor`; on the operator's host the directory `~/.config/cursor` exists). Assumption:
 * Cursor runs with it read-only (Unverified until the live rerun; ADR-0059 item 4).
 */
export const CURSOR_LOGIN_STORE = ".config/cursor";

/**
 * Cursor's state directory under `$HOME`, bound read-write: the CLI writes chats, projects, tracking data and rewrites
 * `cli-config.json` (temp file and rename in that directory) on every run ([LIVE] "Side effects").
 */
export const CURSOR_STATE_DIR = ".cursor";

/** Host directories hidden behind a tmpfs beside `$HOME` and the platform temp directory, when they exist. */
export const HIDDEN_HOST_DIRS: readonly string[] = ["/tmp", "/var/tmp", "/run/user"];

/** Namespace and lifetime flags: every namespace but the network (the cell's network is `on`), killed with its parent. */
export const BWRAP_ISOLATION_FLAGS: readonly string[] = ["--unshare-all", "--share-net", "--die-with-parent"];

/** Per-probe timeout (Assumption, as `OUTER_SANDBOX_PROBE_TIMEOUT_MS`: a no-op under bwrap takes milliseconds). */
export const CONFINEMENT_PROBE_TIMEOUT_MS = 5_000;

/**
 * The probe's shell script: create `$1` in the worktree, and fail if `$2`, a canary beside the worktree, is visible.
 * The test-only pass-through stand-in (`fixtures/passthrough-bwrap.sh`) matches this text.
 */
export const CONFINEMENT_PROBE_SCRIPT = 'touch "$1" && test ! -e "$2"';

/** Ineligible detail when no `bwrap` is found. */
export const CURSOR_BWRAP_MISSING =
  "bubblewrap (bwrap) not found on PATH: the Cursor bypass cell runs only inside its bwrap wrapper and has no " +
  "unconfined fallback (ADR-0059)";
/** Ineligible detail after a failed confinement probe. */
export const CURSOR_CONFINEMENT_FAILED =
  "the bwrap confinement probe failed on this host: the Cursor bypass cell runs only inside its bwrap wrapper and " +
  "has no unconfined fallback (ADR-0059)";

/** What the wrapper hides and binds; every path absolute and resolved. */
export interface CursorConfinementPlan {
  readonly bwrap: string;
  /** Resolved Cursor executable, argv[0] inside the wrapper (a `~/.local/bin` symlink is not visible there). */
  readonly executable: string;
  readonly home: string;
  /** Directories covered by an empty tmpfs (parents before children). */
  readonly hidden: readonly string[];
  /** Bound back read-only when present (`--ro-bind-try`): Cursor's install directory and its login store. */
  readonly readOnly: readonly string[];
  /** Bound back read-write when present (`--bind-try`): Cursor's state directory. */
  readonly writable: readonly string[];
}

export interface CursorConfinementOptions {
  /** Absolute `bwrap` path, or null when none is installed. */
  readonly bwrap: string | null;
  /** `$HOME` the provider process gets; undefined when unset. */
  readonly home: string | undefined;
  /** Platform temp directory (`os.tmpdir()`). */
  readonly tmpDir: string;
  /** Absolute path of the Cursor executable (argv[0] inside the wrapper); its directory is bound read-only. */
  readonly executable: string;
}

const resolved = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const depth = (p: string): number => p.split(path.sep).filter(Boolean).length;
/** `inner` equals `outer` or lies below it. */
export const within = (inner: string, outer: string): boolean => {
  const rel = path.relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const unique = (ps: readonly string[]): string[] => [...new Set(ps)];

/**
 * The plan for this host, or the Ineligible detail. Pure apart from `realpath` and `stat` of the named directories
 * (never a read of their contents).
 */
export function cursorConfinementPlan(o: CursorConfinementOptions): CursorConfinementPlan | { refused: string } {
  if (o.bwrap === null) return { refused: CURSOR_BWRAP_MISSING };
  if (o.home === undefined || o.home === "" || !path.isAbsolute(o.home)) {
    return { refused: "HOME is unset or not absolute: the bwrap wrapper cannot hide it (ADR-0059)" };
  }
  const home = resolved(o.home);
  if (home === path.parse(home).root) return { refused: "HOME is the filesystem root: it cannot be hidden (ADR-0059)" };
  const hidden = unique([home, resolved(o.tmpDir), ...HIDDEN_HOST_DIRS.map(resolved)])
    .filter((d) => d !== path.parse(d).root && isDir(d))
    .sort((a, b) => depth(a) - depth(b));
  const executable = resolved(o.executable);
  const installDir = path.dirname(executable);
  if (hidden.some((d) => within(d, installDir))) {
    return { refused: `Cursor's install directory ${installDir} contains a directory the wrapper hides (ADR-0059)` };
  }
  return {
    bwrap: o.bwrap,
    executable,
    home,
    hidden,
    readOnly: unique([installDir, path.join(home, CURSOR_LOGIN_STORE)]),
    writable: [path.join(home, CURSOR_STATE_DIR)],
  };
}

/**
 * The `bwrap` arguments (up to and including `--`) confining a run to `worktree`, or the refusal detail when the
 * worktree would re-expose what the plan hides: the root, `$HOME`, a hidden directory or one of their ancestors, or a
 * path inside the login store or the state directory. The worktree's parent is hidden too. Mount order: the
 * read-only root, `/dev`, `/proc`, then each tmpfs and bind from the outermost path in, so no later mount covers an
 * inner one.
 */
export function cursorBwrapArgs(plan: CursorConfinementPlan, worktreePath: string): string[] | { refused: string } {
  if (!path.isAbsolute(worktreePath)) return { refused: "the worktree path is not absolute (ADR-0059)" };
  const worktree = resolved(worktreePath);
  const exposes = (d: string) => within(d, worktree);
  if (
    worktree === path.parse(worktree).root ||
    plan.hidden.some(exposes) ||
    [...plan.readOnly, ...plan.writable].some(exposes)
  ) {
    return { refused: `the worktree ${worktree} contains a directory the bwrap wrapper hides or binds (ADR-0059)` };
  }
  if ([path.join(plan.home, CURSOR_LOGIN_STORE), ...plan.writable].some((d) => within(worktree, d))) {
    return { refused: `the worktree ${worktree} lies inside Cursor's login store or state directory (ADR-0059)` };
  }
  const parent = path.dirname(worktree);
  const hidden = plan.hidden.some((d) => within(parent, d)) ? [...plan.hidden] : [...plan.hidden, parent];
  type Mount = { op: string; p: string };
  const mounts: Mount[] = [
    ...hidden.map((p) => ({ op: "--tmpfs", p })),
    ...plan.readOnly.map((p) => ({ op: "--ro-bind-try", p })),
    ...plan.writable.map((p) => ({ op: "--bind-try", p })),
    { op: "--bind", p: worktree },
  ];
  // Stable sort: at equal depth a tmpfs comes before the binds that follow it.
  mounts.sort((a, b) => depth(a.p) - depth(b.p));
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const m of mounts) args.push(...(m.op === "--tmpfs" ? [m.op, m.p] : [m.op, m.p, m.p]));
  args.push("--chdir", worktree, ...BWRAP_ISOLATION_FLAGS, "--");
  return args;
}

/**
 * The `confinement` probe step: proves the wrapper holds on this host rather than assuming it. In a scratch leg under
 * the temp directory it runs `/bin/sh` inside the same wrapper, which must create a file in the scratch worktree and
 * must not see a canary beside it; the host then checks the file reached the real worktree. Anything else (no plan,
 * spawn error, timeout, non-zero exit, file missing) is a failed step, so the run is `ELIGIBILITY_NONE` (FRD BR-3).
 */
export async function probeConfinement(
  plan: CursorConfinementPlan | { refused: string },
  runner: ProbeRunner,
  tmpDir: string,
): Promise<ProbeResult["steps"][number]> {
  if ("refused" in plan) return { step: "confinement", ok: false, detail: plan.refused };
  let leg: string | undefined;
  try {
    leg = mkdtempSync(path.join(tmpDir, "sb-cursor-bwrap-probe-"));
    const worktree = path.join(leg, "wt");
    const canary = path.join(leg, "outside-canary.txt");
    mkdirSync(worktree);
    writeFileSync(canary, "switchboard confinement probe canary\n");
    const args = cursorBwrapArgs(plan, worktree);
    if (!Array.isArray(args)) return { step: "confinement", ok: false, detail: args.refused };
    const marker = path.join(resolved(worktree), "confined");
    const r = await runner(
      [plan.bwrap, ...args, "/bin/sh", "-c", CONFINEMENT_PROBE_SCRIPT, "sh", marker, resolved(canary)],
      {
        timeoutMs: CONFINEMENT_PROBE_TIMEOUT_MS,
      },
    );
    const why =
      r.spawnError !== undefined
        ? "could not start"
        : r.timedOut
          ? "timed out"
          : r.exitCode !== 0
            ? `exit ${r.exitCode}`
            : !existsSync(marker)
              ? "the worktree bind did not reach the real worktree"
              : undefined;
    return why === undefined
      ? { step: "confinement", ok: true }
      : { step: "confinement", ok: false, detail: `bwrap ${why}` };
  } catch (err) {
    return { step: "confinement", ok: false, detail: `probe setup failed: ${(err as Error).message.slice(0, 200)}` };
  } finally {
    if (leg !== undefined) rmSync(leg, { recursive: true, force: true });
  }
}

/** Default host facts: `bwrap` on `pathEnv`, `$HOME` and `os.tmpdir()`. */
export function hostConfinementDefaults(pathEnv: string | undefined): {
  bwrap: string | null;
  home: string | undefined;
  tmpDir: string;
} {
  return { bwrap: findOnPath(BWRAP_BINARY, pathEnv), home: process.env.HOME, tmpDir: tmpdir() };
}
