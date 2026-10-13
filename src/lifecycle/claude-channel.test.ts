/**
 * T9.4b end to end with a fake `claude` (ADR-0029, ADR-0033; FR-GIT-02, FR-POL-08): the run lifecycle opens the per-run
 * tool channel for a Claude Code project run with the operator opt-in, and only for an approved privileged bypass run
 * (owner decision 41), the channel service writes the `--mcp-config` definition, `--safe-mode` is removed, the argv
 * audits admit both, and the replay script (`src/adapters/claude/fixtures/replay.mjs --mcp-commit`) stands in for
 * Claude Code: it reads the definition, starts the real `switchboard tool-shim` from it and calls `commit`. What the
 * replay does with the definition is modelled on the operator live check (PR #41, a hand-made server), not on a real
 * Claude Code run through Switchboard. Every other profile gets no channel and the argv of the opt-in off. The real
 * `claude` binary is never run; no login, network or credential is used; repositories are temporary.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../adapters/claude/adapter.js";
import { fixturePath, REPLAY_SCRIPT } from "../adapters/claude/fixtures/cases.js";
import {
  AdapterRegistry,
  type ProbeRunner,
  type ProviderAdapter,
  type ResolvedProfile,
  type ShimSpec,
} from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { GIT_CHANNEL_CLOSED, GIT_CHANNEL_OPENED, GitToolService } from "../git/channel.js";
import { GitPublisher, publishRefFor } from "../git/index.js";
import { CHANNEL_MCP_CONFIG_FILE, TOKEN_PREFIX, TOOL_TOKEN_ENV } from "../git/tool-protocol.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import type { ProjectSnapshot } from "../policy/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { RunLifecycle } from "./index.js";

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

/** Probe and auth answers of a logged-in Claude Code 2.1.296; the real binary is never asked. */
const CLAUDE_HELP =
  "-p, --print\n--output-format stream-json\n--permission-mode dontAsk\n--permission-prompts\n--tools\n--allowedTools\n" +
  "--disallowedTools\n--safe-mode\n--restricted\n--strict-mcp-config\n--resume\n";
const probeRunner: ProbeRunner = async (argv) => {
  const last = argv.at(-1);
  if (last === "--version") return { exitCode: 0, stdout: "2.1.296 (Claude Code)\n", stderr: "", timedOut: false };
  if (last === "--help") return { exitCode: 0, stdout: CLAUDE_HELP, stderr: "", timedOut: false };
  return { exitCode: 0, stdout: '{"loggedIn":true}', stderr: "", timedOut: false };
};

const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };
const PROFILE: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};
const PROJECT: ProjectSnapshot = {
  id: "web",
  name: "Web",
  environment_kind: "host",
  context_id: "main",
  base_ref: "main",
  effective_max_profile: "edit-untrusted",
  writable: true,
  identity: IDENTITY,
  push: { policy: "none" },
};

let root: string;
let repo: string;
let dataDir: string;
let record: string;
let db: Database.Database;
let ledger: Ledger;
let service: GitToolService;
let lifecycle: RunLifecycle | undefined;
let shims: ShimSpec[];

/** The real Claude adapter replaying a fixture; `--mcp-commit` makes the replay act on the channel definition. */
function claude(gitChannel: boolean): ClaudeAdapter {
  return new ClaudeAdapter({
    binaryPath: process.execPath,
    launcherArgs: [REPLAY_SCRIPT, "--fixture", fixturePath("success-edit.jsonl"), "--mcp-commit", record, "--"],
    timeouts: PATIENT,
    gitChannel,
  });
}

/** Records the ShimSpec handed to the adapter (test-only capture of the token); optionally rewrites the fragment. */
function capturing(inner: ClaudeAdapter, rewrite?: (argv: string[]) => string[]): ProviderAdapter {
  const channelArgs = inner.gitCapabilities.channelArgs;
  return {
    id: inner.id,
    transports: inner.transports,
    gitWriteControl: inner.gitWriteControl,
    gitCapabilities: {
      ...inner.gitCapabilities,
      ...(channelArgs
        ? {
            channelArgs: (shim, req, p) => {
              shims.push(shim);
              const extra = channelArgs(shim, req, p);
              if ("ineligible" in extra || !rewrite) return extra;
              return { ...extra, argv: rewrite([...extra.argv]) };
            },
          }
        : {}),
    },
    probe: (r) => inner.probe(r),
    authPreflight: (r) => inner.authPreflight(r),
    compile: (req, p) => inner.compile(req, p),
    resumeArgs: (b, req, p) => inner.resumeArgs(b, req, p),
    parseEvent: (i, st) => inner.parseEvent(i, st),
    extractResult: (e, x) => inner.extractResult(e, x),
    classifyFailure: (e) => inner.classifyFailure(e),
  };
}

/** The approved bypass scope a Claude privileged run can compile (network on, R-36; repository config disabled). */
const BYPASS_SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "on" },
  repository_config: { mode: "disabled" },
  bypass: true,
};

function start(adapter: ProviderAdapter, extra: { finalizePublisher?: GitPublisher } = {}): RunLifecycle {
  const ids = createIdGenerator();
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  const lc = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(adapter),
    allowedRoots: [root],
    globalConcurrency: 1,
    resolveProfile: () => PROFILE,
    probeRunner,
    gitTools: service,
    ...extra,
  });
  lc.start();
  lifecycle = lc;
  return lc;
}

const submit = (lc: RunLifecycle) =>
  lc.submit({
    clientId: "c",
    objective: "commit through the channel",
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "claude",
    project: PROJECT,
  });

/** Submit a privileged run, approve it as `serve` would (applyApprovalDecision), and wait for it to end. */
async function submitPrivileged(lc: RunLifecycle, scope: object = BYPASS_SCOPE) {
  const { runId, metaSessionId } = await lc.submit({
    clientId: "c",
    objective: "commit through the channel",
    workspace: repo,
    trustProfile: "privileged",
    provider: "claude",
    project: PROJECT,
    privileged: { scope },
  });
  lc.applyApprovalDecision({
    requestEventId: `evt_test_${runId}`,
    runId,
    decision: "APPROVED",
    requestedBy: "op",
    requestedAt: "2026-10-13T00:00:00.000Z",
    scopeHash: ledger.getApprovalForRun(runId)?.scope_hash ?? "",
  });
  return { runId, metaSessionId, done: await lc.waitForTerminal(runId) };
}

const events = (runId: string) =>
  ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) }));

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? allFiles(full) : d.isFile() ? [full] : [];
  });
}

// biome-ignore lint/suspicious/noExplicitAny: the replay's evidence record is untyped JSON
const readRecord = (): Record<string, any> => JSON.parse(readFileSync(record, "utf8"));

beforeEach(() => {
  shims = [];
  lifecycle = undefined;
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-cch-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  execFileSync("sh", ["-c", "printf 'hello\\n' > README.md"], { cwd: repo });
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  record = path.join(root, "replay-record.json");
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  const publisher = new GitPublisher({ db, scratchDir: path.join(dataDir, "git-scratch") });
  service = new GitToolService({ db, dataDir, publisher, shimCommand: SHIM_COMMAND, fallbackDirs: [root] });
});

afterEach(async () => {
  await lifecycle?.shutdown();
  await service.closeAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Claude Code channel behind the opt-in (T9.4b, fake claude replay)", () => {
  it("opt-in on, approved bypass: one 0600 definition, no --safe-mode, token only in env, commit lands", async () => {
    const lc = start(capturing(claude(true)));
    const { runId, metaSessionId, done } = await submitPrivileged(lc);
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");

    const rec = readRecord();
    expect(rec.error).toBeUndefined();
    const dir = path.join(dataDir, "runs", runId);
    const file = path.join(dir, CHANNEL_MCP_CONFIG_FILE);
    const argv: string[] = rec.argv;
    expect(argv.filter((a) => a === "--mcp-config")).toHaveLength(1);
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe(file);
    expect(argv).toContain("--strict-mcp-config");
    // Owner decision 41 (ADR-0033): --safe-mode stops the server from starting, so this run omits it.
    expect(argv).not.toContain("--safe-mode");
    expect(argv.slice(-2)).toEqual(["--allowedTools", "mcp__switchboard-git__commit"]);
    expect(argv.some((a) => a.includes("*") && a.includes("mcp__"))).toBe(false);
    // The approved bypass invocation; the Git deny rules stay (R-38).
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).toContain("--disallowedTools");
    expect(argv).toContain("Bash(git commit *)");
    expect(rec.servers).toEqual(["switchboard-git"]);
    expect(rec.mode).toBe(0o600);
    expect(rec.dirMode).toBe(0o700);
    expect(rec.tokenInEnv).toBe(true);
    // The server inherits the claude environment (live check, PR #41): only PATH, HOME and the token reach it, and the
    // controller always sets the token (an unset one would stay a literal ${...}).
    expect(rec.envKeys).toContain(TOOL_TOKEN_ENV);
    for (const k of rec.envKeys as string[]) expect(["HOME", "PATH", TOOL_TOKEN_ENV], k).toContain(k);
    expect(rec.tools).toEqual(["commit"]);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].isError).toBe(false);

    // No secret in argv or the definition (FR-POL-08).
    const token = shims[0]?.env[TOOL_TOKEN_ENV] ?? "";
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    for (const text of [JSON.stringify(argv), String(rec.config)]) {
      expect(text).not.toContain(TOKEN_PREFIX);
      expect(text).not.toContain(token.slice(TOKEN_PREFIX.length));
    }
    expect(JSON.parse(rec.config).mcpServers["switchboard-git"].env).toEqual({
      [TOOL_TOKEN_ENV]: `\${${TOOL_TOKEN_ENV}}`,
    });

    // The commit came through the shim, socket and COMP-GIT (sanitised, configured identity).
    const sha = refSha(repo, publishRefFor(metaSessionId));
    expect(sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(g(repo, "log", "-1", "--format=%B", sha)).toBe("Add channel.txt");
    expect(g(repo, "show", "--name-only", "--format=", sha)).toBe("channel.txt");
    expect(ledger.listGitCommits(runId)).toHaveLength(1);

    // The definition, socket and directory are gone once the channel closed; nothing in the data dir holds the token.
    expect(existsSync(file)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    const ev = events(runId);
    expect(ev.find((e) => e.type === GIT_CHANNEL_OPENED)?.p).toMatchObject({ tools: ["commit"] });
    expect(ev.find((e) => e.type === GIT_CHANNEL_CLOSED)?.p).toMatchObject({ commits: 1, removed: true });
    db.pragma("wal_checkpoint(TRUNCATE)");
    for (const f of allFiles(dataDir)) {
      const bytes = readFileSync(f);
      expect(bytes.includes(token.slice(TOKEN_PREFIX.length)), f).toBe(false);
    }
  });

  it("opt-in off: no channel, no --mcp-config, argv as before, nothing committed", async () => {
    const lc = start(capturing(claude(false)));
    const { runId, metaSessionId } = await submit(lc);
    const done = await lc.waitForTerminal(runId);
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
    const rec = readRecord();
    expect(rec.error).toBeDefined(); // the replay found no definition to act on
    expect(rec.argv).not.toContain("--mcp-config");
    expect(rec.argv.some((a: string) => a.includes("mcp__"))).toBe(false);
    expect(rec.tokenInEnv).toBe(false);
    expect(shims).toEqual([]);
    expect(events(runId).some((e) => e.type.startsWith("git_channel"))).toBe(false);
    expect(refSha(repo, publishRefFor(metaSessionId))).toBe("");
  });

  it("opt-in on, every non-bypass run: no channel, argv identical to the opt-in off, --safe-mode kept", async () => {
    const argvOf = async (gitChannel: boolean, privileged: boolean) => {
      shims = [];
      rmSync(record, { force: true });
      const lc = start(capturing(claude(gitChannel)));
      const r = privileged ? await submitPrivileged(lc, { ...BYPASS_SCOPE, bypass: false }) : await submit(lc);
      const done = "done" in r ? r.done : await lc.waitForTerminal(r.runId);
      expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
      await lc.shutdown();
      lifecycle = undefined;
      const rec = readRecord();
      expect(rec.tokenInEnv).toBe(false);
      expect(shims).toEqual([]);
      expect(events(r.runId).some((e) => e.type.startsWith("git_channel"))).toBe(false);
      expect(refSha(repo, publishRefFor(r.metaSessionId))).toBe("");
      // Worktree paths differ per run; compare the flags.
      return (rec.argv as string[]).filter((a) => a.startsWith("-"));
    };
    for (const privileged of [false, true]) {
      const offArgv = await argvOf(false, privileged);
      const onArgv = await argvOf(true, privileged);
      expect(onArgv).toEqual(offArgv);
      expect(onArgv).toContain("--safe-mode");
      expect(onArgv).not.toContain("--mcp-config");
      expect(onArgv).not.toContain("--dangerously-skip-permissions");
    }
  });

  it("opt-in on, edit-untrusted with the project's finalize_commit: finalize-only makes the commit (FR-GIT-09)", async () => {
    const adapter = new ClaudeAdapter({
      binaryPath: process.execPath,
      launcherArgs: [REPLAY_SCRIPT, "--fixture", fixturePath("success-edit.jsonl"), "--write", "edited.txt", "--"],
      timeouts: PATIENT,
      gitChannel: true,
    });
    const finalizePublisher = new GitPublisher({
      db,
      scratchDir: path.join(dataDir, "git-scratch"),
      allowedStates: ["FINALIZING"],
    });
    const lc = start(capturing(adapter), { finalizePublisher });
    const { runId, metaSessionId } = await lc.submit({
      clientId: "c",
      objective: "edit a file",
      workspace: repo,
      trustProfile: "edit-untrusted",
      provider: "claude",
      project: { ...PROJECT, finalize_commit: true },
    });
    const done = await lc.waitForTerminal(runId);
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
    expect(shims).toEqual([]);
    expect(events(runId).some((e) => e.type.startsWith("git_channel"))).toBe(false);
    const sha = refSha(repo, publishRefFor(metaSessionId));
    expect(sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(g(repo, "show", "--name-only", "--format=", sha)).toBe("edited.txt");
  });

  it("a fragment that names another definition is refused by the audit before spawn; the file is removed", async () => {
    const lc = start(
      capturing(claude(true), (argv) => argv.map((a) => (a.endsWith(CHANNEL_MCP_CONFIG_FILE) ? "/tmp/other.json" : a))),
    );
    const { runId, done } = await submitPrivileged(lc);
    expect(done.state).toBe("FAILED");
    expect(done.failure_code).toBe("PERMISSION_BLOCKED");
    expect(done.failure_detail).toMatch(/MCP definition refused/u);
    expect(existsSync(record)).toBe(false); // never spawned
    expect(existsSync(path.join(dataDir, "runs", runId))).toBe(false);
    expect(events(runId).find((e) => e.type === GIT_CHANNEL_CLOSED)?.p).toMatchObject({ removed: true });
  });

  it("a wildcard allow rule in the fragment is refused by the audit before spawn", async () => {
    const lc = start(capturing(claude(true), (argv) => [...argv, "mcp__switchboard-git__*"]));
    const { done } = await submitPrivileged(lc);
    expect(done.failure_code).toBe("PERMISSION_BLOCKED");
    expect(existsSync(record)).toBe(false);
  });
});
