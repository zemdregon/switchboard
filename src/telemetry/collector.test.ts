/**
 * T8.3 (FR-TEL-02, FR-TEL-03, NFR-SEC-01, LLD §7, M8 acceptance): OTLP test collector, span parent links and the
 * forbidden-attribute scanner.
 *
 * Part 1 drives the real T8.1 transport (`createTelemetry`) into the in-process collector and asserts the LLD §7 parent
 * links. Part 2 shows that each forbidden category of LLD §7 fails the scan when planted (positive controls), including
 * a forbidden value on an allowlisted key that travels through the real export path. The fake-adapter lifecycle leg
 * lives in `collector-lifecycle.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  type CollectedSpan,
  decodeOtlpSpans,
  type ForbiddenCategory,
  findForbiddenAttributes,
  parentLinkViolations,
  startTestCollector,
  type TestCollector,
} from "./fixtures/collector.js";
import { createTelemetry } from "./index.js";
import { anchorSpanId, linkForRun, resolveLink, SPAN_PARENTS, traceIdForRun } from "./links.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function collector(): Promise<TestCollector> {
  const started = await startTestCollector();
  cleanup.push(() => started.close());
  return started;
}

function telemetryTo(endpoint: string) {
  const telemetry = createTelemetry({ telemetry: { otlpEndpoint: endpoint } });
  cleanup.push(() => telemetry.close());
  return telemetry;
}

const span = (name: string, attributes: Record<string, string | number | boolean>, extra = {}): CollectedSpan => ({
  name,
  traceId: `1`,
  spanId: `1`,
  startTimeUnixNano: 0n,
  endTimeUnixNano: 0n,
  attributes,
  ...extra,
});

describe("span links (T8.3, LLD §7 tree)", () => {
  it("derives one trace per run and a stable parent id, with no run id reversible from the ids", () => {
    const delegate = linkForRun("run_1", "controller.delegate");
    const spawn = linkForRun("run_1", "provider.spawn");
    const tool = linkForRun("run_1", "agent.tool.read");
    expect(delegate.traceId).toBe(traceIdForRun("run_1"));
    expect(delegate.parentSpanId).toBeUndefined();
    expect(spawn.traceId).toBe(delegate.traceId);
    expect(spawn.parentSpanId).toBe(delegate.spanId);
    expect(tool.parentSpanId).toBe(spawn.spanId);
    expect(tool.spanId).not.toBe(linkForRun("run_1", "agent.tool.read").spanId); // repeatable spans get fresh ids
    expect(anchorSpanId("run_1", "provider.spawn")).toBe(spawn.spanId);
    expect(linkForRun("run_2", "controller.delegate").traceId).not.toBe(delegate.traceId);
    expect(delegate.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(delegate.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(`${delegate.traceId}${delegate.spanId}`).not.toContain("run_1");
  });

  it("explicit ids win, a run id selects the run's trace, and nothing else means an unrelated root", () => {
    const explicit = resolveLink({
      name: "provider.spawn",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      parentSpanId: "c".repeat(16),
    });
    expect(explicit).toEqual({ traceId: "a".repeat(32), spanId: "b".repeat(16), parentSpanId: "c".repeat(16) });
    expect(resolveLink({ name: "provider.spawn", attributes: { "run.id": "run_9" } })).toEqual(
      linkForRun("run_9", "provider.spawn"),
    );
    const root = resolveLink({ name: "inner.call" });
    expect(root.parentSpanId).toBeUndefined();
    expect(root.traceId).not.toBe(resolveLink({ name: "inner.call" }).traceId);
    // Malformed explicit ids fall back rather than exporting an invalid context.
    expect(resolveLink({ name: "provider.spawn", traceId: "0".repeat(32), spanId: "zz" }).traceId).not.toBe(
      "0".repeat(32),
    );
  });

  it("exports the LLD §7 parent link even when the child completes before its parent", async () => {
    const capture = await collector();
    const telemetry = telemetryTo(capture.endpoint);
    const now = Date.now();
    // The provider process exits before the delegation reaches its terminal state, so the child is recorded first.
    telemetry.recordSpan({
      name: "provider.spawn",
      startTime: now,
      endTime: now + 5,
      attributes: { "run.id": "run_link", provider: "fake", "exit.code": 0 },
    });
    telemetry.recordSpan({
      name: "agent.tool.read",
      startTime: now + 1,
      endTime: now + 2,
      attributes: { "run.id": "run_link", "tool.kind": "read" },
    });
    telemetry.recordSpan({
      name: "controller.delegate",
      startTime: now - 10,
      endTime: now + 20,
      attributes: { "run.id": "run_link", "run.state": "SUCCEEDED" },
    });
    telemetry.recordSpan({ name: "inner.call", startTime: now, endTime: now + 1, attributes: { "inner.task": "x" } });
    const spans = await capture.waitForSpans((s) => s.length === 4);

    const byName = new Map(spans.map((s) => [s.name, s]));
    const delegate = byName.get("controller.delegate") as CollectedSpan;
    const spawn = byName.get("provider.spawn") as CollectedSpan;
    const tool = byName.get("agent.tool.read") as CollectedSpan;
    const inner = byName.get("inner.call") as CollectedSpan;
    expect(delegate.traceId).toBe(traceIdForRun("run_link"));
    expect(delegate.parentSpanId).toBeUndefined();
    expect(spawn.traceId).toBe(delegate.traceId);
    expect(spawn.parentSpanId).toBe(delegate.spanId);
    expect(tool.traceId).toBe(delegate.traceId);
    expect(tool.parentSpanId).toBe(spawn.spanId);
    expect(inner.traceId).not.toBe(delegate.traceId);
    expect(inner.parentSpanId).toBeUndefined();
    expect(parentLinkViolations([delegate, spawn, tool], SPAN_PARENTS)).toEqual([]);
    expect(spawn.attributes).toEqual({ "run.id": "run_link", provider: "fake", "exit.code": 0 });
    expect(spawn.endTimeUnixNano - spawn.startTimeUnixNano).toBe(5_000_000n);
  });

  it("honours explicit ids on a completed span", async () => {
    const capture = await collector();
    const telemetry = telemetryTo(capture.endpoint);
    const now = Date.now();
    telemetry.recordSpan({
      name: "run.finalize",
      startTime: now,
      endTime: now + 1,
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "fedcba0987654321",
      parentSpanId: "0123456789abcdef",
    });
    const [exported] = await capture.waitForSpans((s) => s.length === 1);
    expect(exported?.traceId).toBe("1234567890abcdef1234567890abcdef");
    expect(exported?.spanId).toBe("fedcba0987654321");
    expect(exported?.parentSpanId).toBe("0123456789abcdef");
  });

  it("parentLinkViolations reports a missing, wrong or cross-trace parent and an unknown span name", () => {
    const delegate = span("controller.delegate", {}, { spanId: "a".repeat(16), traceId: "1".repeat(32) });
    const good = span(
      "provider.spawn",
      {},
      { spanId: "b".repeat(16), traceId: "1".repeat(32), parentSpanId: "a".repeat(16) },
    );
    expect(parentLinkViolations([delegate, good], SPAN_PARENTS)).toEqual([]);
    const orphan = span("provider.spawn", {}, { spanId: "c".repeat(16), traceId: "1".repeat(32) });
    const wrong = span(
      "provider.spawn",
      {},
      { spanId: "d".repeat(16), traceId: "1".repeat(32), parentSpanId: "b".repeat(16) },
    );
    const crossed = span(
      "provider.spawn",
      {},
      { spanId: "e".repeat(16), traceId: "2".repeat(32), parentSpanId: "a".repeat(16) },
    );
    const rooted = span(
      "controller.delegate",
      {},
      { spanId: "f".repeat(16), traceId: "1".repeat(32), parentSpanId: "a".repeat(16) },
    );
    const unknown = span("provider.unknown", {}, { spanId: "9".repeat(16), traceId: "1".repeat(32) });
    const violations = parentLinkViolations([delegate, good, orphan, wrong, crossed, rooted, unknown], SPAN_PARENTS);
    expect(violations).toHaveLength(5);
    expect(violations.join("\n")).toMatch(/missing parent/);
    expect(violations.join("\n")).toMatch(/parent is provider.spawn, expected controller.delegate/);
    expect(violations.join("\n")).toMatch(/different trace/);
    expect(violations.join("\n")).toMatch(/root span has a parent/);
    expect(violations.join("\n")).toMatch(/not in the LLD §7 span table/);
  });
});

describe("OTLP collector fixture (T8.3)", () => {
  it("decodes ids, timestamps and every attribute value shape", () => {
    const body = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: "provider.spawn",
                  traceId: "AB".repeat(16),
                  spanId: "CD".repeat(8),
                  parentSpanId: "EF".repeat(8),
                  startTimeUnixNano: "1000000000",
                  endTimeUnixNano: 2000000000,
                  attributes: [
                    { key: "run.id", value: { stringValue: "run_1" } },
                    { key: "exit.code", value: { intValue: "0" } },
                    { key: "duration_ms", value: { doubleValue: 1.5 } },
                    { key: "flag", value: { boolValue: true } },
                    { key: "nested", value: { arrayValue: { values: [{ stringValue: "x" }] } } },
                  ],
                },
                { name: "controller.delegate", traceId: "ab".repeat(16), spanId: "01".repeat(8), parentSpanId: "" },
              ],
            },
          ],
        },
      ],
    });
    const [spawn, delegate] = decodeOtlpSpans(body);
    expect(spawn).toEqual({
      name: "provider.spawn",
      traceId: "ab".repeat(16),
      spanId: "cd".repeat(8),
      parentSpanId: "ef".repeat(8),
      startTimeUnixNano: 1_000_000_000n,
      endTimeUnixNano: 2_000_000_000n,
      attributes: {
        "run.id": "run_1",
        "exit.code": 0,
        duration_ms: 1.5,
        flag: true,
        nested: '{"arrayValue":{"values":[{"stringValue":"x"}]}}',
      },
    });
    expect(delegate?.parentSpanId).toBeUndefined();
    expect(decodeOtlpSpans("{}")).toEqual([]);
    expect(() => decodeOtlpSpans("not json")).toThrow();
  });

  it("a stalled collector still records the body and closes cleanly", async () => {
    const stalled = await startTestCollector({ stall: true });
    cleanup.push(() => stalled.close());
    const telemetry = telemetryTo(stalled.endpoint);
    telemetry.recordSpan({ name: "provider.spawn", startTime: 1, endTime: 2 });
    await stalled.waitForSpans((s) => s.length === 1);
    await expect(stalled.waitForSpans((s) => s.length === 2, 50)).rejects.toThrow(/not met within 50 ms/);
    await stalled.close();
    await stalled.close(); // idempotent
  });
});

describe("forbidden attribute scan (T8.3, LLD §7 categories, FR-TEL-03, NFR-SEC-01)", () => {
  const CANARY = "t83canary6d1e9b2c objective text";

  it("passes a span carrying only allowlisted keys with their expected value shapes", () => {
    const clean = span("provider.spawn", {
      "run.id": "run_01HZZZ",
      "session.id": "ms_01HZZZ",
      provider: "fake",
      "adapter.version": "1.0.0",
      model: "fake-model-1",
      trust_profile: "edit-untrusted",
      "run.state": "SUCCEEDED",
      "failure.code": "PROCESS_CRASH",
      "retry.attempt": 2,
      transport: "subprocess-jsonl",
      duration_ms: 12,
      "exit.code": 0,
      "exit.signal": "SIGTERM",
      "tool.kind": "read",
      "changed_files.count": 1,
      "events.count": 5,
      "usage.input_tokens": 10,
      "usage.output_tokens": 5,
      "usage.cache_read_tokens": 0,
      "usage.cache_write_tokens": 0,
      "route.eligible_count": 1,
      "artifact.id": "art_01HZZZ",
      "artifact.sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "artifact.size_bytes": 42,
      "inner.task": "commit_message",
      "inner.outcome": "ok",
      "inner.tokens_in": 12,
    });
    expect(findForbiddenAttributes([clean], { canaries: [CANARY], paths: ["/tmp/sb-t83-work"] })).toEqual([]);
  });

  const planted: ReadonlyArray<[ForbiddenCategory, string, string | number]> = [
    ["prompt_text", "objective", "refactor the module"],
    ["prompt_text", "request.prompt", "zq-planted-9"],
    ["prompt_text", "constraints", "zq-planted-9"],
    ["command_line", "process.command_line", "git push --force"],
    ["command_line", "tool.args", "zq-planted-9"],
    ["file_content", "file.content", "zq-planted-9"],
    ["file_content", "workspace.diff", "zq-planted-9"],
    ["process_output", "stdout", "zq-planted-9"],
    ["process_output", "error.message", "zq-planted-9"],
    ["environment", "env.HOME", "zq-planted-9"],
    ["credential", "api_key", "zq-planted-9"],
    ["credential", "otlp.endpoint", "zq-planted-9"],
    ["credential", "sink.url", "zq-planted-9"],
    ["home_path", "cwd", "zq-planted-9"],
    ["reasoning_text", "provider.reasoning", "zq-planted-9"],
    ["message_body", "mcp.response", "zq-planted-9"],
    ["message_body", "inner.request", "zq-planted-9"],
  ];
  it.each(planted)("fails on a %s key (%s)", (category, key, value) => {
    const findings = findForbiddenAttributes([span("provider.spawn", { "run.id": "run_1", [key]: value })]);
    expect(findings.map((f) => f.category)).toContain(category);
    expect(findings.every((f) => f.key === key && f.span === "provider.spawn")).toBe(true);
    expect(JSON.stringify(findings)).not.toContain(String(value)); // the value never travels into a finding
  });

  const plantedValues: ReadonlyArray<[ForbiddenCategory, string]> = [
    ["canary", `summary: ${CANARY}`],
    ["home_path", "/home/operator/.config/switchboard"],
    ["home_path", "/Users/operator/repo"],
    ["home_path", "C:\\Users\\operator\\repo"],
    ["home_path", "/tmp/sb-t83-work/repo/README.md"],
    ["credential", "https://hooks.example.test/services/T000/B000/XXXX"],
    ["credential", "http://127.0.0.1:4318/v1/traces"],
    ["credential", "sk-ant-api03-CANARYVALUE0123456789abcdef"],
    ["credential", "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD"],
    ["credential", "Bearer abcdefghijklmnop"],
    ["credential", "api_key=abcdefghijklmnop"],
    ["file_content", "diff --git a/x b/x\n--- a/x\n+++ b/x"],
    ["environment", "PATH=/usr/bin ANTHROPIC_API_KEY=x"],
    ["free_text", "first line\nsecond line"],
    ["free_text", "x".repeat(300)],
  ];
  it.each(plantedValues)("fails on a %s value even on an allowlisted key", (category, value) => {
    const findings = findForbiddenAttributes([span("controller.delegate", { "run.id": "run_1", model: value })], {
      canaries: [CANARY],
      paths: ["/tmp/sb-t83-work"],
    });
    expect(findings.map((f) => f.category)).toContain(category);
    for (const finding of findings) expect(JSON.stringify(finding)).not.toContain(value.slice(0, 24));
  });

  it("numbers and booleans are never free text, and a key segment match is case-insensitive", () => {
    expect(findForbiddenAttributes([span("x", { duration_ms: 10 ** 9, flag: true })])).toEqual([]);
    expect(findForbiddenAttributes([span("x", { "Process.STDOUT": "x" })]).map((f) => f.category)).toEqual([
      "process_output",
    ]);
  });

  it("catches a forbidden value on an allowlisted key through the real export path", async () => {
    const capture = await collector();
    const telemetry = telemetryTo(capture.endpoint);
    const now = Date.now();
    // An allowlisted key with a forbidden value: only value scanning (not the T8.4 key filter) can catch this.
    telemetry.recordSpan({
      name: "controller.delegate",
      startTime: now,
      endTime: now + 1,
      attributes: { "run.id": "run_planted", model: CANARY },
    });
    const spans = await capture.waitForSpans((s) => s.length === 1);
    const findings = findForbiddenAttributes(spans, { canaries: [CANARY] });
    expect(findings).toEqual([
      { category: "canary", span: "controller.delegate", key: "model", reason: expect.any(String) },
    ]);
    expect(capture.bodies.join("")).toContain(CANARY); // the collector saw it: the scan, not the transport, is the gate here
  });
});
