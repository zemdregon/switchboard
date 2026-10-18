/**
 * T4.2 (NFR-MAINT-01, NFR-MAINT-03, FR-ADP-01, FR-ADP-02, FR-ADP-04, FR-ADP-11, FR-GIT-01, FR-GIT-02): the TDD §4.9
 * adapter-addition checklist, one named test per item, run against the T4.1 scratch adapter
 * (`./fixtures/scratch-provider.ts`). An item that does not apply to a test-only adapter as written says why in its
 * test name and in TDD §4.9. No provider CLI is run: the scratch adapter runs the bundled fake CLI or the shared replay
 * helper over SYNTHETIC fixtures.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { coverageProblems, STREAM_CATEGORIES } from "../../test/malicious/adapter-leg.js";
import scratchCase from "../../test/malicious/adapters/scratch.case.js";
import { resolveTrustProfile } from "../policy/profiles.js";
import type { PrivilegedScope } from "../policy/types.js";
import { auditInvocation } from "./audit.js";
import { missingRequiredKinds, REQUIRED_CASE_KINDS, runConformanceSuite } from "./conformance.js";
import { FAILURE_CODES } from "./failure.js";
import { modelLiteralHits } from "./fixtures/model-literals.js";
import { privilegedProfile } from "./fixtures/privileged.js";
import { REPLAY_SCRIPT } from "./fixtures/replay.js";
import {
  SCRATCH_EDIT_PROFILE,
  SCRATCH_FIXTURES,
  SCRATCH_MANIFEST_DIR,
  scratchConformanceCases,
  scratchFixturePath,
  scratchReplayAdapter,
} from "./fixtures/scratch/cases.js";
import {
  SCRATCH_BYPASS_FLAG,
  SCRATCH_BYPASS_SHORT_FLAG,
  SCRATCH_BYPASS_VALUE,
  SCRATCH_CONFIG_ID,
  SCRATCH_ID,
  SCRATCH_PROVIDER,
  ScratchAdapter,
} from "./fixtures/scratch-provider.js";
import { loadManifest, MANIFEST_DIR } from "./manifest/index.js";
import { BUILTIN_PROVIDERS, providerEntries, registerProvider } from "./providers.js";
import { AdapterRegistry } from "./registry.js";
import {
  type CompileRequest,
  createParseState,
  type ExitInfo,
  type FailureEvidence,
  type Invocation,
  isIneligible,
  type NormalizedEvent,
  type ProbeOutput,
  type ProviderId,
  type ResolvedProfile,
} from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SCRATCH_MODULE = path.join(HERE, "fixtures", "scratch-provider.ts");
const id = SCRATCH_ID as ProviderId;

const REQUEST: CompileRequest = {
  runId: "run_scratch_checklist",
  objective: "synthetic scratch objective",
  constraints: [],
  workspace: { cwd: "/work/tree", writable: true },
};
const BYPASS_SCOPE: PrivilegedScope = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "off" },
  repository_config: { mode: "disabled" },
  bypass: true,
};
const PRIV_BYPASS = privilegedProfile(BYPASS_SCOPE);
const PRIV_NO_BYPASS = privilegedProfile({ ...BYPASS_SCOPE, bypass: false });
const FIVE_PROFILES = [
  "inspect-untrusted",
  "edit-untrusted",
  "test-sandboxed",
  "trusted-development",
  "privileged",
] as const;

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
const makeCwd = () => {
  const d = mkdtempSync(path.join(tmpdir(), "sb-scratch-checklist-"));
  tmpDirs.push(d);
  return d;
};

describe("TDD §4.9 adapter-addition checklist against the T4.1 scratch adapter (T4.2)", () => {
  it("item 1, module: implements every ProviderAdapter member; its one module lives under fixtures (test-only, so excluded from the build) instead of src/adapters/<id>/, and no non-test source names it", () => {
    const a = new ScratchAdapter();
    expect(a.id).toBe(SCRATCH_ID);
    expect(a.transports).toEqual(["subprocess-jsonl"]);
    expect(a.gitWriteControl).toBeDefined();
    expect(a.gitCapabilities).toBeDefined();
    for (const m of [
      "probe",
      "authPreflight",
      "compile",
      "parseEvent",
      "extractResult",
      "resumeArgs",
      "classifyFailure",
    ] as const) {
      expect(typeof a[m], m).toBe("function");
    }
    const build = JSON.parse(readFileSync(path.join(ROOT, "tsconfig.build.json"), "utf8")) as { exclude: string[] };
    expect(build.exclude).toContain("src/**/fixtures/**");
    // NFR-MAINT-01: only tests (and the scratch fixtures themselves) import the module.
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, name.name);
        if (name.isDirectory()) {
          if (name.name !== "fixtures") walk(full);
        } else if (/\.ts$/.test(name.name) && !/\.test\.ts$/.test(name.name)) {
          if (readFileSync(full, "utf8").includes("scratch-provider")) importers.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(importers).toEqual([]);
  });

  it("item 2, manifest: a valid manifest whose range admits no version, so the gate reports ADAPTER_VERSION_UNVERIFIED; kept under fixtures, not src/adapters/manifests, because the build must not ship a manifest for a synthetic provider", () => {
    const { manifest } = loadManifest(id, SCRATCH_MANIFEST_DIR);
    expect(manifest.provider).toBe(SCRATCH_ID);
    expect(manifest.validated_version_range).toBe("<0.0.0");
    const gate = new AdapterRegistry().register(new ScratchAdapter()).gate(id, "1.0.0", SCRATCH_MANIFEST_DIR);
    expect(gate).toMatchObject({ eligible: false, code: "ADAPTER_VERSION_UNVERIFIED" });
    expect(existsSync(path.join(MANIFEST_DIR, `${SCRATCH_ID}.json`))).toBe(false);
  });

  it("item 3, probe and auth preflight: FR-ADP-02 steps 1 to 5 and smoke through the ProbeRunner only; auth names the native login, never runs it", async () => {
    const calls: (readonly string[])[] = [];
    const answer = (argv: readonly string[], authenticated: boolean): ProbeOutput => {
      calls.push(argv);
      const stdout = argv.includes("--version")
        ? "fake-cli 1.0.0\n"
        : argv.includes("--smoke")
          ? '{"type":"result","ok":true}\n'
          : JSON.stringify({ authenticated });
      return { exitCode: 0, stdout, stderr: "", timedOut: false };
    };
    const a = new ScratchAdapter();
    const probe = await a.probe(async (argv) => answer(argv, true));
    expect(probe.steps.map((s) => s.step)).toEqual(["binary", "version", "command", "output_format", "flags", "smoke"]);
    expect(probe.steps.every((s) => s.ok)).toBe(true);
    expect(await a.authPreflight(async (argv) => answer(argv, true))).toEqual({ state: "OK" });
    const out = await a.authPreflight(async (argv) => answer(argv, false));
    expect(out).toMatchObject({ state: "AUTH_REQUIRED" });
    const missing = await a.probe(async () => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      spawnError: "ENOENT",
    }));
    expect(missing.steps.find((s) => s.step === "binary")?.ok).toBe(false);
    // Every call is a probe of the binary: no login, no credential path, no model call.
    for (const argv of calls) {
      expect(argv.join(" ")).not.toMatch(/login|auth\.json|credentials|\.codex|\.claude/);
      expect(argv.some((w) => ["--version", "--smoke", "--auth-status"].includes(w))).toBe(true);
    }
  });

  it("item 4, compile matrix: pure, and each of the five profiles compiles or is Ineligible with a reason (privileged only with an approved bypass scope, never downgraded)", () => {
    const a = new ScratchAdapter();
    for (const name of FIVE_PROFILES) {
      const profile: ResolvedProfile = name === "privileged" ? PRIV_NO_BYPASS : resolveTrustProfile(name);
      const one = a.compile(REQUEST, profile);
      expect(JSON.stringify(a.compile(REQUEST, profile)), name).toBe(JSON.stringify(one));
      if (name === "privileged") {
        expect(isIneligible(one), name).toBe(true);
        if (isIneligible(one)) expect(one.detail.trim(), name).not.toBe("");
      } else {
        expect(isIneligible(one), name).toBe(false);
        if (!isIneligible(one)) expect(one.cwd).toBe(REQUEST.workspace.cwd);
      }
    }
    const unapproved = a.compile(REQUEST, PRIV_BYPASS);
    expect(isIneligible(unapproved) && unapproved.detail.trim() !== "").toBe(true);
    const approved = a.compile({ ...REQUEST, bypassApproved: true }, PRIV_BYPASS);
    expect(isIneligible(approved)).toBe(false);
    expect((approved as Invocation).argv).toContain(SCRATCH_BYPASS_FLAG);
  });

  it("item 5, stream parser and failure mapping: structured output only; unknown kinds, malformed lines, a missing result and every failure evidence never map to success", () => {
    const a = new ScratchAdapter();
    const state = createParseState();
    const parse = (line: string) => a.parseEvent(line, state);
    expect(parse('{"type":"session","session_id":"s-1"}')).toEqual([{ kind: "session_bound", nativeSessionId: "s-1" }]);
    expect(parse('{"type":"result","ok":true,"summary":"done"}')).toEqual([
      { kind: "result", ok: true, summary: "done" },
    ]);
    expect(parse('{"type":"synthetic.unknown"}')).toEqual([{ kind: "unknown", rawType: "synthetic.unknown" }]);
    expect(parse("not json at all")).toEqual([]);
    expect(parse("free text mentioning result ok true")).toEqual([]);
    const exit = (exitCode: number | null, outcome: ExitInfo["outcome"] = "exited"): ExitInfo => ({
      outcome,
      exitCode,
      signal: null,
      expectedExitCodes: [0],
    });
    const unknownOnly: NormalizedEvent[] = [{ kind: "unknown", rawType: "x" }];
    expect(a.extractResult([], exit(0)).ok).toBe(false);
    expect(a.extractResult(unknownOnly, exit(0))).toMatchObject({ ok: false, failureCode: "OUTPUT_PROTOCOL_ERROR" });
    const outcomes: ExitInfo["outcome"][] = [
      "exited",
      "crashed",
      "timeout",
      "cancelled",
      "spawn_error",
      "protocol_error",
      "internal_error",
    ];
    const eventSets: NormalizedEvent[][] = [
      [],
      unknownOnly,
      [{ kind: "provider_error", category: "never-heard-of-it", message: "?" }],
      [{ kind: "result", ok: false }],
      [{ kind: "rate_limit" }],
      [{ kind: "permission_denied", tool: "shell" }],
    ];
    for (const outcome of outcomes) {
      for (const events of eventSets) {
        for (const exitCode of [0, 1, null]) {
          const evidence: FailureEvidence = {
            events,
            exit: exit(exitCode, outcome),
            stderrTail: "",
            timedOut: outcome === "timeout",
            cancelled: outcome === "cancelled",
          };
          const c = a.classifyFailure(evidence);
          expect(FAILURE_CODES, `${outcome}/${exitCode}/${JSON.stringify(events)}`).toContain(c.code);
        }
      }
    }
  });

  it("item 6, resume: resumes its own binding with the session id, refuses another provider's with a reason, declares resumeCwd as its registry entry does (registry-wide: resume-conformance.test.ts registers it too)", () => {
    const a = new ScratchAdapter();
    const own = a.resumeArgs({ provider: id, nativeSessionId: "s-42" }, REQUEST, SCRATCH_EDIT_PROFILE);
    expect(isIneligible(own)).toBe(false);
    if (!isIneligible(own)) {
      expect(own.argv).toContain("s-42");
      expect(own.cwd).toBe(REQUEST.workspace.cwd);
    }
    for (const other of ["fake", "claude", "no-such-provider"]) {
      const r = a.resumeArgs({ provider: other as ProviderId, nativeSessionId: "s-42" }, REQUEST, SCRATCH_EDIT_PROFILE);
      expect(isIneligible(r) && r.detail.trim() !== "", other).toBe(true);
    }
    expect(["bound", "independent", "unverified"]).toContain(a.resumeCwd);
    expect(SCRATCH_PROVIDER.resumeCwd).toBe(a.resumeCwd);
    const src = readFileSync(path.join(HERE, "resume-conformance.test.ts"), "utf8");
    expect(src).toContain("registerProvider(SCRATCH_PROVIDER)");
  });

  it("item 7, replay fixtures: every scratch fixture is marked SYNTHETIC and replays through the one shared helper (no per-adapter copy)", async () => {
    expect(existsSync(path.join(HERE, "fixtures", "replay-dialects", `${SCRATCH_ID}.mjs`))).toBe(true);
    expect(readdirSync(path.join(HERE, "fixtures", "scratch"))).not.toContain("replay.mjs");
    for (const name of SCRATCH_FIXTURES) {
      const [head = ""] = readFileSync(scratchFixturePath(name), "utf8").split("\n");
      expect((JSON.parse(head) as { _fixture?: { synthetic?: boolean } })._fixture?.synthetic, name).toBe(true);
    }
    const inv = scratchReplayAdapter(scratchFixturePath("success")).compile(
      { ...REQUEST, workspace: { cwd: makeCwd(), writable: true } },
      SCRATCH_EDIT_PROFILE,
    );
    expect(isIneligible(inv)).toBe(false);
    if (!isIneligible(inv)) expect(inv.argv.slice(1, 4)).toEqual([REPLAY_SCRIPT, "--provider", SCRATCH_ID]);
  });

  it("item 8, conformance cases: cover REQUIRED_CASE_KINDS and pass runConformanceSuite with no live provider", async () => {
    const cases = scratchConformanceCases(makeCwd);
    expect(missingRequiredKinds(cases)).toEqual([]);
    expect(REQUIRED_CASE_KINDS.every((k) => cases.some((c) => c.kind === k))).toBe(true);
    const report = await runConformanceSuite(cases);
    const failed = report.cases.flatMap((c) =>
      c.checks.filter((k) => !k.ok).map((k) => `${c.kind}: ${k.name}${k.detail ? ` (${k.detail})` : ""}`),
    );
    expect(failed).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("item 9, malicious-fixture leg: test/malicious/adapters/scratch.case.ts is discovered by the leg and covers every hostile category with a blocked code (the leg replays it)", () => {
    expect(scratchCase.provider).toBe(SCRATCH_ID);
    const legDir = path.join(ROOT, "test", "malicious", "adapters");
    expect(readdirSync(legDir)).toContain(`${SCRATCH_ID}.case.ts`);
    const fx = { codexAuthPath: "/fake-home/.codex/auth.json", outsideSentinel: "/outside/sentinel" };
    const streams = scratchCase.streams(fx as Parameters<typeof scratchCase.streams>[0]);
    expect(coverageProblems(streams)).toEqual([]);
    expect(new Set(streams.map((s) => s.category))).toEqual(new Set(STREAM_CATEGORIES));
  });

  it("item 10, Git declarations: gitWriteControl none-documented and commitChannel finalize-only (fail-closed values)", () => {
    const a = new ScratchAdapter();
    expect(a.gitWriteControl.kind).toBe("none-documented");
    expect(a.gitCapabilities.commitChannel).toBe("finalize-only");
    expect(a.gitCapabilities.channelArgs).toBeUndefined();
  });

  it("item 11, bypass-class flags: long, short and value forms declared as data and refused outside an approved bypass scope; the adapter emits its flag only there", () => {
    expect(SCRATCH_PROVIDER.bypassFlags).toEqual([SCRATCH_BYPASS_FLAG]);
    expect(SCRATCH_PROVIDER.bypassShortFlags).toEqual([SCRATCH_BYPASS_SHORT_FLAG]);
    expect(SCRATCH_PROVIDER.bypassValues).toEqual([SCRATCH_BYPASS_VALUE]);
    const off = registerProvider(SCRATCH_PROVIDER);
    try {
      const base = { argv: ["/bin/scratch"], policyFlags: [] as string[] };
      const forms = [
        [SCRATCH_BYPASS_FLAG],
        [SCRATCH_BYPASS_SHORT_FLAG],
        [SCRATCH_BYPASS_VALUE.flag, SCRATCH_BYPASS_VALUE.value],
      ];
      for (const words of forms) {
        const inv = { ...base, argv: [...base.argv, ...words] };
        expect(
          auditInvocation(inv, { profile: SCRATCH_EDIT_PROFILE, bypassApproved: false }),
          words.join(" "),
        ).not.toEqual([]);
        expect(auditInvocation(inv, { profile: PRIV_BYPASS, bypassApproved: false }), words.join(" ")).not.toEqual([]);
        expect(auditInvocation(inv, { profile: PRIV_BYPASS, bypassApproved: true }), words.join(" ")).toEqual([]);
      }
      const a = new ScratchAdapter();
      for (const name of FIVE_PROFILES.slice(0, 4)) {
        const inv = a.compile({ ...REQUEST, bypassApproved: false }, resolveTrustProfile(name));
        if (!isIneligible(inv)) expect(auditInvocation(inv), name).toEqual([]);
      }
    } finally {
      off();
    }
  });

  it("item 12, registry entry: one entry with id, configId, kind, label and create, registered at runtime and kept out of BUILTIN_PROVIDERS; README login row does not apply (synthetic test adapter, not a user-facing provider), so the README names none", () => {
    expect(SCRATCH_PROVIDER).toMatchObject({ id: SCRATCH_ID, configId: SCRATCH_CONFIG_ID, kind: "real" });
    expect(SCRATCH_PROVIDER.label).toMatch(/synthetic/i);
    expect(SCRATCH_PROVIDER.create?.({})).toBeInstanceOf(ScratchAdapter);
    expect(BUILTIN_PROVIDERS.some((e) => (e.id as string) === SCRATCH_ID)).toBe(false);
    const off = registerProvider(SCRATCH_PROVIDER);
    try {
      expect(providerEntries().filter((e) => e.id === SCRATCH_ID)).toHaveLength(1);
    } finally {
      off();
    }
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8").split("\n");
    const header = readme.indexOf("| Provider | Login step the adapter reports | Status of that step |");
    expect(header).toBeGreaterThan(-1);
    const end = readme.findIndex((l, i) => i > header && !l.startsWith("|"));
    const rows = readme.slice(header + 2, end);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => /scratch/i.test(r))).toEqual([]);
  });

  it("item 13, no model names: the scratch module, dialect and manifest hold no model-like literal or context limit, and the probe lists no models (the synthetic CLI documents no listing command)", async () => {
    const files = [
      SCRATCH_MODULE,
      path.join(HERE, "fixtures", "replay-dialects", `${SCRATCH_ID}.mjs`),
      path.join(SCRATCH_MANIFEST_DIR, `${SCRATCH_ID}.json`),
      path.join(HERE, "fixtures", "scratch", "cases.ts"),
    ];
    const hits = files.flatMap((f) => modelLiteralHits(readFileSync(f, "utf8")).map((h) => `${path.basename(f)}:${h}`));
    expect(hits).toEqual([]);
    expect(modelLiteralHits('const m = "gpt-5";')).not.toEqual([]); // the detector is live
    const probe = await new ScratchAdapter().probe(async (argv) => ({
      exitCode: 0,
      stdout: argv.includes("--version") ? "fake-cli 1.0.0\n" : '{"type":"result","ok":true}\n',
      stderr: "",
      timedOut: false,
    }));
    expect(probe.modelsListed).toBeUndefined();
  });
});
