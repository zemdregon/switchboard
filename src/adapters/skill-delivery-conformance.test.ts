/**
 * T16.7 adapter skill delivery declarations (FR-SKL-05, FR-ADP-11; TDD §3.16.1; LLD §19.6; ADR-0056 items 5, 6 and 8).
 * Every one of the eight provider adapters declares `prompt_prefix` itself (an own method, not the absent-means-default
 * fallback) for every compiled cell: the four non-privileged profiles and every `privileged` scope shape, each with and
 * without a bypass approval, then `resumeArgs` for the same cells. The conformance check (`checkSkillDelivery`, part of
 * `checkAdapterStatics`) fails a `native` declaration without a T16.8 evidence id and a cell whose argv the skills
 * change; broken variants prove both guards fire and a positive control proves they do not always fail. No provider
 * CLI is run: only `compile`, `resumeArgs` and `skillDelivery` are called.
 */
import { describe, expect, it } from "vitest";
import type { TrustProfile } from "../ledger/index.js";
import { resolveTrustProfile } from "../policy/profiles.js";
import { AntigravityAdapter } from "./antigravity/adapter.js";
import { ClaudeAdapter } from "./claude/adapter.js";
import { CodexAdapter } from "./codex/adapter.js";
import { type ConformanceCase, checkAdapterStatics, checkSkillDelivery } from "./conformance.js";
import { CursorAdapter } from "./cursor/adapter.js";
import { FAKE_NATIVE_SKILL_LOCATION, FakeAdapter } from "./fake/adapter.js";
import { privilegedProfile, scopeShapes } from "./fixtures/privileged.js";
import { GrokAdapter } from "./grok/adapter.js";
import { KimiAdapter } from "./kimi/adapter.js";
import { MuseAdapter } from "./muse/adapter.js";
import { OpenCodeAdapter } from "./opencode/adapter.js";
import type { PromptSkill } from "./prompt.js";
import { providerEntries } from "./providers.js";
import {
  type CompileRequest,
  type Ineligible,
  type Invocation,
  isIneligible,
  type NativeSkillLocation,
  type ProviderAdapter,
  type ResolvedProfile,
  type SkillDelivery,
  skillDeliveryOf,
} from "./types.js";

/** An absolute executable that is never run, so `compile` does not depend on what is on PATH. */
const EXE = "/nonexistent/sb-skill-delivery";

const PROVIDERS: Record<string, () => ProviderAdapter> = {
  claude: () => new ClaudeAdapter({ binaryPath: EXE }),
  codex: () => new CodexAdapter({ executable: EXE }),
  grok: () => new GrokAdapter({ executable: EXE }),
  antigravity: () => new AntigravityAdapter({ executable: EXE }),
  cursor: () => new CursorAdapter({ executable: EXE, bwrap: "/opt/synthetic/bwrap" }),
  opencode: () => new OpenCodeAdapter({ executable: EXE }),
  kimi: () => new KimiAdapter({ executable: EXE }),
  muse: () => new MuseAdapter({ executable: EXE }),
};

const SKILLS: readonly PromptSkill[] = [
  { name: "security-review", version: 3, sha256: "4".repeat(64), body: "Check authz.\n" },
  { name: "docs-alignment", version: 1, sha256: "9".repeat(64), body: "Keep the docs in sync.\n" },
];

const request = (over: Partial<CompileRequest> = {}): CompileRequest => ({
  runId: "run_skill_delivery",
  objective: "OBJECTIVE-T167 rename the parser module",
  constraints: ["keep the public API"],
  workspace: { cwd: "/tmp/sb-skill-delivery", writable: true },
  ...over,
});

const NON_PRIVILEGED: readonly TrustProfile[] = [
  "inspect-untrusted",
  "edit-untrusted",
  "test-sandboxed",
  "trusted-development",
];

interface Cell {
  readonly label: string;
  readonly profile: ResolvedProfile;
  readonly bypassApproved: boolean;
  readonly resume: boolean;
}

function* cells(): Generator<Cell> {
  const profiles: { label: string; profile: ResolvedProfile }[] = [
    ...NON_PRIVILEGED.map((name) => ({ label: name, profile: resolveTrustProfile(name) })),
    ...scopeShapes().map((scope) => ({
      label: `privileged ${JSON.stringify(scope)}`,
      profile: privilegedProfile(scope),
    })),
  ];
  for (const { label, profile } of profiles)
    for (const bypassApproved of [false, true])
      for (const resume of [false, true]) {
        yield {
          label: `${label} bypassApproved=${bypassApproved}${resume ? " resume" : ""}`,
          profile: { ...profile, bypassApproved },
          bypassApproved,
          resume,
        };
      }
}

const conformanceCase = (
  adapter: ProviderAdapter,
  cell: Cell,
  over: Partial<CompileRequest> = {},
): ConformanceCase => ({
  kind: cell.resume ? "resume" : "success",
  adapter,
  request: request({ bypassApproved: cell.bypassApproved, ...over }),
  profile: cell.profile,
  expect: { ok: true },
  ...(cell.resume ? { binding: { provider: adapter.id, nativeSessionId: "sess-t167" } } : {}),
});

function compileCell(adapter: ProviderAdapter, cell: Cell, over: Partial<CompileRequest>): Invocation | Ineligible {
  const c = conformanceCase(adapter, cell, over);
  return c.binding ? adapter.resumeArgs(c.binding, c.request, c.profile) : adapter.compile(c.request, c.profile);
}

/** `adapter` itself (private state intact) with its own `skillDelivery` replaced: a test variant, never shipped. */
function declaring(adapter: ProviderAdapter, delivery: SkillDelivery): ProviderAdapter {
  Object.defineProperty(adapter, "skillDelivery", { value: () => delivery });
  return adapter;
}

const location = (evidence: unknown): NativeSkillLocation =>
  ({
    dir: ".claude/skills",
    layout: { file: "SKILL.md" },
    render: (s: PromptSkill) => s.body,
    evidence,
  }) as NativeSkillLocation;

const failed = (checks: { name: string; ok: boolean }[]) => checks.filter((k) => !k.ok).map((k) => k.name);
const EVIDENCE_CHECK = "native skill delivery carries a T16.8 evidence id";
const ARGV_CHECK = "skills never change the compiled argv";

describe("provider adapter skill delivery declarations (T16.7, TDD §3.16.1)", () => {
  it("covers every registered provider adapter except the fake", () => {
    const registered = providerEntries()
      .filter((e) => e.create !== undefined && e.id !== "fake")
      .map((e) => e.id);
    expect(Object.keys(PROVIDERS).sort()).toEqual([...registered].sort());
  });

  for (const [id, make] of Object.entries(PROVIDERS)) {
    it(`${id}: declares skillDelivery explicitly, as its own method`, () => {
      const adapter = make();
      expect(Object.hasOwn(Object.getPrototypeOf(adapter) as object, "skillDelivery")).toBe(true);
      expect(typeof adapter.skillDelivery).toBe("function");
    });

    it(`${id}: every shipped cell is prompt_prefix and passes the delivery conformance checks`, () => {
      const adapter = make();
      let compiled = 0;
      for (const cell of cells()) {
        for (const skills of [undefined, SKILLS]) {
          const c = conformanceCase(adapter, cell, skills ? { skills } : {});
          expect(adapter.skillDelivery?.(c.request, c.profile), cell.label).toBe("prompt_prefix");
          expect(skillDeliveryOf(adapter, c.request, c.profile), cell.label).toBe("prompt_prefix");
          expect(failed(checkSkillDelivery(c)), cell.label).toEqual([]);
        }
        if (!isIneligible(compileCell(adapter, cell, {}))) compiled += 1;
      }
      expect(compiled, `${id} compiles at least one cell`).toBeGreaterThan(0);
    });

    it(`${id}: a delivery declaration never changes the compiled argv (compared per cell)`, () => {
      const shipped = make();
      const native = declaring(make(), { native: location("t16.7-test-evidence") });
      for (const cell of cells()) {
        for (const skills of [undefined, SKILLS]) {
          const over = skills ? { skills } : {};
          expect(compileCell(native, cell, over), cell.label).toEqual(compileCell(shipped, cell, over));
        }
        const plain = compileCell(shipped, cell, {});
        const withSkills = compileCell(shipped, cell, { skills: SKILLS });
        if (isIneligible(plain) || isIneligible(withSkills)) {
          expect(isIneligible(withSkills), cell.label).toBe(isIneligible(plain));
          continue;
        }
        // Only the one word that carries the prompt may differ (T16.5); everything else is byte-identical.
        expect(withSkills.argv.length, cell.label).toBe(plain.argv.length);
        const changed = withSkills.argv.filter((w, i) => w !== plain.argv[i]);
        expect(changed.length, cell.label).toBeLessThanOrEqual(1);
        if (changed.length === 1) expect(changed[0], cell.label).toContain("OBJECTIVE-T167");
        expect(withSkills.env, cell.label).toEqual(plain.env);
        expect(withSkills.policyFlags, cell.label).toEqual(plain.policyFlags);
        if (id === "kimi") expect(withSkills.argv, cell.label).not.toContain("--skills-dir");
      }
    });

    it(`${id}: a broken variant declaring native without a T16.8 evidence id fails conformance`, () => {
      for (const evidence of [undefined, "", "   "]) {
        const broken = declaring(make(), { native: location(evidence) });
        const cell = cells().next().value as Cell;
        const c = conformanceCase(broken, cell, { skills: SKILLS });
        expect(failed(checkSkillDelivery(c)), String(evidence)).toEqual([EVIDENCE_CHECK]);
        expect(failed(checkAdapterStatics(c)), String(evidence)).toContain(EVIDENCE_CHECK);
        // The dispatcher reads it as prompt_prefix (fail closed), so nothing is written to the worktree (T16.6).
        expect(skillDeliveryOf(broken, c.request, c.profile)).toBe("prompt_prefix");
      }
      // Positive control: the same declaration with an evidence id passes, so the check does not always fail.
      const ok = declaring(make(), { native: location("t16.8-check-1") });
      expect(failed(checkSkillDelivery(conformanceCase(ok, cells().next().value as Cell)))).toEqual([]);
    });
  }

  it("a broken variant whose argv the skills change fails conformance", () => {
    const adapter = new ClaudeAdapter({ binaryPath: EXE });
    const compile = adapter.compile.bind(adapter);
    Object.defineProperty(adapter, "compile", {
      value: (req: CompileRequest, profile: ResolvedProfile) => {
        const inv = compile(req, profile);
        if (isIneligible(inv) || !req.skills?.length) return inv;
        return { ...inv, argv: [...inv.argv, "--skills-dir", "/tmp/skills"] };
      },
    });
    const c = conformanceCase(adapter, cells().next().value as Cell);
    expect(failed(checkSkillDelivery(c))).toEqual([ARGV_CHECK]);
    expect(failed(checkAdapterStatics(c))).toContain(ARGV_CHECK);
  });

  it("the fake is native only in its test variant, with its test-only evidence id", () => {
    const prefix = new FakeAdapter({ executable: EXE });
    const native = new FakeAdapter({ executable: EXE, nativeSkills: true });
    expect(FAKE_NATIVE_SKILL_LOCATION.evidence).toBe("fake-test-only");
    for (const cell of cells()) {
      expect(prefix.skillDelivery(), cell.label).toBe("prompt_prefix");
      expect(failed(checkSkillDelivery(conformanceCase(native, cell))), cell.label).toEqual([]);
      expect(compileCell(native, cell, { skills: SKILLS }), cell.label).toEqual(
        compileCell(prefix, cell, { skills: SKILLS }),
      );
    }
  });
});
