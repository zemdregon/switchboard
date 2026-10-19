#!/usr/bin/env node
/**
 * Opt-in live smoke test (T2.6; TDD §3.6 "Live provider smoke"; ROADMAP R-21, R-22, Q-13). Runs ONE trivial edit task
 * through the real `switchboard serve` MCP server against the operator's own installed and logged-in provider CLI, in
 * a throwaway Git repository under a temp directory, then reports which adapter Assumptions held.
 *
 *   SWITCHBOARD_LIVE_TESTS=1 SWITCHBOARD_LIVE_PROVIDER=claude npm run test:live
 *
 * Skipped (exit 0, nothing run) unless SWITCHBOARD_LIVE_TESTS=1. `npm test` and CI never run it. Optional:
 *   SWITCHBOARD_LIVE_PROVIDER    a provider plug-in id: agy | claude | codex | cursor | grok | kimi | opencode (any
 *                                scripts/live/providers/<id>.mjs; required when enabled)
 *   SWITCHBOARD_LIVE_TIMEOUT_MS  how long to wait for the run (default 600000)
 *   SWITCHBOARD_LIVE_KEEP=1      keep the temp directory (ledger, artifacts, serve log) for inspection
 *   SWITCHBOARD_LIVE_MODEL       ask for this model (the budget file's model replaces it when the file is set)
 *   SWITCHBOARD_LIVE_BUDGET_FILE, SWITCHBOARD_LIVE_PURPOSE  the live-test budget guard (T8.9; scripts/live/budget.mjs):
 *                                caps, minimum gap, purpose allowlist and model per provider; exit 75 on refusal
 *
 * Safety: the script never reads, copies or prints credential files, tokens or keys. It runs the provider's own status
 * command and prints only its exit code, whether the output parsed, and the NAMES of its top-level JSON keys (never
 * values, which may name the account). Provider output is analysed for event types only; no prompt, message or
 * reasoning text is printed. The task runs under `edit-untrusted` in a fresh repository that contains only a README,
 * and no bypass flag is ever passed (the compiled flags are printed and audited). A plug-in with a `smokeCell`
 * (`scripts/live/plugin-kit.mjs`: Antigravity, OpenCode, Cursor, Kimi Code, Grok Build, which compile only an approved
 * `privileged` cell, owner decisions 46, 59 and 60) runs the same task in that cell instead: the delegation carries the
 * cell's scope, parks in AWAITING_APPROVAL and is approved through the operator `approve` CLI (no MCP tool can
 * approve, FR-MCP-06); the audit then requires exactly the cell's one bypass-class flag (none for OpenCode and the
 * Kimi ACP cell), as `adapters validate` does.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { admitLiveRun, EXIT_REFUSED, modelHandoff, withBudgetModel } from "./live/budget.mjs";

// Provider plug-ins (T4.3): one scripts/live/providers/<id>.mjs per provider; the contract is in those files.
const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "live", "providers");
const PROVIDERS = readdirSync(PLUGIN_DIR)
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => f.slice(0, -".mjs".length))
  .sort();
// Fixture plug-ins (`fake`, T8.9) are selectable but not advertised, so the messages read as before.
const LISTED = PROVIDERS.filter((id) => !id.startsWith("fake"));

if (process.env.SWITCHBOARD_LIVE_TESTS !== "1") {
  process.stdout.write(
    `live-smoke: SKIPPED (opt-in). Set SWITCHBOARD_LIVE_TESTS=1 and SWITCHBOARD_LIVE_PROVIDER=${LISTED.join("|")} to run it.\n`,
  );
  process.exit(0);
}

const provider = process.env.SWITCHBOARD_LIVE_PROVIDER ?? "";
if (!PROVIDERS.includes(provider)) {
  process.stderr.write(`live-smoke: SWITCHBOARD_LIVE_PROVIDER must be one of ${LISTED.join(", ")}\n`);
  process.exit(2);
}
const plugin = (await import(pathToFileURL(path.join(PLUGIN_DIR, `${provider}.mjs`)).href)).default;
/** The adapter id behind the plug-in (`agy` -> `antigravity`); routing, the version gate and capabilities use it. */
const adapterId = plugin.adapterId ?? provider;
/** Plug-ins whose adapter compiles only an approved `privileged` cell name it here (`scripts/live/plugin-kit.mjs`). */
const cell = plugin.smokeCell;
/** Placeholder approval id for the in-script compile below; it names no approval row (nothing is persisted). */
const SMOKE_APPROVAL_ID = "apv_0000000000000000000000SMKE";
const timeoutMs = Number(process.env.SWITCHBOARD_LIVE_TIMEOUT_MS ?? 600_000);
const keep = process.env.SWITCHBOARD_LIVE_KEEP === "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// T8.9 (NFR-MAINT-05): the live-test budget guard runs before dist/ is loaded and before any provider process.
const budget = admitLiveRun({ script: "live-smoke", runs: { [provider]: 1 }, repoRoot: ROOT });
if (budget.configured && !budget.allowed) {
  process.stderr.write(`live-smoke: REFUSED by the live-test budget: ${budget.reason}\n`);
  process.exit(EXIT_REFUSED);
}
const model = budget.configured ? budget.models[provider] : process.env.SWITCHBOARD_LIVE_MODEL || undefined;
if (budget.configured) process.stderr.write(`live-smoke: admitted by the live-test budget; model ${model}\n`);
const handoff = modelHandoff(model);
const smokeRequest = withBudgetModel(
  { runId: "run_smoke", objective: "x", constraints: [], workspace: { cwd: ROOT, writable: true } },
  model,
);
if (plugin.fixture === true) {
  // A fixture plug-in stops here: it receives the compile request the flow below audits, and nothing is spawned.
  plugin.createAdapter(undefined).compile(smokeRequest, undefined);
  process.stdout.write(`live-smoke: fixture plug-in ${provider} stopped after the budget guard\n`);
  process.exit(0);
}
const DIST = path.join(ROOT, "dist");
const BIN = path.join(DIST, "cli", "bin.js");
if (!existsSync(BIN)) {
  process.stderr.write("live-smoke: dist/ is missing; run `npm run build` (npm run test:live does this)\n");
  process.exit(2);
}
const dist = (p) => import(pathToFileURL(path.join(DIST, p)).href);
const adapters = await dist("adapters/index.js");
const { privilegedScopeHash, resolveProfile, resolveTrustProfile } = await dist("policy/index.js");
const { PROBE_ENV_ALLOWLIST } = await dist("cli/io.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const { default: Database } = await import("better-sqlite3");

const out = (s = "") => process.stdout.write(`${s}\n`);
/** @type {{id: string, group: string, assumption: string, result: "HELD"|"FAILED"|"NOT_CHECKED", evidence: string}[]} */
const checks = [];
const record = (id, group, assumption, result, evidence) => checks.push({ id, group, assumption, result, evidence });
const held = (ok) => (ok === undefined ? "NOT_CHECKED" : ok ? "HELD" : "FAILED");

const GROUP = plugin.group;
const runner = adapters.createProbeRunner(PROBE_ENV_ALLOWLIST);
const adapter = plugin.createAdapter(adapters);
const registry = new adapters.AdapterRegistry().register(adapter);

out(`Switchboard live smoke test: provider ${provider}`);
out("=".repeat(60));

// ---- 1. probe, version gate, auth (no model call) ----------------------------------------------------------------

const probe = await adapter.probe(runner);
const step = (name) => probe.steps.find((s) => s.step === name);
out(`binary: ${probe.binaryPath}  version: ${probe.binaryVersion ?? "(none)"}`);
for (const s of probe.steps) out(`  probe ${s.step}: ${s.ok ? "ok" : "FAILED"}${s.detail ? ` (${s.detail})` : ""}`);
const gate = registry.gate(adapterId, probe.binaryVersion);
out(`version gate: ${gate.eligible ? "eligible" : `${gate.code}: ${gate.detail}`}`);
const binaryOk = step("binary")?.ok === true;

await plugin.probeChecks({ record, held, step, probe, binaryOk, runner, group: GROUP });
record(
  `${plugin.checkPrefix}-V`,
  "Q-12/T2.1",
  "the installed version is inside the manifest's validated range",
  held(binaryOk ? gate.eligible : undefined),
  gate.eligible ? `${probe.binaryVersion} in ${gate.evidence.validatedRange}` : gate.detail,
);

await plugin.authChecks({ record, held, probe, binaryOk, runner, adapter, out, group: GROUP });

// Flags the daemon will pass (from the same compile the daemon runs), audited for bypass flags. In an approved cell
// the audit requires exactly the cell's one bypass-class flag (none when it declares none), as `adapters validate`.
const smokeProfile = cell
  ? resolveTrustProfile("privileged", {
      privileged: {
        scope: cell.scope,
        scopeHash: privilegedScopeHash({ clientId: "live-smoke", metaSessionId: "live-smoke", scope: cell.scope }),
        approvalId: SMOKE_APPROVAL_ID,
      },
    })
  : resolveProfile("edit-untrusted");
const profileLabel = cell ? "approved privileged cell" : "edit-untrusted";
const compiled = adapter.compile(
  { ...smokeRequest, ...(cell?.scope.bypass ? { bypassApproved: true } : {}) },
  smokeProfile,
);
if (adapters.isIneligible(compiled))
  out(`compile (${profileLabel}): ineligible ${compiled.reason}: ${compiled.detail}`);
else {
  out(`compile (${profileLabel}) policy flags: ${compiled.policyFlags.join(" ")}`);
  const bypass = cell ? adapters.findBypassFlags(compiled, adapterId) : adapters.auditInvocation(compiled);
  const expected = cell?.bypassFlag ? [cell.bypassFlag] : [];
  out(
    `bypass-flag audit: ${bypass.length === 0 ? "none" : `FOUND ${bypass.join(", ")}`}${cell ? ` (cell declares ${expected.join(", ") || "none"})` : ""}`,
  );
  if (bypass.length !== expected.length || bypass.some((f, i) => f !== expected[i])) process.exit(1);
}
// FR-GIT-01 declaration (also reported by list_capabilities).
out(
  `git write control: ${adapter.gitWriteControl.kind} (remaining: ${adapter.gitWriteControl.remainingControls.join(", ")})`,
);

// ---- 2. one edit task through the real MCP server -------------------------------------------------------------------

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "switchboard-live-")));
const repo = path.join(tmp, "repo");
const dataDir = path.join(tmp, "data");
mkdirSync(repo);
const gitEnv = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Switchboard Smoke",
  GIT_AUTHOR_EMAIL: "smoke@example.invalid",
  GIT_COMMITTER_NAME: "Switchboard Smoke",
  GIT_COMMITTER_EMAIL: "smoke@example.invalid",
};
const git = (...args) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, env: gitEnv, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
writeFileSync(path.join(repo, "README.md"), "# Throwaway repository for the Switchboard live smoke test\n");
git("add", "-A");
git("commit", "-q", "-m", "init");
const initSha = git("rev-parse", "HEAD");
const configPath = path.join(tmp, "config.json");
writeFileSync(
  configPath,
  JSON.stringify(
    {
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [tmp],
      mcp_clients: [{ id: "live-smoke", max_trust_profile: cell ? "privileged" : "edit-untrusted" }],
      // `providers.<id>` takes the config id (`claude-code`, `grok-build`, ...), not the plug-in id.
      ...(handoff.provider
        ? { providers: { [adapters.configIdForAdapterId(adapterId) ?? adapterId]: handoff.provider } }
        : {}),
    },
    null,
    2,
  ),
);
out(`\ntemp directory: ${tmp}${keep ? " (kept)" : " (removed at the end; SWITCHBOARD_LIVE_KEEP=1 keeps it)"}`);

const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith("SWITCHBOARD_")),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [BIN, "serve", "--client", "live-smoke", "--config", configPath],
  env: childEnv,
  stderr: "pipe",
});
let serveLog = "";
transport.stderr?.on("data", (d) => {
  serveLog += d.toString();
});
const client = new Client({ name: "switchboard-live-smoke", version: "0.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  return { isError: res.isError === true, body: JSON.parse(res.content?.[0]?.text ?? "{}") };
};

const caps = await call("list_capabilities");
const cap = caps.body.providers?.find((p) => p.provider === adapterId);
out(
  `list_capabilities: ${cap ? `${cap.adapter_status}, auth ${cap.auth_state}, profiles [${cap.supported_profiles.join(", ")}]` : JSON.stringify(caps.body).slice(0, 300)}`,
);

const objective =
  "Create a new file named SMOKE.md in the repository root containing exactly one line: switchboard live smoke ok. " +
  "Do not modify, create or delete any other file.";
const delegated = await call("delegate_task", {
  objective,
  workspace_path: repo,
  trust_profile: cell ? "privileged" : "edit-untrusted",
  ...(cell ? { privileged_scope: cell.scope } : {}),
  routing: { provider_preference: adapterId, require_provider: true, ...handoff.routing },
  idempotency_key: `live-smoke-${Date.now()}`,
});
let final = delegated.body;
if (delegated.isError) {
  out(`delegate_task refused: ${final.error?.code}: ${final.error?.message}`);
} else {
  const runId = final.run_id;
  out(`delegate_task: run ${runId} ${final.status}`);
  if (cell && final.status === "AWAITING_APPROVAL") {
    // Switchboard's own approval path: the operator CLI decides, no MCP tool can approve (FR-MCP-06).
    try {
      execFileSync(process.execPath, [BIN, "approve", runId, "--config", configPath], {
        env: childEnv,
        encoding: "utf8",
        timeout: 60_000,
      });
      out("approve: approved through the operator CLI");
    } catch (err) {
      out(`approve: refused: ${String(err).slice(0, 160)}`);
    }
    final = (await call("get_run", { run_id: runId })).body;
  }
  const end = Date.now() + timeoutMs;
  while (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(final.status) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 2000));
    final = (await call("get_run", { run_id: runId })).body;
    out(`  get_run: ${final.status}`);
  }
  if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(final.status)) {
    out(`timed out after ${timeoutMs} ms; cancelling`);
    await call("cancel_run", { run_id: runId });
    final = (await call("get_run", { run_id: runId })).body;
  }
  out(
    `result: ${final.status}${final.failure_code ? ` ${final.failure_code}` : ""}${final.failure_detail ? ` (${final.failure_detail})` : ""}`,
  );
  out(
    `provider: ${final.provider?.adapter} ${final.provider?.adapter_version ?? ""}  changed files: ${final.result?.changed_files ?? "n/a"}`,
  );
}
await client.close();
// serve shuts down when stdin closes; give it a moment to release the lock.
for (let i = 0; i < 100 && existsSync(path.join(dataDir, "serve.lock")); i++)
  await new Promise((r) => setTimeout(r, 100));

// ---- 3. evidence from the ledger and the provider stream (types only, no content) -----------------------------------

const runId = final.run_id;
let types = new Map();
let lines = 0;
let badJson = 0;
let unknownEvents = 0;
const kinds = new Map();
const toolNames = new Set();
const shapes = {
  initWithSession: undefined,
  contentBlocks: undefined,
  resultFields: undefined,
  threadStarted: undefined,
  turnCompleted: undefined,
};
if (runId && existsSync(path.join(dataDir, "ledger.sqlite"))) {
  const db = new Database(path.join(dataDir, "ledger.sqlite"), { readonly: true });
  const art = db.prepare("SELECT sha256 FROM artifact WHERE run_id = ? AND kind = 'provider_stdout'").get(runId);
  db.close();
  if (art) {
    const file = path.join(dataDir, "artifacts", art.sha256.slice(0, 2), art.sha256.slice(2, 4), art.sha256);
    const state = adapters.createParseState();
    types = new Map();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      lines += 1;
      let doc;
      try {
        doc = JSON.parse(line);
      } catch {
        badJson += 1;
        continue;
      }
      const t = `${doc?.type ?? "(no type)"}${typeof doc?.subtype === "string" ? `/${doc.subtype}` : ""}`;
      types.set(t, (types.get(t) ?? 0) + 1);
      plugin.observeEvent(doc, shapes);
      for (const ev of plugin.parseLine ? plugin.parseLine(adapter, line, state) : adapter.parseEvent(line, state)) {
        kinds.set(ev.kind, (kinds.get(ev.kind) ?? 0) + 1);
        if (ev.kind === "unknown") unknownEvents += 1;
        if (ev.kind === "tool_call") toolNames.add(ev.name);
      }
    }
  }
}
out(`\nprovider stream: ${lines} lines, ${badJson} not JSON, ${unknownEvents} unrecognised by the adapter`);
out(`  native event types: ${[...types].map(([t, n]) => `${t} x${n}`).join(", ") || "(none)"}`);
out(`  normalized kinds:   ${[...kinds].map(([t, n]) => `${t} x${n}`).join(", ") || "(none)"}`);
out(`  tool names:         ${[...toolNames].join(", ") || "(none)"}`);

let smokeContent;
try {
  const branch = git("for-each-ref", "--format=%(refname:short)", "refs/heads/switchboard/")
    .split("\n")
    .filter(Boolean)
    .at(-1);
  if (branch) smokeContent = git("show", `${branch}:SMOKE.md`);
} catch {
  smokeContent = undefined;
}
out(
  `SMOKE.md on the result branch: ${smokeContent === undefined ? "missing" : JSON.stringify(smokeContent.slice(0, 200))}`,
);

const ran = lines > 0;
const succeeded = final.status === "SUCCEEDED";

// FR-GIT-01, passive: after a benign run, the only refs are `main` (unchanged) and the controller's run branches, and
// every commit on a run branch carries the controller's checkpoint identity. Nothing is attempted against Git here.
let gitRefsOk;
let gitRefsEvidence = "provider never ran";
if (ran) {
  try {
    const refs = git("for-each-ref", "--format=%(refname) %(objectname)").split("\n").filter(Boolean);
    const foreign = refs.filter((l) => {
      const [name, sha] = l.split(" ");
      if (name === "refs/heads/main") return sha !== initSha;
      return !name.startsWith("refs/heads/switchboard/");
    });
    const authors = refs
      .map((l) => l.split(" ")[0])
      .filter((n) => n.startsWith("refs/heads/switchboard/"))
      .flatMap((n) => git("log", "--format=%ae %ce", `refs/heads/main..${n}`).split("\n").filter(Boolean));
    const foreignCommits = authors.filter((a) => a !== "switchboard@localhost switchboard@localhost");
    gitRefsOk = foreign.length === 0 && foreignCommits.length === 0;
    gitRefsEvidence = `${refs.length} refs, ${foreign.length} unexpected, ${foreignCommits.length} non-controller commits`;
  } catch (err) {
    gitRefsOk = false;
    gitRefsEvidence = `git inspection failed: ${String(err).slice(0, 120)}`;
  }
}
plugin.streamChecks({
  record,
  held,
  ran,
  succeeded,
  final,
  shapes,
  kinds,
  unknownEvents,
  badJson,
  toolNames,
  smokeContent,
  group: GROUP,
});
record(
  "G-1",
  "FR-GIT-01",
  "after a benign run no ref other than the controller's changed and no commit was made by the agent",
  held(gitRefsOk),
  gitRefsEvidence,
);
plugin.gitWriteChecks({ record });
record(
  "E2E",
  "T2.6",
  "one edit task completes through `switchboard serve` and the edit lands on the result branch",
  held(succeeded && smokeContent?.trim() === "switchboard live smoke ok"),
  `${final.status ?? final.error?.code ?? "no run"}; SMOKE.md ${smokeContent === undefined ? "missing" : "present"}`,
);

// ---- 4. report -------------------------------------------------------------------------------------------------------

out("\nAssumptions (ROADMAP R-21 / R-22 / Q-13):");
for (const c of checks) out(`  [${c.result.padEnd(11)}] ${c.id} (${c.group}) ${c.assumption} -- ${c.evidence}`);
const failed = checks.filter((c) => c.result === "FAILED");
out(
  `\n${checks.filter((c) => c.result === "HELD").length} held, ${failed.length} failed, ${checks.filter((c) => c.result === "NOT_CHECKED").length} not checked.`,
);
out("Record the outcome in ROADMAP Q-13 and update the fixtures and TDD §4.1/§4.2 where an Assumption failed.");

const summaryPath = path.join(tmp, "live-smoke-summary.json");
writeFileSync(
  summaryPath,
  `${JSON.stringify({ provider, binary_version: probe.binaryVersion, status: final.status ?? null, failure_code: final.failure_code ?? final.error?.code ?? null, native_event_types: Object.fromEntries(types), checks }, null, 2)}\n`,
);
if (keep) {
  writeFileSync(path.join(tmp, "serve.log"), serveLog);
  out(`kept: ${summaryPath}, ${path.join(tmp, "serve.log")}, ledger and artifacts under ${dataDir}`);
} else {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(succeeded && failed.length === 0 ? 0 : 1);
