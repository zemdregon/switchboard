/**
 * T5.7 (ADR-0038 item 6, LLD §15.6; FR-SES-03, FR-WS-01, 02, 04, 08, NFR-SEC-06): the working directory of a native
 * resume. Through the real run lifecycle with a fake provider CLI (no provider, no network, no credential) against a
 * temporary Git repository:
 * - a directory-bound fake (`bound`, the fake's default) and an `unverified` one resume in the worktree path of the run
 *   that created the native session, on a new run branch at the head checkpoint;
 * - the unbound fake (`independent`) resumes in a fresh path `<data>/worktrees/<sess>/<run>`;
 * - an unusable origin path (unclean, locked, unregistered, a symlink, another repository, another meta-session's path,
 *   no origin run) is never replaced by another directory: the plan says `unavailable` before admission and the run
 *   fails before spawn at LEASED; a missing directory is re-created at the same path;
 * - two meta-sessions never get the same path (FR-WS-08), and a path of another meta-session is rejected.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile, type ResumeCwd } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRecord, type TrustProfile } from "../ledger/index.js";
import { ResumeDirectoryUnavailableError, WorkspaceManager } from "../workspace/index.js";
import { RESUME_DIRECTORY_UNAVAILABLE, RunLifecycle } from "./index.js";

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

const SHORT = { wallClockMs: 20_000, idleMs: 10_000, killGraceMs: 300 };
const PROFILE: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};

/**
 * Fake CLI: the objective (stdin) is a short name. It appends its working directory to `SPAWNS` (outside the repository,
 * so the test can count spawns), reports a session (the resumed id, or `dir-session-1`), writes `<name>.txt` in its
 * working directory and ends with a summary naming that directory.
 */
const DIR_CLI = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (a.includes("--version")) process.stdout.write("fake-cli 1.0.0\\n");
else if (a.includes("--auth-status")) process.stdout.write('{"authenticated":true}\\n');
else if (a.includes("--smoke")) emit({ type: "result", ok: true, summary: "smoke" });
else {
  const name = readFileSync(0, "utf8").trim();
  appendFileSync(SPAWNS, process.cwd() + "\\n");
  const r = a.indexOf("--resume");
  emit({ type: "session", session_id: r >= 0 ? a[r + 1] : "dir-session-1" });
  writeFileSync(name + ".txt", name + "\\n");
  emit({ type: "result", ok: true, summary: "cwd=" + process.cwd() });
}
`;

let root: string;
let repo: string;
let dataDir: string;
let spawns: string;
let script: string;
let db: Database.Database;
let ledger: Ledger;
let workspace: WorkspaceManager;
let lifecycle: RunLifecycle | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-resume-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "base\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  spawns = path.join(root, "spawns.log");
  writeFileSync(spawns, "");
  script = path.join(root, "dir-cli.mjs");
  writeFileSync(script, DIR_CLI.replace("SPAWNS", JSON.stringify(spawns)));
  db = openLedger(path.join(root, "ledger"));
  const ids = createIdGenerator();
  ledger = createLedger(db, { ids });
  workspace = new WorkspaceManager({
    db,
    artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
    dataDir,
    allowedRoots: [root],
    ids,
  });
  lifecycle = undefined;
});

afterEach(async () => {
  await lifecycle?.shutdown();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function start(resumeCwd: ResumeCwd): RunLifecycle {
  lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
    adapters: new AdapterRegistry().register(
      new FakeAdapter({ script, commitChannel: "none", timeouts: SHORT, resumeCwd }),
    ),
    allowedRoots: [root],
    globalConcurrency: 4,
    resolveProfile: () => PROFILE,
  });
  lifecycle.start();
  return lifecycle;
}

const spawnCount = () => readFileSync(spawns, "utf8").split("\n").filter(Boolean).length;
const lastSpawnCwd = () => readFileSync(spawns, "utf8").split("\n").filter(Boolean).at(-1);
const transitions = (runId: string) =>
  ledger
    .listRunEvents(runId)
    .filter((e) => e.type === "state_transition")
    .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);
const sessionRow = (sess: string) =>
  db.prepare("SELECT head_commit, lease_run_id FROM meta_session WHERE id = ?").get(sess) as {
    head_commit: string | null;
    lease_run_id: string | null;
  };
const sessionDir = (sess: string) => path.join(dataDir, "worktrees", sess);

async function runTo(
  lc: RunLifecycle,
  objective: string,
  opts: { metaSessionId?: string; resume?: string; trustProfile?: TrustProfile } = {},
): Promise<RunRecord> {
  const { runId } = await lc.submit({
    clientId: "c",
    objective,
    workspace: repo,
    trustProfile: opts.trustProfile ?? "edit-untrusted",
    provider: "fake",
    ...(opts.metaSessionId !== undefined ? { metaSessionId: opts.metaSessionId } : {}),
    ...(opts.resume !== undefined ? { resume: { nativeSessionId: opts.resume } } : {}),
  });
  return lc.waitForTerminal(runId);
}

/** A first run (creates the native session `dir-session-1`) and its worktree. */
async function origin(lc: RunLifecycle) {
  const first = await runTo(lc, "alpha");
  expect(first.state, first.failure_detail ?? "").toBe("SUCCEEDED");
  return { sess: first.meta_session_id, run: first, path: first.worktree_path as string };
}

const plan = (lc: RunLifecycle, sess: string, resumeCwd: ResumeCwd, trustProfile: TrustProfile = "edit-untrusted") =>
  lc.resumeDirectoryPlan({
    metaSessionId: sess,
    provider: "fake",
    nativeSessionId: "dir-session-1",
    trustProfile,
    workspace: repo,
    resumeCwd,
  });

function expectRefusedBeforeSpawn(run: RunRecord, problem: string): void {
  expect(run.state).toBe("FAILED");
  expect(run.failure_code).toBe("TOOL_FAILURE");
  const last = transitions(run.id).at(-1);
  expect(last).toMatchObject({ from: "LEASED", to: "FAILED", reason: RESUME_DIRECTORY_UNAVAILABLE, problem });
  // Never RUNNING: no process was started in any directory.
  expect(transitions(run.id).some((t) => t.to === "RUNNING")).toBe(false);
}

describe("resume working directory (T5.7, LLD §15.6)", () => {
  for (const resumeCwd of ["bound", "unverified"] as const) {
    it(`${resumeCwd}: the resume runs in the origin worktree path on a new branch at the head checkpoint`, async () => {
      const lc = start(resumeCwd);
      const o = await origin(lc);
      expect(o.path).toBe(path.join(sessionDir(o.sess), o.run.id));
      const head = sessionRow(o.sess).head_commit as string;
      expect(await plan(lc, o.sess, resumeCwd)).toEqual({ kind: "origin", originRunId: o.run.id, originPath: o.path });

      const resumed = await runTo(lc, "beta", { metaSessionId: o.sess, resume: "dir-session-1" });
      expect(resumed.state, resumed.failure_detail ?? "").toBe("SUCCEEDED");
      // Same directory for the provider; the run's own branch, base and pre checkpoints.
      expect(resumed.worktree_path).toBe(o.path);
      expect(lastSpawnCwd()).toBe(o.path);
      expect(resumed.branch).toBe(`switchboard/${o.sess}/${resumed.id}`);
      expect(ledger.getRunCheckpointCommit(resumed.id, "base")).toBe(head);
      expect(ledger.getRunCheckpointCommit(resumed.id, "pre")).toBe(head);
      expect(g(o.path, "symbolic-ref", "HEAD")).toBe(`refs/heads/${resumed.branch}`);
      // The origin run's branch still holds its own checkpoint; the resume's branch builds on it.
      expect(g(repo, "rev-parse", o.run.branch as string)).toBe(head);
      expect(g(repo, "show", "--name-only", "--format=", resumed.branch as string).split("\n")).toEqual(["beta.txt"]);
      expect(readdirNames(sessionDir(o.sess))).toEqual([o.run.id]);
      // A second resume still goes back to the origin path.
      const again = await runTo(lc, "gamma", { metaSessionId: o.sess, resume: "dir-session-1" });
      expect(again.state, again.failure_detail ?? "").toBe("SUCCEEDED");
      expect(again.worktree_path).toBe(o.path);
      expect(readdirNames(sessionDir(o.sess))).toEqual([o.run.id]);
    });
  }

  it("independent: the resume runs in a fresh worktree path", async () => {
    const lc = start("independent");
    const o = await origin(lc);
    expect(await plan(lc, o.sess, "independent")).toEqual({ kind: "fresh" });
    const resumed = await runTo(lc, "beta", { metaSessionId: o.sess, resume: "dir-session-1" });
    expect(resumed.state, resumed.failure_detail ?? "").toBe("SUCCEEDED");
    expect(resumed.worktree_path).toBe(path.join(sessionDir(o.sess), resumed.id));
    expect(resumed.worktree_path).not.toBe(o.path);
    expect(lastSpawnCwd()).toBe(resumed.worktree_path);
    expect(g(o.path, "symbolic-ref", "HEAD")).toBe(`refs/heads/${o.run.branch}`);
  });

  it("a missing origin directory is re-created at the same path from the head checkpoint", async () => {
    const lc = start("bound");
    const o = await origin(lc);
    g(repo, "worktree", "remove", "--force", o.path);
    expect(existsSync(o.path)).toBe(false);
    expect(await plan(lc, o.sess, "bound")).toMatchObject({ kind: "origin", originPath: o.path });
    const resumed = await runTo(lc, "beta", { metaSessionId: o.sess, resume: "dir-session-1" });
    expect(resumed.state, resumed.failure_detail ?? "").toBe("SUCCEEDED");
    expect(resumed.worktree_path).toBe(o.path);
    expect(lastSpawnCwd()).toBe(o.path);
    expect(existsSync(path.join(o.path, "alpha.txt"))).toBe(true); // from the head checkpoint
  });

  describe("an unusable origin path is never replaced by another directory", () => {
    const cases: { name: string; problem: string; spoil: (p: string, sess: string) => void }[] = [
      {
        name: "untracked file",
        problem: "unclean",
        spoil: (p) => writeFileSync(path.join(p, "stray.txt"), "x\n"),
      },
      {
        name: "modified tracked file",
        problem: "unclean",
        spoil: (p) => writeFileSync(path.join(p, "alpha.txt"), "changed\n"),
      },
      { name: "locked worktree", problem: "locked", spoil: (p) => g(repo, "worktree", "lock", p) },
      {
        name: "plain directory, not a worktree",
        problem: "not_registered",
        spoil: (p) => {
          g(repo, "worktree", "remove", "--force", p);
          mkdirSync(p);
        },
      },
      {
        name: "symlink",
        problem: "not_a_directory",
        spoil: (p) => {
          g(repo, "worktree", "remove", "--force", p);
          const elsewhere = path.join(root, "elsewhere");
          mkdirSync(elsewhere);
          symlinkSync(elsewhere, p);
        },
      },
      {
        name: "`.git` file pointing at another repository",
        problem: "not_registered",
        spoil: (p) => {
          const other = path.join(root, "other");
          mkdirSync(other);
          g(other, "init", "-q", "-b", "main");
          writeFileSync(path.join(p, ".git"), `gitdir: ${path.join(other, ".git")}\n`);
        },
      },
    ];
    for (const c of cases) {
      it(`${c.name}: refused before admission and before spawn (${c.problem})`, async () => {
        const lc = start("unverified");
        const o = await origin(lc);
        c.spoil(o.path, o.sess);
        const before = spawnCount();
        expect(await plan(lc, o.sess, "unverified")).toMatchObject({ kind: "unavailable", problem: c.problem });
        // Submitted anyway (as a race past the admission check would be): LEASED re-checks and fails before spawn.
        const resumed = await runTo(lc, "beta", { metaSessionId: o.sess, resume: "dir-session-1" });
        expectRefusedBeforeSpawn(resumed, c.problem);
        expect(spawnCount()).toBe(before);
        expect(readdirNames(sessionDir(o.sess))).toEqual([o.run.id]); // no fresh directory
        expect(g(repo, "branch", "--list", `switchboard/${o.sess}/${resumed.id}`)).toBe(""); // no branch
        expect(sessionRow(o.sess).lease_run_id).toBeNull();
      });
    }

    it("no origin run (a binding no terminal run reported) is refused", async () => {
      const lc = start("bound");
      const o = await origin(lc);
      const p = await lc.resumeDirectoryPlan({
        metaSessionId: o.sess,
        provider: "fake",
        nativeSessionId: "never-reported",
        trustProfile: "edit-untrusted",
        workspace: repo,
        resumeCwd: "bound",
      });
      expect(p).toMatchObject({ kind: "unavailable", problem: "no_origin_run" });
      const before = spawnCount();
      const resumed = await runTo(lc, "beta", { metaSessionId: o.sess, resume: "never-reported" });
      expectRefusedBeforeSpawn(resumed, "no_origin_run");
      expect(spawnCount()).toBe(before);
    });

    it("a read-only resume of a session created in a worktree is refused (directory_mismatch)", async () => {
      const lc = start("bound");
      const o = await origin(lc);
      expect(await plan(lc, o.sess, "bound", "inspect-untrusted")).toMatchObject({
        kind: "unavailable",
        problem: "directory_mismatch",
      });
      const before = spawnCount();
      const resumed = await runTo(lc, "beta", {
        metaSessionId: o.sess,
        resume: "dir-session-1",
        trustProfile: "inspect-untrusted",
      });
      expectRefusedBeforeSpawn(resumed, "directory_mismatch");
      expect(spawnCount()).toBe(before);
    });
  });

  describe("no worktree shared across meta-sessions (FR-WS-08)", () => {
    it("two meta-sessions resumed at once never get the same path", async () => {
      const lc = start("bound");
      const a = await origin(lc);
      const b = await origin(lc);
      expect(a.sess).not.toBe(b.sess);
      const [ra, rb] = await Promise.all([
        runTo(lc, "beta", { metaSessionId: a.sess, resume: "dir-session-1" }),
        runTo(lc, "gamma", { metaSessionId: b.sess, resume: "dir-session-1" }),
      ]);
      expect(ra.state, ra.failure_detail ?? "").toBe("SUCCEEDED");
      expect(rb.state, rb.failure_detail ?? "").toBe("SUCCEEDED");
      expect(ra.worktree_path).toBe(a.path);
      expect(rb.worktree_path).toBe(b.path);
      expect(ra.worktree_path).not.toBe(rb.worktree_path);
      expect(path.dirname(ra.worktree_path as string)).toBe(sessionDir(a.sess));
      expect(path.dirname(rb.worktree_path as string)).toBe(sessionDir(b.sess));
      expect(existsSync(path.join(a.path, "gamma.txt"))).toBe(false);
      expect(existsSync(path.join(b.path, "beta.txt"))).toBe(false);
      // Every worktree path recorded for a run belongs to exactly one meta-session.
      const rows = db
        .prepare("SELECT meta_session_id, worktree_path FROM run WHERE worktree_path IS NOT NULL")
        .all() as {
        meta_session_id: string;
        worktree_path: string;
      }[];
      const owner = new Map<string, string>();
      for (const r of rows) {
        expect(owner.get(r.worktree_path) ?? r.meta_session_id).toBe(r.meta_session_id);
        owner.set(r.worktree_path, r.meta_session_id);
      }
    });

    it("a path that belongs to another meta-session is rejected and left untouched", async () => {
      const lc = start("bound");
      const a = await origin(lc);
      const b = await origin(lc);
      const aHead = g(a.path, "rev-parse", "HEAD");
      const aBranch = g(a.path, "symbolic-ref", "HEAD");

      // The workspace manager rejects it outright.
      expect(await workspace.inspectResumeDirectory(b.sess, a.path)).toMatchObject({
        usable: false,
        problem: "outside_session_directory",
      });
      // A ledger row pointing B's origin at A's worktree (corruption or tampering) is refused before spawn.
      db.prepare("UPDATE run SET worktree_path = ? WHERE id = ?").run(a.path, b.run.id);
      expect(await plan(lc, b.sess, "bound")).toMatchObject({
        kind: "unavailable",
        problem: "outside_session_directory",
      });
      const before = spawnCount();
      const resumed = await runTo(lc, "beta", { metaSessionId: b.sess, resume: "dir-session-1" });
      expectRefusedBeforeSpawn(resumed, "outside_session_directory");
      expect(spawnCount()).toBe(before);
      expect(g(a.path, "rev-parse", "HEAD")).toBe(aHead);
      expect(g(a.path, "symbolic-ref", "HEAD")).toBe(aBranch);
      expect(g(a.path, "status", "--porcelain")).toBe("");
      expect(sessionRow(a.sess).lease_run_id).toBeNull();

      // `prepare` itself refuses it too (the LEASED re-check), with no Git change.
      const fresh = ledger.createRun({
        metaSessionId: b.sess,
        state: "LEASED",
        trustProfile: "edit-untrusted",
        policySnapshot: PROFILE,
        request: {},
        requestHash: "h",
        clientId: "c",
        idempotencyKey: null,
        provider: "fake",
        priority: 0,
      });
      await expect(
        workspace.prepare({
          metaSessionId: b.sess,
          runId: fresh.id,
          workspace: repo,
          trustProfile: "edit-untrusted",
          resumeIn: { originPath: a.path },
        }),
      ).rejects.toBeInstanceOf(ResumeDirectoryUnavailableError);
      expect(g(a.path, "rev-parse", "HEAD")).toBe(aHead);
      expect(g(a.path, "symbolic-ref", "HEAD")).toBe(aBranch);
      expect(sessionRow(b.sess).lease_run_id).toBeNull();
    });
  });
});

function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort();
}
