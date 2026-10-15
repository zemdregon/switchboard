/** T4.46 synthetic matrix: compile/parse evidence only, never native containment evidence. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addAgentEntries, compileProblems, replayHostileStream, STREAM_CATEGORIES } from "./adapter-leg.js";
import cursorCase, { cursorPartialStreams } from "./adapters/cursor.case.js";
import { buildMaliciousFixture, type MaliciousFixture } from "./fixture.js";

let fx: MaliciousFixture;
beforeAll(() => {
  fx = buildMaliciousFixture();
  addAgentEntries(fx);
});
afterAll(() => fx.close());

describe("Cursor malicious leg matrix (T4.46)", () => {
  it("covers each hostile category at exit 0 and exit 1", () => {
    for (const category of STREAM_CATEGORIES) {
      expect(
        new Set(
          cursorCase
            .streams(fx)
            .filter((s) => s.category === category)
            .map((s) => s.exitCode),
        ),
        category,
      ).toEqual(new Set([0, 1]));
    }
    expect(compileProblems(cursorCase, fx)).toEqual([]);
    expect(cursorCase.neverEnabledFlags).toContain("--approve-mcps");
  });

  it("cuts before and after every hostile category at both exits, never succeeding or changing canaries", async () => {
    const streams = cursorPartialStreams(fx);
    expect(streams).toHaveLength(12);
    for (const category of ["credential_read", "out_of_worktree_write", "network"] as const) {
      for (const exitCode of [0, 1]) {
        const cells = streams.filter((s) => s.category === category && s.exitCode === exitCode);
        const positions = cells.map((s) => {
          const parsed = s.lines.map((line): unknown => {
            try {
              return JSON.parse(line) as unknown;
            } catch {
              return undefined;
            }
          });
          const cutAt = parsed.indexOf(undefined);
          const callAt = parsed.findIndex(
            (line) => typeof line === "object" && line !== null && "type" in line && line.type === "tool_call",
          );
          expect(cutAt, s.name).toBeGreaterThanOrEqual(0);
          expect(callAt, s.name).toBeGreaterThanOrEqual(0);
          return cutAt < callAt ? "before" : "after";
        });
        expect(positions.sort(), `${category}, exit ${exitCode}`).toEqual(["after", "before"]);
      }
    }
    for (const stream of streams) {
      const outcome = await replayHostileStream(cursorCase, fx, stream);
      expect(outcome.failedChecks, stream.name).toEqual([]);
      expect(outcome.resultOk, stream.name).toBe(false);
      expect(outcome.failureCode, stream.name).toBe("OUTPUT_PROTOCOL_ERROR");
      expect(outcome.untouched, stream.name).toBe(true);
    }
  });
});
