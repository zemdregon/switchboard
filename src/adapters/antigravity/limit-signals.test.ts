/**
 * T6.15 (FR-CAP-11, FR-ADP-04, FR-CAP-01, FR-CAP-09; ADR-0055 item 11; Delegated agent work, not owner-approved):
 * per-provider limit and usage signal mapping from the T6.11 captures (`docs/research/limit-captures-2026-10-17.md`).
 *
 * The captures hold one structured limit signal that was not already mapped: Antigravity's stderr line `AGY_ERROR:
 * {...}` at exit 3 with the keys `short_error`, `status` (`RESOURCE_EXHAUSTED`), `error_code` (429), `code_kind`,
 * `retryable` and `error_id`. The adapter maps `status` in `classifyFailure` from the stderr tail; the reset is free
 * text inside `short_error`, so no `reset_at` is sourced and no `USAGE_KEYS` entry is declared (Q-100 Delegated
 * default). Every other provider's limit was free text (Claude Code, Codex, Cursor, Kimi Code) or already mapped
 * (OpenCode `provider.quota`), so no other adapter changes.
 *
 * SYNTHETIC fixture: `fixtures/agy_error_quota.jsonl` is hand-written from the captured key names and values; no `agy`
 * is run. The replay writes the fixture's `stderr` lines to its stderr, so the supervisor captures them as a real run's
 * tail would be captured.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  USAGE_KEYS,
  type UsageKeyDeclaration,
  type UsageWindowInputs,
  usageWindows,
} from "../../capacity/usage-window.js";
import type { PacingSettings, SubscriptionSettings } from "../../config/capacity.js";
import { BUILTIN_PROVIDERS } from "../providers.js";
import { startAdapterRun } from "../run.js";
import {
  type CompileRequest,
  type ExitInfo,
  type FailureEvidence,
  isIneligible,
  type NormalizedEvent,
} from "../types.js";
import { AntigravityAdapter, agyErrorClassification } from "./adapter.js";
import { DEFAULT_SESSION_ID, PRIVILEGED_BYPASS_PROFILE, replayAdapter } from "./fixtures/cases.js";
import { AGY_ERROR_EXIT, AGY_ERROR_PREFIX, AGY_ERROR_STATUS_CATEGORIES } from "./protocol.js";

const dirs: string[] = [];
const makeCwd = () => {
  const d = mkdtempSync(join(tmpdir(), "sb-antigravity-limit-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const adapter = () => new AntigravityAdapter({ executable: "/usr/bin/false" });
const EXIT0: ExitInfo = { outcome: "exited", exitCode: 0, signal: null, expectedExitCodes: [0] };
const EXIT3: ExitInfo = { ...EXIT0, exitCode: AGY_ERROR_EXIT };
const evidence = (events: NormalizedEvent[], stderrTail: string, exit: ExitInfo = EXIT3): FailureEvidence => ({
  events,
  exit,
  stderrTail,
  timedOut: exit.outcome === "timeout",
  cancelled: exit.outcome === "cancelled",
});
/** The captured key names with SYNTHETIC values (status, error_code, code_kind and retryable as captured). */
const CAPTURED = {
  short_error: "SYNTHETIC quota text for tests. Resets in 1h2m3s.",
  status: "RESOURCE_EXHAUSTED",
  error_code: 429,
  code_kind: "http",
  retryable: true,
  error_id: "synthetic-error-id",
};
const line = (o: unknown) => `${AGY_ERROR_PREFIX}${JSON.stringify(o)}`;
const TAIL = `error: ${CAPTURED.short_error}\n${line(CAPTURED)}\n`;
const QUOTA = {
  code: "QUOTA_EXHAUSTED",
  detail: "quota: AGY_ERROR status RESOURCE_EXHAUSTED, error_code 429, retryable true",
};
const UNCHANGED = { code: "TOOL_FAILURE", detail: "exit code 3" };

const request = (cwd: string): CompileRequest => ({
  runId: "run_antigravity_t615",
  objective: "synthetic antigravity objective",
  constraints: [],
  workspace: { cwd, writable: true },
  bypassApproved: true,
});

/** Replays `fixture` through the supervisor and returns what `startAdapterRun` gives the lifecycle, tail included. */
async function replay(fixture: string) {
  const a = replayAdapter(fixture);
  const inv = a.compile(request(makeCwd()), PRIVILEGED_BYPASS_PROFILE);
  if (isIneligible(inv)) throw new Error(`ineligible: ${inv.reason}`);
  const outcome = await startAdapterRun(a, inv, { profile: PRIVILEGED_BYPASS_PROFILE, bypassApproved: true }).done;
  expect(outcome.groupEmpty).toBe(true);
  return { a, outcome };
}

describe("antigravity AGY_ERROR mapping on the recorded fixture (T6.15, FR-CAP-11; SYNTHETIC from the T6.11 key names)", () => {
  it("fixture agy_error_quota: the run's stderr tail carries the AGY_ERROR line and classifyFailure gives QUOTA_EXHAUSTED with no reset_at", async () => {
    const { a, outcome } = await replay("agy_error_quota");
    expect(outcome.exit).toMatchObject({ outcome: "exited", exitCode: 3 });
    // The supervisor captured both stderr lines; the structured one is the last.
    expect(outcome.stderrTail.split("\n").filter((l) => l !== "")).toEqual([
      "error: SYNTHETIC quota text for tests. Resets in 1h2m3s.",
      line(CAPTURED),
    ]);
    // Nothing on stdout said "limit": no rate_limit or provider_error event, the session is bound from `init`.
    expect(outcome.events.map((e) => e.kind)).toEqual(["session_bound"]);
    const c = a.classifyFailure({
      events: outcome.events,
      exit: outcome.exit,
      stderrTail: outcome.stderrTail,
      timedOut: false,
      cancelled: false,
    });
    expect(c).toEqual(QUOTA);
    // No reset_at: the duration lives in `short_error`, free text, which is never read (Q-100); the id is not copied.
    expect(Object.keys(c).sort()).toEqual(["code", "detail"]);
    expect(c.detail).not.toContain("Resets in");
    expect(c.detail).not.toContain("synthetic-error-id");
    expect(c.detail).not.toContain(CAPTURED.short_error);
    // `extractResult` gets no stderr (LLD §2), but `startAdapterRun` re-asks `classifyFailure` with the captured tail
    // when the folded result is TOOL_FAILURE (2026-10-21, with Cursor's identical gap), so the lifecycle reads quota.
    expect(outcome.result).toEqual({
      ok: false,
      failureCode: "QUOTA_EXHAUSTED",
      failureDetail: QUOTA.detail,
      nativeSessionId: DEFAULT_SESSION_ID,
      unknownEventCount: 0,
    });
  });

  it("fixture agy_error_exit3 (exit 3, no AGY_ERROR line) is unchanged on both paths: TOOL_FAILURE exit code 3", async () => {
    const { a, outcome } = await replay("agy_error_exit3");
    expect(outcome.stderrTail).toBe("");
    expect(outcome.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: "exit code 3" });
    expect(
      a.classifyFailure({
        events: outcome.events,
        exit: outcome.exit,
        stderrTail: "",
        timedOut: false,
        cancelled: false,
      }),
    ).toEqual(UNCHANGED);
  });
});

describe("antigravity AGY_ERROR mapping rules (T6.15, FR-ADP-04; SYNTHETIC tails)", () => {
  it("maps status RESOURCE_EXHAUSTED to quota (QUOTA_EXHAUSTED) and no other status", () => {
    expect(AGY_ERROR_STATUS_CATEGORIES).toEqual({ RESOURCE_EXHAUSTED: "quota" });
    expect(Object.isFrozen(AGY_ERROR_STATUS_CATEGORIES)).toBe(true);
    expect(agyErrorClassification(evidence([], TAIL))).toEqual(QUOTA);
    expect(adapter().classifyFailure(evidence([], TAIL))).toEqual(QUOTA);
    for (const status of [
      "UNAVAILABLE",
      "INTERNAL",
      "UNAUTHENTICATED",
      "PERMISSION_DENIED",
      "OK",
      "",
      "resource_exhausted",
    ]) {
      const tail = `${line({ ...CAPTURED, status })}\n`;
      expect(agyErrorClassification(evidence([], tail)), status).toBeUndefined();
      expect(adapter().classifyFailure(evidence([], tail)), status).toEqual(UNCHANGED);
    }
  });

  it("error_code 429 or retryable alone, a non-string status or a missing status map nothing", () => {
    const { status: _s, ...noStatus } = CAPTURED;
    for (const o of [
      noStatus,
      { ...CAPTURED, status: 429 },
      { ...CAPTURED, status: null },
      { error_code: 429 },
      { retryable: true },
    ]) {
      expect(agyErrorClassification(evidence([], `${line(o)}\n`)), JSON.stringify(o)).toBeUndefined();
    }
  });

  it("requires the documented exit code 3 and an exited outcome; other exits and supervisor outcomes keep the common verdict", () => {
    for (const code of [0, 1, 2, 4, null]) {
      const exit = { ...EXIT3, exitCode: code };
      expect(agyErrorClassification(evidence([], TAIL, exit)), String(code)).toBeUndefined();
    }
    expect(adapter().classifyFailure(evidence([], TAIL, { ...EXIT3, exitCode: 1 }))).toEqual({
      code: "TOOL_FAILURE",
      detail: "exit code 1",
    });
    expect(adapter().classifyFailure(evidence([], TAIL, { ...EXIT3, exitCode: 0 }))).toEqual({
      code: "OUTPUT_PROTOCOL_ERROR",
      detail: "no result event",
    });
    expect(
      adapter().classifyFailure(evidence([], TAIL, { ...EXIT3, outcome: "timeout", timeoutKind: "idle" })),
    ).toEqual({
      code: "PROCESS_TIMEOUT",
      detail: "idle timeout",
    });
    expect(adapter().classifyFailure(evidence([], TAIL, { ...EXIT3, outcome: "cancelled" }))).toEqual({
      code: "CANCELLED",
      detail: "run cancelled",
    });
    expect(adapter().classifyFailure(evidence([], TAIL, { ...EXIT3, outcome: "crashed", signal: "SIGKILL" }))).toEqual({
      code: "PROCESS_CRASH",
      detail: "signal SIGKILL",
    });
    expect(adapter().classifyFailure(evidence([], TAIL, { ...EXIT3, outcome: "protocol_error" }))).toEqual({
      code: "OUTPUT_PROTOCOL_ERROR",
      detail: "unparseable provider output",
    });
  });

  it("reads only a line that starts with the exact prefix, the last such line, with or without a carriage return", () => {
    const json = JSON.stringify(CAPTURED);
    for (const tail of [
      `AGY_ERROR:${json}\n`,
      `agy_error: ${json}\n`,
      ` ${AGY_ERROR_PREFIX}${json}\n`,
      `AGY_ERROR ${json}\n`,
      `x ${AGY_ERROR_PREFIX}${json}\n`,
      `RESOURCE_EXHAUSTED: 429 Too Many Requests\n`,
      `error: ${CAPTURED.short_error}\n`,
      "",
    ]) {
      expect(agyErrorClassification(evidence([], tail)), JSON.stringify(tail)).toBeUndefined();
    }
    expect(agyErrorClassification(evidence([], `${line(CAPTURED)}\r\n`))).toEqual(QUOTA);
    expect(agyErrorClassification(evidence([], line(CAPTURED)))).toEqual(QUOTA); // no trailing newline
    // The last AGY_ERROR line is the one read (the final error of the run).
    const other = line({ ...CAPTURED, status: "UNAVAILABLE" });
    expect(agyErrorClassification(evidence([], `${line(CAPTURED)}\n${other}\n`))).toBeUndefined();
    expect(agyErrorClassification(evidence([], `${other}\n${line(CAPTURED)}\n`))).toEqual(QUOTA);
  });

  it("fails closed on a truncated tail, a non-object document or a status that is only a prototype property", () => {
    const json = JSON.stringify(CAPTURED);
    for (const body of [
      json.slice(0, -1),
      json.slice(0, 40),
      "",
      "[]",
      `[${json}]`,
      '"RESOURCE_EXHAUSTED"',
      "429",
      "null",
      "true",
      '{"__proto__":{"status":"RESOURCE_EXHAUSTED"}}',
      JSON.stringify({ ...CAPTURED, status: "constructor" }),
      JSON.stringify({ ...CAPTURED, status: "toString" }),
      JSON.stringify({ ...CAPTURED, status: "__proto__" }),
      JSON.stringify({ ...CAPTURED, status: "hasOwnProperty" }),
    ]) {
      expect(agyErrorClassification(evidence([], `${AGY_ERROR_PREFIX}${body}\n`)), body).toBeUndefined();
    }
    // A tail bounded by the caller that cuts the line in half maps nothing; one that keeps it whole maps.
    const whole = `${"x".repeat(100)}\n${line(CAPTURED)}\n`;
    expect(agyErrorClassification(evidence([], whole.slice(-40)))).toBeUndefined();
    expect(agyErrorClassification(evidence([], whole.slice(-(line(CAPTURED).length + 1))))).toEqual(QUOTA);
  });

  it("the detail carries only the structured values; a non-number error_code or non-boolean retryable is left out", () => {
    expect(agyErrorClassification(evidence([], `${line({ status: "RESOURCE_EXHAUSTED" })}\n`))).toEqual({
      code: "QUOTA_EXHAUSTED",
      detail: "quota: AGY_ERROR status RESOURCE_EXHAUSTED",
    });
    expect(
      agyErrorClassification(evidence([], `${line({ ...CAPTURED, error_code: "429", retryable: "true" })}\n`)),
    ).toEqual({ code: "QUOTA_EXHAUSTED", detail: "quota: AGY_ERROR status RESOURCE_EXHAUSTED" });
    // A number that overflows to Infinity in JSON is not finite, so it is left out like a non-number.
    const overflow = `${AGY_ERROR_PREFIX}{"status":"RESOURCE_EXHAUSTED","error_code":1e999,"retryable":true}\n`;
    expect(agyErrorClassification(evidence([], overflow))).toEqual({
      code: "QUOTA_EXHAUSTED",
      detail: "quota: AGY_ERROR status RESOURCE_EXHAUSTED, retryable true",
    });
    expect(agyErrorClassification(evidence([], `${line({ ...CAPTURED, retryable: false })}\n`))).toEqual({
      code: "QUOTA_EXHAUSTED",
      detail: "quota: AGY_ERROR status RESOURCE_EXHAUSTED, error_code 429, retryable false",
    });
  });

  it("free text is never read: short_error and the stderr text decide nothing, whatever they say (FR-ADP-04, Q-100)", () => {
    for (const text of [
      "authentication failed or timed out",
      "invalid model selection (--model x)",
      "rate limit exceeded, retry after 30s",
      "sandbox: operation denied",
      "Resets in 121h22m9s",
    ]) {
      // With the mapped status the verdict is quota whatever the text; with an unmapped status the text cannot help.
      expect(
        agyErrorClassification(evidence([], `error: ${text}\n${line({ ...CAPTURED, short_error: text })}\n`)),
        text,
      ).toEqual(QUOTA);
      expect(
        agyErrorClassification(
          evidence([], `error: ${text}\n${line({ ...CAPTURED, status: "OK", short_error: text })}\n`),
        ),
        text,
      ).toBeUndefined();
    }
  });

  it("precedence: the mapping replaces TOOL_FAILURE only; every more specific verdict stands", () => {
    const a = adapter();
    const CID = DEFAULT_SESSION_ID;
    const with_ = (events: NormalizedEvent[]) => a.classifyFailure(evidence(events, TAIL));
    // TOOL_FAILURE verdicts the structured line refines.
    expect(with_([])).toEqual(QUOTA);
    expect(
      with_([
        { kind: "session_bound", nativeSessionId: CID },
        { kind: "result", ok: false, summary: "ERROR" },
      ]),
    ).toEqual(QUOTA);
    expect(with_([{ kind: "provider_error", category: "unknown", message: "RESOURCE_EXHAUSTED: quota" }])).toEqual(
      QUOTA,
    );
    expect(with_([{ kind: "provider_error", category: "tool", message: "x" }])).toEqual(QUOTA);
    expect(with_([{ kind: "result", ok: false, summary: "SUCCESS with no reported tokens" }])).toEqual(QUOTA);
    // More specific verdicts stand.
    expect(with_([{ kind: "permission_denied", tool: "RunCommand" }])).toEqual({
      code: "PERMISSION_BLOCKED",
      detail: "denied: RunCommand",
    });
    expect(
      with_([
        {
          kind: "tool_call",
          tool: "shell",
          name: "run_command",
          violation: { kind: "git_write", reason: "`git push`" },
        },
      ]),
    ).toEqual({ code: "PERMISSION_BLOCKED", detail: "git write attempted: `git push`" });
    expect(with_([{ kind: "sandbox_violation", detail: "escaped" }])).toEqual({
      code: "SANDBOX_VIOLATION",
      detail: "escaped",
    });
    expect(with_([{ kind: "provider_error", category: "auth", message: "authentication failed" }])).toEqual({
      code: "AUTH_REQUIRED",
      detail: "auth: authentication failed",
    });
    expect(
      with_([{ kind: "provider_error", category: "model_unavailable", message: "invalid model selection" }]),
    ).toEqual({
      code: "MODEL_UNAVAILABLE",
      detail: "model_unavailable: invalid model selection",
    });
    expect(with_([{ kind: "provider_error", category: "protocol", message: "more than one result line" }])).toEqual({
      code: "OUTPUT_PROTOCOL_ERROR",
      detail: "protocol: more than one result line",
    });
    expect(with_([{ kind: "rate_limit" }])).toEqual({ code: "RATE_LIMIT_TRANSIENT", detail: "rate limit reported" });
    expect(a.classifyFailure({ ...evidence([], TAIL), cancelled: true })).toEqual({
      code: "CANCELLED",
      detail: "run cancelled",
    });
    expect(a.classifyFailure({ ...evidence([], TAIL), timedOut: true })).toEqual({
      code: "PROCESS_TIMEOUT",
      detail: "unknown timeout",
    });
  });

  it("a provider with no structured signal is unchanged: no other adapter reads the tail, Antigravity's own verdict without it is the same", () => {
    const others = BUILTIN_PROVIDERS.filter((p) => p.id !== "antigravity" && p.create !== undefined);
    expect(others.map((p) => p.id)).toEqual(["claude", "codex", "grok", "cursor", "opencode", "kimi", "muse", "fake"]);
    for (const p of others) {
      const a = p.create?.({});
      if (a === undefined) throw new Error(`no adapter for ${p.id}`);
      const withTail = a.classifyFailure(evidence([], TAIL));
      expect(withTail, p.id).toEqual(a.classifyFailure(evidence([], "")));
      expect(withTail, p.id).toEqual(UNCHANGED);
    }
    expect(adapter().classifyFailure(evidence([], ""))).toEqual(UNCHANGED);
  });
});

describe("USAGE_KEYS after T6.15 (FR-CAP-09, LLD §16.9): no captured key qualifies", () => {
  const NOW = new Date("2026-10-17T12:00:00.000Z");
  const PACING: PacingSettings = { mode: "gate", targetFraction: 0.95, burstFraction: 0.1, minConfidence: 0.5 };
  const sub: SubscriptionSettings = {
    name: "google",
    providers: ["antigravity"],
    adapterIds: ["antigravity"],
    windows: [{ id: "five-hour", lengthSeconds: 5 * 3600, reset: { kind: "provider_reported" }, budget: null }],
  };
  /**
   * The captured AGY_ERROR keys as a `rate_limit` signal payload, plus invented `reset_time` and `remaining_fraction`
   * keys that no capture shows (the shape a future capture might carry), and a usage row with the same invented key.
   */
  const inputs: UsageWindowInputs = {
    startedRuns: [{ provider: "antigravity", startedAt: "2026-10-17T11:00:00.000Z" }],
    usage: [
      {
        provider: "antigravity",
        source: "provider_reported",
        metrics: { total_tokens: 24, remaining_fraction: 0.25 },
        observedAt: "2026-10-17T11:58:00.000Z",
      },
    ],
    rateLimitSignals: [
      {
        provider: "antigravity",
        payload: {
          status: "RESOURCE_EXHAUSTED",
          error_code: 429,
          code_kind: "http",
          retryable: true,
          reset_time: "2026-10-17T13:30:00.000Z",
        },
        observedAt: "2026-10-17T11:59:00.000Z",
      },
    ],
  };
  const window = (keys?: Readonly<Record<string, readonly UsageKeyDeclaration[]>>) => {
    const out = usageWindows([sub], PACING, inputs, NOW, keys);
    if (out === undefined) throw new Error("expected output");
    return out[0]?.windows[0];
  };

  it("USAGE_KEYS declares nothing for Antigravity (only Claude Code's captured keys, ADR-0088) and stays frozen", () => {
    expect(Object.keys(USAGE_KEYS)).toEqual(["claude"]);
    expect(USAGE_KEYS.antigravity).toBeUndefined();
    expect(Object.isFrozen(USAGE_KEYS)).toBe(true);
  });

  it("an undeclared key never yields provider_reported: the captured payload and even an invented reset or remaining key leave the window unknown", () => {
    for (const w of [window(), window(USAGE_KEYS)]) {
      expect(w?.reset_at).toBeNull();
      expect(w?.window_start).toBeNull();
      expect(w?.used_fraction).toEqual({ value: null, source: "unknown", confidence: 0 });
      expect(w?.elapsed_fraction).toBeNull();
      expect(w?.pace).toBe("unknown");
    }
  });

  it("a declared key yields provider_reported pacing (test-local injection: no real Antigravity key qualifies, so none is declared)", () => {
    const injected: Record<string, readonly UsageKeyDeclaration[]> = {
      antigravity: [
        {
          origin: "rate_limit",
          key: "reset_time",
          carries: "reset_at",
          source: "test-local injection (T6.15): the captured AGY_ERROR carries its reset only as free text",
        },
        {
          origin: "usage_observation",
          key: "remaining_fraction",
          carries: "remaining_fraction",
          source: "test-local injection (T6.15): no capture shows a remaining fraction in run output",
        },
      ],
    };
    const w = window(injected);
    expect(w?.reset_at).toEqual({ at: "2026-10-17T13:30:00.000Z", source: "provider_reported" });
    expect(w?.window_start).toEqual({ at: "2026-10-17T08:30:00.000Z", source: "provider_reported" });
    expect(w?.used_fraction).toEqual({
      value: 0.75,
      source: "provider_reported",
      confidence: 1,
      key: "remaining_fraction",
    });
    // 0.7 elapsed, 0.75 used: within the burst band of the 0.95 target line (0.665), so on pace; allowance (0.95 -
    // 0.75) / 0.3.
    expect(w?.elapsed_fraction).toBe(0.7);
    expect(w?.allowance).toBe(0.666667);
    expect(w?.pace).toBe("on_pace");
    // The same declaration for another provider id declares nothing for Antigravity.
    const elsewhere = window({ claude: injected.antigravity ?? [] });
    expect(elsewhere?.reset_at).toBeNull();
    expect(elsewhere?.used_fraction.source).toBe("unknown");
  });
});
