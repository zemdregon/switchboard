/**
 * T5.3 "Done when" (FR-SES-02, FR-ADP-10, NFR-PRIV-02; ADR-0038; LLD §15.3), on the fake adapters only (the first fake and
 * the second fake of T5.2): after a run on each fake the binding carries provider, harness, backing provider (the
 * `fronted` scenario) and model; every decision kind whose cause exists in code is written once per cause; no decision
 * text comes from provider output; `open_work_json` follows the terminal transitions; no migration.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeAdapterOptions } from "../adapters/fake/adapter.js";
import {
  firstFake,
  SECOND_FAKE_ID,
  SECOND_FAKE_SESSION_ID,
  type StatefulFake,
  secondFake,
  secondFakeProvider,
} from "../adapters/fixtures/continuity-fakes.js";
import { registerProvider } from "../adapters/providers.js";
import { AdapterRegistry } from "../adapters/registry.js";
import type { CompileRequest, Ineligible, Invocation, ProviderAdapter, ResolvedProfile } from "../adapters/types.js";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type DecisionRow, type Ledger, openLedger, type TrustProfile } from "../ledger/index.js";
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
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const PATIENT = { wallClockMs: 120_000, idleMs: 60_000, killGraceMs: 300 };
const NODE = process.execPath;
const profileFor = (name: TrustProfile): ResolvedProfile => ({
  name,
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});
const SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "allowlist", allowlist: [["npm", "test"]] },
  network: { mode: "allowlist", hosts: ["registry.npmjs.org"] },
  repository_config: { mode: "approved" },
  bypass: false,
};

/** The fake compiled as an `edit-untrusted` run for a `privileged` request (the lifecycle still evaluates the approval). */
class PrivilegedFake extends FakeAdapter {
  override compile(request: CompileRequest, profile: ResolvedProfile): Invocation | Ineligible {
    return super.compile(request, { ...profileFor("edit-untrusted"), shell: profile.shell });
  }
}

/** The shapes a decision summary may take (LLD §15.3): fixed templates over controller tokens. */
const TEMPLATES: Record<string, RegExp> = {
  route_selected: /^provider=[a-z0-9][a-z0-9_.-]* mode=(new|resume|handoff) reasons=[a-z_]+(,[a-z_]+)*$/,
  handoff_built: /^bundle=art_\w+ sha256=[0-9a-f]{64} as_of=[0-9a-f]{64} source_runs=\d+$/,
  approval_decided: /^approval=apv_\w+ status=(APPROVED|DENIED) by=(operator|client_policy)$/,
  verification_outcome: /^outcome=(passed|failed|cancelled) passed=\d+ failed=\d+ not_run=\d+$/,
  rollback: /^head=[0-9a-f]{40,64} evidence_commit=[0-9a-f]{40,64} mutated=(true|false)$/,
};

let root: string;
let home: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let lifecycle: RunLifecycle | undefined;
let unregister: (() => void) | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-canon-lc-")));
  home = path.join(root, "home");
  repo = path.join(root, "repo");
  dataDir = path.join(root, "data");
  for (const d of [home, repo, dataDir]) mkdirSync(d);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  db = openLedger(dataDir);
  ledger = createLedger(db, { ids: createIdGenerator() });
  unregister = registerProvider(secondFakeProvider(home));
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  unregister?.();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function start(adapters: ProviderAdapter[]): RunLifecycle {
  const ids = createIdGenerator();
  const artifacts = new ArtifactStore(path.join(dataDir, "artifacts"));
  const workspace = new WorkspaceManager({ db, artifacts, dataDir, allowedRoots: [root], ids });
  const registry = new AdapterRegistry();
  for (const a of adapters) registry.register(a);
  lifecycle = new RunLifecycle({
    ledger,
    workspace,
    artifacts,
    adapters: registry,
    allowedRoots: [root],
    globalConcurrency: 4,
    resolveProfile: profileFor,
  });
  lifecycle.start();
  return lifecycle;
}

const submit = (lc: RunLifecycle, provider: string, extra: Record<string, unknown> = {}) =>
  lc.submit({
    clientId: "client-a",
    objective: "do the work",
    workspace: repo,
    trustProfile: "edit-untrusted",
    provider: provider as never,
    ...extra,
  });

const kinds = (rows: DecisionRow[]) => rows.map((r) => r.decision);
const summaryOf = (rows: DecisionRow[], kind: string) => rows.find((r) => r.decision === kind)?.reason_summary;

describe("provider_binding carries provider, harness, backing provider and model (FR-ADP-10)", () => {
  const specs = [
    {
      name: "first",
      make: (o: FakeAdapterOptions & { home: string }) => firstFake(o),
      provider: "fake",
      session: "fake-session-1",
    },
    {
      name: "second",
      make: (o: FakeAdapterOptions & { home: string }) => secondFake(o),
      provider: SECOND_FAKE_ID,
      session: SECOND_FAKE_SESSION_ID,
    },
  ] as const;

  for (const spec of specs) {
    it(`${spec.name} fake, fronted scenario: the binding records harness, backing provider and model; a resume leaves them alone`, async () => {
      const fake: StatefulFake = spec.make({ home, scenario: "fronted", timeouts: PATIENT });
      const lc = start([fake]);
      const first = await submit(lc, spec.provider);
      expect((await lc.waitForTerminal(first.runId)).state).toBe("SUCCEEDED");
      const bindings = ledger.listProviderBindings(first.metaSessionId);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        provider: spec.provider,
        harness: spec.provider,
        backing_provider: "backing-x",
        model: "m-a",
        native_session_id: spec.session,
      });
      const before = bindings[0];

      const second = await submit(lc, spec.provider, {
        metaSessionId: first.metaSessionId,
        resume: { nativeSessionId: spec.session },
      });
      expect((await lc.waitForTerminal(second.runId)).state).toBe("SUCCEEDED");
      const after = ledger.listProviderBindings(first.metaSessionId);
      expect(after).toHaveLength(1);
      expect({ ...after[0], last_used_at: 0 }).toEqual({ ...before, last_used_at: 0 });
    }, 60_000);
  }

  it("a plain run records the reported model and a null backing provider", async () => {
    const lc = start([firstFake({ home, timeouts: PATIENT })]);
    const r = await submit(lc, "fake");
    await lc.waitForTerminal(r.runId);
    expect(ledger.latestProviderBinding(r.metaSessionId)).toMatchObject({
      harness: "fake",
      backing_provider: null,
      model: "fake-model-1",
    });
  }, 30_000);
});

describe("decisions are written once per cause from fixed templates (ADR-0038 item 3)", () => {
  it("route_selected at admission: new, then resume; written once each", async () => {
    const lc = start([firstFake({ home, timeouts: PATIENT })]);
    const a = await submit(lc, "fake");
    await lc.waitForTerminal(a.runId);
    const b = await submit(lc, "fake", {
      metaSessionId: a.metaSessionId,
      resume: { nativeSessionId: "fake-session-1" },
    });
    await lc.waitForTerminal(b.runId);
    expect(
      ledger
        .listDecisionsForRun(a.runId)
        .filter((d) => d.decision === "route_selected")
        .map((d) => d.reason_summary),
    ).toEqual(["provider=fake mode=new reasons=new_session"]);
    expect(
      ledger
        .listDecisionsForRun(b.runId)
        .filter((d) => d.decision === "route_selected")
        .map((d) => d.reason_summary),
    ).toEqual(["provider=fake mode=resume reasons=same_provider_resume"]);
  }, 60_000);

  it("an idempotent replay of a submission writes no second route_selected", async () => {
    const lc = start([firstFake({ home, timeouts: PATIENT })]);
    const a = await submit(lc, "fake", { idempotencyKey: "canonical-state-key-1" });
    const again = await submit(lc, "fake", { idempotencyKey: "canonical-state-key-1" });
    expect(again.replayed).toBe(true);
    await lc.waitForTerminal(a.runId);
    expect(kinds(ledger.listDecisionsForRun(a.runId)).filter((k) => k === "route_selected")).toHaveLength(1);
  }, 30_000);

  it("verification_outcome when the verification stage finishes: passed, then failed (with a rollback decision)", async () => {
    const lc = start([new FakeAdapter({ scenario: "success", timeouts: PATIENT })]);
    const ok = await submit(lc, "fake", { verificationCommands: [[NODE, "-e", "process.exit(0)"]] });
    expect((await lc.waitForTerminal(ok.runId)).state).toBe("SUCCEEDED");
    expect(summaryOf(ledger.listDecisionsForRun(ok.runId), "verification_outcome")).toBe(
      "outcome=passed passed=1 failed=0 not_run=0",
    );
    // A successful run does not roll back.
    expect(kinds(ledger.listDecisionsForRun(ok.runId))).not.toContain("rollback");

    const bad = await submit(lc, "fake", {
      verificationCommands: [
        [NODE, "-e", "process.exit(3)"],
        [NODE, "-e", "process.exit(0)"],
      ],
    });
    const done = await lc.waitForTerminal(bad.runId);
    expect(done.failure_code).toBe("TEST_FAILURE");
    const rows = ledger.listDecisionsForRun(bad.runId);
    expect(summaryOf(rows, "verification_outcome")).toBe("outcome=failed passed=0 failed=1 not_run=1");
    expect(kinds(rows).filter((k) => k === "rollback")).toHaveLength(1);
    // The rollback decision carries the same facts as the rollback event.
    const ev = ledger.listRunEvents(bad.runId).find((e) => e.type === "rollback");
    const p = JSON.parse(ev?.payload_json ?? "{}") as { head: string; evidence_commit: string; mutated: boolean };
    expect(summaryOf(rows, "rollback")).toBe(
      `head=${p.head} evidence_commit=${p.evidence_commit} mutated=${p.mutated}`,
    );
  }, 90_000);

  it("rollback when a run that did not succeed returns the head to its pre-run checkpoint", async () => {
    const lc = start([new FakeAdapter({ scenario: "task_failure", timeouts: PATIENT })]);
    const r = await submit(lc, "fake");
    expect((await lc.waitForTerminal(r.runId)).state).toBe("FAILED");
    const rows = ledger.listDecisionsForRun(r.runId);
    expect(kinds(rows).sort()).toEqual(["rollback", "route_selected"]);
    expect(summaryOf(rows, "rollback")).toMatch(TEMPLATES.rollback as RegExp);
  }, 30_000);

  it("approval_decided: operator approve, operator deny, and client policy at admission", async () => {
    const lc = start([new PrivilegedFake({ scenario: "success", timeouts: PATIENT })]);
    const decide = (runId: string, decision: "APPROVED" | "DENIED") =>
      lc.applyApprovalDecision({
        requestEventId: `evt_test_${runId}`,
        runId,
        decision,
        requestedBy: "op",
        requestedAt: "2026-10-14T00:00:00.000Z",
        scopeHash: ledger.getApprovalForRun(runId)?.scope_hash ?? "",
      });

    const approved = await submit(lc, "fake", { trustProfile: "privileged", privileged: { scope: SCOPE } });
    expect(kinds(ledger.listDecisionsForRun(approved.runId))).toEqual(["route_selected"]);
    decide(approved.runId, "APPROVED");
    await lc.waitForTerminal(approved.runId);
    const apvA = ledger.getApprovalForRun(approved.runId)?.id;
    expect(summaryOf(ledger.listDecisionsForRun(approved.runId), "approval_decided")).toBe(
      `approval=${apvA} status=APPROVED by=operator`,
    );

    const denied = await submit(lc, "fake", { trustProfile: "privileged", privileged: { scope: SCOPE } });
    expect(decide(denied.runId, "DENIED")).toBe("CANCELLED");
    const apvD = ledger.getApprovalForRun(denied.runId)?.id;
    expect(summaryOf(ledger.listDecisionsForRun(denied.runId), "approval_decided")).toBe(
      `approval=${apvD} status=DENIED by=operator`,
    );

    const policy = await submit(lc, "fake", {
      trustProfile: "privileged",
      privileged: { scope: SCOPE, approvedByClientPolicy: true },
    });
    await lc.waitForTerminal(policy.runId);
    const apvP = ledger.getApprovalForRun(policy.runId)?.id;
    const rows = ledger.listDecisionsForRun(policy.runId);
    expect(summaryOf(rows, "approval_decided")).toBe(`approval=${apvP} status=APPROVED by=client_policy`);
    expect(kinds(rows).filter((k) => k === "approval_decided")).toHaveLength(1);
  }, 90_000);

  it("handoff_built has no caller yet (T5.4/T5.6): no run writes it", async () => {
    const lc = start([new FakeAdapter({ scenario: "success", timeouts: PATIENT })]);
    const r = await submit(lc, "fake", { verificationCommands: [[NODE, "-e", "process.exit(0)"]] });
    await lc.waitForTerminal(r.runId);
    expect(kinds(ledger.listDecisionsForRun(r.runId))).not.toContain("handoff_built");
  }, 30_000);

  it("no decision text comes from provider output (NFR-PRIV-02): every summary matches its template", async () => {
    const lc = start([new FakeAdapter({ scenario: "task_failure", timeouts: PATIENT })]);
    const r = await submit(lc, "fake", { verificationCommands: [[NODE, "-e", "process.exit(0)"]] });
    await lc.waitForTerminal(r.runId);
    const rows = ledger.listDecisionsForRun(r.runId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.reason_summary).toMatch(TEMPLATES[row.decision] as RegExp);
      // The fake CLI's failing run says these words; they never reach a decision.
      expect(row.reason_summary).not.toMatch(/task failed|command failed|tool/);
    }
  }, 30_000);

  it("the append-only triggers reject UPDATE and DELETE of a written decision", async () => {
    const lc = start([new FakeAdapter({ scenario: "success", timeouts: PATIENT })]);
    const r = await submit(lc, "fake");
    await lc.waitForTerminal(r.runId);
    const row = ledger.listDecisionsForRun(r.runId)[0];
    expect(row).toBeDefined();
    expect(() => db.prepare("UPDATE decision SET decision = 'x' WHERE id = ?").run(row?.id)).toThrow();
    expect(() => db.prepare("DELETE FROM decision WHERE id = ?").run(row?.id)).toThrow();
  }, 30_000);

  it("a decision for a run that is already terminal is refused", async () => {
    const lc = start([new FakeAdapter({ scenario: "success", timeouts: PATIENT })]);
    const r = await submit(lc, "fake");
    await lc.waitForTerminal(r.runId);
    expect(() =>
      ledger.appendDecision({
        kind: "route_selected",
        runId: r.runId,
        provider: "fake",
        mode: "new",
        reasons: ["new_session"],
      }),
    ).toThrow(/terminal|already/);
  }, 30_000);
});

describe("open work and changed files per meta-session", () => {
  it("open_work_json follows the terminal transitions, and the outcomes helper reaches verification and changed files", async () => {
    const lc = start([new FakeAdapter({ scenario: "success", timeouts: PATIENT })]);
    const bad = await submit(lc, "fake", { verificationCommands: [[NODE, "-e", "process.exit(3)"]] });
    await lc.waitForTerminal(bad.runId);
    const open = ledger.getOpenWorkProjection(bad.metaSessionId);
    expect(open).toEqual([
      { kind: "last_run_failed", run_id: bad.runId, detail: "TEST_FAILURE" },
      {
        kind: "verification_not_passing",
        run_id: bad.runId,
        detail: { index: 0, outcome: "failed", argv: [NODE, "-e", "process.exit(3)"] },
      },
      { kind: "instruction_not_completed", run_id: bad.runId, detail: bad.runId },
    ]);

    const out = ledger.listOutcomesForMetaSession(bad.metaSessionId);
    expect(out?.runs).toHaveLength(1);
    expect(out?.runs[0]).toMatchObject({
      run_id: bad.runId,
      state: "FAILED",
      verification: [{ index: 0, outcome: "failed", exit_code: 3 }],
    });
    expect(out?.runs[0]?.changed_files_artifact_id).toMatch(/^art_/);
    expect(out?.runs[0]?.test_report_artifact_id).toMatch(/^art_/);
    expect(out?.runs[0]?.post_commit).toMatch(/^[0-9a-f]{40}$/);

    const ok = await submit(lc, "fake", {
      metaSessionId: bad.metaSessionId,
      resume: { nativeSessionId: "fake-session-1" },
    });
    expect((await lc.waitForTerminal(ok.runId)).state).toBe("SUCCEEDED");
    // The newest run succeeded; the older verified run's failing command is still the newest verification (LLD §15.3).
    expect(ledger.getOpenWorkProjection(bad.metaSessionId)).toEqual([
      expect.objectContaining({ kind: "verification_not_passing", run_id: bad.runId }),
    ]);
  }, 90_000);
});

describe("no migration (ADR-0038)", () => {
  it("the decision table keeps its 0001 columns and the open-work column its 0001 default", () => {
    const cols = (db.prepare("PRAGMA table_info(decision)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["id", "meta_session_id", "run_id", "decision", "reason_summary", "created_at"]);
    const open = (
      db.prepare("PRAGMA table_info(meta_session)").all() as { name: string; dflt_value: string | null }[]
    ).find((c) => c.name === "open_work_json");
    expect(open?.dflt_value).toBe("'[]'");
  });
});
