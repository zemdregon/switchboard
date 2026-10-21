/**
 * `get_capacity`, `switchboard capacity` and the `doctor` capacity section (T6.3; FR-MCP-02, FR-OPS-05, FR-CAP-03,
 * LLD §16.3). One projection behind the three surfaces. Fake adapter only; no provider CLI, login or network; the
 * ledger rows are written directly so that the estimate has inputs without running anything.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { grokUsageFromResult } from "../adapters/grok/usage.js";
import {
  AdapterRegistry,
  type ProbeRunner,
  type ProviderId,
  type ProviderUsageResult,
  type ResolvedProfile,
} from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import {
  CAPACITY_NOTE,
  type CapacityProjection,
  ProviderUsageCache,
  type ProviderUsageReaderDeps,
  usageReadTargets,
} from "../capacity/index.js";
import { main } from "../cli/index.js";
import type { CliIo } from "../cli/io.js";
import { type CapacitySettings, loadConfig } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, LEDGER_FILE_NAME, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { createSwitchboardServer, type SwitchboardMcpServer, TOOL_NAMES, WORK_QUEUE_TOOL_NAMES } from "./index.js";
import {
  inputSchema,
  outputSchema,
  PROJECT_TOOL_NAMES,
  SEARCH_TOOL_NAMES,
  WORK_QUEUE_TOOL_NAMES as WORK_NAMES,
} from "./schemas.js";

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

async function connect(
  capacity?: Pick<CapacitySettings, "windowSeconds" | "confidenceRuns" | "subscriptions" | "pacing">,
  opts?: {
    candidateOrder?: readonly ProviderId[];
    registry?: AdapterRegistry;
    providerUsage?: ProviderUsageReaderDeps;
  },
): Promise<Client> {
  if (!db) openData();
  const reg = opts?.registry ?? registry();
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
    ...(opts?.candidateOrder !== undefined ? { candidateOrder: opts.candidateOrder } : {}),
    ...(opts?.providerUsage !== undefined ? { providerUsage: opts.providerUsage } : {}),
    config: {
      allowedRoots: [root],
      mcpClients: new Map([["c1", { id: "c1", maxTrustProfile: "edit-untrusted" as TrustProfile }]]),
      capacity: capacity ?? { windowSeconds: 7200, confidenceRuns: 4 },
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

/** A pacing line: the doctor summary, a window line, or a subscription header (T6.14). */
function isPacingLine(line: string): boolean {
  return (
    /^\s+pacing\b/.test(line) || /\bdefers (yes|no)\b/.test(line) || /\bverdict (deferred|clear|inactive)\b/.test(line)
  );
}

/**
 * FR-CAP-03 wording rule (LLD §16.3, §16.9) over a text surface. Pacing lines also refuse a plan percentage, and every
 * `controller_estimated` pacing line carries the estimate wording. The older `estimate (controller_estimated): score`
 * line is not a pacing line and is not asked for that phrase.
 */
function expectHonestText(text: string): void {
  for (const line of text.split("\n")) {
    if (/remaining/i.test(line)) expect(line).toMatch(/provider-reported|provider_reported/);
    if (!isPacingLine(line)) continue;
    expect(line).not.toMatch(/%|\bplan\b/i);
    if (/\bcontroller_estimated\b/.test(line)) expect(line).toContain("estimate, Switchboard-observed only");
  }
  expect(text).not.toMatch(/quota left|available quota|%/i);
}

/**
 * FR-CAP-03 over a JSON surface: the only "remaining" keys are explicit_remaining, null or provider-reported, and
 * (ADR-0079) a window's remaining_fraction inside a provider_reported `provider_usage` report.
 */
function expectHonestJson(value: unknown): void {
  const walk = (v: unknown, reported: boolean): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item, reported);
      return;
    }
    if (v === null || typeof v !== "object") return;
    for (const [k, child] of Object.entries(v)) {
      if (/remaining/i.test(k)) {
        if (k === "remaining_fraction") expect(reported).toBe(true);
        else {
          expect(k).toBe("explicit_remaining");
          if (child !== null) expect((child as Json).source).toBe("provider_reported");
        }
      }
      walk(child, reported || (k === "provider_usage" && (child as Json | null)?.source === "provider_reported"));
    }
  };
  walk(value, false);
}

describe("get_capacity on the MCP server (T6.3; FR-MCP-02, LLD §16.3)", () => {
  it("is listed with a closed input schema and an output schema; the earlier tools are unchanged", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES, ...WORK_QUEUE_TOOL_NAMES]);
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

  it("provider filter accepts every registered provider in candidate order, including fake", async () => {
    // When candidateOrder does not contain fake, every registered provider is still included in get_capacity
    const client = await connect(undefined, { candidateOrder: [] });
    const unfiltered = await capacityTool(client);
    expect(unfiltered.isError).toBe(false);
    expect(unfiltered.body.providers.map((p: Json) => p.provider)).toContain("fake");

    const filtered = await capacityTool(client, { provider: "fake" });
    expect(filtered.isError).toBe(false);
    expect(filtered.body.providers).toHaveLength(1);
    expect(filtered.body.providers[0].provider).toBe("fake");
    expect(filtered.body.providers[0]).toEqual(unfiltered.body.providers.find((p: Json) => p.provider === "fake"));

    const unknown = await capacityTool(client, { provider: "nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.body.error.code).toBe("INVALID_REQUEST");
    expect(unknown.body.error.message).toMatch(/unknown provider/);
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

const PACING_OPEN = "2026-10-14T17:41:03.158Z";

function pacingConfig(): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [path.join(root, "repos")],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
      limits: { per_provider_concurrency: 2 },
      capacity: {
        window_seconds: 7200,
        confidence_runs: 4,
        pacing: { mode: "gate", target_fraction: 0.95, burst_fraction: 0.1, min_confidence: 0.5 },
        subscriptions: {
          alpha: {
            providers: ["claude-code"],
            windows: [
              {
                id: "day",
                length_seconds: 86400,
                reset: { kind: "fixed", anchor: "2026-10-14T00:00:00Z" },
                budget: { unit: "runs", value: 10 },
              },
            ],
          },
          beta: {
            providers: ["codex"],
            windows: [
              {
                id: "day",
                length_seconds: 86400,
                reset: { kind: "fixed", anchor: "2026-10-14T00:00:00Z" },
                budget: { unit: "runs", value: 10 },
              },
            ],
          },
        },
      },
    }),
  );
}

/** A finished run whose `provider` is the adapter id (`claude`, `codex`), not the config id. */
function finishedAs(provider: string, startedAt: string, finishedAt = startedAt): void {
  const ms = ledger.createMetaSession({ objective: "o" });
  const r = ledger.createRun({
    metaSessionId: ms.id,
    trustProfile: "inspect-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c1",
    provider,
  });
  db?.prepare("UPDATE run SET state = ?, failure_code = ?, started_at = ?, finished_at = ? WHERE id = ?").run(
    "SUCCEEDED",
    null,
    startedAt,
    finishedAt,
    r.id,
  );
}

function seedPacingLedger(): void {
  openData();
  for (let i = 0; i < 8; i++) finishedAs("claude", "2026-10-14T06:00:00.000Z");
  // created_at is the ledger clock (inside the window). started_at is before window_start, so it must not count.
  finishedAs("claude", "2026-10-13T23:00:00.000Z", "2026-10-14T01:00:00.000Z");
  pacingConfig();
}

describe("pacing block on get_capacity, capacity and doctor (T6.14, LLD §16.9)", () => {
  it("get_capacity and capacity --json agree on the pacing block and the output schema is published", async () => {
    openData();
    const plain = await connect();
    const plainBody = (await capacityTool(plain)).body;
    expect(plainBody).not.toHaveProperty("pacing");

    for (let i = 0; i < 8; i++) finishedAs("claude", "2026-10-14T06:00:00.000Z");
    finishedAs("claude", "2026-10-13T23:00:00.000Z", "2026-10-14T01:00:00.000Z");
    pacingConfig();
    const client = await connect(loadConfig({ configPath }).capacity);
    const tool = (await capacityTool(client)).body;
    const json = await cli(["capacity", "--json"]);
    expect(json.code).toBe(0);
    const { schema_version, ...projection } = JSON.parse(json.out) as Json;
    expect(schema_version).toBe(1);
    expect(projection).toEqual(tool);
    expectHonestJson(projection);

    const alpha = tool.pacing[0];
    const beta = tool.pacing[1];
    expect(tool.pacing).toHaveLength(2);
    expect(alpha.subscription).toBe("alpha");
    expect(alpha.providers).toEqual(["claude-code"]);
    expect(alpha.mode).toBe("gate");
    expect(alpha.verdict).toBe("deferred");
    expect(alpha.deferred_until).toBe(PACING_OPEN);
    expect(alpha.windows[0]).toMatchObject({
      id: "day",
      used_fraction: { value: 0.8, source: "controller_estimated", confidence: 0.8 },
      elapsed_fraction: 0.5,
      pace: "ahead",
      defers: true,
    });
    expect(beta.subscription).toBe("beta");
    expect(beta.providers).toEqual(["codex"]);
    expect(beta.verdict).toBe("clear");
    expect(beta.deferred_until).toBeNull();
    expect(beta.windows[0].used_fraction.value).toBe(0);
    expect(beta.windows[0].defers).toBe(false);

    const one = JSON.parse((await cli(["capacity", "--json", "--provider", "fake"])).out) as Json;
    expect(one.providers).toEqual(tool.providers);
    expect(one.pacing).toEqual(tool.pacing);

    const success = (outputSchema("get_capacity") as { anyOf: Json[] }).anyOf[0] as Json;
    expect(success.required).toEqual(["as_of", "window_seconds", "note", "providers", "affinity"]);
    expect(success.required).not.toContain("pacing");
    expect(success.properties.pacing).toBeDefined();
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(success);
    expect(validate(tool), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(plainBody), JSON.stringify(validate.errors)).toBe(true);
  });

  it("the wording test extends to pacing", async () => {
    seedPacingLedger();
    const text = await cli(["capacity"]);
    expect(text.code).toBe(0);
    expectHonestText(text.out);
    const lines = text.out.split("\n");
    const estimated = lines.filter((l) => isPacingLine(l) && l.includes("controller_estimated"));
    expect(estimated.length).toBeGreaterThan(0);
    for (const line of estimated) expect(line).toContain("estimate, Switchboard-observed only");
    const score = lines.find((l) => l.includes("estimate (controller_estimated):"));
    expect(score).toBeDefined();
    expect(score).not.toContain("Switchboard-observed only");
    expect(text.out).not.toMatch(/\bplan\b/);

    expectHonestText("    day: used 0.4, source provider_reported, defers no\n");
    expect(() => expectHonestText("    day: remaining 10, source controller_estimated, defers no\n")).toThrow();
    expect(() =>
      expectHonestText("       pacing alpha: pace ahead, deferred_until none, source controller_estimated\n"),
    ).toThrow();
    expect(() => expectHonestText("  alpha (verdict clear) plan share\n")).toThrow();
  });

  it("doctor prints one pacing line per subscription", async () => {
    seedPacingLedger();
    db?.close();
    db = undefined;
    const report = JSON.parse((await cli(["doctor", "--json"])).out) as Json;
    const tool = JSON.parse((await cli(["capacity", "--json"])).out) as Json;
    expect(report.capacity.pacing).toEqual(tool.pacing);
    const text = await cli(["doctor"]);
    const lines = text.out.split("\n").filter((l) => /^\s+pacing\b/.test(l));
    expect(lines).toEqual([
      "       pacing alpha: pace ahead, deferred_until " +
        `${PACING_OPEN}, source controller_estimated (estimate, Switchboard-observed only)`,
      "       pacing beta: pace behind, deferred_until none, " +
        "source controller_estimated (estimate, Switchboard-observed only)",
    ]);
    expectHonestText(text.out);
  });

  it("existing tool schemas are unchanged apart from the additive pacing block", () => {
    const names = [...TOOL_NAMES, ...PROJECT_TOOL_NAMES, ...SEARCH_TOOL_NAMES, ...WORK_NAMES];
    for (const name of names) {
      if (name === "get_capacity") continue;
      const encoded = JSON.stringify(outputSchema(name));
      expect(encoded).not.toContain("deferred_until");
      expect(encoded).not.toContain('"pacing"');
    }
    expect(Object.keys((inputSchema("get_capacity").properties ?? {}) as object)).toEqual(["provider"]);
    const success = (outputSchema("get_capacity") as { anyOf: { required?: string[] }[] }).anyOf[0];
    expect(success?.required).not.toContain("pacing");
  });
});

/**
 * ADR-0079 (FR-CAP-13, LLD §16.10): the provider's own usage report laid over the projection. A fake adapter with a
 * reader stands in for Codex; the reader's figures are passed through unchanged and never move the estimate.
 */
describe("provider_usage on get_capacity, capacity and doctor (ADR-0079, FR-CAP-13)", () => {
  const REPORT: ProviderUsageResult = {
    provider: "fake",
    source: "provider_reported",
    observed_at: NOW.toISOString(),
    method: "fake usage read",
    plan: "plus",
    limit_reached: false,
    limit_reached_type: null,
    windows: [
      {
        id: "primary",
        limit_id: "codex",
        window_seconds: 18_000,
        used_fraction: 0.21,
        remaining_fraction: 0.79,
        resets_at: "2026-10-14T15:00:00.000Z",
      },
    ],
    credits: { has_credits: true, unlimited: false, balance: "12.5" },
  };

  class ReportingFake extends FakeAdapter {
    reads = 0;
    constructor(private readonly answer: ProviderUsageResult = REPORT) {
      super({ script: "/nonexistent/fake-cli.mjs" });
    }
    async readProviderUsage(_runner: ProbeRunner, now?: Date): Promise<ProviderUsageResult> {
      this.reads++;
      return { ...this.answer, observed_at: (now ?? NOW).toISOString() };
    }
  }
  const noRun: ProbeRunner = async () => {
    throw new Error("the fake reader takes no runner");
  };

  it("carries the report on the provider's entry, validated by the output schema, and caches it for a minute", async () => {
    const fake = new ReportingFake();
    const client = await connect(undefined, {
      registry: new AdapterRegistry().register(fake),
      providerUsage: { runner: noRun, cache: new ProviderUsageCache() },
    });
    const first = await capacityTool(client);
    expect(first.isError).toBe(false);
    expect(first.body.providers[0].provider_usage).toEqual(REPORT);
    // The estimate is unchanged by the report.
    expect(first.body.providers[0]).toMatchObject({ capacity_score: null, explicit_remaining: null, reset_at: null });
    expectHonestJson(first.body);
    await capacityTool(client, { provider: "fake" });
    expect(fake.reads).toBe(1);
  });

  it("an unknown read is passed through with its reason; without reader deps nothing is read", async () => {
    const unknown: ProviderUsageResult = {
      provider: "fake",
      source: "unknown",
      observed_at: NOW.toISOString(),
      method: "fake usage read",
      error: "timed out",
    };
    const fake = new ReportingFake(unknown);
    const client = await connect(undefined, {
      registry: new AdapterRegistry().register(fake),
      providerUsage: { runner: noRun },
    });
    expect((await capacityTool(client)).body.providers[0].provider_usage).toEqual(unknown);

    const silent = new ReportingFake();
    const other = await connect(undefined, { registry: new AdapterRegistry().register(silent) });
    expect((await capacityTool(other)).body.providers[0]).not.toHaveProperty("provider_usage");
    expect(silent.reads).toBe(0);
  });

  it("a Grok-shaped report (period, amounts, unreported) passes the output schema and renders in text", async () => {
    const recorded = grokUsageFromResult(
      JSON.parse(
        readFileSync(new URL("../adapters/grok/fixtures/billing-supergrok-weekly.json", import.meta.url), "utf8"),
      ),
      NOW.toISOString(),
    );
    const synthetic = grokUsageFromResult(
      JSON.parse(
        readFileSync(new URL("../adapters/grok/fixtures/billing-with-usage.synthetic.json", import.meta.url), "utf8"),
      ),
      NOW.toISOString(),
    );
    for (const report of [recorded, synthetic]) {
      const client = await connect(undefined, {
        registry: new AdapterRegistry().register(new ReportingFake(report)),
        providerUsage: { runner: noRun, cache: new ProviderUsageCache() },
      });
      const got = await capacityTool(client);
      expect(got.isError).toBe(false);
      expect(got.body.providers[0].provider_usage).toEqual(report);
      expectHonestJson(got.body);
    }
    const reg = new AdapterRegistry().register(new ReportingFake(recorded));
    const text = await cli(["capacity"], { adapters: reg, providerUsageRunner: noRun });
    expect(text.out).toContain("period: weekly, resets 2026-10-26T15:37:46.149Z");
    expect(text.out).toContain("prepaid_balance 0 (unit unspecified)");
    expect(text.out).toContain("unreported: config.creditUsagePercent, config.monthlyLimit");
  });

  it("`switchboard capacity` and `doctor` print the reported windows under the wording rule; JSON matches", async () => {
    const reg = new AdapterRegistry().register(new ReportingFake());
    const text = await cli(["capacity"], { adapters: reg, providerUsageRunner: noRun });
    expect(text.code).toBe(0);
    expect(text.out).toContain("provider-reported usage (fake usage read, at 2026-10-14T12:00:00.000Z): plan plus");
    expect(text.out).toContain(
      "primary (18000 s, provider_reported): used 0.21, remaining 0.79, resets 2026-10-14T15:00:00.000Z",
    );
    expectHonestText(text.out);
    const json = await cli(["capacity", "--json"], { adapters: reg, providerUsageRunner: noRun });
    expect((JSON.parse(json.out) as Json).providers[0].provider_usage).toEqual(REPORT);
    const doctor = await cli(["doctor"], { adapters: reg, providerUsageRunner: noRun });
    expect(doctor.out).toContain("Provider-reported usage (read through each provider's own CLI):");
    expect(doctor.out).toContain("primary (18000 s, provider_reported): used 0.21, remaining 0.79");
  });

  it("a provider disabled in config is not read (usageReadTargets keeps enabled entries only)", () => {
    const fake = new ReportingFake();
    const entry = { provider: "fake", enabled: false } as CapacityProjection["providers"][number];
    const projection = { providers: [entry] } as CapacityProjection;
    expect(usageReadTargets([fake], projection)).toEqual([]);
    expect(usageReadTargets([fake], { providers: [{ ...entry, enabled: true }] } as CapacityProjection)).toEqual([
      fake,
    ]);
  });
});
