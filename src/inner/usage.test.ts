/**
 * T11.5 (FR-INN-15, ADR-0007, LLD §13.4 step 13): inner-agent usage is recorded in `inner_call` only. Nothing reaches
 * `usage_observation`, provider health or what the envelope reports as usage, unless the operator declared
 * `shares_subscription_with`, in which case each call that reached the backend adds exactly one `inner_agent` row.
 * Scripted fake backend only; no network, no provider CLI.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInnerAgent } from "../config/inner-agent.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger } from "../ledger/index.js";
import { createFakeBackend, createInnerAgent, type FakeStep, type InnerTaskContract } from "./index.js";

const contract: InnerTaskContract<{ title: string }, { title: string }> = {
  task: "run_title",
  template_version: "run_title.v1",
  system: "Write a title.",
  response_schema: {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: { title: { type: "string", minLength: 1, maxLength: 80 } },
  },
  sends_source_content: false,
  fallback: () => ({ title: "fallback" }),
  accept: (v) => v as { title: string },
};

const GOOD: FakeStep = { kind: "text", text: '{"title":"Fix login"}', usage: { in: 10, out: 4 } };
const dirs: string[] = [];
const dbs: { close(): void }[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(script: readonly FakeStep[], shares?: string, allowRemote?: boolean, locality?: "local" | "remote") {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-usage-"));
  dirs.push(dir);
  const db = openLedger(dir);
  dbs.push(db);
  const ledger = createLedger(db, { ids: createIdGenerator() });
  const session = ledger.createMetaSession({ objective: "o" });
  const run = ledger.createRun({
    metaSessionId: session.id,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
  });
  const settings = resolveInnerAgent({
    enabled: true,
    backend: {
      kind: "http",
      base_url: "http://127.0.0.1:1",
      model: "cfg-model",
      ...(shares !== undefined ? { shares_subscription_with: shares } : {}),
      ...(allowRemote !== undefined ? { allow_remote: allowRemote } : {}),
    },
    tasks: { run_title: { enabled: true } },
  });
  const svc = createInnerAgent(settings, {
    backend: createFakeBackend({ script, ...(locality !== undefined ? { locality } : {}) }),
    ledger,
  });
  const call = () => svc.call(contract, { user: "objective: tidy", run_id: run.id });
  /** Every usage-related table and read model, serialised, for a byte comparison. */
  const snapshot = () =>
    JSON.stringify({
      usage: db.prepare("SELECT * FROM usage_observation ORDER BY rowid").all(),
      health: db.prepare("SELECT * FROM provider_health ORDER BY provider").all(),
      forRun: ledger.listUsageObservationsForRun(run.id),
    });
  return { db, ledger, run, call, snapshot };
}

describe("inner-agent usage accounting (T11.5; FR-INN-15)", () => {
  it("without shares_subscription_with, calls are recorded in inner_call only: usage and health are byte-identical", async () => {
    const h = setup([GOOD, GOOD, { kind: "text", text: "not json" }, { kind: "text", text: "still not" }]);
    const before = h.snapshot();
    await h.call();
    await h.call();
    await h.call(); // rejected after its re-ask: still a call that reached the backend
    expect(h.ledger.listInnerCalls()).toHaveLength(3);
    expect(h.snapshot()).toBe(before);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM usage_observation").get()).toEqual({ n: 0 });
  });

  it("with shares_subscription_with, each call that reached the backend adds one labelled observation", async () => {
    const h = setup([GOOD, { kind: "text", text: "bad" }, { kind: "text", text: "bad again" }], "claude-code");
    const r1 = await h.call();
    const r2 = await h.call(); // one call, two attempts (re-ask): still one observation
    expect(r1.accepted).toBe(true);
    expect(r2.accepted).toBe(false);
    const rows = h.db.prepare("SELECT * FROM usage_observation ORDER BY rowid").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows).toHaveLength(h.ledger.listInnerCalls().length);
    expect(rows[0]).toMatchObject({
      run_id: h.run.id,
      provider: "claude-code",
      harness: "claude-code",
      backing_provider: null,
      model: "fake-model",
      source: "inner_agent",
      metrics_json: JSON.stringify({ input_tokens: 10, output_tokens: 4 }),
    });
    expect(JSON.parse(String(rows[1]?.metrics_json))).toEqual({}); // tokens unknown: empty, never estimated
    // the run's provider-reported view is unchanged and provider health is untouched
    expect(h.ledger.listUsageObservationsForRun(h.run.id).map((x) => x.source)).toEqual(["inner_agent", "inner_agent"]);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM provider_health").get()).toEqual({ n: 0 });
  });

  it("writes no observation for a call the privacy gate refused (no request was made)", async () => {
    const h = setup([GOOD], "claude-code", false, "remote");
    const r = await h.call();
    expect(r).toMatchObject({ accepted: false, outcome: "fallback_disabled", reason: "REMOTE_NOT_ALLOWED" });
    expect(h.ledger.listInnerCalls()).toHaveLength(1);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM usage_observation").get()).toEqual({ n: 0 });
  });
});
