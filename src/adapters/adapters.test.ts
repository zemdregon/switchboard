import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { auditInvocation, BYPASS_FLAGS, BypassFlagError } from "./audit.js";
import { missingRequiredKinds, runConformanceCase, runConformanceSuite } from "./conformance.js";
import { FakeAdapter } from "./fake/adapter.js";
import { FAKE_PROFILE, fakeConformanceCases } from "./fake/cases.js";
import { AdapterRegistry } from "./registry.js";
import { createProbeRunner, startAdapterRun } from "./run.js";
import { type Invocation, isIneligible } from "./types.js";

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
