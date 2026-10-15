import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveTrustProfile } from "../policy/profiles.js";
import {
  assertBypassAudit,
  auditInvocation,
  BYPASS_FLAGS,
  type BypassContext,
  BypassFlagError,
  bypassPermitted,
  findBypassFlags,
} from "./audit.js";
import { checkExpectation, missingRequiredKinds, runConformanceCase, runConformanceSuite } from "./conformance.js";
import { FakeAdapter } from "./fake/adapter.js";
import { FAKE_PROFILE, fakeConformanceCases } from "./fake/cases.js";
import { LOOSE_SCOPE, privilegedProfile } from "./fixtures/privileged.js";
import { AdapterRegistry } from "./registry.js";
import { createProbeRunner, startAdapterRun } from "./run.js";
import { type Invocation, isIneligible, type ResolvedProfile } from "./types.js";

const dirs: string[] = [];
const makeCwd = () => {
  const d = mkdtempSync(join(tmpdir(), "sb-fake-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("fake adapter scenarios through the supervisor", () => {
  const cases = fakeConformanceCases(makeCwd);
  const byKind = (k: string) => {
    const c = cases.find((x) => x.kind === k);
    if (!c) throw new Error(`no case ${k}`);
    return c;
  };

  for (const [kind, code] of [
    ["task_failure", "TOOL_FAILURE"],
    ["auth_missing", "AUTH_REQUIRED"],
    ["rate_limit", "RATE_LIMIT_TRANSIENT"],
    ["partial_mutation", "TOOL_FAILURE"],
    ["malformed_output", "OUTPUT_PROTOCOL_ERROR"],
    ["timeout", "PROCESS_TIMEOUT"],
    ["cancellation", "CANCELLED"],
  ] as const) {
    it(`${kind} -> ${code}`, async () => {
      const report = await runConformanceCase(byKind(kind));
      expect(report.checks.filter((c) => !c.ok)).toEqual([]);
      expect(report.result?.failureCode).toBe(code);
    });
  }

  it("success normalizes session, summary and counts unknown events", async () => {
    const report = await runConformanceCase(byKind("success"));
    expect(report.result).toMatchObject({ ok: true, nativeSessionId: "fake-session-1", summary: "completed" });
    expect(report.result?.unknownEventCount).toBe(1);
  });

  it("partial mutation leaves the file in the cwd", async () => {
    const c = byKind("partial_mutation");
    await runConformanceCase(c);
    expect(readFileSync(join(c.request.workspace.cwd, "partial.txt"), "utf8")).toBe("half-written\n");
  });

  it("hang that ignores SIGTERM is cancelled with the group gone", async () => {
    const report = await runConformanceCase(byKind("cancellation"));
    expect(report.checks.find((c) => c.name === "process group empty after run")?.ok).toBe(true);
  });
});

describe("conformance harness", () => {
  it("fake adapter passes the full suite and covers the FR-ADP-11 kinds", async () => {
    const cases = fakeConformanceCases(makeCwd);
    expect(missingRequiredKinds(cases)).toEqual([]);
    const report = await runConformanceSuite(cases);
    const failing = report.cases.flatMap((c) => c.checks.filter((k) => !k.ok).map((k) => `${c.kind}: ${k.name}`));
    expect(failing).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("detects a non-conforming adapter", async () => {
    const cases = fakeConformanceCases(makeCwd);
    const c = cases.find((x) => x.kind === "task_failure");
    if (!c) throw new Error("missing");
    const report = await runConformanceCase({ ...c, expect: { ok: true } });
    expect(report.ok).toBe(false);
  });

  it("checks failureDetail only when the case sets it", async () => {
    const c = fakeConformanceCases(makeCwd).find((x) => x.kind === "task_failure");
    if (!c) throw new Error("missing");
    const unset = await runConformanceCase(c);
    expect(unset.checks.map((k) => k.name)).not.toContain("failure detail matches");
    const detail = unset.result?.failureDetail;
    if (detail === undefined) throw new Error("fake task_failure has no failureDetail");
    const same = await runConformanceCase({ ...c, expect: { ...c.expect, failureDetail: detail } });
    expect(same.checks.find((k) => k.name === "failure detail matches")?.ok).toBe(true);
    expect(same.ok).toBe(true);
    const other = await runConformanceCase({ ...c, expect: { ...c.expect, failureDetail: "exit code 64" } });
    expect(other.checks.find((k) => k.name === "failure detail matches")).toMatchObject({ ok: false, detail });
    expect(other.ok).toBe(false);
  });

  it("checks a null session id, the summary and the unknown event count only when the expectation sets them", () => {
    const cwd = makeCwd();
    const bound = { ok: true, nativeSessionId: "s-1", summary: "done", unknownEventCount: 2 };
    const unbound = { ok: true, unknownEventCount: 0 };
    const failed = (exp: Parameters<typeof checkExpectation>[0], r: Parameters<typeof checkExpectation>[1]) =>
      checkExpectation(exp, r, cwd)
        .filter((k) => !k.ok)
        .map((k) => k.name);
    expect(checkExpectation({ ok: true }, bound, cwd).map((k) => k.name)).toEqual([
      "result.ok matches",
      "failure code matches",
    ]);
    const pinned = { ok: true, nativeSessionId: "s-1", summary: "done", unknownEventCount: 2 };
    expect(failed(pinned, bound)).toEqual([]);
    expect(failed(pinned, unbound)).toEqual(["native session id", "summary matches", "unknown event count matches"]);
    // `null` pins absence: a run that binds a session or carries a summary fails it.
    const none = { ok: true, nativeSessionId: null, summary: null, unknownEventCount: 0 };
    expect(failed(none, unbound)).toEqual([]);
    expect(failed(none, bound)).toEqual(["native session id", "summary matches", "unknown event count matches"]);
  });
});

describe("probe and auth preflight", () => {
  const runner = createProbeRunner();
  it("probe reports version and smoke", async () => {
    const r = await new FakeAdapter().probe(runner);
    expect(r.binaryVersion).toBe("1.0.0");
    expect(r.steps.every((s) => s.ok)).toBe(true);
  });
  it("probe fails cleanly when the binary is missing", async () => {
    const r = await new FakeAdapter({ executable: "/nonexistent/fake-bin" }).probe(runner);
    expect(r.binaryVersion).toBeNull();
    expect(r.steps[0]?.ok).toBe(false);
  });
  it("authPreflight OK and AUTH_REQUIRED", async () => {
    expect(await new FakeAdapter().authPreflight(runner)).toEqual({ state: "OK" });
    expect(await new FakeAdapter({ scenario: "auth_missing" }).authPreflight(runner)).toMatchObject({
      state: "AUTH_REQUIRED",
    });
  });
});

describe("compile and policy", () => {
  const request = { runId: "r", objective: "x", constraints: [], workspace: { cwd: "/tmp", writable: true } };
  it("compiled argv contains no bypass flags", () => {
    const adapter = new FakeAdapter();
    for (const inv of [
      adapter.compile(request, FAKE_PROFILE),
      adapter.resumeArgs({ provider: "fake", nativeSessionId: "s" }, request, FAKE_PROFILE),
    ]) {
      if (isIneligible(inv)) throw new Error("ineligible");
      for (const arg of [...inv.argv, ...inv.policyFlags]) {
        expect(BYPASS_FLAGS.some((f) => arg === f || arg.startsWith(`${f}=`))).toBe(false);
      }
      expect(auditInvocation(inv)).toEqual([]);
    }
  });
  it("privileged profile is Ineligible, not downgraded", () => {
    const r = new FakeAdapter().compile(request, { ...FAKE_PROFILE, name: "privileged", bypassApproved: true });
    expect(r).toMatchObject({ ineligible: true, reason: "PROFILE_UNSUPPORTED" });
  });
  it("audit catches bypass flags and the runner refuses to spawn", () => {
    for (const f of BYPASS_FLAGS) expect(auditInvocation({ argv: ["x", `${f}=1`], policyFlags: [] })).toEqual([f]);
    const inv = new FakeAdapter().compile(request, FAKE_PROFILE) as Invocation;
    const bad = { ...inv, argv: [...inv.argv, "--yolo"] };
    expect(() => startAdapterRun(new FakeAdapter(), bad)).toThrow(BypassFlagError);
  });
});

describe("bypass audit gate (T3.17; FR-POL-03, owner decision 13, ADR-0017)", () => {
  const request = { runId: "r", objective: "x", constraints: [], workspace: { cwd: "/tmp", writable: true } };
  const fakeInv = () => new FakeAdapter().compile(request, FAKE_PROFILE) as Invocation;
  const PRIV_BYPASS = privilegedProfile({ ...LOOSE_SCOPE, bypass: true });
  const PRIV_NO_BYPASS = privilegedProfile(LOOSE_SCOPE);
  const profiles: Array<[string, Pick<ResolvedProfile, "name" | "privilegedScope">]> = [
    ["inspect-untrusted", resolveTrustProfile("inspect-untrusted")],
    ["edit-untrusted", resolveTrustProfile("edit-untrusted")],
    ["test-sandboxed", resolveTrustProfile("test-sandboxed")],
    ["trusted-development", resolveTrustProfile("trusted-development")],
    ["privileged, scope bypass false", PRIV_NO_BYPASS],
    ["privileged, scope bypass true", PRIV_BYPASS],
    ["privileged, no scope binding", { name: "privileged" }],
    // A non-privileged profile carrying a bypass scope is still refused: the profile name is checked first.
    ["edit-untrusted carrying a bypass scope", { ...PRIV_BYPASS, name: "edit-untrusted" }],
  ];

  // The full positive/negative matrix: profile x bypassApproved x each BYPASS_FLAGS entry (bare and `=value`).
  for (const [label, profile] of profiles) {
    for (const bypassApproved of [false, true]) {
      const ctx: BypassContext = { profile, bypassApproved };
      const allowed = label === "privileged, scope bypass true" && bypassApproved;
      it(`${label}, bypassApproved=${bypassApproved}: bypass flags ${allowed ? "admitted" : "refused before spawn"}`, () => {
        expect(bypassPermitted(ctx)).toBe(allowed);
        for (const f of BYPASS_FLAGS) {
          for (const arg of [f, `${f}=1`]) {
            const inv = { ...fakeInv(), argv: [...fakeInv().argv, arg] };
            expect(findBypassFlags(inv)).toEqual([f]);
            expect(auditInvocation(inv, ctx)).toEqual(allowed ? [] : [f]);
            if (allowed) expect(() => assertBypassAudit(inv, ctx)).not.toThrow();
            else {
              expect(() => assertBypassAudit(inv, ctx)).toThrow(BypassFlagError);
              // startAdapterRun throws before any process exists.
              expect(() => startAdapterRun(new FakeAdapter(), inv, { profile, bypassApproved })).toThrow(
                BypassFlagError,
              );
            }
          }
        }
        // A flag in policyFlags only is audited the same way.
        const viaPolicy = { ...fakeInv(), policyFlags: ["--yolo"] };
        expect(auditInvocation(viaPolicy, ctx)).toEqual(allowed ? [] : ["--yolo"]);
      });
    }
  }

  it("without a context every bypass flag is refused, bypassApproved alone admits nothing", () => {
    const inv = { ...fakeInv(), argv: [...fakeInv().argv, "--dangerously-skip-permissions"] };
    expect(bypassPermitted(undefined)).toBe(false);
    expect(auditInvocation(inv)).toEqual(["--dangerously-skip-permissions"]);
    expect(() => startAdapterRun(new FakeAdapter(), inv)).toThrow(BypassFlagError);
    expect(() => startAdapterRun(new FakeAdapter(), inv, { bypassApproved: true })).toThrow(BypassFlagError);
    expect(() => startAdapterRun(new FakeAdapter(), inv, { bypassApproved: false, profile: PRIV_BYPASS })).toThrow(
      BypassFlagError,
    );
    expect(() => startAdapterRun(new FakeAdapter(), inv, { bypassApproved: true, profile: PRIV_NO_BYPASS })).toThrow(
      BypassFlagError,
    );
  });

  it("an invocation with no bypass flag passes the audit in every context", () => {
    for (const [, profile] of profiles)
      for (const bypassApproved of [false, true])
        expect(auditInvocation(fakeInv(), { profile, bypassApproved })).toEqual([]);
    expect(auditInvocation(fakeInv())).toEqual([]);
  });

  it("the approved, bypass-true case spawns (fake CLI) and leaves no process behind", async () => {
    const inv = { ...fakeInv(), argv: [...fakeInv().argv, "--dangerously-skip-permissions"] };
    const run = startAdapterRun(new FakeAdapter(), inv, { profile: PRIV_BYPASS, bypassApproved: true });
    const out = await run.done;
    expect(out.groupEmpty).toBe(true);
  });
});

describe("registry", () => {
  it("registers, gets, lists and rejects duplicates", () => {
    const reg = new AdapterRegistry();
    const a = new FakeAdapter();
    reg.register(a);
    expect(reg.get("fake")).toBe(a);
    expect(reg.has("claude")).toBe(false);
    expect(reg.list()).toEqual([a]);
    expect(() => reg.register(new FakeAdapter())).toThrow(/already registered/);
  });
});
