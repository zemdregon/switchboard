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
  canonicalScopeJson,
  createProfileResolver,
  M2_PROFILES,
  type PrivilegedScope,
  ProfileOverrideError,
  ProfileUnavailableError,
  parsePrivilegedScope,
  privilegedScopeHash,
  resolveProfile,
  resolveTrustProfile,
  SCOPE_FILES_TO_PROFILE,
  SCOPE_NETWORK_TO_PROFILE,
  SCOPE_REPO_CONFIG_TO_PROFILE,
  SCOPE_SHELL_TO_PROFILE,
  validateProfileOverrides,
} from "./index.js";

/** A valid structured scope (LLD §3.1). */
const SCOPE = {
  files: { access: "worktree" },
  shell: { mode: "allowlist", allowlist: [["npm", "test"]] },
  network: { mode: "off" },
  repository_config: { mode: "disabled" },
  bypass: true,
} as const satisfies PrivilegedScope;
const HASH = "a".repeat(64);
const APV = "apv_01ARZ3NDEKTSV4RRFFQ69G5FAV";

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

  it("privileged resolves only from a structured scope binding and never approves a bypass", () => {
    for (const bad of [undefined, null, "scope", 1, [], new Map()]) {
      expect(() => resolveTrustProfile("privileged", { privileged: bad as never })).toThrow(ProfileUnavailableError);
    }
    expect(() => resolveTrustProfile("privileged")).toThrow(ProfileUnavailableError);
    try {
      resolveTrustProfile("privileged");
    } catch (err) {
      expect((err as ProfileUnavailableError).code).toBe("PERMISSION_BLOCKED");
    }
    // An open record (the pre-T3.3 shape), a bad hash or a bad approval id are refused (fail closed).
    for (const binding of [
      { scope: { paths: ["/tmp/x"], bypass: true }, scopeHash: HASH, approvalId: APV },
      { scope: SCOPE, scopeHash: "nothex", approvalId: APV },
      { scope: SCOPE, scopeHash: HASH, approvalId: "run_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    ]) {
      expect(() => resolveTrustProfile("privileged", { privileged: binding as never })).toThrow(
        ProfileUnavailableError,
      );
    }
    const binding = { scope: SCOPE, scopeHash: HASH, approvalId: APV };
    const snap = resolveTrustProfile("privileged", { privileged: binding });
    expect(snap).toMatchObject({
      name: "privileged",
      fileAccess: "scoped",
      shell: "scoped",
      network: "scoped",
      repoConfig: "scoped",
      bypassApproved: false,
    });
    expect(snap.privilegedScope).toEqual(binding);
    expect(snap.privilegedScope?.scope).not.toBe(SCOPE);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.privilegedScope?.scope.shell)).toBe(true);
  });

  it("bypassApproved is never true from any profile, override or scope", () => {
    const overrides = {
      "edit-untrusted": { shell: "broad" as const, network: "policy" as const },
    };
    for (const p of ["inspect-untrusted", "edit-untrusted", "test-sandboxed", "trusted-development"] as const) {
      expect(resolveTrustProfile(p, { overrides }).bypassApproved).toBe(false);
    }
    expect(
      resolveTrustProfile("privileged", { privileged: { scope: SCOPE, scopeHash: HASH, approvalId: APV } })
        .bypassApproved,
    ).toBe(false);
    // A smuggled bypassApproved inside the scope is an unknown key, not a grant.
    expect(() =>
      resolveTrustProfile("privileged", {
        privileged: { scope: { ...SCOPE, bypassApproved: true } as never, scopeHash: HASH, approvalId: APV },
      }),
    ).toThrow(ProfileUnavailableError);
  });

  it("rejects unknown profile names", () => {
    for (const bogus of ["", "toString", "__proto__", "EDIT-UNTRUSTED"]) {
      expect(() => resolveTrustProfile(bogus as TrustProfile)).toThrow(ProfileUnavailableError);
    }
  });
});

describe("structured privileged scope (T3.3, LLD §3.1)", () => {
  const fail = (value: unknown) => {
    const r = parsePrivilegedScope(value);
    expect(r.ok, JSON.stringify(value)).toBe(false);
    return r.ok ? "" : r.field;
  };
  const { bypass: _b, ...noBypass } = SCOPE;

  it("accepts every dimension with closed enums and fills bypass false", () => {
    const r = parsePrivilegedScope(noBypass);
    expect(r).toEqual({ ok: true, scope: { ...noBypass, bypass: false } });
    expect(noBypass).not.toHaveProperty("bypass"); // the input is never mutated
    for (const scope of [
      {
        files: { access: "read-only" },
        shell: { mode: "none" },
        network: { mode: "on" },
        repository_config: { mode: "enabled" },
      },
      {
        files: { access: "worktree" },
        shell: { mode: "broad" },
        network: { mode: "allowlist", hosts: ["registry.npmjs.org", "github.com"] },
        repository_config: { mode: "approved" },
        bypass: false,
      },
    ]) {
      expect(parsePrivilegedScope(scope).ok).toBe(true);
    }
  });

  it("refuses unknown keys, missing dimensions, bad enums and the allowlist iff rules, naming the field", () => {
    expect(fail({ ...SCOPE, extra: 1 })).toBe("$.privileged_scope.extra");
    expect(fail({ ...SCOPE, shell: { mode: "none", wildcard: true } })).toBe("$.privileged_scope.shell.wildcard");
    for (const dim of ["files", "shell", "network", "repository_config"] as const) {
      const { [dim]: _gone, ...rest } = SCOPE;
      expect(fail(rest)).toBe(`$.privileged_scope.${dim}`);
    }
    expect(fail({ ...SCOPE, network: { mode: "policy" } })).toBe("$.privileged_scope.network.mode");
    expect(fail({ ...SCOPE, repository_config: { mode: "approved-only" } })).toBe(
      "$.privileged_scope.repository_config.mode",
    );
    expect(fail({ ...SCOPE, bypass: "yes" })).toBe("$.privileged_scope.bypass");
    // allowlist mode without its list, and a list without allowlist mode.
    expect(fail({ ...SCOPE, shell: { mode: "allowlist" } })).toBe("$.privileged_scope.shell.allowlist");
    expect(fail({ ...SCOPE, shell: { mode: "broad", allowlist: [["ls"]] } })).toBe(
      "$.privileged_scope.shell.allowlist",
    );
    expect(fail({ ...SCOPE, network: { mode: "allowlist" } })).toBe("$.privileged_scope.network.hosts");
    expect(fail({ ...SCOPE, network: { mode: "off", hosts: ["a.example"] } })).toBe("$.privileged_scope.network.hosts");
    // argv-exact entries: arrays of non-empty strings, never a shell string.
    expect(fail({ ...SCOPE, shell: { mode: "allowlist", allowlist: ["npm test"] } })).toBe(
      "$.privileged_scope.shell.allowlist[0]",
    );
    expect(fail({ ...SCOPE, shell: { mode: "allowlist", allowlist: [[]] } })).toBe(
      "$.privileged_scope.shell.allowlist[0]",
    );
    expect(fail({ ...SCOPE, shell: { mode: "allowlist", allowlist: [] } })).toBe("$.privileged_scope.shell.allowlist");
    // Host names only (Proposed pattern): no scheme, path or wildcard.
    for (const host of ["https://a.example", "a.example/x", "*.example"]) {
      expect(fail({ ...SCOPE, network: { mode: "allowlist", hosts: [host] } })).toBe(
        "$.privileged_scope.network.hosts[0]",
      );
    }
    expect(fail(null)).toBe("$.privileged_scope");
    expect(fail([])).toBe("$.privileged_scope");
  });

  it("canonical JSON sorts keys and keeps list order; the v2 hash binds client, meta-session and scope", () => {
    const parsed = parsePrivilegedScope(SCOPE);
    if (!parsed.ok) throw new Error("expected ok");
    const json = canonicalScopeJson(parsed.scope);
    expect(json).toBe(
      '{"bypass":true,"files":{"access":"worktree"},"network":{"mode":"off"},' +
        '"repository_config":{"mode":"disabled"},"shell":{"allowlist":[["npm","test"]],"mode":"allowlist"}}',
    );
    const base = { clientId: "c1", metaSessionId: "sess_A", scope: parsed.scope };
    const h = privilegedScopeHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(privilegedScopeHash({ ...base, scope: JSON.parse(json) })).toBe(h); // key order does not matter
    expect(privilegedScopeHash({ ...base, clientId: "c2" })).not.toBe(h);
    expect(privilegedScopeHash({ ...base, metaSessionId: "sess_B" })).not.toBe(h);
    expect(privilegedScopeHash({ ...base, scope: { ...parsed.scope, bypass: false } })).not.toBe(h);
    const reordered = { ...parsed.scope, shell: { mode: "allowlist" as const, allowlist: [["b"], ["a"]] } };
    const ordered = { ...parsed.scope, shell: { mode: "allowlist" as const, allowlist: [["a"], ["b"]] } };
    expect(privilegedScopeHash({ ...base, scope: reordered })).not.toBe(
      privilegedScopeHash({ ...base, scope: ordered }),
    );
  });

  it("documents the scope-to-profile spelling map; scope-only values have no profile counterpart", () => {
    expect(SCOPE_FILES_TO_PROFILE).toEqual({ "read-only": "read-only", worktree: "worktree" });
    expect(SCOPE_SHELL_TO_PROFILE).toEqual({ none: "none", allowlist: "allowlist", broad: "broad" });
    // network "on" is not the profile's "policy"; repository "approved" is "approved-only"; "enabled" is scope-only.
    expect(SCOPE_NETWORK_TO_PROFILE).toEqual({ off: "off", allowlist: "allowlist", on: null });
    expect(SCOPE_REPO_CONFIG_TO_PROFILE).toEqual({ disabled: "disabled", approved: "approved-only", enabled: null });
  });
});
