/**
 * T16.6 native writer, cleaner and exclusions at the workspace and Git level (FR-SKL-05, FR-SKL-06, FR-SKL-10; LLD
 * §19.6 step 2, §19.8, §19.11): the fallback cases (`path_taken`: in the base checkpoint, tracked, ignored, symlinked,
 * already on disk; `write_failed`), file and directory modes, the `<dir>/switchboard-<name>/<file>` layout, tampering
 * variants at removal, and the commit tool's `SKILL_PATH_IN_COMMIT` refusal. Real Git in temporary repositories.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_NATIVE_SKILL_LOCATION } from "../adapters/fake/adapter.js";
import type { PromptSkill } from "../adapters/prompt.js";
import { type NativeSkillLocation, nativeSkillPath, skillDeliveryOf } from "../adapters/types.js";
import { ArtifactStore } from "../artifacts/index.js";
import { CommitError, GitPublisher, publishRefFor } from "../git/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { WorkspaceManager } from "./index.js";
import { nativeSkillPresent, recordedNativePaths } from "./native-skills.js";

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
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const SKILLS: PromptSkill[] = [
  { name: "alpha-docs", version: 1, sha256: "a".repeat(64), body: "Alpha body.\n" },
  { name: "beta-review", version: 3, sha256: "b".repeat(64), body: "Beta body.\n" },
];
const ALPHA = ".fake/skills/switchboard-alpha-docs.md";
const BETA = ".fake/skills/switchboard-beta-review.md";
/** The directory layout (`<dir>/switchboard-<name>/<file>`), as a skills directory would be. */
const DIR_LAYOUT: NativeSkillLocation = {
  dir: ".agentx/skills",
  layout: { file: "SKILL.md" },
  render: (s) => `# ${s.name}\n${s.body}`,
  evidence: "test-only",
};

let root: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let mgr: WorkspaceManager;
let unlinkFailures = 0;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-nsw-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  db = openLedger(path.join(root, "ledger"));
  const ids = createIdGenerator();
  ledger = createLedger(db, { ids });
  unlinkFailures = 0;
  mgr = new WorkspaceManager({
    db,
    artifacts: new ArtifactStore(path.join(dataDir, "artifacts")),
    dataDir,
    allowedRoots: [root],
    ids,
    nativeSkillFs: {
      unlink: async (file) => {
        if (unlinkFailures > 0) {
          unlinkFailures -= 1;
          throw Object.assign(new Error("injected"), { code: "EPERM" });
        }
        unlinkSync(file);
      },
    },
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function commitToRepo(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), content);
  }
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "more");
}

/** A RUNNING run holding the lease, with a worktree and both skills pinned (`run_skill` rows as admission writes them). */
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
  SKILLS.forEach((s, i) => {
    db.prepare(
      `INSERT INTO run_skill (run_id, position, name, version, sha256, source, delivery)
       VALUES (?, ?, ?, ?, ?, 'request', 'prompt_prefix')`,
    ).run(run.id, i, s.name, s.version, s.sha256);
  });
  return { session, run, wt: ws.worktreePath };
}

const rows = (runId: string) =>
  db
    .prepare("SELECT native_path, written_sha256, removal FROM run_skill WHERE run_id = ? ORDER BY position")
    .all(runId) as { native_path: string | null; written_sha256: string | null; removal: string | null }[];
const events = (runId: string, type: string) =>
  ledger
    .listRunEvents(runId)
    .filter((e) => e.type === type)
    .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);

describe("native skill paths and declarations (T16.6)", () => {
  it("computes only fresh switchboard- paths under a safe relative directory; a declaration needs evidence", () => {
    expect(nativeSkillPath(FAKE_NATIVE_SKILL_LOCATION, "alpha-docs")).toBe(ALPHA);
    expect(nativeSkillPath(DIR_LAYOUT, "alpha-docs")).toBe(".agentx/skills/switchboard-alpha-docs/SKILL.md");
    for (const dir of ["/abs", "../up", "a/../b", ".git/x", "a//b", "a\\b", ""]) {
      expect(nativeSkillPath({ ...DIR_LAYOUT, dir }, "alpha-docs"), dir).toBeUndefined();
    }
    expect(nativeSkillPath(DIR_LAYOUT, "../x")).toBeUndefined();
    expect(nativeSkillPath({ ...DIR_LAYOUT, layout: { file: ".." } }, "alpha-docs")).toBeUndefined();
    expect(nativeSkillPath({ ...DIR_LAYOUT, layout: { ext: "m/d" } }, "alpha-docs")).toBeUndefined();
    const profile = {
      name: "edit-untrusted",
      fileAccess: "worktree",
      shell: "none",
      network: "off",
      repoConfig: "disabled",
      bypassApproved: false,
    } as const;
    const req = { runId: "run_x", objective: "o", constraints: [], workspace: { cwd: "/w", writable: true } };
    const declares = (native: NativeSkillLocation) => ({ skillDelivery: () => ({ native }) });
    expect(skillDeliveryOf(declares(FAKE_NATIVE_SKILL_LOCATION), req, profile)).toEqual({
      native: FAKE_NATIVE_SKILL_LOCATION,
    });
    expect(skillDeliveryOf(declares({ ...FAKE_NATIVE_SKILL_LOCATION, evidence: " " }), req, profile)).toBe(
      "prompt_prefix",
    );
    expect(skillDeliveryOf(declares({ ...FAKE_NATIVE_SKILL_LOCATION, dir: "../out" }), req, profile)).toBe(
      "prompt_prefix",
    );
    expect(skillDeliveryOf({}, req, profile)).toBe("prompt_prefix");
  });
});

describe("native writer (T16.6, LLD §19.6 step 2)", () => {
  it("writes fresh files exclusively: file 0600, created parents 0700, the rendered bytes, path and hash recorded", async () => {
    const { run, wt } = await running();
    const out = await mgr.writeNativeSkills(run.id, FAKE_NATIVE_SKILL_LOCATION, SKILLS);
    expect(out).toEqual([
      { name: "alpha-docs", version: 1, delivery: "native", native_path: ALPHA },
      { name: "beta-review", version: 3, delivery: "native", native_path: BETA },
    ]);
    expect(readFileSync(path.join(wt, ALPHA), "utf8")).toBe("Alpha body.\n");
    expect(statSync(path.join(wt, ALPHA)).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(wt, ".fake")).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(wt, ".fake/skills")).mode & 0o777).toBe(0o700);
    expect(rows(run.id)).toEqual([
      { native_path: ALPHA, written_sha256: sha256("Alpha body.\n"), removal: null },
      { native_path: BETA, written_sha256: sha256("Beta body.\n"), removal: null },
    ]);
    expect(recordedNativePaths(db, run.id)).toEqual([ALPHA, BETA]);
  });

  it("falls back with path_taken when the path or a parent is in the base checkpoint, tracked, ignored, symlinked or on disk", async () => {
    // `before` changes the repository ahead of the run's base checkpoint; `after` changes the worktree.
    const cases: { label: string; before?: () => void; after?: (wt: string) => void }[] = [
      { label: "parent in the base checkpoint", before: () => commitToRepo({ ".fake/other.txt": "x\n" }) },
      { label: "path in the base checkpoint", before: () => commitToRepo({ [ALPHA]: "theirs\n", [BETA]: "theirs\n" }) },
      {
        // Only the base-checkpoint check can see this one: the index and the disk no longer have it.
        label: "parent in the base checkpoint only",
        before: () => commitToRepo({ ".fake/other.txt": "x\n" }),
        after: (wt) => {
          g(wt, "rm", "-q", "-r", "--cached", ".fake");
          rmSync(path.join(wt, ".fake"), { recursive: true });
        },
      },
      {
        label: "tracked in the worktree",
        after: (wt) => {
          mkdirSync(path.join(wt, ".fake/skills"), { recursive: true });
          writeFileSync(path.join(wt, ".fake/skills/keep.md"), "tracked\n");
          g(wt, "add", "-f", ".fake/skills/keep.md");
        },
      },
      { label: "ignored", before: () => commitToRepo({ ".gitignore": ".fake/\n" }) },
      {
        label: "a symlinked parent leaving the worktree",
        after: (wt) => {
          mkdirSync(path.join(root, "outside", "skills"), { recursive: true });
          symlinkSync(path.join(root, "outside"), path.join(wt, ".fake"));
        },
      },
      {
        label: "already on disk (untracked)",
        after: (wt) => {
          mkdirSync(path.join(wt, ".fake/skills"), { recursive: true });
          writeFileSync(path.join(wt, ALPHA), "someone's file\n");
          writeFileSync(path.join(wt, BETA), "someone's file\n");
        },
      },
    ];
    for (const { label, before, after } of cases) {
      before?.();
      const { run, wt } = await running();
      after?.(wt);
      const out = await mgr.writeNativeSkills(run.id, FAKE_NATIVE_SKILL_LOCATION, SKILLS);
      expect(
        out.map((e) => [e.delivery, e.fallback_reason]),
        label,
      ).toEqual([
        ["prompt_prefix", "path_taken"],
        ["prompt_prefix", "path_taken"],
      ]);
      expect(
        rows(run.id).map((r) => r.native_path),
        label,
      ).toEqual([null, null]);
      expect(existsSync(path.join(root, "outside", "skills", "switchboard-alpha-docs.md")), label).toBe(false);
      if (label === "already on disk (untracked)") {
        // Never recorded, so never removed: the cleaner only touches what the writer made.
        expect((await mgr.removeNativeSkills(run.id, "terminal")).examined).toBe(0);
        expect(readFileSync(path.join(wt, ALPHA), "utf8")).toBe("someone's file\n");
      }
      g(repo, "reset", "-q", "--hard", g(repo, "rev-list", "--max-parents=0", "HEAD"));
    }
  });

  it("falls back with write_failed when rendering or writing fails, leaving nothing behind", async () => {
    const { run, wt } = await running();
    const broken: NativeSkillLocation = {
      ...FAKE_NATIVE_SKILL_LOCATION,
      render: () => {
        throw new Error("renderer failure");
      },
    };
    const out = await mgr.writeNativeSkills(run.id, broken, SKILLS);
    expect(out.map((e) => e.fallback_reason)).toEqual(["write_failed", "write_failed"]);
    expect(rows(run.id).map((r) => r.native_path)).toEqual([null, null]);
    expect(existsSync(path.join(wt, ".fake"))).toBe(false);
  });

  it("uses the directory layout and removes only the now-empty switchboard- directory it created", async () => {
    const { run, wt } = await running();
    const out = await mgr.writeNativeSkills(run.id, DIR_LAYOUT, SKILLS);
    expect(out.map((e) => e.native_path)).toEqual([
      ".agentx/skills/switchboard-alpha-docs/SKILL.md",
      ".agentx/skills/switchboard-beta-review/SKILL.md",
    ]);
    expect(readFileSync(path.join(wt, ".agentx/skills/switchboard-alpha-docs/SKILL.md"), "utf8")).toBe(
      "# alpha-docs\nAlpha body.\n",
    );
    // The agent leaves a file of its own beside beta's: that directory is kept (never removed recursively).
    writeFileSync(path.join(wt, ".agentx/skills/switchboard-beta-review/notes.md"), "mine\n");
    const res = await mgr.removeNativeSkills(run.id, "before_verifying");
    expect(res).toEqual({ examined: 2, failed: 0 });
    expect(existsSync(path.join(wt, ".agentx/skills/switchboard-alpha-docs"))).toBe(false);
    expect(readFileSync(path.join(wt, ".agentx/skills/switchboard-beta-review/notes.md"), "utf8")).toBe("mine\n");
    expect(existsSync(path.join(wt, ".agentx/skills"))).toBe(true);
  });
});

describe("cleaner (T16.6, LLD §19.8)", () => {
  it("reports edits, replacement by a link and replacement by a directory; never follows a link; idempotent", async () => {
    const { run, wt } = await running();
    await mgr.writeNativeSkills(run.id, FAKE_NATIVE_SKILL_LOCATION, SKILLS);
    writeFileSync(path.join(wt, ALPHA), "edited by the agent\n");
    const target = path.join(root, "outside-target.txt");
    writeFileSync(target, "not Switchboard's\n");
    unlinkSync(path.join(wt, BETA));
    symlinkSync(target, path.join(wt, BETA));
    expect(await mgr.removeNativeSkills(run.id, "before_verifying")).toEqual({ examined: 2, failed: 0 });
    expect(readFileSync(target, "utf8")).toBe("not Switchboard's\n");
    const tampered = events(run.id, "skill_tampered");
    expect(tampered).toEqual([
      {
        name: "alpha-docs",
        native_path: ALPHA,
        written_sha256: sha256("Alpha body.\n"),
        found_sha256: sha256("edited by the agent\n"),
      },
      { name: "beta-review", native_path: BETA, written_sha256: sha256("Beta body.\n"), found_sha256: null },
    ]);
    expect(rows(run.id).map((r) => r.removal)).toEqual(["verified", "verified"]);
    // Idempotent: nothing left to examine, no further event.
    const n = ledger.listRunEvents(run.id).length;
    expect(await mgr.removeNativeSkills(run.id, "terminal")).toEqual({ examined: 0, failed: 0 });
    expect(ledger.listRunEvents(run.id)).toHaveLength(n);

    // A directory in place of the file is never removed: the removal fails and stays pending.
    const second = await running();
    await mgr.writeNativeSkills(second.run.id, FAKE_NATIVE_SKILL_LOCATION, SKILLS.slice(0, 1));
    unlinkSync(path.join(second.wt, ALPHA));
    mkdirSync(path.join(second.wt, ALPHA));
    expect(await mgr.removeNativeSkills(second.run.id, "terminal")).toEqual({ examined: 1, failed: 1 });
    expect(events(second.run.id, "skill_cleanup_failed")).toEqual([
      { name: "alpha-docs", native_path: ALPHA, errno: "EISDIR" },
    ]);
    expect(await nativeSkillPresent(db, second.session.id)).toBe(true);
  });

  it("an injected unlink failure sets removal = failed and the path stays present until a later pass", async () => {
    const { session, run, wt } = await running();
    await mgr.writeNativeSkills(run.id, FAKE_NATIVE_SKILL_LOCATION, SKILLS);
    unlinkFailures = 2;
    expect(await mgr.removeNativeSkills(run.id, "before_verifying")).toEqual({ examined: 2, failed: 2 });
    expect(rows(run.id).map((r) => r.removal)).toEqual(["failed", "failed"]);
    expect(events(run.id, "skill_cleanup_failed").map((e) => e.errno)).toEqual(["EPERM", "EPERM"]);
    expect(await nativeSkillPresent(db, session.id)).toBe(true);
    expect(await mgr.removeNativeSkills(run.id, "terminal")).toEqual({ examined: 2, failed: 0 });
    expect(existsSync(path.join(wt, ALPHA))).toBe(false);
    expect(await nativeSkillPresent(db, session.id)).toBe(false);
  });
});

describe("commit tool exclusion (T16.6, LLD §19.8)", () => {
  it("refuses with SKILL_PATH_IN_COMMIT when the resulting tree would still contain a recorded path", async () => {
    const { session, run, wt } = await running();
    // The publish ref already holds a file at the path the run will be given (a commit the meta-session made earlier
    // that its head no longer has); the base checkpoint does not, so native delivery proceeds.
    const base = g(repo, "rev-parse", "HEAD");
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: "old\n",
      encoding: "utf8",
    }).trim();
    g(repo, "update-index", "--add", "--cacheinfo", `100644,${blob},${ALPHA}`);
    const tree = g(repo, "write-tree");
    g(repo, "reset", "-q");
    const side = g(repo, "commit-tree", tree, "-p", base, "-m", "earlier");
    g(repo, "update-ref", publishRefFor(session.id), side);
    const out = await mgr.writeNativeSkills(run.id, FAKE_NATIVE_SKILL_LOCATION, SKILLS.slice(0, 1));
    expect(out[0]?.delivery).toBe("native");
    writeFileSync(path.join(wt, "feature.txt"), "feature\n");
    const publisher = new GitPublisher({ db, scratchDir: path.join(root, "scratch") });
    const input = {
      runId: run.id,
      message: "Add feature",
      identity: { name: "Ada", email: "ada@example.test" },
      projectId: "web",
      contextId: "main",
    };
    const err = await publisher.commit(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommitError);
    expect((err as CommitError).code).toBe("PATH_REFUSED");
    expect((err as CommitError).detailReason).toBe("SKILL_PATH_IN_COMMIT");
    expect((err as CommitError).message).toContain("SKILL_PATH_IN_COMMIT");
    expect(g(repo, "rev-parse", publishRefFor(session.id))).toBe(side);

    // Without that earlier file the same call commits, and the recorded path is not in the commit.
    g(repo, "update-ref", "-d", publishRefFor(session.id));
    const res = await publisher.commit(input);
    const names = g(repo, "ls-tree", "-r", "--name-only", res.sha).split("\n");
    expect(names).toContain("feature.txt");
    expect(names).not.toContain(ALPHA);
  });
});
