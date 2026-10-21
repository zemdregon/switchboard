/**
 * Orchestrator-managed projects over MCP (T9.9; FR-PRJ-10, FRD BR-32, LLD §3, ADR-0030). A scripted MCP client talks to
 * the server through the SDK's in-memory transport, against the fake adapter and real temporary Git repositories. No
 * provider CLI, login or network. Only the validation cases the brief names are here; adversarial escape scenarios
 * belong to T3.8b.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, auditInvocation, type Invocation, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import type { ResolvedProject } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { DynamicProjectStore } from "../projects/index.js";
import { openRagStore, ragStoreDir } from "../retrieval/store.js";
import { WorkspaceManager } from "../workspace/index.js";
import {
  createSwitchboardServer,
  PROJECT_TOOL_NAMES,
  type SwitchboardMcpServer,
  TOOL_NAMES,
  WORK_QUEUE_TOOL_NAMES,
} from "./index.js";
import type { PendingRevisionAnnouncement } from "./project-tools.js";

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

/** Fake provider CLI: writes `feature.txt`; the objective "hang" never finishes (for the active-run cases). */
const WRITER_CLI = `
import { writeFileSync } from "node:fs";
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
    emit({ type: "session", session_id: "writer-1" });
    if (prompt.trim() === "hang") { setInterval(() => {}, 1000); return; }
    writeFileSync("feature.txt", "new feature\\n");
    emit({ type: "result", ok: true, summary: "wrote feature" });
  });
}
`;

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: name === "inspect-untrusted" ? "none" : name === "edit-untrusted" ? "allowlist" : "broad",
  ...(name === "edit-untrusted" ? { shellAllowlist: [] } : {}),
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

let root: string;
let repo: string;
let outside: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let store: DynamicProjectStore;
let lifecycle: RunLifecycle;
let compiled: Invocation[];
const servers: { mcp: SwitchboardMcpServer; client: Client }[] = [];

interface ClientSpec {
  id: string;
  max: TrustProfile;
  manage?: boolean;
  maxPush?: "none" | "branch";
  projects?: string[];
}

async function setup(
  clients: ClientSpec[],
  opts: {
    projects?: ResolvedProject[];
    disabled?: string[];
    announcePendingRevision?: (a: PendingRevisionAnnouncement) => void;
  } = {},
) {
  const registry = new AdapterRegistry();
  const fake = new FakeAdapter({ script: path.join(root, "writer-cli.mjs"), timeouts: SHORT });
  registry.register({
    ...fake,
    id: fake.id,
    transports: fake.transports,
    gitWriteControl: fake.gitWriteControl,
    resumeCwd: fake.resumeCwd,
    gitCapabilities: fake.gitCapabilities,
    probe: (r) => fake.probe(r),
    authPreflight: (r) => fake.authPreflight(r),
    compile: (req, p) => {
      const inv = fake.compile(req, p);
      if (!("ineligible" in inv)) compiled.push(inv);
      return inv;
    },
    resumeArgs: (b, req, p) => fake.resumeArgs(b, req, p),
    parseEvent: (i, s) => fake.parseEvent(i, s),
    extractResult: (e, x) => fake.extractResult(e, x),
    classifyFailure: (e) => fake.classifyFailure(e),
  });
  const ids = createIdGenerator();
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
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
  lifecycle.start();
  await connect(clients, opts, registry, artifacts);
}

async function connect(
  clients: ClientSpec[],
  opts: {
    projects?: ResolvedProject[];
    disabled?: string[];
    announcePendingRevision?: (a: PendingRevisionAnnouncement) => void;
  },
  registry: AdapterRegistry,
  artifacts: ArtifactStore,
) {
  const config = {
    allowedRoots: [root],
    dataDir,
    projects: opts.projects ?? [],
    providers: new Map((opts.disabled ?? []).map((id) => [id, { enabled: false, weight: undefined }])),
    mcpClients: new Map(
      clients.map((c) => [
        c.id,
        {
          id: c.id,
          maxTrustProfile: c.max,
          projects: c.projects ?? [],
          manageProjects: c.manage === true,
          maxPushPolicy: c.maxPush ?? "none",
        },
      ]),
    ),
  };
  for (const c of clients) {
    const mcp = createSwitchboardServer({
      lifecycle,
      ledger,
      artifacts,
      registry,
      config,
      clientId: c.id,
      projectStore: store,
      ...(opts.announcePendingRevision !== undefined ? { announcePendingRevision: opts.announcePendingRevision } : {}),
    });
    const client = new Client({ name: `test-${c.id}`, version: "0.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.server.connect(serverSide);
    await client.connect(clientSide);
    await client.listTools(); // caches the output schemas, so every result below is schema-checked
    servers.push({ mcp, client });
  }
}

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON checked by the published output schemas
type Json = Record<string, any>;

async function call(name: string, args: unknown = {}, clientIndex = 0): Promise<{ isError: boolean; body: Json }> {
  const client = servers[clientIndex]?.client;
  if (!client) throw new Error("no client");
  const res = await client.callTool({ name, arguments: args as Record<string, unknown> });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
  return { isError: res.isError === true, body: JSON.parse(text) as Json };
}

async function pollTerminal(runId: string, clientIndex = 0): Promise<Json> {
  const end = Date.now() + 20_000;
  for (;;) {
    const r = await call("get_run", { run_id: runId }, clientIndex);
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(r.body.status)) return r.body;
    if (Date.now() > end) throw new Error(`run ${runId} did not finish: ${r.body.status}`);
    await new Promise((res) => setTimeout(res, 20));
  }
}

const definition = (over: Json = {}, ctx: Json = {}): Json => ({
  id: "dyn-app",
  name: "Dynamic app",
  contexts: [{ id: "main", kind: "repository", path: repo, base_ref: "main", ...ctx }],
  ...over,
});
const BRANCH = {
  push: { policy: "branch", remote: "origin", branch_prefix: "sb/" },
  identity: { name: "A", email: "a@b.c" },
};
const delegate = (over: Json = {}): Json => ({
  objective: "add a feature",
  project: "dyn-app",
  trust_profile: "edit-untrusted",
  ...over,
});
const configured = (id: string): ResolvedProject => ({
  id,
  name: "Configured",
  environment: { kind: "host" },
  contexts: [
    {
      id: "main",
      kind: "repository",
      path: repo,
      baseRef: "main",
      primary: true,
      writable: true,
      finalizeCommit: false,
      push: { policy: "none" },
      sign: false,
    },
  ],
});
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const events = () =>
  db
    .prepare("SELECT action, outcome, code, reason, client_id, project_id FROM project_event ORDER BY ts, id")
    .all() as {
    action: string;
    outcome: string;
    code: string | null;
    reason: string | null;
    client_id: string | null;
    project_id: string | null;
  }[];

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-mcp-dyn-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  outside = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-mcp-dyn-out-")));
  g(outside, "init", "-q", "-b", "main");
  writeFileSync(path.join(outside, "secret.txt"), "x\n");
  g(outside, "add", "-A");
  g(outside, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  store = new DynamicProjectStore(db, { ids: createIdGenerator() });
  writeFileSync(path.join(root, "writer-cli.mjs"), WRITER_CLI);
  compiled = [];
});

afterEach(async () => {
  await lifecycle.shutdown();
  for (const s of servers.splice(0)) {
    await s.client.close();
    await s.mcp.close();
  }
  db.close();
  for (const inv of compiled) expect(auditInvocation(inv)).toEqual([]); // no bypass flag in any compiled argv
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("tool surface (FR-PRJ-10: only with manage_projects)", () => {
  it("a client without the flag has no project tools; calling one is an unknown tool, recorded", async () => {
    await setup([
      { id: "plain", max: "edit-untrusted" },
      { id: "mgr", max: "edit-untrusted", manage: true },
    ]);
    const plain = await servers[0]?.client.listTools();
    expect(plain?.tools.map((t) => t.name)).toEqual([...TOOL_NAMES, ...WORK_QUEUE_TOOL_NAMES]);
    const mgr = await servers[1]?.client.listTools();
    // ADR-0079: no project_sources here, so request_project_source is not offered.
    expect(mgr?.tools.map((t) => t.name)).toEqual([
      ...TOOL_NAMES,
      ...WORK_QUEUE_TOOL_NAMES,
      ...PROJECT_TOOL_NAMES.filter((n) => n !== "request_project_source"),
    ]);
    for (const t of mgr?.tools ?? []) expect((t.inputSchema as Json).additionalProperties).toBe(false);

    const r = await call("create_project", { project: definition() }, 0);
    const unknown = await call("no_such_tool", {}, 0);
    expect(r.body.error.code).toBe("INVALID_REQUEST");
    expect(r.body.error.message).toBe(unknown.body.error.message.replace("no_such_tool", "create_project"));
    expect(count("project_revision")).toBe(0);
    expect(events()).toEqual([
      {
        action: "create_project",
        outcome: "REFUSED",
        code: "INVALID_REQUEST",
        reason: "TOOL_NOT_OFFERED",
        client_id: "plain",
        project_id: "dyn-app",
      },
    ]);
  });

  it("refuses to build a manage_projects server without the store (fail closed)", async () => {
    await setup([{ id: "plain", max: "edit-untrusted" }]);
    expect(() =>
      createSwitchboardServer({
        lifecycle,
        ledger,
        artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
        registry: new AdapterRegistry(),
        config: {
          allowedRoots: [root],
          mcpClients: new Map([["m", { id: "m", maxTrustProfile: "edit-untrusted", manageProjects: true }]]),
        },
        clientId: "m",
      }),
    ).toThrow(/needs the dynamic project store/);
  });
});

describe("create, use, list (creator-only)", () => {
  it("creates a host project, runs in it like a configured one, and shows it only to its creator", async () => {
    await setup([
      { id: "mgr", max: "edit-untrusted", manage: true },
      { id: "other", max: "edit-untrusted", manage: true },
    ]);
    const c = await call("create_project", { project: definition() });
    expect(c.isError, JSON.stringify(c.body)).toBe(false);
    expect(c.body).toEqual({ id: "dyn-app", revision: 1, status: "ACTIVE", in_force_revision: 1 });

    const mine = await call("list_projects");
    expect(mine.body.projects).toEqual([
      {
        id: "dyn-app",
        name: "Dynamic app",
        environment_kind: "host",
        contexts: [
          {
            id: "main",
            kind: "repository",
            primary: true,
            push_policy: "none",
            base_ref: "main",
            sign: false,
            finalize_commit: false,
          },
        ],
        effective_max_profile: "edit-untrusted",
        source: "dynamic",
        revision: 1,
        status: "ACTIVE",
      },
    ]);
    expect(JSON.stringify(mine.body)).not.toContain(root); // no filesystem path
    expect((await call("list_projects", {}, 1)).body).toEqual({ projects: [] });

    const d = await call("delegate_task", delegate({ wait_seconds: 20 }));
    expect(d.isError, JSON.stringify(d.body)).toBe(false);
    expect(d.body).toMatchObject({ status: "SUCCEEDED", project_id: "dyn-app" });
    const row = db.prepare("SELECT project_id, policy_snapshot_json FROM run WHERE id = ?").get(d.body.run_id) as {
      project_id: string;
      policy_snapshot_json: string;
    };
    expect(row.project_id).toBe("dyn-app");
    // the same snapshot shape as a configured project (T9.2/T9.4), no path
    expect(JSON.parse(row.policy_snapshot_json).project).toEqual({
      id: "dyn-app",
      name: "Dynamic app",
      environment_kind: "host",
      context_id: "main",
      base_ref: "main",
      effective_max_profile: "edit-untrusted",
      writable: true,
      push: { policy: "none" },
    });
    const route = db.prepare("SELECT reasons_json FROM route_decision WHERE run_id = ?").get(d.body.run_id) as {
      reasons_json: string;
    };
    expect(JSON.parse(route.reasons_json).project).toEqual({ id: "dyn-app", excluded_providers: [], revision: 1 });
    expect(JSON.stringify(d.body)).not.toContain(repo);

    // another client: refused everywhere, with nothing about the definition in the answer
    const runsBefore = count("run");
    for (const [tool, args] of [
      ["delegate_task", delegate()],
      ["update_project", { id: "dyn-app", project: definition({ name: "mine now" }) }],
      ["delete_project", { id: "dyn-app" }],
      ["create_project", { project: definition() }],
    ] as const) {
      const r = await call(tool, args, 1);
      expect(r.body.error.code, tool).toBe("PERMISSION_BLOCKED");
      expect(JSON.stringify(r.body), tool).not.toContain(repo);
      expect(JSON.stringify(r.body), tool).not.toContain("Dynamic app");
    }
    expect(count("run")).toBe(runsBefore);
    expect(store.state("dyn-app")?.revisions).toHaveLength(1);
  });

  it("never touches a configured project, and a configured id always wins", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true, projects: ["web-app"] }], {
      projects: [configured("web-app")],
    });
    const create = await call("create_project", { project: definition({ id: "web-app" }) });
    const update = await call("update_project", { id: "web-app", project: definition({ id: "web-app" }) });
    const del = await call("delete_project", { id: "web-app" });
    for (const r of [create, update, del]) {
      expect(r.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "NOT_MANAGEABLE" } });
    }
    // the same message as for another client's project: no oracle beyond the code
    expect(create.body.error.message).toBe("project web-app is not a dynamic project of this client");
    expect(count("project_revision")).toBe(0);
    const list = await call("list_projects");
    expect(list.body.projects.map((p: Json) => [p.id, p.source])).toEqual([["web-app", undefined]]);
  });

  it("update and delete of an unknown id are INVALID_REQUEST; create of an existing id is INVALID_REQUEST", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true }]);
    expect((await call("update_project", { id: "dyn-app", project: definition() })).body.error.code).toBe(
      "INVALID_REQUEST",
    );
    expect((await call("delete_project", { id: "dyn-app" })).body.error.code).toBe("INVALID_REQUEST");
    await call("create_project", { project: definition() });
    expect((await call("create_project", { project: definition() })).body.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "ID_EXISTS" },
    });
    expect(
      (await call("update_project", { id: "dyn-app", project: definition({ id: "renamed" }) })).body.error,
    ).toMatchObject({ code: "INVALID_REQUEST", details: { reason: "ID_MISMATCH" } });
  });
});

describe("limits (BR-32): never wider than the client", () => {
  it("rejects ceiling, provider, push, paths outside the roots and inside the data dir; writes no revision", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true }], { disabled: ["codex"] });
    const link = path.join(root, "link");
    symlinkSync(outside, link);
    const dataRepo = path.join(dataDir, "nested");
    mkdirSync(dataRepo);
    g(dataRepo, "init", "-q", "-b", "main");
    writeFileSync(path.join(dataRepo, "f"), "x");
    g(dataRepo, "add", "-A");
    g(dataRepo, "commit", "-q", "-m", "x");
    const cases: [string, Json, string][] = [
      ["ceiling", definition({ max_trust_profile: "trusted-development" }), "CEILING_ABOVE_CLIENT"],
      ["provider", definition({ allowed_providers: ["codex"] }), "PROVIDER_OUTSIDE_CLIENT"],
      ["push", definition({}, BRANCH), "PUSH_ABOVE_CLIENT"],
      ["outside", definition({}, { path: outside }), "OUTSIDE_ALLOWED_ROOT"],
      ["dotdot", definition({}, { path: `${root}/../${path.basename(outside)}` }), "OUTSIDE_ALLOWED_ROOT"],
      ["symlink", definition({}, { path: link }), "OUTSIDE_ALLOWED_ROOT"],
      ["data dir", definition({}, { path: dataRepo }), "INSIDE_DATA_DIR"],
    ];
    for (const [label, project, reason] of cases) {
      const r = await call("create_project", { project });
      expect(r.body.error, label).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason } });
      expect(JSON.stringify(r.body), label).not.toContain(outside);
    }
    expect(count("project_revision")).toBe(0);
    expect(events().map((e) => [e.outcome, e.reason])).toEqual(cases.map(([, , reason]) => ["REFUSED", reason]));
  });

  it("a client cannot raise its own limits through a definition", async () => {
    await setup([{ id: "mgr", max: "inspect-untrusted", manage: true }]);
    for (const extra of [
      { max_push_policy: "branch" },
      { manage_projects: true },
      { client_id: "other" },
      { max_trust_profile: "privileged" },
    ]) {
      const r = await call("create_project", { project: definition(extra) });
      expect(r.body.error.code, JSON.stringify(extra)).toMatch(/INVALID_REQUEST|PERMISSION_BLOCKED/);
    }
    const top = await call("create_project", { project: definition(), max_trust_profile: "privileged" });
    expect(top.body.error.code).toBe("INVALID_REQUEST");
    await call("create_project", { project: definition({ max_trust_profile: "inspect-untrusted" }) });
    const up = await call("update_project", {
      id: "dyn-app",
      project: definition({ max_trust_profile: "edit-untrusted" }),
    });
    expect(up.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "CEILING_ABOVE_CLIENT" } });
    expect(store.state("dyn-app")?.revisions).toHaveLength(1);
  });

  it("malformed input: oversized fields, odd ids, prototype keys, NUL and control characters", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true }]);
    const proto = JSON.parse(`{"id":"dyn-app","name":"x","contexts":[],"__proto__":{"polluted":true}}`);
    const cases: [string, Json][] = [
      ["huge name", definition({ name: "n".repeat(100_000) })],
      ["huge path", definition({}, { path: `/${"p".repeat(10_000)}` })],
      [
        "many contexts",
        definition({
          contexts: Array.from({ length: 40 }, (_, i) => ({
            id: `c${i}`,
            kind: "repository",
            path: repo,
            base_ref: "main",
          })),
        }),
      ],
      ["unicode id", definition({ id: "dyn-аpp" })], // Cyrillic a
      ["fullwidth id", definition({ id: "ｄyn-app" })],
      ["upper id", definition({ id: "Dyn-App" })],
      ["constructor key", { ...definition(), constructor: { prototype: {} } }],
      ["proto key", proto],
      ["NUL path", definition({}, { path: `${repo}\u0000/x` })],
      ["newline name", definition({ name: "a\nb" })],
      ["bidi name", definition({ name: "abc‮def" })],
      ["unknown context kind", definition({}, { kind: "s3" })],
      ["no contexts", definition({ contexts: [] })],
    ];
    for (const [label, project] of cases) {
      const r = await call("create_project", { project });
      expect(r.body.error?.code, label).toBe("INVALID_REQUEST");
    }
    expect(({} as Json).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(count("project_revision")).toBe(0);
    const refused = events();
    expect(refused).toHaveLength(cases.length);
    expect(refused.every((e) => e.outcome === "REFUSED" && e.code === "INVALID_REQUEST")).toBe(true);
    // a malformed id is never stored
    expect(refused.map((e) => e.project_id).filter((p) => p !== null && p !== "dyn-app")).toEqual([]);
    expect(JSON.stringify(db.prepare("SELECT payload_json FROM project_event").all()).length).toBeLessThan(10_000);
  });
});

describe("provider name aliases (ADR-0076)", () => {
  it("allowed_providers takes claude and claude-code alike, stores one spelling, and an alias is never a widening", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true }]);
    const created = await call("create_project", {
      project: definition({ allowed_providers: ["claude", "claude-code"] }),
    });
    expect(created.body).toEqual({ id: "dyn-app", revision: 1, status: "ACTIVE", in_force_revision: 1 });
    expect((await call("list_projects")).body.projects[0].allowed_providers).toEqual(["claude-code"]);
    // The other spelling of the same set is equivalent: no approval needed.
    const same = await call("update_project", {
      id: "dyn-app",
      project: definition({ allowed_providers: ["claude"] }),
    });
    expect(same.body).toEqual({ id: "dyn-app", revision: 2, status: "ACTIVE", in_force_revision: 2 });
    // Adding a provider under its adapter spelling is still a widening that waits for the operator.
    const wider = await call("update_project", {
      id: "dyn-app",
      project: definition({ allowed_providers: ["claude-code", "grok"] }),
    });
    expect(wider.body).toMatchObject({
      revision: 3,
      status: "PENDING_APPROVAL",
      approval_needed: ["widened_providers"],
      in_force_revision: 2,
    });
    // An unknown name is refused by the schema, which lists both spellings.
    const unknown = await call("update_project", {
      id: "dyn-app",
      project: definition({ allowed_providers: ["claude-cod"] }),
    });
    expect(unknown.body.error.code).toBe("INVALID_REQUEST");
  });

  it("an alias of a disabled provider is refused exactly like its own spelling", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true }], { disabled: ["claude-code", "grok"] });
    for (const name of ["claude", "claude-code", "grok", "grok-build"]) {
      const r = await call("create_project", { project: definition({ allowed_providers: [name] }) });
      expect(r.body.error, name).toMatchObject({
        code: "PERMISSION_BLOCKED",
        details: { reason: "PROVIDER_OUTSIDE_CLIENT" },
      });
    }
    expect(count("project_revision")).toBe(0);
  });
});

describe("approval (BR-32): container, push and widening wait for the operator", () => {
  it("a push or container revision is PENDING_APPROVAL and cannot start runs until approved", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true, maxPush: "branch" }]);
    const c = await call("create_project", { project: definition({}, BRANCH) });
    expect(c.body).toMatchObject({
      id: "dyn-app",
      revision: 1,
      status: "PENDING_APPROVAL",
      approval_needed: ["push_policy", "commit_identity"],
    });
    expect(c.body.in_force_revision).toBeUndefined();
    // ADR-0068: the message names the MCP approval path and the CLI one.
    expect(c.body.message).toMatch(/decide_approval from an approver client/);
    expect(c.body.message).toMatch(/switchboard projects approve/);
    expect(JSON.stringify(c.body)).not.toMatch(/decided_by|operator user/);
    const listed = await call("list_projects");
    expect(listed.body.projects[0]).toMatchObject({ id: "dyn-app", status: "PENDING_APPROVAL", revision: 1 });

    const blocked = await call("delegate_task", delegate());
    expect(blocked.body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { project: "dyn-app", reason: "approval_required" },
    });
    expect(blocked.body.error.message).toMatch(/decide_approval from an approver client.*switchboard projects approve/);
    expect(count("run")).toBe(0);

    store.decide({ projectId: "dyn-app", decision: "APPROVED", decidedBy: "op" }); // what `projects approve` does
    const d = await call("delegate_task", delegate({ wait_seconds: 20 }));
    expect(d.isError, JSON.stringify(d.body)).toBe(false);
    const snap = JSON.parse(
      (
        db.prepare("SELECT policy_snapshot_json FROM run WHERE id = ?").get(d.body.run_id) as {
          policy_snapshot_json: string;
        }
      ).policy_snapshot_json,
    ).project;
    expect(snap).toMatchObject({ push: { policy: "branch" }, identity: { name: "A", email: "a@b.c" } });
    await pollTerminal(d.body.run_id);

    const container = await call("create_project", {
      project: definition({
        id: "box-app",
        environment: { kind: "container", image_digest: `sha256:${"b".repeat(64)}` },
      }),
    });
    expect(container.body).toMatchObject({ status: "PENDING_APPROVAL", approval_needed: ["container_environment"] });
    expect((await call("delegate_task", delegate({ project: "box-app" }))).body.error.code).toBe("PERMISSION_BLOCKED");
    store.decide({ projectId: "box-app", decision: "APPROVED", decidedBy: "op" });
    // approved, but this controller has no container environment wired (T10.1): refused before any side effect, as
    // for a configured container project
    const m10 = await call("delegate_task", delegate({ project: "box-app" }));
    expect(m10.body.error).toMatchObject({ code: "TOOL_FAILURE", details: { reason: "ENVIRONMENT_NOT_IMPLEMENTED" } });
  });

  it("turning the merge policy on waits for the operator; off does not (T15.8, FR-SUB-02)", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true }]);
    const off = await call("create_project", { project: definition({ merge_policy: { enabled: false } }) });
    expect(off.body).toMatchObject({ revision: 1, status: "ACTIVE" });
    const on = await call("update_project", {
      id: "dyn-app",
      project: definition({ merge_policy: { enabled: true, method: "rebase", required_reports: ["docs-alignment"] } }),
    });
    expect(on.body).toMatchObject({
      revision: 2,
      status: "PENDING_APPROVAL",
      approval_needed: ["merge_policy"],
      in_force_revision: 1,
    });
    expect(store.state("dyn-app")?.inForce?.definition.merge_policy).toEqual({ enabled: false });
    store.decide({ projectId: "dyn-app", decision: "APPROVED", decidedBy: "op" });
    expect(store.state("dyn-app")?.inForce?.definition.merge_policy?.enabled).toBe(true);
    const bad = await call("update_project", {
      id: "dyn-app",
      project: definition({ merge_policy: { enabled: true, required_reports: ["anything"] } }),
    });
    expect(bad.body.error.code).toBe("INVALID_REQUEST");
  });

  it("submodules: recursive alone is ACTIVE, writable_paths wait as submodule_write; list_projects reads them back (ADR-0079)", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true }]);
    const rec = await call("create_project", {
      project: definition({}, { submodules: { mode: "recursive", exclude: ["vendor/x"] } }),
    });
    expect(rec.body).toMatchObject({ revision: 1, status: "ACTIVE" });
    const listed = await call("list_projects");
    expect(listed.body.projects[0].contexts[0]).toEqual({
      id: "main",
      kind: "repository",
      primary: true,
      push_policy: "none",
      base_ref: "main",
      sign: false,
      finalize_commit: false,
      submodules: { mode: "recursive", writable_paths: [], exclude: ["vendor/x"] },
    });
    expect(JSON.stringify(listed.body)).not.toContain(repo);
    const write = await call("update_project", {
      id: "dyn-app",
      project: definition({}, { submodules: { mode: "recursive", writable_paths: ["libs/a"] } }),
    });
    expect(write.body).toMatchObject({
      revision: 2,
      status: "PENDING_APPROVAL",
      approval_needed: ["submodule_write"],
      in_force_revision: 1,
    });
    const all = await call("update_project", {
      id: "dyn-app",
      project: definition({}, { submodules: { mode: "recursive", writable_paths: ["*"] } }),
    });
    expect(all.body).toMatchObject({ status: "PENDING_APPROVAL", approval_needed: ["submodule_write"] });
    const pending = await call("list_projects");
    expect(pending.body.projects[0]).toMatchObject({ status: "ACTIVE", pending_revision: 3 });
    store.decide({ projectId: "dyn-app", decision: "APPROVED", decidedBy: "op" });
    expect(store.state("dyn-app")?.inForce?.definition.contexts[0]?.submodules?.writable_paths).toEqual(["*"]);
    const after = await call("list_projects");
    expect(after.body.projects[0].contexts[0].submodules).toEqual({
      mode: "recursive",
      writable_paths: ["*"],
      exclude: [],
    });
  });

  it("submodules: structural refusals carry their reason code and write no revision (ADR-0079 item 1)", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true }]);
    const second = { id: "docs", kind: "repository", path: repo, base_ref: "main" };
    const cases: [string, string, Json][] = [
      [
        "SUBMODULES_PRIMARY_ONLY",
        "$.project.contexts[1].submodules.mode",
        definition({
          contexts: [
            { ...(definition().contexts as Json[])[0], primary: true },
            { ...second, submodules: { mode: "recursive" } },
          ],
        }),
      ],
      [
        "SUBMODULE_PATH_UNSAFE",
        "$.project.contexts[0].submodules.exclude[0]",
        definition({}, { submodules: { mode: "recursive", exclude: ["a/../b"] } }),
      ],
      [
        "SUBMODULE_PATH_UNSAFE",
        "$.project.contexts[0].submodules.writable_paths[1]",
        definition({}, { submodules: { mode: "recursive", writable_paths: ["a", "a/.git/x"] } }),
      ],
      [
        "SUBMODULE_PATH_UNSAFE",
        "$.project.contexts[0].submodules.writable_paths",
        definition({}, { submodules: { mode: "recursive", writable_paths: ["*", "a"] } }),
      ],
      [
        "SUBMODULES_NOT_WRITABLE",
        "$.project.contexts[0].submodules.writable_paths",
        definition({}, { submodules: { mode: "off", writable_paths: ["a"] } }),
      ],
      [
        "SUBMODULES_NOT_WRITABLE",
        "$.project.contexts[0].submodules.writable_paths",
        definition({}, { writable: false, submodules: { mode: "recursive", writable_paths: ["a"] } }),
      ],
      [
        "SUBMODULE_PATH_CONFLICT",
        "$.project.contexts[0].submodules",
        definition({}, { submodules: { mode: "recursive", writable_paths: ["a"], exclude: ["a"] } }),
      ],
    ];
    for (const [reason, field, project] of cases) {
      const r = await call("create_project", { project });
      expect(r.isError, reason).toBe(true);
      expect(r.body.error.code, reason).toBe("INVALID_REQUEST");
      expect(r.body.error.details, reason).toMatchObject({ reason, field });
    }
    // Schema-level refusals (bad mode, unknown key, leading slash, duplicates, too many) are INVALID_REQUEST too.
    for (const submodules of [
      { mode: "all" },
      { mode: "recursive", extra: true },
      { mode: "recursive", exclude: ["/abs"] },
      { mode: "recursive", exclude: ["a", "a"] },
      { mode: "recursive", exclude: Array.from({ length: 513 }, (_, i) => `s/${i}`) },
    ]) {
      const r = await call("create_project", { project: definition({}, { submodules }) });
      expect(r.body.error.code).toBe("INVALID_REQUEST");
    }
    expect(count("project_revision")).toBe(0);
  });

  it("merge_policy.checks all_reported waits for the operator as merge_checks; list_projects shows checks (ADR-0079 item 7)", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true }]);
    const required = await call("create_project", { project: definition({ merge_policy: { enabled: false } }) });
    expect(required.body).toMatchObject({ status: "ACTIVE" });
    expect((await call("list_projects")).body.projects[0].merge_policy.checks).toBe("required");
    const all = await call("update_project", {
      id: "dyn-app",
      project: definition({ merge_policy: { enabled: false, checks: "all_reported" } }),
    });
    expect(all.body).toMatchObject({ status: "PENDING_APPROVAL", approval_needed: ["merge_checks"] });
    store.decide({ projectId: "dyn-app", decision: "APPROVED", decidedBy: "op" });
    expect((await call("list_projects")).body.projects[0].merge_policy.checks).toBe("all_reported");
    const bad = await call("update_project", {
      id: "dyn-app",
      project: definition({ merge_policy: { checks: "some" } }),
    });
    expect(bad.body.error.code).toBe("INVALID_REQUEST");
  });

  it("turning setup on or changing it waits for the operator; list_projects shows it (ADR-0071)", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true }]);
    await call("create_project", { project: definition() });
    const SETUP = { commands: [["corepack", "pnpm", "install", "--frozen-lockfile"]], cache: "pnpm" };
    const on = await call("update_project", { id: "dyn-app", project: definition({ setup: SETUP }) });
    expect(on.body).toMatchObject({
      revision: 2,
      status: "PENDING_APPROVAL",
      approval_needed: ["project_setup"],
      in_force_revision: 1,
    });
    // Revision 1 (no setup) stays in force until the operator decides.
    expect((await call("list_projects")).body.projects[0].setup).toBeUndefined();
    store.decide({ projectId: "dyn-app", decision: "APPROVED", decidedBy: "op" });
    expect((await call("list_projects")).body.projects[0]).toMatchObject({
      revision: 2,
      setup: {
        commands: [["corepack", "pnpm", "install", "--frozen-lockfile"]],
        network: { hosts: ["registry.npmjs.org"] },
        cache: "pnpm",
        timeout_seconds: 600,
      },
    });
    // The same setup again (defaults spelled out) is not a widening; a changed one is.
    const same = await call("update_project", {
      id: "dyn-app",
      project: definition({ setup: { ...SETUP, network: { hosts: ["registry.npmjs.org"] }, timeout_seconds: 600 } }),
    });
    expect(same.body).toMatchObject({ revision: 3, status: "ACTIVE" });
    const hosts = await call("update_project", {
      id: "dyn-app",
      project: definition({ setup: { ...SETUP, network: { hosts: ["registry.npmjs.org", "repo.yarnpkg.com"] } } }),
    });
    expect(hosts.body).toMatchObject({ status: "PENDING_APPROVAL", approval_needed: ["project_setup"] });
    // Removing it narrows: no approval.
    const off = await call("update_project", { id: "dyn-app", project: definition() });
    expect(off.body).toMatchObject({ status: "ACTIVE" });

    for (const bad of [
      { commands: [] },
      { commands: [["a"], ["b"], ["c"], ["d"], ["e"], ["f"], ["g"], ["h"], ["i"]] },
      { commands: [Array.from({ length: 33 }, () => "x")] },
      { commands: [[""]] },
      { commands: [["pnpm"]], network: { hosts: ["*.npmjs.org"] } },
      { commands: [["pnpm"]], network: { hosts: ["registry.npmjs.org:443"] } },
      { commands: [["pnpm"]], network: { hosts: ["10.0.0.1"] } },
      { commands: [["pnpm"]], network: { hosts: ["Registry.npmjs.org"] } },
      { commands: [["pnpm"]], network: { hosts: Array.from({ length: 9 }, (_, i) => `h${i}.example.org`) } },
      { commands: [["pnpm"]], cache: "yarn" },
      { commands: [["pnpm"]], timeout_seconds: 1801 },
      { commands: [["pnpm"]], env: { NPM_TOKEN: "x" } },
      { commands: [["pnpm"]], env: { CI: "true; rm -rf /" } },
      { commands: "pnpm install" },
    ]) {
      const r = await call("update_project", { id: "dyn-app", project: definition({ setup: bad }) });
      expect(r.body.error?.code, JSON.stringify(bad)).toBe("INVALID_REQUEST");
    }
    const container = await call("create_project", {
      project: definition({
        id: "box-setup",
        environment: { kind: "container", image_digest: `sha256:${"b".repeat(64)}` },
        setup: SETUP,
      }),
    });
    expect(container.body.error).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("a rejected revision stays unusable; widening an approved revision returns to pending with the old one in force", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true }]);
    await call("create_project", { project: definition({ max_trust_profile: "inspect-untrusted" }) });
    const widen = await call("update_project", {
      id: "dyn-app",
      project: definition({ max_trust_profile: "edit-untrusted" }),
    });
    expect(widen.body).toMatchObject({
      revision: 2,
      status: "PENDING_APPROVAL",
      approval_needed: ["widened_trust_ceiling"],
      in_force_revision: 1,
    });
    // revision 1 is still in force: its ceiling applies
    const high = await call("delegate_task", delegate());
    expect(high.body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { effective_max_profile: "inspect-untrusted" },
    });
    const low = await call("delegate_task", delegate({ trust_profile: "inspect-untrusted", wait_seconds: 20 }));
    expect(low.isError, JSON.stringify(low.body)).toBe(false);
    const route = (id: string) =>
      JSON.parse(
        (db.prepare("SELECT reasons_json FROM route_decision WHERE run_id = ?").get(id) as { reasons_json: string })
          .reasons_json,
      ).project.revision;
    expect(route(low.body.run_id)).toBe(1);
    expect((await call("list_projects")).body.projects[0]).toMatchObject({
      revision: 1,
      status: "ACTIVE",
      pending_revision: 2,
    });

    store.decide({ projectId: "dyn-app", decision: "REJECTED", decidedBy: "op" });
    expect((await call("delegate_task", delegate())).body.error.code).toBe("PERMISSION_BLOCKED");
    const again = await call("update_project", {
      id: "dyn-app",
      project: definition({ max_trust_profile: "edit-untrusted" }),
    });
    expect(again.body).toMatchObject({ revision: 3, status: "PENDING_APPROVAL" });
    store.decide({ projectId: "dyn-app", decision: "APPROVED", decidedBy: "op" });
    const now = await call("delegate_task", delegate({ wait_seconds: 20 }));
    expect(now.isError, JSON.stringify(now.body)).toBe(false);
    expect(route(now.body.run_id)).toBe(3);
    // narrowing needs no approval
    const narrow = await call("update_project", {
      id: "dyn-app",
      project: definition({ max_trust_profile: "inspect-untrusted" }),
    });
    expect(narrow.body).toEqual({ id: "dyn-app", revision: 4, status: "ACTIVE", in_force_revision: 4 });

    // a project created pending and then rejected has nothing in force
    await call("create_project", {
      project: definition({
        id: "other-app",
        environment: { kind: "container", image_digest: `sha256:${"c".repeat(64)}` },
      }),
    });
    store.decide({ projectId: "other-app", decision: "REJECTED", decidedBy: "op" });
    expect((await call("delegate_task", delegate({ project: "other-app" }))).body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { reason: "revision_rejected" },
    });
  });

  it("revalidates at admission and against the client's current limits", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true, maxPush: "branch" }]);
    await call("create_project", { project: definition() });
    // the repository is replaced by a symlink that leaves the allowed roots
    renameSync(repo, `${repo}-moved`);
    symlinkSync(outside, repo);
    const moved = await call("delegate_task", delegate());
    expect(moved.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "OUTSIDE_ALLOWED_ROOT" } });
    unlinkSync(repo);
    renameSync(`${repo}-moved`, repo);

    await call("create_project", { project: definition({ id: "push-app" }, BRANCH) });
    store.decide({ projectId: "push-app", decision: "APPROVED", decidedBy: "op" });
    // the same client, now configured without push and without manage_projects
    for (const s of servers.splice(0)) {
      await s.client.close();
      await s.mcp.close();
    }
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter({ script: path.join(root, "writer-cli.mjs"), timeouts: SHORT }));
    await connect(
      [{ id: "mgr", max: "edit-untrusted", manage: true, maxPush: "none" }],
      {},
      registry,
      new ArtifactStore(path.join(dataDir, "artifacts")),
    );
    expect((await call("delegate_task", delegate({ project: "push-app" }))).body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { reason: "PUSH_ABOVE_CLIENT" },
    });
    await connect(
      [{ id: "mgr", max: "edit-untrusted" }],
      {},
      registry,
      new ArtifactStore(path.join(dataDir, "artifacts")),
    );
    expect((await call("delegate_task", delegate(), 1)).body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { reason: "MANAGE_PROJECTS_OFF" },
    });
    expect((await call("list_projects", {}, 1)).body).toEqual({ projects: [] });
    expect(count("run")).toBe(0);
  });
});

describe("retrieval settings in a dynamic project (T12.1; FR-RAG-03, FR-RAG-09, FR-RAG-10)", () => {
  it("accepts narrowing rag settings and refuses the sharing flags, which only the operator may set", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true }]);
    for (const [over, ctx, field] of [
      [{ rag: { use_global: true } }, {}, "$.project.rag.use_global"],
      [{ rag: { contribute_to_global: true } }, {}, "$.project.rag.contribute_to_global"],
      [{}, { rag: { contribute_to_global: true } }, "$.project.contexts[0].rag.contribute_to_global"],
    ] as const) {
      const r = await call("create_project", { project: definition(over, ctx) });
      expect(r.body.error).toMatchObject({
        code: "PERMISSION_BLOCKED",
        details: { reason: "RAG_SHARING_OPERATOR_ONLY" },
      });
      expect(JSON.stringify(r.body.error)).toContain(field);
    }
    expect(count("project_revision")).toBe(0);
    const ok = await call("create_project", {
      project: definition(
        { rag: { mode: "off", exclude: ["vendor/**"], caps: { max_files: 10 } } },
        { rag: { mode: "off" } },
      ),
    });
    expect(ok.isError, JSON.stringify(ok.body)).toBe(false);
  });

  it("delete_project removes the project's retrieval store", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true }]);
    await call("create_project", { project: definition() });
    const s = openRagStore(dataDir, { kind: "project", projectId: "dyn-app" });
    s.close();
    const other = openRagStore(dataDir, { kind: "project", projectId: "other-app" });
    other.close();
    const dir = ragStoreDir(dataDir, { kind: "project", projectId: "dyn-app" });
    expect(existsSync(dir)).toBe(true);
    expect((await call("delete_project", { id: "dyn-app" })).body).toMatchObject({ status: "DELETED" });
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(ragStoreDir(dataDir, { kind: "project", projectId: "other-app" }))).toBe(true);
  });
});

describe("delete, history and events", () => {
  it("delete is refused while a run is active, allowed after; history stays; the id is not reused", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true }]);
    await call("create_project", { project: definition() });
    const d = await call("delegate_task", delegate({ objective: "hang" }));
    expect(d.isError, JSON.stringify(d.body)).toBe(false);
    const refused = await call("delete_project", { id: "dyn-app" });
    expect(refused.body.error).toMatchObject({ code: "INVALID_REQUEST", details: { reason: "ACTIVE_RUN" } });
    await call("cancel_run", { run_id: d.body.run_id });
    await pollTerminal(d.body.run_id);
    const ok = await call("delete_project", { id: "dyn-app" });
    expect(ok.body).toEqual({ id: "dyn-app", revision: 2, status: "DELETED" });
    expect((await call("list_projects")).body).toEqual({ projects: [] });
    expect((await call("delegate_task", delegate())).body.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect((await call("get_run", { run_id: d.body.run_id })).body.project_id).toBe("dyn-app"); // history kept
    expect((await call("create_project", { project: definition() })).body.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "ID_DELETED" },
    });
    expect((await call("delete_project", { id: "dyn-app" })).body.error.code).toBe("INVALID_REQUEST");
  });

  it("every call is one event, accepted or refused, and survives a new server on the same ledger", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true }]);
    await call("create_project", { project: definition() }); // accepted
    await call("create_project", { project: definition() }); // refused: exists
    await call("update_project", { id: "dyn-app", project: definition({ name: "Renamed" }) }); // accepted
    await call("update_project", { id: "dyn-app" }); // refused: schema
    await call("delete_project", { id: "dyn-app" }); // accepted
    expect(events().map((e) => [e.action, e.outcome])).toEqual([
      ["create_project", "ACCEPTED"],
      ["create_project", "REFUSED"],
      ["update_project", "ACCEPTED"],
      ["update_project", "REFUSED"],
      ["delete_project", "ACCEPTED"],
    ]);
    expect(events().every((e) => e.client_id === "mgr")).toBe(true);

    // restart: a new store and server on the same ledger see the same projects
    store = new DynamicProjectStore(db, { ids: createIdGenerator() });
    const registry = new AdapterRegistry();
    registry.register(new FakeAdapter({ script: path.join(root, "writer-cli.mjs"), timeouts: SHORT }));
    await connect(
      [{ id: "mgr", max: "edit-untrusted", manage: true }],
      {},
      registry,
      new ArtifactStore(path.join(dataDir, "artifacts")),
    );
    await call("create_project", { project: definition({ id: "next-app" }) }, 1);
    expect((await call("list_projects", {}, 1)).body.projects.map((p: Json) => p.id)).toEqual(["next-app"]);
    expect(store.state("dyn-app")?.deleted).toBe(true);
  });
});

describe("pending revision announcement (T14.9, FR-CTL-10, ADR-0048)", () => {
  it("announces push_revision and dynamic_project once each; silent for ACTIVE writes", async () => {
    const announced: PendingRevisionAnnouncement[] = [];
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true, maxPush: "branch" }], {
      announcePendingRevision: (a) => announced.push(a),
    });
    const push = await call("create_project", { project: definition({}, BRANCH) });
    expect(push.body).toMatchObject({ id: "dyn-app", revision: 1, status: "PENDING_APPROVAL" });
    const box = await call("create_project", {
      project: definition({
        id: "box-app",
        environment: { kind: "container", image_digest: `sha256:${"b".repeat(64)}` },
      }),
    });
    expect(box.body).toMatchObject({ id: "box-app", revision: 1, status: "PENDING_APPROVAL" });
    const active = await call("create_project", { project: definition({ id: "plain-app" }) });
    expect(active.body).toMatchObject({ id: "plain-app", revision: 1, status: "ACTIVE" });
    // A refused write announces nothing.
    const refused = await call("create_project", { project: definition({ id: "plain-app" }) });
    expect(refused.isError).toBe(true);
    expect(announced).toEqual([
      { projectId: "dyn-app", revision: 1, kind: "push_revision" },
      { projectId: "box-app", revision: 1, kind: "dynamic_project" },
    ]);
  });

  it("a failing announcement never undoes the revision write", async () => {
    await setup([{ id: "mgr", max: "edit-untrusted", manage: true, maxPush: "branch" }], {
      announcePendingRevision: () => {
        throw new Error("observer boom");
      },
    });
    const c = await call("create_project", { project: definition({}, BRANCH) });
    expect(c.body).toMatchObject({ id: "dyn-app", revision: 1, status: "PENDING_APPROVAL" });
    expect(store.state("dyn-app")?.pending?.revision).toBe(1);
  });
});
