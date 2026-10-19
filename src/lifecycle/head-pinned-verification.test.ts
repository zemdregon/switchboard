/**
 * T8.10 end to end (FR-EXE-10, FR-SKL-11, FR-EXE-08, LLD §20.6): the fake adapter plays the agent, the lifecycle pins the
 * commit and tree before VERIFYING, records a `verification_result` keyed by `(publish_ref, head_sha)`, and the
 * `get_run` envelope exposes `verification.verified_at_sha` with `stale` computed on read. A docs-alignment run's report
 * is taken out of the worktree, stored as an artifact and reported, and never committed or pushed. Real Git in temporary
 * directories; no provider CLI, login, network or credential.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScenario } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { publishRefFor } from "../git/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { buildEnvelope } from "../mcp/envelope.js";
import { WorkspaceManager } from "../workspace/index.js";
import { DOCS_ALIGNMENT_EVENT, DOCS_ALIGNMENT_FILE } from "./docs-alignment.js";
import { RunLifecycle, type SkillAdmissionPort } from "./index.js";

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
const NODE = process.execPath;
const PASS = [NODE, "-e", "process.exit(0)"];
/** A planted string: it may appear only in the stored report, never in an event (notes are untrusted). */
const NOTES_CANARY = "CANARY-docs-notes-5e1b";

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

/** A stub of the T16.4 port that pins `docs-alignment` (the store path itself is tested in `src/skills/`). */
const DOCS_SKILL: SkillAdmissionPort = {
  fields: { skills: ["docs-alignment"] },
  resolve: () => ({
    event: {
      entries: [{ name: "docs-alignment", version: 1, sha256: "a".repeat(64), source: "request" }],
      skipped: [],
    },
    write: () => {},
  }),
};

let root: string;
let repo: string;
let base: string;
let db: Database.Database;
let ledger: Ledger;
let artifacts: ArtifactStore;
let lifecycle: RunLifecycle | undefined;

function makeLifecycle(scenario: FakeScenario): RunLifecycle {
  const ids = createIdGenerator();
  const dataDir = path.join(root, "data");
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  const lc = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(new FakeAdapter({ scenario, timeouts: PATIENT })),
    allowedRoots: [root],
    globalConcurrency: 2,
    resolveProfile: profileFor,
  });
  lc.start();
  lifecycle = lc;
  return lc;
}

async function run(
  scenario: FakeScenario,
  opts: { plan?: object; verify?: string[][]; skills?: SkillAdmissionPort } = {},
): Promise<string> {
  const lc = makeLifecycle(scenario);
  const { runId } = await lc.submit({
    clientId: "c",
    objective: opts.plan ? JSON.stringify(opts.plan) : "do the work",
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    verificationCommands: opts.verify ?? [PASS],
    ...(opts.skills ? { skills: opts.skills } : {}),
  });
  await lc.waitForTerminal(runId);
  return runId;
}

const envelope = (runId: string) =>
  buildEnvelope(ledger, ledger.getRunRecord(runId) as NonNullable<ReturnType<Ledger["getRunRecord"]>>, (s) => s);
const eventsOf = (runId: string, type: string) =>
  ledger
    .listRunEvents(runId)
    .filter((e) => e.type === type)
    .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);
async function testReport(runId: string): Promise<Record<string, unknown>> {
  const row = ledger.listArtifactsForRun(runId).find((a) => a.kind === "test_report");
  expect(row).toBeDefined();
  return JSON.parse((await artifacts.get((row as { sha256: string }).sha256)).toString("utf8"));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-pinned-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  base = g(repo, "rev-parse", "HEAD");
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("head-pinned verification evidence (T8.10, FR-EXE-10, LLD §20.6)", () => {
  it("a result carries the SHA and tree it ran on, keyed by (publish_ref, head_sha); get_run shows it current", async () => {
    const runId = await run("success");
    expect(ledger.getRunRecord(runId)?.state).toBe("SUCCEEDED");
    const tree = g(repo, "rev-parse", `${base}^{tree}`);

    const report = await testReport(runId);
    expect(report).toMatchObject({ outcome: "passed", head_sha: base, tree_sha: tree });

    const publishRef = publishRefFor(ledger.getRunRecord(runId)?.meta_session_id as string);
    const rows = ledger.listVerificationResultsAt(publishRef, base);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ run_id: runId, head_sha: base, tree_sha: tree, outcome: "passed" });
    expect(rows[0]?.artifact_id).toBe(envelope(runId).artifacts.test_report);

    expect(envelope(runId).verification).toEqual({ verified_at_sha: base, tree_sha: tree, stale: false });
  });

  it("a dirty worktree records a tree but no SHA, and the result is never current", async () => {
    const runId = await run("edit_files", { plan: { files: { "new.txt": "dirty\n" }, summary: "edited" } });
    const report = await testReport(runId);
    expect(report.head_sha).toBeNull();
    expect(report.tree_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(report.tree_sha).not.toBe(g(repo, "rev-parse", `${base}^{tree}`));
    expect(ledger.latestVerificationResult(runId)).toMatchObject({ head_sha: null });
    expect(envelope(runId).verification).toMatchObject({ verified_at_sha: null, stale: true });
  });

  it("a new commit on the run's published ref makes the result stale in get_run", async () => {
    const runId = await run("success");
    expect(envelope(runId).verification?.stale).toBe(false);
    const rec = ledger.getRunRecord(runId) as NonNullable<ReturnType<Ledger["getRunRecord"]>>;
    const publishRef = publishRefFor(rec.meta_session_id);
    writeFileSync(path.join(repo, "later.txt"), "later\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "later");
    const moved = g(repo, "rev-parse", "HEAD");
    ledger.recordGitCommit({
      commitSha: moved,
      treeSha: g(repo, "rev-parse", "HEAD^{tree}"),
      repoRoot: repo,
      publishRef,
      projectId: "proj",
      contextId: "ctx",
      metaSessionId: rec.meta_session_id,
      runId,
      provider: "fake",
      harness: "fake",
      origin: "commit_tool",
      sanitizer: { rules: {} },
      eventPayload: { commit_sha: moved },
    });
    expect(envelope(runId).verification).toMatchObject({ verified_at_sha: base, stale: true });
    // The evidence itself is unchanged: still recorded at the old head, not at the new one.
    expect(ledger.listVerificationResultsAt(publishRef, base)).toHaveLength(1);
    expect(ledger.listVerificationResultsAt(publishRef, moved)).toHaveLength(0);
  });

  it("a run without verification commands records no result and get_run has no verification pin", async () => {
    const runId = await run("success", { verify: [] });
    expect(ledger.latestVerificationResult(runId)).toBeUndefined();
    expect(envelope(runId).verification).toBeUndefined();
  });
});

describe("docs-alignment report (T8.10, FR-SKL-11, LLD §20.6)", () => {
  const conflict = () => ({
    files: {
      [DOCS_ALIGNMENT_FILE]: JSON.stringify({
        head_sha: base,
        verdict: "conflict",
        notes: `README claims a flag the CLI does not have. ${NOTES_CANARY}`,
      }),
    },
    summary: "checked",
  });

  it("a conflict is reported and stored, and the report never reaches a commit, a ref or a push", async () => {
    const runId = await run("edit_files", { plan: conflict(), skills: DOCS_SKILL });
    expect(ledger.getRunRecord(runId)?.state).toBe("SUCCEEDED");

    const [event] = eventsOf(runId, DOCS_ALIGNMENT_EVENT);
    expect(event).toMatchObject({ present: true, valid: true, verdict: "conflict", head_sha: base });
    const all = JSON.stringify(ledger.listRunEvents(runId));
    expect(all).not.toContain(NOTES_CANARY);

    const art = ledger.listArtifactsForRun(runId).find((a) => a.kind === "docs_alignment");
    expect(art?.id).toBe(event?.artifact_id);
    expect(envelope(runId).artifacts.docs_alignment).toBe(art?.id);
    const stored = JSON.parse((await artifacts.get((art as { sha256: string }).sha256)).toString("utf8"));
    expect(stored).toMatchObject({ v: 1, verdict: "conflict", head_sha: base });
    expect(stored.notes).toContain(NOTES_CANARY);

    // Taken out of the worktree before verification: the pin is clean, so verification is at the base commit.
    const worktree = ledger.getRunRecord(runId)?.worktree_path as string;
    expect(existsSync(path.join(worktree, DOCS_ALIGNMENT_FILE))).toBe(false);
    expect(envelope(runId).verification).toMatchObject({ verified_at_sha: base, stale: false });

    // Reported, never acted on: no commit, no publish ref, no push, and the protected branch is where it was.
    expect(ledger.listGitCommits(runId)).toHaveLength(0);
    expect(eventsOf(runId, "git_push")).toHaveLength(0);
    const publishRef = publishRefFor(ledger.getRunRecord(runId)?.meta_session_id as string);
    expect(g(repo, "for-each-ref", "--format=%(refname)", publishRef)).toBe("");
    expect(g(repo, "rev-parse", "refs/heads/main")).toBe(base);
  });

  it("a malformed report is recorded as invalid and stored nowhere", async () => {
    const plan = { files: { [DOCS_ALIGNMENT_FILE]: `{"head_sha":"${base}","verdict":"maybe","notes":""}` } };
    const runId = await run("edit_files", { plan, skills: DOCS_SKILL });
    expect(eventsOf(runId, DOCS_ALIGNMENT_EVENT)).toEqual([{ present: true, valid: false }]);
    expect(ledger.listArtifactsForRun(runId).some((a) => a.kind === "docs_alignment")).toBe(false);
  });

  it("a run without the skill never inspects or removes a docs_alignment.json", async () => {
    const runId = await run("edit_files", { plan: conflict() });
    expect(eventsOf(runId, DOCS_ALIGNMENT_EVENT)).toHaveLength(0);
    const worktree = ledger.getRunRecord(runId)?.worktree_path as string;
    expect(existsSync(path.join(worktree, DOCS_ALIGNMENT_FILE))).toBe(true);
    // The file is part of the worktree's tree, so this run's verification records no SHA.
    expect(envelope(runId).verification).toMatchObject({ verified_at_sha: null, stale: true });
  });
});
