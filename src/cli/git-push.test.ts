/**
 * T9.6 operator command `switchboard git push` and the `runs show` provenance view (FR-GIT-05, FR-GIT-07, FR-WS-05;
 * LLD §12.6, §12.7; ADR-0028). Temporary repositories and a LOCAL bare remote; no provider CLI, no network; the push's
 * HOME is a temporary directory, so no real Git configuration or credential is read.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { GitPublisher, publishRefFor } from "../git/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger } from "../ledger/index.js";
import { acquireDataDirLock } from "../lock/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

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
const remoteRefs = (bare: string) =>
  g(bare, "for-each-ref", "--format=%(refname)")
    .split("\n")
    .filter((l) => l !== "");
const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };
const MESSAGE = "Add the feature with a distinctive message body";

let tmp: string;
let repo: string;
let bare: string;
let dataDir: string;
let configPath: string;
let env: Record<string, string | undefined>;

function writeConfig(push: Record<string, unknown>): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [path.dirname(repo)],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted", projects: ["web"] }],
      projects: [
        {
          id: "web",
          name: "Web",
          contexts: [{ id: "main", kind: "repository", path: repo, base_ref: "main", push, identity: IDENTITY }],
        },
      ],
    }),
  );
}

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env,
    user: "tester",
  };
  const code = await main([...args, "--config", configPath], io);
  return { code, out: out.join(""), err: err.join("") };
}

/** One meta-session with one run that published one commit through the commit library; the ledger is closed after. */
async function seedCommit(): Promise<{ sessionId: string; runId: string; sha: string }> {
  const db = openLedger(dataDir);
  try {
    const ids = createIdGenerator();
    const ledger = createLedger(db, { ids });
    const mgr = new WorkspaceManager({
      db,
      artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
      dataDir,
      allowedRoots: [path.dirname(repo)],
      ids,
    });
    const session = ledger.createMetaSession({ objective: "o", repoRoot: repo, projectId: "web" });
    const r = ledger.createRun({
      metaSessionId: session.id,
      state: "RUNNING",
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h",
      clientId: "c1",
      provider: "fake",
      projectId: "web",
    });
    const ws = await mgr.prepare({
      metaSessionId: session.id,
      runId: r.id,
      workspace: repo,
      trustProfile: "edit-untrusted",
    });
    if (ws.mode !== "worktree") throw new Error("expected a worktree");
    writeFileSync(path.join(ws.worktreePath, "feature.txt"), "feature\n");
    const c = await new GitPublisher({ db, scratchDir: path.join(tmp, "scratch"), ids }).commit({
      runId: r.id,
      message: `${MESSAGE}\n\nCo-authored-by: Agent <agent@example.test>`,
      identity: IDENTITY,
      projectId: "web",
      contextId: "main",
    });
    return { sessionId: session.id, runId: r.id, sha: c.sha };
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-cli-push-")));
  const repos = path.join(tmp, "repos");
  repo = path.join(repos, "web");
  bare = path.join(tmp, "remote.git");
  mkdirSync(repo, { recursive: true });
  mkdirSync(path.join(tmp, "home"));
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  g(tmp, "init", "-q", "--bare", "-b", "main", bare);
  g(repo, "remote", "add", "origin", bare);
  dataDir = path.join(tmp, "data");
  configPath = path.join(tmp, "config.json");
  env = { PATH: process.env.PATH, HOME: path.join(tmp, "home") };
  writeConfig({ policy: "branch", remote: "origin", branch_prefix: "ops/" });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("switchboard git push (operator command)", () => {
  it("pushes the publish ref under the prefix, then runs show gives the provenance with the push", async () => {
    const s = await seedCommit();
    const r = await run(["git", "push", s.sessionId, "--json"]);
    expect(r.code, r.out + r.err).toBe(0);
    const j = JSON.parse(r.out);
    const target = `refs/heads/ops/${s.sessionId}`;
    expect(j).toMatchObject({
      meta_session_id: s.sessionId,
      outcome: "ACCEPTED",
      reason: "ACCEPTED",
      pushed: true,
      remote: "origin",
      ref: target,
      head_sha: s.sha,
      commits: [s.sha],
      recorded_on_run: s.runId,
    });
    expect(remoteRefs(bare)).toEqual([target]);
    expect(g(bare, "rev-parse", target)).toBe(g(repo, "rev-parse", publishRefFor(s.sessionId)));
    expect(r.out).not.toContain(bare);

    // runs show: JSON provenance (FR-GIT-07) with the push, and never the message or a URL.
    const show = await run(["runs", "show", s.runId, "--json"]);
    expect(show.code).toBe(0);
    const d = JSON.parse(show.out);
    expect(d.run.commits).toHaveLength(1);
    const c = d.run.commits[0];
    expect(c).toMatchObject({
      sha: s.sha,
      origin: "commit_tool",
      project_id: "web",
      context_id: "main",
      meta_session_id: s.sessionId,
      run_id: s.runId,
      provider: "fake",
      sanitizer: { rules: { "trailer.co-author": 1 } },
      pushed_to: [{ push_id: j.push_id, remote: "origin", ref: target }],
    });
    expect(c.tree_sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(c.patch_id).toMatch(/^[0-9a-f]{40}$/u);
    expect(Object.keys(c)).toEqual(
      expect.arrayContaining(["model", "adapter_version", "adapter_version_id", "harness", "tool_event_id"]),
    );
    // T11.4 (LLD §12.7): an agent-written message
    expect(c).toMatchObject({ message_source: "agent", inner_call_id: null });
    expect(d.run.pushes).toEqual([
      expect.objectContaining({ id: j.push_id, outcome: "ACCEPTED", remote: "origin", ref: target, run_id: null }),
    ]);
    // Text view.
    const text = await run(["runs", "show", s.runId]);
    expect(text.out).toContain("Commits (provenance, FR-GIT-07):");
    expect(text.out).toContain(`pushed: origin ${target} (${j.push_id}`);
    expect(text.out).toContain("sanitiser: trailer.co-author=1");
    expect(text.out).toContain("    message: agent\n");
    expect(text.out).toContain(`Pushes (FR-GIT-05):\n  ${j.push_id}  ACCEPTED (ACCEPTED)  origin ${target}`);
    for (const out of [show.out, text.out]) {
      expect(out).not.toContain("distinctive message body");
      expect(out).not.toContain(bare);
    }
    const human = await run(["git", "push", s.runId]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("already up to date");
  });

  it("policy none: the command refuses with a message naming the policy, and the attempt is recorded", async () => {
    writeConfig({ policy: "none" });
    const s = await seedCommit();
    const r = await run(["git", "push", s.sessionId]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("push refused (POLICY_NONE)");
    expect(r.out).toContain("push policy is none");
    expect(remoteRefs(bare)).toEqual([]);
    const show = JSON.parse((await run(["runs", "show", s.runId, "--json"])).out);
    expect(show.run.pushes).toEqual([expect.objectContaining({ outcome: "REFUSED_POLICY", reason: "POLICY_NONE" })]);
    expect(show.run.commits[0].pushed_to).toEqual([]);
  });

  it("refuses while a serve daemon holds the data-directory lock, writing nothing", async () => {
    const s = await seedCommit();
    const lock = acquireDataDirLock(dataDir);
    try {
      const r = await run(["git", "push", s.sessionId, "--json"]);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.out).error.code).toBe("LOCKED");
    } finally {
      lock.release();
    }
    expect(remoteRefs(bare)).toEqual([]);
    expect(JSON.parse((await run(["runs", "show", s.runId, "--json"])).out).run.pushes).toEqual([]);
  });

  it("unknown ids and bad usage", async () => {
    await seedCommit();
    expect(JSON.parse((await run(["git", "push", "sess_nope", "--json"])).out).error.code).toBe("NOT_FOUND");
    expect(JSON.parse((await run(["git", "push", "run_nope", "--json"])).out).error.code).toBe("NOT_FOUND");
    expect(JSON.parse((await run(["git", "push", "origin", "--json"])).out).error.code).toBe("NOT_FOUND");
    expect((await run(["git", "push"])).code).toBe(2);
    expect((await run(["git", "push", "a", "b"])).code).toBe(2);
    expect((await run(["git", "fetch", "x"])).code).toBe(2);
  });

  it("a remote that is a URL with credentials fails config loading without echoing it", async () => {
    writeConfig({ policy: "branch", remote: "https://user:s3cr3t@example.invalid/r.git", branch_prefix: "ops/" });
    const r = await run(["git", "push", "sess_x", "--json"]);
    expect(r.code).toBe(1);
    const e = JSON.parse(r.out).error;
    expect(e.code).toBe("CONFIG");
    expect(e.message).toContain("push.remote: must be the name of a remote");
    expect(r.out + r.err).not.toContain("s3cr3t");
    writeConfig({ policy: "branch", remote: "origin", branch_prefix: "../x/" });
    expect(JSON.parse((await run(["git", "push", "sess_x", "--json"])).out).error.message).toContain(
      "push.branch_prefix",
    );
  });
});
