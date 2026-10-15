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
 * Third pass (T4.6, FR-ADP-10; same terms): `backingProvider` and model on `session_bound` edge cases. Pinned gaps: a
 * vendor or model first reported on a later line with the same id is dropped (fixture `backing_on_finish.jsonl`); a
 * line whose id is empty, unsafe or changed loses its vendor; a non-null non-string root value shadows every other
 * spelling and the part. Values are bound verbatim (no trim or case folding, the harness name kept); a resumed run
 * binds the vendor its own stream reports (fixture `resume_backing.jsonl`), and resume never passes one.
 * Fourth pass (2026-10-15, same terms; mirrors Grok T4.23 fourth and fifth passes): a resumed stream reporting another
 * safe id binds it and succeeds, caught only by the conformance check (fixture `resume_other_id.jsonl`, gap); one
 * reporting no id succeeds unbound (gap); an empty or unsafe root `sessionID` shadows a safe part id (gap); a shell
 * command is never clipped and carries no target; prototype-named event types, error types and part ids are plain
 * strings; and the result honours the invocation's expected exit codes.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../artifacts/index.js";
import { createIdGenerator } from "../../ids/index.js";
import { createLedger, openLedger } from "../../ledger/index.js";
import { RunLifecycle } from "../../lifecycle/index.js";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { WorkspaceManager } from "../../workspace/index.js";
import { runConformanceCase } from "../conformance.js";
import { privilegedProfile } from "../fixtures/privileged.js";
import { AdapterRegistry } from "../registry.js";
import { createProbeRunner } from "../run.js";
import { guardEvent } from "../tool-guard.js";
import type { CompileRequest, NormalizedEvent, ParseState, ProbeRunner, ResolvedProfile } from "../types.js";
import { OpenCodeAdapter } from "./adapter.js";
import {
  BYPASS_SCOPE,
  DEFAULT_SESSION_ID,
  PRIVILEGED_BYPASS_PROFILE,
  RESUMED_SESSION_ID,
  replayAdapter,
} from "./fixtures/cases.js";

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

describe("opencode parser residuals, third pass: backingProvider and model on session_bound (T4.53, T4.6, FR-ADP-10; synthetic lines; parser unchanged)", () => {
  const bound = (events: readonly NormalizedEvent[]) => events.filter((e) => e.kind === "session_bound");
  const parseRaw = (raws: string[]) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    return { a, events: raws.flatMap((r) => a.parseEvent(r, state)), state };
  };
  const VENDOR = {
    backing_provider: "late-vendor",
    backingProvider: "late-camel",
    model: "Late Model",
  };

  it("pins the gap: a backing vendor or model first reported on a later line with the same id is dropped, on every line type", () => {
    for (const later of [
      { ...TEXT("ok", SID), ...VENDOR },
      { ...TOOL("read", { filePath: "a.txt" }, SID), ...VENDOR },
      { ...FINISH("tool-calls", "prt_f0"), ...VENDOR },
      { ...FINISH("stop", "prt_f1"), ...VENDOR },
      { ...TEXT("ok", SID), part: { type: "text", text: "ok", ...VENDOR } },
    ]) {
      const { events, state } = parse([START(SID), later, FINISH("stop", "prt_f9")]);
      expect(bound(events), JSON.stringify(later)).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
      expect(JSON.stringify(events)).not.toContain("late-");
      expect(JSON.stringify(events)).not.toContain("Late Model");
      expect(state.nativeSessionId).toBe(SID);
      expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
        ok: true,
        nativeSessionId: SID,
      });
    }
  });

  it("an id-less line carrying a vendor before the binding line loses it; the binding line reports only its own fields", () => {
    const { events } = parse([{ ...START(), ...VENDOR }, { ...TEXT("ok", SID), model: "Text Model" }, FINISH("stop")]);
    expect(bound(events)).toEqual([{ kind: "session_bound", nativeSessionId: SID, model: "Text Model" }]);
    // An empty id is absent too: its vendor is lost, nothing is bound and nothing errors.
    const empty = parse([{ ...START(""), ...VENDOR }, FINISH("stop")]);
    expect(bound(empty.events)).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
    expect(empty.events.filter((e) => e.kind === "provider_error")).toEqual([]);
  });

  it("a line with an unsafe id binds nothing and its vendor is lost; the later safe id binds without it and the run fails", () => {
    const { events, state } = parse([{ ...START("-x"), ...VENDOR }, TEXT("ok", SID), FINISH("stop")]);
    expect(events[0]).toEqual({
      kind: "provider_error",
      category: "protocol",
      message: "session id is not a safe argument",
    });
    expect(bound(events)).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
    expect(JSON.stringify(events)).not.toContain("late-");
    expect(state.nativeSessionId).toBe(SID);
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      nativeSessionId: SID,
    });
  });

  it("a vendor on a line naming a changed id is never bound; the first binding and its vendor stay", () => {
    const { events } = parse([
      { ...START(SID), backing_provider: "first-vendor", model: "First" },
      {
        ...TEXT("ok", OTHER),
        backing_provider: "changed-vendor",
        model: "Changed",
      },
      FINISH("stop"),
    ]);
    expect(bound(events)).toEqual([
      {
        kind: "session_bound",
        nativeSessionId: SID,
        model: "First",
        backingProvider: "first-vendor",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("changed-vendor");
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      nativeSessionId: SID,
    });
  });

  it("the binding line's vendor is reported whatever the line type, including an error and an unknown type (gap: the run fails)", () => {
    const withVendor = {
      sessionID: SID,
      backing_provider: "v-1",
      model: "M-1",
    };
    const cases: [object, string | undefined][] = [
      [
        {
          type: "error",
          ...withVendor,
          error: { type: "provider.auth", message: "x" },
        },
        "AUTH_REQUIRED",
      ],
      [{ type: "mystery_event", ...withVendor }, "OUTPUT_PROTOCOL_ERROR"],
      [{ ...TOOL("read", { filePath: "a.txt" }), ...withVendor }, undefined],
      [{ ...FINISH("stop"), ...withVendor }, undefined],
    ];
    for (const [first, code] of cases) {
      const { events } = parse([first, FINISH("stop", "prt_last")]);
      expect(bound(events), JSON.stringify(first)).toEqual([
        {
          kind: "session_bound",
          nativeSessionId: SID,
          model: "M-1",
          backingProvider: "v-1",
        },
      ]);
      const r = adapter().extractResult(events, EXIT_OK);
      expect(r, JSON.stringify(first)).toMatchObject(code ? { ok: false, failureCode: code } : { ok: true });
    }
  });

  it("a non-null non-string root backing_provider shadows root backingProvider and the part; root model alike shadows part model", () => {
    for (const raw of [0, false, "", { vendor: "x" }, ["x"]]) {
      const { events } = parse([
        {
          ...START(SID),
          backing_provider: raw,
          backingProvider: "root-camel",
          model: raw,
          part: {
            type: "step-start",
            backing_provider: "part-snake",
            backingProvider: "part-camel",
            model: "Part",
          },
        },
      ]);
      expect(bound(events), JSON.stringify(raw)).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
    }
    // A null at each level falls through to the next spelling, in the order root snake, root camel, part snake, part camel.
    const order = (o: Record<string, unknown>, p: Record<string, unknown>) =>
      bound(parse([{ ...START(SID), ...o, part: { type: "step-start", ...p } }]).events)[0];
    expect(order({ backing_provider: null, backingProvider: "rc" }, { backing_provider: "ps" })).toMatchObject({
      backingProvider: "rc",
    });
    expect(
      order({ backing_provider: null, backingProvider: null }, { backing_provider: "ps", backingProvider: "pc" }),
    ).toMatchObject({
      backingProvider: "ps",
    });
    expect(order({}, { backing_provider: null, backingProvider: "pc" })).toMatchObject({ backingProvider: "pc" });
    expect(order({ model: null }, { model: "Part" })).toMatchObject({
      model: "Part",
    });
  });

  it("backingProvider and model are bound verbatim: no trim, no case folding, the harness name kept, 128 characters unclipped", () => {
    const exact = "v".repeat(128);
    for (const [vendor, model] of [
      ["opencode", "opencode"],
      ["  Anthropic  ", " Model With Spaces "],
      ["ANTHROPIC", "claude-SONNET"],
      [exact, exact],
      ["éditeur", "modèle"],
      ["a/b:c", "provider/model-1"],
    ]) {
      const { events } = parse([{ ...START(SID), model, backing_provider: vendor }]);
      expect(bound(events), vendor).toEqual([
        {
          kind: "session_bound",
          nativeSessionId: SID,
          model,
          backingProvider: vendor,
        },
      ]);
    }
    const over = parse([{ ...START(SID), model: `${exact}m`, backing_provider: `${exact}b` }]);
    expect(bound(over.events)).toEqual([
      {
        kind: "session_bound",
        nativeSessionId: SID,
        model: `${exact}…`,
        backingProvider: `${exact}…`,
      },
    ]);
  });

  it("Object.prototype member names are plain strings: bound verbatim, never resolved to an inherited member", () => {
    for (const name of ["constructor", "hasOwnProperty", "valueOf", "toString", "__proto__", "__defineGetter__"]) {
      const { events } = parse([{ ...START(SID), model: name, backing_provider: name }, FINISH("stop")]);
      expect(bound(events), name).toEqual([
        {
          kind: "session_bound",
          nativeSessionId: SID,
          model: name,
          backingProvider: name,
        },
      ]);
      expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
        ok: true,
        nativeSessionId: SID,
      });
    }
  });

  it("an own __proto__ key in the JSON, at the root or in the part, cannot supply a backing vendor, model or session id", () => {
    const smuggled = `{"sessionID":"${SID}","model":"proto-model","backing_provider":"proto-vendor","backingProvider":"proto-camel"}`;
    const root = parseRaw([`{"type":"step_start","__proto__":${smuggled},"part":{"type":"step-start"}}`]);
    expect(bound(root.events)).toEqual([]);
    expect(root.state.nativeSessionId).toBeUndefined();
    const part = parseRaw([
      `{"type":"step_start","sessionID":"${SID}","part":{"type":"step-start","__proto__":${smuggled}}}`,
    ]);
    expect(bound(part.events)).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
    expect(JSON.stringify([root.events, part.events])).not.toContain("proto-");
  });

  it("a resumed stream's binding carries its own vendor; resumeArgs never passes a vendor or model and ignores extra binding fields", () => {
    const { events } = parse([
      {
        ...START(RESUMED_SESSION_ID),
        backing_provider: "backing-resumed",
        model: "Resumed Model",
      },
    ]);
    expect(bound(events)).toEqual([
      {
        kind: "session_bound",
        nativeSessionId: RESUMED_SESSION_ID,
        model: "Resumed Model",
        backingProvider: "backing-resumed",
      },
    ]);
    const request: CompileRequest = {
      runId: "run_opencode_t453_third",
      objective: "resume",
      constraints: [],
      workspace: { cwd: "/work/tree", writable: true },
      bypassApproved: true,
    };
    const plain = adapter().resumeArgs(
      { provider: "opencode", nativeSessionId: RESUMED_SESSION_ID },
      request,
      PRIVILEGED_BYPASS_PROFILE,
    );
    const extra = {
      provider: "opencode",
      nativeSessionId: RESUMED_SESSION_ID,
      backingProvider: "x-vendor",
      model: "x-model",
    } as const;
    const withExtra = adapter().resumeArgs(extra, request, PRIVILEGED_BYPASS_PROFILE);
    expect(withExtra).toEqual(plain);
    expect(JSON.stringify(withExtra)).not.toContain("x-vendor");
    expect(JSON.stringify(withExtra)).not.toContain("x-model");
  });

  it("fixture backing_on_finish replays to success with no backing vendor or model bound", async () => {
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("backing_on_finish"),
      request: {
        runId: "run_opencode_backing_on_finish",
        objective: "synthetic opencode objective",
        constraints: [],
        workspace: { cwd: makeCwd(), writable: true },
        bypassApproved: true,
      },
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toEqual({
      ok: true,
      nativeSessionId: DEFAULT_SESSION_ID,
      unknownEventCount: 0,
      summary: "ok",
    });
  });

  it("fixture resume_backing replays a resumed run binding the resumed id with its vendor and model", async () => {
    const report = await runConformanceCase({
      kind: "resume",
      adapter: replayAdapter("resume_backing"),
      request: {
        runId: "run_opencode_resume_backing",
        objective: "synthetic opencode objective",
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

  it("fixture backing_on_finish through RunLifecycle stores harness opencode with no backing vendor and no model", async () => {
    const root = realpathSync(makeCwd());
    const repo = join(root, "repo");
    mkdirSync(repo);
    const g = (...args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd: repo,
        env: {
          PATH: process.env.PATH ?? "",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "OpenCode Dev",
          GIT_AUTHOR_EMAIL: "opencode@example.test",
          GIT_COMMITTER_NAME: "OpenCode Dev",
          GIT_COMMITTER_EMAIL: "opencode@example.test",
        },
      });
    g("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "initial\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    const dataDir = join(root, "data");
    mkdirSync(dataDir);
    const db = openLedger(dataDir);
    const ids = createIdGenerator();
    const ledger = createLedger(db, { ids });
    const artifacts = new ArtifactStore(join(dataDir, "artifacts"));
    const real = createProbeRunner();
    // A synthetic stored login for the T4.54 auth preflight; every other probe runs the replay launcher.
    const probeRunner: ProbeRunner = async (argv, opts) =>
      argv.includes("auth") && argv.includes("list")
        ? {
            stdout: JSON.stringify([
              {
                id: "opencode",
                name: "Synthetic",
                connections: [{ type: "oauth" }],
              },
            ]),
            stderr: "",
            exitCode: 0,
            timedOut: false,
          }
        : real(argv, opts);
    const lifecycle = new RunLifecycle({
      ledger,
      workspace: new WorkspaceManager({
        db,
        artifacts,
        dataDir,
        allowedRoots: [root],
        ids,
      }),
      artifacts,
      adapters: new AdapterRegistry().register(replayAdapter("backing_on_finish")),
      allowedRoots: [root],
      globalConcurrency: 1,
      resolveProfile: (name) => resolveTrustProfile(name),
      probeRunner,
    });
    lifecycle.start();
    try {
      const { runId, metaSessionId } = await lifecycle.submit({
        clientId: "c",
        objective: "a vendor reported only on the step_finish line",
        workspace: repo,
        trustProfile: "privileged",
        provider: "opencode",
        privileged: { scope: BYPASS_SCOPE, approvedByClientPolicy: true },
      });
      const done = await lifecycle.waitForTerminal(runId);
      expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
      const bindings = ledger.listProviderBindings(metaSessionId);
      expect(bindings).toEqual([
        expect.objectContaining({
          provider: "opencode",
          harness: "opencode",
          native_session_id: DEFAULT_SESSION_ID,
        }),
      ]);
      expect(bindings[0]?.backing_provider ?? null).toBeNull();
      expect(bindings[0]?.model ?? null).toBeNull();
      const rows = ledger.listUsageObservationsForRun(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        provider: "opencode",
        harness: "opencode",
        source: "provider_reported",
      });
      expect(rows[0]?.backing_provider ?? null).toBeNull();
      expect(JSON.stringify([bindings, rows])).not.toContain("backing-late");
      expect(JSON.stringify([bindings, rows])).not.toContain("Finish Model 2");
    } finally {
      await lifecycle.shutdown();
      db.close();
    }
  });
});

describe("opencode parser residuals, fourth pass: resume id gaps, id shadowing, prototype values and exit codes (T4.53, synthetic lines; parser unchanged)", () => {
  const OTHER_RESUMED = "ses_SYNTHETIC0000000000000099";
  const request = (): CompileRequest => ({
    runId: "run_opencode_t453_fourth",
    objective: "synthetic opencode objective",
    constraints: [],
    workspace: { cwd: makeCwd(), writable: true },
    bypassApproved: true,
  });

  it("pins the gap end to end: fixture resume_other_id passes `--session <requested>`, binds the reported id and succeeds", async () => {
    const a = replayAdapter("resume_other_id");
    const binding = { provider: "opencode" as const, nativeSessionId: RESUMED_SESSION_ID };
    const req = request();
    const inv = a.resumeArgs(binding, req, PRIVILEGED_BYPASS_PROFILE);
    if ("ineligible" in inv) throw new Error(inv.detail);
    expect(inv.argv.slice(-4)).toEqual(["--session", RESUMED_SESSION_ID, "--", req.objective]);
    const report = await runConformanceCase({
      kind: "resume",
      adapter: a,
      request: req,
      profile: PRIVILEGED_BYPASS_PROFILE,
      binding,
      expect: { ok: true, nativeSessionId: RESUMED_SESSION_ID },
    });
    // Only the conformance harness compares the ids; the adapter result is a success on the other session.
    expect(report.checks.filter((k) => !k.ok).map((k) => k.name)).toEqual(["native session id"]);
    expect(report.result).toMatchObject({ ok: true, nativeSessionId: OTHER_RESUMED, unknownEventCount: 0 });
  });

  it("pins the gap: a resumed stream that reports no sessionID succeeds with nothing bound (the parser never sees the request)", () => {
    const { sessionID: _bound, ...idless } = FINISH("stop", "prt_f1");
    const { events, state } = parse([START(), TEXT("resumed"), idless]);
    expect(events.filter((e) => e.kind === "session_bound")).toEqual([]);
    expect(state.nativeSessionId).toBeUndefined();
    expect(adapter().extractResult(events, EXIT_OK)).toEqual({ ok: true, unknownEventCount: 0, summary: "resumed" });
  });

  it("pins the gap: a root sessionID that is an empty string shadows a safe part id, so the line binds nothing", () => {
    const withPart = (root: unknown) => ({
      type: "step_start",
      sessionID: root,
      part: { type: "step-start", sessionID: SID },
    });
    const empty = parse([withPart("")]);
    expect(empty.events).toEqual([]);
    expect(empty.state.nativeSessionId).toBeUndefined();
    // An unsafe root id shadows the part's too: the line errors and binds nothing.
    expect(parse([withPart("--auto")]).events).toEqual([
      { kind: "provider_error", category: "protocol", message: "session id is not a safe argument" },
    ]);
    // Only a missing, null or non-string root value falls through to the part's id.
    for (const root of [undefined, null, 7, { id: OTHER }]) {
      expect(parse([withPart(root)]).state.nativeSessionId, JSON.stringify(root)).toBe(SID);
    }
  });

  it("a shell command is never clipped (a target is), so a Git write past 2,000 characters still reaches the guard", () => {
    const command = `echo ${"x".repeat(2_100)} && git push origin main`;
    const { events } = parse([START(SID), TOOL("shell", { command, filePath: "/work/tree/a" }), FINISH("stop")]);
    // A shell tool carries no target, even when its input names a path.
    expect(events.find((e) => e.kind === "tool_call")).toEqual({
      kind: "tool_call",
      tool: "shell",
      name: "shell",
      command,
    });
    expect(
      adapter().extractResult(guarded([START(SID), TOOL("shell", { command }), FINISH("stop")]), EXIT_OK),
    ).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: SID });
  });

  it("prototype-named values are plain strings: an event type is unknown, an error type unmapped, a part id an ordinary key", () => {
    for (const name of ["constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
      const unknown = parse([{ type: name, sessionID: SID }]);
      expect(unknown.events.at(-1), name).toEqual({ kind: "unknown", rawType: name });
      expect(unknown.state.unknownEvents, name).toBe(1);
      const failed = parse([ERROR(name), FINISH("stop")]).events;
      expect(
        failed.find((e) => e.kind === "provider_error"),
        name,
      ).toEqual({
        kind: "provider_error",
        category: "unknown",
        message: `${name}: synthetic`,
      });
      expect(adapter().extractResult(failed, EXIT_OK), name).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE" });
      // Each prototype-named part id dedupes its own repeat and collides with no other id.
      const usage = parse([FINISH("tool-calls", name), FINISH("tool-calls", name), FINISH("stop", "prt_other")]).events;
      expect(
        usage.filter((e) => e.kind === "usage"),
        name,
      ).toHaveLength(2);
    }
  });

  it("extractResult honours the compiled expected exit codes rather than a hard-coded 0", () => {
    const { events } = parse([FINISH("stop")]);
    expect(adapter().extractResult(events, { ...EXIT_OK, exitCode: 2, expectedExitCodes: [0, 2] })).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: SID,
    });
    expect(adapter().extractResult(events, { ...EXIT_OK, expectedExitCodes: [2] })).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "exit code 0",
      nativeSessionId: SID,
    });
    expect(adapter().extractResult(events, { ...EXIT_OK, exitCode: null })).toMatchObject({ ok: false });
    // compile and resumeArgs both expect exit 0 only, so a resumed run is judged the same way.
    const req = request();
    for (const inv of [
      adapter().compile(req, PRIVILEGED_BYPASS_PROFILE),
      adapter().resumeArgs({ provider: "opencode", nativeSessionId: SID }, req, PRIVILEGED_BYPASS_PROFILE),
    ]) {
      if ("ineligible" in inv) throw new Error(inv.detail);
      expect(inv.expectedExitCodes).toEqual([0]);
    }
  });
});
