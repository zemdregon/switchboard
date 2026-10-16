/**
 * In-process OTLP/HTTP test collector and the LLD §7 forbidden-attribute scanner (T8.3, FR-TEL-02, FR-TEL-03,
 * NFR-SEC-01, M8 acceptance). Test fixture only: not imported by production code.
 *
 * The collector is a plain loopback HTTP server on an ephemeral port that accepts `POST /v1/traces` bodies in the OTLP
 * JSON encoding the T8.1 exporter sends, decodes every span with its trace, span and parent ids and attributes, and
 * keeps the raw bodies for whole-body canary assertions. No OpenTelemetry package is needed to receive.
 *
 * The scanner implements the forbidden categories of LLD §7 as checks over exported attribute keys and values, so a
 * test fails when a forbidden category is planted on a span (positive controls live in `../collector.test.ts`).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { DEFAULT_SECRET_PATTERNS, PREFIXED_PATTERNS } from "../../artifacts/redact.js";

export type CollectedAttributeValue = string | number | boolean;

/** One span as the collector received it (OTLP JSON, ids as lowercase hex). */
export interface CollectedSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  /** Absent for a root span. */
  readonly parentSpanId?: string;
  readonly startTimeUnixNano: bigint;
  readonly endTimeUnixNano: bigint;
  readonly attributes: Readonly<Record<string, CollectedAttributeValue>>;
}

export interface TestCollector {
  /** The OTLP/HTTP traces endpoint to put in `telemetry.otlp_endpoint`. */
  readonly endpoint: string;
  /** Raw request bodies in arrival order (for whole-body assertions). */
  readonly bodies: readonly string[];
  /** Every span decoded from every body so far, in arrival order. */
  spans(): CollectedSpan[];
  /** Resolves once `predicate` holds over the decoded spans; rejects after `timeoutMs`. */
  waitForSpans(predicate: (spans: CollectedSpan[]) => boolean, timeoutMs?: number): Promise<CollectedSpan[]>;
  /** Stops accepting and closes open connections. Idempotent. */
  close(): Promise<void>;
}

export interface TestCollectorOptions {
  /** Receive bodies but never answer, to exercise exporter timeouts. */
  readonly stall?: boolean;
}

/** Starts the collector on `127.0.0.1` with an ephemeral port. The caller must `close()` it. */
export async function startTestCollector(options: TestCollectorOptions = {}): Promise<TestCollector> {
  const bodies: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part: string) => {
      body += part;
    });
    request.on("end", () => {
      bodies.push(body);
      if (options.stall) return;
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  let closed: Promise<void> | undefined;
  const spans = () => bodies.flatMap((body) => decodeOtlpSpans(body));
  return {
    endpoint: `http://127.0.0.1:${port}/v1/traces`,
    bodies,
    spans,
    async waitForSpans(predicate, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const current = spans();
        if (predicate(current)) return current;
        if (Date.now() > deadline) {
          throw new Error(`test collector: condition not met within ${timeoutMs} ms (${current.length} spans)`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    close() {
      closed ??= new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      return closed;
    },
  };
}

// ---- OTLP JSON decoding ------------------------------------------------------------------------------------------

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: string | number;
  boolValue?: boolean;
}

interface OtlpSpan {
  name?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: Array<{ key?: string; value?: OtlpAnyValue }>;
}

interface OtlpTracesBody {
  resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: OtlpSpan[] }> }>;
}

/** Decodes one OTLP/HTTP JSON request body into spans. Throws on a body that is not OTLP JSON. */
export function decodeOtlpSpans(body: string): CollectedSpan[] {
  const parsed = JSON.parse(body) as OtlpTracesBody;
  const out: CollectedSpan[] = [];
  for (const resource of parsed.resourceSpans ?? []) {
    for (const scope of resource.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) out.push(decodeSpan(span));
    }
  }
  return out;
}

function decodeSpan(span: OtlpSpan): CollectedSpan {
  const attributes: Record<string, CollectedAttributeValue> = {};
  for (const attribute of span.attributes ?? []) {
    if (typeof attribute.key !== "string") continue;
    const value = decodeValue(attribute.value);
    if (value !== undefined) attributes[attribute.key] = value;
  }
  const parent = typeof span.parentSpanId === "string" && span.parentSpanId.length > 0 ? span.parentSpanId : undefined;
  return {
    name: String(span.name ?? ""),
    traceId: String(span.traceId ?? "").toLowerCase(),
    spanId: String(span.spanId ?? "").toLowerCase(),
    ...(parent !== undefined ? { parentSpanId: parent.toLowerCase() } : {}),
    startTimeUnixNano: BigInt(span.startTimeUnixNano ?? 0),
    endTimeUnixNano: BigInt(span.endTimeUnixNano ?? 0),
    attributes,
  };
}

function decodeValue(value: OtlpAnyValue | undefined): CollectedAttributeValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.boolValue === "boolean") return value.boolValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return Number(value.doubleValue);
  // Arrays, byte and nested values are never allowlisted; surface them as a string so the scanner still sees them.
  return JSON.stringify(value);
}

// ---- LLD §7 forbidden categories --------------------------------------------------------------------------------

/** The forbidden categories of LLD §7 (FR-TEL-03, NFR-SEC-01). */
export type ForbiddenCategory =
  | "prompt_text"
  | "command_line"
  | "file_content"
  | "process_output"
  | "environment"
  | "credential"
  | "home_path"
  | "reasoning_text"
  | "message_body"
  | "free_text"
  | "canary";

export interface ForbiddenFinding {
  readonly category: ForbiddenCategory;
  readonly span: string;
  readonly key: string;
  /** What matched: a key segment or a value pattern. The value itself is never included (it may be the secret). */
  readonly reason: string;
}

export interface ForbiddenScanOptions {
  /** Planted strings (objective, constraints, environment values, tool arguments) that must appear in no value. */
  readonly canaries?: readonly string[];
  /** Absolute directories (workspace, data directory) whose paths must not appear in a value. */
  readonly paths?: readonly string[];
}

/** Key segments (split on `.`) that name a forbidden category whatever the value. */
const FORBIDDEN_KEY_SEGMENTS: ReadonlyArray<readonly [ForbiddenCategory, ReadonlySet<string>]> = [
  ["prompt_text", new Set(["prompt", "objective", "constraint", "constraints", "instruction", "instructions"])],
  ["command_line", new Set(["command", "command_line", "cmd", "cmdline", "argv", "arg", "args", "arguments", "shell"])],
  ["file_content", new Set(["content", "contents", "diff", "patch", "file_content", "file_contents"])],
  ["process_output", new Set(["stdout", "stderr", "output", "text", "message", "log", "logs"])],
  ["environment", new Set(["env", "environment", "envvar", "envvars", "variables"])],
  [
    "credential",
    new Set([
      "token",
      "tokens",
      "secret",
      "secrets",
      "password",
      "passwd",
      "api_key",
      "apikey",
      "key",
      "credential",
      "credentials",
      "authorization",
      "cookie",
      "cookies",
      "url",
      "uri",
      "endpoint",
      "webhook",
      "sink",
    ]),
  ],
  ["home_path", new Set(["home", "homedir", "cwd", "abspath", "absolute_path"])],
  ["reasoning_text", new Set(["reasoning", "thinking", "thought", "thoughts", "transcript"])],
  ["message_body", new Set(["request", "response", "payload", "body", "params", "result"])],
];

const URL_PATTERN = /\b[a-z][a-z0-9+.-]{1,15}:\/\/\S/i;
const DIFF_PATTERN = /(^|\n)(diff --git |@@ -\d+(,\d+)? \+\d+|\+\+\+ [ab/]|--- [ab/])/;
const ENV_ASSIGNMENT_PATTERN = /\b(PATH|HOME|USER|SHELL|[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD))=\S/;
const HOME_PATH_PATTERN = /(^|[\s"'=:(,])(\/home\/[^/\s]+|\/Users\/[^/\s]+|\/root(\/|$)|[A-Za-z]:\\Users\\[^\\\s]+)/;
const FREE_TEXT_MAX_LENGTH = 256;

/**
 * Scans exported spans for the forbidden categories of LLD §7. Returns one finding per violated (span, key, category);
 * an empty array means every attribute key and value is clear. Values are never copied into findings.
 */
export function findForbiddenAttributes(
  spans: readonly CollectedSpan[],
  options: ForbiddenScanOptions = {},
): ForbiddenFinding[] {
  const findings: ForbiddenFinding[] = [];
  const home = homedir();
  const paths = [...(options.paths ?? []), home].filter((p) => p.length > 1);
  for (const span of spans) {
    for (const [key, raw] of Object.entries(span.attributes)) {
      const add = (category: ForbiddenCategory, reason: string) =>
        findings.push({ category, span: span.name, key, reason });
      // Keys: any dot-separated segment that names a forbidden category (allowlisted counts such as
      // `usage.input_tokens` or `events.count` have no such segment).
      const segments = key.toLowerCase().split(".");
      for (const [category, words] of FORBIDDEN_KEY_SEGMENTS) {
        if (segments.some((segment) => words.has(segment))) add(category, `key segment names ${category}`);
      }
      if (typeof raw !== "string") continue;
      const value = raw;
      // Values: planted canaries first (exact), then shape-based detectors.
      for (const canary of options.canaries ?? []) {
        if (canary.length > 0 && value.includes(canary)) add("canary", "planted canary present in value");
      }
      for (const path of paths) {
        if (value.includes(path)) add("home_path", "absolute host path present in value");
      }
      if (HOME_PATH_PATTERN.test(value)) add("home_path", "home-directory shaped path in value");
      if (URL_PATTERN.test(value)) add("credential", "URL in value (sink, webhook or endpoint)");
      for (const pattern of DEFAULT_SECRET_PATTERNS) {
        if (new RegExp(pattern.source, pattern.flags.replace("g", "")).test(value)) {
          add("credential", "credential-shaped value");
          break;
        }
      }
      for (const pattern of PREFIXED_PATTERNS) {
        if (new RegExp(pattern.source, pattern.flags.replace("g", "")).test(value)) {
          add("credential", "credential assignment in value");
          break;
        }
      }
      if (DIFF_PATTERN.test(value)) add("file_content", "unified diff markers in value");
      if (ENV_ASSIGNMENT_PATTERN.test(value)) add("environment", "environment assignment in value");
      if (value.includes("\n") || value.length > FREE_TEXT_MAX_LENGTH) {
        add("free_text", "multi-line or over-long value (prose, output or payload)");
      }
    }
  }
  return findings;
}

/** Parent-link check against the LLD §7 tree: returns a description of every violation, empty when consistent. */
export function parentLinkViolations(
  spans: readonly CollectedSpan[],
  parents: Readonly<Record<string, string | null>>,
): string[] {
  const byId = new Map(spans.map((span) => [span.spanId, span] as const));
  const violations: string[] = [];
  for (const span of spans) {
    const expected = Object.hasOwn(parents, span.name) ? parents[span.name] : undefined;
    if (expected === undefined) {
      violations.push(`${span.name}: not in the LLD §7 span table`);
      continue;
    }
    if (expected === null) {
      if (span.parentSpanId !== undefined) violations.push(`${span.name}: root span has a parent`);
      continue;
    }
    if (span.parentSpanId === undefined) {
      violations.push(`${span.name}: missing parent (expected ${expected})`);
      continue;
    }
    const parent = byId.get(span.parentSpanId);
    if (parent === undefined) violations.push(`${span.name}: parent span id not exported`);
    else if (parent.name !== expected) violations.push(`${span.name}: parent is ${parent.name}, expected ${expected}`);
    else if (parent.traceId !== span.traceId) violations.push(`${span.name}: parent in a different trace`);
  }
  return violations;
}
