/**
 * ADR-0073 (LLD §20.7.1, FR-SUB-02): the merge gate accepts a pull request head that is a chain of pure base merges on
 * the published tip (GitHub's "Update branch"), verified by the controller with local Git, and merges pinned to that
 * head. Real local Git repositories and a bare `file://` remote stand in for GitHub (a "hub" clone makes the commits
 * GitHub would, and `refs/pull/<n>/head` is written on the bare remote); `gh` is a fake {@link CiMergePort}. No network.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectMergePolicy } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import {
  classifyPullHead,
  fetchedSha,
  GitPullHeadPort,
  MAX_BASE_MERGE_CHAIN,
  mergeGateRefs,
  pullFetchArgs,
} from "./base-merge.js";
import { updateBranchOnRequest } from "./branch-update.js";
import { GhArgvError, ghPrUpdateBranchArgv, isAllowedGhArgv } from "./gh-argv.js";
import { type MergePolicyDeps, mergeOnRequest, pollMergePolicies } from "./merge-policy.js";
import type { CiBranchUpdatePort, CiMergePort, CiPullRequestGateView, CiRequiredChecks } from "./port.js";

const BRANCH = "sb/feature-1";
const REF = `refs/heads/${BRANCH}`;
const PR = 42;
const POLICY: ProjectMergePolicy = { enabled: true, method: "squash", requiredReports: [] };
const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

/** G10 to G12 fake whose view head is whatever the test last pushed to the pull request. */
class FakeMerge implements CiMergePort, CiBranchUpdatePort {
  calls: string[] = [];
  head = "";
  checks: CiRequiredChecks = { kind: "checks", buckets: ["pass"] };
  merges: { prNumber: number; method: string; headSha: string }[] = [];
  updates: { prNumber: number; expectedHeadSha: string }[] = [];
  onUpdate: (() => void) | undefined;
  async pullRequestGateView(): Promise<CiPullRequestGateView> {
    this.calls.push("view");
    return {
      number: PR,
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      headSha: this.head,
      headBranch: BRANCH,
      baseBranch: "main",
    };
  }
  async requiredChecks(): Promise<CiRequiredChecks> {
    this.calls.push("checks");
    return this.checks;
  }
  async mergePullRequest(q: { prNumber: number; method: string; headSha: string }) {
    this.calls.push("merge");
    this.merges.push({ prNumber: q.prNumber, method: q.method, headSha: q.headSha });
  }
  async updatePullRequestBranch(q: { prNumber: number; expectedHeadSha: string }) {
    this.calls.push("update");
    this.updates.push({ prNumber: q.prNumber, expectedHeadSha: q.expectedHeadSha });
    this.onUpdate?.();
  }
}

interface World {
  root: string;
  /** The project's repository (where Switchboard published from). */
  repo: string;
  /** A clone standing in for GitHub's own commits. */
  hub: string;
  remote: string;
  /** The published tip. */
  tip: string;
  db: ReturnType<typeof openLedger>;
  ledger: Ledger;
  runId: string;
  merge: FakeMerge;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
const gitOk = (cwd: string, ...args: string[]): boolean => {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
};

function commitFile(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** Push the hub's HEAD to the pull request branch and `refs/pull/<n>/head`, as GitHub would; returns the new head. */
function pushPullHead(w: World): string {
  git(w.hub, "push", "-q", "-f", "origin", `HEAD:${REF}`, `HEAD:refs/pull/${PR}/head`);
  w.merge.head = git(w.hub, "rev-parse", "HEAD");
  return w.merge.head;
}

/** Advance `main` on the remote by one commit of `file`. */
function advanceMain(w: World, file: string, content: string): string {
  git(w.hub, "checkout", "-q", "main");
  git(w.hub, "pull", "-q", "--ff-only", "origin", "main");
  const sha = commitFile(w.hub, file, content, `main: ${file}`);
  git(w.hub, "push", "-q", "origin", "main");
  return sha;
}

/** Check out the pull request branch's current head in the hub. */
function onPullBranch(w: World): void {
  git(w.hub, "fetch", "-q", "origin");
  git(w.hub, "checkout", "-q", "-B", BRANCH, `origin/${BRANCH}`);
}

/** GitHub's "Update branch": merge `origin/main` into the branch with no other change. */
function updateBranch(w: World): string {
  onPullBranch(w);
  git(w.hub, "merge", "-q", "--no-ff", "origin/main", "-m", `Merge branch 'main' into ${BRANCH}`);
  return pushPullHead(w);
}

function setup(): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-basemerge-")));
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  const hub = path.join(root, "hub");
  mkdirSync(repo);
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(repo, "init", "-q", "-b", "main");
  commitFile(repo, "f.txt", "1\n2\n3\n", "init");
  git(repo, "remote", "add", "origin", `file://${remote}`);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "checkout", "-q", "-b", BRANCH);
  const tip = commitFile(repo, "f.txt", "one\n2\n3\n", "switchboard: feature");
  git(repo, "push", "-q", "origin", `HEAD:${REF}`, `HEAD:refs/pull/${PR}/head`);
  git(repo, "checkout", "-q", "main");
  git(root, "clone", "-q", `file://${remote}`, hub);

  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const db = openLedger(dataDir);
  const ledger = createLedger(db, { ids: createIdGenerator() });
  const metaSessionId = ledger.createMetaSession({ objective: "Build", projectId: "app" }).id;
  const run = ledger.createRun({
    metaSessionId,
    state: "SUCCEEDED",
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "orch",
    projectId: "app",
  });
  db.prepare(
    `INSERT INTO git_push (id, run_id, project_id, context_id, remote, ref, head_sha, outcome, detail, requested_by,
       created_at) VALUES ('gps_basemerge', ?, 'app', 'main', 'origin', ?, ?, 'ACCEPTED', NULL, 'agent_tool', ?)`,
  ).run(run.id, REF, tip, "2026-10-20T01:00:00.000Z");
  // Verification is keyed to the published tip, never to the base merge head (ADR-0073).
  ledger.recordVerificationResult({
    runId: run.id,
    metaSessionId,
    publishRef: "refs/heads/switchboard/pub/x",
    headSha: tip,
    treeSha: "a".repeat(40),
    outcome: "passed",
    artifactId: null,
  });
  const merge = new FakeMerge();
  merge.head = tip;
  return { root, repo, hub, remote, tip, db, ledger, runId: run.id, merge };
}

const port = (w: World) =>
  new GitPullHeadPort({ repoOf: (id) => (id === "app" ? w.repo : undefined), sourceEnv: GIT_ENV });

function deps(w: World): MergePolicyDeps {
  return {
    db: w.db,
    ledger: w.ledger,
    merge: w.merge,
    targets: () => [{ projectId: "app", policy: POLICY, baseRef: "main" }],
    resolveRemote: async () => ({ owner: "acme", repo: "app" }),
    pullHeads: port(w),
    nowMs: () => Date.parse("2026-10-20T12:00:00.000Z"),
  };
}

const mergeRows = (w: World) =>
  w.db
    .prepare("SELECT outcome, reason, head_sha, head_kind, pr_head_sha FROM merge_event ORDER BY created_at, rowid")
    .all();

let w: World | undefined;
beforeEach(() => {
  w = setup();
});
afterEach(() => {
  w?.db.close();
  if (w) rmSync(w.root, { recursive: true, force: true });
  w = undefined;
});

describe("G15 gh argv (ADR-0073)", () => {
  it("builds the update-branch template pinned to a head, and the audit refuses every drift", () => {
    const sha = "a".repeat(40);
    const argv = ghPrUpdateBranchArgv("acme", "app", "42", sha);
    expect(argv).toEqual([
      "api",
      "--method",
      "PUT",
      "repos/acme/app/pulls/42/update-branch",
      "-f",
      `expected_head_sha=${sha}`,
      "--silent",
    ]);
    expect(isAllowedGhArgv(argv)).toBe(true);
    const drift = (i: number, v: string) => argv.map((x, j) => (j === i ? v : x));
    for (const bad of [
      drift(2, "POST"),
      drift(3, "repos/acme/app/pulls/42/merge"),
      drift(3, "repos/acme/app/pulls/0/update-branch"),
      drift(3, "repos/acme/a/b/pulls/42/update-branch"),
      drift(4, "-F"),
      drift(5, "expected_head_sha=HEAD"),
      drift(5, `update_method=rebase`),
      drift(6, "--paginate"),
      argv.slice(0, 6),
      [...argv, "-f", "update_method=rebase"],
    ]) {
      expect(isAllowedGhArgv(bad), bad.join(" ")).toBe(false);
    }
    expect(() => ghPrUpdateBranchArgv("acme", "app", "42", "HEAD")).toThrow(GhArgvError);
    expect(() => ghPrUpdateBranchArgv("acme", "app", "-1", sha)).toThrow(GhArgvError);
    expect(() => ghPrUpdateBranchArgv("-acme", "app", "42", sha)).toThrow(GhArgvError);
  });
});

describe("the pull request fetch (ADR-0073)", () => {
  it("writes only the controller namespace, takes SHAs from the fetch output and never moves origin/main", async () => {
    const world = w as World;
    advanceMain(world, "b.txt", "b\n");
    const merged = updateBranch(world);
    git(world.repo, "fetch", "-q", "origin", "main:refs/remotes/origin/main");
    const trackingBefore = git(world.repo, "rev-parse", "refs/remotes/origin/main");
    rmSync(path.join(world.repo, ".git", "FETCH_HEAD"), { force: true });
    advanceMain(world, "c.txt", "c\n");
    const read = await port(world).inspect({
      projectId: "app",
      remote: "origin",
      prNumber: PR,
      baseBranch: "main",
      publishedSha: world.tip,
      prHeadSha: merged,
    });
    expect(read).toEqual({ kind: "read", head: "base_merge", upToDate: false, conflicts: false });
    const refs = mergeGateRefs("origin", PR);
    expect(git(world.repo, "rev-parse", refs.head)).toBe(merged);
    expect(git(world.repo, "rev-parse", refs.base)).toBe(git(world.hub, "rev-parse", "origin/main"));
    expect(git(world.repo, "rev-parse", "refs/remotes/origin/main")).toBe(trackingBefore);
    expect(gitOk(world.repo, "rev-parse", "-q", "--verify", "FETCH_HEAD")).toBe(false);
    expect(pullFetchArgs("origin", PR, "main")).toContain("--refmap=");
    expect(() => pullFetchArgs("origin", PR, "-x")).toThrow();
    expect(fetchedSha(`! ${"0".repeat(40)} ${"1".repeat(40)} ${refs.head}\n`, refs.head)).toBeUndefined();
  });

  it("a head that differs from the one gh reported is foreign; a failed fetch is a read error", async () => {
    const world = w as World;
    advanceMain(world, "b.txt", "b\n");
    const merged = updateBranch(world);
    const q = {
      projectId: "app",
      remote: "origin",
      prNumber: PR,
      baseBranch: "main",
      publishedSha: world.tip,
      prHeadSha: world.tip,
    };
    expect(await port(world).inspect(q)).toMatchObject({ kind: "read", head: "foreign" });
    expect(await port(world).inspect({ ...q, prHeadSha: merged, prNumber: 7 })).toEqual({ kind: "error" });
    expect(await port(world).inspect({ ...q, projectId: "other", prHeadSha: merged })).toMatchObject({
      head: "foreign",
    });
  });
});

describe("pure base merges at the merge gate (ADR-0073)", () => {
  it("the poller merges a pure base merge, pinned to the new head, and records head_kind base_merge", async () => {
    const world = w as World;
    advanceMain(world, "b.txt", "b\n");
    const merged = updateBranch(world);
    const r = await pollMergePolicies(deps(world));
    expect(r.refused).toEqual([]);
    expect(r.merged).toEqual([
      { projectId: "app", publishRef: REF, prNumber: PR, headSha: merged, headKind: "base_merge" },
    ]);
    expect(world.merge.merges).toEqual([{ prNumber: PR, method: "squash", headSha: merged }]);
    expect(mergeRows(world)).toEqual([
      { outcome: "attempted", reason: null, head_sha: world.tip, head_kind: "base_merge", pr_head_sha: merged },
      { outcome: "merged", reason: null, head_sha: world.tip, head_kind: "base_merge", pr_head_sha: merged },
    ]);
    const ev = world.ledger.listRunEvents(world.runId).find((e) => e.type === "merge_event");
    expect(JSON.parse(ev?.payload_json ?? "{}")).toMatchObject({ head_kind: "base_merge", pr_head_sha: merged });
  });

  it("merge_run_pr's gate (mergeOnRequest) merges a pure base merge pinned to it, also with expected_head_sha", async () => {
    const world = w as World;
    advanceMain(world, "b.txt", "b\n");
    const merged = updateBranch(world);
    const req = { projectId: "app", remote: "origin", publishRef: REF };
    expect(await mergeOnRequest(deps(world), { ...req, expectedHeadSha: "9".repeat(40) })).toMatchObject({
      kind: "refused",
      reason: "head_moved",
    });
    const out = await mergeOnRequest(deps(world), { ...req, expectedHeadSha: merged });
    expect(out).toMatchObject({ kind: "merged", headSha: merged, headKind: "base_merge", alreadyMerged: false });
    expect(world.merge.merges).toEqual([{ prNumber: PR, method: "squash", headSha: merged }]);
  });

  it("accepts a chain of two base merges", async () => {
    const world = w as World;
    advanceMain(world, "b.txt", "b\n");
    updateBranch(world);
    advanceMain(world, "c.txt", "c\n");
    const second = updateBranch(world);
    const r = await pollMergePolicies(deps(world));
    expect(r.merged.map((m) => [m.headSha, m.headKind])).toEqual([[second, "base_merge"]]);
    const base = git(world.hub, "rev-parse", "origin/main");
    expect(await classifyPullHead(world.repo, world.tip, second, base)).toBe("base_merge");
    expect(MAX_BASE_MERGE_CHAIN).toBe(10);
  });

  it("a merge that also changes a file is head_moved", async () => {
    const world = w as World;
    advanceMain(world, "b.txt", "b\n");
    onPullBranch(world);
    git(world.hub, "merge", "-q", "--no-ff", "--no-commit", "origin/main");
    writeFileSync(path.join(world.hub, "extra.txt"), "smuggled\n");
    git(world.hub, "add", "extra.txt");
    git(world.hub, "commit", "-q", "-m", `Merge branch 'main' into ${BRANCH}`);
    pushPullHead(world);
    await expectHeadMoved(world);
  });

  it("a conflict-resolution merge is head_moved", async () => {
    const world = w as World;
    advanceMain(world, "f.txt", "uno\n2\n3\n");
    onPullBranch(world);
    expect(gitOk(world.hub, "merge", "-q", "--no-ff", "origin/main", "-m", "Merge")).toBe(false);
    writeFileSync(path.join(world.hub, "f.txt"), "one\n2\n3\n");
    git(world.hub, "add", "f.txt");
    git(world.hub, "commit", "-q", "--no-edit");
    pushPullHead(world);
    await expectHeadMoved(world);
  });

  it("a merge whose second parent is not on the base branch is head_moved", async () => {
    const world = w as World;
    git(world.hub, "checkout", "-q", "-b", "side", "origin/main");
    commitFile(world.hub, "side.txt", "side\n", "side work");
    git(world.hub, "push", "-q", "origin", "side");
    onPullBranch(world);
    git(world.hub, "merge", "-q", "--no-ff", "side", "-m", `Merge branch 'side' into ${BRANCH}`);
    pushPullHead(world);
    await expectHeadMoved(world);
  });

  it("a non-merge foreign commit is head_moved", async () => {
    const world = w as World;
    onPullBranch(world);
    commitFile(world.hub, "g.txt", "g\n", "someone else's commit");
    pushPullHead(world);
    await expectHeadMoved(world);
  });
});

async function expectHeadMoved(world: World): Promise<void> {
  const r = await pollMergePolicies(deps(world));
  expect(r.merged).toEqual([]);
  expect(r.refused.map((x) => x.reason)).toEqual(["head_moved"]);
  expect(world.merge.calls).not.toContain("merge");
  expect(world.merge.calls).not.toContain("checks");
  expect(
    (await mergeOnRequest(deps(world), { projectId: "app", remote: "origin", publishRef: REF })).kind === "refused",
  ).toBe(true);
}

describe("update_run_branch's request (ADR-0073)", () => {
  const updateDeps = (world: World) => ({ ...deps(world), pullHeads: port(world), update: world.merge });
  const req = { projectId: "app", remote: "origin", publishRef: REF };

  it("asks GitHub to update a branch behind its base, pinned to the head it read; the result is accepted", async () => {
    const world = w as World;
    advanceMain(world, "b.txt", "b\n");
    world.merge.onUpdate = () => updateBranch(world);
    const out = await updateBranchOnRequest(updateDeps(world), req);
    expect(out).toMatchObject({ kind: "updated", prNumber: PR, previousHeadSha: world.tip });
    expect(world.merge.updates).toEqual([{ prNumber: PR, expectedHeadSha: world.tip }]);
    // The head GitHub wrote is a pure base merge: the gate merges it.
    const r = await pollMergePolicies(deps(world));
    expect(r.merged.map((m) => m.headKind)).toEqual(["base_merge"]);
  });

  it("does nothing for a branch that already contains the base head", async () => {
    const world = w as World;
    expect(await updateBranchOnRequest(updateDeps(world), req)).toMatchObject({ kind: "current" });
    advanceMain(world, "b.txt", "b\n");
    const merged = updateBranch(world);
    expect(await updateBranchOnRequest(updateDeps(world), req)).toMatchObject({
      kind: "current",
      previousHeadSha: merged,
    });
    expect(world.merge.updates).toEqual([]);
  });

  it("refuses a foreign head, a moved expected head and a conflicting base before any write", async () => {
    const world = w as World;
    advanceMain(world, "f.txt", "uno\n2\n3\n");
    expect(await updateBranchOnRequest(updateDeps(world), req)).toMatchObject({
      kind: "refused",
      reason: "not_mergeable",
    });
    expect(await updateBranchOnRequest(updateDeps(world), { ...req, expectedHeadSha: "9".repeat(40) })).toMatchObject({
      kind: "refused",
      reason: "head_moved",
    });
    onPullBranch(world);
    commitFile(world.hub, "g.txt", "g\n", "foreign");
    pushPullHead(world);
    expect(await updateBranchOnRequest(updateDeps(world), req)).toMatchObject({
      kind: "refused",
      reason: "head_moved",
    });
    expect(world.merge.updates).toEqual([]);
  });
});
