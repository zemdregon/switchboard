/**
 * T8.3 collector integration test (FR-TEL-02, FR-TEL-03, NFR-SEC-01, LLD §7 harness shape, M8 acceptance).
 *
 * One `delegate_task` runs through the real lifecycle on the fake adapter with `telemetry.otlp_endpoint` pointed at the
 * in-process OTLP/HTTP collector (`./fixtures/collector.ts`). The exported spans are asserted on: span count, the
 * expected span names, the LLD §7 parent links (one trace per run, `provider.spawn` under `controller.delegate`),
 * every attribute key on the allowlist, and the absence of every forbidden category, with an objective, a constraint,
 * two environment values and the absolute workspace path planted as canaries. No provider CLI is installed or needed.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScenario } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile, type TrustProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRecord } from "../ledger/index.js";
import { RunLifecycle, TERMINAL_STATES } from "../lifecycle/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import {
  type CollectedSpan,
  findForbiddenAttributes,
  parentLinkViolations,
  startTestCollector,
  type TestCollector,
} from "./fixtures/collector.js";
import { createTelemetry } from "./index.js";
import { SPAN_PARENTS, traceIdForRun } from "./links.js";
import { CONTROLLER_DELEGATE_SPAN, PROVIDER_SPAWN_SPAN } from "./spans.js";

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

/** LLD §7 allowlisted keys the T8.2 builders can set on the two spans of this path (the full set is T8.4's). */
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
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-t83-")));
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

/** Synthetic canaries: random, never real; the credential-shaped one matches the redactor's `sk-` pattern. */
function makeCanaries() {
  const hex = randomBytes(12).toString("hex");
  return {
    objective: `t83objective${hex} summarise the README`,
    constraint: `t83constraint${hex} never push`,
    envCredential: `sk-ant-api03-T83CANARY${hex}${hex}`,
    envPlain: `t83envplain${hex}`,
  };
}

async function runOnce(scenario: FakeScenario, canaries: ReturnType<typeof makeCanaries>) {
  const capture: TestCollector = await startTestCollector();
  cleanup.push(() => capture.close());
  const telemetry = createTelemetry({ telemetry: { otlpEndpoint: capture.endpoint } });
  cleanup.push(() => telemetry.close());
  const ids = createIdGenerator();
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  const lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(new FakeAdapter({ scenario })),
    allowedRoots: [root],
    globalConcurrency: 2,
    resolveProfile: profileFor,
    telemetry,
    // Planted in the controller's own environment (outside the provider allowlist): neither value may be exported.
    baseEnv: { ...process.env, T83_CANARY_API_KEY: canaries.envCredential, T83_CANARY_PLAIN: canaries.envPlain },
  });
  lifecycle.start();
  cleanup.push(() => lifecycle.shutdown());
  const { runId, metaSessionId } = await lifecycle.submit({
    clientId: "client-a",
    objective: canaries.objective,
    constraints: [canaries.constraint],
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
  });
  const deadline = Date.now() + 20_000;
  while (!TERMINAL_STATES.has((ledger.getRunRecord(runId) as RunRecord).state)) {
    if (Date.now() > deadline) throw new Error("run did not reach a terminal state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = ledger.getRunRecord(runId) as RunRecord;
  // Both spans complete at the terminal transition; the batch processor exports them within its 100 ms delay.
  await capture.waitForSpans((s) => s.length >= 2, 10_000);
  await lifecycle.shutdown();
  await telemetry.close();
  return { capture, spans: capture.spans(), run, runId, metaSessionId };
}

function assertTreeAndRedaction(
  spans: readonly CollectedSpan[],
  bodies: readonly string[],
  canaries: ReturnType<typeof makeCanaries>,
  runId: string,
) {
  // Span count and names: exactly the two LLD §7 spans the T8.2 wrapper emits for one delegate/finalize path.
  expect(spans.map((s) => s.name).sort()).toEqual([CONTROLLER_DELEGATE_SPAN, PROVIDER_SPAWN_SPAN]);
  const delegate = spans.find((s) => s.name === CONTROLLER_DELEGATE_SPAN) as CollectedSpan;
  const spawn = spans.find((s) => s.name === PROVIDER_SPAWN_SPAN) as CollectedSpan;

  // Parent links: one trace per run; provider.spawn is a child of controller.delegate, which is a root.
  expect(parentLinkViolations(spans, SPAN_PARENTS)).toEqual([]);
  expect(delegate.traceId).toBe(traceIdForRun(runId));
  expect(delegate.parentSpanId).toBeUndefined();
  expect(spawn.traceId).toBe(delegate.traceId);
  expect(spawn.parentSpanId).toBe(delegate.spanId);
  expect(spawn.spanId).not.toBe(delegate.spanId);
  // The process lifetime lies inside the delegation.
  expect(spawn.startTimeUnixNano).toBeGreaterThanOrEqual(delegate.startTimeUnixNano);
  expect(spawn.endTimeUnixNano).toBeLessThanOrEqual(delegate.endTimeUnixNano);
  expect(delegate.endTimeUnixNano).toBeGreaterThan(delegate.startTimeUnixNano);

  // Keys: only allowlisted ones; values: no forbidden category (LLD §7), including every planted canary.
  const canaryValues = Object.values(canaries);
  for (const span of spans) {
    for (const key of Object.keys(span.attributes)) expect(ALLOWED_KEYS.has(key), `${span.name}:${key}`).toBe(true);
  }
  expect(findForbiddenAttributes(spans, { canaries: canaryValues, paths: [root, repo, dataDir] })).toEqual([]);

  // Strongest form: nothing planted (and no absolute path) appears anywhere in any exported OTLP body.
  const exported = bodies.join("\n");
  for (const canary of canaryValues) expect(exported).not.toContain(canary);
  expect(exported).not.toContain(root);
  expect(exported).not.toContain("T83_CANARY");
  return { delegate, spawn };
}

describe("collector integration: fake-adapter delegate/finalize path (T8.3)", () => {
  it("exports the LLD §7 span tree for a successful run with no forbidden attribute", async () => {
    const canaries = makeCanaries();
    const { capture, spans, run, runId, metaSessionId } = await runOnce("success", canaries);
    expect(run.state).toBe("SUCCEEDED");
    const { delegate, spawn } = assertTreeAndRedaction(spans, capture.bodies, canaries, runId);

    expect(delegate.attributes).toMatchObject({
      "run.id": runId,
      "session.id": metaSessionId,
      provider: "fake",
      trust_profile: "edit-untrusted",
      "run.state": "SUCCEEDED",
    });
    expect(delegate.attributes["failure.code"]).toBeUndefined();
    expect(spawn.attributes).toMatchObject({
      "run.id": runId,
      "session.id": metaSessionId,
      provider: "fake",
      "adapter.version": "1.0.0",
      transport: "subprocess-jsonl",
      "exit.code": 0,
    });
    expect(spawn.attributes.duration_ms).toBeGreaterThanOrEqual(0);
    expect(delegate.attributes.duration_ms).toBeGreaterThanOrEqual(spawn.attributes.duration_ms as number);
  }, 60_000);

  it("keeps the tree and the redaction on a failed run, with failure.code on the delegation span only", async () => {
    const canaries = makeCanaries();
    const { capture, spans, run, runId } = await runOnce("task_failure", canaries);
    expect(run.state).toBe("FAILED");
    const { delegate, spawn } = assertTreeAndRedaction(spans, capture.bodies, canaries, runId);
    expect(delegate.attributes["run.state"]).toBe("FAILED");
    expect(typeof delegate.attributes["failure.code"]).toBe("string");
    expect(spawn.attributes["exit.code"]).toBe(1);
    // The fake's error text ("command failed") is provider output: it must not have reached any span.
    expect(capture.bodies.join("\n")).not.toContain("command failed");
  }, 60_000);

  it("the scan fails this path when a forbidden category is planted on an exported span (positive control)", async () => {
    const canaries = makeCanaries();
    const { spans } = await runOnce("success", canaries);
    expect(findForbiddenAttributes(spans, { canaries: Object.values(canaries) })).toEqual([]);
    // Same spans, with the objective planted on an allowlisted key of the real provider.spawn span.
    const tampered = spans.map((span) =>
      span.name === PROVIDER_SPAWN_SPAN
        ? { ...span, attributes: { ...span.attributes, model: canaries.objective } }
        : span,
    );
    const findings = findForbiddenAttributes(tampered, { canaries: Object.values(canaries) });
    expect(findings.map((f) => `${f.span}:${f.key}:${f.category}`)).toEqual([`${PROVIDER_SPAWN_SPAN}:model:canary`]);
    // And a forbidden key planted on the delegation span is caught without any canary knowledge.
    const keyed = spans.map((span) =>
      span.name === CONTROLLER_DELEGATE_SPAN
        ? { ...span, attributes: { ...span.attributes, "request.objective": "anything" } }
        : span,
    );
    expect(
      findForbiddenAttributes(keyed)
        .map((f) => f.category)
        .sort(),
    ).toEqual(["message_body", "prompt_text"]);
  }, 60_000);
});
