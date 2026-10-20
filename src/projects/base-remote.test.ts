/**
 * ADR-0074: the effective base remote of a dynamic definition. A primary `clone_url` context refreshes from its push
 * remote, else `origin`, unless it sets `base_remote`, which must then be the clone's remote; an explicit value that
 * differs from the default waits for approval (Delegated, fail closed). `path` contexts and configured projects keep
 * ADR-0067 (no `base_remote`, no fetch).
 */
import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../config/index.js";
import {
  approvalReasons,
  CLONE_REMOTE,
  checkBaseRemote,
  defaultBaseRemote,
  ProjectRuleError,
  toResolved,
} from "./rules.js";

const def = (ctx: Partial<ProjectConfig["contexts"][number]> = {}): ProjectConfig => ({
  id: "web",
  name: "Web",
  contexts: [
    {
      id: "main",
      kind: "repository",
      path: "/srv/clones/github.com/o/web",
      base_ref: "main",
      clone_url: "https://github.com/o/web",
      ...ctx,
    },
  ],
});

const baseRemoteOf = (d: ProjectConfig) => toResolved(d).contexts[0]?.baseRemote;

describe("effective base remote (ADR-0074)", () => {
  it("defaults a clone_url context to origin, or to its push remote", () => {
    expect(CLONE_REMOTE).toBe("origin");
    expect(baseRemoteOf(def())).toBe("origin");
    expect(baseRemoteOf(def({ push: { policy: "branch", remote: "origin", branch_prefix: "sb/" } }))).toBe("origin");
    expect(defaultBaseRemote({ clone_url: "https://github.com/o/web", push: { policy: "none", remote: "fork" } })).toBe(
      "fork",
    );
  });

  it("leaves a path context without base_remote unchanged (no fetch, as configured projects)", () => {
    const { clone_url: _drop, ...pathCtx } = def().contexts[0] as ProjectConfig["contexts"][number];
    expect(baseRemoteOf({ ...def(), contexts: [pathCtx] })).toBeUndefined();
    expect(baseRemoteOf({ ...def(), contexts: [{ ...pathCtx, base_remote: "upstream" }] })).toBe("upstream");
  });

  it("refuses a clone_url context's base_remote other than the clone's remote", () => {
    expect(() => checkBaseRemote(def({ base_remote: "origin" }))).not.toThrow();
    expect(() => checkBaseRemote(def())).not.toThrow();
    let err: unknown;
    try {
      checkBaseRemote(def({ base_remote: "upstream" }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProjectRuleError);
    expect(err).toMatchObject({
      code: "PERMISSION_BLOCKED",
      reason: "BASE_REMOTE_NOT_CLONE_REMOTE",
      field: "$.project.contexts[0].base_remote",
    });
    // A path context keeps the configuration rule (any remote name).
    const { clone_url: _drop, ...pathCtx } = def().contexts[0] as ProjectConfig["contexts"][number];
    expect(() => checkBaseRemote({ ...def(), contexts: [{ ...pathCtx, base_remote: "upstream" }] })).not.toThrow();
  });

  it("needs no approval for the default or an equal explicit value; a differing explicit value waits", () => {
    expect(approvalReasons(def(), undefined, "edit-untrusted")).not.toContain("base_remote");
    expect(approvalReasons(def({ base_remote: "origin" }), undefined, "edit-untrusted")).not.toContain("base_remote");
    const pushFork = { policy: "none" as const, remote: "fork" };
    expect(approvalReasons(def({ push: pushFork }), undefined, "edit-untrusted")).not.toContain("base_remote");
    expect(approvalReasons(def({ push: pushFork, base_remote: "origin" }), undefined, "edit-untrusted")).toContain(
      "base_remote",
    );
  });
});
