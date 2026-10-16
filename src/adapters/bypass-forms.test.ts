/**
 * Bypass-class short spellings, clusters and flag values in the argv audit (ADR-0037; amends ADR-0035; FR-POL-03,
 * T3.17, T4.1 audit gaps found by the 2026-10-13 spikes).
 *
 * 1. The T3.17 matrix (8 profiles × bypassApproved) over every new form, in argv and in policyFlags: refused before
 *    spawn except in the approved bypass case.
 * 2. No over-match beyond the documented forms; the existing flag matching is unchanged.
 * 3. Declarations of entries without an adapter (`create`) have no effect; the built-in declarations are as sourced.
 * 4. Registration refuses malformed short flags and values and stays additive; built-in declarations are frozen.
 * No provider CLI is run: the scratch entry is synthetic and the fake adapter's argv is used.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveTrustProfile } from "../policy/profiles.js";
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
import { FakeAdapter } from "./fake/adapter.js";
import { FAKE_PROFILE } from "./fake/cases.js";
import { LOOSE_SCOPE, privilegedProfile } from "./fixtures/privileged.js";
import {
  SCRATCH_BYPASS_SHORT_FLAG,
  SCRATCH_BYPASS_VALUE,
  SCRATCH_ID,
  SCRATCH_PROVIDER,
} from "./fixtures/scratch-provider.js";
import {
  BUILTIN_PROVIDERS,
  declaredBypassShortFlags,
  declaredBypassValues,
  type ProviderEntry,
  ProviderRegistrationError,
  providerEntries,
  providerGeneration,
  registerProvider,
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
