import { type ChildProcess, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { darwinProcInfo, type ProcInfo, type StartTimeProbe, unsupportedProcInfo } from "../exec/index.js";
import { inspectOrphan } from "./process.js";

/**
 * T4.9: the orphan identity rules over every process-table answer, on injected tables, so the macOS (`ps`) and
 * unsupported-platform paths run on Linux CI. A real detached child provides a live process group for `kill(-pgid, 0)`;
 * nothing here is ever signalled except that child at the end.
 */

let child: ChildProcess;
let livePgid: number;
let deadPgid: number;

beforeAll(async () => {
  const gone = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
  deadPgid = gone.pid as number;
  await new Promise((r) => gone.on("exit", r));
  child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  livePgid = child.pid as number;
});

afterAll(() => {
  try {
    process.kill(-livePgid, "SIGKILL");
  } catch {}
});

function fakeInfo(probe: StartTimeProbe, live: boolean | undefined): ProcInfo {
  return { mechanism: "linux-proc", startTime: () => probe, liveGroupMember: () => live };
}

const rec = (pgid: number, ticks: number | null) => ({ pid: pgid, pgid, proc_start_ticks: ticks });

describe("inspectOrphan over the platform port", () => {
  it("matching start time and a live group: our orphan", () => {
    expect(inspectOrphan(rec(livePgid, 77), fakeInfo({ kind: "present", start: 77 }, true))).toEqual({
      kind: "alive",
      pgid: livePgid,
      leaderAlive: true,
    });
  });

  it("different start time: PID reused, never signalled", () => {
    expect(inspectOrphan(rec(livePgid, 77), fakeInfo({ kind: "present", start: 78 }, true))).toEqual({
      kind: "pid_reused",
      pgid: livePgid,
      recordedTicks: 77,
      actualTicks: 78,
    });
  });

  it("no recorded start time: unverifiable", () => {
    expect(inspectOrphan(rec(livePgid, null), fakeInfo({ kind: "present", start: 78 }, true)).kind).toBe(
      "unverifiable",
    );
  });

  it("leader gone but the group lives: our orphan (POSIX: a new PID never matches an active group ID)", () => {
    expect(inspectOrphan(rec(livePgid, 77), fakeInfo({ kind: "absent" }, true))).toEqual({
      kind: "alive",
      pgid: livePgid,
      leaderAlive: false,
    });
  });

  it("leader presence unknown and the group answers kill(-pgid, 0): unverifiable, never signalled", () => {
    expect(inspectOrphan(rec(livePgid, 77), fakeInfo({ kind: "unknown" }, undefined)).kind).toBe("unverifiable");
    expect(inspectOrphan(rec(livePgid, 77), fakeInfo({ kind: "unknown" }, true)).kind).toBe("unverifiable");
  });

  it("leader presence unknown and no such group: nothing to do", () => {
    expect(inspectOrphan(rec(deadPgid, 77), fakeInfo({ kind: "unknown" }, undefined))).toEqual({ kind: "none" });
  });

  it("an unsupported platform never yields a signallable orphan", () => {
    expect(inspectOrphan(rec(livePgid, 77), unsupportedProcInfo()).kind).toBe("unverifiable");
    expect(inspectOrphan(rec(deadPgid, 77), unsupportedProcInfo())).toEqual({ kind: "none" });
  });

  describe("macOS (BSD ps fixture; Unverified on a real Mac until T4.10)", () => {
    const lstart = "Tue Oct 13 10:00:00 2026";
    const epoch = Date.UTC(2026, 9, 13, 10, 0, 0) / 1000;
    const table = () =>
      [
        `${livePgid} 1 ${livePgid} Ss ${lstart}`,
        `${livePgid + 1} ${livePgid} ${livePgid} S ${lstart}`, // grandchild in the same group
      ].join("\n");

    it("matching lstart: our orphan", () => {
      const info = darwinProcInfo({ runPs: table, processExists: () => true });
      expect(inspectOrphan(rec(livePgid, epoch), info)).toEqual({ kind: "alive", pgid: livePgid, leaderAlive: true });
    });

    it("different lstart: PID reused", () => {
      const info = darwinProcInfo({ runPs: table, processExists: () => true });
      expect(inspectOrphan(rec(livePgid, epoch - 3600), info).kind).toBe("pid_reused");
    });

    it("ps fails or prints garbage: unverifiable (fail closed)", () => {
      for (const runPs of [() => undefined, () => "garbage"]) {
        const info = darwinProcInfo({ runPs, processExists: () => true });
        expect(inspectOrphan(rec(livePgid, epoch), info).kind).toBe("unverifiable");
      }
    });
  });
});
