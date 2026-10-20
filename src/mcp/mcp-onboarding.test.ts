/**
 * MCP-only project onboarding (ADR-0068; FR-PRJ-10 note 2026-10-20, FR-CTL-08, FR-CTL-13, FR-POL-10). A scripted MCP
 * client talks to the server through the SDK's in-memory transport, against the fake adapter, real temporary Git
 * repositories and a local bare "remote" that stands in for GitHub: the injected Git runner rewrites the HTTPS URL to
 * it and answers `fetch` itself. No provider CLI, login, credential or network.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import type { ProjectSourcesSettings, ResolvedMcpClient, ResolvedProject } from "../config/index.js";
import type { DecisionAnnouncement } from "../control/decisions.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { NOT_AN_ALLOWED_WORKSPACE, RunLifecycle } from "../lifecycle/index.js";
import { DynamicProjectStore, type GitRunner } from "../projects/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { createSwitchboardServer, type SwitchboardMcpServer } from "./index.js";

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
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (a.includes("--version")) process.stdout.write("fake-cli 1.0.0\\n");
else if (a.includes("--auth-status")) process.stdout.write('{"authenticated":true}\\n');
else { emit({ type: "session", session_id: "s-1" }); emit({ type: "result", ok: true, summary: "done" }); }
`;

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

const REPO_URL = "https://github.com/Digifender-LLC/whumpo-fixture";
const PRIVILEGED_SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "allowlist", allowlist: [["npm", "test"]] },
  network: { mode: "allowlist", hosts: ["example.test"] },
  repository_config: { mode: "disabled" },
  bypass: false,
};

/** grok-bot as prod configures it: manages projects and approves its own project revisions, never privileged runs. */
const CLIENTS: ResolvedMcpClient[] = [
  {
    id: "grok-bot",
    maxTrustProfile: "edit-untrusted",
    manageProjects: true,
    maxPushPolicy: "branch",
    approvalProxy: true,
    approvalProxyTargets: ["grok-bot", "root"],
    approvalProxyKinds: ["dynamic_project", "push_revision"],
  },
  { id: "root", maxTrustProfile: "privileged", projects: ["conf-app"] },
  // a proxy with the ADR-0047 default (every kind)
  { id: "full", maxTrustProfile: "inspect-untrusted", approvalProxy: true, approvalProxyTargets: ["root"] },
  { id: "other", maxTrustProfile: "edit-untrusted", manageProjects: true },
];

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON checked by the published output schemas
type Json = Record<string, any>;

let root: string;
let repo: string;
let outside: string;
let bare: string;
let cloneRoot: string;
let db: Database.Database;
let ledger: Ledger;
let store: DynamicProjectStore;
let lifecycle: RunLifecycle;
let gitCalls: string[][];
let announced: DecisionAnnouncement[];
const servers = new Map<string, { mcp: SwitchboardMcpServer; client: Client }>();

/** Maps the fixture's HTTPS URL to the local bare repository; `fetch` is answered here. No network. */
const localGit =
  (remotes: ReadonlyMap<string, string>): GitRunner =>
  async (args, opts) => {
    gitCalls.push([...args]);
    if (args.includes("fetch")) return { ok: true, stdout: "" };
    const a = [...args];
    const at = a.indexOf("--");
    const url = a.includes("clone") ? (a[at + 1] as string) : undefined;
    if (url !== undefined) {
      const local = remotes.get(url);
      if (local === undefined) return { ok: false, stdout: "" };
      a[at + 1] = local;
    }
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
      : (opts.sources ?? { cloneRoot, allowedHosts: ["github.com"], allowedOwners: ["digifender-llc"] });
  const configured: ResolvedProject = {
    id: "conf-app",
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
  };
  const config = {
    allowedRoots: [root],
    dataDir: path.join(root, "data"),
    projects: [configured],
    mcpClients: new Map(CLIENTS.map((c) => [c.id, c])),
    ...(sources !== undefined ? { projectSources: sources } : {}),
  };
  for (const c of CLIENTS) {
    const mcp = createSwitchboardServer({
      lifecycle,
      ledger,
      artifacts,
      registry,
      config,
      clientId: c.id,
      projectStore: store,
      projectGit: localGit(new Map([[`${REPO_URL}.git`, bare]])),
      decisions: { announce: (a) => announced.push(a) },
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

async function pollTerminal(clientId: string, runId: string): Promise<Json> {
  const end = Date.now() + 20_000;
  for (;;) {
    const r = await call(clientId, "get_run", { run_id: runId });
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(r.body.status)) return r.body;
    if (Date.now() > end) throw new Error(`run ${runId} did not finish: ${r.body.status}`);
    await new Promise((res) => setTimeout(res, 20));
  }
}

const cloned = (over: Json = {}, ctx: Json = {}): Json => ({
  id: "whumpo",
  name: "Whumpo website",
  contexts: [
    {
      id: "main",
      kind: "repository",
      clone_url: `${REPO_URL}.git`,
      base_ref: "main",
      push: { policy: "branch", remote: "origin", branch_prefix: "sb/" },
      identity: { name: "Switchboard", email: "sb@example.test" },
      ...ctx,
    },
  ],
  ...over,
});
const events = () =>
  db.prepare("SELECT action, outcome, code, reason, payload_json FROM project_event ORDER BY ts, id").all() as {
    action: string;
    outcome: string;
    code: string | null;
    reason: string | null;
    payload_json: string;
  }[];
const decision = (over: Json = {}): Json => ({
  project_id: "whumpo",
  question: "Please let Switchboard clone this repository for the website work.",
  options: [
    { label: "Allow", action: "none" },
    { label: "Refuse", action: "cancel" },
  ],
  recommended_option: 1,
  onboarding: { repository_url: REPO_URL },
  ...over,
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-onboard-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  bare = path.join(root, "remote.git");
  g(root, "clone", "-q", "--bare", repo, bare);
  cloneRoot = path.join(root, "clones");
  mkdirSync(cloneRoot);
  outside = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-onboard-out-")));
  g(outside, "init", "-q", "-b", "main");
  mkdirSync(path.join(root, "data"));
  db = openLedger(path.join(root, "data"));
  ledger = createLedger(db, { ids: createIdGenerator() });
  store = new DynamicProjectStore(db, { ids: createIdGenerator() });
  gitCalls = [];
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
  rmSync(outside, { recursive: true, force: true });
});

describe("MCP-only onboarding end to end (ADR-0068)", () => {
  it("clone_url -> PENDING_APPROVAL -> list_pending_approvals -> decide_approval -> ACTIVE -> delegate_task", async () => {
    await setup();
    const names = (await servers.get("grok-bot")?.client.listTools())?.tools.map((t) => t.name) ?? [];
    // orchestrator profile with approval_proxy: the proxy tools are listed next to the project tools
    expect(names).toEqual(
      expect.arrayContaining([
        "create_project",
        "list_pending_approvals",
        "decide_approval",
        "request_decision",
        "decide",
      ]),
    );

    const created = await call("grok-bot", "create_project", { project: cloned() });
    expect(created.isError, JSON.stringify(created.body)).toBe(false);
    expect(created.body).toMatchObject({
      id: "whumpo",
      revision: 1,
      status: "PENDING_APPROVAL",
      approval_needed: ["push_policy", "commit_identity"],
    });
    expect(created.body.message).toMatch(/decide_approval from an approver client.*switchboard projects approve/);
    const target = path.join(cloneRoot, "github.com", "digifender-llc", "whumpo-fixture");
    expect(existsSync(path.join(target, "README.md"))).toBe(true);
    const stored = store.state("whumpo")?.latest.definition.contexts[0];
    expect(stored).toMatchObject({ path: target, clone_url: REPO_URL });
    const accepted = events().filter((e) => e.outcome === "ACCEPTED");
    expect(JSON.parse(accepted[0]?.payload_json ?? "{}")).toMatchObject({
      clone: "cloned",
      clone_sources: ["github.com/digifender-llc/whumpo-fixture"],
    });

    const listed = await call("grok-bot", "list_projects");
    const entry = listed.body.projects.find((p: Json) => p.id === "whumpo");
    expect(entry).toMatchObject({ status: "PENDING_APPROVAL", source: "dynamic" });
    expect(entry.contexts[0]).toMatchObject({ id: "main", push_policy: "branch", source_url: REPO_URL });
    expect(JSON.stringify(listed.body)).not.toContain(cloneRoot);

    const blocked = await call("grok-bot", "delegate_task", {
      objective: "update the home page",
      project: "whumpo",
      trust_profile: "edit-untrusted",
    });
    expect(blocked.body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { project: "whumpo", reason: "approval_required" },
    });
    expect(blocked.body.error.message).toMatch(/decide_approval from an approver client/);

    const pending = await call("grok-bot", "list_pending_approvals", {});
    expect(pending.body.approvals).toHaveLength(1);
    const item = pending.body.approvals[0];
    expect(item).toMatchObject({
      kind: "push_revision",
      project_id: "whumpo",
      revision: 1,
      target_client_id: "grok-bot",
    });
    const decided = await call("grok-bot", "decide_approval", {
      approval_id: item.approval_id,
      approval_digest: item.approval_digest,
      decision: "approve",
    });
    expect(decided.body).toEqual({ approval_id: item.approval_id, status: "APPROVED" });
    expect(store.state("whumpo")?.latest.decision).toMatchObject({
      decision: "APPROVED",
      decidedBy: "mcp_proxy:grok-bot",
    });

    const active = await call("grok-bot", "list_projects");
    expect(active.body.projects.find((p: Json) => p.id === "whumpo")).toMatchObject({ status: "ACTIVE", revision: 1 });

    const run = await call("grok-bot", "delegate_task", {
      objective: "update the home page",
      project: "whumpo",
      trust_profile: "edit-untrusted",
      wait_seconds: 20,
    });
    expect(run.isError, JSON.stringify(run.body)).toBe(false);
    expect(run.body.project_id).toBe("whumpo");
    expect((await pollTerminal("grok-bot", run.body.run_id)).status).toBe("SUCCEEDED");
  });

  it("a second create_project for the same repository reuses the clone; a different case is the same repository", async () => {
    await setup();
    expect((await call("grok-bot", "create_project", { project: cloned() })).isError).toBe(false);
    const again = await call("grok-bot", "create_project", {
      project: cloned({ id: "whumpo-two" }, { clone_url: "https://github.com/digifender-llc/WHUMPO-fixture/" }),
    });
    expect(again.isError, JSON.stringify(again.body)).toBe(false);
    expect(gitCalls.filter((c) => c.includes("clone"))).toHaveLength(1);
    expect(gitCalls.some((c) => c.includes("fetch"))).toBe(true);
    const last = events().at(-1);
    expect(JSON.parse(last?.payload_json ?? "{}")).toMatchObject({ clone: "reused" });
  });

  it("a proxy limited to project kinds cannot list or decide a privileged approval; the default proxy can", async () => {
    await setup();
    const d = await call("root", "delegate_task", {
      objective: "Privileged change",
      workspace_path: repo,
      trust_profile: "privileged",
      privileged_scope: PRIVILEGED_SCOPE,
    });
    expect(d.body.status).toBe("AWAITING_APPROVAL");

    const full = await call("full", "list_pending_approvals", {});
    const item = full.body.approvals.find((a: Json) => a.kind === "privileged_scope");
    expect(item).toMatchObject({ run_id: d.body.run_id, target_client_id: "root" });

    const limited = await call("grok-bot", "list_pending_approvals", {});
    expect(limited.body.approvals.filter((a: Json) => a.kind === "privileged_scope")).toEqual([]);
    const refused = await call("grok-bot", "decide_approval", {
      approval_id: item.approval_id,
      approval_digest: item.approval_digest,
      decision: "approve",
    });
    const unknown = await call("grok-bot", "decide_approval", {
      approval_id: "apv_01HZZZZZZZZZZZZZZZZZZZZZZZ",
      approval_digest: item.approval_digest,
      decision: "approve",
    });
    expect(refused.body.error.code).toBe("INVALID_REQUEST");
    expect(refused.body).toEqual(unknown.body); // one refusal: no oracle for approvals of another kind
    expect(ledger.getApproval(item.approval_id)?.status).toBe("PENDING");
  });

  it("refusals are closed codes with fixed text, never Git output, and every attempt is audited", async () => {
    await setup();
    const create = (ctx: Json, id = "whumpo") => call("grok-bot", "create_project", { project: cloned({ id }, ctx) });

    const bad = await create({ clone_url: "https://user:secret-token@github.com/Digifender-LLC/whumpo-fixture" });
    expect(bad.body.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "CLONE_URL_INVALID", field: "$.project.contexts[0].clone_url" },
    });
    expect(JSON.stringify(bad.body)).not.toContain("secret-token");

    const owner = await create({ clone_url: "https://github.com/someone-else/repo" });
    expect(owner.body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { reason: "CLONE_SOURCE_NOT_ALLOWED" },
    });

    const missing = await create({ clone_url: "https://github.com/Digifender-LLC/not-there" });
    expect(missing.body.error).toMatchObject({
      code: "TOOL_FAILURE",
      retryable: true,
      message:
        "repository could not be cloned with the server's git credentials; the operator may need to grant access",
      details: { reason: "CLONE_FAILED" },
    });
    expect(existsSync(path.join(cloneRoot, "github.com", "digifender-llc", "not-there"))).toBe(false);

    const both = await create({ path: repo });
    expect(both.body.error.code).toBe("INVALID_REQUEST");
    const neither = await call("grok-bot", "create_project", {
      project: { id: "whumpo", name: "W", contexts: [{ id: "main", kind: "repository", base_ref: "main" }] },
    });
    expect(neither.body.error.code).toBe("INVALID_REQUEST");

    // an existing directory at the target that is not this repository is never touched
    const target = path.join(cloneRoot, "github.com", "digifender-llc", "whumpo-fixture");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "keep.txt"), "mine\n");
    const conflict = await create({});
    expect(conflict.body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { reason: "CLONE_TARGET_CONFLICT" },
    });
    expect(existsSync(path.join(target, "keep.txt"))).toBe(true);

    // a refused definition never clones: the ceiling check runs before the clone
    rmSync(target, { recursive: true });
    const ceiling = await create({}, "whumpo");
    expect(ceiling.isError).toBe(false); // sanity: the same definition is accepted once the target is free
    const before = gitCalls.filter((c) => c.includes("clone")).length;
    const tooHigh = await call("grok-bot", "create_project", {
      project: cloned(
        { id: "whumpo-priv", max_trust_profile: "privileged" },
        { clone_url: "https://github.com/Digifender-LLC/third" },
      ),
    });
    expect(tooHigh.body.error.code).toBe("PERMISSION_BLOCKED");
    expect(gitCalls.filter((c) => c.includes("clone")).length).toBe(before);

    const codes = events().map((e) => [e.outcome, e.reason, JSON.parse(e.payload_json).clone]);
    expect(codes).toEqual([
      ["REFUSED", "CLONE_URL_INVALID", "refused"],
      ["REFUSED", "CLONE_SOURCE_NOT_ALLOWED", "refused"],
      ["REFUSED", "CLONE_FAILED", "failed"],
      ["REFUSED", "INVALID_ARGUMENTS", undefined],
      ["REFUSED", "INVALID_ARGUMENTS", undefined],
      ["REFUSED", "CLONE_TARGET_CONFLICT", "refused"],
      ["ACCEPTED", "PENDING_APPROVAL", "cloned"],
      ["REFUSED", "CEILING_ABOVE_CLIENT", undefined],
    ]);
    for (const e of events()) expect(e.payload_json).not.toMatch(/secret-token|https:|\/tmp\//);
  });

  it("without project_sources every clone_url is refused (fail closed)", async () => {
    await setup({ sources: null });
    const r = await call("grok-bot", "create_project", { project: cloned() });
    expect(r.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "CLONE_NOT_CONFIGURED" } });
    expect(gitCalls).toEqual([]);
    expect(existsSync(path.join(cloneRoot, "github.com"))).toBe(false);
  });
});

describe("request_decision onboarding (ADR-0068)", () => {
  it("a client asks about a project that does not exist yet; it sees the decision; sinks hear the project only", async () => {
    await setup();
    const r = await call("grok-bot", "request_decision", decision());
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(r.body).toMatchObject({ project_id: "whumpo", state: "open", onboarding: { repository_url: REPO_URL } });
    expect(announced).toEqual([{ projectId: "whumpo" }]);

    const listed = await call("grok-bot", "list_decisions", { project_id: "whumpo" });
    expect(listed.body.decisions).toHaveLength(1);
    expect(listed.body.decisions[0]).toMatchObject({
      requester_client_id: "grok-bot",
      onboarding: { repository_url: REPO_URL },
      question: { label: "untrusted_client_text" },
    });
    const digest = await call("grok-bot", "get_digest", {});
    const project = digest.body.projects.find((p: Json) => p.project_id === "whumpo");
    expect(project?.open_decisions).toHaveLength(1);
    // another client sees nothing of it
    expect((await call("other", "list_decisions", {})).body.decisions).toEqual([]);

    // the URL is normalised: .git and a trailing slash dropped, the host lower-cased
    const n = await call(
      "grok-bot",
      "request_decision",
      decision({
        project_id: "whumpo-b",
        onboarding: { repository_url: "https://GitHub.com/Digifender-LLC/whumpo-fixture.git/" },
      }),
    );
    expect(n.body.onboarding).toEqual({ repository_url: REPO_URL });
  });

  it("refuses a configured id or another client's project with one message, and bad URLs and combinations", async () => {
    await setup();
    expect(
      (
        await call("other", "create_project", {
          project: {
            ...cloned({ id: "theirs" }),
            contexts: [{ id: "main", kind: "repository", path: repo, base_ref: "main" }],
          },
        })
      ).isError,
    ).toBe(false);
    const conf = await call("grok-bot", "request_decision", decision({ project_id: "conf-app" }));
    const theirs = await call("grok-bot", "request_decision", decision({ project_id: "theirs" }));
    expect(conf.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "NOT_MANAGEABLE" } });
    expect(theirs.body.error.message.replace("theirs", "X")).toBe(conf.body.error.message.replace("conf-app", "X"));

    const url = await call(
      "grok-bot",
      "request_decision",
      decision({ onboarding: { repository_url: "git@github.com:a/b" } }),
    );
    expect(url.body.error).toMatchObject({ code: "INVALID_REQUEST", details: { reason: "CLONE_URL_INVALID" } });
    const owner = await call(
      "grok-bot",
      "request_decision",
      decision({ onboarding: { repository_url: "https://github.com/someone-else/x" } }),
    );
    expect(owner.body.error).toMatchObject({
      code: "PERMISSION_BLOCKED",
      details: { reason: "CLONE_SOURCE_NOT_ALLOWED" },
    });
    const combined = await call("grok-bot", "request_decision", decision({ enqueue: [] }));
    expect(combined.body.error.code).toBe("INVALID_REQUEST");
    const badId = await call("grok-bot", "request_decision", decision({ project_id: "Bad_Id" }));
    expect(badId.body.error.code).toBe("INVALID_REQUEST");
    // without onboarding, an unknown project is still refused as before
    const plain = await call("grok-bot", "request_decision", decision({ onboarding: undefined, project_id: "nope" }));
    expect(plain.body.error.code).toBe("INVALID_REQUEST");
    expect(ledger.listDecisions({ requesterClientIds: ["grok-bot"], limit: 10 })).toEqual([]);
  });

  it("allows the client's own pending project, with or without onboarding, but not an approved one", async () => {
    await setup();
    expect((await call("grok-bot", "create_project", { project: cloned() })).body.status).toBe("PENDING_APPROVAL");
    expect((await call("grok-bot", "request_decision", decision())).isError).toBe(false);
    const without = await call("grok-bot", "request_decision", decision({ onboarding: undefined }));
    expect(without.isError, JSON.stringify(without.body)).toBe(false);
    store.decide({ projectId: "whumpo", decision: "APPROVED", decidedBy: "op" });
    const approved = await call("grok-bot", "request_decision", decision());
    expect(approved.body.error).toMatchObject({ code: "INVALID_REQUEST", details: { reason: "PROJECT_EXISTS" } });
  });

  it("checks the URL syntax only when project_sources is not configured", async () => {
    await setup({ sources: null });
    const r = await call(
      "grok-bot",
      "request_decision",
      decision({ onboarding: { repository_url: "https://github.com/someone-else/x" } }),
    );
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(r.body.onboarding).toEqual({ repository_url: "https://github.com/someone-else/x" });
  });
});

describe("workspace_path has no existence oracle (ADR-0068 item 5, FR-POL-10)", () => {
  it("missing and existing paths outside the roots, and refused paths inside, give byte-identical errors", async () => {
    await setup();
    const ask = (p: string, trust = "edit-untrusted") =>
      call("root", "delegate_task", { objective: "probe", workspace_path: p, trust_profile: trust });
    const existing = await ask(outside);
    const missing = await ask(path.join(outside, "no", "such", "dir"));
    const etc = await ask("/etc");
    const dotdot = await ask(path.join(root, "..", path.basename(outside)));
    // `link/..` resolves through the link (to the parent of `outside`), never lexically back into the root
    symlinkSync(outside, path.join(root, "link"));
    const viaLink = await ask(`${root}/link/..`, "inspect-untrusted");
    const inMissing = await ask(path.join(root, "missing"));
    mkdirSync(path.join(root, "plain"));
    const notRepo = await ask(path.join(root, "plain"));
    writeFileSync(path.join(root, "file.txt"), "x\n");
    const file = await ask(path.join(root, "file.txt"), "inspect-untrusted");
    for (const r of [existing, missing, etc, dotdot, viaLink, inMissing, notRepo, file]) {
      expect(r.isError).toBe(true);
      expect(r.body).toEqual(existing.body);
    }
    expect(existing.body.error).toMatchObject({ code: "INVALID_REQUEST", message: NOT_AN_ALLOWED_WORKSPACE });
    // a real workspace still works
    const ok = await ask(repo);
    expect(ok.isError, JSON.stringify(ok.body)).toBe(false);
    await pollTerminal("root", ok.body.run_id);
  });
});
