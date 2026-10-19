/**
 * `steer_run` on the MCP server (T14.7; FR-CTL-04, FR-SES-03, FRD BR-7, LLD §3.4.4; M14 acceptance plan scenario E).
 * Through the SDK client, so every result is checked against the published output schema. The ROADMAP done-when:
 * listed with a closed schema; on a fake adapter a steered run continues the same native session with the note (no
 * replay) at the turn boundary; another client's run is refused; the note is a controller event in the ledger. The
 * fake is the bundled fake CLI keeping its session state and received prompts under a temporary HOME
 * (`../adapters/fixtures/continuity-fakes.ts`). Fake CLIs only; nothing live.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeScenario } from "../adapters/fake/adapter.js";
import { firstFake, type StatefulFake } from "../adapters/fixtures/continuity-fakes.js";
import {
  AdapterRegistry,
  type CompileRequest,
  type Invocation,
  type NativeBinding,
  type ResolvedProfile,
} from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunEventRow, type TrustProfile } from "../ledger/index.js";
import { RunLifecycle, type TransitionNotice } from "../lifecycle/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { inputSchema, outputSchema, TOOL_NAMES, WORK_QUEUE_TOOL_NAMES } from "./schemas.js";
import { createSwitchboardServer } from "./server.js";

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON checked by the published output schemas
type Json = Record<string, any>;

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

const OBJECTIVE = "Fix the parser crash";
const NOTE = "Also keep the public API unchanged.";

/** What the lifecycle asked the adapter to compile, per turn: a fresh compile or a resume of a binding. */
interface Compiled {
  kind: "compile" | "resume";
  binding?: NativeBinding;
  objective: string;
  argv: readonly string[];
  stdin: Invocation["stdin"];
}

interface Setup {
  root: string;
  repo: string;
  ledger: Ledger;
  lifecycle: RunLifecycle;
  fake: StatefulFake;
  compiled: Compiled[];
  /** Called on every lifecycle transition (set by a test). */
  onTransition: { fn?: (n: TransitionNotice) => void };
  call(name: string, args: Json, clientId?: string): Promise<{ isError: boolean; body: Json }>;
  ok(name: string, args: Json, clientId?: string): Promise<Json>;
  client(clientId?: string): Client;
  close(): Promise<void>;
}

let s: Setup | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

/** A ledger, workspace and lifecycle over one stateful fake (`fake`), and MCP clients `orch` and `other`. */
async function setup(scenario: FakeScenario = "success", start = true): Promise<Setup> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-steer-")));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const home = path.join(root, "home");
  mkdirSync(home);
  const db = openLedger(dataDir);
  const ledger = createLedger(db, { ids: createIdGenerator() });
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const allowedRoots = [root];
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots, ids: createIdGenerator() });
  const fake = firstFake({ home, scenario, timeouts: { wallClockMs: 60_000, idleMs: 30_000, killGraceMs: 300 } });
  const compiled: Compiled[] = [];
  const record = (
    kind: Compiled["kind"],
    req: CompileRequest,
    inv: Invocation | { ineligible: true },
    b?: NativeBinding,
  ) => {
    if (!("ineligible" in inv) && req.runId !== "route-check") {
      compiled.push({ kind, ...(b ? { binding: b } : {}), objective: req.objective, argv: inv.argv, stdin: inv.stdin });
    }
    return inv;
  };
  const adapter = Object.assign(Object.create(Object.getPrototypeOf(fake)) as StatefulFake, fake, {
    compile: (req: CompileRequest, p: ResolvedProfile) => record("compile", req, fake.compile(req, p)),
    resumeArgs: (b: NativeBinding, req: CompileRequest, p: ResolvedProfile) =>
      record("resume", req, fake.resumeArgs(b, req, p), b),
    parseEvent: fake.parseEvent.bind(fake),
  });
  const registry = new AdapterRegistry().register(adapter);
  const onTransition: Setup["onTransition"] = {};
  const lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots,
    globalConcurrency: 2,
    perProviderConcurrency: 1,
    resolveProfile: profileFor,
    onTransition: (n) => onTransition.fn?.(n),
    eligibility: {
      platform: "linux",
      gate: (id, version) => ({
        eligible: true,
        evidence: { provider: id, observedVersion: version, validatedRange: "test", validatedCliVersion: "test" },
      }),
    },
  });
  if (start) lifecycle.start();
  const mcpClients = new Map([
    ["orch", { id: "orch", maxTrustProfile: "edit-untrusted" as TrustProfile }],
    ["other", { id: "other", maxTrustProfile: "edit-untrusted" as TrustProfile }],
  ]);
  const clients = new Map<string, Client>();
  for (const clientId of mcpClients.keys()) {
    const mcp = createSwitchboardServer({
      lifecycle,
      ledger,
      artifacts,
      registry,
      config: {
        allowedRoots,
        mcpClients,
        capacity: { windowSeconds: 3600, confidenceRuns: 10 },
        limits: { perProviderConcurrency: 1 },
      },
      clientId,
    });
    const client = new Client({ name: clientId, version: "0.0.0" });
    const [c, t] = InMemoryTransport.createLinkedPair();
    await mcp.server.connect(t);
    await client.connect(c);
    await client.listTools(); // caches output schemas: every result is checked against them
    clients.set(clientId, client);
  }
  const clientOf = (id = "orch"): Client => {
    const c = clients.get(id);
    if (c === undefined) throw new Error(`no client ${id}`);
    return c;
  };
  const call = async (name: string, args: Json, clientId?: string) => {
    const res = await clientOf(clientId).callTool({ name, arguments: args });
    const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}") as Json;
    return { isError: res.isError === true, body };
  };
  const ok = async (name: string, args: Json, clientId?: string) => {
    const r = await call(name, args, clientId);
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    return r.body;
  };
  return {
    root,
    repo,
    ledger,
    lifecycle,
    fake,
    compiled,
    onTransition,
    call,
    ok,
    client: clientOf,
    close: async () => {
      for (const c of clients.values()) await c.close();
      await lifecycle.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const delegate = (h: Setup, clientId = "orch") =>
  h.ok("delegate_task", { objective: OBJECTIVE, workspace_path: h.repo, trust_profile: "edit-untrusted" }, clientId);
const eventsOf = (h: Setup, runId: string, type?: string): RunEventRow[] =>
  h.ledger.listRunEvents(runId).filter((e) => type === undefined || e.type === type);
const payloadOf = (e: RunEventRow): Json => JSON.parse(e.payload_json ?? "{}") as Json;
/** The prompt log the fake CLI keeps: one `{session_id, prompt}` line per process it ran (what it received on stdin). */
const promptLog = (h: Setup): { session_id: string; prompt: string }[] => {
  const log = h.fake.reports.at(-1)?.prompt_log;
  if (log === undefined) return [];
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { session_id: string; prompt: string });
};

describe("steer_run (T14.7, FR-CTL-04)", () => {
  it("is listed last with closed schemas; the earlier tools are listed unchanged", async () => {
    s = await setup();
    const { tools } = await s.client().listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES, ...WORK_QUEUE_TOOL_NAMES]);
    expect(TOOL_NAMES.at(-1)).toBe("steer_run");
    const tool = tools.find((t) => t.name === "steer_run");
    expect(tool?.inputSchema).toEqual(inputSchema("steer_run"));
    expect(tool?.outputSchema).toEqual(outputSchema("steer_run"));
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["run_id", "note"],
      properties: { note: { type: "string", minLength: 1, maxLength: 4096 } },
    });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["run_id", "note"]);
    // The output is the get_run envelope.
    expect(outputSchema("steer_run")).toEqual(outputSchema("get_run"));
  });

  it("refuses a missing, empty, oversized or extra argument as INVALID_REQUEST", async () => {
    s = await setup("success", false);
    const r = await delegate(s);
    for (const args of [
      { run_id: r.run_id },
      { run_id: r.run_id, note: "" },
      { run_id: r.run_id, note: "x".repeat(4097) },
      { run_id: r.run_id, note: NOTE, extra: true },
    ]) {
      const res = await s.call("steer_run", args);
      expect(res.isError).toBe(true);
      expect(res.body.error.code).toBe("INVALID_REQUEST");
    }
    expect(eventsOf(s, r.run_id, "steer_requested")).toEqual([]);
  });

  it("continues the same native session with only the note at the turn boundary (steered while queued)", async () => {
    s = await setup("success", false);
    const r = await delegate(s);
    expect(r.status).toBe("QUEUED");
    const steered = await s.ok("steer_run", { run_id: r.run_id, note: NOTE });
    expect(steered.run_id).toBe(r.run_id);
    expect(JSON.stringify(steered)).not.toContain(NOTE);
    s.lifecycle.start();
    const run = await s.lifecycle.waitForTerminal(r.run_id);
    expect(run.state).toBe("SUCCEEDED");

    // Turn 1 compiled the objective; turn 2 resumed the session turn 1 reported, with the note only.
    expect(s.compiled.map((c) => c.kind)).toEqual(["compile", "resume"]);
    const [first, second] = s.compiled as [Compiled, Compiled];
    expect(first.objective).toBe(OBJECTIVE);
    expect(second.binding).toEqual({ provider: "fake", nativeSessionId: "fake-session-1" });
    expect(second.objective).toBe(NOTE);
    expect(second.argv).toContain("--resume");
    expect(second.argv[second.argv.indexOf("--resume") + 1]).toBe("fake-session-1");
    expect(second.stdin).toEqual({ kind: "text", value: NOTE });

    // What the fake CLI received: the same native session both times, the objective once (no replay), then the note.
    expect(promptLog(s)).toEqual([
      { session_id: "fake-session-1", prompt: OBJECTIVE },
      { session_id: "fake-session-1", prompt: NOTE },
    ]);

    // The note is a controller event (length and hash only); delivery is recorded; the text is in no event.
    const requested = eventsOf(s, r.run_id, "steer_requested");
    expect(requested.map(payloadOf)).toEqual([
      {
        note_chars: NOTE.length,
        note_sha256: createHash("sha256").update(NOTE).digest("hex"),
        delivery: "boundary_resume",
      },
    ]);
    expect(eventsOf(s, r.run_id, "steer_delivered").map(payloadOf)).toEqual([
      { delivery: "boundary_resume", notes: 1 },
    ]);
    expect(eventsOf(s, r.run_id, "steer_undelivered")).toEqual([]);
    for (const e of eventsOf(s, r.run_id)) expect(e.payload_json ?? "").not.toContain(NOTE);

    // Same run and meta-session: no successor run, no new meta-session; one binding for the one native session.
    expect(s.ledger.listRunsForMetaSession(run.meta_session_id).map((x) => x.id)).toEqual([r.run_id]);
    const got = await s.ok("get_run", { run_id: r.run_id, include_events: { limit: 200 } });
    expect(got.status).toBe("SUCCEEDED");
    expect(JSON.stringify(got)).not.toContain(NOTE);
  });

  it("delivers a note sent while the provider is running at the end of that turn", async () => {
    s = await setup();
    const h = s;
    let steered: string | undefined;
    h.onTransition.fn = (n) => {
      if (n.to === "RUNNING" && steered === undefined) {
        steered = n.runId;
        expect(h.lifecycle.steer(n.runId, NOTE)).toEqual({ accepted: true });
      }
    };
    const r = await delegate(h);
    const run = await h.lifecycle.waitForTerminal(r.run_id);
    expect(steered).toBe(r.run_id);
    expect(run.state).toBe("SUCCEEDED");
    expect(promptLog(h)).toEqual([
      { session_id: "fake-session-1", prompt: OBJECTIVE },
      { session_id: "fake-session-1", prompt: NOTE },
    ]);
    expect(eventsOf(h, r.run_id, "steer_delivered")).toHaveLength(1);
    // The resumed turn's pid is recorded on the run, as the first turn's was.
    expect(eventsOf(h, r.run_id, "steer_turn_spawned")).toHaveLength(1);
    // Both turns' provider streams are kept as artifacts of the run.
    const kinds = h.ledger.listArtifactsForRun(r.run_id).map((a) => a.kind);
    expect(kinds.filter((k) => k === "provider_stdout")).toHaveLength(2);
  });

  it("refuses another client's run as unknown (as get_run) and records nothing", async () => {
    s = await setup("success", false);
    const r = await delegate(s, "orch");
    const res = await s.call("steer_run", { run_id: r.run_id, note: NOTE }, "other");
    expect(res.isError).toBe(true);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
    expect((await s.call("get_run", { run_id: r.run_id }, "other")).body.error.code).toBe("INVALID_REQUEST");
    expect(eventsOf(s, r.run_id, "steer_requested")).toEqual([]);
    const unknown = await s.call("steer_run", { run_id: "01JUNKNOWNRUN0000000000000", note: NOTE });
    expect(unknown.body.error.code).toBe("INVALID_REQUEST");
  });

  it("is a no-op on a terminal run, returning its envelope", async () => {
    s = await setup();
    const r = await delegate(s);
    await s.lifecycle.waitForTerminal(r.run_id);
    const before = eventsOf(s, r.run_id).length;
    const res = await s.ok("steer_run", { run_id: r.run_id, note: NOTE });
    expect(res.status).toBe("SUCCEEDED");
    expect(eventsOf(s, r.run_id)).toHaveLength(before);
    expect(s.compiled.map((c) => c.kind)).toEqual(["compile"]);
  });

  it("does not resume after a failed turn; the note is recorded undelivered", async () => {
    s = await setup("task_failure", false);
    const r = await delegate(s);
    await s.ok("steer_run", { run_id: r.run_id, note: NOTE });
    s.lifecycle.start();
    const run = await s.lifecycle.waitForTerminal(r.run_id);
    expect(run.state).toBe("FAILED");
    expect(s.compiled.map((c) => c.kind)).toEqual(["compile"]);
    expect(eventsOf(s, r.run_id, "steer_undelivered").map(payloadOf)).toEqual([
      { reason: "turn_not_successful", notes: 1 },
    ]);
  });

  it("records a note queued on a run cancelled before dispatch as undelivered", async () => {
    s = await setup("success", false);
    const r = await delegate(s);
    await s.ok("steer_run", { run_id: r.run_id, note: NOTE });
    await s.ok("cancel_run", { run_id: r.run_id });
    expect(eventsOf(s, r.run_id, "steer_undelivered").map(payloadOf)).toEqual([{ reason: "run_ended", notes: 1 }]);
    expect(s.compiled).toEqual([]);
  });
});
