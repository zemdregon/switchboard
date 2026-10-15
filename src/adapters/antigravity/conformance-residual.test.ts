/**
 * T4.35 residual (2026-10-15, Delegated agent work, not owner-approved; synthetic fixtures only, no `agy` run, adapter
 * and parser unchanged). The suite in antigravity.test.ts shows each case passes; these tests show each case can fail:
 * a compile the replay refuses (exit 64 for the argv, exit 65 for an empty prompt) writes nothing to stdout and must
 * not satisfy any case's expectation.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type ConformanceCase, runConformanceCase } from "../conformance.js";
import type { Invocation } from "../types.js";
import type { AntigravityAdapter } from "./adapter.js";
import {
  ANTIGRAVITY_RUNNABLE_KINDS,
  antigravityConformanceCases,
  DEFAULT_SESSION_ID,
  fixturePath,
  replayAdapter,
} from "./fixtures/cases.js";

const dirs: string[] = [];
const makeCwd = () => {
  const d = mkdtempSync(join(tmpdir(), "sb-antigravity-residual-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** `c` with its compiled argv rewritten by `edit`. A Proxy, because the adapter's `#` members reject a copy. */
const refusedBy = (c: ConformanceCase, edit: (argv: string[]) => string[]): ConformanceCase => {
  const a = c.adapter as AntigravityAdapter;
  const adapter = new Proxy(a, {
    get(target, key) {
      if (key === "compile") {
        return (...args: Parameters<AntigravityAdapter["compile"]>) => {
          const inv = target.compile(...args);
          return "ineligible" in inv ? inv : ({ ...inv, argv: edit(inv.argv), policyFlags: [] } satisfies Invocation);
        };
      }
      const v: unknown = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ...c, adapter };
};

const runnable = () => antigravityConformanceCases(makeCwd).filter((c) => ANTIGRAVITY_RUNNABLE_KINDS.includes(c.kind));
const fixtureOf = (c: ConformanceCase): string => {
  const inv = c.adapter.compile(c.request, c.profile);
  const path = "ineligible" in inv ? undefined : inv.argv.find((w) => w.endsWith(".jsonl"));
  return path?.slice(path.lastIndexOf("/") + 1, -".jsonl".length) ?? "";
};

describe("antigravity conformance cases fail when the replay refuses the compile (T4.35, FR-ADP-11)", () => {
  it.each([
    ["exit code 64", (argv: string[]) => argv.filter((w) => w !== "--dangerously-skip-permissions")],
    ["exit code 65", (argv: string[]) => argv.map((w) => (w.startsWith("--prompt=") ? "--prompt=" : w))],
  ])("every runnable case fails a compile the replay ends with %s", async (detail, edit) => {
    const passing: string[] = [];
    for (const c of runnable()) {
      const report = await runConformanceCase(refusedBy(c, edit));
      expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: detail });
      if (report.ok) passing.push(`${c.kind}/${fixtureOf(c)}`);
    }
    expect(passing).toEqual([]);
  });

  it("without failureDetail, the slash-command, /credits and empty-stream cases would pass a refused compile", async () => {
    const weak = runnable().filter((c) => ["slash_command", "credits_command", "rate_limit"].includes(fixtureOf(c)));
    expect(weak.map((c) => [fixtureOf(c), c.expect.failureDetail])).toEqual([
      ["slash_command", "SUCCESS with no reported tokens"],
      ["credits_command", "SUCCESS with no reported tokens"],
      ["rate_limit", "exit code 1"],
    ]);
    for (const c of weak) {
      const { failureDetail: _detail, ...loose } = c.expect;
      const refused = refusedBy({ ...c, expect: loose }, (argv) =>
        argv.filter((w) => w !== "--dangerously-skip-permissions"),
      );
      // The hole the detail closes: code, session id and mutation alone match the replay's exit 64.
      expect((await runConformanceCase(refused)).ok).toBe(true);
      expect((await runConformanceCase(c)).ok).toBe(true);
    }
  });
});

describe("antigravity whole-stream order shapes in the case list (T4.35, T4.33 fixtures)", () => {
  it("lists an unknown line before the result, a late auth envelope and an unparseable trailing line", () => {
    const cases = antigravityConformanceCases(makeCwd);
    const listed = (fixture: string) =>
      cases
        .filter((c) => {
          const inv = c.adapter.compile(c.request, c.profile);
          return !("ineligible" in inv) && inv.argv.includes(fixturePath(fixture));
        })
        .map((c) => [c.kind, c.expect]);
    expect(listed("unknown_then_result")).toEqual([["success", { ok: true, nativeSessionId: DEFAULT_SESSION_ID }]]);
    expect(listed("error_after_result")).toEqual([
      [
        "malformed_output",
        {
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          failureDetail: "protocol: more than one result line",
          nativeSessionId: DEFAULT_SESSION_ID,
        },
      ],
    ]);
    expect(listed("malformed_after_result")).toEqual([
      [
        "malformed_output",
        {
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          failureDetail: "unparseable provider output",
          nativeSessionId: DEFAULT_SESSION_ID,
        },
      ],
    ]);
  });
});

describe("antigravity fixture inventory (T4.35, FR-ADP-11)", () => {
  // Each fixture outside the case list, with the reason it stays out. Adding a fixture without a case or a reason here
  // fails, so a synthetic shape cannot sit unreplayed.
  const OUT_OF_SUITE: Record<string, string> = {
    non_tool_step_command: "replays to a success: a command off a `tool` step is not seen (T4.33 gap, pinned)",
    sandbox_violation_unrecorded: "replays to a success: the tool's error is not read (T4.33 gap, pinned)",
    resume_failure: "needs `--conversation <id>`, which is not compiled while resumeArgs is Ineligible (Q-86)",
    resume_unknown_id: "needs `--conversation <id>`, which is not compiled while resumeArgs is Ineligible (Q-86)",
  };
  const dir = dirname(fixturePath("hang"));
  const onDisk = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .sort();
  const replayed = () =>
    new Set(
      antigravityConformanceCases(makeCwd)
        .map((c) => fixtureOf(c))
        .filter((f) => f !== ""),
    );

  it("every fixture is replayed by a case or listed out of the suite with a reason, never both", () => {
    const listed = replayed();
    expect(onDisk.filter((f) => !listed.has(f) && !Object.hasOwn(OUT_OF_SUITE, f))).toEqual([]);
    expect(Object.keys(OUT_OF_SUITE).filter((f) => listed.has(f))).toEqual([]);
    expect(Object.keys(OUT_OF_SUITE).filter((f) => !onDisk.includes(f))).toEqual([]);
    expect([...listed].filter((f) => !onDisk.includes(f))).toEqual([]);
  });

  it.each(onDisk)("%s starts with SYNTHETIC provenance metadata", (name) => {
    const first: unknown = JSON.parse(readFileSync(fixturePath(name), "utf8").split("\n")[0] ?? "");
    expect(first).toMatchObject({ _fixture: { synthetic: true, note: expect.stringMatching(/^SYNTHETIC: /) } });
  });
});

describe("antigravity timeout cases through the replay (T4.35, FR-ADP-11)", () => {
  const timeouts = () => antigravityConformanceCases(makeCwd).filter((c) => c.kind === "timeout");
  const own = (c: ConformanceCase): string[] => {
    const inv = c.adapter.compile(c.request, c.profile);
    return "ineligible" in inv ? [] : inv.argv.slice(0, inv.argv.indexOf("--"));
  };

  it("lists idle timeouts on both SIGTERM paths and a wall-clock timeout, each naming its kind", () => {
    expect(timeouts().map((c) => [own(c).includes("--ignore-term"), c.expect.failureDetail])).toEqual([
      [false, "idle timeout"],
      [true, "idle timeout"],
      [false, "wall_clock timeout"],
    ]);
  });

  it("swapping the idle and wall-clock budgets fails the detail check, so the timeout kind is pinned", async () => {
    for (const c of timeouts()) {
      const wall = c.expect.failureDetail === "wall_clock timeout";
      const swapped = replayAdapter("hang", {
        hang: true,
        ignoreTerm: own(c).includes("--ignore-term"),
        timeouts: wall ? { idleMs: 400 } : { wallClockMs: 400, idleMs: 10_000 },
      });
      const report = await runConformanceCase({ ...c, adapter: swapped });
      expect(report.result).toMatchObject({ ok: false, failureCode: "PROCESS_TIMEOUT" });
      expect(report.checks.filter((k) => !k.ok).map((k) => k.name)).toEqual(["failure detail matches"]);
    }
  });
});
