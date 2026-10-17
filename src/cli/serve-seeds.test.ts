/**
 * T9.13 (FR-WS-10, LLD §5.1): `serve` composes the dependency seed store only when a configured project declares a
 * seed. Without one there is no store, no runtime and no `seeds` directory, so every worktree is as before. A scripted
 * runtime stands in for Docker; nothing is started.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts/index.js";
import type { ResolvedProject, SeedSpec } from "../config/index.js";
import type { ContainerRuntime } from "../environment/index.js";
import { createIdGenerator } from "../ids/index.js";
import { openLedger } from "../ledger/index.js";
import { hostSeedEnvironment } from "../workspace/index.js";
import { serveSeeds } from "./serve.js";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-serve-seeds-"));
  db = openLedger(dir);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const DIGEST = `sha256:${"f".repeat(64)}`;
const NPM: SeedSpec = {
  id: "npm",
  lockfile: "package-lock.json",
  directory: "node_modules",
  install: ["npm", "ci"],
  timeoutMs: 600_000,
};
const project = (id: string, kind: "host" | "container", seeds?: SeedSpec[]): ResolvedProject =>
  ({
    id,
    name: id,
    environment: kind === "container" ? { kind, imageDigest: DIGEST } : { kind },
    contexts: [{ id: "main", kind: "repository", path: dir, baseRef: "main", primary: true, writable: true }],
    ...(seeds !== undefined ? { dependencySeeds: seeds } : {}),
  }) as unknown as ResolvedProject;
const config = (projects: ResolvedProject[]) => ({
  projects,
  dataDir: dir,
  limits: { globalConcurrency: 4, perProviderConcurrency: 1 },
  confinedVerification: false,
  profileOverrides: {},
});
const counting = () => {
  const made = { count: 0 };
  return {
    made,
    make: (): ContainerRuntime => {
      made.count += 1;
      return {} as ContainerRuntime;
    },
  };
};
const compose = (projects: ResolvedProject[], make: () => ContainerRuntime) =>
  serveSeeds(config(projects), db, new ArtifactStore(path.join(dir, "artifacts")), createIdGenerator(), {}, make);

describe("serveSeeds (T9.13)", () => {
  it("no project declares a seed: no store, no runtime, no seeds directory (main behaviour)", () => {
    const { made, make } = counting();
    expect(compose([project("web", "host"), project("box", "container"), project("e", "host", [])], make)).toBe(
      undefined,
    );
    expect(made.count).toBe(0);
    expect(existsSync(path.join(dir, "seeds"))).toBe(false);
  });

  it("plans each seeded project's seeds and environment; a host-only set makes no runtime", () => {
    const { made, make } = counting();
    const s = compose([project("web", "host", [NPM]), project("api", "host")], make);
    expect(made.count).toBe(0);
    expect(s?.root).toBe(path.join(dir, "seeds"));
    expect(s?.plan("web")).toEqual({ specs: [NPM], environment: hostSeedEnvironment() });
    expect(s?.plan("api")).toBeUndefined();
    expect(s?.plan("unknown")).toBeUndefined();
  });

  it("a seeded container project gets the container builder and its image digest as the seed environment", () => {
    const { made, make } = counting();
    const s = compose([project("box", "container", [NPM])], make);
    expect(made.count).toBe(1);
    expect(s?.plan("box")).toEqual({ specs: [NPM], environment: { kind: "container", imageDigest: DIGEST } });
  });
});
