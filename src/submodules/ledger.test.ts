import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger } from "../ledger/index.js";
import {
  findAcceptedSubmodulePush,
  insertSubmoduleCommit,
  insertSubmoduleMerge,
  insertSubmodulePullRequest,
  insertSubmodulePush,
  isSessionSubmoduleCommit,
  latestSubmoduleCommit,
  listSubmoduleCommitsForUmbrella,
  listSubmoduleMergeSteps,
  listSubmodulePullRequestsForRun,
  listSubmodulePullRequestsForUmbrellaRef,
  listSubmodulePushesForRun,
  type SubmoduleLedgerDeps,
  submoduleCommitPaths,
} from "./ledger.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const U = "e".repeat(40);
const REPO = "github.test/acme/lib";

let dir: string;
let db: Database.Database;
let ids: ReturnType<typeof createIdGenerator>;
let deps: SubmoduleLedgerDeps;
let clock: number;

function seed(): { sessionId: string; runId: string } {
  const ledger = createLedger(db, { ids });
  const session = ledger.createMetaSession({ objective: "o", repoRoot: "/repo", projectId: "web" });
  const run = ledger.createRun({
    metaSessionId: session.id,
    state: "RUNNING",
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
    provider: "fake",
    projectId: "web",
  });
  return { sessionId: session.id, runId: run.id };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-subledger-"));
  db = openLedger(dir);
  clock = Date.parse("2026-10-21T10:00:00Z");
  // Every call moves the clock, so ordering by created_at is observable.
  ids = createIdGenerator();
  deps = {
    ids,
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
  };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("submodule_commit helpers", () => {
  it("inserts rows with an smc_ id and returns the latest commit per (meta-session, repo)", () => {
    const { sessionId, runId } = seed();
    const first = insertSubmoduleCommit(
      db,
      {
        runId,
        metaSessionId: sessionId,
        repo: REPO,
        paths: ["libs/a", "vendor/a"],
        parentSha: A,
        commitSha: B,
        umbrellaCommitSha: U,
      },
      deps,
    );
    expect(first.id).toMatch(/^smc_[0-9A-Z]{26}$/u);
    expect(first.kind).toBe("publish");
    expect(submoduleCommitPaths(first)).toEqual(["libs/a", "vendor/a"]);
    insertSubmoduleCommit(
      db,
      {
        runId,
        metaSessionId: sessionId,
        repo: REPO,
        paths: ["libs/a"],
        parentSha: B,
        commitSha: C,
        umbrellaCommitSha: U,
      },
      deps,
    );
    insertSubmoduleCommit(
      db,
      {
        runId,
        metaSessionId: sessionId,
        repo: "github.test/acme/other",
        paths: ["o"],
        parentSha: A,
        commitSha: A,
        umbrellaCommitSha: U,
      },
      deps,
    );
    expect(latestSubmoduleCommit(db, sessionId, REPO)?.commit_sha).toBe(C);
    expect(latestSubmoduleCommit(db, sessionId, "github.test/acme/none")).toBeUndefined();
    expect(latestSubmoduleCommit(db, "sess_other", REPO)).toBeUndefined();
    expect(listSubmoduleCommitsForUmbrella(db, U).map((r) => r.commit_sha)).toEqual([B, C, A]);
  });

  it("answers whether a SHA is a recorded submodule commit of the meta-session (optionally of one repo)", () => {
    const { sessionId, runId } = seed();
    insertSubmoduleCommit(
      db,
      {
        runId,
        metaSessionId: sessionId,
        repo: REPO,
        paths: ["libs/a"],
        parentSha: A,
        commitSha: B,
        umbrellaCommitSha: U,
      },
      deps,
    );
    expect(isSessionSubmoduleCommit(db, sessionId, B)).toBe(true);
    expect(isSessionSubmoduleCommit(db, sessionId, B, REPO)).toBe(true);
    expect(isSessionSubmoduleCommit(db, sessionId, B, "github.test/acme/other")).toBe(false);
    expect(isSessionSubmoduleCommit(db, sessionId, A)).toBe(false);
    expect(isSessionSubmoduleCommit(db, "sess_other", B)).toBe(false);
  });

  it("refuses an unsafe path list and a non-SHA before writing, and the table stays append-only", () => {
    const { sessionId, runId } = seed();
    const base = { runId, metaSessionId: sessionId, repo: REPO, parentSha: A, commitSha: B, umbrellaCommitSha: U };
    expect(() => insertSubmoduleCommit(db, { ...base, paths: [] }, deps)).toThrow(/paths/u);
    expect(() => insertSubmoduleCommit(db, { ...base, paths: ["../x"] }, deps)).toThrow(/paths/u);
    expect(() => insertSubmoduleCommit(db, { ...base, paths: ["a"], commitSha: "HEAD" }, deps)).toThrow(/SHA/u);
    insertSubmoduleCommit(db, { ...base, paths: ["a"] }, deps);
    expect(() => db.prepare("UPDATE submodule_commit SET repo = 'x'").run()).toThrow(/append-only/u);
    expect(() => db.prepare("DELETE FROM submodule_commit").run()).toThrow(/append-only/u);
  });
});

describe("submodule_push helpers", () => {
  it("finds the accepted push of one head to one branch of one repository of the meta-session", () => {
    const { sessionId, runId } = seed();
    const base = {
      runId,
      metaSessionId: sessionId,
      projectId: "web",
      repo: REPO,
      paths: ["libs/a"],
      ref: "refs/heads/switchboard/sess_x",
      headSha: B,
      umbrellaHeadSha: U,
      requestedBy: "mcp_client:c",
    };
    const refused = insertSubmodulePush(db, { ...base, outcome: "REJECTED_REMOTE", reason: "non_fast_forward" }, deps);
    expect(refused.id).toMatch(/^smp_/u);
    expect(findAcceptedSubmodulePush(db, { metaSessionId: sessionId, repo: REPO, ref: base.ref, headSha: B })).toBe(
      undefined,
    );
    const ok = insertSubmodulePush(db, { ...base, outcome: "ACCEPTED", reason: "ok" }, deps);
    expect(findAcceptedSubmodulePush(db, { metaSessionId: sessionId, repo: REPO, ref: base.ref, headSha: B })?.id).toBe(
      ok.id,
    );
    expect(findAcceptedSubmodulePush(db, { metaSessionId: sessionId, repo: REPO, ref: base.ref, headSha: C })).toBe(
      undefined,
    );
    expect(
      findAcceptedSubmodulePush(db, { metaSessionId: sessionId, repo: REPO, ref: "refs/heads/other", headSha: B }),
    ).toBe(undefined);
    expect(listSubmodulePushesForRun(db, runId).map((r) => r.outcome)).toEqual(["REJECTED_REMOTE", "ACCEPTED"]);
    expect(() => insertSubmodulePush(db, { ...base, ref: "main", outcome: "ACCEPTED", reason: "ok" }, deps)).toThrow(
      /CHECK/u,
    );
  });
});

describe("submodule_pull_request helpers", () => {
  it("lists pull requests by run and by umbrella ref", () => {
    const { sessionId, runId } = seed();
    const push = insertSubmodulePush(
      db,
      {
        runId,
        metaSessionId: sessionId,
        projectId: "web",
        repo: REPO,
        paths: ["libs/a"],
        ref: "refs/heads/switchboard/sess_x",
        headSha: B,
        umbrellaHeadSha: U,
        outcome: "ACCEPTED",
        reason: "ok",
        requestedBy: "operator",
      },
      deps,
    );
    const pr = insertSubmodulePullRequest(
      db,
      {
        runId,
        metaSessionId: sessionId,
        pushId: push.id,
        clientId: "c",
        repo: "acme/lib",
        number: 7,
        url: "https://github.com/acme/lib/pull/7",
        branch: "switchboard/sess_x",
        baseRef: "main",
        headSha: B,
        umbrellaRef: "refs/heads/switchboard/sess_x",
        draft: true,
        action: "created",
      },
      deps,
    );
    expect(pr.id).toMatch(/^spr_/u);
    expect(pr.draft).toBe(1);
    expect(listSubmodulePullRequestsForRun(db, runId).map((r) => r.number)).toEqual([7]);
    expect(listSubmodulePullRequestsForUmbrellaRef(db, "refs/heads/switchboard/sess_x").map((r) => r.id)).toEqual([
      pr.id,
    ]);
    expect(listSubmodulePullRequestsForUmbrellaRef(db, "refs/heads/other")).toEqual([]);
  });
});

describe("submodule_merge helpers", () => {
  it("records merge steps by umbrella ref, a refusal only once per head and reason", () => {
    const { sessionId, runId } = seed();
    const ref = "refs/heads/switchboard/sess_x";
    const base = { runId, metaSessionId: sessionId, projectId: "web", umbrellaRef: ref };
    const r1 = insertSubmoduleMerge(
      db,
      { ...base, step: "submodule_refused", repo: "acme/lib", prNumber: 7, headSha: B, reason: "check_pending" },
      deps,
    );
    expect(r1?.id).toMatch(/^smm_/u);
    expect(
      insertSubmoduleMerge(
        db,
        { ...base, step: "submodule_refused", repo: "acme/lib", prNumber: 7, headSha: B, reason: "check_pending" },
        deps,
      ),
    ).toBeUndefined();
    insertSubmoduleMerge(
      db,
      { ...base, step: "submodule_merged", repo: "acme/lib", prNumber: 7, headSha: B, mergedSha: C },
      deps,
    );
    insertSubmoduleMerge(db, { ...base, step: "gitlinks_repointed", headSha: U, mergedSha: A }, deps);
    expect(listSubmoduleMergeSteps(db, "web", ref).map((r) => r.step)).toEqual([
      "submodule_refused",
      "submodule_merged",
      "gitlinks_repointed",
    ]);
    expect(listSubmoduleMergeSteps(db, "other", ref)).toEqual([]);
    // The table's CHECKs: a merged step needs its merged commit.
    expect(() =>
      insertSubmoduleMerge(db, { ...base, step: "submodule_merged", repo: "acme/lib", prNumber: 7, headSha: B }, deps),
    ).toThrow(/CHECK/u);
  });
});
