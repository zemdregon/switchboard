/**
 * T11.5 (FR-INN-15, BR-41, ADR-0007) at the two production callers `serve` wires (T11.14): the git `commit` tool channel
 * over its Unix socket (T11.4, `src/git/channel.ts`) and the MCP admission harness whose `delegate_task`,
 * `continue_task` and quota failover (T6.6) run the routing hook (T11.11, `src/lifecycle/lifecycle.ts`). `usage.test.ts` and
 * `usage-surfaces.test.ts` call the injected contracts directly; this file drives the callers themselves, so the claim
 * "one labelled observation per backend request with a shared subscription, none without, and never any provider usage
 * or capacity" is made where a run actually makes the calls. Scripted in-process fake backend and the scripted fake
 * provider CLI only: no network, no model, no provider CLI, no login.
 *
 * Post-#446 (Q-96 answered 2026-10-15, Delegated): `usage.test.ts` and `usage-surfaces.test.ts` pin that both `REPLACE`
 * spellings are refused with `append-only` on each row `recordInnerCall` writes, after a call on the injected contract
 * and the `inner test` CLI. The guard is on the table, not the path, so those pins hold for every caller of the same
 * ledger; what they cannot see is which rows each production caller actually wrote (the commit channel's call under the
 * run, admission's run-less call, the failover's call under the failed run) and whether the readers those callers feed
 * (`runs show` with its commit row, `get_run` with events, `get_capacity`) stay byte-identical. `expectReplacesRefused`
 * below repeats the pin on exactly those rows, so a caller that ever recorded through another connection (one without
 * the pragma) or into an unguarded table would fail here and nowhere else.
 *
 * Post-#462 residual (Delegated): the harness callers had been read through `get_capacity` and `get_run` only; `runs
 * show` (text and `--json`, through the operator CLI over the same ledger directory) is now in every harness snapshot,
 * and the one caller-specific row shape no test had produced, the quota failover's call failing under the failed run
 * (the backend erroring after the request was sent, or answering off schema twice), is driven and pinned: the row
 * under the failed run with its outcome and summed or unknown counts, the labelled observation the flag then writes
 * under that run, the `inner_call` event carrying the reason, both REPLACE spellings refused on each, the successor
 * unmoved. The `get_capacity` provider entries after a quota failover are also compared across harnesses: one with no
 * classifier hook at all against one labelled under each provider, byte for byte.
 *
 * Post-#471 residual (Delegated): two accounting edges the harness tests had not produced. A reported zero (admission
 * accepted at 0/0; a continuation whose first answer is off schema at 0/0 and whose re-ask is accepted at 3/1) is
 * recorded as the figure 0 and summed as a number, so the labelled row carries `input_tokens: 0` rather than omitting a
 * falsy count or marking it unknown. And the project gate at the production callers through the production resolver
 * (`innerSettingResolver` over the harness's own ledger, with the hook's own fail-closed branch for a resolver that
 * throws): a project `off`, a context `off` under a project that is not, and a resolver throw each write one run-less
 * `fallback_disabled` / `PROJECT_OFF` row with `attempts` 0 and no observation even with the flag, make no request and
 * store the heuristic, while an `inherit` project through the same hook classifies through the backend.
 *
 * Post-#496 residual (Delegated): the breaker (T11.2, LLD §13.4 step 6) at both production callers, where `usage.test.ts`
 * pins it on the injected contract only. `serve` builds one service for the commit channel and the routing hook, so the
 * circuit two failed drafts open over the socket is the one the hook is then denied by: the failed calls write their
 * rows (and, with the flag, labelled rows with unknown counts), the run's one `inner_degraded` event carries the reason
 * code and no count or backend message, and each denied call is a `CIRCUIT_OPEN` row at `attempts` 0 with no
 * observation. At the admission harness the circuit opens on a run-less call, so no `inner_degraded` event exists
 * anywhere; the quota failover under the open circuit is denied run-less at admission and under the failed run with an
 * `inner_call` event carrying the reason, no observation even when the label is that run's own provider.
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
import { GIT_TOOL_DENIED, GitToolService, type OpenChannel } from "../git/channel.js";
import { GitPublisher, publishRefFor } from "../git/index.js";
import { TOOL_TOKEN_ENV } from "../git/tool-protocol.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import type { RunLifecycleOptions } from "../lifecycle/lifecycle.js";
import { buildEnvelope } from "../mcp/envelope.js";
import { DynamicProjectStore, innerSettingResolver, toResolved } from "../projects/index.js";
import { type Harness, type HarnessOptions, type Json, startHarness } from "../routing/fixtures/harness.js";
import { WorkspaceManager } from "../workspace/index.js";
import {
  createClassifyRouteFeaturesHook,
  createFakeBackend,
  createInnerAgent,
  type FakeBackend,
  type FakeStep,
  type InnerAgentService,
  PROMPT_PROVIDER_NAMES,
  type ProjectInnerSetting,
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

type Row = Record<string, unknown>;
const REPLACE_SPELLINGS = ["INSERT OR REPLACE INTO", "REPLACE INTO"] as const;
/** A huge count no honest row carries, so a rewrite that went through could not hide in any reader. */
const REWRITTEN = 999_999;
/**
 * Both `REPLACE` spellings SQLite accepts, on each row one recorded inner call wrote, with the rewrite that would matter
 * to a reader: the `inner_call` row with other counts and outcome (the inner diagnostics), the labelled observation
 * relabelled `provider_reported` (the capacity collector's filter), the run's `inner_call` event with a rewritten
 * payload (`runs show`, `get_run`). Every statement must be refused by the table's `append-only` guard: under
 * `recursive_triggers = ON` (Q-96) the delete half of a REPLACE fires the `BEFORE DELETE` trigger. `labelled` is absent
 * without the flag and `event` is absent for a call without a run id, since `recordInnerCall` then wrote neither. The
 * rewritten outcome is always one the row does not carry (an accepted call to rejected, any other to accepted), so the
 * statement is never a no-op rewrite that a reader could not tell from the original.
 */
function expectReplacesRefused(db: Database.Database, rows: { call: Row; labelled?: Row; event?: Row }): void {
  expect(db.pragma("recursive_triggers", { simple: true })).toBe(1);
  const flipped = rows.call.outcome === "accepted" ? "rejected_validator" : "accepted";
  for (const spelling of REPLACE_SPELLINGS) {
    expect(() =>
      db
        .prepare(
          `${spelling} inner_call (id, task, backend_kind, model_id, locality, template_version, outcome, reason,
             attempts, latency_ms, tokens_in, tokens_out, input_bytes, output_bytes, input_sha256, run_id,
             meta_session_id, created_at)
           VALUES (@id, @task, @backend_kind, @model_id, @locality, @template_version, @outcome, @reason, @attempts,
             @latency_ms, @tokens_in, @tokens_out, @input_bytes, @output_bytes, @input_sha256, @run_id,
             @meta_session_id, @created_at)`,
        )
        .run({ ...rows.call, outcome: flipped, tokens_in: REWRITTEN, tokens_out: REWRITTEN }),
    ).toThrow(/append-only/u);
    if (rows.labelled !== undefined) {
      expect(() =>
        db
          .prepare(
            `${spelling} usage_observation (id, run_id, provider, harness, backing_provider, model, source, metrics_json,
                                            observed_at)
             VALUES (@id, @run_id, @provider, @harness, @backing_provider, @model, @source, @metrics_json, @observed_at)`,
          )
          .run({
            ...rows.labelled,
            source: "provider_reported",
            metrics_json: JSON.stringify({ "usage.input_tokens": REWRITTEN, "usage.output_tokens": REWRITTEN }),
          }),
      ).toThrow(/append-only/u);
    }
    if (rows.event !== undefined) {
      expect(() =>
        db
          .prepare(
            `${spelling} run_event (id, run_id, seq, ts, type, payload_json, artifact_id)
             VALUES (@id, @run_id, @seq, @ts, @type, @payload_json, @artifact_id)`,
          )
          .run({ ...rows.event, payload_json: JSON.stringify({ rewritten: true, tokens_in: REWRITTEN }) }),
      ).toThrow(/append-only/u);
    }
  }
}

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
    o: {
      locality?: "local" | "remote";
      breaker?: { failure_threshold: number; open_ms: number };
      /** Also enable `route_features`, so the hook `serve` builds on the same service can be driven (default: off). */
      routeFeatures?: boolean;
    } = {},
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
      tasks: {
        commit_message: { enabled: true },
        ...(o.routeFeatures === true ? { route_features: { enabled: true } } : {}),
      },
      ...(o.breaker !== undefined ? { breaker: o.breaker } : {}),
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

    it(`${label}: after the drafted commit, both REPLACE spellings are refused on the rows the channel's call wrote${shares === null ? "" : " (the labelled observation included)"}, and every reader is byte-identical (post-#446)`, async () => {
      // The rows this caller wrote: the `inner_call` row under the run (the commit row points at it), the labelled
      // observation under the run when the flag is set, and the run's `inner_call` event. The readers this caller feeds
      // are the ones the first test enumerates plus the commit row and `runs show` whole (events and commits included),
      // in both forms.
      const r = await running();
      const { svc } = inner(shares, [draft("Trim parser input", { in: 8, out: 3 })]);
      const ch = await openFor(service(svc), r);
      expect(await commit(ch, {})).toMatchObject({ ok: true, result: { files_changed: 1 } });
      const state = async () => ({
        calls: db.prepare("SELECT * FROM inner_call ORDER BY rowid").all() as Row[],
        usage: db.prepare("SELECT * FROM usage_observation ORDER BY rowid").all() as Row[],
        events: db.prepare("SELECT * FROM run_event WHERE run_id = ? ORDER BY seq").all(r.runId) as Row[],
        commits: ledger.listGitCommits(r.runId),
        listed: ledger.listInnerCalls({ runId: r.runId }),
        show: await cli(["runs", "show", r.runId, "--json"]),
        showText: await cli(["runs", "show", r.runId]),
        surfaces: await surfaces(r.runId),
      });
      const before = await state();
      const [call] = before.calls;
      const labelled = before.usage.find((row) => row.source === "inner_agent");
      const event = before.events.find((e) => e.type === "inner_call");
      expect(before.calls).toHaveLength(1);
      expect(call).toMatchObject({ task: "commit_message", outcome: "accepted", run_id: r.runId, tokens_in: 8 });
      expect(before.usage.map((row) => row.source)).toEqual(
        shares === null
          ? ["provider_reported", "provider_reported"]
          : ["provider_reported", "provider_reported", "inner_agent"],
      );
      if (shares !== null) expect(labelled).toMatchObject({ provider: shares, harness: shares, run_id: r.runId });
      expect(event).toMatchObject({ type: "inner_call", run_id: r.runId });
      expect(before.commits).toEqual([expect.objectContaining({ message_source: "inner", inner_call_id: call?.id })]);
      expect(JSON.stringify(before)).not.toContain(String(REWRITTEN));

      expectReplacesRefused(db, {
        call: call as Row,
        ...(labelled !== undefined ? { labelled } : {}),
        ...(event !== undefined ? { event } : {}),
      });
      // The run's own provider-reported row is guarded by the same triggers: a REPLACE that inflates it is refused too,
      // so the provider usage every surface above reads cannot be moved by this spelling either.
      const reported = before.usage.find((row) => row.source === "provider_reported" && row.run_id === r.runId);
      for (const spelling of REPLACE_SPELLINGS) {
        expect(() =>
          db
            .prepare(
              `${spelling} usage_observation (id, run_id, provider, harness, backing_provider, model, source, metrics_json,
                                              observed_at)
               VALUES (@id, @run_id, @provider, @harness, @backing_provider, @model, @source, @metrics_json, @observed_at)`,
            )
            .run({ ...reported, metrics_json: JSON.stringify({ "usage.input_tokens": REWRITTEN }) }),
        ).toThrow(/append-only/u);
      }
      expect(await state()).toEqual(before);
    });

    // Post-#496 residual (Delegated): the breaker (T11.2, step 6) at the production callers. `usage.test.ts` pins on the
    // injected contract that a denied call writes no observation and the failed calls that opened the circuit one each;
    // what that cannot see is the rows and events the callers write around the transition, nor that `serve` builds one
    // service (`src/cli/serve.ts`: the same `innerAgent` goes to `GitToolService` and to `createClassifyRouteFeaturesHook`),
    // so the circuit a commit channel opens is the one the routing hook is then denied by. Two drafts whose backend
    // errors open it over the socket: each writes a `BACKEND_ERROR` row with `attempts` 1 (with the flag, a labelled row
    // with `{}` each: the request may have consumed the subscription) and the second writes the run's one
    // `inner_degraded` event in the same transaction, carrying the reason code, never the backend's message or a count.
    // The third draft and a classification through the production hook on the same service are denied `CIRCUIT_OPEN`
    // with `attempts` 0 after the locality lookup and the redaction (so `locality` is `local` and `input_bytes` is not 0)
    // and before any request: no observation even with the flag, no further `inner_degraded` event, the heuristic
    // classifies. The agent's own message still commits while the circuit is open, and no provider surface moves.
    it(`${label}: two failed drafts open the breaker over the socket (one inner_degraded event under the run${shares === null ? "" : ", one labelled row with unknown counts each"}); the denied draft and the routing hook on the same service write CIRCUIT_OPEN rows with attempts 0 and no observation`, async () => {
      const r = await running();
      const { svc, backend } = inner(
        shares,
        [
          { kind: "error", message: "boom" },
          { kind: "error", message: "boom" },
          draft("Never used", { in: 1, out: 1 }),
        ],
        { breaker: { failure_threshold: 2, open_ms: 60_000 }, routeFeatures: true },
      );
      const ch = await openFor(service(svc), r);
      const before = await surfaces(r.runId);
      const [beforeRest, beforeEvents, beforeCommits] = splitEvents(await cli(["runs", "show", r.runId, "--json"]));
      expect(beforeCommits).toEqual([]);
      const runEvents = () =>
        db.prepare("SELECT * FROM run_event WHERE run_id = ? ORDER BY seq").all(r.runId) as (Row & {
          type: string;
          payload_json: string;
          ts: string;
        })[];
      const innerEventsBefore = runEvents().filter((e) => /^inner_/u.test(e.type));
      expect(innerEventsBefore).toEqual([]);

      // (1) and (2): the backend errors after each request; the second failure is the transition.
      expect(await commit(ch, {})).toMatchObject({ ok: false, error: { code: "MESSAGE_REQUIRED" } });
      expect(svc.breakerState).toBe("closed");
      expect(await commit(ch, {})).toMatchObject({ ok: false, error: { code: "MESSAGE_REQUIRED" } });
      expect(svc.breakerState).toBe("open");
      expect(backend.requests).toHaveLength(2);
      const opened = ledger.listInnerCalls({ runId: r.runId });
      expect(opened.map((c) => [c.task, c.outcome, c.reason, c.attempts, c.tokens_in, c.model_id])).toEqual([
        ["commit_message", "fallback_unavailable", "BACKEND_ERROR", 1, null, "local-model"],
        ["commit_message", "fallback_unavailable", "BACKEND_ERROR", 1, null, "local-model"],
      ]);
      const unknown = (runId: string) => ({
        run_id: runId,
        provider: shares,
        harness: shares,
        backing_provider: null,
        model: "local-model",
        metrics_json: "{}",
      });
      expect(innerRows()).toEqual(shares === null ? [] : [unknown(r.runId), unknown(r.runId)]);
      // The run's events so far: two `inner_call` events and, after the second, the one `inner_degraded` event, stamped
      // with the second call row's `created_at` (one transaction), naming the reason code and the breaker's state and
      // carrying neither the backend's message nor a token figure.
      const afterOpen = runEvents().filter((e) => /^inner_/u.test(e.type));
      expect(afterOpen.map((e) => e.type)).toEqual(["inner_call", "inner_call", "inner_degraded"]);
      const degraded = afterOpen[2];
      expect(JSON.parse(degraded?.payload_json ?? "{}")).toEqual({
        state: "degraded",
        reason: "BACKEND_ERROR",
        breaker_state: "open",
        backend_kind: "http",
      });
      expect(degraded?.ts).toBe(opened[1]?.created_at);
      expect(JSON.stringify(afterOpen)).not.toMatch(/boom|token|usage/u);

      // (3): the draft the open circuit denies: no request, a row with `attempts` 0 after the lookup and the redaction,
      // no observation even with the flag, and no second transition event.
      expect(await commit(ch, {})).toMatchObject({ ok: false, error: { code: "MESSAGE_REQUIRED" } });
      expect(backend.requests).toHaveLength(2);
      expect(refSha(repo, publishRefFor(r.sessionId))).toBe("");
      const denied = ledger.listInnerCalls({ runId: r.runId })[2];
      expect(denied).toMatchObject({
        task: "commit_message",
        outcome: "fallback_unavailable",
        reason: "CIRCUIT_OPEN",
        attempts: 0,
        tokens_in: null,
        tokens_out: null,
        model_id: "local-model",
        locality: "local",
        latency_ms: 0,
      });
      expect(denied?.input_bytes).toBeGreaterThan(0);
      expect(innerRows()).toHaveLength(shares === null ? 0 : 2);
      expect(runEvents().filter((e) => e.type === "inner_degraded")).toHaveLength(1);

      // (4): the routing hook `serve` builds on the same service (the production shape, under this run and session) is
      // denied by the circuit the commit channel opened: the heuristic classifies, the row is `CIRCUIT_OPEN` with
      // `attempts` 0 under the run, no request, no observation.
      const hook = createClassifyRouteFeaturesHook(svc, () => "inherit");
      const features = await hook(
        { objective: "ok", constraints: [], verificationCommands: 0, writable: true },
        { runId: r.runId, metaSessionId: r.sessionId },
      );
      expect(features.classifier).toBe("heuristic.v1");
      expect(backend.requests).toHaveLength(2);
      const calls = ledger.listInnerCalls({ runId: r.runId });
      expect(calls.map((c) => [c.task, c.outcome, c.reason, c.attempts, c.meta_session_id])).toEqual([
        ["commit_message", "fallback_unavailable", "BACKEND_ERROR", 1, r.sessionId],
        ["commit_message", "fallback_unavailable", "BACKEND_ERROR", 1, r.sessionId],
        ["commit_message", "fallback_unavailable", "CIRCUIT_OPEN", 0, r.sessionId],
        ["route_features", "fallback_unavailable", "CIRCUIT_OPEN", 0, r.sessionId],
      ]);
      expect(innerRows()).toEqual(shares === null ? [] : [unknown(r.runId), unknown(r.runId)]);
      expect(svc.breakerState).toBe("open");

      // (5): the agent's own message commits while the circuit is open; the channel does not depend on the backend.
      expect(await commit(ch, { message: "Agent wrote this" })).toMatchObject({ ok: true });
      expect(g(repo, "log", "-1", "--format=%s", publishRefFor(r.sessionId))).toBe("Agent wrote this");
      expect(ledger.listInnerCalls({ runId: r.runId })).toHaveLength(4);
      expect(ledger.listGitCommits(r.runId)[0]).toMatchObject({ message_source: "agent", inner_call_id: null });

      // Readers: every provider surface is byte-identical; `runs show` gains the inner events (the degraded one right
      // after the second call's, before the channel's own refusal event for that draft, and listed with its reason code
      // in both forms), the channel's refusal of each undrafted commit, the commit intent and the commit, none with a
      // token figure, a usage key or the backend's message.
      expect(await surfaces(r.runId)).toEqual(before);
      const [afterRest, afterEvents, afterCommits] = splitEvents(await cli(["runs", "show", r.runId, "--json"]));
      expect(afterRest).toBe(beforeRest);
      const gained = afterEvents.slice(beforeEvents.length);
      expect(gained.map((e) => e.type)).toEqual([
        "inner_call",
        GIT_TOOL_DENIED,
        "inner_call",
        "inner_degraded",
        GIT_TOOL_DENIED,
        "inner_call",
        GIT_TOOL_DENIED,
        "inner_call",
        "git_commit_intent",
        "git_commit",
      ]);
      expect(afterCommits).toEqual([expect.objectContaining({ message_source: "agent", inner_call_id: null })]);
      expect(JSON.stringify([gained, afterCommits])).not.toMatch(/boom|token|usage/u);
      expect(JSON.stringify(gained)).toMatch(/CIRCUIT_OPEN/u);
      const text = await cli(["runs", "show", r.runId]);
      expect(text).toMatch(/ {2}inner_degraded {2}\{/u);
      expect(text).toMatch(/CIRCUIT_OPEN/u);
      expect(text).not.toMatch(/boom|inner_agent/u);
      // The text form prints the run's own provider-reported usage (the row `running()` planted), so the no-token pin
      // is on the inner event lines: four `inner_call` lines and the `inner_degraded` line, none with a count.
      const innerLines = text.split("\n").filter((line) => / {2}inner_(?:call|degraded) {2}\{/u.test(line));
      expect(innerLines).toHaveLength(5);
      expect(innerLines.join("\n")).not.toMatch(/token|usage/u);

      // Post-#446 on these rows: the four call rows, the two labelled rows (with the flag), the four `inner_call` events
      // and the `inner_degraded` event refuse both REPLACE spellings, and every reader is byte-identical afterwards.
      const state = async () => ({
        calls: db.prepare("SELECT * FROM inner_call ORDER BY rowid").all() as Row[],
        usage: db.prepare("SELECT * FROM usage_observation ORDER BY rowid").all() as Row[],
        events: runEvents(),
        commits: ledger.listGitCommits(r.runId),
        show: await cli(["runs", "show", r.runId, "--json"]),
        showText: text,
        surfaces: await surfaces(r.runId),
      });
      const snapshot = await state();
      expect(snapshot.calls).toHaveLength(4);
      const labelledRows = snapshot.usage.filter((row) => row.source === "inner_agent");
      expect(labelledRows).toHaveLength(shares === null ? 0 : 2);
      const callEvents = snapshot.events.filter((e) => e.type === "inner_call");
      expect(callEvents).toHaveLength(4);
      expect(JSON.stringify(snapshot)).not.toContain(String(REWRITTEN));
      for (const [i, call] of snapshot.calls.entries()) {
        expectReplacesRefused(db, {
          call,
          ...(i < 2 && shares !== null ? { labelled: labelledRows[i] as Row } : {}),
          event: callEvents[i] as Row,
        });
      }
      expectReplacesRefused(db, {
        call: snapshot.calls[1] as Row,
        event: snapshot.events.find((e) => e.type === "inner_degraded") as Row,
      });
      expect(await state()).toEqual(snapshot);
    });
  }
});

describe("the MCP admission harness (T11.11 production path) records inner usage as T11.5 says (FR-INN-15)", () => {
  let h: Harness | undefined;
  const extraDirs: string[] = [];
  afterEach(async () => {
    await h?.close();
    h = undefined;
    for (const d of extraDirs.splice(0)) rmSync(d, { recursive: true, force: true });
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

  /**
   * `runs show` (text and `--json`) through the operator CLI over the harness's own ledger directory: the third reader
   * T11.5 names beside `get_capacity` and `get_run`, and the one the harness tests had not read. The CLI opens its own
   * connection to the same database file (as `cli-run-isolation.test.ts` does); the config carries only what the loader
   * requires. Its clock is pinned so two reads of an unchanged run are byte-identical.
   */
  const configs = new Map<string, string>();
  async function show(h: Harness, runId: string): Promise<{ json: string; text: string }> {
    let configPath = configs.get(h.root);
    if (configPath === undefined) {
      configPath = path.join(h.root, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          schema_version: 1,
          data_dir: path.join(h.root, "data"),
          allowed_roots: [h.root],
          mcp_clients: [{ id: "orch", max_trust_profile: "edit-untrusted" }],
        }),
      );
      configs.set(h.root, configPath);
    }
    const run = async (args: string[]): Promise<string> => {
      const out: string[] = [];
      const err: string[] = [];
      const io: CliIo = {
        stdout: { write: (s) => out.push(s) },
        stderr: { write: (s) => err.push(s) },
        env: {},
        adapters: new AdapterRegistry().register(new FakeAdapter({ script: "/nonexistent/fake-cli.mjs" })),
        now,
      };
      expect(await main([...args, "--config", configPath as string], io), err.join("")).toBe(0);
      return out.join("");
    };
    return { json: await run(["runs", "show", runId, "--json"]), text: await run(["runs", "show", runId]) };
  }
  /** Both forms of `runs show` for each (untyped) run body, in order. */
  const shows = (h: Harness, runs: readonly Json[]) => Promise.all(runs.map((run) => show(h, run.run_id as string)));

  interface SetupOptions {
    /** The backend's answers, in order. Default: two accepted classifications with counts 4/2 and 6/1. */
    script?: readonly FakeStep[];
    /** The hook's project resolver, built once the harness (and so its ledger) exists. Default: every project `inherit`. */
    resolveSetting?: (harness: Harness) => (projectId: string, contextId: string) => ProjectInnerSetting;
    harness?: HarnessOptions;
    /** The breaker's thresholds (default: the configured defaults, which no test here reaches). */
    breaker?: { failure_threshold: number; open_ms: number };
  }
  async function setup(
    shares: string | null,
    options: SetupOptions = {},
  ): Promise<{ harness: Harness; backend: FakeBackend; service: InnerAgentService }> {
    const backend = createFakeBackend({
      script: options.script ?? [
        { kind: "text", text: reply, usage: { in: 4, out: 2 } },
        { kind: "text", text: reply, usage: { in: 6, out: 1 } },
      ],
    });
    let hook: ReturnType<typeof createClassifyRouteFeaturesHook> | undefined;
    h = await startHarness({
      ...(options.harness ?? {}),
      lifecycle: {
        classifyRouteFeatures: (
          input: Parameters<NonNullable<RunLifecycleOptions["classifyRouteFeatures"]>>[0],
          context: Parameters<NonNullable<RunLifecycleOptions["classifyRouteFeatures"]>>[1],
        ) => {
          if (!hook) throw new Error("hook not initialized");
          return hook(input, context);
        },
        ...(options.harness?.lifecycle ?? {}),
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
        ...(options.breaker !== undefined ? { breaker: options.breaker } : {}),
      }),
      { backend, ledger: h.ledger },
    );
    hook = createClassifyRouteFeaturesHook(service, options.resolveSetting?.(h) ?? (() => "inherit"));
    return { harness: h, backend, service };
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

      // Post-#446: the rows admission and continuation wrote are the two run-less `inner_call` rows and, with the flag,
      // the two run-less labelled observations; no `inner_call` event exists anywhere, since neither call had a run id.
      // Both REPLACE spellings are refused on each, and the readers this caller feeds (`get_capacity`, both runs'
      // `get_run` with and without events, both runs' `runs show` in both forms) are byte-identical, as is every row.
      const state = async () => ({
        calls: h.db.prepare("SELECT * FROM inner_call ORDER BY rowid").all() as Row[],
        usage: h.db.prepare("SELECT * FROM usage_observation ORDER BY rowid").all() as Row[],
        events: h.db.prepare("SELECT type, run_id, payload_json FROM run_event ORDER BY run_id, seq").all() as Row[],
        capacity: entries((await h.ok("get_capacity", {})) as Capacity),
        runs: await Promise.all(
          [first, second].flatMap((run) => [
            h.ok("get_run", { run_id: run.run_id }),
            h.ok("get_run", { run_id: run.run_id, include_events: {} }),
          ]),
        ),
        shows: await shows(h, [first, second]),
      });
      const snapshot = await state();
      expect(snapshot.calls).toHaveLength(2);
      expect(snapshot.events.filter((e) => e.type === "inner_call")).toEqual([]);
      const labelledRows = snapshot.usage.filter((row) => row.source === "inner_agent");
      expect(labelledRows).toHaveLength(shares === null ? 0 : 2);
      expect(JSON.stringify(snapshot)).not.toContain(String(REWRITTEN));
      // `runs show` on either run: no usage section (its query reads provider-reported rows only, and the scripted CLI
      // reported none), no `inner_call` event (run-less calls write none) and no token figure, whatever the label.
      for (const { json, text } of snapshot.shows) {
        expect(JSON.parse(json)).not.toHaveProperty("usage");
        expect(JSON.parse(json).events.map((e: { type: string }) => e.type)).not.toContain("inner_call");
        expect(text).not.toMatch(/inner|token/u);
        expect(json).not.toMatch(/inner|token/u);
      }
      for (const [i, call] of snapshot.calls.entries()) {
        expect(call).toMatchObject({ task: "route_features", run_id: null, outcome: "accepted" });
        expectReplacesRefused(h.db, { call, ...(shares === null ? {} : { labelled: labelledRows[i] as Row }) });
      }
      expect(await state()).toEqual(snapshot);
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

      // Post-#446: this is the one `serve`-path classification that wrote all three guarded rows (the `inner_call` row
      // under the failed run, its labelled observation under that run with the flag, and the failed run's `inner_call`
      // event), beside admission's run-less pair. Both REPLACE spellings are refused on each of them, and the readers
      // this caller feeds (`get_capacity`, both runs' `get_run` with and without events, both runs' `runs show` in both
      // forms, the ledger's per-run list) are byte-identical, as is every row.
      const state = async () => ({
        calls: h.db.prepare("SELECT * FROM inner_call ORDER BY rowid").all() as Row[],
        usage: h.db.prepare("SELECT * FROM usage_observation ORDER BY rowid").all() as Row[],
        events: h.db.prepare("SELECT * FROM run_event ORDER BY run_id, seq").all() as Row[],
        perRun: [failed, successor].map((run) => h.ledger.listUsageObservationsForRun(run.run_id)),
        capacity: entries((await h.ok("get_capacity", {})) as Capacity),
        runs: await Promise.all(
          [failed, successor].flatMap((run) => [
            h.ok("get_run", { run_id: run.run_id }),
            h.ok("get_run", { run_id: run.run_id, include_events: {} }),
          ]),
        ),
        shows: await shows(h, [failed, successor]),
      });
      const snapshot = await state();
      const [admitted, failover] = snapshot.calls;
      const labelledRows = snapshot.usage.filter((row) => row.source === "inner_agent");
      const failoverEvents = snapshot.events.filter((e) => e.type === "inner_call");
      expect(admitted).toMatchObject({ task: "route_features", run_id: null });
      expect(failover).toMatchObject({ task: "route_features", run_id: failed.run_id, tokens_in: 6, tokens_out: 1 });
      expect(labelledRows.map((row) => row.run_id)).toEqual(shares === null ? [] : [null, failed.run_id]);
      expect(failoverEvents).toEqual([expect.objectContaining({ run_id: failed.run_id })]);
      expect(JSON.stringify(snapshot)).not.toContain(String(REWRITTEN));
      // `runs show` on the failed run: the failover's `inner_call` event is listed in both forms with its provenance and
      // no token figure, and there is no usage section even when the label is the failed run's own provider (`fake`),
      // because the query reads provider-reported rows only; the successor shows neither.
      const [failedShow, successorShow] = snapshot.shows;
      const failedDoc = JSON.parse(failedShow?.json ?? "{}") as { events: { type: string; payload: unknown }[] };
      expect(failedDoc).not.toHaveProperty("usage");
      expect(failedDoc.events.filter((e) => e.type === "inner_call").map((e) => e.payload)).toEqual([
        expect.objectContaining({ task: "route_features", outcome: "accepted", attempts: 1 }),
      ]);
      expect(failedShow?.text).toMatch(/ {2}inner_call {2}\{/u);
      for (const doc of [failedShow?.json, failedShow?.text]) expect(doc).not.toMatch(/token|inner_agent/u);
      expect(JSON.parse(successorShow?.json ?? "{}")).not.toHaveProperty("usage");
      for (const doc of [successorShow?.json, successorShow?.text]) expect(doc).not.toMatch(/inner|token/u);
      expectReplacesRefused(h.db, {
        call: admitted as Row,
        ...(shares === null ? {} : { labelled: labelledRows[0] as Row }),
      });
      expectReplacesRefused(h.db, {
        call: failover as Row,
        ...(shares === null ? {} : { labelled: labelledRows[1] as Row }),
        event: failoverEvents[0] as Row,
      });
      expect(await state()).toEqual(snapshot);
    }, 120_000);
  }

  // The failover call failing under the failed run: the one caller-specific row shape no test had produced. The backend
  // either errors after the request was sent (one attempt, counts unknown, the configured model id) or answers off
  // schema on the call and on the one re-ask (two attempts, both attempts' reported counts summed, the backend's model
  // id). Either way the request consumed the shared subscription, so with the flag one labelled row is written under
  // the failed run with exactly what is known; the heuristic classifies the failover instead and the successor is
  // unmoved. The label is `fake`, the failed run's own provider, the most adversarial choice for every reader.
  const FAILURES = [
    {
      name: "errors after the request was sent",
      step: { kind: "error", message: "boom" } as FakeStep,
      requests: 2,
      row: { outcome: "fallback_unavailable", reason: "BACKEND_ERROR", attempts: 1, tokens_in: null, tokens_out: null },
      model: "configured-model",
      metrics: {},
    },
    {
      name: "answers off schema on the call and the re-ask",
      step: { kind: "text", text: "not json", usage: { in: 9, out: 5 } } as FakeStep,
      requests: 3,
      row: { outcome: "rejected_validator", reason: "NOT_JSON", attempts: 2, tokens_in: 18, tokens_out: 10 },
      model: "fake-model",
      metrics: { input_tokens: 18, output_tokens: 10 },
    },
  ] as const;
  for (const failure of FAILURES) {
    for (const shares of [null, "fake"]) {
      const label = shares === null ? "no shared subscription" : `shares_subscription_with = ${shares}`;
      it(`${label}: a failover classification whose backend ${failure.name} writes ${shares === null ? "no observation" : "one labelled row under the failed run with what is known"}; the successor and every reader unmoved`, async () => {
        const { harness: h, backend } = await setup(shares);
        backend.setScript([{ kind: "text", text: reply, usage: { in: 4, out: 2 } }, failure.step]);
        const before = entries((await h.ok("get_capacity", {})) as Capacity);

        const failed = await h.delegate("quota");
        expect(failed).toMatchObject({ status: "FAILED", failure_code: "QUOTA_EXHAUSTED" });
        await h.waitFor(() => h.ledger.findSuccessorRun(failed.run_id) !== undefined);
        const successor = await h.settle(h.ledger.findSuccessorRun(failed.run_id)?.id as string);
        expect(successor).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake-b" } });
        expect(backend.requests).toHaveLength(failure.requests);
        // Admission was classified by the backend; the failover fell back to the heuristic, stored as such (Q-82).
        const [admittedDecision, failoverDecision] = h.decisions();
        expect(JSON.parse(admittedDecision?.features_json ?? "{}").route_features).toMatchObject({
          task_kind: { value: "docs", source: "inner" },
        });
        expect(JSON.parse(failoverDecision?.features_json ?? "{}").route_features).toMatchObject({
          classifier: "heuristic.v1",
          task_kind: { source: "heuristic" },
        });
        expect(failoverDecision?.selected_provider).toBe("fake-b");

        const calls = h.db
          .prepare(
            `SELECT task, run_id, meta_session_id, outcome, reason, attempts, tokens_in, tokens_out, model_id
             FROM inner_call ORDER BY created_at, id`,
          )
          .all();
        expect(calls).toEqual([
          {
            task: "route_features",
            run_id: null,
            meta_session_id: null,
            outcome: "accepted",
            reason: null,
            attempts: 1,
            tokens_in: 4,
            tokens_out: 2,
            model_id: "fake-model",
          },
          {
            task: "route_features",
            run_id: failed.run_id,
            meta_session_id: failed.meta_session_id,
            model_id: failure.model,
            ...failure.row,
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
                  run_id: failed.run_id,
                  provider: shares,
                  harness: shares,
                  model: failure.model,
                  metrics_json: JSON.stringify(failure.metrics),
                },
              ],
        );
        expect(h.db.prepare("SELECT COUNT(*) AS n FROM usage_observation").get()).toEqual({
          n: shares === null ? 0 : 2,
        });

        // Readers: neither envelope reports usage; the failed run's events carry the failover's `inner_call` event with
        // its outcome and reason and no token figure; `get_capacity` counts no observation for the exhausted provider
        // even when the label names it, and the spare that never ran is byte-identical.
        for (const run of [failed, successor]) {
          expect(run.usage).toEqual({ reported: null, estimated: null, capacity_confidence: null });
        }
        const failedEvents = (
          (await h.ok("get_run", { run_id: failed.run_id, include_events: {} })) as {
            events: { type: string; payload: unknown }[];
          }
        ).events;
        const innerEvents = failedEvents.filter((e) => e.type === "inner_call");
        expect(innerEvents.map((e) => e.payload)).toEqual([
          expect.objectContaining({
            task: "route_features",
            outcome: failure.row.outcome,
            reason: failure.row.reason,
            attempts: failure.row.attempts,
          }),
        ]);
        expect(JSON.stringify(innerEvents)).not.toMatch(/token|input_tokens|boom|not json/u);
        const afterBody = (await h.ok("get_capacity", {})) as Capacity;
        for (const p of ["fake", "fake-b"]) {
          expect(afterBody.providers.find((x) => x.provider === p)?.window.usage_observations).toBe(0);
        }
        expect(entries(afterBody).grok).toBe(before.grok);
        expect(JSON.stringify(afterBody)).not.toMatch(/inner/u);

        // The three rows the failed call wrote (the `inner_call` row, the labelled row with the flag, the event) and
        // admission's pair refuse both REPLACE spellings, and every reader is byte-identical afterwards.
        const state = async () => ({
          calls: h.db.prepare("SELECT * FROM inner_call ORDER BY rowid").all() as Row[],
          usage: h.db.prepare("SELECT * FROM usage_observation ORDER BY rowid").all() as Row[],
          events: h.db.prepare("SELECT * FROM run_event ORDER BY run_id, seq").all() as Row[],
          perRun: [failed, successor].map((run) => h.ledger.listUsageObservationsForRun(run.run_id)),
          capacity: entries((await h.ok("get_capacity", {})) as Capacity),
          runs: await Promise.all(
            [failed, successor].flatMap((run) => [
              h.ok("get_run", { run_id: run.run_id }),
              h.ok("get_run", { run_id: run.run_id, include_events: {} }),
            ]),
          ),
          shows: await shows(h, [failed, successor]),
        });
        const snapshot = await state();
        const [admitted, failover] = snapshot.calls;
        const labelledRows = snapshot.usage.filter((row) => row.source === "inner_agent");
        const failoverEvents = snapshot.events.filter((e) => e.type === "inner_call");
        expect(failover).toMatchObject({ run_id: failed.run_id, outcome: failure.row.outcome });
        expect(failoverEvents).toEqual([expect.objectContaining({ run_id: failed.run_id })]);
        expect(JSON.stringify(snapshot)).not.toContain(String(REWRITTEN));
        for (const { json, text } of snapshot.shows) {
          expect(JSON.parse(json)).not.toHaveProperty("usage");
          expect(json).not.toMatch(/token|inner_agent|boom|not json/u);
          expect(text).not.toMatch(/token|inner_agent|boom|not json/u);
        }
        expectReplacesRefused(h.db, {
          call: admitted as Row,
          ...(shares === null ? {} : { labelled: labelledRows[0] as Row }),
        });
        expectReplacesRefused(h.db, {
          call: failover as Row,
          ...(shares === null ? {} : { labelled: labelledRows[1] as Row }),
          event: failoverEvents[0] as Row,
        });
        expect(await state()).toEqual(snapshot);
      }, 120_000);
    }
  }

  // T11.5 "byte-identical with and without inner calls", across harnesses rather than before and after: the same quota
  // failover driven with no classifier hook at all (the lifecycle's heuristic, no inner agent anywhere) and then with
  // the backend classifying admission and failover under a label naming each provider in turn. The per-provider
  // `get_capacity` entries (every field but the clock: score, confidence, risk, sources, breaker, window counts) must
  // be the same bytes, including for the exhausted provider when it is the label and so has one labelled row with
  // counts under its failed run. The `affinity` block is keyed by the workspace path's hash, which differs per harness,
  // so it is not compared here; `src/capacity/capacity.test.ts` pins it on one ledger.
  it("the quota failover's get_capacity provider entries are the same bytes with no inner agent and with one labelled under every provider", async () => {
    const failover = async (harness: Harness) => {
      const failed = await harness.delegate("quota");
      expect(failed).toMatchObject({ status: "FAILED", failure_code: "QUOTA_EXHAUSTED" });
      await harness.waitFor(() => harness.ledger.findSuccessorRun(failed.run_id) !== undefined);
      const successor = await harness.settle(harness.ledger.findSuccessorRun(failed.run_id)?.id as string);
      expect(successor).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake-b" } });
      return {
        failedId: failed.run_id as string,
        entries: entries((await harness.ok("get_capacity", {})) as Capacity),
      };
    };
    h = await startHarness();
    const { entries: baseline } = await failover(h);
    expect(Object.keys(baseline).sort()).toEqual(["fake", "fake-b", "grok"]);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM inner_call").get()).toEqual({ n: 0 });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM usage_observation").get()).toEqual({ n: 0 });
    // The baseline is not a trivial answer: the exhausted provider's window records the failure and the successor's
    // its run, so a labelled row leaking into the collector would move a non-empty window.
    expect(JSON.parse(baseline.fake ?? "{}")).toMatchObject({ window: { terminal_runs: 1, quota_exhausted: 1 } });
    expect(JSON.parse(baseline["fake-b"] ?? "{}")).toMatchObject({ window: { terminal_runs: 1 } });
    await h.close();
    h = undefined;

    for (const shares of ["fake", "fake-b", "grok"]) {
      const { harness, backend } = await setup(shares);
      const labelled = await failover(harness);
      expect(labelled.entries).toEqual(baseline);
      expect(backend.requests).toHaveLength(2);
      // What the comparison is against: admission's run-less labelled row and the failover's under the failed run,
      // both naming this label, and no other observation in the ledger.
      expect(harness.db.prepare("SELECT provider, run_id, source FROM usage_observation ORDER BY rowid").all()).toEqual(
        [
          { provider: shares, run_id: null, source: "inner_agent" },
          { provider: shares, run_id: labelled.failedId, source: "inner_agent" },
        ],
      );
      await harness.close();
      h = undefined;
    }
  }, 180_000);

  // Post-#471 residual (Delegated): a reported zero is a figure, not an unknown (FR-INN-15 "as reported or unknown";
  // `tokenCount(0)` is 0 and the ledger writes a metric for every non-null count). No channel test had recorded one, so
  // a ledger that dropped falsy counts (`if (row.tokens_in)` for `!== null`) or a pipeline that summed a zero as
  // unknown would have passed every pin so far (`src/inner/usage.test.ts` pins `tokenCount(0)` as a unit only).
  // Admission reports 0/0 and is accepted; the continuation's first answer is off schema with 0/0 and the re-ask is
  // accepted with 3/1, so its figure is 0 + 3 and 0 + 1 over two attempts: summed, never unknown.
  for (const shares of [null, "fake-b"]) {
    const label = shares === null ? "no shared subscription" : `shares_subscription_with = ${shares}`;
    it(`${label}: zero reported counts are recorded as zero and summed through a re-ask, ${shares === null ? "no observation" : "two labelled rows carrying the zeros"}, provider capacity unmoved`, async () => {
      const { harness: h, backend } = await setup(shares, {
        script: [
          { kind: "text", text: reply, usage: { in: 0, out: 0 } },
          { kind: "text", text: "not json", usage: { in: 0, out: 0 } },
          { kind: "text", text: reply, usage: { in: 3, out: 1 } },
        ],
      });
      const before = entries((await h.ok("get_capacity", {})) as Capacity);

      const first = await h.delegate("ok", { provider_preference: "fake-b", require_provider: true });
      expect(first.provider.adapter).toBe("fake-b");
      const continued = await h.ok("continue_task", { meta_session_id: first.meta_session_id, instruction: "ok" });
      const second = await h.settle(continued.run_id);
      expect(second.provider.adapter).toBe("fake-b");
      expect(backend.requests).toHaveLength(3);
      for (const row of h.decisions()) {
        expect(JSON.parse(row.features_json).route_features.task_kind).toMatchObject({
          value: "docs",
          source: "inner",
        });
      }
      expect(
        h.db
          .prepare(
            `SELECT task, run_id, outcome, reason, attempts, tokens_in, tokens_out, model_id
             FROM inner_call ORDER BY created_at, id`,
          )
          .all(),
      ).toEqual([
        {
          task: "route_features",
          run_id: null,
          outcome: "accepted",
          reason: null,
          attempts: 1,
          tokens_in: 0,
          tokens_out: 0,
          model_id: "fake-model",
        },
        {
          task: "route_features",
          run_id: null,
          outcome: "accepted",
          reason: null,
          attempts: 2,
          tokens_in: 3,
          tokens_out: 1,
          model_id: "fake-model",
        },
      ]);
      // The labelled rows carry the zero as a key with the value 0, exactly as a non-zero count would be carried, and
      // the summed figure; nothing is omitted as falsy and nothing is unknown.
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
                metrics_json: JSON.stringify({ input_tokens: 0, output_tokens: 0 }),
              },
              {
                run_id: null,
                provider: shares,
                harness: shares,
                model: "fake-model",
                metrics_json: JSON.stringify({ input_tokens: 3, output_tokens: 1 }),
              },
            ],
      );
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM usage_observation WHERE source = 'inner_agent'").get()).toEqual({
        n: shares === null ? 0 : 2,
      });

      // Readers: a zero-count labelled row under the provider that ran moves its window no more than a counted one.
      for (const run of [first, second]) {
        expect(run.usage).toEqual({ reported: null, estimated: null, capacity_confidence: null });
        expect(h.ledger.listUsageObservationsForRun(run.run_id)).toEqual([]);
      }
      const providerReported = (
        h.db
          .prepare("SELECT COUNT(*) AS n FROM usage_observation WHERE source = 'provider_reported' AND provider = ?")
          .get("fake-b") as { n: number }
      ).n;
      const afterBody = (await h.ok("get_capacity", {})) as Capacity;
      const after = entries(afterBody);
      expect(afterBody.providers.find((p) => p.provider === "fake-b")?.window.usage_observations).toBe(
        providerReported,
      );
      expect(after.grok).toBe(before.grok);
      expect(after.fake).toBe(before.fake);
      expect(JSON.stringify(afterBody)).not.toMatch(/inner/u);

      const state = async () => ({
        calls: h.db.prepare("SELECT * FROM inner_call ORDER BY rowid").all() as Row[],
        usage: h.db.prepare("SELECT * FROM usage_observation ORDER BY rowid").all() as Row[],
        events: h.db.prepare("SELECT type, run_id, payload_json FROM run_event ORDER BY run_id, seq").all() as Row[],
        capacity: entries((await h.ok("get_capacity", {})) as Capacity),
        runs: await Promise.all(
          [first, second].flatMap((run) => [
            h.ok("get_run", { run_id: run.run_id }),
            h.ok("get_run", { run_id: run.run_id, include_events: {} }),
          ]),
        ),
        shows: await shows(h, [first, second]),
      });
      const snapshot = await state();
      expect(snapshot.events.filter((e) => e.type === "inner_call")).toEqual([]);
      expect(JSON.stringify(snapshot)).not.toContain(String(REWRITTEN));
      for (const { json, text } of snapshot.shows) {
        expect(JSON.parse(json)).not.toHaveProperty("usage");
        expect(text).not.toMatch(/inner|token/u);
        expect(json).not.toMatch(/inner|token/u);
      }
      const labelledRows = snapshot.usage.filter((row) => row.source === "inner_agent");
      for (const [i, call] of snapshot.calls.entries()) {
        expectReplacesRefused(h.db, { call, ...(shares === null ? {} : { labelled: labelledRows[i] as Row }) });
      }
      expect(await state()).toEqual(snapshot);
    }, 120_000);
  }

  // Post-#471 residual (Delegated): route-feature gating at the production callers through the production resolver.
  // `serve` builds the hook over `innerSettingResolver` (configured projects first, then the dynamic store, unknown is
  // `off`; `src/git/commit-message.test.ts` pins the resolver as a unit) and the hook turns a resolver throw into `off`
  // (`src/inner/route-features.ts`). `src/mcp/inner-route-features.test.ts` pins the stored heuristic and the request
  // count for a project `off` and a throwing resolver, but nothing had read what those denials write. Here the same
  // resolver, over the harness's own ledger, serves a project set `off`, a project whose context is `off` under a
  // project that is not (the most restrictive wins), a project the resolver cannot read, and an `inherit` project.
  // Each denial is zero-cost: one run-less `inner_call` row with `fallback_disabled` / `PROJECT_OFF`, `attempts` 0, no
  // count, the configured model id and the initial `remote` locality (no lookup happened), no observation even with the
  // flag (nothing was consumed), no backend request, the heuristic stored (Q-82). The `inherit` project classifies
  // through the backend with the same hook, so the gate and not the wiring is what decides; the continuation under the
  // denied session is denied the same way with the session id on its row.
  for (const shares of [null, "fake-b"]) {
    const label = shares === null ? "no shared subscription" : `shares_subscription_with = ${shares}`;
    it(`${label}: an admission or continuation the project gate denies through the production resolver (off, context off, resolver throwing) writes one run-less fallback_disabled row with attempts 0 and ${shares === null ? "no observation" : "no observation despite the flag"}; the inherit project classifies`, async () => {
      const repo = realpathSync(mkdtempSync(path.join(SHORT_TMP, "sb-inner-proj-")));
      extraDirs.push(repo);
      g(repo, "init", "-q", "-b", "main");
      writeFileSync(path.join(repo, "README.md"), "hello\n");
      g(repo, "add", "-A");
      g(repo, "commit", "-q", "-m", "init");
      const ctx = (inner_agent?: ProjectInnerSetting) => ({
        id: "main",
        kind: "repository" as const,
        path: repo,
        base_ref: "main",
        ...(inner_agent !== undefined ? { inner_agent } : {}),
      });
      const projects = [
        toResolved({ id: "open", name: "Open", contexts: [ctx()] }),
        toResolved({ id: "shut", name: "Shut", inner_agent: "off", contexts: [ctx()] }),
        toResolved({ id: "ctxshut", name: "Context shut", inner_agent: "inherit", contexts: [ctx("off")] }),
        toResolved({ id: "boom", name: "Boom", contexts: [ctx()] }),
      ];
      const ids = projects.map((p) => p.id);
      const { harness: h, backend } = await setup(shares, {
        resolveSetting: (harness) => {
          const real = innerSettingResolver(projects, new DynamicProjectStore(harness.db));
          return (projectId, contextId) => {
            if (projectId === "boom") throw new Error("resolver threw");
            return real(projectId, contextId);
          };
        },
        harness: {
          lifecycle: { allowedRoots: [repo] },
          config: {
            allowedRoots: [repo],
            projects,
            mcpClients: new Map([
              ["orch", { id: "orch", maxTrustProfile: "edit-untrusted", projects: ids }],
              ["other", { id: "other", maxTrustProfile: "edit-untrusted" }],
            ]),
          },
        },
      });
      const before = entries((await h.ok("get_capacity", {})) as Capacity);
      const delegate = async (project: string) =>
        h.settle(
          (
            await h.ok("delegate_task", {
              project,
              objective: "ok",
              trust_profile: "edit-untrusted",
            })
          ).run_id,
        );

      const shut = await delegate("shut");
      const shutContinued = await h.settle(
        (await h.ok("continue_task", { meta_session_id: shut.meta_session_id, instruction: "ok" })).run_id,
      );
      const ctxshut = await delegate("ctxshut");
      const boom = await delegate("boom");
      expect(backend.requests).toHaveLength(0);
      const open = await delegate("open");
      expect(backend.requests).toHaveLength(1);
      const runs = [shut, shutContinued, ctxshut, boom, open];
      // Project runs land on `fake` (configured order); `fake-b` and `grok` never run and are the byte-identical pair.
      for (const run of runs)
        expect(run, JSON.stringify(run)).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake" } });

      // Stored decisions: the heuristic for every denied classification, the backend's for the open project (Q-82).
      const classifierOf = (run: Json) =>
        JSON.parse(h.decisions().find((d) => d.run_id === run.run_id)?.features_json ?? "{}").route_features.classifier;
      for (const run of [shut, shutContinued, ctxshut, boom]) expect(classifierOf(run)).toBe("heuristic.v1");
      expect(classifierOf(open)).toBe("route_features.v1");

      const denied = {
        task: "route_features",
        run_id: null,
        outcome: "fallback_disabled",
        reason: "PROJECT_OFF",
        attempts: 0,
        tokens_in: null,
        tokens_out: null,
        model_id: "configured-model",
        locality: "remote",
        input_bytes: 0,
      };
      expect(
        h.db
          .prepare(
            `SELECT task, run_id, meta_session_id, outcome, reason, attempts, tokens_in, tokens_out, model_id, locality,
                    input_bytes
             FROM inner_call ORDER BY created_at, id`,
          )
          .all(),
      ).toEqual([
        { ...denied, meta_session_id: null },
        { ...denied, meta_session_id: shut.meta_session_id },
        { ...denied, meta_session_id: null },
        { ...denied, meta_session_id: null },
        {
          task: "route_features",
          run_id: null,
          meta_session_id: null,
          outcome: "accepted",
          reason: null,
          attempts: 1,
          tokens_in: 4,
          tokens_out: 2,
          model_id: "fake-model",
          locality: "local",
          input_bytes: expect.any(Number),
        },
      ]);
      // The only observation is the open project's: a denial consumed nothing, so the flag writes nothing for it.
      expect(
        h.db
          .prepare(
            "SELECT run_id, provider, harness, model, metrics_json, source FROM usage_observation ORDER BY rowid",
          )
          .all()
          .filter((row) => (row as Row).source === "inner_agent"),
      ).toEqual(
        shares === null
          ? []
          : [
              {
                run_id: null,
                provider: shares,
                harness: shares,
                model: "fake-model",
                metrics_json: JSON.stringify({ input_tokens: 4, output_tokens: 2 }),
                source: "inner_agent",
              },
            ],
      );

      // Readers: no run reports usage; the providers that never ran are byte-identical; the one that ran counts
      // provider-reported rows only.
      for (const run of runs) {
        expect(run.usage).toEqual({ reported: null, estimated: null, capacity_confidence: null });
        expect(h.ledger.listUsageObservationsForRun(run.run_id)).toEqual([]);
      }
      const afterBody = (await h.ok("get_capacity", {})) as Capacity;
      const after = entries(afterBody);
      expect(after.grok).toBe(before.grok);
      expect(after["fake-b"]).toBe(before["fake-b"]);
      expect(afterBody.providers.find((p) => p.provider === "fake")?.window.usage_observations).toBe(
        (
          h.db
            .prepare("SELECT COUNT(*) AS n FROM usage_observation WHERE source = 'provider_reported' AND provider = ?")
            .get("fake") as { n: number }
        ).n,
      );
      expect(JSON.stringify(afterBody)).not.toMatch(/inner/u);

      const state = async () => ({
        calls: h.db.prepare("SELECT * FROM inner_call ORDER BY rowid").all() as Row[],
        usage: h.db.prepare("SELECT * FROM usage_observation ORDER BY rowid").all() as Row[],
        events: h.db.prepare("SELECT type, run_id, payload_json FROM run_event ORDER BY run_id, seq").all() as Row[],
        capacity: entries((await h.ok("get_capacity", {})) as Capacity),
        runs: await Promise.all(
          runs.flatMap((run) => [
            h.ok("get_run", { run_id: run.run_id }),
            h.ok("get_run", { run_id: run.run_id, include_events: {} }),
          ]),
        ),
        shows: await shows(h, runs),
      });
      const snapshot = await state();
      expect(snapshot.calls).toHaveLength(5);
      // Run-less calls write no event, denied or not, so no run carries an `inner_call` event or a reason code.
      expect(snapshot.events.filter((e) => e.type === "inner_call")).toEqual([]);
      expect(JSON.stringify(snapshot.runs)).not.toMatch(/PROJECT_OFF|fallback_disabled|inner_call|token/u);
      for (const { json, text } of snapshot.shows) {
        expect(JSON.parse(json)).not.toHaveProperty("usage");
        expect(text).not.toMatch(/inner|token|PROJECT_OFF/u);
        expect(json).not.toMatch(/inner|token|PROJECT_OFF/u);
      }
      expect(JSON.stringify(snapshot)).not.toContain(String(REWRITTEN));
      const labelledRows = snapshot.usage.filter((row) => row.source === "inner_agent");
      for (const call of snapshot.calls) {
        const labelled = call.outcome === "accepted" && shares !== null ? { labelled: labelledRows[0] as Row } : {};
        expectReplacesRefused(h.db, { call, ...labelled });
      }
      expect(await state()).toEqual(snapshot);
    }, 120_000);
  }

  // Post-#496 residual (Delegated): the breaker (T11.2, step 6) at the admission harness. Admission classifies before a
  // run exists, so when the second failed admission opens the circuit the `inner_degraded` event the pipeline hands the
  // ledger has no run to be written under: the degradation is on record in the two `BACKEND_ERROR` rows (and, with the
  // flag, their two labelled rows with `{}`) and nowhere in any run's event list or `runs show`. The quota failover is
  // then driven under the open circuit: its admission is denied run-less, and its failover classification, the one
  // `serve`-path call with a run id, is denied under the failed run with a `CIRCUIT_OPEN` row at `attempts` 0 and an
  // `inner_call` event carrying that reason and no count, and no observation even when the label is the failed run's own
  // provider. The heuristic classifies every denied call, the successor is unmoved and no provider surface moves.
  for (const shares of [null, "fake"]) {
    const label = shares === null ? "no shared subscription" : `shares_subscription_with = ${shares}`;
    it(`${label}: two failed admissions open the breaker with no event anywhere (${shares === null ? "no observation" : "two run-less labelled rows with unknown counts"}); the quota failover under the open circuit is denied run-less at admission and under the failed run with a CIRCUIT_OPEN event, no observation`, async () => {
      const {
        harness: h,
        backend,
        service,
      } = await setup(shares, {
        script: [
          { kind: "error", message: "boom" },
          { kind: "error", message: "boom" },
          { kind: "text", text: reply },
        ],
        breaker: { failure_threshold: 2, open_ms: 60_000 },
      });
      const before = entries((await h.ok("get_capacity", {})) as Capacity);
      const innerEvents = () =>
        h.db
          .prepare("SELECT type, run_id, payload_json FROM run_event WHERE type LIKE 'inner_%' ORDER BY run_id, seq")
          .all() as (Row & { type: string; run_id: string; payload_json: string })[];

      // Two admissions whose classification fails after the request was sent; the second opens the circuit. Both runs
      // are put on `fake` (a requirement, so routing cannot move them), the one provider the scripted CLI stops on quota,
      // so that the workspace's affinity then keeps the quota run there too (affinity outranks a preference).
      const first = await h.delegate("ok", { provider_preference: "fake", require_provider: true });
      expect(service.breakerState).toBe("closed");
      const second = await h.delegate("ok", { provider_preference: "fake", require_provider: true });
      expect(service.breakerState).toBe("open");
      for (const run of [first, second])
        expect(run).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake" } });
      expect(backend.requests).toHaveLength(2);
      expect(innerEvents()).toEqual([]);

      // The failover under the open circuit: admission denied run-less, the failover classification denied under the
      // failed run, no request for either; the successor lands where it always does.
      const failed = await h.delegate("quota");
      expect(failed).toMatchObject({
        status: "FAILED",
        failure_code: "QUOTA_EXHAUSTED",
        provider: { adapter: "fake" },
      });
      await h.waitFor(() => h.ledger.findSuccessorRun(failed.run_id) !== undefined);
      const successor = await h.settle(h.ledger.findSuccessorRun(failed.run_id)?.id as string);
      expect(successor).toMatchObject({ status: "SUCCEEDED", provider: { adapter: "fake-b" } });
      expect(backend.requests).toHaveLength(2);
      expect(service.breakerState).toBe("open");
      expect(h.decisions()).toHaveLength(4);
      for (const row of h.decisions()) {
        expect(JSON.parse(row.features_json).route_features).toMatchObject({
          classifier: "heuristic.v1",
          task_kind: { source: "heuristic" },
        });
      }

      const failedCall = {
        task: "route_features",
        run_id: null,
        meta_session_id: null,
        outcome: "fallback_unavailable",
        reason: "BACKEND_ERROR",
        attempts: 1,
        tokens_in: null,
        tokens_out: null,
        model_id: "configured-model",
        locality: "local",
      };
      const deniedCall = { ...failedCall, reason: "CIRCUIT_OPEN", attempts: 0 };
      expect(
        h.db
          .prepare(
            `SELECT task, run_id, meta_session_id, outcome, reason, attempts, tokens_in, tokens_out, model_id, locality
             FROM inner_call ORDER BY created_at, id`,
          )
          .all(),
      ).toEqual([
        failedCall,
        failedCall,
        deniedCall,
        { ...deniedCall, run_id: failed.run_id, meta_session_id: failed.meta_session_id },
      ]);
      // A denied call made no request, so the lookup and the redaction ran (`locality` local, bytes counted) but the
      // only observations are the two failed requests', run-less with unknown counts under the configured model id.
      for (const row of h.db.prepare("SELECT input_bytes FROM inner_call").all() as { input_bytes: number }[]) {
        expect(row.input_bytes).toBeGreaterThan(0);
      }
      expect(
        h.db
          .prepare(
            "SELECT run_id, provider, harness, model, metrics_json, source FROM usage_observation ORDER BY rowid",
          )
          .all()
          .filter((row) => (row as Row).source === "inner_agent"),
      ).toEqual(
        shares === null
          ? []
          : [
              {
                run_id: null,
                provider: shares,
                harness: shares,
                model: "configured-model",
                metrics_json: "{}",
                source: "inner_agent",
              },
              {
                run_id: null,
                provider: shares,
                harness: shares,
                model: "configured-model",
                metrics_json: "{}",
                source: "inner_agent",
              },
            ],
      );
      // The only inner event in the ledger is the failover denial's `inner_call` under the failed run, with the reason
      // and no count; no `inner_degraded` event exists, since the transition happened on a run-less call.
      const events = innerEvents();
      expect(events.map((e) => [e.type, e.run_id])).toEqual([["inner_call", failed.run_id]]);
      expect(JSON.parse(events[0]?.payload_json ?? "{}")).toMatchObject({
        task: "route_features",
        outcome: "fallback_unavailable",
        reason: "CIRCUIT_OPEN",
        attempts: 0,
        locality: "local",
      });
      expect(events[0]?.payload_json).not.toMatch(/token|boom/u);

      // Readers: no run reports usage; the exhausted provider (three runs, two labelled rows naming it with the flag)
      // and the successor count provider-reported rows only; the spare that never ran is byte-identical.
      const runs = [first, second, failed, successor];
      for (const run of runs) {
        expect(run.usage).toEqual({ reported: null, estimated: null, capacity_confidence: null });
        expect(h.ledger.listUsageObservationsForRun(run.run_id)).toEqual([]);
      }
      const afterBody = (await h.ok("get_capacity", {})) as Capacity;
      for (const p of ["fake", "fake-b"]) {
        expect(afterBody.providers.find((x) => x.provider === p)?.window.usage_observations).toBe(
          (
            h.db
              .prepare(
                "SELECT COUNT(*) AS n FROM usage_observation WHERE source = 'provider_reported' AND provider = ?",
              )
              .get(p) as { n: number }
          ).n,
        );
      }
      expect(JSON.parse(entries(afterBody).fake ?? "{}")).toMatchObject({
        window: { terminal_runs: 3, quota_exhausted: 1 },
      });
      expect(entries(afterBody).grok).toBe(before.grok);
      expect(JSON.stringify(afterBody)).not.toMatch(/inner|CIRCUIT_OPEN/u);

      // `runs show`: the failed run lists the denial with its reason in both forms, none shows a usage section, a token
      // figure, a degraded event or the backend's message.
      const state = async () => ({
        calls: h.db.prepare("SELECT * FROM inner_call ORDER BY rowid").all() as Row[],
        usage: h.db.prepare("SELECT * FROM usage_observation ORDER BY rowid").all() as Row[],
        events: h.db.prepare("SELECT * FROM run_event ORDER BY run_id, seq").all() as Row[],
        capacity: entries((await h.ok("get_capacity", {})) as Capacity),
        runs: await Promise.all(
          runs.flatMap((run) => [
            h.ok("get_run", { run_id: run.run_id }),
            h.ok("get_run", { run_id: run.run_id, include_events: {} }),
          ]),
        ),
        shows: await shows(h, runs),
      });
      const snapshot = await state();
      expect(snapshot.calls).toHaveLength(4);
      const [, , failedShow, successorShow] = snapshot.shows;
      expect(
        JSON.parse(failedShow?.json ?? "{}").events.filter((e: { type: string }) => e.type === "inner_call"),
      ).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ reason: "CIRCUIT_OPEN", attempts: 0 }) }),
      ]);
      expect(failedShow?.text).toMatch(/ {2}inner_call {2}\{/u);
      expect(failedShow?.text).toMatch(/CIRCUIT_OPEN/u);
      for (const doc of [successorShow?.json, successorShow?.text]) expect(doc).not.toMatch(/inner|CIRCUIT_OPEN/u);
      for (const { json, text } of snapshot.shows) {
        expect(JSON.parse(json)).not.toHaveProperty("usage");
        expect(json).not.toMatch(/token|inner_agent|inner_degraded|boom/u);
        expect(text).not.toMatch(/token|inner_agent|inner_degraded|boom/u);
      }
      expect(JSON.stringify(snapshot)).not.toContain(String(REWRITTEN));
      const labelledRows = snapshot.usage.filter((row) => row.source === "inner_agent");
      const denialEvent = snapshot.events.find((e) => e.type === "inner_call");
      for (const [i, call] of snapshot.calls.entries()) {
        expectReplacesRefused(h.db, {
          call,
          ...(i < 2 && shares !== null ? { labelled: labelledRows[i] as Row } : {}),
          ...(i === 3 ? { event: denialEvent as Row } : {}),
        });
      }
      expect(await state()).toEqual(snapshot);
    }, 120_000);
  }
});
