/**
 * ADR-0072 end to end: a run whose provider reported success after a recovered, non-security permission denial
 * SUCCEEDS (finalize-only commit, warnings in the run result, publishable by `publish_run`); a security-class or
 * unclassified denial, a guard verdict, a controller refusal during the run, a Git ref change and a provider failure
 * after a denial still end FAILED as before. The fake adapter's `edit_files` and `git_attempts` plans report the
 * denials (`denials`) and tool calls (`calls`); temporary repositories and a LOCAL bare remote only, no provider CLI.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScenario } from "../adapters/fake/adapter.js";
import { AdapterRegistry, type NormalizedEvent, type ParseState, type ResolvedProfile } from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import type { ResolvedProject } from "../config/index.js";
import { GIT_TOOL_DENIED } from "../git/channel.js";
import {
  GIT_FINALIZE_COMMIT_EVENT,
  GitPublisher,
  GitPusher,
  projectPushContextResolver,
  SECRET_SCAN_HIT_EVENT,
} from "../git/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRecord } from "../ledger/index.js";
import { buildEnvelope } from "../mcp/envelope.js";
import { publishRun } from "../mcp/publish.js";
import type { ProjectSnapshot } from "../policy/index.js";
import { DynamicProjectStore } from "../projects/index.js";
import { WorkspaceManager } from "../workspace/index.js";
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
const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };
const PROFILE: ResolvedProfile = {
  name: "edit-untrusted",
  fileAccess: "worktree",
  shell: "allowlist",
  shellAllowlist: [],
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
  effective_max_profile: "trusted-development",
  writable: true,
  identity: IDENTITY,
  push: { policy: "branch" },
  finalize_commit: true,
};
const RESOLVED: ResolvedProject[] = [
  {
    id: "web",
    name: "Web",
    environment: { kind: "host" },
    contexts: [
      {
        id: "main",
        kind: "repository",
        path: "",
        baseRef: "main",
        primary: true,
        writable: true,
        sign: false,
        finalizeCommit: true,
        identity: IDENTITY,
        push: { policy: "branch", remote: "origin", branchPrefix: "sb/" },
      },
    ],
  } as ResolvedProject,
];

const DENIED_BASH = { tool: "Bash", class: "profile" };
/** The shape of the `rule`-denied command of run_01M5D1YRABBYPBGFGWZGZHT18C (paths synthetic). */
const PROD_RULE_COMMAND =
  'for f in $(git ls-files src | head -20); do echo "$f $(git log -1 --format=%cs -- "$f")"; done; git branch -a';
const plan = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ files: { "README.md": "hello\n" }, summary: "Greet in the README", ...over });

let root: string;
let repo: string;
let bare: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let artifacts: ArtifactStore;
let lifecycle: RunLifecycle | undefined;

/** A fake whose first reported denial also records `type` for the running run, as the controller would mid-run. */
class RecordingFake extends FakeAdapter {
  #done = false;
  constructor(
    scenario: FakeScenario,
    private readonly record: { type: string; payload: Record<string, unknown> } | undefined,
  ) {
    super({ scenario, timeouts: PATIENT, commitChannel: "none" });
  }
  override parseEvent(input: Parameters<FakeAdapter["parseEvent"]>[0], state: ParseState): NormalizedEvent[] {
    const out = super.parseEvent(input, state);
    if (this.record && !this.#done && out.some((e) => e.kind === "permission_denied")) {
      this.#done = true;
      const running = db.prepare("SELECT id FROM run WHERE state = 'RUNNING'").get() as { id: string };
      ledger.appendRunEvent({ runId: running.id, type: this.record.type, payload: this.record.payload });
    }
    return out;
  }
}

function makeLifecycle(scenario: FakeScenario = "edit_files", record?: RecordingFake["record"]): RunLifecycle {
  const ids = createIdGenerator();
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: new AdapterRegistry().register(new RecordingFake(scenario, record)),
    allowedRoots: [root],
    globalConcurrency: 1,
    resolveProfile: () => PROFILE,
    finalizePublisher: new GitPublisher({
      db,
      scratchDir: path.join(dataDir, "git-scratch"),
      allowedStates: ["FINALIZING"],
    }),
  });
  lifecycle.start();
  return lifecycle;
}

async function runOnce(lc: RunLifecycle, objective: string): Promise<{ runId: string; done: RunRecord }> {
  const r = await lc.submit({
    clientId: "c",
    objective,
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: "fake",
    project: PROJECT,
  });
  return { runId: r.runId, done: await lc.waitForTerminal(r.runId) };
}

const events = (runId: string) =>
  ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) }));
const finalizeEvent = (runId: string) => events(runId).find((e) => e.type === GIT_FINALIZE_COMMIT_EVENT)?.p;
const transition = (runId: string, rule: string) =>
  events(runId).find((e) => e.type === "state_transition" && e.p.rule === rule)?.p;
const terminalPayload = (runId: string) =>
  events(runId).findLast((e) => e.type === "state_transition")?.p as Record<string, unknown>;

/** `publish_run` pushes the run's finalize commit to the LOCAL bare remote. */
async function expectPublishable(runId: string): Promise<void> {
  const resolveContext = projectPushContextResolver({
    projects: RESOLVED.map((p) => ({ ...p, contexts: p.contexts.map((c) => ({ ...c, path: repo })) })),
    store: new DynamicProjectStore(db, { ids: createIdGenerator() }),
    clients: new Map(),
  });
  const pusher = new GitPusher({
    db,
    resolveContext,
    sourceEnv: { PATH: process.env.PATH, HOME: path.join(root, "home") },
    ids: createIdGenerator(),
  });
  const published = await publishRun(
    { ledger, artifacts, clientId: "c", clientProjects: ["web"], scrub: (s) => s },
    {
      pusher,
      resolveContext,
      pulls: {
        findForBranch: async () => null,
        create: async () => ({ number: 1, url: "https://github.com/acme/web/pull/1" }),
      },
    },
    ledger.getRunRecord(runId) as RunRecord,
    { openPullRequest: false, draft: true },
  );
  expect(published.publication.reused).toBe(false);
  expect(g(bare, "rev-parse", `refs/heads/${published.publication.branch}`)).toBe(published.publication.head_sha);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-denied-")));
  repo = path.join(root, "repo");
  bare = path.join(root, "remote.git");
  mkdirSync(repo);
  mkdirSync(path.join(root, "home"));
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hi\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  g(root, "init", "-q", "--bare", "-b", "main", bare);
  g(repo, "remote", "add", "origin", bare);
  g(repo, "push", "-q", "origin", "main");
  dataDir = path.join(root, "data");
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  lifecycle = undefined;
});

afterEach(async () => {
  await lifecycle?.shutdown();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("recovered, non-security denials (ADR-0072)", () => {
  it("succeed: T12, finalize commit, warnings in get_run's result, publishable by publish_run", async () => {
    const { runId, done } = await runOnce(
      makeLifecycle(),
      plan({ denials: [DENIED_BASH, DENIED_BASH, { tool: "WebFetch", class: "profile" }] }),
    );
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
    expect(done.failure_code).toBeNull();
    expect(transition(runId, "T12")).toMatchObject({ pending: "success" });
    expect(finalizeEvent(runId)).toMatchObject({ outcome: "committed" });
    const warnings = [
      { code: "PERMISSION_DENIED_RECOVERED", tool: "Bash", count: 2 },
      { code: "PERMISSION_DENIED_RECOVERED", tool: "WebFetch", count: 1 },
    ];
    expect(terminalPayload(runId).warnings).toEqual(warnings);
    // The provider events keep the closed class, never text.
    expect(events(runId).filter((e) => e.p.kind === "permission_denied")).toEqual([
      { type: "provider_event", p: { kind: "permission_denied", denial: "profile" } },
      { type: "provider_event", p: { kind: "permission_denied", denial: "profile" } },
      { type: "provider_event", p: { kind: "permission_denied", denial: "profile" } },
    ]);
    const envelope = buildEnvelope(ledger, ledger.getRunRecord(runId) as RunRecord, (s) => s);
    expect(envelope.status).toBe("SUCCEEDED");
    expect(envelope.result.warnings).toEqual(warnings);

    await expectPublishable(runId);
  });

  it("prod shape (run_01M5D1YR...): 4 dontAsk Bash denials + a Git deny-rule hit on a read-only loop -> SUCCEEDED", async () => {
    // ADR-0072 follow-up: the `rule` denial's command was a `git log` loop plus `git branch -a`; the guard sees the
    // same command and finds no Git write.
    const calls = [{ tool: "shell", name: "Bash", command: PROD_RULE_COMMAND }];
    const denials = [DENIED_BASH, DENIED_BASH, DENIED_BASH, DENIED_BASH, { tool: "Bash", class: "git_rule_local" }];
    const { runId, done } = await runOnce(makeLifecycle(), plan({ calls, denials }));
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
    expect(finalizeEvent(runId)).toMatchObject({ outcome: "committed" });
    const warnings = [
      { code: "PERMISSION_DENIED_RECOVERED", tool: "Bash", count: 4 },
      { code: "GIT_RULE_DENIED_RECOVERED", tool: "Bash", count: 1 },
    ];
    expect(terminalPayload(runId).warnings).toEqual(warnings);
    expect(buildEnvelope(ledger, done, (s) => s).result.warnings).toEqual(warnings);
    await expectPublishable(runId);
  });

  it("a run without denials records no warnings", async () => {
    const { runId, done } = await runOnce(makeLifecycle(), plan());
    expect(done.state).toBe("SUCCEEDED");
    expect(terminalPayload(runId).warnings).toBeUndefined();
    expect(buildEnvelope(ledger, done, (s) => s).result.warnings).toBeUndefined();
  });
});

describe("security-class or unclassified denials still fail (ADR-0072)", () => {
  const failsAsToday = async (
    objective: string,
    code: "PERMISSION_BLOCKED" | "SANDBOX_VIOLATION",
    detail: RegExp,
    lc: RunLifecycle = makeLifecycle(),
  ) => {
    const { runId, done } = await runOnce(lc, objective);
    expect(done.state).toBe("FAILED");
    expect(done.failure_code).toBe(code);
    expect(done.failure_detail).toMatch(detail);
    expect(finalizeEvent(runId)).toEqual({ outcome: "skipped", reason: "run_not_succeeded" });
    expect(terminalPayload(runId).warnings).toBeUndefined();
    return runId;
  };

  it("Git deny rule (FR-GIT-01 class)", async () => {
    await failsAsToday(
      plan({ denials: [DENIED_BASH, { tool: "Bash", class: "git_write" }] }),
      "PERMISSION_BLOCKED",
      /^denied: Bash$/,
    );
  });

  it("git push the tool-call guard sees, even when the provider called the denial ordinary", async () => {
    const calls = [{ tool: "shell", name: "Bash", command: "git push origin HEAD:main" }];
    await failsAsToday(plan({ calls, denials: [DENIED_BASH] }), "PERMISSION_BLOCKED", /^git write attempted/);
  });

  it("write outside the worktree", async () => {
    await failsAsToday(
      plan({ denials: [{ tool: "Write", class: "outside_worktree" }] }),
      "PERMISSION_BLOCKED",
      /^denied: Write$/,
    );
  });

  it("credential read (a provider credential directory, FR-AUTH-01)", async () => {
    const calls = [{ tool: "shell", name: "Bash", command: "cat ~/.claude/.credentials.json" }];
    await failsAsToday(plan({ calls, denials: [DENIED_BASH] }), "SANDBOX_VIOLATION", /^provider state reached/);
  });

  it("unknown class (fail closed)", async () => {
    await failsAsToday(plan({ denials: [DENIED_BASH, { tool: "Bash" }] }), "PERMISSION_BLOCKED", /^denied: Bash$/);
  });

  it("secret scan block recorded during the run", async () => {
    const lc = makeLifecycle("edit_files", {
      type: SECRET_SCAN_HIT_EVENT,
      payload: { stage: "push", rule_id: "github_token", path: "a.txt", line: 1 },
    });
    const runId = await failsAsToday(plan({ denials: [DENIED_BASH] }), "PERMISSION_BLOCKED", /secret scan block/, lc);
    expect(transition(runId, "T13")).toMatchObject({ pending: "failure", failure_code: "PERMISSION_BLOCKED" });
  });

  it("a commit-stage secret-scan warning does not block (it is a warning, not a refusal)", async () => {
    const lc = makeLifecycle("edit_files", {
      type: SECRET_SCAN_HIT_EVENT,
      payload: { stage: "commit", rule_id: "github_token", path: "a.txt", line: 1 },
    });
    const { done } = await runOnce(lc, plan({ denials: [DENIED_BASH] }));
    expect(done.state).toBe("SUCCEEDED");
  });

  it("tool-channel refusal recorded during the run (path outside the worktree, push refused, ...)", async () => {
    const lc = makeLifecycle("edit_files", { type: GIT_TOOL_DENIED, payload: { code: "PATH_OUTSIDE_WORKTREE" } });
    await failsAsToday(plan({ denials: [DENIED_BASH] }), "PERMISSION_BLOCKED", /tool channel refusal/, lc);
  });

  it("Git refs changed by the agent (FR-GIT-03)", async () => {
    const attempts = JSON.stringify({
      steps: [
        { op: "write", path: "evil.txt", content: "x\n" },
        { op: "branch", name: "agent-branch" },
      ],
      denials: [DENIED_BASH],
    });
    const runId = await failsAsToday(attempts, "PERMISSION_BLOCKED", /git refs changed/, makeLifecycle("git_attempts"));
    expect(transition(runId, "T12")).toMatchObject({ pending: "success" });
  });

  it("Git refs changed after a recovered local Git deny-rule hit (ADR-0072 follow-up, FR-GIT-03)", async () => {
    const attempts = JSON.stringify({
      steps: [{ op: "branch", name: "agent-branch" }],
      denials: [{ tool: "Bash", class: "git_rule_local" }],
    });
    await failsAsToday(
      attempts,
      "PERMISSION_BLOCKED",
      /^denied: Bash; git refs changed$/,
      makeLifecycle("git_attempts"),
    );
  });
});

describe("provider failure after a denial (ADR-0072 item 3)", () => {
  it("still fails as before", async () => {
    const { runId, done } = await runOnce(makeLifecycle(), plan({ denials: [DENIED_BASH], ok: false }));
    expect(done.state).toBe("FAILED");
    expect(done.failure_code).toBe("PERMISSION_BLOCKED");
    expect(transition(runId, "T13")).toMatchObject({ pending: "failure" });
    expect(finalizeEvent(runId)).toEqual({ outcome: "skipped", reason: "run_not_succeeded" });
  });
});
