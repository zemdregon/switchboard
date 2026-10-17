/**
 * Test harness for M7 routing tests (T7.2 onward): a real ledger, workspace and lifecycle, one scripted fake CLI
 * registered under three provider ids (`fake`, `fake-b`, `grok`, in that configured order) and MCP servers for two
 * clients (`orch`, `other`), each reached through the SDK client so every result is checked against the published
 * output schemas. No provider CLI is installed or called.
 *
 * Each provider's session event reports the placeholder model `<id>-model`. The instruction is the mode: `ok` succeeds, `overload` fails as provider overload (counted by the breaker), `quota`
 * stops on quota only on `fake` (`fake-b` and `grok` are spares, so a quota failover always lands on a provider that
 * succeeds). A provider id in `FAKE_DOWN` (environment of the test process, read
 * at compile time) is made ineligible by its adapter's compile verdict.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type Database from "better-sqlite3";
import { expect } from "vitest";
import { FakeAdapter } from "../../adapters/fake/adapter.js";
import { secondFakeProvider } from "../../adapters/fixtures/continuity-fakes.js";
import { AdapterRegistry, type ProviderAdapter, type ProviderId, type ResolvedProfile } from "../../adapters/index.js";
import { registerProvider } from "../../adapters/providers.js";
import { ArtifactStore } from "../../artifacts/index.js";
import { createIdGenerator } from "../../ids/index.js";
import { createLedger, type Ledger, openLedger, type RouteDecisionRow, type TrustProfile } from "../../ledger/index.js";
import { RunLifecycle } from "../../lifecycle/index.js";
import { createSwitchboardServer, type SwitchboardMcpServer } from "../../mcp/index.js";
import type { ModelRegistry } from "../../models/registry.js";
import { WorkspaceManager } from "../../workspace/index.js";

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
    emit({ type: "session", session_id: "s-" + process.pid, model: process.env.FAKE_MODEL });
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
    if (mode === "slow") {
      // T14.6: stays RUNNING long enough for a test to pause its project, then finishes on its own.
      setTimeout(() => emit({ type: "result", ok: true, summary: "done" }), 600);
      return;
    }
    emit({ type: "result", ok: true, summary: "done" });
  });
}
`;

/** Providers whose adapter currently refuses to compile (ineligible, `CAPABILITY_MISSING`). Mutable by tests. */
export const down = new Set<string>();
/** T7.12: providers whose adapter declares `reportedModelFlag: accepted`. Mutable by tests; cleared per harness. */
export const pinning = new Set<string>();
/** T7.12: providers whose adapter refuses any requested model (`CAPABILITY_MISSING`). Mutable by tests. */
export const refusesModel = new Set<string>();
/** T7.12: every run compile (not the eligibility `route-check`), with the model it was given. */
export const compiled: { provider: string; runId: string; model: string | undefined }[] = [];

function scripted(id: string, script: string, spare = false): ProviderAdapter {
  const base = new FakeAdapter({ script, timeouts: PATIENT });
  return {
    id: id as ProviderId,
    transports: base.transports,
    gitWriteControl: base.gitWriteControl,
    resumeCwd: base.resumeCwd,
    gitCapabilities: { commitChannel: "none", detail: "test double" },
    get reportedModelFlag() {
      return { kind: pinning.has(id) ? ("accepted" as const) : ("not_accepted" as const), detail: "test double" };
    },
    probe: (r) => base.probe(r),
    authPreflight: (r) => base.authPreflight(r),
    compile: (req, p) => {
      if (down.has(id)) return { ineligible: true, reason: "CAPABILITY_MISSING", detail: `${id} is down for the test` };
      if (req.model !== undefined && refusesModel.has(id)) {
        return { ineligible: true, reason: "CAPABILITY_MISSING", detail: `${id} refuses models for the test` };
      }
      const inv = base.compile(req, p);
      if ("ineligible" in inv) return inv;
      if (req.runId !== "route-check") compiled.push({ provider: id, runId: req.runId, model: req.model });
      // Each provider's native session reports its own placeholder model (`<id>-model`), as a real CLI reports one; a
      // compiled model is reported as the session's model (T7.12).
      const model = req.model ?? `${id}-model`;
      const env = { ...inv.env, FAKE_MODEL: model, ...(spare ? { FAKE_PROVIDER_ROLE: "spare" } : {}) };
      return { ...inv, env };
    },
    resumeArgs: (b, req, p) => base.resumeArgs(b, req, p),
    parseEvent: (i, s) => base.parseEvent(i, s),
    extractResult: (e, x) => base.extractResult(e, x),
    classifyFailure: (e) => base.classifyFailure(e),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON checked by the published output schemas
export type Json = Record<string, any>;

export interface Harness {
  root: string;
  repo: string;
  db: Database.Database;
  ledger: Ledger;
  lifecycle: RunLifecycle;
  /** T15.1: the adapter registry the servers route over (for a queue admission tick in tests). */
  registry: AdapterRegistry;
  /** Raw tool call through the SDK client of `clientId` (default `orch`). */
  call(name: string, args: Json, clientId?: string): Promise<{ isError: boolean; body: Json }>;
  /** Tool call that must succeed. */
  ok(name: string, args: Json, clientId?: string): Promise<Json>;
  delegate(objective: string, routing?: Json, extra?: Json): Promise<Json>;
  /** A further Git repository under the allowed root (another project key). */
  newRepo(name: string): string;
  settle(runId: string): Promise<Json>;
  decisions(): RouteDecisionRow[];
  waitFor(check: () => boolean): Promise<void>;
  client(clientId?: string): Client;
  close(): Promise<void>;
}

export interface HarnessOptions {
  allowedRoots?: readonly string[];
  maxAttempts?: number;
  /** Extra `RunLifecycle` options (for example `routing`); a function receives the harness ledger (T14.4 budgets). */
  lifecycle?: Record<string, unknown> | ((deps: { ledger: Ledger }) => Record<string, unknown>);
  /** Extra MCP server config (for example `routing`). */
  config?: Record<string, unknown>;
  /** Extra MCP server deps, given the harness ledger handle and data directory (T16.9: the skill store). */
  deps?: (h: { db: Database.Database; dataDir: string }) => Record<string, unknown>;
  /** T7.8: model registry for minimum_capability tests. */
  models?: ModelRegistry;
  /** T6.8: one injected clock for the ledger, the lifecycle and the MCP servers. Absent: the system clock. */
  now?: () => Date;
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  down.clear();
  pinning.clear();
  refusesModel.clear();
  compiled.length = 0;
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-route-")));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const script = path.join(root, "cli.mjs");
  writeFileSync(script, CLI);
  const unregister = registerProvider(secondFakeProvider(path.join(root, "home")));
  const db = openLedger(dataDir);
  const ledger = createLedger(db, { ids: createIdGenerator(), ...(opts.now !== undefined ? { now: opts.now } : {}) });
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const allowedRoots = [
    root,
    ...(opts.allowedRoots ?? []),
    ...((opts.config?.allowedRoots as readonly string[] | undefined) ?? []),
  ];
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots, ids: createIdGenerator() });
  const registry = new AdapterRegistry()
    .register(scripted("fake", script))
    .register(scripted("fake-b", script, true))
    .register(scripted("grok", script, true));
  const lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots,
    globalConcurrency: 4,
    perProviderConcurrency: 1,
    resolveProfile: profileFor,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    breaker: { failureThreshold: 10, openSeconds: 300 },
    retry: { maxAttempts: opts.maxAttempts ?? 2, baseMs: 20, capMs: 100, queueHorizonSeconds: 0 },
    eligibility: {
      platform: "linux",
      gate: (id, version) => ({
        eligible: true,
        evidence: { provider: id, observedVersion: version, validatedRange: "test", validatedCliVersion: "test" },
      }),
      ...(opts.models !== undefined ? { models: opts.models } : {}),
    },
    ...(typeof opts.lifecycle === "function" ? opts.lifecycle({ ledger }) : (opts.lifecycle ?? {})),
  });
  lifecycle.start();
  const mcpClients = new Map([
    ["orch", { id: "orch", maxTrustProfile: "edit-untrusted" as TrustProfile }],
    ["other", { id: "other", maxTrustProfile: "edit-untrusted" as TrustProfile }],
  ]);
  const servers = new Map<string, { mcp: SwitchboardMcpServer; client: Client }>();
  for (const clientId of mcpClients.keys()) {
    const mcp = createSwitchboardServer({
      lifecycle,
      ledger,
      artifacts,
      registry,
      config: {
        allowedRoots,
        mcpClients,
        capacity: { windowSeconds: 3600, confidenceRuns: 10 },
        limits: { perProviderConcurrency: 1 },
        ...(opts.config ?? {}),
      },
      ...(opts.deps?.({ db, dataDir }) ?? {}),
      clientId,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    const client = new Client({ name: clientId, version: "0.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await mcp.server.connect(s);
    await client.connect(c);
    await client.listTools(); // caches output schemas: every result is checked against them
    servers.set(clientId, { mcp, client });
  }
  const clientOf = (id = "orch"): Client => {
    const s = servers.get(id);
    if (s === undefined) throw new Error(`no client ${id}`);
    return s.client;
  };
  const call = async (name: string, args: Json, clientId?: string) => {
    const res = await clientOf(clientId).callTool({ name, arguments: args });
    const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}") as Json;
    return { isError: res.isError === true, body };
  };
  const ok = async (name: string, args: Json, clientId?: string) => {
    const r = await call(name, args, clientId);
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    return r.body;
  };
  const settle = async (runId: string) => {
    await lifecycle.waitForTerminal(runId);
    return ok("get_run", { run_id: runId });
  };
  return {
    root,
    repo,
    db,
    ledger,
    lifecycle,
    registry,
    call,
    ok,
    settle,
    client: clientOf,
    delegate: async (objective, routing = {}, extra = {}) =>
      settle(
        (
          await ok("delegate_task", {
            objective,
            workspace_path: repo,
            trust_profile: "edit-untrusted",
            routing,
            ...extra,
          })
        ).run_id,
      ),
    newRepo: (name) => {
      const dir = path.join(root, name);
      mkdirSync(dir);
      g(dir, "init", "-q", "-b", "main");
      writeFileSync(path.join(dir, "README.md"), `${name}\n`);
      g(dir, "add", "-A");
      g(dir, "commit", "-q", "-m", "init");
      return dir;
    },
    decisions: () => db.prepare("SELECT * FROM route_decision ORDER BY created_at, id").all() as RouteDecisionRow[],
    waitFor: async (check) => {
      const end = Date.now() + 30_000;
      while (!check()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    close: async () => {
      await lifecycle.shutdown();
      for (const s of servers.values()) {
        await s.client.close();
        await s.mcp.close();
      }
      unregister();
      db.close();
      rmSync(root, { recursive: true, force: true });
      down.clear();
    },
  };
}
