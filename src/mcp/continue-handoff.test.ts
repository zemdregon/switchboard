/**
 * T5.6: `continue_task` under FRD BR-18 (LLD §15.7; ADR-0038 items 6.4, 7 and 8; FRD WF-2, WF-3, C2 to C7), through
 * the MCP server on the two continuity fakes (T5.2) with the real lifecycle, workspace manager, artifact store and
 * Git in a temporary repository. Each BR-18 branch has a case: native resume, a handoff to a named provider, a handoff
 * for a session with no binding, a handoff when the session provider is ineligible, and `require_provider` naming an
 * ineligible provider. The fail-closed refusals: the bundle failure code, a target outside the project and a
 * `privileged` continuation on another provider while ROADMAP Q-61 is open. The fakes are synthetic test adapters
 * (`fake`, `fake-b`); no real provider CLI, login or network is used. The end-to-end case here checks the transcript
 * canaries against the prompt and the bundle; the last `describe` is the M5 acceptance test (T5.9) with the
 * file-access proof: the controller's own file opens are recorded and none lies under a provider state directory.
 */
import { execFileSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FIRST_FAKE_STATE_DIR,
  firstFake,
  SECOND_FAKE_CONFIG_ID,
  SECOND_FAKE_ID,
  SECOND_FAKE_STATE_DIR,
  type StatefulFake,
  secondFake,
  secondFakeProvider,
} from "../adapters/fixtures/continuity-fakes.js";
import {
  AdapterRegistry,
  type AuthResult,
  auditInvocation,
  type Ineligible,
  type Invocation,
  type ProviderAdapter,
  type ProviderId,
  type ResolvedProfile,
  type VersionGateResult,
} from "../adapters/index.js";
import { registerProvider } from "../adapters/providers.js";
import { ArtifactStore } from "../artifacts/index.js";
import type { ResolvedProject } from "../config/index.js";
import { INSTRUCTION_MARKER, PRIVILEGED_CROSS_PROVIDER } from "../continuity/index.js";
import { GitPublisher } from "../git/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { createSwitchboardServer, type SwitchboardMcpServer } from "./index.js";

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
const CANARY = "switchboard-canary"; // the line the fake CLI writes into its transcript (cli.mjs)
const B = SECOND_FAKE_ID;

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: name === "inspect-untrusted" ? "none" : "allowlist",
  ...(name === "inspect-untrusted" ? {} : { shellAllowlist: [] }),
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

/** A valid structured privileged scope (LLD §3.1). */
const SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "allowlist", allowlist: [["npm", "test"]] },
  network: { mode: "allowlist", hosts: ["registry.npmjs.org"] },
  repository_config: { mode: "disabled" },
  bypass: true,
};

/** A continuity fake behind a wrapper that counts probes, records resumes and can be made logged out. */
interface Watched {
  readonly adapter: ProviderAdapter;
  readonly fake: StatefulFake;
  probes: number;
  readonly resumes: string[];
  auth: AuthResult;
  /** Drop the CLI's `session_bound` event: a run that reports no native session (so the session gets no binding). */
  dropSession: boolean;
}

let compiled: Invocation[];

function watched(fake: StatefulFake): Watched {
  const w = {
    fake,
    probes: 0,
    resumes: [] as string[],
    auth: { state: "OK" } as AuthResult,
    dropSession: false,
  } as Watched;
  // Test double for T3.5/T3.6 (as in mcp.test.ts): the fake compiles `privileged` as `edit-untrusted`, never a bypass.
  const map = (p: ResolvedProfile) => (p.name === "privileged" ? profileFor("edit-untrusted") : p);
  const keep = (inv: Invocation | Ineligible) => {
    if (!("ineligible" in inv)) compiled.push(inv);
    return inv;
  };
  (w as { adapter: ProviderAdapter }).adapter = {
    id: fake.id,
    transports: fake.transports,
    gitWriteControl: fake.gitWriteControl,
    resumeCwd: fake.resumeCwd,
    gitCapabilities: fake.gitCapabilities,
    probe: (r) => {
      w.probes += 1;
      return fake.probe(r);
    },
    authPreflight: (r) => (w.auth.state === "OK" ? fake.authPreflight(r) : Promise.resolve(w.auth)),
    compile: (req, p) => keep(fake.compile(req, map(p))),
    resumeArgs: (b, req, p) => {
      w.resumes.push(b.nativeSessionId);
      return keep(fake.resumeArgs(b, req, map(p)));
    },
    parseEvent: (i, s) => fake.parseEvent(i, s).filter((e) => !(w.dropSession && e.kind === "session_bound")),
    extractResult: (e, x) => fake.extractResult(e, x),
    classifyFailure: (e) => fake.classifyFailure(e),
  };
  return w;
}

/** Both fakes have no manifest: a test-only version gate passes them (as mcp.test.ts does for `fake`). */
const gate = (id: ProviderId, version: string | null): VersionGateResult => ({
  eligible: true,
  evidence: { provider: id, observedVersion: version, validatedRange: "test", validatedCliVersion: "test" },
});

let root: string;
let home: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let artifacts: ArtifactStore;
let lifecycle: RunLifecycle;
let unregister: (() => void) | undefined;
let a: Watched;
let b: Watched;
const servers: { mcp: SwitchboardMcpServer; client: Client }[] = [];

interface Setup {
  projects?: ResolvedProject[];
  clients?: { id: string; max: TrustProfile; approval?: "required" | "not_required"; projects?: string[] }[];
  start?: boolean;
  finalizeCommit?: boolean;
}

async function setup(s: Setup = {}): Promise<void> {
  a = watched(firstFake({ home, scenario: "edit_files", timeouts: PATIENT }));
  b = watched(secondFake({ home, scenario: "edit_files", timeouts: PATIENT }));
  const registry = new AdapterRegistry();
  registry.register(a.adapter);
  registry.register(b.adapter);
  const ids = createIdGenerator();
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots: [root],
    globalConcurrency: 2,
    resolveProfile: profileFor,
    eligibility: { platform: "linux", gate },
    ...(s.finalizeCommit
      ? {
          finalizePublisher: new GitPublisher({
            db,
            scratchDir: path.join(dataDir, "git-scratch"),
            allowedStates: ["FINALIZING"],
          }),
        }
      : {}),
  });
  if (s.start !== false) lifecycle.start();
  const clients = s.clients ?? [{ id: "orchestrator", max: "edit-untrusted" }];
  const config = {
    allowedRoots: [root],
    projects: s.projects ?? [],
    mcpClients: new Map(
      clients.map((c) => [
        c.id,
        {
          id: c.id,
          maxTrustProfile: c.max,
          ...(c.approval ? { privilegedApproval: c.approval } : {}),
          ...(c.projects ? { projects: c.projects } : {}),
        },
      ]),
    ),
  };
  for (const c of clients) {
    const mcp = createSwitchboardServer({ lifecycle, ledger, artifacts, registry, config, clientId: c.id });
    const client = new Client({ name: `test-${c.id}`, version: "0.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.server.connect(serverSide);
    await client.connect(clientSide);
    await client.listTools(); // every result below is checked against the published output schemas
    servers.push({ mcp, client });
  }
}

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON checked by the published output schemas
type Json = Record<string, any>;

async function call(name: string, args: Json = {}): Promise<{ isError: boolean; body: Json }> {
  const client = servers[0]?.client;
  if (!client) throw new Error("no client");
  const res = await client.callTool({ name, arguments: args });
  const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}") as Json;
  if (res.structuredContent !== undefined) expect(res.structuredContent).toEqual(body);
  return { isError: res.isError === true, body };
}

async function pollTerminal(runId: string): Promise<Json> {
  const end = Date.now() + 60_000;
  for (;;) {
    const r = await call("get_run", { run_id: runId });
    expect(r.isError).toBe(false);
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(r.body.status)) return r.body;
    if (Date.now() > end) throw new Error(`run ${runId} did not finish: ${r.body.status}`);
    await new Promise((res) => setTimeout(res, 20));
  }
}

const plan = (files: Record<string, string>, summary: string) => JSON.stringify({ files, summary });
const delegate = (over: Json = {}): Json => ({
  objective: plan({ "src/a.ts": "export const a = 1;\n" }, "a wrote src/a.ts"),
  workspace_path: repo,
  trust_profile: "edit-untrusted",
  routing: { provider_preference: "fake" },
  ...over,
});

/** Run A on the first fake and wait for it. */
async function runA(over: Json = {}): Promise<{ runId: string; sess: string }> {
  const d = await call("delegate_task", delegate(over));
  expect(d.isError, JSON.stringify(d.body)).toBe(false);
  const done = await pollTerminal(d.body.run_id);
  expect(done.status, JSON.stringify(done)).toBe("SUCCEEDED");
  return { runId: d.body.run_id, sess: d.body.meta_session_id };
}

/** Row counts that a refused call must leave unchanged ("nothing written"). */
const rows = () =>
  Object.fromEntries(
    ["run", "run_event", "artifact", "decision", "route_decision", "provider_binding", "approval"].map((t) => [
      t,
      (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
    ]),
  );
const routeOf = (runId: string) => JSON.parse(ledger.getRouteDecision(runId)?.reasons_json ?? "{}") as Json;
const decisionsOf = (runId: string, kind: string) =>
  (
    db.prepare("SELECT reason_summary FROM decision WHERE run_id = ? AND decision = ?").all(runId, kind) as {
      reason_summary: string;
    }[]
  ).map((r) => r.reason_summary);
const prompts = (stateDir: string): string[] => {
  const file = path.join(home, stateDir, "prompts.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => (JSON.parse(l) as { prompt: string }).prompt);
};
const viewText = (runId: string): string => {
  const view = ledger.listArtifactsForRun(runId).find((x) => x.kind === "handoff_view");
  if (!view) throw new Error(`no handoff_view for ${runId}`);
  return readFileSync(artifacts.pathFor(view.sha256), "utf8");
};

function project(over: Partial<ResolvedProject> = {}, finalizeCommit = false): ResolvedProject {
  return {
    id: "web-app",
    name: "Web application",
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
        finalizeCommit,
        ...(finalizeCommit ? { identity: { name: "Ada Maintainer", email: "ada@example.test" } } : {}),
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-cont-")));
  home = path.join(root, "home");
  repo = path.join(root, "repo");
  dataDir = path.join(root, "data");
  for (const d of [home, repo, dataDir]) mkdirSync(d);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  compiled = [];
  // The second fake's one registry entry (T5.2), so a project can allow it by its config id.
  unregister = registerProvider(secondFakeProvider(home));
});

afterEach(async () => {
  await lifecycle?.shutdown();
  for (const s of servers.splice(0)) {
    await s.client.close();
    await s.mcp.close();
  }
  unregister?.();
  db.close();
  // AGENTS.md / FR-POL-03: no compiled argv carried a bypass flag.
  for (const inv of compiled) expect(auditInvocation(inv)).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

describe("continue_task under BR-18 on the two fakes (T5.6)", () => {
  it("no provider named and the session provider eligible: native resume, unchanged", async () => {
    await setup();
    const { sess } = await runA();
    const c = await call("continue_task", {
      meta_session_id: sess,
      instruction: plan({ "src/a.ts": "export const a = 3;\n" }, "a resumed"),
    });
    expect(c.isError, JSON.stringify(c.body)).toBe(false);
    const done = await pollTerminal(c.body.run_id);
    expect(done).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake" } });
    expect(done.route.reasons[0]).toBe("selected fake (resume same_provider_resume from fake; continuation)");
    expect(a.resumes).toEqual(["fake-session-1"]);
    expect(routeOf(c.body.run_id).continuation).toEqual({
      mode: "resume",
      reason: "same_provider_resume",
      from_provider: "fake",
    });
    expect(decisionsOf(c.body.run_id, "route_selected")).toEqual([
      "provider=fake mode=resume reasons=same_provider_resume",
    ]);
    expect(ledger.listArtifactsForRun(c.body.run_id).some((x) => x.kind === "handoff_view")).toBe(false);
    expect(done.artifacts.handoff_view).toBeUndefined();
  });

  it("another provider named: a handoff to it from the head checkpoint, a second binding, A still resumable; commits carry their provider (end to end)", async () => {
    await setup({
      projects: [project({}, true)],
      clients: [{ id: "o", max: "edit-untrusted", projects: ["web-app"] }],
      finalizeCommit: true,
    });
    // Provider A edits; the controller commits at FINALIZING (finalize-only opt-in, the fakes have no tool channel).
    const d = await call("delegate_task", {
      objective: plan({ "src/a.ts": "export const a = 1;\n" }, "a wrote src/a.ts"),
      project: "web-app",
      trust_profile: "edit-untrusted",
      routing: { provider_preference: "fake" },
    });
    expect(d.isError, JSON.stringify(d.body)).toBe(false);
    expect((await pollTerminal(d.body.run_id)).status).toBe("SUCCEEDED");
    const sess = d.body.meta_session_id as string;
    const bindingA = ledger.latestProviderBinding(sess, "fake");
    expect(bindingA?.native_session_id).toBe("fake-session-1");
    const headBefore = ledger.getMetaSessionContinuity(sess)?.head_commit as string;
    const canaryA = path.join(home, FIRST_FAKE_STATE_DIR, "sessions", "fake-session-1.jsonl");
    const canaryABefore = readFileSync(canaryA, "utf8");
    expect(canaryABefore).toContain(CANARY);

    // Provider B continues from the bundle: a fresh native session, the instruction last in its prompt.
    const instruction = plan({ "src/a.ts": "export const a = 2;\n", "src/b.ts": "export const b = 2;\n" }, "b done");
    const c = await call("continue_task", {
      meta_session_id: sess,
      instruction,
      routing: { provider_preference: B },
    });
    expect(c.isError, JSON.stringify(c.body)).toBe(false);
    const done = await pollTerminal(c.body.run_id);
    expect(done, JSON.stringify(done)).toMatchObject({ status: "SUCCEEDED", provider: { adapter: B } });
    expect(done.route.reasons[0]).toBe(`selected ${B} (handoff provider_named from fake; provider_preference)`);
    expect(routeOf(c.body.run_id).continuation).toEqual({
      mode: "handoff",
      reason: "provider_named",
      from_provider: "fake",
    });
    expect(decisionsOf(c.body.run_id, "route_selected")).toEqual([`provider=${B} mode=handoff reasons=provider_named`]);
    expect(decisionsOf(c.body.run_id, "handoff_built")).toHaveLength(1);
    expect(done.artifacts.handoff_view).toBe(
      ledger.listArtifactsForRun(c.body.run_id).find((x) => x.kind === "handoff_view")?.id,
    );
    expect(a.resumes).toEqual([]);
    expect(b.resumes).toEqual([]); // a fresh native session, never a resume of A's

    // The new run started from the meta-session's head checkpoint, in its own worktree.
    const runB = ledger.getRunRecord(c.body.run_id);
    expect(runB?.worktree_path).not.toBe(ledger.getRunRecord(d.body.run_id)?.worktree_path);
    g(repo, "merge-base", "--is-ancestor", headBefore, runB?.branch as string); // throws if not
    const diff = await call("get_artifacts", { run_id: c.body.run_id, kinds: ["diff"] });
    expect(diff.body.artifacts[0].inline_text).toContain("-export const a = 1;");
    expect(diff.body.artifacts[0].inline_text).toContain("+export const a = 2;");

    // A second binding; A's binding is untouched (WF-3 postcondition).
    const bindings = ledger.listProviderBindings(sess);
    expect(bindings.map((x) => [x.provider, x.native_session_id]).sort()).toEqual([
      ["fake", "fake-session-1"],
      [B, "fake-b-session-1"],
    ]);
    expect(ledger.latestProviderBinding(sess, "fake")).toEqual(bindingA);
    expect(readFileSync(canaryA, "utf8")).toBe(canaryABefore);

    // FR-GIT-07: each commit's provenance names the provider of the run that made it.
    const commits = db
      .prepare(
        "SELECT run_id, provider, harness, origin FROM git_commit WHERE meta_session_id = ? ORDER BY created_at, id",
      )
      .all(sess);
    expect(commits).toEqual([
      { run_id: d.body.run_id, provider: "fake", harness: "fake", origin: "finalize_only" },
      { run_id: c.body.run_id, provider: B, harness: B, origin: "finalize_only" },
    ]);

    // The bundle and B's prompt hold the instruction and the labels, but neither transcript canary nor its path.
    const promptB = prompts(SECOND_FAKE_STATE_DIR);
    expect(promptB).toHaveLength(1);
    expect(promptB[0]?.endsWith(`${INSTRUCTION_MARKER}\n${instruction}`)).toBe(true);
    const canaryB = path.join(home, SECOND_FAKE_STATE_DIR, "sessions", "fake-b-session-1.jsonl");
    expect(readFileSync(canaryB, "utf8")).toContain(CANARY);
    const bundle = viewText(c.body.run_id);
    for (const text of [promptB[0] ?? "", bundle]) {
      expect(text).toContain("a wrote src/a.ts");
      for (const leak of [CANARY, canaryA, canaryB, home, FIRST_FAKE_STATE_DIR, SECOND_FAKE_STATE_DIR]) {
        expect(text).not.toContain(leak);
      }
    }
    expect(JSON.stringify(done)).not.toContain("a wrote src/a.ts"); // no bundle text in the envelope (FR-MCP-04)

    // A's native session is still resumable: a resume of it on A runs in A's origin worktree and continues it.
    const snap = JSON.parse(runB?.policy_snapshot_json ?? "{}").project;
    const r = await lifecycle.submit({
      clientId: "o",
      objective: plan({ "src/c.ts": "export const c = 3;\n" }, "a resumed"),
      metaSessionId: sess,
      trustProfile: "edit-untrusted",
      provider: "fake",
      resume: { nativeSessionId: "fake-session-1" },
      project: snap,
    });
    expect((await lifecycle.waitForTerminal(r.runId)).state).toBe("SUCCEEDED");
    expect(a.resumes).toEqual(["fake-session-1"]);
    expect(readFileSync(canaryA, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  }, 120_000);

  /** Run A on the first fake, which reports no native session: the meta-session gets no binding. */
  const unboundA = async () => {
    a.dropSession = true;
    const r = await runA();
    a.dropSession = false;
    expect(ledger.latestProviderBinding(r.sess)).toBeUndefined();
    return r;
  };

  it("a meta-session with no binding and no provider named: a handoff preferring its provider", async () => {
    await setup();
    const { sess } = await unboundA();
    const probesB = b.probes;
    const c = await call("continue_task", { meta_session_id: sess, instruction: plan({ "x.txt": "x\n" }, "x") });
    expect(c.isError, JSON.stringify(c.body)).toBe(false);
    const done = await pollTerminal(c.body.run_id);
    expect(done).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake" } });
    expect(done.route.reasons[0]).toBe("selected fake (handoff no_binding from fake; continuation)");
    expect(routeOf(c.body.run_id).continuation).toEqual({
      mode: "handoff",
      reason: "no_binding",
      from_provider: "fake",
    });
    expect(done.artifacts.handoff_view).toEqual(expect.any(String));
    expect(a.resumes).toEqual([]);
    expect(b.probes).toBe(probesB);
    expect(ledger.latestProviderBinding(sess)?.native_session_id).toBe("fake-session-1"); // the fresh session's binding
  }, 60_000);

  it("a meta-session with no binding continued on another provider is a handoff", async () => {
    await setup();
    const { sess } = await unboundA();
    const c = await call("continue_task", {
      meta_session_id: sess,
      instruction: plan({ "b.txt": "b\n" }, "b"),
      routing: { provider_preference: B },
    });
    expect(c.isError, JSON.stringify(c.body)).toBe(false);
    const done = await pollTerminal(c.body.run_id);
    expect(done).toMatchObject({ status: "SUCCEEDED", provider: { adapter: B } });
    expect(routeOf(c.body.run_id).continuation).toEqual({
      mode: "handoff",
      reason: "provider_named",
      from_provider: "fake",
    });
    expect(ledger.listProviderBindings(sess).map((x) => x.provider)).toEqual([B]);
  }, 60_000);

  it("the session provider ineligible: a handoff over the other providers; require_provider gets its BR-3 code", async () => {
    await setup();
    const { sess } = await runA();
    a.auth = { state: "AUTH_REQUIRED", loginCommand: "fake login" };
    const probesB = b.probes;

    // require_provider naming the ineligible session provider: its BR-3 code, nothing written.
    let before = rows();
    const req = await call("continue_task", {
      meta_session_id: sess,
      instruction: "x",
      routing: { provider_preference: "fake", require_provider: true },
    });
    expect(req.body.error).toMatchObject({ code: "AUTH_REQUIRED", retryable: false });
    expect(b.probes).toBe(probesB);
    expect(rows()).toEqual(before);

    // Without it: a handoff to the other provider, recorded with its reason.
    const c = await call("continue_task", { meta_session_id: sess, instruction: plan({ "b.txt": "b\n" }, "b") });
    expect(c.isError, JSON.stringify(c.body)).toBe(false);
    const done = await pollTerminal(c.body.run_id);
    expect(done).toMatchObject({ status: "SUCCEEDED", provider: { adapter: B } });
    expect(done.route.reasons[0]).toBe(`selected ${B} (handoff bound_provider_ineligible from fake; configured_order)`);
    expect(decisionsOf(c.body.run_id, "route_selected")).toEqual([
      `provider=${B} mode=handoff reasons=bound_provider_ineligible`,
    ]);
    expect(a.resumes).toEqual([]);

    // The session provider is now B. `require_provider` naming another provider that is ineligible: its BR-3 code
    // from the named-provider branch, nothing written, and no resume of B either.
    expect(ledger.latestProviderBinding(sess)?.provider).toBe(B);
    before = rows();
    const reqOther = await call("continue_task", {
      meta_session_id: sess,
      instruction: "x",
      routing: { provider_preference: "fake", require_provider: true },
    });
    expect(reqOther.body.error).toMatchObject({ code: "AUTH_REQUIRED" });
    expect(reqOther.body.error.message).toContain("fake login");
    expect(rows()).toEqual(before);
    expect(b.resumes).toEqual([]);
  }, 90_000);

  it("a bundle that cannot be built: TOOL_FAILURE HANDOFF_BUNDLE_UNAVAILABLE and nothing written", async () => {
    await setup();
    const { sess } = await runA();
    // A head that does not resolve in the repository (a missing record): the build fails closed (ADR-0038 item 7).
    db.prepare("UPDATE meta_session SET head_commit = ? WHERE id = ?").run("0".repeat(40), sess);
    const before = rows();
    const r = await call("continue_task", {
      meta_session_id: sess,
      instruction: "x",
      routing: { provider_preference: B },
    });
    expect(r.body.error).toEqual({
      code: "TOOL_FAILURE",
      message: "the handoff bundle could not be built from the controller's records",
      retryable: false,
      details: { reason: "HANDOFF_BUNDLE_UNAVAILABLE" },
    });
    expect(rows()).toEqual(before);
    expect(prompts(SECOND_FAKE_STATE_DIR)).toEqual([]);
  });

  it("a project that does not allow the target: PERMISSION_BLOCKED before any side effect", async () => {
    await setup({
      // The second fake's config id is registered at runtime, outside the built-in union of config ids.
      projects: [
        project({
          allowedProviders: [SECOND_FAKE_CONFIG_ID] as unknown as NonNullable<ResolvedProject["allowedProviders"]>,
        }),
      ],
      clients: [{ id: "o", max: "edit-untrusted", projects: ["web-app"] }],
    });
    const d = await call("delegate_task", {
      objective: plan({ "b.txt": "b\n" }, "b"),
      project: "web-app",
      trust_profile: "edit-untrusted",
    });
    expect(d.isError, JSON.stringify(d.body)).toBe(false);
    expect((await pollTerminal(d.body.run_id)).provider.adapter).toBe(B);
    const before = rows();
    const probesA = a.probes;
    for (const routing of [{ provider_preference: "fake" }, { provider_preference: "fake", require_provider: true }]) {
      const r = await call("continue_task", { meta_session_id: d.body.meta_session_id, instruction: "x", routing });
      expect(r.body.error).toMatchObject({
        code: "PERMISSION_BLOCKED",
        details: { project: "web-app", allowed_providers: [SECOND_FAKE_CONFIG_ID] },
      });
    }
    expect(a.probes).toBe(probesA); // the target was never probed
    expect(rows()).toEqual(before);
    expect(prompts(FIRST_FAKE_STATE_DIR)).toEqual([]);
  });

  it("privileged: refused on another provider while Q-61 is open; same-provider continuations keep C7", async () => {
    expect(PRIVILEGED_CROSS_PROVIDER).toBe("refuse"); // the fail-closed default; Q-61 is not answered
    await setup({ clients: [{ id: "z", max: "privileged", approval: "not_required" }] });
    // A privileged run on the first fake under a client-policy approval; it reports no native session, so the
    // same-provider continuation at the end is a handoff on the same provider (the lifecycle guard's allowed case).
    a.dropSession = true;
    const { runId, sess } = await runA({ trust_profile: "privileged", privileged_scope: SCOPE });
    a.dropSession = false;
    expect(ledger.getApprovalForRun(runId)?.status).toBe("APPROVED");
    const before = rows();
    const probesB = b.probes;

    const expectRefused = (r: { body: Json }, to?: string) =>
      expect(r.body.error).toMatchObject({
        code: "INVALID_REQUEST",
        retryable: false,
        details: { reason: "PRIVILEGED_CROSS_PROVIDER", from_provider: "fake", ...(to ? { to_provider: to } : {}) },
      });
    // Another provider named (also with require_provider).
    expectRefused(
      await call("continue_task", { meta_session_id: sess, instruction: "x", routing: { provider_preference: B } }),
      B,
    );
    expectRefused(
      await call("continue_task", {
        meta_session_id: sess,
        instruction: "x",
        routing: { provider_preference: B, require_provider: true },
      }),
      B,
    );
    // The session provider ineligible: BR-18 would hand off to another provider, which Q-61 refuses.
    a.auth = { state: "AUTH_REQUIRED", loginCommand: "fake login" };
    const ineligible = await call("continue_task", { meta_session_id: sess, instruction: "x" });
    expectRefused(ineligible);
    expect(ineligible.body.error.details.to_provider).toBeUndefined();
    expect(b.probes).toBe(probesB); // refused before the other provider was probed
    expect(rows()).toEqual(before);

    // Same provider: admitted under the approval as is, with no new approval row (C7 unchanged).
    a.auth = { state: "OK" };
    const same = await call("continue_task", { meta_session_id: sess, instruction: plan({ "p.txt": "p\n" }, "p") });
    expect(same.isError, JSON.stringify(same.body)).toBe(false);
    expect(same.body).toMatchObject({ approval: { status: "APPROVED" } });
    expect(await pollTerminal(same.body.run_id)).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake" } });
    expect(routeOf(same.body.run_id).continuation).toMatchObject({ mode: "handoff", reason: "no_binding" });
    expect(ledger.listApprovals()).toHaveLength(1);
  }, 60_000);
});

/**
 * M5 acceptance (T5.9; FR-SES-02, 03, 04, 05, FR-EXE-08, ADR-0001, TDD §3.6): provider A edits and runs a verification
 * command; `continue_task` naming provider B continues from the bundle and completes the task. While it runs, the
 * controller process records every path it opens through the `node:fs` and `node:fs/promises` open, read, stream and
 * directory functions, and the test asserts that none lies under either fake's provider state directory and that
 * both canary transcripts are unchanged by the controller.
 *
 * Limit (stated with the evidence): the wrappers see this process only. The fake CLIs are child processes and write
 * their own transcripts, which is the point of the canaries; a native binding (the ledger's SQLite driver) and a
 * child process such as `git` open files the wrappers cannot see. FR-SES-04 constrains the controller.
 */
describe("M5 acceptance on two fake adapters (T5.9)", () => {
  /** The `node:fs` entry points that take a path and open, read, stream or list it (or write it, which opens it). */
  const WATCHED = [
    "openSync",
    "open",
    "readFileSync",
    "readFile",
    "createReadStream",
    "createWriteStream",
    "opendirSync",
    "opendir",
    "readdirSync",
    "readdir",
    "copyFileSync",
    "copyFile",
    "writeFileSync",
    "writeFile",
    "appendFileSync",
    "appendFile",
    "cpSync",
    "cp",
  ] as const;
  const WATCHED_PROMISES = [
    "open",
    "readFile",
    "readdir",
    "opendir",
    "copyFile",
    "writeFile",
    "appendFile",
    "cp",
  ] as const;

  let opened: string[] = [];
  let recording = false;
  let restores: (() => void)[] = [];

  const note = (arg: unknown): void => {
    if (!recording) return;
    if (typeof arg === "string") opened.push(path.resolve(arg));
    else if (Buffer.isBuffer(arg)) opened.push(path.resolve(arg.toString("utf8")));
    else if (arg instanceof URL && arg.protocol === "file:") opened.push(path.resolve(arg.pathname));
  };
  const wrap = (obj: Record<string, unknown>, name: string): void => {
    const orig = obj[name];
    if (typeof orig !== "function") return;
    obj[name] = function (this: unknown, ...args: unknown[]) {
      note(args[0]);
      return Reflect.apply(orig, this, args);
    };
    restores.push(() => {
      obj[name] = orig;
    });
  };
  const startRecording = (): void => {
    for (const n of WATCHED) wrap(fs as unknown as Record<string, unknown>, n);
    for (const n of WATCHED_PROMISES) wrap(fs.promises as unknown as Record<string, unknown>, n);
    syncBuiltinESMExports(); // code that imports `{ readFileSync } from "node:fs"` sees the wrappers too
    opened = [];
    recording = true;
  };
  const stopRecording = (): string[] => {
    recording = false;
    for (const r of restores.reverse()) r();
    restores = [];
    syncBuiltinESMExports();
    return opened;
  };
  const under = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);
  /** Opened paths under either fake's provider state directory (the transcripts, the prompt logs, the state root). */
  const stateOpens = (paths: readonly string[]) =>
    paths.filter((p) => [FIRST_FAKE_STATE_DIR, SECOND_FAKE_STATE_DIR].some((d) => under(p, path.join(home, d))));

  afterEach(() => {
    if (restores.length > 0) stopRecording();
  });

  it("A edits and verifies, B continues from the bundle and completes; the controller opens no provider state", async () => {
    await setup({
      projects: [project({}, true)],
      clients: [{ id: "o", max: "edit-untrusted", projects: ["web-app"] }],
      finalizeCommit: true,
    });
    startRecording();

    // Provider A edits, and the controller runs the verification command in A's worktree (FR-EXE-08).
    const d = await call("delegate_task", {
      objective: plan({ "src/a.ts": "export const a = 1;\n" }, "a wrote src/a.ts"),
      project: "web-app",
      trust_profile: "edit-untrusted",
      routing: { provider_preference: "fake" },
      verification_commands: [[process.execPath, "-e", "console.log('tests pass')"]],
    });
    expect(d.isError, JSON.stringify(d.body)).toBe(false);
    const doneA = await pollTerminal(d.body.run_id);
    expect(doneA.status, JSON.stringify(doneA)).toBe("SUCCEEDED");
    expect(doneA.result.verification).toEqual([expect.objectContaining({ index: 0, outcome: "passed", exit_code: 0 })]);
    const sess = d.body.meta_session_id as string;

    // A's canary exists (written by the fake CLI, a child process); take its hash outside the recording window.
    const canaryA = path.join(home, FIRST_FAKE_STATE_DIR, "sessions", "fake-session-1.jsonl");
    recording = false;
    const canaryABefore = readFileSync(canaryA, "utf8");
    recording = true;
    expect(canaryABefore).toContain(CANARY);

    // `continue_task` naming provider B: a handoff from the bundle, a fresh native session on B.
    const instruction = plan({ "src/b.ts": "export const b = 2;\n" }, "b done");
    const c = await call("continue_task", {
      meta_session_id: sess,
      instruction,
      routing: { provider_preference: B },
    });
    expect(c.isError, JSON.stringify(c.body)).toBe(false);
    const doneB = await pollTerminal(c.body.run_id);
    expect(doneB, JSON.stringify(doneB)).toMatchObject({ status: "SUCCEEDED", provider: { adapter: B } });
    expect(routeOf(c.body.run_id).continuation).toMatchObject({ mode: "handoff", reason: "provider_named" });

    // FR-SES-05: `get_artifacts` returns the handoff view of B's run, which carries A's verification outcome.
    const view = await call("get_artifacts", { run_id: c.body.run_id, kinds: ["handoff_view"] });
    expect(view.isError, JSON.stringify(view.body)).toBe(false);
    expect(view.body.artifacts).toHaveLength(1);
    expect(view.body.artifacts[0].kind).toBe("handoff_view");

    const seen = stopRecording();
    // The controller really did open files while recording (so an empty `stateOpens` is not an empty recorder) ...
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((p) => under(p, root))).toBe(true);
    // ... and none of them lies under a provider state directory.
    expect(stateOpens(seen)).toEqual([]);

    // Both canary transcripts are as the fake CLIs left them: A's is unchanged by B's run, B's holds only its own.
    const canaryB = path.join(home, SECOND_FAKE_STATE_DIR, "sessions", "fake-b-session-1.jsonl");
    expect(readFileSync(canaryA, "utf8")).toBe(canaryABefore);
    expect(readFileSync(canaryB, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
    // The transcripts reached the new prompt only as the bundle's rendering: no canary line, no state path.
    const bundle = viewText(c.body.run_id);
    expect(bundle).toContain("a wrote src/a.ts");
    for (const leak of [CANARY, canaryA, canaryB, FIRST_FAKE_STATE_DIR, SECOND_FAKE_STATE_DIR]) {
      expect(bundle).not.toContain(leak);
      for (const p of prompts(SECOND_FAKE_STATE_DIR)) expect(p).not.toContain(leak);
    }
  }, 120_000);

  it("positive control: a controller read of a canary is recorded and fails the assertion", async () => {
    const canary = path.join(home, FIRST_FAKE_STATE_DIR, "sessions", "fake-session-1.jsonl");
    mkdirSync(path.dirname(canary), { recursive: true });
    writeFileSync(canary, `${CANARY}\n`);
    startRecording();
    readFileSync(canary, "utf8"); // a named import, as the source modules use
    fs.readFileSync(canary, "utf8");
    await fs.promises.readFile(canary, "utf8");
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(canary);
      stream.on("error", reject).on("close", () => resolve());
      stream.resume();
    });
    const seen = stopRecording();
    const hits = stateOpens(seen);
    expect(new Set(hits)).toEqual(new Set([canary]));
    expect(hits.length).toBeGreaterThanOrEqual(4); // one per call; a stream may also open through `fs.open`
    // The wrappers are removed: a later read is not recorded.
    recording = true;
    readFileSync(canary, "utf8");
    recording = false;
    expect(stateOpens(opened)).toHaveLength(hits.length);
  });
});
