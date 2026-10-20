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
    expect(claudeDenialClass("Bash", "subcommandResults")).toBe("git_write");
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

/** The shape of the `rule`-denied command of run_01M5D1YRABBYPBGFGWZGZHT18C (paths synthetic). */
const PROD_RULE_COMMAND =
  'for f in $(git ls-files src | head -20); do echo "$f $(git log -1 --format=%cs -- "$f")"; done; git branch -a';

/**
 * The prod stream shape: four dontAsk (`mode`) shell denials and one Git deny-rule (`rule`) denial of `command`, each
 * after its `tool_use`, then a successful `result`. `ruleToolUse: false` drops the denied `tool_use` line.
 */
function prodShape(command: string, o: { ruleToolUse?: boolean; reason?: string } = {}): string[] {
  const S = "{{SESSION_ID}}";
  const lines = [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: S,
      model: "synthetic-model",
    }),
  ];
  const call = (id: string, cmd: string, reason: string, withToolUse = true) => {
    if (withToolUse) {
      const content = [{ type: "tool_use", id, name: "Bash", input: { command: cmd } }];
      lines.push(
        JSON.stringify({
          type: "assistant",
          session_id: S,
          message: { role: "assistant", content },
        }),
      );
    }
    lines.push(
      JSON.stringify({
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: id,
        decision_reason_type: reason,
        message: "scrubbed",
        session_id: S,
      }),
    );
  };
  for (let i = 1; i <= 4; i++) call(`toolu_mode_${i}`, `synthetic-build-step-${i}`, "mode");
  call("toolu_rule", command, o.reason ?? "rule", o.ruleToolUse ?? true);
  lines.push(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done.",
      session_id: S,
    }),
  );
  return lines;
}

/** The `subcommandResults`-denied command of run_01M5D74KSXB5VVC4FZD0D3Q92C (whumpo #301 refresh, 2026-10-20). */
const PROD_SUBCOMMAND_COMMAND = "git branch -a --contains c121037704e9c004289585ad3fc4fa478ec3cfdd";

describe("Claude subcommandResults denials by command (ADR-0072 follow-up 2)", () => {
  it("maps subcommandResults like rule: a local Git read is recoverable, anything else fails", () => {
    expect(claudeDenialClass("Bash", "subcommandResults", PROD_SUBCOMMAND_COMMAND)).toBe("git_rule_local");
    expect(claudeDenialClass("Bash", "subcommandResults", "git log -1 && git push origin x")).toBe("git_write");
    expect(claudeDenialClass("Bash", "subcommandResults", "gh pr list")).toBe("git_write");
    expect(claudeDenialClass("Bash", "subcommandResults", "curl https://example.test")).toBe("git_write");
    expect(claudeDenialClass("Write", "subcommandResults", PROD_SUBCOMMAND_COMMAND)).toBe("git_write");
  });

  it("prod shape of run_01M5D74KSXB5VVC4FZD0D3Q92C -> ok with a GIT_RULE_DENIED_RECOVERED warning", async () => {
    const r = await replay({ lines: prodShape(PROD_SUBCOMMAND_COMMAND, { reason: "subcommandResults" }) });
    expect(r.failureCode, r.failureDetail).toBeUndefined();
    expect(r).toMatchObject({
      ok: true,
      warnings: [
        { code: "PERMISSION_DENIED_RECOVERED", tool: "Bash", count: 4 },
        { code: "GIT_RULE_DENIED_RECOVERED", tool: "Bash", count: 1 },
      ],
    });
  });

  it.each([
    ["git push origin x"],
    ["git -C ../x branch -a"],
    ["gh pr merge 1"],
    ["git branch -a; rm -rf /tmp/x && git fetch"],
  ])("subcommandResults denial of %j -> PERMISSION_BLOCKED", async (command) => {
    const r = await replay({ lines: prodShape(command, { reason: "subcommandResults" }) });
    expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });

  it("subcommandResults whose tool_use was never seen -> PERMISSION_BLOCKED", async () => {
    const r = await replay({
      lines: prodShape(PROD_SUBCOMMAND_COMMAND, { reason: "subcommandResults", ruleToolUse: false }),
    });
    expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
  });
});

describe("Claude Git deny-rule denials by command (ADR-0072 follow-up)", () => {
  it("maps a rule denial by the denied command; no command or another tool -> git_write", () => {
    expect(claudeDenialClass("Bash", "rule", PROD_RULE_COMMAND)).toBe("git_rule_local");
    expect(claudeDenialClass("Bash", "rule", "git push origin x")).toBe("git_write");
    expect(claudeDenialClass("Bash", "rule")).toBe("git_write");
    expect(claudeDenialClass("Write", "rule", "git branch -a")).toBe("git_write");
  });

  it("prod shape: 4 mode denials + a rule denial of a read-only git loop -> ok with both warnings", async () => {
    const r = await replay({ lines: prodShape(PROD_RULE_COMMAND) });
    expect(r.failureCode, r.failureDetail).toBeUndefined();
    expect(r).toMatchObject({
      ok: true,
      warnings: [
        { code: "PERMISSION_DENIED_RECOVERED", tool: "Bash", count: 4 },
        { code: "GIT_RULE_DENIED_RECOVERED", tool: "Bash", count: 1 },
      ],
    });
  });

  it.each([
    ["git push origin x"],
    ["git -C ../x branch"],
    ["gh pr merge 12 --squash"],
    ["git log -1; git remote set-url origin https://example.test/x.git"],
    ['echo "$(git push origin x)"; git branch -a'],
    ["for f in a b; do $f; done; git branch -a"],
    ["git branch -a | xargs git push origin"],
    ["unparseable 'quote"],
  ])("rule denial of %j -> PERMISSION_BLOCKED", async (command) => {
    const r = await replay({ lines: prodShape(command) });
    expect(r).toMatchObject({ ok: false, failureCode: "PERMISSION_BLOCKED" });
    expect(r.warnings).toBeUndefined();
  });

  it("a rule denial whose tool_use was never seen -> PERMISSION_BLOCKED (fail closed)", async () => {
    const r = await replay({
      lines: prodShape("git branch -a", { ruleToolUse: false }),
    });
    expect(r).toMatchObject({
      ok: false,
      failureCode: "PERMISSION_BLOCKED",
      failureDetail: "denied: Bash",
    });
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
    ["subcommandResults on a non-Git command (fail closed)", "subcommandResults", "Bash"],
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
