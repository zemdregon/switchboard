/**
 * Malicious-fixture suite, skills leg (T16.11; FR-SKL-04, FR-SKL-06, FR-SKL-10, NFR-SEC-03, R-69; TDD §3.16.2 properties
 * 3, 4 and 6 and its last paragraph; LLD §19.6 step 2, §19.8, §19.11; ADR-0056 items 4, 8 and 13).
 *
 * The hostile repository of ./fixture.ts gains its own `.claude/skills` skill, `.cursor/rules` rules, a skill-loading
 * instruction in `AGENTS.md` and a pre-existing `switchboard-` path, or a committed `.claude` symbolic link leaving the
 * worktree (`addSkillHostility`). Runs go through the REAL lifecycle with the production skill store, admission port
 * (`skillAdmissionPort`) and delivery port (`skillDeliveryPort`), the T16.6 native writer and cleaner, the injected
 * `commit` tool, the T8.3 in-process OTLP collector, a notification sink dispatcher with a capturing transport and the
 * `serve` JSON-lines logger. The fake agent (./skill-agent.mjs) reports the hashes of the native skill files it finds
 * and, in the R-69 test, copies them elsewhere in the worktree before the fake CLI commits.
 *
 * Every store skill body carries a random canary; every repository skill, rule and instruction carries another. No
 * provider CLI, login or network is used. Positive controls at the end show each detector fires.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScenario } from "../../src/adapters/fake/adapter.js";
import {
  AdapterRegistry,
  type CompileRequest,
  type Ineligible,
  type Invocation,
  type NativeSkillLocation,
  type ResolvedProfile,
  type SkillDelivery,
} from "../../src/adapters/index.js";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { skillDeliveryPort, stderrLogger } from "../../src/cli/serve.js";
import type { ResolvedSkills } from "../../src/config/index.js";
import type { NotificationSinkSettings } from "../../src/config/notification-sinks.js";
import { needsAttentionOf } from "../../src/control/needs-attention.js";
import { SinkDispatcher, sinkOutcomeRecorder, transitionNotifier } from "../../src/control/sinks.js";
import { GitToolService } from "../../src/git/channel.js";
import { GitPublisher, publishRefFor } from "../../src/git/index.js";
import { createIdGenerator } from "../../src/ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../../src/ledger/index.js";
import { RunLifecycle, type SkillDeliveryPort } from "../../src/lifecycle/index.js";
import type { ProjectSnapshot } from "../../src/policy/index.js";
import { source } from "../../src/skills/fixtures/sources.js";
import {
  addSkill,
  appendSkillEvent,
  canonicalBody,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_NAMES,
  DEFAULT_MAX_PER_RUN,
  DEFAULT_MAX_RUN_BYTES,
  readSkillContent,
  SkillAdmissionError,
  skillAdmissionPort,
} from "../../src/skills/index.js";
import { startTestCollector, type TestCollector } from "../../src/telemetry/fixtures/collector.js";
import { createTelemetry, type Telemetry } from "../../src/telemetry/index.js";
import { WorkspaceManager } from "../../src/workspace/index.js";
import { runArtifactsText, surfacesContaining, treeHash, treeText } from "./detectors.js";
import { addSkillHostility, buildMaliciousFixture, type MaliciousFixture, type SkillHostility, tg } from "./fixture.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(HERE, "skill-agent.mjs");
const BIN = path.join(HERE, "..", "..", "src", "cli", "bin.ts");
const TS_REGISTER = path.join(HERE, "..", "..", "src", "reconcile", "fixtures", "ts-register.mjs");
const SHIM_COMMAND = [
  process.execPath,
  "--experimental-transform-types",
  "--no-warnings",
  "--import",
  TS_REGISTER,
  BIN,
  "tool-shim",
];
/** Short socket parent for the tool channel on macOS, where the fixture's temporary path is too long. */
const SOCKET_PARENT = process.platform === "darwin" ? "/tmp" : tmpdir();
const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const TEST_TIMEOUT = 120_000;
const UNTRUSTED: readonly TrustProfile[] = ["inspect-untrusted", "edit-untrusted", "test-sandboxed"];

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

/** The fake's T16.6 location (`.fake/skills/switchboard-<name>.md`) and two test-only cells over hostile directories. */
const FAKE_CELL: NativeSkillLocation = {
  dir: ".fake/skills",
  layout: { ext: "md" },
  render: (s) => s.body,
  evidence: "fake-test-only",
};
const CLAUDE_CELL: NativeSkillLocation = { ...FAKE_CELL, dir: ".claude/skills", layout: { file: "SKILL.md" } };
const CURSOR_CELL: NativeSkillLocation = { ...FAKE_CELL, dir: ".cursor/rules", layout: { ext: "mdc" } };
const ALPHA = ".fake/skills/switchboard-alpha-docs.md";
const BETA = ".fake/skills/switchboard-beta-review.md";

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

/** The real fake adapter (or ./skill-agent.mjs in front of it) declaring `cell`; keeps every run's invocation. */
class SkillLegAdapter extends FakeAdapter {
  constructor(
    private readonly cell: NativeSkillLocation | undefined,
    private readonly mode: "report" | "copy",
    scenario: FakeScenario,
    private readonly compiled: Map<string, Invocation>,
  ) {
    super({ scenario, script: AGENT, timeouts: PATIENT });
  }
  override skillDelivery(): SkillDelivery {
    return this.cell === undefined ? "prompt_prefix" : { native: this.cell };
  }
  override compile(req: CompileRequest, p: ResolvedProfile): Invocation | Ineligible {
    const inv = super.compile(req, p);
    if ("ineligible" in inv) return inv;
    const out = { ...inv, env: { ...inv.env, SKILL_AGENT_MODE: this.mode } };
    this.compiled.set(req.runId, out);
    return out;
  }
}

interface World {
  fx: MaliciousFixture;
  hostile: SkillHostility;
  db: Database.Database;
  ledger: Ledger;
  artifacts: ArtifactStore;
  service: GitToolService;
  collector: TestCollector;
  telemetry: Telemetry;
  sinks: SinkDispatcher;
  sinkBodies: string[];
  logLines: string[];
  compiled: Map<string, Invocation>;
  lifecycle?: RunLifecycle | undefined;
  /** A random canary in every store skill body (TDD §3.16.2 property 6). */
  canary: string;
  /** Store bodies as delivered (canonical body), by name. */
  bodies: Record<string, string>;
  versions: Record<string, { version: number; sha256: string }>;
}

let w: World;

function settings(defaults: string[] = []): ResolvedSkills {
  return {
    enabled: true,
    defaults,
    roles: {},
    delivery: "native_preferred",
    allowDraftInTrusted: false,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    maxPerRun: DEFAULT_MAX_PER_RUN,
    maxRunBytes: DEFAULT_MAX_RUN_BYTES,
    maxNames: DEFAULT_MAX_NAMES,
  };
}

function project(): ProjectSnapshot {
  return {
    id: "web",
    name: "Web",
    environment_kind: "host",
    context_id: "main",
    base_ref: "main",
    effective_max_profile: "trusted-development",
    writable: true,
    identity: { name: "Ada Maintainer", email: "ada@example.test" },
    push: { policy: "none" },
  };
}

/**
 * The operator's store: `alpha-docs` and `beta-review` approved from operator files; `hostile-helper` imported from the
 * hostile repository's own skill with `--from-repository` and approved (`repository_path`); `gamma-review` has an
 * approved version 1 and a newer draft version 2; `delta-draft` has only a draft. `versions` names the approved ones.
 */
function fillStore(x: Pick<World, "fx" | "hostile" | "db" | "canary">) {
  const dir = path.join(x.fx.base, "operator-skills");
  mkdirSync(dir, { recursive: true });
  const dataDir = x.fx.dataDir;
  const versions: World["versions"] = {};
  const put = (name: string, file: string, opts: { repo?: boolean; approve?: boolean } = {}) => {
    const r = addSkill(
      x.db,
      dataDir,
      { name, file, ...(opts.repo ? { fromRepository: true } : {}) },
      { repositoryRoots: opts.repo ? [x.fx.repo] : [] },
    );
    if (r.kind !== "added") throw new Error(`add ${name}: ${JSON.stringify(r)}`);
    if (opts.approve === false) return;
    appendSkillEvent(x.db, { name, version: r.version, kind: "approved" });
    versions[name] = { version: r.version, sha256: r.sha256 };
  };
  const operatorFile = (name: string, edition: string, approve = true) => {
    const file = path.join(dir, `${name}-${edition}.md`);
    writeFileSync(file, source(`# ${name}\n\nOperator playbook for ${name}, ${edition}. ${x.canary}\n`, { name }));
    put(name, file, { approve });
  };
  for (const name of ["alpha-docs", "beta-review", "gamma-review"]) operatorFile(name, "approved");
  operatorFile("gamma-review", "draft", false);
  operatorFile("delta-draft", "draft", false);
  put("hostile-helper", x.hostile.repoSkillFile, { repo: true });
  const bodies: Record<string, string> = {};
  for (const [name, v] of Object.entries(versions)) bodies[name] = canonicalBody(readSkillContent(dataDir, v.sha256));
  return { versions, bodies };
}

async function setUp(opts: { claudeLink?: boolean } = {}): Promise<void> {
  const fx = buildMaliciousFixture();
  const hostile = addSkillHostility(fx, opts);
  const db = openLedger(fx.dataDir);
  const ledger = createLedger(db, { ids: createIdGenerator() });
  const canary = `SBSKILL-${randomBytes(10).toString("hex")}`;
  const { versions, bodies } = fillStore({ fx, hostile, db, canary });
  const publisher = new GitPublisher({ db, scratchDir: path.join(fx.dataDir, "git-scratch") });
  const service = new GitToolService({
    db,
    dataDir: fx.dataDir,
    publisher,
    shimCommand: SHIM_COMMAND,
    fallbackDirs: [SOCKET_PARENT],
  });
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
  w = {
    fx,
    hostile,
    db,
    ledger,
    artifacts: new ArtifactStore(path.join(fx.dataDir, "artifacts")),
    service,
    collector,
    telemetry,
    sinks,
    sinkBodies,
    logLines,
    compiled: new Map(),
    canary,
    bodies,
    versions,
  };
}

afterEach(async () => {
  if (w === undefined) return;
  await w.lifecycle?.shutdown();
  await w.sinks.close();
  await w.telemetry.close();
  await w.collector.close();
  await w.service.closeAll();
  w.db.close();
  w.fx.close();
});

interface Make {
  cell?: NativeSkillLocation;
  mode?: "report" | "copy";
  scenario?: FakeScenario;
  /** Negative control only: a delivery port that leaks each body into a run event. */
  leakyPort?: boolean;
}

async function lifecycle(o: Make = {}): Promise<RunLifecycle> {
  await w.lifecycle?.shutdown();
  const ids = createIdGenerator();
  const workspace = new WorkspaceManager({
    db: w.db,
    artifacts: w.artifacts,
    dataDir: w.fx.dataDir,
    allowedRoots: [w.fx.allowedRoot],
    ids,
  });
  const real = skillDeliveryPort(w.db, w.fx.dataDir);
  const port: SkillDeliveryPort = o.leakyPort
    ? {
        load: (runId) => {
          const skills = real.load(runId);
          for (const s of skills) w.ledger.appendRunEvent({ runId, type: "leak_probe", payload: { body: s.body } });
          return skills;
        },
        record: real.record,
      }
    : real;
  const lc = new RunLifecycle({
    ledger: w.ledger,
    workspace,
    artifacts: w.artifacts,
    adapters: new AdapterRegistry().register(
      new SkillLegAdapter(o.cell ?? FAKE_CELL, o.mode ?? "report", o.scenario ?? "git_attempts", w.compiled),
    ),
    allowedRoots: [w.fx.allowedRoot],
    globalConcurrency: 2,
    resolveProfile: profileFor,
    skillDelivery: port,
    skillDeliveryMode: "native_preferred",
    gitTools: w.service,
    telemetry: w.telemetry,
    onTransition: transitionNotifier(w.sinks, (runId) => w.ledger.getRunRecord(runId)?.project_id),
  });
  lc.start();
  w.lifecycle = lc;
  return lc;
}

function admission(fields: { skills?: string[] }, defaults: string[] = []) {
  return skillAdmissionPort({ db: w.db, settings: settings(defaults), fields });
}

async function run(
  lc: RunLifecycle,
  objective: string,
  opts: { profile?: TrustProfile; skills?: string[]; defaults?: string[] } = {},
) {
  const { runId, metaSessionId } = await lc.submit({
    clientId: "c",
    objective,
    workspace: w.fx.repo,
    trustProfile: opts.profile ?? "edit-untrusted",
    provider: "fake",
    project: project(),
    skills: admission(opts.skills !== undefined ? { skills: opts.skills } : {}, opts.defaults ?? []),
  });
  return { runId, metaSessionId, done: await lc.waitForTerminal(runId) };
}

const plan = (steps: unknown[]) => JSON.stringify({ steps, hang: false });
const events = (runId: string) =>
  w.ledger
    .listRunEvents(runId)
    .map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) as Record<string, unknown> }));
const ofType = (runId: string, type: string) => events(runId).filter((e) => e.type === type);
const skillRows = (runId: string) =>
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
const worktreeOf = (runId: string) => w.ledger.getRunRecord(runId)?.worktree_path as string;
const treeOf = (rev: string) => tg(w.fx.repo, "ls-tree", "-r", "--name-only", rev).split("\n");
const stdinOf = (runId: string) => {
  const s = w.compiled.get(runId)?.stdin;
  return s?.kind === "text" ? s.value : "";
};
/** The fake agent's `skill_report` (native file name -> SHA-256), from the run's stored provider output. */
async function agentReport(runId: string): Promise<Record<string, string>> {
  const text = await runArtifactsText(w.ledger, w.artifacts, [runId]);
  const m = /\{\\?"skill_report\\?":(\{[^}]*\})\}/u.exec(text);
  if (m === null) throw new Error("no skill_report in the run's artifacts");
  return JSON.parse((m[1] as string).replaceAll('\\"', '"')) as Record<string, string>;
}

/** Every surface of TDD §3.16.2 property 6, as text, after the runs have ended. */
async function captureSurfaces(runIds: readonly string[]): Promise<Record<string, string>> {
  await w.lifecycle?.shutdown();
  w.lifecycle = undefined;
  await w.sinks.drain();
  await w.telemetry.close();
  return {
    event: runIds.flatMap((id) => w.ledger.listRunEvents(id).map((e) => `${e.type} ${e.payload_json}`)).join("\n"),
    run: runIds.map((id) => JSON.stringify(w.ledger.getRunRecord(id))).join("\n"),
    run_skill: runIds.map((id) => JSON.stringify(skillRows(id))).join("\n"),
    span: w.collector.bodies.join("\n"),
    log: w.logLines.join(""),
    artifact: await runArtifactsText(w.ledger, w.artifacts, runIds),
    sink: w.sinkBodies.join("\n"),
    operator_repository: tg(w.fx.repo, "log", "--all", "-p", "--format=%H %B"),
    remote: tg(w.fx.remote, "log", "--all", "-p", "--format=%H %B"),
  };
}

describe("malicious fixture: Switchboard-controlled skills (T16.11)", () => {
  beforeEach(async () => {
    await setUp();
  });

  it(
    "untrusted runs load no repository skill and receive only approved store versions",
    async () => {
      // Requested, a repository-imported version or a draft is refused under every untrusted profile; nothing is written.
      let lc = await lifecycle({ scenario: "success" });
      const runsBefore = (w.db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n;
      for (const profile of UNTRUSTED) {
        for (const [ref, code, reason] of [
          ["hostile-helper", "PERMISSION_BLOCKED", "SKILL_REPOSITORY_ORIGIN"],
          ["gamma-review@2", "PERMISSION_BLOCKED", "SKILL_NOT_APPROVED"],
          // A name with no approved version has no usable version at all (LLD §19.5).
          ["delta-draft", "INVALID_REQUEST", "SKILL_UNKNOWN"],
        ] as const) {
          const refused = await run(lc, "do it", { profile, skills: [ref] }).then(
            () => undefined,
            (e: unknown) => e,
          );
          expect(refused, `${profile} ${ref}`).toBeInstanceOf(SkillAdmissionError);
          expect((refused as SkillAdmissionError).code).toBe(code);
          expect((refused as SkillAdmissionError).details).toEqual({ reason, skill: ref });
        }
      }
      expect((w.db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n).toBe(runsBefore);

      // Configured as defaults: the repository-imported one and the draft-only one are skipped with an event, the
      // draft version 2 is passed over for the approved version 1, and the run gets exactly the approved versions.
      const defaults = ["alpha-docs", "hostile-helper", "gamma-review", "delta-draft", "beta-review"];
      const approved = ["alpha-docs", "gamma-review", "beta-review"];
      for (const profile of UNTRUSTED) {
        lc = await lifecycle({ scenario: "success" });
        const { runId, done } = await run(lc, "do it", { profile, defaults });
        expect(done.state, `${profile}: ${done.failure_detail ?? ""}`).toBe("SUCCEEDED");
        expect(skillRows(runId).map((r) => [r.name, r.version, r.sha256, r.source])).toEqual(
          approved.map((n) => [n, w.versions[n]?.version, w.versions[n]?.sha256, "global_default"]),
        );
        expect(w.versions["gamma-review"]?.version).toBe(1);
        expect(ofType(runId, "skill_resolved")[0]?.p.skipped).toEqual([
          { name: "hostile-helper", reason: "SKILL_REPOSITORY_ORIGIN" },
          { name: "delta-draft", reason: "SKILL_UNKNOWN" },
        ]);
        const stdin = stdinOf(runId);
        if (profile === "inspect-untrusted") {
          // No worktree for a read-only run, so no native file (LLD §19.6 step 1): the approved bodies, and only
          // those, travel in the prompt prefix, and the agent finds no skill file.
          expect(ofType(runId, "skill_delivered")[0]?.p.entries).toEqual(
            approved.map((n) => ({ name: n, version: w.versions[n]?.version, delivery: "prompt_prefix" })),
          );
          expect(stdin.startsWith("[operator skills: 3;")).toBe(true);
          for (const n of approved) expect(stdin).toContain(w.bodies[n] as string);
          expect(await agentReport(runId)).toEqual({});
        } else {
          // Delivered natively, byte for byte the approved store bodies (the controller's record and the agent's view).
          expect(ofType(runId, "skill_delivered")[0]?.p.entries).toEqual(
            approved.map((n) => ({
              name: n,
              version: w.versions[n]?.version,
              delivery: "native",
              native_path: `.fake/skills/switchboard-${n}.md`,
            })),
          );
          const expected = Object.fromEntries(
            approved.map((n) => [`switchboard-${n}.md`, sha256(w.bodies[n] as string)]),
          );
          expect(await agentReport(runId)).toEqual(expected);
          expect(skillRows(runId).map((r) => r.written_sha256)).toEqual(
            approved.map((n) => expected[`switchboard-${n}.md`]),
          );
          expect(stdin).not.toContain(w.canary); // native delivery: no prefix block either
          // The repository's own skill is left alone in the worktree, and the delivered files are gone.
          const wt = worktreeOf(runId);
          expect(readFileSync(path.join(wt, ".claude", "skills", "hostile-helper", "SKILL.md"), "utf8")).toContain(
            w.hostile.repoCanary,
          );
          expect(existsSync(path.join(wt, ALPHA))).toBe(false);
        }
        // Nothing of the repository's own skills, rules or instructions, and no draft text, reaches the prompt.
        expect(stdin).not.toContain(w.hostile.repoCanary);
        expect(stdin).not.toContain("gamma-review, draft");
        expect(stdin).not.toContain("delta-draft");
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "a pre-existing switchboard- path falls back to the prompt prefix and is left untouched",
    async () => {
      const lc = await lifecycle({ cell: CURSOR_CELL, scenario: "success" });
      const before = treeHash(w.fx.repo, true);
      const { runId, done } = await run(lc, "do it", { skills: ["alpha-docs"] });
      expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
      expect(ofType(runId, "skill_delivered")[0]?.p.entries).toEqual([
        {
          name: "alpha-docs",
          version: w.versions["alpha-docs"]?.version,
          delivery: "prompt_prefix",
          fallback_reason: "path_taken",
        },
      ]);
      expect(skillRows(runId).map((r) => [r.delivery, r.native_path])).toEqual([["prompt_prefix", null]]);
      // The approved body is in the prefix; the repository's file is not, and it is unchanged and not removed.
      const stdin = stdinOf(runId);
      expect(stdin.startsWith("[operator skills: 1;")).toBe(true);
      expect(stdin).toContain(w.bodies["alpha-docs"] as string);
      expect(stdin).not.toContain(w.hostile.repoCanary);
      const file = path.join(worktreeOf(runId), w.hostile.preExistingPath);
      expect(readFileSync(file, "utf8")).toBe(`Not Switchboard's file. ${w.hostile.repoCanary}\n`);
      expect(ofType(runId, "skill_removed")).toEqual([]);
      expect(treeHash(w.fx.repo, true)).toBe(before);
    },
    TEST_TIMEOUT,
  );

  it(
    "the canary appears in no event, span, log, artifact or sink capture",
    async () => {
      // Native run: the agent edits, stages and commits around its skill files (T16.6 hostile moves, no copy).
      let lc = await lifecycle();
      const native = await run(
        lc,
        plan([
          { op: "append", path: ALPHA, content: "agent edit\n" },
          { op: "add", path: ALPHA },
          { op: "add", path: BETA },
          { op: "write", path: "feature.txt", content: "feature\n" },
          { op: "tool_commit", arguments: { message: "Add the feature" } },
          { op: "commit", message: "plain commit with everything" },
        ]),
        { skills: ["alpha-docs", "beta-review"] },
      );
      expect(native.done.state, native.done.failure_detail ?? "").toBe("SUCCEEDED");
      expect(skillRows(native.runId).map((r) => [r.delivery, r.removal])).toEqual([
        ["native", "verified"],
        ["native", "verified"],
      ]);
      expect(ofType(native.runId, "skill_tampered")).toHaveLength(1);
      // Prefix run (a pre-existing path): the body travels only on the provider's stdin.
      lc = await lifecycle({ cell: CURSOR_CELL, scenario: "success" });
      const prefix = await run(lc, "do it", { skills: ["alpha-docs"] });
      expect(prefix.done.state).toBe("SUCCEEDED");
      expect(stdinOf(prefix.runId)).toContain(w.canary); // the canary did reach the provider, so its absence below means something

      await w.collector.waitForSpans((s) => s.length >= 4, 10_000);
      const capture = await captureSurfaces([native.runId, prefix.runId]);
      // Each surface really captured something for these runs.
      expect(capture.event).toContain("skill_delivered");
      expect(capture.span).toContain(native.runId);
      expect(capture.log).toContain("notification sink delivery failed");
      expect(capture.artifact).toMatch(/\S/u);
      expect(capture.sink).toContain(native.runId);
      expect(capture.event).toContain("sink_delivery_failed");
      expect(surfacesContaining(capture, w.canary)).toEqual([]);
      // Neither are the store bodies' other lines, nor the repository skill's canary.
      expect(surfacesContaining(capture, "Operator playbook for")).toEqual([]);
      expect(surfacesContaining(capture, w.hostile.repoCanary)).toEqual(["operator_repository", "remote"]);
    },
    TEST_TIMEOUT,
  );

  it(
    "R-69: an agent copies its skill file elsewhere and commits: the copy is not detected; the recorded path is still excluded",
    async () => {
      const lc = await lifecycle({ mode: "copy" });
      const { runId, metaSessionId, done } = await run(
        lc,
        plan([
          { op: "add", path: ALPHA },
          { op: "tool_commit", arguments: { message: "Add notes" } },
        ]),
        { skills: ["alpha-docs", "beta-review"] },
      );
      expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
      const copies = ["notes/copy-of-switchboard-alpha-docs.md", "notes/copy-of-switchboard-beta-review.md"];

      // The copy is not detected: it reaches the commit with the approved body, and nothing flags the run.
      const pub = publishRefFor(metaSessionId);
      expect(tg(w.fx.repo, "rev-list", "--count", `main..${pub}`)).toBe("1");
      const tree = treeOf(pub);
      expect(tree).toEqual(expect.arrayContaining(copies));
      expect(tg(w.fx.repo, "show", `${pub}:${copies[0]}`)).toBe((w.bodies["alpha-docs"] as string).trimEnd());
      expect(tg(w.fx.repo, "show", `${pub}:${copies[1]}`)).toContain(w.canary);
      for (const type of ["skill_tampered", "skill_cleanup_failed"]) expect(ofType(runId, type)).toEqual([]);
      expect(needsAttentionOf(w.ledger, done, { now: new Date() })).toEqual({ active: false });

      // The recorded paths are still excluded: from the commit, the checkpoint, every artifact's path list, and the disk.
      for (const p of [ALPHA, BETA]) expect(tree).not.toContain(p);
      const post = treeOf(w.ledger.getRunCheckpointCommit(runId, "post") as string);
      expect(post).toEqual(expect.arrayContaining(copies));
      for (const p of [ALPHA, BETA]) expect(post).not.toContain(p);
      const changed = w.ledger.listArtifactsForRun(runId).find((a) => a.kind === "changed_files");
      const listed = JSON.parse((await w.artifacts.get(changed?.sha256 as string)).toString("utf8")) as {
        path: string;
      }[];
      expect(listed.map((e) => e.path)).toEqual(expect.arrayContaining(copies));
      for (const p of [ALPHA, BETA]) expect(listed.map((e) => e.path)).not.toContain(p);
      const artifactText = await runArtifactsText(w.ledger, w.artifacts, [runId]);
      expect(artifactText).not.toContain("+++ b/.fake/skills/");
      expect(skillRows(runId).map((r) => r.removal)).toEqual(["verified", "verified"]);
      for (const p of [ALPHA, BETA]) expect(existsSync(path.join(worktreeOf(runId), p))).toBe(false);
      // As R-69 states, the copied text is ordinary content now: the diff artifact carries it.
      expect(artifactText).toContain(w.canary);
    },
    TEST_TIMEOUT,
  );
});

describe("malicious fixture: symlinked .claude leaving the worktree (T16.11)", () => {
  beforeEach(async () => {
    await setUp({ claudeLink: true });
  });

  it(
    "the symlinked path falls back to the prompt prefix and nothing is written outside the worktree",
    async () => {
      const target = w.hostile.claudeLinkTarget as string;
      const outsideBefore = treeHash(w.fx.outsideDir);
      const homeBefore = treeHash(w.fx.fakeHome);
      const lc = await lifecycle({ cell: CLAUDE_CELL, scenario: "success" });
      const { runId, done } = await run(lc, "do it", { skills: ["alpha-docs", "beta-review"] });
      expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
      expect(realpathSync(path.join(worktreeOf(runId), ".claude"))).toBe(realpathSync(target));
      expect(ofType(runId, "skill_delivered")[0]?.p.entries).toEqual(
        ["alpha-docs", "beta-review"].map((name) => ({
          name,
          version: w.versions[name]?.version,
          delivery: "prompt_prefix",
          fallback_reason: "path_taken",
        })),
      );
      expect(skillRows(runId).map((r) => r.native_path)).toEqual([null, null]);
      const stdin = stdinOf(runId);
      expect(stdin.startsWith("[operator skills: 2;")).toBe(true);
      expect(stdin).toContain(w.canary);
      expect(stdin).not.toContain(w.hostile.repoCanary);
      // Nothing outside the worktree changed: the link target, the rest of the outside directory and the fake home.
      expect(treeHash(w.fx.outsideDir)).toBe(outsideBefore);
      expect(treeHash(w.fx.fakeHome)).toBe(homeBefore);
      expect(treeText(target)).not.toContain(w.canary);
    },
    TEST_TIMEOUT,
  );
});

describe("positive controls (each detector fires)", () => {
  beforeEach(async () => {
    await setUp({ claudeLink: true });
  });

  it(
    "a delivery port that leaks the body into a run event is caught by the surface scan",
    async () => {
      const lc = await lifecycle({ scenario: "success", leakyPort: true });
      const { runId, done } = await run(lc, "do it", { skills: ["alpha-docs"] });
      expect(done.state).toBe("SUCCEEDED");
      const capture = await captureSurfaces([runId]);
      expect(surfacesContaining(capture, w.canary)).toEqual(["event"]);
      // Planted directly, each other surface is reported by name too.
      expect(
        surfacesContaining({ span: `x${w.canary}`, log: w.canary, artifact: w.canary, sink: w.canary }, w.canary),
      ).toEqual(["span", "log", "artifact", "sink"]);
    },
    TEST_TIMEOUT,
  );

  it(
    "a trusted run does receive the repository-imported skill, so the untrusted assertion can fail",
    async () => {
      const lc = await lifecycle({ scenario: "success" });
      const { runId, done } = await run(lc, "do it", { profile: "trusted-development", skills: ["hostile-helper"] });
      expect(done.state).toBe("SUCCEEDED");
      expect(skillRows(runId).map((r) => [r.name, r.source])).toEqual([["hostile-helper", "request"]]);
      expect(await agentReport(runId)).toEqual({
        "switchboard-hostile-helper.md": sha256(w.bodies["hostile-helper"] as string),
      });
    },
    TEST_TIMEOUT,
  );

  it("a write through the .claude link changes the outside tree hash", () => {
    const before = treeHash(w.fx.outsideDir);
    const linked = path.join(w.fx.repo, ".claude", "skills", "switchboard-alpha-docs");
    mkdirSync(linked);
    writeFileSync(path.join(linked, "SKILL.md"), w.canary);
    expect(treeHash(w.fx.outsideDir)).not.toBe(before);
    expect(treeText(w.hostile.claudeLinkTarget as string)).toContain(w.canary);
  });
});
