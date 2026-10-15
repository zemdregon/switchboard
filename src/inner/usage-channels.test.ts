/**
 * T11.5 (FR-INN-15, BR-41, ADR-0007) at the two production callers `serve` wires (T11.14): the git `commit` tool channel
 * over its Unix socket (T11.4, `src/git/channel.ts`) and the MCP admission harness whose `delegate_task`,
 * `continue_task` and quota failover (T6.6) run the routing hook (T11.11, `src/lifecycle/lifecycle.ts`). `usage.test.ts` and
 * `usage-surfaces.test.ts` call the injected contracts directly; this file drives the callers themselves, so the claim
 * "one labelled observation per backend request with a shared subscription, none without, and never any provider usage
 * or capacity" is made where a run actually makes the calls. Scripted in-process fake backend and the scripted fake
 * provider CLI only: no network, no model, no provider CLI, no login.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { main } from "../cli/index.js";
import type { CliIo } from "../cli/io.js";
import { resolveInnerAgent } from "../config/inner-agent.js";
import { GitToolService, type OpenChannel } from "../git/channel.js";
import { GitPublisher, publishRefFor } from "../git/index.js";
import { TOOL_TOKEN_ENV } from "../git/tool-protocol.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import type { RunLifecycleOptions } from "../lifecycle/lifecycle.js";
import { buildEnvelope } from "../mcp/envelope.js";
import { type Harness, startHarness } from "../routing/fixtures/harness.js";
import { WorkspaceManager } from "../workspace/index.js";
import {
  createClassifyRouteFeaturesHook,
  createFakeBackend,
  createInnerAgent,
  type FakeBackend,
  type FakeStep,
  type InnerAgentService,
  PROMPT_PROVIDER_NAMES,
} from "./index.js";

/** macOS temp paths (`/private/var/folders/...`) are too long for the 100-byte socket bound (T4.10); `/tmp` is not. */
const SHORT_TMP = process.platform === "darwin" ? "/tmp" : tmpdir();
const NOW = new Date("2026-10-15T12:00:00.000Z");
const now = () => NOW;
/** The run's provider (the fake adapter's id); the shared subscription names a configured provider id instead. */
const PROVIDER = "fake";
const SHARED = "claude-code";
const SINCE = "1970-01-01T00:00:00.000Z";

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
const refSha = (cwd: string, ref: string): string => {
  try {
    return g(cwd, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return "";
  }
};

const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };
const SHIM = [process.execPath, "/nonexistent/bin.js", "tool-shim"];
const draft = (subject: string, usage?: { in: number | null; out: number | null }): FakeStep => ({
  kind: "text",
  text: JSON.stringify({ subject }),
  ...(usage !== undefined ? { usage } : {}),
});

describe("the commit tool channel (T11.4 production path) records inner usage as T11.5 says (FR-INN-15)", () => {
  let root: string;
  let repo: string;
  let dataDir: string;
  let configPath: string;
  let db: Database.Database;
  let ledger: Ledger;
  let mgr: WorkspaceManager;
  let services: GitToolService[];

  beforeEach(() => {
    services = [];
    root = realpathSync(mkdtempSync(path.join(SHORT_TMP, "sb-ucmsg-")));
    repo = path.join(root, "repo");
    mkdirSync(repo);
    g(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "Initial import");
    dataDir = path.join(root, "d");
    configPath = path.join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        data_dir: dataDir,
        allowed_roots: [root],
        mcp_clients: [{ id: "c1", max_trust_profile: "edit-untrusted" }],
        capacity: { window_seconds: 7200, confidence_runs: 4 },
      }),
    );
    db = openLedger(dataDir);
    const ids = createIdGenerator();
    ledger = createLedger(db, { ids, now });
    mgr = new WorkspaceManager({
      db,
      artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
      dataDir,
      allowedRoots: [root],
      ids,
    });
  });

  afterEach(async () => {
    for (const s of services) await s.closeAll();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function inner(
    shares: string | null,
    script: readonly FakeStep[],
    o: { locality?: "local" | "remote" } = {},
  ): { svc: InnerAgentService; backend: FakeBackend } {
    const settings = resolveInnerAgent({
      enabled: true,
      backend: {
        kind: "http",
        base_url: "http://127.0.0.1:9",
        model: "local-model",
        allow_remote: false,
        ...(shares !== null ? { shares_subscription_with: shares } : {}),
      },
      tasks: { commit_message: { enabled: true } },
    });
    const backend = createFakeBackend({ locality: o.locality ?? "local", script });
    const svc = createInnerAgent(settings, {
      backend,
      ledger,
      providerNames: [SHARED, "codex", PROVIDER, ...PROMPT_PROVIDER_NAMES],
    });
    return { svc, backend };
  }

  function service(svc: InnerAgentService, innerSettingFor?: () => "off" | "inherit"): GitToolService {
    const s = new GitToolService({
      db,
      dataDir,
      publisher: new GitPublisher({ db, scratchDir: path.join(root, "scratch") }),
      shimCommand: SHIM,
      fallbackDirs: [],
      innerAgent: svc,
      ...(innerSettingFor !== undefined ? { innerSettingFor } : {}),
    });
    services.push(s);
    return s;
  }

  /**
   * A RUNNING run of the fake provider holding the lease with a real worktree and one changed file, with one
   * provider-reported usage row of its own, beside a finished run of the same provider (so the capacity estimate has
   * evidence and the comparison is not between two empty answers).
   */
  async function running() {
    const ms = ledger.createMetaSession({ objective: "o" });
    const done = ledger.createRun({
      metaSessionId: ms.id,
      trustProfile: "inspect-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h",
      clientId: "c1",
      provider: PROVIDER,
    });
    db.prepare("UPDATE run SET state = ?, started_at = ?, finished_at = ? WHERE id = ?").run(
      "SUCCEEDED",
      "2026-10-15T11:20:00.000Z",
      "2026-10-15T11:30:00.000Z",
      done.id,
    );
    ledger.insertUsageObservation({
      runId: done.id,
      provider: PROVIDER,
      harness: PROVIDER,
      source: "provider_reported",
      metrics: { "usage.input_tokens": 100, "usage.output_tokens": 20 },
    });
    const session = ledger.createMetaSession({ objective: "o", repoRoot: repo, projectId: "web" });
    const run = ledger.createRun({
      metaSessionId: session.id,
      state: "RUNNING",
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: {},
      requestHash: "h",
      clientId: "c1",
      provider: PROVIDER,
      projectId: "web",
    });
    ledger.insertUsageObservation({
      runId: run.id,
      provider: PROVIDER,
      harness: PROVIDER,
      source: "provider_reported",
      metrics: { "usage.input_tokens": 7 },
    });
    const ws = await mgr.prepare({
      metaSessionId: session.id,
      runId: run.id,
      workspace: repo,
      trustProfile: "edit-untrusted",
    });
    if (ws.mode !== "worktree") throw new Error("expected a worktree");
    writeFileSync(path.join(ws.worktreePath, "parser.ts"), "export const parse = (s: string) => s.trim();\n");
    return { sessionId: session.id, runId: run.id, wt: ws.worktreePath };
  }
  type Run = Awaited<ReturnType<typeof running>>;

  function openFor(s: GitToolService, r: Run): Promise<OpenChannel> {
    return s.open({
      runId: r.runId,
      metaSessionId: r.sessionId,
      worktreePath: r.wt,
      identity: IDENTITY,
      projectId: "web",
      contextId: "main",
      nativeSessionIds: () => [],
    });
  }

  // biome-ignore lint/suspicious/noExplicitAny: wire answers are untyped JSON
  type Answer = Record<string, any>;
  /** One `commit` call over the channel's Unix socket, exactly as the tool shim sends it. */
  function commit(ch: OpenChannel, args: Record<string, unknown>): Promise<Answer> {
    const line = `${JSON.stringify({ v: 1, token: ch.shim.env[TOOL_TOKEN_ENV], tool: "commit", arguments: args })}\n`;
    return new Promise((resolve) => {
      const sock = net.createConnection({ path: ch.socketPath });
      let buf = "";
      sock.on("error", () => {});
      sock.on("data", (d) => {
        buf += d.toString("utf8");
      });
      sock.on("close", () => resolve(JSON.parse(buf.split("\n")[0] || '{"closed":true}') as Answer));
      sock.on("connect", () => sock.write(line));
    });
  }

  async function cli(args: string[]): Promise<string> {
    const out: string[] = [];
    const io: CliIo = {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: () => {} },
      env: {},
      adapters: new AdapterRegistry().register(new FakeAdapter({ script: "/nonexistent/fake-cli.mjs" })),
      now,
    };
    expect(await main([...args, "--config", configPath], io)).toBe(0);
    return out.join("");
  }

  const innerRows = () =>
    db
      .prepare(
        "SELECT run_id, provider, harness, backing_provider, model, metrics_json FROM usage_observation WHERE source = 'inner_agent' ORDER BY rowid",
      )
      .all();
  const providerRows = () => db.prepare("SELECT * FROM usage_observation WHERE source = 'provider_reported'").all();
  const envelope = (runId: string) => {
    const record = ledger.getRunRecord(runId);
    if (!record) throw new Error("run not found");
    return JSON.stringify(buildEnvelope(ledger, record, (s) => s));
  };
  /**
   * A `runs show --json` document as [everything but `events` and `run.commits`, re-serialised canonically; the event
   * types; the commit rows]: the channel's commit is itself listed by the run, so it is set aside and asserted on.
   */
  function splitEvents(json: string): [string, { type: string }[], Record<string, unknown>[]] {
    const { events, run, ...rest } = JSON.parse(json) as {
      events: { type: string }[];
      run: { commits: Record<string, unknown>[] } & Record<string, unknown>;
    } & Record<string, unknown>;
    const { commits, ...runRest } = run;
    return [JSON.stringify({ ...rest, run: runRest }), events, commits];
  }
  /** Every provider-facing surface the commit could move, before and after. */
  async function surfaces(runId: string) {
    return {
      capacity: await cli(["capacity", "--json"]),
      capacityProvider: await cli(["capacity", "--provider", PROVIDER, "--json"]),
      capacityText: await cli(["capacity"]),
      envelope: envelope(runId),
      providerRows: JSON.stringify(providerRows()),
      health: JSON.stringify(db.prepare("SELECT * FROM provider_health ORDER BY provider").all()),
      reportedSince: JSON.stringify(ledger.listProviderReportedUsageSince(PROVIDER, SINCE)),
    };
  }

  for (const shares of [null, SHARED]) {
    const label = shares === null ? "no shared subscription" : `shares_subscription_with = ${shares}`;

    it(`${label}: a drafted commit over the socket writes ${shares === null ? "no observation" : "one labelled observation under the run"} and moves no provider surface`, async () => {
      const r = await running();
      const { svc, backend } = inner(shares, [draft("Trim parser input", { in: 8, out: 3 })]);
      const ch = await openFor(service(svc), r);
      const before = await surfaces(r.runId);
      const [beforeRest, beforeEvents, beforeCommits] = splitEvents(await cli(["runs", "show", r.runId, "--json"]));
      expect(beforeCommits).toEqual([]);
      const parsed = JSON.parse(before.capacity) as { providers: { provider: string; window: unknown }[] };
      expect(parsed.providers.map((p) => p.provider)).toEqual([PROVIDER]);
      expect(parsed.providers[0]?.window).toMatchObject({ terminal_runs: 1, usage_observations: 2 });
      expect(JSON.parse(before.envelope).usage.reported).toHaveLength(1);

      expect(await commit(ch, {})).toMatchObject({ ok: true, result: { files_changed: 1 } });
      expect(g(repo, "log", "-1", "--format=%s", publishRefFor(r.sessionId))).toBe("Trim parser input");
      expect(backend.requests).toHaveLength(1);
      const calls = ledger.listInnerCalls({ runId: r.runId });
      expect(calls).toEqual([
        expect.objectContaining({
          task: "commit_message",
          outcome: "accepted",
          run_id: r.runId,
          attempts: 1,
          tokens_in: 8,
          tokens_out: 3,
        }),
      ]);
      expect(ledger.listGitCommits(r.runId)[0]).toMatchObject({ message_source: "inner", inner_call_id: calls[0]?.id });
      // The observation, when the flag is set: the call's run id, the shared provider as its label (not the run's
      // provider), the backend's model and exactly the counts the backend reported; nothing more.
      expect(innerRows()).toEqual(
        shares === null
          ? []
          : [
              {
                run_id: r.runId,
                provider: shares,
                harness: shares,
                backing_provider: null,
                model: "fake-model",
                metrics_json: JSON.stringify({ input_tokens: 8, output_tokens: 3 }),
              },
            ],
      );
      expect(ledger.listProviderReportedUsageSince(shares ?? SHARED, SINCE)).toHaveLength(0);
      expect(await surfaces(r.runId)).toEqual(before);
      // `runs show` gains the channel's own output only: its three events (the inner call, the commit intent and the
      // commit) and the commit row with its inner provenance, none with a token figure, around a byte-identical
      // document (its provider-reported usage view included).
      const [afterRest, afterEvents, afterCommits] = splitEvents(await cli(["runs", "show", r.runId, "--json"]));
      expect(afterRest).toBe(beforeRest);
      const gained = afterEvents.slice(beforeEvents.length);
      expect(gained.map((e) => e.type)).toEqual(["inner_call", "git_commit_intent", "git_commit"]);
      expect(afterCommits).toEqual([
        expect.objectContaining({ origin: "commit_tool", message_source: "inner", inner_call_id: calls[0]?.id }),
      ]);
      // The gained parts carry the call's provenance, never its counts (the `usage` view, unchanged above, is the
      // provider's own row).
      expect(JSON.stringify([gained, afterCommits])).not.toMatch(/token|usage/u);
    });

    it(`${label}: a failed request writes ${shares === null ? "nothing" : "one row with unknown counts"}; a denied one and the agent's own message write none`, async () => {
      // Three commit calls the channel decides on: (1) the backend errors after the request was sent (attempts 1, so
      // with the flag one observation with `{}`: the request may have consumed the subscription); (2) the project is
      // `off` at call time (no request, no observation, no inner_call row either: the channel skips the task); (3) the
      // agent gives its own message (no call at all).
      const r = await running();
      let setting: "off" | "inherit" = "inherit";
      const { svc, backend } = inner(shares, [{ kind: "error", message: "boom" }, draft("Never used")]);
      const ch = await openFor(
        service(svc, () => setting),
        r,
      );
      const before = await surfaces(r.runId);

      const failed = await commit(ch, {});
      expect(failed).toMatchObject({ ok: false, error: { code: "MESSAGE_REQUIRED" } });
      expect(refSha(repo, publishRefFor(r.sessionId))).toBe("");
      expect(backend.requests).toHaveLength(1);
      expect(ledger.listInnerCalls({ runId: r.runId }).map((c) => [c.outcome, c.reason, c.attempts])).toEqual([
        ["fallback_unavailable", "BACKEND_ERROR", 1],
      ]);
      expect(innerRows()).toEqual(
        shares === null
          ? []
          : [
              {
                run_id: r.runId,
                provider: shares,
                harness: shares,
                backing_provider: null,
                model: "local-model", // the configured model: the backend reported none before it failed
                metrics_json: "{}",
              },
            ],
      );
      // The database's error text and the backend's message stay out of the answer the agent reads.
      expect(JSON.stringify(failed)).not.toContain("boom");

      setting = "off";
      expect(await commit(ch, {})).toMatchObject({ ok: false, error: { code: "MESSAGE_REQUIRED" } });
      expect(backend.requests).toHaveLength(1);
      expect(ledger.listInnerCalls({ runId: r.runId }).map((c) => [c.outcome, c.reason, c.attempts])).toEqual([
        ["fallback_unavailable", "BACKEND_ERROR", 1],
        ["fallback_disabled", "PROJECT_OFF", 0],
      ]);
      expect(innerRows()).toHaveLength(shares === null ? 0 : 1);

      setting = "inherit";
      expect(await commit(ch, { message: "Agent wrote this" })).toMatchObject({ ok: true });
      expect(g(repo, "log", "-1", "--format=%s", publishRefFor(r.sessionId))).toBe("Agent wrote this");
      expect(backend.requests).toHaveLength(1);
      expect(ledger.listInnerCalls({ runId: r.runId })).toHaveLength(2);
      expect(innerRows()).toHaveLength(shares === null ? 0 : 1);
      expect(ledger.listGitCommits(r.runId)[0]).toMatchObject({ message_source: "agent", inner_call_id: null });
      expect(await surfaces(r.runId)).toEqual(before);
    });

    it(`${label}: a remote backend the privacy gate refuses made no request, so no observation even with the flag`, async () => {
      const r = await running();
      const { svc, backend } = inner(shares, [draft("Remote draft", { in: 50, out: 9 })], { locality: "remote" });
      const ch = await openFor(service(svc), r);
      const before = await surfaces(r.runId);
      expect(await commit(ch, {})).toMatchObject({ ok: false, error: { code: "MESSAGE_REQUIRED" } });
      expect(backend.requests).toHaveLength(0);
      expect(ledger.listInnerCalls({ runId: r.runId }).map((c) => [c.outcome, c.reason, c.attempts])).toEqual([
        ["fallback_disabled", "REMOTE_NOT_ALLOWED", 0],
      ]);
      expect(innerRows()).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM usage_observation").get()).toEqual({ n: 2 });
      expect(await surfaces(r.runId)).toEqual(before);
    });
  }
});

describe("the MCP admission harness (T11.11 production path) records inner usage as T11.5 says (FR-INN-15)", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  const reply = JSON.stringify({
    context_volume: "small",
    autonomy: "low",
    reasoning_depth: "low",
    task_kind: "docs",
  });
  type Capacity = { as_of: string; providers: { provider: string; window: { usage_observations: number } }[] };
  /** A `get_capacity` body without its clock (the harness runs on the real clock), per provider. */
  const entries = (body: Capacity) => Object.fromEntries(body.providers.map((p) => [p.provider, JSON.stringify(p)]));

  async function setup(shares: string | null): Promise<{ harness: Harness; backend: FakeBackend }> {
    const backend = createFakeBackend({
      script: [
        { kind: "text", text: reply, usage: { in: 4, out: 2 } },
        { kind: "text", text: reply, usage: { in: 6, out: 1 } },
      ],
    });
    let hook: ReturnType<typeof createClassifyRouteFeaturesHook> | undefined;
    h = await startHarness({
      lifecycle: {
        classifyRouteFeatures: (
          input: Parameters<NonNullable<RunLifecycleOptions["classifyRouteFeatures"]>>[0],
          context: Parameters<NonNullable<RunLifecycleOptions["classifyRouteFeatures"]>>[1],
        ) => {
          if (!hook) throw new Error("hook not initialized");
          return hook(input, context);
        },
      },
    });
    const service = createInnerAgent(
      resolveInnerAgent({
        enabled: true,
        backend: {
          kind: "http",
          base_url: "http://127.0.0.1:9",
          model: "configured-model",
          ...(shares !== null ? { shares_subscription_with: shares } : {}),
        },
        tasks: { route_features: { enabled: true, timeout_ms: 500 } },
      }),
      { backend, ledger: h.ledger },
    );
    hook = createClassifyRouteFeaturesHook(service, () => "inherit");
    return { harness: h, backend };
  }

  // `fake-b` is the provider every run here lands on; `grok` is registered, eligible and never chosen.
  for (const shares of [null, "fake-b", "grok"]) {
    const label = shares === null ? "no shared subscription" : `shares_subscription_with = ${shares}`;
    it(`${label}: admission and continuation classify through the backend, ${shares === null ? "no observation" : "two labelled rows"}, provider capacity unmoved`, async () => {
      const { harness: h, backend } = await setup(shares);
      const before = entries((await h.ok("get_capacity", {})) as Capacity);
      expect(Object.keys(before).sort()).toEqual(["fake", "fake-b", "grok"]);

      const first = await h.delegate("ok", { provider_preference: "fake-b", require_provider: true });
      expect(first.provider.adapter).toBe("fake-b");
      const continued = await h.ok("continue_task", { meta_session_id: first.meta_session_id, instruction: "ok" });
      const second = await h.settle(continued.run_id);
      expect(second.provider.adapter).toBe("fake-b");
      expect(backend.requests).toHaveLength(2);
      for (const row of h.decisions()) {
        expect(JSON.parse(row.features_json).route_features.task_kind).toMatchObject({
          value: "docs",
          source: "inner",
        });
      }
      // Admission classifies before a run exists; continuation classifies under the session before its run exists
      // (`src/mcp/inner-route-features.test.ts`), so both rows carry no run id, and so does each observation.
      expect(
        h.db
          .prepare(
            "SELECT task, run_id, outcome, attempts, tokens_in, tokens_out FROM inner_call ORDER BY created_at, id",
          )
          .all(),
      ).toEqual([
        { task: "route_features", run_id: null, outcome: "accepted", attempts: 1, tokens_in: 4, tokens_out: 2 },
        { task: "route_features", run_id: null, outcome: "accepted", attempts: 1, tokens_in: 6, tokens_out: 1 },
      ]);
      const inner = h.db
        .prepare(
          "SELECT run_id, provider, harness, model, metrics_json FROM usage_observation WHERE source = 'inner_agent' ORDER BY rowid",
        )
        .all();
      expect(inner).toEqual(
        shares === null
          ? []
          : [
              {
                run_id: null,
                provider: shares,
                harness: shares,
                model: "fake-model",
                metrics_json: JSON.stringify({ input_tokens: 4, output_tokens: 2 }),
              },
              {
                run_id: null,
                provider: shares,
                harness: shares,
                model: "fake-model",
                metrics_json: JSON.stringify({ input_tokens: 6, output_tokens: 1 }),
              },
            ],
      );

      // Neither run's envelope reports the inner rows as usage, and the scripted provider CLI reported none.
      for (const run of [first, second]) {
        expect(run.usage).toEqual({ reported: null, estimated: null, capacity_confidence: null });
        expect(h.ledger.listUsageObservationsForRun(run.run_id)).toEqual([]);
      }
      const providerReported = (p: string) =>
        (
          h.db
            .prepare("SELECT COUNT(*) AS n FROM usage_observation WHERE source = 'provider_reported' AND provider = ?")
            .get(p) as { n: number }
        ).n;
      const afterBody = (await h.ok("get_capacity", {})) as Capacity;
      const after = entries(afterBody);
      // The provider that ran: its window counts provider-reported rows only, whatever the shared label charged it.
      const ran = afterBody.providers.find((p) => p.provider === "fake-b");
      expect(ran?.window.usage_observations).toBe(providerReported("fake-b"));
      // The provider that never ran: byte-identical to before (its clock aside), even when two labelled rows with
      // counts now name it. `fake` never ran either.
      expect(after.grok).toBe(before.grok);
      expect(after.fake).toBe(before.fake);
      expect(JSON.stringify(afterBody)).not.toMatch(/inner/u);
      const filtered = (await h.ok("get_capacity", { provider: "grok" })) as Capacity;
      expect(entries(filtered)).toEqual({ grok: before.grok });
    }, 120_000);
  }

  // The third production call site of the routing hook (T11.14: admission, continuation and quota failover). The
  // quota ladder (T6.6, `src/lifecycle/lifecycle.ts` `failoverTarget`) classifies the failover route under the run
  // that failed, after it is terminal, so this is the one `serve`-path classification that carries a run id, and the
  // run it carries belongs to the provider whose quota was just exhausted. `fake` is the only provider the scripted CLI
  // stops on quota; the successor always lands on `fake-b` (first spare in configured order).
  for (const shares of [null, "fake", "fake-b", "grok"]) {
    const label = shares === null ? "no shared subscription" : `shares_subscription_with = ${shares}`;
    it(`${label}: the quota failover classifies under the failed run, ${shares === null ? "no observation" : "one labelled row under that run"}, the successor's choice and capacity unmoved`, async () => {
      const { harness: h, backend } = await setup(shares);
      const before = entries((await h.ok("get_capacity", {})) as Capacity);

      const failed = await h.delegate("quota");
      expect(failed).toMatchObject({ status: "FAILED", failure_code: "QUOTA_EXHAUSTED" });
      expect(failed.provider.adapter).toBe("fake");
      await h.waitFor(() => h.ledger.findSuccessorRun(failed.run_id) !== undefined);
      const successor = await h.settle(h.ledger.findSuccessorRun(failed.run_id)?.id as string);
      expect(successor.status).toBe("SUCCEEDED");
      // The labelled rows never reach the scorer (ADR-0007; `collectScoreInputs` reads provider-reported rows only), so
      // the failover lands on the same provider whether the label names it, the exhausted provider or a spare.
      expect(successor.provider.adapter).toBe("fake-b");
      expect(backend.requests).toHaveLength(2);
      expect(h.decisions()).toHaveLength(2);
      for (const row of h.decisions()) {
        expect(JSON.parse(row.features_json).route_features.task_kind).toMatchObject({
          value: "docs",
          source: "inner",
        });
      }

      // Admission classified before a run existed; the failover classified under the failed run and its session.
      expect(
        h.db
          .prepare(
            `SELECT task, run_id, meta_session_id, outcome, attempts, tokens_in, tokens_out
             FROM inner_call ORDER BY created_at, id`,
          )
          .all(),
      ).toEqual([
        {
          task: "route_features",
          run_id: null,
          meta_session_id: null,
          outcome: "accepted",
          attempts: 1,
          tokens_in: 4,
          tokens_out: 2,
        },
        {
          task: "route_features",
          run_id: failed.run_id,
          meta_session_id: failed.meta_session_id,
          outcome: "accepted",
          attempts: 1,
          tokens_in: 6,
          tokens_out: 1,
        },
      ]);
      const inner = h.db
        .prepare(
          "SELECT run_id, provider, harness, model, metrics_json FROM usage_observation WHERE source = 'inner_agent' ORDER BY rowid",
        )
        .all();
      expect(inner).toEqual(
        shares === null
          ? []
          : [
              {
                run_id: null,
                provider: shares,
                harness: shares,
                model: "fake-model",
                metrics_json: JSON.stringify({ input_tokens: 4, output_tokens: 2 }),
              },
              {
                // The failover's labelled row carries the failed run's id: usage of the shared subscription attributed
                // to the run whose quota exhaustion caused the classification, not to the successor.
                run_id: failed.run_id,
                provider: shares,
                harness: shares,
                model: "fake-model",
                metrics_json: JSON.stringify({ input_tokens: 6, output_tokens: 1 }),
              },
            ],
      );
      expect(
        h.db.prepare("SELECT COUNT(*) AS n FROM usage_observation WHERE source = 'provider_reported'").get(),
      ).toEqual({
        n: 0,
      });

      // Neither envelope reports the labelled row as usage. The ledger's own per-run list returns every source, so it
      // does show the labelled row under the failed run; the envelope is the reader that filters it out, which is the
      // point (`usage-surfaces.test.ts`, "each reader keeps to its own table").
      for (const run of [failed, successor]) {
        expect(run.usage).toEqual({ reported: null, estimated: null, capacity_confidence: null });
      }
      expect(h.ledger.listUsageObservationsForRun(failed.run_id).map((o) => o.source)).toEqual(
        shares === null ? [] : ["inner_agent"],
      );
      expect(h.ledger.listUsageObservationsForRun(successor.run_id)).toEqual([]);
      // The failed run's event list gains the one `inner_call` event of the failover classification, with no token
      // figure, beside its `quota_ladder` event; the successor's list has none (its route was decided on the failed run).
      const events = async (runId: string) =>
        (
          (await h.ok("get_run", { run_id: runId, include_events: {} })) as {
            events: { type: string; payload: unknown }[];
          }
        ).events;
      const failedEvents = await events(failed.run_id);
      const innerEvents = failedEvents.filter((e) => e.type === "inner_call");
      expect(innerEvents).toHaveLength(1);
      expect(innerEvents[0]?.payload).toMatchObject({ task: "route_features", outcome: "accepted", attempts: 1 });
      expect(JSON.stringify(innerEvents[0]?.payload)).not.toMatch(/token|tokens_in|tokens_out|input_tokens/u);
      expect(failedEvents.map((e) => e.type)).toContain("quota_ladder");
      expect((await events(successor.run_id)).filter((e) => e.type === "inner_call")).toEqual([]);

      // `get_capacity`: the exhausted provider and the successor count provider-reported rows only (none here), whatever
      // the label charged; the spare that never ran is byte-identical (its clock aside) even when it is the label.
      const afterBody = (await h.ok("get_capacity", {})) as Capacity;
      const after = entries(afterBody);
      for (const p of ["fake", "fake-b"]) {
        expect(afterBody.providers.find((x) => x.provider === p)?.window.usage_observations).toBe(0);
      }
      expect(after.grok).toBe(before.grok);
      expect(JSON.stringify(afterBody)).not.toMatch(/inner/u);
      const filtered = (await h.ok("get_capacity", { provider: "grok" })) as Capacity;
      expect(entries(filtered)).toEqual({ grok: before.grok });
    }, 120_000);
  }
});
