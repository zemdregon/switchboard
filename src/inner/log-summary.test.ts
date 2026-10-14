/**
 * Log and verification-output summary (T11.9; FR-INN-13, FR-EXE-08, FR-INN-06, FR-INN-16, LLD §13.4 to §13.7). The inner
 * backend is the scripted in-process fake: no network, no model, no provider CLI. In every test the status, failure code,
 * exit codes and counts asserted come from the ledger records the test wrote (the run row and the terminal transition), and
 * the backend's text is only ever the thing under test, never the source of a figure.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import { resolveInnerAgent } from "../config/inner-agent.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import {
  LOG_SUMMARY_EVENT,
  type VerificationCommandResult,
  verificationReport,
  verificationSummary,
} from "../lifecycle/index.js";
import { buildEnvelope } from "../mcp/envelope.js";
import { outputSchema } from "../mcp/schemas.js";
import {
  buildLogSummaryInput,
  createFakeBackend,
  createInnerAgent,
  type FakeBackend,
  type FakeStep,
  HEURISTIC_TEXT_MAX_BYTES,
  heuristicExcerpt,
  type LogSummaryDeps,
  PROMPT_PROVIDER_NAMES,
  parseTestReport,
  type RecordedCheck,
  summariseVerification,
  truncateLogInput,
  validateLogSummary,
} from "./index.js";

// A planted secret in the `sk-` shape the artifact redactor knows. Assembled so no scanner flags this file.
const SECRET = `sk-${"planted0123456789ABCDEF"}`;

let root: string;
let db: Database.Database;
let ledger: Ledger;
let store: ArtifactStore;
let sessionId: string;
let runId: string;
let reportId: string;
let reportSha: string;

const scrub = (s: string) => s;

function cmd(i: number, o: Partial<VerificationCommandResult>): VerificationCommandResult {
  return {
    index: i,
    argv: ["npm", "test"],
    outcome: "passed",
    exitCode: 0,
    signal: null,
    durationMs: 5,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutTruncated: false,
    stderrTruncated: false,
    internalError: false,
    ...o,
  };
}

const longOutput = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}: ${i === n - 1 ? "FAILED 3 tests" : "ok"}`).join("\n");

interface Seed {
  stdout?: string;
  stderr?: string;
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-logsum-")));
  db = openLedger(path.join(root, "d"));
  ledger = createLedger(db, { ids: createIdGenerator() });
  store = new ArtifactStore(path.join(root, "d", "artifacts"));
  const session = ledger.createMetaSession({ objective: "test" });
  sessionId = session.id;
  const run = ledger.createRun({
    metaSessionId: session.id,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
  });
  runId = run.id;
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/**
 * A run whose verification FAILED, recorded the way the lifecycle records it: per-command events, the redacted
 * `test_report` artifact, and the terminal transition carrying the per-command summaries. check 1 passes (exit 0),
 * check 2 fails (exit 1), check 3 is not run.
 */
async function seedFailedRun(seed: Seed = {}): Promise<void> {
  const commands = [
    cmd(0, { stdout: Buffer.from("all good here\n") }),
    cmd(1, {
      outcome: "failed",
      exitCode: 1,
      stdout: Buffer.from(seed.stdout ?? longOutput(60)),
      stderr: Buffer.from(seed.stderr ?? ""),
    }),
    cmd(2, { outcome: "not_run", exitCode: null, durationMs: 0 }),
  ];
  for (const c of commands)
    if (c.outcome !== "not_run")
      ledger.appendRunEvent({ runId, type: "verification_command", payload: verificationSummary(c) });
  const body = verificationReport({ outcome: "failed", commands, internalError: false }, (b) => store.redactContent(b));
  const stored = await store.put(body);
  reportId = ledger.insertArtifact({
    runId,
    metaSessionId: sessionId,
    kind: "test_report",
    sha256: stored.sha256,
    sizeBytes: stored.sizeBytes,
    mediaType: "application/json",
  });
  reportSha = stored.sha256;
  const cur = ledger.getRunRecord(runId);
  ledger.casRunState({
    runId,
    from: cur?.state as "QUEUED",
    to: "FAILED",
    expectedVersion: cur?.version as number,
    set: { failure_code: "TEST_FAILURE", failure_detail: "verification failed: check 2 (exit 1)" },
    payload: { rule: "T14", verification: commands.map(verificationSummary), summary: "agent said done" },
  });
}

interface Opts {
  enabled?: boolean;
  task?: boolean;
  locality?: "local" | "remote";
  allowRemote?: boolean;
  allowSourceContent?: boolean;
  script?: readonly FakeStep[];
}
function deps(o: Opts = {}): { deps: LogSummaryDeps; backend: FakeBackend } {
  const settings = resolveInnerAgent({
    enabled: o.enabled ?? true,
    backend: {
      kind: "http",
      base_url: "http://127.0.0.1:9",
      model: "local-model",
      allow_remote: o.allowRemote ?? false,
    },
    tasks: {
      log_summary: {
        enabled: o.task ?? true,
        ...(o.allowSourceContent !== undefined ? { allow_source_content: o.allowSourceContent } : {}),
      },
    },
  });
  const backend = createFakeBackend({ locality: o.locality ?? "local", ...(o.script ? { script: o.script } : {}) });
  const service = createInnerAgent(settings, {
    backend,
    ledger,
    providerNames: ["claude-code", "codex", "fake", ...PROMPT_PROVIDER_NAMES],
  });
  return { deps: { service, ledger, artifacts: store }, backend };
}
const text = (value: unknown): FakeStep => ({ kind: "text", text: JSON.stringify(value) });
const envelope = () => {
  const rec = ledger.getRunRecord(runId);
  if (rec === undefined) throw new Error("no run");
  return buildEnvelope(ledger, rec, scrub);
};
/** The controller-record part of an envelope: everything that must be identical with and without any summary. */
const records = (e: ReturnType<typeof envelope>) => ({
  status: e.status,
  failure_code: e.failure_code,
  failure_detail: e.failure_detail,
  verification: e.result.verification,
  summary: e.result.summary,
  changed_files: e.result.changed_files,
});
const callRows = () => ledger.listInnerCalls({ runId });
const summaryArtifacts = () => ledger.listArtifactsForRun(runId).filter((a) => a.kind === "log_summary");

describe("log_summary task: accepted summary", () => {
  it("is labelled inner-agent generated, points at the raw artifact, and leaves every record untouched", async () => {
    await seedFailedRun();
    const before = records(envelope());
    expect(before).toMatchObject({ status: "FAILED", failure_code: "TEST_FAILURE" });
    expect(before.verification.map((v) => [v.outcome, v.exit_code])).toEqual([
      ["passed", 0],
      ["failed", 1],
      ["not_run", null],
    ]);

    const { deps: d, backend } = deps({
      script: [
        text({
          summary: "check 2 failed with exit code 1; the last line reports FAILED 3 tests.",
          notable: ["FAILED 3 tests"],
        }),
      ],
    });
    const r = await summariseVerification(d, { runId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("inner");
    expect(r.rawArtifactId).toBe(reportId);
    expect(r.rawSha256).toBe(reportSha);

    // the prompt: facts restated as labelled lines from the records, the excerpt, no identifier, no argv
    const prompt = backend.requests.map((q) => q.user).join("\n");
    expect(prompt).toContain("Recorded facts (restate, do not infer):");
    expect(prompt).toContain("- check 1: outcome passed, exit code 0");
    expect(prompt).toContain("- check 2: outcome failed, exit code 1");
    expect(prompt).toContain("- check 3: outcome not_run");
    expect(prompt).toContain("- counts: 3 checks (1 passed, 1 failed, 1 not_run)");
    expect(prompt).toContain("line 60: FAILED 3 tests");
    for (const leaked of [runId, sessionId, reportId, root, "npm"]) expect(prompt).not.toContain(leaked);

    // the stored artifact and the run event
    const [art] = summaryArtifacts();
    expect(art).toMatchObject({ id: r.summaryArtifactId, media_type: "application/json", run_id: runId });
    const stored = JSON.parse((await store.get(art?.sha256 ?? "")).toString("utf8"));
    expect(stored).toMatchObject({
      v: 1,
      source: "inner",
      template_version: "log_summary.v1",
      raw_artifact_id: reportId,
      raw_sha256: reportSha,
    });
    const ev = ledger.listRunEvents(runId).filter((e) => e.type === LOG_SUMMARY_EVENT);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.artifact_id).toBe(r.summaryArtifactId);
    expect(callRows().map((c) => [c.task, c.outcome])).toEqual([["log_summary", "accepted"]]);
    // the inner_call run event references the same artifact
    expect(ledger.listRunEvents(runId).find((e) => e.type === "inner_call")?.artifact_id).toBe(r.summaryArtifactId);

    // the envelope: a labelled, display-only view with the raw pointer; every record identical to before
    const e = envelope();
    expect(e.result.verification_summary).toMatchObject({
      source: "inner",
      text: "check 2 failed with exit code 1; the last line reports FAILED 3 tests.",
      notable: ["FAILED 3 tests"],
      raw_artifact: { id: reportId, sha256: reportSha },
      summary_artifact_id: r.summaryArtifactId,
    });
    expect(e.result.verification_summary?.label).toMatch(/inner-agent generated/u);
    expect(records(e)).toEqual(before);
    expect(e.artifacts.log_summary).toBe(r.summaryArtifactId);
    expect(e.artifacts.test_report).toBe(reportId);
    // and the tool's output schema allows it
    const validate = new Ajv2020({ strict: false }).compile(outputSchema("get_run"));
    expect(validate(JSON.parse(JSON.stringify(e)))).toBe(true);
  });

  it("a hostile backend claiming 'all tests passed' for a failing run changes no status, exit code or count", async () => {
    await seedFailedRun();
    const before = records(envelope());
    const beforeFull = JSON.stringify(envelope());

    // (a) a claim the validator recognises is rejected (after the one re-ask) and the fallback is shown
    const a = deps({ script: [text({ summary: "All tests passed. Nothing to fix.", notable: ["exit code 0"] })] });
    const ra = await summariseVerification(a.deps, { runId });
    expect(ra.ok && ra.source).toBe("heuristic");
    expect(a.backend.requests).toHaveLength(2); // asked, then one re-ask carrying only an error class
    expect(a.backend.requests[1]?.user).toContain("[previous answer rejected: rule]");
    expect(a.backend.requests[1]?.user).not.toContain("All tests passed");
    expect(callRows().map((c) => c.outcome)).toEqual(["rejected_validator"]);
    expect(records(envelope())).toEqual(before);

    // (b) a false claim the patterns cannot know is accepted as PROSE, labelled, and still decides nothing
    const b = deps({ script: [text({ summary: "No problems were found and everything is fine." })] });
    const rb = await summariseVerification(b.deps, { runId });
    expect(rb.ok && rb.source).toBe("inner");
    const e = envelope();
    expect(e.result.verification_summary?.source).toBe("inner");
    expect(e.result.verification_summary?.label).toMatch(/inner-agent generated/u);
    expect(e.result.verification_summary?.label).toMatch(/controller records/u);
    expect(records(e)).toEqual(before);
    expect(e.status).toBe("FAILED");
    expect(e.failure_code).toBe("TEST_FAILURE");
    expect(e.result.verification.map((v) => v.exit_code)).toEqual([0, 1, null]);
    // nothing else in the envelope moved either
    const { verification_summary: _v, ...resultRest } = e.result;
    const { artifacts: _a, result: _r, ...envRest } = e;
    const { artifacts: _a0, result: _r0, ...beforeRest } = JSON.parse(beforeFull);
    expect(envRest).toEqual(beforeRest);
    expect(resultRest).toEqual(_r0);
  });

  it.each([
    ["an invented number", { summary: "2043 tests failed in check 2." }],
    ["an invented exit code", { summary: "check 2 exited with code 137." }],
    ["a URL", { summary: "See https://example.test/log for check 2." }],
    ["a multi-line summary", { summary: "check 2 failed.\nSecond line." }],
    ["a blank note", { summary: "check 2 failed.", notable: ["  "] }],
    ["a too-long summary", { summary: "x".repeat(601) }],
    ["an extra property", { summary: "check 2 failed.", status: "SUCCEEDED" }],
    ["too many notes", { summary: "check 2 failed.", notable: ["a", "b", "c", "d", "e", "f"] }],
  ])("%s is rejected and the deterministic fallback is shown", async (_n, value) => {
    await seedFailedRun();
    const { deps: d } = deps({ script: [text(value)] });
    const r = await summariseVerification(d, { runId });
    expect(r.ok && r.source).toBe("heuristic");
    expect(callRows().map((c) => c.outcome)).toEqual(["rejected_validator"]);
    expect(envelope().result.verification_summary?.source).toBe("heuristic");
    expect(envelope().status).toBe("FAILED");
  });

  it("a success claim is allowed only when the records say every check passed", async () => {
    const commands = [cmd(0, { stdout: Buffer.from("ok\n") }), cmd(1, { stdout: Buffer.from("ok too\n") })];
    const stored = await store.put(
      verificationReport({ outcome: "passed", commands, internalError: false }, (b) => store.redactContent(b)),
    );
    ledger.insertArtifact({
      runId,
      metaSessionId: sessionId,
      kind: "test_report",
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
      mediaType: "application/json",
    });
    const { deps: d } = deps({ script: [text({ summary: "All tests passed in 2 checks." })] });
    const r = await summariseVerification(d, { runId });
    expect(r.ok && r.source).toBe("inner");
  });
});

describe("log_summary task: deterministic fallback", () => {
  const fails: [string, FakeStep][] = [
    ["empty output", { kind: "empty" }],
    ["backend error", { kind: "error", message: `boom ${SECRET}` }],
    ["not JSON", { kind: "text", text: "just prose" }],
  ];
  it.each(fails)("%s yields the head and tail excerpt, labelled heuristic, with counts", async (_n, step) => {
    await seedFailedRun();
    const { deps: d } = deps({ script: [step] });
    const r = await summariseVerification(d, { runId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("heuristic");
    // 60 lines of check 2, plus a header line, "all good here" and its header, plus the section header: counted by the controller
    expect(r.text.split("\n")[0]).toMatch(/^excerpt of raw output: \d+ lines, \d+ bytes$/u);
    expect(r.text).toContain("== check 1 ==");
    expect(r.text).toContain("[... ");
    expect(r.text).toContain("lines omitted ...]");
    expect(r.text).toContain("line 60: FAILED 3 tests"); // the tail
    expect(r.text).not.toContain("line 30: ok"); // the middle is omitted
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(HEURISTIC_TEXT_MAX_BYTES);
    expect(r.rawArtifactId).toBe(reportId);
    const e = envelope();
    expect(e.result.verification_summary).toMatchObject({
      source: "heuristic",
      raw_artifact: { id: reportId, sha256: reportSha },
    });
    expect(e.result.verification_summary?.label).toMatch(/heuristic/u);
    expect(e.result.verification_summary?.label).not.toMatch(/inner-agent generated/u);
    expect(e.result.verification_summary?.notable).toBeUndefined();
    // the fallback never touches a record
    expect(e.status).toBe("FAILED");
    expect(e.result.verification.map((v) => v.exit_code)).toEqual([0, 1, null]);
    // a backend error message that echoes a secret is dropped everywhere
    expect(JSON.stringify([e, ledger.listRunEvents(runId), callRows()])).not.toContain(SECRET);
  });

  it("is a pure function of the records: the same input gives the same text", async () => {
    await seedFailedRun();
    const report = parseTestReport(await store.get(reportSha)) as RecordedCheck[];
    expect(heuristicExcerpt(report)).toBe(heuristicExcerpt(report));
    const lines = heuristicExcerpt(report).split("\n");
    expect(lines.filter((l) => l.startsWith("[... "))).toHaveLength(1);
    // 8 head lines and 12 tail lines around the marker, plus the counts line
    const at = lines.findIndex((l) => l.startsWith("[... "));
    expect(at).toBe(1 + 8);
    expect(lines.length - at - 1).toBe(12);
  });

  it("strips terminal control characters and clips very long lines", () => {
    const text = heuristicExcerpt([
      {
        index: 0,
        outcome: "failed",
        exitCode: 1,
        stdout: `\u001b[31mred\u001b[0m\u0007\n${"x".repeat(5000)}`,
        stderr: "",
      },
    ]);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting that no control character survives is the point
    expect(text).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u);
    expect(text).toContain("[31mred");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(HEURISTIC_TEXT_MAX_BYTES);
    expect(heuristicExcerpt([{ index: 0, outcome: "passed", exitCode: 0, stdout: "", stderr: "" }])).toBe(
      "excerpt of raw output: 0 lines, 0 bytes\n(no output)",
    );
  });
});

describe("log_summary task: gates and absence", () => {
  it("with the task not enabled (or the agent off) nothing is produced, called or written", async () => {
    await seedFailedRun();
    for (const o of [{ task: false }, { enabled: false }]) {
      const { deps: d, backend } = deps(o);
      expect(await summariseVerification(d, { runId })).toEqual({ ok: false, reason: "NOT_ENABLED" });
      expect(backend.requests).toHaveLength(0);
    }
    expect(summaryArtifacts()).toEqual([]);
    expect(ledger.listRunEvents(runId).some((e) => e.type === LOG_SUMMARY_EVENT)).toBe(false);
    expect(callRows()).toEqual([]);
    expect(envelope().result.verification_summary).toBeUndefined();
  });

  it("a run with no verification report has nothing to summarise", async () => {
    const { deps: d, backend } = deps();
    expect(await summariseVerification(d, { runId })).toEqual({ ok: false, reason: "NO_VERIFICATION_OUTPUT" });
    expect(backend.requests).toHaveLength(0);
  });

  it("a malformed report is not summarised", async () => {
    const stored = await store.put(JSON.stringify({ v: 2, commands: [] }));
    ledger.insertArtifact({
      runId,
      metaSessionId: sessionId,
      kind: "test_report",
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
      mediaType: "application/json",
    });
    const { deps: d } = deps();
    expect(await summariseVerification(d, { runId })).toEqual({ ok: false, reason: "NO_VERIFICATION_OUTPUT" });
  });

  // Log output is source-like content, so the seven-row gate of LLD §13.5 applies exactly as for diffs.
  it.each([
    ["a remote backend without allow_remote", { locality: "remote", allowRemote: false } as Opts, "REMOTE_NOT_ALLOWED"],
    [
      "a remote backend without the per-task source opt-in",
      { locality: "remote", allowRemote: true } as Opts,
      "SOURCE_CONTENT_NOT_ALLOWED",
    ],
  ])("%s: no byte is sent and the fallback is shown", async (_n, o, reason) => {
    await seedFailedRun();
    const { deps: d, backend } = deps({ ...o, script: [text({ summary: "check 2 failed." })] });
    const r = await summariseVerification(d, { runId });
    expect(r.ok && r.source).toBe("heuristic");
    expect(backend.requests).toHaveLength(0);
    expect(callRows().map((c) => [c.outcome, c.reason])).toEqual([["fallback_disabled", reason]]);
  });

  it("a remote backend with both opt-ins is called; a project set to off or local_only is not", async () => {
    await seedFailedRun();
    const ok = deps({
      locality: "remote",
      allowRemote: true,
      allowSourceContent: true,
      script: [text({ summary: "check 2 failed." })],
    });
    expect((await summariseVerification(ok.deps, { runId })).ok).toBe(true);
    expect(ok.backend.requests).toHaveLength(1);
    for (const [setting, locality] of [
      ["off", "local"],
      ["local_only", "remote"],
    ] as const) {
      const blocked = deps({ locality, allowRemote: true, allowSourceContent: true });
      const r = await summariseVerification(blocked.deps, { runId, projectSetting: setting });
      expect(r.ok && r.source).toBe("heuristic");
      expect(blocked.backend.requests).toHaveLength(0);
    }
  });

  it("a planted secret, home path and native session ID never reach the prompt, the artifact or the envelope", async () => {
    const native = "native-session-0001";
    await seedFailedRun({ stdout: `token ${SECRET}\nat ${root}/x.ts\nsession ${native}\n${longOutput(5)}` });
    const { deps: d, backend } = deps({ script: [text({ summary: "check 2 failed with exit code 1." })] });
    const r = await summariseVerification(d, { runId, nativeSessionIds: [native] });
    expect(r.ok).toBe(true);
    const prompt = backend.requests.map((q) => `${q.system}\n${q.user}`).join("\n");
    expect(prompt).not.toContain(SECRET);
    expect(prompt).not.toContain(native);
    const all = JSON.stringify([envelope(), ledger.listRunEvents(runId), callRows()]);
    expect(all).not.toContain(SECRET);
    // the heuristic path too
    const f = deps({ script: [{ kind: "empty" }] });
    const rf = await summariseVerification(f.deps, { runId });
    expect(rf.ok && rf.text).not.toContain(SECRET);
  });
});

describe("log_summary pieces", () => {
  const checks: RecordedCheck[] = [
    { index: 0, outcome: "failed", exitCode: 2, stdout: "boom 17 times", stderr: "" },
    { index: 1, outcome: "not_run", exitCode: null, stdout: "", stderr: "" },
  ];

  it("the digit rule: only whole digit runs of the text the model was given may appear", () => {
    const seen = "check 1: exit code 2 ... 17 times";
    expect(validateLogSummary({ summary: "check 1 exited 2 after 17 times" }, seen, checks)).toBeNull();
    expect(validateLogSummary({ summary: "1700 times" }, seen, checks)).toBe("invented_number");
    expect(validateLogSummary({ summary: "ok", notable: ["code 99"] }, seen, checks)).toBe("invented_number");
    expect(validateLogSummary({ summary: "see\u0007" }, seen, checks)).toBe("control");
    expect(validateLogSummary({ summary: "www.example.test" }, seen, checks)).toBe("url");
    expect(validateLogSummary({ summary: "build is green" }, seen, checks)).toBe("success_claim");
  });

  it("the input builder keeps the facts whole and the budget keeps a 25% head and a 75% tail of the excerpt", () => {
    const big: RecordedCheck[] = [
      { index: 0, outcome: "failed", exitCode: 1, stdout: `HEAD\n${"mid\n".repeat(5000)}TAIL`, stderr: "" },
    ];
    const built = buildLogSummaryInput({ checks: big, rawArtifactId: "a", rawSha256: "b" }, 2000);
    const cut = truncateLogInput(built, 2000);
    expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(2000);
    expect(cut.text).toContain("- check 1: outcome failed, exit code 1");
    expect(cut.text).toContain("- counts: 1 checks (1 failed)");
    expect(cut.text).toMatch(/\[truncated: \d+ bytes omitted\]/u);
    expect(cut.text).toContain("HEAD");
    expect(cut.text.endsWith("TAIL")).toBe(true);
    expect(cut.omitted).toBeGreaterThan(0);
    expect(truncateLogInput("short", 100)).toEqual({ text: "short", omitted: 0 });
  });

  it("the envelope shows nothing for a malformed or forged event, and takes its label from the source", async () => {
    await seedFailedRun();
    const sha = "a".repeat(64);
    const base = { source: "inner", text: "t", raw_artifact_id: reportId, raw_sha256: sha };
    for (const bad of [
      { ...base, source: "model" },
      { ...base, text: 5 },
      { ...base, raw_sha256: "short" },
      { text: "t" },
    ]) {
      ledger.appendRunEvent({ runId, type: LOG_SUMMARY_EVENT, payload: bad });
      expect(envelope().result.verification_summary).toBeUndefined();
    }
    ledger.appendRunEvent({
      runId,
      type: LOG_SUMMARY_EVENT,
      payload: { ...base, label: "verified by the controller" },
    });
    const v = envelope().result.verification_summary;
    expect(v?.label).toMatch(/inner-agent generated/u);
    expect(v?.label).not.toMatch(/verified by the controller/u);
    // the latest event wins; heuristic ignores `notable`
    ledger.appendRunEvent({
      runId,
      type: LOG_SUMMARY_EVENT,
      payload: { ...base, source: "heuristic", notable: ["x"] },
    });
    expect(envelope().result.verification_summary).toMatchObject({ source: "heuristic" });
    expect(envelope().result.verification_summary?.notable).toBeUndefined();
  });
});
