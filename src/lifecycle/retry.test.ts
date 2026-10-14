/**
 * Automatic retry with linked successor runs (T6.5; FR-CAP-05, FR-MCP-10, FRD WF-5, BR-6, BR-7, T16, T18, LLD §9 and
 * §16.5, ADR-0043 item 4). Fake provider CLI only (no provider, no network); injected random source.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { main } from "../cli/index.js";
import type { CliIo } from "../cli/io.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRecord, type TrustProfile } from "../ledger/index.js";
import { buildEnvelope } from "../mcp/envelope.js";
import { WorkspaceManager } from "../workspace/index.js";
import { RunLifecycle, type RunLifecycleOptions } from "./index.js";

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
const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

/**
 * Fake provider CLI. The prompt picks the behaviour:
 * - `flaky`: a rate limit on the first call (counted in a file beside the script), success afterwards;
 * - `throttled`: always a rate limit; `overloaded`: always an overload; `crash`: dies with a signal-like exit;
 * - `dirty`: writes a file, then a rate limit (a mutated workspace);
 * - `reset_far` / `reset_near`: a rate limit whose reported reset lies one hour / 3 s ahead;
 * - `ok`: success.
 */
const CLI = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const a = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const counter = path.join(path.dirname(new URL(import.meta.url).pathname), "flaky-count");
const limited = (reset) => {
  emit({ type: "rate_limit", ...(reset ? { reset_at: reset } : {}) });
  emit({ type: "error", category: "rate_limit", message: "slow down" });
  process.exitCode = 1;
};
if (a.includes("--version")) process.stdout.write("fake-cli 1.0.0\\n");
else if (a.includes("--auth-status")) process.stdout.write('{"authenticated":true}\\n');
else if (a.includes("--smoke")) emit({ type: "result", ok: true, summary: "smoke" });
else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { prompt += c; });
  process.stdin.on("end", () => {
    const p = prompt.trim();
    emit({ type: "session", session_id: "s-1" });
    if (p === "flaky") {
      const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
      writeFileSync(counter, String(n + 1));
      if (n === 0) return limited();
      return emit({ type: "result", ok: true, summary: "ok after retry" });
    }
    if (p === "throttled") return limited();
    if (p === "overloaded") {
      emit({ type: "error", category: "overloaded", message: "busy" });
      process.exitCode = 1;
      return;
    }
    if (p === "dirty") {
      writeFileSync("dirty.txt", "half\\n");
      return limited();
    }
    if (p === "reset_far") return limited(new Date(Date.now() + 3600_000).toISOString());
    if (p === "reset_near") return limited(new Date(Date.now() + 3000).toISOString());
    if (p === "tool_fail") {
      emit({ type: "error", category: "tool", message: "tool broke" });
      process.exitCode = 2;
      return;
    }
    emit({ type: "result", ok: true, summary: "ok" });
  });
}
`;

let root: string;
let repo: string;
let dataDir: string;
let script: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle | undefined;

function makeLifecycle(over: Partial<RunLifecycleOptions> = {}): RunLifecycle {
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids: createIdGenerator() });
  return new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(new FakeAdapter({ script, timeouts: PATIENT })),
    allowedRoots: [root],
    globalConcurrency: 4,
    resolveProfile: profileFor,
    breaker: { failureThreshold: 50, openSeconds: 300 },
    retry: { maxAttempts: 3, baseMs: 50, capMs: 200 },
    random: () => 0.999,
    ...over,
  });
}
const live = (): RunLifecycle => {
  if (!lifecycle) throw new Error("no lifecycle");
  return lifecycle;
};
const submit = (objective: string, extra: Record<string, unknown> = {}) =>
  live().submit({
    clientId: "c",
    objective,
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    ...extra,
  });
const events = (runId: string) =>
  ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) as Record<string, unknown> }));
const event = (runId: string, type: string) => events(runId).find((e) => e.type === type)?.p;
const sessionRuns = (sess: string) => ledger.listRunsForMetaSession(sess);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(20);
  }
};
/** Wait until the meta-session has no non-terminal run, then return its runs oldest first. */
async function settled(sess: string): Promise<RunRecord[]> {
  await until(() => sessionRuns(sess).every((r) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(r.state)));
  return sessionRuns(sess);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-retry-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  script = path.join(root, "cli.mjs");
  writeFileSync(script, CLI);
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("automatic retry (T6.5, LLD §16.5)", () => {
  it("a rate limit on a clean workspace gets a linked successor that then succeeds", async () => {
    lifecycle = makeLifecycle();
    live().start();
    const r = await submit("flaky", { idempotencyKey: "retry-test-key-0001" });
    const runs = await settled(r.metaSessionId);
    expect(runs.map((x) => [x.state, x.failure_code, x.attempt])).toEqual([
      ["FAILED", "RATE_LIMIT_TRANSIENT", 1],
      ["SUCCEEDED", null, 2],
    ]);
    const [first, second] = runs as [RunRecord, RunRecord];
    expect(second).toMatchObject({
      parent_run_id: first.id,
      request_hash: first.request_hash,
      request_json: first.request_json,
      idempotency_key: null,
      provider: "fake",
      trust_profile: "edit-untrusted",
    });
    expect(first.idempotency_key).toBe("retry-test-key-0001");
    expect(event(first.id, "workspace_assessment")).toMatchObject({ retry_eligible: true, auto_retry: true });
    expect(event(first.id, "retry_scheduled")).toMatchObject({ successor_run_id: second.id, attempt: 2, delay_ms: 49 });
    expect(event(second.id, "retry_of")).toEqual({
      run_id: first.id,
      attempt: 1,
      failure_code: "RATE_LIMIT_TRANSIENT",
    });
    // It waited in WAITING_CAPACITY, then went to QUEUED by T18 (FRD §4.1: a new run, not a backward edge).
    const transitions = events(second.id)
      .filter((e) => e.type === "state_transition")
      .map((e) => `${e.p.rule}:${e.p.to ?? ""}`);
    expect(transitions[0]).toBe("T18:QUEUED");
    const notBefore = Date.parse(String(event(first.id, "retry_scheduled")?.not_before));
    expect(Date.parse(second.started_at as string)).toBeGreaterThanOrEqual(notBefore);
    // get_run (FR-MCP-10): the first run names its successor; the successor names what it retries.
    expect(buildEnvelope(ledger, first, (s) => s)).toMatchObject({ superseded_by: second.id });
    const env2 = buildEnvelope(ledger, second, (s) => s);
    expect(env2).toMatchObject({ retry_of: first.id, status: "SUCCEEDED" });
    expect(env2).not.toHaveProperty("superseded_by");
  });

  it("each retryable code retries; the chain stops at max_attempts with the last code; delays follow LLD §9", async () => {
    lifecycle = makeLifecycle();
    live().start();
    for (const objective of ["throttled", "overloaded"]) {
      const r = await submit(objective);
      const runs = await settled(r.metaSessionId);
      expect(runs).toHaveLength(3);
      const code = objective === "throttled" ? "RATE_LIMIT_TRANSIENT" : "PROVIDER_OVERLOADED";
      expect(runs.map((x) => [x.failure_code, x.attempt])).toEqual([
        [code, 1],
        [code, 2],
        [code, 3],
      ]);
      // Full jitter under min(cap, base * 2^(n-1)) with random 0.999: 49 ms, then 99 ms.
      expect(event(runs[0]?.id as string, "retry_scheduled")?.delay_ms).toBe(49);
      expect(event(runs[1]?.id as string, "retry_scheduled")?.delay_ms).toBe(99);
      expect(event(runs[2]?.id as string, "retry_not_scheduled")).toEqual({
        reason: "attempts_exhausted",
        attempt: 3,
        max_attempts: 3,
      });
    }
  });

  it("a mutated workspace and every non-retryable code get no successor (FR-WS-04 unchanged)", async () => {
    lifecycle = makeLifecycle();
    live().start();
    const dirty = await submit("dirty");
    const d = await settled(dirty.metaSessionId);
    expect(d).toHaveLength(1);
    expect(d[0]?.failure_code).toBe("RATE_LIMIT_TRANSIENT");
    expect(event(d[0]?.id as string, "workspace_assessment")).toMatchObject({ mutated: true, auto_retry: false });
    expect(event(d[0]?.id as string, "retry_not_scheduled")).toEqual({ reason: "workspace_changed" });
    expect(event(d[0]?.id as string, "rollback")).toBeDefined();

    const tool = await submit("tool_fail");
    const t = await settled(tool.metaSessionId);
    expect(t).toHaveLength(1);
    expect(t[0]?.failure_code).toBe("TOOL_FAILURE");
    expect(events(t[0]?.id as string).map((e) => e.type)).not.toContain("retry_not_scheduled");
  });

  it("a reported reset beyond the bound ends the chain; one within it sets the delay", async () => {
    lifecycle = makeLifecycle({ retry: { maxAttempts: 2, baseMs: 10, capMs: 5000 } });
    live().start();
    const far = await submit("reset_far");
    const f = await settled(far.metaSessionId);
    expect(f).toHaveLength(1);
    expect(event(f[0]?.id as string, "retry_not_scheduled")).toMatchObject({
      reason: "reset_beyond_bound",
      bound_ms: 5000,
    });
    const near = await submit("reset_near");
    const n = await settled(near.metaSessionId);
    expect(n).toHaveLength(2);
    const delay = Number(event(n[0]?.id as string, "retry_scheduled")?.delay_ms);
    // The reported reset (about 3 s ahead when the CLI printed it) dominates the 10 ms jitter ceiling.
    expect(delay).toBeGreaterThan(1000);
    expect(delay).toBeLessThanOrEqual(3000);
  });

  it("an open breaker ends the chain (LLD §16.4 before §16.5)", async () => {
    lifecycle = makeLifecycle({ breaker: { failureThreshold: 1, openSeconds: 300 } });
    live().start();
    const r = await submit("throttled");
    const runs = await settled(r.metaSessionId);
    expect(runs).toHaveLength(1);
    expect(event(runs[0]?.id as string, "breaker_opened")).toBeDefined();
    expect(event(runs[0]?.id as string, "retry_not_scheduled")).toEqual({ reason: "breaker_open" });
  });

  it("a waiting successor can be cancelled, and the timer then does nothing", async () => {
    lifecycle = makeLifecycle({ retry: { maxAttempts: 3, baseMs: 400, capMs: 400 } });
    live().start();
    const r = await submit("throttled");
    await until(() => sessionRuns(r.metaSessionId).some((x) => x.state === "WAITING_CAPACITY"));
    const waiting = sessionRuns(r.metaSessionId).find((x) => x.state === "WAITING_CAPACITY") as RunRecord;
    expect(await live().cancel(waiting.id)).toBe("CANCELLED");
    await sleep(600);
    const runs = sessionRuns(r.metaSessionId);
    expect(runs.map((x) => x.state)).toEqual(["FAILED", "CANCELLED"]);
    expect(runs[1]?.started_at).toBeNull();
  });

  it("a restart while a successor waits keeps next_attempt_at and dispatches it afterwards", async () => {
    lifecycle = makeLifecycle({ retry: { maxAttempts: 2, baseMs: 600, capMs: 600 } });
    live().start();
    const r = await submit("flaky");
    await until(() => sessionRuns(r.metaSessionId).some((x) => x.state === "WAITING_CAPACITY"));
    const waiting = sessionRuns(r.metaSessionId).find((x) => x.state === "WAITING_CAPACITY") as RunRecord;
    await live().shutdown();
    expect(ledger.getRunRecord(waiting.id)).toMatchObject({
      state: "WAITING_CAPACITY",
      next_attempt_at: waiting.next_attempt_at,
    });
    lifecycle = makeLifecycle({ retry: { maxAttempts: 2, baseMs: 600, capMs: 600 } });
    live().start();
    expect((await live().waitForTerminal(waiting.id)).state).toBe("SUCCEEDED");
    expect(Date.parse(ledger.getRunRecord(waiting.id)?.started_at as string)).toBeGreaterThanOrEqual(
      Date.parse(waiting.next_attempt_at as string),
    );
  });

  it("runs show prints both links (text and --json)", async () => {
    lifecycle = makeLifecycle();
    live().start();
    const r = await submit("flaky");
    const [first, second] = (await settled(r.metaSessionId)) as [RunRecord, RunRecord];
    const configPath = path.join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        data_dir: dataDir,
        allowed_roots: [root],
        mcp_clients: [{ id: "c", max_trust_profile: "edit-untrusted" }],
      }),
    );
    const show = async (args: string[]) => {
      const out: string[] = [];
      const io: CliIo = { stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, env: {} };
      expect(await main([...args, "--config", configPath], io)).toBe(0);
      return out.join("");
    };
    expect(JSON.parse(await show(["runs", "show", first.id, "--json"])).run).toMatchObject({
      retry_of: null,
      superseded_by: second.id,
    });
    expect(JSON.parse(await show(["runs", "show", second.id, "--json"])).run).toMatchObject({
      retry_of: first.id,
      superseded_by: null,
    });
    expect(await show(["runs", "show", first.id])).toContain(`superseded:  by ${second.id}`);
    expect(await show(["runs", "show", second.id])).toContain(`retry of:    ${first.id}`);
  });
});
