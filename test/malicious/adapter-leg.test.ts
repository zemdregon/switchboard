/**
 * Per-adapter leg of the malicious-fixture suite (T4.3; NFR-SEC-03, FR-ADP-11, TDD §3.6). Discovers every
 * `adapters/*.case.ts` (one file per provider) and runs the shared harness over it. CI needs no provider CLI: the
 * adapters run against the shared replay helper. See ./adapter-leg.ts for exactly what this leg does and does not prove.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AdapterLegCase,
  compileProblems,
  coverageProblems,
  parsedKinds,
  replayHostileStream,
  STREAM_CATEGORIES,
} from "./adapter-leg.js";
import { buildMaliciousFixture, type MaliciousFixture } from "./fixture.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "adapters");
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".case.ts"))
  .sort();
const cases: AdapterLegCase[] = [];
for (const f of files)
  cases.push(((await import(pathToFileURL(path.join(DIR, f)).href)) as { default: AdapterLegCase }).default);

describe("adapter malicious leg: discovery", () => {
  it("runs through the one shared replay helper: no per-adapter replay.mjs copy remains", () => {
    const adapters = path.join(DIR, "..", "..", "..", "src", "adapters");
    for (const p of ["claude", "codex", "cursor"])
      expect(readdirSync(path.join(adapters, p, "fixtures"))).not.toContain("replay.mjs");
    expect(readdirSync(path.join(adapters, "fixtures"))).toContain("replay.mjs");
  });

  it("finds a case file for Claude Code, Codex and Cursor", () => {
    expect(cases.map((c) => c.provider)).toEqual(expect.arrayContaining(["claude", "codex", "cursor"]));
    expect(new Set(cases.map((c) => c.provider)).size).toBe(cases.length);
  });
});

let fx: MaliciousFixture;
beforeAll(() => {
  fx = buildMaliciousFixture();
});
afterAll(() => fx.close());

describe.each(cases.map((c) => [c.provider, c] as const))("adapter malicious leg: %s", (_provider, c) => {
  it("covers every hostile category with a blocked failure code", () => {
    expect(coverageProblems(c.streams(fx))).toEqual([]);
    expect(STREAM_CATEGORIES.length).toBe(4);
  });

  it("compiles isolation flags, enables no repository hook, MCP definition or instruction file, never enables non-disabled repo config", () => {
    expect(compileProblems(c, fx)).toEqual([]);
  });

  it("each hostile stream ends in its blocked code (never success) and leaves the hostile checkout untouched", async () => {
    for (const s of c.streams(fx)) {
      const o = await replayHostileStream(c, fx, s);
      expect(o.failedChecks, s.name).toEqual([]);
      expect(o.resultOk, s.name).toBe(false);
      expect(o.failureCode, s.name).toBe(s.failureCode);
      expect(o.untouched, s.name).toBe(true);
    }
  });

  it("unknown event kinds parse as unknown and never as a result", () => {
    for (const s of c.streams(fx).filter((x) => x.category === "unknown_events")) {
      const kinds = parsedKinds(c, s);
      expect(kinds.length, s.name).toBeGreaterThan(0);
      expect(
        kinds.every((k) => k === "unknown"),
        s.name,
      ).toBe(true);
    }
  });

  // Positive controls: the checks above fail on a broken variant (shown here, so a vacuous pass is visible).
  it("positive control: a case missing a category, or expecting success for a blocked stream, is reported", () => {
    const streams = c.streams(fx);
    expect(coverageProblems(streams.filter((s) => s.category !== "network")).join()).toContain("network");
    expect(
      coverageProblems(streams.map((s) => ({ ...s, failureCode: "TOOL_FAILURE" as const }))).length,
    ).toBeGreaterThan(0);
  });

  it("positive control: a mislabelled expectation fails the replay", async () => {
    const s = c.streams(fx).find((x) => x.category === "credential_read");
    if (!s) throw new Error("no credential stream");
    const wrong = {
      ...s,
      failureCode:
        s.failureCode === "SANDBOX_VIOLATION" ? ("PERMISSION_BLOCKED" as const) : ("SANDBOX_VIOLATION" as const),
    };
    expect((await replayHostileStream(c, fx, wrong)).ok).toBe(false);
  });

  it("positive control: a forbidden or missing flag is reported", () => {
    const withFlag = { ...c, neverEnabledFlags: [...c.neverEnabledFlags, ...c.isolationFlags.slice(0, 1)] };
    expect(compileProblems(withFlag, fx).join()).toContain("forbidden flag");
    const missing = { ...c, isolationFlags: [...c.isolationFlags, "--synthetic-not-a-flag"] };
    expect(compileProblems(missing, fx).join()).toContain("missing isolation flag");
  });
});
