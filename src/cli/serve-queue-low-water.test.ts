/**
 * T15.4 defense (FR-QUE-04, LLD §18.8, ADR-0048): `switchboard serve` attaches the queue low-water tracker, so a project
 * with `queue.low_water` emits exactly one `queue_low` sink event when its admissible queue drains below the mark,
 * re-arms only by refilling to the mark, and a project without the mark emits nothing. The tracker itself is unit-tested
 * (`src/queue/low-water.test.ts`) and MCP-tested in-process (`src/mcp/work-queue.test.ts`); this test proves the serve
 * wiring end to end: the real daemon over stdio, the test-only fake adapter, and a capturing HTTPS webhook sink.
 *
 * Determinism: the serve scheduler tick claims one READY item per second, which would race a naive live enqueue/drain
 * script, so the queue is seeded through the ledger before each serve session and both projects are paused (a paused
 * project's admission is held, so the tick's claim/retry cycles cannot move the admissible count below the mark).
 * Arming then happens through the tracker's startup `init` (which never emits), and each drain is a single
 * `cancel_work` whose dependency chain drops the admissible count below the mark in one ledger notification. Re-arming
 * needs a queue at or above the mark when `serve` starts, so the refill is seeded between the two sessions.
 *
 * The sink must be `https://` (ADR-0048 item 7 refuses plain HTTP even for loopback), so the capture server uses an
 * openssl self-signed certificate and the daemon runs with Node's test-only `NODE_TLS_REJECT_UNAUTHORIZED=0`; the
 * certificate is generated per test and lives only in the temp directory.
 *
 * Q-35: the block drives a real `serve` with the test-only fake adapter, whose compile matrix is "verified on linux
 * only", so on darwin admission ends `ELIGIBILITY_NONE` before the paused project's PAUSED retry; it runs on the Linux
 * leg (same rule as `serve.test.ts`).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { LOCK_FILE_NAME } from "../lock/index.js";
import { TEST_FAKE_ADAPTER_ENV, TEST_FAKE_ADAPTER_VALUE } from "./serve.js";

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
const REQUEST = { objective: "Fix bug", trust_profile: "edit-untrusted" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, deadlineMs: number, what: string): Promise<void> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() >= end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

let root: string;
let configPath: string;
let server: Server;
let port = 0;
const posted: { url: string; body: string }[] = [];
const clients: Client[] = [];

beforeEach(async () => {
  posted.length = 0;
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-serve-low-water-")));
  for (const d of ["repos", "home", "bin"]) mkdirSync(path.join(root, d));
  // PATH holds git only, so no provider CLI on this host is ever probed (AGENTS.md: tests never call a provider).
  symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), path.join(root, "bin", "git"));
  const makeRepo = (name: string): string => {
    const repo = path.join(root, "repos", name);
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: GIT_ENV });
    git("init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
    return repo;
  };
  const repoWeb = makeRepo("web");
  const repoApi = makeRepo("api");
  // Loopback capture server; the sink URL must be https (ADR-0048 item 7), so generate a throwaway self-signed cert.
  const certPath = path.join(root, "sink-cert.pem");
  const keyPath = path.join(root, "sink-key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "2",
      "-subj",
      "/CN=127.0.0.1",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      posted.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("capture server has no port");
  port = address.port;
  configPath = path.join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: path.join(root, "data"),
      allowed_roots: [path.join(root, "repos")],
      mcp_clients: [{ id: "orch", max_trust_profile: "edit-untrusted", projects: ["web", "api"] }],
      projects: [
        {
          id: "web",
          name: "Web",
          contexts: [{ id: "main", kind: "repository", path: repoWeb, base_ref: "main", push: { policy: "none" } }],
          queue: { low_water: 2 },
        },
        {
          id: "api",
          name: "Api",
          contexts: [{ id: "main", kind: "repository", path: repoApi, base_ref: "main", push: { policy: "none" } }],
        },
      ],
      notification_sinks: [
        { id: "capture", kind: "webhook", url: `https://127.0.0.1:${port}/sink`, events: ["queue_low"] },
      ],
    }),
  );
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

/** Start `serve --client orch` and connect an SDK stdio client to it. */
async function connect(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...NODE_ARGS, "serve", "--client", "orch", "--config", configPath],
    env: {
      PATH: path.join(root, "bin"),
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "home", ".config"),
      XDG_DATA_HOME: path.join(root, "home", ".local", "share"),
      [TEST_FAKE_ADAPTER_ENV]: TEST_FAKE_ADAPTER_VALUE,
      // Loopback-only: lets the daemon post to the self-signed capture server (ADR-0048 keeps verification on in code).
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "serve-queue-low-water-test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: any }> {
  const res = await c.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
  return { isError: res.isError === true, body: JSON.parse(text) };
}

/** Cancel one item, retrying while the scheduler tick has it mid-claim (cancel_work returns an ADMITTING item unchanged). */
async function cancelItem(c: Client, workItemId: string): Promise<void> {
  const end = Date.now() + 20_000;
  for (;;) {
    const res = await call(c, "cancel_work", { work_item_id: workItemId });
    if (!res.isError && res.body?.state === "CANCELLED") return;
    if (Date.now() >= end) {
      throw new Error(`cancel_work did not cancel ${workItemId}: ${JSON.stringify(res.body)}`);
    }
    await sleep(100);
  }
}

/** Run ledger mutations against the daemon's data directory while no serve process holds it. */
function seedLedger<T>(mutate: (ledger: Ledger) => T): T {
  const db = openLedger(path.join(root, "data"));
  try {
    return mutate(createLedger(db, { ids: createIdGenerator() }));
  } finally {
    db.close();
  }
}

/** Enqueue a 3-item dependency chain (root READY, then two PENDING items); returns the ids root, middle, leaf. */
function seedChain(ledger: Ledger, projectId: string): [string, string, string] {
  const rootItem = ledger.enqueueWorkItem({
    projectId,
    creatorClientId: "orch",
    request: REQUEST,
    sourceKind: "mcp",
  });
  const mid = ledger.enqueueWorkItem({
    projectId,
    creatorClientId: "orch",
    request: REQUEST,
    sourceKind: "mcp",
    predecessorIds: [rootItem.id],
  });
  const leaf = ledger.enqueueWorkItem({
    projectId,
    creatorClientId: "orch",
    request: REQUEST,
    sourceKind: "mcp",
    predecessorIds: [mid.id],
  });
  return [rootItem.id, mid.id, leaf.id];
}

/** Wait until the previous serve process has fully released the data directory. */
async function serveStopped(): Promise<void> {
  await waitFor(() => !existsSync(path.join(root, "data", LOCK_FILE_NAME)), 30_000, "serve lock release");
}

async function waitPosted(n: number): Promise<void> {
  await waitFor(() => posted.length >= n, 20_000, `${n} queue_low sink delivery(ies), got ${posted.length}`);
}

/** The parsed body of the n-th captured delivery, failing clearly when it never arrived. */
function deliveredPayload(index: number): Record<string, unknown> {
  const sent = posted[index];
  if (sent === undefined) throw new Error(`expected sink delivery #${index + 1}, got ${posted.length}`);
  return JSON.parse(sent.body) as Record<string, unknown>;
}

const describeLinuxVerified = process.platform === "darwin" ? describe.skip : describe;

describeLinuxVerified("serve attaches the queue low-water tracker (T15.4; FR-QUE-04, LLD §18.8)", () => {
  it("one queue_low per drain below the mark with only the ADR-0048 fields; refill re-arms; an unmarked project is silent", async () => {
    // Seed before the daemon starts: both projects paused; web holds 3 admissible items (mark 2), api holds 3 (no mark).
    const [web, api] = seedLedger((ledger) => {
      ledger.setPaused({ projectId: "web", paused: true, by: "seed" });
      ledger.setPaused({ projectId: "api", paused: true, by: "seed" });
      return [seedChain(ledger, "web"), seedChain(ledger, "api")] as const;
    });
    const [webRoot, webMid, webLeaf] = web;

    // First session: the startup init arms web (3 >= 2, no event). Cancelling the chain's middle item makes the leaf
    // unmet, so the admissible count falls below the mark in a single notification: exactly one event.
    let c = await connect();
    await cancelItem(c, webMid);
    await waitPosted(1);
    expect(posted).toHaveLength(1);
    // ADR-0048 item 3: the closed payload, exactly these five fields, controller-generated values only.
    expect(deliveredPayload(0)).toEqual({
      project_id: "web",
      event_kind: "queue_low",
      reason_code: "queue_low",
      run_id: null,
      link: "switchboard://digest",
    });

    // Drain the rest, including the unmarked project (its collapse is a no-op for the tracker), then give the tick
    // more than two periods to misbehave.
    await cancelItem(c, webLeaf);
    await cancelItem(c, webRoot);
    await cancelItem(c, api[1]);
    await cancelItem(c, api[2]);
    await cancelItem(c, api[0]);
    await sleep(2500);
    expect(posted).toHaveLength(1); // no duplicate web event, and api (no low_water) stayed silent
    await c.close();
    await serveStopped();

    // Refill seeded while no daemon runs, so the re-arm comes from the next startup's init, not from a racing enqueue.
    const [refillRoot, refillMid, refillLeaf] = seedLedger((ledger) => seedChain(ledger, "web"));

    // Second session: init re-arms web (3 >= 2); the drain below the mark delivers the second and last event.
    c = await connect();
    await cancelItem(c, refillMid);
    await waitPosted(2);
    expect(posted).toHaveLength(2);
    expect(deliveredPayload(1)).toEqual({
      project_id: "web",
      event_kind: "queue_low",
      reason_code: "queue_low",
      run_id: null,
      link: "switchboard://digest",
    });
    await cancelItem(c, refillLeaf);
    await cancelItem(c, refillRoot);
    await sleep(1000); // settle: the drained queue must not emit again
    expect(posted).toHaveLength(2);
    await c.close();
  }, 180_000);
});
