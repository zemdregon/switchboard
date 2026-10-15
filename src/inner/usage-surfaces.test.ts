/**
 * T11.5 done-when, at the surfaces it names (FR-INN-15, BR-41, ADR-0007): `get_capacity` on the MCP server,
 * `switchboard capacity` (JSON and text) and `runs show --json` are byte-identical with and without inner calls made
 * through the real inner-agent pipeline, both when no subscription is shared and when `shares_subscription_with` names
 * the very provider the estimate is for. The estimator's projection is rendered once for every surface (T6.3, FR-OPS-05:
 * one projection for `get_capacity`, `switchboard capacity` and `doctor`), so the `doctor --json` document and a
 * `get_capacity` call filtered with `{ provider }` are covered here too. The unit tests in `usage.test.ts` and
 * `../capacity/capacity.test.ts` prove the same at the stored rows and the projection; this file proves it at the
 * published tool and CLI output. After #330: `get_run`, `capacity --provider`, and `inner test` with the flag in the
 * on-disk config. Fake adapter and fake inner backend only; no provider CLI, login or external network.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { main } from "../cli/index.js";
import type { CliIo } from "../cli/io.js";
import { resolveHttpTransport } from "../config/http-transport.js";
import { resolveInnerAgent } from "../config/inner-agent.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { type HttpTransportListener, startHttpTransport } from "../mcp/http.js";
import { createSwitchboardServer, type SwitchboardMcpServer } from "../mcp/index.js";
import { OAuthTokenStore } from "../mcp/oauth-tokens.js";
import { WorkspaceManager } from "../workspace/index.js";
import { createFakeBackend, createInnerAgent, type FakeStep, type InnerTaskContract } from "./index.js";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const now = () => NOW;
const PROVIDER = "fake";

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: "read-only",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

const contract: InnerTaskContract<{ title: string }, { title: string }> = {
  task: "run_title",
  template_version: "run_title.v1",
  system: "Write a title.",
  response_schema: {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: { title: { type: "string", minLength: 1, maxLength: 80 } },
  },
  sends_source_content: false,
  fallback: () => ({ title: "fallback" }),
  accept: (v) => v as { title: string },
};

/** Accepted, rejected after a re-ask, then a backend error: three calls that reached the backend. */
const SCRIPT: readonly FakeStep[] = [
  { kind: "text", text: '{"title":"Fix login"}', usage: { in: 1_000_000, out: 50_000 } },
  { kind: "text", text: "not json", usage: { in: 10, out: 1 } },
  { kind: "text", text: "still not", usage: { in: 10, out: 1 } },
  { kind: "error" },
];

let root: string;
let dataDir: string;
let configPath: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle | undefined;
let httpListener: HttpTransportListener | undefined;
const servers: { mcp: SwitchboardMcpServer; client: Client }[] = [];

const registry = () => new AdapterRegistry().register(new FakeAdapter({ script: "/nonexistent/fake-cli.mjs" }));

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-usage-surf-")));
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
  mkdirSync(dataDir, { recursive: true });
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator(), now });
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  for (const s of servers.splice(0)) {
    await s.client.close();
    await s.mcp.close();
  }
  await httpListener?.close();
  httpListener = undefined;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** A finished run of the fake provider with one provider-reported usage row, so the estimate has real inputs. */
function finishedRun(): string {
  const ms = ledger.createMetaSession({ objective: "o" });
  const r = ledger.createRun({
    metaSessionId: ms.id,
    trustProfile: "inspect-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c1",
    provider: PROVIDER,
  });
  db.prepare("UPDATE run SET state = ?, failure_code = ?, started_at = ?, finished_at = ? WHERE id = ?").run(
    "SUCCEEDED",
    null,
    "2026-10-14T11:20:00.000Z",
    "2026-10-14T11:30:00.000Z",
    r.id,
  );
  ledger.insertUsageObservation({
    runId: r.id,
    provider: PROVIDER,
    harness: PROVIDER,
    source: "provider_reported",
    metrics: { "usage.input_tokens": 100, "usage.output_tokens": 20 },
  });
  return r.id;
}

async function connect(http = false): Promise<Client> {
  const reg = registry();
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids: createIdGenerator() });
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
  const activeLifecycle = lifecycle;
  const makeServer = () =>
    createSwitchboardServer({
      lifecycle: activeLifecycle,
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
  if (http) {
    const settings = resolveHttpTransport({
      enabled: true,
      public_url: "https://sb.example.test/mcp",
      port: 0,
      default_mcp_client: "c1",
    });
    if (!settings) throw new Error("HTTP settings missing");
    const tokens = new OAuthTokenStore(db);
    httpListener = await startHttpTransport(settings, {
      tokens,
      clients: {
        register: () => {
          throw new Error("not used");
        },
        get: (clientId) => ({ clientId, status: "approved", redirectUris: [], grantTypes: [], createdAt: "" }),
      },
      mcpServerFor: () => makeServer(),
    });
    if (!httpListener) throw new Error("HTTP listener missing");
    const { token } = tokens.issue({
      kind: "access",
      clientId: "usage-fixture",
      resource: settings.resource,
      scopes: ["mcp"],
      ttlMs: 60_000,
    });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpListener.address.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    // The SDK sessionId type needs a cast with exactOptionalPropertyTypes (as in the M13 tests).
    await client.connect(transport as Transport);
    await client.listTools();
    servers.push({ mcp: { close: async () => {} } as SwitchboardMcpServer, client });
    return client;
  }
  const mcp = makeServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(s);
  await client.connect(c);
  await client.listTools();
  servers.push({ mcp, client });
  return client;
}

/** The exact text the tool returns (what a caller sees), not a re-serialisation. */
async function capacityText(client: Client, args: Record<string, unknown> = {}): Promise<string> {
  const res = await client.callTool({ name: "get_capacity", arguments: args });
  expect(res.isError).not.toBe(true);
  return (res.content as { text: string }[])[0]?.text ?? "";
}

async function cli(args: string[], allowNonZero = false, extra: Partial<CliIo> = {}): Promise<string> {
  const out: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: () => {} },
    env: {},
    adapters: registry(),
    now,
    ...extra,
  };
  const code = await main([...args, "--config", configPath], io);
  if (!allowNonZero) expect(code).toBe(0);
  return out.join("");
}

async function toolText(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError).not.toBe(true);
  return (res.content as { text: string }[])[0]?.text ?? "";
}

/** A `runs show --json` document as [everything but `events`, re-serialised canonically; the events]. */
function splitEvents(json: string): [string, { type: string }[]] {
  const { events, ...rest } = JSON.parse(json) as { events: { type: string }[] } & Record<string, unknown>;
  return [JSON.stringify(rest), events];
}

function innerAgent(shares: string | null) {
  const settings = resolveInnerAgent({
    enabled: true,
    backend: {
      kind: "http",
      base_url: "http://127.0.0.1:1",
      model: "cfg-model",
      shares_subscription_with: shares,
    },
    tasks: { run_title: { enabled: true } },
  });
  return createInnerAgent(settings, { backend: createFakeBackend({ script: SCRIPT }), ledger });
}

describe("get_capacity, switchboard capacity, doctor and runs show with and without inner calls (T11.5; FR-INN-15, BR-41)", () => {
  for (const shares of [null, PROVIDER]) {
    const label = shares === null ? "no shared subscription" : `shares_subscription_with = ${shares}`;
    it(`${label}: every surface is byte-identical after three inner calls under a run of the provider`, async () => {
      const runId = finishedRun();
      const client = await connect();
      const before = {
        tool: await capacityText(client),
        toolForProvider: await capacityText(client, { provider: PROVIDER }),
        capacity: await cli(["capacity", "--json"]),
        capacityProvider: await cli(["capacity", "--provider", PROVIDER, "--json"]),
        capacityText: await cli(["capacity"]),
        // The third renderer of the one projection (T6.3, FR-OPS-05). The on-disk config declares no inner agent, so
        // doctor's inner sections and the config-derived inner_shared_subscription warning are absent and its document
        // is a function of config, probes and the ledger; inner calls alone must not change it. Probe failures are
        // environment facts identical on both sides, so a non-zero exit is allowed and the stdout is still compared.
        doctor: await cli(["doctor", "--json"], true),
        show: await cli(["runs", "show", runId, "--json"]),
        // get_run without include_events is the envelope (no event list): inner_call events must not appear, and usage
        // stays provider_reported only.
        getRun: await toolText(client, "get_run", { run_id: runId }),
      };
      // The estimate has evidence (a terminal run and a usage row): the comparison is not between two empty answers.
      const parsed = JSON.parse(before.tool) as {
        providers: { window: { terminal_runs: number; usage_observations: number } }[];
      };
      expect(parsed.providers[0]?.window).toMatchObject({ terminal_runs: 1, usage_observations: 1 });
      const filtered = JSON.parse(before.toolForProvider) as { providers: unknown[] };
      expect(filtered.providers).toHaveLength(1);
      expect((JSON.parse(before.show) as { usage: unknown[] }).usage).toHaveLength(1);
      expect(JSON.parse(before.doctor).capacity.providers).toHaveLength(1);

      const svc = innerAgent(shares);
      const results = [];
      for (let i = 0; i < 3; i++) results.push(await svc.call(contract, { user: "objective: tidy", run_id: runId }));
      expect(results.map((r) => r.outcome)).toEqual(["accepted", "rejected_validator", "fallback_unavailable"]);
      expect(ledger.listInnerCalls()).toHaveLength(3);
      const inner = db
        .prepare("SELECT provider, metrics_json FROM usage_observation WHERE source = 'inner_agent'")
        .all();
      expect(inner).toHaveLength(shares === null ? 0 : 3);
      if (shares !== null) {
        expect(inner[0]).toEqual({
          provider: PROVIDER,
          metrics_json: JSON.stringify({ input_tokens: 1_000_000, output_tokens: 50_000 }),
        });
      }

      expect(await capacityText(client)).toBe(before.tool);
      expect(await capacityText(client, { provider: PROVIDER })).toBe(before.toolForProvider);
      expect(await cli(["capacity", "--json"])).toBe(before.capacity);
      expect(await cli(["capacity", "--provider", PROVIDER, "--json"])).toBe(before.capacityProvider);
      expect(await cli(["capacity"])).toBe(before.capacityText);
      expect(await cli(["doctor", "--json"], true)).toBe(before.doctor);
      expect(await toolText(client, "get_run", { run_id: runId })).toBe(before.getRun);
      // `runs show` lists the run's events, and each inner call is one `inner_call` run event by design (LLD §13.4 step
      // 13), so the events gained are exactly those; everything else, the provider-reported usage view included, is
      // byte-identical, and no event payload carries a token figure.
      const [beforeRest, beforeEvents] = splitEvents(before.show);
      const [afterRest, afterEvents] = splitEvents(await cli(["runs", "show", runId, "--json"]));
      expect(afterRest).toBe(beforeRest);
      expect(beforeEvents).toEqual([]);
      expect(afterEvents.map((e) => e.type)).toEqual(["inner_call", "inner_call", "inner_call"]);
      expect(JSON.stringify(afterEvents)).not.toMatch(/token|usage/u);
    });
  }
});

describe("inner test CLI and doctor when shares_subscription_with is in the on-disk config (T11.5 after #330)", () => {
  it("inner test writes a labelled observation with null run_id; capacity and doctor.capacity stay byte-identical; the warning is config-derived", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        data_dir: dataDir,
        allowed_roots: [path.join(root, "repos")],
        mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
        limits: { per_provider_concurrency: 2 },
        capacity: { window_seconds: 7200, confidence_runs: 4 },
        inner_agent: {
          enabled: true,
          backend: {
            kind: "http",
            base_url: "http://127.0.0.1:1",
            model: "cfg-model",
            shares_subscription_with: "claude-code",
          },
          tasks: { run_title: { enabled: true } },
        },
      }),
    );
    finishedRun();
    const client = await connect();
    const backend = createFakeBackend({
      script: [{ kind: "text", text: '{"title":"Fix greeting typo"}', usage: { in: 11, out: 5 } }],
    });
    const extra = { innerBackend: backend };
    const before = {
      tool: await capacityText(client),
      capacity: await cli(["capacity", "--json"], false, extra),
      doctor: JSON.parse(await cli(["doctor", "--json"], true, extra)) as {
        checks: { id: string; status: string; detail: string }[];
        capacity: unknown;
        inner_agent: { tasks: { task: string; total_calls: number }[] };
      },
    };
    const warn = before.doctor.checks.find((c) => c.id === "inner_shared_subscription");
    expect(warn).toMatchObject({ status: "warn" });
    expect(warn?.detail).toMatch(/shares the claude-code subscription/);
    expect(before.doctor.inner_agent.tasks.find((t) => t.task === "run_title")?.total_calls).toBe(0);

    const report = JSON.parse(await cli(["inner", "test", "run_title", "--json"], false, extra)) as {
      accepted: boolean;
      task: string;
    };
    expect(report).toMatchObject({ accepted: true, task: "run_title" });
    expect(ledger.listInnerCalls()).toEqual([
      expect.objectContaining({ task: "run_title", run_id: null, attempts: 1 }),
    ]);
    expect(
      db
        .prepare("SELECT run_id, provider, source, metrics_json FROM usage_observation WHERE source = 'inner_agent'")
        .all(),
    ).toEqual([
      {
        run_id: null,
        provider: "claude-code",
        source: "inner_agent",
        metrics_json: JSON.stringify({ input_tokens: 11, output_tokens: 5 }),
      },
    ]);

    expect(await capacityText(client)).toBe(before.tool);
    expect(await cli(["capacity", "--json"], false, extra)).toBe(before.capacity);
    const after = JSON.parse(await cli(["doctor", "--json"], true, extra)) as typeof before.doctor;
    expect(after.capacity).toEqual(before.doctor.capacity);
    expect(after.checks.find((c) => c.id === "inner_shared_subscription")).toEqual(warn);
    // Honest: the inner-agent section reports inner_call counts, so the whole doctor document is not identical.
    expect(after.inner_agent.tasks.find((t) => t.task === "run_title")?.total_calls).toBe(1);
  });
});

describe("Streamable HTTP capacity isolation (T11.14 residual; FR-INN-15)", () => {
  for (const shares of [null, PROVIDER]) {
    it(`keeps filtered and unfiltered responses byte-identical with shared subscription ${shares}`, async () => {
      const runId = finishedRun();
      const client = await connect(true);
      const before = [await capacityText(client), await capacityText(client, { provider: PROVIDER })];
      expect(JSON.parse(before[0] as string).providers[0].window).toMatchObject({
        terminal_runs: 1,
        usage_observations: 1,
      });
      const providerRows = db.prepare("SELECT * FROM usage_observation WHERE source = 'provider_reported'").all();
      const service = innerAgent(shares);
      const outcomes = [];
      for (let i = 0; i < 3; i++)
        outcomes.push((await service.call(contract, { user: "tidy", run_id: runId })).outcome);
      expect(outcomes).toEqual(["accepted", "rejected_validator", "fallback_unavailable"]);
      expect(ledger.listInnerCalls()).toHaveLength(3);
      const innerRows = db
        .prepare(
          "SELECT provider, run_id, metrics_json FROM usage_observation WHERE source = 'inner_agent' ORDER BY rowid",
        )
        .all();
      expect(innerRows).toEqual(
        shares === null
          ? []
          : [
              {
                provider: PROVIDER,
                run_id: runId,
                metrics_json: JSON.stringify({ input_tokens: 1_000_000, output_tokens: 50_000 }),
              },
              {
                provider: PROVIDER,
                run_id: runId,
                metrics_json: JSON.stringify({ input_tokens: 20, output_tokens: 2 }),
              },
              {
                provider: PROVIDER,
                run_id: runId,
                metrics_json: JSON.stringify({}),
              },
            ],
      );
      expect(db.prepare("SELECT * FROM usage_observation WHERE source = 'provider_reported'").all()).toEqual(
        providerRows,
      );
      expect(await capacityText(client)).toBe(before[0]);
      expect(await capacityText(client, { provider: PROVIDER })).toBe(before[1]);
    });
  }
});
