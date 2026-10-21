import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURSOR_USAGE_METHOD,
  type CursorUsageReport,
  dollars,
  parseCursorUsageScreen,
  ptyArgv,
  readCursorUsage,
  resetFromLabel,
  type UsageChild,
  usageEnv,
} from "./usage.js";

const NOW = new Date("2026-10-21T02:43:17.000Z");
/** Recorded 2026-10-21 on Ampere (cursor-agent 2026.10.19-6bbf2c4, Pro plan); only the scratch path is redacted. */
const RECORDED = readFileSync(join(import.meta.dirname, "fixtures", "usage_pro_exhausted.pty.txt"), "utf8");

/**
 * Synthetic panels for the cases the operator's account does not show, built from the renderer's strings in the
 * CLI bundle (`src/usage/usage-pager.tsx`, 2026.10.19-6bbf2c4): the on-demand `fixed` and `unlimited` rows and the
 * Enterprise spend view.
 */
const panel = (rows: string[], header = " Usage • Pro+                                     Resets Jan 3") =>
  [
    "Loading usage data...",
    "─".repeat(40),
    header,
    " Monthly plan and on-demand usage",
    "",
    ...rows,
    "",
    " Esc to close",
  ].join("\r\n");

const report = (raw: string): CursorUsageReport => {
  const r = parseCursorUsageScreen(raw, NOW);
  if (r === null || r.source !== "provider_reported") throw new Error(`not a report: ${JSON.stringify(r)}`);
  return r;
};

describe("parseCursorUsageScreen (recorded capture)", () => {
  it("reads plan, the three included shares, the reset and the on-demand state", () => {
    const r = report(RECORDED);
    expect(r).toEqual({
      provider: "cursor",
      source: "provider_reported",
      observed_at: NOW.toISOString(),
      method: CURSOR_USAGE_METHOD,
      plan: "Pro",
      limit_reached: true,
      limit_reached_type: null,
      windows: [
        {
          id: "included",
          limit_id: null,
          window_seconds: null,
          used_fraction: 1,
          remaining_fraction: 0,
          resets_at: "2026-11-05T00:00:00.000Z",
        },
        {
          id: "included:auto",
          limit_id: null,
          window_seconds: null,
          used_fraction: 1,
          remaining_fraction: 0,
          resets_at: "2026-11-05T00:00:00.000Z",
        },
        {
          id: "included:api",
          limit_id: null,
          window_seconds: null,
          used_fraction: 1,
          remaining_fraction: 0,
          resets_at: "2026-11-05T00:00:00.000Z",
        },
      ],
      credits: null,
      reset_label: "Resets Nov 5",
      reset_precision: "day",
      on_demand: {
        state: "disabled",
        used_usd: 0,
        limit_usd: null,
        remaining_usd: null,
        detail: "On-demand usage is off",
      },
      spend: null,
    });
  });

  it("never carries the raw screen", () => {
    expect(JSON.stringify(report(RECORDED))).not.toMatch(/sb-cursor-usage|Category|█/);
  });
});

describe("parseCursorUsageScreen (synthetic panels)", () => {
  it("fixed on-demand limit with remaining dollars; included below 100% is not a reached limit", () => {
    const r = report(
      panel([
        " Category        Current             Usage",
        " Included        42% used            ████░░░░",
        "   Auto          30% used            ███░░░░░",
        "   API           12% used            █░░░░░░░",
        " On-Demand       $12.50 / $50        ██░░░░░░",
        "",
        " $37.50 remaining",
      ]),
    );
    expect(r.plan).toBe("Pro+");
    expect(r.windows.map((w) => [w.id, w.used_fraction, w.remaining_fraction])).toEqual([
      ["included", 0.42, 0.58],
      ["included:auto", 0.3, 0.7],
      ["included:api", 0.12, 0.88],
    ]);
    expect(r.on_demand).toEqual({
      state: "fixed",
      used_usd: 12.5,
      limit_usd: 50,
      remaining_usd: 37.5,
      detail: "$37.50 remaining",
    });
    expect(r.limit_reached).toBe(false);
    expect(r.windows[0]?.resets_at).toBe("2027-01-03T00:00:00.000Z");
  });

  it("included spent but a fixed on-demand budget left is not a reached limit; a spent one is", () => {
    const rows = (used: string, rest: string) => [
      " Included        100% used           ████████",
      `   On-Demand     ${used}        ████████`,
      "",
      ` ${rest} remaining`,
    ];
    expect(report(panel(rows("$10 / $50", "$40"))).limit_reached).toBe(false);
    expect(report(panel(rows("$50 / $50", "$0"))).limit_reached).toBe(true);
  });

  it("unlimited on-demand: dollars used, no limit, never a reached limit", () => {
    const r = report(
      panel([
        " Included        100% used           ████",
        " On-Demand       $1,204.10           ————",
        "",
        " No monthly limit",
      ]),
    );
    expect(r.on_demand).toEqual({
      state: "unlimited",
      used_usd: 1204.1,
      limit_usd: null,
      remaining_usd: null,
      detail: "No monthly limit",
    });
    expect(r.limit_reached).toBe(false);
  });

  it("unavailable on-demand limit leaves limit_reached unknown when included is spent", () => {
    const r = report(
      panel([
        " Included        100% used           ████",
        " On-Demand       Unavailable         ————",
        "",
        " On-demand limit unavailable",
      ]),
    );
    expect(r.on_demand?.state).toBe("unavailable");
    expect(r.on_demand?.used_usd).toBeNull();
    expect(r.limit_reached).toBeNull();
  });

  it("1% and 0% shares; compact layout rows", () => {
    const r = report(
      panel([
        " Included: 1% used",
        " Auto: 0% used",
        " API: 1% used",
        " On-Demand: Disabled",
        "",
        " On-demand usage is off",
      ]),
    );
    expect(r.windows.map((w) => w.used_fraction)).toEqual([0.01, 0, 0.01]);
    expect(r.on_demand?.state).toBe("disabled");
  });

  it("Current period label: no reset time", () => {
    const r = report(panel([" Included        5% used    █"], " Usage • Pro                    Current period"));
    expect(r.reset_label).toBe("Current period");
    expect(r.windows[0]?.resets_at).toBeNull();
    expect(r.reset_precision).toBeNull();
  });

  it("Enterprise spend view: dollars this and last period, no percentages", () => {
    const raw = [
      " Usage • Enterprise                                Resets Nov 1",
      " Personal spend for the current billing period",
      "",
      " Current cycle     $312.40",
      " ▁▂▃▄▅",
      "",
      " Previous period   $280",
      " ▁▂▃▄▅",
      "",
      " Esc to close",
    ].join("\n");
    const r = report(raw);
    expect(r.plan).toBe("Enterprise");
    expect(r.windows).toEqual([]);
    expect(r.spend).toEqual({ current_cycle_usd: 312.4, previous_period_usd: 280 });
    expect(r.limit_reached).toBeNull();
  });

  it("reads the last frame when the panel was redrawn", () => {
    const first = panel([" Included        10% used    █"]);
    const second = panel([" Included        11% used    █"]);
    expect(report(`${first}\r\n${second}`).windows[0]?.used_fraction).toBe(0.11);
  });
});

describe("parseCursorUsageScreen (no figures)", () => {
  it.each([
    ["Usage details are not available for this plan in the CLI."],
    ["Not logged in. Run /login first."],
    ["Failed to load usage data: deadline exceeded"],
  ])("the CLI's own message %s is unknown with that reason", (msg) => {
    const r = parseCursorUsageScreen(
      `Loading usage data...\r\n  ${msg}\r\n View usage settings at https://cursor.com/dashboard?tab=usage`,
      NOW,
    );
    expect(r).toMatchObject({ provider: "cursor", source: "unknown", error: msg });
  });

  it("nothing recognisable is null", () => {
    expect(parseCursorUsageScreen("Cursor Agent\r\n  Ask (shift+tab to cycle)", NOW)).toBeNull();
    expect(parseCursorUsageScreen(panel([" Category        Current             Usage"]), NOW)).toBeNull();
  });
});

describe("helpers", () => {
  it("resetFromLabel picks the next occurrence in UTC, today included", () => {
    expect(resetFromLabel("Resets Nov 5", NOW)).toBe("2026-11-05T00:00:00.000Z");
    expect(resetFromLabel("Resets Oct 21", NOW)).toBe("2026-10-21T00:00:00.000Z");
    expect(resetFromLabel("Resets Oct 20", NOW)).toBe("2027-10-20T00:00:00.000Z");
    expect(resetFromLabel("Resets Feb 29", NOW)).toBeNull();
    expect(resetFromLabel("Current period", NOW)).toBeNull();
    expect(resetFromLabel("Resets Foo 5", NOW)).toBeNull();
  });

  it("dollars", () => {
    expect(dollars("$1,234.56")).toBe(1234.56);
    expect(dollars("$20")).toBe(20);
    expect(dollars("Disabled")).toBeNull();
    expect(dollars(undefined)).toBeNull();
  });

  it("ptyArgv quotes the binary and forces the terminal size; no bypass flag", () => {
    const linux = ptyArgv("/opt/it's/cursor-agent", [], "linux");
    expect(linux.slice(0, 2)).toEqual(["script", "-qfec"]);
    expect(linux[2]).toBe(
      "stty cols 160 rows 50 2>/dev/null; exec '/opt/it'\\''s/cursor-agent' '--mode' 'ask' '--trust'",
    );
    expect(linux[3]).toBe("/dev/null");
    expect(ptyArgv("/x/cursor-agent", ["--a"], "darwin").slice(0, 5)).toEqual([
      "script",
      "-q",
      "/dev/null",
      "sh",
      "-c",
    ]);
    for (const a of [...linux, ...ptyArgv("/x", [], "darwin")]) {
      expect(a).not.toMatch(/--force|--yolo|--approve-mcps|--print|-f\b/);
    }
  });
});

/** A scripted child: emits frames in response to what is written, as the CLI does. */
function fakeChild(script: { onStart: string; onSlash?: string; onEnter?: string; exitOnEnter?: boolean }) {
  const writes: string[] = [];
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  let data: ((d: string) => void) | undefined;
  const emit = (ev: string, arg?: unknown) => {
    for (const h of handlers[ev] ?? []) h(arg);
  };
  const child: UsageChild & { writes: string[]; killed: string[] } = {
    writes,
    killed: [],
    stdin: {
      write(s: string) {
        writes.push(s);
        if (s === "/usage" && script.onSlash !== undefined) setTimeout(() => data?.(script.onSlash as string), 5);
        if (s === "\r") {
          if (script.exitOnEnter) setTimeout(() => emit("exit", 0), 5);
          else if (script.onEnter !== undefined) setTimeout(() => data?.(script.onEnter as string), 5);
        }
        return true;
      },
      end() {
        return undefined;
      },
    },
    stdout: {
      on(_ev: "data", cb: (d: Buffer | string) => void) {
        data = cb;
        setTimeout(() => cb(script.onStart), 5);
      },
    },
    on(ev, cb) {
      handlers[ev] = [...(handlers[ev] ?? []), cb];
    },
    kill(signal) {
      child.killed.push(String(signal));
      return true;
    },
  };
  return child;
}

describe("readCursorUsage", () => {
  const scratch = () => ({ path: "/tmp/none", cleanup: () => undefined });
  const START = "Cursor Agent\r\n  \x1b[32mAsk (shift+tab to cycle)\x1b[39m\r\n";
  const MENU = "\r\n   → \x1b[1m/usage\x1b[22m\r\n";

  it("types /usage, presses Enter only once the menu selects it, then parses and quits", async () => {
    const child = fakeChild({
      onStart: START,
      onSlash: MENU,
      onEnter: RECORDED.slice(RECORDED.lastIndexOf("Loading usage data")),
    });
    let argv: readonly string[] = [];
    const r = await readCursorUsage({
      exe: "/x/cursor-agent",
      now: () => NOW,
      platform: "linux",
      scratchDir: scratch,
      spawnChild: (a) => {
        argv = a;
        return child;
      },
    });
    expect(argv[0]).toBe("script");
    expect(r.source).toBe("provider_reported");
    expect((r as CursorUsageReport).plan).toBe("Pro");
    expect(child.writes.slice(0, 2)).toEqual(["/usage", "\r"]);
    // Escape, then Ctrl-C twice to quit.
    expect(child.writes.slice(2)).toEqual(["\x1b", "\x03", "\x03"]);
  });

  it("never presses Enter when the menu does not offer /usage; times out as unknown", async () => {
    const child = fakeChild({ onStart: START, onSlash: "\r\n  /usage-something-else\r\n" });
    const r = await readCursorUsage({
      exe: "/x/cursor-agent",
      now: () => NOW,
      timeoutMs: 200,
      scratchDir: scratch,
      spawnChild: () => child,
    });
    expect(r).toMatchObject({ source: "unknown" });
    expect(child.writes).not.toContain("\r");
  });

  it("an exit before the panel is unknown", async () => {
    const child = fakeChild({ onStart: START, onSlash: MENU, exitOnEnter: true });
    const r = await readCursorUsage({
      exe: "/x/cursor-agent",
      now: () => NOW,
      scratchDir: scratch,
      spawnChild: () => child,
    });
    expect(r).toMatchObject({ source: "unknown", error: expect.stringContaining("exited before the usage panel") });
  });

  it("no binary is unknown without spawning", async () => {
    const r = await readCursorUsage({
      exe: undefined,
      now: () => NOW,
      spawnChild: () => {
        throw new Error("must not spawn");
      },
    });
    expect(r).toEqual({
      provider: "cursor",
      source: "unknown",
      observed_at: NOW.toISOString(),
      method: CURSOR_USAGE_METHOD,
      error: "cursor-agent not found on PATH",
    });
  });
});

describe("usageScratchDir", () => {
  it("creates one 0700 directory per user and reuses it; refuses a symbolic link", async () => {
    const { mkdtempSync, statSync, symlinkSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { usageScratchDir } = await import("./usage.js");
    const base = mkdtempSync(join(tmpdir(), "sb-usage-scratch-test-"));
    try {
      const uid = process.getuid?.();
      const a = usageScratchDir(base, uid);
      const b = usageScratchDir(base, uid);
      expect(a.path).toBe(b.path);
      expect(statSync(a.path).mode & 0o777).toBe(0o700);
      symlinkSync(base, join(base, `switchboard-cursor-usage-${(uid ?? 0) + 1}`));
      expect(() => usageScratchDir(base, (uid ?? 0) + 1)).toThrow(/refusing/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("usageEnv", () => {
  it("passes only the allowlist plus terminal and locale", () => {
    expect(usageEnv({ PATH: "/bin", HOME: "/h", CURSOR_API_KEY: "x", SECRET: "y", USER: "u" })).toEqual({
      PATH: "/bin",
      HOME: "/h",
      USER: "u",
      TERM: "xterm-256color",
      NO_COLOR: "1",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    });
  });
});
