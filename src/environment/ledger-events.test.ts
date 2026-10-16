/**
 * `environment` run events into the ledger (T10.2; FR-PRJ-07, LLD §11.3). The sink is the `onEvent` callback the
 * controller gives an environment: it appends to the run's events when the ledger knows the run and never throws.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { ENVIRONMENT_DETAIL_MAX, ENVIRONMENT_EVENT_TYPE, environmentEventSink } from "./ledger-events.js";
import type { EnvironmentEvent } from "./types.js";

let dir: string;
let db: Database.Database;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-envlog-"));
  db = openLedger(dir);
  ledger = createLedger(db, { ids: createIdGenerator() });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

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

const ev = (runId: string, extra: Partial<EnvironmentEvent["payload"]> = {}): EnvironmentEvent => ({
  type: "environment",
  payload: {
    kind: "container",
    step: "orphan_removed",
    run_id: runId,
    container: `switchboard-run-${runId}`,
    ...extra,
  },
});

describe("environmentEventSink (T10.2)", () => {
  it("appends the event to the run's ledger events with type `environment` and the payload as emitted", () => {
    const runId = aRun();
    environmentEventSink(ledger)(ev(runId));
    const rows = ledger.listRunEvents(runId).filter((e) => e.type === ENVIRONMENT_EVENT_TYPE);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload_json ?? "{}")).toEqual(ev(runId).payload);
  });

  it("an event of a run the ledger does not know is handed to onUnrecorded, not written", () => {
    const missed: string[] = [];
    environmentEventSink(ledger, (e, why) => missed.push(`${e.payload.run_id}: ${why}`))(ev("NOPE"));
    expect(missed).toEqual(["NOPE: the ledger has no run with this id"]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM run_event").get() as { n: number }).n).toBe(0);
  });

  it("truncates runtime error text and never throws when the ledger write fails", () => {
    const runId = aRun();
    environmentEventSink(ledger)(ev(runId, { step: "remove_failed", detail: "x".repeat(5000) }));
    const row = ledger.listRunEvents(runId).find((e) => e.type === ENVIRONMENT_EVENT_TYPE);
    expect((JSON.parse(row?.payload_json ?? "{}") as { detail: string }).detail).toHaveLength(ENVIRONMENT_DETAIL_MAX);

    const missed: string[] = [];
    const broken = {
      getRunRecord: ledger.getRunRecord.bind(ledger),
      appendRunEvent: () => {
        throw new Error("database is locked");
      },
    };
    expect(() => environmentEventSink(broken, (_e, why) => missed.push(why))(ev(runId))).not.toThrow();
    expect(missed).toEqual(["database is locked"]);
  });
});
