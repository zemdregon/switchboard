/**
 * MCP `merge_run_pr` on an umbrella publication with linked submodule pull requests (ADR-0080 item 7, LLD §3.4.17),
 * through the server as an orchestrating client calls it: each call advances the ordered merge as far as it can and
 * returns `submodule_merge: { phase, repos }` on the result and on every refusal's details; the state survives a new
 * server instance over the same ledger. The result is checked against the published output schema by the SDK.
 * Local fixture repositories, the controller pusher to a local bare remote, and a fake GitHub only.
 */
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { type FakePr, IDENTITY, makeWorld, PROJECT, UMBRELLA_GH, type World } from "../ci/fixtures/submodule-merge.js";
import { submoduleMergeHook } from "../ci/submodule-merge.js";
import type { ResolvedMcpClient, ResolvedProject } from "../config/index.js";
import type { TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { DynamicProjectStore } from "../projects/index.js";
import { g } from "../submodules/fixtures/repos.js";
import { WorkspaceManager } from "../workspace/index.js";
import type { MergeRunDeps } from "./merge-run-pr.js";
import { createSwitchboardServer } from "./server.js";

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

const CLIENT: ResolvedMcpClient = {
  id: "steward",
  maxTrustProfile: "edit-untrusted",
  manageProjects: true,
  maxPushPolicy: "branch",
  projects: [PROJECT],
};

let w: World | undefined;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  w?.close();
  w = undefined;
});

/** One server instance over the world's current ledger handle (a "restart" builds another after `reopen`). */
async function connect(
  world: World,
): Promise<(name: string, args?: Json) => Promise<{ isError: boolean; body: Json }>> {
  const artifacts = new ArtifactStore(path.join(world.dataDir, "artifacts"));
  const workspace = new WorkspaceManager({
    db: world.db,
    artifacts,
    dataDir: world.dataDir,
    allowedRoots: [world.fx.root],
  });
  const registry = new AdapterRegistry().register(new FakeAdapter({ scenario: "success" }));
  const lifecycle = new RunLifecycle({
    ledger: world.ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots: [world.fx.root],
    globalConcurrency: 1,
    resolveProfile: profileFor,
    eligibility: {
      platform: "linux",
      gate: (id, version) => ({
        eligible: true,
        evidence: { provider: id, observedVersion: version, validatedRange: "test", validatedCliVersion: "test" },
      }),
    },
  });
  const project: ResolvedProject = {
    id: PROJECT,
    name: "Umbrella",
    environment: { kind: "host" },
    contexts: [
      {
        id: "main",
        kind: "repository",
        path: world.umbrella,
        baseRef: "main",
        primary: true,
        writable: true,
        sign: false,
        finalizeCommit: false,
        identity: IDENTITY,
        push: { policy: "branch", remote: "origin", branchPrefix: "sb/" },
      },
    ],
    mergePolicy: world.policy,
  };
  const store = new DynamicProjectStore(world.db);
  const gate = { db: world.db, ledger: world.ledger, merge: world.gh, targets: world.targets };
  const mergeRun: MergeRunDeps = {
    ...gate,
    resolveRemote: async () => UMBRELLA_GH,
    linkedMerge: submoduleMergeHook(gate, world.sub()),
  };
  const mcp = createSwitchboardServer({
    lifecycle,
    ledger: world.ledger,
    artifacts,
    registry,
    config: {
      allowedRoots: [world.fx.root],
      mcpClients: new Map([[CLIENT.id, CLIENT]]),
      projects: [project],
      dataDir: world.dataDir,
    },
    clientId: CLIENT.id,
    projectStore: store,
    publish: {
      pusher: {
        push: async () => {
          throw new Error("publish_run is not called here");
        },
      },
      resolveContext: () => world.pushContext,
      pulls: {
        findForBranch: async () => {
          throw new Error("never");
        },
        create: async () => {
          throw new Error("never");
        },
      },
    },
    mergeRun,
  });
  const client = new Client({ name: CLIENT.id, version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(st);
  await client.connect(ct);
  // Caches the output schemas, so each result below is checked against the published schema by the SDK.
  await client.listTools();
  closers.push(async () => {
    await client.close();
    await mcp.close();
    await lifecycle.shutdown();
  });
  return async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}") as Json;
    return { isError: res.isError === true, body };
  };
}

const pr = (world: World, repo: string) => world.gh.prs.get(repo) as FakePr;

describe("merge_run_pr with linked submodule pull requests (ADR-0080 item 7)", () => {
  it("merges both submodule PRs (squash), pushes the repoint commit and merges the umbrella in one call", async () => {
    w = await makeWorld();
    w.verify();
    const call = await connect(w);
    const r = await call("merge_run_pr", { run_id: w.runId, expected_head_sha: w.preTip });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const tip = w.remoteTip();
    const a = pr(w, "acme/liba").mergeCommitSha as string;
    const b = pr(w, "acme/libb").mergeCommitSha as string;
    expect(r.body).toEqual({
      run_id: w.runId,
      pull_request: { number: 42, url: "https://github.com/acme/umbrella/pull/42" },
      merged: true,
      head_sha: tip,
      head_kind: "published",
      method: "squash",
      submodule_merge: {
        phase: "merged",
        repos: [
          { repo: "acme/liba", paths: ["libs/a", "vendor/a"], pr_number: 11, state: "merged", merged_sha: a },
          { repo: "acme/libb", paths: ["libs/b"], pr_number: 12, state: "merged", merged_sha: b },
        ],
      },
    });
    expect(g(w.bare, "rev-parse", `${tip}:vendor/a`)).toBe(a);
    expect(w.gh.merges.map((m) => [m.repo, m.headSha])).toEqual([
      ["acme/liba", w.libs.a.head1],
      ["acme/libb", w.libs.b.head1],
      ["acme/umbrella", tip],
    ]);
    // Idempotent: merged already.
    const again = await call("merge_run_pr", { run_id: w.runId });
    expect(again.isError).toBe(false);
    expect(again.body.submodule_merge.phase).toBe("merged");
    expect(w.gh.merges).toHaveLength(3);
  });

  it("a pending check on a submodule PR refuses with the progress; a later call resumes", async () => {
    w = await makeWorld();
    w.verify();
    pr(w, "acme/libb").checks = { kind: "checks", buckets: ["pending"] };
    const call = await connect(w);
    const first = await call("merge_run_pr", { run_id: w.runId });
    expect(first.isError).toBe(true);
    expect(first.body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      message: "merge refused (check_pending)",
      details: {
        reason: "check_pending",
        head_sha: w.preTip,
        submodule_merge: {
          phase: "submodules",
          repos: [
            { repo: "acme/liba", state: "merged" },
            { repo: "acme/libb", state: "refused", reason: "check_pending" },
          ],
        },
      },
    });
    pr(w, "acme/libb").checks = { kind: "checks", buckets: ["pass"] };
    const second = await call("merge_run_pr", { run_id: w.runId });
    expect(second.isError, JSON.stringify(second.body)).toBe(false);
    expect(w.gh.merges.map((m) => m.repo)).toEqual(["acme/liba", "acme/libb", "acme/umbrella"]);
  });

  it("a new server instance over the same ledger resumes at the umbrella phase without a second repoint", async () => {
    w = await makeWorld();
    w.verify();
    pr(w, "acme/umbrella").checks = { kind: "checks", buckets: ["pending"] };
    const call = await connect(w);
    const first = await call("merge_run_pr", { run_id: w.runId });
    expect(first.body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { reason: "check_pending", submodule_merge: { phase: "umbrella" } },
    });
    const tip = w.remoteTip();
    expect(tip).not.toBe(w.preTip);
    for (const c of closers.splice(0)) await c();
    w.reopen();
    pr(w, "acme/umbrella").checks = { kind: "checks", buckets: ["pass"] };
    const restarted = await connect(w);
    // The caller's expected head may still be the published tip it got from publish_run.
    const r = await restarted("merge_run_pr", { run_id: w.runId, expected_head_sha: w.preTip });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(r.body).toMatchObject({ head_sha: tip, submodule_merge: { phase: "merged" } });
    expect(w.steps().map((s) => s.step)).toEqual(["submodule_merged", "submodule_merged", "gitlinks_repointed"]);
    expect(w.gh.merges.filter((m) => m.repo !== "acme/umbrella")).toHaveLength(2);
  });

  it("verification is read at the pre-repoint tip: without it the umbrella is unverified_at_head", async () => {
    w = await makeWorld();
    const call = await connect(w);
    const r = await call("merge_run_pr", { run_id: w.runId });
    expect(r.body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { reason: "unverified_at_head", submodule_merge: { phase: "umbrella" } },
    });
    w.verify(w.preTip);
    const again = await call("merge_run_pr", { run_id: w.runId });
    expect(again.isError, JSON.stringify(again.body)).toBe(false);
  });

  it("a repoint push that would not fast-forward is refused with its reason; the remote keeps the foreign commit", async () => {
    w = await makeWorld();
    w.verify();
    const foreign = g(w.umbrella, "commit-tree", `${w.preTip}^{tree}`, "-p", w.preTip, "-m", "foreign");
    g(w.umbrella, "push", "-q", "origin", `${foreign}:${w.publishRef}`);
    const call = await connect(w);
    const r = await call("merge_run_pr", { run_id: w.runId });
    expect(r.body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { reason: "repoint_not_fast_forward", submodule_merge: { phase: "repoint" } },
    });
    expect(w.remoteTip()).toBe(foreign);
  });

  it("an expected_head_sha that is neither the published nor the repointed tip is head_moved", async () => {
    w = await makeWorld();
    w.verify();
    const call = await connect(w);
    const r = await call("merge_run_pr", { run_id: w.runId, expected_head_sha: "9".repeat(40) });
    expect(r.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "head_moved" } });
    expect(w.gh.merges).toEqual([]);
  });
});
