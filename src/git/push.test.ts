/**
 * T9.6 push library (FR-GIT-05, FR-GIT-06, FR-GIT-08, FR-WS-05; FRD BR-29, BR-31, WF-12; LLD §12.6; ADR-0028). Every
 * test uses temporary repositories and a LOCAL bare remote; no network, no provider CLI, no real credential. The push's
 * HOME and XDG_CONFIG_HOME point into the temporary directory so the developer's own Git configuration is never read.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import type { PolicySnapshot } from "../policy/types.js";
import { WorkspaceManager } from "../workspace/index.js";
import { evaluateCredentialReach } from "./credential-reach.js";
import {
  classifyPush,
  classifyRemoteUrl,
  GitPublisher,
  GitPusher,
  isBranchPrefix,
  isRemoteName,
  type PushContextConfig,
  publishRefFor,
  pushArgs,
  pushEnv,
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
const g = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
const refSha = (cwd: string, ref: string): string => {
  try {
    return g(cwd, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return "";
  }
};
const remoteRefs = (bare: string): string[] =>
  g(bare, "for-each-ref", "--format=%(refname)")
    .split("\n")
    .filter((l) => l !== "");

const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };
const NOW = new Date("2026-10-13T10:00:00Z");
const PREFIX = "sb/";

let root: string;
let repo: string;
let bare: string;
let home: string;
let dataDir: string;
let ledgerDir: string;
let db: Database.Database;
let ledger: Ledger;
let mgr: WorkspaceManager;
let publisher: GitPublisher;
let ctx: PushContextConfig;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-push-")));
  repo = path.join(root, "repo");
  bare = path.join(root, "remote.git");
  home = path.join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  g(root, "init", "-q", "--bare", "-b", "main", bare);
  g(repo, "remote", "add", "origin", bare);
  g(repo, "push", "-q", "origin", "main");
  dataDir = path.join(root, "data");
  ledgerDir = path.join(root, "ledger");
  mkdirSync(dataDir);
  db = openLedger(ledgerDir);
  const ids = createIdGenerator();
  ledger = createLedger(db, { ids });
  mgr = new WorkspaceManager({
    db,
    artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
    dataDir,
    allowedRoots: [root],
    ids,
    now: () => NOW,
  });
  publisher = new GitPublisher({ db, scratchDir: path.join(root, "scratch"), now: () => NOW });
  ctx = {
    projectId: "web",
    contextId: "main",
    path: repo,
    baseRef: "main",
    policy: "branch",
    remote: "origin",
    branchPrefix: PREFIX,
  };
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function pusher(over: { timeoutMs?: number } = {}): GitPusher {
  return new GitPusher({
    db,
    resolveContext: (id) => (id === ctx.projectId ? ctx : undefined),
    sourceEnv: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      GIT_DIR: "/nonexistent", // never passed through
      GIT_SSH_COMMAND: "false", // never passed through
    },
    ids: createIdGenerator(),
    now: () => NOW,
    ...over,
  });
}

async function running(sessionId?: string) {
  const session = sessionId
    ? { id: sessionId }
    : ledger.createMetaSession({ objective: "o", repoRoot: repo, projectId: "web" });
  const run = ledger.createRun({
    metaSessionId: session.id,
    state: "RUNNING",
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
    provider: "fake",
    projectId: "web",
  });
  const ws = await mgr.prepare({
    metaSessionId: session.id,
    runId: run.id,
    workspace: repo,
    trustProfile: "edit-untrusted",
  });
  if (ws.mode !== "worktree") throw new Error("expected a worktree");
  return { sessionId: session.id, runId: run.id, wt: ws.worktreePath };
}

/** A RUNNING run that committed `file` through the commit library (a real publish-ref commit with provenance). */
async function committed(file = "feature.txt") {
  const r = await running();
  writeFileSync(path.join(r.wt, file), `${file}\n`);
  const c = await publisher.commit({
    runId: r.runId,
    message: `Add ${file}`,
    identity: IDENTITY,
    projectId: "web",
    contextId: "main",
  });
  return { ...r, sha: c.sha };
}

const pushRows = () => db.prepare("SELECT * FROM git_push ORDER BY created_at, id").all() as Record<string, unknown>[];
const pushEvents = () =>
  db
    .prepare("SELECT run_id, payload_json FROM run_event WHERE type = 'git_push' ORDER BY ts, id")
    .all()
    .map((r) => ({ ...(r as { run_id: string }), p: JSON.parse((r as { payload_json: string }).payload_json) }));

/** Every byte of the ledger directory (database, WAL) as latin1 text, for leak searches. */
function ledgerText(): string {
  db.pragma("wal_checkpoint(TRUNCATE)");
  return readdirSync(ledgerDir)
    .map((f) => readFileSync(path.join(ledgerDir, f)).toString("latin1"))
    .join("\n");
}

describe("policy and target (BR-29, FR-GIT-05)", () => {
  it("policy none refuses before any Git call and records the attempt; the remote is unchanged", async () => {
    const c = await committed();
    ctx = { ...ctx, policy: "none" };
    const before = remoteRefs(bare);
    const r = await pusher().push({ metaSessionId: c.sessionId, requestedBy: "operator" });
    expect(r).toMatchObject({ outcome: "REFUSED_POLICY", reason: "POLICY_NONE", pushed: false, remote: "", ref: "" });
    expect(remoteRefs(bare)).toEqual(before);
    const rows = pushRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "REFUSED_POLICY", detail: "POLICY_NONE", requested_by: "operator" });
    expect(rows[0]?.run_id).toBeNull();
    // The operator attempt is a run event on the run of the newest published commit.
    expect(pushEvents()).toEqual([expect.objectContaining({ run_id: c.runId })]);
  });

  it("branch pushes ONLY the publish ref, under the prefix, and nothing else reaches the remote", async () => {
    const c = await committed();
    // Things that must never be pushed: a tag on the publish head (even with push.followTags in the repository
    // config), the run branch with its checkpoint commits, other local branches.
    g(repo, "tag", "v1", c.sha);
    g(repo, "config", "push.followTags", "true");
    await mgr.finalize(c.runId);
    g(repo, "branch", "other", "main");
    const r = await pusher().push({ metaSessionId: c.sessionId, requestedBy: "operator" });
    expect(r, r.reason).toMatchObject({ outcome: "ACCEPTED", reason: "ACCEPTED", pushed: true, remote: "origin" });
    const target = `refs/heads/${PREFIX}${c.sessionId}`;
    expect(r.ref).toBe(target);
    expect(r.headSha).toBe(c.sha);
    expect(r.commits).toEqual([c.sha]);
    expect(remoteRefs(bare).sort()).toEqual(["refs/heads/main", target].sort());
    expect(refSha(bare, target)).toBe(refSha(repo, publishRefFor(c.sessionId)));
    // The local publish ref and run branch are untouched; no remote-tracking ref is required.
    expect(refSha(repo, publishRefFor(c.sessionId))).toBe(c.sha);
    const row = pushRows()[0];
    expect(row).toMatchObject({
      outcome: "ACCEPTED",
      remote: "origin",
      ref: target,
      head_sha: c.sha,
      project_id: "web",
      context_id: "main",
      detail: "ACCEPTED",
    });
    expect(pushEvents()[0]?.p).toMatchObject({ outcome: "ACCEPTED", commits: [c.sha], commit_count: 1 });
    // The remote's URL (a local path here) is never recorded.
    expect(ledgerText()).not.toContain(bare);
  });

  it("a second commit is a fast-forward; an unchanged head is UP_TO_DATE", async () => {
    const c = await committed("one.txt");
    const p = pusher();
    expect((await p.push({ metaSessionId: c.sessionId, requestedBy: "operator" })).outcome).toBe("ACCEPTED");
    writeFileSync(path.join(c.wt, "two.txt"), "2\n");
    const second = await publisher.commit({
      runId: c.runId,
      message: "Two",
      identity: IDENTITY,
      projectId: "web",
      contextId: "main",
    });
    const r2 = await p.push({ metaSessionId: c.sessionId, requestedBy: "operator" });
    expect(r2).toMatchObject({ outcome: "ACCEPTED", headSha: second.sha, commits: [second.sha, c.sha] });
    const r3 = await p.push({ metaSessionId: c.sessionId, requestedBy: "operator" });
    expect(r3).toMatchObject({ outcome: "ACCEPTED", reason: "UP_TO_DATE", pushed: true });
    expect(pushRows()).toHaveLength(3);
  });

  it("a non-fast-forward is rejected by Git (never forced) and recorded; the remote ref is unchanged", async () => {
    const c = await committed();
    const target = `refs/heads/${PREFIX}${c.sessionId}`;
    // Someone else's unrelated commit is already at the target on the remote.
    const foreign = g(bare, "commit-tree", g(bare, "rev-parse", "main^{tree}"), "-m", "foreign");
    g(bare, "update-ref", target, foreign);
    const r = await pusher().push({ metaSessionId: c.sessionId, requestedBy: "operator" });
    expect(r).toMatchObject({ outcome: "REJECTED_REMOTE", reason: "NON_FAST_FORWARD", pushed: false });
    expect(refSha(bare, target)).toBe(foreign);
    expect(pushRows()[0]).toMatchObject({ outcome: "REJECTED_REMOTE", detail: "NON_FAST_FORWARD" });
  });

  it("the argv never forces and only updates one branch; bad input throws", () => {
    const sha = "a".repeat(40);
    const args = pushArgs("origin", sha, "refs/heads/sb/sess_1");
    expect(args.slice(-2)).toEqual(["origin", `${sha}:refs/heads/sb/sess_1`]);
    for (const bad of ["--force", "-f", "--force-with-lease", "--mirror", "--tags", "--all", "--follow-tags"]) {
      expect(args).not.toContain(bad);
    }
    expect(args.some((a) => a.startsWith("+"))).toBe(false);
    expect(args).toEqual(
      expect.arrayContaining(["--no-verify", "--porcelain", "--no-follow-tags", "core.hooksPath=/dev/null"]),
    );
    expect(() => pushArgs("origin", sha, "refs/tags/v1")).toThrow();
    expect(() => pushArgs("origin", sha, "+refs/heads/x")).toThrow();
    expect(() => pushArgs("https://h/x", sha, "refs/heads/x")).toThrow();
    expect(() => pushArgs("origin", "HEAD", "refs/heads/x")).toThrow();
  });

  it("refuses a target that is the operator's checked-out branch or the remote's default branch", async () => {
    const c = await committed();
    const short = `${PREFIX}${c.sessionId}`;
    g(repo, "checkout", "-q", "-b", short, "main");
    const r1 = await pusher().push({ metaSessionId: c.sessionId, requestedBy: "operator" });
    expect(r1).toMatchObject({ outcome: "REFUSED_POLICY", reason: "TARGET_PROTECTED" });
    g(repo, "checkout", "-q", "main");
    g(repo, "update-ref", `refs/remotes/origin/${short}`, "main");
    g(repo, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${short}`);
    const r2 = await pusher().push({ metaSessionId: c.sessionId, requestedBy: "operator" });
    expect(r2).toMatchObject({ outcome: "REFUSED_POLICY", reason: "TARGET_PROTECTED" });
    ctx = { ...ctx, baseRef: short };
    g(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const r3 = await pusher().push({ metaSessionId: c.sessionId, requestedBy: "operator" });
    expect(r3).toMatchObject({ outcome: "REFUSED_POLICY", reason: "TARGET_PROTECTED" });
    expect(remoteRefs(bare)).toEqual(["refs/heads/main"]);
  });

  it("refuses a publish ref that holds a checkpoint, a run-branch or any non-controller commit", async () => {
    const c = await committed();
    const publish = publishRefFor(c.sessionId);
    // An agent moved the publish ref onto its own commit (made on top of the controller's).
    const foreign = g(repo, "commit-tree", g(repo, "rev-parse", `${c.sha}^{tree}`), "-p", c.sha, "-m", "agent");
    g(repo, "update-ref", publish, foreign);
    const r1 = await pusher().push({ metaSessionId: c.sessionId, requestedBy: "operator" });
    expect(r1).toMatchObject({ outcome: "REFUSED_POLICY", reason: "PUBLISH_HISTORY_UNVERIFIED" });
    // ... or onto the run branch (checkpoint commits).
    await mgr.finalize(c.runId);
    const runBranch = g(repo, "for-each-ref", "--format=%(refname)", `refs/heads/switchboard/${c.sessionId}/`);
    expect(runBranch).not.toBe("");
    g(repo, "update-ref", publish, runBranch.split("\n")[0] as string);
    const r2 = await pusher().push({ metaSessionId: c.sessionId, requestedBy: "operator" });
    expect(r2).toMatchObject({ outcome: "REFUSED_POLICY", reason: "PUBLISH_HISTORY_UNVERIFIED" });
    expect(remoteRefs(bare)).toEqual(["refs/heads/main"]);
  });

  it("refuses a session with nothing published, and a repository that is not the context's", async () => {
    const r = await running();
    expect(await pusher().push({ metaSessionId: r.sessionId, requestedBy: "operator" })).toMatchObject({
      reason: "NOTHING_TO_PUSH",
      outcome: "REFUSED_POLICY",
    });
    const c = await committed();
    ctx = { ...ctx, path: root };
    expect(await pusher().push({ metaSessionId: c.sessionId, requestedBy: "operator" })).toMatchObject({
      reason: "CONTEXT_MISMATCH",
    });
    ctx = { ...ctx, path: "relative/repo" };
    expect(await pusher().push({ metaSessionId: c.sessionId, requestedBy: "operator" })).toMatchObject({
      reason: "CONTEXT_MISMATCH",
    });
    expect(pushRows()).toHaveLength(3);
  });

  it("an unknown meta-session is an error with nothing written", async () => {
    await expect(pusher().push({ metaSessionId: "sess_nope", requestedBy: "operator" })).rejects.toThrow(/unknown/u);
    expect(pushRows()).toHaveLength(0);
  });
});

describe("remote name and URL (credentials never recorded)", () => {
  it("a URL or credential-bearing value as the remote is refused and never written anywhere", async () => {
    const c = await committed();
    for (const remote of ["https://user:s3cr3t-tok@example.invalid/r.git", "git@example.invalid:r.git", "../x", "-o"]) {
      ctx = { ...ctx, remote };
      const r = await pusher().push({ metaSessionId: c.sessionId, requestedBy: "operator" });
      expect(r).toMatchObject({ outcome: "REFUSED_POLICY", reason: "REMOTE_INVALID", remote: "" });
    }
    const text = ledgerText();
    for (const leak of ["s3cr3t-tok", "example.invalid", "git@"]) expect(text).not.toContain(leak);
  });

  it("a configured remote whose URL carries credentials or a disallowed transport is refused without a network call", async () => {
    const c = await committed();
    g(repo, "remote", "add", "cred", "https://user:s3cr3t-tok@example.invalid/r.git");
    g(repo, "remote", "add", "tok", "https://ghp_tokenvalue@example.invalid/r.git");
    g(repo, "remote", "add", "plain", "http://example.invalid/r.git");
    g(repo, "remote", "add", "helper", "ext::sh -c touch% /tmp/should-not-exist");
    g(repo, "remote", "add", "pushurl", bare);
    g(repo, "remote", "set-url", "--push", "pushurl", "ssh://u:pw@example.invalid/r.git");
    const expectations: Record<string, string> = {
      cred: "REMOTE_URL_CREDENTIALS",
      tok: "REMOTE_URL_CREDENTIALS",
      plain: "REMOTE_TRANSPORT_NOT_ALLOWED",
      helper: "REMOTE_TRANSPORT_NOT_ALLOWED",
      pushurl: "REMOTE_URL_CREDENTIALS",
      upstream: "REMOTE_UNKNOWN",
    };
    for (const [remote, reason] of Object.entries(expectations)) {
      ctx = { ...ctx, remote };
      const r = await pusher().push({ metaSessionId: c.sessionId, requestedBy: "operator" });
      expect(r, remote).toMatchObject({ outcome: "REFUSED_POLICY", reason });
    }
    const text = ledgerText();
    for (const leak of ["s3cr3t-tok", "ghp_tokenvalue", "example.invalid", "u:pw"]) expect(text).not.toContain(leak);
  });

  it("classifies URLs without returning them", () => {
    const table: [string, string][] = [
      ["https://github.example/o/r.git", "ok"],
      ["https://user@github.example/o/r.git", "credentials"],
      ["https://user:pw@github.example/o/r.git", "credentials"],
      ["ssh://git@host.example/o/r.git", "ok"],
      ["ssh://git:pw@host.example/o/r.git", "credentials"],
      ["git@host.example:o/r.git", "ok"],
      ["user:pw@host.example:o/r.git", "credentials"],
      ["/srv/git/r.git", "ok"],
      ["../r.git", "ok"],
      ["file:///srv/git/r.git", "ok"],
      ["http://host.example/r.git", "transport"],
      ["git://host.example/r.git", "transport"],
      ["ext::ssh -i key host", "transport"],
      ["fd::3", "transport"],
    ];
    for (const [url, cls] of table) expect(classifyRemoteUrl(url), url).toBe(cls);
  });

  it("remote names and branch prefixes are validated without regular expressions on the value", () => {
    for (const ok of ["origin", "up-stream", "my.remote_2"]) expect(isRemoteName(ok), ok).toBe(true);
    for (const bad of ["", "-x", ".x", "a..b", "https://h/r", "a/b", "a:b", "u@h", "a b", "x".repeat(101)]) {
      expect(isRemoteName(bad), bad).toBe(false);
    }
    for (const ok of ["switchboard/", "sb/pub/", "pub-", "team.x/"]) expect(isBranchPrefix(ok), ok).toBe(true);
    for (const bad of ["", "/x/", "-x/", ".x/", "a//b/", "a..b/", "refs/heads/", "a/.b/", "x.lock/", "a b/", "a:b/"]) {
      expect(isBranchPrefix(bad), bad).toBe(false);
    }
  });
});

describe("trust boundary of the push process (ADR-0028)", () => {
  it("the environment holds only allowlisted variables plus the fixed Git settings", () => {
    const env = pushEnv({
      PATH: "/bin",
      HOME: "/h",
      SSH_AUTH_SOCK: "/s",
      GIT_SSH_COMMAND: "evil",
      GIT_ASKPASS: "evil",
      SSH_ASKPASS: "evil",
      GIT_CONFIG_GLOBAL: "/x",
      GIT_CONFIG_PARAMETERS: "'core.hookspath'='/x'",
      SWITCHBOARD_TOOL_TOKEN: "sbt1_x",
      DISPLAY: ":0",
      AWS_SECRET_ACCESS_KEY: "x",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", SSH_AUTH_SOCK: "/s", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
  });

  it("hooks in the repository never run: pre-push in .git/hooks and in a repository core.hooksPath", async () => {
    const c = await committed();
    const marker = path.join(root, "hook-ran");
    const hook = `#!/bin/sh\ntouch '${marker}'\nexit 1\n`;
    writeFileSync(path.join(repo, ".git", "hooks", "pre-push"), hook);
    chmodSync(path.join(repo, ".git", "hooks", "pre-push"), 0o755);
    const hooksDir = path.join(root, "hooks");
    mkdirSync(hooksDir);
    for (const name of ["pre-push", "reference-transaction", "post-update"]) {
      writeFileSync(path.join(hooksDir, name), hook);
      chmodSync(path.join(hooksDir, name), 0o755);
    }
    g(repo, "config", "core.hooksPath", hooksDir);
    const r = await pusher().push({ metaSessionId: c.sessionId, requestedBy: "operator" });
    expect(r.outcome, r.reason).toBe("ACCEPTED");
    expect(existsSync(marker)).toBe(false);
  });

  it("a repository config key that runs a program refuses the push before it starts", async () => {
    const c = await committed();
    const marker = path.join(root, "cmd-ran");
    for (const [key, value] of [
      ["core.sshCommand", `touch '${marker}'`],
      ["credential.helper", `!touch '${marker}'`],
      ["remote.origin.receivepack", `touch '${marker}'`],
      ["url.ssh://evil.invalid/.insteadOf", bare],
      ["protocol.ext.allow", "always"],
      ["http.sslVerify", "false"],
    ] as const) {
      g(repo, "config", key, value);
      const r = await pusher().push({ metaSessionId: c.sessionId, requestedBy: "operator" });
      expect(r, key).toMatchObject({ outcome: "REFUSED_POLICY", reason: "REPO_CONFIG_UNSAFE" });
      g(repo, "config", "--unset-all", key);
    }
    expect(existsSync(marker)).toBe(false);
    expect(remoteRefs(bare)).toEqual(["refs/heads/main"]);
  });

  it("a failing hook in the remote is a sanitized REMOTE_HOOK_DECLINED; its output is never recorded", async () => {
    const c = await committed();
    const hook = path.join(bare, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'HOOK-SECRET-OUTPUT https://user:pw@leak.invalid' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const r = await pusher().push({ metaSessionId: c.sessionId, requestedBy: "operator" });
    expect(r).toMatchObject({ outcome: "REJECTED_REMOTE", reason: "REMOTE_HOOK_DECLINED", pushed: false });
    const text = ledgerText();
    expect(text).not.toContain("HOOK-SECRET-OUTPUT");
    expect(text).not.toContain("leak.invalid");
    expect(remoteRefs(bare)).toEqual(["refs/heads/main"]);
  });

  it("classifies Git's stderr into fixed reasons only", () => {
    const run = (stderr: string, code = 128) => ({ code, stdout: "", stderr, timedOut: false, spawnError: false });
    const ref = "refs/heads/sb/sess_1";
    expect(classifyPush(run("fatal: could not read Username for 'https://h': terminal prompts disabled"), ref)).toEqual(
      { outcome: "ERROR", reason: "CREDENTIALS_UNAVAILABLE" },
    );
    expect(classifyPush(run("git@h: Permission denied (publickey).\nfatal: Could not read from remote"), ref)).toEqual({
      outcome: "ERROR",
      reason: "CREDENTIALS_UNAVAILABLE",
    });
    expect(classifyPush(run("ssh: Could not resolve hostname h: Name or service not known"), ref).reason).toBe(
      "REMOTE_UNREACHABLE",
    );
    expect(classifyPush(run("fatal: something else entirely"), ref).reason).toBe("GIT_FAILED");
    expect(classifyPush(run("fatal: unable to access 'https://h/': Could not resolve host: h"), ref).reason).toBe(
      "REMOTE_UNREACHABLE",
    );
    expect(classifyPush(run("fatal: transport 'ext' not allowed"), ref).reason).toBe("REMOTE_TRANSPORT_NOT_ALLOWED");
    expect(classifyPush({ ...run(""), timedOut: true }, ref)).toEqual({ outcome: "ERROR", reason: "TIMEOUT" });
    const porcelain = (flag: string, summary: string) => ({
      code: flag === "!" ? 1 : 0,
      stdout: `To x\n${flag}\tabc:${ref}\t${summary}\nDone\n`,
      stderr: "",
      timedOut: false,
      spawnError: false,
    });
    expect(classifyPush(porcelain("*", "[new branch]"), ref).reason).toBe("ACCEPTED");
    expect(classifyPush(porcelain("=", "[up to date]"), ref).reason).toBe("UP_TO_DATE");
    expect(classifyPush(porcelain("!", "[rejected] (fetch first)"), ref).reason).toBe("NON_FAST_FORWARD");
    expect(classifyPush(porcelain("!", "[remote rejected] (pre-receive hook declined)"), ref).reason).toBe(
      "REMOTE_HOOK_DECLINED",
    );
    expect(classifyPush(porcelain("!", "[remote rejected] (shallow update not allowed)"), ref).reason).toBe(
      "REMOTE_REJECTED",
    );
  });
});

describe("violations, agent reach and recording (Q-44, BR-31)", () => {
  it("any git_policy_violation in the meta-session refuses the push (fail closed)", async () => {
    const c = await committed();
    ledger.appendRunEvent({ runId: c.runId, type: "git_policy_violation", payload: { v: 1, violation_count: 1 } });
    const r = await pusher().push({ metaSessionId: c.sessionId, requestedBy: "operator" });
    expect(r).toMatchObject({ outcome: "REFUSED_POLICY", reason: "GIT_POLICY_VIOLATION" });
    const agent = await pusher().push({
      metaSessionId: c.sessionId,
      requestedBy: "agent_tool",
      runId: c.runId,
      agentReach: { ok: true },
    });
    expect(agent).toMatchObject({
      outcome: "REFUSED_POLICY",
      reason: "GIT_POLICY_VIOLATION",
      toolCode: "PUSH_NOT_ALLOWED",
    });
    expect(remoteRefs(bare)).toEqual(["refs/heads/main"]);
  });

  it("an agent push without a passing BR-31 verdict is refused and the reason recorded", async () => {
    const c = await committed();
    const r = await pusher().push({
      metaSessionId: c.sessionId,
      requestedBy: "agent_tool",
      runId: c.runId,
      agentReach: { ok: false, reason: "shell_broad" },
    });
    expect(r).toMatchObject({ outcome: "REFUSED_POLICY", reason: "CREDENTIAL_REACH", toolCode: "PUSH_NOT_ALLOWED" });
    expect(pushEvents()[0]).toMatchObject({ run_id: c.runId, p: { credential_reach: "shell_broad" } });
    expect(pushRows()[0]).toMatchObject({ run_id: c.runId, requested_by: "agent_tool" });
    const ok = await pusher().push({
      metaSessionId: c.sessionId,
      requestedBy: "agent_tool",
      runId: c.runId,
      agentReach: { ok: true },
    });
    expect(ok).toMatchObject({ outcome: "ACCEPTED", pushed: true });
  });

  it("concurrent pushes of one meta-session run one at a time and every attempt is recorded", async () => {
    const c = await committed();
    const p = pusher();
    const results = await Promise.all(
      [1, 2, 3].map(() => p.push({ metaSessionId: c.sessionId, requestedBy: "operator" })),
    );
    expect(results.map((r) => r.reason).sort()).toEqual(["ACCEPTED", "UP_TO_DATE", "UP_TO_DATE"]);
    expect(pushRows()).toHaveLength(3);
    expect(() => db.prepare("DELETE FROM git_push").run()).toThrow(/append-only/u);
    expect(() => db.prepare("UPDATE git_push SET detail = 'x'").run()).toThrow(/append-only/u);
  });
});

describe("credential-reach rule (BR-31, FR-GIT-06)", () => {
  const base = (over: Partial<PolicySnapshot> = {}): PolicySnapshot => ({
    name: "edit-untrusted",
    fileAccess: "worktree",
    shell: "allowlist",
    shellAllowlist: [],
    network: "off",
    repoConfig: "disabled",
    bypassApproved: false,
    project: {
      id: "web",
      name: "Web",
      environment_kind: "host",
      context_id: "main",
      base_ref: "main",
      effective_max_profile: "trusted-development",
      writable: true,
      identity: IDENTITY,
      push: { policy: "branch" },
    },
    ...over,
  });

  it("allows only a profile without arbitrary shell in a host environment", () => {
    expect(evaluateCredentialReach(base())).toEqual({ ok: true });
    expect(evaluateCredentialReach(base({ shell: "none" }))).toEqual({ ok: true });
    expect(evaluateCredentialReach(base({ shellAllowlist: ["npm test"] }))).toEqual({
      ok: false,
      reason: "shell_allowlist",
    });
    expect(evaluateCredentialReach(base({ shell: "broad" }))).toEqual({ ok: false, reason: "shell_broad" });
    expect(evaluateCredentialReach(base({ bypassApproved: true, shell: "none" }))).toEqual({
      ok: false,
      reason: "bypass_run",
    });
    const project = base().project as NonNullable<PolicySnapshot["project"]>;
    expect(evaluateCredentialReach(base({ project: { ...project, environment_kind: "container" } }))).toEqual({
      ok: false,
      reason: "container_not_available",
    });
    expect(evaluateCredentialReach(base({ project: { ...project, push: { policy: "none" } } }))).toEqual({
      ok: false,
      reason: "policy_not_branch",
    });
    const { project: _drop, ...noProject } = base();
    expect(evaluateCredentialReach(noProject)).toEqual({ ok: false, reason: "no_project" });
  });

  it("judges a privileged run by its approved scope and always refuses bypass", () => {
    const { shellAllowlist: _none, ...plain } = base();
    const scoped = (shell: unknown, bypass: boolean): PolicySnapshot => ({
      ...plain,
      name: "privileged",
      shell: "scoped",
      privilegedScope: {
        scope: {
          files: { access: "worktree" },
          shell: shell as { mode: "none" },
          network: { mode: "off" },
          repository_config: { mode: "disabled" },
          bypass,
        },
        scopeHash: "h",
        approvalId: "apr_1",
      },
    });
    expect(evaluateCredentialReach(scoped({ mode: "none" }, false))).toEqual({ ok: true });
    expect(evaluateCredentialReach(scoped({ mode: "none" }, true))).toEqual({ ok: false, reason: "bypass_run" });
    expect(evaluateCredentialReach(scoped({ mode: "broad" }, false))).toEqual({ ok: false, reason: "shell_broad" });
    expect(evaluateCredentialReach(scoped({ mode: "allowlist", allowlist: [["ls"]] }, false))).toEqual({
      ok: false,
      reason: "shell_allowlist",
    });
  });
});
