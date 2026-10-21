/**
 * Grok provider-reported usage (ADR-0079, FR-CAP-13, LLD §16.10). The parser runs over the recorded `_x.ai/billing`
 * answer of 2026-10-21 (grok 1.0.50, SuperGrok weekly account) and a synthetic shape carrying the fields that account
 * did not report. The adapter method runs with a fake probe runner: no Grok CLI, login or network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProbeOutput, ProbeRunner } from "../types.js";
import { GrokAdapter } from "./adapter.js";
import {
  GROK_USAGE_ARGS,
  GROK_USAGE_METHOD,
  GROK_USAGE_STDIN,
  GROK_USAGE_TIMEOUT_MS,
  grokUsageFromResult,
  grokUsageFromStdout,
  isGrokUsageAnswer,
} from "./usage.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixtureText = (name: string) => readFileSync(path.join(HERE, "fixtures", name), "utf8");
const fixture = (name: string): unknown => JSON.parse(fixtureText(name));
const AT = "2026-10-21T02:36:26.000Z";

describe("grokUsageFromResult", () => {
  it("maps the recorded SuperGrok answer: a weekly period, three zero amounts, no window, unreported keys", () => {
    expect(grokUsageFromResult(fixture("billing-supergrok-weekly.json"), AT)).toEqual({
      provider: "grok",
      source: "provider_reported",
      observed_at: AT,
      method: GROK_USAGE_METHOD,
      plan: "SuperGrok",
      limit_reached: null,
      limit_reached_type: null,
      windows: [],
      credits: null,
      period: { kind: "weekly", starts_at: "2026-10-19T15:37:46.149Z", resets_at: "2026-10-26T15:37:46.149Z" },
      amounts: [
        { id: "prepaid_balance", value: 0, unit: "unspecified", key: "config.prepaidBalance" },
        { id: "on_demand_cap", value: 0, unit: "unspecified", key: "config.onDemandCap" },
        { id: "on_demand_used", value: 0, unit: "unspecified", key: "config.onDemandUsed" },
      ],
      unreported: ["config.creditUsagePercent", "config.monthlyLimit"],
    });
  });

  it("maps a synthetic answer with creditUsagePercent to one credit_period window and all four amounts", () => {
    const r = grokUsageFromResult(fixture("billing-with-usage.synthetic.json"), AT);
    if (r.source !== "provider_reported") throw new Error("unreachable");
    expect(r.plan).toBe("SuperGrok Heavy");
    expect(r.period).toEqual({
      kind: "monthly",
      starts_at: "2026-10-01T00:00:00.000Z",
      resets_at: "2026-11-01T00:00:00.000Z",
    });
    expect(r.windows).toEqual([
      {
        id: "credit_period",
        limit_id: null,
        window_seconds: 31 * 86_400,
        used_fraction: 0.425,
        remaining_fraction: 0.575,
        resets_at: "2026-11-01T00:00:00.000Z",
      },
    ]);
    expect(r.amounts?.map((a) => [a.id, a.value])).toEqual([
      ["prepaid_balance", 7],
      ["on_demand_cap", 20],
      ["on_demand_used", 3.5],
      ["monthly_limit", 100],
    ]);
    expect(r.unreported).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/history|unknownField|USD/);
  });

  it("falls back to the billing period, omits period when none exists, and clamps the percentage", () => {
    const r = grokUsageFromResult(
      {
        config: {
          billingPeriodStart: "2026-10-19T00:00:00Z",
          billingPeriodEnd: "2026-10-26T00:00:00Z",
          creditUsagePercent: 140,
        },
      },
      AT,
    );
    if (r.source !== "provider_reported") throw new Error("unreachable");
    expect(r.period).toEqual({
      kind: "unknown",
      starts_at: "2026-10-19T00:00:00.000Z",
      resets_at: "2026-10-26T00:00:00.000Z",
    });
    expect(r.windows[0]).toMatchObject({ used_fraction: 1, remaining_fraction: 0, window_seconds: 604_800 });
    expect(r.plan).toBeNull();
    const bare = grokUsageFromResult({ config: {}, subscription_tier: "x".repeat(65) }, AT);
    expect(bare).not.toHaveProperty("period");
    expect(bare).toMatchObject({ plan: null, windows: [] });
  });

  it("a result without config is unknown, never headroom", () => {
    expect(grokUsageFromResult({ subscription_tier: "SuperGrok" }, AT)).toEqual({
      provider: "grok",
      source: "unknown",
      observed_at: AT,
      method: GROK_USAGE_METHOD,
      error: "_x.ai/billing answered without config",
    });
  });
});

describe("grokUsageFromStdout", () => {
  it("skips junk lines, notifications and the initialize answer, and takes the id 2 result", () => {
    const r = grokUsageFromStdout(fixtureText("billing-rpc-answer.synthetic.jsonl"), AT);
    expect(r).toMatchObject({ source: "provider_reported", plan: "SuperGrok", period: { kind: "weekly" } });
    expect(JSON.stringify(r)).not.toMatch(/example-host|agentInfo/);
  });

  it("a JSON-RPC error or a missing answer is unknown", () => {
    const err = '{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"not signed in\\u0007"}}\n';
    expect(grokUsageFromStdout(err, AT)).toMatchObject({
      source: "unknown",
      error: "_x.ai/billing failed: not signed in",
    });
    expect(grokUsageFromStdout('{"id":1,"result":{}}\n', AT)).toMatchObject({
      source: "unknown",
      error: "no answer to _x.ai/billing",
    });
  });
});

describe("GrokAdapter.readProviderUsage", () => {
  const out = (o: Partial<ProbeOutput>): ProbeOutput => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...o,
  });

  it("runs `grok agent --no-leader stdio`, holds stdin until id 2 answers, and parses stdout", async () => {
    const calls: { argv: readonly string[]; opts: Parameters<ProbeRunner>[1] }[] = [];
    const runner: ProbeRunner = async (argv, opts) => {
      calls.push({ argv, opts });
      return out({ stdout: fixtureText("billing-rpc-answer.synthetic.jsonl") });
    };
    const r = await new GrokAdapter({ executable: "/opt/grok" }).readProviderUsage(runner, new Date(AT));
    expect(r.source).toBe("provider_reported");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(["/opt/grok", ...GROK_USAGE_ARGS]);
    expect(calls[0]?.opts?.stdinText).toBe(GROK_USAGE_STDIN);
    expect(calls[0]?.opts?.timeoutMs).toBe(GROK_USAGE_TIMEOUT_MS);
    const hold = calls[0]?.opts?.holdStdinUntil;
    expect(hold?.({ id: 2, result: {} })).toBe(true);
    expect(hold?.({ id: 1, result: {} })).toBe(false);
    expect(hold?.({ method: "_x.ai/session/update" })).toBe(false);
    const methods = GROK_USAGE_STDIN.trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { method: string }).method);
    expect(methods).toEqual(["initialize", "_x.ai/billing"]);
    expect(isGrokUsageAnswer(null)).toBe(false);
  });

  it("no binary, a spawn failure or a timeout is unknown with a reason", async () => {
    const never: ProbeRunner = async () => {
      throw new Error("must not run");
    };
    expect(await new GrokAdapter({ pathEnv: "" }).readProviderUsage(never, new Date(AT))).toMatchObject({
      source: "unknown",
      error: "grok not found on PATH",
    });
    const spawnFail: ProbeRunner = async () => out({ exitCode: null, spawnError: "ENOENT" });
    expect(await new GrokAdapter({ executable: "/x" }).readProviderUsage(spawnFail, new Date(AT))).toMatchObject({
      source: "unknown",
      error: "could not start grok agent (ENOENT)",
    });
    const slow: ProbeRunner = async () => out({ exitCode: null, timedOut: true });
    expect(await new GrokAdapter({ executable: "/x" }).readProviderUsage(slow, new Date(AT))).toMatchObject({
      source: "unknown",
      error: "grok agent timed out before answering",
    });
  });
});
