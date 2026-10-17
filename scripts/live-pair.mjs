#!/usr/bin/env node
/**
 * Opt-in live pair test (T5.11; ROADMAP §6.9, M5 verification; FR-SES-03, FR-SES-04, NFR-SEC-01). Delegates one trivial
 * edit task to one real provider CLI through `switchboard serve`, then continues the same meta-session on a second real
 * provider through `continue_task` (a handoff under BR-18), in a throwaway Git repository under a temp directory:
 *
 *   SWITCHBOARD_LIVE_TESTS=1 npm run test:live:pair                       # claude -> codex, then codex -> claude
 *   SWITCHBOARD_LIVE_TESTS=1 SWITCHBOARD_LIVE_PAIR=claude:codex npm run test:live:pair
 *
 * Skipped (exit 0, nothing run) unless SWITCHBOARD_LIVE_TESTS=1. `npm test` and CI never run it. Optional:
 *   SWITCHBOARD_LIVE_PAIR        `<first>:<second>` (provider plug-in ids), or `both` (default): every ordered pair of
 *                                the Claude Code and Codex plug-ins, so each direction is run
 *   SWITCHBOARD_LIVE_TIMEOUT_MS  how long to wait for each run (default 600000)
 *   SWITCHBOARD_LIVE_KEEP=1      keep the temp directories (ledger, artifacts, serve log) for inspection
 *   SWITCHBOARD_LIVE_BUDGET_FILE, SWITCHBOARD_LIVE_PURPOSE  the live-test budget guard (T8.9; scripts/live/budget.mjs):
 *                                caps, minimum gap, purpose allowlist and model per provider; exit 75 on refusal. Each
 *                                pair direction is one provider run on each of its two providers.
 *
 * It uses the provider plug-ins of `scripts/live/providers/` (T4.3) for the adapter and probe, and the same rules as
 * `scripts/live-smoke.mjs`: it never reads, copies or prints credential files, tokens or keys, and passes no bypass flag
 * (both compiles are audited). It records statuses, the failure codes, the bindings (provider, harness, backing
 * provider, model; never a native session id), the bundle's artifact id and SHA-256, and check results. It never
 * prints or stores a prompt, a transcript or provider output text.
 *
 * Whether it was run is a fact for the operator task T5.12; nothing here claims a result.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { admitLiveRun, EXIT_REFUSED, modelHandoff, withBudgetModel } from "./live/budget.mjs";

const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "live", "providers");
const PROVIDERS = readdirSync(PLUGIN_DIR)
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => f.slice(0, -".mjs".length))
  .sort();
/** Fixture plug-ins (`fake`, T8.9) are selectable but not advertised, so the messages read as before. */
const listed = (ids) => ids.filter((id) => !id.startsWith("fake"));
/** The pair this milestone is verified with (M5 row): Claude Code and Codex, each direction. */
const DEFAULT_PAIRS = [
  ["claude", "codex"],
  ["codex", "claude"],
];

/** `claude:codex` -> one pair; `both` or unset -> {@link DEFAULT_PAIRS}; anything else is refused. */
export function parsePairs(spec, known = PROVIDERS) {
  if (spec === undefined || spec === "" || spec === "both") return { ok: true, pairs: DEFAULT_PAIRS };
  const m = /^([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)$/.exec(spec);
  if (!m) return { ok: false, reason: "SWITCHBOARD_LIVE_PAIR must be both or <first>:<second>" };
  const [, a, b] = m;
  if (a === b) return { ok: false, reason: "the two providers of a pair must differ (a handoff is across providers)" };
  for (const id of [a, b]) {
    if (!known.includes(id))
      return { ok: false, reason: `unknown provider plug-in ${id}; expected one of ${listed(known).join(", ")}` };
  }
  return { ok: true, pairs: [[a, b]] };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await run();

async function run() {
  if (process.env.SWITCHBOARD_LIVE_TESTS !== "1") {
    process.stdout.write(
      `live-pair: SKIPPED (opt-in). Set SWITCHBOARD_LIVE_TESTS=1 (and optionally SWITCHBOARD_LIVE_PAIR=<first>:<second> from ${listed(PROVIDERS).join("|")}) to run it.\n`,
    );
    process.exit(0);
  }
  const parsed = parsePairs(process.env.SWITCHBOARD_LIVE_PAIR);
  if (!parsed.ok) {
    process.stderr.write(`live-pair: ${parsed.reason}\n`);
    process.exit(2);
  }
  const missing = parsed.pairs.flat().filter((id) => !PROVIDERS.includes(id));
  if (missing.length > 0) {
    process.stderr.write(`live-pair: missing provider plug-in(s): ${[...new Set(missing)].join(", ")}\n`);
    process.exit(2);
  }
  const timeoutMs = Number(process.env.SWITCHBOARD_LIVE_TIMEOUT_MS ?? 600_000);
  const keep = process.env.SWITCHBOARD_LIVE_KEEP === "1";
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // T8.9 (NFR-MAINT-05): the live-test budget guard runs before dist/ is loaded and before any provider process.
  const runs = {};
  for (const id of parsed.pairs.flat()) runs[id] = (runs[id] ?? 0) + 1;
  const budget = admitLiveRun({ script: "live-pair", runs, repoRoot: ROOT });
  if (budget.configured && !budget.allowed) {
    process.stderr.write(`live-pair: REFUSED by the live-test budget: ${budget.reason}\n`);
    process.exit(EXIT_REFUSED);
  }
  const models = budget.configured ? budget.models : {};
  if (budget.configured) {
    const named = Object.entries(models).map(([id, m]) => `${id} ${m}`);
    process.stderr.write(`live-pair: admitted by the live-test budget; models ${named.join(", ")}\n`);
  }
  const pairRequest = (id) =>
    withBudgetModel(
      { runId: "run_pair", objective: "x", constraints: [], workspace: { cwd: ROOT, writable: true } },
      models[id],
    );
  const fixtures = [];
  for (const id of Object.keys(runs)) {
    const p = (await import(pathToFileURL(path.join(PLUGIN_DIR, `${id}.mjs`)).href)).default;
    if (p.fixture === true) fixtures.push([id, p]);
  }
  if (fixtures.length > 0) {
    // A fixture plug-in stops the run here: it receives the compile request runPair audits, and nothing is spawned.
    for (const [id, p] of fixtures) p.createAdapter(undefined).compile(pairRequest(id), undefined);
    process.stdout.write(
      `live-pair: fixture plug-in ${fixtures.map(([id]) => id).join(", ")} stopped after the budget guard\n`,
    );
    process.exit(0);
  }
  const BIN = path.join(ROOT, "dist", "cli", "bin.js");
  if (!existsSync(BIN)) {
    process.stderr.write("live-pair: dist/ is missing; run `npm run build` (npm run test:live:pair does this)\n");
    process.exit(2);
  }
  const dist = (p) => import(pathToFileURL(path.join(ROOT, "dist", p)).href);
  const adapters = await dist("adapters/index.js");
  const { resolveProfile } = await dist("policy/index.js");
  const { PROBE_ENV_ALLOWLIST } = await dist("cli/io.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { default: Database } = await import("better-sqlite3");

  const out = (s = "") => process.stdout.write(`${s}\n`);
  const results = [];
  for (const [first, second] of parsed.pairs) {
    results.push(await runPair(first, second));
  }

  /** One direction: `first` takes the task, `second` continues it. Returns the report object. */
  async function runPair(first, second) {
    const label = `${first} -> ${second}`;
    const checks = [];
    const record = (id, assumption, result, evidence) => checks.push({ id, assumption, result, evidence });
    out(`\nSwitchboard live pair: ${label}`);
    out("=".repeat(60));
    const plugins = {};
    const ready = {};
    for (const id of [first, second]) {
      plugins[id] = (await import(pathToFileURL(path.join(PLUGIN_DIR, `${id}.mjs`)).href)).default;
      const adapter = plugins[id].createAdapter(adapters);
      const runner = adapters.createProbeRunner(PROBE_ENV_ALLOWLIST);
      const probe = await adapter.probe(runner);
      const gate = new adapters.AdapterRegistry().register(adapter).gate(id, probe.binaryVersion);
      const auth = probe.steps.every((s) => s.ok) ? await adapter.authPreflight(runner) : { state: "UNKNOWN" };
      const compiled = adapter.compile(pairRequest(id), resolveProfile("edit-untrusted"));
      const bypass = adapters.isIneligible(compiled) ? [] : adapters.auditInvocation(compiled);
      out(
        `${id}: version ${probe.binaryVersion ?? "(none)"}, gate ${gate.eligible ? "eligible" : gate.code}, auth ${auth.state}, bypass flags ${bypass.length === 0 ? "none" : `FOUND ${bypass.join(", ")}`}`,
      );
      if (bypass.length > 0) process.exit(1);
      ready[id] = gate.eligible && auth.state === "OK";
    }
    if (!ready[first] || !ready[second]) {
      record(
        "P-0",
        "both providers are installed, inside their validated range and logged in",
        "NOT_CHECKED",
        `${first}: ${ready[first] ? "ready" : "not ready"}; ${second}: ${ready[second] ? "ready" : "not ready"}`,
      );
      return report(label, checks, {});
    }
    record(
      "P-0",
      "both providers are installed, inside their validated range and logged in",
      "HELD",
      "probe, gate and auth",
    );

    const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "switchboard-pair-")));
    const repo = path.join(tmp, "repo");
    const dataDir = path.join(tmp, "data");
    mkdirSync(repo);
    const gitEnv = {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Switchboard Pair",
      GIT_AUTHOR_EMAIL: "pair@example.invalid",
      GIT_COMMITTER_NAME: "Switchboard Pair",
      GIT_COMMITTER_EMAIL: "pair@example.invalid",
    };
    const git = (...args) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, env: gitEnv, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "# Throwaway repository for the Switchboard live pair test\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const configPath = path.join(tmp, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        data_dir: dataDir,
        allowed_roots: [tmp],
        mcp_clients: [{ id: "live-pair", max_trust_profile: "edit-untrusted" }],
        ...(budget.configured
          ? { providers: Object.fromEntries([first, second].map((id) => [id, modelHandoff(models[id]).provider])) }
          : {}),
      }),
    );
    out(`temp directory: ${tmp}${keep ? " (kept)" : " (removed at the end; SWITCHBOARD_LIVE_KEEP=1 keeps it)"}`);

    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith("SWITCHBOARD_")),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, "serve", "--client", "live-pair", "--config", configPath],
      env: childEnv,
      stderr: "pipe",
    });
    let serveLog = "";
    transport.stderr?.on("data", (d) => {
      serveLog += d.toString();
    });
    const client = new Client({ name: "switchboard-live-pair", version: "0.0.0" });
    await client.connect(transport);
    const call = async (name, args = {}) => {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
      return { isError: res.isError === true, body: JSON.parse(res.content?.[0]?.text ?? "{}") };
    };
    const terminal = (s) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(s);
    const wait = async (first_) => {
      let final = first_;
      const end = Date.now() + timeoutMs;
      while (!terminal(final.status) && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 2000));
        final = (await call("get_run", { run_id: first_.run_id })).body;
        out(`  get_run: ${final.status}`);
      }
      if (!terminal(final.status)) {
        out(`timed out after ${timeoutMs} ms; cancelling`);
        await call("cancel_run", { run_id: first_.run_id });
        final = (await call("get_run", { run_id: first_.run_id })).body;
      }
      return final;
    };
    const describe = (f) => `${f.status ?? f.error?.code ?? "no run"}${f.failure_code ? ` ${f.failure_code}` : ""}`;

    const evidence = { first, second };
    let metaSessionId;
    try {
      // 1. The first provider takes the task.
      const d = await call("delegate_task", {
        objective:
          "Create a new file named PAIR-A.md in the repository root containing exactly one line: switchboard pair a. " +
          "Do not modify, create or delete any other file.",
        workspace_path: repo,
        trust_profile: "edit-untrusted",
        routing: { provider_preference: first, require_provider: true, ...modelHandoff(models[first]).routing },
        idempotency_key: `live-pair-${first}-${Date.now()}`,
      });
      if (d.isError) {
        record(
          "P-1",
          `delegate_task to ${first} is admitted and the run succeeds`,
          "FAILED",
          `refused ${d.body.error?.code}: ${d.body.error?.message}`,
        );
        return await finish();
      }
      metaSessionId = d.body.meta_session_id;
      const doneA = await wait(d.body);
      evidence.first_run = { id: d.body.run_id, status: doneA.status, failure_code: doneA.failure_code ?? null };
      record(
        "P-1",
        `delegate_task to ${first} is admitted and the run succeeds`,
        doneA.status === "SUCCEEDED" ? "HELD" : "FAILED",
        describe(doneA),
      );
      if (doneA.status !== "SUCCEEDED") return await finish();

      // 2. The same meta-session continues on the second provider: a handoff from the bundle.
      const c = await call("continue_task", {
        meta_session_id: metaSessionId,
        instruction:
          "Create a new file named PAIR-B.md in the repository root containing exactly one line: switchboard pair b. " +
          "Do not modify, create or delete any other file.",
        routing: { provider_preference: second, require_provider: true, ...modelHandoff(models[second]).routing },
      });
      if (c.isError) {
        record(
          "P-2",
          `continue_task naming ${second} is admitted as a handoff`,
          "FAILED",
          `refused ${c.body.error?.code}: ${c.body.error?.message}`,
        );
        return await finish();
      }
      const doneB = await wait(c.body);
      evidence.second_run = { id: c.body.run_id, status: doneB.status, failure_code: doneB.failure_code ?? null };
      const reason0 = doneB.route?.reasons?.[0] ?? "";
      record(
        "P-2",
        `continue_task naming ${second} is admitted as a handoff from ${first}`,
        reason0.includes("handoff") && reason0.includes(second) ? "HELD" : "FAILED",
        reason0.replace(/[^\w ():;.,>-]/g, "").slice(0, 160) || "no route reason",
      );
      record(
        "P-3",
        `the run on ${second} succeeds from the bundle`,
        doneB.status === "SUCCEEDED" ? "HELD" : "FAILED",
        describe(doneB),
      );
      const view = doneB.artifacts?.handoff_view;
      record(
        "P-4",
        "the handoff run's envelope names a handoff_view artifact",
        view ? "HELD" : "FAILED",
        view ?? "none",
      );
      const listed = view ? await call("get_artifacts", { run_id: c.body.run_id, kinds: ["handoff_view"] }) : undefined;
      const art = listed?.body?.artifacts?.[0];
      evidence.bundle = art ? { artifact_id: art.artifact_id, sha256: art.sha256, size_bytes: art.size_bytes } : null;
      record(
        "P-5",
        "get_artifacts returns the handoff_view with a SHA-256",
        art?.sha256 ? "HELD" : "FAILED",
        art?.sha256 ? `${art.artifact_id} ${art.sha256}` : "none",
      );
      return await finish();
    } finally {
      await client.close().catch(() => {});
    }

    /** Ledger evidence (rows only), result-branch content, then the per-pair report. */
    async function finish() {
      await client.close().catch(() => {});
      for (let i = 0; i < 100 && existsSync(path.join(dataDir, "serve.lock")); i++)
        await new Promise((r) => setTimeout(r, 100));
      if (metaSessionId && existsSync(path.join(dataDir, "ledger.sqlite"))) {
        const db = new Database(path.join(dataDir, "ledger.sqlite"), { readonly: true });
        const rows = db
          .prepare(
            "SELECT provider, harness, backing_provider, model FROM provider_binding WHERE meta_session_id = ? ORDER BY created_at, rowid",
          )
          .all(metaSessionId);
        db.close();
        evidence.bindings = rows;
        const providers = rows.map((r) => r.provider);
        record(
          "P-6",
          `the meta-session has one binding per provider, ${first} first and ${second} second`,
          evidence.second_run?.status === "SUCCEEDED"
            ? providers.length === 2 && providers[0] === first && providers[1] === second
              ? "HELD"
              : "FAILED"
            : "NOT_CHECKED",
          `bindings: ${providers.join(", ") || "none"}`,
        );
      }
      let contentB;
      try {
        const branch = git("for-each-ref", "--format=%(refname:short)", "refs/heads/switchboard/")
          .split("\n")
          .filter(Boolean)
          .at(-1);
        if (branch) contentB = git("show", `${branch}:PAIR-B.md`);
      } catch {
        contentB = undefined;
      }
      if (evidence.second_run?.status === "SUCCEEDED") {
        record(
          "P-7",
          `PAIR-B.md written by ${second} is on the newest result branch`,
          contentB?.trim() === "switchboard pair b" ? "HELD" : "FAILED",
          contentB === undefined ? "missing" : "present",
        );
      }
      const summary = path.join(tmp, "live-pair-summary.json");
      writeFileSync(summary, `${JSON.stringify({ pair: label, evidence, checks }, null, 2)}\n`);
      if (keep) {
        writeFileSync(path.join(tmp, "serve.log"), serveLog);
        out(`kept: ${summary}, ${path.join(tmp, "serve.log")}, ledger and artifacts under ${dataDir}`);
      } else {
        rmSync(tmp, { recursive: true, force: true });
      }
      return report(label, checks, evidence);
    }
  }

  function report(label, checks, evidence) {
    out(`\nChecks for ${label} (ROADMAP T5.11, FR-SES-03, FR-SES-04):`);
    for (const c of checks) out(`  [${c.result.padEnd(11)}] ${c.id} ${c.assumption} -- ${c.evidence}`);
    if (evidence.bundle) out(`  bundle: ${evidence.bundle.artifact_id} sha256 ${evidence.bundle.sha256}`);
    return { label, checks, evidence };
  }

  const failed = results.flatMap((r) => r.checks).filter((c) => c.result === "FAILED");
  const notChecked = results.flatMap((r) => r.checks).filter((c) => c.result === "NOT_CHECKED");
  const held = results.flatMap((r) => r.checks).filter((c) => c.result === "HELD");
  out(`\n${held.length} held, ${failed.length} failed, ${notChecked.length} not checked.`);
  out(
    "Record the outcome in ROADMAP T5.12, TDD §4.1 and §4.2 and the T5.0 table (PASS, FAIL or NOT_CHECKED per check).",
  );
  process.exit(failed.length === 0 && notChecked.length === 0 && held.length > 0 ? 0 : 1);
}
