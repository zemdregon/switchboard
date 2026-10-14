/**
 * Background scheduler (T12.4; FR-RAG-11, LLD §14.5): a trigger never waits for a build, builds run one at a time, and
 * an operator action runs with the project's build aborted. Injected builds only.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { BuildResult } from "./build.js";
import { RagIndexer } from "./indexer.js";

const result = (projectKey: string, outcome: BuildResult["outcome"] = "ok"): BuildResult => ({
  projectKey,
  outcome,
  reason: null,
  revision: 1,
  complete: outcome === "ok",
  files: 0,
  chunks: 0,
  bytes: 0,
  filesEmbedded: 0,
  filesRemoved: 0,
  embedCalls: 0,
  durationMs: 0,
  backendKind: "local",
  locality: "local",
  modelId: "m",
});

/** A build that runs until released or aborted. */
function gatedBuilds() {
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const build = (id: string, signal: AbortSignal) => {
    started.push(id);
    return new Promise<BuildResult>((resolve) => {
      const done = (o: BuildResult["outcome"]) => resolve(result(id, o));
      release.set(id, () => done("ok"));
      signal.addEventListener("abort", () => done("partial"), { once: true });
    });
  };
  return { started, release, build };
}

const indexers: RagIndexer[] = [];
afterEach(async () => {
  for (const i of indexers.splice(0)) await i.stop();
});
const make = (deps: ConstructorParameters<typeof RagIndexer>[0]) => {
  const i = new RagIndexer(deps);
  indexers.push(i);
  return i;
};
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("RagIndexer", () => {
  it("trigger returns before the build starts, and the event loop stays free while a build is in flight", async () => {
    const g = gatedBuilds();
    const results: BuildResult[] = [];
    const idx = make({ projects: () => ["a"], build: g.build, onResult: (r) => results.push(r) });
    idx.trigger("a");
    expect(g.started).toEqual([]); // nothing ran inside trigger
    await tick();
    expect(g.started).toEqual(["a"]);
    expect(idx.current()).toBe("a");
    // Admission-like work completes while the build is still running.
    const admitted = await Promise.race([
      new Promise((r) => setTimeout(() => r("admitted"), 1)),
      idx.idle().then(() => "build finished first"),
    ]);
    expect(admitted).toBe("admitted");
    g.release.get("a")?.();
    await idx.idle();
    expect(results.map((r) => r.outcome)).toEqual(["ok"]);
  });

  it("runs builds one at a time in trigger order, queueing a project at most once", async () => {
    const g = gatedBuilds();
    const idx = make({ projects: () => ["a", "b"], build: g.build });
    idx.start();
    idx.trigger("a");
    idx.trigger("b");
    expect(idx.queued()).toEqual(["a", "b"]);
    await tick();
    expect(g.started).toEqual(["a"]);
    idx.trigger("a"); // a is running, not queued: it is queued once for after the current build
    expect(idx.queued()).toEqual(["b", "a"]);
    g.release.get("a")?.();
    await tick();
    expect(g.started).toEqual(["a", "b"]);
    g.release.get("b")?.();
    await tick();
    g.release.get("a")?.();
    await idx.idle();
    expect(g.started).toEqual(["a", "b", "a"]);
  });

  it("exclusive aborts the project's running build, waits for it, and starts no build of it meanwhile", async () => {
    const g = gatedBuilds();
    const results: BuildResult[] = [];
    const idx = make({ projects: () => ["a"], build: g.build, onResult: (r) => results.push(r) });
    idx.trigger("a");
    await tick();
    let during: string | undefined = "unset";
    const out = await idx.exclusive("a", () => {
      during = idx.current();
      idx.trigger("a"); // queued, but held until the action settles
      return "cleared";
    });
    expect(out).toBe("cleared");
    expect(during).toBeUndefined();
    expect(results.map((r) => r.outcome)).toEqual(["partial"]);
  });

  it("a build error is reported and the queue continues; stop aborts and drops the queue", async () => {
    const errors: string[] = [];
    const g = gatedBuilds();
    const idx = make({
      projects: () => [],
      build: (id, s) => (id === "bad" ? Promise.reject(new Error("boom")) : g.build(id, s)),
      onError: (id) => errors.push(id),
    });
    idx.trigger("bad");
    idx.trigger("c");
    idx.trigger("d");
    await tick();
    expect(errors).toEqual(["bad"]);
    expect(g.started).toEqual(["c"]);
    await idx.stop();
    expect(g.started).toEqual(["c"]);
    idx.trigger("e");
    expect(idx.queued()).toEqual([]);
  });
});
