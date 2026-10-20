/**
 * Idle timeout end to end (FR-EXE-01, FR-CTL-03; regression of prod run run_01M5BZDDH2S2ANYFX32R337ER5, whose provider
 * reported success, stayed alive on a background shell and was failed PROCESS_TIMEOUT "idle timeout" five minutes
 * later, so nothing was published). The fake adapter plays the agent with the `edit_files` plan: `linger` reports the
 * result and stays alive, `stall` goes quiet before any result. Real Git in temporary directories; no provider CLI,
 * login, network or credential.
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
import { createLedger, type Ledger, openLedger, type RunRecord, type TrustProfile } from "../ledger/index.js";
import { buildEnvelope } from "../mcp/envelope.js";
import type { ProjectSnapshot } from "../policy/types.js";
import { WorkspaceManager } from "../workspace/index.js";
import { type NeedsAttentionNotice, RunLifecycle } from "./index.js";

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

const SHORT_IDLE = { wallClockMs: 60_000, idleMs: 400, killGraceMs: 300 };
const PATIENT = { wallClockMs: 60_000, idleMs: 60_000, killGraceMs: 300 };
const PROJECT: ProjectSnapshot = {
  id: "web",
  name: "Web",
  environment_kind: "host",
  context_id: "main",
  base_ref: "main",
  effective_max_profile: "edit-untrusted",
  writable: true,
  push: { policy: "none" },
};

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

let root: string;
let repo: string;
let db: Database.Database;
let ledger: Ledger;
let artifacts: ArtifactStore;
let lifecycle: RunLifecycle | undefined;
let notices: NeedsAttentionNotice[];

async function run(
  plan: object,
  opts: { timeouts?: typeof SHORT_IDLE; project?: ProjectSnapshot } = {},
): Promise<RunRecord> {
  const ids = createIdGenerator();
  const dataDir = path.join(root, "data");
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  const lc = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(
      new FakeAdapter({ scenario: "edit_files", timeouts: opts.timeouts ?? SHORT_IDLE }),
    ),
    allowedRoots: [root],
    globalConcurrency: 2,
    resolveProfile: profileFor,
    onNeedsAttention: (n) => notices.push(n),
  });
  lc.start();
  lifecycle = lc;
  const { runId } = await lc.submit({
    clientId: "c",
    objective: JSON.stringify(plan),
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    ...(opts.project ? { project: opts.project } : {}),
  });
  await lc.waitForTerminal(runId);
  return ledger.getRunRecord(runId) as RunRecord;
}

const eventsOf = (runId: string, type: string) =>
  ledger
    .listRunEvents(runId)
    .filter((e) => e.type === type)
    .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);

async function diffOf(runId: string): Promise<string> {
  const row = ledger.listArtifactsForRun(runId).find((a) => a.kind === "diff");
  expect(row).toBeDefined();
  return (await artifacts.get((row as { sha256: string }).sha256)).toString("utf8");
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-idle-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  notices = [];
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("idle timeout after a final successful result (FR-EXE-01)", () => {
  it("succeeds with the work kept and records the bound that ended the lingering process", async () => {
    const r = await run({ files: { "feature.txt": "done\n" }, summary: "work complete", linger: true });
    expect(r.state).toBe("SUCCEEDED");
    expect(r.failure_code).toBeNull();
    const toFinalizing = eventsOf(r.id, "state_transition").find((e) => e.to === "FINALIZING");
    expect(toFinalizing).toMatchObject({ rule: "T12", exit_outcome: "timeout", settled_after_result: "idle" });
    expect(await diffOf(r.id)).toContain("feature.txt");
    expect(eventsOf(r.id, "rollback")).toEqual([]);
    expect(notices).toEqual([]);
  });
});

describe("idle timeout before any result (FR-EXE-01, FR-CTL-03)", () => {
  it("fails PROCESS_TIMEOUT, keeps the diff and evidence commit, and shows needs_attention idle_timeout_work_kept", async () => {
    const r = await run({ files: { "feature.txt": "half\n" }, stall: true });
    expect(r).toMatchObject({ state: "FAILED", failure_code: "PROCESS_TIMEOUT", failure_detail: "idle timeout" });
    expect(await diffOf(r.id)).toContain("feature.txt");
    const [rollback] = eventsOf(r.id, "rollback");
    expect(g(repo, "show", `${rollback?.evidence_commit as string}:feature.txt`)).toBe("half");
    const envelope = buildEnvelope(ledger, r, (s) => s, { now: new Date() });
    expect(envelope.needs_attention).toEqual({ active: true, reason: "idle_timeout_work_kept" });
    expect(notices).toEqual([{ runId: r.id, projectId: null, reason: "idle_timeout_work_kept" }]);
  });

  it("an idle timeout with no changes fails without the flag", async () => {
    const r = await run({ files: {}, stall: true });
    expect(r).toMatchObject({ state: "FAILED", failure_code: "PROCESS_TIMEOUT" });
    expect(buildEnvelope(ledger, r, (s) => s, { now: new Date() }).needs_attention).toEqual({ active: false });
    expect(notices).toEqual([]);
  });
});

describe("projects[].timeouts.provider_idle_seconds (FR-EXE-01)", () => {
  it("the frozen project idle window replaces the adapter's", async () => {
    const started = Date.now();
    const r = await run(
      { files: { "feature.txt": "half\n" }, stall: true },
      { timeouts: PATIENT, project: { ...PROJECT, provider_idle_ms: 500 } },
    );
    expect(r).toMatchObject({ state: "FAILED", failure_code: "PROCESS_TIMEOUT", failure_detail: "idle timeout" });
    expect(Date.now() - started).toBeLessThan(30_000); // the adapter's 60 s window would still be open
  });
});
