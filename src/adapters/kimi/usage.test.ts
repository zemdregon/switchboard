/**
 * Kimi Code provider-reported plan usage (FR-CAP-13, ADR-0079, BR-50): the `/usage` panel parser on the recorded
 * 2.1.1 capture and synthetic panels, the stable probe directory checks, and the TUI driver against a SYNTHETIC fake
 * TUI run through the real `script` (including the folder trust dialog).
 * No `kimi` is ever run: every executable here is the fake, and the reader is always given it explicitly.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOnPath } from "../codex/adapter.js";
import {
  createTerminalRunner,
  type SpawnImpl,
  scriptArgs,
  TERMINAL_PROBE_DIR_NOT_EMPTY,
  TERMINAL_PROBE_DIR_UNSAFE,
} from "../terminal-run.js";
import type { ProbeRunner } from "../types.js";
import { KimiAdapter } from "./adapter.js";
import {
  KIMI_USAGE_METHOD,
  kimiUsageEnv,
  kimiUsageReport,
  parseKimiUsagePanel,
  REASON_NO_TERMINAL,
  REASON_NOT_LOGGED_IN,
  REASON_NOT_READY,
  REASON_TRUST_REFUSED,
  readKimiUsage,
  stripTerminal,
} from "./usage.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/usage-tui-2.1.1.raw", import.meta.url));
const FAKE_TUI = fileURLToPath(new URL("./fixtures/fake-kimi-usage-tui.mjs", import.meta.url));
const NOW = new Date("2026-10-21T10:00:00.000Z");
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000).toISOString();

/** A synthetic panel in the renderer's layout (side borders, bottom border, ANSI colour on the heading). */
function panel_(...body: string[]): string {
  const rows = ["Session usage", "  No token usage recorded yet.", "", ...body];
  return [
    "   ╭ Usage ──────────────╮",
    ...rows.map((r) => `   │ ${r.replace("Plan usage", "\u001b[1mPlan usage\u001b[22m").padEnd(70)} │`),
    "   ╰─────────────────────╯",
    "",
  ].join("\r\r\n");
}

describe("stripTerminal", () => {
  it("removes CSI, OSC and other escapes, splits on CR and LF and trims the side borders", () => {
    const raw =
      "\u001b[?2026h\u001b]8;;http://x\u0007a\u001b(B\r │ \u001b[38;2;1;2;3mPlan usage\u001b[0m │\r\nb\u001b\\";
    expect(stripTerminal(raw)).toEqual(["a", "Plan usage", "", "b"]);
  });
});

describe("parseKimiUsagePanel on the recorded 2.1.1 capture", () => {
  it("reads the 5h and monthly windows, the breakdown and the reset hints", () => {
    const p = parseKimiUsagePanel(readFileSync(FIXTURE, "utf8"), NOW);
    expect(p).toEqual({
      kind: "ok",
      balances: [],
      windows: [
        {
          id: "5h",
          label: "5h limit",
          used_fraction: 0,
          remaining_fraction: 1,
          precision: 0.01,
          reset_at: at(59 * 60),
          reset_precision_seconds: 60,
        },
        {
          id: "monthly",
          label: "Monthly limit",
          used_fraction: 0.25,
          remaining_fraction: 0.75,
          precision: 0.01,
          reset_at: at(22 * 86_400 + 21 * 3_600 + 22 * 60),
          reset_precision_seconds: 60,
          breakdown: { kimi: 0.05, code: 0.2 },
        },
      ],
    });
  });
});

describe("parseKimiUsagePanel on synthetic panels", () => {
  it("reads a weekly row, a past reset and a seconds-only reset", () => {
    const p = parseKimiUsagePanel(
      panel_(
        "Plan usage",
        "  5h limit       ████████████████████  100% used  reset",
        "  Weekly limit   ███░░░░░░░░░░░░░░░░░  13% used   resets in 45s",
        "  Monthly limit  ░░░░░░░░░░░░░░░░░░░░  0% used",
      ),
      NOW,
    );
    expect(p.kind).toBe("ok");
    if (p.kind !== "ok") return;
    expect(
      p.windows.map((w) => [w.id, w.used_fraction, w.remaining_fraction, w.reset_at, w.reset_precision_seconds]),
    ).toEqual([
      ["5h", 1, 0, NOW.toISOString(), 60],
      ["weekly", 0.13, 0.87, at(45), 1],
      ["monthly", 0, 1, null, null],
    ]);
    expect(p.windows[2]?.breakdown).toBeUndefined();
  });

  it("reads Extra Usage money rows in $, ¥, other currencies and Unlimited", () => {
    const usd = parseKimiUsagePanel(
      panel_(
        "Plan usage",
        "  5h limit       ░░░░░░░░░░░░░░░░░░░░  0% used   resets in 1h 2m",
        "",
        "Extra Usage",
        "  ████░░░░░░░░░░░░░░░░",
        "  Used this month  $1.23",
        "  Monthly limit    $10.00",
        "  Balance          $5.00",
      ),
      NOW,
    );
    expect(usd.kind === "ok" && usd.balances).toEqual([
      { id: "used_this_month", label: "Used this month", text: "$1.23", amount: 1.23, currency: "USD" },
      { id: "monthly_limit", label: "Monthly limit", text: "$10.00", amount: 10, currency: "USD" },
      { id: "balance", label: "Balance", text: "$5.00", amount: 5, currency: "USD" },
    ]);
    expect(usd.kind === "ok" && usd.windows.map((w) => w.id)).toEqual(["5h"]);
    const other = parseKimiUsagePanel(
      panel_(
        "Plan usage",
        "  5h limit  0% used",
        "",
        "Extra Usage",
        "  Used this month  ¥1,234.50",
        "  Monthly limit    Unlimited",
        "  Balance          7.00 EUR",
      ),
      NOW,
    );
    expect(other.kind === "ok" && other.balances).toEqual([
      { id: "used_this_month", label: "Used this month", text: "¥1,234.50", amount: 1234.5, currency: "CNY" },
      { id: "monthly_limit", label: "Monthly limit", text: "Unlimited", amount: null, currency: null, unlimited: true },
      { id: "balance", label: "Balance", text: "7.00 EUR", amount: 7, currency: "EUR" },
    ]);
  });

  it("returns a scrubbed, clipped error for the error form", () => {
    const p = parseKimiUsagePanel(
      panel_("Plan usage", "  Authorization failed. Please check your API key (try /login)."),
      NOW,
    );
    expect(p).toEqual({ kind: "error", reason: "Authorization failed. Please check your API key (try /login)." });
    const leaky = parseKimiUsagePanel(
      panel_(
        "Plan usage",
        `  Failed to fetch usage: GET https://api.example/usage?k=1 ${"x".repeat(200)}`,
        "  /home/someone/.kimi-code/credentials.json sk-abcdefghijklmnopqrstuvwxyz0123",
      ),
      NOW,
    );
    expect(leaky.kind).toBe("error");
    if (leaky.kind !== "error") return;
    expect(leaky.reason.length).toBeLessThanOrEqual(160);
    expect(leaky.reason).not.toMatch(/https|api\.example|credentials|abcdefghij/);
  });

  it("reads the empty form as no windows", () => {
    expect(parseKimiUsagePanel(panel_("Plan usage", "  No usage data available."), NOW)).toEqual({
      kind: "ok",
      windows: [],
      balances: [],
    });
  });

  it("tells not logged in from absent", () => {
    expect(parseKimiUsagePanel(' │ LLM not set, send "/login" to login │\r\n context: 0%', NOW)).toEqual({
      kind: "not_logged_in",
    });
    expect(parseKimiUsagePanel("OAuth login expired. Send /login to login.\r\n", NOW)).toEqual({
      kind: "not_logged_in",
    });
    expect(parseKimiUsagePanel(panel_("Context window", "  0%"), NOW)).toEqual({ kind: "absent" });
    expect(parseKimiUsagePanel("", NOW)).toEqual({ kind: "absent" });
  });

  it("uses the last complete panel when the TUI redraws", () => {
    const first = panel_("Plan usage", "  5h limit  10% used  resets in 5m");
    const second = panel_("Plan usage", "  5h limit  20% used  resets in 4m");
    const partial = "\r\n │ Plan usage │\r\n │   5h limit  9";
    const p = parseKimiUsagePanel(first + second + partial, NOW);
    expect(p.kind === "ok" && p.windows.map((w) => w.used_fraction)).toEqual([0.2]);
  });
});

const unreachable: SpawnImpl = (cmd) => {
  throw new Error(`must not spawn ${cmd}`);
};
const noProbe: ProbeRunner = async () => {
  throw new Error("the probe runner is not used");
};

/** A child that prints nothing until stopped; records what was written to its stdin. */
function silentChild(): {
  spawnImpl: SpawnImpl;
  typed: string[];
  seen: { args?: readonly string[]; opts?: SpawnOptions };
} {
  const typed: string[] = [];
  const seen: { args?: readonly string[]; opts?: SpawnOptions } = {};
  const spawnImpl: SpawnImpl = (_cmd, args, opts) => {
    seen.args = args;
    seen.opts = opts;
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    stdin.on("data", (d: Buffer) => typed.push(d.toString("utf8")));
    Object.assign(child, {
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
      kill: () => {
        setImmediate(() => child.emit("exit", null, "SIGTERM"));
        return true;
      },
    });
    return child;
  };
  return { spawnImpl, typed, seen };
}

describe("mapping to the shared provider usage shape (ADR-0079)", () => {
  it("maps the recorded panel: windows with lengths, the monthly breakdown as limit windows", () => {
    const panel = parseKimiUsagePanel(readFileSync(FIXTURE, "utf8"), NOW);
    if (panel.kind !== "ok") throw new Error(panel.kind);
    const monthlyReset = at(22 * 86_400 + 21 * 3_600 + 22 * 60);
    expect(kimiUsageReport(panel, NOW.toISOString())).toEqual({
      provider: "kimi",
      source: "provider_reported",
      observed_at: NOW.toISOString(),
      method: KIMI_USAGE_METHOD,
      plan: null,
      limit_reached: null,
      limit_reached_type: null,
      windows: [
        {
          id: "5h",
          limit_id: null,
          window_seconds: 18_000,
          used_fraction: 0,
          remaining_fraction: 1,
          resets_at: at(59 * 60),
        },
        {
          id: "monthly",
          limit_id: null,
          window_seconds: null,
          used_fraction: 0.25,
          remaining_fraction: 0.75,
          resets_at: monthlyReset,
        },
        {
          id: "kimi:monthly",
          limit_id: "kimi",
          window_seconds: null,
          used_fraction: 0.05,
          remaining_fraction: 0.95,
          resets_at: monthlyReset,
        },
        {
          id: "code:monthly",
          limit_id: "code",
          window_seconds: null,
          used_fraction: 0.2,
          remaining_fraction: 0.8,
          resets_at: monthlyReset,
        },
      ],
      credits: null,
    });
  });

  it("maps a weekly row and the Extra Usage wallet to credits", () => {
    const panel = parseKimiUsagePanel(
      panel_(
        "Plan usage",
        "  Weekly limit   ███░░░░░░░░░░░░░░░░░  13% used   resets in 2d",
        "",
        "Extra Usage",
        "  Used this month  $1.23",
        "  Monthly limit    Unlimited",
        "  Balance          $5.00",
      ),
      NOW,
    );
    if (panel.kind !== "ok") throw new Error(panel.kind);
    const r = kimiUsageReport(panel, NOW.toISOString());
    if (r.source !== "provider_reported") throw new Error("unknown");
    expect(r.windows).toEqual([
      {
        id: "weekly",
        limit_id: null,
        window_seconds: 604_800,
        used_fraction: 0.13,
        remaining_fraction: 0.87,
        resets_at: at(2 * 86_400),
      },
    ]);
    expect(r.credits).toEqual({ has_credits: true, unlimited: true, balance: "$5.00" });
    const empty = parseKimiUsagePanel(
      panel_("Plan usage", "  5h limit  0% used", "", "Extra Usage", "  Balance  ¥0.00"),
      NOW,
    );
    if (empty.kind !== "ok") throw new Error(empty.kind);
    const e = kimiUsageReport(empty, NOW.toISOString());
    expect(e.source === "provider_reported" && e.credits).toEqual({
      has_credits: false,
      unlimited: false,
      balance: "¥0.00",
    });
  });
});

describe("KimiAdapter.readProviderUsage without a terminal runner", () => {
  it("is unknown and spawns nothing", async () => {
    const r = await new KimiAdapter({ executable: "/nonexistent/kimi" }).readProviderUsage(noProbe, NOW);
    expect(r).toEqual({
      provider: "kimi",
      source: "unknown",
      observed_at: NOW.toISOString(),
      method: KIMI_USAGE_METHOD,
      error: REASON_NO_TERMINAL,
    });
    const missing = await readKimiUsage({ exe: undefined, terminal: undefined, env: {}, now: NOW });
    expect(missing.source === "unknown" && missing.error).toBe("kimi not found on PATH");
  });
});

describe("createTerminalRunner without a TUI", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sb-kimi-usage-pre-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const base = { scriptCommand: "/usr/bin/script", platform: "linux" as const };
  const read = (terminal: ReturnType<typeof createTerminalRunner>, readyWaitMs = 200) =>
    readKimiUsage({ exe: "/opt/k/kimi", terminal, env: { PATH: "/usr/bin" }, now: NOW, readyWaitMs });

  it("builds script argv per platform", () => {
    expect(scriptArgs("linux", ["/opt/k/kimi"])).toEqual(["-qfc", "'/opt/k/kimi'", "/dev/null"]);
    expect(scriptArgs("darwin", ["/opt/k/kimi"])).toEqual(["-q", "/dev/null", "/opt/k/kimi"]);
    expect(scriptArgs("win32", ["/opt/k/kimi"])).toBeUndefined();
  });

  it("refuses without spawning: unsupported platform, no script, unsafe argv", async () => {
    const win = await read(createTerminalRunner({ probeRoot: dir, platform: "win32", spawnImpl: unreachable }));
    expect(win.source === "unknown" && win.error).toMatch(/Linux or macOS/);
    const noScript = await read(createTerminalRunner({ probeRoot: dir, pathEnv: dir, spawnImpl: unreachable }));
    expect(noScript.source === "unknown" && noScript.error).toMatch(/`script` not found/);
    const quote = await readKimiUsage({
      exe: "/x/ki'mi",
      terminal: createTerminalRunner({ ...base, probeRoot: dir, spawnImpl: unreachable }),
      env: {},
      now: NOW,
    });
    expect(quote.source === "unknown" && quote.error).toMatch(/cannot be passed/);
  });

  it("refuses without spawning when the probe directory is not empty, a symlink or writable by others", async () => {
    const runner = (probeRoot: string) => createTerminalRunner({ ...base, probeRoot, spawnImpl: unreachable });
    const full = path.join(dir, "full");
    mkdirSync(path.join(full, "kimi-usage", ".kimi-code"), { recursive: true, mode: 0o700 });
    expect(await read(runner(full))).toMatchObject({ source: "unknown", error: TERMINAL_PROBE_DIR_NOT_EMPTY });

    const linked = path.join(dir, "linked");
    mkdirSync(path.join(dir, "target"), { mode: 0o700 });
    mkdirSync(linked, { mode: 0o700 });
    symlinkSync(path.join(dir, "target"), path.join(linked, "kimi-usage"));
    expect(await read(runner(linked))).toMatchObject({ source: "unknown", error: TERMINAL_PROBE_DIR_UNSAFE });

    const shared = path.join(dir, "shared");
    mkdirSync(path.join(shared, "kimi-usage"), { recursive: true });
    chmodSync(path.join(shared, "kimi-usage"), 0o770);
    expect(await read(runner(shared))).toMatchObject({ source: "unknown", error: TERMINAL_PROBE_DIR_UNSAFE });
  });

  it("spawns detached in the probe directory (created 0700) with exactly the given environment", async () => {
    const env = { PATH: "/usr/bin", HOME: "/home/op", KIMI_CODE_HOME: "/elsewhere", TMUX: "x", TMUX_PANE: "%1" };
    const allowed = kimiUsageEnv(["PATH", "HOME"], env);
    expect(allowed).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/op",
      TERM: "xterm-256color",
      COLUMNS: "120",
      LINES: "50",
    });
    const child = silentChild();
    const terminal = createTerminalRunner({ ...base, probeRoot: path.join(dir, "probes"), spawnImpl: child.spawnImpl });
    const r = await readKimiUsage({ exe: "/opt/k/kimi", terminal, env: allowed, now: NOW, readyWaitMs: 50 });
    expect(r.source).toBe("unknown");
    const probeDir = path.join(dir, "probes", "kimi-usage");
    expect(statSync(probeDir).mode & 0o777).toBe(0o700);
    expect(child.seen.args).toEqual(["-qfc", "'/opt/k/kimi'", "/dev/null"]);
    expect(child.seen.opts?.detached).toBe(true);
    expect(child.seen.opts?.env).toEqual(allowed);
    expect(child.seen.opts?.cwd).toBe(realpathSync(probeDir));
  });

  it("fails closed without typing when the prompt never shows", async () => {
    const child = silentChild();
    const r = await read(createTerminalRunner({ ...base, probeRoot: dir, spawnImpl: child.spawnImpl }));
    expect(r).toMatchObject({ source: "unknown", error: REASON_NOT_READY });
    expect(child.typed.join("")).not.toMatch(/[/u\r]/); // only the Ctrl-C of the shutdown
  });
});

const SCRIPT = resolveOnPath("script", process.env.PATH);
const ptyUnsupported = SCRIPT === undefined || !["linux", "darwin"].includes(process.platform);

describe.skipIf(ptyUnsupported)("KimiAdapter.readProviderUsage through the real `script` with a fake TUI", () => {
  let dir: string;
  let probeRoot: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sb-kimi-usage-"));
    probeRoot = path.join(dir, "probes");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const probeDir = () => path.join(probeRoot, "kimi-usage");

  const read = (scenario: string, opts: { timeoutMs?: number } = {}) =>
    readKimiUsage({
      exe: process.execPath,
      launcher: [FAKE_TUI, `--scenario=${scenario}`, FIXTURE],
      terminal: createTerminalRunner({ probeRoot }),
      env: kimiUsageEnv(["PATH", "HOME"], process.env),
      now: NOW,
      keyDelayMs: 40,
      readyWaitMs: 5_000,
      timeoutMs: opts.timeoutMs ?? 20_000,
    });

  it("the adapter types /usage, reads the panel and stops the TUI", async () => {
    const exe = path.join(dir, "kimi");
    writeFileSync(exe, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_TUI}' --scenario=ok '${FIXTURE}'\n`);
    chmodSync(exe, 0o755);
    const r = await new KimiAdapter({ executable: exe }).readProviderUsage(noProbe, NOW, {
      terminal: createTerminalRunner({ probeRoot }),
    });
    expect(r.source, JSON.stringify(r)).toBe("provider_reported");
    if (r.source !== "provider_reported") return;
    expect(r.windows.map((w) => [w.id, w.used_fraction])).toEqual([
      ["5h", 0],
      ["monthly", 0.25],
      ["kimi:monthly", 0.05],
      ["code:monthly", 0.2],
    ]);
  }, 30_000);

  it("answers the trust dialog that names the probe directory, then reads the panel", async () => {
    const r = await read("trust");
    expect(r.source, JSON.stringify(r)).toBe("provider_reported");
    expect(existsSync(path.join(probeDir(), "trust-answered"))).toBe(true);
  }, 30_000);

  it("does not answer a trust dialog that names another folder", async () => {
    const r = await read("trust-other");
    expect(r).toMatchObject({ source: "unknown", error: REASON_TRUST_REFUSED });
    expect(existsSync(path.join(probeDir(), "trust-answered"))).toBe(false);
  }, 30_000);

  it("reports not logged in without typing", async () => {
    expect(await read("not-logged-in")).toMatchObject({ source: "unknown", error: REASON_NOT_LOGGED_IN });
  }, 30_000);

  it("fails closed on a TUI that never shows its prompt and still stops it", async () => {
    const started = Date.now();
    const r = await read("hang", { timeoutMs: 2_500 });
    expect(r.source).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
