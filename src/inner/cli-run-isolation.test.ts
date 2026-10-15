/**
 * T11.14 residual: README's CLI-only inner commands never touch run data (FR-INN-16/17, LLD §13.5/13.8).
 * Existing CLI tests cover empty ledgers and fixture prompts. Here an unrelated run already exists: every non-inner
 * table must stay identical across diagnostics, all task fixtures, suspension and resume. In-process fakes only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry } from "../adapters/index.js";
import { main } from "../cli/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { INNER_FIXTURES } from "./fixture.js";
import { createFakeBackend, INNER_TASKS, type InnerTask } from "./index.js";

const RUN_TEXT = "UNRELATED_RUN_CONTENT_478ec";
const REPLY_TEXT = "SYNTHETIC_REPLY_CONTENT_97bea";
const replies: Record<InnerTask, object> = {
  commit_message: { subject: REPLY_TEXT },
  pr_draft: { title: REPLY_TEXT, body: REPLY_TEXT },
  route_features: { context_volume: "small", autonomy: "low", reasoning_depth: "low", task_kind: "docs" },
  handoff_condense: { fields: { goal: REPLY_TEXT } },
  log_summary: { summary: REPLY_TEXT },
  run_title: { title: REPLY_TEXT },
};

let root: string;
let configPath: string;
let db: Database.Database;
let ledger: Ledger;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "sb-inner-isolation-"));
  const dataDir = path.join(root, "data");
  mkdirSync(path.join(root, "repos"));
  mkdirSync(dataDir);
  configPath = path.join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [path.join(root, "repos")],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
      inner_agent: {
        enabled: true,
        backend: { kind: "http", base_url: "http://127.0.0.1:1/v1", model: "fake-model" },
        tasks: Object.fromEntries(INNER_TASKS.map((task) => [task, { enabled: true }])),
        suspension: { window_calls: 1, min_calls: 1, rejection_threshold: 0.5 },
      },
    }),
  );
  db = openLedger(dataDir);
  ledger = createLedger(db);
  const session = ledger.createMetaSession({ objective: RUN_TEXT });
  const run = ledger.createRun({
    metaSessionId: session.id,
    trustProfile: "inspect-untrusted",
    policySnapshot: { marker: RUN_TEXT },
    request: { objective: RUN_TEXT },
    requestHash: "unrelated-request-hash",
    clientId: "c1",
    provider: "fake",
  });
  ledger.insertUsageObservation({
    runId: run.id,
    provider: "fake",
    harness: "fake",
    source: "provider_reported",
    metrics: { input_tokens: 123 },
  });
  const artifactId = ledger.insertArtifact({
    runId: run.id,
    metaSessionId: session.id,
    kind: "test_report",
    sha256: "a".repeat(64),
    sizeBytes: 123,
    mediaType: "text/plain",
  });
  ledger.appendRunEvent({
    runId: run.id,
    type: "verification_command",
    artifactId,
    payload: { exit_code: 0 },
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** Compare rows, not database bytes (SQLite bookkeeping can change when inner_call is appended). */
function nonInnerRows(): Record<string, string[]> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
    name: string;
  }[];
  return Object.fromEntries(
    tables
      .filter(({ name }) => !["inner_call", "inner_task_state", "sqlite_sequence"].includes(name))
      .map(({ name }) => [
        name,
        db
          .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      ]),
  );
}

it.each([false, true])("CLI-only commands preserve an existing run and its data (json=%s)", async (json) => {
  const before = nonInnerRows();
  expect(before.run).toHaveLength(1);
  expect(before.usage_observation).toHaveLength(1);
  expect(before.run_event).toHaveLength(1);
  expect(before.artifact).toHaveLength(1);
  expect(JSON.stringify(before)).toContain(RUN_TEXT);
  const backend = createFakeBackend();
  async function cli(args: string[], expectedCode = 0) {
    const output: string[] = [];
    const errors: string[] = [];
    const code = await main([...args, ...(json ? ["--json"] : []), "--config", configPath], {
      stdout: { write: (s) => output.push(s) },
      stderr: { write: (s) => errors.push(s) },
      env: {},
      adapters: new AdapterRegistry().register(new FakeAdapter()),
      innerBackend: backend,
    });
    expect(code, errors.join("")).toBe(expectedCode);
    const printed = [...output, ...errors].join("");
    expect(printed, args.join(" ")).not.toContain(RUN_TEXT);
    expect(printed, args.join(" ")).not.toContain(REPLY_TEXT);
    expect(nonInnerRows(), args.join(" ")).toEqual(before);
  }

  await cli(["inner", "status"]);
  await cli(["doctor"]);
  for (const task of INNER_TASKS) {
    backend.setScript([{ kind: "text", text: JSON.stringify(replies[task]) }]);
    await cli(["inner", "test", task]);
  }
  expect(ledger.listInnerCalls()).toHaveLength(INNER_TASKS.length);
  for (const call of ledger.listInnerCalls()) {
    expect(call).toMatchObject({ run_id: null, meta_session_id: null, outcome: "accepted" });
  }
  expect(backend.requests.map((request) => request.user)).toEqual(INNER_TASKS.map((task) => INNER_FIXTURES[task].user));
  expect(JSON.stringify(backend.requests)).not.toContain(RUN_TEXT);

  backend.setScript([{ kind: "text", text: "invalid synthetic response" }]);
  await cli(["inner", "test", "run_title"], 1);
  expect(ledger.getInnerTaskState("run_title")?.suspended).toBe(true);
  await cli(["inner", "status"]);
  await cli(["doctor"]);
  await cli(["inner", "resume", "run_title"]);
  expect(ledger.getInnerTaskState("run_title")?.suspended).toBe(false);
  expect(ledger.getInnerTaskState("run_title")?.version).toBe(2);
  expect(JSON.stringify(ledger.listInnerCalls())).not.toContain(REPLY_TEXT);
});
