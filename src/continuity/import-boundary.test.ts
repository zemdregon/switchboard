/**
 * Import boundary of the handoff bundle builder (T5.4 "Done when"; FR-SES-04, ADR-0001, ADR-0038 item 1.2, LLD §15.1
 * last paragraph). The builder must not be able to parse provider output or read stream artifacts, structurally:
 * - the runtime import closure of the builder modules (`bundle*.ts`, `handoff-view.ts`), followed through every
 *   relative non-type import, reaches no adapter module (the provider parsers live in `src/adapters/`), no
 *   `src/exec/` module (the JSONL and ACP stream readers), no MCP module and no lifecycle module other than the pure
 *   `request.ts` (canonical JSON);
 * - no module in that closure imports `fs` (the builder opens no file: artifact content comes through an injected
 *   reader that `bundle-sources.ts` restricts to `changed_files` and `test_report`, and Git through the hardened
 *   runner);
 * - the builder modules never name the stream artifact kinds, so no code path can select them.
 * The runtime half (a canary in the stream and diff artifacts never reaches a bundle, and only `changed_files` and
 * `test_report` content is read) is in `bundle.test.ts` and `bundle-lifecycle.test.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..");
const BUILDER = [
  "continuity/bundle.ts",
  "continuity/bundle-schema.ts",
  "continuity/bundle-sources.ts",
  "continuity/handoff-view.ts",
];

/** Runtime import specifiers (static `import ... from`, re-exports, dynamic `import()`); `import type` is skipped. */
function runtimeImports(source: string): string[] {
  const out: string[] = [];
  const re =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of source.matchAll(re)) {
    if (m[4] !== undefined) out.push(m[4]);
    else if (m[2] === undefined) out.push(m[3] as string);
  }
  return out;
}

function closure(entries: readonly string[]): { modules: Set<string>; external: Map<string, string[]> } {
  const modules = new Set<string>();
  const external = new Map<string, string[]>();
  const queue = [...entries];
  while (queue.length > 0) {
    const rel = queue.shift() as string;
    if (modules.has(rel)) continue;
    modules.add(rel);
    const text = readFileSync(path.join(SRC, rel), "utf8");
    for (const spec of runtimeImports(text)) {
      if (!spec.startsWith(".")) {
        external.set(rel, [...(external.get(rel) ?? []), spec]);
        continue;
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)).replace(/\.js$/u, ".ts");
      queue.push(target);
    }
  }
  return { modules, external };
}

describe("handoff bundle builder import boundary (T5.4)", () => {
  const { modules, external } = closure(BUILDER);

  it("the closure is what the design allows, and nothing else", () => {
    expect([...modules].sort()).toEqual(
      [...BUILDER, "continuity/open-work.ts", "lifecycle/request.ts", "workspace/git.ts"].sort(),
    );
  });

  it("reaches no adapter parser, stream reader, MCP or lifecycle engine module", () => {
    const forbidden = [...modules].filter(
      (m) =>
        m.startsWith("adapters/") ||
        m.startsWith("exec/") ||
        m.startsWith("mcp/") ||
        (m.startsWith("lifecycle/") && m !== "lifecycle/request.ts"),
    );
    expect(forbidden).toEqual([]);
  });

  it("no module of the closure imports fs; only crypto and child_process (the Git runner) are used", () => {
    const all = [...external.values()].flat();
    expect(all.filter((s) => /(^|:)fs(\/promises)?$/.test(s))).toEqual([]);
    expect([...new Set(all)].sort()).toEqual(["node:child_process", "node:crypto"]);
  });

  it("the builder modules never name a stream artifact kind", () => {
    for (const rel of BUILDER) {
      const text = readFileSync(path.join(SRC, rel), "utf8");
      expect(text).not.toMatch(/provider_stdout|provider_stderr/);
    }
  });

  it("the import scanner sees type-only imports as type-only (self-test)", () => {
    expect(
      runtimeImports('import type { A } from "./a.js";\nimport { b } from "./b.js";\nexport * from "./c.js";'),
    ).toEqual(["./b.js", "./c.js"]);
    expect(runtimeImports('const m = await import("../adapters/claude/parser.js");')).toEqual([
      "../adapters/claude/parser.js",
    ]);
  });
});

describe("handoff prompt renderer import boundary (T5.5)", () => {
  const { modules, external } = closure(["continuity/render.ts"]);

  it("is pure: the schema, the redactor and canonical JSON only, no file or process access", () => {
    expect([...modules].sort()).toEqual(
      ["continuity/bundle-schema.ts", "continuity/render.ts", "artifacts/redact.ts", "lifecycle/request.ts"].sort(),
    );
    expect([...new Set([...external.values()].flat())].sort()).toEqual(["node:crypto"]);
  });

  it("never names a stream artifact kind", () => {
    expect(readFileSync(path.join(SRC, "continuity/render.ts"), "utf8")).not.toMatch(/provider_stdout|provider_stderr/);
  });
});
