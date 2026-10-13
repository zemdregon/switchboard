/**
 * `projects list|show|approve` with dynamic projects (T9.9; FR-PRJ-10, FRD BR-32, ADR-0030). The ledger is written
 * through the same store the MCP tools use; no provider CLI.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdGenerator } from "../ids/index.js";
import { openLedger } from "../ledger/index.js";
import { LOCK_FILE_NAME } from "../lock/index.js";
import { DynamicProjectStore } from "../projects/index.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

let tmp: string;
let repo: string;
let dataDir: string;
let configPath: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-prj-dyn-")));
  repo = path.join(tmp, "roots", "repo");
  mkdirSync(repo, { recursive: true });
  const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: GIT_ENV });
  g("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "x\n");
  g("add", "-A");
  g("-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  dataDir = path.join(tmp, "data");
  configPath = path.join(tmp, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [path.join(tmp, "roots")],
      mcp_clients: [
        { id: "mgr", max_trust_profile: "edit-untrusted", manage_projects: true, max_push_policy: "branch" },
      ],
      projects: [
        {
          id: "web-app",
          name: "Configured",
          contexts: [{ id: "main", kind: "repository", path: repo, base_ref: "main" }],
        },
      ],
    }),
  );
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: {},
    user: "operator1",
  };
  const code = await main([...args, "--config", configPath], io);
  return { code, out: out.join(""), err: err.join("") };
}

/** Writes revisions as the MCP tools would (they share this store). */
function seed(revs: ("ACTIVE" | "PENDING_APPROVAL")[], id = "dyn-app") {
  const db = openLedger(dataDir);
  try {
    const store = new DynamicProjectStore(db, { ids: createIdGenerator() });
    revs.forEach((status, i) => {
      store.appendRevision(
        {
          projectId: id,
          clientId: "mgr",
          definition: {
            id,
            name: `rev ${i + 1}`,
            contexts: [
              {
                id: "main",
                kind: "repository",
                path: repo,
                base_ref: "main",
                ...(status === "PENDING_APPROVAL"
                  ? {
                      push: { policy: "branch" as const, remote: "origin", branch_prefix: "sb/" },
                      identity: { name: "A", email: "a@b.c" },
                    }
                  : {}),
              },
            ],
          },
          status,
          approvalReasons: status === "PENDING_APPROVAL" ? ["push_policy", "commit_identity"] : [],
          action: i === 0 ? "create_project" : "update_project",
        },
        () => undefined,
      );
    });
  } finally {
    db.close();
  }
}

function decisions(): { project_id: string; revision: number; decision: string; decided_by: string }[] {
  const db = openLedger(dataDir);
  try {
    return db.prepare("SELECT project_id, revision, decision, decided_by FROM project_revision_decision").all() as {
      project_id: string;
      revision: number;
      decision: string;
      decided_by: string;
    }[];
  } finally {
    db.close();
  }
}

describe("projects list | show with dynamic projects", () => {
  it("lists configured and dynamic projects with source, creator, state and revision; no ledger means none", async () => {
    const empty = await run(["projects", "list", "--json"]);
    expect(JSON.parse(empty.out).projects.map((p: { source: string }) => p.source)).toEqual(["config"]);
    seed(["PENDING_APPROVAL"]);
    const list = await run(["projects", "list", "--json"]);
    expect(list.code).toBe(0);
    const projects = JSON.parse(list.out).projects;
    expect(projects[0]).toMatchObject({ id: "web-app", source: "config" });
    expect(projects[1]).toMatchObject({
      id: "dyn-app",
      source: "dynamic",
      creator: "mgr",
      revision: 1,
      state: "pending_approval",
      pending_revision: 1,
      approval_needed: ["push_policy", "commit_identity"],
      contexts: [{ path: repo, push: { policy: "branch" }, identity: { name: "A", email: "a@b.c" } }],
    });
    expect(projects[1].in_force_revision).toBeUndefined();
    const text = await run(["projects", "list"]);
    expect(text.out).toContain("dyn-app\thost\t1 context(s)\trev 1\tdynamic (client mgr, revision 1 pending_approval");
    const show = await run(["projects", "show", "dyn-app", "--json"]);
    expect(JSON.parse(show.out)).toMatchObject({
      project: { id: "dyn-app", source: "dynamic" },
      revisions: [{ revision: 1, state: "pending_approval", approval_needed: ["push_policy", "commit_identity"] }],
    });
    expect((await run(["projects", "show", "dyn-app"])).out).toContain(
      "needs approval for: push_policy, commit_identity",
    );
  });
});

describe("projects approve", () => {
  it("approves the single pending revision and records who decided", async () => {
    seed(["PENDING_APPROVAL"]);
    const r = await run(["projects", "approve", "dyn-app", "--json"]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      project_id: "dyn-app",
      revision: 1,
      decision: "approved",
      state: "approved",
      in_force_revision: 1,
      decided_by: "operator1",
      daemon_running: false,
    });
    expect(decisions()).toEqual([
      { project_id: "dyn-app", revision: 1, decision: "APPROVED", decided_by: "operator1" },
    ]);
    // a second decision is refused
    const again = await run(["projects", "approve", "dyn-app", "--json"]);
    expect(again.code).toBe(1);
    expect(JSON.parse(again.out).error.code).toBe("REFUSED");
  });

  it("needs --revision once there is more than one revision, and refuses a superseded one", async () => {
    seed(["ACTIVE", "PENDING_APPROVAL", "PENDING_APPROVAL"]);
    const bare = await run(["projects", "approve", "dyn-app"]);
    expect(bare.code).toBe(2);
    expect(bare.err).toContain("--revision");
    const old = await run(["projects", "approve", "dyn-app", "--revision", "2", "--json"]);
    expect(JSON.parse(old.out).error).toMatchObject({ code: "REFUSED" });
    expect(JSON.parse(old.out).error.message).toMatch(/superseded/);
    const rej = await run(["projects", "approve", "dyn-app", "--revision", "3", "--reject", "--json"]);
    expect(JSON.parse(rej.out)).toMatchObject({ revision: 3, decision: "rejected", in_force_revision: 1 });
    expect(decisions()).toEqual([
      { project_id: "dyn-app", revision: 3, decision: "REJECTED", decided_by: "operator1" },
    ]);
  });

  it("refuses configured, unknown and active revisions, and bad flags", async () => {
    seed(["ACTIVE"]);
    expect(JSON.parse((await run(["projects", "approve", "web-app", "--json"])).out).error.code).toBe("REFUSED");
    expect(JSON.parse((await run(["projects", "approve", "nope", "--json"])).out).error.code).toBe("NOT_FOUND");
    expect(JSON.parse((await run(["projects", "approve", "dyn-app", "--json"])).out).error.message).toMatch(
      /only a revision waiting for approval/,
    );
    expect((await run(["projects", "approve", "dyn-app", "--revision", "0"])).code).toBe(2);
    expect((await run(["projects", "approve", "dyn-app", "--revision", "1x"])).code).toBe(2);
    expect((await run(["projects", "list", "--reject"])).code).toBe(2);
    expect((await run(["runs", "list", "--revision", "1"])).code).toBe(2);
    expect((await run(["projects", "approve"])).code).toBe(2);
    expect(decisions()).toEqual([]);
  });

  it("writes the decision while a serve daemon holds the lock (like approve/deny)", async () => {
    seed(["PENDING_APPROVAL"]);
    writeFileSync(path.join(dataDir, LOCK_FILE_NAME), `${process.pid}\n`); // a live owner
    const r = await run(["projects", "approve", "dyn-app", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ decision: "approved", daemon_running: true });
  });
});
