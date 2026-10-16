/**
 * The project environment resolver `serve` gives the lifecycle (T10.1; FR-PRJ-04, FR-PRJ-05, LLD §11.3). Pure: no
 * container runtime is involved; the environments are inert stand-ins.
 */
import { describe, expect, it } from "vitest";
import type { ResolvedProject } from "../config/projects.js";
import type { ProjectSnapshot } from "../policy/types.js";
import { hostEnvironment } from "./host.js";
import { createProjectEnvironmentResolver } from "./resolver.js";
import type { Environment } from "./types.js";

const DIGEST = `sha256:${"d".repeat(64)}`;
const container: Environment = {
  kind: "container",
  prepare: (_run, invocation) => Promise.resolve({ invocation }),
  teardown: () => Promise.resolve(),
  sweepOrphans: () => Promise.resolve({ removed: [] }),
};
const ctx = (id: string, primary: boolean, p: string) =>
  ({ id, kind: "repository", path: p, baseRef: "main", primary, writable: primary }) as ResolvedProject["contexts"][0];
const def = (environment: ResolvedProject["environment"]): Pick<ResolvedProject, "environment" | "contexts"> => ({
  environment,
  contexts: [ctx("main", true, "/repo/main"), ctx("docs", false, "/repo/docs-link"), ctx("spec", false, "/repo/spec")],
});
const snap = (over: Partial<ProjectSnapshot> = {}): ProjectSnapshot => ({
  id: "box",
  name: "Box",
  environment_kind: "container",
  image_digest: DIGEST,
  context_id: "main",
  base_ref: "main",
  effective_max_profile: "edit-untrusted",
  ...over,
});
const canonical = (p: string) => {
  if (p.endsWith("missing")) throw new Error("ENOENT");
  return p.replace("-link", "");
};

describe("createProjectEnvironmentResolver (T10.1)", () => {
  it("host runs (by path or a host project) get the identity environment and mount nothing", () => {
    const r = createProjectEnvironmentResolver({ container, lookup: () => undefined, canonical });
    expect(r.resolve(undefined)).toEqual({ environment: hostEnvironment, readOnlyContexts: [] });
    expect(r.resolve(snap({ environment_kind: "host" }))).toEqual({
      environment: hostEnvironment,
      readOnlyContexts: [],
    });
  });

  it("a container project gets the container environment, every non-primary context read-only (canonical) and its limits", () => {
    const lookups: string[] = [];
    const r = createProjectEnvironmentResolver({
      container,
      canonical,
      lookup: (id) => {
        lookups.push(id);
        return def({ kind: "container", imageDigest: DIGEST, limits: { cpus: 1, memoryMb: 256 } });
      },
    });
    expect(r.resolve(snap())).toEqual({
      environment: container,
      readOnlyContexts: [
        { id: "docs", path: "/repo/docs" },
        { id: "spec", path: "/repo/spec" },
      ],
      limits: { cpus: 1, memoryMb: 256 },
    });
    expect(lookups).toEqual(["box"]);
  });

  it("fails closed (no placement) rather than run a container project on the host", () => {
    const found = def({ kind: "container", imageDigest: DIGEST });
    // no container environment wired
    expect(createProjectEnvironmentResolver({ lookup: () => found, canonical }).resolve(snap())).toBeUndefined();
    // project no longer defined, or no longer a container project
    expect(createProjectEnvironmentResolver({ container, lookup: () => undefined }).resolve(snap())).toBeUndefined();
    const nowHost = def({ kind: "host" });
    expect(createProjectEnvironmentResolver({ container, lookup: () => nowHost }).resolve(snap())).toBeUndefined();
    // re-pinned image: the frozen snapshot is not run against another image
    const repinned = def({ kind: "container", imageDigest: `sha256:${"e".repeat(64)}` });
    expect(createProjectEnvironmentResolver({ container, lookup: () => repinned }).resolve(snap())).toBeUndefined();
    // a read-only context that cannot be canonicalised
    const missing = { ...found, contexts: [...found.contexts, ctx("gone", false, "/repo/missing")] };
    expect(
      createProjectEnvironmentResolver({ container, lookup: () => missing, canonical }).resolve(snap()),
    ).toBeUndefined();
  });
});
