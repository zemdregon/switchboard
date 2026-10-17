/**
 * T6.14 (FR-CAP-09, FR-CAP-03, LLD §16.9): the `pacing` block on the one capacity projection. Fakes and a ledger
 * written directly; no provider CLI. The gate verdict is computed here; nothing holds a run (that is T6.8).
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pacingDoctorLine, renderCapacity } from "../cli/capacity.js";
import type { PacingSettings, SubscriptionSettings } from "../config/capacity.js";
import { loadConfig } from "../config/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import {
  AFFINITY_NOTE,
  bindingPacingWindow,
  CAPACITY_NOTE,
  type CapacityProjection,
  capacityJson,
  capacityProjection,
  type PacingSubscriptionView,
} from "./projection.js";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const ANCHOR = "2026-10-17T00:00:00.000Z";
const RESET = "2026-10-18T00:00:00.000Z";
const DAY = 86_400;
const PACING: PacingSettings = { mode: "gate", targetFraction: 0.95, burstFraction: 0.1, minConfidence: 0.5 };
const PROVIDERS = [{ id: "fake", enabled: true, weight: null, concurrencyLimit: 1 }];
const BASE = { windowSeconds: 3600, confidenceRuns: 10 };

/** Earlier of reset and `start + length × (used − B) / T`, rounded to the millisecond. Independent of the projection. */
function gateOpen(
  startIso: string,
  lengthSeconds: number,
  used: number,
  burst: number,
  target: number,
  resetIso: string,
): string {
  const formula = Date.parse(startIso) + lengthSeconds * 1000 * ((used - burst) / target);
  return new Date(Math.round(Math.min(Date.parse(resetIso), formula))).toISOString();
}

const day = (budget: SubscriptionSettings["windows"][0]["budget"]): SubscriptionSettings["windows"][0] => ({
  id: "day",
  lengthSeconds: DAY,
  reset: { kind: "fixed", anchor: ANCHOR },
  budget,
});

const sub = (name: string, windows: SubscriptionSettings["windows"], adapterIds = ["fake"]): SubscriptionSettings => ({
  name,
  providers: adapterIds.map((id) => (id === "fake" ? "fake-cfg" : id)),
  adapterIds: [...adapterIds],
  windows,
});

describe("pacing block on the capacity projection (T6.14, LLD §16.9)", () => {
  let dir: string;
  let db: Database.Database;
  let ledger: Ledger;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "sb-pacing-"));
    db = openLedger(dir);
    ledger = createLedger(db, { now: () => NOW });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function addRun(
    provider: string,
    state: "SUCCEEDED" | "RUNNING",
    startedAt: string | null,
    finishedAt: string | null,
  ): string {
    const ms = ledger.createMetaSession({ objective: "o", constraints: [] });
    const r = ledger.createRun({
      metaSessionId: ms.id,
      trustProfile: "inspect-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h",
      clientId: "c",
      provider,
    });
    db.prepare("UPDATE run SET state = ?, started_at = ?, finished_at = ? WHERE id = ?").run(
      state,
      startedAt,
      finishedAt,
      r.id,
    );
    return r.id;
  }

  function project(subscriptions?: readonly SubscriptionSettings[], pacing: PacingSettings = PACING) {
    return capacityProjection(
      ledger,
      PROVIDERS,
      subscriptions === undefined ? BASE : { ...BASE, subscriptions, pacing },
      NOW,
    );
  }

  it("no subscription: capacity output byte-identical to main", () => {
    addRun("fake", "SUCCEEDED", "2026-10-17T11:50:00.000Z", "2026-10-17T11:55:00.000Z");
    const main = capacityProjection(ledger, PROVIDERS, BASE, NOW);
    const mainJson = capacityJson(main);
    const mainText = renderCapacity(main);
    expect(mainJson).not.toContain("pacing");
    expect(mainText).not.toContain("Pacing");
    expect(main).not.toHaveProperty("pacing");

    const empty = capacityProjection(ledger, PROVIDERS, { ...BASE, subscriptions: [], pacing: PACING }, NOW);
    expect(empty).not.toHaveProperty("pacing");
    expect(capacityJson(empty)).toBe(mainJson);
    expect(renderCapacity(empty)).toBe(mainText);

    const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-pacing-cfg-")));
    try {
      const file = path.join(tmp, "config.json");
      const write = (capacity: unknown) => {
        writeFileSync(
          file,
          JSON.stringify({
            schema_version: 1,
            allowed_roots: [tmp],
            mcp_clients: [{ id: "main", max_trust_profile: "edit-untrusted" }],
            ...(capacity === undefined ? {} : { capacity }),
          }),
        );
        return loadConfig({ configPath: file }).capacity;
      };
      for (const capacity of [undefined, {}, { window_seconds: 3600 }]) {
        const settings = write(capacity);
        expect(settings).not.toHaveProperty("subscriptions");
        expect(settings).not.toHaveProperty("pacing");
        const out = capacityProjection(ledger, PROVIDERS, settings, NOW);
        expect(out).not.toHaveProperty("pacing");
        expect(capacityJson(out)).toBe(mainJson);
        expect(renderCapacity(out)).toBe(mainText);
      }
      const pacingOnly = write({ pacing: { mode: "score" } });
      const out = capacityProjection(ledger, PROVIDERS, pacingOnly, NOW);
      expect(out).not.toHaveProperty("pacing");
      expect(capacityJson(out)).toBe(mainJson);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("one entry per subscription with each window's figures, deferred_until and the gate verdict", () => {
    for (let i = 0; i < 8; i++) addRun("fake", "SUCCEEDED", "2026-10-17T06:00:00.000Z", "2026-10-17T06:05:00.000Z");
    const open = gateOpen(ANCHOR, DAY, 0.8, 0.1, 0.95, RESET);
    expect(open).toBe("2026-10-17T17:41:03.158Z");

    const ahead = project([sub("alpha", [day({ unit: "runs", value: 10 })])]);
    const alpha = ahead.pacing?.[0];
    expect(alpha?.subscription).toBe("alpha");
    expect(alpha?.providers).toEqual(["fake-cfg"]);
    expect(alpha?.mode).toBe("gate");
    expect(alpha?.verdict).toBe("deferred");
    expect(alpha?.deferred_until).toBe(open);
    const w = alpha?.windows[0];
    expect(w).toMatchObject({
      id: "day",
      length_seconds: DAY,
      reset_at: { at: RESET, source: "operator_declared" },
      window_start: { at: ANCHOR, source: "operator_declared" },
      elapsed_fraction: 0.5,
      allowance: 0.3,
      pace: "ahead",
      defers: true,
    });
    expect(w?.used_fraction).toMatchObject({
      value: 0.8,
      source: "controller_estimated",
      confidence: 0.8,
      lower_bound: true,
      basis: "runs",
    });
    expect(alpha).not.toHaveProperty("openAt");
    expect(w).not.toHaveProperty("openAt");

    // Confidence equal to min_confidence still defers (>=).
    const atFloor = project([sub("alpha", [day({ unit: "runs", value: 10 })])], { ...PACING, minConfidence: 0.8 });
    expect(atFloor.pacing?.[0]?.verdict).toBe("deferred");

    // Two runs are behind the line and do not defer.
    db.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(path.join(os.tmpdir(), "sb-pacing-"));
    db = openLedger(dir);
    ledger = createLedger(db, { now: () => NOW });
    addRun("fake", "SUCCEEDED", "2026-10-17T06:00:00.000Z", "2026-10-17T06:05:00.000Z");
    addRun("fake", "SUCCEEDED", "2026-10-17T07:00:00.000Z", "2026-10-17T07:05:00.000Z");
    const behind = project([sub("alpha", [day({ unit: "runs", value: 10 })])]).pacing?.[0];
    expect(behind?.windows[0]?.used_fraction.value).toBe(0.2);
    expect(behind?.windows[0]?.pace).toBe("behind");
    expect(behind?.windows[0]?.allowance).toBe(1.5);
    expect(behind?.windows[0]?.defers).toBe(false);
    expect(behind?.verdict).toBe("clear");
    expect(behind?.deferred_until).toBeNull();

    // No runs: used 0, still clear.
    db.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(path.join(os.tmpdir(), "sb-pacing-"));
    db = openLedger(dir);
    ledger = createLedger(db, { now: () => NOW });
    const idle = project([
      sub("alpha", [day({ unit: "runs", value: 10 })]),
      sub("beta", [day({ unit: "runs", value: 10 })]),
    ]).pacing;
    expect(idle?.map((s) => s.subscription)).toEqual(["alpha", "beta"]);
    expect(idle?.[0]?.windows[0]?.used_fraction.value).toBe(0);
    expect(idle?.[0]?.windows[0]?.allowance).toBe(1.9);
    expect(idle?.[0]?.verdict).toBe("clear");
    expect(idle?.[1]?.verdict).toBe("clear");

    // No budget: unknown source, unknown pace, does not defer.
    const unknown = project([sub("alpha", [day(null)])]).pacing?.[0];
    expect(unknown?.windows[0]?.used_fraction).toEqual({ value: null, source: "unknown", confidence: 0 });
    expect(unknown?.windows[0]?.pace).toBe("unknown");
    expect(unknown?.windows[0]?.defers).toBe(false);
    expect(unknown?.verdict).toBe("clear");

    // Two windows: deferred_until is the later gate-open, and the binding window is the smaller allowance.
    for (let i = 0; i < 8; i++) addRun("fake", "SUCCEEDED", NOW.toISOString(), NOW.toISOString());
    const both = project([
      sub("alpha", [
        day({ unit: "runs", value: 10 }),
        {
          id: "hour",
          lengthSeconds: 3600,
          reset: { kind: "fixed", anchor: ANCHOR },
          budget: { unit: "runs", value: 10 },
        },
      ]),
    ]).pacing?.[0];
    const dayOpen = gateOpen(ANCHOR, DAY, 0.8, 0.1, 0.95, RESET);
    const hourOpen = gateOpen("2026-10-17T12:00:00.000Z", 3600, 0.8, 0.1, 0.95, "2026-10-17T13:00:00.000Z");
    expect(hourOpen).toBe("2026-10-17T12:44:12.632Z");
    expect(both?.windows.map((w) => w.defers)).toEqual([true, true]);
    expect(both?.deferred_until).toBe(dayOpen);
    expect(dayOpen > hourOpen).toBe(true);
    expect(bindingPacingWindow(both as PacingSubscriptionView)?.id).toBe("hour");

    // A formula past the reset clamps deferred_until to reset_at (T 0.5, B 0, used 1).
    db.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(path.join(os.tmpdir(), "sb-pacing-"));
    db = openLedger(dir);
    ledger = createLedger(db, { now: () => NOW });
    addRun("fake", "SUCCEEDED", "2026-10-17T06:00:00.000Z", "2026-10-17T06:05:00.000Z");
    const tight = project([sub("alpha", [day({ unit: "runs", value: 1 })])], {
      mode: "gate",
      targetFraction: 0.5,
      burstFraction: 0,
      minConfidence: 0.5,
    }).pacing?.[0];
    expect(tight?.windows[0]?.used_fraction.value).toBe(1);
    expect(tight?.windows[0]?.defers).toBe(true);
    expect(tight?.deferred_until).toBe(RESET);
  });

  it("mode score and off never defer, and a rolling window or low confidence never defers", () => {
    for (let i = 0; i < 8; i++) addRun("fake", "SUCCEEDED", "2026-10-17T06:00:00.000Z", "2026-10-17T06:05:00.000Z");
    const windows = [day({ unit: "runs", value: 10 })];
    for (const mode of ["score", "off"] as const) {
      const view = project([sub("alpha", windows)], { ...PACING, mode }).pacing?.[0];
      expect(view?.mode).toBe(mode);
      expect(view?.verdict).toBe("inactive");
      expect(view?.deferred_until).toBeNull();
      expect(view?.windows[0]?.defers).toBe(false);
      expect(view?.windows[0]?.used_fraction.value).toBe(0.8);
      expect(view?.windows[0]?.pace).toBe("ahead");
    }

    const low = project([sub("alpha", windows)], { ...PACING, minConfidence: 0.9 }).pacing?.[0];
    expect(low?.windows[0]?.used_fraction.confidence).toBe(0.8);
    expect(low?.windows[0]?.defers).toBe(false);
    expect(low?.verdict).toBe("clear");
    expect(low?.deferred_until).toBeNull();

    const rolling = project([
      sub("alpha", [
        { id: "roll", lengthSeconds: DAY, reset: { kind: "rolling" }, budget: { unit: "runs", value: 8 } },
      ]),
    ]).pacing?.[0];
    expect(rolling?.windows[0]?.reset_at).toBeNull();
    expect(rolling?.windows[0]?.used_fraction.value).toBe(1);
    expect(rolling?.windows[0]?.defers).toBe(false);
    expect(rolling?.verdict).toBe("clear");
    expect(rolling?.deferred_until).toBeNull();
  });

  it("an in-flight run counts by started_at and a reported_tokens budget is read from the ledger", () => {
    addRun("fake", "SUCCEEDED", "2026-10-17T06:00:00.000Z", "2026-10-17T06:05:00.000Z");
    addRun("fake", "RUNNING", "2026-10-17T11:00:00.000Z", null);
    // created_at is the ledger clock (inside the window); started_at is before window_start, so it must not count.
    addRun("fake", "SUCCEEDED", "2026-10-16T23:00:00.000Z", "2026-10-16T23:30:00.000Z");
    addRun("fake", "RUNNING", "2026-10-16T22:00:00.000Z", null);
    const used = project([sub("alpha", [day({ unit: "runs", value: 10 })])]).pacing?.[0]?.windows[0]?.used_fraction;
    expect(used?.value).toBe(0.2);
    expect(used?.source).toBe("controller_estimated");

    const runId = addRun("fake", "SUCCEEDED", "2026-10-17T08:00:00.000Z", "2026-10-17T08:05:00.000Z");
    ledger.insertUsageObservation({
      runId,
      provider: "fake",
      harness: "fake",
      source: "provider_reported",
      metrics: { total_tokens: 50 },
    });
    const tokens = project([
      sub("alpha", [
        {
          id: "day",
          lengthSeconds: DAY,
          reset: { kind: "fixed", anchor: ANCHOR },
          budget: { unit: "reported_tokens", value: 100 },
        },
      ]),
    ]).pacing?.[0]?.windows[0]?.used_fraction;
    expect(tokens).toMatchObject({ value: 0.5, source: "controller_estimated", basis: "reported_tokens" });
  });

  it("text and doctor lines obey the pacing wording rule", () => {
    for (let i = 0; i < 8; i++) addRun("fake", "SUCCEEDED", "2026-10-17T06:00:00.000Z", "2026-10-17T06:05:00.000Z");
    const view = project([sub("alpha", [day({ unit: "runs", value: 10 })])]);
    const text = renderCapacity(view);
    const windowLine = text.split("\n").find((l) => l.includes("defers yes"));
    expect(windowLine).toContain("used 0.8 (estimate, Switchboard-observed only)");
    expect(windowLine).toContain("source controller_estimated");
    expect(windowLine).not.toMatch(/remaining|%|\bplan\b/i);
    const header = text.split("\n").find((l) => l.includes("verdict deferred"));
    expect(header).toContain("deferred_until 2026-10-17T17:41:03.158Z");
    expect(text).not.toMatch(/quota left|available quota|%/i);

    const doctor = pacingDoctorLine(view.pacing?.[0] as PacingSubscriptionView);
    expect(doctor).toBe(
      "       pacing alpha: pace ahead, deferred_until 2026-10-17T17:41:03.158Z, " +
        "source controller_estimated (estimate, Switchboard-observed only)",
    );

    const reported: CapacityProjection = {
      as_of: NOW.toISOString(),
      window_seconds: 3600,
      note: CAPACITY_NOTE,
      providers: [],
      affinity: { source: "controller", note: AFFINITY_NOTE, projects: [], truncated: false },
      pacing: [
        {
          subscription: "reported",
          providers: ["fake-cfg"],
          mode: "gate",
          deferred_until: null,
          verdict: "clear",
          windows: [
            {
              id: "day",
              length_seconds: DAY,
              reset_at: { at: RESET, source: "operator_declared" },
              window_start: { at: ANCHOR, source: "operator_declared" },
              used_fraction: { value: 0.4, source: "provider_reported", confidence: 1, key: "used_fraction" },
              elapsed_fraction: 0.5,
              allowance: 1.1,
              pace: "behind",
              defers: false,
            },
          ],
        },
      ],
    };
    const reportedText = renderCapacity(reported);
    const reportedLine = reportedText.split("\n").find((l) => l.includes("defers no"));
    expect(reportedLine).toContain("source provider_reported");
    expect(reportedLine).not.toContain("estimate, Switchboard-observed only");
    expect(reportedLine).not.toMatch(/remaining/i);
    const reportedDoctor = pacingDoctorLine(reported.pacing?.[0] as PacingSubscriptionView);
    expect(reportedDoctor).toContain("source provider_reported");
    expect(reportedDoctor).not.toContain("estimate, Switchboard-observed only");
  });
});
