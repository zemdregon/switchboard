import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Platform port for the two process-table questions the controller asks (LLD §8.2, ROADMAP T4.9):
 *
 * - the start time of a PID, recorded at spawn and compared at reconciliation to tell a live orphan from a reused PID
 *   (FR-EXE-06, NFR-REL-01); and
 * - whether a process group still has a live (non-zombie) member, which the cancel sequence polls (FR-EXE-01).
 *
 * Mechanisms:
 * - **Linux** (`linux-proc`): `/proc/<pid>/stat` field 22 (start time in clock ticks) and a scan of `/proc/<pid>/stat`
 *   for `pgrp` and `state`. This is the M1 behaviour, unchanged.
 * - **macOS** (`darwin-ps`, Unverified until T4.10): one run of BSD `/bin/ps -A` with fixed `-o` columns `pid`,
 *   `ppid`, `pgid`, `state` and `lstart`, in the environment `LC_ALL=C`, `TZ=UTC` only, so `lstart` (strftime `%c`)
 *   prints in the POSIX locale form `%a %b %e %H:%M:%S %Y` in UTC. The start time is stored as UTC epoch seconds.
 *   Any failure, timeout or unparseable row makes the whole answer "cannot tell".
 * - **Anything else** (`unsupported`, including Windows): never verifies a process.
 *
 * Fail closed: an answer of `unknown` (start time) or `undefined` (group) means "cannot verify". Callers never signal
 * a PID whose identity they cannot verify, and treat a group they cannot inspect as still alive.
 */

export type ProcMechanism = "linux-proc" | "darwin-ps" | "unsupported";

export type StartTimeProbe =
  | { readonly kind: "present"; readonly start: number }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

export interface ProcInfo {
  readonly mechanism: ProcMechanism;
  /** Start time of `pid` in a platform-specific unit (Linux: clock ticks since boot; macOS: UTC epoch seconds). */
  startTime(pid: number): StartTimeProbe;
  /** True/false whether group `pgid` has a non-zombie member; undefined when the table cannot be read. */
  liveGroupMember(pgid: number): boolean | undefined;
}

/** File-system reads the Linux implementation needs; injectable so tests run on fixtures. */
export interface ProcFs {
  readdir(dir: string): string[];
  readFile(file: string): string;
}

const nodeProcFs: ProcFs = {
  readdir: (dir) => readdirSync(dir),
  readFile: (file) => readFileSync(file, "utf8"),
};

/** Fields after the parenthesised comm (`state`, `ppid`, `pgrp`, ...); keyed on the last `)` as comm may hold one. */
function statFields(stat: string): string[] {
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

export function linuxProcInfo(fs: ProcFs = nodeProcFs): ProcInfo {
  return {
    mechanism: "linux-proc",
    startTime(pid) {
      // M1 behaviour: any read failure means the PID is gone (with /proc mounted, a live PID always has a stat file).
      try {
        const ticks = Number(statFields(fs.readFile(`/proc/${pid}/stat`))[19]);
        return Number.isFinite(ticks) ? { kind: "present", start: ticks } : { kind: "absent" };
      } catch {
        return { kind: "absent" };
      }
    },
    liveGroupMember(pgid) {
      // Zombies (killed but not yet reaped by init, which can take seconds in containers) cannot run code.
      try {
        for (const entry of fs.readdir("/proc")) {
          if (!/^\d+$/.test(entry)) continue;
          let stat: string;
          try {
            stat = fs.readFile(`/proc/${entry}/stat`);
          } catch {
            continue; // exited while scanning
          }
          const rest = statFields(stat);
          if (Number(rest[2]) === pgid && rest[0] !== "Z" && rest[0] !== "X") return true;
        }
        return false;
      } catch {
        return undefined;
      }
    },
  };
}

/** Absolute path, so `PATH` cannot substitute another `ps` (Assumption: the macOS base system path; T4.10). */
export const DARWIN_PS_PATH = "/bin/ps";
/** Fixed columns, one `-o` each with an empty header so no header line is printed (macOS ps(1), `-o`). */
export const DARWIN_PS_ARGS: readonly string[] = [
  "-A",
  "-o",
  "pid=",
  "-o",
  "ppid=",
  "-o",
  "pgid=",
  "-o",
  "state=",
  "-o",
  "lstart=",
];
/** The whole child environment: the POSIX locale for `%c` and UTC so the start time is unambiguous. */
export const DARWIN_PS_ENV: Readonly<Record<string, string>> = { LC_ALL: "C", TZ: "UTC" };
/** Proposed bounds for one `ps` run. */
const DARWIN_PS_TIMEOUT_MS = 5_000;
const DARWIN_PS_MAX_BYTES = 16 * 1024 * 1024;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** `%e` pads a one-digit day with a space; column padding may add more, so fields are split on any run of blanks. */
const LSTART_RE = /^([A-Z][a-z]{2}) +([A-Z][a-z]{2}) +(\d{1,2}) +(\d{2}):(\d{2}):(\d{2}) +(\d{4})$/;

/** Parse `lstart` printed as POSIX-locale `%c` (`%a %b %e %H:%M:%S %Y`) in UTC; epoch seconds, or undefined. */
export function parseLstartUtc(text: string): number | undefined {
  const m = LSTART_RE.exec(text);
  if (!m) return undefined;
  const [day, mon, ...nums] = m.slice(1) as string[];
  const month = MONTHS.indexOf(mon as string);
  const [date, hour, minute, second, year] = nums.map(Number) as [number, number, number, number, number];
  if (!DAYS.includes(day as string) || month < 0 || date < 1 || date > 31 || hour > 23 || minute > 59 || second > 60) {
    return undefined;
  }
  const ms = Date.UTC(year, month, date, hour, minute, second);
  const check = new Date(ms);
  if (check.getUTCDate() !== date || check.getUTCMonth() !== month) return undefined; // e.g. Feb 30
  return ms / 1000;
}

export interface DarwinPsRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly state: string;
  readonly start: number;
}

const PS_ROW_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/;

/** Parse the whole `ps` table; undefined if it is empty or any non-blank line does not match the column contract. */
export function parseDarwinPsTable(text: string): DarwinPsRow[] | undefined {
  const rows: DarwinPsRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const m = PS_ROW_RE.exec(line);
    if (!m) return undefined;
    const [pid, ppid, pgid] = [m[1], m[2], m[3]].map(Number) as [number, number, number];
    const start = parseLstartUtc(m[5] as string);
    if (start === undefined) return undefined; // PID 0 is allowed: the kernel may be listed
    rows.push({ pid, ppid, pgid, state: m[4] as string, start });
  }
  return rows.length > 0 ? rows : undefined;
}

function runDarwinPs(): string | undefined {
  try {
    return execFileSync(DARWIN_PS_PATH, [...DARWIN_PS_ARGS], {
      env: { ...DARWIN_PS_ENV },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: DARWIN_PS_TIMEOUT_MS,
      maxBuffer: DARWIN_PS_MAX_BYTES,
      killSignal: "SIGKILL",
    });
  } catch {
    return undefined; // missing binary, non-zero exit, timeout or oversize output
  }
}

/** `kill(pid, 0)`: true when the PID exists (EPERM included), false only on ESRCH-like failure. */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface DarwinProcDeps {
  /** Run `ps` and return its stdout, or undefined on any failure. */
  readonly runPs?: () => string | undefined;
  /** Whether `pid` exists (`kill(pid, 0)`). */
  readonly processExists?: (pid: number) => boolean;
}

export function darwinProcInfo(deps: DarwinProcDeps = {}): ProcInfo {
  const runPs = deps.runPs ?? runDarwinPs;
  const processExists = deps.processExists ?? pidExists;
  const table = (): DarwinPsRow[] | undefined => {
    const out = runPs();
    return out === undefined ? undefined : parseDarwinPsTable(out);
  };
  return {
    mechanism: "darwin-ps",
    startTime(pid) {
      const rows = table();
      if (rows === undefined) return { kind: "unknown" };
      const row = rows.find((r) => r.pid === pid);
      if (row !== undefined) return { kind: "present", start: row.start };
      // Absent only if the kernel agrees; a live PID that ps did not list cannot be verified.
      return processExists(pid) ? { kind: "unknown" } : { kind: "absent" };
    },
    liveGroupMember(pgid) {
      const rows = table();
      if (rows === undefined) return undefined;
      return rows.some((r) => r.pgid === pgid && !r.state.startsWith("Z"));
    },
  };
}

export function unsupportedProcInfo(): ProcInfo {
  return {
    mechanism: "unsupported",
    startTime: () => ({ kind: "unknown" }),
    liveGroupMember: () => undefined,
  };
}

/** The implementation for `platform` (a `process.platform` value). */
export function procInfoFor(platform: string): ProcInfo {
  if (platform === "linux") return linuxProcInfo();
  if (platform === "darwin") return darwinProcInfo();
  return unsupportedProcInfo();
}

/** The implementation for the running host. */
export const hostProcInfo: ProcInfo = procInfoFor(process.platform);

/**
 * Start time of `pid` for the ledger's `proc_start_ticks` column, or null when absent or unverifiable (LLD §8.2).
 * Linux: clock ticks since boot; macOS: UTC epoch seconds. Only ever compared for equality on the same host.
 */
export function procStartTicks(pid: number, info: ProcInfo = hostProcInfo): number | null {
  const probe = info.startTime(pid);
  return probe.kind === "present" ? probe.start : null;
}
