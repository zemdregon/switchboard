/**
 * The `inner.call` structured log line (T11.2, T11.14; LLD §13.8 as-built note, ADR-0012). The design's `inner.call`
 * span is not built; what the pipeline writes instead is one body-free log line per pipeline outcome, with or without a
 * ledger. Until now that line was only scanned for secrets alongside everything else; this file pins its contract: one
 * line per call, a fixed key set, scalar values, no token count, no model id, no body, and the ledger row id when one
 * exists. Scripted fake backend only: no network, no provider CLI, no model.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInnerAgent } from "../config/inner-agent.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger } from "../ledger/index.js";
import { createFakeBackend, type FakeStep } from "./fake-backend.js";
import { createInnerAgent, type InnerCallInput, type InnerLogEntry, type InnerTaskContract } from "./index.js";

/** The as-built key set from LLD §13.8: nothing else may appear on the line. */
const LINE_KEYS = [
  "attempts",
  "breaker_state",
  "call_id",
  "event",
  "input_bytes",
  "latency_ms",
  "locality",
  "output_bytes",
  "outcome",
  "reason",
  "task",
] as const;

/** Names that would mean a body, a count or an identifier leaked onto the line (LLD §13.8 forbidden list). */
const FORBIDDEN_KEY = /token|model|prompt|system|user|text|body|content|diff|url|message|objective|response/iu;

const SECRET = `sk-${"loglinesecret0123456789ABCDEF"}`;
const USER_MARK = "USER-TEXT-MARKER-5e2b";
const REPLY_MARK = "Reply-Title-Marker-91aa";
const SYSTEM_MARK = "SYSTEM-PROMPT-MARKER-c0de";

const FALLBACK = { title: "fallback" };
interface Title {
  title: string;
}
const contract: InnerTaskContract<Title, typeof FALLBACK> = {
  task: "run_title",
  template_version: "run_title.v1",
  system: `Write a title. ${SYSTEM_MARK}`,
  response_schema: {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: { title: { type: "string", minLength: 1, maxLength: 80 } },
  },
  sends_source_content: false,
  fallback: () => FALLBACK,
  accept: (v: unknown) => v as Title,
};

const dirs: string[] = [];
const dbs: { close(): void }[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Harness {
  svc: ReturnType<typeof createInnerAgent>;
  logs: InnerLogEntry[];
  ledger?: ReturnType<typeof createLedger>;
  runId?: string;
}
function harness(script: readonly FakeStep[], opts: { ledger?: boolean; locality?: "local" | "remote" } = {}): Harness {
  const logs: InnerLogEntry[] = [];
  const settings = resolveInnerAgent({
    enabled: true,
    backend: { kind: "http", base_url: "http://127.0.0.1:1", model: "cfg-model", timeout_ms: 2000 },
    tasks: { run_title: { enabled: true } },
  });
  const backend = createFakeBackend({ script, locality: opts.locality ?? "local" });
  if (opts.ledger === false) {
    return { svc: createInnerAgent(settings, { backend, logger: (e) => logs.push(e), homeDir: "/home/zz" }), logs };
  }
  const dir = mkdtempSync(path.join(tmpdir(), "sb-logline-"));
  dirs.push(dir);
  const db = openLedger(dir);
  dbs.push(db);
  const ledger = createLedger(db, { ids: createIdGenerator() });
  const session = ledger.createMetaSession({ objective: "o" });
  const run = ledger.createRun({
    metaSessionId: session.id,
    trustProfile: "edit-untrusted",
    policySnapshot: {},
    request: {},
    requestHash: "h",
    clientId: "c",
  });
  const svc = createInnerAgent(settings, { backend, ledger, logger: (e) => logs.push(e), homeDir: "/home/zz" });
  return { svc, logs, ledger, runId: run.id };
}
const input = (h: Harness, over: Partial<InnerCallInput> = {}): InnerCallInput => ({
  user: `objective: tidy the parser ${USER_MARK} key=${SECRET}`,
  ...(h.runId !== undefined ? { run_id: h.runId } : {}),
  ...over,
});

/** The single `inner.call` line of a call, asserted against the as-built contract; returns it for outcome checks. */
function theLine(h: Harness): InnerLogEntry {
  const lines = h.logs.filter((l) => l.event === "inner.call");
  expect(lines).toHaveLength(1);
  const line = lines[0] as InnerLogEntry;
  expect(Object.keys(line).sort()).toEqual([...LINE_KEYS].sort());
  for (const [k, v] of Object.entries(line)) {
    expect(k).not.toMatch(FORBIDDEN_KEY);
    expect(["string", "number", "boolean"].includes(typeof v) || v === null).toBe(true);
  }
  expect(typeof line.reason === "string" ? line.reason : "X").toMatch(/^[A-Z0-9_]{1,64}$/u);
  const text = JSON.stringify(line);
  for (const mark of [SECRET, USER_MARK, REPLY_MARK, SYSTEM_MARK, "cfg-model", "fake-model"]) {
    expect(text).not.toContain(mark);
  }
  return line;
}

describe("the inner.call log line (LLD §13.8 as built; no span, no body, no token count)", () => {
  it("an accepted call: one line, the fixed keys, call_id = the row id; the token counts stay on the row only", async () => {
    const h = harness([{ kind: "text", text: `{"title":"${REPLY_MARK}"}`, usage: { in: 10, out: 4 } }]);
    const r = await h.svc.call(contract, input(h));
    expect(r).toMatchObject({ accepted: true, value: { title: REPLY_MARK } });
    const line = theLine(h);
    const [row] = h.ledger?.listInnerCalls() ?? [];
    expect(row).toMatchObject({ tokens_in: 10, tokens_out: 4, model_id: "fake-model" });
    expect(line).toMatchObject({
      task: "run_title",
      outcome: "accepted",
      reason: null,
      attempts: 1,
      locality: "local",
      breaker_state: "closed",
      call_id: row?.id,
    });
    expect(line.input_bytes).toBe(row?.input_bytes);
    expect(line.output_bytes).toBe(row?.output_bytes);
    expect(typeof line.latency_ms).toBe("number");
  });

  it("a validator rejection after the one re-ask: one line, not one per attempt", async () => {
    const h = harness([{ kind: "text", text: `{"nope":"${REPLY_MARK}"}` }]);
    const r = await h.svc.call(contract, input(h));
    expect(r).toMatchObject({ accepted: false, outcome: "rejected_validator", reason: "SCHEMA" });
    expect(theLine(h)).toMatchObject({ outcome: "rejected_validator", reason: "SCHEMA", attempts: 2 });
  });

  it("a backend error: one line with the generic code; the backend's message is not on it", async () => {
    const h = harness([{ kind: "error", message: `boom ${REPLY_MARK} ${SECRET}` }]);
    const r = await h.svc.call(contract, input(h));
    expect(r).toMatchObject({ accepted: false, outcome: "fallback_unavailable", reason: "BACKEND_ERROR" });
    expect(theLine(h)).toMatchObject({ outcome: "fallback_unavailable", reason: "BACKEND_ERROR", attempts: 1 });
  });

  it("a project set to off: one line before any backend contact, attempts 0", async () => {
    const h = harness([{ kind: "text", text: '{"title":"never"}' }]);
    const r = await h.svc.call(contract, input(h, { project_setting: "off" }));
    expect(r).toMatchObject({ accepted: false, outcome: "fallback_disabled", reason: "PROJECT_OFF" });
    expect(theLine(h)).toMatchObject({
      outcome: "fallback_disabled",
      reason: "PROJECT_OFF",
      attempts: 0,
      latency_ms: 0,
    });
  });

  it("a remote backend without allow_remote: one line, the gate reason, attempts 0", async () => {
    const h = harness([{ kind: "text", text: '{"title":"never"}' }], { locality: "remote" });
    const r = await h.svc.call(contract, input(h));
    expect(r).toMatchObject({ accepted: false, outcome: "fallback_disabled", reason: "REMOTE_NOT_ALLOWED" });
    expect(theLine(h)).toMatchObject({
      outcome: "fallback_disabled",
      reason: "REMOTE_NOT_ALLOWED",
      attempts: 0,
      locality: "remote",
    });
  });

  it("without a ledger the line is still written once, with call_id null", async () => {
    const h = harness([{ kind: "text", text: `{"title":"${REPLY_MARK}"}`, usage: { in: 10, out: 4 } }], {
      ledger: false,
    });
    const r = await h.svc.call(contract, input(h));
    expect(r).toMatchObject({ accepted: true, value: { title: REPLY_MARK } });
    expect(theLine(h)).toMatchObject({ outcome: "accepted", attempts: 1, call_id: null });
  });

  it("a logger that throws never changes the call's result", async () => {
    const logs: InnerLogEntry[] = [];
    const settings = resolveInnerAgent({
      enabled: true,
      backend: { kind: "http", base_url: "http://127.0.0.1:1", model: "cfg-model", timeout_ms: 2000 },
      tasks: { run_title: { enabled: true } },
    });
    const backend = createFakeBackend({ script: [{ kind: "text", text: '{"title":"Fix login"}' }], locality: "local" });
    const svc = createInnerAgent(settings, {
      backend,
      logger: (e) => {
        logs.push(e);
        throw new Error("logger failure");
      },
      homeDir: "/home/zz",
    });
    const r = await svc.call(contract, { user: "objective: tidy the parser" });
    expect(r).toMatchObject({ accepted: true, value: { title: "Fix login" } });
    expect(logs.filter((l) => l.event === "inner.call")).toHaveLength(1);
  });
});
