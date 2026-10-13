// Controller-overhead benchmark (T2.7; NFR-PERF-01, NFR-PERF-02; TDD §3.6.1). Run with `npm run bench` (builds first).
// Drives the real MCP server over the SDK's in-memory transport with the fake adapter's `success` scenario on a temp
// git repo. Provider time is excluded: the fake CLI does no work, and the preflight/spawn marks below are taken from
// wrapper calls around the adapter, so the figures are controller overhead plus the cost of spawning the (trivial)
// fake probe processes. Usage: node scripts/bench-perf.mjs [--n 30] [--warmup 5] [--json]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FakeAdapter } from "../dist/adapters/fake/adapter.js";
import { AdapterRegistry } from "../dist/adapters/index.js";
import { ArtifactStore } from "../dist/artifacts/index.js";
import { createIdGenerator } from "../dist/ids/index.js";
import { createLedger, openLedger } from "../dist/ledger/index.js";
import { RunLifecycle } from "../dist/lifecycle/index.js";
import { createSwitchboardServer } from "../dist/mcp/index.js";
import { WorkspaceManager } from "../dist/workspace/index.js";

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const N = argOf("--n", 30);
const WARMUP = argOf("--warmup", 5);
const AS_JSON = process.argv.includes("--json");

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Bench",
  GIT_AUTHOR_EMAIL: "bench@example.test",
  GIT_COMMITTER_NAME: "Bench",
  GIT_COMMITTER_EMAIL: "bench@example.test",
};
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const profileFor = (name) => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: name === "inspect-untrusted" ? "none" : "allowlist",
  ...(name === "edit-untrusted" ? { shellAllowlist: [] } : {}),
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

// Marks written by the adapter wrapper. All times are performance.now() in this process.
const marks = { compile: 0, exit: 0, probeMs: 0, authMs: 0, probeCalls: 0 };
const inner = new FakeAdapter({ scenario: "success" });
const timed = async (key, fn) => {
  const t = performance.now();
  try {
    return await fn();
  } finally {
    marks[key] += performance.now() - t;
  }
};
const adapter = {
  id: inner.id,
  transports: inner.transports,
  probe: (r) => {
    marks.probeCalls += 1;
    return timed("probeMs", () => inner.probe(r));
  },
  authPreflight: (r) => timed("authMs", () => inner.authPreflight(r)),
  compile: (req, p) => {
    marks.compile = performance.now(); // last step before the provider process is spawned
    return inner.compile(req, p);
  },
  resumeArgs: (b, req, p) => inner.resumeArgs(b, req, p),
  parseEvent: (i, s) => inner.parseEvent(i, s),
  extractResult: (e, x) => {
    marks.exit = performance.now(); // called as soon as the process exit has been observed
    return inner.extractResult(e, x);
  },
  classifyFailure: (e) => inner.classifyFailure(e),
};

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-bench-")));
const repo = path.join(root, "repo");
const dataDir = path.join(root, "data");
mkdirSync(repo);
mkdirSync(dataDir);
git(repo, "init", "-q", "-b", "main");
writeFileSync(path.join(repo, "README.md"), "hello\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "init");

const db = openLedger(dataDir);
const ledger = createLedger(db, { ids: createIdGenerator() });
const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
const registry = new AdapterRegistry();
registry.register(adapter);
const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids: createIdGenerator() });
const lifecycle = new RunLifecycle({
  ledger,
  workspace,
  artifacts,
  adapters: registry,
  allowedRoots: [root],
  globalConcurrency: 4,
  resolveProfile: profileFor,
  eligibility: {
    platform: "linux",
    // The fake adapter has no compliance manifest; accept it as the tests do.
    gate: (id, version) => ({
      eligible: true,
      evidence: { provider: id, observedVersion: version, validatedRange: "bench", validatedCliVersion: "bench" },
    }),
  },
});
lifecycle.start();
const mcp = createSwitchboardServer({
  lifecycle,
  ledger,
  artifacts,
  registry,
  config: {
    allowedRoots: [root],
    mcpClients: new Map([["bench", { id: "bench", maxTrustProfile: "edit-untrusted" }]]),
  },
  clientId: "bench",
});
const client = new Client({ name: "bench", version: "0.0.0" });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await mcp.server.connect(serverSide);
await client.connect(clientSide);
await client.listTools();

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: res.isError === true, body: JSON.parse(res.content[0]?.text ?? "{}") };
};
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const tick = () => new Promise((r) => setImmediate(r));

async function oneRun() {
  marks.probeMs = marks.authMs = marks.probeCalls = 0;
  marks.compile = marks.exit = 0;
  const t0 = performance.now();
  const d = await call("delegate_task", {
    objective: "bench",
    workspace_path: repo,
    trust_profile: "edit-untrusted",
  });
  const t1 = performance.now();
  if (d.isError) throw new Error(`delegate_task failed: ${JSON.stringify(d.body)}`);
  const runId = d.body.run_id;
  let last;
  const deadline = performance.now() + 30_000;
  for (;;) {
    last = await call("get_run", { run_id: runId });
    if (TERMINAL.has(last.body.status)) break;
    if (performance.now() > deadline) throw new Error(`run ${runId} did not finish`);
    await tick();
  }
  const t2 = performance.now();
  if (last.body.status !== "SUCCEEDED") throw new Error(`run ended ${last.body.status}: ${JSON.stringify(last.body)}`);
  const preflight = marks.probeMs + marks.authMs;
  return {
    runId,
    ack: t1 - t0,
    toSpawn: marks.compile - t0, // accepted call -> just before provider spawn (includes preflight probes)
    preflight, // live probe + auth preflight, uncached (NFR-PERF-02)
    probe: marks.probeMs,
    auth: marks.authMs,
    toSpawnExPreflight: marks.compile - t0 - preflight,
    finalize: t2 - marks.exit, // provider exit observed -> terminal state visible through get_run
  };
}

for (let i = 0; i < WARMUP; i += 1) await oneRun();
const runs = [];
for (let i = 0; i < N; i += 1) runs.push(await oneRun());

const lastRun = runs.at(-1).runId;
const getRunMs = [];
const capsMs = [];
for (let i = 0; i < WARMUP; i += 1) {
  await call("get_run", { run_id: lastRun });
  await call("list_capabilities");
}
for (let i = 0; i < N; i += 1) {
  let t = performance.now();
  await call("get_run", { run_id: lastRun });
  getRunMs.push(performance.now() - t);
  t = performance.now();
  await call("list_capabilities");
  capsMs.push(performance.now() - t);
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const stat = (xs) => ({
  p50: pct(xs, 50),
  p95: pct(xs, 95),
  max: Math.max(...xs),
});
const col = (k) => runs.map((r) => r[k]);
const results = {
  date: new Date().toISOString(),
  host: {
    node: process.version,
    os: `${os.type()} ${os.release()} (${os.platform()}/${os.arch()})`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    cpuCount: os.cpus().length,
    totalMemGiB: Number((os.totalmem() / 2 ** 30).toFixed(1)),
  },
  n: N,
  warmup: WARMUP,
  metricsMs: {
    delegate_task_ack: stat(col("ack")),
    accepted_to_spawn_total_uncached_preflight: stat(col("toSpawn")),
    accepted_to_spawn_excluding_preflight: stat(col("toSpawnExPreflight")),
    preflight_probe_and_auth_live: stat(col("preflight")),
    preflight_probe_only: stat(col("probe")),
    preflight_auth_only: stat(col("auth")),
    provider_exit_to_terminal_visible: stat(col("finalize")),
    get_run: stat(getRunMs),
    list_capabilities_live_probe: stat(capsMs),
  },
};

await lifecycle.shutdown();
await client.close();
await mcp.close();
db.close();
rmSync(root, { recursive: true, force: true });

if (AS_JSON) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const h = results.host;
  console.log(`Switchboard controller-overhead benchmark  ${results.date}`);
  console.log(`host: node ${h.node}; ${h.os}; ${h.cpu} x${h.cpuCount}; ${h.totalMemGiB} GiB RAM`);
  console.log(`iterations: ${N} after ${WARMUP} warm-up; fake adapter scenario "success"; times in ms\n`);
  console.log(`${"metric".padEnd(46)}${"p50".padStart(9)}${"p95".padStart(9)}${"max".padStart(9)}`);
  for (const [k, v] of Object.entries(results.metricsMs)) {
    console.log(
      `${k.padEnd(46)}${v.p50.toFixed(1).padStart(9)}${v.p95.toFixed(1).padStart(9)}${v.max.toFixed(1).padStart(9)}`,
    );
  }
}
