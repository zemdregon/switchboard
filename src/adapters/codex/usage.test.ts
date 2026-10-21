/**
 * Codex provider-reported usage (ADR-0079, FR-CAP-13, LLD §16.10). The parser runs over the recorded, redacted
 * `codex app-server` answer of 2026-10-21 (docs/research/codex-usage-2026-10-21.md) and two synthetic shapes from the
 * generated protocol schema (a reached limit with a second bucket, and a JSON-RPC error). The adapter method runs
 * with a fake probe runner: no Codex CLI, login or network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProbeOutput, ProbeRunner } from "../types.js";
import { CodexAdapter } from "./adapter.js";
import {
  CODEX_USAGE_ARGS,
  CODEX_USAGE_METHOD,
  CODEX_USAGE_STDIN,
  codexUsageFromResult,
  codexUsageFromStdout,
  isCodexUsageAnswer,
} from "./usage.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(path.join(HERE, "fixtures", "usage", name), "utf8");
const AT = "2026-10-21T02:36:26.000Z";

describe("codexUsageFromStdout", () => {
  it("maps the recorded app-server answer to provider_reported windows, plan and credits; drops accountId", () => {
    const r = codexUsageFromStdout(fixture("app-server-rate-limits.jsonl"), AT);
    expect(r).toEqual({
      provider: "codex",
      source: "provider_reported",
      observed_at: AT,
      method: CODEX_USAGE_METHOD,
      plan: "plus",
      limit_reached: false,
      limit_reached_type: null,
      windows: [
        {
          id: "primary",
          limit_id: "codex",
          window_seconds: 18_000,
          used_fraction: 0.21,
          remaining_fraction: 0.79,
          resets_at: "2026-10-21T06:25:26.000Z",
        },
        {
          id: "secondary",
          limit_id: "codex",
          window_seconds: 604_800,
          used_fraction: 0.22,
          remaining_fraction: 0.78,
          resets_at: "2026-10-27T06:34:07.000Z",
        },
      ],
      credits: { has_credits: true, unlimited: false, balance: "100.0000000000" },
    });
    expect(JSON.stringify(r)).not.toMatch(/accountId|redacted|installationId/);
  });

  it("reports a reached limit only from the provider's own flags, and adds a second bucket's windows by limit id", () => {
    const r = codexUsageFromStdout(fixture("synthetic-limit-reached.jsonl"), AT);
    expect(r).toMatchObject({
      source: "provider_reported",
      limit_reached: true,
      limit_reached_type: "rate_limit_reached",
    });
    if (r.source !== "provider_reported") throw new Error("unreachable");
    expect(r.windows.map((w) => [w.id, w.used_fraction, w.remaining_fraction, w.resets_at])).toEqual([
      ["primary", 1, 0, "2026-10-21T06:25:26.000Z"],
      ["secondary", 0.64, 0.36, "2026-10-27T06:34:07.000Z"],
      ["codex_other:primary", 0.05, 0.95, null],
    ]);
    expect(r.credits).toEqual({ has_credits: false, unlimited: false, balance: "0" });
  });

  it("a full window without a flag is not read as reached (the schema forbids inferring it)", () => {
    const r = codexUsageFromResult(
      { rateLimits: { limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null } } },
      AT,
    );
    expect(r).toMatchObject({ source: "provider_reported", limit_reached: null, plan: null, credits: null });
  });

  it("a JSON-RPC error, a missing answer or a result without rateLimits is unknown, never headroom", () => {
    expect(codexUsageFromStdout(fixture("synthetic-rpc-error.jsonl"), AT)).toEqual({
      provider: "codex",
      source: "unknown",
      observed_at: AT,
      method: CODEX_USAGE_METHOD,
      error: "account/rateLimits/read failed: codex account authentication required to read rate limits",
    });
    expect(codexUsageFromStdout('{"id":1,"result":{}}\nnot json\n', AT)).toMatchObject({
      source: "unknown",
      error: "no answer to account/rateLimits/read",
    });
    expect(codexUsageFromResult({ accountId: "x" }, AT)).toMatchObject({ source: "unknown" });
  });

  it("out-of-range percentages are clamped and a non-numeric one drops the window", () => {
    const r = codexUsageFromResult(
      { rateLimits: { primary: { usedPercent: 140 }, secondary: { usedPercent: "12" } } },
      AT,
    );
    if (r.source !== "provider_reported") throw new Error("unreachable");
    expect(r.windows).toEqual([
      { id: "primary", limit_id: null, window_seconds: null, used_fraction: 1, remaining_fraction: 0, resets_at: null },
    ]);
  });
});

describe("CodexAdapter.readProviderUsage", () => {
  const out = (o: Partial<ProbeOutput>): ProbeOutput => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...o,
  });

  it("runs `codex app-server` with the three requests on stdin, holds stdin until the answer, and parses stdout", async () => {
    const calls: { argv: readonly string[]; opts: Parameters<ProbeRunner>[1] }[] = [];
    const runner: ProbeRunner = async (argv, opts) => {
      calls.push({ argv, opts });
      return out({ stdout: fixture("app-server-rate-limits.jsonl") });
    };
    const r = await new CodexAdapter({ executable: "/opt/codex" }).readProviderUsage(runner, new Date(AT));
    expect(r.source).toBe("provider_reported");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(["/opt/codex", ...CODEX_USAGE_ARGS]);
    expect(calls[0]?.opts?.stdinText).toBe(CODEX_USAGE_STDIN);
    const hold = calls[0]?.opts?.holdStdinUntil;
    expect(hold?.({ id: 2, result: {} })).toBe(true);
    expect(hold?.({ id: 1, result: {} })).toBe(false);
    expect(hold?.({ method: "account/updated" })).toBe(false);
    // The requests: initialize, initialized, account/rateLimits/read; no model, thread or turn method.
    const methods = CODEX_USAGE_STDIN.trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { method: string }).method);
    expect(methods).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
    expect(isCodexUsageAnswer(null)).toBe(false);
  });

  it("no binary, a spawn failure or a timeout is unknown with a reason", async () => {
    const never: ProbeRunner = async () => {
      throw new Error("must not run");
    };
    expect(await new CodexAdapter({ pathEnv: "" }).readProviderUsage(never, new Date(AT))).toMatchObject({
      source: "unknown",
      error: "codex not found on PATH",
    });
    const spawnFail: ProbeRunner = async () => out({ exitCode: null, spawnError: "ENOENT" });
    expect(await new CodexAdapter({ executable: "/x" }).readProviderUsage(spawnFail, new Date(AT))).toMatchObject({
      source: "unknown",
      error: "could not start codex app-server (ENOENT)",
    });
    const slow: ProbeRunner = async () => out({ exitCode: null, timedOut: true });
    expect(await new CodexAdapter({ executable: "/x" }).readProviderUsage(slow, new Date(AT))).toMatchObject({
      source: "unknown",
      error: "codex app-server timed out before answering",
    });
  });
});
