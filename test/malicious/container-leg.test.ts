/**
 * Container leg of the NFR-SEC-03 malicious-fixture suite (T10.3; FR-GIT-01, FR-GIT-03, FR-PRJ-05, FR-WS-05; owner
 * decision 24). Runs in CI with no container runtime: the real lifecycle admits an approved `privileged` scope with
 * `bypass: true` (ADR-0017, approved by client policy, ADR-0019) under a `container` project, and the real
 * `createContainerEnvironment` prepares it over an EMULATED rootless runtime. The emulation records the run spec the
 * environment hands a runtime and starts the agent with an empty `PATH`, which is what an image without a Git client
 * gives it (ADR-0020); it cannot emulate the mount namespace, so the agent here only acts inside the worktree, the one
 * writable mount. Reaching host paths outside the mounts is the opt-in Docker leg (`container-docker-leg.test.ts`).
 *
 * The agent is the fake CLI's `git_attempts` scenario: every plain Git write it knows (commit, branch, tag, update-ref
 * of the operator's branch and of the run branch, push, reset, checkout -b), plus rewriting the worktree's `.git` link
 * so that the controller's own Git would follow it into the operator's repository. Shown here:
 * - the spec mounts the worktree (rw) and the declared context (ro) only; no repository, Git directory, data directory,
 *   home or runtime socket; host-only environment names and the canary variable are not forwarded;
 * - every Git write attempt fails for want of a Git client, and every ref, `HEAD`, the index, the configuration, the
 *   hooks and the remote stay unchanged; the run branch moves only by the controller's checkpoint;
 * - a rewritten `.git` link is recorded as a Git policy violation and put back before any controller Git runs in the
 *   worktree, so the checkpoint lands on the run branch and the operator's checkout is untouched;
 * - no hook, filter driver or repository agent configuration ran, and no canary token reached the ledger;
 * - the container is removed at run end.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake/adapter.js";
import {
  AdapterRegistry,
  type CompileRequest,
  type ProviderAdapter,
  type ResolvedProfile,
} from "../../src/adapters/index.js";
import { ArtifactStore } from "../../src/artifacts/index.js";
import {
  type ContainerRunSpec,
  type ContainerRuntime,
  createContainerEnvironment,
  type Environment,
  type EnvironmentEvent,
  type RunContext,
} from "../../src/environment/index.js";
import { GIT_POLICY_VIOLATION_EVENT, type ViolationEntry } from "../../src/git/index.js";
import { createIdGenerator } from "../../src/ids/index.js";
import { createLedger, type Ledger, openLedger } from "../../src/ledger/index.js";
import { RunLifecycle } from "../../src/lifecycle/index.js";
import type { ProjectSnapshot } from "../../src/policy/index.js";
import { WorkspaceManager } from "../../src/workspace/index.js";
import { findTokens, ledgerDump, operatorState, readIfExists, refs } from "./detectors.js";
import { buildMaliciousFixture, type MaliciousFixture, tg } from "./fixture.js";

const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const IMAGE_ID = `sha256:${"e".repeat(64)}`;
/** An approved bypass scope with the network on: the widest scope an operator can approve (ADR-0017). */
const BYPASS_SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "broad" },
  network: { mode: "on" },
  repository_config: { mode: "disabled" },
  bypass: true,
};

/**
 * Stands in for a real adapter's bypass compile (the fake CLI has no privileged mode, as in the lifecycle tests): it
 * records the profile dispatch hands it, then compiles the `git_attempts` scenario.
 */
class BypassStandIn implements ProviderAdapter {
  readonly id = "fake" as const;
  readonly transports = ["subprocess-jsonl"] as const;
  readonly gitWriteControl = new FakeAdapter().gitWriteControl;
  readonly resumeCwd = "bound" as const;
  readonly gitCapabilities = { commitChannel: "none", detail: "test double" } as const;
  readonly profiles: ResolvedProfile[] = [];
  private readonly base = new FakeAdapter({ scenario: "git_attempts", timeouts: PATIENT });
  probe: ProviderAdapter["probe"] = (r) => this.base.probe(r);
  authPreflight: ProviderAdapter["authPreflight"] = (r) => this.base.authPreflight(r);
  compile(req: CompileRequest, profile: ResolvedProfile) {
    this.profiles.push(profile);
    return this.base.compile(req, { ...profile, name: "edit-untrusted", bypassApproved: false });
  }
  parseEvent: ProviderAdapter["parseEvent"] = (i, s) => this.base.parseEvent(i, s);
  extractResult: ProviderAdapter["extractResult"] = (e, x) => this.base.extractResult(e, x);
  resumeArgs: ProviderAdapter["resumeArgs"] = (b, r, p) => this.base.resumeArgs(b, r, p);
  classifyFailure: ProviderAdapter["classifyFailure"] = (e) => this.base.classifyFailure(e);
}

/**
 * A rootless runtime emulated on the host: the image is "present" and has no Git client; `runArgv` records the spec
 * and starts the provider's own argv with `PATH` set to an empty directory (no `git` or `gh` resolves), `node` mapped
 * back to this Node executable, in the worktree (the supervisor's `cwd`, the same path as inside a real container).
 */
function emulatedRuntime(emptyBin: string): ContainerRuntime & { specs: ContainerRunSpec[]; removed: string[] } {
  const specs: ContainerRunSpec[] = [];
  const removed: string[] = [];
  return {
    name: "emulated",
    specs,
    removed,
    clientEnvAllowlist: [],
    info: () =>
      Promise.resolve({
        available: true,
        rootless: true,
        serverVersion: "emulated",
        clientPath: null,
        detail: "emulated rootless runtime",
      }),
    resolveImage: () => Promise.resolve({ kind: "found", imageId: IMAGE_ID }),
    scanImageForGitClient: () =>
      Promise.resolve({ completed: true, found: [], detail: "no git or gh executable on the image PATH" }),
    runArgv: (spec) => {
      specs.push(spec);
      const [exe = "", ...rest] = spec.argv;
      return [
        "/usr/bin/env",
        `PATH=${emptyBin}`,
        exe === path.basename(process.execPath) ? process.execPath : exe,
        ...rest,
      ];
    },
    inspect: () => Promise.resolve(null),
    remove: (name) => {
      removed.push(name);
      return Promise.resolve({ removed: specs.some((s) => s.name === name) });
    },
    listByLabel: () => Promise.resolve([]),
  };
}

let fx: MaliciousFixture;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle | undefined;
let docs: string;
let runtime: ReturnType<typeof emulatedRuntime>;
let adapter: BypassStandIn;
let contexts: RunContext[];
let envEvents: EnvironmentEvent[];

beforeEach(() => {
  fx = buildMaliciousFixture();
  docs = path.join(fx.allowedRoot, "docs");
  mkdirSync(docs);
  writeFileSync(path.join(docs, "guide.md"), "read-only context\n");
  const emptyBin = path.join(fx.base, "image-bin");
  mkdirSync(emptyBin);
  runtime = emulatedRuntime(emptyBin);
  adapter = new BypassStandIn();
  contexts = [];
  envEvents = [];
  db = openLedger(fx.dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  db.close();
  fx.close();
});

const project = (): ProjectSnapshot => ({
  id: "hostile",
  name: "Hostile",
  environment_kind: "container",
  image_digest: IMAGE_ID,
  context_id: "main",
  base_ref: "main",
  effective_max_profile: "privileged",
});

function start(): RunLifecycle {
  const ids = createIdGenerator();
  const artifacts = new ArtifactStore(path.join(fx.dataDir, "artifacts"));
  const inner = createContainerEnvironment({ runtime, onEvent: (e) => envEvents.push(e) });
  const container: Environment = {
    ...inner,
    prepare: (run, inv) => {
      contexts.push(run);
      return inner.prepare(run, inv);
    },
  };
  lifecycle = new RunLifecycle({
    ledger,
    workspace: new WorkspaceManager({ db, artifacts, dataDir: fx.dataDir, allowedRoots: [fx.allowedRoot], ids }),
    artifacts,
    adapters: new AdapterRegistry().register(adapter),
    allowedRoots: [fx.allowedRoot],
    globalConcurrency: 1,
    resolveProfile: () => {
      throw new Error("a privileged run resolves only through its scope");
    },
    environments: {
      resolve: (p) =>
        p?.environment_kind === "container"
          ? { environment: container, readOnlyContexts: [{ id: "docs", path: docs }], limits: { memoryMb: 256 } }
          : undefined,
    },
  });
  lifecycle.start();
  return lifecycle;
}

type Step = Record<string, unknown> & { op: string };

async function bypassRun(steps: Step[]) {
  const l = start();
  const { runId } = await l.submit({
    clientId: "orchestrator",
    objective: JSON.stringify({ steps }),
    workspace: fx.repo,
    trustProfile: "privileged",
    privileged: { scope: BYPASS_SCOPE, approvedByClientPolicy: true },
    provider: "fake",
    project: project(),
  });
  const final = await l.waitForTerminal(runId);
  await l.shutdown();
  lifecycle = undefined;
  return { runId, final, run: ledger.getRunRecord(runId) };
}

const events = (runId: string) =>
  ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) as Record<string, unknown> }));
const violationsOf = (runId: string): ViolationEntry[] =>
  events(runId)
    .filter((e) => e.type === GIT_POLICY_VIOLATION_EVENT)
    .flatMap((e) => e.p.violations as ViolationEntry[]);

/** The `{op, rc}` messages the fake agent printed, from the stored provider stdout. */
async function stepResults(runId: string): Promise<Array<{ op: string; rc: number }>> {
  const terminal = events(runId).find((e) => e.type === "state_transition" && e.p.to === "SUCCEEDED");
  const id = (terminal?.p.artifacts as Record<string, string> | undefined)?.provider_stdout;
  const row = id === undefined ? undefined : ledger.getArtifact(id);
  if (!row) throw new Error("no provider stdout stored");
  const text = (await new ArtifactStore(path.join(fx.dataDir, "artifacts")).get(row.sha256)).toString("utf8");
  const out: Array<{ op: string; rc: number }> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const ev = JSON.parse(line) as { type?: string; text?: string };
    if (ev.type !== "message" || ev.text === undefined) continue;
    const msg = JSON.parse(ev.text) as { op?: string; rc?: number };
    if (typeof msg.op === "string" && typeof msg.rc === "number") out.push({ op: msg.op, rc: msg.rc });
  }
  return out;
}

/** Nothing the fixture plants as a trap ran, and no canary token reached the ledger. */
function expectNoTrapFired(): void {
  expect(readIfExists(fx.hookLog)).toBe("");
  expect(readIfExists(fx.filterLog)).toBe("");
  expect(readIfExists(fx.configLog)).toBe("");
  expect(findTokens(fx, ledgerDump(db))).toEqual([]);
}

describe("NFR-SEC-03 container leg: approved bypass scope in a container environment (T10.3)", () => {
  it("every Git-write attempt fails for want of a Git client and leaves every ref unchanged", async () => {
    const before = operatorState(fx);
    const allBefore = refs(fx.repo);
    const remoteBefore = refs(fx.remote);
    const { runId, final, run } = await bypassRun([
      { op: "write", path: "agent.txt", content: "agent work\n" },
      { op: "commit", message: "agent commit" },
      { op: "branch", name: "agent-branch" },
      { op: "tag", name: "agent-tag" },
      { op: "update_ref", ref: "refs/heads/main", to: "HEAD" },
      { op: "delete_ref", ref: "refs/heads/main" },
      { op: "update_ref", ref: "@run_branch", to: "HEAD" },
      { op: "push", remote: "origin", refspec: "HEAD:refs/heads/main" },
      { op: "reset_hard", to: "HEAD" },
      { op: "checkout_new", name: "agent-side" },
    ]);
    expect(final.state, final.failure_detail ?? "").toBe("SUCCEEDED");

    // Dispatch handed the adapter the approved bypass scope (owner decision 24: the boundary must not rest on it).
    expect(adapter.profiles).toHaveLength(1);
    expect(adapter.profiles[0]).toMatchObject({ name: "privileged", bypassApproved: true });
    expect(contexts[0]?.profile).toMatchObject({ name: "privileged", bypassApproved: true });

    // Every Git command failed to start: no Git client on the image PATH (-1: the executable was not found).
    const results = await stepResults(runId);
    expect(results.map((r) => r.op)).toEqual([
      "write",
      "commit",
      "branch",
      "tag",
      "update_ref",
      "delete_ref",
      "update_ref",
      "push",
      "reset_hard",
      "checkout_new",
    ]);
    expect(results.filter((r) => r.op !== "write").every((r) => r.rc === -1)).toBe(true);

    // FR-GIT-01 by construction: every ref of the repository and the remote is unchanged, except the run branch,
    // which only the controller's checkpoint moved, onto the pre-run commit; the operator's checkout is untouched.
    expect(operatorState(fx)).toEqual(before);
    expect(refs(fx.remote)).toEqual(remoteBefore);
    const runBranch = `refs/heads/${run?.branch ?? ""}`;
    const after = refs(fx.repo);
    expect({ ...after, [runBranch]: "" }).toEqual({ ...allBefore, [runBranch]: "" });
    const pre = ledger.getRunCheckpointCommit(runId, "pre") as string;
    const post = ledger.getRunCheckpointCommit(runId, "post") as string;
    expect(after[runBranch]).toBe(post);
    expect(tg(fx.repo, "rev-parse", `${post}^`)).toBe(pre);
    expect(tg(fx.repo, "log", "-1", "--format=%ae", post)).toBe("switchboard@localhost");
    expect(tg(fx.repo, "show", `${post}:agent.txt`)).toBe("agent work");
    expect(violationsOf(runId)).toEqual([]);
    expect(events(runId).find((e) => e.type === "git_ref_check")?.p).toMatchObject({ result: "clean" });

    // FR-PRJ-05: the spec the runtime received mounts the worktree (rw) and the declared context (ro) only.
    expect(runtime.specs).toHaveLength(1);
    const spec = runtime.specs[0] as ContainerRunSpec;
    const worktree = contexts[0]?.worktreePath as string;
    expect(spec.mounts).toEqual([
      { source: worktree, target: worktree, readonly: false },
      { source: docs, target: docs, readonly: true },
    ]);
    const forbidden = [fx.repo, path.join(fx.repo, ".git"), fx.dataDir, fx.fakeHome, fx.remote, fx.outsideDir];
    for (const m of spec.mounts) {
      for (const f of forbidden) {
        expect(m.source === f || f.startsWith(`${m.source}${path.sep}`), `${m.source} exposes ${f}`).toBe(false);
      }
      expect(m.source).not.toMatch(/docker\.sock|podman\.sock|containerd/);
    }
    expect(worktree.startsWith(`${fx.dataDir}${path.sep}`)).toBe(true);
    expect(spec.workdir).toBe(worktree);
    expect(spec.network).toBe("default"); // the approved scope's network `on`, as the owner decided
    expect(spec.labels).toMatchObject({ "switchboard.run": runId, "switchboard.project": "hostile" });
    for (const name of ["HOME", "SSH_AUTH_SOCK", "GPG_AGENT_INFO", "DOCKER_HOST", fx.envCanaryName]) {
      expect(spec.forwardEnv).not.toContain(name);
    }
    // Removed at run end (teardown), run container and probe both.
    expect(runtime.removed).toEqual([`switchboard-run-${runId}`, `switchboard-probe-${runId}`]);
    expect(envEvents.map((e) => e.payload.step)).toEqual(["image_checked", "prepared", "removed"]);
    expectNoTrapFired();
  });

  it("a rewritten .git link is a recorded violation and is put back before controller Git follows it", async () => {
    const before = operatorState(fx);
    const allBefore = refs(fx.repo);
    const { runId, final, run } = await bypassRun([
      { op: "write", path: "agent.txt", content: "agent work\n" },
      // The worktree's link names the operator repository's worktree entry; the agent points it at the Git directory
      // itself, so a controller `add -A` + `commit` in the worktree would land on the operator's checked-out branch.
      { op: "write", path: ".git", content: `gitdir: ${path.join(fx.repo, ".git")}\n` },
    ]);
    expect(final.state, final.failure_detail ?? "").toBe("SUCCEEDED");
    expect(violationsOf(runId)).toEqual([
      expect.objectContaining({ scope: "worktree_link", kind: "link_changed", action: "restore" }),
    ]);
    expect(events(runId).find((e) => e.type === "git_ref_check")?.p).toMatchObject({
      result: "violation",
      restored: [{ scope: "worktree_link", ok: true }],
    });
    expect(events(runId).find((e) => e.p.to === "SUCCEEDED")?.p).toMatchObject({ git_policy_violation: true });

    expect(operatorState(fx)).toEqual(before);
    const runBranch = `refs/heads/${run?.branch ?? ""}`;
    const after = refs(fx.repo);
    expect({ ...after, [runBranch]: "" }).toEqual({ ...allBefore, [runBranch]: "" });
    const post = ledger.getRunCheckpointCommit(runId, "post") as string;
    expect(after[runBranch]).toBe(post);
    expect(tg(fx.repo, "rev-parse", `${post}^`)).toBe(ledger.getRunCheckpointCommit(runId, "pre"));
    expect(tg(fx.repo, "show", `${post}:agent.txt`)).toBe("agent work");
    // The link is the worktree's own again.
    const worktree = contexts[0]?.worktreePath as string;
    expect(readFileSync(path.join(worktree, ".git"), "utf8")).toMatch(/^gitdir: .*\/\.git\/worktrees\/[^/]+\n$/);
    expect(tg(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(run?.branch);
    expectNoTrapFired();
  });

  it("a .git link replaced by unreadable content is restored the same way; a nested repository stays content only", async () => {
    const before = operatorState(fx);
    const { runId, final, run } = await bypassRun([
      { op: "write", path: "vendor/lib/.git/HEAD", content: "ref: refs/heads/main\n" },
      { op: "write", path: "vendor/lib/.git/refs/heads/main", content: `${fx.baseCommit}\n` },
      { op: "write", path: ".git", content: "not a link\n" },
    ]);
    expect(final.state, final.failure_detail ?? "").toBe("SUCCEEDED");
    expect(violationsOf(runId).map((v) => [v.scope, v.kind])).toEqual([["worktree_link", "link_changed"]]);
    expect(operatorState(fx)).toEqual(before);
    const worktree = contexts[0]?.worktreePath as string;
    expect(tg(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(run?.branch);
    // Q-31 / ADR-0022: the nested repository the agent made is skipped by the checkpoint, never followed.
    expect(events(runId).find((e) => e.p.to === "SUCCEEDED")?.p).toMatchObject({
      nested_repositories_skipped: ["vendor/lib"],
    });
    expectNoTrapFired();
  });
});
