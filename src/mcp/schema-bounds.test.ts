/**
 * MCP input-schema bounds (Queue7 Y8; FR-MCP-03 schema validation, FR-MCP-09, NFR-SEC-05). The HTTP transport caps
 * request bodies (`MAX_MCP_BODY_BYTES`), but stdio has no request-size cap, so on stdio an unbounded input string
 * or array is limited only by memory. This file enforces the fix two ways: a schema walk that fails on any
 * unbounded string, array or object in any published input schema, and behaviour tests showing an over-long value
 * is refused with the normal INVALID_REQUEST envelope (not a crash) over a stdio-style in-memory transport.
 *
 * Project-tool inputs (`create/update/delete_project`) live in `./schemas.ts` (`PROJECT_INPUTS`, validated by
 * `./project-tools.ts` via `inputSchema`), so they are walked here like every other tool: there is no known gap.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../routing/fixtures/harness.js";
import {
  inputSchema,
  PROJECT_TOOL_NAMES,
  patternMaxLength,
  SEARCH_TOOL_NAMES,
  SKILL_TOOL_NAMES,
  TOOL_NAMES,
  WORK_QUEUE_TOOL_NAMES,
} from "./schemas.js";

/**
 * True when `pattern` pins both ends (`^...$`) and every repetition in it is bounded, so only finitely many
 * lengths match. Character classes and escapes are opaque single characters here: the `+` in `[@+-]` and the
 * `{0,127}`-style bounded counts do not unbound a pattern; `*`, bare `+` and `{n,}` do.
 */
function isLengthBoundingPattern(pattern: unknown): boolean {
  if (typeof pattern !== "string" || !pattern.startsWith("^") || !pattern.endsWith("$")) return false;
  const src = pattern
    .slice(1, -1)
    .replace(/\\./g, "")
    .replace(/\[[^\]]*\]/g, "C");
  return !/[*+]/.test(src) && !/\{[0-9]*,\}/.test(src);
}

interface Violation {
  tool: string;
  pointer: string;
  what: string;
}

/** Collect every unbounded string, array or object under `node`; boolean subschemas are not schemas to bound. */
function collectViolations(tool: string, node: unknown, pointer: string, out: Violation[]): void {
  if (typeof node === "boolean" || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) collectViolations(tool, v, `${pointer}/${i}`, out);
    return;
  }
  const record = node as Record<string, unknown>;
  const rawType = record.type;
  const types = Array.isArray(rawType) ? rawType : rawType === undefined ? [] : [rawType];
  if (types.includes("string")) {
    if (
      record.maxLength === undefined &&
      record.enum === undefined &&
      record.const === undefined &&
      !isLengthBoundingPattern(record.pattern)
    ) {
      out.push({ tool, pointer, what: "string without maxLength/enum/const/length-bounding pattern" });
    }
  }
  if (types.includes("array") && record.maxItems === undefined) {
    out.push({ tool, pointer, what: "array without maxItems" });
  }
  const properties = record.properties as Record<string, unknown> | undefined;
  const propValues = properties !== undefined ? Object.values(properties) : [];
  const isPresenceGuard = propValues.length > 0 && propValues.every((v) => typeof v === "boolean");
  if (
    (types.includes("object") || (rawType === undefined && properties !== undefined)) &&
    record.additionalProperties !== false &&
    record.maxProperties === undefined &&
    !isPresenceGuard
  ) {
    // Presence guards (`delegate_task` oneOf branches, `list_runs` not) only name required fields with boolean
    // subschemas; the closed root schema already rejects anything they do not name, so they need no bound.
    out.push({ tool, pointer, what: "object without additionalProperties:false or maxProperties" });
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "enum" || key === "const") continue;
    collectViolations(tool, value, `${pointer}/${key}`, out);
  }
}

describe("MCP input-schema bounds (FR-MCP-09, NFR-SEC-05)", () => {
  it("every published input schema bounds every string, array and object", () => {
    const names = [
      ...TOOL_NAMES,
      ...PROJECT_TOOL_NAMES,
      ...SEARCH_TOOL_NAMES,
      ...WORK_QUEUE_TOOL_NAMES,
      ...SKILL_TOOL_NAMES,
    ];
    expect(names.length).toBeGreaterThan(0);
    const violations: Violation[] = [];
    for (const name of names) collectViolations(name, inputSchema(name), "#", violations);
    expect(
      violations.map((v) => `${v.tool} ${v.pointer}: ${v.what}`),
      "unbounded input schema nodes (tool JSON-pointer: reason)",
    ).toEqual([]);
  });

  it("patternMaxLength never under-approximates the patterns it is used for", () => {
    expect(patternMaxLength("^[a-z][a-z0-9-]{1,40}$")).toBe(41);
    expect(patternMaxLength("^run_[0-9A-HJKMNP-TV-Z]{26}$")).toBe(30);
    expect(patternMaxLength("^sha256:[0-9a-f]{64}$")).toBe(71);
    expect(patternMaxLength("^[a-z][a-z0-9-]{1,47}(@[1-9][0-9]{0,5})?$")).toBe(55);
    expect(patternMaxLength("^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$")).toBe(128);
    // Anything open-ended or unanchored yields no bound rather than a wrong one.
    expect(patternMaxLength("^[a-z]+$")).toBeUndefined();
    expect(patternMaxLength("^[a-z]{1,}$")).toBeUndefined();
    expect(patternMaxLength("[a-z]{3}")).toBeUndefined();
    expect(patternMaxLength("a*")).toBeUndefined();
  });
});

describe("over-long input values are INVALID_REQUEST over stdio (FR-MCP-09)", () => {
  let root: string;
  let h: Harness;
  beforeEach(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-schema-bounds-")));
    h = await startHarness({ allowedRoots: [root] });
  });
  afterEach(async () => {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  });

  // A 68-character run id: far past maxLength 30, so the bound refuses it before any lookup or side effect.
  const tooLongId = `run_${"A".repeat(64)}`;
  it.each([
    ["get_run", { run_id: tooLongId }],
    ["cancel_run", { run_id: tooLongId }],
    ["explain_route", { run_id: tooLongId }],
  ])("%s refuses an over-long id with the validation error envelope", async (tool, args) => {
    const before = (h.db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n;
    const r = await h.call(tool, args);
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatchObject({ code: "INVALID_REQUEST", retryable: false });
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n).toBe(before);
  });

  it("delegate_task refuses an over-long idempotency_key (maxLength-only bound, no pattern)", async () => {
    const r = await h.call("delegate_task", {
      objective: "add a feature",
      workspace_path: path.join(root, "repo"),
      trust_profile: "edit-untrusted",
      idempotency_key: `k-${"k".repeat(200)}`,
    });
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatchObject({ code: "INVALID_REQUEST", retryable: false });
  });
});
