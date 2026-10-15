/**
 * Which inner-agent tasks the production code actually reaches (T11.14; ROADMAP §6.6 T11.14 status, README "Inner
 * agent"). The documents claim: the commit-message task (T11.4) is wired through the `commit` tool and routing
 * classification (T11.11) through `serve`; the PR-draft (T11.8), verification-summary (T11.9), run-title (T11.12) and
 * handoff-condensation (T11.10) tasks are service functions with no production caller, and the `inner test` fixtures do
 * not call their modules either. Until now nothing failed when that changed. This file is a static pin of the claim: a
 * scan of every non-test module under `src/` outside `src/inner/` for the entry-point identifiers of each task. When a
 * later task wires one of the four onto a run path, this test must change in the same pull request as the README and
 * roadmap text (which is the point).
 *
 * Like `import-boundary.test.ts` the scan is textual and deliberately simple: word-bounded identifiers, static and
 * dynamic forms alike, no transitive analysis. Each guarded identifier is also checked to still exist as an export of
 * its module, so a rename cannot make the pin vacuous.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..");

/** Entry points and contracts of the four tasks the documents call "not on a production run path". */
const NOT_WIRED: Record<string, readonly string[]> = {
  "inner/pr-draft.ts": ["createPrDraft", "gatherPrDraftSource", "prDraftContract"],
  "inner/log-summary.ts": ["summariseVerification", "logSummaryContract", "parseTestReport"],
  "inner/run-title.ts": ["createRunTitle", "readRunTitle", "runTitleContract"],
  "inner/handoff-condense.ts": ["condenseHandoffBundle", "handoffCondenseContract"],
};

/** The two wired tasks and the single production module each is wired from. */
const WIRED: Record<string, { module: string; callers: readonly string[] }> = {
  createCommitMessageTask: { module: "inner/commit-message.ts", callers: ["git/channel.ts"] },
  createClassifyRouteFeaturesHook: { module: "inner/route-features.ts", callers: ["cli/serve.ts"] },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Relative posix path under `src/` to source text, production modules only (no tests). */
function productionTree(): Map<string, string> {
  const files = new Map<string, string>();
  for (const full of walk(SRC)) {
    const rel = path.relative(SRC, full).split(path.sep).join("/");
    if (rel.endsWith(".test.ts")) continue;
    files.set(rel, readFileSync(full, "utf8"));
  }
  return files;
}

const identifierRe = (name: string) => new RegExp(`(?<![\\w$])${name}(?![\\w$])`, "u");

/** Files outside `src/inner/` that reference `name`. Pure over a map so it can be checked on a synthetic tree. */
function referrers(files: ReadonlyMap<string, string>, name: string): string[] {
  const re = identifierRe(name);
  return [...files]
    .filter(([rel, text]) => !rel.startsWith("inner/") && re.test(text))
    .map(([rel]) => rel)
    .sort();
}

const exportsName = (source: string, name: string) =>
  new RegExp(`^export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${name}(?![\\w$])`, "mu").test(source);

describe("which inner tasks production code reaches (T11.14 claim pin)", () => {
  const files = productionTree();

  it("the scanner finds a planted reference in a synthetic tree (not vacuous)", () => {
    const synthetic = new Map<string, string>([
      ["inner/pr-draft.ts", "export async function createPrDraft() {}"],
      ["cli/other.ts", "const x = { createPrDraft };"],
      ["cli/dynamic.ts", 'const m = await import("../inner/index.js"); m.createPrDraft();'],
      ["cli/unrelated.ts", "const createPrDraftButNot = 1; // not a word-bounded reference"],
    ]);
    expect(referrers(synthetic, "createPrDraft")).toEqual(["cli/dynamic.ts", "cli/other.ts"]);
    expect(exportsName(synthetic.get("inner/pr-draft.ts") as string, "createPrDraft")).toBe(true);
  });

  it("PR-draft, verification-summary, run-title and handoff-condensation have no production caller outside src/inner/", () => {
    const found: string[] = [];
    for (const [module, names] of Object.entries(NOT_WIRED)) {
      const source = files.get(module);
      expect(source, `${module} exists`).toBeDefined();
      for (const name of names) {
        expect(exportsName(source as string, name), `${module} still exports ${name}`).toBe(true);
        for (const rel of referrers(files, name)) found.push(`${rel} -> ${name}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("the commit-message task is reached only from the commit tool channel and routing classification only from serve", () => {
    for (const [name, { module, callers }] of Object.entries(WIRED)) {
      expect(exportsName(files.get(module) ?? "", name), `${module} still exports ${name}`).toBe(true);
      expect(referrers(files, name), name).toEqual([...callers].sort());
    }
  });

  it("the `inner test` fixtures build their prompts without the four task modules", () => {
    const fixture = files.get("inner/fixture.ts") as string;
    const imported = [...fixture.matchAll(/from\s+"\.\/([a-z-]+)\.js"/gu)].map((m) => m[1] as string).sort();
    expect(imported).not.toContain("pr-draft");
    expect(imported).not.toContain("log-summary");
    expect(imported).not.toContain("run-title");
    expect(imported).not.toContain("handoff-condense");
    expect(imported).toContain("commit-message"); // the one task whose real prompt the fixture reuses
  });
});
