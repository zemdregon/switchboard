/**
 * Kimi Code provider-reported plan usage (FR-CAP-13, ADR-0079, BR-50). Kimi Code CLI 2.1.1 shows the plan quota only in
 * its interactive TUI, through the `/usage` slash command: the CLI fetches the figures with its own login and draws a
 * panel; no model is called and no session is created (2026-10-21 live check, recorded as
 * `fixtures/usage-tui-2.1.1.raw`). This module starts that TUI under a pseudo-terminal (`script`), types `/usage`,
 * reads the panel text and stops the TUI.
 *
 * Credential boundary (ADR-0003): Switchboard reads terminal text only. It reads no Kimi file, token or server token,
 * calls no Kimi HTTP API, never sets `KIMI_CODE_HOME` and passes only `KIMI_ENV_ALLOWLIST` (PATH, HOME) plus terminal
 * size variables. The raw terminal output never leaves {@link KimiUsageReader.read}: it is not logged and no reason
 * quotes it, except a scrubbed and clipped error line the panel itself shows.
 *
 * Panel format (the CLI bundle's `usage-panel.ts`, 2.1.1): a `Plan usage` heading, then rows `5h limit`,
 * `Weekly limit`, `Monthly limit` (each optional) of the form `<label>  <bar>  <N>% used[  resets in <dur>| reset]`,
 * an optional `kimi N% · code M%` line after `Monthly limit`, or a single error line, or `No usage data available.`;
 * optionally an `Extra Usage` section with `Used this month`, `Monthly limit` and `Balance` money rows.
 *
 * Proposed: the input is typed one character at a time and Enter is sent only after the TUI's input line shows
 * exactly `/usage` and its menu selection (if drawn) is `usage`, so a dropped keystroke can never run another command.
 * Nothing is typed until the prompt's status line (`context:`) shows; without it the read fails closed.
 *
 * Delegated (2026-10-21, live check on 2.1.1): the TUI runs in one STABLE probe directory
 * (`<data_dir>/probes/kimi-usage`), not a fresh temporary directory. Kimi Code asks "Trust this folder?" once per exact
 * folder and remembers the answer in its own data directory, so a fresh directory per read would show the dialog
 * every time and leave one trust record per read. The directory must be a real directory (no symlink), owned by this
 * user, without group or other write permission, and EMPTY before every run, so no planted project configuration
 * (`.kimi-code/mcp.json`, [K5]) can start with the TUI. The trust dialog is answered at most once per run and only
 * when it names this directory's real path and its selected option is `Trust and continue`; any other dialog fails
 * closed without a key sent.
 */
import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { defaultRedactor } from "../../artifacts/redact.js";
import {
  type ProviderUsageBalance,
  type ProviderUsageReader,
  type ProviderUsageReport,
  type ProviderUsageWindow,
  round6,
} from "../../capacity/provider-usage.js";
import { resolveOnPath } from "../codex/adapter.js";
import { KIMI_ENV_ALLOWLIST } from "./adapter.js";
import { KIMI_BINARY } from "./protocol.js";

export const KIMI_USAGE_VIA = "Kimi Code TUI /usage (the CLI's own credentials; Switchboard reads terminal text only)";
export const DEFAULT_KIMI_USAGE_TIMEOUT_MS = 45_000;
/** Most terminal output kept while waiting (the newest bytes are kept). */
export const MAX_KIMI_USAGE_OUTPUT_CHARS = 1024 * 1024;
const MAX_REASON_CHARS = 160;

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

export type KimiUsagePanel =
  | { kind: "ok"; windows: ProviderUsageWindow[]; balances: ProviderUsageBalance[] }
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

function parseMoney(text: string): Pick<ProviderUsageBalance, "amount" | "currency"> & { unlimited?: true } {
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
  const windows: ProviderUsageWindow[] = [];
  const balances: ProviderUsageBalance[] = [];
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
        balances.push({ id: slug(label), label, ...parseMoney(money[2] as string) });
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
// The TUI driver
// ---------------------------------------------------------------------------------------------------------------------

export type SpawnImpl = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface KimiUsageReaderOptions {
  /** The `kimi` executable; default resolved on `pathEnv` like the adapter. */
  readonly executable?: string;
  /** Default `env.PATH`. */
  readonly pathEnv?: string;
  /** Environment the allowlist is taken from. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  /** The pseudo-terminal wrapper; default `script` on PATH. */
  readonly scriptCommand?: string;
  readonly platform?: NodeJS.Platform;
  readonly spawnImpl?: SpawnImpl;
  /** Delay between typed characters. Default 150 ms. */
  readonly keyDelayMs?: number;
  /** Longest wait for the prompt (and again after answering the trust dialog). Default 15 000 ms. */
  readonly readyWaitMs?: number;
  /**
   * The stable directory the TUI runs in (Delegated, see the module comment). Required: without it every read is
   * `unavailable`; no location is invented. Production wiring: `<data_dir>/probes/kimi-usage`.
   */
  readonly probeDir?: string;
}

export const REASON_NO_PROBE_DIR = "no Kimi usage probe directory is configured";
export const REASON_PROBE_DIR_NOT_EMPTY = "the Kimi usage probe directory is not empty";
export const REASON_PROBE_DIR_UNSAFE =
  "the Kimi usage probe directory is not a private directory (a symlink, another owner, or group or other write access)";
export const REASON_NOT_READY = "the Kimi Code TUI did not show its prompt in time; nothing was typed";
export const REASON_TRUST_REFUSED =
  "the Kimi Code TUI showed a folder trust dialog that does not match the probe directory; it was not answered";

/**
 * Creates the probe directory (mode 0700) if missing and checks it before a run. Returns its real path, or the fixed
 * reason it cannot be used. Only the directory itself is listed, never read into.
 */
export async function prepareProbeDir(
  dir: string,
): Promise<{ ok: true; realPath: string } | { ok: false; reason: string }> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const st = await lstat(dir);
    const uid = process.getuid?.();
    if (st.isSymbolicLink() || !st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o022) !== 0) {
      return { ok: false, reason: REASON_PROBE_DIR_UNSAFE };
    }
    if ((await readdir(dir)).length > 0) return { ok: false, reason: REASON_PROBE_DIR_NOT_EMPTY };
    return { ok: true, realPath: await realpath(dir) };
  } catch {
    return { ok: false, reason: REASON_PROBE_DIR_UNSAFE };
  }
}

export const REASON_NOT_LOGGED_IN =
  "Kimi Code is not logged in; run `kimi login` (Switchboard never handles the login)";
export const REASON_NO_PLAN_SECTION =
  "the Kimi Code /usage panel showed no Plan usage section (not a Kimi-managed login, or an unknown CLI version)";

const unsafeExe = (exe: string) => exe.includes("'") || /\p{Cc}/u.test(exe);

/** Builds the `script` argv that runs `exe` under a pseudo-terminal, or undefined on an unsupported platform. */
export function scriptArgs(platform: NodeJS.Platform, exe: string): string[] | undefined {
  if (platform === "linux") return ["-qfc", `'${exe}'`, "/dev/null"];
  if (platform === "darwin") return ["-q", "/dev/null", exe];
  return undefined;
}

/** The child environment: only `KIMI_ENV_ALLOWLIST` names from `env`, plus terminal type and size. */
export function kimiUsageEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KIMI_ENV_ALLOWLIST) {
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

/** FR-CAP-13: Kimi Code plan usage through the TUI's `/usage` panel. */
export class KimiUsageReader implements ProviderUsageReader {
  readonly provider = "kimi";
  readonly via = KIMI_USAGE_VIA;
  readonly #opts: KimiUsageReaderOptions;

  constructor(opts: KimiUsageReaderOptions = {}) {
    this.#opts = opts;
  }

  async read(now: Date): Promise<ProviderUsageReport> {
    const observed = now.toISOString();
    const base = {
      provider: this.provider,
      source: "provider_reported" as const,
      observed_at: observed,
      via: this.via,
    };
    const unavailable = (reason: string): ProviderUsageReport => ({ status: "unavailable", ...base, reason });
    const env = this.#opts.env ?? process.env;
    const pathEnv = this.#opts.pathEnv ?? env.PATH;
    const platform = this.#opts.platform ?? process.platform;
    const exe = this.#opts.executable ?? resolveOnPath(KIMI_BINARY, pathEnv);
    if (exe === undefined) return unavailable(`${KIMI_BINARY} not found on PATH`);
    if (unsafeExe(exe)) return unavailable("the kimi executable path cannot be passed to `script` safely");
    const args = scriptArgs(platform, exe);
    if (args === undefined) {
      return unavailable("Kimi Code plan usage needs Linux or macOS (a pseudo-terminal through `script`)");
    }
    const scriptName = this.#opts.scriptCommand ?? "script";
    const script = scriptName.includes("/") ? scriptName : resolveOnPath(scriptName, pathEnv);
    if (script === undefined) {
      return unavailable("`script` not found on PATH; it provides the pseudo-terminal the Kimi Code TUI needs");
    }
    if (this.#opts.probeDir === undefined) return unavailable(REASON_NO_PROBE_DIR);
    const probe = await prepareProbeDir(this.#opts.probeDir);
    if (!probe.ok) return unavailable(probe.reason);
    const timeoutMs = this.#opts.timeoutMs ?? DEFAULT_KIMI_USAGE_TIMEOUT_MS;
    const outcome = await driveUsage({
      spawnImpl: this.#opts.spawnImpl ?? (nodeSpawn as SpawnImpl),
      command: script,
      args,
      cwd: probe.realPath,
      env: kimiUsageEnv(env),
      timeoutMs,
      keyDelayMs: this.#opts.keyDelayMs ?? 150,
      readyWaitMs: this.#opts.readyWaitMs ?? 15_000,
    });
    switch (outcome.kind) {
      case "spawn_error":
        return unavailable("could not start the Kimi Code TUI through `script`");
      case "exited":
        return unavailable("the Kimi Code TUI exited before it showed plan usage");
      case "timeout":
        return unavailable(`the Kimi Code TUI did not show plan usage within ${Math.round(timeoutMs / 1000)} s`);
      case "input_refused":
        return unavailable("the Kimi Code TUI did not show /usage in its input line; Enter was not sent");
      case "not_logged_in":
        return unavailable(REASON_NOT_LOGGED_IN);
      case "not_ready":
        return unavailable(REASON_NOT_READY);
      case "trust_refused":
        return unavailable(REASON_TRUST_REFUSED);
      case "settled": {
        const panel = parseKimiUsagePanel(outcome.text, now);
        if (panel.kind === "ok") return { status: "ok", ...base, windows: panel.windows, balances: panel.balances };
        if (panel.kind === "error") return unavailable(`Kimi Code reported: ${panel.reason}`);
        if (panel.kind === "not_logged_in") return unavailable(REASON_NOT_LOGGED_IN);
        return unavailable(REASON_NO_PLAN_SECTION);
      }
    }
  }
}

type DriveOutcome =
  | { kind: "spawn_error" }
  | { kind: "exited" }
  | { kind: "timeout" }
  | { kind: "input_refused" }
  | { kind: "not_logged_in" }
  | { kind: "not_ready" }
  | { kind: "trust_refused" }
  | { kind: "settled"; text: string };

interface DriveOptions {
  spawnImpl: SpawnImpl;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  keyDelayMs: number;
  readyWaitMs: number;
}

/** Runs the TUI, types `/usage`, waits for the panel and always stops the process group before returning. */
async function driveUsage(o: DriveOptions): Promise<DriveOutcome> {
  const deadline = Date.now() + o.timeoutMs;
  const events = new EventEmitter();
  let buf = "";
  let dropped = 0; // characters dropped from the head of `buf` by the cap
  let exited = false;
  let spawnError = false;
  let child: ChildProcess;
  try {
    child = o.spawnImpl(o.command, o.args, {
      cwd: o.cwd,
      env: o.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return { kind: "spawn_error" };
  }
  const onChunk = (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (buf.length > MAX_KIMI_USAGE_OUTPUT_CHARS) {
      const cut = buf.length - MAX_KIMI_USAGE_OUTPUT_CHARS;
      buf = buf.slice(cut);
      dropped += cut;
    }
    events.emit("change");
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", () => undefined); // drained, never kept
  child.stdin?.on("error", () => undefined);
  child.on("error", () => {
    spawnError = true;
    exited = true;
    events.emit("change");
  });
  child.on("exit", () => {
    exited = true;
    events.emit("change");
  });
  const since = (abs: number) => buf.slice(Math.max(0, abs - dropped));
  const mark = () => dropped + buf.length;
  const write = (s: string) => {
    if (!exited && child.stdin?.writable) child.stdin.write(s);
  };
  const waitFor = (pred: () => boolean, ms: number) =>
    new Promise<boolean>((resolve) => {
      if (pred()) return resolve(true);
      const done = (v: boolean) => {
        clearTimeout(timer);
        events.off("change", check);
        resolve(v);
      };
      const check = () => {
        if (pred()) done(true);
      };
      const timer = setTimeout(() => done(pred()), Math.max(0, ms));
      events.on("change", check);
    });
  const remaining = () => deadline - Date.now();
  const notLoggedIn = (text: string) => stripTerminal(text).some((l) => NOT_LOGGED_IN.some((re) => re.test(l)));
  const ready = (text: string) => stripTerminal(text).some((l) => l.includes("context:"));
  const trustShown = (text: string) => stripTerminal(text).includes(TRUST_QUESTION);

  const run = async (): Promise<DriveOutcome> => {
    await waitFor(
      () => exited || ready(buf) || trustShown(buf) || notLoggedIn(buf),
      Math.min(o.readyWaitMs, remaining()),
    );
    if (spawnError) return { kind: "spawn_error" };
    if (notLoggedIn(buf)) return { kind: "not_logged_in" };
    if (exited) return { kind: "exited" };
    if (trustShown(buf)) {
      // Let the dialog finish drawing (its selected option line), then answer it once, only if it names this folder.
      await waitFor(() => exited || trustDialogDrawn(stripTerminal(buf)), Math.min(3_000, remaining()));
      if (exited) return { kind: "exited" };
      if (!trustDialogMatches(stripTerminal(buf), o.cwd)) return { kind: "trust_refused" };
      const answeredAt = mark();
      write("\r");
      await waitFor(
        () => exited || ready(since(answeredAt)) || trustShown(since(answeredAt)),
        Math.min(o.readyWaitMs, remaining()),
      );
      if (exited) return { kind: "exited" };
      if (trustShown(since(answeredAt))) return { kind: "trust_refused" }; // never answered twice
      if (!ready(since(answeredAt))) return remaining() <= 0 ? { kind: "timeout" } : { kind: "not_ready" };
    } else if (!ready(buf)) {
      return remaining() <= 0 ? { kind: "timeout" } : { kind: "not_ready" };
    }
    const typedAt = mark();
    for (const c of "/usage") {
      write(c);
      await sleep(o.keyDelayMs);
      if (exited) return { kind: "exited" };
    }
    const echoed = await waitFor(
      () => exited || inputShowsUsage(stripTerminal(since(typedAt))),
      Math.min(3_000, remaining()),
    );
    if (exited) return { kind: "exited" };
    if (!echoed || !inputShowsUsage(stripTerminal(since(typedAt)))) {
      return remaining() <= 0 ? { kind: "timeout" } : { kind: "input_refused" };
    }
    const enterAt = mark();
    write("\r");
    const settled = await waitFor(() => exited || kimiUsagePanelSettled(stripTerminal(since(enterAt))), remaining());
    const text = since(enterAt);
    if (kimiUsagePanelSettled(stripTerminal(text))) return { kind: "settled", text };
    return settled ? { kind: "exited" } : { kind: "timeout" };
  };

  try {
    return await run();
  } finally {
    await stop(child, () => exited, write, waitFor);
    buf = "";
  }
}

/** Ctrl-C twice, then SIGTERM to the process group after about 1 s, then SIGKILL after about 3 s. */
async function stop(
  child: ChildProcess,
  isExited: () => boolean,
  write: (s: string) => void,
  waitFor: (pred: () => boolean, ms: number) => Promise<boolean>,
): Promise<void> {
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    }
  };
  if (!isExited()) {
    write("\u0003");
    await sleep(200);
    write("\u0003");
    if (!(await waitFor(isExited, 1_000))) {
      signal("SIGTERM");
      if (!(await waitFor(isExited, 2_000))) {
        signal("SIGKILL");
        await waitFor(isExited, 1_000);
      }
    }
  }
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}
