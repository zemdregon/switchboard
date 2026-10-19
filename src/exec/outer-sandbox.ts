/**
 * Outer sandbox (T3.1; ADR-0051, LLD §8.4; R-8, R-10, FR-POL-06, Q-22): availability detection for bubblewrap,
 * `prlimit` and Landlock, and the fail-closed refusal for a profile that `outer_sandbox.required_profiles` names.
 *
 * Delegated choices (ADR-0051):
 * - Detection never throws and never assumes: a mechanism is `available` only when this host showed it working
 *   (bubblewrap and `prlimit` each run a no-op command; Landlock is named in the kernel's active LSM list). Anything
 *   else (not Linux, not on `PATH`, a probe that fails or times out, an unreadable LSM list) is `unavailable` with a
 *   reason, so a CI runner without them degrades instead of crashing.
 * - The Landlock ABI version is not determined: it needs the `landlock_create_ruleset` system call, which Node.js
 *   does not expose, and this module adds no native helper. It is reported as `null`, never guessed.
 * - This gate wraps no provider process (verification commands are wrapped by T3.11, and the Cursor bypass cell by its
 *   own wrapper, ADR-0059, outside this gate). A profile listed in `required_profiles` is
 *   therefore refused at admission whatever detection finds: `OUTER_SANDBOX_UNAVAILABLE` when a required mechanism is
 *   missing, `OUTER_SANDBOX_NOT_ENFORCED` when all are present. A run is never started unconfined under a
 *   configuration that requires confinement (fail closed; no claim of a control that is not enforced).
 */
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const OUTER_SANDBOX_MECHANISMS = ["bubblewrap", "prlimit", "landlock"] as const;
export type OuterSandboxMechanism = (typeof OUTER_SANDBOX_MECHANISMS)[number];

/**
 * What a profile listed in `outer_sandbox.required_profiles` needs (ADR-0051): bubblewrap for the filesystem, process
 * and network namespaces, `prlimit` for the resource limits of R-8. Landlock is detected and reported only.
 */
export const REQUIRED_OUTER_SANDBOX_MECHANISMS: readonly OuterSandboxMechanism[] = ["bubblewrap", "prlimit"];

/** Refusal reasons, recorded in the error message; the taxonomy code is `ELIGIBILITY_NONE` (FRD BR-3). */
export type OuterSandboxRefusalReason = "OUTER_SANDBOX_UNAVAILABLE" | "OUTER_SANDBOX_NOT_ENFORCED";

export interface OuterSandboxMechanismStatus {
  readonly mechanism: OuterSandboxMechanism;
  readonly available: boolean;
  /** Absolute path of the executable that was probed; null for Landlock or when none was found. */
  readonly path: string | null;
  /** Version text as reported by the tool; null when unknown (always null for Landlock, see the module comment). */
  readonly version: string | null;
  /** One line for operators: what was checked and what it showed. */
  readonly detail: string;
}

export interface OuterSandboxAvailability {
  readonly platform: NodeJS.Platform;
  readonly mechanisms: Readonly<Record<OuterSandboxMechanism, OuterSandboxMechanismStatus>>;
}

export interface OuterSandboxProbeResult {
  /** Exit code, or null when the process could not be started, was killed or timed out. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface OuterSandboxProbeDeps {
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** `PATH` used to find the tools and passed (alone) to each probe. Defaults to `process.env.PATH`. */
  readonly path?: string;
  /** Runs one probe command. Defaults to `execFile` with an environment of `PATH` only and a timeout. */
  readonly run?: (file: string, args: readonly string[]) => Promise<OuterSandboxProbeResult>;
  /** Reads the kernel's active LSM list. Defaults to reading {@link LSM_LIST_PATH}. */
  readonly readLsmList?: () => string;
}

export const LSM_LIST_PATH = "/sys/kernel/security/lsm";
/** Per-probe timeout (Assumption: a no-op under bwrap takes milliseconds; a hang must not stall `doctor` or `serve`). */
export const OUTER_SANDBOX_PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_OUTPUT = 64 * 1024;

/**
 * The bubblewrap probe: an empty-ish sandbox (read-only root, fresh /dev and /proc, every namespace unshared) running
 * `true`. It fails where unprivileged user namespaces are blocked, which is exactly the "installed but unusable" case.
 */
export const BWRAP_PROBE_ARGS: readonly string[] = [
  "--ro-bind",
  "/",
  "/",
  "--dev",
  "/dev",
  "--proc",
  "/proc",
  "--unshare-all",
  "--die-with-parent",
  "--",
  "true",
];
/** The `prlimit` probe: set the core-file limit to zero for `true`. */
export const PRLIMIT_PROBE_ARGS: readonly string[] = ["--core=0:0", "--", "true"];

/** First executable regular file named `name` in the `PATH` list, or null. Relative entries are skipped. */
export function findOnPath(name: string, searchPath: string | undefined): string | null {
  for (const dir of (searchPath ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

function defaultRun(searchPath: string | undefined) {
  return (file: string, args: readonly string[]): Promise<OuterSandboxProbeResult> =>
    new Promise((resolve) => {
      try {
        execFile(
          file,
          [...args],
          {
            env: searchPath !== undefined ? { PATH: searchPath } : {},
            timeout: OUTER_SANDBOX_PROBE_TIMEOUT_MS,
            killSignal: "SIGKILL",
            maxBuffer: MAX_PROBE_OUTPUT,
            encoding: "utf8",
          },
          (err, stdout, stderr) => {
            const code = err ? (typeof err.code === "number" && !err.killed ? err.code : null) : 0;
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
          },
        );
      } catch (err) {
        resolve({ code: null, stdout: "", stderr: (err as Error).message });
      }
    });
}

const firstLine = (s: string): string => (s.split("\n").find((l) => l.trim() !== "") ?? "").trim().slice(0, 200);

const probeFailure = (r: OuterSandboxProbeResult): string =>
  r.code === null
    ? "did not complete (not startable, killed or timed out)"
    : `exited ${r.code}${firstLine(r.stderr) ? `: ${firstLine(r.stderr)}` : ""}`;

async function probeTool(
  mechanism: "bubblewrap" | "prlimit",
  binary: string,
  versionPattern: RegExp,
  probeArgs: readonly string[],
  searchPath: string | undefined,
  run: (file: string, args: readonly string[]) => Promise<OuterSandboxProbeResult>,
): Promise<OuterSandboxMechanismStatus> {
  const found = findOnPath(binary, searchPath);
  if (found === null) {
    return { mechanism, available: false, path: null, version: null, detail: `${binary} not found on PATH` };
  }
  const v = await run(found, ["--version"]);
  const version = v.code === 0 ? (versionPattern.exec(v.stdout)?.[1] ?? (firstLine(v.stdout) || null)) : null;
  const p = await run(found, probeArgs);
  if (p.code !== 0) {
    return { mechanism, available: false, path: found, version, detail: `${binary} probe ${probeFailure(p)}` };
  }
  return {
    mechanism,
    available: true,
    path: found,
    version,
    detail: `${binary}${version ? ` ${version}` : ""} at ${found}: probe ran`,
  };
}

function detectLandlock(platform: NodeJS.Platform, readLsmList: () => string): OuterSandboxMechanismStatus {
  const base = { mechanism: "landlock" as const, path: null, version: null };
  if (platform !== "linux") return { ...base, available: false, detail: `Landlock is Linux only (host: ${platform})` };
  let list: string;
  try {
    list = readLsmList();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    return { ...base, available: false, detail: `cannot read ${LSM_LIST_PATH} (${code}); Landlock status unknown` };
  }
  const active = list
    .trim()
    .split(",")
    .map((s) => s.trim())
    .includes("landlock");
  return active
    ? {
        ...base,
        available: true,
        detail: `landlock is in the active LSM list (${LSM_LIST_PATH}); ABI version not determined`,
      }
    : { ...base, available: false, detail: `landlock is not in the active LSM list (${LSM_LIST_PATH})` };
}

/** Detects each mechanism on this host (see the module comment). Never throws. */
export async function detectOuterSandbox(deps: OuterSandboxProbeDeps = {}): Promise<OuterSandboxAvailability> {
  const platform = deps.platform ?? process.platform;
  const searchPath = deps.path ?? process.env.PATH;
  const run = deps.run ?? defaultRun(searchPath);
  const readLsmList = deps.readLsmList ?? (() => readFileSync(LSM_LIST_PATH, "utf8"));
  const notLinux = (mechanism: "bubblewrap" | "prlimit"): OuterSandboxMechanismStatus => ({
    mechanism,
    available: false,
    path: null,
    version: null,
    detail: `${mechanism} is used on Linux only (host: ${platform})`,
  });
  const guarded = async (
    mechanism: "bubblewrap" | "prlimit",
    probe: () => Promise<OuterSandboxMechanismStatus>,
  ): Promise<OuterSandboxMechanismStatus> => {
    if (platform !== "linux") return notLinux(mechanism);
    try {
      return await probe();
    } catch (err) {
      return {
        mechanism,
        available: false,
        path: null,
        version: null,
        detail: `probe error: ${(err as Error).message}`,
      };
    }
  };
  const [bubblewrap, prlimit] = await Promise.all([
    guarded("bubblewrap", () =>
      probeTool("bubblewrap", "bwrap", /bubblewrap\s+(\S+)/, BWRAP_PROBE_ARGS, searchPath, run),
    ),
    guarded("prlimit", () =>
      probeTool("prlimit", "prlimit", /util-linux\s+(\S+)/, PRLIMIT_PROBE_ARGS, searchPath, run),
    ),
  ]);
  let landlock: OuterSandboxMechanismStatus;
  try {
    landlock = detectLandlock(platform, readLsmList);
  } catch (err) {
    landlock = {
      mechanism: "landlock",
      available: false,
      path: null,
      version: null,
      detail: `probe error: ${(err as Error).message}`,
    };
  }
  return { platform, mechanisms: { bubblewrap, prlimit, landlock } };
}

export interface OuterSandboxRefusal {
  readonly reason: OuterSandboxRefusalReason;
  readonly message: string;
}

/**
 * The admission refusal for `profile`, or undefined when `requiredProfiles` does not name it. A named profile is always
 * refused (see the module comment); the reason says whether the host lacks a mechanism or Switchboard lacks the
 * wrapping. `availability` undefined (detection did not run) counts as every mechanism missing.
 */
export function outerSandboxRefusal(
  profile: string,
  requiredProfiles: readonly string[],
  availability: OuterSandboxAvailability | undefined,
): OuterSandboxRefusal | undefined {
  if (!requiredProfiles.includes(profile)) return undefined;
  const missing = REQUIRED_OUTER_SANDBOX_MECHANISMS.filter((m) => availability?.mechanisms[m].available !== true);
  if (missing.length > 0) {
    const why = missing.map((m) => availability?.mechanisms[m].detail ?? `${m} not detected`).join("; ");
    return {
      reason: "OUTER_SANDBOX_UNAVAILABLE",
      message:
        `trust profile ${JSON.stringify(profile)} requires the outer sandbox (outer_sandbox.required_profiles) and ` +
        `this host lacks ${missing.join(", ")} (${why}); the run is refused rather than started unconfined ` +
        "(OUTER_SANDBOX_UNAVAILABLE)",
    };
  }
  return {
    reason: "OUTER_SANDBOX_NOT_ENFORCED",
    message:
      `trust profile ${JSON.stringify(profile)} requires the outer sandbox (outer_sandbox.required_profiles); ` +
      `${REQUIRED_OUTER_SANDBOX_MECHANISMS.join(" and ")} are available on this host, but this build does not yet ` +
      "wrap runs in them (ADR-0051), so the run is refused rather than started unconfined (OUTER_SANDBOX_NOT_ENFORCED)",
  };
}

/** One-line operator summary of `availability`, e.g. for `doctor`. */
export function describeOuterSandbox(availability: OuterSandboxAvailability): string {
  return OUTER_SANDBOX_MECHANISMS.map((m) => {
    const s = availability.mechanisms[m];
    return `${m}: ${s.available ? "available" : "unavailable"} (${s.detail})`;
  }).join("; ");
}

/**
 * Wraps a verification command `argv` in bubblewrap for confined verification (T3.11; FR-EXE-08, FR-POL-06, decision 11).
 * Mounts the host root read-only (`--ro-bind / /`), provides fresh `/dev` and `/proc`, unshares all namespaces
 * (user, ipc, pid, net, uts, cgroup), sets the working directory to the worktree and binds the worktree directory writable.
 * Writes outside the worktree are refused by the kernel with EROFS (read-only file system).
 */
export function wrapOuterSandboxVerification(
  bwrapPath: string,
  worktreePath: string,
  argv: readonly string[],
): string[] {
  let bindPath = worktreePath;
  try {
    bindPath = realpathSync(worktreePath);
  } catch {
    // If realpath fails (e.g. mock or not yet created), use worktreePath as is.
  }
  return [
    bwrapPath,
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--bind",
    bindPath,
    bindPath,
    "--chdir",
    bindPath,
    "--unshare-all",
    "--die-with-parent",
    "--",
    ...argv,
  ];
}
