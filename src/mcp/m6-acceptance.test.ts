/**
 * M6 acceptance on fake adapters (T6.10; ROADMAP §6 M6 row, FRD WF-5, FR-CAP-01 to 08, FR-MCP-02, FR-MCP-10,
 * FR-OPS-05). Everything goes through the MCP server, as an orchestrator would: injected rate-limit, overload, crash and
 * quota failures produce the WF-5 behaviour with successor runs linked to their predecessors; `get_capacity` and
 * `switchboard capacity` never return `explicit_remaining` unless a provider reported it; a reported cache count is a
 * labelled observation; per project the runs that kept versus switched provider and model are counted by reason.
 * No provider CLI is installed or called; the providers are scripted fake CLIs.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { secondFakeProvider } from "../adapters/fixtures/continuity-fakes.js";
import { AdapterRegistry, type ProviderAdapter, type ProviderId, type ResolvedProfile } from "../adapters/index.js";
import { registerProvider } from "../adapters/providers.js";
import { ArtifactStore } from "../artifacts/index.js";
import { main } from "../cli/index.js";
import type { CliIo } from "../cli/io.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { createSwitchboardServer, type SwitchboardMcpServer } from "./index.js";

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
  ...(name === "edit-untrusted" ? {} : {}),
  bypassApproved: false,
});

/**
 * One scripted CLI for every provider. The instruction is `<mode>:<key>`; a per-key counter beside the script makes the
 * first call fail and later calls succeed (`*_once`). `quota` always stops on quota. Every success reports usage with
 * cache token counts under the Grok Build key names (only the `grok` provider id has a mapping, T6.7).
 */
const CLI = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
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
    const p = (i >= 0 ? prompt.slice(i + ${MARKER.length}) : prompt).trim();
    const [mode, key] = p.split(":");
    const counter = path.join(path.dirname(new URL(import.meta.url).pathname), "count-" + (key ?? "x"));
    const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
    writeFileSync(counter, String(n + 1));
    emit({ type: "session", session_id: "s-" + n });
    const first = n === 0;
    if (mode === "rate_limit_once" && first) {
      emit({ type: "error", category: "rate_limit", message: "slow down" });
      process.exitCode = 1;
      return;
    }
    if (mode === "overload_once" && first) {
      emit({ type: "error", category: "overloaded", message: "busy" });
      process.exitCode = 1;
      return;
    }
    if (mode === "crash_once" && first) {
      process.kill(process.pid, "SIGKILL"); // dies before touching the worktree
      return;
    }
    if (mode === "quota" && process.env.FAKE_PROVIDER_ROLE !== "spare") {
      emit({ type: "error", category: "quota", message: "limit reached" });
      process.exitCode = 1;
      return;
    }
    emit({ type: "usage", input_tokens: 10, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 });
    emit({ type: "result", ok: true, summary: "done" });
  });
}
`;

/** The scripted CLI under a provider id. `spare` is the failover target: it never stops on quota. */
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

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON checked by the published output schemas
type Json = Record<string, any>;

let root: string;
let repo: string;
let dataDir: string;
let configPath: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle;
let mcp: SwitchboardMcpServer;
let client: Client;
let registry: AdapterRegistry;
let unregister: () => void;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-m6-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const script = path.join(root, "cli.mjs");
  writeFileSync(script, CLI);
  configPath = path.join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [root],
      mcp_clients: [{ id: "orch", max_trust_profile: "edit-untrusted" }],
      limits: { per_provider_concurrency: 1 },
    }),
  );
  unregister = registerProvider(secondFakeProvider(path.join(root, "home")));
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids: createIdGenerator() });
  // Candidate order: fake, then fake-b (the failover target), then a fake under the `grok` id (cache keys mapped).
  registry = new AdapterRegistry()
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
    retry: { maxAttempts: 3, baseMs: 20, capMs: 100, queueHorizonSeconds: 0 },
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
  client = new Client({ name: "orchestrator", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(s);
  await client.connect(c);
  await client.listTools(); // every result below is checked against the published output schemas
});

afterEach(async () => {
  await lifecycle.shutdown();
  await client.close();
  await mcp.close();
  unregister();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function call(name: string, args: Json): Promise<{ isError: boolean; body: Json }> {
  const res = await client.callTool({ name, arguments: args });
  const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}") as Json;
  return { isError: res.isError === true, body };
}
const delegate = (instruction: string, routing: Json = {}) =>
  call("delegate_task", {
    objective: instruction,
    workspace_path: repo,
    trust_profile: "edit-untrusted",
    routing: { provider_preference: "fake", ...routing },
  });
/** Follow `superseded_by` from the first run until a run is terminal and has no successor; returns the chain. */
async function chain(runId: string): Promise<Json[]> {
  const out: Json[] = [];
  let id = runId;
  const end = Date.now() + 30_000;
  for (;;) {
    const r = await call("get_run", { run_id: id });
    expect(r.isError).toBe(false);
    const terminal = ["SUCCEEDED", "FAILED", "CANCELLED"].includes(r.body.status);
    if (terminal && r.body.superseded_by !== undefined) {
      out.push(r.body);
      id = r.body.superseded_by as string;
      continue;
    }
    if (terminal && r.body.status === "FAILED" && r.body.failure_code === "QUOTA_EXHAUSTED") {
      // The ladder runs after the terminal transition; give it a moment to link a successor.
      const ladder = ledger.listRunEvents(id).some((e) => e.type === "quota_ladder");
      if (!ladder) {
        if (Date.now() > end) throw new Error("no quota_ladder event");
        await new Promise((res) => setTimeout(res, 25));
        continue;
      }
      const again = await call("get_run", { run_id: id });
      if (again.body.superseded_by !== undefined) continue;
    }
    if (terminal) {
      out.push(r.body);
      return out;
    }
    if (Date.now() > end) throw new Error(`run ${id} did not finish: ${r.body.status}`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

describe("M6 acceptance (T6.10)", () => {
  it("rate-limit, overload and pre-mutation crash failures are retried as linked successors (FR-CAP-05, FR-MCP-10)", async () => {
    for (const [mode, code] of [
      ["rate_limit_once", "RATE_LIMIT_TRANSIENT"],
      ["overload_once", "PROVIDER_OVERLOADED"],
      ["crash_once", "PROCESS_CRASH"],
    ] as const) {
      const d = await delegate(`${mode}:${mode}`);
      expect(d.isError).toBe(false);
      const runs = await chain(d.body.run_id as string);
      expect(runs.map((r) => [r.status, r.failure_code ?? null, r.provider.adapter])).toEqual([
        ["FAILED", code, "fake"],
        ["SUCCEEDED", null, "fake"],
      ]);
      expect(runs[0]?.superseded_by).toBe(runs[1]?.run_id);
      expect(runs[1]?.retry_of).toBe(runs[0]?.run_id);
      expect(runs[1]?.meta_session_id).toBe(runs[0]?.meta_session_id);
    }
  });

  it("QUOTA_EXHAUSTED fails over when allowed and returns the code under require_provider (FR-CAP-06, BR-8, BR-9)", async () => {
    const failover = await chain((await delegate("quota:q1")).body.run_id as string);
    expect(failover.map((r) => [r.status, r.failure_code ?? null, r.provider.adapter])).toEqual([
      ["FAILED", "QUOTA_EXHAUSTED", "fake"],
      ["SUCCEEDED", null, "fake-b"],
    ]);
    expect(failover[1]?.retry_of).toBe(failover[0]?.run_id);
    expect((await call("get_artifacts", { run_id: failover[1]?.run_id })).body.artifacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "handoff_view" })]),
    );

    const pinned = await chain((await delegate("quota:q2", { require_provider: true })).body.run_id as string);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatchObject({ status: "FAILED", failure_code: "QUOTA_EXHAUSTED" });
    expect(pinned[0]).not.toHaveProperty("superseded_by");
  });

  it("capacity surfaces: explicit_remaining only if reported, labelled cache counts, kept and switched by reason", async () => {
    await chain((await delegate("rate_limit_once:c1")).body.run_id as string);
    await chain((await delegate("quota:c2")).body.run_id as string);
    await chain(
      (await delegate("ok:c3", { provider_preference: "grok", require_provider: true })).body.run_id as string,
    );

    const tool = await call("get_capacity", {});
    expect(tool.isError).toBe(false);
    for (const p of tool.body.providers as Json[]) {
      expect(p.explicit_remaining).toBeNull(); // no provider reported remaining quota (FR-CAP-03)
      expect(p.estimate_source).toBe("controller_estimated");
    }
    const byId = Object.fromEntries((tool.body.providers as Json[]).map((p) => [p.provider, p]));
    // Only the `grok` id has a sourced cache-key mapping; the same reported keys under `fake` show nothing.
    expect(byId.grok?.cache).toMatchObject({ read: 7, creation: 2, rows: 1, source: "provider_reported" });
    expect(byId.fake).not.toHaveProperty("cache");
    expect(byId["fake-b"]).not.toHaveProperty("cache");

    // One project (the workspace), five runs that started: fake (rate limit), fake (its retry, kept), fake (the next
    // task, kept), fake-b (quota failover, switched), grok (switched). Since T7.5 each switch carries its recorded
    // affinity reason: the failover `capacity_exhausted`, the required provider `user_request`.
    expect(tool.body.affinity.projects).toEqual([
      expect.objectContaining({ runs: 5, kept: 2, switched: { capacity_exhausted: 1, user_request: 1 } }),
    ]);

    const out: string[] = [];
    const io: CliIo = {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: () => {} },
      env: {},
      adapters: registry,
    };
    expect(await main(["capacity", "--json", "--config", configPath], io)).toBe(0);
    const cli = JSON.parse(out.join("")) as Json;
    expect(cli.providers.map((p: Json) => p.explicit_remaining)).toEqual([null, null, null]);
    expect(cli.providers.map((p: Json) => p.provider)).toEqual(["fake", "fake-b", "grok"]);
    expect(cli.affinity.projects).toEqual(tool.body.affinity.projects);
  });
});
