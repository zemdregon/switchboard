/**
 * `switchboard affinity list|reset` (T7.7; FR-RTE-07, FR-OPS-01, LLD §17.6). The CLI lists rows in text and `--json`,
 * refuses to reset a project with no row (exit 1, nothing written), records a reset with or without a running daemon,
 * and the next routing step treats the reset as `user_request`; the first run that then succeeds consumes it, once.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLedger, openLedger } from "../ledger/index.js";
import { acquireDataDirLock } from "../lock/index.js";
import { type Harness, startHarness } from "../routing/fixtures/harness.js";
import { HELP, main } from "./index.js";
import type { CliIo } from "./io.js";

let tmp: string;
let dataDir: string;
let configPath: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-aff-")));
  const repos = path.join(tmp, "repos");
  mkdirSync(repos);
  dataDir = path.join(tmp, "data");
  configPath = path.join(tmp, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [repos],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
    }),
  );
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: {},
    user: "tester",
  };
  const code = await main([...args, "--config", configPath], io);
  return { code, out: out.join(""), err: err.join("") };
}

function seedRow(key: string, provider: string, model: string | null = null): void {
  const db = openLedger(dataDir);
  try {
    const ledger = createLedger(db);
    const s = ledger.createMetaSession({ objective: "o" });
    const r = ledger.createRun({
      metaSessionId: s.id,
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h",
      clientId: "c1",
      provider,
    });
    ledger.writeProjectAffinity({
      projectKey: key,
      provider,
      model,
      lastRunId: r.id,
      reason: null,
      expectedVersion: undefined,
    });
  } finally {
    db.close();
  }
}

function rows() {
  const db = openLedger(dataDir);
  try {
    return createLedger(db).listProjectAffinities();
  } finally {
    db.close();
  }
}

describe("switchboard affinity (T7.7)", () => {
  it("is in the help text", () => {
    expect(HELP).toContain("affinity list");
    expect(HELP).toContain("affinity reset <project_key>");
  });

  it("lists nothing with no ledger, then each row in text and --json", async () => {
    expect(await run(["affinity", "list"])).toMatchObject({ code: 0, out: "no project affinity recorded\n" });
    expect(JSON.parse((await run(["affinity", "list", "--json"])).out)).toEqual({ schema_version: 1, projects: [] });
    seedRow("proj-a", "claude", "model-x");
    seedRow("ws:abc", "codex");
    const text = await run(["affinity", "list"]);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/^proj-a: claude \(model-x\) since .+, last switch: first run\n/u);
    expect(text.out).toMatch(/\nws:abc: codex since .+, last switch: first run\n$/u);
    const json = JSON.parse((await run(["affinity", "list", "--json"])).out);
    expect(json.projects.map((p: { project_key: string }) => p.project_key)).toEqual(["proj-a", "ws:abc"]);
    expect(json.projects[0]).toMatchObject({ provider: "claude", model: "model-x", reset_requested_at: null });
  });

  it("refuses to reset a project with no row (exit 1, NOT_FOUND) and writes nothing", async () => {
    const none = await run(["affinity", "reset", "proj-a", "--json"]);
    expect(none.code).toBe(1);
    expect(JSON.parse(none.out)).toMatchObject({ error: { code: "NOT_FOUND" } });
    seedRow("proj-b", "claude");
    const missing = await run(["affinity", "reset", "proj-a"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("no affinity recorded for project proj-a");
    expect(rows().map((r) => [r.project_key, r.reset_requested_at])).toEqual([["proj-b", null]]);
  });

  it("records a reset with no daemon and with a daemon holding the lock", async () => {
    seedRow("proj-a", "claude");
    const r = await run(["affinity", "reset", "proj-a", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      schema_version: 1,
      project_key: "proj-a",
      provider: "claude",
      reset_by: "tester",
    });
    expect(rows()[0]).toMatchObject({ reset_by: "tester" });
    const text = await run(["affinity", "list"]);
    expect(text.out).toContain("[reset requested by tester at ");
    const lock = acquireDataDirLock(dataDir); // stands in for a running serve daemon
    try {
      const again = await run(["affinity", "reset", "proj-a"]);
      expect(again.code).toBe(0);
      expect(again.out).toContain("proj-a: reset recorded by tester");
    } finally {
      lock.release();
    }
  });

  it("refuses malformed use with exit 2", async () => {
    expect((await run(["affinity"])).code).toBe(2);
    expect((await run(["affinity", "drop"])).code).toBe(2);
    expect((await run(["affinity", "reset"])).code).toBe(2);
    expect((await run(["affinity", "reset", "a", "b"])).code).toBe(2);
    expect((await run(["affinity", "list", "x"])).code).toBe(2);
  });
});

describe("a reset at the next routing step (T7.7, LLD §17.6)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness({ maxAttempts: 1 });
  });
  afterEach(async () => {
    await h.close();
  });

  it("is user_request until a run succeeds, which consumes it once", async () => {
    await h.delegate("ok");
    const key = h.ledger.listProjectAffinities()[0]?.project_key as string;
    expect(h.ledger.requestAffinityReset(key, "op")).toBe(true);
    // A failing run does not consume the reset.
    const failed = await h.delegate("overload", { provider_preference: "grok" });
    expect(failed.status).toBe("FAILED");
    expect((await h.ok("explain_route", { run_id: failed.run_id })).affinity).toMatchObject({
      affinity_switch_reason: "user_request",
    });
    expect(h.ledger.getProjectAffinity(key)?.reset_by).toBe("op");
    // The next one is still user_request; the preference now decides, and the success consumes the reset.
    const moved = await h.delegate("ok", { provider_preference: "grok" });
    expect(moved.provider.adapter).toBe("grok");
    expect((await h.ok("explain_route", { run_id: moved.run_id })).affinity).toMatchObject({
      provider: "fake",
      affinity_switch_reason: "user_request",
    });
    expect(h.ledger.getProjectAffinity(key)).toMatchObject({
      provider: "grok",
      last_switch_reason: "user_request",
      reset_requested_at: null,
      reset_by: null,
    });
    const events = h.ledger.listRunEvents(moved.run_id).filter((e) => e.type === "routing_affinity_reset");
    expect(events.map((e) => JSON.parse(e.payload_json))).toEqual([{ project_key: key, by: "op" }]);
    // Consumed once: the following delegation holds on the new provider.
    const held = await h.delegate("ok", { provider_preference: "fake" });
    expect(held.provider.adapter).toBe("grok");
    expect((await h.ok("explain_route", { run_id: held.run_id })).affinity).toMatchObject({ held: true });
  }, 120_000);
});
