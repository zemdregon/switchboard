/**
 * Import-boundary test (T11.1; FR-INN-06, TDD §3.12, SDD "structural authority boundary"). No inner-agent output may reach
 * a security or policy decision, and the enforcement is structural: the modules that make those decisions must not import
 * the inner-agent service (`src/inner/`) or its types, so it cannot be injected into them. The check is on DIRECT imports
 * (static, type-only, re-export and dynamic forms) of each protected module. It is deliberately not transitive: a
 * protected module such as `lifecycle.ts` reaches most of the tree (for example `git/channel.ts`, where the commit-message
 * task of T11.4 legitimately calls the service), and reaching a caller is not being handed the service. Known gap
 * (Assumption): a protected module that imports a helper which itself re-exports `src/inner/` would not be caught; no
 * such helper exists, and the helper's own import would have to be added in a reviewed change.
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
 * `lifecycle.ts` is protected whole because the retry decision lives inside it. A later task that must wire the inner
 * agent near dispatch (T11.11) has to split that logic out first, not relax this list silently.
 */
import { readdirSync, readFileSync } from "node:fs";
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

/** Relative import specifiers of one source text (static, type-only, re-export and dynamic forms). */
function relativeImports(source: string): string[] {
  return [...source.matchAll(IMPORT_RE)].map((m) => m[2] as string);
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
  it("no protected module imports src/inner/", () => {
    const files = new Map(listSources(SRC).map((r) => [r, readFileSync(path.join(SRC, r), "utf8")]));
    expect([...files.keys()].some(isInner)).toBe(true); // the tree under test really contains the service
    expect([...files.keys()].some((r) => r.startsWith("policy/"))).toBe(true);
    expect(findBoundaryViolations(files)).toEqual([]);
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
