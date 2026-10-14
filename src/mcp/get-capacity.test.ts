/**
 * `get_capacity`, `switchboard capacity` and the `doctor` capacity section (T6.3; FR-MCP-02, FR-OPS-05, FR-CAP-03,
 * LLD §16.3). One projection behind the three surfaces. Fake adapter only; no provider CLI, login or network; the
 * ledger rows are written directly so that the estimate has inputs without running anything.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { CAPACITY_NOTE } from "../capacity/index.js";
import { main } from "../cli/index.js";
import type { CliIo } from "../cli/io.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, LEDGER_FILE_NAME, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { createSwitchboardServer, type SwitchboardMcpServer, TOOL_NAMES } from "./index.js";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const now = () => NOW;

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: "read-only",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON checked by the published output schemas
type Json = Record<string, any>;

let root: string;
let dataDir: string;
let configPath: string;
let db: Database.Database | undefined;
let ledger: Ledger;
let lifecycle: RunLifecycle | undefined;
const servers: { mcp: SwitchboardMcpServer; client: Client }[] = [];

const registry = () => new AdapterRegistry().register(new FakeAdapter({ script: "/nonexistent/fake-cli.mjs" }));

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-cap-")));
  dataDir = path.join(root, "data");
  mkdirSync(path.join(root, "repos"));
  configPath = path.join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [path.join(root, "repos")],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
      limits: { per_provider_concurrency: 2 },
      capacity: { window_seconds: 7200, confidence_runs: 4 },
    }),
  );
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  for (const s of servers.splice(0)) {
    await s.client.close();
    await s.mcp.close();
  }
  db?.close();
  db = undefined;
  rmSync(root, { recursive: true, force: true });
});

function openData(): void {
  mkdirSync(dataDir, { recursive: true });
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator(), now });
}

/** A finished run of `provider` (written directly; the estimator only reads rows). */
function finished(state: "SUCCEEDED" | "FAILED", code: string | null = null, finishedAt = "2026-10-14T11:30:00.000Z") {
  const ms = ledger.createMetaSession({ objective: "o" });
  const r = ledger.createRun({
    metaSessionId: ms.id,
    trustProfile: "inspect-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c1",
    provider: "fake",
  });
  db?.prepare("UPDATE run SET state = ?, failure_code = ?, started_at = ?, finished_at = ? WHERE id = ?").run(
    state,
    code,
    "2026-10-14T11:20:00.000Z",
    finishedAt,
    r.id,
  );
  return r.id;
}

async function connect(): Promise<Client> {
  if (!db) openData();
  const reg = registry();
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({
    db: db as Database.Database,
    artifacts,
    dataDir,
    allowedRoots: [root],
    ids: createIdGenerator(),
  });
  lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: reg,
    allowedRoots: [root],
    globalConcurrency: 4,
    resolveProfile: profileFor,
    eligibility: {
      platform: "linux",
      gate: (id, version) => ({
        eligible: true,
        evidence: { provider: id, observedVersion: version, validatedRange: "test", validatedCliVersion: "test" },
      }),
    },
  });
  const mcp = createSwitchboardServer({
    lifecycle,
    ledger,
    artifacts,
    registry: reg,
    config: {
      allowedRoots: [root],
      mcpClients: new Map([["c1", { id: "c1", maxTrustProfile: "edit-untrusted" as TrustProfile }]]),
      capacity: { windowSeconds: 7200, confidenceRuns: 4 },
      limits: { perProviderConcurrency: 2 },
    },
    clientId: "c1",
    now,
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(s);
  await client.connect(c);
  await client.listTools(); // caches output schemas: every result below is checked against get_capacity's schema
  servers.push({ mcp, client });
  return client;
}

async function capacityTool(client: Client, args: Json = {}): Promise<{ isError: boolean; body: Json }> {
  const res = await client.callTool({ name: "get_capacity", arguments: args });
  const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}") as Json;
  if (res.structuredContent !== undefined) expect(res.structuredContent).toEqual(body);
  return { isError: res.isError === true, body };
}

async function cli(args: string[], extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: {},
    adapters: registry(),
    now,
    ...extra,
  };
  const code = await main([...args, "--config", configPath], io);
  return { code, out: out.join(""), err: err.join("") };
}

/** FR-CAP-03 wording rule (LLD §16.3) over a text surface. */
function expectHonestText(text: string): void {
  for (const line of text.split("\n")) {
    if (/remaining/i.test(line)) expect(line).toMatch(/provider-reported|provider_reported/);
  }
  expect(text).not.toMatch(/quota left|available quota|%/i);
}

/** FR-CAP-03 over a JSON surface: the only "remaining" key is explicit_remaining, null or provider-reported. */
function expectHonestJson(value: unknown): void {
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v === null || typeof v !== "object") return;
    for (const [k, child] of Object.entries(v)) {
      if (/remaining/i.test(k)) {
        expect(k).toBe("explicit_remaining");
        if (child !== null) expect((child as Json).source).toBe("provider_reported");
      }
      walk(child);
    }
  };
  walk(value);
}

describe("get_capacity on the MCP server (T6.3; FR-MCP-02, LLD §16.3)", () => {
  it("is listed with a closed input schema and an output schema; the earlier tools are unchanged", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(TOOL_NAMES.slice(0, 7)).toEqual([
      "delegate_task",
      "continue_task",
      "get_run",
      "cancel_run",
      "get_artifacts",
      "list_capabilities",
      "list_projects",
    ]);
    const tool = tools.find((t) => t.name === "get_capacity");
    expect(tool?.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["provider"]);
    expect(tool?.outputSchema?.type).toBe("object");
    expect(tool?.description).toMatch(/never provider-authoritative quota/);
  });

  it("with no evidence every provider reads unknown, never headroom", async () => {
    const client = await connect();
    const r = await capacityTool(client);
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ as_of: NOW.toISOString(), window_seconds: 7200, note: CAPACITY_NOTE });
    expect(r.body.providers).toEqual([
      expect.objectContaining({
        provider: "fake",
        capacity_score: null,
        confidence: 0,
        throttle_risk: "unknown",
        explicit_remaining: null,
        reset_at: null,
        concurrency_available: 2,
        concurrency_limit: 2,
      }),
    ]);
    expectHonestJson(r.body);
  });

  it("validates its input: an unknown provider and a malformed one are INVALID_REQUEST", async () => {
    const client = await connect();
    const unknown = await capacityTool(client, { provider: "nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.body.error.code).toBe("INVALID_REQUEST");
    expect(unknown.body.error.message).toMatch(/unknown provider/);
    const bad = await capacityTool(client, { provider: "Bad Provider!" });
    expect(bad.body.error.code).toBe("INVALID_REQUEST");
    const extra = await capacityTool(client, { provider: "fake", window: 5 });
    expect(extra.body.error.code).toBe("INVALID_REQUEST");
    expect((await capacityTool(client, { provider: "fake" })).body.providers).toHaveLength(1);
  });
});

describe("one projection for get_capacity, switchboard capacity and doctor (T6.3; FR-OPS-05, FR-CAP-03)", () => {
  it("get_capacity and capacity --json return the same fields and values for the same ledger and clock", async () => {
    openData();
    finished("SUCCEEDED");
    finished("FAILED", "RATE_LIMIT_TRANSIENT");
    finished("SUCCEEDED", null, "2026-10-14T09:00:00.000Z"); // outside the 2 h window
    db?.prepare(
      `INSERT INTO provider_health (provider, auth_state, version_state, breaker_state, consecutive_failures, updated_at)
       VALUES ('fake', 'UNKNOWN', 'UNVERIFIED', 'CLOSED', 1, ?)`,
    ).run(NOW.toISOString());
    const client = await connect();
    const tool = (await capacityTool(client)).body;
    expect(tool.providers[0]).toMatchObject({
      throttle_risk: "elevated",
      capacity_score: 0.5,
      confidence: 0.5,
      breaker: { state: "CLOSED", until: null, consecutive_failures: 1 },
      window: { terminal_runs: 2, counted_failures: 1 },
    });

    const json = await cli(["capacity", "--json"]);
    expect(json.code).toBe(0);
    const { schema_version, ...projection } = JSON.parse(json.out) as Json;
    expect(schema_version).toBe(1);
    expect(projection).toEqual(tool);
    expectHonestJson(projection);

    const one = await cli(["capacity", "--json", "--provider", "fake"]);
    expect(JSON.parse(one.out).providers).toEqual(tool.providers);
  });

  it("the text view labels estimates and only names provider-reported values as remaining", async () => {
    openData();
    const limited = finished("FAILED", "RATE_LIMIT_TRANSIENT");
    ledger.appendRunEvent({
      runId: limited,
      type: "provider_event",
      payload: { kind: "rate_limit", reset_at: "2026-10-14T12:30:00.000Z" },
    });
    const text = await cli(["capacity"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain(CAPACITY_NOTE);
    expect(text.out).toContain("estimate (controller_estimated): score 0.00, confidence 1.00, throttle risk high");
    expect(text.out).toContain("provider-reported remaining: not reported");
    expect(text.out).toContain("provider-reported reset: 2026-10-14T12:30:00.000Z");
    expectHonestText(text.out);
  });

  it("with no ledger yet every provider is unknown and nothing is created", async () => {
    const r = await cli(["capacity", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).providers[0]).toMatchObject({ throttle_risk: "unknown", capacity_score: null });
    expect(existsSync(path.join(dataDir, LEDGER_FILE_NAME))).toBe(false);
  });

  it("usage errors: an unknown provider, a positional argument, --provider on another command", async () => {
    expect((await cli(["capacity", "--provider", "nope"])).code).toBe(2);
    expect((await cli(["capacity", "extra"])).code).toBe(2);
    expect((await cli(["runs", "list", "--provider", "fake"])).code).toBe(2);
  });

  it("doctor shows one capacity line per adapter from the same projection, labelled as estimates", async () => {
    openData();
    finished("FAILED", "QUOTA_EXHAUSTED");
    db?.close();
    db = undefined;
    const json = await cli(["doctor", "--json"]);
    const report = JSON.parse(json.out) as Json;
    const tool = JSON.parse((await cli(["capacity", "--json"])).out) as Json;
    expect(report.capacity.providers).toEqual(tool.providers);
    const text = await cli(["doctor"]);
    expect(text.out).toContain("Capacity (controller estimates, not provider quota");
    expect(text.out).toMatch(/fake: breaker CLOSED, throttle risk high, estimate confidence 0\.25/);
    expectHonestText(text.out);
  });
});
