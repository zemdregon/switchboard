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
 * Sixth pass (2026-10-15, same terms; mirrors Grok T4.23 sixth pass and Cursor/Antigravity fifth passes): an
 * unrecognized tool name whose input carries a command falls back to shell and reaches the guard (fixture
 * `custom_tool_command.jsonl`); non-object state or input drops the command so a raw string command escapes the guard
 * to success (gap); an empty-string filePath shadows a valid path (gap); read/edit tools ignore input command; an
 * unreadable tool_use after the last stop reports the trailing-tool detail, masking unreadable-event counts, while an
 * unreadable non-tool line reports the unreadable-event count; multiple stop steps succeed if no tool follows the last
 * one; duplicate JSON keys resolve to the last one; line types match exactly (case/whitespace variants are unknown); an
 * empty text part emits no message and counts nothing unknown; a BOM line is unparseable framing; token metrics read
 * from part.tokens only (root tokens dropped, non-negative fractions kept); and summary takes the last 2,000 characters.
 * Seventh pass (2026-10-16, same terms): custom command value/status boundaries, resume id/vendor mismatches,
 * non-stop finishes after stop, and late errors that a later stop cannot erase. These pin observed synthetic
 * behaviour, including gaps; no new native shape or production fix is claimed.
 * Eighth pass (2026-10-16, same terms): a first id reported late (after the stop, on a trailing tool, text, non-stop
 * finish or error line) binds there with its vendor (fixture `late_session_bound.jsonl`); vendor/model spelling
 * parity, independence, 128-character clipping and an empty-string root shadowing the part (gap); the run result never
 * carries vendor or model; resume argv positions and id-length boundaries; and fail-closed trailing events, with an
 * open step_start after the last stop still a success (gap, fixture `trailing_step_start.jsonl`).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import type {
  CompileRequest,
  ExitInfo,
  NativeBinding,
  NormalizedEvent,
  ParseState,
  ProbeRunner,
  ResolvedProfile,
} from "../types.js";
import { OpenCodeAdapter } from "./adapter.js";
import {
  BYPASS_SCOPE,
  DEFAULT_SESSION_ID,
  fixturePath,
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

describe("opencode parser residuals, sixth pass: fallback tools, input shapes, trailing details and framing (T4.53, synthetic lines; parser unchanged)", () => {
  const request = (): CompileRequest => ({
    runId: "run_opencode_t453_sixth",
    objective: "synthetic opencode objective",
    constraints: [],
    workspace: { cwd: makeCwd(), writable: true },
    bypassApproved: true,
  });
  const parseRaw = (raws: string[]) => {
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    return { a, events: raws.flatMap((r) => a.parseEvent(r, state)), state };
  };

  it("an unrecognized tool name whose input carries a string command falls back to shell and is guarded", () => {
    for (const toolName of ["custom_exec", "terminal_cmd", "run", "powershell", ""]) {
      const call = TOOL(toolName, { command: "git push origin main" });
      const { events } = parse([START(SID), call, FINISH("stop")]);
      expect(
        events.find((e) => e.kind === "tool_call"),
        toolName,
      ).toEqual({
        kind: "tool_call",
        tool: "shell",
        name: toolName,
        command: "git push origin main",
      });
      expect(adapter().extractResult(guarded([START(SID), call, FINISH("stop")]), EXIT_OK), toolName).toMatchObject({
        ok: false,
        failureCode: "PERMISSION_BLOCKED",
        nativeSessionId: SID,
      });
    }
    // Without a string command in input, an unrecognized tool is `other` and has no command or target.
    const withoutCommand = parse([START(SID), TOOL("custom_exec", { path: "/work/file.txt" }), FINISH("stop")]).events;
    expect(withoutCommand.find((e) => e.kind === "tool_call")).toEqual({
      kind: "tool_call",
      tool: "other",
      name: "custom_exec",
    });
  });

  it("fixture custom_tool_command replays a Git write behind an unrecognized tool to PERMISSION_BLOCKED", async () => {
    const report = await runConformanceCase({
      kind: "task_failure",
      adapter: replayAdapter("custom_tool_command"),
      request: request(),
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", unknownEventCount: 0 });
  });

  it("pins the gap: a non-object state or input drops the command, so a raw command escapes the guard to success", () => {
    // When state or input is a string or array instead of an object, input is undefined and command is lost.
    for (const badInput of ["git push origin main", ["git push origin main"], 7, null]) {
      const call = {
        type: "tool_use",
        sessionID: SID,
        part: { tool: "shell", state: { status: "completed", input: badInput } },
      };
      const { events } = parse([START(SID), call, FINISH("stop")]);
      expect(
        events.find((e) => e.kind === "tool_call"),
        JSON.stringify(badInput),
      ).toEqual({
        kind: "tool_call",
        tool: "shell",
        name: "shell",
      });
      // The guard sees no command, so the run succeeds (gap pinned).
      expect(
        adapter().extractResult(guarded([START(SID), call, FINISH("stop")]), EXIT_OK),
        JSON.stringify(badInput),
      ).toEqual({ ok: true, unknownEventCount: 0, nativeSessionId: SID });
    }
    // Similarly, input placed directly on part instead of part.state is ignored.
    const directInput = {
      type: "tool_use",
      sessionID: SID,
      part: { tool: "shell", input: { command: "git push origin main" } },
    };
    expect(adapter().extractResult(guarded([START(SID), directInput, FINISH("stop")]), EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: SID,
    });
  });

  it("pins the gap: an empty-string filePath shadows a valid path in read and edit tools", () => {
    const { events } = parse([
      START(SID),
      TOOL("read", { filePath: "", path: "/work/notes.txt" }),
      TOOL("edit", { filePath: "", path: "/work/code.ts" }),
      FINISH("stop"),
    ]);
    const tools = events.filter((e) => e.kind === "tool_call");
    expect(tools).toEqual([
      { kind: "tool_call", tool: "read", name: "read", target: "" },
      { kind: "tool_call", tool: "edit", name: "edit", target: "" },
    ]);
    // Only a non-string or missing filePath falls through to path.
    for (const root of [undefined, null, 7]) {
      const fb = parse([START(SID), TOOL("read", { filePath: root, path: "/work/notes.txt" }), FINISH("stop")]).events;
      expect(
        fb.find((e) => e.kind === "tool_call"),
        JSON.stringify(root),
      ).toEqual({
        kind: "tool_call",
        tool: "read",
        name: "read",
        target: "/work/notes.txt",
      });
    }
  });

  it("read and edit tools ignore input.command, and tool names longer than 64 characters are clipped", () => {
    const call = TOOL("read", { command: "git push origin main", filePath: "/work/notes.txt" });
    const { events } = parse([START(SID), call, FINISH("stop")]);
    expect(events.find((e) => e.kind === "tool_call")).toEqual({
      kind: "tool_call",
      tool: "read",
      name: "read",
      target: "/work/notes.txt",
    });
    // The command is ignored, so the guard sees no command and the run succeeds.
    expect(adapter().extractResult(guarded([START(SID), call, FINISH("stop")]), EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: SID,
    });

    const longName = "x".repeat(80);
    const longTool = parse([START(SID), TOOL(longName, { command: "ls" }), FINISH("stop")]).events;
    expect(longTool.find((e) => e.kind === "tool_call")).toMatchObject({
      name: `${"x".repeat(64)}…`,
      tool: "shell",
    });
  });

  it("detail ranking: an unreadable tool_use after stop reports the trailing-tool detail, masking unreadable counts", () => {
    const unreadableToolUse = { type: "tool_use", sessionID: SID, part: { type: "tool" } };
    const { events } = parse([START(SID), TEXT("hello"), FINISH("stop"), unreadableToolUse]);
    expect(events.at(-1)).toEqual({ kind: "unknown", rawType: "tool_use" });
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the final stop step",
      unknownEventCount: 1,
    });

    // An unreadable non-tool line after stop reports the unreadable count, not the trailing-tool detail.
    for (const nonTool of [
      { type: "tool_call", sessionID: SID },
      { type: "telemetry", sessionID: SID },
      { type: "step_start", sessionID: SID, part: { type: "invalid" } },
    ]) {
      const res = adapter().extractResult(parse([START(SID), TEXT("hello"), FINISH("stop"), nonTool]).events, EXIT_OK);
      expect(res, JSON.stringify(nonTool)).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "1 unreadable event(s) in the stream",
        unknownEventCount: 1,
      });
    }

    // A provider error before stop outranks both trailing tools and unreadable events.
    const errRes = adapter().extractResult(
      parse([START(SID), ERROR("provider.auth"), FINISH("stop"), unreadableToolUse]).events,
      EXIT_OK,
    );
    expect(errRes).toMatchObject({
      ok: false,
      failureCode: "AUTH_REQUIRED",
      failureDetail: "auth: provider.auth: synthetic",
    });
  });

  it("multiple stop steps succeed when no tool call follows the last one; a tool between stops is not trailing", () => {
    const doubleStop = parse([
      START(SID),
      FINISH("stop", "prt_f1"),
      TOOL("shell", { command: "git status" }),
      FINISH("stop", "prt_f2"),
    ]).events;
    // The tool call comes before prt_f2 (the final stop), so it is not trailing and the run succeeds.
    expect(adapter().extractResult(doubleStop, EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: SID,
    });

    // A tool call after the second stop is trailing and fails the run.
    const trailingAfterSecond = parse([
      START(SID),
      FINISH("stop", "prt_f1"),
      FINISH("stop", "prt_f2"),
      TOOL("shell", { command: "git status" }),
    ]).events;
    expect(adapter().extractResult(trailingAfterSecond, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the final stop step",
    });
  });

  it("duplicate JSON keys resolve to the last one (JSON.parse), so a leading type cannot forge or hide a stop", () => {
    // Leading stop hidden by trailing text:
    const { events: hiddenEvents } = parseRaw([
      `{"type":"step_finish","part":{"type":"step-finish","reason":"stop"},"sessionID":"${SID}","type":"text","part":{"type":"text","text":"hidden stop"}}`,
    ]);
    expect(hiddenEvents).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
      { kind: "message", role: "assistant", text: "hidden stop" },
    ]);
    expect(adapter().extractResult(hiddenEvents, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
    });

    // Leading text overridden by trailing step_finish stop:
    const { events: realEvents } = parseRaw([
      `{"type":"text","part":{"type":"text","text":"hello"},"type":"step_finish","sessionID":"${SID}","part":{"type":"step-finish","reason":"stop"}}`,
    ]);
    expect(adapter().extractResult(realEvents, EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: SID,
    });

    // Duplicate reason where last is cancelled:
    const { events: forgedEvents } = parseRaw([
      `{"type":"step_finish","sessionID":"${SID}","part":{"type":"step-finish","reason":"stop","reason":"cancelled"}}`,
    ]);
    expect(adapter().extractResult(forgedEvents, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
    });
  });

  it("line types match exactly: a case or whitespace variant is unknown, never a result or tool call", () => {
    const variants = [
      "Step_finish",
      "STEP_FINISH",
      " step_finish",
      "step_finish ",
      "step-finish",
      "stepFinish",
      "tool_call",
      "Tool_use",
      "TOOL_USE",
      "Text",
      "TEXT",
      "Step_start",
      "Error",
    ];
    const { events, state } = parse(
      variants.map((type) => ({
        type,
        part: { type: "step-finish", reason: "stop" },
      })),
    );
    expect(events).toEqual(variants.map((rawType) => ({ kind: "unknown", rawType })));
    expect(state).toEqual({ lines: variants.length, unknownEvents: variants.length });
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
    });
  });

  it("an empty text part emits no message and counts nothing unknown; a non-string text part is unknown", () => {
    const { events, state } = parse([START(SID), TEXT(""), FINISH("stop")]);
    expect(events.filter((e) => e.kind === "message")).toEqual([]);
    expect(state.unknownEvents).toBe(0);
    expect(adapter().extractResult(events, EXIT_OK)).toEqual({
      ok: true,
      unknownEventCount: 0,
      nativeSessionId: SID,
    });

    // A non-string text part counts as unknown and fails the turn.
    for (const badText of [null, 7, ["hello"], { text: "nested" }]) {
      const bad = parse([
        START(SID),
        { type: "text", sessionID: SID, part: { type: "text", text: badText } },
        FINISH("stop"),
      ]);
      expect(
        bad.events.find((e) => e.kind === "unknown"),
        JSON.stringify(badText),
      ).toEqual({
        kind: "unknown",
        rawType: "text",
      });
      expect(adapter().extractResult(bad.events, EXIT_OK), JSON.stringify(badText)).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
      });
    }
  });

  it("a byte-order mark before a line is unparseable framing: counted as a line, emitting nothing, never unknown", () => {
    const { events, state } = parseRaw([`\uFEFF${line(FINISH("stop"))}`]);
    expect(events).toEqual([]);
    expect(state).toEqual({ lines: 1, unknownEvents: 0 });
    // Without a readable stop, the supervisor ends the run OUTPUT_PROTOCOL_ERROR.
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
    });
  });

  it("token metrics read from part.tokens only: root tokens dropped, non-negative fractions kept, nested cache read", () => {
    // Root tokens and root cost are dropped:
    const rootOnly = parse([
      {
        type: "step_finish",
        sessionID: SID,
        tokens: { input: 10, output: 5 },
        cost: 0.05,
        part: { type: "step-finish", reason: "stop" },
      },
    ]).events;
    expect(rootOnly.filter((e) => e.kind === "usage")).toEqual([]);

    // Fractional tokens and nested cache read:
    const valid = parse([
      {
        type: "step_finish",
        sessionID: SID,
        part: {
          type: "step-finish",
          reason: "stop",
          cost: 0.0025,
          tokens: {
            input: 2.5,
            output: 1.0,
            reasoning: 0,
            cache: { read: 5.5, write: 0 },
          },
        },
      },
    ]).events;
    expect(valid.filter((e) => e.kind === "usage")).toEqual([
      {
        kind: "usage",
        source: "provider_reported",
        metrics: {
          input: 2.5,
          output: 1.0,
          reasoning: 0,
          cache_read: 5.5,
          cache_write: 0,
          cost_usd: 0.0025,
        },
      },
    ]);

    // Negative, non-finite, and non-object cache dropped:
    const invalid = parse([
      {
        type: "step_finish",
        sessionID: SID,
        part: {
          type: "step-finish",
          reason: "stop",
          cost: -0.01,
          tokens: {
            input: -5,
            output: "10" as unknown as number,
            reasoning: Number.NaN,
            cache: 5 as unknown as object,
          },
        },
      },
    ]).events;
    expect(invalid.filter((e) => e.kind === "usage")).toEqual([]);
  });

  it("summary takes the last 2,000 characters of joined text across messages", () => {
    const msg1 = "a".repeat(1_000);
    const msg2 = "b".repeat(1_000);
    const msg3 = "c".repeat(1_000);
    const { events } = parse([TEXT(msg1), TEXT(msg2), TEXT(msg3), FINISH("stop")]);
    const res = adapter().extractResult(events, EXIT_OK);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected success");
    const fullText = `${msg1}\n${msg2}\n${msg3}`;
    expect(res.summary).toHaveLength(2_000);
    expect(res.summary).toBe(fullText.slice(-2_000));
    expect(res.summary?.endsWith(msg3)).toBe(true);
  });

  it("error payload variants: string, numeric, boolean, array, and null/omitted", () => {
    // String error:
    const strErr = parse([START(SID), { type: "error", error: "server crashed" }, FINISH("stop")]).events;
    expect(strErr.find((e) => e.kind === "provider_error")).toEqual({
      kind: "provider_error",
      category: "unknown",
      message: "error: server crashed",
    });

    // Numeric / boolean / array error: JSON.stringify formatted:
    for (const val of [502, false, ["e1", "e2"]]) {
      const valErr = parse([START(SID), { type: "error", error: val }, FINISH("stop")]).events;
      expect(
        valErr.find((e) => e.kind === "provider_error"),
        JSON.stringify(val),
      ).toEqual({
        kind: "provider_error",
        category: "unknown",
        message: JSON.stringify(val),
      });
    }

    // Null or omitted error payload is unknown:
    for (const empty of [undefined, null]) {
      const emptyErr = parse([START(SID), { type: "error", error: empty }, FINISH("stop")]);
      expect(
        emptyErr.events.find((e) => e.kind === "unknown"),
        String(empty),
      ).toEqual({
        kind: "unknown",
        rawType: "error",
      });
    }

    // Known error categories:
    const quota = parse([START(SID), ERROR("provider.quota"), FINISH("stop")]).events;
    expect(quota.find((e) => e.kind === "provider_error")).toEqual({
      kind: "provider_error",
      category: "quota",
      message: "provider.quota: synthetic",
    });
  });
});

describe("opencode parser residuals, seventh pass: custom command boundaries, resume backing mismatches and late finishes (T4.53; synthetic lines; parser unchanged)", () => {
  it("custom tools require a string input.command: empty strings are retained, alternate keys and non-strings are dropped", () => {
    for (const command of ["", "printf synthetic", "git push origin main"]) {
      const { events } = parse([START(SID), TOOL("mcp__terminal__run", { command }), FINISH("stop")]);
      expect(
        events.find((e) => e.kind === "tool_call"),
        command,
      ).toEqual({
        kind: "tool_call",
        tool: "shell",
        name: "mcp__terminal__run",
        command,
      });
      expect(
        adapter().extractResult(
          events.map((e) => guardEvent(e, { cwd: "/work/tree", bypass: true })),
          EXIT_OK,
        ),
      ).toMatchObject(command.startsWith("git") ? { ok: false, failureCode: "PERMISSION_BLOCKED" } : { ok: true });
    }
    for (const input of [
      { command: ["git", "push"] },
      { command: { command: "git push" } },
      { command: null },
      { command: false },
      { command: 7 },
      { cmd: "git push" },
      { commands: ["git push"] },
    ]) {
      const lines = [START(SID), TOOL("mcp__terminal__run", input), FINISH("stop")];
      expect(
        parse(lines).events.find((e) => e.kind === "tool_call"),
        line(input),
      ).toEqual({
        kind: "tool_call",
        tool: "other",
        name: "mcp__terminal__run",
      });
      // Gap: these synthetic command shapes never reach the guard as commands.
      expect(adapter().extractResult(guarded(lines), EXIT_OK), line(input)).toMatchObject({ ok: true });
    }
  });

  it("custom command extraction ignores tool status and output: pending and failed calls still reach the Git guard", () => {
    for (const status of ["pending", "running", "error", "completed", undefined]) {
      const call = {
        type: "tool_use",
        part: {
          tool: "custom_exec",
          state: { status, input: { command: "git push origin main" }, output: "not executed" },
        },
      };
      expect(parse([call]).events).toEqual([
        { kind: "tool_call", tool: "shell", name: "custom_exec", command: "git push origin main" },
      ]);
      expect(
        adapter().extractResult(guarded([START(SID), call, FINISH("stop")]), EXIT_OK),
        String(status),
      ).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: SID });
    }
  });

  it("custom names remain other without a command, including prototype names and a shell prefix", () => {
    for (const name of ["constructor", "__proto__", `bash${"x".repeat(70)}`]) {
      const { events } = parse([TOOL(name, { command: "printf synthetic" })]);
      expect(events).toEqual([
        {
          kind: "tool_call",
          tool: "shell",
          name: name.length > 64 ? `${name.slice(0, 64)}…` : name,
          command: "printf synthetic",
        },
      ]);
      expect(parse([TOOL(name, {})]).events).toEqual([
        {
          kind: "tool_call",
          tool: "other",
          name: name.length > 64 ? `${name.slice(0, 64)}…` : name,
        },
      ]);
    }
  });

  it("pins the resume gap: another id and backing vendor on the first line succeed; the requested id returning later fails", () => {
    const req: CompileRequest = {
      runId: "run_opencode_t453_seventh",
      objective: "resume synthetic",
      constraints: [],
      workspace: { cwd: "/work/tree", writable: true },
      bypassApproved: true,
    };
    const binding = {
      provider: "opencode",
      nativeSessionId: SID,
      backingProvider: "old-vendor",
      model: "old-model",
    } as const;
    const invocation = adapter().resumeArgs(binding, req, PRIVILEGED_BYPASS_PROFILE);
    if ("ineligible" in invocation) throw new Error(invocation.detail);
    expect(invocation.argv.slice(-4)).toEqual(["--session", SID, "--", req.objective]);
    expect(invocation.argv).not.toContain("old-vendor");
    expect(invocation.argv).not.toContain("old-model");
    const first = { ...START(OTHER), backing_provider: "new-vendor", model: "new-model" };
    const mismatch = parse([first, FINISH("stop", "prt_other", OTHER)]);
    expect(mismatch.events.filter((e) => e.kind === "session_bound")).toEqual([
      { kind: "session_bound", nativeSessionId: OTHER, backingProvider: "new-vendor", model: "new-model" },
    ]);
    expect(adapter().extractResult(mismatch.events, EXIT_OK)).toEqual({
      ok: true,
      nativeSessionId: OTHER,
      unknownEventCount: 0,
    });
    const returned = parse([first, FINISH("stop", "prt_requested", SID)]);
    expect(returned.events.filter((e) => e.kind === "session_bound")).toEqual(
      mismatch.events.filter((e) => e.kind === "session_bound"),
    );
    expect(adapter().extractResult(returned.events, EXIT_OK)).toMatchObject({
      ok: false,
      nativeSessionId: OTHER,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "protocol: session id changed mid-run",
    });
  });

  it("pins the gap: a non-stop finish after stop records usage but never revokes that stop, even with an unknown reason", () => {
    for (const reason of ["tool-calls", "length", "", "STOP"]) {
      const { events } = parse([START(SID), FINISH("stop", "prt_stop"), FINISH(reason, "prt_late")]);
      expect(events.filter((e) => e.kind === "result")).toEqual([{ kind: "result", ok: true }]);
      expect(events.filter((e) => e.kind === "usage")).toHaveLength(2);
      expect(adapter().extractResult(events, EXIT_OK), reason).toEqual({
        ok: true,
        nativeSessionId: SID,
        unknownEventCount: 0,
      });
      // A non-stop finish also cannot repair a trailing tool: only a later stop resets the trailing boundary.
      const withTool = [START(SID), FINISH("stop"), TOOL("read", { path: "late.txt" }), FINISH(reason)];
      expect(adapter().extractResult(parse(withTool).events, EXIT_OK), reason).toMatchObject({
        ok: false,
        failureCode: "OUTPUT_PROTOCOL_ERROR",
        failureDetail: "tool call after the final stop step",
      });
    }
  });

  it("late errors survive a later stop and fresh usage; stream order still chooses the first error", () => {
    for (const [first, second, code] of [
      ["provider.auth", "provider.quota", "AUTH_REQUIRED"],
      ["provider.quota", "provider.auth", "QUOTA_EXHAUSTED"],
    ] as const) {
      const { events } = parse([
        START(SID),
        FINISH("stop", "prt_initial"),
        ERROR(first),
        FINISH("tool-calls", "prt_intermediate"),
        ERROR(second),
        FINISH("stop", "prt_final"),
      ]);
      expect(events.filter((e) => e.kind === "result")).toHaveLength(2);
      expect(events.filter((e) => e.kind === "usage")).toHaveLength(3);
      expect(events.at(-1)).toEqual({ kind: "result", ok: true });
      expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
        ok: false,
        failureCode: code,
        nativeSessionId: SID,
      });
    }
  });
});

describe("opencode parser residuals, eighth pass: late binding, vendor parity, resume argv boundaries and trailing events (T4.53, T4.6; synthetic lines; parser unchanged)", () => {
  const request = (cwd = makeCwd()): CompileRequest => ({
    runId: "run_opencode_t453_eighth",
    objective: "synthetic opencode objective",
    constraints: [],
    workspace: { cwd, writable: true },
    bypassApproved: true,
  });
  // `sessionID: undefined` is dropped by JSON.stringify, so the line carries no id (FINISH and ERROR default to SID).
  const noId = <T extends object>(o: T) => ({ ...o, sessionID: undefined });
  const bound = (events: NormalizedEvent[]) => events.filter((e) => e.kind === "session_bound");

  it("a first id on a trailing tool_use binds there with its vendor; the run still fails on the trailing tool", () => {
    const { events } = parse([
      START(),
      TEXT("done"),
      noId(FINISH("stop", "prt_stop")),
      { ...TOOL("read", { filePath: "late.txt" }, SID), backing_provider: "late-vendor", model: "late-model" },
    ]);
    expect(events.slice(-2)).toEqual([
      { kind: "session_bound", nativeSessionId: SID, backingProvider: "late-vendor", model: "late-model" },
      { kind: "tool_call", tool: "read", name: "read", target: "late.txt" },
    ]);
    expect(adapter().extractResult(events, EXIT_OK)).toEqual({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "tool call after the final stop step",
      nativeSessionId: SID,
      unknownEventCount: 0,
      summary: "done",
    });
  });

  it("a first id reported after the stop on a text line or a non-stop finish binds late and the run succeeds", () => {
    for (const late of [TEXT("after", SID), FINISH("tool-calls", "prt_late", SID)]) {
      const { events } = parse([START(), TEXT("before"), noId(FINISH("stop", "prt_stop")), late]);
      expect(bound(events), late.type).toEqual([{ kind: "session_bound", nativeSessionId: SID }]);
      expect(events.findIndex((e) => e.kind === "session_bound")).toBeGreaterThan(
        events.findIndex((e) => e.kind === "result"),
      );
      expect(adapter().extractResult(events, EXIT_OK), late.type).toMatchObject({ ok: true, nativeSessionId: SID });
    }
  });

  it("a first id on an error line after the stop binds, and the run fails with that error's code keeping the id", () => {
    const { events } = parse([START(), noId(FINISH("stop", "prt_stop")), ERROR("provider.quota", SID)]);
    expect(events.slice(-2)).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
      { kind: "provider_error", category: "quota", message: "provider.quota: synthetic" },
    ]);
    expect(adapter().extractResult(events, EXIT_OK)).toMatchObject({
      ok: false,
      failureCode: "QUOTA_EXHAUSTED",
      nativeSessionId: SID,
    });
  });

  it("a stream that never reports an id succeeds unbound, and extractResult reads only the first session_bound it is given", () => {
    const unbound = parse([START(), TEXT("ok"), noId(FINISH("stop"))]).events;
    expect(bound(unbound)).toEqual([]);
    expect(adapter().extractResult(unbound, EXIT_OK)).toEqual({ ok: true, unknownEventCount: 0, summary: "ok" });
    // The parser never emits two bindings; a hand-built list with two shows extractResult keeps the first.
    const twice: NormalizedEvent[] = [
      { kind: "session_bound", nativeSessionId: SID },
      { kind: "session_bound", nativeSessionId: OTHER, backingProvider: "other" },
      { kind: "result", ok: true },
    ];
    expect(adapter().extractResult(twice, EXIT_OK)).toEqual({ ok: true, nativeSessionId: SID, unknownEventCount: 0 });
  });

  it("fixture late_session_bound replays to success, binding the id, vendor and model first reported on the stop line", async () => {
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("late_session_bound"),
      request: request(),
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toEqual({
      ok: true,
      nativeSessionId: DEFAULT_SESSION_ID,
      unknownEventCount: 0,
      summary: "SYNTHETIC: late",
    });
    const lines = readFileSync(fixturePath("late_session_bound"), "utf8").trim().split("\n").slice(1);
    const a = adapter();
    const state: ParseState = { lines: 0, unknownEvents: 0 };
    const events = lines.flatMap((l) => a.parseEvent(l, state));
    expect(bound(events)).toEqual([
      {
        kind: "session_bound",
        nativeSessionId: DEFAULT_SESSION_ID,
        backingProvider: "backing-late-bind",
        model: "Late Bind Model",
      },
    ]);
    expect(events.filter((e) => e.kind === "usage")).toHaveLength(2);
  });

  it("vendor spelling parity: each of the four spellings, and model at root or in the part, binds the same event", () => {
    const want = { kind: "session_bound", nativeSessionId: SID, backingProvider: "vendor-x", model: "model-y" };
    const variants: [string, object][] = [
      ["root snake", { ...START(SID), backing_provider: "vendor-x", model: "model-y" }],
      ["root camel", { ...START(SID), backingProvider: "vendor-x", model: "model-y" }],
      ["part snake", { ...START(SID), part: { type: "step-start", backing_provider: "vendor-x", model: "model-y" } }],
      ["part camel", { ...START(SID), part: { type: "step-start", backingProvider: "vendor-x", model: "model-y" } }],
    ];
    for (const [label, first] of variants) {
      const { events, state } = parse([first, FINISH("stop")]);
      expect(bound(events), label).toEqual([want]);
      expect(state.unknownEvents, label).toBe(0);
    }
  });

  it("vendor and model are independent: either alone binds alone, and an empty string binds neither", () => {
    expect(bound(parse([{ ...START(SID), backing_provider: "only-vendor" }]).events)).toEqual([
      { kind: "session_bound", nativeSessionId: SID, backingProvider: "only-vendor" },
    ]);
    expect(bound(parse([{ ...START(SID), model: "only-model" }]).events)).toEqual([
      { kind: "session_bound", nativeSessionId: SID, model: "only-model" },
    ]);
    expect(bound(parse([{ ...START(SID), backing_provider: "", model: "" }]).events)).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
    ]);
  });

  it("pins the gap: an empty-string root vendor or model shadows the part's value, while a null root falls through", () => {
    const part = { type: "step-start", backing_provider: "part-vendor", model: "part-model" };
    expect(bound(parse([{ ...START(SID), backing_provider: "", model: "", part }]).events)).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
    ]);
    expect(bound(parse([{ ...START(SID), backing_provider: null, model: null, part }]).events)).toEqual([
      { kind: "session_bound", nativeSessionId: SID, backingProvider: "part-vendor", model: "part-model" },
    ]);
  });

  it("vendor and model past 128 characters are clipped to 128 plus an ellipsis; the session id is never clipped", () => {
    const long = "v".repeat(129);
    const id = `s${"0".repeat(255)}`;
    expect(bound(parse([{ ...START(id), backing_provider: long, model: long }]).events)).toEqual([
      {
        kind: "session_bound",
        nativeSessionId: id,
        backingProvider: `${"v".repeat(128)}…`,
        model: `${"v".repeat(128)}…`,
      },
    ]);
  });

  it("the run result never carries a backing vendor or model, whatever session_bound reported", () => {
    const { events } = parse([{ ...START(SID), backing_provider: "vendor-x", model: "model-y" }, FINISH("stop")]);
    const ok = adapter().extractResult(events, EXIT_OK);
    expect(Object.keys(ok).sort()).toEqual(["nativeSessionId", "ok", "unknownEventCount"]);
    const failed = adapter().extractResult(events, EXIT_1);
    expect(Object.keys(failed).sort()).toEqual([
      "failureCode",
      "failureDetail",
      "nativeSessionId",
      "ok",
      "unknownEventCount",
    ]);
  });

  it("resume argv boundaries: `--session <id>` sits between `--standalone` and `--` exactly once, whatever the objective", () => {
    const a = new OpenCodeAdapter({
      executable: "/opt/synthetic/node",
      launcherArgs: ["replay.mjs", "--session", "x"],
    });
    for (const objective of ["", "--", "--session", `--session ${OTHER}`, "-s", "\n"]) {
      const req = { ...request("/work/tree"), objective };
      const inv = a.resumeArgs({ provider: "opencode", nativeSessionId: SID }, req, PRIVILEGED_BYPASS_PROFILE);
      if ("ineligible" in inv) throw new Error(inv.detail);
      expect(inv.argv, JSON.stringify(objective)).toEqual([
        "/opt/synthetic/node",
        "replay.mjs",
        "--session",
        "x",
        "run",
        "--format",
        "json",
        "--standalone",
        "--session",
        SID,
        "--",
        objective,
      ]);
      // Launcher words come first and are the replay's own; the run's options run from `run` to the final `--`.
      const run = inv.argv.indexOf("run");
      expect(
        inv.argv.slice(run, -2).filter((w) => w === "--session"),
        JSON.stringify(objective),
      ).toHaveLength(1);
      expect(inv.policyFlags).toEqual(["--standalone"]);
    }
  });

  it("resume id boundaries: 256 characters pass verbatim, 257 or a non-alphanumeric first character are refused", () => {
    const resume = (nativeSessionId: string) =>
      adapter().resumeArgs({ provider: "opencode", nativeSessionId }, request("/work/tree"), PRIVILEGED_BYPASS_PROFILE);
    for (const id of ["s", `s${"0".repeat(255)}`, "ses_a.b:c-d", "0"]) {
      const inv = resume(id);
      if ("ineligible" in inv) throw new Error(`${id}: ${inv.detail}`);
      expect(inv.argv.slice(-3, -2), id).toEqual([id]);
    }
    for (const id of [`s${"0".repeat(256)}`, "-s", "_ses", ".ses", ":ses", "--", "", "ses id", "ses\n"]) {
      expect(resume(id), JSON.stringify(id)).toEqual({
        ineligible: true,
        reason: "CAPABILITY_MISSING",
        detail: "native session id is not a safe single argument",
      });
    }
    expect(
      adapter().resumeArgs(
        // A persisted binding with a case-variant provider name (not a ProviderName) is another provider.
        { provider: "OpenCode", nativeSessionId: SID } as unknown as NativeBinding,
        request("/work/tree"),
        PRIVILEGED_BYPASS_PROFILE,
      ),
    ).toEqual({ ineligible: true, reason: "CAPABILITY_MISSING", detail: "binding is for OpenCode" });
  });

  it("pins the gap: a step_start after the last stop opens a step that never finishes, and the run still succeeds", () => {
    const { events, state } = parse([START(SID), TEXT("done"), FINISH("stop"), START(SID)]);
    expect(state.unknownEvents).toBe(0);
    expect(adapter().extractResult(events, EXIT_OK)).toEqual({
      ok: true,
      nativeSessionId: SID,
      unknownEventCount: 0,
      summary: "done",
    });
  });

  it("fixture trailing_step_start replays the open trailing step to success (gap)", async () => {
    const report = await runConformanceCase({
      kind: "success",
      adapter: replayAdapter("trailing_step_start"),
      request: request(),
      profile: PRIVILEGED_BYPASS_PROFILE,
      expect: { ok: true, nativeSessionId: DEFAULT_SESSION_ID },
    });
    expect(report.checks.filter((k) => !k.ok)).toEqual([]);
    expect(report.result).toEqual({
      ok: true,
      nativeSessionId: DEFAULT_SESSION_ID,
      unknownEventCount: 0,
      summary: "SYNTHETIC: done",
    });
  });

  it("fail closed after the last stop: an unknown line, a changed id, an unsafe id or a malformed step_start each fail", () => {
    const cases: [label: string, trailing: object, code: string, detail: string][] = [
      [
        "unknown type",
        { type: "session.idle", sessionID: SID },
        "OUTPUT_PROTOCOL_ERROR",
        "1 unreadable event(s) in the stream",
      ],
      [
        "step_start of another part type",
        { type: "step_start", sessionID: SID, part: { type: "text" } },
        "OUTPUT_PROTOCOL_ERROR",
        "1 unreadable event(s) in the stream",
      ],
      ["changed id", TEXT("late", OTHER), "OUTPUT_PROTOCOL_ERROR", "protocol: session id changed mid-run"],
      ["unsafe id", TEXT("late", "-bad"), "OUTPUT_PROTOCOL_ERROR", "protocol: session id is not a safe argument"],
    ];
    for (const [label, trailing, code, detail] of cases) {
      const { events } = parse([START(SID), FINISH("stop"), trailing]);
      expect(adapter().extractResult(events, EXIT_OK), label).toMatchObject({
        ok: false,
        failureCode: code,
        failureDetail: detail,
        nativeSessionId: SID,
      });
    }
  });

  it("a guarded Git write after the last stop reports the guard's code, not the trailing-tool detail", () => {
    const events = guarded([START(SID), FINISH("stop"), TOOL("shell", { command: "git push origin main" }, SID)]);
    const r = adapter().extractResult(events, EXIT_OK);
    expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", nativeSessionId: SID });
    if (r.ok) throw new Error("unreachable");
    expect(r.failureDetail).toMatch(/^git write attempted: /);
  });

  it("a clean stopped stream never succeeds on a non-exited outcome, and keeps its id on every one", () => {
    const { events } = parse([START(SID), TEXT("done"), FINISH("stop")]);
    const outcomes: [outcome: ExitInfo["outcome"], code: string][] = [
      ["timeout", "PROCESS_TIMEOUT"],
      ["cancelled", "CANCELLED"],
      ["crashed", "PROCESS_CRASH"],
      ["spawn_error", "PROCESS_CRASH"],
      ["protocol_error", "OUTPUT_PROTOCOL_ERROR"],
      ["internal_error", "OUTPUT_PROTOCOL_ERROR"],
    ];
    for (const [outcome, code] of outcomes) {
      expect(adapter().extractResult(events, { ...EXIT_OK, outcome, exitCode: null }), outcome).toMatchObject({
        ok: false,
        failureCode: code,
        nativeSessionId: SID,
        summary: "done",
      });
    }
  });
});
