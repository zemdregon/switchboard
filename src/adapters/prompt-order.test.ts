/**
 * Cache-friendly prompt order (FR-RTE-09, Could; LLD §3.2, §14.6 step 5, §14.11.2; T7.9). For every registered adapter
 * that renders a prompt, two runs of a project with the same constraints and different objectives send text that is
 * identical up to the task text; the constraints (stable) come before it and a retrieval pack (volatile, appended to
 * the objective by the lifecycle) after it. The handoff renderer keeps its fixed preamble first and the instruction
 * last. No provider CLI is run: only `compile` is called, and no cache benefit is claimed or measured (Q-53).
 */
import { describe, expect, it } from "vitest";
import { syntheticBundle } from "../continuity/fixtures/handoff-bundle.js";
import { renderHandoffPrompt } from "../continuity/render.js";
import { AntigravityAdapter } from "./antigravity/adapter.js";
import { PRIVILEGED_BYPASS_PROFILE as ANTIGRAVITY_PROFILE } from "./antigravity/fixtures/cases.js";
import { ClaudeAdapter } from "./claude/adapter.js";
import { CodexAdapter } from "./codex/adapter.js";
import { EDIT_PROFILE } from "./codex/fixtures/cases.js";
import { CursorAdapter } from "./cursor/adapter.js";
import { PRIVILEGED_BYPASS_PROFILE as CURSOR_PROFILE } from "./cursor/fixtures/cases.js";
import { FakeAdapter } from "./fake/adapter.js";
import { GrokAdapter } from "./grok/adapter.js";
import { PRIVILEGED_BYPASS_PROFILE as GROK_PROFILE } from "./grok/fixtures/cases.js";
import { KimiAdapter } from "./kimi/adapter.js";
import { PRIVILEGED_BYPASS_PROFILE as KIMI_PROFILE } from "./kimi/fixtures/cases.js";
import { MuseAdapter } from "./muse/adapter.js";
import { PRIVILEGED_BYPASS_PROFILE as MUSE_PROFILE } from "./muse/fixtures/cases.js";
import { OpenCodeAdapter } from "./opencode/adapter.js";
import { PRIVILEGED_BYPASS_PROFILE as OPENCODE_PROFILE } from "./opencode/fixtures/cases.js";
import { CONSTRAINTS_HEADING, renderPrompt, TASK_HEADING } from "./prompt.js";
import { providerEntries } from "./providers.js";
import {
  type CompileRequest,
  type Invocation,
  isIneligible,
  type ProviderAdapter,
  type ResolvedProfile,
} from "./types.js";

/** An absolute executable that is never run, so `compile` does not depend on what is on PATH. */
const EXE = "/nonexistent/sb-prompt-order";

interface Subject {
  readonly make: () => ProviderAdapter;
  readonly profile: ResolvedProfile;
  /** The M4 adapters compile only an approved `privileged` bypass run (their headers); each uses its own fixture. */
  readonly bypassApproved: boolean;
}
const SUBJECTS: Record<string, Subject> = {
  claude: { make: () => new ClaudeAdapter({ binaryPath: EXE }), profile: EDIT_PROFILE, bypassApproved: false },
  codex: { make: () => new CodexAdapter({ executable: EXE }), profile: EDIT_PROFILE, bypassApproved: false },
  grok: { make: () => new GrokAdapter({ executable: EXE }), profile: GROK_PROFILE, bypassApproved: true },
  antigravity: {
    make: () => new AntigravityAdapter({ executable: EXE }),
    profile: ANTIGRAVITY_PROFILE,
    bypassApproved: true,
  },
  cursor: { make: () => new CursorAdapter({ executable: EXE }), profile: CURSOR_PROFILE, bypassApproved: true },
  opencode: { make: () => new OpenCodeAdapter({ executable: EXE }), profile: OPENCODE_PROFILE, bypassApproved: true },
  kimi: { make: () => new KimiAdapter({ executable: EXE }), profile: KIMI_PROFILE, bypassApproved: true },
  muse: { make: () => new MuseAdapter({ executable: EXE }), profile: MUSE_PROFILE, bypassApproved: true },
  fake: { make: () => new FakeAdapter({ executable: EXE }), profile: EDIT_PROFILE, bypassApproved: false },
};

const CONSTRAINTS = ["keep the public API", "do not touch the lockfile"];
const OBJECTIVE_A = "OBJECTIVE-A rename the parser module";
const OBJECTIVE_B = "OBJECTIVE-B add a test for the retry chain";
const PACK = "<switchboard-context-pack 1>\nUNTRUSTED REFERENCE DATA\n</switchboard-context-pack 1>";

const request = (objective: string, constraints = CONSTRAINTS): CompileRequest => ({
  runId: "run_prompt_order",
  objective,
  constraints,
  workspace: { cwd: "/tmp/sb-prompt-order", writable: true },
});

/** The one place an invocation carries the prompt: stdin, the ACP `session/prompt` text or a single argv word. */
function carriedPrompt(inv: Invocation, marker: string): string {
  const carriers = [
    ...(inv.stdin?.kind === "text" ? [inv.stdin.value] : []),
    ...(inv.acp !== undefined ? [inv.acp.prompt] : []),
    ...inv.argv,
  ].filter((text) => text.includes(marker));
  expect(carriers).toHaveLength(1);
  return carriers[0] as string;
}

/** The rendered prompt and the text before the task text; the prefix of an argv carrier includes its flag spelling. */
function split(inv: Invocation, objective: string) {
  const prompt = carriedPrompt(inv, objective);
  const at = prompt.indexOf(objective);
  return { prompt, prefix: prompt.slice(0, at), suffix: prompt.slice(at + objective.length) };
}

function compiler(id: string): (req: CompileRequest) => Invocation {
  const subject = SUBJECTS[id] as Subject;
  const adapter = subject.make();
  return (req) => {
    const inv = adapter.compile({ ...req, bypassApproved: subject.bypassApproved }, subject.profile);
    if (isIneligible(inv)) throw new Error(`${id}: ${inv.reason}`);
    return inv;
  };
}

describe("FR-RTE-09 prompt order per adapter (T7.9)", () => {
  it("covers every registered adapter", () => {
    const registered = providerEntries()
      .filter((e) => e.create !== undefined)
      .map((e) => e.id);
    expect(Object.keys(SUBJECTS).sort()).toEqual([...registered].sort());
  });

  for (const id of Object.keys(SUBJECTS)) {
    const compile = compiler(id);

    it(`${id}: two runs with different objectives share the rendered prefix up to the task text`, () => {
      const a = split(compile(request(OBJECTIVE_A)), OBJECTIVE_A);
      const b = split(compile(request(OBJECTIVE_B)), OBJECTIVE_B);
      expect(a.prefix).toBe(b.prefix);
      expect(a.suffix).toBe(b.suffix);
    });

    it(`${id}: constraints, when rendered, come before the task text and the pack after it`, () => {
      const run = (objective: string) => split(compile(request(`${objective}\n\n${PACK}`)), objective);
      const a = run(OBJECTIVE_A);
      const b = run(OBJECTIVE_B);
      expect(a.prefix).toBe(b.prefix);
      expect(a.suffix).toBe(`\n\n${PACK}`);
      for (const c of CONSTRAINTS) {
        if (a.prompt.includes(c)) expect(a.prefix).toContain(c);
      }
    });
  }

  it("claude renders the constraints, and renders them in the stable prefix", () => {
    const { prefix } = split(compiler("claude")(request(OBJECTIVE_A)), OBJECTIVE_A);
    expect(prefix).toBe(`${CONSTRAINTS_HEADING}\n- ${CONSTRAINTS[0]}\n- ${CONSTRAINTS[1]}\n\n${TASK_HEADING}\n`);
  });
});

describe("renderPrompt (T7.9)", () => {
  it("is the objective alone when there are no constraints", () => {
    expect(renderPrompt(request(OBJECTIVE_A, []))).toBe(OBJECTIVE_A);
  });

  it("puts the constraints first, in their given order, and the task text last", () => {
    const text = renderPrompt(request(OBJECTIVE_A));
    expect(text.endsWith(OBJECTIVE_A)).toBe(true);
    expect(text.indexOf(CONSTRAINTS[0] as string)).toBeLessThan(text.indexOf(CONSTRAINTS[1] as string));
    expect(text.indexOf(CONSTRAINTS[1] as string)).toBeLessThan(text.indexOf(OBJECTIVE_A));
  });

  it("does not depend on the objective: the prefix is a function of the constraints only", () => {
    const prefixOf = (objective: string) => {
      const text = renderPrompt(request(objective));
      return text.slice(0, text.indexOf(objective));
    };
    expect(prefixOf(OBJECTIVE_A)).toBe(prefixOf(OBJECTIVE_B));
  });
});

describe("handoff prompt order (T7.9, LLD §15.5)", () => {
  it("two handoffs of one bundle with different instructions share the prefix; the instruction is last", () => {
    const bundle = syntheticBundle();
    const a = renderHandoffPrompt({ bundle, instruction: OBJECTIVE_A }).prompt;
    const b = renderHandoffPrompt({ bundle, instruction: OBJECTIVE_B }).prompt;
    const prefixA = a.slice(0, a.lastIndexOf(OBJECTIVE_A));
    expect(prefixA).toBe(b.slice(0, b.lastIndexOf(OBJECTIVE_B)));
    expect(a.slice(prefixA.length).trimEnd()).toBe(OBJECTIVE_A);
  });
});
