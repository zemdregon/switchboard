/**
 * Per-provider concurrency limits (T6.9; NFR-PERF-03 "per provider", FR-CAP-04, LLD §16.1). Two fake providers with
 * different limits; runs that never finish hold their slots. No provider CLI, no network.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ProviderAdapter, type ProviderId, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { capacityProviders } from "../capacity/index.js";
import { providerLimits } from "../cli/serve.js";
import { loadConfig } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { RunLifecycle, type RunLifecycleOptions } from "./index.js";
import { SLOT_STATES } from "./states.js";

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
const LONG = { wallClockMs: 60_000, idleMs: 60_000, killGraceMs: 300 };
const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

/** A fake adapter under another provider id whose runs hang (they hold a slot until cancelled). */
function hanging(id: string): ProviderAdapter {
  const base = new FakeAdapter({ scenario: "hang", timeouts: LONG });
  return {
    id: id as ProviderId,
    transports: base.transports,
    gitWriteControl: base.gitWriteControl,
    resumeCwd: base.resumeCwd,
    gitCapabilities: { commitChannel: "none", detail: "test double" },
    probe: (r) => base.probe(r),
    authPreflight: (r) => base.authPreflight(r),
    compile: (req, p) => base.compile(req, p),
    resumeArgs: (b, req, p) => base.resumeArgs(b, req, p),
    parseEvent: (i, s) => base.parseEvent(i, s),
    extractResult: (e, x) => base.extractResult(e, x),
    classifyFailure: (e) => base.classifyFailure(e),
  };
}

let root: string;
let repos: string[];
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle | undefined;

function makeLifecycle(over: Partial<RunLifecycleOptions>): RunLifecycle {
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids: createIdGenerator() });
  return new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(hanging("fake")).register(hanging("fake-b")),
    allowedRoots: [root],
    globalConcurrency: 8,
    perProviderConcurrency: 1,
    resolveProfile: profileFor,
    ...over,
  });
}
const live = () => {
  if (!lifecycle) throw new Error("no lifecycle");
  return lifecycle;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inSlots = (provider?: string) => ledger.countRunsInStates(SLOT_STATES, provider);

/** Three runs per provider, each in its own repository (one write lease per meta-session, so they can run at once). */
async function submitThreeEach(): Promise<void> {
  let i = 0;
  for (const provider of ["fake", "fake-b"] as ProviderId[]) {
    for (let k = 0; k < 3; k++) {
      await live().submit({
        clientId: "c",
        objective: "hold",
        workspace: repos[i++] as string,
        trustProfile: "edit-untrusted",
        provider,
      });
    }
  }
  await sleep(1500);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-conc-")));
  repos = [];
  for (let i = 0; i < 6; i++) {
    const repo = path.join(root, `repo${i}`);
    mkdirSync(repo);
    g(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "init");
    repos.push(repo);
  }
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

describe("per-provider concurrency (T6.9)", () => {
  it("two providers with different limits run that many at once each", async () => {
    lifecycle = makeLifecycle({ perProviderLimits: new Map([["fake", 2]]) });
    live().start();
    await submitThreeEach();
    expect(inSlots("fake")).toBe(2);
    expect(inSlots("fake-b")).toBe(1); // falls back to perProviderConcurrency
    expect(ledger.countRunsInStates(["QUEUED"])).toBe(3);
  });

  it("the default stays one per provider", async () => {
    lifecycle = makeLifecycle({});
    live().start();
    await submitThreeEach();
    expect(inSlots("fake")).toBe(1);
    expect(inSlots("fake-b")).toBe(1);
  });

  it("the global limit still caps the total", async () => {
    lifecycle = makeLifecycle({
      globalConcurrency: 2,
      perProviderLimits: new Map([
        ["fake", 3],
        ["fake-b", 3],
      ]),
    });
    live().start();
    await submitThreeEach();
    expect(inSlots()).toBe(2);
  });
});

describe("providers.<id>.concurrency in configuration (T6.9)", () => {
  const write = (providers: unknown, limits?: unknown) => {
    const p = path.join(root, "config.json");
    writeFileSync(
      p,
      JSON.stringify({
        schema_version: 1,
        data_dir: dataDir,
        allowed_roots: [root],
        mcp_clients: [{ id: "c", max_trust_profile: "edit-untrusted" }],
        providers,
        ...(limits !== undefined ? { limits } : {}),
      }),
    );
    return p;
  };

  it("resolves per adapter id for the dispatcher and the capacity view, defaulting to the shared limit", () => {
    const cfg = loadConfig({
      configPath: write(
        { "claude-code": { concurrency: 3 }, codex: { enabled: true } },
        { per_provider_concurrency: 2 },
      ),
    });
    expect([...providerLimits(cfg)]).toEqual([["claude", 3]]);
    expect(capacityProviders(["claude", "codex"], cfg).map((p) => [p.id, p.concurrencyLimit])).toEqual([
      ["claude", 3],
      ["codex", 2],
    ]);
  });

  it("is strict: integers 1 to 64 only", () => {
    for (const bad of [0, 65, 1.5, "2"]) {
      expect(() => loadConfig({ configPath: write({ codex: { concurrency: bad } }) })).toThrow(
        /\$\.providers\.codex\.concurrency/,
      );
    }
  });
});
