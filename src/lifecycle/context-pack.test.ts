/**
 * Context pack at dispatch (T12.5; FR-RAG-05, FR-RAG-08, LLD §14.6, §14.8). The lifecycle sees retrieval only through
 * its `contextPack` port; these tests drive it with stub ports (the retrieval service itself is tested in
 * `src/retrieval/admission.test.ts`, and its `serve` wiring in `src/cli/rag-index.test.ts`).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type CompileRequest, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import type { ProjectSnapshot } from "../policy/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import {
  CONTEXT_PACK_GRACE_MS,
  type ContextPackPort,
  type ContextPackRequest,
  RAG_RETRIEVAL_EVENT,
  RunLifecycle,
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

const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});
const PROJECT: ProjectSnapshot = {
  id: "web",
  name: "Web",
  environment_kind: "host",
  context_id: "main",
  base_ref: "main",
  effective_max_profile: "trusted-development",
};

/** The fake CLI's `success` scenario, recording the objective each compile received. */
class RecordingAdapter extends FakeAdapter {
  readonly objectives: string[] = [];
  constructor() {
    super({ scenario: "success", timeouts: PATIENT });
  }
  override compile(req: CompileRequest, profile: ResolvedProfile) {
    this.objectives.push(req.objective);
    return super.compile(req, profile);
  }
}

const OBJECTIVE = "Fix the parser in src/parse.ts";
const PACK = "<switchboard-context-pack n>\nUNTRUSTED REFERENCE DATA\n</switchboard-context-pack n>";

let root: string;
let repo: string;
let db: Database.Database;
let ledger: Ledger;
let adapter: RecordingAdapter;
let lifecycle: RunLifecycle | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-pack-")));
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
  adapter = new RecordingAdapter();
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function start(contextPack: ContextPackPort | undefined): RunLifecycle {
  const ids = createIdGenerator();
  const dataDir = path.join(root, "data");
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  lifecycle = new RunLifecycle({
    ledger,
    workspace: new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids }),
    artifacts,
    adapters: new AdapterRegistry().register(adapter),
    allowedRoots: [root],
    globalConcurrency: 2,
    resolveProfile: profileFor,
    ...(contextPack !== undefined ? { contextPack } : {}),
  });
  lifecycle.start();
  return lifecycle;
}

async function runToEnd(l: RunLifecycle, withProject = true) {
  const { runId } = await l.submit({
    clientId: "c",
    objective: OBJECTIVE,
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    ...(withProject ? { project: PROJECT } : {}),
  });
  const final = await l.waitForTerminal(runId);
  return { runId, final };
}

const storedObjective = (runId: string) =>
  (JSON.parse(ledger.getRunRecord(runId)?.request_json ?? "{}") as { objective: string }).objective;
const packEvents = (runId: string) =>
  ledger
    .listRunEvents(runId)
    .filter((e) => e.type === RAG_RETRIEVAL_EVENT)
    .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);

describe("context pack at dispatch (T12.5)", () => {
  it("appends the pack to the compiled prompt only; the stored request text is unchanged", async () => {
    const seen: ContextPackRequest[] = [];
    const l = start({
      timeoutMs: 1000,
      prepare: async (r) => {
        seen.push(r);
        return { text: PACK, event: { record_id: "rag_x", outcome: "ok", snippets: 1 } };
      },
    });
    const { runId, final } = await runToEnd(l);
    expect(final.state).toBe("SUCCEEDED");
    expect(adapter.objectives).toEqual([`${OBJECTIVE}\n\n${PACK}`]);
    expect(storedObjective(runId)).toBe(OBJECTIVE);
    expect(packEvents(runId)).toEqual([{ record_id: "rag_x", outcome: "ok", snippets: 1 }]);
    // The port got the stored request, the project, and the worktree with its base commit.
    expect(seen).toHaveLength(1);
    const run = ledger.getRunRecord(runId);
    expect(seen[0]).toMatchObject({ runId, projectId: "web", objective: OBJECTIVE, primaryRoot: run?.worktree_path });
    expect(seen[0]?.baseCommit).toBe(g(repo, "rev-parse", "HEAD"));
  });

  it("a port that throws leaves the run unaffected: no pack, SUCCEEDED, an `unavailable` event", async () => {
    const l = start({
      timeoutMs: 1000,
      prepare: async () => {
        throw new Error("store exploded");
      },
    });
    const { runId, final } = await runToEnd(l);
    expect(final.state).toBe("SUCCEEDED");
    expect(final.failure_code ?? null).toBeNull();
    expect(adapter.objectives).toEqual([OBJECTIVE]);
    expect(packEvents(runId)).toEqual([{ outcome: "unavailable", reason: "RETRIEVAL_ERROR" }]);
  });

  it("a port that never answers delays dispatch by at most its timeout plus the grace, then runs without a pack", async () => {
    let aborted = false;
    const l = start({
      timeoutMs: 50,
      prepare: (r) =>
        new Promise(() => {
          r.signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    });
    const t0 = Date.now();
    const { runId, final } = await runToEnd(l);
    expect(final.state).toBe("SUCCEEDED");
    expect(adapter.objectives).toEqual([OBJECTIVE]);
    expect(packEvents(runId)).toEqual([{ outcome: "unavailable", reason: "TIMEOUT" }]);
    expect(aborted).toBe(true);
    // Generous bound for a loaded CI machine; the wait itself is 50 + CONTEXT_PACK_GRACE_MS.
    expect(Date.now() - t0).toBeLessThan(30_000 + CONTEXT_PACK_GRACE_MS);
  });

  it("an empty or absent pack compiles the request as is", async () => {
    const l = start({
      timeoutMs: 1000,
      prepare: async () => ({ text: null, event: { outcome: "stale", reason: "MAX_STALENESS" } }),
    });
    const { runId, final } = await runToEnd(l);
    expect(final.state).toBe("SUCCEEDED");
    expect(adapter.objectives).toEqual([OBJECTIVE]);
    expect(packEvents(runId)).toEqual([{ outcome: "stale", reason: "MAX_STALENESS" }]);
  });

  it("an inert port (undefined) writes no event", async () => {
    const l = start({ timeoutMs: 1000, prepare: async () => undefined });
    const { runId, final } = await runToEnd(l);
    expect(final.state).toBe("SUCCEEDED");
    expect(adapter.objectives).toEqual([OBJECTIVE]);
    expect(packEvents(runId)).toEqual([]);
  });

  it("a run without a project is never asked about", async () => {
    let calls = 0;
    const l = start({
      timeoutMs: 1000,
      prepare: async () => {
        calls += 1;
        return { text: PACK, event: {} };
      },
    });
    const { runId, final } = await runToEnd(l, false);
    expect(final.state).toBe("SUCCEEDED");
    expect(calls).toBe(0);
    expect(adapter.objectives).toEqual([OBJECTIVE]);
    expect(packEvents(runId)).toEqual([]);
  });
});
