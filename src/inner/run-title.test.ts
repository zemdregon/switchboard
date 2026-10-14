/**
 * Run title and one-line summary (T11.12, Could; FR-INN-14, FR-INN-06, LLD §13.6 `run_title`, §13.7). The inner backend is
 * the scripted in-process fake: no network, no model, no provider CLI. The title is display-only: the tests also show that
 * creating one leaves the run record exactly as it was.
 */
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInnerAgent } from "../config/inner-agent.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import {
  buildRunTitleInput,
  cleanDisplayText,
  createFakeBackend,
  createInnerAgent,
  createRunTitle,
  type FakeBackend,
  type FakeStep,
  fallbackRunTitle,
  PROMPT_PROVIDER_NAMES,
  RUN_SUMMARY_MAX,
  RUN_TITLE_MAX,
  type RunTitleDeps,
  readRunTitle,
  validateRunTitle,
} from "./index.js";

const SECRET = `sk-${"planted0123456789ABCDEF"}`;

let root: string;
let db: Database.Database;
let ledger: Ledger;
let sessionId: string;
let runId: string;

const OBJECTIVE = "Fix the flaky login test in the auth module\nIt fails about one run in ten on CI.";

function seed(objective = OBJECTIVE): void {
  const session = ledger.createMetaSession({ objective });
  sessionId = session.id;
  runId = ledger.createRun({
    metaSessionId: session.id,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
  }).id;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-runtitle-")));
  db = openLedger(path.join(root, "d"));
  ledger = createLedger(db, { ids: createIdGenerator() });
  seed();
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

interface Opts {
  enabled?: boolean;
  task?: boolean;
  locality?: "local" | "remote";
  allowRemote?: boolean;
  script?: readonly FakeStep[];
}
function deps(o: Opts = {}): { deps: RunTitleDeps; backend: FakeBackend } {
  const settings = resolveInnerAgent({
    enabled: o.enabled ?? true,
    backend: {
      kind: "http",
      base_url: "http://127.0.0.1:9",
      model: "local-model",
      allow_remote: o.allowRemote ?? false,
    },
    tasks: { run_title: { enabled: o.task ?? true } },
  });
  const backend = createFakeBackend({ locality: o.locality ?? "local", ...(o.script ? { script: o.script } : {}) });
  const service = createInnerAgent(settings, {
    backend,
    ledger,
    providerNames: ["claude-code", "codex", "fake", ...PROMPT_PROVIDER_NAMES],
    homeDir: root,
  });
  return { deps: { service, ledger }, backend };
}
const text = (value: unknown): FakeStep => ({ kind: "text", text: JSON.stringify(value) });
const callRows = () => ledger.listInnerCalls({ runId });
const runRow = () => JSON.stringify(ledger.getRunRecord(runId));

describe("run_title task", () => {
  it("an accepted title and summary are recorded in the inner_call event and read back", async () => {
    const before = runRow();
    const { deps: d, backend } = deps({
      script: [text({ title: "Fix flaky login test", summary: "Stabilise the auth login test that fails on CI." })],
    });
    const r = await createRunTitle(d, { runId });
    expect(r).toMatchObject({
      ok: true,
      source: "inner",
      title: "Fix flaky login test",
      summary: "Stabilise the auth login test that fails on CI.",
    });
    expect(callRows().map((c) => [c.task, c.outcome])).toEqual([["run_title", "accepted"]]);
    const ev = ledger.listRunEvents(runId).find((e) => e.type === "inner_call");
    expect(JSON.parse(ev?.payload_json ?? "{}")).toMatchObject({
      task: "run_title",
      outcome: "accepted",
      title: "Fix flaky login test",
      summary: "Stabilise the auth login test that fails on CI.",
    });
    expect(readRunTitle(ledger, runId)).toEqual({
      source: "inner",
      title: "Fix flaky login test",
      summary: "Stabilise the auth login test that fails on CI.",
    });
    // the prompt is the objective only: no identifier, no repository content
    const prompt = backend.requests.map((q) => `${q.system}\n${q.user}`).join("\n");
    expect(prompt).toContain("flaky login test");
    for (const leaked of [runId, sessionId, root]) expect(prompt).not.toContain(leaked);
    // display-only: the run record is exactly what it was
    expect(runRow()).toBe(before);
  });

  it("caps length: a title over 80 or a summary over 200 characters is rejected, not cut, and falls back", async () => {
    for (const bad of [
      { title: "t".repeat(RUN_TITLE_MAX + 1) },
      { title: "ok", summary: "s".repeat(RUN_SUMMARY_MAX + 1) },
    ]) {
      const { deps: d } = deps({ script: [text(bad)] });
      const r = await createRunTitle(d, { runId });
      expect(r).toMatchObject({ ok: true, source: "heuristic", title: "Fix the flaky login test in the auth module" });
    }
    expect(callRows().map((c) => c.outcome)).toEqual(["rejected_validator", "rejected_validator"]);
    // exactly at the cap is fine
    const { deps: d } = deps({
      script: [text({ title: "t".repeat(RUN_TITLE_MAX), summary: "s".repeat(RUN_SUMMARY_MAX) })],
    });
    const r = await createRunTitle(d, { runId });
    expect(r.ok && r.title.length).toBe(RUN_TITLE_MAX);
    expect(r.ok && r.summary?.length).toBe(RUN_SUMMARY_MAX);
  });

  it("control characters in the output are stripped before validation; invisible and bidi characters before display", async () => {
    const { deps: d } = deps({
      script: [
        {
          kind: "text",
          // raw control characters inside the JSON strings (the JSON text is built by hand to place them raw)
          text: '{"title":"Fix\u0007 login\u001b test​‮","summary":"Stable\u0000 and‏ quick"}',
        },
      ],
    });
    const r = await createRunTitle(d, { runId });
    expect(r).toMatchObject({ ok: true, source: "inner", title: "Fix login test", summary: "Stable and quick" });
    expect(JSON.stringify(r)).not.toMatch(/\\u00[01]|\\u007f|\\u200|\\u202/u);
    expect(readRunTitle(ledger, runId)?.title).toBe("Fix login test");
  });

  it.each([
    ["a newline in the title", { title: "A\nB" }],
    ["a tab in the title", { title: "A\tB" }],
    ["a newline in the summary", { title: "A", summary: "x\ny" }],
    ["a line separator", { title: "A B" }],
    ["markdown emphasis", { title: "Fix **login** test" }],
    ["a code span", { title: "Fix `login` test" }],
    ["a heading marker", { title: "# Fix login" }],
    ["a list marker", { title: "- Fix login" }],
    ["a markdown link", { title: "Fix [login](x)" }],
    ["an html tag", { title: "Fix <b>login</b>" }],
    ["a URL in the title", { title: "See https://example.test/x" }],
    ["a URL in the summary", { title: "A", summary: "see www.example.test" }],
    ["leading space", { title: " A" }],
    ["a blank title", { title: "   " }],
    ["an extra property", { title: "A", status: "SUCCEEDED" }],
    ["an empty title", { title: "" }],
  ])("%s is rejected and the objective's first line is shown", async (_n, value) => {
    const { deps: d } = deps({ script: [text(value)] });
    const r = await createRunTitle(d, { runId });
    expect(r).toMatchObject({ ok: true, source: "heuristic", title: "Fix the flaky login test in the auth module" });
    expect(callRows().every((c) => c.outcome !== "accepted")).toBe(true);
    expect(readRunTitle(ledger, runId)).toBeUndefined();
  });

  it("is sanitised like other drafts: trailer lines, controller IDs and native session IDs do not survive", async () => {
    const native = "native-session-0001";
    const { deps: d } = deps({
      script: [text({ title: `Fix login ${runId}`, summary: `Co-authored-by: Bot bot@example.test` })],
    });
    const r = await createRunTitle(d, { runId, nativeSessionIds: [native] });
    expect(r.ok && r.source).toBe("inner");
    expect(JSON.stringify(r)).not.toContain(runId);
    expect(r.ok && r.summary).toBeUndefined(); // a summary that is only a trailer is dropped
    const { deps: d2 } = deps({ script: [text({ title: `Fix ${native} login`, summary: "Fine" })] });
    const r2 = await createRunTitle(d2, { runId, nativeSessionIds: [native] });
    expect(JSON.stringify(r2)).not.toContain(native);
    // a title that is only a trailer line is unusable: rejected_sanitiser, fallback
    const { deps: d3 } = deps({ script: [text({ title: "Co-authored-by: Bot bot@example.test" })] });
    expect(await createRunTitle(d3, { runId })).toMatchObject({ source: "heuristic" });
    expect(callRows().map((c) => c.outcome)).toEqual(["accepted", "accepted", "rejected_sanitiser"]);
  });

  it.each([
    ["empty output", { kind: "empty" } as FakeStep],
    ["backend error", { kind: "error", message: `boom ${SECRET}` } as FakeStep],
    ["not JSON", { kind: "text", text: "just prose" } as FakeStep],
  ])("%s yields the fallback and leaks nothing", async (_n, step) => {
    const { deps: d } = deps({ script: [step] });
    const r = await createRunTitle(d, { runId });
    expect(r).toMatchObject({ ok: true, source: "heuristic", title: "Fix the flaky login test in the auth module" });
    expect(JSON.stringify([r, ledger.listRunEvents(runId), callRows()])).not.toContain(SECRET);
  });

  it("with the task not enabled (or the agent off) the fallback is returned and nothing is called or written", async () => {
    for (const o of [{ task: false }, { enabled: false }]) {
      const { deps: d, backend } = deps(o);
      expect(await createRunTitle(d, { runId })).toMatchObject({ ok: true, source: "heuristic", innerCallId: null });
      expect(backend.requests).toHaveLength(0);
    }
    expect(callRows()).toEqual([]);
    expect(ledger.listRunEvents(runId).some((e) => e.type === "inner_call")).toBe(false);
    expect(await createRunTitle(deps().deps, { runId: "run_unknown" })).toEqual({ ok: false, reason: "NO_SUCH_RUN" });
  });

  // The objective is not repository content, so only `allow_remote` gates a remote backend (LLD §13.5, Assumption).
  it("privacy gates: remote needs allow_remote; project off and local_only never call a remote backend", async () => {
    const denied = deps({ locality: "remote", allowRemote: false });
    expect(await createRunTitle(denied.deps, { runId })).toMatchObject({ source: "heuristic" });
    expect(denied.backend.requests).toHaveLength(0);
    expect(callRows().map((c) => [c.outcome, c.reason])).toEqual([["fallback_disabled", "REMOTE_NOT_ALLOWED"]]);
    const ok = deps({ locality: "remote", allowRemote: true, script: [text({ title: "Fix login" })] });
    expect(await createRunTitle(ok.deps, { runId })).toMatchObject({ source: "inner" });
    for (const [setting, locality] of [
      ["off", "local"],
      ["local_only", "remote"],
    ] as const) {
      const blocked = deps({ locality, allowRemote: true });
      expect(await createRunTitle(blocked.deps, { runId, projectSetting: setting })).toMatchObject({
        source: "heuristic",
      });
      expect(blocked.backend.requests).toHaveLength(0);
    }
  });

  it("a planted secret and home path in the objective never reach the prompt", async () => {
    seed(`Rotate the key ${SECRET} stored in ${root}/keys\nthen redeploy`);
    const { deps: d, backend } = deps({ script: [text({ title: "Rotate the key" })] });
    await createRunTitle(d, { runId });
    const prompt = backend.requests.map((q) => q.user).join("\n");
    expect(prompt).not.toContain(SECRET);
    expect(prompt).not.toContain(root);
    expect(prompt).toContain("Rotate the key");
  });
});

describe("run title pieces", () => {
  it("the fallback is the first non-empty line, cleaned, at most 80 characters, and deterministic", () => {
    expect(fallbackRunTitle("\n\n  Hello   world \nsecond")).toBe("Hello world");
    expect(fallbackRunTitle("A".repeat(200))).toBe("A".repeat(80));
    expect(fallbackRunTitle("😀".repeat(100))).toBe("😀".repeat(80)); // by character, never inside a surrogate pair
    expect(fallbackRunTitle("\u0007\u001b[31mRed‮ text​")).toBe("[31mRed text");
    expect(fallbackRunTitle("")).toBe("");
    expect(fallbackRunTitle("same")).toBe(fallbackRunTitle("same"));
  });

  it("cleanDisplayText removes controls and invisible characters and collapses whitespace", () => {
    expect(cleanDisplayText("a\tb\n c\u0000d​e f")).toBe("a b cdef");
  });

  it("the input is the start of the objective and nothing else, within the byte budget", () => {
    const input = buildRunTitleInput("x".repeat(10_000), 2000);
    expect(input.startsWith("Task description:\n")).toBe(true);
    expect(Buffer.byteLength(input)).toBeLessThanOrEqual(2000 + 20);
    expect(buildRunTitleInput("é".repeat(5000), 500)).not.toContain("�");
  });

  it("validateRunTitle accepts plain single-line text", () => {
    expect(validateRunTitle({ title: "Fix login_test in auth", summary: "Plain text, 2 lines of it." })).toBeNull();
    expect(validateRunTitle({ title: "snake_case_name is fine" })).toBeNull();
  });

  it("readRunTitle re-cleans what it reads and ignores other tasks, outcomes and malformed payloads", () => {
    ledger.appendRunEvent({
      runId,
      type: "inner_call",
      payload: { task: "commit_message", outcome: "accepted", title: "x" },
    });
    ledger.appendRunEvent({
      runId,
      type: "inner_call",
      payload: { task: "run_title", outcome: "rejected_validator", title: "x" },
    });
    ledger.appendRunEvent({ runId, type: "inner_call", payload: { task: "run_title", outcome: "accepted", title: 5 } });
    expect(readRunTitle(ledger, runId)).toBeUndefined();
    ledger.appendRunEvent({
      runId,
      type: "inner_call",
      payload: { task: "run_title", outcome: "accepted", title: `ok‮${"y".repeat(200)}`, summary: "s\nt" },
    });
    expect(readRunTitle(ledger, runId)).toEqual({ source: "inner", title: `ok${"y".repeat(78)}`, summary: "s t" });
  });
});

describe("run title is display-only", () => {
  it("no module outside src/inner/ imports the run-title task or its reader", () => {
    const src = path.resolve(import.meta.dirname, "..");
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(full);
        } else if (/\.ts$/u.test(e.name) && /run-title|readRunTitle|createRunTitle/u.test(readFileSync(full, "utf8"))) {
          importers.push(path.relative(src, full));
        }
      }
    };
    walk(src);
    expect(importers.filter((f) => !f.startsWith("inner/"))).toEqual([]);
  });
});
