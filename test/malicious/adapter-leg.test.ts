/**
 * Per-adapter leg of the malicious-fixture suite (T4.3; NFR-SEC-03, FR-ADP-11, TDD §3.6). Discovers every
 * `adapters/*.case.ts` (one file per provider) and runs the shared harness over it. CI needs no provider CLI: the
 * adapters run against the shared replay helper. See ./adapter-leg.ts for exactly what this leg does and does not prove.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isIneligible, type ProviderAdapter } from "../../src/adapters/index.js";
import {
  type AdapterLegCase,
  addAgentEntries,
  compileProblems,
  coverageProblems,
  gapOutcome,
  gapProblems,
  HOSTILE_REPO_ENTRIES,
  parsedKinds,
  replayHostileStream,
  STREAM_CATEGORIES,
  withFlagStripped,
} from "./adapter-leg.js";
import { opencodePartialStreams, opencodeUnreadableStreams } from "./adapters/opencode.case.js";
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
    for (const p of ["antigravity", "claude", "codex", "cursor", "grok"])
      expect(readdirSync(path.join(adapters, p, "fixtures"))).not.toContain("replay.mjs");
    expect(readdirSync(path.join(adapters, "fixtures"))).toContain("replay.mjs");
  });

  it("finds a case file for Antigravity, Claude Code, Codex, Cursor, Grok Build and OpenCode", () => {
    expect(cases.map((c) => c.provider)).toEqual(
      expect.arrayContaining(["antigravity", "claude", "codex", "cursor", "grok", "opencode"]),
    );
    expect(new Set(cases.map((c) => c.provider)).size).toBe(cases.length);
  });
});

let fx: MaliciousFixture;
beforeAll(() => {
  fx = buildMaliciousFixture();
  addAgentEntries(fx);
});

describe("adapter malicious leg: hostile repository", () => {
  it("carries every hostile repository entry the leg checks for", () => {
    expect(HOSTILE_REPO_ENTRIES.filter((e) => !existsSync(path.join(fx.repo, e)))).toEqual([]);
  });
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

  it.skipIf(c.replayGap !== undefined)(
    "each hostile stream ends in its blocked code (never success) and leaves the hostile checkout untouched",
    async () => {
      for (const s of c.streams(fx)) {
        const o = await replayHostileStream(c, fx, s);
        expect(o.failedChecks, s.name).toEqual([]);
        expect(o.resultOk, s.name).toBe(false);
        expect(o.failureCode, s.name).toBe(s.failureCode);
        expect(o.untouched, s.name).toBe(true);
      }
    },
  );

  // A declared replay gap is pinned, not hidden: no hostile stream ends in its blocked code yet, and a stream that
  // declares `gapResult` ends exactly there both without a process and through the supervisor replay (a full
  // `RunResult` pins the exact `extractResult` value too). When one ends blocked, this fails; remove `replayGap` from
  // the case file so the replay checks above run.
  it.runIf(c.replayGap !== undefined)(`known replay gap still open: ${c.replayGap}`, async () => {
    for (const s of c.streams(fx).filter((x) => x.category !== "unknown_events")) {
      expect(await gapProblems(c, fx, s), s.name).toEqual([]);
    }
  });

  // The pin above models the outcome without a process. This replays the same streams through the supervisor, the
  // tool-call guard and the shared replay helper, so the model is checked against the real path and a gap stream still
  // proves the hostile checkout, canary logs and outside sentinel are left untouched.
  it.runIf(c.replayGap !== undefined)(
    "known replay gap: the replayed outcome matches the pinned one and leaves the hostile checkout untouched",
    async () => {
      for (const s of c.streams(fx).filter((x) => x.category !== "unknown_events")) {
        const model = gapOutcome(c, fx, s);
        const o = await replayHostileStream(c, fx, s);
        const expectationChecks = ["result.ok matches", "failure code matches"];
        expect(
          o.failedChecks.filter((k) => !expectationChecks.some((n) => k.startsWith(n))),
          s.name,
        ).toEqual([]);
        expect({ ok: o.resultOk, failureCode: o.failureCode }, s.name).toEqual({
          ok: model.ok,
          failureCode: model.failureCode,
        });
        expect(o.untouched, s.name).toBe(true);
      }
    },
  );

  // The gap covers only the blocked categories; unknown event kinds still replay through the supervisor.
  it.runIf(c.replayGap !== undefined)(
    "with a replay gap open, unknown-event streams still end in their code through the replay",
    async () => {
      const unknown = c.streams(fx).filter((x) => x.category === "unknown_events");
      expect(unknown.length).toBeGreaterThan(0);
      for (const s of unknown) {
        const o = await replayHostileStream(c, fx, s);
        expect(o.failedChecks, s.name).toEqual([]);
        expect(o.resultOk, s.name).toBe(false);
        expect(o.failureCode, s.name).toBe(s.failureCode);
        expect(o.untouched, s.name).toBe(true);
      }
    },
  );

  it.runIf(c.replayGap !== undefined)(
    "positive control: a mislabelled gapResult is reported by the gap pin",
    async () => {
      const s = c.streams(fx).find((x) => x.category !== "unknown_events");
      if (!s) throw new Error("no blocked-category stream");
      const now = gapOutcome(c, fx, s);
      const wrong = { ...s, gapResult: now.ok ? { ok: false, failureCode: "PROCESS_TIMEOUT" as const } : { ok: true } };
      expect((await gapProblems(c, fx, wrong)).join()).toContain("want");
    },
  );

  it.runIf(c.replayGap !== undefined)(
    "positive control: an exact gapResult with a wrong summary is reported by the gap pin",
    async ({ skip }) => {
      const s = c.streams(fx).find((x) => x.gapResult !== undefined && "unknownEventCount" in x.gapResult);
      if (!s?.gapResult) return skip("the case pins no exact gapResult");
      const wrong = { ...s, gapResult: { ...s.gapResult, unknownEventCount: 0, summary: "not what it ends with" } };
      expect((await gapProblems(c, fx, wrong)).join()).toContain("not what it ends with");
    },
  );

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

  it.skipIf(c.replayGap !== undefined)("positive control: a mislabelled expectation fails the replay", async () => {
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

  it("positive control: an argv naming any hostile repository entry is reported", () => {
    for (const entry of HOSTILE_REPO_ENTRIES) {
      const named: AdapterLegCase = {
        ...c,
        makeAdapter: (file, exitCode) => {
          const real = c.makeAdapter(file, exitCode);
          const compile: ProviderAdapter["compile"] = (request, profile) => {
            const inv = real.compile(request, profile);
            return isIneligible(inv) ? inv : { ...inv, argv: [...inv.argv, path.join(fx.repo, entry)] };
          };
          return Object.assign(Object.create(real) as ProviderAdapter, { compile });
        },
      };
      expect(compileProblems(named, fx).join(), entry).toContain(`hostile repository entry ${entry}`);
    }
  });

  it("positive control: a deliberately broken compile that drops any one isolation flag is reported", () => {
    for (const f of c.isolationFlags) {
      expect(compileProblems(withFlagStripped(c, f), fx).join(), f).toContain(`missing isolation flag ${f}`);
    }
    for (const extra of c.extraProfiles ?? []) {
      for (const f of extra.isolationFlags) {
        expect(compileProblems(withFlagStripped(c, f), fx).join(), `${extra.label} ${f}`).toContain(
          `${extra.label}: missing isolation flag ${f}`,
        );
      }
    }
  });
});

// OpenCode only (T4.56): streams that are not hostile-category streams of the shared harness, replayed on their own.
describe("adapter malicious leg: opencode partial streams", () => {
  const c = cases.find((x) => x.provider === "opencode");
  if (!c) throw new Error("no opencode case file");

  it("a stream cut inside a line ends OUTPUT_PROTOCOL_ERROR (never success) and leaves the checkout untouched", async () => {
    const streams = opencodePartialStreams(fx);
    expect(new Set(streams.map((s) => s.exitCode))).toEqual(new Set([0, 1]));
    for (const s of streams) {
      const o = await replayHostileStream(c, fx, s);
      expect(o.failedChecks, s.name).toEqual([]);
      expect(o.resultOk, s.name).toBe(false);
      expect(o.failureCode, s.name).toBe("OUTPUT_PROTOCOL_ERROR");
      expect(o.untouched, s.name).toBe(true);
    }
  });

  // An unknown kind before `stop` parses as `session_bound` plus `unknown` plus `result`, so it cannot sit in the
  // `unknown_events` category (that category must parse only as `unknown`). It is still not a success (T4.56).
  it("an unreadable event before a final stop step is not a success and leaves the checkout untouched", async () => {
    const streams = opencodeUnreadableStreams();
    expect(new Set(streams.map((s) => s.exitCode))).toEqual(new Set([0, 1]));
    for (const s of streams) {
      const o = await replayHostileStream(c, fx, s);
      expect(o.failedChecks, s.name).toEqual([]);
      expect(o.resultOk, s.name).toBe(false);
      expect(o.failureCode, s.name).toBe(s.failureCode);
      expect(o.untouched, s.name).toBe(true);
    }
  });
});
