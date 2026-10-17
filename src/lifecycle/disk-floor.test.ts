/**
 * Free-disk floor through the lifecycle (T3.23; FR-WS-11, BR-51, LLD §5) with an injected probe and the fake adapter:
 * under the floor a submitted run is accepted and held in `QUEUED` with one `disk_hold` event; raising the probe admits
 * it; the early sweep runs at most once per re-probe period and its end re-probes; a probe that cannot read never
 * holds; without the option no probe is made and a run's events are those of `main`. No provider CLI, no network.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { type Harness, startHarness } from "../routing/fixtures/harness.js";
import { type DiskFloorStatus, MB, WorkspaceManager } from "../workspace/index.js";
import { DISK_HOLD_EVENT, type DiskFloorGate, RunLifecycle } from "./index.js";

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
const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle | undefined;

function makeLifecycle(diskFloor?: DiskFloorGate): RunLifecycle {
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids: createIdGenerator() });
  return new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(new FakeAdapter({ timeouts: PATIENT })),
    allowedRoots: [root],
    globalConcurrency: 4,
    perProviderConcurrency: 4,
    resolveProfile: profileFor,
    retry: { maxAttempts: 1, baseMs: 1, capMs: 1 },
    eligibility: {
      platform: "linux",
      gate: (id, version) => ({
        eligible: true,
        evidence: { provider: id, observedVersion: version, validatedRange: "test", validatedCliVersion: "test" },
      }),
    },
    ...(diskFloor !== undefined ? { diskFloor } : {}),
  });
}

const live = (): RunLifecycle => {
  if (!lifecycle) throw new Error("no lifecycle");
  return lifecycle;
};
const submit = () =>
  live().submit({
    clientId: "c",
    objective: "do the task",
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
  });
const events = (runId: string) => ledger.listRunEvents(runId).map((e) => e.type);
const holds = (runId: string) => ledger.listRunEvents(runId).filter((e) => e.type === DISK_HOLD_EVENT);

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-disk-floor-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("free-disk floor through the lifecycle (T3.23, FR-WS-11)", () => {
  it("under the floor a run is accepted and stays QUEUED with one disk_hold event; raising the probe admits it", async () => {
    let free = 10 * MB;
    let probes = 0;
    lifecycle = makeLifecycle({
      minFreeBytes: 100 * MB,
      paths: [dataDir, path.join(dataDir, "worktrees")],
      probe: {
        freeBytes: () => {
          probes++;
          return free;
        },
      },
      recheckMs: 25,
    });
    live().start();
    const r = await submit();
    expect(r.state).toBe("QUEUED");
    await sleep(200);
    // Several re-probes happened while held; the run is still queued and carries exactly one disk_hold event.
    expect(probes).toBeGreaterThan(2);
    expect(ledger.getRunRecord(r.runId)?.state).toBe("QUEUED");
    const held = holds(r.runId);
    expect(held).toHaveLength(1);
    expect(JSON.parse(held[0]?.payload_json ?? "{}")).toEqual({
      reason: "FREE_DISK_BELOW_FLOOR",
      free_bytes: 10 * MB,
      min_free_bytes: 100 * MB,
      path: dataDir,
    });
    expect(ledger.getRunRecord(r.runId)?.failure_code).toBeNull();

    free = 500 * MB;
    const done = await live().waitForTerminal(r.runId); // woken by the re-probe timer
    expect(done.state).toBe("SUCCEEDED");
    expect(holds(r.runId)).toHaveLength(1);
  });

  it("every queued run is held, each with its own event, and all are admitted once the floor is met", async () => {
    let free = 10 * MB;
    lifecycle = makeLifecycle({
      minFreeBytes: 100 * MB,
      paths: [dataDir],
      probe: { freeBytes: () => free },
      recheckMs: 25,
    });
    live().start();
    const a = await submit();
    const b = await submit();
    await sleep(120);
    for (const r of [a, b]) {
      expect(ledger.getRunRecord(r.runId)?.state).toBe("QUEUED");
      expect(holds(r.runId)).toHaveLength(1);
    }
    free = 500 * MB;
    expect((await live().waitForTerminal(a.runId)).state).toBe("SUCCEEDED");
    expect((await live().waitForTerminal(b.runId)).state).toBe("SUCCEEDED");
  });

  it("the early sweep runs once per re-probe period with the status, and its end re-probes without waiting", async () => {
    let free = 10 * MB;
    const seen: DiskFloorStatus[] = [];
    lifecycle = makeLifecycle({
      minFreeBytes: 100 * MB,
      paths: [dataDir],
      probe: { freeBytes: () => free },
      recheckMs: 10 * 60_000, // the timer would take ten minutes; the sweep's end must admit the run instead
      sweep: async (status) => {
        seen.push(status);
        await sleep(30);
        free = 500 * MB; // the sweep reclaimed space
      },
    });
    live().start();
    const r = await submit();
    const done = await live().waitForTerminal(r.runId);
    expect(done.state).toBe("SUCCEEDED");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ below: true, freeBytes: 10 * MB, minFreeBytes: 100 * MB, path: dataDir });
    expect(holds(r.runId)).toHaveLength(1);
  });

  it("a sweep that reclaims nothing is not re-run before the period ends, and a sweep that throws leaves the hold to the re-probe", async () => {
    let free = 10 * MB;
    let sweeps = 0;
    lifecycle = makeLifecycle({
      minFreeBytes: 100 * MB,
      paths: [dataDir],
      probe: { freeBytes: () => free },
      recheckMs: 40,
      sweep: async () => {
        sweeps++;
        throw new Error("nothing to reclaim");
      },
    });
    live().start();
    const r = await submit();
    await sleep(150);
    expect(ledger.getRunRecord(r.runId)?.state).toBe("QUEUED");
    // About one sweep per 40 ms period over 150 ms, never a tight loop (the end of a sweep re-pumps immediately).
    expect(sweeps).toBeGreaterThanOrEqual(1);
    expect(sweeps).toBeLessThanOrEqual(5);
    free = 500 * MB;
    expect((await live().waitForTerminal(r.runId)).state).toBe("SUCCEEDED");
  });

  it("a probe that cannot read any path never holds: the floor is not assessable, the run proceeds", async () => {
    lifecycle = makeLifecycle({
      minFreeBytes: 100 * MB,
      paths: [dataDir],
      probe: {
        freeBytes: () => {
          throw new Error("ENOENT");
        },
      },
      recheckMs: 25,
    });
    live().start();
    const r = await submit();
    expect((await live().waitForTerminal(r.runId)).state).toBe("SUCCEEDED");
    expect(holds(r.runId)).toHaveLength(0);
  });

  it("without the option no probe is made and a run's events are the same as with a floor that is met (main behaviour)", async () => {
    lifecycle = makeLifecycle();
    live().start();
    const plain = await submit();
    const plainDone = await live().waitForTerminal(plain.runId);
    expect(plainDone.state).toBe("SUCCEEDED");
    const plainEvents = events(plain.runId);
    expect(plainEvents).not.toContain(DISK_HOLD_EVENT);
    await live().shutdown();

    let probes = 0;
    lifecycle = makeLifecycle({
      minFreeBytes: 100 * MB,
      paths: [dataDir],
      probe: {
        freeBytes: () => {
          probes++;
          return 500 * MB;
        },
      },
    });
    live().start();
    const met = await submit();
    expect((await live().waitForTerminal(met.runId)).state).toBe("SUCCEEDED");
    expect(probes).toBeGreaterThan(0);
    expect(events(met.runId)).toEqual(plainEvents);
  });
});

describe("free-disk floor over MCP (T3.23: delegate_task is accepted under the floor)", () => {
  let h: Harness;
  let free = 10 * MB;
  beforeEach(async () => {
    free = 10 * MB;
    h = await startHarness({
      lifecycle: {
        diskFloor: {
          minFreeBytes: 100 * MB,
          paths: ["/"],
          probe: { freeBytes: () => free },
          recheckMs: 25,
        } satisfies DiskFloorGate,
      },
    });
  });
  afterEach(async () => {
    await h.close();
  });

  it("delegate_task returns a QUEUED run with disk_hold recorded, and the run is dispatched once the probe is raised", async () => {
    const body = (await h.ok("delegate_task", {
      objective: "Fix the parser crash",
      workspace_path: h.repo,
      trust_profile: "edit-untrusted",
    })) as { run_id: string; status: string };
    expect(body.status).toBe("QUEUED");
    await sleep(120);
    const run = h.ledger.getRunRecord(body.run_id);
    expect(run?.state).toBe("QUEUED");
    expect(h.ledger.listRunEvents(body.run_id).filter((e) => e.type === DISK_HOLD_EVENT)).toHaveLength(1);
    const shown = (await h.ok("get_run", { run_id: body.run_id })) as { status: string };
    expect(shown.status).toBe("QUEUED");
    free = 500 * MB;
    const done = await h.lifecycle.waitForTerminal(body.run_id);
    expect(done.state).toBe("SUCCEEDED");
  });
});
