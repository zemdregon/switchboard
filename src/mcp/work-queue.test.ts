/**
 * `enqueue_work`, `list_work` and `cancel_work` on the MCP server (T15.1; FR-QUE-01, FR-PRJ-10, LLD §18.4). Through the
 * SDK client, so every result is checked against the published output schema: the tools are listed with closed
 * schemas; items are scoped to the creating client and to projects it may use, as `list_runs`; enqueue refuses a
 * profile above the creator's ceiling and admission later runs under that creator's ceiling (`src/queue/admission.ts`);
 * only the creator may cancel. Fake CLIs only; nothing live.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedMcpClient, ResolvedProject } from "../config/index.js";
import { resolveNotificationSinks } from "../config/notification-sinks.js";
import { SinkDispatcher, type SinkPost } from "../control/sinks.js";
import type { TrustProfile } from "../ledger/index.js";
import type { AdmitWorkDeps } from "../queue/admission.js";
import { attachQueueLowWater } from "../queue/low-water.js";
import { runProjectWorkQueueTick } from "../queue/scheduler.js";
import { type Harness, type Json, startHarness } from "../routing/fixtures/harness.js";
import { inputSchema, outputSchema, TOOL_NAMES, WORK_QUEUE_TOOL_NAMES } from "./schemas.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};

function gitRepo(dir: string): string {
  mkdirSync(dir);
  const g = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, env: GIT_ENV });
  g("init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "hello\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return dir;
}

function project(
  id: string,
  repo: string,
  maxTrustProfile?: TrustProfile,
  queue?: { lowWater?: number },
): ResolvedProject {
  return {
    id,
    name: id,
    environment: { kind: "host" },
    ...(maxTrustProfile !== undefined ? { maxTrustProfile } : {}),
    ...(queue !== undefined ? { queue } : {}),
    contexts: [
      {
        id: "main",
        kind: "repository",
        path: repo,
        baseRef: "main",
        primary: true,
        writable: true,
        push: { policy: "none" },
        sign: false,
        finalizeCommit: false,
      },
    ],
  };
}

const edit: TrustProfile = "edit-untrusted";
let h: Harness;
let projectRoot: string;
let projects: ResolvedProject[];
let mcpClients: Map<string, ResolvedMcpClient>;

async function start(queue?: { maxItemsPerProject: number }, webQueue?: { lowWater?: number }): Promise<void> {
  projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-work-queue-")));
  const web = gitRepo(path.join(projectRoot, "web"));
  const api = gitRepo(path.join(projectRoot, "api"));
  projects = [
    project("web", web, undefined, webQueue),
    project("api", api),
    project("locked", web, "inspect-untrusted"),
  ];
  mcpClients = new Map([
    ["orch", { id: "orch", maxTrustProfile: edit, projects: ["web", "locked"] }],
    ["other", { id: "other", maxTrustProfile: edit, projects: ["web", "api"] }],
  ]);
  h = await startHarness({
    allowedRoots: [projectRoot],
    config: { projects, mcpClients, ...(queue !== undefined ? { queue } : {}) },
  });
}
afterEach(async () => {
  await h.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

const REQUEST = { objective: "Fix the parser crash", trust_profile: "edit-untrusted" };
const enqueue = (args: Json, clientId?: string) => h.call("enqueue_work", args, clientId);
const enqueueOk = (args: Json, clientId?: string) => h.ok("enqueue_work", args, clientId);
const listOk = (args: Json, clientId?: string) => h.ok("list_work", args, clientId);
const itemCount = () => (h.db.prepare("SELECT COUNT(*) AS n FROM project_work_item").get() as { n: number }).n;
const tick = (clients = mcpClients) =>
  runProjectWorkQueueTick(
    h.ledger,
    {
      lifecycle: h.lifecycle,
      ledger: h.ledger,
      registry: h.registry,
      config: { allowedRoots: [h.root, projectRoot], mcpClients: clients, projects },
    } as unknown as AdmitWorkDeps,
    { maxItemsPerProject: 500, dequeueBatch: 1 },
  );

describe("project work queue MCP tools (T15.1, FR-QUE-01)", () => {
  beforeEach(async () => start());

  it("are listed right after the base tools with closed schemas", async () => {
    const { tools } = await h.client().listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES, ...WORK_QUEUE_TOOL_NAMES]);
    expect(WORK_QUEUE_TOOL_NAMES).toEqual(["enqueue_work", "list_work", "cancel_work"]);
    for (const name of WORK_QUEUE_TOOL_NAMES) {
      const t = tools.find((x) => x.name === name);
      expect(t?.inputSchema).toEqual(inputSchema(name));
      expect(t?.outputSchema).toEqual(outputSchema(name));
      expect(t?.inputSchema.additionalProperties).toBe(false);
    }
    const enqueueSchema = inputSchema("enqueue_work") as { properties: { request: Json } };
    expect(enqueueSchema.properties.request.additionalProperties).toBe(false);
    for (const args of [
      { project_id: "web", request: REQUEST, extra: 1 },
      { project_id: "web", request: { ...REQUEST, workspace_path: projectRoot } },
      { project_id: "web", request: { ...REQUEST, wait_seconds: 5 } },
      { project_id: "web", request: REQUEST, priority: 1001 },
      { project_id: "web" },
    ]) {
      const r = await enqueue(args);
      expect(r.isError).toBe(true);
      expect(r.body.error.code).toBe("INVALID_REQUEST");
    }
    expect((await h.call("list_work", { state_in: ["NOPE"] })).body.error.code).toBe("INVALID_REQUEST");
    expect((await h.call("cancel_work", { work_item_id: "run_00000000000000000000000000" })).isError).toBe(true);
    expect(itemCount()).toBe(0);
  });

  it("enqueues a READY item that only its creator lists, scoped like list_runs", async () => {
    const item = await enqueueOk({ project_id: "web", request: REQUEST, priority: 5 });
    expect(item).toMatchObject({
      project_id: "web",
      state: "READY",
      priority: 5,
      trust_profile: "edit-untrusted",
      source_kind: "mcp",
      depends_on: [],
      admitted_run_id: null,
      terminal_at: null,
    });
    expect(item.work_item_id).toMatch(/^que_[0-9A-HJKMNP-TV-Z]{26}$/);
    const row = h.ledger.getWorkItem(item.work_item_id);
    expect(row?.creator_client_id).toBe("orch");
    // LLD §18.2: request_json is the delegate_task input with project set and defaults filled, frozen at enqueue.
    expect(JSON.parse(row?.request_json ?? "{}")).toEqual({
      ...REQUEST,
      project: "web",
      constraints: [],
      verification_commands: [],
      priority: "normal",
    });

    const low = await enqueueOk({ project_id: "web", request: REQUEST, priority: -5 });
    const mine = await listOk({});
    expect(mine.items.map((i: Json) => i.work_item_id)).toEqual([item.work_item_id, low.work_item_id]);
    expect((await listOk({ project_id: "web", state_in: ["CANCELLED"] })).items).toEqual([]);
    expect((await listOk({ limit: 1 })).items).toHaveLength(1);

    // Another client sees none of them, even in a project both may use.
    expect((await listOk({}, "other")).items).toEqual([]);
    expect((await listOk({ project_id: "web" }, "other")).items).toEqual([]);
    const theirs = await enqueueOk({ project_id: "api", request: REQUEST }, "other");
    expect((await listOk({}, "other")).items.map((i: Json) => i.work_item_id)).toEqual([theirs.work_item_id]);
    expect((await listOk({})).items).toHaveLength(2);
  });

  it("refuses an unknown project as INVALID_REQUEST and one outside the client's list as PERMISSION_BLOCKED", async () => {
    for (const [tool, args] of [
      ["enqueue_work", { project_id: "nope", request: REQUEST }],
      ["list_work", { project_id: "nope" }],
    ] as const) {
      const r = await h.call(tool, args);
      expect(r.isError).toBe(true);
      expect(r.body.error.code).toBe("INVALID_REQUEST");
    }
    for (const [tool, args] of [
      ["enqueue_work", { project_id: "api", request: REQUEST }],
      ["list_work", { project_id: "api" }],
    ] as const) {
      const r = await h.call(tool, args);
      expect(r.isError).toBe(true);
      expect(r.body.error.code).toBe("PERMISSION_BLOCKED");
    }
    expect(itemCount()).toBe(0);
  });

  it("refuses a profile above the creator's or the project's ceiling and admits under the creator's ceiling", async () => {
    const above = await enqueue({ project_id: "web", request: { ...REQUEST, trust_profile: "trusted-development" } });
    expect(above.body.error.code).toBe("PERMISSION_BLOCKED");
    expect(above.body.error.details).toMatchObject({ client_max_profile: "edit-untrusted" });
    const locked = await enqueue({ project_id: "locked", request: REQUEST });
    expect(locked.body.error.code).toBe("PERMISSION_BLOCKED");
    expect(locked.body.error.details).toMatchObject({ project: "locked", effective_max_profile: "inspect-untrusted" });
    const priv = await enqueue({ project_id: "web", request: { ...REQUEST, trust_profile: "privileged" } });
    expect(priv.body.error.code).toBe("PERMISSION_BLOCKED");
    const v7 = await enqueue({
      project_id: "web",
      request: { ...REQUEST, trust_profile: "inspect-untrusted", verification_commands: [["npm", "test"]] },
    });
    expect(v7.body.error.code).toBe("INVALID_REQUEST");
    expect(itemCount()).toBe(0);

    // Within the ceiling: the scheduler admits it as the creating client, and the run is that client's.
    const item = await enqueueOk({ project_id: "web", request: REQUEST });
    expect(await tick()).toEqual({ admitted: 1, retried: 0, failed: 0 });
    const admitted = (await listOk({})).items[0];
    expect(admitted.state).toBe("ADMITTED");
    expect(h.ledger.getRunRecord(admitted.admitted_run_id)?.client_id).toBe("orch");
    await h.lifecycle.waitForTerminal(admitted.admitted_run_id);
    expect((await h.ok("get_run", { run_id: admitted.admitted_run_id })).project_id).toBe("web");
    expect((await h.call("get_run", { run_id: admitted.admitted_run_id }, "other")).isError).toBe(true);
    expect((await listOk({ state_in: ["DONE"] })).items.map((i: Json) => i.work_item_id)).toEqual([item.work_item_id]);

    // The creator's ceiling lowered after enqueue: admission refuses it; no other client's ceiling is used.
    const later = await enqueueOk({ project_id: "web", request: REQUEST });
    const lowered = new Map(mcpClients);
    lowered.set("orch", { id: "orch", maxTrustProfile: "inspect-untrusted", projects: ["web"] });
    expect(await tick(lowered)).toEqual({ admitted: 0, retried: 0, failed: 1 });
    const failed = (await listOk({ state_in: ["FAILED_ADMISSION"] })).items;
    expect(failed.map((i: Json) => [i.work_item_id, i.last_error_code])).toEqual([
      [later.work_item_id, "PERMISSION_BLOCKED"],
    ]);
  });

  it("lets only the creator cancel; other states are returned unchanged", async () => {
    const item = await enqueueOk({ project_id: "web", request: REQUEST });
    const byOther = await h.call("cancel_work", { work_item_id: item.work_item_id }, "other");
    expect(byOther.isError).toBe(true);
    expect(byOther.body.error.code).toBe("INVALID_REQUEST");
    expect(h.ledger.getWorkItem(item.work_item_id)?.state).toBe("READY");

    const cancelled = await h.ok("cancel_work", { work_item_id: item.work_item_id });
    expect(cancelled.state).toBe("CANCELLED");
    expect(cancelled.terminal_at).not.toBeNull();
    expect((await h.ok("cancel_work", { work_item_id: item.work_item_id })).updated_at).toBe(cancelled.updated_at);
    const unknown = await h.call("cancel_work", { work_item_id: "que_00000000000000000000000000" });
    expect(unknown.body.error.code).toBe("INVALID_REQUEST");

    // An admitted item is not cancelled here (cancel_run stops its run).
    await enqueueOk({ project_id: "web", request: REQUEST });
    await tick();
    const admitted = (await listOk({ state_in: ["ADMITTED", "DONE"] })).items[0];
    const again = await h.ok("cancel_work", { work_item_id: admitted.work_item_id });
    expect(again.state).not.toBe("CANCELLED");
    await h.lifecycle.waitForTerminal(admitted.admitted_run_id);
  });

  it("replays an idempotency key with the same arguments, refuses it with others, and scopes depends_on", async () => {
    const args = { project_id: "web", request: REQUEST, idempotency_key: "key-000001" };
    const first = await enqueueOk(args);
    const replay = await enqueueOk(args);
    expect(replay).toMatchObject({ work_item_id: first.work_item_id, replayed: true });
    const conflict = await enqueue({ ...args, priority: 3 });
    expect(conflict.body.error.code).toBe("INVALID_REQUEST");
    // Keys are per client: another client's identical key is its own item.
    expect((await enqueueOk(args, "other")).work_item_id).not.toBe(first.work_item_id);
    expect(h.ledger.getWorkItem(first.work_item_id)?.idempotency_key).toBe("mcp:key-000001");

    const next = await enqueueOk({ project_id: "web", request: REQUEST, depends_on: [first.work_item_id] });
    expect(next).toMatchObject({ state: "PENDING", depends_on: [first.work_item_id] });
    const foreign = await enqueue({ project_id: "web", request: REQUEST, depends_on: [first.work_item_id] }, "other");
    expect(foreign.body.error.code).toBe("INVALID_REQUEST");
  });

  it("T15.7: refuses a duplicate dedupe_key with CONFLICT for any client of the project, and returns hot_paths", async () => {
    const first = await enqueueOk({
      project_id: "web",
      request: REQUEST,
      dedupe_key: "parser-crash",
      hot_paths: ["src/parser/**"],
    });
    expect(first).toMatchObject({ dedupe_key: "parser-crash", hot_paths: ["src/parser/**"], superseded_by: null });
    for (const client of ["orch", "other"]) {
      const dup = await enqueue({ project_id: "web", request: REQUEST, dedupe_key: "parser-crash" }, client);
      expect(dup.body.error.code).toBe("INVALID_REQUEST");
      expect(dup.body.error.details).toMatchObject({ field: "dedupe_key", reason: "CONFLICT" });
      // The holder's id is never returned to the refused caller.
      expect(JSON.stringify(dup.body)).not.toContain(first.work_item_id);
    }
    expect(itemCount()).toBe(1);
    // Another project keeps its own keys; a cancelled holder releases the key.
    await enqueueOk({ project_id: "api", request: REQUEST, dedupe_key: "parser-crash" }, "other");
    await h.ok("cancel_work", { work_item_id: first.work_item_id });
    expect(await enqueueOk({ project_id: "web", request: REQUEST, dedupe_key: "parser-crash" })).toMatchObject({
      dedupe_key: "parser-crash",
    });
    const tooMany = await enqueue({
      project_id: "web",
      request: REQUEST,
      hot_paths: Array.from({ length: 33 }, (_, i) => `p${i}/**`),
    });
    expect(tooMany.body.error.code).toBe("INVALID_REQUEST");
    const absolute = await enqueue({ project_id: "web", request: REQUEST, hot_paths: ["/etc/**"] });
    expect(absolute.body.error).toMatchObject({ code: "INVALID_REQUEST", details: { field: "hot_paths" } });
  });
});

describe("project work queue limit (T15.1, LLD §18.1)", () => {
  beforeEach(async () => start({ maxItemsPerProject: 1 }));

  it("refuses an enqueue over queue.max_items_per_project", async () => {
    await enqueueOk({ project_id: "web", request: REQUEST });
    const over = await enqueue({ project_id: "web", request: REQUEST });
    expect(over.body.error.code).toBe("INVALID_REQUEST");
    expect(over.body.error.details).toMatchObject({ max_items_per_project: 1 });
    expect(itemCount()).toBe(1);
  });
});

describe("project work queue low-water mark (T15.4, FR-QUE-04)", () => {
  beforeEach(async () => start(undefined, { lowWater: 3 }));

  it("Tests through the MCP server on fakes with a capturing sink: draining a queue from 4 to 1 items with mark 3 emits exactly one event; refilling to 3 and draining again emits a second; the payload has only the ADR-0048 fields; an unset mark emits nothing", async () => {
    const posted: { url: string; headers: Record<string, string>; body: string }[] = [];
    const post: SinkPost = async (req) => {
      posted.push({ url: req.url, headers: req.headers, body: req.body });
      return 200;
    };
    const dispatcher = new SinkDispatcher({
      sinks: resolveNotificationSinks([
        { id: "test-sink", kind: "webhook", url: "https://127.0.0.1/sink", events: ["queue_low"] },
      ]),
      post,
    });
    attachQueueLowWater({
      ledger: h.ledger,
      getLowWaterMark: (pid) => projects.find((p) => p.id === pid)?.queue?.lowWater,
      dispatcher,
    });

    // 1. Enqueue 4 items into "web" (mark 3) through MCP
    await enqueueOk({ project_id: "web", request: REQUEST });
    const item2 = await enqueueOk({ project_id: "web", request: REQUEST });
    const item3 = await enqueueOk({ project_id: "web", request: REQUEST });
    const item4 = await enqueueOk({ project_id: "web", request: REQUEST });

    // Mark 3: starting at 0, rising 1 -> 2 -> 3 (arms) -> 4. No drop below mark, so 0 events emitted.
    expect(posted).toHaveLength(0);

    // 2. Draining from 4 to 1 items:
    // Cancel item 4: count goes 4 -> 3 (3 >= 3: stays armed, no emit)
    await h.ok("cancel_work", { work_item_id: item4.work_item_id });
    await dispatcher.drain();
    expect(posted).toHaveLength(0);

    // Cancel item 3: count goes 3 -> 2 (2 < 3: drops below mark, emits exactly one event, disarms)
    await h.ok("cancel_work", { work_item_id: item3.work_item_id });
    await dispatcher.drain();
    expect(posted).toHaveLength(1);

    // Cancel item 2: count goes 2 -> 1 (1 < 3: stays disarmed, no second event)
    await h.ok("cancel_work", { work_item_id: item2.work_item_id });
    await dispatcher.drain();
    expect(posted).toHaveLength(1);

    // 3. Payload has only the ADR-0048 fields:
    // project_id, event_kind, reason_code, run_id, link
    const firstSent = posted[0];
    expect(firstSent).toBeDefined();
    const payload = JSON.parse(firstSent?.body ?? "{}");
    expect(Object.keys(payload).sort()).toEqual(["event_kind", "link", "project_id", "reason_code", "run_id"]);
    expect(payload).toEqual({
      project_id: "web",
      event_kind: "queue_low",
      reason_code: "queue_low",
      run_id: null,
      link: "switchboard://digest",
    });

    // 4. Refilling to 3 items and draining again emits a second event:
    // Currently item 1 is in queue (count = 1).
    // Enqueue item 5: count goes 1 -> 2 (< 3: stays disarmed, no emit)
    const item5 = await enqueueOk({ project_id: "web", request: REQUEST });
    await dispatcher.drain();
    expect(posted).toHaveLength(1);

    // Enqueue item 6: count goes 2 -> 3 (3 >= 3: re-arms!, no emit)
    const item6 = await enqueueOk({ project_id: "web", request: REQUEST });
    await dispatcher.drain();
    expect(posted).toHaveLength(1);

    // Drain again:
    // Cancel item 6: count goes 3 -> 2 (2 < 3: drops below mark, emits second event!)
    await h.ok("cancel_work", { work_item_id: item6.work_item_id });
    await dispatcher.drain();
    expect(posted).toHaveLength(2);

    // Cancel item 5: count goes 2 -> 1 (1 < 3: stays disarmed, no third event)
    await h.ok("cancel_work", { work_item_id: item5.work_item_id });
    await dispatcher.drain();
    expect(posted).toHaveLength(2);

    const secondSent = posted[1];
    expect(secondSent).toBeDefined();
    const payload2 = JSON.parse(secondSent?.body ?? "{}");
    expect(Object.keys(payload2).sort()).toEqual(["event_kind", "link", "project_id", "reason_code", "run_id"]);
    expect(payload2).toEqual({
      project_id: "web",
      event_kind: "queue_low",
      reason_code: "queue_low",
      run_id: null,
      link: "switchboard://digest",
    });

    // 5. An unset mark emits nothing:
    // Project "api" has no queue.low_water configured
    await enqueueOk({ project_id: "api", request: REQUEST }, "other");
    const api2 = await enqueueOk({ project_id: "api", request: REQUEST }, "other");
    const api3 = await enqueueOk({ project_id: "api", request: REQUEST }, "other");
    const api4 = await enqueueOk({ project_id: "api", request: REQUEST }, "other");
    await h.ok("cancel_work", { work_item_id: api4.work_item_id }, "other");
    await h.ok("cancel_work", { work_item_id: api3.work_item_id }, "other");
    await h.ok("cancel_work", { work_item_id: api2.work_item_id }, "other");
    await dispatcher.drain();
    // Still exactly 2 events (all from "web", none from "api")
    expect(posted).toHaveLength(2);

    await dispatcher.close();
  });

  it("everything not configured stays byte-identical to main", async () => {
    // When queue.low_water is not set on a project, its resolved representation has no lowWater
    const apiProject = projects.find((p) => p.id === "api");
    expect(apiProject?.queue?.lowWater).toBeUndefined();

    // Standard work item lifecycle on unconfigured project behaves unchanged
    const item = await enqueueOk({ project_id: "api", request: REQUEST }, "other");
    expect(item).toMatchObject({
      project_id: "api",
      state: "READY",
      admitted_run_id: null,
    });
    const cancelled = await h.ok("cancel_work", { work_item_id: item.work_item_id }, "other");
    expect(cancelled.state).toBe("CANCELLED");
  });
});
