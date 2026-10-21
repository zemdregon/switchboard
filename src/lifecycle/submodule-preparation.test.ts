/**
 * ADR-0080 item 3 through the run lifecycle: a submodule refusal while the workspace manager prepares a recursive
 * context's worktree (`SubmodulePreparationError`) fails the run before spawn with the library's closed taxonomy code and
 * `{ reason, path }` details (never a URL), and the lease is released. Real Git against local fixture repositories; the
 * fake adapter; no network, no provider CLI.
 */
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import type { ProjectSnapshot } from "../policy/index.js";
import {
  type Fixture,
  gitmodulesText,
  HOST,
  makeFixture,
  makeRemote,
  makeUmbrella,
  OWNER,
} from "../submodules/fixtures/repos.js";
import { WorkspaceManager } from "../workspace/index.js";
import { RunLifecycle } from "./index.js";

const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});
const PROJECT: ProjectSnapshot = {
  id: "umb",
  name: "Umbrella",
  environment_kind: "host",
  context_id: "main",
  base_ref: "main",
  effective_max_profile: "edit-untrusted",
  writable: true,
  identity: { name: "Ada Maintainer", email: "ada@example.test" },
  push: { policy: "none" },
};

let fx: Fixture;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle | undefined;

beforeEach(() => {
  fx = makeFixture("sb-lc-sub-");
  mkdirSync(path.join(fx.root, "data"));
  db = openLedger(path.join(fx.root, "data"));
  ledger = createLedger(db, { ids: createIdGenerator() });
});
afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  db.close();
  rmSync(fx.root, { recursive: true, force: true });
});

function start(sources: () => Fixture["settings"]): RunLifecycle {
  const dataDir = path.join(fx.root, "data");
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({
    db,
    artifacts,
    dataDir,
    allowedRoots: [fx.root],
    ids: createIdGenerator(),
    submodules: {
      sources,
      git: fx.runner,
      plan: (id) => (id === "umb" ? { writablePaths: ["mods/a"], exclude: [] } : undefined),
    },
  });
  return new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(new FakeAdapter({ timeouts: PATIENT })),
    allowedRoots: [fx.root],
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
  });
}

describe("submodule preparation through the run lifecycle (ADR-0080 item 3)", () => {
  it("a refused submodule source fails the run before spawn with its closed code, reason and path, and releases the lease", async () => {
    const a = makeRemote(fx, "lib-a", { "a.txt": "a\n" });
    const u = makeUmbrella(
      fx,
      { "mods/a": a.head },
      gitmodulesText([["a", "mods/a", `https://${HOST}/${OWNER}/lib-a.git`]]),
    );
    lifecycle = start(() => ({ ...fx.settings, allowedOwners: ["someone-else"] }));
    lifecycle.start();
    const { runId, metaSessionId } = await lifecycle.submit({
      clientId: "c",
      objective: "do the task",
      workspace: u.dir,
      trustProfile: "edit-untrusted",
      provider: "fake",
      project: PROJECT,
    });
    const done = await lifecycle.waitForTerminal(runId);
    expect(done.state).toBe("FAILED");
    expect(done.failure_code).toBe("PERMISSION_BLOCKED");
    expect(done.failure_detail).toContain("workspace preparation failed");
    expect(done.failure_detail).not.toContain(HOST);
    const transitions = ledger
      .listRunEvents(runId)
      .filter((e) => e.type === "state_transition")
      .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);
    expect(transitions.at(-1)).toMatchObject({
      from: "LEASED",
      to: "FAILED",
      reason: "SUBMODULE_SOURCE_NOT_ALLOWED",
      path: "mods/a",
    });
    expect(transitions.some((t) => t.to === "RUNNING")).toBe(false);
    const lease = db.prepare("SELECT lease_run_id FROM meta_session WHERE id = ?").get(metaSessionId) as {
      lease_run_id: string | null;
    };
    expect(lease.lease_run_id).toBeNull();
    expect(fx.calls).toEqual([]);
  });
});
