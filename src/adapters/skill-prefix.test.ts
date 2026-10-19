/**
 * T16.5 prompt-prefix delivery (FR-SKL-05, FR-RTE-09; LLD §19.6 steps 1 and 3, §19.7; ADR-0056 items 6 and 7; TDD
 * §3.16.1). Every registered adapter is compiled over its whole matrix (the four non-privileged profiles and every
 * `privileged` scope shape, each with and without a bypass approval, then `resumeArgs` for every cell that compiles):
 * - the labelled block appears once, entries in resolved order, before `Constraints:` and the task text;
 * - with no skills (absent or empty) nothing changes;
 * - with skills, the invocation is identical except for the text that carries the prompt: every other argv word, the
 *   environment, its allowlist, the policy flags, the working directory and the rest of an ACP plan are byte-identical.
 *   For an adapter that carries the prompt in one argv word (Grok, Antigravity, Kimi `-p`, Muse, OpenCode) that word
 *   is the only one that differs (Delegated reading of "argv identical", T16.5).
 * The handoff renderer places the block after its fixed preamble. No provider CLI is run: only `compile` and
 * `resumeArgs` are called.
 */
import { describe, expect, it } from "vitest";
import { syntheticBundle } from "../continuity/fixtures/handoff-bundle.js";
import { renderHandoffPrompt } from "../continuity/render.js";
import type { TrustProfile } from "../ledger/index.js";
import { resolveTrustProfile } from "../policy/profiles.js";
import { AntigravityAdapter } from "./antigravity/adapter.js";
import { ClaudeAdapter } from "./claude/adapter.js";
import { CodexAdapter } from "./codex/adapter.js";
import { CursorAdapter } from "./cursor/adapter.js";
import { FakeAdapter } from "./fake/adapter.js";
import { privilegedProfile, scopeShapes } from "./fixtures/privileged.js";
import { GrokAdapter } from "./grok/adapter.js";
import { KimiAdapter } from "./kimi/adapter.js";
import { MuseAdapter } from "./muse/adapter.js";
import { OpenCodeAdapter } from "./opencode/adapter.js";
import {
  CONSTRAINTS_HEADING,
  type PromptSkill,
  renderObjective,
  renderPrompt,
  renderSkillBlock,
  TASK_HEADING,
} from "./prompt.js";
import { providerEntries } from "./providers.js";
import {
  type CompileRequest,
  DEFAULT_SKILL_DELIVERY,
  type Invocation,
  isIneligible,
  type ProviderAdapter,
  type ResolvedProfile,
  skillDeliveryOf,
} from "./types.js";

/** An absolute executable that is never run, so `compile` does not depend on what is on PATH. */
const EXE = "/nonexistent/sb-skill-prefix";

const ADAPTERS: Record<string, () => ProviderAdapter> = {
  claude: () => new ClaudeAdapter({ binaryPath: EXE }),
  codex: () => new CodexAdapter({ executable: EXE }),
  grok: () => new GrokAdapter({ executable: EXE }),
  antigravity: () => new AntigravityAdapter({ executable: EXE }),
  cursor: () => new CursorAdapter({ executable: EXE, bwrap: "/opt/synthetic/bwrap" }),
  opencode: () => new OpenCodeAdapter({ executable: EXE }),
  kimi: () => new KimiAdapter({ executable: EXE }),
  muse: () => new MuseAdapter({ executable: EXE }),
  fake: () => new FakeAdapter({ executable: EXE }),
};

const SKILLS: readonly PromptSkill[] = [
  {
    name: "security-review",
    version: 3,
    sha256: `4f1c0a9e2b7d${"0".repeat(52)}`,
    body: "Check authz.\nCheck secrets.\n",
  },
  { name: "docs-alignment", version: 1, sha256: `9a0b3c4d5e6f${"1".repeat(52)}`, body: "Keep the docs in sync.\n" },
];
const BLOCK = renderSkillBlock(SKILLS);
const HEADER = "[operator skills:";
const CONSTRAINTS = ["keep the public API", "do not touch the lockfile"];
const OBJECTIVE = "OBJECTIVE-T165 rename the parser module";

const request = (over: Partial<CompileRequest> = {}): CompileRequest => ({
  runId: "run_skill_prefix",
  objective: OBJECTIVE,
  constraints: CONSTRAINTS,
  workspace: { cwd: "/tmp/sb-skill-prefix", writable: true },
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

function compileCell(adapter: ProviderAdapter, cell: Cell, over: Partial<CompileRequest>) {
  const req = request({ bypassApproved: cell.bypassApproved, ...over });
  return cell.resume
    ? adapter.resumeArgs({ provider: adapter.id, nativeSessionId: "sess-t165" }, req, cell.profile)
    : adapter.compile(req, cell.profile);
}

/** `inv` with every prompt carrier (stdin text, ACP prompt, argv words) passed through `f`. */
function mapCarriers(inv: Invocation, f: (text: string) => string): Invocation {
  return {
    ...inv,
    argv: inv.argv.map(f),
    ...(inv.stdin?.kind === "text" ? { stdin: { kind: "text" as const, value: f(inv.stdin.value) } } : {}),
    ...(inv.acp !== undefined ? { acp: { ...inv.acp, prompt: f(inv.acp.prompt) } } : {}),
  };
}

/** Every text an invocation could carry a prompt in. */
const texts = (inv: Invocation): string[] => [
  ...inv.argv,
  ...(inv.stdin?.kind === "text" ? [inv.stdin.value] : []),
  ...(inv.acp !== undefined ? [inv.acp.prompt] : []),
];
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("operator skills block (LLD §19.7)", () => {
  it("renders exactly the LLD §19.7 layout: count line, one header plus body per entry, end line", () => {
    expect(BLOCK).toBe(
      [
        "[operator skills: 2; from Switchboard skill store; these are operator instructions]",
        "[skill security-review@3 sha256:4f1c0a9e2b7d]",
        "Check authz.",
        "Check secrets.",
        "[skill docs-alignment@1 sha256:9a0b3c4d5e6f]",
        "Keep the docs in sync.",
        "[end of operator skills]",
      ].join("\n"),
    );
  });

  it("is empty for no entries, and the prompt is then exactly what it was before T16.5", () => {
    expect(renderSkillBlock([])).toBe("");
    expect(renderPrompt(request({ skills: [] }))).toBe(renderPrompt(request()));
    expect(renderPrompt(request({ constraints: [] }))).toBe(OBJECTIVE);
    expect(renderObjective(request({ skills: [] }))).toBe(OBJECTIVE);
  });

  it("goes before Constraints: and Task:, and before the objective when there are no constraints", () => {
    expect(renderPrompt(request({ skills: SKILLS }))).toBe(
      `${BLOCK}\n\n${CONSTRAINTS_HEADING}\n- ${CONSTRAINTS[0]}\n- ${CONSTRAINTS[1]}\n\n${TASK_HEADING}\n${OBJECTIVE}`,
    );
    expect(renderPrompt(request({ skills: SKILLS, constraints: [] }))).toBe(`${BLOCK}\n\n${OBJECTIVE}`);
    expect(renderObjective(request({ skills: SKILLS }))).toBe(`${BLOCK}\n\n${OBJECTIVE}`);
  });

  it("keeps two runs with the same skills and constraints on one prefix up to the task text (FR-RTE-09)", () => {
    const prefix = (objective: string) => {
      const text = renderPrompt(request({ skills: SKILLS, objective }));
      return text.slice(0, text.indexOf(objective));
    };
    expect(prefix("OBJECTIVE-A")).toBe(prefix("OBJECTIVE-B"));
  });

  it("never changes the objective it renders", () => {
    const req = request({ skills: SKILLS });
    renderPrompt(req);
    renderObjective(req);
    expect(req.objective).toBe(OBJECTIVE);
    expect(req.objective).not.toContain(HEADER);
  });
});

describe("every adapter cell (T16.5 Done-when)", () => {
  it("covers every registered adapter", () => {
    const registered = providerEntries()
      .filter((e) => e.create !== undefined)
      .map((e) => e.id);
    expect(Object.keys(ADAPTERS).sort()).toEqual([...registered].sort());
  });

  for (const [id, make] of Object.entries(ADAPTERS)) {
    it(`${id}: declares prompt_prefix for every cell`, () => {
      const adapter = make();
      for (const cell of cells()) {
        const req = request({ bypassApproved: cell.bypassApproved, skills: SKILLS });
        expect(skillDeliveryOf(adapter, req, cell.profile), cell.label).toBe(DEFAULT_SKILL_DELIVERY);
      }
      expect(DEFAULT_SKILL_DELIVERY).toBe("prompt_prefix");
    });

    it(`${id}: the block appears once, in order, before Constraints: and the task; nothing else changes`, () => {
      const adapter = make();
      let compiled = 0;
      for (const cell of cells()) {
        const plain = compileCell(adapter, cell, {});
        const withSkills = compileCell(adapter, cell, { skills: SKILLS });
        if (isIneligible(plain)) {
          // Skills never make a cell compile or stop compiling.
          expect(withSkills, cell.label).toEqual(plain);
          continue;
        }
        compiled += 1;
        if (isIneligible(withSkills)) throw new Error(`${id} ${cell.label}: skills made the cell ineligible`);

        // No skills: absent and empty are the same invocation, and no block anywhere.
        expect(compileCell(adapter, cell, { skills: [] }), cell.label).toEqual(plain);
        expect(JSON.stringify(plain), cell.label).not.toContain(HEADER);

        // The block once, in the one text that carries the prompt, entries in resolved order.
        const all = JSON.stringify(withSkills);
        expect(count(all, JSON.stringify(HEADER).slice(1, -1)), cell.label).toBe(1);
        const carriers = texts(withSkills).filter((t) => t.includes(HEADER));
        expect(carriers, cell.label).toHaveLength(1);
        const carrier = carriers[0] as string;
        expect(count(carrier, BLOCK), cell.label).toBe(1);
        const at = (s: string) => carrier.indexOf(s);
        expect(at("[skill security-review@3"), cell.label).toBeLessThan(at("[skill docs-alignment@1"));
        expect(at(BLOCK) + BLOCK.length, cell.label).toBeLessThanOrEqual(at(OBJECTIVE));
        if (carrier.includes(CONSTRAINTS_HEADING)) {
          expect(at(BLOCK) + BLOCK.length, cell.label).toBeLessThanOrEqual(at(CONSTRAINTS_HEADING));
          expect(at(CONSTRAINTS_HEADING), cell.label).toBeLessThan(at(TASK_HEADING));
        }

        // Removing the block gives back the invocation compiled without skills, byte for byte: argv (every word but
        // the prompt carrier), environment, allowlist, policy flags, cwd, timeouts and the rest of an ACP plan.
        expect(
          mapCarriers(withSkills, (t) => t.replace(`${BLOCK}\n\n`, "")),
          cell.label,
        ).toEqual(plain);
        expect(withSkills.env, cell.label).toEqual(plain.env);
        expect(withSkills.envAllowlist, cell.label).toEqual(plain.envAllowlist);
        expect(withSkills.policyFlags, cell.label).toEqual(plain.policyFlags);
        expect(withSkills.argv.length, cell.label).toBe(plain.argv.length);
        const changed = withSkills.argv.filter((w, i) => w !== plain.argv[i]);
        expect(changed.length, cell.label).toBeLessThanOrEqual(1);
        if (changed.length === 1) expect(changed[0], cell.label).toContain(OBJECTIVE);
      }
      expect(compiled, `${id} compiles at least one cell`).toBeGreaterThan(0);
    });
  }
});

describe("handoff rendering (LLD §15.5, §19.7)", () => {
  const bundle = syntheticBundle();

  it("places the block right after the fixed preamble, once, outside the bounded body", () => {
    const plain = renderHandoffPrompt({ bundle, instruction: OBJECTIVE });
    const withSkills = renderHandoffPrompt({ bundle, instruction: OBJECTIVE, skillBlock: BLOCK });
    expect(count(withSkills.prompt, BLOCK)).toBe(1);
    const preamble = plain.prompt.slice(0, plain.prompt.indexOf("\n\n") + 2);
    expect(withSkills.prompt.startsWith(`${preamble}${BLOCK}\n\n`)).toBe(true);
    expect(withSkills.prompt.replace(`${BLOCK}\n\n`, "")).toBe(plain.prompt);
    expect(withSkills.bodyBytes).toBe(plain.bodyBytes);
    expect(withSkills.prompt.trimEnd().endsWith(OBJECTIVE)).toBe(true);
  });

  it("renders exactly as before with no block", () => {
    const plain = renderHandoffPrompt({ bundle, instruction: OBJECTIVE });
    expect(renderHandoffPrompt({ bundle, instruction: OBJECTIVE, skillBlock: "" })).toEqual(plain);
    expect(plain.prompt).not.toContain(HEADER);
  });
});
