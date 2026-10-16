/**
 * T14.4 (FR-CTL-06, ADR-0007) through the MCP server on fake adapters: over an operator cap `delegate_task` and
 * `continue_task` are refused with `ELIGIBILITY_NONE`, `details.reason = "BUDGET_EXHAUSTED"` and the needs-attention
 * reason `budget_exhausted`, no run row is written, the project's non-terminal runs show `budget_exhausted` on
 * `get_run` and `list_runs` (the T14.2 port, no server change), another project and a workspace-path run are still
 * admitted, and no message presents the cap as a provider limit. Fake CLIs only; nothing live.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedProject } from "../config/index.js";
import { BudgetEvaluator } from "../control/budgets.js";
import type { TrustProfile } from "../ledger/index.js";
import type { BudgetRefusalNotice } from "../lifecycle/index.js";
import { type Harness, type Json, startHarness } from "../routing/fixtures/harness.js";

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

const PROVIDER_LIMIT_WORDS = /provider|quota|\btpm\b|\brpm\b|subscription|rate.?limit|remaining/i;

let h: Harness;
let projectRoot: string;
let notices: BudgetRefusalNotice[];
beforeEach(async () => {
  projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-budget-mcp-")));
  const web = gitRepo(path.join(projectRoot, "web"));
  const api = gitRepo(path.join(projectRoot, "api"));
  const edit: TrustProfile = "edit-untrusted";
  notices = [];
  h = await startHarness({
    allowedRoots: [projectRoot],
    config: {
      projects: [project("web", web), project("api", api)],
      mcpClients: new Map([
        ["orch", { id: "orch", maxTrustProfile: edit, projects: ["web"] }],
        ["other", { id: "other", maxTrustProfile: edit, projects: ["web", "api"] }],
      ]),
    },
    // Project `web` may admit one run per UTC day; nothing else is capped (no global cap).
    lifecycle: ({ ledger }) => ({
      budgets: new BudgetEvaluator({
        ledger,
        settings: { global: {}, projects: new Map([["web", { runsPerDay: 1 }]]) },
      }),
      onBudgetRefused: (n: BudgetRefusalNotice) => notices.push(n),
    }),
  });
});
afterEach(async () => {
  await h.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

const delegate = (projectId: string, clientId = "orch") =>
  h.call(
    "delegate_task",
    { objective: "Fix the parser crash", project: projectId, trust_profile: "edit-untrusted" },
    clientId,
  );
const runCount = (): number => (h.db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n;

/** A run of `orch` in project `web` planted AWAITING_APPROVAL (its own reason ranks below `budget_exhausted`). */
function plantedAwaiting(): string {
  const session = h.ledger.createMetaSession({ objective: "o", projectId: "web" });
  return h.ledger.createRun({
    metaSessionId: session.id,
    state: "AWAITING_APPROVAL",
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "orch",
    projectId: "web",
  }).id;
}

describe("operator budget caps at admission over MCP (T14.4, FR-CTL-06)", () => {
  it("over the cap delegate_task is refused with the budget reason, writes nothing and flags the project's open runs", async () => {
    const first = await delegate("web");
    expect(first.isError, JSON.stringify(first.body)).toBe(false);
    await h.settle(first.body.run_id);
    const open = plantedAwaiting();
    expect((await h.ok("get_run", { run_id: open })).needs_attention).toEqual({
      active: true,
      reason: "budget_exhausted", // the cap is already reached: 2 rows today (the planted one counts as admitted)
    });
    const before = runCount();

    const refused = await delegate("web");
    expect(refused.isError).toBe(true);
    expect(refused.body.error, JSON.stringify(refused.body)).toMatchObject({
      code: "ELIGIBILITY_NONE",
      retryable: false,
      details: {
        reason: "BUDGET_EXHAUSTED",
        needs_attention_reason: "budget_exhausted",
        scope: "project",
        project_id: "web",
        cap: "runs_per_day",
        limit: 1,
        used: 2,
      },
    });
    expect(refused.body.error.details.window_ends_at).toMatch(/T00:00:00\.000Z$/);
    expect(refused.body.error.message).toMatch(/^operator budget cap runs_per_day reached for project web/);
    expect(JSON.stringify(refused.body)).not.toMatch(PROVIDER_LIMIT_WORDS);
    expect(runCount()).toBe(before); // no run row, no state (FRD §4 unchanged)
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ projectId: "web", refusal: { cap: "runs_per_day", scope: "project" } });

    // continue_task would create a new run row in the same project: the same refusal.
    const cont = await h.call("continue_task", {
      meta_session_id: first.body.meta_session_id,
      instruction: "And the tests",
    });
    expect(cont.isError).toBe(true);
    expect(cont.body.error, JSON.stringify(cont.body)).toMatchObject({
      code: "ELIGIBILITY_NONE",
      details: { reason: "BUDGET_EXHAUSTED" },
    });
    expect(runCount()).toBe(before);

    // get_run and list_runs agree, and a terminal run of the project never carries the flag.
    const rows: Json[] = (await h.ok("list_runs", { project_id: "web" })).runs;
    for (const row of rows) expect(row).toEqual(await h.ok("get_run", { run_id: row.run_id }));
    expect(rows.find((r) => r.run_id === open)?.needs_attention).toEqual({ active: true, reason: "budget_exhausted" });
    expect(rows.find((r) => r.run_id === first.body.run_id)?.needs_attention).toEqual({ active: false });
  });

  it("the cap is the project's own: another project and a workspace-path run are still admitted", async () => {
    await h.settle(
      (
        await h.ok("delegate_task", {
          objective: "one",
          project: "web",
          trust_profile: "edit-untrusted",
        })
      ).run_id,
    );
    expect((await delegate("web")).body.error?.details?.reason).toBe("BUDGET_EXHAUSTED");
    const api = await delegate("api", "other");
    expect(api.isError, JSON.stringify(api.body)).toBe(false);
    await h.lifecycle.waitForTerminal(api.body.run_id);
    expect((await h.ok("get_run", { run_id: api.body.run_id }, "other")).status).toBe("SUCCEEDED");
    const bare = await h.call("delegate_task", {
      objective: "two",
      workspace_path: h.repo,
      trust_profile: "edit-untrusted",
    });
    expect(bare.isError, JSON.stringify(bare.body)).toBe(false);
    await h.settle(bare.body.run_id);
    expect(notices.map((n) => n.projectId)).toEqual(["web"]);
  });
});
