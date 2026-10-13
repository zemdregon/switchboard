/**
 * T9.10 (FR-GIT-10, FRD BR-33, LLD §12.3.1): `GitPublisher.commit` with `sign`. Only a THROWAWAY unprotected GnuPG key
 * in a temporary `GNUPGHOME` and a temporary `HOME` is used (`fixtures/throwaway-gpg.ts`); the signing cases skip when
 * `gpg` is not installed. The refusal cases need no key at all and always run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import type { PolicySnapshot } from "../policy/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { createThrowawaySigner, gpgAvailable, type ThrowawaySigner } from "./fixtures/throwaway-gpg.js";
import {
  CommitError,
  type CommitInput,
  evaluateCredentialReach,
  evaluateSigningReach,
  GitPublisher,
  type GitPublisherOptions,
  publishRefFor,
  signingReachFromJson,
} from "./index.js";

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
function refSha(cwd: string, ref: string): string {
  try {
    return g(cwd, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return "";
  }
}

const IDENTITY = { name: "Ada Maintainer", email: "ada@example.test" };
const NOW = new Date("2026-10-13T10:00:00Z");
const OK_REACH = { reach: { ok: true } } as const;

let root: string;
let repo: string;
let scratch: string;
let db: Database.Database;
let ledger: Ledger;
let mgr: WorkspaceManager;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-csign-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "original\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  const dataDir = path.join(root, "data");
  scratch = path.join(root, "scratch");
  mkdirSync(dataDir);
  db = openLedger(path.join(root, "ledger"));
  const ids = createIdGenerator();
  ledger = createLedger(db, { ids });
  mgr = new WorkspaceManager({
    db,
    artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
    dataDir,
    allowedRoots: [root],
    ids,
    now: () => NOW,
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function running() {
  const session = ledger.createMetaSession({ objective: "o", repoRoot: repo, projectId: "web" });
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
  const ws = await mgr.prepare({
    metaSessionId: session.id,
    runId: run.id,
    workspace: repo,
    trustProfile: "edit-untrusted",
  });
  if (ws.mode !== "worktree") throw new Error("expected a worktree");
  writeFileSync(path.join(ws.worktreePath, "a.txt"), "changed\n");
  return { session, run, wt: ws.worktreePath };
}

function publisher(extra: Partial<GitPublisherOptions> = {}): GitPublisher {
  return new GitPublisher({ db, scratchDir: scratch, now: () => NOW, ...extra });
}

function input(runId: string, extra: Partial<CommitInput> = {}): CommitInput {
  return { runId, message: "Change things", identity: IDENTITY, projectId: "web", contextId: "main", ...extra };
}

const eventsOf = (runId: string) =>
  ledger.listRunEvents(runId).map((e) => ({ type: e.type, p: JSON.parse(e.payload_json) as Record<string, unknown> }));
/** Everything the ledger holds as text, for the "no key material" checks. */
const ledgerText = () =>
  JSON.stringify([db.prepare("SELECT * FROM run_event").all(), db.prepare("SELECT * FROM git_commit").all()]);

async function expectCode(p: Promise<unknown>, code: string): Promise<CommitError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(CommitError);
    expect((err as CommitError).code).toBe(code);
    return err as CommitError;
  }
  throw new Error(`expected ${code}`);
}

/** A program that records that it ran, for "nothing was executed" checks. */
function markerProgram(name: string): { program: string; marker: string } {
  const marker = path.join(root, `${name}.ran`);
  const program = path.join(root, `${name}.sh`);
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  return { program, marker };
}

describe("signing refusals (no key needed)", () => {
  it("refuses with SIGNING_FAILED when BR-31 refuses, before any commit object; nothing is published", async () => {
    const { session, run } = await running();
    const evil = markerProgram("global-gpg");
    const home = mkdtempSync(path.join(root, "home-"));
    writeFileSync(path.join(home, ".gitconfig"), `[gpg]\n\tprogram = ${evil.program}\n`);
    const err = await expectCode(
      publisher({ signingEnv: { PATH: process.env.PATH ?? "", HOME: home } }).commit(
        input(run.id, { sign: { reach: { ok: false, reason: "shell_broad" } } }),
      ),
      "SIGNING_FAILED",
    );
    expect(err.message).toContain("credential_reach");
    expect(existsSync(evil.marker)).toBe(false);
    expect(refSha(repo, publishRefFor(session.id))).toBe("");
    const ev = eventsOf(run.id);
    expect(ev.some((e) => e.type === "git_commit_intent")).toBe(false);
    expect(ev.find((e) => e.type === "git_commit_signing_failed")?.p).toEqual({
      origin: "commit_tool",
      reason: "credential_reach",
      credential_reach: "shell_broad",
    });
  });

  it("refuses a repository-local gpg.program (malicious .git/config), never runs it; ref unchanged", async () => {
    const { session, run } = await running();
    const evil = markerProgram("repo-gpg");
    g(repo, "config", "gpg.program", evil.program);
    const err = await expectCode(publisher().commit(input(run.id, { sign: OK_REACH })), "SIGNING_FAILED");
    expect(err.message).toContain("repo_config_unsafe");
    expect(existsSync(evil.marker)).toBe(false);
    expect(refSha(repo, publishRefFor(session.id))).toBe("");
    expect(eventsOf(run.id).find((e) => e.type === "git_commit_signing_failed")?.p).toEqual({
      origin: "commit_tool",
      reason: "repo_config_unsafe",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM git_commit").get()).toEqual({ n: 0 });
  });

  it("with sign off, a repository gpg.program and commit.gpgsign are ignored: unsigned, nothing run", async () => {
    const { session, run } = await running();
    const evil = markerProgram("repo-gpg-off");
    g(repo, "config", "gpg.program", evil.program);
    g(repo, "config", "commit.gpgsign", "true");
    const r = await publisher().commit(input(run.id));
    expect(existsSync(evil.marker)).toBe(false);
    expect(refSha(repo, publishRefFor(session.id))).toBe(r.sha);
    expect(g(repo, "cat-file", "commit", r.sha)).not.toContain("gpgsig");
    for (const e of eventsOf(run.id)) expect(e.p).not.toHaveProperty("signed");
  });
});

describe.skipIf(!gpgAvailable())("signed publish commits with a throwaway GnuPG key", () => {
  let signer: ThrowawaySigner;
  beforeEach(() => {
    signer = createThrowawaySigner();
  });
  afterEach(() => signer.dispose());

  it("signs the published commit; it verifies, names only the key, and the ledger holds no key data", async () => {
    const { session, run } = await running();
    const r = await publisher({ signingEnv: signer.env }).commit(
      input(run.id, { message: `Change things\n\nRun: ${run.id}\nSession: ${session.id}`, sign: OK_REACH }),
    );
    expect(refSha(repo, publishRefFor(session.id))).toBe(r.sha);
    execFileSync("git", ["verify-commit", r.sha], { cwd: repo, env: signer.verifyEnv, stdio: "ignore" });
    expect(
      execFileSync("git", ["log", "-1", "--format=%G?|%GF|%GS", r.sha], {
        cwd: repo,
        env: signer.verifyEnv,
        encoding: "utf8",
      }).trim(),
    ).toBe(`G|${signer.fingerprint}|Throwaway Test Key <throwaway@example.test>`);
    // Nothing about the run reaches the commit: the sanitiser removed the ids and signing added nothing.
    const raw = g(repo, "cat-file", "commit", r.sha);
    expect(raw).not.toContain(run.id);
    expect(raw).not.toContain(session.id);
    expect(g(repo, "log", "-1", "--format=%B", r.sha)).toMatch(/^Change things\n/u);
    expect(g(repo, "log", "-1", "--format=%an <%ae>|%cn <%ce>", r.sha)).toBe(
      "Ada Maintainer <ada@example.test>|Ada Maintainer <ada@example.test>",
    );
    const ev = eventsOf(run.id);
    expect(ev.find((e) => e.type === "git_commit_intent")?.p).toMatchObject({ signed: true });
    expect(ev.find((e) => e.type === "git_commit")?.p).toMatchObject({ signed: true });
    const text = ledgerText();
    for (const secretish of [signer.fingerprint, signer.gnupgHome, signer.home]) expect(text).not.toContain(secretish);
  });

  it("a signing failure returns SIGNING_FAILED, writes no intent and leaves the publish ref where it was", async () => {
    const { session, run, wt } = await running();
    const first = await publisher({ signingEnv: signer.env }).commit(input(run.id, { sign: OK_REACH }));
    writeFileSync(path.join(wt, "b.txt"), "more\n");
    writeFileSync(
      path.join(signer.home, ".gitconfig"),
      "[user]\n\tsigningkey = 0000000000000000000000000000000000000000\n",
    );
    const intentsBefore = eventsOf(run.id).filter((e) => e.type === "git_commit_intent").length;
    const err = await expectCode(
      publisher({ signingEnv: signer.env }).commit(input(run.id, { sign: OK_REACH })),
      "SIGNING_FAILED",
    );
    expect(err.message).toContain("sign_failed");
    expect(refSha(repo, publishRefFor(session.id))).toBe(first.sha);
    const ev = eventsOf(run.id);
    expect(ev.filter((e) => e.type === "git_commit_intent").length).toBe(intentsBefore);
    expect(ev.find((e) => e.type === "git_commit_signing_failed")?.p).toEqual({
      origin: "commit_tool",
      reason: "sign_failed",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM git_commit").get()).toEqual({ n: 1 });
    expect(ledgerText()).not.toContain(signer.fingerprint);
  });

  it("with sign off the operator's signing setup is never used, even if it asks to sign every commit", async () => {
    const { run } = await running();
    writeFileSync(
      path.join(signer.home, ".gitconfig"),
      `[user]\n\tsigningkey = ${signer.fingerprint}\n[commit]\n\tgpgsign = true\n`,
    );
    const r = await publisher({ signingEnv: signer.env }).commit(input(run.id));
    expect(g(repo, "cat-file", "commit", r.sha)).not.toContain("gpgsig");
  });
});

describe("signing reach: the BR-31 predicate of the push tool, without its push-policy precondition", () => {
  const base = (over: Partial<PolicySnapshot> = {}): PolicySnapshot => ({
    name: "edit-untrusted",
    fileAccess: "worktree",
    shell: "none",
    network: "off",
    repoConfig: "disabled",
    bypassApproved: false,
    project: {
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
    },
    ...over,
  });
  const withPush = (s: PolicySnapshot): PolicySnapshot => ({
    ...s,
    project: { ...(s.project as NonNullable<PolicySnapshot["project"]>), push: { policy: "branch" } },
  });

  it("gives the same verdict as push wherever push policy is branch, and needs no push policy itself", () => {
    const cases: PolicySnapshot[] = [
      base(),
      base({ shell: "allowlist", shellAllowlist: [] }),
      base({ shell: "allowlist", shellAllowlist: ["npm test"] }),
      base({ shell: "broad" }),
      base({ bypassApproved: true }),
      base({
        project: { ...(base().project as NonNullable<PolicySnapshot["project"]>), environment_kind: "container" },
      }),
    ];
    for (const c of cases) {
      expect(evaluateSigningReach(c)).toEqual(evaluateCredentialReach(withPush(c)));
      expect(evaluateSigningReach(c, { approvedBypass: true })).toEqual(
        evaluateCredentialReach(withPush(c), { approvedBypass: true }),
      );
    }
    expect(evaluateSigningReach(base())).toEqual({ ok: true });
    expect(evaluateSigningReach(base({ shell: "broad" }))).toEqual({ ok: false, reason: "shell_broad" });
    // Owner decision 37 applies unchanged: only the controller-verified approved bypass is exempt.
    expect(evaluateSigningReach(base({ shell: "broad" }), { approvedBypass: true })).toEqual({
      ok: true,
      reason: "bypass_exempt",
    });
    expect(evaluateSigningReach(base({ bypassApproved: true }))).toEqual({ ok: false, reason: "bypass_run" });
    const { project: _drop, ...noProject } = base();
    expect(evaluateSigningReach(noProject)).toEqual({ ok: false, reason: "no_project" });
    expect(signingReachFromJson("{not json")).toEqual({ ok: false, reason: "snapshot_unreadable" });
    expect(signingReachFromJson(JSON.stringify(base()))).toEqual({ ok: true });
  });
});
