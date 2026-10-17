/**
 * T4.35 residual (2026-10-15, Delegated agent work, not owner-approved; synthetic fixtures only, no `agy` run, adapter
 * and parser unchanged). The suite in antigravity.test.ts shows each case passes; these tests show each case can fail:
 * a compile the replay refuses (exit 64 for the argv, exit 65 for an empty prompt) writes nothing to stdout and must
 * not satisfy any case's expectation. Later passes pin that every in-run failure detail family is reached by a case,
 * which cases fail when their stream is reordered, and that every one-word slip in the compiled argv exits 64. The
 * round after the #475 ninth parser residuals pins compile/argv/stream interactions: objectives that could be misread
 * as flags, an environment the replay refuses, an empty stream at a clean exit, and capture-file encodings.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type ConformanceCase,
  type ConformanceCaseReport,
  checkExpectation,
  runConformanceCase,
} from "../conformance.js";
import type { Invocation } from "../types.js";
import type { AntigravityAdapter } from "./adapter.js";
import {
  ANTIGRAVITY_RUNNABLE_KINDS,
  antigravityConformanceCases,
  DEFAULT_SESSION_ID,
  fixturePath,
  replayAdapter,
} from "./fixtures/cases.js";
import { SKIP_PERMISSIONS_FLAG } from "./protocol.js";

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
    expect(listed("unknown_then_result")).toEqual([
      [
        "success",
        {
          ok: true,
          nativeSessionId: DEFAULT_SESSION_ID,
          summary: "SYNTHETIC: recognized turn.",
          unknownEventCount: 1,
        },
      ],
    ]);
    expect(listed("error_after_result")).toEqual([
      [
        "malformed_output",
        {
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          failureDetail: "protocol: more than one result line",
          nativeSessionId: DEFAULT_SESSION_ID,
          summary: "Done.",
          unknownEventCount: 0,
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
          summary: "Done.",
          unknownEventCount: 0,
        },
      ],
    ]);
  });
});

describe("antigravity fixture inventory (T4.35, FR-ADP-11)", () => {
  // Each fixture outside the case list, with the reason it stays out. Adding a fixture without a case or a reason here
  // fails, so a synthetic shape cannot sit unreplayed.
  const OUT_OF_SUITE: Record<string, string> = {
    backing_result_only:
      "replays a result-only stream with backing vendor and model on the result line (T4.33, T4.6, FR-ADP-10; gap, pinned)",
    duplicate_status_key:
      "replays to a success: a duplicated `status` key keeps its last value, so SUCCESS hides ERROR (T4.33 gap, pinned)",
    non_tool_step_command: "replays to a success: a command off a `tool` step is not seen (T4.33 gap, pinned)",
    sandbox_violation_unrecorded: "replays to a success: the tool's error is not read (T4.33 gap, pinned)",
    trailing_repeat_step:
      "replays to a success: a repeated tool step after the result is deduplicated, so the order check misses it (T4.33 gap, pinned)",
    unsafe_then_good_result:
      "pins the T4.33 binding gap (an unsafe init id leaves the binding to the result) in parser-residual.test.ts",
    usage_unreconciled:
      "replays to a success: fractional and unreconciled counters are recorded as reported (T4.33 gap, pinned)",
    agy_error_quota:
      "replays to TOOL_FAILURE `exit code 3` like agy_error_exit3 (extractResult gets no stderr); the T6.15 mapping of its stderr AGY_ERROR line is shown in limit-signals.test.ts from the run's stderr tail",
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

/** `kind:fixture` plus the replay options that change the run, so two cases on one fixture get distinct labels. */
const label = (c: ConformanceCase): string => {
  const inv = c.adapter.compile(c.request, c.profile);
  const own = "ineligible" in inv ? [] : inv.argv.slice(0, inv.argv.indexOf("--"));
  const opts = [
    own.includes("--exit-code") ? `exit ${own[own.indexOf("--exit-code") + 1]}` : "",
    own.includes("--write") ? "write" : "",
    own.includes("--ignore-term") ? "ignores SIGTERM" : "",
    c.kind === "timeout" ? (c.expect.failureDetail ?? "") : "",
  ].filter((o) => o !== "");
  return `${c.kind}:${fixtureOf(c)}${opts.length > 0 ? ` (${opts.join(", ")})` : ""}`;
};

describe("each antigravity conformance case pins its own fixture (T4.35, FR-ADP-11)", () => {
  // A swap the case cannot tell apart, with the reason. The pair normalizes to one result, so no field the harness
  // reads can separate them; each is still its own case because it reaches that result from a different stream shape
  // or supervisor path. Every other swap must fail the case.
  const SAME_RESULT: Record<string, string> = {
    "task_failure:slash_command <- task_failure:credits_command":
      "C6 /usage and /credits envelopes differ only in `command`, which is ignored",
    "task_failure:credits_command <- task_failure:slash_command":
      "C6 /usage and /credits envelopes differ only in `command`, which is ignored",
    "task_failure:git_write_guard <- task_failure:git_write_guard_args":
      "the same `git commit` read from `parameters` and from `args`",
    "task_failure:git_write_guard_args <- task_failure:git_write_guard":
      "the same `git commit` read from `parameters` and from `args`",
    "malformed_output:conversation_changed <- malformed_output:step_conversation_changed":
      "the changed id on the result and on a step is one protocol error",
    "malformed_output:step_conversation_changed <- malformed_output:conversation_changed":
      "the changed id on the result and on a step is one protocol error",
    "task_failure:task_failure <- partial_mutation:task_failure (exit 1, write)":
      "same fixture; the case does not require that no file is written",
    "timeout:hang (idle timeout) <- timeout:hang (ignores SIGTERM, idle timeout)":
      "same fixture; only the kill path differs",
    "timeout:hang (ignores SIGTERM, idle timeout) <- timeout:hang (idle timeout)":
      "same fixture; only the kill path differs",
    "cancellation:hang (ignores SIGTERM) <- cancellation:hang": "same fixture; only the kill path differs",
    "cancellation:hang <- cancellation:hang (ignores SIGTERM)": "same fixture; only the kill path differs",
  };

  let runs: { c: ConformanceCase; name: string; report: ConformanceCaseReport }[] | undefined;
  const runAll = async () => {
    if (runs) return runs;
    runs = [];
    for (const c of runnable()) runs.push({ c, name: label(c), report: await runConformanceCase(c) });
    return runs;
  };

  it("every runnable case pins its detail, session id or none, summary or none, and unknown event count", () => {
    const loose = runnable()
      .filter(
        (c) =>
          (!c.expect.ok && c.expect.failureDetail === undefined) ||
          c.expect.nativeSessionId === undefined ||
          c.expect.summary === undefined ||
          c.expect.unknownEventCount === undefined,
      )
      .map(label);
    expect(loose).toEqual([]);
    const names = runnable().map(label);
    expect(new Set(names).size).toBe(names.length);
  });

  it("a case fails when another case's fixture is replayed in its place, except the listed same-result pairs", async () => {
    const all = await runAll();
    expect(all.filter((r) => !r.report.ok).map((r) => r.name)).toEqual([]);
    const passing: string[] = [];
    for (const a of all) {
      for (const b of all) {
        if (a === b || b.report.result === undefined) continue;
        const checks = checkExpectation(a.c.expect, b.report.result, b.c.request.workspace.cwd);
        if (checks.every((k) => k.ok)) passing.push(`${a.name} <- ${b.name}`);
      }
    }
    expect(passing.sort()).toEqual(Object.keys(SAME_RESULT).sort());
  });

  it("before the whole result was pinned, most swaps passed (the hole these expectations close)", async () => {
    const all = await runAll();
    // The expectations as they stood: code, plus a session id or detail on some cases. Strip the new pins.
    const loose = (c: ConformanceCase): ConformanceCase["expect"] => {
      const { summary: _s, unknownEventCount: _u, ...rest } = c.expect;
      return rest.nativeSessionId === null ? (({ nativeSessionId: _n, ...r }) => r)(rest) : rest;
    };
    let passing = 0;
    for (const a of all) {
      for (const b of all) {
        if (a === b || b.report.result === undefined) continue;
        if (checkExpectation(loose(a.c), b.report.result, b.c.request.workspace.cwd).every((k) => k.ok)) passing += 1;
      }
    }
    expect(passing).toBeGreaterThan(Object.keys(SAME_RESULT).length);
  });
});

describe("every in-run failure detail the antigravity parser can produce is reached by a case (T4.35, FR-ADP-11)", () => {
  // Each detail family `extractResult` and the shared classifier can end a compiled run with, matched against the
  // case list. Before this pass no case reached a non-string `error` or a status other than SUCCESS or ERROR.
  const FAMILIES: Record<string, RegExp> = {
    "provider error, model": /^model_unavailable: /,
    "provider error, auth": /^auth: /,
    "provider error, unmapped string": /^unknown: (?!non-string error field$)/,
    "provider error, non-string error field": /^unknown: non-string error field$/,
    "protocol, second result": /^protocol: more than one result line$/,
    "protocol, changed id": /^protocol: conversation id changed mid-run$/,
    "protocol, unsafe id": /^protocol: conversation id is not a safe token$/,
    "zero-token SUCCESS (Q-86)": /^SUCCESS with no reported tokens$/,
    "status other than SUCCESS with no error": /^SYNTHETIC_CANCELLED$/,
    "soft denial": /^denied: /,
    "Git-write guard (ADR-0039)": /^git write attempted: /,
    "tool after the result": /^tool call after the result line$/,
    "unparseable line": /^unparseable provider output$/,
    "no result": /^no result event$/,
    "unexpected exit": /^exit code \d+$/,
    "idle timeout": /^idle timeout$/,
    "wall-clock timeout": /^wall_clock timeout$/,
    cancellation: /^run cancelled$/,
  };
  // Details the classifier knows that a compiled Antigravity run cannot reach, with the reason. No case may expect one.
  const UNREACHABLE: [RegExp, string][] = [
    [
      /^provider state reached: /,
      "the provider-state guard does not apply in the one compiled cell, an approved bypass",
    ],
    [/^rate limit reported$/, "the parser emits no rate_limit event (no recorded shape, T4.33)"],
    [/^event handling failed$/, "an internal supervisor error, not a stream shape"],
    [/^(signal |spawn_error$|crashed$)/, "a crash of the process, not a stream shape the replay writes"],
  ];

  it("each family is named by at least one runnable case, and each case's detail is in exactly one family", () => {
    const details = runnable().map((c) => [label(c), c.expect.failureDetail] as const);
    const unmatched = Object.entries(FAMILIES)
      .filter(([, re]) => !details.some(([, d]) => d !== undefined && re.test(d)))
      .map(([name]) => name);
    expect(unmatched).toEqual([]);
    const outside = details
      .filter(([, d]) => d !== undefined && Object.values(FAMILIES).filter((re) => re.test(d)).length !== 1)
      .map(([name]) => name);
    expect(outside).toEqual([]);
    expect(details.filter(([, d]) => d !== undefined && UNREACHABLE.some(([re]) => re.test(d)))).toEqual([]);
  });

  it.each([
    ["error_not_string", "unknown: non-string error field", "ok"],
    ["status_unrecorded", "SYNTHETIC_CANCELLED", undefined],
  ])("%s carries tokens and binds the id, yet ends TOOL_FAILURE (%s)", async (fixture, detail, summary) => {
    const c = runnable().find((x) => fixtureOf(x) === fixture);
    if (!c) throw new Error(`missing ${fixture} case`);
    const report = await runConformanceCase(c);
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toEqual({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: detail,
      nativeSessionId: DEFAULT_SESSION_ID,
      unknownEventCount: 0,
      ...(summary === undefined ? {} : { summary }),
    });
  });
});

describe("antigravity whole-stream order: which cases pin the order of their own stream (T4.35, synthetic only)", () => {
  /** `c` replaying a copy of its fixture whose event lines are rewritten by `edit` (the metadata line stays first). */
  const reordered = (c: ConformanceCase, dir: string, tag: string, edit: (lines: string[]) => string[]) => {
    const a = c.adapter as AntigravityAdapter;
    const adapter = new Proxy(a, {
      get(target, key) {
        if (key === "compile") {
          return (...args: Parameters<AntigravityAdapter["compile"]>) => {
            const inv = target.compile(...args);
            if ("ineligible" in inv) return inv;
            const at = inv.argv.indexOf("--fixture") + 1;
            const [meta = "", ...events] = readFileSync(inv.argv[at] ?? "", "utf8")
              .split("\n")
              .filter((l) => l.trim() !== "");
            const copy = join(dir, `${tag}-${fixtureOf(c)}.jsonl`);
            writeFileSync(copy, `${[meta, ...edit(events)].join("\n")}\n`);
            return { ...inv, argv: inv.argv.map((w, i) => (i === at ? copy : w)) } satisfies Invocation;
          };
        }
        const v: unknown = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    return { ...c, adapter };
  };
  const isResult = (l: string) => {
    try {
      return (JSON.parse(l) as { event?: unknown }).event === "result";
    } catch {
      return false;
    }
  };
  const ORDERS = {
    reversed: (lines: string[]) => [...lines].reverse(),
    "result first": (lines: string[]) => [...lines.filter(isResult), ...lines.filter((l) => !isResult(l))],
  };
  // The cases a reordered stream fails, with what the reorder changes. Every other case reaches the same result in
  // any order: one result line (or none) decides it, and the parser reads init, non-tool steps, unknown lines and
  // denials the same before or after that line.
  const ORDER_SENSITIVE: Record<keyof typeof ORDERS, Record<string, string>> = {
    reversed: {
      "success:success_edit": "the write_to_file tool step lands after the result line",
      "malformed_output:malformed_output": "the result's response is read before the unparseable line ends the run",
      "malformed_output:conversation_changed": "the other conversation's result comes first and binds its id",
      "malformed_output:step_conversation_changed": "the other conversation's tool step lands after the result line",
      "malformed_output:trailing_tool": "the trailing tool step moves before the result: a clean success",
      "malformed_output:error_after_result": "the auth envelope comes first, so its error decides the code",
      "malformed_output:malformed_after_result":
        "the unparseable line comes first and ends the run before any id binds",
    },
    "result first": {
      "success:success_edit": "the write_to_file tool step lands after the result line",
      "malformed_output:malformed_output": "the result's response is read before the unparseable line ends the run",
      "malformed_output:conversation_changed": "the other conversation's result comes first and binds its id",
      "malformed_output:step_conversation_changed": "the other conversation's tool step lands after the result line",
    },
  };

  let swept: Record<string, { name: string; report: ConformanceCaseReport }[]> | undefined;
  const sweep = async () => {
    if (swept) return swept;
    const dir = makeCwd();
    const out: Record<string, { name: string; report: ConformanceCaseReport }[]> = {};
    for (const [tag, edit] of Object.entries(ORDERS)) {
      const reports: { name: string; report: ConformanceCaseReport }[] = [];
      // A hanging fixture has one line; its order is the supervisor's, not the stream's.
      for (const c of runnable().filter((x) => x.kind !== "timeout" && x.kind !== "cancellation")) {
        reports.push({ name: label(c), report: await runConformanceCase(reordered(c, dir, tag, edit)) });
      }
      out[tag] = reports;
    }
    swept = out;
    return out;
  };

  it.each(Object.keys(ORDERS) as (keyof typeof ORDERS)[])(
    "with its events %s, exactly the listed order-sensitive cases fail",
    async (tag) => {
      const failing = (await sweep())[tag]?.filter((r) => !r.report.ok).map((r) => r.name) ?? [];
      expect(failing.sort()).toEqual(Object.keys(ORDER_SENSITIVE[tag]).sort());
    },
    60_000,
  );

  it("pins the gap: init and non-tool steps after a clean result leave the run a success (only a tool step trips)", async () => {
    // unknown_then_result is listed as an order shape, yet its unknown line after the result passes the same case.
    const successes = (await sweep())["result first"]?.filter((r) => r.name.startsWith("success:")) ?? [];
    expect(successes.map((r) => [r.name, r.report.result?.ok])).toEqual([
      ["success:success_edit", false],
      ["success:unknown_event", true],
      ["success:backing_provider", true],
      ["success:unknown_then_result", true],
    ]);
    expect(successes[0]?.report.result?.failureDetail).toBe("tool call after the result line");
  });
});

describe("the antigravity replay dialect refuses every one-word slip in the compiled argv (T4.35, ADR-0045)", () => {
  /** The provider argv of the success case (after the launcher's `--`), rewritten by `edit`. */
  const run = (edit: (words: string[]) => string[]) => {
    const c = runnable().find((x) => fixtureOf(x) === "success_edit" && x.kind === "success");
    if (!c) throw new Error("missing success_edit case");
    return runConformanceCase(
      refusedBy(c, (argv) => {
        const sep = argv.indexOf("--");
        return [...argv.slice(0, sep + 1), ...edit(argv.slice(sep + 1))];
      }),
    );
  };
  const COMPILED = [
    "--prompt=synthetic antigravity objective",
    "--output-format",
    "stream-json",
    SKIP_PERMISSIONS_FLAG,
  ];

  it("the compiled provider argv is the four words the dialect expects", () => {
    const c = runnable()[0];
    if (!c) throw new Error("no case");
    const inv = c.adapter.compile(c.request, c.profile);
    expect("ineligible" in inv ? [] : inv.argv.slice(inv.argv.indexOf("--") + 1)).toEqual(COMPILED);
  });

  it("positive control: every order of the three flags replays the success (Go's flag package is order-free)", async () => {
    const groups = [[COMPILED[0] ?? ""], [COMPILED[1] ?? "", COMPILED[2] ?? ""], [COMPILED[3] ?? ""]];
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of orders) {
      const report = await run(() => order.flatMap((i) => groups[i] ?? []));
      expect([order, report.ok]).toEqual([order, true]);
    }
  });

  it.each(COMPILED.map((w, i) => [w, i] as const))(
    "deleting or doubling %s exits 64, so the slip cannot replay the success",
    async (_w, i) => {
      for (const edit of [
        (words: string[]) => words.filter((_, j) => j !== i),
        (words: string[]) => words.flatMap((x, j) => (j === i ? [x, x] : [x])),
      ]) {
        const report = await run(edit);
        expect(report.ok).toBe(false);
        expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: "exit code 64" });
      }
    },
  );
});

describe("the compiled run survives objectives the argv could misread (T4.35, compile/argv, synthetic only)", () => {
  // The one Assumption on the prompt word (protocol.ts): `--prompt=<prompt>` is accepted and the value is never read
  // as flags. The compile matrix pins the argv shape for one leading-dash objective; these pins run hostile objectives
  // end to end and hold the prompt word verbatim, so a compile that shelled out (splitting the value into words) or
  // truncated it would fail here. None of these shapes is duplicated in parser-residual.test.ts: they are compile
  // outputs, not stream shapes.
  const success = () => {
    const c = runnable().find((x) => fixtureOf(x) === "success_edit" && x.kind === "success");
    if (!c) throw new Error("missing success_edit case");
    return c;
  };
  const HOSTILE: [string, string][] = [
    ["the bypass flag itself", "--dangerously-skip-permissions"],
    ["a string flag name", "--output-format"],
    ["a whole fake flag pair", "--prompt=--output-format json"],
    ["the flag-parsing terminator", "--"],
    ["a leading equals sign", "=value"],
    ["an embedded newline", "first line\nsecond line"],
    ["shell metacharacters", "$(touch /tmp/x) ; | & `rm -rf`"],
    ["a tab and non-ASCII text", "r\u0009viser les fichiers \u65e5\u672c\u8a9e"],
    ["4,096 characters", "x".repeat(4096)],
  ];

  it.each(HOSTILE)(
    "an objective with %s stays one `--prompt=` word and replays the success",
    async (_label, objective) => {
      const base = success();
      const c = { ...base, request: { ...base.request, objective } };
      const inv = c.adapter.compile(c.request, c.profile);
      if ("ineligible" in inv) throw new Error("hostile objective must compile");
      expect(inv.argv.slice(inv.argv.indexOf("--") + 1)).toEqual([
        `--prompt=${objective}`,
        "--output-format",
        "stream-json",
        SKIP_PERMISSIONS_FLAG,
      ]);
      const report = await runConformanceCase(c);
      expect(report.ok).toBe(true);
      expect(report.result).toEqual({
        ok: true,
        nativeSessionId: DEFAULT_SESSION_ID,
        summary: "Added hello.txt.",
        unknownEventCount: 0,
      });
    },
  );

  it("a compile that splits the objective into words fails, so the pins have teeth", async () => {
    const base = success();
    const c = refusedBy(
      { ...base, request: { ...base.request, objective: "--sandbox fix the failing test" } },
      (argv) =>
        argv.flatMap((w) => {
          if (!w.startsWith("--prompt=")) return [w];
          const [head = "", ...rest] = w.slice("--prompt=".length).split(" ");
          return [`--prompt=${head}`, ...rest];
        }),
    );
    const report = await runConformanceCase(c);
    expect(report.ok).toBe(false);
    expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: "exit code 64" });
  });
});

describe("every antigravity conformance case fails a compile whose environment the replay refuses (T4.35)", () => {
  // The refusal table in antigravity.test.ts pins each wrong environment against the success case only; this sweep
  // pins that no runnable case can pass one either: every case names a detail the replay's exit 64 does not produce.
  // `env` is the adapter-declared fragment (supervisor: extraEnv always reaches the child and is allowlist-exempt).
  const withEnv = (
    c: ConformanceCase,
    edit: (env: Record<string, string>) => Record<string, string>,
  ): ConformanceCase => {
    const a = c.adapter as AntigravityAdapter;
    const adapter = new Proxy(a, {
      get(target, key) {
        if (key === "compile") {
          return (...args: Parameters<AntigravityAdapter["compile"]>) => {
            const inv = target.compile(...args);
            return "ineligible" in inv ? inv : ({ ...inv, env: edit(inv.env) } satisfies Invocation);
          };
        }
        const v: unknown = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    return { ...c, adapter };
  };
  const EDITS: [string, (env: Record<string, string>) => Record<string, string>][] = [
    ["the auto-update variable missing", () => ({})],
    ["the auto-update variable set to a value other than `true`", () => ({ AGY_CLI_DISABLE_AUTO_UPDATE: "false" })],
    [
      "GEMINI_API_KEY in the adapter-declared environment",
      (env) => ({ ...env, GEMINI_API_KEY: "synthetic-not-a-key" }),
    ],
  ];

  it.each(EDITS)("every runnable case fails when the compiled environment has %s", async (_label, edit) => {
    const passing: string[] = [];
    for (const c of runnable()) {
      const report = await runConformanceCase(withEnv(c, edit));
      expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: "exit code 64" });
      if (report.ok) passing.push(label(c));
    }
    expect(passing).toEqual([]);
  });
});

describe("antigravity empty stream at a clean exit (T4.35, stream/exit interaction, synthetic only)", () => {
  // rate_limit.jsonl pins an empty stream at exit 1 (the exit code decides); empty_exit0.jsonl is the exit-0 twin: a
  // clean expected exit alone is not a success, and with zero output lines nothing binds and no usage is recorded.
  // Before this pass no runnable case ended a compiled run from zero stdout lines (`no_result` keeps its init, step
  // and unknown events; `unknown_events` keeps five).
  it("lists exactly one case on empty_exit0, with the expectation", () => {
    const listed = antigravityConformanceCases(makeCwd).filter((c) => {
      const inv = c.adapter.compile(c.request, c.profile);
      return !("ineligible" in inv) && inv.argv.includes(fixturePath("empty_exit0"));
    });
    expect(listed.map((c) => [c.kind, c.expect])).toEqual([
      [
        "malformed_output",
        {
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          failureDetail: "no result event",
          nativeSessionId: null,
          summary: null,
          unknownEventCount: 0,
        },
      ],
    ]);
  });

  it("a provider that prints nothing and exits 0 ends `no result event` with nothing bound and no usage", async () => {
    const c = runnable().find((x) => fixtureOf(x) === "empty_exit0");
    if (!c) throw new Error("missing empty_exit0 case");
    const report = await runConformanceCase(c);
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toEqual({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "no result event",
      unknownEventCount: 0,
    });
  });
});

describe("antigravity capture-file encodings through the replay (T4.35, stream framing, synthetic only)", () => {
  // The parser pins trailing-CR tolerance at unit level (parser-residual.test.ts); these pins carry the bytes from
  // the capture file to the wire. A scrubbed capture pasted on another platform can arrive CRLF-encoded or with no
  // trailing newline on the last line; both must replay the success. A UTF-8 BOM makes the provenance line
  // unparseable, and the replay refuses the run (exit 64), so a provenance-unreadable capture cannot pass the suite:
  // if the replay replayed it past the metadata check, the failure would be an in-stream detail, not `exit code 64`.
  const dir = makeCwd();
  const reencoded = (edit: (raw: string) => string, tag: string): ConformanceCase => {
    const c = runnable().find((x) => fixtureOf(x) === "success_edit" && x.kind === "success");
    if (!c) throw new Error("missing success_edit case");
    const copy = join(dir, `${tag}-success_edit.jsonl`);
    const a = c.adapter as AntigravityAdapter;
    const adapter = new Proxy(a, {
      get(target, key) {
        if (key === "compile") {
          return (...args: Parameters<AntigravityAdapter["compile"]>) => {
            const inv = target.compile(...args);
            if ("ineligible" in inv) return inv;
            const at = inv.argv.indexOf("--fixture") + 1;
            writeFileSync(copy, edit(readFileSync(inv.argv[at] ?? "", "utf8")));
            return { ...inv, argv: inv.argv.map((w, i) => (i === at ? copy : w)) } satisfies Invocation;
          };
        }
        const v: unknown = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    return { ...c, adapter };
  };

  it.each([
    ["CRLF line endings", (raw: string) => raw.replace(/\n/g, "\r\n")],
    ["no trailing newline on the last line", (raw: string) => raw.replace(/\n$/, "")],
  ])("a capture with %s replays the success", async (_label, edit) => {
    const report = await runConformanceCase(reencoded(edit, "enc"));
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({ ok: true, nativeSessionId: DEFAULT_SESSION_ID });
  });

  it("a capture with a UTF-8 BOM is refused (exit 64), not replayed past its provenance line", async () => {
    const report = await runConformanceCase(reencoded((raw) => `\uFEFF${raw}`, "bom"));
    expect(report.ok).toBe(false);
    expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: "exit code 64" });
  });
});

describe("antigravity hang, host environment, probe and fixture-metadata interactions (T4.35, synthetic only)", () => {
  // The round after the #494 tenth parser residuals. Interactions the earlier rounds name but do not run: the kill path
  // each hang case claims (hang.jsonl's metadata says `ignore_term`; the `--hang` flag overrides it), a whole success
  // stream that then hangs, API-key variables in the controller's own environment, a compile collapsed to a probe argv
  // (the replay answers it without `check`), and the fixture metadata keys and placeholders the replay reads.
  const names = readdirSync(dirname(fixturePath("hang")))
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .sort();
  const linesOf = (name: string) =>
    readFileSync(fixturePath(name), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
  const metaOf = (name: string) =>
    (JSON.parse(linesOf(name)[0] ?? "") as { _fixture: Record<string, unknown> & { write?: { path: string } } })
      ._fixture;
  const successCase = () => {
    const c = runnable().find((x) => fixtureOf(x) === "success_edit" && x.kind === "success");
    if (!c) throw new Error("missing success_edit case");
    return c;
  };

  /**
   * Spawns `c`'s compiled invocation directly, reads its whole hang.jsonl stream, sends SIGTERM and reports whether the
   * process outlived it. The replay installs its SIGTERM handler right after its last write, so the signal waits a
   * settle delay after the last line rather than racing the first byte.
   */
  const sigterm = async (c: ConformanceCase, events: number) => {
    const inv = c.adapter.compile(c.request, c.profile);
    if ("ineligible" in inv) throw new Error("hang case must compile");
    const [exe = "", ...args] = inv.argv;
    const child = spawn(exe, args, { cwd: inv.cwd, env: { PATH: process.env.PATH ?? "", ...inv.env } });
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.on("exit", (_code, signal) => resolve(signal)),
    );
    let out = "";
    await new Promise<void>((resolve) =>
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
        if (out.split("\n").length > events) resolve();
      }),
    );
    await new Promise((r) => setTimeout(r, 200));
    child.kill("SIGTERM");
    const early = await Promise.race([exited, new Promise<"alive">((r) => setTimeout(() => r("alive"), 600))]);
    if (early !== "alive") return { signal: early, aliveAfterTerm: false };
    child.kill("SIGKILL");
    return { signal: await exited, aliveAfterTerm: true };
  };

  it("each hang case's replay takes the kill path its label names, overriding hang.jsonl's `ignore_term` metadata", async () => {
    expect(metaOf("hang").hang).toBe("ignore_term");
    const events = linesOf("hang").length - 1;
    const hangs = runnable().filter((c) => c.kind === "timeout" || c.kind === "cancellation");
    const seen: [string, { signal: NodeJS.Signals | null; aliveAfterTerm: boolean }][] = [];
    for (const c of hangs) seen.push([label(c), await sigterm(c, events)]);
    // The SAME_RESULT reason "only the kill path differs" holds only if the two paths really differ.
    expect(seen).toEqual(
      hangs.map((c) => [
        label(c),
        label(c).includes("ignores SIGTERM")
          ? { signal: "SIGKILL", aliveAfterTerm: true }
          : { signal: "SIGTERM", aliveAfterTerm: false },
      ]),
    );
  }, 30_000);

  it.each([
    ["honours SIGTERM", false],
    ["ignores SIGTERM", true],
  ])("a whole success stream that then hangs (%s) ends an idle timeout, not a success", async (_label, ignoreTerm) => {
    // The clean result line, its tokens and the write are all in; the provider not exiting still decides the run. Only
    // `ok` and the code differ from the success case: id, summary, the visible write and the empty process group hold.
    const adapter = replayAdapter("success_edit", { hang: true, ignoreTerm, timeouts: { idleMs: 400 } });
    const report = await runConformanceCase({ ...successCase(), adapter });
    expect(report.ok).toBe(false);
    expect(report.result).toEqual({
      ok: false,
      failureCode: "PROCESS_TIMEOUT",
      failureDetail: "idle timeout",
      nativeSessionId: DEFAULT_SESSION_ID,
      summary: "Added hello.txt.",
      unknownEventCount: 0,
    });
    expect(report.checks.filter((k) => !k.ok).map((k) => k.name)).toEqual([
      "result.ok matches",
      "failure code matches",
    ]);
  });

  it("API-key variables and a false auto-update flag in the controller's environment do not reach the replay", async () => {
    // The sweep above edits the adapter-declared fragment; this sets the same names on the controller process. The
    // supervisor drops the ones not allowlisted and the declared fragment wins, so the success still passes; if any
    // reached the replay it would exit 64.
    const c = successCase();
    const inv = c.adapter.compile(c.request, c.profile);
    if ("ineligible" in inv) throw new Error("success must compile");
    const HOST = {
      GEMINI_API_KEY: "synthetic-not-a-key",
      GOOGLE_API_KEY: "synthetic-not-a-key",
      GOOGLE_GEMINI_BASE_URL: "http://synthetic.example",
      GOOGLE_CLOUD_PROJECT: "synthetic-project",
      AGY_CLI_DISABLE_AUTO_UPDATE: "false",
    };
    expect(Object.keys(HOST).filter((k) => inv.envAllowlist.includes(k))).toEqual([]);
    for (const [k, v] of Object.entries(HOST)) vi.stubEnv(k, v);
    try {
      const report = await runConformanceCase(c);
      expect(report.checks.filter((k) => !k.ok)).toEqual([]);
      expect(report.result).toMatchObject({ ok: true, nativeSessionId: DEFAULT_SESSION_ID });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["--version", "--help"])(
    "every runnable case fails a compile collapsed to the probe argv `%s` (answered before the argv check)",
    async (probe) => {
      // The replay answers a probe argv at exit 0 with plain text and never reaches `check`, so this refusal is not an
      // exit 64: the text is one unparseable line with nothing bound, which no case expects.
      const passing: string[] = [];
      for (const c of runnable()) {
        const report = await runConformanceCase(
          refusedBy(c, (argv) => [...argv.slice(0, argv.indexOf("--") + 1), probe]),
        );
        expect(report.result).toEqual({
          ok: false,
          failureCode: "OUTPUT_PROTOCOL_ERROR",
          failureDetail: "unparseable provider output",
          unknownEventCount: 0,
        });
        if (report.ok) passing.push(label(c));
      }
      expect(passing).toEqual([]);
    },
    60_000,
  );

  it("each fixture's metadata names only keys the replay reads, and every fixture that does not hang names its exit", () => {
    // A misspelt key (`exitCode`, `requireresume`) is silently ignored, so a fixture would replay at exit 0 or as a
    // fresh run without anyone noticing.
    // `stderr` (T6.15): lines the replay writes to its stderr (agy_error_quota's AGY_ERROR line).
    const READ = new Set(["synthetic", "note", "exit", "write", "hang", "requireResume", "stderr"]);
    expect(names.flatMap((n) => Object.keys(metaOf(n)).flatMap((k) => (READ.has(k) ? [] : [`${n}.${k}`])))).toEqual([]);
    expect(names.filter((n) => !Object.hasOwn(metaOf(n), "exit") && !Object.hasOwn(metaOf(n), "hang"))).toEqual([]);
    expect(names.filter((n) => Object.hasOwn(metaOf(n), "hang"))).toEqual(["hang"]);
    expect(names.filter((n) => metaOf(n).requireResume === true)).toEqual([
      "resume",
      "resume_failure",
      "resume_unknown_id",
    ]);
  });

  it("only the first line carries `_fixture`, and the session placeholder appears only in resume fixtures", () => {
    // The replay skips every `_fixture` line, so a later one would vanish from the stream; and `--conversation` is never
    // compiled (Q-86), so a `{{SESSION_ID}}` placeholder in a fresh-run fixture would replay literally.
    // resume_unknown_id has none: an unknown id lands in a new conversation (C9 run 5), so its id is fixed.
    const later = (n: string, text: string) =>
      linesOf(n)
        .slice(1)
        .some((l) => l.includes(text));
    expect(names.filter((n) => later(n, '"_fixture"'))).toEqual([]);
    expect(names.filter((n) => later(n, "{{SESSION_ID}}"))).toEqual(["resume", "resume_failure"]);
  });

  it("a case on a fixture that writes expects that path, unless its replay flag writes another", () => {
    const writes = runnable()
      .map((c) => {
        const inv = c.adapter.compile(c.request, c.profile);
        const own = "ineligible" in inv ? [] : inv.argv.slice(0, inv.argv.indexOf("--"));
        const flag = own.includes("--write") ? own[own.indexOf("--write") + 1] : undefined;
        return [label(c), flag ?? metaOf(fixtureOf(c)).write?.path, c.expect.mutatedPath] as const;
      })
      .filter(([, written, expected]) => written !== undefined || expected !== undefined);
    expect(writes).toEqual([
      ["success:success_edit", "hello.txt", "hello.txt"],
      ["partial_mutation:task_failure (exit 1, write)", "partial.txt", "partial.txt"],
      ["partial_mutation:denied_after_write", "b.txt", "b.txt"],
      ["partial_mutation:success_edit (exit 1)", "hello.txt", "hello.txt"],
    ]);
  });
});

describe("antigravity replay provenance, blank-line framing, exit source and fixture path (T4.35, synthetic only)", () => {
  // The round after the #500 tenth conformance residuals. The replay reads its run metadata from the first line only
  // and skips blank lines, the `--exit-code` and `--write` flags replace the metadata's exit and write, and the fixture
  // path is read only after the argv check. Earlier rounds pin the metadata keys statically and one BOM; these run the
  // provenance variants, interior blank lines, each flag over its metadata twin and a fixture path that does not exist.
  const dir = makeCwd();
  const metaOf = (name: string) =>
    (JSON.parse(readFileSync(fixturePath(name), "utf8").split("\n")[0] ?? "") as { _fixture: Record<string, unknown> })
      ._fixture;
  const find = (fixture: string, kind?: string) => {
    const c = runnable().find((x) => fixtureOf(x) === fixture && (kind === undefined || x.kind === kind));
    if (!c) throw new Error(`missing ${fixture} case`);
    return c;
  };
  /** `c` replaying `path` in place of its own fixture. */
  const pointedAt = (c: ConformanceCase, path: string): ConformanceCase =>
    refusedBy(c, (argv) => argv.map((w, i) => (argv[i - 1] === "--fixture" ? path : w)));
  /** `c` replaying a copy of its fixture whose lines are rewritten by `edit` (the metadata line is `lines[0]`). */
  const rewritten = (c: ConformanceCase, tag: string, edit: (lines: string[]) => string[]): ConformanceCase => {
    const copy = join(dir, `${tag}-${fixtureOf(c)}.jsonl`);
    const lines = readFileSync(fixturePath(fixtureOf(c)), "utf8")
      .split("\n")
      .filter((l) => l !== "");
    writeFileSync(copy, `${edit(lines).join("\n")}\n`);
    return pointedAt(c, copy);
  };
  const withMeta = (meta: unknown) => (lines: string[]) => [JSON.stringify({ _fixture: meta }), ...lines.slice(1)];
  const META = metaOf("success_edit");

  it("positive control: the success case replays its own copied fixture unchanged", async () => {
    const report = await runConformanceCase(rewritten(find("success_edit", "success"), "same", (lines) => lines));
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
  });

  it.each([
    ["the metadata line removed", (lines: string[]) => lines.slice(1)],
    ["`synthetic: false`", withMeta({ ...META, synthetic: false })],
    ["`synthetic` as the string `true`", withMeta({ ...META, synthetic: "true" })],
    ["`_fixture` as a string", withMeta("SYNTHETIC: a note, not an object")],
    ["`_fixture` as null", withMeta(null)],
    ["`_fixture` as an array", withMeta([META])],
    ["a blank line before the metadata line", (lines: string[]) => ["", ...lines]],
    [
      "the metadata line after the first event",
      (lines: string[]) => [lines[1] ?? "", lines[0] ?? "", ...lines.slice(2)],
    ],
  ])("a capture with %s is refused (exit 64) and writes nothing", async (_label, edit) => {
    const c = find("success_edit", "success");
    const report = await runConformanceCase(rewritten(c, "prov", edit));
    expect(report.ok).toBe(false);
    expect(report.result).toEqual({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "exit code 64",
      unknownEventCount: 0,
    });
    expect(existsSync(join(c.request.workspace.cwd, "hello.txt"))).toBe(false);
  });

  it.each([
    ["spaces", "   "],
    ["a tab", "\t"],
    ["a lone carriage return", "\r"],
  ])("blank and %s-only lines between events are skipped, so the success replays unchanged", async (_label, filler) => {
    const report = await runConformanceCase(
      rewritten(find("success_edit", "success"), "blank", (lines) => [
        lines[0] ?? "",
        ...lines.slice(1).flatMap((l) => ["", filler, l]),
        filler,
      ]),
    );
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toEqual({
      ok: true,
      nativeSessionId: DEFAULT_SESSION_ID,
      summary: "Added hello.txt.",
      unknownEventCount: 0,
    });
  });

  it("each case's exit comes from `--exit-code`, else the metadata, and every `exit code N` detail names that exit", () => {
    const exits = runnable()
      .filter((c) => c.kind !== "timeout" && c.kind !== "cancellation")
      .map((c) => {
        const inv = c.adapter.compile(c.request, c.profile);
        const own = "ineligible" in inv ? [] : inv.argv.slice(0, inv.argv.indexOf("--"));
        const flag = own.includes("--exit-code") ? Number(own[own.indexOf("--exit-code") + 1]) : undefined;
        return [label(c), flag ?? Number(metaOf(fixtureOf(c)).exit ?? 0), c.expect.failureDetail] as const;
      });
    const named = exits.filter(([, , d]) => d !== undefined && /^exit code \d+$/.test(d));
    expect(named.map(([n, e, d]) => [n, d === `exit code ${e}`])).toEqual([
      ["task_failure:rate_limit", true],
      ["task_failure:agy_error_exit3", true],
      ["partial_mutation:success_edit (exit 1)", true],
    ]);
    // Every other nonzero exit is decided by the stream first: an envelope's error or a SUCCESS status at exit 1.
    expect(exits.filter(([, e, d]) => e !== 0 && !/^exit code \d+$/.test(d ?? "")).map(([n, e]) => [n, e])).toEqual([
      ["task_failure:model_unavailable", 1],
      ["task_failure:rate_limit_unrecorded", 1],
      ["auth_missing:auth_missing", 1],
      ["partial_mutation:task_failure (exit 1, write)", 1],
    ]);
  });

  it.each([
    ["rate_limit", "task_failure", "OUTPUT_PROTOCOL_ERROR", "no result event", null],
    ["agy_error_exit3", "task_failure", "OUTPUT_PROTOCOL_ERROR", "no result event", DEFAULT_SESSION_ID],
  ])(
    "`--exit-code 0` over %s's metadata exit fails its case: the stream alone decides (%s)",
    async (fixture, kind, code, detail, id) => {
      const c = find(fixture, kind);
      const report = await runConformanceCase({
        ...c,
        adapter: replayAdapter(fixture, { exitCode: 0 }),
      });
      expect(report.ok).toBe(false);
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: code,
        failureDetail: detail,
      });
      expect(report.result?.nativeSessionId).toBe(id ?? undefined);
    },
  );

  it("`--write` replaces the metadata write rather than adding to it, so the success case's mutation check fails", async () => {
    expect(META.write).toMatchObject({ path: "hello.txt" });
    const c = find("success_edit", "success");
    const report = await runConformanceCase({
      ...c,
      adapter: replayAdapter("success_edit", { write: "other.txt" }),
    });
    expect(existsSync(join(c.request.workspace.cwd, "other.txt"))).toBe(true);
    expect(existsSync(join(c.request.workspace.cwd, "hello.txt"))).toBe(false);
    expect(report.checks.filter((k) => !k.ok).map((k) => k.name)).toEqual(["workspace mutation visible"]);
  });

  it("pins the gap: a fixture path that does not exist crashes the replay at exit 1, which only rate_limit cannot tell", async () => {
    // The replay reads the fixture after the argv check, so a wrong path is a Node crash (exit 1, nothing on stdout).
    // rate_limit expects exactly that result; the fixture inventory above closes the gap by requiring each case's
    // fixture to exist on disk.
    const missing = join(dir, "does-not-exist.jsonl");
    const passing: string[] = [];
    for (const c of runnable()) {
      const report = await runConformanceCase(pointedAt(c, missing));
      expect(report.result).toMatchObject({
        ok: false,
        failureCode: "TOOL_FAILURE",
        failureDetail: "exit code 1",
      });
      if (report.ok) passing.push(label(c));
    }
    expect(passing).toEqual(["task_failure:rate_limit"]);
    const asDir = await runConformanceCase(pointedAt(find("rate_limit"), dir));
    expect(asDir.ok).toBe(true);
  }, 60_000);
});
