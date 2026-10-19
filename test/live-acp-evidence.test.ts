/**
 * Kimi Code live evidence helpers (T4.68; owner ruling relayed 2026-10-19 02:42 CT, ROADMAP §4.2 decision 74):
 * `K-P1`, the `session/request_permission` round trip (fail closed), and `K-F1`, the deliberately failed turn and the
 * CLI's exit code (`scripts/live/acp-evidence.mjs`). Fake streams and ledger rows only; no provider CLI is involved.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { KimiAdapter } from "../src/adapters/kimi/adapter.js";
import { startAdapterRun } from "../src/adapters/run.js";
import { isIneligible } from "../src/adapters/types.js";
import { type PrivilegedScope, privilegedScopeHash, resolveTrustProfile } from "../src/policy/index.js";
import { compileCell } from "./live-cells.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ev = await import(pathToFileURL(path.join(ROOT, "scripts", "live", "acp-evidence.mjs")).href);
const kimi = (await import(pathToFileURL(path.join(ROOT, "scripts", "live", "providers", "kimi.mjs")).href)).default;

const rpc = (o: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", ...o });
/** One agent permission request; `toolCall` fields as ACP v1 names them unless overridden. */
const ask = (
  id: number,
  toolCall: Record<string, unknown> = {
    toolCallId: `t${id}`,
    title: "WriteFile",
    kind: "edit",
    rawInput: { path: "SECRET-PATH" },
  },
) =>
  rpc({
    id,
    method: "session/request_permission",
    params: {
      sessionId: "s1",
      toolCall,
      options: [
        { optionId: "a", kind: "allow_once", name: "Allow" },
        { optionId: "r", kind: "reject_once", name: "Reject" },
      ],
    },
  });
const update = rpc({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "tool_call" } } });
const answer = (option_kind: string | null) => ({
  type: "acp_permission",
  payload_json: JSON.stringify({
    tool_kind: "edit",
    decision: option_kind ?? "cancel_turn",
    option_kind,
    location_count: 0,
  }),
});
const transition = { type: "state_transition", payload_json: JSON.stringify({ to: "RUNNING" }) };

describe("K-P1 permission round trip (fail closed)", () => {
  it("HELD only with a request per tool call, each with a name and arguments, answered allow_once or reject_once", () => {
    const stream = [update, ask(7), ask(8), rpc({ id: 3, result: { stopReason: "end_turn" } })].join("\n");
    const v = ev.permissionRoundTrip({
      ran: true,
      stream,
      runEvents: [transition, answer("allow_once"), answer("reject_once")],
    });
    expect(v.result).toBe("HELD");
    expect(v.record).toEqual({
      requests: 2,
      tool_call_updates: 1,
      tool_call_fields: ["kind", "rawInput", "title", "toolCallId"],
      with_name: 2,
      with_arguments: 2,
      answers: 2,
      option_kinds: ["allow_once", "reject_once"],
    });
    // Field names only: no argument value reaches the evidence line or the record.
    expect(v.evidence).not.toContain("SECRET-PATH");
    expect(JSON.stringify(v.record)).not.toContain("SECRET-PATH");
  });

  it("FAILS when the default mode raised no permission request, even for a run that edited", () => {
    const v = ev.permissionRoundTrip({ ran: true, stream: [update, update].join("\n"), runEvents: [transition] });
    expect(v.result).toBe("FAILED");
    expect(v.evidence).toContain("did not ask (fail closed)");
    expect(v.record.requests).toBe(0);
    expect(v.evidence).toContain("2 tool_call update(s)");
    expect(v.record.tool_call_updates).toBe(2);
    // An empty stream of a run that ran is the same: never passes; the evidence says no tool call was reached.
    const empty = ev.permissionRoundTrip({ ran: true, stream: "", runEvents: [] });
    expect(empty.result).toBe("FAILED");
    expect(empty.evidence).toContain("never reached a tool call");
    expect(empty.record.tool_call_updates).toBe(0);
  });

  it("FAILS a request without the tool name or the arguments", () => {
    const noArgs = ev.permissionRoundTrip({
      ran: true,
      stream: ask(1, { toolCallId: "t1", title: "Shell", kind: "execute" }),
      runEvents: [answer("reject_once")],
    });
    expect(noArgs.result).toBe("FAILED");
    expect(noArgs.evidence).toContain("lacks the tool name or arguments");
    const noName = ev.permissionRoundTrip({
      ran: true,
      stream: ask(1, { toolCallId: "t1", kind: "execute", rawInput: {} }),
      runEvents: [answer("reject_once")],
    });
    expect(noName.result).toBe("FAILED");
    const noToolCall = ev.permissionRoundTrip({
      ran: true,
      stream: rpc({ id: 1, method: "session/request_permission", params: { sessionId: "s1" } }),
      runEvents: [answer("reject_once")],
    });
    expect(noToolCall.result).toBe("FAILED");
  });

  it("FAILS a request the controller did not answer, and an answer that selected no allow_once/reject_once option", () => {
    expect(ev.permissionRoundTrip({ ran: true, stream: ask(1), runEvents: [] }).result).toBe("FAILED");
    const cancelled = ev.permissionRoundTrip({ ran: true, stream: ask(1), runEvents: [answer(null)] });
    expect(cancelled.result).toBe("FAILED");
    expect(cancelled.record.option_kinds).toEqual(["cancelled"]);
    expect(ev.permissionRoundTrip({ ran: true, stream: ask(1), runEvents: [answer("allow_always")] }).result).toBe(
      "FAILED",
    );
  });

  it("is NOT_CHECKED (never HELD) when the provider never ran", () => {
    expect(ev.permissionRoundTrip({ ran: false, stream: ask(1), runEvents: [answer("allow_once")] })).toMatchObject({
      result: "NOT_CHECKED",
      record: { requests: 0, answers: 0 },
    });
  });

  it("ignores the controller's own messages, responses and non-JSON lines", () => {
    const stream = [
      "not json",
      rpc({ id: 1, result: { protocolVersion: 1 } }),
      rpc({ method: "session/request_permission", params: {} }), // a notification, not a request
      ask(2),
    ].join("\n");
    expect(ev.permissionRequests(stream)).toHaveLength(1);
  });
});

describe("K-F1 forced failed turn", () => {
  it("HELD only for a failed turn the CLI ended with a non-zero exit code; the record keeps the CLI's code", () => {
    const v = ev.failedTurnVerdict({
      spawned: true,
      exitCode: 2,
      signal: null,
      turnFailed: true,
      failureCode: "TOOL_FAILURE",
    });
    expect(v.result).toBe("HELD");
    expect(v.record).toEqual({ cli_exit_code: 2, cli_signal: null, turn_failed: true, failure_code: "TOOL_FAILURE" });
  });

  it("FAILS exit code 0 on a failed turn", () => {
    const v = ev.failedTurnVerdict({ spawned: true, exitCode: 0, signal: null, turnFailed: true });
    expect(v.result).toBe("FAILED");
    expect(v.record.cli_exit_code).toBe(0);
  });

  it("FAILS a turn that did not fail and a CLI that ended by a signal", () => {
    expect(ev.failedTurnVerdict({ spawned: true, exitCode: 0, signal: null, turnFailed: false }).evidence).toContain(
      "no failure was forced",
    );
    expect(ev.failedTurnVerdict({ spawned: true, exitCode: 3, signal: null, turnFailed: false }).result).toBe("FAILED");
    const killed = ev.failedTurnVerdict({ spawned: true, exitCode: null, signal: "SIGKILL", turnFailed: true });
    expect(killed.result).toBe("FAILED");
    expect(killed.record).toMatchObject({ cli_exit_code: null, cli_signal: "SIGKILL" });
  });

  it("is NOT_CHECKED when no CLI process ran", () => {
    expect(ev.failedTurnVerdict({ spawned: false, reason: "binary not found" })).toEqual({
      result: "NOT_CHECKED",
      evidence: "binary not found",
      record: { cli_exit_code: null, cli_signal: null, turn_failed: null, failure_code: null },
    });
  });

  it("forces a session id that is one safe argv word with the fixed prefix", () => {
    const id = ev.forcedSessionId("0123456789abcdef");
    expect(id).toBe("sb-forced-fail-0123456789abcdef");
    expect(() => ev.forcedSessionId("--yolo")).toThrow();
  });
});

describe("the Kimi plug-in wires the evidence (T4.68)", () => {
  it("asks for K-P1, K-F1 and evidence retention", () => {
    expect(kimi.permissionRecord).toBe(true);
    expect(kimi.keepEvidence).toBe(true);
    expect(kimi.failedTurn.bypassFlag).toBe("--prompt");
    expect(kimi.failedTurn.scope.bypass).toBe(true);
    // K-P1 rides on the ACP smoke cell and the ACP malicious checks only.
    expect(kimi.smokeCell.scope.bypass).toBe(false);
    expect(
      kimi.malicious.checks
        .filter((c: { scope: { bypass: boolean } }) => !c.scope.bypass)
        .map((c: { id: string }) => c.id),
    ).toEqual(["K-M1", "K-M2"]);
  });

  it("the forced failed turn compiles as a `--prompt` resume with the forced `--session` id and only `--prompt` bypass-class", () => {
    const id = ev.forcedSessionId("00112233aabbccdd");
    const { result, bypassFlags } = compileCell("kimi", kimi.failedTurn.scope, id);
    if ("reason" in result) throw new Error(`${result.reason}: ${result.detail}`);
    expect(result.transport).toBe("subprocess-jsonl");
    expect(bypassFlags).toEqual(["--prompt"]);
    const at = result.argv.indexOf("--session");
    expect(at).toBeGreaterThan(0);
    expect(result.argv[at + 1]).toBe(id);
    expect(result.expectedExitCodes).toEqual([0]);
  });
});

describe("K-F1 through the real run path with a fake `kimi` (no provider CLI)", () => {
  /** A fake CLI that prints one non-record line and exits `code`, as a CLI refusing an unknown session might. */
  const fakeKimi = (code: number) => {
    const dir = mkdtempSync(path.join(tmpdir(), "switchboard-fake-kimi-"));
    const exe = path.join(dir, "kimi");
    writeFileSync(exe, `#!/bin/sh\necho 'session not found' >&2\nexit ${code}\n`);
    chmodSync(exe, 0o755);
    return { dir, exe };
  };
  const scope = kimi.failedTurn.scope as PrivilegedScope;
  const profile = resolveTrustProfile("privileged", {
    privileged: {
      scope,
      scopeHash: privilegedScopeHash({ clientId: "live-smoke", metaSessionId: "live-smoke-failed-turn", scope }),
      approvalId: "apv_0000000000000000000000TEST",
    },
  });
  const turn = async (code: number) => {
    const { dir, exe } = fakeKimi(code);
    try {
      const adapter = new KimiAdapter({ executable: exe });
      const inv = adapter.resumeArgs(
        { provider: "kimi", nativeSessionId: ev.forcedSessionId("0123456789abcdef") },
        {
          runId: "run_smoke_failed_turn",
          objective: "Reply with the single word ok.",
          constraints: [],
          workspace: { cwd: dir, writable: true },
          bypassApproved: true,
        },
        profile,
      );
      if (isIneligible(inv)) throw new Error(inv.detail);
      const outcome = await startAdapterRun(adapter, inv, { profile, bypassApproved: true }).done;
      return ev.failedTurnVerdict({
        spawned: outcome.exit.outcome !== "spawn_error",
        exitCode: outcome.exit.exitCode,
        signal: outcome.exit.signal,
        turnFailed: outcome.result.ok !== true,
        failureCode: outcome.result.failureCode,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("records the CLI's non-zero exit code as HELD", async () => {
    const v = await turn(3);
    expect(v.record.cli_exit_code).toBe(3);
    expect(v.record.turn_failed).toBe(true);
    expect(v.result).toBe("HELD");
  });

  it("FAILS a failed turn that the CLI ended with exit code 0", async () => {
    const v = await turn(0);
    expect(v.record).toMatchObject({ cli_exit_code: 0, turn_failed: true });
    expect(v.result).toBe("FAILED");
  });
});
