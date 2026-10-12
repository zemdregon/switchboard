/**
 * MCP contract tests (T2.4; FR-MCP-01, 03–09; LLD §3). A scripted MCP client talks to the server through the SDK's
 * in-memory transport pair, against the fake adapter, the Claude adapter replaying its synthetic fixtures and the
 * Codex adapter replaying its synthetic fixtures. No provider CLI, login or network is needed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle, type RunLifecycleOptions } from "../lifecycle/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { createScrubber, createSwitchboardServer, type SwitchboardMcpServer, TOOL_NAMES } from "./index.js";

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
  if (argv.includes(REPLAY_SCRIPT)) {
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
  clients?: { id: string; max: TrustProfile }[];
  lifecycle?: Partial<RunLifecycleOptions>;
  start?: boolean;
}

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
    eligibility: { platform: "linux", gate: gateFor(registry, s.passCodex) },
    ...s.lifecycle,
  });
  if (s.start !== false) lifecycle.start();
  const clients = s.clients ?? [{ id: "orchestrator", max: "edit-untrusted" }];
  const config = {
    allowedRoots: [root],
    mcpClients: new Map(clients.map((c) => [c.id, { id: c.id, maxTrustProfile: c.max }])),
  };
  for (const c of clients) {
    const mcp = createSwitchboardServer({ lifecycle, ledger, artifacts, registry, config, clientId: c.id });
    const client = new Client({ name: `test-${c.id}`, version: "0.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.server.connect(serverSide);
    await client.connect(clientSide);
    await client.listTools(); // caches the published output schemas, so every result below is schema-checked
    servers.push({ mcp, client });
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
    expect(cont.route.reasons[0]).toBe("selected fake (continuation)");
    expect(fake.resumes).toEqual(["writer-1"]);
    const diff2 = await call("get_artifacts", { run_id: c.body.run_id, kinds: ["diff"] });
    expect(diff2.body.artifacts[0].inline_text).toContain("+continued"); // started from the session head
  });

  it("wait_seconds returns the terminal envelope when the run finishes within the bound", async () => {
    await setup({ adapters: [fakeWriter()] });
    const d = await call("delegate_task", delegateArgs({ wait_seconds: 20 }));
    expect(d.body.status).toBe("SUCCEEDED");
  });

  it("continue_task rejects an active session, a different provider, an unknown session and an idempotency key", async () => {
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
    expect(other.body.error.code).toBe("INVALID_REQUEST");
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
      validated_range: ">=2.1.296 <2.2.0",
      supported_profiles: ["inspect-untrusted", "edit-untrusted"],
    });
    expect(by.codex).toMatchObject({ adapter_status: "ADAPTER_VERSION_UNVERIFIED", auth_state: "NOT_CHECKED" });
    for (const p of r.body.providers) expect(p.supported_profiles).not.toContain("privileged");
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(process.execPath);
    expect(text).not.toContain(dataDir);
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
        ["delegate_task", delegateArgs({ verification_commands: [["npm", "test"]] })],
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
  it("a profile above the client's maximum is PERMISSION_BLOCKED, never downgraded; privileged is never available", async () => {
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
    const priv = await call("delegate_task", delegateArgs({ trust_profile: "privileged" }), 1);
    expect(priv.body.error.code).toBe("PERMISSION_BLOCKED");
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

describe("outbound scrubbing", () => {
  it("replaces paths outside the allowed roots and credential-shaped tokens", () => {
    const scrub = createScrubber(["/work/allowed"]);
    expect(scrub("see /work/allowed/repo/a.txt and /home/op/.claude/x.json.")).toBe(
      "see /work/allowed/repo/a.txt and <path>.",
    );
    expect(scrub("token sk-abcdefghijklmnopqrstuvwxyz123")).toBe("token [REDACTED]");
  });
});
