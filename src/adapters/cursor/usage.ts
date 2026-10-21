/**
 * Cursor CLI provider-reported usage (ADR-0080, FR-CAP-13, BR-50; Delegated, not owner-approved). The one source of
 * Cursor's plan and usage figures that the CLI itself shows is its interactive `/usage` slash command: the CLI calls
 * Cursor's dashboard service (`GetCurrentPeriodUsage`, `GetHardLimit`, `GetPlanInfo`) with its own login and renders a
 * panel. Print mode has no slash commands and no usage event, and `about --format json` carries the plan name only
 * (`docs/research/cursor-usage-2026-10-21.md`). So this module starts `cursor-agent` in a pseudo-terminal (`script(1)`,
 * no new dependency), types `/usage`, reads the rendered panel and quits. No prompt is ever submitted, so no model is
 * called; Switchboard never reads a Cursor credential, cookie or configuration file (ADR-0003, FR-AUTH-02): the CLI
 * authenticates itself and Switchboard reads only what it prints.
 *
 * The panel, as the CLI renders it at 160 columns (2026.10.19-6bbf2c4, `src/usage/usage-pager.tsx` in its bundle):
 *
 * ```text
 *  Usage • Pro                                              Resets Nov 5
 *  Monthly plan and on-demand usage
 *  Category        Current             Usage
 *  Included        100% used           ████
 *    Auto          100% used           ████
 *    API           100% used           ████
 *  On-Demand       Disabled            ————
 *  On-demand usage is off
 * ```
 *
 * Percentages are whole numbers as the CLI rounds them ("1%" for anything above 0 and below 1). The reset label is the
 * billing-cycle end as a UTC month and day, so `resets_at` is the start of that UTC day and `reset_precision` is
 * `day`. A figure the panel does not show is null, never computed (BR-50).
 */

import { spawn } from "node:child_process";
import { lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderUsageOnDemand } from "../provider-usage.js";

/** One usage window as the CLI reported it. Fractions are in [0, 1]; `remaining_fraction` is `1 - used`. */
export interface CursorUsageWindow {
  /** `included` (the plan's included usage), `included:auto` or `included:api` (its two shares). */
  id: string;
  limit_id: null;
  /** The billing cycle's length is not shown. */
  window_seconds: null;
  used_fraction: number;
  remaining_fraction: number;
  resets_at: string | null;
}

/** The on-demand (usage-based) row: `state` names the CLI's own four cases; dollars as shown, null when not shown. */
export type CursorOnDemand = ProviderUsageOnDemand;

export interface CursorUsageReport {
  provider: "cursor";
  source: "provider_reported";
  observed_at: string;
  method: string;
  plan: string | null;
  /**
   * True when the included usage is at 100% and on-demand use is off or spent; false when included usage is below
   * 100% or on-demand use has no limit; null when the panel does not say.
   */
  limit_reached: boolean | null;
  limit_reached_type: null;
  windows: CursorUsageWindow[];
  credits: null;
  /** The CLI's reset label, verbatim ("Resets Nov 5" or "Current period"). */
  reset_label: string | null;
  reset_precision: "day" | null;
  on_demand: CursorOnDemand | null;
  /** Enterprise accounts get a spend view instead of percentages: cumulative dollars this and last period. */
  spend: { current_cycle_usd: number | null; previous_period_usd: number | null } | null;
}

export interface CursorUsageUnavailable {
  provider: "cursor";
  source: "unknown";
  observed_at: string;
  method: string;
  error: string;
}

export type CursorUsageResult = CursorUsageReport | CursorUsageUnavailable;

export const CURSOR_USAGE_METHOD =
  "cursor-agent /usage (interactive slash command in a pseudo-terminal; no model call)";

/** The slash command typed into the CLI. */
export const USAGE_SLASH_COMMAND = "/usage";
/** Read-only mode and trust for the empty scratch directory the CLI starts in (no prompt is ever submitted). */
export const USAGE_SESSION_ARGS: readonly string[] = ["--mode", "ask", "--trust"];
/** Terminal size forced inside the pseudo-terminal, so the panel uses its wide (one row per line) layout. */
export const USAGE_TTY_COLUMNS = 160;
export const USAGE_TTY_ROWS = 50;
/** Proposed: a whole read is bounded by 30 s; the CLI starts in about 3 s and the panel loads in about 2 s on Ampere. */
export const USAGE_TIMEOUT_MS = 30_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences are the input.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences are the input.
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences are the input.
const ESC_OTHER = /\x1b[()][A-Za-z0-9]|\x1b[=>78NOPc]/g;

/** Terminal output as plain lines: escapes removed, carriage returns treated as line ends, trailing blanks trimmed. */
export function screenLines(raw: string): string[] {
  return raw
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(ESC_OTHER, "")
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/\s+$/, ""));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Resets Nov 5" as the start of that UTC day, the next one on or after today (UTC); null for anything else. */
export function resetFromLabel(label: string, now: Date): string | null {
  const m = /^Resets ([A-Z][a-z]{2}) (\d{1,2})$/.exec(label);
  if (m === null) return null;
  const month = MONTHS.indexOf(m[1] as string);
  const day = Number(m[2]);
  if (month < 0 || day < 1 || day > 31) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (const year of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
    const t = Date.UTC(year, month, day);
    if (new Date(t).getUTCDate() !== day) continue;
    if (t >= today) return new Date(t).toISOString();
  }
  return null;
}

/** "$1,234.56" or "$20" as a number; null otherwise. */
export function dollars(s: string | undefined): number | null {
  if (s === undefined) return null;
  const m = /^\$([0-9][0-9,]*(?:\.[0-9]+)?)$/.exec(s.trim());
  if (m === null) return null;
  const n = Number((m[1] as string).replaceAll(",", ""));
  return Number.isFinite(n) ? n : null;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Messages the CLI prints instead of a panel, verbatim from its bundle; any of them makes the read `unknown`. */
const UNAVAILABLE_MESSAGES: readonly RegExp[] = [
  /Usage details are not available for this plan in the CLI\./,
  /Enterprise spend details are not available for this account in the CLI\./,
  /Not logged in\. Run \/login first\./,
  /Failed to load usage data: ?.*/,
];

const ROW = /^\s*(Included|Auto|API):?\s+(\d{1,3})% used\b/;
const ON_DEMAND = /^\s*On-Demand:?\s+(.+?)(?:\s{2,}|$)/;
const ON_DEMAND_DETAIL =
  /^\s*(On-demand usage is off|No monthly limit|No personal limit|On-demand limit unavailable|\$[0-9][0-9,]*(?:\.[0-9]+)? remaining)\s*$/;

/**
 * Parses the last `/usage` panel in the CLI's terminal output. Pure. Returns `null` when no panel or known message is
 * found (the caller reports `unknown`), a {@link CursorUsageUnavailable} for one of the CLI's own messages, else the
 * report.
 */
export function parseCursorUsageScreen(raw: string, now: Date): CursorUsageResult | null {
  const lines = screenLines(raw);
  const observed_at = now.toISOString();
  // The panel is redrawn on every frame; read only the last one.
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*Usage\s*•/.test(lines[i] as string)) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      for (const re of UNAVAILABLE_MESSAGES) {
        const m = re.exec(lines[i] as string);
        if (m !== null) {
          return {
            provider: "cursor",
            source: "unknown",
            observed_at,
            method: CURSOR_USAGE_METHOD,
            error: m[0].trim(),
          };
        }
      }
    }
    return null;
  }
  const panel = lines.slice(start);
  const end = panel.findIndex((l) => /^\s*Esc to close/.test(l));
  const body = end < 0 ? panel : panel.slice(0, end);

  const head = body[0] as string;
  const reset = /(Resets [A-Z][a-z]{2} \d{1,2}|Current period)\s*$/m.exec(body.slice(0, 3).join("\n"))?.[1] ?? null;
  const planMatch = /Usage\s*•\s*(.+?)(?:\s{2,}|$)/.exec(head);
  const plan = planMatch?.[1]?.trim() || null;
  const resets_at = reset === null ? null : resetFromLabel(reset, now);

  const windows: CursorUsageWindow[] = [];
  const ids: Record<string, string> = { Included: "included", Auto: "included:auto", API: "included:api" };
  for (const l of body) {
    const m = ROW.exec(l);
    if (m === null) continue;
    const id = ids[m[1] as string] as string;
    if (windows.some((w) => w.id === id)) continue;
    const used = round6(Math.min(1, Math.max(0, Number(m[2]) / 100)));
    windows.push({
      id,
      limit_id: null,
      window_seconds: null,
      used_fraction: used,
      remaining_fraction: round6(1 - used),
      resets_at,
    });
  }

  let on_demand: CursorOnDemand | null = null;
  const odLine = body.map((l) => ON_DEMAND.exec(l)).find((m) => m !== null);
  const detail = body.map((l) => ON_DEMAND_DETAIL.exec(l)?.[1]).find((d) => d !== undefined) ?? null;
  if (odLine !== undefined && odLine !== null) {
    const value = (odLine[1] as string).trim();
    const fixed = /^(\$[0-9][0-9,.]*) \/ (\$[0-9][0-9,.]*)$/.exec(value);
    if (fixed !== null) {
      const used_usd = dollars(fixed[1]);
      const limit_usd = dollars(fixed[2]);
      const shown = detail === null ? null : dollars(detail.replace(/ remaining$/, ""));
      on_demand = { state: "fixed", used_usd, limit_usd, remaining_usd: shown, detail };
    } else {
      const state: CursorOnDemand["state"] =
        detail === "On-demand usage is off"
          ? "disabled"
          : detail === "No monthly limit" || detail === "No personal limit"
            ? "unlimited"
            : "unavailable";
      on_demand = {
        state,
        used_usd: value === "Disabled" || value === "Unavailable" ? (state === "disabled" ? 0 : null) : dollars(value),
        limit_usd: null,
        remaining_usd: null,
        detail,
      };
    }
  }

  let spend: CursorUsageReport["spend"] = null;
  if (body.some((l) => /Personal spend for the current billing period/.test(l))) {
    const pick = (label: RegExp) => {
      for (const l of body) {
        const m = label.exec(l);
        if (m !== null) return dollars(m[1]);
      }
      return null;
    };
    spend = {
      current_cycle_usd: pick(/^\s*(?:Current cycle|Current:)\s+(\$[0-9][0-9,.]*)/),
      previous_period_usd: pick(/^\s*(?:Previous period|Previous:)\s+(\$[0-9][0-9,.]*)/),
    };
  }

  if (windows.length === 0 && spend === null) return null;

  const included = windows.find((w) => w.id === "included");
  let limit_reached: boolean | null = null;
  if (included !== undefined) {
    if (included.used_fraction < 1) limit_reached = false;
    else if (on_demand?.state === "disabled") limit_reached = true;
    else if (on_demand?.state === "unlimited") limit_reached = false;
    else if (on_demand?.state === "fixed" && on_demand.remaining_usd !== null)
      limit_reached = on_demand.remaining_usd <= 0;
  }

  return {
    provider: "cursor",
    source: "provider_reported",
    observed_at,
    method: CURSOR_USAGE_METHOD,
    plan,
    limit_reached,
    limit_reached_type: null,
    windows,
    credits: null,
    reset_label: reset,
    reset_precision: resets_at === null ? null : "day",
    on_demand,
    spend,
  };
}

/** POSIX single-quoting for the one shell command `script(1)` runs. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `script(1)` argv that runs the CLI in a pseudo-terminal of the forced size: util-linux on Linux
 * (`script -qfec <cmd> /dev/null`), BSD on macOS (`script -q /dev/null sh -c <cmd>`; **Assumption**, not run on a Mac).
 */
export function ptyArgv(exe: string, launcherArgs: readonly string[], platform: NodeJS.Platform): string[] {
  const cmd = `stty cols ${USAGE_TTY_COLUMNS} rows ${USAGE_TTY_ROWS} 2>/dev/null; exec ${[exe, ...launcherArgs, ...USAGE_SESSION_ARGS].map(shellQuote).join(" ")}`;
  return platform === "darwin" ? ["script", "-q", "/dev/null", "sh", "-c", cmd] : ["script", "-qfec", cmd, "/dev/null"];
}

/** Variables passed through to the CLI, as the probe runner's `PATH` and `HOME` plus the user name and temp dir. */
export const USAGE_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR"];

/**
 * The CLI's environment: only {@link USAGE_ENV_ALLOWLIST} from `source` (least privilege, as the probe runner), plus a
 * fixed terminal type and an English UTF-8 locale so that the panel's labels and dates parse.
 */
export function usageEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of USAGE_ENV_ALLOWLIST) {
    const v = source[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, TERM: "xterm-256color", NO_COLOR: "1", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
}

/** Minimal child the reader drives; `node:child_process` spawn satisfies it, tests pass a fake. */
export interface UsageChild {
  stdin: { write(s: string): unknown; end(): unknown } | null;
  stdout: { on(ev: "data", cb: (d: Buffer | string) => void): unknown } | null;
  on(ev: "exit" | "error", cb: (arg?: unknown) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface ReadCursorUsageOptions {
  exe: string | undefined;
  launcherArgs?: readonly string[];
  now?: () => Date;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  /** Defaults to `node:child_process` spawn in {@link usageScratchDir}. */
  spawnChild?: (argv: readonly string[], cwd: string) => UsageChild;
  /** Defaults to {@link usageScratchDir}. */
  scratchDir?: () => { path: string; cleanup(): void };
}

/**
 * The one empty directory every read starts the CLI in: `<tmpdir>/switchboard-cursor-usage-<uid>`, mode 0700, kept
 * between reads. Cursor records a project entry (`~/.cursor/projects/<slug>`, a trust marker) per directory it starts
 * in, so a fresh directory per read would add one entry per read; a stable one adds exactly one. Refused (throws) when
 * the path exists but is a symbolic link, not a directory, or owned by another user.
 */
export function usageScratchDir(base: string = tmpdir(), uid: number | undefined = process.getuid?.()) {
  const path = join(base, `switchboard-cursor-usage-${uid ?? "user"}`);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory() || (uid !== undefined && st.uid !== uid)) {
    throw new Error(`refusing usage scratch directory ${path}: not a directory owned by this user`);
  }
  return { path, cleanup: () => undefined };
}

/** Screen buffer bound (Proposed): past 1 MiB of text keep the last 256 KiB, which holds several whole frames. */
const MAX_SCREEN_CHARS = 2 ** 20;
const KEEP_SCREEN_CHARS = 2 ** 18;

const plain = (s: string): string => s.replace(OSC, "").replace(CSI, "");
/** The prompt box is up (the CLI accepts input). */
const READY = /Plan, search, build anything|\(shift\+tab to cycle\)/;
/** The slash menu offers `/usage` as the highlighted entry, so Enter runs the command rather than sending a prompt. */
const MENU_SELECTED = /→\s*\/usage\b/;
/** The panel or one of the CLI's own messages is on screen. */
const DONE =
  /Esc to close|Usage details are not available|spend details are not available|Not logged in\. Run \/login|Failed to load usage data/;

const unavailable = (now: Date, error: string): CursorUsageUnavailable => ({
  provider: "cursor",
  source: "unknown",
  observed_at: now.toISOString(),
  method: CURSOR_USAGE_METHOD,
  error,
});

/**
 * Runs the `/usage` command once and parses the panel. Never throws: any failure is an `unknown` result with a short
 * reason. Enter is pressed only once the slash menu shows `/usage` selected, so a slow start never submits the text as a
 * prompt. The raw screen is never returned or logged.
 */
export async function readCursorUsage(opts: ReadCursorUsageOptions): Promise<CursorUsageResult> {
  const now = opts.now ?? (() => new Date());
  if (opts.exe === undefined) return unavailable(now(), "cursor-agent not found on PATH");
  const argv = ptyArgv(opts.exe, opts.launcherArgs ?? [], opts.platform ?? process.platform);
  let scratch: { path: string; cleanup(): void };
  try {
    scratch = (opts.scratchDir ?? usageScratchDir)();
  } catch (e) {
    return unavailable(now(), (e instanceof Error ? e.message : String(e)).slice(0, 200));
  }
  const spawnChild =
    opts.spawnChild ??
    ((a: readonly string[], cwd: string): UsageChild =>
      spawn(a[0] as string, a.slice(1), {
        cwd,
        env: usageEnv(process.env),
        stdio: ["pipe", "pipe", "ignore"],
      }));

  return await new Promise<CursorUsageResult>((resolve) => {
    let out = "";
    let phase: "start" | "typed" | "entered" | "done" = "start";
    let enteredAt = 0;
    let settled = false;
    let child: UsageChild;
    const timers: NodeJS.Timeout[] = [];
    const finish = (r: CursorUsageResult) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      try {
        child.stdin?.write("\x1b");
        child.stdin?.write("\x03");
        child.stdin?.write("\x03");
        child.stdin?.end();
      } catch {
        // The child may already be gone.
      }
      timers.push(setTimeout(() => child.kill("SIGTERM"), 1_000).unref());
      timers.push(setTimeout(() => child.kill("SIGKILL"), 3_000).unref());
      scratch.cleanup();
      resolve(r);
    };
    try {
      child = spawnChild(argv, scratch.path);
    } catch (e) {
      scratch.cleanup();
      resolve(
        unavailable(now(), `could not start script(1): ${e instanceof Error ? e.message : String(e)}`.slice(0, 200)),
      );
      return;
    }
    timers.push(
      setTimeout(
        () =>
          finish(unavailable(now(), `no usage panel within ${opts.timeoutMs ?? USAGE_TIMEOUT_MS} ms (phase ${phase})`)),
        opts.timeoutMs ?? USAGE_TIMEOUT_MS,
      ),
    );
    child.on("error", () => finish(unavailable(now(), "could not start script(1)")));
    child.on("exit", () => {
      if (settled) return;
      const parsed = parseCursorUsageScreen(out, now());
      finish(parsed ?? unavailable(now(), `cursor-agent exited before the usage panel (phase ${phase})`));
    });
    child.stdout?.on("data", (d) => {
      if (settled) return;
      out += typeof d === "string" ? d : d.toString("utf8");
      // Bound memory: the panel is in the last frames.
      if (out.length > MAX_SCREEN_CHARS) out = out.slice(-KEEP_SCREEN_CHARS);
      const text = plain(out);
      if (phase === "start" && READY.test(text)) {
        phase = "typed";
        timers.push(setTimeout(() => child.stdin?.write(USAGE_SLASH_COMMAND), 300));
      } else if (phase === "typed" && MENU_SELECTED.test(text)) {
        phase = "entered";
        enteredAt = out.length;
        timers.push(setTimeout(() => child.stdin?.write("\r"), 300));
      } else if (phase === "entered" && DONE.test(plain(out.slice(enteredAt)))) {
        phase = "done";
        // One more frame may still be on its way; parse after a short settle.
        timers.push(
          setTimeout(() => {
            const parsed = parseCursorUsageScreen(out, now());
            finish(parsed ?? unavailable(now(), "usage panel not recognised"));
          }, 400),
        );
      }
    });
  });
}
