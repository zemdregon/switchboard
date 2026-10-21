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
  KIMI_USAGE_VIA,
  KimiUsageReader,
  kimiUsageEnv,
  parseKimiUsagePanel,
  REASON_NO_PROBE_DIR,
  REASON_NOT_LOGGED_IN,
  REASON_NOT_READY,
  REASON_PROBE_DIR_NOT_EMPTY,
  REASON_PROBE_DIR_UNSAFE,
  REASON_TRUST_REFUSED,
  type SpawnImpl,
  scriptArgs,
  stripTerminal,
} from "./usage.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/usage-tui-2.1.1.raw", import.meta.url));
const FAKE_TUI = fileURLToPath(new URL("./fixtures/fake-kimi-usage-tui.mjs", import.meta.url));
const NOW = new Date("2026-10-21T10:00:00.000Z");
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000).toISOString();

/** A synthetic panel in the renderer's layout (side borders, bottom border, ANSI colour on the heading). */
function panel(...body: string[]): string {
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
      panel(
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
      panel(
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
      { id: "used_this_month", label: "Used this month", amount: 1.23, currency: "USD" },
      { id: "monthly_limit", label: "Monthly limit", amount: 10, currency: "USD" },
      { id: "balance", label: "Balance", amount: 5, currency: "USD" },
    ]);
    expect(usd.kind === "ok" && usd.windows.map((w) => w.id)).toEqual(["5h"]);
    const other = parseKimiUsagePanel(
      panel(
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
      { id: "used_this_month", label: "Used this month", amount: 1234.5, currency: "CNY" },
      { id: "monthly_limit", label: "Monthly limit", amount: null, currency: null, unlimited: true },
      { id: "balance", label: "Balance", amount: 7, currency: "EUR" },
    ]);
  });

  it("returns a scrubbed, clipped error for the error form", () => {
    const p = parseKimiUsagePanel(
      panel("Plan usage", "  Authorization failed. Please check your API key (try /login)."),
      NOW,
    );
    expect(p).toEqual({ kind: "error", reason: "Authorization failed. Please check your API key (try /login)." });
    const leaky = parseKimiUsagePanel(
      panel(
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
    expect(parseKimiUsagePanel(panel("Plan usage", "  No usage data available."), NOW)).toEqual({
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
    expect(parseKimiUsagePanel(panel("Context window", "  0%"), NOW)).toEqual({ kind: "absent" });
    expect(parseKimiUsagePanel("", NOW)).toEqual({ kind: "absent" });
  });

  it("uses the last complete panel when the TUI redraws", () => {
    const first = panel("Plan usage", "  5h limit  10% used  resets in 5m");
    const second = panel("Plan usage", "  5h limit  20% used  resets in 4m");
    const partial = "\r\n │ Plan usage │\r\n │   5h limit  9";
    const p = parseKimiUsagePanel(first + second + partial, NOW);
    expect(p.kind === "ok" && p.windows.map((w) => w.used_fraction)).toEqual([0.2]);
  });
});

const unreachable = (cmd: string): ChildProcess => {
  throw new Error(`must not spawn ${cmd}`);
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

describe("KimiUsageReader without a TUI", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sb-kimi-usage-pre-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const base = { executable: "/opt/k/kimi", scriptCommand: "/usr/bin/script", platform: "linux" as const };

  it("is unavailable, without spawning, when kimi or script is missing or the platform is unsupported", async () => {
    const noKimi = await new KimiUsageReader({ pathEnv: dir, spawnImpl: unreachable }).read(NOW);
    expect(noKimi).toEqual({
      status: "unavailable",
      provider: "kimi",
      source: "provider_reported",
      observed_at: NOW.toISOString(),
      via: KIMI_USAGE_VIA,
      reason: "kimi not found on PATH",
    });
    const noScript = await new KimiUsageReader({ executable: "/x/kimi", pathEnv: dir, spawnImpl: unreachable }).read(
      NOW,
    );
    expect(noScript.status === "unavailable" && noScript.reason).toMatch(/`script` not found/);
    const win = await new KimiUsageReader({ executable: "/x/kimi", platform: "win32", spawnImpl: unreachable }).read(
      NOW,
    );
    expect(win.status === "unavailable" && win.reason).toMatch(/Linux or macOS/);
    const quote = await new KimiUsageReader({ executable: "/x/ki'mi", spawnImpl: unreachable }).read(NOW);
    expect(quote.status === "unavailable" && quote.reason).toMatch(/cannot be passed/);
  });

  it("builds script argv per platform", () => {
    expect(scriptArgs("linux", "/opt/k/kimi")).toEqual(["-qfc", "'/opt/k/kimi'", "/dev/null"]);
    expect(scriptArgs("darwin", "/opt/k/kimi")).toEqual(["-q", "/dev/null", "/opt/k/kimi"]);
    expect(scriptArgs("win32", "/opt/k/kimi")).toBeUndefined();
  });

  it("refuses without spawning when no probe directory is configured, or it is not empty, a symlink or writable by others", async () => {
    const none = await new KimiUsageReader({ ...base, spawnImpl: unreachable }).read(NOW);
    expect(none).toMatchObject({ status: "unavailable", reason: REASON_NO_PROBE_DIR });

    const full = path.join(dir, "full");
    mkdirSync(full, { mode: 0o700 });
    mkdirSync(path.join(full, ".kimi-code"));
    const planted = await new KimiUsageReader({ ...base, probeDir: full, spawnImpl: unreachable }).read(NOW);
    expect(planted).toMatchObject({ status: "unavailable", reason: REASON_PROBE_DIR_NOT_EMPTY });

    const target = path.join(dir, "target");
    mkdirSync(target, { mode: 0o700 });
    const link = path.join(dir, "link");
    symlinkSync(target, link);
    const linked = await new KimiUsageReader({ ...base, probeDir: link, spawnImpl: unreachable }).read(NOW);
    expect(linked).toMatchObject({ status: "unavailable", reason: REASON_PROBE_DIR_UNSAFE });

    const shared = path.join(dir, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o770);
    const open = await new KimiUsageReader({ ...base, probeDir: shared, spawnImpl: unreachable }).read(NOW);
    expect(open).toMatchObject({ status: "unavailable", reason: REASON_PROBE_DIR_UNSAFE });
  });

  it("spawns detached in the probe directory (created 0700) with only PATH, HOME and terminal variables", async () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/op",
      KIMI_CODE_HOME: "/elsewhere",
      TMUX: "/tmp/tmux-1/default,1,0",
      TMUX_PANE: "%1",
      OPENAI_API_KEY: "sk-x",
    };
    expect(kimiUsageEnv(env)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/op",
      TERM: "xterm-256color",
      COLUMNS: "120",
      LINES: "50",
    });
    const probeDir = path.join(dir, "probes", "kimi-usage");
    const child = silentChild();
    const r = await new KimiUsageReader({ ...base, env, probeDir, readyWaitMs: 50, spawnImpl: child.spawnImpl }).read(
      NOW,
    );
    expect(r.status).toBe("unavailable");
    expect(statSync(probeDir).mode & 0o777).toBe(0o700);
    expect(child.seen.args).toEqual(["-qfc", "'/opt/k/kimi'", "/dev/null"]);
    expect(child.seen.opts?.detached).toBe(true);
    expect(child.seen.opts?.env).toEqual(kimiUsageEnv(env));
    expect(child.seen.opts?.cwd).toBe(realpathSync(probeDir));
  });

  it("fails closed without typing when the prompt never shows", async () => {
    const child = silentChild();
    const r = await new KimiUsageReader({
      ...base,
      probeDir: path.join(dir, "probe"),
      readyWaitMs: 200,
      spawnImpl: child.spawnImpl,
    }).read(NOW);
    expect(r).toMatchObject({ status: "unavailable", reason: REASON_NOT_READY });
    expect(child.typed.join("")).not.toMatch(/[/u\r]/); // only the Ctrl-C of the shutdown
  });
});

const SCRIPT = resolveOnPath("script", process.env.PATH);
const ptyUnsupported = SCRIPT === undefined || !["linux", "darwin"].includes(process.platform);

describe.skipIf(ptyUnsupported)("KimiUsageReader through the real `script` with a fake TUI", () => {
  let dir: string;
  let probeDir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sb-kimi-usage-"));
    probeDir = path.join(dir, "probes", "kimi-usage");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fake = (scenario: string): string => {
    const exe = path.join(dir, `kimi-${scenario}`);
    writeFileSync(exe, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_TUI}' --scenario=${scenario} '${FIXTURE}'\n`);
    chmodSync(exe, 0o755);
    return exe;
  };
  const reader = (scenario: string, timeoutMs = 20_000) =>
    new KimiUsageReader({ executable: fake(scenario), probeDir, keyDelayMs: 40, readyWaitMs: 5_000, timeoutMs });

  it("types /usage, reads the panel and stops the TUI", async () => {
    const r = await reader("ok").read(NOW);
    expect(r.status, JSON.stringify(r)).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.windows.map((w) => [w.id, w.used_fraction])).toEqual([
      ["5h", 0],
      ["monthly", 0.25],
    ]);
    expect(r.windows[1]?.breakdown).toEqual({ kimi: 0.05, code: 0.2 });
  }, 30_000);

  it("answers the trust dialog that names the probe directory, then reads the panel", async () => {
    const r = await reader("trust").read(NOW);
    expect(r.status, JSON.stringify(r)).toBe("ok");
    expect(existsSync(path.join(probeDir, "trust-answered"))).toBe(true);
  }, 30_000);

  it("does not answer a trust dialog that names another folder", async () => {
    const r = await reader("trust-other").read(NOW);
    expect(r).toMatchObject({ status: "unavailable", reason: REASON_TRUST_REFUSED });
    expect(existsSync(path.join(probeDir, "trust-answered"))).toBe(false);
  }, 30_000);

  it("reports not logged in without typing", async () => {
    const r = await reader("not-logged-in").read(NOW);
    expect(r).toMatchObject({ status: "unavailable", reason: REASON_NOT_LOGGED_IN });
  }, 30_000);

  it("fails closed on a TUI that never shows its prompt and still stops it", async () => {
    const started = Date.now();
    const r = await reader("hang", 2_500).read(NOW);
    expect(r.status).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
