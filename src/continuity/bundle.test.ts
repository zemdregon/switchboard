/**
 * T5.4 "Done when" on synthetic ledger records, a real ArtifactStore and real Git in a temporary repository (FR-SES-04,
 * FR-SES-05, FR-TEL-03, NFR-SEC-01, FRD BR-8; LLD §15.1 to §15.4, §15.7 step 5; ADR-0038 items 1, 2 and 7):
 * - two builds for the same `as_of` are byte-identical with the same SHA-256, also after later events, decisions, runs
 *   and commits are appended, and a stored view regenerates byte for byte;
 * - every FR-SES-04 field is present or explicitly empty;
 * - a failed attempt lists its failure code and its evidence diff artifact by id and hash (BR-8), never its content;
 * - bounds truncate deterministically, and the bundle stays within `max_bundle_bytes`;
 * - a secret planted in the diff (and in verification output, a summary and a constraint) is redacted;
 * - the content of the provider stream artifacts and of the `diff` artifact (each holding a canary) never appears,
 *   and the builder reads the content of `changed_files` and `test_report` artifacts only;
 * - a build failure is `TOOL_FAILURE` / `HANDOFF_BUNDLE_UNAVAILABLE` and writes nothing.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore, REDACTION_MARKER } from "../artifacts/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger, type RunRow } from "../ledger/index.js";
import {
  assembleHandoffBundle,
  buildHandoffBundle,
  cutBytes,
  cutTail,
  cutText,
  parseNameStatusZ,
  regenerateHandoffBundle,
  splitPatch,
} from "./bundle.js";
import {
  type AsOf,
  BUNDLE_FIELDS,
  type BundleBounds,
  DEFAULT_BUNDLE_BOUNDS,
  FR_SES_04_FIELDS,
  HANDOFF_BUNDLE_UNAVAILABLE,
  type HandoffBundle,
  HandoffBundleError,
} from "./bundle-schema.js";
import { collectBundleSources, takeAsOf } from "./bundle-sources.js";
import { storeHandoffView } from "./handoff-view.js";

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

/** Planted in every stream artifact and in the evidence diff artifact; must never reach a bundle. */
const CANARY = "STREAM-CANARY-7f3a9c";
/** Secrets of shapes the default redactor knows (FR-TEL-03); synthetic values. */
const AWS_KEY = "AKIAABCDEFGHIJKLMNOP";
const API_LINE = 'api_key = "zz-planted-secret-value-123"';
const GH_TOKEN = `ghp_${"a1B2c3D4e5".repeat(4)}`;

let root: string;
let repo: string;
let db: Database.Database;
let ledger: Ledger;
let store: ArtifactStore;
let reads: string[];
let deps: Parameters<typeof buildHandoffBundle>[0];

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-bundle-")));
  repo = path.join(root, "repo");
  const data = path.join(root, "data");
  mkdirSync(repo);
  mkdirSync(data);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  db = openLedger(data);
  ledger = createLedger(db, { ids: createIdGenerator() });
  store = new ArtifactStore(path.join(data, "artifacts"));
  reads = [];
  deps = {
    ledger,
    artifacts: {
      get: (hash: string) => {
        reads.push(hash);
        return store.get(hash);
      },
    },
    redact: (b) => store.redactContent(b),
  };
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const commitAll = (message: string) => {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
};

function session(objective = "Build the feature", constraints: string[] = ["keep the tests green"]) {
  const s = ledger.createMetaSession({ objective, repoRoot: repo, constraints });
  const base = git(repo, "rev-parse", "HEAD");
  db.prepare("UPDATE meta_session SET base_commit = ?, head_commit = ? WHERE id = ?").run(base, base, s.id);
  return { id: s.id, base };
}

async function artifact(runId: string, sessionId: string, kind: string, content: string, media = "text/plain") {
  const stored = await store.put(content);
  return ledger.insertArtifact({
    runId,
    metaSessionId: sessionId,
    kind: kind as never,
    sha256: stored.sha256,
    sizeBytes: stored.sizeBytes,
    mediaType: media,
  });
}

interface RunSpec {
  objective?: string;
  provider?: string;
  state: "SUCCEEDED" | "FAILED" | "CANCELLED";
  failureCode?: string;
  failureDetail?: string;
  summary?: string;
  nativeSessionId?: string;
  postCommit?: string;
  changed?: { status: string; path: string }[];
  verification?: { argv: string[]; outcome: string; exit: number; stdout: string; stderr: string }[];
  mode?: "new" | "resume" | "handoff";
}

/** A terminal run with the records the lifecycle would leave (events, artifacts, decisions, binding). */
async function addRun(sessionId: string, spec: RunSpec): Promise<RunRow> {
  const provider = spec.provider ?? "fake";
  const run = ledger.createRun({
    metaSessionId: sessionId,
    state: "QUEUED",
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {
      objective: spec.objective ?? "Build the feature",
      ...(spec.verification ? { verification_commands: spec.verification.map((v) => v.argv) } : {}),
    },
    requestHash: `h-${Math.random()}`,
    clientId: "c",
    provider,
  });
  ledger.appendDecision({
    kind: "route_selected",
    runId: run.id,
    provider,
    mode: spec.mode ?? "new",
    reasons: [spec.mode === "resume" ? "same_provider_resume" : "new_session"],
  });
  const arts: Record<string, string> = {
    provider_stdout: await artifact(run.id, sessionId, "provider_stdout", `{"type":"message","text":"${CANARY}"}\n`),
    provider_stderr: await artifact(run.id, sessionId, "provider_stderr", `stderr ${CANARY}\n`),
  };
  if (spec.nativeSessionId) {
    ledger.recordProviderBinding({
      metaSessionId: sessionId,
      provider,
      nativeSessionId: spec.nativeSessionId,
      model: "m-1",
      backingProvider: "backing-x",
    });
  }
  if (spec.verification) {
    spec.verification.forEach((v, index) => {
      ledger.appendRunEvent({
        runId: run.id,
        type: "verification_command",
        payload: { index, outcome: v.outcome, exit_code: v.exit, duration_ms: 12 },
      });
    });
    const report = {
      v: 1,
      outcome: spec.verification.every((v) => v.outcome === "passed") ? "passed" : "failed",
      commands: spec.verification.map((v, index) => ({
        index,
        argv: v.argv,
        outcome: v.outcome,
        exit_code: v.exit,
        signal: null,
        duration_ms: 12,
        stdout: v.stdout,
        stderr: v.stderr,
        stdout_truncated: false,
        stderr_truncated: false,
      })),
    };
    arts.test_report = await artifact(run.id, sessionId, "test_report", JSON.stringify(report), "application/json");
    const passed = spec.verification.filter((v) => v.outcome === "passed").length;
    ledger.appendDecision({
      kind: "verification_outcome",
      runId: run.id,
      outcome: passed === spec.verification.length ? "passed" : "failed",
      passed,
      failed: spec.verification.length - passed,
      notRun: 0,
    });
  }
  if (spec.postCommit) {
    arts.diff = await artifact(run.id, sessionId, "diff", `diff --git a/x b/x\n+${CANARY}\n`, "text/x-diff");
    arts.changed_files = await artifact(
      run.id,
      sessionId,
      "changed_files",
      JSON.stringify(spec.changed ?? []),
      "application/json",
    );
    ledger.appendRunEvent({
      runId: run.id,
      type: "workspace_assessment",
      payload: { mutated: spec.state !== "SUCCEEDED", reasons: [], replay_eligible: false },
    });
    ledger.appendRunEvent({
      runId: run.id,
      type: "checkpoint",
      artifactId: arts.diff,
      payload: { kind: "post", commit: spec.postCommit, committed: true, changed_files: spec.changed?.length ?? 0 },
    });
    if (spec.state !== "SUCCEEDED") {
      const head = ledger.getMetaSessionContinuity(sessionId)?.head_commit as string;
      ledger.appendRunEvent({
        runId: run.id,
        type: "rollback",
        payload: { head, evidence_commit: spec.postCommit, mutated: true },
      });
      ledger.appendDecision({ kind: "rollback", runId: run.id, head, evidenceCommit: spec.postCommit, mutated: true });
    } else {
      db.prepare("UPDATE meta_session SET head_commit = ? WHERE id = ?").run(spec.postCommit, sessionId);
    }
  }
  const rec = ledger.getRunRecord(run.id);
  if (!rec) throw new Error("no run");
  const fin = ledger.casRunState({ runId: run.id, from: "QUEUED", to: "FINALIZING", expectedVersion: rec.version });
  if (!fin) throw new Error("lost race");
  ledger.casRunState({
    runId: run.id,
    from: "FINALIZING",
    to: spec.state,
    expectedVersion: fin.version,
    set: {
      ...(spec.state === "FAILED"
        ? { failure_code: spec.failureCode ?? "TOOL_FAILURE", failure_detail: spec.failureDetail ?? "it broke" }
        : {}),
      started_at: "2026-10-14T00:00:00.000Z",
      finished_at: "2026-10-14T00:01:00.000Z",
    },
    payload: {
      artifacts: arts,
      changed_files: spec.changed?.length ?? 0,
      ...(spec.summary ? { summary: spec.summary } : {}),
      ...(spec.nativeSessionId ? { native_session_id: spec.nativeSessionId } : {}),
      ...(spec.state === "CANCELLED" ? { code: "CANCELLED" } : {}),
    },
  });
  return run;
}

/** A meta-session with a succeeded run (planted secrets in the diff), then a failed attempt off the head chain. */
async function richSession() {
  const s = session("Build the feature", ["keep the tests green", `never print ${GH_TOKEN}`]);
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src", "config.ts"), `export const key = "${AWS_KEY}";\n// ${API_LINE}\n`);
  writeFileSync(path.join(repo, "src", "big.txt"), `${"line of text\n".repeat(800)}`);
  writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const head = commitAll("work");
  const ok = await addRun(s.id, {
    state: "SUCCEEDED",
    summary: "Implemented the feature",
    nativeSessionId: "fake-session-1",
    postCommit: head,
    changed: [
      { status: "M", path: "README.md" },
      { status: "A", path: "src/big.txt" },
      { status: "A", path: "src/config.ts" },
    ],
    verification: [{ argv: ["npm", "test"], outcome: "passed", exit: 0, stdout: "all good\n", stderr: "" }],
  });
  // The failed attempt's evidence commit lives on a side branch, not on the head chain.
  git(repo, "switch", "-q", "-c", "evidence");
  writeFileSync(path.join(repo, "src", "broken.ts"), "export const broken = true;\n");
  const evidence = commitAll("evidence");
  git(repo, "switch", "-q", "main");
  const bad = await addRun(s.id, {
    objective: "Now add the second part",
    provider: "fake-b",
    state: "FAILED",
    failureCode: "TEST_FAILURE",
    failureDetail: `verification failed: command 0 failed (exit 1) ${AWS_KEY}`,
    summary: "I tried",
    nativeSessionId: "fake-b-session-1",
    postCommit: evidence,
    changed: [{ status: "A", path: "src/broken.ts" }],
    verification: [
      {
        argv: ["npm", "test"],
        outcome: "failed",
        exit: 1,
        stdout: `${"x".repeat(3000)}\nleaked ${GH_TOKEN}\nFAIL src/broken.test.ts\n`,
        stderr: "error: boom\n",
      },
    ],
  });
  return { s, head, evidence, ok, bad };
}

const parse = (b: Buffer) => JSON.parse(b.toString("utf8")) as HandoffBundle;

describe("bundle regeneration (FR-SES-05)", () => {
  it("two builds for the same as_of are byte-identical, also after later events, runs and commits", async () => {
    const { s, ok, bad } = await richSession();
    const asOf = takeAsOf(ledger, s.id);
    const one = await buildHandoffBundle(deps, asOf, DEFAULT_BUNDLE_BOUNDS);
    const two = await buildHandoffBundle(deps, asOf, DEFAULT_BUNDLE_BOUNDS);
    expect(two.bytes.equals(one.bytes)).toBe(true);
    expect(two.sha256).toBe(one.sha256);

    // Later records: events on terminal runs (an operator push, a log summary), a new run with its own decision and
    // events, a new commit and a moved head. None of them is inside the as_of.
    ledger.appendRunEvent({ runId: ok.id, type: "log_summary", payload: { text: "later" } });
    ledger.appendRunEvent({ runId: bad.id, type: "git_push", payload: { outcome: "ACCEPTED" } });
    const later = ledger.createRun({
      metaSessionId: s.id,
      state: "QUEUED",
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: { objective: "a third instruction" },
      requestHash: "h-later",
      clientId: "c",
      provider: "fake",
    });
    ledger.appendDecision({
      kind: "route_selected",
      runId: later.id,
      provider: "fake",
      mode: "handoff",
      reasons: ["provider_named"],
    });
    ledger.appendRunEvent({ runId: later.id, type: "provider_event", payload: { kind: "message" } });
    writeFileSync(path.join(repo, "later.txt"), "later\n");
    db.prepare("UPDATE meta_session SET head_commit = ? WHERE id = ?").run(commitAll("later"), s.id);

    const three = await buildHandoffBundle(deps, asOf, DEFAULT_BUNDLE_BOUNDS);
    expect(three.bytes.equals(one.bytes)).toBe(true);
    expect(three.sha256).toBe(one.sha256);
    // A stored view regenerates from its own recorded as_of and bounds.
    const again = await regenerateHandoffBundle(deps, one.bytes);
    expect(again.sha256).toBe(one.sha256);
    expect(one.asOfSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parse(one.bytes).as_of).toEqual(asOf);
  }, 30_000);

  it("the pure assembler gives the same bytes for the same sources", async () => {
    const { s } = await richSession();
    const sources = await collectBundleSources(deps, takeAsOf(ledger, s.id));
    const redact = (b: Buffer) => store.redactContent(b);
    const a = assembleHandoffBundle(sources, DEFAULT_BUNDLE_BOUNDS, redact);
    const b = assembleHandoffBundle(sources, DEFAULT_BUNDLE_BOUNDS, redact);
    expect(a.bytes.equals(b.bytes)).toBe(true);
  }, 30_000);
});

describe("bundle content (FR-SES-04, BR-8)", () => {
  it("every field of version 1 is present; FR-SES-04 fields are filled", async () => {
    const { s, head, ok, bad } = await richSession();
    const built = await buildHandoffBundle(deps, takeAsOf(ledger, s.id), DEFAULT_BUNDLE_BOUNDS);
    const b = parse(built.bytes);
    expect(Object.keys(b).sort()).toEqual([...BUNDLE_FIELDS].sort());
    expect(b).toMatchObject({ schema: "switchboard.handoff_bundle", version: 1, builder_version: 1 });
    expect(b.goal).toBe("Build the feature");
    expect(b.constraints).toEqual(["keep the tests green", `never print ${REDACTION_MARKER}`]);
    expect(b.instructions).toEqual([{ run_id: bad.id, text: "Now add the second part" }]);
    expect(b.git).toEqual({ base_commit: s.base, head_commit: head });
    expect(b.changed_files).toEqual([
      { status: "M", path: "README.md" },
      { status: "A", path: "src/big.txt" },
      { status: "A", path: "src/config.ts" },
    ]);
    expect(b.paths_to_inspect).toEqual(["README.md", "src/big.txt", "src/broken.ts", "src/config.ts"]);
    expect(b.diff_excerpts.map((d) => d.path)).toEqual(["README.md", "src/big.txt", "src/config.ts"]);
    expect(b.diff_excerpts[1]?.truncated).toBe(true);
    expect(b.diff_excerpts[0]?.text).toContain("+hello again");
    expect(b.decisions.map((d) => d.kind)).toEqual([
      "route_selected",
      "verification_outcome",
      "route_selected",
      "verification_outcome",
      "rollback",
    ]);
    expect(b.runs.map((r) => [r.run_id, r.state, r.provider, r.harness, r.backing_provider, r.model, r.mode])).toEqual([
      [ok.id, "SUCCEEDED", "fake", "fake", "backing-x", "m-1", "new"],
      [bad.id, "FAILED", "fake-b", "fake-b", "backing-x", "m-1", "new"],
    ]);
    expect(b.runs[0]?.post_commit).toBe(head);
    expect(b.runs[1]?.verification).toEqual([{ index: 0, outcome: "failed", exit_code: 1 }]);
    expect(b.open_work.map((o) => o.kind)).toEqual([
      "last_run_failed",
      "verification_not_passing",
      "instruction_not_completed",
    ]);
    expect(b.diagnostics?.run_id).toBe(bad.id);
    expect(b.diagnostics?.commands[0]).toMatchObject({
      index: 0,
      argv: ["npm", "test"],
      outcome: "failed",
      exit_code: 1,
    });
    expect(b.diagnostics?.commands[0]?.output_excerpt?.stdout).toMatch(/^\[truncated: \d+ characters omitted\]/);
    expect(b.diagnostics?.commands[0]?.output_excerpt?.stdout).toContain("FAIL src/broken.test.ts");
    expect(b.reported).toEqual([
      { run_id: ok.id, provider: "fake", field: "summary", text: "Implemented the feature" },
      { run_id: bad.id, provider: "fake-b", field: "summary", text: "I tried" },
      {
        run_id: bad.id,
        provider: "fake-b",
        field: "failure_detail",
        text: `verification failed: command 0 failed (exit 1) ${REDACTION_MARKER}`,
      },
    ]);
  }, 30_000);

  it("a failed attempt lists its failure code and its evidence diff artifact by id and hash (BR-8)", async () => {
    const { s, head, evidence, bad } = await richSession();
    const b = parse((await buildHandoffBundle(deps, takeAsOf(ledger, s.id), DEFAULT_BUNDLE_BOUNDS)).bytes);
    const diff = ledger.listArtifactsForRun(bad.id).find((a) => a.kind === "diff");
    expect(b.failed_attempts).toEqual([
      {
        run_id: bad.id,
        provider: "fake-b",
        failure_code: "TEST_FAILURE",
        mutated: true,
        evidence_commit: evidence,
        evidence_diff: { artifact_id: diff?.id, sha256: diff?.sha256 },
        head_restored_to: head,
      },
    ]);
  }, 30_000);

  it("a cancelled run is a failed attempt with code CANCELLED; a minimal session has every field explicitly empty", async () => {
    const s = session("Only inspect", []);
    const run = await addRun(s.id, { objective: "Only inspect", state: "CANCELLED" });
    const b = parse((await buildHandoffBundle(deps, takeAsOf(ledger, s.id), DEFAULT_BUNDLE_BOUNDS)).bytes);
    expect(Object.keys(b).sort()).toEqual([...BUNDLE_FIELDS].sort());
    for (const f of FR_SES_04_FIELDS) expect(b[f]).toBeDefined();
    expect(b.constraints).toEqual([]);
    expect(b.instructions).toEqual([]);
    expect(b.changed_files).toEqual([]);
    expect(b.diff_excerpts).toEqual([]);
    expect(b.paths_to_inspect).toEqual([]);
    expect(b.diagnostics).toBeNull();
    expect(b.reported).toEqual([]);
    expect(b.truncation).toEqual([]);
    expect(b.git).toEqual({ base_commit: s.base, head_commit: s.base });
    expect(b.failed_attempts).toEqual([
      {
        run_id: run.id,
        provider: "fake",
        failure_code: "CANCELLED",
        mutated: null,
        evidence_commit: null,
        evidence_diff: null,
        head_restored_to: null,
      },
    ]);
    expect(b.open_work.map((o) => o.kind)).toEqual(["last_run_cancelled", "instruction_not_completed"]);
  }, 30_000);
});

describe("redaction and stream artifacts (FR-TEL-03, NFR-SEC-01, FR-SES-04)", () => {
  it("a secret planted in the diff, verification output, a constraint or a failure detail is redacted", async () => {
    const { s } = await richSession();
    const built = await buildHandoffBundle(deps, takeAsOf(ledger, s.id), DEFAULT_BUNDLE_BOUNDS);
    const text = built.bytes.toString("utf8");
    for (const secret of [AWS_KEY, GH_TOKEN, "zz-planted-secret-value-123"]) expect(text).not.toContain(secret);
    const config = parse(built.bytes).diff_excerpts.find((d) => d.path === "src/config.ts");
    expect(config?.text).toContain(`export const key = "${REDACTION_MARKER}";`);
    expect(config?.text).toContain(`api_key = "${REDACTION_MARKER}`);
  }, 30_000);

  it("no stream or diff artifact content reaches the bundle; only changed_files and test_report content is read", async () => {
    const { s } = await richSession();
    const built = await buildHandoffBundle(deps, takeAsOf(ledger, s.id), DEFAULT_BUNDLE_BOUNDS);
    expect(built.bytes.toString("utf8")).not.toContain(CANARY);
    const kindsRead = reads.map((h) =>
      (db.prepare("SELECT DISTINCT kind FROM artifact WHERE sha256 = ?").all(h) as { kind: string }[]).map(
        (r) => r.kind,
      ),
    );
    expect(kindsRead.length).toBeGreaterThan(0);
    for (const kinds of kindsRead) {
      expect(kinds.every((k) => k === "changed_files" || k === "test_report")).toBe(true);
    }
    // The stream artifacts do hold the canary on disk (the test is meaningful).
    const stdout = (
      db.prepare("SELECT sha256 FROM artifact WHERE kind = 'provider_stdout' LIMIT 1").get() as { sha256: string }
    ).sha256;
    expect(readFileSync(store.pathFor(stdout), "utf8")).toContain(CANARY);
  }, 30_000);
});

describe("bounds (LLD §15.4)", () => {
  const small: BundleBounds = { max_bundle_bytes: 16384, max_diff_excerpt_bytes: 6000, max_text_chars: 40 };

  it("truncate deterministically, record every cut and keep the bundle within max_bundle_bytes", async () => {
    const constraints = Array.from({ length: 64 }, (_, i) => `constraint ${i} ${"é".repeat(400)}`);
    const s = session("Build the feature", constraints);
    for (let i = 0; i < 30; i++)
      writeFileSync(path.join(repo, `f${String(i).padStart(2, "0")}.txt`), `${"x".repeat(200)}\n`);
    writeFileSync(path.join(repo, "a-big.txt"), `${"big line\n".repeat(1000)}`);
    const head = commitAll("many files");
    for (let i = 0; i < 12; i++) {
      await addRun(s.id, {
        objective: `instruction ${i} ${"y".repeat(100)}`,
        state: i === 11 ? "SUCCEEDED" : "FAILED",
        failureCode: "TOOL_FAILURE",
        failureDetail: "z".repeat(100),
        summary: `summary ${i}`,
        ...(i === 11 ? { postCommit: head } : {}),
      });
    }
    const asOf = takeAsOf(ledger, s.id);
    const one = await buildHandoffBundle(deps, asOf, small);
    const two = await buildHandoffBundle(deps, asOf, small);
    expect(one.bytes.equals(two.bytes)).toBe(true);
    expect(one.bytes.length).toBeLessThanOrEqual(small.max_bundle_bytes);
    const b = parse(one.bytes);
    expect(b.bounds).toEqual(small);
    const reasons = new Set(b.truncation.map((t) => t.reason));
    for (const r of ["text_chars", "item_limit", "diff_file_bytes", "diff_total_bytes", "bundle_bytes"]) {
      expect(reasons.has(r as never)).toBe(true);
    }
    // Newest items kept: instructions are the newest 10 (then possibly fewer, dropped from the oldest).
    expect(b.truncation.length).toBeLessThan(30);
    expect(b.truncation).toContainEqual({ field: "instructions", dropped: 2, reason: "item_limit" });
    expect(b.truncation).toContainEqual({ field: "constraints", dropped: 10 * 373 + 54 * 374, reason: "text_chars" });
    expect(b.constraints[0]).toBe(`constraint 0 ${"é".repeat(27)}[truncated: 373 characters omitted]`);
    if (b.instructions.length > 0) {
      expect(b.instructions.at(-1)?.text).toMatch(/^instruction 11 y+\[truncated: \d+ characters omitted\]$/);
    }
    expect(b.failed_attempts.map((f) => f.run_id)).toEqual(
      ledger
        .listRunsForMetaSession(s.id)
        .filter((r) => r.state === "FAILED")
        .slice(-b.failed_attempts.length)
        .map((r) => r.id),
    );
    // Diff excerpts: within the total budget, path order, cut at a code point boundary with the marker.
    const total = b.diff_excerpts.reduce(
      (n, d) => n + Buffer.byteLength(d.text.replace(/\[truncated: \d+ characters omitted\]$/, "")),
      0,
    );
    expect(total).toBeLessThanOrEqual(small.max_diff_excerpt_bytes);
    // The recorded bounds regenerate the same bytes.
    expect((await regenerateHandoffBundle(deps, one.bytes)).sha256).toBe(one.sha256);
  }, 60_000);

  it("text helpers cut at code point boundaries", () => {
    expect(cutText("abcdef", 3)).toEqual({ text: "abc[truncated: 3 characters omitted]", omitted: 3 });
    expect(cutText("ab😀cd", 3).text).toBe("ab😀[truncated: 2 characters omitted]");
    expect(cutTail("abcdef", 2).text).toBe("[truncated: 4 characters omitted]ef");
    expect(cutBytes("aé😀", 4)).toEqual({ text: "aé[truncated: 1 characters omitted]", omittedBytes: 4 });
    expect(cutBytes("abc", 3)).toEqual({ text: "abc", omittedBytes: 0 });
  });

  it("Git output parsers", () => {
    expect(parseNameStatusZ(Buffer.from("M\0a b\0A\0c\0"))).toEqual([
      { status: "M", path: "a b" },
      { status: "A", path: "c" },
    ]);
    expect(() => parseNameStatusZ(Buffer.from("R100\0a\0b\0"))).toThrow(HandoffBundleError);
    expect(splitPatch(Buffer.from("diff --git a/x b/x\n+1\ndiff --git a/y b/y\n+2\n"))).toEqual([
      "diff --git a/x b/x\n+1\n",
      "diff --git a/y b/y\n+2\n",
    ]);
    expect(splitPatch(Buffer.alloc(0))).toEqual([]);
  });
});

describe("failure: HANDOFF_BUNDLE_UNAVAILABLE and nothing written (ADR-0038 item 7)", () => {
  const rowsOf = (sessionId: string) => ({
    views: (db.prepare("SELECT COUNT(*) AS n FROM artifact WHERE kind = 'handoff_view'").get() as { n: number }).n,
    built: (
      db
        .prepare("SELECT COUNT(*) AS n FROM decision WHERE decision = 'handoff_built' AND meta_session_id = ?")
        .get(sessionId) as {
        n: number;
      }
    ).n,
  });
  const receiving = (sessionId: string) =>
    ledger.createRun({
      metaSessionId: sessionId,
      state: "QUEUED",
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: { objective: "continue" },
      requestHash: `h-${Math.random()}`,
      clientId: "c",
      provider: "fake-b",
    });

  const expectUnavailable = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HandoffBundleError);
    expect(err).toMatchObject({
      code: "TOOL_FAILURE",
      retryable: false,
      details: { reason: HANDOFF_BUNDLE_UNAVAILABLE },
      message: "the handoff bundle could not be built from the controller's records",
    });
  };

  it("a head commit that does not resolve fails and writes no view or decision", async () => {
    const { s } = await richSession();
    const asOf: AsOf = { ...takeAsOf(ledger, s.id), head_commit: "0".repeat(40) };
    const run = receiving(s.id);
    await expectUnavailable(
      storeHandoffView({ ...deps, ledger, store }, { receivingRunId: run.id, asOf, bounds: DEFAULT_BUNDLE_BOUNDS }),
    );
    expect(rowsOf(s.id)).toEqual({ views: 0, built: 0 });
  }, 30_000);

  it("a corrupt test_report artifact fails its integrity check; a missing watermark fails", async () => {
    const { s, bad } = await richSession();
    const asOf = takeAsOf(ledger, s.id);
    const tr = ledger.listArtifactsForRun(bad.id).find((a) => a.kind === "test_report");
    writeFileSync(store.pathFor(tr?.sha256 as string), "tampered");
    await expectUnavailable(buildHandoffBundle(deps, asOf, DEFAULT_BUNDLE_BOUNDS));
    const ahead: AsOf = { ...asOf, runs: asOf.runs.map((r) => ({ ...r, last_seq: r.last_seq + 100 })) };
    await expectUnavailable(buildHandoffBundle(deps, ahead, DEFAULT_BUNDLE_BOUNDS));
    expect(rowsOf(s.id)).toEqual({ views: 0, built: 0 });
  }, 30_000);

  it("as_of cannot be taken while a run is active; invalid bounds and a terminal receiving run are refused", async () => {
    const { s } = await richSession();
    const asOf = takeAsOf(ledger, s.id);
    const active = receiving(s.id);
    expect(() => takeAsOf(ledger, s.id)).toThrow(HandoffBundleError);
    await expectUnavailable(buildHandoffBundle(deps, asOf, { ...DEFAULT_BUNDLE_BOUNDS, max_bundle_bytes: 1000 }));
    // The receiving run became terminal: the decision helper refuses it and the artifact row rolls back with it.
    const rec = ledger.getRunRecord(active.id);
    ledger.casRunState({ runId: active.id, from: "QUEUED", to: "CANCELLED", expectedVersion: rec?.version ?? 0 });
    await expectUnavailable(
      storeHandoffView({ ...deps, ledger, store }, { receivingRunId: active.id, asOf, bounds: DEFAULT_BUNDLE_BOUNDS }),
    );
    expect(rowsOf(s.id)).toEqual({ views: 0, built: 0 });
  }, 30_000);
});

describe("the handoff_view artifact (LLD §15.2 Storage, §15.3)", () => {
  it("is stored once for the receiving run with the handoff_built decision, and its bytes are the built bytes", async () => {
    const { s } = await richSession();
    const asOf = takeAsOf(ledger, s.id);
    const run = ledger.createRun({
      metaSessionId: s.id,
      state: "QUEUED",
      trustProfile: "edit-untrusted",
      policySnapshot: {},
      request: { objective: "continue" },
      requestHash: "h-recv",
      clientId: "c",
      provider: "fake-b",
    });
    const out = await storeHandoffView(
      { ...deps, ledger, store },
      { receivingRunId: run.id, asOf, bounds: DEFAULT_BUNDLE_BOUNDS },
    );
    const rows = ledger.listArtifactsForRun(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: out.artifactId,
      kind: "handoff_view",
      media_type: "application/json",
      meta_session_id: s.id,
      sha256: out.sha256,
    });
    const stored = await store.get(out.sha256);
    expect(stored.equals(out.built.bytes)).toBe(true);
    expect((await regenerateHandoffBundle(deps, stored)).sha256).toBe(out.sha256);
    const decisions = ledger.listDecisionsForRun(run.id);
    expect(decisions.map((d) => [d.id, d.decision, d.reason_summary])).toEqual([
      [
        out.decisionId,
        "handoff_built",
        `bundle=${out.artifactId} sha256=${out.sha256} as_of=${out.asOfSha256} source_runs=2`,
      ],
    ]);
  }, 30_000);
});
