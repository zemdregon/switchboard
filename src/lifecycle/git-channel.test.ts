/**
 * T9.4 end to end (FR-GIT-02, FR-GIT-04, FR-GIT-07, LLD §12.2; ADR-0026): the run lifecycle opens the per-run tool
 * channel for a fake-adapter project run, the fake CLI starts the real `switchboard tool-shim` (TypeScript entry through
 * the test-only resolve hook), calls `commit` over MCP, and the shim forwards it over the Unix socket to `COMP-GIT`. No
 * provider CLI, login or network is used; repositories are temporary.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScenario } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ProviderAdapter, type ResolvedProfile, type ShimSpec } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { GIT_CHANNEL_CLOSED, GIT_CHANNEL_OPENED, GIT_TOOL_DENIED, GitToolService } from "../git/channel.js";
import { GitPublisher, publishRefFor } from "../git/index.js";
import { TOKEN_PREFIX } from "../git/tool-protocol.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import type { ProjectSnapshot } from "../policy/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { GIT_CHANNEL_NOT_OFFERED_EVENT, RunLifecycle } from "./index.js";

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

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let service: GitToolService;
let lifecycle: RunLifecycle;
/** ShimSpecs the adapter received (the token is in `env`; test-only capture). */
let shims: ShimSpec[];

function project(over: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    id: "web",
    name: "Web",
    environment_kind: "host",
    context_id: "main",
    base_ref: "main",
    effective_max_profile: "edit-untrusted",
    writable: true,
    identity: IDENTITY,
    push: { policy: "none" },
    ...over,
  };
}

/** The real fake adapter with its real `channelArgs`; only records the ShimSpec it is handed. */
function capturing(scenario: FakeScenario): ProviderAdapter {
  const inner = new FakeAdapter({ scenario, ...(scenario.startsWith("hang") ? {} : { timeouts: PATIENT }) });
  const channelArgs = inner.gitCapabilities.channelArgs;
  if (!channelArgs) throw new Error("fake adapter must declare channelArgs");
  return {
    id: inner.id,
    transports: inner.transports,
    gitWriteControl: inner.gitWriteControl,
    gitCapabilities: {
      ...inner.gitCapabilities,
      channelArgs: (shim, req, p) => {
        shims.push(shim);
        return channelArgs(shim, req, p);
      },
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

function makeLifecycle(scenario: FakeScenario, over: { gitTools?: GitToolService | undefined } = {}): RunLifecycle {
  const ids = createIdGenerator();
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  return new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(capturing(scenario)),
    allowedRoots: [root],
    globalConcurrency: 2,
    resolveProfile: () => PROFILE,
    ...("gitTools" in over ? (over.gitTools ? { gitTools: over.gitTools } : {}) : { gitTools: service }),
  });
}

const submit = (objective: string, p: ProjectSnapshot | null = project()) =>
  lifecycle.submit({
    clientId: "c",
    objective,
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    ...(p ? { project: p } : {}),
  });

const events = (runId: string) =>
  ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) }));

/** Every file under a directory, recursively (for the token leak search). */
function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? allFiles(full) : d.isFile() ? [full] : [];
  });
}

beforeEach(() => {
  shims = [];
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-gch-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  execFileSync("sh", ["-c", "printf 'hello\\n' > README.md"], { cwd: repo });
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
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

describe("injected commit tool, end to end with the fake adapter (T9.4)", () => {
  it("commits through the shim and socket: publish ref advanced, provenance row, sanitised, worktree untouched", async () => {
    lifecycle = makeLifecycle("git_commit");
    lifecycle.start();
    const { runId, metaSessionId } = await submit("go");
    const done = await lifecycle.waitForTerminal(runId);
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");

    const ref = publishRefFor(metaSessionId);
    const sha = refSha(repo, ref);
    expect(sha).toMatch(/^[0-9a-f]{40}$/u);
    // Sanitiser applied (FR-GIT-04): the attribution trailer is gone, and the identity is the context's.
    const msg = g(repo, "log", "-1", "--format=%B", sha);
    expect(msg).toBe("Add the feature");
    expect(g(repo, "log", "-1", "--format=%an <%ae>|%cn <%ce>", sha)).toBe(
      "Ada Maintainer <ada@example.test>|Ada Maintainer <ada@example.test>",
    );
    expect(g(repo, "show", "--name-only", "--format=", sha)).toBe("feature.txt");
    expect(g(repo, "rev-parse", `${sha}^`)).toBe(g(repo, "rev-parse", "main"));

    // Provenance (FR-GIT-07).
    const rows = ledger.listGitCommits(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ commit_sha: sha, project_id: "web", context_id: "main", origin: "commit_tool" });
    expect(JSON.parse(rows[0]?.sanitizer_json ?? "{}")).toEqual({ rules: { "trailer.co-author": 1 } });

    // The run branch holds only controller checkpoints; the operator's checkout is untouched (FR-WS-05).
    const run = ledger.getRunRecord(runId);
    expect(g(repo, "rev-parse", "HEAD")).toBe(g(repo, "rev-parse", "main"));
    expect(g(repo, "status", "--porcelain")).toBe("");
    const branchLog = g(repo, "log", "--format=%ae", `${run?.branch}`, "--not", "main").split("\n");
    expect(branchLog.every((e) => e === "switchboard@localhost")).toBe(true);
    // Neither history reaches the other: no checkpoint is published, and the run branch did not gain the commit.
    for (const [a, b] of [
      [run?.branch ?? "", sha],
      [sha, run?.branch ?? ""],
    ]) {
      expect(() => g(repo, "merge-base", "--is-ancestor", a as string, b as string)).toThrow();
    }

    // Channel lifecycle: opened, closed, socket and directory removed.
    const ev = events(runId);
    const opened = ev.find((e) => e.type === GIT_CHANNEL_OPENED);
    const closed = ev.find((e) => e.type === GIT_CHANNEL_CLOSED);
    expect(opened?.p).toMatchObject({ tools: ["commit"], fallback: false });
    expect(closed?.p).toMatchObject({ calls: 1, commits: 1, refused: 0, removed: true });
    expect(existsSync(opened?.p.socket_dir)).toBe(false);
    expect(service.openCount).toBe(0);
    expect(ev.filter((e) => e.type === GIT_TOOL_DENIED)).toEqual([]);
  });

  it("never writes the token to the ledger, artifacts, events or any file in the data directory", async () => {
    lifecycle = makeLifecycle("git_commit");
    lifecycle.start();
    const { runId } = await submit("go");
    expect((await lifecycle.waitForTerminal(runId)).state).toBe("SUCCEEDED");
    const token = shims[0]?.env.SWITCHBOARD_TOOL_TOKEN ?? "";
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    db.pragma("wal_checkpoint(TRUNCATE)");
    const files = allFiles(dataDir);
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const bytes = readFileSync(f);
      expect(bytes.includes(token), f).toBe(false);
      expect(bytes.includes(token.slice(TOKEN_PREFIX.length)), f).toBe(false);
      expect(bytes.includes(TOKEN_PREFIX), f).toBe(false);
    }
    const all = JSON.stringify(ledger.listRunEvents(runId));
    expect(all).not.toContain(token.slice(TOKEN_PREFIX.length));
  });

  it("refused calls through the shim are tool errors with events, never commits, and the run still succeeds", async () => {
    lifecycle = makeLifecycle("git_commit");
    lifecycle.start();
    const plan = {
      files: { "ok.txt": "ok\n" },
      calls: [
        { name: "commit", arguments: { message: "escape", paths: ["../outside.txt"] } },
        { name: "commit", arguments: { message: "abs", paths: ["/etc/passwd"] } },
        { name: "commit", arguments: { message: "gitdir", paths: [".git/config"] } },
        { name: "commit", arguments: { message: "x".repeat(8193) } },
        { name: "commit", arguments: { message: "extra", sneaky: true } },
        { name: "push", arguments: {} },
      ],
    };
    const { runId, metaSessionId } = await submit(JSON.stringify(plan));
    expect((await lifecycle.waitForTerminal(runId)).state).toBe("SUCCEEDED");
    expect(refSha(repo, publishRefFor(metaSessionId))).toBe("");
    expect(ledger.listGitCommits(runId)).toEqual([]);
    const denied = events(runId)
      .filter((e) => e.type === GIT_TOOL_DENIED)
      .map((e) => e.p.code);
    expect(denied).toEqual([
      "PATH_OUTSIDE_WORKTREE",
      "PATH_OUTSIDE_WORKTREE",
      "PATH_REFUSED",
      "MESSAGE_TOO_LONG",
      "INVALID_ARGUMENTS",
      "UNKNOWN_TOOL",
    ]);
    expect(events(runId).some((e) => e.type === "git_commit_intent")).toBe(false);
  });

  it("removes the socket after cancel and leaves no channel open", async () => {
    lifecycle = makeLifecycle("hang");
    lifecycle.start();
    const { runId } = await submit("go");
    const until = Date.now() + 15_000;
    while (ledger.getRunRecord(runId)?.state !== "RUNNING") {
      if (Date.now() > until) throw new Error("not running");
      await new Promise((r) => setTimeout(r, 20));
    }
    const shim = shims[0];
    expect(shim).toBeDefined();
    const sock = shim?.socketPath ?? "";
    expect(statSync(sock).isSocket()).toBe(true);
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(sock)).mode & 0o777).toBe(0o700);
    await lifecycle.cancel(runId);
    expect((await lifecycle.waitForTerminal(runId)).state).toBe("CANCELLED");
    expect(existsSync(sock)).toBe(false);
    expect(existsSync(path.dirname(sock))).toBe(false);
    expect(service.openCount).toBe(0);
    expect(events(runId).find((e) => e.type === GIT_CHANNEL_CLOSED)?.p).toMatchObject({ removed: true });
  });

  it("offers no channel without a project, identity or writable context, or when the service is not configured", async () => {
    lifecycle = makeLifecycle("success");
    lifecycle.start();
    const a = await submit("go", null);
    const { identity: _unused, ...noIdentity } = project();
    const b = await submit("go2", noIdentity);
    for (const id of [a.runId, b.runId]) expect((await lifecycle.waitForTerminal(id)).state).toBe("SUCCEEDED");
    expect(events(a.runId).some((e) => e.type.startsWith("git_channel"))).toBe(false);
    expect(events(b.runId).find((e) => e.type === GIT_CHANNEL_NOT_OFFERED_EVENT)?.p).toEqual({ reason: "no_identity" });
    await lifecycle.shutdown();

    lifecycle = makeLifecycle("success");
    lifecycle.start();
    const c = await submit("go3", project({ writable: false }));
    expect((await lifecycle.waitForTerminal(c.runId)).state).toBe("SUCCEEDED");
    expect(events(c.runId).find((e) => e.type === GIT_CHANNEL_NOT_OFFERED_EVENT)?.p).toEqual({
      reason: "context_not_writable",
    });
    await lifecycle.shutdown();

    lifecycle = makeLifecycle("success", { gitTools: undefined });
    lifecycle.start();
    const d = await submit("go4");
    expect((await lifecycle.waitForTerminal(d.runId)).state).toBe("SUCCEEDED");
    expect(events(d.runId).some((e) => e.type.startsWith("git_channel"))).toBe(false);
    expect(shims).toEqual([]);
  });

  it("a stale token after the run ended reaches nothing: the socket is gone", async () => {
    lifecycle = makeLifecycle("git_commit");
    lifecycle.start();
    const { runId, metaSessionId } = await submit("go");
    expect((await lifecycle.waitForTerminal(runId)).state).toBe("SUCCEEDED");
    const shim = shims[0] as ShimSpec;
    const before = refSha(repo, publishRefFor(metaSessionId));
    const { forward } = await import("../cli/tool-shim.js");
    const r = await forward(
      { socketPath: shim.socketPath, token: shim.env.SWITCHBOARD_TOOL_TOKEN ?? "" },
      "commit",
      { message: "late" },
      5000,
    );
    expect(r).toMatchObject({ ok: false, error: { code: "CHANNEL_UNAVAILABLE" } });
    expect(refSha(repo, publishRefFor(metaSessionId))).toBe(before);
  });
});
