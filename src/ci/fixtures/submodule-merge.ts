/**
 * Test world of the ordered merge (ADR-0087 item 7): an umbrella repository with a local bare `origin`, two submodule
 * "remotes" (`acme/liba` at the duplicate paths `libs/a` and `vendor/a`, `acme/libb` at `libs/b`) reached through the
 * store fixture's https-to-local runner, their stores already cloned, one published umbrella tip whose gitlinks point
 * at the session's pushed submodule heads, and the ledger rows `publish_run` writes (`git_commit`, `git_push`,
 * `submodule_push`, `submodule_pull_request`) inserted directly. {@link FakeGh} plays GitHub: G10/G11/G18/G12/G19 over
 * these local repositories (a squash merge writes a new commit on the remote's `main`). No network, no real `gh`.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { ProjectMergePolicy } from "../../config/projects.js";
import { publishRefFor } from "../../git/publish-ref.js";
import { GitPusher, type PushContextConfig } from "../../git/push.js";
import { createIdGenerator } from "../../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../../ledger/index.js";
import { parseRepositoryUrl } from "../../projects/clone.js";
import {
  commitFiles,
  type Fixture,
  g,
  gIn,
  gitmodulesText,
  makeFixture,
  makeRemote,
  makeUmbrella,
} from "../../submodules/fixtures/repos.js";
import { insertSubmodulePullRequest, insertSubmodulePush, listSubmoduleMergeSteps } from "../../submodules/ledger.js";
import { ensureStore } from "../../submodules/store.js";
import type { MergeTarget } from "../merge-policy.js";
import type {
  CiMergePort,
  CiPullRequestGateView,
  CiPullRequestMergeState,
  CiPullRequestMergeStatePort,
  CiRequiredChecks,
} from "../port.js";
import type { SubmoduleMergeDeps } from "../submodule-merge.js";

export const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };
export const PROJECT = "umb";
export const UMBRELLA_GH = { owner: "acme", repo: "umbrella" };

/** One pull request as the fake GitHub holds it. */
export interface FakePr {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  headBranch: string;
  baseBranch: string;
  checks: CiRequiredChecks;
  reported: CiRequiredChecks;
  mergeCommitSha?: string;
  /** The head a merged pull request kept (its branch may be gone or moved). */
  mergedHead?: string;
  /** The repository directory; an open pull request's head is read from its branch there, live. */
  dir: string;
}

/** G10, G11, G18, G12 and G19 over local repositories; every call is logged as `<verb> <owner/repo>`. */
export class FakeGh implements CiMergePort, CiPullRequestMergeStatePort {
  readonly calls: string[] = [];
  readonly prs = new Map<string, FakePr>();
  readonly merges: { repo: string; prNumber: number; method: string; headSha: string }[] = [];
  /** Repositories whose G12 throws. */
  readonly failMerge = new Set<string>();

  private head(pr: FakePr): string {
    return pr.state === "MERGED" && pr.mergedHead !== undefined
      ? pr.mergedHead
      : g(pr.dir, "rev-parse", `refs/heads/${pr.headBranch}`);
  }

  async pullRequestGateView(q: {
    owner: string;
    repo: string;
    publishRef: string;
  }): Promise<CiPullRequestGateView | null> {
    const key = `${q.owner}/${q.repo}`;
    this.calls.push(`view ${key}`);
    const pr = this.prs.get(key);
    if (pr === undefined || `refs/heads/${pr.headBranch}` !== q.publishRef) return null;
    return {
      number: pr.number,
      state: pr.state,
      isDraft: pr.isDraft,
      mergeable: pr.mergeable,
      headSha: this.head(pr),
      headBranch: pr.headBranch,
      baseBranch: pr.baseBranch,
    };
  }

  async requiredChecks(q: { owner: string; repo: string }): Promise<CiRequiredChecks> {
    this.calls.push(`checks ${q.owner}/${q.repo}`);
    return (this.prs.get(`${q.owner}/${q.repo}`) as FakePr).checks;
  }

  async reportedChecks(q: { owner: string; repo: string }): Promise<CiRequiredChecks> {
    this.calls.push(`reported ${q.owner}/${q.repo}`);
    return (this.prs.get(`${q.owner}/${q.repo}`) as FakePr).reported;
  }

  async mergePullRequest(q: {
    owner: string;
    repo: string;
    prNumber: number;
    method: "squash" | "merge" | "rebase";
    headSha: string;
  }): Promise<void> {
    const key = `${q.owner}/${q.repo}`;
    this.calls.push(`merge ${key}`);
    if (this.failMerge.has(key)) throw new Error("gh exited 1");
    const pr = this.prs.get(key) as FakePr;
    const head = this.head(pr);
    if (head !== q.headSha) throw new Error("head moved");
    this.merges.push({ repo: key, prNumber: q.prNumber, method: q.method, headSha: q.headSha });
    this.mergeOnRemote(key, head);
  }

  /** GitHub's squash merge: one new commit with the head's tree on the base branch (a new SHA). */
  mergeOnRemote(key: string, head = this.head(this.prs.get(key) as FakePr)): string {
    const pr = this.prs.get(key) as FakePr;
    const base = g(pr.dir, "rev-parse", `refs/heads/${pr.baseBranch}`);
    const sha = gIn(pr.dir, `Squash #${pr.number}\n`, "commit-tree", `${head}^{tree}`, "-p", base);
    g(pr.dir, "update-ref", `refs/heads/${pr.baseBranch}`, sha, base);
    pr.mergedHead = head;
    pr.state = "MERGED";
    pr.mergeCommitSha = sha;
    return sha;
  }

  async pullRequestMergeState(q: { owner: string; repo: string; prNumber: number }): Promise<CiPullRequestMergeState> {
    const key = `${q.owner}/${q.repo}`;
    this.calls.push(`state ${key}`);
    const pr = this.prs.get(key) as FakePr;
    return pr.mergeCommitSha !== undefined
      ? { state: pr.state, mergeCommitSha: pr.mergeCommitSha }
      : { state: pr.state };
  }
}

export interface Lib {
  readonly dir: string;
  readonly url: string;
  readonly key: string;
  /** `owner/repo`. */
  readonly repo: string;
  readonly paths: readonly string[];
  /** The base gitlink. */
  readonly head0: string;
  /** The session's pushed head (on `sb/<sess>`). */
  readonly head1: string;
  readonly number: number;
}

export interface World {
  readonly fx: Fixture;
  readonly dataDir: string;
  db: Database.Database;
  ledger: Ledger;
  readonly umbrella: string;
  readonly bare: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly base: string;
  /** The published umbrella tip (pre-repoint). */
  readonly preTip: string;
  /** `refs/heads/sb/<sess>`, the umbrella publish ref on `origin`. */
  readonly publishRef: string;
  readonly libs: { readonly a: Lib; readonly b: Lib };
  readonly gh: FakeGh;
  policy: ProjectMergePolicy;
  readonly targets: () => MergeTarget[];
  readonly pushContext: PushContextConfig;
  /** A fresh pusher and submodule deps (a "new server instance" builds its own). */
  sub(over?: Partial<SubmoduleMergeDeps>): SubmoduleMergeDeps;
  verify(sha?: string): void;
  steps(): ReturnType<typeof listSubmoduleMergeSteps>;
  /** Close and reopen the ledger (a restart over the same database). */
  reopen(): void;
  remoteTip(): string;
  close(): void;
}

export async function makeWorld(opts: { policy?: Partial<ProjectMergePolicy> } = {}): Promise<World> {
  const fx = makeFixture("sb-submerge-");
  const home = path.join(fx.root, "home");
  mkdirSync(home);
  const ids = createIdGenerator();
  const dataDir = path.join(fx.root, "data");
  mkdirSync(dataDir);
  let db = openLedger(dataDir);
  let ledger = createLedger(db, { ids });
  const session = ledger.createMetaSession({ objective: "umbrella work", repoRoot: "/pending", projectId: PROJECT });
  const branch = `sb/${session.id}`;

  const lib = (name: string, paths: string[], number: number): Lib => {
    const r = makeRemote(fx, name, { "README.md": `${name}\n` }, { owner: "acme" });
    g(r.dir, "checkout", "-q", "-b", branch);
    const head1 = commitFiles(r.dir, { "src.txt": `${name} change\n` }, `${name}: session change`);
    g(r.dir, "checkout", "-q", "main");
    return {
      dir: r.dir,
      url: r.url,
      key: `github.test/acme/${name}`,
      repo: `acme/${name}`,
      paths,
      head0: r.head,
      head1,
      number,
    };
  };
  const a = lib("liba", ["libs/a", "vendor/a"], 11);
  const b = lib("libb", ["libs/b"], 12);
  for (const l of [a, b]) {
    const src = parseRepositoryUrl(l.url);
    if (src === undefined) throw new Error("fixture url");
    await ensureStore(src, { settings: fx.settings, git: fx.runner });
  }

  const gm = gitmodulesText([
    ["a", "libs/a", a.url],
    ["b", "libs/b", b.url],
    ["va", "vendor/a", a.url],
  ]);
  const u = makeUmbrella(fx, { "libs/a": a.head0, "libs/b": b.head0, "vendor/a": a.head0 }, gm);
  // The session's umbrella commit: a file and the three gitlinks at the pushed heads (`git add -A` would drop gitlinks
  // without a directory, so only the file is added).
  g(u.dir, "checkout", "-q", "-b", "work");
  writeFileSync(path.join(u.dir, "feature.txt"), "umbrella change\n");
  g(u.dir, "add", "feature.txt");
  const links = `160000 ${a.head1}\tlibs/a\n160000 ${a.head1}\tvendor/a\n160000 ${b.head1}\tlibs/b\n`;
  gIn(u.dir, links, "update-index", "--index-info");
  g(u.dir, "commit", "-q", "-m", "Umbrella change");
  const preTip = g(u.dir, "rev-parse", "HEAD");
  g(u.dir, "checkout", "-q", "main");
  g(u.dir, "update-ref", publishRefFor(session.id), preTip);
  const bare = path.join(fx.root, "umbrella.git");
  g(fx.root, "init", "-q", "--bare", "-b", "main", bare);
  g(u.dir, "remote", "add", "origin", bare);
  g(u.dir, "push", "-q", "origin", "main");
  g(u.dir, "push", "-q", "origin", `${preTip}:refs/heads/${branch}`);

  db.prepare("UPDATE meta_session SET repo_root = ?, base_commit = ? WHERE id = ?").run(u.dir, u.head, session.id);
  const run = ledger.createRun({
    metaSessionId: session.id,
    state: "SUCCEEDED",
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "steward",
    provider: "fake",
    projectId: PROJECT,
  });
  ledger.recordGitCommit({
    commitSha: preTip,
    treeSha: g(u.dir, "rev-parse", `${preTip}^{tree}`),
    repoRoot: u.dir,
    publishRef: publishRefFor(session.id),
    projectId: PROJECT,
    contextId: "main",
    metaSessionId: session.id,
    runId: run.id,
    provider: "fake",
    harness: "fake",
    origin: "commit_tool",
    sanitizer: { rules: {} },
    eventPayload: { commit_sha: preTip },
  });
  const publishRef = `refs/heads/${branch}`;
  db.prepare(
    `INSERT INTO git_push (id, run_id, project_id, context_id, remote, ref, head_sha, outcome, detail, requested_by,
       created_at) VALUES (?, ?, ?, 'main', 'origin', ?, ?, 'ACCEPTED', 'ACCEPTED', 'mcp_client:steward', ?)`,
  ).run(ids.id("gps"), run.id, PROJECT, publishRef, preTip, "2020-01-01T00:00:00.000Z");
  for (const l of [a, b]) {
    const push = insertSubmodulePush(db, {
      runId: run.id,
      metaSessionId: session.id,
      projectId: PROJECT,
      repo: l.key,
      paths: l.paths,
      ref: publishRef,
      headSha: l.head1,
      umbrellaHeadSha: preTip,
      outcome: "ACCEPTED",
      reason: "ok",
      requestedBy: "mcp_client:steward",
    });
    insertSubmodulePullRequest(db, {
      runId: run.id,
      metaSessionId: session.id,
      pushId: push.id,
      clientId: "steward",
      repo: l.repo,
      number: l.number,
      url: `https://github.com/${l.repo}/pull/${l.number}`,
      branch,
      baseRef: "main",
      headSha: l.head1,
      umbrellaRef: publishRef,
      draft: false,
      action: "created",
    });
  }

  const gh = new FakeGh();
  const pass: CiRequiredChecks = { kind: "checks", buckets: ["pass"] };
  for (const l of [a, b]) {
    gh.prs.set(l.repo, {
      number: l.number,
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      headBranch: branch,
      baseBranch: "main",
      checks: pass,
      reported: pass,
      dir: l.dir,
    });
  }
  gh.prs.set(`${UMBRELLA_GH.owner}/${UMBRELLA_GH.repo}`, {
    number: 42,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    headBranch: branch,
    baseBranch: "main",
    checks: pass,
    reported: pass,
    dir: bare,
  });

  const pushContext: PushContextConfig = {
    projectId: PROJECT,
    contextId: "main",
    path: u.dir,
    baseRef: "main",
    policy: "branch",
    remote: "origin",
    branchPrefix: "sb/",
  };
  const scratch = path.join(fx.root, "scratch");
  mkdirSync(scratch);
  const world: World = {
    fx,
    dataDir,
    db,
    ledger,
    umbrella: u.dir,
    bare,
    sessionId: session.id,
    runId: run.id,
    base: u.head,
    preTip,
    publishRef,
    libs: { a, b },
    gh,
    policy: { enabled: true, method: "squash", requiredReports: [], ...opts.policy },
    targets: () => [{ projectId: PROJECT, policy: world.policy, baseRef: "main" }],
    pushContext,
    sub: (over = {}) => ({
      mergeState: gh,
      pusher: new GitPusher({
        db: world.db,
        resolveContext: (id) => (id === PROJECT ? pushContext : undefined),
        sourceEnv: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
        ids,
      }),
      sources: () => fx.settings,
      git: fx.runner,
      identityOf: (id) => (id === PROJECT ? IDENTITY : undefined),
      scratchDir: scratch,
      ...over,
    }),
    verify: (sha = preTip) => {
      world.ledger.recordVerificationResult({
        runId: run.id,
        metaSessionId: session.id,
        publishRef,
        headSha: sha,
        treeSha: "a".repeat(40),
        outcome: "passed",
        artifactId: null,
      });
    },
    steps: () => listSubmoduleMergeSteps(world.db, PROJECT, publishRef),
    reopen: () => {
      world.db.close();
      db = openLedger(dataDir);
      ledger = createLedger(db, { ids });
      world.db = db;
      world.ledger = ledger;
    },
    remoteTip: () => g(bare, "rev-parse", publishRef),
    close: () => {
      try {
        world.db.close();
      } catch {
        // already closed
      }
      rmSync(fx.root, { recursive: true, force: true });
    },
  };
  return world;
}
