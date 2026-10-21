/**
 * ADR-0080 item 3 "Checkpoints": a run checkpoint also checkpoints each changed writable submodule worktree in its
 * store and records the new gitlink in the umbrella checkpoint; read-only changes are not carried. The umbrella side
 * is driven here as `WorkspaceManager.finalize` would (add, gitlinks, commit), with plain local fixture repositories.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdGenerator } from "../ids/index.js";
import { git } from "../workspace/git.js";
import { findNestedRepositories, nestedPathspecArgs } from "../workspace/nested.js";
import {
  applyCheckpointGitlinks,
  checkpointSkippedEventPayload,
  checkpointSubmodules,
  SUBMODULE_CHECKPOINT_REF_PREFIX,
} from "./checkpoint.js";
import {
  type Fixture,
  g,
  gitmodulesText,
  HOST,
  makeFixture,
  makeRemote,
  makeUmbrella,
  OWNER,
} from "./fixtures/repos.js";
import { readSubmoduleManifest, type SubmoduleManifest } from "./manifest.js";
import { prepareStores } from "./store.js";
import { type AttachRecord, attachSubmodules } from "./worktree.js";

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture("sb-sub-ckpt-");
});
afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

const runId = () => createIdGenerator().id("run");

interface Setup {
  umbrella: string;
  head: string;
  wt: string;
  rec: AttachRecord;
  stores: Map<string, string>;
  manifestFor(commit: string): Promise<SubmoduleManifest>;
  a: { head: string };
  b: { head: string };
}

async function setup(): Promise<Setup> {
  const a = makeRemote(fx, "lib-a", { "a.txt": "a\n" });
  const b = makeRemote(fx, "lib-b", { "b.txt": "b\n" });
  const u = makeUmbrella(
    fx,
    { "mods/a": a.head, "mods/b": b.head },
    gitmodulesText([
      ["a", "mods/a", `https://${HOST}/${OWNER}/lib-a.git`],
      ["b", "mods/b", "../lib-b"],
    ]),
  );
  const manifestFor = (commit: string) =>
    readSubmoduleManifest(u.dir, commit, {
      sources: () => fx.settings,
      umbrella: { host: HOST, owner: OWNER, repo: "umbrella" },
      exclude: [],
      writable: ["mods/a"],
    });
  const manifest = await manifestFor(u.head);
  const prepared = await prepareStores(manifest, undefined, { settings: fx.settings, git: fx.runner });
  const stores = new Map(prepared.map((p) => [p.key, p.path as string]));
  const wt = path.join(fx.root, "data", "run-1");
  mkdirSync(path.dirname(wt), { recursive: true });
  g(u.dir, "worktree", "add", "-q", "-b", "switchboard/run-1", wt, u.head);
  const rec = await attachSubmodules(wt, manifest, { storeFor: (k) => stores.get(k) as string });
  return { umbrella: u.dir, head: u.head, wt, rec, stores, manifestFor, a, b };
}

/** The umbrella side of `WorkspaceManager.finalize` with the submodule steps wired in. Returns the new HEAD. */
async function umbrellaCheckpoint(wt: string, gitlinks: ReadonlyMap<string, string>): Promise<string> {
  const scope = nestedPathspecArgs(await findNestedRepositories(wt));
  await git(["add", "-A", ...scope], { cwd: wt });
  await applyCheckpointGitlinks(wt, gitlinks);
  await git(["commit", "--no-verify", "--no-gpg-sign", "--allow-empty", "-m", "switchboard: checkpoint"], { cwd: wt });
  return g(wt, "rev-parse", "HEAD");
}

const gitlinkOf = (repo: string, commit: string, p: string) =>
  /^160000 commit ([0-9a-f]{40})\t/u.exec(g(repo, "ls-tree", commit, "--", p))?.[1];

describe("checkpointSubmodules", () => {
  it("checkpoints a changed writable submodule in its store and records its gitlink in the umbrella checkpoint", async () => {
    const s = await setup();
    const id = runId();
    const storeA = s.stores.get("github.test/acme/lib-a") as string;
    writeFileSync(path.join(s.wt, "mods/a/a.txt"), "A\n");
    writeFileSync(path.join(s.wt, "mods/a/new.txt"), "new\n");
    writeFileSync(path.join(s.wt, "mods/b/b.txt"), "B\n"); // read-only: not carried
    writeFileSync(path.join(s.wt, "README.md"), "umbrella edit\n");

    const res = await checkpointSubmodules({ runId: id, runWorktree: s.wt, record: s.rec, umbrellaHead: s.head });
    expect(res.checkpoints).toHaveLength(1);
    const ck = res.checkpoints[0] as (typeof res.checkpoints)[number];
    expect(ck).toMatchObject({ path: "mods/a", key: "github.test/acme/lib-a", parentSha: s.a.head });
    expect(ck.ref).toBe(`${SUBMODULE_CHECKPOINT_REF_PREFIX}${id}/${ck.commitSha}`);
    expect(g(storeA, "rev-parse", ck.ref)).toBe(ck.commitSha);
    expect(g(storeA, "log", "-1", "--format=%an <%ae>|%P", ck.commitSha)).toBe(
      `Switchboard <switchboard@localhost>|${s.a.head}`,
    );
    expect(g(storeA, "show", `${ck.commitSha}:new.txt`)).toBe("new");
    // The submodule worktree now sits on its checkpoint, clean, with the files untouched.
    expect(g(path.join(s.wt, "mods/a"), "rev-parse", "HEAD")).toBe(ck.commitSha);
    expect(g(path.join(s.wt, "mods/a"), "status", "--porcelain")).toBe("");
    expect(readFileSync(path.join(s.wt, "mods/a/a.txt"), "utf8")).toBe("A\n");
    expect([...res.gitlinks]).toEqual([["mods/a", ck.commitSha]]);
    expect(res.skipped).toEqual([{ path: "mods/b", reason: "read_only" }]);
    expect(checkpointSkippedEventPayload(res)).toEqual({
      stage: "checkpoint",
      paths: [{ path: "mods/b", reason: "read_only" }],
    });

    const post = await umbrellaCheckpoint(s.wt, res.gitlinks);
    expect(gitlinkOf(s.umbrella, post, "mods/a")).toBe(ck.commitSha);
    expect(gitlinkOf(s.umbrella, post, "mods/b")).toBe(s.b.head);
    expect(g(s.umbrella, "show", `${post}:README.md`)).toBe("umbrella edit");

    // A continued meta-session starts from the umbrella checkpoint: its submodule worktree has the edits.
    const next = path.join(fx.root, "data", "run-2");
    g(s.umbrella, "worktree", "add", "-q", "--detach", next, post);
    const rec2 = await attachSubmodules(next, await s.manifestFor(post), {
      storeFor: (k) => s.stores.get(k) as string,
    });
    expect(rec2.entries.find((e) => e.path === "mods/a")?.sha).toBe(ck.commitSha);
    expect(readFileSync(path.join(next, "mods/a/new.txt"), "utf8")).toBe("new\n");
    expect(readFileSync(path.join(next, "mods/b/b.txt"), "utf8")).toBe("b\n");
  });

  it("records nothing for an unchanged submodule and a second checkpoint chains on the first", async () => {
    const s = await setup();
    const id = runId();
    const none = await checkpointSubmodules({ runId: id, runWorktree: s.wt, record: s.rec, umbrellaHead: s.head });
    expect(none).toEqual({ gitlinks: new Map(), checkpoints: [], skipped: [] });

    writeFileSync(path.join(s.wt, "mods/a/a.txt"), "1\n");
    const first = await checkpointSubmodules({ runId: id, runWorktree: s.wt, record: s.rec, umbrellaHead: s.head });
    const head1 = await umbrellaCheckpoint(s.wt, first.gitlinks);
    writeFileSync(path.join(s.wt, "mods/a/a.txt"), "2\n");
    const second = await checkpointSubmodules({ runId: id, runWorktree: s.wt, record: s.rec, umbrellaHead: head1 });
    expect(second.checkpoints[0]?.parentSha).toBe(first.checkpoints[0]?.commitSha);
    // Unchanged since the last checkpoint and already the umbrella's gitlink: nothing to record.
    const head2 = await umbrellaCheckpoint(s.wt, second.gitlinks);
    const third = await checkpointSubmodules({ runId: id, runWorktree: s.wt, record: s.rec, umbrellaHead: head2 });
    expect(third.gitlinks.size).toBe(0);
    expect(third.checkpoints).toEqual([]);
  });

  it("never uses a submodule whose .git link does not verify", async () => {
    const s = await setup();
    writeFileSync(path.join(s.wt, "mods/a/a.txt"), "A\n");
    writeFileSync(path.join(s.wt, "mods/a/.git"), "gitdir: /nowhere\n");
    const res = await checkpointSubmodules({ runId: runId(), runWorktree: s.wt, record: s.rec, umbrellaHead: s.head });
    expect(res.checkpoints).toEqual([]);
    expect(res.gitlinks.size).toBe(0);
    expect(res.skipped).toContainEqual({ path: "mods/a", reason: "link_invalid" });
  });

  it("refuses a run id that is not one (it becomes part of a ref name)", async () => {
    const s = await setup();
    await expect(
      checkpointSubmodules({ runId: "../x", runWorktree: s.wt, record: s.rec, umbrellaHead: s.head }),
    ).rejects.toThrow(/run id/u);
  });
});
