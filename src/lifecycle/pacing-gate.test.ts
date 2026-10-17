/**
 * Pacing gate (T6.8; FR-CAP-10, FR-CAP-07 as amended, BR-51, LLD §16.9, ADR-0055 item 8). Scripted fake providers
 * (`fake`, `fake-b`, `grok`) behind the MCP server, one injected clock for the ledger, the lifecycle and the servers. The
 * clock runs at real speed from an offset the test sets, so the lifecycle's wake timer fires at the gate-open time. No
 * provider CLI, no network.
 *
 * Seeding: one run on `fake` at 600 s into a 3600 s `fixed` window with a budget of 2 runs gives a used share of 0.5,
 * above the pace line `T × elapsed + B`, so `fake`'s subscription defers until `start + L × (0.5 − B) / T`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { PACING_DEFERRED, PACING_HOLD_EVENT, type PacingGateSettings, pacingDeferrals } from "../capacity/index.js";
import type { PacingSettings, SubscriptionSettings } from "../config/capacity.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RouteDecisionRow, type TrustProfile } from "../ledger/index.js";
import { replayRouteDecision } from "../routing/decision.js";
import { compiled, type Harness, type Json, startHarness } from "../routing/fixtures/harness.js";
import { WorkspaceManager } from "../workspace/index.js";
import { RunLifecycle } from "./index.js";

const ANCHOR = "2026-10-17T00:00:00.000Z";
const ANCHOR_MS = Date.parse(ANCHOR);
const LENGTH = 3600;
const RESET = new Date(ANCHOR_MS + LENGTH * 1000).toISOString();
const GATE: PacingSettings = { mode: "gate", targetFraction: 0.95, burstFraction: 0.1, minConfidence: 0.5 };

/** Earlier of reset and `start + L × (used − B) / T`, to the millisecond; written independently of the gate. */
function gateOpen(used: number, p: PacingSettings = GATE): string {
  const formula = ANCHOR_MS + LENGTH * 1000 * ((used - p.burstFraction) / p.targetFraction);
  return new Date(Math.round(Math.min(Date.parse(RESET), formula))).toISOString();
}
const OPEN = gateOpen(0.5);
/** How far before the gate-open time a held run is admitted: longer than admission takes, so it is still deferred. */
const MARGIN_MS = 2500;

type Reset = SubscriptionSettings["windows"][0]["reset"];
const sub = (name: string, adapterIds: string[], budget = 2, reset: Reset = { kind: "fixed", anchor: ANCHOR }) => ({
  name,
  providers: [...adapterIds],
  adapterIds,
  windows: [{ id: "hour", lengthSeconds: LENGTH, reset, budget: { unit: "runs" as const, value: budget } }],
});

let offset = 0;
const clock = () => new Date(Date.now() + offset);
const setClock = (ms: number) => {
  offset = ms - Date.now();
};

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  offset = 0;
});

async function harness(pacing?: PacingGateSettings): Promise<Harness> {
  setClock(ANCHOR_MS + 600_000);
  h = await startHarness({ now: clock, ...(pacing !== undefined ? { lifecycle: { pacing } } : {}) });
  return h;
}

/** One finished run on `fake` (require_provider), which is what makes `fake`'s subscription defer. */
async function seed(hh: Harness): Promise<string> {
  const body = await hh.delegate("ok", { provider_preference: "fake", require_provider: true });
  expect(body.status).toBe("SUCCEEDED");
  return body.run_id as string;
}

const delegate = async (hh: Harness, routing: Json = {}) =>
  (await hh.ok("delegate_task", { objective: "ok", workspace_path: hh.repo, trust_profile: "edit-untrusted", routing }))
    .run_id as string;
const decisionOf = (hh: Harness, runId: string) => hh.decisions().find((d) => d.run_id === runId) as RouteDecisionRow;
const candidates = (d: RouteDecisionRow) =>
  JSON.parse(d.candidates_json) as { provider: string; eligible: boolean; pacing?: Record<string, unknown> }[];
const holds = (hh: Harness, runId: string) =>
  hh.ledger
    .listRunEvents(runId)
    .filter((e) => e.type === PACING_HOLD_EVENT)
    .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("pacing gate at admission and dispatch (T6.8, LLD §16.9)", () => {
  it("an ahead-of-pace subscription is deferred and its runs go to an undeferred eligible provider (PACING_DEFERRED)", async () => {
    const hh = await harness({ subscriptions: [sub("alpha", ["fake"]), sub("beta", ["fake-b"], 100)], pacing: GATE });
    await seed(hh);
    const runId = await delegate(hh, { provider_preference: "fake" });
    const settled = await hh.settle(runId);
    expect(settled.status).toBe("SUCCEEDED");
    const run = hh.ledger.getRunRecord(runId);
    expect(run?.provider).not.toBe("fake");
    const d = decisionOf(hh, runId);
    expect(d.selected_provider).toBe(run?.provider);
    const fake = candidates(d).find((c) => c.provider === "fake");
    expect(fake?.eligible).toBe(true);
    expect(fake?.pacing).toEqual({
      verdict: PACING_DEFERRED,
      until: OPEN,
      subscription: "alpha",
      window: "hour",
      source: "controller_estimated",
    });
    expect(
      candidates(d)
        .filter((c) => c.pacing !== undefined)
        .map((c) => c.provider),
    ).toEqual(["fake"]);
    const reasons = JSON.parse(d.reasons_json) as { pacing?: unknown; outcome: { kind: string } };
    expect(reasons.outcome.kind).toBe("eligible");
    expect(reasons.pacing).toEqual({
      deferred: [{ provider: "fake", verdict: PACING_DEFERRED, until: OPEN }],
      hold_until: null,
    });
    // The deferred candidate is left out of selection, so the stored row replays exactly.
    const features = JSON.parse(d.features_json) as { admissible: string[] };
    expect(features.admissible).not.toContain("fake");
    expect(replayRouteDecision(d)).toEqual({ schemaVersion: 2, ok: true, differences: [] });
    // The published explain_route output schema still validates a decision that records a deferral.
    expect((await hh.ok("explain_route", { run_id: runId })).selected_provider).toBe(run?.provider);
    expect(holds(hh, runId)).toEqual([]);
  });

  it("with every candidate deferred the run waits in QUEUED and is dispatched no earlier than the formula's gate-open time", async () => {
    const hh = await harness({ subscriptions: [sub("alpha", ["fake", "fake-b", "grok"])], pacing: GATE });
    const seeded = await seed(hh);
    expect(OPEN).toBe("2026-10-17T00:25:15.789Z");
    expect(
      pacingDeferrals(hh.ledger, { subscriptions: [sub("alpha", ["fake"])], pacing: GATE }, clock()).get("fake"),
    ).toEqual({ subscription: "alpha", window: "hour", until: OPEN, source: "controller_estimated" });
    setClock(Date.parse(OPEN) - MARGIN_MS);
    const runId = await delegate(hh);
    expect(hh.ledger.getRunRecord(runId)?.state).toBe("QUEUED");
    const d = decisionOf(hh, runId);
    const reasons = JSON.parse(d.reasons_json) as { pacing: { hold_until: string; deferred: unknown[] } };
    expect(reasons.pacing.hold_until).toBe(OPEN);
    expect(reasons.pacing.deferred).toHaveLength(3);
    await sleep(250);
    expect(hh.ledger.getRunRecord(runId)?.state).toBe("QUEUED");
    expect(holds(hh, runId)).toEqual([
      { subscription: "alpha", window: "hour", until: OPEN, source: "controller_estimated" },
    ]);
    const settled = await hh.settle(runId);
    expect(settled.status).toBe("SUCCEEDED");
    const run = hh.ledger.getRunRecord(runId);
    expect(Date.parse(run?.started_at ?? "")).toBeGreaterThanOrEqual(Date.parse(OPEN));
    expect(holds(hh, runId)).toHaveLength(1);
    // Nothing ran that was not submitted: two runs, two provider processes, no probe run.
    expect(hh.db.prepare("SELECT id FROM run ORDER BY created_at").all()).toEqual([{ id: seeded }, { id: runId }]);
    expect(compiled.map((c) => c.runId).sort()).toEqual([seeded, runId].sort());
  });

  it("require_provider waits on its own gate even when another subscription is clear", async () => {
    const hh = await harness({ subscriptions: [sub("alpha", ["fake"]), sub("beta", ["fake-b"], 100)], pacing: GATE });
    await seed(hh);
    setClock(Date.parse(OPEN) - MARGIN_MS);
    const runId = await delegate(hh, { provider_preference: "fake", require_provider: true });
    const run = hh.ledger.getRunRecord(runId);
    expect(run?.state).toBe("QUEUED");
    expect(run?.provider).toBe("fake");
    const reasons = JSON.parse(decisionOf(hh, runId).reasons_json) as { pacing: { hold_until: string } };
    expect(reasons.pacing.hold_until).toBe(OPEN);
    await sleep(100);
    expect(holds(hh, runId)).toHaveLength(1);
    expect((await hh.settle(runId)).status).toBe("SUCCEEDED");
    const done = hh.ledger.getRunRecord(runId);
    expect(done?.provider).toBe("fake");
    expect(Date.parse(done?.started_at ?? "")).toBeGreaterThanOrEqual(Date.parse(OPEN));
  });

  const neverDefer: [string, PacingGateSettings][] = [
    ["a rolling window", { subscriptions: [sub("alpha", ["fake"], 1, { kind: "rolling" })], pacing: GATE }],
    ["an unknown source", { subscriptions: [sub("alpha", ["fake"], 1, { kind: "provider_reported" })], pacing: GATE }],
    [
      "an estimate below min_confidence",
      { subscriptions: [sub("alpha", ["fake"], 1)], pacing: { ...GATE, minConfidence: 0.9 } },
    ],
    ["mode: score", { subscriptions: [sub("alpha", ["fake"], 1)], pacing: { ...GATE, mode: "score" } }],
    ["mode: off", { subscriptions: [sub("alpha", ["fake"], 1)], pacing: { ...GATE, mode: "off" } }],
  ];
  it.each(neverDefer)("%s never defers and never holds", async (_label, pacing) => {
    const hh = await harness(pacing);
    await seed(hh);
    expect(pacingDeferrals(hh.ledger, pacing, clock()).size).toBe(0);
    const preferred = await delegate(hh, { provider_preference: "fake" });
    const required = await delegate(hh, { provider_preference: "fake", require_provider: true });
    for (const runId of [preferred, required]) {
      expect((await hh.settle(runId)).status).toBe("SUCCEEDED");
      expect(hh.ledger.getRunRecord(runId)?.provider).toBe("fake");
      const d = decisionOf(hh, runId);
      expect(d.candidates_json).not.toContain(PACING_DEFERRED);
      expect(d.reasons_json).not.toContain("pacing");
      expect(holds(hh, runId)).toEqual([]);
    }
  });

  it("no subscription configured gives byte-identical decisions and outcomes to the unconfigured lifecycle", async () => {
    const scenario = async (pacing?: PacingGateSettings) => {
      const hh = await harness(pacing);
      const runId = await delegate(hh, { provider_preference: "fake" });
      await hh.settle(runId);
      // The temporary repository path, and the project key hashed from it, differ between the two harnesses.
      const strip = (s: string) =>
        s
          .split(hh.root)
          .join("<root>")
          .replace(/"ws:[0-9a-f]{64}"/g, '"ws:<key>"');
      const d = decisionOf(hh, runId);
      const run = hh.ledger.getRunRecord(runId);
      const out = {
        decision: [d.features_json, d.weights_json, d.candidates_json, d.selected_provider, d.reasons_json].map((x) =>
          strip(String(x)),
        ),
        outcome: [run?.state, run?.provider, run?.failure_code],
        events: hh.ledger.listRunEvents(runId).map((e) => e.type),
      };
      await hh.close();
      h = undefined;
      return out;
    };
    const unconfigured = await scenario();
    const pacingOnly = await scenario({ subscriptions: [], pacing: GATE });
    expect(pacingOnly).toEqual(unconfigured);
    expect(JSON.stringify(unconfigured)).not.toContain("pacing");
  });
});

describe("a restart keeps the pacing hold (T6.8)", () => {
  const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
  const profileFor = (name: TrustProfile): ResolvedProfile => ({
    name,
    fileAccess: "worktree",
    shell: "none",
    network: "off",
    repoConfig: "disabled",
    bypassApproved: false,
  });
  let root: string;
  let db: Database.Database;
  let lifecycles: RunLifecycle[] = [];

  afterEach(async () => {
    for (const l of lifecycles) await l.shutdown();
    lifecycles = [];
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("a held run stays QUEUED across a restart with one pacing_hold event and dispatches at the gate-open time", async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-pacing-gate-")));
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    const { execFileSync } = await import("node:child_process");
    const env = {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Op",
      GIT_AUTHOR_EMAIL: "op@example.test",
      GIT_COMMITTER_NAME: "Op",
      GIT_COMMITTER_EMAIL: "op@example.test",
    };
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["add", "-A"],
      ["commit", "-q", "-m", "init"],
    ]) {
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, env });
    }
    const dataDir = path.join(root, "data");
    mkdirSync(dataDir);
    db = openLedger(dataDir);
    setClock(ANCHOR_MS + 600_000);
    const ledger: Ledger = createLedger(db, { ids: createIdGenerator(), now: clock });
    const make = () => {
      const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
      const workspace = new WorkspaceManager({
        db,
        artifacts,
        dataDir,
        allowedRoots: [root],
        ids: createIdGenerator(),
      });
      const l = new RunLifecycle({
        ledger,
        workspace,
        artifacts,
        adapters: new AdapterRegistry().register(new FakeAdapter({ timeouts: PATIENT })),
        allowedRoots: [root],
        globalConcurrency: 4,
        perProviderConcurrency: 4,
        resolveProfile: profileFor,
        retry: { maxAttempts: 1, baseMs: 1, capMs: 1 },
        now: clock,
        pacing: { subscriptions: [sub("alpha", ["fake"])], pacing: GATE },
      });
      lifecycles.push(l);
      return l;
    };
    const submit = (l: RunLifecycle) =>
      l.submit({
        clientId: "c",
        objective: "do the task",
        workspace: repo,
        trustProfile: "edit-untrusted",
        provider: "fake",
      });

    const first = make();
    first.start();
    const seeded = await submit(first);
    await first.waitForTerminal(seeded.runId);
    const held = await submit(first);
    await sleep(100);
    expect(ledger.getRunRecord(held.runId)?.state).toBe("QUEUED");
    expect(ledger.listRunEvents(held.runId).filter((e) => e.type === PACING_HOLD_EVENT)).toHaveLength(1);
    await first.shutdown();

    setClock(Date.parse(OPEN) - MARGIN_MS);
    const second = make();
    second.start();
    await sleep(100);
    expect(ledger.getRunRecord(held.runId)?.state).toBe("QUEUED");
    const holdEvents = ledger.listRunEvents(held.runId).filter((e) => e.type === PACING_HOLD_EVENT);
    expect(holdEvents.map((e) => JSON.parse(e.payload_json))).toEqual([
      { subscription: "alpha", window: "hour", until: OPEN, source: "controller_estimated" },
    ]);
    const done = await second.waitForTerminal(held.runId);
    expect(done.state).toBe("SUCCEEDED");
    expect(Date.parse(ledger.getRunRecord(held.runId)?.started_at ?? "")).toBeGreaterThanOrEqual(Date.parse(OPEN));
    expect((db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n).toBe(2);
  });
});
