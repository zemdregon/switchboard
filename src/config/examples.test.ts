/**
 * Y9: every file in `examples/` is a config `loadConfig` accepts.
 *
 * Each `examples/*.json` file is strict JSON (a comment key would stop startup as an unknown key, so the
 * documentation lives in `examples/README.md`). The glob below picks up a new example automatically: its text must
 * contain no provider bypass-class flag (the registry's declared list, ADR-0035) and nothing matching the repo's
 * secret patterns, and it must load with placeholder paths rewritten into a temp dir.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bypassClassFlags } from "../adapters/audit.js";
import { DEFAULT_SECRET_PATTERNS, PREFIXED_PATTERNS } from "../artifacts/redact.js";
import { loadConfig } from "./load.js";

const EXAMPLES_DIR = path.join(import.meta.dirname, "..", "..", "examples");
const REPO_README = path.join(import.meta.dirname, "..", "..", "docs", "guide", "getting-started.md");
/** Placeholder prefix used by every example path; rewritten into a temp dir before loading. */
const PLACEHOLDER_ROOT = "/home/you/";

function exampleFiles(): string[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

function rewritePlaceholders(value: unknown, tmp: string): unknown {
  if (typeof value === "string") {
    return value.startsWith(PLACEHOLDER_ROOT) ? path.join(tmp, value.slice(PLACEHOLDER_ROOT.length)) : value;
  }
  if (Array.isArray(value)) return value.map((v) => rewritePlaceholders(v, tmp));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewritePlaceholders(v, tmp)]));
  }
  return value;
}

/** Create every rewritten absolute path, so `allowed_roots` and project context paths exist at load. */
function createRewrittenPaths(value: unknown, tmp: string): void {
  if (typeof value === "string") {
    if (value === tmp || value.startsWith(`${tmp}${path.sep}`)) mkdirSync(value, { recursive: true });
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) createRewrittenPaths(v, tmp);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) createRewrittenPaths(v, tmp);
  }
}

function stageAndLoad(name: string, parsed: unknown) {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-examples-")));
  try {
    const staged = rewritePlaceholders(parsed, tmp);
    createRewrittenPaths(staged, tmp);
    const configPath = path.join(tmp, `${name}.json`);
    writeFileSync(configPath, JSON.stringify(staged), "utf8");
    // `homedir` keeps the default `data_dir` inside the temp dir instead of the operator's home.
    return loadConfig({ configPath, homedir: tmp });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function assertCleanText(name: string, text: string): void {
  for (const flag of bypassClassFlags()) {
    expect(text.includes(flag), `${name}: must not contain the bypass-class flag ${flag}`).toBe(false);
  }
  for (const re of [...DEFAULT_SECRET_PATTERNS, ...PREFIXED_PATTERNS]) {
    re.lastIndex = 0;
    expect(re.test(text), `${name}: matches the secret pattern ${re.source}`).toBe(false);
  }
}

describe("examples/ configs (Y9)", () => {
  it("every examples/*.json file loads with no error and carries no bypass flag or secret", () => {
    const files = exampleFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(path.join(EXAMPLES_DIR, file), "utf8");
      assertCleanText(file, text);
      const loaded = stageAndLoad(file.replace(/\.json$/, ""), JSON.parse(text));
      expect(loaded.mcpClients.size).toBeGreaterThan(0);
    }
  });

  it("the getting-started guide's minimal example loads too (extracted between its markers)", () => {
    const readme = readFileSync(REPO_README, "utf8");
    const m = /Minimal example:\s+```json\n([\s\S]*?)\n```/.exec(readme);
    expect(m, "the getting-started guide Configure section must keep a fenced minimal JSON example").toBeDefined();
    const text = m?.[1] as string;
    assertCleanText("guide minimal example", text);
    const loaded = stageAndLoad("readme-minimal", JSON.parse(text));
    expect(loaded.mcpClients.size).toBeGreaterThan(0);
  });
});

describe("examples/mcp-clients/ snippets (T8.12)", () => {
  it("every snippet parses as JSON and registers switchboard serve over stdio", () => {
    const dir = path.join(EXAMPLES_DIR, "mcp-clients");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(path.join(dir, file), "utf8");
      assertCleanText(file, text);
      const parsed = JSON.parse(text) as {
        mcpServers?: Record<string, { command?: unknown; args?: unknown }>;
      };
      const entry = parsed.mcpServers?.switchboard;
      expect(entry, `${file}: must register a switchboard server`).toBeDefined();
      expect(entry?.command).toBe("node");
      const args = entry?.args;
      expect(Array.isArray(args), `${file}: args must be a list`).toBe(true);
      expect((args as string[]).join(" ")).toContain("serve --client");
    }
  });
});
