/**
 * Process-level tests for `switchboard serve` (T2.6; FR-OPS-01, FR-OPS-04, FR-MCP-01, FR-EXE-06, NFR-REL-01,
 * NFR-SEC-06). Each test spawns the real CLI entry (`src/cli/bin.ts`, run as TypeScript through the test-only resolve
 * hook in src/reconcile/fixtures) as a child with a temp config and data dir, and talks MCP to it over stdio.
 *
 * The fake adapter is enabled only through the test-only environment switch (`SWITCHBOARD_TEST_FAKE_ADAPTER`, see
 * ./serve.ts); no provider CLI, login or network is used. Every spawned process group is killed in `afterEach`, and the
 * tests assert that no provider process survives a run.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { groupAlive } from "../exec/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, LEDGER_FILE_NAME, openLedger } from "../ledger/index.js";
import { LOCK_FILE_NAME } from "../lock/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import type { CliIo } from "./io.js";
import { main } from "./main.js";
import {
  readFakeSwitch,
  TEST_CLOCK_OFFSET_ENV,
  TEST_FAKE_ADAPTER_ENV,
  TEST_FAKE_ADAPTER_VALUE,
  TEST_FAKE_SCENARIO_ENV,
} from "./serve.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "bin.ts");
const TS_REGISTER = path.join(HERE, "..", "reconcile", "fixtures", "ts-register.mjs");
const NODE_ARGS = ["--experimental-transform-types", "--no-warnings", "--import", TS_REGISTER, BIN];

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

let root: string;
let repo: string;
let dataDir: string;
let configPath: string;
const cleanup: (() => void | Promise<void>)[] = [];
/** Provider process groups seen during a test; each must be gone at the end (no orphans). */
const groups = new Set<number>();

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-serve-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(path.join(root, "home"));
  // PATH for the daemon holds git only, so no real provider CLI installed on this host is ever probed (AGENTS.md:
  // tests never call a provider); claude and codex then report "not found" and the fake is the only usable adapter.
  mkdirSync(path.join(root, "bin"));
  symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), path.join(root, "bin", "git"));
  configPath = path.join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [root],
      mcp_clients: [{ id: "orch", max_trust_profile: "edit-untrusted" }],
    }),
  );
});

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) {
    try {
      await fn();
    } catch {
      // best effort
    }
  }
  for (const pgid of groups) {
    expect(groupAlive(pgid), `provider process group ${pgid} survived`).toBe(false);
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // gone
    }
  }
  groups.clear();
  rmSync(root, { recursive: true, force: true });
});

function childEnv(scenario?: string): Record<string, string> {
  return {
    PATH: path.join(root, "bin"),
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "home", ".config"),
    XDG_DATA_HOME: path.join(root, "home", ".local", "share"),
    [TEST_FAKE_ADAPTER_ENV]: TEST_FAKE_ADAPTER_VALUE,
    ...(scenario ? { [TEST_FAKE_SCENARIO_ENV]: scenario } : {}),
  };
}

const serveArgs = (client = "orch") => [...NODE_ARGS, "serve", "--client", client, "--config", configPath];

interface Connected {
  client: Client;
  transport: StdioClientTransport;
  pid: number;
  stderr: () => string;
}

/** Start `serve` and connect an SDK stdio client to it. */
async function connect(
  scenario?: string,
  opts: { client?: string; env?: Record<string, string> } = {},
): Promise<Connected> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: serveArgs(opts.client),
    env: { ...childEnv(scenario), ...opts.env },
    stderr: "pipe",
  });
  let err = "";
  transport.stderr?.on("data", (d: Buffer) => {
    err += d.toString();
  });
  const client = new Client({ name: "serve-test", version: "0.0.0" });
  await client.connect(transport);
  const pid = transport.pid;
  if (pid === null) throw new Error("serve did not start");
  cleanup.push(async () => {
    await client.close();
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  });
  return { client, transport, pid, stderr: () => err };
}

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON
type Json = Record<string, any>;

async function call(c: Client, name: string, args: Json = {}): Promise<{ isError: boolean; body: Json }> {
  const res = await c.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
  return { isError: res.isError === true, body: JSON.parse(text) as Json };
}

async function pollStatus(c: Client, runId: string, want: (s: string) => boolean, ms = 30_000): Promise<Json> {
  const end = Date.now() + ms;
  for (;;) {
    const r = await call(c, "get_run", { run_id: runId });
    expect(r.isError).toBe(false);
    if (want(r.body.status)) return r.body;
    if (Date.now() > end) throw new Error(`run ${runId} stuck in ${r.body.status}`);
    await new Promise((res) => setTimeout(res, 50));
  }
}
const TERMINAL = (s: string) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(s);

const delegate = (c: Client) =>
  call(c, "delegate_task", {
    objective: "add a feature",
    workspace_path: repo,
    trust_profile: "edit-untrusted",
    routing: { provider_preference: "fake", require_provider: true },
  });

/** Read the provider process group a RUNNING run recorded (read-only; the daemon holds the write side). */
function recordedGroup(runId: string): number {
  const db = new Database(path.join(dataDir, LEDGER_FILE_NAME), { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT pgid FROM run WHERE id = ?").get(runId) as { pgid: number | null } | undefined;
    if (!row?.pgid) throw new Error(`run ${runId} has no recorded process group`);
    groups.add(row.pgid);
    return row.pgid;
  } finally {
    db.close();
  }
}

async function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

/** Wait until a (child) process has exited and been reaped. */
async function waitDead(pid: number, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > end) throw new Error(`process ${pid} did not exit`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function runningRun(c: Client): Promise<{ runId: string; pgid: number }> {
  const d = await delegate(c);
  expect(d.isError, JSON.stringify(d.body)).toBe(false);
  const runId = d.body.run_id as string;
  await pollStatus(c, runId, (s) => s === "RUNNING" || TERMINAL(s));
  const body = (await call(c, "get_run", { run_id: runId })).body;
  expect(body.status).toBe("RUNNING");
  // pid/pgid are committed before the run reads output; poll briefly in case RUNNING was observed first.
  const end = Date.now() + 5000;
  for (;;) {
    try {
      return { runId, pgid: recordedGroup(runId) };
    } catch (err) {
      if (Date.now() > end) throw err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

describe("serve over stdio (process level)", () => {
  it("writes only MCP framing to stdout, logs JSON lines to stderr and exits cleanly when stdin closes", async () => {
    const child = spawn(process.execPath, serveArgs(), { env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    cleanup.push(() => void child.kill("SIGKILL"));
    const stdoutLines: string[] = [];
    let raw = "";
    child.stdout.on("data", (d: Buffer) => {
      raw += d.toString();
    });
    createInterface({ input: child.stdout }).on("line", (l) => stdoutLines.push(l));
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const send = (m: Json) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const waitFor = async (id: number) => {
      const end = Date.now() + 20_000;
      while (!stdoutLines.some((l) => (JSON.parse(l) as Json).id === id)) {
        if (Date.now() > end) throw new Error(`no response ${id}; stderr: ${stderr}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    });
    await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await waitFor(2);
    expect(existsSync(path.join(dataDir, LOCK_FILE_NAME))).toBe(true);
    child.stdin.end();
    const exit = await exitOf(child);
    expect(exit).toEqual({ code: 0, signal: null });

    // stdout: nothing but newline-delimited JSON-RPC 2.0 messages.
    expect(raw.endsWith("\n")).toBe(true);
    expect(stdoutLines.length).toBe(2);
    for (const l of stdoutLines) expect((JSON.parse(l) as Json).jsonrpc).toBe("2.0");
    const tools = (JSON.parse(stdoutLines[1] as string) as Json).result.tools.map((t: Json) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["delegate_task", "get_run", "cancel_run", "list_capabilities"]));

    // stderr: JSON lines (TDD §3.3), including reconciliation before serving and the test-only warning.
    const logs = stderr
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Json);
    const msgs = logs.map((l) => l.msg as string);
    expect(msgs.indexOf("startup reconciliation finished")).toBeLessThan(msgs.indexOf("serving MCP on stdio"));
    expect(msgs).toContain("TEST-ONLY fake adapter enabled; it is not a real provider");
    expect(logs.find((l) => l.msg === "serving MCP on stdio")?.adapters).toEqual(["claude", "codex", "fake"]);
    expect(msgs.at(-1)).toBe("stopped");
    // The lock is released on shutdown.
    expect(existsSync(path.join(dataDir, LOCK_FILE_NAME))).toBe(false);
  }, 30_000);

  it("runs delegate_task -> get_run -> SUCCEEDED end to end against the test-only fake adapter", async () => {
    const c = await connect();
    const d = await delegate(c.client);
    expect(d.isError, JSON.stringify(d.body)).toBe(false);
    expect(TERMINAL(d.body.status)).toBe(false);
    const done = await pollStatus(c.client, d.body.run_id, TERMINAL);
    expect(done.status, c.stderr()).toBe("SUCCEEDED");
    expect(done.provider.adapter).toBe("fake");
    const pgid = recordedGroup(d.body.run_id);
    expect(groupAlive(pgid)).toBe(false);
  }, 30_000);

  it("refuses a second serve on the same data directory while the first holds the lock", async () => {
    const first = await connect();
    const second = spawn(process.execPath, serveArgs(), { env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    cleanup.push(() => void second.kill("SIGKILL"));
    let out = "";
    let err = "";
    second.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    second.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    const exit = await exitOf(second);
    expect(exit.code).toBe(1);
    expect(err).toContain(`Another switchboard serve (pid ${first.pid}) already holds the data directory`);
    expect(out).toBe("");
    // The first daemon is unaffected.
    const caps = await call(first.client, "list_capabilities");
    expect(caps.isError, JSON.stringify(caps.body)).toBe(false);
  }, 30_000);

  it("after SIGKILL mid-run, the next serve reconciles the run to FAILED/PROCESS_CRASH and leaves no orphan", async () => {
    const a = await connect("hang");
    const { runId, pgid } = await runningRun(a.client);
    expect(groupAlive(pgid)).toBe(true);

    process.kill(a.pid, "SIGKILL");
    await waitDead(a.pid);
    // The provider group outlives its controller (it is detached into its own group) until reconciliation.
    expect(groupAlive(pgid)).toBe(true);
    expect(existsSync(path.join(dataDir, LOCK_FILE_NAME))).toBe(true); // stale lock left behind by SIGKILL

    const b = await connect();
    const after = await call(b.client, "get_run", { run_id: runId });
    expect(after.body.status, b.stderr()).toBe("FAILED");
    expect(after.body.failure_code).toBe("PROCESS_CRASH");
    expect(groupAlive(pgid), b.stderr()).toBe(false);
  }, 60_000);

  it("applies an operator `runs cancel` written while the daemon is running", async () => {
    const c = await connect("hang");
    const { runId, pgid } = await runningRun(c.client);
    const out: string[] = [];
    const io: CliIo = { stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, env: {}, user: "op" };
    expect(await main(["runs", "cancel", runId, "--config", configPath, "--json"], io)).toBe(0);
    expect((JSON.parse(out.join("")) as Json).outcome).toBe("requested");
    const done = await pollStatus(c.client, runId, TERMINAL);
    expect(done.status).toBe("CANCELLED");
    expect(groupAlive(pgid)).toBe(false);
  }, 60_000);

  it("shuts down gracefully on SIGTERM: in-flight runs end CANCELLED, the lock is released, no orphans", async () => {
    const c = await connect("hang");
    const { runId, pgid } = await runningRun(c.client);
    process.kill(c.pid, "SIGTERM");
    await waitDead(c.pid);
    expect(groupAlive(pgid)).toBe(false);
    expect(existsSync(path.join(dataDir, LOCK_FILE_NAME))).toBe(false);
    expect(c.stderr()).toContain('"reason":"SIGTERM"');
    const db = new Database(path.join(dataDir, LEDGER_FILE_NAME), { readonly: true });
    try {
      expect((db.prepare("SELECT state FROM run WHERE id = ?").get(runId) as { state: string }).state).toBe(
        "CANCELLED",
      );
    } finally {
      db.close();
    }
  }, 60_000);
});

describe("serve runs retention GC after reconciliation (T3.12; FR-WS-07, NFR-DATA-01)", () => {
  const DAY = 86_400_000;

  /** A meta-session with one run, a real worktree and a `switchboard/` branch, last active `ageDays` ago. */
  async function seedUnit(ageDays: number, state: "SUCCEEDED" | "AWAITING_APPROVAL" = "SUCCEEDED") {
    const at = new Date(Date.now() - ageDays * DAY);
    const db = openLedger(dataDir);
    try {
      const ids = createIdGenerator();
      const ledger = createLedger(db, { ids, now: () => at });
      const sess = ledger.createMetaSession({ objective: "o", repoRoot: repo });
      const run = ledger.createRun({
        metaSessionId: sess.id,
        trustProfile: "edit-untrusted",
        policySnapshot: {},
        request: {},
        requestHash: "h",
        clientId: "orch",
        state: "SUCCEEDED",
      });
      const m = new WorkspaceManager({
        db,
        artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
        dataDir,
        allowedRoots: [root],
        ids,
        now: () => at,
      });
      const ws = await m.prepare({
        metaSessionId: sess.id,
        runId: run.id,
        workspace: repo,
        trustProfile: "edit-untrusted",
      });
      if (ws.mode !== "worktree") throw new Error("expected worktree");
      writeFileSync(path.join(ws.worktreePath, "new.txt"), `change ${run.id}\n`);
      await m.finalize(run.id);
      m.releaseLease(run.id);
      db.prepare("UPDATE run SET updated_at = ?, created_at = ?, state = ? WHERE id = ?").run(
        at.toISOString(),
        at.toISOString(),
        state,
        run.id,
      );
      db.prepare("UPDATE meta_session SET updated_at = ?, lease_run_id = NULL WHERE id = ?").run(
        at.toISOString(),
        sess.id,
      );
      return { sess: sess.id, wt: ws.worktreePath, branch: ws.branch };
    } finally {
      db.close();
    }
  }

  const setRetention = (retention?: Record<string, unknown>) =>
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        data_dir: dataDir,
        allowed_roots: [root],
        mcp_clients: [{ id: "orch", max_trust_profile: "edit-untrusted" }],
        ...(retention ? { retention } : {}),
      }),
    );
  const sessionStatus = (id: string) => {
    const db = new Database(path.join(dataDir, LEDGER_FILE_NAME), { readonly: true });
    try {
      return (db.prepare("SELECT status FROM meta_session WHERE id = ?").get(id) as { status: string }).status;
    } finally {
      db.close();
    }
  };
  const branches = () => g(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n");

  async function untilLogged(c: Connected, msg: string): Promise<void> {
    const end = Date.now() + 10_000;
    while (!c.stderr().includes(`"msg":"${msg}"`)) {
      if (Date.now() > end) throw new Error(`never logged ${msg}; stderr: ${c.stderr()}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("with retention unset it collects nothing, even for a unit far past the 30 day default", async () => {
    const old = await seedUnit(400);
    const c = await connect();
    await untilLogged(c, "serving MCP on stdio");
    expect(c.stderr()).not.toContain("retention gc");
    expect(existsSync(old.wt)).toBe(true);
    expect(branches()).toContain(old.branch);
    expect(sessionStatus(old.sess)).toBe("ACTIVE");
  }, 30_000);

  it("with retention.days set it collects the expired idle unit before serving and leaves recent and non-terminal units", async () => {
    const old = await seedUnit(90);
    const recent = await seedUnit(1);
    const pending = await seedUnit(90, "AWAITING_APPROVAL");
    setRetention({ days: 30 });
    const c = await connect();
    await untilLogged(c, "serving MCP on stdio");
    const logs = c
      .stderr()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Json);
    const msgs = logs.map((l) => l.msg as string);
    expect(msgs.indexOf("startup reconciliation finished")).toBeLessThan(msgs.indexOf("retention gc finished"));
    expect(msgs.indexOf("retention gc finished")).toBeLessThan(msgs.indexOf("serving MCP on stdio"));
    expect(logs.find((l) => l.msg === "retention gc finished")).toMatchObject({
      when: "startup",
      collected: [old.sess],
      errors: 0,
    });
    expect(existsSync(old.wt)).toBe(false);
    expect(branches()).not.toContain(old.branch);
    expect(sessionStatus(old.sess)).toBe("ARCHIVED");
    for (const keep of [recent, pending]) {
      expect(existsSync(keep.wt)).toBe(true);
      expect(branches()).toContain(keep.branch);
      expect(sessionStatus(keep.sess)).toBe("ACTIVE");
    }
    expect(branches()).toContain("main");
    // The daemon still serves normally after the pass.
    expect((await call(c.client, "list_capabilities")).isError).toBe(false);
  }, 30_000);
});

describe("privileged end to end (fake adapter, T3.4; FRD WF-7, T3, T19; owner decision 17)", () => {
  const SCOPE = {
    files: { access: "worktree" },
    shell: { mode: "none" },
    network: { mode: "off" },
    repository_config: { mode: "disabled" },
    bypass: true,
  };
  const DAY_MS = String(24 * 60 * 60 * 1000);

  beforeEach(() => {
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        data_dir: dataDir,
        allowed_roots: [root],
        mcp_clients: [
          { id: "orch", max_trust_profile: "edit-untrusted" },
          { id: "priv", max_trust_profile: "privileged" },
          { id: "self", max_trust_profile: "privileged", privileged_approval: "not_required" },
        ],
      }),
    );
  });

  const delegatePrivileged = (c: Client) =>
    call(c, "delegate_task", {
      objective: "privileged work",
      workspace_path: repo,
      trust_profile: "privileged",
      privileged_scope: SCOPE,
      routing: { provider_preference: "fake", require_provider: true },
    });

  async function operator(cmd: "approve" | "deny", runId: string): Promise<{ code: number; body: Json }> {
    const out: string[] = [];
    const io: CliIo = { stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, env: {}, user: "op" };
    const code = await main([cmd, runId, "--config", configPath, "--json"], io);
    return { code, body: JSON.parse(out.join("")) as Json };
  }

  function ledgerView(runId: string) {
    const db = new Database(path.join(dataDir, LEDGER_FILE_NAME), { readonly: true, fileMustExist: true });
    try {
      return {
        run: db.prepare("SELECT state, pid, pgid, worktree_path FROM run WHERE id = ?").get(runId) as Json,
        approval: db.prepare("SELECT status, decided_at, decided_by FROM approval WHERE run_id = ?").get(runId) as Json,
        worktrees: (db.prepare("SELECT COUNT(*) AS n FROM run WHERE worktree_path IS NOT NULL").get() as Json).n,
      };
    } finally {
      db.close();
    }
  }

  it("waits 24 h (fake clock) across a restart, then approve -> QUEUED -> the adapter's compile refusal", async () => {
    const a = await connect(undefined, { client: "priv" });
    const d = await delegatePrivileged(a.client);
    expect(d.isError, JSON.stringify(d.body)).toBe(false);
    expect(d.body).toMatchObject({ status: "AWAITING_APPROVAL", approval: { status: "PENDING" } });
    const runId = d.body.run_id as string;
    await a.client.close();
    await waitDead(a.pid);

    // Restart with the daemon's clock a day ahead: reconciliation and several operator polls leave it waiting.
    const b = await connect(undefined, { client: "priv", env: { [TEST_CLOCK_OFFSET_ENV]: DAY_MS } });
    expect(b.stderr()).toContain(`"clock_offset_ms":${DAY_MS}`);
    await new Promise((r) => setTimeout(r, 2500));
    const still = await call(b.client, "get_run", { run_id: runId });
    expect(still.body).toMatchObject({ status: "AWAITING_APPROVAL", approval: { status: "PENDING" } });
    expect(ledgerView(runId).approval).toMatchObject({ status: "PENDING", decided_at: null });

    // No MCP tool can approve (FR-MCP-06).
    const tools = (await b.client.listTools()).tools.map((t) => t.name);
    expect(tools.filter((t) => /approv|deny/i.test(t))).toEqual([]);

    // approve while the daemon runs: recorded by the CLI, applied by serve (T3), then dispatched and refused.
    const ap = await operator("approve", runId);
    expect(ap.code, JSON.stringify(ap.body)).toBe(0);
    expect(ap.body).toMatchObject({ outcome: "requested", daemon_running: true, decided_by: "op" });
    const done = await pollStatus(b.client, runId, TERMINAL);
    expect(done).toMatchObject({
      status: "FAILED",
      failure_code: "ELIGIBILITY_NONE",
      approval: { status: "APPROVED" },
    });
    // The fake adapter has no privileged mode: its own compile refuses the scope (BR-3 code, owner decision 19 removed
    // the blanket dispatch refusal), before any lease, worktree or process.
    expect(done.failure_detail).toContain("PROFILE_UNSUPPORTED: fake adapter has no privileged mode");
    expect(JSON.stringify(done)).not.toContain(ap.body.scope_hash);
    const view = ledgerView(runId);
    expect(view.run).toMatchObject({ pid: null, pgid: null, worktree_path: null });
    expect(view.approval).toMatchObject({ status: "APPROVED", decided_by: "op", decided_at: ap.body.decided_at });
    // The operator record's user and hash stay out of the MCP event stream.
    const withEvents = await call(b.client, "get_run", { run_id: runId, include_events: { after_seq: 0, limit: 200 } });
    const evs = withEvents.body.events as Json[];
    const req = evs.find((e) => e.type === "operator_decision_requested");
    expect(req?.payload).toEqual({ decision: "APPROVED", approval_id: ap.body.approval_id });
    expect(evs.map((e) => e.type)).toContain("operator_decision_applied");
    expect(JSON.stringify(evs)).not.toContain(ap.body.scope_hash);
    // A second decision is refused.
    expect((await operator("deny", runId)).code).toBe(1);
  }, 60_000);

  it("a client configured privileged_approval not_required is admitted to QUEUED under a client_policy approval", async () => {
    const c = await connect(undefined, { client: "self" });
    const d = await delegatePrivileged(c.client);
    expect(d.isError, JSON.stringify(d.body)).toBe(false);
    expect(d.body.approval).toMatchObject({ status: "APPROVED" });
    const runId = d.body.run_id as string;
    const done = await pollStatus(c.client, runId, TERMINAL);
    // Admitted without the operator; then the (fake) adapter's compile decides, as for an operator-approved run.
    expect(done).toMatchObject({
      status: "FAILED",
      failure_code: "ELIGIBILITY_NONE",
      approval: { status: "APPROVED" },
    });
    const view = ledgerView(runId);
    expect(view.approval).toMatchObject({ status: "APPROVED", decided_by: "client_policy:self" });
    expect(view.run).toMatchObject({ pid: null, pgid: null, worktree_path: null });
    // Nothing for the operator to decide: approve is refused and says why.
    const ap = await operator("approve", runId);
    expect(ap.code).toBe(1);
    expect(JSON.stringify(ap.body)).toContain("client policy");
  }, 60_000);

  it("deny ends the run CANCELLED with a decided row, no worktree and no spawn; works with and without the daemon", async () => {
    const c = await connect(undefined, { client: "priv" });
    const first = await delegatePrivileged(c.client);
    const second = await delegatePrivileged(c.client);
    const [r1, r2] = [first.body.run_id as string, second.body.run_id as string];
    const dn = await operator("deny", r1);
    expect(dn.body).toMatchObject({ outcome: "requested", daemon_running: true });
    const done = await pollStatus(c.client, r1, TERMINAL);
    expect(done).toMatchObject({ status: "CANCELLED", approval: { status: "DENIED" } });
    expect(ledgerView(r1).approval).toMatchObject({ status: "DENIED", decided_by: "op" });
    await c.client.close();
    await waitDead(c.pid);

    // No daemon: the CLI holds the lock and applies the deny itself.
    const direct = await operator("deny", r2);
    expect(direct.body).toMatchObject({ outcome: "denied", state: "CANCELLED", daemon_running: false });
    for (const id of [r1, r2]) {
      expect(ledgerView(id).run).toMatchObject({ state: "CANCELLED", pid: null, pgid: null, worktree_path: null });
    }
    expect(ledgerView(r1).worktrees).toBe(0);
  }, 60_000);
});

describe("serve refuses to start (in process, before touching stdio)", () => {
  async function run(args: string[], env: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      env,
      homedir: path.join(root, "home"),
    };
    const code = await main(args, io);
    return { code, out: out.join(""), err: err.join("") };
  }

  it("requires --client and rejects --json (stdout is MCP framing only)", async () => {
    const a = await run(["serve", "--config", configPath]);
    expect(a.code).toBe(2);
    expect(a.err).toContain("serve requires --client");
    const b = await run(["serve", "--client", "orch", "--json", "--config", configPath]);
    expect(b.code).toBe(2);
    expect(b.out).toBe("");
    expect(b.err).toContain("does not take --json");
    expect((await run(["doctor", "--client", "orch", "--config", configPath])).code).toBe(2);
  });

  it("refuses an unknown client id without taking the lock (FR-OPS-04, R-9)", async () => {
    const r = await run(["serve", "--client", "intruder", "--config", configPath]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain('unknown MCP client "intruder"; configured clients: orch');
    expect(existsSync(path.join(dataDir, LOCK_FILE_NAME))).toBe(false);
  });

  it("refuses to serve when the ledger cannot be opened, and releases the lock (NFR-SEC-06)", async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, LEDGER_FILE_NAME), "this is not a sqlite database, just junk bytes ".repeat(100));
    const r = await run(["serve", "--client", "orch", "--config", configPath]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    const log = JSON.parse(r.err.trim().split("\n").at(-1) as string) as Json;
    expect(log).toMatchObject({ level: "error", msg: "refusing to serve: the ledger cannot be opened" });
    expect(existsSync(path.join(dataDir, LOCK_FILE_NAME))).toBe(false);
  });

  it("refuses a mistyped test switch value instead of ignoring it", async () => {
    const r = await run(["serve", "--client", "orch", "--config", configPath], { [TEST_FAKE_ADAPTER_ENV]: "1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${TEST_FAKE_ADAPTER_ENV} is set to an unrecognised value`);
    expect(existsSync(path.join(dataDir, LOCK_FILE_NAME))).toBe(false);
  });
});

describe("test-only fake adapter switch", () => {
  it("is off unless the exact sentinel is set, and cannot be enabled from a config file", async () => {
    expect(readFakeSwitch({})).toEqual({ enabled: false });
    expect(readFakeSwitch({ [TEST_FAKE_ADAPTER_ENV]: "" })).toEqual({ enabled: false });
    expect(() => readFakeSwitch({ [TEST_FAKE_ADAPTER_ENV]: "true" })).toThrow(/unrecognised value/);
    expect(readFakeSwitch({ [TEST_FAKE_ADAPTER_ENV]: TEST_FAKE_ADAPTER_VALUE })).toEqual({
      enabled: true,
      scenario: "success",
    });
    expect(() =>
      readFakeSwitch({ [TEST_FAKE_ADAPTER_ENV]: TEST_FAKE_ADAPTER_VALUE, [TEST_FAKE_SCENARIO_ENV]: "nope" }),
    ).toThrow(/must be one of/);
    // T3.4 test-only clock offset: only with the switch on, integers only.
    expect(
      readFakeSwitch({ [TEST_FAKE_ADAPTER_ENV]: TEST_FAKE_ADAPTER_VALUE, [TEST_CLOCK_OFFSET_ENV]: "86400000" }),
    ).toEqual({ enabled: true, scenario: "success", clockOffsetMs: 86_400_000 });
    expect(() => readFakeSwitch({ [TEST_CLOCK_OFFSET_ENV]: "1" })).toThrow(/test-only switch/);
    expect(() =>
      readFakeSwitch({ [TEST_FAKE_ADAPTER_ENV]: TEST_FAKE_ADAPTER_VALUE, [TEST_CLOCK_OFFSET_ENV]: "1d" }),
    ).toThrow(/must be an integer/);

    // The config schema has no `fake` provider and no switch key: such a config is rejected outright.
    for (const extra of [{ providers: { fake: { enabled: true } } }, { test_fake_adapter: true }]) {
      writeFileSync(
        configPath,
        JSON.stringify({
          schema_version: 1,
          data_dir: dataDir,
          allowed_roots: [root],
          mcp_clients: [{ id: "orch", max_trust_profile: "edit-untrusted" }],
          ...extra,
        }),
      );
      const err: string[] = [];
      const code = await main(["serve", "--client", "orch", "--config", configPath], {
        stdout: { write: () => {} },
        stderr: { write: (s) => err.push(s) },
        env: {},
      });
      expect(code).toBe(1);
      expect(err.join("")).toContain("unknown key (not permitted)");
    }
  });
});
