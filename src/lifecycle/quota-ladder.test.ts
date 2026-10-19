/**
 * The `QUOTA_EXHAUSTED` ladder (T6.6; FR-CAP-06, FRD BR-6, BR-8, BR-9, WF-5, LLD §16.6, ADR-0043 item 7): fail over
 * through the M5 handoff when the request permits it, else wait for a provider-reported reset inside the horizon, else
 * return the code. Two fake providers driven by small scripted CLIs; no provider, no network.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { secondFakeProvider } from "../adapters/fixtures/continuity-fakes.js";
import { AdapterRegistry, type ProviderAdapter, type ProviderId, type ResolvedProfile } from "../adapters/index.js";
import { registerProvider } from "../adapters/providers.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRecord, type TrustProfile } from "../ledger/index.js";
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
const MARKER = "[instruction from the orchestrator]";

/**
 * Provider A (`fake`). The instruction picks the behaviour: `quota` (no reset), `quota_near` (a reported reset 2 s
 * ahead, success on the next call), `quota_far` (a reset one hour ahead), `dirty_quota` (writes a file, then quota).
 */
const QUOTA_CLI = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const a = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const counter = path.join(path.dirname(new URL(import.meta.url).pathname), "quota-count");
const quota = (reset) => {
  if (reset) emit({ type: "rate_limit", reset_at: reset });
  emit({ type: "error", category: "quota", message: "limit reached" });
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
    const i = prompt.lastIndexOf(${JSON.stringify(MARKER)});
    const p = (i >= 0 ? prompt.slice(i + ${MARKER.length}) : prompt).trim();
    emit({ type: "session", session_id: "a-1" });
    if (p === "quota") return quota();
    if (p === "quota_far") return quota(new Date(Date.now() + 3600_000).toISOString());
    if (p === "quota_near") {
      const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
      writeFileSync(counter, String(n + 1));
      if (n === 0) return quota(new Date(Date.now() + 2000).toISOString());
      return emit({ type: "result", ok: true, summary: "ok after reset" });
    }
    if (p === "dirty_quota") {
      writeFileSync("dirty.txt", "half\\n");
      return quota();
    }
    emit({ type: "result", ok: true, summary: "ok" });
  });
}
`;

/** Provider B (`fake-b`): records the prompt it got beside the script and succeeds. */
const OK_CLI = `
import { writeFileSync } from "node:fs";
import path from "node:path";
const a = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (a.includes("--version")) process.stdout.write("fake-cli 1.0.0\\n");
else if (a.includes("--auth-status")) process.stdout.write('{"authenticated":true}\\n');
else if (a.includes("--smoke")) emit({ type: "result", ok: true, summary: "smoke" });
else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { prompt += c; });
  process.stdin.on("end", () => {
    writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "b-prompt.txt"), prompt);
    emit({ type: "session", session_id: "b-1" });
    emit({ type: "result", ok: true, summary: "done on b" });
  });
}
`;

function scripted(id: string, script: string, privilegedAs?: TrustProfile): ProviderAdapter {
  const base = new FakeAdapter({ script, timeouts: PATIENT });
  // T6.6: the fake CLI has no privileged mode, so a privileged profile compiles as this profile (the same test
  // double as `privilegedAs` in src/lifecycle/lifecycle.test.ts). Unset, the fake adapter refuses `privileged`.
  const compileProfile = (p: ResolvedProfile): ResolvedProfile =>
    p.name === "privileged" && privilegedAs !== undefined ? { ...p, name: privilegedAs } : p;
  return {
    id: id as ProviderId,
    transports: base.transports,
    gitWriteControl: base.gitWriteControl,
    resumeCwd: base.resumeCwd,
    gitCapabilities: { commitChannel: "none", detail: "test double" },
    probe: (r) => base.probe(r),
    authPreflight: (r) => base.authPreflight(r),
    compile: (req, p) => base.compile(req, compileProfile(p)),
    resumeArgs: (b, req, p) => base.resumeArgs(b, req, compileProfile(p)),
    parseEvent: (i, s) => base.parseEvent(i, s),
    extractResult: (e, x) => base.extractResult(e, x),
    classifyFailure: (e) => base.classifyFailure(e),
  };
}

let root: string;
let repo: string;
let dataDir: string;
let bDir: string;
let db: Database.Database;
let ledger: Ledger;
let artifacts: ArtifactStore;
let lifecycle: RunLifecycle | undefined;
let unregister: () => void;

function makeLifecycle(over: Partial<RunLifecycleOptions> = {}, privilegedAs?: TrustProfile): RunLifecycle {
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids: createIdGenerator() });
  const a = path.join(root, "a", "cli.mjs");
  const b = path.join(bDir, "cli.mjs");
  return new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(scripted("fake", a, privilegedAs)).register(scripted("fake-b", b)),
    allowedRoots: [root],
    globalConcurrency: 4,
    perProviderConcurrency: 2,
    resolveProfile: profileFor,
    breaker: { failureThreshold: 50, openSeconds: 300 },
    retry: { maxAttempts: 3, baseMs: 10, capMs: 100, queueHorizonSeconds: 0 },
    eligibility: {
      platform: "linux",
      gate: (id, version) => ({
        eligible: true,
        evidence: { provider: id, observedVersion: version, validatedRange: "test", validatedCliVersion: "test" },
      }),
    },
    ...over,
  });
}
const live = () => {
  if (!lifecycle) throw new Error("no lifecycle");
  return lifecycle;
};

/** What `delegate_task` stores (FR-RTE-03): both fakes eligible; `required` when `require_provider` named `fake`. */
const route = (required: boolean) => ({
  features_json: JSON.stringify({ trust_profile: "edit-untrusted", required_provider: required ? "fake" : null }),
  candidates_json: JSON.stringify([
    { provider: "fake", eligible: true, reasons: [], score: null },
    { provider: "fake-b", eligible: true, reasons: [], score: null },
  ]),
  selected_provider: "fake",
  reasons_json: JSON.stringify({ selection: { provider: "fake", basis: "test" } }),
});
const submit = (objective: string, opts: { required?: boolean; noRoute?: boolean } = {}) =>
  live().submit({
    clientId: "c",
    objective,
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    ...(opts.noRoute ? {} : { routeDecision: route(opts.required === true) }),
  });
const ladder = (runId: string) =>
  ledger
    .listRunEvents(runId)
    .filter((e) => e.type === "quota_ladder")
    .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settled(sess: string, count: number): Promise<RunRecord[]> {
  const end = Date.now() + 30_000;
  for (;;) {
    const runs = ledger.listRunsForMetaSession(sess);
    const done = runs.every((r) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(r.state));
    const recorded = runs.filter((r) => r.failure_code === "QUOTA_EXHAUSTED").every((r) => ladder(r.id).length > 0);
    if (runs.length >= count && done && recorded) return runs;
    if (Date.now() > end) throw new Error(`timed out: ${runs.map((r) => r.state).join(",")}`);
    await sleep(25);
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-quota-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  mkdirSync(path.join(root, "a"));
  writeFileSync(path.join(root, "a", "cli.mjs"), QUOTA_CLI);
  bDir = path.join(root, "b");
  mkdirSync(bDir);
  writeFileSync(path.join(bDir, "cli.mjs"), OK_CLI);
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  unregister = registerProvider(secondFakeProvider(path.join(root, "home")));
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  unregister();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** A valid structured privileged scope (LLD §3.1; same shape as src/lifecycle/lifecycle.test.ts). */
const SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "allowlist", allowlist: [["npm", "test"]] },
  network: { mode: "allowlist", hosts: ["registry.npmjs.org"] },
  repository_config: { mode: "approved" },
  bypass: false,
};
/** Stand-in for T3.4's `approve`: the approval decided and the run queued (tests only). */
const approveDirect = (runId: string) => {
  const approval = ledger.getApprovalForRun(runId);
  ledger.decideApproval({ id: approval?.id as string, status: "APPROVED", decidedBy: "op" });
  const run = ledger.getRunRecord(runId);
  ledger.casRunState({
    runId,
    from: "AWAITING_APPROVAL",
    to: "QUEUED",
    expectedVersion: run?.version as number,
    payload: { rule: "T3" },
  });
};

describe("QUOTA_EXHAUSTED ladder (T6.6, LLD §16.6)", () => {
  it("fails over to the other eligible provider through a handoff that lists the failed attempt", async () => {
    lifecycle = makeLifecycle();
    live().start();
    const r = await submit("quota");
    const [first, second] = (await settled(r.metaSessionId, 2)) as [RunRecord, RunRecord];
    expect([first.provider, first.state, first.failure_code]).toEqual(["fake", "FAILED", "QUOTA_EXHAUSTED"]);
    expect(second).toMatchObject({ provider: "fake-b", state: "SUCCEEDED", parent_run_id: first.id, attempt: 2 });
    expect(ladder(first.id)).toEqual([
      { outcome: "failover", successor_run_id: second.id, to_provider: "fake-b", not_taken: [] },
    ]);
    const req = JSON.parse(second.request_json) as { handoff: { reason: string; from_provider: string } };
    expect(req.handoff).toMatchObject({ reason: "quota_failover", from_provider: "fake" });
    // The view the successor got lists the failed attempt with its code (FR-SES-04, BR-8).
    const view = ledger.listArtifactsForRun(second.id).find((x) => x.kind === "handoff_view");
    const bundle = JSON.parse(readFileSync(artifacts.pathFor(view?.sha256 as string), "utf8")) as Json;
    expect(JSON.stringify(bundle)).toContain(first.id);
    expect(JSON.stringify(bundle)).toContain("QUOTA_EXHAUSTED");
    expect(readFileSync(path.join(bDir, "b-prompt.txt"), "utf8")).toContain(MARKER);
    // The route decision of the successor records the handoff reason.
    const decision = ledger.getRouteDecision(second.id);
    expect(JSON.parse(decision?.reasons_json ?? "{}")).toMatchObject({
      continuation: { mode: "handoff", reason: "quota_failover", from_provider: "fake" },
    });
  });

  it("a changed workspace is preserved and rolled back before the failover successor starts", async () => {
    lifecycle = makeLifecycle();
    live().start();
    const r = await submit("dirty_quota");
    const [first, second] = (await settled(r.metaSessionId, 2)) as [RunRecord, RunRecord];
    expect(ledger.listRunEvents(first.id).some((e) => e.type === "rollback")).toBe(true);
    expect(second.state).toBe("SUCCEEDED");
    expect(existsSync(path.join(second.worktree_path as string, "dirty.txt"))).toBe(false);
    expect(g(repo, "show", `switchboard/${r.metaSessionId}/${first.id}:dirty.txt`)).toBe("half");
  });

  it("with require_provider and a reported reset inside the horizon it waits on the same provider, then runs", async () => {
    lifecycle = makeLifecycle({ retry: { maxAttempts: 3, baseMs: 10, capMs: 100, queueHorizonSeconds: 10 } });
    live().start();
    const r = await submit("quota_near", { required: true });
    const [first, second] = (await settled(r.metaSessionId, 2)) as [RunRecord, RunRecord];
    const [entry] = ladder(first.id);
    expect(entry).toMatchObject({
      outcome: "wait",
      successor_run_id: second.id,
      not_taken: ["failover:require_provider"],
    });
    expect(second).toMatchObject({ provider: "fake", state: "SUCCEEDED", parent_run_id: first.id, attempt: 2 });
    expect(Date.parse(second.started_at as string)).toBeGreaterThanOrEqual(Date.parse(String(entry?.not_before)));
  });

  it("a reset beyond the horizon, or none, returns QUOTA_EXHAUSTED and creates nothing", async () => {
    lifecycle = makeLifecycle({ retry: { maxAttempts: 3, baseMs: 10, capMs: 100, queueHorizonSeconds: 10 } });
    live().start();
    const far = await submit("quota_far", { required: true });
    const [f] = await settled(far.metaSessionId, 1);
    expect(ledger.listRunsForMetaSession(far.metaSessionId)).toHaveLength(1);
    expect(ladder(f?.id as string)).toEqual([
      { outcome: "returned", not_taken: ["failover:require_provider", "wait:reset_beyond_horizon"] },
    ]);
    const none = await submit("quota", { required: true });
    const [n] = await settled(none.metaSessionId, 1);
    expect(ladder(n?.id as string)).toEqual([
      { outcome: "returned", not_taken: ["failover:require_provider", "wait:no_reported_reset"] },
    ]);
  });

  it("fails closed without a route decision (whether the request allowed failover is unknown)", async () => {
    lifecycle = makeLifecycle();
    live().start();
    const r = await submit("quota", { noRoute: true });
    const [only] = await settled(r.metaSessionId, 1);
    expect(ladder(only?.id as string)).toEqual([
      { outcome: "returned", not_taken: ["failover:no_route_decision", "wait:no_reported_reset"] },
    ]);
  });

  it("a privileged run hitting QUOTA_EXHAUSTED is not failed over cross-provider (Q-61 default)", async () => {
    lifecycle = makeLifecycle({}, "edit-untrusted");
    const r = await live().submit({
      clientId: "c",
      objective: "quota",
      workspace: repo,
      trustProfile: "privileged",
      privileged: { scope: SCOPE },
      provider: "fake",
      routeDecision: route(false),
    });
    expect(r.state).toBe("AWAITING_APPROVAL");
    approveDirect(r.runId);
    live().start(); // dispatch (and its pump) happens only after start, as in src/lifecycle/lifecycle.test.ts
    const [only] = await settled(r.metaSessionId, 1);
    expect([only?.provider, only?.state, only?.failure_code]).toEqual(["fake", "FAILED", "QUOTA_EXHAUSTED"]);
    // No successor: the privileged refusal fires before any other failover branch, and with no reported reset the
    // run is returned. (The non-privileged control above this test fails over to `fake-b` in the same setup.)
    expect(ledger.listRunsForMetaSession(r.metaSessionId)).toHaveLength(1);
    expect(ladder(only?.id as string)).toEqual([
      { outcome: "returned", not_taken: ["failover:privileged_cross_provider", "wait:no_reported_reset"] },
    ]);
    // The eligible other provider was never reached.
    expect(existsSync(path.join(bDir, "b-prompt.txt"))).toBe(false);
  });

  it("a known future reset makes the provider QUOTA_EXHAUSTED at admission (BR-3)", async () => {
    lifecycle = makeLifecycle();
    live().start();
    const r = await submit("quota_far", { required: true });
    await settled(r.metaSessionId, 1);
    const answer = await live().checkEligibility({
      candidates: ["fake", "fake-b"] as ProviderId[],
      requiredProvider: "fake" as ProviderId,
      trustProfile: "edit-untrusted",
      clientMaxProfile: "edit-untrusted",
      cwd: repo,
    });
    expect(answer.decision.outcome).toMatchObject({ failureCode: "QUOTA_EXHAUSTED" });
    expect(answer.decision.excluded[0]?.primary.code).toBe("QUOTA_EXHAUSTED_KNOWN");
    const open = await live().checkEligibility({
      candidates: ["fake", "fake-b"] as ProviderId[],
      trustProfile: "edit-untrusted",
      clientMaxProfile: "edit-untrusted",
      cwd: repo,
    });
    expect(open.decision.eligible).toEqual(["fake-b"]);
  });
});

// biome-ignore lint/suspicious/noExplicitAny: parsed bundle JSON
type Json = any;
