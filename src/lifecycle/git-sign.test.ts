/**
 * T9.10 end to end (FR-GIT-10, FRD BR-33, BR-31, LLD §12.3.1): a project context with `sign: true`, through the run
 * lifecycle, on both controller-side commit paths (the injected `commit` tool via the real shim, and finalize-only).
 * Only a THROWAWAY unprotected GnuPG key in a temporary `GNUPGHOME` and a temporary `HOME` is used
 * (`src/git/fixtures/throwaway-gpg.ts`); the signing cases skip cleanly when `gpg` is not installed. The agent-variable
 * values put into the controller's environment are dummies (no agent socket exists at those paths).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScenario } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { GitToolService } from "../git/channel.js";
import { createThrowawaySigner, gpgAvailable, type ThrowawaySigner } from "../git/fixtures/throwaway-gpg.js";
import { GIT_FINALIZE_COMMIT_EVENT, GitPublisher, publishRefFor } from "../git/index.js";
import { SIGNING_AGENT_VARIABLES } from "../git/sign.js";
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

const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };
const NO_SHELL: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
};
const BROAD_SHELL: ResolvedProfile = { ...NO_SHELL, name: "trusted-development", shell: "broad" };

const COMMIT_PLAN = JSON.stringify({
  report_env: true,
  files: { "feature.txt": "a signed feature\n" },
  calls: [{ name: "commit", arguments: { message: "Add the signed feature", paths: ["feature.txt"] } }],
});
const FINALIZE_PLAN = JSON.stringify({ files: { "README.md": "hello\n" }, summary: "Greet in the README" });

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let artifacts: ArtifactStore;
let lifecycle: RunLifecycle | undefined;
let service: GitToolService | undefined;
let profile: ResolvedProfile;

function project(over: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    id: "web",
    name: "Web",
    environment_kind: "host",
    context_id: "main",
    base_ref: "main",
    effective_max_profile: "trusted-development",
    writable: true,
    identity: IDENTITY,
    push: { policy: "none" },
    sign: true,
    ...over,
  };
}

function start(scenario: FakeScenario, channel: "injected" | "none"): RunLifecycle {
  const ids = createIdGenerator();
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  if (channel === "injected") {
    service = new GitToolService({
      db,
      dataDir,
      publisher: new GitPublisher({ db, scratchDir: path.join(dataDir, "git-scratch") }),
      shimCommand: SHIM_COMMAND,
      fallbackDirs: [root],
    });
  }
  lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(new FakeAdapter({ scenario, timeouts: PATIENT, commitChannel: channel })),
    allowedRoots: [root],
    globalConcurrency: 1,
    resolveProfile: () => profile,
    finalizePublisher: new GitPublisher({
      db,
      scratchDir: path.join(dataDir, "git-scratch-fin"),
      allowedStates: ["FINALIZING"],
    }),
    ...(service ? { gitTools: service } : {}),
  });
  lifecycle.start();
  return lifecycle;
}

async function run(lc: RunLifecycle, objective: string, p: ProjectSnapshot) {
  const r = await lc.submit({
    clientId: "c",
    objective,
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    project: p,
  });
  return { ...r, done: await lc.waitForTerminal(r.runId) };
}

const events = (runId: string) =>
  ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) as Record<string, unknown> }));

async function stdoutOf(runId: string): Promise<string> {
  const row = db.prepare("SELECT sha256 FROM artifact WHERE run_id = ? AND kind = 'provider_stdout'").get(runId) as {
    sha256: string;
  };
  return (await artifacts.get(row.sha256)).toString("utf8");
}

/** The JSON payloads of the fake provider's `message` events. */
async function messages(runId: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const line of (await stdoutOf(runId)).split("\n")) {
    try {
      const ev = JSON.parse(line) as { type?: string; text?: string };
      if (ev.type === "message" && typeof ev.text === "string") out.push(JSON.parse(ev.text));
    } catch {
      // not a message line
    }
  }
  return out;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-lsign-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hi\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  lifecycle = undefined;
  service = undefined;
  profile = NO_SHELL;
});

afterEach(async () => {
  await lifecycle?.shutdown();
  await service?.closeAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("signing refused where BR-31 withholds push (no key needed)", () => {
  it("a host run with a broad shell gets SIGNING_FAILED from commit; nothing is committed or published", async () => {
    profile = BROAD_SHELL;
    const { runId, metaSessionId, done } = await run(start("git_commit", "injected"), COMMIT_PLAN, project());
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
    expect(await messages(runId)).toContainEqual({ call: "commit", error: "SIGNING_FAILED" });
    expect(refSha(repo, publishRefFor(metaSessionId))).toBe("");
    const ev = events(runId);
    expect(ev.some((e) => e.type === "git_commit_intent")).toBe(false);
    expect(ev.find((e) => e.type === "git_commit_signing_failed")?.p).toEqual({
      origin: "commit_tool",
      reason: "credential_reach",
      credential_reach: "shell_broad",
    });
    expect(ev.find((e) => e.type === "git_tool_denied")?.p).toMatchObject({ code: "SIGNING_FAILED" });
  });

  it("finalize-only with a broad shell records SIGNING_FAILED and publishes nothing", async () => {
    profile = BROAD_SHELL;
    const p = project({ finalize_commit: true });
    const { runId, metaSessionId, done } = await run(start("edit_files", "none"), FINALIZE_PLAN, p);
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
    expect(events(runId).find((e) => e.type === GIT_FINALIZE_COMMIT_EVENT)?.p).toEqual({
      outcome: "failed",
      reason: "SIGNING_FAILED",
    });
    expect(refSha(repo, publishRefFor(metaSessionId))).toBe("");
  });
});

describe.skipIf(!gpgAvailable())("signed commits through the lifecycle (throwaway GnuPG key)", () => {
  let signer: ThrowawaySigner;
  const saved: Record<string, string | undefined> = {};
  const CONTROLLER_VARS = ["HOME", "GNUPGHOME", "SSH_AUTH_SOCK", "GPG_AGENT_INFO", "XDG_CONFIG_HOME"];

  beforeEach(() => {
    signer = createThrowawaySigner();
    for (const k of CONTROLLER_VARS) saved[k] = process.env[k];
    // The controller process has the operator's signing variables (here: throwaway values and dummies).
    process.env.HOME = signer.home;
    process.env.GNUPGHOME = signer.gnupgHome;
    process.env.SSH_AUTH_SOCK = path.join(root, "no-such-agent.sock");
    process.env.GPG_AGENT_INFO = path.join(root, "no-such-gpg-agent:0:1");
    delete process.env.XDG_CONFIG_HOME;
  });
  afterEach(() => {
    for (const k of CONTROLLER_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    signer.dispose();
  });

  it("the commit tool's commit is signed and verifies; the provider never had the key or agent variables", async () => {
    const { runId, metaSessionId, done } = await run(start("git_commit", "injected"), COMMIT_PLAN, project());
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
    const sha = refSha(repo, publishRefFor(metaSessionId));
    expect(sha).toMatch(/^[0-9a-f]{40}$/u);
    execFileSync("git", ["verify-commit", sha], { cwd: repo, env: signer.verifyEnv, stdio: "ignore" });
    expect(
      execFileSync("git", ["log", "-1", "--format=%G?|%GF", sha], {
        cwd: repo,
        env: signer.verifyEnv,
        encoding: "utf8",
      }).trim(),
    ).toBe(`G|${signer.fingerprint}`);
    expect(g(repo, "log", "-1", "--format=%B", sha)).toBe("Add the signed feature");

    // Environment inspection: the controller has every signing variable, the provider process has none of them.
    for (const v of ["GNUPGHOME", "SSH_AUTH_SOCK", "GPG_AGENT_INFO", "HOME"]) expect(process.env[v]).toBeTruthy();
    const report = (await messages(runId)).find((m) => Array.isArray(m.env_names));
    expect(report, "the fake provider must report its environment").toBeDefined();
    const names = report?.env_names as string[];
    for (const v of SIGNING_AGENT_VARIABLES) expect(names).not.toContain(v);
    expect(names).not.toContain("HOME");
    expect(names.filter((n) => n.startsWith("GPG") || n.startsWith("GNUPG") || n.startsWith("SSH_"))).toEqual([]);
    expect(await messages(runId)).toContainEqual(expect.objectContaining({ call: "commit", sha }));
    expect(events(runId).find((e) => e.type === "git_commit")?.p).toMatchObject({ signed: true });
  });

  it("finalize-only signs its commit too", async () => {
    const p = project({ finalize_commit: true });
    const { runId, metaSessionId, done } = await run(start("edit_files", "none"), FINALIZE_PLAN, p);
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
    const sha = refSha(repo, publishRefFor(metaSessionId));
    expect(events(runId).find((e) => e.type === GIT_FINALIZE_COMMIT_EVENT)?.p).toMatchObject({
      outcome: "committed",
      commit_sha: sha,
    });
    execFileSync("git", ["verify-commit", sha], { cwd: repo, env: signer.verifyEnv, stdio: "ignore" });
  });

  it("a signing failure on the commit tool path is SIGNING_FAILED and leaves the publish ref unchanged", async () => {
    writeFileSync(
      path.join(signer.home, ".gitconfig"),
      "[user]\n\tsigningkey = 0000000000000000000000000000000000000000\n",
    );
    const { runId, metaSessionId, done } = await run(start("git_commit", "injected"), COMMIT_PLAN, project());
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
    expect(await messages(runId)).toContainEqual({ call: "commit", error: "SIGNING_FAILED" });
    expect(refSha(repo, publishRefFor(metaSessionId))).toBe("");
    expect(events(runId).find((e) => e.type === "git_commit_signing_failed")?.p).toEqual({
      origin: "commit_tool",
      reason: "sign_failed",
    });
  });

  it("without sign the same operator setup is not used: the published commit is unsigned", async () => {
    const { sign: _off, ...unsigned } = project();
    const { metaSessionId, done } = await run(start("git_commit", "injected"), COMMIT_PLAN, unsigned);
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
    const sha = refSha(repo, publishRefFor(metaSessionId));
    expect(g(repo, "cat-file", "commit", sha)).not.toContain("gpgsig");
  });
});
