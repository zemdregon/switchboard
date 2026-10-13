/**
 * T9.7 finalize-only mode end to end (FR-GIT-09, FR-GIT-04, FR-GIT-07, FR-GIT-08; FRD BR-26, BR-27, BR-28, BR-30;
 * owner decision 36, ROADMAP Q-43). A fake adapter variant that declares `commitChannel: "none"` (as Claude Code and
 * Codex do today) edits files and ends with a structured summary; with the project's `finalize_commit` opt-in the
 * controller makes one commit at FINALIZING through `GitPublisher`. Temporary repositories and a LOCAL bare remote only;
 * no provider CLI, no network, no real credential (the operator push's HOME is a temporary directory).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeScenario } from "../adapters/fake/adapter.js";
import {
  AdapterRegistry,
  type CompileRequest,
  type Ineligible,
  type Invocation,
  type ResolvedProfile,
} from "../adapters/index.js";
import { ArtifactStore } from "../artifacts/index.js";
import { main } from "../cli/index.js";
import type { CliIo } from "../cli/io.js";
import { GitToolService } from "../git/channel.js";
import { GIT_FINALIZE_COMMIT_EVENT, GitPublisher, type PublishStep, publishRefFor } from "../git/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRecord } from "../ledger/index.js";
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
const remoteRefs = (bare: string) =>
  g(bare, "for-each-ref", "--format=%(refname)")
    .split("\n")
    .filter((l) => l !== "");

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

/** The summary an agent might end with: real text plus attribution the sanitiser must remove (FR-GIT-04). */
const SUMMARY = [
  "Greet in the README and drop the obsolete notice",
  "",
  "README.md now says hello; NOTICE.txt was obsolete and is removed.",
  "",
  "https://claude.ai/code/session_01UMW3Hb8xMj8ffsFzZVwhyY",
  "",
  "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
].join("\n");
const KEPT =
  "Greet in the README and drop the obsolete notice\n\nREADME.md now says hello; NOTICE.txt was obsolete and is removed.";

const plan = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    files: { "README.md": "hello\n", "NOTICE.txt": null, "docs/new.md": "new doc\n" },
    summary: SUMMARY,
    ...over,
  });

let root: string;
let repo: string;
let bare: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle | undefined;
let service: GitToolService | undefined;

function project(finalize: boolean, over: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    id: "web",
    name: "Web",
    environment_kind: "host",
    context_id: "main",
    base_ref: "main",
    effective_max_profile: "trusted-development",
    writable: true,
    identity: IDENTITY,
    push: { policy: "branch" },
    ...(finalize ? { finalize_commit: true as const } : {}),
    ...over,
  };
}

function finalizePublisher(hooks?: { afterStep?(step: PublishStep): void }): GitPublisher {
  return new GitPublisher({
    db,
    scratchDir: path.join(dataDir, "git-scratch"),
    allowedStates: ["FINALIZING"],
    ...(hooks ? { testHooks: hooks } : {}),
  });
}

interface Setup {
  scenario?: FakeScenario;
  channel?: "injected" | "none";
  publisher?: GitPublisher;
  adapter?: FakeAdapter;
}

function makeLifecycle(s: Setup = {}): RunLifecycle {
  const ids = createIdGenerator();
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  const adapter =
    s.adapter ??
    new FakeAdapter({ scenario: s.scenario ?? "edit_files", timeouts: PATIENT, commitChannel: s.channel ?? "none" });
  if (s.channel === "injected") {
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
    adapters: new AdapterRegistry().register(adapter),
    allowedRoots: [root],
    globalConcurrency: 1,
    resolveProfile: () => PROFILE,
    finalizePublisher: s.publisher ?? finalizePublisher(),
    ...(service ? { gitTools: service } : {}),
  });
  lifecycle.start();
  return lifecycle;
}

async function runOnce(
  lc: RunLifecycle,
  objective: string,
  proj: ProjectSnapshot,
  metaSessionId?: string,
): Promise<{ runId: string; metaSessionId: string; done: RunRecord }> {
  const r = await lc.submit({
    clientId: "c",
    objective,
    ...(metaSessionId ? { metaSessionId } : { workspace: repo }),
    trustProfile: "edit-untrusted",
    provider: "fake",
    project: proj,
  });
  return { runId: r.runId, metaSessionId: r.metaSessionId, done: await lc.waitForTerminal(r.runId) };
}

const events = (runId: string) =>
  ledger.listRunEvents(runId).map((e) => ({ id: e.id, type: e.type, p: JSON.parse(e.payload_json) }));
const finalizeEvent = (runId: string) => events(runId).find((e) => e.type === GIT_FINALIZE_COMMIT_EVENT)?.p;
const commitRows = () =>
  db.prepare("SELECT * FROM git_commit ORDER BY created_at, id").all() as Record<string, unknown>[];
const terminalPayload = (runId: string) =>
  events(runId).findLast((e) => e.type === "state_transition")?.p as Record<string, unknown>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-fin-")));
  repo = path.join(root, "repo");
  bare = path.join(root, "remote.git");
  mkdirSync(repo);
  mkdirSync(path.join(root, "home"));
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hi\n");
  writeFileSync(path.join(repo, "NOTICE.txt"), "old notice\n");
  writeFileSync(path.join(repo, "untouched.txt"), "stays\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  g(root, "init", "-q", "--bare", "-b", "main", bare);
  g(repo, "remote", "add", "origin", bare);
  g(repo, "push", "-q", "origin", "main");
  dataDir = path.join(root, "data");
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  lifecycle = undefined;
  service = undefined;
});

afterEach(async () => {
  await lifecycle?.shutdown();
  await service?.closeAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("finalize-only mode (T9.7)", () => {
  it("opt-in off: a `none` adapter still runs write-capable runs and gives diff + checkpoint only, no commit", async () => {
    const { runId, metaSessionId, done } = await runOnce(makeLifecycle(), plan(), project(false));
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
    const ev = events(runId);
    expect(ev.find((e) => e.type === "checkpoint")?.p).toMatchObject({
      kind: "post",
      committed: true,
      changed_files: 3,
    });
    expect(terminalPayload(runId).artifacts).toMatchObject({
      diff: expect.any(String),
      changed_files: expect.any(String),
    });
    // No commit, no publish ref, no finalize record, no ineligibility (Q-43 decided: none is not ineligible).
    expect(refSha(repo, publishRefFor(metaSessionId))).toBe("");
    expect(commitRows()).toEqual([]);
    expect(finalizeEvent(runId)).toBeUndefined();
    expect(terminalPayload(runId).finalize_commit).toBeUndefined();
    expect(terminalPayload(runId).finalize_commit_skipped).toBeUndefined();
  });

  it("opt-in on: exactly one sanitised commit of exactly the changed paths, with identity and provenance; worktree untouched", async () => {
    const { runId, metaSessionId, done } = await runOnce(makeLifecycle(), plan(), project(true));
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
    const pub = publishRefFor(metaSessionId);
    const sha = refSha(repo, pub);
    expect(sha).toMatch(/^[0-9a-f]{40}$/u);
    // One commit on top of the base, parented on the base (the run's pre checkpoint content).
    const base = refSha(repo, "main");
    expect(g(repo, "rev-list", "--count", `${base}..${pub}`)).toBe("1");
    expect(g(repo, "rev-parse", `${sha}^`)).toBe(base);
    // Exactly the run's changed paths: a modification, a deletion and a new file in a subdirectory.
    expect(g(repo, "diff-tree", "-r", "--no-renames", "--name-status", base, sha).split("\n").sort()).toEqual(
      ["D\tNOTICE.txt", "M\tREADME.md", "A\tdocs/new.md"].sort(),
    );
    expect(g(repo, "show", `${sha}:README.md`)).toBe("hello");
    // Identity applied to author and committer; the message is the sanitised summary and nothing else (FR-GIT-04).
    expect(g(repo, "log", "-1", "--format=%an <%ae>|%cn <%ce>", sha)).toBe(
      "Ada Maintainer <ada@example.test>|Ada Maintainer <ada@example.test>",
    );
    const message = g(repo, "log", "-1", "--format=%B", sha);
    expect(message).toBe(KEPT);
    expect(message).not.toMatch(/co-authored-by|claude\.ai|session_/iu);
    // Provenance (BR-28): one row, origin finalize_only, the git_commit event marked via finalize with the FINALIZING id.
    const rows = commitRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      commit_sha: sha,
      origin: "finalize_only",
      run_id: runId,
      meta_session_id: metaSessionId,
      project_id: "web",
      context_id: "main",
      provider: "fake",
    });
    const sanitizer = JSON.parse(String(rows[0]?.sanitizer_json));
    expect(sanitizer.rules["trailer.co-author"]).toBe(1);
    expect(sanitizer.rules["url.session"]).toBeGreaterThanOrEqual(1);
    const ev = events(runId);
    const finalizing = ev.find((e) => e.type === "state_transition" && e.p.to === "FINALIZING");
    const commitEvent = ev.find((e) => e.type === "git_commit");
    expect(commitEvent?.p).toMatchObject({
      commit_sha: sha,
      origin: "finalize_only",
      via: "finalize",
      finalizing_event_id: finalizing?.id,
    });
    expect(rows[0]?.tool_event_id).toBe(commitEvent?.id);
    expect(finalizeEvent(runId)).toEqual({
      outcome: "committed",
      commit_sha: sha,
      provenance_id: rows[0]?.id,
      files_changed: 3,
    });
    expect(terminalPayload(runId)).toMatchObject({ to: "SUCCEEDED", finalize_commit: sha });
    // Order: the ref check and the evidence checkpoint come first; the ref check stays clean.
    const order = ev.map((e) => e.type);
    expect(order.indexOf("git_ref_check")).toBeLessThan(order.indexOf("checkpoint"));
    expect(order.indexOf("checkpoint")).toBeLessThan(order.indexOf("git_commit_intent"));
    expect(ev.find((e) => e.type === "git_ref_check")?.p.result).toBe("clean");
    expect(ev.some((e) => e.type === "git_policy_violation")).toBe(false);
    // The worktree's index, HEAD and run branch are those the checkpoint left; the commit changed none of them.
    const run = ledger.getRunRecord(runId) as RunRecord;
    const wt = run.worktree_path as string;
    const post = ev.find((e) => e.type === "checkpoint")?.p.commit as string;
    expect(g(wt, "rev-parse", "HEAD")).toBe(post);
    expect(refSha(repo, `refs/heads/${run.branch}`)).toBe(post);
    expect(g(wt, "status", "--porcelain")).toBe("");
    expect(() => g(repo, "merge-base", "--is-ancestor", post, pub)).toThrow(); // checkpoint not in the publish history
    // The operator's checkout is untouched (FR-WS-05).
    expect(g(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(g(repo, "status", "--porcelain")).toBe("");
    expect(refSha(repo, "main")).toBe(base);
  });

  it("a recorded git_policy_violation prevents the commit (BR-27); the run still succeeds", async () => {
    const attempts = JSON.stringify({
      steps: [
        { op: "write", path: "evil.txt", content: "agent commit\n" },
        { op: "commit", message: "agent made this" },
      ],
    });
    const { runId, metaSessionId, done } = await runOnce(
      makeLifecycle({ scenario: "git_attempts" }),
      attempts,
      project(true),
    );
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
    expect(events(runId).some((e) => e.type === "git_policy_violation")).toBe(true);
    expect(finalizeEvent(runId)).toEqual({ outcome: "skipped", reason: "git_policy_violation" });
    expect(terminalPayload(runId)).toMatchObject({
      git_policy_violation: true,
      finalize_commit_skipped: "git_policy_violation",
    });
    expect(refSha(repo, publishRefFor(metaSessionId))).toBe("");
    expect(commitRows()).toEqual([]);
  });

  it("no usable summary: no commit and `no_message` (the controller never invents a message)", async () => {
    const lc = makeLifecycle();
    const none = await runOnce(lc, plan({ summary: null }), project(true));
    expect(none.done.state).toBe("SUCCEEDED");
    expect(finalizeEvent(none.runId)).toEqual({ outcome: "skipped", reason: "no_message" });
    expect(terminalPayload(none.runId).finalize_commit_skipped).toBe("no_message");
    // A summary that is nothing but attribution is empty after sanitising: same result.
    const onlyAttribution = await runOnce(
      lc,
      plan({ files: { "x.txt": "x\n" }, summary: "Co-Authored-By: Claude <noreply@anthropic.com>" }),
      project(true),
      none.metaSessionId,
    );
    expect(onlyAttribution.done.state).toBe("SUCCEEDED");
    expect(finalizeEvent(onlyAttribution.runId)).toEqual({ outcome: "skipped", reason: "no_message" });
    expect(refSha(repo, publishRefFor(none.metaSessionId))).toBe("");
    expect(commitRows()).toEqual([]);
  });

  it("a failed run makes no commit", async () => {
    const { runId, metaSessionId, done } = await runOnce(makeLifecycle(), plan({ ok: false }), project(true));
    expect(done.state).toBe("FAILED");
    expect(finalizeEvent(runId)).toEqual({ outcome: "skipped", reason: "run_not_succeeded" });
    expect(refSha(repo, publishRefFor(metaSessionId))).toBe("");
    expect(commitRows()).toEqual([]);
  });

  it("an adapter that receives the channel never gets the finalize commit (the tool is the path)", async () => {
    const { runId, metaSessionId, done } = await runOnce(makeLifecycle({ channel: "injected" }), plan(), project(true));
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
    expect(events(runId).some((e) => e.type === "git_channel_opened")).toBe(true);
    expect(finalizeEvent(runId)).toBeUndefined();
    expect(refSha(repo, publishRefFor(metaSessionId))).toBe("");
    expect(commitRows()).toEqual([]);
  });

  it("a refused path refuses the whole commit (T9.3 rules): nothing committed, the reason recorded as counts", async () => {
    const lc = makeLifecycle();
    // Run 1 creates a file but gives no summary, so nothing is published; its change is in the meta-session head.
    const first = await runOnce(lc, plan({ files: { "temp.txt": "t\n" }, summary: null }), project(true));
    expect(finalizeEvent(first.runId)).toEqual({ outcome: "skipped", reason: "no_message" });
    // Run 2 deletes it and edits another file: the deletion is not in the publish parent (the base), so it is refused.
    const second = await runOnce(
      lc,
      plan({ files: { "temp.txt": null, "README.md": "edited\n" }, summary: "Remove temp and edit README" }),
      project(true),
      first.metaSessionId,
    );
    expect(second.done.state).toBe("SUCCEEDED");
    expect(finalizeEvent(second.runId)).toEqual({ outcome: "failed", reason: "PATH_REFUSED", refused: { missing: 1 } });
    expect(terminalPayload(second.runId).finalize_commit_skipped).toBe("PATH_REFUSED");
    expect(refSha(repo, publishRefFor(first.metaSessionId))).toBe("");
    expect(commitRows()).toEqual([]);
    // No path name reaches the event (counts only).
    expect(JSON.stringify(finalizeEvent(second.runId))).not.toContain("temp.txt");
  });

  describe("crash safety (T9.3 intent/outcome ordering covers this path)", () => {
    it("a crash after the ref update is rolled forward by recover(): provenance row with origin finalize_only", async () => {
      const crashing = finalizePublisher({
        afterStep: (step) => {
          if (step === "ref_updated") throw new Error("simulated crash after update-ref");
        },
      });
      const { runId, metaSessionId, done } = await runOnce(
        makeLifecycle({ publisher: crashing }),
        plan(),
        project(true),
      );
      // The simulated crash does not change the outcome; the commit is published but has no row yet.
      expect(done.state).toBe("SUCCEEDED");
      expect(finalizeEvent(runId)).toEqual({ outcome: "failed", reason: "INTERNAL_ERROR" });
      const sha = refSha(repo, publishRefFor(metaSessionId));
      expect(sha).toMatch(/^[0-9a-f]{40}$/u);
      expect(commitRows()).toEqual([]);
      const intent = events(runId).find((e) => e.type === "git_commit_intent")?.p;
      expect(intent).toMatchObject({ commit_sha: sha, via: "finalize", record: { origin: "finalize_only" } });
      // Restart: recovery writes the row and the event, keeping the finalize marker.
      const report = await new GitPublisher({ db, scratchDir: path.join(dataDir, "git-scratch") }).recover();
      expect(report).toEqual({ rolledForward: [sha], aborted: [], unresolved: [] });
      expect(commitRows()).toEqual([
        expect.objectContaining({ commit_sha: sha, origin: "finalize_only", run_id: runId }),
      ]);
      const finalizing = events(runId).find((e) => e.type === "state_transition" && e.p.to === "FINALIZING");
      expect(events(runId).find((e) => e.type === "git_commit")?.p).toMatchObject({
        commit_sha: sha,
        via: "finalize",
        finalizing_event_id: finalizing?.id,
        recovered: true,
      });
    });

    it("a crash after the intent but before the ref update is aborted by recover(): nothing published", async () => {
      const crashing = finalizePublisher({
        afterStep: (step) => {
          if (step === "intent_recorded") throw new Error("simulated crash before update-ref");
        },
      });
      const { runId, metaSessionId, done } = await runOnce(
        makeLifecycle({ publisher: crashing }),
        plan(),
        project(true),
      );
      expect(done.state).toBe("SUCCEEDED");
      expect(refSha(repo, publishRefFor(metaSessionId))).toBe("");
      const report = await new GitPublisher({ db, scratchDir: path.join(dataDir, "git-scratch") }).recover();
      expect(report.aborted).toHaveLength(1);
      expect(report.rolledForward).toEqual([]);
      expect(commitRows()).toEqual([]);
      expect(events(runId).find((e) => e.type === "git_commit_aborted")?.p).toMatchObject({
        reason: "not_published_at_recovery",
      });
    });
  });

  it("approved bypass runs are handled identically: the commit follows the ref check", async () => {
    /** Compiles `privileged` as an edit profile (the fake CLI has no bypass flag; none is emitted). */
    class PrivilegedNoChannel extends FakeAdapter {
      override compile(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
        return super.compile(request, { ...PROFILE, shell: profile.shell, bypassApproved: false });
      }
    }
    const lc = makeLifecycle({
      adapter: new PrivilegedNoChannel({ scenario: "edit_files", timeouts: PATIENT, commitChannel: "none" }),
    });
    const { runId, metaSessionId } = await lc.submit({
      clientId: "c",
      objective: plan(),
      workspace: repo,
      trustProfile: "privileged",
      provider: "fake",
      project: project(true),
      privileged: {
        scope: {
          files: { access: "worktree" },
          shell: { mode: "broad" },
          network: { mode: "off" },
          repository_config: { mode: "disabled" },
          bypass: true,
        },
      },
    });
    lc.applyApprovalDecision({
      requestEventId: `evt_test_${runId}`,
      runId,
      decision: "APPROVED",
      requestedBy: "op",
      requestedAt: "2026-10-13T00:00:00.000Z",
      scopeHash: ledger.getApprovalForRun(runId)?.scope_hash ?? "",
    });
    const done = await lc.waitForTerminal(runId);
    expect(done.state, done.failure_detail ?? "").toBe("SUCCEEDED");
    const ev = events(runId);
    expect(ev.find((e) => e.type === "privileged_dispatch")?.p).toMatchObject({ bypass_approved: true });
    const sha = refSha(repo, publishRefFor(metaSessionId));
    expect(sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(g(repo, "log", "-1", "--format=%B", sha)).toBe(KEPT);
    const order = ev.map((e) => e.type);
    expect(order.indexOf("git_ref_check")).toBeLessThan(order.indexOf(GIT_FINALIZE_COMMIT_EVENT));
    expect(ev.find((e) => e.type === "git_ref_check")?.p.result).toBe("clean");
    expect(commitRows()).toEqual([expect.objectContaining({ commit_sha: sha, origin: "finalize_only" })]);
  });

  it("push policy is unaffected: the operator command pushes the finalize commit; runs show marks it via finalize", async () => {
    const { runId, metaSessionId, done } = await runOnce(makeLifecycle(), plan(), project(true));
    expect(done.state).toBe("SUCCEEDED");
    await lifecycle?.shutdown();
    lifecycle = undefined;
    const sha = refSha(repo, publishRefFor(metaSessionId));
    const configPath = path.join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        data_dir: dataDir,
        allowed_roots: [root],
        mcp_clients: [{ id: "c", max_trust_profile: "edit-untrusted", projects: ["web"] }],
        projects: [
          {
            id: "web",
            name: "Web",
            contexts: [
              {
                id: "main",
                kind: "repository",
                path: repo,
                base_ref: "main",
                push: { policy: "branch", remote: "origin", branch_prefix: "agent/" },
                identity: IDENTITY,
                finalize_commit: true,
              },
            ],
          },
        ],
      }),
    );
    const cli = async (args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const io: CliIo = {
        stdout: { write: (s) => out.push(s) },
        stderr: { write: (s) => err.push(s) },
        env: { PATH: process.env.PATH, HOME: path.join(root, "home") },
        user: "tester",
      };
      const code = await main([...args, "--config", configPath], io);
      return { code, out: out.join(""), err: err.join("") };
    };
    const pushed = await cli(["git", "push", metaSessionId, "--json"]);
    expect(pushed.code, pushed.out + pushed.err).toBe(0);
    const target = `refs/heads/agent/${metaSessionId}`;
    expect(JSON.parse(pushed.out)).toMatchObject({ outcome: "ACCEPTED", ref: target, head_sha: sha, commits: [sha] });
    expect(remoteRefs(bare).sort()).toEqual(["refs/heads/main", target].sort());
    expect(g(bare, "rev-parse", target)).toBe(sha);

    const show = await cli(["runs", "show", runId, "--json"]);
    expect(show.code).toBe(0);
    const d = JSON.parse(show.out);
    expect(d.run.commits).toEqual([
      expect.objectContaining({
        sha,
        origin: "finalize_only",
        via: "finalize",
        pushed_to: [expect.objectContaining({ remote: "origin", ref: target })],
      }),
    ]);
    expect(d.run.finalize_commit).toEqual({ outcome: "committed", commit_sha: sha });
    const text = await cli(["runs", "show", runId]);
    expect(text.out).toContain(`${sha}  finalize_only  via finalize`);
    expect(text.out).toContain(`finalize:    committed ${sha} (finalize-only, FR-GIT-09)`);
    // The provenance view never carries the commit message.
    expect(JSON.stringify(d.run.commits)).not.toContain("obsolete");
  });
});
