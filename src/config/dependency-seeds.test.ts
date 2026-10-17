/**
 * T9.13 (FR-WS-10, LLD §5.1): `projects[].dependency_seeds` and the `limits.seed_*` keys. The schema refuses unknown
 * shapes; `checkProjects` refuses the path rules a schema cannot say (absolute, `..`, `.git`, a directory that is or
 * holds the lockfile, nested directories, duplicate ids); an unset key leaves the resolved config exactly as before; and
 * a dynamic project definition (the MCP `create_project` shape) cannot carry the key.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./index.js";
import { projectSchema } from "./schema.js";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-config-seeds-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function write(obj: unknown): string {
  const p = path.join(tmp, "config.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
const NPM = { id: "npm", lockfile: "package-lock.json", directory: "node_modules", install: ["npm", "ci"] };
const config = (project: Record<string, unknown> = {}, limits?: Record<string, unknown>) => ({
  schema_version: 1,
  allowed_roots: [tmp],
  mcp_clients: [{ id: "main", max_trust_profile: "edit-untrusted", projects: ["web"] }],
  ...(limits !== undefined ? { limits } : {}),
  projects: [
    {
      id: "web",
      name: "Web",
      contexts: [{ id: "main", kind: "repository", path: path.join(tmp, "repo"), base_ref: "main" }],
      ...project,
    },
  ],
});
const errorOf = (cfg: unknown): string => {
  try {
    loadConfig({ configPath: write(cfg) });
  } catch (err) {
    if (err instanceof ConfigError) return err.message;
    throw err;
  }
  return "";
};

describe("projects[].dependency_seeds (T9.13, FR-WS-10)", () => {
  it("resolves a declared seed with the default timeout, in declaration order", () => {
    const c = loadConfig({
      configPath: write(
        config({
          dependency_seeds: [NPM, { ...NPM, id: "py", lockfile: "uv.lock", directory: ".venv", timeout_seconds: 30 }],
        }),
      ),
    });
    expect(c.projects[0]?.dependencySeeds).toEqual([
      {
        id: "npm",
        lockfile: "package-lock.json",
        directory: "node_modules",
        install: ["npm", "ci"],
        timeoutMs: 600_000,
      },
      { id: "py", lockfile: "uv.lock", directory: ".venv", install: ["npm", "ci"], timeoutMs: 30_000 },
    ]);
  });

  it("unset: no dependencySeeds key on the project and limits exactly as before", () => {
    const c = loadConfig({ configPath: write(config()) });
    expect(c.projects[0]).not.toHaveProperty("dependencySeeds");
    expect(c.limits).toEqual({ globalConcurrency: 4, perProviderConcurrency: 1 });
  });

  it("limits.seed_store_mb and seed_entries_per_seed resolve only when set", () => {
    const c = loadConfig({ configPath: write(config({}, { seed_store_mb: 512, seed_entries_per_seed: 2 })) });
    expect(c.limits).toEqual({
      globalConcurrency: 4,
      perProviderConcurrency: 1,
      seedStoreMb: 512,
      seedEntriesPerSeed: 2,
    });
    expect(errorOf(config({}, { seed_entries_per_seed: 0 }))).toMatch(/seed_entries_per_seed/);
  });

  it.each([
    ["an absolute lockfile", { lockfile: "/etc/passwd" }, /lockfile: must be relative/],
    ["a '..' component", { directory: "../outside" }, /directory: must not contain a '\.\.' component/],
    ["a path under .git", { directory: ".git/hooks" }, /directory: must not be under \.git/],
    ["a non-normalised path", { directory: "./node_modules" }, /directory: must be normalised/],
    [
      "a directory that holds the lockfile",
      { lockfile: "node_modules/lock.json" },
      /must not be or contain the lockfile/,
    ],
    ["an empty executable", { install: [""] }, /install: must name an executable/],
  ])("refuses %s", (_what, patch, message) => {
    expect(errorOf(config({ dependency_seeds: [{ ...NPM, ...patch }] }))).toMatch(message);
  });

  it("refuses duplicate ids and nested directories, without echoing the paths", () => {
    const dup = errorOf(config({ dependency_seeds: [NPM, { ...NPM, directory: "other" }] }));
    expect(dup).toMatch(/dependency_seeds\[1\]\.id: duplicate seed id/);
    const nested = errorOf(config({ dependency_seeds: [NPM, { ...NPM, id: "inner", directory: "node_modules/x" }] }));
    expect(nested).toMatch(/dependency_seeds\[1\]\.directory: equal to or nested with dependency_seeds\[0\]/);
    expect(nested).not.toContain("node_modules/x");
  });

  it("refuses unknown fields, a shell string, more than eight seeds and a timeout out of range (schema)", () => {
    expect(errorOf(config({ dependency_seeds: [{ ...NPM, shell: true }] }))).not.toBe("");
    expect(errorOf(config({ dependency_seeds: [{ ...NPM, install: "npm ci" }] }))).not.toBe("");
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...NPM, id: `s${i}`, directory: `d${i}` }));
    expect(errorOf(config({ dependency_seeds: nine }))).not.toBe("");
    expect(errorOf(config({ dependency_seeds: [{ ...NPM, timeout_seconds: 3601 }] }))).not.toBe("");
    expect(errorOf(config({ dependency_seeds: [{ ...NPM, id: "Bad_Id" }] }))).not.toBe("");
  });

  it("a dynamic project definition (create_project's shape) cannot declare seeds", () => {
    expect(projectSchema.additionalProperties).toBe(false);
    expect(Object.keys(projectSchema.properties)).not.toContain("dependency_seeds");
  });
});
