/**
 * T4.68 (2026-10-19, Delegated agent work, not owner-approved; Linus ruling 2026-10-19 05:22 CDT item 2): the Kimi Code
 * ACP stream that ended the w1408 live smoke run `OUTPUT_PROTOCOL_ERROR` (0 `session_bound`, 0 `result`, 1 unknown
 * record, no tool calls). The kept provider stdout held two records (`fixtures/captured_acp_session_start.jsonl`,
 * redacted: session id zeroed, home path replaced): the `initialize` result, then a `session/update`
 * `available_commands_update` for the new session, sent BEFORE the `session/new` reply. The client took that update as
 * one "for another session" (no session id was bound yet) and failed the run before any prompt was sent.
 *
 * These cases play the captured records through the fake ACP agent in place of `kimi acp`, through the Kimi adapter's
 * own ACP plan, the real supervisor and the shared client. No `kimi` binary, network or credential is used.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ACP_UNREQUESTED_TOOL_CALL } from "../../exec/acp/client.js";
import { FAKE_ACP_AGENT_PATH } from "../fake/adapter.js";
import { privilegedProfile } from "../fixtures/privileged.js";
import { startAdapterRun } from "../run.js";
import { type Invocation, isIneligible, type NormalizedEvent } from "../types.js";
import { KIMI_NO_PERMISSION_REQUESTS, KimiAdapter } from "./adapter.js";
import { fixturePath } from "./fixtures/cases.js";
import { deferredAcpInvocation } from "./fixtures/deferred-acp.js";

const root = mkdtempSync(path.join(tmpdir(), "sb-kimi-acp-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

type Step = Record<string, unknown>;

/** The live smoke's ACP cell (`scripts/live/providers/kimi.mjs`): worktree files, shell `none`, no bypass. */
const ACP_SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "none" },
  network: { mode: "on" },
  repository_config: { mode: "enabled" },
  bypass: false,
} as const;

const CAPTURED = readFileSync(fixturePath("captured_acp_session_start"), "utf8").split("\n").filter(Boolean);
const [INIT_LINE, EARLY_UPDATE_LINE] = CAPTURED as [string, string];
const SID = (JSON.parse(EARLY_UPDATE_LINE) as { params: { sessionId: string } }).params.sessionId;
const INIT_RESULT = (JSON.parse(INIT_LINE) as { result: unknown }).result;

/** The captured start: `initialize` answered as recorded, then the update before the `session/new` reply. */
const capturedStart = (sessionId = SID): Step[] => [
  { recv: "initialize", reply: { result: INIT_RESULT } },
  { recv: "session/new" },
  { raw: `${EARLY_UPDATE_LINE}\n` },
  { reply_to: "session/new", result: { sessionId, modes: { currentModeId: "default" } } },
];
const update = (u: Record<string, unknown>): Step => ({
  send: { method: "session/update", params: { sessionId: SID, update: u } },
});
const END: Step = { reply_to: "session/prompt", result: { stopReason: "end_turn" } };
const OPTIONS = [
  { optionId: "approve", name: "Approve once", kind: "allow_once" },
  { optionId: "approve_for_session", name: "Approve for this session", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

async function run(steps: (wt: string) => Step[]) {
  n += 1;
  const dir = path.join(root, `case-${n}`);
  const wt = path.join(dir, "wt");
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, "README.md"), "hi");
  const fixture = path.join(dir, "fixture.json");
  const record = path.join(dir, "record.jsonl");
  writeFileSync(fixture, JSON.stringify({ steps: steps(wt) }));
  const adapter = new KimiAdapter({ executable: "/opt/synthetic/kimi" });
  const profile = privilegedProfile(ACP_SCOPE);
  const inv: Invocation = deferredAcpInvocation({ cwd: wt });
  inv.argv = [process.execPath, FAKE_ACP_AGENT_PATH, "--fixture", fixture, "--record", record];
  inv.envAllowlist = ["PATH"];
  const out = await startAdapterRun(adapter, inv, {
    profile,
    bypassApproved: false,
    acp: { snapshot: { profile, worktree: wt, writable: true, readOnlyContexts: [] } },
  }).done;
  const received = readFileSync(record, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      const r = JSON.parse(l) as { recv?: Record<string, unknown> };
      return r.recv ? [r.recv] : [];
    });
  return { out, wt, received };
}

const kinds = (events: readonly NormalizedEvent[]) => events.map((e) => e.kind);

describe("kimi ACP: the approval scope is refused since the bypass-only gate", () => {
  it("compile of the ACP scope is Ineligible PROFILE_UNSUPPORTED: Kimi has no permission requests", () => {
    const adapter = new KimiAdapter({ executable: "/opt/synthetic/kimi" });
    const compiled = adapter.compile(
      { runId: "run_gate", objective: "x", constraints: [], workspace: { cwd: root, writable: true } },
      privilegedProfile(ACP_SCOPE),
    );
    expect(isIneligible(compiled)).toBe(true);
    if (isIneligible(compiled)) {
      expect(compiled.reason).toBe("PROFILE_UNSUPPORTED");
      expect(compiled.detail).toContain("Kimi has no permission requests");
      expect(compiled.detail).toContain(KIMI_NO_PERMISSION_REQUESTS);
    }
  });
});

describe("kimi ACP: the captured session start (w1408 live smoke, CLI 2.1.1; redacted, replayed offline)", () => {
  it("the fixture is the two recorded records: initialize result, then available_commands_update for the session", () => {
    expect(CAPTURED).toHaveLength(2);
    expect(JSON.parse(INIT_LINE)).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
    expect(JSON.parse(EARLY_UPDATE_LINE)).toMatchObject({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: SID, update: { sessionUpdate: "available_commands_update" } },
    });
    expect(Object.hasOwn(JSON.parse(EARLY_UPDATE_LINE) as object, "id")).toBe(false); // a notification
  });

  it("an update before the session/new reply no longer breaks the run: bound, prompted, permission asked, SUCCEEDED", async () => {
    const { out, received } = await run((wt) => [
      ...capturedStart(),
      { recv: "session/prompt" },
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "WriteFile", kind: "edit", status: "pending" }),
      {
        send: {
          id: 0,
          method: "session/request_permission",
          params: {
            sessionId: SID,
            toolCall: {
              toolCallId: "t1",
              title: "WriteFile",
              kind: "edit",
              rawInput: { path: "SMOKE.md" },
              locations: [{ path: path.join(wt, "SMOKE.md") }],
            },
            options: OPTIONS,
          },
        },
      },
      { recv_response: 0 },
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }),
      update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "done" } }),
      END,
    ]);
    expect(out.result.failureCode).toBeUndefined();
    expect(out.result.ok).toBe(true);
    expect(out.result.nativeSessionId).toBe(SID);
    // session_bound comes first; the held update follows it (still `unknown`, ADR-0036 item 8.2), then the turn.
    expect(kinds(out.events)).toEqual(["session_bound", "unknown", "tool_call", "tool_call", "message", "result"]);
    expect(out.events[1]).toEqual({ kind: "unknown", rawType: "available_commands_update" });
    const answer = received.find((m) => m.id === 0 && !("method" in m));
    expect(answer).toEqual({
      jsonrpc: "2.0",
      id: 0,
      result: { outcome: { outcome: "selected", optionId: "approve" } },
    });
    expect(received.map((m) => m.method).filter(Boolean)).toEqual(["initialize", "session/new", "session/prompt"]);
  });

  it("K-P1 fail closed: a tool call that runs without a permission request ends PERMISSION_BLOCKED, never SUCCEEDED", async () => {
    const { out, received } = await run(() => [
      ...capturedStart(),
      { recv: "session/prompt" },
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "WriteFile", kind: "edit", status: "pending" }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }),
      { recv: "session/cancel" },
      { reply_to: "session/prompt", result: { stopReason: "cancelled" } },
    ]);
    expect(out.result.ok).toBe(false);
    expect(out.result.failureCode).toBe("PERMISSION_BLOCKED");
    // The tool calls stay visible (the live check needs to see that a tool call happened without a request).
    expect(out.events.filter((e) => e.kind === "tool_call")).toHaveLength(2);
    expect(out.events).toContainEqual({ kind: "permission_denied", tool: ACP_UNREQUESTED_TOOL_CALL });
    expect(received.some((m) => m.method === "session/cancel")).toBe(true);
  });

  it("a tool call that starts already in_progress, with no request, is blocked as well", async () => {
    const { out } = await run(() => [
      ...capturedStart(),
      { recv: "session/prompt" },
      update({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Shell", kind: "execute", status: "in_progress" }),
      { recv: "session/cancel" },
      { reply_to: "session/prompt", result: { stopReason: "cancelled" } },
    ]);
    expect(out.result.failureCode).toBe("PERMISSION_BLOCKED");
  });

  it("a held update for a session other than the one session/new returns is still OUTPUT_PROTOCOL_ERROR", async () => {
    const { out, received } = await run(() => [
      ...capturedStart("session_00000000-0000-0000-0000-000000000999"),
      { hang: true },
    ]);
    expect(out.exit.outcome).toBe("protocol_error");
    expect(out.result.failureCode).toBe("OUTPUT_PROTOCOL_ERROR");
    expect(out.events.some((e) => e.kind === "result")).toBe(false);
    expect(received.some((m) => m.method === "session/prompt")).toBe(false);
  });
});
