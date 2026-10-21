import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { WorkspaceManager } from "./index.js";
import { excludePathspec, findNestedRepositories, partitionNested } from "./nested.js";

/**
 * Nested-repository guard (Q-31, R-35, TDD §3.4, ADR-0022). Fixtures are harmless: the "driver" only touches a marker
 * file in a temp directory outside every repository. Nothing here plays an attacker (that is T3.8b).
 */

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};

/** Plain Git for the test's own setup, with the marker filter and diff drivers disabled so setup never trips them. */
function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "filter.sbmark.clean=", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Unhardened Git: what a naive controller would run. Used only as a positive control. */
function plain(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: "pipe" });
}

let root: string;
let repo: string;
let markers: string;
let db: Database.Database;
let ledger: Ledger;
let mgr: WorkspaceManager;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-nested-")));
  repo = path.join(root, "repo");
  markers = path.join(root, "markers");
  mkdirSync(repo);
  mkdirSync(markers);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "original\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  db = openLedger(path.join(root, "ledger"));
  ledger = createLedger(db, { ids: createIdGenerator() });
  mgr = new WorkspaceManager({
    db,
    artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
    dataDir,
    allowedRoots: [root],
    ids: createIdGenerator(),
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function prepared() {
  const session = ledger.createMetaSession({ objective: "o", repoRoot: repo });
  const run = ledger.createRun({
    metaSessionId: session.id,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
  });
  const ws = await mgr.prepare({
    metaSessionId: session.id,
    runId: run.id,
    workspace: repo,
    trustProfile: "edit-untrusted",
  });
  if (ws.mode !== "worktree") throw new Error("expected worktree");
  return { run, wt: ws.worktreePath };
}

const markerFiles = () =>
  existsSync(markers) ? execFileSync("ls", [markers], { encoding: "utf8" }).split("\n").filter(Boolean) : [];
const clearMarkers = () => {
  rmSync(markers, { recursive: true, force: true });
  mkdirSync(markers);
};

/**
 * What the run leaves behind: a nested repository `dir` with a committed `f.txt` and `.gitattributes` selecting a
 * driver `sbmark` that only touches a marker file, registered as a gitlink in the worktree index (as a previous
 * `git add -A` would leave it), then `f.txt` rewritten to the same size so Git has to hash it through the filter.
 */
function plantNested(wt: string, dir = "nested", gitFile = false, stage = true): string {
  const n = path.join(wt, dir);
  mkdirSync(n, { recursive: true });
  g(n, "init", "-q", "-b", "main");
  writeFileSync(path.join(n, ".gitattributes"), "f.txt filter=sbmark diff=sbmark\n");
  writeFileSync(path.join(n, "f.txt"), "one\n");
  g(n, "add", "-A");
  g(n, "commit", "-q", "-m", "n");
  const cfg = path.join(n, ".git", "config");
  const marker = (name: string) => `touch '${path.join(markers, name)}'; cat`;
  writeFileSync(
    cfg,
    `${readFileSync(cfg, "utf8")}[filter "sbmark"]\n\tclean = ${marker("clean")}\n[diff "sbmark"]\n\ttextconv = ${marker("textconv")}\n`,
  );
  if (gitFile) {
    // Move the git directory out and leave a gitdir-pointer file in its place.
    const out = path.join(root, `gitdir-${Math.random().toString(36).slice(2)}`);
    execFileSync("mv", [path.join(n, ".git"), out]);
    writeFileSync(path.join(n, ".git"), `gitdir: ${out}\n`);
  }
  if (stage) g(wt, "add", "--", `:(literal)${dir}`);
  writeFileSync(path.join(n, "f.txt"), "two\n");
  const t = new Date(Date.now() + 5000);
  utimesSync(path.join(n, "f.txt"), t, t);
  return n;
}

describe("nested repository guard (Q-31, R-35)", () => {
  it("positive control: the marker driver runs when Git is invoked directly, in the nested repo or from its parent", async () => {
    const { wt } = await prepared();
    const n = plantNested(wt);
    plain(n, "status", "--porcelain");
    expect(markerFiles()).toContain("clean");
    clearMarkers();
    utimesSync(path.join(n, "f.txt"), new Date(Date.now() + 6000), new Date(Date.now() + 6000));
    plain(wt, "status", "--porcelain=v2"); // an unhardened parent status descends into the gitlink
    expect(markerFiles()).toContain("clean");
  });

  for (const gitFile of [false, true]) {
    const form = gitFile ? "a .git file (gitdir pointer)" : "a .git directory";
    it(`status, diff, add and checkpoint never start Git in a nested repository with ${form}`, async () => {
      const { run, wt } = await prepared();
      plantNested(wt, "nested", gitFile);
      clearMarkers();
      const assessment = await mgr.assessMutation(run.id);
      expect(markerFiles()).toEqual([]);
      expect(assessment.nestedRepositories).toEqual(["nested"]);
      expect(assessment.reasons.join()).not.toMatch(/unreadable/);
      writeFileSync(path.join(wt, "a.txt"), "changed by the run\n");
      const fin = await mgr.finalize(run.id);
      expect(markerFiles()).toEqual([]);
      expect(fin.nestedRepositories).toEqual(["nested"]);
      // The ordinary change is captured. The gitlink entry the run had already staged is only a pointer; none of the
      // nested repository's files are in the checkpoint.
      expect(fin.committed).toBe(true);
      expect(fin.changedFiles).toEqual([
        { status: "M", path: "a.txt" },
        { status: "A", path: "nested" },
      ]);
      await mgr.rollback(run.id);
      expect(markerFiles()).toEqual([]);
      expect(readFileSync(path.join(wt, "a.txt"), "utf8")).toBe("original\n");
    });
  }

  it("a run that only touches an unstaged nested repository is not committed (stated consequence: weaker change detection)", async () => {
    const { run, wt } = await prepared();
    plantNested(wt, "nested", false, false);
    const fin = await mgr.finalize(run.id);
    expect(fin.committed).toBe(false);
    expect(fin.changedFiles).toEqual([]);
    expect(fin.nestedRepositories).toEqual(["nested"]);
  });

  it("reports no warning when there is no nested repository, and never treats the worktree root's own .git as nested", async () => {
    const { run, wt } = await prepared();
    expect(existsSync(path.join(wt, ".git"))).toBe(true); // a gitdir-pointer file in a linked worktree
    expect((await mgr.assessMutation(run.id)).nestedRepositories).toEqual([]);
    expect((await findNestedRepositories(wt)).paths).toEqual([]);
  });

  it("handles paths with spaces, unicode and glob characters, and does not descend into nested repositories", async () => {
    const { run, wt } = await prepared();
    const names = ["with space/dep", "ünï-cødé/日本語", "we*ird[1]?/x", "-dash", ":colon"];
    for (const name of names) plantNested(wt, name);
    mkdirSync(path.join(wt, "nested-in", "deeper"), { recursive: true });
    plantNested(wt, "nested", false);
    mkdirSync(path.join(wt, "nested", "inner"));
    mkdirSync(path.join(wt, "nested", "inner", ".git")); // inside a nested repository: covered by the outer exclude
    clearMarkers();
    const found = (await findNestedRepositories(wt)).paths;
    expect([...found].sort()).toEqual([...names, "nested"].sort());
    writeFileSync(path.join(wt, "a.txt"), "changed\n");
    const assessment = await mgr.assessMutation(run.id);
    const fin = await mgr.finalize(run.id);
    expect(markerFiles()).toEqual([]);
    expect(assessment.nestedRepositories).toEqual(found);
    // Only a.txt plus the gitlink pointers the run had staged; no file below any nested repository.
    const paths = fin.changedFiles.map((f) => f.path).sort();
    expect(paths).toEqual(["a.txt", ...names, "nested"].sort());
  });

  it("does not follow symlinks and ignores a symlink to a repository outside the worktree", async () => {
    const { wt } = await prepared();
    const outside = path.join(root, "outside");
    mkdirSync(path.join(outside, "deep"), { recursive: true });
    g(path.join(outside, "deep"), "init", "-q");
    symlinkSync(outside, path.join(wt, "link-to-outside"));
    expect((await findNestedRepositories(wt)).paths).toEqual([]);
  });

  // T4.10: APFS (macOS) refuses a name that is not valid UTF-8 (mkdir fails ENOENT), so the case cannot be built there.
  it.skipIf(process.platform === "darwin")(
    "a name that is not valid UTF-8 is excluded through a widened glob instead of failing the run",
    async () => {
      const { run, wt } = await prepared();
      const bad = Buffer.concat([Buffer.from(`${wt}/bad-`), Buffer.from([0xff, 0xfe]), Buffer.from("-dir")]);
      mkdirSync(Buffer.concat([bad, Buffer.from("/.git")]) as unknown as string, { recursive: true });
      const found = await findNestedRepositories(wt);
      expect(found.paths).toHaveLength(1);
      expect(found.excludes[0]).toMatch(/^:\(exclude,top,glob\)bad-\*-dir$/);
      writeFileSync(path.join(wt, "a.txt"), "changed\n");
      const fin = await mgr.finalize(run.id);
      expect(fin.changedFiles).toEqual([{ status: "M", path: "a.txt" }]);
      expect(
        g(wt, "ls-files")
          .split("\n")
          .filter((l) => l.includes("bad-")),
      ).toEqual([]);
    },
  );

  it("excludePathspec uses literal matching for ordinary names and escapes glob characters otherwise", () => {
    expect(excludePathspec("a b/ü")).toBe(":(exclude,top,literal)a b/ü");
    expect(excludePathspec("x*[y]�z")).toBe(":(exclude,top,glob)x\\*\\[y]*z");
  });

  it("ADR-0087: partitionNested separates attached declared submodules from other nested repositories", () => {
    const nested = {
      paths: ["libs/a", "libs/a-copy", "tmp/agent-repo", "vendor/b"],
      excludes: ["libs/a", "libs/a-copy", "tmp/agent-repo", "vendor/b"].map(excludePathspec),
    };
    const split = partitionNested(nested, ["vendor/b", "libs/a", "not/found"]);
    expect(split.submodules).toEqual(["libs/a", "vendor/b"]);
    expect(split.others.paths).toEqual(["libs/a-copy", "tmp/agent-repo"]);
    expect(split.others.excludes).toEqual([excludePathspec("libs/a-copy"), excludePathspec("tmp/agent-repo")]);
    // Without attached submodules (a context without mode recursive) every nested repository stays excluded.
    expect(partitionNested(nested, []).others).toEqual(nested);
  });
});
