/**
 * LLD §19.5 steps 1 to 5 (T16.4; FR-SKL-03, FR-SKL-04, FRD BR-53, V15, C8): `resolveRunSkills` over in-memory
 * catalogues. Nothing is read or written. The property tests use a seeded generator, so a failure names its seed.
 */
import { describe, expect, it } from "vitest";
import type { TrustProfile } from "../ledger/index.js";
import {
  type ResolveRunSkillsInput,
  type RunSkillSet,
  resolveRunSkills,
  SkillAdmissionError,
  type SkillAdmissionSettings,
} from "./admission.js";
import type { CatalogEntry, CatalogVersion, SkillCatalog } from "./resolve.js";

const UNTRUSTED: readonly TrustProfile[] = ["inspect-untrusted", "edit-untrusted", "test-sandboxed"];
const ALL_PROFILES: readonly TrustProfile[] = [...UNTRUSTED, "trusted-development", "privileged"];

const hash = (name: string, version: number) =>
  `${name}:${version}`
    .split("")
    .map((c) => c.charCodeAt(0).toString(16))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);

const v = (
  name: string,
  version: number,
  state: CatalogVersion["state"],
  origin: CatalogVersion["origin"] = "operator_file",
  sizeBytes = 100,
): CatalogVersion => ({ version, state, origin, sha256: hash(name, version), sizeBytes });

function catalog(entries: CatalogEntry[]): SkillCatalog {
  const m = new Map(entries.map((e) => [e.name, e]));
  return (name) => m.get(name);
}

const settings = (over: Partial<SkillAdmissionSettings> = {}): SkillAdmissionSettings => ({
  defaults: [],
  roles: {},
  allowDraftInTrusted: false,
  maxPerRun: 8,
  maxRunBytes: 65_536,
  ...over,
});

const input = (over: Partial<ResolveRunSkillsInput> = {}): ResolveRunSkillsInput => ({
  settings: settings(),
  fields: {},
  profile: "edit-untrusted",
  ...over,
});

function refusal(f: () => unknown): SkillAdmissionError {
  try {
    f();
  } catch (err) {
    if (err instanceof SkillAdmissionError) return err;
    throw err;
  }
  throw new Error("expected a SkillAdmissionError");
}

const STORE = catalog([
  { name: "alpha", retired: false, versions: [v("alpha", 1, "approved"), v("alpha", 2, "approved")] },
  { name: "beta", retired: false, versions: [v("beta", 1, "approved"), v("beta", 2, "draft")] },
  { name: "repo-made", retired: false, versions: [v("repo-made", 1, "approved", "repository_path")] },
  { name: "big", retired: false, versions: [v("big", 1, "approved", "operator_file", 40_000)] },
  { name: "old-one", retired: true, versions: [v("old-one", 1, "approved")] },
]);

describe("resolveRunSkills steps 2 to 5", () => {
  it("refuses a requested name with the V15 code and reason; a failing default is skipped instead", () => {
    const cases: [string, string, string][] = [
      ["nope", "INVALID_REQUEST", "SKILL_UNKNOWN"],
      ["old-one", "INVALID_REQUEST", "SKILL_UNKNOWN"],
      ["beta@2", "PERMISSION_BLOCKED", "SKILL_NOT_APPROVED"],
      ["repo-made", "PERMISSION_BLOCKED", "SKILL_REPOSITORY_ORIGIN"],
    ];
    for (const [ref, code, reason] of cases) {
      const err = refusal(() => resolveRunSkills(input({ fields: { skills: [ref] } }), STORE));
      expect(err.code, ref).toBe(code);
      expect(err.details).toEqual({ reason, skill: ref });
      const skipped = resolveRunSkills(input({ settings: settings({ defaults: [ref] }) }), STORE);
      expect(skipped.entries).toEqual([]);
      expect(skipped.skipped).toEqual([{ name: ref, reason }]);
    }
    const notPermitted = refusal(() =>
      resolveRunSkills(input({ fields: { skills: ["alpha"] }, clientSkills: ["beta"] }), STORE),
    );
    expect([notPermitted.code, notPermitted.details.reason]).toEqual(["PERMISSION_BLOCKED", "SKILL_NOT_PERMITTED"]);
  });

  it("caps give SKILL_RUN_LIMIT (count and bytes)", () => {
    const count = refusal(() =>
      resolveRunSkills(input({ settings: settings({ maxPerRun: 1 }), fields: { skills: ["alpha", "beta"] } }), STORE),
    );
    expect([count.code, count.details]).toEqual(["INVALID_REQUEST", { reason: "SKILL_RUN_LIMIT" }]);
    const bytes = refusal(() =>
      resolveRunSkills(
        input({ settings: settings({ maxRunBytes: 40_050 }), fields: { skills: ["alpha", "big"] } }),
        STORE,
      ),
    );
    expect([bytes.code, bytes.details]).toEqual(["INVALID_REQUEST", { reason: "SKILL_RUN_LIMIT" }]);
    // At the limit is allowed; defaults count towards the caps as well.
    expect(
      resolveRunSkills(
        input({ settings: settings({ maxRunBytes: 40_100, defaults: ["alpha"] }), fields: { skills: ["big"] } }),
        STORE,
      ).entries.length,
    ).toBe(2);
  });

  it("an unknown role selects nothing and is not an error", () => {
    const set = resolveRunSkills(
      input({ settings: settings({ roles: { reviewer: ["alpha"] } }), fields: { role: "nobody" } }),
      STORE,
    );
    expect(set).toEqual({ entries: [], skipped: [] });
  });
});

describe("resolveRunSkills step 1 (continuation, C8)", () => {
  const previous = [
    { name: "alpha", version: 1, sha256: hash("alpha", 1) },
    { name: "beta", version: 2, sha256: hash("beta", 2) },
  ];

  it("copies the previous rows with source continued and re-checks BR-53 for the new profile", () => {
    const trusted = resolveRunSkills(
      input({ profile: "trusted-development", settings: settings({ allowDraftInTrusted: true }), previous }),
      STORE,
    );
    expect(trusted.entries).toEqual([
      { name: "alpha", version: 1, sha256: hash("alpha", 1), source: "continued" },
      { name: "beta", version: 2, sha256: hash("beta", 2), source: "continued" },
    ]);
    const lower = resolveRunSkills(
      input({ profile: "inspect-untrusted", settings: settings({ allowDraftInTrusted: true }), previous }),
      STORE,
    );
    expect(lower.entries.map((e) => `${e.name}@${e.version}`)).toEqual(["alpha@1"]);
    expect(lower.skipped).toEqual([{ name: "beta@2", reason: "SKILL_NOT_APPROVED" }]);
  });

  it("a changed hash or a retired name is not copied; any field replaces the copy with steps 2 to 5", () => {
    const set = resolveRunSkills(
      input({
        previous: [
          { name: "alpha", version: 1, sha256: "f".repeat(64) },
          { name: "old-one", version: 1, sha256: hash("old-one", 1) },
        ],
      }),
      STORE,
    );
    expect(set.entries).toEqual([]);
    expect(set.skipped.map((s) => s.reason)).toEqual(["SKILL_UNKNOWN", "SKILL_UNKNOWN"]);
    const fresh = resolveRunSkills(input({ previous, fields: { skill_defaults: "omit" } }), STORE);
    expect(fresh).toEqual({ entries: [], skipped: [] });
  });
});

/** Mulberry32: a small seeded generator, so a failing case can be replayed from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const NAMES = ["aa", "bb", "cc", "dd", "ee", "ff"];

function generated(seed: number): { store: CatalogEntry[]; input: ResolveRunSkillsInput } {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const states: CatalogVersion["state"][] = ["approved", "draft", "revoked"];
  const store: CatalogEntry[] = NAMES.map((name) => ({
    name,
    retired: r() < 0.1,
    versions: Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) =>
      v(name, i + 1, pick(states), r() < 0.3 ? "repository_path" : "operator_file"),
    ),
  }));
  const ref = () => (r() < 0.4 ? `${pick(NAMES)}@${1 + Math.floor(r() * 3)}` : pick(NAMES));
  const refs = (n: number) => Array.from({ length: Math.floor(r() * n) }, ref);
  const requested = [...new Set(refs(4))];
  return {
    store,
    input: {
      settings: settings({
        defaults: refs(3),
        roles: { dev: refs(3) },
        allowDraftInTrusted: r() < 0.5,
      }),
      project: { defaults: refs(3), roles: { dev: refs(2) } },
      fields: {
        ...(requested.length > 0 ? { skills: requested } : {}),
        ...(r() < 0.5 ? { role: pick(["dev", "ops"]) } : {}),
        ...(r() < 0.2 ? { skill_defaults: "omit" as const } : {}),
      },
      profile: pick(ALL_PROFILES),
      ...(r() < 0.3
        ? {
            previous: NAMES.slice(0, Math.floor(r() * 4)).map((name) => {
              const n = 1 + Math.floor(r() * 3);
              return { name, version: n, sha256: hash(name, n) };
            }),
          }
        : {}),
    },
  };
}

function outcome(input: ResolveRunSkillsInput, store: SkillCatalog): RunSkillSet | { refused: object } {
  try {
    return resolveRunSkills(input, store);
  } catch (err) {
    if (err instanceof SkillAdmissionError) return { refused: { code: err.code, ...err.details } };
    throw err;
  }
}

describe("properties over generated requests (TDD §3.16.2)", () => {
  it("property 3: an untrusted profile never resolves a draft, revoked or repository_path version", () => {
    let checked = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const g = generated(seed);
      const store = catalog(g.store);
      for (const profile of UNTRUSTED) {
        const result = outcome({ ...g.input, profile }, store);
        if ("refused" in result) continue;
        for (const e of result.entries) {
          const ver = store(e.name)?.versions.find((x) => x.version === e.version);
          expect(ver?.state, `seed ${seed} ${profile} ${e.name}@${e.version}`).toBe("approved");
          expect(ver?.origin, `seed ${seed} ${profile} ${e.name}@${e.version}`).toBe("operator_file");
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000); // the generator does produce resolved entries to check
  });

  it("property 8: the resolver is deterministic (same config, store and request give the same ordered set)", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const a = generated(seed);
      const b = generated(seed);
      expect(outcome(b.input, catalog(b.store)), `seed ${seed}`).toEqual(outcome(a.input, catalog(a.store)));
    }
  });
});
