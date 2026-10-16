/**
 * Bypass-class short spellings, clusters and flag values in the argv audit (ADR-0037; amends ADR-0035; FR-POL-03,
 * T3.17, T4.1 audit gaps found by the 2026-10-13 spikes).
 *
 * 1. The T3.17 matrix (8 profiles × bypassApproved) over every new form, in argv and in policyFlags: refused before
 *    spawn except in the approved bypass case.
 * 2. No over-match beyond the documented forms; the existing flag matching is unchanged.
 * 3. Declarations of entries without an adapter (`create`) have no effect; the built-in declarations are as sourced.
 * 4. Registration refuses malformed short flags and values and stays additive; built-in declarations are frozen.
 * 5. Provider-scoped flags (T4.62, ADR-0049 item 1): Kimi Code's `-p`/`--prompt` refused only in Kimi argv and in argv
 *    of an unknown provider; Claude Code's `-p` and Antigravity's `--prompt` stay accepted.
 * No provider CLI is run: the scratch entry is synthetic and the fake adapter's argv is used.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveTrustProfile } from "../policy/profiles.js";
import { AntigravityAdapter } from "./antigravity/adapter.js";
import {
  assertBypassAudit,
  auditInvocation,
  type BypassContext,
  BypassFlagError,
  bypassClassFlags,
  bypassClassShortFlags,
  bypassClassValues,
  findBypassFlags,
} from "./audit.js";
import { ClaudeAdapter } from "./claude/adapter.js";
import { FakeAdapter } from "./fake/adapter.js";
import { FAKE_PROFILE } from "./fake/cases.js";
import { LOOSE_SCOPE, privilegedProfile } from "./fixtures/privileged.js";
import {
  SCRATCH_BYPASS_SHORT_FLAG,
  SCRATCH_BYPASS_VALUE,
  SCRATCH_ID,
  SCRATCH_PROVIDER,
} from "./fixtures/scratch-provider.js";
import { KimiAdapter } from "./kimi/adapter.js";
import {
  BUILTIN_PROVIDERS,
  declaredBypassShortFlags,
  declaredBypassValues,
  type ProviderEntry,
  ProviderRegistrationError,
  providerEntries,
  providerGeneration,
  registerProvider,
  scopedBypassFlags,
} from "./providers.js";
import { startAdapterRun } from "./run.js";
import type { Invocation, ResolvedProfile } from "./types.js";

const cleanups: (() => void)[] = [];
const register = (entry: ProviderEntry) => {
  const off = registerProvider(entry);
  cleanups.push(off);
  return off;
};
afterEach(() => {
  for (const off of cleanups.splice(0).reverse()) off();
});

const request = { runId: "r", objective: "x", constraints: [], workspace: { cwd: "/tmp", writable: true } };
const fakeInv = () => new FakeAdapter().compile(request, FAKE_PROFILE) as Invocation;
const withArgv = (...extra: string[]) => ({ ...fakeInv(), argv: [...fakeInv().argv, ...extra] });
const withPolicy = (...policyFlags: string[]) => ({ ...fakeInv(), policyFlags });

const SCRATCH_VALUE_HIT = `${SCRATCH_BYPASS_VALUE.flag} ${SCRATCH_BYPASS_VALUE.value}`;
const CLAUDE_MODE_HIT = "--permission-mode bypassPermissions";

/** Each new form: the argv words that carry it and the one hit the audit reports. */
const FORMS: Array<[string, string[], string]> = [
  ["short flag alone", ["-k"], SCRATCH_BYPASS_SHORT_FLAG],
  ["short flag with =value", ["-k=1"], SCRATCH_BYPASS_SHORT_FLAG],
  ["cluster, letter last", ["-qk"], SCRATCH_BYPASS_SHORT_FLAG],
  ["cluster, letter first", ["-kq"], SCRATCH_BYPASS_SHORT_FLAG],
  ["cluster, letter inside, with =value", ["-qkz=x"], SCRATCH_BYPASS_SHORT_FLAG],
  ["value, space-separated", ["--scratch-guard", "off"], SCRATCH_VALUE_HIT],
  ["value, other case", ["--scratch-guard", "OFF"], SCRATCH_VALUE_HIT],
  ["value, = form", ["--scratch-guard=off"], SCRATCH_VALUE_HIT],
  ["Claude mode value, space-separated", ["--permission-mode", "bypassPermissions"], CLAUDE_MODE_HIT],
  ["Claude mode value, = form", ["--permission-mode=bypassPermissions"], CLAUDE_MODE_HIT],
];

describe("new forms in the T3.17 matrix (ADR-0037)", () => {
  const PRIV_BYPASS = privilegedProfile({ ...LOOSE_SCOPE, bypass: true });
  const profiles: Array<[string, Pick<ResolvedProfile, "name" | "privilegedScope">]> = [
    ["inspect-untrusted", resolveTrustProfile("inspect-untrusted")],
    ["edit-untrusted", resolveTrustProfile("edit-untrusted")],
    ["test-sandboxed", resolveTrustProfile("test-sandboxed")],
    ["trusted-development", resolveTrustProfile("trusted-development")],
    ["privileged, scope bypass false", privilegedProfile(LOOSE_SCOPE)],
    ["privileged, scope bypass true", PRIV_BYPASS],
    ["privileged, no scope binding", { name: "privileged" }],
    ["edit-untrusted carrying a bypass scope", { ...PRIV_BYPASS, name: "edit-untrusted" }],
  ];

  for (const [label, profile] of profiles) {
    for (const bypassApproved of [false, true]) {
      const allowed = label === "privileged, scope bypass true" && bypassApproved;
      it(`${label}, bypassApproved=${bypassApproved}: every new form ${allowed ? "admitted" : "refused"}`, () => {
        register(SCRATCH_PROVIDER);
        const ctx: BypassContext = { profile, bypassApproved };
        for (const [form, words, hit] of FORMS) {
          for (const inv of [withArgv(...words), withPolicy(...words)]) {
            expect(findBypassFlags(inv), form).toEqual([hit]);
            expect(auditInvocation(inv, ctx), form).toEqual(allowed ? [] : [hit]);
            if (allowed) expect(() => assertBypassAudit(inv, ctx), form).not.toThrow();
            else {
              expect(() => startAdapterRun(new FakeAdapter(), inv, ctx), form).toThrow(BypassFlagError);
              expect(() => startAdapterRun(new FakeAdapter(), inv, ctx), form).toThrow(hit);
            }
            // Without a context every form is refused.
            expect(auditInvocation(inv), form).toEqual([hit]);
          }
        }
      });
    }
  }
});

describe("matching is limited to the declared forms; existing matching unchanged", () => {
  it("near misses are not hits", () => {
    register(SCRATCH_PROVIDER);
    const misses: string[][] = [
      ["-q"],
      ["-qz"],
      ["--k"], // a long name, not a cluster
      ["--kq"],
      ["-"],
      ["--"],
      ["k"],
      ["off"], // the value alone
      ["--scratch-guard", "on"],
      ["--scratch-guard"], // flag at the end, no value
      ["--scratch-guard=", "off"],
      ["--scratch-guardx", "off"],
      ["--scratch-guard", "off-ish"],
      ["--scratch-guard=offx"],
      ["--permission-mode", "dontAsk"],
    ];
    for (const words of misses) {
      expect(findBypassFlags(withArgv(...words)), words.join(" ")).toEqual([]);
      expect(findBypassFlags(withPolicy(...words)), words.join(" ")).toEqual([]);
    }
  });

  it("a value pair is not read across the argv/policyFlags boundary (each list is checked on its own)", () => {
    register(SCRATCH_PROVIDER);
    const inv = { ...withArgv("--scratch-guard"), policyFlags: ["off"] };
    expect(findBypassFlags(inv)).toEqual([]);
  });

  it("several hits are reported once each, in argv order then policyFlags", () => {
    register(SCRATCH_PROVIDER);
    const inv = {
      ...withArgv("--yolo", "-qk", "--scratch-guard", "off", "-k", "--yolo=1"),
      policyFlags: ["--permission-mode=bypassPermissions", "-k"],
    };
    expect(findBypassFlags(inv)).toEqual(["--yolo", "-k", SCRATCH_VALUE_HIT, CLAUDE_MODE_HIT]);
  });

  it("the flag list and its matching are as before: shared and declared flags only, bare or flag=value", () => {
    register(SCRATCH_PROVIDER);
    const before = bypassClassFlags();
    expect(before).not.toContain(SCRATCH_BYPASS_SHORT_FLAG);
    for (const f of before) {
      expect(findBypassFlags(withArgv(f))).toEqual([f]);
      expect(findBypassFlags(withArgv(`${f}=x`))).toEqual([f]);
      expect(findBypassFlags(withArgv(`${f}x`))).toEqual([]);
    }
  });

  it("a short flag declared in bypassFlags also matches inside a cluster", () => {
    register({ id: "eta", configId: "eta-cli", kind: "real", bypassFlags: ["-j"] });
    expect(bypassClassShortFlags()).toContain("-j");
    expect(findBypassFlags(withArgv("-pj"))).toEqual(["-j"]);
    expect(findBypassFlags(withArgv("-j"))).toEqual(["-j"]);
  });
});

describe("declarations count only once the entry has an adapter (create)", () => {
  it("with no registration, the Claude Code, Grok Build, Cursor, Kimi Code and Muse Code declarations are active", () => {
    // Cursor's short flags (T4.42) and Kimi Code's `-y` (T4.62).
    const CURSOR_SHORT = ["-f", "-w", "-H", "-e", "-y"];
    expect(declaredBypassShortFlags()).toEqual(CURSOR_SHORT);
    const ACTIVE_VALUES = [
      { flag: "--permission-mode", value: "bypassPermissions" },
      { flag: "--allow", value: "*" },
      { flag: "--allow", value: "**" },
      { flag: "--allowed-tools", value: "*" },
      { flag: "--allowed-tools", value: "**" },
      { flag: "--sandbox", value: "disabled" },
      { flag: "--approval-mode", value: "never" },
      { flag: "--sandbox-network", value: "unrestricted" },
      { flag: "--sandbox-network", value: "enabled" },
    ];
    // Claude Code's `--permission-mode bypassPermissions` and Grok Build's (declared since T4.22) are one value;
    // Cursor's `--sandbox disabled` is active since T4.42, Muse Code's three values since T4.72.
    expect(declaredBypassValues()).toEqual(ACTIVE_VALUES);
    expect(bypassClassShortFlags()).toEqual(CURSOR_SHORT);
    expect(bypassClassValues()).toEqual(ACTIVE_VALUES);
    // Cursor declarations are active now that T4.42 added its adapter.
    for (const words of [["-f"], ["-pf"], ["--sandbox", "disabled"], ["--sandbox=disabled"]]) {
      expect(auditInvocation(withArgv(...words)), words.join(" ")).toHaveLength(1);
    }
    // Claude Code's value and Grok Build's catch-all allow rule are active: both have an adapter.
    expect(auditInvocation(withArgv("--permission-mode", "bypassPermissions"))).toEqual([CLAUDE_MODE_HIT]);
    expect(auditInvocation(withArgv("--allow", "*"))).toHaveLength(1);
  });

  it("the built-in declarations are exactly the sourced ones", () => {
    const decl = Object.fromEntries(
      (BUILTIN_PROVIDERS as readonly ProviderEntry[]).map((e) => [
        e.id,
        { short: e.bypassShortFlags ?? [], values: e.bypassValues ?? [] },
      ]),
    );
    expect(decl).toEqual({
      claude: { short: [], values: [{ flag: "--permission-mode", value: "bypassPermissions" }] },
      codex: { short: [], values: [] },
      grok: {
        short: [],
        values: [
          { flag: "--permission-mode", value: "bypassPermissions" },
          { flag: "--allow", value: "*" },
          { flag: "--allow", value: "**" },
          { flag: "--allowed-tools", value: "*" },
          { flag: "--allowed-tools", value: "**" },
        ],
      },
      antigravity: { short: [], values: [] },
      cursor: { short: ["-f", "-w", "-H", "-e"], values: [{ flag: "--sandbox", value: "disabled" }] },
      opencode: { short: [], values: [] },
      kimi: { short: ["-y"], values: [] },
      muse: {
        short: [],
        values: [
          { flag: "--approval-mode", value: "never" },
          { flag: "--sandbox-network", value: "unrestricted" },
          { flag: "--sandbox-network", value: "enabled" },
        ],
      },
      fake: { short: [], values: [] },
    });
  });

  it("the same declarations become active when an entry with an adapter declares them", () => {
    const { create } = SCRATCH_PROVIDER;
    register({
      id: "zeta",
      configId: "zeta-cli",
      kind: "real",
      bypassFlags: [],
      bypassShortFlags: ["-f"],
      bypassValues: [{ flag: "--sandbox", value: "disabled" }],
      ...(create !== undefined ? { create } : {}),
    });
    expect(auditInvocation(withArgv("-pf"))).toEqual(["-f"]);
    expect(auditInvocation(withArgv("--sandbox", "disabled"))).toEqual(["--sandbox disabled"]);
    expect(auditInvocation(withArgv("--sandbox=Disabled"))).toEqual(["--sandbox disabled"]);
  });

  it("a runtime entry without create is inert; removing an active entry drops only its own forms", () => {
    const { create: _create, ...inert } = SCRATCH_PROVIDER;
    const offInert = register({ ...inert, id: "scratch-inert", configId: "scratch-inert-cli" });
    expect(auditInvocation(withArgv("-k", "--scratch-guard", "off"))).toEqual([]);
    offInert();
    const off = register(SCRATCH_PROVIDER);
    expect(auditInvocation(withArgv("-k", "--scratch-guard", "off"))).toEqual(["-k", SCRATCH_VALUE_HIT]);
    off();
    expect(providerEntries().some((e) => e.id === SCRATCH_ID)).toBe(false);
    expect(auditInvocation(withArgv("-k", "--scratch-guard", "off"))).toEqual([]);
    expect(auditInvocation(withArgv("--permission-mode", "bypassPermissions"))).toEqual([CLAUDE_MODE_HIT]);
  });
});

describe("registration of short flags and values: validated and additive only", () => {
  const base: ProviderEntry = { id: "zeta", configId: "zeta-cli", kind: "real", bypassFlags: [] };
  const bad = (x: unknown) => x as never;
  const cases: [string, ProviderEntry, RegExp][] = [
    ["a long name as short flag", { ...base, bypassShortFlags: ["--kk"] }, /malformed bypass short flag/],
    ["two letters", { ...base, bypassShortFlags: ["-kk"] }, /malformed bypass short flag/],
    ["no dash", { ...base, bypassShortFlags: ["k"] }, /malformed bypass short flag/],
    ["a dash alone", { ...base, bypassShortFlags: ["-"] }, /malformed bypass short flag/],
    ["a short flag with a value", { ...base, bypassShortFlags: ["-k=1"] }, /malformed bypass short flag/],
    ["short flags not an array", { ...base, bypassShortFlags: bad("-k") }, /bypassShortFlags must be an array/],
    ["values not an array", { ...base, bypassValues: bad({ flag: "--a", value: "b" }) }, /must be an array/],
    ["a value that is a string", { ...base, bypassValues: bad(["--a b"]) }, /malformed bypass value/],
    ["a value without value", { ...base, bypassValues: bad([{ flag: "--a" }]) }, /malformed bypass value/],
    ["an empty value", { ...base, bypassValues: [{ flag: "--a", value: "" }] }, /malformed bypass value/],
    ["a value with a space", { ...base, bypassValues: [{ flag: "--a", value: "b c" }] }, /malformed bypass value/],
    ["a value with a newline", { ...base, bypassValues: [{ flag: "--a", value: "b\n" }] }, /malformed bypass value/],
    ["an over-long value", { ...base, bypassValues: [{ flag: "--a", value: "v".repeat(129) }] }, /malformed/],
    ["a value flag with =", { ...base, bypassValues: [{ flag: "--a=b", value: "c" }] }, /malformed bypass value/],
    ["a value flag without dashes", { ...base, bypassValues: [{ flag: "a", value: "c" }] }, /malformed bypass value/],
    ["a value with an extra key", { ...base, bypassValues: bad([{ flag: "--a", value: "c", x: 1 }]) }, /malformed/],
    ["a null value", { ...base, bypassValues: bad([null]) }, /malformed bypass value/],
  ];
  for (const [label, entry, message] of cases) {
    it(`refuses ${label}, changing nothing`, () => {
      const before = {
        gen: providerGeneration(),
        entries: providerEntries().length,
        short: bypassClassShortFlags(),
        values: bypassClassValues(),
      };
      expect(() => registerProvider(entry)).toThrow(ProviderRegistrationError);
      expect(() => registerProvider(entry)).toThrow(message);
      expect(providerGeneration()).toBe(before.gen);
      expect(providerEntries()).toHaveLength(before.entries);
      expect(bypassClassShortFlags()).toEqual(before.short);
      expect(bypassClassValues()).toEqual(before.values);
    });
  }

  it("built-in short flags, values and value objects are frozen", () => {
    for (const e of BUILTIN_PROVIDERS as readonly ProviderEntry[]) {
      if (e.bypassShortFlags !== undefined) expect(Object.isFrozen(e.bypassShortFlags)).toBe(true);
      if (e.bypassValues !== undefined) {
        expect(Object.isFrozen(e.bypassValues)).toBe(true);
        for (const v of e.bypassValues) expect(Object.isFrozen(v)).toBe(true);
      }
    }
    const values = (BUILTIN_PROVIDERS as readonly ProviderEntry[]).find((e) => e.id === "claude")?.bypassValues;
    if (values === undefined) throw new Error("Claude Code declares a bypass value");
    expect(() => (values as unknown as unknown[]).pop()).toThrow(TypeError);
    expect(() => {
      (values[0] as { value: string }).value = "dontAsk";
    }).toThrow(TypeError);
    expect(values).toEqual([{ flag: "--permission-mode", value: "bypassPermissions" }]);
  });

  it("a registration is copied: changing the caller's arrays afterwards changes nothing", () => {
    const short = ["-k"];
    const values = [{ flag: "--scratch-guard", value: "off" }];
    const { create } = SCRATCH_PROVIDER;
    register({
      ...base,
      bypassShortFlags: short,
      bypassValues: values,
      ...(create !== undefined ? { create } : {}),
    });
    short.pop();
    (values[0] as { value: string }).value = "on";
    expect(auditInvocation(withArgv("-k", "--scratch-guard", "off"))).toEqual(["-k", SCRATCH_VALUE_HIT]);
  });

  it("an entry cannot remove an active value or short flag: duplicates add nothing", () => {
    register(SCRATCH_PROVIDER);
    const before = { short: bypassClassShortFlags(), values: bypassClassValues() };
    const { create } = SCRATCH_PROVIDER;
    register({
      ...base,
      bypassShortFlags: ["-k"],
      bypassValues: [
        { flag: "--permission-mode", value: "BYPASSPERMISSIONS" },
        { flag: "--scratch-guard", value: "off" },
      ],
      ...(create !== undefined ? { create } : {}),
    });
    expect(bypassClassShortFlags()).toEqual(before.short);
    expect(bypassClassValues()).toEqual(before.values);
  });
});

describe("provider-scoped bypass flags (T4.62, ADR-0049 item 1, Q-95)", () => {
  const KIMI_EXE = "/opt/synthetic/kimi";
  const kimiArgv = (...words: string[]): Pick<Invocation, "argv" | "policyFlags"> => ({
    argv: [KIMI_EXE, ...words],
    policyFlags: [],
  });
  // Kimi Code's one bypass cell: the loosest scope with repository configuration `enabled` and `bypass`.
  const BYPASS_SCOPE = { ...LOOSE_SCOPE, repository_config: { mode: "enabled" }, bypass: true } as const;
  const bypassProfile: ResolvedProfile = { ...privilegedProfile(BYPASS_SCOPE), bypassApproved: true };
  const approved: BypassContext = { profile: bypassProfile, bypassApproved: true };
  /** Every context except the approved bypass cell (ADR-0017): none, unapproved, approved without `bypass`, others. */
  const refusing: Array<[string, BypassContext | undefined]> = [
    ["no context", undefined],
    ["privileged bypass scope, not approved", { profile: privilegedProfile(BYPASS_SCOPE), bypassApproved: false }],
    ["privileged without bypass, approved", { profile: privilegedProfile(LOOSE_SCOPE), bypassApproved: true }],
    ["trusted-development, approved", { profile: resolveTrustProfile("trusted-development"), bypassApproved: true }],
  ];
  const KIMI_FORMS: Array<[string, ReturnType<typeof kimiArgv>, string[]]> = [
    ["-p <prompt>", kimiArgv("-p", "x"), ["-p"]],
    ["-p=<prompt>", kimiArgv("-p=x"), ["-p"]],
    ["-p joined to its value", kimiArgv("-px y"), ["-p"]],
    ["-p in a cluster after -y", kimiArgv("-yp", "x"), ["-y", "-p"]],
    ["--prompt <prompt>", kimiArgv("--prompt", "x"), ["--prompt"]],
    ["--prompt=<prompt> (the compiled form)", kimiArgv("--prompt=x"), ["--prompt"]],
    ["--prompt in policyFlags", { argv: [KIMI_EXE], policyFlags: ["--prompt"] }, ["--prompt"]],
  ];

  it.each(KIMI_FORMS)("Kimi argv with %s is refused outside the approved bypass cell", (_n, inv, hits) => {
    for (const [label, ctx] of refusing) {
      expect(auditInvocation(inv, ctx, "kimi"), label).toEqual(hits);
      expect(() => assertBypassAudit(inv, ctx, "kimi"), label).toThrow(BypassFlagError);
    }
    expect(auditInvocation(inv, approved, "kimi")).toEqual([]);
    expect(() => assertBypassAudit(inv, approved, "kimi")).not.toThrow();
  });

  it("does not over-match other Kimi words", () => {
    for (const words of [["--prompts"], ["--promptx=1"], ["--plan-x"], ["--output-format", "stream-json"], ["x-p"]]) {
      expect(findBypassFlags(kimiArgv(...words), "kimi"), words.join(" ")).toEqual([]);
    }
  });

  it("Claude Code's -p and Antigravity's --prompt stay accepted in their own argv, unchanged", () => {
    const claudeArgv = { argv: ["/opt/synthetic/claude", "-p", "--output-format", "stream-json"], policyFlags: [] };
    const agyArgv = { argv: ["/opt/synthetic/agy", "--prompt=fix it", "--output-format", "json"], policyFlags: [] };
    for (const [label, ctx] of refusing) {
      expect(auditInvocation(claudeArgv, ctx, "claude"), label).toEqual([]);
      expect(auditInvocation(agyArgv, ctx, "antigravity"), label).toEqual([]);
      // Without a provider the provider-agnostic lists only apply (the pre-T4.62 behaviour).
      expect(auditInvocation(claudeArgv, ctx), label).toEqual([]);
      expect(auditInvocation(agyArgv, ctx), label).toEqual([]);
    }
    // The real compiles: Claude Code under every non-privileged profile, Antigravity in its approved bypass cell.
    const claude = new ClaudeAdapter({ binaryPath: "/opt/synthetic/claude" });
    for (const name of ["inspect-untrusted", "edit-untrusted", "test-sandboxed", "trusted-development"] as const) {
      const inv = claude.compile(request, resolveTrustProfile(name));
      if ("ineligible" in inv) continue;
      expect(inv.argv, name).toContain("-p");
      expect(auditInvocation(inv, undefined, "claude"), name).toEqual([]);
    }
    const agy = new AntigravityAdapter({ executable: "/opt/synthetic/agy" });
    const agyInv = agy.compile({ ...request, bypassApproved: true }, bypassProfile);
    if ("ineligible" in agyInv) throw new Error(agyInv.detail);
    expect(agyInv.argv.some((a) => a.startsWith("--prompt="))).toBe(true);
    // Its bypass compile also carries the shared `--dangerously-skip-permissions`: the result is the pre-T4.62 one.
    for (const [label, ctx] of refusing) {
      expect(auditInvocation(agyInv, ctx, "antigravity"), label).toEqual(auditInvocation(agyInv, ctx));
      expect(auditInvocation(agyInv, ctx, "antigravity"), label).not.toContain("--prompt");
    }
    expect(auditInvocation(agyInv, approved, "antigravity")).toEqual([]);
    expect(bypassClassFlags()).not.toContain("-p");
    expect(bypassClassFlags()).not.toContain("--prompt");
  });

  it("an argv whose provider is unknown is checked against the shared list and every provider-scoped list", () => {
    register({
      id: "scoped-zeta",
      configId: "scoped-zeta-cli",
      kind: "real",
      bypassFlags: [],
      providerScopedBypassFlags: ["--zap", "-z"],
    });
    expect(scopedBypassFlags("nonesuch")).toEqual(["-p", "--prompt", "--zap", "-z"]);
    expect(scopedBypassFlags("kimi")).toEqual(["-p", "--prompt"]);
    expect(scopedBypassFlags("claude")).toEqual([]);
    const inv = kimiArgv("--yolo", "-f", "--sandbox", "disabled", "-p", "x", "--prompt=y", "--zap", "-zq");
    expect(auditInvocation(inv, undefined, "nonesuch")).toEqual([
      "--yolo",
      "-f",
      "--sandbox disabled",
      "-p",
      "--prompt",
      "--zap",
      "-z",
    ]);
    expect(auditInvocation(inv, approved, "nonesuch")).toEqual([]);
    // A known provider sees only its own scoped list on top of the provider-agnostic ones.
    expect(auditInvocation(inv, undefined, "kimi")).toEqual(["--yolo", "-f", "--sandbox disabled", "-p", "--prompt"]);
    expect(auditInvocation(inv, undefined, "claude")).toEqual(["--yolo", "-f", "--sandbox disabled"]);
  });

  it("the spawn path names the adapter: a Kimi bypass-cell argv is refused before spawn without the approval", () => {
    const kimi = new KimiAdapter({ executable: KIMI_EXE });
    const inv = kimi.compile(request, bypassProfile) as Invocation;
    expect(inv.argv).toContain("--prompt=x");
    // The compile gate is bypassed: the approved compile is spawned under each refusing context.
    for (const [label, ctx] of refusing) {
      const opts = ctx !== undefined ? { profile: ctx.profile, bypassApproved: ctx.bypassApproved } : {};
      expect(() => startAdapterRun(kimi, inv, opts), label).toThrow(BypassFlagError);
    }
  });

  it("registration validates and freezes provider-scoped flags", () => {
    for (const bad of [["-p=x"], ["p"], ["--a b"], [""]]) {
      expect(() =>
        registerProvider({
          id: "scoped-bad",
          configId: "scoped-bad-cli",
          kind: "real",
          bypassFlags: [],
          providerScopedBypassFlags: bad,
        }),
      ).toThrow(ProviderRegistrationError);
    }
    const kimiEntry = (BUILTIN_PROVIDERS as readonly ProviderEntry[]).find((e) => e.id === "kimi");
    expect(kimiEntry?.providerScopedBypassFlags).toEqual(["-p", "--prompt"]);
    expect(Object.isFrozen(kimiEntry?.providerScopedBypassFlags)).toBe(true);
    const scoped = (BUILTIN_PROVIDERS as readonly ProviderEntry[]).filter((e) => e.providerScopedBypassFlags);
    expect(scoped.map((e) => e.id)).toEqual(["kimi"]);
  });
});
