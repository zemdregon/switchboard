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
import { M2_PROFILES, ProfileUnavailableError, resolveProfile } from "./index.js";

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
        // No shell is granted by the default (empty) allowlist on Claude.
        if (adapter.id === "claude") expect(compiled.argv.some((a) => a.startsWith("Bash"))).toBe(false);
      }
    }
  });
});
