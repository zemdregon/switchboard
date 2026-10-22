/**
 * T6.15 (FR-CAP-11, FR-ADP-04; accepted by owner decision 64, [ADR-0058](../../adr/0058-captured-limit-signatures.md)):
 * Cursor "out of usage" limit-signal mapping from the 2026-10-18 T6.11 captures (`cursor-20261018T091208Z.txt`,
 * exit 1; the signature repeats across the `cursor-*.txt` captures).
 *
 * SYNTHETIC tails only, built from the redacted capture line (the capture carries no secret): a non-zero exited
 * run whose stderr tail holds a line with both `ActionRequiredError` and `out of usage` maps to `QUOTA_EXHAUSTED`
 * (`cursorQuotaClassification`, reached through `FailureEvidence.stderrTail`, which `extractResult` cannot
 * supply; `startAdapterRun` applies it to a TOOL_FAILURE result). A near-miss stays on the old mapping (either phrase alone, the phrases on different lines, or a generic
 * limit word with neither phrase), and exit 0 never maps to quota. No `cursor-agent` is run.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startAdapterRun } from "../run.js";
import type { ExitInfo, FailureEvidence, NormalizedEvent } from "../types.js";
import { CursorAdapter, cursorQuotaClassification } from "./adapter.js";

const adapter = () => new CursorAdapter({ executable: "/usr/bin/false" });
const EXIT_OK: ExitInfo = {
  outcome: "exited",
  exitCode: 0,
  signal: null,
  expectedExitCodes: [0],
};
const EXIT_1: ExitInfo = { ...EXIT_OK, exitCode: 1 };
const evidence = (
  events: NormalizedEvent[],
  stderrTail: string,
  exit: ExitInfo = EXIT_1,
  extra: Partial<FailureEvidence> = {},
): FailureEvidence => ({
  events,
  exit,
  stderrTail,
  timedOut: false,
  cancelled: false,
  ...extra,
});
/** The redacted capture line, verbatim (no secret, no account identifier). */
const CAPTURE_LINE =
  "ActionRequiredError: Increase limits for faster responses You're out of usage. Switch to Auto, " +
  "or ask your admin to increase your limit to continue.";
const QUOTA = {
  code: "QUOTA_EXHAUSTED",
  detail: "quota: ActionRequiredError out of usage",
};
const TOOL_FAILURE_1 = { code: "TOOL_FAILURE", detail: "exit code 1" };

describe("cursor out-of-usage mapping (T6.15, FR-CAP-11; SYNTHETIC tails from the capture line)", () => {
  it("the capture line at exit 1 maps to QUOTA_EXHAUSTED with a fixed detail carrying no account text", () => {
    const tail = `${CAPTURE_LINE}\nEXIT 1\n`;
    expect(cursorQuotaClassification(evidence([], tail))).toEqual(QUOTA);
    expect(adapter().classifyFailure(evidence([], tail))).toEqual(QUOTA);
    // The detail names the matched signal only: no account identifier, no tail text.
    const c = adapter().classifyFailure(evidence([], tail));
    expect(Object.keys(c).sort()).toEqual(["code", "detail"]);
    expect(c.detail).not.toContain("admin");
    expect(c.detail).not.toContain("Auto");
  });

  it("a near-miss stays on the old mapping: one phrase alone maps nothing", () => {
    // Another ActionRequiredError text (for example a login prompt) without "out of usage".
    const loginPrompt = "ActionRequiredError: Not signed in. Run `cursor-agent login` to continue.\n";
    expect(cursorQuotaClassification(evidence([], loginPrompt))).toBeUndefined();
    expect(adapter().classifyFailure(evidence([], loginPrompt))).toEqual(TOOL_FAILURE_1);
    // "out of usage" without the ActionRequiredError marker.
    const bareUsage = "You're out of usage. Switch to Auto to continue.\n";
    expect(cursorQuotaClassification(evidence([], bareUsage))).toBeUndefined();
    expect(adapter().classifyFailure(evidence([], bareUsage))).toEqual(TOOL_FAILURE_1);
    // Generic limit words with neither phrase map nothing (ADR-0058 (d)).
    for (const generic of [
      "Error: rate limit exceeded (429), retry later.\n",
      "Error: quota exceeded for this window.\n",
      "ActionRequiredError: none\nlimit reached\n",
    ]) {
      expect(cursorQuotaClassification(evidence([], generic))).toBeUndefined();
      expect(adapter().classifyFailure(evidence([], generic))).toEqual(TOOL_FAILURE_1);
    }
    // The phrases on different lines are not one signal.
    const split = "ActionRequiredError: something else failed\nYou're out of usage\n";
    expect(cursorQuotaClassification(evidence([], split))).toBeUndefined();
    expect(adapter().classifyFailure(evidence([], split))).toEqual(TOOL_FAILURE_1);
    // Case matters for the marker; "out of usage" matches in any case.
    expect(cursorQuotaClassification(evidence([], `${CAPTURE_LINE.toLowerCase()}\n`))).toBeUndefined();
    expect(
      cursorQuotaClassification(evidence([], `${CAPTURE_LINE.replace("out of usage", "OUT OF USAGE")}\n`)),
    ).toEqual(QUOTA);
  });

  it("exit 0 never maps to quota, whatever the tail says", () => {
    expect(cursorQuotaClassification(evidence([], `${CAPTURE_LINE}\n`, EXIT_OK))).toBeUndefined();
    expect(adapter().classifyFailure(evidence([], `${CAPTURE_LINE}\n`, EXIT_OK))).toEqual({
      code: "OUTPUT_PROTOCOL_ERROR",
      detail: "no result event",
    });
  });

  it("precedence: the mapping replaces TOOL_FAILURE only; every more specific verdict stands", () => {
    const tail = `${CAPTURE_LINE}\n`;
    const with_ = (events: NormalizedEvent[]) => adapter().classifyFailure(evidence(events, tail));
    expect(with_([])).toEqual(QUOTA);
    expect(with_([{ kind: "result", ok: false, summary: "task failed" }])).toEqual(QUOTA);
    expect(with_([{ kind: "provider_error", category: "unknown", message: "boom" }])).toEqual(QUOTA);
    expect(with_([{ kind: "provider_error", category: "tool", message: "boom" }])).toEqual(QUOTA);
    expect(with_([{ kind: "provider_error", category: "quota", message: "limit" }])).toEqual({
      code: "QUOTA_EXHAUSTED",
      detail: "quota: limit",
    });
    // A login prompt's structured auth error stands: the tail alone never promotes it.
    expect(
      with_([
        {
          kind: "provider_error",
          category: "auth",
          message: "credential source env is not the native login",
        },
      ]),
    ).toEqual({
      code: "AUTH_REQUIRED",
      detail: "auth: credential source env is not the native login",
    });
    expect(with_([{ kind: "permission_denied", tool: "shellToolCall" }])).toEqual({
      code: "PERMISSION_BLOCKED",
      detail: "denied: shellToolCall",
    });
    expect(with_([{ kind: "rate_limit" }])).toEqual({
      code: "RATE_LIMIT_TRANSIENT",
      detail: "rate limit reported",
    });
    expect(adapter().classifyFailure(evidence([], tail, EXIT_1, { cancelled: true }))).toEqual({
      code: "CANCELLED",
      detail: "run cancelled",
    });
    expect(
      adapter().classifyFailure(
        evidence([], tail, {
          ...EXIT_1,
          outcome: "timeout",
          timeoutKind: "idle",
        }),
      ),
    ).toEqual({
      code: "PROCESS_TIMEOUT",
      detail: "idle timeout",
    });
  });

  it("a cancelled run never maps to quota, whatever the tail says", () => {
    expect(cursorQuotaClassification(evidence([], `${CAPTURE_LINE}\n`, EXIT_1, { cancelled: true }))).toBeUndefined();
  });

  it("extractResult cannot see the tail: a quota-stop-shaped run still ends TOOL_FAILURE there (pinned gap)", () => {
    // The adapter contract passes no stderr to extractResult (LLD §2); startAdapterRun closes the gap (next test).
    expect(adapter().extractResult([], EXIT_1)).toEqual({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "exit code 1",
      unknownEventCount: 0,
    });
  });

  it("startAdapterRun: a run that exits 1 with the 2026-10-21 stderr ends QUOTA_EXHAUSTED, not TOOL_FAILURE", async () => {
    const stderr =
      "ActionRequiredError: Increase limits for faster responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.";
    const dir = mkdtempSync(join(tmpdir(), "sb-cursor-quota-"));
    const file = (code: string): string => {
      const f = join(dir, `${Math.random().toString(36).slice(2)}.cjs`);
      writeFileSync(f, code);
      return f;
    };
    const script = `process.stderr.write(${JSON.stringify(stderr)}); process.exit(1);`;
    const inv = {
      transport: "subprocess-jsonl" as const,
      argv: [process.execPath, file(script)],
      env: {},
      envAllowlist: [],
      cwd: process.cwd(),
      stdin: { kind: "none" as const },
      outputFormat: "jsonl" as const,
      timeouts: { wallClockMs: 20_000, idleMs: 20_000, killGraceMs: 1000 },
      policyFlags: [],
      expectedExitCodes: [0],
      maxLineBytes: 65_536,
    };
    const out = await startAdapterRun(adapter(), inv).done;
    expect(out.result).toMatchObject({
      ok: false,
      failureCode: "QUOTA_EXHAUSTED",
      failureDetail: QUOTA.detail,
    });
    // The same exit without the usage text stays TOOL_FAILURE.
    const plain = { ...inv, argv: [process.execPath, file("process.stderr.write('boom'); process.exit(1);")] };
    try {
      expect((await startAdapterRun(adapter(), plain).done).result).toMatchObject({
        failureCode: "TOOL_FAILURE",
        failureDetail: "exit code 1",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
