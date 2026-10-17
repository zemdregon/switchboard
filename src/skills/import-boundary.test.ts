/**
 * Import boundary (T16.4; FR-SKL-04, BR-54, LLD §19.5, ADR-0056): skills are resolved once per run at admission and
 * are never read by eligibility, scoring, affinity, the profile compiler, approval or any other policy component.
 * Structurally: no module under `src/policy/`, `src/routing/` or `src/capacity/` may import `src/skills/`, directly or
 * through any chain of imports. Modelled on `src/retrieval/import-boundary.test.ts`.
 *
 * The walk follows every static `import`/`export ... from` and dynamic `import()` of a relative specifier (type-only
 * imports included, which is stricter than the emitted JavaScript). Two positive controls prove the walk can fail: a
 * planted import in an in-memory module graph is found, and the MCP and queue admission modules, which do import
 * skills, are reached. The lifecycle is checked too: `src/capacity/` reaches it, so it uses a structurally typed port.
 *
 * One leaf is exempt: `src/skills/limits.ts` (T16.3), the numeric ranges of the `skills.*` configuration keys, which
 * `src/config/schema.ts` and `src/config/load.ts` import and through them most of the tree. It imports nothing and
 * exports only numbers and a type, so it carries no skill name, text or resolution; a test below keeps it that way.
 * Delegated (T16.4, 2026-10-17, not owner-approved): moving it under `src/config/` would be the cleaner fix, but that
 * directory is outside T16.4's files.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..");
const SKILLS = path.join(SRC, "skills") + path.sep;
/** The constants-only leaf the configuration loader imports (see the module comment). */
const EXEMPT = new Set([path.join(SRC, "skills", "limits.ts")]);

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

/** The import chain from `entry` to the first skills module, or undefined when none is reachable. */
function chainToSkills(
  entry: string,
  read: (f: string) => string = (f) => readFileSync(f, "utf8"),
  exists: (f: string) => boolean = existsSync,
  skillsDir = SKILLS,
  exempt: ReadonlySet<string> = EXEMPT,
): string[] | undefined {
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length > 0) {
    const f = queue.shift() as string;
    if (exempt.has(f)) continue;
    if (f.startsWith(skillsDir)) {
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

/** LLD §19.5's policy components, by directory. */
const POLICY_DIRS: Record<string, string[]> = {
  "src/policy (profile choice, compilation, approval checks)": sources("policy"),
  "src/routing (eligibility, scoring, affinity)": sources("routing"),
  "src/capacity (capacity, breaker, pacing)": sources("capacity"),
  // Reachable from src/capacity (through src/control), so it takes skills only through its `SkillAdmissionPort`.
  "the lifecycle (admission, ceilings, the policy snapshot and dispatch)": [path.join(SRC, "lifecycle/lifecycle.ts")],
};

describe("skills import boundary (FR-SKL-04, LLD §19.5)", () => {
  for (const [what, files] of Object.entries(POLICY_DIRS)) {
    it(`no module under ${what} can reach src/skills`, () => {
      expect(files.length).toBeGreaterThan(0);
      const reached: Record<string, string[]> = {};
      for (const f of files) {
        const chain = chainToSkills(f);
        if (chain !== undefined) reached[path.relative(SRC, f)] = chain;
      }
      expect(reached).toEqual({});
    });
  }

  it("positive control: a planted import, even two hops away and type-only, is found", () => {
    const root = path.join(path.sep, "virtual", "src");
    const files: Record<string, string> = {
      [path.join(root, "routing/a.ts")]: 'import { b } from "./b.js";\n',
      [path.join(root, "routing/b.ts")]: 'export type { X } from "../util/c.js";\n',
      [path.join(root, "util/c.ts")]: 'import type { RunSkillSet } from "../skills/admission.js";\n',
      [path.join(root, "skills/admission.ts")]: "export {};\n",
    };
    const chain = chainToSkills(
      path.join(root, "routing/a.ts"),
      (f) => files[f] ?? "",
      (f) => f in files,
      path.join(root, "skills") + path.sep,
    );
    expect(chain?.map((c) => path.basename(c))).toEqual(["a.ts", "b.ts", "c.ts", "admission.ts"]);
  });

  it("the exempt leaf src/skills/limits.ts imports nothing and exports only constants and a type", () => {
    const text = readFileSync(path.join(SRC, "skills", "limits.ts"), "utf8");
    expect(text).not.toMatch(/\bimport\b|\brequire\(/u);
    for (const m of text.matchAll(/^export\s+(\w+)\s+(\w+)/gmu)) {
      expect(["const", "interface"], `${m[2]}`).toContain(m[1]);
    }
  });

  it("positive control: the exemption is one file; any other skills module is still found", () => {
    const root = path.join(path.sep, "virtual", "src");
    const files: Record<string, string> = {
      [path.join(root, "capacity/a.ts")]: 'import { L } from "../skills/limits.js";\nimport "../skills/resolve.js";\n',
      [path.join(root, "skills/limits.ts")]: "export const L = 1;\n",
      [path.join(root, "skills/resolve.ts")]: "export {};\n",
    };
    const chain = chainToSkills(
      path.join(root, "capacity/a.ts"),
      (f) => files[f] ?? "",
      (f) => f in files,
      path.join(root, "skills") + path.sep,
      new Set([path.join(root, "skills/limits.ts")]),
    );
    expect(chain?.map((c) => path.basename(c))).toEqual(["a.ts", "resolve.ts"]);
  });

  it("positive control: admission does reach skills, so the walk resolves real imports", () => {
    expect(chainToSkills(path.join(SRC, "cli/serve.ts"))).toBeDefined();
    expect(chainToSkills(path.join(SRC, "mcp/server.ts"))).toBeDefined();
    expect(chainToSkills(path.join(SRC, "queue/admission.ts"))).toBeDefined();
  });
});
