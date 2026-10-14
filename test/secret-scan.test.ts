/**
 * Secret-pattern scan of everything the controller persists or emits (NFR-SEC-01, FR-TEL-03; ROADMAP §6.1.1).
 *
 * Full runs go through the REAL lifecycle, ledger, artifact store and MCP server (fake adapter, a scripted provider
 * process) and through the real `serve` daemon as a child process. SYNTHETIC canary credentials (random, shaped like
 * the redactor's patterns, never real) are planted in three places:
 *
 *  (a) the controller's own environment, outside the run's environment allowlist (`ANTHROPIC_API_KEY` and others);
 *  (b) the provider's output: tool command line, assistant message, stderr, error text, result summary, a written file;
 *  (c) the prompt (objective) text.
 *
 * Afterwards every surface is scanned: all rows of all ledger tables, every file under the data directory (the raw
 * SQLite file and WAL included, worktrees excluded: those are the provider's own working files, and their content
 * reaches the controller only through the redacted `diff` artifact), MCP responses, CLI `--json` output and the
 * daemon's stderr log. Assertions are on the exact canary values, plus a generic pass of the redactor's own
 * patterns over the text surfaces.
 *
 * Prompt text (c): the objective is deliberately stored in `meta_session.objective` and `run.request_json` (the
 * continuity record, LLD §15; FRD BR-8), so the objective canary is asserted absent from `run_event` payloads, artifacts,
 * the daemon log and CLI list output, not from those two columns. A credential-shaped canary inside the prompt is
 * asserted absent everywhere, including those columns and the raw data directory: the objective is redacted at
 * admission (Q-68).
 *
 * The scanner itself has positive controls at the end: each detector is shown to fire on planted text.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAdapter } from "../src/adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile, type VersionGateResult } from "../src/adapters/index.js";
import { ArtifactStore } from "../src/artifacts/index.js";
import { DEFAULT_SECRET_PATTERNS, PREFIXED_PATTERNS } from "../src/artifacts/redact.js";
import type { CliIo } from "../src/cli/io.js";
import { main } from "../src/cli/main.js";
import { TEST_FAKE_ADAPTER_ENV, TEST_FAKE_ADAPTER_VALUE, TEST_FAKE_SCENARIO_ENV } from "../src/cli/serve.js";
import { createIdGenerator } from "../src/ids/index.js";
import { createLedger, openLedger, type TrustProfile } from "../src/ledger/index.js";
import { RunLifecycle } from "../src/lifecycle/index.js";
import { createSwitchboardServer } from "../src/mcp/index.js";
import { WorkspaceManager } from "../src/workspace/index.js";

// ---- canaries ---------------------------------------------------------------------------------------------------------

const hex = (n: number) => randomBytes(n).toString("hex");
const upperHex = (n: number) => hex(n).toUpperCase();

/** `name -> value`. Every credential-shaped value matches DEFAULT_SECRET_PATTERNS, so redaction could catch it. */
interface Canaries {
  readonly env: Readonly<Record<string, string>>;
  /** Plain (not credential-shaped) environment value: only exact-match scanning can find it. */
  readonly envPlain: { name: string; value: string };
  readonly out: Readonly<Record<string, string>>;
  readonly promptText: string;
  readonly promptCredential: string;
}

function makeCanaries(): Canaries {
  return {
    env: {
      ANTHROPIC_API_KEY: `sk-ant-api03-CANARYENV${hex(16)}`,
      OPENAI_API_KEY: `sk-proj-CANARYENV${hex(16)}`,
      GITHUB_TOKEN: `ghp_CANARYENV${hex(12)}${hex(8)}`,
      AWS_ACCESS_KEY_ID: `AKIACANARY${upperHex(5)}`,
      SB_SCAN_SLACK_TOKEN: `xoxb-CANARYENV-${hex(8)}`,
    },
    envPlain: { name: "SB_SCAN_PLAIN_VALUE", value: `plain-env-value-${hex(10)}` },
    out: {
      tool_command: `ghp_CANARYCMD${hex(12)}${hex(8)}`,
      message: `sk-ant-api03-CANARYMSG${hex(16)}`,
      stderr: `AKIACANARY${upperHex(5)}`,
      error_text: `sk-proj-CANARYERR${hex(16)}`,
      summary: `xoxb-CANARYSUM-${hex(8)}`,
      file: `ghp_CANARYFILE${hex(12)}${hex(8)}`,
    },
    promptText: `PROMPT-CANARY-${hex(10)}`,
    promptCredential: `sk-ant-api03-CANARYPROMPT${hex(16)}`,
  };
}

const allEnvValues = (c: Canaries): string[] => [...Object.values(c.env), c.envPlain.value];
const credentialCanaries = (c: Canaries): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(c.env).map(([k, v]) => [`env.${k}`, v])),
  ...Object.fromEntries(Object.entries(c.out).map(([k, v]) => [`out.${k}`, v])),
  "prompt.credential": c.promptCredential,
});
const allCredentialCanaries = (c: Canaries): string[] => Object.values(credentialCanaries(c));

// ---- scanner ----------------------------------------------------------------------------------------------------------

/** Canary values (by label) found in `text`. */
function findCanaries(text: string, canaries: Record<string, string>): string[] {
  return Object.entries(canaries)
    .filter(([, v]) => text.includes(v))
    .map(([k]) => k);
}

/** Matches of the redactor's own patterns, minus the redaction marker itself. */
function patternHits(text: string): string[] {
  const hits: string[] = [];
  for (const re of [...DEFAULT_SECRET_PATTERNS, ...PREFIXED_PATTERNS]) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      // PREFIXED_PATTERNS keep the key name; the value is group-less text after the prefix.
      const value = m[1] !== undefined ? m[0].slice(m[1].length) : m[0];
      if (value !== "[REDACTED]") hits.push(m[0].slice(0, 60));
    }
  }
  return hits;
}

/** Every file under `root` (no symlink following) as latin1 text, one entry per file; `skip` prunes directories. */
function filesUnder(root: string, skip: (abs: string) => boolean = () => false): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (skip(abs)) continue;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs);
      else out.push({ file: abs, text: readFileSync(abs, "latin1") });
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** Every row of every table, every column; blobs as latin1 text. `except` drops named `table.column` pairs. */
function ledgerText(db: Database.Database, except: readonly string[] = []): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  const parts: string[] = [];
  for (const { name } of tables) {
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]) {
      for (const [col, val] of Object.entries(row)) {
        if (except.includes(`${name}.${col}`)) continue;
        parts.push(Buffer.isBuffer(val) ? val.toString("latin1") : String(val));
      }
    }
  }
  return parts.join("\n");
}

// ---- harness ----------------------------------------------------------------------------------------------------------

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Op",
  GIT_AUTHOR_EMAIL: "op@example.test",
  GIT_COMMITTER_NAME: "Op",
  GIT_COMMITTER_EMAIL: "op@example.test",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

function makeRepo(root: string): string {
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

/**
 * A scripted provider process. Behaviour is chosen by a `mode:` word in the prompt (read from stdin). It prints the
 * synthetic output canaries in every place a provider can, and reports the VALUES of any environment variable whose
 * name looks credential-like, so a canary that reached the child would show up in the provider output as well.
 */
function providerScript(c: Canaries): string {
  return `import { readFileSync, writeFileSync } from "node:fs";
const C = ${JSON.stringify(c.out)};
if (process.argv.includes("--version")) { process.stdout.write("fake-cli 1.0.0\\n"); process.exit(0); }
if (process.argv.includes("--auth-status")) { process.stdout.write('{"authenticated":true}\\n'); process.exit(0); }
const prompt = readFileSync(0, "utf8");
const mode = /mode:(\\w+)/.exec(prompt)?.[1] ?? "ok";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const leaked = Object.entries(process.env).filter(([k]) => /KEY|TOKEN|SECRET|SB_SCAN|ANTHROPIC|OPENAI|AWS|GITHUB/.test(k));
emit({ type: "session", session_id: "scan-session-" + mode, model: "fake-model-1" });
emit({ type: "tool", tool: "shell", name: "bash", command: "curl -H 'Authorization: Bearer " + C.tool_command + "' https://example.test", target: "README.md" });
emit({ type: "message", text: "tool output: " + C.message + " env seen: " + JSON.stringify(leaked) });
process.stderr.write("provider stderr: " + C.stderr + "\\n");
if (mode === "edit") writeFileSync("notes.txt", "token = " + C.file + "\\n");
if (mode === "fail") {
  emit({ type: "error", category: "tool", message: "command failed: " + C.error_text });
  emit({ type: "result", ok: false, summary: "failed " + C.summary });
  process.exitCode = 1;
} else {
  emit({ type: "usage", input_tokens: 10, output_tokens: 5 });
  emit({ type: "result", ok: true, summary: "done " + C.summary });
}
`;
}

const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: name === "inspect-untrusted" ? "read-only" : "worktree",
  shell: name === "inspect-untrusted" ? "none" : name === "edit-untrusted" ? "allowlist" : "broad",
  ...(name === "edit-untrusted" ? { shellAllowlist: [] } : {}),
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON checked by the published output schemas
type Json = Record<string, any>;

/** Text of each surface the in-process runs produced. */
interface Surfaces {
  /** All ledger tables, all columns, except the two columns that hold the objective by design (see header). */
  ledger: string;
  /** All ledger tables, all columns. */
  ledger_full: string;
  ledger_run_events: string;
  artifacts_decoded: string;
  mcp: string;
  cli: string;
  /** Raw bytes of every file under the data directory (SQLite file and WAL included), worktrees excluded. */
  data_dir_files: string;
  data_dir_file_list: string;
}

/** The two columns that store the orchestrator's objective verbatim (continuity record). */
const OBJECTIVE_COLUMNS = ["meta_session.objective", "run.request_json"] as const;

interface Collected {
  readonly surfaces: Surfaces;
  readonly runIds: string[];
  readonly statuses: Record<string, string>;
}

const SAVED_ENV: Record<string, string | undefined> = {};
function plantEnv(c: Canaries): void {
  for (const [k, v] of Object.entries({ ...c.env, [c.envPlain.name]: c.envPlain.value })) {
    SAVED_ENV[k] = process.env[k];
    process.env[k] = v;
  }
}
function restoreEnv(): void {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Part 1: in-process lifecycle + MCP + CLI against one data directory. */
async function runInProcess(c: Canaries, root: string): Promise<Collected & { dataDir: string }> {
  const repo = makeRepo(root);
  const dataDir = path.join(root, "data");
  const script = path.join(root, "provider.mjs");
  writeFileSync(script, providerScript(c));
  const configPath = path.join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      data_dir: dataDir,
      allowed_roots: [root],
      mcp_clients: [{ id: "orch", max_trust_profile: "edit-untrusted" }],
    }),
  );

  const db = openLedger(dataDir);
  const ids = createIdGenerator();
  const ledger = createLedger(db, { ids });
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  const adapter = new FakeAdapter({
    executable: process.execPath,
    script,
    timeouts: { wallClockMs: 20_000, idleMs: 10_000, killGraceMs: 300 },
  });
  const registry = new AdapterRegistry().register(adapter);
  const gate = (id: string, version: string | null): VersionGateResult => ({
    eligible: true,
    evidence: { provider: id, observedVersion: version, validatedRange: "test", validatedCliVersion: "test" },
  });
  const lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots: [root],
    globalConcurrency: 2,
    resolveProfile: profileFor,
    eligibility: { platform: "linux", gate: gate as AdapterRegistry["gate"] },
  });
  lifecycle.start();
  const mcp = createSwitchboardServer({
    lifecycle,
    ledger,
    artifacts,
    registry,
    config: {
      allowedRoots: [root],
      mcpClients: new Map([["orch", { id: "orch", maxTrustProfile: "edit-untrusted" as const }]]),
    },
    clientId: "orch",
  });
  const client = new Client({ name: "secret-scan", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(serverSide);
  await client.connect(clientSide);

  const mcpTexts: string[] = [];
  const call = async (name: string, args: Json) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
    mcpTexts.push(text, JSON.stringify(res.structuredContent ?? null));
    return { isError: res.isError === true, body: JSON.parse(text) as Json };
  };

  const runIds: string[] = [];
  const statuses: Record<string, string> = {};
  for (const mode of ["ok", "fail", "edit"]) {
    const d = await call("delegate_task", {
      objective: `${c.promptText} mode:${mode} (credential in prompt: ${c.promptCredential})`,
      workspace_path: repo,
      trust_profile: "edit-untrusted",
      routing: { provider_preference: "fake", require_provider: true },
    });
    if (d.isError) throw new Error(`delegate_task failed: ${JSON.stringify(d.body)}`);
    const runId = d.body.run_id as string;
    const end = Date.now() + 45_000;
    for (;;) {
      const r = await call("get_run", { run_id: runId });
      if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(r.body.status)) {
        statuses[mode] = r.body.status;
        break;
      }
      if (Date.now() > end) throw new Error(`run ${runId} did not finish: ${r.body.status}`);
      await new Promise((res) => setTimeout(res, 25));
    }
    await call("get_run", { run_id: runId, include_events: { after_seq: 0, limit: 500 } });
    await call("get_artifacts", { run_id: runId, max_inline_bytes: 1_048_576 });
    runIds.push(runId);
  }
  await call("list_capabilities", {});

  // CLI output, with the canaries in the CLI process environment as the real entry point would pass them.
  const cliText: string[] = [];
  const cliErr: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => cliText.push(s) },
    stderr: { write: (s) => cliErr.push(s) },
    env: { ...process.env },
    user: "tester",
    adapters: registry,
  };
  const cli = async (args: string[]) => {
    const code = await main([...args, "--config", configPath], io);
    expect(code, `switchboard ${args.join(" ")}`).toBe(0);
  };
  await cli(["runs", "list", "--json"]);
  await cli(["runs", "list"]);
  for (const id of runIds) {
    await cli(["runs", "show", id, "--json"]);
    await cli(["runs", "show", id]);
  }
  await cli(["doctor", "--json"]);
  await cli(["doctor"]);

  // Stop everything, fold the WAL into the main file and close, then read what is on disk.
  await lifecycle.shutdown();
  await client.close();
  await mcp.close();
  const artifactTexts: string[] = [];
  for (const row of db.prepare("SELECT sha256 FROM artifact").all() as { sha256: string }[])
    artifactTexts.push((await artifacts.get(row.sha256)).toString("latin1"));
  const events = (db.prepare("SELECT payload_json FROM run_event").all() as { payload_json: string }[])
    .map((r) => r.payload_json)
    .join("\n");
  const ledgerNoObjective = ledgerText(db, OBJECTIVE_COLUMNS);
  const ledgerFull = ledgerText(db);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  const worktrees = path.join(dataDir, "worktrees");
  const files = filesUnder(dataDir, (abs) => abs === worktrees);
  const surfaces: Surfaces = {
    ledger: ledgerNoObjective,
    ledger_full: ledgerFull,
    ledger_run_events: events,
    artifacts_decoded: artifactTexts.join("\n"),
    mcp: mcpTexts.join("\n"),
    cli: `${cliText.join("")}\n${cliErr.join("")}`,
    data_dir_files: files.map((f) => `${f.file}\n${f.text}`).join("\n"),
    data_dir_file_list: files.map((f) => f.file).join("\n"),
  };
  return { surfaces, runIds, statuses, dataDir };
}

describe("secret scan: in-process runs (lifecycle, ledger, artifacts, MCP, CLI)", () => {
  let root: string;
  let c: Canaries;
  let got: Collected & { dataDir: string };

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-secret-scan-")));
    c = makeCanaries();
    plantEnv(c);
    try {
      got = await runInProcess(c, root);
    } finally {
      restoreEnv();
    }
  }, 120_000);

  afterAll(() => {
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  });

  it("completed the runs the scan depends on, and the surfaces are not empty", () => {
    expect(got.statuses).toEqual({ ok: "SUCCEEDED", fail: "FAILED", edit: "SUCCEEDED" });
    for (const name of ["ledger", "ledger_run_events", "artifacts_decoded", "mcp", "cli", "data_dir_files"] as const) {
      expect(got.surfaces[name].length, name).toBeGreaterThan(200);
    }
    // The scan covers the raw ledger file and the artifact store, not only the table dump.
    expect(got.surfaces.data_dir_file_list).toContain("ledger.sqlite");
    expect(got.surfaces.data_dir_file_list).toContain(`${path.sep}artifacts${path.sep}`);
    // The provider streams were stored (and redacted), so absence elsewhere is meaningful.
    expect(got.surfaces.artifacts_decoded).toContain("[REDACTED]");
    expect(got.surfaces.artifacts_decoded).toContain("provider stderr:");
  });

  it("no environment or provider-output credential canary appears on any surface", () => {
    const canaries = credentialCanaries(c);
    const found: Record<string, string[]> = {};
    for (const [surface, text] of Object.entries(got.surfaces)) {
      const hits = findCanaries(text, canaries);
      if (hits.length > 0) found[surface] = hits;
    }
    expect(found).toEqual({});
  });

  it("no environment value, credential-shaped or plain, appears on any surface", () => {
    const envCanaries = Object.fromEntries(allEnvValues(c).map((v, i) => [`env_${i}`, v]));
    const found: Record<string, string[]> = {};
    for (const [surface, text] of Object.entries(got.surfaces)) {
      const hits = findCanaries(text, envCanaries);
      if (hits.length > 0) found[surface] = hits;
    }
    expect(found).toEqual({});
  });

  it("the provider child never received the environment canaries (allowlist holds)", () => {
    // The scripted provider prints the values of credential-like variables it can see; its stdout artifact would
    // carry them. `[]` is the allowlist evidence (the scan above shows no value anywhere).
    expect(got.surfaces.artifacts_decoded).toContain("env seen: []");
  });

  // Q-68 (Delegated by the orchestrator, 2026-10-14): the objective is redacted at admission, so a credential pasted
  // into a prompt reaches neither the objective columns nor the raw SQLite file and WAL.
  it("a credential-shaped canary in the prompt is absent from the whole ledger and data directory", () => {
    expect(got.surfaces.ledger_full).not.toContain(c.promptCredential);
    expect(got.surfaces.data_dir_files).not.toContain(c.promptCredential);
    // Positive control: the prompt text itself is still stored, with the marker where the credential was.
    expect(got.surfaces.ledger_full).toContain(`${c.promptText} mode:ok (credential in prompt: [REDACTED])`);
  });

  it("run_event payloads omit the prompt text (FR-TEL-03)", () => {
    expect(got.surfaces.ledger_run_events.length).toBeGreaterThan(200);
    expect(got.surfaces.ledger_run_events).not.toContain(c.promptText);
  });

  it("artifacts, MCP responses and CLI output omit the prompt text (the objective columns hold it by design)", () => {
    expect(got.surfaces.artifacts_decoded).not.toContain(c.promptText);
    expect(got.surfaces.mcp).not.toContain(c.promptText);
    expect(got.surfaces.cli).not.toContain(c.promptText);
  });

  it("no secret pattern matches any text surface (redactor patterns, generic pass)", () => {
    const found: Record<string, string[]> = {};
    for (const name of ["ledger", "ledger_run_events", "artifacts_decoded", "mcp", "cli"] as const) {
      const hits = patternHits(got.surfaces[name]);
      if (hits.length > 0) found[name] = hits;
    }
    expect(found).toEqual({});
  });
});

// ---- Part 2: the real serve daemon -------------------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "src", "cli", "bin.ts");
const TS_REGISTER = path.join(HERE, "..", "src", "reconcile", "fixtures", "ts-register.mjs");

/**
 * T4.10: this block drives a real `serve` process with the test-only fake adapter, whose compile matrix is "verified on
 * linux only" (Q-35, NFR-PORT-02), so on darwin eligibility ends `ELIGIBILITY_NONE` by design and the run never starts.
 * The Q-35 rule is unchanged; the block runs on the Linux leg (as the same-cause blocks of `src/cli/serve.test.ts`).
 */
const describeLinuxVerified = process.platform === "darwin" ? describe.skip : describe;

describeLinuxVerified("secret scan: `serve` daemon as a process (stderr log, data directory, MCP over stdio)", () => {
  let root: string;
  let c: Canaries;
  const surfaces = { mcp: "", stderr: "", data_dir_files: "", ledger: "", run_events: "" };

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-secret-serve-")));
    c = makeCanaries();
    const repo = makeRepo(root);
    const dataDir = path.join(root, "data");
    mkdirSync(path.join(root, "home"));
    mkdirSync(path.join(root, "bin"));
    symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), path.join(root, "bin", "git"));
    const configPath = path.join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        data_dir: dataDir,
        allowed_roots: [root],
        mcp_clients: [{ id: "orch", max_trust_profile: "edit-untrusted" }],
      }),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--experimental-transform-types",
        "--no-warnings",
        "--import",
        TS_REGISTER,
        BIN,
        "serve",
        "--client",
        "orch",
        "--config",
        configPath,
      ],
      env: {
        PATH: path.join(root, "bin"),
        HOME: path.join(root, "home"),
        [TEST_FAKE_ADAPTER_ENV]: TEST_FAKE_ADAPTER_VALUE,
        [TEST_FAKE_SCENARIO_ENV]: "task_failure",
        ...c.env,
        [c.envPlain.name]: c.envPlain.value,
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const client = new Client({ name: "secret-scan-serve", version: "0.0.0" });
    await client.connect(transport);
    const texts: string[] = [];
    const call = async (name: string, args: Json) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
      texts.push(text, JSON.stringify(res.structuredContent ?? null));
      return JSON.parse(text) as Json;
    };
    const d = await call("delegate_task", {
      objective: `${c.promptText} (credential in prompt: ${c.promptCredential})`,
      workspace_path: repo,
      trust_profile: "edit-untrusted",
      routing: { provider_preference: "fake", require_provider: true },
    });
    const runId = d.run_id as string;
    const end = Date.now() + 45_000;
    for (;;) {
      const r = await call("get_run", { run_id: runId });
      if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(r.status)) break;
      if (Date.now() > end) throw new Error("serve run did not finish");
      await new Promise((res) => setTimeout(res, 50));
    }
    await call("get_run", { run_id: runId, include_events: { after_seq: 0, limit: 500 } });
    await call("get_artifacts", { run_id: runId, max_inline_bytes: 1_048_576 });
    await client.close(); // closes stdin: the daemon shuts down cleanly and checkpoints
    await new Promise((res) => setTimeout(res, 500));

    surfaces.mcp = texts.join("\n");
    surfaces.stderr = stderr;
    const worktrees = path.join(dataDir, "worktrees");
    const files = filesUnder(dataDir, (abs) => abs === worktrees);
    surfaces.data_dir_files = files.map((f) => f.text).join("\n");
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path.join(dataDir, "ledger.sqlite"), { readonly: true });
    try {
      surfaces.ledger = ledgerText(db, OBJECTIVE_COLUMNS);
      surfaces.run_events = (db.prepare("SELECT payload_json FROM run_event").all() as { payload_json: string }[])
        .map((r) => r.payload_json)
        .join("\n");
    } finally {
      db.close();
    }
  }, 120_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("logged something, so the log scan is meaningful", () => {
    expect(surfaces.stderr).toContain('"component":"serve"');
    expect(surfaces.run_events.length).toBeGreaterThan(50);
  });

  it("the daemon log, MCP responses, ledger and data directory hold no credential or environment canary", () => {
    const canaries = {
      ...Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, v])),
      [c.envPlain.name]: c.envPlain.value,
    };
    const found: Record<string, string[]> = {};
    for (const [surface, text] of Object.entries(surfaces)) {
      // The objective is redacted at admission (Q-68), so no surface, the raw data directory included, holds the
      // prompt credential.
      const hits = findCanaries(text, { ...canaries, prompt_credential: c.promptCredential });
      if (hits.length > 0) found[surface] = hits;
    }
    expect(found).toEqual({});
  });

  it("the daemon log and run_event payloads omit the prompt text", () => {
    expect(surfaces.stderr).not.toContain(c.promptText);
    expect(surfaces.run_events).not.toContain(c.promptText);
  });

  it("no secret pattern matches the daemon log, MCP responses or run_event payloads", () => {
    expect(patternHits(surfaces.stderr)).toEqual([]);
    expect(patternHits(surfaces.mcp)).toEqual([]);
    expect(patternHits(surfaces.run_events)).toEqual([]);
  });
});

// ---- positive controls for the scanner --------------------------------------------------------------------------------

describe("secret scan: positive controls", () => {
  it("findCanaries and patternHits fire on planted values", () => {
    const c = makeCanaries();
    for (const v of allCredentialCanaries(c)) {
      expect(findCanaries(`xx ${v} yy`, { v })).toEqual(["v"]);
      expect(patternHits(`xx ${v} yy`).length, v).toBeGreaterThan(0);
    }
    expect(patternHits("password = hunter2hunter2").length).toBeGreaterThan(0);
    expect(patternHits("sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")).toEqual([]);
    expect(patternHits("[REDACTED] Bearer [REDACTED]")).toEqual([]);
  });

  it("ledgerText reads every column of every table, blobs included", () => {
    // A throwaway in-memory database stands in for the ledger: the scanner must find a value in any column.
    const Database = openLedger;
    const dir = mkdtempSync(path.join(tmpdir(), "sb-secret-pc-"));
    try {
      const db = Database(dir);
      db.exec("CREATE TABLE zz_probe (a TEXT, b BLOB)");
      db.prepare("INSERT INTO zz_probe VALUES (?, ?)").run("plain", Buffer.from("blobcanary-1234"));
      expect(ledgerText(db)).toContain("blobcanary-1234");
      expect(ledgerText(db, ["zz_probe.b"])).not.toContain("blobcanary-1234");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
