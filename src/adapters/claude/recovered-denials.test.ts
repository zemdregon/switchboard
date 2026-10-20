/**
 * ADR-0072 for Claude Code: the class of a `system/permission_denied` event comes from its `decision_reason_type`, and
 * a run whose only blocking evidence is recovered `mode` denials of `Bash` is a success with warnings. The replay of
 * `permission-denied-recovered.jsonl` (synthetic, in the shape of the operator's 2.1.294 streams) goes through
 * `startAdapterRun`, so the tool-call guard runs as in production; the real `claude` binary is never run.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replayLauncher } from "../fixtures/replay.js";
import { startAdapterRun } from "../run.js";
import { createParseState, isIneligible, type NormalizedEvent, type RunResult } from "../types.js";
import { ClaudeAdapter } from "./adapter.js";
import { EDIT_UNTRUSTED, fixturePath } from "./fixtures/cases.js";
import { claudeDenialClass, parseClaudeLine } from "./parse.js";

const FIXTURE = fixturePath("permission-denied-recovered.jsonl");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "sb-claude-denied-"));
  dirs.push(d);
  return d;
};

/** Replay `lines` (default: the fixture) through the real adapter and `startAdapterRun`. */
async function replay(o: { lines?: string[]; exitCode?: number } = {}): Promise<RunResult> {
  let file = FIXTURE;
  if (o.lines) {
    file = path.join(tmp(), "variant.jsonl");
    writeFileSync(file, `${o.lines.join("\n")}\n`);
  }
  const adapter = new ClaudeAdapter({
    binaryPath: process.execPath,
    launcherArgs: replayLauncher("claude", file, o.exitCode !== undefined ? ["--exit-code", String(o.exitCode)] : []),
    timeouts: { wallClockMs: 10_000, idleMs: 2_000, killGraceMs: 300 },
  });
  const inv = adapter.compile(
    { runId: "run_claude_denied", objective: "synthetic", constraints: [], workspace: { cwd: tmp(), writable: true } },
    EDIT_UNTRUSTED,
  );
  if (isIneligible(inv)) throw new Error(inv.detail);
  return (await startAdapterRun(adapter, inv, { profile: EDIT_UNTRUSTED }).done).result;
}

const fixtureLines = () =>
  readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((l) => l !== "");
/** The fixture with the second denial's `decision_reason_type` replaced (or removed when `undefined`). */
const withSecondReason = (reason: string | undefined, tool = "Bash") =>
  fixtureLines().map((l) => {
    const doc = JSON.parse(l) as Record<string, unknown>;
    if (doc.subtype !== "permission_denied" || doc.tool_use_id !== "toolu_recovered_2") return l;
    const { decision_reason_type: _r, ...rest } = doc;
    return JSON.stringify({
      ...rest,
      tool_name: tool,
      ...(reason !== undefined ? { decision_reason_type: reason } : {}),
    });
  });

describe("claudeDenialClass (ADR-0072 mapping)", () => {
  it("maps the reason types seen on 2.1.294 and leaves the rest unclassified", () => {
    expect(claudeDenialClass("Bash", "mode")).toBe("profile");
    expect(claudeDenialClass("Write", "mode")).toBeUndefined();
    expect(claudeDenialClass("Edit", "mode")).toBeUndefined();
    expect(claudeDenialClass("Bash", "rule")).toBe("git_write");
    expect(claudeDenialClass("Write", "other")).toBe("outside_worktree");
    expect(claudeDenialClass("Glob", "other")).toBe("outside_worktree");
    expect(claudeDenialClass("Bash", "subcommandResults")).toBeUndefined();
    expect(claudeDenialClass("Bash", undefined)).toBeUndefined();
    expect(claudeDenialClass("Bash", "a-future-reason")).toBeUndefined();
  });

  it("parses the fixture into classified denials, each reported once", () => {
    const state = createParseState();
    const events: NormalizedEvent[] = fixtureLines().flatMap((l) => parseClaudeLine(l, state));
    expect(events.filter((e) => e.kind === "permission_denied")).toEqual([
      { kind: "permission_denied", tool: "Bash", denial: "profile" },
      { kind: "permission_denied", tool: "Bash", denial: "profile" },
    ]);
    expect(state.unknownEvents).toBe(1); // the `_fixture` comment line only
  });
});

describe("Claude Code replay of a recovered run (ADR-0072)", () => {
  it("recovered dontAsk shell denials + success -> ok with a warning", async () => {
    const r = await replay();
    expect(r).toMatchObject({ ok: true, warnings: [{ code: "PERMISSION_DENIED_RECOVERED", tool: "Bash", count: 2 }] });
    expect(r.failureCode).toBeUndefined();
  });

  it.each([
    ["rule (Git deny rule)", "rule", "Bash"],
    ["other (file tool outside the worktree)", "other", "Write"],
    ["subcommandResults (unclassified)", "subcommandResults", "Bash"],
    ["no reason (unclassified)", undefined, "Bash"],
    ["mode on a file-write tool (unclassified)", "mode", "Write"],
  ])("%s -> PERMISSION_BLOCKED as before", async (_name, reason, tool) => {
    const r = await replay({ lines: withSecondReason(reason, tool) });
    expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED", failureDetail: "denied: Bash" });
    expect(r.warnings).toBeUndefined();
  });

  it("a denial only in result.permission_denials (no system event) stays unclassified -> PERMISSION_BLOCKED", async () => {
    const lines = fixtureLines().filter((l) => !l.includes('"toolu_recovered_2","decision_reason_type"'));
    const r = await replay({ lines });
    expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });

  it("a guard verdict on the denied call (credential path) -> SANDBOX_VIOLATION", async () => {
    const lines = fixtureLines().map((l) => l.replace("synthetic-build-step-1", "cat ~/.claude/.credentials.json"));
    const r = await replay({ lines });
    expect(r).toMatchObject({ ok: false, failureCode: "SANDBOX_VIOLATION" });
  });

  it("the provider failing after a recovered denial still fails", async () => {
    const lines = fixtureLines().map((l) =>
      l.startsWith('{"type":"result"') ? l.replace('"is_error":false', '"is_error":true') : l,
    );
    expect(await replay({ lines })).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(await replay({ exitCode: 1 })).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });
});
