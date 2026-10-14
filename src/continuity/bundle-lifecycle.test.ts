/**
 * T5.4 end to end on the two continuity fakes (T5.2) through the real lifecycle, workspace manager and artifact store,
 * with real Git in a temporary repository (FR-SES-04, FR-SES-05, FR-TEL-03, ADR-0001, ADR-0038 item 1.2). Each fake
 * keeps a canary "transcript" under a temporary HOME and reports its state paths on stdout, so the provider stdout
 * artifacts hold those paths: neither the transcript canary nor anything only the stream artifacts hold may reach the
 * bundle, and the builder reads the content of `changed_files` and `test_report` artifacts only. No real provider CLI
 * is invoked.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { firstFake, SECOND_FAKE_ID, secondFake, secondFakeProvider } from "../adapters/fixtures/continuity-fakes.js";
import { registerProvider } from "../adapters/providers.js";
import { AdapterRegistry } from "../adapters/registry.js";
import type { ResolvedProfile } from "../adapters/types.js";
import { ArtifactStore, REDACTION_MARKER } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import { RunLifecycle } from "../lifecycle/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { buildHandoffBundle } from "./bundle.js";
import { DEFAULT_BUNDLE_BOUNDS, type HandoffBundle } from "./bundle-schema.js";
import { takeAsOf } from "./bundle-sources.js";

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
const AWS_KEY = "AKIAQRSTUVWXYZ234567";
const profileFor = (name: ResolvedProfile["name"]): ResolvedProfile => ({
  name,
  fileAccess: "worktree",
  shell: "none",
  network: "off",
  repoConfig: "disabled",
  bypassApproved: false,
});

let root: string;
let home: string;
let repo: string;
let dataDir: string;
let db: Database.Database;
let ledger: Ledger;
let store: ArtifactStore;
let lifecycle: RunLifecycle | undefined;
let unregister: (() => void) | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-bundle-lc-")));
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
  store = new ArtifactStore(path.join(dataDir, "artifacts"));
  unregister = registerProvider(secondFakeProvider(home));
});

afterEach(async () => {
  await lifecycle?.shutdown();
  lifecycle = undefined;
  unregister?.();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("handoff bundle from a session on both fakes (T5.4)", () => {
  it("is regenerable, carries no stream or transcript content and redacts a planted secret", async () => {
    const ids = createIdGenerator();
    const workspace = new WorkspaceManager({ db, artifacts: store, dataDir, allowedRoots: [root], ids });
    const registry = new AdapterRegistry();
    registry.register(firstFake({ home, scenario: "edit_files", timeouts: PATIENT }));
    registry.register(secondFake({ home, scenario: "edit_files", timeouts: PATIENT }));
    lifecycle = new RunLifecycle({
      ledger,
      workspace,
      artifacts: store,
      adapters: registry,
      allowedRoots: [root],
      globalConcurrency: 4,
      resolveProfile: profileFor,
    });
    lifecycle.start();

    // A delegation on the first fake whose verification fails (rolled back), then a continuation on the second fake.
    const plan1 = { files: { "src/b.ts": "export const b = 1;\n" }, summary: "added b" };
    const a = await lifecycle.submit({
      clientId: "client-a",
      objective: JSON.stringify(plan1),
      workspace: repo,
      trustProfile: "edit-untrusted",
      provider: "fake",
      verificationCommands: [[NODE, "-e", "console.log('verification says no'); process.exit(2)"]],
    });
    const aDone = await lifecycle.waitForTerminal(a.runId);
    expect(aDone.state).toBe("FAILED");
    expect(aDone.failure_code).toBe("TEST_FAILURE");

    const plan2 = { files: { "src/app.ts": `export const key = "${AWS_KEY}";\n` }, summary: "wrote the app" };
    const b = await lifecycle.submit({
      clientId: "client-a",
      objective: JSON.stringify(plan2),
      workspace: repo,
      trustProfile: "edit-untrusted",
      provider: SECOND_FAKE_ID as never,
      metaSessionId: a.metaSessionId,
    });
    expect((await lifecycle.waitForTerminal(b.runId)).state).toBe("SUCCEEDED");

    const reads: string[] = [];
    const deps = {
      ledger,
      artifacts: {
        get: (h: string) => {
          reads.push(h);
          return store.get(h);
        },
      },
      redact: (x: Buffer) => store.redactContent(x),
    };
    const asOf = takeAsOf(ledger, a.metaSessionId);
    const one = await buildHandoffBundle(deps, asOf, DEFAULT_BUNDLE_BOUNDS);

    // Later events on a terminal run do not change the bundle (FR-SES-05).
    ledger.appendRunEvent({ runId: a.runId, type: "log_summary", payload: { note: "later" } });
    const two = await buildHandoffBundle(deps, asOf, DEFAULT_BUNDLE_BOUNDS);
    expect(two.bytes.equals(one.bytes)).toBe(true);
    expect(two.sha256).toBe(one.sha256);

    const text = one.bytes.toString("utf8");
    const bundle = JSON.parse(text) as HandoffBundle;
    // The stream artifacts hold the fakes' state paths (under HOME) and the transcripts hold the canary; neither
    // reaches the bundle.
    const stdoutRows = db.prepare("SELECT sha256 FROM artifact WHERE kind = 'provider_stdout'").all() as {
      sha256: string;
    }[];
    expect(stdoutRows.length).toBe(2);
    for (const row of stdoutRows) expect(readFileSync(store.pathFor(row.sha256), "utf8")).toContain(home);
    expect(text).not.toContain(home);
    expect(text).not.toContain("switchboard-canary");
    expect(text).not.toContain("prompts.log");
    // Only changed_files and test_report content was read.
    for (const h of reads) {
      const kinds = (
        db.prepare("SELECT DISTINCT kind FROM artifact WHERE sha256 = ?").all(h) as { kind: string }[]
      ).map((r) => r.kind);
      expect(kinds.every((k) => k === "changed_files" || k === "test_report")).toBe(true);
    }
    expect(reads.length).toBe(4); // two builds, each reading one changed_files and one test_report

    // The planted secret is redacted wherever it appears (goal, diff excerpt).
    expect(text).not.toContain(AWS_KEY);
    expect(bundle.diff_excerpts.find((d) => d.path === "src/app.ts")?.text).toContain(REDACTION_MARKER);

    // Content: both providers, the failed attempt with its evidence diff by id and hash, the diagnostics tail.
    expect(bundle.runs.map((r) => [r.provider, r.state, r.mode])).toEqual([
      ["fake", "FAILED", "new"],
      [SECOND_FAKE_ID, "SUCCEEDED", "new"],
    ]);
    const diff = ledger.listArtifactsForRun(a.runId).find((x) => x.kind === "diff");
    expect(bundle.failed_attempts).toEqual([
      expect.objectContaining({
        run_id: a.runId,
        provider: "fake",
        failure_code: "TEST_FAILURE",
        evidence_diff: { artifact_id: diff?.id, sha256: diff?.sha256 },
      }),
    ]);
    expect(bundle.changed_files).toEqual([{ status: "A", path: "src/app.ts" }]);
    expect(bundle.paths_to_inspect).toEqual(["src/app.ts", "src/b.ts"]);
    expect(bundle.diagnostics?.commands[0]?.output_excerpt?.stdout).toContain("verification says no");
    expect(bundle.reported.filter((r) => r.field === "summary").map((r) => r.text)).toEqual([
      "added b",
      "wrote the app",
    ]);
  }, 120_000);
});
