/**
 * T9.14 operator command `switchboard git ack-secret-scan` (FR-GIT-11, FR-CTL-03; LLD §20.9; ADR-0061 amendment
 * 2026-10-20). Temporary repositories and a LOCAL bare remote; no provider CLI, no network. The canary is a synthetic
 * AWS access-key-id shape, never a real credential.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { loadConfig } from "../config/index.js";
import { needsAttentionOf } from "../control/needs-attention.js";
import { GitPublisher, GitPusher, pushContextResolver } from "../git/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, LEDGER_FILE_NAME, openLedger } from "../ledger/index.js";
import { acquireDataDirLock } from "../lock/index.js";
import {
  PROJECT_TOOL_NAMES,
  SEARCH_TOOL_NAMES,
  SKILL_TOOL_NAMES,
  TOOL_NAMES,
  WORK_QUEUE_TOOL_NAMES,
} from "../mcp/schemas.js";
import { WorkspaceManager } from "../workspace/index.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

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
const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };
const CANARY = "AKIACANARY0000000000";

let tmp: string;
let repo: string;
let dataDir: string;
let configPath: string;
let env: Record<string, string | undefined>;

function writeConfig(push: Record<string, unknown>): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [path.dirname(repo)],
      mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted", projects: ["web"] }],
      projects: [
        {
          id: "web",
          name: "Web",
          contexts: [{ id: "main", kind: "repository", path: repo, base_ref: "main", push, identity: IDENTITY }],
        },
      ],
    }),
  );
}

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env,
    user: "tester",
  };
  const code = await main([...args, "--config", configPath], io);
  return { code, out: out.join(""), err: err.join("") };
}

/** One meta-session with one RUNNING run that published `content` at `file`; the ledger is closed after. */
async function seedCommit(content: string, file = "creds.txt"): Promise<{ sessionId: string; runId: string }> {
  const db = openLedger(dataDir);
  try {
    const ids = createIdGenerator();
    const ledger = createLedger(db, { ids });
    const mgr = new WorkspaceManager({
      db,
      artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
      dataDir,
      allowedRoots: [path.dirname(repo)],
      ids,
    });
    const session = ledger.createMetaSession({ objective: "o", repoRoot: repo, projectId: "web" });
    const r = ledger.createRun({
      metaSessionId: session.id,
      state: "RUNNING",
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h",
      clientId: "c1",
      provider: "fake",
      projectId: "web",
    });
    const ws = await mgr.prepare({
      metaSessionId: session.id,
      runId: r.id,
      workspace: repo,
      trustProfile: "edit-untrusted",
    });
    if (ws.mode !== "worktree") throw new Error("expected a worktree");
    writeFileSync(path.join(ws.worktreePath, file), content);
    await new GitPublisher({ db, scratchDir: path.join(tmp, "scratch"), ids }).commit({
      runId: r.id,
      message: `Add ${file}`,
      identity: IDENTITY,
      projectId: "web",
      contextId: "main",
    });
    return { sessionId: session.id, runId: r.id };
  } finally {
    db.close();
  }
}

function withLedger<T>(fn: (db: ReturnType<typeof openLedger>, ledger: ReturnType<typeof createLedger>) => T): T {
  const db = openLedger(dataDir);
  try {
    return fn(db, createLedger(db));
  } finally {
    db.close();
  }
}

const blocked = (runId: string) =>
  withLedger((_db, ledger) => {
    const rec = ledger.getRunRecord(runId);
    if (!rec) throw new Error("no run");
    return needsAttentionOf(ledger, rec, { now: new Date() });
  });
const ackEvents = () =>
  withLedger((db) =>
    (
      db
        .prepare("SELECT run_id, payload_json FROM run_event WHERE type = 'secret_scan_acknowledged' ORDER BY ts, id")
        .all() as { run_id: string; payload_json: string }[]
    ).map((r) => ({ run_id: r.run_id, p: JSON.parse(r.payload_json) as Record<string, unknown> })),
  );
const ledgerText = () => readFileSync(path.join(dataDir, LEDGER_FILE_NAME)).toString("latin1");

async function refusedPush(sessionId: string): Promise<string> {
  const r = await run(["git", "push", sessionId, "--json"]);
  const j = JSON.parse(r.out);
  expect(j).toMatchObject({ outcome: "REFUSED_POLICY", reason: "SECRET_SCAN_BLOCKED" });
  // ADR-0075: the JSON names each finding (rule id, path, line) and never the value.
  expect(j).toMatchObject({
    findings: [{ rule_id: "aws_access_key_id", path: "creds.txt", line: 1 }],
    finding_count: 1,
  });
  expect(r.out).not.toContain(CANARY);
  return j.push_id as string;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-cli-ack-")));
  repo = path.join(tmp, "repos", "web");
  const bare = path.join(tmp, "remote.git");
  mkdirSync(repo, { recursive: true });
  mkdirSync(path.join(tmp, "home"));
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  g(tmp, "init", "-q", "--bare", "-b", "main", bare);
  g(repo, "remote", "add", "origin", bare);
  dataDir = path.join(tmp, "data");
  configPath = path.join(tmp, "config.json");
  env = { PATH: process.env.PATH, HOME: path.join(tmp, "home") };
  writeConfig({ policy: "branch", remote: "origin", branch_prefix: "ops/" });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("switchboard git ack-secret-scan (T9.14, LLD §20.9)", () => {
  it("ADR-0075: the human output of a refused git push names the finding, never the value", async () => {
    const s = await seedCommit(`${CANARY}\n`);
    const r = await run(["git", "push", s.sessionId]);
    expect(r.out).toContain(
      "push refused (SECRET_SCAN_BLOCKED): 1 secret-scan finding: aws_access_key_id at creds.txt:1; the pre-push",
    );
    expect(r.out + r.err).not.toContain(CANARY);
  });

  it("clears secret_scan_blocked for the refusal, is idempotent and never lets the push through", async () => {
    const s = await seedCommit(`${CANARY}\n`);
    const pushId = await refusedPush(s.sessionId);
    expect(blocked(s.runId)).toEqual({ active: true, reason: "secret_scan_blocked" });

    const r = await run(["git", "ack-secret-scan", pushId, "--json"]);
    expect(r.code, r.out + r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({
      push_id: pushId,
      outcome: "acknowledged",
      meta_session_id: s.sessionId,
      recorded_on_run: s.runId,
      ref: `refs/heads/ops/${s.sessionId}`,
      acknowledged_by: "tester",
      still_blocked: false,
      daemon_running: false,
    });
    expect(j.event_id).toMatch(/^evt_/u);
    expect(ackEvents()).toEqual([
      {
        run_id: s.runId,
        p: { push_id: pushId, acknowledged_by: "tester", ref: `refs/heads/ops/${s.sessionId}`, head_sha: j.head_sha },
      },
    ]);
    expect(blocked(s.runId)).toEqual({ active: false });

    // A second acknowledgement exits 0 and writes nothing.
    const again = await run(["git", "ack-secret-scan", pushId, "--json"]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out)).toMatchObject({ outcome: "already_acknowledged", event_id: null });
    expect(ackEvents()).toHaveLength(1);
    expect((await run(["git", "ack-secret-scan", pushId])).out).toContain("already acknowledged");

    // The same canary still refuses (operator push and an exempt approved bypass run); the new refusal re-raises the flag.
    const second = await refusedPush(s.sessionId);
    expect(second).not.toBe(pushId);
    expect(blocked(s.runId)).toEqual({ active: true, reason: "secret_scan_blocked" });
    const config = loadConfig({ argv: ["--config", configPath], env });
    const db = openLedger(dataDir);
    try {
      const res = await new GitPusher({
        db,
        resolveContext: pushContextResolver(config.projects),
        sourceEnv: env,
        ids: createIdGenerator(),
      }).push({
        metaSessionId: s.sessionId,
        requestedBy: "agent_tool",
        runId: s.runId,
        agentReach: { ok: true, reason: "bypass_exempt" },
      });
      expect(res).toMatchObject({ outcome: "REFUSED_POLICY", reason: "SECRET_SCAN_BLOCKED", pushed: false });
    } finally {
      db.close();
    }
    // The first refusal is now superseded, but it was acknowledged before: idempotent exit 0, the flag stays raised.
    const old = await run(["git", "ack-secret-scan", pushId, "--json"]);
    expect(old.code).toBe(0); // already acknowledged wins over superseded (check order 3 before 4)
    expect(JSON.parse(old.out)).toMatchObject({ outcome: "already_acknowledged", still_blocked: true });
    expect(ackEvents()).toHaveLength(1);
    expect(ledgerText()).not.toContain(CANARY);
  });

  it("refuses a superseded refusal and acknowledges only the latest", async () => {
    const s = await seedCommit(`${CANARY}\n`);
    const first = await refusedPush(s.sessionId);
    const second = await refusedPush(s.sessionId);
    const r = await run(["git", "ack-secret-scan", first, "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).error).toMatchObject({ code: "REFUSED" });
    expect(JSON.parse(r.out).error.message).toContain(second);
    expect(ackEvents()).toEqual([]);
    expect((await run(["git", "ack-secret-scan", second, "--json"])).code).toBe(0);
    expect(blocked(s.runId)).toEqual({ active: false });
  });

  it("refuses an accepted push and a refusal for another reason; unknown and malformed ids", async () => {
    const clean = await seedCommit("nothing secret\n", "notes.txt");
    const ok = JSON.parse((await run(["git", "push", clean.sessionId, "--json"])).out);
    expect(ok.outcome).toBe("ACCEPTED");
    const a = await run(["git", "ack-secret-scan", ok.push_id, "--json"]);
    expect(a.code).toBe(1);
    expect(JSON.parse(a.out).error.code).toBe("REFUSED");

    writeConfig({ policy: "none" });
    const s = await seedCommit(`${CANARY}\n`);
    const none = JSON.parse((await run(["git", "push", s.sessionId, "--json"])).out);
    expect(none.reason).toBe("POLICY_NONE");
    expect(JSON.parse((await run(["git", "ack-secret-scan", none.push_id, "--json"])).out).error.code).toBe("REFUSED");

    expect(JSON.parse((await run(["git", "ack-secret-scan", "gps_nope", "--json"])).out).error.code).toBe("NOT_FOUND");
    expect((await run(["git", "ack-secret-scan", "sess_x"])).code).toBe(2);
    expect((await run(["git", "ack-secret-scan"])).code).toBe(2);
    expect((await run(["git", "ack-secret-scan", "gps_a", "gps_b"])).code).toBe(2);
    expect(ackEvents()).toEqual([]);
  });

  it("refuses a git_push row that has no git_push event (fail closed)", async () => {
    await seedCommit(`${CANARY}\n`);
    withLedger((db) =>
      db
        .prepare(
          `INSERT INTO git_push (id, run_id, project_id, context_id, remote, ref, head_sha, outcome, detail,
             requested_by, created_at) VALUES ('gps_orphan', NULL, 'web', 'main', 'origin', 'refs/heads/ops/x',
             ?, 'REFUSED_POLICY', 'SECRET_SCAN_BLOCKED', 'operator', ?)`,
        )
        .run("0".repeat(40), new Date().toISOString()),
    );
    const r = await run(["git", "ack-secret-scan", "gps_orphan", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).error.code).toBe("REFUSED");
    expect(ackEvents()).toEqual([]);
  });

  it("writes while a serve daemon holds the data-directory lock", async () => {
    const s = await seedCommit(`${CANARY}\n`);
    const pushId = await refusedPush(s.sessionId);
    const lock = acquireDataDirLock(dataDir);
    try {
      const r = await run(["git", "ack-secret-scan", pushId, "--json"]);
      expect(r.code, r.out + r.err).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({ outcome: "acknowledged", daemon_running: true });
    } finally {
      lock.release();
    }
    expect(ackEvents()).toHaveLength(1);
  });

  it("is reachable from no MCP tool or worker-facing module", () => {
    const names: string[] = [
      ...TOOL_NAMES,
      ...PROJECT_TOOL_NAMES,
      ...SEARCH_TOOL_NAMES,
      ...WORK_QUEUE_TOOL_NAMES,
      ...SKILL_TOOL_NAMES,
    ];
    for (const n of names) expect(n).not.toMatch(/ack|acknowledg|secret/u);
    // Only the CLI entry imports the command module (the module itself names the file only in comments).
    const src = path.resolve(__dirname, "..");
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
          if (readFileSync(p, "utf8").includes('secret-scan-ack.js"')) importers.push(path.relative(src, p));
        }
      }
    };
    walk(src);
    expect(importers).toEqual(["cli/main.ts"]);
  });
});
