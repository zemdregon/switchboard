/**
 * T3.8b controller confinement checks (owner decision 63; NFR-SEC-03, R-3; TDD §3.6 "T3.8b confinement checks"). Each
 * CF row of that table that the controller enforces is driven end to end through the REAL lifecycle, tool channel,
 * ledger, artifact store and MCP surface with the EXISTING fake-provider scenarios (`env_report`, `git_attempts` with
 * its `tool_commit` step, `success`) and small JSON plans. No new fake behaviour, no payload, no real credential
 * location: the only synthetic secret is the environment name `SBCANARY_T38B` and the only outside file is
 * `canary.txt` in this test's temporary directory. CF-5, CF-6 and CF-8 are recorded `NOT ENFORCED` / `NOT DETECTED` in
 * the TDD and have no test here.
 *
 * Where a check needs a symlink in the worktree (the fake CLI makes none), the TEST HARNESS places it after the
 * controller created the worktree and before the fake provider starts, as in `test/malicious/controller.test.ts`.
 *
 * Every check has a positive control in "T3.8b positive controls" that shows its assertion can fail: the allowed
 * variant of the same call succeeds, or the allowlisted name does appear.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScenario } from "../../src/adapters/fake/adapter.js";
import {
  AdapterRegistry,
  type CompileRequest,
  type GitCapabilities,
  type Ineligible,
  type Invocation,
  type ProbeRunner,
  type ProviderAdapter,
  type ResolvedProfile,
  type ShimSpec,
  type VersionGateResult,
} from "../../src/adapters/index.js";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { GIT_TOOL_DENIED, GitToolService } from "../../src/git/channel.js";
import { GIT_POLICY_VIOLATION_EVENT, GitPublisher, publishRefFor, type ViolationEntry } from "../../src/git/index.js";
import { TOKEN_PREFIX } from "../../src/git/tool-protocol.js";
import { createIdGenerator } from "../../src/ids/index.js";
import { createLedger, type Ledger, openLedger } from "../../src/ledger/index.js";
import { RunLifecycle } from "../../src/lifecycle/index.js";
import { createSwitchboardServer, SubjectBindingStore } from "../../src/mcp/index.js";
import type { ProjectSnapshot } from "../../src/policy/index.js";
import { WorkspaceManager } from "../../src/workspace/index.js";

/** macOS temp paths are too long for the 100-byte socket bound (T4.10); `/tmp` is not. */
const SHORT_TMP = process.platform === "darwin" ? "/tmp" : tmpdir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM_COMMAND = [
  process.execPath,
  "--experimental-transform-types",
  "--no-warnings",
  "--import",
  path.join(HERE, "..", "..", "src", "reconcile", "fixtures", "ts-register.mjs"),
  path.join(HERE, "..", "..", "src", "cli", "bin.ts"),
  "tool-shim",
];

const CANARY_ENV = "SBCANARY_T38B";
const CANARY_FILE = "canary.txt";
const CANARY_BYTES = "synthetic canary for T3.8b, not a secret\n";
const TEST_TIMEOUT = 90_000;
const PATIENT = { wallClockMs: 60_000, idleMs: 30_000, killGraceMs: 300 };
const PROFILE: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};
const PROJECT: ProjectSnapshot = {
  id: "web",
  name: "Web",
  environment_kind: "host",
  context_id: "main",
  base_ref: "main",
  effective_max_profile: "edit-untrusted",
  writable: true,
  identity: { name: "Ada Maintainer", email: "ada@example.test" },
  push: { policy: "none" },
};

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
const refSha = (cwd: string, ref: string): string => {
  try {
    return g(cwd, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return "";
  }
};

/**
 * The real fake adapter with three test knobs: the scenario, names added to the environment allowlist (the CF-4
 * positive control only), a hook that places workspace content in the controller-created worktree just before spawn
 * (CF-3), and a token substitution applied to the ShimSpec the channel hands the adapter (CF-9). The fake adapter's
 * own `channelArgs` still builds the argv and environment.
 */
class ConfinementAdapter implements ProviderAdapter {
  readonly id = "fake" as const;
  readonly transports = ["subprocess-jsonl"] as const;
  readonly gitWriteControl = new FakeAdapter().gitWriteControl;
  readonly resumeCwd = "bound" as const;
  readonly gitCapabilities: GitCapabilities;
  scenario: FakeScenario = "success";
  extraAllowlist: string[] = [];
  beforeSpawn: ((cwd: string) => void) | undefined;
  swapToken: ((real: string) => string) | undefined;
  /** The real token of every channel opened, in order (test-only capture, never asserted on its value). */
  readonly tokens: string[] = [];
  private readonly base = new FakeAdapter({ timeouts: PATIENT });

  constructor(private readonly worktreesDir: string) {
    const channelArgs = this.base.gitCapabilities.channelArgs;
    if (!channelArgs) throw new Error("fake adapter must declare channelArgs");
    this.gitCapabilities = {
      ...this.base.gitCapabilities,
      channelArgs: (shim: ShimSpec, req, p) => {
        const real = shim.env.SWITCHBOARD_TOOL_TOKEN ?? "";
        this.tokens.push(real);
        const token = this.swapToken ? this.swapToken(real) : real;
        return channelArgs({ ...shim, env: { ...shim.env, SWITCHBOARD_TOOL_TOKEN: token } }, req, p);
      },
    };
  }
  private inner(): FakeAdapter {
    return new FakeAdapter({ scenario: this.scenario, timeouts: PATIENT });
  }
  probe(r: ProbeRunner) {
    return this.inner().probe(r);
  }
  authPreflight(r: ProbeRunner) {
    return this.inner().authPreflight(r);
  }
  private prepared(inv: Invocation | Ineligible, req: CompileRequest): Invocation | Ineligible {
    if ("ineligible" in inv) return inv;
    // compile also runs for the eligibility check against the operator path: only touch a run worktree.
    if (req.workspace.cwd.startsWith(this.worktreesDir + path.sep)) this.beforeSpawn?.(req.workspace.cwd);
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

let root: string;
let repo: string;
let remote: string;
let canaryPath: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let artifacts: ArtifactStore;
let registry: AdapterRegistry;
let adapter: ConfinementAdapter;
let service: GitToolService;
let lifecycle: RunLifecycle;

type Step = Record<string, unknown> & { op: string };

/** One run to a terminal state. `steps` is a `git_attempts` plan; the project (and so the tool channel) is on by default. */
async function run(scenario: FakeScenario, steps: Step[] = [], opts: { project?: boolean } = {}) {
  adapter.scenario = scenario;
  const { runId, metaSessionId } = await lifecycle.submit({
    clientId: "orchestrator",
    objective: JSON.stringify({ steps }),
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    ...(opts.project === false ? {} : { project: PROJECT }),
  });
  const done = await lifecycle.waitForTerminal(runId);
  return { runId, metaSessionId, state: done.state, publish: refSha(repo, publishRefFor(metaSessionId)) };
}

const events = (runId: string) =>
  ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) as Record<string, unknown> }));
const denied = (runId: string) =>
  events(runId)
    .filter((e) => e.type === GIT_TOOL_DENIED)
    .map((e) => e.p);
const violationsOf = (runId: string): ViolationEntry[] =>
  events(runId)
    .filter((e) => e.type === GIT_POLICY_VIOLATION_EVENT)
    .flatMap((e) => e.p.violations as ViolationEntry[]);

/** The environment names the `env_report` scenario printed, read back from the stored provider stdout. */
async function reportedEnvNames(runId: string): Promise<string[]> {
  const art = ledger.listArtifactsForRun(runId).find((a) => a.kind === "provider_stdout");
  if (!art) throw new Error("no provider_stdout artifact");
  for (const line of (await artifacts.get(art.sha256)).toString("utf8").split("\n")) {
    try {
      const ev = JSON.parse(line) as { type?: string; text?: string };
      if (ev.type !== "message" || typeof ev.text !== "string") continue;
      const report = JSON.parse(ev.text) as { env_names?: unknown };
      if (Array.isArray(report.env_names)) return report.env_names as string[];
    } catch {
      // not a report line
    }
  }
  throw new Error("no env report in provider stdout");
}

const gate = (id: string, version: string | null): VersionGateResult => ({
  eligible: true,
  evidence: { provider: id, observedVersion: version, validatedRange: "test", validatedCliVersion: "test" },
});

const tool = (message: string, paths: string[]): Step => ({ op: "tool_commit", arguments: { message, paths } });

/** Call `get_artifacts` on the real MCP server (in-memory transport) as the client that owns the runs. */
async function getArtifacts(runIds: string[]): Promise<{ isError: boolean; body: Record<string, unknown> }[]> {
  const server = createSwitchboardServer({
    lifecycle,
    ledger,
    artifacts,
    registry,
    config: {
      allowedRoots: [root],
      mcpClients: new Map([["orchestrator", { id: "orchestrator", maxTrustProfile: "edit-untrusted" as const }]]),
    },
    subjectBindings: new SubjectBindingStore(db),
    clientId: "orchestrator",
  });
  const client = new Client({ name: "t38b", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.server.connect(serverSide);
  await client.connect(clientSide);
  try {
    const out = [];
    for (const runId of runIds) {
      const res = await client.callTool({ name: "get_artifacts", arguments: { run_id: runId } });
      const text = (res.content as { text: string }[])[0]?.text ?? "{}";
      out.push({ isError: res.isError === true, body: JSON.parse(text) as Record<string, unknown> });
    }
    return out;
  } finally {
    await client.close();
    await server.close();
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(SHORT_TMP, "sb-t38b-")));
  repo = path.join(root, "repo");
  remote = path.join(root, "remote.git");
  canaryPath = path.join(root, CANARY_FILE);
  writeFileSync(canaryPath, CANARY_BYTES);
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  g(root, "init", "-q", "--bare", remote);
  g(repo, "remote", "add", "origin", remote);
  g(repo, "push", "-q", "origin", "main");
  dataDir = path.join(root, "data");
  db = openLedger(dataDir);
  const ids = createIdGenerator();
  ledger = createLedger(db, { ids });
  artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const publisher = new GitPublisher({ db, scratchDir: path.join(dataDir, "git-scratch") });
  service = new GitToolService({ db, dataDir, publisher, shimCommand: SHIM_COMMAND, fallbackDirs: [root] });
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  adapter = new ConfinementAdapter(path.join(dataDir, "worktrees"));
  registry = new AdapterRegistry().register(adapter);
  lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots: [root],
    globalConcurrency: 2,
    resolveProfile: () => PROFILE,
    gitTools: service,
    // MCP serving needs eligibility dependencies; every fake version is in range here (as in controller.test.ts).
    eligibility: { platform: "linux", gate: gate as AdapterRegistry["gate"] },
  });
  lifecycle.start();
});

afterEach(async () => {
  delete process.env[CANARY_ENV];
  await lifecycle.shutdown();
  await service.closeAll();
  db.close();
  // Every check: the outside canary file is byte-identical afterwards.
  expect(readFileSync(canaryPath, "utf8")).toBe(CANARY_BYTES);
  rmSync(root, { recursive: true, force: true });
});

describe("T3.8b confinement checks on the fake provider (owner decision 63)", () => {
  it(
    "CF-1 path traversal: commit tool paths with `../` or an absolute path are refused PATH_OUTSIDE_WORKTREE",
    async () => {
      const r = await run("git_attempts", [
        { op: "write", path: "ok.txt", content: "ok\n" },
        tool("dotdot", [`../${CANARY_FILE}`]),
        tool("nested dotdot", [`sub/../../${CANARY_FILE}`]),
        tool("absolute", [canaryPath]),
      ]);
      expect(r.state).toBe("SUCCEEDED"); // tool errors never fail the run
      expect(denied(r.runId).map((d) => d.code)).toEqual([
        "PATH_OUTSIDE_WORKTREE",
        "PATH_OUTSIDE_WORKTREE",
        "PATH_OUTSIDE_WORKTREE",
      ]);
      expect(r.publish).toBe("");
      expect(ledger.listGitCommits(r.runId)).toEqual([]);
      expect(events(r.runId).some((e) => e.type === "git_commit_intent")).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "CF-2 path traversal: MCP get_artifacts refuses a non-ID or `../` run_id, and the store refuses a non-hash id",
    async () => {
      const ok = await run("success", [], { project: false });
      const bad = [
        `../${CANARY_FILE}`,
        `run_../../${CANARY_FILE}`,
        `${ok.runId}/../${CANARY_FILE}`,
        `${ok.runId}/..`,
        canaryPath,
      ];
      const answers = await getArtifacts(bad);
      answers.forEach((a, i) => {
        expect(a.isError, bad[i]).toBe(true);
        expect((a.body.error as { code?: string } | undefined)?.code, bad[i]).toBe("INVALID_REQUEST");
        expect(JSON.stringify(a.body)).not.toContain(CANARY_BYTES.trim());
      });
      // Artifact ids are SHA-256 hashes (`assertHash`): a relative path or a hash with `/../` is refused.
      const stored = ledger.listArtifactsForRun(ok.runId)[0]?.sha256 ?? "";
      expect(stored).toMatch(/^[0-9a-f]{64}$/);
      for (const id of [`../../${CANARY_FILE}`, canaryPath, `${stored.slice(0, 60)}/../`, `${stored}/..`]) {
        await expect(artifacts.get(id), id).rejects.toMatchObject({ code: "INVALID_HASH" });
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "CF-3 symlink: a commit tool path through a worktree symlink to outside is refused PATH_OUTSIDE_WORKTREE",
    async () => {
      adapter.beforeSpawn = (cwd) => symlinkSync(root, path.join(cwd, "escape"));
      const r = await run("git_attempts", [tool("through link", [`escape/${CANARY_FILE}`])]);
      expect(r.state).toBe("SUCCEEDED");
      // The per-path reason `symlink_in_path` is asserted in src/git/commit.test.ts; the event carries code and count.
      expect(denied(r.runId)).toEqual([{ code: "PATH_OUTSIDE_WORKTREE", tool: "commit", refused_paths: 1 }]);
      expect(r.publish).toBe("");
      expect(ledger.listGitCommits(r.runId)).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    "CF-4 environment read: SBCANARY_T38B set in the controller environment is absent from the provider child",
    async () => {
      process.env[CANARY_ENV] = "synthetic";
      const r = await run("env_report", [], { project: false });
      expect(r.state).toBe("SUCCEEDED");
      const names = await reportedEnvNames(r.runId);
      expect(names).toContain("PATH"); // the report works: an allowlisted name is there
      expect(names).not.toContain(CANARY_ENV);
    },
    TEST_TIMEOUT,
  );

  it(
    "CF-7 Git push from inside: plain `git push` to the configured local bare remote is detected; publish ref unchanged",
    async () => {
      const r = await run("git_attempts", [
        { op: "write", path: "x.txt", content: "x\n" },
        { op: "commit", message: "agent" },
        { op: "push", remote: "origin", refspec: "HEAD:refs/heads/agent-pushed" },
      ]);
      expect(r.state).toBe("SUCCEEDED"); // BR-27: a violation never fails the run
      expect(violationsOf(r.runId).find((v) => v.ref === "refs/remotes/origin/agent-pushed")).toMatchObject({
        scope: "other",
        kind: "created",
        action: "report",
      });
      expect(r.publish).toBe("");
      expect(ledger.listGitCommits(r.runId)).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    "CF-9 tool-channel token: a forged token and another run's token are refused TOKEN_INVALID with git_tool_denied",
    async () => {
      const first = await run("git_attempts", [{ op: "write", path: "a.txt", content: "a\n" }, tool("a", ["a.txt"])]);
      expect(first.publish).not.toBe("");
      const otherRunsToken = adapter.tokens[0] ?? "";
      expect(otherRunsToken.startsWith(TOKEN_PREFIX)).toBe(true);
      const forged = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      for (const token of [forged, otherRunsToken]) {
        adapter.swapToken = () => token;
        const r = await run("git_attempts", [{ op: "write", path: "b.txt", content: "b\n" }, tool("b", ["b.txt"])]);
        expect(r.state).toBe("SUCCEEDED");
        expect(denied(r.runId).map((d) => d.code)).toEqual(["TOKEN_INVALID"]);
        expect(ledger.listGitCommits(r.runId)).toEqual([]);
        expect(r.publish).toBe("");
        expect(JSON.stringify(ledger.listRunEvents(r.runId))).not.toContain(token.slice(TOKEN_PREFIX.length));
      }
    },
    TEST_TIMEOUT,
  );
});

describe("T3.8b positive controls: each check fails when the boundary lets the call through", () => {
  it(
    "CF-1 control: the same commit tool call with a worktree path commits and moves the publish ref",
    async () => {
      const r = await run("git_attempts", [{ op: "write", path: "ok.txt", content: "ok\n" }, tool("ok", ["ok.txt"])]);
      expect(denied(r.runId)).toEqual([]);
      expect(r.publish).not.toBe("");
      expect(ledger.listGitCommits(r.runId)).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "CF-2 control: get_artifacts with the run's own ID returns its artifacts, and the store reads a stored hash",
    async () => {
      const ok = await run("success", [], { project: false });
      const [answer] = await getArtifacts([ok.runId]);
      expect(answer?.isError).toBe(false);
      expect((answer?.body.artifacts as unknown[] | undefined)?.length).toBeGreaterThan(0);
      const stored = ledger.listArtifactsForRun(ok.runId)[0]?.sha256 ?? "";
      await expect(artifacts.get(stored)).resolves.toBeInstanceOf(Buffer);
    },
    TEST_TIMEOUT,
  );

  it(
    "CF-3 control: the same path through a real directory in the worktree commits",
    async () => {
      adapter.beforeSpawn = (cwd) => {
        mkdirSync(path.join(cwd, "escape"));
        writeFileSync(path.join(cwd, "escape", CANARY_FILE), "inside\n");
      };
      const r = await run("git_attempts", [tool("real dir", [`escape/${CANARY_FILE}`])]);
      expect(denied(r.runId)).toEqual([]);
      expect(r.publish).not.toBe("");
    },
    TEST_TIMEOUT,
  );

  it(
    "CF-4 control: allowlisting SBCANARY_T38B makes it visible to the child",
    async () => {
      process.env[CANARY_ENV] = "synthetic";
      adapter.extraAllowlist = [CANARY_ENV];
      const r = await run("env_report", [], { project: false });
      expect(await reportedEnvNames(r.runId)).toContain(CANARY_ENV);
    },
    TEST_TIMEOUT,
  );

  it(
    "CF-7 control: the same plan without the push records no remote-tracking violation and the remote has no ref",
    async () => {
      const r = await run("git_attempts", [
        { op: "write", path: "x.txt", content: "x\n" },
        { op: "commit", message: "agent" },
      ]);
      expect(violationsOf(r.runId).filter((v) => (v.ref ?? "").startsWith("refs/remotes/"))).toEqual([]);
      expect(refSha(remote, "refs/heads/agent-pushed")).toBe("");
    },
    TEST_TIMEOUT,
  );

  it(
    "CF-9 control: the run's own token commits and records no git_tool_denied",
    async () => {
      const r = await run("git_attempts", [{ op: "write", path: "b.txt", content: "b\n" }, tool("b", ["b.txt"])]);
      expect(denied(r.runId)).toEqual([]);
      expect(r.publish).not.toBe("");
    },
    TEST_TIMEOUT,
  );
});
