/**
 * ADR-0080 item 3: per-run submodule worktrees attached from shared stores, their `.git` link check, rollback, status,
 * tree writing and detach. Repository-configured filters and hooks in a store never run.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SubmoduleError } from "./errors.js";
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
import {
  type AttachRecord,
  attachSubmodules,
  detachSubmodules,
  parseStatusPaths,
  readAttachRecord,
  resetSubmodule,
  submoduleStatus,
  verifySubmoduleLink,
  writeAttachRecord,
  writeWorktreeTree,
} from "./worktree.js";

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture("sb-sub-wt-");
});
afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

interface Setup {
  manifest: SubmoduleManifest;
  stores: Map<string, string>;
  /** The umbrella's run worktree (a real `git worktree add`, so gitlink paths are empty directories). */
  wt: string;
  a: { dir: string; head: string };
  b: { dir: string; head: string };
}

async function setup(remoteFiles: Record<string, string> = { "a.txt": "a\n" }): Promise<Setup> {
  const a = makeRemote(fx, "lib-a", remoteFiles);
  const b = makeRemote(fx, "lib-b", { "b.txt": "b\n" });
  const u = makeUmbrella(
    fx,
    { "mods/a": a.head, "dup/a": a.head, "mods/b": b.head },
    gitmodulesText([
      ["a", "mods/a", `https://${HOST}/${OWNER}/lib-a.git`],
      ["a2", "dup/a", "../lib-a"],
      ["b", "mods/b", "../lib-b"],
    ]),
  );
  const manifest = await readSubmoduleManifest(u.dir, u.head, {
    sources: () => fx.settings,
    umbrella: { host: HOST, owner: OWNER, repo: "umbrella" },
    exclude: [],
    writable: ["mods/a", "mods/b"],
  });
  const prepared = await prepareStores(manifest, undefined, { settings: fx.settings, git: fx.runner });
  const stores = new Map(prepared.map((p) => [p.key, p.path as string]));
  const wt = path.join(fx.root, "data", "run-1");
  mkdirSync(path.dirname(wt), { recursive: true });
  g(u.dir, "worktree", "add", "-q", "--detach", wt, u.head);
  expect(readFileSync(path.join(wt, "README.md"), "utf8")).toBe("umbrella\n");
  return { manifest, stores, wt, a, b };
}

const storeFor = (s: Setup) => (key: string) => s.stores.get(key) as string;
const worktreeCount = (store: string) =>
  g(store, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length;

describe("attachSubmodules / detachSubmodules", () => {
  it("attaches each path from its shared store, records it, and detaches leaving no stale worktree", async () => {
    const s = await setup();
    const storeA = s.stores.get("github.test/acme/lib-a") as string;
    const rec = await attachSubmodules(s.wt, s.manifest, { storeFor: storeFor(s) });
    expect(rec.version).toBe(1);
    expect(rec.worktree).toBe(s.wt);
    expect(rec.entries.map((e) => [e.path, e.key, e.store, e.sha, e.writable, e.wiki])).toEqual([
      ["dup/a", "github.test/acme/lib-a", storeA, s.a.head, false, false],
      ["mods/a", "github.test/acme/lib-a", storeA, s.a.head, true, false],
      ["mods/b", "github.test/acme/lib-b", s.stores.get("github.test/acme/lib-b"), s.b.head, true, false],
    ]);
    // Duplicate-URL paths are two worktrees of one store.
    expect(worktreeCount(storeA)).toBe(3);
    for (const e of rec.entries) {
      expect(readFileSync(path.join(s.wt, e.path, e.key.endsWith("lib-a") ? "a.txt" : "b.txt"), "utf8")).toMatch(
        /^[ab]\n$/u,
      );
      expect(g(path.join(s.wt, e.path), "rev-parse", "HEAD")).toBe(e.sha);
      expect(await verifySubmoduleLink(s.wt, e)).toBe(true);
    }

    const file = path.join(fx.root, "data", "run-1.submodules.json");
    await writeAttachRecord(file, rec);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await readAttachRecord(file, fx.settings.cloneRoot)).toEqual(rec);

    const res = await detachSubmodules(rec);
    expect(res).toEqual({ removed: 3, unlinked: 0, missing: 0, pruneFailed: 0 });
    expect(worktreeCount(storeA)).toBe(1);
    expect(worktreeCount(s.stores.get("github.test/acme/lib-b") as string)).toBe(1);
    expect(existsSync(path.join(s.wt, "mods/a", "a.txt"))).toBe(false);
    // Detaching again is harmless.
    expect(await detachSubmodules(rec)).toEqual({ removed: 0, unlinked: 0, missing: 3, pruneFailed: 0 });
  });

  it("refuses a symlinked target, a symlinked ancestor and a non-empty directory, and rolls back what it attached", async () => {
    for (const plant of ["target-link", "ancestor-link", "non-empty"] as const) {
      const s = await setup();
      const storeA = s.stores.get("github.test/acme/lib-a") as string;
      const outside = path.join(fx.root, `outside-${plant}`);
      mkdirSync(outside);
      if (plant === "target-link") {
        rmSync(path.join(s.wt, "mods/b"), { recursive: true });
        symlinkSync(outside, path.join(s.wt, "mods/b"));
      } else if (plant === "ancestor-link") {
        rmSync(path.join(s.wt, "mods"), { recursive: true });
        symlinkSync(outside, path.join(s.wt, "mods"));
      } else {
        writeFileSync(path.join(s.wt, "mods/b", "planted"), "x");
      }
      const err = await attachSubmodules(s.wt, s.manifest, { storeFor: storeFor(s), concurrency: 1 }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SubmoduleError);
      expect((err as SubmoduleError).reason).toBe("SUBMODULE_PATH_UNSAFE");
      expect((err as SubmoduleError).path).toBe(plant === "ancestor-link" ? "mods/a" : "mods/b");
      expect(worktreeCount(storeA)).toBe(1);
      expect(existsSync(path.join(outside, "a.txt"))).toBe(false);
      expect(existsSync(path.join(outside, "b.txt"))).toBe(false);
      rmSync(fx.root, { recursive: true, force: true });
      fx = makeFixture("sb-sub-wt-");
    }
  });

  it("refuses a commit that is not in its store (attach never fetches)", async () => {
    const s = await setup();
    const ghost = {
      ...s.manifest,
      entries: [{ ...(s.manifest.entries[0] as SubmoduleManifest["entries"][number]), sha: "9".repeat(40) }],
    };
    const n = fx.calls.length;
    const err = await attachSubmodules(s.wt, ghost, { storeFor: storeFor(s) }).catch((e: unknown) => e);
    expect((err as SubmoduleError).reason).toBe("SUBMODULE_COMMIT_MISSING");
    expect((err as SubmoduleError).code).toBe("TOOL_FAILURE");
    expect(fx.calls.length).toBe(n);
  });
});

describe("repository filter drivers and hooks in a store (TDD §3.4)", () => {
  it("never runs the store's clean/smudge/process drivers or hooks on attach, status, tree writing or reset", async () => {
    const s = await setup({ ".gitattributes": "*.dat filter=evil\n*.proc filter=evilproc\n", "payload.dat": "raw\n" });
    const storeA = s.stores.get("github.test/acme/lib-a") as string;
    const log = path.join(fx.root, "canary.log");
    const script = (name: string, body: string) => {
      const p = path.join(fx.root, `${name}.sh`);
      writeFileSync(p, `#!/bin/sh\necho "${name} in $PWD" >> '${log}'\n${body}\n`);
      chmodSync(p, 0o755);
      return p;
    };
    g(storeA, "config", "filter.evil.clean", script("clean", "sed s/^/CLEANED-/"));
    g(storeA, "config", "filter.evil.smudge", script("smudge", "sed s/^/SMUDGED-/"));
    g(storeA, "config", "filter.evil.required", "true");
    g(storeA, "config", "filter.evilproc.process", script("process", "cat"));
    const hooks = path.join(fx.root, "hooks");
    mkdirSync(hooks);
    for (const h of ["post-checkout", "reference-transaction", "post-index-change"]) {
      script(`hook-${h}`, "exit 0");
      writeFileSync(path.join(hooks, h), `#!/bin/sh\necho "hook ${h}" >> '${log}'\n`);
      chmodSync(path.join(hooks, h), 0o755);
      writeFileSync(path.join(storeA, ".git", "hooks", h), `#!/bin/sh\necho "hook ${h}" >> '${log}'\n`);
      chmodSync(path.join(storeA, ".git", "hooks", h), 0o755);
    }
    g(storeA, "config", "core.hooksPath", hooks);
    const canary = () => (existsSync(log) ? readFileSync(log, "utf8") : "");

    const rec = await attachSubmodules(s.wt, s.manifest, { storeFor: storeFor(s) });
    const entry = rec.entries.find((e) => e.path === "mods/a") as AttachRecord["entries"][number];
    expect(canary()).toBe("");
    expect(readFileSync(path.join(s.wt, "mods/a", "payload.dat"), "utf8")).toBe("raw\n");

    writeFileSync(path.join(s.wt, "mods/a", "payload.dat"), "changed\n");
    writeFileSync(path.join(s.wt, "mods/a", "new.dat"), "new\n");
    expect((await submoduleStatus(s.wt, entry)).sort()).toEqual(["new.dat", "payload.dat"]);
    const tree = await writeWorktreeTree(s.wt, entry, entry.sha);
    expect(canary()).toBe("");
    expect(g(storeA, "cat-file", "blob", `${tree}:payload.dat`)).toBe("changed");
    expect(g(storeA, "cat-file", "blob", `${tree}:new.dat`)).toBe("new");
    // The worktree's own index was not touched by the tree write.
    expect(g(path.join(s.wt, "mods/a"), "diff", "--cached", "--name-only")).toBe("");

    await resetSubmodule(s.wt, entry, entry.sha);
    expect(canary()).toBe("");
    expect(readFileSync(path.join(s.wt, "mods/a", "payload.dat"), "utf8")).toBe("raw\n");
    expect(existsSync(path.join(s.wt, "mods/a", "new.dat"))).toBe(false);
    expect(await submoduleStatus(s.wt, entry)).toEqual([]);

    await detachSubmodules(rec);
    expect(canary()).toBe("");

    // Positive control: plain Git in the same store runs the smudge driver and the hook.
    const control = path.join(fx.root, "control");
    g(storeA, "worktree", "add", "-q", "--detach", control, s.a.head);
    expect(readFileSync(path.join(control, "payload.dat"), "utf8")).toBe("SMUDGED-raw\n");
    expect(canary()).toMatch(/smudge in/u);
    expect(canary()).toMatch(/hook post-checkout/u);
  });
});

describe("writeWorktreeTree with a path subset (ADR-0080 item 4)", () => {
  it("adds only the named paths and puts restored paths back to the parent's entries", async () => {
    const s = await setup({ "a.txt": "a\n", "keep.txt": "keep\n" });
    const storeA = s.stores.get("github.test/acme/lib-a") as string;
    const rec = await attachSubmodules(s.wt, s.manifest, { storeFor: storeFor(s) });
    const entry = rec.entries.find((e) => e.path === "mods/a") as AttachRecord["entries"][number];
    writeFileSync(path.join(s.wt, "mods/a", "a.txt"), "A\n");
    writeFileSync(path.join(s.wt, "mods/a", "keep.txt"), "changed\n");
    mkdirSync(path.join(s.wt, "mods/a", "skills"));
    writeFileSync(path.join(s.wt, "mods/a", "skills", "SKILL.md"), "skill\n");
    const tree = await writeWorktreeTree(s.wt, entry, entry.sha, {
      paths: ["a.txt", "skills"],
      restorePaths: ["skills/SKILL.md"],
    });
    expect(g(storeA, "cat-file", "blob", `${tree}:a.txt`)).toBe("A");
    expect(g(storeA, "cat-file", "blob", `${tree}:keep.txt`)).toBe("keep");
    expect(g(storeA, "ls-tree", "-r", "--name-only", tree)).not.toMatch(/SKILL/u);
  });
});

describe("verifySubmoduleLink", () => {
  it("rejects a .git link pointed at the store's own Git directory, a symlink, a directory or a missing link", async () => {
    const s = await setup();
    const rec = await attachSubmodules(s.wt, s.manifest, { storeFor: storeFor(s) });
    const entry = rec.entries.find((e) => e.path === "mods/a") as AttachRecord["entries"][number];
    const link = path.join(s.wt, "mods/a", ".git");
    const good = readFileSync(link, "utf8");
    const storeGit = path.join(entry.store, ".git");

    writeFileSync(link, `gitdir: ${storeGit}\n`);
    expect(await verifySubmoduleLink(s.wt, entry)).toBe(false);
    await expect(resetSubmodule(s.wt, entry, entry.sha)).rejects.toMatchObject({
      reason: "SUBMODULE_LINK_INVALID",
      code: "PERMISSION_BLOCKED",
    });
    await expect(writeWorktreeTree(s.wt, entry, entry.sha)).rejects.toMatchObject({ reason: "SUBMODULE_LINK_INVALID" });
    await expect(submoduleStatus(s.wt, entry)).rejects.toMatchObject({ reason: "SUBMODULE_LINK_INVALID" });
    // Another submodule's admin directory of the same store is not this path's either.
    const other = readFileSync(path.join(s.wt, "dup/a", ".git"), "utf8");
    writeFileSync(link, other);
    expect(await verifySubmoduleLink(s.wt, entry)).toBe(false);

    rmSync(link);
    expect(await verifySubmoduleLink(s.wt, entry)).toBe(false);
    symlinkSync(path.join(s.wt, "dup/a", ".git"), link);
    expect(await verifySubmoduleLink(s.wt, entry)).toBe(false);
    rmSync(link);
    mkdirSync(link);
    expect(await verifySubmoduleLink(s.wt, entry)).toBe(false);
    rmSync(link, { recursive: true });
    writeFileSync(link, good);
    expect(await verifySubmoduleLink(s.wt, entry)).toBe(true);
    expect(await verifySubmoduleLink(s.wt, { ...entry, path: "../x" })).toBe(false);

    // A tampered link makes detach drop only the store's record, never follow the link.
    writeFileSync(link, `gitdir: ${storeGit}\n`);
    const res = await detachSubmodules(rec);
    expect(res.removed + res.unlinked).toBe(3);
    expect(worktreeCount(entry.store)).toBe(1);
    expect(g(entry.store, "rev-parse", "--is-bare-repository")).toBe("false");
  });

  it("detach of a path replaced by a symlink drops the record without touching the link target", async () => {
    const s = await setup();
    const rec = await attachSubmodules(s.wt, s.manifest, { storeFor: storeFor(s) });
    const outside = path.join(fx.root, "precious");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "keep.txt"), "keep\n");
    rmSync(path.join(s.wt, "mods/b"), { recursive: true });
    symlinkSync(outside, path.join(s.wt, "mods/b"));
    const res = await detachSubmodules(rec);
    expect(res).toEqual({ removed: 2, unlinked: 1, missing: 0, pruneFailed: 0 });
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep\n");
    expect(worktreeCount(s.stores.get("github.test/acme/lib-b") as string)).toBe(1);
  });
});

describe("readAttachRecord", () => {
  it("returns undefined for a missing file and refuses anything this library did not write", async () => {
    const file = path.join(fx.root, "rec.json");
    expect(await readAttachRecord(file, fx.settings.cloneRoot)).toBeUndefined();
    const entry = {
      path: "mods/a",
      key: "github.test/acme/lib-a",
      store: path.join(fx.settings.cloneRoot, "github.test/acme/lib-a"),
      sha: "a".repeat(40),
      writable: true,
      wiki: false,
    };
    const ok = { version: 1, worktree: path.join(fx.root, "wt"), entries: [entry] };
    writeFileSync(file, JSON.stringify(ok));
    expect(await readAttachRecord(file, fx.settings.cloneRoot)).toEqual(ok);
    const bad: unknown[] = [
      "not json",
      { ...ok, version: 2 },
      { ...ok, worktree: "relative/wt" },
      { ...ok, entries: [{ ...entry, store: "/etc" }] },
      { ...ok, entries: [{ ...entry, store: `${fx.settings.cloneRoot}/../escape` }] },
      { ...ok, entries: [{ ...entry, path: "../x" }] },
      { ...ok, entries: [{ ...entry, sha: "HEAD" }] },
      { ...ok, entries: [{ ...entry, key: "GitHub.test/acme/lib-a" }] },
      { ...ok, entries: [{ ...entry, wiki: true }] },
      { ...ok, entries: {} },
    ];
    for (const b of bad) {
      writeFileSync(file, typeof b === "string" ? b : JSON.stringify(b));
      await expect(readAttachRecord(file, fx.settings.cloneRoot)).rejects.toMatchObject({
        reason: "SUBMODULE_RECORD_INVALID",
      });
    }
  });
});

describe("parseStatusPaths", () => {
  it("reads ordinary, renamed, unmerged and untracked records", () => {
    const z = [
      "1 .M N... 100644 100644 100644 aaa bbb with space.txt",
      "2 R. N... 100644 100644 100644 aaa bbb R100 new name",
      "old name",
      "u UU N... 100644 100644 100644 100644 a b c conflict",
      "? untracked/file",
      "",
    ].join("\0");
    expect(parseStatusPaths(z)).toEqual(["with space.txt", "new name", "conflict", "untracked/file"]);
  });
});
