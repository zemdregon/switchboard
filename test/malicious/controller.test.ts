/**
 * Malicious-fixture suite, controller leg (T3.8; NFR-SEC-03 controller leg, FR-POL-04, FR-EXE-07, FR-WS-05, FR-TEL-03,
 * NFR-SEC-01; TDD §3.4, §3.6). A hostile-looking fixture repository (./fixture.ts) is driven through the REAL lifecycle
 * and MCP surface with the existing benign fake-provider scenarios. Every assertion is about the controller's own
 * invariants; nothing here makes the fake provider attack anything (adversarial scenarios are T3.8b, owner-reviewed).
 *
 * Where a test needs workspace content the fake CLI does not produce (symlinks pointing outside the repository), the
 * TEST HARNESS writes it into the run's worktree after the controller created it and before the fake provider starts,
 * standing in for "whatever the run left behind"; the fake provider itself only runs its normal scenario.
 *
 * Every detector has a positive control in "positive controls" below that plants what it looks for and shows it fires.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScenario } from "../../src/adapters/fake/adapter.js";
import {
  AdapterRegistry,
  type CompileRequest,
  type Ineligible,
  type Invocation,
  type ProbeRunner,
  type ProviderAdapter,
  type ResolvedProfile,
  type VersionGateResult,
} from "../../src/adapters/index.js";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { createIdGenerator } from "../../src/ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRecord, type TrustProfile } from "../../src/ledger/index.js";
import { RunLifecycle } from "../../src/lifecycle/index.js";
import { createSwitchboardServer, type SwitchboardMcpServer } from "../../src/mcp/index.js";
import { driverOverrides, GitError, git, gitText } from "../../src/workspace/git.js";
import { WorkspaceManager } from "../../src/workspace/index.js";
import {
  envLeaks,
  findTokens,
  ledgerDump,
  newRefs,
  operatorState,
  readIfExists,
  refs,
  treeHash,
  treeText,
} from "./detectors.js";
import {
  buildMaliciousFixture,
  configureFilterDrivers,
  FILTER_DRIVER,
  type MaliciousFixture,
  plainGit,
  type TokenRole,
  tg,
} from "./fixture.js";

const SHORT = { wallClockMs: 15_000, idleMs: 5_000, killGraceMs: 300 };
const TEST_TIMEOUT = 60_000;

/** SRS §3.3 stand-in profiles, as in src/mcp/mcp.test.ts. */
const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: name === "inspect-untrusted" ? "none" : name === "edit-untrusted" ? "allowlist" : "broad",
  ...(name === "edit-untrusted" ? { shellAllowlist: [] } : {}),
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

/**
 * The fake adapter with a per-run scenario. `beforeSpawn` lets the harness place workspace content in the worktree the
 * controller created; `extraAllowlist` exists only for the environment positive control.
 */
class HarnessAdapter implements ProviderAdapter {
  readonly id = "fake" as const;
  readonly transports = ["subprocess-jsonl"] as const;
  readonly gitWriteControl = new FakeAdapter().gitWriteControl;
  readonly resumeCwd = "bound" as const;
  readonly gitCapabilities = { commitChannel: "none", detail: "test double" } as const;
  scenario: FakeScenario = "success";
  beforeSpawn: ((cwd: string) => void) | undefined;
  extraAllowlist: string[] = [];
  worktreesDir: string | undefined;
  /** Environment names the unmodified fake adapter declares (allowlist plus adapter-set variables). */
  declaredEnv: string[] = [];
  private readonly base = new FakeAdapter({ timeouts: SHORT });

  private inner(): FakeAdapter {
    return new FakeAdapter({ scenario: this.scenario, timeouts: SHORT });
  }
  probe(r: ProbeRunner) {
    return this.inner().probe(r);
  }
  authPreflight(r: ProbeRunner) {
    return this.inner().authPreflight(r);
  }
  private prepared(inv: Invocation | Ineligible, req: CompileRequest): Invocation | Ineligible {
    if ("ineligible" in inv) return inv;
    this.declaredEnv = [...inv.envAllowlist, ...Object.keys(inv.env)];
    // compile also runs for the admission/preflight eligibility check (against the operator path, no worktree yet):
    // place content only in a controller-created run worktree, just before spawn.
    if (this.worktreesDir !== undefined && req.workspace.cwd.startsWith(this.worktreesDir + path.sep)) {
      this.beforeSpawn?.(req.workspace.cwd);
    }
    return { ...inv, envAllowlist: [...inv.envAllowlist, ...this.extraAllowlist] };
  }
  compile(req: CompileRequest, p: ResolvedProfile) {
    return this.prepared(this.inner().compile(req, p), req);
  }
  resumeArgs: ProviderAdapter["resumeArgs"] = (b, req, p) => this.prepared(this.inner().resumeArgs(b, req, p), req);
  parseEvent: ProviderAdapter["parseEvent"] = (i, s) => this.base.parseEvent(i, s);
  extractResult: ProviderAdapter["extractResult"] = (e, x) => this.base.extractResult(e, x);
  classifyFailure: ProviderAdapter["classifyFailure"] = (e) => this.base.classifyFailure(e);
}

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON checked by the published output schemas
type Json = Record<string, any>;

interface RunOutcome {
  readonly runId: string;
  readonly metaSessionId: string;
  readonly envelope: Json;
  readonly artifacts: Json[];
  readonly record: RunRecord;
}

interface Harness {
  readonly fx: MaliciousFixture;
  readonly db: Database.Database;
  readonly ledger: Ledger;
  readonly artifacts: ArtifactStore;
  readonly workspace: WorkspaceManager;
  readonly adapter: HarnessAdapter;
  /** Text of every MCP tool result this harness received. */
  readonly mcpTexts: string[];
  call(name: string, args: Json): Promise<{ isError: boolean; body: Json }>;
  delegate(scenario: FakeScenario, beforeSpawn?: (cwd: string) => void): Promise<RunOutcome>;
  cont(metaSessionId: string, scenario: FakeScenario): Promise<RunOutcome>;
  close(): Promise<void>;
}

async function openHarness(): Promise<Harness> {
  const fx = buildMaliciousFixture();
  // Controller process environment: a FAKE home and a canary secret variable (restored in close()).
  const savedHome = process.env.HOME;
  process.env.HOME = fx.fakeHome;
  process.env[fx.envCanaryName] = fx.tokens.env_secret;

  const db = openLedger(fx.dataDir);
  const ids = createIdGenerator();
  const ledger = createLedger(db, { ids });
  const artifacts = new ArtifactStore(path.join(fx.dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir: fx.dataDir, allowedRoots: [fx.allowedRoot], ids });
  const adapter = new HarnessAdapter();
  adapter.worktreesDir = path.join(fx.dataDir, "worktrees");
  const registry = new AdapterRegistry().register(adapter);
  const gate = (id: string, version: string | null): VersionGateResult => ({
    eligible: true,
    evidence: { provider: id, observedVersion: version, validatedRange: "test", validatedCliVersion: "test" },
  });
  const lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots: [fx.allowedRoot],
    globalConcurrency: 2,
    resolveProfile: profileFor,
    eligibility: { platform: "linux", gate: gate as AdapterRegistry["gate"] },
  });
  lifecycle.start();
  const config = {
    allowedRoots: [fx.allowedRoot],
    mcpClients: new Map([["orchestrator", { id: "orchestrator", maxTrustProfile: "edit-untrusted" as const }]]),
  };
  const mcp: SwitchboardMcpServer = createSwitchboardServer({
    lifecycle,
    ledger,
    artifacts,
    registry,
    config,
    clientId: "orchestrator",
  });
  const client = new Client({ name: "t38", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(serverSide);
  await client.connect(clientSide);
  await client.listTools();

  const mcpTexts: string[] = [];
  const call = async (name: string, args: Json) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
    mcpTexts.push(text, JSON.stringify(res.structuredContent ?? null));
    return { isError: res.isError === true, body: JSON.parse(text) as Json };
  };
  const finish = async (runId: string, metaSessionId: string): Promise<RunOutcome> => {
    const end = Date.now() + 30_000;
    for (;;) {
      const r = await call("get_run", { run_id: runId });
      if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(r.body.status)) break;
      if (Date.now() > end) throw new Error(`run ${runId} did not finish: ${r.body.status}`);
      await new Promise((res) => setTimeout(res, 20));
    }
    const envelope = (await call("get_run", { run_id: runId, include_events: { after_seq: 0, limit: 200 } })).body;
    const arts = (await call("get_artifacts", { run_id: runId, max_inline_bytes: 1_048_576 })).body;
    const record = ledger.getRunRecord(runId);
    if (!record) throw new Error("run vanished");
    return { runId, metaSessionId, envelope, artifacts: (arts.artifacts ?? []) as Json[], record };
  };
  return {
    fx,
    db,
    ledger,
    artifacts,
    workspace,
    adapter,
    mcpTexts,
    call,
    async delegate(scenario, beforeSpawn) {
      adapter.scenario = scenario;
      adapter.beforeSpawn = beforeSpawn;
      const d = await call("delegate_task", {
        objective: `run the ${scenario} scenario`,
        workspace_path: fx.repo,
        trust_profile: "edit-untrusted",
      });
      if (d.isError) throw new Error(`delegate_task failed: ${JSON.stringify(d.body)}`);
      return finish(d.body.run_id, d.body.meta_session_id);
    },
    async cont(metaSessionId, scenario) {
      adapter.scenario = scenario;
      adapter.beforeSpawn = undefined;
      const c = await call("continue_task", { meta_session_id: metaSessionId, instruction: "keep going" });
      if (c.isError) throw new Error(`continue_task failed: ${JSON.stringify(c.body)}`);
      return finish(c.body.run_id, metaSessionId);
    },
    async close() {
      await lifecycle.shutdown();
      await client.close();
      await mcp.close();
      db.close();
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      delete process.env[fx.envCanaryName];
      fx.close();
    },
  };
}

/** Canary tokens found in every controller output: ledger rows, stored artifacts, worktrees (no link following), MCP. */
function leakScan(h: Harness): Record<string, TokenRole[]> {
  return {
    ledger: findTokens(h.fx, ledgerDump(h.db)),
    artifacts: findTokens(h.fx, treeText(path.join(h.fx.dataDir, "artifacts"))),
    worktrees: findTokens(h.fx, treeText(path.join(h.fx.dataDir, "worktrees"))),
    mcp: findTokens(h.fx, h.mcpTexts.join("\n")),
  };
}
const NO_LEAKS = { ledger: [], artifacts: [], worktrees: [], mcp: [] };

async function streamText(h: Harness, runId: string, kind: "provider_stdout" | "provider_stderr"): Promise<string> {
  const row = h.db.prepare("SELECT sha256 FROM artifact WHERE run_id = ? AND kind = ?").get(runId, kind) as
    | { sha256: string }
    | undefined;
  if (!row) throw new Error(`no ${kind} artifact for ${runId}`);
  return (await h.artifacts.get(row.sha256)).toString("utf8");
}

/** Symlinks pointing outside the repository (absolute, `..`-relative, into the fake home, at a directory). */
function linkPlanter(fx: MaliciousFixture, prefix: string) {
  const targets: string[] = [];
  const plant = (cwd: string) => {
    const links: [string, string][] = [
      [`${prefix}-abs`, fx.outsideSentinel],
      [`${prefix}-home`, fx.codexAuthPath],
      [`${prefix}-rel`, path.relative(cwd, fx.outsideSentinel)],
      [`${prefix}-dir`, fx.outsideDir],
    ];
    for (const [name, target] of links) {
      symlinkSync(target, path.join(cwd, name));
      targets.push(target);
    }
  };
  return { plant, targets };
}

const diffTexts = (run: RunOutcome): string[] =>
  run.artifacts.filter((a) => a.kind === "diff").map((a) => String(a.inline_text ?? ""));

describe("T3.8 controller invariants on a hostile fixture repository", () => {
  let h: Harness;
  let before: ReturnType<typeof operatorState>;
  let beforeAllRefs: Record<string, string>;
  let outsideHash: string;
  let homeHash: string;
  const runs: Record<string, RunOutcome> = {};
  let successLinks: ReturnType<typeof linkPlanter>;
  let failedLinks: ReturnType<typeof linkPlanter>;
  let rollbackDiff = "";

  beforeAll(async () => {
    h = await openHarness();
    const { fx } = h;
    before = operatorState(fx);
    beforeAllRefs = refs(fx.repo);
    outsideHash = treeHash(fx.outsideDir);
    homeHash = treeHash(fx.fakeHome);

    // The existing benign scenarios, end to end through MCP: success, a continuation, failures and mutations.
    runs.success = await h.delegate("success");
    runs.continuation = await h.cont(runs.success.metaSessionId, "success");
    runs.env = await h.delegate("env_report");
    runs.taskFailure = await h.delegate("task_failure");
    runs.malformed = await h.delegate("malformed_output");
    runs.rateLimit = await h.delegate("rate_limit");
    runs.partial = await h.delegate("partial_mutation");
    successLinks = linkPlanter(fx, "leak-ok");
    runs.successLinks = await h.delegate("success", successLinks.plant);
    failedLinks = linkPlanter(fx, "leak-failed");
    runs.partialLinks = await h.delegate("partial_mutation", failedLinks.plant);

    // Explicit rollback of the failed run's worktree (FR-WS-04) with one more untracked outside-pointing link.
    const wt = runs.partialLinks.record.worktree_path as string;
    symlinkSync(fx.claudeCredentialsPath, path.join(wt, "leak-late"));
    const rb = await h.workspace.rollback(runs.partialLinks.runId);
    const sha = (h.db.prepare("SELECT sha256 FROM artifact WHERE id = ?").get(rb.diffArtifactId) as { sha256: string })
      .sha256;
    rollbackDiff = (await h.artifacts.get(sha)).toString("latin1");
    // Re-read every run's MCP view after the rollback, so its artifact is part of the MCP scan too.
    for (const r of Object.values(runs))
      await h.call("get_artifacts", { run_id: r.runId, max_inline_bytes: 1_048_576 });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it("ran the scenarios the suite relies on", () => {
    const status = Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, r.envelope.status]));
    expect(status).toEqual({
      success: "SUCCEEDED",
      continuation: "SUCCEEDED",
      env: "SUCCEEDED",
      taskFailure: "FAILED",
      malformed: "FAILED",
      rateLimit: "FAILED",
      partial: "FAILED",
      successLinks: "SUCCEEDED",
      partialLinks: "FAILED",
    });
    for (const r of Object.values(runs)) expect(r.record.worktree_path).not.toBeNull();
  });

  it("(1) FR-EXE-07: the provider child gets only allowlisted environment names; the canary variable and HOME are absent", async () => {
    const stdout = await streamText(h, runs.env?.runId as string, "provider_stdout");
    const leaks = envLeaks(stdout, h.adapter.declaredEnv);
    expect(leaks).toEqual([]); // `undefined` would mean no report at all
    expect(stdout).not.toContain(h.fx.envCanaryName);
    expect(stdout).not.toMatch(/"HOME"/);
    expect(findTokens(h.fx, stdout)).toEqual([]);
  });

  it("(2) FR-WS-05: operator refs, HEAD, index, working tree, config, hooks and remote are unchanged", () => {
    expect(operatorState(h.fx)).toEqual(before);
    const added = newRefs(beforeAllRefs, refs(h.fx.repo));
    expect(added.length).toBeGreaterThan(0);
    for (const r of added) expect(r).toMatch(/^refs\/heads\/switchboard\/sess_[0-9A-Za-z]+\/run_[0-9A-Za-z]+$/);
    // No existing ref moved, the operator's branch included.
    for (const [name, sha] of Object.entries(beforeAllRefs)) expect(refs(h.fx.repo)[name]).toBe(sha);
  });

  it("(3) TDD §3.4: controller Git (worktree add, status, diff, checkpoint commit, rollback) never runs repository hooks or fsmonitor", () => {
    expect(readIfExists(h.fx.hookLog)).toBe("");
    // Controller checkpoint commits really happened (so commit hooks had their chance to fire).
    expect(tg(h.fx.repo, "log", "-1", "--format=%an", `refs/heads/${runs.partial?.record.branch}`)).toBe("Switchboard");
  });

  it("(3) FR-POL-04: repository agent configuration (.mcp.json, .claude/settings.json, .codex/config.toml) is never executed", () => {
    expect(readIfExists(h.fx.configLog)).toBe("");
  });

  it("(4) symlinks: diffs and artifacts store link targets only, never the bytes behind an outside-pointing link", () => {
    const ok = diffTexts(runs.successLinks as RunOutcome).join("\n");
    const failed = diffTexts(runs.partialLinks as RunOutcome).join("\n");
    expect(ok).toContain("new file mode 120000");
    for (const t of successLinks.targets) expect(ok).toContain(t);
    for (const t of failedLinks.targets) expect(failed).toContain(t);
    expect(rollbackDiff).toContain(h.fx.claudeCredentialsPath); // the late link, as a target string
    for (const text of [ok, failed, rollbackDiff]) expect(findTokens(h.fx, text)).toEqual([]);
    // Following the links never wrote through them: the outside directory and the fake home are byte-identical.
    expect(treeHash(h.fx.outsideDir)).toBe(outsideHash);
    expect(treeHash(h.fx.fakeHome)).toBe(homeHash);
    // Rollback removed the untracked link without touching its target.
    const wt = runs.partialLinks?.record.worktree_path as string;
    expect(existsSync(path.join(wt, "leak-late"))).toBe(false);
    expect(existsSync(h.fx.claudeCredentialsPath)).toBe(true);
  });

  it("(4)+(5) NFR-SEC-01, FR-TEL-03: no canary token in ledger rows, stored artifacts (provider logs included), worktrees or MCP envelopes", () => {
    expect(h.mcpTexts.length).toBeGreaterThan(0);
    expect(leakScan(h)).toEqual(NO_LEAKS);
  });

  it("(6) FR-POL-10: workspaces outside the allowed roots are refused, including through symlinks and `..`", async () => {
    const { fx } = h;
    // A real Git repository outside the allowed root, reachable through a symlink inside it.
    const outsideRepo = path.join(fx.base, "outside-repo");
    mkdirSync(path.join(outsideRepo, "inner"), { recursive: true });
    tg(outsideRepo, "init", "-q", "-b", "main");
    const sneaky = path.join(fx.allowedRoot, "sneaky-link");
    symlinkSync(outsideRepo, sneaky);
    // Raw, unnormalised `..` segments (path.join would normalise them away before the controller saw them).
    const dotDot = `${fx.repo}/../../outside-repo`;
    const viaLinkDotDot = `${fx.allowedRoot}/repo/links/outside-dir/..`;
    const candidates = [outsideRepo, sneaky, dotDot, viaLinkDotDot, fx.outsideDir];

    const runCount = () => (h.db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n;
    const n0 = runCount();
    for (const ws of candidates) {
      const r = await h.call("delegate_task", { objective: "x", workspace_path: ws, trust_profile: "edit-untrusted" });
      expect(r.isError, ws).toBe(true);
      expect(r.body.error.code, ws).toBe("INVALID_REQUEST");
      await expect(
        h.workspace.prepare({
          metaSessionId: "sess_t38",
          runId: "run_t38",
          workspace: ws,
          trustProfile: "edit-untrusted",
        }),
        ws,
      ).rejects.toMatchObject({ code: "WORKSPACE_NOT_ALLOWED" });
    }
    expect(runCount()).toBe(n0);

    // An allowed root inside a repository whose top level lies outside every allowed root is refused too.
    const nested = new WorkspaceManager({
      db: h.db,
      artifacts: h.artifacts,
      dataDir: fx.dataDir,
      allowedRoots: [fx.allowedRoot, path.join(outsideRepo, "inner")],
    });
    await expect(
      nested.prepare({
        metaSessionId: "sess_t38",
        runId: "run_t38",
        workspace: path.join(outsideRepo, "inner"),
        trustProfile: "edit-untrusted",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_ALLOWED", message: expect.stringMatching(/repository root/) });
    // Nothing was created in the outside repository.
    expect(tg(outsideRepo, "for-each-ref")).toBe("");
    expect(
      tg(outsideRepo, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((l) => l.startsWith("worktree")),
    ).toHaveLength(1);
  });
});

describe("T3.8 repository-configured Git filter and diff drivers", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
    configureFilterDrivers(h.fx);
  });
  afterEach(async () => {
    await h.close();
  });

  // Found by T3.8 (reproduced with Git 2.43): filter drivers (`filter.<name>.clean/smudge/process`) and diff drivers
  // (`diff.<name>.textconv/command`) defined in the operator checkout's local config and selected by a committed
  // `.gitattributes` used to execute inside controller Git operations: smudge on `git worktree add`, clean on
  // `git add -A`, textconv on the `git diff` that builds the diff artifact. src/workspace/git.ts now neutralises every
  // such driver for every controller Git call (TDD §3.4 "Repository hooks, filters and diff drivers"). The positive
  // controls below show each driver really runs under unhardened Git in the same fixture.
  it(
    "controller Git never runs filter (clean/smudge/process) or diff (textconv/external) drivers from repository configuration",
    async () => {
      const run = await h.delegate("success", touchDriverFiles);
      expect(run.envelope.status).toBe("SUCCEEDED");
      expect(readIfExists(h.fx.filterLog)).toBe("");
      // The diff artifact carries the raw bytes (no textconv) of the files the drivers would have handled.
      const diff = diffTexts(run).join("\n");
      expect(diff).toContain("+changed by the run (dat)");
      expect(diff).toContain("+changed by the run (proc)");
      expect(diff).toContain("+new by the run (dat)");
    },
    TEST_TIMEOUT,
  );

  it(
    "nor on the failure and explicit rollback paths (add -A, diff --cached --binary, reset --hard, clean)",
    async () => {
      const run = await h.delegate("partial_mutation", touchDriverFiles);
      expect(run.envelope.status).toBe("FAILED");
      // Explicit rollback of the failed run's worktree (FR-WS-04).
      const rb = await h.workspace.rollback(run.runId);
      const sha = (
        h.db.prepare("SELECT sha256 FROM artifact WHERE id = ?").get(rb.diffArtifactId) as { sha256: string }
      ).sha256;
      expect((await h.artifacts.get(sha)).toString("utf8")).toContain("+changed by the run (dat)");
      expect(readIfExists(h.fx.filterLog)).toBe("");
      const wt = run.record.worktree_path as string;
      expect(readFileSync(path.join(wt, "payload.dat"), "utf8")).toBe("plain data\n");
      expect(existsSync(path.join(wt, "new.dat"))).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "hooks stay disabled and nothing leaks even with the drivers configured",
    async () => {
      const run = await h.delegate("partial_mutation");
      expect(run.envelope.status).toBe("FAILED");
      expect(readIfExists(h.fx.hookLog)).toBe("");
      expect(leakScan(h)).toEqual(NO_LEAKS);
    },
    TEST_TIMEOUT,
  );
});

/** Modify and add files whose attributes select the fixture's filter and diff drivers. */
function touchDriverFiles(cwd: string): void {
  writeFileSync(path.join(cwd, "payload.dat"), "changed by the run (dat)\n");
  writeFileSync(path.join(cwd, "payload.proc"), "changed by the run (proc)\n");
  writeFileSync(path.join(cwd, "new.dat"), "new by the run (dat)\n");
  writeFileSync(path.join(cwd, "new.proc"), "new by the run (proc)\n");
}

describe("T3.8 controller Git runner vs. unhardened Git, operation by operation", () => {
  // Each case runs the controller's runner (src/workspace/git.ts) and then, as its positive control, the same
  // operation through plain Git in the same fixture, which must run the driver.
  let fx: MaliciousFixture;
  const log = () => readIfExists(fx.filterLog);
  const clearLog = () => rmSync(fx.filterLog, { force: true });
  const wtPath = (name: string) => path.join(fx.base, name);
  beforeEach(() => {
    fx = buildMaliciousFixture();
    configureFilterDrivers(fx);
  });
  afterEach(() => {
    fx.close();
  });

  it("worktree add: no smudge or process filter; unhardened Git runs both", async () => {
    await git(["worktree", "add", "-q", "--detach", wtPath("wt-a"), fx.baseCommit], { cwd: fx.repo });
    expect(log()).toBe("");
    expect(readFileSync(path.join(wtPath("wt-a"), "payload.dat"), "utf8")).toBe("plain data\n");
    expect(readFileSync(path.join(wtPath("wt-a"), "payload.proc"), "utf8")).toBe("process data\n");
    plainGit(fx.repo, "worktree", "add", "-q", "--detach", wtPath("wt-b"), fx.baseCommit);
    expect(log()).toMatch(/filter smudge/);
    expect(log()).toMatch(/filter process/);
  });

  it("add -A: no clean or process filter; unhardened Git runs both", async () => {
    await git(["worktree", "add", "-q", "--detach", wtPath("wt"), fx.baseCommit], { cwd: fx.repo });
    touchDriverFiles(wtPath("wt"));
    await git(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: wtPath("wt") });
    await git(["add", "-A"], { cwd: wtPath("wt") });
    expect(log()).toBe("");
    expect(await gitText(["show", ":payload.dat"], { cwd: wtPath("wt") })).toBe("changed by the run (dat)");
    writeFileSync(path.join(wtPath("wt"), "payload.dat"), "changed again (dat)\n");
    writeFileSync(path.join(wtPath("wt"), "payload.proc"), "changed again (proc)\n");
    plainGit(wtPath("wt"), "add", "-A");
    expect(log()).toMatch(/filter clean/);
    expect(log()).toMatch(/filter process/);
  });

  it("diff: no textconv or external diff command; unhardened Git runs both", async () => {
    await git(["worktree", "add", "-q", "--detach", wtPath("wt"), fx.baseCommit], { cwd: fx.repo });
    touchDriverFiles(wtPath("wt"));
    const wt = { cwd: wtPath("wt") };
    expect((await git(["diff", "--quiet", fx.baseCommit], { ...wt, okCodes: [1] })).code).toBe(1);
    await git(["add", "-A"], wt);
    const binary = (await git(["diff", "--cached", "--binary", "--no-color", fx.baseCommit], wt)).stdout.toString();
    expect(binary).toContain("+changed by the run (dat)");
    await git(["diff", "--name-status", "-z", "--no-renames", "--cached", fx.baseCommit], wt);
    expect(log()).toBe("");
    // Positive controls: plain `git diff` runs the external diff command, and with `--no-ext-diff` the textconv.
    plainGit(wtPath("wt"), "diff", "--cached", fx.baseCommit);
    expect(log()).toMatch(/filter extdiff/);
    clearLog();
    plainGit(wtPath("wt"), "diff", "--cached", "--no-ext-diff", fx.baseCommit);
    expect(log()).toMatch(/filter textconv/);
  });

  it("commit, reset --hard, clean, worktree remove and branch -D (finalize, rollback and GC paths) run no driver", async () => {
    await git(["worktree", "add", "-q", "-b", "sb-run", wtPath("wt"), fx.baseCommit], { cwd: fx.repo });
    const wt = { cwd: wtPath("wt") };
    touchDriverFiles(wtPath("wt"));
    await git(["add", "-A"], wt);
    await git(["commit", "--no-verify", "--no-gpg-sign", "-q", "-m", "checkpoint"], wt);
    touchDriverFiles(wtPath("wt"));
    writeFileSync(path.join(wtPath("wt"), "payload.dat"), "dirty (dat)\n");
    await git(["reset", "--hard", fx.baseCommit], wt);
    await git(["clean", "-fd"], wt);
    expect(readFileSync(path.join(wtPath("wt"), "payload.dat"), "utf8")).toBe("plain data\n");
    touchDriverFiles(wtPath("wt"));
    await git(["worktree", "remove", "--force", "--force", wtPath("wt")], { cwd: fx.repo });
    await git(["worktree", "prune"], { cwd: fx.repo });
    await git(["branch", "-D", "sb-run"], { cwd: fx.repo });
    expect(log()).toBe("");
    // Positive control: an unhardened `reset --hard` checks the files out through the smudge driver.
    plainGit(fx.repo, "worktree", "add", "-q", "--detach", wtPath("wt2"), fx.baseCommit);
    clearLog();
    writeFileSync(path.join(wtPath("wt2"), "payload.dat"), "dirty (dat)\n");
    plainGit(wtPath("wt2"), "reset", "-q", "--hard", fx.baseCommit);
    expect(log()).toMatch(/filter smudge/);
  });

  it("drivers defined through include.path or config.worktree are neutralised too", async () => {
    // Move the smudge driver into an included file and the clean driver into the main worktree's config.worktree.
    const smudge = tg(fx.repo, "config", "--local", `filter.${FILTER_DRIVER}.smudge`);
    const clean = tg(fx.repo, "config", "--local", `filter.${FILTER_DRIVER}.clean`);
    tg(fx.repo, "config", "--local", "--unset", `filter.${FILTER_DRIVER}.smudge`);
    tg(fx.repo, "config", "--local", "--unset", `filter.${FILTER_DRIVER}.clean`);
    const included = path.join(fx.base, "included.gitconfig");
    writeFileSync(included, `[filter "${FILTER_DRIVER}"]\n\tsmudge = ${smudge}\n`);
    tg(fx.repo, "config", "--local", "include.path", included);
    tg(fx.repo, "config", "--local", "extensions.worktreeConfig", "true");
    tg(fx.repo, "config", "--worktree", `filter.${FILTER_DRIVER}.clean`, clean);

    await git(["worktree", "add", "-q", "--detach", wtPath("wt"), fx.baseCommit], { cwd: fx.repo });
    writeFileSync(path.join(fx.repo, "payload.dat"), "operator edit (dat)\n");
    await git(["add", "payload.dat"], { cwd: fx.repo });
    expect(log()).toBe("");
    plainGit(fx.repo, "worktree", "add", "-q", "--detach", wtPath("wt2"), fx.baseCommit);
    expect(log()).toMatch(/filter smudge/);
    writeFileSync(path.join(fx.repo, "payload.dat"), "operator edit again (dat)\n");
    plainGit(fx.repo, "add", "payload.dat");
    expect(log()).toMatch(/filter clean/);
  });

  it("a driver name that `-c` cannot express makes controller Git fail closed", async () => {
    tg(fx.repo, "config", "--local", "filter.odd=name.smudge", "/bin/false");
    await expect(driverOverrides(fx.repo)).rejects.toBeInstanceOf(GitError);
    await expect(git(["status", "--porcelain=v2", "-z"], { cwd: fx.repo })).rejects.toBeInstanceOf(GitError);
    tg(fx.repo, "config", "--local", "--unset", "filter.odd=name.smudge");
    await expect(git(["status", "--porcelain=v2", "-z"], { cwd: fx.repo })).resolves.toMatchObject({ code: 0 });
    expect(log()).toBe("");
  });
});

describe("T3.8 positive controls: every detector fires when its invariant is broken", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await openHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it(
    "environment detector: allowlisting the canary variable makes it visible to the child",
    async () => {
      h.adapter.extraAllowlist = [h.fx.envCanaryName];
      const run = await h.delegate("env_report");
      expect(run.envelope.status).toBe("SUCCEEDED");
      const stdout = await streamText(h, run.runId, "provider_stdout");
      expect(envLeaks(stdout, h.adapter.declaredEnv)).toEqual([h.fx.envCanaryName]);
      expect(envLeaks('{"type":"message","text":"no report"}', [])).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  it("operator-state detector: a changed file, index entry, ref, HEAD or remote ref is noticed", () => {
    const { fx } = h;
    const base = operatorState(fx);
    writeFileSync(path.join(fx.repo, "README.md"), "changed\n");
    const afterFile = operatorState(fx);
    expect(afterFile.files).not.toBe(base.files);
    expect(afterFile.status).not.toBe(base.status);
    tg(fx.repo, "add", "README.md");
    const afterIndex = operatorState(fx);
    expect(afterIndex.indexEntries).not.toBe(base.indexEntries);
    expect(afterIndex.indexBytes).not.toBe(base.indexBytes);
    tg(fx.repo, "update-ref", "refs/heads/not-a-run-branch", fx.baseCommit);
    expect(operatorState(fx).refs).not.toEqual(base.refs);
    tg(fx.repo, "symbolic-ref", "HEAD", "refs/heads/not-a-run-branch");
    expect(operatorState(fx).head).not.toBe(base.head);
    tg(fx.repo, "push", "-q", "--no-verify", "origin", "refs/heads/not-a-run-branch");
    expect(operatorState(fx).remoteRefs).not.toEqual(base.remoteRefs);
  });

  it(
    "hook detector: Git without the controller's hardening runs the repository's hooks in a run worktree",
    async () => {
      const run = await h.delegate("success");
      expect(readIfExists(h.fx.hookLog)).toBe("");
      plainGit(run.record.worktree_path as string, "commit", "--allow-empty", "-q", "-m", "unhardened");
      expect(readIfExists(h.fx.hookLog)).toMatch(/hook pre-commit \(core\.hooksPath\)/);
    },
    TEST_TIMEOUT,
  );

  it("filter detector: Git without hardening runs the configured smudge and process drivers", () => {
    configureFilterDrivers(h.fx);
    const scratch = path.join(h.fx.base, "scratch-wt");
    plainGit(h.fx.repo, "worktree", "add", "-q", "--detach", scratch, h.fx.baseCommit);
    expect(readIfExists(h.fx.filterLog)).toMatch(/filter smudge/);
    expect(readIfExists(h.fx.filterLog)).toMatch(/filter process/);
  });

  it("agent-config detector: running the repository's .mcp.json command writes the canary log", () => {
    const cfg = JSON.parse(readFileSync(path.join(h.fx.repo, ".mcp.json"), "utf8")) as {
      mcpServers: { canary: { command: string; args: string[] } };
    };
    execFileSync(cfg.mcpServers.canary.command, cfg.mcpServers.canary.args);
    expect(readIfExists(h.fx.configLog)).toMatch(/config mcp\.json/);
  });

  it(
    "symlink detector: reading through an outside-pointing link exposes the token; storing its target does not",
    async () => {
      const planter = linkPlanter(h.fx, "probe");
      const run = await h.delegate("success", planter.plant);
      const wt = run.record.worktree_path as string;
      expect(findTokens(h.fx, readFileSync(path.join(wt, "probe-abs"), "utf8"))).toEqual(["outside_sentinel"]);
      expect(findTokens(h.fx, readFileSync(path.join(wt, "probe-home"), "utf8"))).toEqual(["codex_auth"]);
      expect(findTokens(h.fx, readFileSync(path.join(wt, "probe-rel"), "utf8"))).toEqual(["outside_sentinel"]);
      // A link-following diff (what the controller must NOT do) would carry the token.
      const following = spawnSync("diff", ["-u", "/dev/null", path.join(wt, "probe-home")], {
        encoding: "utf8",
      }).stdout;
      expect(findTokens(h.fx, following)).toEqual(["codex_auth"]);
    },
    TEST_TIMEOUT,
  );

  it(
    "token detectors: a token planted in the ledger, the artifact store, an MCP artifact or a worktree is found",
    async () => {
      const run = await h.delegate("success");
      expect(leakScan(h)).toEqual(NO_LEAKS);
      // Ledger.
      h.ledger.appendRunEvent({ runId: run.runId, type: "probe", payload: { x: h.fx.tokens.env_secret } });
      // Artifact store, then exposed through MCP as a diff artifact of the caller's own run.
      const stored = await h.artifacts.put(`leaked ${h.fx.tokens.codex_auth}\n`);
      h.ledger.insertArtifact({
        runId: run.runId,
        metaSessionId: run.metaSessionId,
        kind: "diff",
        sha256: stored.sha256,
        sizeBytes: stored.sizeBytes,
        mediaType: "text/x-diff",
      });
      await h.call("get_artifacts", { run_id: run.runId, kinds: ["diff"], max_inline_bytes: 1_048_576 });
      // Worktree (a regular file, not a link).
      writeFileSync(path.join(run.record.worktree_path as string, "copied.txt"), h.fx.tokens.outside_sentinel);
      expect(leakScan(h)).toEqual({
        ledger: ["env_secret"],
        artifacts: ["codex_auth"],
        worktrees: ["outside_sentinel"],
        mcp: ["codex_auth"],
      });
    },
    TEST_TIMEOUT,
  );

  it("workspace-root detector: the refusal is specific (an allowed repository passes the root checks)", async () => {
    // Fails later, on the missing meta-session, which proves the root and repository checks themselves passed.
    await expect(
      h.workspace.prepare({
        metaSessionId: "sess_t38",
        runId: "run_t38",
        workspace: h.fx.repo,
        trustProfile: "edit-untrusted",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
