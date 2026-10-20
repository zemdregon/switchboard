/**
 * Migration 0033 (ADR-0069): `git_push` is rebuilt so `requested_by` also takes `mcp_client:<id>` (every row, id and
 * the append-only guards kept), and the append-only `pull_request` table is created.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, MIGRATIONS, migrate } from "./index.js";

let dir: string;
let d: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-m33-"));
  d = new Database(path.join(dir, "m33.sqlite"));
  d.pragma("foreign_keys = ON");
});
afterEach(() => {
  d.close();
  rmSync(dir, { recursive: true, force: true });
});

const push = (ledger: ReturnType<typeof createLedger>, runId: string, requestedBy: string) =>
  ledger.recordGitPush({
    runId: null,
    eventRunId: runId,
    projectId: "p",
    contextId: "main",
    remote: "origin",
    ref: "refs/heads/sb/x",
    headSha: "a".repeat(40),
    outcome: "ACCEPTED",
    detail: "ACCEPTED",
    requestedBy: requestedBy as "operator",
    eventPayload: {},
  });

describe("migration 0033 (mcp_publication)", () => {
  it("keeps every git_push row and widens requested_by to mcp_client:<id> only", () => {
    migrate(
      d,
      undefined,
      MIGRATIONS.filter((m) => m.version <= 32),
    );
    const ledger = createLedger(d, { ids: createIdGenerator() });
    const session = ledger.createMetaSession({ objective: "t" });
    const run = ledger.createRun({
      metaSessionId: session.id,
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h",
      clientId: "c",
    });
    const before = push(ledger, run.id, "operator").row;
    expect(() => push(ledger, run.id, "mcp_client:linus")).toThrow(/CHECK/u);
    expect(
      migrate(
        d,
        undefined,
        MIGRATIONS.filter((m) => m.version <= 33),
      ),
    ).toEqual([33]);
    expect(d.prepare("SELECT * FROM git_push").all()).toEqual([before]);
    expect(push(ledger, run.id, "mcp_client:linus").row.requested_by).toBe("mcp_client:linus");
    for (const bad of ["mcp_client:", "mcp_clientx", "client:linus", "MCP_CLIENT:linus"]) {
      expect(() => push(ledger, run.id, bad), bad).toThrow(/CHECK/u);
    }
    expect(() => d.prepare("UPDATE git_push SET detail = 'x'").run()).toThrow(/append-only/u);
    expect(() => d.prepare("DELETE FROM git_push").run()).toThrow(/append-only/u);
    expect(d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'git_push_run'").get()).toEqual({
      name: "git_push_run",
    });

    const pr = ledger.recordPullRequest({
      run_id: run.id,
      meta_session_id: session.id,
      push_id: before.id,
      client_id: "linus",
      repo: "acme/web",
      number: 7,
      url: "https://github.com/acme/web/pull/7",
      branch: "sb/x",
      base_ref: "main",
      head_sha: "a".repeat(40),
      draft: 0,
      action: "created",
    });
    expect(pr.id).toMatch(/^prq_/u);
    expect(ledger.listPullRequestsForRun(run.id)).toEqual([pr]);
    expect(ledger.listPullRequestsForMetaSession(session.id)).toEqual([pr]);
    const event = ledger.listRunEvents(run.id).find((e) => e.type === "pull_request_opened");
    expect(JSON.parse(event?.payload_json ?? "{}")).toMatchObject({
      pull_request_id: pr.id,
      number: 7,
      action: "created",
    });
    expect(() => d.prepare("UPDATE pull_request SET number = 8").run()).toThrow(/append-only/u);
    expect(() => d.prepare("DELETE FROM pull_request").run()).toThrow(/append-only/u);
    expect(() =>
      ledger.recordPullRequest({ ...pr, url: "https://evil.example/acme/web/pull/7", action: "created" }),
    ).toThrow(/CHECK/u);
  });
});
