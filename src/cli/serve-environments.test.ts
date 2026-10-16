/**
 * T10.1 (FR-PRJ-04, LLD §11.3): `serve` composes the lifecycle's environment resolver from the configuration and the
 * `container` backend. A scripted runtime stands in for Docker; nothing is started.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectConfig, ResolvedProject } from "../config/index.js";
import { type ContainerRuntime, hostEnvironment } from "../environment/index.js";
import { createIdGenerator } from "../ids/index.js";
import { createLedger, type Ledger, openLedger } from "../ledger/index.js";
import type { ProjectSnapshot } from "../policy/index.js";
import type { DynamicProjectState } from "../projects/index.js";
import { type Logger, runEnvironments } from "./serve.js";

let dir: string;
let db: Database.Database;
let ledger: Ledger;
const log: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-envs-"));
  db = openLedger(dir);
  ledger = createLedger(db, { ids: createIdGenerator() });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const DIGEST = `sha256:${"f".repeat(64)}`;
const project = (id: string, kind: "host" | "container"): ResolvedProject =>
  ({
    id,
    name: id,
    environment: kind === "container" ? { kind, imageDigest: DIGEST } : { kind },
    contexts: [{ id: "main", kind: "repository", path: dir, baseRef: "main", primary: true, writable: true }],
  }) as unknown as ResolvedProject;
const snap = (id: string): ProjectSnapshot => ({
  id,
  name: id,
  environment_kind: "container",
  image_digest: DIGEST,
  context_id: "main",
  base_ref: "main",
  effective_max_profile: "edit-untrusted",
});
const noDynamic = { state: () => undefined };
const counting = () => {
  const made = { count: 0 };
  const make = (): ContainerRuntime => {
    made.count += 1;
    return {} as ContainerRuntime; // never called: composition asks the runtime nothing
  };
  return { made, make };
};

describe("runEnvironments (T10.1)", () => {
  it("a host-only configuration composes nothing and never makes a runtime (host behaviour unchanged)", () => {
    const { made, make } = counting();
    expect(runEnvironments({ projects: [project("web", "host")] }, noDynamic, ledger, log, make)).toBeUndefined();
    expect(made.count).toBe(0);
  });

  it("a container project resolves to the container backend; host stays the identity; unknown ids fail closed", () => {
    const { made, make } = counting();
    const r = runEnvironments(
      { projects: [project("web", "host"), project("box", "container")] },
      noDynamic,
      ledger,
      log,
      make,
    );
    expect(made.count).toBe(1);
    expect(r?.resolve(snap("box"))?.environment.kind).toBe("container");
    expect(r?.resolve(undefined)?.environment).toBe(hostEnvironment);
    expect(r?.resolve(snap("nope"))).toBeUndefined();
  });

  it("a dynamic project resolves to its revision in force; a configured one of the same id wins", () => {
    const { make } = counting();
    const definition = {
      id: "dyn",
      name: "dyn",
      environment: { kind: "container", image_digest: DIGEST },
      contexts: [{ id: "main", kind: "repository", path: dir, base_ref: "main", primary: true }],
    } as unknown as ProjectConfig;
    const store = {
      state: (id: string) =>
        id === "dyn" ? ({ inForce: { definition } } as unknown as DynamicProjectState) : undefined,
    };
    const r = runEnvironments({ projects: [project("box", "container")] }, store, ledger, log, make);
    expect(r?.resolve(snap("dyn"))?.environment.kind).toBe("container");
    expect(r?.resolve({ ...snap("dyn"), image_digest: `sha256:${"0".repeat(64)}` })).toBeUndefined();
  });
});
