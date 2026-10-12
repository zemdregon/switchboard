import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixturePath as claudeFixture, DEFAULT_SESSION_ID } from "../adapters/claude/fixtures/cases.js";
import { parseClaudeLine } from "../adapters/claude/parse.js";
import { CodexAdapter } from "../adapters/codex/adapter.js";
import { fixturePath as codexFixture } from "../adapters/codex/fixtures/cases.js";
import { createParseState, type NormalizedEvent } from "../adapters/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { usageObservationsFromEvents } from "./index.js";

const fixtureLines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.includes('"_fixture"'))
    .map((l) => l.replaceAll("{{SESSION_ID}}", DEFAULT_SESSION_ID));

const claudeEvents = (name: string): NormalizedEvent[] => {
  const state = createParseState();
  return fixtureLines(claudeFixture(name)).flatMap((l) => parseClaudeLine(l, state));
};
const codexEvents = (name: string): NormalizedEvent[] => {
  const state = createParseState();
  const a = new CodexAdapter({ executable: "/opt/synthetic/bin/codex" });
  return fixtureLines(codexFixture(name.replace(".jsonl", ""))).flatMap((l) => a.parseEvent(l, state));
};

describe("usageObservationsFromEvents", () => {
  it("Claude replay fixture: one provider_reported row with the reported metrics only", () => {
    const rows = usageObservationsFromEvents(claudeEvents("success-edit.jsonl"), {
      runId: "run_x",
      provider: "claude",
    });
    expect(rows).toEqual([
      {
        runId: "run_x",
        provider: "claude",
        harness: "claude",
        backingProvider: null,
        model: "synthetic-model",
        source: "provider_reported",
        metrics: {
          total_cost_usd: 0.01,
          num_turns: 3,
          duration_ms: 1200,
          "usage.input_tokens": 100,
          "usage.output_tokens": 20,
        },
      },
    ]);
  });

  it("Codex replay fixture: turn.completed usage becomes a provider_reported row (event shape is an Assumption)", () => {
    const rows = usageObservationsFromEvents(codexEvents("success_edit.jsonl"), { runId: "run_y", provider: "codex" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "codex",
      harness: "codex",
      source: "provider_reported",
      metrics: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 30 },
    });
  });

  it("falls back to the run's model and derives nothing when no usage was reported", () => {
    const events = claudeEvents("success-edit.jsonl").filter((e) => e.kind !== "usage");
    expect(usageObservationsFromEvents(events, { runId: "r", provider: "claude", model: "m" })).toEqual([]);
    expect(usageObservationsFromEvents([], { runId: "r", provider: "claude" })).toEqual([]);
    const empty: NormalizedEvent = { kind: "usage", source: "provider_reported", metrics: {} };
    expect(usageObservationsFromEvents([empty], { runId: "r", provider: "claude" })).toEqual([]);
  });

  it("drops non-finite numbers and never defaults a missing figure to zero", () => {
    const ev: NormalizedEvent = {
      kind: "usage",
      source: "provider_reported",
      metrics: { input_tokens: 5, bad: Number.NaN, unreported: null },
    };
    const [row] = usageObservationsFromEvents([ev], { runId: "r", provider: "codex" });
    expect(row?.metrics).toEqual({ input_tokens: 5, unreported: null });
  });
});

describe("usage_observation ledger helpers", () => {
  let dir: string;
  let db: Database.Database;
  let ledger: Ledger;
  let runId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sb-usage-"));
    db = openLedger(dir);
    ledger = createLedger(db, { ids: createIdGenerator() });
    const s = ledger.createMetaSession({ objective: "t" });
    runId = ledger.createRun({
      metaSessionId: s.id,
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h",
      clientId: "c",
    }).id;
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("inserts and lists by run with the source label and separate harness/backing/model columns", () => {
    expect(ledger.listUsageObservationsForRun(runId)).toEqual([]);
    const [row] = usageObservationsFromEvents(codexEvents("success_inspect.jsonl"), {
      runId,
      provider: "codex",
      model: "m1",
    });
    const id = ledger.insertUsageObservation({ ...(row as NonNullable<typeof row>), backingProvider: "openai" });
    expect(id).toMatch(/^use_/);
    const [stored] = ledger.listUsageObservationsForRun(runId);
    expect(stored).toMatchObject({
      id,
      run_id: runId,
      provider: "codex",
      harness: "codex",
      backing_provider: "openai",
      model: "m1",
      source: "provider_reported",
    });
    expect(JSON.parse(stored?.metrics_json ?? "{}")).toEqual({
      input_tokens: 50,
      cached_input_tokens: 10,
      output_tokens: 12,
    });
  });

  it("is append-only: update and delete fail", () => {
    ledger.insertUsageObservation({
      runId,
      provider: "claude",
      harness: "claude",
      source: "provider_reported",
      metrics: { a: 1 },
    });
    expect(() => db.prepare("UPDATE usage_observation SET model = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM usage_observation").run()).toThrow(/append-only/);
    expect(ledger.listUsageObservationsForRun(runId)).toHaveLength(1);
  });

  it("never stores an estimate in this table", () => {
    expect(() =>
      ledger.insertUsageObservation({
        runId,
        provider: "claude",
        harness: "claude",
        // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the type to prove the runtime guard
        source: "controller_estimated" as any,
        metrics: { remaining: 0.5 },
      }),
    ).toThrow(/provider_reported/);
    expect(ledger.listUsageObservationsForRun(runId)).toEqual([]);
  });
});
