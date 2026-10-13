import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInnerAgent } from "../config/inner-agent.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, openLedger } from "../ledger/index.js";
import {
  CircuitBreaker,
  createFakeBackend,
  createInnerAgent,
  evaluatePrivacyGate,
  type FakeBackend,
  type FakeStep,
  type InnerAgentService,
  type InnerCallInput,
  type InnerLogEntry,
  type InnerTaskContract,
  redactInput,
  truncateHeadTail,
} from "./index.js";

// A planted secret in the `sk-` shape the artifact redactor knows. Assembled so no scanner flags this file.
const SECRET = `sk-${"planted0123456789ABCDEF"}`;
const FALLBACK = { title: "fallback" };

interface Title {
  title: string;
}
const contract = (
  over: Partial<InnerTaskContract<Title, typeof FALLBACK>> = {},
): InnerTaskContract<Title, typeof FALLBACK> => ({
  task: "run_title",
  template_version: "run_title.v1",
  system: "Write a title.",
  response_schema: {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: { title: { type: "string", minLength: 1, maxLength: 80 } },
  },
  sends_source_content: false,
  fallback: () => FALLBACK,
  accept: (v) => v as Title,
  ...over,
});

const GOOD: FakeStep = { kind: "text", text: '{"title":"Fix login"}' };

interface Harness {
  svc: InnerAgentService;
  backend: FakeBackend;
  logs: InnerLogEntry[];
  ledger: ReturnType<typeof createLedger>;
  runId: string;
  clock: { t: number };
}
const dirs: string[] = [];
const dbs: { close(): void }[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(
  script: readonly FakeStep[],
  cfg: { timeout_ms?: number; allow_remote?: boolean; tasks?: object; breaker?: object; max_concurrency?: number } = {},
  backendOpts: { locality?: "local" | "remote" } = {},
): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-inner-"));
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
  const backend = createFakeBackend({ script, ...backendOpts });
  const logs: InnerLogEntry[] = [];
  const clock = { t: 1_000_000 };
  const settings = resolveInnerAgent({
    enabled: true,
    backend: {
      kind: "http",
      base_url: "http://127.0.0.1:1",
      model: "cfg-model",
      timeout_ms: cfg.timeout_ms ?? 2000,
      ...(cfg.allow_remote !== undefined ? { allow_remote: cfg.allow_remote } : {}),
      ...(cfg.max_concurrency !== undefined ? { max_concurrency: cfg.max_concurrency } : {}),
    },
    tasks: { run_title: { enabled: true }, ...(cfg.tasks ?? {}) },
    ...(cfg.breaker !== undefined ? { breaker: cfg.breaker } : {}),
  });
  const svc = createInnerAgent(settings, {
    backend,
    ledger,
    logger: (e) => logs.push(e),
    now: () => clock.t,
    homeDir: "/home/zz",
  });
  return { svc, backend, logs, ledger, runId: run.id, clock };
}
const input = (h: Harness, over: Partial<InnerCallInput> = {}): InnerCallInput => ({
  user: "objective: tidy the parser",
  run_id: h.runId,
  ...over,
});
const rows = (h: Harness) => h.ledger.listInnerCalls();

describe("inner call pipeline (T11.2; LLD §13.4, FR-INN-07, FR-INN-08)", () => {
  it("accepts a valid answer, writes one row and one inner_call run event with no body", async () => {
    const h = harness([{ kind: "text", text: '{"title":"Fix login"}', usage: { in: 10, out: 4 }, model_id: "m-1" }]);
    const r = await h.svc.call(contract(), input(h));
    expect(r).toMatchObject({ accepted: true, value: { title: "Fix login" }, outcome: "accepted" });
    const [row] = rows(h);
    expect(row).toMatchObject({
      task: "run_title",
      backend_kind: "http",
      model_id: "m-1",
      locality: "local",
      outcome: "accepted",
      reason: null,
      attempts: 1,
      tokens_in: 10,
      tokens_out: 4,
      run_id: h.runId,
    });
    expect(row?.input_bytes).toBe(Buffer.byteLength("objective: tidy the parser"));
    expect(row?.output_bytes).toBe(Buffer.byteLength('{"title":"Fix login"}'));
    expect(row?.input_sha256).toMatch(/^[0-9a-f]{64}$/u);
    const ev = h.ledger.listRunEvents(h.runId).filter((e) => e.type === "inner_call");
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]?.payload_json ?? "{}")).toMatchObject({
      inner_call_id: row?.id,
      outcome: "accepted",
      attempts: 1,
    });
    expect(ev[0]?.payload_json).not.toContain("Fix login");
  });

  it("no row and the fallback when the task is not enabled or the agent is off", async () => {
    const h = harness([GOOD], { tasks: { run_title: { enabled: false } } });
    expect(await h.svc.call(contract(), input(h))).toMatchObject({
      accepted: false,
      outcome: "no_call",
      fallback: FALLBACK,
    });
    const off = createInnerAgent(undefined);
    expect(await off.call(contract(), { user: "x" })).toMatchObject({
      accepted: false,
      outcome: "no_call",
      fallback: FALLBACK,
    });
    expect(rows(h)).toEqual([]);
    expect(h.backend.requests).toHaveLength(0);
  });

  it("a call with no run writes the row and no run event", async () => {
    const h = harness([GOOD]);
    await h.svc.call(contract(), { user: "x" });
    expect(rows(h)).toHaveLength(1);
    expect(rows(h)[0]?.run_id).toBeNull();
    expect(h.ledger.listRunEvents(h.runId)).toEqual([]);
  });

  it("invalid output: one re-ask with a fixed class and never the rejected text; a good second answer is accepted", async () => {
    const h = harness([{ kind: "text", text: `not json ${SECRET} HOSTILE-PAYLOAD` }, GOOD]);
    const r = await h.svc.call(contract(), input(h));
    expect(r.accepted).toBe(true);
    expect(h.backend.requests).toHaveLength(2);
    expect(h.backend.requests[1]?.user).toContain("[previous answer rejected: not_json]");
    expect(h.backend.requests[1]?.user).not.toContain("HOSTILE-PAYLOAD");
    expect(rows(h)[0]).toMatchObject({ outcome: "accepted", attempts: 2 });
  });

  it("invalid twice is rejected_validator with the last error class as the reason, within the bound", async () => {
    const h = harness([{ kind: "text", text: '{"title":""}' }]);
    const r = await h.svc.call(contract(), input(h));
    expect(r).toMatchObject({ accepted: false, outcome: "rejected_validator", reason: "SCHEMA", fallback: FALLBACK });
    expect(h.backend.requests).toHaveLength(2);
    expect(rows(h)[0]).toMatchObject({ outcome: "rejected_validator", reason: "SCHEMA", attempts: 2 });
  });

  it("empty, whitespace-only and control-only output fall back (class empty)", async () => {
    for (const step of [
      { kind: "empty" },
      { kind: "text", text: " \n\t " },
      { kind: "text", text: "\u0000\u0007" },
    ] as FakeStep[]) {
      const h = harness([step]);
      const r = await h.svc.call(contract(), input(h));
      expect(r).toMatchObject({ outcome: "rejected_validator", reason: "EMPTY" });
      expect(h.backend.requests[1]?.user).toContain("rejected: empty");
    }
  });

  it("oversized output is invalid (too_long), never truncated into validity", async () => {
    const big = `{"title":"${"a".repeat(80)}"}`;
    const h = harness([{ kind: "text", text: big }]);
    const r = await h.svc.call(contract({ max_output_bytes: 40 }), input(h));
    expect(r).toMatchObject({ outcome: "rejected_validator", reason: "TOO_LONG" });
    // the default cap is max_output_tokens * 4 bytes: run_title is 80 tokens, so 320 bytes
    const h2 = harness([{ kind: "text", text: `{"title":"x","pad":"${"p".repeat(400)}"}` }]);
    expect(await h2.svc.call(contract(), input(h2))).toMatchObject({
      outcome: "rejected_validator",
      reason: "TOO_LONG",
    });
  });

  it("non-UTF-8 output (U+FFFD or a lone surrogate) is invalid", async () => {
    for (const text of ['{"title":"bad � byte"}', '{"title":"lone \uD800"}']) {
      const h = harness([{ kind: "text", text }]);
      expect(await h.svc.call(contract(), input(h))).toMatchObject({
        outcome: "rejected_validator",
        reason: "NOT_JSON",
      });
    }
  });

  it("JSON must be a single value with nothing around it; extra keys fail the schema; the rule validator applies", async () => {
    const wrapped = harness([{ kind: "text", text: '```json\n{"title":"x"}\n```' }]);
    expect(await wrapped.svc.call(contract(), input(wrapped))).toMatchObject({ reason: "NOT_JSON" });
    const extra = harness([{ kind: "text", text: '{"title":"x","extra":1}' }]);
    expect(await extra.svc.call(contract(), input(extra))).toMatchObject({ reason: "SCHEMA" });
    const rule = harness([{ kind: "text", text: '{"title":"forbidden"}' }]);
    const r = await rule.svc.call(
      contract({ validate: (v) => ((v as Title).title === "forbidden" ? "no" : null) }),
      input(rule),
    );
    expect(r).toMatchObject({ outcome: "rejected_validator", reason: "RULE" });
  });

  it("control characters are stripped from the output, including ones written as JSON escapes", async () => {
    const h = harness([{ kind: "text", text: '{"title":"a\\u0007b\\u0000c\\u001bd"}' }]);
    const r = await h.svc.call(contract(), input(h));
    expect(r).toMatchObject({ accepted: true, value: { title: "abcd" } });
  });

  it("the sanitiser can reject a valid answer (rejected_sanitiser, no re-ask)", async () => {
    const h = harness([GOOD]);
    const r = await h.svc.call(contract({ sanitise: () => null }), input(h));
    expect(r).toMatchObject({ outcome: "rejected_sanitiser", fallback: FALLBACK });
    expect(h.backend.requests).toHaveLength(1);
    const ok = await h.svc.call(contract({ sanitise: (v) => ({ title: `${v.title}!` }) }), input(h));
    expect(ok).toMatchObject({ accepted: true, value: { title: "Fix login!" } });
  });

  it("slow backend: falls back at the deadline (both attempts together), even if it ignores the abort signal", async () => {
    const h = harness([{ kind: "hang" }], { timeout_ms: 300 });
    const t0 = Date.now();
    const r = await h.svc.call(contract(), input(h));
    const took = Date.now() - t0;
    expect(r).toMatchObject({
      accepted: false,
      outcome: "fallback_unavailable",
      reason: "TIMEOUT",
      fallback: FALLBACK,
    });
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(1500);
    expect(rows(h)[0]).toMatchObject({ outcome: "fallback_unavailable", reason: "TIMEOUT", attempts: 1 });
    expect(rows(h)[0]?.latency_ms).toBeGreaterThanOrEqual(250);

    const ignoring = harness([GOOD], { timeout_ms: 300 });
    ignoring.backend.complete = () => new Promise(() => {}); // never settles, honours no signal
    const t1 = Date.now();
    expect(await ignoring.svc.call(contract(), input(ignoring))).toMatchObject({ reason: "TIMEOUT" });
    expect(Date.now() - t1).toBeLessThan(1500);
  });

  it("a slow first answer leaves no time for the re-ask: the bound covers both attempts", async () => {
    const h = harness(
      [
        { kind: "text", text: "nope", delay_ms: 250 },
        { kind: "text", text: '{"title":"late"}', delay_ms: 250 },
      ],
      {
        timeout_ms: 400,
      },
    );
    const t0 = Date.now();
    const r = await h.svc.call(contract(), input(h));
    expect(Date.now() - t0).toBeLessThan(1200);
    expect(r.accepted).toBe(false);
    expect(rows(h)[0]?.attempts).toBe(2);
  });

  it("an erroring backend falls back; its message never reaches rows, events or logs", async () => {
    const h = harness([{ kind: "error", message: `upstream said: ${SECRET} and the prompt` }]);
    const r = await h.svc.call(contract(), input(h));
    expect(r).toMatchObject({ outcome: "fallback_unavailable", reason: "BACKEND_ERROR" });
    expect(JSON.stringify([rows(h), h.ledger.listRunEvents(h.runId), h.logs])).not.toContain(SECRET);
  });

  it("an unreadable envelope (no text string) counts as a transport failure", async () => {
    const h = harness([GOOD]);
    h.backend.complete = async () => ({ model_id: "m" }) as never;
    expect(await h.svc.call(contract(), input(h))).toMatchObject({
      outcome: "fallback_unavailable",
      reason: "BACKEND_ERROR",
    });
  });

  it("a backend that throws from resolveLocality is treated as remote (fail closed)", async () => {
    const h = harness([GOOD]);
    h.backend.resolveLocality = async () => {
      throw new Error("dns");
    };
    expect(await h.svc.call(contract(), input(h))).toMatchObject({
      outcome: "fallback_disabled",
      reason: "REMOTE_NOT_ALLOWED",
    });
    expect(h.backend.requests).toHaveLength(0);
    expect(rows(h)[0]).toMatchObject({ locality: "remote", attempts: 0, latency_ms: 0, input_bytes: 0 });
  });

  it("an exception inside the pipeline becomes fallback_unavailable and never throws", async () => {
    const h = harness([GOOD]);
    const r = await h.svc.call(
      contract({
        accept: () => {
          throw new Error("boom");
        },
      }),
      input(h),
    );
    expect(r).toMatchObject({ accepted: false, outcome: "fallback_unavailable", reason: "PIPELINE_ERROR" });
    const bad = await h.svc.call(
      contract({ fallback: () => FALLBACK, response_schema: { type: "nonsense" } }),
      input(h),
    );
    expect(bad).toMatchObject({ accepted: false, outcome: "fallback_unavailable", reason: "PIPELINE_ERROR" });
  });

  it("a ledger failure does not throw into the caller and is logged as a code only", async () => {
    const h = harness([GOOD]);
    const svc = createInnerAgent(h.svc.settings, {
      backend: h.backend,
      ledger: {
        recordInnerCall: () => {
          throw new Error(`disk ${SECRET}`);
        },
      },
      logger: (e) => h.logs.push(e),
    });
    expect(await svc.call(contract(), input(h))).toMatchObject({ accepted: true });
    expect(h.logs.some((l) => l.event === "inner.record_failed")).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain(SECRET);
  });
});

describe("input handling (LLD §13.4 steps 2 to 4)", () => {
  it("a planted secret, home path, controller ID, native session ID and provider name never reach the backend, rows, events or logs", async () => {
    const h = harness([GOOD, GOOD]);
    const ctrlId = `run_${"0123456789ABCDEFGHJKMNPQRS"}`;
    const user = [
      `token=${SECRET}`,
      `Authorization: Bearer abcdefgh12345678`,
      `path /home/zz/project/file.ts`,
      `id ${ctrlId} native native-sess-777 via claude and codex`,
      "ctrl\u0007char",
    ].join("\n");
    await h.svc.call(contract(), { ...input(h), user, native_session_ids: ["native-sess-777"] });
    const sent = h.backend.requests[0]?.user ?? "";
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toContain("abcdefgh12345678");
    expect(sent).not.toContain("/home/zz");
    expect(sent).toContain("~/project/file.ts");
    expect(sent).not.toContain(ctrlId);
    expect(sent).not.toContain("native-sess-777");
    expect(sent).not.toContain("\u0007");
    // every stored artefact: rows, events, logs
    const stored = JSON.stringify([rows(h), h.ledger.listRunEvents(h.runId), h.logs]);
    for (const needle of [SECRET, "abcdefgh12345678", ctrlId, "native-sess-777", "/home/zz", "tidy"]) {
      expect(stored).not.toContain(needle);
    }
    // the hash is of the redacted text that was sent
    expect(rows(h)[0]?.input_bytes).toBe(Buffer.byteLength(sent));
  });

  it("provider names are scrubbed when configured", () => {
    expect(redactInput("ask Claude or codex-cli, not codexx", { providerNames: ["claude", "codex"] })).toBe(
      "ask [provider] or codex-cli, not codexx".replace("codex-cli", "[provider]-cli"),
    );
  });

  it("an over-budget input is truncated head 25% / tail 75% with the marker, within the budget, never mid-character", () => {
    const text = `${"H".repeat(500)}${"é".repeat(2000)}${"T".repeat(3000)}`;
    const t = truncateHeadTail(text, 1024);
    expect(Buffer.byteLength(t.text)).toBeLessThanOrEqual(1024);
    expect(t.text).toMatch(/\n\[truncated: \d+ bytes omitted\]\n/u);
    expect(t.text).not.toContain("�");
    expect(t.text.startsWith("H")).toBe(true);
    expect(t.text.endsWith("T")).toBe(true);
    expect(t.omitted).toBe(
      Buffer.byteLength(text) -
        (Buffer.byteLength(t.text) - Buffer.byteLength(`\n[truncated: ${t.omitted} bytes omitted]\n`)),
    );
    expect(truncateHeadTail("short", 1024)).toEqual({ text: "short", omitted: 0 });
  });

  it("the pipeline applies the budget and records the sent size; a task can supply its own truncation", async () => {
    const h = harness([GOOD], { tasks: { run_title: { enabled: true, input_budget_bytes: 1024 } } });
    await h.svc.call(contract(), { ...input(h), user: "x".repeat(10_000) });
    expect(rows(h)[0]?.input_bytes).toBeLessThanOrEqual(1024);
    expect(h.backend.requests[0]?.user).toContain("[truncated:");
    const custom = await h.svc.call(contract({ truncate: () => ({ text: "CUT", omitted: 1 }) }), {
      ...input(h),
      user: "y".repeat(10_000),
    });
    expect(custom.accepted).toBe(true);
    expect(h.backend.requests.at(-1)?.user).toBe("CUT");
  });
});

describe("privacy gate (LLD §13.5)", () => {
  it("implements the seven rows", () => {
    const g = (o: Partial<Parameters<typeof evaluatePrivacyGate>[0]>) =>
      evaluatePrivacyGate({
        projectSetting: "inherit",
        locality: "local",
        allowRemote: false,
        sendsSourceContent: false,
        allowSourceContent: false,
        ...o,
      });
    expect(g({ projectSetting: "off", locality: "local" })).toEqual({ allowed: false, reason: "PROJECT_OFF" });
    expect(g({ projectSetting: "local_only", locality: "remote", allowRemote: true })).toEqual({
      allowed: false,
      reason: "PROJECT_LOCAL_ONLY",
    });
    expect(g({ projectSetting: "local_only" })).toEqual({ allowed: true });
    expect(g({ locality: "remote" })).toEqual({ allowed: false, reason: "REMOTE_NOT_ALLOWED" });
    expect(g({ locality: "remote", allowRemote: true })).toEqual({ allowed: true });
    expect(g({ locality: "remote", allowRemote: true, sendsSourceContent: true })).toEqual({
      allowed: false,
      reason: "SOURCE_CONTENT_NOT_ALLOWED",
    });
    expect(g({ locality: "remote", allowRemote: true, sendsSourceContent: true, allowSourceContent: true })).toEqual({
      allowed: true,
    });
    expect(g({ sendsSourceContent: true })).toEqual({ allowed: true });
  });

  it("a denial writes fallback_disabled with a reason code and sends nothing", async () => {
    const h = harness([GOOD], {}, { locality: "remote" });
    const r = await h.svc.call(contract(), input(h));
    expect(r).toMatchObject({ outcome: "fallback_disabled", reason: "REMOTE_NOT_ALLOWED", fallback: FALLBACK });
    expect(h.backend.requests).toHaveLength(0);
    expect(rows(h)[0]).toMatchObject({ outcome: "fallback_disabled", locality: "remote", attempts: 0 });
    const off = await h.svc.call(contract(), input(h, { project_setting: "off" }));
    expect(off).toMatchObject({ reason: "PROJECT_OFF" });
  });
});

describe("circuit breaker (LLD §13.4 step 6)", () => {
  it("unit: opens at the threshold, half-opens after open_ms with one probe, closes on success, reopens on failure", () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 2, openMs: 1000, now: () => now });
    expect(b.admit()).toBe("allow");
    expect(b.failure("allow")).toBeUndefined();
    expect(b.success("allow")).toBeUndefined(); // success resets the run of failures
    b.failure("allow");
    expect(b.failure("allow")).toBe("degraded");
    expect(b.state).toBe("open");
    expect(b.admit()).toBe("deny");
    now = 999;
    expect(b.admit()).toBe("deny");
    now = 1000;
    const p = b.admit();
    expect(p).toBe("probe");
    expect(b.state).toBe("half_open");
    expect(b.admit()).toBe("deny"); // only one probe at a time
    expect(b.failure(p)).toBeUndefined();
    expect(b.state).toBe("open");
    expect(b.admit()).toBe("deny"); // timer restarted
    now = 2000;
    const p2 = b.admit();
    expect(b.success(p2)).toBe("recovered");
    expect(b.state).toBe("closed");
    expect(b.admit()).toBe("allow");
    // an abandoned probe frees the slot
    b.failure("allow");
    b.failure("allow");
    now = 3000;
    const p3 = b.admit();
    b.abandon(p3);
    expect(b.admit()).toBe("probe");
  });

  it("integration: opens after consecutive transport failures across tasks, denies without calling, then probes and recovers", async () => {
    const h = harness([{ kind: "error" }], {
      breaker: { failure_threshold: 2, open_ms: 1000 },
      tasks: { run_title: { enabled: true }, log_summary: { enabled: true } },
    });
    const other = { ...contract(), task: "log_summary" as const };
    expect(await h.svc.call(contract(), input(h))).toMatchObject({ reason: "BACKEND_ERROR" });
    expect(h.svc.breakerState).toBe("closed");
    expect(await h.svc.call(other, input(h))).toMatchObject({ reason: "BACKEND_ERROR" });
    expect(h.svc.breakerState).toBe("open");
    const seen = h.backend.requests.length;
    expect(await h.svc.call(contract(), input(h))).toMatchObject({
      outcome: "fallback_unavailable",
      reason: "CIRCUIT_OPEN",
    });
    expect(h.backend.requests).toHaveLength(seen); // no call while open
    expect(rows(h).at(-1)).toMatchObject({ reason: "CIRCUIT_OPEN", attempts: 0, latency_ms: 0 });

    // the probe fails: stays open
    h.clock.t += 1000;
    expect(await h.svc.call(contract(), input(h))).toMatchObject({ reason: "BACKEND_ERROR" });
    expect(h.backend.requests).toHaveLength(seen + 1);
    expect(h.svc.breakerState).toBe("open");

    // the probe succeeds: closes
    h.backend.setScript([GOOD]);
    h.clock.t += 1000;
    expect(await h.svc.call(contract(), input(h))).toMatchObject({ accepted: true });
    expect(h.svc.breakerState).toBe("closed");

    const events = h.ledger.listRunEvents(h.runId).filter((e) => e.type === "inner_degraded");
    expect(events.map((e) => JSON.parse(e.payload_json))).toEqual([
      { state: "degraded", reason: "BACKEND_ERROR", breaker_state: "open", backend_kind: "http" },
      { state: "recovered", reason: "", breaker_state: "closed", backend_kind: "http" },
    ]);
  });

  it("while half-open only one concurrent call is the probe", async () => {
    const h = harness([{ kind: "error" }], { breaker: { failure_threshold: 1, open_ms: 1000 } });
    await h.svc.call(contract(), input(h));
    expect(h.svc.breakerState).toBe("open");
    h.clock.t += 1000;
    h.backend.setScript([{ kind: "text", text: '{"title":"p"}', delay_ms: 150 }]);
    const [a, b] = await Promise.all([h.svc.call(contract(), input(h)), h.svc.call(contract(), input(h))]);
    expect([a.accepted, b.accepted].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.accepted)).toMatchObject({ reason: "CIRCUIT_OPEN" });
  });

  it("a validator rejection is a quality outcome and does not move the breaker", async () => {
    const h = harness([{ kind: "text", text: "garbage" }], { breaker: { failure_threshold: 1, open_ms: 1000 } });
    for (let i = 0; i < 3; i++) await h.svc.call(contract(), input(h));
    expect(h.svc.breakerState).toBe("closed");
  });
});

describe("concurrency slot (LLD §13.4 step 5)", () => {
  it("no free slot within the call's bound is fallback_unavailable BUSY, and the call is never made", async () => {
    const h = harness([{ kind: "text", text: '{"title":"slow"}', delay_ms: 600 }], {
      max_concurrency: 1,
      tasks: { run_title: { enabled: true }, log_summary: { enabled: true, timeout_ms: 200 } },
    });
    const waiter = { ...contract(), task: "log_summary" as const };
    const t0 = Date.now();
    const first = h.svc.call(contract(), input(h));
    await new Promise((r) => setTimeout(r, 30));
    const second = await h.svc.call(waiter, input(h));
    expect(second).toMatchObject({ outcome: "fallback_unavailable", reason: "BUSY" });
    expect(Date.now() - t0).toBeLessThan(600);
    expect(await first).toMatchObject({ accepted: true });
    expect(h.backend.requests).toHaveLength(1);
    expect(rows(h).find((r) => r.reason === "BUSY")).toMatchObject({ attempts: 0, latency_ms: 0 });
  });
});

describe("recording (LLD §13.4 step 13, §13.8)", () => {
  it("run_title style payloads are merged into the run event of an accepted call only", async () => {
    const h = harness([GOOD]);
    await h.svc.call(contract({ event_payload: (v) => ({ title: v.title }) }), input(h));
    const ev = h.ledger.listRunEvents(h.runId).find((e) => e.type === "inner_call");
    expect(JSON.parse(ev?.payload_json ?? "{}")).toMatchObject({ title: "Fix login" });
  });

  it("the table stays append-only and holds no prompt or response text", async () => {
    const h = harness([{ kind: "text", text: `{"title":"Visible only in the answer"}` }]);
    await h.svc.call(contract(), { ...input(h), user: "UNIQUE-PROMPT-TEXT" });
    const blob = JSON.stringify([rows(h), h.ledger.listRunEvents(h.runId), h.logs]);
    expect(blob).not.toContain("UNIQUE-PROMPT-TEXT");
    expect(blob).not.toContain("Visible only in the answer");
  });
});
