/**
 * Import-boundary test (T11.1; FR-INN-06, TDD §3.12, SDD "structural authority boundary"). No inner-agent output may reach
 * a security or policy decision, and the enforcement is structural: the modules that make those decisions must not import
 * the inner-agent service (`src/inner/`) or its types, so it cannot be injected into them. The check is on DIRECT imports
 * (static, type-only, re-export and dynamic forms) of each protected module, plus a TRANSITIVE re-export walk: from each
 * protected module, every `export … from` / `export *` chain is followed, and a chain that reaches `src/inner/` fails.
 * Only re-exports are followed transitively, not ordinary imports: a protected module such as `lifecycle.ts` reaches most
 * of the tree through imports (for example `git/channel.ts`, where the commit-message task of T11.4 legitimately calls
 * the service), and reaching a caller is not being handed the service. A protected module that re-exports a helper which
 * itself re-exports `src/inner/` is now caught (the re-export gap is closed); what remains untested by design is a
 * runtime-only handoff with no static `export … from` edge, which no reviewed change may add without touching imports.
 *
 * Protected modules (Delegated reading of FR-INN-06 "COMP-POL, the adapters' profile compilers, the retry logic or the
 * push path", plus the other items it lists):
 * - COMP-POL: all of `src/policy/`;
 * - every adapter, which includes each profile compiler and the failure classification (`src/adapters/`);
 * - the retry and failure-classification logic: `src/lifecycle/lifecycle.ts` (holds the BR-7 retry set), `states.ts`,
 *   `src/mcp/errors.ts` (the retryable set);
 * - approvals and eligibility: `src/lifecycle/approval.ts`, `src/routing/eligibility.ts`;
 * - the stage-2 scorer (M7, T7.1): `src/routing/score.ts` never reads features, so inner features (FR-INN-12) can be
 *   recorded but cannot rank (Q-82);
 * - verification results: `src/lifecycle/verification.ts`;
 * - the push path and the sanitiser rule table: `src/git/push*.ts`, `publish-ref.ts`, `ref-guard.ts`,
 *   `credential-reach.ts`, `sanitize.ts`, `safe-pattern.ts`;
 * - the commit algorithm (T11.4, Delegated): `src/git/commit.ts` applies the sanitiser to every message and receives the
 *   commit-message task only as an injected function from `git/channel.ts`, so it never imports the service itself;
 * - redaction: `src/artifacts/redact.ts`;
 * - usage accounting (T11.5): `src/usage/`, `src/ledger/` and `src/mcp/envelope.ts`; the capacity estimator (M6, T6.2)
 *   lives under `src/capacity/` and is protected whole.
 * `lifecycle.ts` is protected whole because the retry decision lives inside it. T11.11 wires the inner agent near
 * dispatch by injecting `classifyRouteFeatures` from `serve.ts` (and tests), so this module never imports `src/inner/`.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..");

const PROTECTED: readonly RegExp[] = [
  /^policy\//,
  /^adapters\//,
  /^lifecycle\/(lifecycle|states|approval|verification)\.ts$/,
  /^mcp\/errors\.ts$/,
  /^routing\/(eligibility|score)\.ts$/,
  /^git\/(push[^/]*|publish-ref|ref-guard|credential-reach|sanitize|safe-pattern|commit)\.ts$/,
  /^artifacts\/redact\.ts$/,
  // T11.5 (FR-INN-15): usage and capacity code, the ledger and the envelope that reads usage never see the service.
  /^usage\//,
  /^ledger\//,
  /^mcp\/envelope\.ts$/,
  // T6.2 (FR-INN-15, BR-41): the capacity estimator and its projection never see the service.
  /^capacity\//,
];
const isInner = (rel: string) => rel.startsWith("inner/");
const isProtected = (rel: string) => PROTECTED.some((re) => re.test(rel));

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)(["'])(\.{1,2}\/[^"']*)\1/g;
/** Re-export specifiers only (`export … from`, `export * from`): the edges the transitive walk follows. */
const REEXPORT_RE = /\bexport\s[^;]*?\bfrom\s*(["'])(\.{1,2}\/[^"']*)\1/g;

/** Relative import specifiers of one source text (static, type-only, re-export and dynamic forms). */
function relativeImports(source: string): string[] {
  return [...source.matchAll(IMPORT_RE)].map((m) => m[2] as string);
}

/** Relative re-export specifiers of one source text (`export … from` / `export * from` forms only). */
function relativeReexports(source: string): string[] {
  return [...source.matchAll(REEXPORT_RE)].map((m) => m[2] as string);
}

function resolveSpecifier(fromRel: string, spec: string, known: ReadonlySet<string>): string | undefined {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  const base = joined.replace(/\.js$/u, "");
  for (const cand of [`${base}.ts`, `${base}/index.ts`, joined]) if (known.has(cand)) return cand;
  return undefined;
}

/**
 * Each protected module's direct import of `src/inner/`, as `from -> to`. Pure over a map of relative path (posix, under
 * `src/`) to source text, so it can be tested with a synthetic tree.
 */
function findBoundaryViolations(files: ReadonlyMap<string, string>): string[] {
  const known = new Set(files.keys());
  const edges = new Map<string, string[]>();
  for (const [rel, text] of files) {
    const out: string[] = [];
    for (const spec of relativeImports(text)) {
      const target = resolveSpecifier(rel, spec, known);
      if (target !== undefined) out.push(target);
    }
    edges.set(rel, out);
  }
  const violations: string[] = [];
  for (const [from, targets] of edges) {
    if (!isProtected(from) || isInner(from)) continue;
    for (const to of targets) if (isInner(to)) violations.push(`${from} -> ${to}`);
  }
  return violations;
}

/**
 * Each protected module's transitive re-export chain into `src/inner/`, as `from -(re-export)-> … -> to`. Only
 * `export … from` edges are followed (ordinary imports are legitimately transitive, see the header): a protected
 * module that re-exports a helper which itself re-exports the service hands the service to its own importers.
 * Pure over a map of relative path (posix, under `src/`) to source text, so it can be tested with a synthetic tree.
 */
function findReexportViolations(files: ReadonlyMap<string, string>): string[] {
  const known = new Set(files.keys());
  const edges = new Map<string, string[]>();
  for (const [rel, text] of files) {
    const out: string[] = [];
    for (const spec of relativeReexports(text)) {
      const target = resolveSpecifier(rel, spec, known);
      if (target !== undefined) out.push(target);
    }
    edges.set(rel, out);
  }
  const violations: string[] = [];
  for (const root of known) {
    if (!isProtected(root) || isInner(root)) continue;
    // BFS over re-export edges only; the first chain that reaches the service is reported.
    const parent = new Map<string, string | null>([[root, null]]);
    const queue = [root];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (isInner(current) && current !== root) {
        const chain: string[] = [];
        for (let c: string | null = current; c !== null; c = parent.get(c) ?? null) chain.unshift(c);
        violations.push(`${root} -(re-export)-> ${chain.slice(1).join(" -> ")}`);
        break;
      }
      for (const next of edges.get(current) ?? []) {
        if (!parent.has(next)) {
          parent.set(next, current);
          queue.push(next);
        }
      }
    }
  }
  return violations;
}

function listSources(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== "fixtures" && e.name !== "node_modules") out.push(...listSources(dir, r));
    } else if (/\.(ts|mts)$/u.test(e.name) && !/\.test\.ts$/u.test(e.name) && !e.name.endsWith(".d.ts")) out.push(r);
  }
  return out;
}

describe("inner-agent import boundary (FR-INN-06)", () => {
  it("no protected module imports src/inner/, directly or through a re-export chain", () => {
    const files = new Map(listSources(SRC).map((r) => [r, readFileSync(path.join(SRC, r), "utf8")]));
    expect([...files.keys()].some(isInner)).toBe(true); // the tree under test really contains the service
    expect([...files.keys()].some((r) => r.startsWith("policy/"))).toBe(true);
    expect(findBoundaryViolations(files)).toEqual([]);
    expect(findReexportViolations(files)).toEqual([]);
  });

  it("detects a direct, a type-only, a re-export and a dynamic import, and ignores unprotected importers", () => {
    const tree = (protectedSrc: string, mid = "export const x = 1;") =>
      new Map([
        ["inner/index.ts", "export const s = 1;"],
        ["policy/profiles.ts", protectedSrc],
        ["util/mid.ts", mid],
      ]);
    expect(findBoundaryViolations(tree("export const p = 1;"))).toEqual([]);
    expect(findBoundaryViolations(tree('import { s } from "../inner/index.js";'))).toEqual([
      "policy/profiles.ts -> inner/index.ts",
    ]);
    expect(findBoundaryViolations(tree('import type { S } from "../inner/index.js";'))).toHaveLength(1);
    expect(findBoundaryViolations(tree('export * from "../inner/index.js";'))).toHaveLength(1);
    expect(findBoundaryViolations(tree('const m = await import("../inner/index.js");'))).toHaveLength(1);
    // an unprotected module (a future caller) may import the service; a protected one may not
    expect(findBoundaryViolations(tree("export const p = 1;", 'import { s } from "../inner/index.js";'))).toEqual([]);
    expect(
      findBoundaryViolations(
        new Map([
          ["inner/index.ts", ""],
          ["inner/port.ts", ""],
          ["git/push.ts", 'import { s } from "../inner/index.js";'],
          ["adapters/claude/adapter.ts", 'import type { T } from "../../inner/port.js";'],
        ]),
      ),
    ).toEqual(["git/push.ts -> inner/index.ts", "adapters/claude/adapter.ts -> inner/port.ts"]);
  });

  it("a re-export chain from a protected module to src/inner/ is caught, on a temp fixture tree", () => {
    // Protected-module stand-in -> re-exporting helper -> the service (the retrieval boundary's full-walk control
    // in src/retrieval/import-boundary.test.ts does the same shape for ordinary imports).
    const dir = mkdtempSync(path.join(tmpdir(), "sb-inner-reexport-"));
    try {
      const write = (rel: string, text: string) => {
        const abs = path.join(dir, rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, text);
      };
      write("policy/profiles.ts", 'export * from "../util/mid.js";\n');
      write("util/mid.ts", 'export type { S } from "../inner/index.js";\n');
      write("inner/index.ts", "export const s = 1;\n");
      const files = new Map(
        ["policy/profiles.ts", "util/mid.ts", "inner/index.ts"].map(
          (r) => [r, readFileSync(path.join(dir, r), "utf8")] as [string, string],
        ),
      );
      expect(findReexportViolations(files)).toEqual([
        "policy/profiles.ts -(re-export)-> util/mid.ts -> inner/index.ts",
      ]);
      // Ordinary imports stay legitimately transitive: the same shape through `import` is not a re-export.
      const imported = new Map(files);
      imported.set("policy/profiles.ts", 'import { m } from "../util/mid.js";\nexport const p = m;\n');
      imported.set("util/mid.ts", 'import { s } from "../inner/index.js";\nexport const m = s;\n');
      expect(findReexportViolations(imported)).toEqual([]);
      expect(findBoundaryViolations(imported)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the protected list matches the modules it names", () => {
    const files = new Set(listSources(SRC));
    for (const must of [
      "lifecycle/lifecycle.ts",
      "lifecycle/approval.ts",
      "mcp/errors.ts",
      "routing/eligibility.ts",
      "git/push.ts",
      "git/sanitize.ts",
      "git/commit.ts",
      "adapters/failure.ts",
      "artifacts/redact.ts",
      "usage/observations.ts",
      "ledger/repo.ts",
      "mcp/envelope.ts",
      "capacity/estimate.ts",
    ]) {
      expect(files.has(must), must).toBe(true);
      expect(isProtected(must), must).toBe(true);
    }
  });
});
