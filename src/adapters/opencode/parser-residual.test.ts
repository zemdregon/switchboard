/**
 * T4.53 residual (2026-10-15, Delegated agent work, not owner-approved; synthetic lines only, no `opencode` run,
 * adapter and parser unchanged; as Grok T4.23, Cursor T4.43 and Antigravity T4.33 `parser-residual.test.ts`). Pins
 * stream-order behaviour opencode.test.ts leaves implicit: the order of events emitted for one line, an unsafe id
 * before a safe one, an id that changes and changes back, the first provider error deciding the code, the trailing
 * tool check counted from the last `stop`, part-id usage dedupe across step reasons, and resume/compile parity across
 * request axes (not only scopes), with binding refusals ahead of every compile refusal. No native shape is claimed.
 * Second pass (2026-10-15, same terms): the order of a binding error line, an unknown type that binds (gap), the
 * trailing-tool and unreadable-event details, text after the last stop, usage dedupe gaps (a part id spent without
 * counters, first counters win, an empty-string id, dedupe across a changed id, state shared by two adapters), fresh
 * invocations from compile and resume, and parser/resume agreement on id shapes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { runConformanceCase } from "../conformance.js";
import { privilegedProfile } from "../fixtures/privileged.js";
import { guardEvent } from "../tool-guard.js";
import type { CompileRequest, ParseState, ResolvedProfile } from "../types.js";
import { OpenCodeAdapter } from "./adapter.js";
import { BYPASS_SCOPE, PRIVILEGED_BYPASS_PROFILE, RESUMED_SESSION_ID, replayAdapter } from "./fixtures/cases.js";

const dirs: string[] = [];
const makeCwd = () => {
  const d = mkdtempSync(join(tmpdir(), "sb-opencode-residual-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const adapter = () => new OpenCodeAdapter({ executable: "/opt/synthetic/opencode" });
const line = (o: unknown) => JSON.stringify(o);
const parse = (lines: object[]) => {
  const a = adapter();
  const state: ParseState = { lines: 0, unknownEvents: 0 };
  return { events: lines.flatMap((l) => a.parseEvent(line(l), state)), state };
};
const EXIT_OK = {
  outcome: "exited",
  exitCode: 0,
  signal: null,
  expectedExitCodes: [0],
} as const;
const EXIT_1 = { ...EXIT_OK, exitCode: 1 };
const SID = "ses_SYNTHETIC0000000000000001";
const OTHER = "ses_SYNTHETIC0000000000000002";
const sid = (id?: string) => (id === undefined ? {} : { sessionID: id });
const START = (id?: string) => ({
  type: "step_start",
  ...sid(id),
  part: { type: "step-start" },
});
const TEXT = (text: string, id?: string) => ({
  type: "text",
  ...sid(id),
  part: { type: "text", text },
});
const TOOL = (tool: string, input: object, id?: string) => ({
  type: "tool_use",
  ...sid(id),
  part: { tool, state: { status: "completed", input } },
});
const FINISH = (reason: string, partId?: string, id: string | undefined = SID) => ({
  type: "step_finish",
  ...sid(id),
  part: {
    ...(partId ? { id: partId } : {}),
    type: "step-finish",
    reason,
    tokens: { input: 3, output: 1 },
  },
});
const ERROR = (type: string, id: string | undefined = SID) => ({
  type: "error",
  ...sid(id),
  error: { type, message: "synthetic" },
});
const guarded = (lines: object[]) => parse(lines).events.map((e) => guardEvent(e, { cwd: "/work/tree", bypass: true }));

describe("opencode parser residuals: stream order (T4.53, synthetic lines; parser unchanged)", () => {
  it("on the line that first carries a sessionID, session_bound precedes that line's usage and result", () => {
    const { events, state } = parse([FINISH("stop", "prt_f1")]);
    expect(events).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
      {
        kind: "usage",
        source: "provider_reported",
        metrics: { input: 3, output: 1 },
      },
      { kind: "result", ok: true },
    ]);
    expect(state).toEqual({ lines: 1, unknownEvents: 0, nativeSessionId: SID });
  });

  it("an unsafe sessionID's protocol error precedes the same line's tool_call, which still reaches the guard", () => {
    const push = TOOL("shell", { command: "git push origin main" }, "--auto");
    expect(parse([push]).events).toEqual([
      {
        kind: "provider_error",
        category: "protocol",
        message: "session id is not a safe argument",
      },
      {
        kind: "tool_call",
        tool: "shell",
        name: "shell",
        command: "git push origin main",
      },
    ]);
    // ADR-0039: the guard verdict outranks the protocol error that came first on the line.
    expect(adapter().extractResult(guarded([push, FINISH("stop")]), EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      nativeSessionId: SID,
    });
  });

  it("an unsafe id before any safe one binds nothing; the later safe id binds, but the run still fails on the first", () => {
    const { events, state } = parse([START("--session"), TEXT("ok", SID), FINISH("stop")]);
    expect(events.filter((e) => e.kind === "session_bound")).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
    expect(state.nativeSessionId).toBe(SID);
    expect(adapter().extractResult(events, EXIT_OK)).toEqual({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: session id is not a safe argument",
      unknownEventCount: 0,
      nativeSessionId: SID,
      summary: "ok",
    });
  });

  it("an id that changes and changes back: each line naming the other id errors, it never binds, the return adds none", () => {
    const { events, state } = parse([START(SID), TEXT("a", OTHER), TEXT("b", SID), FINISH("stop", undefined, OTHER)]);
    const errors = events.filter((e) => e.kind === "provider_error");
    expect(errors).toEqual([
      {
        kind: "provider_error",
        category: "protocol",
        message: "session id changed mid-run",
      },
      {
        kind: "provider_error",
        category: "protocol",
        message: "session id changed mid-run",
      },
    ]);
    // One error per line naming another id (lines 2 and 4); line 3, back on the bound id, adds none.
    expect(events.map((e) => e.kind)).toEqual([
      "session_bound",
      "provider_error",
      "message",
      "message",
      "provider_error",
      "usage",
      "result",
    ]);
    expect(state.nativeSessionId).toBe(SID);
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      nativeSessionId: SID,
    });
  });

  it("a sessionID first seen on the final stop line binds there; earlier id-less lines are kept and the run succeeds", () => {
    const { events } = parse([START(), TOOL("read", { filePath: "/work/tree/a" }), TEXT("done"), FINISH("stop")]);
    expect(events.map((e) => e.kind)).toEqual(["tool_call", "message", "session_bound", "usage", "result"]);
    expect(adapter().extractResult(events, EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: SID,
      summary: "done",
    });
  });

  it("the first provider error in stream order decides the code, whatever error follows it", () => {
    const changed = TEXT("x", OTHER);
    const cases: [first: object, second: object, code: string][] = [
      [ERROR("provider.auth"), ERROR("provider.quota"), "AUTH_REQUIRED"],
      [ERROR("provider.quota"), ERROR("provider.auth"), "QUOTA_EXHAUSTED"],
      [ERROR("provider.no-route"), ERROR("provider.auth"), "MODEL_UNAVAILABLE"],
      [ERROR("provider.rate_limit"), ERROR("provider.auth"), "TOOL_FAILURE"],
      [changed, ERROR("provider.auth"), "OUTPUT_PROTOCOL_ERROR"],
      [ERROR("provider.auth"), changed, "AUTH_REQUIRED"],
    ];
    for (const [first, second, code] of cases) {
      const events = parse([START(SID), first, second, FINISH("stop")]).events;
      for (const exit of [EXIT_OK, EXIT_1]) {
        expect(adapter().extractResult(events, exit), `${line(first)} then ${line(second)}`).toMatchObject({
          ok: false,
          failureCode: code,
          nativeSessionId: SID,
        });
      }
    }
  });

  it("a tool call after the final stop keeps the classifier's detail when the code is not OUTPUT_PROTOCOL_ERROR", () => {
    const tool = TOOL("read", { filePath: "/work/tree/late" });
    expect(adapter().extractResult(parse([FINISH("stop"), tool]).events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the final stop step",
    });
    expect(adapter().extractResult(parse([FINISH("stop"), tool]).events, EXIT_1)).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "exit code 1",
    });
    expect(
      adapter().extractResult(parse([ERROR("provider.auth"), FINISH("stop"), tool]).events, EXIT_OK),
    ).toMatchObject({
      ok: false,
      failureCode: "AUTH_REQUIRED",
      failureDetail: "auth: provider.auth: synthetic",
    });
  });

  it("the trailing check counts from the last stop: a tool call between two stop steps is not trailing", () => {
    const between = parse([
      FINISH("stop", "prt_f1"),
      TOOL("read", { filePath: "/work/tree/a" }),
      FINISH("stop", "prt_f2"),
    ]);
    expect(adapter().extractResult(between.events, EXIT_OK)).toMatchObject({
      ok: true,
      nativeSessionId: SID,
    });
    // A later non-stop step does not move the final result, so a tool call after it is still trailing.
    const afterStep = parse([FINISH("stop", "prt_f1"), FINISH("tool-calls", "prt_f2"), TOOL("read", { path: "b" })]);
    expect(adapter().extractResult(afterStep.events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the final stop step",
    });
  });

  it("usage dedupe is by part id across step reasons: a stop reusing a tool-calls part id records no second usage", () => {
    const { events } = parse([FINISH("tool-calls", "prt_same"), FINISH("stop", "prt_same")]);
    expect(events.filter((e) => e.kind === "usage")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: "result", ok: true });
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
      ok: true,
    });
  });
});

describe("opencode stream-order residuals, second pass (T4.53, synthetic lines; parser unchanged)", () => {
  it("an error line that first carries a sessionID binds it before its provider_error, and the failure keeps the id", () => {
    const { events } = parse([ERROR("provider.quota"), FINISH("stop")]);
    expect(events.slice(0, 2)).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
      {
        kind: "provider_error",
        category: "quota",
        message: "provider.quota: synthetic",
      },
    ]);
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "QUOTA_EXHAUSTED",
      nativeSessionId: SID,
    });
  });

  it("pins the gap: an unknown event type carrying the first sessionID binds it, though the run then fails", () => {
    const { events, state } = parse([{ type: "synthetic_future", sessionID: SID }, TEXT("ok"), FINISH("stop")]);
    expect(events.slice(0, 2)).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
      { kind: "unknown", rawType: "synthetic_future" },
    ]);
    expect(state).toEqual({ lines: 3, unknownEvents: 1, nativeSessionId: SID });
    expect(adapter().extractResult(events, EXIT_OK)).toEqual({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "1 unreadable event(s) in the stream",
      unknownEventCount: 1,
      nativeSessionId: SID,
      summary: "ok",
    });
  });

  it("an unreadable tool_use after the last stop reports the trailing-tool detail, not the unreadable-event one", () => {
    const unreadableTool = { type: "tool_use", sessionID: SID, part: { state: { input: { command: "ls" } } } };
    expect(adapter().extractResult(parse([FINISH("stop"), unreadableTool]).events, EXIT_OK)).toEqual({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the final stop step",
      unknownEventCount: 1,
      nativeSessionId: SID,
    });
    // An unreadable step_finish after the stop is not a tool call: it is reported as an unreadable event.
    const unreadableStep = { type: "step_finish", sessionID: SID, part: { type: "step-finish" } };
    expect(adapter().extractResult(parse([FINISH("stop"), unreadableStep]).events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "1 unreadable event(s) in the stream",
      unknownEventCount: 1,
    });
  });

  it("an unreadable line with no stop keeps the classifier's detail; a stop that follows switches to the count", () => {
    const unreadable = { type: "synthetic_future", sessionID: SID };
    const noStop = adapter().extractResult(parse([unreadable, TEXT("ok")]).events, EXIT_OK);
    expect(noStop).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    expect(noStop.failureDetail).not.toBe("1 unreadable event(s) in the stream");
    expect(adapter().extractResult(parse([unreadable, unreadable, FINISH("stop")]).events, EXIT_OK)).toMatchObject({
      failureDetail: "2 unreadable event(s) in the stream",
      unknownEventCount: 2,
    });
  });

  it("text after the last stop joins the summary and leaves a clean run clean (only a tool call trips the order check)", () => {
    const { events } = parse([TEXT("before"), FINISH("stop"), TEXT("after")]);
    expect(adapter().extractResult(events, EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: SID,
      summary: "before\nafter",
    });
  });

  it("an unsafe id on the stop line still records that line's usage and result, in the order error, usage, result", () => {
    const { events, state } = parse([FINISH("stop", "prt_f1", "--auto")]);
    expect(events.map((e) => e.kind)).toEqual(["provider_error", "usage", "result"]);
    expect(state.nativeSessionId).toBeUndefined();
    expect(adapter().extractResult(events, EXIT_OK)).toEqual({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: session id is not a safe argument",
      unknownEventCount: 0,
    });
  });
});

describe("opencode usage dedupe gaps (T4.53, FR-CAP-01; synthetic lines, parser unchanged)", () => {
  const step = (part: object, id: string | undefined = SID) => ({
    type: "step_finish",
    ...sid(id),
    part: { type: "step-finish", ...part },
  });
  const usage = (lines: object[]) => parse(lines).events.filter((e) => e.kind === "usage");

  it("pins the gap: a part id first seen with no readable counters is spent, so its later counters are never recorded", () => {
    expect(
      usage([
        step({ id: "prt_a", reason: "tool-calls" }),
        step({ id: "prt_a", reason: "stop", tokens: { input: 5, output: 2 } }),
      ]),
    ).toEqual([]);
  });

  it("the first counters for a part id win: a repeat with other values is dropped, never summed or replaced", () => {
    expect(
      usage([
        step({ id: "prt_a", reason: "tool-calls", tokens: { input: 1 } }),
        step({ id: "prt_a", reason: "stop", tokens: { input: 9, output: 4 }, cost: 0.5 }),
      ]),
    ).toEqual([{ kind: "usage", source: "provider_reported", metrics: { input: 1 } }]);
  });

  it("a step_finish with no reason is unreadable and does not spend its part id; the later readable one records", () => {
    const { events, state } = parse([
      step({ id: "prt_a", tokens: { input: 7 } }),
      step({ id: "prt_a", reason: "stop", tokens: { input: 3 } }),
    ]);
    expect(events.filter((e) => e.kind === "usage")).toEqual([
      { kind: "usage", source: "provider_reported", metrics: { input: 3 } },
    ]);
    expect(state.unknownEvents).toBe(1);
  });

  it("pins the gap: an empty-string part id is a dedupe key, while a non-string part id is no key at all", () => {
    expect(
      usage([
        step({ id: "", reason: "tool-calls", tokens: { input: 1 } }),
        step({ id: "", reason: "stop", tokens: { input: 2 } }),
      ]),
    ).toHaveLength(1);
    expect(
      usage([
        step({ id: 7, reason: "tool-calls", tokens: { input: 1 } }),
        step({ id: 7, reason: "stop", tokens: { input: 2 } }),
      ]),
    ).toHaveLength(2);
  });

  it("pins the gap: dedupe ignores the session id, so a changed-id line reusing a part id records no usage", () => {
    const { events } = parse([
      step({ id: "prt_a", reason: "tool-calls", tokens: { input: 1 } }),
      step({ id: "prt_a", reason: "stop", tokens: { input: 2 } }, OTHER),
    ]);
    expect(events.filter((e) => e.kind === "usage")).toHaveLength(1);
    // The changed id still fails the run, so no usage of the other session reaches a successful result.
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      nativeSessionId: SID,
    });
  });

  it("dedupe state belongs to the ParseState, not the adapter: two adapters sharing one state count a part once", () => {
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const a = adapter().parseEvent(line(FINISH("tool-calls", "prt_shared")), state);
    const b = adapter().parseEvent(line(FINISH("stop", "prt_shared")), state);
    expect([...a, ...b].filter((e) => e.kind === "usage")).toHaveLength(1);
    expect(b).toEqual([{ kind: "result", ok: true }]);
    expect(state.lines).toBe(2);
  });
});

describe("opencode resume/compile parity across request axes (T4.53, FR-SES-03; adapter unchanged)", () => {
  const base: CompileRequest = {
    runId: "run_opencode_t453_parity",
    objective: "fix the failing test",
    constraints: [],
    workspace: { cwd: "/work/tree", writable: true },
    bypassApproved: true,
  };
  const approved: ResolvedProfile = {
    ...privilegedProfile(BYPASS_SCOPE),
    bypassApproved: true,
  };
  const requests: [label: string, CompileRequest][] = [
    ["base", base],
    ["flag-like objective", { ...base, objective: "--session ses_other --auto" }],
    ["multi-line objective", { ...base, objective: "line one\n--continue\nline three" }],
    ["requested model", { ...base, model: "synthetic/model" }],
    ["read-only workspace", { ...base, workspace: { cwd: "/work/tree", writable: false } }],
    ["request not approved", { ...base, bypassApproved: false }],
  ];
  const profiles: [label: string, ResolvedProfile][] = [
    ["approved privileged", approved],
    ["unapproved privileged", { ...approved, bypassApproved: false }],
    ["privileged without bypass", privilegedProfile({ ...BYPASS_SCOPE, bypass: false })],
    ["git-write allowlist", { ...approved, shellAllowlist: ["git push"] }],
    ["trusted-development", resolveTrustProfile("trusted-development")],
    ["inspect-untrusted approved", { ...resolveTrustProfile("inspect-untrusted"), bypassApproved: true }],
  ];
  const adapters: [label: string, OpenCodeAdapter][] = [
    ["executable", adapter()],
    [
      "launcher and timeouts",
      new OpenCodeAdapter({
        executable: "/opt/synthetic/node",
        launcherArgs: ["replay.mjs", "--provider", "opencode"],
        timeouts: { idleMs: 1_234 },
      }),
    ],
    ["no executable", new OpenCodeAdapter({ pathEnv: "" })],
  ];

  it("resumeArgs is compile with `--session <id>` before `--`, or the same refusal, for every request, profile and adapter", () => {
    let compiled = 0;
    for (const [al, a] of adapters) {
      for (const [pl, profile] of profiles) {
        for (const [rl, req] of requests) {
          const label = `${al} / ${pl} / ${rl}`;
          const first = a.compile(req, profile);
          const resumed = a.resumeArgs({ provider: "opencode", nativeSessionId: OTHER }, req, profile);
          if ("ineligible" in first) {
            expect(resumed, label).toEqual(first);
            continue;
          }
          compiled += 1;
          expect(resumed, label).toEqual({
            ...first,
            argv: [...first.argv.slice(0, -2), "--session", OTHER, "--", req.objective],
          });
          // The objective stays one argv word after the end-of-options marker, never read as a flag.
          expect(first.argv.at(-1), label).toBe(req.objective);
          expect(first.argv.indexOf("--"), label).toBe(first.argv.length - 2);
        }
      }
    }
    // A bypass scope compiles when the profile or the request carries the approval (FR-POL-03): the approved profile
    // with four requests plus the unapproved one with the three approved, writable, model-less requests, on the two
    // adapters that have an executable.
    expect(compiled).toBe(14);
  });

  it("binding refusals come before every compile refusal, whatever the request, profile or executable", () => {
    for (const [al, a] of adapters) {
      for (const [pl, profile] of profiles) {
        for (const [rl, req] of requests) {
          const label = `${al} / ${pl} / ${rl}`;
          expect(a.resumeArgs({ provider: "codex", nativeSessionId: SID }, req, profile), label).toEqual({
            ineligible: true,
            reason: "CAPABILITY_MISSING",
            detail: "binding is for codex",
          });
          for (const unsafe of ["", "--auto", "-c", "a b", "ses/1"]) {
            expect(a.resumeArgs({ provider: "opencode", nativeSessionId: unsafe }, req, profile), label).toEqual({
              ineligible: true,
              reason: "CAPABILITY_MISSING",
              detail: "native session id is not a safe single argument",
            });
          }
        }
      }
    }
  });

  it("compile and resumeArgs return fresh objects: mutating one invocation changes no later one, and inputs stay intact", () => {
    const a = adapter();
    const req = structuredClone(base);
    const first = a.compile(req, approved);
    if ("ineligible" in first) throw new Error("expected an invocation");
    const snapshot = structuredClone(first);
    first.argv.push("--auto");
    first.envAllowlist.push("OPENCODE_CONFIG_CONTENT");
    first.policyFlags.push("--auto");
    first.timeouts.idleMs = 1;
    first.env.OPENCODE_PERMISSION = "{}";
    expect(a.compile(req, approved)).toEqual(snapshot);
    const resumed = a.resumeArgs({ provider: "opencode", nativeSessionId: OTHER }, req, approved);
    expect(resumed).toEqual({
      ...snapshot,
      argv: [...snapshot.argv.slice(0, -2), "--session", OTHER, "--", req.objective],
    });
    expect(req).toEqual(base);
  });

  it("the parser and resumeArgs agree on id shapes: every id the parser binds resumes, every id it refuses is refused", () => {
    const ids = [
      "a",
      "0",
      "ses_x",
      "a.b:c-d_e",
      "A".repeat(256),
      "A".repeat(257),
      "-a",
      ".a",
      "_a",
      ":a",
      "a b",
      "a/b",
      "a\n",
      "é",
    ];
    for (const id of ids) {
      const { state } = parse([START(id)]);
      const bound = state.nativeSessionId === id;
      const resumed = adapter().resumeArgs({ provider: "opencode", nativeSessionId: id }, base, approved);
      expect("ineligible" in resumed, JSON.stringify(id)).toBe(!bound);
    }
  });

  it("a resumed replay with a flag-like objective passes the id from `--session`, not from the prompt", async () => {
    const report = await runConformanceCase({
      kind: "resume",
      adapter: replayAdapter("resume"),
      request: {
        runId: "run_opencode_t453_parity",
        objective: "--session ses_SYNTHETIC0000000000000099",
        constraints: [],
        workspace: { cwd: makeCwd(), writable: true },
        bypassApproved: true,
      },
      profile: PRIVILEGED_BYPASS_PROFILE,
      binding: { provider: "opencode", nativeSessionId: RESUMED_SESSION_ID },
      expect: { ok: true, nativeSessionId: RESUMED_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({
      ok: true,
      nativeSessionId: RESUMED_SESSION_ID,
      unknownEventCount: 0,
    });
  });
});
