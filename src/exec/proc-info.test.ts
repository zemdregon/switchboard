import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  DARWIN_PS_ARGS,
  DARWIN_PS_ENV,
  DARWIN_PS_PATH,
  darwinProcInfo,
  linuxProcInfo,
  type ProcFs,
  parseDarwinPsTable,
  parseLstartUtc,
  procInfoFor,
  unsupportedProcInfo,
} from "./proc-info.js";
import { groupAlive } from "./supervisor.js";

/** A fake /proc: `stat` lines keyed by PID (comm may hold spaces and parentheses, as on a real kernel). */
function fakeProc(stats: Record<number, string>, opts: { unreadableRoot?: boolean } = {}): ProcFs {
  return {
    readdir(dir: string): string[] {
      if (dir !== "/proc" || opts.unreadableRoot) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return [...Object.keys(stats), "self", "sys"];
    },
    readFile(file: string): string {
      const m = /^\/proc\/(\d+)\/stat$/.exec(file);
      const line = m ? stats[Number(m[1])] : undefined;
      if (line === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return line;
    },
  };
}

/** /proc/<pid>/stat with `state`, `ppid`, `pgrp` and field 22 `starttime`; the other fields are filler. */
function stat(pid: number, comm: string, state: string, ppid: number, pgrp: number, startTicks: number): string {
  // Fields 3.. after "(comm) ": state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime
  // cutime cstime priority nice num_threads itrealvalue starttime ...
  const rest = [state, ppid, pgrp, pgrp, 0, -1, 4194560, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, startTicks, 0, 0];
  return `${pid} (${comm}) ${rest.join(" ")}\n`;
}

describe("linuxProcInfo (/proc, existing behaviour)", () => {
  const proc = fakeProc({
    100: stat(100, "node", "S", 1, 100, 5000),
    101: stat(101, "sh) (x", "S", 100, 100, 5001), // hostile comm: parsing keys on the last ')'
    102: stat(102, "sleep", "Z", 101, 100, 5002),
    200: stat(200, "other", "R", 1, 200, 9000),
  });
  const info = linuxProcInfo(proc);

  it("reads the start ticks (field 22) and ignores a hostile comm", () => {
    expect(info.mechanism).toBe("linux-proc");
    expect(info.startTime(100)).toEqual({ kind: "present", start: 5000 });
    expect(info.startTime(101)).toEqual({ kind: "present", start: 5001 });
  });

  it("reports a missing PID as absent, as procStartTicks always has", () => {
    expect(info.startTime(4242)).toEqual({ kind: "absent" });
  });

  it("finds grandchildren by process group and ignores zombies", () => {
    expect(info.liveGroupMember(100)).toBe(true); // leader and grandchild 101 are live
    expect(info.liveGroupMember(4242)).toBe(false);
    const onlyZombie = linuxProcInfo(fakeProc({ 102: stat(102, "sleep", "Z", 1, 300, 1) }));
    expect(onlyZombie.liveGroupMember(300)).toBe(false);
    const dead = linuxProcInfo(fakeProc({ 103: stat(103, "x", "X", 1, 300, 1) }));
    expect(dead.liveGroupMember(300)).toBe(false);
  });

  it("returns undefined (cannot tell) when /proc cannot be listed", () => {
    expect(linuxProcInfo(fakeProc({}, { unreadableRoot: true })).liveGroupMember(100)).toBeUndefined();
  });
});

const ROW = (pid: number, ppid: number, pgid: number, state: string, lstart: string) =>
  `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${String(pgid).padStart(5)} ${state.padEnd(4)} ${lstart}`;

/** A fake BSD `ps` table as `/bin/ps -A -o pid= -o ppid= -o pgid= -o state= -o lstart=` prints it under LC_ALL=C. */
const TABLE = [
  ROW(1, 0, 1, "Ss", "Mon Oct 12 08:00:00 2026"),
  ROW(4100, 1, 4100, "Ss", "Tue Oct 13 10:00:00 2026"), // provider leader (session leader)
  ROW(4101, 4100, 4100, "S", "Tue Oct 13 10:00:01 2026"), // child
  ROW(4102, 4101, 4100, "R+", "Tue Oct  6 09:05:07 2026"), // grandchild; %e pads a one-digit day with a space
  ROW(4200, 1, 4200, "Z", "Tue Oct 13 10:00:02 2026"), // zombie-only group
  "",
].join("\n");

describe("parseLstartUtc (strftime %c in the POSIX locale)", () => {
  it("parses '%a %b %e %H:%M:%S %Y' as UTC epoch seconds", () => {
    expect(parseLstartUtc("Tue Oct 13 10:00:00 2026")).toBe(Date.UTC(2026, 9, 13, 10, 0, 0) / 1000);
    expect(parseLstartUtc("Tue Oct  6 09:05:07 2026")).toBe(Date.UTC(2026, 9, 6, 9, 5, 7) / 1000);
  });

  it("rejects anything else", () => {
    for (const bad of [
      "",
      "Di Okt 13 10:00:00 2026", // non-C locale
      "Tue Oct 13 10:00 2026",
      "Tue Oct 32 10:00:00 2026",
      "Tue Foo 13 10:00:00 2026",
      "Tue Oct 13 24:00:00 2026",
      "2026-10-13T10:00:00Z",
      "Tue Feb 30 10:00:00 2026", // not a calendar date
    ]) {
      expect(parseLstartUtc(bad)).toBeUndefined();
    }
  });
});

describe("parseDarwinPsTable", () => {
  it("parses every row", () => {
    const rows = parseDarwinPsTable(TABLE);
    expect(rows).toHaveLength(5);
    expect(rows?.[3]).toEqual({
      pid: 4102,
      ppid: 4101,
      pgid: 4100,
      state: "R+",
      start: Date.UTC(2026, 9, 6, 9, 5, 7) / 1000,
    });
  });

  it("fails closed (undefined) on any unparseable row, a header line or empty output", () => {
    expect(parseDarwinPsTable("")).toBeUndefined();
    expect(parseDarwinPsTable(`  PID  PPID  PGID STAT STARTED\n${TABLE}`)).toBeUndefined();
    expect(parseDarwinPsTable(`${TABLE}garbage\n`)).toBeUndefined();
    expect(parseDarwinPsTable(TABLE.replace("Tue Oct 13 10:00:00 2026", "Di Okt 13 10:00:00 2026"))).toBeUndefined();
    expect(parseDarwinPsTable(`-1 0 0 S Tue Oct 13 10:00:00 2026\n`)).toBeUndefined();
    expect(parseDarwinPsTable(`${ROW(0, 0, 0, "Rs", "Tue Oct 13 10:00:00 2026")}\n`)).toHaveLength(1);
  });
});

describe("darwinProcInfo (BSD ps; Unverified on a real Mac until T4.10)", () => {
  const exists = new Set([1, 4100, 4101, 4102, 4200]);
  const info = darwinProcInfo({ runPs: () => TABLE, processExists: (pid) => exists.has(pid) });

  it("runs /bin/ps with fixed columns, the C locale and UTC", () => {
    expect(DARWIN_PS_PATH).toBe("/bin/ps");
    expect(DARWIN_PS_ARGS).toEqual(["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "state=", "-o", "lstart="]);
    expect(DARWIN_PS_ENV).toEqual({ LC_ALL: "C", TZ: "UTC" });
  });

  it("reads the start time of a listed process", () => {
    expect(info.mechanism).toBe("darwin-ps");
    expect(info.startTime(4100)).toEqual({ kind: "present", start: Date.UTC(2026, 9, 13, 10, 0, 0) / 1000 });
  });

  it("detects PID reuse: a different start time is a different process", () => {
    const recorded = Date.UTC(2026, 9, 13, 9, 0, 0) / 1000; // what the earlier controller stored
    const now = info.startTime(4100);
    expect(now.kind).toBe("present");
    expect(now.kind === "present" && now.start !== recorded).toBe(true);
  });

  it("is absent only when ps omits the PID and kill(pid, 0) agrees", () => {
    expect(info.startTime(4999)).toEqual({ kind: "absent" });
    const hidden = darwinProcInfo({ runPs: () => TABLE, processExists: () => true });
    expect(hidden.startTime(4999)).toEqual({ kind: "unknown" }); // ps did not list a live PID: cannot verify
  });

  it("finds child and grandchild by process group and ignores zombies", () => {
    expect(info.liveGroupMember(4100)).toBe(true);
    expect(info.liveGroupMember(4200)).toBe(false);
    expect(info.liveGroupMember(4999)).toBe(false);
  });

  it("fails closed when ps fails or prints something unparseable", () => {
    for (const runPs of [() => undefined, () => "", () => "ps: illegal option -- o\n", () => `${TABLE}\nnot a row`]) {
      const broken = darwinProcInfo({ runPs, processExists: () => false });
      expect(broken.startTime(4100)).toEqual({ kind: "unknown" });
      expect(broken.liveGroupMember(4100)).toBeUndefined();
    }
  });
});

describe("procInfoFor (platform selection)", () => {
  it("picks /proc on Linux, BSD ps on macOS and fails closed elsewhere", () => {
    expect(procInfoFor("linux").mechanism).toBe("linux-proc");
    expect(procInfoFor("darwin").mechanism).toBe("darwin-ps");
    for (const p of ["win32", "freebsd", "openbsd", "sunos", "aix", "android"]) {
      expect(procInfoFor(p).mechanism).toBe("unsupported");
    }
  });

  it("an unsupported platform can never verify a process", () => {
    const info = unsupportedProcInfo();
    expect(info.startTime(1)).toEqual({ kind: "unknown" });
    expect(info.liveGroupMember(1)).toBeUndefined();
  });
});

describe("groupAlive over the platform port (cancel and timeout polling)", () => {
  it("treats a group whose table cannot be read as alive, and trusts the table otherwise", () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const pgid = child.pid as number;
    try {
      const table = (live: boolean | undefined) => ({ ...unsupportedProcInfo(), liveGroupMember: () => live });
      expect(groupAlive(pgid, unsupportedProcInfo())).toBe(true); // cannot tell: keep waiting, then escalate
      expect(groupAlive(pgid, table(false))).toBe(false); // only zombies left
      expect(groupAlive(pgid, table(true))).toBe(true);
    } finally {
      process.kill(-pgid, "SIGKILL");
    }
    const exited = darwinProcInfo({ runPs: () => TABLE, processExists: () => false });
    expect(groupAlive(pgid + 1_000_000, exited)).toBe(false); // kill(-pgid, 0) ESRCH wins over any table
  });
});
