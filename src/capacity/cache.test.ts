/**
 * FR-CAP-08 cache observations and per-project switch counts (T6.7; LLD §3.2, §16.8, ADR-0032 item 8). Pure helpers
 * and the projection over a real ledger; no provider.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderCapacity } from "../cli/capacity.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import {
  AFFINITY_NOTE,
  CACHE_KEYS,
  type CapacityProviderInfo,
  cacheObservation,
  capacityJson,
  capacityProjection,
  projectKey,
  switchCounts,
} from "./index.js";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const SETTINGS = { windowSeconds: 3600, confidenceRuns: 10 };

describe("cacheObservation (T6.7)", () => {
  it("maps only sourced keys: Grok Build today; every other provider has no block", () => {
    expect(Object.keys(CACHE_KEYS)).toEqual(["grok"]);
    const rows = [
      { metrics: { cache_read_input_tokens: 100, cache_creation_input_tokens: 20, input_tokens: 5 } },
      { metrics: { cache_read_input_tokens: 50 } },
      { metrics: { input_tokens: 7 } }, // holds no cache key: not counted
    ];
    expect(cacheObservation("grok", rows)).toEqual({
      read: 150,
      creation: 20,
      rows: 2,
      source: "provider_reported",
      key_names: ["cache_read_input_tokens", "cache_creation_input_tokens"],
      key_source: expect.stringContaining("live-checks-2026-10-14-grok.md"),
    });
    // Reported by other CLIs but not mapped (no adapter, synthetic only, or unknown): absent, never zero.
    expect(cacheObservation("codex", [{ metrics: { cached_input_tokens: 9 } }])).toBeUndefined();
    expect(cacheObservation("cursor", [{ metrics: { cacheReadTokens: 9 } }])).toBeUndefined();
    expect(cacheObservation("claude", [{ metrics: { "usage.cache_read_input_tokens": 9 } }])).toBeUndefined();
    expect(cacheObservation("grok", [{ metrics: { input_tokens: 1 } }])).toBeUndefined();
    expect(cacheObservation("grok", [])).toBeUndefined();
    // A non-number or negative value is not a count.
    expect(
      cacheObservation("grok", [{ metrics: { cache_read_input_tokens: "9", cache_creation_input_tokens: -1 } }]),
    ).toBeUndefined();
  });

  it("a creation count stays null when only reads were reported", () => {
    expect(cacheObservation("grok", [{ metrics: { cache_read_input_tokens: 3 } }])).toMatchObject({
      read: 3,
      creation: null,
      rows: 1,
    });
  });
});

describe("switchCounts (T6.7)", () => {
  it("counts kept versus switched per project, by recorded reason or unrecorded", () => {
    const r = (projectKey: string, provider: string, model: string | null, switchReason: string | null = null) => ({
      projectKey,
      provider,
      model,
      switchReason,
    });
    expect(
      switchCounts([
        r("proj_a", "fake", "m1"),
        r("proj_b", "codex", null),
        r("proj_a", "fake", "m1"),
        r("proj_a", "fake-b", "m1"),
        r("proj_a", "fake-b", "m2", "user_request"),
        r("proj_a", "fake-b", "m2"),
      ]),
    ).toEqual([
      { project_key: "proj_a", runs: 5, kept: 2, switched: { unrecorded: 1, user_request: 1 } },
      { project_key: "proj_b", runs: 1, kept: 0, switched: {} },
    ]);
  });
});

describe("the projection carries the cache block and the affinity counts (T6.7)", () => {
  let dir: string;
  let db: Database.Database;
  let ledger: Ledger;
  const providers: CapacityProviderInfo[] = [
    { id: "grok", enabled: true, weight: null, concurrencyLimit: 1 },
    { id: "codex", enabled: true, weight: null, concurrencyLimit: 1 },
  ];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sb-cache-"));
    db = openLedger(dir);
    ledger = createLedger(db, { now: () => NOW });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A run that started, on `provider` with `model`, in a project or a workspace; optional M7 affinity reason. */
  const started = (
    provider: string,
    model: string | null,
    where: { project?: string; workspace: string },
    reason?: string,
    createdAt = "2026-10-14T11:30:00.000Z",
  ) => {
    const ms = ledger.createMetaSession({ objective: "o", ...(where.project ? { projectId: where.project } : {}) });
    const r = ledger.createRun({
      metaSessionId: ms.id,
      trustProfile: "inspect-untrusted",
      policySnapshot: {},
      request: { workspace: where.workspace },
      requestHash: "h",
      clientId: "c",
      provider,
      ...(where.project ? { projectId: where.project } : {}),
    });
    db.prepare(
      "UPDATE run SET state = 'SUCCEEDED', model = ?, started_at = ?, finished_at = ?, created_at = ? WHERE id = ?",
    ).run(model, createdAt, createdAt, createdAt, r.id);
    if (reason !== undefined) {
      ledger.insertRouteDecision({
        runId: r.id,
        features_json: "{}",
        candidates_json: "[]",
        selected_provider: provider,
        reasons_json: JSON.stringify({ affinity: { affinity_switch_reason: reason } }),
      });
    }
    return r.id;
  };

  it("sums Grok's reported cache tokens in the window and gives Codex no block", () => {
    const g1 = started("grok", "grok-4.7-build", { workspace: "/w/one" });
    for (const metrics of [
      { cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
      { cache_read_input_tokens: 40, cache_creation_input_tokens: 0 },
    ]) {
      ledger.insertUsageObservation({
        runId: g1,
        provider: "grok",
        harness: "grok",
        source: "provider_reported",
        metrics,
      });
    }
    const c1 = started("codex", null, { workspace: "/w/two" });
    ledger.insertUsageObservation({
      runId: c1,
      provider: "codex",
      harness: "codex",
      source: "provider_reported",
      metrics: { cached_input_tokens: 9 },
    });
    const p = capacityProjection(ledger, providers, SETTINGS, NOW);
    expect(p.providers[0]?.cache).toMatchObject({ read: 140, creation: 20, rows: 2, source: "provider_reported" });
    expect(p.providers[1]).not.toHaveProperty("cache");
    // The cache figures are not an estimate input: the score is the same without them.
    expect(p.providers[0]?.capacity_score).toBe(p.providers[1]?.capacity_score);
  });

  it("counts kept and switched runs per project key (project id, or ws: and the workspace hash)", () => {
    started("grok", "m1", { project: "proj_a", workspace: "/w/a" }, undefined, "2026-10-14T11:10:00.000Z");
    started("grok", "m1", { project: "proj_a", workspace: "/w/a" }, undefined, "2026-10-14T11:20:00.000Z");
    started("codex", null, { project: "proj_a", workspace: "/w/a" }, undefined, "2026-10-14T11:30:00.000Z");
    started("codex", "m9", { project: "proj_a", workspace: "/w/a" }, "user_request", "2026-10-14T11:40:00.000Z");
    started("grok", "m1", { workspace: "/w/loose" }, undefined, "2026-10-14T11:15:00.000Z");
    started("grok", "m1", { project: "proj_a", workspace: "/w/a" }, undefined, "2026-10-14T09:00:00.000Z"); // too old
    const p = capacityProjection(ledger, providers, SETTINGS, NOW);
    const ws = `ws:${createHash("sha256").update("/w/loose").digest("hex")}`;
    expect(projectKey(null, "/w/loose")).toBe(ws);
    expect(p.affinity).toEqual({
      source: "controller",
      note: AFFINITY_NOTE,
      truncated: false,
      projects: [
        { project_key: "proj_a", runs: 4, kept: 1, switched: { unrecorded: 1, user_request: 1 } },
        { project_key: ws, runs: 1, kept: 0, switched: {} },
      ],
    });
    expect(capacityJson(p)).toBe(capacityJson(capacityProjection(ledger, providers, SETTINGS, NOW)));
  });

  it("an MCP client sees only its own runs in the affinity block; the operator sees all", () => {
    started("grok", "m1", { project: "proj_a", workspace: "/w/a" });
    const other = started("codex", null, { project: "proj_secret", workspace: "/w/s" });
    db.prepare("UPDATE run SET client_id = 'other' WHERE id = ?").run(other);
    const keys = (clientId?: string) =>
      capacityProjection(ledger, providers, SETTINGS, NOW, clientId).affinity.projects.map((p) => p.project_key);
    expect(keys("c")).toEqual(["proj_a"]);
    expect(keys("other")).toEqual(["proj_secret"]);
    expect(keys()).toEqual(["proj_a", "proj_secret"]);
  });

  it("wording: reported counts and evidence, never a claim of cache use", () => {
    const g1 = started("grok", "m1", { project: "proj_a", workspace: "/w/a" });
    ledger.insertUsageObservation({
      runId: g1,
      provider: "grok",
      harness: "grok",
      source: "provider_reported",
      metrics: { cache_read_input_tokens: 5 },
    });
    const p = capacityProjection(ledger, providers, SETTINGS, NOW);
    const text = renderCapacity(p);
    expect(text).toContain("provider-reported cache tokens: read 5, creation - (1 reports)");
    expect(text).toContain("proj_a: 1 runs, kept 0, switched 0");
    expect(`${text}${capacityJson(p)}`).not.toMatch(/cache hit|hit rate|saved/i);
  });
});
