#!/usr/bin/env node
/**
 * Opt-in live smoke test (T2.6; TDD §3.6 "Live provider smoke"; ROADMAP R-21, R-22, Q-13). Runs ONE trivial edit task
 * through the real `switchboard serve` MCP server against the operator's own installed and logged-in provider CLI, in
 * a throwaway Git repository under a temp directory, then reports which adapter Assumptions held.
 *
 *   SWITCHBOARD_LIVE_TESTS=1 SWITCHBOARD_LIVE_PROVIDER=claude npm run test:live
 *
 * Skipped (exit 0, nothing run) unless SWITCHBOARD_LIVE_TESTS=1. `npm test` and CI never run it. Optional:
 *   SWITCHBOARD_LIVE_PROVIDER    claude | codex (required when enabled)
 *   SWITCHBOARD_LIVE_TIMEOUT_MS  how long to wait for the run (default 600000)
 *   SWITCHBOARD_LIVE_KEEP=1      keep the temp directory (ledger, artifacts, serve log) for inspection
 *
 * Safety: the script never reads, copies or prints credential files, tokens or keys. It runs the provider's own status
 * command and prints only its exit code, whether the output parsed, and the NAMES of its top-level JSON keys (never
 * values, which may name the account). Provider output is analysed for event types only; no prompt, message or
 * reasoning text is printed. No bypass flag is ever passed (the compiled flags are printed and audited). The task runs
 * under `edit-untrusted` in a fresh repository that contains only a README.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.env.SWITCHBOARD_LIVE_TESTS !== "1") {
  process.stdout.write(
    "live-smoke: SKIPPED (opt-in). Set SWITCHBOARD_LIVE_TESTS=1 and SWITCHBOARD_LIVE_PROVIDER=claude|codex to run it.\n",
  );
  process.exit(0);
}

const PROVIDERS = ["claude", "codex"];
const provider = process.env.SWITCHBOARD_LIVE_PROVIDER ?? "";
if (!PROVIDERS.includes(provider)) {
  process.stderr.write(`live-smoke: SWITCHBOARD_LIVE_PROVIDER must be one of ${PROVIDERS.join(", ")}\n`);
  process.exit(2);
}
const timeoutMs = Number(process.env.SWITCHBOARD_LIVE_TIMEOUT_MS ?? 600_000);
const keep = process.env.SWITCHBOARD_LIVE_KEEP === "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const BIN = path.join(DIST, "cli", "bin.js");
if (!existsSync(BIN)) {
  process.stderr.write("live-smoke: dist/ is missing; run `npm run build` (npm run test:live does this)\n");
  process.exit(2);
}
const dist = (p) => import(pathToFileURL(path.join(DIST, p)).href);
const adapters = await dist("adapters/index.js");
const { resolveProfile } = await dist("policy/index.js");
const { PROBE_ENV_ALLOWLIST } = await dist("cli/io.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const { default: Database } = await import("better-sqlite3");

const out = (s = "") => process.stdout.write(`${s}\n`);
/** @type {{id: string, group: string, assumption: string, result: "HELD"|"FAILED"|"NOT_CHECKED", evidence: string}[]} */
const checks = [];
const record = (id, group, assumption, result, evidence) => checks.push({ id, group, assumption, result, evidence });
const held = (ok) => (ok === undefined ? "NOT_CHECKED" : ok ? "HELD" : "FAILED");

const GROUP = provider === "claude" ? "R-21" : "R-22";
const runner = adapters.createProbeRunner(PROBE_ENV_ALLOWLIST);
const adapter = provider === "claude" ? new adapters.ClaudeAdapter() : new adapters.CodexAdapter();
const registry = new adapters.AdapterRegistry().register(adapter);

out(`Switchboard live smoke test: provider ${provider}`);
out("=".repeat(60));

// ---- 1. probe, version gate, auth (no model call) ----------------------------------------------------------------

const probe = await adapter.probe(runner);
const step = (name) => probe.steps.find((s) => s.step === name);
out(`binary: ${probe.binaryPath}  version: ${probe.binaryVersion ?? "(none)"}`);
for (const s of probe.steps) out(`  probe ${s.step}: ${s.ok ? "ok" : "FAILED"}${s.detail ? ` (${s.detail})` : ""}`);
const gate = registry.gate(provider, probe.binaryVersion);
out(`version gate: ${gate.eligible ? "eligible" : `${gate.code}: ${gate.detail}`}`);
const binaryOk = step("binary")?.ok === true;

if (provider === "claude") {
  record(
    "C-1",
    GROUP,
    "`claude --version` prints `<semver> (Claude Code)`",
    held(binaryOk ? step("version")?.ok : undefined),
    probe.binaryVersion ?? "no version",
  );
  record(
    "C-2",
    GROUP,
    "`claude --help` lists every flag the adapter emits (--safe-mode, --restricted, --disallowedTools, ...)",
    held(binaryOk ? step("flags")?.ok && step("output_format")?.ok : undefined),
    binaryOk ? (step("flags")?.detail ?? "all present") : "binary not found",
  );
} else {
  record(
    "X-1",
    GROUP,
    "`codex --version` prints a parseable version line",
    held(binaryOk ? step("version")?.ok : undefined),
    probe.binaryVersion ?? "no version",
  );
  record(
    "X-2",
    GROUP,
    "`codex exec --help` lists --json, --sandbox and the ignore-config/rules flags",
    held(binaryOk ? step("flags")?.ok && step("output_format")?.ok : undefined),
    binaryOk ? (step("flags")?.detail ?? "all present") : "binary not found",
  );
  if (binaryOk) {
    const help = await runner([probe.binaryPath, "exec", "--help"]);
    const text = help.exitCode === 0 ? help.stdout : "";
    record(
      "X-3",
      GROUP,
      "the sandbox values are spelled `read-only` and `workspace-write`",
      held(text ? text.includes("read-only") && text.includes("workspace-write") : undefined),
      text ? "searched `codex exec --help`" : "help unavailable",
    );
  } else {
    record(
      "X-3",
      GROUP,
      "the sandbox values are spelled `read-only` and `workspace-write`",
      "NOT_CHECKED",
      "binary not found",
    );
  }
}
record(
  `${provider === "claude" ? "C" : "X"}-V`,
  "Q-12/T2.1",
  "the installed version is inside the manifest's validated range",
  held(binaryOk ? gate.eligible : undefined),
  gate.eligible ? `${probe.binaryVersion} in ${gate.evidence.validatedRange}` : gate.detail,
);

if (provider === "claude" && binaryOk) {
  // Status command shape only: exit code, parse, key NAMES. Values are never printed.
  const r = await runner([probe.binaryPath, "auth", "status", "--json"]);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = undefined;
  }
  const isObj = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  const keys = isObj ? Object.keys(parsed).sort() : [];
  out(`auth status: exit ${r.exitCode}, JSON ${isObj ? "object" : "not parseable"}, keys [${keys.join(", ")}]`);
  record("C-3", GROUP, "`claude auth status --json` prints a JSON object", held(isObj), `exit ${r.exitCode}`);
  record(
    "C-4",
    GROUP,
    "the status JSON has a boolean `loggedIn` field consistent with the exit code (0 = logged in)",
    held(isObj ? typeof parsed.loggedIn === "boolean" && (parsed.loggedIn === true) === (r.exitCode === 0) : undefined),
    isObj ? `loggedIn is ${typeof parsed.loggedIn}` : "no JSON",
  );
  const auth = await adapter.authPreflight(runner);
  out(
    `auth preflight (PATH and HOME only): ${auth.state}${auth.state === "AUTH_REQUIRED" ? ` -> run \`${auth.loginCommand}\` yourself` : ""}`,
  );
  record(
    "C-5",
    GROUP,
    "the status command works with only PATH and HOME in its environment",
    held(auth.state === "OK" ? true : auth.state === "UNKNOWN" ? false : undefined),
    auth.state,
  );
} else if (provider === "codex") {
  out(
    "auth status: Codex documents no status command (Q-10); the adapter reports UNKNOWN, so routing is expected to refuse it",
  );
  record(
    "X-4",
    "Q-10",
    "a Codex auth status mechanism exists that the adapter can use",
    "NOT_CHECKED",
    "no documented command; adapter returns UNKNOWN (fail closed)",
  );
}

// Flags the daemon will pass (from the same compile the daemon runs), audited for bypass flags.
const compiled = adapter.compile(
  { runId: "run_smoke", objective: "x", constraints: [], workspace: { cwd: ROOT, writable: true } },
  resolveProfile("edit-untrusted"),
);
if (adapters.isIneligible(compiled)) out(`compile (edit-untrusted): ineligible ${compiled.reason}: ${compiled.detail}`);
else {
  out(`compile (edit-untrusted) policy flags: ${compiled.policyFlags.join(" ")}`);
  const bypass = adapters.auditInvocation(compiled);
  out(`bypass-flag audit: ${bypass.length === 0 ? "none" : `FOUND ${bypass.join(", ")}`}`);
  if (bypass.length > 0) process.exit(1);
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
      mcp_clients: [{ id: "live-smoke", max_trust_profile: "edit-untrusted" }],
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
const cap = caps.body.providers?.find((p) => p.provider === provider);
out(
  `list_capabilities: ${cap ? `${cap.adapter_status}, auth ${cap.auth_state}, profiles [${cap.supported_profiles.join(", ")}]` : JSON.stringify(caps.body).slice(0, 300)}`,
);

const objective =
  "Create a new file named SMOKE.md in the repository root containing exactly one line: switchboard live smoke ok. " +
  "Do not modify, create or delete any other file.";
const delegated = await call("delegate_task", {
  objective,
  workspace_path: repo,
  trust_profile: "edit-untrusted",
  routing: { provider_preference: provider, require_provider: true },
  idempotency_key: `live-smoke-${Date.now()}`,
});
let final = delegated.body;
if (delegated.isError) {
  out(`delegate_task refused: ${final.error?.code}: ${final.error?.message}`);
} else {
  const runId = final.run_id;
  out(`delegate_task: run ${runId} ${final.status}`);
  const end = Date.now() + timeoutMs;
  while (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(final.status) && Date.now() < end) {
    final = (await call("get_run", { run_id: runId, wait_seconds: 30 })).body;
    out(`  get_run: ${final.status}`);
  }
  if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(final.status)) {
    out(`timed out after ${timeoutMs} ms; cancelling`);
    await call("cancel_run", { run_id: runId });
    final = (await call("get_run", { run_id: runId, wait_seconds: 30 })).body;
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
      if (provider === "claude") {
        if (doc?.type === "system" && doc.subtype === "init")
          shapes.initWithSession = typeof doc.session_id === "string";
        if ((doc?.type === "assistant" || doc?.type === "user") && shapes.contentBlocks !== false) {
          shapes.contentBlocks = Array.isArray(doc.message?.content);
        }
        if (doc?.type === "result") {
          shapes.resultFields = ["subtype", "is_error", "session_id", "usage"].every((k) => k in doc);
        }
      } else {
        if (doc?.type === "thread.started") shapes.threadStarted = typeof doc.thread_id === "string";
        if (doc?.type === "turn.completed") shapes.turnCompleted = typeof doc.usage === "object" && doc.usage !== null;
      }
      for (const ev of adapter.parseEvent(line, state)) {
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
if (provider === "claude") {
  record(
    "C-6",
    GROUP,
    "`-p` reads the prompt from stdin and `--verbose` is accepted with stream-json",
    held(ran ? succeeded : undefined),
    ran ? final.status : "provider never ran",
  );
  record(
    "C-7",
    GROUP,
    "stream starts with `system`/`init` carrying `session_id`",
    held(ran ? shapes.initWithSession === true : undefined),
    String(shapes.initWithSession ?? "no init event"),
  );
  record(
    "C-8",
    GROUP,
    "`assistant`/`user` events carry `message.content[]` blocks",
    held(ran ? shapes.contentBlocks === true : undefined),
    String(shapes.contentBlocks ?? "no such events"),
  );
  record(
    "C-9",
    GROUP,
    "the `result` event has `subtype`, `is_error`, `session_id` and `usage`",
    held(ran ? shapes.resultFields === true : undefined),
    String(shapes.resultFields ?? "no result event"),
  );
  record(
    "C-10",
    GROUP,
    "every event type in a successful run is recognised (no `unknown` events)",
    held(ran ? unknownEvents === 0 && badJson === 0 : undefined),
    `${unknownEvents} unknown, ${badJson} non-JSON`,
  );
  record(
    "C-11",
    GROUP,
    "the file-creating tool is named `Write` (or `Edit`) and is allowed by --tools",
    held(ran ? smokeContent !== undefined && (toolNames.has("Write") || toolNames.has("Edit")) : undefined),
    [...toolNames].join(", ") || "no tool calls",
  );
  record(
    "C-12",
    GROUP,
    "error category strings (rate_limit, overloaded, authentication_failed, ...)",
    "NOT_CHECKED",
    "needs a failing run; not provoked by this smoke test",
  );
} else {
  record(
    "X-5",
    GROUP,
    "`codex exec --json` reads the prompt from stdin",
    held(ran ? succeeded : undefined),
    ran ? final.status : "provider never ran",
  );
  record(
    "X-6",
    GROUP,
    "the stream has `thread.started` with `thread_id`",
    held(ran ? shapes.threadStarted === true : undefined),
    String(shapes.threadStarted ?? "no such event"),
  );
  record(
    "X-7",
    GROUP,
    "`turn.completed` carries `usage`",
    held(ran ? shapes.turnCompleted === true : undefined),
    String(shapes.turnCompleted ?? "no such event"),
  );
  record(
    "X-8",
    GROUP,
    "every event and item type in a successful run is recognised (no `unknown` events)",
    held(ran ? unknownEvents === 0 && badJson === 0 : undefined),
    `${unknownEvents} unknown, ${badJson} non-JSON`,
  );
  record(
    "X-9",
    GROUP,
    "error `code` strings and the `declined` item status",
    "NOT_CHECKED",
    "needs a failing run; not provoked by this smoke test",
  );
}
record(
  "G-1",
  "FR-GIT-01",
  "after a benign run no ref other than the controller's changed and no commit was made by the agent",
  held(gitRefsOk),
  gitRefsEvidence,
);
if (provider === "claude") {
  record(
    "C-G2",
    "FR-GIT-01",
    "`--disallowedTools` Git deny rules (`Bash(git commit *)`, ...) are accepted with no Bash in --tools and deny a Git write",
    "NOT_CHECKED",
    "acceptance is covered by C-6 (the run starts); denial needs a deliberate Git write attempt, which this smoke test never makes (malicious fixtures: T9.5). " +
      'Depends on bypass: an approved privileged run with `bypass: true` adds --dangerously-skip-permissions (`claude --help`: "Bypass all permission checks") and keeps these deny rules; ' +
      "whether Claude still honours deny rules under that flag is an Assumption, unverified (R-26, TDD §4.1.1; live check T3.9), and this smoke test never runs a bypass invocation",
  );
} else {
  record(
    "X-G1",
    "FR-GIT-01",
    "the workspace-write sandbox blocks writes to the worktree's Git directory (outside the cwd, under .git/worktrees/)",
    "NOT_CHECKED",
    "needs a deliberate `git commit` attempt inside the sandbox, which this smoke test never makes (malicious fixtures: T9.5)",
  );
}
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
