/**
 * ADR-0087 item 8: `request_project_source` and the `project_source` approval kind. A scripted MCP client talks to the
 * server through the SDK's in-memory transport against the fake adapter, a local bare repository standing in for the
 * remote (the injected Git runner rewrites the HTTPS URL to it) and a real ledger. No provider CLI, login or network.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import type { ProjectSourcesSettings, ResolvedMcpClient } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { DynamicProjectStore, type GitRunner, ProjectSourceGrantStore } from "../projects/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { createSwitchboardServer, type SwitchboardMcpServer } from "./index.js";
import type { PendingSourceAnnouncement } from "./project-tools.js";

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

const CLI = `
const a = process.argv.slice(2);
if (a.includes("--version")) process.stdout.write("fake-cli 1.0.0\\n");
else if (a.includes("--auth-status")) process.stdout.write('{"authenticated":true}\\n');
else process.stdout.write(JSON.stringify({ type: "result", ok: true, summary: "done" }) + "\\n");
`;

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

const NEW_URL = "https://github.com/NewCo/fixture";

const CLIENTS: ResolvedMcpClient[] = [
  { id: "mgr", maxTrustProfile: "edit-untrusted", manageProjects: true },
  // an approver that lists the opt-in kind explicitly
  {
    id: "approver",
    maxTrustProfile: "inspect-untrusted",
    approvalProxy: true,
    approvalProxyTargets: ["mgr"],
    approvalProxyKinds: ["project_source"],
  },
  // an approver with the ADR-0047 default kinds: project_source is not among them
  {
    id: "default-approver",
    maxTrustProfile: "inspect-untrusted",
    approvalProxy: true,
    approvalProxyTargets: ["mgr"],
  },
  // lists the kind but is not a proxy for `mgr`
  {
    id: "other-approver",
    maxTrustProfile: "inspect-untrusted",
    approvalProxy: true,
    approvalProxyTargets: ["approver"],
    approvalProxyKinds: ["project_source"],
  },
  { id: "plain", maxTrustProfile: "edit-untrusted" },
];

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON checked by the published output schemas
type Json = Record<string, any>;

let root: string;
let bare: string;
let cloneRoot: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle;
let grants: ProjectSourceGrantStore;
let announced: PendingSourceAnnouncement[];
const servers = new Map<string, { mcp: SwitchboardMcpServer; client: Client }>();

const localGit: GitRunner = async (args, opts) => {
  if (args.includes("fetch")) return { ok: true, stdout: "" };
  const a = [...args];
  const at = a.indexOf("--");
  const url = a.includes("clone") ? (a[at + 1] as string) : undefined;
  if (url !== undefined) a[at + 1] = bare;
  try {
    const stdout = execFileSync("git", a, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: GIT_ENV,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (url !== undefined) g(a[a.length - 1] as string, "remote", "set-url", "origin", url);
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
};

async function setup(opts: { sources?: ProjectSourcesSettings | null } = {}) {
  const ids = createIdGenerator();
  const artifacts = new ArtifactStore(path.join(root, "data", "artifacts"));
  const workspace = new WorkspaceManager({
    db,
    artifacts,
    dataDir: path.join(root, "data"),
    allowedRoots: [root],
    ids,
  });
  const script = path.join(root, "cli.mjs");
  writeFileSync(script, CLI);
  const registry = new AdapterRegistry().register(
    new FakeAdapter({ script, timeouts: { wallClockMs: 15_000, idleMs: 5_000, killGraceMs: 300 } }),
  );
  lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots: [root],
    globalConcurrency: 2,
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
  const sources =
    opts.sources === null
      ? undefined
      : (opts.sources ?? { cloneRoot, allowedHosts: ["github.com"], allowedOwners: ["acme"] });
  grants = new ProjectSourceGrantStore(db, { ids, ...(sources !== undefined ? { config: sources } : {}) });
  const config = {
    allowedRoots: [root],
    dataDir: path.join(root, "data"),
    projects: [],
    mcpClients: new Map(CLIENTS.map((c) => [c.id, c])),
    ...(sources !== undefined ? { projectSources: sources } : {}),
  };
  const projectStore = new DynamicProjectStore(db, { ids });
  for (const c of CLIENTS) {
    const mcp = createSwitchboardServer({
      lifecycle,
      ledger,
      artifacts,
      registry,
      config,
      clientId: c.id,
      projectStore,
      projectGit: localGit,
      projectSourceGrants: grants,
      announcePendingSource: (a) => announced.push(a),
    });
    const client = new Client({ name: c.id, version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcp.server.connect(st);
    await client.connect(ct);
    await client.listTools(); // caches the output schemas: every result below is schema-checked by the SDK
    servers.set(c.id, { mcp, client });
  }
}

async function call(clientId: string, name: string, args: Json = {}): Promise<{ isError: boolean; body: Json }> {
  const client = servers.get(clientId)?.client;
  if (!client) throw new Error(`no client ${clientId}`);
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
  return { isError: res.isError === true, body: JSON.parse(text) as Json };
}
const toolNames = async (clientId: string) =>
  ((await servers.get(clientId)?.client.listTools())?.tools ?? []).map((t) => t.name);

const project = (): Json => ({
  id: "newco-app",
  name: "NewCo app",
  contexts: [{ id: "main", kind: "repository", clone_url: `${NEW_URL}.git`, base_ref: "main" }],
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-srcreq-")));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  bare = path.join(root, "remote.git");
  g(root, "clone", "-q", "--bare", repo, bare);
  cloneRoot = path.join(root, "clones");
  mkdirSync(cloneRoot);
  mkdirSync(path.join(root, "data"));
  db = openLedger(path.join(root, "data"));
  ledger = createLedger(db, { ids: createIdGenerator() });
  announced = [];
});

afterEach(async () => {
  await lifecycle.shutdown();
  for (const s of servers.values()) {
    await s.client.close();
    await s.mcp.close();
  }
  servers.clear();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("request_project_source (ADR-0087 item 8)", () => {
  it("request -> list_pending_approvals -> decide_approval -> create_project passes the source check, no restart", async () => {
    await setup();
    const before = await call("mgr", "create_project", { project: project() });
    expect(before.isError).toBe(true);
    expect(before.body.error.details.reason).toBe("CLONE_SOURCE_NOT_ALLOWED");

    const req = await call("mgr", "request_project_source", { owner: "NewCo" });
    expect(req.isError, JSON.stringify(req.body)).toBe(false);
    expect(req.body).toMatchObject({ host: "github.com", owner: "newco", status: "PENDING_APPROVAL" });
    expect(req.body.request_id).toMatch(/^psr_/);
    expect(announced).toEqual([{ requestId: req.body.request_id, kind: "project_source" }]);

    // idempotent: the same pending request, announced once
    const again = await call("mgr", "request_project_source", { owner: "newco", host: "github.com" });
    expect(again.body).toMatchObject({ request_id: req.body.request_id, status: "PENDING_APPROVAL" });
    expect(announced).toHaveLength(1);

    const listed = await call("approver", "list_pending_approvals");
    expect(listed.body.approvals).toEqual([
      expect.objectContaining({
        approval_id: req.body.request_id,
        kind: "project_source",
        target_client_id: "mgr",
        scope_summary: "add owner newco on github.com to project_sources",
        approval_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    const stillBlocked = await call("mgr", "create_project", { project: project() });
    expect(stillBlocked.body.error.details.reason).toBe("CLONE_SOURCE_NOT_ALLOWED");

    const item = listed.body.approvals[0];
    const decided = await call("approver", "decide_approval", {
      approval_id: item.approval_id,
      approval_digest: item.approval_digest,
      decision: "approve",
    });
    expect(decided.body).toEqual({ approval_id: item.approval_id, status: "APPROVED" });
    expect(grants.get(item.approval_id)).toMatchObject({ status: "APPROVED", decided_by: "mcp_proxy:approver" });

    const after = await call("mgr", "create_project", { project: project() });
    expect(after.isError, JSON.stringify(after.body)).toBe(false);
    expect(after.body.id).toBe("newco-app");
    expect((await call("approver", "list_pending_approvals")).body.approvals).toEqual([]);

    // a repeat request for an approved owner returns the approved request
    const repeat = await call("mgr", "request_project_source", { owner: "newco" });
    expect(repeat.body).toMatchObject({ request_id: req.body.request_id, status: "APPROVED" });
  });

  it("a denied request leaves the owner refused, and a decided request cannot be decided again", async () => {
    await setup();
    const req = await call("mgr", "request_project_source", { owner: "newco" });
    const [item] = (await call("approver", "list_pending_approvals")).body.approvals;
    const denied = await call("approver", "decide_approval", {
      approval_id: item.approval_id,
      approval_digest: item.approval_digest,
      decision: "deny",
    });
    expect(denied.body.status).toBe("DENIED");
    expect(grants.get(req.body.request_id)?.status).toBe("REJECTED");
    const created = await call("mgr", "create_project", { project: project() });
    expect(created.body.error.details.reason).toBe("CLONE_SOURCE_NOT_ALLOWED");
    const second = await call("approver", "decide_approval", {
      approval_id: item.approval_id,
      approval_digest: item.approval_digest,
      decision: "approve",
    });
    expect(second.isError).toBe(true);
    expect(second.body.error.code).toBe("INVALID_REQUEST");
  });

  it("an approver without project_source in approval_proxy_kinds neither sees nor decides it", async () => {
    await setup();
    const req = await call("mgr", "request_project_source", { owner: "newco" });
    expect((await call("default-approver", "list_pending_approvals")).body.approvals).toEqual([]);
    const [item] = (await call("approver", "list_pending_approvals")).body.approvals;
    const refused = await call("default-approver", "decide_approval", {
      approval_id: item.approval_id,
      approval_digest: item.approval_digest,
      decision: "approve",
    });
    expect(refused.isError).toBe(true);
    // not a target of this approver either
    expect((await call("other-approver", "list_pending_approvals")).body.approvals).toEqual([]);
    const notTarget = await call("other-approver", "decide_approval", {
      approval_id: item.approval_id,
      approval_digest: item.approval_digest,
      decision: "approve",
    });
    expect(notTarget.isError).toBe(true);
    expect(grants.get(req.body.request_id)?.status).toBe("PENDING");
  });

  it("is offered only to a manage_projects client, and only with project_sources configured", async () => {
    await setup();
    expect(await toolNames("mgr")).toContain("request_project_source");
    for (const id of ["plain", "approver", "default-approver"]) {
      expect(await toolNames(id), id).not.toContain("request_project_source");
    }
    const refused = await call("plain", "request_project_source", { owner: "newco" });
    expect(refused.isError).toBe(true);
    expect(refused.body.error.message).toMatch(/unknown tool/);
  });

  it("does not exist on a server without project_sources", async () => {
    await setup({ sources: null });
    expect(await toolNames("mgr")).not.toContain("request_project_source");
    const r = await call("mgr", "request_project_source", { owner: "newco" });
    expect(r.isError).toBe(true);
    expect(r.body.error.message).toMatch(/unknown tool/);
  });

  it("answers with closed reason codes", async () => {
    await setup();
    const badHost = await call("mgr", "request_project_source", { owner: "newco", host: "gitlab.com" });
    expect(badHost.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "HOST_NOT_ALLOWED" } });
    for (const owner of ["..", ".", "a/b", "-x"]) {
      const r = await call("mgr", "request_project_source", { owner });
      expect(r.body.error, owner).toMatchObject({ code: "INVALID_REQUEST", details: { reason: "OWNER_INVALID" } });
    }
    const known = await call("mgr", "request_project_source", { owner: "ACME" });
    expect(known.isError).toBe(false);
    expect(known.body).toMatchObject({ owner: "acme", status: "ALREADY_ALLOWED" });
    expect(known.body.request_id).toBeUndefined();
    expect(grants.pending()).toEqual([]);
    expect(announced).toEqual([]);
  });
});
