/**
 * MCP contract tests (T2.4; FR-MCP-01, 03–09; LLD §3). A scripted MCP client talks to the server through the SDK's
 * in-memory transport pair, against the fake adapter, the Claude adapter replaying its synthetic fixtures and the
 * Codex adapter replaying its synthetic fixtures. No provider CLI, login or network is needed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replayAdapter as claudeReplay, DEFAULT_SESSION_ID, REPLAY_SCRIPT } from "../adapters/claude/fixtures/cases.js";
import { replayAdapter as codexReplay } from "../adapters/codex/fixtures/cases.js";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import {
  AdapterRegistry,
  type AuthResult,
  auditInvocation,
  createProbeRunner,
  type Ineligible,
  type Invocation,
  type ProbeRunner,
  type ProviderAdapter,
  type ProviderId,
  type ResolvedProfile,
  type VersionGateResult,
} from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { type HttpTransportSettings, type ResolvedProject, resolveHttpTransport } from "../config/index.js";
import { buildAndPutHandoffView, DEFAULT_BUNDLE_BOUNDS, INSTRUCTION_MARKER, takeAsOf } from "../continuity/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle, type RunLifecycleOptions } from "../lifecycle/index.js";
import { createProfileResolver } from "../policy/index.js";
import { compileCheck, requirementsFor, TRUST_PROFILE_ORDER } from "../routing/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import {
  createScrubber,
  createSwitchboardServer,
  type HttpTransportListener,
  MAX_MCP_REQUESTS_PER_CLIENT,
  OAuthTokenStore,
  SubjectBindingStore,
  type SwitchboardMcpServer,
  startHttpTransport,
  TOOL_NAMES,
} from "./index.js";

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

const SHORT = { wallClockMs: 15_000, idleMs: 5_000, killGraceMs: 300 };

/** SRS §3.3 defaults for the two M2 profiles; the rest are stand-ins no M2 adapter compiles. */
const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: name === "inspect-untrusted" ? "none" : name === "edit-untrusted" ? "allowlist" : "broad",
  ...(name === "edit-untrusted" ? { shellAllowlist: [] } : {}),
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

/**
 * Fake provider CLI for the vertical slice: reads the prompt from stdin, writes or appends `feature.txt` in its cwd and
 * reports a session id (the resumed one when `--resume` is given). The objective "hang" never finishes.
 */
const WRITER_CLI = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const i = a.indexOf("--resume");
const resumed = i >= 0 ? a[i + 1] : undefined;
if (a.includes("--version")) process.stdout.write("fake-cli 1.0.0\\n");
else if (a.includes("--auth-status")) process.stdout.write('{"authenticated":true}\\n');
else if (a.includes("--smoke")) emit({ type: "result", ok: true, summary: "smoke" });
else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { prompt += c; });
  process.stdin.on("end", () => {
    emit({ type: "session", session_id: resumed ?? "writer-1" });
    if (prompt.trim() === "hang") { setInterval(() => {}, 1000); return; }
    if (prompt.trim() === "usage") emit({ type: "usage", input_tokens: 12, output_tokens: 3 });
    const prev = existsSync("feature.txt") ? readFileSync("feature.txt", "utf8") : "";
    writeFileSync("feature.txt", prev + (resumed ? "continued\\n" : "new feature\\n"));
    emit({ type: "tool", tool: "edit", name: "write_file", target: "feature.txt" });
    emit({ type: "result", ok: true, summary: resumed ? "continued " + resumed : "wrote feature" });
  });
}
`;

const CLAUDE_HELP =
  "-p, --print\n--output-format stream-json\n--permission-mode dontAsk\n--permission-prompts\n--tools\n--allowedTools\n" +
  "--disallowedTools\n" +
  "--safe-mode\n--restricted\n--strict-mcp-config\n--resume\n";

/** Every invocation compiled during a test, for the bypass-flag audit. */
let compiled: Invocation[];

interface Recorded {
  adapter: ProviderAdapter;
  resumes: string[];
}

/** Wraps an adapter: records compiled invocations and resume calls; optionally overrides auth (test double). */
function recorded(inner: ProviderAdapter, auth?: AuthResult): Recorded {
  const resumes: string[] = [];
  const keep = (inv: Invocation | Ineligible) => {
    if (!("ineligible" in inv)) compiled.push(inv);
    return inv;
  };
  const adapter: ProviderAdapter = {
    id: inner.id,
    transports: inner.transports,
    gitWriteControl: inner.gitWriteControl,
    resumeCwd: inner.resumeCwd,
    gitCapabilities: inner.gitCapabilities,
    probe: (r) => inner.probe(r),
    authPreflight: (r) => (auth ? Promise.resolve(auth) : inner.authPreflight(r)),
    compile: (req, p) => keep(inner.compile(req, p)),
    resumeArgs: (b, req, p) => {
      resumes.push(b.nativeSessionId);
      return keep(inner.resumeArgs(b, req, p));
    },
    parseEvent: (i, s) => inner.parseEvent(i, s),
    extractResult: (e, x) => inner.extractResult(e, x),
    classifyFailure: (e) => inner.classifyFailure(e),
  };
  return { adapter, resumes };
}

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let artifacts: ArtifactStore;
let lifecycle: RunLifecycle;
let writerScript: string;
let claudeLoggedIn: boolean;
const servers: { mcp: SwitchboardMcpServer; client: Client }[] = [];

/** Probe runner: the Claude replay script only replays streams, so its probe/auth commands are answered here. */
const realRunner = createProbeRunner();
const probeRunner: ProbeRunner = async (argv, opts) => {
  if (argv.includes(REPLAY_SCRIPT) && argv[argv.indexOf("--provider") + 1] === "claude") {
    const tail = argv.slice(argv.indexOf("--") + 1).join(" ");
    const out = { exitCode: 0, stderr: "", timedOut: false };
    if (tail === "--version") return { ...out, stdout: "2.1.296 (Claude Code)\n" };
    if (tail === "--help") return { ...out, stdout: CLAUDE_HELP };
    if (tail === "auth status --json") {
      return claudeLoggedIn
        ? { ...out, stdout: '{"loggedIn":true}' }
        : { ...out, exitCode: 1, stdout: '{"loggedIn":false}' };
    }
    return { ...out, exitCode: 64, stdout: "" };
  }
  return realRunner(argv, opts);
};

/** Version gate: the real manifests for claude/codex unless `passCodex`; `fake` has no manifest (test-only pass). */
function gateFor(registry: AdapterRegistry, passCodex = false) {
  return (id: ProviderId, version: string | null, dir?: string): VersionGateResult => {
    if (id === "fake" || (passCodex && id === "codex")) {
      return {
        eligible: true,
        evidence: { provider: id, observedVersion: version, validatedRange: "test", validatedCliVersion: "test" },
      };
    }
    return registry.gate(id, version, dir);
  };
}

interface Setup {
  adapters: ProviderAdapter[];
  passCodex?: boolean;
  /** Host platform injected into eligibility (T3.7); default linux. */
  platform?: string;
  clients?: { id: string; max: TrustProfile; approval?: "required" | "not_required"; projects?: string[] }[];
  /** Configured projects (T9.2); the array is shared with the server so a test can change it between calls. */
  projects?: ResolvedProject[];
  lifecycle?: Partial<RunLifecycleOptions>;
  start?: boolean;
  /**
   * T13.4: also serve these clients over the HTTP transport. Each token is issued for `oauthClientId` and its client
   * is appended to `servers` after the stdio-style ones, so `call(..., index)` reaches it over Streamable HTTP.
   */
  http?: {
    map?: Record<string, string>;
    defaultMcpClient?: string;
    tokens: { oauthClientId: string; scopes?: string[] }[];
  };
}

const HTTP_RESOURCE = "https://sb.example.test/mcp";
/** A client store in which every OAuth client is approved, unless named in `revokedClients`. */
const revokedClients = new Set<string>();
const approvedClients = {
  register: () => {
    throw new Error("not used");
  },
  get: (clientId: string) => ({
    clientId,
    status: revokedClients.has(clientId) ? ("revoked" as const) : ("approved" as const),
    redirectUris: [],
    grantTypes: [],
    createdAt: "",
  }),
};
const httpClient = (i: number): Client => {
  const c = servers[i]?.client;
  if (!c) throw new Error("no client");
  return c;
};
let httpListener: HttpTransportListener | undefined;

async function setup(s: Setup): Promise<void> {
  const registry = new AdapterRegistry();
  for (const a of s.adapters) registry.register(a);
  const ids = createIdGenerator();
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots: [root],
    globalConcurrency: 4,
    resolveProfile: profileFor,
    probeRunner,
    eligibility: { platform: s.platform ?? "linux", gate: gateFor(registry, s.passCodex) },
    ...s.lifecycle,
  });
  if (s.start !== false) lifecycle.start();
  const clients = s.clients ?? [{ id: "orchestrator", max: "edit-untrusted" }];
  const config = {
    allowedRoots: [root],
    projects: s.projects ?? [],
    mcpClients: new Map(
      clients.map((c) => [
        c.id,
        {
          id: c.id,
          maxTrustProfile: c.max,
          ...(c.approval ? { privilegedApproval: c.approval } : {}),
          ...(c.projects ? { projects: c.projects } : {}),
        },
      ]),
    ),
  };
  // T13.5: one binding store for every server, as `serve` does.
  const subjectBindings = new SubjectBindingStore(db);
  for (const c of clients) {
    const mcp = createSwitchboardServer({
      lifecycle,
      ledger,
      artifacts,
      registry,
      config,
      clientId: c.id,
      subjectBindings,
    });
    const client = new Client({ name: `test-${c.id}`, version: "0.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.server.connect(serverSide);
    await client.connect(clientSide);
    await client.listTools(); // caches the published output schemas, so every result below is schema-checked
    servers.push({ mcp, client });
  }
  if (s.http) {
    const settings = resolveHttpTransport({
      enabled: true,
      public_url: HTTP_RESOURCE,
      port: 0,
      clients: Object.entries(s.http.map ?? {}).map(([oauth_client_id, mcp_client]) => ({
        oauth_client_id,
        mcp_client,
      })),
      ...(s.http.defaultMcpClient !== undefined ? { default_mcp_client: s.http.defaultMcpClient } : {}),
    }) as HttpTransportSettings;
    const tokens = new OAuthTokenStore(db);
    httpListener = await startHttpTransport(settings, {
      tokens,
      clients: approvedClients,
      mcpServerFor: (id, subject) =>
        createSwitchboardServer({
          lifecycle,
          ledger,
          artifacts,
          registry,
          config,
          clientId: id,
          subject,
          subjectBindings,
        }),
    });
    const url = new URL(`http://127.0.0.1:${httpListener?.address.port}/mcp`);
    for (const t of s.http.tokens) {
      const { token } = tokens.issue({
        kind: "access",
        clientId: t.oauthClientId,
        resource: HTTP_RESOURCE,
        scopes: t.scopes ?? ["mcp"],
        ttlMs: 60_000,
      });
      const client = new Client({ name: `http-${t.oauthClientId}`, version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      // The SDK's `sessionId?: string | undefined` trips `exactOptionalPropertyTypes`.
      await client.connect(transport as Transport);
      await client.listTools();
      servers.push({ mcp: { close: async () => {} } as unknown as SwitchboardMcpServer, client });
    }
  }
}

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON checked by the published output schemas
type Json = Record<string, any>;
interface Call {
  isError: boolean;
  body: Json;
}

async function call(name: string, args: Json = {}, clientIndex = 0): Promise<Call> {
  const client = servers[clientIndex]?.client;
  if (!client) throw new Error("no client");
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
  const body = JSON.parse(text) as Json;
  if (res.structuredContent !== undefined) expect(res.structuredContent).toEqual(body);
  return { isError: res.isError === true, body };
}

async function pollTerminal(runId: string, clientIndex = 0): Promise<Json> {
  const end = Date.now() + 20_000;
  for (;;) {
    const r = await call("get_run", { run_id: runId }, clientIndex);
    expect(r.isError).toBe(false);
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(r.body.status)) return r.body;
    if (Date.now() > end) throw new Error(`run ${runId} did not finish: ${r.body.status}`);
    await new Promise((res) => setTimeout(res, 20));
  }
}

/** A valid structured privileged scope (LLD §3.1). */
const SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "allowlist", allowlist: [["npm", "test"]] },
  network: { mode: "allowlist", hosts: ["registry.npmjs.org"] },
  repository_config: { mode: "disabled" },
  bypass: true,
};

const runCount = () => (db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n;
const newWriter = () => new FakeAdapter({ script: writerScript, timeouts: SHORT });
/** The fake writer behind the recording wrapper, so every compiled argv is audited. */
const fakeWriter = () => recorded(newWriter()).adapter;
const delegateArgs = (over: Json = {}): Json => ({
  objective: "add a feature",
  workspace_path: repo,
  trust_profile: "edit-untrusted",
  ...over,
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-mcp-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  writerScript = path.join(root, "writer-cli.mjs");
  writeFileSync(writerScript, WRITER_CLI);
  claudeLoggedIn = true;
  compiled = [];
});

afterEach(async () => {
  await lifecycle.shutdown();
  for (const s of servers.splice(0)) {
    await s.client.close();
    await s.mcp.close();
  }
  await httpListener?.close();
  httpListener = undefined;
  revokedClients.clear();
  db.close();
  // FR-POL-03 / AGENTS.md: no compiled argv in any run of this file carried a bypass flag.
  for (const inv of compiled) expect(auditInvocation(inv)).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

describe("tool surface (FR-MCP-01, FR-MCP-09)", () => {
  it("publishes the six M2 tools with closed input schemas and output schemas", async () => {
    await setup({ adapters: [fakeWriter()] });
    const client = servers[0]?.client as Client;
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect((t.inputSchema as Json).additionalProperties).toBe(false);
      expect(t.outputSchema?.type).toBe("object");
    }
    // FRD §7.2 C6 / FR-MCP-08: no idempotency key on continue_task.
    const cont = tools.find((t) => t.name === "continue_task");
    expect(Object.keys(cont?.inputSchema.properties ?? {})).not.toContain("idempotency_key");
  });

  it("an unknown tool is an INVALID_REQUEST tool error", async () => {
    await setup({ adapters: [fakeWriter()] });
    const r = await call("rm_rf", {});
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatchObject({ code: "INVALID_REQUEST", retryable: false });
  });

  it("refuses to serve an unconfigured client or a lifecycle without the eligibility gate", async () => {
    await setup({ adapters: [fakeWriter()] });
    const base = {
      lifecycle,
      ledger,
      artifacts,
      registry: new AdapterRegistry(),
      config: { allowedRoots: [root], mcpClients: new Map() },
    };
    expect(() => createSwitchboardServer({ ...base, clientId: "nobody" })).toThrow(/unknown MCP client/);
    const ungated = new RunLifecycle({
      ledger,
      workspace: new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root] }),
      artifacts,
      adapters: new AdapterRegistry(),
      allowedRoots: [root],
      globalConcurrency: 1,
      resolveProfile: profileFor,
    });
    const mcpClients = new Map([["a", { id: "a", maxTrustProfile: "edit-untrusted" as const }]]);
    expect(() =>
      createSwitchboardServer({
        ...base,
        lifecycle: ungated,
        clientId: "a",
        config: { allowedRoots: [root], mcpClients },
      }),
    ).toThrow(/eligibility/);
  });
});

describe("usage in get_run (T2.5)", () => {
  it("shows provider-reported observations with their source label; null (not zero) when none were reported", async () => {
    await setup({ adapters: [fakeWriter()] });
    const none = await call("delegate_task", delegateArgs());
    const noneDone = await pollTerminal(none.body.run_id);
    expect(noneDone.usage).toEqual({ reported: null, estimated: null, capacity_confidence: null });

    const d = await call("delegate_task", delegateArgs({ objective: "usage" }));
    const done = await pollTerminal(d.body.run_id);
    expect(done.status).toBe("SUCCEEDED");
    expect(done.usage.estimated).toBeNull();
    expect(done.usage.capacity_confidence).toBeNull();
    expect(done.usage.reported).toHaveLength(1);
    expect(done.usage.reported[0]).toMatchObject({
      source: "provider_reported",
      provider: "fake",
      harness: "fake",
      metrics: { input_tokens: 12, output_tokens: 3 },
    });
  });
});

describe("harness and backing provider in get_run (T4.6, FR-ADP-10)", () => {
  it("stores both in usage_observation and shows both in get_run", async () => {
    await setup({ adapters: [recorded(new FakeAdapter({ scenario: "fronted", timeouts: SHORT })).adapter] });
    const d = await call("delegate_task", delegateArgs());
    const done = await pollTerminal(d.body.run_id);
    expect(done.status).toBe("SUCCEEDED");
    expect(done.usage.reported).toHaveLength(1);
    expect(done.usage.reported[0]).toMatchObject({
      harness: "fake",
      backing_provider: "backing-x",
      model: "m-a",
      metrics: { input_tokens: 7, output_tokens: 2 },
    });
    const rows = ledger.listUsageObservationsForRun(d.body.run_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ harness: "fake", backing_provider: "backing-x", model: "m-a" });
  });
});

describe("vertical slice against the fake adapter", () => {
  it("delegate_task → get_run until SUCCEEDED → get_artifacts diff → continue_task on the same native session", async () => {
    const fake = recorded(newWriter());
    await setup({ adapters: [fake.adapter] });

    const d = await call("delegate_task", delegateArgs());
    expect(d.isError).toBe(false);
    expect(d.body).toMatchObject({ status: expect.stringMatching(/QUEUED|PREFLIGHT|LEASED|RUNNING/) });
    expect(d.body.run_id).toMatch(/^run_/);
    expect(d.body.meta_session_id).toMatch(/^sess_/);

    const done = await pollTerminal(d.body.run_id);
    expect(done).toMatchObject({
      status: "SUCCEEDED",
      provider: { adapter: "fake", adapter_version: "1.0.0" },
      result: { summary: "wrote feature", changed_files: 1, verification: [] },
    });
    expect(done.route.reasons).toEqual(["selected fake (configured_order)", "fake: eligible"]);
    expect(Object.keys(done.artifacts).sort()).toEqual(["changed_files", "diff"]); // no provider streams (LLD §3)
    expect(done.failure_code).toBeUndefined();

    const arts = await call("get_artifacts", { run_id: d.body.run_id, kinds: ["diff"] });
    expect(arts.isError).toBe(false);
    expect(arts.body.artifacts).toHaveLength(1);
    expect(arts.body.artifacts[0]).toMatchObject({ kind: "diff", artifact_id: done.artifacts.diff });
    expect(arts.body.artifacts[0].inline_text).toContain("+new feature");
    const small = await call("get_artifacts", { run_id: d.body.run_id, max_inline_bytes: 0 });
    expect(small.body.artifacts.every((a: Json) => a.inline_text === undefined)).toBe(true);

    const ev = await call("get_run", { run_id: d.body.run_id, include_events: { after_seq: 0, limit: 200 } });
    expect(ev.body.events[0]).toMatchObject({ seq: 1, type: "state_transition", payload: { to: "QUEUED" } });
    expect(JSON.stringify(ev.body)).not.toContain(dataDir); // worktree paths never leave the controller

    const c = await call("continue_task", { meta_session_id: d.body.meta_session_id, instruction: "keep going" });
    expect(c.isError).toBe(false);
    expect(c.body.meta_session_id).toBe(d.body.meta_session_id);
    expect(c.body.run_id).not.toBe(d.body.run_id);
    const cont = await pollTerminal(c.body.run_id);
    expect(cont).toMatchObject({ status: "SUCCEEDED", result: { summary: "continued writer-1" } });
    expect(cont.route.reasons[0]).toBe("selected fake (resume same_provider_resume from fake; continuation)");
    expect(fake.resumes).toEqual(["writer-1"]);
    const diff2 = await call("get_artifacts", { run_id: c.body.run_id, kinds: ["diff"] });
    expect(diff2.body.artifacts[0].inline_text).toContain("+continued"); // started from the session head
  });

  it("wait_seconds returns the terminal envelope when the run finishes within the bound", async () => {
    await setup({ adapters: [fakeWriter()] });
    const d = await call("delegate_task", delegateArgs({ wait_seconds: 20 }));
    expect(d.body.status).toBe("SUCCEEDED");
  });

  it("continue_task resumes in the origin worktree; an unusable directory becomes a same-provider handoff (T5.7, T5.6)", async () => {
    const fake = recorded(newWriter());
    await setup({ adapters: [fake.adapter] });
    const d = await call("delegate_task", delegateArgs());
    expect((await pollTerminal(d.body.run_id)).status).toBe("SUCCEEDED");
    const sess = d.body.meta_session_id as string;
    const originPath = ledger.getRunRecord(d.body.run_id)?.worktree_path as string;

    const c = await call("continue_task", { meta_session_id: sess, instruction: "keep going" });
    expect(c.isError).toBe(false);
    expect((await pollTerminal(c.body.run_id)).status).toBe("SUCCEEDED");
    expect(ledger.getRunRecord(c.body.run_id)?.worktree_path).toBe(originPath); // the fake declares `bound`

    // An untracked file in the origin worktree: no resume there, and none anywhere else (LLD §15.6 step 3). T5.6: the
    // continuation is a handoff on the same provider in a fresh worktree, recorded with its reason.
    writeFileSync(path.join(originPath, "stray.txt"), "x\n");
    const resumesBefore = fake.resumes.length;
    const h = await call("continue_task", { meta_session_id: sess, instruction: "more" });
    expect(h.isError).toBe(false);
    const done = await pollTerminal(h.body.run_id);
    expect(done.status).toBe("SUCCEEDED");
    expect(done.route.reasons[0]).toBe("selected fake (handoff resume_directory_unavailable from fake; continuation)");
    expect(fake.resumes).toHaveLength(resumesBefore); // no native resume anywhere
    expect(ledger.getRunRecord(h.body.run_id)?.worktree_path).not.toBe(originPath);
    expect(JSON.stringify(done)).not.toContain(dataDir); // no controller path in the envelope
    const rd = JSON.parse(ledger.getRouteDecision(h.body.run_id)?.reasons_json ?? "{}");
    expect(rd.continuation).toEqual({
      mode: "handoff",
      reason: "resume_directory_unavailable",
      from_provider: "fake",
      problem: "unclean",
    });
    expect(ledger.listArtifactsForRun(h.body.run_id).map((a) => a.kind)).toContain("handoff_view");
  });

  it("continue_task rejects an active session, an unregistered provider, an unknown session and an idempotency key", async () => {
    await setup({ adapters: [fakeWriter()] });
    const d = await call("delegate_task", delegateArgs({ objective: "hang" }));
    const sess = d.body.meta_session_id;
    const active = await call("continue_task", { meta_session_id: sess, instruction: "more" });
    expect(active.body.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(active.body.error.message).toMatch(/active run/);
    await call("cancel_run", { run_id: d.body.run_id });
    await pollTerminal(d.body.run_id);
    const other = await call("continue_task", {
      meta_session_id: sess,
      instruction: "more",
      routing: { provider_preference: "codex" },
    });
    // T5.6: another registered provider is a handoff now (src/mcp/continue-handoff.test.ts); an unregistered one is
    // still refused by C5 (as V8) before anything else.
    expect(other.body.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { field: "routing.provider_preference" },
    });
    const unknown = await call("continue_task", { meta_session_id: `sess_${"0".repeat(26)}`, instruction: "x" });
    expect(unknown.body.error.code).toBe("INVALID_REQUEST");
    const keyed = await call("continue_task", { meta_session_id: sess, instruction: "x", idempotency_key: "abcdefgh" });
    expect(keyed.body.error.code).toBe("INVALID_REQUEST");
  });
});

describe("Claude and Codex adapters on recorded replay fixtures", () => {
  it("claude: required provider runs end to end and continue_task resumes its native session", async () => {
    const claude = recorded(claudeReplay("success-edit.jsonl", { write: "hello.txt", timeouts: { idleMs: 5_000 } }));
    await setup({ adapters: [claude.adapter] });
    const d = await call(
      "delegate_task",
      delegateArgs({ routing: { provider_preference: "claude", require_provider: true } }),
    );
    expect(d.isError).toBe(false);
    const done = await pollTerminal(d.body.run_id);
    expect(done).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "claude", adapter_version: "2.1.296" } });
    expect(done.result.changed_files).toBe(1);
    expect(done.route.reasons[0]).toBe("selected claude (provider_preference)");
    const arts = await call("get_artifacts", { run_id: d.body.run_id, kinds: ["diff"] });
    expect(arts.body.artifacts[0].inline_text).toContain("hello.txt");

    const c = await call("continue_task", { meta_session_id: d.body.meta_session_id, instruction: "and more" });
    expect(c.isError).toBe(false);
    expect((await pollTerminal(c.body.run_id)).status).toBe("SUCCEEDED");
    expect(claude.resumes).toEqual([DEFAULT_SESSION_ID]);
    const resumed = compiled.at(-1);
    expect(resumed?.argv).toEqual(expect.arrayContaining(["--resume", DEFAULT_SESSION_ID]));
  });

  it("claude logged out: require_provider fails AUTH_REQUIRED naming the native login, and no run starts", async () => {
    claudeLoggedIn = false;
    await setup({ adapters: [recorded(claudeReplay("success-edit.jsonl")).adapter, fakeWriter()] });
    const r = await call(
      "delegate_task",
      delegateArgs({ routing: { provider_preference: "claude", require_provider: true } }),
    );
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatchObject({ code: "AUTH_REQUIRED", details: { login_command: "claude auth login" } });
    expect(r.body.error.message).toContain("claude auth login");
    expect(runCount()).toBe(0);
    // Without require_provider the hint only narrows: the eligible fake adapter is chosen instead (BR-4).
    const any = await call("delegate_task", delegateArgs({ routing: { provider_preference: "claude" } }));
    expect(any.isError).toBe(false);
    expect((await pollTerminal(any.body.run_id)).provider.adapter).toBe("fake");
  });

  it("codex with the shipped manifest: required provider fails ADAPTER_VERSION_UNVERIFIED (BR-3)", async () => {
    await setup({ adapters: [recorded(codexReplay("success_edit")).adapter] });
    const r = await call(
      "delegate_task",
      delegateArgs({ routing: { provider_preference: "codex", require_provider: true } }),
    );
    expect(r.body.error).toMatchObject({
      code: "ADAPTER_VERSION_UNVERIFIED",
      details: { eligibility: [{ provider: "codex", code: "ADAPTER_VERSION_UNVERIFIED" }] },
    });
    // No candidate at all: ELIGIBILITY_NONE with per-provider reasons.
    const none = await call("delegate_task", delegateArgs());
    expect(none.body.error).toMatchObject({ code: "ELIGIBILITY_NONE" });
    expect(none.body.error.details.eligibility[0]).toMatchObject({ provider: "codex" });
    expect(runCount()).toBe(0);
  });

  it("codex: with a validated version and auth (test doubles) a run completes end to end", async () => {
    const codex = recorded(codexReplay("success_edit", { idleMs: 5_000 }), { state: "OK" });
    await setup({ adapters: [codex.adapter], passCodex: true });
    const d = await call(
      "delegate_task",
      delegateArgs({ routing: { provider_preference: "codex", require_provider: true } }),
    );
    expect(d.isError).toBe(false);
    const done = await pollTerminal(d.body.run_id);
    expect(done).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "codex" }, result: { changed_files: 1 } });
    expect(compiled.some((inv) => inv.argv.includes("exec"))).toBe(true);
  });

  it("list_capabilities reports per-provider status without paths outside allowed roots", async () => {
    await setup({
      adapters: [fakeWriter(), recorded(claudeReplay("success-edit.jsonl")).adapter, codexReplay("success_edit")],
    });
    const r = await call("list_capabilities");
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ schema_version: 1, client_max_profile: "edit-untrusted" });
    const by = Object.fromEntries(r.body.providers.map((p: Json) => [p.provider, p]));
    expect(by.fake).toMatchObject({ adapter_status: "READY", auth_state: "OK", transports: ["subprocess-jsonl"] });
    expect(by.claude).toMatchObject({
      adapter_status: "READY",
      binary_version: "2.1.296",
      validated_range: ">=2.1.294 <2.2.0",
      // privileged: Claude compiles a representative scope (network on; LLD §3.1 "Listing", Proposed).
      supported_profiles: ["inspect-untrusted", "edit-untrusted", "privileged"],
    });
    expect(by.codex).toMatchObject({ adapter_status: "ADAPTER_VERSION_UNVERIFIED", auth_state: "NOT_CHECKED" });
    // FR-GIT-01: Claude names its deny rules; Codex declares that no control is documented.
    expect(by.claude.git_write_control).toMatchObject({
      kind: "provider-deny-rules",
      remaining_controls: ["FR-GIT-03", "FR-GIT-06"],
    });
    expect(by.codex.git_write_control).toMatchObject({
      kind: "none-documented",
      remaining_controls: ["FR-GIT-03", "FR-GIT-06"],
    });
    expect(by.codex.git_write_control.detail).toMatch(/no Codex per-command deny or allow rule/);
    expect(by.fake.supported_profiles).not.toContain("privileged"); // the fake adapter has no privileged mode
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(process.execPath);
    expect(text).not.toContain(dataDir);
  });
});

describe("list_capabilities supported_profiles (T3.7: the compile matrix on this host)", () => {
  /** Fake writer that also compiles `privileged` (test double): shows privileged is listed only when it compiles. */
  const privilegedCapable = (): ProviderAdapter => {
    const inner = fakeWriter();
    return {
      ...inner,
      compile: (req, p) => inner.compile(req, p.name === "privileged" ? profileFor("edit-untrusted") : p),
    };
  };
  const supportedBy = async () => {
    const r = await call("list_capabilities");
    expect(r.isError).toBe(false);
    return Object.fromEntries(r.body.providers.map((p: Json) => [p.provider, p])) as Record<string, Json>;
  };

  it("linux, production profiles: equals each adapter's own compile of every profile", async () => {
    const claude = recorded(claudeReplay("success-edit.jsonl")).adapter;
    const codex = codexReplay("success_edit");
    const resolve = createProfileResolver();
    await setup({
      adapters: [claude, codex, privilegedCapable()],
      passCodex: true,
      lifecycle: { resolveProfile: resolve },
      start: false,
    });
    const by = await supportedBy();
    // T3.5 / T3.6 matrices with the SRS defaults (TDD §4.1.1, §4.2.1). privileged is listed when the adapter compiles
    // any representative scope (LLD §3.1 "Listing", Proposed): Claude with network on, Codex with shell broad.
    expect(by.claude?.supported_profiles).toEqual([
      "inspect-untrusted",
      "edit-untrusted",
      "trusted-development",
      "privileged",
    ]);
    expect(by.codex?.supported_profiles).toEqual(["inspect-untrusted", "edit-untrusted", "privileged"]);
    expect(by.fake?.supported_profiles).toEqual([...TRUST_PROFILE_ORDER]);
    // The same verdicts the eligibility filter gets from compileCheck (one code path).
    for (const [adapter, id] of [
      [claude, "claude"],
      [codex, "codex"],
    ] as const) {
      const matrix = TRUST_PROFILE_ORDER.filter((p) => {
        if (p === "privileged") return false; // checked through the representative scopes above
        const snap = resolve(p);
        return !("ineligible" in compileCheck(adapter, snap, requirementsFor(p, snap), root));
      });
      expect(by[id]?.supported_profiles.filter((p: string) => p !== "privileged")).toEqual(matrix);
    }
    expect(by.claude?.adapter_status).toBe("READY");
  });

  it("non-Linux host: no sandbox-dependent profile is listed, and the provider status is unaffected", async () => {
    await setup({
      adapters: [recorded(claudeReplay("success-edit.jsonl")).adapter, privilegedCapable()],
      lifecycle: { resolveProfile: createProfileResolver() },
      platform: "darwin",
      start: false,
    });
    const by = await supportedBy();
    expect(by.claude).toMatchObject({ adapter_status: "READY", supported_profiles: [] });
    expect(by.fake).toMatchObject({ adapter_status: "READY", supported_profiles: [] });
  });

  it("a delegate_task for a profile no provider compiles fails ELIGIBILITY_NONE with machine-readable reasons", async () => {
    await setup({
      adapters: [recorded(claudeReplay("success-edit.jsonl")).adapter],
      clients: [{ id: "dev", max: "trusted-development" }],
      lifecycle: { resolveProfile: createProfileResolver() },
      start: false,
    });
    const r = await call("delegate_task", delegateArgs({ trust_profile: "test-sandboxed" }));
    expect(r.body.error).toMatchObject({
      code: "ELIGIBILITY_NONE",
      details: { eligibility: [{ provider: "claude", code: "PROFILE_UNSUPPORTED" }] },
    });
    expect(runCount()).toBe(0);
  });

  it("privileged admission: still admitted when the only exclusion is the deferred compile; refused off Linux", async () => {
    const clients = [{ id: "root", max: "privileged" as const }];
    const args = delegateArgs({ trust_profile: "privileged", privileged_scope: SCOPE });
    await setup({ adapters: [fakeWriter()], clients, start: false });
    const ok = await call("delegate_task", args);
    expect(ok.body.status).toBe("AWAITING_APPROVAL");
    await lifecycle.shutdown();
    for (const sv of servers.splice(0)) {
      await sv.client.close();
      await sv.mcp.close();
    }
    await setup({ adapters: [fakeWriter()], clients, platform: "darwin", start: false });
    const before = runCount();
    const refused = await call("delegate_task", args);
    expect(refused.body.error).toMatchObject({
      code: "ELIGIBILITY_NONE",
      details: { eligibility: [{ provider: "fake", code: "PROFILE_PLATFORM_UNVERIFIED" }] },
    });
    expect(runCount()).toBe(before);
  });
});

describe("verification commands (T3.10, FR-EXE-08, FRD V7, BR-16)", () => {
  it("runs them after the agent: the envelope carries per-command results and a test_report artifact", async () => {
    await setup({ adapters: [fakeWriter()] });
    const ok = await call(
      "delegate_task",
      delegateArgs({ verification_commands: [[process.execPath, "-e", "console.log('tests pass')"]] }),
    );
    expect(ok.isError).toBe(false);
    const done = await pollTerminal(ok.body.run_id);
    expect(done.status).toBe("SUCCEEDED");
    expect(done.result.summary).toBe("wrote feature");
    expect(done.result.verification).toEqual([expect.objectContaining({ index: 0, outcome: "passed", exit_code: 0 })]);
    expect(Object.keys(done.artifacts).sort()).toEqual(["changed_files", "diff", "test_report"]);
    expect(JSON.stringify(done)).not.toContain("tests pass"); // output only in the artifact (FR-TEL-03)
    const arts = await call("get_artifacts", { run_id: ok.body.run_id, kinds: ["test_report"] });
    const rep = JSON.parse(arts.body.artifacts[0].inline_text);
    expect(rep.commands[0]).toMatchObject({ outcome: "passed", stdout: "tests pass\n" });

    const bad = await call(
      "delegate_task",
      delegateArgs({ verification_commands: [[process.execPath, "-e", "process.exit(1)"]] }),
    );
    const failed = await pollTerminal(bad.body.run_id);
    expect(failed).toMatchObject({ status: "FAILED", failure_code: "TEST_FAILURE" });
    expect(failed.result.summary).toBe("wrote feature"); // the agent's own result is kept (BR-16)
    expect(failed.result.verification).toEqual([expect.objectContaining({ outcome: "failed", exit_code: 1 })]);
    expect(failed.artifacts.test_report).toMatch(/^art_/);
  });

  it("refuses them under inspect-untrusted with details.field, and writes no run", async () => {
    await setup({ adapters: [fakeWriter()] });
    const r = await call(
      "delegate_task",
      delegateArgs({ trust_profile: "inspect-untrusted", verification_commands: [["npm", "test"]] }),
    );
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatchObject({ code: "INVALID_REQUEST", details: { field: "verification_commands" } });
    expect(runCount()).toBe(0);
  });
});

describe("validation (FR-MCP-09, FRD §7)", () => {
  it("schema, path and routing-hint failures are INVALID_REQUEST before any side effect", async () => {
    await setup({ adapters: [fakeWriter()] });
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-mcp-outside-")));
    try {
      const bad: [string, Json][] = [
        ["delegate_task", { workspace_path: repo, trust_profile: "edit-untrusted" }],
        ["delegate_task", delegateArgs({ objective: "" })],
        ["delegate_task", delegateArgs({ surprise: true })],
        ["delegate_task", delegateArgs({ trust_profile: "root" })],
        ["delegate_task", delegateArgs({ wait_seconds: 61 })],
        ["delegate_task", delegateArgs({ idempotency_key: "short" })],
        ["delegate_task", delegateArgs({ workspace_path: outside })],
        ["delegate_task", delegateArgs({ workspace_path: path.join(root, "missing") })],
        ["delegate_task", delegateArgs({ routing: { provider_preference: "nope" } })],
        ["delegate_task", delegateArgs({ routing: { require_provider: true } })],
        // V7: refused under inspect-untrusted (owner decision 11 allows host verification only for write profiles).
        [
          "delegate_task",
          delegateArgs({ trust_profile: "inspect-untrusted", verification_commands: [["npm", "test"]] }),
        ],
        ["delegate_task", delegateArgs({ verification_commands: [[]] })],
        ["delegate_task", delegateArgs({ verification_commands: [[""]] })],
        ["get_run", { run_id: "run_bogus" }],
        ["get_run", { run_id: `run_${"0".repeat(26)}` }],
        ["cancel_run", { run_id: `run_${"0".repeat(26)}` }],
        ["get_artifacts", { run_id: `run_${"0".repeat(26)}`, kinds: ["provider_stdout"] }],
        ["list_capabilities", { extra: 1 }],
      ];
      for (const [tool, args] of bad) {
        const r = await call(tool, args);
        expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
        expect(r.body.error.code, `${tool} ${JSON.stringify(args)}`).toBe("INVALID_REQUEST");
        expect(JSON.stringify(r.body)).not.toContain(outside);
      }
      const schema = await call("delegate_task", delegateArgs({ surprise: true }));
      expect(schema.body.error.details.errors[0]).toMatchObject({ path: "$.surprise" });
      const cap = await call("delegate_task", delegateArgs({ routing: { minimum_capability: "high" } }));
      expect(cap.body.error.code).toBe("ELIGIBILITY_NONE");
      expect(runCount()).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("per-client trust ceiling (FR-MCP-06, BR-13)", () => {
  it("a profile above the client's maximum is PERMISSION_BLOCKED, never downgraded; privileged needs a scope", async () => {
    await setup({
      adapters: [fakeWriter()],
      clients: [
        { id: "reader", max: "inspect-untrusted" },
        { id: "root", max: "privileged" },
      ],
    });
    const up = await call("delegate_task", delegateArgs({ trust_profile: "edit-untrusted" }), 0);
    expect(up.body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { requested: "edit-untrusted", client_max_profile: "inspect-untrusted" },
    });
    // T3.3: with a privileged ceiling the request is no longer blocked, but V13 needs a scope (INVALID_REQUEST).
    const priv = await call("delegate_task", delegateArgs({ trust_profile: "privileged" }), 1);
    expect(priv.body.error).toMatchObject({ code: "INVALID_REQUEST", details: { field: "privileged_scope" } });
    const below = await call(
      "delegate_task",
      delegateArgs({ trust_profile: "privileged", privileged_scope: SCOPE }),
      0,
    );
    expect(below.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { requested: "privileged" } });
    expect(runCount()).toBe(0);
    // At the ceiling is fine.
    const ok = await call("delegate_task", delegateArgs({ trust_profile: "inspect-untrusted" }), 0);
    expect(ok.isError).toBe(false);
    expect(ledger.getRunRecord(ok.body.run_id)?.trust_profile).toBe("inspect-untrusted");
    // continue_task may not raise the profile above the ceiling either (FRD C4).
    await pollTerminal(ok.body.run_id, 0);
    const raise = await call(
      "continue_task",
      { meta_session_id: ok.body.meta_session_id, instruction: "edit now", trust_profile: "edit-untrusted" },
      0,
    );
    expect(raise.body.error.code).toBe("PERMISSION_BLOCKED");
  });
});

describe("MCP over the HTTP transport (T13.4; FR-MCP-14, Q-77)", () => {
  const A = `sbc_${"a".repeat(22)}`;
  const B = `sbc_${"b".repeat(22)}`;

  it("a token's client gets its mapped client's maximum profile; no scope or claim raises it", async () => {
    await setup({
      adapters: [fakeWriter()],
      clients: [
        { id: "reader", max: "inspect-untrusted" },
        { id: "root", max: "privileged" },
      ],
      // The token claims `privileged` as a scope: it changes nothing.
      http: { map: { [A]: "reader" }, tokens: [{ oauthClientId: A, scopes: ["mcp", "privileged"] }] },
    });
    const http = 2;
    const { tools } = await httpClient(http).listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    const up = await call("delegate_task", delegateArgs({ trust_profile: "edit-untrusted" }), http);
    expect(up.body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { requested: "edit-untrusted", client_max_profile: "inspect-untrusted" },
    });
    const priv = await call(
      "delegate_task",
      delegateArgs({ trust_profile: "privileged", privileged_scope: SCOPE }),
      http,
    );
    expect(priv.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { requested: "privileged" } });
    expect(runCount()).toBe(0);
    const ok = await call("delegate_task", delegateArgs({ trust_profile: "inspect-untrusted" }), http);
    expect(ok.isError).toBe(false);
    expect(ledger.getRunRecord(ok.body.run_id)).toMatchObject({
      client_id: "reader",
      trust_profile: "inspect-untrusted",
    });
    await pollTerminal(ok.body.run_id, http);
  });

  it("a privileged request over HTTP waits for the operator; no tool can approve it", async () => {
    await setup({
      adapters: [fakeWriter()],
      clients: [{ id: "root", max: "privileged" }],
      http: { map: { [B]: "root" }, tokens: [{ oauthClientId: B }] },
    });
    const d = await call("delegate_task", delegateArgs({ trust_profile: "privileged", privileged_scope: SCOPE }), 1);
    expect(d.body.status).toBe("AWAITING_APPROVAL");
    expect(ledger.listApprovals()).toMatchObject([{ run_id: d.body.run_id, status: "PENDING" }]);
    const { tools } = await httpClient(1).listTools();
    expect(tools.map((t) => t.name).filter((n) => /approv|deny/i.test(n))).toEqual([]);
  });

  it("refuses an unmapped client and a token without the mcp scope (403); a default mapping applies", async () => {
    await setup({
      adapters: [fakeWriter()],
      clients: [{ id: "reader", max: "inspect-untrusted" }],
      http: { defaultMcpClient: "reader", tokens: [{ oauthClientId: B }] },
    });
    const ok = await call("delegate_task", delegateArgs({ trust_profile: "inspect-untrusted" }), 1);
    expect(ledger.getRunRecord(ok.body.run_id)?.client_id).toBe("reader");
    await pollTerminal(ok.body.run_id, 1);
    await httpListener?.close();

    const settings = resolveHttpTransport({
      enabled: true,
      public_url: HTTP_RESOURCE,
      port: 0,
      clients: [{ oauth_client_id: A, mcp_client: "reader" }],
    }) as HttpTransportSettings;
    const tokens = new OAuthTokenStore(db);
    let built = 0;
    const refused: string[] = [];
    httpListener = await startHttpTransport(settings, {
      tokens,
      clients: approvedClients,
      onClientRefused: (reason) => refused.push(reason),
      mcpServerFor: () => {
        built++;
        throw new Error("must not be built");
      },
    });
    const post = (token: string) =>
      fetch(`http://127.0.0.1:${httpListener?.address.port}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    const issue = (clientId: string, scopes: string[]) =>
      tokens.issue({ kind: "access", clientId, resource: HTTP_RESOURCE, scopes, ttlMs: 60_000 }).token;
    for (const t of [issue(B, ["mcp"]), issue(A, [])]) {
      const r = await post(t);
      expect(r.status).toBe(403);
      expect(r.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
      expect(await r.json()).toEqual({ error: "insufficient_scope" });
    }
    expect(refused).toEqual(["unmapped_client", "missing_scope"]);
    // A client revoked after its token was issued is refused at once (401), even though the token is unexpired.
    revokedClients.add(A);
    expect((await post(issue(A, ["mcp"]))).status).toBe(401);
    expect(built).toBe(0);
  });

  it("serves POST only, caps requests in flight and keeps the credential away from the MCP server", async () => {
    await setup({ adapters: [fakeWriter()], clients: [{ id: "reader", max: "inspect-untrusted" }] });
    const settings = resolveHttpTransport({
      enabled: true,
      public_url: HTTP_RESOURCE,
      port: 0,
      default_mcp_client: "reader",
    }) as HttpTransportSettings;
    const tokens = new OAuthTokenStore(db);
    const seen: (string | undefined)[] = [];
    // A server whose connect never settles holds its request open, so the in-flight cap can be observed.
    const hanging = {
      server: { connect: () => new Promise<never>(() => {}) },
      close: async () => {},
    } as unknown as SwitchboardMcpServer;
    httpListener = await startHttpTransport(settings, {
      tokens,
      clients: approvedClients,
      mcpServerFor: () => hanging,
      // Records, after the handler has run, the credential headers the MCP transport would see on a POST.
      createServer: (handler) =>
        http.createServer((req, res) => {
          handler(req, res);
          if (req.method === "POST") seen.push(req.headers.authorization, req.headers.cookie);
        }),
    });
    const listener = httpListener;
    if (!listener) throw new Error("no listener");
    const token = tokens.issue({
      kind: "access",
      clientId: A,
      resource: HTTP_RESOURCE,
      scopes: ["mcp"],
      ttlMs: 60_000,
    });
    const url = `http://127.0.0.1:${listener.address.port}/mcp`;
    const headers = { authorization: `Bearer ${token.token}`, "content-type": "application/json", cookie: "a=b" };
    for (const method of ["GET", "DELETE", "PUT"]) {
      const r = await fetch(url, { method, headers });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("POST");
    }
    const abort = new AbortController();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const held = Array.from({ length: MAX_MCP_REQUESTS_PER_CLIENT }, () =>
      fetch(url, { method: "POST", headers, body, signal: abort.signal }).catch(() => undefined),
    );
    await new Promise((res) => setTimeout(res, 100));
    const over = await fetch(url, { method: "POST", headers, body });
    expect(over.status).toBe(503);
    abort.abort();
    await Promise.all(held);
    await new Promise((res) => setTimeout(res, 100));
    // Served (and the refused 503) requests: the handler removed both headers before the MCP transport could read them.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.slice(0, MAX_MCP_REQUESTS_PER_CLIENT * 2).every((h) => h === undefined)).toBe(true);
  });
});

describe("HTTP session binding by subject and client (T13.5; FR-MCP-15, Q-78)", () => {
  const A = `sbc_${"a".repeat(22)}`;
  const B = `sbc_${"b".repeat(22)}`;
  const TOKEN_SHAPE = /sb(?:at|rt|ac)_[A-Za-z0-9_-]{43}/;
  // Both OAuth clients map to the same configured MCP client, so only the subject tells them apart.
  const shared = async (): Promise<{ stdio: number; a: number; b: number }> => {
    await setup({
      adapters: [fakeWriter()],
      clients: [{ id: "shared", max: "edit-untrusted" }],
      http: { map: { [A]: "shared", [B]: "shared" }, tokens: [{ oauthClientId: A }, { oauthClientId: B }] },
      start: false,
    });
    return { stdio: 0, a: 1, b: 2 };
  };
  /** The error a caller gets for an id that never existed, with the id swapped in: the refusal must look the same. */
  const unknownError = async (tool: string, args: Json, idKey: string, index: number): Promise<Json> => {
    const ghost = { ...args, [idKey]: `${String(args[idKey]).slice(0, -4)}0000` };
    const r = await call(tool, ghost, index);
    return JSON.parse(JSON.stringify(r.body.error).replaceAll(ghost[idKey], String(args[idKey]))) as Json;
  };

  it("another subject, and stdio for the same MCP client, cannot read, continue or cancel an HTTP run", async () => {
    const { stdio, a, b } = await shared();
    const mine = await call("delegate_task", delegateArgs({ idempotency_key: "key-0001" }), a);
    expect(mine.isError).toBe(false);
    expect(ledger.getRunRecord(mine.body.run_id)?.client_id).toBe("shared");
    expect(db.prepare("SELECT oauth_client_id FROM http_subject").all()).toEqual([{ oauth_client_id: A }]);
    const attempts = [
      ["get_run", { run_id: mine.body.run_id }, "run_id"],
      ["cancel_run", { run_id: mine.body.run_id }, "run_id"],
      ["get_artifacts", { run_id: mine.body.run_id }, "run_id"],
      ["continue_task", { meta_session_id: mine.body.meta_session_id, instruction: "x" }, "meta_session_id"],
    ] as const;
    for (const other of [b, stdio]) {
      for (const [tool, args, idKey] of attempts) {
        const r = await call(tool, args, other);
        expect(r.body.error?.code, `${tool} from ${other}`).toBe("INVALID_REQUEST");
        // No existence oracle: exactly the answer for an id that does not exist.
        expect(r.body.error, `${tool} from ${other}`).toEqual(await unknownError(tool, args, idKey, other));
      }
      // The same idempotency key and request from another subject neither replays nor reveals the run.
      const replay = await call("delegate_task", delegateArgs({ idempotency_key: "key-0001" }), other);
      expect(replay.body.error).toMatchObject({
        code: "INVALID_REQUEST",
        message: "idempotency key reused with different parameters",
      });
    }
    expect(ledger.getRunRecord(mine.body.run_id)?.state).toBe("QUEUED");
    // The subject that opened it still can, and its own replay is a replay.
    expect((await call("get_run", { run_id: mine.body.run_id }, a)).body.status).toBe("QUEUED");
    const again = await call("delegate_task", delegateArgs({ idempotency_key: "key-0001" }), a);
    expect(again.body).toMatchObject({ run_id: mine.body.run_id, replayed: true });
  });

  it("a stdio run is unknown over HTTP", async () => {
    const { stdio, a } = await shared();
    const local = await call("delegate_task", delegateArgs(), stdio);
    expect(local.isError).toBe(false);
    expect((await call("get_run", { run_id: local.body.run_id }, a)).body.error?.code).toBe("INVALID_REQUEST");
    expect((await call("cancel_run", { run_id: local.body.run_id }, a)).body.error?.code).toBe("INVALID_REQUEST");
    expect(db.prepare("SELECT COUNT(*) AS n FROM http_subject").get()).toEqual({ n: 0 });
    expect(ledger.getRunRecord(local.body.run_id)?.state).toBe("QUEUED");
  });

  it("a binding never changes hands, and an HTTP server without the bindings refuses to start", async () => {
    await shared();
    const store = new SubjectBindingStore(db);
    store.bind("ms_1", A);
    store.bind("ms_1", A); // idempotent for the same subject
    expect(() => store.bind("ms_1", B)).toThrow(/another subject/);
    expect(store.subjectOf("ms_1")).toBe(A);
    expect(store.subjectOf("ms_2")).toBeUndefined();
    const registry = new AdapterRegistry();
    expect(() =>
      createSwitchboardServer({
        lifecycle,
        ledger,
        artifacts,
        registry,
        config: {
          allowedRoots: [root],
          mcpClients: new Map([["shared", { id: "shared", maxTrustProfile: "inspect-untrusted" }]]),
        },
        clientId: "shared",
        subject: A,
      }),
    ).toThrow(/subject bindings/);
  });

  it("refuses an Mcp-Session-Id; responses and the ledger hold no token, even one planted in the objective", async () => {
    await shared();
    const listener = httpListener;
    if (!listener) throw new Error("no listener");
    const tokens = new OAuthTokenStore(db);
    const issued = tokens.issue({
      kind: "access",
      clientId: A,
      resource: HTTP_RESOURCE,
      scopes: ["mcp"],
      ttlMs: 60_000,
    });
    const planted = `sbat_${"Q".repeat(43)}`;
    const url = `http://127.0.0.1:${listener.address.port}/mcp`;
    const headers = {
      authorization: `Bearer ${issued.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const seen: string[] = [];
    const post = async (body: unknown, extra: Record<string, string> = {}, token = issued.token) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${token}`, ...extra },
        body: JSON.stringify(body),
      });
      seen.push(JSON.stringify([...r.headers]), await r.clone().text());
      return r;
    };
    const tool = (name: string, args: Json) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });

    const withSession = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-session-id": "anything" });
    expect(withSession.status).toBe(400);
    expect(await withSession.json()).toMatchObject({ error: "invalid_request" });

    const d = await post(tool("delegate_task", delegateArgs({ objective: `use ${planted} and ${issued.token}` })));
    expect(d.status).toBe(200);
    const runId = (JSON.parse(JSON.parse(await d.text()).result.content[0].text) as Json).run_id as string;
    await post(tool("get_run", { run_id: runId, include_events: { after_seq: 0, limit: 50 } }));
    await post(tool("get_run", { run_id: issued.token }));
    await post(tool("get_artifacts", { run_id: runId }));
    await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {}, `${issued.token}x`); // a refused token

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (t) => t.name,
    );
    const rows = tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all()));
    for (const surface of [...seen, ...rows]) {
      expect(surface).not.toContain(issued.token);
      expect(surface).not.toContain(planted);
      expect(TOKEN_SHAPE.test(surface), surface.slice(0, 200)).toBe(false);
    }
    // Positive control: the scan would have found the token.
    expect(TOKEN_SHAPE.test(`x ${issued.token} y`)).toBe(true);
  });
});

describe("privileged admission (T3.3; FR-POL-09, FR-MCP-06, BR-13, BR-14, V13, C7; LLD §3.1)", () => {
  const PRIV_CLIENTS = [
    { id: "root", max: "privileged" as const },
    { id: "other", max: "privileged" as const },
    { id: "editor", max: "edit-untrusted" as const },
  ];
  const privArgs = (over: Json = {}): Json =>
    delegateArgs({ trust_profile: "privileged", privileged_scope: SCOPE, ...over });
  const approvals = () => ledger.listApprovals();

  it("a client ceiling below privileged gives PERMISSION_BLOCKED before V13, with nothing written", async () => {
    await setup({ adapters: [fakeWriter()], clients: PRIV_CLIENTS, start: false });
    for (const args of [privArgs(), delegateArgs({ trust_profile: "privileged" })]) {
      const r = await call("delegate_task", args, 2);
      expect(r.body.error).toMatchObject({
        code: "PERMISSION_BLOCKED",
        details: { requested: "privileged", client_max_profile: "edit-untrusted" },
      });
    }
    expect(runCount()).toBe(0);
    expect(approvals()).toHaveLength(0);
  });

  it("ceiling privileged: AWAITING_APPROVAL with exactly one PENDING row; the envelope shows status and time only", async () => {
    await setup({ adapters: [fakeWriter()], clients: PRIV_CLIENTS });
    const d = await call("delegate_task", privArgs());
    expect(d.isError).toBe(false);
    expect(d.body.status).toBe("AWAITING_APPROVAL");
    const rows = approvals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ run_id: d.body.run_id, status: "PENDING" });
    expect(d.body.approval).toEqual({ status: "PENDING", requested_at: rows[0]?.requested_at });
    // Never dispatched: no process, no worktree.
    await new Promise((res) => setTimeout(res, 50));
    const run = ledger.getRunRecord(d.body.run_id);
    expect(run).toMatchObject({ state: "AWAITING_APPROVAL", pid: null, worktree_path: null });
    // get_run (with events) never carries the scope content, the hash or decided_by.
    const g = await call("get_run", { run_id: d.body.run_id, include_events: { after_seq: 0 } });
    expect(g.body.approval).toEqual({ status: "PENDING", requested_at: rows[0]?.requested_at });
    for (const body of [d.body, g.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(rows[0]?.scope_hash as string);
      expect(text).not.toContain("registry.npmjs.org");
      expect(text).not.toContain("allowlist");
      expect(text).not.toContain("decided_by");
    }
    // No MCP tool approves or denies (FR-MCP-06, BR-14).
    const client = servers[0]?.client;
    if (!client) throw new Error("no client");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).filter((n) => /approv|deny/i.test(n))).toEqual([]);
    expect(compiled).toEqual([]);
  });

  it("V1/V13: a missing scope, unknown key, missing dimension or allowlist mismatch is INVALID_REQUEST naming the field", async () => {
    await setup({ adapters: [fakeWriter()], clients: PRIV_CLIENTS, start: false });
    const cases: [Json, string][] = [
      [delegateArgs({ trust_profile: "privileged" }), "privileged_scope"],
      [delegateArgs({ privileged_scope: SCOPE }), "privileged_scope"],
      [privArgs({ privileged_scope: { ...SCOPE, extra: true } }), "$.privileged_scope.extra"],
      [
        privArgs({ privileged_scope: { ...SCOPE, files: { access: "worktree", paths: ["/"] } } }),
        "$.privileged_scope.files.paths",
      ],
      [
        privArgs({ privileged_scope: { files: SCOPE.files, shell: SCOPE.shell, network: SCOPE.network } }),
        "$.privileged_scope.repository_config",
      ],
      [
        privArgs({ privileged_scope: { ...SCOPE, shell: { mode: "allowlist" } } }),
        "$.privileged_scope.shell.allowlist",
      ],
      [
        privArgs({ privileged_scope: { ...SCOPE, shell: { mode: "none", allowlist: [["ls"]] } } }),
        "$.privileged_scope.shell.allowlist",
      ],
      [
        privArgs({ privileged_scope: { ...SCOPE, network: { mode: "allowlist" } } }),
        "$.privileged_scope.network.hosts",
      ],
      [
        privArgs({ privileged_scope: { ...SCOPE, network: { mode: "on", hosts: ["a.example"] } } }),
        "$.privileged_scope.network.hosts",
      ],
      [privArgs({ privileged_scope: { ...SCOPE, network: { mode: "policy" } } }), "$.privileged_scope.network.mode"],
    ];
    for (const [args, field] of cases) {
      const r = await call("delegate_task", args);
      expect(r.body.error, field).toMatchObject({ code: "INVALID_REQUEST", details: { field } });
      expect(r.body.error.message, field).toContain(field);
    }
    expect(runCount()).toBe(0);
    expect(approvals()).toHaveLength(0);
  });

  it("idempotent replay returns the same run; a new delegate_task with an identical scope gets a new meta-session and row", async () => {
    await setup({ adapters: [fakeWriter()], clients: PRIV_CLIENTS, start: false });
    const args = privArgs({ idempotency_key: "priv-0001" });
    const a = await call("delegate_task", args);
    const again = await call("delegate_task", args);
    expect(again.body).toMatchObject({ run_id: a.body.run_id, replayed: true, status: "AWAITING_APPROVAL" });
    expect(approvals()).toHaveLength(1);
    const other = await call("delegate_task", privArgs());
    expect(other.body.status).toBe("AWAITING_APPROVAL");
    expect(other.body.meta_session_id).not.toBe(a.body.meta_session_id);
    const rows = approvals();
    expect(rows.map((r) => r.status)).toEqual(["PENDING", "PENDING"]);
    expect(rows[0]?.scope_json).toBe(rows[1]?.scope_json);
    expect(rows[0]?.scope_hash).not.toBe(rows[1]?.scope_hash); // bound to the meta-session (owner decision 17)
  });

  it("cancel_run while AWAITING_APPROVAL ends CANCELLED and closes the row DENIED by cancel_run (Q-15)", async () => {
    await setup({ adapters: [fakeWriter()], clients: PRIV_CLIENTS, start: false });
    const d = await call("delegate_task", privArgs());
    const c = await call("cancel_run", { run_id: d.body.run_id, reason: "no longer needed" });
    expect(c.body).toMatchObject({ status: "CANCELLED", approval: { status: "DENIED" } });
    expect(ledger.getApprovalForRun(d.body.run_id)).toMatchObject({ status: "DENIED", decided_by: "cancel_run" });
  });

  it("continue_task: QUEUED under an APPROVED approval with the scope as is; refused when PENDING, DENIED, absent or another client", async () => {
    // The binding below is recorded by hand, with no run that reported it, so there is no origin worktree (T5.7,
    // LLD §15.6): the `independent` fake keeps this test about C7; the directory rule has its own tests.
    const independent = recorded(new FakeAdapter({ script: writerScript, timeouts: SHORT, resumeCwd: "independent" }));
    await setup({ adapters: [independent.adapter], clients: PRIV_CLIENTS, start: false });
    const d = await call("delegate_task", privArgs());
    const sess = d.body.meta_session_id as string;
    const cont = (clientIndex = 0, over: Json = {}) =>
      call("continue_task", { meta_session_id: sess, instruction: "go on", ...over }, clientIndex);
    // The first run would need a native session to resume (M2 rule); record one as a completed run would.
    ledger.recordProviderBinding({ metaSessionId: sess, provider: "fake", nativeSessionId: "writer-1" });

    // PENDING (the first run is also still active): refused.
    expect((await cont()).body.error.code).toBe("INVALID_REQUEST");
    // Approve through the repo helper (stands in for T3.4) and let the first run reach its dispatch refusal.
    const row = approvals()[0];
    ledger.decideApproval({ id: row?.id as string, status: "APPROVED", decidedBy: "op" });
    const first = ledger.getRunRecord(d.body.run_id);
    ledger.casRunState({
      runId: d.body.run_id,
      from: "AWAITING_APPROVAL",
      to: "QUEUED",
      expectedVersion: first?.version as number,
      payload: { rule: "T3" },
    });
    lifecycle.start();
    const done = await pollTerminal(d.body.run_id);
    // The fake adapter cannot compile privileged: the dispatch compile decides (BR-3 code), not a blanket refusal.
    expect(done).toMatchObject({
      status: "FAILED",
      failure_code: "ELIGIBILITY_NONE",
      approval: { status: "APPROVED" },
    });
    expect(done.failure_detail).not.toContain("privileged compile not available");
    await lifecycle.shutdown(); // stop dispatch so the continuation stays QUEUED for inspection

    // Another client: the meta-session is not even visible to it (C2), so INVALID_REQUEST.
    expect((await cont(1)).body.error.code).toBe("INVALID_REQUEST");
    // A privileged_scope cannot be passed to continue_task (closed schema, C7).
    expect((await cont(0, { privileged_scope: SCOPE })).body.error.code).toBe("INVALID_REQUEST");

    const c = await cont();
    expect(c.isError).toBe(false);
    expect(c.body).toMatchObject({ status: "QUEUED", approval: { status: "APPROVED" } });
    expect(approvals()).toHaveLength(1);
    const snap = JSON.parse(ledger.getRunRecord(c.body.run_id)?.policy_snapshot_json ?? "{}");
    expect(snap.privilegedScope).toEqual({
      scope: JSON.parse(row?.scope_json as string),
      scopeHash: row?.scope_hash,
      approvalId: row?.id,
    });
    expect(snap.bypassApproved).toBe(false);
    expect(JSON.stringify(c.body)).not.toContain(row?.scope_hash as string);

    // DENIED: a second privileged meta-session cancelled while waiting.
    const d2 = await call("delegate_task", privArgs());
    await call("cancel_run", { run_id: d2.body.run_id });
    ledger.recordProviderBinding({ metaSessionId: d2.body.meta_session_id, provider: "fake", nativeSessionId: "w" });
    const denied = await call("continue_task", { meta_session_id: d2.body.meta_session_id, instruction: "x" });
    expect(denied.body.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(denied.body.error.message).toContain("DENIED");

    // PENDING on an idle meta-session (its first run ended without a decision, written directly for the test).
    const d3 = await call("delegate_task", privArgs());
    const r3 = ledger.getRunRecord(d3.body.run_id);
    ledger.casRunState({
      runId: d3.body.run_id,
      from: "AWAITING_APPROVAL",
      to: "CANCELLED",
      expectedVersion: r3?.version as number,
      payload: { rule: "T19" },
    });
    ledger.recordProviderBinding({ metaSessionId: d3.body.meta_session_id, provider: "fake", nativeSessionId: "q" });
    const pending = await call("continue_task", { meta_session_id: d3.body.meta_session_id, instruction: "x" });
    expect(pending.body.error.code).toBe("INVALID_REQUEST");
    expect(pending.body.error.message).toContain("PENDING");

    // Absent: an ordinary meta-session continued as privileged.
    const plain = await call("delegate_task", delegateArgs());
    await call("cancel_run", { run_id: plain.body.run_id });
    ledger.recordProviderBinding({ metaSessionId: plain.body.meta_session_id, provider: "fake", nativeSessionId: "p" });
    const absent = await call("continue_task", {
      meta_session_id: plain.body.meta_session_id,
      instruction: "x",
      trust_profile: "privileged",
    });
    expect(absent.body.error.code).toBe("INVALID_REQUEST");
    expect(absent.body.error.message).toContain("absent");
    expect(approvals()).toHaveLength(3);
  });
});

describe("privileged_approval not_required (owner decision 22, ADR-0019)", () => {
  const CLIENTS = [
    { id: "zemdregon", max: "privileged" as const, approval: "not_required" as const },
    { id: "ops", max: "privileged" as const, approval: "required" as const },
    { id: "low", max: "edit-untrusted" as const, approval: "not_required" as const }, // loadConfig refuses this
  ];
  /** Fake writer that also compiles `privileged` (test double for T3.5/T3.6), for first runs and resumes. */
  const privilegedCapable = (): ProviderAdapter => {
    const inner = fakeWriter();
    const map = (p: ResolvedProfile) => (p.name === "privileged" ? profileFor("edit-untrusted") : p);
    return {
      ...inner,
      compile: (req, p) => inner.compile(req, map(p)),
      resumeArgs: (b, req, p) => inner.resumeArgs(b, req, map(p)),
    };
  };
  const privArgs = (over: Json = {}): Json =>
    delegateArgs({ trust_profile: "privileged", privileged_scope: SCOPE, ...over });

  it("not_required: QUEUED with an APPROVED client_policy row and runs; required: AWAITING_APPROVAL as before", async () => {
    await setup({ adapters: [privilegedCapable()], clients: CLIENTS });
    const d = await call("delegate_task", privArgs({ wait_seconds: 10 }));
    expect(d.isError).toBe(false);
    const row = ledger.getApprovalForRun(d.body.run_id);
    expect(row).toMatchObject({ status: "APPROVED", decided_by: "client_policy:zemdregon" });
    expect(d.body.approval).toEqual({ status: "APPROVED", requested_at: row?.requested_at });
    const done = await pollTerminal(d.body.run_id);
    expect(done).toMatchObject({ status: "SUCCEEDED", approval: { status: "APPROVED" } });
    // The envelope never carries decided_by, the hash or the scope content (FR-MCP-04).
    const g = await call("get_run", { run_id: d.body.run_id, include_events: { after_seq: 0 } });
    for (const body of [d.body, g.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain("client_policy:zemdregon");
      expect(text).not.toContain(row?.scope_hash as string);
      expect(text).not.toContain("registry.npmjs.org");
    }
    const waiting = await call("delegate_task", privArgs(), 1);
    expect(waiting.body.status).toBe("AWAITING_APPROVAL");
    expect(ledger.getApprovalForRun(waiting.body.run_id)?.status).toBe("PENDING");
  });

  it("the ceiling still applies: not_required below a privileged ceiling is PERMISSION_BLOCKED with nothing written", async () => {
    await setup({ adapters: [privilegedCapable()], clients: CLIENTS, start: false });
    const r = await call("delegate_task", privArgs(), 2);
    expect(r.body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { requested: "privileged", client_max_profile: "edit-untrusted" },
    });
    expect(runCount()).toBe(0);
    expect(ledger.listApprovals()).toHaveLength(0);
    // V13 is unchanged too: privileged without a scope is INVALID_REQUEST.
    const noScope = await call("delegate_task", delegateArgs({ trust_profile: "privileged" }));
    expect(noScope.body.error).toMatchObject({ code: "INVALID_REQUEST", details: { field: "privileged_scope" } });
  });

  it("continue_task runs under the client_policy approval with the scope as is", async () => {
    await setup({ adapters: [privilegedCapable()], clients: CLIENTS });
    const d = await call("delegate_task", privArgs());
    await pollTerminal(d.body.run_id);
    const c = await call("continue_task", { meta_session_id: d.body.meta_session_id, instruction: "go on" });
    expect(c.isError).toBe(false);
    expect(c.body.approval).toMatchObject({ status: "APPROVED" });
    const done = await pollTerminal(c.body.run_id);
    expect(done.status).toBe("SUCCEEDED");
    const row = ledger.getApprovalForRun(d.body.run_id);
    expect(ledger.listApprovals()).toHaveLength(1);
    const snap = JSON.parse(ledger.getRunRecord(c.body.run_id)?.policy_snapshot_json ?? "{}");
    expect(snap.privilegedScope).toMatchObject({ scopeHash: row?.scope_hash, approvalId: row?.id });
    expect(ledger.listRunsCoveredByApproval(row?.id as string).map((r) => r.id)).toEqual([
      d.body.run_id,
      c.body.run_id,
    ]);
  });

  it("a tampered scope hash still fails PERMISSION_BLOCKED before spawn", async () => {
    await setup({ adapters: [privilegedCapable()], clients: CLIENTS, start: false });
    const d = await call("delegate_task", privArgs());
    expect(d.body.status).toBe("QUEUED");
    const snap = JSON.parse(ledger.getRunRecord(d.body.run_id)?.policy_snapshot_json ?? "{}");
    snap.privilegedScope.scope.network = { mode: "on" };
    db.prepare("UPDATE run SET policy_snapshot_json = ? WHERE id = ?").run(JSON.stringify(snap), d.body.run_id);
    lifecycle.start();
    const done = await pollTerminal(d.body.run_id);
    expect(done).toMatchObject({ status: "FAILED", failure_code: "PERMISSION_BLOCKED" });
    expect(ledger.getRunRecord(d.body.run_id)).toMatchObject({ pid: null, worktree_path: null });
  });
});

describe("idempotency (FR-MCP-08, BR-10)", () => {
  it("same key and request returns the same run; a different request fails; keys are scoped per client", async () => {
    await setup({
      adapters: [fakeWriter()],
      clients: [
        { id: "a", max: "edit-untrusted" },
        { id: "b", max: "edit-untrusted" },
      ],
      start: false,
    });
    const args = delegateArgs({ idempotency_key: "key-0001" });
    const first = await call("delegate_task", args);
    const again = await call("delegate_task", { ...args, wait_seconds: 0 });
    expect(again.isError).toBe(false);
    expect(again.body).toMatchObject({ run_id: first.body.run_id, replayed: true });
    // Same canonical request: a different spelling of the same workspace and explicit defaults.
    const spelled = await call("delegate_task", {
      ...args,
      workspace_path: `${repo}/.`,
      constraints: [],
      priority: "normal",
    });
    expect(spelled.body.run_id).toBe(first.body.run_id);
    const changed = await call("delegate_task", { ...args, objective: "something else" });
    expect(changed.body.error).toMatchObject({ code: "INVALID_REQUEST" });
    const otherClient = await call("delegate_task", args, 1);
    expect(otherClient.isError).toBe(false);
    expect(otherClient.body.run_id).not.toBe(first.body.run_id);
    expect(runCount()).toBe(2);
  });

  it("another client's run and meta-session are unknown ids", async () => {
    await setup({
      adapters: [fakeWriter()],
      clients: [
        { id: "a", max: "edit-untrusted" },
        { id: "b", max: "edit-untrusted" },
      ],
      start: false,
    });
    const mine = await call("delegate_task", delegateArgs(), 0);
    for (const [tool, args] of [
      ["get_run", { run_id: mine.body.run_id }],
      ["cancel_run", { run_id: mine.body.run_id }],
      ["get_artifacts", { run_id: mine.body.run_id }],
      ["continue_task", { meta_session_id: mine.body.meta_session_id, instruction: "x" }],
    ] as const) {
      const r = await call(tool, args, 1);
      expect(r.body.error?.code, tool).toBe("INVALID_REQUEST");
    }
    expect(ledger.getRunRecord(mine.body.run_id)?.state).toBe("QUEUED");
  });

  it("a full ingress queue maps to ELIGIBILITY_NONE with reason QUEUE_FULL (ROADMAP Q-5, Proposed)", async () => {
    await setup({ adapters: [fakeWriter()], lifecycle: { maxQueueDepth: 1 }, start: false });
    expect((await call("delegate_task", delegateArgs())).isError).toBe(false);
    const full = await call("delegate_task", delegateArgs());
    expect(full.body.error).toMatchObject({ code: "ELIGIBILITY_NONE", details: { reason: "QUEUE_FULL" } });
  });
});

describe("cancel_run (WF-4, BR-11)", () => {
  it("cancels a running task asynchronously; cancelling a terminal run is a no-op", async () => {
    await setup({ adapters: [fakeWriter()] });
    const d = await call("delegate_task", delegateArgs({ objective: "hang" }));
    const end = Date.now() + 10_000;
    while (ledger.getRunRecord(d.body.run_id)?.state !== "RUNNING") {
      if (Date.now() > end) throw new Error("never reached RUNNING");
      await new Promise((res) => setTimeout(res, 20));
    }
    const c = await call("cancel_run", { run_id: d.body.run_id, reason: "changed my mind" });
    expect(c.isError).toBe(false);
    const done = await pollTerminal(d.body.run_id);
    expect(done.status).toBe("CANCELLED");
    expect(done.failure_code).toBeUndefined();
    const again = await call("cancel_run", { run_id: d.body.run_id });
    expect(again.body.status).toBe("CANCELLED");
  });

  it("a queued run is cancelled directly", async () => {
    await setup({ adapters: [fakeWriter()], start: false });
    const d = await call("delegate_task", delegateArgs());
    const c = await call("cancel_run", { run_id: d.body.run_id });
    expect(c.body.status).toBe("CANCELLED");
  });
});

describe("dispatch-time gate (FRD BR-20, T8)", () => {
  it("a provider that becomes ineligible after admission fails at PREFLIGHT with the BR-3 code", async () => {
    await setup({ adapters: [recorded(claudeReplay("success-edit.jsonl")).adapter], start: false });
    const d = await call("delegate_task", delegateArgs());
    expect(d.isError).toBe(false);
    claudeLoggedIn = false;
    lifecycle.start();
    const done = await pollTerminal(d.body.run_id);
    expect(done).toMatchObject({ status: "FAILED", failure_code: "AUTH_REQUIRED" });
    expect(done.failure_detail).toContain("claude auth login");
  });
});

describe("handoff runs on the MCP read surface (T5.5, FR-MCP-04)", () => {
  it("get_run of a handoff run, with its events, carries no bundle text", async () => {
    await setup({ adapters: [fakeWriter()] });
    const goal = "add a feature canary-goal-7Q4";
    const constraint = "canary-constraint-9Z2";
    const d = await call("delegate_task", delegateArgs({ objective: goal, constraints: [constraint] }));
    expect((await pollTerminal(d.body.run_id)).status).toBe("SUCCEEDED");
    const sess = d.body.meta_session_id as string;

    // The lifecycle hook T5.6 will call (no continue_task change here): build and store the view, admit the run.
    const { built, stored } = await buildAndPutHandoffView(
      { ledger, artifacts, redact: (x: Buffer) => artifacts.redactContent(x), store: artifacts },
      { asOf: takeAsOf(ledger, sess), bounds: DEFAULT_BUNDLE_BOUNDS },
    );
    const bundleText = built.bytes.toString("utf8");
    expect(bundleText).toContain(goal);
    expect(bundleText).toContain(constraint);
    const h = await lifecycle.submit({
      clientId: "orchestrator",
      objective: "continue the feature",
      trustProfile: "edit-untrusted",
      provider: "fake",
      metaSessionId: sess,
      constraints: [constraint],
      handoff: { built, stored, fromProvider: "fake", reason: "no_binding" },
    });
    expect((await pollTerminal(h.runId)).status).toBe("SUCCEEDED");

    const g = await call("get_run", { run_id: h.runId, include_events: { after_seq: 0, limit: 200 } });
    expect(g.isError).toBe(false);
    const text = JSON.stringify(g.body);
    for (const t of [goal, constraint, "[untrusted data", INSTRUCTION_MARKER, "another agent started", bundleText]) {
      expect(text).not.toContain(t);
    }
    // The view is named by id only (T5.10 owns its read surface).
    const view = ledger.listArtifactsForRun(h.runId).find((a) => a.kind === "handoff_view");
    expect(g.body.artifacts.handoff_view).toBe(view?.id);
    expect(g.body.route.reasons.join(" ")).not.toContain(goal);
  });
});

describe("outbound scrubbing", () => {
  it("replaces paths outside the allowed roots and credential-shaped tokens", () => {
    const scrub = createScrubber(["/work/allowed"]);
    expect(scrub("see /work/allowed/repo/a.txt and /home/op/.claude/x.json.")).toBe(
      "see /work/allowed/repo/a.txt and <path>.",
    );
    expect(scrub("token sk-abcdefghijklmnopqrstuvwxyz123")).toBe("token [REDACTED]");
  });
});

/** A configured `host` project whose primary context is `repo` (T9.2); `over` replaces any field. */
function project(over: Partial<ResolvedProject> = {}, contextPath = repo, baseRef = "main"): ResolvedProject {
  return {
    id: "web-app",
    name: "Web application",
    environment: { kind: "host" },
    contexts: [
      {
        id: "main",
        kind: "repository",
        path: contextPath,
        baseRef,
        primary: true,
        writable: true,
        push: { policy: "none" },
        sign: false,
        finalizeCommit: false,
      },
    ],
    ...over,
  };
}
const projectArgs = (over: Json = {}): Json => ({
  objective: "add a feature",
  project: "web-app",
  trust_profile: "edit-untrusted",
  ...over,
});
const sessionRow = (id: string) =>
  db.prepare("SELECT project_id, base_commit FROM meta_session WHERE id = ?").get(id) as {
    project_id: string | null;
    base_commit: string | null;
  };
const runRow = (id: string) =>
  db.prepare("SELECT project_id, policy_snapshot_json FROM run WHERE id = ?").get(id) as {
    project_id: string | null;
    policy_snapshot_json: string;
  };

describe("projects (T9.2; FR-PRJ-03, FR-PRJ-04, FR-PRJ-06; FRD V12, BR-23)", () => {
  it("publishes list_projects and a delegate_task whose project and workspace_path are alternatives", async () => {
    await setup({ adapters: [fakeWriter()] });
    const client = servers[0]?.client as Client;
    const { tools } = await client.listTools();
    const del = tools.find((t) => t.name === "delegate_task");
    expect(del?.inputSchema.required).toEqual(["objective", "trust_profile"]);
    expect(Object.keys(del?.inputSchema.properties ?? {})).toContain("project");
    expect(tools.map((t) => t.name)).toContain("list_projects");
  });

  it("exactly one of project and workspace_path: both and neither are INVALID_REQUEST with nothing written", async () => {
    await setup({
      adapters: [fakeWriter()],
      projects: [project()],
      clients: [{ id: "o", max: "edit-untrusted", projects: ["web-app"] }],
    });
    const both = await call("delegate_task", delegateArgs({ project: "web-app" }));
    expect(both.body.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(both.body.error.message).toMatch(/exactly one of workspace_path and project/);
    const { workspace_path: _w, ...none } = delegateArgs();
    const neither = await call("delegate_task", none);
    expect(neither.body.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(neither.body.error.message).toMatch(/exactly one of workspace_path and project/);
    expect(runCount()).toBe(0);
  });

  it("a project run records project_id on the run and meta-session and the environment kind in the policy snapshot", async () => {
    g(repo, "branch", "release");
    writeFileSync(path.join(repo, "later.txt"), "later\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "later on main");
    const release = g(repo, "rev-parse", "release");
    await setup({
      adapters: [fakeWriter()],
      projects: [project({}, repo, "release")],
      clients: [{ id: "o", max: "edit-untrusted", projects: ["web-app"] }],
    });
    const d = await call("delegate_task", projectArgs({ wait_seconds: 20 }));
    expect(d.isError).toBe(false);
    expect(d.body).toMatchObject({ status: "SUCCEEDED", project_id: "web-app" });
    expect(sessionRow(d.body.meta_session_id)).toEqual({ project_id: "web-app", base_commit: release }); // FR-PRJ-02 base_ref
    const row = runRow(d.body.run_id);
    expect(row.project_id).toBe("web-app");
    expect(JSON.parse(row.policy_snapshot_json).project).toEqual({
      id: "web-app",
      name: "Web application",
      environment_kind: "host",
      context_id: "main",
      base_ref: "release",
      effective_max_profile: "edit-untrusted",
      // T9.4 / Q-41: Git facts frozen at admission (no identity configured here, so none is recorded).
      writable: true,
      push: { policy: "none" },
    });
    expect(JSON.stringify(d.body)).not.toContain(repo); // the context path never leaves the controller
  });

  it("freezes the primary context's commit identity and push policy into the run's snapshot (T9.4, Q-41)", async () => {
    const base = project();
    const ctx = base.contexts[0];
    if (!ctx) throw new Error("no context");
    await setup({
      adapters: [fakeWriter()],
      projects: [
        {
          ...base,
          contexts: [
            {
              ...ctx,
              identity: { name: "Ada Maintainer", email: "ada@example.test" },
              push: { policy: "branch", remote: "https://user:secret@example.test/r.git", branchPrefix: "pub/" },
            },
          ],
        },
      ],
      clients: [{ id: "o", max: "edit-untrusted", projects: ["web-app"] }],
    });
    const d = await call("delegate_task", projectArgs({ wait_seconds: 20 }));
    expect(d.isError, JSON.stringify(d.body)).toBe(false);
    const snap = JSON.parse(runRow(d.body.run_id).policy_snapshot_json).project;
    expect(snap).toMatchObject({
      writable: true,
      identity: { name: "Ada Maintainer", email: "ada@example.test" },
      push: { policy: "branch" },
    });
    // The remote is not frozen: it is not validated as a remote name and could carry credentials (NFR-SEC-01).
    expect(runRow(d.body.run_id).policy_snapshot_json).not.toContain("secret");
    // T9.7: no finalize-only opt-in configured, so none is frozen.
    expect(snap.finalize_commit).toBeUndefined();
  });

  it("freezes the finalize-only opt-in into the run's snapshot (T9.7, FR-GIT-09)", async () => {
    const base = project();
    const ctx = base.contexts[0];
    if (!ctx) throw new Error("no context");
    await setup({
      adapters: [fakeWriter()],
      projects: [
        {
          ...base,
          contexts: [{ ...ctx, identity: { name: "Ada Maintainer", email: "ada@example.test" }, finalizeCommit: true }],
        },
      ],
      clients: [{ id: "o", max: "edit-untrusted", projects: ["web-app"] }],
    });
    const d = await call("delegate_task", projectArgs({ wait_seconds: 20 }));
    expect(d.isError, JSON.stringify(d.body)).toBe(false);
    expect(JSON.parse(runRow(d.body.run_id).policy_snapshot_json).project).toMatchObject({ finalize_commit: true });
  });

  it("a workspace_path run has no project; a client with no project list keeps using workspace paths", async () => {
    await setup({ adapters: [fakeWriter()], projects: [project()] });
    const d = await call("delegate_task", delegateArgs({ wait_seconds: 20 }));
    expect(d.body.status).toBe("SUCCEEDED");
    expect(d.body.project_id).toBeUndefined();
    expect(sessionRow(d.body.meta_session_id).project_id).toBeNull();
    expect(JSON.parse(runRow(d.body.run_id).policy_snapshot_json).project).toBeUndefined();
  });

  it("unknown project is INVALID_REQUEST; a project outside the client's list (or with no list) is PERMISSION_BLOCKED", async () => {
    await setup({
      adapters: [fakeWriter()],
      projects: [project(), project({ id: "other-app", name: "Other" })],
      clients: [
        { id: "listed", max: "edit-untrusted", projects: ["web-app"] },
        { id: "unlisted", max: "edit-untrusted" },
      ],
    });
    const unknown = await call("delegate_task", projectArgs({ project: "nope" }), 0);
    expect(unknown.body.error).toMatchObject({ code: "INVALID_REQUEST", details: { field: "project" } });
    const outside = await call("delegate_task", projectArgs({ project: "other-app" }), 0);
    expect(outside.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { project: "other-app" } });
    const none = await call("delegate_task", projectArgs(), 1);
    expect(none.body.error).toMatchObject({ code: "PERMISSION_BLOCKED" });
    expect(runCount()).toBe(0);
    const ok = await call("delegate_task", projectArgs({ wait_seconds: 20 }), 0);
    expect(ok.body.status).toBe("SUCCEEDED");
  });

  it("a container project fails with the not-implemented error and nothing written (M10)", async () => {
    const container = project({ environment: { kind: "container", imageDigest: `sha256:${"a".repeat(64)}` } });
    await setup({
      adapters: [fakeWriter()],
      projects: [container],
      clients: [{ id: "o", max: "edit-untrusted", projects: ["web-app"] }],
    });
    const r = await call("delegate_task", projectArgs());
    expect(r.body.error).toMatchObject({ code: "TOOL_FAILURE", details: { reason: "ENVIRONMENT_NOT_IMPLEMENTED" } });
    expect(r.body.error.message).toMatch(/not implemented yet \(M10\)/);
    expect(runCount()).toBe(0);
  });

  it("a base ref that does not resolve is INVALID_REQUEST with nothing written", async () => {
    await setup({
      adapters: [fakeWriter()],
      projects: [project({}, repo, "no-such-ref")],
      clients: [{ id: "o", max: "edit-untrusted", projects: ["web-app"] }],
    });
    const r = await call("delegate_task", projectArgs());
    expect(r.body.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(r.body.error.message).toMatch(/base ref/);
    expect(runCount()).toBe(0);
  });

  it("a primary context outside the allowed roots is INVALID_REQUEST (checked again at admission)", async () => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-outside-")));
    try {
      await setup({
        adapters: [fakeWriter()],
        projects: [project({}, outside)],
        clients: [{ id: "o", max: "edit-untrusted", projects: ["web-app"] }],
      });
      const r = await call("delegate_task", projectArgs({ trust_profile: "inspect-untrusted" }));
      expect(r.body.error).toMatchObject({ code: "INVALID_REQUEST" });
      expect(r.body.error.message).toMatch(/allowed root/);
      expect(runCount()).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  describe("effective ceiling is the lower of the client's and the project's (FR-PRJ-06)", () => {
    const cases: [
      client: TrustProfile,
      project: TrustProfile | undefined,
      requested: TrustProfile,
      blocked: boolean,
    ][] = [
      ["edit-untrusted", "inspect-untrusted", "edit-untrusted", true], // project lower
      ["edit-untrusted", "inspect-untrusted", "inspect-untrusted", false],
      ["inspect-untrusted", "edit-untrusted", "edit-untrusted", true], // client lower
      ["edit-untrusted", "trusted-development", "edit-untrusted", false], // equal to the lower: allowed
      ["edit-untrusted", undefined, "edit-untrusted", false], // no project ceiling: the client's stands
      ["edit-untrusted", undefined, "test-sandboxed", true],
    ];
    it.each(cases)("client %s, project %s, requested %s -> blocked %s", async (cMax, pMax, requested, blocked) => {
      await setup({
        adapters: [fakeWriter()],
        projects: [project(pMax ? { maxTrustProfile: pMax } : {})],
        clients: [{ id: "o", max: cMax, projects: ["web-app"] }],
      });
      const r = await call("delegate_task", projectArgs({ trust_profile: requested }));
      if (blocked) {
        expect(r.body.error).toMatchObject({
          code: "PERMISSION_BLOCKED",
          details: { requested, client_max_profile: cMax, project: "web-app" },
        });
        expect(runCount()).toBe(0);
      } else {
        expect(r.body.error).toBeUndefined();
      }
    });

    it("a project ceiling below privileged blocks privileged for a privileged client, before V13 and with nothing written", async () => {
      await setup({
        adapters: [fakeWriter()],
        projects: [project({ maxTrustProfile: "trusted-development" })],
        clients: [{ id: "o", max: "privileged", approval: "not_required", projects: ["web-app"] }],
      });
      const r = await call("delegate_task", projectArgs({ trust_profile: "privileged", privileged_scope: SCOPE }));
      expect(r.body.error).toMatchObject({
        code: "PERMISSION_BLOCKED",
        details: { requested: "privileged", effective_max_profile: "trusted-development" },
      });
      expect(r.body.error.message).toMatch(/project web-app/);
      expect(runCount()).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM approval").get() as { n: number }).n).toBe(0);
    });
  });

  describe("allowed_providers (FR-PRJ-06, BR-23)", () => {
    it("narrows routing to the project's providers and records the excluded ones in the route decision", async () => {
      await setup({
        adapters: [fakeWriter(), recorded(claudeReplay("success-edit.jsonl")).adapter],
        projects: [project({ allowedProviders: ["claude-code"] })],
        clients: [{ id: "o", max: "edit-untrusted", projects: ["web-app"] }],
      });
      const d = await call("delegate_task", projectArgs({ wait_seconds: 20 }));
      expect(d.body.provider.adapter).toBe("claude");
      const rd = JSON.parse(
        (
          db.prepare("SELECT reasons_json FROM route_decision WHERE run_id = ?").get(d.body.run_id) as {
            reasons_json: string;
          }
        ).reasons_json,
      );
      expect(rd.project).toEqual({ id: "web-app", excluded_providers: ["fake"] });
    });

    it("require_provider outside the set is PERMISSION_BLOCKED with nothing written; a set leaving no registered provider is ELIGIBILITY_NONE", async () => {
      await setup({
        adapters: [fakeWriter(), recorded(claudeReplay("success-edit.jsonl")).adapter],
        projects: [
          project({ allowedProviders: ["claude-code"] }),
          project({ id: "cursor-only", name: "C", allowedProviders: ["cursor"] }),
        ],
        clients: [{ id: "o", max: "edit-untrusted", projects: ["web-app", "cursor-only"] }],
      });
      const named = await call(
        "delegate_task",
        projectArgs({ routing: { provider_preference: "fake", require_provider: true } }),
      );
      expect(named.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { project: "web-app" } });
      const empty = await call("delegate_task", projectArgs({ project: "cursor-only" }));
      expect(empty.body.error).toMatchObject({ code: "ELIGIBILITY_NONE", details: { reason: "PROJECT_PROVIDERS" } });
      expect(runCount()).toBe(0);
    });
  });

  describe("a meta-session stays in its project (BR-23)", () => {
    it("continue_task keeps the project on the new run and takes no project input", async () => {
      await setup({
        adapters: [fakeWriter()],
        projects: [project()],
        clients: [{ id: "o", max: "edit-untrusted", projects: ["web-app"] }],
      });
      const d = await call("delegate_task", projectArgs({ wait_seconds: 20 }));
      expect(d.body.status).toBe("SUCCEEDED");
      const withProject = await call("continue_task", {
        meta_session_id: d.body.meta_session_id,
        instruction: "more",
        project: "other-app",
      });
      expect(withProject.body.error).toMatchObject({ code: "INVALID_REQUEST" });
      expect(runCount()).toBe(1);
      const c = await call("continue_task", {
        meta_session_id: d.body.meta_session_id,
        instruction: "keep going",
        wait_seconds: 20,
      });
      expect(c.body).toMatchObject({ status: "SUCCEEDED", project_id: "web-app" });
      const row = runRow(c.body.run_id);
      expect(row.project_id).toBe("web-app");
      expect(JSON.parse(row.policy_snapshot_json).project.environment_kind).toBe("host");
    });

    it("the lifecycle refuses a conflicting project, or one added to a path session, in the admission transaction", async () => {
      await setup({
        adapters: [fakeWriter()],
        projects: [project()],
        clients: [{ id: "o", max: "edit-untrusted", projects: ["web-app"] }],
      });
      const inProject = await call("delegate_task", projectArgs({ wait_seconds: 20 }));
      const byPath = await call("delegate_task", delegateArgs({ wait_seconds: 20 }));
      const snap = (id: string) => ({
        id,
        name: id,
        environment_kind: "host" as const,
        context_id: "main",
        base_ref: "main",
        effective_max_profile: "edit-untrusted" as const,
      });
      const base = {
        clientId: "o",
        objective: "x",
        trustProfile: "edit-untrusted" as const,
        provider: "fake" as const,
      };
      await expect(
        lifecycle.submit({ ...base, metaSessionId: inProject.body.meta_session_id, project: snap("other-app") }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(lifecycle.submit({ ...base, metaSessionId: inProject.body.meta_session_id })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
      await expect(
        lifecycle.submit({ ...base, metaSessionId: byPath.body.meta_session_id, project: snap("web-app") }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(runCount()).toBe(2);
    });

    it("a project removed from configuration, or from the client's list, refuses new runs but keeps history", async () => {
      const projects = [project()];
      const clients = [{ id: "o", max: "edit-untrusted" as const, projects: ["web-app"] }];
      await setup({ adapters: [fakeWriter()], projects, clients });
      const d = await call("delegate_task", projectArgs({ wait_seconds: 20 }));
      clients[0]?.projects.splice(0);
      const blocked = await call("continue_task", { meta_session_id: d.body.meta_session_id, instruction: "again" });
      expect(blocked.body.error).toMatchObject({ code: "PERMISSION_BLOCKED" });
      clients[0]?.projects.push("web-app");
      projects.splice(0);
      const gone = await call("continue_task", { meta_session_id: d.body.meta_session_id, instruction: "again" });
      expect(gone.body.error).toMatchObject({ code: "INVALID_REQUEST" });
      expect(runCount()).toBe(1);
      expect((await call("get_run", { run_id: d.body.run_id })).body.project_id).toBe("web-app");
    });
  });

  describe("list_projects (read-only, per client)", () => {
    it("lists only the calling client's projects, with ceilings and no paths", async () => {
      await setup({
        adapters: [fakeWriter()],
        projects: [
          project({ maxTrustProfile: "inspect-untrusted", allowedProviders: ["claude-code", "codex"] }),
          project({ id: "other-app", name: "Other" }),
          project({ id: "hidden-app", name: "Hidden" }),
        ],
        clients: [
          { id: "a", max: "edit-untrusted", projects: ["web-app", "other-app"] },
          { id: "b", max: "inspect-untrusted", projects: ["other-app"] },
          { id: "c", max: "edit-untrusted" },
        ],
      });
      const a = await call("list_projects", {}, 0);
      expect(a.isError).toBe(false);
      expect(a.body.projects).toEqual([
        {
          id: "web-app",
          name: "Web application",
          environment_kind: "host",
          contexts: [{ id: "main", kind: "repository", primary: true, push_policy: "none" }],
          max_trust_profile: "inspect-untrusted",
          effective_max_profile: "inspect-untrusted",
          allowed_providers: ["claude-code", "codex"],
        },
        {
          id: "other-app",
          name: "Other",
          environment_kind: "host",
          contexts: [{ id: "main", kind: "repository", primary: true, push_policy: "none" }],
          effective_max_profile: "edit-untrusted",
        },
      ]);
      expect(JSON.stringify(a.body)).not.toContain(root); // no filesystem path
      const b = await call("list_projects", {}, 1);
      expect(b.body.projects.map((p: Json) => [p.id, p.effective_max_profile])).toEqual([
        ["other-app", "inspect-untrusted"],
      ]);
      expect((await call("list_projects", {}, 2)).body).toEqual({ projects: [] });
      const bad = await call("list_projects", { project: "x" }, 0);
      expect(bad.body.error.code).toBe("INVALID_REQUEST");
    });
  });
});
