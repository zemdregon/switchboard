/**
 * LLD §19.5 steps 2 to 4 (T16.9; FR-SKL-03, FR-SKL-04): the pure resolver `list_skills` uses for `defaults` and
 * admission (T16.4) is to reuse. Catalogues are in-memory; nothing is read or written.
 */
import { describe, expect, it } from "vitest";
import {
  type CatalogEntry,
  type CatalogVersion,
  newestInjectableVersion,
  type ResolveSkillsInput,
  resolveSkills,
  type SkillCatalog,
} from "./resolve.js";

const v = (version: number, state: CatalogVersion["state"], origin: CatalogVersion["origin"] = "operator_file") => ({
  version,
  state,
  origin,
  sha256: `${String(version)}`.repeat(64).slice(0, 64),
});

function catalog(entries: CatalogEntry[]): SkillCatalog {
  const m = new Map(entries.map((e) => [e.name, e]));
  return (name) => m.get(name);
}

const STORE = catalog([
  { name: "alpha", retired: false, versions: [v(1, "approved"), v(2, "approved")] },
  { name: "beta", retired: false, versions: [v(1, "approved"), v(2, "draft")] },
  { name: "gamma", retired: false, versions: [v(1, "approved"), v(2, "revoked")] },
  { name: "old-one", retired: true, versions: [v(1, "approved")] },
  { name: "repo-made", retired: false, versions: [v(1, "approved", "repository_path")] },
]);

const base: ResolveSkillsInput = {
  profile: "edit-untrusted",
  allowDraftInTrusted: false,
  global: { defaults: [], roles: {} },
};

const pick = (r: ReturnType<typeof resolveSkills>) => r.entries.map((e) => `${e.name}@${e.version}:${e.source}`);

describe("resolveSkills (LLD §19.5 steps 2 to 4)", () => {
  it("builds candidates in source order and keeps the first position per name", () => {
    const r = resolveSkills(
      {
        ...base,
        global: { defaults: ["beta"], roles: { reviewer: ["alpha", "beta"] } },
        project: { defaults: ["gamma", "alpha"], roles: { reviewer: ["alpha"] } },
        role: "reviewer",
        requested: ["gamma"],
      },
      STORE,
    );
    expect(pick(r)).toEqual(["beta@1:global_default", "alpha@2:global_role", "gamma@1:project_default"]);
    expect(r.skipped).toEqual([]);
    expect(r.refused).toBeUndefined();
  });

  it("an explicit @n anywhere wins over an unpinned entry and supplies the source", () => {
    const r = resolveSkills({ ...base, global: { defaults: ["alpha"], roles: {} }, requested: ["alpha@1"] }, STORE);
    expect(pick(r)).toEqual(["alpha@1:request"]);
  });

  it("an unknown role selects nothing and skill_defaults omit drops every configured list", () => {
    const lists = { defaults: ["alpha"], roles: { reviewer: ["beta"] } };
    expect(pick(resolveSkills({ ...base, global: lists, role: "nobody" }, STORE))).toEqual(["alpha@2:global_default"]);
    expect(pick(resolveSkills({ ...base, global: lists, role: "constructor" }, STORE))).toEqual([
      "alpha@2:global_default",
    ]);
    expect(
      pick(
        resolveSkills({ ...base, global: lists, role: "reviewer", skillDefaults: "omit", requested: ["beta"] }, STORE),
      ),
    ).toEqual(["beta@1:request"]);
  });

  it("a failing configured default is skipped with its reason; a failing requested name refuses", () => {
    const r = resolveSkills(
      {
        ...base,
        clientSkills: ["alpha", "beta", "repo-made", "old-one", "missing"],
        global: { defaults: ["missing", "old-one", "gamma", "beta@2", "repo-made", "alpha"], roles: {} },
      },
      STORE,
    );
    expect(pick(r)).toEqual(["alpha@2:global_default"]);
    expect(r.skipped.map((s) => [s.ref, s.reason])).toEqual([
      ["missing", "SKILL_UNKNOWN"],
      ["old-one", "SKILL_UNKNOWN"],
      ["gamma", "SKILL_NOT_PERMITTED"],
      ["beta@2", "SKILL_NOT_APPROVED"],
      ["repo-made", "SKILL_REPOSITORY_ORIGIN"],
    ]);
    expect(r.refused).toBeUndefined();

    const req = resolveSkills({ ...base, global: { defaults: ["beta"], roles: {} }, requested: ["beta@2"] }, STORE);
    expect(req.refused).toEqual({ ref: "beta@2", reason: "SKILL_NOT_APPROVED" });
    expect(req.skipped).toEqual([]);
    expect(resolveSkills({ ...base, requested: ["missing"] }, STORE).refused).toEqual({
      ref: "missing",
      reason: "SKILL_UNKNOWN",
    });
  });

  it("a draft resolves only in a trusted profile with allow_draft_in_trusted; a revoked version never", () => {
    const trusted = { ...base, profile: "trusted-development" as const, allowDraftInTrusted: true };
    expect(pick(resolveSkills({ ...trusted, requested: ["beta", "gamma"] }, STORE))).toEqual([
      "beta@2:request",
      "gamma@1:request",
    ]);
    expect(pick(resolveSkills({ ...base, requested: ["beta"] }, STORE))).toEqual(["beta@1:request"]);
    expect(resolveSkills({ ...trusted, requested: ["gamma@2"] }, STORE).refused).toEqual({
      ref: "gamma@2",
      reason: "SKILL_NOT_APPROVED",
    });
  });

  it("is deterministic for the same input", () => {
    const input = { ...base, global: { defaults: ["alpha", "beta"], roles: {} }, requested: ["gamma@1"] };
    expect(resolveSkills(input, STORE)).toEqual(resolveSkills(input, STORE));
  });
});

describe("newestInjectableVersion (LLD §19.9)", () => {
  it("falls back to an older version that passes the gates, and hides retired or invisible names", () => {
    const entry = (n: string) => STORE(n) as CatalogEntry;
    expect(newestInjectableVersion(entry("gamma"), base)?.version).toBe(1);
    expect(newestInjectableVersion(entry("beta"), base)?.version).toBe(1);
    expect(newestInjectableVersion(entry("old-one"), base)).toBeUndefined();
    expect(newestInjectableVersion(entry("repo-made"), base)).toBeUndefined();
    expect(newestInjectableVersion(entry("repo-made"), { ...base, profile: "trusted-development" })?.version).toBe(1);
    expect(newestInjectableVersion(entry("alpha"), { ...base, clientSkills: ["beta"] })).toBeUndefined();
  });
});
