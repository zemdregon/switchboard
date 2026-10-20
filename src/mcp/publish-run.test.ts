/**
 * MCP `publish_run` (ADR-0069, LLD §3.4.12) through the server as an orchestrating client calls it: offered only to a
 * client whose `max_push_policy` is `branch`, scoped exactly as `get_run` (another client's or another HTTP subject's
 * run is "unknown run"), only for a SUCCEEDED run with a published commit, the controller push with the pre-push secret
 * scan, recorded as `mcp_client:<id>`, idempotent, with the pull request opened or reused through a fake
 * {@link PullRequestPort}, and `gh` failures reported as a closed `pull_request_error` while the push stands. The
 * envelope (`get_run`, `list_runs`, `get_digest`) carries `publications` with the pull request link.
 *
 * Also the run-visibility rule over the HTTP-subject path (FR-QUE-08, FR-MCP-15): a run admitted from this client's
 * queued item is visible to every subject of the client, a run another subject delegated is not, on every run-scoped
 * tool (`get_run`, `list_runs`, `get_artifacts`, `get_digest`, `explain_route`, `publish_run`).
 *
 * Temporary repositories and a LOCAL bare remote; the push URL is reported as a github.com URL by an injected reader,
 * and no real `gh` or provider CLI runs.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { type PullRequestLink, type PullRequestPort, PullRequestPortError } from "../ci/gh-pr.js";
import type { ResolvedMcpClient, ResolvedProject } from "../config/index.js";
import { GitPublisher, GitPusher, projectPushContextResolver } from "../git/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { DynamicProjectStore } from "../projects/index.js";
import type { AdmitWorkDeps } from "../queue/admission.js";
import { runProjectWorkQueueTick } from "../queue/scheduler.js";
import { WorkspaceManager } from "../workspace/index.js";
import { SubjectBindingStore } from "./http-subjects.js";
import { AGENT_TEXT_LABEL } from "./publish.js";
import { createSwitchboardServer } from "./server.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };
const TOKEN = `ghp_canary${"0".repeat(30)}`;
const PR_URL = "https://github.com/acme/web/pull/42";

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON checked by the published output schemas
type Json = Record<string, any>;

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

class FakePulls implements PullRequestPort {
  calls: { op: "find" | "create"; args: Json }[] = [];
  open: PullRequestLink | null = null;
  failWith: PullRequestPortError | undefined;
  async findForBranch(q: { owner: string; repo: string; branch: string }): Promise<PullRequestLink | null> {
    this.calls.push({ op: "find", args: q });
    if (this.failWith) throw this.failWith;
    return this.open;
  }
  async create(q: Json & { branch: string }): Promise<{ number: number; url: string }> {
    this.calls.push({ op: "create", args: q });
    if (this.failWith) throw this.failWith;
    this.open = { number: 42, state: "OPEN", url: PR_URL };
    return { number: 42, url: PR_URL };
  }
}

interface Fixture {
  root: string;
  repo: string;
  bare: string;
  db: Database.Database;
  ledger: Ledger;
  lifecycle: RunLifecycle;
  pulls: FakePulls;
  artifacts: ArtifactStore;
  queue: AdmitWorkDeps;
  bindings: SubjectBindingStore;
  store: DynamicProjectStore;
  /** What the injected push-URL reader reports for the remote. */
  pushUrl: string;
  /** A connected client for `clientId`, optionally as an HTTP subject. */
  connect(
    clientId: string,
    subject?: string,
  ): Promise<(name: string, args: Json) => Promise<{ isError: boolean; body: Json }>>;
  tools(clientId: string): Promise<string[]>;
  seedRun(opts?: {
    clientId?: string;
    projectId?: string;
    content?: string;
    file?: string;
    succeed?: boolean;
    /** The run's result summary (the terminal transition's `summary`, as `get_run` shows it). */
    summary?: string;
  }): Promise<{
    runId: string;
    sessionId: string;
  }>;
  close(): Promise<void>;
}

const CLIENTS: ResolvedMcpClient[] = [
  {
    id: "linus",
    maxTrustProfile: "edit-untrusted",
    manageProjects: true,
    maxPushPolicy: "branch",
    projects: ["web", "quiet"],
  },
  { id: "peer", maxTrustProfile: "edit-untrusted", manageProjects: true, maxPushPolicy: "branch", projects: ["web"] },
  { id: "nopush", maxTrustProfile: "edit-untrusted", manageProjects: true, maxPushPolicy: "none", projects: ["web"] },
  {
    id: "console",
    maxTrustProfile: "edit-untrusted",
    manageProjects: true,
    maxPushPolicy: "branch",
    projects: ["web"],
    toolProfile: "console",
  },
];

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function start(): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-publish-")));
  const repo = path.join(root, "repos", "web");
  const bare = path.join(root, "remote.git");
  mkdirSync(repo, { recursive: true });
  const g = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, env: GIT_ENV });
  g("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { env: GIT_ENV });
  g("remote", "add", "origin", bare);
  g("push", "-q", "origin", "main");
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const db = openLedger(dataDir);
  const ids = createIdGenerator();
  const ledger = createLedger(db, { ids });
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  const registry = new AdapterRegistry().register(new FakeAdapter({ scenario: "success" }));
  const lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots: [root],
    globalConcurrency: 4,
    resolveProfile: profileFor,
    eligibility: {
      platform: "linux",
      gate: (id, version) => ({
        eligible: true,
        evidence: { provider: id, observedVersion: version, validatedRange: "test", validatedCliVersion: "test" },
      }),
    },
  });
  const ctx = (policy: "branch" | "none") => ({
    id: "main",
    kind: "repository" as const,
    path: repo,
    baseRef: "main",
    primary: true,
    writable: true,
    sign: false,
    finalizeCommit: false,
    identity: IDENTITY,
    push: policy === "branch" ? { policy, remote: "origin", branchPrefix: "sb/" } : { policy },
  });
  const projects: ResolvedProject[] = [
    { id: "web", name: "Web", environment: { kind: "host" }, contexts: [ctx("branch")] },
    { id: "quiet", name: "Quiet", environment: { kind: "host" }, contexts: [ctx("none")] },
  ];
  const mcpClients = new Map(CLIENTS.map((c) => [c.id, c]));
  const config = { allowedRoots: [root], mcpClients, projects, dataDir };
  const store = new DynamicProjectStore(db, { ids });
  const resolveContext = projectPushContextResolver({ projects, store, clients: mcpClients });
  const pusher = new GitPusher({ db, resolveContext, sourceEnv: { PATH: process.env.PATH, HOME: root }, ids });
  const pulls = new FakePulls();
  const bindings = new SubjectBindingStore(db);
  const publish = {
    pusher,
    resolveContext,
    pulls,
    pushUrl: async () => fixture.pushUrl,
  };
  const opened: { close(): Promise<void> }[] = [];
  const connect = async (clientId: string, subject?: string) => {
    const mcp = createSwitchboardServer({
      lifecycle,
      ledger,
      artifacts,
      registry,
      config,
      clientId,
      projectStore: store,
      subjectBindings: bindings,
      ...(subject !== undefined ? { subject } : {}),
      publish,
    });
    const client = new Client({ name: clientId, version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcp.server.connect(st);
    await client.connect(ct);
    await client.listTools(); // output schemas are cached, so each result below is schema-checked by the SDK
    opened.push({
      close: async () => {
        await client.close();
        await mcp.close();
      },
    });
    return async (name: string, args: Json) => {
      const res = await client.callTool({ name, arguments: args });
      const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}") as Json;
      return { isError: res.isError === true, body };
    };
  };
  const publisher = new GitPublisher({ db, scratchDir: path.join(root, "scratch") });
  const fixture: Fixture = {
    store,
    pushUrl: "git@github.com:acme/web.git",
    root,
    repo,
    bare,
    db,
    ledger,
    lifecycle,
    pulls,
    artifacts,
    bindings,
    queue: { lifecycle, ledger, registry, config } as unknown as AdmitWorkDeps,
    connect,
    tools: async (clientId) => {
      const mcp = createSwitchboardServer({
        lifecycle,
        ledger,
        artifacts,
        registry,
        config,
        clientId,
        projectStore: store,
        subjectBindings: bindings,
        publish,
      });
      const client = new Client({ name: clientId, version: "0.0.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await mcp.server.connect(st);
      await client.connect(ct);
      const names = (await client.listTools()).tools.map((t) => t.name);
      await client.close();
      await mcp.close();
      return names;
    },
    seedRun: async (o = {}) => {
      const projectId = o.projectId ?? "web";
      const session = ledger.createMetaSession({ objective: "work", repoRoot: repo, projectId });
      const r = ledger.createRun({
        metaSessionId: session.id,
        state: "RUNNING",
        trustProfile: "edit-untrusted",
        policySnapshot: {},
        request: {},
        requestHash: "h",
        clientId: o.clientId ?? "linus",
        provider: "fake",
        projectId,
      });
      const ws = await workspace.prepare({
        metaSessionId: session.id,
        runId: r.id,
        workspace: repo,
        trustProfile: "edit-untrusted",
      });
      if (ws.mode !== "worktree") throw new Error("expected a worktree");
      writeFileSync(path.join(ws.worktreePath, o.file ?? "feature.txt"), o.content ?? "feature\n");
      await publisher.commit({
        runId: r.id,
        message: "Add the feature",
        identity: IDENTITY,
        projectId,
        contextId: "main",
      });
      if (o.succeed !== false) {
        const row = ledger.getRunRecord(r.id);
        ledger.casRunState({
          runId: r.id,
          from: "RUNNING",
          to: "SUCCEEDED",
          expectedVersion: row?.version as number,
          ...(o.summary !== undefined ? { payload: { summary: o.summary } } : {}),
        });
      }
      return { runId: r.id, sessionId: session.id };
    },
    close: async () => {
      for (const o of opened) await o.close();
      await lifecycle.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return fixture;
}

const remoteRefs = (bare: string): string[] =>
  execFileSync("git", ["for-each-ref", "--format=%(refname)"], { cwd: bare, env: GIT_ENV, encoding: "utf8" })
    .split("\n")
    .filter((l) => l !== "");

const pushRows = (db: Database.Database) =>
  db.prepare("SELECT outcome, detail, requested_by, run_id FROM git_push ORDER BY created_at, id").all() as Json[];

describe("publish_run (ADR-0069)", () => {
  it("is offered only to a client with max_push_policy branch (never to a console client)", async () => {
    f = await start();
    expect(await f.tools("linus")).toContain("publish_run");
    expect(await f.tools("nopush")).not.toContain("publish_run");
    expect(await f.tools("console")).not.toContain("publish_run");
    const call = await f.connect("nopush");
    const { runId } = await f.seedRun({ clientId: "nopush" });
    const r = await call("publish_run", { run_id: runId });
    expect(r.body.error).toMatchObject({ code: "INVALID_REQUEST", message: 'unknown tool "publish_run"' });
    expect(pushRows(f.db)).toEqual([]);
  });

  it("pushes the branch, records the MCP client, opens a pull request and shows it in get_run, list_runs and get_digest", async () => {
    f = await start();
    const call = await f.connect("linus");
    const { runId, sessionId } = await f.seedRun();
    const r = await call("publish_run", { run_id: runId, draft: true });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const branch = `sb/${sessionId}`;
    expect(r.body).toMatchObject({
      run_id: runId,
      meta_session_id: sessionId,
      publication: { remote: "origin", branch, reused: false },
      pull_request: { number: 42, url: PR_URL, draft: true, reused: false },
    });
    expect(remoteRefs(f.bare)).toContain(`refs/heads/${branch}`);
    expect(pushRows(f.db)).toEqual([
      { outcome: "ACCEPTED", detail: "ACCEPTED", requested_by: "mcp_client:linus", run_id: runId },
    ]);
    const create = f.pulls.calls.find((c) => c.op === "create")?.args as Json;
    expect(create).toMatchObject({ owner: "acme", repo: "web", branch, base: "main", draft: true });
    expect(create.title).toBe(`switchboard: ${runId}`);
    expect(create.body).toContain(`Run: \`${runId}\``);
    expect(create.body).toContain(`Meta-session: \`${sessionId}\``);
    const prRows = f.db.prepare("SELECT number, url, branch, action, client_id, draft FROM pull_request").all();
    expect(prRows).toEqual([{ number: 42, url: PR_URL, branch, action: "created", client_id: "linus", draft: 1 }]);
    expect(f.ledger.listRunEvents(runId).map((e) => e.type)).toContain("pull_request_opened");

    const publication = {
      branch,
      head_sha: r.body.publication.head_sha,
      pushed_at: expect.any(String),
      pull_request_url: PR_URL,
      pull_request_number: 42,
    };
    expect((await call("get_run", { run_id: runId })).body.publications).toEqual([publication]);
    const listed = (await call("list_runs", {})).body.runs.find((x: Json) => x.run_id === runId);
    expect(listed.publications).toEqual([publication]);
    const digest = (await call("get_digest", {})).body;
    const finished = digest.projects.find((p: Json) => p.project_id === "web").finished;
    expect(finished.find((e: Json) => e.run_id === runId).publications).toEqual([publication]);
  });

  const PROPOSING_SUMMARY = [
    "All done! Here is a PR title and description you can use:",
    "",
    "---",
    "",
    "## Fix broken relative Markdown links and anchors (docs only)",
    "",
    "Fixes relative links, cc @octocat.",
    "",
    "### Changes",
    "",
    "| File | Fix |",
    "| --- | --- |",
    "| README.md | anchor |",
  ].join("\n");

  it("titles and describes the pull request from the run summary's proposal, with the metadata underneath", async () => {
    f = await start();
    const call = await f.connect("linus");
    const { runId, sessionId } = await f.seedRun({ summary: PROPOSING_SUMMARY });
    const r = await call("publish_run", { run_id: runId });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const create = f.pulls.calls.find((c) => c.op === "create")?.args as Json;
    expect(create.title).toBe("switchboard: Fix broken relative Markdown links and anchors (docs only)");
    const body = create.body as string;
    expect(body.startsWith("Fixes relative links, cc \uff20octocat.\n\n### Changes\n\n| File | Fix |")).toBe(true);
    expect(body).not.toContain("All done!");
    expect(body).not.toContain("@octocat");
    const [description, metadata] = body.split("\n\n---\n\n");
    expect(description).toContain("| README.md | anchor |");
    expect(metadata).toBe(
      [
        AGENT_TEXT_LABEL.run_summary,
        "",
        "Opened by Switchboard `publish_run` with the operator's GitHub login.",
        "",
        `- Run: \`${runId}\``,
        `- Meta-session: \`${sessionId}\``,
        "- Provider: fake",
        "- Project: `web`",
        `- Head: \`${r.body.publication.head_sha}\``,
      ].join("\n"),
    );
  });

  it("a pr_draft artifact still wins over the run summary's proposal", async () => {
    f = await start();
    const call = await f.connect("linus");
    const { runId, sessionId } = await f.seedRun({ summary: PROPOSING_SUMMARY });
    const stored = await f.artifacts.put(JSON.stringify({ title: "Draft title", body: "Draft body." }));
    f.ledger.insertArtifact({
      runId,
      metaSessionId: sessionId,
      kind: "pr_draft",
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
      mediaType: "application/json",
    });
    expect((await call("publish_run", { run_id: runId })).isError).toBe(false);
    const create = f.pulls.calls.find((c) => c.op === "create")?.args as Json;
    expect(create.title).toBe("switchboard: Draft title");
    expect(create.body.startsWith(`Draft body.\n\n---\n\n${AGENT_TEXT_LABEL.pr_draft}\n\nOpened by Switchboard`)).toBe(
      true,
    );
    expect(create.body).not.toContain("Fix broken relative");
  });

  it("a summary without a proposal keeps the run-id title and the metadata-only body", async () => {
    f = await start();
    const call = await f.connect("linus");
    const { runId } = await f.seedRun({ summary: "I fixed the links.\n\n## Notes\n\nAll tests pass." });
    expect((await call("publish_run", { run_id: runId })).isError).toBe(false);
    const create = f.pulls.calls.find((c) => c.op === "create")?.args as Json;
    expect(create.title).toBe(`switchboard: ${runId}`);
    expect(create.body.startsWith("Opened by Switchboard `publish_run`")).toBe(true);
    expect(create.body).not.toContain("---");
    expect(create.body).not.toContain("I fixed the links");
  });

  it("is idempotent: publishing again pushes nothing new and reuses the open pull request", async () => {
    f = await start();
    const call = await f.connect("linus");
    const { runId } = await f.seedRun();
    const first = await call("publish_run", { run_id: runId });
    expect(first.isError).toBe(false);
    const again = await call("publish_run", { run_id: runId });
    expect(again.body).toMatchObject({
      publication: { push_id: first.body.publication.push_id, reused: true },
      pull_request: { number: 42, url: PR_URL, reused: true },
    });
    expect(pushRows(f.db)).toHaveLength(1);
    expect(f.pulls.calls.filter((c) => c.op === "create")).toHaveLength(1);
    expect(f.db.prepare("SELECT action FROM pull_request").all()).toEqual([{ action: "created" }]);
  });

  it("reuses a pull request that is already open for the branch instead of creating one", async () => {
    f = await start();
    const call = await f.connect("linus");
    const { runId } = await f.seedRun();
    f.pulls.open = { number: 9, state: "OPEN", url: "https://github.com/acme/web/pull/9" };
    const r = await call("publish_run", { run_id: runId });
    expect(r.body.pull_request).toEqual({
      number: 9,
      url: "https://github.com/acme/web/pull/9",
      draft: false,
      reused: true,
    });
    expect(f.pulls.calls.map((c) => c.op)).toEqual(["find"]);
    expect(f.db.prepare("SELECT number, action FROM pull_request").all()).toEqual([{ number: 9, action: "reused" }]);
  });

  it("a gh failure keeps the push and reports a closed pull_request_error", async () => {
    f = await start();
    const call = await f.connect("linus");
    const { runId } = await f.seedRun();
    f.pulls.failWith = new PullRequestPortError("AUTH_REQUIRED", "gh requires authentication");
    const r = await call("publish_run", { run_id: runId });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ pull_request: null, pull_request_error: "AUTH_REQUIRED" });
    expect(pushRows(f.db)).toEqual([expect.objectContaining({ outcome: "ACCEPTED" })]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM pull_request").get()).toEqual({ n: 0 });
    expect((await call("get_run", { run_id: runId })).body.publications).toEqual([
      expect.not.objectContaining({ pull_request_url: expect.anything() }),
    ]);
  });

  it("open_pull_request false pushes only; a non-github remote is REMOTE_NOT_GITHUB without any gh call", async () => {
    f = await start();
    const call = await f.connect("linus");
    const { runId } = await f.seedRun();
    const r = await call("publish_run", { run_id: runId, open_pull_request: false });
    expect(r.body).toMatchObject({ pull_request: null, publication: { reused: false } });
    expect(r.body.pull_request_error).toBeUndefined();
    expect(f.pulls.calls).toEqual([]);
    const other = await f.seedRun();
    f.pushUrl = "https://gitlab.example/acme/web.git";
    const r2 = await call("publish_run", { run_id: other.runId });
    expect(r2.body).toMatchObject({ pull_request: null, pull_request_error: "REMOTE_NOT_GITHUB" });
    expect(f.pulls.calls).toEqual([]);
    expect(pushRows(f.db).map((p) => p.outcome)).toEqual(["ACCEPTED", "ACCEPTED"]);
  });

  it("publishes a run of the creator's approved dynamic project; another client's run there is not publishable", async () => {
    f = await start();
    f.store.appendRevision(
      {
        projectId: "dyn-app",
        clientId: "linus",
        definition: {
          id: "dyn-app",
          name: "Dynamic",
          contexts: [
            {
              id: "main",
              kind: "repository",
              path: f.repo,
              base_ref: "main",
              push: { policy: "branch", remote: "origin", branch_prefix: "dyn/" },
              identity: IDENTITY,
            },
          ],
        },
        status: "PENDING_APPROVAL",
        approvalReasons: ["push_policy", "commit_identity"],
        action: "create_project",
      },
      () => undefined,
    );
    const linus = await f.connect("linus");
    const pending = await f.seedRun({ projectId: "dyn-app" });
    expect((await linus("publish_run", { run_id: pending.runId })).body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { reason: "CONTEXT_UNKNOWN" },
    });
    f.store.decide({ projectId: "dyn-app", decision: "APPROVED", decidedBy: "operator1" });
    const ok = await linus("publish_run", { run_id: pending.runId });
    expect(ok.isError, JSON.stringify(ok.body)).toBe(false);
    expect(ok.body.publication.branch).toBe(`dyn/${pending.sessionId}`);
    expect(remoteRefs(f.bare)).toContain(`refs/heads/dyn/${pending.sessionId}`);
    const peerRun = await f.seedRun({ projectId: "dyn-app", clientId: "peer" });
    const peer = await f.connect("peer");
    expect((await peer("publish_run", { run_id: peerRun.runId })).body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { reason: "CONTEXT_UNKNOWN" },
    });
  });

  it("the pre-push secret scan blocks: PERMISSION_BLOCKED SECRET_SCAN_BLOCKED, nothing reaches the remote", async () => {
    f = await start();
    const call = await f.connect("linus");
    const { runId } = await f.seedRun({ content: `token: ${TOKEN}\n`, file: "config.ts" });
    const r = await call("publish_run", { run_id: runId });
    expect(r.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "SECRET_SCAN_BLOCKED" } });
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    expect(remoteRefs(f.bare)).toEqual(["refs/heads/main"]);
    expect(pushRows(f.db)).toEqual([
      expect.objectContaining({
        outcome: "REFUSED_POLICY",
        detail: "SECRET_SCAN_BLOCKED",
        requested_by: "mcp_client:linus",
      }),
    ]);
    expect(f.pulls.calls).toEqual([]);
  });

  it("refuses a run that has not SUCCEEDED, a project whose policy is none, and a run without a commit", async () => {
    f = await start();
    const call = await f.connect("linus");
    const running = await f.seedRun({ succeed: false });
    expect((await call("publish_run", { run_id: running.runId })).body.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "RUN_NOT_SUCCEEDED" },
    });
    const quiet = await f.seedRun({ projectId: "quiet" });
    expect((await call("publish_run", { run_id: quiet.runId })).body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { reason: "POLICY_NONE" },
    });
    const session = f.ledger.createMetaSession({ objective: "x", repoRoot: f.repo, projectId: "web" });
    const bare = f.ledger.createRun({
      metaSessionId: session.id,
      state: "SUCCEEDED",
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h",
      clientId: "linus",
      provider: "fake",
      projectId: "web",
    });
    expect((await call("publish_run", { run_id: bare.id })).body.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "NOTHING_TO_PUBLISH" },
    });
    expect(pushRows(f.db)).toEqual([]);
  });

  it("another client's run, and another HTTP subject's run, are unknown runs exactly like an id that does not exist", async () => {
    f = await start();
    const { runId, sessionId } = await f.seedRun({ clientId: "linus" });
    f.bindings.bind(sessionId, "sbc_subject_a");
    const ownerA = await f.connect("linus", "sbc_subject_a");
    const otherSubject = await f.connect("linus", "sbc_subject_b");
    const otherClient = await f.connect("peer");
    for (const call of [otherSubject, otherClient]) {
      const r = await call("publish_run", { run_id: runId });
      expect(r.body.error).toMatchObject({ code: "INVALID_REQUEST", message: `unknown run ${runId}` });
    }
    expect(pushRows(f.db)).toEqual([]);
    expect((await ownerA("publish_run", { run_id: runId, open_pull_request: false })).isError).toBe(false);
  });
});

describe("run visibility of queue-admitted runs over the HTTP-subject path (FR-QUE-08, FR-MCP-15)", () => {
  it("every subject of the enqueuing client sees the run on every run-scoped tool; another client or subject does not", async () => {
    f = await start();
    const subjectA = await f.connect("linus", "sbc_subject_a");
    const subjectB = await f.connect("linus", "sbc_subject_b");
    const peer = await f.connect("peer", "sbc_subject_p");
    const enq = await subjectA("enqueue_work", {
      project_id: "web",
      request: { objective: "queued work", trust_profile: "edit-untrusted" },
    });
    expect(enq.isError, JSON.stringify(enq.body)).toBe(false);
    f.lifecycle.start();
    expect(await runProjectWorkQueueTick(f.ledger, f.queue, { maxItemsPerProject: 500, dequeueBatch: 1 })).toEqual({
      admitted: 1,
      retried: 0,
      failed: 0,
    });
    const queuedRun = f.ledger.getWorkItem(enq.body.work_item_id)?.admitted_run_id as string;
    await f.lifecycle.waitForTerminal(queuedRun);
    // A run subject A delegated directly is A's only (T13.5).
    const direct = await subjectA("delegate_task", {
      objective: "direct work",
      project: "web",
      trust_profile: "edit-untrusted",
    });
    expect(direct.isError, JSON.stringify(direct.body)).toBe(false);
    const directRun = direct.body.run_id as string;
    await f.lifecycle.waitForTerminal(directRun);

    const visible = async (call: typeof subjectA, runId: string) => {
      expect((await call("get_run", { run_id: runId })).body.run_id).toBe(runId);
      expect((await call("list_runs", {})).body.runs.map((r: Json) => r.run_id)).toContain(runId);
      expect((await call("get_artifacts", { run_id: runId })).body.run_id).toBe(runId);
      expect((await call("explain_route", { run_id: runId })).isError).toBe(false);
      const digest = (await call("get_digest", {})).body;
      const ids = digest.projects.flatMap((p: Json) => [...p.finished, ...p.failed].map((e: Json) => e.run_id));
      expect(ids).toContain(runId);
      // Visible: the answer is about the run itself (it has no published commit), never "unknown run".
      const pub = await call("publish_run", { run_id: runId });
      expect(pub.body.error).toMatchObject({ details: { reason: "NOTHING_TO_PUBLISH" } });
    };
    const unknown = async (call: typeof subjectA, runId: string) => {
      for (const tool of ["get_run", "get_artifacts", "explain_route", "publish_run"]) {
        const r = await call(tool, { run_id: runId });
        expect(r.body.error, tool).toMatchObject({ code: "INVALID_REQUEST", message: `unknown run ${runId}` });
      }
      expect((await call("list_runs", {})).body.runs.map((r: Json) => r.run_id)).not.toContain(runId);
      const digest = (await call("get_digest", {})).body;
      const ids = digest.projects.flatMap((p: Json) => [...p.finished, ...p.failed].map((e: Json) => e.run_id));
      expect(ids).not.toContain(runId);
    };
    await visible(subjectA, queuedRun);
    await visible(subjectB, queuedRun);
    await unknown(peer, queuedRun);
    await visible(subjectA, directRun);
    await unknown(subjectB, directRun);
    await unknown(peer, directRun);
  });
});
