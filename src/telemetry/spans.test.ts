/**
 * T8.2 (FR-TEL-02, FR-TEL-03, LLD §7, ADR-0012): wrapper-boundary span emission.
 *
 * A full `delegate_task` runs on the fake adapter with OTLP pointed at an in-process collector on loopback; the
 * exported spans are read back and asserted. No provider CLI is involved and no real provider is contacted.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile, type TrustProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRecord } from "../ledger/index.js";
import { RunLifecycle, TERMINAL_STATES } from "../lifecycle/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { createTelemetry, type Telemetry } from "./index.js";
import { CONTROLLER_DELEGATE_SPAN, delegateSpan, PROVIDER_SPAWN_SPAN, SpanTracker, spawnSpan } from "./spans.js";

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

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

/** LLD §7 allowlisted attribute keys (as emitted by the T8.2 builders; the export-time drop filter is T8.4). */
const ALLOWED_KEYS = new Set([
  "run.id",
  "session.id",
  "provider",
  "adapter.version",
  "model",
  "trust_profile",
  "run.state",
  "failure.code",
  "retry.attempt",
  "transport",
  "duration_ms",
  "exit.code",
  "exit.signal",
]);

interface RawSpan {
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string; doubleValue?: string } }>;
}

function attrsOf(span: RawSpan): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const a of span.attributes ?? []) {
    out[a.key] =
      a.value.stringValue !== undefined ? a.value.stringValue : Number(a.value.intValue ?? a.value.doubleValue);
  }
  return out;
}

async function collector() {
  const bodies: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part) => {
      body += part;
    });
    request.on("end", () => {
      bodies.push(body);
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { bodies, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces` };
}

function spansFrom(bodies: string[]): RawSpan[] {
  const spans: RawSpan[] = [];
  for (const body of bodies) {
    const parsed = JSON.parse(body) as {
      resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: RawSpan[] }> }>;
    };
    for (const resource of parsed.resourceSpans ?? []) {
      for (const scope of resource.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) spans.push(span);
      }
    }
  }
  return spans;
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-tel-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function makeLifecycle(telemetry: Telemetry | undefined): RunLifecycle {
  const ids = createIdGenerator();
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  return new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(new FakeAdapter()),
    allowedRoots: [root],
    globalConcurrency: 2,
    resolveProfile: profileFor,
    ...(telemetry !== undefined ? { telemetry } : {}),
  });
}

const until = async (cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("span builders (T8.2, LLD §7)", () => {
  it("controller.delegate sets only allowlisted facts, with run.state and failure.code", () => {
    const span = delegateSpan(1_000, 1_500, {
      runId: "run-1",
      sessionId: "sess-1",
      provider: "fake",
      trustProfile: "edit-untrusted",
      attempt: 2,
      terminalState: "FAILED",
      failureCode: "PROCESS_CRASH",
    });
    expect(span.name).toBe(CONTROLLER_DELEGATE_SPAN);
    expect(span.attributes).toEqual({
      "run.id": "run-1",
      "session.id": "sess-1",
      provider: "fake",
      trust_profile: "edit-untrusted",
      "retry.attempt": 2,
      "run.state": "FAILED",
      "failure.code": "PROCESS_CRASH",
      duration_ms: 500,
    });
  });

  it("omits undefined, null and first-attempt facts instead of inventing them", () => {
    const delegate = delegateSpan(1_000, 1_000, {
      runId: "run-1",
      sessionId: "sess-1",
      provider: null,
      trustProfile: "inspect-untrusted",
      attempt: 1,
      terminalState: "SUCCEEDED",
      failureCode: null,
    });
    expect(Object.keys(delegate.attributes ?? {}).sort()).toEqual(
      ["duration_ms", "run.id", "run.state", "session.id", "trust_profile"].sort(),
    );
    const spawn = spawnSpan(2_000, 2_100, {
      runId: "run-1",
      sessionId: "sess-1",
      provider: "fake",
      trustProfile: "inspect-untrusted",
      adapterVersion: undefined,
      exitCode: null,
      exitSignal: null,
    });
    expect(Object.keys(spawn.attributes ?? {}).sort()).toEqual(
      ["duration_ms", "provider", "run.id", "session.id", "trust_profile"].sort(),
    );
  });

  it("SpanTracker never throws: no sink, a throwing sink, or a finish without a start", () => {
    const none = new SpanTracker(undefined);
    none.delegateStarted("run-1", 1);
    none.delegateFinished("run-1", 2, {
      runId: "run-1",
      sessionId: "s",
      provider: "fake",
      trustProfile: "inspect-untrusted",
      terminalState: "SUCCEEDED",
    });

    const throwing = new SpanTracker({
      recordSpan: () => {
        throw new Error("sink exploded");
      },
      close: () => Promise.resolve(),
    });
    throwing.delegateStarted("run-1", 1);
    expect(() =>
      throwing.delegateFinished("run-1", 2, {
        runId: "run-1",
        sessionId: "s",
        provider: "fake",
        trustProfile: "inspect-untrusted",
        terminalState: "SUCCEEDED",
      }),
    ).not.toThrow();

    const recorded: string[] = [];
    const sink = new SpanTracker({
      recordSpan: (span) => recorded.push(span.name),
      close: () => Promise.resolve(),
    });
    // A finish without a start observes no span by construction.
    sink.delegateFinished("run-2", 2, {
      runId: "run-2",
      sessionId: "s",
      provider: "fake",
      trustProfile: "inspect-untrusted",
      terminalState: "SUCCEEDED",
    });
    sink.delegateStarted("run-1", 1);
    sink.delegateFinished("run-1", 2, {
      runId: "run-1",
      sessionId: "s",
      provider: "fake",
      trustProfile: "inspect-untrusted",
      terminalState: "SUCCEEDED",
    });
    expect(recorded).toEqual([CONTROLLER_DELEGATE_SPAN]);
  });
});

describe("wrapper-boundary span export on a fake-adapter run (T8.2)", () => {
  it("exports controller.delegate and provider.spawn with run.id, provider and duration; the planted prompt never appears", async () => {
    const capture = await collector();
    const telemetry = createTelemetry({ telemetry: { otlpEndpoint: capture.endpoint } });
    cleanup.push(() => telemetry.close());
    const lifecycle = makeLifecycle(telemetry);
    lifecycle.start();
    // FR-TEL-03: this string must reach no span attribute (and no exported field at all).
    const planted = "t82plantedcanary4f9c1b7a2e objective text";
    const { runId, metaSessionId } = await lifecycle.submit({
      clientId: "client-a",
      objective: planted,
      workspace: repo,
      trustProfile: "edit-untrusted",
      provider: "fake",
    });
    await until(() => TERMINAL_STATES.has((ledger.getRunRecord(runId) as RunRecord).state));
    expect((ledger.getRunRecord(runId) as RunRecord).state).toBe("SUCCEEDED");

    const names = () => spansFrom(capture.bodies).map((s) => s.name);
    await vi.waitFor(() => expect(names()).toContain(CONTROLLER_DELEGATE_SPAN), { timeout: 5_000 });
    await vi.waitFor(() => expect(names()).toContain(PROVIDER_SPAWN_SPAN), { timeout: 5_000 });
    const spans = spansFrom(capture.bodies);
    const namesList = spans.map((s) => s.name);
    expect(namesList).toContain(CONTROLLER_DELEGATE_SPAN);
    expect(namesList).toContain(PROVIDER_SPAWN_SPAN);

    for (const span of spans) {
      expect(Number(span.endTimeUnixNano)).toBeGreaterThanOrEqual(Number(span.startTimeUnixNano));
      for (const key of Object.keys(attrsOf(span))) expect(ALLOWED_KEYS.has(key)).toBe(true);
      // The canary must not appear in any attribute value of any exported span.
      for (const value of Object.values(attrsOf(span))) expect(String(value)).not.toContain(planted);
    }

    const delegate = spans.find((s) => s.name === CONTROLLER_DELEGATE_SPAN);
    const delegateAttrs = attrsOf(delegate as RawSpan);
    expect(delegateAttrs["run.id"]).toBe(runId);
    expect(delegateAttrs["session.id"]).toBe(metaSessionId);
    expect(delegateAttrs.provider).toBe("fake");
    expect(delegateAttrs["run.state"]).toBe("SUCCEEDED");
    expect(delegateAttrs.duration_ms).toBeGreaterThanOrEqual(0);
    expect(Number(delegate?.endTimeUnixNano)).toBeGreaterThan(Number(delegate?.startTimeUnixNano));

    const spawn = spans.find((s) => s.name === PROVIDER_SPAWN_SPAN);
    const spawnAttrs = attrsOf(spawn as RawSpan);
    expect(spawnAttrs["run.id"]).toBe(runId);
    expect(spawnAttrs.provider).toBe("fake");
    expect(spawnAttrs["adapter.version"]).toBe("1.0.0");
    expect(spawnAttrs.transport).toBe("subprocess-jsonl");
    expect(spawnAttrs["exit.code"]).toBe(0);
    expect(spawnAttrs.duration_ms).toBeGreaterThanOrEqual(0);
    expect(Number(spawn?.endTimeUnixNano)).toBeGreaterThan(Number(spawn?.startTimeUnixNano));

    // Strongest form of the FR-TEL-03 assertion: the planted prompt appears nowhere in any exported OTLP body.
    for (const body of capture.bodies) expect(body).not.toContain(planted);

    await lifecycle.shutdown();
  }, 30_000);

  it("emits no spans when telemetry is unset", async () => {
    const capture = await collector();
    const lifecycle = makeLifecycle(undefined);
    lifecycle.start();
    const { runId } = await lifecycle.submit({
      clientId: "client-a",
      objective: "no telemetry configured",
      workspace: repo,
      trustProfile: "edit-untrusted",
      provider: "fake",
    });
    await until(() => TERMINAL_STATES.has((ledger.getRunRecord(runId) as RunRecord).state));
    await lifecycle.shutdown();
    await new Promise((r) => setTimeout(r, 300));
    expect(capture.bodies).toEqual([]);
  }, 30_000);
});
