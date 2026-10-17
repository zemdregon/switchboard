/**
 * T9.13 (FR-WS-10, LLD §5.1, ADR-0057): the dependency seed store on real Git in temporary repositories with fake
 * install commands (Node scripts). The run lifecycle's Done-when tests are in `src/lifecycle/dependency-seeds.test.ts`;
 * these cover the LLD's extra cases (a symlink leaving the directory, the `privileged` build profile, an `evicting`
 * entry, a container run's single read-only mount), the failure reasons, single flight, the early-sweep reclaimer
 * (T3.23) and startup reconciliation.
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
import type { ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import {
  type ContainerRuntime,
  containerSeedCommand,
  createContainerEnvironment,
  createDockerRuntime,
  EnvironmentRefusal,
} from "../environment/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import {
  createSeedStore,
  earlySweepReclaimers,
  hostSeedEnvironment,
  MB,
  runEarlySweep,
  SEED_FAILED_EVENT,
  type SeedCommandFactory,
  type SeedEnvironment,
  type SeedSpec,
  type SeedStore,
  seedKey,
  seedReclaimer,
  WorkspaceManager,
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
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

/** Writes `node_modules/pkg/index.js` from the lockfile; one counter line per build. `BODY` adds behaviour. */
const installScript = (counter: string, body = "") => `
import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
const lock = readFileSync("package-lock.json", "utf8").trim();
appendFileSync(${JSON.stringify(counter)}, lock + "\\n");
mkdirSync("node_modules/pkg", { recursive: true });
writeFileSync("node_modules/pkg/index.js", "module.exports = " + JSON.stringify(lock) + ";\\n");
symlinkSync("index.js", "node_modules/pkg/main.js");
${body}
`;

let root: string;
let repo: string;
let dataDir: string;
let counter: string;
let db: Database.Database;
let ledger: Ledger;
let mgr: WorkspaceManager;
let artifacts: ArtifactStore;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-seeds-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(repo, "package-lock.json"), "lock-v1\n");
  writeFileSync(path.join(repo, "README.md"), "base\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  counter = path.join(root, "builds.log");
  db = openLedger(path.join(root, "ledger"));
  const ids = createIdGenerator();
  ledger = createLedger(db, { ids });
  artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  mgr = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
});

afterEach(() => {
  db.close();
  execFileSync("chmod", ["-R", "u+w", root]); // store entries are read-only
  rmSync(root, { recursive: true, force: true });
});

function script(body = ""): string {
  const p = path.join(root, `install-${readdirSync(root).length}.mjs`);
  writeFileSync(p, installScript(counter, body));
  return p;
}
const spec = (install: string, patch: Partial<SeedSpec> = {}): SeedSpec => ({
  id: "npm",
  lockfile: "package-lock.json",
  directory: "node_modules",
  install: [process.execPath, install],
  timeoutMs: 30_000,
  ...patch,
});
const newStore = (o: { maxBytes?: number; entriesPerSeed?: number; container?: SeedCommandFactory } = {}): SeedStore =>
  createSeedStore({
    db,
    artifacts,
    dataDir,
    maxBytes: o.maxBytes ?? 10 * MB,
    entriesPerSeed: o.entriesPerSeed ?? 3,
    baseEnv: process.env,
    ...(o.container !== undefined ? { commands: { container: o.container } } : {}),
  });

/** A run of project `web` with a fresh worktree (as the workspace manager creates it before seeding). */
async function prepared(
  profile: TrustProfile = "edit-untrusted",
  environment: SeedEnvironment = hostSeedEnvironment(),
) {
  const session = ledger.createMetaSession({ objective: "o", repoRoot: repo, projectId: "web" });
  const run = ledger.createRun({
    metaSessionId: session.id,
    trustProfile: profile,
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
    projectId: "web",
  });
  const ws = await mgr.prepare({ metaSessionId: session.id, runId: run.id, workspace: repo, trustProfile: profile });
  if (ws.mode !== "worktree") throw new Error("expected a worktree");
  return {
    runId: run.id,
    projectId: "web",
    profile,
    baseCommit: ws.baseCommit,
    repoRoot: ws.repoRoot,
    worktreePath: ws.worktreePath,
    environment,
  };
}
const builds = () => (existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").filter(Boolean) : []);
const failures = (runId: string) =>
  ledger
    .listRunEvents(runId)
    .filter((e) => e.type === SEED_FAILED_EVENT)
    .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);
const entries = () =>
  existsSync(path.join(dataDir, "seeds"))
    ? readdirSync(path.join(dataDir, "seeds")).filter((n) => /^[0-9a-f]{64}$/.test(n))
    : [];
const finish = (runId: string) => {
  db.prepare("UPDATE run SET state = 'SUCCEEDED' WHERE id = ?").run(runId);
  mgr.releaseLease(runId);
};

describe("seedKey (LLD §5.1 Key)", () => {
  const base = {
    projectId: "web",
    seedId: "npm",
    lockfileSha256: "a".repeat(64),
    install: ["npm", "ci"],
    profile: "edit-untrusted" as TrustProfile,
    environment: { kind: "host", platform: "linux", arch: "arm64" } as SeedEnvironment,
  };
  it("is stable and changes with every input", () => {
    const k = seedKey(base);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(seedKey({ ...base })).toBe(k);
    for (const patch of [
      { projectId: "api" },
      { seedId: "py" },
      { lockfileSha256: "b".repeat(64) },
      { install: ["npm", "install"] },
      { profile: "trusted-development" as TrustProfile },
      { environment: { kind: "container", imageDigest: `sha256:${"c".repeat(64)}` } as SeedEnvironment },
    ]) {
      expect(seedKey({ ...base, ...patch })).not.toBe(k);
    }
  });
});

describe("SeedStore.seed (T9.13)", () => {
  it("single flight: concurrent runs needing one key share one build", async () => {
    const store = newStore();
    const install = script("await new Promise((r) => setTimeout(r, 300));");
    const [a, b] = await Promise.all([prepared(), prepared()]);
    const [ra, rb] = await Promise.all([store.seed(a, spec(install)), store.seed(b, spec(install))]);
    expect(builds()).toEqual(["lock-v1"]);
    expect([ra, rb].map((r) => r.ok && r.built).sort()).toEqual([false, true]);
    for (const r of [a, b]) {
      expect(readFileSync(path.join(r.worktreePath, "node_modules/pkg/index.js"), "utf8")).toContain("lock-v1");
      // A symlink inside the entry is recreated with its relative target, never pointed into the store.
      expect(lstatSync(path.join(r.worktreePath, "node_modules/pkg/main.js")).isSymbolicLink()).toBe(true);
      expect(readFileSync(path.join(r.worktreePath, "node_modules/pkg/main.js"), "utf8")).toContain("lock-v1");
    }
  });

  it("a symlink leaving the directory fails the build with unsafe_entry", async () => {
    const store = newStore();
    const a = await prepared();
    const r = await store.seed(a, spec(script('symlinkSync("../../README.md", "node_modules/escape");')));
    expect(r).toEqual({ ok: false, reason: "unsafe_entry" });
    expect(failures(a.runId)).toEqual([{ seed_id: "npm", reason: "unsafe_entry" }]);
    expect(entries()).toEqual([]);
    expect(existsSync(path.join(a.worktreePath, "node_modules"))).toBe(false);
    const abs = await prepared();
    expect(await store.seed(abs, spec(script('symlinkSync("/etc/hosts", "node_modules/abs");')))).toEqual({
      ok: false,
      reason: "unsafe_entry",
    });
  });

  it("a privileged run's build records profile trusted-development and shares that profile's entry", async () => {
    const store = newStore();
    const install = script();
    const p = await prepared("privileged");
    const r = await store.seed(p, spec(install));
    expect(r.ok).toBe(true);
    expect(db.prepare("SELECT profile FROM dependency_seed").all()).toEqual([{ profile: "trusted-development" }]);
    const t = await prepared("trusted-development");
    const rt = await store.seed(t, spec(install));
    expect(rt.ok && !rt.built && r.ok && rt.seedKey === r.seedKey).toBe(true);
    // Another profile never reuses it (the profile is part of the key).
    const e = await prepared("edit-untrusted");
    const re = await store.seed(e, spec(install));
    expect(re.ok && re.built).toBe(true);
    expect(builds()).toHaveLength(2);
  });

  it("an entry marked evicting is never used: it is rolled forward and built again", async () => {
    const store = newStore();
    const install = script();
    const a = await prepared();
    const first = await store.seed(a, spec(install));
    finish(a.runId);
    db.prepare("UPDATE dependency_seed SET state = 'evicting', evict_intent_at = 'x'").run();
    const b = await prepared();
    const second = await store.seed(b, spec(install));
    expect(second.ok && second.built).toBe(true);
    expect(first.ok && second.ok && first.seedKey === second.seedKey).toBe(true);
    expect(builds()).toEqual(["lock-v1", "lock-v1"]);
    expect(db.prepare("SELECT state FROM dependency_seed").all()).toEqual([{ state: "ready" }]);
  });

  it("each failure records one seed_failed and leaves the worktree unseeded", async () => {
    const store = newStore();
    const install = script();
    const missing = await prepared();
    expect(await store.seed(missing, spec(install, { lockfile: "yarn.lock" }))).toEqual({
      ok: false,
      reason: "lockfile_missing",
    });
    const notIgnored = await prepared();
    expect(await store.seed(notIgnored, spec(install, { directory: "vendor" }))).toEqual({
      ok: false,
      reason: "not_ignored",
    });
    const slow = await prepared();
    expect(
      await store.seed(slow, spec(script("await new Promise((r) => setTimeout(r, 5000));"), { timeoutMs: 300 })),
    ).toEqual({ ok: false, reason: "build_timeout" });
    const full = await prepared();
    expect(await newStore({ maxBytes: 4 }).seed(full, spec(install))).toEqual({ ok: false, reason: "store_full" });
    for (const r of [missing, notIgnored, slow, full]) {
      expect(failures(r.runId)).toHaveLength(1);
      expect(existsSync(path.join(r.worktreePath, "node_modules"))).toBe(false);
      expect(g(r.worktreePath, "status", "--porcelain", "--untracked-files=all", "--ignored")).toBe("");
    }
    expect(entries()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM dependency_seed").get()).toEqual({ n: 0 });
  });

  it("a directory already present (a native resume in place) is kept with method existing and nothing is built", async () => {
    const store = newStore();
    const a = await prepared();
    mkdirSync(path.join(a.worktreePath, "node_modules"));
    writeFileSync(path.join(a.worktreePath, "node_modules", "mine.js"), "kept\n");
    const r = await store.seed(a, spec(script()));
    expect(r).toMatchObject({ ok: true, method: "existing", built: false });
    expect(builds()).toEqual([]);
    expect(readFileSync(path.join(a.worktreePath, "node_modules", "mine.js"), "utf8")).toBe("kept\n");
  });
});

describe("the dependency_seeds reclaimer of the early disk sweep (T3.23, FR-WS-11)", () => {
  it("is registered first, removes private copies of idle worktrees (never a leased one), then unused entries", async () => {
    const store = newStore();
    const install = script();
    const idle = await prepared();
    await store.seed(idle, spec(install));
    finish(idle.runId);
    const leased = await prepared(); // still holds its lease (and is not terminal)
    await store.seed(leased, spec(install));
    writeFileSync(path.join(repo, "package-lock.json"), "lock-v2\n");
    g(repo, "commit", "-q", "-am", "bump");
    const other = await prepared();
    await store.seed(other, spec(install));
    finish(other.runId);
    expect(entries()).toHaveLength(2);

    const list = earlySweepReclaimers({
      gc: { db, artifacts, dataDir, days: 30 },
      enabled: false,
      seeds: seedReclaimer(store),
    });
    expect(list.map((r) => r.name)).toEqual(["dependency_seeds", "meta_sessions"]);
    const r = await runEarlySweep({
      db,
      floor: { minFreeBytes: 100 * MB, paths: [dataDir], probe: { freeBytes: () => 1 } },
      reclaimers: list,
    });
    expect(r.leasedWorktrees).toEqual([leased.worktreePath]);
    expect(r.steps[0]).toEqual({ name: "dependency_seeds", outcome: { reclaimed: 3, notes: [] } });
    // Private copies of idle runs gone; the leased worktree untouched.
    expect(existsSync(path.join(idle.worktreePath, "node_modules"))).toBe(false);
    expect(existsSync(path.join(other.worktreePath, "node_modules"))).toBe(false);
    expect(readFileSync(path.join(leased.worktreePath, "node_modules/pkg/index.js"), "utf8")).toContain("lock-v1");
    // The lock-v2 entry (no non-terminal user) is evicted; the lock-v1 entry is in use by the leased run and stays.
    const left = db.prepare("SELECT seed_key FROM dependency_seed").all() as { seed_key: string }[];
    expect(left).toHaveLength(1);
    expect(entries()).toEqual([left[0]?.seed_key]);
    expect(
      db.prepare("SELECT run_id FROM dependency_seed_use WHERE removed_at IS NOT NULL ORDER BY run_id").all(),
    ).toEqual([{ run_id: idle.runId }, { run_id: other.runId }].sort((x, y) => x.run_id.localeCompare(y.run_id)));
  });
});

describe("SeedStore.reconcile (LLD §5.1 crash safety)", () => {
  it("drops building rows without a build, rolls evicting rows forward and removes scratch and orphan entries", async () => {
    const store = newStore();
    const a = await prepared();
    const r = await store.seed(a, spec(script()));
    finish(a.runId);
    const key = r.ok ? r.seedKey : "";
    db.prepare("UPDATE dependency_seed SET state = 'evicting'").run();
    db.prepare(
      `INSERT INTO dependency_seed (seed_key, project_id, seed_id, lockfile_sha256, profile, environment, state, created_at)
       VALUES (?, 'web', 'npm', 'x', 'edit-untrusted', '{}', 'building', 'x')`,
    ).run("b".repeat(64));
    const orphan = path.join(dataDir, "seeds", "c".repeat(64));
    mkdirSync(orphan);
    mkdirSync(path.join(dataDir, "seeds", ".build", "left-over"), { recursive: true });
    await store.reconcile();
    expect(db.prepare("SELECT COUNT(*) AS n FROM dependency_seed").get()).toEqual({ n: 0 });
    expect(existsSync(path.join(dataDir, "seeds", key))).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(readdirSync(path.join(dataDir, "seeds", ".build"))).toEqual([]);
  });
});

describe("a container run's seed (ADR-0057 item 5)", () => {
  const DIGEST = `sha256:${"d".repeat(64)}`;
  const PROFILE: ResolvedProfile = {
    name: "edit-untrusted",
    fileAccess: "worktree",
    shell: "none",
    network: "off",
    repoConfig: "disabled",
    bypassApproved: false,
  };
  /** The Docker driver's real `runArgv` behind a runtime that answers every check (no Docker is called). */
  const fakeRuntime = (): ContainerRuntime => {
    const docker = createDockerRuntime({
      clientPath: "/usr/bin/docker",
      exec: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    });
    return {
      ...docker,
      info: async () => ({
        available: true,
        rootless: true,
        serverVersion: "1",
        clientPath: "/usr/bin/docker",
        detail: "fake rootless",
      }),
      resolveImage: async () => ({ kind: "found", imageId: "sha256:img" }),
      scanImageForGitClient: async () => ({ completed: true, found: [], detail: "clean" }),
      runArgv: (spec) => docker.runArgv(spec),
    };
  };
  /** Stands in for the container builder: runs the install on the host (the argv shape is the builder's own test). */
  const hostLike: SeedCommandFactory = async (ctx) => ({
    argv: ctx.spec.install,
    envAllowlist: ["PATH", "HOME"],
    confinable: false,
  });

  it("is one read-only bind mount of the entry, no copy on the host, and no other path under the data directory", async () => {
    const store = newStore({ container: hostLike });
    const run = await prepared("edit-untrusted", { kind: "container", imageDigest: DIGEST });
    const r = await store.seed(run, spec(script()));
    expect(r).toMatchObject({ ok: true, method: "mount", built: true });
    expect(existsSync(path.join(run.worktreePath, "node_modules"))).toBe(false);
    const key = r.ok ? r.seedKey : "";
    expect(store.containerMounts(run.runId)).toEqual([
      {
        source: path.join(dataDir, "seeds", key),
        target: path.join(run.worktreePath, "node_modules"),
        readOnly: true,
      },
    ]);

    const runtime = fakeRuntime();
    const env = createContainerEnvironment({
      runtime,
      seeds: { root: path.join(dataDir, "seeds"), mounts: (id) => store.containerMounts(id) },
    });
    const prepared2 = await env.prepare(
      {
        runId: run.runId,
        projectId: "web",
        worktreePath: run.worktreePath,
        readOnlyContexts: [],
        profile: PROFILE,
        imageDigest: DIGEST,
      },
      {
        argv: ["/usr/bin/fake", "--run"],
        env: {},
        envAllowlist: ["PATH"],
        policyFlags: [],
        timeouts: { wallClockMs: 1000, idleMs: 1000, killGraceMs: 100 },
      } as never,
    );
    const argv = prepared2.invocation.argv;
    const mounts = argv.filter((_a, i) => argv[i - 1] === "--mount");
    expect(mounts).toEqual([
      `type=bind,src=${run.worktreePath},dst=${run.worktreePath}`,
      `type=bind,src=${path.join(dataDir, "seeds", key)},dst=${path.join(run.worktreePath, "node_modules")},readonly`,
    ]);
    expect(mounts.filter((m) => m.endsWith(",readonly"))).toHaveLength(1);
    // Under the data directory: the run's own worktree and that one entry, nothing else.
    const under = mounts.map((m) => /src=([^,]+)/.exec(m)?.[1] ?? "").filter((s) => s.startsWith(dataDir));
    expect(under).toEqual([run.worktreePath, path.join(dataDir, "seeds", key)]);
  });

  it("the container builder runs the install in the project's image with only the scratch worktree mounted", async () => {
    const factory = containerSeedCommand({ runtime: fakeRuntime(), profileFor: () => PROFILE });
    const cmd = await factory({
      runId: "run_1",
      projectId: "web",
      seedKey: "f".repeat(64),
      scratch: "/data/seeds/.build/s1",
      spec: {
        id: "npm",
        lockfile: "package-lock.json",
        directory: "node_modules",
        install: ["npm", "ci"],
        timeoutMs: 1,
      },
      profile: "edit-untrusted",
      environment: { kind: "container", imageDigest: DIGEST },
    });
    expect(cmd.confinable).toBe(false);
    const a = cmd.argv;
    expect(a.filter((_x, i) => a[i - 1] === "--mount")).toEqual([
      "type=bind,src=/data/seeds/.build/s1,dst=/data/seeds/.build/s1",
    ]);
    expect(a.slice(-3)).toEqual(["sha256:img", "npm", "ci"]);
    expect(a).toContain("switchboard.role=seed");
    expect(a).toContain(`switchboard.seed=${"f".repeat(64)}`);
    expect(a[a.indexOf("--network") + 1]).toBe("none"); // the build profile's network: off
    await expect(
      containerSeedCommand({
        runtime: {
          ...fakeRuntime(),
          scanImageForGitClient: async () => ({
            completed: true,
            found: [{ name: "git", path: "/usr/bin/git" }],
            detail: "git",
          }),
        },
        profileFor: () => PROFILE,
      })({
        runId: "run_1",
        projectId: "web",
        seedKey: "f".repeat(64),
        scratch: "/s",
        spec: { id: "npm", lockfile: "l", directory: "d", install: ["x"], timeoutMs: 1 },
        profile: "edit-untrusted",
        environment: { kind: "container", imageDigest: DIGEST },
      }),
    ).rejects.toThrow(/Git client/);
  });

  it("a seed mount from outside the store or targeting outside the worktree refuses the run", async () => {
    const refusal = async (m: { source: string; target: string }) => {
      const env = createContainerEnvironment({
        runtime: fakeRuntime(),
        seeds: { root: "/data/seeds", mounts: () => [m] },
      });
      const run = {
        runId: "run_1",
        projectId: "web",
        worktreePath: "/wt/run",
        readOnlyContexts: [],
        profile: PROFILE,
        imageDigest: DIGEST,
      };
      return env.prepare(run, { argv: ["/usr/bin/fake"], env: {}, envAllowlist: [] } as never).then(
        () => "prepared",
        (err: unknown) => (err instanceof EnvironmentRefusal ? err.reason : String(err)),
      );
    };
    const entry = `/data/seeds/${"e".repeat(64)}`;
    expect(await refusal({ source: "/data/artifacts", target: "/wt/run/node_modules" })).toBe(
      "CONTAINER_MOUNT_PATH_INVALID",
    );
    expect(await refusal({ source: entry, target: "/elsewhere/node_modules" })).toBe("CONTAINER_MOUNT_PATH_INVALID");
    expect(await refusal({ source: entry, target: "/wt/run" })).toBe("CONTAINER_MOUNT_PATH_INVALID");
    expect(await refusal({ source: `${entry}/../x`, target: "/wt/run/node_modules" })).toBe(
      "CONTAINER_MOUNT_PATH_INVALID",
    );
    expect(await refusal({ source: entry, target: "/wt/run/node_modules" })).toBe("prepared");
  });
});
