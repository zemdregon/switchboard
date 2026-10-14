/**
 * `rag` configuration (T12.1; FR-RAG-01, FR-RAG-03, FR-RAG-04, FR-RAG-09, FR-RAG-11, LLD §14.1). No embedding backend is
 * contacted: these tests only load configuration files.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectiveProjectRag, loadConfig, RAG_DEFAULTS } from "./index.js";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-rag-config-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const write = (obj: unknown) => {
  const p = path.join(tmp, "config.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
};
const base = () => ({
  schema_version: 1,
  allowed_roots: [tmp],
  mcp_clients: [{ id: "main", max_trust_profile: "edit-untrusted" }],
});
const project = (over: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}) => ({
  id: "web-app",
  name: "Web app",
  contexts: [{ id: "main", kind: "repository", path: path.join(tmp, "repo"), base_ref: "main", ...ctx }],
  ...over,
});
const HTTP = { kind: "http", base_url: "http://127.0.0.1:8089", model: "operator-model" };
const load = (extra: Record<string, unknown>) => loadConfig({ configPath: write({ ...base(), ...extra }) });
// Synthetic canary only: assembled at run time so no credential-shaped literal sits in the source.
const CANARY = `ghp_${"Q".repeat(36)}`;

describe("rag section absent or without a backend: inert (FR-RAG-01, FR-RAG-04)", () => {
  it("defaults to auto with no backend, so every project resolves off", () => {
    const c = load({ projects: [project()] });
    expect(c.rag.mode).toBe("auto");
    expect(c.rag.embedding).toBeUndefined();
    expect(effectiveProjectRag(c.rag, c.projects[0]?.rag)).toEqual({ enabled: false, reason: "NO_BACKEND" });
  });

  it("a project asking for auto, or a section with caps but no backend, is still off", () => {
    const c = load({ rag: { caps: { max_files: 10 } }, projects: [project({ rag: { mode: "auto" } })] });
    expect(effectiveProjectRag(c.rag, c.projects[0]?.rag)).toEqual({ enabled: false, reason: "NO_BACKEND" });
  });

  it("applies the T12.0 values and the Assumption defaults", () => {
    const c = load({});
    expect(c.rag.caps).toEqual({ ...RAG_DEFAULTS.caps });
    expect(c.rag.caps.maxChunks).toBe(25_000);
    expect(c.rag.retrieval).toEqual({
      topK: 8,
      maxContextTokens: 4000,
      maxStalenessMs: 24 * 3_600_000,
      admissionTimeoutMs: 250,
    });
    expect(c.rag.global).toEqual({ enabled: false, sources: [] });
  });
});

describe("schema and fail-closed rules (LLD §14.1)", () => {
  it("rejects unknown keys at every level", () => {
    expect(() => load({ rag: { surprise: 1 } })).toThrow(/\$\.rag\.surprise: unknown key/);
    expect(() => load({ rag: { embedding: { ...HTTP, api_key: "x" } } })).toThrow(
      /\$\.rag\.embedding\.api_key: unknown key/,
    );
    expect(() => load({ rag: { caps: { max_vectors: 1 } } })).toThrow(/\$\.rag\.caps\.max_vectors: unknown key/);
    expect(() => load({ projects: [project({ rag: { allow_remote: true } })] })).toThrow(/unknown key/);
    expect(() => load({ projects: [project({}, { rag: { use_global: true } })] })).toThrow(/unknown key/);
  });

  it("rejects a credential-looking value anywhere in the section without echoing it", () => {
    for (const cfg of [
      { rag: { embedding: { ...HTTP, model: CANARY } } },
      { rag: { exclude: [CANARY] } },
      { projects: [project({ rag: { exclude: [CANARY] } })] },
      { projects: [project({}, { rag: { exclude: [CANARY] } })] },
    ]) {
      let msg = "";
      try {
        load(cfg);
      } catch (err) {
        msg = (err as Error).message;
      }
      expect(msg).toMatch(/looks like a credential/);
      expect(msg).not.toContain(CANARY);
    }
  });

  it("rejects a base_url with userinfo or a query, and a missing base_url", () => {
    expect(() => load({ rag: { embedding: { ...HTTP, base_url: "http://u:p@127.0.0.1:1" } } })).toThrow(/userinfo/);
    expect(() => load({ rag: { embedding: { ...HTTP, base_url: "http://127.0.0.1:1/?k=v" } } })).toThrow(/query/);
    expect(() => load({ rag: { embedding: { kind: "http", model: "m" } } })).toThrow(/base_url: required/);
  });

  it("refuses the local kind in this version (T12.0) rather than guessing", () => {
    expect(() => load({ rag: { embedding: { kind: "local", model: "m" } } })).toThrow(
      /\$\.rag\.embedding\.kind: "local" is not available/,
    );
  });

  it("refuses mode on without a backend, at the installation and in a project", () => {
    expect(() => load({ rag: { mode: "on" } })).toThrow(/\$\.rag\.mode: "on" needs an embedding backend/);
    expect(() => load({ projects: [project({ rag: { mode: "on" } })] })).toThrow(
      /\$\.projects\[0\]\.rag\.mode: "on" needs an installation embedding backend/,
    );
  });

  it("caps above the schema maxima, or a project cap above the installation's, are refused", () => {
    expect(() => load({ rag: { caps: { max_chunks: 25_001 } } })).toThrow(/max_chunks/);
    expect(() =>
      load({
        rag: { embedding: HTTP, caps: { max_files: 100 } },
        projects: [project({ rag: { caps: { max_files: 101 } } })],
      }),
    ).toThrow(/\$\.projects\[0\]\.rag\.caps\.max_files: may only lower the installation value \(100\)/);
    expect(() =>
      load({ rag: { embedding: HTTP }, projects: [project({}, { rag: { caps: { max_chunks: 30_000 } } })] }),
    ).toThrow(/max_chunks/);
  });

  it("refuses absolute or parent-relative exclude globs", () => {
    expect(() => load({ rag: { exclude: ["/etc/**"] } })).toThrow(/\$\.rag\.exclude\[0\]: must be relative/);
    expect(() => load({ projects: [project({ rag: { exclude: ["../x"] } })] })).toThrow(/'\.\.' segment/);
  });

  it("global sources must be absolute, under an allowed root and uniquely labelled", () => {
    const g = (sources: unknown) => load({ rag: { global: { enabled: true, sources } } });
    expect(() => g([{ path: "docs", label: "a" }])).toThrow(/sources\[0\]\.path: must be absolute/);
    expect(() => g([{ path: "/elsewhere/docs", label: "a" }])).toThrow(/under an allowed root/);
    expect(() =>
      g([
        { path: path.join(tmp, "a"), label: "kb" },
        { path: path.join(tmp, "b"), label: "kb" },
      ]),
    ).toThrow(/sources\[1\]\.label: duplicate label/);
    expect(g([{ path: path.join(tmp, "kb"), label: "kb" }]).rag.global.sources).toHaveLength(1);
  });
});

describe("effective per-project setting (narrowing only)", () => {
  it("with a backend, auto is on; installation off or project off wins", () => {
    const on = load({ rag: { embedding: HTTP }, projects: [project()] });
    expect(effectiveProjectRag(on.rag, on.projects[0]?.rag)).toMatchObject({ enabled: true, useGlobal: false });
    const instOff = load({ rag: { embedding: HTTP, mode: "off" }, projects: [project({ rag: { mode: "on" } })] });
    expect(effectiveProjectRag(instOff.rag, instOff.projects[0]?.rag)).toEqual({
      enabled: false,
      reason: "INSTALLATION_OFF",
    });
    const projOff = load({ rag: { embedding: HTTP }, projects: [project({ rag: { mode: "off" } })] });
    expect(effectiveProjectRag(projOff.rag, projOff.projects[0]?.rag)).toEqual({
      enabled: false,
      reason: "PROJECT_OFF",
    });
  });

  it("lowers caps, unions exclusions, and grants sharing only when the global store is enabled", () => {
    const c = load({
      rag: { embedding: HTTP, exclude: ["dist/**"] },
      projects: [project({ rag: { caps: { max_files: 5 }, exclude: ["vendor/**"], use_global: true } })],
    });
    const eff = effectiveProjectRag(c.rag, c.projects[0]?.rag);
    expect(eff).toMatchObject({ enabled: true, exclude: ["dist/**", "vendor/**"], useGlobal: false });
    if (eff.enabled) expect(eff.caps.maxFiles).toBe(5);
    const g = load({
      rag: { embedding: HTTP, global: { enabled: true } },
      projects: [project({ rag: { use_global: true, contribute_to_global: true } })],
    });
    expect(effectiveProjectRag(g.rag, g.projects[0]?.rag)).toMatchObject({ useGlobal: true, contributeToGlobal: true });
  });

  it("keeps the remote gates off unless the operator sets them (FR-RAG-04)", () => {
    const c = load({ rag: { embedding: HTTP } });
    expect(c.rag.embedding).toMatchObject({ allowRemote: false, allowSourceContent: false, timeoutMs: 15_000 });
  });
});
