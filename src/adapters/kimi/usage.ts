/**
 * Kimi Code provider-reported plan usage (FR-CAP-13, ADR-0079, BR-50). Kimi Code CLI 2.1.1 shows the plan quota only in
 * its interactive TUI, through the `/usage` slash command: the CLI fetches the figures with its own login and draws a
 * panel; no model is called and no session is created (2026-10-21 live check, recorded as
 * `fixtures/usage-tui-2.1.1.raw`). {@link readKimiUsage} starts that TUI through a {@link TerminalRunner} (a
 * pseudo-terminal in a stable private probe directory, `src/adapters/terminal-run.ts`), types `/usage`, reads the panel
 * text and maps it to the shared {@link ProviderUsageResult}.
 *
 * Credential boundary (ADR-0003): Switchboard reads terminal text only. It reads no Kimi file, token or server token,
 * calls no Kimi HTTP API, never sets `KIMI_CODE_HOME` and passes only `KIMI_ENV_ALLOWLIST` (PATH, HOME) plus terminal
 * type and size. The raw terminal output never leaves the drive function: it is not logged and no error quotes it,
 * except a scrubbed, bounded error line the panel itself shows.
 *
 * Panel format (the CLI bundle's `usage-panel.ts`, 2.1.1): a `Plan usage` heading, then rows `5h limit`,
 * `Weekly limit`, `Monthly limit` (each optional) of the form `<label>  <bar>  <N>% used[  resets in <dur>| reset]`,
 * an optional `kimi N% · code M%` line after `Monthly limit`, or a single error line, or `No usage data available.`;
 * optionally an `Extra Usage` section with `Used this month`, `Monthly limit` and `Balance` money rows.
 *
 * Proposed: nothing is typed until the prompt's status line (`context:`) shows; without it the read fails closed. The
 * input is typed one character at a time and Enter is sent only after the TUI's input line shows exactly `/usage` and
 * its menu selection (if drawn) is `usage`, so a dropped keystroke can never run another command.
 *
 * Delegated (2026-10-21, live check on 2.1.1): in a folder it has not trusted, the TUI first asks "Trust this folder?"
 * and remembers the answer per exact folder. The run therefore uses the stable probe directory `kimi-usage` (production
 * `<data_dir>/probes/kimi-usage`, checked private and empty before every run by the runner), and the dialog is
 * answered at most once per run and only when it names that directory's real path and its selected option is
 * `Trust and continue`; any other dialog fails closed without a key sent.
 */
import { defaultRedactor } from "../../artifacts/redact.js";
import {
  type ProviderUsageCredits,
  type ProviderUsageResult,
  type ProviderUsageWindow,
  safeExcerpt,
} from "../provider-usage.js";
import type { TerminalIo, TerminalRunner } from "../types.js";

export const KIMI_USAGE_METHOD = "kimi TUI /usage (pseudo-terminal)";
export const KIMI_USAGE_PROBE_DIR = "kimi-usage";
export const DEFAULT_KIMI_USAGE_TIMEOUT_MS = 45_000;
const MAX_REASON_CHARS = 160;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

// ---------------------------------------------------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------------------------------------------------

/* biome-ignore-start lint/suspicious/noControlCharactersInRegex: these patterns match terminal control sequences */
const OSC = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
const STRING_SEQ = /\u001b[P^_X][\s\S]*?\u001b\\/g;
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const C1_CSI = /\u009b[0-?]*[ -/]*[@-~]/g;
const ESC_OTHER = /\u001b[ -/]*[0-~]/g;
const LONE_ESC = /\u001b/g;
const OTHER_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/* biome-ignore-end lint/suspicious/noControlCharactersInRegex: end */

/**
 * Terminal text as lines: ANSI CSI, OSC and other escape sequences removed, split on CR and LF, each line trimmed and
 * stripped of the panel's `│` side borders.
 */
export function stripTerminal(raw: string): string[] {
  const text = raw
    .replace(OSC, "")
    .replace(STRING_SEQ, "")
    .replace(CSI, "")
    .replace(C1_CSI, "")
    .replace(ESC_OTHER, "")
    .replace(LONE_ESC, "")
    .replace(/\t/g, " ")
    .replace(OTHER_CONTROLS, (c) => (c === "\r" || c === "\n" ? c : ""));
  return text.split(/\r|\n/).map((line) => {
    let l = line.trim();
    if (l.startsWith("│")) l = l.slice(1);
    if (l.endsWith("│")) l = l.slice(0, -1);
    return l.trim();
  });
}

/** One `Plan usage` row. Fractions are 0..1 (6 decimal places); `precision` 0.01 for the rounded whole percent. */
export interface KimiUsageWindow {
  /** `5h`, `weekly`, `monthly`, or a slug of an unknown label. */
  id: string;
  label: string;
  used_fraction: number;
  remaining_fraction: number;
  precision: number;
  /** Derived from the relative hint and `now`; null when the panel gave none. */
  reset_at: string | null;
  reset_precision_seconds: number | null;
  /** The `kimi N% · code M%` split under the row, as fractions. */
  breakdown?: Record<string, number>;
}

/** One `Extra Usage` money row; `text` is the provider's own string (`$5.00`, `Unlimited`). */
export interface KimiUsageBalance {
  id: string;
  label: string;
  text: string;
  amount: number | null;
  currency: string | null;
  unlimited?: true;
}

export type KimiUsagePanel =
  | { kind: "ok"; windows: KimiUsageWindow[]; balances: KimiUsageBalance[] }
  | { kind: "error"; reason: string }
  | { kind: "not_logged_in" }
  | { kind: "absent" };

const PLAN_HEADING = "Plan usage";
const EXTRA_HEADING = "Extra Usage";
/** Other panel headings; reaching one ends the Plan usage section. */
const OTHER_HEADINGS = new Set(["Session usage", "Context window", "Usage"]);
const NOT_LOGGED_IN = [/LLM not set/, /OAuth login expired/];
const NO_DATA = "No usage data available.";

const WINDOW_IDS: Record<string, string> = { "5h limit": "5h", "Weekly limit": "weekly", "Monthly limit": "monthly" };
const ROW = /^(\S.*?\blimit)\s+[█░▏▎▍▌▋▊▉]*\s*(\d{1,3})% used(?:\s+(?:resets in ((?:\d+[dhms]\s*)+)|(reset)))?$/;
const BREAKDOWN_PART = /^([A-Za-z][\w-]*) (\d{1,3})%$/;
const MONEY_ROW = /^(Used this month|Monthly limit|Balance)\s+(\S.*)$/;
const UNIT_SECONDS: Record<string, number> = { d: 86_400, h: 3_600, m: 60, s: 1 };

const isBottom = (l: string) => l.startsWith("╰");
const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

/** True when `lines` hold a finished Plan usage section (followed by the panel bottom) or a not-logged-in notice. */
export function kimiUsagePanelSettled(lines: readonly string[]): boolean {
  if (lines.some((l) => NOT_LOGGED_IN.some((re) => re.test(l)))) return true;
  const at = lines.lastIndexOf(PLAN_HEADING);
  return at >= 0 && lines.slice(at + 1).some(isBottom);
}

/** Scrubs and clips a line the panel showed, for a reason (no paths, URLs, addresses, ids or tokens). */
export function scrubPanelLine(line: string, home: string | undefined = process.env.HOME): string {
  let s = defaultRedactor(Buffer.from(line, "utf8")).toString("utf8");
  if (home !== undefined && home.length > 1) s = s.split(home).join("~");
  s = s
    .replace(/\p{Cc}/gu, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/~[\\/]\S*/g, "<path>")
    .replace(/(?:\b[A-Za-z]:)?(?:[\\/][^\s"'`,;:()[\]{}<>]+){2,}/g, "<path>")
    .replace(/[^\s"'`<>@]+@[^\s"'`<>@]+/g, "<email>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>")
    .replace(/\b\d{6,}\b/g, "<n>")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g, "<token>")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > MAX_REASON_CHARS ? `${s.slice(0, MAX_REASON_CHARS - 3)}...` : s;
}

function parseDuration(text: string): { seconds: number; precision: number } {
  let seconds = 0;
  let onlySeconds = true;
  for (const m of text.matchAll(/(\d+)([dhms])/g)) {
    seconds += Number(m[1]) * (UNIT_SECONDS[m[2] as string] ?? 0);
    if (m[2] !== "s") onlySeconds = false;
  }
  return { seconds, precision: onlySeconds ? 1 : 60 };
}

function parseMoney(text: string): Pick<KimiUsageBalance, "amount" | "currency"> & { unlimited?: true } {
  const t = text.trim();
  if (t === "Unlimited") return { amount: null, currency: null, unlimited: true };
  const num = (s: string) => {
    const n = Number(s.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  let m = /^(-?)\$(\d[\d,]*(?:\.\d+)?)$/.exec(t);
  if (m) return { amount: num(`${m[1]}${m[2]}`), currency: "USD" };
  m = /^(-?)¥(\d[\d,]*(?:\.\d+)?)$/.exec(t);
  if (m) return { amount: num(`${m[1]}${m[2]}`), currency: "CNY" };
  m = /^(-?\d[\d,]*(?:\.\d+)?) ([A-Z]{3})$/.exec(t);
  if (m) return { amount: num(m[1] as string), currency: m[2] as string };
  return { amount: null, currency: null };
}

/**
 * Parses the last `/usage` panel in raw terminal output. `now` turns relative reset hints into timestamps. Pure.
 */
export function parseKimiUsagePanel(raw: string, now: Date): KimiUsagePanel {
  const lines = stripTerminal(raw);
  // Last complete occurrence: the TUI redraws, so the same panel can appear more than once.
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] !== PLAN_HEADING) continue;
    if (at < 0) at = i;
    if (lines.slice(i + 1).some(isBottom)) {
      at = i;
      break;
    }
  }
  if (at < 0) {
    return lines.some((l) => NOT_LOGGED_IN.some((re) => re.test(l))) ? { kind: "not_logged_in" } : { kind: "absent" };
  }
  const windows: KimiUsageWindow[] = [];
  const balances: KimiUsageBalance[] = [];
  const errorLines: string[] = [];
  let mode: "plan" | "extra" = "plan";
  for (const line of lines.slice(at + 1)) {
    if (isBottom(line) || OTHER_HEADINGS.has(line) || line === PLAN_HEADING) break;
    if (line === "") continue;
    if (line === EXTRA_HEADING) {
      mode = "extra";
      continue;
    }
    if (mode === "extra") {
      const money = MONEY_ROW.exec(line);
      if (money) {
        const label = money[1] as string;
        const text = (money[2] as string).trim();
        balances.push({ id: slug(label), label, text, ...parseMoney(text) });
      }
      continue; // the optional bar line and anything unknown
    }
    if (line === NO_DATA) continue;
    const row = ROW.exec(line);
    if (row) {
      const label = row[1] as string;
      const used = round6(Math.min(100, Math.max(0, Number(row[2]))) / 100);
      let resetAt: string | null = null;
      let resetPrecision: number | null = null;
      if (row[3] !== undefined) {
        const d = parseDuration(row[3]);
        resetAt = new Date(now.getTime() + d.seconds * 1000).toISOString();
        resetPrecision = d.precision;
      } else if (row[4] !== undefined) {
        resetAt = now.toISOString();
        resetPrecision = 60;
      }
      windows.push({
        id: WINDOW_IDS[label] ?? slug(label),
        label,
        used_fraction: used,
        remaining_fraction: round6(1 - used),
        precision: 0.01,
        reset_at: resetAt,
        reset_precision_seconds: resetPrecision,
      });
      continue;
    }
    const parts = line.split(" · ").map((p) => BREAKDOWN_PART.exec(p.trim()));
    const last = windows.at(-1);
    if (last !== undefined && parts.every((p) => p !== null)) {
      last.breakdown = Object.fromEntries(
        parts.map((p) => [(p as RegExpExecArray)[1] as string, round6(Number((p as RegExpExecArray)[2]) / 100)]),
      );
      continue;
    }
    if (windows.length === 0) errorLines.push(line);
  }
  if (windows.length === 0 && errorLines.length > 0) {
    return { kind: "error", reason: scrubPanelLine(errorLines.join(" ")) };
  }
  return { kind: "ok", windows, balances };
}

// ---------------------------------------------------------------------------------------------------------------------
// The TUI dialogue and the mapping to the shared shape
// ---------------------------------------------------------------------------------------------------------------------

export const REASON_NO_TERMINAL = "no terminal runner configured";
export const REASON_NOT_LOGGED_IN =
  "Kimi Code is not logged in; run `kimi login` (Switchboard never handles the login)";
export const REASON_NO_PLAN_SECTION =
  "the Kimi Code /usage panel showed no Plan usage section (not a Kimi-managed login, or an unknown CLI version)";
export const REASON_NOT_READY = "the Kimi Code TUI did not show its prompt in time; nothing was typed";
export const REASON_TRUST_REFUSED =
  "the Kimi Code TUI showed a folder trust dialog that does not match the probe directory; it was not answered";
export const REASON_INPUT_REFUSED = "the Kimi Code TUI did not show /usage in its input line; Enter was not sent";
export const REASON_EXITED = "the Kimi Code TUI exited before it showed plan usage";

/** The child environment: only `allowlist` names from `env`, plus terminal type and size. */
export function kimiUsageEnv(
  allowlist: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of allowlist) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  return { ...out, TERM: "xterm-256color", COLUMNS: "120", LINES: "50" };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const TRUST_QUESTION = "Trust this folder?";
const TRUST_OPTION = "❯ Trust and continue";

/** The trust dialog has drawn a selected option (`❯ ...`) after its question. */
function trustDialogDrawn(lines: readonly string[]): boolean {
  const q = lines.lastIndexOf(TRUST_QUESTION);
  return q >= 0 && lines.slice(q + 1).some((l) => l.startsWith("❯"));
}

/** The last trust dialog names exactly `realPath` and selects `Trust and continue`. */
function trustDialogMatches(lines: readonly string[], realPath: string): boolean {
  const q = lines.lastIndexOf(TRUST_QUESTION);
  if (q < 0) return false;
  const after = lines.slice(q + 1);
  const selected = after.filter((l) => l.startsWith("❯")).at(-1);
  return after.includes(realPath) && selected === TRUST_OPTION;
}

/** True once the input line shows exactly `/usage` and the command menu, if drawn, selects `usage`. */
function inputShowsUsage(lines: readonly string[]): boolean {
  let input: string | undefined;
  let selected: string | undefined;
  for (const l of lines) {
    const i = /^>\s*(\/\S*)$/.exec(l);
    if (i) input = i[1];
    const s = /^→\s+(\S+)/.exec(l);
    if (s) selected = s[1];
  }
  return input === "/usage" && (selected === undefined || selected === "usage");
}

export type KimiDriveOutcome =
  | { kind: "exited" }
  | { kind: "timeout" }
  | { kind: "input_refused" }
  | { kind: "not_logged_in" }
  | { kind: "not_ready" }
  | { kind: "trust_refused" }
  | { kind: "settled"; text: string };

export interface KimiDriveOptions {
  /** Delay between typed characters. Default 150 ms. */
  readonly keyDelayMs?: number;
  /** Longest wait for the prompt (and again after answering the trust dialog). Default 15 000 ms. */
  readonly readyWaitMs?: number;
}

/** The `/usage` dialogue over a {@link TerminalIo}; returns the panel text after Enter, or why there is none. */
export async function driveKimiUsage(io: TerminalIo, o: KimiDriveOptions = {}): Promise<KimiDriveOutcome> {
  const keyDelayMs = o.keyDelayMs ?? 150;
  const readyWaitMs = o.readyWaitMs ?? 15_000;
  const lines = (text: string) => stripTerminal(text);
  const notLoggedIn = (text: string) => lines(text).some((l) => NOT_LOGGED_IN.some((re) => re.test(l)));
  const ready = (text: string) => lines(text).some((l) => l.includes("context:"));
  const trustShown = (text: string) => lines(text).includes(TRUST_QUESTION);
  const late = (): KimiDriveOutcome => (io.remaining() <= 0 ? { kind: "timeout" } : { kind: "not_ready" });

  await io.waitFor(
    () => io.exited() || ready(io.output()) || trustShown(io.output()) || notLoggedIn(io.output()),
    Math.min(readyWaitMs, io.remaining()),
  );
  if (notLoggedIn(io.output())) return { kind: "not_logged_in" };
  if (io.exited()) return { kind: "exited" };
  if (trustShown(io.output())) {
    // Let the dialog finish drawing (its selected option), then answer it once, only if it names this folder.
    await io.waitFor(() => io.exited() || trustDialogDrawn(lines(io.output())), Math.min(3_000, io.remaining()));
    if (io.exited()) return { kind: "exited" };
    if (!trustDialogMatches(lines(io.output()), io.cwd)) return { kind: "trust_refused" };
    const answeredAt = io.mark();
    io.write("\r");
    await io.waitFor(
      () => io.exited() || ready(io.outputSince(answeredAt)) || trustShown(io.outputSince(answeredAt)),
      Math.min(readyWaitMs, io.remaining()),
    );
    if (io.exited()) return { kind: "exited" };
    if (trustShown(io.outputSince(answeredAt))) return { kind: "trust_refused" }; // never answered twice
    if (!ready(io.outputSince(answeredAt))) return late();
  } else if (!ready(io.output())) {
    return late();
  }
  const typedAt = io.mark();
  for (const c of "/usage") {
    io.write(c);
    await sleep(keyDelayMs);
    if (io.exited()) return { kind: "exited" };
  }
  const echoed = () => inputShowsUsage(lines(io.outputSince(typedAt)));
  await io.waitFor(() => io.exited() || echoed(), Math.min(3_000, io.remaining()));
  if (io.exited()) return { kind: "exited" };
  if (!echoed()) return io.remaining() <= 0 ? { kind: "timeout" } : { kind: "input_refused" };
  const enterAt = io.mark();
  io.write("\r");
  const settled = () => kimiUsagePanelSettled(lines(io.outputSince(enterAt)));
  await io.waitFor(() => io.exited() || settled(), io.remaining());
  if (settled()) return { kind: "settled", text: io.outputSince(enterAt) };
  return io.exited() ? { kind: "exited" } : { kind: "timeout" };
}

/** Window lengths for the known rows (Kimi's `monthly` is a calendar month: no fixed length). */
const WINDOW_SECONDS: Record<string, number | null> = { "5h": 18_000, weekly: 604_800, monthly: null };

/** Maps a parsed panel to the shared report (ADR-0079): the breakdown becomes `<limit>:<window>` windows. */
export function kimiUsageReport(
  panel: Extract<KimiUsagePanel, { kind: "ok" }>,
  observedAt: string,
): ProviderUsageResult {
  const windows: ProviderUsageWindow[] = [];
  for (const w of panel.windows) {
    const windowSeconds = WINDOW_SECONDS[w.id] ?? null;
    windows.push({
      id: w.id,
      limit_id: null,
      window_seconds: windowSeconds,
      used_fraction: w.used_fraction,
      remaining_fraction: w.remaining_fraction,
      resets_at: w.reset_at,
    });
    for (const [limit, used] of Object.entries(w.breakdown ?? {})) {
      windows.push({
        id: `${limit}:${w.id}`,
        limit_id: limit,
        window_seconds: windowSeconds,
        used_fraction: used,
        remaining_fraction: round6(1 - used),
        resets_at: w.reset_at,
      });
    }
  }
  let credits: ProviderUsageCredits | null = null;
  if (panel.balances.length > 0) {
    const balance = panel.balances.find((b) => b.id === "balance");
    const limit = panel.balances.find((b) => b.id === "monthly_limit");
    credits = {
      has_credits: (balance?.amount ?? 0) > 0,
      unlimited: limit?.unlimited === true,
      balance: balance === undefined ? null : safeExcerpt(balance.text, 40),
    };
  }
  return {
    provider: "kimi",
    source: "provider_reported",
    observed_at: observedAt,
    method: KIMI_USAGE_METHOD,
    plan: null,
    limit_reached: null,
    limit_reached_type: null,
    windows,
    credits,
  };
}

export interface ReadKimiUsageOptions extends KimiDriveOptions {
  /** The resolved `kimi` executable (undefined: not on PATH). */
  readonly exe: string | undefined;
  /** Launcher arguments before the CLI's own (tests: a fake TUI script). */
  readonly launcher?: readonly string[];
  readonly terminal: TerminalRunner | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly now: Date;
  readonly timeoutMs?: number;
}

/** FR-CAP-13: Kimi Code plan usage through the TUI's `/usage` panel; every failure is `unknown` with a fixed reason. */
export async function readKimiUsage(o: ReadKimiUsageOptions): Promise<ProviderUsageResult> {
  const observedAt = o.now.toISOString();
  const unknown = (error: string): ProviderUsageResult => ({
    provider: "kimi",
    source: "unknown",
    observed_at: observedAt,
    method: KIMI_USAGE_METHOD,
    error,
  });
  if (o.exe === undefined) return unknown("kimi not found on PATH");
  if (o.terminal === undefined) return unknown(REASON_NO_TERMINAL);
  const timeoutMs = o.timeoutMs ?? DEFAULT_KIMI_USAGE_TIMEOUT_MS;
  const run = await o.terminal([o.exe, ...(o.launcher ?? [])], {
    probeDirName: KIMI_USAGE_PROBE_DIR,
    timeoutMs,
    env: o.env,
    drive: (io) => driveKimiUsage(io, o),
  });
  if (!run.ok) return unknown(run.error);
  const outcome = run.value;
  switch (outcome.kind) {
    case "exited":
      return unknown(REASON_EXITED);
    case "timeout":
      return unknown(`the Kimi Code TUI did not show plan usage within ${Math.round(timeoutMs / 1000)} s`);
    case "input_refused":
      return unknown(REASON_INPUT_REFUSED);
    case "not_logged_in":
      return unknown(REASON_NOT_LOGGED_IN);
    case "not_ready":
      return unknown(REASON_NOT_READY);
    case "trust_refused":
      return unknown(REASON_TRUST_REFUSED);
    case "settled": {
      const panel = parseKimiUsagePanel(outcome.text, o.now);
      if (panel.kind === "ok") return kimiUsageReport(panel, observedAt);
      if (panel.kind === "error") return unknown(`Kimi Code reported: ${safeExcerpt(panel.reason)}`);
      if (panel.kind === "not_logged_in") return unknown(REASON_NOT_LOGGED_IN);
      return unknown(REASON_NO_PLAN_SECTION);
    }
  }
}
