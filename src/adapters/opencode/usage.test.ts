/**
 * OpenCode provider-reported spend (ADR-0089, FR-CAP-16, BR-63, LLD §16.13). No OpenCode CLI is run: a fake
 * ProbeRunner answers with the recorded fixtures.
 *
 * _fixture: `fixtures/usage/stats-{5h,7d,30d}.stdout.txt` were recorded 2026-10-21 on the operator host from opencode
 * v2.0.23 with `opencode api --standalone experimental.session.stats --param from=<epoch ms> --param to=<epoch ms>
 * --param tools=none`, `to` = `fixtures/usage/now.txt` and `from` = `to` minus 5 hours, 7 days and 30 days. Kept
 * verbatim; nothing is redacted because the output carries no account id, email or credential (model ids only).
 * `synthetic-http-500.stdout.txt` reproduces what bad input prints (with exit 0); `synthetic-malformed.stdout.txt` is
 * truncated JSON. Both are synthetic.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProviderUsageReport, ProviderUsageResult, ProviderUsageUnavailable } from "../provider-usage.js";
import type { ProbeOutput, ProbeRunner } from "../types.js";
import { OpenCodeAdapter } from "./adapter.js";
import {
  MAX_USAGE_MODELS,
  OPENCODE_USAGE_METHOD,
  type OpenCodeSessionStats,
  parseSessionStats,
  spendWindow,
} from "./usage.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "usage");
const fixture = (name: string) => readFileSync(path.join(DIR, name), "utf8");
const TO = Number(fixture("now.txt").trim());
const NOW = new Date(TO);
const H5 = { from: TO - 18_000_000, to: TO };
const D7 = { from: TO - 604_800_000, to: TO };
const D30 = { from: TO - 2_592_000_000, to: TO };

const ok = (stdout: string): ProbeOutput => ({ exitCode: 0, stdout, stderr: "", timedOut: false });

/** Answers by the `from=` parameter, as the real CLI would; records every argv. */
function fakeRunner(answers: Record<number, ProbeOutput>): { runner: ProbeRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: ProbeRunner = async (argv) => {
    calls.push([...argv]);
    const from = Number(argv.find((a) => a.startsWith("from="))?.slice(5));
    return answers[from] ?? ok("HTTP 500 Internal Server Error\n");
  };
  return { runner, calls };
}

const recorded = () => ({
  [H5.from]: ok(fixture("stats-5h.stdout.txt")),
  [D7.from]: ok(fixture("stats-7d.stdout.txt")),
  [D30.from]: ok(fixture("stats-30d.stdout.txt")),
});

const adapter = () => new OpenCodeAdapter({ executable: "/opt/opencode/bin/opencode" });
const read = (runner: ProbeRunner) => adapter().readProviderUsage(runner, NOW);
function asReport(r: ProviderUsageResult): ProviderUsageReport {
  if (r.source !== "provider_reported") throw new Error(`unexpected unknown: ${r.error}`);
  return r;
}
function asUnknown(r: ProviderUsageResult): ProviderUsageUnavailable {
  if (r.source !== "unknown") throw new Error("expected unknown");
  return r;
}

describe("parseSessionStats on the recorded fixtures", () => {
  it("30 days: the reported cost, counts and tokens as reported", () => {
    const r = parseSessionStats(fixture("stats-30d.stdout.txt"), D30);
    if (!r.ok) throw new Error(r.error);
    expect(r.stats.cost).toBe(14.401603773000007);
    expect(r.stats).toMatchObject({ sessions: 655, steps: 24471 });
    expect(r.stats.tokens).toEqual({
      input: 77361885,
      output: 5593609,
      reasoning: 5493389,
      cache_read: 2582075248,
      cache_write: 0,
    });
    expect(r.stats.models).toHaveLength(11);
  });

  it("5 hours: every figure zero, no models", () => {
    const r = parseSessionStats(fixture("stats-5h.stdout.txt"), H5);
    if (!r.ok) throw new Error(r.error);
    expect(r.stats).toEqual({
      cost: 0,
      sessions: 0,
      steps: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      models: [],
    });
  });

  it("the HTTP 500 text OpenCode prints with exit 0, and truncated JSON, are not JSON", () => {
    expect(parseSessionStats(fixture("synthetic-http-500.stdout.txt"), H5)).toEqual({
      ok: false,
      error: "output is not JSON",
    });
    expect(parseSessionStats(fixture("synthetic-malformed.stdout.txt"), H5)).toEqual({
      ok: false,
      error: "output is not JSON",
    });
  });

  it("a range that does not echo the request is refused", () => {
    const r = parseSessionStats(fixture("stats-7d.stdout.txt"), { from: D7.from + 1, to: D7.to });
    expect(r).toEqual({ ok: false, error: "the reported range does not match the request" });
  });

  it("fails closed on a wrong shape: negative or non-finite cost, missing tokens, bad model, inherited keys", () => {
    const base = JSON.parse(fixture("stats-7d.stdout.txt"));
    const variant = (edit: (d: Record<string, unknown>) => void) => {
      const doc = structuredClone(base);
      edit(doc.data);
      return parseSessionStats(JSON.stringify(doc), D7);
    };
    expect(variant((d) => (d.cost = -1)).ok).toBe(false);
    expect(variant((d) => (d.cost = "12")).ok).toBe(false);
    expect(variant((d) => delete d.tokens).ok).toBe(false);
    expect(variant((d) => (d.models = [{ model: { id: 1, providerID: "x" }, steps: 1, cost: 0 }])).ok).toBe(false);
    expect(variant((d) => (d.models = {})).ok).toBe(false);
    expect(parseSessionStats("[]", D7).ok).toBe(false);
    expect(parseSessionStats('{"__proto__":{"data":{}}}', D7).ok).toBe(false);
    expect(parseSessionStats("1e999", D7).ok).toBe(false);
  });
});

describe("spendWindow", () => {
  it("the reported cost is the amount in usd, with no limit, remaining or reset; models sorted by cost", () => {
    const r = parseSessionStats(fixture("stats-30d.stdout.txt"), D30);
    if (!r.ok) throw new Error(r.error);
    const w = spendWindow("monthly", 2_592_000, D30, r.stats);
    expect(w).toMatchObject({
      id: "monthly",
      window_seconds: 2_592_000,
      from: new Date(D30.from).toISOString(),
      to: new Date(D30.to).toISOString(),
      amount: 14.401603773000007,
      unit: "usd",
    });
    expect(Object.keys(w).sort()).toEqual(["amount", "detail", "from", "id", "to", "unit", "window_seconds"]);
    const models = (w.detail?.models ?? []) as { provider_id: string; model_id: string; cost_usd: number }[];
    expect(models.slice(0, 2)).toEqual([
      {
        provider_id: "opencode-go",
        model_id: "muse-spark-1.3-contributor",
        cost_usd: 12.672632952000056,
        steps: 21220,
      },
      { provider_id: "opencode-go", model_id: "deepseek-v4.1-flash", cost_usd: 1.7289708209999999, steps: 857 },
    ]);
    // Free models tie at 0 and are ordered by provider then model id.
    expect(models.slice(2).map((m) => `${m.provider_id}/${m.model_id}`)).toEqual([
      "opencode-go/space-bunny-free",
      "opencode/big-pickle",
      "opencode/cat-jam-free",
      "opencode/deepseek-v4.1-flash",
      "opencode/fledge-alpha-free",
      "opencode/gpt-5-nano",
      "opencode/longcat-2.5-preview-free",
      "opencode/mimo-v2.6-flash-free",
      "opencode/space-bunny-free",
    ]);
    expect(w.detail).not.toHaveProperty("models_omitted");
  });

  it("caps the model list and says how many were left out", () => {
    const stats: OpenCodeSessionStats = {
      cost: 1,
      sessions: 1,
      steps: 30,
      tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      models: Array.from({ length: 25 }, (_, i) => ({ provider_id: "p", model_id: `m${i}`, cost_usd: i, steps: 1 })),
    };
    const w = spendWindow("weekly", 604_800, D7, stats);
    expect(w.detail?.models).toHaveLength(MAX_USAGE_MODELS);
    expect(w.detail?.models_omitted).toBe(5);
    const models = (w.detail?.models ?? []) as { model_id: string }[];
    expect(models[0]?.model_id).toBe("m24");
  });
});

describe("OpenCodeAdapter.readProviderUsage", () => {
  it("reads three rolling windows, one after another, with the documented argv", async () => {
    const { runner, calls } = fakeRunner(recorded());
    const report = asReport(await read(runner));
    expect(report).toMatchObject({
      provider: "opencode",
      source: "provider_reported",
      method: OPENCODE_USAGE_METHOD,
      observed_at: NOW.toISOString(),
      plan: null,
      limit_reached: null,
      limit_reached_type: null,
      windows: [],
      credits: null,
    });
    expect(report.method).toBe("opencode api --standalone experimental.session.stats");
    expect(report.spend_windows?.map((w) => [w.id, w.window_seconds, w.amount, w.unit])).toEqual([
      ["five_hour", 18_000, 0, "usd"],
      ["weekly", 604_800, 12.454677125000059, "usd"],
      ["monthly", 2_592_000, 14.401603773000007, "usd"],
    ]);
    expect(calls).toEqual(
      [H5, D7, D30].map((w) => [
        "/opt/opencode/bin/opencode",
        "api",
        "--standalone",
        "experimental.session.stats",
        "--param",
        `from=${w.from}`,
        "--param",
        `to=${w.to}`,
        "--param",
        "tools=none",
      ]),
    );
    expect(report.note).toMatch(/does not report a plan limit, what is left of it or a reset time/);
    expect(report.note).toContain("https://opencode.ai/docs/go");
    expect(report.scope).toMatch(/including use outside Switchboard/);
  });

  it("puts the launcher between the executable and the stats arguments", async () => {
    const { runner, calls } = fakeRunner(recorded());
    const a = new OpenCodeAdapter({ executable: "/usr/bin/node", launcherArgs: ["/opt/opencode/cli.js"] });
    await a.readProviderUsage(runner, NOW);
    expect(calls[0]?.slice(0, 3)).toEqual(["/usr/bin/node", "/opt/opencode/cli.js", "api"]);
  });

  it("asks each window with a 20 s timeout and no stdin", async () => {
    const opts: unknown[] = [];
    const inner = fakeRunner(recorded()).runner;
    const runner: ProbeRunner = async (argv, o) => {
      opts.push(o);
      return inner(argv, o);
    };
    await read(runner);
    expect(opts).toEqual([{ timeoutMs: 20_000 }, { timeoutMs: 20_000 }, { timeoutMs: 20_000 }]);
  });

  it("HTTP 500 text with exit 0 is unknown, with no raw output and no later window run", async () => {
    const { runner, calls } = fakeRunner({ [H5.from]: ok(fixture("synthetic-http-500.stdout.txt")) });
    const r = asUnknown(await read(runner));
    expect(r).toEqual({
      provider: "opencode",
      source: "unknown",
      observed_at: NOW.toISOString(),
      method: OPENCODE_USAGE_METHOD,
      error: "session stats (five_hour): output is not JSON",
    });
    expect(JSON.stringify(r)).not.toContain("Internal Server Error");
    expect(calls).toHaveLength(1);
  });

  it("malformed JSON in a later window makes the whole read unknown", async () => {
    const answers = recorded();
    answers[D30.from] = ok(fixture("synthetic-malformed.stdout.txt"));
    const r = asUnknown(await read(fakeRunner(answers).runner));
    expect(r.error).toBe("session stats (monthly): output is not JSON");
    expect(r).not.toHaveProperty("spend_windows");
  });

  it("a range echo mismatch is unknown", async () => {
    const answers = recorded();
    answers[H5.from] = ok(fixture("stats-7d.stdout.txt")); // 7-day range answered to the 5-hour request
    const r = asUnknown(await read(fakeRunner(answers).runner));
    expect(r.error).toMatch(/range does not match the request/);
  });

  it("spawn error, timeout and a non-zero exit are unknown; stderr and the spawn error are never copied", async () => {
    const fail = async (out: Partial<ProbeOutput>) => {
      const runner: ProbeRunner = async () => ({
        exitCode: null,
        stdout: "",
        stderr: "secret-ish stderr text",
        timedOut: false,
        ...out,
      });
      return asUnknown(await read(runner));
    };
    const spawn = await fail({ spawnError: "ENOENT" });
    expect(spawn.error).toBe("session stats (five_hour): could not start opencode");
    expect((await fail({ timedOut: true })).error).toMatch(/timed out$/);
    expect((await fail({ exitCode: 3 })).error).toMatch(/exited 3$/);
    for (const r of [spawn, await fail({ exitCode: 1 })]) {
      expect(JSON.stringify(r)).not.toContain("stderr text");
      expect(JSON.stringify(r)).not.toContain("ENOENT");
    }
  });

  it("with no opencode on PATH nothing is run", async () => {
    const { runner, calls } = fakeRunner(recorded());
    const r = asUnknown(await new OpenCodeAdapter({ pathEnv: "/nonexistent-dir" }).readProviderUsage(runner, NOW));
    expect(r.error).toBe("opencode not found on PATH");
    expect(calls).toEqual([]);
  });
});
