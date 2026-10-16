import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScenario } from "../adapters/fake/adapter.js";
import {
  AdapterRegistry,
  bypassClassFlags,
  type CompileRequest,
  type Ineligible,
  type Invocation,
  type ProbeRunner,
  type ProviderAdapter,
  type ResolvedProfile,
} from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import type { CliIo } from "../cli/io.js";
import { main } from "../cli/main.js";
import { groupAlive } from "../exec/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunState, type TrustProfile } from "../ledger/index.js";
import { canonicalScopeJson, parsePrivilegedScope, privilegedScopeHash } from "../policy/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import {
  ApprovalRefusedError,
  assertTransition,
  bypassApprovedFor,
  evaluateBypass,
  IllegalTransitionError,
  LifecycleError,
  RUN_STATES,
  RunLifecycle,
  type RunLifecycleOptions,
  requestHash,
  TERMINAL_STATES,
  TRANSITIONS,
  type TransitionNotice,
} from "./index.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

// Only the deliberate hang scenarios need short timeouts. Every other scenario gets generous ones so a slow
// child start under CPU contention (parallel test files, shared CI runners) is not mistaken for a hang.
const SHORT = { wallClockMs: 15_000, idleMs: 5_000, killGraceMs: 300 };
const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

/** Fake CLI variant that edits the worktree and succeeds, so the diff artifact is non-empty. */
const WRITER_CLI = `
import { writeFileSync } from "node:fs";
const a = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (a.includes("--version")) process.stdout.write("fake-cli 1.0.0\\n");
else if (a.includes("--auth-status")) process.stdout.write('{"authenticated":true}\\n');
else if (a.includes("--smoke")) emit({ type: "result", ok: true, summary: "smoke" });
else {
  emit({ type: "session", session_id: "writer-1" });
  writeFileSync("feature.txt", "new feature\\n");
  emit({ type: "tool", tool: "edit", name: "write_file", target: "feature.txt" });
  emit({ type: "result", ok: true, summary: "wrote feature" });
}
`;

/** Same as WRITER_CLI but the provider also reports usage (T2.5). */
const USAGE_WRITER_CLI = WRITER_CLI.replace(
  'emit({ type: "tool"',
  'emit({ type: "usage", input_tokens: 7, output_tokens: 2 });\n  emit({ type: "tool"',
);

type Scenario = FakeScenario | "writer" | "writer-usage";

/**
 * Test adapter: the objective names the scenario for that run, so one registered `fake` adapter can play several
 * runs. Hooks let tests act at precise lifecycle points (cancel during PREFLIGHT or LEASED, compile errors).
 */
class ScenarioAdapter implements ProviderAdapter {
  readonly id = "fake" as const;
  readonly transports = ["subprocess-jsonl"] as const;
  readonly gitWriteControl = new FakeAdapter().gitWriteControl;
  readonly resumeCwd = "bound" as const;
  /** No injected tool channel: these tests cover the lifecycle without COMP-GIT (T9.4 has its own tests). */
  readonly gitCapabilities = { commitChannel: "none", detail: "test double" } as const;
  probeGate: Promise<void> | undefined;
  authScenario: FakeScenario = "success";
  onCompile: ((req: CompileRequest) => void) | undefined;
  /** Every profile `compile` received (to check what dispatch hands the adapter). */
  readonly compiledProfiles: ResolvedProfile[] = [];
  /**
   * Test double for the T3.5/T3.6 privileged compile: when set, a `privileged` profile compiles as this profile (the
   * fake CLI has no privileged mode). Unset, the fake adapter refuses `privileged` (PROFILE_UNSUPPORTED).
   */
  privilegedAs: TrustProfile | undefined;
  compileOverride: ((req: CompileRequest, inv: Invocation) => Invocation | Ineligible) | undefined;
  private readonly base = new FakeAdapter({ timeouts: PATIENT });

  constructor(
    private readonly writerScript: string,
    private readonly usageScript = writerScript,
  ) {}

  private forScenario(s: Scenario): FakeAdapter {
    if (s === "writer-usage") return new FakeAdapter({ script: this.usageScript, timeouts: PATIENT });
    if (s === "writer") return new FakeAdapter({ script: this.writerScript, timeouts: PATIENT });
    return new FakeAdapter({ scenario: s, timeouts: s.startsWith("hang") ? SHORT : PATIENT });
  }

  async probe(runner: ProbeRunner) {
    probes++;
    if (this.probeGate) await this.probeGate;
    return this.base.probe(runner);
  }
  authPreflight(runner: ProbeRunner) {
    return new FakeAdapter({ scenario: this.authScenario }).authPreflight(runner);
  }
  compile(req: CompileRequest, profile: ResolvedProfile) {
    compiles++;
    this.onCompile?.(req);
    this.compiledProfiles.push(profile);
    const effective = profile.name === "privileged" && this.privilegedAs ? profileFor(this.privilegedAs) : profile;
    const inv = this.forScenario(req.objective as Scenario).compile(req, effective);
    if (this.compileOverride && !("ineligible" in inv)) return this.compileOverride(req, inv);
    return inv;
  }
  parseEvent: ProviderAdapter["parseEvent"] = (i, s) => this.base.parseEvent(i, s);
  extractResult: ProviderAdapter["extractResult"] = (e, x) => this.base.extractResult(e, x);
  resumeArgs: ProviderAdapter["resumeArgs"] = (b, r, p) =>
    this.base.resumeArgs(b, r, p.name === "privileged" && this.privilegedAs ? profileFor(this.privilegedAs) : p);
  classifyFailure: ProviderAdapter["classifyFailure"] = (e) => this.base.classifyFailure(e);
}

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let adapter: ScenarioAdapter;
let lifecycle: RunLifecycle;
let notices: TransitionNotice[];
/** Adapter calls in this test (the privileged safety boundary: none for a privileged run). */
let compiles = 0;
let probes = 0;

function makeLifecycle(over: Partial<RunLifecycleOptions> = {}): RunLifecycle {
  const ids = createIdGenerator();
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  return new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(adapter),
    allowedRoots: [root],
    globalConcurrency: 4,
    resolveProfile: profileFor,
    onTransition: (n) => notices.push(n),
    ...over,
  });
}

const submit = (objective: Scenario | string, extra: Record<string, unknown> = {}) =>
  lifecycle.submit({
    clientId: "client-a",
    objective,
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    ...extra,
  });

/** A valid structured privileged scope (LLD §3.1). */
const SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "allowlist", allowlist: [["npm", "test"]] },
  network: { mode: "allowlist", hosts: ["registry.npmjs.org"] },
  repository_config: { mode: "approved" },
  bypass: true,
};
/** Stand-in for T3.4's `approve`: the FRD T3 edge written directly (tests only). */
const approveDirect = (runId: string) => {
  const run = ledger.getRunRecord(runId);
  if (!run) throw new Error("no run");
  ledger.casRunState({
    runId,
    from: "AWAITING_APPROVAL",
    to: "QUEUED",
    expectedVersion: run.version,
    payload: { rule: "T3" },
  });
  notices.push({ runId, from: "AWAITING_APPROVAL", to: "QUEUED", rule: "T3" });
};

const path_ = (runId: string) =>
  notices
    .filter((n) => n.runId === runId)
    .map((n) => n.to)
    .join(">");
const rules = (runId: string) => notices.filter((n) => n.runId === runId).map((n) => n.rule);
const events = (runId: string) => ledger.listRunEvents(runId).map((e) => ({ ...e, p: JSON.parse(e.payload_json) }));
const sessionRow = (id: string) =>
  db.prepare("SELECT head_commit, lease_run_id FROM meta_session WHERE id = ?").get(id) as {
    head_commit: string | null;
    lease_run_id: string | null;
  };
const artifactKinds = (runId: string) =>
  (db.prepare("SELECT kind FROM artifact WHERE run_id = ? ORDER BY kind").all(runId) as { kind: string }[]).map(
    (r) => r.kind,
  );
const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(() => {
  compiles = 0;
  probes = 0;
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-life-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  const writer = path.join(root, "writer-cli.mjs");
  writeFileSync(writer, WRITER_CLI);
  const usageWriter = path.join(root, "usage-writer-cli.mjs");
  writeFileSync(usageWriter, USAGE_WRITER_CLI);
  adapter = new ScenarioAdapter(writer, usageWriter);
  notices = [];
  lifecycle = makeLifecycle();
});

afterEach(async () => {
  await lifecycle.shutdown();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("usage observations (T2.5, FR-CAP-01)", () => {
  const usageRows = (runId: string) => ledger.listUsageObservationsForRun(runId);

  it("stores provider-reported usage in the terminal transaction, on success", async () => {
    lifecycle.start();
    const ok = await submit("writer-usage");
    expect((await lifecycle.waitForTerminal(ok.runId)).state).toBe("SUCCEEDED");
    const rows = usageRows(ok.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "provider_reported", provider: "fake", harness: "fake" });
    expect(JSON.parse(rows[0]?.metrics_json ?? "{}")).toEqual({ input_tokens: 7, output_tokens: 2 });
  });

  it("stores nothing when the provider reported no usage", async () => {
    lifecycle.start();
    const r = await submit("writer");
    await lifecycle.waitForTerminal(r.runId);
    expect(usageRows(r.runId)).toEqual([]);
  });
});

describe("state machine table (FRD §4.2)", () => {
  it("never leaves a terminal state and rejects edges the FRD does not define", () => {
    for (const t of TERMINAL_STATES) {
      for (const to of RUN_STATES) expect(() => assertTransition(t, to)).toThrow(IllegalTransitionError);
    }
    expect(() => assertTransition("QUEUED", "RUNNING")).toThrow(IllegalTransitionError);
    expect(() => assertTransition("RUNNING", "SUCCEEDED")).toThrow(IllegalTransitionError);
    expect(() => assertTransition("LEASED", "QUEUED")).toThrow(IllegalTransitionError);
    expect(() => assertTransition("FINALIZING", "RUNNING")).toThrow(IllegalTransitionError);
    expect(assertTransition("QUEUED", "PREFLIGHT").id).toBe("T4");
  });

  it("lets every non-terminal state except FINALIZING be cancelled (FRD §4.3)", () => {
    for (const s of RUN_STATES) {
      if (TERMINAL_STATES.has(s)) continue;
      const direct = TRANSITIONS.some((t) => t.from === s && t.to === "CANCELLED");
      const viaFinalizing = TRANSITIONS.some((t) => t.from === s && t.to === "FINALIZING");
      expect(direct || viaFinalizing || s === "FINALIZING").toBe(true);
    }
  });

  it("the ledger refuses a transition whose source state or version is stale", async () => {
    const r = await submit("success");
    const run = ledger.getRunRecord(r.runId);
    if (!run) throw new Error("missing");
    expect(ledger.casRunState({ runId: run.id, from: "RUNNING", to: "FINALIZING", expectedVersion: run.version })).toBe(
      undefined,
    );
    expect(ledger.casRunState({ runId: run.id, from: "QUEUED", to: "PREFLIGHT", expectedVersion: 99 })).toBe(undefined);
    expect(ledger.getRunRecord(run.id)?.state).toBe("QUEUED");
    expect(events(run.id)).toHaveLength(1);
  });
});

describe("admission", () => {
  it("T1: a valid request is QUEUED with its first run_event, and nothing dispatches before start()", async () => {
    const r = await submit("success");
    expect(r.state).toBe("QUEUED");
    const ev = events(r.runId);
    expect(ev.map((e) => [e.seq, e.type, e.p.to, e.p.rule])).toEqual([[1, "state_transition", "QUEUED", "T1"]]);
    await new Promise((res) => setTimeout(res, 50));
    expect(ledger.getRunRecord(r.runId)?.state).toBe("QUEUED");
  });

  it("rejects invalid input before writing anything (FRD §7)", async () => {
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n;
    const outside = mkdtempSync(path.join(tmpdir(), "sb-outside-"));
    const notGit = path.join(root, "plain");
    mkdirSync(notGit);
    try {
      await expect(submit("")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(submit("success", { workspace: outside })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(submit("success", { workspace: notGit })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(submit("success", { provider: "codex" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(submit("success", { trustProfile: "root" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(count()).toBe(0);
      // inspect-untrusted may use a non-Git directory (FR-WS-06).
      await expect(submit("success", { workspace: notGit, trustProfile: "inspect-untrusted" })).resolves.toMatchObject({
        state: "QUEUED",
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("T2: a privileged request waits in AWAITING_APPROVAL, is never dispatched, and can be cancelled", async () => {
    const r = await submit("success", { trustProfile: "privileged", privileged: { scope: SCOPE } });
    expect(r.state).toBe("AWAITING_APPROVAL");
    lifecycle.start();
    await new Promise((res) => setTimeout(res, 50));
    expect(ledger.getRunRecord(r.runId)?.state).toBe("AWAITING_APPROVAL");
    expect(compiles).toBe(0);
    expect(await lifecycle.cancel(r.runId)).toBe("CANCELLED");
    expect(rules(r.runId)).toEqual(["T19"]);
    // FRD §4.3 / Q-15 (Proposed): the PENDING approval is closed DENIED, decided by the cancel source.
    expect(ledger.getApprovalForRun(r.runId)).toMatchObject({ status: "DENIED", decided_by: "cancel_run" });
    expect(events(r.runId).map((e) => e.type)).toContain("approval_closed");
  });

  describe("objective redaction at admission (Q-68, NFR-SEC-01)", () => {
    // Synthetic canaries shaped like the redactor's patterns (never real credentials).
    const KEY = `sk-ant-api03-CANARYQ68${"0a1b2c3d".repeat(3)}`;
    const GH = `ghp_${"Q68canary".repeat(4)}`;
    const ledgerText = () =>
      [
        ...(db.prepare("SELECT objective, constraints_json FROM meta_session").all() as Record<string, string>[]),
        ...(db.prepare("SELECT request_json FROM run").all() as Record<string, string>[]),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n");
    const storedRequest = (runId: string) => JSON.parse(ledger.getRunRecord(runId)?.request_json ?? "{}");
    const compiled: CompileRequest[] = [];
    beforeEach(() => {
      compiled.length = 0;
      adapter.onCompile = (req) => compiled.push(req);
    });

    it("stores and sends the redacted objective and constraints, with a count and never the original", async () => {
      const r = await submit(`fix the build, my key is ${KEY}`, { constraints: [`use token ${GH}`, "keep tests"] });
      const meta = ledger.getMetaSession(r.metaSessionId);
      expect(meta?.objective).toBe("fix the build, my key is [REDACTED]");
      const req = storedRequest(r.runId);
      expect(req).toMatchObject({
        objective: "fix the build, my key is [REDACTED]",
        constraints: ["use token [REDACTED]", "keep tests"],
        admission_redactions: 2,
      });
      expect(ledgerText()).not.toContain(KEY);
      expect(ledgerText()).not.toContain(GH);
      lifecycle.start();
      await lifecycle.waitForTerminal(r.runId);
      // What the adapter compiles is what the provider receives (stdin or the ACP prompt).
      expect(compiled.map((c) => [c.objective, c.constraints])).toEqual([
        ["fix the build, my key is [REDACTED]", ["use token [REDACTED]", "keep tests"]],
      ]);
    });

    it("a clean objective is stored unchanged with no redaction field (stored request and hash unchanged)", async () => {
      const r = await submit("success", { constraints: ["keep tests"] });
      const req = storedRequest(r.runId);
      expect(req.objective).toBe("success");
      expect(req).not.toHaveProperty("admission_redactions");
      // A literal marker already in the text is not counted as a redaction.
      const m = await submit("leave [REDACTED] as it is");
      expect(storedRequest(m.runId)).not.toHaveProperty("admission_redactions");
    });

    it("a continuation stores and sends its own instruction redacted and re-sends the stored constraints", async () => {
      lifecycle.start();
      const first = await submit("success", { constraints: [`token ${GH}`] });
      await lifecycle.waitForTerminal(first.runId);
      // The MCP layer continues with the constraints the meta-session's latest run stored (FRD C3).
      const inherited = lifecycle.metaSessionContext(first.metaSessionId)?.constraints;
      expect(inherited).toEqual(["token [REDACTED]"]);
      const next = await submit(`now use ${KEY}`, { metaSessionId: first.metaSessionId, constraints: inherited });
      await lifecycle.waitForTerminal(next.runId);
      expect(storedRequest(next.runId)).toMatchObject({
        objective: "now use [REDACTED]",
        constraints: ["token [REDACTED]"],
        admission_redactions: 1,
      });
      expect(compiled.map((c) => [c.objective, c.constraints])).toEqual([
        ["success", ["token [REDACTED]"]],
        ["now use [REDACTED]", ["token [REDACTED]"]],
      ]);
      expect(ledgerText()).not.toContain(KEY);
      expect(ledgerText()).not.toContain(GH);
    });
  });

  describe("privileged admission (T3.3, LLD §3.1)", () => {
    it("T2 writes the run, one PENDING approval and the first event in one transaction; no process, no worktree", async () => {
      const r = await submit("success", { trustProfile: "privileged", privileged: { scope: SCOPE } });
      const run = ledger.getRunRecord(r.runId);
      const approval = ledger.getApprovalForRun(r.runId);
      expect(approval).toMatchObject({ status: "PENDING", decided_at: null, decided_by: null });
      expect(ledger.listApprovals()).toHaveLength(1);
      const parsed = parsePrivilegedScope(SCOPE);
      if (!parsed.ok) throw new Error("bad fixture");
      expect(approval?.scope_json).toBe(canonicalScopeJson(parsed.scope));
      const hash = privilegedScopeHash({ clientId: "client-a", metaSessionId: r.metaSessionId, scope: parsed.scope });
      expect(approval?.scope_hash).toBe(hash);
      expect(JSON.parse(run?.policy_snapshot_json ?? "{}")).toEqual({
        name: "privileged",
        fileAccess: "scoped",
        shell: "scoped",
        network: "scoped",
        repoConfig: "scoped",
        bypassApproved: false,
        privilegedScope: { scope: parsed.scope, scopeHash: hash, approvalId: approval?.id },
      });
      expect(events(r.runId).map((e) => e.p)).toEqual([
        { from: null, to: "AWAITING_APPROVAL", rule: "T2", approval_id: approval?.id },
      ]);
      expect(run?.worktree_path).toBeNull();
      expect(run?.pid).toBeNull();
      expect(sessionRow(r.metaSessionId).lease_run_id).toBeNull();
    });

    it("refuses a missing or malformed scope, a scope with another profile and a scope on a continuation", async () => {
      const count = () => (db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n;
      await expect(submit("success", { trustProfile: "privileged" })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
      await expect(
        submit("success", { trustProfile: "privileged", privileged: { scope: { ...SCOPE, extra: 1 } } }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(submit("success", { privileged: { scope: SCOPE } })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
      const first = await submit("success");
      lifecycle.start();
      await lifecycle.waitForTerminal(first.runId);
      await expect(
        submit("success", {
          trustProfile: "privileged",
          metaSessionId: first.metaSessionId,
          privileged: { scope: SCOPE },
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(count()).toBe(1);
      expect(ledger.listApprovals()).toHaveLength(0);
    });

    it("refuses a continuation of a meta-session that retention GC has archived, before any run is written (R-42)", async () => {
      const first = await submit("success");
      lifecycle.start();
      await lifecycle.waitForTerminal(first.runId);
      const runs = ledger.listRunsForMetaSession(first.metaSessionId).length;
      db.prepare("UPDATE meta_session SET status = 'ARCHIVED' WHERE id = ?").run(first.metaSessionId);
      await expect(submit("success", { metaSessionId: first.metaSessionId })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("archived"),
      });
      expect(ledger.listRunsForMetaSession(first.metaSessionId)).toHaveLength(runs);
    });

    it("refuses a continuation archived between validation and the admission transaction (R-42)", async () => {
      const first = await submit("success");
      lifecycle.start();
      await lifecycle.waitForTerminal(first.runId);
      const runs = ledger.listRunsForMetaSession(first.metaSessionId).length;
      const pending = submit("success", { metaSessionId: first.metaSessionId });
      // validate() awaits the workspace check; GC marks the session in that gap.
      db.prepare("UPDATE meta_session SET status = 'ARCHIVED' WHERE id = ?").run(first.metaSessionId);
      await expect(pending).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(ledger.listRunsForMetaSession(first.metaSessionId)).toHaveLength(runs);
    });

    it("idempotent replay returns the same run and writes no second approval row", async () => {
      const opts = { trustProfile: "privileged", privileged: { scope: SCOPE }, idempotencyKey: "priv-key-1" };
      const a = await submit("success", opts);
      const b = await submit("success", opts);
      expect(b).toEqual({ ...a, replayed: true });
      expect(ledger.listApprovals()).toHaveLength(1);
      // The scope is part of the request hash: the same key with another scope is a mismatch.
      await expect(
        submit("success", { ...opts, privileged: { scope: { ...SCOPE, bypass: false } } }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    });

    it("an approved privileged run is compiled by its adapter; an adapter that cannot compile it fails with the BR-3 code", async () => {
      const r = await submit("success", { trustProfile: "privileged", privileged: { scope: SCOPE } });
      const approval = ledger.getApprovalForRun(r.runId);
      ledger.decideApproval({ id: approval?.id as string, status: "APPROVED", decidedBy: "op" });
      approveDirect(r.runId); // stands in for T3.4's `approve`
      lifecycle.start();
      const done = await lifecycle.waitForTerminal(r.runId);
      // The fake adapter has no privileged mode: compile decides (T3.7 path, FRD T10), never PERMISSION_BLOCKED.
      expect(done).toMatchObject({ state: "FAILED", failure_code: "ELIGIBILITY_NONE", pid: null });
      expect(done.failure_detail).toContain("fake cannot compile privileged: PROFILE_UNSUPPORTED");
      expect(rules(r.runId)).toEqual(["T3", "T4", "T5", "T10"]);
      expect(compiles).toBe(1);
      // bypassApproved came from the approval (SCOPE sets bypass), never from the stored snapshot.
      expect(adapter.compiledProfiles[0]).toMatchObject({ name: "privileged", bypassApproved: true });
      expect(JSON.parse(done.policy_snapshot_json).bypassApproved).toBe(false);
      // A failed later run never changes the approval (owner decision 17).
      expect(ledger.getApproval(approval?.id as string)?.status).toBe("APPROVED");
    });

    it("an approved privileged run whose adapter compiles the scope runs in its own worktree and succeeds", async () => {
      adapter.privilegedAs = "edit-untrusted";
      const r = await submit("writer", {
        trustProfile: "privileged",
        privileged: { scope: { ...SCOPE, bypass: false } },
      });
      const approval = ledger.getApprovalForRun(r.runId);
      ledger.decideApproval({ id: approval?.id as string, status: "APPROVED", decidedBy: "op" });
      approveDirect(r.runId);
      lifecycle.start();
      const done = await lifecycle.waitForTerminal(r.runId);
      expect(done.state).toBe("SUCCEEDED");
      expect(done.worktree_path).not.toBeNull(); // FR-WS-05: a worktree, never the operator's checkout
      expect(existsSync(path.join(repo, "feature.txt"))).toBe(false);
      expect(adapter.compiledProfiles[0]).toMatchObject({ name: "privileged", bypassApproved: false });
      expect(events(r.runId).find((e) => e.type === "privileged_dispatch")?.p).toEqual({
        approval_id: approval?.id,
        bypass_approved: false,
      });
    });

    it("T1 continuation under an APPROVED approval copies the scope as is and writes no new approval row", async () => {
      const r = await submit("success", { trustProfile: "privileged", privileged: { scope: SCOPE } });
      const approval = ledger.getApprovalForRun(r.runId);
      const cont = (over: Record<string, unknown> = {}) =>
        submit("success", {
          trustProfile: "privileged",
          metaSessionId: r.metaSessionId,
          privileged: { approvalId: approval?.id },
          ...over,
        });
      // PENDING: refused (and the first run is still active).
      await expect(cont()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      ledger.decideApproval({ id: approval?.id as string, status: "APPROVED", decidedBy: "op" });
      approveDirect(r.runId);
      lifecycle.start();
      await lifecycle.waitForTerminal(r.runId);
      // Another client is refused even with the right approval id.
      await expect(cont({ clientId: "client-b" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      // An approval id from another meta-session is refused.
      const other = await submit("success", { trustProfile: "privileged", privileged: { scope: SCOPE } });
      await expect(
        cont({ privileged: { approvalId: ledger.getApprovalForRun(other.runId)?.id } }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      const before = ledger.listApprovals().length;
      const c = await cont();
      expect(c.state).toBe("QUEUED");
      expect(ledger.listApprovals()).toHaveLength(before);
      const snap = JSON.parse(ledger.getRunRecord(c.runId)?.policy_snapshot_json ?? "{}");
      const first = JSON.parse(ledger.getRunRecord(r.runId)?.policy_snapshot_json ?? "{}");
      expect(snap.privilegedScope).toEqual(first.privilegedScope);
      expect(snap.bypassApproved).toBe(false);
      expect(events(c.runId)[0]?.p).toEqual({ from: null, to: "QUEUED", rule: "T1", approval_id: approval?.id });
      expect(ledger.listRunsCoveredByApproval(approval?.id as string).map((x) => x.id)).toEqual([r.runId, c.runId]);
      const done = await lifecycle.waitForTerminal(c.runId);
      expect(done).toMatchObject({ state: "FAILED", failure_code: "ELIGIBILITY_NONE" });
      // Cancelling or failing a later run leaves the approval unchanged.
      expect(ledger.getApproval(approval?.id as string)?.status).toBe("APPROVED");
    });

    it("a DENIED approval or a tampered scope hash refuses the continuation", async () => {
      const r = await submit("success", { trustProfile: "privileged", privileged: { scope: SCOPE } });
      const approval = ledger.getApprovalForRun(r.runId);
      expect(await lifecycle.cancel(r.runId)).toBe("CANCELLED");
      await expect(
        submit("success", {
          trustProfile: "privileged",
          metaSessionId: r.metaSessionId,
          privileged: { approvalId: approval?.id },
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining("DENIED") });

      const t = await submit("success", { trustProfile: "privileged", privileged: { scope: SCOPE } });
      const ta = ledger.getApprovalForRun(t.runId);
      // Tamper while PENDING (the update-once trigger allows it), then approve.
      db.prepare("UPDATE approval SET scope_json = ? WHERE id = ?").run(
        JSON.stringify({ ...SCOPE, network: { mode: "on" } }),
        ta?.id,
      );
      ledger.decideApproval({ id: ta?.id as string, status: "APPROVED", decidedBy: "op" });
      approveDirect(t.runId);
      lifecycle.start();
      await lifecycle.waitForTerminal(t.runId);
      await expect(
        submit("success", {
          trustProfile: "privileged",
          metaSessionId: t.metaSessionId,
          privileged: { approvalId: ta?.id },
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining("hash") });
    });
  });

  describe("privileged approval and bypass check (T3.4, LLD §3.1 Approve and Bypass)", () => {
    /** The operator decision as `serve` applies it (the CLI's record is stood in for by an event id). */
    const decide = (runId: string, decision: "APPROVED" | "DENIED" = "APPROVED") => {
      const run = ledger.getRunRecord(runId);
      const row = ledger.getApprovalForRun(runId);
      return lifecycle.applyApprovalDecision({
        requestEventId: `evt_test_${runId}`,
        runId,
        decision,
        requestedBy: "op",
        requestedAt: "2026-10-13T00:00:00.000Z",
        scopeHash: run ? (row?.scope_hash ?? "") : "",
      });
    };
    const transitionPayload = (runId: string, to: string) =>
      events(runId)
        .filter((e) => e.type === "state_transition")
        .map((e) => e.p)
        .find((p) => p.to === to);
    // biome-ignore lint/suspicious/noExplicitAny: the stored snapshot is untyped JSON edited in place
    const setSnapshot = (runId: string, edit: (snap: Record<string, any>) => void) => {
      const snap = JSON.parse(ledger.getRunRecord(runId)?.policy_snapshot_json ?? "{}");
      edit(snap);
      db.prepare("UPDATE run SET policy_snapshot_json = ? WHERE id = ?").run(JSON.stringify(snap), runId);
    };

    it("approve moves the run AWAITING_APPROVAL -> QUEUED (T3) with a decided row; dispatch computes bypassApproved for the compile", async () => {
      const r = await submit("success", { trustProfile: "privileged", privileged: { scope: SCOPE } });
      expect(decide(r.runId)).toBe("QUEUED");
      const row = ledger.getApprovalForRun(r.runId);
      expect(row).toMatchObject({ status: "APPROVED", decided_by: "op", decided_at: "2026-10-13T00:00:00.000Z" });
      expect(events(r.runId).map((e) => e.type)).toEqual([
        "state_transition",
        "approval_decided",
        "state_transition",
        "operator_decision_applied",
      ]);
      expect(transitionPayload(r.runId, "QUEUED")).toMatchObject({ rule: "T3", reason: "operator_approve" });
      lifecycle.start();
      const done = await lifecycle.waitForTerminal(r.runId);
      expect(done).toMatchObject({ state: "FAILED", failure_code: "ELIGIBILITY_NONE", pid: null });
      expect(events(r.runId).find((e) => e.type === "privileged_dispatch")?.p).toEqual({
        approval_id: row?.id,
        bypass_approved: true,
      });
      expect(transitionPayload(r.runId, "FAILED")).toMatchObject({ rule: "T10", reason: "PROFILE_UNSUPPORTED" });
      expect(rules(r.runId)).toEqual(["T3", "T4", "T5", "T10"]);
      expect(adapter.compiledProfiles.map((p) => p.bypassApproved)).toEqual([true]);
      // The stored snapshot is never widened: bypassApproved is computed at dispatch, not written back.
      expect(JSON.parse(done.policy_snapshot_json).bypassApproved).toBe(false);
      // A second decision is refused and changes nothing.
      expect(() => decide(r.runId, "DENIED")).toThrow(ApprovalRefusedError);
      expect(ledger.getApprovalForRun(r.runId)?.status).toBe("APPROVED");
    });

    it("operator `approve` (CLI, no daemon, under the data-directory lock) -> QUEUED -> SUCCEEDED; a continuation runs without a second approve", async () => {
      adapter.privilegedAs = "edit-untrusted";
      const configPath = path.join(root, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          schema_version: 1,
          data_dir: dataDir,
          allowed_roots: [root],
          mcp_clients: [{ id: "client-a", max_trust_profile: "privileged" }],
        }),
      );
      const operator = async (cmd: "approve" | "deny", runId: string) => {
        const out: string[] = [];
        const io: CliIo = { stdout: { write: (c) => out.push(c) }, stderr: { write: () => {} }, env: {}, user: "op" };
        const code = await main([cmd, runId, "--config", configPath, "--json"], io);
        return { code, body: out.length > 0 ? (JSON.parse(out.join("")) as Record<string, unknown>) : {} };
      };

      const r = await submit("writer", { trustProfile: "privileged", privileged: { scope: SCOPE } });
      expect(r.state).toBe("AWAITING_APPROVAL");
      const pending = ledger.getApprovalForRun(r.runId);
      expect(pending).toMatchObject({ run_id: r.runId, status: "PENDING" });
      expect(compiles).toBe(0);

      // No daemon holds the lock: the CLI takes it and applies the decision to the requesting run's PENDING row (WF-7).
      const ap = await operator("approve", r.runId);
      expect(ap.code, JSON.stringify(ap.body)).toBe(0);
      expect(ap.body).toMatchObject({
        run_id: r.runId,
        outcome: "approved",
        state: "QUEUED",
        daemon_running: false,
        approval_id: pending?.id,
        decided_by: "op",
        scope_hash: pending?.scope_hash,
      });
      expect(ledger.getRunRecord(r.runId)?.state).toBe("QUEUED");
      expect(ledger.getApprovalForRun(r.runId)).toMatchObject({ status: "APPROVED", decided_by: "op" });

      // The QUEUED run is dispatched and runs to completion on the fake adapter.
      lifecycle.start();
      const done = await lifecycle.waitForTerminal(r.runId);
      expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
      expect(done.pid).not.toBeNull(); // a provider process was spawned
      expect(done.worktree_path).not.toBeNull();
      expect(existsSync(path.join(repo, "feature.txt"))).toBe(false); // the write stayed in the worktree
      expect(adapter.compiledProfiles).toHaveLength(1);
      expect(adapter.compiledProfiles[0]).toMatchObject({ name: "privileged", bypassApproved: true });
      expect(events(r.runId).find((e) => e.type === "privileged_dispatch")?.p).toEqual({
        approval_id: pending?.id,
        bypass_approved: true,
      });
      expect(JSON.parse(done.policy_snapshot_json).bypassApproved).toBe(false); // computed at dispatch, never stored

      // A continuation of the approved meta-session is QUEUED at admission (FRD C7) and runs; no new row, no approve.
      const cont = await submit("success", {
        trustProfile: "privileged",
        metaSessionId: r.metaSessionId,
        privileged: { approvalId: pending?.id },
      });
      expect(cont.state).toBe("QUEUED");
      expect(ledger.getApprovalForRun(cont.runId)).toBeUndefined();
      const contDone = await lifecycle.waitForTerminal(cont.runId);
      expect(contDone.state, contDone.failure_detail ?? "").toBe("SUCCEEDED");
      expect(rules(cont.runId)).not.toContain("T3"); // never waited for approval
      expect(adapter.compiledProfiles.at(-1)).toMatchObject({ name: "privileged", bypassApproved: true });
      expect(events(cont.runId).find((e) => e.type === "privileged_dispatch")?.p).toEqual({
        approval_id: pending?.id,
        bypass_approved: true,
      });
      expect(ledger.listApprovals()).toHaveLength(1);
      // approve acts only on the requesting run: on the continuation it is refused and changes nothing.
      expect((await operator("approve", cont.runId)).code).toBe(1);
      expect((await operator("approve", r.runId)).code).toBe(1); // already decided
      expect(ledger.getApprovalForRun(r.runId)).toMatchObject({ status: "APPROVED", decided_by: "op" });

      // An identical scope in a new meta-session is not covered: it waits for its own approve.
      const fresh = await submit("success", { trustProfile: "privileged", privileged: { scope: SCOPE } });
      expect(fresh.state).toBe("AWAITING_APPROVAL");
      expect(ledger.getApprovalForRun(fresh.runId)?.status).toBe("PENDING");
    });

    it("deny ends the run CANCELLED (T19) with a DENIED row; no worktree, no process", async () => {
      const r = await submit("success", { trustProfile: "privileged", privileged: { scope: SCOPE } });
      expect(decide(r.runId, "DENIED")).toBe("CANCELLED");
      const done = await lifecycle.waitForTerminal(r.runId);
      expect(done).toMatchObject({ state: "CANCELLED", pid: null, worktree_path: null });
      expect(done.finished_at).not.toBeNull();
      expect(ledger.getApprovalForRun(r.runId)).toMatchObject({ status: "DENIED", decided_by: "op" });
      expect(rules(r.runId)).toEqual(["T19"]);
      expect(() => decide(r.runId)).toThrow(/CANCELLED, not AWAITING_APPROVAL/);
    });

    it("a tampered or mismatched scope hash fails the run PERMISSION_BLOCKED before any probe, lease or spawn", async () => {
      const tamper: [string, (runId: string) => void][] = [
        ["snapshot hash", (id) => setSnapshot(id, (s) => (s.privilegedScope.scopeHash = "0".repeat(64)))],
        ["snapshot scope", (id) => setSnapshot(id, (s) => (s.privilegedScope.scope.network = { mode: "on" }))],
        ["snapshot approval", (id) => setSnapshot(id, (s) => (s.privilegedScope.approvalId = "apv_missing"))],
      ];
      const ids: string[] = [];
      for (const [, edit] of tamper) {
        const r = await submit("success", { trustProfile: "privileged", privileged: { scope: SCOPE } });
        expect(decide(r.runId)).toBe("QUEUED");
        edit(r.runId); // after approval, before dispatch
        ids.push(r.runId);
      }
      // A row rewritten while PENDING is refused at approve; forced through, dispatch still refuses it.
      const t = await submit("success", { trustProfile: "privileged", privileged: { scope: SCOPE } });
      const ta = ledger.getApprovalForRun(t.runId);
      db.prepare("UPDATE approval SET scope_json = ? WHERE id = ?").run(
        JSON.stringify({ ...SCOPE, network: { mode: "on" } }),
        ta?.id,
      );
      expect(() => decide(t.runId)).toThrow(/scope hash check failed/);
      expect(ledger.getRunRecord(t.runId)?.state).toBe("AWAITING_APPROVAL");
      expect(ledger.getApprovalForRun(t.runId)?.status).toBe("PENDING");
      ledger.decideApproval({ id: ta?.id as string, status: "APPROVED", decidedBy: "op" });
      approveDirect(t.runId);
      ids.push(t.runId);

      lifecycle.start();
      for (const id of ids) {
        const done = await lifecycle.waitForTerminal(id);
        expect(done, id).toMatchObject({ state: "FAILED", failure_code: "PERMISSION_BLOCKED", pid: null });
        expect(done.worktree_path).toBeNull();
        expect(done.failure_detail).toContain("privileged approval check failed before spawn");
        expect(done.failure_detail).not.toMatch(/[0-9a-f]{64}/); // never a hash value
        expect(transitionPayload(id, "FAILED")).toMatchObject({ rule: "T8", reason: "APPROVAL_MISMATCH" });
        expect(rules(id).slice(-2)).toEqual(["T4", "T8"]);
      }
      expect(compiles).toBe(0);
      expect(probes).toBe(0);
    });

    it("bypassApproved is true only for an APPROVED row matching the run's client, meta-session, hash and bypass", async () => {
      const r = await submit("success", { trustProfile: "privileged", privileged: { scope: SCOPE } });
      const rec = () => ledger.getRunRecord(r.runId) as NonNullable<ReturnType<typeof ledger.getRunRecord>>;
      // PENDING: no approval yet.
      expect(bypassApprovedFor(ledger, rec())).toBe(false);
      expect(evaluateBypass(ledger, rec())).toMatchObject({
        ok: false,
        mismatch: "the approval is PENDING, not APPROVED",
      });
      decide(r.runId);
      expect(bypassApprovedFor(ledger, rec())).toBe(true);
      // A continuation of the approved meta-session is covered without a new approve.
      lifecycle.start();
      await lifecycle.waitForTerminal(r.runId);
      const approvalId = ledger.getApprovalForRun(r.runId)?.id;
      const cont = await submit("success", {
        trustProfile: "privileged",
        metaSessionId: r.metaSessionId,
        privileged: { approvalId },
      });
      const contRec = ledger.getRunRecord(cont.runId) as NonNullable<ReturnType<typeof ledger.getRunRecord>>;
      expect(bypassApprovedFor(ledger, contRec)).toBe(true);
      await lifecycle.waitForTerminal(cont.runId);
      expect(events(cont.runId).find((e) => e.type === "privileged_dispatch")?.p).toMatchObject({
        bypass_approved: true,
      });
      // A run in another meta-session with an identical scope is not covered by it, even when its snapshot names it.
      const other = await submit("success", { trustProfile: "privileged", privileged: { scope: SCOPE } });
      setSnapshot(other.runId, (s) => {
        s.privilegedScope.approvalId = approvalId;
        s.privilegedScope.scopeHash = ledger.getApproval(approvalId as string)?.scope_hash;
      });
      const otherRec = ledger.getRunRecord(other.runId) as NonNullable<ReturnType<typeof ledger.getRunRecord>>;
      expect(evaluateBypass(ledger, otherRec)).toMatchObject({
        ok: false,
        mismatch: "the approval belongs to another meta-session or client",
      });
      // DENIED: false.
      const d = await submit("success", { trustProfile: "privileged", privileged: { scope: SCOPE } });
      decide(d.runId, "DENIED");
      expect(bypassApprovedFor(ledger, ledger.getRunRecord(d.runId) as typeof contRec)).toBe(false);
      // APPROVED and matching, but the scope does not set bypass: ok, and false.
      const nb = await submit("success", {
        trustProfile: "privileged",
        privileged: { scope: { ...SCOPE, bypass: false } },
      });
      decide(nb.runId);
      const nbRec = ledger.getRunRecord(nb.runId) as typeof contRec;
      expect(evaluateBypass(ledger, nbRec)).toMatchObject({ ok: true, bypassApproved: false });
      expect(bypassApprovedFor(ledger, nbRec)).toBe(false);
      // A non-privileged run has no approval: never bypassApproved.
      const plain = await submit("success");
      expect(bypassApprovedFor(ledger, ledger.getRunRecord(plain.runId) as typeof contRec)).toBe(false);
    });

    it("approve is refused for a later run that merely reuses an approval, and the approval is unchanged", async () => {
      const r = await submit("success", { trustProfile: "privileged", privileged: { scope: SCOPE } });
      decide(r.runId);
      lifecycle.start();
      await lifecycle.waitForTerminal(r.runId);
      const approvalId = ledger.getApprovalForRun(r.runId)?.id;
      const cont = await submit("success", {
        trustProfile: "privileged",
        metaSessionId: r.metaSessionId,
        privileged: { approvalId },
      });
      expect(() =>
        lifecycle.applyApprovalDecision({
          requestEventId: "evt_x",
          runId: cont.runId,
          decision: "DENIED",
          requestedBy: "op",
          requestedAt: "2026-10-13T00:00:00.000Z",
          scopeHash: "",
        }),
      ).toThrow(/approve and deny act only on the run that requested an approval/);
      // Cancelling (or failing) the later run leaves the approval unchanged.
      await lifecycle.cancel(cont.runId);
      expect(["CANCELLED", "FAILED"]).toContain((await lifecycle.waitForTerminal(cont.runId)).state);
      expect(ledger.getApproval(approvalId as string)?.status).toBe("APPROVED");
    });
  });

  describe("approval by client policy (owner decision 22, ADR-0019: privileged_approval not_required)", () => {
    const byPolicy = (objective: Scenario | string = "writer", scope: unknown = SCOPE, extra = {}) =>
      submit(objective, { trustProfile: "privileged", privileged: { scope, approvedByClientPolicy: true }, ...extra });
    // biome-ignore lint/suspicious/noExplicitAny: the stored snapshot is untyped JSON edited in place
    const setSnapshot = (runId: string, edit: (snap: Record<string, any>) => void) => {
      const snap = JSON.parse(ledger.getRunRecord(runId)?.policy_snapshot_json ?? "{}");
      edit(snap);
      db.prepare("UPDATE run SET policy_snapshot_json = ? WHERE id = ?").run(JSON.stringify(snap), runId);
    };

    it("T1 to QUEUED with the scope hashed and an APPROVED row decided by client_policy:<client>, in one transaction", async () => {
      const r = await byPolicy();
      expect(r.state).toBe("QUEUED");
      const row = ledger.getApprovalForRun(r.runId);
      const parsed = parsePrivilegedScope(SCOPE);
      if (!parsed.ok) throw new Error("bad fixture");
      expect(row).toMatchObject({
        status: "APPROVED",
        decided_by: "client_policy:client-a",
        scope_json: canonicalScopeJson(parsed.scope),
        scope_hash: privilegedScopeHash({ clientId: "client-a", metaSessionId: r.metaSessionId, scope: parsed.scope }),
      });
      expect(row?.decided_at).not.toBeNull();
      expect(ledger.listApprovals()).toHaveLength(1);
      const snap = JSON.parse(ledger.getRunRecord(r.runId)?.policy_snapshot_json ?? "{}");
      expect(snap.privilegedScope).toEqual({ scope: parsed.scope, scopeHash: row?.scope_hash, approvalId: row?.id });
      expect(snap.bypassApproved).toBe(false);
      expect(events(r.runId).map((e) => [e.type, e.p])).toEqual([
        ["state_transition", { from: null, to: "QUEUED", rule: "T1", approval_id: row?.id, approval: "client_policy" }],
        ["approval_decided", { approval_id: row?.id, status: "APPROVED", reason: "client_policy" }],
      ]);
      expect(rules(r.runId)).toEqual([]); // admission notices are not transitions; nothing waited for approval
      // Without the flag the same request still waits for the operator (required is unchanged).
      const waiting = await submit("writer", { trustProfile: "privileged", privileged: { scope: SCOPE } });
      expect(waiting.state).toBe("AWAITING_APPROVAL");
      expect(ledger.getApprovalForRun(waiting.runId)?.status).toBe("PENDING");
    });

    it("dispatches like an operator-approved run: bypassApproved from the row, a worktree, and approve/deny refused", async () => {
      adapter.privilegedAs = "edit-untrusted";
      const r = await byPolicy();
      expect(() =>
        lifecycle.applyApprovalDecision({
          requestEventId: "evt_policy",
          runId: r.runId,
          decision: "DENIED",
          requestedBy: "op",
          requestedAt: "2026-10-13T00:00:00.000Z",
          scopeHash: ledger.getApprovalForRun(r.runId)?.scope_hash ?? "",
        }),
      ).toThrow(/granted by client policy/);
      lifecycle.start();
      const done = await lifecycle.waitForTerminal(r.runId);
      expect(done.state).toBe("SUCCEEDED");
      expect(done.worktree_path).not.toBeNull();
      expect(existsSync(path.join(repo, "feature.txt"))).toBe(false);
      expect(adapter.compiledProfiles[0]).toMatchObject({ name: "privileged", bypassApproved: true });
      expect(events(r.runId).find((e) => e.type === "privileged_dispatch")?.p).toMatchObject({ bypass_approved: true });
      expect(ledger.getApprovalForRun(r.runId)?.status).toBe("APPROVED");
    });

    it("the argv audit admits a bypass flag only for an approved scope that sets bypass (profile passed to spawn)", async () => {
      adapter.privilegedAs = "edit-untrusted";
      // Test double for T3.5: append the Claude bypass flag to every privileged invocation.
      adapter.compileOverride = (_req, inv) => ({ ...inv, argv: [...inv.argv, "--dangerously-skip-permissions"] });
      const yes = await byPolicy("writer", SCOPE);
      const no = await byPolicy("writer", { ...SCOPE, bypass: false });
      lifecycle.start();
      expect((await lifecycle.waitForTerminal(yes.runId)).state).toBe("SUCCEEDED");
      const refused = await lifecycle.waitForTerminal(no.runId);
      expect(refused).toMatchObject({ state: "FAILED", failure_code: "PERMISSION_BLOCKED", pid: null });
      expect(refused.failure_detail).toContain("--dangerously-skip-permissions");
    });

    // T3.17 lifecycle wiring: the CLI records the argv it was spawned with, so a pass means the flag reached a process.
    const argvRecorder = () => {
      const out = path.join(root, "spawned-argv.json");
      const script = path.join(root, "argv-recorder.mjs");
      writeFileSync(
        script,
        `import { writeFileSync } from "node:fs";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));
emit({ type: "session", session_id: "argv-1" });
emit({ type: "result", ok: true, summary: "recorded" });
`,
      );
      return {
        out,
        withFlags: (inv: Invocation, flags: readonly string[]) => ({
          ...inv,
          argv: [inv.argv[0] ?? process.execPath, script, ...inv.argv.slice(2), ...flags],
        }),
      };
    };

    it("an approved bypass-true run is spawned with every bypass-class flag on its argv (T3.17)", async () => {
      adapter.privilegedAs = "edit-untrusted";
      const rec = argvRecorder();
      const flags = bypassClassFlags();
      adapter.compileOverride = (_req, inv) => rec.withFlags(inv, flags);
      const r = await byPolicy("writer", SCOPE);
      lifecycle.start();
      const done = await lifecycle.waitForTerminal(r.runId);
      expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
      expect(adapter.compiledProfiles.at(-1)).toMatchObject({ name: "privileged", bypassApproved: true });
      const argv = JSON.parse(readFileSync(rec.out, "utf8")) as string[];
      for (const f of flags) expect(argv).toContain(f);
    });

    it("every other case refuses each bypass-class flag before spawn: non-privileged profiles, bypass false (T3.17)", async () => {
      adapter.privilegedAs = "edit-untrusted";
      const rec = argvRecorder();
      let flag = "";
      adapter.compileOverride = (_req, inv) => rec.withFlags(inv, [flag]);
      lifecycle.start();
      const cases: [string, () => Promise<{ runId: string }>][] = [
        ...(["inspect-untrusted", "edit-untrusted", "test-sandboxed", "trusted-development"] as const).map(
          (p): [string, () => Promise<{ runId: string }>] => [p, () => submit("writer", { trustProfile: p })],
        ),
        ["privileged bypass:false", () => byPolicy("writer", { ...SCOPE, bypass: false })],
      ];
      for (const [label, run] of cases) {
        for (const f of bypassClassFlags()) {
          flag = f;
          const r = await run();
          const done = await lifecycle.waitForTerminal(r.runId);
          expect(done, `${label} ${f}`).toMatchObject({
            state: "FAILED",
            failure_code: "PERMISSION_BLOCKED",
            pid: null,
          });
          expect(done.failure_detail, `${label} ${f}`).toContain(f);
          expect(path_(r.runId), `${label} ${f}`).not.toContain("RUNNING");
          expect(existsSync(rec.out), `${label} ${f}`).toBe(false);
        }
      }
      // One run per declared bypass-class flag and case: the list grows with each M4 adapter (T4.32, T4.42, T4.52).
    }, 180_000);

    it("a continuation runs under the client-policy approval as is; another client cannot use it", async () => {
      adapter.privilegedAs = "edit-untrusted";
      const r = await byPolicy();
      lifecycle.start();
      await lifecycle.waitForTerminal(r.runId);
      const approvalId = ledger.getApprovalForRun(r.runId)?.id;
      await expect(
        submit("writer", {
          clientId: "client-b",
          trustProfile: "privileged",
          metaSessionId: r.metaSessionId,
          privileged: { approvalId },
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      const cont = await submit("writer", {
        trustProfile: "privileged",
        metaSessionId: r.metaSessionId,
        privileged: { approvalId },
      });
      expect(cont.state).toBe("QUEUED");
      expect(ledger.listApprovals()).toHaveLength(1);
      const done = await lifecycle.waitForTerminal(cont.runId);
      expect(done.state).toBe("SUCCEEDED");
      expect(ledger.listRunsCoveredByApproval(approvalId as string).map((x) => x.id)).toEqual([r.runId, cont.runId]);
    });

    it("a tampered snapshot or row still fails PERMISSION_BLOCKED before any probe, lease or spawn", async () => {
      adapter.privilegedAs = "edit-untrusted";
      const a = await byPolicy();
      setSnapshot(a.runId, (snap) => (snap.privilegedScope.scope.network = { mode: "on" }));
      const b = await byPolicy();
      // The row is decided in the admission transaction, so the update-once trigger already refuses rewriting it.
      expect(() =>
        db.prepare("UPDATE approval SET scope_hash = ? WHERE run_id = ?").run("0".repeat(64), b.runId),
      ).toThrow(/approval already decided/);
      setSnapshot(b.runId, (snap) => (snap.privilegedScope.scopeHash = "0".repeat(64)));
      lifecycle.start();
      for (const id of [a.runId, b.runId]) {
        const done = await lifecycle.waitForTerminal(id);
        expect(done, id).toMatchObject({ state: "FAILED", failure_code: "PERMISSION_BLOCKED", pid: null });
        expect(done.worktree_path).toBeNull();
        expect(done.failure_detail).toContain("privileged approval check failed before spawn");
      }
      expect(compiles).toBe(0);
      expect(probes).toBe(0);
    });

    it("idempotent replay returns the same run and writes no second row; the scope is still validated", async () => {
      const a = await byPolicy("writer", SCOPE, { idempotencyKey: "policy-key-1" });
      const b = await byPolicy("writer", SCOPE, { idempotencyKey: "policy-key-1" });
      expect(b).toEqual({ ...a, replayed: true });
      expect(ledger.listApprovals()).toHaveLength(1);
      await expect(byPolicy("writer", { ...SCOPE, extra: 1 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(ledger.listApprovals()).toHaveLength(1);
    });
  });

  it("idempotency keys: same parameters return the original run; different parameters fail; keys are per client", async () => {
    const key = "key-123456";
    const a = await submit("success", { idempotencyKey: key });
    const again = await submit("success", { idempotencyKey: key });
    expect(again).toEqual({ ...a, replayed: true });
    await expect(submit("other objective", { idempotencyKey: key })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    const otherClient = await submit("success", { idempotencyKey: key, clientId: "client-b" });
    expect(otherClient.runId).not.toBe(a.runId);
    expect((db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n).toBe(2);
    // Replay also works once the original is terminal.
    lifecycle.start();
    await lifecycle.waitForTerminal(a.runId);
    expect(await submit("success", { idempotencyKey: key })).toMatchObject({ runId: a.runId, replayed: true });
  });

  it("request hashes are independent of key order", () => {
    expect(requestHash({ a: 1, b: [1, { y: 2, x: 1 }] })).toBe(requestHash({ b: [1, { x: 1, y: 2 }], a: 1 }));
  });

  it("refuses a second active run on one meta-session, and accepts a continuation once it is idle (BR-17)", async () => {
    const first = await submit("success");
    const cont = { metaSessionId: first.metaSessionId, workspace: undefined };
    await expect(submit("success", cont)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    lifecycle.start();
    await until(() => ledger.getRunRecord(first.runId)?.state === "RUNNING");
    await expect(submit("success", cont)).rejects.toThrow(/active run/);
    await lifecycle.waitForTerminal(first.runId);
    const second = await submit("success", cont);
    expect(second.metaSessionId).toBe(first.metaSessionId);
    expect((await lifecycle.waitForTerminal(second.runId)).state).toBe("SUCCEEDED");
    await expect(submit("success", { ...cont, idempotencyKey: "key-abcdefgh" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });
});

describe("queue and concurrency (FR-CAP-04)", () => {
  it("bounds the queue with QUEUE_FULL and writes nothing for the rejected request", async () => {
    lifecycle = makeLifecycle({ maxQueueDepth: 2 });
    await submit("success");
    await submit("success");
    const err = await submit("success").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LifecycleError);
    expect((err as LifecycleError).code).toBe("QUEUE_FULL");
    expect((db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM meta_session").get() as { n: number }).n).toBe(2);
  });

  it("dispatches by priority, then age", async () => {
    lifecycle = makeLifecycle({ globalConcurrency: 1 });
    const batch = await submit("success", { priority: "batch" });
    const normal1 = await submit("success");
    const interactive = await submit("success", { priority: "interactive" });
    const normal2 = await submit("success", { priority: "normal" });
    lifecycle.start();
    for (const r of [batch, normal1, interactive, normal2]) await lifecycle.waitForTerminal(r.runId);
    const order = notices.filter((n) => n.to === "PREFLIGHT").map((n) => n.runId);
    expect(order).toEqual([interactive.runId, normal1.runId, normal2.runId, batch.runId]);
  });

  it("never holds more slots than the global limit", async () => {
    lifecycle = makeLifecycle({ globalConcurrency: 2 });
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await submit("success"));
    let max = 0;
    const slot: RunState[] = ["PREFLIGHT", "LEASED", "RUNNING", "VERIFYING", "FINALIZING"];
    const sample = setInterval(() => {
      max = Math.max(max, ledger.countRunsInStates(slot));
    }, 5);
    lifecycle.start();
    try {
      for (const r of runs) expect((await lifecycle.waitForTerminal(r.runId)).state).toBe("SUCCEEDED");
    } finally {
      clearInterval(sample);
    }
    expect(max).toBe(2);
  });

  it("honours an optional per-provider limit", async () => {
    lifecycle = makeLifecycle({ globalConcurrency: 4, perProviderConcurrency: 1 });
    const a = await submit("success");
    const b = await submit("success");
    lifecycle.start();
    await until(() => ledger.getRunRecord(a.runId)?.state === "RUNNING");
    expect(ledger.getRunRecord(b.runId)?.state).toBe("QUEUED");
    await lifecycle.waitForTerminal(b.runId);
  });
});

describe("run lifecycle", () => {
  it("success: QUEUED > PREFLIGHT > LEASED > RUNNING > FINALIZING > SUCCEEDED with diff artifact and advanced head", async () => {
    const r = await submit("writer");
    lifecycle.start();
    const done = await lifecycle.waitForTerminal(r.runId);
    expect(done.state).toBe("SUCCEEDED");
    expect(done.failure_code).toBeNull();
    expect(path_(r.runId)).toBe("PREFLIGHT>LEASED>RUNNING>FINALIZING>SUCCEEDED");
    expect(rules(r.runId)).toEqual(["T4", "T5", "T9", "T12", "T15"]);
    expect(done.pid).toBeGreaterThan(0);
    expect(done.pgid).toBe(done.pid);
    expect(done.exit_code).toBe(0);
    expect(artifactKinds(r.runId)).toEqual(["changed_files", "diff", "provider_stderr", "provider_stdout"]);

    const diffId = (
      db.prepare("SELECT sha256 FROM artifact WHERE run_id = ? AND kind = 'diff'").get(r.runId) as {
        sha256: string;
      }
    ).sha256;
    const diff = readFileSync(path.join(dataDir, "artifacts", diffId.slice(0, 2), diffId.slice(2, 4), diffId), "utf8");
    expect(diff).toContain("+new feature");

    const s = sessionRow(r.metaSessionId);
    expect(s.lease_run_id).toBeNull();
    expect(s.head_commit).toBe(g(done.worktree_path as string, "rev-parse", "HEAD"));
    expect(g(repo, "status", "--porcelain")).toBe(""); // operator tree untouched (FR-WS-05)
    expect(existsSync(path.join(repo, "feature.txt"))).toBe(false);

    // Every lifecycle step appended a gapless run_event (FR-TEL-01); pid was recorded before provider output.
    const ev = events(r.runId);
    expect(ev.map((e) => e.seq)).toEqual(ev.map((_, i) => i + 1));
    const runningAt = ev.findIndex((e) => e.p.to === "RUNNING");
    const firstOutput = ev.findIndex((e) => e.type === "provider_event");
    expect(runningAt).toBeGreaterThan(-1);
    expect(runningAt).toBeLessThan(firstOutput);
    expect(ev.find((e) => e.p.to === "RUNNING")?.p.pid).toBe(done.pid);
    expect(JSON.stringify(ev)).not.toContain("new feature"); // no content in events
  });

  it("T16: task failure without mutation is replay-eligible but not replayed; head unchanged", async () => {
    const r = await submit("task_failure");
    lifecycle.start();
    const done = await lifecycle.waitForTerminal(r.runId);
    expect(done.state).toBe("FAILED");
    expect(done.failure_code).toBe("TOOL_FAILURE");
    expect(rules(r.runId)).toEqual(["T4", "T5", "T9", "T13", "T16"]);
    const assess = events(r.runId).find((e) => e.type === "workspace_assessment")?.p;
    expect(assess).toMatchObject({ mutated: false, replay_eligible: true, retry_eligible: false, auto_retry: false });
    expect(ledger.listRunsForMetaSession(r.metaSessionId)).toHaveLength(1);
    expect(artifactKinds(r.runId)).toContain("diff");
  });

  it("a retryable code on a clean workspace is retry-eligible and gets a linked successor (T6.5; FR-CAP-05)", async () => {
    const r = await submit("rate_limit");
    lifecycle.start();
    const done = await lifecycle.waitForTerminal(r.runId);
    expect(done.failure_code).toBe("RATE_LIMIT_TRANSIENT");
    const assess = events(r.runId).find((e) => e.type === "workspace_assessment")?.p;
    expect(assess).toMatchObject({ mutated: false, retry_eligible: true, auto_retry: true });
    // Detailed retry behaviour is in retry.test.ts; here only the link (LLD §16.5).
    const successor = ledger.listRunsForMetaSession(r.metaSessionId)[1];
    expect(successor).toMatchObject({ parent_run_id: r.runId, attempt: 2 });
  });

  it("mutated failure: evidence checkpoint and diff kept, head rolled back to the pre-run checkpoint, never replayed", async () => {
    const r = await submit("partial_mutation");
    lifecycle.start();
    const done = await lifecycle.waitForTerminal(r.runId);
    expect(done.state).toBe("FAILED");
    expect(done.failure_code).toBe("TOOL_FAILURE");
    const ev = events(r.runId);
    expect(ev.find((e) => e.type === "workspace_assessment")?.p).toMatchObject({
      mutated: true,
      replay_eligible: false,
      retry_eligible: false,
    });
    const base = g(repo, "rev-parse", "HEAD");
    expect(ev.find((e) => e.type === "rollback")?.p.head).toBe(base);
    expect(sessionRow(r.metaSessionId)).toEqual({ head_commit: base, lease_run_id: null });
    // Evidence commit is on the run's controller branch.
    const branch = `switchboard/${r.metaSessionId}/${r.runId}`;
    expect(g(repo, "show", `${branch}:partial.txt`)).toBe("half-written");
    expect(ledger.listRunsForMetaSession(r.metaSessionId)).toHaveLength(1);

    // A continuation starts from the rolled-back head, not from the mutated state.
    const next = await submit("writer", { metaSessionId: r.metaSessionId, workspace: undefined });
    const nextDone = await lifecycle.waitForTerminal(next.runId);
    expect(nextDone.state).toBe("SUCCEEDED");
    expect(existsSync(path.join(nextDone.worktree_path as string, "partial.txt"))).toBe(false);
  });

  it("T8: auth missing at preflight ends FAILED/AUTH_REQUIRED naming the native login command, no worktree", async () => {
    adapter.authScenario = "auth_missing";
    const r = await submit("success");
    lifecycle.start();
    const done = await lifecycle.waitForTerminal(r.runId);
    expect(done.state).toBe("FAILED");
    expect(done.failure_code).toBe("AUTH_REQUIRED");
    expect(done.failure_detail).toContain("fake-cli login");
    expect(rules(r.runId)).toEqual(["T4", "T8"]);
    expect(done.worktree_path).toBeNull();
  });

  it("T8: a failed probe step ends FAILED/ELIGIBILITY_NONE", async () => {
    adapter.probe = async () => ({ binaryPath: "/nope", binaryVersion: null, steps: [{ step: "binary", ok: false }] });
    const r = await submit("success");
    lifecycle.start();
    const done = await lifecycle.waitForTerminal(r.runId);
    expect(done.failure_code).toBe("ELIGIBILITY_NONE");
    expect(done.failure_detail).toContain("binary");
    expect(rules(r.runId)).toEqual(["T4", "T8"]);
  });

  it("T10: a profile the adapter cannot compile ends FAILED/ELIGIBILITY_NONE (BR-3) and releases the lease", async () => {
    // T3.7 change: until T3.7 this ended PERMISSION_BLOCKED (ROADMAP §6.2.1). A compile Ineligible is not a denial;
    // FRD BR-3 / LLD §2 map PROFILE_UNSUPPORTED to ELIGIBILITY_NONE, with the reason in the transition event.
    adapter.compileOverride = () => ({ ineligible: true, reason: "PROFILE_UNSUPPORTED", detail: "no" });
    const r = await submit("success");
    lifecycle.start();
    const done = await lifecycle.waitForTerminal(r.runId);
    expect(done.failure_code).toBe("ELIGIBILITY_NONE");
    expect(done.failure_detail).toContain("PROFILE_UNSUPPORTED: no");
    expect(rules(r.runId)).toEqual(["T4", "T5", "T10"]);
    expect(events(r.runId).at(-1)?.p).toMatchObject({
      reason: "PROFILE_UNSUPPORTED",
      stage: "compile",
      eligibility: [{ code: "PROFILE_UNSUPPORTED", detail: "no" }],
    });
    expect(sessionRow(r.metaSessionId).lease_run_id).toBeNull();
    expect(done.pid).toBeNull();
  });

  describe("compile-time Ineligible with stage-1 eligibility (T3.7, FRD BR-3, T8, T10)", () => {
    const passGate: NonNullable<RunLifecycleOptions["eligibility"]>["gate"] = (id) => ({
      eligible: true,
      evidence: { provider: id, observedVersion: "x", validatedRange: "test", validatedCliVersion: "test" },
    });
    beforeEach(async () => {
      await lifecycle.shutdown();
      lifecycle = makeLifecycle({ eligibility: { platform: "linux", gate: passGate } });
    });

    it("a race-time compile Ineligible at LEASED (preflight passed) ends FAILED with the BR-3 code and the reason", async () => {
      // Preflight's compile check (runId "route-check") passes; the LEASED compile refuses: the race §6.2.1 described.
      adapter.compileOverride = (req, inv) =>
        req.runId === "route-check" ? inv : { ineligible: true, reason: "CAPABILITY_MISSING", detail: "raced" };
      const r = await submit("success");
      lifecycle.start();
      const done = await lifecycle.waitForTerminal(r.runId);
      expect(done).toMatchObject({ state: "FAILED", failure_code: "ELIGIBILITY_NONE", pid: null });
      expect(done.failure_detail).toContain("CAPABILITY_MISSING: raced");
      expect(rules(r.runId)).toEqual(["T4", "T5", "T10"]);
      expect(events(r.runId).at(-1)?.p).toMatchObject({
        to: "FAILED",
        reason: "CAPABILITY_MISSING",
        stage: "compile",
        eligibility: [{ code: "CAPABILITY_MISSING", detail: "raced" }],
      });
      expect(sessionRow(r.metaSessionId).lease_run_id).toBeNull();
    });

    it("a compile Ineligible at PREFLIGHT ends FAILED/ELIGIBILITY_NONE (T8) with the reason, no lease or worktree", async () => {
      adapter.compileOverride = () => ({ ineligible: true, reason: "PROFILE_UNSUPPORTED", detail: "not here" });
      const r = await submit("success");
      lifecycle.start();
      const done = await lifecycle.waitForTerminal(r.runId);
      expect(done).toMatchObject({ state: "FAILED", failure_code: "ELIGIBILITY_NONE", worktree_path: null, pid: null });
      expect(rules(r.runId)).toEqual(["T4", "T8"]);
      expect(events(r.runId).at(-1)?.p).toMatchObject({
        eligibility: [{ code: "PROFILE_UNSUPPORTED", detail: "not here" }],
      });
    });

    it("an adapter AUTH_REQUIRED or VERSION_UNVERIFIED from compile keeps its own BR-3 code", async () => {
      adapter.compileOverride = (req, inv) =>
        req.runId === "route-check" ? inv : { ineligible: true, reason: "VERSION_UNVERIFIED", detail: "moved" };
      const r = await submit("success");
      lifecycle.start();
      expect(await lifecycle.waitForTerminal(r.runId)).toMatchObject({
        failure_code: "ADAPTER_VERSION_UNVERIFIED",
      });
    });

    it("preflight compiles the run's frozen snapshot, not a fresh resolution", async () => {
      // The resolver drifts after admission (e.g. a config reload); both compiles must still see the stored snapshot.
      let drift = false;
      await lifecycle.shutdown();
      lifecycle = makeLifecycle({
        eligibility: { platform: "linux", gate: passGate },
        resolveProfile: (n) => ({ ...profileFor(n), ...(drift ? { shell: "broad" as const } : {}) }),
      });
      const seen: string[] = [];
      const compile = adapter.compile.bind(adapter);
      adapter.compile = (req, profile) => {
        seen.push(`${req.runId === "route-check" ? "preflight" : "leased"}:${profile.shell}`);
        return compile(req, profile);
      };
      const r = await submit("success");
      drift = true;
      lifecycle.start();
      expect((await lifecycle.waitForTerminal(r.runId)).state).toBe("SUCCEEDED");
      expect(seen).toEqual(["preflight:none", "leased:none"]);
    });
  });

  it("T10: a spawn error ends FAILED/PROCESS_CRASH", async () => {
    adapter.compileOverride = (_req, inv) => ({ ...inv, argv: [path.join(root, "no-such-binary")] });
    const r = await submit("success");
    lifecycle.start();
    const done = await lifecycle.waitForTerminal(r.runId);
    expect(done.failure_code).toBe("PROCESS_CRASH");
    expect(rules(r.runId)).toEqual(["T4", "T5", "T10"]);
    expect(sessionRow(r.metaSessionId).lease_run_id).toBeNull();
  });

  it("T10: a bypass flag in the compiled invocation is refused before spawn", async () => {
    adapter.compileOverride = (_req, inv) => ({ ...inv, policyFlags: ["--yolo"] });
    const r = await submit("success");
    lifecycle.start();
    const done = await lifecycle.waitForTerminal(r.runId);
    expect(done.failure_code).toBe("PERMISSION_BLOCKED");
    expect(done.pid).toBeNull();
  });

  it("T13: timeout and malformed output end FAILED with their codes via FINALIZING", async () => {
    const hang = await submit("hang");
    const bad = await submit("malformed_output");
    lifecycle.start();
    const [h, b] = await Promise.all([lifecycle.waitForTerminal(hang.runId), lifecycle.waitForTerminal(bad.runId)]);
    expect(h.failure_code).toBe("PROCESS_TIMEOUT");
    expect(b.failure_code).toBe("OUTPUT_PROTOCOL_ERROR");
    expect(rules(hang.runId)).toEqual(["T4", "T5", "T9", "T13", "T16"]);
    expect(groupAlive(h.pgid as number)).toBe(false);
  }, 20_000);

  it("inspect-untrusted runs read-only: no worktree, no lease, no diff", async () => {
    const r = await submit("success", { trustProfile: "inspect-untrusted" });
    lifecycle.start();
    const done = await lifecycle.waitForTerminal(r.runId);
    expect(done.state).toBe("SUCCEEDED");
    expect(done.worktree_path).toBeNull();
    expect(artifactKinds(r.runId)).toEqual(["provider_stderr", "provider_stdout"]);
  });

  it("isolates a controller-side failure to its run (NFR-REL-02)", async () => {
    adapter.onCompile = (req) => {
      if (req.objective === "explode") throw new Error("boom");
    };
    const bad = await submit("explode");
    const good = await submit("success");
    lifecycle.start();
    const [b, ok] = await Promise.all([lifecycle.waitForTerminal(bad.runId), lifecycle.waitForTerminal(good.runId)]);
    expect(b.failure_code).toBe("TOOL_FAILURE");
    expect(b.failure_detail).toContain("boom");
    expect(ok.state).toBe("SUCCEEDED");
    expect(sessionRow(bad.metaSessionId).lease_run_id).toBeNull();
  });
});

describe("cancellation (WF-4, FRD §4.3)", () => {
  it("T19 from QUEUED: CANCELLED at once with no workspace", async () => {
    const r = await submit("success");
    expect(await lifecycle.cancel(r.runId)).toBe("CANCELLED");
    expect(rules(r.runId)).toEqual(["T19"]);
    lifecycle.start();
    await new Promise((res) => setTimeout(res, 30));
    expect(ledger.getRunRecord(r.runId)?.worktree_path).toBeNull();
  });

  it("T19 from PREFLIGHT: the slot is released and nothing is leased", async () => {
    let open: () => void = () => {};
    adapter.probeGate = new Promise((res) => {
      open = res;
    });
    const r = await submit("success");
    lifecycle.start();
    await until(() => ledger.getRunRecord(r.runId)?.state === "PREFLIGHT");
    expect(await lifecycle.cancel(r.runId)).toBe("PREFLIGHT");
    open();
    const done = await lifecycle.waitForTerminal(r.runId);
    expect(done.state).toBe("CANCELLED");
    expect(rules(r.runId)).toEqual(["T4", "T19"]);
    expect(done.worktree_path).toBeNull();
  });

  it("T19 from LEASED: lease released, worktree retained unchanged, no process spawned", async () => {
    let id = "";
    adapter.onCompile = () => {
      void lifecycle.cancel(id);
    };
    const r = await submit("success");
    id = r.runId;
    lifecycle.start();
    const done = await lifecycle.waitForTerminal(r.runId);
    expect(done.state).toBe("CANCELLED");
    expect(rules(r.runId)).toEqual(["T4", "T5", "T19"]);
    expect(done.pid).toBeNull();
    expect(sessionRow(r.metaSessionId).lease_run_id).toBeNull();
    expect(existsSync(done.worktree_path as string)).toBe(true);
  });

  it("T13/T17 from RUNNING: kills the whole process group and ends CANCELLED via FINALIZING", async () => {
    const r = await submit("hang_ignore_term");
    lifecycle.start();
    await until(() => ledger.getRunRecord(r.runId)?.state === "RUNNING");
    const running = ledger.getRunRecord(r.runId);
    expect(groupAlive(running?.pgid as number)).toBe(true);
    await lifecycle.cancel(r.runId);
    const done = await lifecycle.waitForTerminal(r.runId);
    expect(done.state).toBe("CANCELLED");
    expect(done.failure_code).toBeNull();
    expect(rules(r.runId)).toEqual(["T4", "T5", "T9", "T13", "T17"]);
    expect(groupAlive(done.pgid as number)).toBe(false);
    const fin = events(r.runId).find((e) => e.p.to === "FINALIZING");
    expect(fin?.p).toMatchObject({ pending: "cancelled", group_empty: true });
    expect(sessionRow(r.metaSessionId).lease_run_id).toBeNull();
    // Cancelling a terminal run is a no-op (BR-11); an unknown id is INVALID_REQUEST.
    expect(await lifecycle.cancel(r.runId)).toBe("CANCELLED");
    await expect(lifecycle.cancel("run_00000000000000000000000000")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  }, 20_000);
});

describe("acp-stdio runs (T4.8, ADR-0036)", () => {
  const fixtureFor = (steps: unknown[]) => {
    const f = path.join(root, `acp-fixture-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify({ steps }));
    return f;
  };
  const SID = "acp-sess-1";
  const head = [
    { recv: "initialize", reply: { result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } } },
    { recv: "session/new", reply: { result: { sessionId: SID } } },
    { recv: "session/prompt" },
  ];
  const end = { reply_to: "session/prompt", result: { stopReason: "end_turn" } };

  it("records acp_initialized and acp_request_refused, and succeeds", async () => {
    const fixture = fixtureFor([
      ...head,
      { send: { id: 5, method: "fs/read_text_file", params: { sessionId: SID, path: "/etc/passwd" } } },
      { recv_response: 5 },
      end,
    ]);
    const acpAdapter = new FakeAdapter({ acp: { fixture }, timeouts: PATIENT });
    lifecycle = makeLifecycle({ adapters: new AdapterRegistry().register(acpAdapter) });
    lifecycle.start();
    const r = await submit("acp task");
    expect((await lifecycle.waitForTerminal(r.runId)).state).toBe("SUCCEEDED");
    const types = events(r.runId).map((e) => e.type);
    expect(types).toContain("acp_initialized");
    expect(events(r.runId).find((e) => e.type === "acp_request_refused")?.p).toEqual({ method: "fs/read_text_file" });
  }, 30_000);

  it("a permission request outside the profile ends PERMISSION_BLOCKED with an acp_permission event", async () => {
    const fixture = fixtureFor([
      ...head,
      {
        send: {
          id: 6,
          method: "session/request_permission",
          params: {
            sessionId: SID,
            toolCall: { toolCallId: "t1", kind: "execute" },
            options: [
              { optionId: "a", name: "Allow", kind: "allow_once" },
              { optionId: "r", name: "Reject", kind: "reject_once" },
            ],
          },
        },
      },
      { recv_response: 6 },
      end,
    ]);
    const acpAdapter = new FakeAdapter({ acp: { fixture }, timeouts: PATIENT });
    lifecycle = makeLifecycle({ adapters: new AdapterRegistry().register(acpAdapter) });
    lifecycle.start();
    const r = await submit("acp task");
    const final = await lifecycle.waitForTerminal(r.runId);
    expect(final.state).toBe("FAILED");
    expect(final.failure_code).toBe("PERMISSION_BLOCKED");
    expect(events(r.runId).find((e) => e.type === "acp_permission")?.p).toMatchObject({
      tool_kind: "execute",
      decision: "reject_once",
    });
  }, 30_000);
});

describe("pre-spawn refusals (ADR-0039, Q-62, Q-63)", () => {
  const ENV = { PATH: process.env.PATH ?? "" };
  /** The provider id is switched on the shared test adapter: the refusal tables are keyed by real provider ids. */
  const asProvider = (id: string, over: Partial<RunLifecycleOptions> = {}) => {
    (adapter as { id: string }).id = id;
    lifecycle = makeLifecycle(over);
  };
  const run = (runId: string) => {
    const r = ledger.getRunRecord(runId);
    if (!r) throw new Error("no run");
    return r;
  };
  /** No process was spawned: no pid, and the run never reached RUNNING. */
  const neverSpawned = (runId: string) => {
    expect(run(runId).pid).toBeNull();
    expect(path_(runId)).not.toContain("RUNNING");
  };
  const failureReason = (runId: string) =>
    events(runId)
      .filter((e) => e.type === "state_transition" && e.p.to === "FAILED")
      .map((e) => e.p.reason)[0];
  const commitAgentConfig = () => {
    mkdirSync(path.join(repo, ".agents"));
    writeFileSync(path.join(repo, ".agents", "mcp_config.json"), "{}\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "agent config");
  };
  const approve = (runId: string) => {
    const approval = ledger.getApprovalForRun(runId);
    ledger.decideApproval({ id: approval?.id as string, status: "APPROVED", decidedBy: "op" });
    approveDirect(runId);
  };

  describe("working directory reaching provider state", () => {
    it("refuses a run whose working directory contains a provider state directory", async () => {
      asProvider("grok", { baseEnv: { ...ENV, HOME: repo } });
      lifecycle.start();
      const r = await submit("writer", { provider: "grok", trustProfile: "inspect-untrusted" });
      const done = await lifecycle.waitForTerminal(r.runId);
      expect(done).toMatchObject({ state: "FAILED", failure_code: "PERMISSION_BLOCKED" });
      expect(done.failure_detail).toMatch(/working directory .* contains .*\/\.(claude|codex|grok)/);
      expect(failureReason(r.runId)).toBe("PROVIDER_STATE_REACHABLE");
      expect(compiles).toBe(1);
      neverSpawned(r.runId);
      expect(existsSync(path.join(repo, "feature.txt"))).toBe(false);
    });

    it("refuses a run whose working directory is inside a provider state directory", async () => {
      const home = path.join(root, "home");
      const inside = path.join(home, ".claude", "proj");
      mkdirSync(inside, { recursive: true });
      asProvider("claude", { baseEnv: { ...ENV, HOME: home } });
      lifecycle.start();
      const r = await submit("writer", { provider: "claude", trustProfile: "inspect-untrusted", workspace: inside });
      const done = await lifecycle.waitForTerminal(r.runId);
      expect(done).toMatchObject({ state: "FAILED", failure_code: "PERMISSION_BLOCKED" });
      expect(done.failure_detail).toContain("is inside");
      expect(failureReason(r.runId)).toBe("PROVIDER_STATE_REACHABLE");
      neverSpawned(r.runId);
      expect(existsSync(path.join(inside, "feature.txt"))).toBe(false);
    });

    it("admits the same run when no provider state directory is reachable", async () => {
      asProvider("grok", { baseEnv: { ...ENV, HOME: path.join(root, "elsewhere") } });
      lifecycle.start();
      const r = await submit("writer", { provider: "grok", trustProfile: "edit-untrusted" });
      expect((await lifecycle.waitForTerminal(r.runId)).state).toBe("SUCCEEDED");
    });
  });

  describe("repository-local agent config", () => {
    beforeEach(() => {
      commitAgentConfig();
    });

    it("refuses an edit-untrusted run whose worktree holds repo-local agent config, before spawn", async () => {
      asProvider("antigravity", { baseEnv: { ...ENV, HOME: path.join(root, "elsewhere") } });
      lifecycle.start();
      const r = await submit("writer", { provider: "antigravity" });
      const done = await lifecycle.waitForTerminal(r.runId);
      expect(done).toMatchObject({ state: "FAILED", failure_code: "PERMISSION_BLOCKED" });
      expect(done.failure_detail).toContain(".agents/mcp_config.json");
      expect(done.failure_detail).toContain("repoConfig is disabled");
      expect(failureReason(r.runId)).toBe("REPO_AGENT_CONFIG_REFUSED");
      neverSpawned(r.runId);
    });

    it("does not refuse a provider whose repo-local paths are not listed", async () => {
      asProvider("fake", { baseEnv: { ...ENV, HOME: path.join(root, "elsewhere") } });
      lifecycle.start();
      const r = await submit("writer");
      expect((await lifecycle.waitForTerminal(r.runId)).state).toBe("SUCCEEDED");
    });

    it("admits the run under an approved scope whose repository_config is `approved`", async () => {
      adapter.privilegedAs = "edit-untrusted";
      asProvider("antigravity", { baseEnv: { ...ENV, HOME: path.join(root, "elsewhere") } });
      const r = await submit("writer", {
        provider: "antigravity",
        trustProfile: "privileged",
        privileged: { scope: { ...SCOPE, bypass: false } },
      });
      approve(r.runId);
      lifecycle.start();
      const done = await lifecycle.waitForTerminal(r.runId);
      expect(done.state).toBe("SUCCEEDED");
      expect(done.failure_code).toBeNull();
    });

    it("admits the run under an approved scope whose repository_config is `enabled`", async () => {
      adapter.privilegedAs = "edit-untrusted";
      asProvider("antigravity", { baseEnv: { ...ENV, HOME: path.join(root, "elsewhere") } });
      const r = await submit("writer", {
        provider: "antigravity",
        trustProfile: "privileged",
        privileged: { scope: { ...SCOPE, bypass: false, repository_config: { mode: "enabled" } } },
      });
      approve(r.runId);
      lifecycle.start();
      expect((await lifecycle.waitForTerminal(r.runId)).state).toBe("SUCCEEDED");
    });

    it("still refuses under an approved scope whose repository_config is `disabled`", async () => {
      adapter.privilegedAs = "edit-untrusted";
      asProvider("antigravity", { baseEnv: { ...ENV, HOME: path.join(root, "elsewhere") } });
      const r = await submit("writer", {
        provider: "antigravity",
        trustProfile: "privileged",
        privileged: { scope: { ...SCOPE, bypass: false, repository_config: { mode: "disabled" } } },
      });
      approve(r.runId);
      lifecycle.start();
      const done = await lifecycle.waitForTerminal(r.runId);
      expect(done).toMatchObject({ state: "FAILED", failure_code: "PERMISSION_BLOCKED" });
      expect(failureReason(r.runId)).toBe("REPO_AGENT_CONFIG_REFUSED");
      neverSpawned(r.runId);
    });
  });
});
