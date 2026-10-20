/**
 * MCP `merge_run_pr` (ADR-0070, LLD §3.4.13) through the server as an orchestrating client calls it: offered exactly
 * when `publish_run` is and the merge port is wired, scoped like `publish_run` (another client's or subject's run is
 * unknown), deciding with T15.8's shared gate (`applyMergeGate`, LLD §20.7) over a fake {@link CiMergePort}: merges a
 * green, mergeable, published pull request pinned to the published head; refuses policy off, a paused project, a
 * draft, a moved head or an `expected_head_sha` mismatch, a base mismatch, a pull request that is not mergeable, no
 * required checks, a pending or failed check, and a head without a passed verification unless the policy sets
 * `require_verification: false`; idempotent on an already merged pull request; every decision a `merge_event` row
 * visible in `get_digest`. A dynamic project's `update_project` turning the policy on waits for `decide_approval`.
 * No real `gh`, no network, no provider CLI.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import type { PullHeadInspection, PullHeadPort, PullHeadQuery } from "../ci/base-merge.js";
import { mergeTargetsFrom } from "../ci/merge-policy.js";
import type { CiBranchUpdatePort, CiMergePort, CiPullRequestGateView, CiRequiredChecks } from "../ci/port.js";
import { CiStatusError } from "../ci/port.js";
import type { ResolvedMcpClient, ResolvedProject } from "../config/index.js";
import { projectPushContextResolver } from "../git/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { DynamicProjectStore } from "../projects/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { SubjectBindingStore } from "./http-subjects.js";
import type { MergeRunDeps } from "./merge-run-pr.js";
import { createSwitchboardServer } from "./server.js";

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON checked by the published output schemas
type Json = Record<string, any>;

const TIP = "2".repeat(40);
const OTHER = "4".repeat(40);
const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };
const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

/** G10 to G12 fake: the view follows the queried branch unless a test overrides a field. */
class FakeMerge implements CiMergePort {
  calls: string[] = [];
  view: Partial<CiPullRequestGateView> | null = {};
  checks: CiRequiredChecks | Error = { kind: "checks", buckets: ["pass", "pass"] };
  mergeError: Error | undefined;
  merges: { prNumber: number; method: string; headSha: string; owner: string; repo: string }[] = [];
  async pullRequestGateView(q: { publishRef: string }): Promise<CiPullRequestGateView | null> {
    this.calls.push("view");
    if (this.view === null) return null;
    return {
      number: 42,
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      headSha: TIP,
      headBranch: q.publishRef.slice("refs/heads/".length),
      baseBranch: "main",
      ...this.view,
    };
  }
  async requiredChecks(): Promise<CiRequiredChecks> {
    this.calls.push("checks");
    if (this.checks instanceof Error) throw this.checks;
    return this.checks;
  }
  async mergePullRequest(q: { owner: string; repo: string; prNumber: number; method: string; headSha: string }) {
    this.calls.push("merge");
    if (this.mergeError) throw this.mergeError;
    this.merges.push({ ...q });
  }
}

/** ADR-0073: the controller's Git read of the pull request head, as a test sets it. */
class FakePullHeads implements PullHeadPort {
  queries: PullHeadQuery[] = [];
  result: PullHeadInspection = { kind: "read", head: "published", upToDate: false, conflicts: false };
  async inspect(q: PullHeadQuery): Promise<PullHeadInspection> {
    this.queries.push(q);
    return this.result;
  }
}

/** ADR-0073: G15 fake. */
class FakeUpdate implements CiBranchUpdatePort {
  updates: { owner: string; repo: string; prNumber: number; expectedHeadSha: string }[] = [];
  error: Error | undefined;
  async updatePullRequestBranch(q: { owner: string; repo: string; prNumber: number; expectedHeadSha: string }) {
    if (this.error) throw this.error;
    this.updates.push({ ...q });
  }
}

const CLIENTS: ResolvedMcpClient[] = [
  {
    id: "steward",
    maxTrustProfile: "edit-untrusted",
    manageProjects: true,
    maxPushPolicy: "branch",
    projects: ["web", "plain", "noverify"],
    approvalProxy: true,
    approvalProxyTargets: ["steward"],
    approvalProxyKinds: ["dynamic_project", "push_revision"],
  },
  { id: "peer", maxTrustProfile: "edit-untrusted", manageProjects: true, maxPushPolicy: "branch", projects: ["web"] },
  { id: "nopush", maxTrustProfile: "edit-untrusted", manageProjects: true, maxPushPolicy: "none", projects: ["web"] },
];

interface Fixture {
  root: string;
  repo: string;
  db: Database.Database;
  ledger: Ledger;
  store: DynamicProjectStore;
  merge: FakeMerge;
  heads: FakePullHeads;
  update: FakeUpdate;
  bindings: SubjectBindingStore;
  connect(
    clientId: string,
    opts?: { subject?: string; noMergePort?: boolean; noUpdatePort?: boolean },
  ): Promise<{ call: (name: string, args?: Json) => Promise<{ isError: boolean; body: Json }>; tools: string[] }>;
  published(o?: { clientId?: string; projectId?: string; sha?: string }): { runId: string; sessionId: string };
  verify(p: { runId: string; sessionId: string }, sha?: string): void;
  close(): Promise<void>;
}

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function start(): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-merge-run-")));
  const repo = path.join(root, "repos", "web");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: repo,
    env: GIT_ENV,
  });
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
  const ctx = {
    id: "main",
    kind: "repository" as const,
    path: repo,
    baseRef: "main",
    primary: true,
    writable: true,
    sign: false,
    finalizeCommit: false,
    identity: IDENTITY,
    push: { policy: "branch" as const, remote: "origin", branchPrefix: "sb/" },
  };
  const projects: ResolvedProject[] = [
    {
      id: "web",
      name: "Web",
      environment: { kind: "host" },
      contexts: [ctx],
      mergePolicy: { enabled: true, method: "squash", requiredReports: [] },
    },
    { id: "plain", name: "Plain", environment: { kind: "host" }, contexts: [ctx] },
    {
      id: "noverify",
      name: "No verify",
      environment: { kind: "host" },
      contexts: [ctx],
      mergePolicy: { enabled: true, method: "rebase", requiredReports: [], requireVerification: false },
    },
  ];
  const mcpClients = new Map(CLIENTS.map((c) => [c.id, c]));
  const config = { allowedRoots: [root], mcpClients, projects, dataDir };
  const store = new DynamicProjectStore(db, { ids });
  const resolveContext = projectPushContextResolver({ projects, store, clients: mcpClients });
  const publish = {
    pusher: {
      push: async () => {
        throw new Error("merge_run_pr never pushes");
      },
    },
    resolveContext,
    pulls: {
      findForBranch: async () => {
        throw new Error("merge_run_pr never opens a pull request");
      },
      create: async () => {
        throw new Error("merge_run_pr never opens a pull request");
      },
    },
  };
  const merge = new FakeMerge();
  const heads = new FakePullHeads();
  const update = new FakeUpdate();
  const mergeRun: MergeRunDeps = {
    db,
    merge,
    targets: () => mergeTargetsFrom(projects, store),
    resolveRemote: async () => ({ owner: "acme", repo: "web" }),
    pullHeads: heads,
    update,
  };
  const mergeRunNoUpdate: MergeRunDeps = {
    db,
    merge,
    targets: mergeRun.targets,
    resolveRemote: mergeRun.resolveRemote,
    pullHeads: heads,
  };
  const bindings = new SubjectBindingStore(db);
  const opened: (() => Promise<void>)[] = [];
  let seq = 0;
  const fixture: Fixture = {
    root,
    repo,
    db,
    ledger,
    store,
    merge,
    heads,
    update,
    bindings,
    connect: async (clientId, opts = {}) => {
      const mcp = createSwitchboardServer({
        lifecycle,
        ledger,
        artifacts,
        registry,
        config,
        clientId,
        projectStore: store,
        subjectBindings: bindings,
        ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
        publish,
        ...(opts.noMergePort === true ? {} : { mergeRun: opts.noUpdatePort === true ? mergeRunNoUpdate : mergeRun }),
      });
      const client = new Client({ name: clientId, version: "0.0.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await mcp.server.connect(st);
      await client.connect(ct);
      // Caches the output schemas, so each result below is checked against the published schema by the SDK.
      const tools = (await client.listTools()).tools.map((t) => t.name);
      opened.push(async () => {
        await client.close();
        await mcp.close();
      });
      return {
        tools,
        call: async (name, args = {}) => {
          const res = await client.callTool({ name, arguments: args });
          const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}") as Json;
          return { isError: res.isError === true, body };
        },
      };
    },
    published: (o = {}) => {
      seq++;
      const projectId = o.projectId ?? "web";
      const clientId = o.clientId ?? "steward";
      const session = ledger.createMetaSession({ objective: "work", repoRoot: repo, projectId });
      const run = ledger.createRun({
        metaSessionId: session.id,
        state: "SUCCEEDED",
        trustProfile: "edit-untrusted",
        policySnapshot: {},
        request: {},
        requestHash: "h",
        clientId,
        provider: "fake",
        projectId,
      });
      db.prepare(
        `INSERT INTO git_push (id, run_id, project_id, context_id, remote, ref, head_sha, outcome, detail,
           requested_by, created_at) VALUES (?, ?, ?, 'main', 'origin', ?, ?, 'ACCEPTED', NULL, ?, ?)`,
      ).run(
        `gps_m070_${String(seq).padStart(22, "0")}`,
        run.id,
        projectId,
        `refs/heads/sb/${session.id}`,
        o.sha ?? TIP,
        `mcp_client:${clientId}`,
        `2026-10-20T01:00:${String(seq).padStart(2, "0")}.000Z`,
      );
      return { runId: run.id, sessionId: session.id };
    },
    verify: (p, sha = TIP) => {
      ledger.recordVerificationResult({
        runId: p.runId,
        metaSessionId: p.sessionId,
        publishRef: `refs/heads/sb/${p.sessionId}`,
        headSha: sha,
        treeSha: "a".repeat(40),
        outcome: "passed",
        artifactId: null,
      });
    },
    close: async () => {
      for (const c of opened) await c();
      await lifecycle.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return fixture;
}

const mergeRows = (db: Database.Database) =>
  db.prepare("SELECT outcome, reason, pr_number, head_sha, method, run_id FROM merge_event ORDER BY rowid").all();

describe("merge_run_pr (ADR-0070)", () => {
  it("is offered exactly with publish_run and the merge port; otherwise it is an unknown tool", async () => {
    f = await start();
    const steward = await f.connect("steward");
    expect(steward.tools).toContain("publish_run");
    expect(steward.tools).toContain("merge_run_pr");
    const noPort = await f.connect("steward", { noMergePort: true });
    expect(noPort.tools).toContain("publish_run");
    expect(noPort.tools).not.toContain("merge_run_pr");
    const nopush = await f.connect("nopush");
    expect(nopush.tools).not.toContain("merge_run_pr");
    const { runId } = f.published({ clientId: "nopush" });
    for (const c of [noPort, nopush]) {
      const r = await c.call("merge_run_pr", { run_id: runId });
      expect(r.body.error).toMatchObject({ code: "INVALID_REQUEST", message: 'unknown tool "merge_run_pr"' });
      expect(r.body.error.details.tools).not.toContain("merge_run_pr");
    }
    expect(f.merge.calls).toEqual([]);
  });

  it("merges a green, mergeable, verified, published pull request pinned to the published head; get_digest shows it", async () => {
    f = await start();
    const { call } = await f.connect("steward");
    const p = f.published();
    f.verify(p);
    const r = await call("merge_run_pr", { run_id: p.runId, expected_head_sha: TIP });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(r.body).toEqual({
      run_id: p.runId,
      pull_request: { number: 42, url: "https://github.com/acme/web/pull/42" },
      merged: true,
      head_sha: TIP,
      head_kind: "published",
      method: "squash",
    });
    expect(f.merge.merges).toEqual([{ owner: "acme", repo: "web", prNumber: 42, method: "squash", headSha: TIP }]);
    // Gate order: G10, G11, the G10 re-read, then G12.
    expect(f.merge.calls).toEqual(["view", "checks", "view", "merge"]);
    expect(mergeRows(f.db)).toEqual([
      { outcome: "attempted", reason: null, pr_number: 42, head_sha: TIP, method: "squash", run_id: p.runId },
      { outcome: "merged", reason: null, pr_number: 42, head_sha: TIP, method: "squash", run_id: p.runId },
    ]);
    const digest = (await call("get_digest", {})).body;
    const web = digest.projects.find((x: Json) => x.project_id === "web");
    expect(JSON.stringify(web)).toContain('"merge_event"');
    expect(JSON.stringify(web)).toContain('"merged"');
  });

  it("is idempotent: a pull request already merged at the published head returns merged true without G12", async () => {
    f = await start();
    const { call } = await f.connect("steward");
    const p = f.published();
    f.merge.view = { state: "MERGED" };
    const r = await call("merge_run_pr", { run_id: p.runId });
    expect(r.body).toMatchObject({ merged: true, head_sha: TIP, pull_request: { number: 42 } });
    expect(f.merge.calls).toEqual(["view"]);
    expect(mergeRows(f.db)).toEqual([]);
    expect(f.db.prepare("SELECT kind FROM ref_event").all()).toEqual([{ kind: "merged" }]);
  });

  const refusals: [string, (fx: Fixture) => void, string, Json?][] = [
    ["a draft", (fx) => (fx.merge.view = { isDraft: true }), "draft"],
    ["a moved head", (fx) => (fx.merge.view = { headSha: OTHER }), "head_moved"],
    ["a base mismatch", (fx) => (fx.merge.view = { baseBranch: "develop" }), "base_mismatch"],
    ["a pull request that is not mergeable", (fx) => (fx.merge.view = { mergeable: "CONFLICTING" }), "not_mergeable"],
    ["no pull request", (fx) => (fx.merge.view = null), "not_mergeable"],
    ["a closed pull request", (fx) => (fx.merge.view = { state: "CLOSED" }), "not_mergeable"],
    ["no required checks", (fx) => (fx.merge.checks = { kind: "none" }), "no_required_checks"],
    ["a pending check", (fx) => (fx.merge.checks = { kind: "checks", buckets: ["pass", "pending"] }), "check_pending"],
    ["a failed check", (fx) => (fx.merge.checks = { kind: "checks", buckets: ["pass", "fail"] }), "check_failed"],
    ["an expected_head_sha mismatch", () => undefined, "head_moved", { expected_head_sha: OTHER }],
  ];
  for (const [label, arrange, reason, extra] of refusals) {
    it(`refuses ${label}: PERMISSION_BLOCKED ${reason}, recorded, no merge`, async () => {
      f = await start();
      const { call } = await f.connect("steward");
      const p = f.published();
      f.verify(p);
      arrange(f);
      const r = await call("merge_run_pr", { run_id: p.runId, ...(extra ?? {}) });
      expect(r.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", retryable: false, details: { reason } });
      expect(f.merge.merges).toEqual([]);
      expect(f.merge.calls).not.toContain("merge");
      expect(mergeRows(f.db)).toEqual([expect.objectContaining({ outcome: "refused", reason, run_id: p.runId })]);
    });
  }

  it("refuses a project without the policy, and a paused project, as policy_off before any gh call", async () => {
    f = await start();
    const { call } = await f.connect("steward");
    const plain = f.published({ projectId: "plain" });
    const off = await call("merge_run_pr", { run_id: plain.runId });
    expect(off.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "policy_off" } });
    const p = f.published();
    f.verify(p);
    expect((await call("pause_project", { project_id: "web" })).body).toMatchObject({ paused: true });
    const paused = await call("merge_run_pr", { run_id: p.runId });
    expect(paused.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "policy_off" } });
    expect(f.merge.calls).toEqual([]);
    expect(mergeRows(f.db)).toEqual([
      expect.objectContaining({ outcome: "refused", reason: "policy_off", run_id: plain.runId }),
      expect.objectContaining({ outcome: "refused", reason: "policy_off", run_id: p.runId }),
    ]);
  });

  it("refuses a head without a passed verification; require_verification false merges without one", async () => {
    f = await start();
    const { call } = await f.connect("steward");
    const p = f.published();
    const r = await call("merge_run_pr", { run_id: p.runId });
    expect(r.body.error).toMatchObject({ details: { reason: "unverified_at_head" } });
    const nv = f.published({ projectId: "noverify" });
    const ok = await call("merge_run_pr", { run_id: nv.runId });
    expect(ok.isError, JSON.stringify(ok.body)).toBe(false);
    expect(ok.body).toMatchObject({ merged: true, method: "rebase" });
    expect(f.merge.merges).toEqual([expect.objectContaining({ method: "rebase", headSha: TIP })]);
  });

  it("a gh failure is TOOL_FAILURE gh_error, retryable; a retry after the failed G12 merges", async () => {
    f = await start();
    const { call } = await f.connect("steward");
    const p = f.published();
    f.verify(p);
    f.merge.mergeError = new CiStatusError("GH_FAILED");
    const r = await call("merge_run_pr", { run_id: p.runId });
    expect(r.body.error).toMatchObject({ code: "TOOL_FAILURE", retryable: true, details: { reason: "gh_error" } });
    f.merge.mergeError = undefined;
    const again = await call("merge_run_pr", { run_id: p.runId });
    expect(again.body).toMatchObject({ merged: true });
  });

  it("another client's run, another subject's run and an unpublished run are refused without any gh call", async () => {
    f = await start();
    const p = f.published();
    f.verify(p);
    f.bindings.bind(p.sessionId, "sbc_subject_a");
    const other = await f.connect("steward", { subject: "sbc_subject_b" });
    const peer = await f.connect("peer");
    for (const c of [other, peer]) {
      const r = await c.call("merge_run_pr", { run_id: p.runId });
      expect(r.body.error).toMatchObject({ code: "INVALID_REQUEST", message: `unknown run ${p.runId}` });
    }
    const owner = await f.connect("steward", { subject: "sbc_subject_a" });
    const session = f.ledger.createMetaSession({ objective: "x", repoRoot: f.repo, projectId: "web" });
    const bare = f.ledger.createRun({
      metaSessionId: session.id,
      state: "SUCCEEDED",
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h",
      clientId: "steward",
      provider: "fake",
      projectId: "web",
    });
    f.bindings.bind(session.id, "sbc_subject_a");
    expect((await owner.call("merge_run_pr", { run_id: bare.id })).body.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "NOT_PUBLISHED" },
    });
    expect(f.merge.calls).toEqual([]);
    expect((await owner.call("merge_run_pr", { run_id: p.runId })).body).toMatchObject({ merged: true });
  });

  it("update_project turning the policy on waits for decide_approval; list_projects shows the policy in force", async () => {
    f = await start();
    const { call } = await f.connect("steward");
    const definition = (mergePolicy?: Json): Json => ({
      id: "site",
      name: "Site",
      contexts: [
        {
          id: "main",
          kind: "repository",
          path: f?.repo,
          base_ref: "main",
          push: { policy: "branch", remote: "origin", branch_prefix: "sb/" },
          identity: IDENTITY,
        },
      ],
      ...(mergePolicy !== undefined ? { merge_policy: mergePolicy } : {}),
    });
    const approveAll = async () => {
      const pending = (await call("list_pending_approvals", {})).body.approvals as Json[];
      for (const item of pending) {
        const d = await call("decide_approval", {
          approval_id: item.approval_id,
          approval_digest: item.approval_digest,
          decision: "approve",
        });
        expect(d.body, JSON.stringify(d.body)).toMatchObject({ status: "APPROVED" });
      }
      return pending.length;
    };
    const created = await call("create_project", { project: definition() });
    expect(created.isError, JSON.stringify(created.body)).toBe(false);
    expect(await approveAll()).toBe(1);
    const p = f.published({ projectId: "site" });
    f.verify(p);
    expect((await call("merge_run_pr", { run_id: p.runId })).body.error).toMatchObject({
      details: { reason: "policy_off" },
    });

    const updated = await call("update_project", {
      id: "site",
      project: definition({ enabled: true, method: "squash", require_verification: false }),
    });
    expect(updated.body).toMatchObject({ status: "PENDING_APPROVAL" });
    expect(updated.body.approval_needed).toContain("merge_policy");
    // Still the revision without the policy in force: refused, and list_projects shows no policy yet.
    expect((await call("merge_run_pr", { run_id: p.runId })).body.error).toMatchObject({
      details: { reason: "policy_off" },
    });
    const before = (await call("list_projects", {})).body.projects.find((x: Json) => x.id === "site");
    expect(before.merge_policy).toBeUndefined();

    expect(await approveAll()).toBe(1);
    const after = (await call("list_projects", {})).body.projects.find((x: Json) => x.id === "site");
    expect(after).toMatchObject({
      status: "ACTIVE",
      merge_policy: { enabled: true, method: "squash", required_reports: [], require_verification: false },
    });
    const web = (await call("list_projects", {})).body.projects.find((x: Json) => x.id === "web");
    expect(web.merge_policy).toEqual({
      enabled: true,
      method: "squash",
      required_reports: [],
      require_verification: true,
    });
    const merged = await call("merge_run_pr", { run_id: p.runId });
    expect(merged.isError, JSON.stringify(merged.body)).toBe(false);
    expect(merged.body).toMatchObject({ merged: true, method: "squash" });
  });
});

describe("update_run_branch and pure base merges (ADR-0073)", () => {
  const BASE_MERGE = "5".repeat(40);

  it("is offered with merge_run_pr and the update port; otherwise, and to a client without push, an unknown tool", async () => {
    f = await start();
    expect((await f.connect("steward")).tools).toContain("update_run_branch");
    const noUpdate = await f.connect("steward", { noUpdatePort: true });
    expect(noUpdate.tools).toContain("merge_run_pr");
    expect(noUpdate.tools).not.toContain("update_run_branch");
    expect((await f.connect("steward", { noMergePort: true })).tools).not.toContain("update_run_branch");
    const nopush = await f.connect("nopush");
    expect(nopush.tools).not.toContain("update_run_branch");
    const { runId } = f.published({ clientId: "nopush" });
    for (const c of [noUpdate, nopush]) {
      const r = await c.call("update_run_branch", { run_id: runId });
      expect(r.body.error).toMatchObject({ code: "INVALID_REQUEST", message: 'unknown tool "update_run_branch"' });
    }
    expect(f.update.updates).toEqual([]);
  });

  it("asks GitHub to update the branch, pinned to the head it read; a branch_update run event is recorded", async () => {
    f = await start();
    const { call } = await f.connect("steward");
    const p = f.published();
    const r = await call("update_run_branch", { run_id: p.runId, expected_head_sha: TIP });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(r.body).toEqual({
      run_id: p.runId,
      pull_request: { number: 42, url: "https://github.com/acme/web/pull/42" },
      updated: true,
      previous_head_sha: TIP,
    });
    expect(f.update.updates).toEqual([{ owner: "acme", repo: "web", prNumber: 42, expectedHeadSha: TIP }]);
    expect(f.heads.queries).toMatchObject([{ projectId: "web", prNumber: 42, baseBranch: "main", publishedSha: TIP }]);
    const ev = f.ledger.listRunEvents(p.runId).filter((e) => e.type === "branch_update");
    expect(ev.map((e) => JSON.parse(e.payload_json))).toEqual([
      { publish_ref: `refs/heads/sb/${p.sessionId}`, outcome: "requested", previous_head_sha: TIP, pr_number: 42 },
    ]);
    // Nothing was merged.
    expect(mergeRows(f.db)).toEqual([]);
  });

  it("returns updated false for a branch already up to date, without asking GitHub", async () => {
    f = await start();
    const { call } = await f.connect("steward");
    const p = f.published();
    f.heads.result = { kind: "read", head: "published", upToDate: true, conflicts: false };
    const r = await call("update_run_branch", { run_id: p.runId });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(r.body).toMatchObject({ updated: false, previous_head_sha: TIP });
    expect(f.update.updates).toEqual([]);
  });

  it("refuses policy off, a foreign head, a conflicting base and a moved expected head; gh failure is retryable", async () => {
    f = await start();
    const { call } = await f.connect("steward");
    const plain = f.published({ projectId: "plain" });
    const off = await call("update_run_branch", { run_id: plain.runId });
    expect(off.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "policy_off" } });
    const p = f.published();
    const moved = await call("update_run_branch", { run_id: p.runId, expected_head_sha: OTHER });
    expect(moved.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "head_moved" } });
    f.merge.view = { headSha: OTHER };
    f.heads.result = { kind: "read", head: "foreign", upToDate: false, conflicts: false };
    const foreign = await call("update_run_branch", { run_id: p.runId });
    expect(foreign.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "head_moved" } });
    f.merge.view = {};
    f.heads.result = { kind: "read", head: "published", upToDate: false, conflicts: true };
    const conflict = await call("update_run_branch", { run_id: p.runId });
    expect(conflict.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "not_mergeable" } });
    f.heads.result = { kind: "read", head: "published", upToDate: false, conflicts: false };
    f.update.error = new CiStatusError("GH_FAILED");
    const failed = await call("update_run_branch", { run_id: p.runId });
    expect(failed.body.error).toMatchObject({ code: "TOOL_FAILURE", retryable: true, details: { reason: "gh_error" } });
    expect(f.update.updates).toEqual([]);
  });

  it("another client's run is unknown, and nothing is read or written", async () => {
    f = await start();
    const p = f.published();
    const peer = await f.connect("peer");
    const r = await peer.call("update_run_branch", { run_id: p.runId });
    expect(r.body.error).toMatchObject({ code: "INVALID_REQUEST", message: `unknown run ${p.runId}` });
    expect(f.merge.calls).toEqual([]);
    expect(f.heads.queries).toEqual([]);
    expect(f.update.updates).toEqual([]);
  });

  it("merge_run_pr merges a pure base merge head pinned to it (head_kind base_merge), verified at the published tip", async () => {
    f = await start();
    const { call } = await f.connect("steward");
    const p = f.published();
    f.verify(p);
    f.merge.view = { headSha: BASE_MERGE };
    f.heads.result = { kind: "read", head: "base_merge", upToDate: true, conflicts: false };
    const r = await call("merge_run_pr", { run_id: p.runId, expected_head_sha: BASE_MERGE });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(r.body).toMatchObject({ merged: true, head_sha: BASE_MERGE, head_kind: "base_merge" });
    expect(f.merge.merges).toMatchObject([{ prNumber: 42, headSha: BASE_MERGE }]);
    // Without the pull-head reader the same head is head_moved, as before ADR-0073.
    f.heads.result = { kind: "read", head: "foreign", upToDate: false, conflicts: false };
    const q = f.published();
    f.verify(q);
    const refused = await call("merge_run_pr", { run_id: q.runId });
    expect(refused.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "head_moved" } });
  });
});
