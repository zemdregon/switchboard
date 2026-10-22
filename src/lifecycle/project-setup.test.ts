/**
 * ADR-0071: the project setup step through the real run lifecycle with the fake adapter, real Git in a temporary
 * repository and a fake install (a Node script that writes `node_modules/pkg/installed.txt` from the lockfile; `FAIL`
 * in the lockfile exits 3, `SLEEP` hangs). The fake provider CLI records whether it saw the installed file. Setup runs
 * through the bridge without bubblewrap (`wrap`), so these tests need no user namespaces and no network.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { breakerOutcome } from "../capacity/breaker.js";
import { bridgeOnly } from "../exec/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunState } from "../ledger/index.js";
import type { ProjectSnapshot } from "../policy/index.js";
import { createProjectSetup, WORKSPACE_SETUP_EVENT, WorkspaceManager } from "../workspace/index.js";
import { RunLifecycle } from "./index.js";

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
const PROFILE: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};

const CLI = `
import { existsSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
const a = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (a.includes("--version")) process.stdout.write("fake-cli 1.0.0\\n");
else if (a.includes("--auth-status")) process.stdout.write('{"authenticated":true}\\n');
else if (a.includes("--smoke")) emit({ type: "result", ok: true, summary: "smoke" });
else {
  readFileSync(0, "utf8");
  writeFileSync(SPAWNED, "spawned\\n");
  emit({ type: "session", session_id: "setup-1" });
  const seen = existsSync("node_modules/pkg/installed.txt") ? "installed" : "missing";
  writeFileSync("agent.txt", seen + "\\n");
  emit({ type: "result", ok: true, summary: "agent saw " + seen });
}
`;

const INSTALL = `
const fs = require("node:fs");
const lock = fs.readFileSync("package-lock.json", "utf8");
if (lock.includes("FAIL")) { process.stderr.write("ERR_PNPM_FAKE install failed\\n"); process.exit(3); }
if (lock.includes("SLEEP")) setInterval(() => {}, 1000);
else {
  fs.mkdirSync("node_modules/pkg", { recursive: true });
  fs.writeFileSync("node_modules/pkg/installed.txt", lock);
  console.log("installed");
}
`;

let root: string;
let repo: string;
let spawned: string;
let script: string;
let install: string;
const open: { lifecycle: RunLifecycle; db: Database.Database }[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-setup-lc-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(repo, "package-lock.json"), "lock-v1\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  spawned = path.join(root, "spawned.txt");
  script = path.join(root, "cli.mjs");
  writeFileSync(script, CLI.replace("SPAWNED", JSON.stringify(spawned)));
  install = path.join(root, "install.cjs");
  writeFileSync(install, INSTALL);
});

afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.lifecycle.shutdown();
    o.db.close();
  }
  rmSync(root, { recursive: true, force: true });
});

interface Harness {
  readonly lifecycle: RunLifecycle;
  readonly ledger: Ledger;
  readonly db: Database.Database;
  readonly dataDir: string;
}

function controller(withRunner = true): Harness {
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = openLedger(path.join(root, "ledger.sqlite"));
  const ids = createIdGenerator();
  const ledger = createLedger(db, { ids });
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  const lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(new FakeAdapter({ script, commitChannel: "none", timeouts: PATIENT })),
    allowedRoots: [root],
    globalConcurrency: 2,
    resolveProfile: () => PROFILE,
    ...(withRunner
      ? {
          projectSetup: createProjectSetup({
            dataDir,
            baseEnv: { PATH: process.env.PATH, HOME: "/home/operator", SB_PLANTED_SECRET: "planted" },
            wrap: (argv, socketPath) => bridgeOnly(socketPath, process.execPath, argv),
            killGraceMs: 200,
          }),
        }
      : {}),
  });
  lifecycle.start();
  open.push({ lifecycle, db });
  return { lifecycle, ledger, db, dataDir };
}

const project = (setup?: ProjectSnapshot["setup"]): ProjectSnapshot => ({
  id: "web",
  name: "Web",
  environment_kind: "host",
  context_id: "main",
  base_ref: "main",
  effective_max_profile: "trusted-development",
  writable: true,
  ...(setup !== undefined ? { setup } : {}),
});
const SETUP = (timeout = 60): NonNullable<ProjectSnapshot["setup"]> => ({
  commands: [[process.execPath, install]],
  network_hosts: ["registry.npmjs.org"],
  cache: "pnpm",
  timeout_seconds: timeout,
  env: {},
});

async function until(what: string, cond: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const TERMINAL: readonly RunState[] = ["SUCCEEDED", "FAILED", "CANCELLED"];
async function runToEnd(h: Harness, p: ProjectSnapshot) {
  const { runId } = await h.lifecycle.submit({
    clientId: "c",
    objective: "do it",
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    project: p,
  });
  await until("the run to end", () => TERMINAL.includes(h.ledger.getRunRecord(runId)?.state as RunState));
  return { runId, run: h.ledger.getRunRecord(runId) };
}

const setupEvents = (h: Harness, runId: string) =>
  h.ledger
    .listRunEvents(runId)
    .filter((e) => e.type === WORKSPACE_SETUP_EVENT)
    .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>)
    .filter((p) => p.phase !== "command_started");
const failedTransition = (h: Harness, runId: string) =>
  h.ledger
    .listRunEvents(runId)
    .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>)
    .find((p) => p.to === "FAILED");

describe("project setup through the run lifecycle (ADR-0071)", () => {
  it("installs before the agent starts: the agent sees the installed file, and nothing is committed from it", async () => {
    const h = controller();
    const { runId, run } = await runToEnd(h, project(SETUP()));
    expect(run?.state).toBe("SUCCEEDED");
    const wt = run?.worktree_path as string;
    expect(readFileSync(path.join(wt, "agent.txt"), "utf8")).toBe("installed\n");
    const events = setupEvents(h, runId);
    expect(events.map((e) => e.phase)).toEqual(["started", "succeeded"]);
    expect(events[1]).toMatchObject({ exit_codes: [0], confined: false, proxy_allowed: 0, proxy_refused: 0 });
    // Codes and numbers only: no argv, path or output in any setup event.
    expect(JSON.stringify(events)).not.toContain(install);
    expect(JSON.stringify(events)).not.toContain("installed");
    const log = h.ledger.listArtifactsForRun(runId).find((a) => a.kind === "setup_log");
    expect(log).toBeDefined();
    const body = JSON.parse(
      (await new ArtifactStore(path.join(h.dataDir, "artifacts")).get(log?.sha256 as string)).toString("utf8"),
    ) as { outcome: string; commands: { stdout: string }[] };
    expect(body.outcome).toBe("succeeded");
    expect(body.commands[0]?.stdout).toBe("installed\n");
    // The run's checkpoint has the agent's file, never the ignored setup output.
    const changed = g(wt, "show", "--name-only", "--format=", "HEAD");
    expect(changed.split("\n")).toEqual(["agent.txt"]);
  });

  it("a project without setup runs exactly as before (no event, no artifact)", async () => {
    const h = controller();
    const { runId, run } = await runToEnd(h, project());
    expect(run?.state).toBe("SUCCEEDED");
    expect(readFileSync(path.join(run?.worktree_path as string, "agent.txt"), "utf8")).toBe("missing\n");
    expect(setupEvents(h, runId)).toEqual([]);
    expect(h.ledger.listArtifactsForRun(runId).some((a) => a.kind === "setup_log")).toBe(false);
  });

  it("a failed setup fails the run before spawn (TOOL_FAILURE, SETUP_FAILED) and leaves the breaker alone", async () => {
    writeFileSync(path.join(repo, "package-lock.json"), "FAIL\n");
    g(repo, "commit", "-q", "-am", "failing lock");
    const h = controller();
    const { runId, run } = await runToEnd(h, project(SETUP()));
    expect(run).toMatchObject({ state: "FAILED", failure_code: "TOOL_FAILURE", started_at: null });
    expect(run?.failure_detail).toContain("SETUP_FAILED");
    expect(run?.failure_detail).toContain("command 0 failed (exit 3)");
    expect(failedTransition(h, runId)).toMatchObject({ reason: "SETUP_FAILED", setup_reason: "command_failed" });
    expect(existsSync(spawned)).toBe(false);
    expect(setupEvents(h, runId).map((e) => e.phase)).toEqual(["started", "failed"]);
    expect(h.ledger.listArtifactsForRun(runId).some((a) => a.kind === "setup_log")).toBe(true);
    // LLD §16.4: a TOOL_FAILURE before the provider ran is neutral for the breaker.
    expect(breakerOutcome(run as NonNullable<typeof run>)).toBe("neutral");
    const health = h.ledger.getProviderHealth("fake");
    expect(health?.consecutive_failures ?? 0).toBe(0);
    expect(health?.breaker_state ?? "CLOSED").toBe("CLOSED");
  });

  it("a setup that outlasts timeout_seconds fails the run with SETUP_TIMEOUT before spawn", async () => {
    writeFileSync(path.join(repo, "package-lock.json"), "SLEEP\n");
    g(repo, "commit", "-q", "-am", "slow lock");
    const h = controller();
    const { runId, run } = await runToEnd(h, project(SETUP(1)));
    expect(run).toMatchObject({ state: "FAILED", failure_code: "TOOL_FAILURE" });
    expect(run?.failure_detail).toContain("SETUP_TIMEOUT");
    expect(failedTransition(h, runId)).toMatchObject({ reason: "SETUP_TIMEOUT", setup_reason: "timeout" });
    expect(existsSync(spawned)).toBe(false);
  });

  it("a run whose project has setup fails closed when no runner is wired", async () => {
    const h = controller(false);
    const { runId, run } = await runToEnd(h, project(SETUP()));
    expect(run).toMatchObject({ state: "FAILED", failure_code: "TOOL_FAILURE" });
    expect(failedTransition(h, runId)).toMatchObject({ reason: "SETUP_FAILED", setup_reason: "unavailable" });
    expect(existsSync(spawned)).toBe(false);
  });
});
