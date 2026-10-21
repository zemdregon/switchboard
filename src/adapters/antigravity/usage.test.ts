/**
 * T6.20 (FR-CAP-13, LLD §16.10, ADR-0082 on the ADR-0079 reader): Antigravity's provider-reported usage from
 * `agy -p "/usage"` and `/credits`, on the recorded `agy` 1.4.3 fixtures in `fixtures/usage/` (see its README). No
 * provider CLI runs here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProbeOutput, ProbeRunner } from "../types.js";
import { AntigravityAdapter } from "./adapter.js";
import {
  AGY_CREDITS_ARGS,
  AGY_USAGE_ARGS,
  AGY_USAGE_METHOD,
  AGY_USAGE_TIMEOUT_MS,
  parseAgyCredits,
  parseAgyUsage,
} from "./usage.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "usage");
const fixture = (name: string) => readFileSync(path.join(dir, name), "utf8");
const USAGE = fixture("usage-1.4.3.jsonl");
const CREDITS = fixture("credits-1.4.3.jsonl");
const LOGGED_OUT = fixture("usage-logged-out-1.4.3.jsonl");
const NOW = new Date("2026-10-21T03:00:00.000Z");
const MODELS_OK = "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n";
const MODELS_LOGGED_OUT =
  "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n";

const out = (stdout: string, extra: Partial<ProbeOutput> = {}): ProbeOutput => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  ...extra,
});

/** A runner answering by argv; records every call. */
function runner(answers: { models?: ProbeOutput; usage?: ProbeOutput; credits?: ProbeOutput }) {
  const calls: { argv: readonly string[]; cwd?: string; timeoutMs?: number }[] = [];
  const run: ProbeRunner = async (argv, opts) => {
    calls.push({
      argv,
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    if (argv.includes("models")) return answers.models ?? out(MODELS_OK);
    if (argv.includes("/usage")) return answers.usage ?? out(USAGE);
    if (argv.includes("/credits")) return answers.credits ?? out(CREDITS);
    return out("", { exitCode: 2 });
  };
  return { run, calls };
}

describe("parseAgyUsage (recorded agy 1.4.3)", () => {
  it("reads every bucket of every group with remaining, used, window length and reset", () => {
    const r = parseAgyUsage(USAGE);
    if ("reason" in r) throw new Error(r.reason);
    expect(r.windows.map((w) => [w.id, w.limit_id, w.window_seconds])).toEqual([
      ["gemini-weekly", "Gemini Models", 604800],
      ["gemini-5h", "Gemini Models", 18000],
      ["3p-weekly", "Claude and GPT models", 604800],
      ["3p-5h", "Claude and GPT models", 18000],
      ["gemini-argon-wtu-weekly", "Gemini 4 Argon", 604800],
    ]);
    expect(r.windows[0]).toEqual({
      id: "gemini-weekly",
      limit_id: "Gemini Models",
      window_seconds: 604800,
      used_fraction: 0.863692,
      remaining_fraction: 0.136308,
      resets_at: "2026-10-24T07:21:04.000Z",
    });
    for (const w of r.windows) {
      expect(w.remaining_fraction + w.used_fraction).toBeCloseTo(1, 6);
      expect(w.resets_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    }
  });

  it("refuses a logged-out answer, a non-JSON answer and an answer that started a turn", () => {
    expect(parseAgyUsage(LOGGED_OUT)).toEqual({ reason: "status ERROR: authentication failed or timed out" });
    expect(parseAgyUsage("Gemini Models\tWeekly Limit Remaining\t13%\t2026-10-24T07:21:04Z\n")).toEqual({
      reason: "no JSON result on stdout",
    });
    const turned = JSON.parse(USAGE) as Record<string, unknown>;
    turned.num_turns = 1;
    expect(parseAgyUsage(JSON.stringify(turned))).toEqual({ reason: "the answer started an agent turn" });
    const credits = parseAgyUsage(CREDITS);
    expect(credits).toEqual({ reason: "no usage command payload" });
  });

  it("drops a bucket with an out-of-range fraction, a bad reset, an unsafe id or a prototype key (fail closed)", () => {
    const doc = JSON.parse(USAGE) as { command: { data: { groups: { buckets: Record<string, unknown>[] }[] } } };
    const [g0, g1, g2] = doc.command.data.groups;
    if (g0 === undefined || g1 === undefined || g2 === undefined) throw new Error("fixture shape");
    (g0.buckets[0] as Record<string, unknown>).remaining_fraction = 1.5;
    (g0.buckets[1] as Record<string, unknown>).reset_time = "soon";
    (g1.buckets[0] as Record<string, unknown>).id = "../etc";
    g1.buckets[1] = JSON.parse('{"__proto__":{"id":"x","window":"5h","remaining_fraction":0.5}}');
    const r = parseAgyUsage(JSON.stringify(doc));
    if ("reason" in r) throw new Error(r.reason);
    expect(r.windows.map((w) => w.id)).toEqual(["gemini-argon-wtu-weekly"]);
    g2.buckets = [];
    expect(parseAgyUsage(JSON.stringify(doc))).toEqual({ reason: "usage payload has no valid bucket" });
  });

  it("keeps an unknown window kind with a null length and a missing reset as null", () => {
    const doc = JSON.parse(USAGE) as { command: { data: { groups: { buckets: Record<string, unknown>[] }[] } } };
    const b = doc.command.data.groups[0]?.buckets[0] as Record<string, unknown>;
    b.window = "monthly";
    delete b.reset_time;
    const r = parseAgyUsage(JSON.stringify(doc));
    if ("reason" in r) throw new Error(r.reason);
    expect(r.windows[0]).toMatchObject({ id: "gemini-weekly", window_seconds: null, resets_at: null });
  });
});

describe("parseAgyCredits (recorded agy 1.4.3)", () => {
  it("reads remaining_credits as the credit balance and nothing from another payload", () => {
    expect(parseAgyCredits(CREDITS)).toEqual({ has_credits: false, unlimited: false, balance: "0" });
    expect(parseAgyCredits(USAGE)).toBeUndefined();
    expect(parseAgyCredits(LOGGED_OUT)).toBeUndefined();
  });
});

describe("AntigravityAdapter.readProviderUsage", () => {
  const adapter = () => new AntigravityAdapter({ executable: "/opt/agy/agy" });

  it("checks the login with agy models first, then runs /usage and /credits outside any workspace", async () => {
    const { run, calls } = runner({});
    const r = await adapter().readProviderUsage(run, NOW);
    expect(calls[0]?.argv).toEqual(["/opt/agy/agy", "models"]);
    expect(calls.slice(1).map((c) => c.argv)).toEqual([
      ["/opt/agy/agy", ...AGY_USAGE_ARGS],
      ["/opt/agy/agy", ...AGY_CREDITS_ARGS],
    ]);
    for (const c of calls.slice(1)) expect(c).toMatchObject({ timeoutMs: AGY_USAGE_TIMEOUT_MS });
    expect(r).toMatchObject({
      provider: "antigravity",
      source: "provider_reported",
      observed_at: NOW.toISOString(),
      method: AGY_USAGE_METHOD,
      plan: null,
      limit_reached: null,
      limit_reached_type: null,
      credits: { has_credits: false, unlimited: false, balance: "0" },
    });
    if (r.source !== "provider_reported") throw new Error("expected a report");
    expect(r.windows).toHaveLength(5);
  });

  it("never runs /usage when agy models says signed out (it would wait for a sign-in)", async () => {
    const { run, calls } = runner({ models: out("", { exitCode: 1, stderr: MODELS_LOGGED_OUT }) });
    const r = await adapter().readProviderUsage(run, NOW);
    expect(calls.map((c) => c.argv.slice(1))).toEqual([["models"]]);
    expect(r).toEqual({
      provider: "antigravity",
      source: "unknown",
      observed_at: NOW.toISOString(),
      method: AGY_USAGE_METHOD,
      error: "agy is not signed in; run `agy` to sign in",
    });
  });

  it("an unknown login state, a timeout, a spawn error or a logged-out answer is unknown with no figure", async () => {
    const cases: { models?: ProbeOutput; usage?: ProbeOutput; detail: RegExp }[] = [
      { models: out("weird"), detail: /not a recognised login state/ },
      { usage: out("", { timedOut: true, exitCode: null }), detail: /timed out/ },
      { usage: out("", { spawnError: "ENOENT", exitCode: null }), detail: /could not be started/ },
      { usage: out(LOGGED_OUT, { exitCode: 1 }), detail: /exit 1: status ERROR/ },
    ];
    for (const c of cases) {
      const r = await adapter().readProviderUsage(runner(c).run, NOW);
      if (r.source !== "unknown") throw new Error("expected unknown");
      expect(r).not.toHaveProperty("windows");
      expect(r.error).toMatch(c.detail);
    }
  });

  it("a failed /credits leaves credits null and the windows reported", async () => {
    const r = await adapter().readProviderUsage(
      runner({ credits: out("", { timedOut: true, exitCode: null }) }).run,
      NOW,
    );
    if (r.source !== "provider_reported") throw new Error("expected a report");
    expect(r.windows).toHaveLength(5);
    expect(r.credits).toBeNull();
  });

  it("without a binary on PATH it spawns nothing", async () => {
    const { run, calls } = runner({});
    const r = await new AntigravityAdapter({ pathEnv: "/nonexistent" }).readProviderUsage(run, NOW);
    expect(calls).toEqual([]);
    expect(r).toMatchObject({ source: "unknown", error: "agy not found on PATH" });
  });

  it("the recorded fixtures carry no account identifier", () => {
    for (const s of [USAGE, CREDITS, LOGGED_OUT]) {
      expect(s).not.toMatch(/@|ya29\.|"(email|account|token|access_token|refresh_token)"/i);
    }
  });
});
