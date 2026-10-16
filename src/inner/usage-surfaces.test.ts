/**
 * T11.5 done-when, at the surfaces it names (FR-INN-15, BR-41, ADR-0007): `get_capacity` on the MCP server,
 * `switchboard capacity` (JSON and text) and `runs show --json` are byte-identical with and without inner calls made
 * through the real inner-agent pipeline, both when no subscription is shared and when `shares_subscription_with` names
 * the very provider the estimate is for. The estimator's projection is rendered once for every surface (T6.3, FR-OPS-05:
 * one projection for `get_capacity`, `switchboard capacity` and `doctor`), so the `doctor --json` document and a
 * `get_capacity` call filtered with `{ provider }` are covered here too. The unit tests in `usage.test.ts` and
 * `../capacity/capacity.test.ts` prove the same at the stored rows and the projection; this file proves it at the
 * published tool and CLI output. After #330: `get_run`, `capacity --provider`, and `inner test` with the flag in the
 * on-disk config. After #399: the Streamable HTTP session pins `get_run` too and a second session opened after the
 * calls, and a flag naming an unknown provider id is refused at `doctor` and `inner test` before either surface can
 * name it. Fake adapter and fake inner backend only; no provider CLI, login or external network (the HTTP transport
 * listens on loopback).
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
import {
  createClassifyRouteFeaturesHook,
  createCommitMessageTask,
  createFakeBackend,
  createInnerAgent,
  type FakeStep,
  type InnerTaskContract,
} from "./index.js";

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
let httpToken: string | undefined;
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
  httpToken = undefined;
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
    httpToken = token;
    return connectHttpSession();
  }
  const mcp = makeServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(s);
  await client.connect(c);
  await client.listTools();
  servers.push({ mcp, client });
  return client;
}

/**
 * A new Streamable HTTP session against the listener `connect(true)` started: the transport calls `mcpServerFor` once
 * per session, so this client talks to a fresh `SwitchboardMcpServer` instance over the same lifecycle and ledger.
 */
async function connectHttpSession(): Promise<Client> {
  if (!httpListener || httpToken === undefined) throw new Error("connect(true) first");
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpListener.address.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${httpToken}` } },
  });
  // The SDK sessionId type needs a cast with exactOptionalPropertyTypes (as in the M13 tests).
  await client.connect(transport as Transport);
  await client.listTools();
  servers.push({ mcp: { close: async () => {} } as SwitchboardMcpServer, client });
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

/** Every production reader of `usage_observation` and `inner_call`, as the text each returns, for a byte comparison. */
async function readerSurfaces(client: Client, runId: string, extra: Partial<CliIo>) {
  return {
    innerStatusJson: await cli(["inner", "status", "--json"], true, extra),
    innerStatus: await cli(["inner", "status"], true, extra),
    doctorJson: await cli(["doctor", "--json"], true, extra),
    doctor: await cli(["doctor"], true, extra),
    tool: await capacityText(client),
    toolForProvider: await capacityText(client, { provider: PROVIDER }),
    capacity: await cli(["capacity", "--json"]),
    capacityText: await cli(["capacity"]),
    show: await cli(["runs", "show", runId, "--json"]),
    showText: await cli(["runs", "show", runId]),
    getRun: await toolText(client, "get_run", { run_id: runId }),
    getRunEvents: await toolText(client, "get_run", { run_id: runId, include_events: {} }),
  };
}

function innerAgent(shares: string | null, script: readonly FakeStep[] = SCRIPT) {
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
  return createInnerAgent(settings, { backend: createFakeBackend({ script }), ledger });
}

/** The human `runs show` split into [everything but its event lines (`  seq  ts  type  payload`); the event lines]. */
function splitEventLines(text: string): [string, string[]] {
  const isEvent = (line: string) => /^ {2} *\d+ {2}\S+ {2}\S+ {2}/u.test(line);
  const lines = text.split("\n");
  return [lines.filter((l) => !isEvent(l)).join("\n"), lines.filter(isEvent)];
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
        // get_run with include_events is the same envelope plus the compact event list (LLD §3).
        getRunEvents: await toolText(client, "get_run", { run_id: runId, include_events: {} }),
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
      // The MCP tool's event list says the same: three inner_call events, no token figure, the envelope around them
      // byte-identical (so the `usage` object a primary agent reads is unchanged by the inner calls).
      const [beforeEnvelope, beforeToolEvents] = splitEvents(before.getRunEvents);
      const [afterEnvelope, afterToolEvents] = splitEvents(
        await toolText(client, "get_run", { run_id: runId, include_events: {} }),
      );
      expect(afterEnvelope).toBe(beforeEnvelope);
      expect(beforeToolEvents).toEqual([]);
      expect(afterToolEvents.map((e) => e.type)).toEqual(["inner_call", "inner_call", "inner_call"]);
      expect(JSON.stringify(afterToolEvents)).not.toMatch(/token|usage/u);
    });
  }
});

describe("each reader keeps to its own table: an inner_agent usage row moves no inner diagnostic and no provider surface (T11.5; ADR-0007)", () => {
  it("a labelled observation no inner call made changes nothing in inner status, doctor, get_capacity, capacity, runs show or get_run", async () => {
    // The pipeline writes an inner_agent row only beside an inner_call row, so this row can only be planted directly
    // (the ledger's own `insertUsageObservation` refuses the source). It names the provider with capacity evidence, the
    // finished run and a huge count, so that any reader that joined `usage_observation` without its `source` filter,
    // or any inner diagnostic that read `usage_observation` instead of `inner_call`, would show it. The on-disk flag
    // must name a configured provider id (the fake adapter's is not one), so the real call charges claude-code.
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
    const runId = finishedRun();
    const client = await connect();
    const extra = {
      innerBackend: createFakeBackend({
        script: [{ kind: "text", text: '{"title":"Fix greeting typo"}', usage: { in: 11, out: 5 } }],
      }),
    };
    // One real call first, so the inner diagnostics compare populated documents (one call, one labelled row), not
    // empty ones.
    expect(JSON.parse(await cli(["inner", "test", "run_title", "--json"], false, extra))).toMatchObject({
      accepted: true,
    });
    expect(ledger.listInnerCalls()).toHaveLength(1);
    const surfaces = () => readerSurfaces(client, runId, extra);
    const before = await surfaces();
    // The human `runs show` prints a usage section only from provider-reported rows (`src/cli/runs.ts`): it names the
    // run's provider-reported row and nothing about the inner agent.
    expect(before.showText).toMatch(/usage/iu);
    expect(before.showText).not.toMatch(/inner/iu);
    const doctor = JSON.parse(before.doctorJson) as {
      checks: { id: string }[];
      inner_agent: { tasks: { task: string; total_calls: number }[] };
    };
    expect(doctor.checks.map((c) => c.id)).toContain("inner_shared_subscription");
    expect(doctor.inner_agent.tasks.find((t) => t.task === "run_title")?.total_calls).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_observation WHERE source = 'inner_agent'").get()).toEqual({
      n: 1,
    });

    const PLANTED = 987_654_321;
    db.prepare(
      `INSERT INTO usage_observation (id, run_id, provider, harness, backing_provider, model, source, metrics_json,
                                      observed_at)
       VALUES ('use_planted_inner', ?, ?, ?, NULL, 'cfg-model', 'inner_agent', ?, ?)`,
    ).run(
      runId,
      PROVIDER,
      PROVIDER,
      JSON.stringify({ input_tokens: PLANTED, output_tokens: PLANTED }),
      NOW.toISOString(),
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_observation WHERE source = 'inner_agent'").get()).toEqual({
      n: 2,
    });

    const after = await surfaces();
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain(String(PLANTED));
    // The ledger's own run view returns the planted row (it lists every source for the run); the readers above are what
    // filter it out, which is the point.
    expect(
      ledger
        .listUsageObservationsForRun(runId)
        .map((o) => o.source)
        .sort(),
    ).toEqual(["inner_agent", "provider_reported"]);
  });

  it("a REPLACE that relabels a labelled or planted inner_agent row as provider_reported, or rewrites the inner_call row, is refused before any reader sees it; the same row honestly inserted does move the readers (post-#442)", async () => {
    // Q-96 (answered 2026-10-15, Delegated): `openLedger` sets `recursive_triggers = ON`, so SQLite's REPLACE conflict
    // resolution now fires the BEFORE DELETE guard instead of silently rewriting a guarded row. `usage.test.ts` pins
    // that on the rows; this pins it at the readers the test above enumerates, with the rewrite that would matter most
    // to them: the planted row (the provider with capacity evidence, under the finished run, a huge count) relabelled
    // `provider_reported`, the real labelled row rewritten to that same shape, and the `inner_call` row the inner
    // diagnostics report rewritten with other counts and outcome. The last step inserts the planted shape the honest
    // way and shows every provider reader move, so a REPLACE that went through could not have hidden.
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
    const runId = finishedRun();
    const client = await connect();
    const extra = {
      innerBackend: createFakeBackend({
        script: [{ kind: "text", text: '{"title":"Fix greeting typo"}', usage: { in: 11, out: 5 } }],
      }),
    };
    expect(JSON.parse(await cli(["inner", "test", "run_title", "--json"], false, extra))).toMatchObject({
      accepted: true,
    });
    const PLANTED = 987_654_321;
    db.prepare(
      `INSERT INTO usage_observation (id, run_id, provider, harness, backing_provider, model, source, metrics_json,
                                      observed_at)
       VALUES ('use_planted_inner', ?, ?, ?, NULL, 'cfg-model', 'inner_agent', ?, ?)`,
    ).run(
      runId,
      PROVIDER,
      PROVIDER,
      JSON.stringify({ input_tokens: PLANTED, output_tokens: PLANTED }),
      NOW.toISOString(),
    );
    const rows = () => ({
      usage: db.prepare("SELECT * FROM usage_observation ORDER BY rowid").all() as Record<string, unknown>[],
      calls: db.prepare("SELECT * FROM inner_call ORDER BY rowid").all() as Record<string, unknown>[],
    });
    const before = { rows: rows(), surfaces: await readerSurfaces(client, runId, extra) };
    const labelled = before.rows.usage.find((r) => r.source === "inner_agent" && r.id !== "use_planted_inner");
    const planted = before.rows.usage.find((r) => r.id === "use_planted_inner");
    const [call] = before.rows.calls;
    expect(labelled).toMatchObject({ provider: "claude-code", run_id: null, source: "inner_agent" });
    expect(planted).toMatchObject({ provider: PROVIDER, run_id: runId, source: "inner_agent" });
    expect(call).toMatchObject({ task: "run_title", outcome: "accepted", tokens_in: 11, tokens_out: 5 });
    type Capacity = { providers: { window: { terminal_runs: number; usage_observations: number } }[] };
    expect((JSON.parse(before.surfaces.tool) as Capacity).providers[0]?.window).toMatchObject({
      terminal_runs: 1,
      usage_observations: 1,
    });
    expect(db.pragma("recursive_triggers", { simple: true })).toBe(1);

    const rewriteUsage = (spelling: string, row: Record<string, unknown>) =>
      db
        .prepare(
          `${spelling} usage_observation (id, run_id, provider, harness, backing_provider, model, source, metrics_json,
                                          observed_at)
           VALUES (@id, @run_id, @provider, @harness, @backing_provider, @model, @source, @metrics_json, @observed_at)`,
        )
        .run(row);
    const rewriteCall = (spelling: string, row: Record<string, unknown>) =>
      db
        .prepare(
          `${spelling} inner_call (id, task, backend_kind, model_id, locality, template_version, outcome, reason,
             attempts, latency_ms, tokens_in, tokens_out, input_bytes, output_bytes, input_sha256, run_id,
             meta_session_id, created_at)
           VALUES (@id, @task, @backend_kind, @model_id, @locality, @template_version, @outcome, @reason, @attempts,
             @latency_ms, @tokens_in, @tokens_out, @input_bytes, @output_bytes, @input_sha256, @run_id,
             @meta_session_id, @created_at)`,
        )
        .run(row);
    for (const spelling of ["INSERT OR REPLACE INTO", "REPLACE INTO"]) {
      expect(() => rewriteUsage(spelling, { ...planted, source: "provider_reported" })).toThrow(/append-only/u);
      expect(() =>
        rewriteUsage(spelling, {
          ...labelled,
          run_id: runId,
          provider: PROVIDER,
          harness: PROVIDER,
          source: "provider_reported",
          metrics_json: planted?.metrics_json,
        }),
      ).toThrow(/append-only/u);
      expect(() =>
        rewriteCall(spelling, { ...call, outcome: "rejected_validator", tokens_in: 999_999, tokens_out: 999_999 }),
      ).toThrow(/append-only/u);
    }
    expect(rows()).toEqual(before.rows);
    expect(await readerSurfaces(client, runId, extra)).toEqual(before.surfaces);
    expect(JSON.stringify(before.surfaces)).not.toContain(String(PLANTED));

    // Not vacuous: the planted shape written the honest way (a new id, the lifecycle's own writer) moves every provider
    // reader the refused relabel would have moved, and none of the inner diagnostics, which read `inner_call` only.
    ledger.insertUsageObservation({
      runId,
      provider: PROVIDER,
      harness: PROVIDER,
      source: "provider_reported",
      metrics: { input_tokens: PLANTED, output_tokens: PLANTED },
    });
    const after = await readerSurfaces(client, runId, extra);
    expect((JSON.parse(after.tool) as Capacity).providers[0]?.window).toMatchObject({
      terminal_runs: 1,
      usage_observations: 2,
    });
    // (The human `doctor` capacity line prints the verdict, not the window counts, so it alone does not move.)
    for (const key of ["tool", "toolForProvider", "capacity", "capacityText", "doctorJson"] as const) {
      expect(after[key]).not.toBe(before.surfaces[key]);
    }
    expect((JSON.parse(after.show) as { usage: unknown[] }).usage).toHaveLength(2);
    expect(after.showText).toContain(String(PLANTED));
    expect((JSON.parse(after.getRun) as { usage: { reported: unknown[] } }).usage.reported).toHaveLength(2);
    expect(after.getRunEvents).toContain(String(PLANTED));
    expect(after.innerStatusJson).toBe(before.surfaces.innerStatusJson);
    expect(after.innerStatus).toBe(before.surfaces.innerStatus);
  });
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

  it("inner test without shares_subscription_with writes inner_call only; capacity and doctor.capacity stay byte-identical; warning is absent", async () => {
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
    expect(warn).toBeUndefined();
    expect(before.doctor.inner_agent.tasks.find((t) => t.task === "run_title")?.total_calls).toBe(0);

    const report = JSON.parse(await cli(["inner", "test", "run_title", "--json"], false, extra)) as {
      accepted: boolean;
      task: string;
    };
    expect(report).toMatchObject({ accepted: true, task: "run_title" });
    expect(ledger.listInnerCalls()).toEqual([
      expect.objectContaining({ task: "run_title", run_id: null, attempts: 1 }),
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_observation WHERE source = 'inner_agent'").get()).toEqual({
      n: 0,
    });

    expect(await capacityText(client)).toBe(before.tool);
    expect(await cli(["capacity", "--json"], false, extra)).toBe(before.capacity);
    const after = JSON.parse(await cli(["doctor", "--json"], true, extra)) as typeof before.doctor;
    expect(after.capacity).toEqual(before.doctor.capacity);
    expect(after.checks.find((c) => c.id === "inner_shared_subscription")).toBeUndefined();
    expect(after.inner_agent.tasks.find((t) => t.task === "run_title")?.total_calls).toBe(1);
  });

  it("the doctor warning names the provider exactly, in JSON and in the human line, and reads the same after a call", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        data_dir: dataDir,
        allowed_roots: [path.join(root, "repos")],
        mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
        inner_agent: {
          enabled: true,
          backend: {
            kind: "http",
            base_url: "http://127.0.0.1:1",
            model: "cfg-model",
            shares_subscription_with: "codex",
          },
          tasks: { run_title: { enabled: true } },
        },
      }),
    );
    const extra = {
      innerBackend: createFakeBackend({ script: [{ kind: "text", text: '{"title":"Fix greeting typo"}' }] }),
    };
    const detail =
      "the inner agent shares the codex subscription: its calls consume codex capacity; each call is recorded as a " +
      "usage observation labelled inner_agent (not as provider usage, and it does not change capacity_score)";
    const jsonCheck = async () =>
      (JSON.parse(await cli(["doctor", "--json"], true, extra)) as { checks: Record<string, unknown>[] }).checks.filter(
        (c) => c.id === "inner_shared_subscription",
      );
    const humanLine = async () =>
      (await cli(["doctor"], true, extra)).match(/^\[warn\] Inner agent subscription: .*$/gmu);
    expect(await jsonCheck()).toEqual([
      { id: "inner_shared_subscription", label: "Inner agent subscription", status: "warn", detail },
    ]);
    expect(await humanLine()).toEqual([`[warn] Inner agent subscription: ${detail}`]);

    expect(JSON.parse(await cli(["inner", "test", "run_title", "--json"], false, extra))).toMatchObject({
      accepted: true,
    });
    expect(db.prepare("SELECT provider FROM usage_observation WHERE source = 'inner_agent'").all()).toEqual([
      { provider: "codex" },
    ]);
    // Config-derived: one check, same text, whether or not calls have been made.
    expect(await jsonCheck()).toEqual([
      { id: "inner_shared_subscription", label: "Inner agent subscription", status: "warn", detail },
    ]);
    expect(await humanLine()).toEqual([`[warn] Inner agent subscription: ${detail}`]);
  });

  it("enabled: false with the flag set: no warning, inner test makes no call, no row of either kind, capacity unchanged", async () => {
    // FR-INN-15's warning is about an inner agent that consumes the provider's capacity; a disabled one consumes nothing
    // (FR-INN-01), so doctor says nothing and the ledger gains neither an inner_call nor an observation.
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
          enabled: false,
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
    const backend = createFakeBackend({ script: [{ kind: "text", text: '{"title":"Fix greeting typo"}' }] });
    const extra = { innerBackend: backend };
    const before = {
      tool: await capacityText(client),
      capacity: await cli(["capacity", "--json"], false, extra),
      doctor: await cli(["doctor", "--json"], true, extra),
    };
    const doctor = JSON.parse(before.doctor) as { checks: { id: string }[]; inner_agent: { state: string } };
    expect(doctor.checks.map((c) => c.id)).not.toContain("inner_shared_subscription");
    expect(doctor.inner_agent.state).toBe("off");
    expect(await cli(["doctor"], true, extra)).not.toMatch(/Inner agent subscription/u);

    const report = await cli(["inner", "test", "run_title", "--json"], true, extra);
    expect(JSON.parse(report)).toMatchObject({ ran: false, accepted: false, outcome: "off" });
    expect(backend.requests).toHaveLength(0);
    expect(ledger.listInnerCalls()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_observation WHERE source = 'inner_agent'").get()).toEqual({
      n: 0,
    });
    expect(await capacityText(client)).toBe(before.tool);
    expect(await cli(["capacity", "--json"], false, extra)).toBe(before.capacity);
    // Nothing was called, so the whole doctor document (inner section included) is byte-identical this time.
    expect(await cli(["doctor", "--json"], true, extra)).toBe(before.doctor);
  });

  it("the shared provider disabled for routing (providers.<id>.enabled: false) keeps the warning and the label: the subscription is consumed whether or not the provider is routed to", async () => {
    // FR-INN-15's warning is about subscription consumption, not routing. `providers.claude-code.enabled: false` takes
    // the provider out of routing, but the inner agent still draws on its subscription, so `doctor` must carry the very
    // check it carries with the provider enabled, `inner status` must still name it, and each backend request still
    // writes its labelled row under claude-code. The fake registry has no claude adapter, so the capacity surfaces
    // compared here are the fake provider's; the label never reaches any of them (the estimator reads provider-reported
    // rows only). Delegated: the routing switch does not silence the warning.
    const config = (providers?: Record<string, unknown>) =>
      JSON.stringify({
        schema_version: 1,
        data_dir: dataDir,
        allowed_roots: [path.join(root, "repos")],
        mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
        limits: { per_provider_concurrency: 2 },
        capacity: { window_seconds: 7200, confidence_runs: 4 },
        ...(providers !== undefined ? { providers } : {}),
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
      });
    type Doctor = { checks: { id: string }[]; capacity: unknown; inner_agent: { tasks: { task: string }[] } };
    const warning = (doc: Doctor) => doc.checks.filter((c) => c.id === "inner_shared_subscription");
    finishedRun();
    const client = await connect();
    const backend = createFakeBackend({
      script: [{ kind: "text", text: '{"title":"Fix greeting typo"}', usage: { in: 11, out: 5 } }],
    });
    const extra = { innerBackend: backend };

    writeFileSync(configPath, config());
    const enabledWarning = warning(JSON.parse(await cli(["doctor", "--json"], true, extra)) as Doctor);
    expect(enabledWarning).toEqual([expect.objectContaining({ status: "warn" })]);

    writeFileSync(configPath, config({ "claude-code": { enabled: false } }));
    const before = {
      tool: await capacityText(client),
      capacity: await cli(["capacity", "--json"], false, extra),
      doctor: JSON.parse(await cli(["doctor", "--json"], true, extra)) as Doctor,
    };
    expect(warning(before.doctor)).toEqual(enabledWarning);
    expect(await cli(["doctor"], true, extra)).toMatch(
      /^\[warn\] Inner agent subscription: the inner agent shares the claude-code subscription: its calls consume claude-code capacity; /mu,
    );
    expect(await cli(["inner", "status"], true, extra)).toContain("shares subscription with: claude-code\n");

    expect(JSON.parse(await cli(["inner", "test", "run_title", "--json"], false, extra))).toMatchObject({
      accepted: true,
    });
    expect(backend.requests).toHaveLength(1);
    expect(ledger.listInnerCalls()).toEqual([
      expect.objectContaining({ task: "run_title", run_id: null, attempts: 1 }),
    ]);
    expect(
      db
        .prepare(
          "SELECT run_id, provider, harness, source, metrics_json FROM usage_observation WHERE source = 'inner_agent'",
        )
        .all(),
    ).toEqual([
      {
        run_id: null,
        provider: "claude-code",
        harness: "claude-code",
        source: "inner_agent",
        metrics_json: JSON.stringify({ input_tokens: 11, output_tokens: 5 }),
      },
    ]);
    expect(ledger.listProviderReportedUsageSince("claude-code", "1970-01-01T00:00:00.000Z")).toHaveLength(0);

    expect(await capacityText(client)).toBe(before.tool);
    expect(await cli(["capacity", "--json"], false, extra)).toBe(before.capacity);
    const after = JSON.parse(await cli(["doctor", "--json"], true, extra)) as Doctor;
    expect(after.capacity).toEqual(before.doctor.capacity);
    expect(warning(after)).toEqual(enabledWarning);
  });
});

describe("serve-path contracts (commit_message and route_features) leave capacity surfaces byte-identical (T11.5)", () => {
  for (const shares of [null, PROVIDER]) {
    const label = shares === null ? "no shared subscription" : `shares_subscription_with = ${shares}`;
    it(`${label}: get_capacity and capacity --json stay byte-identical after commit-message and route-features calls`, async () => {
      const runId = finishedRun();
      const client = await connect();
      const before = {
        tool: await capacityText(client),
        toolForProvider: await capacityText(client, { provider: PROVIDER }),
        capacity: await cli(["capacity", "--json"]),
      };

      const settings = resolveInnerAgent({
        enabled: true,
        backend: {
          kind: "http",
          base_url: "http://127.0.0.1:1",
          model: "cfg-model",
          ...(shares !== null ? { shares_subscription_with: shares } : {}),
        },
        tasks: { commit_message: { enabled: true }, route_features: { enabled: true } },
      });
      const routeReply = '{"context_volume":"small","autonomy":"low","reasoning_depth":"low","task_kind":"docs"}';
      const svc = createInnerAgent(settings, {
        backend: createFakeBackend({
          script: [
            { kind: "text", text: '{"subject":"Fix typo"}', usage: { in: 15, out: 4 } },
            { kind: "text", text: routeReply, usage: { in: 10, out: 2 } },
            { kind: "text", text: routeReply, usage: { in: 12, out: 3 } },
          ],
        }),
        ledger,
      });

      const runRecord = ledger.getRunRecord(runId);
      if (!runRecord) throw new Error("run not found");

      // 1. Commit message task (under runId)
      const drafted = await createCommitMessageTask(svc, {
        mode: "draft_if_missing",
        runId,
        metaSessionId: runRecord.meta_session_id,
        projectSetting: "inherit",
        nativeSessionIds: [],
      }).draft({
        numstat: "1\t0\tx.ts",
        diff: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1 @@\n+x\n",
        recentSubjects: [],
        sanitise: (s) => s,
      });
      expect(drafted).toMatchObject({ ok: true, text: "Fix typo" });

      // 2. Route features hook: admission (no runId) and continuation (under runId)
      const hook = createClassifyRouteFeaturesHook(svc, () => "inherit");
      const input = { objective: "Fix typo", constraints: [] as const, verificationCommands: 0, writable: true };
      const adm = await hook(input, {});
      const cont = await hook(input, { runId, metaSessionId: runRecord.meta_session_id });
      expect(adm.task_kind).toMatchObject({ value: "docs", source: "inner" });
      expect(cont.task_kind).toMatchObject({ value: "docs", source: "inner" });

      expect(ledger.listInnerCalls()).toHaveLength(3);
      const innerRows = db
        .prepare("SELECT provider, source, metrics_json FROM usage_observation WHERE source = 'inner_agent'")
        .all();
      expect(innerRows).toHaveLength(shares === null ? 0 : 3);

      expect(await capacityText(client)).toBe(before.tool);
      expect(await capacityText(client, { provider: PROVIDER })).toBe(before.toolForProvider);
      expect(await cli(["capacity", "--json"])).toBe(before.capacity);
    });
  }
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
      // The run's envelope over the same transport: `get_run` without `include_events` and with it (LLD §3). The
      // envelope's `usage` object is what a remote primary agent reads, so it is pinned here as it is in memory.
      const beforeGetRun = await toolText(client, "get_run", { run_id: runId });
      const [beforeEnvelope, beforeEvents] = splitEvents(
        await toolText(client, "get_run", { run_id: runId, include_events: {} }),
      );
      expect((JSON.parse(beforeGetRun) as { usage: { reported: unknown[] } }).usage.reported).toHaveLength(1);
      expect(beforeEvents).toEqual([]);
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
      expect(await toolText(client, "get_run", { run_id: runId })).toBe(beforeGetRun);
      const [afterEnvelope, afterEvents] = splitEvents(
        await toolText(client, "get_run", { run_id: runId, include_events: {} }),
      );
      expect(afterEnvelope).toBe(beforeEnvelope);
      expect(afterEvents.map((e) => e.type)).toEqual(["inner_call", "inner_call", "inner_call"]);
      expect(JSON.stringify(afterEvents)).not.toMatch(/token|usage/u);

      // A second session opened after the calls gets its own server instance from `mcpServerFor`, so the equality
      // above is not a property of one session's in-memory state: a remote client that connects later reads the
      // same bytes from the ledger.
      const later = await connectHttpSession();
      expect(await capacityText(later)).toBe(before[0]);
      expect(await capacityText(later, { provider: PROVIDER })).toBe(before[1]);
      expect(await toolText(later, "get_run", { run_id: runId })).toBe(beforeGetRun);
      const [laterEnvelope, laterEvents] = splitEvents(
        await toolText(later, "get_run", { run_id: runId, include_events: {} }),
      );
      expect(laterEnvelope).toBe(beforeEnvelope);
      expect(laterEvents.map((e) => e.type)).toEqual(["inner_call", "inner_call", "inner_call"]);
    });
  }
});

describe("the flag must name a configured provider: doctor and inner test when it does not (T11.5; FR-INN-15)", () => {
  it("doctor fails on the config check naming the key, emits no inner_shared_subscription warning; inner test sends nothing and writes no row", async () => {
    // The warning text and the observation label are both taken from `shares_subscription_with` as written, so a
    // value that is not a configured provider id must be refused before either surface can name it (a warning about
    // a provider that does not exist, or a labelled row no estimate could ever belong to). The loader's refusal is a
    // unit test (`src/config/config.test.ts`); this is the same refusal at the two FR-INN-15 surfaces.
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        data_dir: dataDir,
        allowed_roots: [path.join(root, "repos")],
        mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
        inner_agent: {
          enabled: true,
          backend: {
            kind: "http",
            base_url: "http://127.0.0.1:1",
            model: "cfg-model",
            shares_subscription_with: "claude-cod",
          },
          tasks: { run_title: { enabled: true } },
        },
      }),
    );
    const backend = createFakeBackend({ script: [{ kind: "text", text: '{"title":"Fix greeting typo"}' }] });
    const run = async (args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const io: CliIo = {
        stdout: { write: (s) => out.push(s) },
        stderr: { write: (s) => err.push(s) },
        env: {},
        adapters: registry(),
        now,
        innerBackend: backend,
      };
      const code = await main([...args, "--config", configPath], io);
      return { code, out: out.join(""), err: err.join("") };
    };
    const refusal = "inner_agent.backend.shares_subscription_with: must name a configured provider id or be null";

    const doctorJson = await run(["doctor", "--json"]);
    expect(doctorJson.code).toBe(1);
    const doc = JSON.parse(doctorJson.out) as {
      ok: boolean;
      checks: { id: string; status: string; detail: string }[];
      inner_agent?: unknown;
    };
    expect(doc.ok).toBe(false);
    expect(doc.checks.find((c) => c.id === "config")).toMatchObject({ status: "fail" });
    expect(doc.checks.find((c) => c.id === "config")?.detail).toContain(refusal);
    expect(doc.checks.map((c) => c.id)).not.toContain("inner_shared_subscription");
    expect(doc.inner_agent).toBeUndefined();
    expect(doctorJson.out).not.toMatch(/claude-cod subscription|Inner agent subscription/u);

    const doctorText = await run(["doctor"]);
    expect(doctorText.code).toBe(1);
    // The loader's message spans two lines: the heading, then the offending key with its JSON path.
    expect(doctorText.out).toMatch(
      /^\[FAIL\] Config: Invalid config:\n\s+\$\.inner_agent\.backend\.shares_subscription_with: must name a configured provider id or be null$/mu,
    );
    expect(doctorText.out).not.toMatch(/\[warn\] Inner agent subscription/u);

    const test = await run(["inner", "test", "run_title", "--json"]);
    expect(test.code).toBe(1);
    expect(test.out + test.err).toContain(refusal);
    expect(backend.requests).toHaveLength(0);
    expect(ledger.listInnerCalls()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_observation").get()).toEqual({ n: 0 });
  });
});

describe("off-schema token shapes reach the labelled row as partial or unknown and move no reader (T11.5 residual; FR-INN-15)", () => {
  // `usage.test.ts` pins `tokenCount` and the rows for a backend that reports a null, fractional, negative, non-finite,
  // string or unsafe count; nothing had read what those rows look like at the published surfaces. Distinctive figures,
  // so a reader that estimated, coerced or surfaced one of them is caught by a substring check over every surface.
  const PARTIAL_IN = 7_777_777;
  const STRING_IN = "6666666";
  const UNSAFE_OUT = 2 ** 53;
  const script: readonly FakeStep[] = [
    // call 1: output unknown, input reported: a partial row
    { kind: "text", text: '{"title":"Fix login"}', usage: { in: PARTIAL_IN, out: null } },
    // call 2: a re-ask after an off-schema first answer whose counts were bogus; the re-ask's good counts cannot
    // restore a total that is already unknown (null + anything is unknown)
    { kind: "text", text: "not json", usage: { in: 1.5, out: -1 } },
    { kind: "text", text: '{"title":"Fix login"}', usage: { in: 3, out: 1 } },
    // call 3: a backend that does not honour the port's number type (a numeric string, an unsafe integer)
    { kind: "text", text: '{"title":"Fix login"}', usage: { in: STRING_IN as unknown as number, out: UNSAFE_OUT } },
    // call 4: non-finite
    { kind: "text", text: '{"title":"Fix login"}', usage: { in: Number.NaN, out: Number.POSITIVE_INFINITY } },
    // call 5: `usage` that is not an object at all
    { kind: "text", text: '{"title":"Fix login"}', usage: "unshaped-report" as unknown as { in: number; out: number } },
    // call 6: a negative zero is zero (a safe integer, not negative), so it is a reported count, not unknown
    { kind: "text", text: '{"title":"Fix login"}', usage: { in: 0, out: -0 } },
  ];
  for (const shares of [null, PROVIDER]) {
    const label = shares === null ? "no shared subscription" : `shares_subscription_with = ${shares}`;
    it(`${label}: six calls with off-schema counts write ${shares === null ? "no observation" : "partial or empty labelled rows"} and every reader is byte-identical`, async () => {
      const runId = finishedRun();
      const client = await connect();
      // The on-disk config declares no inner agent, so `doctor` is a function of config, probes and the ledger's
      // provider tables and is compared whole. `inner status` reads `inner_call` from the ledger whatever the config
      // says, so its two forms are the one reader expected to move, by the call counts and nothing else.
      const surfaces = async () => {
        const { innerStatusJson, innerStatus, ...s } = await readerSurfaces(client, runId, {});
        const [show, showEvents] = splitEvents(s.show);
        const [getRunEvents, toolEvents] = splitEvents(s.getRunEvents);
        const [showText, showTextEvents] = splitEventLines(s.showText);
        return {
          stable: { ...s, show, showText, getRunEvents },
          events: { show: showEvents, tool: toolEvents, showText: showTextEvents },
          inner: { json: innerStatusJson, text: innerStatus },
        };
      };
      type InnerStatus = {
        inner_agent: { tasks: { task: string; total_calls: number; calls: { accepted: number } }[] };
      };
      const runTitle = (json: string) =>
        (JSON.parse(json) as InnerStatus).inner_agent.tasks.find((t) => t.task === "run_title");
      const before = await surfaces();
      expect(before.events.show).toEqual([]);
      expect(before.events.tool).toEqual([]);
      expect(before.events.showText).toEqual([]);
      expect((JSON.parse(before.stable.show) as { usage: unknown[] }).usage).toHaveLength(1);
      expect(before.stable.showText).toMatch(/usage\.input_tokens/u);
      expect(runTitle(before.inner.json)).toMatchObject({ total_calls: 0 });

      const svc = innerAgent(shares, script);
      const results = [];
      for (let i = 0; i < 6; i++) results.push(await svc.call(contract, { user: "objective: tidy", run_id: runId }));
      expect(results.map((r) => r.outcome)).toEqual(Array(6).fill("accepted"));
      expect(ledger.listInnerCalls().map((c) => [c.attempts, c.tokens_in, c.tokens_out])).toEqual([
        [1, PARTIAL_IN, null],
        [2, null, null],
        [1, null, null],
        [1, null, null],
        [1, null, null],
        [1, 0, 0],
      ]);
      const labelled = db
        .prepare(
          "SELECT run_id, provider, model, metrics_json FROM usage_observation WHERE source = 'inner_agent' ORDER BY rowid",
        )
        .all();
      expect(labelled).toEqual(
        shares === null
          ? []
          : [{ input_tokens: PARTIAL_IN }, {}, {}, {}, {}, { input_tokens: 0, output_tokens: 0 }].map((metrics) => ({
              run_id: runId,
              provider: PROVIDER,
              model: "fake-model",
              metrics_json: JSON.stringify(metrics),
            })),
      );
      // Only the figures the backend reported as non-negative safe integers are stored anywhere: the string, the
      // unsafe, the non-finite and the non-object ones are in no row of either table (the fraction and the negative
      // are too short to check by substring; the null counts above cover them).
      const allRows = JSON.stringify({
        usage: db.prepare("SELECT * FROM usage_observation").all(),
        calls: db.prepare("SELECT * FROM inner_call").all(),
      });
      for (const figure of [STRING_IN, String(UNSAFE_OUT), "NaN", "Infinity", "unshaped-report"]) {
        expect(allRows).not.toContain(figure);
      }

      const after = await surfaces();
      expect(after.stable).toEqual(before.stable);
      // The run gained exactly six `inner_call` events on each event surface, none carrying a count.
      expect(after.events.show.map((e) => e.type)).toEqual(Array(6).fill("inner_call"));
      expect(after.events.tool.map((e) => e.type)).toEqual(Array(6).fill("inner_call"));
      expect(after.events.showText.map((l) => l.match(/ {2}(\S+) {2}\{/u)?.[1])).toEqual(Array(6).fill("inner_call"));
      expect(JSON.stringify(after.events)).not.toMatch(/token|usage/u);
      // The inner diagnostics count the six accepted calls and report no count of either kind, so a backend's
      // off-schema figure cannot reach an operator through them either.
      expect(runTitle(after.inner.json)).toMatchObject({ total_calls: 6, calls: { accepted: 6 } });
      expect(after.inner.text).toMatch(/^run_title +no +active +6 +6 /mu);
      expect(JSON.stringify(after.inner)).not.toMatch(/token/u);
      for (const figure of [String(PARTIAL_IN), STRING_IN, String(UNSAFE_OUT), "unshaped-report"]) {
        expect(JSON.stringify(after)).not.toContain(figure);
      }
    });
  }
});

describe("a duplicate-id insert in every non-REPLACE conflict spelling is refused or ignored, on the labelled row, the inner_call row and its run event, before any reader sees it (T11.5 residual; FR-INN-15, ADR-0005)", () => {
  it("INSERT, OR ABORT, OR FAIL and OR ROLLBACK raise the UNIQUE constraint; OR IGNORE writes nothing; rows and every reader are byte-identical", async () => {
    // #442 and #446 pinned the two REPLACE spellings (the BEFORE DELETE guard, Q-96). The other four conflict
    // resolutions never reach a trigger: a duplicate id is refused by the primary key (or, for OR IGNORE, dropped
    // without a write). The rewrite tried on each row is the one that would matter most to the readers: the labelled
    // row relabelled `provider_reported` with a huge count under the run with capacity evidence, the call row with
    // another outcome and huge counts, and the run event carrying a token figure. The event is also tried under a new
    // id on the taken (run_id, seq), which its UNIQUE constraint refuses, and under its own id on a free seq.
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
    const runId = finishedRun();
    const client = await connect();
    // The doctor probe's backend (its canary writes no row); the call under the run goes through the pipeline so that
    // the run event exists, labelled under the provider with capacity evidence.
    const extra = {
      innerBackend: createFakeBackend({
        script: [{ kind: "text", text: '{"title":"Fix greeting typo"}', usage: { in: 11, out: 5 } }],
      }),
    };
    const svc = innerAgent(PROVIDER, [{ kind: "text", text: '{"title":"Fix login"}', usage: { in: 11, out: 5 } }]);
    expect(await svc.call(contract, { user: "objective: tidy", run_id: runId })).toMatchObject({ accepted: true });
    const rows = () => ({
      usage: db.prepare("SELECT * FROM usage_observation ORDER BY rowid").all() as Record<string, unknown>[],
      calls: db.prepare("SELECT * FROM inner_call ORDER BY rowid").all() as Record<string, unknown>[],
      events: db.prepare("SELECT * FROM run_event ORDER BY rowid").all() as Record<string, unknown>[],
    });
    const before = { rows: rows(), surfaces: await readerSurfaces(client, runId, extra) };
    const labelled = before.rows.usage.find((r) => r.source === "inner_agent");
    const [call] = before.rows.calls;
    const event = before.rows.events.find((r) => r.type === "inner_call");
    expect(labelled).toMatchObject({ provider: PROVIDER, run_id: runId, source: "inner_agent" });
    expect(call).toMatchObject({ task: "run_title", outcome: "accepted", tokens_in: 11, tokens_out: 5, run_id: runId });
    expect(event).toMatchObject({ run_id: runId, type: "inner_call" });
    expect(before.rows.usage).toHaveLength(2);
    expect(before.rows.events).toHaveLength(1);
    type Capacity = { providers: { window: { terminal_runs: number; usage_observations: number } }[] };
    expect((JSON.parse(before.surfaces.tool) as Capacity).providers[0]?.window).toMatchObject({
      terminal_runs: 1,
      usage_observations: 1,
    });
    expect((JSON.parse(before.surfaces.doctorJson) as { checks: { id: string }[] }).checks.map((c) => c.id)).toContain(
      "inner_shared_subscription",
    );

    const PLANTED = 987_654_321;
    const insert = (spelling: string, table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      return db
        .prepare(`${spelling} ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`)
        .run(row);
    };
    const attempts: [string, Record<string, unknown>, RegExp][] = [
      [
        "usage_observation",
        { ...labelled, source: "provider_reported", metrics_json: JSON.stringify({ input_tokens: PLANTED }) },
        /UNIQUE constraint failed: usage_observation\.id/u,
      ],
      [
        "inner_call",
        { ...call, outcome: "rejected_validator", tokens_in: PLANTED, tokens_out: PLANTED },
        /UNIQUE constraint failed: inner_call\.id/u,
      ],
      // SQLite checks the (run_id, seq) index before the primary key, so the same id is tried on a free seq to reach
      // the key, and a fresh id on the taken seq to reach the index.
      [
        "run_event",
        { ...event, seq: 2, payload_json: JSON.stringify({ tokens: PLANTED }) },
        /UNIQUE constraint failed: run_event\.id/u,
      ],
      [
        "run_event",
        { ...event, id: "evt_duplicate_seq", payload_json: JSON.stringify({ tokens: PLANTED }) },
        /UNIQUE constraint failed: run_event\.run_id, run_event\.seq/u,
      ],
    ];
    for (const [table, row, refusal] of attempts) {
      for (const spelling of [
        "INSERT INTO",
        "INSERT OR ABORT INTO",
        "INSERT OR FAIL INTO",
        "INSERT OR ROLLBACK INTO",
      ]) {
        expect(() => insert(spelling, table, row), `${spelling} ${table}`).toThrow(refusal);
      }
      expect(insert("INSERT OR IGNORE INTO", table, row).changes, `OR IGNORE ${table}`).toBe(0);
    }
    expect(rows()).toEqual(before.rows);
    expect(await readerSurfaces(client, runId, extra)).toEqual(before.surfaces);
    expect(JSON.stringify(before.surfaces)).not.toContain(String(PLANTED));

    // Not vacuous: the relabelled shape under a fresh id through the lifecycle's own writer moves the provider readers
    // and none of the inner diagnostics.
    ledger.insertUsageObservation({
      runId,
      provider: PROVIDER,
      harness: PROVIDER,
      source: "provider_reported",
      metrics: { input_tokens: PLANTED },
    });
    const after = await readerSurfaces(client, runId, extra);
    expect((JSON.parse(after.tool) as Capacity).providers[0]?.window).toMatchObject({
      terminal_runs: 1,
      usage_observations: 2,
    });
    expect(after.tool).not.toBe(before.surfaces.tool);
    expect(after.getRun).toContain(String(PLANTED));
    expect(after.innerStatusJson).toBe(before.surfaces.innerStatusJson);
    expect(after.innerStatus).toBe(before.surfaces.innerStatus);
  });
});
