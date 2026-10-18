/**
 * M16 acceptance on fake adapters through the MCP server (T16.12; ROADMAP §6 M16 row; FR-SKL-01 to FR-SKL-10, CAP-17;
 * ADR-0056, LLD §19, TDD §3.16). One named test per clause of the M16 acceptance column, each on the T16.x production
 * pieces: the T16.1 store (`addSkill`, `appendSkillEvent`), the T16.4 admission inside `delegate_task` and
 * `continue_task`, the T16.5 renderer (`renderSkillBlock`) and delivery port (`skillDeliveryPort`), the T16.6 native
 * writer, cleaner, exclusions and GC, the T16.9 tools, the T8.3 in-process OTLP collector, a notification sink
 * dispatcher with a capturing transport, the `serve` logger and the T16.11 surface detectors. The skills continuity
 * clause (handoff and resume, T16.10) is covered by `src/continuity/skill-continuity.test.ts`.
 *
 * A scripted MCP client (the SDK client over an in-memory transport, so every result is checked against the published
 * output schemas) drives one fake adapter (`fake`, the bundled fake CLI; `fake-b`, the second continuity fake, for the
 * handoff). Every store skill body carries a random canary. No provider CLI is installed, logged in or called; no
 * network is used.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runArtifactsText, surfacesContaining } from "../../test/malicious/detectors.js";
import { FAKE_NATIVE_SKILL_LOCATION, FakeAdapter, type FakeScenario } from "../adapters/fake/adapter.js";
import {
  SECOND_FAKE_ID,
  type StatefulFake,
  secondFake,
  secondFakeProvider,
} from "../adapters/fixtures/continuity-fakes.js";
import {
  AdapterRegistry,
  type CompileRequest,
  type Ineligible,
  type Invocation,
  type ResolvedProfile,
  type SkillDelivery,
} from "../adapters/index.js";
import { renderSkillBlock } from "../adapters/prompt.js";
import { registerProvider } from "../adapters/providers.js";
import { ArtifactStore } from "../artifacts/index.js";
import { skillDeliveryPort, stderrLogger } from "../cli/serve.js";
import type { ResolvedMcpClient, ResolvedProject, ResolvedSkills } from "../config/index.js";
import type { NotificationSinkSettings } from "../config/notification-sinks.js";
import { needsAttentionOf } from "../control/needs-attention.js";
import { SinkDispatcher, sinkOutcomeRecorder, transitionNotifier } from "../control/sinks.js";
import { GitToolService } from "../git/channel.js";
import { GitPublisher, publishRefFor } from "../git/index.js";
import { GitPusher } from "../git/push.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRecord, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { reconcile } from "../reconcile/index.js";
import { source } from "../skills/fixtures/sources.js";
import {
  addSkill,
  appendSkillEvent,
  canonicalBody,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_NAMES,
  DEFAULT_MAX_PER_RUN,
  DEFAULT_MAX_RUN_BYTES,
  readSkillContent,
} from "../skills/index.js";
import { startTestCollector, type TestCollector } from "../telemetry/fixtures/collector.js";
import { createTelemetry, type Telemetry } from "../telemetry/index.js";
import { runRetentionGc, WorkspaceManager } from "../workspace/index.js";
import { createSwitchboardServer, type SwitchboardMcpServer } from "./index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "cli", "bin.ts");
const TS_REGISTER = path.join(HERE, "..", "reconcile", "fixtures", "ts-register.mjs");
const SHIM_COMMAND = [
  process.execPath,
  "--experimental-transform-types",
  "--no-warnings",
  "--import",
  TS_REGISTER,
  BIN,
  "tool-shim",
];
/** Short socket parent for the tool channel on macOS, where a temporary path is too long for a Unix socket. */
const SHORT_TMP = process.platform === "darwin" ? "/tmp" : tmpdir();
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
const TEST_TIMEOUT = 180_000;
const UNTRUSTED: readonly TrustProfile[] = ["inspect-untrusted", "edit-untrusted", "test-sandboxed"];
const OBJECTIVE = "OBJECTIVE-M16 fix the parser crash";
const ALPHA = ".fake/skills/switchboard-alpha-docs.md";
const BETA = ".fake/skills/switchboard-beta-review.md";
const NATIVE_DIR = ".fake/skills/switchboard-";
const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON checked by the published output schemas
type Json = Record<string, any>;

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

function settings(over: Partial<ResolvedSkills> = {}): ResolvedSkills {
  return {
    enabled: true,
    defaults: [],
    roles: { reviewer: ["beta-review"] },
    delivery: "native_preferred",
    allowDraftInTrusted: false,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    maxPerRun: DEFAULT_MAX_PER_RUN,
    maxRunBytes: DEFAULT_MAX_RUN_BYTES,
    maxNames: DEFAULT_MAX_NAMES,
    ...over,
  };
}

/** The configured project `web` over `repo`: writable, with a commit identity so the injected `commit` tool is offered. */
function project(repo: string): ResolvedProject {
  return {
    id: "web",
    name: "Web",
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
        identity: { name: "Ada Maintainer", email: "ada@example.test" },
      },
    ],
  };
}

/**
 * The real fake adapter with two test switches a run can flip without a new world: the scenario (the fake CLI reads it
 * from argv) and the delivery declaration (`native` with the T16.6 location, or `prompt_prefix` like every provider
 * today). Keeps every run's compiled invocation for the argv and environment comparison.
 */
class AcceptanceFake extends FakeAdapter {
  scenario: FakeScenario = "success";
  native = false;
  readonly compiled = new Map<string, Invocation>();
  constructor() {
    super({ timeouts: PATIENT });
  }
  override skillDelivery(): SkillDelivery {
    return this.native ? { native: FAKE_NATIVE_SKILL_LOCATION } : "prompt_prefix";
  }
  override compile(req: CompileRequest, p: ResolvedProfile): Invocation | Ineligible {
    const inv = super.compile(req, p);
    if ("ineligible" in inv) return inv;
    const argv = inv.argv.map((a, i) => (i > 0 && inv.argv[i - 1] === "--scenario" ? this.scenario : a));
    const out = { ...inv, argv };
    if (req.runId !== "route-check") this.compiled.set(req.runId, out);
    return out;
  }
}

interface World {
  root: string;
  repo: string;
  dataDir: string;
  db: Database.Database;
  ledger: Ledger;
  artifacts: ArtifactStore;
  workspace: WorkspaceManager;
  service: GitToolService;
  collector: TestCollector;
  telemetry: Telemetry;
  sinks: SinkDispatcher;
  sinkBodies: string[];
  logLines: string[];
  fake: AcceptanceFake;
  fakeB: StatefulFake;
  lifecycle: RunLifecycle;
  mcp: SwitchboardMcpServer;
  client: Client;
  unregister: () => void;
  /** Injected unlink failures left (T16.6 fault injection); 0 means the real unlink. */
  unlinkFailures: number;
  /** A random canary in every store skill body (TDD §3.16.2 property 6). */
  canary: string;
  /** Approved versions by name, and their canonical bodies as delivered. */
  versions: Record<string, { version: number; sha256: string }>;
  bodies: Record<string, string>;
}

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await closeWorld(w);
});

interface Options {
  /** `absent`: no store wired at all (the server has no `skills` dep). */
  skills?: ResolvedSkills | "absent";
}

/**
 * The operator's store: `alpha-docs` and `beta-review` approved; `drafty` with an approved version 1 and a draft
 * version 2; `repo-made` imported with `--from-repository` and approved (`repository_path`).
 */
function fillStore(db: Database.Database, dataDir: string, root: string, canary: string) {
  const dir = path.join(root, "operator-skills");
  const repoDir = path.join(root, "skill-repo");
  mkdirSync(dir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  const versions: World["versions"] = {};
  const put = (name: string, edition: string, opts: { repo?: boolean; approve?: boolean } = {}) => {
    const file = path.join(opts.repo ? repoDir : dir, `${name}-${edition}.md`);
    writeFileSync(file, source(`# ${name}\n\nOperator playbook for ${name}, ${edition}. ${canary}\n`, { name }));
    const r = addSkill(
      db,
      dataDir,
      { name, file, ...(opts.repo ? { fromRepository: true } : {}) },
      { repositoryRoots: opts.repo ? [repoDir] : [] },
    );
    if (r.kind !== "added") throw new Error(`add ${name}: ${JSON.stringify(r)}`);
    if (opts.approve === false) return;
    appendSkillEvent(db, { name, version: r.version, kind: "approved" });
    versions[name] = { version: r.version, sha256: r.sha256 };
  };
  put("alpha-docs", "approved");
  put("beta-review", "approved");
  put("drafty", "approved");
  put("drafty", "draft", { approve: false });
  put("repo-made", "imported", { repo: true });
  const bodies: Record<string, string> = {};
  for (const [name, v] of Object.entries(versions)) bodies[name] = canonicalBody(readSkillContent(dataDir, v.sha256));
  return { versions, bodies };
}

async function openWorld(o: Options = {}): Promise<World> {
  const root = realpathSync(mkdtempSync(path.join(SHORT_TMP, "sb-m16-")));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  const dataDir = path.join(root, "data");
  const home = path.join(root, "home");
  mkdirSync(dataDir);
  mkdirSync(home);
  const db = openLedger(dataDir);
  const ids = createIdGenerator();
  const ledger = createLedger(db, { ids });
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const canary = `SBM16-${randomBytes(10).toString("hex")}`;
  const { versions, bodies } = fillStore(db, dataDir, root, canary);
  const w = { unlinkFailures: 0 } as World;
  const workspace = new WorkspaceManager({
    db,
    artifacts,
    dataDir,
    allowedRoots: [root],
    ids,
    nativeSkillFs: {
      unlink: async (file) => {
        if (w.unlinkFailures > 0) {
          w.unlinkFailures -= 1;
          throw Object.assign(new Error("injected"), { code: "EACCES" });
        }
        const { unlink } = await import("node:fs/promises");
        await unlink(file);
      },
    },
  });
  const publisher = new GitPublisher({ db, scratchDir: path.join(dataDir, "git-scratch") });
  const service = new GitToolService({ db, dataDir, publisher, shimCommand: SHIM_COMMAND, fallbackDirs: [SHORT_TMP] });
  const collector = await startTestCollector();
  const telemetry = createTelemetry({ telemetry: { otlpEndpoint: collector.endpoint } });
  const logLines: string[] = [];
  const log = stderrLogger({
    stdout: { write: () => true },
    stderr: { write: (s: string) => logLines.push(s) },
    env: {},
  });
  const sinkBodies: string[] = [];
  const sink = (id: string): NotificationSinkSettings => ({
    id,
    kind: "webhook",
    url: `https://${id}.example.test/hook`,
    events: new Set(["run_terminal", "needs_attention"]),
    maxPerMinute: 1_000,
  });
  // `failing` answers 500, so a delivery failure reaches the logger and a `sink_delivery_failed` run event too.
  const sinks = new SinkDispatcher({
    sinks: [sink("capture"), sink("failing")],
    post: async (req) => {
      sinkBodies.push(JSON.stringify(req));
      return req.url.includes("failing") ? 500 : 200;
    },
    onOutcome: sinkOutcomeRecorder({ log, appendRunEvent: (e) => ledger.appendRunEvent(e) }),
  });
  const fake = new AcceptanceFake();
  const fakeB = secondFake({ home, timeouts: PATIENT });
  const unregister = registerProvider(secondFakeProvider(home));
  const registry = new AdapterRegistry().register(fake).register(fakeB);
  const lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots: [root],
    globalConcurrency: 2,
    perProviderConcurrency: 1,
    resolveProfile: profileFor,
    eligibility: {
      platform: "linux",
      gate: (id, version) => ({
        eligible: true,
        evidence: { provider: id, observedVersion: version, validatedRange: "test", validatedCliVersion: "test" },
      }),
    },
    skillDelivery: skillDeliveryPort(db, dataDir),
    skillDeliveryMode: "native_preferred",
    gitTools: service,
    telemetry,
    onTransition: transitionNotifier(sinks, (runId) => ledger.getRunRecord(runId)?.project_id),
  });
  lifecycle.start();
  // The ceiling is above every untrusted profile, so an untrusted request is judged by the skill gate, not the ceiling.
  const trusted: TrustProfile = "trusted-development";
  const orch: ResolvedMcpClient = { id: "orch", maxTrustProfile: trusted, projects: ["web"] };
  const skills = o.skills === "absent" ? undefined : (o.skills ?? settings());
  const mcp = createSwitchboardServer({
    lifecycle,
    ledger,
    artifacts,
    registry,
    config: { allowedRoots: [root], mcpClients: new Map([["orch", orch]]), projects: [project(repo)] },
    ...(skills === undefined ? {} : { skills: { db, dataDir, settings: skills } }),
    clientId: "orch",
  });
  const client = new Client({ name: "orch", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(st);
  await client.connect(ct);
  await client.listTools(); // caches output schemas: every result is checked against them
  Object.assign(w, {
    root,
    repo,
    dataDir,
    db,
    ledger,
    artifacts,
    workspace,
    service,
    collector,
    telemetry,
    sinks,
    sinkBodies,
    logLines,
    fake,
    fakeB,
    lifecycle,
    mcp,
    client,
    unregister,
    canary,
    versions,
    bodies,
  });
  worlds.push(w);
  return w;
}

async function closeWorld(w: World): Promise<void> {
  await w.client.close();
  await w.mcp.close();
  await w.lifecycle.shutdown();
  await w.sinks.close();
  await w.telemetry.close();
  await w.collector.close();
  await w.service.closeAll();
  w.unregister();
  w.db.close();
  rmSync(w.root, { recursive: true, force: true });
}

// ---- the scripted client ------------------------------------------------------------------------------------------

async function call(w: World, name: string, args: Json): Promise<{ isError: boolean; body: Json }> {
  const res = await w.client.callTool({ name, arguments: args });
  const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}") as Json;
  return { isError: res.isError === true, body };
}
async function ok(w: World, name: string, args: Json): Promise<Json> {
  const r = await call(w, name, args);
  expect(r.isError, JSON.stringify(r.body)).toBe(false);
  return r.body;
}
const delegate = (w: World, extra: Json = {}) =>
  call(w, "delegate_task", { objective: OBJECTIVE, project: "web", trust_profile: "edit-untrusted", ...extra });
/** Delegates, waits for the terminal state and returns the run id, its `get_run` view and the ledger record. */
async function delegated(w: World, extra: Json = {}): Promise<{ runId: string; run: Json; done: RunRecord }> {
  const r = await delegate(w, extra);
  expect(r.isError, JSON.stringify(r.body)).toBe(false);
  const runId = r.body.run_id as string;
  const done = await w.lifecycle.waitForTerminal(runId);
  return { runId, run: await ok(w, "get_run", { run_id: runId }), done };
}
const waitFor = async (check: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const plan = (steps: unknown[]) => JSON.stringify({ steps, hang: false });
const events = (w: World, runId: string) =>
  w.ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) as Json }));
const ofType = (w: World, runId: string, type: string) => events(w, runId).filter((e) => e.type === type);
const skillRows = (w: World, runId: string) =>
  w.db
    .prepare(
      `SELECT name, version, sha256, source, delivery, native_path, written_sha256, removal FROM run_skill
       WHERE run_id = ? ORDER BY position`,
    )
    .all(runId) as {
    name: string;
    version: number;
    sha256: string;
    source: string;
    delivery: string;
    native_path: string | null;
    written_sha256: string | null;
    removal: string | null;
  }[];
const runCount = (w: World) => (w.db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n;
const worktreeOf = (w: World, runId: string) => w.ledger.getRunRecord(runId)?.worktree_path as string;
const treeOf = (w: World, rev: string) => g(w.repo, "ls-tree", "-r", "--name-only", rev).split("\n");
const stdinOf = (w: World, runId: string) => {
  const s = w.fake.compiled.get(runId)?.stdin;
  return s?.kind === "text" ? s.value : "";
};
/** The parts of an invocation a skill may never change (LLD §19.6; the worktree `cwd` differs per run by design). */
const fixedParts = (inv: Invocation) => ({
  transport: inv.transport,
  argv: inv.argv,
  env: inv.env,
  envAllowlist: inv.envAllowlist,
  policyFlags: inv.policyFlags,
  outputFormat: inv.outputFormat,
});
/** The resolved entries `role: reviewer` plus `skills: [alpha-docs]` give (LLD §19.5 order: global role, then request). */
const resolvedSet = (w: World) =>
  (["beta-review", "alpha-docs"] as const).map((name) => ({
    name,
    version: w.versions[name]?.version as number,
    sha256: w.versions[name]?.sha256 as string,
    body: w.bodies[name] as string,
  }));

/** Every surface of the canary clause, as text, once the runs have ended and the exporters have flushed. */
async function captureSurfaces(w: World, runIds: readonly string[]): Promise<Record<string, string>> {
  await w.lifecycle.shutdown();
  await w.sinks.drain();
  await w.telemetry.close();
  const views: string[] = [];
  for (const id of runIds) {
    views.push(JSON.stringify(await ok(w, "get_run", { run_id: id, include_events: { after_seq: 0, limit: 200 } })));
    views.push(JSON.stringify(await ok(w, "get_artifacts", { run_id: id })));
  }
  return {
    event: runIds.flatMap((id) => w.ledger.listRunEvents(id).map((e) => `${e.type} ${e.payload_json}`)).join("\n"),
    run: runIds.map((id) => JSON.stringify(w.ledger.getRunRecord(id))).join("\n"),
    run_skill: runIds.map((id) => JSON.stringify(skillRows(w, id))).join("\n"),
    span: w.collector.bodies.join("\n"),
    log: w.logLines.join(""),
    artifact: await runArtifactsText(w.ledger, w.artifacts, runIds),
    sink: w.sinkBodies.join("\n"),
    mcp_view: views.join("\n"),
    repository: g(w.repo, "log", "--all", "-p", "--format=%H %B"),
  };
}

describe("M16 acceptance (T16.12)", () => {
  it(
    "a scripted MCP client lists skills and delegates with skills and a role to a fake adapter: the run records each skill's name, version, hash and mode",
    async () => {
      const w = await openWorld();
      // list_skills: the versions an untrusted run could get, metadata only (FR-SKL-08); the repository-imported
      // skill shows only at the client's trusted maximum.
      const list = await ok(w, "list_skills", { trust_profile: "edit-untrusted" });
      expect((list.skills as Json[]).map((s) => [s.name, s.version, s.approved])).toEqual([
        ["alpha-docs", 1, true],
        ["beta-review", 1, true],
        ["drafty", 1, true], // version 2 is a draft, so version 1 is what an untrusted run could get
      ]);
      expect(JSON.stringify(list)).not.toContain(w.canary);
      expect(((await ok(w, "list_skills", {})).skills as Json[]).map((s) => [s.name, s.origin])).toEqual([
        ["alpha-docs", "operator_file"],
        ["beta-review", "operator_file"],
        ["drafty", "operator_file"],
        ["repo-made", "repository_path"],
      ]);
      expect((await ok(w, "list_skills", { project: "web", role: "reviewer" })).defaults).toEqual([
        { name: "beta-review", version: 1, source: "global_role" },
      ]);

      // delegate_task with a skill and a role: the run records each skill (name, version, hash) and the delivery mode.
      const { runId, run } = await delegated(w, { skills: ["alpha-docs"], role: "reviewer" });
      expect(run.status).toBe("SUCCEEDED");
      const expected = resolvedSet(w);
      expect(run.skills).toEqual(
        expected.map((s, i) => ({
          name: s.name,
          version: s.version,
          sha256: s.sha256,
          source: i === 0 ? "global_role" : "request",
          delivery: "prompt_prefix",
        })),
      );
      expect(skillRows(w, runId).map((r) => [r.name, r.version, r.sha256, r.source, r.delivery])).toEqual(
        expected.map((s, i) => [s.name, s.version, s.sha256, i === 0 ? "global_role" : "request", "prompt_prefix"]),
      );
      expect(ofType(w, runId, "skill_resolved")[0]?.p.entries).toEqual(
        expected.map((s, i) => ({
          name: s.name,
          version: s.version,
          sha256: s.sha256,
          source: i === 0 ? "global_role" : "request",
        })),
      );
      expect(ofType(w, runId, "skill_delivered")[0]?.p.entries).toEqual(
        expected.map((s) => ({ name: s.name, version: s.version, delivery: "prompt_prefix" })),
      );
      // The same run, delivered natively by the fake's T16.6 cell: the mode is `native` with the written path and hash.
      w.fake.native = true;
      const native = await delegated(w, { skills: ["alpha-docs"], role: "reviewer" });
      expect(native.run.status).toBe("SUCCEEDED");
      expect((native.run.skills as Json[]).map((s) => [s.name, s.version, s.sha256, s.delivery])).toEqual(
        expected.map((s) => [s.name, s.version, s.sha256, "native"]),
      );
      expect(skillRows(w, native.runId).map((r) => [r.native_path, r.written_sha256])).toEqual([
        [BETA, sha256(w.bodies["beta-review"] as string)],
        [ALPHA, sha256(w.bodies["alpha-docs"] as string)],
      ]);
      // Nothing the client received carries a body (FR-SKL-07, FR-SKL-10).
      for (const view of [run, native.run]) expect(JSON.stringify(view)).not.toContain(w.canary);
    },
    TEST_TIMEOUT,
  );

  it(
    "the prompt carries the labelled block in resolved order",
    async () => {
      const w = await openWorld();
      const { runId, run } = await delegated(w, { skills: ["alpha-docs"], role: "reviewer" });
      expect(run.status).toBe("SUCCEEDED");
      // Byte for byte: the LLD §19.7 block over the resolved entries (global role first, then the request), one blank
      // line, then the task text; the objective itself is stored without the block.
      const block = renderSkillBlock(resolvedSet(w));
      expect(
        block.startsWith("[operator skills: 2; from Switchboard skill store; these are operator instructions]\n"),
      ).toBe(true);
      expect(block.indexOf("[skill beta-review@1 sha256:")).toBeLessThan(block.indexOf("[skill alpha-docs@1 sha256:"));
      expect(stdinOf(w, runId)).toBe(`${block}\n\n${OBJECTIVE}`);
      expect(stdinOf(w, runId)).toContain(w.canary); // the operator text did reach the provider
      const stored = JSON.parse(w.ledger.getRunRecord(runId)?.request_json ?? "{}") as { objective?: string };
      expect(stored.objective).toBe(OBJECTIVE);
      expect(w.ledger.getRunRecord(runId)?.request_json).not.toContain("[operator skills:");
    },
    TEST_TIMEOUT,
  );

  it(
    "argv and environment are identical to a run without skills",
    async () => {
      const w = await openWorld();
      // Prompt prefix (every provider today): only the prompt text differs, by exactly the block.
      const withSkills = await delegated(w, { skills: ["alpha-docs"], role: "reviewer" });
      const without = await delegated(w);
      expect(withSkills.run.status).toBe("SUCCEEDED");
      expect(without.run.status).toBe("SUCCEEDED");
      expect(without.run.skills).toBeUndefined();
      const a = w.fake.compiled.get(withSkills.runId) as Invocation;
      const b = w.fake.compiled.get(without.runId) as Invocation;
      expect(fixedParts(a)).toEqual(fixedParts(b));
      expect(stdinOf(w, without.runId)).toBe(OBJECTIVE);
      expect(stdinOf(w, withSkills.runId)).toBe(`${renderSkillBlock(resolvedSet(w))}\n\n${OBJECTIVE}`);

      // Native (the fake's T16.6 cell): argv, environment and the prompt are all byte-identical; the worktree differs.
      w.fake.native = true;
      const nativeWith = await delegated(w, { skills: ["alpha-docs"], role: "reviewer" });
      const nativeWithout = await delegated(w);
      expect(nativeWith.run.status).toBe("SUCCEEDED");
      expect(nativeWithout.run.status).toBe("SUCCEEDED");
      expect(skillRows(w, nativeWith.runId).map((r) => r.delivery)).toEqual(["native", "native"]);
      const c = w.fake.compiled.get(nativeWith.runId) as Invocation;
      const d = w.fake.compiled.get(nativeWithout.runId) as Invocation;
      expect(fixedParts(c)).toEqual(fixedParts(d));
      expect(c.stdin).toEqual(d.stdin);
      expect(fixedParts(c)).toEqual(fixedParts(b));
    },
    TEST_TIMEOUT,
  );

  it(
    "an untrusted run naming a draft or repository-imported skill is refused",
    async () => {
      const w = await openWorld();
      const before = runCount(w);
      for (const profile of UNTRUSTED) {
        for (const [ref, reason] of [
          ["drafty@2", "SKILL_NOT_APPROVED"],
          ["repo-made", "SKILL_REPOSITORY_ORIGIN"],
          ["repo-made@1", "SKILL_REPOSITORY_ORIGIN"],
        ] as const) {
          const r = await delegate(w, { trust_profile: profile, skills: [ref] });
          expect(r.isError, `${profile} ${ref}`).toBe(true);
          expect(r.body.error, `${profile} ${ref}`).toMatchObject({
            code: "PERMISSION_BLOCKED",
            details: { reason, skill: ref },
          });
          expect(JSON.stringify(r.body)).not.toContain(w.canary);
        }
      }
      // A refusal writes nothing: no run, no run_skill row.
      expect(runCount(w)).toBe(before);
      expect(w.db.prepare("SELECT COUNT(*) AS n FROM run_skill").get()).toEqual({ n: 0 });
      // The same name unpinned resolves to its approved version, and only that text reaches the provider.
      const { runId, run } = await delegated(w, { skills: ["drafty"] });
      expect(run.status).toBe("SUCCEEDED");
      expect(skillRows(w, runId).map((r) => [r.name, r.version])).toEqual([["drafty", 1]]);
      expect(stdinOf(w, runId)).not.toContain("drafty, draft");
      expect(stdinOf(w, runId)).toContain("drafty, approved");
    },
    TEST_TIMEOUT,
  );

  it(
    "a fake adapter's native skill file never appears in a commit, checkpoint, diff, patch or handoff, blocks publication while present and is gone after every terminal state, a restart and GC",
    async () => {
      const w = await openWorld();
      w.fake.native = true;
      w.fake.scenario = "git_attempts";
      const skills = { skills: ["alpha-docs"], role: "reviewer" };

      // 1. SUCCEEDED: the agent edits, stages and commits around its skill files, through the tool and with plain Git.
      const steps = [
        { op: "append", path: ALPHA, content: "agent edit\n" },
        { op: "add", path: ALPHA },
        { op: "add", path: BETA },
        { op: "write", path: "feature.txt", content: "feature\n" },
        { op: "tool_commit", arguments: { message: "Add the feature" } },
        { op: "write", path: "second.txt", content: "second\n" },
        { op: "tool_commit", arguments: { message: "Add second", paths: [ALPHA, "second.txt"] } },
        { op: "commit", message: "plain commit with everything" },
      ];
      const first = await delegated(w, { objective: plan(steps), ...skills });
      expect(first.run.status, first.done.failure_detail ?? "").toBe("SUCCEEDED");
      expect(skillRows(w, first.runId).map((r) => [r.delivery, r.native_path, r.removal])).toEqual([
        ["native", BETA, "verified"],
        ["native", ALPHA, "verified"],
      ]);
      expect(ofType(w, first.runId, "skill_tampered")).toHaveLength(1); // the edit was noticed and recorded
      const session = first.run.meta_session_id as string;
      // Commit: the publish ref holds the tool commits and no recorded path; the patches (`log -p`) show no skill file.
      const pub = publishRefFor(session);
      expect(g(w.repo, "rev-list", "--count", `main..${pub}`)).toBe("2");
      for (const sha of g(w.repo, "rev-list", `main..${pub}`).split("\n")) {
        expect(treeOf(w, sha)).not.toContain(ALPHA);
        expect(treeOf(w, sha)).not.toContain(BETA);
      }
      expect(treeOf(w, pub)).toEqual(expect.arrayContaining(["feature.txt", "second.txt"]));
      const patches = g(w.repo, "log", "--all", "-p", "--format=%H %B");
      expect(patches).toContain("feature.txt");
      expect(patches).not.toContain(NATIVE_DIR);
      expect(patches).not.toContain(w.canary);
      // Checkpoint: the post-run checkpoint has the agent's work and no recorded path.
      const post = treeOf(w, w.ledger.getRunCheckpointCommit(first.runId, "post") as string);
      expect(post).toContain("feature.txt");
      expect(post).not.toContain(ALPHA);
      expect(post).not.toContain(BETA);
      // Diff and changed_files artifacts: neither names a recorded path or carries a body.
      const artifactText = await runArtifactsText(w.ledger, w.artifacts, [first.runId]);
      expect(artifactText).toContain("feature.txt");
      expect(artifactText).not.toContain(NATIVE_DIR);
      expect(artifactText).not.toContain(w.canary);
      expect(existsSync(path.join(worktreeOf(w, first.runId), ALPHA))).toBe(false);

      // Handoff: the successor on the other fake gets a bundle with neither the path nor a body in it.
      const cont = await call(w, "continue_task", {
        meta_session_id: session,
        instruction: "Carry on",
        routing: { provider_preference: SECOND_FAKE_ID },
      });
      expect(cont.isError, JSON.stringify(cont.body)).toBe(false);
      const handoff = cont.body.run_id as string;
      expect((await w.lifecycle.waitForTerminal(handoff)).state).toBe("SUCCEEDED");
      const handoffRun = await ok(w, "get_run", { run_id: handoff });
      expect(handoffRun.provider).toMatchObject({ adapter: SECOND_FAKE_ID });
      const view = w.ledger.listArtifactsForRun(handoff).find((a) => a.kind === "handoff_view");
      expect(view).toBeDefined();
      expect(handoffRun.artifacts.handoff_view).toBe(view?.id);
      const bundle = (await w.artifacts.get(view?.sha256 as string)).toString("utf8");
      expect(bundle).toContain("feature.txt");
      // The orchestrator's own objective (the plan) names the path; that is its text and travels as the goal. Nothing
      // else in the bundle (changed files, diff excerpts, runs, decisions, paths to inspect) names it or holds a body.
      const { goal, ...rest } = JSON.parse(bundle) as Json;
      expect(goal).toContain(ALPHA);
      expect(JSON.stringify(rest)).not.toContain(NATIVE_DIR);
      expect(bundle).not.toContain(w.canary);
      // The successor's own prompt names the path only where it quotes that goal (it gets the same skill versions, in
      // its provider's way: the prefix block, since the second fake declares no native cell).
      const occurrences = (text: string) => text.split(NATIVE_DIR).length - 1;
      const promptLog = readFileSync(w.fakeB.reports.at(-1)?.prompt_log as string, "utf8");
      expect(promptLog).toContain("Carry on");
      expect(occurrences(promptLog)).toBeLessThanOrEqual(occurrences(goal as string));
      expect(skillRows(w, handoff).map((r) => [r.name, r.version, r.source])).toEqual([
        ["beta-review", 1, "continued"],
        ["alpha-docs", 1, "continued"],
      ]);

      // 2. FAILED after the provider ran.
      w.fake.scenario = "task_failure";
      const failed = await delegated(w, { objective: "fail", ...skills });
      expect(failed.run.status).toBe("FAILED");
      expect(skillRows(w, failed.runId).map((r) => r.removal)).toEqual(["verified", "verified"]);
      expect(existsSync(path.join(worktreeOf(w, failed.runId), ALPHA))).toBe(false);

      // 3. CANCELLED while the provider runs: the file is there during the run and gone after cancel_run.
      w.fake.scenario = "hang";
      const hung = await delegate(w, { objective: "hang", ...skills });
      expect(hung.isError, JSON.stringify(hung.body)).toBe(false);
      const hangId = hung.body.run_id as string;
      await waitFor(() => w.ledger.getRunRecord(hangId)?.state === "RUNNING");
      expect(existsSync(path.join(worktreeOf(w, hangId), ALPHA))).toBe(true);
      await ok(w, "cancel_run", { run_id: hangId });
      expect((await w.lifecycle.waitForTerminal(hangId)).state).toBe("CANCELLED");
      expect(skillRows(w, hangId).map((r) => r.removal)).toEqual(["verified", "verified"]);
      expect(existsSync(path.join(worktreeOf(w, hangId), ALPHA))).toBe(false);

      // 4. Publication blocked while present, GC removes it: with every unlink failing the file stays, the run is
      // flagged, `push` is refused, and (after step 5) retention GC removes it and clears the flag.
      w.fake.scenario = "git_attempts";
      w.unlinkFailures = 1_000;
      const stuck = await delegated(w, {
        objective: plan([
          { op: "add", path: ALPHA },
          { op: "write", path: "work.txt", content: "work\n" },
        ]),
        ...skills,
      });
      expect(stuck.run.status).toBe("SUCCEEDED");
      expect(skillRows(w, stuck.runId).map((r) => r.removal)).toEqual(["failed", "failed"]);
      expect(existsSync(path.join(worktreeOf(w, stuck.runId), ALPHA))).toBe(true);
      expect(stuck.run.needs_attention).toEqual({ active: true, reason: "skill_cleanup_failed" });
      const stuckPost = treeOf(w, w.ledger.getRunCheckpointCommit(stuck.runId, "post") as string);
      expect(stuckPost).toContain("work.txt");
      expect(stuckPost).not.toContain(ALPHA);
      const pusher = new GitPusher({
        db: w.db,
        resolveContext: () => ({
          projectId: "web",
          contextId: "main",
          path: w.repo,
          baseRef: "main",
          policy: "branch",
        }),
      });
      const refused = await pusher.push({
        metaSessionId: stuck.run.meta_session_id as string,
        requestedBy: "operator",
      });
      expect(refused).toMatchObject({ pushed: false, outcome: "REFUSED_POLICY", reason: "SKILL_PATH_PRESENT" });
      w.unlinkFailures = 0;
      await w.lifecycle.shutdown();

      // 5. A restart: a run found RUNNING by startup reconciliation (the controller died with the file delivered and
      // the agent's edit staged) has the file removed before its worktree is assessed; the checkpoint never has it.
      const crashed = await inFlightRunning(w);
      writeFileSync(path.join(crashed.wt, ALPHA), "edited\n");
      g(crashed.wt, "add", "-f", ALPHA);
      writeFileSync(path.join(crashed.wt, "work.txt"), "work\n");
      await reconcile({ db: w.db, ledger: w.ledger, workspace: w.workspace, killGraceMs: 300 });
      expect(["FAILED", "SUCCEEDED"]).toContain(w.ledger.getRunRecord(crashed.runId)?.state);
      expect(existsSync(path.join(crashed.wt, ALPHA))).toBe(false);
      expect(skillRows(w, crashed.runId).map((r) => r.removal)).toEqual(["verified"]);
      expect(ofType(w, crashed.runId, "skill_removed").map((e) => e.p.point)).toEqual(["reconciliation"]);
      const crashedPost = treeOf(w, w.ledger.getRunCheckpointCommit(crashed.runId, "post") as string);
      expect(crashedPost).toContain("work.txt");
      expect(crashedPost).not.toContain(ALPHA);

      // 6. GC (the stuck run of step 4): removal verified at point `gc`, the flag cleared, `push` no longer refused.
      const gc = await runRetentionGc({
        db: w.db,
        artifacts: w.artifacts,
        dataDir: w.dataDir,
        days: 0,
        now: new Date(Date.now() + 86_400_000),
      });
      expect(gc.errors).toEqual([]);
      expect(skillRows(w, stuck.runId).map((r) => r.removal)).toEqual(["verified", "verified"]);
      expect(ofType(w, stuck.runId, "skill_removed").at(-1)?.p.point).toBe("gc");
      expect(needsAttentionOf(w.ledger, w.ledger.getRunRecord(stuck.runId) as RunRecord, { now: new Date() })).toEqual({
        active: false,
      });
      const after = await pusher.push({ metaSessionId: stuck.run.meta_session_id as string, requestedBy: "operator" });
      expect(after.reason).not.toBe("SKILL_PATH_PRESENT");
      // No recorded path exists on disk for any run of this test.
      for (const id of [first.runId, handoff, failed.runId, hangId, crashed.runId, stuck.runId]) {
        for (const p of [ALPHA, BETA])
          expect(existsSync(path.join(worktreeOf(w, id) ?? w.root, p)), `${id} ${p}`).toBe(false);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "no event, span, log or sink contains a planted canary from a skill body",
    async () => {
      const w = await openWorld();
      // A native run whose agent edits, stages and commits around its skill files, then a prompt-prefix run.
      w.fake.native = true;
      w.fake.scenario = "git_attempts";
      const native = await delegated(w, {
        objective: plan([
          { op: "append", path: ALPHA, content: "agent edit\n" },
          { op: "add", path: ALPHA },
          { op: "write", path: "feature.txt", content: "feature\n" },
          { op: "tool_commit", arguments: { message: "Add the feature" } },
        ]),
        skills: ["alpha-docs"],
        role: "reviewer",
      });
      expect(native.run.status, native.done.failure_detail ?? "").toBe("SUCCEEDED");
      expect(skillRows(w, native.runId).map((r) => r.delivery)).toEqual(["native", "native"]);
      w.fake.native = false;
      w.fake.scenario = "success";
      const prefix = await delegated(w, { skills: ["alpha-docs"], role: "reviewer" });
      expect(prefix.run.status).toBe("SUCCEEDED");
      // The canary did reach the provider (the files, then the prompt), so its absence below means something.
      expect(skillRows(w, native.runId).map((r) => r.written_sha256)).toEqual([
        sha256(w.bodies["beta-review"] as string),
        sha256(w.bodies["alpha-docs"] as string),
      ]);
      expect(stdinOf(w, prefix.runId)).toContain(w.canary);

      await w.collector.waitForSpans((s) => s.length >= 4, 10_000);
      const capture = await captureSurfaces(w, [native.runId, prefix.runId]);
      // Each surface really captured something for these runs.
      expect(capture.event).toContain("skill_delivered");
      expect(capture.event).toContain("sink_delivery_failed");
      expect(capture.span).toContain(native.runId);
      expect(capture.log).toContain("notification sink delivery failed");
      expect(capture.artifact).toContain("feature.txt");
      expect(capture.sink).toContain(native.runId);
      expect(capture.mcp_view).toContain("skill_delivered");
      expect(capture.repository).toContain("feature.txt");
      expect(surfacesContaining(capture, w.canary)).toEqual([]);
      expect(surfacesContaining(capture, "Operator playbook for")).toEqual([]);
      // Positive control: the detector reports a surface the canary is planted on.
      expect(surfacesContaining({ ...capture, planted: `x ${w.canary} y` }, w.canary)).toEqual(["planted"]);
    },
    TEST_TIMEOUT,
  );

  it(
    "with skills disabled every behaviour is unchanged",
    async () => {
      // Baseline: skills enabled, a run that names none.
      const on = await openWorld();
      const onTools = JSON.stringify(
        (await on.client.listTools()).tools.filter((t) => !t.name.endsWith("_skill") && t.name !== "list_skills"),
      );
      const onRun = await delegated(on);
      expect(onRun.run.status).toBe("SUCCEEDED");
      const onTypes = events(on, onRun.runId).map((e) => e.type);
      const onInv = on.fake.compiled.get(onRun.runId) as Invocation;
      await closeWorld(worlds.splice(worlds.indexOf(on), 1)[0] as World);

      for (const mode of ["disabled", "absent"] as const) {
        const w = await openWorld({ skills: mode === "absent" ? "absent" : settings({ enabled: false }) });
        // The tool list has no skill tool, and is otherwise what the enabled installation offers.
        const names = (await w.client.listTools()).tools.map((t) => t.name);
        expect(names).not.toContain("list_skills");
        expect(names).not.toContain("get_skill");
        expect(JSON.stringify((await w.client.listTools()).tools)).toBe(onTools);
        // A run without the fields: the same invocation (argv, environment, prompt), the same events, no skill record.
        const { runId, run } = await delegated(w);
        expect(run.status).toBe("SUCCEEDED");
        expect(run.skills).toBeUndefined();
        const inv = w.fake.compiled.get(runId) as Invocation;
        expect(fixedParts(inv)).toEqual(fixedParts(onInv));
        expect(inv.stdin).toEqual(onInv.stdin);
        expect(stdinOf(w, runId)).toBe(OBJECTIVE);
        expect(events(w, runId).map((e) => e.type)).toEqual(onTypes);
        expect(w.db.prepare("SELECT COUNT(*) AS n FROM run_skill").get()).toEqual({ n: 0 });
        // The fields are refused as SKILLS_DISABLED on each tool, and nothing is written.
        const before = runCount(w);
        for (const f of [{ skills: ["alpha-docs"] }, { role: "reviewer" }, { skill_defaults: "omit" }]) {
          const d = await delegate(w, f);
          expect(d.body.error, JSON.stringify(f)).toMatchObject({
            code: "INVALID_REQUEST",
            details: { reason: "SKILLS_DISABLED" },
          });
          const c = await call(w, "continue_task", { meta_session_id: run.meta_session_id, instruction: "more", ...f });
          expect(c.body.error, JSON.stringify(f)).toMatchObject({
            code: "INVALID_REQUEST",
            details: { reason: "SKILLS_DISABLED" },
          });
        }
        expect(runCount(w)).toBe(before);
        for (const tool of ["list_skills", "get_skill"]) {
          expect((await call(w, tool, { name: "alpha-docs" })).body.error).toMatchObject({ code: "INVALID_REQUEST" });
        }
        await closeWorld(worlds.splice(worlds.indexOf(w), 1)[0] as World);
      }
    },
    TEST_TIMEOUT,
  );
});

/**
 * A run walked through the FRD edges to RUNNING with its worktree prepared and `alpha-docs` delivered natively by the
 * T16.6 writer, as the controller leaves one when it dies mid-run (the reconciliation fixture of
 * `src/reconcile/native-skills.test.ts`).
 */
async function inFlightRunning(w: World): Promise<{ runId: string; wt: string }> {
  const sess = w.ledger.createMetaSession({ objective: "synthetic", projectId: "web" });
  const created = w.ledger.createRun({
    metaSessionId: sess.id,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {
      objective: "synthetic",
      workspace: w.repo,
      constraints: [],
      trust_profile: "edit-untrusted",
      provider: "fake",
    },
    requestHash: "h",
    clientId: "orch",
    projectId: "web",
    provider: "fake",
  });
  let cur = w.ledger.getRunRecord(created.id) as RunRecord;
  let wt = "";
  for (const [to, rule] of [
    ["PREFLIGHT", "T4"],
    ["LEASED", "T5"],
    ["RUNNING", "T9"],
  ] as const) {
    cur = w.ledger.casRunState({
      runId: cur.id,
      from: cur.state,
      to,
      expectedVersion: cur.version,
      payload: { rule },
    }) as RunRecord;
    if (to === "LEASED") {
      const ws = await w.workspace.prepare({
        metaSessionId: sess.id,
        runId: cur.id,
        workspace: w.repo,
        trustProfile: "edit-untrusted",
      });
      if (ws.mode !== "worktree") throw new Error("expected a worktree");
      wt = ws.worktreePath;
      const v = w.versions["alpha-docs"] as { version: number; sha256: string };
      w.db
        .prepare(
          `INSERT INTO run_skill (run_id, position, name, version, sha256, source, delivery)
           VALUES (?, 0, 'alpha-docs', ?, ?, 'request', 'prompt_prefix')`,
        )
        .run(cur.id, v.version, v.sha256);
      const out = await w.workspace.writeNativeSkills(cur.id, FAKE_NATIVE_SKILL_LOCATION, [
        { name: "alpha-docs", version: v.version, sha256: v.sha256, body: w.bodies["alpha-docs"] as string },
      ]);
      expect(out[0]?.delivery).toBe("native");
      w.workspace.markNativeDelivered(cur.id, new Date().toISOString());
      cur = w.ledger.getRunRecord(cur.id) as RunRecord;
    }
  }
  expect(cur.state).toBe("RUNNING");
  return { runId: cur.id, wt };
}
