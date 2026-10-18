/**
 * T6.15 (FR-CAP-11, FR-ADP-04; Delegated agent work, not owner-approved): Kimi Code 5-hour usage-limit mapping
 * from the 2026-10-15 T6.11 capture (`kimi-20261015T103850Z.txt`, exit 1).
 *
 * SYNTHETIC tails only, built from the redacted capture line (the capture carries no secret): a non-zero exited
 * run whose stderr tail holds a line with both `403` and `usage limit` maps to `QUOTA_EXHAUSTED`
 * (`kimiQuotaClassification`, reached only through `FailureEvidence.stderrTail`, which `extractResult` cannot
 * supply). The quota check runs before the auth mapping because the CLI labels this quota stop
 * `provider.auth_error`: without it the router would treat a usage stop as a logged-out provider. A `403`
 * without `usage limit` keeps its current mapping, and exit 0 never maps to quota. No `kimi` is run.
 */
import { describe, expect, it } from "vitest";
import type { ExitInfo, FailureEvidence, NormalizedEvent } from "../types.js";
import { KimiAdapter, kimiQuotaClassification } from "./adapter.js";

const adapter = () => new KimiAdapter({ executable: "/opt/synthetic/kimi" });
const EXIT_OK: ExitInfo = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] };
const EXIT_1: ExitInfo = { ...EXIT_OK, exitCode: 1 };
const evidence = (
  events: NormalizedEvent[],
  stderrTail: string,
  exit: ExitInfo = EXIT_1,
  extra: Partial<FailureEvidence> = {},
): FailureEvidence => ({ events, exit, stderrTail, timedOut: false, cancelled: false, ...extra });
/** The redacted capture line, verbatim (no secret, no account identifier). */
const CAPTURE_LINE =
  "error: failed to run prompt: provider.auth_error: 403 You've reached your 5-hour usage limit. Your quota will " +
  "reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: " +
  "https://www.kimi.com/membership/subscription?tab=quota";
const QUOTA = { code: "QUOTA_EXHAUSTED", detail: "quota: 403 usage limit" };
const TOOL_FAILURE_1 = { code: "TOOL_FAILURE", detail: "exit code 1" };
const AUTH_ERROR: NormalizedEvent = {
  kind: "provider_error",
  category: "auth",
  message: "Authentication required",
};
const UNKNOWN_ERROR: NormalizedEvent = {
  kind: "provider_error",
  category: "unknown",
  message: CAPTURE_LINE,
};

describe("kimi 5-hour usage-limit mapping (T6.15, FR-CAP-11; SYNTHETIC tails from the capture line)", () => {
  it("the capture line at exit 1 maps to QUOTA_EXHAUSTED with a fixed detail carrying no account text", () => {
    const tail = `${CAPTURE_LINE}\nSee log: <path>\nEXIT 1\n`;
    expect(kimiQuotaClassification(evidence([], tail))).toEqual(QUOTA);
    expect(adapter().classifyFailure(evidence([], tail))).toEqual(QUOTA);
    // The detail names the matched signal only: no URL, no tail text.
    const c = adapter().classifyFailure(evidence([], tail));
    expect(Object.keys(c).sort()).toEqual(["code", "detail"]);
    expect(c.detail).not.toContain("kimi.com");
    expect(c.detail).not.toContain("5-hour");
  });

  it("the quota check runs before the auth mapping: a stream auth or unknown error for the same stop still maps quota", () => {
    const tail = `${CAPTURE_LINE}\n`;
    // The CLI labels the quota stop `provider.auth_error`; a stream event for it would read as logged-out.
    expect(adapter().classifyFailure(evidence([AUTH_ERROR], tail))).toEqual(QUOTA);
    // A meta error carrying the capture text lands in `unknown` today (it starts with neither observed auth
    // prefix); the tail still refines it to quota.
    expect(adapter().classifyFailure(evidence([UNKNOWN_ERROR], tail))).toEqual(QUOTA);
    // A failed result beside the tail is refined the same way.
    expect(adapter().classifyFailure(evidence([{ kind: "result", ok: false, summary: "task failed" }], tail))).toEqual(
      QUOTA,
    );
  });

  it("a near-miss stays on the old mapping: a 403 without usage limit changes nothing", () => {
    // A 403 auth failure with no usage-limit text keeps TOOL_FAILURE (no stream event) or AUTH_REQUIRED.
    const auth403 = "error: failed to run prompt: provider.auth_error: 403 invalid api key\n";
    expect(kimiQuotaClassification(evidence([], auth403))).toBeUndefined();
    expect(adapter().classifyFailure(evidence([], auth403))).toEqual(TOOL_FAILURE_1);
    expect(adapter().classifyFailure(evidence([AUTH_ERROR], auth403))).toEqual({
      code: "AUTH_REQUIRED",
      detail: "auth: Authentication required",
    });
    // "usage limit" without a 403 is not the captured signal.
    const noStatus = "error: failed to run prompt: usage limit reached, try again later\n";
    expect(kimiQuotaClassification(evidence([], noStatus))).toBeUndefined();
    expect(adapter().classifyFailure(evidence([], noStatus))).toEqual(TOOL_FAILURE_1);
    // 403 as part of a longer number is not the status.
    const longNumber = "error: failed after 14039 retries: usage limit bookkeeping\n";
    expect(kimiQuotaClassification(evidence([], longNumber))).toBeUndefined();
    expect(adapter().classifyFailure(evidence([], longNumber))).toEqual(TOOL_FAILURE_1);
    // The phrases on different lines are not one signal.
    const split = "error: provider.auth_error: 403\ninfo: usage limit dashboard at <url>\n";
    expect(kimiQuotaClassification(evidence([], split))).toBeUndefined();
    expect(adapter().classifyFailure(evidence([], split))).toEqual(TOOL_FAILURE_1);
  });

  it("exit 0 never maps to quota, whatever the tail says", () => {
    expect(kimiQuotaClassification(evidence([], `${CAPTURE_LINE}\n`, EXIT_OK))).toBeUndefined();
    expect(adapter().classifyFailure(evidence([], `${CAPTURE_LINE}\n`, EXIT_OK))).toEqual({
      code: "OUTPUT_PROTOCOL_ERROR",
      detail: "no result event",
    });
  });

  it("precedence: every verdict more specific than TOOL_FAILURE/AUTH_REQUIRED stands", () => {
    const tail = `${CAPTURE_LINE}\n`;
    const with_ = (events: NormalizedEvent[]) => adapter().classifyFailure(evidence(events, tail));
    expect(
      with_([
        {
          kind: "tool_call",
          tool: "shell",
          name: "run",
          command: "git push",
          violation: { kind: "git_write", reason: "git push" },
        },
      ]),
    ).toEqual({ code: "PERMISSION_BLOCKED", detail: "git write attempted: git push" });
    expect(with_([{ kind: "permission_denied", tool: "Shell" }])).toEqual({
      code: "PERMISSION_BLOCKED",
      detail: "denied: Shell",
    });
    expect(with_([{ kind: "provider_error", category: "model_unavailable", message: "no such model" }])).toEqual({
      code: "MODEL_UNAVAILABLE",
      detail: "model_unavailable: no such model",
    });
    expect(with_([{ kind: "provider_error", category: "protocol", message: "more than one resume hint" }])).toEqual({
      code: "OUTPUT_PROTOCOL_ERROR",
      detail: "protocol: more than one resume hint",
    });
    expect(with_([{ kind: "rate_limit" }])).toEqual({ code: "RATE_LIMIT_TRANSIENT", detail: "rate limit reported" });
    expect(adapter().classifyFailure(evidence([], tail, EXIT_1, { cancelled: true }))).toEqual({
      code: "CANCELLED",
      detail: "run cancelled",
    });
    expect(
      adapter().classifyFailure(evidence([], tail, { ...EXIT_1, outcome: "timeout", timeoutKind: "idle" })),
    ).toEqual({
      code: "PROCESS_TIMEOUT",
      detail: "idle timeout",
    });
    expect(
      adapter().classifyFailure(
        evidence([], tail, { ...EXIT_1, outcome: "crashed", exitCode: null, signal: "SIGKILL" }),
      ),
    ).toEqual({ code: "PROCESS_CRASH", detail: "signal SIGKILL" });
  });

  it("extractResult cannot see the tail: a quota-stop-shaped run still ends TOOL_FAILURE there (pinned gap)", () => {
    // The adapter contract passes no stderr to extractResult (LLD §2), so the mapping is reached only by a caller
    // that passes the tail to classifyFailure, as `startAdapterRun` captures it (src/adapters/run.ts).
    expect(adapter().extractResult([], EXIT_1)).toEqual({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "exit code 1",
      unknownEventCount: 0,
    });
  });
});
