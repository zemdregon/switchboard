/**
 * Queued `privileged` admission parity with MCP `delegate_task` (FR-QUE-01, LLD §18.4: "the same pipeline"), and the
 * secret-free reason recorded on `admission_failed`. Regression for prod 2026-10-20: every queued item with
 * `trust_profile: privileged` failed `TOOL_FAILURE` because queued eligibility resolved the bare name `privileged`
 * (production's resolver always throws for it) instead of compiling against the request's scope, as delegate_task does.
 * The lifecycle here uses that production resolver for `privileged`; no provider CLI is installed or called.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import type { ResolvedMcpClient, ResolvedProject } from "../config/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { createSwitchboardServer, type SwitchboardMcpServer } from "../mcp/index.js";
import { resolveProfile } from "../policy/index.js";
import type { Json } from "../routing/fixtures/harness.js";
import { WorkspaceManager } from "../workspace/index.js";
import { type AdmitWorkDeps, admitWorkItemRequest } from "./admission.js";
import { runProjectWorkQueueTick } from "./scheduler.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};

/** Stub snapshots for the four plain profiles; `privileged` goes to the production resolver, which always throws. */
const profileFor = (name: TrustProfile): ResolvedProfile =>
  name === "privileged"
    ? resolveProfile(name)
    : {
        name,
        fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
        shell: "none",
        network: "off",
        repoConfig: "disabled",
        bypassApproved: false,
      };

/** The prod request's scope shape (bypass true). */
const SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "on" },
  repository_config: { mode: "disabled" },
  bypass: true,
};

const CLIENTS: ResolvedMcpClient[] = [
  { id: "linus", maxTrustProfile: "privileged", privilegedApproval: "not_required", projects: ["app"] },
  { id: "asks", maxTrustProfile: "privileged", privilegedApproval: "required", projects: ["app"] },
  { id: "plain", maxTrustProfile: "edit-untrusted", projects: ["app"] },
];

const TICK = { maxItemsPerProject: 500, dequeueBatch: 1 };

interface Fixture {
  root: string;
  events(itemId: string): { type: string; detail_json: string | null }[];
  ledger: Ledger;
  lifecycle: RunLifecycle;
  deps: AdmitWorkDeps;
  call(clientId: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Json }>;
  close(): Promise<void>;
}

async function start(): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-queue-priv-")));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  const g = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, env: GIT_ENV });
  g("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const db = openLedger(dataDir);
  const ids = createIdGenerator();
  const ledger = createLedger(db, { ids });
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  const registry = new AdapterRegistry().register(new FakeAdapter({ scenario: "success" }));
  const lifecycle = new RunLifecycle({
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
  const projects: ResolvedProject[] = [
    {
      id: "app",
      name: "App",
      environment: { kind: "host" },
      contexts: [
        {
          id: "main",
          kind: "repository",
          path: repo,
          baseRef: "main",
          primary: true,
          writable: true,
          sign: false,
          finalizeCommit: false,
          push: { policy: "none" },
        },
      ],
    },
  ];
  const mcpClients = new Map(CLIENTS.map((c) => [c.id, c]));
  const config = { allowedRoots: [root], mcpClients, projects };
  const servers = new Map<string, { mcp: SwitchboardMcpServer; client: Client }>();
  for (const c of CLIENTS) {
    const mcp = createSwitchboardServer({ lifecycle, ledger, artifacts, registry, config, clientId: c.id });
    const client = new Client({ name: c.id, version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcp.server.connect(st);
    await client.connect(ct);
    servers.set(c.id, { mcp, client });
  }
  const deps = {
    lifecycle,
    ledger,
    registry,
    config: {
      ...config,
      dataDir,
      providers: new Map(),
      limits: { globalConcurrency: 4, perProviderConcurrency: 1 },
      capacity: { windowSeconds: 3600, confidenceRuns: 10, retry: { maxAttempts: 2, baseMs: 20, capMs: 100 } },
      routing: {},
    },
  } as unknown as AdmitWorkDeps;
  return {
    root,
    events: (itemId) =>
      db
        .prepare("SELECT type, detail_json FROM project_work_event WHERE work_item_id = ? ORDER BY created_at, id")
        .all(itemId) as { type: string; detail_json: string | null }[],
    ledger,
    lifecycle,
    deps,
    call: async (clientId, name, args) => {
      const res = await (servers.get(clientId) as { client: Client }).client.callTool({ name, arguments: args });
      const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}") as Json;
      return { isError: res.isError === true, body };
    },
    close: async () => {
      await lifecycle.shutdown();
      for (const s of servers.values()) {
        await s.client.close();
        await s.mcp.close();
      }
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const request = (extra: Record<string, unknown> = {}) => ({
  objective: "privileged change",
  project: "app",
  constraints: [],
  routing: {},
  trust_profile: "privileged",
  privileged_scope: SCOPE,
  ...extra,
});

const enqueue = (f: Fixture, clientId: string, req: Record<string, unknown>) =>
  f.ledger.enqueueWorkItem({ projectId: "app", creatorClientId: clientId, request: req, sourceKind: "mcp" });

const failedDetail = (f: Fixture, itemId: string) => {
  const ev = f.events(itemId).find((e) => e.type === "admission_failed");
  return JSON.parse(ev?.detail_json ?? "null") as Record<string, unknown> | null;
};

describe("queued privileged admission matches delegate_task", () => {
  let f: Fixture;
  afterEach(async () => {
    await f?.close();
    vi.restoreAllMocks();
  });

  it.each([
    ["linus", "not_required"],
    ["asks", "required"],
  ])("client %s (privileged_approval %s): the queue admits as delegate_task does", async (clientId) => {
    f = await start();
    const direct = await f.call(clientId, "delegate_task", request());
    expect(direct.isError, JSON.stringify(direct.body)).toBe(false);

    const item = enqueue(f, clientId, request());
    expect(await runProjectWorkQueueTick(f.ledger, f.deps, TICK)).toEqual({ admitted: 1, retried: 0, failed: 0 });
    const row = f.ledger.getWorkItem(item.id);
    expect(row?.state, JSON.stringify(f.events(item.id))).toBe("ADMITTED");
    const queuedRun = row?.admitted_run_id as string;

    const directRun = direct.body.run_id as string;
    const directApproval = f.ledger.getApprovalForRun(directRun);
    const queuedApproval = f.ledger.getApprovalForRun(queuedRun);
    expect(queuedApproval?.status).toBe(directApproval?.status);
    // The scope hash binds the meta-session (FRD C7), so compare the approved scope itself.
    expect(queuedApproval?.scope_json).toBeDefined();
    expect(JSON.parse(queuedApproval?.scope_json ?? "null")).toEqual(JSON.parse(directApproval?.scope_json ?? ""));
    expect(f.ledger.getRunRecord(queuedRun)?.trust_profile).toBe("privileged");
    expect(f.ledger.getRunRecord(queuedRun)?.client_id).toBe(clientId);
    if (clientId === "asks") {
      // Approval still required: both wait for the operator; nothing runs.
      expect(directApproval?.status).toBe("PENDING");
      expect(f.ledger.getRunRecord(queuedRun)?.state).toBe("AWAITING_APPROVAL");
      expect(direct.body.status).toBe("AWAITING_APPROVAL");
    } else {
      expect(directApproval?.status).toBe("APPROVED");
      expect(f.ledger.getRunRecord(queuedRun)?.state).not.toBe("AWAITING_APPROVAL");
      await f.lifecycle.waitForTerminal(queuedRun);
      await f.lifecycle.waitForTerminal(directRun);
    }
    // The same route basis as delegate_task: the deferred privileged compile is named, not reported as an exclusion.
    const basis = (id: string) => JSON.parse(f.ledger.getRouteDecision(id)?.reasons_json ?? "{}").selection?.basis;
    expect(basis(queuedRun)).toBe(basis(directRun));
  });

  it("the ceiling still refuses a queued privileged item, with a reason on admission_failed", async () => {
    f = await start();
    const item = enqueue(f, "plain", request());
    expect((await runProjectWorkQueueTick(f.ledger, f.deps, TICK)).failed).toBe(1);
    expect(f.ledger.getWorkItem(item.id)).toMatchObject({
      state: "FAILED_ADMISSION",
      last_error_code: "PERMISSION_BLOCKED",
    });
    expect(failedDetail(f, item.id)).toEqual({
      code: "PERMISSION_BLOCKED",
      message: "trust profile exceeds project ceiling", // client ceiling edit-untrusted, applied per project
    });
  });

  it("V13 as delegate_task: a scope is refused without the privileged profile, and a bad scope names its field", async () => {
    f = await start();
    const stray = enqueue(f, "linus", request({ trust_profile: "edit-untrusted" }));
    const bad = enqueue(f, "linus", request({ privileged_scope: { ...SCOPE, shell: { mode: "nope" } } }));
    await runProjectWorkQueueTick(f.ledger, f.deps, TICK);
    await runProjectWorkQueueTick(f.ledger, f.deps, TICK);
    expect(failedDetail(f, stray.id)).toEqual({
      code: "INVALID_REQUEST",
      message: "privileged_scope is allowed only with trust_profile privileged (got edit-untrusted)",
      field: "privileged_scope",
    });
    const badDetail = failedDetail(f, bad.id);
    expect(badDetail?.code).toBe("INVALID_REQUEST");
    expect(badDetail?.message).toMatch(/^invalid privileged_scope: /u);
    expect(badDetail?.field).toMatch(/shell/u);
  });

  it("an unexpected exception records TOOL_FAILURE with its class name only: no message, secret or path", async () => {
    f = await start();
    const secret = "sk-ant-api03-SECRETSECRETSECRETSECRETSECRET";
    vi.spyOn(f.lifecycle, "routeFeatures").mockRejectedValue(new RangeError(`boom ${secret} at /etc/shadow`));
    const outcome = await admitWorkItemRequest(f.deps, "linus", "app", request(), "queue:x");
    expect(outcome).toEqual({
      kind: "failed",
      code: "TOOL_FAILURE",
      detail: { message: "internal controller error; see the operator log", error_class: "RangeError" },
    });

    const item = enqueue(f, "linus", request());
    await runProjectWorkQueueTick(f.ledger, f.deps, TICK);
    const detail = failedDetail(f, item.id);
    expect(detail).toEqual({
      code: "TOOL_FAILURE",
      message: "internal controller error; see the operator log",
      error_class: "RangeError",
    });
    expect(JSON.stringify(detail)).not.toContain(secret);
    expect(JSON.stringify(detail)).not.toContain("/etc/shadow");
  });

  it("a known error's message is scrubbed of credentials and of paths outside the allowed roots", async () => {
    f = await start();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const { ToolError } = await import("../mcp/errors.js");
    vi.spyOn(f.lifecycle, "routeFeatures").mockRejectedValue(
      new ToolError("TOOL_FAILURE", `cannot read /home/op/.secret token ${secret}`, { reason: "X" }),
    );
    const outcome = await admitWorkItemRequest(f.deps, "linus", "app", request(), "queue:y");
    expect(outcome.kind).toBe("failed");
    const text = JSON.stringify(outcome);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("/home/op/.secret");
    expect(outcome).toMatchObject({ code: "TOOL_FAILURE", detail: { reason: "X" } });
  });
});
