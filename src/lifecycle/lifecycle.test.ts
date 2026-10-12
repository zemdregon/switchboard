import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScenario } from "../adapters/fake/adapter.js";
import {
  AdapterRegistry,
  type CompileRequest,
  type Ineligible,
  type Invocation,
  type ProbeRunner,
  type ProviderAdapter,
  type ResolvedProfile,
} from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { groupAlive } from "../exec/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunState, type TrustProfile } from "../ledger/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import {
  assertTransition,
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

const SHORT = { wallClockMs: 15_000, idleMs: 5_000, killGraceMs: 300 };

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
  probeGate: Promise<void> | undefined;
  authScenario: FakeScenario = "success";
  onCompile: ((req: CompileRequest) => void) | undefined;
  compileOverride: ((req: CompileRequest, inv: Invocation) => Invocation | Ineligible) | undefined;
  private readonly base = new FakeAdapter({ timeouts: SHORT });

  constructor(
    private readonly writerScript: string,
    private readonly usageScript = writerScript,
  ) {}

  private forScenario(s: Scenario): FakeAdapter {
    if (s === "writer-usage") return new FakeAdapter({ script: this.usageScript, timeouts: SHORT });
    if (s === "writer") return new FakeAdapter({ script: this.writerScript, timeouts: SHORT });
    return new FakeAdapter({ scenario: s, timeouts: SHORT });
  }

  async probe(runner: ProbeRunner) {
    if (this.probeGate) await this.probeGate;
    return this.base.probe(runner);
  }
  authPreflight(runner: ProbeRunner) {
    return new FakeAdapter({ scenario: this.authScenario }).authPreflight(runner);
  }
  compile(req: CompileRequest, profile: ResolvedProfile) {
    this.onCompile?.(req);
    const inv = this.forScenario(req.objective as Scenario).compile(req, profile);
    if (this.compileOverride && !("ineligible" in inv)) return this.compileOverride(req, inv);
    return inv;
  }
  parseEvent: ProviderAdapter["parseEvent"] = (i, s) => this.base.parseEvent(i, s);
  extractResult: ProviderAdapter["extractResult"] = (e, x) => this.base.extractResult(e, x);
  resumeArgs: ProviderAdapter["resumeArgs"] = (b, r, p) => this.base.resumeArgs(b, r, p);
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
    const r = await submit("success", { trustProfile: "privileged" });
    expect(r.state).toBe("AWAITING_APPROVAL");
    lifecycle.start();
    await new Promise((res) => setTimeout(res, 50));
    expect(ledger.getRunRecord(r.runId)?.state).toBe("AWAITING_APPROVAL");
    expect(await lifecycle.cancel(r.runId)).toBe("CANCELLED");
    expect(rules(r.runId)).toEqual(["T19"]);
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

  it("a retryable code on a clean workspace is recorded as retry-eligible, but M1 creates no successor (FR-CAP-05 is M6)", async () => {
    const r = await submit("rate_limit");
    lifecycle.start();
    const done = await lifecycle.waitForTerminal(r.runId);
    expect(done.failure_code).toBe("RATE_LIMIT_TRANSIENT");
    const assess = events(r.runId).find((e) => e.type === "workspace_assessment")?.p;
    expect(assess).toMatchObject({ mutated: false, retry_eligible: true, auto_retry: false });
    await new Promise((res) => setTimeout(res, 50));
    expect(ledger.listRunsForMetaSession(r.metaSessionId)).toHaveLength(1);
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

  it("T10: a profile the adapter cannot compile ends FAILED/PERMISSION_BLOCKED and releases the lease", async () => {
    adapter.compileOverride = () => ({ ineligible: true, reason: "PROFILE_UNSUPPORTED", detail: "no" });
    const r = await submit("success");
    lifecycle.start();
    const done = await lifecycle.waitForTerminal(r.runId);
    expect(done.failure_code).toBe("PERMISSION_BLOCKED");
    expect(rules(r.runId)).toEqual(["T4", "T5", "T10"]);
    expect(sessionRow(r.metaSessionId).lease_run_id).toBeNull();
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
