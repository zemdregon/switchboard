/**
 * `serve`'s composition of the startup container sweep (T10.2; FR-PRJ-07). No container runtime is touched: the runtime
 * is injected. The sweep itself and its ordering are in `src/reconcile/reconcile.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedProject } from "../config/projects.js";
import { type ContainerRuntime, containerName, SWITCHBOARD_RUN_LABEL } from "../environment/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { type Logger, orphanSweepEnvironments } from "./serve.js";

let dir: string;
let db: Database.Database;
let ledger: Ledger;
const warnings: string[] = [];
const log: Logger = { info: () => undefined, warn: (m) => warnings.push(m), error: () => undefined };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-sweep-"));
  db = openLedger(dir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  warnings.length = 0;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const project = (kind: "host" | "container"): ResolvedProject =>
  ({ id: kind, name: kind, environment: { kind } }) as unknown as ResolvedProject;

function runtime(available: boolean, existing: string[]): ContainerRuntime & { removed: string[] } {
  const removed: string[] = [];
  const left = new Set(existing);
  return {
    removed,
    name: "fake",
    clientEnvAllowlist: [],
    info: () =>
      Promise.resolve({ available, rootless: true, serverVersion: null, clientPath: null, detail: "fake runtime" }),
    resolveImage: () => Promise.resolve({ kind: "not_present" }),
    scanImageForGitClient: () => Promise.resolve({ completed: false, found: [], detail: "unused" }),
    runArgv: () => [],
    inspect: () => Promise.resolve(null),
    remove: (name) => {
      const was = left.delete(name);
      if (was) removed.push(name);
      return Promise.resolve({ removed: was });
    },
    listByLabel: () =>
      Promise.resolve(
        [...left].map((name) => ({ name, labels: { [SWITCHBOARD_RUN_LABEL]: name.replace("switchboard-run-", "") } })),
      ),
  };
}

function aRun(): string {
  const sess = ledger.createMetaSession({ objective: "x" });
  return ledger.createRun({
    metaSessionId: sess.id,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {
      objective: "x",
      workspace: dir,
      constraints: [],
      trust_profile: "edit-untrusted",
      provider: "fake",
      priority: "normal",
    },
    requestHash: "h",
    clientId: "c",
    provider: "fake",
  }).id;
}

describe("orphanSweepEnvironments (T10.2)", () => {
  it("composes nothing, and never asks for a runtime, when no project is a container project", async () => {
    let made = 0;
    const envs = await orphanSweepEnvironments({ projects: [project("host")] }, ledger, log, () => {
      made += 1;
      return runtime(true, []);
    });
    expect(envs).toEqual([]);
    expect(made).toBe(0);
  });

  it("skips with a warning when the runtime does not answer", async () => {
    const envs = await orphanSweepEnvironments({ projects: [project("container")] }, ledger, log, () =>
      runtime(false, []),
    );
    expect(envs).toEqual([]);
    expect(warnings).toEqual(["container orphan sweep skipped: no container runtime answered"]);
  });

  it("composes a container environment whose sweep removals land in the ledger as `environment` events", async () => {
    const runId = aRun();
    const rt = runtime(true, [containerName(runId)]);
    const envs = await orphanSweepEnvironments({ projects: [project("container")] }, ledger, log, () => rt);
    expect(envs.map((e) => e.kind)).toEqual(["container"]);
    await envs[0]?.sweepOrphans(new Set());
    expect(rt.removed).toEqual([containerName(runId)]);
    const ev = ledger.listRunEvents(runId).find((e) => e.type === "environment");
    expect(JSON.parse(ev?.payload_json ?? "{}")).toMatchObject({ step: "orphan_removed", kind: "container" });
  });
});
