/**
 * Project brief in the dispatched prompt (T5.14; FR-SES-07, LLD §20.13), through the real lifecycle and the fake
 * adapter, with the port `serve` wires ({@link briefContextPack}) over a stub retrieval port:
 * - with a brief, the prompt carries its labelled block before the retrieved context, inside the shared budget, and the
 *   retrieval port is given the brief's tokens to reserve;
 * - with no brief, the prompt is byte-identical to the one T12.5 compiled (pinned below) and retrieval reserves nothing;
 * - the brief is the one frozen at admission; one that can no longer be found by its hash fails the run closed.
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
import {
  type ContextPackOutcome,
  type ContextPackRequest,
  RAG_RETRIEVAL_EVENT,
  RunLifecycle,
} from "../lifecycle/index.js";
import { admitBrief } from "../mcp/project-tools.js";
import type { ProjectSnapshot } from "../policy/index.js";
import { briefTokens } from "../projects/brief.js";
import { WorkspaceManager } from "../workspace/index.js";
import { briefContextPack } from "./brief-pack.js";

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
const BRIEF = "Goal: ship the parser.\nDone when: npm test passes.\nKnown failures: CANARY-T514-flaky-lexer.\n";
const BUDGET = 4000;
const NONCE = "0123456789abcdef";

let root: string;
let repo: string;
let briefFile: string;
let db: Database.Database;
let ledger: Ledger;
let adapter: RecordingAdapter;
let lifecycle: RunLifecycle | undefined;
let reserved: number[];

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-brief-pack-")));
  repo = path.join(root, "roots", "repo");
  mkdirSync(repo, { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  mkdirSync(path.join(root, "operator"));
  briefFile = path.join(root, "operator", "brief.md");
  writeFileSync(briefFile, BRIEF);
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  adapter = new RecordingAdapter();
  reserved = [];
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const allowedRoots = () => [path.join(root, "roots")];

/** `retrieval`: the stub retrieval port (T12.5's contract); it records the tokens the brief reserved. */
function start(retrieval: (r: ContextPackRequest) => Promise<ContextPackOutcome | undefined>): RunLifecycle {
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
    contextPack: briefContextPack({
      timeoutMs: 1000,
      maxContextTokens: BUDGET,
      allowedRoots: allowedRoots(),
      policySnapshot: (runId) => ledger.getRunRecord(runId)?.policy_snapshot_json,
      project: () => ({ briefFile, contexts: [] }),
      retrieve: async (request, tokens) => {
        reserved.push(tokens);
        return retrieval(request);
      },
      nonce: () => NONCE,
    }),
  });
  lifecycle.start();
  return lifecycle;
}

async function runToEnd(l: RunLifecycle, project: ProjectSnapshot = PROJECT) {
  const { runId } = await l.submit({
    clientId: "c",
    objective: OBJECTIVE,
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    project,
  });
  return { runId, final: await l.waitForTerminal(runId) };
}

const packEvents = (runId: string) =>
  ledger
    .listRunEvents(runId)
    .filter((e) => e.type === RAG_RETRIEVAL_EVENT)
    .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);

const okPack = async (): Promise<ContextPackOutcome> => ({ text: PACK, event: { outcome: "ok", snippets: 1 } });

describe("project brief in the prompt (T5.14)", () => {
  it("unset: the prompt is byte-identical to the T12.5 output and retrieval reserves nothing", async () => {
    const l = start(okPack);
    const { runId, final } = await runToEnd(l);
    expect(final.state).toBe("SUCCEEDED");
    // Pinned output: request text, one blank line, the pack (exactly what T12.5 compiles without the brief port).
    expect(adapter.objectives).toEqual([`${OBJECTIVE}\n\n${PACK}`]);
    expect(adapter.objectives[0]).toMatchInlineSnapshot(`
      "Fix the parser in src/parse.ts

      <switchboard-context-pack n>
      UNTRUSTED REFERENCE DATA
      </switchboard-context-pack n>"
    `);
    expect(reserved).toEqual([0]);
    expect(packEvents(runId)).toEqual([{ outcome: "ok", snippets: 1 }]);
  });

  it("unset with retrieval inert: the request text alone and no event, as before", async () => {
    const l = start(async () => undefined);
    const { runId, final } = await runToEnd(l);
    expect(final.state).toBe("SUCCEEDED");
    expect(adapter.objectives).toEqual([OBJECTIVE]);
    expect(packEvents(runId)).toEqual([]);
  });

  it("set: the labelled block comes before the retrieved context, inside the budget; the ledger has the hash only", async () => {
    const l = start(okPack);
    const admitted = admitBrief({ id: "web", briefFile, contexts: [] }, allowedRoots());
    const sha = admitted.brief_sha256 as string;
    const { runId, final } = await runToEnd(l, { ...PROJECT, ...admitted });
    expect(final.state).toBe("SUCCEEDED");
    const prompt = adapter.objectives[0] as string;
    const block = [
      `<switchboard-project-brief ${NONCE}>`,
      `PROJECT BRIEF of project "web", maintained by the operator in Switchboard's configuration,`,
      "outside the repository: the goal, definition of done and known failures. It is context for the request above,",
      "which takes precedence where they differ.",
      `brief_sha256: ${sha}`,
      BRIEF.slice(0, -1),
      `</switchboard-project-brief ${NONCE}>`,
    ].join("\n");
    expect(prompt).toBe(`${OBJECTIVE}\n\n${block}\n\n${PACK}`);
    // The brief's tokens are reserved from the same budget before retrieval runs, so retrieval is what is trimmed.
    const tokens = briefTokens(`${block}\n\n`);
    expect(reserved).toEqual([tokens]);
    expect(tokens + briefTokens(PACK)).toBeLessThanOrEqual(BUDGET);
    expect(packEvents(runId)).toEqual([{ outcome: "ok", snippets: 1, brief_sha256: sha, brief_tokens_est: tokens }]);
    // The stored request and every ledger row carry no brief text.
    const rec = ledger.getRunRecord(runId);
    expect(JSON.parse(rec?.request_json ?? "{}").objective).toBe(OBJECTIVE);
    expect(JSON.parse(rec?.policy_snapshot_json ?? "{}").project.brief_sha256).toBe(sha);
    const dump = JSON.stringify(db.prepare("SELECT * FROM run_event").all()) + JSON.stringify(rec);
    expect(dump).not.toContain("CANARY-T514");
  });

  it("set with retrieval inert or failing: the brief alone is delivered", async () => {
    const l = start(async () => {
      throw new Error("index exploded");
    });
    const admitted = admitBrief({ id: "web", briefFile, contexts: [] }, allowedRoots());
    const { runId, final } = await runToEnd(l, { ...PROJECT, ...admitted });
    expect(final.state).toBe("SUCCEEDED");
    expect(adapter.objectives[0]).toMatch(
      /^Fix the parser in src\/parse\.ts\n\n<switchboard-project-brief [0-9a-f]+>\n/,
    );
    expect(adapter.objectives[0]?.endsWith(`</switchboard-project-brief ${NONCE}>`)).toBe(true);
    expect(packEvents(runId)[0]).toMatchObject({ outcome: "unavailable", reason: "RETRIEVAL_ERROR" });
  });

  it("an edit after admission does not change the run: it gets the brief frozen at admission", async () => {
    const l = start(async () => undefined);
    const admitted = admitBrief({ id: "web", briefFile, contexts: [] }, allowedRoots());
    writeFileSync(briefFile, "Edited after admission.\n");
    const { final } = await runToEnd(l, { ...PROJECT, ...admitted });
    expect(final.state).toBe("SUCCEEDED");
    expect(adapter.objectives[0]).toContain("CANARY-T514-flaky-lexer");
    expect(adapter.objectives[0]).not.toContain("Edited after admission.");
  });

  it("a frozen brief that can no longer be found by its hash fails the run closed before spawn", async () => {
    const l = start(okPack);
    const { runId, final } = await runToEnd(l, { ...PROJECT, brief_sha256: "f".repeat(64) });
    expect(final.state).toBe("FAILED");
    expect(final.failure_code).toBe("TOOL_FAILURE");
    expect(adapter.objectives).toEqual([]);
    expect(ledger.getRunRecord(runId)?.failure_detail).toContain("no longer available");
  });
});
