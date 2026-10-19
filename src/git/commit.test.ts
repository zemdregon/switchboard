import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { git } from "../workspace/git.js";
import { WorkspaceManager } from "../workspace/index.js";
import {
  CommitError,
  type CommitInput,
  GitPublisher,
  type GitPublisherOptions,
  isRunBranchRef,
  type PublishStep,
  publishRefFor,
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

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" });
}

/** Exit code of a Git command that is allowed to fail. */
function gRc(cwd: string, ...args: string[]): number {
  try {
    execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "ignore" });
    return 0;
  } catch (err) {
    return (err as { status: number }).status;
  }
}

const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };
const NOW = new Date("2026-10-13T10:00:00Z");

let root: string;
let repo: string;
let dataDir: string;
let scratch: string;
let db: Database.Database;
let ledger: Ledger;
let mgr: WorkspaceManager;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-gitpub-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, ".gitignore"), "*.log\nbuild/\n");
  writeFileSync(path.join(repo, "a.txt"), "original\n");
  writeFileSync(path.join(repo, "b.txt"), "bee\n");
  writeFileSync(path.join(repo, "d.txt"), "dee\n");
  mkdirSync(path.join(repo, "sub"));
  writeFileSync(path.join(repo, "sub", "s.txt"), "ess\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  scratch = path.join(root, "scratch");
  mkdirSync(dataDir);
  db = openLedger(path.join(root, "ledger"));
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
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function running() {
  const session = ledger.createMetaSession({ objective: "o", repoRoot: repo, projectId: "web" });
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
  return { session, run, ws, wt: ws.worktreePath };
}

function publisher(extra: Partial<GitPublisherOptions> = {}): GitPublisher {
  return new GitPublisher({ db, scratchDir: scratch, now: () => NOW, ...extra });
}

function input(runId: string, extra: Partial<CommitInput> = {}): CommitInput {
  return { runId, message: "Change things", identity: IDENTITY, projectId: "web", contextId: "main", ...extra };
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const indexFile = (wt: string) => path.resolve(wt, g(wt, "rev-parse", "--git-path", "index").trim());
/** The commit a ref points at, or "" when the ref does not exist. */
function refSha(cwd: string, ref: string): string {
  try {
    return g(cwd, "rev-parse", "--verify", "--quiet", ref).trim();
  } catch {
    return "";
  }
}
const treeDiff = (cwd: string, a: string, b: string) =>
  g(cwd, "diff-tree", "-r", "--name-status", a, b).trim().split("\n");

describe("publish ref naming (FR-GIT-08, LLD §12.3)", () => {
  it("lives under a controller namespace apart from the run branches", () => {
    const ref = publishRefFor("sess_01J9ZABCDEFGHJKMNPQRSTVWXY");
    expect(ref).toBe("refs/heads/switchboard/pub/sess_01J9ZABCDEFGHJKMNPQRSTVWXY");
    expect(isRunBranchRef(ref)).toBe(false);
    expect(isRunBranchRef("refs/heads/switchboard/sess_AAA/run_BBB")).toBe(true);
  });

  it("refuses a prefix that would collide with the run-branch namespace or is malformed", () => {
    const sess = "sess_01J9ZABCDEFGHJKMNPQRSTVWXY";
    for (const prefix of [
      "switchboard/",
      "switchboard/sess_x/",
      "a..b/",
      "/abs/",
      "a//b/",
      "no-slash",
      "x.lock/",
      ".hidden/",
      "",
    ]) {
      expect(() => publishRefFor(sess, prefix), prefix).toThrow();
    }
    expect(publishRefFor(sess, "team/pub/")).toBe(`refs/heads/team/pub/${sess}`);
    expect(() => publishRefFor("not-a-session")).toThrow();
  });
});

describe("commit algorithm (LLD §12.3, FR-GIT-07, FR-GIT-08)", () => {
  it("commits exactly the requested paths, stages deletions, and leaves the worktree index, HEAD and run branch alone", async () => {
    const { session, run, ws, wt } = await running();
    writeFileSync(path.join(wt, "a.txt"), "changed\n");
    writeFileSync(path.join(wt, "c.txt"), "new\n");
    rmSync(path.join(wt, "b.txt"));
    writeFileSync(path.join(wt, "d.txt"), "not requested\n");
    writeFileSync(path.join(wt, "e.txt"), "untracked, not requested\n");
    const indexBefore = sha256(indexFile(wt));
    const headBefore = g(wt, "rev-parse", "HEAD").trim();
    const branchBefore = refSha(repo, `refs/heads/${ws.branch}`);
    const statusBefore = g(wt, "status", "--porcelain");

    const res = await publisher().commit(input(run.id, { paths: ["a.txt", "c.txt", "b.txt"] }));

    expect(res.publishRef).toBe(`refs/heads/switchboard/pub/${session.id}`);
    expect(refSha(repo, res.publishRef)).toBe(res.sha);
    expect(res.parentSha).toBe(ws.baseCommit);
    expect(res.filesChanged).toBe(3);
    expect(treeDiff(repo, ws.baseCommit, res.sha)).toEqual(["M\ta.txt", "D\tb.txt", "A\tc.txt"]);
    // the worktree's own state is untouched
    expect(sha256(indexFile(wt))).toBe(indexBefore);
    expect(g(wt, "rev-parse", "HEAD").trim()).toBe(headBefore);
    expect(refSha(repo, `refs/heads/${ws.branch}`)).toBe(branchBefore);
    expect(g(wt, "status", "--porcelain")).toBe(statusBefore);
    // identity, dates, message, no signature, no trailer
    const raw = g(repo, "cat-file", "commit", res.sha);
    expect(raw).toContain(`author ${IDENTITY.name} <${IDENTITY.email}> ${NOW.getTime() / 1000} +0000`);
    expect(raw).toContain(`committer ${IDENTITY.name} <${IDENTITY.email}> ${NOW.getTime() / 1000} +0000`);
    expect(raw).not.toContain("gpgsig");
    expect(g(repo, "log", "-1", "--format=%B", res.sha)).toBe("Change things\n\n");
    expect(raw).not.toMatch(/Switchboard|switchboard/u);
  });

  it("with no paths commits every change but not ignored files or nested repositories", async () => {
    const { run, wt } = await running();
    writeFileSync(path.join(wt, "a.txt"), "changed\n");
    writeFileSync(path.join(wt, "new.txt"), "new\n");
    writeFileSync(path.join(wt, "debug.log"), "ignored\n");
    mkdirSync(path.join(wt, "build"));
    writeFileSync(path.join(wt, "build", "out.bin"), "ignored\n");
    rmSync(path.join(wt, "sub", "s.txt"));
    mkdirSync(path.join(wt, "vendor", "lib"), { recursive: true });
    g(path.join(wt, "vendor", "lib"), "init", "-q");
    writeFileSync(path.join(wt, "vendor", "lib", "x.txt"), "inside nested repo\n");

    const res = await publisher().commit(input(run.id));
    const changed = g(repo, "diff-tree", "-r", "--name-only", `${res.sha}~1`, res.sha).trim().split("\n").sort();
    expect(changed).toEqual(["a.txt", "new.txt", "sub/s.txt"]);
  });

  it("seeds the second commit from the publish head and records the chain", async () => {
    const { run, wt } = await running();
    writeFileSync(path.join(wt, "a.txt"), "one\n");
    const first = await publisher().commit(input(run.id, { paths: ["a.txt"] }));
    writeFileSync(path.join(wt, "c.txt"), "two\n");
    const second = await publisher().commit(input(run.id, { message: "Second", paths: ["c.txt"] }));
    expect(second.parentSha).toBe(first.sha);
    expect(treeDiff(repo, first.sha, second.sha)).toEqual(["A\tc.txt"]);
    expect(ledger.listGitCommits(run.id).map((r) => r.commit_sha)).toEqual([first.sha, second.sha]);
  });

  it("keeps checkpoint commits out of the publish history and the publish ref out of checkpoint commits", async () => {
    const { session, run, ws, wt } = await running();
    writeFileSync(path.join(wt, "a.txt"), "published\n");
    writeFileSync(path.join(wt, "e.txt"), "left for the checkpoint\n");
    const res = await publisher().commit(input(run.id, { paths: ["a.txt"] }));
    const before = refSha(repo, res.publishRef);

    // the controller's post-run checkpoint (FR-WS-03) lands on the run branch
    const fin = await mgr.finalize(run.id);
    expect(fin.committed).toBe(true);
    const checkpoint = fin.postCommit;
    expect(refSha(repo, `refs/heads/${ws.branch}`)).toBe(checkpoint);

    expect(refSha(repo, res.publishRef)).toBe(before); // a checkpoint does not move the publish ref
    expect(gRc(repo, "merge-base", "--is-ancestor", checkpoint, res.publishRef)).toBe(1);
    expect(g(repo, "rev-list", res.publishRef).split("\n")).not.toContain(checkpoint);
    expect(g(repo, "for-each-ref", "--contains", checkpoint, "refs/heads/switchboard/pub/").trim()).toBe("");
    // and a later publish commit still does not pull the checkpoint in
    const second = await publisher({ allowedStates: ["RUNNING"] }).commit(
      input(run.id, { message: "Again", paths: ["e.txt"] }),
    );
    expect(gRc(repo, "merge-base", "--is-ancestor", checkpoint, second.sha)).toBe(1);
    expect(g(repo, "rev-list", "--count", second.sha, "--not", ws.baseCommit)).toBe("2\n");
    expect(second.publishRef).toContain(session.id);
  });

  it("writes the provenance row and the git_commit event, and neither carries message text", async () => {
    const { session, run, wt } = await running();
    db.prepare("UPDATE run SET model = 'm-1' WHERE id = ?").run(run.id);
    writeFileSync(path.join(wt, "a.txt"), "x\n");
    const res = await publisher().commit(
      input(run.id, {
        message:
          "Fix the pager\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
        paths: ["a.txt"],
      }),
    );
    expect(g(repo, "log", "-1", "--format=%B", res.sha)).toBe("Fix the pager\n\n");
    const [row] = ledger.listGitCommits(run.id);
    expect(row).toMatchObject({
      id: res.provenanceId,
      commit_sha: res.sha,
      tree_sha: res.treeSha,
      patch_id: res.patchId,
      repo_root: repo,
      publish_ref: res.publishRef,
      project_id: "web",
      context_id: "main",
      meta_session_id: session.id,
      run_id: run.id,
      provider: "fake",
      harness: "fake",
      model: "m-1",
      origin: "commit_tool",
    });
    expect(row?.patch_id).toMatch(/^[0-9a-f]{40}$/u);
    expect(row?.id).toMatch(/^gcm_[0-9A-Z]{26}$/u);
    expect(JSON.parse(row?.sanitizer_json ?? "")).toEqual({
      rules: { "footer.generated-by": 1, "trailer.co-author": 1 },
    });
    const events = ledger.listRunEvents(run.id).filter((e) => e.type.startsWith("git_commit"));
    expect(events.map((e) => e.type)).toEqual(["git_commit_intent", "git_commit"]);
    expect(row?.tool_event_id).toBe(events[1]?.id);
    for (const e of events) expect(e.payload_json).not.toMatch(/Fix the pager|Claude|noreply/u);
  });

  it("rolls back the event and the row together when the row cannot be written, then recovery completes it", async () => {
    const { run, wt } = await running();
    writeFileSync(path.join(wt, "a.txt"), "x\n");
    db.exec("CREATE TRIGGER block_gc BEFORE INSERT ON git_commit BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const err = await publisher()
      .commit(input(run.id, { paths: ["a.txt"] }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommitError);
    expect((err as CommitError).code).toBe("PROVENANCE_PENDING");
    const sha = (err as CommitError).commitSha as string;
    expect(refSha(repo, publishRefFor(ledger.getRun(run.id)?.meta_session_id as string))).toBe(sha);
    expect(ledger.listGitCommits(run.id)).toEqual([]);
    expect(ledger.listRunEvents(run.id).some((e) => e.type === "git_commit")).toBe(false); // same transaction

    db.exec("DROP TRIGGER block_gc");
    const report = await publisher().recover();
    expect(report).toEqual({ rolledForward: [sha], aborted: [], unresolved: [] });
    expect(ledger.listGitCommits(run.id).map((r) => r.commit_sha)).toEqual([sha]);
    expect(
      JSON.parse(ledger.listRunEvents(run.id).find((e) => e.type === "git_commit")?.payload_json ?? "{}"),
    ).toMatchObject({
      recovered: true,
    });
    expect(await publisher().recover()).toEqual({ rolledForward: [], aborted: [], unresolved: [] }); // idempotent
  });

  it("ignores repository hooks and user configuration (hardened controller Git)", async () => {
    const { run, wt } = await running();
    for (const hook of ["reference-transaction", "pre-commit", "commit-msg", "post-commit"]) {
      const file = path.join(repo, ".git", "hooks", hook);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "#!/bin/sh\nexit 1\n");
      chmodSync(file, 0o755);
    }
    g(repo, "config", "commit.gpgsign", "true");
    g(repo, "config", "gpg.program", "/nonexistent/gpg");
    writeFileSync(path.join(wt, "a.txt"), "x\n");
    const res = await publisher().commit(input(run.id, { paths: ["a.txt"] }));
    expect(refSha(repo, res.publishRef)).toBe(res.sha);
    expect(g(repo, "cat-file", "commit", res.sha)).not.toContain("gpgsig"); // signing is T9.10, off here
  });

  it("treats a wildcard literally and still commits a file whose name contains one", async () => {
    const { run, wt } = await running();
    writeFileSync(path.join(wt, "we*ird[1].txt"), "odd\n");
    writeFileSync(path.join(wt, "x.txt"), "x\n");
    writeFileSync(path.join(wt, "y.txt"), "y\n");
    await expect(publisher().commit(input(run.id, { paths: ["*.txt"] }))).rejects.toMatchObject({
      code: "PATH_REFUSED",
      refused: [{ path: "*.txt", reason: "missing" }],
    });
    const res = await publisher().commit(input(run.id, { paths: ["we*ird[1].txt"] }));
    expect(g(repo, "diff-tree", "-r", "--name-only", `${res.sha}~1`, res.sha).trim()).toBe("we*ird[1].txt");
  });

  it("handles names that look like options or pathspec magic, and a directory path with a deletion inside", async () => {
    const { run, wt } = await running();
    writeFileSync(path.join(wt, "-dash.txt"), "d\n");
    writeFileSync(path.join(wt, ":(top)magic.txt"), "m\n");
    writeFileSync(path.join(wt, "sub", "new.txt"), "n\n");
    rmSync(path.join(wt, "sub", "s.txt"));
    const res = await publisher().commit(input(run.id, { paths: ["-dash.txt", ":(top)magic.txt", "sub"] }));
    expect(treeDiff(repo, `${res.sha}~1`, res.sha)).toEqual([
      "A\t-dash.txt",
      "A\t:(top)magic.txt",
      "A\tsub/new.txt",
      "D\tsub/s.txt",
    ]);
  });
});

describe("repository filter drivers and submodules (TDD §3.10, LLD §12.3)", () => {
  const EVIL_ATTRS = "*.dat filter=evil diff=evil\n*.proc filter=evilproc\n";

  /** Repository-configured drivers that append a canary line and pass content through (T3.8 shape, local). */
  function configureEvilDrivers(cwd: string, log: string): void {
    const script = (name: string, body: string) => {
      const p = path.join(root, `${name}.sh`);
      writeFileSync(p, `#!/bin/sh\necho "filter ${name} in $PWD" >> '${log}'\n${body}\n`);
      chmodSync(p, 0o755);
      return p;
    };
    g(cwd, "config", "filter.evil.clean", script("clean", "cat"));
    g(cwd, "config", "filter.evil.smudge", script("smudge", "cat"));
    g(cwd, "config", "filter.evil.required", "true");
    g(cwd, "config", "filter.evilproc.process", script("process", "cat"));
    g(cwd, "config", "diff.evil.textconv", script("textconv", 'cat "$1"'));
    g(cwd, "config", "diff.evil.command", script("extdiff", "exit 0"));
    g(cwd, "config", "diff.external", script("external", "exit 0"));
  }

  /** Plain Git as an operator shell would run it: the repository's own drivers all apply (positive controls only). */
  const plainGit = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

  const canary = (log: string): string => {
    try {
      return readFileSync(log, "utf8");
    } catch {
      return "";
    }
  };

  it("commits working-tree bytes without running repository clean/smudge/process or textconv/external drivers", async () => {
    const log = path.join(root, "filters.log");
    writeFileSync(path.join(repo, ".gitattributes"), EVIL_ATTRS);
    writeFileSync(path.join(repo, "payload.dat"), "plain data\n");
    writeFileSync(path.join(repo, "payload.proc"), "process data\n");
    configureEvilDrivers(repo, log);
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "drivers");
    expect(g(repo, "show", "HEAD:payload.dat")).toBe("plain data\n");
    rmSync(log, { force: true });

    const { run, wt } = await running();
    // Seeding the worktree ran no smudge or process driver and checked out the raw bytes.
    expect(canary(log)).toBe("");
    expect(readFileSync(path.join(wt, "payload.dat"), "utf8")).toBe("plain data\n");

    writeFileSync(path.join(wt, "payload.dat"), "changed by the run (dat)\n");
    writeFileSync(path.join(wt, "payload.proc"), "changed by the run (proc)\n");
    writeFileSync(path.join(wt, "new.dat"), "new by the run (dat)\n");
    const res = await publisher().commit(input(run.id));
    // Neither the temporary-index `git add` (clean, process) nor the `diff-tree` calls behind the patch id
    // (textconv, external) ran any repository-configured driver.
    expect(canary(log)).toBe("");
    expect(res.filesChanged).toBe(3);
    expect(g(repo, "show", `${res.sha}:payload.dat`)).toBe("changed by the run (dat)\n");
    expect(g(repo, "show", `${res.sha}:payload.proc`)).toBe("changed by the run (proc)\n");
    expect(g(repo, "show", `${res.sha}:new.dat`)).toBe("new by the run (dat)\n");

    // Positive controls: the same drivers really run under unhardened Git in this worktree.
    writeFileSync(path.join(wt, "payload.dat"), "changed again (dat)\n");
    plainGit(wt, "add", "-A");
    expect(canary(log)).toMatch(/filter clean/);
    expect(canary(log)).toMatch(/filter process/);
    plainGit(wt, "diff", "--cached", "--no-ext-diff", "HEAD");
    expect(canary(log)).toMatch(/filter textconv/);
    rmSync(log, { force: true });
    plainGit(wt, "diff", "--cached", "HEAD");
    expect(canary(log)).toMatch(/filter extdiff/);
  });

  it("leaves submodule pointers alone: an initialized submodule is excluded and never recursed into", async () => {
    const fileEnv = { ...GIT_ENV, GIT_ALLOW_PROTOCOL: "file" };
    const sgit = (cwd: string, ...args: string[]): string =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: fileEnv, encoding: "utf8" }).trim();
    const subsrc = path.join(root, "subsrc");
    mkdirSync(subsrc);
    g(subsrc, "init", "-q", "-b", "main");
    writeFileSync(path.join(subsrc, "lib.txt"), "v1\n");
    g(subsrc, "add", "-A");
    g(subsrc, "commit", "-q", "-m", "sub v1");
    const v1 = g(subsrc, "rev-parse", "HEAD").trim();
    sgit(repo, "submodule", "add", "-q", subsrc, "vendor/sub");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "add submodule");

    const { run, wt } = await running();
    sgit(wt, "submodule", "update", "--init", "--quiet", "vendor/sub");
    // Advance the submodule upstream and move the worktree's pointer there, plus a top-level change.
    writeFileSync(path.join(subsrc, "lib.txt"), "v2\n");
    g(subsrc, "add", "-A");
    g(subsrc, "commit", "-q", "-m", "sub v2");
    const v2 = g(subsrc, "rev-parse", "HEAD").trim();
    sgit(wt, "submodule", "update", "--remote", "--quiet", "vendor/sub");
    expect(g(path.join(wt, "vendor", "sub"), "rev-parse", "HEAD").trim()).toBe(v2);
    writeFileSync(path.join(wt, "a.txt"), "top change\n");
    const libBefore = sha256(path.join(wt, "vendor", "sub", "lib.txt"));

    // Naming the submodule (or a directory above it) is refused, like any nested repository.
    await expect(publisher().commit(input(run.id, { paths: ["vendor/sub"] }))).rejects.toMatchObject({
      code: "PATH_REFUSED",
      refused: [{ path: "vendor/sub", reason: "nested_repository" }],
    });
    await expect(publisher().commit(input(run.id, { paths: ["vendor"] }))).rejects.toMatchObject({
      code: "PATH_REFUSED",
      refused: [{ path: "vendor", reason: "contains_nested_repository" }],
    });

    // Committing everything stages the top-level change but not the moved gitlink: no recursion, no fetch.
    const res = await publisher().commit(input(run.id));
    expect(res.filesChanged).toBe(1);
    expect(g(repo, "show", `${res.sha}:a.txt`)).toBe("top change\n");
    const parentLink = g(repo, "ls-tree", `${res.sha}~1`, "--", "vendor/sub").trim();
    expect(parentLink).toBe(`160000 commit ${v1}\tvendor/sub`);
    expect(g(repo, "ls-tree", res.sha, "--", "vendor/sub").trim()).toBe(parentLink);
    expect(sha256(path.join(wt, "vendor", "sub", "lib.txt"))).toBe(libBefore);
  });
});

describe("hardened Git helper", () => {
  it("accepts only the plumbing variables as extra environment", async () => {
    await expect(git(["--version"], { env: { GIT_INDEX_FILE: "/tmp/x" } })).resolves.toBeTruthy();
    for (const key of ["GIT_DIR", "GIT_CONFIG_COUNT", "GIT_SSH_COMMAND", "PATH", "HOME"]) {
      await expect(git(["--version"], { env: { [key]: "x" } }), key).rejects.toThrow(/not allowed/u);
    }
  });
});

describe("path refusals (reported per path, nothing committed)", () => {
  it("refuses outside, missing, ignored, nested, .git and symlink paths with a reason for each", async () => {
    const { run, wt, session } = await running();
    writeFileSync(path.join(wt, "ok.txt"), "ok\n");
    writeFileSync(path.join(wt, "debug.log"), "ignored\n");
    mkdirSync(path.join(wt, "vendor", "lib"), { recursive: true });
    g(path.join(wt, "vendor", "lib"), "init", "-q");
    writeFileSync(path.join(wt, "vendor", "lib", "x.txt"), "nested\n");
    writeFileSync(path.join(root, "outside.txt"), "outside\n");
    symlinkSync(root, path.join(wt, "escape"));

    const bad = [
      "../outside.txt",
      "sub/../../outside.txt",
      path.join(root, "outside.txt"),
      "nope.txt",
      "debug.log",
      "vendor/lib/x.txt",
      "vendor",
      ".git/config",
      "escape/outside.txt",
      ".",
      "",
    ];
    const err = (await publisher()
      .commit(input(run.id, { paths: ["ok.txt", ...bad] }))
      .catch((e: unknown) => e)) as CommitError;
    expect(err).toBeInstanceOf(CommitError);
    expect(err.code).toBe("PATH_OUTSIDE_WORKTREE");
    const byPath = Object.fromEntries(err.refused.map((r) => [r.path, r.reason]));
    expect(byPath).toEqual({
      "../outside.txt": "outside_worktree",
      "sub/../../outside.txt": "outside_worktree",
      [path.join(root, "outside.txt")]: "outside_worktree",
      "nope.txt": "missing",
      "debug.log": "ignored",
      "vendor/lib/x.txt": "nested_repository",
      vendor: "contains_nested_repository",
      ".git/config": "git_dir",
      "escape/outside.txt": "symlink_in_path",
      ".": "invalid",
      "": "invalid",
    });
    // all or nothing: the acceptable path was not committed either
    expect(refSha(repo, publishRefFor(session.id))).toBe("");
    expect(ledger.listGitCommits(run.id)).toEqual([]);
    expect(ledger.listRunEvents(run.id).filter((e) => e.type.startsWith("git_commit"))).toEqual([]);
  });

  it("uses PATH_REFUSED when nothing is outside the worktree", async () => {
    const { run } = await running();
    await expect(publisher().commit(input(run.id, { paths: ["nope.txt"] }))).rejects.toMatchObject({
      code: "PATH_REFUSED",
    });
  });

  it("allows a tracked file that is deleted, and a tracked file that is now ignored", async () => {
    const { run, wt } = await running();
    writeFileSync(path.join(wt, ".gitignore"), "*.log\nbuild/\nd.txt\n"); // d.txt is tracked in the base, now ignored
    writeFileSync(path.join(wt, "d.txt"), "tracked but now ignored\n");
    rmSync(path.join(wt, "b.txt"));
    const res = await publisher().commit(input(run.id, { paths: ["d.txt", "b.txt"] }));
    expect(treeDiff(repo, `${res.sha}~1`, res.sha)).toEqual(["D\tb.txt", "M\td.txt"]);
  });

  it("reports NOTHING_TO_COMMIT when the tree would not change", async () => {
    const { run, session } = await running();
    await expect(publisher().commit(input(run.id))).rejects.toMatchObject({ code: "NOTHING_TO_COMMIT" });
    await expect(publisher().commit(input(run.id, { paths: ["a.txt"] }))).rejects.toMatchObject({
      code: "NOTHING_TO_COMMIT",
    });
    expect(refSha(repo, publishRefFor(session.id))).toBe("");
  });
});

describe("request, lease and message checks", () => {
  it("refuses a run that is not RUNNING, has lost its lease or is unknown", async () => {
    const { run, wt } = await running();
    writeFileSync(path.join(wt, "a.txt"), "x\n");
    await expect(publisher().commit(input("run_NOPE"))).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    db.prepare("UPDATE run SET state = 'FINALIZING' WHERE id = ?").run(run.id);
    await expect(publisher().commit(input(run.id))).rejects.toMatchObject({ code: "NOT_RUNNING" });
    await expect(
      publisher({ allowedStates: ["FINALIZING"] }).commit(input(run.id, { paths: ["a.txt"] })),
    ).resolves.toBeTruthy();
    db.prepare("UPDATE run SET state = 'RUNNING' WHERE id = ?").run(run.id);
    mgr.releaseLease(run.id);
    await expect(publisher().commit(input(run.id))).rejects.toMatchObject({ code: "LEASE_LOST" });
  });

  it("refuses an expired lease and a missing worktree", async () => {
    const { run, session, wt } = await running();
    db.prepare("UPDATE meta_session SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(session.id);
    await expect(publisher().commit(input(run.id))).rejects.toMatchObject({ code: "LEASE_LOST" });
    db.prepare("UPDATE meta_session SET lease_expires_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(session.id);
    rmSync(wt, { recursive: true, force: true });
    await expect(publisher().commit(input(run.id))).rejects.toMatchObject({ code: "NO_WORKTREE" });
  });

  it("refuses bad identities, including the controller's checkpoint identity", async () => {
    const { run } = await running();
    for (const identity of [
      { name: "", email: "a@b.test" },
      { name: "Ada", email: "" },
      { name: "A<da", email: "a@b.test" },
      { name: "Ada", email: "a@b.test>\nX: y" },
      { name: "Switchboard", email: "switchboard@localhost" },
      { name: "Anyone", email: "Switchboard@Localhost" },
    ]) {
      await expect(publisher().commit(input(run.id, { identity })), JSON.stringify(identity)).rejects.toMatchObject({
        code: "IDENTITY_INVALID",
      });
    }
  });

  it("refuses an empty request and too many paths", async () => {
    const { run } = await running();
    await expect(publisher().commit(input(run.id, { message: "  " }))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(publisher().commit(input(run.id, { paths: [] }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      publisher().commit(input(run.id, { paths: Array.from({ length: 257 }, (_, i) => `f${i}`) })),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("returns MESSAGE_EMPTY_AFTER_SANITISING and leaves the ref alone", async () => {
    const { run, wt, session } = await running();
    writeFileSync(path.join(wt, "a.txt"), "x\n");
    await expect(
      publisher().commit(
        input(run.id, { message: "Co-authored-by: Claude <noreply@anthropic.com>", paths: ["a.txt"] }),
      ),
    ).rejects.toMatchObject({ code: "MESSAGE_EMPTY_AFTER_SANITISING" });
    expect(refSha(repo, publishRefFor(session.id))).toBe("");
    expect(ledger.listRunEvents(run.id).filter((e) => e.type.startsWith("git_commit"))).toEqual([]);
  });

  it("applies operator patterns and the run's native session id", async () => {
    const { run, wt } = await running();
    writeFileSync(path.join(wt, "a.txt"), "x\n");
    const res = await publisher({ sanitizePatterns: ["^ticket-\\d+"] }).commit(
      input(run.id, {
        message: "Fix cache (thread_7f3a9c21d0e84b)\n\nTICKET-77 internal tracker\nBody stays",
        paths: ["a.txt"],
        nativeSessionIds: ["thread_7f3a9c21d0e84b"],
      }),
    );
    expect(g(repo, "log", "-1", "--format=%B", res.sha)).toBe("Fix cache ()\n\nBody stays\n\n");
    expect(res.sanitizer.rules).toEqual({ "id.native-session": 1, "operator.1": 1 });
  });

  it("rejects an unsafe operator pattern when the publisher is built", () => {
    // Assembled at run time so static analysis does not read the fixture as a live regex.
    const unsafe = ["(a+", ")+$"].join("");
    expect(() => publisher({ sanitizePatterns: [unsafe] })).toThrow(/pattern 0/u);
  });
});

describe("compare-and-swap on the publish ref", () => {
  it("retries once on top of a ref that moved, aborting the lost attempt's intent", async () => {
    const { session, run, wt } = await running();
    writeFileSync(path.join(wt, "a.txt"), "mine\n");
    const ref = publishRefFor(session.id);
    let moved = false;
    const res = await publisher({
      testHooks: {
        afterStep: (step) => {
          if (step !== "intent_recorded" || moved) return;
          moved = true;
          // another publisher wins the race
          const interloper = g(
            repo,
            "commit-tree",
            g(repo, "rev-parse", "main^{tree}").trim(),
            "-p",
            "main",
            "-m",
            "interloper",
          ).trim();
          g(repo, "update-ref", ref, interloper);
        },
      },
    }).commit(input(run.id, { paths: ["a.txt"] }));
    expect(moved).toBe(true);
    expect(g(repo, "log", "-1", "--format=%s", `${res.sha}~1`).trim()).toBe("interloper");
    expect(refSha(repo, ref)).toBe(res.sha);
    const types = ledger
      .listRunEvents(run.id)
      .map((e) => e.type)
      .filter((t) => t.startsWith("git_commit"));
    expect(types).toEqual(["git_commit_intent", "git_commit_aborted", "git_commit_intent", "git_commit"]);
    expect(ledger.listGitCommits(run.id)).toHaveLength(1);
    expect(await publisher().recover()).toEqual({ rolledForward: [], aborted: [], unresolved: [] });
  });

  it("gives up with PUBLISH_CONFLICT after the retry and records no provenance row", async () => {
    const { session, run, wt } = await running();
    writeFileSync(path.join(wt, "a.txt"), "mine\n");
    const ref = publishRefFor(session.id);
    let n = 0;
    const err = (await publisher({
      testHooks: {
        afterStep: (step) => {
          if (step !== "intent_recorded") return;
          const tree = g(repo, "rev-parse", "main^{tree}").trim();
          g(repo, "update-ref", ref, g(repo, "commit-tree", tree, "-p", "main", "-m", `interloper ${++n}`).trim());
        },
      },
    })
      .commit(input(run.id, { paths: ["a.txt"] }))
      .catch((e: unknown) => e)) as CommitError;
    expect(err.code).toBe("PUBLISH_CONFLICT");
    expect(n).toBe(2);
    expect(ledger.listGitCommits(run.id)).toEqual([]);
    expect(ledger.listRunEvents(run.id).filter((e) => e.type === "git_commit_aborted")).toHaveLength(2);
    expect(g(repo, "log", "-1", "--format=%s", ref).trim()).toBe("interloper 2");
  });
});

describe("crash injection: every step recovers (ADR-0025)", () => {
  const STEPS: PublishStep[] = ["tree_written", "commit_created", "intent_recorded", "ref_updated", "outcome_recorded"];
  const EXPECT: Record<PublishStep, { ref: boolean; row: boolean; recovery: "none" | "aborted" | "rolled-forward" }> = {
    tree_written: { ref: false, row: false, recovery: "none" },
    commit_created: { ref: false, row: false, recovery: "none" },
    intent_recorded: { ref: false, row: false, recovery: "aborted" },
    ref_updated: { ref: true, row: false, recovery: "rolled-forward" },
    outcome_recorded: { ref: true, row: true, recovery: "none" },
  };

  for (const step of STEPS) {
    it(`a crash after ${step} leaves a recoverable state`, async () => {
      const { session, run, wt } = await running();
      writeFileSync(path.join(wt, "a.txt"), "x\n");
      const indexBefore = sha256(indexFile(wt));
      const ref = publishRefFor(session.id);
      const crash = new Error(`crash after ${step}`);
      await expect(
        publisher({
          testHooks: {
            afterStep: (s) => {
              if (s === step) throw crash;
            },
          },
        }).commit(input(run.id, { paths: ["a.txt"] })),
      ).rejects.toBe(crash);

      const want = EXPECT[step];
      const published = refSha(repo, ref);
      expect(published !== "").toBe(want.ref);
      expect(ledger.listGitCommits(run.id).length).toBe(want.row ? 1 : 0);
      expect(sha256(indexFile(wt))).toBe(indexBefore); // a crash never touches the worktree's own index

      // "restart": a new publisher over the same ledger
      const report = await publisher().recover();
      expect(report.unresolved).toEqual([]);
      expect(report.rolledForward.length).toBe(want.recovery === "rolled-forward" ? 1 : 0);
      expect(report.aborted.length).toBe(want.recovery === "aborted" ? 1 : 0);
      // after recovery a published commit has exactly one row and an unpublished one has none
      expect(ledger.listGitCommits(run.id).length).toBe(want.ref ? 1 : 0);
      expect(refSha(repo, ref) !== "").toBe(want.ref);
      expect(await publisher().recover()).toEqual({ rolledForward: [], aborted: [], unresolved: [] });

      // the session carries on: the next commit works and builds on whatever is published
      writeFileSync(path.join(wt, "c.txt"), "next\n");
      const next = await publisher().commit(input(run.id, { message: "Next", paths: ["c.txt"] }));
      expect(next.parentSha).toBe(want.ref ? published : await running_base(session.id));
    });
  }

  it("recovery leaves an unresolvable intent for the next call", async () => {
    const { run, wt, session } = await running();
    writeFileSync(path.join(wt, "a.txt"), "x\n");
    await publisher({
      testHooks: {
        afterStep: (s) => {
          if (s === "ref_updated") throw new Error("crash");
        },
      },
    })
      .commit(input(run.id, { paths: ["a.txt"] }))
      .catch(() => undefined);
    db.prepare("UPDATE meta_session SET repo_root = repo_root WHERE id = ?").run(session.id);
    const intent = db.prepare("SELECT payload_json FROM run_event WHERE type = 'git_commit_intent'").get() as {
      payload_json: string;
    };
    expect(JSON.parse(intent.payload_json).record.repoRoot).toBe(repo);
    rmSync(repo, { recursive: true, force: true }); // the repository is gone: cannot decide
    const report = await publisher().recover();
    expect(report.unresolved).toHaveLength(1);
    expect(ledger.listGitCommits(run.id)).toEqual([]);
  });

  function running_base(sessionId: string): string {
    const row = db.prepare("SELECT base_commit FROM meta_session WHERE id = ?").get(sessionId) as {
      base_commit: string;
    };
    return row.base_commit;
  }
});

describe("finalize-only loosened limits for an approved bypass run (owner decision 44, ROADMAP Q-45)", () => {
  const loose = { origin: "finalize_only" as const, looseLimits: true };

  it("commits all 300 changed paths in one pass; without the flag the 256-path limit still holds", async () => {
    const { run, wt, session } = await running();
    const names = Array.from({ length: 300 }, (_, i) => `many/f${i}.txt`);
    mkdirSync(path.join(wt, "many"));
    for (const n of names) writeFileSync(path.join(wt, n), `${n}\n`);
    await expect(publisher().commit(input(run.id, { paths: names, origin: "finalize_only" }))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    // The flag alone (origin commit_tool, i.e. the agent's own channel) is not honoured either.
    await expect(publisher().commit(input(run.id, { paths: names, looseLimits: true }))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    const res = await publisher().commit(input(run.id, { paths: names, ...loose }));
    expect(res.filesChanged).toBe(300);
    expect(g(repo, "ls-tree", "-r", "--name-only", refSha(repo, publishRefFor(session.id))).split("\n")).toEqual(
      expect.arrayContaining(names),
    );
  });

  it("still refuses traversal, symlink and .git paths when loosened, and commits nothing", async () => {
    const { run, wt, session } = await running();
    writeFileSync(path.join(wt, "ok.txt"), "ok\n");
    writeFileSync(path.join(root, "outside.txt"), "outside\n");
    symlinkSync(root, path.join(wt, "escape"));
    const many = Array.from({ length: 300 }, (_, i) => `ok${i}.txt`);
    for (const n of many) writeFileSync(path.join(wt, n), "x\n");
    const err = (await publisher()
      .commit(input(run.id, { paths: [...many, "../outside.txt", "escape/outside.txt", ".git/config"], ...loose }))
      .catch((e: unknown) => e)) as CommitError;
    expect(err).toBeInstanceOf(CommitError);
    expect(err.code).toBe("PATH_OUTSIDE_WORKTREE");
    expect(Object.fromEntries(err.refused.map((r) => [r.path, r.reason]))).toEqual({
      "../outside.txt": "outside_worktree",
      "escape/outside.txt": "symlink_in_path",
      ".git/config": "git_dir",
    });
    expect(refSha(repo, publishRefFor(session.id))).toBe("");
  });

  it("sanitises the whole message first, then truncates with a note; the report covers the full text", async () => {
    const { run, wt } = await running();
    writeFileSync(path.join(wt, "a.txt"), "x\n");
    // The attribution line sits beyond the 8192-character limit: the sanitiser must still see (and remove) it.
    const body = `Subject line\n\n${"word ".repeat(4000)}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n`;
    expect(body.length).toBeGreaterThan(20_000);
    const res = await publisher().commit(input(run.id, { message: body, paths: ["a.txt"], ...loose }));
    const msg = g(repo, "log", "-1", "--format=%B", res.sha);
    expect(msg.length).toBeLessThanOrEqual(8192 + 2);
    expect(msg.startsWith("Subject line\n\nword word")).toBe(true);
    expect(msg).toContain("truncated");
    expect(msg.toLowerCase()).not.toContain("co-authored");
    expect(res.sanitizer.rules["trailer.co-author"]).toBe(1);
    // Without the flag the same message is committed whole (the limit lives in the callers, not here).
    writeFileSync(path.join(wt, "a.txt"), "y\n");
    const whole = await publisher().commit(input(run.id, { message: body, paths: ["a.txt"] }));
    expect(g(repo, "log", "-1", "--format=%B", whole.sha).length).toBeGreaterThan(19_000);
  });

  it("leaves a message within the limit untouched, even with the flag", async () => {
    const { run, wt } = await running();
    writeFileSync(path.join(wt, "a.txt"), "x\n");
    const res = await publisher().commit(input(run.id, { message: "Short one", paths: ["a.txt"], ...loose }));
    expect(g(repo, "log", "-1", "--format=%B", res.sha)).toBe("Short one\n\n");
  });
});
