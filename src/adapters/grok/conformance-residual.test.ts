/**
 * T4.22 conformance residual (2026-10-16, Delegated agent work, not owner-approved; synthetic fixtures only, no `grok`
 * run, adapter and parser unchanged). The suite in grok.test.ts shows each case passes and the T4.23 parser residuals
 * (parser-residual.test.ts) pin line shapes; these tests pin how the compiled argv, resume and the shared replay
 * interact: which compile slips a conformance case catches (exit 64 or 65, a wrong resume id), which it cannot (the
 * replay's grok dialect does not check the sandbox profile, `--disable-web-search` or a `--deny` rule), which inputs
 * the compile accepts without refusing, and where the adapter and the run path read a bypass approval differently.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveTrustProfile } from "../../policy/profiles.js";
import { BypassFlagError } from "../audit.js";
import {
  type ConformanceCase,
  checkAdapterStatics,
  checkExpectation,
  runConformanceCase,
  runConformanceSuite,
} from "../conformance.js";
import { privilegedProfile } from "../fixtures/privileged.js";
import { startAdapterRun } from "../run.js";
import type { CompileRequest, Invocation, ResolvedProfile, TrustProfile } from "../types.js";
import { GROK_BYPASS_OUTSIDE_PRIVILEGED, GrokAdapter } from "./adapter.js";
import {
  BYPASS_SCOPE,
  DEFAULT_SESSION_ID,
  grokConformanceCases,
  PRIVILEGED_BYPASS_PROFILE,
  RESUMED_SESSION_ID,
  replayAdapter,
} from "./fixtures/cases.js";
import { NON_PRIVILEGED_UNSUPPORTED_DETAIL } from "./protocol.js";

const dirs: string[] = [];
const makeCwd = () => {
  const d = mkdtempSync(join(tmpdir(), "sb-grok-conf-residual-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Edit = (argv: string[]) => string[];
/**
 * `c` with the argv (and policy flags) of both `compile` and `resumeArgs` rewritten by `edit`. A Proxy that binds every
 * other member to the real adapter: an `Object.create` copy cannot reach the adapter's `#` members, so every replayed
 * `end` line would throw in `parseEvent` and end the run "event handling failed" whatever the edit (see the last test).
 */
const editedBy = (c: ConformanceCase, edit: Edit): ConformanceCase => {
  const a = c.adapter as GrokAdapter;
  const fix = (inv: Invocation | ReturnType<GrokAdapter["compile"]>) =>
    "ineligible" in inv ? inv : ({ ...inv, argv: edit(inv.argv), policyFlags: edit(inv.policyFlags) } as Invocation);
  const adapter = new Proxy(a, {
    get(target, key) {
      if (key === "compile") return (...args: Parameters<GrokAdapter["compile"]>) => fix(target.compile(...args));
      if (key === "resumeArgs") {
        return (...args: Parameters<GrokAdapter["resumeArgs"]>) => fix(target.resumeArgs(...args));
      }
      const v: unknown = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ...c, adapter };
};
const cases = () => grokConformanceCases(makeCwd);
const caseOf = (kind: ConformanceCase["kind"]): ConformanceCase => {
  const c = cases().find((x) => x.kind === kind);
  if (!c) throw new Error(`missing ${kind} case`);
  return c;
};
const failing = (checks: { name: string; ok: boolean }[]) => checks.filter((k) => !k.ok).map((k) => k.name);

describe("grok conformance cases fail when the replay refuses the compile (T4.22, T4.25, FR-ADP-11)", () => {
  it.each([
    ["exit code 64", "--no-auto-update removed", (argv: string[]) => argv.filter((w) => w !== "--no-auto-update")],
    ["exit code 64", "the refused `-p` short form added", (argv: string[]) => [...argv, "-p", "x"]],
    [
      "exit code 65",
      "an empty `--single=` prompt",
      (argv: string[]) => argv.map((w) => (w.startsWith("--single=") ? "--single=" : w)),
    ],
  ])("every runnable case fails a compile the replay ends with %s (%s)", async (detail, _name, edit) => {
    const passing: string[] = [];
    // Not the timeout case: its 400 ms idle budget can fire before a loaded replay exits, so under CPU contention a
    // refused compile ends PROCESS_TIMEOUT and would satisfy it (a load-dependent residual, not pinned here).
    for (const c of cases().filter((x) => x.kind !== "timeout")) {
      const report = await runConformanceCase(editedBy(c, edit));
      expect(report.result, c.kind).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: detail });
      if (report.ok) passing.push(c.kind);
    }
    expect(passing).toEqual([]);
  });

  it("task_failure names its session id and stopReason, so a refused compile's bare TOOL_FAILURE no longer satisfies it", async () => {
    const c = caseOf("task_failure");
    expect(c.expect).toEqual({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "stopReason cancelled",
      nativeSessionId: DEFAULT_SESSION_ID,
    });
    const refused = await runConformanceCase(editedBy(c, (argv) => argv.filter((w) => w !== "--no-auto-update")));
    const result = refused.result;
    if (result === undefined) throw new Error("no result");
    expect(failing(checkExpectation(c.expect, result, c.request.workspace.cwd))).toEqual([
      "failure detail matches",
      "native session id",
    ]);
    // Before this pass the case named only ok and code, and that expectation passes the refused run.
    expect(
      failing(checkExpectation({ ok: false, failureCode: "TOOL_FAILURE" }, result, c.request.workspace.cwd)),
    ).toEqual([]);
    // The tightened case still passes its own fixture, with the whole suite.
    expect((await runConformanceSuite(cases())).ok).toBe(true);
  });

  it("a resume compiled as `--resume <id>` fails only the resume case: the replay reads `-r`, the others replay as usual", async () => {
    const edit: Edit = (argv) => argv.map((w) => (w === "-r" ? "--resume" : w));
    const report = await runConformanceSuite(cases().map((c) => editedBy(c, edit)));
    expect(report.cases.filter((r) => !r.ok).map((r) => r.kind)).toEqual(["resume"]);
    expect(report.cases.find((r) => r.kind === "resume")?.result).toMatchObject({
      ok: false,
      failureCode: "TOOL_FAILURE",
      failureDetail: "exit code 64",
    });
  });

  it("a resume compiled with another id than the binding succeeds, and only the harness's native session id check fails it", async () => {
    const other = "00000000-0000-4000-8000-000000000077";
    const edit: Edit = (argv) => argv.map((w, i) => (argv[i - 1] === "-r" ? other : w));
    const report = await runConformanceCase(editedBy(caseOf("resume"), edit));
    expect(report.result).toMatchObject({ ok: true, nativeSessionId: other });
    expect(failing(report.checks)).toEqual(["native session id"]);
    expect(caseOf("resume").expect.nativeSessionId).toBe(RESUMED_SESSION_ID);
  });
});

describe("grok replay blind spots: argv slips the grok dialect accepts (T4.22 gap pins; unit argv tests are the only guard)", () => {
  it.each([
    [
      "the sandbox profile swapped from strict to workspace",
      (argv: string[]) => argv.map((w) => (w === "strict" ? "workspace" : w)),
    ],
    [
      "--disable-web-search dropped with network off",
      (argv: string[]) => argv.filter((w) => w !== "--disable-web-search"),
    ],
    [
      "a --deny prefix rule added (the dialect refuses --allow only)",
      (argv: string[]) => [...argv, "--deny", "Bash(git commit*)"],
    ],
  ])("pins the gap: %s still passes every conformance case", async (_name, edit) => {
    const report = await runConformanceSuite(cases().map((c) => editedBy(c, edit)));
    expect(report.cases.filter((r) => !r.ok).map((r) => r.kind)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("the compile those slips start from: `--sandbox strict --disable-web-search --always-approve` and no --deny", () => {
    const c = caseOf("success");
    const inv = c.adapter.compile(c.request, c.profile);
    if ("ineligible" in inv) throw new Error(inv.detail);
    expect(inv.policyFlags).toEqual(["--sandbox", "strict", "--disable-web-search", "--always-approve"]);
    expect(inv.argv.slice(-inv.policyFlags.length)).toEqual(inv.policyFlags);
    expect(inv.argv).not.toContain("--deny");
  });
});

describe("grok compile inputs the adapter does not refuse (T4.22 gap pins; adapter unchanged)", () => {
  const EXE = "/opt/synthetic/grok";
  const adapter = () => new GrokAdapter({ executable: EXE });
  const approved: ResolvedProfile = { ...PRIVILEGED_BYPASS_PROFILE, bypassApproved: true };
  const req = (over: Partial<CompileRequest> = {}): CompileRequest => ({
    runId: "run_grok_conf_residual",
    objective: "synthetic grok objective",
    constraints: [],
    workspace: { cwd: "/work/tree", writable: true },
    bypassApproved: true,
    ...over,
  });

  it("pins the gap: an empty or blank objective compiles to `--single=`, and only the replay refuses it (exit 65)", async () => {
    for (const objective of ["", "   ", "\n"]) {
      const inv = adapter().compile(req({ objective }), approved);
      expect("ineligible" in inv, JSON.stringify(objective)).toBe(false);
      if (!("ineligible" in inv)) expect(inv.argv).toContain(`--single=${objective}`);
      const resumed = adapter().resumeArgs(
        { provider: "grok", nativeSessionId: RESUMED_SESSION_ID },
        req({ objective }),
        approved,
      );
      expect("ineligible" in resumed, JSON.stringify(objective)).toBe(false);
    }
    const c = caseOf("success");
    const report = await runConformanceCase({ ...c, request: { ...c.request, objective: " " } });
    expect(report.result).toMatchObject({ ok: false, failureCode: "TOOL_FAILURE", failureDetail: "exit code 65" });
  });

  it("pins the gap: constraints never reach Grok Build; compile and resume ignore them (Claude appends them to its prompt)", () => {
    const plain = adapter().compile(req(), approved);
    const constrained = adapter().compile(req({ constraints: ["do not touch src/", "--yolo"] }), approved);
    expect(constrained).toEqual(plain);
    const binding = { provider: "grok" as const, nativeSessionId: RESUMED_SESSION_ID };
    expect(adapter().resumeArgs(binding, req({ constraints: ["x"] }), approved)).toEqual(
      adapter().resumeArgs(binding, req(), approved),
    );
  });

  it("the prompt word splits at the first `=` only: an objective that is itself `--single=…` replays verbatim", async () => {
    const objective = "--single=a=b -r other";
    const inv = adapter().compile(req({ objective }), approved);
    if ("ineligible" in inv) throw new Error(inv.detail);
    expect(inv.argv.filter((w) => w.startsWith("--single="))).toEqual([`--single=${objective}`]);
    expect(inv.argv).not.toContain("-r");
    const c = caseOf("success");
    const report = await runConformanceCase({ ...c, request: { ...c.request, objective } });
    expect(report.ok).toBe(true);
  });
});

describe("grok bypass approval sources and profile names (T4.22, FR-POL-03, ADR-0017)", () => {
  const EXE = "/opt/synthetic/grok";
  const adapter = () => new GrokAdapter({ executable: EXE });
  const req = (bypassApproved: boolean): CompileRequest => ({
    runId: "run_grok_conf_residual",
    objective: "synthetic grok objective",
    constraints: [],
    workspace: { cwd: "/work/tree", writable: true },
    bypassApproved,
  });
  const binding = { provider: "grok" as const, nativeSessionId: RESUMED_SESSION_ID };

  it("the adapter takes the approval from the profile or the request: either alone compiles the same invocation", () => {
    const fromProfile = adapter().compile(req(false), { ...PRIVILEGED_BYPASS_PROFILE, bypassApproved: true });
    const fromRequest = adapter().compile(req(true), { ...PRIVILEGED_BYPASS_PROFILE, bypassApproved: false });
    expect("ineligible" in fromProfile).toBe(false);
    expect(fromProfile).toEqual(fromRequest);
    expect(adapter().resumeArgs(binding, req(false), { ...PRIVILEGED_BYPASS_PROFILE, bypassApproved: true })).toEqual(
      adapter().resumeArgs(binding, req(true), { ...PRIVILEGED_BYPASS_PROFILE, bypassApproved: false }),
    );
  });

  it("pins the gap: a profile-only approval compiles, but the run path reads the request's and refuses to spawn (fail closed)", () => {
    const c = caseOf("success");
    const profileOnly: ConformanceCase = {
      ...c,
      request: { ...c.request, bypassApproved: false },
      profile: { ...PRIVILEGED_BYPASS_PROFILE, bypassApproved: true },
    };
    const inv = c.adapter.compile(profileOnly.request, profileOnly.profile);
    if ("ineligible" in inv) throw new Error(inv.detail);
    expect(inv.policyFlags).toContain("--always-approve");
    // The harness's static check and the run's audit both take bypassApproved from the request.
    expect(failing(checkAdapterStatics(profileOnly))).toEqual([
      "no refused bypass flags in argv/policyFlags",
      "no bypass flag without bypassApproved",
    ]);
    expect(() => startAdapterRun(c.adapter, inv, { profile: profileOnly.profile, bypassApproved: false })).toThrow(
      BypassFlagError,
    );
  });

  const NON_PRIVILEGED: TrustProfile[] = [
    "inspect-untrusted",
    "edit-untrusted",
    "test-sandboxed",
    "trusted-development",
  ];

  it.each(NON_PRIVILEGED)(
    "%s: an approval from either source is refused with the exact outside-privileged detail",
    (name) => {
      const outside = { ineligible: true, reason: "PROFILE_UNSUPPORTED", detail: GROK_BYPASS_OUTSIDE_PRIVILEGED };
      const base = resolveTrustProfile(name);
      expect(adapter().compile(req(true), base)).toEqual(outside);
      expect(adapter().compile(req(false), { ...base, bypassApproved: true })).toEqual(outside);
      expect(adapter().resumeArgs(binding, req(true), base)).toEqual(outside);
      expect(adapter().compile(req(false), base)).toEqual({
        ineligible: true,
        reason: "PROFILE_UNSUPPORTED",
        detail: `${name}: ${NON_PRIVILEGED_UNSUPPORTED_DETAIL}`,
      });
    },
  );

  it.each(NON_PRIVILEGED)(
    "%s carrying an approved bypass scope binding is still refused: the profile name decides",
    (name) => {
      const scope = privilegedProfile(BYPASS_SCOPE).privilegedScope;
      if (scope === undefined) throw new Error("no scope binding");
      const borrowed: ResolvedProfile = {
        ...resolveTrustProfile(name),
        privilegedScope: scope,
        bypassApproved: true,
      };
      expect(borrowed.privilegedScope?.scope.bypass).toBe(true);
      for (const r of [adapter().compile(req(true), borrowed), adapter().resumeArgs(binding, req(true), borrowed)]) {
        expect(r).toEqual({ ineligible: true, reason: "PROFILE_UNSUPPORTED", detail: GROK_BYPASS_OUTSIDE_PRIVILEGED });
      }
    },
  );
});

describe("grok conformance helper shape (T4.22 test-quality pin)", () => {
  it("an `Object.create` copy of the adapter ends every replayed run `event handling failed`, so a refusal test built on one must also check the exit-code detail", async () => {
    const c = caseOf("success");
    const a = c.adapter as GrokAdapter;
    const copy: GrokAdapter = Object.create(a);
    copy.compile = (r, p) => a.compile(r, p); // the argv is unchanged: the replay accepts it
    const report = await runConformanceCase({ ...c, adapter: copy });
    expect(report.result).toMatchObject({
      ok: false,
      failureCode: "OUTPUT_PROTOCOL_ERROR",
      failureDetail: "event handling failed",
    });
    // The Proxy used above keeps the private members reachable, so the same unchanged argv passes.
    expect((await runConformanceCase(editedBy(c, (argv) => argv))).ok).toBe(true);
    expect(replayAdapter("success_edit")).toBeInstanceOf(GrokAdapter);
  });
});
