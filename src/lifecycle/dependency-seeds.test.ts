/**
 * T9.13 (FR-WS-10, LLD §5.1, ADR-0057): dependency seeding through the real run lifecycle with the fake adapter, real
 * Git in a temporary repository and a fake install command (a Node script that writes `node_modules/pkg/index.js` from
 * the lockfile and appends one line per build to a counter file; it fails when the lockfile says `FAIL`). The fake
 * provider CLI writes `<name>.txt`, and for a name starting with `mutate` also changes the mode of and writes to the
 * seeded file, then waits for its gate file so runs can be held non-terminal. These are the row's Done-when tests.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
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
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunState } from "../ledger/index.js";
import type { ProjectSnapshot } from "../policy/index.js";
import {
  createSeedStore,
  hostSeedEnvironment,
  SEED_APPLIED_EVENT,
  SEED_FAILED_EVENT,
  type SeedSpec,
  type SeedStore,
  WorkspaceManager,
} from "../workspace/index.js";
import { RunLifecycle } from "./index.js";

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

const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const PROFILE: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};
const PROJECT: ProjectSnapshot = {
  id: "web",
  name: "Web",
  environment_kind: "host",
  context_id: "main",
  base_ref: "main",
  effective_max_profile: "trusted-development",
  writable: true,
};
const SEEDED_FILE = path.join("node_modules", "pkg", "index.js");

const GATED_CLI = `
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const a = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (a.includes("--version")) process.stdout.write("fake-cli 1.0.0\\n");
else if (a.includes("--auth-status")) process.stdout.write('{"authenticated":true}\\n');
else if (a.includes("--smoke")) emit({ type: "result", ok: true, summary: "smoke" });
else {
  const name = readFileSync(0, "utf8").trim();
  if (!/^[a-z0-9]+$/.test(name)) { emit({ type: "result", ok: false, summary: "bad name" }); process.exit(1); }
  emit({ type: "session", session_id: "seed-" + name });
  writeFileSync(name + ".txt", name + "\\n");
  if (name.startsWith("mutate")) {
    const f = path.join("node_modules", "pkg", "index.js");
    chmodSync(f, 0o777);
    appendFileSync(f, "// tampered by " + name + "\\n");
  }
  const gate = path.join(GATES, name + ".go");
  const timer = setInterval(() => {
    if (!existsSync(gate)) return;
    clearInterval(timer);
    emit({ type: "result", ok: true, summary: "wrote " + name });
  }, 20);
}
`;

const INSTALL = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const lock = readFileSync("package-lock.json", "utf8").trim();
appendFileSync(COUNTER, lock + "\\n");
if (lock.includes("FAIL")) { process.stderr.write("install failed\\n"); process.exit(3); }
mkdirSync("node_modules/pkg", { recursive: true });
writeFileSync("node_modules/pkg/index.js", "module.exports = " + JSON.stringify(lock) + ";\\n");
`;

let root: string;
let repo: string;
let gates: string;
let counter: string;
let install: string;
let script: string;
const open: { lifecycle: RunLifecycle; db: Database.Database }[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-seed-lc-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "base\n");
  writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(repo, "package-lock.json"), "lock-v1\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  gates = path.join(root, "gates");
  mkdirSync(gates);
  counter = path.join(root, "builds.log");
  install = path.join(root, "install.mjs");
  writeFileSync(install, INSTALL.replace("COUNTER", JSON.stringify(counter)));
  script = path.join(root, "gated-cli.mjs");
  writeFileSync(script, GATED_CLI.replace("GATES", JSON.stringify(gates)));
});

afterEach(async () => {
  for (const name of NAMES) writeFileSync(path.join(gates, `${name}.go`), "");
  for (const o of open.splice(0)) {
    await o.lifecycle.shutdown();
    o.db.close();
  }
  execFileSync("chmod", ["-R", "u+w", root]); // store entries are read-only
  rmSync(root, { recursive: true, force: true });
});

const NAMES = ["alpha", "beta", "gamma", "delta", "mutatea"];
const SPEC = (): SeedSpec => ({
  id: "npm",
  lockfile: "package-lock.json",
  directory: "node_modules",
  install: [process.execPath, install],
  timeoutMs: 60_000,
});

interface Harness {
  readonly lifecycle: RunLifecycle;
  readonly ledger: Ledger;
  readonly db: Database.Database;
  readonly dataDir: string;
  readonly store?: SeedStore;
}

/** One controller. `seeds`: the project's declared seeds (`undefined`: no `seeding` option at all, as on `main`). */
function controller(o: { name: string; seeds?: readonly SeedSpec[]; entriesPerSeed?: number }): Harness {
  const dataDir = path.join(root, `data-${o.name}`);
  mkdirSync(dataDir);
  const db = openLedger(path.join(root, `ledger-${o.name}`));
  const ids = createIdGenerator();
  const ledger = createLedger(db, { ids });
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const seeds = o.seeds;
  const store =
    seeds === undefined
      ? undefined
      : createSeedStore({
          db,
          artifacts,
          dataDir,
          maxBytes: 10 * 1024 * 1024,
          entriesPerSeed: o.entriesPerSeed ?? 3,
          baseEnv: process.env,
          ids,
          cloneMode: "auto",
        });
  const workspace = new WorkspaceManager({
    db,
    artifacts,
    dataDir,
    allowedRoots: [root],
    ids,
    ...(store !== undefined && seeds !== undefined
      ? {
          seeding: {
            store,
            plan: (projectId: string) =>
              projectId === "web" && seeds.length > 0
                ? { specs: seeds, environment: hostSeedEnvironment() }
                : undefined,
          },
        }
      : {}),
  });
  const lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(new FakeAdapter({ script, commitChannel: "none", timeouts: PATIENT })),
    allowedRoots: [root],
    globalConcurrency: 4,
    resolveProfile: () => PROFILE,
  });
  lifecycle.start();
  open.push({ lifecycle, db });
  return { lifecycle, ledger, db, dataDir, ...(store !== undefined ? { store } : {}) };
}

async function until(what: string, cond: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const gate = (name: string) => writeFileSync(path.join(gates, `${name}.go`), "");
const state = (h: Harness, runId: string): RunState | undefined => h.ledger.getRunRecord(runId)?.state;
const worktreeOf = (h: Harness, runId: string) =>
  (h.db.prepare("SELECT worktree_path FROM run WHERE id = ?").get(runId) as { worktree_path: string | null })
    .worktree_path;
const builds = () => (existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").filter(Boolean) : []);
const events = (h: Harness, runId: string, type: string) =>
  h.ledger
    .listRunEvents(runId)
    .filter((e) => e.type === type)
    .map((e) => ({ type: e.type, payload: JSON.parse(e.payload_json) as Record<string, unknown> }));
const storeEntries = (h: Harness) =>
  existsSync(path.join(h.dataDir, "seeds"))
    ? readdirSync(path.join(h.dataDir, "seeds")).filter((n) => /^[0-9a-f]{64}$/.test(n))
    : [];
const modeOf = (p: string) => lstatSync(p).mode & 0o7777;

/** Submit a project run and wait until its fake CLI has written its file (RUNNING, holding its gate). */
async function start(h: Harness, name: string) {
  const { runId } = await h.lifecycle.submit({
    clientId: "c",
    objective: name,
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    project: PROJECT,
  });
  await until(`${name} to write its file`, () => {
    const wt = worktreeOf(h, runId);
    return state(h, runId) === "RUNNING" && wt !== null && existsSync(path.join(wt, `${name}.txt`));
  });
  return { runId, worktree: worktreeOf(h, runId) as string };
}

async function finish(h: Harness, name: string, runId: string): Promise<void> {
  gate(name);
  await until(`${name} to end`, () => state(h, runId) === "SUCCEEDED");
}

/** Every path below `dir` (not `.git`), with type, mode and content: a byte-level picture of a worktree. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (cur: string) => {
    for (const name of readdirSync(cur).sort()) {
      if (cur === dir && name === ".git") continue;
      const p = path.join(cur, name);
      const st = lstatSync(p);
      const rel = path.relative(dir, p);
      if (st.isDirectory()) {
        out[rel] = `dir ${(st.mode & 0o777).toString(8)}`;
        walk(p);
      } else out[rel] = `file ${(st.mode & 0o777).toString(8)} ${readFileSync(p, "base64")}`;
    }
  };
  walk(dir);
  return out;
}

describe("dependency seeding through the run lifecycle (T9.13, FR-WS-10)", () => {
  it("a project with no seed gives byte-identical worktrees, events and diffs to main", async () => {
    // One after the other: both controllers share the repository, whose refs the ref guard watches during a run.
    const main = controller({ name: "main" }); // no `seeding` option: the code path on main
    const a = await start(main, "alpha");
    const atStart = snapshot(a.worktree);
    await finish(main, "alpha", a.runId);
    const none = controller({ name: "none", seeds: [] }); // seeding composed, but the project declares no seed
    const b = await start(none, "alpha");
    expect(snapshot(b.worktree)).toEqual(atStart);
    expect(existsSync(path.join(b.worktree, "node_modules"))).toBe(false);
    await finish(none, "alpha", b.runId);

    const types = (h: Harness, runId: string) => h.ledger.listRunEvents(runId).map((e) => e.type);
    expect(types(none, b.runId)).toEqual(types(main, a.runId));
    const diffOf = async (h: Harness, runId: string) => {
      const art = h.ledger.listArtifactsForRun(runId).find((x) => x.kind === "diff");
      return new ArtifactStore(path.join(h.dataDir, "artifacts")).get(art?.sha256 as string);
    };
    expect((await diffOf(none, b.runId)).equals(await diffOf(main, a.runId))).toBe(true);
    expect(snapshot(b.worktree)).toEqual(snapshot(a.worktree));
    // No store directory, no ledger row, no seed event.
    expect(existsSync(path.join(none.dataDir, "seeds"))).toBe(false);
    expect(none.db.prepare("SELECT COUNT(*) AS n FROM dependency_seed").get()).toEqual({ n: 0 });
    expect(none.db.prepare("SELECT COUNT(*) AS n FROM dependency_seed_use").get()).toEqual({ n: 0 });
    expect(builds()).toEqual([]);
  });

  it("two runs on one lockfile hash build the store entry once and both worktrees contain the directory", async () => {
    const h = controller({ name: "two", seeds: [SPEC()] });
    const a = await start(h, "alpha");
    const b = await start(h, "beta");
    expect(builds()).toEqual(["lock-v1"]);
    expect(storeEntries(h)).toHaveLength(1);
    for (const r of [a, b]) {
      expect(readFileSync(path.join(r.worktree, SEEDED_FILE), "utf8")).toBe('module.exports = "lock-v1";\n');
      // The seeded directory is ignored: the worktree is clean apart from the agent's own file.
      expect(g(r.worktree, "status", "--porcelain", "--untracked-files=all")).toMatch(/^\?\? [a-z]+\.txt$/);
    }
    const [ea] = events(h, a.runId, SEED_APPLIED_EVENT);
    const [eb] = events(h, b.runId, SEED_APPLIED_EVENT);
    expect(ea?.payload).toMatchObject({ seed_id: "npm", built: true });
    expect(eb?.payload).toMatchObject({
      seed_id: "npm",
      built: false,
      seed_key: ea?.payload.seed_key,
    });
    expect(["clone", "copy"]).toContain(eb?.payload.method);
    // The build log is a seed_log artifact of the run that built it, and only of that run.
    expect(h.ledger.listArtifactsForRun(a.runId).filter((x) => x.kind === "seed_log")).toHaveLength(1);
    expect(h.ledger.listArtifactsForRun(b.runId).filter((x) => x.kind === "seed_log")).toHaveLength(0);
    await finish(h, "alpha", a.runId);
    await finish(h, "beta", b.runId);
    // The checkpoint commit and the diff never carry the seeded directory.
    expect(g(a.worktree, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("node_modules");
  });

  it("a fake agent that changes the mode of and writes to a seeded file leaves the store and the other worktree unchanged", async () => {
    const h = controller({ name: "mut", seeds: [SPEC()] });
    const a = await start(h, "alpha");
    const key = storeEntries(h)[0] as string;
    const entryFile = path.join(h.dataDir, "seeds", key, "pkg", "index.js");
    const entryBefore = { body: readFileSync(entryFile, "utf8"), mode: modeOf(entryFile) };
    const otherBefore = {
      body: readFileSync(path.join(a.worktree, SEEDED_FILE), "utf8"),
      mode: modeOf(path.join(a.worktree, SEEDED_FILE)),
    };

    const m = await start(h, "mutatea");
    const mine = path.join(m.worktree, SEEDED_FILE);
    expect(modeOf(mine)).toBe(0o777);
    expect(readFileSync(mine, "utf8")).toContain("tampered by mutatea");
    // Separate inodes: never a hardlink or a symlink into the store (Q-103 Delegated default).
    expect(lstatSync(mine).ino).not.toBe(lstatSync(entryFile).ino);
    expect(lstatSync(mine).nlink).toBe(1);
    expect(lstatSync(path.join(m.worktree, "node_modules")).isSymbolicLink()).toBe(false);

    expect({ body: readFileSync(entryFile, "utf8"), mode: modeOf(entryFile) }).toEqual(entryBefore);
    expect(entryBefore.mode & 0o222).toBe(0); // stored read-only
    const other = path.join(a.worktree, SEEDED_FILE);
    expect({ body: readFileSync(other, "utf8"), mode: modeOf(other) }).toEqual(otherBefore);

    // A later run still gets the untouched entry.
    const c = await start(h, "gamma");
    expect(readFileSync(path.join(c.worktree, SEEDED_FILE), "utf8")).toBe(entryBefore.body);
    expect(builds()).toEqual(["lock-v1"]);
  });

  it("a changed lockfile builds a new entry", async () => {
    const h = controller({ name: "lock", seeds: [SPEC()] });
    const a = await start(h, "alpha");
    await finish(h, "alpha", a.runId);
    writeFileSync(path.join(repo, "package-lock.json"), "lock-v2\n");
    g(repo, "commit", "-q", "-am", "bump lockfile");
    const b = await start(h, "beta");
    expect(builds()).toEqual(["lock-v1", "lock-v2"]);
    expect(storeEntries(h)).toHaveLength(2);
    expect(readFileSync(path.join(b.worktree, SEEDED_FILE), "utf8")).toBe('module.exports = "lock-v2";\n');
    const keyOf = (runId: string) =>
      (events(h, runId, SEED_APPLIED_EVENT)[0]?.payload as { seed_key: string; built: boolean }) ?? {};
    expect(keyOf(b.runId).seed_key).not.toBe(keyOf(a.runId).seed_key);
    expect(keyOf(b.runId).built).toBe(true);
  });

  it("a failing install leaves the run admitted with an unseeded worktree and a seed_failed event", async () => {
    writeFileSync(path.join(repo, "package-lock.json"), "FAIL\n");
    g(repo, "commit", "-q", "-am", "broken lockfile");
    const h = controller({ name: "fail", seeds: [SPEC()] });
    const a = await start(h, "alpha");
    expect(existsSync(path.join(a.worktree, "node_modules"))).toBe(false);
    expect(events(h, a.runId, SEED_FAILED_EVENT).map((e) => e.payload)).toEqual([
      { seed_id: "npm", reason: "build_failed" },
    ]);
    expect(events(h, a.runId, SEED_APPLIED_EVENT)).toEqual([]);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM dependency_seed").get()).toEqual({ n: 0 });
    expect(storeEntries(h)).toEqual([]);
    expect(readdirSync(path.join(h.dataDir, "seeds", ".build"))).toEqual([]); // scratch worktree removed
    expect(g(repo, "worktree", "list", "--porcelain")).not.toContain(path.join(h.dataDir, "seeds"));
    const log = h.ledger.listArtifactsForRun(a.runId).find((x) => x.kind === "seed_log");
    const body = JSON.parse(
      (await new ArtifactStore(path.join(h.dataDir, "artifacts")).get(log?.sha256 as string)).toString("utf8"),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      v: 1,
      seed_id: "npm",
      outcome: "build_failed",
      exit_code: 3,
      stderr: "install failed\n",
    });
    await finish(h, "alpha", a.runId);
    expect(state(h, a.runId)).toBe("SUCCEEDED");
  });

  it("LRU eviction never removes an entry in use", async () => {
    const h = controller({ name: "lru", seeds: [SPEC()], entriesPerSeed: 1 });
    const a = await start(h, "alpha"); // holds the lock-v1 entry, non-terminal
    const k1 = storeEntries(h)[0] as string;
    writeFileSync(path.join(repo, "package-lock.json"), "lock-v2\n");
    g(repo, "commit", "-q", "-am", "bump lockfile");
    const b = await start(h, "beta"); // builds lock-v2; the bound of one entry per seed asks to evict lock-v1
    expect(storeEntries(h).sort()).toHaveLength(2);
    expect(storeEntries(h)).toContain(k1);
    expect(readFileSync(path.join(a.worktree, SEEDED_FILE), "utf8")).toBe('module.exports = "lock-v1";\n');
    expect(await h.store?.evict()).toEqual({ reclaimed: 0, notes: [] });
    expect(storeEntries(h)).toContain(k1);

    await finish(h, "alpha", a.runId); // lock-v1 is no longer in use
    expect(await h.store?.evict()).toEqual({ reclaimed: 1, notes: [] });
    expect(storeEntries(h)).not.toContain(k1);
    expect(storeEntries(h)).toHaveLength(1);
    expect(h.db.prepare("SELECT seed_key FROM dependency_seed").all()).toEqual([{ seed_key: storeEntries(h)[0] }]);
    // The in-use lock-v2 entry is never a candidate either.
    expect(await h.store?.evict()).toEqual({ reclaimed: 0, notes: [] });
    await finish(h, "beta", b.runId);
  });
});
