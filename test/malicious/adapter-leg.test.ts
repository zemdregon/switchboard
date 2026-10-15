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
  requestFor,
  STREAM_CATEGORIES,
  withFlagStripped,
} from "./adapter-leg.js";
import { antigravityPartialStreams, antigravityResidualStreams } from "./adapters/antigravity.case.js";
import {
  grokCellPolicyFlags,
  grokCellProblems,
  grokCompiledCells,
  grokPartialStreams,
  grokRefusedScopes,
  grokResidualStreams,
} from "./adapters/grok.case.js";
import {
  opencodeGuardBlindStreams,
  opencodePartialStreams,
  opencodeUnreadableStreams,
} from "./adapters/opencode.case.js";
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
    for (const p of ["antigravity", "claude", "codex", "cursor", "grok", "opencode"])
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

/** Providers whose hostile-stream replay runs one test per category. */
const SPLIT_BY_CATEGORY = new Set(["antigravity", "grok", "opencode"]);

describe.each(cases.map((c) => [c.provider, c] as const))("adapter malicious leg: %s", (_provider, c) => {
  it("covers every hostile category with a blocked failure code", () => {
    expect(coverageProblems(c.streams(fx))).toEqual([]);
    expect(STREAM_CATEGORIES.length).toBe(4);
  });

  it("compiles isolation flags, enables no repository hook, MCP definition or instruction file, never enables non-disabled repo config", () => {
    expect(compileProblems(c, fx)).toEqual([]);
  });

  // Keep the expanded OpenCode, Grok Build and Antigravity matrices within the per-test budget without weakening the
  // replay assertions.
  for (const category of SPLIT_BY_CATEGORY.has(c.provider) ? STREAM_CATEGORIES : [undefined]) {
    it.skipIf(c.replayGap !== undefined)(
      `${category ? `${category}: ` : ""}each hostile stream ends in its blocked code (never success) and leaves the hostile checkout untouched`,
      async () => {
        for (const s of c.streams(fx).filter((s) => category === undefined || s.category === category)) {
          const o = await replayHostileStream(c, fx, s);
          expect(o.failedChecks, s.name).toEqual([]);
          expect(o.resultOk, s.name).toBe(false);
          expect(o.failureCode, s.name).toBe(s.failureCode);
          expect(o.untouched, s.name).toBe(true);
        }
      },
    );
  }

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
  /** The exit codes the blocked matrix replays; the partial and unreadable streams cover each of them. */
  const OPENCODE_EXITS = [0, 1, 2, 137] as const;

  it("names every OpenCode stream once, so no cell is shadowed by a duplicate", () => {
    const names = [
      ...c.streams(fx),
      ...opencodePartialStreams(fx),
      ...opencodeUnreadableStreams(),
      ...opencodeGuardBlindStreams(fx),
    ].map((s) => s.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });

  it("a stream cut inside a line ends OUTPUT_PROTOCOL_ERROR (never success) and leaves the checkout untouched", async () => {
    const streams = opencodePartialStreams(fx);
    expect(new Set(streams.map((s) => s.exitCode))).toEqual(new Set(OPENCODE_EXITS));
    for (const cat of ["credential_read", "out_of_worktree_write", "network"] as const) {
      expect(new Set(streams.filter((s) => s.category === cat).map((s) => s.exitCode)), cat).toEqual(
        new Set(OPENCODE_EXITS),
      );
      for (const exitCode of OPENCODE_EXITS) {
        const cell = streams.filter((s) => s.category === cat && s.exitCode === exitCode);
        const positions = cell.map((s) => {
          const parsed: unknown[] = s.lines.map((line) => {
            try {
              return JSON.parse(line) as unknown;
            } catch {
              return undefined;
            }
          });
          const cutAt = parsed.indexOf(undefined);
          const hostileAt = parsed.findIndex((line) => {
            if (typeof line !== "object" || line === null || !("type" in line) || line.type !== "tool_use")
              return false;
            if (!("part" in line) || typeof line.part !== "object" || line.part === null) return false;
            const part = line.part as { tool?: unknown; state?: { input?: { command?: unknown } } };
            return (part.tool === "shell" || part.tool === "bash") && typeof part.state?.input?.command === "string";
          });
          expect(cutAt, `${s.name}: malformed line`).toBeGreaterThanOrEqual(0);
          if (hostileAt === -1) {
            expect(s.lines[cutAt], `${s.name}: cut inside tool command`).toContain('"type":"tool_use"');
            expect(s.lines[cutAt], `${s.name}: cut inside tool command`).toContain('"command":');
            return "inside";
          }
          return cutAt < hostileAt ? "before" : "after";
        });
        expect(
          positions.filter((position) => position === "before"),
          `${cat}, exit ${exitCode}, before`,
        ).toHaveLength(1);
        expect(
          positions.filter((position) => position === "inside"),
          `${cat}, exit ${exitCode}, inside`,
        ).toHaveLength(1);
        expect(
          positions.filter((position) => position === "after"),
          `${cat}, exit ${exitCode}, after`,
        ).toHaveLength(2);
      }
    }
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
  it("an unreadable event before or after a final stop step is not a success and leaves the checkout untouched", async () => {
    const streams = opencodeUnreadableStreams();
    expect(new Set(streams.map((s) => s.exitCode))).toEqual(new Set(OPENCODE_EXITS));
    for (const s of streams) {
      // The replay helper consumes the provenance header; it is not a provider event.
      const kinds = parsedKinds(c, { ...s, lines: s.lines.slice(1) });
      expect(
        kinds.filter((k) => k === "unknown"),
        s.name,
      ).toHaveLength(1);
      expect(kinds, s.name).toContain("result");
      const o = await replayHostileStream(c, fx, s);
      expect(o.failedChecks, s.name).toEqual([]);
      expect(o.resultOk, s.name).toBe(false);
      expect(o.failureCode, s.name).toBe(s.failureCode);
      expect(o.untouched, s.name).toBe(true);
    }
  });

  // Positive controls: the two checks above fail on a broken variant (shown here, so a vacuous pass is visible).
  it("positive control: a partial stream with its cut line dropped no longer ends OUTPUT_PROTOCOL_ERROR", async () => {
    const cutBefore = opencodePartialStreams(fx).filter((s) => s.name.startsWith("output cut before"));
    expect(cutBefore.length).toBeGreaterThan(0);
    for (const s of cutBefore) {
      const repaired = { ...s, lines: s.lines.filter((line) => line !== '{"type":"step_fin') };
      expect(repaired.lines.length, s.name).toBe(s.lines.length - 1);
      const o = await replayHostileStream(c, fx, repaired);
      expect(o.ok, s.name).toBe(false);
      expect(o.failureCode, s.name).toBe("PERMISSION_BLOCKED");
      expect(o.untouched, s.name).toBe(true);
    }
  });

  it("positive control: a mislabelled unreadable-stream expectation fails the replay", async () => {
    for (const exitCode of OPENCODE_EXITS) {
      const s = opencodeUnreadableStreams().find((x) => x.exitCode === exitCode);
      if (!s) throw new Error(`no unreadable stream at exit ${exitCode}`);
      const wrong = {
        ...s,
        failureCode: s.failureCode === "TOOL_FAILURE" ? ("OUTPUT_PROTOCOL_ERROR" as const) : ("TOOL_FAILURE" as const),
      };
      expect((await replayHostileStream(c, fx, wrong)).ok, s.name).toBe(false);
    }
  });

  // Known gap (1): a Git write that is not an own string `command` on a shell-kind tool never reaches the guard. Each
  // stream is pinned at the result it ends with today, without a process and through the replay; when one ends
  // PERMISSION_BLOCKED the gap has closed, so move it into the blocked list.
  it("known gap: a Git write the guard cannot see is pinned at its current result, not blocked", async () => {
    const streams = opencodeGuardBlindStreams(fx);
    expect(streams).toHaveLength(24);
    for (const cat of ["credential_read", "out_of_worktree_write", "network"] as const) {
      expect(new Set(streams.filter((s) => s.category === cat).map((s) => s.exitCode)), cat).toEqual(new Set([0, 1]));
    }
    for (const s of streams) {
      expect(s.failureCode, s.name).toBe("PERMISSION_BLOCKED");
      expect(await gapProblems(c, fx, s), s.name).toEqual([]);
    }
  });

  it("positive control: a mislabelled guard-blind pin is reported, and the same call under an own command key is blocked", async () => {
    const s = opencodeGuardBlindStreams(fx).find((x) => x.name.includes("cmd key") && x.exitCode === 0);
    if (!s) throw new Error("no cmd-key stream");
    const wrong = { ...s, gapResult: { ok: false, failureCode: "TOOL_FAILURE" as const } };
    expect((await gapProblems(c, fx, wrong)).join()).toContain("want");
    const renamed = { ...s, lines: s.lines.map((line) => line.replace('"cmd":', '"command":')) };
    expect(renamed.lines).not.toEqual(s.lines);
    expect((await gapProblems(c, fx, renamed)).join()).toContain("gap closed");
    const o = await replayHostileStream(c, fx, renamed);
    expect(o.failureCode).toBe("PERMISSION_BLOCKED");
    expect(o.untouched).toBe(true);
  });

  // The blocked list rests on the guard verdict, not on the adapter's own failure mapping: with the verdict removed
  // (parseEvent and extractResult only), none of the blocked streams ends PERMISSION_BLOCKED.
  it("positive control: without the ADR-0039 guard verdict, no blocked OpenCode stream ends PERMISSION_BLOCKED", () => {
    const blocked = c.streams(fx).filter((s) => s.failureCode === "PERMISSION_BLOCKED");
    expect(blocked.length).toBeGreaterThan(200);
    const adapter = c.makeAdapter("unused", 0);
    for (const s of blocked) {
      const state = { lines: 0, unknownEvents: 0 };
      const events = s.lines.slice(1).flatMap((line) => adapter.parseEvent(line, state));
      const res = adapter.extractResult(events, {
        outcome: "exited",
        exitCode: s.exitCode,
        signal: null,
        expectedExitCodes: [0],
      });
      expect(res.failureCode, s.name).not.toBe("PERMISSION_BLOCKED");
    }
  });
});

// Antigravity only (T4.36): streams cut inside a line, replayed on their own.
describe("adapter malicious leg: antigravity partial streams", () => {
  const c = cases.find((x) => x.provider === "antigravity");
  if (!c) throw new Error("no antigravity case file");
  /** The exit codes the blocked matrix replays; the partial streams cover each of them. */
  const ANTIGRAVITY_EXITS = [0, 1, 2, 137] as const;

  it("names every Antigravity stream once, so no cell is shadowed by a duplicate", () => {
    const names = [...c.streams(fx), ...antigravityPartialStreams(fx)].map((s) => s.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });

  it("a stream cut inside a line ends OUTPUT_PROTOCOL_ERROR (never success) and leaves the checkout untouched", async () => {
    const streams = antigravityPartialStreams(fx);
    expect(new Set(streams.map((s) => s.exitCode))).toEqual(new Set(ANTIGRAVITY_EXITS));
    for (const category of ["credential_read", "out_of_worktree_write", "network"] as const) {
      for (const exitCode of ANTIGRAVITY_EXITS) {
        const cell = streams.filter((s) => s.category === category && s.exitCode === exitCode);
        const positions = cell.map((s) => {
          const parsed: unknown[] = s.lines.map((line) => {
            try {
              return JSON.parse(line) as unknown;
            } catch {
              return undefined;
            }
          });
          const cutAt = parsed.indexOf(undefined);
          const hostileAt = parsed.findIndex((line) => {
            if (typeof line !== "object" || line === null || !("event" in line)) return false;
            return line.event === "step_update" && JSON.stringify(line).includes("git ");
          });
          expect(cutAt, `${s.name}: malformed line`).toBeGreaterThanOrEqual(0);
          if (hostileAt === -1) {
            expect(s.lines[cutAt], `${s.name}: cut inside the hostile step`).toContain('"event":"step_update"');
            expect(s.lines[cutAt], `${s.name}: cut inside the hostile step`).toContain("git ");
            return "inside";
          }
          return cutAt < hostileAt ? "before" : "after";
        });
        expect(
          positions.filter((position) => position === "before"),
          `${category}, exit ${exitCode}, before`,
        ).toHaveLength(1);
        expect(
          positions.filter((position) => position === "inside"),
          `${category}, exit ${exitCode}, inside`,
        ).toHaveLength(1);
        expect(
          positions.filter((position) => position === "after"),
          `${category}, exit ${exitCode}, after`,
        ).toHaveLength(1);
      }
    }
    for (const s of streams) {
      const o = await replayHostileStream(c, fx, s);
      expect(o.failedChecks, s.name).toEqual([]);
      expect(o.resultOk, s.name).toBe(false);
      expect(o.failureCode, s.name).toBe("OUTPUT_PROTOCOL_ERROR");
      expect(o.untouched, s.name).toBe(true);
    }
  });

  // Positive controls: the checks above fail on a broken variant (shown here, so a vacuous pass is visible).
  it("positive control: a partial stream with its cut line dropped no longer ends OUTPUT_PROTOCOL_ERROR", async () => {
    const cutBefore = antigravityPartialStreams(fx).filter((s) => s.name.startsWith("output cut before"));
    expect(cutBefore.length).toBeGreaterThan(0);
    for (const s of cutBefore) {
      const repaired = { ...s, lines: s.lines.filter((line) => line !== '{"event":"step_') };
      expect(repaired.lines.length, s.name).toBe(s.lines.length - 1);
      const o = await replayHostileStream(c, fx, repaired);
      expect(o.ok, s.name).toBe(false);
      expect(o.failureCode, s.name).toBe("PERMISSION_BLOCKED");
      expect(o.untouched, s.name).toBe(true);
    }
  });

  it("positive control: without the ADR-0039 guard verdict, none of the residual blocked streams ends PERMISSION_BLOCKED", () => {
    const residuals = antigravityResidualStreams(fx);
    expect(residuals.length).toBe(114);
    const adapter = c.makeAdapter("unused", 0);
    for (const s of residuals) {
      const state = { lines: 0, unknownEvents: 0 };
      const events = s.lines.slice(1).flatMap((line) => adapter.parseEvent(line, state));
      const res = adapter.extractResult(events, {
        outcome: "exited",
        exitCode: s.exitCode,
        signal: null,
        expectedExitCodes: [0],
      });
      expect(res.failureCode, s.name).not.toBe("PERMISSION_BLOCKED");
    }
  });

  it("positive control: an unrefused Git-write stream with no guard verdict would end ok", () => {
    const s = antigravityResidualStreams(fx).find((x) => x.name.includes("duplicate command key") && x.exitCode === 0);
    if (!s) throw new Error("missing unrefused stream");
    const adapter = c.makeAdapter("unused", 0);
    const state = { lines: 0, unknownEvents: 0 };
    const events = s.lines.slice(1).flatMap((line) => adapter.parseEvent(line, state));
    expect(
      adapter.extractResult(events, { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] }).ok,
    ).toBe(true);
  });
});

// Grok Build only (T4.26): streams cut inside a line, replayed on their own.
describe("adapter malicious leg: grok partial streams", () => {
  const c = cases.find((x) => x.provider === "grok");
  if (!c) throw new Error("no grok case file");
  /** The exit codes the blocked matrix replays; the partial streams cover each of them. */
  const GROK_EXITS = [0, 1, 2, 137] as const;

  it("names every Grok stream once, so no cell is shadowed by a duplicate", () => {
    const names = [...c.streams(fx), ...grokPartialStreams(fx)].map((s) => s.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });

  it("a stream cut inside a line ends OUTPUT_PROTOCOL_ERROR (never success) and leaves the checkout untouched", async () => {
    const streams = grokPartialStreams(fx);
    expect(new Set(streams.map((s) => s.exitCode))).toEqual(new Set(GROK_EXITS));
    for (const category of ["credential_read", "out_of_worktree_write", "network"] as const) {
      for (const exitCode of GROK_EXITS) {
        const cell = streams.filter((s) => s.category === category && s.exitCode === exitCode);
        const positions = cell.map((s) => {
          const parsed: unknown[] = s.lines.map((line) => {
            try {
              return JSON.parse(line) as unknown;
            } catch {
              return undefined;
            }
          });
          const cutAt = parsed.indexOf(undefined);
          const hostileAt = parsed.findIndex((line) => {
            if (typeof line !== "object" || line === null || !("type" in line) || line.type !== "tool_call")
              return false;
            if (!("input" in line) || typeof line.input !== "object" || line.input === null) return false;
            return "command" in line.input && typeof line.input.command === "string";
          });
          expect(cutAt, `${s.name}: malformed line`).toBeGreaterThanOrEqual(0);
          expect(hostileAt, `${s.name}: readable hostile call`).toBeGreaterThanOrEqual(0);
          return cutAt < hostileAt ? "before" : "after";
        });
        expect(
          positions.filter((position) => position === "before"),
          `${category}, exit ${exitCode}, before`,
        ).toHaveLength(1);
        expect(
          positions.filter((position) => position === "after"),
          `${category}, exit ${exitCode}, after`,
        ).toHaveLength(1);
      }
    }
    for (const s of streams) {
      const o = await replayHostileStream(c, fx, s);
      expect(o.failedChecks, s.name).toEqual([]);
      expect(o.resultOk, s.name).toBe(false);
      expect(o.failureCode, s.name).toBe("OUTPUT_PROTOCOL_ERROR");
      expect(o.untouched, s.name).toBe(true);
    }
  });

  // Positive controls: the checks above fail on a broken variant (shown here, so a vacuous pass is visible).
  it("positive control: a partial stream with its cut line dropped no longer ends OUTPUT_PROTOCOL_ERROR", async () => {
    const cutBefore = grokPartialStreams(fx).filter((s) => s.name.startsWith("output cut before"));
    expect(cutBefore.length).toBeGreaterThan(0);
    for (const s of cutBefore) {
      const repaired = { ...s, lines: s.lines.filter((line) => line !== '{"type":"tool_') };
      expect(repaired.lines.length, s.name).toBe(s.lines.length - 1);
      const o = await replayHostileStream(c, fx, repaired);
      expect(o.ok, s.name).toBe(false);
      expect(o.failureCode, s.name).toBe("PERMISSION_BLOCKED");
      expect(o.untouched, s.name).toBe(true);
    }
  });

  it("positive control: without the ADR-0039 guard verdict, none of the residual blocked streams ends PERMISSION_BLOCKED", () => {
    const residuals = grokResidualStreams(fx);
    expect(residuals.length).toBe(180);
    const adapter = c.makeAdapter("unused", 0);
    for (const s of residuals) {
      const state = { lines: 0, unknownEvents: 0 };
      const events = s.lines.slice(1).flatMap((line) => adapter.parseEvent(line, state));
      const res = adapter.extractResult(events, {
        outcome: "exited",
        exitCode: s.exitCode,
        signal: null,
        expectedExitCodes: [0],
      });
      expect(res.failureCode, s.name).not.toBe("PERMISSION_BLOCKED");
    }
  });

  it("positive control: an unrefused Git-write stream with no guard verdict would end ok", () => {
    const s = grokResidualStreams(fx).find((x) => x.name.includes("duplicate command key") && x.exitCode === 0);
    if (!s) throw new Error("missing unrefused stream");
    const adapter = c.makeAdapter("unused", 0);
    const state = { lines: 0, unknownEvents: 0 };
    const events = s.lines.slice(1).flatMap((line) => adapter.parseEvent(line, state));
    expect(
      adapter.extractResult(events, { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] }).ok,
    ).toBe(true);
  });
});

// Grok Build only (T4.26): the compiled cells pinned beyond flag presence, and the scopes it must refuse.
describe("adapter malicious leg: grok compiled cells", () => {
  const c = cases.find((x) => x.provider === "grok");
  if (!c) throw new Error("no grok case file");
  const compileCell = (cell: (typeof grokCompiledCells)[number]) => {
    const inv = c
      .makeAdapter(path.join(fx.base, "unused.jsonl"), 0)
      .compile({ ...requestFor(fx.repo, true), workspace: { cwd: fx.repo, writable: cell.writable } }, cell.profile);
    if (isIneligible(inv)) throw new Error(`${cell.label} does not compile: ${inv.reason}: ${inv.detail}`);
    return inv;
  };

  it("each cell compiles one --sandbox with its value, web search off exactly with network off, and one --always-approve", () => {
    expect(new Set(grokCompiledCells.map((cell) => cell.sandbox))).toEqual(
      new Set(["strict", "workspace", "read-only"]),
    );
    for (const cell of grokCompiledCells) expect(grokCellProblems(compileCell(cell), cell), cell.label).toEqual([]);
  });

  it("positive control: a widening second --sandbox, an inline or detached value, or a policyFlags drift is reported", () => {
    for (const cell of grokCompiledCells) {
      const inv = compileCell(cell);
      const at = inv.argv.indexOf("--sandbox");
      const broken: [string, string[], string[]][] = [
        ["second --sandbox workspace", [...inv.argv, "--sandbox", "workspace"], inv.policyFlags],
        ["inline --sandbox=", inv.argv.map((a, i) => (i === at ? `--sandbox=${cell.sandbox}` : a)), inv.policyFlags],
        ["value detached", [...inv.argv.filter((_, i) => i !== at + 1), cell.sandbox], inv.policyFlags],
        ["second --always-approve", [...inv.argv, "--always-approve"], inv.policyFlags],
        [
          "web search flipped",
          cell.webSearchOff
            ? inv.argv.filter((a) => a !== "--disable-web-search")
            : [...inv.argv, "--disable-web-search"],
          inv.policyFlags,
        ],
        ["policyFlags without the sandbox", inv.argv, inv.policyFlags.slice(2)],
      ];
      for (const [label, argv, policyFlags] of broken) {
        expect(grokCellProblems({ ...inv, argv, policyFlags }, cell).length, `${cell.label}: ${label}`).toBeGreaterThan(
          0,
        );
      }
      expect(grokCellPolicyFlags(cell)).toEqual(inv.policyFlags);
    }
  });

  it("refuses repository configuration disabled or approved in every cell, and every other unsupported scope", () => {
    expect(grokRefusedScopes.filter((s) => s.label.includes("repository_config"))).toHaveLength(6);
    for (const s of grokRefusedScopes) {
      const inv = c
        .makeAdapter(path.join(fx.base, "unused.jsonl"), 0)
        .compile(requestFor(fx.repo, s.bypassApproved), s.profile);
      expect(isIneligible(inv) ? inv.reason : "compiled", s.label).toBe(s.reason);
    }
  });
});
