/**
 * ADR-0079 items 5 and 6 (FR-GIT-14, LLD §3.4.16): `publish_run` on an umbrella run whose head changes gitlinks of
 * writable submodules, through the server as an orchestrating client calls it. Local fixture repositories only
 * (`src/submodules/fixtures/repos.ts`): every submodule "remote" is a local repository behind an https URL that the
 * injected push port and store runner map with command-scope `url.<local>.insteadOf` (production argv stays
 * https-only), the umbrella remote is a local bare repository, and `gh` is a fake {@link PullRequestPort}. Nothing
 * leaves the host; no real `gh` or provider CLI runs.
 *
 * Covered: the linked publication (two submodule repositories, one of them referenced by two paths), the multi-repo
 * secret scan refusing everything with a prefixed path, a rejected submodule push refusing with per-repository outcomes
 * and no umbrella push, a retry that pushes only what is missing, a `gh` failure on one repository, the
 * `SUBMODULE_HISTORY_UNVERIFIED` refusal, and the `linked_pull_requests` / `ref_events` exposure in `get_run`,
 * `list_runs` and `get_digest`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { type PullRequestLink, type PullRequestPort, PullRequestPortError } from "../ci/gh-pr.js";
import { parseGithubRemote } from "../ci/published-refs.js";
import type { ResolvedMcpClient, ResolvedProject } from "../config/index.js";
import { GitPublisher, GitPusher, projectPushContextResolver } from "../git/index.js";
import type { GitPushRun } from "../git/push.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { DynamicProjectStore } from "../projects/index.js";
import {
  commitFiles,
  GIT_ENV,
  g,
  gitmodulesText,
  HOST,
  makeFixture,
  makeRemote,
  makeUmbrella,
  OWNER,
  type Fixture as SubFixture,
} from "../submodules/fixtures/repos.js";
import { insertSubmoduleMerge } from "../submodules/ledger.js";
import { readSubmoduleManifest } from "../submodules/manifest.js";
import { prepareStores } from "../submodules/store.js";
import { attachRecordFile, attachSubmodules, writeAttachRecord } from "../submodules/worktree.js";
import { WorkspaceManager } from "../workspace/index.js";
import { createSwitchboardServer } from "./server.js";

const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };
const TOKEN = `ghp_canary${"0".repeat(30)}`;
const KEY_A = `${HOST}/acme/lib-a`;
const KEY_B = `${HOST}/acme/lib-b`;
const UMBRELLA_URL = "https://github.com/acme/umbrella/pull/1";
const WRITABLE = ["mods/a", "dup/a", "mods/b"];

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

/** A fake `gh`: one open pull request per `owner/repo` and branch, numbers per repository, failures per repository. */
class FakePulls implements PullRequestPort {
  calls: { op: "find" | "create"; args: Json }[] = [];
  open = new Map<string, PullRequestLink>();
  failFor = new Set<string>();
  private next = new Map<string, number>();
  async findForBranch(q: { owner: string; repo: string; branch: string }): Promise<PullRequestLink | null> {
    this.calls.push({ op: "find", args: q });
    if (this.failFor.has(`${q.owner}/${q.repo}`)) throw new PullRequestPortError("GH_FAILED", "gh failed");
    return this.open.get(`${q.owner}/${q.repo}#${q.branch}`) ?? null;
  }
  async create(q: Json & { owner: string; repo: string; branch: string }): Promise<{ number: number; url: string }> {
    this.calls.push({ op: "create", args: q });
    const repo = `${q.owner}/${q.repo}`;
    if (this.failFor.has(repo)) throw new PullRequestPortError("GH_FAILED", "gh failed");
    const number = (this.next.get(repo) ?? 0) + 1;
    this.next.set(repo, number);
    const url = `https://github.com/${repo}/pull/${number}`;
    this.open.set(`${repo}#${q.branch}`, { number, state: "OPEN", url });
    return { number, url };
  }
  created(repo: string): Json | undefined {
    return this.calls.find((c) => c.op === "create" && `${c.args.owner}/${c.args.repo}` === repo)?.args;
  }
}

const CLIENTS: ResolvedMcpClient[] = [
  { id: "linus", maxTrustProfile: "edit-untrusted", manageProjects: true, maxPushPolicy: "branch", projects: ["web"] },
];

interface Fx {
  sub: SubFixture;
  db: Database.Database;
  ledger: Ledger;
  pulls: FakePulls;
  umbrella: string;
  umbrellaBare: string;
  remotes: { a: string; b: string };
  /** Every argv the submodule push port saw. */
  pushCalls: string[][];
  call(name: string, args: Json): Promise<{ isError: boolean; body: Json }>;
  /** A SUCCEEDED run that changed `files` (umbrella-relative) and committed through the controller. */
  seedRun(files: Readonly<Record<string, string>>): Promise<{ runId: string; sessionId: string }>;
  close(): Promise<void>;
}

let f: Fx | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function start(): Promise<Fx> {
  const sub = makeFixture("sb-pubsub-");
  const root = sub.root;
  const a = makeRemote(sub, "lib-a", { "a.txt": "a\n" });
  const b = makeRemote(sub, "lib-b", { "b.txt": "b\n" }, { branch: "master" });
  const w = makeRemote(sub, "umbrella.wiki", { "Home.md": "home\n" });
  const u = makeUmbrella(
    sub,
    { "mods/a": a.head, "dup/a": a.head, "mods/b": b.head, wiki: w.head },
    gitmodulesText([
      ["a", "mods/a", `https://${HOST}/${OWNER}/lib-a.git`],
      ["a2", "dup/a", `https://${HOST}/${OWNER}/lib-a`],
      ["b", "mods/b", `https://${HOST}/${OWNER}/lib-b.git`],
      ["wiki", "wiki", `https://${HOST}/${OWNER}/umbrella.wiki.git`],
    ]),
  );
  const umbrellaBare = path.join(root, "umbrella-remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", umbrellaBare], { env: GIT_ENV });
  g(u.dir, "remote", "add", "origin", umbrellaBare);
  g(u.dir, "push", "-q", "origin", "main");

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
  const projects: ResolvedProject[] = [
    {
      id: "web",
      name: "Web",
      environment: { kind: "host" },
      contexts: [
        {
          id: "main",
          kind: "repository",
          path: u.dir,
          baseRef: "main",
          primary: true,
          writable: true,
          sign: false,
          finalizeCommit: false,
          identity: IDENTITY,
          push: { policy: "branch", remote: "origin", branchPrefix: "sb/" },
          submodules: { mode: "recursive", writablePaths: WRITABLE, exclude: [] },
        },
      ],
    },
  ];
  const mcpClients = new Map(CLIENTS.map((c) => [c.id, c]));
  const config = { allowedRoots: [root], mcpClients, projects, dataDir };
  const store = new DynamicProjectStore(db, { ids });
  const resolveContext = projectPushContextResolver({ projects, store, clients: mcpClients });
  const pusher = new GitPusher({ db, resolveContext, sourceEnv: { PATH: process.env.PATH, HOME: root }, ids });
  const pulls = new FakePulls();
  const pushCalls: string[][] = [];
  // The submodule push port: the production argv, with the fixture's https → local mapping in front (command scope).
  const push = async (cwd: string, args: readonly string[], timeoutMs: number): Promise<GitPushRun> => {
    pushCalls.push([...args]);
    const map: string[] = ["-c", "protocol.file.allow=always"];
    for (const [https, local] of sub.remotes) map.push("-c", `url.file://${local}.insteadOf=${https}`);
    const r = spawnSync("git", [...map, ...args], { cwd, env: GIT_ENV, encoding: "utf8", timeout: timeoutMs });
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: false, spawnError: !!r.error };
  };
  const publish = {
    pusher,
    resolveContext,
    pulls,
    pushUrl: async () => "https://github.com/acme/umbrella.git",
    submodules: {
      db,
      plan: (projectId: string) => (projectId === "web" ? { writablePaths: WRITABLE, exclude: [] } : undefined),
      sources: () => sub.settings,
      git: sub.runner,
      push,
      // The fixture host stands for github.com (the fake gh never reaches a network); names in lower case.
      githubRepo: (url: string) =>
        parseGithubRemote(url.replace(`https://${HOST}/`, "https://github.com/").toLowerCase()),
    },
  };
  const mcp = createSwitchboardServer({
    lifecycle,
    ledger,
    artifacts,
    registry,
    config,
    clientId: "linus",
    projectStore: store,
    publish,
  });
  const client = new Client({ name: "linus", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(st);
  await client.connect(ct);
  await client.listTools(); // output schemas are cached, so each result below is schema-checked by the SDK
  const publisher = new GitPublisher({
    db,
    scratchDir: path.join(root, "scratch"),
    submoduleCloneRoot: sub.settings.cloneRoot,
  });
  return {
    sub,
    db,
    ledger,
    pulls,
    umbrella: u.dir,
    umbrellaBare,
    remotes: { a: a.dir, b: b.dir },
    pushCalls,
    call: async (name, args) => {
      const res = await client.callTool({ name, arguments: args });
      const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}") as Json;
      return { isError: res.isError === true, body };
    },
    seedRun: async (files) => {
      const session = ledger.createMetaSession({ objective: "work", repoRoot: u.dir, projectId: "web" });
      const r = ledger.createRun({
        metaSessionId: session.id,
        state: "RUNNING",
        trustProfile: "edit-untrusted",
        policySnapshot: {},
        request: {},
        requestHash: "h",
        clientId: "linus",
        provider: "fake",
        projectId: "web",
      });
      const ws = await workspace.prepare({
        metaSessionId: session.id,
        runId: r.id,
        workspace: u.dir,
        trustProfile: "edit-untrusted",
      });
      if (ws.mode !== "worktree") throw new Error("expected a worktree");
      const manifest = await readSubmoduleManifest(u.dir, u.head, {
        sources: () => sub.settings,
        exclude: [],
        writable: WRITABLE,
      });
      const prepared = await prepareStores(manifest, undefined, { settings: sub.settings, git: sub.runner });
      const stores = new Map(prepared.map((p) => [p.key, p.path as string]));
      const rec = await attachSubmodules(ws.worktreePath, manifest, { storeFor: (k) => stores.get(k) as string });
      await writeAttachRecord(attachRecordFile(ws.worktreePath), rec);
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(ws.worktreePath, rel)), { recursive: true });
        writeFileSync(path.join(ws.worktreePath, rel), text);
      }
      await publisher.commit({
        runId: r.id,
        message: "Change things",
        identity: IDENTITY,
        projectId: "web",
        contextId: "main",
      });
      const row = ledger.getRunRecord(r.id);
      ledger.casRunState({ runId: r.id, from: "RUNNING", to: "SUCCEEDED", expectedVersion: row?.version as number });
      return { runId: r.id, sessionId: session.id };
    },
    close: async () => {
      await client.close();
      await mcp.close();
      await lifecycle.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const refsOf = (dir: string): string[] =>
  execFileSync("git", ["for-each-ref", "--format=%(refname)"], { cwd: dir, env: GIT_ENV, encoding: "utf8" })
    .split("\n")
    .filter((l) => l !== "");

const refSha = (dir: string, ref: string): string => g(dir, "rev-parse", "--verify", ref);

const subPushRows = (db: Database.Database) =>
  db
    .prepare("SELECT repo, paths_json, ref, outcome, reason, requested_by FROM submodule_push ORDER BY created_at, id")
    .all() as Json[];

const gitPushRows = (db: Database.Database) =>
  db.prepare("SELECT outcome, detail FROM git_push ORDER BY created_at, id").all() as Json[];

const CHANGES = { "README.md": "umbrella changed\n", "mods/a/a.txt": "A\n", "mods/b/b.txt": "B\n" };

describe("publish_run with linked submodule publication (ADR-0079 items 5 and 6)", () => {
  it("pushes each changed submodule repository once, opens one pull request per repository, then the umbrella's", async () => {
    f = await start();
    const { runId, sessionId } = await f.seedRun(CHANGES);
    const r = await f.call("publish_run", { run_id: runId });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const branch = `sb/${sessionId}`;

    // The umbrella publication is exactly as before.
    expect(r.body).toMatchObject({
      publication: { remote: "origin", branch, reused: false },
      pull_request: { number: 1, url: UMBRELLA_URL, draft: false, reused: false },
    });
    expect(refsOf(f.umbrellaBare)).toContain(`refs/heads/${branch}`);

    // One entry per changed repository, in path order; the duplicate-URL repository lists both paths.
    const subs = r.body.submodules as Json[];
    expect(subs.map((s) => [s.repo, s.paths, s.branch, s.default_branch])).toEqual([
      [KEY_A, ["dup/a", "mods/a"], branch, "main"],
      [KEY_B, ["mods/b"], branch, "master"],
    ]);
    const headA = refSha(f.remotes.a, `refs/heads/${branch}`);
    const headB = refSha(f.remotes.b, `refs/heads/${branch}`);
    expect(subs[0]).toMatchObject({
      head_sha: headA,
      publication: { push_id: expect.stringMatching(/^smp_/u), reused: false },
      pull_request: { number: 1, url: "https://github.com/acme/lib-a/pull/1", draft: false, reused: false },
    });
    expect(subs[1]).toMatchObject({
      head_sha: headB,
      pull_request: { number: 1, url: "https://github.com/acme/lib-b/pull/1", reused: false },
    });
    // The gitlinks of the published umbrella head are exactly the pushed submodule heads.
    const umbrellaHead = r.body.publication.head_sha as string;
    expect(g(f.umbrella, "ls-tree", umbrellaHead, "--", "mods/a")).toContain(headA);
    expect(g(f.umbrella, "ls-tree", umbrellaHead, "--", "dup/a")).toContain(headA);
    expect(g(f.umbrella, "ls-tree", umbrellaHead, "--", "mods/b")).toContain(headB);
    // Never the default branch, and nothing but the session branch.
    expect(refsOf(f.remotes.a)).toEqual(["refs/heads/main", `refs/heads/${branch}`]);
    expect(refsOf(f.remotes.b)).toEqual(["refs/heads/master", `refs/heads/${branch}`]);

    // One submodule_push row per attempt; the argv is https-only, never forced, and names no credential.
    expect(subPushRows(f.db)).toEqual([
      {
        repo: KEY_A,
        paths_json: '["dup/a","mods/a"]',
        ref: `refs/heads/${branch}`,
        outcome: "ACCEPTED",
        reason: "ok",
        requested_by: "mcp_client:linus",
      },
      {
        repo: KEY_B,
        paths_json: '["mods/b"]',
        ref: `refs/heads/${branch}`,
        outcome: "ACCEPTED",
        reason: "ok",
        requested_by: "mcp_client:linus",
      },
    ]);
    expect(f.pushCalls).toHaveLength(2);
    for (const argv of f.pushCalls) {
      expect(argv).toContain("protocol.allow=never");
      expect(argv).toContain("protocol.https.allow=always");
      expect(argv.slice(-3, -1)).toEqual(["--", "origin"]);
      expect(argv.at(-1)).toMatch(new RegExp(`^[0-9a-f]{40}:refs/heads/sb/${sessionId}$`, "u"));
      expect(argv.join(" ")).not.toMatch(/https?:|@|--force|\+/u);
    }

    // Pull requests: submodules first against their own default branch, then the umbrella listing them.
    expect(f.pulls.calls.filter((c) => c.op === "create").map((c) => `${c.args.owner}/${c.args.repo}`)).toEqual([
      "acme/lib-a",
      "acme/lib-b",
      "acme/umbrella",
    ]);
    expect(f.pulls.created("acme/lib-a")).toMatchObject({ branch, base: "main" });
    expect(f.pulls.created("acme/lib-b")).toMatchObject({ branch, base: "master" });
    const umbrellaBody = f.pulls.created("acme/umbrella")?.body as string;
    expect(umbrellaBody).toContain("https://github.com/acme/lib-a/pull/1");
    expect(umbrellaBody).toContain("https://github.com/acme/lib-b/pull/1");
    expect(umbrellaBody).toContain("`dup/a`, `mods/a`");
    expect(f.pulls.created("acme/lib-a")?.body).toContain(`Run: \`${runId}\``);
    const prRows = f.db
      .prepare("SELECT repo, number, branch, base_ref, umbrella_ref, action FROM submodule_pull_request ORDER BY repo")
      .all();
    expect(prRows).toEqual([
      {
        repo: "acme/lib-a",
        number: 1,
        branch,
        base_ref: "main",
        umbrella_ref: `refs/heads/${branch}`,
        action: "created",
      },
      {
        repo: "acme/lib-b",
        number: 1,
        branch,
        base_ref: "master",
        umbrella_ref: `refs/heads/${branch}`,
        action: "created",
      },
    ]);
    // Each linked pull request is a pull_request_opened event with its repo (and the umbrella's as before).
    const opened = f.ledger
      .listRunEvents(runId)
      .filter((e) => e.type === "pull_request_opened")
      .map((e) => JSON.parse(e.payload_json).repo);
    expect(opened).toEqual(["acme/lib-a", "acme/lib-b", "acme/umbrella"]);
  });

  it("is idempotent: publishing again pushes nothing and reuses every pull request", async () => {
    f = await start();
    const { runId } = await f.seedRun(CHANGES);
    expect((await f.call("publish_run", { run_id: runId })).isError).toBe(false);
    const again = await f.call("publish_run", { run_id: runId });
    expect(again.isError, JSON.stringify(again.body)).toBe(false);
    expect(again.body.publication.reused).toBe(true);
    expect((again.body.submodules as Json[]).map((s) => [s.publication.reused, s.pull_request.reused])).toEqual([
      [true, true],
      [true, true],
    ]);
    expect(subPushRows(f.db)).toHaveLength(2);
    expect(f.pushCalls).toHaveLength(2);
    expect(f.pulls.calls.filter((c) => c.op === "create")).toHaveLength(3);
  });

  it("a secret in a submodule refuses the whole publication with the finding's path prefixed by the submodule path", async () => {
    f = await start();
    const { runId, sessionId } = await f.seedRun({ ...CHANGES, "mods/b/config.ts": `token: ${TOKEN}\n` });
    const r = await f.call("publish_run", { run_id: runId });
    expect(r.body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: {
        reason: "SECRET_SCAN_BLOCKED",
        repos: [KEY_B],
        findings: [{ rule_id: "github_token", path: "mods/b/config.ts", line: 1 }],
        finding_count: 1,
      },
    });
    expect(r.body.error.message).toContain("github_token at mods/b/config.ts:1");
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    // Nothing was pushed anywhere, and no push was even attempted.
    expect(refsOf(f.remotes.a)).not.toContain(`refs/heads/sb/${sessionId}`);
    expect(refsOf(f.remotes.b)).not.toContain(`refs/heads/sb/${sessionId}`);
    expect(refsOf(f.umbrellaBare)).toEqual(["refs/heads/main"]);
    expect(f.pushCalls).toEqual([]);
    expect(subPushRows(f.db)).toEqual([]);
    expect(gitPushRows(f.db)).toEqual([]);
    expect(f.pulls.calls).toEqual([]);
  });

  it("a rejected submodule push refuses SUBMODULE_PUSH_FAILED with per-repository outcomes; a retry pushes only what is missing", async () => {
    f = await start();
    const { runId, sessionId } = await f.seedRun(CHANGES);
    const branch = `sb/${sessionId}`;
    // Someone else's commit already sits on the session branch of lib-b: the push is not a fast-forward.
    g(f.remotes.b, "checkout", "-q", "-b", branch);
    commitFiles(f.remotes.b, { "foreign.txt": "x\n" }, "foreign");
    g(f.remotes.b, "checkout", "-q", "master");

    const r = await f.call("publish_run", { run_id: runId });
    expect(r.body.error).toMatchObject({
      code: "TOOL_FAILURE",
      details: {
        reason: "SUBMODULE_PUSH_FAILED",
        submodules: [
          { repo: KEY_A, paths: ["dup/a", "mods/a"], outcome: "ACCEPTED", reason: "ok" },
          { repo: KEY_B, paths: ["mods/b"], outcome: "REJECTED_REMOTE", reason: "NON_FAST_FORWARD" },
        ],
      },
    });
    // No umbrella push, no pull request.
    expect(refsOf(f.umbrellaBare)).toEqual(["refs/heads/main"]);
    expect(gitPushRows(f.db)).toEqual([]);
    expect(f.pulls.calls).toEqual([]);

    // The operator removes the foreign branch; the retry pushes lib-b only, then the umbrella.
    g(f.remotes.b, "branch", "-q", "-D", branch);
    const retry = await f.call("publish_run", { run_id: runId });
    expect(retry.isError, JSON.stringify(retry.body)).toBe(false);
    expect((retry.body.submodules as Json[]).map((s) => [s.repo, s.publication.reused])).toEqual([
      [KEY_A, true],
      [KEY_B, false],
    ]);
    expect(subPushRows(f.db).map((x) => [x.repo, x.outcome])).toEqual([
      [KEY_A, "ACCEPTED"],
      [KEY_B, "REJECTED_REMOTE"],
      [KEY_B, "ACCEPTED"],
    ]);
    expect(f.pushCalls).toHaveLength(3);
    expect(gitPushRows(f.db)).toEqual([{ outcome: "ACCEPTED", detail: "ACCEPTED" }]);
  });

  it("a gh failure for one repository is reported on that repository; every push and the other pull requests stand", async () => {
    f = await start();
    const { runId, sessionId } = await f.seedRun(CHANGES);
    f.pulls.failFor.add("acme/lib-b");
    const r = await f.call("publish_run", { run_id: runId });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const [a, b] = r.body.submodules as Json[];
    expect(a?.pull_request).toMatchObject({ number: 1 });
    expect(a?.pull_request_error).toBeUndefined();
    expect(b?.pull_request).toBeNull();
    expect(b?.pull_request_error).toBe("GH_FAILED");
    expect(r.body.pull_request).toMatchObject({ number: 1, url: UMBRELLA_URL });
    expect(refsOf(f.remotes.b)).toContain(`refs/heads/sb/${sessionId}`);
    const body = f.pulls.created("acme/umbrella")?.body as string;
    expect(body).toContain("https://github.com/acme/lib-a/pull/1");
    expect(body).toContain("`mods/b`");
    expect(body).toContain("GH_FAILED");
  });

  it("refuses SUBMODULE_HISTORY_UNVERIFIED when a changed gitlink is not a recorded submodule commit of the session", async () => {
    f = await start();
    const { runId } = await f.seedRun(CHANGES);
    // Simulate a gitlink commit the ledger never recorded for its repository.
    f.db.exec("DROP TRIGGER submodule_commit_no_update");
    f.db.prepare("UPDATE submodule_commit SET repo = ? WHERE repo = ?").run(`${HOST}/acme/other`, KEY_B);
    const r = await f.call("publish_run", { run_id: runId });
    expect(r.body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { reason: "SUBMODULE_HISTORY_UNVERIFIED", path: "mods/b" },
    });
    expect(f.pushCalls).toEqual([]);
    expect(gitPushRows(f.db)).toEqual([]);
  });

  it("get_run, list_runs and get_digest show linked_pull_requests with their merge state, and submodule ref events", async () => {
    f = await start();
    const { runId, sessionId } = await f.seedRun(CHANGES);
    const r = await f.call("publish_run", { run_id: runId });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const branch = `sb/${sessionId}`;
    const umbrellaRef = `refs/heads/${branch}`;
    const [a, b] = r.body.submodules as Json[];
    const mergedSha = "c".repeat(40);
    insertSubmoduleMerge(f.db, {
      runId,
      metaSessionId: sessionId,
      projectId: "web",
      umbrellaRef,
      step: "submodule_merged",
      repo: "acme/lib-a",
      prNumber: 1,
      headSha: a?.head_sha,
      mergedSha,
    });
    insertSubmoduleMerge(f.db, {
      runId,
      metaSessionId: sessionId,
      projectId: "web",
      umbrellaRef,
      step: "submodule_refused",
      repo: "acme/lib-b",
      prNumber: 1,
      headSha: b?.head_sha,
      reason: "check_pending",
    });
    insertSubmoduleMerge(f.db, {
      runId,
      metaSessionId: sessionId,
      projectId: "web",
      umbrellaRef,
      step: "gitlinks_repointed",
      headSha: r.body.publication.head_sha,
      mergedSha: "d".repeat(40),
    });

    const linked = [
      {
        repo: KEY_A,
        paths: ["dup/a", "mods/a"],
        number: 1,
        url: "https://github.com/acme/lib-a/pull/1",
        base_ref: "main",
        head_sha: a?.head_sha,
        merge_state: { state: "merged", merged_sha: mergedSha },
      },
      {
        repo: KEY_B,
        paths: ["mods/b"],
        number: 1,
        url: "https://github.com/acme/lib-b/pull/1",
        base_ref: "master",
        head_sha: b?.head_sha,
        merge_state: { state: "refused", reason: "check_pending" },
      },
    ];
    const run = (await f.call("get_run", { run_id: runId })).body;
    expect(run.publications).toEqual([
      expect.objectContaining({ branch, pull_request_url: UMBRELLA_URL, linked_pull_requests: linked }),
    ]);
    const listed = (await f.call("list_runs", {})).body.runs.find((x: Json) => x.run_id === runId);
    expect(listed.publications[0].linked_pull_requests).toEqual(linked);
    const digest = (await f.call("get_digest", {})).body;
    const project = digest.projects.find((p: Json) => p.project_id === "web");
    expect(project.finished.find((e: Json) => e.run_id === runId).publications[0].linked_pull_requests).toEqual(linked);
    const kinds = (project.ref_events as Json[]).map((e) => [e.type, e.code, e.pr_number, e.publish_ref]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ["submodule_merge", "submodule_merged", 1, umbrellaRef],
        ["submodule_merge", "gitlinks_repointed", null, umbrellaRef],
      ]),
    );
    // A refusal step is not a ref event (the merge_run_pr refusal carries it).
    expect(kinds.filter(([, code]) => code === "submodule_refused")).toEqual([]);
    const merged = (project.ref_events as Json[]).find((e) => e.code === "submodule_merged");
    expect(merged).toMatchObject({ run_id: runId, repo: "acme/lib-a", head_sha: a?.head_sha, merged_sha: mergedSha });
  });
});
