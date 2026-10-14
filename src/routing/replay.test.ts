/**
 * T7.2 (FR-RTE-03, FR-RTE-02, FR-RTE-04, LLD §17.4, ADR-0044 item 6): every route decision written through the MCP server
 * (plain delegations, a preference, a required provider, a same-provider continuation, a continuation that names another
 * provider and a quota failover) is self-contained: re-running the scorer on the stored row alone reproduces the stored
 * selection, rule, terms and scores exactly. A tampered row is caught, and an M2 eligibility-only row replays as such.
 * No provider CLI is installed or called; the providers are one scripted fake CLI under three ids.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { secondFakeProvider } from "../adapters/fixtures/continuity-fakes.js";
import { AdapterRegistry, type ProviderAdapter, type ProviderId, type ResolvedProfile } from "../adapters/index.js";
import { registerProvider } from "../adapters/providers.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RouteDecisionRow, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { createSwitchboardServer, type SwitchboardMcpServer } from "../mcp/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { replayRouteDecision } from "./decision.js";

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
const MARKER = "[instruction from the orchestrator]";
const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

/** `ok` succeeds; `overload` fails as provider overload (counted by the breaker); `quota` stops on quota unless spare. */
const CLI = `
const a = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (a.includes("--version")) process.stdout.write("fake-cli 1.0.0\\n");
else if (a.includes("--auth-status")) process.stdout.write('{"authenticated":true}\\n');
else if (a.includes("--smoke")) emit({ type: "result", ok: true, summary: "smoke" });
else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { prompt += c; });
  process.stdin.on("end", () => {
    const i = prompt.lastIndexOf(${JSON.stringify(MARKER)});
    const mode = (i >= 0 ? prompt.slice(i + ${MARKER.length}) : prompt).trim();
    emit({ type: "session", session_id: "s-" + process.pid });
    if (mode === "overload") {
      emit({ type: "error", category: "overloaded", message: "busy" });
      process.exitCode = 1;
      return;
    }
    if (mode === "quota" && process.env.FAKE_PROVIDER_ROLE !== "spare") {
      emit({ type: "error", category: "quota", message: "limit reached" });
      process.exitCode = 1;
      return;
    }
    emit({ type: "result", ok: true, summary: "done" });
  });
}
`;

function scripted(id: string, script: string, spare = false): ProviderAdapter {
  const base = new FakeAdapter({ script, timeouts: PATIENT });
  return {
    id: id as ProviderId,
    transports: base.transports,
    gitWriteControl: base.gitWriteControl,
    resumeCwd: base.resumeCwd,
    gitCapabilities: { commitChannel: "none", detail: "test double" },
    probe: (r) => base.probe(r),
    authPreflight: (r) => base.authPreflight(r),
    compile: (req, p) => {
      const inv = base.compile(req, p);
      if ("ineligible" in inv) return inv;
      return spare ? { ...inv, env: { ...inv.env, FAKE_PROVIDER_ROLE: "spare" } } : inv;
    },
    resumeArgs: (b, req, p) => base.resumeArgs(b, req, p),
    parseEvent: (i, s) => base.parseEvent(i, s),
    extractResult: (e, x) => base.extractResult(e, x),
    classifyFailure: (e) => base.classifyFailure(e),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON
type Json = Record<string, any>;

let root: string;
let repo: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle;
let mcp: SwitchboardMcpServer;
let unregister: () => void;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-replay-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const script = path.join(root, "cli.mjs");
  writeFileSync(script, CLI);
  unregister = registerProvider(secondFakeProvider(path.join(root, "home")));
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids: createIdGenerator() });
  const registry = new AdapterRegistry()
    .register(scripted("fake", script))
    .register(scripted("fake-b", script, true))
    .register(scripted("grok", script));
  lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots: [root],
    globalConcurrency: 4,
    perProviderConcurrency: 1,
    resolveProfile: profileFor,
    breaker: { failureThreshold: 10, openSeconds: 300 },
    retry: { maxAttempts: 2, baseMs: 20, capMs: 100, queueHorizonSeconds: 0 },
    eligibility: {
      platform: "linux",
      gate: (id, version) => ({
        eligible: true,
        evidence: { provider: id, observedVersion: version, validatedRange: "test", validatedCliVersion: "test" },
      }),
    },
  });
  lifecycle.start();
  mcp = createSwitchboardServer({
    lifecycle,
    ledger,
    artifacts,
    registry,
    config: {
      allowedRoots: [root],
      mcpClients: new Map([["orch", { id: "orch", maxTrustProfile: "edit-untrusted" as TrustProfile }]]),
      capacity: { windowSeconds: 3600, confidenceRuns: 10 },
      limits: { perProviderConcurrency: 1 },
    },
    clientId: "orch",
  });
});

afterEach(async () => {
  await lifecycle.shutdown();
  await mcp.close();
  unregister();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function call(name: string, args: Json): Promise<Json> {
  const res = await mcp.callTool(name, args);
  const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}") as Json;
  expect(res.isError === true, JSON.stringify(body)).toBe(false);
  return body;
}

async function settle(runId: string): Promise<Json> {
  await lifecycle.waitForTerminal(runId);
  return call("get_run", { run_id: runId });
}

const delegate = async (objective: string, routing: Json = {}) =>
  settle(
    (await call("delegate_task", { objective, workspace_path: repo, trust_profile: "edit-untrusted", routing })).run_id,
  );

function allDecisions(): RouteDecisionRow[] {
  return db.prepare("SELECT * FROM route_decision ORDER BY created_at, id").all() as RouteDecisionRow[];
}

async function waitFor(check: () => boolean): Promise<void> {
  const end = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("route decision replay (T7.2, FR-RTE-03)", () => {
  it("reproduces every stored decision of a mixed session from the stored row alone", async () => {
    const first = await delegate("ok");
    expect(first.status).toBe("SUCCEEDED");
    const overloaded = await delegate("overload", { provider_preference: "fake" });
    expect(overloaded.status).toBe("FAILED");
    if (overloaded.superseded_by !== undefined) await settle(overloaded.superseded_by); // the retry fails the same way
    await delegate("ok"); // now scored with history on `fake`
    await delegate("ok", { provider_preference: "grok" });
    await delegate("ok", { provider_preference: "fake-b", require_provider: true });
    // A same-provider continuation, and one that names another provider (a handoff).
    const resumed = await call("continue_task", { meta_session_id: first.meta_session_id, instruction: "ok" });
    await settle(resumed.run_id);
    const handed = await call("continue_task", {
      meta_session_id: first.meta_session_id,
      instruction: "ok",
      routing: { provider_preference: "grok" },
    });
    await settle(handed.run_id);
    // A quota stop on `fake` fails over by stage 2 to another eligible provider.
    const quota = await delegate("quota", { provider_preference: "fake" });
    expect(quota.failure_code).toBe("QUOTA_EXHAUSTED");
    await waitFor(() => ledger.listRunEvents(quota.run_id).some((e) => e.type === "quota_ladder"));
    const ladder = ledger.listRunEvents(quota.run_id).find((e) => e.type === "quota_ladder");
    expect(JSON.parse(ladder?.payload_json ?? "{}")).toMatchObject({ outcome: "failover" });

    const rows = allDecisions();
    expect(rows.length).toBe(9);
    const rules = new Set<string>();
    for (const row of rows) {
      const replay = replayRouteDecision(row);
      expect(replay, row.id).toEqual({ schemaVersion: 2, ok: true, differences: [] });
      const reasons = JSON.parse(row.reasons_json) as { selection: { rule: string } };
      rules.add(reasons.selection.rule);
      const features = JSON.parse(row.features_json) as Json;
      expect(features.route_features).toMatchObject({ classifier: "heuristic.v1" });
      expect(JSON.parse(row.weights_json ?? "null")).toEqual({
        success: 1,
        latency: 1,
        capacity: 1,
        security: 1,
        handoff: 1,
        cost: 1,
      });
    }
    expect(rules).toEqual(new Set(["configured_order", "score", "provider_preference", "required_provider"]));
  }, 60_000);

  it("reports a tampered row and replays an M2 eligibility-only row as version 1", async () => {
    await delegate("ok");
    await delegate("ok", { provider_preference: "grok" });
    for (const row of allDecisions()) {
      const f = JSON.parse(row.features_json) as Json;
      const p = Object.keys(f.score_inputs)[0] as string;
      f.score_inputs[p].healthy += 5;
      const tampered = replayRouteDecision({ ...row, features_json: JSON.stringify(f) });
      expect(tampered.ok).toBe(false);
      expect(tampered.differences.some((d) => d.startsWith(`score ${p}`))).toBe(true);
      const w = JSON.parse(row.weights_json ?? "{}") as Json;
      expect(replayRouteDecision({ ...row, selected_provider: "nobody" }).ok).toBe(false);
      expect(replayRouteDecision({ ...row, weights_json: JSON.stringify({ ...w, capacity: 7 }) }).ok).toBe(false);
    }
    const m2 = {
      features_json: JSON.stringify({ trust_profile: "edit-untrusted", required_provider: null }),
      weights_json: null,
      candidates_json: JSON.stringify([{ provider: "fake", eligible: true, reasons: [], score: null }]),
      selected_provider: "fake",
      reasons_json: JSON.stringify({ selection: { provider: "fake", basis: "configured_order" } }),
    };
    expect(replayRouteDecision(m2)).toEqual({ schemaVersion: 1, ok: true, differences: [] });
  }, 60_000);
});
