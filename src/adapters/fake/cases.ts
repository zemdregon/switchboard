/** Conformance cases for the fake adapter (T1.7). */
import type { ConformanceCase } from "../conformance.js";
import type { CompileRequest, ResolvedProfile } from "../types.js";
import { FakeAdapter, type FakeScenario } from "./adapter.js";

export const FAKE_PROFILE: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};

const SHORT = { wallClockMs: 10_000, idleMs: 400, killGraceMs: 300 };

/** `makeCwd` returns a fresh empty directory for each case (partial mutation writes into it). */
export function fakeConformanceCases(makeCwd: () => string): ConformanceCase[] {
  const request = (): CompileRequest => ({
    runId: "run_fake",
    objective: "do the thing",
    constraints: [],
    workspace: { cwd: makeCwd(), writable: true },
  });
  const make = (scenario: FakeScenario, timeouts?: Partial<typeof SHORT>) =>
    new FakeAdapter({ scenario, timeouts: { ...SHORT, ...timeouts } });
  const base = { profile: FAKE_PROFILE } as const;
  return [
    {
      ...base,
      kind: "success",
      adapter: make("success"),
      request: request(),
      expect: { ok: true, nativeSessionId: "fake-session-1" },
    },
    {
      ...base,
      kind: "task_failure",
      adapter: make("task_failure"),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE" },
    },
    {
      ...base,
      kind: "auth_missing",
      adapter: make("auth_missing"),
      request: request(),
      expect: { ok: false, failureCode: "AUTH_REQUIRED" },
    },
    {
      ...base,
      kind: "rate_limit",
      adapter: make("rate_limit"),
      request: request(),
      expect: { ok: false, failureCode: "RATE_LIMIT_TRANSIENT" },
    },
    {
      ...base,
      kind: "partial_mutation",
      adapter: make("partial_mutation"),
      request: request(),
      expect: { ok: false, failureCode: "TOOL_FAILURE", mutatedPath: "partial.txt" },
    },
    {
      ...base,
      kind: "malformed_output",
      adapter: make("malformed_output"),
      request: request(),
      expect: { ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" },
    },
    {
      ...base,
      kind: "timeout",
      adapter: make("hang"),
      request: request(),
      expect: { ok: false, failureCode: "PROCESS_TIMEOUT" },
    },
    {
      ...base,
      kind: "cancellation",
      adapter: make("hang_ignore_term", { idleMs: 10_000 }),
      request: request(),
      expect: { ok: false, failureCode: "CANCELLED" },
    },
    {
      ...base,
      kind: "resume",
      adapter: make("success"),
      request: request(),
      binding: { provider: "fake", nativeSessionId: "fake-session-42" },
      expect: { ok: true, nativeSessionId: "fake-session-42" },
    },
  ];
}
