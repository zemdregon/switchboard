/**
 * Host load hold (T3.24; FR-CAP-12, NFR-PERF-03, LLD §20.2) with an injected load reader and the fake adapter: above
 * `max_load1` a submitted run is accepted and held in `QUEUED` with one `load_hold` event; between the resume value
 * and the maximum it stays held (hysteresis); below the resume value it is admitted; a running run is never stopped;
 * a `light` run is admitted while held, and over MCP only for a client with `allow_light`; `get_run` and `get_digest`
 * show `held_load`; an unreadable load never holds; without the option the reader is never called and a run's events
 * are those of `main`. No real load average, no provider CLI, no network.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScenario } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import {
  type HostLoadGate,
  LIGHT_RUN_EVENT,
  LOAD_HOLD_EVENT,
  LOAD_RELEASE_EVENT,
  nextLoadHeld,
  readLoad1,
} from "../capacity/host-load.js";
import type { ResolvedProject } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { type Harness, type Json, startHarness } from "../routing/fixtures/harness.js";
import { WorkspaceManager } from "../workspace/index.js";
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
const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gateOf = (load: () => number, recheckMs = 20): HostLoadGate => ({
  maxLoad1: 10,
  resumeLoad1: 8,
  reader: { load1: load },
  recheckMs,
});

describe("hysteresis (T3.24, FR-CAP-12)", () => {
  const gate = { maxLoad1: 10, resumeLoad1: 8 };
  it("starts above the maximum, holds between the two values and ends below the resume value", () => {
    expect(nextLoadHeld(false, 9, gate)).toBe(false);
    expect(nextLoadHeld(false, 10, gate)).toBe(false);
    expect(nextLoadHeld(false, 10.5, gate)).toBe(true);
    expect(nextLoadHeld(true, 9, gate)).toBe(true);
    expect(nextLoadHeld(true, 8, gate)).toBe(true);
    expect(nextLoadHeld(true, 7.9, gate)).toBe(false);
  });
  it("an unreadable load never holds and ends a hold", () => {
    expect(nextLoadHeld(false, null, gate)).toBe(false);
    expect(nextLoadHeld(true, null, gate)).toBe(false);
    expect(
      readLoad1({
        load1: () => {
          throw new Error("no /proc");
        },
      }),
    ).toBeNull();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) expect(readLoad1({ load1: () => bad })).toBeNull();
    expect(readLoad1({ load1: () => 3.5 })).toBe(3.5);
  });
});

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle | undefined;

function makeLifecycle(hostLoad?: HostLoadGate, scenario: FakeScenario = "success"): RunLifecycle {
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids: createIdGenerator() });
  return new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(new FakeAdapter({ timeouts: PATIENT, scenario })),
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
    ...(hostLoad !== undefined ? { hostLoad } : {}),
  });
}

const live = (): RunLifecycle => {
  if (!lifecycle) throw new Error("no lifecycle");
  return lifecycle;
};
const submit = (extra: { light?: boolean } = {}) =>
  live().submit({
    clientId: "c",
    objective: "do the task",
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    ...extra,
  });
const events = (runId: string) => ledger.listRunEvents(runId).map((e) => e.type);
const ofType = (runId: string, type: string) => ledger.listRunEvents(runId).filter((e) => e.type === type);
const stateOf = (runId: string) => ledger.getRunRecord(runId)?.state;
async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(10);
  }
}

describe("host load hold through the lifecycle (T3.24, FR-CAP-12)", () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-host-load-")));
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

  it("above max a run stays QUEUED with one load_hold; between resume and max it stays held; below resume it is admitted", async () => {
    let load = 12;
    let reads = 0;
    lifecycle = makeLifecycle(
      gateOf(() => {
        reads++;
        return load;
      }),
    );
    live().start();
    const r = await submit();
    expect(r.state).toBe("QUEUED");
    await until(() => reads > 2);
    expect(stateOf(r.runId)).toBe("QUEUED");
    const held = ofType(r.runId, LOAD_HOLD_EVENT);
    expect(held).toHaveLength(1);
    expect(JSON.parse(held[0]?.payload_json ?? "{}")).toEqual({
      reason: "LOAD_ABOVE_MAX",
      load1: 12,
      max: 10,
      resume: 8,
    });

    // Hysteresis: below the maximum but not below the resume value, the hold continues (no new event, no release).
    load = 9;
    const before = reads;
    await until(() => reads > before + 2);
    expect(stateOf(r.runId)).toBe("QUEUED");
    expect(ofType(r.runId, LOAD_HOLD_EVENT)).toHaveLength(1);
    expect(ofType(r.runId, LOAD_RELEASE_EVENT)).toHaveLength(0);

    load = 7;
    expect((await live().waitForTerminal(r.runId)).state).toBe("SUCCEEDED");
    expect(ofType(r.runId, LOAD_RELEASE_EVENT).map((e) => JSON.parse(e.payload_json))).toEqual([{ load1: 7 }]);
    const order = events(r.runId);
    expect(order.indexOf(LOAD_RELEASE_EVENT)).toBeLessThan(order.lastIndexOf("state_transition"));
  });

  it("a load between resume and max does not start a hold", async () => {
    lifecycle = makeLifecycle(gateOf(() => 9.5));
    live().start();
    const r = await submit();
    expect((await live().waitForTerminal(r.runId)).state).toBe("SUCCEEDED");
    expect(ofType(r.runId, LOAD_HOLD_EVENT)).toHaveLength(0);
  });

  it("never stops a running run: a run already RUNNING keeps running while a new one is held", async () => {
    let load = 1;
    lifecycle = makeLifecycle(
      gateOf(() => load),
      "hang",
    );
    live().start();
    const running = await submit();
    await until(() => stateOf(running.runId) === "RUNNING");
    load = 50;
    const queued = await submit();
    await until(() => ofType(queued.runId, LOAD_HOLD_EVENT).length === 1);
    await sleep(100);
    expect(stateOf(running.runId)).toBe("RUNNING");
    expect(ofType(running.runId, LOAD_HOLD_EVENT)).toHaveLength(0);
    expect(events(running.runId)).not.toContain("cancel_requested");
    expect(stateOf(queued.runId)).toBe("QUEUED");
    await live().cancel(queued.runId);
    await live().cancel(running.runId);
    expect((await live().waitForTerminal(running.runId)).state).toBe("CANCELLED");
  });

  it("a light run is admitted while held; a plain one submitted with it stays held", async () => {
    lifecycle = makeLifecycle(gateOf(() => 40));
    live().start();
    const plain = await submit();
    const light = await submit({ light: true });
    expect(ofType(light.runId, LIGHT_RUN_EVENT)).toHaveLength(1);
    expect((await live().waitForTerminal(light.runId)).state).toBe("SUCCEEDED");
    expect(ofType(light.runId, LOAD_HOLD_EVENT)).toHaveLength(0);
    expect(stateOf(plain.runId)).toBe("QUEUED");
    expect(ofType(plain.runId, LOAD_HOLD_EVENT)).toHaveLength(1);
  });

  it("an unreadable load never holds", async () => {
    lifecycle = makeLifecycle(
      gateOf(() => {
        throw new Error("loadavg unavailable");
      }),
    );
    live().start();
    const r = await submit();
    expect((await live().waitForTerminal(r.runId)).state).toBe("SUCCEEDED");
    expect(ofType(r.runId, LOAD_HOLD_EVENT)).toHaveLength(0);
  });

  it("an open hold left by an earlier process is adopted after a restart, so hysteresis holds across it", async () => {
    let load = 20;
    lifecycle = makeLifecycle(gateOf(() => load));
    live().start();
    const r = await submit();
    await until(() => ofType(r.runId, LOAD_HOLD_EVENT).length === 1);
    await live().shutdown();
    load = 9; // between resume and max: a fresh process must not treat this as "no hold"
    lifecycle = makeLifecycle(gateOf(() => load));
    live().start();
    await sleep(120);
    expect(stateOf(r.runId)).toBe("QUEUED");
    expect(ofType(r.runId, LOAD_HOLD_EVENT)).toHaveLength(1);
    load = 1;
    expect((await live().waitForTerminal(r.runId)).state).toBe("SUCCEEDED");
    expect(ofType(r.runId, LOAD_RELEASE_EVENT)).toHaveLength(1);
  });

  it("without the option the reader is never called and a run's events equal those under a low load (main behaviour)", async () => {
    lifecycle = makeLifecycle();
    live().start();
    const plain = await submit();
    expect((await live().waitForTerminal(plain.runId)).state).toBe("SUCCEEDED");
    const plainEvents = events(plain.runId);
    expect(plainEvents).not.toContain(LOAD_HOLD_EVENT);
    await live().shutdown();

    let reads = 0;
    lifecycle = makeLifecycle(
      gateOf(() => {
        reads++;
        return 0.5;
      }),
    );
    live().start();
    const low = await submit();
    expect((await live().waitForTerminal(low.runId)).state).toBe("SUCCEEDED");
    expect(reads).toBeGreaterThan(0);
    expect(events(low.runId)).toEqual(plainEvents);
  });
});

function project(id: string, dir: string): ResolvedProject {
  return {
    id,
    name: id,
    environment: { kind: "host" },
    contexts: [
      {
        id: "main",
        kind: "repository",
        path: dir,
        baseRef: "main",
        primary: true,
        writable: true,
        push: { policy: "none" },
        sign: false,
        finalizeCommit: false,
      },
    ],
  };
}

describe("host load hold over MCP (T3.24: held_load on get_run and get_digest, allow_light)", () => {
  let h: Harness;
  let projectRoot: string;
  let load = 30;
  beforeEach(async () => {
    load = 30;
    projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-host-load-mcp-")));
    const web = path.join(projectRoot, "web");
    mkdirSync(web);
    g(web, "init", "-q", "-b", "main");
    writeFileSync(path.join(web, "README.md"), "hello\n");
    g(web, "add", "-A");
    g(web, "commit", "-q", "-m", "init");
    const edit: TrustProfile = "edit-untrusted";
    h = await startHarness({
      allowedRoots: [projectRoot],
      lifecycle: { hostLoad: gateOf(() => load) },
      config: {
        projects: [project("web", web)],
        mcpClients: new Map([
          ["orch", { id: "orch", maxTrustProfile: edit, projects: ["web"], allowLight: true }],
          ["other", { id: "other", maxTrustProfile: edit, projects: ["web"] }],
        ]),
      },
    });
  });
  afterEach(async () => {
    await h.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const delegate = (clientId: string, extra: Json = {}) =>
    h.ok(
      "delegate_task",
      { objective: "Fix the parser crash", project: "web", trust_profile: "edit-untrusted", ...extra },
      clientId,
    ) as Promise<{ run_id: string; status: string }>;

  it("a held run shows held_load in get_run and get_digest; lowering the load admits it and clears both", async () => {
    const body = await delegate("orch");
    expect(body.status).toBe("QUEUED");
    await h.waitFor(() => h.ledger.listRunEvents(body.run_id).some((e) => e.type === LOAD_HOLD_EVENT));
    const shown = (await h.ok("get_run", { run_id: body.run_id })) as { status: string; hold?: unknown };
    expect(shown.status).toBe("QUEUED");
    expect(shown.hold).toMatchObject({ reason: "held_load" });
    const digest = (await h.ok("get_digest", {}, "orch")) as {
      projects: { project_id: string; held?: { run_id: string; reason: string }[]; needs_attention: unknown[] }[];
    };
    const web = digest.projects.find((p) => p.project_id === "web");
    expect(web?.held?.map((x) => [x.run_id, x.reason])).toEqual([[body.run_id, "held_load"]]);
    expect(web?.needs_attention).toEqual([]);

    load = 1;
    await h.lifecycle.waitForTerminal(body.run_id);
    const after = (await h.ok("get_run", { run_id: body.run_id })) as { status: string; hold?: unknown };
    expect(after.status).toBe("SUCCEEDED");
    expect(after.hold).toBeUndefined();
    const later = (await h.ok("get_digest", {}, "orch")) as { projects: { project_id: string; held?: unknown }[] };
    expect(later.projects.find((p) => p.project_id === "web")?.held).toBeUndefined();
  });

  it("light from a client with allow_light is admitted while held; light from a client without it is ignored", async () => {
    const allowed = await delegate("orch", { light: true });
    const ignored = await delegate("other", { light: true });
    expect((await h.lifecycle.waitForTerminal(allowed.run_id)).state).toBe("SUCCEEDED");
    expect(h.ledger.listRunEvents(allowed.run_id).some((e) => e.type === LIGHT_RUN_EVENT)).toBe(true);
    await h.waitFor(() => h.ledger.listRunEvents(ignored.run_id).some((e) => e.type === LOAD_HOLD_EVENT));
    expect(h.ledger.getRunRecord(ignored.run_id)?.state).toBe("QUEUED");
    expect(h.ledger.listRunEvents(ignored.run_id).some((e) => e.type === LIGHT_RUN_EVENT)).toBe(false);
    load = 1;
    expect((await h.lifecycle.waitForTerminal(ignored.run_id)).state).toBe("SUCCEEDED");
  });
});
