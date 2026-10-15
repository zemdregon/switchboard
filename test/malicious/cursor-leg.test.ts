/** T4.46 synthetic matrix: compile/parse evidence only, never native containment evidence. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createParseState } from "../../src/adapters/index.js";
import {
  addAgentEntries,
  compileProblems,
  gapOutcome,
  parsedKinds,
  replayHostileStream,
  STREAM_CATEGORIES,
} from "./adapter-leg.js";
import cursorCase, { cursorPartialStreams, cursorResidualStreams } from "./adapters/cursor.case.js";
import { buildMaliciousFixture, type MaliciousFixture } from "./fixture.js";

let fx: MaliciousFixture;
beforeAll(() => {
  fx = buildMaliciousFixture();
  addAgentEntries(fx);
});
afterAll(() => fx.close());

describe("Cursor malicious leg matrix (T4.46)", () => {
  it("covers each hostile category at exits 0, 1, 2 and 137", () => {
    for (const category of STREAM_CATEGORIES) {
      expect(
        new Set(
          cursorCase
            .streams(fx)
            .filter((s) => s.category === category)
            .map((s) => s.exitCode),
        ),
        category,
      ).toEqual(new Set([0, 1, 2, 137]));
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

  it("ends every residual cell in its code with canaries untouched; unrefused Git writes rely on the guard", async () => {
    const streams = cursorResidualStreams(fx);
    const names = streams.map((s) => s.name);
    expect(new Set(names).size, "unique names").toBe(names.length);
    const unrefused = streams.filter((s) => s.name.startsWith("unrefused shell"));
    expect(unrefused).toHaveLength(6);
    for (const s of unrefused) {
      // No provider refusal in the stream: PERMISSION_BLOCKED comes from the ADR-0039 guard verdict alone.
      expect(parsedKinds(cursorCase, s), s.name).not.toContain("permission_denied");
      expect(gapOutcome(cursorCase, fx, s), s.name).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        failureDetail: expect.stringContaining("git write attempted") as unknown,
      });
    }
    for (const s of streams) {
      const outcome = await replayHostileStream(cursorCase, fx, s);
      expect(outcome.failedChecks, s.name).toEqual([]);
      expect(outcome.resultOk, s.name).toBe(false);
      expect(outcome.failureCode, s.name).toBe(s.failureCode);
      expect(outcome.untouched, s.name).toBe(true);
    }
  });

  it("positive control: the same unrefused Git-write stream with no guard verdict would end ok", () => {
    const s = cursorResidualStreams(fx).find((x) => x.name === "unrefused shell network with a Git write, exit 0");
    if (!s) throw new Error("missing unrefused network stream");
    const adapter = cursorCase.makeAdapter("unused", 0);
    const state = createParseState();
    const events = s.lines.slice(1).flatMap((line) => adapter.parseEvent(line, state));
    expect(
      adapter.extractResult(events, { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] }).ok,
    ).toBe(true);
  });
});
