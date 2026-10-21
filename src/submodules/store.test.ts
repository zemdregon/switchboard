/**
 * ADR-0080 item 3: shared object stores. Git runs for real against local "remote" repositories; the fixture runner maps
 * the https URLs to them with command-scope `insteadOf`, so the production argv stays https only and nothing leaves
 * the host. Runner calls are counted to show that a fetch happens only for a missing commit.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloneError, type GitRunner } from "../projects/clone.js";
import {
  commitFiles,
  type Fixture,
  g,
  gitmodulesText,
  HOST,
  makeFixture,
  makeRemote,
  makeUmbrella,
  OWNER,
} from "./fixtures/repos.js";
import { readSubmoduleManifest } from "./manifest.js";
import {
  defaultBranchOf,
  ensureCommits,
  ensureStore,
  FETCHED_COMMIT_REF_PREFIX,
  mapBounded,
  prepareStores,
  STORE_FETCH_CONFIG,
  storePath,
} from "./store.js";

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture("sb-sub-store-");
});
afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

const src = (repo: string) => ({ host: HOST, owner: OWNER, repo });
const fetches = () => fx.calls.filter((c) => c.includes("fetch"));
const deps = () => ({ settings: fx.settings, git: fx.runner });

describe("ensureStore", () => {
  it("clones once with --no-checkout and https-only hardening, then reuses without any network call", async () => {
    makeRemote(fx, "lib-a", { "a.txt": "a\n" });
    const first = await ensureStore(src("lib-a"), deps());
    expect(first.outcome).toBe("cloned");
    expect(first.path).toBe(storePath(src("lib-a"), fx.settings));
    expect(first.path).toBe(path.join(fx.settings.cloneRoot, HOST, "acme", "lib-a"));
    expect(readdirSync(first.path)).toEqual([".git"]); // no checkout
    expect(g(first.path, "config", "--get", "remote.origin.url")).toBe(`https://${HOST}/${OWNER}/lib-a.git`);

    const clone = fx.calls.find((c) => c.includes("clone")) as string[];
    expect(clone).toEqual(
      expect.arrayContaining([
        "--no-checkout",
        "--no-recurse-submodules",
        "protocol.allow=never",
        "protocol.https.allow=always",
        "submodule.recurse=false",
        "fetch.recurseSubmodules=false",
        "core.hooksPath=/dev/null",
      ]),
    );
    expect(clone.join(" ")).not.toMatch(/protocol\.(file|ssh|ext)\.allow/u);

    const n = fx.calls.length;
    const again = await ensureStore(src("lib-a"), deps());
    expect(again).toEqual({ path: first.path, outcome: "reused" });
    expect(fx.calls.slice(n).filter((c) => c.includes("fetch") || c.includes("clone"))).toEqual([]);
  });

  it("refuses a source that is no longer in project_sources", async () => {
    const err = await ensureStore({ host: HOST, owner: "other", repo: "x" }, deps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloneError);
    expect((err as CloneError).reason).toBe("CLONE_SOURCE_NOT_ALLOWED");
    expect(fx.calls).toEqual([]);
  });
});

describe("ensureCommits", () => {
  it("fetches only when a commit is missing: branches first, then the commit by id; a second run fetches nothing", async () => {
    const remote = makeRemote(fx, "lib-a");
    const store = (await ensureStore(src("lib-a"), deps())).path;

    // Present at clone time: no network call.
    let n = fx.calls.length;
    expect(await ensureCommits(store, [remote.head], { git: fx.runner })).toEqual({
      present: [remote.head],
      fetched: [],
      missing: [],
    });
    expect(fx.calls.length).toBe(n);

    // A new commit on a branch: one branch fetch is enough.
    const onBranch = commitFiles(remote.dir, { "b.txt": "b\n" }, "second");
    // A commit no branch reaches (only by id).
    g(remote.dir, "checkout", "-q", "--detach");
    const hidden = commitFiles(remote.dir, { "h.txt": "h\n" }, "hidden");
    g(remote.dir, "update-ref", "refs/hidden/x", hidden);
    g(remote.dir, "checkout", "-q", "main");
    const unknown = "f".repeat(40);

    n = fx.calls.length;
    const r = await ensureCommits(store, [remote.head, onBranch, hidden, unknown, "not-a-sha"], {
      git: fx.runner,
      key: "github.test/acme/lib-a",
    });
    expect(r).toEqual({ present: [remote.head], fetched: [onBranch, hidden], missing: [unknown, "not-a-sha"] });
    const made = fx.calls.slice(n);
    expect(made).toHaveLength(3); // branches, then hidden by id, then unknown by id
    expect(made[0]).toEqual([
      ...STORE_FETCH_CONFIG,
      ...fetchFlags(),
      "--",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    expect(made[1]?.at(-1)).toBe(`${hidden}:${FETCHED_COMMIT_REF_PREFIX}${hidden}`);
    expect(made[2]?.at(-1)).toBe(`${unknown}:${FETCHED_COMMIT_REF_PREFIX}${unknown}`);
    for (const c of made) {
      expect(c).toEqual(expect.arrayContaining(["protocol.allow=never", "protocol.https.allow=always"]));
      expect(c.join(" ")).not.toMatch(/protocol\.(file|ssh)\.allow/u);
    }
    expect(g(store, "rev-parse", `${FETCHED_COMMIT_REF_PREFIX}${hidden}`)).toBe(hidden);

    // Cache: the second run makes no network call.
    n = fx.calls.length;
    expect((await ensureCommits(store, [remote.head, onBranch, hidden], { git: fx.runner })).fetched).toEqual([]);
    expect(fx.calls.length).toBe(n);
  });

  it("never fetches when the store's own configuration is unsafe or its origin is not its https source", async () => {
    makeRemote(fx, "lib-a");
    const store = (await ensureStore(src("lib-a"), deps())).path;
    const missing = "e".repeat(40);
    g(store, "config", "credential.helper", "!echo evil");
    let n = fx.calls.length;
    expect((await ensureCommits(store, [missing], { git: fx.runner })).missing).toEqual([missing]);
    expect(fx.calls.length).toBe(n);
    g(store, "config", "--unset", "credential.helper");

    g(store, "remote", "set-url", "origin", "file:///somewhere/else");
    n = fx.calls.length;
    expect((await ensureCommits(store, [missing], { git: fx.runner })).missing).toEqual([missing]);
    expect(fx.calls.length).toBe(n);

    g(store, "remote", "set-url", "origin", `https://${HOST}/${OWNER}/other.git`);
    expect((await ensureCommits(store, [missing], { git: fx.runner, key: "github.test/acme/lib-a" })).missing).toEqual([
      missing,
    ]);
    expect(fx.calls.length).toBe(n);
  });

  it("serialises fetches into one store", async () => {
    makeRemote(fx, "lib-a");
    const store = (await ensureStore(src("lib-a"), deps())).path;
    let inFlight = 0;
    let max = 0;
    const slow: GitRunner = async (args, opts) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      const res = await fx.runner(args, opts);
      inFlight--;
      return res;
    };
    await Promise.all([1, 2, 3].map((i) => ensureCommits(store, [String(i).repeat(40)], { git: slow })));
    expect(max).toBe(1);
  });

  it("returns every commit as missing for a store that does not exist", async () => {
    const sha = "a".repeat(40);
    expect(await ensureCommits(path.join(fx.root, "nope"), [sha], { git: fx.runner })).toEqual({
      present: [],
      fetched: [],
      missing: [sha],
    });
    expect(fx.calls).toEqual([]);
  });
});

describe("defaultBranchOf", () => {
  it("reads origin/HEAD set by the clone, and runs remote set-head once when it is absent", async () => {
    makeRemote(fx, "lib-a");
    makeRemote(fx, "lib-m", undefined, { branch: "master" });
    const a = (await ensureStore(src("lib-a"), deps())).path;
    const m = (await ensureStore(src("lib-m"), deps())).path;
    let n = fx.calls.length;
    expect(await defaultBranchOf(a, { git: fx.runner })).toBe("main");
    expect(await defaultBranchOf(m, { git: fx.runner })).toBe("master");
    expect(fx.calls.length).toBe(n);

    g(m, "remote", "set-head", "origin", "--delete");
    n = fx.calls.length;
    expect(await defaultBranchOf(m, { git: fx.runner })).toBe("master");
    expect(fx.calls.slice(n).map((c) => c.slice(STORE_FETCH_CONFIG.length))).toEqual([
      ["remote", "set-head", "origin", "--auto"],
    ]);
  });
});

describe("mapBounded", () => {
  it("keeps order, bounds concurrency and rethrows the first failure after every item ran", async () => {
    let inFlight = 0;
    let max = 0;
    const out = await mapBounded([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(max).toBe(3);
    const seen: number[] = [];
    await expect(
      mapBounded([1, 2, 3], 2, async (x) => {
        seen.push(x);
        if (x === 1) throw new Error("one");
        return x;
      }),
    ).rejects.toThrow("one");
    expect(seen.sort()).toEqual([1, 2, 3]);
    expect(await mapBounded([], 8, async (x: number) => x)).toEqual([]);
  });
});

describe("prepareStores", () => {
  it("makes one store per repository (duplicate-URL paths share it) and reports missing commits per key", async () => {
    const a = makeRemote(fx, "lib-a");
    const b = makeRemote(fx, "lib-b");
    const ghost = "d".repeat(40);
    const u = makeUmbrella(
      fx,
      { "x/a": a.head, "y/a": a.head, b: b.head, c: ghost },
      gitmodulesText([
        ["xa", "x/a", `https://${HOST}/${OWNER}/lib-a.git`],
        ["ya", "y/a", "../lib-a"],
        ["b", "b", "../lib-b.git"],
        ["c", "c", "../lib-c"],
      ]),
    );
    const manifest = await readSubmoduleManifest(u.dir, u.head, {
      sources: () => fx.settings,
      umbrella: { host: HOST, owner: OWNER, repo: "umbrella" },
      exclude: [],
      writable: [],
    });
    const res = await prepareStores(manifest, undefined, { ...deps(), concurrency: 2 });
    // In manifest.byKey order (first path of each key: b, c, x/a).
    expect(res.map((r) => [r.key, r.outcome, r.present, r.missing])).toEqual([
      ["github.test/acme/lib-b", "cloned", [b.head], []],
      ["github.test/acme/lib-c", "failed", [], [ghost]],
      ["github.test/acme/lib-a", "cloned", [a.head], []],
    ]);
    expect(res[1]?.reason).toBe("CLONE_FAILED");
    expect(fx.calls.filter((c) => c.includes("clone"))).toHaveLength(3);
    expect(existsSync(path.join(fx.settings.cloneRoot, HOST, "acme", "lib-c"))).toBe(false);

    // Warm cache: nothing cloned or fetched for the present stores.
    const n = fetches().length;
    const again = await prepareStores(manifest, new Map([["github.test/acme/lib-c", []]]), deps());
    expect(again.map((r) => r.outcome)).toEqual(["reused", "failed", "reused"]);
    expect(fetches().length).toBe(n);
  });
});

function fetchFlags(): string[] {
  return ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--no-auto-maintenance"];
}
