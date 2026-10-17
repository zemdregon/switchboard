/**
 * T16.4 (FR-SKL-03, FR-SKL-04, FR-SKL-07, FR-MCP-08, FR-MCP-09, LLD §19.4, §19.5, FRD BR-52, BR-53, V15, C8, WF-16):
 * skill admission through the SDK client on the routing harness (fake providers only; no provider CLI is installed or
 * called). The T16.1 store is filled with the operator helpers, as `switchboard skills` (T16.2) does.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedMcpClient, ResolvedProject, ResolvedSkills } from "../config/index.js";
import type { TrustProfile } from "../ledger/index.js";
import type { AdmitWorkDeps } from "../queue/admission.js";
import { runProjectWorkQueueTick } from "../queue/scheduler.js";
import { type Harness, type Json, startHarness } from "../routing/fixtures/harness.js";
import { BODY_CANARY, source } from "../skills/fixtures/sources.js";
import {
  addSkill,
  appendSkillEvent,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_NAMES,
  DEFAULT_MAX_PER_RUN,
  DEFAULT_MAX_RUN_BYTES,
} from "../skills/index.js";

const UNTRUSTED: readonly TrustProfile[] = ["inspect-untrusted", "edit-untrusted", "test-sandboxed"];
const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};

let h: Harness | undefined;
let projectRoot: string | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  if (projectRoot !== undefined) rmSync(projectRoot, { recursive: true, force: true });
  projectRoot = undefined;
});

function settings(over: Partial<ResolvedSkills> = {}): ResolvedSkills {
  return {
    enabled: true,
    defaults: [],
    roles: {},
    delivery: "native_preferred",
    allowDraftInTrusted: false,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    maxPerRun: DEFAULT_MAX_PER_RUN,
    maxRunBytes: DEFAULT_MAX_RUN_BYTES,
    maxNames: DEFAULT_MAX_NAMES,
    ...over,
  };
}

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

function project(id: string, repo: string, skills?: ResolvedProject["skills"]): ResolvedProject {
  return {
    id,
    name: id,
    environment: { kind: "host" },
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
    ...(skills !== undefined ? { skills } : {}),
  };
}

interface Setup {
  skills?: ResolvedSkills | "absent";
  orch?: Partial<ResolvedMcpClient>;
  projectSkills?: ResolvedProject["skills"];
}

interface Started {
  x: Harness;
  projects: ResolvedProject[];
  mcpClients: Map<string, ResolvedMcpClient>;
  skills: ResolvedSkills | undefined;
}

async function start(s: Setup = {}): Promise<Started> {
  projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-t164-")));
  const projects = [project("web", gitRepo(path.join(projectRoot, "web")), s.projectSkills)];
  const mcpClients = new Map<string, ResolvedMcpClient>([
    ["orch", { id: "orch", maxTrustProfile: "trusted-development", projects: ["web"], ...s.orch }],
    ["other", { id: "other", maxTrustProfile: "edit-untrusted", projects: ["web"] }],
  ]);
  const skills = s.skills === "absent" ? undefined : (s.skills ?? settings());
  h = await startHarness({
    allowedRoots: [projectRoot],
    config: { projects, mcpClients },
    deps: ({ db, dataDir }) => (skills === undefined ? {} : { skills: { db, dataDir, settings: skills } }),
  });
  return { x: h, projects, mcpClients, skills };
}

let bodies = 0;
/** Store one version of `name` and return its number; `approve` (default true) approves it. */
function add(x: Harness, name: string, opts: { repo?: boolean; approve?: boolean; body?: string } = {}): number {
  const dir = path.join(x.root, opts.repo ? "skill-repo" : "operator");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${Math.random().toString(36).slice(2)}.md`);
  bodies += 1; // a new version needs new content (SKILL_UNCHANGED otherwise)
  writeFileSync(file, source(`${opts.body ?? `Body of ${name}, edition ${bodies}.`} ${BODY_CANARY}\n`, { name }));
  const r = addSkill(
    x.db,
    path.join(x.root, "data"),
    { name, file, ...(opts.repo ? { fromRepository: true } : {}) },
    { repositoryRoots: opts.repo ? [dir] : [] },
  );
  if (r.kind !== "added") throw new Error(`add ${name}: ${JSON.stringify(r)}`);
  if (opts.approve !== false) appendSkillEvent(x.db, { name, version: r.version, kind: "approved" });
  return r.version;
}

const runSkills = (x: Harness, runId: string) =>
  x.db
    .prepare(
      "SELECT position, name, version, source, delivery, delivered_at FROM run_skill WHERE run_id = ? ORDER BY position",
    )
    .all(runId) as { position: number; name: string; version: number; source: string; delivery: string }[];
const resolvedEvents = (x: Harness, runId: string) =>
  (
    x.db.prepare("SELECT payload_json FROM run_event WHERE run_id = ? AND type = 'skill_resolved'").all(runId) as {
      payload_json: string;
    }[]
  ).map((r) => JSON.parse(r.payload_json) as Json);
const countRuns = (x: Harness) => (x.db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n;
const refs = (rows: { name: string; version: number }[]) => rows.map((r) => `${r.name}@${r.version}`);

const delegate = (x: Harness, args: Json, clientId?: string) =>
  x.call(
    "delegate_task",
    { objective: "Fix the bug", project: "web", trust_profile: "edit-untrusted", ...args },
    clientId,
  );
async function delegateOk(x: Harness, args: Json): Promise<string> {
  const r = await delegate(x, args);
  expect(r.isError, JSON.stringify(r.body)).toBe(false);
  await x.settle(r.body.run_id as string);
  return r.body.run_id as string;
}

describe("disabled (V15 SKILLS_DISABLED)", () => {
  for (const mode of ["enabled false", "store not wired"] as const) {
    it(`with ${mode}, each field on each tool is INVALID_REQUEST SKILLS_DISABLED and writes nothing`, async () => {
      const { x } = await start({ skills: mode === "enabled false" ? settings({ enabled: false }) : "absent" });
      const first = await delegateOk(x, {});
      const session = (await x.ok("get_run", { run_id: first })).meta_session_id as string;
      const fields: Json[] = [{ skills: ["alpha"] }, { role: "dev" }, { skill_defaults: "apply" }];
      const before = countRuns(x);
      for (const f of fields) {
        const calls = [
          delegate(x, f),
          x.call("continue_task", { meta_session_id: session, instruction: "more", ...f }),
          x.call("enqueue_work", {
            project_id: "web",
            request: { objective: "q", trust_profile: "edit-untrusted", ...f },
          }),
        ];
        for (const r of await Promise.all(calls)) {
          expect(r.body.error, JSON.stringify(f)).toMatchObject({
            code: "INVALID_REQUEST",
            details: { reason: "SKILLS_DISABLED" },
          });
        }
      }
      expect(countRuns(x)).toBe(before);
      expect(x.db.prepare("SELECT COUNT(*) AS n FROM project_work_item").get()).toEqual({ n: 0 });
      expect(x.db.prepare("SELECT COUNT(*) AS n FROM run_skill").get()).toEqual({ n: 0 });
      // A run without fields is admitted as before, with no skill row and no skill event.
      expect(resolvedEvents(x, first)).toEqual([]);
      expect((await x.ok("get_run", { run_id: first })).skills).toBeUndefined();
    });
  }

  it("the schemas take the three fields on delegate_task, continue_task and enqueue_work.request", async () => {
    const { x } = await start();
    const tools = (await x.client().listTools()).tools;
    const props = (name: string) => tools.find((t) => t.name === name)?.inputSchema.properties as Json;
    for (const p of [props("delegate_task"), props("continue_task"), props("enqueue_work").request.properties]) {
      expect(p.skills).toMatchObject({ type: "array", maxItems: 8, uniqueItems: true });
      expect(p.role).toMatchObject({ type: "string" });
      expect(p.skill_defaults).toEqual({ enum: ["apply", "omit"] });
    }
    const bad = await delegate(x, { skills: ["Not A Name"] });
    expect(bad.body.error.code).toBe("INVALID_REQUEST");
    const extra = await delegate(x, { skill_text: "x" });
    expect(extra.body.error.code).toBe("INVALID_REQUEST");
  });
});

describe("resolution order, pinning and the run rows (LLD §19.5, BR-52)", () => {
  it("the five sources resolve in order with first-occurrence de-duplication and @n winning", async () => {
    const { x } = await start({
      skills: settings({ defaults: ["g-one", "shared"], roles: { dev: ["g-role", "p-one"] } }),
      projectSkills: { defaults: ["p-one", "shared"], roles: { dev: ["p-role"] } },
    });
    for (const n of ["g-one", "g-role", "p-one", "p-role", "req-one"]) add(x, n);
    add(x, "shared");
    add(x, "shared"); // version 2 is the newest approved; the request pins version 1
    const runId = await delegateOk(x, { role: "dev", skills: ["req-one", "shared@1"] });
    expect(runSkills(x, runId)).toEqual([
      {
        position: 0,
        name: "g-one",
        version: 1,
        source: "global_default",
        delivery: "prompt_prefix",
        delivered_at: null,
      },
      { position: 1, name: "shared", version: 1, source: "request", delivery: "prompt_prefix", delivered_at: null },
      { position: 2, name: "g-role", version: 1, source: "global_role", delivery: "prompt_prefix", delivered_at: null },
      { position: 3, name: "p-one", version: 1, source: "global_role", delivery: "prompt_prefix", delivered_at: null },
      {
        position: 4,
        name: "p-role",
        version: 1,
        source: "project_role",
        delivery: "prompt_prefix",
        delivered_at: null,
      },
      { position: 5, name: "req-one", version: 1, source: "request", delivery: "prompt_prefix", delivered_at: null },
    ]);
    const [event, ...more] = resolvedEvents(x, runId);
    expect(more).toEqual([]);
    expect(event?.skipped).toEqual([]);
    expect(event?.entries.map((e: Json) => `${e.name}@${e.version}:${e.source}`)).toEqual([
      "g-one@1:global_default",
      "shared@1:request",
      "g-role@1:global_role",
      "p-one@1:global_role",
      "p-role@1:project_role",
      "req-one@1:request",
    ]);
    for (const e of event?.entries ?? [])
      expect(Object.keys(e).sort()).toEqual(["name", "sha256", "source", "version"]);

    // get_run: metadata only (FR-SKL-07); delivery is null until dispatch records it (T16.5, T16.6).
    const run = await x.ok("get_run", { run_id: runId, include_events: { after_seq: 0, limit: 200 } });
    expect(run.skills).toHaveLength(6);
    expect(run.skills[1]).toEqual({
      name: "shared",
      version: 1,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      source: "request",
      delivery: null,
    });
    expect(JSON.stringify(run)).not.toContain(BODY_CANARY);
    expect(JSON.stringify(run)).not.toContain("Body of");

    // skill_defaults omit drops all four configured sources.
    const omit = await delegateOk(x, { role: "dev", skills: ["req-one"], skill_defaults: "omit" });
    expect(refs(runSkills(x, omit))).toEqual(["req-one@1"]);
    expect(runSkills(x, omit)[0]?.source).toBe("request");
  });

  it("an unknown role is not an error and selects nothing", async () => {
    const { x } = await start({ skills: settings({ roles: { dev: ["g-role"] } }) });
    add(x, "g-role");
    const runId = await delegateOk(x, { role: "nobody" });
    expect(runSkills(x, runId)).toEqual([]);
    expect(resolvedEvents(x, runId)).toEqual([]);
    expect((await x.ok("get_run", { run_id: runId })).skills).toBeUndefined();
  });

  it("versions stay pinned when a newer version is approved mid-session; continue_task without fields reuses them", async () => {
    const { x } = await start();
    add(x, "alpha");
    const first = await delegateOk(x, { skills: ["alpha"] });
    const session = (await x.ok("get_run", { run_id: first })).meta_session_id as string;
    expect(add(x, "alpha")).toBe(2); // approved while the session is open
    const r = await x.call("continue_task", { meta_session_id: session, instruction: "next step" });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const second = r.body.run_id as string;
    await x.settle(second);
    expect(runSkills(x, first).map((s) => [s.name, s.version, s.source])).toEqual([["alpha", 1, "request"]]);
    expect(runSkills(x, second).map((s) => [s.name, s.version, s.source])).toEqual([["alpha", 1, "continued"]]);
    expect(resolvedEvents(x, second)[0]?.entries).toEqual([
      { name: "alpha", version: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u), source: "continued" },
    ]);
    // With a field, the continuation resolves afresh (C8 "present"): the unpinned name is now version 2.
    const r3 = await x.call("continue_task", { meta_session_id: session, instruction: "again", skills: ["alpha"] });
    expect(r3.isError, JSON.stringify(r3.body)).toBe(false);
    await x.settle(r3.body.run_id as string);
    expect(runSkills(x, r3.body.run_id as string).map((s) => [s.name, s.version, s.source])).toEqual([
      ["alpha", 2, "request"],
    ]);
  });

  it("continue_task without fields re-checks BR-53 for a lower profile: a draft is skipped with an event", async () => {
    const { x } = await start({ skills: settings({ allowDraftInTrusted: true }) });
    add(x, "alpha");
    const draft = add(x, "drafty", { approve: false });
    const first = await delegateOk(x, { trust_profile: "trusted-development", skills: ["alpha", `drafty@${draft}`] });
    expect(refs(runSkills(x, first))).toEqual(["alpha@1", "drafty@1"]);
    const session = (await x.ok("get_run", { run_id: first })).meta_session_id as string;
    const r = await x.call("continue_task", {
      meta_session_id: session,
      instruction: "lower",
      trust_profile: "edit-untrusted",
    });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const second = r.body.run_id as string;
    await x.settle(second);
    expect(refs(runSkills(x, second))).toEqual(["alpha@1"]);
    expect(resolvedEvents(x, second)[0]?.skipped).toEqual([{ name: "drafty@1", reason: "SKILL_NOT_APPROVED" }]);
  });
});

describe("gates under the untrusted profiles (BR-53, V15)", () => {
  for (const profile of UNTRUSTED) {
    it(`${profile}: a requested draft or repository_path version is PERMISSION_BLOCKED; a failing default is skipped`, async () => {
      const { x } = await start({
        skills: settings({ allowDraftInTrusted: true, defaults: ["drafty@1", "repo-made", "alpha"] }),
      });
      add(x, "alpha");
      add(x, "drafty", { approve: false });
      add(x, "repo-made", { repo: true });
      const before = countRuns(x);
      const cases: [string, string][] = [
        ["drafty@1", "SKILL_NOT_APPROVED"],
        ["repo-made", "SKILL_REPOSITORY_ORIGIN"],
        ["repo-made@1", "SKILL_REPOSITORY_ORIGIN"],
      ];
      for (const [ref, reason] of cases) {
        const r = await delegate(x, { trust_profile: profile, skills: [ref] });
        expect(r.body.error, ref).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason, skill: ref } });
      }
      expect(countRuns(x)).toBe(before); // a refusal writes nothing
      expect(x.db.prepare("SELECT COUNT(*) AS n FROM run_skill").get()).toEqual({ n: 0 });

      const runId = await delegateOk(x, { trust_profile: profile });
      expect(refs(runSkills(x, runId))).toEqual(["alpha@1"]);
      expect(resolvedEvents(x, runId)[0]?.skipped).toEqual([
        { name: "drafty@1", reason: "SKILL_NOT_APPROVED" },
        { name: "repo-made", reason: "SKILL_REPOSITORY_ORIGIN" },
      ]);
    });
  }

  it("trusted-development takes the same draft only with allow_draft_in_trusted; unknown and not permitted names", async () => {
    const { x } = await start({ orch: { skills: ["alpha", "drafty"] } });
    add(x, "alpha");
    add(x, "drafty", { approve: false });
    add(x, "hidden");
    const off = await delegate(x, { trust_profile: "trusted-development", skills: ["drafty@1"] });
    expect(off.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "SKILL_NOT_APPROVED" } });
    const hidden = await delegate(x, { skills: ["hidden"] });
    expect(hidden.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { reason: "SKILL_NOT_PERMITTED" } });
    const unknown = await delegate(x, { skills: ["no-such"] });
    expect(unknown.body.error).toMatchObject({ code: "INVALID_REQUEST", details: { reason: "SKILL_UNKNOWN" } });
  });
});

describe("caps, request_hash and the queue", () => {
  it("caps give SKILL_RUN_LIMIT and write nothing", async () => {
    const { x } = await start({ skills: settings({ maxPerRun: 2, defaults: ["alpha"] }) });
    for (const n of ["alpha", "bravo", "charlie"]) add(x, n);
    const before = countRuns(x);
    const r = await delegate(x, { skills: ["bravo", "charlie"] });
    expect(r.body.error).toMatchObject({ code: "INVALID_REQUEST", details: { reason: "SKILL_RUN_LIMIT" } });
    expect(countRuns(x)).toBe(before);
    await h?.close();
    h = undefined;
    const { x: y } = await start({ skills: settings({ maxRunBytes: 100 }) });
    add(y, "alpha");
    const big = await delegate(y, { skills: ["alpha"] });
    expect(big.body.error).toMatchObject({ code: "INVALID_REQUEST", details: { reason: "SKILL_RUN_LIMIT" } });
  });

  it("the fields change request_hash (FR-MCP-08): an idempotency key reused with other skill fields is refused", async () => {
    const { x } = await start();
    add(x, "alpha");
    const a = await delegate(x, { idempotency_key: "key-00000001", skills: ["alpha"] });
    expect(a.isError, JSON.stringify(a.body)).toBe(false);
    await x.settle(a.body.run_id as string);
    const replay = await delegate(x, { idempotency_key: "key-00000001", skills: ["alpha"] });
    expect(replay.body).toMatchObject({ run_id: a.body.run_id, replayed: true });
    for (const other of [
      {},
      { skills: ["alpha@1"] },
      { role: "dev", skills: ["alpha"] },
      { skill_defaults: "omit", skills: ["alpha"] },
    ]) {
      const r = await delegate(x, { idempotency_key: "key-00000001", ...other });
      expect(r.body.error, JSON.stringify(other)).toMatchObject({ code: "INVALID_REQUEST" });
      expect(r.body.error.message).toMatch(/idempotency key reused/u);
    }
    const plain = await delegateOk(x, {});
    const hashOf = (id: string) =>
      (x.db.prepare("SELECT request_hash FROM run WHERE id = ?").get(id) as { request_hash: string }).request_hash;
    expect(hashOf(plain)).not.toBe(hashOf(a.body.run_id as string));
  });

  it("a queued item stores the fields and resolves them at its own admission", async () => {
    const { x, projects, mcpClients, skills } = await start();
    const e = await x.call("enqueue_work", {
      project_id: "web",
      request: { objective: "queued", trust_profile: "edit-untrusted", skills: ["late"], role: "dev" },
    });
    expect(e.isError, JSON.stringify(e.body)).toBe(false); // "late" does not exist yet: nothing resolves at enqueue
    const item = x.ledger.getWorkItem(e.body.work_item_id as string);
    expect(JSON.parse(item?.request_json ?? "{}")).toMatchObject({ skills: ["late"], role: "dev" });
    add(x, "late");
    const deps = {
      lifecycle: x.lifecycle,
      ledger: x.ledger,
      registry: x.registry,
      config: { allowedRoots: [x.root, projectRoot], mcpClients, projects },
      skills: { db: x.db, settings: skills },
    } as unknown as AdmitWorkDeps;
    expect((await runProjectWorkQueueTick(x.ledger, deps, { maxItemsPerProject: 50, dequeueBatch: 1 })).admitted).toBe(
      1,
    );
    const runId = x.ledger.getWorkItem(e.body.work_item_id as string)?.admitted_run_id as string;
    await x.settle(runId);
    expect(runSkills(x, runId).map((s) => [s.name, s.version, s.source])).toEqual([["late", 1, "request"]]);

    // A queued item whose name fails a gate at admission fails with the V15 code; without the store it is disabled.
    const bad = await x.ok("enqueue_work", {
      project_id: "web",
      request: { objective: "queued 2", trust_profile: "edit-untrusted", skills: ["missing"] },
    });
    await runProjectWorkQueueTick(x.ledger, deps, { maxItemsPerProject: 50, dequeueBatch: 1 });
    expect(x.ledger.getWorkItem(bad.work_item_id as string)).toMatchObject({ state: "FAILED_ADMISSION" });
    const off = await x.ok("enqueue_work", {
      project_id: "web",
      request: { objective: "queued 3", trust_profile: "edit-untrusted", role: "dev" },
    });
    const { skills: _dropped, ...noSkills } = deps as unknown as Json;
    await runProjectWorkQueueTick(x.ledger, noSkills as AdmitWorkDeps, { maxItemsPerProject: 50, dequeueBatch: 1 });
    expect(x.ledger.getWorkItem(off.work_item_id as string)).toMatchObject({ state: "FAILED_ADMISSION" });
  });
});
