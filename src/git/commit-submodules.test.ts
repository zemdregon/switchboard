/**
 * ADR-0079 item 4 (FR-GIT-14): controller-made submodule commits in the commit tool path and `finalize_commit`.
 * Local fixture repositories only (`src/submodules/fixtures/repos.ts`); the submodules are attached with the library
 * itself (`attachSubmodules` + `writeAttachRecord`), as the workspace manager does for a `mode: "recursive"` context.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import {
  type Fixture,
  g,
  gitmodulesText,
  HOST,
  makeFixture,
  makeRemote,
  makeUmbrella,
  OWNER,
} from "../submodules/fixtures/repos.js";
import { listSubmoduleCommitsForUmbrella, submoduleCommitPaths } from "../submodules/ledger.js";
import { readSubmoduleManifest } from "../submodules/manifest.js";
import { prepareStores } from "../submodules/store.js";
import { type AttachRecord, attachRecordFile, attachSubmodules, writeAttachRecord } from "../submodules/worktree.js";
import { WorkspaceManager } from "../workspace/index.js";
import { CommitError, type CommitInput, GitPublisher, type GitPublisherOptions } from "./commit.js";
import { makeFinalizeCommit } from "./finalize.js";
import { createThrowawaySigner, gpgAvailable } from "./fixtures/throwaway-gpg.js";
import { publishRefFor } from "./publish-ref.js";

const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };
const NOW = new Date("2026-10-21T10:00:00Z");
const KEY_A = "github.test/acme/lib-a";
const KEY_B = "github.test/acme/lib-b";

let fx: Fixture;
let db: Database.Database;
let ledger: Ledger;
let mgr: WorkspaceManager;
let scratch: string;

beforeEach(() => {
  fx = makeFixture("sb-csub-");
  const dataDir = path.join(fx.root, "data");
  mkdirSync(dataDir);
  scratch = path.join(fx.root, "scratch");
  db = openLedger(path.join(fx.root, "ledger"));
  const ids = createIdGenerator();
  ledger = createLedger(db, { ids });
  mgr = new WorkspaceManager({
    db,
    artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
    dataDir,
    allowedRoots: [fx.root],
    ids,
    now: () => NOW,
  });
});

afterEach(() => {
  db.close();
  rmSync(fx.root, { recursive: true, force: true });
});

interface Setup {
  sessionId: string;
  runId: string;
  wt: string;
  umbrella: string;
  rec: AttachRecord;
  stores: Map<string, string>;
  a: { head: string };
  b: { head: string };
}

/**
 * An umbrella with `mods/a` and `dup/a` (one repository, two paths), `mods/b` and the wiki `wiki`, a running run with
 * its worktree, and every submodule attached. `writable` is the context's `writable_paths`.
 */
async function setup(opts: { writable?: string[]; state?: "RUNNING" | "FINALIZING" } = {}): Promise<Setup> {
  const a = makeRemote(fx, "lib-a", { "a.txt": "a\n", "keep.txt": "keep\n" });
  const b = makeRemote(fx, "lib-b", { "b.txt": "b\n" });
  const w = makeRemote(fx, "umbrella.wiki", { "Home.md": "home\n" });
  const u = makeUmbrella(
    fx,
    { "mods/a": a.head, "dup/a": a.head, "mods/b": b.head, wiki: w.head },
    gitmodulesText([
      ["a", "mods/a", `https://${HOST}/${OWNER}/lib-a.git`],
      ["a2", "dup/a", "../lib-a"],
      ["b", "mods/b", "../lib-b"],
      ["wiki", "wiki", "../umbrella.wiki"],
    ]),
  );
  const session = ledger.createMetaSession({ objective: "o", repoRoot: u.dir, projectId: "web" });
  const run = ledger.createRun({
    metaSessionId: session.id,
    state: opts.state ?? "RUNNING",
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
    workspace: u.dir,
    trustProfile: "edit-untrusted",
  });
  if (ws.mode !== "worktree") throw new Error("expected a worktree");
  const manifest = await readSubmoduleManifest(u.dir, u.head, {
    sources: () => fx.settings,
    umbrella: { host: HOST, owner: OWNER, repo: "umbrella" },
    exclude: [],
    writable: opts.writable ?? ["mods/a", "wiki"],
  });
  const prepared = await prepareStores(manifest, undefined, { settings: fx.settings, git: fx.runner });
  const stores = new Map(prepared.map((p) => [p.key, p.path as string]));
  const rec = await attachSubmodules(ws.worktreePath, manifest, { storeFor: (k) => stores.get(k) as string });
  await writeAttachRecord(attachRecordFile(ws.worktreePath), rec);
  return { sessionId: session.id, runId: run.id, wt: ws.worktreePath, umbrella: u.dir, rec, stores, a, b };
}

function publisher(extra: Partial<GitPublisherOptions> = {}): GitPublisher {
  return new GitPublisher({
    db,
    scratchDir: scratch,
    now: () => NOW,
    submoduleCloneRoot: fx.settings.cloneRoot,
    ...extra,
  });
}

function input(runId: string, extra: Partial<CommitInput> = {}): CommitInput {
  return { runId, message: "Change things", identity: IDENTITY, projectId: "web", contextId: "main", ...extra };
}

/** The gitlink of `p` in `commit` (undefined when it is not a gitlink there). */
function gitlink(repo: string, commit: string, p: string): string | undefined {
  const line = g(repo, "ls-tree", commit, "--", p);
  const m = /^160000 commit ([0-9a-f]{40})\t/u.exec(line);
  return m?.[1];
}

function refSha(cwd: string, ref: string): string {
  try {
    return g(cwd, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return "";
  }
}

async function expectCode(p: Promise<unknown>, code: string): Promise<CommitError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(CommitError);
    expect((err as CommitError).code).toBe(code);
    return err as CommitError;
  }
  throw new Error(`expected ${code}`);
}

const write = (s: Setup, rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(s.wt, rel)), { recursive: true });
  writeFileSync(path.join(s.wt, rel), text);
};

describe("commit tool: all changes (ADR-0079 item 4)", () => {
  it("commits a changed writable submodule in its store, bumps every path of the repository and records it", async () => {
    const s = await setup({ writable: ["mods/a", "dup/a"] });
    const storeA = s.stores.get(KEY_A) as string;
    write(s, "README.md", "umbrella changed\n");
    write(s, "mods/a/a.txt", "A\n");
    write(s, "mods/b/b.txt", "B\n"); // read-only
    write(s, "wiki/Home.md", "edited\n"); // a wiki is never writable

    const r = await publisher().commit(input(s.runId));

    const pubRef = publishRefFor(s.sessionId);
    expect(refSha(s.umbrella, pubRef)).toBe(r.sha);
    expect(r.submodules).toHaveLength(1);
    const made = r.submodules?.[0];
    expect(made).toMatchObject({ paths: ["dup/a", "mods/a"], repo: KEY_A, parentSha: s.a.head });
    const subSha = made?.commitSha as string;
    // Both paths of the repository point at the new commit; read-only paths keep their gitlinks.
    expect(gitlink(s.umbrella, r.sha, "mods/a")).toBe(subSha);
    expect(gitlink(s.umbrella, r.sha, "dup/a")).toBe(subSha);
    expect(gitlink(s.umbrella, r.sha, "mods/b")).toBe(s.b.head);
    expect(r.submodulesSkipped).toEqual([
      { path: "mods/b", reason: "read_only" },
      { path: "wiki", reason: "read_only" },
    ]);
    expect(g(s.umbrella, "show", `${r.sha}:README.md`)).toBe("umbrella changed");
    expect(r.filesChanged).toBe(3); // README.md and the two gitlinks
    // The submodule commit lives in the store, kept by the store's publish ref, with the context identity.
    expect(refSha(storeA, pubRef)).toBe(subSha);
    expect(g(storeA, "show", `${subSha}:a.txt`)).toBe("A");
    expect(g(storeA, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%s|%P", subSha)).toBe(
      `Ada Maintainer <ada@example.test>|Ada Maintainer <ada@example.test>|Change things|${s.a.head}`,
    );
    // The unchanged duplicate was moved to the new commit.
    expect(readFileSync(path.join(s.wt, "dup/a/a.txt"), "utf8")).toBe("A\n");
    expect(g(path.join(s.wt, "dup/a"), "rev-parse", "HEAD")).toBe(subSha);
    // One submodule_commit row in the transaction of the umbrella git_commit row; the event names it.
    const rows = listSubmoduleCommitsForUmbrella(db, r.sha);
    expect(rows.map((x) => [x.repo, submoduleCommitPaths(x), x.parent_sha, x.commit_sha, x.run_id])).toEqual([
      [KEY_A, ["dup/a", "mods/a"], s.a.head, subSha, s.runId],
    ]);
    const ev = ledger.listRunEvents(s.runId).find((e) => e.type === "git_commit");
    expect(JSON.parse(ev?.payload_json ?? "{}").submodules).toEqual([
      { repo: KEY_A, paths: ["dup/a", "mods/a"], commit_sha: subSha },
    ]);
  });

  it("parents the next commit on the session's previous submodule commit and skips an unchanged tree", async () => {
    const s = await setup();
    write(s, "mods/a/a.txt", "A1\n");
    const first = await publisher().commit(input(s.runId));
    const c1 = first.submodules?.[0]?.commitSha as string;
    // A submodule-only change: the gitlinks of both paths of the repository (dup/a is a read-only duplicate).
    expect(first.filesChanged).toBe(2);

    write(s, "mods/a/a.txt", "A2\n");
    const second = await publisher().commit(input(s.runId, { message: "More" }));
    expect(second.submodules?.[0]).toMatchObject({ repo: KEY_A, parentSha: c1 });
    const c2 = second.submodules?.[0]?.commitSha as string;
    expect(gitlink(s.umbrella, second.sha, "mods/a")).toBe(c2);

    // The worktree still sits on the attach commit (HEAD never moves), but its tree equals c2's: skipped.
    write(s, "README.md", "only the umbrella\n");
    const third = await publisher().commit(input(s.runId, { message: "Umbrella only" }));
    expect(third.submodules).toEqual([]);
    expect(gitlink(s.umbrella, third.sha, "mods/a")).toBe(c2);
  });

  it("never records a submodule HEAD the agent moved: the controller commits the tree as its own commit", async () => {
    const s = await setup();
    const sub = path.join(s.wt, "mods/a");
    write(s, "mods/a/a.txt", "agent\n");
    g(sub, "add", "-A");
    g(sub, "commit", "-q", "-m", "agent commit");
    const agentSha = g(sub, "rev-parse", "HEAD");
    const r = await publisher().commit(input(s.runId));
    const made = r.submodules?.[0]?.commitSha as string;
    expect(made).not.toBe(agentSha);
    expect(gitlink(s.umbrella, r.sha, "mods/a")).toBe(made);
    expect(g(s.stores.get(KEY_A) as string, "log", "-1", "--format=%P", made)).toBe(s.a.head);
    // An umbrella-only commit afterwards still never takes the moved HEAD of an unchanged path.
    write(s, "README.md", "x\n");
    const next = await publisher().commit(input(s.runId, { message: "x" }));
    expect(gitlink(s.umbrella, next.sha, "mods/a")).toBe(made);
  });

  it("refuses two duplicate paths changed differently (submodule_duplicate_diverged); nothing is published", async () => {
    const s = await setup({ writable: ["mods/a", "dup/a"] });
    write(s, "mods/a/a.txt", "one\n");
    write(s, "dup/a/a.txt", "two\n");
    const err = await expectCode(publisher().commit(input(s.runId)), "PATH_REFUSED");
    expect(err.refused).toEqual([
      { path: "dup/a", reason: "submodule_duplicate_diverged" },
      { path: "mods/a", reason: "submodule_duplicate_diverged" },
    ]);
    expect(refSha(s.umbrella, publishRefFor(s.sessionId))).toBe("");
    expect(refSha(s.stores.get(KEY_A) as string, publishRefFor(s.sessionId))).toBe("");
  });

  it("does not use a submodule whose .git link was tampered with (link_invalid); its gitlink stays", async () => {
    const s = await setup();
    write(s, "mods/a/a.txt", "A\n");
    const elsewhere = path.join(fx.root, "elsewhere");
    g(fx.root, "init", "-q", elsewhere);
    writeFileSync(path.join(s.wt, "mods/a/.git"), `gitdir: ${path.join(elsewhere, ".git")}\n`);
    write(s, "README.md", "x\n");
    const r = await publisher().commit(input(s.runId));
    expect(r.submodules).toEqual([]);
    expect(r.submodulesSkipped).toContainEqual({ path: "mods/a", reason: "link_invalid" });
    expect(gitlink(s.umbrella, r.sha, "mods/a")).toBe(s.a.head);
  });

  it("a removed .git link does not turn the submodule into plain umbrella files", async () => {
    const s = await setup();
    rmSync(path.join(s.wt, "mods/a/.git"));
    write(s, "mods/a/a.txt", "A\n");
    write(s, "README.md", "x\n");
    const r = await publisher().commit(input(s.runId));
    expect(r.submodulesSkipped).toContainEqual({ path: "mods/a", reason: "link_invalid" });
    expect(gitlink(s.umbrella, r.sha, "mods/a")).toBe(s.a.head);
    expect(g(s.umbrella, "ls-tree", "-r", "--name-only", r.sha)).not.toMatch(/mods\/a\//u);
  });

  it("refuses NOTHING_TO_COMMIT when neither the umbrella nor a writable submodule changed", async () => {
    const s = await setup();
    write(s, "mods/b/b.txt", "B\n"); // read-only only
    await expectCode(publisher().commit(input(s.runId)), "NOTHING_TO_COMMIT");
  });

  it("refuses an attach record when the publisher has no clone root, and a record of another worktree", async () => {
    const s = await setup();
    write(s, "mods/a/a.txt", "A\n");
    const noRoot = new GitPublisher({ db, scratchDir: scratch, now: () => NOW });
    await expectCode(noRoot.commit(input(s.runId)), "GIT_FAILED");
    writeFileSync(attachRecordFile(s.wt), JSON.stringify({ ...s.rec, worktree: path.join(fx.root, "other") }));
    await expectCode(publisher().commit(input(s.runId)), "GIT_FAILED");
    expect(refSha(s.umbrella, publishRefFor(s.sessionId))).toBe("");
  });
});

describe("commit tool: explicit paths (ADR-0079 item 4)", () => {
  it("commits an explicit path inside a writable submodule in that submodule only", async () => {
    const s = await setup();
    write(s, "mods/a/a.txt", "A\n");
    write(s, "mods/a/keep.txt", "not this\n");
    write(s, "README.md", "not this either\n");
    const r = await publisher().commit(input(s.runId, { paths: ["mods/a/a.txt"] }));
    const sub = r.submodules?.[0]?.commitSha as string;
    const storeA = s.stores.get(KEY_A) as string;
    expect(g(storeA, "show", `${sub}:a.txt`)).toBe("A");
    expect(g(storeA, "show", `${sub}:keep.txt`)).toBe("keep");
    expect(g(s.umbrella, "show", `${r.sha}:README.md`)).toBe("umbrella");
    expect(r.filesChanged).toBe(2); // the gitlinks of mods/a and its duplicate dup/a
  });

  it("commits a whole submodule when its root is named, alongside an umbrella path", async () => {
    const s = await setup();
    write(s, "mods/a/a.txt", "A\n");
    write(s, "mods/a/new.txt", "new\n");
    write(s, "README.md", "changed\n");
    const r = await publisher().commit(input(s.runId, { paths: ["mods/a", "README.md"] }));
    const sub = r.submodules?.[0]?.commitSha as string;
    expect(g(s.stores.get(KEY_A) as string, "show", `${sub}:new.txt`)).toBe("new");
    expect(g(s.umbrella, "show", `${r.sha}:README.md`)).toBe("changed");
  });

  it("refuses a path inside a read-only submodule or a wiki (submodule_read_only)", async () => {
    const s = await setup();
    write(s, "mods/b/b.txt", "B\n");
    write(s, "wiki/Home.md", "W\n");
    const err = await expectCode(
      publisher().commit(input(s.runId, { paths: ["mods/b/b.txt", "wiki"] })),
      "PATH_REFUSED",
    );
    expect(err.refused).toEqual([
      { path: "mods/b/b.txt", reason: "submodule_read_only" },
      { path: "wiki", reason: "submodule_read_only" },
    ]);
  });

  it("refuses a missing path inside a submodule, a path in a tampered submodule, and still refuses a parent directory", async () => {
    const s = await setup();
    write(s, "mods/a/a.txt", "A\n");
    let err = await expectCode(publisher().commit(input(s.runId, { paths: ["mods/a/nope.txt"] })), "PATH_REFUSED");
    expect(err.refused).toEqual([{ path: "mods/a/nope.txt", reason: "missing" }]);
    err = await expectCode(publisher().commit(input(s.runId, { paths: ["mods"] })), "PATH_REFUSED");
    expect(err.refused).toEqual([{ path: "mods", reason: "contains_nested_repository" }]);
    writeFileSync(path.join(s.wt, "mods/a/.git"), "gitdir: /nowhere\n");
    err = await expectCode(publisher().commit(input(s.runId, { paths: ["mods/a/a.txt"] })), "PATH_REFUSED");
    expect(err.refused).toEqual([{ path: "mods/a/a.txt", reason: "submodule_link_invalid" }]);
  });
});

describe("crash recovery (ADR-0025) with submodule commits", () => {
  it("rolls forward the git_commit row and its submodule_commit rows", async () => {
    const s = await setup();
    write(s, "mods/a/a.txt", "A\n");
    const crashing = publisher({
      testHooks: {
        afterStep: (step) => {
          if (step === "ref_updated") throw new Error("crash");
        },
      },
    });
    await expect(crashing.commit(input(s.runId))).rejects.toThrow("crash");
    const sha = refSha(s.umbrella, publishRefFor(s.sessionId));
    expect(listSubmoduleCommitsForUmbrella(db, sha)).toEqual([]);
    const report = await publisher().recover();
    expect(report.rolledForward).toEqual([sha]);
    const rows = listSubmoduleCommitsForUmbrella(db, sha);
    expect(rows.map((r) => r.repo)).toEqual([KEY_A]);
    expect(rows[0]?.commit_sha).toBe(gitlink(s.umbrella, sha, "mods/a"));
  });
});

describe.skipIf(!gpgAvailable())("signing (T9.10) of submodule commits", () => {
  it("signs the submodule commit the same way as the umbrella commit", async () => {
    const signer = createThrowawaySigner();
    try {
      const s = await setup();
      write(s, "mods/a/a.txt", "A\n");
      const r = await publisher({ signingEnv: signer.env }).commit(input(s.runId, { sign: { reach: { ok: true } } }));
      const sub = r.submodules?.[0]?.commitSha as string;
      const storeA = s.stores.get(KEY_A) as string;
      execFileSync("git", ["verify-commit", r.sha], { cwd: s.umbrella, env: signer.verifyEnv, stdio: "ignore" });
      execFileSync("git", ["verify-commit", sub], { cwd: storeA, env: signer.verifyEnv, stdio: "ignore" });
    } finally {
      signer.dispose();
    }
  });
});

describe("finalize_commit (T9.7) with submodules", () => {
  const project = {
    id: "web",
    context_id: "main",
    environment_kind: "host",
    writable: true,
    identity: IDENTITY,
    finalize_commit: true,
  } as unknown as Parameters<typeof makeFinalizeCommit>[1]["project"];

  const request = (runId: string, changedPaths: string[]) => ({
    runId,
    project,
    succeeded: true,
    gitPolicyViolation: false,
    changedPaths,
    summary: "Finalize things",
    nativeSessionIds: [],
    finalizingEventId: undefined,
  });

  it("commits submodule changes when the run changed no umbrella path", async () => {
    const s = await setup({ state: "FINALIZING" });
    write(s, "mods/a/a.txt", "A\n");
    const out = await makeFinalizeCommit(publisher({ allowedStates: ["FINALIZING"] }), request(s.runId, []));
    expect(out).toMatchObject({ outcome: "committed", filesChanged: 2, submoduleCommits: 1 });
    const sha = refSha(s.umbrella, publishRefFor(s.sessionId));
    expect(listSubmoduleCommitsForUmbrella(db, sha).map((r) => r.repo)).toEqual([KEY_A]);
  });

  it("takes every writable submodule and reports (not refuses) a changed path in a read-only one", async () => {
    const s = await setup({ state: "FINALIZING" });
    write(s, "mods/a/a.txt", "A\n");
    write(s, "README.md", "changed\n");
    const out = await makeFinalizeCommit(
      publisher({ allowedStates: ["FINALIZING"] }),
      request(s.runId, ["README.md", "mods/b"]),
    );
    expect(out).toMatchObject({ outcome: "committed", filesChanged: 3, submoduleCommits: 1, submodulesSkipped: 1 });
  });

  it("still skips no_changes without an attach record", async () => {
    const s = await setup({ state: "FINALIZING" });
    rmSync(attachRecordFile(s.wt));
    const out = await makeFinalizeCommit(publisher({ allowedStates: ["FINALIZING"] }), request(s.runId, []));
    expect(out).toEqual({ outcome: "skipped", reason: "no_changes" });
    expect(existsSync(attachRecordFile(s.wt))).toBe(false);
  });
});

describe("store keys", () => {
  it("B is not touched by a commit of A", async () => {
    const s = await setup();
    write(s, "mods/a/a.txt", "A\n");
    await publisher().commit(input(s.runId));
    expect(refSha(s.stores.get(KEY_B) as string, publishRefFor(s.sessionId))).toBe("");
  });
});
