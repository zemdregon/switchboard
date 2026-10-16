/**
 * `pause_project` / `resume_project` on the MCP server (T14.6; FR-CTL-05, FR-SES-06, LLD §3.4.4). Through the SDK
 * client, so every result is checked against the published output schema. The ROADMAP done-when: a paused project
 * admits nothing and its running runs finish; a client cannot pause another client's project. Also: the digest's
 * `paused`, the operator's global pause as the tools and the digest see it, and that no run gains a `needs_attention`
 * reason from a pause. Fake CLIs only; nothing live.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedProject } from "../config/index.js";
import { GLOBAL_PAUSE_SCOPE, requestGlobalPause } from "../control/pause.js";
import type { TrustProfile } from "../ledger/index.js";
import { type Harness, type Json, startHarness } from "../routing/fixtures/harness.js";
import { inputSchema, outputSchema, TOOL_NAMES } from "./schemas.js";

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

function project(id: string, repo: string): ResolvedProject {
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
  };
}

let h: Harness;
let projectRoot: string;
beforeEach(async () => {
  projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-pause-mcp-")));
  const web = gitRepo(path.join(projectRoot, "web"));
  const api = gitRepo(path.join(projectRoot, "api"));
  const edit: TrustProfile = "edit-untrusted";
  h = await startHarness({
    allowedRoots: [projectRoot],
    config: {
      projects: [project("web", web), project("api", api)],
      mcpClients: new Map([
        ["orch", { id: "orch", maxTrustProfile: edit, projects: ["web"] }],
        ["other", { id: "other", maxTrustProfile: edit, projects: ["web", "api"] }],
      ]),
    },
  });
});
afterEach(async () => {
  await h.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

const delegate = (projectId: string, clientId = "orch", objective = "Fix the parser crash") =>
  h.call("delegate_task", { objective, project: projectId, trust_profile: "edit-untrusted" }, clientId);
const runCount = () => (h.db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n;
const section = (d: Json, id: string): Json => d.projects.find((p: Json) => p.project_id === id);
const status = async (runId: string, clientId = "orch") => (await h.ok("get_run", { run_id: runId }, clientId)).status;

describe("pause_project / resume_project (T14.6, FR-CTL-05)", () => {
  it("both tools are listed last with the LLD input and output, closed; the earlier tools are unchanged", async () => {
    const { tools } = await h.client().listTools();
    const names = tools.map((t) => t.name);
    expect(names.slice(0, TOOL_NAMES.length)).toEqual([...TOOL_NAMES]);
    for (const name of ["pause_project", "resume_project"] as const) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.inputSchema).toEqual(inputSchema(name));
      expect(tool?.outputSchema).toEqual(outputSchema(name));
      expect(tool?.inputSchema).toMatchObject({ additionalProperties: false, required: ["project_id"] });
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["project_id"]);
    }
    // Closed input: an extra field is refused before the handler.
    const extra = await h.call("pause_project", { project_id: "web", force: true });
    expect(extra.isError).toBe(true);
    expect(extra.body.error.code).toBe("INVALID_REQUEST");
  });

  it("a paused project admits nothing (delegate_task and continue_task, no run row) until resume_project; it is idempotent", async () => {
    const first = await delegate("web");
    expect(first.isError, JSON.stringify(first.body)).toBe(false);
    await h.lifecycle.waitForTerminal(first.body.run_id);
    expect(await status(first.body.run_id)).toBe("SUCCEEDED");
    const before = runCount();

    expect(await h.ok("pause_project", { project_id: "web" })).toEqual({ project_id: "web", paused: true });
    expect(await h.ok("pause_project", { project_id: "web" })).toEqual({ project_id: "web", paused: true });
    expect(h.ledger.getControlPlaneState("web")).toMatchObject({ paused: 1, paused_by: "mcp:orch" });

    const refused = await delegate("web");
    expect(refused.isError).toBe(true);
    expect(refused.body.error).toMatchObject({
      code: "ELIGIBILITY_NONE",
      retryable: false,
      details: { reason: "PROJECT_PAUSED", project_id: "web" },
    });
    expect(refused.body.error.message).toContain("resume_project");
    const continued = await h.call("continue_task", {
      meta_session_id: first.body.meta_session_id,
      instruction: "and now the tests",
    });
    expect(continued.isError).toBe(true);
    expect(continued.body.error.details).toEqual({ reason: "PROJECT_PAUSED", project_id: "web" });
    expect(runCount()).toBe(before);
    // list_runs and get_run are unchanged by the pause: the finished run shows no attention reason.
    expect((await h.ok("get_run", { run_id: first.body.run_id })).needs_attention).toEqual({ active: false });

    expect(await h.ok("resume_project", { project_id: "web" })).toEqual({ project_id: "web", paused: false });
    expect(await h.ok("resume_project", { project_id: "web" })).toEqual({ project_id: "web", paused: false });
    const again = await h.call("continue_task", {
      meta_session_id: first.body.meta_session_id,
      instruction: "and now the tests",
    });
    expect(again.isError, JSON.stringify(again.body)).toBe(false);
    await h.lifecycle.waitForTerminal(again.body.run_id);
    expect(await status(again.body.run_id)).toBe("SUCCEEDED");
    expect(runCount()).toBe(before + 1);
  });

  it("running runs finish: a run RUNNING when its project is paused ends SUCCEEDED and no second run starts until resume", async () => {
    const slow = await delegate("web", "orch", "slow");
    expect(slow.isError, JSON.stringify(slow.body)).toBe(false);
    await h.waitFor(() => h.ledger.getRunRecord(slow.body.run_id)?.state === "RUNNING");
    expect(await h.ok("pause_project", { project_id: "web" })).toEqual({ project_id: "web", paused: true });
    expect(await status(slow.body.run_id)).toBe("RUNNING");
    expect((await delegate("web")).body.error.details).toEqual({ reason: "PROJECT_PAUSED", project_id: "web" });

    await h.lifecycle.waitForTerminal(slow.body.run_id);
    const done = await h.ok("get_run", { run_id: slow.body.run_id });
    expect(done.status).toBe("SUCCEEDED");
    expect(done.needs_attention).toEqual({ active: false });
    expect(h.ledger.listRunsForMetaSession(slow.body.meta_session_id)).toHaveLength(1);
    expect((await delegate("web")).body.error.details).toEqual({ reason: "PROJECT_PAUSED", project_id: "web" });

    await h.ok("resume_project", { project_id: "web" });
    const next = await delegate("web");
    expect(next.isError, JSON.stringify(next.body)).toBe(false);
    await h.lifecycle.waitForTerminal(next.body.run_id);
    expect(await status(next.body.run_id)).toBe("SUCCEEDED");
  });

  it("a client cannot pause another client's project: PERMISSION_BLOCKED outside its list, INVALID_REQUEST when unknown, and only its own projects are held", async () => {
    // `api` is configured but not in orch's list; `other` may use both.
    const blocked = await h.call("pause_project", { project_id: "api" });
    expect(blocked.isError).toBe(true);
    expect(blocked.body.error.code).toBe("PERMISSION_BLOCKED");
    expect(h.ledger.getControlPlaneState("api")).toBeUndefined();
    const unknown = await h.call("resume_project", { project_id: "nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.body.error.code).toBe("INVALID_REQUEST");
    expect(h.ledger.getControlPlaneState("nope")).toBeUndefined();

    // other pauses web (shared): orch is held there too, since the pause is the project's, not the caller's...
    expect(await h.ok("pause_project", { project_id: "web" }, "other")).toEqual({ project_id: "web", paused: true });
    expect(h.ledger.getControlPlaneState("web")).toMatchObject({ paused_by: "mcp:other" });
    expect((await delegate("web", "orch")).body.error.details).toEqual({ reason: "PROJECT_PAUSED", project_id: "web" });
    // ...but other's api is not held by a pause on web, and orch cannot touch api at all.
    const api = await delegate("api", "other");
    expect(api.isError, JSON.stringify(api.body)).toBe(false);
    await h.lifecycle.waitForTerminal(api.body.run_id);
    expect(await status(api.body.run_id, "other")).toBe("SUCCEEDED");
    expect((await h.call("resume_project", { project_id: "api" })).body.error.code).toBe("PERMISSION_BLOCKED");
    // orch may resume the shared project it is allowed to use; the row then names orch.
    expect(await h.ok("resume_project", { project_id: "web" })).toEqual({ project_id: "web", paused: false });
    expect(h.ledger.getControlPlaneState("web")).toMatchObject({ paused: 0, paused_by: "mcp:orch" });
  });

  it("get_digest reports paused per project: true while paused (project or global), false after resume; never a needs_attention reason", async () => {
    const done = await delegate("web");
    await h.lifecycle.waitForTerminal(done.body.run_id);
    expect(section(await h.ok("get_digest", {}), "web")).toMatchObject({ paused: false, needs_attention: [] });

    await h.ok("pause_project", { project_id: "web" });
    const paused = await h.ok("get_digest", {});
    expect(section(paused, "web")).toMatchObject({ paused: true, needs_attention: [] });
    const theirs = await h.ok("get_digest", {}, "other");
    expect(section(theirs, "web").paused).toBe(true);
    expect(section(theirs, "api").paused).toBe(false);
    // A delta after the newest event is empty: a pause toggle is not a run event and never advances the cursor.
    expect(await h.ok("get_digest", { since_cursor: paused.cursor })).toEqual({ cursor: paused.cursor, projects: [] });

    await h.ok("resume_project", { project_id: "web" });
    expect(section(await h.ok("get_digest", {}), "web").paused).toBe(false);

    // The operator's global pause: every visible project reads paused, admission is GLOBAL_PAUSED, and the project
    // tools still report (and only change) the project's own flag.
    requestGlobalPause(h.ledger, { paused: true, requestedBy: "op", direct: true });
    const global = await h.ok("get_digest", {}, "other");
    expect(global.projects.map((p: Json) => [p.project_id, p.paused])).toEqual([
      ["api", true],
      ["web", true],
    ]);
    expect((await delegate("api", "other")).body.error).toMatchObject({
      code: "ELIGIBILITY_NONE",
      details: { reason: "GLOBAL_PAUSED" },
    });
    expect(await h.ok("resume_project", { project_id: "web" })).toEqual({ project_id: "web", paused: false });
    expect(h.ledger.getControlPlaneState(GLOBAL_PAUSE_SCOPE)?.paused).toBe(1);
    expect((await delegate("web")).body.error.details).toEqual({ reason: "GLOBAL_PAUSED" });
    requestGlobalPause(h.ledger, { paused: false, requestedBy: "op", direct: true });
    const admitted = await delegate("web");
    expect(admitted.isError, JSON.stringify(admitted.body)).toBe(false);
    await h.lifecycle.waitForTerminal(admitted.body.run_id);
  });
});
