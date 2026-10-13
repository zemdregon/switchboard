/** Production COMP-POL profile resolution (T2.6; FR-POL-01–05, 08, 09; SRS §3.3; ADR-0004). */
import { describe, expect, it } from "vitest";
import {
  auditInvocation,
  BYPASS_FLAGS,
  ClaudeAdapter,
  CodexAdapter,
  type CompileRequest,
  type Invocation,
  isIneligible,
  type TrustProfile,
} from "../adapters/index.js";
import { TRUST_PROFILES } from "../config/index.js";
import { toToolError } from "../mcp/errors.js";
import {
  createProfileResolver,
  M2_PROFILES,
  ProfileOverrideError,
  ProfileUnavailableError,
  resolveProfile,
  resolveTrustProfile,
  validateProfileOverrides,
} from "./index.js";

const request = (profile: TrustProfile): CompileRequest => ({
  runId: "run_1",
  objective: "do it",
  constraints: [],
  workspace: { cwd: "/tmp/ws", writable: profile !== "inspect-untrusted" },
});

describe("resolveProfile (COMP-POL, M2)", () => {
  it("resolves inspect-untrusted to the SRS §3.3 defaults", () => {
    expect(resolveProfile("inspect-untrusted")).toEqual({
      name: "inspect-untrusted",
      fileAccess: "read-only",
      shell: "none",
      network: "off",
      repoConfig: "disabled",
      bypassApproved: false,
    });
  });

  it("resolves edit-untrusted to the SRS §3.3 defaults with an empty (narrowest) shell allowlist", () => {
    expect(resolveProfile("edit-untrusted")).toEqual({
      name: "edit-untrusted",
      fileAccess: "worktree",
      shell: "allowlist",
      shellAllowlist: [],
      network: "off",
      repoConfig: "disabled",
      bypassApproved: false,
    });
  });

  it("returns frozen snapshots that cannot alter the defaults", () => {
    const a = resolveProfile("edit-untrusted");
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.shellAllowlist)).toBe(true);
    expect(() => (a.shellAllowlist as string[]).push("rm -rf /")).toThrow();
    expect(() => {
      (a as { bypassApproved: boolean }).bypassApproved = true;
    }).toThrow();
    expect(resolveProfile("edit-untrusted")).not.toBe(a);
    expect(resolveProfile("edit-untrusted").shellAllowlist).toEqual([]);
  });

  it("never grants privileged and never approves a bypass (FR-POL-03, FR-POL-09)", () => {
    expect(() => resolveProfile("privileged")).toThrow(ProfileUnavailableError);
    for (const p of M2_PROFILES) expect(resolveProfile(p).bypassApproved).toBe(false);
    try {
      resolveProfile("privileged");
    } catch (err) {
      expect((err as ProfileUnavailableError).code).toBe("PERMISSION_BLOCKED");
      expect(toToolError(err).code).toBe("PERMISSION_BLOCKED");
    }
  });

  it("fails closed for every profile not delivered in M2 and for unknown names (NFR-SEC-06)", () => {
    for (const p of TRUST_PROFILES.filter((x) => !M2_PROFILES.includes(x) && x !== "privileged")) {
      expect(() => resolveProfile(p)).toThrow(ProfileUnavailableError);
      try {
        resolveProfile(p);
      } catch (err) {
        expect((err as ProfileUnavailableError).code).toBe("ELIGIBILITY_NONE");
        expect(toToolError(err)).toMatchObject({ code: "ELIGIBILITY_NONE", details: { trust_profile: p } });
      }
    }
    for (const bogus of ["", "toString", "__proto__", "constructor", "EDIT-UNTRUSTED"]) {
      expect(() => resolveProfile(bogus as TrustProfile)).toThrow(ProfileUnavailableError);
    }
  });

  it("compiles on the Claude and Codex adapters with no bypass flag (FR-POL-02, FR-POL-03)", () => {
    const adapters = [
      new ClaudeAdapter({ binaryPath: "/nonexistent/claude" }),
      new CodexAdapter({ executable: "/nonexistent/codex" }),
    ];
    for (const adapter of adapters) {
      for (const p of M2_PROFILES) {
        const inv = adapter.compile(request(p), resolveProfile(p));
        expect(isIneligible(inv), `${adapter.id} ${p}: ${JSON.stringify(inv)}`).toBe(false);
        const compiled = inv as Invocation;
        expect(auditInvocation(compiled)).toEqual([]);
        for (const flag of BYPASS_FLAGS) expect(compiled.argv.join(" ")).not.toContain(flag);
        // No shell is granted by the default (empty) allowlist on Claude: no Bash tool, no Bash allow rule. (Bash deny
        // rules after --disallowedTools are expected, FR-GIT-01.)
        if (adapter.id === "claude") {
          const argv = compiled.argv;
          expect(argv[argv.indexOf("--tools") + 1]?.split(",")).not.toContain("Bash");
          const allow = argv.slice(argv.indexOf("--allowedTools") + 1, argv.indexOf("--disallowedTools"));
          expect(allow.length).toBeGreaterThan(0);
          expect(allow.some((a) => a.startsWith("Bash"))).toBe(false);
        }
      }
    }
  });
});

describe("resolveTrustProfile (COMP-POL, T3.2)", () => {
  const STRICT = {
    fileAccess: "worktree",
    shell: "allowlist",
    shellAllowlist: [],
    network: "off",
    repoConfig: "disabled",
    bypassApproved: false,
  };

  it("resolves all four non-privileged profiles to frozen snapshots with the Proposed strict defaults", () => {
    expect(resolveTrustProfile("test-sandboxed")).toEqual({
      name: "test-sandboxed",
      ...STRICT,
    });
    expect(resolveTrustProfile("trusted-development")).toEqual({
      name: "trusted-development",
      ...STRICT,
    });
    expect(resolveTrustProfile("edit-untrusted")).toEqual({
      name: "edit-untrusted",
      ...STRICT,
    });
    expect(resolveTrustProfile("inspect-untrusted")).toMatchObject({
      fileAccess: "read-only",
      shell: "none",
    });
    for (const p of ["inspect-untrusted", "edit-untrusted", "test-sandboxed", "trusted-development"] as const) {
      const snap = resolveTrustProfile(p);
      expect(Object.isFrozen(snap)).toBe(true);
      expect(snap.overrides).toBeUndefined();
      expect(snap.bypassApproved).toBe(false);
    }
    expect(Object.isFrozen(resolveTrustProfile("test-sandboxed").shellAllowlist)).toBe(true);
  });

  it("keeps the M2-gated resolver refusing non-M2 profiles, with or without overrides", () => {
    const resolver = createProfileResolver({
      "test-sandboxed": { network: "policy" },
    });
    for (const p of ["test-sandboxed", "trusted-development", "privileged"] as const) {
      expect(() => resolver(p)).toThrow(ProfileUnavailableError);
    }
    expect(resolver("edit-untrusted").name).toBe("edit-untrusted");
  });

  it("tightening and loosening need an explicit per-field override and both appear in the snapshot", () => {
    const snap = resolveTrustProfile("edit-untrusted", {
      overrides: {
        "edit-untrusted": {
          shellAllowlist: ["npm test"],
          network: "allowlist",
          networkAllowlist: ["registry.npmjs.org"],
          fileAccess: "read-only",
        },
      },
    });
    expect(snap).toMatchObject({
      fileAccess: "read-only",
      shell: "allowlist",
      shellAllowlist: ["npm test"],
      network: "allowlist",
      networkAllowlist: ["registry.npmjs.org"],
      repoConfig: "disabled",
      bypassApproved: false,
    });
    expect(snap.overrides).toEqual([
      {
        profile: "edit-untrusted",
        field: "fileAccess",
        from: "worktree",
        to: "read-only",
        direction: "tighten",
      },
      {
        profile: "edit-untrusted",
        field: "network",
        from: "off",
        to: "allowlist",
        direction: "loosen",
      },
      {
        profile: "edit-untrusted",
        field: "shellAllowlist",
        from: [],
        to: ["npm test"],
        direction: "loosen",
      },
      {
        profile: "edit-untrusted",
        field: "networkAllowlist",
        from: [],
        to: ["registry.npmjs.org"],
        direction: "loosen",
      },
    ]);
    expect(Object.isFrozen(snap.overrides)).toBe(true);
    // Round-trips through the ledger's JSON column.
    expect(JSON.parse(JSON.stringify(snap)).overrides).toHaveLength(4);
  });

  it("an override applies only to its own profile and only to the fields named", () => {
    const overrides = { "trusted-development": { shell: "broad" as const } };
    const td = resolveTrustProfile("trusted-development", { overrides });
    expect(td.shell).toBe("broad");
    expect(td.shellAllowlist).toBeUndefined();
    expect(td.network).toBe("off");
    expect(resolveTrustProfile("edit-untrusted", { overrides })).toEqual({
      name: "edit-untrusted",
      ...STRICT,
    });
  });

  it("rejects invalid overrides: orphaned lists, wildcards, duplicates, bad values, unknown fields and profiles", () => {
    const bad = (o: object, re: RegExp) =>
      expect(() =>
        resolveTrustProfile("edit-untrusted", {
          overrides: { "edit-untrusted": o },
        }),
      ).toThrow(re);
    bad({ shell: "none", shellAllowlist: ["ls"] }, /shell_allowlist: requires shell to be "allowlist"/);
    bad({ shellAllowlist: ["*"] }, /shell_allowlist: a wildcard/);
    bad({ shellAllowlist: ["ls", "ls"] }, /duplicate entry/);
    bad({ networkAllowlist: ["example.com"] }, /network_allowlist: requires network/);
    bad({ network: "everything" }, /network: must be one of off, allowlist, policy/);
    bad({ bypassApproved: true }, /unknown override field bypassApproved/);
    bad({ "*": "all" }, /unknown override field \*/);
    expect(() => validateProfileOverrides({ privileged: {} } as never)).toThrow(/unknown or non-overridable/);
    expect(() => validateProfileOverrides({ "*": {} } as never)).toThrow(ProfileOverrideError);
  });

  it("privileged resolves only from an explicit scope object and never approves a bypass", () => {
    for (const bad of [undefined, null, "scope", 1, [], new Map()]) {
      expect(() => resolveTrustProfile("privileged", { scope: bad as never })).toThrow(ProfileUnavailableError);
    }
    expect(() => resolveTrustProfile("privileged")).toThrow(ProfileUnavailableError);
    try {
      resolveTrustProfile("privileged");
    } catch (err) {
      expect((err as ProfileUnavailableError).code).toBe("PERMISSION_BLOCKED");
    }
    const scope = { paths: ["/tmp/x"], bypass: true };
    const snap = resolveTrustProfile("privileged", { scope });
    expect(snap).toMatchObject({
      name: "privileged",
      fileAccess: "scoped",
      shell: "scoped",
      network: "scoped",
      repoConfig: "scoped",
      bypassApproved: false,
    });
    expect(snap.scope).toEqual(scope);
    expect(snap.scope).not.toBe(scope);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.scope)).toBe(true);
  });

  it("bypassApproved is never true from any profile, override or scope", () => {
    const overrides = {
      "edit-untrusted": { shell: "broad" as const, network: "policy" as const },
    };
    for (const p of ["inspect-untrusted", "edit-untrusted", "test-sandboxed", "trusted-development"] as const) {
      expect(resolveTrustProfile(p, { overrides }).bypassApproved).toBe(false);
    }
    expect(
      resolveTrustProfile("privileged", {
        scope: { bypassApproved: true, bypass: true },
      }).bypassApproved,
    ).toBe(false);
  });

  it("rejects unknown profile names", () => {
    for (const bogus of ["", "toString", "__proto__", "EDIT-UNTRUSTED"]) {
      expect(() => resolveTrustProfile(bogus as TrustProfile)).toThrow(ProfileUnavailableError);
    }
  });
});
