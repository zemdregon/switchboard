/**
 * `list_runs` on the MCP server (T14.1; FR-CTL-01, FR-MCP-02, FR-MCP-04, LLD §3.4.2). Through the SDK client, so every
 * result is checked against the published output schema: the tool is listed with closed schemas and the earlier tools
 * are unchanged; another client's runs and unknown projects are not returned; each row equals the `get_run` envelope
 * for the same run; the status, project and time filters, ordering and the cursor. Fake CLIs only; nothing live.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedProject } from "../config/index.js";
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
  projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-list-runs-")));
  const web = gitRepo(path.join(projectRoot, "web"));
  const api = gitRepo(path.join(projectRoot, "api"));
  const edit: TrustProfile = "edit-untrusted";
  h = await startHarness({
    allowedRoots: [projectRoot],
    config: {
      projects: [project("web", web), project("api", api), project("hidden", web)],
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

const list = (args: Json, clientId?: string) => h.call("list_runs", args, clientId);
const listOk = (args: Json, clientId?: string) => h.ok("list_runs", args, clientId);
const inProject = async (projectId: string, clientId = "orch"): Promise<Json> => {
  const r = await h.ok(
    "delegate_task",
    { objective: "Fix the parser crash", project: projectId, trust_profile: "edit-untrusted" },
    clientId,
  );
  await h.lifecycle.waitForTerminal(r.run_id);
  return h.ok("get_run", { run_id: r.run_id }, clientId);
};
const createdAt = (runId: string): string => h.ledger.getRunRecord(runId)?.created_at ?? "";
/** Newest first: `created_at` descending, then `run_id` descending (LLD §3.4.2). */
const newestFirst = (ids: string[]): string[] =>
  [...ids].sort((a, b) => createdAt(b).localeCompare(createdAt(a)) || b.localeCompare(a));

describe("list_runs (T14.1, FR-CTL-01)", () => {
  it("is listed after explain_route with closed schemas; the earlier tools are listed unchanged", async () => {
    const { tools } = await h.client().listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(TOOL_NAMES).toEqual([
      "delegate_task",
      "continue_task",
      "get_run",
      "cancel_run",
      "get_artifacts",
      "list_capabilities",
      "list_projects",
      "get_capacity",
      "explain_route",
      "list_runs",
      "get_digest",
      "pause_project",
      "resume_project",
      "steer_run",
    ]);
    for (const t of tools) {
      expect(t.inputSchema).toEqual(inputSchema(t.name as (typeof TOOL_NAMES)[number]));
      expect(t.outputSchema).toEqual(outputSchema(t.name as (typeof TOOL_NAMES)[number]));
    }
    // get_run's published documents are the ones list_runs rows reuse.
    expect(inputSchema("get_run")).toMatchObject({ additionalProperties: false, required: ["run_id"] });
    const tool = tools.find((t) => t.name === "list_runs");
    expect(tool?.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(tool?.inputSchema.required).toBeUndefined();
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
      "project_id",
      "status",
      "status_in",
      "since",
      "until",
      "limit",
      "cursor",
    ]);
    const success = ((tool?.outputSchema?.anyOf ?? []) as Json[])[0] as Json;
    expect(success).toMatchObject({ additionalProperties: false, required: ["runs"] });
    expect(success.properties.runs.items).toEqual((outputSchema("get_run").anyOf as Json[])[0]);
    expect(tool?.description).toMatch(/get_run envelope/);

    const extra = await list({ client_id: "other" });
    expect(extra.isError).toBe(true);
    expect(extra.body.error.code).toBe("INVALID_REQUEST");
  });

  it("each row equals the get_run envelope for the same run, newest first", async () => {
    const a = await h.delegate("Fix the parser crash");
    const b = await inProject("web");
    const c = await h.delegate("Add a test", { provider_preference: "grok" });
    const { runs, next_cursor } = await listOk({});
    expect(next_cursor).toBeNull();
    expect(runs.map((r: Json) => r.run_id)).toEqual(newestFirst([a.run_id, b.run_id, c.run_id]));
    for (const row of runs) expect(row).toEqual(await h.ok("get_run", { run_id: row.run_id }));
    expect(runs.find((r: Json) => r.run_id === b.run_id).project_id).toBe("web");
  });

  it("never returns another client's runs, even in a project both may use", async () => {
    const mine = await inProject("web");
    const theirs = await inProject("web", "other");
    const theirsApi = await inProject("api", "other");
    const own = await listOk({});
    expect(own.runs.map((r: Json) => r.run_id)).toEqual([mine.run_id]);
    expect((await listOk({ project_id: "web" })).runs.map((r: Json) => r.run_id)).toEqual([mine.run_id]);
    const other = await listOk({}, "other");
    expect(other.runs.map((r: Json) => r.run_id)).toEqual(newestFirst([theirs.run_id, theirsApi.run_id]));
    // The same refusal as get_run for a run of another client.
    expect((await h.call("get_run", { run_id: theirs.run_id })).body.error.code).toBe("INVALID_REQUEST");
  });

  it("refuses an unknown project (INVALID_REQUEST) and one outside the client's list (PERMISSION_BLOCKED)", async () => {
    await inProject("api", "other");
    const unknown = await list({ project_id: "nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.body.error).toMatchObject({ code: "INVALID_REQUEST", details: { field: "project_id" } });
    const api = await list({ project_id: "api" });
    expect(api.body.error).toMatchObject({ code: "PERMISSION_BLOCKED", details: { project: "api" } });
    expect(JSON.stringify(api.body)).not.toContain("run_");
    const hidden = await list({ project_id: "hidden" }, "other");
    expect(hidden.body.error.code).toBe("PERMISSION_BLOCKED");
    const badId = await list({ project_id: "Not An Id" });
    expect(badId.body.error.code).toBe("INVALID_REQUEST");
  });

  it("filters by project, status and status_in; status with status_in is INVALID_REQUEST", async () => {
    const plain = await h.delegate("Fix the parser crash");
    const web = await inProject("web");
    expect(plain.status).toBe("SUCCEEDED");
    expect((await listOk({ project_id: "web" })).runs.map((r: Json) => r.run_id)).toEqual([web.run_id]);
    expect((await listOk({ status: "FAILED" })).runs).toEqual([]);
    expect((await listOk({ status: "SUCCEEDED" })).runs).toHaveLength(2);
    expect((await listOk({ status_in: ["QUEUED", "SUCCEEDED"] })).runs).toHaveLength(2);
    expect((await listOk({ status_in: ["RUNNING", "CANCELLED"] })).runs).toEqual([]);
    const both = await list({ status: "SUCCEEDED", status_in: ["SUCCEEDED"] });
    expect(both.body.error).toMatchObject({ code: "INVALID_REQUEST", details: { field: "status_in" } });
    expect((await list({ status: "DONE" })).body.error.code).toBe("INVALID_REQUEST");
    expect((await list({ status_in: [] })).body.error.code).toBe("INVALID_REQUEST");
    expect((await list({ status_in: ["QUEUED", "QUEUED"] })).body.error.code).toBe("INVALID_REQUEST");
  });

  it("filters by time: since is inclusive, until exclusive, on the creation time in any zone", async () => {
    const ids: string[] = [];
    for (const objective of ["one", "two", "three"]) ids.push((await h.delegate(objective)).run_id);
    const pivot = ids[1] as string;
    const at = createdAt(pivot);
    const expectFrom = newestFirst(ids.filter((id) => createdAt(id) >= at));
    const expectBefore = newestFirst(ids.filter((id) => createdAt(id) < at));
    expect((await listOk({ since: at })).runs.map((r: Json) => r.run_id)).toEqual(expectFrom);
    expect((await listOk({ until: at })).runs.map((r: Json) => r.run_id)).toEqual(expectBefore);
    expect(expectFrom).toContain(pivot);
    expect(expectBefore).not.toContain(pivot);
    // The same instant written with an offset selects the same rows.
    const ms = Date.parse(at);
    const shifted = new Date(ms + 2 * 3600_000).toISOString().replace(/Z$/u, "+02:00");
    expect((await listOk({ since: shifted })).runs.map((r: Json) => r.run_id)).toEqual(expectFrom);
    expect((await listOk({ since: at, until: at })).runs).toEqual([]);
    expect((await list({ since: "yesterday" })).body.error.code).toBe("INVALID_REQUEST");
    for (const until of [
      "2026-02-31T10:00:00Z",
      "2026-02-29T10:00:00Z",
      "2026-13-01T10:00:00Z",
      "2026-01-01T25:00:00Z",
    ]) {
      const impossible = await list({ until });
      expect(impossible.body.error, until).toMatchObject({ code: "INVALID_REQUEST", details: { field: "until" } });
    }
    expect((await listOk({ until: "2028-02-29T10:00:00+01:00" })).runs).toHaveLength(3);
  });

  it("pages with limit and an opaque cursor; a forged cursor is INVALID_REQUEST", async () => {
    const ids: string[] = [];
    for (const objective of ["one", "two", "three"]) ids.push((await h.delegate(objective)).run_id);
    await inProject("web", "other");
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i++) {
      const page = await listOk({ limit: 1, ...(cursor !== undefined ? { cursor } : {}) });
      expect(page.runs).toHaveLength(1);
      seen.push(page.runs[0].run_id);
      cursor = page.next_cursor ?? undefined;
      if (i < 2) expect(typeof page.next_cursor).toBe("string");
      else expect(page.next_cursor).toBeNull();
    }
    expect(seen).toEqual(newestFirst(ids));
    const two = await listOk({ limit: 2 });
    expect(two.runs.map((r: Json) => r.run_id)).toEqual(newestFirst(ids).slice(0, 2));
    const rest = await listOk({ limit: 2, cursor: two.next_cursor });
    expect(rest.runs.map((r: Json) => r.run_id)).toEqual(newestFirst(ids).slice(2));
    expect(rest.next_cursor).toBeNull();

    const forged = await list({ cursor: Buffer.from("DROP TABLE run").toString("base64url") });
    expect(forged.body.error).toMatchObject({ code: "INVALID_REQUEST", details: { field: "cursor" } });
    expect((await list({ cursor: "x".repeat(129) })).body.error.code).toBe("INVALID_REQUEST");
    expect((await list({ limit: 0 })).body.error.code).toBe("INVALID_REQUEST");
    expect((await list({ limit: 201 })).body.error.code).toBe("INVALID_REQUEST");
  });

  it("is read-only: listing writes nothing to the ledger", async () => {
    await h.delegate("Fix the parser crash");
    const count = () =>
      (h.db.prepare("SELECT (SELECT COUNT(*) FROM run) + (SELECT COUNT(*) FROM run_event) AS n").get() as { n: number })
        .n;
    const before = count();
    await listOk({});
    await list({ project_id: "nope" });
    expect(count()).toBe(before);
  });
});
