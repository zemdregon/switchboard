/**
 * T6.20 (FR-CAP-13, LLD §16.10, ADR-0082 on the ADR-0079 reader): Antigravity's `provider_usage` on `get_capacity`,
 * `switchboard capacity` and `doctor`, through the real probe runner against a stand-in `agy` script that prints the
 * recorded `agy` 1.4.3 answers (`src/adapters/antigravity/fixtures/usage/`); no provider CLI, login or network.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AntigravityAdapter } from "../adapters/antigravity/adapter.js";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, createProbeRunner, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { ProviderUsageCache, type ProviderUsageReaderDeps } from "../capacity/index.js";
import { main } from "../cli/index.js";
import type { CliIo } from "../cli/io.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { createSwitchboardServer, type SwitchboardMcpServer } from "./index.js";

const NOW = new Date("2026-10-21T03:00:00.000Z");
const now = () => NOW;
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "../adapters/antigravity/fixtures/usage");

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON checked by the published output schema
type Json = Record<string, any>;

let root: string;
let dataDir: string;
let configPath: string;
let agyScript: string;
let db: Database.Database | undefined;
const lifecycles: RunLifecycle[] = [];
const servers: { mcp: SwitchboardMcpServer; client: Client }[] = [];

/** A stand-in `agy`: the recorded answers by argv; `AGY_STATE=logged-out` answers `models` like a signed-out CLI. */
function writeAgy(dir: string): string {
  const file = path.join(dir, "agy.mjs");
  const usage = readFileSync(path.join(FIXTURES, "usage-1.4.3.jsonl"), "utf8");
  const credits = readFileSync(path.join(FIXTURES, "credits-1.4.3.jsonl"), "utf8");
  writeFileSync(
    file,
    `const a = process.argv.slice(2);
const out = (s, code = 0) => { process.stdout.write(s); process.exitCode = code; };
if (a[0] === "--version") out("1.4.4\\n");
else if (a.includes("--help")) out("--prompt --output-format --dangerously-skip-permissions --conversation\\n");
else if (a[0] === "models") {
  if (${JSON.stringify(path.join(dir, "logged-out"))} && (await import("node:fs")).existsSync(${JSON.stringify(path.join(dir, "logged-out"))})) {
    process.stderr.write("Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\\n");
    process.exitCode = 1;
  } else out("gemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\n");
}
else if (a.includes("/usage")) out(${JSON.stringify(usage)});
else if (a.includes("/credits")) out(${JSON.stringify(credits)});
else out("", 2);
`,
  );
  return file;
}

const agy = () => new AntigravityAdapter({ executable: process.execPath, launcherArgs: [agyScript] });
const registry = () =>
  new AdapterRegistry().register(new FakeAdapter({ script: "/nonexistent/fake-cli.mjs" })).register(agy());

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: "read-only",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

function writeConfig(extra: Json = {}): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [path.join(root, "repos")],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
      capacity: { window_seconds: 7200, confidence_runs: 4 },
      ...extra,
    }),
  );
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-capu-")));
  dataDir = path.join(root, "data");
  mkdirSync(path.join(root, "repos"));
  configPath = path.join(root, "config.json");
  agyScript = writeAgy(root);
  writeConfig();
});

afterEach(async () => {
  for (const l of lifecycles.splice(0)) await l.shutdown();
  for (const s of servers.splice(0)) {
    await s.client.close();
    await s.mcp.close();
  }
  db?.close();
  db = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function connect(providerUsage?: ProviderUsageReaderDeps): Promise<Client> {
  mkdirSync(dataDir, { recursive: true });
  db ??= openLedger(dataDir);
  const ledger = createLedger(db, { ids: createIdGenerator(), now });
  const reg = registry();
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids: createIdGenerator() });
  const lifecycle = new RunLifecycle({
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
  lifecycles.push(lifecycle);
  const mcp = createSwitchboardServer({
    lifecycle,
    ledger,
    artifacts,
    registry: reg,
    config: {
      allowedRoots: [root],
      mcpClients: new Map([["c1", { id: "c1", maxTrustProfile: "edit-untrusted" as TrustProfile }]]),
      capacity: { windowSeconds: 7200, confidenceRuns: 4 },
    },
    clientId: "c1",
    now,
    ...(providerUsage !== undefined ? { providerUsage } : {}),
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(s);
  await client.connect(c);
  await client.listTools(); // caches output schemas: every result below is checked against get_capacity's schema
  servers.push({ mcp, client });
  return client;
}

async function capacityTool(client: Client, args: Json = {}): Promise<Json> {
  const res = await client.callTool({ name: "get_capacity", arguments: args });
  expect(res.isError).not.toBe(true);
  const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}") as Json;
  expect(res.structuredContent).toEqual(body);
  return body;
}

async function cli(args: string[]) {
  const out: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: () => undefined },
    env: {},
    adapters: registry(),
    now,
  };
  const code = await main([...args, "--config", configPath], io);
  return { code, out: out.join("") };
}

const usageDeps = (): ProviderUsageReaderDeps => ({
  runner: createProbeRunner(["PATH"]),
  cache: new ProviderUsageCache(),
});
const agyEntry = (body: Json): Json | undefined => (body.providers as Json[]).find((p) => p.provider === "antigravity");

describe("T6.20 Antigravity provider_usage on get_capacity, capacity and doctor", () => {
  it("get_capacity carries Antigravity's own /usage report on its entry, provider_reported and schema-valid", async () => {
    const body = await capacityTool(await connect(usageDeps()));
    const u = agyEntry(body)?.provider_usage as Json;
    expect(u).toMatchObject({
      provider: "antigravity",
      source: "provider_reported",
      observed_at: NOW.toISOString(),
      method: 'agy -p "/usage" --output-format json',
      plan: null,
      limit_reached: null,
      credits: { has_credits: false, unlimited: false, balance: "0" },
    });
    expect((u.windows as Json[]).map((w) => [w.id, w.limit_id, w.window_seconds])).toEqual([
      ["gemini-weekly", "Gemini Models", 604800],
      ["gemini-5h", "Gemini Models", 18000],
      ["3p-weekly", "Claude and GPT models", 604800],
      ["3p-5h", "Claude and GPT models", 18000],
      ["gemini-argon-wtu-weekly", "Gemini 4 Argon", 604800],
    ]);
    expect((u.windows as Json[])[0]).toMatchObject({
      used_fraction: 0.863692,
      remaining_fraction: 0.136308,
      resets_at: "2026-10-24T07:21:04.000Z",
    });
    // The estimate is unchanged: provider_usage never feeds capacity_score or explicit_remaining.
    expect(agyEntry(body)?.explicit_remaining).toBeNull();
    const fake = (body.providers as Json[]).find((p) => p.provider === "fake");
    expect(fake).not.toHaveProperty("provider_usage");
  });

  it("signed out, agy is never asked for /usage and the entry says unknown with the reason", async () => {
    writeFileSync(path.join(root, "logged-out"), "");
    const body = await capacityTool(await connect(usageDeps()), { provider: "antigravity" });
    expect(agyEntry(body)?.provider_usage).toEqual({
      provider: "antigravity",
      source: "unknown",
      observed_at: NOW.toISOString(),
      method: 'agy -p "/usage" --output-format json',
      error: "agy is not signed in; run `agy` to sign in",
    });
  });

  it("without the reader there is no provider_usage at all", async () => {
    const body = await capacityTool(await connect());
    for (const p of body.providers as Json[]) expect(p).not.toHaveProperty("provider_usage");
  });

  it("switchboard capacity --json agrees with get_capacity, and the text and doctor label every figure", async () => {
    const mcp = await capacityTool(await connect(usageDeps()), { provider: "antigravity" });
    const json = await cli(["capacity", "--provider", "antigravity", "--json"]);
    expect(json.code).toBe(0);
    expect(agyEntry(JSON.parse(json.out))?.provider_usage).toEqual(agyEntry(mcp)?.provider_usage);
    const text = await cli(["capacity", "--provider", "antigravity"]);
    expect(text.out).toContain(
      'provider-reported usage (agy -p "/usage" --output-format json, at 2026-10-21T03:00:00.000Z)',
    );
    expect(text.out).toContain(
      "gemini-weekly (604800 s, provider_reported): used 0.863692, remaining 0.136308, resets 2026-10-24T07:21:04.000Z",
    );
    expect(text.out).not.toMatch(/%/);
    const doctor = await cli(["doctor"]);
    expect(doctor.out).toContain("gemini-5h (18000 s, provider_reported): used 0.000165, remaining 0.999835");
  });

  it("a provider disabled in config is not read", async () => {
    writeConfig({ providers: { antigravity: { enabled: false } } });
    const r = await cli(["capacity", "--json"]);
    expect(r.code).toBe(0);
    expect(agyEntry(JSON.parse(r.out))).not.toHaveProperty("provider_usage");
  });
});
