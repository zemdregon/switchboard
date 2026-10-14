/**
 * Import boundary (T12.5; FR-RAG-07, BR-46, LLD §14, TDD §3.13): retrieved content is untrusted data and never an input
 * to a security or policy decision. Structurally: no module that chooses or compiles a profile, writes the policy
 * snapshot, decides eligibility, approvals or ceilings, or pushes or commits may import the retrieval service, directly
 * or through any chain of imports. The lifecycle reaches retrieval only through its structurally typed `contextPack`
 * port, wired in `serve`.
 *
 * The walk follows every static `import`/`export ... from` and dynamic `import()` of a relative specifier (type-only
 * imports included, which is stricter than the emitted JavaScript). Two positive controls prove the walk can fail: a
 * planted import in an in-memory module graph is found, and the `serve` wiring, which does import retrieval, is reached.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..");
const RETRIEVAL = path.join(SRC, "retrieval") + path.sep;

const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/** Relative specifiers of a module, resolved to `.ts` files that exist. */
function importsOf(file: string, read: (f: string) => string, exists: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const m of read(file).matchAll(SPEC_RE)) {
    const spec = m[1] as string;
    if (!spec.startsWith(".")) continue;
    const abs = path.resolve(path.dirname(file), spec);
    const candidates = [abs.replace(/\.js$/, ".ts"), `${abs}.ts`, path.join(abs, "index.ts")];
    const hit = candidates.find(exists);
    if (hit !== undefined) out.push(hit);
  }
  return out;
}

/** The import chain from `entry` to the first retrieval module, or undefined when none is reachable. */
function chainToRetrieval(
  entry: string,
  read: (f: string) => string = (f) => readFileSync(f, "utf8"),
  exists: (f: string) => boolean = existsSync,
  retrievalDir = RETRIEVAL,
): string[] | undefined {
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length > 0) {
    const f = queue.shift() as string;
    if (f.startsWith(retrievalDir)) {
      const chain: string[] = [];
      for (let c: string | null = f; c !== null; c = parent.get(c) ?? null) chain.unshift(path.relative(SRC, c));
      return chain;
    }
    for (const next of importsOf(f, read, exists)) {
      if (!parent.has(next)) {
        parent.set(next, f);
        queue.push(next);
      }
    }
  }
  return undefined;
}

const sources = (dir: string) =>
  readdirSync(path.join(SRC, dir), { recursive: true, encoding: "utf8" })
    .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !n.includes("fixtures"))
    .map((n) => path.join(SRC, dir, n));

/** FR-RAG-07's decision points, by module. */
const DECISION_MODULES: Record<string, string[]> = {
  "profile choice, compilation and policy (COMP-POL)": sources("policy"),
  "profile compilation by the adapters": sources("adapters"),
  eligibility: ["routing/eligibility.ts", "routing/collect.ts"].map((f) => path.join(SRC, f)),
  "approvals and the privileged check": [path.join(SRC, "lifecycle/approval.ts")],
  "admission, ceilings, the policy snapshot and dispatch": [path.join(SRC, "lifecycle/lifecycle.ts")],
  "commit and push (COMP-GIT)": [
    "git/commit.ts",
    "git/push.ts",
    "git/finalize.ts",
    "git/channel.ts",
    "git/sign.ts",
  ].map((f) => path.join(SRC, f)),
  "configuration and profile resolution": [path.join(SRC, "config/index.ts")],
};

describe("retrieval import boundary (FR-RAG-07)", () => {
  for (const [what, files] of Object.entries(DECISION_MODULES)) {
    it(`no ${what} module can reach src/retrieval`, () => {
      expect(files.length).toBeGreaterThan(0);
      const reached: Record<string, string[]> = {};
      for (const f of files) {
        expect(existsSync(f), `${path.relative(SRC, f)} exists`).toBe(true);
        const chain = chainToRetrieval(f);
        if (chain !== undefined) reached[path.relative(SRC, f)] = chain;
      }
      expect(reached).toEqual({});
    });
  }

  it("positive control: a planted import, even two hops away and type-only, is found", () => {
    const root = path.join(path.sep, "virtual", "src");
    const files: Record<string, string> = {
      [path.join(root, "policy/a.ts")]: 'import { b } from "./b.js";\n',
      [path.join(root, "policy/b.ts")]: 'export type { X } from "../util/c.js";\n',
      [path.join(root, "util/c.ts")]: 'import type { ContextPackResult } from "../retrieval/admission.js";\n',
      [path.join(root, "retrieval/admission.ts")]: "export {};\n",
    };
    const chain = chainToRetrieval(
      path.join(root, "policy/a.ts"),
      (f) => files[f] ?? "",
      (f) => f in files,
      path.join(root, "retrieval") + path.sep,
    );
    expect(chain?.map((c) => path.basename(c))).toEqual(["a.ts", "b.ts", "c.ts", "admission.ts"]);
  });

  it("positive control: the serve wiring does reach retrieval, so the walk resolves real imports", () => {
    expect(chainToRetrieval(path.join(SRC, "cli/rag-index.ts"))).toBeDefined();
    expect(chainToRetrieval(path.join(SRC, "cli/serve.ts"))).toBeDefined();
  });
});
