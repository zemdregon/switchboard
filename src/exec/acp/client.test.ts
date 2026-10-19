/**
 * `acp-stdio` transport against the scripted fake ACP agent (T4.8; ADR-0036 "Conformance plan"; FR-EXE-03, FR-EXE-01,
 * 02, 05, 07, NFR-REL-02). Runs through the real supervisor, the shared client and `startAdapterRun`, with the fake
 * adapter's `acp-stdio` mode. No provider CLI is installed or called.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AcpPlanAuditError } from "../../adapters/audit.js";
import { FakeAdapter } from "../../adapters/fake/adapter.js";
import { type AdapterRunOptions, startAdapterRun } from "../../adapters/run.js";
import {
  type CompileRequest,
  type Invocation,
  isIneligible,
  type NormalizedEvent,
  type ResolvedProfile,
} from "../../adapters/types.js";
import { resolveProfile } from "../../policy/profiles.js";
import type { PrivilegedScope } from "../../policy/types.js";
import { groupAlive } from "../supervisor.js";
import { ACP_MAX_EARLY_UPDATES, ACP_UNREQUESTED_TOOL_CALL, type AcpRunEvent } from "./client.js";

const root = mkdtempSync(path.join(tmpdir(), "sb-acp-client-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

type Step = Record<string, unknown>;
const SID = "sess-1";

const INIT = (result: Record<string, unknown> = {}): Step => ({
  recv: "initialize",
  reply: {
    result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, embeddedContext: true } },
      authMethods: [{ id: "fake-login", name: "Fake login", description: "do not record me", type: "terminal" }],
      ...result,
    },
  },
});
const NEW: Step = { recv: "session/new", reply: { result: { sessionId: SID } } };
const PROMPT: Step = { recv: "session/prompt" };
const update = (u: Record<string, unknown>, sessionId = SID): Step => ({
  send: { method: "session/update", params: { sessionId, update: u } },
});
const END = (stopReason = "end_turn"): Step => ({ reply_to: "session/prompt", result: { stopReason } });
const OPTIONS = [
  { optionId: "aa", name: "Always allow", kind: "allow_always" },
  { optionId: "a1", name: "Allow", kind: "allow_once" },
  { optionId: "ra", name: "Never", kind: "reject_always" },
  { optionId: "r1", name: "Reject", kind: "reject_once" },
];
const permission = (id: number, toolCall: Record<string, unknown>, options: unknown[] = OPTIONS): Step => ({
  send: { id, method: "session/request_permission", params: { sessionId: SID, toolCall, options } },
});

const SCOPE: PrivilegedScope = {
  files: { access: "worktree" },
  shell: { mode: "none" },
  network: { mode: "off" },
  repository_config: { mode: "disabled" },
  bypass: true,
};
const privileged = (bypassApproved: boolean): ResolvedProfile => ({
  name: "privileged",
  fileAccess: "scoped",
  shell: "scoped",
  network: "scoped",
  repoConfig: "scoped",
  bypassApproved,
  privilegedScope: { scope: SCOPE, scopeHash: "a".repeat(64), approvalId: "apv_1" },
});

interface Case {
  /** The fixture steps, or a function of the case's worktree path. */
  steps: Step[] | ((wt: string) => Step[]);
  ignoreTerm?: boolean;
  profile?: ResolvedProfile;
  bypassApproved?: boolean;
  resume?: string;
  acp?: Partial<NonNullable<AdapterRunOptions["acp"]>>;
  fake?: { modeId?: string; mcpServers?: Array<{ name: string; command: string; args: string[]; env: [] }> };
  tweak?: (inv: Invocation) => Invocation;
  timeouts?: Partial<Invocation["timeouts"]>;
  onEvent?: (e: NormalizedEvent) => void;
  baseEnv?: Record<string, string>;
}

function setup(c: Case) {
  n += 1;
  const dir = path.join(root, `case-${n}`);
  const wt = path.join(dir, "wt");
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, "README.md"), "hi");
  const fixture = path.join(dir, "fixture.json");
  const record = path.join(dir, "record.jsonl");
  const steps = typeof c.steps === "function" ? c.steps(wt) : c.steps;
  writeFileSync(fixture, JSON.stringify({ steps, ignoreTerm: c.ignoreTerm === true }));
  const adapter = new FakeAdapter({
    acp: { fixture, record, ...(c.fake ?? {}) },
    timeouts: { wallClockMs: 20_000, idleMs: 20_000, killGraceMs: 300, ...c.timeouts },
  });
  const profile = c.profile ?? resolveProfile("edit-untrusted");
  const request: CompileRequest = {
    runId: `run_${n}`,
    objective: "please do the task",
    constraints: [],
    workspace: { cwd: wt, writable: true },
  };
  const compiled =
    c.resume !== undefined
      ? adapter.resumeArgs({ provider: "fake", nativeSessionId: c.resume }, request, profile)
      : adapter.compile(request, profile);
  if (isIneligible(compiled)) throw new Error(compiled.detail);
  const inv = c.tweak ? c.tweak(compiled) : compiled;
  const runEvents: AcpRunEvent[] = [];
  const opts: AdapterRunOptions = {
    profile,
    bypassApproved: c.bypassApproved ?? false,
    ...(c.baseEnv ? { baseEnv: c.baseEnv } : {}),
    ...(c.onEvent ? { onEvent: c.onEvent } : {}),
    acp: {
      snapshot: { profile, worktree: wt, writable: true, readOnlyContexts: [] },
      onRunEvent: (e) => runEvents.push(e),
      ...c.acp,
    },
  };
  const recorded = () =>
    readFileSync(record, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { env?: string[]; recv?: Record<string, unknown> });
  const received = () => recorded().flatMap((r) => (r.recv ? [r.recv] : []));
  return { adapter, inv, opts, wt, runEvents, recorded, received };
}

async function run(c: Case) {
  const s = setup(c);
  const agent = startAdapterRun(s.adapter, s.inv, s.opts);
  const out = await agent.done;
  return { ...s, out, agent };
}

const kinds = (events: readonly NormalizedEvent[]) => events.map((e) => e.kind);
const responseTo = (msgs: Record<string, unknown>[], id: number) => msgs.find((m) => m.id === id && !("method" in m));

describe("acp-stdio: session start and streamed updates", () => {
  it("handshake, session/new, prompt and updates map to NormalizedEvents in order", async () => {
    const { out, received, recorded, runEvents, wt } = await run({
      steps: [
        INIT(),
        NEW,
        PROMPT,
        update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Hel" } }),
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private reasoning" } }),
        update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "lo" } }),
        update({
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Read README",
          kind: "read",
          status: "pending",
          locations: [{ path: "/abs/README.md" }],
        }),
        update({ sessionUpdate: "usage_update", used: 10, size: 1000, cost: { amount: 0.01, currency: "USD" } }),
        update({ sessionUpdate: "plan", entries: [] }),
        update({ sessionUpdate: "brand_new_variant" }),
        END(),
      ],
    });
    expect(out.result.ok).toBe(true);
    expect(out.result.nativeSessionId).toBe(SID);
    expect(kinds(out.events)).toEqual([
      "session_bound",
      "message",
      "tool_call",
      "usage",
      "unknown",
      "unknown",
      "result",
    ]);
    expect(out.events[1]).toEqual({ kind: "message", role: "assistant", text: "Hello" });
    expect(out.events[2]).toMatchObject({ tool: "read", name: "Read README", target: "/abs/README.md" });
    expect(out.events[3]).toMatchObject({ metrics: { used: 10, size: 1000, cost_amount: 0.01, cost_currency: "USD" } });
    expect(out.events.slice(4, 6)).toEqual([
      { kind: "unknown", rawType: "plan" },
      { kind: "unknown", rawType: "brand_new_variant" },
    ]);
    expect(JSON.stringify(out.events)).not.toContain("private reasoning"); // NFR-PRIV-02
    expect(out.stdout.toString()).toContain("private reasoning"); // kept in the raw artifact only
    expect(out.exit.outcome).toBe("exited");
    expect(out.groupEmpty).toBe(true);

    const msgs = received();
    const init = msgs.find((m) => m.method === "initialize") as { params: Record<string, unknown> };
    expect(init.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "switchboard", version: expect.any(String) },
    });
    expect(msgs.find((m) => m.method === "session/new")?.params).toEqual({ cwd: wt, mcpServers: [] });
    expect(msgs.find((m) => m.method === "session/prompt")?.params).toEqual({
      sessionId: SID,
      prompt: [{ type: "text", text: "please do the task" }],
    });
    expect(msgs.filter((m) => m.method === "session/prompt")).toHaveLength(1);
    expect(msgs.some((m) => m.method === "authenticate" || m.method === "logout")).toBe(false);
    // FR-EXE-07: only allowlisted names reach the agent (node itself may not add any; macOS adds `__CF_USER_TEXT_ENCODING` to every process, T4.10).
    expect(recorded()[0]?.env?.filter((k) => k !== "PATH" && k !== "__CF_USER_TEXT_ENCODING")).toEqual([]);
    // FR-EXE-05: stderr captured, never parsed as protocol.
    expect(out.stderr.toString()).toContain("fake-acp-agent: started");
    expect(out.stdin?.toString()).toContain('"method":"initialize"');
    expect(runEvents).toEqual([
      {
        type: "acp_initialized",
        payload: {
          protocol_version: 1,
          agent_capabilities: { loadSession: false, promptCapabilities: { image: false, embeddedContext: true } },
          auth_methods: [{ id: "fake-login", type: "terminal" }],
        },
      },
    ]);
  });

  it("only allowlisted environment names reach the agent", async () => {
    const { recorded } = await run({
      steps: [INIT(), NEW, PROMPT, END()],
      baseEnv: { PATH: process.env.PATH ?? "/usr/bin", SECRET_TOKEN: "x", HOME: "/root" },
    });
    expect(recorded()[0]?.env?.filter((k) => k !== "__CF_USER_TEXT_ENCODING")).toEqual(["PATH"]);
  });
});

describe("acp-stdio: updates before the session/new reply (T4.68, Kimi Code CLI 2.1.1 live smoke 2026-10-19)", () => {
  const HELD_NEW: Step[] = [{ recv: "session/new" }];
  const replyNew = (sessionId = SID): Step => ({ reply_to: "session/new", result: { sessionId } });
  const commands = (sessionId = SID) =>
    update({ sessionUpdate: "available_commands_update", availableCommands: [] }, sessionId);

  it("are held and handled in order after session_bound, checked against the returned id", async () => {
    const { out } = await run({
      steps: [INIT(), ...HELD_NEW, commands(), commands(), replyNew(), PROMPT, END()],
    });
    expect(out.result.ok).toBe(true);
    expect(out.events).toEqual([
      { kind: "session_bound", nativeSessionId: SID },
      { kind: "unknown", rawType: "available_commands_update" },
      { kind: "unknown", rawType: "available_commands_update" },
      { kind: "result", ok: true },
    ]);
  });

  it("a held update for another session, or more than the bound, is OUTPUT_PROTOCOL_ERROR before any prompt", async () => {
    const other = await run({
      steps: [INIT(), ...HELD_NEW, commands("other-session"), replyNew(), { hang: true }],
    });
    expect(other.out.result.failureCode).toBe("OUTPUT_PROTOCOL_ERROR");
    expect(other.received().some((m) => m.method === "session/prompt")).toBe(false);
    const flood = Array.from({ length: ACP_MAX_EARLY_UPDATES + 1 }, () => commands());
    const many = await run({ steps: [INIT(), ...HELD_NEW, ...flood, { hang: true }] });
    expect(many.out.result.failureCode).toBe("OUTPUT_PROTOCOL_ERROR");
    expect(many.out.groupEmpty).toBe(true);
  });

  it("an update before session/new was sent is still OUTPUT_PROTOCOL_ERROR", async () => {
    const { out } = await run({ steps: [commands(), { hang: true }] });
    expect(out.result.failureCode).toBe("OUTPUT_PROTOCOL_ERROR");
  });
});

describe("acp-stdio: requirePermissionRequest (ADR-0049 item 3, fail closed)", () => {
  const require = (inv: Invocation): Invocation => ({
    ...inv,
    acp: { ...(inv.acp as NonNullable<Invocation["acp"]>), requirePermissionRequest: true },
  });
  const ranUnasked: Step[] = [
    INIT(),
    NEW,
    PROMPT,
    update({ sessionUpdate: "tool_call", toolCallId: "t1", kind: "read", status: "pending" }),
    update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }),
    END(),
  ];

  it("a tool call that ran with no request naming it ends PERMISSION_BLOCKED; without the flag nothing changes", async () => {
    const blocked = await run({ steps: ranUnasked, tweak: require });
    expect(blocked.out.result.failureCode).toBe("PERMISSION_BLOCKED");
    expect(blocked.out.events).toContainEqual({ kind: "permission_denied", tool: ACP_UNREQUESTED_TOOL_CALL });
    const unflagged = await run({ steps: ranUnasked });
    expect(unflagged.out.result.ok).toBe(true);
  });

  it("a tool call that was asked for and allowed runs on; an approved bypass run is not restricted", async () => {
    const asked = await run({
      steps: (wt) => [
        INIT(),
        NEW,
        PROMPT,
        update({ sessionUpdate: "tool_call", toolCallId: "t1", kind: "edit", status: "pending" }),
        permission(5, { toolCallId: "t1", kind: "edit", locations: [{ path: path.join(wt, "README.md") }] }),
        { recv_response: 5 },
        update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }),
        END(),
      ],
      tweak: require,
    });
    expect(asked.out.result.ok).toBe(true);
    const bypass = await run({ profile: privileged(true), bypassApproved: true, steps: ranUnasked, tweak: require });
    expect(bypass.out.result.ok).toBe(true);
  });
});

describe("acp-stdio: initialize, version and errors", () => {
  it("a protocol version 2 answer is OUTPUT_PROTOCOL_ERROR", async () => {
    const { out } = await run({ steps: [INIT({ protocolVersion: 2 }), { hang: true }] });
    expect(out.result.failureCode).toBe("OUTPUT_PROTOCOL_ERROR");
    expect(out.groupEmpty).toBe(true);
  });

  it("no answer to initialize is PROCESS_TIMEOUT", async () => {
    const { out } = await run({ steps: [{ recv: "initialize" }, { hang: true }], acp: { initializeTimeoutMs: 300 } });
    expect(out.result.failureCode).toBe("PROCESS_TIMEOUT");
    expect(out.exit.timeoutKind).toBe("acp_initialize");
    expect(out.groupEmpty).toBe(true);
  });

  it("no answer to session/new is PROCESS_TIMEOUT", async () => {
    const { out } = await run({
      steps: [INIT(), { recv: "session/new" }, { hang: true }],
      acp: { sessionTimeoutMs: 300 },
    });
    expect(out.result.failureCode).toBe("PROCESS_TIMEOUT");
    expect(out.exit.timeoutKind).toBe("acp_session");
  });

  it.each([
    ["max_tokens", "TOOL_FAILURE"],
    ["max_turn_requests", "TOOL_FAILURE"],
    ["refusal", "TOOL_FAILURE"],
    ["cancelled", "TOOL_FAILURE"], // not requested by the controller
  ])("stop reason %s gives %s", async (stopReason, code) => {
    const { out } = await run({ steps: [INIT(), NEW, PROMPT, END(stopReason)] });
    expect(out.result.ok).toBe(false);
    expect(out.result.failureCode).toBe(code);
    expect(out.events.at(-1)).toEqual({ kind: "result", ok: false, summary: `stop reason: ${stopReason}` });
  });

  it("an error response to the prompt is provider_error with the code as category", async () => {
    const { out } = await run({
      steps: [INIT(), NEW, PROMPT, { reply_to: "session/prompt", error: { code: -32603, message: "boom" } }],
    });
    expect(out.events.at(-1)).toEqual({ kind: "provider_error", category: "-32603", message: "boom" });
    expect(out.result.failureCode).toBe("TOOL_FAILURE");
  });

  it("-32000 on any request is AUTH_REQUIRED naming the native login; no authenticate or logout is sent", async () => {
    const { out, received } = await run({
      steps: [INIT(), { recv: "session/new", reply: { error: { code: -32000, message: "auth_required" } } }],
    });
    expect(out.result.failureCode).toBe("AUTH_REQUIRED");
    expect(out.result.failureDetail).toContain("fake-acp login");
    const methods = received().map((m) => m.method);
    expect(methods).not.toContain("authenticate");
    expect(methods).not.toContain("logout");
    expect(methods).not.toContain("session/prompt");
  });

  it("an exit before the result is PROCESS_CRASH", async () => {
    const { out } = await run({ steps: [INIT(), NEW, PROMPT, { exit: 0 }] });
    expect(out.exit.outcome).toBe("crashed");
    expect(out.result.failureCode).toBe("PROCESS_CRASH");
  });
});

describe("acp-stdio: cancel and timeouts end the process group", () => {
  it("cancel answers the pending permission request cancelled, sends session/cancel, and kills the group", async () => {
    let signalDecision: () => void = () => {};
    const decided = new Promise<void>((r) => {
      signalDecision = r;
    });
    const s = setup({
      ignoreTerm: true, // only SIGKILL ends it, and it never answers session/cancel
      steps: [INIT(), NEW, PROMPT, permission(50, { toolCallId: "t1", kind: "read" }), { hang: true }],
      acp: {
        permissionDecisionMs: 60_000,
        decide: () => {
          signalDecision();
          return new Promise(() => {});
        },
      },
    });
    let pgid: number | undefined;
    const agent = startAdapterRun(s.adapter, s.inv, {
      ...s.opts,
      onSpawn: ({ pgid: g }) => {
        pgid = g;
      },
    });
    await decided;
    await agent.cancel();
    const out = await agent.done;
    expect(out.exit.outcome).toBe("cancelled");
    expect(out.result.failureCode).toBe("CANCELLED");
    expect(out.groupEmpty).toBe(true);
    expect(pgid !== undefined && groupAlive(pgid)).toBe(false);
    const msgs = s.received();
    expect(responseTo(msgs, 50)).toMatchObject({ result: { outcome: { outcome: "cancelled" } } });
    expect(msgs.some((m) => m.method === "session/cancel")).toBe(true);
    expect(s.runEvents.find((e) => e.type === "acp_permission")?.payload).toMatchObject({
      decision: "cancel_turn",
      reason: "run_cancelling",
    });
  });

  it("a cooperative agent answers cancelled within the grace; the run is CANCELLED", async () => {
    let bound: () => void = () => {};
    const ready = new Promise<void>((r) => {
      bound = r;
    });
    const s = setup({
      steps: [INIT(), NEW, PROMPT, { recv: "session/cancel" }, END("cancelled")],
      timeouts: { killGraceMs: 5_000 },
      onEvent: (e) => {
        if (e.kind === "session_bound") bound();
      },
    });
    const agent = startAdapterRun(s.adapter, s.inv, s.opts);
    await ready;
    await new Promise((r) => setTimeout(r, 100)); // let the prompt reach the agent
    const t0 = Date.now();
    await agent.cancel();
    const out = await agent.done;
    expect(out.result.failureCode).toBe("CANCELLED");
    expect(out.events.at(-1)).toMatchObject({ kind: "result", ok: false });
    expect(Date.now() - t0).toBeLessThan(4_000); // did not wait out the 5 s grace
  });

  it("a wall-clock timeout sends session/cancel and ends PROCESS_TIMEOUT with the group gone", async () => {
    const { out, received } = await run({
      ignoreTerm: true,
      steps: [INIT(), NEW, PROMPT, { hang: true }],
      timeouts: { wallClockMs: 800 },
    });
    expect(out.result.failureCode).toBe("PROCESS_TIMEOUT");
    expect(out.exit.timeoutKind).toBe("wall_clock");
    expect(out.groupEmpty).toBe(true);
    expect(received().some((m) => m.method === "session/cancel")).toBe(true);
  });
});

describe("acp-stdio: malformed or oversize messages give OUTPUT_PROTOCOL_ERROR", () => {
  const wrong = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } };
  it.each<[string, Step[], Partial<Case>?]>([
    ["oversize line (over 1 MiB)", [{ raw: `{"jsonrpc":"2.0","method":"x","params":"${"a".repeat(1024 * 1024)}"}\n` }]],
    ["invalid JSON", [{ raw: "this is not json\n" }]],
    ["invalid UTF-8", [{ rawBase64: Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]).toString("base64") }]],
    ["a blank line", [{ raw: "\n" }]],
    ["a batch array", [{ raw: '[{"jsonrpc":"2.0","method":"session/update"}]\n' }]],
    ["jsonrpc 1.0", [{ raw: '{"jsonrpc":"1.0","method":"session/update"}\n' }]],
    ["a response to an unknown id", [{ send: { id: 999, result: {} } }]],
    ["an update for another session", [update(wrong, "other-session")]],
    [
      "a permission request for another session",
      [{ send: { id: 3, method: "session/request_permission", params: { sessionId: "nope", options: [] } } }],
    ],
  ])("%s", async (_name, steps) => {
    const { out } = await run({ steps: [INIT(), NEW, PROMPT, ...steps, { hang: true }] });
    expect(out.exit.outcome).toBe("protocol_error");
    expect(out.result.failureCode).toBe("OUTPUT_PROTOCOL_ERROR");
    expect(out.groupEmpty).toBe(true);
  });

  it("more than 8 unanswered agent requests", async () => {
    const reqs = Array.from({ length: 9 }, (_v, i) => permission(100 + i, { toolCallId: `t${i}`, kind: "read" }));
    const { out } = await run({
      steps: [INIT(), NEW, PROMPT, ...reqs, { hang: true }],
      acp: { decide: () => new Promise(() => {}), permissionDecisionMs: 30_000 },
    });
    expect(out.result.failureCode).toBe("OUTPUT_PROTOCOL_ERROR");
    expect(out.groupEmpty).toBe(true);
  });
});

describe("acp-stdio: permission answers (ADR-0036 item 9)", () => {
  it("a request outside the profile is denied with reject_once; the tool call is denied; PERMISSION_BLOCKED", async () => {
    const { out, received, runEvents } = await run({
      profile: resolveProfile("inspect-untrusted"),
      steps: [
        INIT(),
        NEW,
        PROMPT,
        permission(7, { toolCallId: "t9", kind: "edit", locations: [{ path: "/anywhere/file.txt" }] }),
        { recv_response: 7 },
        update({ sessionUpdate: "tool_call_update", toolCallId: "t9", kind: "edit", status: "failed" }),
        END(),
      ],
    });
    expect(responseTo(received(), 7)).toMatchObject({ result: { outcome: { outcome: "selected", optionId: "r1" } } });
    expect(out.events.find((e) => e.kind === "tool_call")).toMatchObject({ tool: "edit", denied: true });
    expect(out.events.some((e) => e.kind === "permission_denied")).toBe(true);
    expect(out.result.failureCode).toBe("PERMISSION_BLOCKED");
    expect(runEvents.find((e) => e.type === "acp_permission")?.payload).toEqual({
      tool_kind: "edit",
      decision: "reject_once",
      reason: "kind_not_in_profile",
      option_kind: "reject_once",
      location_count: 1,
    });
  });

  it("a request inside the profile gets allow_once, never allow_always (listed first)", async () => {
    const { out, received } = await run({
      steps: (wt) => [
        INIT(),
        NEW,
        PROMPT,
        permission(8, { toolCallId: "t1", kind: "edit", locations: [{ path: path.join(wt, "README.md") }] }),
        { recv_response: 8 },
        END(),
      ],
    });
    expect(responseTo(received(), 8)).toMatchObject({ result: { outcome: { outcome: "selected", optionId: "a1" } } });
    expect(out.result.ok).toBe(true);
  });

  it("allow_always is never selected even when it is the only allow option", async () => {
    const { out, received } = await run({
      steps: (wt) => [
        INIT(),
        NEW,
        PROMPT,
        permission(9, { toolCallId: "t1", kind: "edit", locations: [{ path: path.join(wt, "README.md") }] }, [
          OPTIONS[0],
          OPTIONS[3],
        ]),
        { recv_response: 9 },
        END(),
      ],
    });
    expect(responseTo(received(), 9)).toMatchObject({ result: { outcome: { outcome: "selected", optionId: "r1" } } });
    expect(out.result.failureCode).toBe("PERMISSION_BLOCKED");
  });

  it("no reject option: answer cancelled, send session/cancel, PERMISSION_BLOCKED", async () => {
    const { out, received } = await run({
      profile: resolveProfile("inspect-untrusted"),
      steps: [
        INIT(),
        NEW,
        PROMPT,
        permission(11, { toolCallId: "t1", kind: "execute" }, [OPTIONS[0], OPTIONS[1], OPTIONS[2]]),
        { recv: "session/cancel" },
        END("cancelled"),
      ],
    });
    const msgs = received();
    expect(responseTo(msgs, 11)).toMatchObject({ result: { outcome: { outcome: "cancelled" } } });
    expect(msgs.some((m) => m.method === "session/cancel")).toBe(true);
    expect(out.result.failureCode).toBe("PERMISSION_BLOCKED");
    expect(out.exit.outcome).toBe("exited");
  });

  it("the allow-everything answer is refused without bypassApproved and given (allow_once only) with it", async () => {
    const steps = [
      INIT(),
      NEW,
      PROMPT,
      permission(12, { toolCallId: "t1", kind: "execute", rawInput: { command: ["rm", "-rf", "x"] } }),
      { recv_response: 12 },
      END(),
    ];
    // Snapshot says approved, but the run's own carrier does not: both must agree.
    const half = await run({ profile: privileged(true), bypassApproved: false, steps });
    expect(responseTo(half.received(), 12)).toMatchObject({ result: { outcome: { optionId: "r1" } } });
    const none = await run({ profile: privileged(false), bypassApproved: false, steps });
    expect(responseTo(none.received(), 12)).toMatchObject({ result: { outcome: { optionId: "r1" } } });
    const full = await run({ profile: privileged(true), bypassApproved: true, steps });
    expect(responseTo(full.received(), 12)).toMatchObject({ result: { outcome: { optionId: "a1" } } });
    expect(full.out.result.ok).toBe(true);
    expect(full.runEvents.find((e) => e.type === "acp_permission")?.payload).toMatchObject({
      decision: "allow_once",
      reason: "approved_bypass",
    });
  });

  it("a decision not returned within the 1 s bound is a rejection", async () => {
    const t0 = Date.now();
    const { out, received } = await run({
      steps: [INIT(), NEW, PROMPT, permission(13, { toolCallId: "t1", kind: "read" }), { recv_response: 13 }, END()],
      acp: { decide: () => new Promise(() => {}) }, // default bound: ACP_PERMISSION_DECISION_MS = 1000
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000);
    expect(responseTo(received(), 13)).toMatchObject({ result: { outcome: { optionId: "r1" } } });
    expect(out.result.failureCode).toBe("PERMISSION_BLOCKED");
  });

  it("a synchronous decision that overran the bound, or threw, is a rejection", async () => {
    let clock = 0;
    const slow = await run({
      steps: [INIT(), NEW, PROMPT, permission(14, { toolCallId: "t1", kind: "read" }), { recv_response: 14 }, END()],
      acp: {
        now: () => clock,
        decide: () => {
          clock += 2_000;
          return { answer: "allow_once", optionId: "a1", reason: "in_profile" };
        },
      },
    });
    expect(responseTo(slow.received(), 14)).toMatchObject({ result: { outcome: { optionId: "r1" } } });
    const threw = await run({
      steps: [INIT(), NEW, PROMPT, permission(15, { toolCallId: "t1", kind: "read" }), { recv_response: 15 }, END()],
      acp: {
        decide: () => {
          throw new Error("bug");
        },
      },
    });
    expect(responseTo(threw.received(), 15)).toMatchObject({ result: { outcome: { optionId: "r1" } } });
  });
});

describe("acp-stdio: refused client methods (ADR-0036 item 11)", () => {
  it("fs/*, terminal/*, _-prefixed and provider methods get -32601 at once; the run continues", async () => {
    const methods = ["fs/read_text_file", "terminal/create", "_x/anything", "cursor/ask_question"];
    const steps: Step[] = [INIT(), NEW, PROMPT];
    methods.forEach((method, i) => {
      steps.push({ send: { id: 200 + i, method, params: { sessionId: SID } } }, { recv_response: 200 + i });
    });
    steps.push(END());
    const { out, received, runEvents } = await run({ steps });
    const msgs = received();
    methods.forEach((_m, i) => {
      expect(responseTo(msgs, 200 + i)).toMatchObject({ error: { code: -32601 } });
    });
    expect(runEvents.filter((e) => e.type === "acp_request_refused").map((e) => e.payload.method)).toEqual(methods);
    expect(out.result.ok).toBe(true);
  });
});

describe("acp-stdio: resume (ADR-0036 item 7.2)", () => {
  it("prefers session/resume when advertised", async () => {
    const { out, received } = await run({
      resume: "old-1",
      steps: [
        INIT({ agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } }),
        { recv: "session/resume", reply: { result: {} } },
        PROMPT,
        {
          send: {
            method: "session/update",
            params: { sessionId: "old-1", update: { sessionUpdate: "usage_update", used: 1 } },
          },
        },
        END(),
      ],
    });
    const methods = received().map((m) => m.method);
    expect(methods).toContain("session/resume");
    expect(methods).not.toContain("session/load");
    expect(out.result.ok).toBe(true);
    expect(out.events[0]).toEqual({ kind: "session_bound", nativeSessionId: "old-1" });
  });

  it("session/load replay is counted, not re-emitted", async () => {
    const replay = (text: string) => ({
      send: {
        method: "session/update",
        params: {
          sessionId: "old-2",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      },
    });
    const { out, received } = await run({
      resume: "old-2",
      steps: [
        INIT({ agentCapabilities: { loadSession: true } }),
        { recv: "session/load" },
        replay("old history"),
        replay("more history"),
        { reply_to: "session/load", result: {} },
        PROMPT,
        END(),
      ],
    });
    expect(received().map((m) => m.method)).toContain("session/load");
    expect(JSON.stringify(out.events)).not.toContain("history");
    expect(kinds(out.events)).toEqual(["session_bound", "result"]);
  });

  it("neither advertised: TOOL_FAILURE acp_resume_unsupported before any prompt", async () => {
    const { out, received } = await run({ resume: "old-3", steps: [INIT()] });
    expect(out.result.failureCode).toBe("TOOL_FAILURE");
    expect(out.result.failureDetail).toContain("acp_resume_unsupported");
    expect(received().map((m) => m.method)).not.toContain("session/prompt");
  });
});

describe("acp-stdio: modes and the plan audit (ADR-0036 items 7.3 and 10)", () => {
  it("a current_mode_update to a declared bypass mode outside the bypass case is PERMISSION_BLOCKED", async () => {
    const { out, received } = await run({
      steps: [
        INIT(),
        NEW,
        PROMPT,
        update({ sessionUpdate: "current_mode_update", currentModeId: "fake-bypass-mode" }),
        { recv: "session/cancel" },
        END("cancelled"),
      ],
    });
    expect(out.events).toContainEqual({ kind: "permission_denied", tool: "acp_bypass_mode" });
    expect(out.result.failureCode).toBe("PERMISSION_BLOCKED");
    expect(received().some((m) => m.method === "session/cancel")).toBe(true);
  });

  it("a plan selecting a declared bypass mode is refused before spawn; a plain mode is sent", async () => {
    const s = setup({ steps: [], fake: { modeId: "fake-bypass-mode" } });
    expect(() => startAdapterRun(s.adapter, s.inv, s.opts)).toThrow(AcpPlanAuditError);
    const { out, received } = await run({
      fake: { modeId: "ask" },
      steps: [INIT(), NEW, { recv: "session/set_mode", reply: { result: {} } }, PROMPT, END()],
    });
    expect(received().find((m) => m.method === "session/set_mode")?.params).toEqual({ sessionId: SID, modeId: "ask" });
    expect(out.result.ok).toBe(true);
  });

  it("a plan with mcpServers, stdin text or no plan is refused before spawn", () => {
    const s = setup({ steps: [], fake: { mcpServers: [{ name: "x", command: "/bin/x", args: [], env: [] }] } });
    expect(() => startAdapterRun(s.adapter, s.inv, s.opts)).toThrow(/mcpServers/);
    const t = setup({ steps: [] });
    expect(() => startAdapterRun(t.adapter, { ...t.inv, stdin: { kind: "text", value: "x" } }, t.opts)).toThrow(
      AcpPlanAuditError,
    );
    const { acp: _drop, ...noPlan } = t.inv;
    expect(() => startAdapterRun(t.adapter, noPlan, t.opts)).toThrow(AcpPlanAuditError);
    const { acp: _snap, ...noSnapshot } = t.opts;
    expect(() => startAdapterRun(t.adapter, t.inv, noSnapshot)).toThrow(/permission snapshot/);
  });
});
